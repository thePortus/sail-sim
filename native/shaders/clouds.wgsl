// Volumetric clouds — WGSL port of the client's volumetric-clouds-plugin
// (itself a faithful port of the Shadertoy 4dSBDt cloud model): a spherical-shell
// ray march with FBM-eroded density, a Beer-Lambert + fitted-Mie light march, and
// weather-texture coverage. Drawn as a full-screen layer after the opaque scene
// with premultiplied-alpha blend; the hardware depth test lets terrain/ships
// occlude it (so the in-shader depth/terrain occlusion of the original is dropped).

struct CloudU {
  invViewProj : mat4x4<f32>,
  camPos      : vec4<f32>,   // xyz camera position
  sunDir      : vec4<f32>,   // xyz unit toward sun
  sunCol      : vec4<f32>,
  skyCol      : vec4<f32>,
  groundCol   : vec4<f32>,
  slab        : vec4<f32>,   // cloudBase, cloudTop, cloudCoverage, cloudType
  anim        : vec4<f32>,   // time, driftX, driftZ, farZ
};
@group(0) @binding(0) var<uniform> u : CloudU;
@group(0) @binding(1) var noiseTex   : texture_2d<f32>;
@group(0) @binding(2) var noiseSamp  : sampler;
@group(0) @binding(3) var weatherTex : texture_2d<f32>;
@group(0) @binding(4) var weatherSamp : sampler;

const PI : f32 = 3.14159265;
const EARTH_RADIUS : f32 = 2000000.0;
// Baked-atlas constants (8x4 grid of 32^3 slices).
const NOISE_SLICE : f32 = 32.0;
const NOISE_DEPTH : f32 = 32.0;
const ATLAS_W : f32 = 256.0;
const ATLAS_H : f32 = 128.0;
const ATLAS_COLS : f32 = 8.0;
const MARCH_STEPS : i32 = 48;
const LIGHT_STEPS : i32 = 6;

