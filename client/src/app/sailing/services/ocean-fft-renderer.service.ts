/**
 * OceanFFTRenderer — assembles the FFT ocean's visible surface: the clipmap geometry +
 * the PBR cascade material, fed by OceanFFTEngine's compute textures. WebGPU only.
 *
 * The FFT ocean is the default on WebGPU (auto-enabled on init). Ctrl+Shift+O switches
 * between it and the classic procedural ocean.
 */
import { Injectable, inject } from '@angular/core';
import { Constants, Observer, Scene, Material, Mesh, SubMesh, Vector3 } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { OceanFFTEngine } from './ocean-fft-engine.service';
import { MultiplayerService } from './multiplayer.service';
import { OceanGeometry } from './ocean-fft/ocean-geometry';
import { OceanFFTMaterial } from './ocean-fft/ocean-material';
import { HULL_STENCIL_REF } from './ocean-fft/hull-cut-mask';
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
  private _stencilMaskOn = false;

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
      // Scene depth (camera-space Z of opaque geom, ocean excluded) — the same live DepthRenderer
      // the procedural ocean uses. Used here to depth-cut the near-boat hull reveal so it shows the
      // submerged hull but not the deeper seabed behind it. (Contact foam stays off — _ContactFoam=0.)
      depthTexture: this.sceneService.oceanDepthMap,
      reflectionTexture: this.oceanService.getReflectionTexture(),
      refractionTexture: this.oceanService.getRefractionTexture(),
      // When reflections are off the mirror RTT stops rendering, so feed the shader the sky/fog hue
      // to reflect analytically (strength 0 → planar reflection off, sky fallback full) instead of a
      // dead-black RTT — keeps the shallows see-through and the water from reading flat-dark.
      getSkyReflect: () => {
        const fog = this.sceneService.scene?.fogColor;
        const color = fog ? new Vector3(fog.r, fog.g, fog.b).scaleInPlace(1.25) : new Vector3(0.45, 0.62, 0.82);
        return { color, strength: this.oceanService.isReflectionsEnabled() ? 0.9 : 0 };
      },
      getShore: () => this.oceanService.getShoreInfo(),
      getBoatWake: () => this.oceanService.getBoatWake(),
      getHullCut: () => this.oceanService.getHullCut(),
      getWakePaths: () => ({
        paths: this._wakeTracker.paths,
        meta: this._wakeTracker.meta,
        count: this._wakeTracker.boatCount,
      }),
      getSplashData: () => this.oceanService.getSplashData(),
      getCannonFlash: () => this.oceanService.getCannonFlash(),
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
      getFishStartle: () => this.oceanService.getFishStartle(),
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

    this._tick = scene.onBeforeRenderObservable.add(() => this.sceneService.span('fft', () => {
      if (this._enabled) {
        this._geometry!.update();
        this._updateWakes(scene);
        this._syncStencilMask();
      }
    }));

    this._installToggleKey();
    // Engage per the persisted Ocean quality dial (default High → FFT on WebGPU). Ctrl+Shift+O stays
    // as a debug override that flips the mode without touching the dial.
    void this.applyQuality(this.oceanService.getOceanQuality());
  }

  /** Apply the Ocean quality dial: ≥1 → FFT ocean (2 = ultra 256² grid), 0 (Cheap) → procedural ocean.
   *  Safe no-op on WebGL / when the FFT pipeline is unavailable (the procedural ocean stays). */
  async applyQuality(level: number): Promise<void> {
    if (!this._geometry || !this._material) { return; }
    const wantFft = level >= 1;
    if (wantFft) { this.fft.setUltra(level >= 2); }   // engine no-ops when the grid size is unchanged
    if (wantFft !== (this._mode === 'fft')) { await this.toggleFFT(); }
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

  /**
   * Mirror OceanService's hull-stencil-mask flag onto the live FFT surface (changes only — cheap to poll).
   * When ON: every cascade material rejects pixels the hull-stencil proxy stamped (stencil == REF), so the
   * sea is masked out of the hull by true geometry; and a group-0 opaque sort draws that proxy FIRST so its
   * stencil is laid down before the water reads it (proxy + ocean share renderingGroup 0). When OFF: restore
   * the default (stencil test off, default opaque order). Set by VesselService for a hullCut vessel in
   * stencil mode (localStorage.ignis_hullcut === 'stencil').
   */
  private _syncStencilMask(): void {
    const want = this.oceanService.getHullCut().stencilMask === true;
    if (want === this._stencilMaskOn) { return; }
    this._stencilMaskOn = want;
    for (const m of this._realMaterials) {
      m.stencil.enabled            = want;
      m.stencil.func               = Constants.NOTEQUAL;   // draw only where the proxy did NOT stamp
      m.stencil.funcRef            = HULL_STENCIL_REF;
      m.stencil.funcMask           = 0xff;
      m.stencil.mask               = 0x00;                 // the ocean never writes stencil itself
      m.stencil.opStencilDepthPass = Constants.KEEP;
      m.stencil.opStencilFail      = Constants.KEEP;
      m.stencil.opDepthFail        = Constants.KEEP;
    }
    // Force the stencil proxy to render before the rest of group 0 (the FFT ocean lives there too, and
    // opaque draw order is otherwise undefined → the proxy would stamp too late). Comparator hoists the
    // proxy and leaves every other submesh's relative order intact (stable sort).
    this.sceneService.scene.setRenderingOrder(0, want
      ? (a: SubMesh, b: SubMesh) => {
          const pa = a.getMesh().metadata?.stencilProxy ? 0 : 1;
          const pb = b.getMesh().metadata?.stencilProxy ? 0 : 1;
          return pa - pb;
        }
      : null);
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
    // Float the boat on the ACTUAL FFT surface — no calming. The radial-disc calming that used to be
    // mirrored here (matching the material) is gone: it flattened the wave the hull sampled, so the boat
    // barely bobbed. The buoyancy service samples this at 8 hull points, so returning the true swell makes
    // the pinnace heave/pitch/roll again, while the exact waterline-contour depression (in the material,
    // riding hullCutWaterY = the boat's floor) keeps the open hull dry as it bobs.
    this.oceanService.setHeightProvider((x, z) => this.fft.getHeightAt(x, z));
  }

  private _disable(): void {
    if (!this._geometry) { return; }
    this._enabled = false;
    this._mode = 'off';
    // Drop any stencil-mask state before the procedural ocean takes over (its meshes share group 0/2 and
    // must not inherit our group-0 draw-order override or a stale stencil test).
    if (this._stencilMaskOn) {
      this._stencilMaskOn = false;
      this._realMaterials.forEach((m) => { m.stencil.enabled = false; });
      this.sceneService.scene.setRenderingOrder(0, null);
    }
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
    this._material = null;
    this._realMaterials = [];
    // Reset the A/B state so the next session starts fresh. init() default-enables FFT via
    // toggleFFT(), which TOGGLES on _mode — if we leave _mode='fft' here, the next init would
    // toggle it OFF and drop back to the procedural Gerstner ocean ("looks like WebGL").
    this._mode = 'off';
    this._enabled = false;
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
