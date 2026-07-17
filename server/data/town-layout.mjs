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
import factionsPkg from '../factions.js';   // CJS faction config (default import in ESM)

const { factionIds } = factionsPkg;

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
    taverns   = 3 + Math.floor(rng() * 2);            // 3–4
    dwellings = 30 + Math.floor(rng() * 13);          // 30–42 (fills the widened capital footprint)
    shacks    = 2 + Math.floor(rng() * 3);            // 2–4
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
/**
 * Derive a town's defensive WALL PATH from its flat `pad` rectangle (client-agnostic; both the Babylon and
 * native clients walk this same polyline). The pad bounds the whole town, so the path is the pad offset
 * outward by `WALL_M`.
 *
 * Walls are LAND defence — like real Spanish-Main harbor works, the seaward frontage is left OPEN so ships can
 * make the quay (the fort's guns cover the water instead). So this is an OPEN polyline (NOT a closed loop):
 * the two land flanks + the inland back wall enclose the landward sides, and only short SEA-RETURN stubs flank
 * an open harbor MOUTH in the centre of the seaward edge. Consecutive nodes are joined by a straight curtain;
 * there is NO segment closing the last node back to the first (that gap is the harbor mouth).
 *
 * Nodes: { x, z, tag } where tag ∈ 'corner' | 'bastion' | 'gate'. The two seaward corners are bastions (they
 * guard the harbor mouth); capitals bastion the inland corners too. A land GATE on the inland wall can be added
 * later. Kept simple for the wall-path SPIKE (placeholder segments before the modular coquina kit lands).
 */
export function deriveWalls(pad, tier) {
  if (!pad) return [];
  const WALL_M = 6;                                   // curtain stands this far outside the pad apron
  const hr = pad.rotY * Math.PI / 180;
  const fwd = [-Math.sin(hr), -Math.cos(hr)];         // inland (landward); -fwd = seaward (the harbor)
  const rgt = [ Math.cos(hr), -Math.sin(hr)];         // across the frontage
  const hZ = pad.halfZ + WALL_M, hX = pad.halfX + WALL_M;
  const mouth = hX * 0.55;                            // half-width of the OPEN harbor mouth (sea side stays open)
  const W = (df, ds, tag) => ({                       // pad-centre-relative (df along fwd, ds across) → world
    x: +(pad.cx + fwd[0] * df + rgt[0] * ds).toFixed(1),
    z: +(pad.cz + fwd[1] * df + rgt[1] * ds).toFixed(1),
    tag,
  });
  const inland = tier === 'capital' ? 'bastion' : 'corner';
  return [
    W(-hZ, -mouth, 'corner'),   // left sea-return tip (edge of the open harbor mouth)
    W(-hZ, -hX,    'bastion'),  // seaward-left strongpoint
    W( hZ, -hX,    inland),     // inland-left
    W( hZ,  0,     'gate'),     // LAND GATE — centre of the inland back wall (the landward entrance)
    W( hZ,  hX,    inland),     // inland-right
    W(-hZ,  hX,    'bastion'),  // seaward-right strongpoint
    W(-hZ,  mouth, 'corner'),   // right sea-return tip  (OPEN gap back to node 0 = the harbor mouth)
  ];
}

/**
 * Harbor-fort combat spec per town tier (server-authoritative). A fort that FIRES is a combatant, so its exact
 * placement + gun characteristics live here — the clients render from what this emits, they don't compute it, so
 * native and Babylon can never disagree about where the guns are. `range`/`reload`/`damage` are PLACEHOLDERS for
 * the combat pass to tune. Each gun's muzzle is an offset in the fort frame: `fwd` = metres seaward of the fort
 * centre, `side` = metres across (+ = right of seaward), `up` = metres above the pad. Only tiers with an authored
 * GLB + spec get a fort; medium/capital await the T2/T3 forts (walls only until then — an absent entry, not a
 * bug). `glb` is the basename the client loads (`forts/<glb>.glb`).
 */
