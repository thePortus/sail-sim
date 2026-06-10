/**
 * Phase 3 — Bathymetry polish: procedural reefs / shelves / seamounts for the baked elevation field
 * (Float32, metres, signed; land > 0, seabed < 0, waterline at 0).
 *
 * GEBCO bathymetry is ~460 m/sample — it gives the real MACRO seafloor (shelves, basins, island
 * drop-offs) but nothing fine: no reefs, no ripples, no hazards. These passes ADD that structure
 * procedurally and SEEDED, keyed to the coastline, depth, and region archetype, so every world gets
 * believable near-shore reefs. They act ONLY underwater; real land + macro bathy are left intact.
 *
 * P3a (this file, for now): shore-distance transform + fringing reefs + seabed micro-relief.
 * P3b (later): lagoon shelves + seamounts (incl. rare surface-breaching islet hazards).
 *
 * Mirrors erode.mjs: in-place Float32 passes, deterministic via mulberry32, gentle by design.
 */

import { mulberry32 } from './augment.mjs';

// ── Cheap value-noise fBm (local copy so this module stands alone) ───────────────
function hash2(x, z) { return ((Math.sin(x * 127.1 + z * 311.7) * 43758.5453) % 1 + 1) % 1; }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, z) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < 4; o++) { s += amp * vnoise(x * f + o * 19.3, z * f - o * 7.1); norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-9))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ── Per-archetype reef profiles (the "character" knobs; seed jitters them in deriveReefs) ────────
// crestDepth/flatDepth are NEGATIVE elevations (m). distM are metres from shore. intensity 0..1.
// passDensity 0..1 → fraction of the reef broken by channels (higher = more gaps / patchier).
// lagoonStrength 0..1 (0 = no lagoon flattening), lagoonDepth = target lagoon floor (m, negative),
// seamountCount = baseline number of offshore seamounts/pinnacles to stamp.
const ARCHETYPE_REEF = {
  // Crest/flat depths sit below storm-trough reach (~2 m + seed jitter) so re-raised reef tops are
  // never exposed by waves — they read as bright shallows, not breaching sand (user feedback).
  'atoll':                 { intensity: 0.95, crestDepth: -2.2, flatDepth: -3.6, crestDistM: 150, foreReefM: 70, passDensity: 0.30, maxBaseDepth: 38, detailAmp: 0.8, lagoonStrength: 0.85, lagoonDepth: -5,  seamountCount: 3 },
  'reef-lagoon':           { intensity: 0.95, crestDepth: -2.2, flatDepth: -3.6, crestDistM: 150, foreReefM: 70, passDensity: 0.32, maxBaseDepth: 38, detailAmp: 0.8, lagoonStrength: 0.80, lagoonDepth: -6,  seamountCount: 3 },
  'volcanic-barrier-reef': { intensity: 0.90, crestDepth: -2.4, flatDepth: -3.8, crestDistM: 180, foreReefM: 80, passDensity: 0.35, maxBaseDepth: 42, detailAmp: 0.8, lagoonStrength: 0.70, lagoonDepth: -9,  seamountCount: 6 },
  'shield-volcano':        { intensity: 0.55, crestDepth: -1.6, flatDepth: -3.5, crestDistM: 90,  foreReefM: 55, passDensity: 0.45, maxBaseDepth: 30, detailAmp: 0.7, lagoonStrength: 0.0,  lagoonDepth: -8,  seamountCount: 12 },
  'volcanic-multi-island': { intensity: 0.55, crestDepth: -1.6, flatDepth: -3.5, crestDistM: 95,  foreReefM: 55, passDensity: 0.45, maxBaseDepth: 30, detailAmp: 0.7, lagoonStrength: 0.0,  lagoonDepth: -8,  seamountCount: 12 },
  'eroded-rocky':          { intensity: 0.28, crestDepth: -1.8, flatDepth: -3.5, crestDistM: 65,  foreReefM: 45, passDensity: 0.62, maxBaseDepth: 24, detailAmp: 0.6, lagoonStrength: 0.0,  lagoonDepth: -6,  seamountCount: 2 },
  'hilly-small-isles':     { intensity: 0.32, crestDepth: -1.8, flatDepth: -3.5, crestDistM: 70,  foreReefM: 45, passDensity: 0.58, maxBaseDepth: 26, detailAmp: 0.6, lagoonStrength: 0.0,  lagoonDepth: -6,  seamountCount: 3 },
};
const DEFAULT_REEF = { intensity: 0.45, crestDepth: -1.6, flatDepth: -3.2, crestDistM: 90, foreReefM: 55, passDensity: 0.45, maxBaseDepth: 30, detailAmp: 0.7, lagoonStrength: 0.0, lagoonDepth: -7, seamountCount: 4 };

