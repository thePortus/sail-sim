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
  Vector2, Vector3, Vector4, Matrix, Constants,
  Mesh, MeshBuilder, ShaderMaterial,
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

// Terrain heightfield (R32F metres) for cloud-vs-mountain occlusion — marched directly along the ray
// (the depth renderer can't see the clipmap's vertex displacement). bounds = (minX, minZ, sizeX, sizeZ).
uniform sampler2D terrainHeightSampler;
uniform vec4  terrainBounds;
uniform vec2  terrainTexSize;
uniform float terrainMaxAlt;
uniform float terrainHasField;

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
// Accumulated horizontal cloud drift (metres), integrated on the CPU so wind changes never jump the
// offset. (Replaces wind*time, which scaled every wind tweak by the ever-growing time → jitter.)
uniform vec2  cloudDrift;

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

// Spherical-shell atmosphere radius (Shadertoy uses real earth 6.3e6, but that
// loses float32 precision at our meter scale → shell jitter). Scaled down to keep
// precision while still curving the cloud deck down to the horizon. Tunable: larger
// = gentler, more distant horizon curve; smaller = tighter "small planet" curve.
#define EARTH_RADIUS 2000000.0

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

// ── Shadertoy 4dSBDt cloud-model helpers (faithful port) ──────────────────────
//
// vc_noise3D tiles every 1.0 in uvw; the Shadertoy's noise(vec3 x) tiles every
// noiseSliceDim (32) units of x, so we map x -> (x+0.5)/noiseSliceDim to match its
// frequency convention before sampling the same 32-cube atlas.
float vc_noiseST(vec3 x) {
    return vc_noise3D((x + 0.5) / noiseSliceDim);
}

// Three-octave fractional Brownian motion with the Shadertoy's rotation matrix.
float vc_fbm(vec3 p) {
    mat3 m = mat3( 0.00,  0.80,  0.60,
                  -0.80,  0.36, -0.48,
                  -0.60, -0.48,  0.64);
    float f  = 0.5000 * vc_noiseST(p); p = m * p * 2.02;
    f       += 0.2500 * vc_noiseST(p); p = m * p * 2.03;
    f       += 0.1250 * vc_noiseST(p);
    return f;
}

// Fitted numerical Mie phase (from shadertoy 4sjBDG) — sharp forward scatter + glow.
float vc_mieFit(float costh) {
    const float p0 = 9.805233e-06, p1 = -6.500000e+01, p2 = -5.500000e+01,
                p3 = 8.194068e-01, p4 =  1.388198e-01, p5 = -8.370334e+01,
                p6 = 7.810083e+00, p7 =  2.054747e-03, p8 =  2.600563e-02,
                p9 = -4.552125e-12;
    float pp = costh + p3;
    vec4 expValues = exp(vec4(p1 * costh + p2, p5 * pp * pp, p6 * costh, p9 * costh));
    vec4 expValWeight = vec4(p0, p4, p7, p8);
    return dot(expValues, expValWeight);
}

// Ray vs concentric cloud shell at altitude h, numerically stable at planetary radius. The shell is
// centred at (camera.x, -EARTH_RADIUS, camera.z), so oc = (0, origin.y + R, 0). The naive
// c = |oc|^2 - (R+h)^2 squares ~2e6 into ~4e12 and subtracts two such — float32 cancellation that
// jitters the hit distance as the camera bobs (all clouds vibrate in/out). Factor it as the
// difference of squares using the SMALL altitude h, so no R^2 intermediate ever forms.
float vc_intersectShell(vec3 origin, vec3 dir, float h) {
    float R  = EARTH_RADIUS;
    float L  = origin.y + R;                              // |oc| (oc points straight up)
    float b  = 2.0 * (L * dir.y);                         // 2*dot(dir, oc), oc = (0, L, 0)
    float c  = (origin.y - h) * (origin.y + 2.0 * R + h); // |oc|^2 - (R+h)^2, no R^2 term
    float disc = b * b - 4.0 * c;
    if (disc < 0.0) return -1.0;
    float q  = (-b + ((b < 0.0) ? -sqrt(disc) : sqrt(disc))) / 2.0;
    float t0 = q;
    float t1 = c / q;
    if (t0 > t1) { float tmp = t0; t0 = t1; t1 = tmp; }
    if (t1 < 0.0) return -1.0;
    return (t0 < 0.0) ? t1 : t0;
}

// ── Cloud density (faithful Shadertoy 4dSBDt clouds() on a spherical shell) ────

// Earth centre tracks the camera horizontally so the cloud deck always curves away
// from wherever the player is (the Shadertoy keeps its camera near origin; we sail
// a large world, so a fixed centre would push us to the sphere's edge).
float vc_cloudHeight(vec3 p) {
    vec3  center     = vec3(cameraPosition.x, -EARTH_RADIUS, cameraPosition.z);
    float atmoHeight = length(p - center) - EARTH_RADIUS;   // metres above the (curved) sea
    return vc_sat((atmoHeight - cloudBase) / max(cloudTop - cloudBase, 1.0));
}

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

// Faithful port of the Shadertoy clouds(): two-scale weather-texture coverage ×
// vertical profile × pow() shape × two-octave fbm erosion. lod>=1.5 takes the cheap
// "fast" path (used by the light march). cloudCoverage shifts the weather threshold so
// the same field ranges clear → overcast.
float vc_getDensity(vec3 p, float lod) {
    float ch = vc_cloudHeight(p);
    if (ch <= 0.0 || ch >= 1.0) return 0.0;

    // Storm factor from cloudType (0.40 calm cumulus → 0.95 towering cumulonimbus).
    float storm = smoothstep(0.40, 0.95, cloudType);

    // Wind drift — offset the sample position so the cloud pattern travels with the wind to
    // match the game's wind convention (same sign the prior cloud system used). Plus a slow,
    // wind-independent vertical "boil" so clouds evolve in place, not just translate. KNOBS:
    // drift rate 0.08, boil rate 3.0.
    vec2  wd    = cloudDrift;
    vec2  pzx   = p.zx + wd.yx;
    vec3  drift = vec3(wd.x, 0.0, wd.y);
    float evo   = time * 3.0;

    float largeWeather = clamp((texture2D(weatherSampler, -0.00005 * pzx).r - 0.18) * 5.0, 0.0, 2.0);
    // covThresh lowers with coverage AND storminess → storms fill the sky.
    float covThresh    = 0.28 - (cloudCoverage - 0.5) * 0.5 - storm * 0.05;
    float weather      = largeWeather * max(0.0, texture2D(weatherSampler, 0.0002 * pzx).r - covThresh) / 0.72;
    weather *= smoothstep(0.0, 0.5, ch) * smoothstep(1.0, 0.5, ch);   // vertical fade in/out
    float cloudShape = pow(weather, 0.3 + 1.5 * smoothstep(0.2, 0.5, ch));
    if (cloudShape <= 0.0) return 0.0;

    // First erosion octave (low-freq lumps), drifting with the wind.
    float den = max(0.0, cloudShape - 0.7 * vc_fbm((p + drift) * 0.01));
    if (den <= 0.0) return 0.0;

    // Density scale rises with storminess → thicker, self-shadowing, darker-based storm cloud.
    float dScale = mix(0.20, 0.32, storm);

    // Light-march / coarse path stops here (the Shadertoy 'fast' branch).
    if (lod >= 1.5) return largeWeather * dScale * min(1.0, 5.0 * den);

    // Second erosion octave (high-freq cauliflower detail) — drifts + boils; full path only.
    den = max(0.0, den - 0.2 * vc_fbm((p + drift + vec3(0.0, evo, 0.0)) * 0.05));
    return largeWeather * dScale * min(1.0, 5.0 * den);
}

