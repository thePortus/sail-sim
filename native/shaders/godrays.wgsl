// God rays (crepuscular light shafts) — screen-space radial light scattering,
// mirroring the client's VolumetricLightScatteringPostProcess. Two entry points:
//
//   fs_occlusion — draw the sun's brightness where the sky is visible, depth-tested
//     so terrain / ocean / ships block it, into an offscreen occlusion mask.
//   fs_blur      — smear the mask radially outward from the sun's screen position
//     and output the shafts (additively blended over the scene by the pipeline).

// ── Occlusion pass ──────────────────────────────────────────────────────────
struct OccU {
  invViewProj : mat4x4<f32>,
  eye         : vec4<f32>,
  sun         : vec4<f32>,   // xyz = toward-sun; w = brightness (day/horizon fade)
};
@group(0) @binding(0) var<uniform> o : OccU;

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0)       ndc      : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : VSOut;
  out.position = vec4<f32>(pts[vid], 1.0, 1.0);   // z=1 (far) — depth test lets geometry occlude
  out.ndc = pts[vid];
  return out;
}

@fragment
fn fs_occlusion(in : VSOut) -> @location(0) vec4<f32> {
  let far = o.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - o.eye.xyz);
  let s = max(dot(dir, normalize(o.sun.xyz)), 0.0);
  // Bright core + a tighter halo — the light source the shafts radiate from.
  let m = pow(s, 240.0) * 1.0 + pow(s, 45.0) * 0.22;
  return vec4<f32>(vec3<f32>(m * o.sun.w), 1.0);
}

// ── Radial-blur / composite pass ────────────────────────────────────────────
struct BlurU {
  sunUV  : vec4<f32>,   // xy = sun screen UV; z = exposure; w = decay
  params : vec4<f32>,   // x = weight, y = density, z = sample count, w = in-view (0/1)
};
@group(0) @binding(0) var<uniform> b : BlurU;
@group(0) @binding(1) var occTex  : texture_2d<f32>;
@group(0) @binding(2) var occSamp : sampler;

@fragment
fn fs_blur(in : VSOut) -> @location(0) vec4<f32> {
  if (b.params.w < 0.5) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }   // sun behind camera / off — no shafts
  let dims = vec2<f32>(textureDimensions(occTex));
  let uv = in.position.xy / dims;

  let N = i32(b.params.z);
  let deltaUV = (b.sunUV.xy - uv) * (b.params.y / b.params.z);   // step toward the sun (density / N)
  var illum = 1.0;
  var col = vec3<f32>(0.0);
  var sampUV = uv;
  for (var i = 0; i < N; i = i + 1) {
    sampUV = sampUV + deltaUV;
    let s = textureSampleLevel(occTex, occSamp, sampUV, 0.0).rgb * illum * b.params.x;
    col = col + s;
    illum = illum * b.sunUV.w;   // exponential decay along the ray
  }
  // Warm shafts, scaled by exposure; additive blend adds them to the scene.
  return vec4<f32>(col * b.sunUV.z * vec3<f32>(1.0, 0.92, 0.78), 1.0);
}
