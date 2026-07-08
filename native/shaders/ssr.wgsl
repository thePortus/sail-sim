// Screen-space reflections (opt-in). Reads the composited HDR scene + depth, reconstructs a
// geometric normal from depth (no G-buffer), reflects the view ray, and marches it in world space
// against the depth buffer; on a hit it samples the scene colour and adds it back, Fresnel-weighted
// (grazing angles reflect most → wet-deck / hull sheen). Output = scene + reflection, so the post
// pass grades it as usual. Camera-only geometric normals: fine for low-frequency reflections.

struct SsrU {
  invVP  : mat4x4<f32>,   // NDC -> world
  vp     : mat4x4<f32>,   // world -> NDC (marching)
  eye    : vec4<f32>,     // camera world pos (xyz)
  params : vec4<f32>,     // x = SSR strength (0 = off), y = max world distance, z = step count, w = water-cut height
  fog    : vec4<f32>,     // x = distance density, y = height falloff scale, z = sea-level Y, w = fog amount (0 = off)
  fogCol : vec4<f32>,     // xyz = fog / aerial-haze colour (matches the horizon sky)
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
  var col = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;

  let ip = vec2<i32>(clamp(uv * dims, vec2<f32>(0.0), dims - 1.0));
  let d = textureLoad(depthTex, ip, 0);
  if (d >= 0.99999) { return vec4<f32>(col, 1.0); }   // sky — untouched by SSR/fog

  let P = worldFromUV(uv, d);

  // ── SSR: only non-water surfaces above the water cut (params.x = strength; 0 = SSR off). The ocean
  //    (Y below the cut) is skipped — its planar mirror covers it and depth-normals on waves smear. ──
  if (u.params.x > 0.001 && P.y >= u.params.w) {
    let Pr = worldFromUV(uv + vec2<f32>(texel.x, 0.0), textureLoad(depthTex, ip + vec2<i32>(1, 0), 0));
    let Pu = worldFromUV(uv + vec2<f32>(0.0, texel.y), textureLoad(depthTex, ip + vec2<i32>(0, 1), 0));
    var N = normalize(cross(Pu - P, Pr - P));
    let V = normalize(u.eye.xyz - P);
    if (dot(N, V) < 0.0) { N = -N; }
    let fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);   // grazing reflects most
    if (fres >= 0.03) {
      let R = reflect(-V, N);
      let steps = i32(u.params.z);
      let stepLen = u.params.y / f32(steps);
      var Q = P + N * 0.08;
      for (var i = 0; i < steps; i = i + 1) {
        Q = Q + R * stepLen;
        let c = u.vp * vec4<f32>(Q, 1.0);
        if (c.w <= 0.0) { break; }
        let sndc = c.xyz / c.w;
        let suv = vec2<f32>(sndc.x * 0.5 + 0.5, 0.5 - sndc.y * 0.5);
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { break; }
        let sp = vec2<i32>(clamp(suv * dims, vec2<f32>(0.0), dims - 1.0));
        let sd = textureLoad(depthTex, sp, 0);
        if (sndc.z > sd + 0.00002 && sndc.z < sd + 0.004) {   // hit (behind surface, within thickness)
          let edge = min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y));
          col = col + textureSampleLevel(sceneTex, samp, suv, 0.0).rgb * smoothstep(0.0, 0.08, edge) * fres * u.params.x;
          break;
        }
      }
    }
  }

  // ── Aerial fog: exponential distance fog × a height falloff (denser near sea level), toward the
  //    horizon-sky colour, so distant islands and sea recede into atmospheric haze (fog.w = amount). ──
  if (u.fog.w > 0.001) {
    let dist = length(P - u.eye.xyz);
    let distF = 1.0 - exp(-dist * u.fog.x);
    let heightF = exp(-max(P.y - u.fog.z, 0.0) * u.fog.y);
    let f = clamp(distF * heightF * u.fog.w, 0.0, 1.0);
    col = mix(col, u.fogCol.xyz, f);
  }

  return vec4<f32>(col, 1.0);
}
