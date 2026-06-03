/**
 * WGSL compute kernels for the FFT ocean — ported verbatim from the gasgiant FFT-Ocean
 * project (https://github.com/gasgiant/FFT-Ocean) via Popov72's Babylon.js port
 * (https://github.com/Popov72/OceanDemo). All credit to the original authors.
 *
 * These run only on WebGPU (compute shaders). Inlined as TS strings to match the
 * project's no-raw-loader convention.
 */

// ── Initial spectrum: JONSWAP h0(k) + directional spreading (runs once / weather change) ──
export const INITIAL_SPECTRUM_WGSL = /* wgsl */ `
const PI : f32 = 3.1415926;

@group(0) @binding(1) var WavesData : texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var H0K : texture_storage_2d<rg32float, write>;
@group(0) @binding(4) var Noise : texture_2d<f32>;

struct Params {
    Size : u32,
    LengthScale : f32,
    CutoffHigh : f32,
    CutoffLow : f32,
    GravityAcceleration : f32,
    Depth : f32,
};

@group(0) @binding(5) var<uniform> params : Params;

struct SpectrumParameter {
    scale : f32,
    angle : f32,
    spreadBlend : f32,
    swell : f32,
    alpha : f32,
    peakOmega : f32,
    gamma : f32,
    shortWavesFade : f32,
};

struct SpectrumParameters {
    elements : array<SpectrumParameter>,
};

@group(0) @binding(6) var<storage, read> spectrums : SpectrumParameters;

fn frequency(k: f32, g: f32, depth: f32) -> f32 {
    return sqrt(g * k * tanh(min(k * depth, 20.0)));
}

fn frequencyDerivative(k: f32, g: f32, depth: f32) -> f32 {
    let th = tanh(min(k * depth, 20.0));
    let ch = cosh(k * depth);
    return g * (depth * k / ch / ch + th) / frequency(k, g, depth) / 2.0;
}

fn normalisationFactor(s: f32) -> f32 {
    let s2 = s * s;
    let s3 = s2 * s;
    let s4 = s3 * s;
    if (s < 5.0) {
        return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
    }
    return -4.80e-08 * s4 + 1.07e-05 * s3 - 9.53e-04 * s2 + 5.90e-02 * s + 3.93e-01;
}

fn cosine2s(theta: f32, s: f32) -> f32 {
    return normalisationFactor(s) * pow(abs(cos(0.5 * theta)), 2.0 * s);
}

fn spreadPower(omega: f32, peakOmega: f32) -> f32 {
    if (omega > peakOmega) {
        return 9.77 * pow(abs(omega / peakOmega), -2.5);
    }
    return 6.97 * pow(abs(omega / peakOmega), 5.0);
}

fn directionSpectrum(theta: f32, omega: f32, pars: SpectrumParameter) -> f32 {
    let s = spreadPower(omega, pars.peakOmega) + 16.0 * tanh(min(omega / pars.peakOmega, 20.0)) * pars.swell * pars.swell;
    return mix(2.0 / PI * cos(theta) * cos(theta), cosine2s(theta - pars.angle, s), pars.spreadBlend);
}

fn TMACorrection(omega: f32, g: f32, depth: f32) -> f32 {
    let omegaH = omega * sqrt(depth / g);
    if (omegaH <= 1.0) {
        return 0.5 * omegaH * omegaH;
    }
    if (omegaH < 2.0) {
        return 1.0 - 0.5 * (2.0 - omegaH) * (2.0 - omegaH);
    }
    return 1.0;
}

fn JONSWAP(omega: f32, g: f32, depth: f32, pars: SpectrumParameter) -> f32 {
    var sigma: f32;
    if (omega <= pars.peakOmega) {
        sigma = 0.07;
    } else {
        sigma = 0.09;
    }
    let r = exp(-(omega - pars.peakOmega) * (omega - pars.peakOmega) / 2.0 / sigma / sigma / pars.peakOmega / pars.peakOmega);

    let oneOverOmega = 1.0 / omega;
    let peakOmegaOverOmega = pars.peakOmega / omega;

    return pars.scale * TMACorrection(omega, g, depth) * pars.alpha * g * g
        * oneOverOmega * oneOverOmega * oneOverOmega * oneOverOmega * oneOverOmega
        * exp(-1.25 * peakOmegaOverOmega * peakOmegaOverOmega * peakOmegaOverOmega * peakOmegaOverOmega)
        * pow(abs(pars.gamma), r);
}

fn shortWavesFade(kLength: f32, pars: SpectrumParameter) -> f32 {
    return exp(-pars.shortWavesFade * pars.shortWavesFade * kLength * kLength);
}

@compute @workgroup_size(8,8,1)
fn calculateInitialSpectrum(@builtin(global_invocation_id) id : vec3<u32>) {
    let deltaK = 2.0 * PI / params.LengthScale;
    let nx = f32(id.x) - f32(params.Size) / 2.0;
    let nz = f32(id.y) - f32(params.Size) / 2.0;
    let k = vec2<f32>(nx, nz) * deltaK;
    let kLength = length(k);

    if (kLength <= params.CutoffHigh && kLength >= params.CutoffLow) {
        let omega = frequency(kLength, params.GravityAcceleration, params.Depth);
        textureStore(WavesData, vec2<i32>(id.xy), vec4<f32>(k.x, 1.0 / kLength, k.y, omega));

        let kAngle = atan2(k.y, k.x);
        let dOmegadk = frequencyDerivative(kLength, params.GravityAcceleration, params.Depth);
        var spectrum = JONSWAP(omega, params.GravityAcceleration, params.Depth, spectrums.elements[0]) * directionSpectrum(kAngle, omega, spectrums.elements[0]) * shortWavesFade(kLength, spectrums.elements[0]);
        if (spectrums.elements[1].scale > 0.0) {
            spectrum = spectrum + JONSWAP(omega, params.GravityAcceleration, params.Depth, spectrums.elements[1]) * directionSpectrum(kAngle, omega, spectrums.elements[1]) * shortWavesFade(kLength, spectrums.elements[1]);
        }
        let noise = textureLoad(Noise, vec2<i32>(id.xy), 0).xy;
        textureStore(H0K, vec2<i32>(id.xy), vec4<f32>(noise * sqrt(2.0 * spectrum * abs(dOmegadk) / kLength * deltaK * deltaK), 0., 0.));
    } else {
        textureStore(H0K, vec2<i32>(id.xy), vec4<f32>(0.0));
        textureStore(WavesData, vec2<i32>(id.xy), vec4<f32>(k.x, 1.0, k.y, 0.0));
    }
}
`;

