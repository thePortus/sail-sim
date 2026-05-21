'use strict';

/**
 * The Archipelago of Ignis — a volcanic island chain.
 *
 * Coastline is defined as 16 polar control points (compass angles at 22.5° steps).
 * Compass convention: 0° = North (+Z), 90° = East (+X), 180° = South (-Z).
 * The client interpolates these to build a full coastline polygon.
 *
 * peaks[]: secondary volcanic peaks relative to island center.
 * spawnX/spawnZ: safe open-water spawn point near the island.
 */

// Helper — build coastline array from a 16-element radius list (N → NNW, 22.5° steps)
function mkCoastline(radii) {
  const labels = [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5, 180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5];
  return labels.map((angleDeg, i) => ({ angleDeg, radius: radii[i] }));
}

const ISLANDS = [

  // ── 1. Isla del Fuego ─────────────────────────────────────────────────────
  // The great fire island. Largest of the archipelago, dominated by an active
  // stratovolcano. Deep bays on the east and south, rocky capes to the NNE and ESE.
  {
    id: 'isla-del-fuego',
    name: 'Isla del Fuego',
    centerX: 0, centerZ: 0,
    maxRadius: 5000,
    peakElevation: 950,
    coastline: mkCoastline([
      4800, 5200, 4600, 3500,   // N NNE NE ENE   (NE bay)
      4700, 5300, 4900, 4200,   // E ESE SE SSE    (ESE cape)
      3800, 4500, 5100, 5400,   // S SSW SW WSW    (S bay, W bulk)
      4800, 3700, 5000, 4400,   // W WNW NW NNW    (WNW bay)
    ]),
    peaks: [
      { dx:    0, dz:    0, elevation: 950, radius: 1300 }, // main caldera
      { dx:  850, dz: -650, elevation: 510, radius:  700 }, // eastern flank peak
      { dx: -900, dz:  480, elevation: 380, radius:  580 }, // western ridge
    ],
    type: 'volcanic',
    description: 'The great fire island, dominated by an active stratovolcano.',
    spawnX: 7200, spawnZ: 0,
  },

  // ── 2. Isla de la Niebla ──────────────────────────────────────────────────
  // The Mist Island. Often shrouded in cloud. Rugged NW coastline, gentler south.
  {
    id: 'isla-de-la-niebla',
    name: 'Isla de la Niebla',
    centerX: -12000, centerZ: 9000,
    maxRadius: 2800,
    peakElevation: 620,
    coastline: mkCoastline([
      2400, 2700, 2900, 2500,
      2100, 2400, 2600, 2800,
      2700, 2500, 2200, 2600,
      2800, 3000, 2700, 2600,
    ]),
    peaks: [
      { dx: -200, dz:  300, elevation: 620, radius: 800 },
      { dx:  700, dz: -500, elevation: 300, radius: 450 },
    ],
    type: 'volcanic',
    description: 'A mist-shrouded island with a rugged northwest face.',
    spawnX: -12000, spawnZ: 12500,
  },

  // ── 3. Isla Roca Negra ────────────────────────────────────────────────────
  // Black Rock Island. Steep-sided, very dark basalt. A distinct landmark.
  {
    id: 'isla-roca-negra',
    name: 'Isla Roca Negra',
    centerX: 16000, centerZ: -4000,
    maxRadius: 2500,
    peakElevation: 740,
    coastline: mkCoastline([
      2100, 2400, 2600, 2200,
      1900, 2300, 2500, 2700,
      2400, 2000, 2200, 2500,
      2300, 2000, 1800, 2100,
    ]),
    peaks: [
      { dx:   0, dz:  0, elevation: 740, radius: 700 },
      { dx: 400, dz: 600, elevation: 320, radius: 380 },
    ],
    type: 'volcanic',
    description: 'Stark black basalt columns rise sheer from the sea.',
    spawnX: 18800, spawnZ: -4000,
  },

  // ── 4. Isla del Sur ───────────────────────────────────────────────────────
  // Southern Island. The most southerly of the main group. Broad and welcoming.
  {
    id: 'isla-del-sur',
    name: 'Isla del Sur',
    centerX: -7000, centerZ: -15000,
    maxRadius: 3200,
    peakElevation: 580,
    coastline: mkCoastline([
      2800, 3000, 3100, 3200,
      2900, 2500, 2800, 3200,
      3100, 2900, 2700, 3100,
      3200, 3000, 2600, 2900,
    ]),
    peaks: [
      { dx:  200, dz: -100, elevation: 580, radius: 900 },
      { dx: -600, dz:  400, elevation: 260, radius: 500 },
    ],
    type: 'volcanic',
    description: 'A broad southern island with fertile green slopes.',
    spawnX: -7000, spawnZ: -18500,
  },

  // ── 5. Isla del Este ──────────────────────────────────────────────────────
  // The easternmost inhabited island. Long and narrow, good anchorage on the west.
  {
    id: 'isla-del-este',
    name: 'Isla del Este',
    centerX: 19000, centerZ: 11000,
    maxRadius: 2600,
    peakElevation: 650,
    coastline: mkCoastline([
      2200, 2500, 2700, 2400,
      2800, 2600, 2300, 2500,
      2400, 2200, 2000, 2300,
      2500, 2700, 2600, 2400,
    ]),
    peaks: [
      { dx: -100, dz:  200, elevation: 650, radius: 750 },
    ],
    type: 'volcanic',
    description: 'The furthest eastern isle. Clear, deep water on the west anchorage.',
    spawnX: 22000, spawnZ: 11000,
  },

  // ── 6. Isla Perdida ───────────────────────────────────────────────────────
  // The Lost Island. Remote, seldom visited. Rough seas on its windward face.
  {
    id: 'isla-perdida',
    name: 'Isla Perdida',
    centerX: -18000, centerZ: -8000,
    maxRadius: 2200,
    peakElevation: 490,
    coastline: mkCoastline([
      1800, 2000, 2200, 1900,
      1700, 2100, 2200, 2100,
      1900, 2100, 2200, 2000,
      1800, 2100, 2300, 2100,
    ]),
    peaks: [
      { dx:   0, dz:   0, elevation: 490, radius: 650 },
    ],
    type: 'volcanic',
    description: 'A remote, lonely island far from the main group.',
    spawnX: -18000, spawnZ: -10500,
  },

  // ── 7. Arrecife Verde ─────────────────────────────────────────────────────
  // The Green Reef. Low and lush, ringed by shallow coral-coloured rock.
  {
    id: 'arrecife-verde',
    name: 'Arrecife Verde',
    centerX: 7000, centerZ: 9000,
    maxRadius: 1200,
    peakElevation: 180,
    coastline: mkCoastline([
      1000, 1100, 1200, 1100,
       900, 1100, 1200, 1100,
      1000, 1100, 1200, 1100,
      1000, 1100, 1200, 1000,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 180, radius: 500 },
    ],
    type: 'volcanic',
    description: 'A low green island ringed with vivid shallow water.',
    spawnX: 8400, spawnZ: 9000,
  },

  // ── 8. Peñón del Diablo ───────────────────────────────────────────────────
  // Devil's Rock. A steep, intimidating spire. No safe landing.
  {
    id: 'penon-del-diablo',
    name: 'Peñón del Diablo',
    centerX: -9000, centerZ: -4000,
    maxRadius: 900,
    peakElevation: 340,
    coastline: mkCoastline([
       700,  800,  900,  800,
       700,  900,  850,  750,
       800,  900,  800,  700,
       750,  850,  900,  800,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 340, radius: 350 },
    ],
    type: 'volcanic',
    description: 'A sheer volcanic spire. There is no safe landing.',
    spawnX: -9000, spawnZ: -5200,
  },

  // ── 9. Islote Seco ────────────────────────────────────────────────────────
  // Dry Islet. Arid, windswept, little vegetation.
  {
    id: 'islote-seco',
    name: 'Islote Seco',
    centerX: 3500, centerZ: -11000,
    maxRadius: 700,
    peakElevation: 150,
    coastline: mkCoastline([
      600, 650, 700, 650,
      600, 700, 650, 600,
      650, 700, 650, 600,
      650, 700, 650, 600,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 150, radius: 300 },
    ],
    type: 'volcanic',
    description: 'A dry, sun-baked islet with little to offer but shelter.',
    spawnX: 4300, spawnZ: -11000,
  },

  // ── 10. La Roca ───────────────────────────────────────────────────────────
  // The Rock. A distinct navigation waypoint visible for miles.
  {
    id: 'la-roca',
    name: 'La Roca',
    centerX: 13000, centerZ: 6000,
    maxRadius: 600,
    peakElevation: 200,
    coastline: mkCoastline([
      500, 550, 600, 550,
      500, 600, 550, 500,
      550, 600, 550, 500,
      550, 600, 550, 500,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 200, radius: 250 },
    ],
    type: 'volcanic',
    description: 'A prominent rocky outcrop used by sailors as a waypoint.',
    spawnX: 13700, spawnZ: 6000,
  },

  // ── 11. Caleta Blanca ─────────────────────────────────────────────────────
  // White Cove. Light-coloured volcanic ash beaches on the south side.
  {
    id: 'caleta-blanca',
    name: 'Caleta Blanca',
    centerX: -15000, centerZ: 6000,
    maxRadius: 1000,
    peakElevation: 130,
    coastline: mkCoastline([
       800,  900, 1000,  900,
       750,  900, 1000,  950,
       850, 1000,  950,  800,
       900, 1000,  950,  850,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 130, radius: 400 },
    ],
    type: 'volcanic',
    description: 'A low island with pale ash beaches in the sheltered southern cove.',
    spawnX: -15000, spawnZ: 7300,
  },

  // ── 12. Bajo del Sur ──────────────────────────────────────────────────────
  // Southern Shoal. Barely above water. A hazard to navigation.
  {
    id: 'bajo-del-sur',
    name: 'Bajo del Sur',
    centerX: 8000, centerZ: -16000,
    maxRadius: 750,
    peakElevation: 90,
    coastline: mkCoastline([
      600, 700, 750, 700,
      650, 750, 700, 650,
      700, 750, 700, 650,
      700, 750, 700, 650,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 90, radius: 280 },
    ],
    type: 'volcanic',
    description: 'A low, wave-washed shoal. Barely above sea level at high tide.',
    spawnX: 9000, spawnZ: -16000,
  },

  // ── 13. Las Picotas ───────────────────────────────────────────────────────
  // The Spikes. A cluster of sharp volcanic needles.
  {
    id: 'las-picotas',
    name: 'Las Picotas',
    centerX: -5000, centerZ: 7000,
    maxRadius: 300,
    peakElevation: 90,
    coastline: mkCoastline([
      250, 280, 300, 280,
      250, 300, 280, 250,
      270, 300, 280, 250,
      270, 300, 280, 260,
    ]),
    peaks: [
      { dx:   0, dz:   0, elevation: 90, radius: 120 },
      { dx:  80, dz: -70, elevation: 70, radius:  80 },
    ],
    type: 'volcanic',
    description: 'A cluster of jagged volcanic needles rising from the sea.',
    spawnX: -5000, spawnZ: 7500,
  },

  // ── 14. El Escollo ────────────────────────────────────────────────────────
  // The Reef. A partly submerged hazard.
  {
    id: 'el-escollo',
    name: 'El Escollo',
    centerX: 10000, centerZ: -9000,
    maxRadius: 250,
    peakElevation: 65,
    coastline: mkCoastline([
      200, 230, 250, 230,
      200, 240, 250, 220,
      210, 240, 250, 230,
      220, 240, 250, 220,
    ]),
    peaks: [
      { dx: 0, dz: 0, elevation: 65, radius: 100 },
    ],
    type: 'volcanic',
    description: 'A partly submerged volcanic reef. Give it wide berth.',
    spawnX: 10300, spawnZ: -9000,
  },

  // ── 15. Los Farallones ────────────────────────────────────────────────────
  // Sea Stacks. Dramatic pillars of rock far to the northwest.
  {
    id: 'los-farallones',
    name: 'Los Farallones',
    centerX: -19000, centerZ: -3000,
    maxRadius: 280,
    peakElevation: 120,
    coastline: mkCoastline([
      150, 200, 250, 180,
      130, 220, 250, 200,
      160, 220, 250, 180,
      150, 210, 250, 190,
    ]),
    peaks: [
      { dx:   0, dz:  0, elevation: 120, radius: 100 },
      { dx: -80, dz: 60, elevation:  90, radius:  70 },
    ],
    type: 'volcanic',
    description: 'Dramatic sea-stack pillars at the far edge of the archipelago.',
    spawnX: -19000, spawnZ: -3600,
  },
];

exports.getIslands = (req, res) => {
  res.json(ISLANDS);
};

exports.getIslandById = (req, res) => {
  const island = ISLANDS.find(i => i.id === req.params.id);
  if (!island) return res.status(404).json({ message: 'Island not found' });
  res.json(island);
};
