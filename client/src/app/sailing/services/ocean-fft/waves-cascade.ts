/**
 * WavesCascade — one frequency band of the FFT ocean. Per frame: evolve the spectrum to
 * time t (4 RG spectra), inverse-FFT each, then merge into the displacement / derivatives /
 * turbulence(foam) textures the ocean material samples. Ported from Popov72's OceanDemo
 * `wavesCascade.ts`.
 */
import {
  ComputeShader, UniformBuffer, BaseTexture, Constants, WebGPUEngine,
} from '@babylonjs/core';
import { ComputeHelper } from './compute-helper';
import { FFT } from './fft';
import { InitialSpectrum } from './initial-spectrum';
import { WavesSettings } from './waves-settings';
import { TIME_DEPENDENT_SPECTRUM_WGSL, WAVES_MERGER_WGSL } from './wgsl';

const HALF = Constants.TEXTURETYPE_HALF_FLOAT;
const BILINEAR = Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
const TRILINEAR = Constants.TEXTURE_TRILINEAR_SAMPLINGMODE;

export class WavesCascade {
  private _engine: WebGPUEngine;
  private _size: number;
  private _fft: FFT;
  private _initialSpectrum: InitialSpectrum;
  private _lambda = 0;

  private _timeDependentSpectrum: ComputeShader;
  private _timeParams: UniformBuffer;
  private _buffer: BaseTexture;
  private _DxDz: BaseTexture;
  private _DyDxz: BaseTexture;
  private _DyxDyz: BaseTexture;
  private _DxxDzz: BaseTexture;

  private _merger: ComputeShader;
  private _mergerParams: UniformBuffer;
  private _displacement: BaseTexture;
  private _derivatives: BaseTexture;
  private _turbulence: BaseTexture;
  private _turbulence2: BaseTexture;
  private _pingPong = false;

  get displacement() { return this._displacement; }
  get derivatives() { return this._derivatives; }
  get turbulence() { return this._pingPong ? this._turbulence2 : this._turbulence; }

  constructor(size: number, noise: BaseTexture, fft: FFT, engine: WebGPUEngine) {
    this._engine = engine;
    this._size = size;
    this._fft = fft;

    this._initialSpectrum = new InitialSpectrum(engine, size, noise);

    const rg = Constants.TEXTUREFORMAT_RG;
    const rgba = Constants.TEXTUREFORMAT_RGBA;

    this._buffer = ComputeHelper.createStorageTexture('buffer', engine, size, size, rg);
    this._DxDz = ComputeHelper.createStorageTexture('DxDz', engine, size, size, rg);
    this._DyDxz = ComputeHelper.createStorageTexture('DyDxz', engine, size, size, rg);
    this._DyxDyz = ComputeHelper.createStorageTexture('DyxDyz', engine, size, size, rg);
    this._DxxDzz = ComputeHelper.createStorageTexture('DxxDzz', engine, size, size, rg);

    this._timeParams = new UniformBuffer(engine);
    this._timeParams.addUniform('Time', 1);

    this._timeDependentSpectrum = ComputeHelper.createShader(engine, 'timeDependentSpectrum', TIME_DEPENDENT_SPECTRUM_WGSL, 'calculateAmplitudes', {
      H0: { group: 0, binding: 1 },
      WavesData: { group: 0, binding: 3 },
      params: { group: 0, binding: 4 },
      DxDz: { group: 0, binding: 5 },
      DyDxz: { group: 0, binding: 6 },
      DyxDyz: { group: 0, binding: 7 },
      DxxDzz: { group: 0, binding: 8 },
    });
    this._timeDependentSpectrum.setTexture('H0', this._initialSpectrum.initialSpectrum as never, false);
    this._timeDependentSpectrum.setTexture('WavesData', this._initialSpectrum.wavesData as never, false);
    this._timeDependentSpectrum.setUniformBuffer('params', this._timeParams);
    this._timeDependentSpectrum.setStorageTexture('DxDz', this._DxDz);
    this._timeDependentSpectrum.setStorageTexture('DyDxz', this._DyDxz);
    this._timeDependentSpectrum.setStorageTexture('DyxDyz', this._DyxDyz);
    this._timeDependentSpectrum.setStorageTexture('DxxDzz', this._DxxDzz);

    this._displacement = ComputeHelper.createStorageTexture('displacement', engine, size, size, rgba, HALF, BILINEAR);
    this._derivatives = ComputeHelper.createStorageTexture('derivatives', engine, size, size, rgba, HALF, TRILINEAR, true);
    this._turbulence = ComputeHelper.createStorageTexture('turbulence', engine, size, size, rgba, HALF, TRILINEAR, true);
    this._turbulence2 = ComputeHelper.createStorageTexture('turbulence2', engine, size, size, rgba, HALF, TRILINEAR, true);

    this._mergerParams = new UniformBuffer(engine);
    this._mergerParams.addUniform('Lambda', 1);
    this._mergerParams.addUniform('DeltaTime', 1);

    this._merger = ComputeHelper.createShader(engine, 'wavesMerger', WAVES_MERGER_WGSL, 'fillResultTextures', {
      params: { group: 0, binding: 0 },
      Displacement: { group: 0, binding: 1 },
      Derivatives: { group: 0, binding: 2 },
      TurbulenceRead: { group: 0, binding: 3 },
      TurbulenceWrite: { group: 0, binding: 4 },
      DxDz: { group: 0, binding: 5 },
      DyDxz: { group: 0, binding: 6 },
      DyxDyz: { group: 0, binding: 7 },
      DxxDzz: { group: 0, binding: 8 },
    });
    this._merger.setUniformBuffer('params', this._mergerParams);
    this._merger.setStorageTexture('Displacement', this._displacement);
    this._merger.setStorageTexture('Derivatives', this._derivatives);
    this._merger.setTexture('DxDz', this._DxDz as never, false);
    this._merger.setTexture('DyDxz', this._DyDxz as never, false);
    this._merger.setTexture('DyxDyz', this._DyxDyz as never, false);
    this._merger.setTexture('DxxDzz', this._DxxDzz as never, false);
  }

