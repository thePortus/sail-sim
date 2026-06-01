import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Engine, WebGPUEngine, Scene, Color3, Color4, Vector3,
  HemisphericLight, DirectionalLight,
  FreeCamera, MeshBuilder, StandardMaterial, Mesh, Material, GlowLayer,
  DefaultRenderingPipeline, ShadowGenerator, CascadedShadowGenerator,
  SSAO2RenderingPipeline, DepthOfFieldEffectBlurLevel,
  DepthRenderer, RenderTargetTexture, Texture, Constants, DynamicTexture,
  SceneInstrumentation, EngineInstrumentation,
} from '@babylonjs/core';
import { SkyMaterial, CustomMaterial } from '@babylonjs/materials';
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
  private moonMesh!:  Mesh;
  private starDome: Mesh | null = null;
  private starMat:  CustomMaterial | null = null;
  private _starTime = 0;
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

  // Lightning flash: additive boost to ambient light, driven by CloudService.
  // 0 = no flash; ~1 = full strike. Applied on top of the time-of-day ambient.
  private _lightningFlash = 0;
  /** Set each frame by CloudService to flash the scene during storms (0–1+). */
  setLightningFlash(amount: number): void { this._lightningFlash = Math.max(0, amount); }

  // Dedicated camera-space-Z depth map of all opaque geometry EXCEPT the ocean.
  // The ocean shader samples this to find where the hull / shore sits just behind
  // the water surface and lays a soft foam wash there, hiding the hard aliased
  // waterline edge. Empty pixels clear to 1e8 (treated as "infinitely far").
  private oceanDepthRenderer: DepthRenderer | null = null;
  private _oceanDepthMap: RenderTargetTexture | null = null;
  /** Camera-space-Z depth of opaque geometry (ocean excluded). Null until built. */
  get oceanDepthMap(): RenderTargetTexture | null { return this._oceanDepthMap; }

  // Public signal so the HUD can display the current game time.
  gameTime = signal(10.5);  // 0–24 hours

  // Weather-driven cloudiness proxy used to shape SkyMaterial haze/brightness.
  private skyCloudiness = 0.25;
  private targetSkyCloudiness = 0.25;

  // Sun glare occlusion: 0 = fully blocked by terrain, 1 = fully visible.
  private sunOcclusionT = 1.0;
  private sunOcclusionFrame = 0;
  private lastSunOccluded = false;

  // Moon occlusion (same scheme as the sun, separate state).
  private moonOcclusionT = 1.0;
  private moonOcclusionFrame = 0;
  private lastMoonOccluded = false;

  // Terrain height query, injected by TerrainService once its heightfield is
  // ready (avoids a DI cycle). Returns terrain elevation in metres at a world
  // XZ. Used to ray-march sun occlusion against the mountains.
  private terrainHeightSampler: ((x: number, z: number) => number) | null = null;
  /** Called by TerrainService so the sun can be occluded by the heightfield. */
  setTerrainHeightSampler(fn: (x: number, z: number) => number): void {
    this.terrainHeightSampler = fn;
  }

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

      // Render at the display's native pixel density. Without this the backing
      // buffer is sized in CSS pixels and the browser upscales it to physical
      // pixels on HiDPI/Retina screens — making the whole frame soft and thin
      // geometry (mast, rigging, hull outline) stair-step regardless of MSAA/FXAA,
      // because the aliasing happens during the upscale AFTER anti-aliasing runs.
      // Load the stored AA level first (it caps the resolution) and apply before
      // any render targets are created so they size to the final resolution.
      const storedAa = parseInt(localStorage.getItem('ignis_aa_quality') ?? '1', 10);
      this._aaQuality = isNaN(storedAa) ? 1 : Math.max(0, Math.min(3, storedAa));
      this.applyResolutionScale();

      this.scene = new Scene(this.engine);
      this.scene.fogMode    = Scene.FOGMODE_EXP2;
      this.scene.fogDensity = 0.000035;

      this.buildSky();
      this.buildLights();
      this.buildCelestialBodies();
      this.buildStars();
      this.buildCamera(canvas);
      this.buildPostProcessing();
      this.buildOceanDepthRenderer();
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
    const csg = new CascadedShadowGenerator(512, this.sun);  // was 1024 — cheaper map
    csg.numCascades        = 3;                              // render/clear; fine at the
    // NOTE: filteringQuality and sun.shadowEnabled both produce a broken shadow
    // shader on this WebGPU path (scene renders black). Leave filtering at the
    // default — shadows are NOT a safe perf lever here. Use the RTT off-switches.
    csg.stabilizeCascades  = true;   // reduces shimmering as camera pans
    csg.lambda             = 0.75;   // 0 = uniform splits, 1 = logarithmic
    csg.shadowMaxZ         = 200;    // shadows discarded beyond 200 u (was 400): distant
                                     // terrain skips all shadow work, and the 3 cascades
                                     // pack into a tighter range → sharper near shadows.
    csg.bias               = 0.001;
    csg.normalBias         = 0.02;
    csg.darkness           = 0.05;   // 0 = fully opaque shadow, 1 = invisible
    csg.transparencyShadow = true;   // sails/flag cloth casts transparent shadows
    // Render the shadow map EVERY frame. (An earlier every-other-frame throttle made
    // the boat's shadow lag on alternate frames → visible wobble as the ship bobs. With
    // the 42k forest trees gone, only the ship + a few near palms cast, so the shadow
    // pass is cheap and every-frame is fine.)
    const shadowMap = csg.getShadowMap();
    if (shadowMap) shadowMap.refreshRate = 1;
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

    // Moon — a rocky, self-glowing sphere built from a procedural crater texture.
    // disableLighting + emissiveTexture means it shows its surface fully lit (a
    // glowing full moon) regardless of scene lighting; the glow layer adds a halo.
    const moonMat = new StandardMaterial('moonMat', this.scene);
    moonMat.disableLighting = true;
    moonMat.emissiveTexture = this.buildMoonTexture();
    moonMat.emissiveColor   = new Color3(0.82, 0.88, 1.0);   // cool moonlight tint
    moonMat.diffuseColor    = Color3.Black();
    moonMat.specularColor   = Color3.Black();

    this.moonMesh = MeshBuilder.CreateSphere('moonDisk', { diameter: 1900, segments: 32 }, this.scene);
    this.moonMesh.material = moonMat;
    this.moonMesh.isPickable = false;
    this.moonMesh.renderingGroupId = 2;
    this.moonMesh.visibility = 0;
    this.glowLayer.addIncludedOnlyMesh(this.moonMesh);
  }

  // ── Stars ───────────────────────────────────────────────────────────────────
  // A procedural starfield on an infinite-distance dome (renders as background with
  // the skybox), faded in as the sun drops. Stars vary in size, brightness, and very
  // slightly in colour (cool blue-white ↔ faint warm amber), with a faint Milky Way
  // band — baked into a texture so there's no fragile custom shader. Drifts slowly.
  private buildStars(): void {
    const tex = this.buildStarTexture();

    const mat = new CustomMaterial('starMat', this.scene);
    mat.disableLighting = true;
    mat.emissiveTexture = tex;
    mat.opacityTexture  = tex;            // alpha from the texture → black sky stays clear
    mat.diffuseColor    = Color3.Black();
    mat.specularColor   = Color3.Black();
    mat.backFaceCulling = false;          // viewed from inside the dome
    mat.alpha = 0;                        // faded in at night by tickTimeOfDay
    // Soft twinkle: a high-spatial-frequency, low-amplitude shimmer (product of sines) so
    // different stars dim/brighten at different times. uStarTime advances in tickTimeOfDay.
    mat.AddUniform('uStarTime', 'float', null);
    mat.Fragment_Before_FragColor(`
      float tw = 0.80 + 0.20 * sin(vPositionW.x * 0.0021 + uStarTime * 3.0)
                             * sin(vPositionW.y * 0.0017 + uStarTime * 2.2)
                             * sin(vPositionW.z * 0.0019 - uStarTime * 2.6);
      color.rgb *= tw;
    `);
    mat.onBindObservable.add(() => {
      const fx = mat.getEffect();
      if (fx) fx.setFloat('uStarTime', this._starTime);
    });
    this.starMat = mat;

    const dome = MeshBuilder.CreateSphere('starDome', { diameter: 140000, segments: 24 }, this.scene);
    dome.material         = mat;
    dome.infiniteDistance = true;         // follow the camera, render at the far background
    dome.renderingGroupId = 0;            // with the skybox; transparent → draws over it
    dome.applyFog         = false;        // stars must not be tinted by scene fog
    dome.isPickable       = false;
    dome.setEnabled(false);               // off during the day
    this.starDome = dome;
  }

  /** Procedurally paints a starfield (varied size / brightness / slight colour + a faint
   *  Milky Way band) into a transparent texture. */
  private buildStarTexture(): DynamicTexture {
    const W = 2048, H = 1024;
    const tex = new DynamicTexture('starTex', { width: W, height: H }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';   // overlapping glows accumulate

    const rnd = Math.random;

    // Faint Milky Way: extra dim stars scattered along a gently sloped diagonal band.
    const mwY = H * 0.40, mwSlope = -0.12;
    for (let i = 0; i < 1600; i++) {
      const x = rnd() * W;
      const y = mwY + (x - W * 0.5) * mwSlope + (rnd() - 0.5) * H * 0.18;
      const b = Math.pow(rnd(), 3.0) * 0.5;
      ctx.fillStyle = `rgba(232,236,255,${0.04 + b * 0.22})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.4 + b * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Main starfield: most faint & tiny, a few bright & large; subtle colour spread.
    const STAR_COUNT = 2600;
    for (let i = 0; i < STAR_COUNT; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const b = Math.pow(rnd(), 2.2);                              // brightness, weighted faint
      const radius = 0.4 + b * 0.78 + (rnd() < 0.010 ? 0.55 : 0.0); // size: smaller still, rare few bigger
      const cr = rnd();
      let r = 255, g = 252, bl = 246;                              // near-white default
      if (cr < 0.18)      { r = 255; g = 238; bl = 212; }          // warm / amber
      else if (cr > 0.82) { r = 212; g = 229; bl = 255; }          // cool blue-white
      const a = 0.25 + b * 0.75;
      const grd = ctx.createRadialGradient(x, y, 0, x, y, radius * 1.7);
      grd.addColorStop(0,   `rgba(${r},${g},${bl},${a})`);
      grd.addColorStop(0.5, `rgba(${r},${g},${bl},${a * 0.35})`);
      grd.addColorStop(1,   `rgba(${r},${g},${bl},0)`);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    tex.update();
    return tex;
  }

  /**
   * Procedural rocky moon: a grey surface with darker "maria" patches and many
   * craters (dark floor + bright rim), built once into a DynamicTexture. Used as
   * the moon's emissive map so no external image asset is needed.
   */
  private buildMoonTexture(): DynamicTexture {
    const S = 512;
    const tex = new DynamicTexture('moonTex', { width: S, height: S }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;

    // Deterministic RNG so the moon looks the same every run.
    let s = 0x9e3779b1 >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0xffffffff; };

    // Base regolith grey.
    ctx.fillStyle = '#b6bac2';
    ctx.fillRect(0, 0, S, S);

    // Maria — large darker basaltic plains.
    for (let i = 0; i < 8; i++) {
      const x = rnd() * S, y = rnd() * S, r = 50 + rnd() * 130;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(118,122,132,0.55)');
      g.addColorStop(1, 'rgba(118,122,132,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    // Craters — dark bowl with a brighter rim.
    for (let i = 0; i < 110; i++) {
      const x = rnd() * S, y = rnd() * S, r = 2 + rnd() * rnd() * 24;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0.0, 'rgba(86,88,96,0.6)');
      g.addColorStop(0.7, 'rgba(140,144,152,0.15)');
      g.addColorStop(1.0, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(226,229,236,0.45)';
      ctx.lineWidth = Math.max(0.5, r * 0.12);
      ctx.beginPath(); ctx.arc(x, y, r * 0.95, 0, Math.PI * 2); ctx.stroke();
    }

    tex.update();
    return tex;
  }

  // ── Camera ───────────────────────────────────────────────────────────────────

  private buildCamera(canvas: HTMLCanvasElement): void {
    this.camera = new FreeCamera('mainCam', new Vector3(7000, 12, -20), this.scene);
    this.camera.minZ = 0.5;
    this.camera.maxZ = 120000;
    this.camera.fov  = 1.1;
  }

  // ── Ocean depth map ───────────────────────────────────────────────────────────
  // A dedicated depth pass that stores camera-space Z (linear world-unit depth)
  // of every opaque mesh EXCEPT the ocean itself. The ocean fragment shader
  // compares its own camera-space Z against this to detect where the hull (or
  // shore) sits just behind the water surface, then feathers a soft foam wash
  // over that band — softening the hard, aliased waterline silhouette that MSAA
  // and FXAA can't resolve. NEAREST sampling avoids smearing hull depth into the
  // 1e8 "empty" clear value at silhouette edges.
  private buildOceanDepthRenderer(): void {
    const depthRenderer = new DepthRenderer(
      this.scene,
      Constants.TEXTURETYPE_FLOAT, // wide range — camera-space Z up to maxZ / 1e8 clear
      this.camera,
      /* storeNonLinearDepth */ false,
      Texture.NEAREST_SAMPLINGMODE,
      /* storeCameraSpaceZ  */ true,
    );
    const depthMap = depthRenderer.getDepthMap();
    // Exclude the four ocean LOD meshes (all named 'ocean_*') so open water reads
    // the 1e8 clear (= "far") rather than its own surface depth.
    depthMap.renderListPredicate = (m) => !m.name.startsWith('ocean_');
    // Every frame: at low FPS an every-other-frame depth pass makes the soft-waterline
    // foam around the bobbing hull strobe. (Was 2 for perf; the strobe wasn't worth it.)
    depthMap.refreshRate = 1;
    this.scene.customRenderTargets.push(depthMap);

    this.oceanDepthRenderer = depthRenderer;
    this._oceanDepthMap = depthMap;
  }

  // ── Post-processing pipeline ──────────────────────────────────────────────────

  private buildPostProcessing(): void {
    this.pipeline = new DefaultRenderingPipeline('mainPipeline', true, this.scene, [this.camera]);

    // Bloom — makes emissive meshes (sun disk, torches) bleed light into the scene.
    // Weight and exposure are boosted dynamically at golden hour in tickTimeOfDay().
    this.pipeline.bloomEnabled   = true;
    this.pipeline.bloomThreshold = 0.78;
    this.pipeline.bloomWeight    = 0.28;
    // Perf: kernel 128→48 and scale 0.5→0.33. The wide-kernel blur on a HiDPI
    // framebuffer was the entire daytime FPS hit (bloom is off at night, which is
    // why daytime ran ~14 vs ~22 at night). The glow is a touch tighter — barely
    // perceptible — for roughly 4× cheaper bloom.
    this.pipeline.bloomKernel    = 48;
    this.pipeline.bloomScale     = 0.33;

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

    // Sharpening — restores a little crispness to rigging and deck detail after
    // FXAA / SSAO's bilateral blur. Kept low: a high edgeAmount amplifies contrast
    // across the highest-contrast silhouette in the scene — the dark hull against
    // the bright ocean — which un-does FXAA's edge smoothing and makes the
    // waterline look pixelated/stair-stepped. 0.08 keeps detail without re-aliasing.
    this.pipeline.sharpenEnabled         = true;
    this.pipeline.sharpen.edgeAmount     = 0.08;
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
    // Render resolution is part of the same quality dial (it's the single biggest
    // quality/perf lever), so re-apply it whenever the AA level changes.
    this.applyResolutionScale();
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
      // ── Moon: rocky glowing sphere at the anti-solar point ───────────────────
      // Fades in as the sun drops below the horizon, sits opposite the sun, spins
      // slowly, and is occluded by mountains just like the sun.
      const moonDir = dir.scale(-1);
      const moonBlocked = this.isMoonOccluded(moonDir);
      this.moonOcclusionT += ((moonBlocked ? 0.0 : 1.0) - this.moonOcclusionT) * 0.50;

      const moonVis = Math.max(0, Math.min(1, (0.04 - h) / 0.16)) * this.moonOcclusionT;
      this.moonMesh.position.copyFrom(this.camera.position.add(moonDir.scale(62000)));
      this.moonMesh.visibility = moonVis;
      this.moonMesh.rotation.y += dt * 0.012;

      // Stars: fade in as the sun drops below the horizon; the dome drifts very slowly.
      if (this.starDome && this.starMat) {
        const starF = Math.max(0, Math.min(1, (-h - 0.02) / 0.16));
        this.starDome.setEnabled(starF > 0.001);
        this.starMat.alpha = starF * 0.95;
        this.starDome.rotation.y += dt * 0.001;
        this._starTime += dt;
      }

      // Glow layer includes ONLY the sun & moon: solar halo by day, lunar halo by
      // night. Clamped so neither bleeds at the wrong time of day.
      const sunGlow = h > 0.02
        ? Math.min(1.4, (0.25 + horizon * 1.8 + above * 0.3) * occT)
        : 0;
      this.glowLayer.intensity = Math.max(sunGlow, moonVis * 0.55);
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
    this.ambient.intensity = (isNight
      ? 0.28 + cloud * 0.05
      : 0.10 + above * 0.38 + cloud * 0.06)
      + this._lightningFlash * 2.6;   // lightning flash brightens the whole scene
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

    // Overcast/storm pulls fog toward a flat grey — but that grey must follow the
    // light level, otherwise a night storm blends toward bright daytime grey and
    // makes distant islands glow unnaturally. Dark storm-grey at night → bright
    // overcast by day.
    const fogDayLight = Math.max(0, Math.min(1, (h + 0.05) / 0.35));
    // Daytime overcast: bright grey under light cloud, but a thick storm (cloud
    // near 1) should read DARK and moody — otherwise the fog washes distant
    // islands brighter than the storm sky behind them.
    const stormDark = Math.max(0, (cloud - 0.45) / 0.45);   // ramps in earlier & faster
    const overcastDay = Color3.Lerp(
      new Color3(0.58, 0.63, 0.70),   // light overcast: bright grey
      new Color3(0.19, 0.22, 0.27),   // full storm: dark, matches the moody sky
      stormDark,
    );
    const overcast = Color3.Lerp(
      new Color3(0.05, 0.06, 0.09),   // night storm: dark grey, no glow
      overcastDay,
      fogDayLight,
    );
    // Heavier cloud washes the fog more fully toward the (now darker) overcast, so distant
    // islands don't read brighter than the dark storm sky behind them.
    fog = Color3.Lerp(fog, overcast, Math.min(0.92, cloud * (0.45 + stormDark * 0.45)));

    this.scene.fogColor   = fog;
    this.scene.clearColor = new Color4(fog.r * 0.20, fog.g * 0.20, fog.b * 0.30, 1);
  }

  /**
   * Ray-marches the terrain heightfield from the camera along a unit direction:
   * returns true if any terrain surface rises above the ray (i.e. a mountain
   * blocks the line of sight). Cheap — array lookups with a growing step — and
   * used to occlude both the sun and the moon. NOT throttled; callers throttle.
   */
  private marchTerrainBlock(dir: Vector3): boolean {
    if (!this.camera || !this.terrainHeightSampler) return false;
    if (dir.y < 0.02) return false;                 // pointing at/below horizon → nothing above

    const cam = this.camera.position;
    const MAX_DIST   = 30_000;   // how far to look for blocking terrain
    const MAX_HEIGHT = 1_500;    // once the ray clears the tallest peaks, it's unblocked
    const sample = this.terrainHeightSampler;

    // Step size grows with distance — fine near the camera, coarse far away.
    for (let d = 120; d < MAX_DIST; d += 40 + d * 0.02) {
      const rayY = cam.y + dir.y * d;
      if (rayY > MAX_HEIGHT) break;                 // above all terrain → clear
      if (sample(cam.x + dir.x * d, cam.z + dir.z * d) > rayY) return true;
    }
    return false;
  }

  /** Throttled (every 8th frame) sun occlusion — stops the sun shining through mountains. */
  private isSunOccluded(sunDir: Vector3): boolean {
    this.sunOcclusionFrame = (this.sunOcclusionFrame + 1) % 8;
    if (this.sunOcclusionFrame !== 0) return this.lastSunOccluded;
    this.lastSunOccluded = this.marchTerrainBlock(sunDir);
    return this.lastSunOccluded;
  }

  /** Throttled (every 8th frame, offset from the sun) moon occlusion. */
  private isMoonOccluded(moonDir: Vector3): boolean {
    this.moonOcclusionFrame = (this.moonOcclusionFrame + 1) % 8;
    if (this.moonOcclusionFrame !== 4) return this.lastMoonOccluded;
    this.lastMoonOccluded = this.marchTerrainBlock(moonDir);
    return this.lastMoonOccluded;
  }

  // ── Render loop ───────────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    // FPS overlay — hidden by default, toggled with the backtick (`) key.
    // (F12 can't be used: browsers reserve it for DevTools and block preventDefault.)
    const fpsEl = document.createElement('div');
    fpsEl.style.cssText =
      'position:fixed;top:6px;left:6px;z-index:99999;text-align:left;line-height:1.45;' +
      'font:600 12px ui-monospace,monospace;color:#9effa0;background:rgba(0,0,0,0.62);' +
      'padding:6px 9px;border-radius:6px;pointer-events:none;display:none;white-space:pre;';
    document.body.appendChild(fpsEl);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') {
        fpsEl.style.display = fpsEl.style.display === 'none' ? 'block' : 'none';
      }
    });

    // Perf instrumentation — only read when the overlay is visible. Breaks the
    // frame into CPU (active-mesh eval, render-targets, inter-frame JS) and GPU
    // time so we can see exactly what's pinning the frame rate.
    const sInstr = new SceneInstrumentation(this.scene);
    sInstr.captureActiveMeshesEvaluationTime = true;
    sInstr.captureRenderTargetsRenderTime = true;
    sInstr.captureRenderTime = true;
    sInstr.captureFrameTime = true;
    sInstr.captureInterFrameTime = true;
    const eInstr = new EngineInstrumentation(this.engine);
    eInstr.captureGPUFrameTime = true;
    let perfFrame = 0;

    let lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.05);
      lastTime  = now;
      this.tickTimeOfDay(dt);
      this.scene.render();
      if (fpsEl.style.display !== 'none' && (perfFrame++ % 15) === 0) {
        const ms = (c: { lastSecAverage: number }) => c.lastSecAverage.toFixed(1);
        const gpuMs = (eInstr.gpuFrameTimeCounter.lastSecAverage / 1e6) || 0;
        fpsEl.textContent =
          `${this.engine.getFps().toFixed(0)} FPS   (${sInstr.frameTimeCounter.lastSecAverage.toFixed(1)} ms/frame)\n` +
          `gpu        ${gpuMs ? gpuMs.toFixed(1) + ' ms' : 'n/a'}\n` +
          `evalMeshes ${ms(sInstr.activeMeshesEvaluationTimeCounter)} ms\n` +
          `renderTgts ${ms(sInstr.renderTargetsRenderTimeCounter)} ms\n` +
          `mainRender ${ms(sInstr.renderTimeCounter)} ms\n` +
          `interFrame ${ms(sInstr.interFrameTimeCounter)} ms (cpu/js)\n` +
          `draws ${sInstr.drawCallsCounter.lastSecAverage | 0}   activeMeshes ${this.scene.getActiveMeshes().length}`;
      }
    });
    window.addEventListener('resize', () => {
      this.applyResolutionScale();
      this.engine.resize();
    });
  }

  // Render resolution is now its own user setting (the single biggest perf/quality
  // lever), independent of AA. _renderScale is a fraction (0.5–1.0) of the display's
  // native pixel density (native = min(devicePixelRatio, 2), capped to bound cost
  // on very-high-DPR screens). 1.0 = full native (sharpest, current look); 0.5 =
  // half-res (quarter the pixels → big FPS win, softer). Persisted to localStorage.
  private readonly MAX_PIXEL_RATIO = 2;
  private _renderScale = (() => {
    const r = parseFloat(localStorage.getItem('ignis_render_scale') ?? '1');
    return isNaN(r) ? 1 : Math.max(0.5, Math.min(1.0, r));
  })();

  getRenderScale(): number { return this._renderScale; }

  setRenderScale(scale: number): void {
    this._renderScale = Math.max(0.5, Math.min(1.0, scale));
    localStorage.setItem('ignis_render_scale', String(this._renderScale));
    this.applyResolutionScale();
  }

  private applyResolutionScale(): void {
    if (!this.engine) return;
    const native = Math.min(window.devicePixelRatio || 1, this.MAX_PIXEL_RATIO);
    const eff = Math.max(0.25, native * this._renderScale);
    this.engine.setHardwareScalingLevel(1 / eff);
  }

  /**
   * Drive the real cascaded shadow MAP from the Shadows quality setting (the same
   * slider also controls the separate raymarched terrain-shadow mask in
   * TerrainService — this is the half that was never wired up).
   *   0 Off  — shadow map not rendered at all
   *   1 Low  — 2 cascades, every-other-frame
   *   2 Med  — 3 cascades, every-other-frame (default)
   *   3 High — 3 cascades, every frame
   */
  setShadowMapQuality(level: number): void {
    if (!this.shadowGenerator) return;
    const csg = this.shadowGenerator as CascadedShadowGenerator;
    // Do NOT toggle sun.shadowEnabled — flipping it recompiles every receiver shader
    // and blanks the scene on WebGPU. Vary only cascade count + refresh rate, which
    // recompile to a valid shadow shader and render fine. Level 0 = cheapest (1
    // cascade, quarter-rate); 3 = best (3 cascades, every frame).
    const cascades = level <= 0 ? 1 : (level === 1 ? 2 : 3);
    if (csg.numCascades !== cascades) csg.numCascades = cascades;
    const sm = csg.getShadowMap();
    // Every frame for normal levels (no shadow wobble); only the perf-floor level 0
    // throttles to every other frame.
    if (sm) sm.refreshRate = level <= 0 ? 2 : 1;
  }

  dispose(): void {
    this.oceanDepthRenderer?.dispose();
    this.oceanDepthRenderer = null;
    this._oceanDepthMap = null;
    this.engine?.dispose();
  }
}
