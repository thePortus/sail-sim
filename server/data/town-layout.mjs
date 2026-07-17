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

/**
 * Faction → street-network pattern (historically grounded — see the Laws of the Indies, and the
 * planned-grid vs medieval-serpentine split among real 17th-c Caribbean ports):
 *   spanish → 'plaza'    Plaza Mayor at the town's heart, rectilinear grid ringing it (Laws of the Indies)
 *   french  → 'bastide'  tighter market-square grid, plaza nearer the waterfront
 *   dutch   → 'rows'     long blocks PARALLEL to the waterfront + short cross alleys (Willemstad)
 *   english → 'grid'     planned High-Street port (Port Royal)  …or…
 *             'organic'  medieval serpentine lanes (Bridgetown) — 50/50 per town
 * Small towns are always 'organic' hamlets (a shore lane + a winding high street), whoever owns them.
 */
const PATTERN_BLOCKS = {           // block pitch (m): depth = inland (f) pitch, width = across (s) pitch
  plaza:   { bd: 30, bw: 32 },
  bastide: { bd: 24, bw: 26 },
  grid:    { bd: 28, bw: 30 },
  rows:    { bd: 24, bw: 0  },     // rows: no fixed s-pitch — staggered alleys instead
};

/**
 * ROADS-FIRST town layout (v3). The street NETWORK is generated first — an arterial skeleton
 * (waterfront quay road + a main/high street from the pier) filled in by the faction's pattern —
 * then building LOTS are derived from the street frontage and the roster is placed onto lots,
 * always facing their street (Parish–Müller pipeline shape: roads → blocks/lots → buildings).
 * The number of roads emerges from block-pitch targets over the buildable envelope, so a wide
 * capital genuinely needs (and gets) more streets than a hamlet. Output format is unchanged:
 * streets as straight segments, buildings, optional square, pad rect (walls/forts derive from it).
 */
