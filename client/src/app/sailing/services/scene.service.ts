import { Injectable, NgZone, inject, signal } from '@angular/core';
import {
  Engine, Scene, Color3, Color4, Vector3,
  HemisphericLight, DirectionalLight,
  FreeCamera, MeshBuilder, StandardMaterial, Mesh, GlowLayer,
  DefaultRenderingPipeline,
} from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials';

@Injectable({ providedIn: 'root' })
export class SceneService {
  private zone = inject(NgZone);

  engine!: Engine;
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
  private pipeline!: DefaultRenderingPipeline;

  // Public signal so the HUD can display the current game time.
  gameTime = signal(10.5);  // 0–24 hours

  // 1 real second = 1 game minute → full day/night cycle every 24 real minutes.
  private gameHours = 10.5;
  private readonly SECS_PER_GAME_HOUR = 60;

  init(canvas: HTMLCanvasElement): void {
    this.zone.runOutsideAngular(() => {
      this.engine = new Engine(canvas, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        antialias: true,
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
      blurKernelSize: 128,
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

    // FXAA smooths aliased edges on the ocean and cloud geometry.
    this.pipeline.fxaaEnabled = true;

    // Image processing: subtle vignette and contrast lift.
    this.pipeline.imageProcessingEnabled = true;
    this.pipeline.imageProcessing.vignetteEnabled = true;
    this.pipeline.imageProcessing.vignetteWeight  = 0.60;
    this.pipeline.imageProcessing.contrast        = 1.10;
    this.pipeline.imageProcessing.exposure        = 1.0;
  }

  getSkyMesh(): any { return this.skyMesh; }

  updateFogDensity(density: number): void {
    if (this.scene) this.scene.fogDensity = density;
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
    this.gameHours   = ((Date.now() / 1000) % cycleSecs) / this.SECS_PER_GAME_HOUR;
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
    this.skyMat.turbidity       = 2.0 + horizon * 16.0;   // much denser at horizon
    this.skyMat.mieCoefficient  = 0.005 + horizon * 0.045; // bigger sun corona at sunset
    this.skyMat.mieDirectionalG = 0.97 - horizon * 0.08;

    // ── Celestial disk positions ───────────────────────────────────────────────
    // Place them at a large distance from the camera so they never clip.
    if (this.camera) {
      const base = this.camera.position;
      this.sunMesh.position  = base.add(dir.scale(65000));
      this.moonMesh.position = base.add(dir.negate().scale(65000));
    }

    this.sunMesh.setEnabled(h > -0.06);
    this.moonMesh.setEnabled(h < 0.14);   // overlap briefly at dawn/dusk

    // Sun colour: deep crimson-scarlet at horizon → blazing white at zenith.
    const sunMat = this.sunMesh.material as StandardMaterial;
    sunMat.emissiveColor = new Color3(
      1.0,
      Math.min(1, 0.20 + above * 0.78),   // deep amber-red at horizon
      Math.min(1, 0.03 + above * 0.91),   // nearly zero blue near horizon
    );
    // Atmospheric refraction: sun appears enlarged when close to the horizon.
    const sunScale = 1.0 + Math.max(0, 0.88 - above) * 3.2;
    this.sunMesh.scaling.setAll(sunScale);

    // Glow: erupts dramatically at sunrise/sunset, steady midday, dim moonlit at night.
    this.glowLayer.intensity = h > 0
      ? 0.40 + horizon * 5.5 + above * 0.15
      : 0.22;  // soft moonlit glow

    // ── Post-processing: bloom and exposure surge at golden hour ──────────────
    if (this.pipeline) {
      this.pipeline.bloomWeight                 = 0.28 + horizon * 0.68;
      this.pipeline.imageProcessing.exposure    = 1.0  + horizon * 0.48;
      this.pipeline.imageProcessing.contrast    = 1.10 + horizon * 0.14;
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
    this.ambient.intensity = 0.14 + above * 0.54;
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
