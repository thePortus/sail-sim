import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Engine, WebGPUEngine, Scene, Color3, Color4, Vector3, Ray,
  HemisphericLight, DirectionalLight,
  FreeCamera, MeshBuilder, StandardMaterial, Mesh, Material, GlowLayer,
  DefaultRenderingPipeline, ShadowGenerator, CascadedShadowGenerator,
  SSAO2RenderingPipeline, DepthOfFieldEffectBlurLevel,
} from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials';
import { Weather } from '../models';

@Injectable({ providedIn: 'root' })
export class SceneService {
  private zone = inject(NgZone);

  engine!:    WebGPUEngine | Engine;
  scene!:     Scene;
  private _isWebGPU = false;
  /** True when the session is running on a WebGPU backend. */
  get isWebGPU(): boolean { return this._isWebGPU; }
  camera!: FreeCamera;

  private skyMat!:    SkyMaterial;
  private skyMesh:    any;
  private sun!:       DirectionalLight;
  private moonLight!: DirectionalLight;
  private ambient!:   HemisphericLight;
  private sunMesh!:   Mesh;
  private glowLayer!: GlowLayer;

  /** Exclude a mesh from the glow/emissive composite pass (WebGPU-safe). */
  excludeFromGlow(mesh: Mesh): void {
    this.glowLayer?.addExcludedMesh(mesh);
  }

  /**
   * Exclude a material from the prePass G-buffer render (normals/depth).
   * Use for custom WGSL ShaderMaterials — Babylon's prePass compiler can't
   * generate a G-buffer variant for them, which would break SSAO2 and DoF.
   */
  excludeFromPrePass(material: Material): void {
    const prePass = this.scene?.prePassRenderer;
    if (!prePass) return;
    if (!prePass.excludedMaterials.includes(material)) {
      prePass.excludedMaterials.push(material);
    }
  }

  // Shadow generator — attached to the sun DirectionalLight and exposed so that
  // VesselService, TerrainService, CannonService, and MultiplayerService can
  // register their meshes as casters / receivers.
  shadowGenerator!: ShadowGenerator;
  private pipeline!: DefaultRenderingPipeline;
  private _aaQuality = 1; // 0=Off 1=FXAA 2=MSAA2x 3=MSAA4x

  // Public signal so the HUD can display the current game time.
  gameTime = signal(10.5);  // 0–24 hours

  // Weather-driven cloudiness proxy used to shape SkyMaterial haze/brightness.
  private skyCloudiness = 0.25;
  private targetSkyCloudiness = 0.25;

  // Sun glare occlusion: 0 = fully blocked by terrain, 1 = fully visible.
  private sunOcclusionT = 1.0;
  private sunOcclusionFrame = 0;
  private lastSunOccluded = false;

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
  private _cachedBloomThreshold = 0.78;
  private _cachedBloomEnabled = true;
  private _cachedGrainAnimated = true;
  private _cachedGrainIntensity = 12;

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

      // ── Engine selection: prefer WebGPU, fall back to WebGL ─────────────────
      const FORCE_WEBGL = false;
      const gpuSupported = !FORCE_WEBGL && typeof navigator !== 'undefined' && !!navigator.gpu;

      if (gpuSupported) {
        try {
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
          this._isWebGPU = true;
          console.log('[Scene] WebGPU engine active');
        } catch (err) {
          console.warn('[Scene] WebGPU init failed — falling back to WebGL:', err);
          this.engine   = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
          this._isWebGPU = false;
        }
      } else {
        console.log('[Scene] WebGPU not available — using WebGL');
        this.engine   = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
        this._isWebGPU = false;
      }

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
    skybox.renderingGroupId = 0;
    skybox.isPickable       = false;
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

  private buildCelestialBodies(): void {
    this.glowLayer = new GlowLayer('glow', this.scene, {
      mainTextureFixedSize: 512,
      blurKernelSize: 64,
    });

    const sunMat = new StandardMaterial('sunMat', this.scene);
    sunMat.disableLighting = true;
    sunMat.emissiveColor = new Color3(1.0, 0.95, 0.68);
    sunMat.specularColor = Color3.Black();

    this.sunMesh = MeshBuilder.CreatePlane('sunDisk', { size: 2200 }, this.scene);
    this.sunMesh.material = sunMat;
    this.sunMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.sunMesh.isPickable = false;
    this.sunMesh.renderingGroupId = 2;
    this.glowLayer.addIncludedOnlyMesh(this.sunMesh);
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

    // FXAA / MSAA — applied LAST so that all the property setters above (each of
    // which triggers an internal _buildPipeline() call in Babylon.js) have already
    // fired before we stamp the AA state.  Applying it earlier means sharpen /
    // grain / DOF / imageProcessing rebuilds can silently discard the FXAA pass
    // — exactly the "looks off on first load but fine after toggling" symptom.
    // The deferred re-apply catches any async WebGPU pipeline reconstruction that
    // Babylon.js schedules on the following frame.
    const storedAa = parseInt(localStorage.getItem('ignis_aa_quality') ?? '1', 10);
    this._aaQuality = isNaN(storedAa) ? 1 : Math.max(0, Math.min(3, storedAa));
    this.applyAaQuality();
    setTimeout(() => this.applyAaQuality(), 0);
  }