export function layoutTown(town, site, tier, elevAt, fp, rng, wish) {
  const hr = town.heading * Math.PI / 180;
  const fwd = [-Math.sin(hr), -Math.cos(hr)];         // inland (landward)
  const rgt = [ Math.cos(hr), -Math.sin(hr)];         // right (perpendicular)
  const L = (f, s) => ({ x: +(town.x + fwd[0] * f + rgt[0] * s).toFixed(1),
                         z: +(town.z + fwd[1] * f + rgt[1] * s).toFixed(1) });

  const STREET_W = 5;
  const SPEC = {
    capital: { depthM: 170, squareD: 24, squareW: 28, targetWidthM: 130 },
    medium:  { depthM: 95,  squareD: 14, squareW: 16, targetWidthM: 58 },
    small:   { depthM: 80,  squareD: 0,  squareW: 0,  targetWidthM: 42 },
  }[tier];
  // Artificial-flat apron past the naturally-flat land (the pad levels the rest). Capitals get a
  // much larger one so the top tier actually reads bigger than a well-sited medium town.
  const EXT = tier === 'capital' ? { depth: 90, width: 65 } : { depth: 46, width: 30 };
  const WATERFRONT = 20;                              // band reserved near the pier root
  const usableDepth = Math.max(20, Math.min(SPEC.depthM, site.inlandFlatM + EXT.depth) - WATERFRONT - SPEC.squareD - 8);
  const usableWidth = Math.min(SPEC.targetWidthM, site.flatWidthM + EXT.width);

  // Buildable envelope in the town frame: quay line F0 → inland limit F1, |s| ≤ HW across.
  const F0 = WATERFRONT - 4;
  const F1 = F0 + usableDepth + SPEC.squareD + 10;
  const HW = usableWidth / 2;

  const pattern = tier === 'small' ? 'organic'
    : town.faction === 'spanish' ? 'plaza'
    : town.faction === 'french'  ? 'bastide'
    : town.faction === 'dutch'   ? 'rows'
    : (rng() < 0.5 ? 'grid' : 'organic');

  // ── STAGE 1+2: the street network — polylines of {f,s} nodes ────────────────────────────────
  const polylines = [];
  const allSegs = [];                                 // segment soup (spacing / lot rejection)
  const pushPoly = (nodes) => {
    const clean = nodes.filter((n) => Number.isFinite(n.f) && Number.isFinite(n.s));
    if (clean.length < 2) return;
    polylines.push(clean);
    for (let i = 1; i < clean.length; i++) allSegs.push([clean[i - 1], clean[i]]);
  };
  const distToStreets = (f, s) => {
    let best = Infinity;
    for (const [a, b] of allSegs) {
      const df = b.f - a.f, ds = b.s - a.s;
      const len2 = df * df + ds * ds;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((f - a.f) * df + (s - a.s) * ds) / len2)) : 0;
      const d = Math.hypot(f - (a.f + df * t), s - (a.s + ds * t));
      if (d < best) best = d;
    }
    return best;
  };

  // Plaza (Plaza Mayor / market square): a reserved rectangle the grid RINGS, never crosses.
  const hasPlaza = !!(wish.townhall && SPEC.squareD > 0 && (pattern === 'plaza' || pattern === 'bastide'));
  const plazaF = pattern === 'bastide' ? F0 + (F1 - F0) * 0.38 : F0 + (F1 - F0) * 0.52;
  const plazaHD = SPEC.squareD / 2, plazaHS = SPEC.squareW / 2;
  const inPlaza = (f, s, m = 0) =>
    hasPlaza && Math.abs(f - plazaF) < plazaHD + m && Math.abs(s) < plazaHS + m;

  // A gently-jittered street: ~7 m nodes with low-frequency lateral noise pinned at the ends (so
  // grids read hand-surveyed, not CAD-drawn), split where it would cross the plaza (ring it).
  const jitterLine = (fa, sa, fb, sb, amp) => {
    const len = Math.hypot(fb - fa, sb - sa);
    if (len < 4) return;
    const n = Math.max(2, Math.ceil(len / 7));
    const ph = rng() * Math.PI * 2, fr = (0.5 + rng()) * Math.PI;
    const nf = -(sb - sa) / len, ns = (fb - fa) / len;   // unit normal
    let run = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const w = Math.sin(ph + fr * t) * amp * Math.sin(Math.PI * t);
      const f = fa + (fb - fa) * t + nf * w, s = sa + (sb - sa) * t + ns * w;
      if (inPlaza(f, s, 1)) { pushPoly(run); run = []; continue; }
      run.push({ f, s });
    }
    pushPoly(run);
  };
  // Merge near-coincident grid lines, preferring plaza-edge lines (streets leave the plaza corners).
  const dedupeLines = (arr, minGap) => {
    arr.sort((a, b) => a.v - b.v);
    const keep = [];
    for (const it of arr) {
      const near = keep.findIndex((k) => Math.abs(k.v - it.v) < minGap);
      if (near < 0) keep.push(it);
      else if (it.edge && !keep[near].edge) keep[near] = it;
    }
    return keep;
  };

  if (pattern === 'plaza' || pattern === 'bastide' || pattern === 'grid') {
    const { bd, bw } = PATTERN_BLOCKS[pattern];
    // Cross streets (parallel to the waterfront): the quay road at F0, then every ~blockDepth.
    const fSet = [];
    for (let f = F0; f <= F1; f += bd + (rng() - 0.5) * 4) fSet.push({ v: f, edge: false });
    if (hasPlaza) fSet.push({ v: plazaF - plazaHD, edge: true }, { v: plazaF + plazaHD, edge: true });
    // Longitudinal streets: the main street on axis, then every ~blockWidth outward.
    const sSet = [{ v: (rng() - 0.5) * 3, edge: false }];
    for (let s = bw; s <= HW; s += bw + (rng() - 0.5) * 4) {
      sSet.push({ v: s + (rng() - 0.5) * 3, edge: false });
      sSet.push({ v: -s + (rng() - 0.5) * 3, edge: false });
    }
    if (hasPlaza) sSet.push({ v: plazaHS, edge: true }, { v: -plazaHS, edge: true });
    for (const k of dedupeLines(fSet, 9)) jitterLine(k.v, -HW, k.v, HW, 0.7 + rng() * 1.2);
    for (const k of dedupeLines(sSet, 10)) jitterLine(F0, k.v, F1, k.v, 0.7 + rng() * 1.2);
    jitterLine(3, 0, F0, 0, 0.4);                     // pier spur onto the quay road
  } else if (pattern === 'rows') {
    // Long rows parallel to the shore (the quay road is row 0), a main street from the pier, and
    // short STAGGERED alleys tying adjacent rows together.
    const { bd } = PATTERN_BLOCKS.rows;
    const rows = [];
    for (let f = F0; f <= F1; f += bd + (rng() - 0.5) * 3) rows.push(f);
    for (const f of rows) jitterLine(f, -HW, f, HW, 1.0 + rng() * 1.5);
    jitterLine(3, (rng() - 0.5) * 3, F1, (rng() - 0.5) * 6, 1.2);   // main street, pier → inland
    for (let i = 1; i < rows.length; i++) {
      const nAlley = Math.max(1, Math.floor(HW / 26));
      for (let k = 0; k < nAlley; k++) {
        const s = (rng() - 0.5) * 2 * (HW - 6);
        if (Math.abs(s) < 9) continue;                // the main street already connects here
        jitterLine(rows[i - 1], s, rows[i], s, 0.4);
      }
    }
  } else if (tier === 'small') {
    // ORGANIC HAMLET: shore lane + a winding high street with a couple of GUARANTEED side lanes
    // (grown with curvature drift, snapping into other lanes on approach — junctions, not crossings).
    jitterLine(F0, -HW, F0, HW, 1.6 + rng() * 1.6);
    const grow = (f0, s0, ang0, budget) => {
      const nodes = [{ f: f0, s: s0 }];
      let f = f0, s = s0, ang = ang0;
      const bias = (rng() - 0.5) * 0.14;              // persistent curvature → serpentine
      for (let i = 0; i < 40; i++) {
        const step = 7 + rng() * 3;
        ang += bias + (rng() - 0.5) * 0.22;
        const nf2 = f + Math.cos(ang) * step, ns2 = s + Math.sin(ang) * step;
        // Floor at the PIER (f≈1), not the quay line — the high street launches from f=3 and must
        // cross the quay road; flooring at F0 killed it on its very first step.
        if (nf2 < 1 || nf2 > F1 || Math.abs(ns2) > HW) break;
        // Snap into another lane on approach (a junction) — but only once clear of the START, else
        // the high street dies the moment it CROSSES the quay road it launches from.
        if (Math.hypot(nf2 - f0, ns2 - s0) > 22 && distToStreets(nf2, ns2) < 9) {
          nodes.push({ f: nf2, s: ns2 }); break;
        }
        nodes.push({ f: nf2, s: ns2 });
        f = nf2; s = ns2;
        if (Math.hypot(f - f0, s - s0) > budget) break;
      }
      pushPoly(nodes);
    };
    grow(3, 0, (rng() - 0.5) * 0.2, F1 - F0 + 24);    // the high street
    const hs = polylines[polylines.length - 1];       // (last pushed = the high street's inland run)
    const nb = 2 + (rng() < 0.5 ? 1 : 0);
    for (let k = 0; k < nb && hs && hs.length > 3; k++) {
      const i = Math.max(1, Math.min(hs.length - 2,
        Math.floor((k + 0.5 + (rng() - 0.5) * 0.4) / nb * (hs.length - 2)) + 1));
      const a = hs[i - 1], b = hs[i + 1], p = hs[i];
      const along = Math.atan2(b.s - a.s, b.f - a.f);
      const side = k % 2 === 0 ? 1 : -1;
      grow(p.f, p.s, along + side * (Math.PI / 2 + (rng() - 0.5) * 0.4), 16 + rng() * 26);
    }
  } else {
    // ORGANIC (medieval serpentine, Bridgetown-style) for medium/capital: a grid WARPED hard and
    // randomly THINNED — pure tip-growth degenerated on big envelopes (streets pooled at the shore
    // and never reached inland), while a heavily deformed, dropout'd grid keeps full coverage and
    // reads properly medieval at this scale: no two lanes parallel, kinked junctions, missing links.
    const bd = 26, bw = 28;
    const fSet = [], sSet = [{ v: (rng() - 0.5) * 4, edge: true }];   // keep the high street
    for (let f = F0; f <= F1; f += bd + (rng() - 0.5) * 8) fSet.push({ v: f, edge: f === F0 });
    for (let s = bw; s <= HW; s += bw + (rng() - 0.5) * 8) {
      sSet.push({ v: s + (rng() - 0.5) * 5, edge: false });
      sSet.push({ v: -s + (rng() - 0.5) * 5, edge: false });
    }
    dedupeLines(fSet, 10).forEach((k, i) => {
      if (i === 0 || rng() > 0.22)                     // dropout — but always keep the quay road
        jitterLine(k.v, -HW + rng() * 14, k.v, HW - rng() * 14, 3.5 + rng() * 4);
    });
    for (const k of dedupeLines(sSet, 11)) {
      if (k.edge || rng() > 0.22)
        jitterLine(F0, k.v, F1 - rng() * 18, k.v, 3.5 + rng() * 4);
    }
    jitterLine(3, 0, F0, 0, 0.5);                     // pier spur
  }

  // ── Buildings scaffolding (same primitives as before) ───────────────────────────────────────
  const buildings = [];
  const placed = [];                                  // {x,z,r} greedy overlap rejection
  let minF = Infinity, maxF = -Infinity, minS = Infinity, maxS = -Infinity;
  const localHeading = (df, ds) => dirHeading(fwd[0] * df + rgt[0] * ds, fwd[1] * df + rgt[1] * ds);
  const place = (asset, f, s, rotDeg, inPad = true) => {
    const p = L(f, s);
    buildings.push({ asset, x: p.x, z: p.z, rotY: Math.round(rotDeg) });
    placed.push({ x: p.x, z: p.z, r: Math.hypot(fp[asset].w, fp[asset].d) / 2 + 0.6 });
    if (!inPad) return;                               // stilt-shacks live at the waterline
    const rr = Math.max(fp[asset].w, fp[asset].d) / 2 + 1;
    minF = Math.min(minF, f - rr); maxF = Math.max(maxF, f + rr);
    minS = Math.min(minS, s - rr); maxS = Math.max(maxS, s + rr);
  };
  const overlaps = (x, z, r) => placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r);

  // Waterfront: shipwright near the pier (on the quay).
  const swSide = rng() < 0.5 ? -1 : 1;
  place('shipwright_shack', 16, swSide * 14, town.heading + (rng() - 0.5) * 30);

  // Stilt-shacks over the harbour water, off to the side of the pier (unchanged; outside the pad).
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

  // ── Civic anchors ───────────────────────────────────────────────────────────────────────────
  let square = null;
  if (hasPlaza) {
    const c = L(plazaF, 0);
    square = { cx: c.x, cz: c.z, halfX: +plazaHS.toFixed(1), halfZ: +plazaHD.toFixed(1), rotY: Math.round(town.heading) };
    minF = Math.min(minF, plazaF - plazaHD - 2); maxF = Math.max(maxF, plazaF + plazaHD + 2);
    minS = Math.min(minS, -plazaHS - 2);         maxS = Math.max(maxS, plazaHS + 2);
    if (wish.fountain) place(wish.fountain, plazaF, 0, town.heading);
    // The hall presides from the plaza's INLAND edge, facing the water across the square.
    place(wish.townhall, plazaF + plazaHD + fp[wish.townhall].d / 2 + 1.5, (rng() - 0.5) * 4, town.heading);
  } else if (wish.townhall) {
    // Grid/rows/organic: the hall closes the inland end of the most-inland CENTRAL street — always
    // connected to the network (a fixed-depth spot could float far from any road on thin layouts).
    let bf = -1e9, bs = (rng() - 0.5) * 6;
    for (const poly of polylines) for (const n of poly)
      if (Math.abs(n.s) < 14 && n.f > bf) { bf = n.f; bs = n.s; }
    if (bf < F0) { bf = F1 - 10; bs = 0; }
    place(wish.townhall, bf + fp[wish.townhall].d / 2 + 3, bs, (rng() - 0.5) * 18 + town.heading);
  }

  // ── STAGE 3: frontage LOTS along every street (both sides), plaza ring first ────────────────
  const cands = [];
  for (const poly of polylines) {
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const segLen = Math.hypot(b.f - a.f, b.s - a.s);
      if (segLen < 2) continue;
      const tf = (b.f - a.f) / segLen, ts = (b.s - a.s) / segLen;
      // ~1 lot / 8 m of frontage per side (7 m in hamlets — their short lanes must host the roster).
      const steps = Math.max(1, Math.floor(segLen / (tier === 'small' ? 7 : 8)));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.35 + rng() * 0.3) / steps;
        const f = a.f + (b.f - a.f) * t, s = a.s + (b.s - a.s) * t;
        for (const side of [-1, 1]) {
          const setback = STREET_W / 2 + 3.9 + rng() * 1.7;
          const lf = f + -ts * side * setback + (rng() - 0.5) * 1.2;
          const ls = s + tf * side * setback + (rng() - 0.5) * 1.2;
          if (lf < F0 - 2 || lf > F1 + 6 || Math.abs(ls) > HW + 6) continue;
          if (inPlaza(lf, ls, 1)) continue;                       // never build ON the plaza
          if (distToStreets(lf, ls) < STREET_W / 2 + 1.6) continue;   // …or in a road
          const rot = localHeading(ts * side, -tf * side) + (rng() - 0.5) * 12;   // face the street
          // Plaza-ring lots first (they frame the square), then fill outward from the pier so the
          // town is densest at the waterfront and thins inland.
          const prio = inPlaza(lf, ls, 7) ? 0 : 1;
          cands.push({ f: lf, s: ls, rot, score: prio * 1e6 + Math.hypot(lf - 3, ls) + rng() * 8 });
        }
      }
    }
  }
  cands.sort((a, b) => a.score - b.score);

  // ── STAGE 4: the roster fills the lots (taverns first — wishlist order is priority) ─────────
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

  // ── Output: streets as world segments; pad covers buildings AND the road network ────────────
  const streets = [];
  for (const poly of polylines)
    for (let i = 1; i < poly.length; i++) {
      const A = L(poly[i - 1].f, poly[i - 1].s), B = L(poly[i].f, poly[i].s);
      streets.push({ x1: A.x, z1: A.z, x2: B.x, z2: B.z, width: STREET_W });
    }
  for (const poly of polylines) for (const n of poly) {
    minF = Math.min(minF, n.f - 3); maxF = Math.max(maxF, n.f + 3);
    minS = Math.min(minS, n.s - 3); maxS = Math.max(maxS, n.s + 3);
  }

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
  return { tier, buildings, square, streets, pad, walls, forts, pattern };
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
    t.pattern = layout.pattern;   // street-network style (plaza/bastide/grid/rows/organic) — informational
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
