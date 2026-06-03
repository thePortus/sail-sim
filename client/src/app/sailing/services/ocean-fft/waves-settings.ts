/**
 * WavesSettings — the JONSWAP spectrum parameters for the FFT ocean, ported from
 * Popov72's OceanDemo `wavesSettings.ts`. Two display spectra (a wind-driven "local"
 * sea + a "swell") are converted into the packed per-element struct the WGSL spectrum
 * kernel reads. Phase 2 will drive `local`/`swell` from the game's weather system.
 */
import { Scalar, UniformBuffer, StorageBuffer } from '@babylonjs/core';

export interface DisplaySpectrumSettings {
  scale: number;
  windSpeed: number;      // m/s
  windDirection: number;  // degrees
  fetch: number;          // metres
  spreadBlend: number;    // 0..1
  swell: number;          // 0..1
  peakEnhancement: number;
  shortWavesFade: number;
}

interface SpectrumSettings {
  scale: number;
  angle: number;
  spreadBlend: number;
  swell: number;
  alpha: number;
  peakOmega: number;
  gamma: number;
  shortWavesFade: number;
}

export class WavesSettings {
  public g = 9.81;
  public depth = 500;          // deep-water dispersion (open ocean); coastal shoaling is done in the material
  public lambda = 1;           // horizontal displacement (choppiness) strength, 0..1+

  public local: DisplaySpectrumSettings = {
    scale: 0.5,
    windSpeed: 5,
    windDirection: -29.81,
    fetch: 100000,
    spreadBlend: 1,
    swell: 0.198,
    peakEnhancement: 3.3,
    shortWavesFade: 0.01,
  };

  public swell: DisplaySpectrumSettings = {
    scale: 0.5,
    windSpeed: 5,
    windDirection: 90,
    fetch: 300000,
    spreadBlend: 1,
    swell: 1,
    peakEnhancement: 3.3,
    shortWavesFade: 0.01,
  };

  private _spectrums: SpectrumSettings[] = [
    { scale: 0, angle: 0, spreadBlend: 0, swell: 0, alpha: 0, peakOmega: 0, gamma: 0, shortWavesFade: 0 },
    { scale: 0, angle: 0, spreadBlend: 0, swell: 0, alpha: 0, peakOmega: 0, gamma: 0, shortWavesFade: 0 },
  ];

  /** Push g/depth into the params UBO and the two spectra into the storage buffer. */
  setParametersToShader(params: UniformBuffer, spectrumParameters: StorageBuffer): void {
    params.updateFloat('GravityAcceleration', this.g);
    params.updateFloat('Depth', this.depth);

    this._fill(this.local, this._spectrums[0]);
    this._fill(this.swell, this._spectrums[1]);

    const buffer: number[] = [];
    this._linearize(this._spectrums[0], buffer);
    this._linearize(this._spectrums[1], buffer);

    spectrumParameters.update(buffer);
  }

  private _linearize(s: SpectrumSettings, buffer: number[]): void {
    buffer.push(s.scale, s.angle, s.spreadBlend, s.swell, s.alpha, s.peakOmega, s.gamma, s.shortWavesFade);
  }

  private _fill(display: DisplaySpectrumSettings, settings: SpectrumSettings): void {
    settings.scale = display.scale;
    settings.angle = (display.windDirection / 180) * Math.PI;
    settings.spreadBlend = display.spreadBlend;
    settings.swell = Scalar.Clamp(display.swell, 0.01, 1);
    settings.alpha = this._jonswapAlpha(this.g, display.fetch, display.windSpeed);
    settings.peakOmega = this._jonswapPeakFrequency(this.g, display.fetch, display.windSpeed);
    settings.gamma = display.peakEnhancement;
    settings.shortWavesFade = display.shortWavesFade;
  }

  private _jonswapAlpha(g: number, fetch: number, windSpeed: number): number {
    return 0.076 * Math.pow((g * fetch) / windSpeed / windSpeed, -0.22);
  }

  private _jonswapPeakFrequency(g: number, fetch: number, windSpeed: number): number {
    return 22 * Math.pow((windSpeed * fetch) / g / g, -0.33);
  }
}
