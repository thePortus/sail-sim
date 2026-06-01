/**
 * VolumetricCloudsPlugin — ray-marching post-process cloud rendering.
 *
 * Ported from Babylon.js playground #MAONNT#13, which adapts Shadertoy 4dSBDt.
 * Two passes:
 *   1. volumetricClouds     — ray-marches a cloud slab (Beer-Lambert + HG scatter)
 *   2. volumetricCloudsDenoise — 3×3 bilateral filter to suppress jitter noise
 *
 * The Shadertoy Grey Noise 3D bin is repacked into a 2D atlas texture so we
 * avoid sampler3D entirely (which causes WebGPU bind-group mismatches and
 * WebGL ES precision issues).  The shader does trilinear Z interpolation
 * between atlas slices manually.
 *
 * All custom GLSL helper functions are prefixed "vc_" to avoid colliding with
 * Babylon.js's own shader preamble (which defines remap, saturate, etc.).
 */

import {
  Scene, Camera, PostProcess, Effect, Texture, RawTexture,
  Vector2, Vector3, Matrix, Constants,
} from '@babylonjs/core';
import { ShaderStore } from '@babylonjs/core/Engines/shaderStore';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import { DepthRenderer } from '@babylonjs/core/Rendering/depthRenderer';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';

// ─────────────────────────────────────────────────────────────────────────────
// Atlas constants (match what parse3DNoise() produces for the 32×32×32 bin)
// ─────────────────────────────────────────────────────────────────────────────
// 32 slices packed 8×4 → atlas = 256×128 px
const ATLAS_COLS = 8;
const ATLAS_ROWS = 4;     // ceil(32 / 8)

// ─────────────────────────────────────────────────────────────────────────────
// Fragment shaders — GLSL ES compatible with WebGL2 and Babylon's WGSL transpiler
// ─────────────────────────────────────────────────────────────────────────────

