import {
  MaterialPluginBase, Material, UniformBuffer, ShaderLanguage, Nullable,
} from '@babylonjs/core';

/**
 * Hull & deck WETNESS — a fragment plugin attached to each vessel's hull/deck PBRMaterial
 * (NOT sails/flags/rigging). Port of the native client's mesh.wgsl wetness. Built in phases:
 *
 *   Phase 1: a wet FILM — the hull darkens in a band around the waterline, and rain darkens
 *     up-facing surfaces.
 *   Phase 2: standing deck PUDDLES (flat, up-facing deck floor above the waterline, pooled patchily
 *     where rain gathers) darkened toward wet wood, plus a wet SHEEN — an analytic sun-specular glint
 *     that is sharper on standing water and fades at night. The sheen replaces the roughness-drop the
 *     native shader does: Babylon exposes no injection point to lower `roughness` before its light
 *     loop, so instead we add our own highlight lobe at the proven CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR
 *     point using the in-scope shading normal (normalW) and view vector (viewDirectionW).
 *   Phase 3 (this): WAVE-FOLLOWING waterline. Instead of a flat plane at seaY, the local sea surface
 *     is a tangent PLANE to the real swell at the ship — VesselService samples the ocean's actual
 *     height field (getWaveHeightAt, the same field the hull floats on, be it FFT or procedural) at
 *     the ship and ±ε in x/z each frame, deriving the sea height + its world-space gradient. The
 *     shader then reconstructs localSea = seaY + grad·(worldXZ − shipXZ) so the wetline heaves and
 *     tilts with the swell against each part of the hull. The offset is clamped to the local wave
 *     amplitude so it stays sane for distant ships (they share the one global static). Sub-hull
 *     undulation (waves shorter than the hull) isn't captured by a single plane — that would need a
 *     per-fragment height texture; a later refinement if wanted.
 *   Later phases: puddle sky reflections + raindrop ripples.
 *
 * Global per-frame state (sea-surface Y at the local ship, rain, time, sun direction, enable) lives
 * in a static updated once per frame by VesselService — mirroring SailBillowPlugin.wind. Emits WGSL
 * (WebGPU) and GLSL (WebGL); this client supports both.
 */
export class WetnessPlugin extends MaterialPluginBase {
  /** Scene-wide wetness state, pushed once per frame by VesselService.pumpWetness(). */
  static readonly shared = {
    seaY: 0,       // sea-surface world Y at the local ship (the waterline height)
    reach: 0.35,   // splash reach (m) above the sea the wet band climbs the hull
    rain: 0,       // rain intensity [0,1]
    time: 0,       // seconds (unused pre-ripples; drives puddle ripples later)
    sunX: -0.4,    // unit vector TOWARD the sun (world) — drives the wet sheen highlight
    sunY: 0.8,
    sunZ: 0.6,
    shipX: 0,      // local ship world XZ — anchor of the wave tangent plane
    shipZ: 0,
    gradX: 0,      // world-space sea-height gradient at the ship (dH/dx, dH/dz)
    gradZ: 0,
    amp: 1,        // local wave amplitude (m) — clamps the tangent-plane offset for distant fragments
    enabled: 1,    // 0 = off (shader no-ops), 1 = on
  };

  constructor(material: Material) {
    super(material, 'Wetness', 205, { WETNESS: true });
    this._enable(true);
  }

  override isCompatible(): boolean { return true; }             // GLSL + WGSL
  override getClassName(): string { return 'WetnessPlugin'; }

