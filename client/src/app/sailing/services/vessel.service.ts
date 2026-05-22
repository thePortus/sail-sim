import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  MeshBuilder, Vector3, Color3, Color4, StandardMaterial, Mesh,
  TransformNode, DynamicTexture, ParticleSystem, Scene, PointerEventTypes, PointLight,
} from '@babylonjs/core';
import { SceneService } from './scene.service';
import { IslandService } from './island.service';
import { OceanService }  from './ocean.service';
import { Vessel, VesselPart, SailState, Wind, SeaConditions, VesselState, VesselPhysics } from '../models';

@Injectable({ providedIn: 'root' })
export class VesselService {
  private sceneService  = inject(SceneService);
  private islandService = inject(IslandService);
  private oceanService  = inject(OceanService);
  private zone          = inject(NgZone);

  // ── Public reactive state ─────────────────────────────────────────────────
  grounded = signal<boolean>(false);

  state = signal<VesselState>({
    x: 7200, z: 0, heading: 270, speed: 0,
    sailState: 'reefed', windAngle: 90, isPortTack: false, heelAngle: 0,
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

  // ── Mesh handles ──────────────────────────────────────────────────────────
  private root!:         TransformNode;
  private mainSailPivot: TransformNode | null = null;
  private jibPivot:      TransformNode | null = null;
  private mainSailMesh:  Mesh | null = null;
  private jibMesh:       Mesh | null = null;

  // ── Torches ───────────────────────────────────────────────────────────────
  private torchLights:    PointLight[]         = [];
  private torchFlameMats: StandardMaterial[]   = [];

  // ── Input ─────────────────────────────────────────────────────────────────
  private keys = { left: false, right: false };
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
  private simTime = 0;

  // ── World-scale travel multiplier ─────────────────────────────────────────
  // The HUD displays physics speed (realistic knots), but world position advances
  // at TRAVEL_SCALE × that rate — a classic video-game map-compression trick.
  // Raise this to make island-to-island sailing feel snappier; lower it for realism.
  private readonly TRAVEL_SCALE = 5.0;

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

    mesh.parent   = this.root;
    mesh.position = new Vector3(part.position.x, part.position.y, part.position.z);
    if (part.rotation) {
      mesh.rotation = new Vector3(part.rotation.x, part.rotation.y, part.rotation.z);
    }

    const mat = new StandardMaterial(part.id + '_mat', scene);
    mat.diffuseColor  = Color3.FromHexString(part.material.color);
    mat.specularColor = Color3.FromHexString(part.material.specular ?? '#222222');
    if (part.material.alpha    !== undefined) mat.alpha = part.material.alpha;
    if (part.material.emissive !== undefined) {
      mat.emissiveColor  = Color3.FromHexString(part.material.emissive);
      mat.disableLighting = false;  // keep diffuse but add emissive glow
    }
    mesh.material = mat;

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
      sconce.parent   = this.root;
      sconce.position = new Vector3(pos.x, pos.y, pos.z);
      const sconceMat = new StandardMaterial(`torch_sconce_mat_${i}`, scene);
      sconceMat.diffuseColor  = new Color3(0.16, 0.12, 0.10);
      sconceMat.specularColor = new Color3(0.25, 0.20, 0.15);
      sconce.material = sconceMat;

      // Flame sphere (emissive orange ball at the top of the sconce)
      const flame = MeshBuilder.CreateSphere(`torch_flame_${i}`, {
        diameter: 0.22, segments: 7,
      }, scene);
      flame.parent   = this.root;
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
    const mastX = 0, mastZ = 1.5;
    const mastTopY = 15.1;     // top of mast
    const boomY    = 1.7;      // boom height
    const boomLen  = 7.8;      // how far boom extends aft of mast

    // ── Main sail (pivot at mast base) ────────────────────────────────────
    this.mainSailPivot = new TransformNode('main_sail_pivot', scene);
    this.mainSailPivot.parent   = this.root;
    this.mainSailPivot.position = new Vector3(mastX, 0, mastZ);

    // Ribbon: luff (mast edge) and leech (free edge), 12 horizontal strips
    const segments = 12;
    const luff: Vector3[] = [];
    const leech: Vector3[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const y = boomY + t * (mastTopY - boomY);
      luff.push(new Vector3(0, y, 0));
      // Leech tapers: full boom length at foot, ~20% shorter at head
      const zOff = -(boomLen * (1 - t * 0.22));
      leech.push(new Vector3(0, y, zOff));
    }

    this.mainSailMesh = MeshBuilder.CreateRibbon('mainsail', {
      pathArray:        [luff, leech],
      sideOrientation:  Mesh.DOUBLESIDE,
      updatable:        true,
    }, scene);
    this.mainSailMesh.parent = this.mainSailPivot;

    const sailMat = new StandardMaterial('mainsail_mat', scene);
    sailMat.diffuseColor  = new Color3(0.98, 0.97, 0.90);
    sailMat.specularColor = new Color3(0.05, 0.05, 0.05);
    sailMat.alpha         = 0.92;
    sailMat.backFaceCulling = false;
    this.mainSailMesh.material = sailMat;

    // ── Jib (pivot at forestay attachment near bow) ───────────────────────
    const jibBaseZ = 7.0;    // near bow
    const jibTopY  = mastTopY - 1.0;
    this.jibPivot  = new TransformNode('jib_pivot', scene);
    this.jibPivot.parent   = this.root;
    this.jibPivot.position = new Vector3(0, 0, jibBaseZ);

    const jLuff:  Vector3[] = [];
    const jLeech: Vector3[] = [];
    const jSegs = 10;
    for (let i = 0; i <= jSegs; i++) {
      const t = i / jSegs;
      // luff runs from foot (bow) up to hank at masthead
      const y  = 1.5 + t * (jibTopY - 1.5);
      const dz = -t * (jibBaseZ - mastZ) - (1 - t) * 0;  // tracks forestay
      jLuff.push(new Vector3(0, y, dz));
      // leech: from clew (near mast base) to head (masthead)
      jLeech.push(new Vector3(0, y, -(jibBaseZ - mastZ) * t + dz * 0.3));
    }

    this.jibMesh = MeshBuilder.CreateRibbon('jib', {
      pathArray:       [jLuff, jLeech],
      sideOrientation: Mesh.DOUBLESIDE,
      updatable:       true,
    }, scene);
    this.jibMesh.parent = this.jibPivot;

    const jibMat = new StandardMaterial('jib_mat', scene);
    jibMat.diffuseColor   = new Color3(0.97, 0.96, 0.88);
    jibMat.specularColor  = new Color3(0.04, 0.04, 0.04);
    jibMat.alpha          = 0.90;
    jibMat.backFaceCulling = false;
    this.jibMesh.material = jibMat;
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

    this.isGrounded = false;
    this.grounded.set(false);
    this.resetWake();
  }

  private updateSailMeshes(): void {
    if (!this.mainSailMesh || !this.jibMesh) return;
    switch (this.sailState) {
      case 'reefed':
        this.mainSailMesh.scaling.y = 0.08;
        this.jibMesh.setEnabled(false);
        break;
      case 'topsails':
        this.mainSailMesh.scaling.y = 0.5;
        this.jibMesh.setEnabled(true);
        this.jibMesh.scaling.y = 0.5;
        break;
      case 'full':
        this.mainSailMesh.scaling.y = 1.0;
        this.jibMesh.setEnabled(true);
        this.jibMesh.scaling.y = 1.0;
        break;
    }
  }

  // ── Sail efficiency curve ─────────────────────────────────────────────────
  // Redesigned to make close-hauled sailing viable (~52 % eff at minTackAngle).
  // minTackAngle = 32° (set in vessel physics), so the "in irons" zone is tighter.

  private sailEfficiency(angleFromWind: number): number {
    const sailMult = this.sailState === 'reefed' ? 0 : this.sailState === 'topsails' ? 0.5 : 1.0;
    const a = Math.abs(angleFromWind);
    let eff: number;

    if      (a < this.physics.minTackAngle) eff = -0.30;  // in irons: gentle pushback
    else if (a < 45)  eff = 0.52;  // close-hauled: was 0.15, now usable
    else if (a < 60)  eff = 0.72;  // close reach
    else if (a < 90)  eff = 0.86;  // beam reach
    else if (a < 115) eff = 0.95;  // broad reach approach
    else if (a < 145) eff = 1.00;  // broad reach — peak VMG
    else if (a < 165) eff = 0.88;  // running
    else              eff = 0.72;  // dead downwind (blanketed jib)

    return eff * sailMult;
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

  // ── Sail angle for visual rotation ────────────────────────────────────────

  private sailSwingAngle(angleFromWind: number): number {
    const a = Math.abs(angleFromWind);
    if (a < 35)  return 6;
    if (a < 65)  return 14 + (a - 35) * 0.8;
    if (a < 120) return 38 + (a - 65) * 0.7;
    if (a < 165) return 76 + (a - 120) * 0.3;
    return 89;
  }

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
    const sea  = this.currentSea;

    // Angle from wind: 0 = into wind, 180 = before wind
    let diff = this.heading - wind.fromBearingDeg;
    diff = ((diff + 360) % 360);
    const angleFromWind = diff > 180 ? 360 - diff : diff;
    const isPortTack    = diff <= 180;

    const eff    = this.sailEfficiency(angleFromWind);
    const target = Math.max(-1.5, Math.min(this.physics.maxSpeed, wind.speed * eff * this.physics.sailAreaFactor));
    this.speed  += (target - this.speed) * this.physics.accelerationRate * dt;
    if (Math.abs(this.speed) < 0.001) this.speed = 0;  // snap to zero only on true standstill

    // Steering
    if (this.keys.left || this.keys.right) {
      const dir = this.keys.left ? -1 : 1;
      this.heading = ((this.heading + dir * this.turnRate(this.speed) * dt) + 360) % 360;
    }

    // Position update — world moves faster than physics speed implies
    // (TRAVEL_SCALE compresses map distances while keeping knots realistic)
    const hr   = this.heading * Math.PI / 180;
    const newX = this.x + Math.sin(hr) * this.speed * dt * this.TRAVEL_SCALE;
    const newZ = this.z + Math.cos(hr) * this.speed * dt * this.TRAVEL_SCALE;

    if (this.islandService.isOnLand(newX, newZ)) {
      // Block movement, halt the vessel, and mark as aground
      this.speed = 0;
      if (!this.isGrounded) {
        this.isGrounded = true;
        this.grounded.set(true);
      }
    } else {
      this.x = newX;
      this.z = newZ;
      // Clear grounded if we managed to drift/back off the shore
      if (this.isGrounded) {
        this.isGrounded = false;
        this.grounded.set(false);
      }
    }

    // Wake trail
    this.updateWake();

    // Heel angle (leeward lean)
    const heelMagnitude = Math.abs(eff) * Math.abs(this.speed / this.physics.maxSpeed) * 12;
    const heelAngle     = (isPortTack ? 1 : -1) * heelMagnitude;

    // Update root transform
    this.root.position.x = this.x;
    this.root.position.z = this.z;
    this.root.rotation.y = this.heading * Math.PI / 180;

    // Sit the hull realistically in the water.
    // hull_main local bottom = −0.8 → at FLOAT_Y −0.4 the bottom is at world Y −1.2
    // (clearly submerged), deck at world Y ≈ +0.72, waterline stripe at +0.42.
    // In storm, rise slightly so wave crests don't swamp the deck.
    const FLOAT_Y = -0.4 + sea.choppiness * 0.2;  // calm ≈ −0.40  storm ≈ −0.20

    // Wave bobbing — keep amplitude modest so hull never dips back into waves.
    const t        = this.simTime;
    const bobAmp   = 0.12 + sea.choppiness * 0.22;  // 0.14 calm → 0.34 storm
    const pitchAmp = 0.8  + sea.choppiness * 1.5;   // °
    const rollAmp  = 1.5  + sea.choppiness * 2.5;   // °

    this.root.position.y = FLOAT_Y + Math.sin(t * 1.2) * bobAmp;
    this.root.rotation.z = (heelAngle + Math.sin(t * 1.6) * rollAmp) * Math.PI / 180;
    this.root.rotation.x = Math.sin(t * 0.9 + 1.3) * pitchAmp * Math.PI / 180;

    // Sail rotation
    const swingDeg = this.sailSwingAngle(angleFromWind);
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
      this.state.set({ x: this.x, z: this.z, heading: this.heading, speed: this.speed,
        sailState: this.sailState, windAngle: angleFromWind, isPortTack, heelAngle });
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
        case 'ArrowLeft':  case 'KeyA': this.keys.left  = true; break;
        case 'ArrowRight': case 'KeyD': this.keys.right = true; break;
        case 'KeyW': this.stepSail(1);  break;   // step sail up
        case 'KeyS': this.stepSail(-1); break;   // step sail down
        case 'Digit1': this.setSailState('reefed');   break;
        case 'Digit2': this.setSailState('topsails'); break;
        case 'Digit3': this.setSailState('full');     break;
      }
    };
    this.keyUpHandler = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'ArrowLeft':  case 'KeyA': this.keys.left  = false; break;
        case 'ArrowRight': case 'KeyD': this.keys.right = false; break;
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
    this.bowSpray = new ParticleSystem('bowSpray', 220, scene);
    this.bowSpray.particleTexture = this.wakeTex;
    this.bowSpray.emitter    = this.bowEmit;
    this.bowSpray.minEmitBox = new Vector3(-0.4, 0, -0.4);
    this.bowSpray.maxEmitBox = new Vector3( 0.4, 0,  0.4);
    this.bowSpray.color1     = new Color4(1.00, 1.00, 1.00, 0.72);
    this.bowSpray.color2     = new Color4(0.88, 0.95, 1.00, 0.50);
    this.bowSpray.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.bowSpray.minSize     = 0.06; this.bowSpray.maxSize     = 0.20;
    this.bowSpray.minLifeTime = 0.4;  this.bowSpray.maxLifeTime = 1.2;
    this.bowSpray.minEmitPower = 2;   this.bowSpray.maxEmitPower = 6;
    this.bowSpray.updateSpeed  = 0.016;
    // direction1/direction2 are heading-dependent — set in updateWake each tick
    this.bowSpray.direction1 = new Vector3(-1, 0.2, 0);
    this.bowSpray.direction2 = new Vector3( 1, 0.2, 0);
    this.bowSpray.gravity    = new Vector3(0, -0.5, 0);
    this.bowSpray.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.bowSpray.emitRate   = 0;
    this.bowSpray.start();

