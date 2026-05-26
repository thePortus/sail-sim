import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  WebGPUEngine, Scene, Color3, Color4, Vector3, Ray,
  HemisphericLight, DirectionalLight,
  FreeCamera, MeshBuilder, StandardMaterial, Mesh, GlowLayer,
  DefaultRenderingPipeline, ShadowGenerator, CascadedShadowGenerator,
  SSAO2RenderingPipeline, DepthOfFieldEffectBlurLevel,
} from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials';

@Injectable({ providedIn: 'root' })
export class SceneService {
  private zone = inject(NgZone);

  engine!: WebGPUEngine;
  scene!:  Scene;
  camera!: FreeCamera;

  private skyMat!:    SkyMaterial;
  private skyMesh:    any;
  private sun!:       DirectionalLight;
  private moonLight!: DirectionalLight;
  private ambient!:   HemisphericLight;
  private sunMesh!:   Mesh;
  private moonMesh!:  Mesh;
  private glowLayer!: GlowLayer;

  // Shadow generator — attached to the sun DirectionalLight and exposed so that
  // VesselService, IslandService, CannonService, and MultiplayerService can
  // register their meshes as casters / receivers.
  shadowGenerator!: ShadowGenerator;
  private pipeline!: DefaultRenderingPipeline;

  // Public signal so the HUD can display the current game time.
  gameTime = signal(10.5);  // 0–24 hours

  // Sun glare occlusion: 0 = fully blocked by terrain, 1 = fully visible.
  // Smoothly interpolated to avoid a hard pop when the sun crosses a ridgeline.
  private sunOcclusionT = 1.0;

  // Occlusion ray-cast throttle.  At midday the upward ray misses island
  // bounding boxes almost immediately.  At dawn/dusk the nearly-horizontal
  // 50 km ray intersects EVERY island bounding box in the scene, which
  // escalates to a full mesh triangle test for each one — millions of
  // triangle-ray intersection tests per frame on the CPU.  Firing every 6th
  // frame costs nothing perceptible because sunOcclusionT is lerped each frame.
  private sunOcclusionFrame  = 0;
  private lastSunOccluded    = false;

  // ── Post-processing setter cache ────────────────────────────────────────────
  // BabylonJS ImageProcessingConfiguration setters have NO equality guard:
  // every write fires onUpdateParameters, notifying every subscribed
  // StandardMaterial to call _markAllSubMeshesAsImageProcessingDirty().  With
  // hundreds of island + biome meshes, at dawn/dusk (where `horizon` changes
  // every frame), this triggers a per-frame dirty-mark cascade that forces
  // WebGPU bind-group recreation for all those meshes — sustained CPU/GPU stall.
  // During day and night `horizon = 0` so the computed values never change and
  // the setters either hit BabylonJS's own skips or rarely re-fire; only the
  // continuous-change window causes the problem.
  // Fix: cache the last-written value and skip the setter call when the new
  // value is within PIPELINE_EPS of what was already applied.
  private readonly PIPELINE_EPS = 0.02;   // raised from 0.005 — updates every ~2 s during transition
  private _cachedExposure = 1.0;
  private _cachedContrast = 1.10;
  private _cachedBloomW   = 0.28;   // bloomWeight cache (setter fires per-call with no guard)

  // sun / moon enabled-state cache — avoids calling setEnabled(true/false) on
  // every single frame tick when the state hasn't changed.
  // Initialised to true to match BabylonJS's default (all created meshes start enabled).
  private _sunEnabled  = true;
  private _moonEnabled = true;

  // 1 real second = 1 game minute → full day/night cycle every 24 real minutes.
  private gameHours = 10.5;
  private readonly SECS_PER_GAME_HOUR = 60;

  // Admin time offset: added to the wall clock so the sky can be forced to any hour.
  private timeOffsetSecs = 0;

