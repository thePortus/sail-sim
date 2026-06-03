/**
 * Minimal compute utilities for the FFT ocean — adapted from Popov72's OceanDemo
 * `computeHelper.ts`. Creates storage textures, dispatches compute shaders by parsing
 * their declared workgroup size, and copies storage textures (which can't be blitted).
 */
import {
  ComputeShader, UniformBuffer, RawTexture, Texture, BaseTexture,
  Constants, WebGPUEngine,
} from '@babylonjs/core';
import { COPY_TEXTURE_2_WGSL, COPY_TEXTURE_4_WGSL } from './wgsl';

type Bindings = Record<string, { group: number; binding: number }>;

export class ComputeHelper {
  /** Cached per-shader [x,y,z] workgroup sizes (parsed from the WGSL source). */
  private static _wg = new WeakMap<ComputeShader, [number, number, number]>();

  private static _copy4: ComputeShader | null = null;
  private static _copy2: ComputeShader | null = null;
  private static _copy4Params: UniformBuffer | null = null;
  private static _copy2Params: UniformBuffer | null = null;

  /** Create a compute shader and remember its workgroup size for Dispatch(). */
  static createShader(
    engine: WebGPUEngine, name: string, source: string, entryPoint: string, bindings: Bindings,
  ): ComputeShader {
    const cs = new ComputeShader(name, engine, { computeSource: source }, {
      bindingsMapping: bindings,
      entryPoint,
    });
    ComputeHelper._wg.set(cs, ComputeHelper._parseWorkgroup(source, entryPoint));
    return cs;
  }

  private static _parseWorkgroup(source: string, entryPoint: string): [number, number, number] {
    // Find `@workgroup_size(x,y,z)` immediately preceding `fn <entryPoint>(`.
    const rx = new RegExp(
      `workgroup_size\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)\\s*fn\\s+${entryPoint}\\s*\\(`,
      'g',
    );
    const m = rx.exec(source);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : [8, 8, 1];
  }

  /**
   * Dispatch enough workgroups to cover numIterations*, using the shader's workgroup size.
   * Returns false if the shader wasn't ready (compute shaders compile async, so an early
   * dispatch is a silent no-op — callers that dispatch once must retry until this is true).
   */
  static dispatch(cs: ComputeShader, numX: number, numY = 1, numZ = 1): boolean {
    const wg = ComputeHelper._wg.get(cs) ?? [8, 8, 1];
    return cs.dispatch(
      Math.ceil(numX / wg[0]),
      Math.ceil(numY / wg[1]),
      Math.ceil(numZ / wg[2]),
    );
  }

  static createStorageTexture(
    name: string, engine: WebGPUEngine, width: number, height: number,
    format = Constants.TEXTUREFORMAT_RGBA,
    type = Constants.TEXTURETYPE_FLOAT,
    sampling = Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    generateMipMaps = false,
    wrap = Constants.TEXTURE_WRAP_ADDRESSMODE,
  ): RawTexture {
    const tex = new RawTexture(
      null, width, height, format, engine, generateMipMaps, false, sampling, type,
      Constants.TEXTURE_CREATIONFLAG_STORAGE,
    );
    tex.name = name;
    tex.wrapU = wrap;
    tex.wrapV = wrap;
    tex.updateSamplingMode(sampling);
    return tex;
  }

  /** Copy a (sampled) texture into a storage texture via a compute pass. */
  static copyTexture(source: BaseTexture, dest: BaseTexture, engine: WebGPUEngine): void {
    const fourCh = source.getInternalTexture()!.format !== Constants.TEXTUREFORMAT_RG;

    if (fourCh && !ComputeHelper._copy4) {
      ComputeHelper._copy4Params = new UniformBuffer(engine);
      ComputeHelper._copy4Params.addUniform('width', 1);
      ComputeHelper._copy4Params.addUniform('height', 1);
      ComputeHelper._copy4 = ComputeHelper.createShader(engine, 'copyTex4', COPY_TEXTURE_4_WGSL, 'main', {
        dest: { group: 0, binding: 0 }, src: { group: 0, binding: 1 }, params: { group: 0, binding: 2 },
      });
      ComputeHelper._copy4.setUniformBuffer('params', ComputeHelper._copy4Params);
    }
    if (!fourCh && !ComputeHelper._copy2) {
      ComputeHelper._copy2Params = new UniformBuffer(engine);
      ComputeHelper._copy2Params.addUniform('width', 1);
      ComputeHelper._copy2Params.addUniform('height', 1);
      ComputeHelper._copy2 = ComputeHelper.createShader(engine, 'copyTex2', COPY_TEXTURE_2_WGSL, 'main', {
        dest: { group: 0, binding: 0 }, src: { group: 0, binding: 1 }, params: { group: 0, binding: 2 },
      });
      ComputeHelper._copy2.setUniformBuffer('params', ComputeHelper._copy2Params);
    }

    const cs = (fourCh ? ComputeHelper._copy4 : ComputeHelper._copy2)!;
    const params = (fourCh ? ComputeHelper._copy4Params : ComputeHelper._copy2Params)!;

    cs.setTexture('src', source as Texture, false);
    cs.setStorageTexture('dest', dest);

    const { width, height } = source.getSize();
    params.updateInt('width', width);
    params.updateInt('height', height);
    params.update();

    ComputeHelper.dispatch(cs, width, height, 1);
  }
}
