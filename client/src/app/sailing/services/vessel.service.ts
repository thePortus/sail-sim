import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  MeshBuilder, Vector3, Color3, Color4, StandardMaterial, PBRMaterial, Mesh,
  TransformNode, DynamicTexture, ParticleSystem, Scene, PointerEventTypes, PointLight,
  VertexBuffer,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { IslandService } from './island.service';
import { OceanService }  from './ocean.service';
import { VesselBuoyancyService } from './vessel-buoyancy.service';
import { Vessel, VesselPart, SailState, Wind, SeaConditions, VesselState, VesselPhysics } from '../models';

@Injectable({ providedIn: 'root' })
export class VesselService {
  private sceneService     = inject(SceneService);
  private islandService    = inject(IslandService);
  private oceanService     = inject(OceanService);
  private buoyancyService  = inject(VesselBuoyancyService);
  private zone             = inject(NgZone);

  // ── Public reactive state ─────────────────────────────────────────────────
  grounded = signal<boolean>(false);

  state = signal<VesselState>({
    x: 7200, z: 0, heading: 270, speed: 0,
    sailState: 'reefed', windAngle: 90, isPortTack: false, heelAngle: 0,
    sheetAngle: 30, trimQuality: 1,
  });

  // ── Physics ────────────────────────────────────────────────────────────────
  private x          = 7200;
  private z          = 0;
  private heading    = 270;   // compass bearing 0=N(+Z) 90=E(+X)
  private speed      = 0;
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
  private mainSailPivot: TransformNode | null = null;
  private jibPivot:      TransformNode | null = null;
  private mainSailMesh:  Mesh | null = null;
  private jibMesh:       Mesh | null = null;

  // ── PBR material / texture pools ─────────────────────────────────────────
  private matPool         = new Map<string, PBRMaterial>();
  private texPool         = new Map<string, DynamicTexture>();

  // ── Torches ───────────────────────────────────────────────────────────────
  private torchLights:    PointLight[]         = [];
  private torchFlameMats: StandardMaterial[]   = [];
  private torchSconceMats: StandardMaterial[]  = [];

  // ── Cannon recoil ────────────────────────────────────────────────────────
  // addCannonRecoil() is called by CannonService on every broadside.
  // A decaying sinusoidal impulse is added to the vessel's heave and pitch
  // for RECOIL_DUR seconds, giving the "ship kicks back" feel.
  private recoilRemaining = 0;
  private readonly RECOIL_DUR = 1.8;   // seconds of oscillation

  addCannonRecoil(): void {
    this.recoilRemaining = this.RECOIL_DUR;
  }

  // ── Sheet (sail trim) ─────────────────────────────────────────────────────
  // sheetAngleDeg: degrees from the boat's centreline the boom swings out.
  //   5 = close-hauled (sail sheeted hard in)
  //  88 = fully eased (sail right out, running downwind)
  // The player adjusts with Q (ease) / E (haul in).
  private sheetAngleDeg = 30;    // sensible default for a reaching start

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
  private readonly TRAVEL_SCALE = 10.0;

  // ── Wake / hull-wash particle systems ────────────────────────────────────
  // Four ParticleSystems share one foam texture and use plain Vector3 emitters
  // that are repositioned every physics tick to follow the hull.  Particles are
  // emitted into world space, so they stay put while the boat moves away from
  // them — this naturally builds up a V-shaped foam trail behind the vessel.

  private readonly WAKE_Y = 0.30;          // at the waterline — slightly above wave trough

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
  init(vessel: Vessel, spawnX: number, spawnZ: number, spawnHeading = 270): void {
    this.x       = spawnX;
    this.z       = spawnZ;
    this.heading = spawnHeading;
    if (vessel.physics) Object.assign(this.physics, vessel.physics);

    const { scene } = this.sceneService;
    // Group 2 renders after ocean (groups 0+1) but keeps the ocean's depth values
    // so the wave surface correctly occludes submerged hull geometry.
    scene.setRenderingAutoClearDepthStencil(2, false);
    this.buildMesh(vessel, scene);
    this.setupInput();
    this.setupCameraInput();
    this.startLoop(scene);
  }