  override getUniforms() {
    return { ubo: [
      { name: 'wetSeaY',    size: 1, type: 'float' },
      { name: 'wetReach',   size: 1, type: 'float' },
      { name: 'wetRain',    size: 1, type: 'float' },
      { name: 'wetEnabled', size: 1, type: 'float' },
      { name: 'wetSunDir',  size: 3, type: 'vec3'  },
      { name: 'wetWave',    size: 4, type: 'vec4'  },
      { name: 'wetAmp',     size: 1, type: 'float' },
    ] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const s = WetnessPlugin.shared;
    uniformBuffer.updateFloat('wetSeaY', s.seaY);
    uniformBuffer.updateFloat('wetReach', s.reach);
    uniformBuffer.updateFloat('wetRain', s.rain);
    uniformBuffer.updateFloat('wetEnabled', s.enabled);
    uniformBuffer.updateFloat3('wetSunDir', s.sunX, s.sunY, s.sunZ);
    uniformBuffer.updateFloat4('wetWave', s.shipX, s.shipZ, s.gradX, s.gradZ);
    uniformBuffer.updateFloat('wetAmp', s.amp);
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{ [point: string]: string }> {
    if (shaderType !== 'fragment') { return null; }
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: WetnessPlugin.WGSL_DEFS,
        CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: WetnessPlugin.WGSL,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: WetnessPlugin.GLSL_DEFS,
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: WetnessPlugin.GLSL,
    };
  }

  // ── Value noise (2D) for patchy puddle placement — cheap 4-corner bilinear hash. ──
  private static readonly GLSL_DEFS = `
    float wetHash21(vec2 p) {
      vec2 q = p - floor(p / 512.0) * 512.0;
      return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453);
    }
    float wetNoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = wetHash21(i);
      float b = wetHash21(i + vec2(1.0, 0.0));
      float c = wetHash21(i + vec2(0.0, 1.0));
      float d = wetHash21(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
  `;

  private static readonly WGSL_DEFS = `
    fn wetHash21(p : vec2f) -> f32 {
      let q = p - floor(p / 512.0) * 512.0;
      return fract(sin(dot(q, vec2f(127.1, 311.7))) * 43758.5453);
    }
    fn wetNoise(p : vec2f) -> f32 {
      let i = floor(p); let f = fract(p);
      let u = f * f * (3.0 - 2.0 * f);
      let a = wetHash21(i);
      let b = wetHash21(i + vec2f(1.0, 0.0));
      let c = wetHash21(i + vec2f(0.0, 1.0));
      let d = wetHash21(i + vec2f(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
  `;

  // Wet band at the waterline + rain film (Phase 1), standing deck puddles, and a sun-specular sheen
  // (Phase 2). finalColor is the lit (image-processed) colour; normalW/viewDirectionW are the in-scope
  // final shading normal and view vector.
  private static readonly GLSL = `
    if (wetEnabled > 0.5) {
      float wNUp = normalize(vNormalW).y;
      // Wave-following waterline: tangent plane to the swell at the ship (localSea = seaY + grad·d).
      float wOff = clamp(wetWave.z * (vPositionW.x - wetWave.x) + wetWave.w * (vPositionW.z - wetWave.y), -wetAmp, wetAmp);
      float wLocalSea = wetSeaY + wOff;
      float wWL  = clamp(1.0 - smoothstep(wLocalSea - 0.05, wLocalSea + wetReach, vPositionW.y), 0.0, 1.0);
      float wRainUp = clamp(wNUp * 0.45 + 0.5, 0.0, 1.0);
      float wDamp = max(wWL, wetRain * wRainUp);
      // Standing deck puddles: flat (small worldY derivative), up-facing deck floor from the waterline
      // up to ~4 m, pooled patchily where rain gathers — not every up-facing fitting.
      float wFlat   = 1.0 - smoothstep(0.02, 0.09, fwidth(vPositionW.y));
      float wUpFace = smoothstep(0.6, 0.85, wNUp);
      float wAbove  = step(wLocalSea, vPositionW.y) * (1.0 - step(wLocalSea + 4.0, vPositionW.y));
      float wPatch  = smoothstep(0.5, 0.8, wetNoise(vPositionW.xz * 0.6));
      float wPuddle = wFlat * wUpFace * wAbove * wPatch * clamp(wetRain * 1.3, 0.0, 1.0);
      // Darken: wet film toward wet wood, standing water darker still (grain visible through the pool).
      finalColor.rgb *= mix(mix(1.0, 0.68, wDamp), 0.5, wPuddle);
      // Wet sheen: an analytic sun highlight, sharper on standing water, faded when the sun is low/set.
      vec3 wH = normalize(normalize(viewDirectionW) + wetSunDir);
      float wDay  = clamp(wetSunDir.y * 3.0, 0.0, 1.0);
      float wWet  = max(wDamp, wPuddle);
      float wShin = mix(60.0, 400.0, wPuddle);
      float wSpec = pow(max(dot(normalize(normalW), wH), 0.0), wShin) * wWet * wDay;
      finalColor.rgb += vec3(wSpec * 0.7);
    }
  `;

  private static readonly WGSL = `
    if (uniforms.wetEnabled > 0.5) {
      let wNUp = normalize(fragmentInputs.vNormalW).y;
      // Wave-following waterline: tangent plane to the swell at the ship (localSea = seaY + grad·d).
      let wOff = clamp(uniforms.wetWave.z * (fragmentInputs.vPositionW.x - uniforms.wetWave.x) + uniforms.wetWave.w * (fragmentInputs.vPositionW.z - uniforms.wetWave.y), -uniforms.wetAmp, uniforms.wetAmp);
      let wLocalSea = uniforms.wetSeaY + wOff;
      let wWL  = clamp(1.0 - smoothstep(wLocalSea - 0.05, wLocalSea + uniforms.wetReach, fragmentInputs.vPositionW.y), 0.0, 1.0);
      let wRainUp = clamp(wNUp * 0.45 + 0.5, 0.0, 1.0);
      let wDamp = max(wWL, uniforms.wetRain * wRainUp);
      // Standing deck puddles: flat, up-facing deck floor above the waterline, pooled patchily by rain.
      let wFlat   = 1.0 - smoothstep(0.02, 0.09, fwidth(fragmentInputs.vPositionW.y));
      let wUpFace = smoothstep(0.6, 0.85, wNUp);
      let wAbove  = step(wLocalSea, fragmentInputs.vPositionW.y) * (1.0 - step(wLocalSea + 4.0, fragmentInputs.vPositionW.y));
      let wPatch  = smoothstep(0.5, 0.8, wetNoise(fragmentInputs.vPositionW.xz * 0.6));
      let wPuddle = wFlat * wUpFace * wAbove * wPatch * clamp(uniforms.wetRain * 1.3, 0.0, 1.0);
      // Darken: wet film toward wet wood, standing water darker still (grain visible through the pool).
      finalColor = vec4f(finalColor.rgb * mix(mix(1.0, 0.68, wDamp), 0.5, wPuddle), finalColor.a);
      // Wet sheen: an analytic sun highlight, sharper on standing water, faded when the sun is low/set.
      let wH = normalize(normalize(viewDirectionW) + uniforms.wetSunDir);
      let wDay  = clamp(uniforms.wetSunDir.y * 3.0, 0.0, 1.0);
      let wWet  = max(wDamp, wPuddle);
      let wShin = mix(60.0, 400.0, wPuddle);
      let wSpec = pow(max(dot(normalize(normalW), wH), 0.0), wShin) * wWet * wDay;
      finalColor = vec4f(finalColor.rgb + vec3f(wSpec * 0.7), finalColor.a);
    }
  `;
}
