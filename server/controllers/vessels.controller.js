'use strict';

// Coordinate system: +Z = bow/forward, -Z = stern, +X = starboard, -X = port, +Y = up
// Hull runs from z ≈ -6.5 (stern) to z ≈ 7.2 (bow tip).
// Mast at z=1.5, masthead at y≈15.6.
// Deck surface at y ≈ 1.22.
//
// materialType keys — consumed by the client PBR material factory:
//   wood_hull   dark mahogany hull planking
//   wood_teak   golden teak deck
//   wood_spar   varnished spruce/aluminum spar
//   brass       polished brass/bronze fittings
//   steel       stainless steel hardware and rigging
//   black_metal cast-iron keel and rudder
//   paint_white gloss white marine paint
//   paint_cream off-white/cream GRP cabin
//   paint_navy  dark navy painted surfaces
//   rubber      black rubber seals
//   glass       tinted glass (binnacle dome)
//   rope        natural fibre cordage
//   nav_red     emissive port light
//   nav_green   emissive starboard light
//   nav_white   emissive white masthead / stern light

const PI_2 = 1.5708; // Math.PI / 2

// Build a broadside of `n` guns a side, evenly spread fore-aft in [+zMax..-zMax], at beam ±x and world muzzle
// height y (game frame: +Z bow, +X starboard). The array LENGTH is the broadside size the combat gate uses.
function gunLine(n, x, y, zMax) {
  const port = [], stbd = [];
  for (let i = 0; i < n; i++) {
    const z = +(zMax - (n > 1 ? i * (2 * zMax / (n - 1)) : 0)).toFixed(1);
    port.push({ x: -x, y, z }); stbd.push({ x, y, z });
  }
  return { port, stbd };
}
// Two-battery layout from the actual model gun positions: `guns` = gun-deck long guns (full range),
// `carr` = spar-deck CARRONADES (tagged carronade:true → short range + heavy; the client auto-holds them
// beyond reach). Each is a stbd-side [x,y,z] list; port mirrors x. Muzzle flashes line up with the ports.
function battery(guns, carr) {
  const mk = (arr, c) => arr.map(([x, y, z]) => (c ? { x, y, z, carronade: true } : { x, y, z }));
  const stbd = [...mk(guns, false), ...mk(carr, true)];
  return { stbd, port: stbd.map(m => ({ ...m, x: -m.x })) };
}
const FRIG_LONG = [[5.09,4.01,16.55],[5.65,3.80,14.13],[6.03,3.62,11.60],[6.36,3.47,9.10],[6.60,3.35,6.60],[6.77,3.26,4.08],[6.85,3.18,1.58],[6.85,3.17,-0.92],[6.84,3.24,-3.42],[6.78,3.32,-5.93],[6.63,3.42,-8.43],[6.50,3.50,-10.93],[6.30,3.56,-13.44],[6.03,3.61,-15.96],[5.85,3.70,-18.60]];
const FRIG_CARR = [[5.18,5.90,13.98],[5.59,5.64,10.61],[5.89,5.45,7.19],[6.04,5.31,3.80],[6.06,5.21,0.40],[6.07,5.28,-3.00],[6.04,5.41,-6.40],[5.95,5.53,-9.79],[5.80,5.64,-13.19],[5.60,5.74,-16.45],[5.36,5.85,-19.98]];

