// Screen-space contact shadows (opt-in). Marches a short ray from each surface toward the sun in
// world space, projecting each step to screen and testing the depth buffer: if a nearer surface sits
// between the pixel and the light, the pixel is in a short-range shadow the sun's shadow-map cascades
// are too coarse to catch — rope-on-deck grounding, rails, and the ship's own contact shadow where
// the hull meets the water. Output is an occlusion multiplier composited into the HDR scene with a
// multiply blend (result = scene * occl), so it only ever darkens.

struct CsU {
  invVP  : mat4x4<f32>,   // NDC -> world
  vp     : mat4x4<f32>,   // world -> NDC (for projecting march samples)
  sunDir : vec4<f32>,     // xyz = unit toward the sun ; w = day factor
  params : vec4<f32>,     // x = max march distance (m) ; y = step count ; z = strength [0..1] ; w = depth thickness
};
@group(0) @binding(0) var<uniform> u : CsU;
@group(0) @binding(1) var depthTex : texture_depth_2d;

struct VSOut { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let p = pts[vid];
  var o : VSOut;
  o.position = vec4<f32>(p, 0.0, 1.0);
  o.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return o;
}

fn worldFromUV(uv : vec2<f32>, d : f32) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let w = u.invVP * ndc;
  return w.xyz / w.w;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let dims = vec2<f32>(textureDimensions(depthTex, 0));
  let ip = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - 1.0));
  let d = textureLoad(depthTex, ip, 0);
  if (d >= 0.99999) { return vec4<f32>(1.0); }   // sky — never shadowed

  let P = worldFromUV(uv, d);
  let L = normalize(u.sunDir.xyz);
  let steps = i32(u.params.y);
  let stepLen = u.params.x / f32(steps);
  // Interleaved-gradient dither on the start offset hides the low step count.
  let jitter = fract(52.9829189 * fract(dot(in.position.xy, vec2<f32>(0.06711056, 0.00583715))));

  var occ = 0.0;
  for (var i = 0; i < steps; i = i + 1) {
    let Q = P + L * ((f32(i) + jitter) * stepLen);
    let c = u.vp * vec4<f32>(Q, 1.0);
    if (c.w <= 0.0) { break; }
    let sndc = c.xyz / c.w;
    let suv = vec2<f32>(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { break; }
    let sp = vec2<i32>(clamp(suv * dims, vec2<f32>(0.0), dims - 1.0));
    let sd = textureLoad(depthTex, sp, 0);
    // Occluded when a stored surface sits IN FRONT of the marched sample (nearer to the camera) by
    // more than a small bias, but within a thickness slab (so we don't shadow through the whole world).
    if (sd < sndc.z - 0.00003 && sd > sndc.z - u.params.w) {
      // Fade with march distance so the contact darkening stays local.
      occ = max(occ, 1.0 - f32(i) / f32(steps));
    }
  }

  let shadow = occ * u.params.z * u.sunDir.w;   // scale by strength and daylight
  return vec4<f32>(vec3<f32>(1.0 - shadow), 1.0);
}
