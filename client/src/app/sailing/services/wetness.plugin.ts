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
      { name: 'wetTime',    size: 1, type: 'float' },
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
    uniformBuffer.updateFloat('wetTime', s.time);
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

  // ── Helpers: value noise for puddle placement, the raindrop ripple field (VERBATIM port of the
  //    ocean's rainField so puddle droplets match the raindrops on the water), and an analytic sky
  //    reflection for the puddle surface (Phase 4). ──
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
    float deckRainField(vec2 p, float t) {
      vec2 cell = floor(p); vec2 f = fract(p);
      float h1 = wetHash21(cell); float h2 = wetHash21(cell + 5.7);
      float h3 = wetHash21(cell + 11.3); float h4 = wetHash21(cell + 19.1);
      vec2 center = vec2(0.2 + h1 * 0.6, 0.2 + h2 * 0.6);
      float rate = mix(1.0, 3.2, h3);
      float life = fract(t * rate + h1 * 7.0);
      float r = length(f - center);
      float sz = mix(0.16, 0.42, h4);
      float impact = (1.0 - smoothstep(0.0, sz * 0.55, r)) * (1.0 - smoothstep(0.0, 0.22, life));
      float ringR = life * sz * 1.6;
      float ring = 1.0 - smoothstep(0.0, sz * 0.34, abs(r - ringR));
      ring *= smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
      return impact + ring * 0.6;
    }
    vec3 puddleRipple(vec2 pm, float t, float rain) {
      vec2 r = vec2(sin(pm.x * 3.1 + t * 2.0), cos(pm.y * 2.7 - t * 1.7)) * 0.5;
      r += vec2(cos(pm.y * 5.3 - t * 2.4), sin(pm.x * 4.6 + t * 3.1)) * 0.28;
      float crest = 0.0;
      if (rain > 0.02) {
        vec2 rp = pm * 1.7; float e = 0.18;
        float n0 = deckRainField(rp, t);
        vec2 grad = vec2(deckRainField(rp + vec2(e, 0.0), t) - n0,
                         deckRainField(rp + vec2(0.0, e), t) - n0) / e;
        r += grad * 0.55 * rain;
        crest = clamp(n0 * 0.8, 0.0, 1.0) * rain;
      }
      return vec3(r, crest);
    }
    vec3 wetSkyColor(vec3 dir) {
      float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
      float day = clamp(wetSunDir.y * 3.0 + 0.15, 0.0, 1.0);
      vec3 zenith  = mix(vec3(0.02, 0.03, 0.06), vec3(0.20, 0.40, 0.72), day);
      vec3 horizon = mix(vec3(0.04, 0.05, 0.08), vec3(0.62, 0.70, 0.82), day);
      vec3 sky = mix(horizon, zenith, up);
      float sun = pow(max(dot(dir, wetSunDir), 0.0), 200.0);
      sky += vec3(1.0, 0.9, 0.7) * sun * day * 2.0;
      return sky;
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
    fn deckRainField(p : vec2f, t : f32) -> f32 {
      let cell = floor(p); let f = fract(p);
      let h1 = wetHash21(cell); let h2 = wetHash21(cell + 5.7);
      let h3 = wetHash21(cell + 11.3); let h4 = wetHash21(cell + 19.1);
      let center = vec2f(0.2 + h1 * 0.6, 0.2 + h2 * 0.6);
      let rate = mix(1.0, 3.2, h3);
      let life = fract(t * rate + h1 * 7.0);
      let r = length(f - center);
      let sz = mix(0.16, 0.42, h4);
      let impact = (1.0 - smoothstep(0.0, sz * 0.55, r)) * (1.0 - smoothstep(0.0, 0.22, life));
      let ringR = life * sz * 1.6;
      var ring = 1.0 - smoothstep(0.0, sz * 0.34, abs(r - ringR));
      ring = ring * smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.5, 1.0, life));
      return impact + ring * 0.6;
    }
    fn puddleRipple(pm : vec2f, t : f32, rain : f32) -> vec3f {
      var r = vec2f(sin(pm.x * 3.1 + t * 2.0), cos(pm.y * 2.7 - t * 1.7)) * 0.5;
      r = r + vec2f(cos(pm.y * 5.3 - t * 2.4), sin(pm.x * 4.6 + t * 3.1)) * 0.28;
      var crest = 0.0;
      if (rain > 0.02) {
        let rp = pm * 1.7; let e = 0.18;
        let n0 = deckRainField(rp, t);
        let grad = vec2f(deckRainField(rp + vec2f(e, 0.0), t) - n0,
                         deckRainField(rp + vec2f(0.0, e), t) - n0) / e;
        r = r + grad * 0.55 * rain;
        crest = clamp(n0 * 0.8, 0.0, 1.0) * rain;
      }
      return vec3f(r, crest);
    }
    fn wetSkyColor(dir : vec3f) -> vec3f {
      let up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
      let day = clamp(uniforms.wetSunDir.y * 3.0 + 0.15, 0.0, 1.0);
      let zenith  = mix(vec3f(0.02, 0.03, 0.06), vec3f(0.20, 0.40, 0.72), day);
      let horizon = mix(vec3f(0.04, 0.05, 0.08), vec3f(0.62, 0.70, 0.82), day);
      var sky = mix(horizon, zenith, up);
      let sun = pow(max(dot(dir, uniforms.wetSunDir), 0.0), 200.0);
      sky = sky + vec3f(1.0, 0.9, 0.7) * sun * day * 2.0;
      return sky;
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
      // ── Standing water as an actual surface: raindrop ripples ripple the puddle normal, an analytic
      //    sky reflection comes in by water's real Fresnel (weak looking down, mirror toward grazing),
      //    and rain-ring crests catch the light. Gated to the deeper puddles only. ──
      float wDeep = smoothstep(0.2, 0.7, wPuddle);
      if (wDeep > 0.001) {
        vec3 wRip = puddleRipple(vPositionW.xz, wetTime, wetRain);
        vec3 wN2 = normalize(normalize(normalW) + vec3(wRip.x, 0.0, wRip.y) * 0.1);
        vec3 wVv = normalize(viewDirectionW);
        vec3 wRefDir = reflect(-wVv, wN2);
        vec3 wSky = wetSkyColor(wRefDir);
        float wCosNV = clamp(dot(wN2, wVv), 0.0, 1.0);
        float wFres = 0.03 + 0.97 * pow(1.0 - wCosNV, 5.0);
        vec3 wWater = mix(finalColor.rgb, wSky, clamp(wFres * 1.7, 0.0, 0.9));
        finalColor.rgb = mix(finalColor.rgb, wWater, wDeep);
        finalColor.rgb += vec3(wRip.z * wDeep * 0.5);
      }
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
      // ── Standing water as an actual surface: raindrop ripples ripple the puddle normal, an analytic
      //    sky reflection comes in by water's real Fresnel (weak looking down, mirror toward grazing),
      //    and rain-ring crests catch the light. Gated to the deeper puddles only. ──
      let wDeep = smoothstep(0.2, 0.7, wPuddle);
      if (wDeep > 0.001) {
        let wRip = puddleRipple(fragmentInputs.vPositionW.xz, uniforms.wetTime, uniforms.wetRain);
        let wN2 = normalize(normalize(normalW) + vec3f(wRip.x, 0.0, wRip.y) * 0.1);
        let wVv = normalize(viewDirectionW);
        let wRefDir = reflect(-wVv, wN2);
        let wSky = wetSkyColor(wRefDir);
        let wCosNV = clamp(dot(wN2, wVv), 0.0, 1.0);
        let wFres = 0.03 + 0.97 * pow(1.0 - wCosNV, 5.0);
        let wWater = mix(finalColor.rgb, wSky, clamp(wFres * 1.7, 0.0, 0.9));
        finalColor = vec4f(mix(finalColor.rgb, wWater, wDeep), finalColor.a);
        finalColor = vec4f(finalColor.rgb + vec3f(wRip.z * wDeep * 0.5), finalColor.a);
      }
    }
  `;
}
