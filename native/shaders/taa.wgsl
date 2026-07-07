// Temporal anti-aliasing resolve — opt-in AA mode (gfx.aa == 3), off by default.
//
// The scene is rendered each frame with a sub-pixel Halton jitter on the projection. This pass
// reprojects the previous frame's accumulated history into the current frame via CAMERA MOTION
// (reconstruct world pos from depth + the current inverse view-proj, project with the previous
// view-proj), neighborhood-clamps that history to the current 3x3 colour AABB to reject ghosting
// on disocclusion / moving objects, and blends. Heavy history feedback averages the jittered
// samples into anti-aliasing (and is the substrate for temporal upscaling later).
//
// Camera-motion reprojection only: static world (terrain/sky/islands) is correct; the moving ship
// and waves rely on the neighborhood clamp to stay stable until per-object motion vectors are added.

struct TaaU {
  invVP  : mat4x4<f32>,   // current unjittered inverse view-proj (NDC -> world)
  prevVP : mat4x4<f32>,   // previous frame unjittered view-proj (world -> prev NDC)
  texel  : vec4<f32>,     // x,y = 1/w,1/h ; z = history feedback ; w = 1 if history valid
  params : vec4<f32>,     // x = sharpen amount ; y = variance-clip gamma ; z,w reserved
};
@group(0) @binding(0) var<uniform> u : TaaU;
@group(0) @binding(1) var curTex   : texture_2d<f32>;   // this frame, post-graded (render res)
@group(0) @binding(2) var linSamp  : sampler;
@group(0) @binding(3) var depthTex : texture_depth_2d;  // this frame scene depth (render res)
@group(0) @binding(4) var histTex  : texture_2d<f32>;   // previous frame's TAA output

struct VSOut { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32> };

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let p = pts[vid];
  var o : VSOut;
  o.position = vec4<f32>(p, 0.0, 1.0);
  o.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);   // flip Y to texture space
  return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let cur = textureSampleLevel(curTex, linSamp, uv, 0.0).rgb;
  if (u.texel.w < 0.5) { return vec4<f32>(cur, 1.0); }   // first frame — no history yet

  let res = vec2<i32>(i32(1.0 / u.texel.x + 0.5), i32(1.0 / u.texel.y + 0.5));
  let pix = clamp(vec2<i32>(i32(uv.x * f32(res.x)), i32(uv.y * f32(res.y))), vec2<i32>(0), res - vec2<i32>(1));
  let d = textureLoad(depthTex, pix, 0);

  // Reconstruct world position, reproject into the previous frame.
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let wH = u.invVP * ndc;
  let world = wH.xyz / wH.w;
  let pc = u.prevVP * vec4<f32>(world, 1.0);
  if (pc.w <= 0.0) { return vec4<f32>(cur, 1.0); }
  let pndc = pc.xy / pc.w;
  let puv = vec2<f32>(pndc.x * 0.5 + 0.5, 0.5 - pndc.y * 0.5);
  if (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) { return vec4<f32>(cur, 1.0); }

  var hist = textureSampleLevel(histTex, linSamp, puv, 0.0).rgb;

  // Variance clipping (Salvi): clip history to the current 3x3 colour distribution's mean ± gamma*
  // stddev, NOT its min/max AABB. On high-variance regions (foam/glints/sail-vs-water edges) the AABB
  // is huge and lets stale history smear into rainbow trails; mean±sigma is far tighter, so it rejects
  // the ghosting camera-only reprojection can't. gamma (params.y) tunes tightness — lower = crisper,
  // less ghosting, more shimmer.
  var m1 = vec3<f32>(0.0);
  var m2 = vec3<f32>(0.0);
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let s = textureSampleLevel(curTex, linSamp, uv + vec2<f32>(f32(dx), f32(dy)) * u.texel.xy, 0.0).rgb;
      m1 = m1 + s;
      m2 = m2 + s * s;
    }
  }
  let mean  = m1 * (1.0 / 9.0);
  let sigma = sqrt(max(m2 * (1.0 / 9.0) - mean * mean, vec3<f32>(0.0)));
  let gamma = u.params.y;
  hist = clamp(hist, mean - gamma * sigma, mean + gamma * sigma);

  var outc = mix(cur, hist, u.texel.z);
  // Sharpen: unsharp-mask against the 3x3 mean to claw back the softening from bilinear history
  // resampling (the classic TAA blur). params.x = amount; 0 disables.
  outc = max(outc + (outc - mean) * u.params.x, vec3<f32>(0.0));
  return vec4<f32>(outc, 1.0);
}
