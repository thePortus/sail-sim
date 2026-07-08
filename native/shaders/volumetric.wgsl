// Volumetric sun shafts (opt-in). Marches the view ray from the camera to the depth surface,
// shadow-tests each step against the sun's tight (cascade-0) shadow map, and accumulates
// Henyey-Greenstein in-scatter toward the sun. Where rigging/sails/hull occlude the shadow map,
// the beam is cut → true god-rays through the rigging near the ship; beyond the cascade the air is
// treated as lit, giving a soft sun-ward atmospheric glow. Output is additive into the HDR scene.

const PI : f32 = 3.14159265;

struct VolU {
  invVP    : mat4x4<f32>,   // NDC -> world (camera)
  shadowVP : mat4x4<f32>,   // world -> cascade-0 sun-shadow clip
  sunDir   : vec4<f32>,     // xyz = unit toward the sun ; w = day factor
  sunCol   : vec4<f32>,     // xyz = sun colour * intensity
  camPos   : vec4<f32>,     // xyz camera world pos
  params   : vec4<f32>,     // x = step count, y = density, z = max march distance, w = HG phase g
};
@group(0) @binding(0) var<uniform> u : VolU;
@group(0) @binding(1) var depthTex : texture_depth_2d;
@group(0) @binding(2) var shadowT  : texture_depth_2d;
@group(0) @binding(3) var shadowS  : sampler_comparison;

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

fn hgPhase(cosT : f32, g : f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-4), 1.5));
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let dims = vec2<f32>(textureDimensions(depthTex, 0));
  let ip = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - 1.0));
  let d = textureLoad(depthTex, ip, 0);

  let Pfar = worldFromUV(uv, min(d, 0.99999));
  let ro = u.camPos.xyz;
  let toFar = Pfar - ro;
  let rayLen = min(length(toFar), u.params.z);
  let dir = toFar / max(length(toFar), 1e-4);

  let steps = i32(u.params.x);
  let stepLen = rayLen / f32(steps);
  // Interleaved-gradient dither on the start offset kills banding in the march.
  let jitter = fract(52.9829189 * fract(dot(in.position.xy, vec2<f32>(0.06711056, 0.00583715))));
  let cosT = dot(dir, u.sunDir.xyz);
  let phase = hgPhase(cosT, u.params.w);

  var acc = 0.0;
  for (var i = 0; i < steps; i = i + 1) {
    let P = ro + dir * ((f32(i) + jitter) * stepLen);
    var lit = 1.0;   // outside the cascade → open air (no occluder) → lit
    let sc = u.shadowVP * vec4<f32>(P, 1.0);
    let suv = vec2<f32>(sc.x * 0.5 + 0.5, 0.5 - sc.y * 0.5);
    if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0 && sc.z > 0.0 && sc.z < 1.0) {
      lit = textureSampleCompareLevel(shadowT, shadowS, suv, sc.z - 0.0015);
    }
    acc = acc + lit * stepLen;
  }

  // Only scatter toward the sun (cosT > 0); the phase already concentrates it, this clips the back.
  let shafts = acc * u.params.y * phase * max(cosT, 0.0) * u.sunDir.w;
  return vec4<f32>(u.sunCol.xyz * shafts, 1.0);   // additive into the HDR scene
}
