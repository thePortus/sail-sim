/**
 * Phase 6 — Auxiliary terrain maps baked from the final signed elevation field.
 *
 * These are the SUBSTRATE for the later terrain-skinning effort (and handy for gameplay/AI): they
 * describe the terrain's surface character without re-deriving it at runtime. All are computed from the
 * finished `field` (Float32, metres, signed) AFTER erosion + reefs, so they reflect what actually ships.
 *
 *   • slope     — |∇height| (m/m), the steepness used for rock/scree vs. soil/sand.
 *   • shoreDist — metres to the nearest land (0 on land) — beaches, mangroves, harbour scoring.
 *   • wetness   — low-frequency moisture field (matches the terrain shader's `moist`): lush vs. arid.
 *   • flow      — D8 drainage / water accumulation: river channels, wet valleys, delta mouths.
 *   • biome     — id 0..5 (seabed/sand/grass/gravel/rock/snow), the dominant cover class per cell.
 *
 * The build script packs slope/shoreDist/wetness/flow into one RGBA PNG and biome into a palette PNG.
 */

import { shoreDistanceField } from './reefs.mjs';

/** Slope magnitude |∇h| in metres per metre (0 flat → large on cliffs). */
export function auxSlope(field, OUT, cellM) {
  const out = new Float32Array(OUT * OUT);
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      const i = y * OUT + x;
      const xl = x > 0 ? field[i - 1] : field[i], xr = x < OUT - 1 ? field[i + 1] : field[i];
      const yd = y > 0 ? field[i - OUT] : field[i], yu = y < OUT - 1 ? field[i + OUT] : field[i];
      const gx = (xr - xl) / (2 * cellM), gy = (yu - yd) / (2 * cellM);
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** Low-frequency moisture in [0,1] — the SAME field the terrain shader samples (large island-scale
 *  wet/dry bands + a finer octave). worldX/worldZ are derived from grid coords + worldBounds. */
export function auxMoisture(field, OUT, worldBounds) {
  const out = new Float32Array(OUT * OUT);
  const { minX, maxX, minZ, maxZ } = worldBounds;
  for (let y = 0; y < OUT; y++) {
    const wz = maxZ - (y / (OUT - 1)) * (maxZ - minZ);
    for (let x = 0; x < OUT; x++) {
      const wx = minX + (x / (OUT - 1)) * (maxX - minX);
      const m = 0.5
        + 0.34 * Math.sin(wx * 0.00080 + 1.3)
        + 0.24 * Math.sin(wz * 0.00095 - 0.7)
        + 0.18 * Math.sin((wx - wz) * 0.00060 + 2.1)
        + 0.12 * Math.sin((wx * 0.7 + wz * 1.1) * 0.0022 - 1.1);
      out[y * OUT + x] = Math.max(0, Math.min(1, m));
    }
  }
  return out;
}

/**
 * D8 flow accumulation (drainage). Each land cell sheds its "rain" to its steepest-descent neighbour;
 * processing cells from high to low accumulates flow downhill, so valleys/rivers/deltas light up.
 * Returns raw accumulation counts (land only; sea = 0); the caller log-normalises for display.
 */
export function auxFlow(field, OUT, seaLevel = 0) {
  const acc = new Float32Array(OUT * OUT);
  const down = new Int32Array(OUT * OUT).fill(-1);
  const land = [];
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      const i = y * OUT + x;
      if (field[i] <= seaLevel) continue;
      acc[i] = 1;
      land.push(i);
      // steepest-descent D8 neighbour
      let best = -1, bestDrop = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= OUT || ny >= OUT) continue;
          const ni = ny * OUT + nx;
          const drop = (field[i] - field[ni]) / Math.hypot(dx, dy);
          if (drop > bestDrop) { bestDrop = drop; best = ni; }
        }
      }
      down[i] = best;   // −1 = pit / flows to sea
    }
  }
  // High → low so a cell's total accumulation is known before it drains downhill.
  land.sort((a, b) => field[b] - field[a]);
  for (const i of land) { const d = down[i]; if (d >= 0 && field[d] > seaLevel) acc[d] += acc[i]; }
  return acc;
}

/**
 * Biome id per cell (0 seabed, 1 sand, 2 grass, 3 gravel, 4 rock, 5 snow) — the argmax of the same
 * cover weights the terrain shader blends (height-normalised bands + slope + moisture + shore boost),
 * so the baked map matches what's drawn. `peakElev` = manifest.targetPeakElevation (the h normaliser).
 */
export function auxBiome(field, OUT, slope, moisture, peakElev, seaLevel = 0) {
  const out = new Uint8Array(OUT * OUT);
  const peak = Math.max(1, peakElev);
  for (let i = 0; i < field.length; i++) {
    const yEl = field[i];
    if (yEl <= seaLevel) { out[i] = 0; continue; }   // seabed
    const h = Math.min(1, yEl / peak);
    const sl = Math.min(1.5, slope[i]);               // m/m
    const wet = Math.max(0, Math.min(1, (moisture[i] - 0.25) / 0.53));
    const shoreW = Math.max(0, Math.min(1, 1 - yEl / 10));
    const hSand = Math.max(0, Math.min(1, 1 - h / 0.085));
    const sandSlope = (yEl < 15 ? 1 : Math.max(0, 1 - sl * 1.25));
    let wSand = Math.max(hSand, shoreW) * sandSlope;
    let wGrass = Math.max(0, Math.min(1, (h - 0.035) / 0.28)) * Math.max(0, 1 - sl * 0.95) * (0.35 + 1.30 * wet);
    let wGravel = Math.max(0, Math.min(1, (h - 0.20) / 0.52)) * Math.max(0, 0.25 + sl * 1.5) * (1.45 - 0.75 * wet);
    let wRock = Math.max(0, Math.min(1, (h - 0.34) / 0.54)) * Math.max(0, 0.22 + sl * 1.7) * (1.25 - 0.40 * wet);
    let wSnow = Math.max(0, Math.min(1, (h - 0.66) / 0.16)) * Math.max(0, 1 - sl * 2.2);
    let best = 1, bv = wSand;
    if (wGrass > bv) { bv = wGrass; best = 2; }
    if (wGravel > bv) { bv = wGravel; best = 3; }
    if (wRock > bv) { bv = wRock; best = 4; }
    if (wSnow > bv) { bv = wSnow; best = 5; }
    out[i] = best;
  }
  return out;
}

/** Compute all aux maps from the final field. Returns the raw typed arrays (full OUT resolution). */
export function computeAuxMaps(field, OUT, cellM, worldBounds, peakElev, seaLevel = 0) {
  const slope = auxSlope(field, OUT, cellM);
  const shoreDist = shoreDistanceField(field, OUT, cellM, seaLevel);
  const moisture = auxMoisture(field, OUT, worldBounds);
  const flow = auxFlow(field, OUT, seaLevel);
  const biome = auxBiome(field, OUT, slope, moisture, peakElev, seaLevel);
  return { slope, shoreDist, moisture, flow, biome };
}

/** Palette (RGB) for the biome ids, for the biome PNG + preview. */
export const BIOME_PALETTE = [
  [40, 90, 130],     // 0 seabed  (blue)
  [216, 200, 150],   // 1 sand    (tan)
  [70, 120, 55],     // 2 grass   (green)
  [120, 110, 90],    // 3 gravel  (olive-grey)
  [95, 88, 82],      // 4 rock    (grey-brown)
  [240, 240, 245],   // 5 snow    (white)
];
