// Screen-space reflections (opt-in). Reads the composited HDR scene + depth, reconstructs a
// geometric normal from depth (no G-buffer), reflects the view ray, and marches it in world space
// against the depth buffer; on a hit it samples the scene colour and adds it back, Fresnel-weighted
// (grazing angles reflect most → wet-deck / hull sheen). Output = scene + reflection, so the post
// pass grades it as usual. Camera-only geometric normals: fine for low-frequency reflections.

struct SsrU {
  invVP  : mat4x4<f32>,   // NDC -> world
  vp     : mat4x4<f32>,   // world -> NDC (marching)
  eye    : vec4<f32>,     // camera world pos (xyz)
  params : vec4<f32>,     // x = strength, y = max world distance, z = step count, w = fade start height
};
@group(0) @binding(0) var<uniform> u : SsrU;
@group(0) @binding(1) var sceneTex : texture_2d<f32>;
@group(0) @binding(2) var samp     : sampler;
@group(0) @binding(3) var depthTex : texture_depth_2d;

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
  let dims = vec2<f32>(textureDimensions(sceneTex, 0));
  let texel = 1.0 / dims;
  let scene = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;

  let ip = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - 1.0));
  let d = textureLoad(depthTex, ip, 0);
  if (d >= 0.99999) { return vec4<f32>(scene, 1.0); }   // sky — nothing to reflect off

  let P = worldFromUV(uv, d);
  // Skip the ocean surface (world Y ≈ 0, ± wave height): its planar reflection already covers it, and
  // depth-reconstructed normals on the choppy waves produce streaky SSR garbage. params.w = cut height.
  if (P.y < u.params.w) { return vec4<f32>(scene, 1.0); }
  // Geometric normal from neighbouring depth (screen-space derivatives via texel taps).
  let Pr = worldFromUV(uv + vec2<f32>(texel.x, 0.0), textureLoad(depthTex, ip + vec2<i32>(1, 0), 0));
  let Pu = worldFromUV(uv + vec2<f32>(0.0, texel.y), textureLoad(depthTex, ip + vec2<i32>(0, 1), 0));
  var N = normalize(cross(Pu - P, Pr - P));
  let V = normalize(u.eye.xyz - P);
  if (dot(N, V) < 0.0) { N = -N; }

  // Fresnel: grazing angles reflect most. Skip near-normal (little reflection → cheap early out).
  let fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  if (fres < 0.03) { return vec4<f32>(scene, 1.0); }

  let R = reflect(-V, N);
  let steps = i32(u.params.z);
  let stepLen = u.params.y / f32(steps);
  var Q = P + N * 0.08;   // bias off the surface to avoid self-hit
  var hitCol = vec3<f32>(0.0);
  var hit = 0.0;
  for (var i = 0; i < steps; i = i + 1) {
    Q = Q + R * stepLen;
    let c = u.vp * vec4<f32>(Q, 1.0);
    if (c.w <= 0.0) { break; }
    let sndc = c.xyz / c.w;
    let suv = vec2<f32>(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { break; }
    let sp = vec2<i32>(clamp(suv * dims, vec2<f32>(0.0), dims - 1.0));
    let sd = textureLoad(depthTex, sp, 0);
    // The marched point is behind the visible surface → a reflected hit. A thickness window
    // avoids reflecting through thin geometry / the far sky.
    if (sndc.z > sd + 0.00002 && sndc.z < sd + 0.004) {
      hitCol = textureSampleLevel(sceneTex, samp, suv, 0.0).rgb;
      // Fade at screen edges so reflections don't pop where the ray leaves the frame.
      let edge = min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y));
      hit = smoothstep(0.0, 0.08, edge);
      break;
    }
  }

  return vec4<f32>(scene + hitCol * hit * fres * u.params.x, 1.0);
}