/** Derive a seeded reef profile for an archetype (so reefs vary per world but stay believable). */
export function deriveReefs(seed, archetype = '') {
  const base = ARCHETYPE_REEF[archetype] ?? DEFAULT_REEF;
  const rng = mulberry32((seed ^ 0x5eedbeef) >>> 0);
  const j = (v, frac) => v * (1 + (rng() * 2 - 1) * frac);   // ±frac jitter
  const p = {
    intensity:    Math.max(0, Math.min(1, j(base.intensity, 0.12))),
    crestDepth:   j(base.crestDepth, 0.20),
    flatDepth:    j(base.flatDepth, 0.18),
    crestDistM:   j(base.crestDistM, 0.22),
    foreReefM:    j(base.foreReefM, 0.20),
    passDensity:  Math.max(0, Math.min(1, j(base.passDensity, 0.18))),
    maxBaseDepth: j(base.maxBaseDepth, 0.15),
    detailAmp:    Math.max(0, j(base.detailAmp, 0.20)),
    lagoonStrength: Math.max(0, Math.min(1, j(base.lagoonStrength, 0.12))),
    lagoonDepth:  j(base.lagoonDepth, 0.20),
    seamountCount: Math.max(0, Math.round(j(base.seamountCount, 0.35))),
    noiseOff:     (rng() * 1000) | 0,
  };
  p.label = `int${p.intensity.toFixed(2)} crest${p.crestDepth.toFixed(1)}m dist${p.crestDistM.toFixed(0)}m pass${p.passDensity.toFixed(2)} detail±${p.detailAmp.toFixed(1)}m lagoon${p.lagoonStrength.toFixed(2)}@${p.lagoonDepth.toFixed(0)}m smt${p.seamountCount}`;
  return p;
}

/**
 * Distance (METRES) from each cell to the nearest SOURCE cell (isSource(i) === true); 0 at a source.
 * Two-pass chamfer transform (ortho 1, diagonal √2 in cell units) — cheap O(N), ~Euclidean.
 */
function chamferDistance(OUT, cellM, isSource) {
  const BIG = 1e9, SQRT2 = Math.SQRT2;
  const d = new Float32Array(OUT * OUT);
  for (let i = 0; i < d.length; i++) d[i] = isSource(i) ? 0 : BIG;
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    const i = y * OUT + x; let v = d[i];
    if (y > 0)              v = Math.min(v, d[i - OUT] + 1);
    if (x > 0)              v = Math.min(v, d[i - 1] + 1);
    if (y > 0 && x > 0)     v = Math.min(v, d[i - OUT - 1] + SQRT2);
    if (y > 0 && x < OUT - 1) v = Math.min(v, d[i - OUT + 1] + SQRT2);
    d[i] = v;
  }
  for (let y = OUT - 1; y >= 0; y--) for (let x = OUT - 1; x >= 0; x--) {
    const i = y * OUT + x; let v = d[i];
    if (y < OUT - 1)              v = Math.min(v, d[i + OUT] + 1);
    if (x < OUT - 1)              v = Math.min(v, d[i + 1] + 1);
    if (y < OUT - 1 && x < OUT - 1) v = Math.min(v, d[i + OUT + 1] + SQRT2);
    if (y < OUT - 1 && x > 0)     v = Math.min(v, d[i + OUT - 1] + SQRT2);
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] *= cellM;
  return d;
}

