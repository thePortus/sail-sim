// Harbor-town layout generator (Harbor Towns v2). Pure-ish + deterministic: given detected pier sites
// (each with a measured inland flat depth/width) and a map seed, it names + tiers each town and lays out
// its buildings, civic square, streets, and a flat pad rectangle — all in WORLD coordinates so the client
// just places them. No terrain access here; the build script passes an elevAt(x,z) sampler + footprints.
//
// Town frame: origin = shore point; +forward = INLAND (the pier extends seaward, the town extends inland);
// +right = perpendicular. Waterfront (shipwright + stilt-shacks) → one/two avenues with flanking house
// columns → an inland civic square (town hall on its inland edge, fountain centred).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './augment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fisher–Yates shuffle driven by a seeded RNG (deterministic per map seed). */
function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** World direction (dx,dz) → heading degrees, matching the seaward heading convention (atan2(x,z)). */
export function dirHeading(dx, dz) { return (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360; }

/**
 * Pick the building roster for a town tier (deterministic via `rng`). Returns the town-hall + fountain
 * variants (or null), whether there's a shipwright, how many stilt-shacks, and an ordered house list
 * (taverns first so they survive a capacity trim). Counts get clamped to the site's flat land in layoutTown.
 */
export function composeTown(tier, rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const fountains = ['fountain_tiered', 'fountain_statue', 'fountain_spout', 'fountain_simple'];
  let townhall = null, fountain = null, taverns = 0, dwellings = 0, shacks = 0;
  if (tier === 'capital') {
    townhall  = rng() < 0.6 ? 'townhall_governor' : 'townhall_magistrate';
    fountain  = pick(fountains);
    taverns   = 1 + Math.floor(rng() * 2);            // 1–2
    dwellings = 8 + Math.floor(rng() * 9);            // 8–16
    shacks    = 1 + Math.floor(rng() * 3);            // 1–3
  } else if (tier === 'medium') {
    townhall  = rng() < 0.8 ? (rng() < 0.5 ? 'townhall_magistrate' : 'townhall_governor') : null;
    fountain  = (townhall && rng() < 0.5) ? pick(fountains) : null;
    taverns   = 1;
    dwellings = 3 + Math.floor(rng() * 4);            // 3–6
    shacks    = rng() < 0.5 ? 1 : 0;
  } else {                                            // small
    townhall  = rng() < 0.3 ? 'townhall_magistrate' : null;
    taverns   = 1;
    dwellings = Math.floor(rng() * 3);                // 0–2
  }
  const houses = [];
  for (let i = 0; i < taverns; i++) houses.push('cabin_tavern');
  for (let i = 0; i < dwellings; i++) houses.push('cabin_dwelling');
  return { townhall, fountain, shipwright: true, shacks, houses };
}

/**
 * Lay out one town in its shore-local frame and return { tier, buildings[], square, streets[], pad }.
 * The lot grid (rowPitch / laneHalf) guarantees no two footprints overlap. Dwelling/avenue counts are
 * clamped to the site's measured flat depth/width so the pad never has to carve into a hillside.
 */
export function layoutTown(town, site, tier, elevAt, fp, rng, wish) {
  const hr = town.heading * Math.PI / 180;
  const fwd = [-Math.sin(hr), -Math.cos(hr)];         // inland (landward)
  const rgt = [ Math.cos(hr), -Math.sin(hr)];         // right (perpendicular)
  const L = (f, s) => ({ x: +(town.x + fwd[0] * f + rgt[0] * s).toFixed(1),
                         z: +(town.z + fwd[1] * f + rgt[1] * s).toFixed(1) });

  const STREET_W = 5, GAP = 3.5;
  const HW = 8.6, HD = 7.5;                            // house lot cell (max of tavern/dwelling footprints)
  const laneHalf = STREET_W / 2 + HD / 2 + GAP;       // side offset of a house column from its avenue
  const rowPitch = HW + GAP;                          // fwd spacing between house rows
  const aveSpacing = 2 * laneHalf + STREET_W + HW;    // gap between the two avenues (capital)

  const SPEC = {
    capital: { avenues: 2, depthM: 80, squareD: 20, squareW: 24 },
    medium:  { avenues: 1, depthM: 50, squareD: 14, squareW: 16 },
    small:   { avenues: 1, depthM: 30, squareD: 0,  squareW: 0  },
  }[tier];

  const WATERFRONT = 20;                              // band reserved near the pier (kept clear of the shore/water cell)
  const usableDepth = Math.max(rowPitch, Math.min(SPEC.depthM, site.inlandFlatM) - WATERFRONT - SPEC.squareD - GAP * 2);
  const usableWidth = Math.min(120, site.flatWidthM);
  const rows = Math.max(1, Math.floor(usableDepth / rowPitch));
  let avenues = SPEC.avenues;
  const widthFor = (n) => n === 2 ? aveSpacing + 2 * laneHalf + HW : 2 * laneHalf + HW;
  while (avenues > 1 && widthFor(avenues) > usableWidth) avenues--;

  const aveOffs = avenues === 2 ? [-aveSpacing / 2, aveSpacing / 2] : [0];
  const cols = [];
  for (const a of aveOffs) { cols.push({ s: a - laneHalf, ave: a }); cols.push({ s: a + laneHalf, ave: a }); }
  const maxHouses = rows * cols.length;

  const buildings = [];
  let minF = Infinity, maxF = -Infinity, minS = Infinity, maxS = -Infinity;
  const place = (asset, f, s, rotDeg, inPad = true) => {
    const p = L(f, s);
    buildings.push({ asset, x: p.x, z: p.z, rotY: Math.round(rotDeg) });
    if (!inPad) return;                               // stilt-shacks live at the waterline, outside the flat apron
    const r = Math.max(fp[asset].w, fp[asset].d) / 2 + 1;
    minF = Math.min(minF, f - r); maxF = Math.max(maxF, f + r);
    minS = Math.min(minS, s - r); maxS = Math.max(maxS, s + r);
  };

  // Waterfront: shipwright off to one side of the pier; stilt-shacks at the water's edge. The shacks sit
  // ON stilts over the water (origin at the waterline), so they're excluded from the flattened pad.
  const swSide = rng() < 0.5 ? -1 : 1;
  place('shipwright_shack', 16, swSide * 12, town.heading);   // ~16 m inland → lands on a LAND cell, not the water shore cell
  for (let i = 0; i < (wish.shacks || 0); i++) {
    place('cabin_shack', 2, (i % 2 ? 1 : -1) * (8 + Math.floor(i / 2) * 5), town.heading, false);
  }

  // Residential: fill the lot grid row by row, each house facing its avenue.
  const houses = wish.houses.slice(0, maxHouses);
  const resFStart = WATERFRONT + HD / 2 + 2;
  let hi = 0;
  for (let r = 0; r < rows && hi < houses.length; r++) {
    for (const c of cols) {
      if (hi >= houses.length) break;
      const faceSign = Math.sign(c.ave - c.s) || 1;   // face toward the avenue
      place(houses[hi++], resFStart + r * rowPitch, c.s, dirHeading(rgt[0] * faceSign, rgt[1] * faceSign));
    }
  }
  const resFEnd = resFStart + (rows - 1) * rowPitch;

  // Civic square (town hall on its inland edge facing seaward, fountain centred) — skipped for tiers/sites
  // without a town hall or square depth.
  let square = null;
  if (wish.townhall && SPEC.squareD > 0) {
    const sqF = resFEnd + GAP + SPEC.squareD / 2;
    const c = L(sqF, 0);
    square = { cx: c.x, cz: c.z, halfX: +(SPEC.squareW / 2).toFixed(1), halfZ: +(SPEC.squareD / 2).toFixed(1), rotY: Math.round(town.heading) };
    minF = Math.min(minF, sqF - SPEC.squareD / 2); maxF = Math.max(maxF, sqF + SPEC.squareD / 2);
    minS = Math.min(minS, -SPEC.squareW / 2);       maxS = Math.max(maxS, SPEC.squareW / 2);
    if (wish.fountain) place(wish.fountain, sqF, 0, town.heading);
    place(wish.townhall, sqF + SPEC.squareD / 2 + fp[wish.townhall].d / 2 + 1, 0, town.heading);
  } else if (wish.townhall) {
    place(wish.townhall, resFEnd + GAP + fp[wish.townhall].d / 2 + 2, 0, town.heading);
  }

  // Streets: a spine along the centreline; for two-avenue towns, each avenue + a waterfront connector.
  const streets = [];
  const ribbon = (f1, s1, f2, s2) => { const a = L(f1, s1), b = L(f2, s2); streets.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z, width: STREET_W }); };
  ribbon(4, 0, square ? resFEnd + GAP : resFEnd, 0);
  for (const a of aveOffs) { if (Math.abs(a) > 0.1) ribbon(resFStart - GAP, a, resFEnd + GAP, a); }
  if (avenues === 2) ribbon(resFStart - GAP, aveOffs[0], resFStart - GAP, aveOffs[1]);

  // Pad: the flat rectangle to bake under the whole town (halfZ along heading/inland, halfX across).
  const M = 4;
  minF -= M; maxF += M; minS -= M; maxS += M;
  const cF = (minF + maxF) / 2, cS = (minS + maxS) / 2, c = L(cF, cS);
  const samples = [];
  for (const df of [-0.45, 0, 0.45]) for (const ds of [-0.45, 0, 0.45]) {
    const p = L(cF + df * (maxF - minF), cS + ds * (maxS - minS));
    samples.push(elevAt(p.x, p.z));
  }
  samples.sort((a, b) => a - b);
  const elev = Math.max(1.2, samples[Math.floor(samples.length / 2)]);
  const pad = { cx: c.x, cz: c.z, halfX: Math.round((maxS - minS) / 2), halfZ: Math.round((maxF - minF) / 2), rotY: Math.round(town.heading), elev: +elev.toFixed(2) };

  return { tier, buildings, square, streets, pad };
}