// ── Light march toward the sun (faithful Shadertoy lightRay) ──────────────────

float vc_hash1(float n) { return fract(sin(n) * 43758.5453); }

// Returns the sun radiance reaching sample p: multi-term Beer-Lambert (direct + two
// scattered lobes) × Mie phase × a thin-cloud silver-lining boost. dC = density at p,
// mu = dot(viewDir, sunDir), phase = vc_mieFit(mu).
float vc_lightMarch(vec3 p, float phase, float dC, float mu, float jOff) {
    float ch    = vc_cloudHeight(p);
    float zMaxl = cloudTop - cloudBase;
    float stepL = zMaxl / float(lightSteps);
    float den   = 0.0;

    // Jitter the cone start to break up shadow banding. Use the per-PIXEL Interleaved Gradient Noise
    // offset (same value for every sample along this ray) rather than a per-sample white-noise hash:
    // coherent across the ray, so the spatial denoise settles it instead of leaving lit-top grain.
    vec3 q = p + sunDirection * stepL * jOff;
    for (int j = 0; j < lightSteps; j++) {
        den += vc_getDensity(q + sunDirection * float(j) * stepL, 2.0);
    }

    // More in-scatter when looking away from the sun (low/negative mu).
    float scatterAmount = mix(0.008, 1.0, smoothstep(0.96, 0.0, mu));
    float beersLaw = exp(-stepL * den)
                   + 0.5 * scatterAmount * exp(-0.1  * stepL * den)
                   + 0.4 * scatterAmount * exp(-0.02 * stepL * den);

    // Silver-lining boost on thin cloud (low local density), fading as the cone fills in.
    return beersLaw * phase
         * mix(0.05 + 1.5 * pow(min(1.0, dC * 8.5), 0.3 + 5.5 * ch), 1.0, clamp(den * 0.4, 0.0, 1.0));
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

    // Spherical cloud shell: the camera sails well below the deck, so each upward ray
    // exits the inner shell (cloudBase) at tNear and the outer shell (cloudTop) at tFar.
    // Near-horizon rays graze for huge distances and are fogged out anyway — skip them.
    float tNear = vc_intersectShell(cameraPosition, rd, cloudBase);
    float tFar  = vc_intersectShell(cameraPosition, rd, cloudTop);

    if (rd.y < 0.02 || tNear < 0.0 || tFar <= tNear) {
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

    // Terrain occlusion: march the heightfield along the ray and ask "is a mountain in the way?".
    // If terrain rises above the ray before the cloud, clip the slab to it (or skip the cloud).
    // Bounded: stop once an ascending ray climbs above the tallest terrain. texelFetch (nearest) —
    // the R32F heightfield isn't hardware-filterable on WebGPU.
    if (terrainHasField > 0.5) {
        float tt = 1.0;
        for (int it = 0; it < 160; it++) {
            vec3 pT = cameraPosition + rd * tt;
            if ((pT.y > terrainMaxAlt + 5.0 && rd.y >= 0.0) || tt > tFar) break;
            // Bilinear terrain height (smooths the 24 m texels → no blocky silhouette).
            vec2 uvT = vec2((pT.x - terrainBounds.x) / terrainBounds.z,
                            (terrainBounds.y + terrainBounds.w - pT.z) / terrainBounds.w);
            float hT = -1.0e4;
            if (uvT.x >= 0.0 && uvT.x <= 1.0 && uvT.y >= 0.0 && uvT.y <= 1.0) {
                vec2 tc = uvT * terrainTexSize - 0.5; vec2 fr = fract(tc);
                ivec2 i0 = ivec2(floor(tc)); ivec2 mx = ivec2(terrainTexSize) - 1;
                float h00 = texelFetch(terrainHeightSampler, clamp(i0,            ivec2(0), mx), 0).r;
                float h10 = texelFetch(terrainHeightSampler, clamp(i0+ivec2(1,0), ivec2(0), mx), 0).r;
                float h01 = texelFetch(terrainHeightSampler, clamp(i0+ivec2(0,1), ivec2(0), mx), 0).r;
                float h11 = texelFetch(terrainHeightSampler, clamp(i0+ivec2(1,1), ivec2(0), mx), 0).r;
                hT = mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
            }
            float gap = pT.y - hT;                                  // clearance above the terrain
            if (gap < 0.0) {                                        // only when the ray is BELOW the surface
                if (tt <= tNear) { gl_FragColor = scene; return; }
                tFar = min(tFar, tt);
                break;
            }
            tt += max(6.0, gap * 0.45);                             // finer near the surface → tight silhouette (no clear-sky halo)
        }
    }

    // Ray march.
    float dist = max(tFar - tNear, 0.0);
    float step = dist / float(marchSteps);

    // Static per-pixel jitter to break up banding. NOT time-varying: an animated jitter
    // makes the march noise crawl/twinkle every frame, and we have no TAA to average it out —
    // a fixed screen-space dither lets the spatial denoise settle it instead. Interleaved Gradient
    // Noise (low-discrepancy, blue-noise-like) instead of a sin-hash: neighbouring pixels get
    // well-spread offsets, so the 5x5 denoise resolves it cleanly (white-noise hash left visible grain).
    float jit01 = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float jit   = jit01 * step;

    // Fitted Mie phase — sharp forward-scatter spike (silver lining) + soft glow.
    float cosA  = dot(rd, sunDirection);
    float phase = vc_mieFit(cosA);

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
            // lt already includes the Mie phase + Beer + silver-lining (see vc_lightMarch).
            float lt = vc_lightMarch(p, phase, rho, cosA, jit01);
            float ch = vc_cloudHeight(p);
            // Ambient: blue sky irradiance (stronger toward the open top) + a soft fill on the
            // base so undersides aren't black + ocean/terrain bounce. Tint/brightness come from
            // our time/weather-aware sky & ground uniforms. KNOBS: 0.34 / 0.10 / 0.45 (raised to
            // lift the shadows and tame the light-vs-dark contrast).
            // Drive cloud darkness by the CLOUDINESS (coverage) setting: low coverage -> strongly lift the
            // shadowed-side ambient so partly-cloudy skies read fluffy + white; high coverage keeps a moody
            // look but with a LIFTED dark floor so storms don't crush huge regions to max black (softer
            // contrast). ambLift ~3.2 (light) -> 1.5 (heavy).
            float ambLift = mix(3.2, 1.5, smoothstep(0.10, 0.78, cloudCoverage));
            vec3 ambient = (skyColor    * (0.5 + 0.6 * ch) * 0.34
                         +  skyColor    * max(0.0, 1.0 - 2.0 * ch) * 0.10
                         +  groundColor * (1.0 - ch) * 0.45) * ambLift;
            // Sun term — Mie phase is small so this needs gain; KNOB 15.0 (lowered from 25 to pull
            // the blown highlights down). ≈ the Shadertoy's SUN_POWER rescaled to our exposure.
            vec3 radiance = ambient + sunColor * 15.0 * lt;

            // Energy-conserving scatter integration (Sebastien Hillaire). Extinction is the
            // density itself over the step length (no separate absorption coeff — faithful).
            float sT = exp(-rho * step);
            scatter  += transmit * radiance * (1.0 - sT);
            transmit *= sT;
        }

        t += step;
    }

    // Storm detail-reveal: a gamma (<1) on the cloud's own scatter expands the shadow/midtone separation so
    // the dense storm masses show structure instead of flattening into one dark blob. Keeps black at black
    // and barely touches the bright silver linings. Gated to high coverage so fair-weather clouds are unchanged.
    float stormDetail = smoothstep(0.45, 0.85, cloudCoverage);
    scatter = mix(scatter, pow(max(scatter, vec3(0.0)), vec3(0.62)), stormDetail);
    // Fair-weather brightness: lift the WHOLE cloud (lit bodies too, not just shadows) toward bright white at
    // low coverage, so noon clear-sky cumulus read brilliant white rather than grey. ~1.45x (light) -> 1.0.
    scatter *= mix(1.45, 1.0, smoothstep(0.12, 0.55, cloudCoverage));
    gl_FragColor = vec4(scene.rgb * transmit + scatter, scene.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────

const DENOISE_FRAG = `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 screenSize;

float vc_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Tone-compressed luma (Reinhard): maps HDR [0,inf) into [0,1) so the range weight treats noise in the
// bright cloud TOPS the same as in the mid/dark clouds (raw HDR luma makes highlight noise look like a
// hard edge and survive the denoise). Real geometry edges still span a big compressed gap and persist.
float vc_tone(vec3 c) { float l = vc_luma(c); return l / (1.0 + l); }

void main(void) {
    vec2  px     = 1.0 / screenSize;
    vec4  center = texture2D(textureSampler, vUV);
    float cl     = vc_tone(center.rgb);

    vec3  sum = vec3(0.0);
    float wt  = 0.0;

    // 5x5 bilateral blur: a spatial gaussian softens the cloud noise/dither over a wider radius, while
    // the (tone-compressed) range weight preserves high-contrast geometry edges so the scene stays crisp.
    for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
            vec2  uv = vUV + vec2(float(x), float(y)) * px;
            vec4  s  = texture2D(textureSampler, uv);
            float sw = exp(-float(x * x + y * y) / 4.5);     // spatial gaussian (sigma ~1.5)
            float rw = exp(-abs(vc_tone(s.rgb) - cl) * 10.0); // range — edge-preserving in tone space
            float w  = sw * rw;
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

// The WGSL is split into SHARED pieces composed into two variants that use the IDENTICAL cloud model:
//  • post-process variant (legacy): scene+depth+terrain composited in-shader (still the WebGL-era path).
//  • DOME variant: an in-scene backdrop mesh (renderingGroupId 0) — geometry, particles and birds all
//    rasterise OVER it, so the occlusion artifacts of the post-process approach are impossible.
const CLOUD_WGSL_COMMON_UNIFORMS = `
uniform cameraPosition: vec3f;
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
// Accumulated horizontal cloud drift (metres), integrated on the CPU so wind changes never jump it.
uniform cloudDrift: vec2f;
uniform farZ: f32;
uniform marchSteps: i32;
uniform lightSteps: i32;
uniform noiseSliceDim: f32;
uniform noiseDepth: f32;
uniform atlasW: f32;
uniform atlasH: f32;
uniform atlasCols: f32;
`;

const CLOUD_WGSL_PP_HEADER = `
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

// Terrain heightfield (R32F metres) for cloud-vs-mountain occlusion (marched along the ray).
var terrainHeightSamplerSampler: sampler;
var terrainHeightSampler: texture_2d<f32>;

uniform invViewProjection: mat4x4f;
uniform cameraForward: vec3f;
uniform terrainBounds: vec4f;
uniform terrainTexSize: vec2f;
uniform terrainMaxAlt: f32;
uniform terrainHasField: f32;
uniform nearZ: f32;
`;

const CLOUD_WGSL_HELPERS = `
const PI: f32 = 3.14159265;
// Scaled-down earth radius for the spherical cloud shell (see GLSL note) — keeps
// float32 precision while curving the deck to the horizon. Tunable.
const EARTH_RADIUS: f32 = 2000000.0;

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

// ── Shadertoy 4dSBDt cloud-model helpers (faithful port) ──────────────────────
// vc_noise3D tiles every 1.0; the Shadertoy noise(vec3) tiles every noiseSliceDim
// units, so map x -> (x+0.5)/noiseSliceDim to match its frequency convention.
fn vc_noiseST(x: vec3f) -> f32 {
    return vc_noise3D((x + 0.5) / uniforms.noiseSliceDim);
}

fn vc_fbm(p_in: vec3f) -> f32 {
    let m = mat3x3f( 0.00,  0.80,  0.60,
                    -0.80,  0.36, -0.48,
                    -0.60, -0.48,  0.64);
    var p = p_in;
    var f = 0.5000 * vc_noiseST(p); p = m * p * 2.02;
    f    += 0.2500 * vc_noiseST(p); p = m * p * 2.03;
    f    += 0.1250 * vc_noiseST(p);
    return f;
}

fn vc_mieFit(costh: f32) -> f32 {
    let p0 = 9.805233e-06; let p1 = -6.500000e+01; let p2 = -5.500000e+01;
    let p3 = 8.194068e-01; let p4 =  1.388198e-01; let p5 = -8.370334e+01;
    let p6 = 7.810083e+00; let p7 =  2.054747e-03; let p8 =  2.600563e-02;
    let p9 = -4.552125e-12;
    let pp = costh + p3;
    let expValues = exp(vec4f(p1 * costh + p2, p5 * pp * pp, p6 * costh, p9 * costh));
    let expValWeight = vec4f(p0, p4, p7, p8);
    return dot(expValues, expValWeight);
}

// Stable ray-vs-concentric-shell at altitude h (see GLSL note): factor c as the difference of
// squares with the SMALL altitude so no R^2 (~4e12) intermediate forms and float cancellation can't
// jitter the hit distance as the camera bobs.
fn vc_intersectShell(origin: vec3f, dir: vec3f, h: f32) -> f32 {
    let R  = EARTH_RADIUS;
    let L  = origin.y + R;
    let b  = 2.0 * (L * dir.y);
    let c  = (origin.y - h) * (origin.y + 2.0 * R + h);
    let disc = b * b - 4.0 * c;
    if (disc < 0.0) { return -1.0; }
    let q  = (-b + select(sqrt(disc), -sqrt(disc), b < 0.0)) / 2.0;
    var t0 = q;
    var t1 = c / q;
    if (t0 > t1) { let tmp = t0; t0 = t1; t1 = tmp; }
    if (t1 < 0.0) { return -1.0; }
    return select(t0, t1, t0 < 0.0);
}

// Earth centre tracks the camera horizontally (see GLSL note) so the deck curves away
// from the player wherever they sail.
fn vc_cloudHeight(p: vec3f) -> f32 {
    let center     = vec3f(uniforms.cameraPosition.x, -EARTH_RADIUS, uniforms.cameraPosition.z);
    let atmoHeight = length(p - center) - EARTH_RADIUS;
    return vc_sat((atmoHeight - uniforms.cloudBase) / max(uniforms.cloudTop - uniforms.cloudBase, 1.0));
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

// Faithful port of the Shadertoy clouds() — see GLSL twin for the commentary.
fn vc_getDensity(p: vec3f, lod: f32) -> f32 {
    let ch = vc_cloudHeight(p);
    if (ch <= 0.0 || ch >= 1.0) { return 0.0; }

    // Storm factor (0.40 calm → 0.95 cumulonimbus). See GLSL twin for the commentary.
    let storm = smoothstep(0.40, 0.95, uniforms.cloudType);

    let wd    = uniforms.cloudDrift;
    let pzx   = p.zx + wd.yx;
    let drift = vec3f(wd.x, 0.0, wd.y);
    let evo   = uniforms.time * 3.0;

    let largeWeather = clamp((textureSampleLevel(weatherSampler, weatherSamplerSampler, -0.00005 * pzx, 0.0).r - 0.18) * 5.0, 0.0, 2.0);
    let covThresh    = 0.28 - (uniforms.cloudCoverage - 0.5) * 0.5 - storm * 0.05;
    var weather      = largeWeather * max(0.0, textureSampleLevel(weatherSampler, weatherSamplerSampler, 0.0002 * pzx, 0.0).r - covThresh) / 0.72;
    weather = weather * smoothstep(0.0, 0.5, ch) * smoothstep(1.0, 0.5, ch);
    let cloudShape = pow(weather, 0.3 + 1.5 * smoothstep(0.2, 0.5, ch));
    if (cloudShape <= 0.0) { return 0.0; }

    var den = max(0.0, cloudShape - 0.7 * vc_fbm((p + drift) * 0.01));
    if (den <= 0.0) { return 0.0; }

    let dScale = mix(0.20, 0.32, storm);

    if (lod >= 1.5) { return largeWeather * dScale * min(1.0, 5.0 * den); }

    den = max(0.0, den - 0.2 * vc_fbm((p + drift + vec3f(0.0, evo, 0.0)) * 0.05));
    return largeWeather * dScale * min(1.0, 5.0 * den);
}

fn vc_hash1(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }

// Faithful Shadertoy lightRay — see GLSL twin for commentary. jOff = per-pixel IGN cone-start offset.
fn vc_lightMarch(p: vec3f, phase: f32, dC: f32, mu: f32, jOff: f32) -> f32 {
    let ch    = vc_cloudHeight(p);
    let zMaxl = uniforms.cloudTop - uniforms.cloudBase;
    let stepL = zMaxl / f32(uniforms.lightSteps);
    var den: f32 = 0.0;

    let q = p + uniforms.sunDirection * stepL * jOff;
    for (var j: i32 = 0; j < uniforms.lightSteps; j++) {
        den += vc_getDensity(q + uniforms.sunDirection * f32(j) * stepL, 2.0);
    }

    let scatterAmount = mix(0.008, 1.0, smoothstep(0.96, 0.0, mu));
    let beersLaw = exp(-stepL * den)
                 + 0.5 * scatterAmount * exp(-0.1  * stepL * den)
                 + 0.4 * scatterAmount * exp(-0.02 * stepL * den);

    return beersLaw * phase
         * mix(0.05 + 1.5 * pow(min(1.0, dC * 8.5), 0.3 + 5.5 * ch), 1.0, clamp(den * 0.4, 0.0, 1.0));
}
`;

const CLOUD_WGSL_PP_MAIN = `
@fragment
fn main(input: FragmentInputs)->FragmentOutputs {
    let scene_color = textureSample(textureSampler, textureSamplerSampler, input.vUV);

    // Reconstruct world-space ray from far-plane NDC (avoids near-plane Z
    // convention differences between WebGL [-1,1] and WebGPU [0,1]).
    let ndc = input.vUV * 2.0 - vec2f(1.0);
    var wF  = uniforms.invViewProjection * vec4f(ndc, 1.0, 1.0);
    wF     /= wF.w;
    let rd  = normalize(wF.xyz - uniforms.cameraPosition);

    // Spherical cloud shell (see GLSL twin): upward rays exit the inner shell (cloudBase)
    // at tNear and the outer shell (cloudTop) at tFar; near-horizon rays are skipped.
    var tNear = vc_intersectShell(uniforms.cameraPosition, rd, uniforms.cloudBase);
    var tFar  = vc_intersectShell(uniforms.cameraPosition, rd, uniforms.cloudTop);

    if (rd.y < 0.02 || tNear < 0.0 || tFar <= tNear) {
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

    // Terrain occlusion: march the heightfield along the ray — clip the cloud where a mountain blocks
    // it (the depth renderer can't see the clipmap's vertex displacement). textureLoad (nearest).
    if (uniforms.terrainHasField > 0.5) {
        var tt: f32 = 1.0;
        for (var it: i32 = 0; it < 160; it = it + 1) {
            let pT = uniforms.cameraPosition + rd * tt;
            if ((pT.y > uniforms.terrainMaxAlt + 5.0 && rd.y >= 0.0) || tt > tFar) { break; }
            let uvT = vec2f((pT.x - uniforms.terrainBounds.x) / uniforms.terrainBounds.z,
                            (uniforms.terrainBounds.y + uniforms.terrainBounds.w - pT.z) / uniforms.terrainBounds.w);
            var hT: f32 = -1.0e4;
            if (uvT.x >= 0.0 && uvT.x <= 1.0 && uvT.y >= 0.0 && uvT.y <= 1.0) {
                let tc = uvT * uniforms.terrainTexSize - vec2f(0.5);
                let fr = fract(tc);
                let i0 = vec2<i32>(floor(tc));
                let mx = vec2<i32>(uniforms.terrainTexSize) - vec2<i32>(1, 1);
                let h00 = textureLoad(terrainHeightSampler, clamp(i0,                  vec2<i32>(0), mx), 0).r;
                let h10 = textureLoad(terrainHeightSampler, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), mx), 0).r;
                let h01 = textureLoad(terrainHeightSampler, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), mx), 0).r;
                let h11 = textureLoad(terrainHeightSampler, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), mx), 0).r;
                hT = mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
            }
            let gap = pT.y - hT;
            if (gap < 0.0) {   // only when the ray is BELOW the surface (was <1.0 → over-occluded, clear-sky halo)
                if (tt <= tNear) { fragmentOutputs.color = scene_color; return fragmentOutputs; }
                tFar = min(tFar, tt);
                break;
            }
            tt = tt + max(6.0, gap * 0.45);   // finer near the surface → silhouette hugs the real terrain edge
        }
    }

    let dist      = max(tFar - tNear, 0.0);
    let step_size = dist / f32(uniforms.marchSteps);

    // Static per-pixel jitter (see GLSL note): Interleaved Gradient Noise (low-discrepancy) rather
    // than a sin-hash, so neighbouring pixels get well-spread offsets the 5x5 denoise resolves cleanly.
    let jit01 = fract(52.9829189 * fract(dot(input.position.xy, vec2f(0.06711056, 0.00583715))));
    let jit   = jit01 * step_size;

    // Dual-lobe phase: broad forward scatter + a tight forward spike (silver lining).
    let cosA  = dot(rd, uniforms.sunDirection);
    let phase = vc_mieFit(cosA);

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
            // lt already includes the Mie phase + Beer + silver-lining (see vc_lightMarch).
            let lt = vc_lightMarch(p, phase, rho, cosA, jit01);
            let ch = vc_cloudHeight(p);
            // Ambient (sky + base fill + ground bounce); tint/brightness from our uniforms.
            // KNOBS 0.34 / 0.10 / 0.45 — raised to lift shadows and tame the contrast.
            // Drive cloud darkness by the CLOUDINESS (coverage) setting: low coverage -> strongly lift the
            // shadowed-side ambient so partly-cloudy skies read fluffy + white; high coverage keeps a moody
            // look but with a LIFTED dark floor so storms don't crush huge regions to max black (softer
            // contrast). ambLift ~3.2 (light) -> 1.5 (heavy).
            let ambLift = mix(3.2, 1.5, smoothstep(0.10, 0.78, uniforms.cloudCoverage));
            let ambient = (uniforms.skyColor    * (0.5 + 0.6 * ch) * 0.34
                        +  uniforms.skyColor    * max(0.0, 1.0 - 2.0 * ch) * 0.10
                        +  uniforms.groundColor * (1.0 - ch) * 0.45) * ambLift;
            // Sun term — gain lowered 25 → 15 to pull down the blown highlights.
            let radiance = ambient + uniforms.sunColor * 15.0 * lt;

            // Energy-conserving integration; extinction = density × step (faithful, no abs coeff).
            let sT = exp(-rho * step_size);
            scatter  += transmit * radiance * (1.0 - sT);
            transmit *= sT;
        }

        t += step_size;
    }

    // Storm detail-reveal (see GLSL): gamma (<1) on scatter expands shadow/midtone separation in dense storm
    // masses; black stays black, silver linings ~unchanged. Gated to high coverage (fair weather untouched).
    let stormDetail = smoothstep(0.45, 0.85, uniforms.cloudCoverage);
    scatter = mix(scatter, pow(max(scatter, vec3f(0.0)), vec3f(0.62)), vec3f(stormDetail));
    // Fair-weather brightness: lift the WHOLE cloud toward bright white at low coverage (noon clear cumulus).
    scatter *= mix(1.45, 1.0, smoothstep(0.12, 0.55, uniforms.cloudCoverage));
    fragmentOutputs.color = vec4f(scene_color.rgb * transmit + scatter, scene_color.a);
}
`;

// Identical content to the historical single-string shader (header + uniforms + helpers + main).
const CLOUD_WGSL = CLOUD_WGSL_PP_HEADER + CLOUD_WGSL_COMMON_UNIFORMS + CLOUD_WGSL_HELPERS + CLOUD_WGSL_PP_MAIN;

// ─────────────────────────────────────────────────────────────────────────────
// DOME variant — the raymarch rendered as an in-scene backdrop mesh (option C).
// Same cloud model/uniforms; differences vs the post-process:
//  • the ray comes from the mesh fragment's world position (no invViewProjection / vUV);
//  • NO scene/depth/terrain sampling — geometry simply rasterises over the dome afterwards;
//  • output is PREMULTIPLIED (scatter, 1−transmit), blended over the sky with ONE/ONE_MINUS_SRC_ALPHA.
// ─────────────────────────────────────────────────────────────────────────────

const CLOUD_DOME_VERTEX_WGSL = `
attribute position: vec3f;
#include<sceneUboDeclaration>
#include<meshUboDeclaration>
varying vWorldPos: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let wp = mesh.world * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vWorldPos = wp.xyz;
    vertexOutputs.position = scene.viewProjection * wp;
}
`;

const CLOUD_DOME_HEADER = `
varying vWorldPos: vec3f;

