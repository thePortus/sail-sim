/**
 * WavesGenerator — owns the FFT, the gaussian noise texture, and the 3 frequency cascades
 * (broad swell / waves / fine chop). Drives them each frame and exposes their textures to
 * the ocean material. Ported from Popov72's OceanDemo `wavesGenerator.ts`.
 *
 * Length scales are the per-cascade domain sizes (metres); cutoff boundaries split the
 * spectrum so adjacent cascades don't double-count the same wavelengths.
 */
import {
  RawTexture, BaseTexture, Constants, WebGPUEngine,
} from '@babylonjs/core';
import { FFT } from './fft';
import { WavesCascade } from './waves-cascade';
import { WavesSettings } from './waves-settings';

export class WavesGenerator {
  /** Per-cascade domain size in metres (large → small). */
  public lengthScale = [250, 17, 5];

  private _engine: WebGPUEngine;
  private _size: number;
  private _settings: WavesSettings;
  private _startTime: number;
  private _fft: FFT;
  private _noise: RawTexture;
  private _cascades: WavesCascade[];

  constructor(size: number, settings: WavesSettings, engine: WebGPUEngine, startTimeSec: number) {
    this._engine = engine;
    this._size = size;
    this._settings = settings;
    this._startTime = startTimeSec;

    this._fft = new FFT(engine, size);
    this._noise = this._generateNoise(size);

    this._cascades = [
      new WavesCascade(size, this._noise, this._fft, engine),
      new WavesCascade(size, this._noise, this._fft, engine),
      new WavesCascade(size, this._noise, this._fft, engine),
    ];

    this.initializeCascades();
  }

  getCascade(i: number): WavesCascade { return this._cascades[i]; }

  /** Debug: the raw gaussian noise texture (rg32f). */
  get debugNoise(): RawTexture { return this._noise; }

  /** Debug: skip the IFFTs on every cascade (DxDz then holds the raw spectrum). */
  setDebugSkipIFFT(skip: boolean): void {
    for (const c of this._cascades) { c.debugSkipIFFT = skip; }
  }

  /** Rebuild every cascade's static spectrum (call after weather/settings change). */
  initializeCascades(): void {
    let boundary1 = 0.0001;
    for (let i = 0; i < this.lengthScale.length; ++i) {
      const boundary2 = i < this.lengthScale.length - 1
        ? (2 * Math.PI) / this.lengthScale[i + 1] * 6
        : 9999;
      this._cascades[i].calculateInitials(this._settings, this.lengthScale[i], boundary1, boundary2);
      boundary1 = boundary2;
    }
  }

  /** Advance all cascades to the current time (call once per frame). */
  update(nowSec: number): void {
    const time = nowSec - this._startTime;
    for (const c of this._cascades) {
      c.calculateWavesAtTime(time);
    }
  }

  displacementTex(cascade: number): BaseTexture { return this._cascades[cascade].displacement; }
  derivativesTex(cascade: number): BaseTexture { return this._cascades[cascade].derivatives; }
  turbulenceTex(cascade: number): BaseTexture { return this._cascades[cascade].turbulence; }

  dispose(): void {
    for (const c of this._cascades) { c.dispose(); }
    this._noise.dispose();
    this._fft.dispose();
  }

  /** Gaussian (Box–Muller) RG noise — the random phases the spectrum is seeded from. */
  private _generateNoise(size: number): RawTexture {
    const data = new Float32Array(size * size * 2);
    for (let i = 0; i < size * size; ++i) {
      data[i * 2 + 0] = this._normalRandom();
      data[i * 2 + 1] = this._normalRandom();
    }
    const noise = new RawTexture(
      data, size, size, Constants.TEXTUREFORMAT_RG, this._engine, false, false,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
    );
    noise.name = 'fftNoise';
    return noise;
  }

  private _normalRandom(): number {
    return Math.cos(2 * Math.PI * Math.random()) * Math.sqrt(-2 * Math.log(Math.random() + 1e-9));
  }
}