// ── Conjugate spectrum: pack h0(k) and h0(-k)* into one RGBA texture ──
export const CONJUGATE_SPECTRUM_WGSL = /* wgsl */ `
@group(0) @binding(0) var H0 : texture_storage_2d<rgba32float, write>;

struct Params {
    Size : u32,
    LengthScale : f32,
    CutoffHigh : f32,
    CutoffLow : f32,
    GravityAcceleration : f32,
    Depth : f32,
};

@group(0) @binding(5) var<uniform> params : Params;
@group(0) @binding(8) var H0K : texture_2d<f32>;

@compute @workgroup_size(8,8,1)
fn calculateConjugatedSpectrum(@builtin(global_invocation_id) id : vec3<u32>) {
    let h0K = textureLoad(H0K, vec2<i32>(id.xy), 0).xy;
    let h0MinusK = textureLoad(H0K, vec2<i32>(i32(params.Size - id.x) % i32(params.Size), i32(params.Size - id.y) % i32(params.Size)), 0);

    textureStore(H0, vec2<i32>(id.xy), vec4<f32>(h0K.x, h0K.y, h0MinusK.x, -h0MinusK.y));
}
`;

// ── Time evolution: advance spectrum to time t, emit 4 displacement/derivative spectra ──
export const TIME_DEPENDENT_SPECTRUM_WGSL = /* wgsl */ `
@group(0) @binding(1) var H0 : texture_2d<f32>;
@group(0) @binding(3) var WavesData : texture_2d<f32>;

struct Params {
    Time : f32,
};

@group(0) @binding(4) var<uniform> params : Params;

@group(0) @binding(5) var DxDz : texture_storage_2d<rg32float, write>;
@group(0) @binding(6) var DyDxz : texture_storage_2d<rg32float, write>;
@group(0) @binding(7) var DyxDyz : texture_storage_2d<rg32float, write>;
@group(0) @binding(8) var DxxDzz : texture_storage_2d<rg32float, write>;

fn complexMult(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.r * b.r - a.g * b.g, a.r * b.g + a.g * b.r);
}

@compute @workgroup_size(8,8,1)
fn calculateAmplitudes(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);
    let wave = textureLoad(WavesData, iid.xy, 0);
    let phase = wave.w * params.Time;
    let exponent = vec2<f32>(cos(phase), sin(phase));
    let h0 = textureLoad(H0, iid.xy, 0);
    let h = complexMult(h0.xy, exponent) + complexMult(h0.zw, vec2<f32>(exponent.x, -exponent.y));
    let ih = vec2<f32>(-h.y, h.x);

    let displacementX = ih * wave.x * wave.y;
    let displacementY = h;
    let displacementZ = ih * wave.z * wave.y;

    let displacementX_dx = -h * wave.x * wave.x * wave.y;
    let displacementY_dx = ih * wave.x;
    let displacementZ_dx = -h * wave.x * wave.z * wave.y;

    let displacementY_dz = ih * wave.z;
    let displacementZ_dz = -h * wave.z * wave.z * wave.y;

    textureStore(DxDz,   iid.xy, vec4<f32>(displacementX.x - displacementZ.y, displacementX.y + displacementZ.x, 0., 0.));
    textureStore(DyDxz,  iid.xy, vec4<f32>(displacementY.x - displacementZ_dx.y, displacementY.y + displacementZ_dx.x, 0., 0.));
    textureStore(DyxDyz, iid.xy, vec4<f32>(displacementY_dx.x - displacementY_dz.y, displacementY_dx.y + displacementY_dz.x, 0., 0.));
    textureStore(DxxDzz, iid.xy, vec4<f32>(displacementX_dx.x - displacementZ_dz.y, displacementX_dx.y + displacementZ_dz.x, 0., 0.));
}
`;