var noiseSamplerSampler: sampler;
var noiseSampler: texture_2d<f32>;
var weatherSamplerSampler: sampler;
var weatherSampler: texture_2d<f32>;
`;

const CLOUD_DOME_MAIN = `
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    // The dome is an infiniteDistance box centred on the camera, so the fragment's world position is
    // camera + a fixed offset — normalising the difference gives the view ray exactly like the old
    // far-plane NDC reconstruction, with no matrix work.
    let rd = normalize(input.vWorldPos - uniforms.cameraPosition);

    var tNear = vc_intersectShell(uniforms.cameraPosition, rd, uniforms.cloudBase);
    var tFar  = vc_intersectShell(uniforms.cameraPosition, rd, uniforms.cloudTop);

    if (rd.y < 0.02 || tNear < 0.0 || tFar <= tNear) {
        fragmentOutputs.color = vec4f(0.0);
        return fragmentOutputs;
    }
    tNear = max(tNear, 0.01);
    tFar  = min(tFar, uniforms.farZ);

    let dist      = max(tFar - tNear, 0.0);
    let step_size = dist / f32(uniforms.marchSteps);

    // Static per-pixel jitter — Interleaved Gradient Noise on the frag coord, same as the PP variant.
    let jit01 = fract(52.9829189 * fract(dot(input.position.xy, vec2f(0.06711056, 0.00583715))));
    let jit   = jit01 * step_size;

    let cosA  = dot(rd, uniforms.sunDirection);
    let phase = vc_mieFit(cosA);

    var transmit: f32  = 1.0;
    var scatter:  vec3f = vec3f(0.0);
    var t: f32 = tNear + jit;

    // Adaptive empty-space skipping — identical to the PP variant.
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
            let lt = vc_lightMarch(p, phase, rho, cosA, jit01);
            let ch = vc_cloudHeight(p);
            let ambLift = mix(3.2, 1.5, smoothstep(0.10, 0.78, uniforms.cloudCoverage));
            let ambient = (uniforms.skyColor    * (0.5 + 0.6 * ch) * 0.34
                        +  uniforms.skyColor    * max(0.0, 1.0 - 2.0 * ch) * 0.10
                        +  uniforms.groundColor * (1.0 - ch) * 0.45) * ambLift;
            let radiance = ambient + uniforms.sunColor * 15.0 * lt;

            let sT = exp(-rho * step_size);
            scatter  += transmit * radiance * (1.0 - sT);
            transmit *= sT;
        }

        t += step_size;
    }

    // Same storm detail-reveal + fair-weather lift as the PP variant.
    let stormDetail = smoothstep(0.45, 0.85, uniforms.cloudCoverage);
    scatter = mix(scatter, pow(max(scatter, vec3f(0.0)), vec3f(0.62)), vec3f(stormDetail));
    scatter *= mix(1.45, 1.0, smoothstep(0.12, 0.55, uniforms.cloudCoverage));

    // PREMULTIPLIED: rgb = in-scattered light, a = cloud opacity. ONE/ONE_MINUS_SRC_ALPHA over the sky
    // reproduces exactly the PP composite (sky·transmit + scatter).
    fragmentOutputs.color = vec4f(scatter, 1.0 - transmit);
}
`;

const CLOUD_DOME_FRAG_WGSL = CLOUD_DOME_HEADER + CLOUD_WGSL_COMMON_UNIFORMS + CLOUD_WGSL_HELPERS + CLOUD_DOME_MAIN;

// ─────────────────────────────────────────────────────────────────────────────

const DENOISE_WGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform screenSize: vec2f;

fn vc_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// Tone-compressed luma (Reinhard): maps HDR [0,inf) into [0,1) so the range weight treats noise in the
// bright cloud TOPS the same as in the mid/dark clouds (raw HDR luma makes highlight noise look like a
// hard edge and survive the denoise). Real geometry edges still span a big compressed gap and persist.
fn vc_tone(c: vec3f) -> f32 { let l = vc_luma(c); return l / (1.0 + l); }

@fragment
fn main(input: FragmentInputs)->FragmentOutputs {
    let px     = 1.0 / uniforms.screenSize;
    let center = textureSample(textureSampler, textureSamplerSampler, input.vUV);
    let cl     = vc_tone(center.rgb);

    var sum: vec3f = vec3f(0.0);
    var wt:  f32   = 0.0;

    // 5x5 bilateral blur: a spatial gaussian softens the cloud noise/dither over a wider radius, while
    // the (tone-compressed) range weight preserves high-contrast geometry edges so the scene stays crisp.
    for (var x: i32 = -2; x <= 2; x++) {
        for (var y: i32 = -2; y <= 2; y++) {
            let uv = input.vUV + vec2f(f32(x), f32(y)) * px;
            let s  = textureSampleLevel(textureSampler, textureSamplerSampler, uv, 0.0);
            let sw = exp(-f32(x * x + y * y) / 4.5);            // spatial gaussian (sigma ~1.5)
            let rw = exp(-abs(vc_tone(s.rgb) - cl) * 10.0);     // range — edge-preserving in tone space
            let w  = sw * rw;
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
  /** 'dome' (default on WebGPU): in-scene backdrop mesh — geometry/particles/birds draw OVER the clouds,
   *  occlusion artifacts impossible; no depth renderer needed. 'postprocess': the legacy screen-space
   *  composite (WebGL fallback — the dome shaders are WGSL-only). */
  mode?:             'dome' | 'postprocess';
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

  private cloudPass:    PostProcess | null = null;
  private denoisePass:  PostProcess | null = null;
  // DOME mode (option C): the raymarch as an in-scene backdrop mesh instead of a post-process.
  private domeMode = false;
  private domeMesh: Mesh | null = null;
  private domeMat:  ShaderMaterial | null = null;
  private weatherTex:  Texture    | null = null;
  private noiseTex:    RawTexture | null = null;
  // true → procedural grey value-noise weather map (Shadertoy-style); false → pebbles.png.
  private readonly useGreyNoiseWeather = true;

  // Optional hooks (set by CloudService) returning the physical atmosphere's sun & sky COLOUR
  // (hue) so the clouds adopt the atmospheric scattering's colour temperature — warm at the
  // horizon, blue at noon — while keeping their own tuned brightness. Null → use the built-in curves.
  getAtmoSun: (() => Vector3 | null) | null = null;
  getAtmoSky: (() => Vector3 | null) | null = null;

  // NOTE: P3 temporal reprojection was attempted and removed — it can't work cleanly in
  // Babylon's auto-managed camera post-process chain (persistent cross-frame history
  // capture fights the pooled pass outputs; an off-chain capture pass crashes at
  // construction). The perf goal of P3 is instead met by the adaptive empty-space
  // skipping in the march loop. See cloud_upgrade_roadmap.md.

  // 1×1 placeholder textures used until async loads complete.
  // WebGPU requires every declared binding to be present on the first frame;
  // WebGL silently ignores missing textures (black), but we set these for both.
  private noisePlaceholder:   RawTexture | null = null;
  private weatherPlaceholder: RawTexture | null = null;
  private depthPlaceholder:   RawTexture | null = null;
  private terrainPlaceholder: RawTexture | null = null;

  // Babylon.js DepthRenderer: stores linear (eye-Z) depth for the scene camera.
  private depthRenderer: DepthRenderer | null = null;

  // Atlas metadata (populated when binary is parsed).
  private atlasW    = 256;
  private atlasH    = 128;
  private noiseDim  = 32;   // texels per slice edge
  private noiseDepth = 32;  // number of Z slices

  private elapsedSecs = 0;
  /** Accumulated horizontal cloud drift (metres, XZ). Integrated per-frame from wind so that changing
   *  the wind never retroactively jumps the offset — the old wind*time form scaled every weather-tick
   *  wind tweak by the ever-growing time, which showed as jitter in the cloud movement. */
  private cloudDrift = new Vector2(0, 0);
  /** Low-pass-filtered frame time (seconds) used to advance ALL cloud animation. The raw engine
   *  delta swings ~15↔45 ms frame-to-frame (and spikes past 1 s on shader-recompile hitches); feeding
   *  that straight into the time/drift accumulators made the cloud shape morph + translate by a 3×-
   *  varying amount each frame, which the eye reads as the whole field jittering / "zooming a teeny
   *  bit." We diagnosed it by instrumenting every candidate input: only dt moved. An EMA of dt keeps
   *  the long-run speed identical but makes the per-frame step near-constant, so the judder is gone.
   *  -1 = uninitialised (seed from the first real frame instead of easing up from 0). */
  private smoothDt = -1;
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
    // Dome mode is WGSL-only → WebGL keeps the legacy post-process path.
    this.domeMode = (options.mode ?? (isWebGPU ? 'dome' : 'postprocess')) === 'dome' && isWebGPU;
    this.buildPlaceholders();
    this.registerShaders(isWebGPU);
    if (this.domeMode) {
      // No depth renderer in dome mode: occlusion comes free from the raster order (the dome draws
      // first, everything else over it) — that's a whole every-frame depth pass saved, too.
      this.buildDome();
    } else {
      // storeNonLinearDepth = false → stores linear metric (eyeZ - nearZ) / (farZ - nearZ).
      this.depthRenderer = scene.enableDepthRenderer(camera, false);
      this.buildPostProcesses(options.renderScale ?? 0.82, isWebGPU);
    }
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

    // Terrain height: a deep negative value (R32F) so the placeholder never registers a hit until the
    // real heightfield is published. Must be FLOAT to match the terrain texture's textureLoad type.
    this.terrainPlaceholder = new RawTexture(
      new Float32Array([-1.0e4]), 1, 1, Constants.TEXTUREFORMAT_R,
      this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT,
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
      ShaderStore.ShadersStoreWGSL['volCloudDomeVertexShader']   = CLOUD_DOME_VERTEX_WGSL;
      ShaderStore.ShadersStoreWGSL['volCloudDomeFragmentShader'] = CLOUD_DOME_FRAG_WGSL;
    }
  }

  // ── Dome mode (option C) ──────────────────────────────────────────────────

  /** Build the in-scene cloud backdrop: an infiniteDistance box (like the skybox) carrying the raymarch
   *  as a ShaderMaterial. renderingGroupId 0 + transparent + huge alphaIndex → draws right after the
   *  sky/sun/moon/stars within group 0, and EVERYTHING in groups 1+ (terrain, ocean LODs, ships, birds)
   *  plus all the group-3 particle FX rasterises over it. Premultiplied blend reproduces the exact
   *  composite the post-process produced (sky·transmit + scatter). */
  private buildDome(): void {
    const mat = new ShaderMaterial('volCloudDome', this.scene, 'volCloudDome', {
      attributes: ['position'],
      uniformBuffers: ['Scene', 'Mesh'],
      samplers: ['noiseSampler', 'weatherSampler'],
      needAlphaBlending: true,
      shaderLanguage: ShaderLanguage.WGSL,
    });
    mat.backFaceCulling   = false;            // viewed from inside the box
    mat.disableDepthWrite = true;             // backdrop never occludes anything
    mat.fogEnabled        = false;            // infiniteDistance + EXP2 fog would wash it to fog colour
    mat.alphaMode         = Constants.ALPHA_PREMULTIPLIED;   // ONE / ONE_MINUS_SRC_ALPHA
    mat.onBindObservable.add(() => {
      const eff = mat.getEffect();
      if (eff && this._enabled) { this.applyCloudUniforms(eff); }
    });
    this.domeMat = mat;

    // Slightly inside the sky domes (proceduralSky 130000 / Preetham 150000) so depth-testing against
    // the opaque sky always passes; sun (65000) and moon are farther from the camera than this mesh's
    // centre (the camera itself), so the back-to-front transparent sort draws them FIRST → clouds pass
    // in front of the sun/moon. alphaIndex above the star dome's default breaks the distance tie.
    const dome = MeshBuilder.CreateBox('volCloudDome', { size: 120000 }, this.scene);
    dome.material         = mat;
    dome.infiniteDistance = true;
    dome.renderingGroupId = 0;
    dome.alphaIndex       = 5000;
    dome.isPickable       = false;
    dome.applyFog         = false;
    this.domeMesh = dome;
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
        'time', 'cloudDrift',
        'nearZ', 'farZ', 'marchSteps', 'lightSteps',
        'noiseSliceDim', 'noiseDepth', 'atlasW', 'atlasH', 'atlasCols',
        'terrainBounds', 'terrainTexSize', 'terrainMaxAlt', 'terrainHasField',
      ],
      /* samplers */ ['noiseSampler', 'weatherSampler', 'depthSampler', 'terrainHeightSampler'],
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
    // Smooth + clamp the frame delta before advancing any animation. Raw getDeltaTime() swings
    // ~15↔45 ms frame-to-frame and spikes past 1 s on shader-recompile hitches; advancing the cloud
    // time/drift by that raw value made the field morph + translate unevenly each frame — the
    // "jitter / teeny zoom" the instrumentation pinned to dt (and nothing else). Clamp out spikes,
    // then EMA toward the running mean so the per-frame step is near-constant. Long-run speed is
    // unchanged; only the frame-to-frame judder is removed.
    const rawDt = Math.min(0.05, Math.max(0, this.scene.getEngine().getDeltaTime() / 1000));
    this.smoothDt = this.smoothDt < 0 ? rawDt : this.smoothDt + (rawDt - this.smoothDt) * 0.06;
    const dt = this.smoothDt;
    this.elapsedSecs += dt;
    // Integrate the drift from the CURRENT wind each frame (matches the old wd = wind*time*0.08 rate),
    // so a wind change only bends future motion instead of jumping the whole accumulated offset.
    this.cloudDrift.x += this.windDirection.x * this.windSpeed * 0.08 * dt;
    this.cloudDrift.y += this.windDirection.z * this.windSpeed * 0.08 * dt;

    const sunDir = this.getSunDir();
    if (!this.domeMode) {
      // Build the inverse view-projection from THIS camera explicitly. scene.getTransformMatrix() returns
      // whatever transform was set last in the frame — the ocean reflection/refraction RTTs and the depth
      // renderer each render with their own camera, so reading the shared matrix here can flicker between
      // camera states frame-to-frame, which the far clouds amplify into a constant jitter. The camera's
      // own view×projection is stable and correct. (Dome mode: the ray comes from the mesh fragment's
      // world position — no matrices, no depth, no terrain needed.)
      const invVP = Matrix.Invert(this.camera.getViewMatrix().multiply(this.camera.getProjectionMatrix()));
      effect.setMatrix('invViewProjection', invVP);
      // World-space unit vector the camera is looking toward; used to convert
      // linear eye-depth back into a ray-parameter t for occlusion comparison.
      effect.setVector3('cameraForward', this.camera.getDirection(Vector3.Forward()));
    }
    effect.setVector3('cameraPosition', this.camera.globalPosition);
    effect.setVector3('sunDirection', sunDir);
    // ── Time-of-day lighting ───────────────────────────────────────────────
    // sunDir.y is sin(elevation): +1 = noon zenith, 0 = horizon, -1 = midnight.
    const el = Math.max(0, sunDir.y);   // 0 at/below horizon, 1 at zenith

    // Direct sun beam — golden/orange near the horizon (sunrise & sunset), cooling to a
    // bright near-white at noon. Values >1 at noon (HDR) so lit cloud reads bright through
    // ACES. The blue & green channels drop hardest at low sun, giving warm low-angle light.
    const sunBright = 0.05 + 1.7 * el;
    const sunColor = new Vector3(
      sunBright,
      sunBright * (0.52 + 0.48 * el),
      sunBright * (0.34 + 0.62 * el),
    );

    // Sky irradiance — the diffuse light from the whole atmosphere that
    // illuminates cloud tops from above.  This is the primary "whitening" term.
    // We attenuate it when coverage is high so storm clouds look grey/dark:
    //   coverage 0.00–0.45 → full sky irradiance (scattered cumulus → white)
    //   coverage 0.45–1.00 → progressively dimmer (overcast / storm → dark grey)
    const stormDim = Math.max(0.08, 1.0 - Math.max(0, this.cloudCoverage - 0.45) * 1.5);
    // Cool moonlight floor after dark (sunDir.y < 0 ⇒ the moon, anti-solar, is up) so night
    // clouds read as faint silver-blue against the dark sky instead of going black.
    const night = Math.max(0, -sunDir.y);
    const skyColor = new Vector3(
      stormDim * (0.12 + 1.8 * el) + night * 0.10,
      stormDim * (0.15 + 1.9 * el) + night * 0.12,
      stormDim * (0.20 + 2.0 * el) + night * 0.16,
    );

    // Couple to the physical atmosphere: re-tint the sun & sky colour to the atmosphere's HUE
    // (keeping our own luminance/brightness) so clouds match the sky's colour temperature.
    const tintToAtmo = (col: Vector3, atmo: Vector3 | null): void => {
      if (!atmo) { return; }
      const al = Math.max(1e-4, atmo.x * 0.30 + atmo.y * 0.59 + atmo.z * 0.11);   // atmo luminance
      const cl = col.x * 0.30 + col.y * 0.59 + col.z * 0.11;                       // keep our lum
      col.set(cl * atmo.x / al, cl * atmo.y / al, cl * atmo.z / al);
    };
    tintToAtmo(sunColor, this.getAtmoSun?.() ?? null);
    tintToAtmo(skyColor, this.getAtmoSky?.() ?? null);

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

    effect.setFloat('time',        this.elapsedSecs);
    effect.setVector2('cloudDrift', this.cloudDrift);

    if (!this.domeMode) { effect.setFloat('nearZ', this.camera.minZ); }
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

    // Depth + terrain occlusion inputs — POST-PROCESS MODE ONLY. The dome needs neither: scene geometry
    // simply rasterises over the backdrop in raster order.
    if (!this.domeMode) {
      // Depth map — supplied by Babylon's DepthRenderer each frame.
      // Fall back to the zero-placeholder (= no occlusion) if not yet ready.
      const depthMap = this.depthRenderer?.getDepthMap() ?? null;
      effect.setTexture(
        'depthSampler',
        depthMap?.isReady() ? depthMap : this.depthPlaceholder,
      );

      // Terrain heightfield (published by TerrainService via scene.metadata) for cloud-vs-mountain
      // occlusion. Fall back to the deep-negative placeholder (= never occludes) until it's ready.
      const thf = (this.scene.metadata as { terrainHeightField?: {
        tex: Texture; bounds: Vector4; texSize: Vector2; maxAlt: number } } | null)?.terrainHeightField;
      const haveTerrain = !!(thf && thf.tex?.isReady());
      effect.setTexture('terrainHeightSampler', haveTerrain ? thf!.tex : this.terrainPlaceholder);
      effect.setFloat('terrainHasField', haveTerrain ? 1 : 0);
      if (haveTerrain) {
        effect.setVector4('terrainBounds', thf!.bounds);
        effect.setVector2('terrainTexSize', thf!.texSize);
        effect.setFloat('terrainMaxAlt', thf!.maxAlt);
      } else {
        effect.setVector4('terrainBounds', new Vector4(0, 0, 1, 1));
        effect.setVector2('terrainTexSize', new Vector2(1, 1));
        effect.setFloat('terrainMaxAlt', 0);
      }
    }
  }

  // ── Texture loading ───────────────────────────────────────────────────────

  private loadTextures(weatherUrl: string, noiseUrl: string): void {
    // 2-D coverage / weather texture.
    if (this.useGreyNoiseWeather) {
      // Procedural smooth value-noise FBM — matches the character of the Shadertoy's
      // "Grey Noise Medium" iChannel0 (smoother / less structured than the pebbles photo),
      // generated locally so we don't fetch a second asset. Toggle off to use pebbles.png.
      this.weatherTex = this.buildGreyNoise2D(256);
    } else {
      this.weatherTex = new Texture(
        weatherUrl, this.scene,
        /*noMipmap=*/false, /*invertY=*/true, Texture.TRILINEAR_SAMPLINGMODE,
      );
      // MIRROR (not WRAP): reflected tiling is C0-continuous across tile boundaries, so
      // even the distant weather-map seam disappears instead of showing a hard line.
      this.weatherTex.wrapU = Texture.MIRROR_ADDRESSMODE;
      this.weatherTex.wrapV = Texture.MIRROR_ADDRESSMODE;
    }

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
   * Generates a seamless tiling grey value-noise FBM texture (R8) to use as the cloud
   * weather/coverage map — the character of the Shadertoy's "Grey Noise Medium" iChannel0.
   * All octave periods divide `size`, so the texture tiles seamlessly under MIRROR/WRAP.
   */
  private buildGreyNoise2D(size: number): RawTexture {
    const data = new Uint8Array(size * size);

    // Integer-lattice hash, periodic in `period` so each octave tiles seamlessly.
    const hash = (ix: number, iy: number, period: number): number => {
      const x = ((ix % period) + period) % period;
      const y = ((iy % period) + period) % period;
      let h = (x * 374761393 + y * 668265263) | 0;
      h = (h ^ (h >>> 13)) * 1274126177;
      h = h ^ (h >>> 16);
      return (h >>> 0) / 4294967295;
    };
    const fade = (t: number): number => t * t * (3 - 2 * t);
    const valNoise = (fx: number, fy: number, period: number): number => {
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fade(fx - x0), ty = fade(fy - y0);
      const v00 = hash(x0, y0, period),     v10 = hash(x0 + 1, y0, period);
      const v01 = hash(x0, y0 + 1, period), v11 = hash(x0 + 1, y0 + 1, period);
      const a = v00 + (v10 - v00) * tx;
      const b = v01 + (v11 - v01) * tx;
      return a + (b - a) * ty;
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        let f = 0, amp = 0.5, sum = 0, period = 4;
        for (let o = 0; o < 4; o++) {
          f   += amp * valNoise(u * period, v * period, period);
          sum += amp;
          amp *= 0.5;
          period *= 2;
        }
        data[y * size + x] = Math.max(0, Math.min(255, Math.round((f / sum) * 255)));
      }
    }

    const tex = new RawTexture(
      data, size, size, Constants.TEXTUREFORMAT_R, this.scene,
      /*generateMipMaps=*/false, /*invertY=*/false,
      Texture.BILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    tex.wrapU = Texture.MIRROR_ADDRESSMODE;
    tex.wrapV = Texture.MIRROR_ADDRESSMODE;
    return tex;
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

  /**
   * Snapshot of the live cloud coverage state so the ocean & terrain shaders can cast cloud
   * shadows that match the actual clouds — the current wind drift (precomputed to match the
   * cloud shader's `wd`), the coverage/storm threshold, and the cloud base altitude. The surface
   * shaders reproduce the coverage field procedurally (no extra texture sampler — the FFT ocean
   * is already at the WebGPU 16-texture limit), so shadows drift in sync and track density.
   */
  getCloudShadowField(): { drift: Vector2; covThresh: number; cloudBase: number } | null {
    if (!this._enabled) { return null; }
    const st = Math.max(0, Math.min(1, (this.cloudType - 0.40) / (0.95 - 0.40)));
    const storm = st * st * (3 - 2 * st);                           // smoothstep(0.40, 0.95)
    const covThresh = 0.28 - (this.cloudCoverage - 0.5) * 0.5 - storm * 0.05;
    return {
      drift: this.cloudDrift.clone(),                               // exact accumulated shader drift
      covThresh,
      cloudBase: this.cloudBaseHeight,
    };
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
    this.domeMesh?.setEnabled(enabled);   // dome mode: stop drawing the backdrop entirely
  }

  dispose(): void {
    this.domeMesh?.dispose(); this.domeMesh = null;
    this.domeMat?.dispose();  this.domeMat  = null;
    if (this.cloudPass)    { this.cloudPass.dispose(this.camera);    this.cloudPass    = null; }
    if (this.denoisePass)  { this.denoisePass.dispose(this.camera);  this.denoisePass  = null; }
    if (this.depthRenderer) {
      this.scene.disableDepthRenderer(this.camera);
      this.depthRenderer = null;
    }
    this.weatherTex?.dispose();         this.weatherTex         = null;
    this.noiseTex?.dispose();           this.noiseTex           = null;
    this.noisePlaceholder?.dispose();   this.noisePlaceholder   = null;
    this.weatherPlaceholder?.dispose(); this.weatherPlaceholder = null;
    this.depthPlaceholder?.dispose();   this.depthPlaceholder   = null;
    this.terrainPlaceholder?.dispose(); this.terrainPlaceholder = null;
  }
}