  // ── Anti-aliasing quality ──────────────────────────────────────────────────

  private applyAaQuality(): void {
    if (!this.pipeline) return;
    switch (this._aaQuality) {
      case 0: this.pipeline.fxaaEnabled = false; this.pipeline.samples = 1; break;
      case 1: this.pipeline.fxaaEnabled = true;  this.pipeline.samples = 1; break;
      case 2: this.pipeline.fxaaEnabled = true;  this.pipeline.samples = 2; break;
      case 3: this.pipeline.fxaaEnabled = true;  this.pipeline.samples = 4; break;
    }
  }

  getAaQuality(): number { return this._aaQuality; }

  setAaQuality(level: number): void {
    this._aaQuality = Math.max(0, Math.min(3, Math.round(level)));
    localStorage.setItem('ignis_aa_quality', String(this._aaQuality));
    this.applyAaQuality();
  }

  getSkyMesh(): any { return this.skyMesh; }

  /** Returns a unit vector pointing FROM the scene origin TOWARD the sun. */
  getSunDirection(): Vector3 { return this.computeSunDir(); }

  updateFogDensity(density: number): void {
    if (this.scene) this.scene.fogDensity = density;
  }

  updateSkyFromWeather(weather: Weather): void {
    this.targetSkyCloudiness = Math.max(0, Math.min(1, weather.cloudiness));
  }

  // ── Time of day ──────────────────────────────────────────────────────────────

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
    const isNight = h < -0.05;
    // Spikes near horizon for sunrise/sunset colour effects
    const horizon = Math.max(0, 1 - Math.abs(h) / 0.22);

    // ── SkyMaterial ───────────────────────────────────────────────────────────
    this.skyCloudiness += (this.targetSkyCloudiness - this.skyCloudiness) * Math.min(1, dt * 0.35);
    const cloud = this.skyCloudiness;

    // inclination: 0 = at horizon, 0.45 ≈ high noon, negative = below horizon.
    this.skyMat.inclination = h * 0.45;
    this.skyMat.azimuth = (this.gameHours / 24 * 0.5 + 0.1) % 1;

    // Blend time-of-day haze with weather cloudiness to emulate overcast skies.
    this.skyMat.turbidity = Math.min(10, 2.0 + horizon * 4.0 + cloud * 4.0);
    this.skyMat.mieCoefficient = Math.min(0.03, 0.005 + horizon * 0.01 + cloud * 0.02);
    this.skyMat.mieDirectionalG = 0.97 - horizon * 0.07;
    this.skyMat.rayleigh = Math.max(0.5, 2.2 - cloud * 1.2);
    this.skyMat.luminance = Math.max(0.35, 1.0 - cloud * 0.35);

    if (this.camera) {
      const sunPos = this.camera.position.add(dir.scale(65000));
      this.sunMesh.position.copyFrom(sunPos);

      const sunShouldBeOn = h > -0.06;
      let occT = 1.0;
      if (sunShouldBeOn) {
        const blocked = this.isSunOccluded(dir);
        const target = blocked ? 0.0 : 1.0;
        this.sunOcclusionT += (target - this.sunOcclusionT) * 0.50;
      } else {
        this.sunOcclusionT = 1.0;
      }
      occT = this.sunOcclusionT;

      this.sunMesh.scaling.setAll((1.0 + Math.max(0, 0.88 - above) * 3.0) * occT);
      this.sunMesh.visibility = Math.max(0.0, above) * occT;

      const sunMat = this.sunMesh.material as StandardMaterial;
      sunMat.emissiveColor = new Color3(
        1.0 * occT,
        Math.min(1, 0.28 + above * 0.72) * occT,
        Math.min(1, 0.10 + above * 0.82) * occT,
      );
      // Clamp solar glow below the horizon so terrain cannot be brightened by bloom/glow at night.
      this.glowLayer.intensity = h > 0.02
        ? Math.min(1.4, (0.25 + horizon * 1.8 + above * 0.3) * occT)
        : 0;
    }