export const FORT_SPEC = {
  // depth/width = the fort's footprint (metres, seaward × across); depth sets the inland offset (seaward face on
  // the pad), and the client samples the footprint corners to SINK the fort to the lowest ground (never float).
  // flag = the flagstaff-top offset in the fort's LOCAL frame (glTF Y-up); the client hangs flag_<cc>.glb there.
  // accent = this tier carries the per-nation accent turret (accent_<cc>.glb, positioned in the fort's frame).
  small:   { glb: 'fort_t1', depth: 7,  width: 9,  range: 600, reload: 6.0, damage: 25,
             flag: [-3.4, 7.4, 2.1], accent: true,
             guns: [{ fwd: 2.0, side: 0.0, up: 1.3 }] },                       // T1 battery: 1 central gun
  medium:  { glb: 'fort_t2', depth: 11, width: 14, range: 700, reload: 5.5, damage: 32,
             flag: [-4.7, 8.5, 3.3],
             guns: [{ fwd: 4.7, side: -4.8, up: 2.5 }, { fwd: 4.7, side: -1.6, up: 2.5 },
                    { fwd: 4.7, side: 1.6, up: 2.5 },  { fwd: 4.7, side: 4.8, up: 2.5 }] },   // T2: 4 seaward guns
  capital: { glb: 'fort_t3', depth: 16, width: 22, range: 850, reload: 5.0, damage: 40,
             flag: [0, 13.6, 1.6],
             guns: [{ fwd: 7.0, side: -7.5, up: 3.1 }, { fwd: 7.0, side: -4.5, up: 3.1 },
                    { fwd: 7.0, side: -1.5, up: 3.1 }, { fwd: 7.0, side: 1.5, up: 3.1 },
                    { fwd: 7.0, side: 4.5, up: 3.1 },  { fwd: 7.0, side: 7.5, up: 3.1 },       // 6 main battery
                    { fwd: 9.0, side: -10.4, up: 4.3 }, { fwd: 9.0, side: -8.8, up: 4.3 },     // left bastion
                    { fwd: 9.0, side: 8.8, up: 4.3 },  { fwd: 9.0, side: 10.4, up: 4.3 }] },   // right bastion
};

/**
 * Derive a town's harbor fort(s) from its flat `pad` (client-agnostic, like deriveWalls). The T1 battery sits on
 * the seaward centreline, just inside the pad's seaward edge (so it rests on the flat pad — y = pad.elev, never
 * floating), guns facing seaward (= the town's seaward heading). Returns an ARRAY (0 or 1 forts today; kept a
 * list so a capital could later carry a water-battery + a citadel). Each fort carries its authoritative world
 * transform + per-gun muzzle world positions for the combat pass.
 */
export function deriveForts(pad, tier) {
  if (!pad) return [];
  const spec = FORT_SPEC[tier];
  if (!spec) return [];
  const hr = pad.rotY * Math.PI / 180;
  const fwd = [-Math.sin(hr), -Math.cos(hr)];         // inland; -fwd = seaward (guns face -fwd)
  const rgt = [ Math.cos(hr), -Math.sin(hr)];         // across the frontage (+ = right)
  const df = -pad.halfZ + (spec.depth || 8) * 0.5 + 1;   // set inland so the seaward face rests ~1 m inside the pad edge
  const fx = +(pad.cx + fwd[0] * df).toFixed(1);
  const fz = +(pad.cz + fwd[1] * df).toFixed(1);
  const sea = [-fwd[0], -fwd[1]];                     // seaward unit (guns direction)
  const guns = spec.guns.map((g) => ({
    x: +(fx + sea[0] * g.fwd + rgt[0] * g.side).toFixed(1),
    z: +(fz + sea[1] * g.fwd + rgt[1] * g.side).toFixed(1),
    y: +(pad.elev + g.up).toFixed(2),
    heading: pad.rotY, range: spec.range, reload: spec.reload, damage: spec.damage,
  }));
  // hd/hw = footprint half-extents (seaward/across) so the client can sample corners and sink the fort.
  return [{ tier, glb: spec.glb, x: fx, z: fz, y: pad.elev, heading: pad.rotY,
            hd: spec.depth * 0.5, hw: (spec.width || spec.depth) * 0.5,
            flag: spec.flag || null, accent: !!spec.accent, guns }];
}

