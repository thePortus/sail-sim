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

const VESSELS = [
  {
    id: 1,
    name: 'Sloop',
    slug: 'sloop',
    description: 'A nimble single-masted sailing vessel. Responsive to the wind and lively on the water.',
    physics: {
      maxSpeed:         9.0,
      accelerationRate: 0.22,
      minTackAngle:     32,
      sailAreaFactor:   0.40,
      weight:           2800,
    },
    parts: [

      // ── Hull ─────────────────────────────────────────────────────────────────

      { id: 'hull_main',
        shape: 'box', params: { width: 3.4, height: 1.8, depth: 9.5 },
        position: { x: 0, y: 0.1, z: 0 },
        materialType: 'wood_hull',
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_bow',
        shape: 'box', params: { width: 1.8, height: 1.6, depth: 2.8 },
        position: { x: 0, y: 0.05, z: 5.8 },
        materialType: 'wood_hull',
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_stern',
        shape: 'box', params: { width: 3.1, height: 1.5, depth: 2.2 },
        position: { x: 0, y: 0.05, z: -5.4 },
        materialType: 'wood_hull',
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_bulwark_port',
        shape: 'box', params: { width: 0.14, height: 0.56, depth: 10.6 },
        position: { x: -1.72, y: 1.39, z: 0 },
        materialType: 'wood_hull',
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'hull_bulwark_stbd',
        shape: 'box', params: { width: 0.14, height: 0.56, depth: 10.6 },
        position: { x: 1.72, y: 1.39, z: 0 },
        materialType: 'wood_hull',
        material: { color: '#3B2212', specular: '#1A1008' } },

      { id: 'transom',
        shape: 'box', params: { width: 2.95, height: 1.65, depth: 0.12 },
        position: { x: 0, y: 0.22, z: -6.55 },
        materialType: 'wood_hull',
        material: { color: '#3B2212', specular: '#1A1008' } },

      // Brass toerails along the top of the bulwarks
      { id: 'toerail_port',
        shape: 'box', params: { width: 0.07, height: 0.10, depth: 10.6 },
        position: { x: -1.67, y: 1.72, z: 0 },
        materialType: 'brass',
        material: { color: '#C8962A', specular: '#886622' } },

      { id: 'toerail_stbd',
        shape: 'box', params: { width: 0.07, height: 0.10, depth: 10.6 },
        position: { x: 1.67, y: 1.72, z: 0 },
        materialType: 'brass',
        material: { color: '#C8962A', specular: '#886622' } },

      // White waterline stripe
      { id: 'waterline_stripe',
        shape: 'box', params: { width: 3.52, height: 0.18, depth: 11.2 },
        position: { x: 0, y: 0.82, z: 0 },
        materialType: 'paint_white',
        material: { color: '#E8E8E0', specular: '#444444' } },

      // ── Keel + lead ballast bulb ──────────────────────────────────────────────

      { id: 'keel',
        shape: 'box', params: { width: 0.35, height: 1.9, depth: 7.5 },
        position: { x: 0, y: -1.75, z: 0 },
        materialType: 'black_metal',
        material: { color: '#111111', specular: '#222222' } },

      { id: 'keel_bulb',
        shape: 'sphere', params: { diameter: 0.92, tessellation: 14 },
        position: { x: 0, y: -2.88, z: 0.3 },
        materialType: 'black_metal',
        material: { color: '#1C1C1C', specular: '#444444' } },

      // ── Deck ─────────────────────────────────────────────────────────────────

      { id: 'deck_main',
        shape: 'box', params: { width: 3.28, height: 0.22, depth: 6.6 },
        position: { x: 0, y: 1.12, z: -0.9 },
        materialType: 'wood_teak',
        material: { color: '#8B6914', specular: '#1A1008' } },

      { id: 'deck_forward',
        shape: 'box', params: { width: 3.1, height: 0.22, depth: 4.5 },
        position: { x: 0, y: 1.12, z: 4.2 },
        materialType: 'wood_teak',
        material: { color: '#9B7820', specular: '#1A1008' } },

      { id: 'hatch_main',
        shape: 'box', params: { width: 1.42, height: 0.15, depth: 1.62 },
        position: { x: 0, y: 1.25, z: 0.5 },
        materialType: 'paint_navy',
        material: { color: '#1A2B3C', specular: '#334455' } },

      { id: 'hatch_fore',
        shape: 'box', params: { width: 0.82, height: 0.13, depth: 0.82 },
        position: { x: 0, y: 1.26, z: 3.5 },
        materialType: 'paint_navy',
        material: { color: '#1A2B3C', specular: '#334455' } },

      // ── Cockpit ──────────────────────────────────────────────────────────────

      { id: 'cockpit_sole',
        shape: 'box', params: { width: 2.1, height: 0.14, depth: 2.4 },
        position: { x: 0, y: 0.90, z: -3.4 },
        materialType: 'wood_teak',
        material: { color: '#7A5A10', specular: '#1A1008' } },

      { id: 'cockpit_coaming_port',
        shape: 'box', params: { width: 0.16, height: 0.52, depth: 2.65 },
        position: { x: -1.07, y: 1.39, z: -3.4 },
        materialType: 'paint_cream',
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'cockpit_coaming_stbd',
        shape: 'box', params: { width: 0.16, height: 0.52, depth: 2.65 },
        position: { x: 1.07, y: 1.39, z: -3.4 },
        materialType: 'paint_cream',
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'cockpit_coaming_aft',
        shape: 'box', params: { width: 2.55, height: 0.52, depth: 0.16 },
        position: { x: 0, y: 1.39, z: -4.78 },
        materialType: 'paint_cream',
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'tiller',
        shape: 'box', params: { width: 0.10, height: 0.10, depth: 1.4 },
        position: { x: 0.6, y: 1.35, z: -4.2 },
        rotation: { x: 0, y: -0.4, z: 0 },
        materialType: 'wood_spar',
        material: { color: '#5C3D11', specular: '#111111' } },

      { id: 'binnacle',
        shape: 'cylinder', params: { diameter: 0.34, height: 0.72, tessellation: 16 },
        position: { x: 0, y: 1.58, z: -3.02 },
        materialType: 'black_metal',
        material: { color: '#1A1A1A', specular: '#444444' } },

      { id: 'binnacle_dome',
        shape: 'sphere', params: { diameter: 0.38, tessellation: 16 },
        position: { x: 0, y: 2.06, z: -3.02 },
        materialType: 'glass',
        material: { color: '#222222', specular: '#777777' } },

      // ── Cabin / doghouse ─────────────────────────────────────────────────────

      { id: 'cabin',
        shape: 'box', params: { width: 1.9, height: 1.06, depth: 3.2 },
        position: { x: 0, y: 1.74, z: -1.2 },
        materialType: 'paint_cream',
        material: { color: '#F0EDD8', specular: '#333333' } },

      { id: 'cabin_roof',
        shape: 'box', params: { width: 2.0, height: 0.18, depth: 3.35 },
        position: { x: 0, y: 2.33, z: -1.2 },
        materialType: 'paint_navy',
        material: { color: '#1A2B3C', specular: '#222222' } },

      // Brass porthole rings
      { id: 'porthole_port_1',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 24 },
        position: { x: -0.97, y: 2.05, z: -0.70 },
        rotation: { x: 0, y: 0, z: PI_2 },
        materialType: 'brass',
        material: { color: '#B8A060', specular: '#998844' } },

      { id: 'porthole_port_2',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 24 },
        position: { x: -0.97, y: 2.05, z: -2.00 },
        rotation: { x: 0, y: 0, z: PI_2 },
        materialType: 'brass',
        material: { color: '#B8A060', specular: '#998844' } },

      { id: 'porthole_stbd_1',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 24 },
        position: { x: 0.97, y: 2.05, z: -0.70 },
        rotation: { x: 0, y: 0, z: PI_2 },
        materialType: 'brass',
        material: { color: '#B8A060', specular: '#998844' } },

      { id: 'porthole_stbd_2',
        shape: 'torus', params: { diameter: 0.38, thickness: 0.08, tessellation: 24 },
        position: { x: 0.97, y: 2.05, z: -2.00 },
        rotation: { x: 0, y: 0, z: PI_2 },
        materialType: 'brass',
        material: { color: '#B8A060', specular: '#998844' } },

      // ── Stern rail + platform ─────────────────────────────────────────────────

      { id: 'stern_rail_port',
        shape: 'cylinder', params: { diameter: 0.07, height: 0.95, tessellation: 8 },
        position: { x: -1.55, y: 1.69, z: -5.4 },
        materialType: 'steel',
        material: { color: '#DDDDCC', specular: '#999999' } },

      { id: 'stern_rail_stbd',
        shape: 'cylinder', params: { diameter: 0.07, height: 0.95, tessellation: 8 },
        position: { x: 1.55, y: 1.69, z: -5.4 },
        materialType: 'steel',
        material: { color: '#DDDDCC', specular: '#999999' } },

      { id: 'stern_rail_top',
        shape: 'cylinder', params: { diameter: 0.055, height: 3.16, tessellation: 6 },
        position: { x: 0, y: 2.19, z: -5.4 },
        rotation: { x: 0, y: 0, z: PI_2 },
        materialType: 'steel',
        material: { color: '#DDDDCC', specular: '#999999' } },

      { id: 'stern_platform',
        shape: 'box', params: { width: 3.1, height: 0.14, depth: 0.92 },
        position: { x: 0, y: 1.14, z: -5.98 },
        materialType: 'wood_teak',
        material: { color: '#8B6914', specular: '#1A1008' } },

      // ── Mast + fittings ──────────────────────────────────────────────────────

      { id: 'mast',
        shape: 'cylinder', params: { diameter: 0.21, height: 14.5, tessellation: 16 },
        position: { x: 0, y: 8.35, z: 1.5 },
        materialType: 'wood_spar',
        material: { color: '#D8D5C8', specular: '#666655' } },

      { id: 'mast_collar',
        shape: 'cylinder', params: { diameter: 0.42, height: 0.28, tessellation: 12 },
        position: { x: 0, y: 1.27, z: 1.5 },
        materialType: 'rubber',
        material: { color: '#2A2A2A', specular: '#555555' } },

      // NOTE: gooseneck, boom, boom_end_cap, boom_block are built
      // programmatically in vessel.service.ts so they rotate with the sail pivot.

      // Mast hoops — 7 rings along the luff track where the mainsail attaches
      { id: 'mast_hoop_0',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 2.30, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'mast_hoop_1',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 3.40, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'mast_hoop_2',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 4.50, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'mast_hoop_3',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 5.60, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'mast_hoop_4',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 6.70, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'mast_hoop_5',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 7.80, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'mast_hoop_6',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.048, tessellation: 16 },
        position: { x: 0, y: 8.90, z: 1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      // Spreaders
      { id: 'spreader_port',
        shape: 'cylinder', params: { diameter: 0.07, height: 2.7, tessellation: 8 },
        position: { x: -1.35, y: 10.5, z: 1.5 },
        rotation: { x: 0, y: 0, z: PI_2 },
        materialType: 'wood_spar',
        material: { color: '#D8D5C8', specular: '#666655' } },

      { id: 'spreader_stbd',
        shape: 'cylinder', params: { diameter: 0.07, height: 2.7, tessellation: 8 },
        position: { x: 1.35, y: 10.5, z: 1.5 },
        rotation: { x: 0, y: 0, z: -PI_2 },
        materialType: 'wood_spar',
        material: { color: '#D8D5C8', specular: '#666655' } },

      // Masthead navigation light + sheave box
      { id: 'masthead_light',
        shape: 'sphere', params: { diameter: 0.26, tessellation: 12 },
        position: { x: 0, y: 15.68, z: 1.5 },
        materialType: 'nav_white',
        material: { color: '#FFFFF0', specular: '#FFFFFF', emissive: '#FFFFAA' } },

      { id: 'masthead_sheave',
        shape: 'box', params: { width: 0.20, height: 0.28, depth: 0.13 },
        position: { x: 0, y: 15.40, z: 1.5 },
        materialType: 'brass',
        material: { color: '#C8962A', specular: '#886622' } },

      // ── Boom + end fittings — built in vessel.service.ts (pivot-parented) ──

      // ── Standing rigging ─────────────────────────────────────────────────────

      { id: 'forestay',
        shape: 'cylinder', params: { diameter: 0.04, height: 17.0, tessellation: 4 },
        position: { x: 0, y: 9.5, z: 4.8 },
        rotation: { x: -0.85, y: 0, z: 0 },
        materialType: 'steel',
        material: { color: '#999999', specular: '#666666' } },

      { id: 'backstay',
        shape: 'cylinder', params: { diameter: 0.038, height: 16.2, tessellation: 4 },
        position: { x: 0, y: 8.4, z: -2.0 },
        rotation: { x: 0.45, y: 0, z: 0 },
        materialType: 'steel',
        material: { color: '#999999', specular: '#666666' } },

      { id: 'shroud_port_upper',
        shape: 'cylinder', params: { diameter: 0.038, height: 5.8, tessellation: 4 },
        position: { x: -1.35, y: 13.05, z: 1.5 },
        rotation: { x: 0, y: 0, z: 0.487 },
        materialType: 'steel',
        material: { color: '#999999', specular: '#666666' } },

      { id: 'shroud_stbd_upper',
        shape: 'cylinder', params: { diameter: 0.038, height: 5.8, tessellation: 4 },
        position: { x: 1.35, y: 13.05, z: 1.5 },
        rotation: { x: 0, y: 0, z: -0.487 },
        materialType: 'steel',
        material: { color: '#999999', specular: '#666666' } },

      { id: 'shroud_port_lower',
        shape: 'cylinder', params: { diameter: 0.035, height: 9.5, tessellation: 4 },
        position: { x: -0.88, y: 5.85, z: 1.0 },
        rotation: { x: 0.06, y: 0, z: 0.175 },
        materialType: 'steel',
        material: { color: '#999999', specular: '#666666' } },

      { id: 'shroud_stbd_lower',
        shape: 'cylinder', params: { diameter: 0.035, height: 9.5, tessellation: 4 },
        position: { x: 0.88, y: 5.85, z: 1.0 },
        rotation: { x: 0.06, y: 0, z: -0.175 },
        materialType: 'steel',
        material: { color: '#999999', specular: '#666666' } },

      // Chainplates — metal strap at hull where lower shrouds terminate
      { id: 'chainplate_port',
        shape: 'box', params: { width: 0.06, height: 0.55, depth: 0.28 },
        position: { x: -1.72, y: 1.22, z: 0.8 },
        materialType: 'steel',
        material: { color: '#AAAAAA', specular: '#CCCCCC' } },

      { id: 'chainplate_stbd',
        shape: 'box', params: { width: 0.06, height: 0.55, depth: 0.28 },
        position: { x: 1.72, y: 1.22, z: 0.8 },
        materialType: 'steel',
        material: { color: '#AAAAAA', specular: '#CCCCCC' } },

      // ── Bowsprit ─────────────────────────────────────────────────────────────

      { id: 'bowsprit',
        shape: 'cylinder', params: { diameter: 0.16, height: 3.0, tessellation: 10 },
        position: { x: 0, y: 1.46, z: 8.7 },
        rotation: { x: PI_2 - 0.14, y: 0, z: 0 },
        materialType: 'wood_spar',
        material: { color: '#D8D5C8', specular: '#666655' } },

      // ── Rudder ───────────────────────────────────────────────────────────────

      { id: 'rudder',
        shape: 'box', params: { width: 0.18, height: 2.2, depth: 1.88 },
        position: { x: 0, y: -1.0, z: -6.95 },
        materialType: 'black_metal',
        material: { color: '#111111', specular: '#222222' } },

      // ── Deck hardware ─────────────────────────────────────────────────────────

      { id: 'winch_port',
        shape: 'cylinder', params: { diameter: 0.30, height: 0.28, tessellation: 12 },
        position: { x: -1.28, y: 1.28, z: 0.8 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'winch_stbd',
        shape: 'cylinder', params: { diameter: 0.30, height: 0.28, tessellation: 12 },
        position: { x: 1.28, y: 1.28, z: 0.8 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'cleat_bow',
        shape: 'cylinder', params: { diameter: 0.24, height: 0.11, tessellation: 10 },
        position: { x: 0, y: 1.26, z: 6.3 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'cleat_port',
        shape: 'cylinder', params: { diameter: 0.18, height: 0.10, tessellation: 8 },
        position: { x: -1.60, y: 1.23, z: -1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      { id: 'cleat_stbd',
        shape: 'cylinder', params: { diameter: 0.18, height: 0.10, tessellation: 8 },
        position: { x: 1.60, y: 1.23, z: -1.5 },
        materialType: 'steel',
        material: { color: '#888888', specular: '#BBBBBB' } },

      // Rope coils on cleats
      { id: 'rope_coil_bow',
        shape: 'torus', params: { diameter: 0.40, thickness: 0.08, tessellation: 12 },
        position: { x: 0, y: 1.35, z: 6.3 },
        materialType: 'rope',
        material: { color: '#C8A86A', specular: '#666633' } },

      { id: 'rope_coil_port',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.065, tessellation: 10 },
        position: { x: -1.60, y: 1.30, z: -1.5 },
        materialType: 'rope',
        material: { color: '#C8A86A', specular: '#666633' } },

      { id: 'rope_coil_stbd',
        shape: 'torus', params: { diameter: 0.32, thickness: 0.065, tessellation: 10 },
        position: { x: 1.60, y: 1.30, z: -1.5 },
        materialType: 'rope',
        material: { color: '#C8A86A', specular: '#666633' } },

      // ── Navigation lights ─────────────────────────────────────────────────────

      { id: 'nav_red',
        shape: 'sphere', params: { diameter: 0.20, tessellation: 12 },
        position: { x: -1.62, y: 1.36, z: 5.55 },
        materialType: 'nav_red',
        material: { color: '#FF2200', specular: '#FF6644', emissive: '#CC1100' } },

      { id: 'nav_green',
        shape: 'sphere', params: { diameter: 0.20, tessellation: 12 },
        position: { x: 1.62, y: 1.36, z: 5.55 },
        materialType: 'nav_green',
        material: { color: '#00CC44', specular: '#44FF88', emissive: '#008833' } },

      // Stern navigation light (white — visible from astern 135° arc)
      { id: 'stern_light',
        shape: 'sphere', params: { diameter: 0.20, tessellation: 12 },
        position: { x: 0, y: 2.25, z: -5.4 },
        materialType: 'nav_white',
        material: { color: '#FFFFF0', specular: '#FFFFFF', emissive: '#FFFFEE' } },

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
