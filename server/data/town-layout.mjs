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
    taverns   = 2 + Math.floor(rng() * 2);            // 2–3
    dwellings = 22 + Math.floor(rng() * 12);          // 22–33
    shacks    = 1 + Math.floor(rng() * 3);            // 1–3
  } else if (tier === 'medium') {
    townhall  = rng() < 0.8 ? (rng() < 0.5 ? 'townhall_magistrate' : 'townhall_governor') : null;
    fountain  = (townhall && rng() < 0.5) ? pick(fountains) : null;
    taverns   = 1 + Math.floor(rng() * 2);            // 1–2
    dwellings = 12 + Math.floor(rng() * 9);           // 12–20
    shacks    = 1 + (rng() < 0.4 ? 1 : 0);            // 1–2
  } else {                                            // small
    townhall  = rng() < 0.4 ? 'townhall_magistrate' : null;
    taverns   = 1;
    dwellings = 11 + Math.floor(rng() * 5);           // 11–15
    shacks    = rng() < 0.6 ? 1 : 0;                  // ~60% get one
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

  const STREET_W = 5;
  const SPEC = {
    capital: { depthM: 150, squareD: 20, squareW: 24, maxStreets: 4, targetWidthM: 90 },
    medium:  { depthM: 95,  squareD: 14, squareW: 16, maxStreets: 3, targetWidthM: 58 },
    small:   { depthM: 80,  squareD: 0,  squareW: 0,  maxStreets: 2, targetWidthM: 42 },
  }[tier];

  // Town extends up to ~46 m past the naturally-flat land (the pad flattens the rest), so even tight sites
  // host a proper number of houses. Layout is ORGANIC: a few WANDERING streets, with houses placed along
  // both sides at jittered spacing/setback and rotated to face the local street direction (+ a little skew).
  const WATERFRONT = 20;                              // band reserved near the pier (clear of the shore/water cell)
  const usableDepth = Math.max(20, Math.min(SPEC.depthM, site.inlandFlatM + 46) - WATERFRONT - SPEC.squareD - 8);
  const usableWidth = Math.min(SPEC.targetWidthM, site.flatWidthM + 30);

  const buildings = [];
  const placed = [];                                 // {x,z,r} for greedy overlap rejection
  let minF = Infinity, maxF = -Infinity, minS = Infinity, maxS = -Infinity;
  // Town-local direction (df=inland, ds=across) → world heading degrees.
  const localHeading = (df, ds) => dirHeading(fwd[0] * df + rgt[0] * ds, fwd[1] * df + rgt[1] * ds);
  const place = (asset, f, s, rotDeg, inPad = true) => {
    const p = L(f, s);
    buildings.push({ asset, x: p.x, z: p.z, rotY: Math.round(rotDeg) });
    placed.push({ x: p.x, z: p.z, r: Math.hypot(fp[asset].w, fp[asset].d) / 2 + 0.6 });
    if (!inPad) return;                              // stilt-shacks live at the waterline, outside the flat apron
    const rr = Math.max(fp[asset].w, fp[asset].d) / 2 + 1;
    minF = Math.min(minF, f - rr); maxF = Math.max(maxF, f + rr);
    minS = Math.min(minS, s - rr); maxS = Math.max(maxS, s + rr);
  };
  const overlaps = (x, z, r) => placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r);

  // Waterfront: shipwright near the pier (on the quay/land).
  const swSide = rng() < 0.5 ? -1 : 1;
  place('shipwright_shack', 16, swSide * 14, town.heading + (rng() - 0.5) * 30);

  // Stilt-shacks: out over the harbour water, off to the side of the pier. Placed SEAWARD of the shore (ff<0,
  // beyond the raised quay's a-range) so the quay never lifts them onto land, and where the natural seabed is
  // already water (findHarbors guarantees navigable water seaward). The shack sits at the waterline (client
  // y=0) — the seabed depth below is hidden underwater. Excluded from the pad.
  let shacksLeft = wish.shacks || 0;
  if (shacksLeft > 0) {
    for (const ff of [-15, -18, -21, -13, -24]) {
      for (const mag of [11, 14, 17]) for (const sgn of [swSide, -swSide]) {
        if (shacksLeft <= 0) break;
        const s = sgn * mag, p = L(ff, s), e = elevAt(p.x, p.z);
        if (e < -0.4 && !overlaps(p.x, p.z, 4)) {
          place('cabin_shack', ff, s, town.heading + (rng() - 0.5) * 45, false);
          shacksLeft--;
        }
      }
      if (shacksLeft <= 0) break;
    }
  }

  // Civic square (inland end): town hall + fountain. Placed BEFORE the houses so the greedy fill flows around it.
  const resF0 = WATERFRONT + 6, resF1 = resF0 + usableDepth;
  let square = null;
  if (wish.townhall && SPEC.squareD > 0) {
    const sqF = resF1 + 6 + SPEC.squareD / 2;
    const c = L(sqF, 0);
    square = { cx: c.x, cz: c.z, halfX: +(SPEC.squareW / 2).toFixed(1), halfZ: +(SPEC.squareD / 2).toFixed(1), rotY: Math.round(town.heading) };
    minF = Math.min(minF, sqF - SPEC.squareD / 2 - 2); maxF = Math.max(maxF, sqF + SPEC.squareD / 2 + 2);
    minS = Math.min(minS, -SPEC.squareW / 2 - 2);      maxS = Math.max(maxS, SPEC.squareW / 2 + 2);
    if (wish.fountain) place(wish.fountain, sqF, 0, town.heading);
    place(wish.townhall, sqF + SPEC.squareD / 2 + fp[wish.townhall].d / 2 + 1, 0, town.heading);
  } else if (wish.townhall) {
    place(wish.townhall, resF1 + 6 + fp[wish.townhall].d / 2, (rng() - 0.5) * 18 + town.heading);
  }

  // ── Streets: several wandering, roughly-parallel lanes (dense → lots of house frontage), then CONNECTORS
  //    that tie them into one network (no orphan roads): a cross-street across the front + back of the lanes,
  //    and a spine joining the lanes to the pier-front and the square. ──
  const streets = [];
  const seg = (P, Q) => { const A = L(P.f, P.s), B = L(Q.f, Q.s); streets.push({ x1: A.x, z1: A.z, x2: B.x, z2: B.z, width: STREET_W }); };
  const nLanes = Math.max(1, Math.min(SPEC.maxStreets, Math.floor(usableWidth / 19)));
  const lines = [];                                  // sAt functions (house frontage runs along these)
  const fronts = [], backs = [];                     // lane endpoints, for the cross-connectors
  for (let k = 0; k < nLanes; k++) {
    const baseS = nLanes === 1 ? (rng() - 0.5) * 6 : (k / (nLanes - 1) - 0.5) * (usableWidth - 18);
    const amp = 5 + rng() * 9, ph = rng() * Math.PI * 2, fr = 0.6 + rng() * 1.5, tilt = (rng() - 0.5) * 0.45;
    const sAt = (f) => baseS + tilt * (f - resF0) + amp * Math.sin(ph + fr * Math.PI * (f - resF0) / Math.max(1, resF1 - resF0));
    lines.push(sAt);
    const front = { f: resF0, s: sAt(resF0) }; fronts.push(front);
    let pcur = front;
    for (let f = resF0 + 7; f <= resF1; f += 7) { const np = { f, s: sAt(f) }; seg(pcur, np); pcur = np; }
    backs.push(pcur);
  }
  // Connectors: chain the lane fronts together + the lane backs together, then a spine from the front-centre
  // out to the pier (f≈3) and from the back-centre to the square centre — so the whole town is one network.
  for (let k = 0; k < nLanes - 1; k++) { seg(fronts[k], fronts[k + 1]); seg(backs[k], backs[k + 1]); }
  const mid = Math.floor(nLanes / 2);
  seg({ f: 3, s: 0 }, fronts[mid]);
  if (square) seg(backs[mid], { f: resF1 + 6 + SPEC.squareD / 2, s: 0 });

  // House candidate lots along both sides of each lane (jittered position/setback, rotated to face the road).
  const cands = [];
  for (const sAt of lines) {
    for (let f = resF0 + rng() * 3; f <= resF1; f += 7.5 + rng() * 2.5) {
      const sc = sAt(f), ds = (sAt(f + 1) - sAt(f - 1)) / 2, tl = Math.hypot(1, ds);
      const nF = -ds / tl, nS = 1 / tl;
      for (const side of [-1, 1]) {
        const setback = STREET_W / 2 + 4.1 + rng() * 1.8;
        cands.push({
          f: f + nF * side * setback + (rng() - 0.5) * 1.6,
          s: sc + nS * side * setback + (rng() - 0.5) * 1.6,
          rot: localHeading(-nF * side, -nS * side) + (rng() - 0.5) * 28,
        });
      }
    }
  }

  // Greedy: drop each wishlist house into the next candidate lot that doesn't overlap anything placed.
  const houses = wish.houses.slice();
  let hi = 0;
  for (const c of cands) {
    if (hi >= houses.length) break;
    const asset = houses[hi];
    const r = Math.hypot(fp[asset].w, fp[asset].d) / 2 + 0.6;
    const p = L(c.f, c.s);
    if (overlaps(p.x, p.z, r)) continue;
    place(asset, c.f, c.s, c.rot);
    hi++;
  }

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
