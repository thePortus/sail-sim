/**
 * WebGPU bake for the minimap terrain layers (WebGPU-compute roadmap P4).
 *
 * Replaces the CPU raster in minimap.component buildTerrainLayer — 2048² × getElevationFast
 * (~4.2M nearest-texel reads ≈ a ~400 ms main-thread hitch every time the layers rebuild) — with
 * one compute dispatch over the GPU-resident heightfield + a single async readPixels. The caller
 * turns the returned RGBA bytes into a canvas (rows are already in canvas order: row 0 = north —
 * the heightfield texture and the minimap share that orientation, so the kernel is a pure
 * resample + colour grade with no world math and no Y flip).
 *
 * Colour bands are an exact port of the CPU grading (water, sand, lowland green, mid brown,
 * upland, peak). KEEP IN SYNC with minimap.component buildTerrainLayer.
 *
 * WGSL rules (hard-won): NO semicolons and NO backticks inside WGSL comments.
 */
import {
  ComputeShader, UniformBuffer, RawTexture, Texture, Scene, Vector2, WebGPUEngine, Constants,
} from '@babylonjs/core';
import { ComputeHelper } from '../ocean-fft/compute-helper';

const BAKE_WGSL = /* wgsl */ `
struct Params {
  texSizeMinus1: vec2f,   // heightfield texel count - 1
  peak: f32,              // targetPeakElevation (normalises the land bands)
  _pad0: f32,
};

@group(0) @binding(0) var dest: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = textureDimensions(dest);
  if (id.x >= res.x || id.y >= res.y) { return; }

  // Canvas row 0 = north = heightfield row 0 — a straight nearest-texel resample.
  let uv = vec2f(f32(id.x) / f32(res.x - 1u), f32(id.y) / f32(res.y - 1u));
  let t = clamp(vec2i(round(uv * params.texSizeMinus1)), vec2i(0), vec2i(params.texSizeMinus1));
  let e = textureLoad(heightTex, t, 0).r;

  var c = vec3f(13.0, 38.0, 64.0);          // water
  if (e > 0.01) {
    let n = e / params.peak;
    if (n < 0.03)      { c = vec3f(170.0, 148.0, 110.0); }   // sand
    else if (n < 0.25) { c = vec3f(63.0, 104.0, 48.0); }     // lowland green
    else if (n < 0.55) { c = vec3f(95.0, 83.0, 65.0); }      // mid brown
    else if (n < 0.80) { c = vec3f(72.0, 64.0, 57.0); }      // upland
    else               { c = vec3f(56.0, 52.0, 52.0); }      // peak
  }
  textureStore(dest, vec2i(id.xy), vec4f(c / 255.0, 1.0));
}
`;

export class MinimapBakeCompute {
  private readonly cs: ComputeShader;
  private readonly params: UniformBuffer;
  private chain: Promise<unknown> = Promise.resolve();   // serialise bakes (shared UBO)

  constructor(private readonly engine: WebGPUEngine, private readonly scene: Scene) {
    this.params = new UniformBuffer(engine);
    this.params.addUniform('texSizeMinus1', 2);
    this.params.addUniform('peak', 1);
    this.params.addUniform('_pad0', 1);
    this.cs = ComputeHelper.createShader(engine, 'minimapBake', BAKE_WGSL, 'main', {
      dest:      { group: 0, binding: 0 },
      heightTex: { group: 0, binding: 1 },
      params:    { group: 0, binding: 2 },
    });
    this.cs.setUniformBuffer('params', this.params);
  }

  /** Bake one terrain layer. Resolves with res×res RGBA bytes in canvas row order. */
  bake(res: number, heightTex: Texture, texSize: Vector2, peak: number): Promise<Uint8Array> {
    const run = (): Promise<Uint8Array> => new Promise<Uint8Array>((resolve, reject) => {
      const dest: RawTexture = ComputeHelper.createStorageTexture(
        `minimapBake_${res}`, this.engine, res, res,
        Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT,
      );
      this.cs.setStorageTexture('dest', dest);
      this.cs.setTexture('heightTex', heightTex, false);
      this.params.updateFloat2('texSizeMinus1', texSize.x - 1, texSize.y - 1);
      this.params.updateFloat('peak', peak);
      this.params.updateFloat('_pad0', 0);
      this.params.update();

      // The compute shader compiles async — retry the dispatch once per frame until it lands,
      // then read the pixels back (readPixels flushes the queue, so it sees this dispatch).
      let tries = 0;
      const obs = this.scene.onBeforeRenderObservable.add(() => {
        if (!ComputeHelper.dispatch(this.cs, res, res, 1)) {
          if (++tries > 600) {
            this.scene.onBeforeRenderObservable.remove(obs);
            dest.dispose();
            reject(new Error('minimap bake compute never became ready'));
          }
          return;
        }
        this.scene.onBeforeRenderObservable.remove(obs);
        dest.readPixels(undefined, undefined, undefined, undefined, true)?.then((buf) => {
          dest.dispose();
          resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        }).catch((e) => { dest.dispose(); reject(e); });
      });
    });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);   // keep the chain alive past failures
    return next;
  }

  dispose(): void {
    this.params.dispose();
  }
}
