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

/** A harbor town: identity + a pier site. x,z = the shore point (pier origin at the waterline);
 *  heading points SEAWARD (the pier body + docking water extend that way). Detected during terrain
 *  generation (server build findHarbors → manifest.harbors). */
export interface TerrainHarbor {
  id: string;
  name: string;
  description: string;
  variant: 'straight' | 'l' | 't';
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
  targetPeakElevation: number;
  worldBounds: TerrainWorldBounds;
  spawns: TerrainSpawnPoint[];
  harbors?: TerrainHarbor[];   // harbor towns (version ≥ 2 real-data manifests)
  // ── Legacy PNG-pipeline fields (optional; absent on real-data region manifests) ──
  waterThreshold?: number;
  sourceMin?: number;
  sourceMax?: number;
  // ── Signed unified-field encoding (real-data region manifests, version ≥ 2) ──
  // When present, elevation decodes as (q / quantizationLevels) * (maxElevation - minElevation)
  // + minElevation, giving one continuous land(+)/seabed(−) field instead of land-only 0..peak.
  minElevation?: number;
  maxElevation?: number;
  seaLevel?: number;
  verticalScale?: number;
  sourceName?: string;
  archetype?: string;
}

// ── Vessels ───────────────────────────────────────────────────────────────────

export type SailState = 'reefed' | 'topsails' | 'full';

// ── Rigged vessel manifest (companion JSON to a single rigged GLB) ──────────────
// Describes the animation clips, morph targets, and free-rotation bones baked into
// a one-file rigged vessel (e.g. bermuda_sloop_rigged.glb). Consumed by
// SloopController to drive rudder/trim/furl/flag without hardcoding node names.

export interface RiggedMorphRef {
  node:   string;   // mesh node that owns the morph target manager
  target: string;   // morph target name (e.g. "Furl")
  index:  number;   // morph target index on that manager
}

export interface RiggedSailSheetPair {
  sail:        string;                 // logical sail name (Mainsail, Jib, …)
  sail_morph:  RiggedMorphRef;         // the sail's furl morph
  sheet_morph: RiggedMorphRef | null;  // paired sheet-rope morph (drive in lockstep)
}

export interface RiggedClip {
  frames: [number, number];
  kind:   'scrub' | 'play';
  [extra: string]: unknown;
}

export interface RiggedManifest {
  model:        string;
  frame_range:  [number, number];
  fps_authored?: number;
  constants:    Record<string, number>;
  skeleton:     { armature_node: string; joints: string[] };
  clips:        Record<string, RiggedClip>;
  morph_targets: Record<string, Record<string, number>>;
  sail_sheet_pairs: RiggedSailSheetPair[];
  free_rotation_bones: Record<string, { role: string; drive: string; suggestion: string }>;
}

export interface VesselPhysics {
  maxSpeed:        number;
  accelerationRate: number;
  minTackAngle:    number;
  sailAreaFactor:  number;
  weight:          number;
  /** Seconds a fired broadside takes to reload before that side can fire again.
   *  Later modified by crew/morale; a flat per-ship constant for now. */
  reloadWindow?:   number;
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

/** One cannon muzzle in vessel-local space (+Z bow, +Y up). */
export interface VesselCannon { x: number; y: number; z: number; }

export interface Vessel {
  id:          number;
  name:        string;
  slug:        string;
  description: string;
  physics:     VesselPhysics;
  parts:       VesselPart[];
  /** First-person camera eye position in vessel-local space (+Z bow, +X stbd, +Y up). Optional. */
  firstPersonCam?: { x: number; y: number; z: number };
  /** Rigged GLB + animation manifest filenames under /geometry/ (defaults to the sloop if absent). */
  glb?:      string;
  manifest?: string;
  /** Rotate the model 180° about Y on import so its bow faces game-forward (+Z). */
  importFlipY?: boolean;
  /** World starboard direction in vessel-local X: +1 = starboard is +X, −1 = −X (opposite handedness). */
  rightSign?: 1 | -1;
  /** Muzzle positions per side (length = guns per side). */
  cannons?: { port: VesselCannon[]; stbd: VesselCannon[] };
  /** Per-zone hit points (overrides the default ZONE_HP; lets a vessel be weaker/sturdier). */
  zoneHp?: Partial<Record<'bow' | 'stern' | 'port' | 'starboard' | 'masts', number>>;
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
  anchored:    boolean;   // anchor down (boat parked/tethered)
  anchorSide:  'S' | 'P'; // which anchor dropped
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
  anchored?:   boolean;   // anchor down — render the dropped anchor on remotes
  anchorSide?: 'S' | 'P'; // which anchor dropped
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
