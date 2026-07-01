// FFT-ocean compute kernels, copied VERBATIM from the browser client
//   ../../client/src/app/sailing/services/ocean-fft/wgsl.ts
// (initial spectrum is reused from the generated initial_spectrum_wgsl.h.)
// Keep in sync with the client. Original authors: gasgiant FFT-Ocean via Popov72.
#pragma once

inline const char* CONJUGATE_SPECTRUM_WGSL = R"WGSL(
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
)WGSL";

inline const char* TIME_DEPENDENT_SPECTRUM_WGSL = R"WGSL(
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
)WGSL";

inline const char* FFT_PRECOMPUTE_WGSL = R"WGSL(
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
)WGSL";

inline const char* FFT_HORIZONTAL_WGSL = R"WGSL(
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
)WGSL";

inline const char* FFT_VERTICAL_WGSL = R"WGSL(
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
)WGSL";

inline const char* FFT_PERMUTE_WGSL = R"WGSL(
@group(0) @binding(5) var InputBuffer : texture_2d<f32>;
@group(0) @binding(6) var OutputBuffer : texture_storage_2d<rg32float, write>;

@compute @workgroup_size(8,8,1)
fn permute(@builtin(global_invocation_id) id : vec3<u32>) {
    let iid = vec3<i32>(id);
    let input = textureLoad(InputBuffer, iid.xy, 0);
    textureStore(OutputBuffer, iid.xy, input * (1.0 - 2.0 * f32((iid.x + iid.y) % 2)));
}
)WGSL";

inline const char* WAVES_MERGER_WGSL = R"WGSL(
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
)WGSL";

inline const char* COPY_TEXTURE_2_WGSL = R"WGSL(
@group(0) @binding(0) var dest : texture_storage_2d<rg32float, write>;
@group(0) @binding(1) var src : texture_2d<f32>;

struct Params { width : u32, height : u32, };
@group(0) @binding(2) var<uniform> params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    textureStore(dest, vec2<i32>(gid.xy), textureLoad(src, vec2<i32>(gid.xy), 0));
}
)WGSL";
