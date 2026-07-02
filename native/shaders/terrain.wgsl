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
  extra    : vec4<f32>,   // x = peak elevation (m); y = biome textures ready
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
  // Only land above the waterline draws; the sea covers the seabed, so shallow
  // reef flats read as water, not exposed green land.
  if (in.elev < 0.2) { discard; }

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
  let grassC = grassFine * 0.65
             + textureSample(grassTex, tileSamp, wp.xz * 0.013).rgb * 0.35;
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
  let tnStrength = (0.40 + 0.45 * smoothstep(0.25, 0.65, slope)) * (1.0 - forestF);
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
  col = col * (0.32 + 0.68 * diff);
  // Day/night (u.sun.w = daylight): dim + cool the land toward a moonlit night.
  let dayK = u.sun.w;
  col = col * mix(0.13, 1.0, dayK) * mix(vec3<f32>(0.48, 0.58, 0.82), vec3<f32>(1.0), dayK);
  return vec4<f32>(col, 1.0);   // sRGB target does gamma
}
