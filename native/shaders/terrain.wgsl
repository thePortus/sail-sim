// Terrain: a camera-following grid displaced by the world height texture (R32F,
// signed elevation in metres), skinned by the Angular client's biome system:
// baked RGBA splat-map weights (sand/grass/gravel/rock; snow = 1-sum) re-sharpened
// by per-pixel slope, five Polyhaven diffuse tiles blended with multi-scale
// triplanar UVs, per-biome normal perturbation, sedimentary strata on cliffs,
// a wet-sand tide line, and a painted forest canopy — all ported from
// terrain.service.ts. Falls back to simple height-band colours until the biome
// textures arrive (extra.y = 0).

struct TU {
  viewProj : mat4x4<f32>,
  eye      : vec4<f32>,   // xyz camera
  bounds   : vec4<f32>,   // minX, maxX, minZ, maxZ (world metres)
  misc     : vec4<f32>,   // x,y = texW,texH ; z,w = origin (ship x,z)
  sun      : vec4<f32>,   // xyz light direction; w = daylight factor
  extra    : vec4<f32>,   // x = peak elevation (m); y = biome textures ready;
                          // z = inner discard half-size (far ring; 0 = near grid)
};
@group(0) @binding(0)  var<uniform> u : TU;
@group(0) @binding(1)  var heightTex : texture_2d<f32>;
@group(0) @binding(2)  var splatTex  : texture_2d<f32>;
@group(0) @binding(3)  var sandTex   : texture_2d<f32>;
@group(0) @binding(4)  var grassTex  : texture_2d<f32>;
@group(0) @binding(5)  var gravelTex : texture_2d<f32>;
@group(0) @binding(6)  var rockTex   : texture_2d<f32>;
@group(0) @binding(7)  var snowTex   : texture_2d<f32>;
@group(0) @binding(8)  var sandNor   : texture_2d<f32>;
@group(0) @binding(9)  var grassNor  : texture_2d<f32>;
@group(0) @binding(10) var rockNor   : texture_2d<f32>;
@group(0) @binding(11) var grass2Tex : texture_2d<f32>;   // variety mixes (anti-tiling)
@group(0) @binding(12) var rock2Tex  : texture_2d<f32>;
@group(0) @binding(13) var tileSamp  : sampler;   // repeat, trilinear, aniso
@group(0) @binding(14) var splatSamp : sampler;   // clamp, bilinear

// ── Sun shadows RECEIVED on land (group 1, so the depth-only shadow CASTER
//    pipeline — which shares group 0 — never binds these while writing them).
//    Same 2-cascade scheme the ocean samples: the tight ship box up close, the
//    wide landscape box out to ~1.7 km, so buildings/piers/trees throw real
//    shadows on the ground. ──
struct TShadow {
  vp0    : mat4x4<f32>,   // world -> sun clip, tight (ship) cascade
  vp1    : mat4x4<f32>,   // world -> sun clip, wide (far landscape) cascade
  vp2    : mat4x4<f32>,   // world -> sun clip, mid cascade (trees / near land)
  params : vec4<f32>,     // x = enabled; y = bias0; z = bias1; w = shadow texel (uv)
};
@group(1) @binding(0) var<uniform> ts : TShadow;
@group(1) @binding(1) var shadowT0 : texture_depth_2d;
@group(1) @binding(2) var shadowT1 : texture_depth_2d;
@group(1) @binding(3) var shadowT2 : texture_depth_2d;
@group(1) @binding(4) var shadowSamp : sampler_comparison;

// 3x3 PCF against a cascade; returns visibility, or -1 if the point is outside it.
fn pcfCascade(t : texture_depth_2d, vp : mat4x4<f32>, worldPos : vec3<f32>, bias : f32, margin : f32) -> f32 {
  let sp = vp * vec4<f32>(worldPos, 1.0);
  let uv = vec2<f32>(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
  if (uv.x <= margin || uv.x >= 1.0 - margin || uv.y <= margin || uv.y >= 1.0 - margin ||
      sp.z <= 0.0 || sp.z >= 1.0) { return -1.0; }
  let px = ts.params.w;
  var s = 0.0;
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      s += textureSampleCompareLevel(t, shadowSamp, uv + vec2<f32>(f32(dx), f32(dy)) * px, sp.z - bias);
    }
  }
  return s / 9.0;
}