// ── FFT: precompute twiddle factors + butterfly input indices ──
export const FFT_PRECOMPUTE_WGSL = /* wgsl */ `
const PI: f32 = 3.1415926;

@group(0) @binding(0) var PrecomputeBuffer : texture_storage_2d<rgba32float, write>;

struct Params {
    Step : i32,
    Size : i32,
};

@group(0) @binding(1) var<uniform> params : Params;

fn complexExp(a: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(cos(a.y), sin(a.y)) * exp(a.x);
}

@compute @workgroup_size(1,8,1)
fn precomputeTwiddleFactorsAndInputIndices(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);
    let b = params.Size >> (id.x + 1u);
    let mult = 2.0 * PI * vec2<f32>(0.0, -1.0) / f32(params.Size);
    let i = (2 * b * (iid.y / b) + (iid.y % b)) % params.Size;
    let twiddle = complexExp(mult * vec2<f32>(f32((iid.y / b) * b)));

    textureStore(PrecomputeBuffer, iid.xy, vec4<f32>(twiddle.x, twiddle.y, f32(i), f32(i + b)));
    textureStore(PrecomputeBuffer, vec2<i32>(iid.x, iid.y + params.Size / 2), vec4<f32>(-twiddle.x, -twiddle.y, f32(i), f32(i + b)));
}
`;

// ── FFT: horizontal butterfly pass ──
export const FFT_HORIZONTAL_WGSL = /* wgsl */ `
struct Params {
    Step : i32,
    Size : i32,
};

@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(3) var PrecomputedData : texture_2d<f32>;
@group(0) @binding(5) var InputBuffer : texture_2d<f32>;
@group(0) @binding(6) var OutputBuffer : texture_storage_2d<rg32float, write>;

fn complexMult(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.r * b.r - a.g * b.g, a.r * b.g + a.g * b.r);
}

@compute @workgroup_size(8,8,1)
fn horizontalStepInverseFFT(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);
    let data = textureLoad(PrecomputedData, vec2<i32>(params.Step, iid.x), 0);
    let inputsIndices = vec2<i32>(data.ba);

    let input0 = textureLoad(InputBuffer, vec2<i32>(inputsIndices.x, iid.y), 0);
    let input1 = textureLoad(InputBuffer, vec2<i32>(inputsIndices.y, iid.y), 0);

    textureStore(OutputBuffer, iid.xy, vec4<f32>(
        input0.xy + complexMult(vec2<f32>(data.r, -data.g), input1.xy), 0., 0.
    ));
}
`;