// Per-vessel config consumed by the client:
//   glb/manifest  — rigged asset + animation manifest under /geometry/
//   importFlipY   — rotate the model 180° about Y on import so its bow faces game-forward (+Z)
//   rightSign     — world starboard direction in vessel-local X (+1 = starboard is +X, −1 = −X). The
//                   pinnace hull is the opposite handedness of the sloop; sign-sensitive code (rudder,
//                   trim, heel/list roll) multiplies by this.
//   cannons       — muzzle positions per side, vessel-local (+Z bow, +Y up). Length = guns per side.
//   zoneHp        — per-zone hit points (the pinnace is weaker / easier to sink).
//   firstPersonCam — on-deck camera eye, vessel-local.
// The FIRST entry is the selector's default (the pinnace is the starter vessel).
const VESSELS = [
  {
    id: 2,
    name: 'Pinnace',
    slug: 'pinnace',
    description: 'A small, lively ship\'s boat — quick to handle and forgiving, but lightly built. One gun a side. The recommended starter.',
    glb:      'pinnace.glb',
    manifest: 'pinnace.manifest.json',
    importFlipY: false,           // pinnace already exports bow = +Z
    rightSign:   -1,              // starboard is −X on this hull (opposite the sloop)
    physics: {
      maxSpeed:         8.0,
      accelerationRate: 0.30,     // lighter → accelerates quicker
      minTackAngle:     34,       // a lug rig points slightly lower than the sloop
      sailAreaFactor:   0.34,
      weight:           1400,     // half the sloop — nimble
      // v2 sailing rig (server-authoritative handling; both clients read this) — a handy sprit/lug: lower peak
      // drive but holds it dead downwind, and forgiving of sloppy trim.
      forceK:           0.26,
      trimForgive:      1.25,
      leewayK:          1.4,
      polar: [[34, 0.42], [55, 0.62], [80, 0.82], [100, 0.92], [125, 0.97], [150, 0.90], [180, 0.80]],
      hullHalfLen:      4.1,
      hullHalfBeam:     1.1,
      GM:               0.55,      // metacentric height (m) — roll STIFFNESS: low beam but stiff for a small boat → quick lively roll
      buoyancy: { pitchScale: 0.16, heaveTau: 0.45, tiltTau: 0.30 },
    },
    // Helm: near the front of the tiller, just to starboard (starboard = −X here), seated eye height.
    firstPersonCam: { x: -0.45, y: 1.45, z: -2.4 },
    // One carriage gun per side, amidships. Standard sides: port = −X (left), starboard = +X (right),
    // so each gun fires out its own rail (matches the run-out animation and the cannon-fire direction).
    cannons: {
      port: [{ x: -0.95, y: 0.85, z:  0.15 }],
      stbd: [{ x:  0.95, y: 0.85, z: -0.15 }],
    },
    zoneHp: { bow: 55, stern: 55, port: 80, starboard: 80, masts: 60 },
    crew: 4,                      // Crew resource: full complement (grapeshot attrites it; tavern re-hires)
    cargo: 20,                    // hold capacity in cargo slots (Town Economy) — small, nimble
    price: 0,                     // Ships-as-economy: the free starter hull
    parts: [],
  },
  {
    id: 1,
    name: 'Sloop',
    slug: 'sloop',
    description: 'A nimble single-masted sailing vessel. Responsive to the wind and lively on the water. Six guns and a stout hull.',
    glb:      'bermuda_sloop_rigged.glb',
    manifest: 'bermuda_sloop_rigged.manifest.json',
    importFlipY: true,
    rightSign:   1,
    physics: {
      maxSpeed:         9.0,
      accelerationRate: 0.22,
      minTackAngle:     32,
      sailAreaFactor:   0.40,
      weight:           2800,
      // Bermuda rig: points high, strong on a reach (peak ~120°), but the main blankets the jib dead
      // downwind so the run falls off. A tuned rig → fussier trim. tiltTau -1 = client default smoothing.
      forceK:           0.26,
      trimForgive:      1.0,
      leewayK:          1.0,
      polar: [[32, 0.46], [45, 0.64], [60, 0.80], [90, 0.93], [120, 1.00], [150, 0.82], [180, 0.66]],
      hullHalfLen:      7.0,
      hullHalfBeam:     2.2,
      GM:               0.90,      // stiff, lively — a well-ballasted racer; snappier roll than a laden trader
      buoyancy: { pitchScale: 0.14, heaveTau: 1.5, tiltTau: -1 },
    },
    // Helm — just aft of the wheel, on the centreline, standing eye height, looking forward.
    firstPersonCam: { x: 0.6, y: 2.6, z: -2.8 },
    zoneHp: { bow: 90, stern: 90, port: 130, starboard: 130, masts: 100 },
    crew: 7,                      // Crew resource: full complement (grapeshot attrites it; tavern re-hires)
    cargo: 40,                    // hold capacity in cargo slots (Town Economy) — stout merchantman
    price: 10000,                 // Ships-as-economy: bought at a port shipwright
    parts: [],
  },
  {
    id: 4,
    name: 'Merchantman',
    slug: 'merchantman',
    description: 'A three-masted hagboat — fore and main square-rigged, a gaff spanker aft. A huge hold and the toughest hull afloat, but only six guns and slow to gather way: the trader\'s ship, built to haul cargo, not to fight.',
    glb:      'merchantman.glb',
    manifest: 'merchantman.manifest.json',
    importFlipY: false,           // merchantman exports bow = +X; the client rights it via baseYawDeg −90 (VESSEL_RIGS)
    rightSign:   1,               // after the −90 yaw, starboard is +X
    physics: {
      maxSpeed:         8.6,      // big sail plan but a heavy laden hull → lower top end than the brig
      accelerationRate: 0.12,     // very heavy → slowest to gather way
      minTackAngle:     52,       // square-rigged → points even lower than the brig
      sailAreaFactor:   0.50,     // a great spread of canvas
      weight:           6500,     // the deepest, heaviest hull in the fleet
      // Three-masted square-rigger: huge drive on a reach and HOLDS it dead downwind, slow to accelerate,
      // little leeway, forgiving of sloppy trim.
      forceK:           1.18,
      trimForgive:      1.15,
      leewayK:          0.85,
      polar: [[52, 0.38], [72, 0.60], [92, 0.80], [120, 1.00], [150, 0.96], [180, 0.88]],
      hullHalfLen:      15.0,
      hullHalfBeam:     3.6,
      GM:               0.70,      // tender laden trader — deep heavy hull → slow, ponderous, majestic roll
      buoyancy: { pitchScale: 0.06, heaveTau: 1.1, tiltTau: 0.65 },
    },
    // Helm — at the wheel on the high quarterdeck aft (B_Wheel ≈ model y 7.93), standing eye height, looking
    // forward. y is vessel-local (rides the floated hull). y RAISED 6.0→8.8 (= wheel 7.93 + ~0.9 eye): the old
    // 6.0 sat ~2 m BELOW the wheel, down inside the cabin beneath the quarterdeck. x offset to STARBOARD off the
    // centreline so the view clears the centreline spanker/gaff and the masts.
    firstPersonCam: { x: 1.4, y: 8.8, z: -9.0 },
    // THREE guns a side on the gun deck (game frame: +Z bow, +X starboard). Fore→aft positions taken from the
    // actual B_Lid gunport bones; muzzle y is the WORLD height = model gunport y(~6.3) + floatDraft(−3.8) ≈ 2.5.
    cannons: {
      port: [{ x: -3.4, y: 2.5, z: 4.1 }, { x: -3.4, y: 2.5, z: -2.4 }, { x: -3.4, y: 2.5, z: -5.9 }],
      stbd: [{ x:  3.4, y: 2.5, z: 4.1 }, { x:  3.4, y: 2.5, z: -2.4 }, { x:  3.4, y: 2.5, z: -5.9 }],
    },
    zoneHp: { bow: 150, stern: 150, port: 220, starboard: 220, masts: 160 },
    crew: 9,                      // Crew resource: a thinly-manned trader (not a warship's full complement)
    cargo: 120,                   // hold capacity — the whole point: the biggest hold in the fleet
    price: 90000,                 // Ships-as-economy: a major purchase below the brig warship, for haulers
    parts: [],
  },
  {
    id: 3,
    name: 'Brigantine',
    slug: 'brig',
    description: 'A big two-masted warship — square-rigged forward, gaff main aft. Eight guns, a deep stout hull, and a heavy spread of canvas: slow to gather way but powerful and steady. The most ship gold can buy.',
    glb:      'brig.glb',
    manifest: 'brig.manifest.json',
    importFlipY: false,           // brig exports bow = +Z
    rightSign:   1,               // starboard is +X on this hull
    physics: {
      maxSpeed:         9.5,      // big sail plan → strong top end on a reach
      accelerationRate: 0.16,     // heavy → slow to gather way
      minTackAngle:     50,       // square sails can't point close
      sailAreaFactor:   0.48,     // lots of canvas
      weight:           5200,     // deep, heavily-built hull
      // Square-rigged foremast + gaff main: points low, strong drive on a reach, HOLDS it dead downwind
      // (square sails love a run, peak ~120°); heavy deep hull → little leeway, fairly forgiving of trim.
      forceK:           1.12,
      trimForgive:      1.1,
      leewayK:          0.9,
      polar: [[50, 0.40], [70, 0.62], [90, 0.82], [120, 1.00], [150, 0.95], [180, 0.86]],
      hullHalfLen:      12.0,
      hullHalfBeam:     3.2,
      GM:               0.85,      // a steady warship — stiffer than the trader, but a deep hull → measured roll
      buoyancy: { pitchScale: 0.07, heaveTau: 1.0, tiltTau: 0.6 },
    },
    // Helm — at the wheel aft (B_Wheel ≈ model 0,5.74,-11.1), standing eye height, looking forward.
    // y is vessel-local (rides the floated hull); the quarterdeck sits high on this ship.
    // x offset to STARBOARD off the centreline so the helmsman sees forward AROUND the centreline boom/gaff
    // (dead-centre put the view straight into the main boom & gaff).
    firstPersonCam: { x: 1.2, y: 6.6, z: -9.5 },
    // Four guns a side, taken from the actual gunport (B_Lid) bone positions — and they are NOT on one deck:
    // a forecastle chase (z≈9), a main-deck waist gun (z≈1.5, sitting ~1 m lower), and two on the raised
    // quarterdeck (z≈-6.5, -9). y is the WORLD muzzle height = model gunport y + floatDraft(-2.3) - barrel.
    // Standard sides: port = −X, starboard = +X, so each gun fires out its own rail.
    // y lowered ~0.6 m from the lid-bone height so balls leave THROUGH the gunports, not over the rail.
    cannons: {
      port: [{ x: -2.7, y: 2.25, z: 9.0 }, { x: -3.5, y: 1.32, z: 1.5 }, { x: -3.4, y: 2.34, z: -6.5 }, { x: -3.1, y: 2.44, z: -9.0 }],
      stbd: [{ x:  2.7, y: 2.25, z: 9.0 }, { x:  3.5, y: 1.32, z: 1.5 }, { x:  3.4, y: 2.34, z: -6.5 }, { x:  3.1, y: 2.44, z: -9.0 }],
    },
    zoneHp: { bow: 140, stern: 140, port: 200, starboard: 200, masts: 150 },
    crew: 12,                     // Crew resource: a big ship needs hands at every station
    cargo: 60,                    // hold capacity in cargo slots — a roomy warship hold
    price: 200000,                // Ships-as-economy: the top-tier shipwright purchase
    parts: [],
  },
  // ── Frigate (USS Constitution type) — apex warship, three armament loadouts (shared hull/rig/asset) ──────────
  // FAST under a huge sail plan but the heaviest hull afloat: slow to gather way (weight→massK) + slow to turn
  // (physics.turnFactor). Bow=+Z. The `armament` field drives the client Frigate_Guns_<v> mesh toggle.
  {
    id: 5, name: 'Frigate (Heavy)', slug: 'frigate_heavy', armament: 'heavy',
    description: 'A 44-gun heavy frigate — a purpose-built man-of-war with a full battery of 24-pounders and spar-deck carronades. The toughest hull and deadliest broadside afloat, fast under her huge press of canvas, but the heaviest ship in the fleet: ponderous to turn and slow to gather way. The apex predator of the sea.',
    glb: 'frigate.glb', manifest: 'frigate.manifest.json', importFlipY: false, rightSign: 1,
    physics: { maxSpeed: 10.2, accelerationRate: 0.09, minTackAngle: 50, sailAreaFactor: 0.55, weight: 11000, turnFactor: 0.50, hullHalfLen: 24.0, hullHalfBeam: 5.5, GM: 1.00 },
    firstPersonCam: { x: 0.0, y: 9.0, z: -16.7 },   // helmsman abaft the wheel on the quarterdeck (vessel-local; Y re-snapped to deck)
    cannons: battery(FRIG_LONG, FRIG_CARR),   // 15 long guns + 11 carronades
    zoneHp: { bow: 250, stern: 250, port: 360, starboard: 360, masts: 250 },
    crew: 480, cargo: 40, price: 750000, parts: [],
  },
  {
    id: 6, name: 'Frigate (Medium)', slug: 'frigate_medium', armament: 'medium',
    description: 'A frigate on a medium battery — fewer, lighter guns than the heavy, trading some of that crushing broadside for a slightly livelier, cheaper ship. Still the toughest hull and among the fastest afloat, and still ponderous to handle.',
    glb: 'frigate.glb', manifest: 'frigate.manifest.json', importFlipY: false, rightSign: 1,
    physics: { maxSpeed: 10.5, accelerationRate: 0.10, minTackAngle: 50, sailAreaFactor: 0.55, weight: 10000, turnFactor: 0.55, hullHalfLen: 24.0, hullHalfBeam: 5.5, GM: 1.02 },
    firstPersonCam: { x: 0.0, y: 9.0, z: -16.7 },   // helmsman abaft the wheel on the quarterdeck (vessel-local; Y re-snapped to deck)
    cannons: battery(FRIG_LONG, FRIG_CARR.slice(1, 9)),   // 15 long guns + 8 carronades
    zoneHp: { bow: 230, stern: 230, port: 320, starboard: 320, masts: 230 },
    crew: 420, cargo: 50, price: 500000, parts: [],
  },
  {
    id: 7, name: 'Frigate (Light)', slug: 'frigate_light', armament: 'light',
    description: 'A frigate on a light battery — the least-armed loadout, the fastest and handiest of the three, and the cheapest way onto a frigate\'s deck. A stout, fast hull for a captain who values speed over a full broadside.',
    glb: 'frigate.glb', manifest: 'frigate.manifest.json', importFlipY: false, rightSign: 1,
    physics: { maxSpeed: 10.8, accelerationRate: 0.11, minTackAngle: 50, sailAreaFactor: 0.55, weight: 9000, turnFactor: 0.60, hullHalfLen: 24.0, hullHalfBeam: 5.5, GM: 1.05 },
    firstPersonCam: { x: 0.0, y: 9.0, z: -16.7 },   // helmsman abaft the wheel on the quarterdeck (vessel-local; Y re-snapped to deck)
    cannons: battery(FRIG_LONG.slice(0, 13), FRIG_CARR.slice(2, 8)),   // 13 long guns + 6 carronades
    zoneHp: { bow: 210, stern: 210, port: 280, starboard: 280, masts: 210 },
    crew: 360, cargo: 60, price: 350000, parts: [],
  },
];