fn sunShadowLand(worldPos : vec3<f32>) -> f32 {
  if (ts.params.x < 0.5) { return 1.0; }
  // Pick the TIGHTEST in-range cascade: ship box -> mid box -> wide box. Each has
  // finer texels than the last, so beach tree shadows stay crisp with no coarse
  // seam until the far cascade takes over well past the trees.
  let v0 = pcfCascade(shadowT0, ts.vp0, worldPos, ts.params.y, 0.01);
  if (v0 >= 0.0) { return v0; }
  let v2 = pcfCascade(shadowT2, ts.vp2, worldPos, ts.params.z, 0.008);
  if (v2 >= 0.0) { return v2; }
  let v1 = pcfCascade(shadowT1, ts.vp1, worldPos, ts.params.z, 0.005);
  if (v1 >= 0.0) { return v1; }
  return 1.0;
}

fn worldToTexel(wx : f32, wz : f32) -> vec2<f32> {
  let ux = (wx - u.bounds.x) / (u.bounds.y - u.bounds.x);
  let uz = (u.bounds.w - wz) / (u.bounds.w - u.bounds.z);   // +Z is south
  return vec2<f32>(ux * u.misc.x - 0.5, uz * u.misc.y - 0.5);
}
fn loadH(ix : i32, iz : i32) -> f32 {
  let w = i32(u.misc.x); let h = i32(u.misc.y);
  return textureLoad(heightTex, vec2<i32>(clamp(ix, 0, w - 1), clamp(iz, 0, h - 1)), 0).r;
}
fn sampleH(wx : f32, wz : f32) -> f32 {
  let tc = worldToTexel(wx, wz);
  let i0 = vec2<i32>(floor(tc));
  let f  = fract(tc);
  let h00 = loadH(i0.x, i0.y);     let h10 = loadH(i0.x + 1, i0.y);
  let h01 = loadH(i0.x, i0.y + 1); let h11 = loadH(i0.x + 1, i0.y + 1);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
// World XZ -> [0,1] uv over the terrain bounds (same flip as the heightfield —
// the splat map is baked in heightfield orientation).
fn worldToUV(wx : f32, wz : f32) -> vec2<f32> {
  return vec2<f32>((wx - u.bounds.x) / (u.bounds.y - u.bounds.x),
                   (u.bounds.w - wz) / (u.bounds.w - u.bounds.z));
}

// Value noise (port of the client's _dHash/_dVal) — biome-edge + macro breakup.
fn dHash(p : vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn dVal(p : vec2<f32>) -> f32 {
  let i = floor(p); let f = fract(p);
  let uu = f * f * (3.0 - 2.0 * f);
  return mix(mix(dHash(i), dHash(i + vec2<f32>(1.0, 0.0)), uu.x),
             mix(dHash(i + vec2<f32>(0.0, 1.0)), dHash(i + vec2<f32>(1.0, 1.0)), uu.x), uu.y);
}

// Forest moisture field (low-frequency; shared by biome wetness + canopy).
fn forestMoist(wp : vec3<f32>) -> f32 {
  return 0.5
    + 0.34 * sin(wp.x * 0.00080 + 1.3)
    + 0.24 * sin(wp.z * 0.00095 - 0.7)
    + 0.18 * sin((wp.x - wp.z) * 0.00060 + 2.1)
    + 0.12 * sin((wp.x * 0.7 + wp.z * 1.1) * 0.0022 - 1.1);
}

// Biome weights from the baked control/splat map, re-sharpened on cliffs by the
// per-pixel slope (the splat is ~24 m/texel -> smooth). Returns (sand, grass,
// gravel, rock); snow = 1 - sum. Port of the client's _biomeSplat.
fn biomeSplat(wp : vec3<f32>, nW : vec3<f32>) -> vec4<f32> {
  let s = textureSample(splatTex, splatSamp, worldToUV(wp.x, wp.z));
  var wSand = s.r; var wGrass = s.g; var wGravel = s.b; var wRock = s.a;
  var wSnow = max(0.0, 1.0 - (s.r + s.g + s.b + s.a));
  let slope = 1.0 - clamp(nW.y, 0.0, 1.0);
  let steep = smoothstep(0.35, 0.72, slope);
  wRock  = max(wRock, steep);
  wGrass = wGrass * (1.0 - steep * 0.9);
  wSand  = wSand  * (1.0 - steep * 0.7);
  // Snow line by slope + ASPECT: snow clings to flatter, shaded faces; steep +
  // sun-facing faces go bare rock. FIXED sunny azimuth (seasonal average — the
  // moving sun must not make snow flicker). Melted snow becomes rock.
  let nh = nW.xz; let nhl = length(nh);
  var aspect = 0.0;
  if (nhl > 1e-3) { aspect = dot(nh / nhl, vec2<f32>(0.5, -0.866)); }
  let snowMelt = clamp(max(smoothstep(0.32, 0.62, slope),
                           smoothstep(0.0, 0.7, aspect) * smoothstep(0.06, 0.30, slope) * 0.8), 0.0, 1.0);
  let melted = wSnow * snowMelt; wSnow = wSnow - melted; wRock = wRock + melted;
  // Biome-edge softening: fine (~1.7 m) noise breaks hard borders so materials
  // interlock. Grass/sand trade tufts; gravel scree along rock/grass borders.
  let en = dVal(wp.xz * 1.10) * 0.6 + dVal(wp.xz * 3.40 + vec2<f32>(13.0)) * 0.4;
  let eb = (en - 0.5) * 2.0;
  let sg = clamp(min(wSand, wGrass) * 4.0, 0.0, 1.0);
  wGrass = wGrass + eb * sg * 0.5; wSand = wSand - eb * sg * 0.5;
  let rg = clamp(min(wRock, wGrass) * 4.0, 0.0, 1.0);
  let scree = smoothstep(0.55, 0.85, en) * rg;
  wGravel = wGravel + scree * 0.6; wRock = wRock - scree * 0.3; wGrass = wGrass - scree * 0.3;
  wSand = max(wSand, 0.0); wGrass = max(wGrass, 0.0); wGravel = max(wGravel, 0.0); wRock = max(wRock, 0.0);
  let t = max(1e-4, wSand + wGrass + wGravel + wRock + wSnow);
  return vec4<f32>(wSand, wGrass, wGravel, wRock) / t;
}

// Fine triplanar sample of one tile: 3 planar projections weighted by triW.
fn tri(tex : texture_2d<f32>, wp : vec3<f32>, s : f32, triW : vec3<f32>) -> vec3<f32> {
  return textureSample(tex, tileSamp, wp.yz * s).rgb * triW.x
       + textureSample(tex, tileSamp, wp.xz * s).rgb * triW.y
       + textureSample(tex, tileSamp, wp.xy * s).rgb * triW.z;
}
// Triplanar normal-map sample, reoriented to world space per projection plane
// (OpenGL convention: R=+U, G=+V, B=+N — port of the client's section 9).
fn triNor(tex : texture_2d<f32>, wp : vec3<f32>, s : f32, triW : vec3<f32>) -> vec3<f32> {
  let nYZ = textureSample(tex, tileSamp, wp.yz * s).rgb * 2.0 - 1.0;
  let nXZ = textureSample(tex, tileSamp, wp.xz * s).rgb * 2.0 - 1.0;
  let nXY = textureSample(tex, tileSamp, wp.xy * s).rgb * 2.0 - 1.0;
  return normalize(vec3<f32>(nYZ.b, nYZ.r, nYZ.g) * triW.x
                 + vec3<f32>(nXZ.r, nXZ.b, nXZ.g) * triW.y
                 + vec3<f32>(nXY.r, nXY.g, nXY.b) * triW.z);
}

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0)       worldPos : vec3<f32>,
  @location(1)       elev     : f32,   // raw elevation for colour + waterline cull
};