/**
 * Turn raw pier sites into named, tiered towns with a full building layout. Deterministically (by seed)
 * shuffles the canned name bank, assigns one unique identity per site (capped at the name count), then:
 *   • ranks sites by inland flat land and marks the top ~12 (that actually fit) as CAPITALS;
 *   • tiers the rest medium/small, clamped down where the flat land is too small;
 *   • runs layoutTown for each, with a per-town RNG stream so a town's layout is stable and independent.
 * `elevAt(x,z)` samples the baked field for pad elevation; `footprints` = assets_manifest footprint_m.
 */
export function assignTowns(sites, seed, elevAt, footprints) {
  const bank = JSON.parse(readFileSync(join(__dirname, 'town-names.json'), 'utf8')).towns;
  const rng = mulberry32((seed ?? 1) ^ 0x70c4b0a7);            // distinct stream from terrain/reefs
  const names = seededShuffle(bank, rng);
  const n = Math.min(sites.length, names.length);

  const towns = [];
  for (let k = 0; k < n; k++) {
    const s = sites[k], id = names[k];
    towns.push({ id: `town_${k}`, name: id.name, description: id.description, x: s.x, z: s.z, heading: s.heading, _site: s });
  }

  // Capitals = the most spacious inland sites (need real flat depth + width to host the big layout).
  const CAPITALS = Math.min(12, towns.length);
  const order = towns.map((_, i) => i).sort((a, b) => towns[b]._site.inlandFlatM - towns[a]._site.inlandFlatM);
  const capital = new Set();
  for (const i of order) {
    if (capital.size >= CAPITALS) break;
    const st = towns[i]._site;
    if (st.inlandFlatM >= 55 && st.flatWidthM >= 45) capital.add(i);
  }

  for (let i = 0; i < towns.length; i++) {
    const t = towns[i], st = t._site;
    let tier;
    if (capital.has(i)) tier = 'capital';
    else if (st.inlandFlatM >= 35 && st.flatWidthM >= 24) tier = (rng() < 0.85 ? 'medium' : 'small');
    else tier = 'small';

    // Per-town RNG: stable + independent of neighbours (composeTown then layoutTown share this stream).
    const lr = mulberry32(((seed ?? 1) ^ ((0x9e3779b1 * (i + 1)) >>> 0)) >>> 0);
    // Pier variant: capitals favour the bigger L/T heads; others anything.
    t.variant = tier === 'capital' ? (lr() < 0.5 ? 't' : 'l') : ['straight', 'l', 't'][Math.floor(lr() * 3)];

    const wish = composeTown(tier, lr);
    const layout = layoutTown(t, st, tier, elevAt, footprints, lr, wish);
    t.tier = tier;
    t.pad = layout.pad;
    t.buildings = layout.buildings;
    t.square = layout.square;
    t.streets = layout.streets;
    delete t._site;
  }
  return towns;
}