// ── FFT: vertical butterfly pass ──
export const FFT_VERTICAL_WGSL = /* wgsl */ `
struct Params {
    Step : i32,
    Size : i32,
};

@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(3) var PrecomputedData : texture_2d<f32>;
@group(0) @binding(5) var InputBuffer : texture_2d<f32>;
@group(0) @binding(6) var OutputBuffer : texture_storage_2d<rg32float, write>;

fn complexMult(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.r * b.r - a.g * b.g, a.r * b.g + a.g * b.r);
}

@compute @workgroup_size(8,8,1)
fn verticalStepInverseFFT(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);
    let data = textureLoad(PrecomputedData, vec2<i32>(params.Step, iid.y), 0);
    let inputsIndices = vec2<i32>(data.ba);

    let input0 = textureLoad(InputBuffer, vec2<i32>(iid.x, inputsIndices.x), 0);
    let input1 = textureLoad(InputBuffer, vec2<i32>(iid.x, inputsIndices.y), 0);

    textureStore(OutputBuffer, iid.xy, vec4<f32>(
        input0.xy + complexMult(vec2<f32>(data.r, -data.g), input1.xy), 0., 0.
    ));
}
`;

// ── FFT: final permutation (sign flip checkerboard) ──
export const FFT_PERMUTE_WGSL = /* wgsl */ `
@group(0) @binding(5) var InputBuffer : texture_2d<f32>;
@group(0) @binding(6) var OutputBuffer : texture_storage_2d<rg32float, write>;

@compute @workgroup_size(8,8,1)
fn permute(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);
    let input = textureLoad(InputBuffer, iid.xy, 0);
    textureStore(OutputBuffer, iid.xy, input * (1.0 - 2.0 * f32((iid.x + iid.y) % 2)));
}
`;

// ── Merge the 4 IFFTed spectra into displacement + derivatives + turbulence(foam) ──
export const WAVES_MERGER_WGSL = /* wgsl */ `
struct Params {
    Lambda : f32,
    DeltaTime : f32,
};

@group(0) @binding(0) var<uniform> params : Params;

@group(0) @binding(1) var Displacement : texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var Derivatives : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var TurbulenceRead : texture_2d<f32>;
@group(0) @binding(4) var TurbulenceWrite : texture_storage_2d<rgba16float, write>;

@group(0) @binding(5) var Dx_Dz : texture_2d<f32>;
@group(0) @binding(6) var Dy_Dxz : texture_2d<f32>;
@group(0) @binding(7) var Dyx_Dyz : texture_2d<f32>;
@group(0) @binding(8) var Dxx_Dzz : texture_2d<f32>;

@compute @workgroup_size(8,8,1)
fn fillResultTextures(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);

    let DxDz = textureLoad(Dx_Dz, iid.xy, 0);
    let DyDxz = textureLoad(Dy_Dxz, iid.xy, 0);
    let DyxDyz = textureLoad(Dyx_Dyz, iid.xy, 0);
    let DxxDzz = textureLoad(Dxx_Dzz, iid.xy, 0);

    textureStore(Displacement, iid.xy, vec4<f32>(params.Lambda * DxDz.x, DyDxz.x, params.Lambda * DxDz.y, 0.));
    textureStore(Derivatives, iid.xy, vec4<f32>(DyxDyz.x, DyxDyz.y, DxxDzz.x * params.Lambda, DxxDzz.y * params.Lambda));

    let jacobian = (1.0 + params.Lambda * DxxDzz.x) * (1.0 + params.Lambda * DxxDzz.y) - params.Lambda * params.Lambda * DyDxz.y * DyDxz.y;

    var turbulence = textureLoad(TurbulenceRead, iid.xy, 0).r + params.DeltaTime * 0.5 / max(jacobian, 0.5);
    turbulence = min(jacobian, turbulence);

    textureStore(TurbulenceWrite, iid.xy, vec4<f32>(turbulence, turbulence, turbulence, 1.));
}
`;

// ── Copy helpers (storage textures can't be blitted directly) ──
export const COPY_TEXTURE_4_WGSL = /* wgsl */ `
@group(0) @binding(0) var dest : texture_storage_2d<rgba32float, write>;
@group(0) @binding(1) var src : texture_2d<f32>;

struct Params { width : u32, height : u32, };
@group(0) @binding(2) var<uniform> params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    textureStore(dest, vec2<i32>(gid.xy), textureLoad(src, vec2<i32>(gid.xy), 0));
}
`;

export const COPY_TEXTURE_2_WGSL = /* wgsl */ `
@group(0) @binding(0) var dest : texture_storage_2d<rg32float, write>;
@group(0) @binding(1) var src : texture_2d<f32>;

struct Params { width : u32, height : u32, };
@group(0) @binding(2) var<uniform> params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    textureStore(dest, vec2<i32>(gid.xy), textureLoad(src, vec2<i32>(gid.xy), 0));
}
`;
