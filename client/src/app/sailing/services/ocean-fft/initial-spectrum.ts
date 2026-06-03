/**
 * InitialSpectrum — builds the static h0(k) spectrum for one cascade (two compute passes:
 * JONSWAP spectrum, then conjugate packing). Re-run on every weather change.
 * Ported from Popov72's OceanDemo `initialSpectrum.ts`.
 */
import {
  ComputeShader, UniformBuffer, StorageBuffer, BaseTexture, Constants, WebGPUEngine,
} from '@babylonjs/core';
import { ComputeHelper } from './compute-helper';
import { WavesSettings } from './waves-settings';
import { INITIAL_SPECTRUM_WGSL, CONJUGATE_SPECTRUM_WGSL } from './wgsl';

export class InitialSpectrum {
  private _engine: WebGPUEngine;
  private _size: number;

  private _phase1: ComputeShader;
  private _phase2: ComputeShader;
  private _spectrumParameters: StorageBuffer;
  private _params: UniformBuffer;

  private _initialSpectrum: BaseTexture;   // H0 (RGBA32F): h0(k) + h0(-k)*
  private _precomputedData: BaseTexture;   // WavesData (RGBA32F): kx, 1/|k|, kz, omega
  private _buffer: BaseTexture;            // H0K scratch (RG32F)

  get initialSpectrum() { return this._initialSpectrum; }
  get wavesData() { return this._precomputedData; }

  constructor(engine: WebGPUEngine, size: number, noise: BaseTexture) {
    this._engine = engine;
    this._size = size;

    this._initialSpectrum = ComputeHelper.createStorageTexture('h0', engine, size, size, Constants.TEXTUREFORMAT_RGBA);
    this._precomputedData = ComputeHelper.createStorageTexture('wavesData', engine, size, size, Constants.TEXTUREFORMAT_RGBA);
    this._buffer = ComputeHelper.createStorageTexture('h0k', engine, size, size, Constants.TEXTUREFORMAT_RG);

    this._spectrumParameters = new StorageBuffer(engine, 8 * 2 * 4, Constants.BUFFER_CREATIONFLAG_READWRITE);

    this._params = new UniformBuffer(engine);
    this._params.addUniform('Size', 1);
    this._params.addUniform('LengthScale', 1);
    this._params.addUniform('CutoffHigh', 1);
    this._params.addUniform('CutoffLow', 1);
    this._params.addUniform('GravityAcceleration', 1);
    this._params.addUniform('Depth', 1);

    this._phase1 = ComputeHelper.createShader(engine, 'initialSpectrum', INITIAL_SPECTRUM_WGSL, 'calculateInitialSpectrum', {
      WavesData: { group: 0, binding: 1 },
      H0K: { group: 0, binding: 2 },
      Noise: { group: 0, binding: 4 },
      params: { group: 0, binding: 5 },
      spectrumParameters: { group: 0, binding: 6 },
    });
    this._phase1.setStorageTexture('WavesData', this._precomputedData);
    this._phase1.setStorageTexture('H0K', this._buffer);
    this._phase1.setTexture('Noise', noise as never, false);
    this._phase1.setStorageBuffer('spectrumParameters', this._spectrumParameters);
    this._phase1.setUniformBuffer('params', this._params);

    this._phase2 = ComputeHelper.createShader(engine, 'conjugateSpectrum', CONJUGATE_SPECTRUM_WGSL, 'calculateConjugatedSpectrum', {
      H0: { group: 0, binding: 0 },
      params: { group: 0, binding: 5 },
      H0K: { group: 0, binding: 8 },
    });
    this._phase2.setStorageTexture('H0', this._initialSpectrum);
    this._phase2.setUniformBuffer('params', this._params);
    this._phase2.setTexture('H0K', this._buffer as never, false);
  }

  generate(wavesSettings: WavesSettings, lengthScale: number, cutoffLow: number, cutoffHigh: number): void {
    this._params.updateInt('Size', this._size);
    this._params.updateFloat('LengthScale', lengthScale);
    this._params.updateFloat('CutoffHigh', cutoffHigh);
    this._params.updateFloat('CutoffLow', cutoffLow);

    wavesSettings.setParametersToShader(this._params, this._spectrumParameters);
    this._params.update();

    ComputeHelper.dispatch(this._phase1, this._size, this._size, 1);
    ComputeHelper.dispatch(this._phase2, this._size, this._size, 1);
  }

  dispose(): void {
    this._spectrumParameters.dispose();
    this._params.dispose();
    this._precomputedData.dispose();
    this._buffer.dispose();
    this._initialSpectrum.dispose();
  }
}
