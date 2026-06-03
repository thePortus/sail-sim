/**
 * FFT — radix-2 inverse FFT over a size×size complex (RG) texture, via the precomputed
 * twiddle-factor table. logN horizontal butterfly passes, logN vertical passes, then a
 * checkerboard permutation. Based on Popov72's OceanDemo `fft.ts`.
 *
 * IMPORTANT difference from the demo: each butterfly pass gets its OWN uniform buffer with
 * its `Step` baked in. The demo mutated a single shared uniform buffer between passes, which
 * under Babylon 7's WebGPU backend makes every recorded dispatch read the FINAL Step at
 * submit time (the buffer is written in place) — collapsing the transform to zero. Per-pass
 * constant buffers remove that race.
 */
import {
  ComputeShader, UniformBuffer, BaseTexture, Constants, WebGPUEngine,
} from '@babylonjs/core';
import { ComputeHelper } from './compute-helper';
import { FFT_PRECOMPUTE_WGSL, FFT_HORIZONTAL_WGSL, FFT_VERTICAL_WGSL, FFT_PERMUTE_WGSL } from './wgsl';

export class FFT {
  private _engine: WebGPUEngine;
  private _size: number;
  private _logSize: number;

  private _precomputedData: BaseTexture;
  private _stepParams: UniformBuffer[];   // one per butterfly pass, Step baked in
  private _precompute: ComputeShader;
  private _precomputeDone = false;        // twiddle table built? (async-compile retry)
  private _horizontal: ComputeShader;
  private _vertical: ComputeShader;
  private _permute: ComputeShader;

  constructor(engine: WebGPUEngine, size: number) {
    this._engine = engine;
    this._size = size;
    this._logSize = Math.log2(size) | 0;

    this._precomputedData = ComputeHelper.createStorageTexture(
      'precomputeTwiddle', engine, this._logSize, size, Constants.TEXTUREFORMAT_RGBA,
    );

    // One constant uniform buffer per pass: { Step: i, Size: N }.
    this._stepParams = [];
    for (let i = 0; i < this._logSize; i++) {
      const ub = new UniformBuffer(engine);
      ub.addUniform('Step', 1);
      ub.addUniform('Size', 1);
      ub.updateInt('Step', i);
      ub.updateInt('Size', size);
      ub.update();
      this._stepParams.push(ub);
    }

    this._precompute = ComputeHelper.createShader(engine, 'fftPrecompute', FFT_PRECOMPUTE_WGSL, 'precomputeTwiddleFactorsAndInputIndices', {
      PrecomputeBuffer: { group: 0, binding: 0 },
      params: { group: 0, binding: 1 },
    });
    this._precompute.setStorageTexture('PrecomputeBuffer', this._precomputedData);
    this._precompute.setUniformBuffer('params', this._stepParams[0]);   // precompute uses Size only
    this._ensurePrecompute();   // tries now; retried each IFFT until the shader is ready

    this._horizontal = ComputeHelper.createShader(engine, 'fftHorizontal', FFT_HORIZONTAL_WGSL, 'horizontalStepInverseFFT', {
      params: { group: 0, binding: 1 },
      PrecomputedData: { group: 0, binding: 3 },
      InputBuffer: { group: 0, binding: 5 },
      OutputBuffer: { group: 0, binding: 6 },
    });
    this._horizontal.setTexture('PrecomputedData', this._precomputedData as never, false);

    this._vertical = ComputeHelper.createShader(engine, 'fftVertical', FFT_VERTICAL_WGSL, 'verticalStepInverseFFT', {
      params: { group: 0, binding: 1 },
      PrecomputedData: { group: 0, binding: 3 },
      InputBuffer: { group: 0, binding: 5 },
      OutputBuffer: { group: 0, binding: 6 },
    });
    this._vertical.setTexture('PrecomputedData', this._precomputedData as never, false);

    this._permute = ComputeHelper.createShader(engine, 'fftPermute', FFT_PERMUTE_WGSL, 'permute', {
      InputBuffer: { group: 0, binding: 5 },
      OutputBuffer: { group: 0, binding: 6 },
    });
  }

  /** Build the twiddle table if it hasn't been (the constructor's attempt may have been a
   *  no-op because the shader was still compiling). Idempotent once it succeeds. */
  private _ensurePrecompute(): void {
    if (this._precomputeDone) { return; }
    this._precomputeDone = ComputeHelper.dispatch(this._precompute, this._logSize, this._size / 2, 1);
  }

  /** In-place inverse FFT of `input` (RG), using `buffer` (RG) as ping-pong scratch. */
  IFFT2D(input: BaseTexture, buffer: BaseTexture): void {
    this._ensurePrecompute();
    const logSize = this._logSize;
    let pingPong = false;

    for (let i = 0; i < logSize; ++i) {
      pingPong = !pingPong;
      this._horizontal.setUniformBuffer('params', this._stepParams[i]);
      this._horizontal.setTexture('InputBuffer', (pingPong ? input : buffer) as never, false);
      this._horizontal.setStorageTexture('OutputBuffer', pingPong ? buffer : input);
      ComputeHelper.dispatch(this._horizontal, this._size, this._size, 1);
    }

    for (let i = 0; i < logSize; ++i) {
      pingPong = !pingPong;
      this._vertical.setUniformBuffer('params', this._stepParams[i]);
      this._vertical.setTexture('InputBuffer', (pingPong ? input : buffer) as never, false);
      this._vertical.setStorageTexture('OutputBuffer', pingPong ? buffer : input);
      ComputeHelper.dispatch(this._vertical, this._size, this._size, 1);
    }

    if (pingPong) {
      ComputeHelper.copyTexture(buffer, input, this._engine);
    }

    this._permute.setTexture('InputBuffer', input as never, false);
    this._permute.setStorageTexture('OutputBuffer', buffer);
    ComputeHelper.dispatch(this._permute, this._size, this._size, 1);

    ComputeHelper.copyTexture(buffer, input, this._engine);
  }

  dispose(): void {
    this._precomputedData.dispose();
    this._stepParams.forEach((ub) => ub.dispose());
  }
}