// ── Dynamic buoyancy derivation (server-authoritative; both clients integrate the same oscillators) ──────────
// The visible bobbing is a DAMPED HARMONIC OSCILLATOR per axis (heave/pitch/roll), not a place-at-wave-height
// low-pass. Each axis' NATURAL PERIOD is derived here from the ship's physical properties, so a heavy wide
// hull genuinely rolls slower/more ponderously than a light narrow one — the "feel" falls out of the physics
// instead of being hand-tuned per ship. The client runs:  angleʺ = ω²·(waveTarget − angle) − 2ζω·angleʹ.
//
//   heave: spring = ρ·g·A_waterplane vs displacement + added mass  →  T = 2π·√((1+a)·draft·Cb / (Cw·g))
//   roll : restoring moment = Δ·g·GM (metacentric height = roll stiffness) → naval T = 2·C·B / √GM
//   pitch: same with the (much larger) longitudinal metacentre GML     → T = 2·C·L / √GML  (stiff → fast)
//
// GM (per vessel, authored) is the key roll-feel knob: high = stiff/snappy warship, low = tender/slow trader.
// Everything else derives from weight + hull L/B we already carry. Gains map the sampled wave-face SLOPE (rad)
// to a target tilt; maxTilt caps it ("dramatic but forgiving"); zeta sets how many times it rocks before
// settling (low roll zeta → a visible, characterful roll).
function deriveBuoyancy(phys) {
  const g = 9.81;
  const L = 2 * (phys.hullHalfLen  ?? 7.0);
  const B = 2 * (phys.hullHalfBeam ?? 2.2);
  const draft = phys.draft ?? Math.max(0.9, 0.45 * B);   // deeper hull → longer heave period
  const GM  = phys.GM  ?? 0.85;                            // roll metacentric height (m)
  const GML = phys.GML ?? 1.05 * L;                        // longitudinal metacentre ~ length (pitch is stiff)
  const Cw = 0.72, Cb = 0.50, addedHeave = 0.7;           // waterplane / block coeffs; heave added-mass fraction
  const Croll = 0.40, Cpitch = 0.24;                      // roll/pitch period coefficients (naval rule-of-thumb)
  const Troll  = 2 * Croll  * B / Math.sqrt(GM);
  const Tpitch = 2 * Cpitch * L / Math.sqrt(GML);
  const Theave = 2 * Math.PI * Math.sqrt((1 + addedHeave) * draft * Cb / (Cw * g));
  const w = (T) => +(2 * Math.PI / T).toFixed(3);
  const b = phys.buoyancy || {};   // an authored buoyancy sub-block may override any derived value
  return {
    ...b,   // keep legacy pitchScale/heaveTau/tiltTau (unused by the oscillator, harmless to carry)
    heaveOmega: b.heaveOmega ?? w(Theave), heaveZeta: b.heaveZeta ?? 0.30,
    pitchOmega: b.pitchOmega ?? w(Tpitch), pitchZeta: b.pitchZeta ?? 0.22, pitchGain: b.pitchGain ?? 0.85,
    rollOmega:  b.rollOmega  ?? w(Troll),  rollZeta:  b.rollZeta  ?? 0.16, rollGain:  b.rollGain  ?? 1.05,
    // Wind-heel → roll-target contribution. PURELY VISUAL: leeway + sail-spill still use the raw heel
    // angle, so trimming this changes only how far the hull LEANS. 0.5 keeps the lean realistic (a
    // 10 kn beam reach leans ~5°, a hard blow tops out ~13°) instead of the over-the-top ~23° that
    // the old 0.9 × the 26° cap produced. The roll oscillator eases it in, so the ship rolls DOWN
    // onto its new angle over a second or two rather than snapping.
    heelGain:   b.heelGain ?? 0.5,
    maxTilt:    b.maxTilt  ?? 0.24,    // rad cap on wave-induced tilt (~13.7°) — forgiving
    periods:    { heave: +Theave.toFixed(2), pitch: +Tpitch.toFixed(2), roll: +Troll.toFixed(2) },   // debug/HUD
  };
}
// Enrich every vessel's physics with the derived oscillator block at module load, so every endpoint that
// emits `physics` (getVesselBySlug / getDefaultVessel) carries it and both clients read the same numbers.
for (const v of VESSELS) if (v.physics) v.physics.buoyancy = deriveBuoyancy(v.physics);
exports.deriveBuoyancy = deriveBuoyancy;

