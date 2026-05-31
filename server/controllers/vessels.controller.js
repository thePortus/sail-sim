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
    parts: [],
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