export function layoutTown(town, site, tier, elevAt, fp, rng, wish) {
  const hr = town.heading * Math.PI / 180;
  const fwd = [-Math.sin(hr), -Math.cos(hr)];         // inland (landward)
  const rgt = [ Math.cos(hr), -Math.sin(hr)];         // right (perpendicular)
  const L = (f, s) => ({ x: +(town.x + fwd[0] * f + rgt[0] * s).toFixed(1),
                         z: +(town.z + fwd[1] * f + rgt[1] * s).toFixed(1) });

  const STREET_W = 5;
  const SPEC = {
    capital: { depthM: 170, squareD: 24, squareW: 28, maxStreets: 5, targetWidthM: 130 },
    medium:  { depthM: 95,  squareD: 14, squareW: 16, maxStreets: 3, targetWidthM: 58 },
    small:   { depthM: 80,  squareD: 0,  squareW: 0,  maxStreets: 2, targetWidthM: 42 },
  }[tier];

  // Town extends past the naturally-flat land (the pad flattens the rest), so even tight sites host a
  // proper number of houses. CAPITALS get a much larger artificial-flat apron: with the old shared
  // +46/+30 allowance a minimum-qualifying capital site clamped down to the same usable footprint as a
  // well-sited medium town — more buildings, no more ground, so the top tier never READ bigger.
  // Layout is ORGANIC: a few WANDERING streets, with houses placed along both sides at jittered
  // spacing/setback and rotated to face the local street direction (+ a little skew).
  const EXT = tier === 'capital' ? { depth: 90, width: 65 } : { depth: 46, width: 30 };
  const WATERFRONT = 20;                              // band reserved near the pier (clear of the shore/water cell)
  const usableDepth = Math.max(20, Math.min(SPEC.depthM, site.inlandFlatM + EXT.depth) - WATERFRONT - SPEC.squareD - 8);
  const usableWidth = Math.min(SPEC.targetWidthM, site.flatWidthM + EXT.width);

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
    // (fixed) the rotation used to be passed as the SIDEWAYS offset `s` — heading degrees read as
    // metres, flinging small-town townhalls up to ~360 m off-axis and dragging a huge flat pad
    // (terrain scar) with them. s is a small jitter; the heading goes in the rotation slot.
    place(wish.townhall, resF1 + 6 + fp[wish.townhall].d / 2, (rng() - 0.5) * 10,
          (rng() - 0.5) * 18 + town.heading);
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

  const walls = deriveWalls(pad, tier);
  const forts = deriveForts(pad, tier);
  return { tier, buildings, square, streets, pad, walls, forts };
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
  const rng = mulberry32((seed ?? 1) ^ 0x70c4b0a7);            // distinct stream from terrain/reefs

  // Bare towns first — faction (which depends on POSITION) is assigned before the name, so each town can draw
  // its identity from its owning nation's pool.
  const towns = [];
  for (let k = 0; k < sites.length; k++) {
    const s = sites[k];
    towns.push({ id: `town_${k}`, x: s.x, z: s.z, heading: s.heading, _site: s });
  }
  assignFactions(towns, seed);       // spatial spheres of interest (+ contested borders)
  assignFactionNames(towns, seed);   // name + description from each town's faction pool

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
    t.walls = layout.walls;
    t.forts = layout.forts;
    delete t._site;
  }

  assignSpecialties(towns, seed);
  return towns;
}

// Specialty pools per tier (capitals are trade hubs → mostly ports). Keep keys in sync with
// server/trade-goods.js SPECIALTIES.
const SPEC_POOLS = {
  capital: ['port', 'port', 'port', 'forge', 'distillery', 'plantation'],
  medium:  ['plantation', 'plantation', 'distillery', 'forge', 'logging', 'fishing'],
  small:   ['farmstead', 'fishing', 'logging', 'plantation'],
};
const ALL_SPECS = ['plantation', 'distillery', 'forge', 'logging', 'fishing', 'farmstead', 'port'];

/**
 * Assign each town an economic `specialty` (Town Economy). Uses a DEDICATED rng stream so it never perturbs
 * the geometry streams in assignTowns (the global `rng` / per-town `lr`) — geometry stays byte-identical and
 * only the `specialty` field is added. Then a guarantee pass ensures every specialty appears ≥1 town (so every
 * consumed good has a producer somewhere). Deterministic given (towns order + tiers + seed). Exported so a
 * one-off manifest patch can apply the SAME assignment without a full terrain re-bake.
 */