  // ─────────────────────────────────────────────────────────────────────────
  private buildMesh(vessel: Vessel, scene: Scene): void {
    this.root = new TransformNode('vessel_root', scene);
    this.root.position = new Vector3(this.x, 0, this.z);
    this.root.rotation.y = this.heading * Math.PI / 180;

    // Build structural parts
    for (const part of vessel.parts) {
      this.createPart(part, scene);
    }

    // Build sails (animated, so handled separately)
    this.buildSails(scene);
    this.updateSailMeshes();

    // Build torches after root is set up so they can be parented
    this.buildTorches(scene);

    // Build wake trail (world-space, not parented to root)
    this.buildWake(scene);

    // Register every hull / rig / sail mesh with the WaterMaterial so it appears
    // in both the reflection RTT (mirror of the above-water hull in the surface)
    // and the refraction RTT (the submerged hull visible through the water).
    for (const mesh of this.root.getChildMeshes()) {
      this.oceanService.addToRenderList(mesh);
    }
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

  // ── Torches ───────────────────────────────────────────────────────────────
  // Two oil torches on the stern rail uprights — each a sconce + flame sphere + PointLight.
  // All meshes and lights are parented to this.root so they track the vessel.

  private buildTorches(scene: Scene): void {
    const torchPositions = [
      { x: -1.55, y: 2.26, z: -5.4 },  // port stern rail cap
      { x:  1.55, y: 2.26, z: -5.4 },  // stbd stern rail cap
    ];

    for (let i = 0; i < torchPositions.length; i++) {
      const pos = torchPositions[i];

      // Sconce bracket (small dark cylinder, like an iron bracket)
      const sconce = MeshBuilder.CreateCylinder(`torch_sconce_${i}`, {
        diameter: 0.12, height: 0.32, tessellation: 8,
      }, scene);
      sconce.parent           = this.root;
      sconce.renderingGroupId = 2;
      sconce.position = new Vector3(pos.x, pos.y, pos.z);
      const sconceMat = new StandardMaterial(`torch_sconce_mat_${i}`, scene);
      sconceMat.diffuseColor  = new Color3(0.16, 0.12, 0.10);
      sconceMat.specularColor = new Color3(0.25, 0.20, 0.15);
      sconce.material = sconceMat;
      this.torchSconceMats.push(sconceMat);

      // Flame sphere (emissive orange ball at the top of the sconce)
      const flame = MeshBuilder.CreateSphere(`torch_flame_${i}`, {
        diameter: 0.22, segments: 7,
      }, scene);
      flame.parent           = this.root;
      flame.renderingGroupId = 2;
      flame.position = new Vector3(pos.x, pos.y + 0.30, pos.z);
      const flameMat = new StandardMaterial(`torch_flame_mat_${i}`, scene);
      flameMat.diffuseColor   = new Color3(1.0, 0.55, 0.05);
      flameMat.emissiveColor  = new Color3(1.0, 0.45, 0.02);
      flameMat.disableLighting = false;
      flame.material = flameMat;
      this.torchFlameMats.push(flameMat);

      // PointLight — parented to the vessel root so it moves with the ship
      const light = new PointLight(`torch_light_${i}`, new Vector3(pos.x, pos.y + 0.32, pos.z), scene);
      light.parent    = this.root;
      light.diffuse   = new Color3(1.0, 0.55, 0.15);
      light.specular  = new Color3(0.6, 0.30, 0.05);
      light.intensity = 0.85;
      light.range     = 9;
      this.torchLights.push(light);
    }
  }

  private buildSails(scene: Scene): void {
    const mastX   = 0,   mastZ   = 1.5;
    const mastTopY = 15.1;
    const boomY    = 1.76;   // matches gooseneck height in vessel data
    const boomLen  = 7.8;    // boom cylinder height (mast to end)

    // ── Main sail pivot ───────────────────────────────────────────────────
    this.mainSailPivot = new TransformNode('main_sail_pivot', scene);
    this.mainSailPivot.parent   = this.root;
    this.mainSailPivot.position = new Vector3(mastX, 0, mastZ);

    // ── Boom assembly — parented to pivot so it swings with the sail ─────
    // All positions in pivot-local space (subtract pivot world offset z=1.5 from
    // any root-local z, since the pivot is at root-local (0,0,1.5)).
    {
      const sparMat  = this.buildVesselMat(
        { id:'boom_dyn', shape:'cylinder', params:{}, position:{x:0,y:0,z:0},
          materialType:'wood_spar', material:{color:'#D8D5C8'} }, scene);
      const steelMat = this.buildVesselMat(
        { id:'steel_boom', shape:'torus', params:{}, position:{x:0,y:0,z:0},
          materialType:'steel', material:{color:'#AAAAAA'} }, scene);
      const brassMat = this.buildVesselMat(
        { id:'brass_gooseneck', shape:'cylinder', params:{}, position:{x:0,y:0,z:0},
          materialType:'brass', material:{color:'#C8962A'} }, scene);

      // Gooseneck — at pivot origin (z_local=0 = z_world=1.5=mast)
      const gooseneck = MeshBuilder.CreateCylinder('gooseneck_dyn',
        { diameter:0.30, height:0.26, tessellation:12 }, scene);
      gooseneck.parent = this.mainSailPivot;
      gooseneck.position = new Vector3(0, boomY, 0);
      gooseneck.rotation = new Vector3(Math.PI / 2, 0, 0);
      gooseneck.renderingGroupId = 2;
      gooseneck.material = brassMat;

      // Boom cylinder — z_local = -2.4 - 1.5 = -3.9 (centre of 7.8m cylinder)
      const boom = MeshBuilder.CreateCylinder('boom_dyn',
        { diameter:0.13, height:boomLen, tessellation:8 }, scene);
      boom.parent = this.mainSailPivot;
      boom.position = new Vector3(0, boomY, -3.9);
      boom.rotation = new Vector3(Math.PI / 2, 0, 0);
      boom.renderingGroupId = 2;
      boom.material = sparMat;

      // Boom end cap — z_local = -6.32 - 1.5 = -7.82
      const boomEnd = MeshBuilder.CreateSphere('boom_end_dyn',
        { diameter:0.22, segments:10 }, scene);
      boomEnd.parent = this.mainSailPivot;
      boomEnd.position = new Vector3(0, boomY, -7.82);
      boomEnd.renderingGroupId = 2;
      boomEnd.material = sparMat;

      // Mainsheet block — z_local = -6.28 - 1.5 = -7.78
      const boomBlock = MeshBuilder.CreateTorus('boom_block_dyn',
        { diameter:0.24, thickness:0.05, tessellation:12 }, scene);
      boomBlock.parent = this.mainSailPivot;
      boomBlock.position = new Vector3(0, boomY - 0.18, -7.78);
      boomBlock.renderingGroupId = 2;
      boomBlock.material = steelMat;
    }

    // ── Multi-path mainsail (5 chord stations, 24 height segs) ───────────
    // Paths run foot→head; 5 paths sweep luff(mast)→leech(free edge).
    // Parabolic belly: sin(u·π) profile across chord, sin(t·π) scaling
    // along span — fullest in mid-sail, tapers at foot and head.
    const CHORD  = 5;
    const SEGS   = 24;
    const DRAFT  = 0.11;   // max belly as fraction of local chord width

    const mainPaths: Vector3[][] = [];
    for (let ci = 0; ci < CHORD; ci++) {
      const u    = ci / (CHORD - 1);   // 0 = luff, 1 = leech
      const path: Vector3[] = [];
      for (let i = 0; i <= SEGS; i++) {
        const t      = i / SEGS;
        const y      = boomY + t * (mastTopY - boomY);
        const zLeech = -(boomLen * (1 - t * 0.22));   // leech z at this height
        const z      = u * zLeech;                     // chord-station z
        const chord  = Math.abs(zLeech);
        // Belly: parabolic across chord, sinusoidal along span
        const bellyCross = Math.sin(u * Math.PI);
        const bellySpan  = 0.55 + 0.45 * Math.sin(t * Math.PI);
        const x          = bellyCross * bellySpan * chord * DRAFT;
        path.push(new Vector3(x, y, z));
      }
      mainPaths.push(path);
    }

    this.mainSailMesh = MeshBuilder.CreateRibbon('mainsail', {
      pathArray: mainPaths, sideOrientation: Mesh.DOUBLESIDE, updatable: true,
    }, scene);
    this.mainSailMesh.parent           = this.mainSailPivot;
    this.mainSailMesh.renderingGroupId = 2;
    // Bake UVs by path/vertex index so threads scale physically uniformly.
    // 3 tiles luff→leech × 5 tiles foot→head keeps canvas threads near-square.
    this.bakeRibbonUVs(this.mainSailMesh, CHORD, SEGS, 3, 5);
    this.mainSailMesh.material = this.buildCanvasMat(scene);

    // ── Jib (pivot at forestay tack near bow) ─────────────────────────────
    const jibBaseZ = 7.0;
    const jibTopY  = mastTopY - 1.0;
    this.jibPivot  = new TransformNode('jib_pivot', scene);
    this.jibPivot.parent   = this.root;
    this.jibPivot.position = new Vector3(0, 0, jibBaseZ);

    // 4 chord paths × 16 height segs — gentler belly than mainsail
    const J_CHORD = 4;
    const J_SEGS  = 16;
    const J_DRAFT = 0.09;
    const span     = jibBaseZ - mastZ;   // = 5.5 units (forestay length projected)

    const jibPaths: Vector3[][] = [];
    for (let ci = 0; ci < J_CHORD; ci++) {
      const u    = ci / (J_CHORD - 1);
      const path: Vector3[] = [];
      for (let i = 0; i <= J_SEGS; i++) {
        const t    = i / J_SEGS;
        const y    = 1.5 + t * (jibTopY - 1.5);
        const zL   = -t * span;                          // luff z (along forestay)
        const zLe  = -span * t + zL * 0.3;              // leech z
        const z    = zL + u * (zLe - zL);               // interpolated z
        const chord = Math.abs(zLe - zL);
        const bellyCross = Math.sin(u * Math.PI);
        const bellySpan  = 0.45 + 0.55 * Math.sin(t * Math.PI);
        const x    = bellyCross * bellySpan * chord * J_DRAFT;
        path.push(new Vector3(x, y, z));
      }
      jibPaths.push(path);
    }

    this.jibMesh = MeshBuilder.CreateRibbon('jib', {
      pathArray: jibPaths, sideOrientation: Mesh.DOUBLESIDE, updatable: true,
    }, scene);
    this.jibMesh.parent           = this.jibPivot;
    this.jibMesh.renderingGroupId = 2;
    this.bakeRibbonUVs(this.jibMesh, J_CHORD, J_SEGS, 2, 3);
    this.jibMesh.material = this.buildCanvasMat(scene);
  }

  // ── Sail state ────────────────────────────────────────────────────────────

  setSailState(state: SailState): void {
    this.sailState = state;
    this.updateSailMeshes();
  }

  // ── Refloat ───────────────────────────────────────────────────────────────
  // Teleports the vessel to the spawn point of the nearest island, furls sails,
  // resets speed, and clears the grounded flag.

  refloat(): void {
    const { spawnX, spawnZ } = this.islandService.nearestIslandSpawn(this.x, this.z);
    this.x       = spawnX;
    this.z       = spawnZ;
    this.speed   = 0;
    this.heading = 270;   // face west (out to sea) — sensible default
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

  private updateSailMeshes(): void {
    if (!this.mainSailMesh || !this.jibMesh) return;
    switch (this.sailState) {
      case 'reefed':
        // Hide both sails completely — a squished mesh looks wrong at the mast foot
        this.mainSailMesh.setEnabled(false);
        this.jibMesh.setEnabled(false);
        break;
      case 'topsails':
        this.mainSailMesh.setEnabled(true);
        this.mainSailMesh.scaling.y = 0.5;
        this.jibMesh.setEnabled(true);
        this.jibMesh.scaling.y = 0.5;
        break;
      case 'full':
        this.mainSailMesh.setEnabled(true);
        this.mainSailMesh.scaling.y = 1.0;
        this.jibMesh.setEnabled(true);
        this.jibMesh.scaling.y = 1.0;
        break;
    }
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
      this.updateCamera();
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

    const newX = this.x + Math.sin(hr) * this.speed * dt * this.TRAVEL_SCALE + lwyX;
    const newZ = this.z + Math.cos(hr) * this.speed * dt * this.TRAVEL_SCALE + lwyZ;

    if (this.islandService.isOnLand(newX, newZ)) {
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

    // Cross-wave broaching bias: only active when player is not steering.
    if (!this.keys.left && !this.keys.right) {
      this.heading = ((this.heading + buoy.steeringBias * dt) + 360) % 360;
    }

    // FLOAT_DRAFT: small fixed freeboard so the waterline sits at deck level in
    // perfectly flat water (corrects for any systematic offset in the wave model).
    const FLOAT_DRAFT = 0.05;

    // Cannon recoil: brief decaying heave + pitch oscillation after a broadside.
    let recoilY = 0, recoilPitchR = 0;
    if (this.recoilRemaining > 0) {
      this.recoilRemaining = Math.max(0, this.recoilRemaining - dt);
      const env  = this.recoilRemaining / this.RECOIL_DUR;          // 1 → 0
      const osc  = Math.sin(env * this.RECOIL_DUR * Math.PI * 3.5); // ~3 oscillations
      recoilY      = env * osc * 0.20;      // ±20 cm heave
      recoilPitchR = env * osc * 0.038;     // ±2.2° fore-aft pitch
    }

    // Anti-sink floor: apply only a gentle (15 %) correction of the floor excess
    // rather than a hard snap-to.  The 0.55 m tolerance already absorbs most
    // momentary corner submersion, so a light blend is enough to prevent the
    // hull from going dramatically underwater without launching it into the air.
    const floorLift    = Math.max(0, buoy.heaveFloor - buoy.heave);
    const heaveApplied = buoy.heave + floorLift * 0.15;
    this.root.position.y = FLOAT_DRAFT + heaveApplied + recoilY;

    // Combine sailing heel (wind-induced lean) with wave-induced roll.
    this.root.rotation.z = buoy.rollRad  + (heelAngle * Math.PI / 180);
    this.root.rotation.x = buoy.pitchRad + recoilPitchR;

    // Sail rotation — driven by the player-controlled sheet angle
    const swingDeg  = this.sheetAngleDeg;
    const swingSide = isPortTack ? -1 : 1;
    if (this.mainSailPivot) this.mainSailPivot.rotation.y = swingSide * swingDeg * Math.PI / 180;
    if (this.jibPivot)      this.jibPivot.rotation.y      = swingSide * swingDeg * 0.7 * Math.PI / 180;

    // Torch flicker — multi-frequency sine waves + small random noise
    if (this.torchLights.length > 0) {
      for (let i = 0; i < this.torchLights.length; i++) {
        const offset = i * 2.73;
        const flicker =
          Math.sin(t * 9.1  + offset)       * 0.14 +
          Math.sin(t * 17.3 + offset * 1.7) * 0.07 +
          Math.sin(t * 31.7 + offset * 3.1) * 0.04 +
          (Math.random() - 0.5)              * 0.07;
        const intensity = Math.max(0.45, 0.85 + flicker);
        this.torchLights[i].intensity = intensity;
        if (this.torchFlameMats[i]) {
          // Shift emissive between deep orange and bright yellow-orange
          const b = 0.35 + flicker * 0.4;
          this.torchFlameMats[i].emissiveColor.set(1.0, Math.max(0.3, 0.45 + b), Math.max(0, b * 0.3));
        }
      }
    }

    // Publish state
    this.zone.run(() => {
      this.state.set({
        x: this.x, z: this.z, heading: this.heading, speed: this.speed,
        sailState: this.sailState, windAngle: angleFromWind, isPortTack, heelAngle,
        sheetAngle:  Math.round(this.sheetAngleDeg),
        trimQuality: this.sailState === 'reefed' ? 1 : this.trimFactor(Math.abs(angleFromWind)),
      });
    });
  }

  private updateCamera(): void {
    const cam = this.sceneService.camera;
    if (!cam) return;

    // Orbit angles — azimuth is relative to vessel heading so the camera
    // stays behind the boat as it turns, but the user can swing it around.
    const azRad   = (this.heading + this.camAzimuth) * Math.PI / 180;
    const elevRad = this.camElevation * Math.PI / 180;

    const targetX = this.x;
    const targetY = 1.2;   // aim at cabin/lower-mast level — hull is now lower in the water
    const targetZ = this.z;

    const desiredX = targetX - Math.cos(elevRad) * Math.sin(azRad) * this.camDist;
    const desiredZ = targetZ - Math.cos(elevRad) * Math.cos(azRad) * this.camDist;
    const desiredY = targetY + Math.sin(elevRad) * this.camDist;

    const lerp = this.isDragging ? 1.0 : 0.08;  // snap instantly while dragging
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
            this.camElevation  = Math.max(4, Math.min(85, this.camElevation - dy * 0.3));
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
      }
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
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

    this.bowSpray.emitRate  = Math.round(sf * 100);
    this.sternFoam.emitRate = Math.round(sf * 70);
    this.portFroth.emitRate = Math.round(sf * 55);
    this.stbdFroth.emitRate = Math.round(sf * 55);

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
   * Procedural canvas-weave albedo (128 × 128).
   * Alternating warp/weft threads using a cosine cross-section profile.
   */
  private makeCanvasAlbedo(scene: Scene, name: string): DynamicTexture {
    const SZ  = 128;
    const S   = 8;   // thread pitch in pixels
    const tex = new DynamicTexture(name, { width: SZ, height: SZ }, scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(SZ, SZ);
    const px  = img.data;

    for (let y = 0; y < SZ; y++) {
      const rowPhase = Math.floor(y / S) % 2;
      for (let x = 0; x < SZ; x++) {
        const colPhase = Math.floor(x / S) % 2;
        const ty   = (y % S) / S;
        const tx   = (x % S) / S;
        const over = (colPhase === rowPhase);   // this thread is on top
        // Cosine cross-section: raised in the centre, tapered at edges
        const prof = over
          ? 0.5 + 0.5 * Math.cos((tx - 0.5) * Math.PI * 2)
          : 0.3 + 0.4 * Math.cos((ty - 0.5) * Math.PI * 2);
        const base = over ? 230 : 215;
        const val  = Math.round(base - prof * 30);
        const idx  = (y * SZ + x) * 4;
        px[idx + 0] = Math.min(255, val + 15);   // warm off-white
        px[idx + 1] = Math.min(255, val + 8);
        px[idx + 2] = Math.max(0,   val - 10);
        px[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    tex.update();
    return tex;
  }

  /**
   * Procedural canvas-weave normal map (128 × 128).
   * Each thread arc contributes a normal that slopes toward its apex.
   */
  private makeCanvasNormal(scene: Scene, name: string): DynamicTexture {
    const SZ  = 128;
    const S   = 8;
    const tex = new DynamicTexture(name + '_nrm', { width: SZ, height: SZ }, scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const img = ctx.createImageData(SZ, SZ);
    const px  = img.data;

    for (let y = 0; y < SZ; y++) {
      const rowPhase = Math.floor(y / S) % 2;
      for (let x = 0; x < SZ; x++) {
        const colPhase = Math.floor(x / S) % 2;
        const ty   = (y % S) / S;
        const tx   = (x % S) / S;
        const over = (colPhase === rowPhase);
        // Top thread: normal curves left-right (R channel)
        // Under thread: normal curves up-down (G channel)
        const nx = over ? Math.round(128 + 48 * Math.sin((tx - 0.5) * Math.PI)) : 128;
        const ny = over ? 128 : Math.round(128 + 48 * Math.sin((ty - 0.5) * Math.PI));
        const idx = (y * SZ + x) * 4;
        px[idx + 0] = nx;
        px[idx + 1] = ny;
        px[idx + 2] = 220;   // slightly reduced Z — threads are rounded, not flat
        px[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    tex.update();
    return tex;
  }

  /**
   * Replace BabylonJS ribbon auto-UVs with world-space UVs so the canvas-weave
   * texture tiles at a consistent physical size regardless of sail taper.
   *
   * BabylonJS CreateRibbon maps U 0→1 across the full width and V 0→1 along the
   * full height, which stretches the texture to match the sail's aspect ratio.
   * Instead we derive U from the local-space z-position and V from the y-position,
   * then scale by tilesAcross / tilesUp so the texture repeats at the chosen rate.
   *
   * physWidth  — maximum z-extent of the sail in pivot-local space (boom length)
   * physHeight — y-extent of the sail (boom to masthead)
   * yBase      — local y at the foot of the sail (V = 0 origin)
   */
  private fixRibbonUVs(
    mesh: Mesh,
    physWidth: number,
    physHeight: number,
    yBase: number,
    tilesAcross: number,
    tilesUp: number,
  ): void {
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
    const raw = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!pos || !raw) return;

    // Work on a mutable Float32Array copy — getVerticesData may return a view
    const uvs = new Float32Array(raw.length);
    const n   = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const py = pos[i * 3 + 1];   // y → V (0 at foot, 1 at head)
      const pz = pos[i * 3 + 2];   // z → U (0 at luff/mast, negative toward leech)
      uvs[i * 2 + 0] = (-pz  / physWidth)  * tilesAcross;
      uvs[i * 2 + 1] = ((py - yBase) / physHeight) * tilesUp;
    }
    mesh.updateVerticesData(VertexBuffer.UVKind, uvs);
  }

  /**
   * Bake UV coordinates for a multi-path ribbon by path/vertex index.
   *
   * BabylonJS ribbon vertex ordering: all vertices of path 0, then path 1, etc.
   * Within each path, vertices go from first to last (foot→head for our sails).
   *
   * U = pathIndex / (numPaths−1)  →  0=luff, 1=leech
   * V = vertIndex / numSegs       →  0=foot, 1=head
   *
   * tilesAcross/tilesUp scale so canvas-weave threads have near-square physical size.
   */
  private bakeRibbonUVs(
    mesh:        Mesh,
    numPaths:    number,
    numSegs:     number,
    tilesAcross: number,
    tilesUp:     number,
  ): void {
    const raw = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!raw) return;
    const uvs        = new Float32Array(raw.length);
    const vertsPerPath = numSegs + 1;
    const n          = uvs.length / 2;
    for (let k = 0; k < n; k++) {
      const pathIdx = Math.floor(k / vertsPerPath);
      const vertIdx = k % vertsPerPath;
      uvs[k * 2 + 0] = (pathIdx / (numPaths - 1)) * tilesAcross;
      uvs[k * 2 + 1] = (vertIdx / numSegs)         * tilesUp;
    }
    mesh.updateVerticesData(VertexBuffer.UVKind, uvs);
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

  /**
   * PBR canvas-weave material shared by all sails.
   * Semi-transparent (alpha 0.92), double-sided, with woven albedo + normal map.
   */
  private buildCanvasMat(scene: Scene): PBRMaterial {
    const key = 'canvas_sail';
    if (this.matPool.has(key)) return this.matPool.get(key)!;

    const alb = this.getTex(scene, 'canvas_alb', () => this.makeCanvasAlbedo(scene, 'canvas_alb'));
    const nrm = this.getTex(scene, 'canvas_nrm', () => this.makeCanvasNormal(scene, 'canvas'));
    // UV tiling is baked per-mesh via fixRibbonUVs — keep scale at 1 here
    // so both mainsail and jib can have independent physical tile counts.
    alb.uScale = 1; alb.vScale = 1;
    nrm.uScale = 1; nrm.vScale = 1;
    nrm.level  = 0.45;

    const m = new PBRMaterial('canvas_sail_mat', scene);
    m.albedoTexture    = alb;
    m.bumpTexture      = nrm;
    m.roughness        = 0.82;
    m.metallic         = 0;
    m.alpha            = 0.92;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    m.backFaceCulling  = false;
    m.twoSidedLighting = true;

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
    for (const light of this.torchLights) light.dispose();
    this.torchLights     = [];
    this.torchFlameMats  = [];
    this.torchSconceMats = [];
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