    // ── Stern foam (long-life wake V-trail) ────────────────────────────────
    // Low velocity so particles stay roughly where spawned; the moving boat
    // leaves them behind, naturally building a long V-shaped foam trail.
    this.sternFoam = new ParticleSystem('sternFoam', 600, scene);
    this.sternFoam.particleTexture = this.wakeTex;
    this.sternFoam.emitter    = this.sternEmit;
    this.sternFoam.minEmitBox = new Vector3(-1.0, 0, -0.5);
    this.sternFoam.maxEmitBox = new Vector3( 1.0, 0,  0.5);
    this.sternFoam.color1     = new Color4(1.00, 1.00, 1.00, 0.60);
    this.sternFoam.color2     = new Color4(0.85, 0.94, 1.00, 0.38);
    this.sternFoam.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.sternFoam.minSize     = 0.12; this.sternFoam.maxSize     = 0.38;
    this.sternFoam.minLifeTime = 4.0;  this.sternFoam.maxLifeTime = 9.0;
    this.sternFoam.minEmitPower = 0.5; this.sternFoam.maxEmitPower = 2.5;
    this.sternFoam.updateSpeed  = 0.016;
    this.sternFoam.direction1 = new Vector3(-1, 0, -1);
    this.sternFoam.direction2 = new Vector3( 1, 0,  1);
    this.sternFoam.gravity    = Vector3.Zero();
    this.sternFoam.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.sternFoam.emitRate   = 0;
    this.sternFoam.start();