/** Look up a vessel definition by slug (defaults to the sloop). Used by the movement validator to
 *  read per-vessel physics (maxSpeed, etc.) when checking the plausibility of a position update. */
exports.getVesselDef = (slug) => VESSELS.find(v => v.slug === slug) || VESSELS.find(v => v.slug === 'sloop') || VESSELS[0];

// ── Shipwright per-hull UPGRADE costs (each buyable once) ────────────────────────────────────────────────────
// Scales by tier; BOTH upgrades together stay cheaper than the next ship up (pinnace 6k < sloop 10k; sloop 50k <
// brig 200k). Cannon = armor cost per tier for now (kept as separate fields so either can be tuned independently).
const UPGRADE_COST = {
  pinnace:     { cannon: 3000,  armor: 3000  },
  sloop:       { cannon: 25000, armor: 25000 },
  brig:        { cannon: 60000, armor: 60000 },
  merchantman: { cannon: 30000, armor: 30000 },   // both together < the brig (200k); a hauler's modest refit
  frigate_heavy:  { cannon: 120000, armor: 120000 },   // apex tier — flat, expensive refit scaled by loadout
  frigate_medium: { cannon: 90000,  armor: 90000  },
  frigate_light:  { cannon: 70000,  armor: 70000  },
};
/** Cost of a 'cannon' | 'armor' upgrade for a vessel slug (0 if unknown). */
exports.upgradeCost = (slug, kind) => (UPGRADE_COST[slug] && UPGRADE_COST[slug][kind]) || 0;