@vertex
fn vs_main(@location(0) inXZ : vec2<f32>) -> VSOut {
  let wx = inXZ.x + u.misc.z;   // grid follows the ship
  let wz = inXZ.y + u.misc.w;
  let y  = sampleH(wx, wz);
  var o : VSOut;
  o.worldPos = vec3<f32>(wx, y, wz);
  o.elev     = y;
  o.position = u.viewProj * vec4<f32>(o.worldPos, 1.0);
  return o;
}

// Height-banded fallback (until the biome textures arrive).
fn biomeColor(h : f32) -> vec3<f32> {
  let sand   = vec3<f32>(0.78, 0.72, 0.52);
  let grass  = vec3<f32>(0.34, 0.46, 0.20);
  let jungle = vec3<f32>(0.15, 0.30, 0.12);
  let rock   = vec3<f32>(0.42, 0.38, 0.33);
  var c = sand;
  c = mix(c, grass,  smoothstep(0.6, 5.0, h));
  c = mix(c, jungle, smoothstep(10.0, 45.0, h));
  c = mix(c, rock,   smoothstep(70.0, 150.0, h));
  return c;
}

@fragment
fn fs_main(in : VSOut) -> @location(0) vec4<f32> {
  // Far ring: leave the centre square to the detailed near grid (extra.z = its
  // half-size with slop for the differing origin snaps; 0 on the near grid).
  if (u.extra.z > 0.0 &&
      max(abs(in.worldPos.x - u.misc.z), abs(in.worldPos.z - u.misc.w)) < u.extra.z) { discard; }
  // Mirror clip (extra.w = 1 only in the reflection pass): a planar mirror
  // across y=0 must reflect ONLY geometry above the water — without this the
  // seabed (below y=0 for kilometres) fills the whole mirror and buries the
  // island reflections under a wall of sand.
  if (u.extra.w > 0.5 && in.worldPos.y < 0.02) { discard; }
  // The seabed DRAWS now (no waterline cull): the ocean surface above is
  // alpha-blended by true depth, so submerged sand shows through the shallows.
  // Underwater fragments get absorption shading below so reef flats read as
  // drowned sand, never as exposed green land.

  let wp = in.worldPos;
  let e = (u.bounds.y - u.bounds.x) / u.misc.x;   // ~one texel in metres
  let hl = sampleH(wp.x - e, wp.z); let hr = sampleH(wp.x + e, wp.z);
  let hd = sampleH(wp.x, wp.z - e); let hu = sampleH(wp.x, wp.z + e);
  var N = normalize(vec3<f32>(hl - hr, 2.0 * e, hd - hu));
  let L = normalize(u.sun.xyz);

  let slope = 1.0 - clamp(N.y, 0.0, 1.0);
  let moist = forestMoist(wp);
  let wetF  = smoothstep(0.25, 0.78, clamp(moist, 0.0, 1.0));
  let h01   = clamp(wp.y / max(u.extra.x, 1.0), 0.0, 1.0);

  // Triplanar plane weights from the geometric normal.
  var aw = pow(abs(N), vec3<f32>(4.0));
  let triW = aw / (aw.x + aw.y + aw.z);

  // ── Biome weights (splat + slope sharpening + edge noise) ───────────────────
  let bw = biomeSplat(wp, N);
  let wSand = bw.x; let wGrass = bw.y; let wGravel = bw.z; let wRock = bw.w;
  let wSnow = max(0.0, 1.0 - (bw.x + bw.y + bw.z + bw.w));

  // ── Texture-variety blend noise (client section 6): slow sinusoids (~880-1460 m
  //    period) smoothly mix each biome's two textures so big faces don't repeat. ──
  let rMix = cos(wp.z * 0.0071 + wp.x * 0.0043) * 0.5 + 0.5;
  let gMix = sin(wp.x * 0.0055 + wp.z * 0.0031) * 0.5 + 0.5;

  // ── Multi-scale triplanar diffuse per biome (client section 7 scales) ───────
  // Sand — 15 m fine + 55 m coarse XZ, warmed to golden beach tone.
  let sandFine = tri(sandTex, wp, 0.067, triW);
  let sandRaw  = sandFine * 0.65
               + textureSample(sandTex, tileSamp, wp.xz * 0.018).rgb * 0.35;
  let sandC = clamp(sandRaw * vec3<f32>(1.20, 1.08, 0.80), vec3<f32>(0.0), vec3<f32>(1.0));
  // Grass — 20 m fine blending grass <-> grass2 + 75 m coarse XZ tonal anchor.
  let grassFine = mix(tri(grassTex, wp, 0.050, triW), tri(grass2Tex, wp, 0.044, triW), gMix);
  let grassRaw = grassFine * 0.65
               + textureSample(grassTex, tileSamp, wp.xz * 0.013).rgb * 0.35;
  // Tame the vivid, plasticy green: desaturate toward an olive luminance + dim a touch, so grasslands read as
  // natural matte turf rather than bright plastic.
  let grassLum = dot(grassRaw, vec3<f32>(0.36, 0.5, 0.14));
  let grassC = mix(grassRaw, vec3<f32>(grassLum) * vec3<f32>(0.86, 0.94, 0.62), 0.32) * 0.90;
  // Gravel — 25 m fine + 50 m coarse ROCK tri (cross-texture macro).
  let gravC = tri(gravelTex, wp, 0.040, triW) * 0.55
            + tri(rockTex,   wp, 0.020, triW) * 0.45;
  // Rock — 12/14 m fine blending rock <-> rock2 + 40 m coarse GRAVEL tri.
  let rockFine = mix(tri(rockTex, wp, 0.083, triW), tri(rock2Tex, wp, 0.071, triW), rMix);
  let rockC = rockFine * 0.55
            + tri(gravelTex, wp, 0.025, triW) * 0.45;
  // Snow — 30 m fine + 100 m coarse XZ.
  let snowC = tri(snowTex, wp, 0.033, triW) * 0.70
            + textureSample(snowTex, tileSamp, wp.xz * 0.010).rgb * 0.30;

  // ── Weighted blend + macro tonal modulation (slow ~500 m brightness drift) ──
  var col = sandC * wSand + grassC * wGrass + gravC * wGravel
          + rockC * wRock + snowC * wSnow;
  let macroMod = 0.90 + 0.20 * dVal(wp.xz * 0.002);
  col = clamp(col * macroMod, vec3<f32>(0.0), vec3<f32>(1.0));

  // ── Sedimentary strata on steep rock faces (client 8b) ──────────────────────
  let strataGate = smoothstep(0.18, 0.45, slope) * clamp(wRock + wGravel, 0.0, 1.0);
  let warp  = sin(wp.x * 0.030 + wp.z * 0.021) * 1.6
            + sin(wp.x * 0.011 - wp.z * 0.014) * 2.4;
  let band1 = sin(wp.y * 0.55 + warp);
  let band2 = sin(wp.y * 1.70 + warp * 0.6);
  let strata = (band1 * 0.7 + band2 * 0.3) * 0.5 + 0.5;
  col = col * mix(1.0, 0.88 + 0.24 * strata, strataGate);

  // ── Wet sand / tide line (client 8c): damp darkened band above the waterline ─
  let wetBand = (1.0 - smoothstep(0.0, 3.5, wp.y))
              * smoothstep(-1.0, 0.3, wp.y) * wSand;
  let wetLum = dot(col, vec3<f32>(0.299, 0.587, 0.114));
  let wetCol = mix(col, vec3<f32>(wetLum), 0.25) * 0.62;
  col = mix(col, wetCol, wetBand);
  let Vw   = normalize(u.eye.xyz - wp);
  let fres = pow(1.0 - clamp(dot(Vw, N), 0.0, 1.0), 4.0);
  col = col + vec3<f32>(0.45, 0.62, 0.82) * (fres * wetBand * 0.20);   // wet sheen toward sky

  // ── Forest canopy paint (client 8d): dense forest as terrain shading ────────
  let fElev  = smoothstep(0.045, 0.11, h01) * (1.0 - smoothstep(0.60, 0.72, h01));
  let fSlope = clamp(1.0 - slope * 1.45, 0.0, 1.0);
  let fMoist = smoothstep(0.30, 0.60, moist);
  let fpw = sin(wp.x * 0.0021 + wp.z * 0.0013)
          + sin(wp.z * 0.0026 - wp.x * 0.0009 + 2.0)
          + sin((wp.x + wp.z) * 0.0015 - 1.0);
  let fPatch  = smoothstep(-0.2, 1.1, fpw);
  let forestF = clamp(fElev * fSlope * fMoist * fPatch, 0.0, 1.0);
  // Canopy colour: deep green, mottled by finer clump noise, greener when wet.
  let mott = sin(wp.x * 0.045) * sin(wp.z * 0.045) * 0.5 + 0.5;
  let canopyDark = mix(vec3<f32>(0.07, 0.15, 0.06), vec3<f32>(0.10, 0.20, 0.07), wetF);
  let canopyLit  = mix(vec3<f32>(0.14, 0.27, 0.11), vec3<f32>(0.20, 0.34, 0.14), wetF);
  col = mix(col, mix(canopyDark, canopyLit, mott), forestF * 0.94);
  // Lumpy canopy normal: treetops catch the sun, valleys self-shade.
  let cq  = wp.xz * 0.085;
  let c0  = sin(cq.x) * sin(cq.y);
  let cgx = (sin(cq.x + 0.15) * sin(cq.y) - c0) / 0.15;
  let cgz = (sin(cq.x) * sin(cq.y + 0.15) - c0) / 0.15;
  N = normalize(N + vec3<f32>(-cgx, 0.0, -cgz) * (forestF * 0.5));

  // ── Per-biome tiled normal perturbation (client section 9) ──────────────────
  // sand -> ripple grain; grass -> leaf litter; gravel/rock/snow -> rock face.
  let snW = triNor(sandNor,  wp, 0.067, triW);
  let gnW = triNor(grassNor, wp, 0.050, triW);
  let rnW = triNor(rockNor,  wp, 0.083, triW);
  let tileNorm = normalize(snW * wSand + gnW * wGrass + rnW * (wGravel + wRock + wSnow));
  // Stronger on steep slopes so cliffs read craggy; forests keep their canopy lumps.
  // Ease grass's normal perturbation (× (1 - 0.4·wGrass)) so flat turf reads matte, not bumpy-plasticy.
  let tnStrength = (0.40 + 0.45 * smoothstep(0.25, 0.65, slope)) * (1.0 - forestF) * (1.0 - 0.40 * wGrass);
  N = normalize(N + tileNorm * tnStrength);

  // ── Fallback path: height-band colours until the biome textures arrive ──────
  if (u.extra.y < 0.5) {
    col = biomeColor(in.elev);
    col = mix(col * vec3<f32>(0.72, 0.68, 0.55), col, smoothstep(0.2, 1.5, in.elev));
    let e2 = 1.5 * (u.bounds.y - u.bounds.x) / u.misc.x;
    let hl2 = sampleH(wp.x - e2, wp.z); let hr2 = sampleH(wp.x + e2, wp.z);
    let hd2 = sampleH(wp.x, wp.z - e2); let hu2 = sampleH(wp.x, wp.z + e2);
    N = normalize(vec3<f32>(hl2 - hr2, 2.0 * e2, hd2 - hu2));
  }

  let diff = max(dot(N, L), 0.0);
  // Sun shadows dim only the DIRECT term (buildings/piers/trees on land, plus
  // the ship near shore); the ambient 0.32 stays so shadowed ground isn't black.
  let sunVis = sunShadowLand(wp);
  col = col * (0.32 + 0.68 * diff * sunVis);
  // Underwater: the client's exact seabed grade — a fixed sandy-dim multiply that
  // fades to dark at night. sunUp is reconstructed from the daylight factor.
  //
  // ── Scalloped waterline (LAND side of the client's shoreline noise) ──────────
  // The grade used to switch on a DEAD-STRAIGHT elev<0.2 contour — the ruler line
  // where dry sand meets wet. Perturb that threshold with world-space value noise
  // (~1.4 m scallop + ~4.6 m octave + ~0.17 m dither) and feather it, so the wet
  // line undulates like a real shore. Uses the SAME world coords + noise as the
  // ocean shallows (ocean_surface.wgsl), so land + water disguise the line together.
  {
    let sunEl = u.sun.w * 0.2 - 0.1;
    let sunUp = smoothstep(0.0, 0.12, sunEl);
    // Undulation: drift the scallop noise slowly ALONG the shore (travelling waves)
    // and add a ~8 s ebb-and-flow wash that breathes the whole line up/down, so the
    // waterline is alive instead of a frozen wavy contour. Time = u.eye.w (sim clock).
    let tSec = u.eye.w;
    let drift = vec2<f32>(tSec * 0.12, tSec * 0.05);
    let shScal = dVal((wp.xz + drift) * 0.70) * 0.75 + dHash(floor((wp.xz + drift) * 2.3)) * 0.25;   // [0,1]
    let shDith = dVal(wp.xz * 6.0);                                              // [0,1] (fine grain stays put)
    let ebb = sin(tSec * 0.8 + wp.x * 0.13 + wp.z * 0.09) * 0.10
            + sin(tSec * 1.3 - wp.z * 0.18) * 0.05;                              // ±0.15 m wash
    // Amplitude knobs (metres of threshold wobble): SCALLOP breaks it into waves,
    // DITHER fuzzes the edge. FEATHER softens the razor edge into a wet band.
    let shoreThresh = 0.2 + (shScal - 0.5) * 1.2 + (shDith - 0.5) * 0.5 + ebb;
    let underwater  = 1.0 - smoothstep(shoreThresh - 0.20, shoreThresh + 0.20, in.elev);
    let seabedGrade = vec3<f32>(0.62, 0.62, 0.55) * (0.08 + 0.92 * sunUp);
    col = col * mix(vec3<f32>(1.0, 1.0, 1.0), seabedGrade, underwater);
  }
  // Day/night (u.sun.w = daylight): dim + cool the land toward a moonlit night.
  // Night floor 0.30 (was 0.13) — the client deliberately raised its night
  // ambient/moonlight so mountains read as moonlit, not featureless black.
  let dayK = u.sun.w;
  col = col * mix(0.30, 1.0, dayK) * mix(vec3<f32>(0.48, 0.58, 0.82), vec3<f32>(1.0), dayK);
  // Aerial haze (client EXP2 fog): distant land recedes into the horizon colour.
  let hazeD = distance(u.eye.xyz, in.worldPos);
  let hazeAmt = 1.0 - exp(-pow(hazeD * 0.00009, 2.0));
  let hazeCol = mix(vec3<f32>(0.13, 0.155, 0.21), vec3<f32>(0.66, 0.72, 0.80), dayK);
  col = mix(col, hazeCol, hazeAmt);
  return vec4<f32>(col, 1.0);   // sRGB target does gamma
}