export function assignSpecialties(towns, seed) {
  for (let i = 0; i < towns.length; i++) {
    const sr = mulberry32((((seed ?? 1) ^ ((0x85ebca6b * (i + 1)) >>> 0) ^ 0x53504543) >>> 0));
    const pool = SPEC_POOLS[towns[i].tier] || SPEC_POOLS.medium;
    towns[i].specialty = pool[Math.floor(sr() * pool.length)];
  }
  // Fill any missing specialty onto the least-disruptive towns first (small, then medium; never a capital).
  const tierRank = { small: 0, medium: 1, capital: 2 };
  const present = new Set(towns.map((t) => t.specialty));
  const missing = ALL_SPECS.filter((s) => !present.has(s));
  if (missing.length) {
    const fillOrder = towns
      .map((t, i) => ({ i, rank: tierRank[t.tier] ?? 1 }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    let fi = 0;
    for (const spec of missing) {
      while (fi < fillOrder.length && towns[fillOrder[fi].i].tier === 'capital') fi++;
      if (fi >= fillOrder.length) break;
      towns[fillOrder[fi].i].specialty = spec;
      fi++;
    }
  }
  return towns;
}

// ── factions (spheres of interest) ──────────────────────────────────────────────
const CONTESTED_RATIO = 1.30;   // a town whose 2nd-nearest nation is within 30% of its nearest sits on a border
const CONTESTED_PROB  = 0.5;    // ...and a seeded coin-flip decides it's actually contested (flagged for events)

/** FNV-1a string hash → a stable per-faction RNG seed offset. */
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; } return h >>> 0; }
/** Small roman numeral for cycled name suffixes (only used if a nation ever has more towns than pool names). */
function roman(n) { return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][n] || String(n); }

const LLOYD_ITERS = 8;   // k-means relaxation passes — pull anchors to the centre of their territory for balance

/**
 * Assign each town a `faction` (and flag `contested` border towns) via SPHERES OF INTEREST: farthest-point
 * sampling seeds one well-spread anchor per nation, then a few k-means (Lloyd) passes relax each anchor to the
 * CENTRE of its territory — so spheres follow town density and come out reasonably balanced + contiguous (not
 * one nation swallowing a whole island). Every town joins its nearest anchor; a guarantee pass ensures each
 * nation keeps ≥1 town. A town whose 2nd-nearest nation is within CONTESTED_RATIO may be flagged `contested`
 * + given a `rivalFaction` for the future events module (it still has a primary owner for colour/name/home).
 * DEDICATED rng stream → geometry + specialty assignment stay byte-identical.
 */
