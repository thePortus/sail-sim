/**
 * Curated catalog of real-world archipelago regions for the terrain generator.
 *
 * Each region is a real place fetched from OpenTopography (Copernicus GLO-30 for land detail +
 * GEBCO/SRTM15+ for ocean bathymetry). The procedural augmentation layer (later phase) crops,
 * rotates, mirrors and sea-level-shifts these to produce endless varied — but real-grounded — worlds.
 *
 * Regions are chosen to (a) pack MULTIPLE islands into a ~50 km window (a real archipelago, not one
 * giant mountain), (b) span distinct archetypes (volcanic peaks, eroded rocky isles, atolls, shield
 * volcanoes, reef-lagoon systems), and (c) sit at low-ish latitude so the equirectangular projection
 * (x scaled by cos(lat)) stays near-square with minimal distortion.
 *
 * `center` is [lat, lon] in degrees; `spanKm` is the square window edge in kilometres (defaults to
 * the playable world size). The bbox is derived in deriveBBox() below.
 */

/** Default window edge (km) — matches the current 50 km playable world envelope. */
export const DEFAULT_SPAN_KM = 50;

export const REGIONS = [
  {
    id: 'society_bora_bora',
    name: 'Bora Bora & Tahaʻa, Society Islands',
    archetype: 'volcanic-barrier-reef',
    center: [-16.55, -151.75],
    notes: 'Sharp volcanic peaks ringed by barrier reefs and turquoise lagoons — the postcard archipelago.',
  },
  {
    id: 'galapagos_isabela',
    name: 'Isabela & Fernandina, Galápagos',
    archetype: 'shield-volcano',
    center: [-0.50, -91.20],
    notes: 'Broad basaltic shield volcanoes with calderas; sits on the equator (near-zero lon distortion).',
  },
  {
    id: 'maldives_male',
    name: 'North & South Malé Atolls, Maldives',
    archetype: 'atoll',
    center: [4.20, 73.50],
    notes: 'Classic ring atolls — reef flats and lagoons barely above sea level; great for sea-level-shift variety.',
  },
  {
    id: 'cyclades_naxos',
    name: 'Naxos, Paros & Mykonos, Cyclades',
    archetype: 'eroded-rocky',
    center: [37.10, 25.30],
    notes: 'Dry, eroded rocky islands with moderate peaks (~1000 m) and many isles; lat 37°N (cos≈30% lon squeeze).',
  },
  {
    id: 'palau_rock_islands',
    name: 'Rock Islands, Palau',
    archetype: 'reef-lagoon',
    center: [7.30, 134.40],
    notes: 'Maze of forested limestone rock islands inside a barrier-reef lagoon.',
  },
  {
    id: 'bvi_tortola',
    name: 'British Virgin Islands',
    archetype: 'hilly-small-isles',
    center: [18.45, -64.50],
    notes: 'A scatter of small steep-sided hilly islands with channels — dense, varied coastline.',
  },
  {
    id: 'hawaii_maui_nui',
    name: 'Maui Nui (Lanaʻi – Molokaʻi – West Maui)',
    archetype: 'volcanic-multi-island',
    center: [20.95, -156.95],
    notes: 'Channel between several volcanic islands; multi-island variety without one peak dominating the window.',
  },
];

/**
 * Derive a [south, north, west, east] bounding box (degrees) for a region from its centre + span.
 * Longitude span is widened by 1/cos(lat) so the window is ~square in metres (compensating for the
 * meridian convergence). Returns the bbox plus the metres-per-degree used (handy downstream).
 */
export function deriveBBox(region, spanKm = DEFAULT_SPAN_KM) {
  const [lat, lon] = region.center;
  const KM_PER_DEG_LAT = 110.574;
  const KM_PER_DEG_LON = 111.320 * Math.cos((lat * Math.PI) / 180);
  const latSpanDeg = spanKm / KM_PER_DEG_LAT;
  const lonSpanDeg = spanKm / KM_PER_DEG_LON;
  return {
    south: lat - latSpanDeg / 2,
    north: lat + latSpanDeg / 2,
    west: lon - lonSpanDeg / 2,
    east: lon + lonSpanDeg / 2,
    kmPerDegLat: KM_PER_DEG_LAT,
    kmPerDegLon: KM_PER_DEG_LON,
  };
}

/** OpenTopography global-DEM demtypes we pull per region. */
export const SOURCES = {
  land:  { demtype: 'COP30',        file: 'land_cop30.tif',  label: 'Copernicus GLO-30 (land, 30 m)' },
  bathy: { demtype: 'GEBCOIceTopo', file: 'bathy_gebco.tif', label: 'GEBCO 2024 (bathymetry, ~500 m)' },
};

export function regionById(id) {
  return REGIONS.find((r) => r.id === id) || null;
}
