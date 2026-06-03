/**
 * OceanFFTEngine — Angular wrapper around the FFT ocean compute pipeline (WebGPU only).
 *
 * Owns a WavesGenerator (3 cascades) and ticks it every frame, exposing the resulting
 * displacement / derivatives / turbulence textures (and per-cascade length scales) for the
 * ocean material to sample. On WebGL it stays inactive — the legacy procedural ocean keeps
 * rendering and `isActive` reads false.
 *
 * Faithful port of the gasgiant FFT-Ocean → Popov72 OceanDemo pipeline; see ocean-fft/.
 *
 * Phase 1 of the ocean rewrite: compute core only (no rendering swap yet).
 */
import { Injectable, inject } from '@angular/core';
import { Observer, Scene, WebGPUEngine, TextureTools } from '@babylonjs/core';
import { SceneService } from './scene.service';
import { Wind, SeaConditions } from '../models';
import { WavesGenerator } from './ocean-fft/waves-generator';
import { WavesSettings } from './ocean-fft/waves-settings';
import { ComputeHelper } from './ocean-fft/compute-helper';

/** Grid size presets. N must be a power of two. */
export const FFT_SIZE_DEFAULT = 128;   // standard quality
export const FFT_SIZE_ULTRA   = 256;   // "Ultra" toggle

@Injectable({ providedIn: 'root' })
export class OceanFFTEngine {
  private sceneService = inject(SceneService);

  private _active = false;
  private _size = FFT_SIZE_DEFAULT;
  private _settings = new WavesSettings();
  private _generator: WavesGenerator | null = null;
  private _engine: WebGPUEngine | null = null;
  private _scene: Scene | null = null;
  private _tickObserver: Observer<Scene> | null = null;
  private _startTime = 0;

  // Weather-mapping throttle: re-seeding the spectrum is the only non-per-frame step, so we
  // rebuild only when the wind has moved meaningfully (and never more than a few times/sec).
  private _lastReinitMs = -1e9;
  private _lastWindMs = -1;   // last applied wind speed (m/s)
  private _lastDirDeg = -999;
  private _lastChop = -1;

  /** True when the GPU FFT pipeline is live (WebGPU + initialised). */
  get isActive(): boolean { return this._active; }
  get size(): number { return this._size; }
  get settings(): WavesSettings { return this._settings; }

  /**
   * Initialise the FFT pipeline. No-op (and stays inactive) on WebGL. Safe to call once
   * the scene exists. `size` overrides the default (use FFT_SIZE_ULTRA for ultra).
   */
  init(size: number = FFT_SIZE_DEFAULT): void {
    if (this._active) { return; }
    if (!this.sceneService.isWebGPU) {
      console.log('[OceanFFT] WebGL engine — FFT ocean disabled (procedural ocean stays active)');
      return;
    }

    this._engine = this.sceneService.engine as WebGPUEngine;
    this._scene = this.sceneService.scene;
    this._size = this._pow2(size);
    this._startTime = performance.now() / 1000;

    try {
      this._generator = new WavesGenerator(this._size, this._settings, this._engine, this._startTime);
    } catch (err) {
      console.warn('[OceanFFT] init failed — falling back to procedural ocean:', err);
      this._generator = null;
      return;
    }

    // Drive the cascades every frame. Runs before the ocean material binds its textures.
    this._tickObserver = this._scene.onBeforeRenderObservable.add(() => this._tick());
    this._active = true;
    console.log(`[OceanFFT] active — ${this._size}² grid, 3 cascades`);
  }

  /** Change the grid resolution (rebuilds the pipeline). Stable presets only. */
  setSize(size: number): void {
    const n = this._pow2(size);
    if (n === this._size && this._generator) { return; }
    this._size = n;
    if (!this._active) { return; }
    this._generator?.dispose();
    this._generator = new WavesGenerator(this._size, this._settings, this._engine!, this._startTime);
  }

  /**
   * Map the game's weather onto the JONSWAP spectrum and re-seed the cascades. The wave
   * field emerges from the physics: stronger wind → larger, sharper, wind-aligned seas;
   * choppier conditions → pointier crests (more horizontal displacement) + more foam.
   * Throttled so the (cheap but not free) spectrum rebuild fires only on real change.
   */
  updateWeather(wind: Wind, sea: SeaConditions): void {
    if (!this._active || !this._generator) { return; }

    const ms        = Math.max(0.5, wind.speed * 0.5144);          // knots → m/s (JONSWAP needs >0)
    const dir       = wind.fromBearingDeg;
    const chop      = Math.max(0.05, Math.min(1, sea.choppiness));
    const beaufortT = Math.max(0, Math.min(1, (wind.beaufort ?? 0) / 12));

    const s = this._settings;
    // Wind-driven sea (the dominant, locally-generated chop + waves).
    s.local.windSpeed       = ms;
    s.local.windDirection   = dir;
    s.local.scale           = 0.5;
    s.local.fetch           = 100000;
    s.local.peakEnhancement = 2.0 + 1.6 * beaufortT;              // storms sharpen the spectral peak
    s.local.shortWavesFade  = 0.03 - 0.025 * chop;                // rougher seas keep more fine chop
    // Long-period swell — slightly off the wind axis, grows with the sea state.
    s.swell.windSpeed       = ms * 0.85 + 1;
    s.swell.windDirection   = dir + 25;
    s.swell.scale           = 0.2 + 0.4 * beaufortT;
    s.swell.fetch           = 300000;
    s.swell.swell           = 1;
    // Horizontal displacement (choppiness): pointier, breaking crests as it builds.
    s.lambda                = 0.7 + 0.6 * chop;

    // Throttle: skip unless wind moved enough, and at most ~every 400 ms.
    const now = performance.now();
    const moved =
      Math.abs(ms - this._lastWindMs) > 0.3 ||
      Math.abs(dir - this._lastDirDeg) > 2 ||
      Math.abs(chop - this._lastChop) > 0.03;
    if (!moved || now - this._lastReinitMs < 400) { return; }

    this._lastReinitMs = now;
    this._lastWindMs = ms;
    this._lastDirDeg = dir;
    this._lastChop = chop;
    this._generator.initializeCascades();
  }