export function assignFactions(towns, seed) {
  const ids = factionIds();
  const K = Math.min(ids.length, towns.length);
  if (K === 0) return towns;
  const fr = mulberry32((((seed ?? 1) ^ 0x46414354) >>> 0));   // 'FACT'
  const d2 = (a, b) => { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; };

  // Farthest-point sampling → K spread seed anchors; anchor index a flies nation ids[a]'s flag throughout.
  const anchorIdx = [Math.floor(fr() * towns.length)];
  while (anchorIdx.length < K) {
    let bestI = -1, bestD = -1;
    for (let i = 0; i < towns.length; i++) {
      if (anchorIdx.includes(i)) continue;
      let nearest = Infinity;
      for (const ai of anchorIdx) nearest = Math.min(nearest, d2(towns[i], towns[ai]));
      if (nearest > bestD) { bestD = nearest; bestI = i; }
    }
    if (bestI < 0) break;
    anchorIdx.push(bestI);
  }
  let cen = anchorIdx.map((i) => ({ x: towns[i].x, z: towns[i].z }));

  // Lloyd relaxation: reassign to nearest centroid, then recompute centroids. Settles spheres onto density.
  const nearestC = (t) => { let bi = 0, bd = Infinity; for (let a = 0; a < K; a++) { const d = d2(t, cen[a]); if (d < bd) { bd = d; bi = a; } } return bi; };
  for (let iter = 0; iter < LLOYD_ITERS; iter++) {
    const sx = new Array(K).fill(0), sz = new Array(K).fill(0), cnt = new Array(K).fill(0);
    for (const t of towns) { const a = nearestC(t); sx[a] += t.x; sz[a] += t.z; cnt[a]++; }
    let moved = false;
    for (let a = 0; a < K; a++) {
      if (!cnt[a]) continue;                 // keep an emptied anchor where it is (guarantee pass fixes ≥1)
      const nx = sx[a] / cnt[a], nz = sz[a] / cnt[a];
      if (nx !== cen[a].x || nz !== cen[a].z) moved = true;
      cen[a] = { x: nx, z: nz };
    }
    if (!moved) break;
  }
  const anchors = cen.map((p, a) => ({ x: p.x, z: p.z, faction: ids[a] }));

  // Final assignment: nearest anchor = owner; 2nd-nearest within CONTESTED_RATIO + a coin-flip = contested.
  for (const t of towns) {
    let n1 = Infinity, n2 = Infinity, a1 = 0, a2 = -1;
    for (let a = 0; a < K; a++) {
      const d = d2(t, anchors[a]);
      if (d < n1) { n2 = n1; a2 = a1; n1 = d; a1 = a; }
      else if (d < n2) { n2 = d; a2 = a; }
    }
    t.faction = anchors[a1].faction;
    t._fa = a1;   // scratch: anchor index, used by the guarantee pass
    delete t.contested; delete t.rivalFaction;
    const ratio = n1 > 0 ? Math.sqrt(n2 / n1) : Infinity;   // sqrt → a true linear distance ratio
    if (a2 >= 0 && ratio < CONTESTED_RATIO && fr() < CONTESTED_PROB) { t.contested = true; t.rivalFaction = anchors[a2].faction; }
  }

  // Guarantee ≥1 town per nation: hand each empty nation the town closest to its anchor, taken from the
  // currently-largest nation (never stranding that donor at zero).
  const counts = () => { const c = new Array(K).fill(0); for (const t of towns) c[t._fa]++; return c; };
  for (let a = 0; a < K; a++) {
    let c = counts();
    if (c[a] > 0) continue;
    let donor = -1; for (let b = 0; b < K; b++) if (c[b] > 1 && (donor < 0 || c[b] > c[donor])) donor = b;
    if (donor < 0) continue;
    let pick = null, pd = Infinity;
    for (const t of towns) { if (t._fa !== donor) continue; const d = d2(t, anchors[a]); if (d < pd) { pd = d; pick = t; } }
    if (pick) { pick._fa = a; pick.faction = anchors[a].faction; delete pick.contested; delete pick.rivalFaction; }
  }
  for (const t of towns) delete t._fa;
  return towns;
}

/**
 * Give each town a `name` + `description` drawn from its OWNING nation's pool (town-names.json factions.<id>),
 * so identities fit the flag (Port Royal=English, Petit-Goâve=French, …). Per-faction seeded shuffle; cycles
 * with a roman-numeral suffix if a nation ever holds more towns than its pool. Call AFTER assignFactions.
 */
export function assignFactionNames(towns, seed) {
  const pools = JSON.parse(readFileSync(join(__dirname, 'town-names.json'), 'utf8')).factions || {};
  for (const fid of factionIds()) {
    const pool = pools[fid] || [];
    const shuffled = pool.length ? seededShuffle(pool, mulberry32((((seed ?? 1) ^ hashStr(fid)) >>> 0))) : [];
    const mine = towns.filter((t) => t.faction === fid);
    for (let k = 0; k < mine.length; k++) {
      const base = shuffled.length ? shuffled[k % shuffled.length] : { name: `Harbour ${k + 1}`, description: 'A nameless anchorage.' };
      const cycle = Math.floor(k / Math.max(1, shuffled.length));
      mine[k].name = cycle === 0 ? base.name : `${base.name} ${roman(cycle + 1)}`;
      mine[k].description = base.description;
    }
  }
  for (const t of towns) if (!t.name) { t.name = 'Free Harbour'; t.description = 'An unaligned anchorage.'; }
  return towns;
}
