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
const ULTRA_KEY = 'ignis_ocean_ultra';

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
  private _choppiness = 0.3;   // latest sea-state 0..1 (drives foam trim in the material)

  /** Latest sea choppiness (0..1) from the weather system. */
  get choppiness(): number { return this._choppiness; }

  /** True when the GPU FFT pipeline is live (WebGPU + initialised). */
  get isActive(): boolean { return this._active; }
  get size(): number { return this._size; }
  get settings(): WavesSettings { return this._settings; }

  /**
   * Initialise the FFT pipeline. No-op (and stays inactive) on WebGL. Safe to call once
   * the scene exists. `size` overrides the default (use FFT_SIZE_ULTRA for ultra).
   */
  init(size?: number): void {
    if (this._active) { return; }
    if (!this.sceneService.isWebGPU) { return; }   // WebGL: procedural ocean stays active

    this._engine = this.sceneService.engine as WebGPUEngine;
    this._scene = this.sceneService.scene;
    const persisted = localStorage.getItem(ULTRA_KEY) === '1' ? FFT_SIZE_ULTRA : FFT_SIZE_DEFAULT;
    this._size = this._pow2(size ?? persisted);
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
  }

  /** True when the FFT grid is at the high-detail "Ultra" resolution. */
  get ultra(): boolean { return this._size >= FFT_SIZE_ULTRA; }

  /** Toggle the "Ultra" (256²) vs standard (128²) grid; persisted across sessions. */
  setUltra(on: boolean): void {
    localStorage.setItem(ULTRA_KEY, on ? '1' : '0');
    this.setSize(on ? FFT_SIZE_ULTRA : FFT_SIZE_DEFAULT);
  }

  /** Change the grid resolution (rebuilds the pipeline). Stable presets only. */
  setSize(size: number): void {
    const n = this._pow2(size);
    if (n === this._size && this._generator) { return; }
    this._size = n;
    if (!this._active) { return; }
    this._heightMap = null;   // stale (old resolution)
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
    this._choppiness = chop;   // exposed to the material so heavy seas foam less

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

  // ── CPU height readback (buoyancy) ──────────────────────────────────────────
  private _heightMap: Uint16Array | null = null;   // cascade-0 displacement (rgba16f), CPU copy
  private _readbackPending = false;

  /**
   * World-surface height at (wx, wz) from the read-back cascade-0 displacement (the broad
   * swell — the cascade buoyancy cares about). Returns NaN until the first readback lands so
   * callers can fall back. Bilinear, wrapping on the cascade's length scale.
   */
  getHeightAt(wx: number, wz: number): number {
    const map = this._heightMap;
    if (!map) { return NaN; }
    const N = this._size, mask = N - 1;
    const ls = this.getLengthScale(0) || 250;
    const fx = (wx / ls) * N, fz = (wz / ls) * N;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const ix0 = x0 & mask, iz0 = z0 & mask, ix1 = (x0 + 1) & mask, iz1 = (z0 + 1) & mask;
    // Height is channel 1 (G) of the displacement texture (the merger packs y there).
    const h = (ix: number, iz: number) => TextureTools.FromHalfFloat(map[(iz * N + ix) * 4 + 1]);
    const a = h(ix0, iz0), b = h(ix1, iz0), c = h(ix0, iz1), d = h(ix1, iz1);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /** Kick off an async readback of cascade-0 displacement (no GPU stall; lands in ~1-2 frames). */
  private _readbackHeight(): void {
    if (this._readbackPending) { return; }
    const tex = this.getDisplacementTex(0);
    if (!tex) { return; }
    this._readbackPending = true;
    tex.readPixels(undefined, undefined, undefined, undefined, true)
      .then((buf) => { if (buf) { this._heightMap = new Uint16Array(buf.buffer); } this._readbackPending = false; })
      .catch(() => { this._readbackPending = false; });
  }

  dispose(): void {
    if (this._tickObserver && this._scene) {
      this._scene.onBeforeRenderObservable.remove(this._tickObserver);
      this._tickObserver = null;
    }
    this._generator?.dispose();
    this._generator = null;
    this._active = false;
    // Drop the engine-bound static copy shaders so the next session rebuilds them on the new engine.
    ComputeHelper.reset();
  }

  private _tick(): void {
    if (!this._generator) { return; }
    try {
      this._generator.update(performance.now() / 1000);
      // Perf A/B: localStorage.ignis_no_fft_readback='1' skips the per-frame height readback (buoyancy
      // freezes — fine for a measurement). If the frame time drops with this on, the readback was
      // stalling the pipeline on GPU completion.
      if (localStorage.getItem('ignis_no_fft_readback') !== '1') { this._readbackHeight(); }
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
