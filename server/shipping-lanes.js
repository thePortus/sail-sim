'use strict';
/**
 * shipping-lanes.js — a LIVE "where are the ships" hint for every player's minimap. Instead of where merchants
 * COULD go (static route chokepoints — accurate but unhelpful for actually finding ships), this tracks where the
 * NPC merchant fleet ACTUALLY IS right now: it bins live merchant positions into a coarse grid, smooths it over
 * a few seconds (so the hint is steady, not jittery), and reports the densest cluster(s) as vague glowing zones.
 *
 * Cheap: O(merchants) per refresh, every few seconds. A hotspot is only emitted where there's a REAL cluster
 * (≥ MIN_CLUSTER merchants nearby) so it never points at empty water. `version` bumps only when the reported
 * clusters change cell, so the broadcaster re-sends to clients just on change.
 */
const terrainConfig = require('./config/terrain.config');

const WB = terrainConfig.worldBounds;          // playable envelope (±25000)
const RES = 40;                                // coarse density grid (≈1250 u / cell) → a vague regional hint
const SPLAT = 1;                               // each ship splats over a 3×3 so nearby ships merge into a blob
const EMA = 0.5;                               // new-sample weight per refresh (≈8 s memory at REFRESH_MS) — steadies it
const REFRESH_MS = 4000;                       // re-bin + re-cluster this often (merchants drift slowly)
const MAX_HOTSPOTS = 3;                        // at most this many cluster markers
const MIN_PEAK_FRAC = 0.55;                    // a secondary cluster must be ≥ this × the densest to be worth showing
const SUPPRESS = 7;                            // NMS radius (cells) so clusters are spread apart
const MIN_CLUSTER = 2;                         // a hotspot needs ≥ this many merchants within CLUSTER_R (no empty hints)
const CLUSTER_R = 3200;                        // world units: "near" radius used to count + size a cluster

function worldToRaster(x, z) {
  let cx = Math.floor(((x - WB.minX) / (WB.maxX - WB.minX)) * RES);
  let cz = Math.floor(((z - WB.minZ) / (WB.maxZ - WB.minZ)) * RES);
  cx = cx < 0 ? 0 : cx > RES - 1 ? RES - 1 : cx;
  cz = cz < 0 ? 0 : cz > RES - 1 ? RES - 1 : cz;
  return { cx, cz };
}
function rasterToWorld(cx, cz) {
  return {
    x: WB.minX + ((cx + 0.5) / RES) * (WB.maxX - WB.minX),
    z: WB.minZ + ((cz + 0.5) / RES) * (WB.maxZ - WB.minZ),
  };
}

/** 3×3 box blur so a cluster is a robust REGIONAL blob, not a single-cell spike. */
function blur(acc) {
  const out = new Float32Array(RES * RES);
  for (let z = 0; z < RES; z++) {
    for (let x = 0; x < RES; x++) {
      let s = 0, n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < RES && nz >= 0 && nz < RES) { s += acc[nz * RES + nx]; n++; }
        }
      }
      out[z * RES + x] = s / n;
    }
  }
  return out;
}

// ── state ──────────────────────────────────────────────────────────────────────────────────────────────────
let dens = new Float32Array(RES * RES);   // time-smoothed (EMA) merchant density
let cached = [];                          // current cluster hotspots [{x,z,w}]
let version = 0;
let lastRefresh = 0;

/** Feed the live NPC list each broadcast tick. Throttled internally; updates `cached` + bumps `version` on change. */
function update(npcs, nowMs) {
  const now = nowMs || Date.now();
  if (now - lastRefresh < REFRESH_MS) return;
  lastRefresh = now;

  // Collect this instant's MERCHANT positions (not pirates/hunters — we're hinting at trade traffic).
  const ships = [];
  for (const n of npcs) {
    if (!n || n.isPirate || n.isHunter || !n.state || (n.combat && n.combat.sunk)) continue;
    ships.push({ x: n.state.x, z: n.state.z });
  }

  // Bin this instant with a 3×3 splat, then fold into the smoothed grid (EMA → steady hint, not frame jitter).
  const inst = new Float32Array(RES * RES);
  for (const s of ships) {
    const { cx, cz } = worldToRaster(s.x, s.z);
    for (let dz = -SPLAT; dz <= SPLAT; dz++) {
      for (let dx = -SPLAT; dx <= SPLAT; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= RES || nz < 0 || nz >= RES) continue;
        inst[nz * RES + nx] += Math.max(0, 1 - 0.4 * (Math.abs(dx) + Math.abs(dz)));   // centre heavier
      }
    }
  }
  for (let i = 0; i < dens.length; i++) dens[i] = dens[i] * (1 - EMA) + inst[i] * EMA;

  // Find the densest spaced-apart cells, then KEEP only those that sit on a real cluster of live ships.
  const g = blur(dens);
  let gmax = 0; for (let i = 0; i < g.length; i++) if (g[i] > gmax) gmax = g[i];
  const next = [];
  if (gmax > 0 && ships.length >= MIN_CLUSTER) {
    const used = new Uint8Array(RES * RES);
    const R2 = CLUSTER_R * CLUSTER_R;
    let topCount = 0;
    const raw = [];
    for (let h = 0; h < MAX_HOTSPOTS; h++) {
      let best = -1, bestV = 0;
      for (let i = 0; i < g.length; i++) { if (!used[i] && g[i] > bestV) { bestV = g[i]; best = i; } }
      if (best < 0 || bestV < gmax * MIN_PEAK_FRAC) break;
      const cx = best % RES, cz = (best - cx) / RES;
      for (let dz = -SUPPRESS; dz <= SUPPRESS; dz++) {
        for (let dx = -SUPPRESS; dx <= SUPPRESS; dx++) {
          const nx = cx + dx, nz = cz + dz;
          if (nx >= 0 && nx < RES && nz >= 0 && nz < RES) used[nz * RES + nx] = 1;
        }
      }
      const { x, z } = rasterToWorld(cx, cz);
      let count = 0; for (const s of ships) { const dx = s.x - x, dz = s.z - z; if (dx * dx + dz * dz <= R2) count++; }
      if (count >= MIN_CLUSTER) { raw.push({ x: Math.round(x), z: Math.round(z), count }); if (count > topCount) topCount = count; }
    }
    for (const r of raw) next.push({ x: r.x, z: r.z, w: +(r.count / topCount).toFixed(2) });
  }

  if (JSON.stringify(next) !== JSON.stringify(cached)) { cached = next; version++; }
}

function hotspots() { return cached; }
function getVersion() { return version; }

module.exports = { update, hotspots, getVersion,
  _test: { update, worldToRaster, rasterToWorld, RES, reset() { dens = new Float32Array(RES * RES); cached = []; version = 0; lastRefresh = 0; } } };
