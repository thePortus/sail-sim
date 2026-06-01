// ── Weather ───────────────────────────────────────────────────────────────────

export interface Wind {
  x:               number;
  z:               number;
  speed:           number;
  fromBearingDeg:  number;   // compass bearing the wind comes FROM (0=N, 90=E)
  cardinalDir:     string;
  beaufort:        number;
}

export interface SeaConditions {
  waveHeight:  number;  // 0.3–3.5
  choppiness:  number;  // 0.05–1.0
}

export interface Weather {
  wind:          Wind;
  sea:           SeaConditions;
  turbulence:    number;
  fog:           { density: number };
  /** 0 = crystal-clear blue sky → 1 = pitch-dark storm.
   *  Drives cloud overcast level, fog, and precipitation independently of wind. */
  cloudiness:    number;
  precipitation: 'none' | 'drizzle' | 'rain' | 'storm';
  description:   string;
}

// ── Islands ───────────────────────────────────────────────────────────────────

export interface CoastlinePoint {
  angleDeg: number;
  radius:   number;
}

export interface IslandPeak {
  dx:        number;
  dz:        number;
  elevation: number;
  radius:    number;
}

export interface Island {
  id:            string;
  name:          string;
  centerX:       number;
  centerZ:       number;
  maxRadius:     number;
  peakElevation: number;
  coastline:     CoastlinePoint[];
  peaks:         IslandPeak[];
  type:          'volcanic' | 'atoll' | 'ridge' | 'crescent' | 'stack' | 'bay';
  description:   string;
  spawnX:        number;
  spawnZ:        number;
}

export interface TerrainWorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TerrainSpawnPoint {
  x: number;
  z: number;
  heading: number;
}

export interface TerrainManifest {
  version: number;
  source: string;
  width: number;
  height: number;
  chunkSize: number;
  chunkCountX: number;
  chunkCountZ: number;
  quantizationLevels: number;
  waterThreshold: number;
  sourceMin: number;
  sourceMax: number;
  targetPeakElevation: number;
  worldBounds: TerrainWorldBounds;
  spawns: TerrainSpawnPoint[];
}

// ── Vessels ───────────────────────────────────────────────────────────────────

export type SailState = 'reefed' | 'topsails' | 'full';

export interface VesselPhysics {
  maxSpeed:        number;
  accelerationRate: number;
  minTackAngle:    number;
  sailAreaFactor:  number;
  weight:          number;
}

export interface VesselPartParams {
  width?:        number;
  height?:       number;
  depth?:        number;
  diameter?:     number;
  thickness?:    number;   // torus tube diameter
  tessellation?: number;
}

export interface VesselPart {
  id:           string;
  shape:        'box' | 'cylinder' | 'plane' | 'sphere' | 'torus';
  params:       VesselPartParams;
  position:     { x: number; y: number; z: number };
  rotation?:    { x: number; y: number; z: number };
  /** PBR material preset key. When present, overrides the flat StandardMaterial
   *  that was previously derived from `material.color` / `material.specular`. */
  materialType?: string;
  material:     { color: string; specular?: string; alpha?: number; emissive?: string };
}

export interface Vessel {
  id:          number;
  name:        string;
  slug:        string;
  description: string;
  physics:     VesselPhysics;
  parts:       VesselPart[];
}

export interface VesselSummary {
  id:          number;
  name:        string;
  slug:        string;
  description: string;
}

// ── Game state ────────────────────────────────────────────────────────────────

export interface VesselState {
  x:           number;
  z:           number;
  heading:     number;    // compass bearing 0–360, 0=North (+Z), 90=East (+X)
  speed:       number;    // current speed (units/s)
  turnRate?:   number;    // heading angular velocity (deg/s); broadcast for remote dead-reckoning
  sailState:   SailState;
  windAngle:   number;    // 0=into wind, 180=before wind
  isPortTack:  boolean;   // wind from port side
  heelAngle:   number;    // lean angle (degrees, positive=starboard)
  sheetAngle:  number;    // sail sheet angle 5–88° (5=close-hauled, 88=fully eased)
  trimQuality: number;    // 0–1 how well the sail is trimmed for the current wind angle
}

export interface OtherPlayer {
  id:          string;
  x:           number;
  z:           number;
  heading:     number;
  speed:       number;
  turnRate?:   number;    // heading deg/s (for remote dead-reckoning that curves through turns)
  sheetAngle?: number;    // boom sheet angle (deg) so remotes render trimmed sails
  isPortTack?: boolean;   // which side the boom swings — needed to mirror the trim
  sailState:   SailState;
  vesselName:  string;
  vesselSlug:  string;
  callsign:    string;
}

export interface ChatMessage {
  id:       string;
  from:     string;
  to?:      string;
  text:     string;
  timestamp: Date;
  chatType: 'global' | 'dm';
}