  /** Rebuild the static spectrum (call on weather change). */
  calculateInitials(wavesSettings: WavesSettings, lengthScale: number, cutoffLow: number, cutoffHigh: number): void {
    this._lambda = wavesSettings.lambda;
    this._initialSpectrum.generate(wavesSettings, lengthScale, cutoffLow, cutoffHigh);
  }

  /** Advance to time t and refresh displacement/derivatives/turbulence (call per frame). */
  calculateWavesAtTime(time: number): void {
    this._timeParams.updateFloat('Time', time);
    this._timeParams.update();
    ComputeHelper.dispatch(this._timeDependentSpectrum, this._size, this._size, 1);

    this._fft.IFFT2D(this._DxDz, this._buffer);
    this._fft.IFFT2D(this._DyDxz, this._buffer);
    this._fft.IFFT2D(this._DyxDyz, this._buffer);
    this._fft.IFFT2D(this._DxxDzz, this._buffer);

    let deltaTime = this._engine.getDeltaTime() / 1000;
    if (deltaTime > 0.5) { deltaTime = 0.5; }
    this._mergerParams.updateFloat('Lambda', this._lambda);
    this._mergerParams.updateFloat('DeltaTime', deltaTime);
    this._mergerParams.update();

    this._pingPong = !this._pingPong;
    this._merger.setTexture('TurbulenceRead', (this._pingPong ? this._turbulence : this._turbulence2) as never, false);
    this._merger.setStorageTexture('TurbulenceWrite', this._pingPong ? this._turbulence2 : this._turbulence);

    ComputeHelper.dispatch(this._merger, this._size, this._size, 1);

    this._engine.generateMipmaps(this._derivatives.getInternalTexture()!);
    this._engine.generateMipmaps((this._pingPong ? this._turbulence2 : this._turbulence).getInternalTexture()!);
  }

  dispose(): void {
    this._initialSpectrum.dispose();
    this._timeParams.dispose();
    this._buffer.dispose();
    this._DxDz.dispose();
    this._DyDxz.dispose();
    this._DyxDyz.dispose();
    this._DxxDzz.dispose();
    this._mergerParams.dispose();
    this._displacement.dispose();
    this._derivatives.dispose();
    this._turbulence.dispose();
    this._turbulence2.dispose();
  }
}