  // ── Texture accessors for the ocean material (Phase 3 consumes these) ──
  getDisplacementTex(cascade: number) { return this._generator?.displacementTex(cascade) ?? null; }
  getDerivativesTex(cascade: number) { return this._generator?.derivativesTex(cascade) ?? null; }
  getTurbulenceTex(cascade: number) { return this._generator?.turbulenceTex(cascade) ?? null; }
  getLengthScale(cascade: number): number { return this._generator?.lengthScale[cascade] ?? 0; }

  private _debugSkipIFFT = false;
  /** Debug: toggle skipping the IFFTs (so DxDz holds the raw pre-IFFT spectrum). */
  toggleDebugSkipIFFT(): void {
    this._debugSkipIFFT = !this._debugSkipIFFT;
    this._generator?.setDebugSkipIFFT(this._debugSkipIFFT);
    console.log(`[OceanFFT] debug skip-IFFT = ${this._debugSkipIFFT} (now press Ctrl+Shift+D)`);
  }

  /**
   * Debug: read back cascade-0 displacement and log the height (and dx/dz) range. Tells us
   * whether the FFT compute is actually producing waves (non-zero) or outputting nothing.
   */
  async debugReadback(): Promise<void> {
    ComputeHelper.logReadiness();
    if (!this._generator) { console.log('[OceanFFT] debug: no generator'); return; }
    const c0 = this._generator.getCascade(0);
    console.log(`[OceanFFT] settings: windSpeed=${this._settings.local.windSpeed.toFixed(2)}m/s scale=${this._settings.local.scale} lengthScale0=${this.getLengthScale(0)}`);
    // Walk the chain: zero first appears at the broken stage.
    console.log('  noise     ' + await this._stats(this._generator.debugNoise, false));
    console.log('  H0 spectr ' + await this._stats(c0.debugInitialSpectrum, false));
    console.log('  DxDz(IFFT)' + await this._stats(c0.debugDxDz, false));
    console.log('  displace  ' + await this._stats(this.getDisplacementTex(0), true));
  }

  /** Read a texture back and summarise its scalar range. half=true for rgba16float. */
  private async _stats(tex: { readPixels: (...a: never[]) => Promise<ArrayBufferView | null> } | null, half: boolean): Promise<string> {
    if (!tex) { return 'null texture'; }
    let raw: ArrayBufferView | null;
    try {
      raw = await (tex as { readPixels: (f?: number, l?: number, b?: undefined, fr?: boolean, nd?: boolean) => Promise<ArrayBufferView | null> })
        .readPixels(undefined, undefined, undefined, undefined, true);
    } catch (err) {
      return 'readPixels failed: ' + err;
    }
    if (!raw) { return 'null data'; }
    const vals: number[] = [];
    if (half) {
      const u = new Uint16Array(raw.buffer);
      for (let i = 0; i < u.length; i++) { vals.push(TextureTools.FromHalfFloat(u[i])); }
    } else {
      const f = new Float32Array(raw.buffer);
      for (let i = 0; i < f.length; i++) { vals.push(f[i]); }
    }
    let mn = 1e9, mx = -1e9, s = 0;
    for (const v of vals) { mn = Math.min(mn, v); mx = Math.max(mx, v); s += Math.abs(v); }
    return `min=${mn.toExponential(2)} max=${mx.toExponential(2)} meanAbs=${(s / vals.length).toExponential(2)}`;
  }

  dispose(): void {
    if (this._tickObserver && this._scene) {
      this._scene.onBeforeRenderObservable.remove(this._tickObserver);
      this._tickObserver = null;
    }
    this._generator?.dispose();
    this._generator = null;
    this._active = false;
  }

  private _tick(): void {
    if (!this._generator) { return; }
    try {
      this._generator.update(performance.now() / 1000);
    } catch (err) {
      // A GPU/validation fault would otherwise throw every frame — disable cleanly once.
      console.warn('[OceanFFT] tick failed — disabling FFT ocean:', err);
      this.dispose();
    }
  }

  private _pow2(n: number): number {
    // Snap to the nearest power of two in [64, 512].
    const clamped = Math.max(64, Math.min(512, n | 0));
    return 1 << Math.round(Math.log2(clamped));
  }
}
