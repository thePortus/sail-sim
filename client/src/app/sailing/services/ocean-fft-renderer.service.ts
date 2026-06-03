/**
 * OceanFFTRenderer — assembles the FFT ocean's visible surface: the clipmap geometry +
 * the PBR cascade material, fed by OceanFFTEngine's compute textures. WebGPU only.
 *
 * Built disabled. While the rewrite is in progress this is flipped on/off for verification:
 *   Ctrl+Shift+O — toggle the real FFT ocean (pre-compiles + logs; aborts safely on error,
 *                  so a bad shader can never black-screen the scene).
 *   Ctrl+Shift+P — toggle the clipmap with a PLAIN PBR material (no FFT sampling) to isolate
 *                  geometry problems from shader problems.
 * Once it's fully featured it becomes the default WebGPU ocean.
 */
import { Injectable, inject } from '@angular/core';
import { Observer, Scene, Material, Mesh, PBRMaterial, Color3 } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { OceanService } from './ocean.service';
import { OceanFFTEngine } from './ocean-fft-engine.service';
import { CannonService } from './cannon.service';
import { MultiplayerService } from './multiplayer.service';
import { OceanGeometry } from './ocean-fft/ocean-geometry';
import { OceanFFTMaterial } from './ocean-fft/ocean-material';

@Injectable({ providedIn: 'root' })
export class OceanFFTRenderer {
  private sceneService = inject(SceneService);
  private oceanService = inject(OceanService);
  private fft = inject(OceanFFTEngine);
  private cannonService = inject(CannonService);
  private multiplayerService = inject(MultiplayerService);

  /** Reusable buffer for boat-shadow positions (local at 0, then remotes). vec4 ×8. */
  private readonly _boatShadowBuf = new Float32Array(8 * 4);

  private _geometry: OceanGeometry | null = null;
  private _material: OceanFFTMaterial | null = null;
  private _realMaterials: Material[] = [];
  private _plainMaterial: PBRMaterial | null = null;
  private _tick: Observer<Scene> | null = null;
  private _enabled = false;
  private _mode: 'off' | 'fft' | 'plain' = 'off';
  private _startTime = 0;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  get isAvailable(): boolean { return this._geometry !== null; }
  get isEnabled(): boolean { return this._enabled; }

  /** Build the clipmap + materials (WebGPU + active FFT engine only). Stays disabled. */
  init(): void {
    if (this._geometry) { return; }
    if (!this.sceneService.isWebGPU || !this.fft.isActive) {
      console.log('[OceanFFT] renderer skipped (needs WebGPU + active FFT engine)');
      return;
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
      getWakePath: () => this.oceanService.getWakePath(),
      getSplashData: () => this.oceanService.getSplashData(),
      getWaterShadow: () => this.oceanService.getWaterShadowInfo(),
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
    this._plainMaterial = new PBRMaterial('oceanFFTPlain', scene);
    this._plainMaterial.albedoColor = new Color3(0.02, 0.08, 0.15);
    this._plainMaterial.metallic = 0;
    this._plainMaterial.roughness = 0.4;
    this._plainMaterial.backFaceCulling = false;

    this._geometry = new OceanGeometry(camera, scene);
    this._geometry.setMaterials(this._realMaterials);
    this._geometry.initializeMeshes();
    this._geometry.root.setEnabled(false);

    this._tick = scene.onBeforeRenderObservable.add(() => {
      if (this._enabled) { this._geometry!.update(); }
    });

    this._installToggleKey();
    console.log('[OceanFFT] renderer ready — Ctrl+Shift+O (FFT ocean), Ctrl+Shift+P (plain clipmap test)');
  }

  /** Toggle the real FFT ocean. Pre-compiles and aborts safely (with a logged error) on failure. */
  async toggleFFT(): Promise<void> {
    if (!this._geometry || !this._material) { return; }
    if (this._mode === 'fft') { this._disable(); return; }
    if (this._mode === 'plain') { this._disable(); }

    console.log('[OceanFFT] compiling FFT material…');
    this._geometry.setMaterials(this._realMaterials);
    const probe = this._geometry.allMeshes()[0] as Mesh;

    try {
      await Promise.all(this._realMaterials.map((m) => m.forceCompilationAsync(probe)));
    } catch (err) {
      console.error('[OceanFFT] FFT material FAILED to compile — staying on procedural ocean. Error:\n', err);
      return;
    }
    console.log('[OceanFFT] FFT material compiled OK — enabling. If the screen now goes black, the fault is at DRAW time (bindings/geometry), not shader compile.');
    this._commit('fft');
  }

  /** Toggle the clipmap with a plain PBR material — if THIS renders, geometry is fine. */
  async togglePlain(): Promise<void> {
    if (!this._geometry || !this._plainMaterial) { return; }
    if (this._mode === 'plain') { this._disable(); return; }
    if (this._mode === 'fft') { this._disable(); }

    const plain = this._plainMaterial as Material;
    this._geometry.setMaterials([plain, plain, plain]);
    const probe = this._geometry.allMeshes()[0] as Mesh;
    try {
      await this._plainMaterial.forceCompilationAsync(probe);
    } catch (err) {
      console.error('[OceanFFT] plain clipmap FAILED to compile (geometry/material core issue):\n', err);
      return;
    }
    console.log('[OceanFFT] plain clipmap compiled — enabling (geometry isolation test)');
    this._commit('plain');
  }

  private _commit(mode: 'fft' | 'plain'): void {
    if (!this._geometry) { return; }
    this._mode = mode;
    this._enabled = true;
    this._geometry.root.setEnabled(true);
    this.oceanService.setHidden(true);
    console.log(`[OceanFFT] ${mode === 'fft' ? 'FFT ocean' : 'plain clipmap'} ON`);
  }

  private _disable(): void {
    if (!this._geometry) { return; }
    this._enabled = false;
    this._mode = 'off';
    this._geometry.root.setEnabled(false);
    this.oceanService.setHidden(false);
    console.log('[OceanFFT] procedural ocean restored');
  }

  dispose(): void {
    if (this._tick) { this.sceneService.scene.onBeforeRenderObservable.remove(this._tick); this._tick = null; }
    if (this._keyHandler) { window.removeEventListener('keydown', this._keyHandler); this._keyHandler = null; }
    this._geometry?.dispose();
    this._realMaterials.forEach((m) => m.dispose());
    this._plainMaterial?.dispose();
    this._material?.dispose();
    this._geometry = null;
  }

  private _installToggleKey(): void {
    this._keyHandler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey)) { return; }
      if (e.code === 'KeyO') { e.preventDefault(); this.toggleFFT(); }
      else if (e.code === 'KeyP') { e.preventDefault(); this.togglePlain(); }
      else if (e.code === 'KeyD') { e.preventDefault(); this.fft.debugReadback(); }
      else if (e.code === 'KeyI') { e.preventDefault(); this.fft.toggleDebugSkipIFFT(); }
      else if (e.code === 'KeyM') {
        e.preventDefault();
        this.cannonService.suppressSplashFx = !this.cannonService.suppressSplashFx;
        console.log(`[OceanFFT] splash particles ${this.cannonService.suppressSplashFx ? 'OFF' : 'ON'}`);
      }
    };
    window.addEventListener('keydown', this._keyHandler);
  }
}