fn vc_sat(x : f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn vc_remap(v : f32, lo : f32, hi : f32) -> f32 { return vc_sat((v - lo) / max(hi - lo, 1e-5)); }

// 3-D noise via the 2-D atlas: trilinear Z across two bilinearly-sampled slices.
fn vc_noise3D(uvwIn : vec3<f32>) -> f32 {
  let uvw = fract(uvwIn);
  let z  = uvw.z * NOISE_DEPTH;
  let z0 = floor(z);
  let zf = z - z0;
  let z1 = (z0 + 1.0) % NOISE_DEPTH;
  let halfTexel = 0.5 / NOISE_SLICE;
  let xy = clamp(uvw.xy, vec2<f32>(halfTexel), vec2<f32>(1.0 - halfTexel)) * NOISE_SLICE;
  let atlasSize = vec2<f32>(ATLAS_W, ATLAS_H);
  let uv0 = (vec2<f32>(z0 % ATLAS_COLS, floor(z0 / ATLAS_COLS)) * NOISE_SLICE + xy) / atlasSize;
  let uv1 = (vec2<f32>(z1 % ATLAS_COLS, floor(z1 / ATLAS_COLS)) * NOISE_SLICE + xy) / atlasSize;
  let s0 = textureSampleLevel(noiseTex, noiseSamp, uv0, 0.0).r;
  let s1 = textureSampleLevel(noiseTex, noiseSamp, uv1, 0.0).r;
  return mix(s0, s1, zf);
}
fn vc_noiseST(x : vec3<f32>) -> f32 { return vc_noise3D((x + 0.5) / NOISE_SLICE); }

fn vc_fbm(p0 : vec3<f32>) -> f32 {
  let m = mat3x3<f32>(vec3<f32>(0.00, 0.80, 0.60),
                      vec3<f32>(-0.80, 0.36, -0.48),
                      vec3<f32>(-0.60, -0.48, 0.64));
  var p = p0;
  var f = 0.5000 * vc_noiseST(p); p = m * p * 2.02;
  f = f + 0.2500 * vc_noiseST(p); p = m * p * 2.03;
  f = f + 0.1250 * vc_noiseST(p);
  return f;
}

// Fitted numerical Mie phase (Shadertoy 4sjBDG): sharp forward scatter + glow.
fn vc_mieFit(costh : f32) -> f32 {
  let p0 = 9.805233e-06; let p1 = -6.500000e+01; let p2 = -5.500000e+01;
  let p3 = 8.194068e-01; let p4 = 1.388198e-01;  let p5 = -8.370334e+01;
  let p6 = 7.810083e+00; let p7 = 2.054747e-03;  let p8 = 2.600563e-02;
  let p9 = -4.552125e-12;
  let pp = costh + p3;
  let e = exp(vec4<f32>(p1 * costh + p2, p5 * pp * pp, p6 * costh, p9 * costh));
  return dot(e, vec4<f32>(p0, p4, p7, p8));
}

// Ray vs concentric cloud shell at altitude h (numerically stable at planet radius).
fn vc_intersectShell(origin : vec3<f32>, dir : vec3<f32>, h : f32) -> f32 {
  let R = EARTH_RADIUS;
  let L = origin.y + R;
  let b = 2.0 * (L * dir.y);
  let c = (origin.y - h) * (origin.y + 2.0 * R + h);
  let disc = b * b - 4.0 * c;
  if (disc < 0.0) { return -1.0; }
  var sq = sqrt(disc); if (b < 0.0) { sq = -sq; }
  let q = (-b + sq) / 2.0;
  var t0 = q; var t1 = c / q;
  if (t0 > t1) { let tmp = t0; t0 = t1; t1 = tmp; }
  if (t1 < 0.0) { return -1.0; }
  if (t0 < 0.0) { return t1; }
  return t0;
}

fn vc_cloudHeight(p : vec3<f32>) -> f32 {
  let center = vec3<f32>(u.camPos.x, -EARTH_RADIUS, u.camPos.z);
  let atmoHeight = length(p - center) - EARTH_RADIUS;
  return vc_sat((atmoHeight - u.slab.x) / max(u.slab.y - u.slab.x, 1.0));
}

// Faithful port of the Shadertoy clouds(): weather coverage x vertical profile x
// pow() shape x two-octave fbm erosion. lod>=1.5 = cheap path (light march).
fn vc_getDensity(p : vec3<f32>, lod : f32) -> f32 {
  let ch = vc_cloudHeight(p);
  if (ch <= 0.0 || ch >= 1.0) { return 0.0; }
  let cloudType = u.slab.w;
  let coverage  = u.slab.z;
  let storm = smoothstep(0.40, 0.95, cloudType);

  let wd  = u.anim.yz;
  let pzx = p.zx + wd.yx;
  let drift = vec3<f32>(wd.x, 0.0, wd.y);
  let evo = u.anim.x * 3.0;

  let largeWeather = clamp((textureSampleLevel(weatherTex, weatherSamp, -0.00005 * pzx, 0.0).r - 0.18) * 5.0, 0.0, 2.0);
  let covThresh = 0.28 - (coverage - 0.5) * 0.5 - storm * 0.05;
  var weather = largeWeather * max(0.0, textureSampleLevel(weatherTex, weatherSamp, 0.0002 * pzx, 0.0).r - covThresh) / 0.72;
  weather = weather * smoothstep(0.0, 0.5, ch) * smoothstep(1.0, 0.5, ch);
  let cloudShape = pow(weather, 0.3 + 1.5 * smoothstep(0.2, 0.5, ch));
  if (cloudShape <= 0.0) { return 0.0; }

  var den = max(0.0, cloudShape - 0.7 * vc_fbm((p + drift) * 0.01));
  if (den <= 0.0) { return 0.0; }
  let dScale = mix(0.20, 0.32, storm);
  if (lod >= 1.5) { return largeWeather * dScale * min(1.0, 5.0 * den); }
  den = max(0.0, den - 0.24 * vc_fbm((p + drift + vec3<f32>(0.0, evo, 0.0)) * 0.075));   // finer erosion -> crisper billows
  return largeWeather * dScale * min(1.0, 5.0 * den);
}

// Light march toward the sun: multi-term Beer-Lambert x Mie phase x silver lining.
fn vc_lightMarch(p : vec3<f32>, phase : f32, dC : f32, mu : f32, jOff : f32) -> f32 {
  let ch = vc_cloudHeight(p);
  let stepL = (u.slab.y - u.slab.x) / f32(LIGHT_STEPS);
  var den = 0.0;
  let q = p + u.sunDir.xyz * stepL * jOff;
  for (var j = 0; j < LIGHT_STEPS; j = j + 1) {
    den = den + vc_getDensity(q + u.sunDir.xyz * f32(j) * stepL, 2.0);
  }
  let scatterAmount = mix(0.008, 1.0, smoothstep(0.96, 0.0, mu));
  // Lower multi-scatter coefficients than the reference: they kept the deep/underside
  // of the cloud lit (a flat, over-bright base), washing out the self-shadow. Smaller
  // values let dense regions go properly dark so the base reads as grey shadow.
  let beersLaw = exp(-stepL * den)
               + 0.34 * scatterAmount * exp(-0.1 * stepL * den)
               + 0.22 * scatterAmount * exp(-0.02 * stepL * den);
  return beersLaw * phase
       * mix(0.05 + 1.5 * pow(min(1.0, dC * 8.5), 0.3 + 5.5 * ch), 1.0, clamp(den * 0.4, 0.0, 1.0));
}

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0)       ndc      : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VSOut {
  var pts = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o : VSOut;
  o.position = vec4<f32>(pts[vid], 1.0, 1.0);   // z=1 (far) so depth test lets geometry occlude
  o.ndc = pts[vid];
  return o;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  let wF4 = u.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let wF = wF4.xyz / wF4.w;
  let rd = normalize(wF - u.camPos.xyz);

  var tNear = vc_intersectShell(u.camPos.xyz, rd, u.slab.x);
  var tFar  = vc_intersectShell(u.camPos.xyz, rd, u.slab.y);
  if (rd.y < 0.02 || tNear < 0.0 || tFar <= tNear) { return vec4<f32>(0.0); }
  tNear = max(tNear, 0.01);
  tFar  = min(tFar, u.anim.w);

  let dist = max(tFar - tNear, 0.0);
  let stepSz = dist / f32(MARCH_STEPS);

  let jit01 = fract(52.9829189 * fract(dot(in.position.xy, vec2<f32>(0.06711056, 0.00583715))));
  let jit = jit01 * stepSz;
  let cosA = dot(rd, u.sunDir.xyz);
  let phase = vc_mieFit(cosA);

  var transmit = 1.0;
  var scatter = vec3<f32>(0.0);
  var t = tNear + jit;
  let bigStep = stepSz * 3.0;
  var fine = false;

  for (var i = 0; i < MARCH_STEPS; i = i + 1) {
    if (t >= tFar || transmit < 0.02) { break; }
    let p = u.camPos.xyz + rd * t;
    let rho = vc_getDensity(p, 0.0);
    if (!fine) {
      if (rho > 0.001) { t = t - bigStep; fine = true; continue; }
      t = t + bigStep;
      continue;
    }
    if (rho > 0.001) {
      let lt = vc_lightMarch(p, phase, rho, cosA, jit01);
      let ch = vc_cloudHeight(p);
      // Ambient (sky/ground fill) is kept moderate — enough that shadowed undersides
      // read as medium grey, but NOT so strong it floods them up to the sunlit
      // brightness (which erased the self-shadowing and made clouds a flat blob). The
      // contrast between the dark shadow (ambient only) and the bright sunlit face
      // (the large sun term below) is what gives the billows their form.
      let ambLift = mix(2.5, 1.25, smoothstep(0.10, 0.78, u.slab.z));
      // Steep top→base gradient: sunlit tops get the full sky fill, undersides much
      // less, so the base sits in shadow (grey) instead of matching the bright top.
      let ambient = (u.skyCol.xyz * (0.32 + 0.9 * ch) * 0.24
                   + u.groundCol.xyz * (1.0 - ch) * 0.20) * ambLift;
      let radiance = ambient + u.sunCol.xyz * 15.0 * lt;
      let sT = exp(-rho * stepSz);
      scatter = scatter + transmit * radiance * (1.0 - sT);
      transmit = transmit * sT;
    }
    t = t + stepSz;
  }

  let stormDetail = smoothstep(0.45, 0.85, u.slab.z);
  scatter = mix(scatter, pow(max(scatter, vec3<f32>(0.0)), vec3<f32>(0.62)), stormDetail);
  scatter = scatter * mix(1.45, 1.0, smoothstep(0.12, 0.55, u.slab.z));

  // Highlight rolloff. The bright sunlit faces (sun term ~2..12) saturate to white
  // while the dark ambient-only shadows (~0.4..0.6) stay a medium grey — so the full
  // dark-shadow → white-top range is preserved, which is what reads as billowed form.
  // (A soft-knee that capped everything at grey killed exactly this contrast.)
  scatter = vec3<f32>(1.0) - exp(-scatter * 1.1);

  // Premultiplied-alpha output: framebuffer = scene*transmit + scatter.
  return vec4<f32>(scatter, 1.0 - transmit);
}