const CLOUD_FRAG = `
// Precision is provided by Babylon.js's engine preamble — do NOT redeclare it
// here, as that would break the WebGPU GLSL→SPIR-V preprocessor's ability to
// inject layout(location = N) onto the vUV varying.

varying vec2 vUV;

// Babylon provides the upstream scene colour.
uniform sampler2D textureSampler;

// 2-D atlas packing the 3-D noise (8 cols × 4 rows of NOISE_DIM×NOISE_DIM slices).
uniform sampler2D noiseSampler;
// 2-D cloud coverage / weather map.
uniform sampler2D weatherSampler;

// Linear depth map from Babylon's DepthRenderer (same camera).
// Stores (eyeZ - nearZ) / (farZ - nearZ) in the R channel.
uniform sampler2D depthSampler;

// Camera.
uniform mat4  invViewProjection;
uniform vec3  cameraPosition;
uniform vec3  cameraForward;

// Lighting.
uniform vec3 sunDirection;   // unit vec toward sun
uniform vec3 sunColor;
uniform vec3 skyColor;
uniform vec3 groundColor;    // upward bounce light (ocean/terrain tint) onto cloud bases

// Cloud slab.
uniform float cloudBase;
uniform float cloudTop;
uniform float cloudCoverage;
uniform float cloudDensity;
uniform float absorptionCoeff;
uniform float cloudType;   // 0 = flat stratus, ~0.4 = fair-weather cumulus, 1 = towering cumulonimbus

// Wind / time.
uniform float time;
uniform vec2  windDir;
uniform float windSpeed;

// Clip planes.
uniform float nearZ;
uniform float farZ;

// Quality.
uniform int marchSteps;
uniform int lightSteps;

// Atlas layout (set from TypeScript so we handle any bin dimensions).
uniform float noiseSliceDim;  // texels per slice edge (e.g. 32)
uniform float noiseDepth;     // total number of Z slices (e.g. 32)
uniform float atlasW;         // atlas width  in texels
uniform float atlasH;         // atlas height in texels
uniform float atlasCols;      // slices per atlas row

#define PI 3.14159265

// ── Prefixed helpers (avoids collision with Babylon.js preamble) ─────────────

float vc_sat(float x) { return clamp(x, 0.0, 1.0); }

float vc_remap(float v, float lo, float hi) {
    return vc_sat((v - lo) / max(hi - lo, 1e-5));
}

float vc_hgPhase(float cosA, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(0.0, 1.0 + g2 - 2.0 * g * cosA), 1.5));
}

// Parametric distance to horizontal plane y = planeY along ray (ro, rd).
float vc_slabT(vec3 ro, vec3 rd, float planeY) {
    if (abs(rd.y) < 1e-6) return 1e9;
    return (planeY - ro.y) / rd.y;
}

// ── 3-D noise via 2-D atlas ──────────────────────────────────────────────────
//
// uvw should be in [0,1]³; coordinates tile via fract().
// Trilinear Z: two neighbouring slices bilinearly sampled, then mix()ed.
float vc_noise3D(vec3 uvw) {
    uvw = fract(uvw);

    float z  = uvw.z * noiseDepth;
    float z0 = floor(z);
    float zf = z - z0;
    float z1 = mod(z0 + 1.0, noiseDepth);

    // XY within the slice — clamp half-texel inward to avoid atlas bleed.
    // ('half' is a reserved GLSL keyword — use 'halfTexel' instead)
    float halfTexel = 0.5 / noiseSliceDim;
    vec2  xy        = clamp(uvw.xy, halfTexel, 1.0 - halfTexel) * noiseSliceDim;

    vec2 atlasSize = vec2(atlasW, atlasH);

    // Slice 0
    float col0 = mod(z0, atlasCols);
    float row0 = floor(z0 / atlasCols);
    vec2 uv0 = (vec2(col0, row0) * noiseSliceDim + xy) / atlasSize;

    // Slice 1 (trilinear Z)
    float col1 = mod(z1, atlasCols);
    float row1 = floor(z1 / atlasCols);
    vec2 uv1 = (vec2(col1, row1) * noiseSliceDim + xy) / atlasSize;

    float s0 = texture2D(noiseSampler, uv0).r;
    float s1 = texture2D(noiseSampler, uv1).r;
    return mix(s0, s1, zf);
}

// ── Cloud density ─────────────────────────────────────────────────────────────

float vc_heightFrac(float y) { return vc_remap(y, cloudBase, cloudTop); }

// Height gradient — its shape is driven by cloudType so one field renders different
// cloud forms: stratus stays a low flat sheet, cumulus builds to mid-height with a
// rounded top, cumulonimbus towers to the top of the slab. The cloud TOP rises and the
// base softens with type. (type≈0.36 reproduces the previous fixed gradient.)
float vc_heightGrad(float h) {
    float topEnd = mix(0.42, 1.0,  cloudType);   // how high the cloud builds
    float baseW  = mix(0.04, 0.12, cloudType);   // base softness (taller types fade in slower)
    return vc_sat(vc_remap(h, 0.0, baseW)                       // rise off the base
                * (1.0 - vc_remap(h, topEnd * 0.5, topEnd)));   // round off below the top
}

float vc_getDensity(vec3 p, float lod) {
    float h = vc_heightFrac(p.y);
    if (h < 0.0 || h > 1.0) return 0.0;

    float hg = vc_heightGrad(h);
    if (hg < 0.001) return 0.0;

    // Wind advection offset.
    float wt = time * windSpeed * 0.08;
    vec2  wd = windDir * wt;

    // 2-D weather map drives spatial coverage.
    vec2  wuv = p.xz * 0.000012 + wd * 0.00002;
    float wc  = texture2D(weatherSampler, wuv).r;
    float cov = vc_sat(cloudCoverage + wc - 0.5);
    if (cov < 0.01) return 0.0;

    // Low-frequency base shape.
    vec3 np   = p * 0.000075 + vec3(wd.x, 0.0, wd.y) * 0.00004;
    // lod is used to scale the noise coordinates for a coarser sample.
    float ns  = vc_noise3D(np * (1.0 + lod * 0.5));
    float shp = vc_remap(ns, 1.0 - cov, 1.0) * hg;
    if (shp < 0.001) return 0.0;

    // High-frequency detail erosion (skipped at high LOD).
    if (lod < 1.5) {
        vec3  dp  = p * 0.00038 + vec3(wd.x, 0.0, wd.y) * 0.00012;
        float det = vc_noise3D(dp * 3.0);
        float ero = mix(det, 1.0 - det, vc_sat(h * 8.0));
        // Erode more for puffy/storm types (broken cauliflower edges), less for stratus
        // (smoother continuous sheet).
        shp = vc_remap(shp, ero * mix(0.10, 0.32, cloudType), 1.0);
    }

    return vc_sat(shp) * cloudDensity;
}

// ── Light march (cone from sample toward sun) ─────────────────────────────────

float vc_lightMarch(vec3 p) {
    float slabH = cloudTop - cloudBase;
    float step  = slabH / float(lightSteps);
    float acc   = 0.0;

    for (int i = 0; i < lightSteps; i++) {
        p   += sunDirection * step;
        acc += vc_getDensity(p, 2.0) * step;
    }

    float beer   = exp(-acc * absorptionCoeff);
    float powder = 1.0 - exp(-acc * absorptionCoeff * 2.0);
    return beer * mix(1.0, powder * 2.0, 0.25);
}

// ── Main ─────────────────────────────────────────────────────────────────────

void main(void) {
    vec4 scene = texture2D(textureSampler, vUV);

    // Reconstruct world-space ray direction from NDC.
    // Using far-plane point + cameraPosition avoids depending on the near-plane
    // Z convention (which differs between WebGL and WebGPU in clip space).
    vec2 ndc = vUV * 2.0 - 1.0;
    vec4 wF  = invViewProjection * vec4(ndc, 1.0, 1.0);  wF /= wF.w;
    vec3 rd  = normalize(wF.xyz - cameraPosition);

    // Find ray / cloud-slab intersections.
    float camY = cameraPosition.y;
    float t0   = vc_slabT(cameraPosition, rd, cloudBase);
    float t1   = vc_slabT(cameraPosition, rd, cloudTop);

    float tNear, tFar;
    if (camY < cloudBase) {
        tNear = t0; tFar = t1;
    } else if (camY < cloudTop) {
        tNear = 0.01;
        tFar  = rd.y > 0.0 ? t1 : t0;
    } else {
        tNear = t1; tFar = t0;
    }

    if (tNear < 0.0 || tNear >= tFar) {
        gl_FragColor = scene;
        return;
    }
    tNear = max(tNear, 0.01);
    tFar  = min(tFar, farZ);

    // Depth occlusion: if opaque geometry sits in front of the cloud slab,
    // skip or clamp the march so clouds don't overdraw it.
    // With nearZ=0.5, farZ=120000, the threshold rawDepth > 0.0001 corresponds
    // to ~12.5 m — objects closer than that (including the player ship) would
    // slip below the threshold and have clouds composited over them.
    // Using 1e-7 safely catches any geometry at camera.minZ or beyond while
    // excluding sky pixels which are cleared to exactly 0.
    float rawDepth = texture2D(depthSampler, vUV).r;
    if (rawDepth > 1e-7) {
        // Reconstruct view-space Z, then convert to ray-t via projection onto rd.
        float geoEyeZ = rawDepth * (farZ - nearZ) + nearZ;
        float geoT    = geoEyeZ / max(dot(rd, cameraForward), 0.001);
        if (geoT <= tNear) {
            gl_FragColor = scene;
            return;
        }
        tFar = min(tFar, geoT);
    }

    // Ray march.
    float dist = max(tFar - tNear, 0.0);
    float step = dist / float(marchSteps);

    // Time-varying jitter to break up banding.
    float jit = fract(sin(dot(vUV + fract(time * 0.1), vec2(127.1, 311.7))) * 43758.5) * step;

    // Dual-lobe phase: a broad lobe for overall forward scatter + a sharp forward
    // lobe that lights the cloud edge facing the sun — the "silver lining".
    float cosA    = dot(rd, sunDirection);
    float phaseBroad = mix(vc_hgPhase(cosA, 0.6), vc_hgPhase(cosA, -0.3), 0.3);
    float phaseFwd   = vc_hgPhase(cosA, 0.92);   // tight forward spike
    float phaseV     = phaseBroad + phaseFwd * 1.6;

    float transmit = 1.0;
    vec3  scatter  = vec3(0.0);
    float t        = tNear + jit;

    // Adaptive empty-space skipping: most rays cross mostly-empty sky. Advance with a
    // big step while the (cheap) density probe reads empty; on the first hit, step back
    // once and switch to fine steps for accurate cloud sampling. This reaches tFar in far
    // fewer iterations over clear sky — a real speedup with no quality change inside cloud.
    float bigStep = step * 3.0;
    bool  fine    = false;   // false = coarse skipping, true = inside/near cloud

    for (int i = 0; i < marchSteps; i++) {
        if (t >= tFar || transmit < 0.02) break;

        vec3  p   = cameraPosition + rd * t;
        float rho = vc_getDensity(p, 0.0);

        if (!fine) {
            if (rho > 0.001) { t -= bigStep; fine = true; continue; }  // back up, refine
            t += bigStep;
            continue;
        }

        if (rho > 0.001) {
            float lt  = vc_lightMarch(p);
            float hf  = vc_heightFrac(p.y);
            // Sky irradiance: strong at cloud top (open sky above), moderate at
            // base (shadowed by the cloud mass itself). Primary daytime whitening.
            float amb = 0.25 + 0.45 * hf;
            // Multi-scatter approximation: thin/edge regions (high light transmit)
            // glow with extra forward-scattered sun — boosts the silver lining and
            // keeps deep cloud cores from going flat-black.
            float ms  = (0.35 + 0.65 * lt);
            // Ground/ocean bounce: faint upward light tints the shadowed cloud bases.
            vec3  bounce = groundColor * (1.0 - hf) * 0.5;
            vec3  lum = sunColor * lt * phaseV * ms
                      + skyColor * amb
                      + bounce;

            // Energy-conserving integration.
            float sT   = exp(-rho * absorptionCoeff * step);
            float inte = (1.0 - sT) / max(rho * absorptionCoeff, 1e-5);
            scatter   += transmit * lum * rho * absorptionCoeff * inte;
            transmit  *= sT;
        }

        t += step;
    }

    gl_FragColor = vec4(scene.rgb * transmit + scatter, scene.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

const DENOISE_FRAG = `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 screenSize;