  /** Pin the sky to a specific game-hour by computing the required epoch offset. */
  setTimeOffset(targetHours: number): void {
    const cycleSecs   = this.SECS_PER_GAME_HOUR * 24;
    const nowNorm     = (Date.now() / 1000) % cycleSecs;
    const targetSecs  = targetHours * this.SECS_PER_GAME_HOUR;
    this.timeOffsetSecs = ((targetSecs - nowNorm) + cycleSecs) % cycleSecs;
  }

  clearTimeOffset(): void {
    this.timeOffsetSecs = 0;
  }

  async initAsync(canvas: HTMLCanvasElement): Promise<void> {
    await this.zone.runOutsideAngular(async () => {
      this.engine = await WebGPUEngine.CreateAsync(canvas, {
        antialias: true,
        // The FFT postprocess and time-evolve compute shaders bind 5–6 storage
        // textures per stage.  The WebGPU default minimum is 4; the adapter
        // supports 8.  We must declare this in requiredLimits at device creation
        // time — it cannot be patched later without recreating the device.
        deviceDescriptor: {
          requiredLimits: { maxStorageTexturesPerShaderStage: 8 },
        },
      });

      this.scene = new Scene(this.engine);
      this.scene.fogMode    = Scene.FOGMODE_EXP2;
      this.scene.fogDensity = 0.000035;

      this.buildSky();
      this.buildLights();
      this.buildCelestialBodies();
      this.buildCamera(canvas);
      this.buildPostProcessing();
      this.startRenderLoop();
    });
  }

  // ── Sky ──────────────────────────────────────────────────────────────────────

  private buildSky(): void {
    this.skyMat = new SkyMaterial('sky', this.scene);
    this.skyMat.backFaceCulling = false;

    // Preetham atmospheric model — tuned for a dramatic, real-looking sky.
    this.skyMat.turbidity        = 2.5;   // 2 = crystal clear, 10 = heavy haze
    this.skyMat.luminance        = 1.0;
    this.skyMat.rayleigh         = 2.2;   // blue sky scattering intensity
    this.skyMat.mieCoefficient   = 0.008; // sun-halo size
    this.skyMat.mieDirectionalG  = 0.96;  // how tight the halo cone is (0=spread, 1=laser)
    this.skyMat.inclination      = 0.35;  // set properly by first tick
    this.skyMat.azimuth          = 0.15;

    const skybox = MeshBuilder.CreateBox('skybox', { size: 150000 }, this.scene);
    skybox.material         = this.skyMat;
    skybox.infiniteDistance = true;
    this.skyMesh = skybox;
  }

  // ── Lights ───────────────────────────────────────────────────────────────────

  private buildLights(): void {
    this.ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this.scene);