/** Distance (METRES) from each cell to the nearest LAND cell (height > seaLevel); 0 on land. */
export function shoreDistanceField(field, OUT, cellM, seaLevel = 0) {
  return chamferDistance(OUT, cellM, (i) => field[i] > seaLevel);
}

/**
 * Fringing reefs: raise the seabed toward a shallow crest in a band hugging the shore, with a reef
 * flat, an algal crest just below the surface, and the natural slope left as the fore-reef beyond it.
 * Broken into segments by a low-frequency noise gate (navigable passes/channels), with fine crest
 * roughness (coral). Only lifts where the natural seabed is deeper than the reef profile AND not in
 * open deep water (so it never walls a cliff up from the abyss), and never breaks the surface.
 */
export function fringingReefs(field, OUT, seed, shoreDist, profile, cellM, seaLevel = 0) {
  const { intensity, crestDepth, flatDepth, crestDistM, foreReefM, passDensity, maxBaseDepth, noiseOff } = profile;
  if (intensity <= 0) return;
  const CREST = Math.min(crestDepth, -0.4);   // crest stays ≥ 0.4 m submerged (no accidental islets)
  const passFeatM = 230;                       // along-shore channel scale (m)
  const roughFeatM = 17;                        // crest coral roughness scale (m)
  const passThresh = 0.34 + passDensity * 0.30;

  /** Reef target elevation at shore-distance d (m). Below the crest band it plunges → max() reverts. */
  const reefElevAt = (d) => {
    if (d < crestDistM) return lerp(flatDepth, CREST, smoothstep(0, crestDistM, d));
    return lerp(CREST, -300, smoothstep(crestDistM, crestDistM + foreReefM, d));   // fore-reef → natural
  };

  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      const i = y * OUT + x;
      const natural = field[i];
      if (natural >= seaLevel) continue;                       // land
      const d = shoreDist[i];
      if (d > crestDistM + foreReefM) continue;                // outside reef reach
      // Only reef on shallow-ish bases (skip drop-offs into the deep).
      const baseGate = 1 - smoothstep(maxBaseDepth - 6, maxBaseDepth + 6, -natural);
      if (baseGate <= 0) continue;
      // Channels/passes: low-freq along-shore noise carves gaps so the reef never seals navigation.
      const nx = (x * cellM) / passFeatM + noiseOff, nz = (y * cellM) / passFeatM - noiseOff;
      const gate = smoothstep(passThresh - 0.09, passThresh + 0.09, fbm(nx, nz));
      if (gate <= 0) continue;
      // Crest roughness (coral lumps) — small, only near the shallow crest.
      const rough = (fbm((x * cellM) / roughFeatM + 5, (y * cellM) / roughFeatM - 7) - 0.5) * 0.7;
      let target = reefElevAt(d) + rough;
      target = Math.min(target, -0.4);                         // re-clamp after roughness
      const lift = target - natural;
      if (lift <= 0) continue;
      field[i] = natural + lift * intensity * baseGate * gate;
    }
  }
}

/**
 * Seabed micro-relief — the underwater analog of erode.mjs addDetail: domain-warped fBm ripples /
 * coral rubble on the shallow seabed, slope-aware and faded out into the deep (the abyss stays
 * smooth). `amp` is peak displacement (m). The "upsample GEBCO" payoff: the smooth bilinear seabed
 * gains real fine structure up close.
 */
export function seabedDetail(field, OUT, seed, opts = {}) {
  const { amp = 0.7, featureM = 15, worldM = 50000, seaLevel = 0 } = opts;
  const off = (mulberry32((seed ^ 0x9e22a1b3) >>> 0)() * 1000) | 0;
  const cell = worldM / (OUT - 1);
  const fScale = cell / featureM;
  const out = new Float32Array(field.length);
  out.set(field);
  for (let y = 1; y < OUT - 1; y++) {
    for (let x = 1; x < OUT - 1; x++) {
      const i = y * OUT + x;
      const h = field[i];
      if (h >= seaLevel) continue;                             // seabed only
      const depth = -h;
      const depthFade = 1 - smoothstep(45, 75, depth);         // detail in the shallows, gone deep
      if (depthFade <= 0) continue;
      const slope = (Math.abs(field[i + 1] - field[i - 1]) + Math.abs(field[i + OUT] - field[i - OUT])) * 0.5;
      const slopeW = Math.min(1, 0.45 + slope / 30);
      const nx = (x + off) * fScale, nz = (y + off) * fScale;
      const wx = nx + (fbm(nx * 0.5 + 11, nz * 0.5 - 4) - 0.5) * 2.0;
      const wz = nz + (fbm(nx * 0.5 - 7, nz * 0.5 + 9) - 0.5) * 2.0;
      out[i] = h + (fbm(wx, wz) - 0.5) * 2 * amp * depthFade * slopeW;
    }
  }
  field.set(out);
}

