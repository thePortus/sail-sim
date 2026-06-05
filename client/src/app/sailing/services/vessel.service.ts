import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  MeshBuilder, Vector3, Color3, Color4, StandardMaterial, PBRMaterial, Mesh, Material,
  AbstractMesh, TransformNode, DynamicTexture, ParticleSystem, Scene, PointerEventTypes, PointLight,
  DirectionalLight,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';   // registers GLB/GLTF plugin with SceneLoader
import { SceneService } from './scene.service';
import { TerrainService } from './terrain.service';
import { OceanService }  from './ocean.service';
import { VesselBuoyancyService } from './vessel-buoyancy.service';
import { VesselAssetCacheService } from './vessel-asset-cache.service';
import { SloopController } from './rigged-vessel.controller';
import { CombatService } from './combat.service';
import { listingFor } from './combat.constants';
import { Vessel, VesselPart, SailState, Wind, SeaConditions, VesselState, VesselPhysics } from '../models';

// Single rigged vessel asset (replaces the old 7-part split sloop). The companion
// manifest names every clip / morph / bone the SloopController drives.
const SLOOP_GLB      = 'bermuda_sloop_rigged.glb';
const SLOOP_MANIFEST = 'bermuda_sloop_rigged.manifest.json';

@Injectable({ providedIn: 'root' })
export class VesselService {
  private sceneService     = inject(SceneService);
  private terrainService   = inject(TerrainService);
  private oceanService     = inject(OceanService);
  private buoyancyService  = inject(VesselBuoyancyService);
  private assetCache       = inject(VesselAssetCacheService);
  private combatService    = inject(CombatService);
  private zone             = inject(NgZone);

  // ── Public reactive state ─────────────────────────────────────────────────
  grounded = signal<boolean>(false);
  /** True while the anchor is down (boat parked/tethered). */
  anchored = signal<boolean>(false);

  state = signal<VesselState>({
    x: 7200, z: 0, heading: 270, speed: 0,
    sailState: 'reefed', windAngle: 90, isPortTack: false, heelAngle: 0,
    sheetAngle: 30, trimQuality: 1, anchored: false, anchorSide: 'S',
  });

  // ── Physics ────────────────────────────────────────────────────────────────
  private x          = 7200;
  private z          = 0;
  private heading    = 270;   // compass bearing 0=N(+Z) 90=E(+X)
  private speed      = 0;
  private prevHeading       = 270;   // last frame's heading, for angular-velocity calc
  private turnRateSmoothed  = 0;     // smoothed heading deg/s, broadcast for remote dead-reckoning
  private sailState:  SailState = 'reefed';
  private isGrounded: boolean   = false;

  private physics: VesselPhysics = {
    maxSpeed: 8, accelerationRate: 0.25, minTackAngle: 38, sailAreaFactor: 0.32, weight: 2800,
  };

  /**
   * Seconds the vessel has been continuously blocked by land.
   * The aground signal only fires once this exceeds GROUNDED_DELAY,
   * so glancing contacts (headland scrape, tight manoeuvre) don't
   * trigger the overlay — only a genuine, sustained grounding does.
   */
  private groundedTime  = 0;
  private readonly GROUNDED_DELAY = 5.0;   // seconds of continuous blocking → aground

  // ── Mesh handles ──────────────────────────────────────────────────────────
  private root!:         TransformNode;


  // ── Rigged vessel animation driver (single GLB: skeleton clips + morphs) ────
  private controller: SloopController | null = null;

  // Water-contact shadow projected beneath the hull.
  private waterShadow: Mesh | null = null;
  private waterShadowMat: StandardMaterial | null = null;

  // ── PBR material / texture pools ─────────────────────────────────────────
  private matPool         = new Map<string, PBRMaterial>();
  private texPool         = new Map<string, DynamicTexture>();

  // ── Cannon recoil ────────────────────────────────────────────────────────
  // Shot-triggered lateral roll impulse model (spring + damper):
  //   shot applies angular-velocity impulse away from firing side,
  //   then hull naturally returns with heavy naval damping.
  private recoilRoll = 0;
  private recoilRollVel = 0;
  // Damage listing — eased toward the tilt from our own hull state (combatService.zones).
  private listRoll  = 0;
  private listPitch = 0;
  private readonly RECOIL_SPRING = 7.2;
  private readonly RECOIL_DAMPING = 5.8;
  private readonly RECOIL_IMPULSE = 0.40;   // rad/s heel kick PER shot
  private readonly RECOIL_MAX_ROLL = 0.17;  // ~9.7° hard safety cap

  // Lateral shudder: a damped sideways lurch AWAY from the firing side (fire
  // starboard → hull jolts to port), layered on top of the sim position.
  private recoilSway = 0;
  private recoilSwayVel = 0;
  private readonly RECOIL_SWAY_SPRING  = 9.0;
  private readonly RECOIL_SWAY_DAMPING = 6.0;
  private readonly RECOIL_SWAY_IMPULSE = 0.95;  // m/s lateral kick PER shot
  private readonly RECOIL_SWAY_MAX     = 0.95;  // m hard cap

  // Hit shudder — a SEPARATE, much heavier roll+sway transient for taking a cannonball
  // (so it reads as violent without changing the tuned firing recoil).
  private hitRoll = 0;
  private hitRollVel = 0;
  private hitSway = 0;
  private hitSwayVel = 0;
  private readonly HIT_SPRING       = 8.5;
  private readonly HIT_DAMPING      = 4.6;
  private readonly HIT_ROLL_IMPULSE = 1.1;   // rad/s — violent heel
  private readonly HIT_SWAY_IMPULSE = 2.6;   // m/s — violent lurch
  private readonly HIT_MAX_ROLL     = 0.34;  // ~19° cap
  private readonly HIT_MAX_SWAY     = 1.8;   // m cap

  /** Heavy shudder from taking a cannonball on the given struck side. */
  addHitShudder(side: 'port' | 'stbd'): void {
    const dir = side === 'port' ? 1 : -1;
    this.hitRollVel += dir * this.HIT_ROLL_IMPULSE;
    this.hitSwayVel += dir * this.HIT_SWAY_IMPULSE;
  }

  addCannonRecoil(side: 'port' | 'stbd'): void {
    // Reaction shoves the hull AWAY from the firing side: a port broadside heels +
    // lurches to starboard (+Z roll, +sway), a starboard broadside to port.
    const dir = side === 'port' ? 1 : -1;
    this.recoilRollVel += dir * this.RECOIL_IMPULSE;
    this.recoilSwayVel += dir * this.RECOIL_SWAY_IMPULSE;
  }

  // ── Gunnery animation delegators (CannonService → SloopController) ──────────
  // Map game-layer 'port'/'stbd' to the model's 'S'/'P' bone-side codes in ONE place.
  // Verified at runtime: the model's 'P' bones sit on the vessel's port (−x) side, which
  // matches the port muzzle offsets — so game 'port' drives the model's 'P' clips.
  private gunSide(side: 'port' | 'stbd'): 'S' | 'P' { return side === 'port' ? 'P' : 'S'; }

  /** 0 = stowed (gun in, ports closed) .. 1 = ready (ports open, gun run out). */
  setGunDeploy(side: 'port' | 'stbd', t: number): void {
    this.controller?.setGunDeployTarget(this.gunSide(side), t);
  }
  /** Recoil kick on a side (call once per cannon shot). */
  addGunRecoilKick(side: 'port' | 'stbd', kick = 0.7): void {
    this.controller?.addGunRecoil(this.gunSide(side), kick);
  }
  /** True once a side has finished running out (safe to fire). */
  isGunReady(side: 'port' | 'stbd'): boolean {
    return this.controller?.isGunReady(this.gunSide(side)) ?? false;
  }
  /** True once a side's stow animation + recoil have fully settled. */
  isGunSettled(side: 'port' | 'stbd'): boolean {
    return this.controller?.gunSettled(this.gunSide(side)) ?? true;
  }
  /** Per-ship reload window (seconds). */
  getReloadWindow(): number { return this.physics.reloadWindow ?? 6; }

  /** Returns the vessel root TransformNode. Used by CannonService to parent cannon pivots. */
  getRoot(): TransformNode { return this.root; }

  // ── Sheet (sail trim) ─────────────────────────────────────────────────────
  // sheetAngleDeg: degrees from the boat's centreline the boom swings out.
  //   5 = close-hauled (sail sheeted hard in)
  //  88 = fully eased (sail right out, running downwind)
  // The player adjusts with Q (ease) / E (haul in).
  private sheetAngleDeg = 30;    // sensible default for a reaching start

