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
  params : vec4<f32>,     // x = max march distance (m) ; y = step count ; z = strength [0..1] ; w = thickness slab (m)
  camPos : vec4<f32>,     // xyz = camera world position (for metric depth comparison)
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
  // Contact shadows are a SHORT-RANGE effect (rope/rail/hull-meets-water). Near the horizon a single texel
  // spans a huge world distance and NDC depth precision collapses, so the depth-reconstructed normal below
  // goes noisy and the grazing gate flips frame-to-frame -> the distant-ocean strobing. Nothing that far has
  // a legitimate short-range occluder (and the march there is sub-pixel anyway), so fade the whole effect out
  // with camera distance.
  let dCam = distance(u.camPos.xyz, P);
  let distFade = 1.0 - smoothstep(140.0, 320.0, dCam);
  if (distFade <= 0.001) { return vec4<f32>(1.0); }
  let L = normalize(u.sunDir.xyz);
  let steps = i32(u.params.y);
  let stepLen = u.params.x / f32(steps);
  // Interleaved-gradient dither on the start offset hides the low step count.
  let jitter = fract(52.9829189 * fract(dot(in.position.xy, vec2<f32>(0.06711056, 0.00583715))));

  // Geometric normal from depth (oriented toward the camera). On a GRAZING or back-facing surface the sun ray
  // slides along the facet and hits the surface itself — that self-occlusion is the dark-triangle pattern on the
  // faceted ocean and the flashing on the flat sails. Skip those: a facet that grazes/faces away from the sun
  // has no legitimate short-range occluder anyway (its shading comes from normal lighting). Nothing to do with
  // the depth threshold, which is why bias/thickness tweaks and TAA changed nothing.
  let texel = 1.0 / dims;
  let dimI  = vec2<i32>(dims) - vec2<i32>(1);
  let Pr = worldFromUV(uv + vec2<f32>(texel.x, 0.0), textureLoad(depthTex, min(ip + vec2<i32>(1, 0), dimI), 0));
  let Pu = worldFromUV(uv + vec2<f32>(0.0, texel.y), textureLoad(depthTex, min(ip + vec2<i32>(0, 1), dimI), 0));
  var N = normalize(cross(Pu - P, Pr - P));
  if (dot(N, u.camPos.xyz - P) < 0.0) { N = -N; }
  if (dot(N, L) < 0.20) { return vec4<f32>(1.0); }        // grazing / back-facing → no contact shadow
  let Pm = P + N * 0.06;                                  // lift the march off the surface (no self re-entry)

  var occ = 0.0;
  for (var i = 0; i < steps; i = i + 1) {
    let Q = Pm + L * ((f32(i) + jitter) * stepLen);
    let c = u.vp * vec4<f32>(Q, 1.0);
    if (c.w <= 0.0) { break; }
    let sndc = c.xyz / c.w;
    let suv = vec2<f32>(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { break; }
    let sp = vec2<i32>(clamp(suv * dims, vec2<f32>(0.0), dims - 1.0));
    let sd = textureLoad(depthTex, sp, 0);
    if (sd >= 0.99999) { continue; }                       // sky at the sample — no occluder there
    // Compare in WORLD space (metres), NOT raw NDC depth: NDC is wildly non-linear, so the old
    // `sd - u.params.w` slab was effectively half the world (over-occlusion) and the 0.00003 NDC bias let
    // wave crests + sail surfaces self-shadow -> dark triangles on the water + flashing on the sails.
    let occWorld = worldFromUV(suv, sd);                   // frontmost surface at this sample
    let dQ   = distance(u.camPos.xyz, Q);                  // marched point's distance from camera
    let dOcc = distance(u.camPos.xyz, occWorld);           // occluder's distance from camera
    // Occluded when a real surface sits IN FRONT of the march point by [bias, thickness] METRES — a thin
    // slab that skips self/grazing hits (bias) and never shadows through the background (thickness).
    if (dOcc < dQ - 0.08 && dOcc > dQ - u.params.w) {
      occ = max(occ, 1.0 - f32(i) / f32(steps));           // fade with march distance — darkening stays local
    }
  }

  let shadow = occ * u.params.z * u.sunDir.w * distFade;   // scale by strength, daylight, distance falloff
  return vec4<f32>(vec3<f32>(1.0 - shadow), 1.0);
}
