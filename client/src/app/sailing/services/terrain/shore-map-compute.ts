/**
 * WebGPU compute path for the shore proximity map (WebGPU-compute roadmap P2).
 *
 * Replaces the CPU double pass in terrain.service `updateShoreMap` (128² nearest-texel land scan +
 * an 8-direction × 8-step search per water texel ≈ 1M array ops every 10 frames + canvas churn)
 * with one 128² compute dispatch over the GPU-resident clipmap height texture. The result feeds:
 *   - the ocean shaders directly (u_shoreMap — shoaling attenuation, shallow tint, caustics, fish),
 *   - the CPU buoyancy twin via a small async readback (~64 KB) handled by the caller, so
 *     `shoreProximityAt` keeps serving the SAME data the vertex shader reads.
 *
 * Texel-faithful port of the CPU version:
 *   - land test = nearest heightfield texel (round, clamped) strictly above the waterline; the
 *     quantized `hf > waterlineQ` compare becomes a metre threshold of (waterlineQ + 0.5) quanta,
 *     exact because the height texture stores dequantized integer multiples.
 *   - proximity = 1 − (minDist − 1) / 7 over the 8-direction search, window-bounds break included.
 *   - output rgba8unorm with proximity in R (the ocean reads .r; the old DynamicTexture was rgba8).
 */
import {
  ComputeShader, UniformBuffer, RawTexture, Texture, Vector2, Vector4, Constants,
} from '@babylonjs/core';
import type { WebGPUEngine } from '@babylonjs/core';
import { ComputeHelper } from '../ocean-fft/compute-helper';

// NOTE: no backticks inside WGSL comments — they terminate the template literal.
const SHORE_MAP_WGSL = /* wgsl */ `
struct Params {
  center: vec2f,          // window centre (camera x, z)
  halfSize: f32,          // worldSize * 0.5
  worldPerTexel: f32,     // worldSize / (res - 1)
  landThreshold: f32,     // metres — height above this = land (NO semicolons in WGSL comments: Babylon's preprocessor line-splits on them)
  _pad0: f32,
  texSizeMinus1: vec2f,   // heightfield texel count - 1
  wbounds: vec4f,         // heightfield world bounds: minX, minZ, sizeX, sizeZ
};

@group(0) @binding(0) var dest: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

// Nearest-texel land test at WINDOW texel (px, py) — mirrors terrain.service isLandRaw.
fn isLand(px: i32, py: i32) -> bool {
  let wx = (params.center.x - params.halfSize) + f32(px) * params.worldPerTexel;
  let wz = (params.center.y + params.halfSize) - f32(py) * params.worldPerTexel;
  let u = (wx - params.wbounds.x) / params.wbounds.z;
  let v = (params.wbounds.y + params.wbounds.w - wz) / params.wbounds.w;
  let t = vec2i(round(vec2f(u, v) * params.texSizeMinus1));
  let tc = clamp(t, vec2i(0), vec2i(params.texSizeMinus1));
  return textureLoad(heightTex, tc, 0).r > params.landThreshold;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = textureDimensions(dest);
  if (id.x >= res.x || id.y >= res.y) { return; }
  let px = i32(id.x);
  let py = i32(id.y);
  let resI = vec2i(res);

  var encoded = 1.0;                     // land texel: full proximity
  if (!isLand(px, py)) {
    // Water texel: distance to the closest land texel along 8 directions (window-bounded).
    var dirs = array<vec2i, 8>(
      vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1),
      vec2i(-1, -1), vec2i(-1, 1), vec2i(1, -1), vec2i(1, 1),
    );
    var minDist = 8;                     // MAX_STEPS
    for (var d = 0; d < 8; d++) {
      if (minDist <= 1) { break; }       // cannot get any closer
      for (var s = 1; s < minDist; s++) {
        let nx = px + dirs[d].x * s;
        let ny = py + dirs[d].y * s;
        if (nx < 0 || nx >= resI.x || ny < 0 || ny >= resI.y) { break; }
        if (isLand(nx, ny)) { minDist = s; break; }
      }
    }
    encoded = max(0.0, 1.0 - f32(minDist - 1) / 7.0);   // 1 = adjacent to land, 0 = 8+ texels out
  }
  // Store Y-FLIPPED: the CPU path painted a canvas (row 0 = north) that DynamicTexture uploads
  // Y-inverted (default invertY), so the ocean shader's UV math expects v=1 = north. textureStore
  // has no such inversion — flip the row here to match the convention the consumers were built on.
  textureStore(dest, vec2i(px, resI.y - 1 - py), vec4f(encoded, 0.0, 0.0, 1.0));
}
`;

export class ShoreMapCompute {
  /** The proximity texture the ocean materials bind as u_shoreMap (proximity in R). */
  readonly texture: RawTexture;

  private readonly cs: ComputeShader;
  private readonly params: UniformBuffer;
  private readonly res: number;

  constructor(engine: WebGPUEngine, res: number) {
    this.res = res;
    this.texture = ComputeHelper.createStorageTexture(
      'shoreMapGPU', engine, res, res,
      Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_INT,   // → rgba8unorm (filterable)
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    );
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.params = new UniformBuffer(engine);
    this.params.addUniform('center', 2);
    this.params.addUniform('halfSize', 1);
    this.params.addUniform('worldPerTexel', 1);
    this.params.addUniform('landThreshold', 1);
    this.params.addUniform('_pad0', 1);
    this.params.addUniform('texSizeMinus1', 2);
    this.params.addUniform('wbounds', 4);

    this.cs = ComputeHelper.createShader(engine, 'shoreMap', SHORE_MAP_WGSL, 'main', {
      dest:      { group: 0, binding: 0 },
      heightTex: { group: 0, binding: 1 },
      params:    { group: 0, binding: 2 },
    });
    this.cs.setStorageTexture('dest', this.texture);
    this.cs.setUniformBuffer('params', this.params);
  }

  /** Dispatch one shore-map update. Returns false while the compute shader is still compiling. */
  update(
    heightTex: Texture, wbounds: Vector4, texSize: Vector2,
    cx: number, cz: number, worldSize: number, landThreshold: number,
  ): boolean {
    this.cs.setTexture('heightTex', heightTex, false);   // textureLoad only — no sampler
    this.params.updateFloat2('center', cx, cz);
    this.params.updateFloat('halfSize', worldSize * 0.5);
    this.params.updateFloat('worldPerTexel', worldSize / (this.res - 1));
    this.params.updateFloat('landThreshold', landThreshold);
    this.params.updateFloat('_pad0', 0);
    this.params.updateFloat2('texSizeMinus1', texSize.x - 1, texSize.y - 1);
    this.params.updateVector4('wbounds', wbounds);
    this.params.update();
    return ComputeHelper.dispatch(this.cs, this.res, this.res, 1);
  }

  dispose(): void {
    this.params.dispose();
    this.texture.dispose();
  }
}
