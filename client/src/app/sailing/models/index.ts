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
  precipitation: 'rain' | 'none';
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
  type:          'volcanic' | 'atoll' | 'ridge';
  description:   string;
  spawnX:        number;
  spawnZ:        number;
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
  id:       string;
  shape:    'box' | 'cylinder' | 'plane' | 'sphere' | 'torus';
  params:   VesselPartParams;
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  material: { color: string; specular?: string; alpha?: number; emissive?: string };
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
  sailState:   SailState;
  windAngle:   number;    // 0=into wind, 180=before wind
  isPortTack:  boolean;   // wind from port side
  heelAngle:   number;    // lean angle (degrees, positive=starboard)
}

export interface OtherPlayer {
  id:          string;
  x:           number;
  z:           number;
  heading:     number;
  speed:       number;
  sailState:   SailState;
  vesselName:  string;
  vesselSlug:  string;
  callsign:    string;
}