/** Full crew complement for a vessel (the Crew resource's max). Defaults to the sloop's if unknown. */
exports.crewFor = (slug) => (exports.getVesselDef(slug)?.crew | 0) || 4;

exports.getVessels = (req, res) => {
  // Summary feeds the shipwright menu: name + description + the economic/handling stats a buyer compares.
  const summaries = VESSELS.map(v => ({
    id: v.id, name: v.name, slug: v.slug, description: v.description,
    price: v.price | 0, cargo: v.cargo | 0,
    maxSpeed: v.physics?.maxSpeed ?? 0, guns: (v.cannons?.port?.length ?? 3),
    cannonUpgradeCost: exports.upgradeCost(v.slug, 'cannon'), armorUpgradeCost: exports.upgradeCost(v.slug, 'armor'),
  }));
  res.json(summaries);
};

/** The buyable-vessel catalogue as a plain array — used server-side by the ship-purchase validator. */
exports.listVessels = () => VESSELS.map(v => ({ slug: v.slug, name: v.name, price: v.price | 0, cargo: v.cargo | 0 }));

exports.getDefaultVessel = (req, res) => {
  res.json(VESSELS[0]);
};

exports.getVesselBySlug = (req, res) => {
  const vessel = VESSELS.find(v => v.slug === req.params.slug);
  if (!vessel) return res.status(404).json({ message: 'Vessel not found' });
  res.json(vessel);
};
