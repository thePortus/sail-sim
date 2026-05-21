'use strict';

// Coordinate system: +Z = bow/forward, -Z = stern, +X = starboard, -X = port, +Y = up
// Hull runs from z ≈ -6.5 (stern) to z ≈ 7.2 (bow tip).
// Mast at z=1.5, masthead at y≈15.6.
// Deck surface at y ≈ 1.22.

const PI_2 = 1.5708; // Math.PI / 2

const VESSELS = [
  {
    id: 1,
    name: 'Sloop',
    slug: 'sloop',
    description: 'A nimble single-masted sailing vessel. Responsive to the wind and lively on the water.',
    physics: {
      maxSpeed:         9.0,   // units/s ≈ 17.5 knots hard ceiling
      accelerationRate: 0.22,
      minTackAngle:     32,    // can point to 32° off wind (was 38°)
      sailAreaFactor:   0.40,  // sail drive — close-hauled now viable (was 0.32)
      weight:           2800,
    },
    parts: [

      // ── Hull ─────────────────────────────────────────────────────────────────

      { id: 'hull_main',
        shape: 'box', params: { width: 3.4, height: 1.8, depth: 9.5 },
        position: { x: 0, y: 0.1, z: 0 },
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_bow',
        shape: 'box', params: { width: 1.8, height: 1.6, depth: 2.8 },
        position: { x: 0, y: 0.05, z: 5.8 },
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_stern',
        shape: 'box', params: { width: 3.1, height: 1.5, depth: 2.2 },
        position: { x: 0, y: 0.05, z: -5.4 },
        material: { color: '#3B2212', specular: '#1A1008' } },

      // Raised bulwarks along each side above the waterline
      { id: 'hull_bulwark_port',
        shape: 'box', params: { width: 0.14, height: 0.56, depth: 10.6 },
        position: { x: -1.72, y: 1.39, z: 0 },
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_bulwark_stbd',
        shape: 'box', params: { width: 0.14, height: 0.56, depth: 10.6 },
        position: { x: 1.72, y: 1.39, z: 0 },
        material: { color: '#3B2212', specular: '#1A1008' } },

      // Brass toerails along the top of the bulwarks
      { id: 'toerail_port',
        shape: 'box', params: { width: 0.07, height: 0.10, depth: 10.6 },
        position: { x: -1.67, y: 1.72, z: 0 },
        material: { color: '#C8962A', specular: '#886622' } },

      { id: 'toerail_stbd',
        shape: 'box', params: { width: 0.07, height: 0.10, depth: 10.6 },
        position: { x: 1.67, y: 1.72, z: 0 },
        material: { color: '#C8962A', specular: '#886622' } },

      // White waterline stripe
      { id: 'waterline_stripe',
        shape: 'box', params: { width: 3.52, height: 0.18, depth: 11.2 },
        position: { x: 0, y: 0.82, z: 0 },
        material: { color: '#E8E8E0', specular: '#444444' } },

      // ── Keel + lead ballast bulb ──────────────────────────────────────────────

      { id: 'keel',
        shape: 'box', params: { width: 0.35, height: 1.9, depth: 7.5 },
        position: { x: 0, y: -1.75, z: 0 },
        material: { color: '#111111', specular: '#222222' } },

      // Sphere: heavy lead keel bulb at the bottom of the fin
      { id: 'keel_bulb',
        shape: 'sphere', params: { diameter: 0.92, tessellation: 10 },
        position: { x: 0, y: -2.88, z: 0.3 },
        material: { color: '#1C1C1C', specular: '#444444' } },

      // ── Deck ─────────────────────────────────────────────────────────────────

      // Aft deck (teak planking, darker)
      { id: 'deck_main',
        shape: 'box', params: { width: 3.28, height: 0.22, depth: 6.6 },
        position: { x: 0, y: 1.12, z: -0.9 },
        material: { color: '#8B6914', specular: '#1A1008' } },

      // Forward deck (slightly lighter teak)
      { id: 'deck_forward',
        shape: 'box', params: { width: 3.1, height: 0.22, depth: 4.5 },
        position: { x: 0, y: 1.12, z: 4.2 },
        material: { color: '#9B7820', specular: '#1A1008' } },

      // Main companionway hatch
      { id: 'hatch_main',
        shape: 'box', params: { width: 1.42, height: 0.15, depth: 1.62 },
        position: { x: 0, y: 1.25, z: 0.5 },
        material: { color: '#1A2B3C', specular: '#334455' } },

      // Forward hatch / skylight
      { id: 'hatch_fore',
        shape: 'box', params: { width: 0.82, height: 0.13, depth: 0.82 },
        position: { x: 0, y: 1.26, z: 3.5 },
        material: { color: '#1A2B3C', specular: '#334455' } },

      // ── Cockpit ──────────────────────────────────────────────────────────────

      // Cockpit sole (floor of the cockpit well, lower than deck)
      { id: 'cockpit_sole',
        shape: 'box', params: { width: 2.1, height: 0.14, depth: 2.4 },
        position: { x: 0, y: 0.90, z: -3.4 },
        material: { color: '#7A5A10', specular: '#1A1008' } },

      // Cockpit coamings (raised sides and aft wall of the cockpit well)
      { id: 'cockpit_coaming_port',
        shape: 'box', params: { width: 0.16, height: 0.52, depth: 2.65 },
        position: { x: -1.07, y: 1.39, z: -3.4 },
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'cockpit_coaming_stbd',
        shape: 'box', params: { width: 0.16, height: 0.52, depth: 2.65 },
        position: { x: 1.07, y: 1.39, z: -3.4 },
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'cockpit_coaming_aft',
        shape: 'box', params: { width: 2.55, height: 0.52, depth: 0.16 },
        position: { x: 0, y: 1.39, z: -4.78 },
        material: { color: '#F0EDD8', specular: '#333333' } },

      // Tiller
      { id: 'tiller',
        shape: 'box', params: { width: 0.10, height: 0.10, depth: 1.4 },
        position: { x: 0.6, y: 1.35, z: -4.2 },
        rotation: { x: 0, y: -0.4, z: 0 },
        material: { color: '#5C3D11', specular: '#111111' } },

      // Binnacle (compass housing, black cylinder)
      { id: 'binnacle',
        shape: 'cylinder', params: { diameter: 0.34, height: 0.72, tessellation: 12 },
        position: { x: 0, y: 1.58, z: -3.02 },
        material: { color: '#1A1A1A', specular: '#444444' } },

      // Sphere: binnacle dome (compass glass cover)
      { id: 'binnacle_dome',
        shape: 'sphere', params: { diameter: 0.38, tessellation: 12 },
        position: { x: 0, y: 2.06, z: -3.02 },
        material: { color: '#222222', specular: '#777777' } },

      // ── Cabin / doghouse ─────────────────────────────────────────────────────

      { id: 'cabin',
        shape: 'box', params: { width: 1.9, height: 1.06, depth: 3.2 },
        position: { x: 0, y: 1.74, z: -1.2 },
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'cabin_roof',
        shape: 'box', params: { width: 2.0, height: 0.18, depth: 3.35 },
        position: { x: 0, y: 2.33, z: -1.2 },
        material: { color: '#1A2B3C', specular: '#222222' } },

      // Torus: brass porthole rings on port side
      { id: 'porthole_port_1',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 20 },
        position: { x: -0.97, y: 2.05, z: -0.70 },
        rotation: { x: 0, y: 0, z: PI_2 },
        material: { color: '#B8A060', specular: '#998844' } },

      { id: 'porthole_port_2',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 20 },
        position: { x: -0.97, y: 2.05, z: -2.00 },
        rotation: { x: 0, y: 0, z: PI_2 },
        material: { color: '#B8A060', specular: '#998844' } },

      // Torus: brass porthole rings on starboard side
      { id: 'porthole_stbd_1',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 20 },
        position: { x: 0.97, y: 2.05, z: -0.70 },
        rotation: { x: 0, y: 0, z: PI_2 },
        material: { color: '#B8A060', specular: '#998844' } },

      { id: 'porthole_stbd_2',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 20 },
        position: { x: 0.97, y: 2.05, z: -2.00 },
        rotation: { x: 0, y: 0, z: PI_2 },
        material: { color: '#B8A060', specular: '#998844' } },

      // ── Stern rail + platform ─────────────────────────────────────────────────

      { id: 'stern_rail_port',
        shape: 'cylinder', params: { diameter: 0.07, height: 0.95, tessellation: 8 },
        position: { x: -1.55, y: 1.69, z: -5.4 },
        material: { color: '#DDDDCC', specular: '#999999' } },

      { id: 'stern_rail_stbd',
        shape: 'cylinder', params: { diameter: 0.07, height: 0.95, tessellation: 8 },
        position: { x: 1.55, y: 1.69, z: -5.4 },
        material: { color: '#DDDDCC', specular: '#999999' } },

      // Horizontal top rail connecting the two stern uprights
      { id: 'stern_rail_top',
        shape: 'cylinder', params: { diameter: 0.055, height: 3.16, tessellation: 6 },
        position: { x: 0, y: 2.19, z: -5.4 },
        rotation: { x: 0, y: 0, z: PI_2 },
        material: { color: '#DDDDCC', specular: '#999999' } },

      // Stern boarding platform
      { id: 'stern_platform',
        shape: 'box', params: { width: 3.1, height: 0.14, depth: 0.92 },
        position: { x: 0, y: 1.14, z: -5.98 },
        material: { color: '#8B6914', specular: '#1A1008' } },

      // ── Mast + collar ────────────────────────────────────────────────────────

      // Mast: center y=8.35 → bottom at y=1.6 (deck), top (masthead) at y≈15.6
      { id: 'mast',
        shape: 'cylinder', params: { diameter: 0.21, height: 14.5, tessellation: 8 },
        position: { x: 0, y: 8.35, z: 1.5 },
        material: { color: '#D8D5C8', specular: '#666655' } },

      // Black rubber collar sealing the mast through the deck
      { id: 'mast_collar',
        shape: 'cylinder', params: { diameter: 0.42, height: 0.28, tessellation: 10 },
        position: { x: 0, y: 1.27, z: 1.5 },
        material: { color: '#2A2A2A', specular: '#555555' } },

      // Spreaders (horizontal arms at ~65% mast height — support shrouds)
      // rotation.z = PI/2 lays the cylinder along the X-axis;
      // for port: center x=-1.35 → extends from x=0 (mast) to x=-2.7 (tip)
      { id: 'spreader_port',
        shape: 'cylinder', params: { diameter: 0.07, height: 2.7, tessellation: 6 },
        position: { x: -1.35, y: 10.5, z: 1.5 },
        rotation: { x: 0, y: 0, z: PI_2 },
        material: { color: '#D8D5C8', specular: '#666655' } },

      { id: 'spreader_stbd',
        shape: 'cylinder', params: { diameter: 0.07, height: 2.7, tessellation: 6 },
        position: { x: 1.35, y: 10.5, z: 1.5 },
        rotation: { x: 0, y: 0, z: -PI_2 },
        material: { color: '#D8D5C8', specular: '#666655' } },

      // Sphere: white masthead navigation light at the very top of the mast
      { id: 'masthead_light',
        shape: 'sphere', params: { diameter: 0.26, tessellation: 8 },
        position: { x: 0, y: 15.68, z: 1.5 },
        material: { color: '#FFFFF0', specular: '#FFFFFF', emissive: '#FFFFAA' } },

      // ── Boom + end cap ────────────────────────────────────────────────────────

      // Boom: horizontal, lies along Z (rotation.x = PI/2)
      // Center z=-2.4 → extends from z=1.5 (mast) to z=-6.3 (aft end)
      { id: 'boom',
        shape: 'cylinder', params: { diameter: 0.13, height: 7.8, tessellation: 6 },
        position: { x: 0, y: 1.76, z: -2.4 },
        rotation: { x: PI_2, y: 0, z: 0 },
        material: { color: '#D8D5C8', specular: '#666655' } },

      // Sphere: rounded boom end cap (a small detail that looks polished)
      { id: 'boom_end_cap',
        shape: 'sphere', params: { diameter: 0.22, tessellation: 8 },
        position: { x: 0, y: 1.76, z: -6.32 },
        material: { color: '#D8D5C8', specular: '#666655' } },

      // ── Standing rigging ─────────────────────────────────────────────────────

      // Forestay: from masthead down to bow — main jib stay
      { id: 'forestay',
        shape: 'cylinder', params: { diameter: 0.04, height: 17.0, tessellation: 4 },
        position: { x: 0, y: 9.5, z: 4.8 },
        rotation: { x: -0.85, y: 0, z: 0 },
        material: { color: '#999999', specular: '#666666' } },

      // Backstay: from masthead down to stern — supports mast from aft
      // Vector: from (y=1.2, z=-5.5) to (y=15.6, z=1.5) → angle ≈ 0.45 rad from vertical
      { id: 'backstay',
        shape: 'cylinder', params: { diameter: 0.038, height: 16.2, tessellation: 4 },
        position: { x: 0, y: 8.4, z: -2.0 },
        rotation: { x: 0.45, y: 0, z: 0 },
        material: { color: '#999999', specular: '#666666' } },

      // Upper shrouds: from spreader tips up to masthead
      // Port: from (-2.7, 10.5) to (0, 15.6) → angle 0.487 rad from vertical
      { id: 'shroud_port_upper',
        shape: 'cylinder', params: { diameter: 0.038, height: 5.8, tessellation: 4 },
        position: { x: -1.35, y: 13.05, z: 1.5 },
        rotation: { x: 0, y: 0, z: 0.487 },
        material: { color: '#999999', specular: '#666666' } },

      { id: 'shroud_stbd_upper',
        shape: 'cylinder', params: { diameter: 0.038, height: 5.8, tessellation: 4 },
        position: { x: 1.35, y: 13.05, z: 1.5 },
        rotation: { x: 0, y: 0, z: -0.487 },
        material: { color: '#999999', specular: '#666666' } },

      // Lower shrouds: from chainplates near deck to spreader base on mast
      // Port: from (-1.65, 1.2) to (-0.1, 10.5) → angle 0.175 rad from vertical
      { id: 'shroud_port_lower',
        shape: 'cylinder', params: { diameter: 0.035, height: 9.5, tessellation: 4 },
        position: { x: -0.88, y: 5.85, z: 1.0 },
        rotation: { x: 0.06, y: 0, z: 0.175 },
        material: { color: '#999999', specular: '#666666' } },

      { id: 'shroud_stbd_lower',
        shape: 'cylinder', params: { diameter: 0.035, height: 9.5, tessellation: 4 },
        position: { x: 0.88, y: 5.85, z: 1.0 },
        rotation: { x: 0.06, y: 0, z: -0.175 },
        material: { color: '#999999', specular: '#666666' } },

      // ── Bowsprit ─────────────────────────────────────────────────────────────

      // Extends forward from the bow, slightly above deck, angled up 8°
      { id: 'bowsprit',
        shape: 'cylinder', params: { diameter: 0.16, height: 3.0, tessellation: 8 },
        position: { x: 0, y: 1.46, z: 8.7 },
        rotation: { x: PI_2 - 0.14, y: 0, z: 0 },
        material: { color: '#D8D5C8', specular: '#666655' } },

      // ── Rudder ───────────────────────────────────────────────────────────────

      { id: 'rudder',
        shape: 'box', params: { width: 0.18, height: 2.2, depth: 1.88 },
        position: { x: 0, y: -1.0, z: -6.95 },
        material: { color: '#111111', specular: '#222222' } },

      // ── Deck hardware ────────────────────────────────────────────────────────

      // Primary winches (port and starboard, at the mast)
      { id: 'winch_port',
        shape: 'cylinder', params: { diameter: 0.30, height: 0.28, tessellation: 10 },
        position: { x: -1.28, y: 1.28, z: 0.8 },
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'winch_stbd',
        shape: 'cylinder', params: { diameter: 0.30, height: 0.28, tessellation: 10 },
        position: { x: 1.28, y: 1.28, z: 0.8 },
        material: { color: '#888888', specular: '#BBBBBB' } },

      // Bow cleat for mooring
      { id: 'cleat_bow',
        shape: 'cylinder', params: { diameter: 0.24, height: 0.11, tessellation: 8 },
        position: { x: 0, y: 1.26, z: 6.3 },
        material: { color: '#888888', specular: '#BBBBBB' } },

      // Midship cleats
      { id: 'cleat_port',
        shape: 'cylinder', params: { diameter: 0.18, height: 0.10, tessellation: 6 },
        position: { x: -1.60, y: 1.23, z: -1.5 },
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'cleat_stbd',
        shape: 'cylinder', params: { diameter: 0.18, height: 0.10, tessellation: 6 },
        position: { x: 1.60, y: 1.23, z: -1.5 },
        material: { color: '#888888', specular: '#BBBBBB' } },

      // ── Navigation lights ────────────────────────────────────────────────────

      // Sphere: port (red) nav light — visible from forward port quadrant
      { id: 'nav_red',
        shape: 'sphere', params: { diameter: 0.20, tessellation: 8 },
        position: { x: -1.62, y: 1.36, z: 5.55 },
        material: { color: '#FF2200', specular: '#FF6644', emissive: '#CC1100' } },

      // Sphere: starboard (green) nav light
      { id: 'nav_green',
        shape: 'sphere', params: { diameter: 0.20, tessellation: 8 },
        position: { x: 1.62, y: 1.36, z: 5.55 },
        material: { color: '#00CC44', specular: '#44FF88', emissive: '#008833' } },

    ],
  },
];

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