    // ── Port hull froth ────────────────────────────────────────────────────
    this.portFroth = new ParticleSystem('portFroth', 160, scene);
    this.portFroth.particleTexture = this.wakeTex;
    this.portFroth.emitter    = this.portEmit;
    this.portFroth.minEmitBox = new Vector3(-0.3, 0, -1.5);
    this.portFroth.maxEmitBox = new Vector3( 0.3, 0,  1.5);
    this.portFroth.color1     = new Color4(1.00, 1.00, 1.00, 0.55);
    this.portFroth.color2     = new Color4(0.90, 0.96, 1.00, 0.30);
    this.portFroth.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.portFroth.minSize     = 0.04; this.portFroth.maxSize     = 0.14;
    this.portFroth.minLifeTime = 0.4;  this.portFroth.maxLifeTime = 1.4;
    this.portFroth.minEmitPower = 1;   this.portFroth.maxEmitPower = 4;
    this.portFroth.updateSpeed  = 0.016;
    this.portFroth.direction1 = new Vector3(-1, 0.1, 0);
    this.portFroth.direction2 = new Vector3(-3, 0.2, 0);
    this.portFroth.gravity    = new Vector3(0, -0.3, 0);
    this.portFroth.blendMode  = ParticleSystem.BLENDMODE_ADD;
    this.portFroth.emitRate   = 0;
    this.portFroth.start();

