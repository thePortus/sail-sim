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
    },
    // Helm — at the wheel aft (B_Wheel ≈ model 0,5.74,-11.1), standing eye height, looking forward.
    // y is vessel-local (rides the floated hull); the quarterdeck sits high on this ship.
    firstPersonCam: { x: 0, y: 6.6, z: -9.5 },
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
    price: 800000,                // Ships-as-economy: the top-tier shipwright purchase
    parts: [],
  },
];

/** Look up a vessel definition by slug (defaults to the sloop). Used by the movement validator to
 *  read per-vessel physics (maxSpeed, etc.) when checking the plausibility of a position update. */
exports.getVesselDef = (slug) => VESSELS.find(v => v.slug === slug) || VESSELS.find(v => v.slug === 'sloop') || VESSELS[0];

/** Full crew complement for a vessel (the Crew resource's max). Defaults to the sloop's if unknown. */
exports.crewFor = (slug) => (exports.getVesselDef(slug)?.crew | 0) || 4;

exports.getVessels = (req, res) => {
  // Summary feeds the shipwright menu: name + description + the economic/handling stats a buyer compares.
  const summaries = VESSELS.map(v => ({
    id: v.id, name: v.name, slug: v.slug, description: v.description,
    price: v.price | 0, cargo: v.cargo | 0,
    maxSpeed: v.physics?.maxSpeed ?? 0, guns: (v.cannons?.port?.length ?? 3),
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