    // ── Post-processing: bloom and exposure surge at golden hour ──────────────
    if (this.pipeline) {
      // Hard-disable dynamic post FX at night to eliminate visible luminance pulsing.
      const bloomEnabled = !isNight;
      if (bloomEnabled !== this._cachedBloomEnabled) {
        this.pipeline.bloomEnabled = bloomEnabled;
        this._cachedBloomEnabled = bloomEnabled;
      }

      const grainAnimated = !isNight;
      if (grainAnimated !== this._cachedGrainAnimated) {
        this.pipeline.grain.animated = grainAnimated;
        this._cachedGrainAnimated = grainAnimated;
      }

      const grainIntensity = isNight ? 4 : 12;
      if (Math.abs(grainIntensity - this._cachedGrainIntensity) > this.PIPELINE_EPS) {
        this.pipeline.grain.intensity = grainIntensity;
        this._cachedGrainIntensity = grainIntensity;
      }

      // 0 in daytime, ramps to 1 shortly after sunset to suppress non-emissive glow.
      const nightBlend = isNight ? 1 : Math.max(0, Math.min(1, (-h - 0.03) / 0.20));

      // bloomWeight: throttle like exposure/contrast — the DefaultRenderingPipeline
      // setter chain fires internal observers on every write.
      const dayBloomW = Math.max(0.12, 0.26 + horizon * 0.58 - cloud * 0.30);
      const newBloomW = Math.max(0, dayBloomW * (1 - nightBlend));
      if (Math.abs(newBloomW - this._cachedBloomW) > this.PIPELINE_EPS) {
        this.pipeline.bloomWeight = newBloomW;
        this._cachedBloomW = newBloomW;
      }

      const newBloomThreshold = 0.78 + nightBlend * 0.35;
      if (Math.abs(newBloomThreshold - this._cachedBloomThreshold) > this.PIPELINE_EPS) {
        this.pipeline.bloomThreshold = newBloomThreshold;
        this._cachedBloomThreshold = newBloomThreshold;
      }

      // exposure and contrast setters fire onUpdateParameters with NO equality
      // guard, notifying every subscribed StandardMaterial to mark sub-meshes
      // dirty each frame — with hundreds of biome meshes this causes a sustained
      // WebGPU bind-group recreation stall during dawn/dusk.  Only push a new
      // value when it has changed by more than PIPELINE_EPS (≈ every 0.5 s
      // real-time during the transition window, invisible at the rate the sky moves).
      const newExposure = isNight
        ? 0.72    // was 0.58 — too dark to see terrain at all at night
        : Math.max(0.52, 1.0 + horizon * 0.40 - cloud * 0.16 - nightBlend * 0.38);
      const newContrast = isNight
        ? 1.06
        : Math.max(1.0, 1.08 + horizon * 0.12 - cloud * 0.05);
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
    this.sun.intensity = above * (1.35 * (1 - cloud * 0.55));
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
    // Raised from 0.28/0.35 — peaks at 0.50 at midnight so terrain reads as moonlit
    // rather than pitch-black.  Cloud cover attenuates as before.
    this.moonLight.intensity = (isNight ? Math.max(0, -h * 0.50) : Math.max(0, -h * 0.60)) * (1 - cloud * 0.35);

    // ── Hemisphere (ambient sky fill) ─────────────────────────────────────────
    // Golden hour: warm amber fill; daytime: neutral blue-white; night: dim blue.
    // Night ambient raised from 0.14 → 0.28 so mountains are visible by starlight/
    // moonlight and don't render as featureless black silhouettes.
    this.ambient.intensity = isNight
      ? 0.28 + cloud * 0.05
      : 0.10 + above * 0.38 + cloud * 0.06;
    // Lerp between standard daylight ambient and warm golden-hour tones.
    const dayAmbient  = isNight
      ? new Color3(0.30, 0.38, 0.52)   // brighter blue — was (0.20, 0.25, 0.35)
      : new Color3(0.52 + above * 0.38, 0.58 + above * 0.32, 0.84 + above * 0.16);
    const warmAmbient = new Color3(1.0, 0.68, 0.30);
    // Restrict warm amber fill to daytime golden hour only.
    const warmMix = h > 0 ? horizon * 0.60 : 0;
    this.ambient.diffuse     = Color3.Lerp(dayAmbient, warmAmbient, warmMix);
    this.ambient.groundColor = isNight
      ? new Color3(0.09, 0.12, 0.22)   // was (0.05, 0.07, 0.14) — raised for visibility
      : new Color3(
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

    fog = Color3.Lerp(fog, new Color3(0.60, 0.65, 0.72), cloud * 0.45);

    this.scene.fogColor   = fog;
    this.scene.clearColor = new Color4(fog.r * 0.20, fog.g * 0.20, fog.b * 0.30, 1);
  }

  /**
   * CPU ray-cast: is any island terrain mesh blocking the camera→sun ray?
   */
  private isSunOccluded(sunDir: Vector3): boolean {
    if (!this.camera) return false;

    if (sunDir.y < 0.02) {
      this.lastSunOccluded = false;
      return false;
    }

    this.sunOcclusionFrame = (this.sunOcclusionFrame + 1) % 8;
    if (this.sunOcclusionFrame !== 0) return this.lastSunOccluded;

    const rayLen = Math.min(25_000, 800 / sunDir.y);
    const ray = new Ray(this.camera.position, sunDir, rayLen);
    const onlyBB = sunDir.y < 0.12;

    for (const mesh of this.scene.meshes) {
      if (!mesh.isEnabled() || !mesh.name.startsWith('island_')) continue;
      if (ray.intersectsMesh(mesh, false, undefined, onlyBB).hit) {
        this.lastSunOccluded = true;
        return true;
      }
    }

    this.lastSunOccluded = false;
    return false;
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
