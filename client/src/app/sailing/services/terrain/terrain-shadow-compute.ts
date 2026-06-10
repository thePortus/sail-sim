/**
 * WebGPU compute path for the terrain shadow mask (WebGPU-compute roadmap P1).
 *
 * Replaces the CPU raymarch in terrain.service `updateTerrainShadowMask` (128² texels × up to
 * 40 ray steps ≈ 360k heightfield samples every few frames + canvas ImageData churn) with a
 * single 128² compute dispatch over the clipmap height texture that already lives on the GPU.
 * The output is consumed ONLY by the ocean shaders (u_terrainShadowMask), so there is no
 * readback — the storage texture is bound to the ocean materials directly.
 *
 * Format: rgba8unorm — storage-writable AND filterable. The ocean samples the mask with a
 * bilinear sampler (textureSampleLevel); float32 textures are not filterable on WebGPU, so
 * rgba32float here would fail bind-group validation. rgba8 also matches the old DynamicTexture,
 * keeping the soft texel-filtered shadow edges identical.
 *
 * The world→texel mapping and the march loop mirror the CPU version exactly (same 0.2 m
 * water-only gate, same +2 m occluder margin), and the height lookup copies the clipmap
 * shader's bilinear convention (uv * texSize - 0.5, floor + fract, 4 texel fetches).
 */
import {
  ComputeShader, UniformBuffer, RawTexture, Texture, Vector2, Vector4, Constants,
} from '@babylonjs/core';
import type { WebGPUEngine } from '@babylonjs/core';
import { ComputeHelper } from '../ocean-fft/compute-helper';

// NOTE: no backticks inside WGSL comments — they terminate the template literal.
const TERRAIN_SHADOW_WGSL = /* wgsl */ `
struct Params {
  center: vec2f,         // mask window centre (camera x, z)
  halfSize: f32,         // worldSize * 0.5
  worldPerTexel: f32,    // worldSize / (res - 1)
  marchX: f32,           // toward-sun march direction (xz, normalized-ish)
  marchZ: f32,
  rayRise: f32,          // ray height gain per metre marched
  steps: f32,            // ray steps (quality dial)
  stepDistance: f32,     // metres per step
  wbounds: vec4f,        // heightfield world bounds: minX, minZ, sizeX, sizeZ
  texSize: vec2f,        // heightfield texels
};

@group(0) @binding(0) var dest: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

// Bilinear ground height at world (wx, wz) — same texel convention as the clipmap material
// (r32float is not filterable, so filter manually with textureLoad).
fn groundAt(wx: f32, wz: f32) -> f32 {
  let uv = vec2f((wx - params.wbounds.x) / params.wbounds.z,
                 (params.wbounds.y + params.wbounds.w - wz) / params.wbounds.w);
  let p  = uv * params.texSize - 0.5;
  let i0 = vec2i(floor(p));
  let f  = fract(p);
  let mx = vec2i(params.texSize) - vec2i(1);
  let h00 = textureLoad(heightTex, clamp(i0,               vec2i(0), mx), 0).r;
  let h10 = textureLoad(heightTex, clamp(i0 + vec2i(1, 0), vec2i(0), mx), 0).r;
  let h01 = textureLoad(heightTex, clamp(i0 + vec2i(0, 1), vec2i(0), mx), 0).r;
  let h11 = textureLoad(heightTex, clamp(i0 + vec2i(1, 1), vec2i(0), mx), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = textureDimensions(dest);
  if (id.x >= res.x || id.y >= res.y) { return; }

  let wx = (params.center.x - params.halfSize) + f32(id.x) * params.worldPerTexel;
  let wz = (params.center.y + params.halfSize) - f32(id.y) * params.worldPerTexel;

  var mask = 0.0;
  if (groundAt(wx, wz) <= 0.2) {                       // water (and waterline) only
    for (var s = 1.0; s <= params.steps; s += 1.0) {
      let dist = params.stepDistance * s;
      let hTerrain = groundAt(wx + params.marchX * dist, wz + params.marchZ * dist);
      if (hTerrain > params.rayRise * dist + 2.0) {    // +2 m: ignore sub-noise occluders
        mask = 1.0;
        break;
      }
    }
  }
  // Store Y-FLIPPED: the CPU path painted a canvas (row 0 = north) that DynamicTexture uploads
  // Y-inverted (default invertY), so the ocean shader's UV math expects v=1 = north. textureStore
  // has no such inversion — flip the row here to match the convention the consumers were built on.
  textureStore(dest, vec2i(i32(id.x), i32(res.y) - 1 - i32(id.y)), vec4f(mask, mask, mask, 1.0));
}
`;

export class TerrainShadowCompute {
  /** The mask texture the ocean materials bind as u_terrainShadowMask. */
  readonly texture: RawTexture;

  private readonly cs: ComputeShader;
  private readonly params: UniformBuffer;
  private readonly res: number;

  constructor(engine: WebGPUEngine, res: number) {
    this.res = res;
    this.texture = ComputeHelper.createStorageTexture(
      'terrainShadowMaskGPU', engine, res, res,
      Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT,   // → rgba8unorm
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    );
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.params = new UniformBuffer(engine);
    this.params.addUniform('center', 2);
    this.params.addUniform('halfSize', 1);
    this.params.addUniform('worldPerTexel', 1);
    this.params.addUniform('marchX', 1);
    this.params.addUniform('marchZ', 1);
    this.params.addUniform('rayRise', 1);
    this.params.addUniform('steps', 1);
    this.params.addUniform('stepDistance', 1);
    this.params.addUniform('wbounds', 4);
    this.params.addUniform('texSize', 2);

    this.cs = ComputeHelper.createShader(engine, 'terrainShadowMask', TERRAIN_SHADOW_WGSL, 'main', {
      dest:      { group: 0, binding: 0 },
      heightTex: { group: 0, binding: 1 },
      params:    { group: 0, binding: 2 },
    });
    this.cs.setStorageTexture('dest', this.texture);
    this.cs.setUniformBuffer('params', this.params);
  }

  /**
   * Dispatch one mask update. Returns false while the compute shader is still compiling
   * (async) — the caller should just try again next cadence tick; the ocean keeps its
   * fallback/previous mask meanwhile.
   */
  update(
    heightTex: Texture, wbounds: Vector4, texSize: Vector2,
    cx: number, cz: number, worldSize: number,
    marchX: number, marchZ: number, rayRise: number, steps: number,
  ): boolean {
    const maxDistance = worldSize * 0.80;
    this.cs.setTexture('heightTex', heightTex, false);   // textureLoad only — no sampler
    this.params.updateFloat2('center', cx, cz);
    this.params.updateFloat('halfSize', worldSize * 0.5);
    this.params.updateFloat('worldPerTexel', worldSize / (this.res - 1));
    this.params.updateFloat('marchX', marchX);
    this.params.updateFloat('marchZ', marchZ);
    this.params.updateFloat('rayRise', rayRise);
    this.params.updateFloat('steps', steps);
    this.params.updateFloat('stepDistance', maxDistance / Math.max(1, steps));
    this.params.updateVector4('wbounds', wbounds);
    this.params.updateFloat2('texSize', texSize.x, texSize.y);
    this.params.update();
    return ComputeHelper.dispatch(this.cs, this.res, this.res, 1);
  }

  dispose(): void {
    this.params.dispose();
    this.texture.dispose();
  }
}