    this.sun          = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.6), this.scene);
    this.sun.position = new Vector3(8000, 12000, -4000);

    // CascadedShadowGenerator splits the camera frustum into distance bands so
    // nearby geometry gets crisp shadows without forcing a giant ortho frustum
    // over the full 50 000-unit world.
    //   Cascade 0 (~0–30 u)  : vessel hull, cannonballs — high resolution
    //   Cascade 1 (~30–150 u): island self-shadowing, vessel-on-island
    //   Cascade 2 (~150–400 u): distant terrain — low resolution
    const csg = new CascadedShadowGenerator(1024, this.sun);
    csg.numCascades        = 3;
    csg.stabilizeCascades  = true;   // reduces shimmering as camera pans
    csg.lambda             = 0.75;   // 0 = uniform splits, 1 = logarithmic
    csg.shadowMaxZ         = 400;    // shadows discarded beyond 400 units
    csg.bias               = 0.001;
    csg.normalBias         = 0.02;
    csg.darkness           = 0.05;   // 0 = fully opaque shadow, 1 = invisible
    csg.transparencyShadow = true;   // sails/flag cloth casts transparent shadows
    this.shadowGenerator   = csg;

    // Cool blue-white directional light simulating moonlight.
    // Direction is updated each frame (opposite the sun). Intensity peaks at midnight.
    this.moonLight         = new DirectionalLight('moonLight', new Vector3(0, -1, 0), this.scene);
    this.moonLight.diffuse  = new Color3(0.62, 0.72, 0.94);
    this.moonLight.specular = new Color3(0.28, 0.32, 0.52);
    this.moonLight.intensity = 0;   // off during daytime — animated in tick
  }

  // ── Sun / moon disks with glow ────────────────────────────────────────────────

  private buildCelestialBodies(): void {
    this.glowLayer = new GlowLayer('glow', this.scene, {
      mainTextureFixedSize: 512,
      // 64 → internally halved to 32 taps per axis per pass, vs 128 → 64 taps.
      // 2× cheaper blur with no perceptible quality loss on a soft glow effect.
      blurKernelSize: 64,
    });

    // Sun — large emissive plane, always faces camera (billboard), glow-only mesh.
    const sunMat = new StandardMaterial('sunMat', this.scene);
    sunMat.disableLighting = true;
    sunMat.emissiveColor   = new Color3(1, 0.95, 0.65);

    this.sunMesh = MeshBuilder.CreatePlane('sunDisk', { size: 2200 }, this.scene);
    this.sunMesh.material      = sunMat;
    this.sunMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.sunMesh.isPickable    = false;
    this.glowLayer.addIncludedOnlyMesh(this.sunMesh);

    // Moon — smaller, cool silver-blue tone.
    const moonMat = new StandardMaterial('moonMat', this.scene);
    moonMat.disableLighting = true;
    moonMat.emissiveColor   = new Color3(0.80, 0.85, 0.97);

    this.moonMesh = MeshBuilder.CreatePlane('moonDisk', { size: 850 }, this.scene);
    this.moonMesh.material      = moonMat;
    this.moonMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.moonMesh.isPickable    = false;
    this.glowLayer.addIncludedOnlyMesh(this.moonMesh);
  }

  // ── Camera ───────────────────────────────────────────────────────────────────

  private buildCamera(canvas: HTMLCanvasElement): void {
    this.camera = new FreeCamera('mainCam', new Vector3(7000, 12, -20), this.scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 120000;
    this.camera.fov  = 1.1;
  }

  // ── Post-processing pipeline ──────────────────────────────────────────────────

  private buildPostProcessing(): void {
    this.pipeline = new DefaultRenderingPipeline('mainPipeline', true, this.scene, [this.camera]);

    // Bloom — makes emissive meshes (sun disk, torches) bleed light into the scene.
    // Weight and exposure are boosted dynamically at golden hour in tickTimeOfDay().
    this.pipeline.bloomEnabled   = true;
    this.pipeline.bloomThreshold = 0.78;
    this.pipeline.bloomWeight    = 0.28;
    this.pipeline.bloomKernel    = 128;
    this.pipeline.bloomScale     = 0.5;

    // SSAO — bakes contact shadows into corners and crevices of nearby geometry
    // (mast base, under the boom, beneath deck railings, etc.).  maxZ = 100
    // zeroes the AO term for any fragment beyond 100 world units from the camera,
    // so distant islands and ocean are unaffected.  The 0.75 ratio renders the
    // occlusion buffer at 75 % of screen resolution for a good quality/perf trade.
    const ssao            = new SSAO2RenderingPipeline('ssao2', this.scene, 0.75, [this.camera]);
    ssao.radius           = 2.0;   // world-space sample radius — tuned to ship-deck scale
    ssao.totalStrength    = 1.8;   // amplification on the AO term (raise for darker corners)
    ssao.base             = 0.0;   // 0 = fully dark in 100 %-occluded spots
    ssao.samples          = 16;    // 16 gives clean results on modern GPUs
    ssao.maxZ             = 100;   // AO zeroed beyond 100 u — excludes islands / far terrain
    ssao.bilateralSamples = 8;     // denoising pass sample count (smooth edges)

    // FXAA smooths aliased edges on the ocean and cloud geometry.
    this.pipeline.fxaaEnabled = true;

    // Sharpening — counteracts the softening from FXAA and SSAO's bilateral blur,
    // keeping hull edges, rigging, and deck detail crisp.
    this.pipeline.sharpenEnabled         = true;
    this.pipeline.sharpen.edgeAmount     = 0.25;
    this.pipeline.sharpen.colorAmount    = 1.0;

    // Film grain — breaks up the uniform "CG plastic" look on flat surfaces
    // (deck planks, sails, hull paint).  Animated so it reads as surface
    // texture/life rather than static noise.
    this.pipeline.grainEnabled       = true;
    this.pipeline.grain.intensity    = 12;
    this.pipeline.grain.animated     = true;

    // Depth of field — keeps the player vessel sharp while softening the horizon
    // and distant ships, mimicking a real camera lens.
    // focusDistance is in millimetres internally (1000 mm ≈ 1 world unit here).
    this.pipeline.depthOfFieldEnabled        = true;
    this.pipeline.depthOfFieldBlurLevel      = DepthOfFieldEffectBlurLevel.Medium;
    this.pipeline.depthOfField.fStop         = 2.8;    // aperture — lower = shallower DOF
    this.pipeline.depthOfField.focalLength   = 85;     // mm — telephoto compresses depth nicely
    this.pipeline.depthOfField.focusDistance = 8000;   // mm (~8 world units) — focused on ship
    this.pipeline.depthOfField.lensSize      = 50;     // physical lens diameter in mm

    // Image processing: ACES tone mapping + vignette + contrast.
    // ACES remaps how bright highlights clip — prevents blown-out whites and
    // gives a photographic, non-linear colour response (type 2 = ACES).
    this.pipeline.imageProcessingEnabled                   = true;
    this.pipeline.imageProcessing.toneMappingEnabled       = true;
    this.pipeline.imageProcessing.toneMappingType          = 2;     // ACES filmic
    this.pipeline.imageProcessing.vignetteEnabled          = true;
    this.pipeline.imageProcessing.vignetteWeight           = 0.60;
    this.pipeline.imageProcessing.contrast                 = 1.10;
    this.pipeline.imageProcessing.exposure                 = 1.0;
  }

  getSkyMesh(): any { return this.skyMesh; }

  updateFogDensity(density: number): void {
    if (this.scene) this.scene.fogDensity = density;
  }

  // ── Time of day ──────────────────────────────────────────────────────────────

  /**
   * CPU ray-cast: is any island terrain mesh blocking the camera→sun ray?
   *
   * ── Why the original implementation was slow at dawn/dusk ───────────────
   * scene.pickWithRay iterates every mesh, applies the predicate, then for
   * every island that passes runs:
   *   1. Bounding-box test  (O(1) per island)
   *   2. Triangle intersection  (O(triangles) per island that passes #1)
   *
   * At midday the ray points steeply upward and misses all bounding boxes
   * immediately — O(1) total cost.
   *
   * At dawn/dusk the ray is nearly horizontal at y ≈ 12 m, sweeping a 50 km
   * corridor.  Every island bounding box intersects this ray, so ALL 100
   * islands advance to triangle-testing: 100 × 5 000 tris × 100 ns ≈ 50 ms
   * per cast.  Even throttled to 1-in-6 frames, a 50 ms spike every 6th
   * frame causes severe visible jitter.
   *
   * ── Fix: three combined optimisations ──────────────────────────────────
   *
   * 1. Skip entirely when the sun is at or below h = 0.02 — the glow is too
   *    dim and atmospheric for occlusion to be perceptible.
   *
   * 2. Adaptive ray length: no island beyond (800 m / sunDir.y) can physically
   *    block the sun (800 m = tallest volcanic peak).  This shrinks the test
   *    corridor from 50 km down to ~16 km at 3°, ~6 km at 7°, etc.
   *
   * 3. Bounding-info-only (O(1) per island) when the sun is below 12°.  At
   *    those angles the ray is still nearly horizontal and triangle counts are
   *    large.  The visual effect of occlusion is subtle enough near the horizon
   *    that a conservative bounding-volume answer is indistinguishable.  Above
   *    12° the ray is steep, very few bounding boxes are hit, and full triangle
   *    accuracy is cheap.
   *
   * Result: dawn/dusk cost drops from ~50 ms/cast to < 0.2 ms/cast.
   */
  private isSunOccluded(sunDir: Vector3): boolean {
    if (!this.camera) return false;

    // (1) Near-horizon skip.
    if (sunDir.y < 0.02) { this.lastSunOccluded = false; return false; }

    // Throttle: run the actual test every 8th frame.
    // sunOcclusionT lerp (0.50/frame) fully converges within 2-3 frames,
    // so results stay visually smooth regardless of throttle interval.
    this.sunOcclusionFrame = (this.sunOcclusionFrame + 1) % 8;
    if (this.sunOcclusionFrame !== 0) return this.lastSunOccluded;

    // (2) Adaptive ray length.
    const rayLen = Math.min(25_000, 800 / sunDir.y);
    const ray    = new Ray(this.camera.position, sunDir, rayLen);
    const rl2    = rayLen * rayLen;
    const cx     = this.camera.position.x;
    const cz     = this.camera.position.z;

    // (3) Bounding-info-only at low sun angles; full triangles when steep.
    const onlyBB = sunDir.y < 0.12;

    for (const mesh of this.scene.meshes) {
      if (!mesh.isPickable || !mesh.name.startsWith('island_')) continue;
      // Distance pre-filter: skip islands outside the adaptive ray range.
      const dx = mesh.position.x - cx;
      const dz = mesh.position.z - cz;
      if (dx * dx + dz * dz > rl2) continue;
      if (ray.intersectsMesh(mesh, false, undefined, onlyBB).hit) {
        this.lastSunOccluded = true;
        return true;
      }
    }

    this.lastSunOccluded = false;
    return false;
  }

  // Returns a unit vector pointing FROM the scene origin TOWARD the sun.
  private computeSunDir(): Vector3 {
    // Smooth sine arc: h=6 sunrise, h=12 noon, h=18 sunset.
    const elev  = Math.sin(((this.gameHours - 6) / 12) * Math.PI); // -1..1
    const az    = (this.gameHours / 24) * Math.PI * 2 - Math.PI;   // azimuth
    const horiz = Math.sqrt(Math.max(0, 1 - elev * elev));          // horizontal component
    return new Vector3(horiz * Math.sin(az), elev, horiz * Math.cos(az));
  }

  private tickTimeOfDay(dt: number): void {
    // Derive from the wall clock so every client—regardless of when they join—
    // sees the same sky.  One full day/night cycle = SECS_PER_GAME_HOUR × 24
    // real seconds (default 60 s/hr → 24-minute cycle).
    const cycleSecs  = this.SECS_PER_GAME_HOUR * 24;
    this.gameHours   = (((Date.now() / 1000) + this.timeOffsetSecs) % cycleSecs) / this.SECS_PER_GAME_HOUR;
    this.gameTime.set(this.gameHours);

    const dir     = this.computeSunDir();
    const h       = dir.y;              // -1 midnight → +1 noon
    const above   = Math.max(0, h);     // 0..1 above horizon
    // Spikes near horizon for sunrise/sunset colour effects
    const horizon = Math.max(0, 1 - Math.abs(h) / 0.22);

    // ── SkyMaterial ───────────────────────────────────────────────────────────
    // inclination: 0 = at horizon, 0.45 ≈ high noon, negative = below horizon.
    this.skyMat.inclination     = h * 0.45;
    this.skyMat.azimuth         = (this.gameHours / 24 * 0.5 + 0.1) % 1;
    // Dense atmospheric haze near the horizon for thick, glaring sunsets.
    // Turbidity is capped at 10: the Preetham model's Mie scattering term has
    // cos(zenithAngle) in a denominator that approaches 0 at the horizon, so
    // with turbidity=18 the GPU shader can produce near-infinite or NaN luminance
    // values, which propagate into the bloom and MirrorTexture passes and can
    // cause GPU stalls or precision-mode switches on some hardware.
    this.skyMat.turbidity       = 2.0 + horizon * 8.0;    // cap 10, was 2+horizon*16=18
    this.skyMat.mieCoefficient  = 0.005 + horizon * 0.025; // cap 0.030, was 0.050
    this.skyMat.mieDirectionalG = 0.97 - horizon * 0.08;

    // ── Celestial disk positions ───────────────────────────────────────────────
    // Place them at a large distance from the camera so they never clip.
    if (this.camera) {
      const base = this.camera.position;
      this.sunMesh.position  = base.add(dir.scale(65000));
      this.moonMesh.position = base.add(dir.negate().scale(65000));
    }

    // Only call setEnabled when the state actually changes — calling it every
    // frame on an already-enabled mesh can invalidate WebGPU render state.
    const sunShouldBeOn  = h > -0.06;
    const moonShouldBeOn = h < 0.14;
    if (sunShouldBeOn  !== this._sunEnabled)  { this.sunMesh.setEnabled(sunShouldBeOn);   this._sunEnabled  = sunShouldBeOn; }
    if (moonShouldBeOn !== this._moonEnabled) { this.moonMesh.setEnabled(moonShouldBeOn); this._moonEnabled = moonShouldBeOn; }

    // ── Sun terrain occlusion ──────────────────────────────────────────────────
    // The GlowLayer renders the sun mesh to a separate texture that has no depth
    // context — the glow bleeds through volcanic mountains without this check.
    // Ray-cast toward the sun once per frame; smoothly fade the occlusion factor
    // so the glare disappears gracefully behind ridgelines rather than popping.
    if (h > -0.06) {
      const blocked   = this.isSunOccluded(dir);
      const occTarget = blocked ? 0.0 : 1.0;
      // 0.50 lerp factor: ~2-frame fade-in/out at 60 fps — fast enough to
      // track a mountain edge without popping, slow enough to look smooth.
      this.sunOcclusionT += (occTarget - this.sunOcclusionT) * 0.50;
    } else {
      this.sunOcclusionT = 1.0;  // below horizon — occlusion logic not needed
    }
    const occT = this.sunOcclusionT;

    // Sun colour: deep crimson-scarlet at horizon → blazing white at zenith.
    // Both emissiveColor and mesh visibility are driven by occT so (a) the glow
    // layer loses its source mesh input and (b) depth-buffer precision failures
    // at 65 km can't let the disc bleed through a mountain.
    const sunMat = this.sunMesh.material as StandardMaterial;
    sunMat.emissiveColor = new Color3(
      1.0                                  * occT,
      Math.min(1, 0.20 + above * 0.78)    * occT,   // deep amber-red at horizon
      Math.min(1, 0.03 + above * 0.91)    * occT,   // nearly zero blue near horizon
    );
    this.sunMesh.visibility = occT;
    // Atmospheric refraction: sun appears enlarged when close to the horizon.
    const sunScale = 1.0 + Math.max(0, 0.88 - above) * 3.2;
    this.sunMesh.scaling.setAll(sunScale);

    // Glow: erupts dramatically at sunrise/sunset, steady midday, dim moonlit at night.
    // Multiplied by occT so glare disappears when the sun is behind terrain.
    // Cap at 1.5 — the original ~5.9 peak was visually extreme and added no
    // perceptible quality beyond 2.0 while keeping the GPU glow composite busy.
    const baseGlow = h > 0
      ? 0.40 + horizon * 2.5 + above * 0.15   // peak ≈ 2.9 (was 5.9)
      : 0.22;  // soft moonlit glow
    this.glowLayer.intensity = Math.min(1.5, baseGlow * occT);

    // ── Post-processing: bloom and exposure surge at golden hour ──────────────
    if (this.pipeline) {
      // bloomWeight: throttle like exposure/contrast — the DefaultRenderingPipeline
      // setter chain fires internal observers on every write.
      const newBloomW = 0.28 + horizon * 0.68;
      if (Math.abs(newBloomW - this._cachedBloomW) > this.PIPELINE_EPS) {
        this.pipeline.bloomWeight = newBloomW;
        this._cachedBloomW = newBloomW;
      }

      // exposure and contrast setters fire onUpdateParameters with NO equality
      // guard, notifying every subscribed StandardMaterial to mark sub-meshes
      // dirty each frame — with hundreds of biome meshes this causes a sustained
      // WebGPU bind-group recreation stall during dawn/dusk.  Only push a new
      // value when it has changed by more than PIPELINE_EPS (≈ every 0.5 s
      // real-time during the transition window, invisible at the rate the sky moves).
      const newExposure = 1.0  + horizon * 0.48;
      const newContrast = 1.10 + horizon * 0.14;
      if (Math.abs(newExposure - this._cachedExposure) > this.PIPELINE_EPS) {
        this.pipeline.imageProcessing.exposure = newExposure;
        this._cachedExposure = newExposure;
      }
      if (Math.abs(newContrast - this._cachedContrast) > this.PIPELINE_EPS) {
        this.pipeline.imageProcessing.contrast = newContrast;
        this._cachedContrast = newContrast;
      }
    }

    // ── Directional (sun) light ────────────────────────────────────────────────
    this.sun.direction = dir.negate();
    this.sun.intensity = above * 1.35;
    this.sun.diffuse   = new Color3(
      1.0,
      Math.min(1, 0.28 + above * 0.67),   // warm orange at horizon → white at noon
      Math.min(1, 0.05 + above * 0.90),   // nearly no blue near horizon
    );
    this.sun.specular = this.sun.diffuse;

    // ── Moonlight (directional, opposite the sun, only at night) ─────────────
    // Peaks at midnight (h = -1) → intensity 0.35, zero by sunrise.
    // Smooth transition: full moon feel with cool blue-white tones.
    this.moonLight.direction = dir;               // toward-sun = away-from-sun's direction
    this.moonLight.intensity = Math.max(0, -h * 0.35);

    // ── Hemisphere (ambient sky fill) ─────────────────────────────────────────
    // Golden hour: warm amber fill; daytime: neutral blue-white; night: dim blue.
    this.ambient.intensity = 0.10 + above * 0.38;
    // Lerp between standard daylight ambient and warm golden-hour tones.
    const dayAmbient  = new Color3(0.52 + above * 0.38, 0.58 + above * 0.32, 0.84 + above * 0.16);
    const warmAmbient = new Color3(1.0, 0.68, 0.30);
    this.ambient.diffuse     = Color3.Lerp(dayAmbient, warmAmbient, horizon * 0.60);
    this.ambient.groundColor = new Color3(
      0.04 + above * 0.14 + horizon * 0.26,
      0.07 + above * 0.16 + horizon * 0.08,
      Math.max(0, 0.14 + above * 0.10 - horizon * 0.09),
    );

    // ── Fog and scene clear colour ─────────────────────────────────────────────
    // night deep navy → dawn warm orange → full day sea blue
    let fog: Color3;
    if (h > 0.30) {
      fog = new Color3(0.55, 0.70, 0.87);                                    // day
    } else if (h > 0) {
      fog = Color3.Lerp(new Color3(0.78, 0.40, 0.15), new Color3(0.55, 0.70, 0.87), h / 0.30);
    } else if (h > -0.25) {
      fog = Color3.Lerp(new Color3(0.01, 0.02, 0.07), new Color3(0.78, 0.40, 0.15), (h + 0.25) / 0.25);
    } else {
      fog = new Color3(0.01, 0.02, 0.07);                                    // night
    }

    this.scene.fogColor   = fog;
    this.scene.clearColor = new Color4(fog.r * 0.22, fog.g * 0.22, fog.b * 0.32, 1);
  }

  // ── Render loop ───────────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    let lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.05);
      lastTime  = now;
      this.tickTimeOfDay(dt);
      this.scene.render();
    });
    window.addEventListener('resize', () => this.engine.resize());
  }

  dispose(): void {
    this.engine?.dispose();
  }
}
