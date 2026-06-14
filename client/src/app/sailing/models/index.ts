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
/** One placed building/prop in a town (world coords; rotY in degrees). asset = GLB basename in harbors/. */
export interface TownBuilding {
  asset: string;
  x: number;
  z: number;
  rotY: number;
}

/** Oriented rectangle (world coords; halfZ along heading/inland, halfX across; rotY degrees). */
export interface TownRect {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
  rotY: number;
  elev?: number;   // flattened pad elevation (pads only)
}

export interface TownStreet { x1: number; z1: number; x2: number; z2: number; width: number; }

export interface TerrainHarbor {
  id: string;
  name: string;
  description: string;
  variant: 'straight' | 'l' | 't';
  x: number;
  z: number;
  heading: number;
  // Harbor Towns v2 (optional — present on manifests baked with the town-layout generator).
  tier?: 'capital' | 'medium' | 'small';
  pad?: TownRect;
  buildings?: TownBuilding[];
  square?: TownRect | null;
  streets?: TownStreet[];
  // Town Economy — the town's trade specialty (e.g. 'plantation', 'port'). Drives its market prices.
  specialty?: string;
  // Factions — the owning nation (e.g. 'english'); contested border towns also carry a rivalFaction.
  faction?: string;
  contested?: boolean;
  rivalFaction?: string;
}

// ── Town Economy (Phase 1) ──────────────────────────────────────────────────
/** One good's quoted prices at a town: ask = player buys, bid = player sells. Phase 2 adds a scarcity hint:
 *  `level` = stock/priceRef (1≈normal, <1 scarce/dear, >1 abundant/cheap); `role` = produced|consumed|neutral. */
export interface MarketRow {
  goodId: string; name: string; ask: number; bid: number; level?: number; role?: string;
  stock?: number;    // units physically on hand at this town
  buyable?: number;  // how many the player may buy right now (a town never sells its last unit)
  cap?: number;      // the town's stock cap for this good
}
/** A trade rumour: the best place to SELL one of this town's exports right now. */
export interface MarketHint { goodId: string; goodName: string; townId: string; townName: string; bid: number; }
/** A town's market quote, pushed by the server when the trader is opened or a trade resolves. */
export interface MarketState {
  townId: string; name: string; specialty: string; goods: MarketRow[]; hint?: MarketHint | null;
  faction?: string | null; contested?: boolean; rivalFaction?: string | null;
}
/** A discovered town in the player's ledger: its specialty + last-seen prices + the in-game day seen. */
export interface LedgerEntry { specialty: string; day: number; goods: { id: string; ask: number; bid: number }[]; }

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

/** Optional dismasting descriptor — the `MastDown` scrub clip + the splinter `Break` morph that the
 *  game drives off the `masts` damage zone. Absent on older GLBs (controllers no-op gracefully). */
export interface RiggedMastDamage {
  fall_clip:    string;          // scrub clip that topples the rig (0 upright .. 1 collapsed)
  hinge_bone?:  string;
  mast_node?:   string;
  break_morph:  RiggedMorphRef;  // splinter/buckle morph on the mast mesh
  fall_side?:   string;
  range_label?: string;
  note?:        string;
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
  mast_damage?: RiggedMastDamage;
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
  npc?:        boolean;    // an NPC merchant trader (server-controlled), not a real player
  faction?:    string | null;   // owning nation for an NPC merchant (e.g. 'english'); null for players
}

export interface ChatMessage {
  id:       string;
  from:     string;
  to?:      string;
  text:     string;
  timestamp: Date;
  chatType: 'global' | 'dm' | 'squadron';
}

/** A squadron member as sent in the server's `squadron_state` roster. */
export interface SquadronMember { id: string; callsign: string; }

/** The player's current squadron (null = not in one), mirrored from `squadron_state`. */
export interface SquadronState {
  squadronId: string;
  leaderId:   string;
  members:    SquadronMember[];
}

/** A pending squadron invite awaiting accept/decline, from `squadron_invited`. */
export interface SquadronInvite {
  squadronId:   string;
  fromId:       string;
  fromCallsign: string;
}