float vc_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main(void) {
    vec2  px     = 1.0 / screenSize;
    vec4  center = texture2D(textureSampler, vUV);
    float cl     = vc_luma(center.rgb);

    vec3  sum = vec3(0.0);
    float wt  = 0.0;

    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            vec2  uv = vUV + vec2(float(x), float(y)) * px;
            vec4  s  = texture2D(textureSampler, uv);
            float w  = exp(-abs(vc_luma(s.rgb) - cl) * 12.0);
            sum += s.rgb * w;
            wt  += w;
        }
    }

    gl_FragColor = vec4(sum / wt, center.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// WGSL shaders — WebGPU path (registered in ShaderStore.ShadersStoreWGSL)
//
// Follows Babylon.js WGSL PostProcess conventions:
//   • varying vUV: vec2f;            — screen UV (declared explicitly)
//   • var <name>Sampler: sampler;    — sampler object (before texture)
//   • var <name>: texture_2d<f32>;   — texture object
//   • uniform <field>: <type>;       — accessed as uniforms.<field>
//   • textureSampleLevel inside loops (non-uniform control flow)
//   • return fragmentOutputs;        — explicit return on early exit
// ─────────────────────────────────────────────────────────────────────────────

const CLOUD_WGSL = `
varying vUV: vec2f;

var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var noiseSamplerSampler: sampler;
var noiseSampler: texture_2d<f32>;
var weatherSamplerSampler: sampler;
var weatherSampler: texture_2d<f32>;

// Linear depth map from Babylon's DepthRenderer.
// Stores (eyeZ - nearZ) / (farZ - nearZ) in the R channel.
var depthSamplerSampler: sampler;
var depthSampler: texture_2d<f32>;

uniform invViewProjection: mat4x4f;
uniform cameraPosition: vec3f;
uniform cameraForward: vec3f;
uniform sunDirection: vec3f;
uniform sunColor: vec3f;
uniform skyColor: vec3f;
uniform groundColor: vec3f;   // upward bounce light (ocean/terrain) onto cloud bases
uniform cloudBase: f32;
uniform cloudTop: f32;
uniform cloudCoverage: f32;
uniform cloudDensity: f32;
uniform absorptionCoeff: f32;
uniform cloudType: f32;   // 0 = flat stratus, ~0.4 = fair-weather cumulus, 1 = towering cumulonimbus
uniform time: f32;
uniform windDir: vec2f;
uniform windSpeed: f32;
uniform nearZ: f32;
uniform farZ: f32;
uniform marchSteps: i32;
uniform lightSteps: i32;
uniform noiseSliceDim: f32;
uniform noiseDepth: f32;
uniform atlasW: f32;
uniform atlasH: f32;
uniform atlasCols: f32;

const PI: f32 = 3.14159265;

fn vc_fmod(a: f32, b: f32) -> f32 { return a - floor(a / b) * b; }
fn vc_sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn vc_remap(v: f32, lo: f32, hi: f32) -> f32 {
    return vc_sat((v - lo) / max(hi - lo, 1e-5));
}

fn vc_hgPhase(cosA: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(0.0, 1.0 + g2 - 2.0 * g * cosA), 1.5));
}

fn vc_slabT(ro: vec3f, rd: vec3f, planeY: f32) -> f32 {
    if (abs(rd.y) < 1e-6) { return 1e9; }
    return (planeY - ro.y) / rd.y;
}

fn vc_noise3D(uvw_in: vec3f) -> f32 {
    let uvw = fract(uvw_in);
    let z   = uvw.z * uniforms.noiseDepth;
    let z0  = floor(z);
    let zf  = z - z0;
    let z1  = vc_fmod(z0 + 1.0, uniforms.noiseDepth);

    let halfTexel = 0.5 / uniforms.noiseSliceDim;
    let xy        = clamp(uvw.xy, vec2f(halfTexel), vec2f(1.0 - halfTexel))
                    * uniforms.noiseSliceDim;
    let atlasSize = vec2f(uniforms.atlasW, uniforms.atlasH);

    let col0 = vc_fmod(z0, uniforms.atlasCols);
    let row0 = floor(z0 / uniforms.atlasCols);
    let uv0  = (vec2f(col0, row0) * uniforms.noiseSliceDim + xy) / atlasSize;

    let col1 = vc_fmod(z1, uniforms.atlasCols);
    let row1 = floor(z1 / uniforms.atlasCols);
    let uv1  = (vec2f(col1, row1) * uniforms.noiseSliceDim + xy) / atlasSize;

    let s0 = textureSampleLevel(noiseSampler, noiseSamplerSampler, uv0, 0.0).r;
    let s1 = textureSampleLevel(noiseSampler, noiseSamplerSampler, uv1, 0.0).r;
    return mix(s0, s1, zf);
}

fn vc_heightFrac(y: f32) -> f32 {
    return vc_remap(y, uniforms.cloudBase, uniforms.cloudTop);
}

fn vc_heightGrad(h: f32) -> f32 {
    // Shape driven by cloudType: stratus flat & low, cumulus mid w/ rounded top,
    // cumulonimbus towers to the slab top. (type≈0.36 ≈ the previous fixed gradient.)
    let topEnd = mix(0.42, 1.0,  uniforms.cloudType);
    let baseW  = mix(0.04, 0.12, uniforms.cloudType);
    return vc_sat(vc_remap(h, 0.0, baseW) * (1.0 - vc_remap(h, topEnd * 0.5, topEnd)));
}

fn vc_getDensity(p: vec3f, lod: f32) -> f32 {
    let h = vc_heightFrac(p.y);
    if (h < 0.0 || h > 1.0) { return 0.0; }

    let hg = vc_heightGrad(h);
    if (hg < 0.001) { return 0.0; }

    let wt = uniforms.time * uniforms.windSpeed * 0.08;
    let wd = uniforms.windDir * wt;

    let wuv = p.xz * 0.000012 + wd * 0.00002;
    let wc  = textureSampleLevel(weatherSampler, weatherSamplerSampler, wuv, 0.0).r;
    let cov = vc_sat(uniforms.cloudCoverage + wc - 0.5);
    if (cov < 0.01) { return 0.0; }

    let np  = p * 0.000075 + vec3f(wd.x, 0.0, wd.y) * 0.00004;
    let ns  = vc_noise3D(np * (1.0 + lod * 0.5));
    var shp = vc_remap(ns, 1.0 - cov, 1.0) * hg;
    if (shp < 0.001) { return 0.0; }

    if (lod < 1.5) {
        let dp  = p * 0.00038 + vec3f(wd.x, 0.0, wd.y) * 0.00012;
        let det = vc_noise3D(dp * 3.0);
        let ero = mix(det, 1.0 - det, vc_sat(h * 8.0));
        // More erosion for puffy/storm types, less for stratus (smoother sheet).
        shp = vc_remap(shp, ero * mix(0.10, 0.32, uniforms.cloudType), 1.0);
    }

    return vc_sat(shp) * uniforms.cloudDensity;
}

fn vc_lightMarch(p_in: vec3f) -> f32 {
    let slabH     = uniforms.cloudTop - uniforms.cloudBase;
    let step_size = slabH / f32(uniforms.lightSteps);
    var acc: f32  = 0.0;
    var p = p_in;

    for (var i: i32 = 0; i < uniforms.lightSteps; i++) {
        p   += uniforms.sunDirection * step_size;
        acc += vc_getDensity(p, 2.0) * step_size;
    }

    let beer   = exp(-acc * uniforms.absorptionCoeff);
    let powder = 1.0 - exp(-acc * uniforms.absorptionCoeff * 2.0);
    return beer * mix(1.0, powder * 2.0, 0.25);
}

@fragment
fn main(input: FragmentInputs)->FragmentOutputs {
    let scene_color = textureSample(textureSampler, textureSamplerSampler, input.vUV);

    // Reconstruct world-space ray from far-plane NDC (avoids near-plane Z
    // convention differences between WebGL [-1,1] and WebGPU [0,1]).
    let ndc = input.vUV * 2.0 - vec2f(1.0);
    var wF  = uniforms.invViewProjection * vec4f(ndc, 1.0, 1.0);
    wF     /= wF.w;
    let rd  = normalize(wF.xyz - uniforms.cameraPosition);

    let camY = uniforms.cameraPosition.y;
    let t0   = vc_slabT(uniforms.cameraPosition, rd, uniforms.cloudBase);
    let t1   = vc_slabT(uniforms.cameraPosition, rd, uniforms.cloudTop);

    var tNear: f32;
    var tFar:  f32;
    if (camY < uniforms.cloudBase) {
        tNear = t0; tFar = t1;
    } else if (camY < uniforms.cloudTop) {
        tNear = 0.01;
        tFar  = select(t0, t1, rd.y > 0.0);
    } else {
        tNear = t1; tFar = t0;
    }

    if (tNear < 0.0 || tNear >= tFar) {
        fragmentOutputs.color = scene_color;
        return fragmentOutputs;
    }
    tNear = max(tNear, 0.01);
    tFar  = min(tFar, uniforms.farZ);

    // Depth occlusion: if opaque geometry sits in front of the cloud slab,
    // skip or clamp the march so clouds don't overdraw it.
    // Threshold 1e-7 catches geometry at camera.minZ while excluding sky
    // pixels (cleared to exactly 0) — see GLSL path comment for full reasoning.
    let rawDepth = textureSampleLevel(depthSampler, depthSamplerSampler, input.vUV, 0.0).r;
    if (rawDepth > 1e-7) {
        let geoEyeZ = rawDepth * (uniforms.farZ - uniforms.nearZ) + uniforms.nearZ;
        let geoT    = geoEyeZ / max(dot(rd, uniforms.cameraForward), 0.001);
        if (geoT <= tNear) {
            fragmentOutputs.color = scene_color;
            return fragmentOutputs;
        }
        tFar = min(tFar, geoT);
    }

    let dist      = max(tFar - tNear, 0.0);
    let step_size = dist / f32(uniforms.marchSteps);

    // Time-varying jitter to break up ray-march banding.
    let jit_uv = input.vUV + fract(uniforms.time * 0.1);
    let jit    = fract(sin(dot(jit_uv, vec2f(127.1, 311.7))) * 43758.5) * step_size;

    // Dual-lobe phase: broad forward scatter + a tight forward spike (silver lining).
    let cosA       = dot(rd, uniforms.sunDirection);
    let phaseBroad = mix(vc_hgPhase(cosA, 0.6), vc_hgPhase(cosA, -0.3), 0.3);
    let phaseFwd   = vc_hgPhase(cosA, 0.92);
    let phaseV     = phaseBroad + phaseFwd * 1.6;

    var transmit: f32  = 1.0;
    var scatter:  vec3f = vec3f(0.0);
    var t: f32 = tNear + jit;

    // Adaptive empty-space skipping (see GLSL note): coarse strides over clear sky,
    // back up one stride + fine-march on the first density hit. No quality change inside.
    let bigStep = step_size * 3.0;
    var fine = false;

    for (var i: i32 = 0; i < uniforms.marchSteps; i++) {
        if (t >= tFar || transmit < 0.02) { break; }

        let p   = uniforms.cameraPosition + rd * t;
        let rho = vc_getDensity(p, 0.0);

        if (!fine) {
            if (rho > 0.001) { t -= bigStep; fine = true; continue; }
            t += bigStep;
            continue;
        }

        if (rho > 0.001) {
            let lt  = vc_lightMarch(p);
            let hf  = vc_heightFrac(p.y);
            // Sky irradiance: strong at cloud top, moderate at base. Primary whitening.
            let amb = 0.25 + 0.45 * hf;
            // Multi-scatter approx: thin/edge regions glow with extra forward sun.
            let ms  = (0.35 + 0.65 * lt);
            // Ground/ocean bounce: faint upward light tints shadowed cloud bases.
            let bounce = uniforms.groundColor * (1.0 - hf) * 0.5;
            let lum = uniforms.sunColor * lt * phaseV * ms
                    + uniforms.skyColor * amb
                    + bounce;

            let sT   = exp(-rho * uniforms.absorptionCoeff * step_size);
            let inte = (1.0 - sT) / max(rho * uniforms.absorptionCoeff, 1e-5);
            scatter  += transmit * lum * rho * uniforms.absorptionCoeff * inte;
            transmit *= sT;
        }

        t += step_size;
    }

    fragmentOutputs.color = vec4f(scene_color.rgb * transmit + scatter, scene_color.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

const DENOISE_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform screenSize: vec2f;

fn vc_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

@fragment
fn main(input: FragmentInputs)->FragmentOutputs {
    let px     = 1.0 / uniforms.screenSize;
    let center = textureSample(textureSampler, textureSamplerSampler, input.vUV);
    let cl     = vc_luma(center.rgb);

    var sum: vec3f = vec3f(0.0);
    var wt:  f32   = 0.0;

    for (var x: i32 = -1; x <= 1; x++) {
        for (var y: i32 = -1; y <= 1; y++) {
            let uv = input.vUV + vec2f(f32(x), f32(y)) * px;
            let s  = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0);
            let w  = exp(-abs(vc_luma(s.rgb) - cl) * 12.0);
            sum   += s.rgb * w;
            wt    += w;
        }
    }

    fragmentOutputs.color = vec4f(sum / wt, center.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Plugin options
// ─────────────────────────────────────────────────────────────────────────────

export interface VolumetricCloudsOptions {
  cloudBaseHeight?:  number;
  cloudThickness?:   number;
  cloudCoverage?:    number;
  cloudDensity?:     number;
  absorptionCoeff?:  number;
  cloudType?:        number;
  marchSteps?:       number;
  lightSteps?:       number;
  renderScale?:      number;
  windDirection?:    Vector3;
  windSpeed?:        number;
  weatherTextureUrl?: string;
  volumeNoiseUrl?:   string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin class
// ─────────────────────────────────────────────────────────────────────────────

export class VolumetricCloudsPlugin {

  // ── Public parameters (update freely between frames) ──────────────────────
  cloudBaseHeight: number;
  cloudThickness:  number;
  cloudCoverage:   number;
  cloudDensity:    number;
  absorptionCoeff: number;
  cloudType:       number;   // 0 stratus → ~0.4 cumulus → 1 cumulonimbus
  marchSteps:      number;
  lightSteps:      number;
  windDirection:   Vector3;
  windSpeed:       number;

  // ── Private state ─────────────────────────────────────────────────────────
  private readonly scene:     Scene;
  private readonly camera:    Camera;
  private readonly getSunDir: () => Vector3;

  private cloudPass:   PostProcess | null = null;
  private denoisePass: PostProcess | null = null;
  private weatherTex:  Texture    | null = null;
  private noiseTex:    RawTexture | null = null;

  // 1×1 placeholder textures used until async loads complete.
  // WebGPU requires every declared binding to be present on the first frame;
  // WebGL silently ignores missing textures (black), but we set these for both.
  private noisePlaceholder:   RawTexture | null = null;
  private weatherPlaceholder: RawTexture | null = null;
  private depthPlaceholder:   RawTexture | null = null;

  // Babylon.js DepthRenderer: stores linear (eye-Z) depth for the scene camera.
  private depthRenderer: DepthRenderer | null = null;

  // Atlas metadata (populated when binary is parsed).
  private atlasW    = 256;
  private atlasH    = 128;
  private noiseDim  = 32;   // texels per slice edge
  private noiseDepth = 32;  // number of Z slices

  private elapsedSecs = 0;
  private _enabled    = true;

  constructor(
    scene: Scene,
    camera: Camera,
    /** Callback returning the current unit vector pointing toward the sun. */
    getSunDirection: () => Vector3,
    options: VolumetricCloudsOptions = {},
  ) {
    this.scene     = scene;
    this.camera    = camera;
    this.getSunDir = getSunDirection;

    this.cloudBaseHeight = options.cloudBaseHeight ?? 900;
    this.cloudThickness  = options.cloudThickness  ?? 600;
    this.cloudCoverage   = options.cloudCoverage   ?? 0.50;
    this.cloudType       = options.cloudType       ?? 0.40;   // ≈ the previous fixed look
    this.cloudDensity    = options.cloudDensity    ?? 0.40;
    this.absorptionCoeff = options.absorptionCoeff ?? 0.004;
    this.marchSteps      = options.marchSteps      ?? 48;
    this.lightSteps      = options.lightSteps      ?? 6;
    this.windDirection   = options.windDirection   ?? new Vector3(1, 0, 0.2);
    this.windSpeed       = options.windSpeed       ?? 8;

    const isWebGPU = scene.getEngine().isWebGPU;
    this.buildPlaceholders();
    // storeNonLinearDepth = false → stores linear metric (eyeZ - nearZ) / (farZ - nearZ).
    this.depthRenderer = scene.enableDepthRenderer(camera, false);
    this.registerShaders(isWebGPU);
    this.buildPostProcesses(options.renderScale ?? 0.82, isWebGPU);
    this.loadTextures(
      options.weatherTextureUrl ?? 'https://celeste-twinkle.github.io/Babylon-App-Show/clouds/pebbles.png',
      options.volumeNoiseUrl    ?? 'https://celeste-twinkle.github.io/Babylon-App-Show/clouds/greyNoise3D.bin',
    );
  }

  // ── Shader registration ───────────────────────────────────────────────────

  /**
   * Creates 1×1 placeholder textures that satisfy WebGPU bind-group requirements
   * on the first frame, before the async noise/weather fetches complete.
   */
  private buildPlaceholders(): void {
    // Mid-grey noise: gives neutral density until the real atlas loads.
    const grey1 = new Uint8Array([128]);
    this.noisePlaceholder = new RawTexture(
      grey1, 1, 1, Constants.TEXTUREFORMAT_R,
      this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );

    // Weather: uniform half-coverage so we see clouds right away.
    const grey4 = new Uint8Array([128, 128, 128, 255]);
    this.weatherPlaceholder = new RawTexture(
      grey4, 1, 1, Constants.TEXTUREFORMAT_RGBA,
      this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );

    // Depth: value 0 = "no geometry" so no occlusion fires on the first frame.
    const depthZero = new Uint8Array([0]);
    this.depthPlaceholder = new RawTexture(
      depthZero, 1, 1, Constants.TEXTUREFORMAT_R,
      this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
  }

  /**
   * Registers shaders in the correct store for the active backend.
   * Keeping GLSL out of Effect.ShadersStore on WebGPU prevents Babylon.js from
   * attempting to compile it via glslang → SPIR-V (which requires explicit
   * layout(location=N) qualifiers that Babylon only injects for built-in shaders).
   */
  private registerShaders(isWebGPU: boolean): void {
    if (!isWebGPU) {
      // GLSL — WebGL path only
      if (!Effect.ShadersStore['volumetricCloudsPixelShader']) {
        Effect.ShadersStore['volumetricCloudsPixelShader'] = CLOUD_FRAG;
      }
      if (!Effect.ShadersStore['volumetricCloudsDenoisePixelShader']) {
        Effect.ShadersStore['volumetricCloudsDenoisePixelShader'] = DENOISE_FRAG;
      }
    } else {
      // WGSL — WebGPU path only
      if (!ShaderStore.ShadersStoreWGSL['volumetricCloudsPixelShader']) {
        ShaderStore.ShadersStoreWGSL['volumetricCloudsPixelShader'] = CLOUD_WGSL;
      }
      if (!ShaderStore.ShadersStoreWGSL['volumetricCloudsDenoisePixelShader']) {
        ShaderStore.ShadersStoreWGSL['volumetricCloudsDenoisePixelShader'] = DENOISE_WGSL;
      }
    }
  }

  // ── Post-process chain ────────────────────────────────────────────────────

  private buildPostProcesses(renderScale: number, isWebGPU: boolean): void {
    const lang = isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;

    // Pass 1 — volumetric ray march.
    this.cloudPass = new PostProcess(
      'volumetricClouds',
      'volumetricClouds',
      /* uniforms */ [
        'invViewProjection', 'cameraPosition', 'cameraForward',
        'sunDirection', 'sunColor', 'skyColor', 'groundColor',
        'cloudBase', 'cloudTop', 'cloudCoverage', 'cloudDensity', 'absorptionCoeff', 'cloudType',
        'time', 'windDir', 'windSpeed',
        'nearZ', 'farZ', 'marchSteps', 'lightSteps',
        'noiseSliceDim', 'noiseDepth', 'atlasW', 'atlasH', 'atlasCols',
      ],
      /* samplers */ ['noiseSampler', 'weatherSampler', 'depthSampler'],
      /* scale    */ renderScale,
      /* camera   */ this.camera,
      /* samplingMode */ undefined,
      /* engine       */ undefined,
      /* reusable     */ undefined,
      /* defines      */ undefined,
      /* textureType  */ undefined,
      /* vertexUrl    */ undefined,
      /* indexParams  */ undefined,
      /* blockCompile */ undefined,
      /* texFormat    */ undefined,
      /* language     */ lang,
    );

    this.cloudPass.onApply = (effect: Effect) => {
      if (this._enabled) this.applyCloudUniforms(effect);
    };

    // Pass 2 — bilateral denoise at full resolution.
    this.denoisePass = new PostProcess(
      'volumetricCloudsDenoise',
      'volumetricCloudsDenoise',
      /* uniforms */ ['screenSize'],
      /* samplers */ [],
      /* scale    */ 1.0,
      /* camera   */ this.camera,
      /* samplingMode */ undefined,
      /* engine       */ undefined,
      /* reusable     */ undefined,
      /* defines      */ undefined,
      /* textureType  */ undefined,
      /* vertexUrl    */ undefined,
      /* indexParams  */ undefined,
      /* blockCompile */ undefined,
      /* texFormat    */ undefined,
      /* language     */ lang,
    );

    this.denoisePass.onApply = (effect: Effect) => {
      if (!this._enabled) return;
      const rect = this.scene.getEngine().getRenderingCanvasClientRect();
      effect.setVector2('screenSize', new Vector2(
        rect?.width  ?? 1920,
        rect?.height ?? 1080,
      ));
    };
  }

  // ── Per-frame uniform upload ──────────────────────────────────────────────

  private applyCloudUniforms(effect: Effect): void {
    const dt = this.scene.getEngine().getDeltaTime() / 1000;
    this.elapsedSecs += dt;

    const sunDir = this.getSunDir();
    const invVP  = Matrix.Invert(this.scene.getTransformMatrix());

    effect.setMatrix('invViewProjection', invVP);
    effect.setVector3('cameraPosition', this.scene.activeCamera!.position);
    // World-space unit vector the camera is looking toward; used to convert
    // linear eye-depth back into a ray-parameter t for occlusion comparison.
    effect.setVector3('cameraForward', this.camera.getDirection(Vector3.Forward()));
    effect.setVector3('sunDirection', sunDir);
    // ── Time-of-day lighting ───────────────────────────────────────────────
    // sunDir.y is sin(elevation): +1 = noon zenith, 0 = horizon, -1 = midnight.
    const el = Math.max(0, sunDir.y);   // 0 at/below horizon, 1 at zenith

    // Direct sun beam — warm, bright during day, near-zero below the horizon.
    // Values intentionally >1 at noon (HDR) so even a partially-shadowed cloud
    // (lt ≈ 0.4–0.6) still contributes perceptible warm colour.
    const sunColor = new Vector3(
      0.08 + 1.7 * el,
      0.08 + 1.6 * el,
      0.10 + 1.2 * el,
    );

    // Sky irradiance — the diffuse light from the whole atmosphere that
    // illuminates cloud tops from above.  This is the primary "whitening" term.
    // We attenuate it when coverage is high so storm clouds look grey/dark:
    //   coverage 0.00–0.45 → full sky irradiance (scattered cumulus → white)
    //   coverage 0.45–1.00 → progressively dimmer (overcast / storm → dark grey)
    const stormDim = Math.max(0.08, 1.0 - Math.max(0, this.cloudCoverage - 0.45) * 1.5);
    const skyColor = new Vector3(
      stormDim * (0.12 + 1.8 * el),
      stormDim * (0.15 + 1.9 * el),
      stormDim * (0.20 + 2.0 * el),
    );

    effect.setVector3('sunColor', sunColor);
    effect.setVector3('skyColor',  skyColor);

    // Ground/ocean bounce — a faint upward light that tints the shadowed cloud bases
    // (sea-blue by day, fading to near-black at night). Subtle, but it stops the
    // undersides reading as flat dead grey.
    const bounceColor = new Vector3(
      stormDim * (0.05 + 0.16 * el),
      stormDim * (0.07 + 0.20 * el),
      stormDim * (0.09 + 0.26 * el),
    );
    effect.setVector3('groundColor', bounceColor);

    effect.setFloat('cloudBase',       this.cloudBaseHeight);
    effect.setFloat('cloudTop',        this.cloudBaseHeight + this.cloudThickness);
    effect.setFloat('cloudCoverage',   this.cloudCoverage);
    effect.setFloat('cloudDensity',    this.cloudDensity);
    effect.setFloat('absorptionCoeff', this.absorptionCoeff);
    effect.setFloat('cloudType',       this.cloudType);

    effect.setFloat('time',      this.elapsedSecs);
    effect.setVector2('windDir', new Vector2(
      this.windDirection.x,
      this.windDirection.z,
    ));
    effect.setFloat('windSpeed', this.windSpeed);

    effect.setFloat('nearZ', this.camera.minZ);
    effect.setFloat('farZ',  this.camera.maxZ);
    effect.setInt('marchSteps', this.marchSteps);
    effect.setInt('lightSteps', this.lightSteps);

    // Atlas layout uniforms — drives vc_noise3D() in the shader.
    effect.setFloat('noiseSliceDim', this.noiseDim);
    effect.setFloat('noiseDepth',    this.noiseDepth);
    effect.setFloat('atlasW',        this.atlasW);
    effect.setFloat('atlasH',        this.atlasH);
    effect.setFloat('atlasCols',     ATLAS_COLS);

    // Always bind a texture — WebGPU requires every declared sampler binding to
    // be present.  Use the placeholder until the async fetch completes.
    effect.setTexture(
      'noiseSampler',
      this.noiseTex?.isReady() ? this.noiseTex : this.noisePlaceholder,
    );
    effect.setTexture(
      'weatherSampler',
      this.weatherTex?.isReady() ? this.weatherTex : this.weatherPlaceholder,
    );

    // Depth map — supplied by Babylon's DepthRenderer each frame.
    // Fall back to the zero-placeholder (= no occlusion) if not yet ready.
    const depthMap = this.depthRenderer?.getDepthMap() ?? null;
    effect.setTexture(
      'depthSampler',
      depthMap?.isReady() ? depthMap : this.depthPlaceholder,
    );
  }

  // ── Texture loading ───────────────────────────────────────────────────────

  private loadTextures(weatherUrl: string, noiseUrl: string): void {
    // 2-D coverage / weather texture.
    this.weatherTex = new Texture(
      weatherUrl, this.scene,
      /*noMipmap=*/false, /*invertY=*/true, Texture.TRILINEAR_SAMPLINGMODE,
    );
    this.weatherTex.wrapU = Texture.WRAP_ADDRESSMODE;
    this.weatherTex.wrapV = Texture.WRAP_ADDRESSMODE;

    // 3-D grey-noise bin → repacked as 2-D atlas.
    fetch(noiseUrl)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        this.noiseTex = this.buildNoiseAtlas(buf);
        console.log(
          `[VolumetricClouds] 3D noise atlas ready (${this.noiseDim}³ → ${this.atlasW}×${this.atlasH})`,
        );
      })
      .catch(err => {
        console.warn('[VolumetricClouds] Could not load 3D noise:', err);
      });
  }

  /**
   * Parses a Shadertoy binary volume file and repacks the voxel data into a
   * 2-D atlas texture so we can sample it without sampler3D.
   *
   * Binary header (20 bytes):
   *   0–3   "BIN\n"
   *   4–7   width    (int32 LE)
   *   8–11  height   (int32 LE)
   *  12–15  depth    (int32 LE)
   *  16–19  channels (int32 LE)   — always 1 for the grey-noise bin
   *  20+    uint8 voxel data (width×height×depth bytes)
   */
  private buildNoiseAtlas(buf: ArrayBuffer): RawTexture {
    const dv = new DataView(buf);
    const w  = dv.getInt32(4,  true);
    const h  = dv.getInt32(8,  true);
    const d  = dv.getInt32(12, true);
    const src = new Uint8Array(buf, 20);

    // Record actual dimensions for the shader uniforms.
    this.noiseDim   = w;   // assume w === h (square slices)
    this.noiseDepth = d;

    // Choose an atlas grid that fits all d slices.
    const cols = ATLAS_COLS;                    // 8
    const rows = Math.ceil(d / cols);           // 4 for d=32
    this.atlasW = cols * w;
    this.atlasH = rows * h;

    const atlas = new Uint8Array(this.atlasW * this.atlasH);

    for (let z = 0; z < d; z++) {
      const col = z % cols;
      const row = Math.floor(z / cols);
      const ox  = col * w;
      const oy  = row * h;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const srcIdx = z * w * h + y * w + x;
          const dstIdx = (oy + y) * this.atlasW + (ox + x);
          atlas[dstIdx] = src[srcIdx];
        }
      }
    }

    const tex = new RawTexture(
      atlas,
      this.atlasW, this.atlasH,
      Constants.TEXTUREFORMAT_R,
      this.scene,
      /*generateMipMaps=*/false,
      /*invertY=*/false,
      Texture.BILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    return tex;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** 0 = clear sky, 1 = fully overcast. */
  updateCoverage(coverage: number): void {
    this.cloudCoverage = Math.max(0, Math.min(1, coverage));
  }

  /** direction is the XZ vector the wind blows TOWARD (need not be normalised). */
  updateWind(direction: Vector3, speed: number): void {
    const n = direction.normalize();
    this.windDirection.copyFrom(n);
    this.windSpeed = Math.max(1, speed);
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  dispose(): void {
    if (this.cloudPass)   { this.cloudPass.dispose(this.camera);   this.cloudPass   = null; }
    if (this.denoisePass) { this.denoisePass.dispose(this.camera); this.denoisePass = null; }
    if (this.depthRenderer) {
      this.scene.disableDepthRenderer(this.camera);
      this.depthRenderer = null;
    }
    this.weatherTex?.dispose();         this.weatherTex         = null;
    this.noiseTex?.dispose();           this.noiseTex           = null;
    this.noisePlaceholder?.dispose();   this.noisePlaceholder   = null;
    this.weatherPlaceholder?.dispose(); this.weatherPlaceholder = null;
    this.depthPlaceholder?.dispose();   this.depthPlaceholder   = null;
  }
}