/**
 * Lagoon shelves: flatten ENCLOSED shallow basins (inside an atoll ring / barrier reef / cluster of
 * islands) up to a calm uniform lagoon floor. Enclosure is detected cheaply with a box-blurred BARRIER
 * mask (land + reef crest, height > −2 m) via an integral image — a cell surrounded by lots of nearby
 * barrier is "inside". Only RAISES (fills depressions up to the floor; never carves), only on shallow
 * basins (deep enclosed basins are left alone), archetype-gated. Run AFTER fringingReefs so the reef
 * crests are part of the barrier ring.
 */
export function lagoonShelves(field, OUT, seed, profile, cellM, seaLevel = 0) {
  const { lagoonStrength, lagoonDepth } = profile;
  if (lagoonStrength <= 0) return;
  const featM = 80;                                            // lagoon-floor undulation scale
  const off = (mulberry32((seed ^ 0x1a607a90) >>> 0)() * 1000) | 0;
  const DEEP = -14;                                            // "open ocean" floods only through water deeper than this

  // Flood the OPEN ocean inward from the map borders, through deep water only. The reef/island ring
  // (shallower than DEEP) blocks the flood, so an enclosed lagoon is never reached.
  const open = new Uint8Array(OUT * OUT);
  const stack = [];
  const push = (i) => { if (field[i] < DEEP && !open[i]) { open[i] = 1; stack.push(i); } };
  for (let x = 0; x < OUT; x++) { push(x); push((OUT - 1) * OUT + x); }
  for (let y = 0; y < OUT; y++) { push(y * OUT); push(y * OUT + OUT - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % OUT, y = (i / OUT) | 0;
    if (x > 0) push(i - 1);
    if (x < OUT - 1) push(i + 1);
    if (y > 0) push(i - OUT);
    if (y < OUT - 1) push(i + OUT);
  }

  // Distance from each cell to the open ocean. Shallow cells FAR from open water = enclosed lagoon
  // (an open-coast shelf is right next to open ocean → small distance → left alone).
  const distOpen = chamferDistance(OUT, cellM, (i) => open[i] === 1);

  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      const i = y * OUT + x;
      const natural = field[i];
      if (natural >= seaLevel) continue;                       // underwater only
      const depth = -natural;
      const depthGate = 1 - smoothstep(20, 38, depth);         // shallow basins only
      if (depthGate <= 0) continue;
      const enclose = smoothstep(150, 480, distOpen[i]);       // sealed off from open water → inside a lagoon
      if (enclose <= 0) continue;
      const undulate = (fbm((x * cellM) / featM + off, (y * cellM) / featM - off) - 0.5) * 1.5;
      const target = lagoonDepth + undulate;
      const lift = target - natural;                           // fill UP to the shelf only
      if (lift <= 0) continue;
      field[i] = natural + lift * lagoonStrength * enclose * depthGate;
    }
  }
}

/**
 * Seamounts: isolated cone-shaped peaks rising from the offshore seabed — submerged scenic mounts,
 * near-surface PINNACLE hazards, and a rare few that BREACH the surface as tiny rocky islet hazards.
 * Placed by rejection sampling in moderately-deep open water (30–280 m, well offshore), spaced apart.
 * Each cone rises from the local seabed to a seeded summit, so it blends into the floor at its skirt
 * (no cliff ring). Run on the signed field in place.
 */
