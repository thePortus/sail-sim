/**
 * Phase 2a — Seed-driven GEOMETRIC augmentation of a real-data region.
 *
 * A single integer seed deterministically derives a set of cheap, lossless-ish transforms that make
 * one real archipelago read as a fresh world every match, while staying grounded in real landforms:
 *
 *   • orientation — one of 8 dihedral poses (rot 0/90/180/270 × optional mirror), FREE for the 90°
 *     multiples (no resample, no empty corners), plus a small continuous rotation jitter for variety.
 *   • zoom + pan  — sample a sub-window of the source (a different stretch of the archipelago).
 *   • sea-level   — shift the whole field up/down a few metres. With REAL bathymetry this is the
 *     killer knob: drop the sea and atolls/shoals surface into islands & beaches; raise it and
 *     islands shrink to reef rings and bays flood. Huge variety for ~free.
 *
 * Transforms act on normalised output coords (u,v ∈ [0,1]); the build script maps the transformed
 * (u,v) to geographic lon/lat and samples the sources. Out-of-window samples fall back to open ocean.
 */

/** Mulberry32 — tiny deterministic PRNG. Same seed → same world, forever. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive augmentation params from a seed (+ optional archetype, so atolls get bolder sea-level swings).
 * Returns the params, a transform(u,v) function, and a human label for logs/manifest.
 */
export function deriveAugment(seed, archetype = '') {
  const rng = mulberry32(seed);
  const mirror = rng() < 0.5;
  const quarter = Math.floor(rng() * 4);                 // 0..3 → 0/90/180/270°
  const jitterDeg = (rng() * 2 - 1) * 12;                // ±12° continuous wobble
  const rot = (quarter * 90 + jitterDeg) * Math.PI / 180;
  const zoom = 0.78 + rng() * 0.17;                      // 0.78..0.95 (sample a sub-window → pan room)
  const margin = (1 - zoom) * 0.5;                       // keep the window inside the source
  const panU = (rng() * 2 - 1) * margin;
  const panV = (rng() * 2 - 1) * margin;
  // Sea-level offset (m): + raises land out of the water (sea drops), − floods it. Atolls/reef-lagoon
  // archetypes get a wider swing because their character lives within a few metres of sea level.
  const seaSwing = /atoll|reef|cay/.test(archetype) ? 6 : 4;
  const seaLevel = (rng() * 2 - 1) * seaSwing;

  const cosR = Math.cos(rot), sinR = Math.sin(rot);
  const transform = (u, v) => {
    let cu = u - 0.5, cv = v - 0.5;
    if (mirror) cu = -cu;
    const ru = (cu * cosR - cv * sinR) * zoom + panU;
    const rv = (cu * sinR + cv * cosR) * zoom + panV;
    return [ru + 0.5, rv + 0.5];
  };

  const label = `rot${Math.round(quarter * 90 + jitterDeg)}°${mirror ? '+mirror' : ''} `
    + `zoom${zoom.toFixed(2)} pan(${panU.toFixed(2)},${panV.toFixed(2)}) sea${seaLevel >= 0 ? '+' : ''}${seaLevel.toFixed(1)}m`;

  return { seed, mirror, rot, zoom, panU, panV, seaLevel, transform, label };
}