    // ── Stbd hull froth ────────────────────────────────────────────────────
    this.stbdFroth = new ParticleSystem('stbdFroth', 160, scene);
    this.stbdFroth.particleTexture = this.wakeTex;
    this.stbdFroth.emitter    = this.stbdEmit;
    this.stbdFroth.minEmitBox = new Vector3(-0.3, 0, -1.5);
    this.stbdFroth.maxEmitBox = new Vector3( 0.3, 0,  1.5);
    this.stbdFroth.color1     = new Color4(1.00, 1.00, 1.00, 0.55);
    this.stbdFroth.color2     = new Color4(0.90, 0.96, 1.00, 0.30);
    this.stbdFroth.colorDead  = new Color4(1.00, 1.00, 1.00, 0.00);
    this.stbdFroth.minSize     = 0.04; this.stbdFroth.maxSize     = 0.14;
    this.stbdFroth.minLifeTime = 0.4;  this.stbdFroth.maxLifeTime = 1.4;
    this.stbdFroth.minEmitPower = 1;   this.stbdFroth.maxEmitPower = 4;
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

    // ── Heading-dependent direction vectors ───────────────────────────────
    // Bow: spray sideways away from the prow (port and stbd plumes)
    this.bowSpray.direction1.set(-rgtX * 4 - fwdX, 0.3, -rgtZ * 4 - fwdZ);
    this.bowSpray.direction2.set( rgtX * 4 - fwdX, 0.3,  rgtZ * 4 - fwdZ);

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
    const moving = absSpeed > 0.3;
    const sf     = moving ? Math.min(1, absSpeed / this.physics.maxSpeed) : 0;

    this.bowSpray.emitRate  = Math.round(sf * 60);
    this.sternFoam.emitRate = Math.round(sf * 45);
    this.portFroth.emitRate = Math.round(sf * 35);
    this.stbdFroth.emitRate = Math.round(sf * 35);

    // ── Size scales modestly with speed ───────────────────────────────────
    const sizeBoost = sf * 0.08;
    this.bowSpray.maxSize  = 0.20 + sizeBoost;
    this.sternFoam.maxSize = 0.38 + sizeBoost;

    // ── Inform ocean service so wake plane shader knows boat position ──────
    this.oceanService.setBoatTransform(this.x, this.z, hdgR, this.speed);
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
    this.torchLights    = [];
    this.torchFlameMats = [];
    for (const ps of [this.bowSpray, this.sternFoam, this.portFroth, this.stbdFroth]) {
      ps?.stop(); ps?.dispose();
    }
    this.wakeTex?.dispose();
  }
}