export function seamounts(field, OUT, seed, shoreDist, profile, cellM, seaLevel = 0, countOverride) {
  const count = countOverride != null ? countOverride : profile.seamountCount;
  if (count <= 0) return 0;
  const rng = mulberry32((seed ^ 0x5ea3beef) >>> 0);
  const minOffshore = 800, sepBase = 1.6;                      // m offshore; separation = sepBase × radius
  const placed = [];   // {x, y, R}
  const shape = (t) => { const s = 1 - t * t; return s * s; }; // (1−t²)²: flat-ish summit, smooth skirt

  let attempts = 0, maxAttempts = count * 80;
  while (placed.length < count && attempts++ < maxAttempts) {
    const x = (rng() * OUT) | 0, y = (rng() * OUT) | 0, i = y * OUT + x;
    const natural = field[i], depth = -natural;
    if (depth < 30 || depth > 280) continue;                  // moderate offshore depth (so it can blend + breach)
    if (shoreDist[i] < minOffshore) continue;                 // open water, not hugging islands (reef territory)
    const Rm = 200 + rng() * 600;                             // footprint radius (m)
    const Rc = Rm / cellM;
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < (p.R + Rc) * sepBase)) continue;

    // Summit: rare BREACH (islet), common near-surface PINNACLE, some submerged SCENIC mount.
    const roll = rng();
    let summit;
    if (roll < 0.28)      summit = 1 + rng() * 8;              // breach → +1..+9 m islet (clamped below)
    else if (roll < 0.72) summit = -(2 + rng() * 13);          // pinnacle → −2..−15 m (grounding hazard)
    else                  summit = natural + depth * (0.4 + rng() * 0.35);  // scenic → rises 40–75 % up
    summit = Math.min(summit, 9);                              // keep islets to small rocks, not mountains
    const rise = summit - natural;                            // cone spans seabed → summit
    if (rise <= 1) continue;
    const roughAmp = Math.min(3, rise * 0.03);                // gentle — don't let roughness spike the summit
    const roughOff = (rng() * 1000) | 0;

    const Rci = Math.ceil(Rc);
    for (let dy = -Rci; dy <= Rci; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= OUT) continue;
      for (let dx = -Rci; dx <= Rci; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= OUT) continue;
        const t = Math.hypot(dx, dy) / Rc; if (t >= 1) continue;
        const j = yy * OUT + xx;
        const rough = (fbm(xx / 6 + roughOff, yy / 6 - roughOff) - 0.5) * 2 * roughAmp * (1 - t);
        const cone = natural + rise * shape(t) + rough;
        if (cone > field[j]) field[j] = cone;                 // rise from the floor (max blend at skirt)
      }
    }
    placed.push({ x, y, R: Rc, summit });
  }
  return placed.length;
}

/**
 * Orchestrate the bathymetry-polish passes on the signed field (in place). Returns the seeded profile +
 * the shore-distance field. CLI overrides: `intensity`/`detail`/`lagoon`/`seamounts` (null/undefined →
 * archetype default; 0 → skip that pass).
 */
export function addReefs(field, OUT, seed, opts = {}) {
  const { cellM, worldM = 50000, archetype = '', seaLevel = 0, intensity, detail, lagoon, seamounts: smtCount } = opts;
  const profile = deriveReefs(seed, archetype);
  if (intensity != null) profile.intensity = Math.max(0, Math.min(1, intensity));
  if (detail != null) profile.detailAmp = Math.max(0, detail);
  if (lagoon != null) profile.lagoonStrength = Math.max(0, Math.min(1, lagoon));

  const shoreDist = shoreDistanceField(field, OUT, cellM, seaLevel);
  if (profile.intensity > 0) fringingReefs(field, OUT, seed, shoreDist, profile, cellM, seaLevel);
  if (profile.lagoonStrength > 0) lagoonShelves(field, OUT, seed, profile, cellM, seaLevel);
  const placedSeamounts = seamounts(field, OUT, seed, shoreDist, profile, cellM, seaLevel, smtCount);
  if (profile.detailAmp > 0) seabedDetail(field, OUT, seed, { amp: profile.detailAmp, worldM, seaLevel });

  return { profile, shoreDist, placedSeamounts };
}
