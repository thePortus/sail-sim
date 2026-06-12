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
    cargo: 20,                    // hold capacity in cargo slots (Town Economy) — small, nimble
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
    cargo: 40,                    // hold capacity in cargo slots (Town Economy) — stout merchantman
    parts: [],
  },
];

/** Look up a vessel definition by slug (defaults to the sloop). Used by the movement validator to
 *  read per-vessel physics (maxSpeed, etc.) when checking the plausibility of a position update. */
exports.getVesselDef = (slug) => VESSELS.find(v => v.slug === slug) || VESSELS.find(v => v.slug === 'sloop') || VESSELS[0];

exports.getVessels = (req, res) => {
  const summaries = VESSELS.map(v => ({
    id: v.id, name: v.name, slug: v.slug, description: v.description,
  }));
  res.json(summaries);
};

exports.getDefaultVessel = (req, res) => {
  res.json(VESSELS[0]);
};

exports.getVesselBySlug = (req, res) => {
  const vessel = VESSELS.find(v => v.slug === req.params.slug);
  if (!vessel) return res.status(404).json({ message: 'Vessel not found' });
  res.json(vessel);
};
