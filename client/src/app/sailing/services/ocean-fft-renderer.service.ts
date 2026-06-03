/**
 * OceanFFTRenderer — assembles the FFT ocean's visible surface: the clipmap geometry +
 * the PBR cascade material, fed by OceanFFTEngine's compute textures. WebGPU only.
 *
 * The FFT ocean is the default on WebGPU (auto-enabled on init). Ctrl+Shift+O switches
 * between it and the classic procedural ocean.
 */
import { Injectable, inject } from '@angular/core';
import { Observer, Scene, Material, Mesh } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { OceanFFTEngine } from './ocean-fft-engine.service';
import { MultiplayerService } from './multiplayer.service';
import { OceanGeometry } from './ocean-fft/ocean-geometry';
import { OceanFFTMaterial } from './ocean-fft/ocean-material';
import { WakeTracker } from './ocean-fft/wake-tracker';

@Injectable({ providedIn: 'root' })
export class OceanFFTRenderer {
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);
  private fft = inject(OceanFFTEngine);
  private multiplayerService = inject(MultiplayerService);

  /** Reusable buffer for boat-shadow positions (local at 0, then remotes). vec4 ×8. */
  private readonly _boatShadowBuf = new Float32Array(8 * 4);

  /** Per-vessel wake path tracker (local + remotes) → curved wakes for every ship. */
  private readonly _wakeTracker = new WakeTracker();

  private _geometry: OceanGeometry | null = null;
  private _material: OceanFFTMaterial | null = null;
  private _realMaterials: Material[] = [];
  private _tick: Observer<Scene> | null = null;
  private _enabled = false;
  private _mode: 'off' | 'fft' = 'off';
  private _startTime = 0;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  get isAvailable(): boolean { return this._geometry !== null; }
  get isEnabled(): boolean { return this._enabled; }

  /** Build the clipmap + materials (WebGPU + active FFT engine only). Stays disabled. */
  init(): void {
    if (this._geometry) { return; }
    if (!this.sceneService.isWebGPU || !this.fft.isActive) {
      return;   // WebGL or FFT engine unavailable — procedural ocean stays
    }

    const scene = this.sceneService.scene;
    const camera = this.sceneService.camera;
    this._startTime = performance.now() / 1000;

    this._material = new OceanFFTMaterial({
      scene,
      camera,
      fft: this.fft,
      // Depth-based contact foam disabled for now: the scene depth RTT is currently invalid
      // in this build (pre-existing pipeline error), and binding it can poison the draw.
      // Re-enabled in Phase 5 once that RTT is sorted.
      depthTexture: null,
      reflectionTexture: this.oceanService.getReflectionTexture(),
      refractionTexture: this.oceanService.getRefractionTexture(),
      getShore: () => this.oceanService.getShoreInfo(),
      getBoatWake: () => this.oceanService.getBoatWake(),
      getWakePaths: () => ({
        paths: this._wakeTracker.paths,
        meta: this._wakeTracker.meta,
        count: this._wakeTracker.boatCount,
      }),
      getSplashData: () => this.oceanService.getSplashData(),
      getWaterShadow: () => this.oceanService.getWaterShadowInfo(),
      getRain: () => this.oceanService.getRainIntensity(),
      getChoppiness: () => this.fft.choppiness,
      getBoatShadows: () => {
        const buf = this._boatShadowBuf;
        const local = this.oceanService.getBoatWake();
        buf[0] = local.x; buf[1] = local.z; buf[2] = 0; buf[3] = 0;
        const n = 1 + this.multiplayerService.fillVesselPositions(buf, 1, 8);
        return { data: buf, count: n };
      },
      getSunDir: () => this.sceneService.getSunDirection(),
      getTime: () => performance.now() / 1000 - this._startTime,
    });

    this._realMaterials = [
      this._material.getMaterial(true, true),
      this._material.getMaterial(true, false),
      this._material.getMaterial(false, false),
    ];

    // Plain reference material — a clipmap painted with this isolates geometry issues.
    this._geometry = new OceanGeometry(camera, scene);
    this._geometry.setMaterials(this._realMaterials);
    this._geometry.initializeMeshes();
    this._geometry.root.setEnabled(false);

    this._tick = scene.onBeforeRenderObservable.add(() => {
      if (this._enabled) {
        this._geometry!.update();
        this._updateWakes(scene);
      }
    });

    this._installToggleKey();
    // The FFT ocean is the default on WebGPU; Ctrl+Shift+O switches back to the procedural one.
    void this.toggleFFT();
  }

  /** Record/extend every ship's wake path, then pack the nearest few for the material. */
  private _updateWakes(scene: Scene): void {
    const dt = Math.min(scene.getEngine().getDeltaTime() * 0.001, 0.05);
    const local = this.oceanService.getBoatWake();
    const boats = [{ id: 'local', x: local.x, z: local.z, speed: local.speed }];
    for (const r of this.multiplayerService.getVesselWakeSources()) { boats.push(r); }
    this._wakeTracker.update(dt, boats);
    const cam = this.sceneService.camera.position;
    this._wakeTracker.assemble(cam.x, cam.z);
  }

  /** Switch to the FFT ocean (or back to procedural). Pre-compiles and aborts safely on failure. */
  async toggleFFT(): Promise<void> {
    if (!this._geometry || !this._material) { return; }
    if (this._mode === 'fft') { this._disable(); return; }
    const probe = this._geometry.allMeshes()[0] as Mesh;
    try {
      await Promise.all(this._realMaterials.map((m) => m.forceCompilationAsync(probe)));
    } catch (err) {
      console.warn('[OceanFFT] material failed to compile — staying on the procedural ocean:', err);
      return;
    }
    this._commit();
  }

  private _commit(): void {
    if (!this._geometry) { return; }
    this._mode = 'fft';
    this._enabled = true;
    this._geometry.root.setEnabled(true);
    this.oceanService.setHidden(true);
    // Float the boat on the actual FFT surface, with the same boat-footprint calming as the
    // material so the hull agrees with the (calmed) water around it.
    this.oceanService.setHeightProvider((x, z) => {
      const h = this.fft.getHeightAt(x, z);
      if (Number.isNaN(h)) { return h; }
      const b = this.oceanService.getBoatWake();
      const d = Math.hypot(x - b.x, z - b.z);
      const s = Math.max(0, Math.min(1, (d - 6) / (16 - 6)));   // smoothstep(6,16)
      return h * (0.45 + 0.55 * (s * s * (3 - 2 * s)));
    });
  }

  private _disable(): void {
    if (!this._geometry) { return; }
    this._enabled = false;
    this._mode = 'off';
    this._geometry.root.setEnabled(false);
    this.oceanService.setHidden(false);
    this.oceanService.setHeightProvider(null);   // back to the procedural height model
  }

  dispose(): void {
    if (this._tick) { this.sceneService.scene.onBeforeRenderObservable.remove(this._tick); this._tick = null; }
    if (this._keyHandler) { window.removeEventListener('keydown', this._keyHandler); this._keyHandler = null; }
    this._geometry?.dispose();
    this._realMaterials.forEach((m) => m.dispose());
    this._material?.dispose();
    this._geometry = null;
  }

  private _installToggleKey(): void {
    this._keyHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyO') {
        e.preventDefault();
        void this.toggleFFT();
      }
    };
    window.addEventListener('keydown', this._keyHandler);
  }
}