  // ── Anchor (parking) ───────────────────────────────────────────────────────
  // While anchored the boat is tethered within ANCHOR_RADIUS of the drop point: it can
  // sail/drift only a metre or two before the rode snubs taut, and can't drift in current.
  private isAnchored   = false;
  private anchorSide: 'S' | 'P' = 'S';   // which anchor dropped (random per drop)
  private anchorX      = 0;
  private anchorZ      = 0;
  private anchorDeploy = 0;              // animated 0=stowed .. 1=lowered
  private readonly ANCHOR_RADIUS = 2.5;  // metres of scope before the rode snubs

  /** Drop or weigh anchor (P key / HUD button). Dropping picks a random side. */
  toggleAnchor(): void {
    this.isAnchored = !this.isAnchored;
    if (this.isAnchored) {
      this.anchorSide = Math.random() < 0.5 ? 'S' : 'P';
      this.anchorX = this.x;
      this.anchorZ = this.z;
    }
    this.anchored.set(this.isAnchored);
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  private keys = { left: false, right: false, sheetIn: false, sheetOut: false };
  private keyHandler!:    (e: KeyboardEvent) => void;
  private keyUpHandler!:  (e: KeyboardEvent) => void;
  private wheelHandler!:  (e: WheelEvent) => void;
  private pointerObserver: any = null;

  // ── Camera orbit ──────────────────────────────────────────────────────────
  private camAzimuth   = 0;    // degrees offset from dead-astern (0 = behind vessel)
  private camElevation = 22;   // degrees above horizon
  private camDist      = 24;   // follow distance (units)
  private isDragging   = false;
  private lastMouseX   = 0;
  private lastMouseY   = 0;

  // ── Weather ────────────────────────────────────────────────────────────────
  private currentWind: Wind = { x: 5, z: 3, speed: 6, fromBearingDeg: 330, cardinalDir: 'NNW', beaufort: 2 };
  private currentSea: SeaConditions = { waveHeight: 0.5, choppiness: 0.1 };
  private simTime   = 0;
  private gustPhase = 0;   // independent phase for gust oscillation

  // ── World-scale travel multiplier ─────────────────────────────────────────
  // The HUD displays physics speed (realistic knots), but world position advances
  // at TRAVEL_SCALE × that rate — a classic video-game map-compression trick.
  // Raise this to make island-to-island sailing feel snappier; lower it for realism.
  private readonly TRAVEL_SCALE = 5.0;

  // ── Hull collision ──────────────────────────────────────────────────────────
  // The aground check used to test only the boat's CENTRE point, so the long bow
  // could plunge ~half a hull-length into an island before the centre reached land
  // (the "sailing inside the island" bug). We instead sample several points along
  // the hull's length so the bow/stern stops at the shoreline like a solid body.
  private readonly HULL_HALF_LEN = 7.0;   // world units from centre to bow/stern tip
  private readonly HULL_SAMPLES  = 4;     // points sampled fore-of-centre to the bow

  /**
   * True if any point along the hull centreline (from centre toward the moving end)
   * lies on land — so the bow/stern is blocked the instant it touches shore, not
   * once the centre arrives. `dirSign` is +1 when moving ahead, -1 when reversing.
   */
  private hullHitsLand(cx: number, cz: number, hr: number, dirSign: number): boolean {
    const fx = Math.sin(hr) * dirSign;   // unit heading vector (forward / reverse)
    const fz = Math.cos(hr) * dirSign;
    for (let i = 1; i <= this.HULL_SAMPLES; i++) {
      const d = (this.HULL_HALF_LEN * i) / this.HULL_SAMPLES;
      if (this.terrainService.isOnLand(cx + fx * d, cz + fz * d)) return true;
    }
    return false;
  }

  // ── Wake / hull-wash particle systems ────────────────────────────────────
  // Four ParticleSystems share one foam texture and use plain Vector3 emitters
  // that are repositioned every physics tick to follow the hull.  Particles are
  // emitted into world space, so they stay put while the boat moves away from
  // them — this naturally builds up a V-shaped foam trail behind the vessel.

  private readonly WAKE_Y = 0.30;          // at the waterline — slightly above wave trough

  // Particle-sprite wake disabled: the additive white foam sprites read as flat
  // billboards on the water and looked bad. The wake is now rendered entirely in
  // the ocean shader (displacement trench + foam trail driven by setBoatTransform).
  // Set true to bring the sprites back.
  private readonly WAKE_PARTICLES_ENABLED = false;

  private wakeTex!:   DynamicTexture;
  private bowSpray!:  ParticleSystem;      // bow-wave V pushing water sideways
  private sternFoam!: ParticleSystem;      // long-life foam forming the wake V-trail
  private portFroth!: ParticleSystem;      // hull wash along port side
  private stbdFroth!: ParticleSystem;      // hull wash along stbd side

  // Emitter positions — updated every tick, referenced (not copied) by the systems
  private bowEmit   = new Vector3(0, this.WAKE_Y, 0);
  private sternEmit = new Vector3(0, this.WAKE_Y, 0);
  private portEmit  = new Vector3(0, this.WAKE_Y, 0);
  private stbdEmit  = new Vector3(0, this.WAKE_Y, 0);

  // ─────────────────────────────────────────────────────────────────────────
  async init(vessel: Vessel, spawnX: number, spawnZ: number, spawnHeading = 270): Promise<void> {
    this.x       = spawnX;
    this.z       = spawnZ;
    this.heading = spawnHeading;
    if (vessel.physics) Object.assign(this.physics, vessel.physics);

    const { scene } = this.sceneService;
    // Group 2 renders after ocean (groups 0+1) but keeps the ocean's depth values
    // so the wave surface correctly occludes submerged hull geometry.
    scene.setRenderingAutoClearDepthStencil(2, false);
    await this.buildMesh(vessel, scene);
    this.setupInput();
    this.setupCameraInput();
    this.startLoop(scene);
  }

  // ─────────────────────────────────────────────────────────────────────────
  private async buildMesh(vessel: Vessel, scene: Scene): Promise<void> {
    this.root = new TransformNode('vessel_root', scene);
    this.root.position = new Vector3(this.x, 0, this.z);
    this.root.rotation.y = this.heading * Math.PI / 180;

    // Build structural parts
    for (const part of vessel.parts) {
      this.createPart(part, scene);
    }

    // Build wake trail (world-space, not parented to root)
    this.buildWake(scene);

    // Projected hull shadow on the water surface.
    this.buildWaterShadow(scene);

    // Load GLB geometry parts (hull, mast, flag, sails, cannons)
    await this.buildGLBMeshes(scene);

    // Register every hull / rig / sail mesh for ocean reflection + shadows + the WebGPU
    // varying-budget trims (see helper).
    this.registerMeshesForRendering(this.root.getChildMeshes());
  }

  /** Register a set of vessel meshes for ocean reflection/refraction, shadow casting, and
   *  the WebGPU varying-budget trims. The single rigged GLB's PBR materials carry more vertex
   *  varyings than the old split parts; combined with the SSAO prePass, shadow receipt, fog,
   *  and the ocean-reflection clip-plane they blow past WebGPU's hard 16 inter-stage limit,
   *  which invalidates EVERY pipeline that includes the vessel (black screen). So: cast
   *  shadows (depth-only, cheap) but don't receive them, drop fog.
   *
   *  The vessel is now KEPT IN the prePass (the excludeFromPrePass call was removed): with shadow
   *  receipt + fog already dropped there's room under the 16 limit, and being in the prePass gives
   *  SSAO/DoF the boat's true depth+normals — without it, SSAO sampled the ocean/shore BEHIND the
   *  boat and painted their AO onto the hull/sails (the "transparent boat" artifact). If this turns
   *  out to still overflow 16 (black screen with the vessel pipeline invalid), the next varying to
   *  shed is the ocean-reflection clip-plane (drop oceanService.addToRenderList → loses boat-in-water
   *  reflection/refraction), then re-exclude from the prePass as the last resort. */
  private registerMeshesForRendering(meshes: AbstractMesh[]): void {
    const sg = this.sceneService.shadowGenerator;
    const seenMats = new Set<Material>();
    for (const mesh of meshes) {
      this.oceanService.addToRenderList(mesh);
      sg?.addShadowCaster(mesh, true);
      mesh.receiveShadows = false;
      const mat = mesh.material;
      if (mat && !seenMats.has(mat)) {
        seenMats.add(mat);
        mat.fogEnabled = false;
      }
    }
  }

  /** Live-reload the rigged model after /reloadassets bumped the cache version: dispose the
   *  current model + controller and re-instantiate from the (now cache-busted) GLB, keeping
   *  the vessel root, physics, input, camera, and cannon wiring intact. */
  async reloadModel(): Promise<void> {
    const scene = this.sceneService.scene;
    if (!scene || !this.root) return;
    const oldRoot = this.controller?.root ?? null;
    if (oldRoot) {
      for (const m of oldRoot.getChildMeshes(false)) this.oceanService.removeFromRenderList(m);
    }
    this.controller?.dispose();
    this.controller = null;
    oldRoot?.dispose();   // disposes the old instanced meshes (shared materials are kept)

    await this.buildGLBMeshes(scene);   // re-instantiate fresh + build a new controller
    if (this.controller) {
      this.registerMeshesForRendering(this.controller.root.getChildMeshes(false));
    }
  }

  // ── GLB geometry loading ──────────────────────────────────────────────────
  // Loads the single rigged sloop GLB (skeleton clips + morph targets, Draco +
  // WEBP) from the /geometry/ static route, plus its companion manifest, and wraps
  // the instantiated model in a SloopController that drives rudder/trim/furl/flag.
  //
  // Orientation: after the loader's handedness conversion the model's bow points -Z,
  // so we apply the 180° Y flip (flipY=true) to face +Z = forward = direction of travel.
  // Parenting + renderingGroupId 2 still happen inside instantiateRigged().
  private async buildGLBMeshes(scene: Scene): Promise<void> {
    const [rigged, manifest] = await Promise.all([
      this.assetCache.instantiateRigged(SLOOP_GLB, scene, this.root, true),
      this.assetCache.loadManifest(SLOOP_MANIFEST),
    ]);
    if (!rigged) { console.warn('[Vessel] rigged sloop failed to load'); return; }

    this.controller = new SloopController(rigged.entries, rigged.root, manifest, scene);
    this.controller.applySailState(this.sailState, true);   // initial pose snaps (no furl anim)
  }

  private buildWaterShadow(scene: Scene): void {
    const tex = new DynamicTexture('hullShadowTex', { width: 128, height: 128 }, scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0.0, 'rgba(0,0,0,0.92)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.55)');
    grd.addColorStop(1.0, 'rgba(0,0,0,0.0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    tex.update();

    this.waterShadowMat = new StandardMaterial('hullShadowMat', scene);
    this.waterShadowMat.diffuseTexture = tex;
    this.waterShadowMat.opacityTexture = tex;
    this.waterShadowMat.emissiveColor = new Color3(0, 0, 0);
    this.waterShadowMat.disableLighting = true;
    this.waterShadowMat.backFaceCulling = false;
    this.waterShadowMat.alpha = 0.90;

    this.waterShadow = MeshBuilder.CreateDisc('hullShadow', { radius: 16, tessellation: 32 }, scene);
    this.waterShadow.material = this.waterShadowMat;
    this.waterShadow.renderingGroupId = 3;
    this.waterShadow.isPickable = false;
    this.waterShadow.rotation.x = Math.PI / 2;
    this.waterShadow.alwaysSelectAsActiveMesh = true;
  }

  private createPart(part: VesselPart, scene: Scene): Mesh {
    let mesh: Mesh;

    if (part.shape === 'box') {
      mesh = MeshBuilder.CreateBox(part.id, {
        width: part.params.width, height: part.params.height, depth: part.params.depth,
      }, scene);
    } else if (part.shape === 'cylinder') {
      mesh = MeshBuilder.CreateCylinder(part.id, {
        diameter: part.params.diameter, height: part.params.height,
        tessellation: part.params.tessellation ?? 8,
      }, scene);
    } else if (part.shape === 'sphere') {
      mesh = MeshBuilder.CreateSphere(part.id, {
        diameter: part.params.diameter,
        segments: part.params.tessellation ?? 8,
      }, scene);
    } else if (part.shape === 'torus') {
      mesh = MeshBuilder.CreateTorus(part.id, {
        diameter:     part.params.diameter,
        thickness:    part.params.thickness ?? 0.1,
        tessellation: part.params.tessellation ?? 16,
      }, scene);
    } else {
      mesh = MeshBuilder.CreatePlane(part.id, {
        width: part.params.width, height: part.params.height,
        sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
    }

    mesh.parent           = this.root;
    mesh.renderingGroupId = 2;   // render after ocean (groups 0+1) so hull is always visible
    mesh.position = new Vector3(part.position.x, part.position.y, part.position.z);
    if (part.rotation) {
      mesh.rotation = new Vector3(part.rotation.x, part.rotation.y, part.rotation.z);
    }

    mesh.material = this.buildVesselMat(part, scene);

    return mesh;
  }

  // ── Sail state ────────────────────────────────────────────────────────────

  setSailState(state: SailState): void {
    this.sailState = state;
    this.controller?.applySailState(state);
  }

  // ── Refloat ───────────────────────────────────────────────────────────────
  // Teleports the vessel to an arbitrary world position.
  // Keeps the current heading, furls sails, and resets speed/grounded state.
  teleportTo(worldX: number, worldZ: number): void {
    this.x     = worldX;
    this.z     = worldZ;
    this.speed = 0;
    this.isAnchored = false;
    this.anchored.set(false);
    this.setSailState('reefed');

    if (this.root) {
      this.root.position.x = this.x;
      this.root.position.z = this.z;
    }

    this.isGrounded   = false;
    this.groundedTime = 0;
    this.grounded.set(false);
    this.resetWake();
  }

  // Teleports the vessel to the nearest terrain spawn point, furls sails,
  // resets speed, and clears the grounded flag.

  refloat(): void {
    const { spawnX, spawnZ, heading } = this.terrainService.nearestSpawn(this.x, this.z);
    this.x       = spawnX;
    this.z       = spawnZ;
    this.speed   = 0;
    this.heading = heading;
    this.isAnchored = false;
    this.anchored.set(false);
    this.setSailState('reefed');

    // Snap mesh immediately so the camera doesn't pan across the world
    if (this.root) {
      this.root.position.x = this.x;
      this.root.position.z = this.z;
      this.root.rotation.y = this.heading * Math.PI / 180;
    }

    this.isGrounded   = false;
    this.groundedTime = 0;
    this.grounded.set(false);
    this.resetWake();
  }


  // ── Sail efficiency curve ─────────────────────────────────────────────────
  // Redesigned to make close-hauled sailing viable (~52 % eff at minTackAngle).
  // minTackAngle = 32° (set in vessel physics), so the "in irons" zone is tighter.

  /**
   * Return the ideal sheet angle (° from centreline) for a given wind angle.
   * Close-hauled = sail in tight; running = sail fully eased.
   */
  private optimalSheetAngle(absAngleFromWind: number): number {
    if (absAngleFromWind < 38)  return 5;
    if (absAngleFromWind < 60)  return 18;
    if (absAngleFromWind < 90)  return 35;
    if (absAngleFromWind < 115) return 52;
    if (absAngleFromWind < 145) return 68;
    if (absAngleFromWind < 165) return 82;
    return 88;
  }

  /**
   * 0–1 trim quality based on how close the player-set sheet angle is to optimal.
   * Over-sheeted (sail too tight) drops off fast; under-sheeted drops more gently.
   */
  private trimFactor(absAngleFromWind: number): number {
    const optimal  = this.optimalSheetAngle(absAngleFromWind);
    const mismatch = this.sheetAngleDeg - optimal;
    if (mismatch < 0) {
      // Over-sheeted: sail stalls quickly — 30° over = fully stalled
      return Math.max(0, 1 + mismatch / 30);
    } else {
      // Under-sheeted: sail luffs more gently — 50° under = fully luffing
      return Math.max(0, 1 - mismatch / 50);
    }
  }

  private sailEfficiency(angleFromWind: number): number {
    if (this.sailState === 'reefed') return 0;
    const sailMult = this.sailState === 'topsails' ? 0.5 : 1.0;
    const a = Math.abs(angleFromWind);
    let eff: number;

    if      (a < this.physics.minTackAngle) eff = -0.30;  // in irons: gentle pushback
    else if (a < 45)  eff = 0.52;  // close-hauled
    else if (a < 60)  eff = 0.72;  // close reach
    else if (a < 90)  eff = 0.86;  // beam reach
    else if (a < 115) eff = 0.95;  // broad reach approach
    else if (a < 145) eff = 1.00;  // broad reach — peak VMG
    else if (a < 165) eff = 0.88;  // running
    else              eff = 0.72;  // dead downwind (blanketed jib)

    // Trim penalty: even a perfect point of sail underperforms with a mis-set sheet
    const trim = (a < this.physics.minTackAngle) ? 1 : this.trimFactor(a);
    return eff * sailMult * trim;
  }

  // ── Turn rate (speed-dependent) ───────────────────────────────────────────
  // Lorentzian shape: peaks at ~25 % of max speed, drops sharply at high speed.
  // At full speed the boat turns ~11 °/s (≈ 360° in 33 s) — hard to spin.
  // At low/zero speed it's ~4 °/s — barely steerable until you have momentum.

  private turnRate(speed: number): number {
    const sf   = Math.abs(speed) / this.physics.maxSpeed;
    if (sf < 0.03) return 4;            // essentially stopped — minimal helm response
    // f(sf) = K · sf / (1 + (sf/p)²) — peaks at sf=p, then falls as 1/sf
    const p    = 0.28;                  // peak agility at 28 % of hull speed
    const rate = 155 * sf / (1 + (sf / p) * (sf / p));
    return Math.max(4, Math.min(30, rate));
  }

  // ── Sheet adjustment rate ─────────────────────────────────────────────────
  private readonly SHEET_RATE = 28;   // degrees per second while Q/E is held

  // ── Update weather from outside ───────────────────────────────────────────

  updateWeather(wind: Wind, sea: SeaConditions): void {
    this.currentWind = wind;
    this.currentSea  = sea;
  }

  // ── Physics loop ──────────────────────────────────────────────────────────

  private startLoop(scene: Scene): void {
    let lastTime = performance.now();
    scene.registerBeforeRender(() => {
      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.05);
      lastTime  = now;
      this.simTime += dt;
      this.physicsStep(dt);
      this.updateCamera(dt);
    });
  }

  private physicsStep(dt: number): void {
    const wind = this.currentWind;

    // ── Sheet adjustment (Q = ease out, E = haul in) ──────────────────────
    if (this.keys.sheetOut) this.sheetAngleDeg = Math.min(88, this.sheetAngleDeg + this.SHEET_RATE * dt);
    if (this.keys.sheetIn)  this.sheetAngleDeg = Math.max( 5, this.sheetAngleDeg - this.SHEET_RATE * dt);

    // ── Gust simulation ─────────────────────────────────────────────────────
    // Two incommensurate sine waves create irregular, non-repeating gusts.
    // ±15 % amplitude feels authentic without being sim-racing extreme.
    this.gustPhase += dt;
    const gustMult   = 1.0
      + 0.10 * Math.sin(this.gustPhase * 2.73)
      + 0.05 * Math.sin(this.gustPhase * 1.31 + 1.7);
    const gustSpeed  = wind.speed * gustMult;

    // Angle from wind: 0 = into wind, 180 = before wind
    let diff = this.heading - wind.fromBearingDeg;
    diff = ((diff + 360) % 360);
    const angleFromWind = diff > 180 ? 360 - diff : diff;
    const isPortTack    = diff <= 180;

    const eff    = this.sailEfficiency(angleFromWind);
    const baseTarget = Math.max(-1.5, Math.min(this.physics.maxSpeed, gustSpeed * eff * this.physics.sailAreaFactor));
    // speedModifier applied below after buoyancy is computed
    this.speed  += (baseTarget - this.speed) * this.physics.accelerationRate * dt;
    if (Math.abs(this.speed) < 0.001) this.speed = 0;  // snap to zero only on true standstill

    // Steering
    if (this.keys.left || this.keys.right) {
      const dir = this.keys.left ? -1 : 1;
      this.heading = ((this.heading + dir * this.turnRate(this.speed) * dt) + 360) % 360;
    }

    // ── Position update ──────────────────────────────────────────────────────
    // TRAVEL_SCALE compresses map distances while keeping knot values realistic.
    const hr = this.heading * Math.PI / 180;

    // Leeway: sailing boats slip sideways (leeward) under sail pressure.
    // Proportional to heel angle — more heel = more sideways drift.
    // On port tack the wind pushes to starboard (+cos/−sin in world space).
    const heelMag     = Math.abs(eff) * Math.abs(this.speed / this.physics.maxSpeed) * 12;
    const leewayDeg   = heelMag * 0.28;        // max ~3.4° leeway at full speed/heel
    const leewayRad   = leewayDeg * Math.PI / 180;
    const leewaySign  = isPortTack ? 1 : -1;   // push to starboard on port tack
    const lwyX = Math.cos(hr) * leewaySign * Math.abs(this.speed) * leewayRad * dt * this.TRAVEL_SCALE;
    const lwyZ = -Math.sin(hr) * leewaySign * Math.abs(this.speed) * leewayRad * dt * this.TRAVEL_SCALE;

    let newX = this.x + Math.sin(hr) * this.speed * dt * this.TRAVEL_SCALE + lwyX;
    let newZ = this.z + Math.cos(hr) * this.speed * dt * this.TRAVEL_SCALE + lwyZ;

    // Anchor tether: clamp travel to a small radius around the drop point so the boat
    // can sail/drift only a metre or two before the rode snubs taut, then halts. The boat
    // is free to swing on the rode (heading unchanged here), it just can't drift away.
    if (this.isAnchored) {
      const dx = newX - this.anchorX, dz = newZ - this.anchorZ;
      const d  = Math.hypot(dx, dz);
      if (d > this.ANCHOR_RADIUS) {
        newX = this.anchorX + (dx / d) * this.ANCHOR_RADIUS;
        newZ = this.anchorZ + (dz / d) * this.ANCHOR_RADIUS;
        this.speed = 0;
      }
    }

    // Block when the HULL (bow when moving ahead, stern when reversing) — not just
    // the centre — would touch land, so the ship halts at the shoreline instead of
    // burying its bow inside the island. dirSign follows the direction of travel.
    const dirSign = this.speed >= 0 ? 1 : -1;
    if (this.hullHitsLand(newX, newZ, hr, dirSign) ||
        this.terrainService.isOnLand(newX, newZ)) {
      // ── Movement is blocked — ship cannot enter land ─────────────────────
      this.speed = 0;

      // Accumulate contact time.  Only declare "aground" once the ship has
      // been pinned for GROUNDED_DELAY seconds — this lets players scrape a
      // headland or back off a beach without triggering the overlay.
      this.groundedTime += dt;
      if (!this.isGrounded && this.groundedTime >= this.GROUNDED_DELAY) {
        this.isGrounded = true;
        this.grounded.set(true);
      }
    } else {
      this.x = newX;
      this.z = newZ;
      // Any free movement resets the contact timer and clears the aground flag.
      this.groundedTime = 0;
      if (this.isGrounded) {
        this.isGrounded = false;
        this.grounded.set(false);
      }
    }

    // Wake trail
    this.updateWake();

    // Heel angle (leeward lean from wind pressure on sails)
    // heelMag was already computed above for leeway — reuse it.
    const heelAngle = (isPortTack ? 1 : -1) * heelMag;

    // Update root transform
    this.root.position.x = this.x;
    this.root.position.z = this.z;
    this.root.rotation.y = this.heading * Math.PI / 180;

    this.updateWaterShadow();

    // ── Buoyancy: 8-point hull sampling + wave slope physics ──────────────────
    // VesselBuoyancyService samples OceanService.getVisualHeightAt() — a CPU
    // port of the GPU vertex shader's waveHeight() — so the physics height
    // matches the rendered surface exactly.
    const t    = this.simTime;
    const buoy = this.buoyancyService.update(this.x, this.z, hr, t, dt);

    // Wave surfing: wave slope makes the boat go faster downhill, slower uphill.
    // Blended gently so it's a subtle 0–30% nudge, not a jarring step-change.
    const modTarget = Math.max(-1.5, Math.min(this.physics.maxSpeed,
      baseTarget * (1 + buoy.speedModifier),
    ));
    this.speed += (modTarget - this.speed) * this.physics.accelerationRate * dt * 0.3;

    // Cross-wave broaching bias + slow sea-state wander: only active when the
    // player is not steering. buoy.steeringBias is the fast wave-to-wave jostle
    // (zero-mean, oscillates). On top we add a slow, low-frequency wander so the
    // confused sea gradually nudges the boat off course over ~tens of seconds,
    // requiring the occasional correction. Both scale with sea roughness, so calm
    // water barely moves the bow while rough seas need more frequent attention.
    if (!this.keys.left && !this.keys.right) {
      const roughT = Math.min(1, this.currentSea.choppiness * 0.7 + this.currentSea.waveHeight / 4.0);
      const wander = Math.sin(t * 0.08 + 1.3) + 0.5 * Math.sin(t * 0.19 + 4.1);
      const waveYaw = wander * roughT * 0.6;   // °/s slow drift
      this.heading = ((this.heading + (buoy.steeringBias + waveYaw) * dt) + 360) % 360;
    }

    // FLOAT_DRAFT: vertical offset so the hull sits correctly in the water. The rigged
    // model's origin is authored AT the waterline (midships), so 0 sits it right; the old
    // -0.75 was tuned for the previous model and swamped this one. Negative = lower/more draft.
    const FLOAT_DRAFT = 0.0;

    // Cannon recoil: damped lateral roll response driven only by fire impulses.
    const recoilAcc = -this.RECOIL_SPRING * this.recoilRoll - this.RECOIL_DAMPING * this.recoilRollVel;
    this.recoilRollVel += recoilAcc * dt;
    this.recoilRoll += this.recoilRollVel * dt;
    if (this.recoilRoll > this.RECOIL_MAX_ROLL) this.recoilRoll = this.RECOIL_MAX_ROLL;
    if (this.recoilRoll < -this.RECOIL_MAX_ROLL) this.recoilRoll = -this.RECOIL_MAX_ROLL;
    if (Math.abs(this.recoilRoll) < 0.0002 && Math.abs(this.recoilRollVel) < 0.0002) {
      this.recoilRoll = 0;
      this.recoilRollVel = 0;
    }

    // Cannon recoil sway: a damped sideways lurch away from the firing side, layered
    // on top of the sim position so the hull visibly shudders sideways as it fires.
    const swayAcc = -this.RECOIL_SWAY_SPRING * this.recoilSway - this.RECOIL_SWAY_DAMPING * this.recoilSwayVel;
    this.recoilSwayVel += swayAcc * dt;
    this.recoilSway += this.recoilSwayVel * dt;
    if (this.recoilSway >  this.RECOIL_SWAY_MAX) this.recoilSway =  this.RECOIL_SWAY_MAX;
    if (this.recoilSway < -this.RECOIL_SWAY_MAX) this.recoilSway = -this.RECOIL_SWAY_MAX;
    if (Math.abs(this.recoilSway) < 0.0005 && Math.abs(this.recoilSwayVel) < 0.0005) {
      this.recoilSway = 0;
      this.recoilSwayVel = 0;
    }

    // Hit shudder (taking a cannonball): a separate, heavier spring-damper on its own
    // caps, added on top of the firing recoil.
    const hitRollAcc = -this.HIT_SPRING * this.hitRoll - this.HIT_DAMPING * this.hitRollVel;
    this.hitRollVel += hitRollAcc * dt;
    this.hitRoll += this.hitRollVel * dt;
    if (this.hitRoll >  this.HIT_MAX_ROLL) this.hitRoll =  this.HIT_MAX_ROLL;
    if (this.hitRoll < -this.HIT_MAX_ROLL) this.hitRoll = -this.HIT_MAX_ROLL;
    if (Math.abs(this.hitRoll) < 0.0002 && Math.abs(this.hitRollVel) < 0.0002) {
      this.hitRoll = 0; this.hitRollVel = 0;
    }
    const hitSwayAcc = -this.HIT_SPRING * this.hitSway - this.HIT_DAMPING * this.hitSwayVel;
    this.hitSwayVel += hitSwayAcc * dt;
    this.hitSway += this.hitSwayVel * dt;
    if (this.hitSway >  this.HIT_MAX_SWAY) this.hitSway =  this.HIT_MAX_SWAY;
    if (this.hitSway < -this.HIT_MAX_SWAY) this.hitSway = -this.HIT_MAX_SWAY;
    if (Math.abs(this.hitSway) < 0.0005 && Math.abs(this.hitSwayVel) < 0.0005) {
      this.hitSway = 0; this.hitSwayVel = 0;
    }

    // Apply the combined sway (firing recoil + hit shudder) along the hull's beam
    // (starboard) axis, overriding the plain sim position set earlier this frame.
    const totalSway = this.recoilSway + this.hitSway;
    if (totalSway !== 0) {
      const swayHRad = this.heading * Math.PI / 180;
      this.root.position.x = this.x + totalSway * Math.cos(swayHRad);
      this.root.position.z = this.z - totalSway * Math.sin(swayHRad);
    }

    // Anti-sink floor: apply only a gentle (15 %) correction of the floor excess
    // rather than a hard snap-to.  The 0.55 m tolerance already absorbs most
    // momentary corner submersion, so a light blend is enough to prevent the
    // hull from going dramatically underwater without launching it into the air.
    const floorLift    = Math.max(0, buoy.heaveFloor - buoy.heave);
    const heaveApplied = buoy.heave + floorLift * 0.15;
    this.root.position.y = FLOAT_DRAFT + heaveApplied;

    // Combine sailing heel (wind-induced lean) with wave-induced roll.
    // Damage listing: ease toward the tilt implied by our hull state, then layer it on
    // top of wave roll + heel + recoil/hit. roll +stbd-down, pitch +bow-up (buoy convention).
    const list = listingFor(this.combatService.zones());
    this.listRoll  += (list.roll  - this.listRoll)  * 0.04;
    this.listPitch += (list.pitch - this.listPitch) * 0.04;

    this.root.rotation.z = buoy.rollRad + (heelAngle * Math.PI / 180) + this.recoilRoll + this.hitRoll + this.listRoll;
    this.root.rotation.x = buoy.pitchRad + this.listPitch;

    // ── Rigged vessel drive (single GLB: skeleton clips + free bones) ─────────
    if (this.controller) {
      // Yards: brace from square (eased / running, sheet 88°) to fully braced
      // (close-hauled, sheet 5°). Maps the player sheet angle onto the Trim clip.
      const braced = Math.max(0, Math.min(1, (88 - this.sheetAngleDeg) / 83));
      this.controller.setTrim(braced);

      // Boom + gaff: tack-correct leeward swing (same math as the old boom pivot:
      // boom forward at 0° running downwind, swinging athwartship upwind).
      const swingSide = isPortTack ? -1 : 1;
      const swingRad  = swingSide * (this.sheetAngleDeg - 90) * Math.PI / 180;
      this.controller.setBoomSwing(swingRad);

      // Rudder/wheel: from the helm keys; when not steering, mirror the actual yaw
      // (wave wander + momentum) so the rudder isn't frozen amidships.
      let rudder = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      if (rudder === 0) rudder = Math.max(-1, Math.min(1, this.turnRateSmoothed / 20));
      this.controller.setRudder(rudder);

      // Flag + pennant stream downwind, relative to the hull heading (the controller yaws
      // the bones about world-up so it's heel-independent).
      const windLocalRad = (((this.currentWind.fromBearingDeg + 180) % 360) - this.heading) * Math.PI / 180;
      this.controller.idleWind(windLocalRad, Math.min(1.2, this.currentWind.speed / 8), this.simTime);

      // Anchor: lower/raise the dropped side; keep the other stowed.
      this.anchorDeploy += ((this.isAnchored ? 1 : 0) - this.anchorDeploy) * Math.min(1, dt * 2.5);
      this.controller.dropAnchor('S', this.anchorSide === 'S' ? this.anchorDeploy : 0);
      this.controller.dropAnchor('P', this.anchorSide === 'P' ? this.anchorDeploy : 0);

      // Ease trim / boom-swing / furl toward their targets (no teleporting on tack/auto-trim).
      this.controller.tickRig(dt);
    }

    // Actual heading angular velocity (deg/s, shortest arc) — covers steering, wave
    // wander, and buoyancy yaw uniformly. Broadcast so remote clients can curve their
    // dead-reckoning through our turns instead of projecting straight.
    let hDelta = ((this.heading - this.prevHeading + 540) % 360) - 180;
    const turnRate = dt > 0 ? hDelta / dt : 0;
    // Light smoothing so a noisy per-frame value doesn't make remote turns jitter.
    this.turnRateSmoothed += (turnRate - this.turnRateSmoothed) * Math.min(1, dt * 8);
    this.prevHeading = this.heading;

    // Publish state
    this.zone.run(() => {
      this.state.set({
        x: this.x, z: this.z, heading: this.heading, speed: this.speed,
        turnRate: this.turnRateSmoothed,
        sailState: this.sailState, windAngle: angleFromWind, isPortTack, heelAngle,
        sheetAngle:  Math.round(this.sheetAngleDeg),
        trimQuality: this.sailState === 'reefed' ? 1 : this.trimFactor(Math.abs(angleFromWind)),
        anchored: this.isAnchored, anchorSide: this.anchorSide,
      });
    });
  }

  private updateWaterShadow(): void {
    if (!this.waterShadow) return;

    const sun = this.sceneService.scene.lights.find(l => l instanceof DirectionalLight && l.name === 'sun') as DirectionalLight | undefined;
    if (!sun || sun.direction.y >= -0.01) {
      this.waterShadow.setEnabled(false);
      return;
    }

    const sunDir = sun.direction.negate().normalize();
    const shadowDirX = -sunDir.x;
    const shadowDirZ = -sunDir.z;
    const stretch = 1.8 + Math.min(3.5, (1 - Math.max(0, sunDir.y)) * 4.5);
    const offset = 1.5 + Math.min(10, (1 - Math.max(0, sunDir.y)) * 9.0);

    this.waterShadow.setEnabled(true);
    this.waterShadow.position.x = this.x + shadowDirX * offset;
    this.waterShadow.position.z = this.z + shadowDirZ * offset;
    this.waterShadow.position.y = this.oceanService.getWaveHeightAt(this.x, this.z, this.simTime) + 0.06;
    this.waterShadow.scaling.x = stretch * 1.65;
    this.waterShadow.scaling.y = 1.0;
    this.waterShadow.scaling.z = stretch * 1.10;
    this.waterShadow.rotation.y = Math.atan2(shadowDirX, shadowDirZ);
    this.waterShadow.visibility = 0.34 + (1 - Math.max(0, sunDir.y)) * 0.48;
  }

  private updateCamera(dt: number): void {
    const cam = this.sceneService.camera;
    if (!cam) return;

    // Orbit angles — azimuth is relative to vessel heading so the camera
    // stays behind the boat as it turns, but the user can swing it around.
    const azRad   = (this.heading + this.camAzimuth) * Math.PI / 180;
    const elevRad = this.camElevation * Math.PI / 180;

    const targetX = this.x;
    const targetY = 2.5;   // aim at lower-mast level
    const targetZ = this.z;

    const desiredX = targetX - Math.cos(elevRad) * Math.sin(azRad) * this.camDist;
    const desiredZ = targetZ - Math.cos(elevRad) * Math.cos(azRad) * this.camDist;
    const desiredY = targetY + Math.sin(elevRad) * this.camDist;

    // Frame-rate-independent follow. A fixed per-frame fraction (the old 0.08) makes the camera's
    // catch-up speed depend on frame time: with dt swinging 15↔45 ms the look-at orientation steps
    // by uneven amounts each frame. The near scene barely shifts, but the distant volumetric clouds
    // reproject almost entirely from camera ROTATION, so that orientation wobble is amplified into
    // the persistent cloud "jitter". Easing by (1 - e^(-k·dt)) makes the camera cover the same
    // fraction per unit TIME regardless of frame rate — k=5 reproduces the old 0.08 at 60 fps.
    const lerp = this.isDragging ? 1.0 : 1 - Math.exp(-5 * dt);
    cam.position.x += (desiredX - cam.position.x) * lerp;
    cam.position.y += (desiredY - cam.position.y) * lerp;
    cam.position.z += (desiredZ - cam.position.z) * lerp;
    cam.setTarget(new Vector3(targetX, targetY, targetZ));
  }

  private setupCameraInput(): void {
    const scene  = this.sceneService.scene;
    const canvas = this.sceneService.engine.getRenderingCanvas();

    // Use BabylonJS pointer observable — guaranteed to fire even when the scene
    // registers its own internal pointer listeners on the canvas.
    this.pointerObserver = scene.onPointerObservable.add((info) => {
      const ev = info.event as PointerEvent;
      switch (info.type) {
        case PointerEventTypes.POINTERDOWN:
          if (ev.button === 0) {
            this.isDragging = true;
            this.lastMouseX = ev.clientX;
            this.lastMouseY = ev.clientY;
            if (canvas) canvas.style.cursor = 'grabbing';
          }
          break;
        case PointerEventTypes.POINTERMOVE:
          if (this.isDragging) {
            const dx = ev.clientX - this.lastMouseX;
            const dy = ev.clientY - this.lastMouseY;
            this.lastMouseX = ev.clientX;
            this.lastMouseY = ev.clientY;
            this.camAzimuth   += dx * 0.45;
            this.camElevation  = Math.max(-5, Math.min(85, this.camElevation - dy * 0.3));
          }
          break;
        case PointerEventTypes.POINTERUP:
          this.isDragging = false;
          if (canvas) canvas.style.cursor = 'default';
          break;
      }
    });

    // Wheel zoom stays as a DOM event — no BabylonJS interference here.
    if (canvas) {
      this.wheelHandler = (e: WheelEvent) => {
        this.camDist = Math.max(8, Math.min(80, this.camDist + e.deltaY * 0.04));
        e.preventDefault();
      };
      canvas.addEventListener('wheel', this.wheelHandler, { passive: false });
    }
  }

  // ── Input handling ────────────────────────────────────────────────────────

  private stepSail(dir: 1 | -1): void {
    const order: SailState[] = ['reefed', 'topsails', 'full'];
    const next = order[Math.max(0, Math.min(2, order.indexOf(this.sailState) + dir))];
    if (next !== this.sailState) this.setSailState(next);
  }

  private setupInput(): void {
    this.keyHandler = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement) return;
      switch (e.code) {
        case 'ArrowLeft':  case 'KeyA': this.keys.left     = true; break;
        case 'ArrowRight': case 'KeyD': this.keys.right    = true; break;
        case 'KeyQ': this.keys.sheetOut = true;  break;   // ease sheet (sail swings out)
        case 'KeyE': this.keys.sheetIn  = true;  break;   // haul in sheet (sail comes in)
        case 'KeyW': this.stepSail(1);  break;   // step sail up
        case 'KeyS': this.stepSail(-1); break;   // step sail down
        case 'KeyT': {                            // auto-trim: jump to optimal sheet angle
          const curState = this.state();
          const optimal  = this.optimalSheetAngle(Math.abs(curState.windAngle));
          this.sheetAngleDeg = optimal;
          break;
        }
        case 'Digit1': this.setSailState('reefed');   break;
        case 'Digit2': this.setSailState('topsails'); break;
        case 'Digit3': this.setSailState('full');     break;
        case 'KeyP':   this.toggleAnchor();           break;
      }
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
      if (document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement) return;
      switch (e.code) {
        case 'ArrowLeft':  case 'KeyA': this.keys.left     = false; break;
        case 'ArrowRight': case 'KeyD': this.keys.right    = false; break;
        case 'KeyQ': this.keys.sheetOut = false; break;
        case 'KeyE': this.keys.sheetIn  = false; break;
      }
    };
    window.addEventListener('keydown', this.keyHandler);
    window.addEventListener('keyup',   this.keyUpHandler);
  }

  // ── Wake / hull-wash particle systems ────────────────────────────────────

  private buildWake(scene: Scene): void {
    // Shared foam texture: soft radial gradient, slightly wider than tall
    this.wakeTex = new DynamicTexture('wakeFoamTex', { width: 128, height: 128 }, scene, false);
    const ctx    = this.wakeTex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
    grd.addColorStop(0.30, 'rgba(235,248,255,0.82)');
    grd.addColorStop(0.65, 'rgba(210,235,255,0.28)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    this.wakeTex.update();
    this.wakeTex.hasAlpha = true;

    // ── Bow spray ──────────────────────────────────────────────────────────
    // Emits from the bow, particles pushed sideways to form the bow wave.
    this.bowSpray = new ParticleSystem('bowSpray', 400, scene);
    this.bowSpray.particleTexture = this.wakeTex;
    this.bowSpray.emitter    = this.bowEmit;
    this.bowSpray.minEmitBox = new Vector3(-0.4, 0, -0.4);
    this.bowSpray.maxEmitBox = new Vector3( 0.4, 0,  0.4);
    this.bowSpray.color1     = new Color4(1.00, 1.00, 1.00, 0.72);
    this.bowSpray.color2     = new Color4(0.88, 0.95, 1.00, 0.50);
    this.bowSpray.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.bowSpray.minSize     = 0.5;  this.bowSpray.maxSize     = 2.0;
    this.bowSpray.minLifeTime = 0.5;  this.bowSpray.maxLifeTime = 2.0;
    this.bowSpray.minEmitPower = 3;   this.bowSpray.maxEmitPower = 9;
    this.bowSpray.updateSpeed  = 0.016;
    // direction1/direction2 are heading-dependent — set in updateWake each tick
    this.bowSpray.direction1 = new Vector3(-1, 0.6, 0);
    this.bowSpray.direction2 = new Vector3( 1, 0.6, 0);
    this.bowSpray.gravity    = new Vector3(0, -2.0, 0);
    this.bowSpray.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.bowSpray.emitRate   = 0;
    this.bowSpray.start();

    // ── Stern foam (long-life wake V-trail) ────────────────────────────────
    // Low velocity so particles stay roughly where spawned; the moving boat
    // leaves them behind, naturally building a long V-shaped foam trail.
    this.sternFoam = new ParticleSystem('sternFoam', 900, scene);
    this.sternFoam.particleTexture = this.wakeTex;
    this.sternFoam.emitter    = this.sternEmit;
    this.sternFoam.minEmitBox = new Vector3(-1.0, 0, -0.5);
    this.sternFoam.maxEmitBox = new Vector3( 1.0, 0,  0.5);
    this.sternFoam.color1     = new Color4(1.00, 1.00, 1.00, 0.60);
    this.sternFoam.color2     = new Color4(0.85, 0.94, 1.00, 0.38);
    this.sternFoam.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.sternFoam.minSize     = 1.0;  this.sternFoam.maxSize     = 3.5;
    this.sternFoam.minLifeTime = 5.0;  this.sternFoam.maxLifeTime = 14.0;
    this.sternFoam.minEmitPower = 1.0; this.sternFoam.maxEmitPower = 4.0;
    this.sternFoam.updateSpeed  = 0.016;
    this.sternFoam.direction1 = new Vector3(-1, 0, -1);
    this.sternFoam.direction2 = new Vector3( 1, 0,  1);
    this.sternFoam.gravity    = Vector3.Zero();
    this.sternFoam.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.sternFoam.emitRate   = 0;
    this.sternFoam.start();

    // ── Port hull froth ────────────────────────────────────────────────────
    this.portFroth = new ParticleSystem('portFroth', 300, scene);
    this.portFroth.particleTexture = this.wakeTex;
    this.portFroth.emitter    = this.portEmit;
    this.portFroth.minEmitBox = new Vector3(-0.3, 0, -1.5);
    this.portFroth.maxEmitBox = new Vector3( 0.3, 0,  1.5);
    this.portFroth.color1     = new Color4(1.00, 1.00, 1.00, 0.55);
    this.portFroth.color2     = new Color4(0.90, 0.96, 1.00, 0.30);
    this.portFroth.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.portFroth.minSize     = 0.3;  this.portFroth.maxSize     = 1.2;
    this.portFroth.minLifeTime = 0.5;  this.portFroth.maxLifeTime = 2.5;
    this.portFroth.minEmitPower = 2;   this.portFroth.maxEmitPower = 6;
    this.portFroth.updateSpeed  = 0.016;
    this.portFroth.direction1 = new Vector3(-1, 0.1, 0);
    this.portFroth.direction2 = new Vector3(-3, 0.2, 0);
    this.portFroth.gravity    = new Vector3(0, -0.3, 0);
    this.portFroth.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.portFroth.emitRate   = 0;
    this.portFroth.start();

    // ── Stbd hull froth ────────────────────────────────────────────────────
    this.stbdFroth = new ParticleSystem('stbdFroth', 300, scene);
    this.stbdFroth.particleTexture = this.wakeTex;
    this.stbdFroth.emitter    = this.stbdEmit;
    this.stbdFroth.minEmitBox = new Vector3(-0.3, 0, -1.5);
    this.stbdFroth.maxEmitBox = new Vector3( 0.3, 0,  1.5);
    this.stbdFroth.color1     = new Color4(1.00, 1.00, 1.00, 0.55);
    this.stbdFroth.color2     = new Color4(0.90, 0.96, 1.00, 0.30);
    this.stbdFroth.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.stbdFroth.minSize     = 0.3;  this.stbdFroth.maxSize     = 1.2;
    this.stbdFroth.minLifeTime = 0.5;  this.stbdFroth.maxLifeTime = 2.5;
    this.stbdFroth.minEmitPower = 2;   this.stbdFroth.maxEmitPower = 6;
    this.stbdFroth.updateSpeed  = 0.016;
    this.stbdFroth.direction1 = new Vector3(1, 0.1, 0);
    this.stbdFroth.direction2 = new Vector3(3, 0.2, 0);
    this.stbdFroth.gravity    = new Vector3(0, -0.3, 0);
    this.stbdFroth.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.stbdFroth.emitRate   = 0;
    this.stbdFroth.start();
  }

  private resetWake(): void {
    // Snap emitters to current position so old particles don't linger in the wrong place
    this.updateWake();
  }

  private updateWake(): void {
    const absSpeed = Math.abs(this.speed);
    const hdgR     = this.heading * Math.PI / 180;

    // Forward unit vector (direction the bow points)
    const fwdX =  Math.sin(hdgR);
    const fwdZ =  Math.cos(hdgR);
    // Right unit vector (starboard side)
    const rgtX =  Math.cos(hdgR);
    const rgtZ = -Math.sin(hdgR);

    // Approximate hull geometry (world units)
    const halfLen = 7.0;   // bow/stern offset from vessel centre
    const halfBm  = 2.2;   // half-beam (port/stbd offset)
    const Y       = this.WAKE_Y;

    // ── Reposition emitters ──────────────────────────────────────────────
    this.bowEmit.set(
      this.x + fwdX * halfLen,
      Y,
      this.z + fwdZ * halfLen,
    );
    this.sternEmit.set(
      this.x - fwdX * halfLen,
      Y,
      this.z - fwdZ * halfLen,
    );
    this.portEmit.set(
      this.x - rgtX * halfBm,
      Y,
      this.z - rgtZ * halfBm,
    );
    this.stbdEmit.set(
      this.x + rgtX * halfBm,
      Y,
      this.z + rgtZ * halfBm,
    );

    // ── Speed fraction — drives emit rates, sizes, and vertical spray height ─
    const moving = absSpeed > 0.3;
    const sf     = moving ? Math.min(1, absSpeed / this.physics.maxSpeed) : 0;

    // ── Heading-dependent direction vectors ───────────────────────────────
    // Bow: spray sideways + upward — Y scales with speed for dramatic high-speed plumes
    const bowY = 0.5 + sf * 0.9;
    this.bowSpray.direction1.set(-rgtX * 4 - fwdX, bowY, -rgtZ * 4 - fwdZ);
    this.bowSpray.direction2.set( rgtX * 4 - fwdX, bowY,  rgtZ * 4 - fwdZ);

    // Stern: spread sideways and slightly aft; long-lifetime particles form the V
    this.sternFoam.direction1.set(-fwdX * 2 - rgtX * 4, 0, -fwdZ * 2 - rgtZ * 4);
    this.sternFoam.direction2.set(-fwdX * 2 + rgtX * 4, 0, -fwdZ * 2 + rgtZ * 4);

    // Port: pushed outward to port side
    this.portFroth.direction1.set(-rgtX * 2 - fwdX * 0.5, 0.15, -rgtZ * 2 - fwdZ * 0.5);
    this.portFroth.direction2.set(-rgtX * 4 - fwdX * 0.5, 0.25, -rgtZ * 4 - fwdZ * 0.5);

    // Stbd: pushed outward to starboard side
    this.stbdFroth.direction1.set( rgtX * 2 - fwdX * 0.5, 0.15,  rgtZ * 2 - fwdZ * 0.5);
    this.stbdFroth.direction2.set( rgtX * 4 - fwdX * 0.5, 0.25,  rgtZ * 4 - fwdZ * 0.5);

    // ── Emit rates — scale with speed, cut off below threshold ───────────

    const wf = this.WAKE_PARTICLES_ENABLED ? sf : 0;
    this.bowSpray.emitRate  = Math.round(wf * 100);
    this.sternFoam.emitRate = Math.round(wf * 70);
    this.portFroth.emitRate = Math.round(wf * 55);
    this.stbdFroth.emitRate = Math.round(wf * 55);

    // ── Size scales modestly with speed ───────────────────────────────────
    const sizeBoost = sf * 0.6;
    this.bowSpray.maxSize  = 2.0 + sizeBoost;
    this.sternFoam.maxSize = 3.5 + sizeBoost;

    // ── Inform ocean service so wake plane shader knows boat position ──────
    this.oceanService.setBoatTransform(this.x, this.z, hdgR, this.speed);
  }

  // ── PBR material & texture helpers ────────────────────────────────────────

  private getTex(
    scene: Scene,
    key: string,
    factory: () => DynamicTexture,
  ): DynamicTexture {
    if (!this.texPool.has(key)) this.texPool.set(key, factory());
    return this.texPool.get(key)!;
  }

  /** Minimal seeded LCG — deterministic per texture name so grain is stable across reloads. */
  private makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  /**
   * Procedural wood-grain albedo texture (256 × 256).
   * Uses bezier curves for bold plank lines plus a fine-grain overlay.
   */
  private makeWoodAlbedo(
    scene: Scene,
    name: string,
    baseRgb: [number, number, number],
    darkRgb: [number, number, number],
    grainCount: number,
  ): DynamicTexture {
    const SZ  = 256;
    const tex = new DynamicTexture(name, { width: SZ, height: SZ }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const [br, bg, bb] = baseRgb;
    const [dr, dg, db] = darkRgb;

    ctx.fillStyle = `rgb(${br},${bg},${bb})`;
    ctx.fillRect(0, 0, SZ, SZ);

    const rng = this.makeRng(name.charCodeAt(0) * 37 + grainCount);

    // Bold grain lines — bezier curves spanning the full texture height
    for (let g = 0; g < grainCount; g++) {
      const x0   = rng() * SZ;
      const x1   = x0 + (rng() - 0.5) * 40;
      const cp1x = x0 + (rng() - 0.5) * 30;
      const cp2x = x1 + (rng() - 0.5) * 30;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(cp1x, SZ * 0.33, cp2x, SZ * 0.67, x1, SZ);
      ctx.strokeStyle = `rgba(${dr},${dg},${db},${(0.4 + rng() * 0.4).toFixed(2)})`;
      ctx.lineWidth   = 0.5 + rng() * 1.5;
      ctx.stroke();
    }

    // Fine-grain overlay — many thin, subtle lines for close-up richness
    for (let g = 0; g < grainCount * 3; g++) {
      const x0 = rng() * SZ;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0 + (rng() - 0.5) * 20, SZ);
      ctx.strokeStyle = `rgba(${dr},${dg},${db},${(0.08 + rng() * 0.12).toFixed(2)})`;
      ctx.lineWidth   = 0.3 + rng() * 0.5;
      ctx.stroke();
    }

    tex.update();
    return tex;
  }

  /**
   * Procedural wood-grain normal map (256 × 256).
   * Encodes groove cross-section profiles as tangent-space normals:
   *   R=128 (X=0), G varies across groove slope, B reduced at groove center.
   */
  private makeWoodNormal(
    scene: Scene,
    name: string,
    grainCount: number,
  ): DynamicTexture {
    const SZ  = 256;
    const tex = new DynamicTexture(name + '_nrm', { width: SZ, height: SZ }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(SZ, SZ);
    const px  = img.data;

    // Seed with flat tangent-space normal: R=128(X=0), G=128(Y=0), B=255(Z=+1)
    for (let i = 0; i < SZ * SZ; i++) {
      px[i * 4 + 0] = 128;
      px[i * 4 + 1] = 128;
      px[i * 4 + 2] = 255;
      px[i * 4 + 3] = 255;
    }

    const rng = this.makeRng(name.charCodeAt(0) * 53 + grainCount + 7);
    for (let g = 0; g < grainCount; g++) {
      const cx   = (rng() * SZ) | 0;
      const half = 1 + Math.round(rng() * 2);   // groove half-width: 1–3 px
      for (let y = 0; y < SZ; y++) {
        const drift = Math.round((rng() - 0.5) * 3);   // slight meander per row
        for (let w = -half; w <= half; w++) {
          const x   = ((cx + drift + w) + SZ) % SZ;
          const t   = w / half;                             // -1 to +1 across groove
          // G encodes cross-groove slope (left wall tilts one way, right the other)
          const gV  = Math.round(128 + 26 * t) & 0xff;
          // B slightly reduced at the groove center (concave shadow)
          const bV  = Math.round(230 + 25 * (t * t)) & 0xff;
          const idx = (y * SZ + x) * 4;
          px[idx + 1] = gV;
          px[idx + 2] = bV;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    tex.update();
    return tex;
  }

  /**
   * Build (or retrieve from cache) the PBR material for a vessel part.
   * Dispatches on `part.materialType`; falls back to a flat-colour PBR for
   * any part that has no materialType annotation.
   */
  private buildVesselMat(part: VesselPart, scene: Scene): PBRMaterial {
    const key = part.materialType ?? ('_hex_' + part.material.color);
    if (this.matPool.has(key)) return this.matPool.get(key)!;

    const m = new PBRMaterial(key + '_mat', scene);
    m.metallic  = 0;
    m.roughness = 0.6;

    switch (part.materialType) {

      case 'wood_hull': {
        const alb = this.getTex(scene, 'wood_hull_alb', () =>
          this.makeWoodAlbedo(scene, 'wood_hull_alb', [59, 34, 18], [26, 10, 5], 14));
        const nrm = this.getTex(scene, 'wood_hull_nrm', () =>
          this.makeWoodNormal(scene, 'wood_hull', 14));
        alb.uScale = 3; alb.vScale = 3;
        nrm.uScale = 3; nrm.vScale = 3;
        nrm.level  = 0.55;   // subtle plank grooves — not deep carving
        m.albedoTexture = alb;
        m.bumpTexture   = nrm;
        m.roughness     = 0.88;
        break;
      }

      case 'wood_teak': {
        const alb = this.getTex(scene, 'wood_teak_alb', () =>
          this.makeWoodAlbedo(scene, 'wood_teak_alb', [155, 120, 32], [94, 62, 10], 10));
        const nrm = this.getTex(scene, 'wood_teak_nrm', () =>
          this.makeWoodNormal(scene, 'wood_teak', 10));
        alb.uScale = 4; alb.vScale = 4;
        nrm.uScale = 4; nrm.vScale = 4;
        nrm.level  = 0.50;
        m.albedoTexture = alb;
        m.bumpTexture   = nrm;
        m.roughness     = 0.78;
        break;
      }

      case 'wood_spar': {
        const alb = this.getTex(scene, 'wood_spar_alb', () =>
          this.makeWoodAlbedo(scene, 'wood_spar_alb', [216, 213, 200], [174, 171, 158], 20));
        const nrm = this.getTex(scene, 'wood_spar_nrm', () =>
          this.makeWoodNormal(scene, 'wood_spar', 20));
        alb.uScale = 2; alb.vScale = 6;
        nrm.uScale = 2; nrm.vScale = 6;
        nrm.level  = 0.45;   // fine grain — varnished spar, not rough plank
        m.albedoTexture = alb;
        m.bumpTexture   = nrm;
        m.roughness     = 0.55;
        break;
      }

      case 'brass':
        m.albedoColor = new Color3(0.78, 0.59, 0.16);
        m.metallic    = 0.80;
        m.roughness   = 0.38;
        break;

      case 'steel':
        m.albedoColor = new Color3(0.78, 0.80, 0.82);
        m.metallic    = 1.0;
        m.roughness   = 0.22;
        break;

      case 'black_metal':
        m.albedoColor = new Color3(0.08, 0.08, 0.08);
        m.metallic    = 0.65;
        m.roughness   = 0.52;
        break;

      case 'paint_white':
        m.albedoColor = new Color3(0.91, 0.91, 0.88);
        m.roughness   = 0.50;
        break;

      case 'paint_cream':
        m.albedoColor = new Color3(0.94, 0.93, 0.85);
        m.roughness   = 0.52;
        break;

      case 'paint_navy':
        m.albedoColor = new Color3(0.10, 0.17, 0.24);
        m.roughness   = 0.45;
        break;

      case 'rubber':
        m.albedoColor = new Color3(0.16, 0.16, 0.16);
        m.roughness   = 0.95;
        break;

      case 'glass':
        m.albedoColor      = new Color3(0.12, 0.14, 0.18);
        m.metallic         = 0.05;
        m.roughness        = 0.04;
        m.alpha            = 0.55;
        m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        break;

      case 'rope':
        m.albedoColor = new Color3(0.78, 0.66, 0.42);
        m.roughness   = 0.92;
        break;

      case 'nav_red':
        m.albedoColor       = new Color3(0.85, 0.08, 0.05);
        m.emissiveColor     = new Color3(0.80, 0.04, 0.02);
        m.emissiveIntensity = 2.0;
        m.roughness         = 0.30;
        break;

      case 'nav_green':
        m.albedoColor       = new Color3(0.05, 0.75, 0.25);
        m.emissiveColor     = new Color3(0.02, 0.50, 0.10);
        m.emissiveIntensity = 2.0;
        m.roughness         = 0.30;
        break;

      case 'nav_white':
        m.albedoColor       = new Color3(1.0, 1.0, 0.94);
        m.emissiveColor     = new Color3(1.0, 1.0, 0.90);
        m.emissiveIntensity = 1.5;
        m.roughness         = 0.30;
        break;

      default:
        // Fallback: read flat colour from part.material (legacy / un-annotated parts)
        m.albedoColor = Color3.FromHexString(part.material.color);
        if (part.material.alpha !== undefined) {
          m.alpha            = part.material.alpha;
          m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        }
        if (part.material.emissive !== undefined) {
          m.emissiveColor     = Color3.FromHexString(part.material.emissive);
          m.emissiveIntensity = 1.5;
        }
        break;
    }

    this.matPool.set(key, m);
    return m;
  }

  getPosition(): { x: number; z: number } {
    return { x: this.x, z: this.z };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('keyup',   this.keyUpHandler);
    if (this.pointerObserver) {
      this.sceneService.scene?.onPointerObservable.remove(this.pointerObserver);
    }
    const canvas = this.sceneService.engine?.getRenderingCanvas();
    if (canvas && this.wheelHandler) {
      canvas.removeEventListener('wheel', this.wheelHandler as EventListener);
    }
    this.controller?.dispose();
    this.controller = null;
    for (const ps of [this.bowSpray, this.sternFoam, this.portFroth, this.stbdFroth]) {
      ps?.stop(); ps?.dispose();
    }
    this.wakeTex?.dispose();

    // Drain PBR pools before disposing the root so meshes don't try to
    // auto-dispose shared materials a second time via root.dispose(false, false).
    this.matPool.forEach(mat => mat.dispose());
    this.matPool.clear();
    this.texPool.forEach(tex => tex.dispose());
    this.texPool.clear();

    // Dispose all child meshes/lights; skip material auto-dispose (done above).
    this.root?.dispose(false, false);
  }
}
