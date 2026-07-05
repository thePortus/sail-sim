#include "ocean_fft.hpp"
#include "initial_spectrum_wgsl.h"   // INITIAL_SPECTRUM_WGSL (generated)
#include "ocean_fft_wgsl.hpp"        // the rest of the compute kernels
#if defined(WEBGPU_BACKEND_WGPU)
#include <webgpu/wgpu.h>             // wgpuDevicePoll
#endif

#include <cmath>
#include <cstdio>
#include <cstring>
#include <initializer_list>

namespace {

// Bind group layout entry spec. kind: 0=uniform, 1=read-only-storage-buffer,
// 2=write-storage-texture (fmt), 3=sampled texture (unfilterable-float).
struct ESpec { uint32_t binding; int kind; WGPUTextureFormat fmt; };

WGPUBindGroupLayout buildBGL(WGPUDevice d, std::initializer_list<ESpec> specs) {
  std::vector<WGPUBindGroupLayoutEntry> e;
  for (const ESpec& s : specs) {
    WGPUBindGroupLayoutEntry x = {};
    x.binding = s.binding;
    x.visibility = WGPUShaderStage_Compute;
    switch (s.kind) {
      case 0: x.buffer.type = WGPUBufferBindingType_Uniform; break;
      case 1: x.buffer.type = WGPUBufferBindingType_ReadOnlyStorage; break;
      case 2: x.storageTexture.access = WGPUStorageTextureAccess_WriteOnly;
              x.storageTexture.format = s.fmt;
              x.storageTexture.viewDimension = WGPUTextureViewDimension_2D; break;
      case 3: x.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
              x.texture.viewDimension = WGPUTextureViewDimension_2D; break;
    }
    e.push_back(x);
  }
  WGPUBindGroupLayoutDescriptor d2 = {};
  d2.entryCount = (uint32_t)e.size();
  d2.entries = e.data();
  return wgpuDeviceCreateBindGroupLayout(d, &d2);
}

WGPUComputePipeline makeComputePipeline(WGPUDevice d, const char* code, const char* entry, WGPUBindGroupLayout bgl) {
  WGPUShaderModuleWGSLDescriptor wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderModuleWGSLDescriptor;
  wgsl.code = code;
  WGPUShaderModuleDescriptor smd = {};
  smd.nextInChain = &wgsl.chain;
  WGPUShaderModule mod = wgpuDeviceCreateShaderModule(d, &smd);
  WGPUPipelineLayoutDescriptor pld = {};
  pld.bindGroupLayoutCount = 1; pld.bindGroupLayouts = &bgl;
  WGPUPipelineLayout pl = wgpuDeviceCreatePipelineLayout(d, &pld);
  WGPUComputePipelineDescriptor cpd = {};
  cpd.compute.module = mod;
  cpd.compute.entryPoint = entry;
  cpd.layout = pl;
  WGPUComputePipeline p = wgpuDeviceCreateComputePipeline(d, &cpd);
  wgpuPipelineLayoutRelease(pl);
  wgpuShaderModuleRelease(mod);
  return p;
}

WGPUTexture makeTex(WGPUDevice d, WGPUTextureFormat fmt, uint32_t w, uint32_t h, bool storage) {
  WGPUTextureDescriptor td = {};
  td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopySrc | WGPUTextureUsage_CopyDst;
  if (storage) td.usage |= WGPUTextureUsage_StorageBinding;
  td.dimension = WGPUTextureDimension_2D;
  td.size = { w, h, 1 };
  td.format = fmt;
  td.mipLevelCount = 1;
  td.sampleCount = 1;
  return wgpuDeviceCreateTexture(d, &td);
}

WGPUBuffer makeBuffer(WGPUDevice d, uint64_t size, WGPUBufferUsageFlags usage) {
  WGPUBufferDescriptor bd = {};
  bd.size = size; bd.usage = usage;
  return wgpuDeviceCreateBuffer(d, &bd);
}

WGPUBindGroupEntry texE(uint32_t binding, WGPUTextureView v) {
  WGPUBindGroupEntry e = {}; e.binding = binding; e.textureView = v; return e;
}
WGPUBindGroupEntry bufE(uint32_t binding, WGPUBuffer b, uint64_t size) {
  WGPUBindGroupEntry e = {}; e.binding = binding; e.buffer = b; e.size = size; return e;
}

float jonswapAlpha(float g, float fetch, float ws) { return 0.076f * std::pow((g * fetch) / (ws * ws), -0.22f); }
float jonswapPeak(float g, float fetch, float ws)  { return 22.0f * std::pow((ws * fetch) / (g * g), -0.33f); }

constexpr WGPUTextureFormat RG32F   = WGPUTextureFormat_RG32Float;
constexpr WGPUTextureFormat RGBA32F = WGPUTextureFormat_RGBA32Float;
constexpr WGPUTextureFormat RGBA16F = WGPUTextureFormat_RGBA16Float;

} // namespace

WGPUBindGroup OceanFFT::bg(WGPUBindGroupLayout bgl, const std::vector<WGPUBindGroupEntry>& entries) {
  WGPUBindGroupDescriptor d = {};
  d.layout = bgl;
  d.entryCount = entries.size();
  d.entries = entries.data();
  WGPUBindGroup g = wgpuDeviceCreateBindGroup(_device, &d);
  _transient.push_back(g);
  return g;
}

OceanFFT::OceanFFT(WGPUDevice device, WGPUQueue queue, uint32_t size, float lengthScale,
                   float cutoffLow, float cutoffHigh)
    : _device(device), _queue(queue), _size(size), _lengthScale(lengthScale) {
  _logSize = (uint32_t)std::log2((double)size);

  auto pipe = [&](const char* code, const char* entry, WGPUBindGroupLayout bgl) {
    return Pipe{ makeComputePipeline(device, code, entry, bgl), bgl };
  };
  // Bindings mirror the WGSL exactly. Sampled r/rg/rgba32f textures are
  // unfilterable-float (textureLoad only); storage textures carry their format.
  _initial = pipe(INITIAL_SPECTRUM_WGSL, "calculateInitialSpectrum", buildBGL(device, {
    {1,2,RGBA32F},{2,2,RG32F},{4,3,RG32F},{5,0,RGBA32F},{6,1,RGBA32F} }));
  _conjugate = pipe(CONJUGATE_SPECTRUM_WGSL, "calculateConjugatedSpectrum", buildBGL(device, {
    {0,2,RGBA32F},{5,0,RGBA32F},{8,3,RG32F} }));
  _timeDep = pipe(TIME_DEPENDENT_SPECTRUM_WGSL, "calculateAmplitudes", buildBGL(device, {
    {1,3,RGBA32F},{3,3,RGBA32F},{4,0,RGBA32F},{5,2,RG32F},{6,2,RG32F},{7,2,RG32F},{8,2,RG32F} }));
  _precompute = pipe(FFT_PRECOMPUTE_WGSL, "precomputeTwiddleFactorsAndInputIndices", buildBGL(device, {
    {0,2,RGBA32F},{1,0,RGBA32F} }));
  _horizontal = pipe(FFT_HORIZONTAL_WGSL, "horizontalStepInverseFFT", buildBGL(device, {
    {1,0,RGBA32F},{3,3,RGBA32F},{5,3,RG32F},{6,2,RG32F} }));
  _vertical = pipe(FFT_VERTICAL_WGSL, "verticalStepInverseFFT", buildBGL(device, {
    {1,0,RGBA32F},{3,3,RGBA32F},{5,3,RG32F},{6,2,RG32F} }));
  _permute = pipe(FFT_PERMUTE_WGSL, "permute", buildBGL(device, {
    {5,3,RG32F},{6,2,RG32F} }));
  _merger = pipe(WAVES_MERGER_WGSL, "fillResultTextures", buildBGL(device, {
    {0,0,RGBA32F},{1,2,RGBA16F},{2,2,RGBA16F},{3,3,RGBA16F},{4,2,RGBA16F},
    {5,3,RG32F},{6,3,RG32F},{7,3,RG32F},{8,3,RG32F} }));
  _copy2 = pipe(COPY_TEXTURE_2_WGSL, "main", buildBGL(device, {
    {0,2,RG32F},{1,3,RG32F},{2,0,RGBA32F} }));

  // textures
  _noise        = makeTex(device, RG32F, size, size, false);
  _wavesData    = makeTex(device, RGBA32F, size, size, true);
  _h0k          = makeTex(device, RG32F, size, size, true);
  _h0           = makeTex(device, RGBA32F, size, size, true);
  _twiddle      = makeTex(device, RGBA32F, _logSize, size, true);
  _DxDz         = makeTex(device, RG32F, size, size, true);
  _DyDxz        = makeTex(device, RG32F, size, size, true);
  _DyxDyz       = makeTex(device, RG32F, size, size, true);
  _DxxDzz       = makeTex(device, RG32F, size, size, true);
  _buffer       = makeTex(device, RG32F, size, size, true);
  _displacement = makeTex(device, RGBA16F, size, size, true);
  _derivatives  = makeTex(device, RGBA16F, size, size, true);
  _turbulence   = makeTex(device, RGBA16F, size, size, true);
  _turbulence2  = makeTex(device, RGBA16F, size, size, true);

  auto view = [&](WGPUTexture t) { return wgpuTextureCreateView(t, nullptr); };
  _noiseView = view(_noise); _wavesDataView = view(_wavesData); _h0kView = view(_h0k);
  _h0View = view(_h0); _twiddleView = view(_twiddle);
  _DxDzView = view(_DxDz); _DyDxzView = view(_DyDxz); _DyxDyzView = view(_DyxDyz);
  _DxxDzzView = view(_DxxDzz); _bufferView = view(_buffer);
  _displacementView = view(_displacement); _derivativesView = view(_derivatives);
  _turbulenceView = view(_turbulence); _turbulence2View = view(_turbulence2);

  // buffers
  _params       = makeBuffer(device, 32, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
  _spectrum     = makeBuffer(device, 64, WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
  _timeParams   = makeBuffer(device, 16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
  _mergerParams = makeBuffer(device, 16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
  _copyParams   = makeBuffer(device, 16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
  for (uint32_t i = 0; i < _logSize; ++i) {
    WGPUBuffer b = makeBuffer(device, 16, WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    struct { int32_t step, size; } sp{ (int32_t)i, (int32_t)size };
    wgpuQueueWriteBuffer(queue, b, 0, &sp, sizeof(sp));
    _stepParams.push_back(b);
  }

  // gaussian (Box-Muller) RG noise, matching the client
  {
    std::vector<float> noise((size_t)size * size * 2);
    uint32_t s = 0x12345u;
    auto rnd = [&]() { s = s * 1664525u + 1013904223u; return (float)((s >> 8) & 0xFFFFFF) / (float)0xFFFFFF; };
    for (size_t i = 0; i < (size_t)size * size; ++i) {
      float u1 = rnd(), u2 = rnd();
      noise[i * 2 + 0] = std::cos(6.2831853f * u1) * std::sqrt(-2.0f * std::log(u2 + 1e-9f));
      noise[i * 2 + 1] = std::sin(6.2831853f * u2) * std::sqrt(-2.0f * std::log(u1 + 1e-9f));
    }
    WGPUImageCopyTexture dst = {}; dst.texture = _noise; dst.aspect = WGPUTextureAspect_All;
    WGPUTextureDataLayout layout = {}; layout.bytesPerRow = size * 8; layout.rowsPerImage = size;
    WGPUExtent3D ext = { size, size, 1 };
    wgpuQueueWriteTexture(queue, &dst, noise.data(), noise.size() * sizeof(float), &layout, &ext);
  }

  // params + JONSWAP spectrum (single cascade: length 250, wide cutoff band)
  struct { uint32_t Size; float LengthScale, CutoffHigh, CutoffLow, Gravity, Depth; } P{
    size, lengthScale, cutoffHigh, cutoffLow, 9.81f, 500.0f };
  wgpuQueueWriteBuffer(queue, _params, 0, &P, sizeof(P));

  const float g = 9.81f;
  auto fillSpectrum = [&](float* out, float scale, float windDirDeg, float windSpeed, float fetch, float swell) {
    out[0] = scale;
    out[1] = windDirDeg / 180.0f * 3.14159265f;         // angle
    out[2] = 1.0f;                                       // spreadBlend
    out[3] = std::fmax(0.01f, std::fmin(1.0f, swell));   // swell
    out[4] = jonswapAlpha(g, fetch, windSpeed);          // alpha
    out[5] = jonswapPeak(g, fetch, windSpeed);           // peakOmega
    out[6] = 3.3f;                                        // gamma
    out[7] = 0.01f;                                       // shortWavesFade
  };
  float spectra[16];
  fillSpectrum(&spectra[0], 0.5f, -29.81f, 5.0f, 100000.0f, 0.198f);  // local wind sea
  fillSpectrum(&spectra[8], 0.5f,  90.0f,  5.0f, 300000.0f, 1.0f);    // swell
  wgpuQueueWriteBuffer(queue, _spectrum, 0, spectra, sizeof(spectra));

  struct { uint32_t w, h; } cp{ size, size };
  wgpuQueueWriteBuffer(queue, _copyParams, 0, &cp, sizeof(cp));
}

void OceanFFT::initSpectrum() {
  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(_device, nullptr);
  WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(enc, nullptr);
  const uint32_t g = _size / 8;

  // initial spectrum: 1=WavesData(w), 2=H0K(w), 4=Noise, 5=params, 6=spectrum
  wgpuComputePassEncoderSetPipeline(pass, _initial.pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_initial.bgl, {
    texE(1, _wavesDataView), texE(2, _h0kView), texE(4, _noiseView),
    bufE(5, _params, 32), bufE(6, _spectrum, 64) }), 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);

  // conjugate: 0=H0(w), 5=params, 8=H0K
  wgpuComputePassEncoderSetPipeline(pass, _conjugate.pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_conjugate.bgl, {
    texE(0, _h0View), bufE(5, _params, 32), texE(8, _h0kView) }), 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);

  // twiddle precompute: 0=PrecomputeBuffer(w), 1=params(step0). workgroup (1,8,1).
  wgpuComputePassEncoderSetPipeline(pass, _precompute.pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_precompute.bgl, {
    texE(0, _twiddleView), bufE(1, _stepParams[0], 16) }), 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass, _logSize, _size / 2 / 8, 1);

  wgpuComputePassEncoderEnd(pass);
  wgpuComputePassEncoderRelease(pass);
  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuQueueSubmit(_queue, 1, &cmd);
  wgpuCommandBufferRelease(cmd);
  wgpuCommandEncoderRelease(enc);

  for (WGPUBindGroup b : _transient) wgpuBindGroupRelease(b);
  _transient.clear();
}

// In-place inverse FFT of `input` (RG), using _buffer as ping-pong scratch.
void OceanFFT::ifft2d(WGPUComputePassEncoder pass, WGPUTexture input, WGPUTextureView inputView) {
  const uint32_t g = _size / 8;
  bool pp = false;

  for (uint32_t i = 0; i < _logSize; ++i) {
    pp = !pp;
    WGPUTextureView inV  = pp ? inputView : _bufferView;
    WGPUTextureView outV = pp ? _bufferView : inputView;
    wgpuComputePassEncoderSetPipeline(pass, _horizontal.pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_horizontal.bgl, {
      bufE(1, _stepParams[i], 16), texE(3, _twiddleView), texE(5, inV), texE(6, outV) }), 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);
  }
  for (uint32_t i = 0; i < _logSize; ++i) {
    pp = !pp;
    WGPUTextureView inV  = pp ? inputView : _bufferView;
    WGPUTextureView outV = pp ? _bufferView : inputView;
    wgpuComputePassEncoderSetPipeline(pass, _vertical.pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_vertical.bgl, {
      bufE(1, _stepParams[i], 16), texE(3, _twiddleView), texE(5, inV), texE(6, outV) }), 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);
  }

  auto copyToInput = [&](WGPUTextureView srcSampled) {   // copy src -> input (storage)
    wgpuComputePassEncoderSetPipeline(pass, _copy2.pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_copy2.bgl, {
      texE(0, inputView), texE(1, srcSampled), bufE(2, _copyParams, 16) }), 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);
  };

  if (pp) copyToInput(_bufferView);   // (never true for power-of-two logSize, kept for fidelity)

  // permute: In=input, Out=buffer
  wgpuComputePassEncoderSetPipeline(pass, _permute.pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_permute.bgl, {
    texE(5, inputView), texE(6, _bufferView) }), 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);

  copyToInput(_bufferView);   // buffer -> input
}

// Live weather -> JONSWAP respectrum: exact port of the client's
// ocean-fft-engine updateWeather(). The wave field emerges from the physics:
// stronger wind = larger, sharper, wind-aligned seas; choppier conditions =
// pointier crests (lambda) + more foam. Weather formulas (choppiness/beaufort)
// mirror weather.service buildWeather().
void OceanFFT::updateWeather(float windKnots, float fromBearingDeg) {
  const float g = 9.81f;
  const float pi = 3.14159265f;
  float ms  = std::fmax(0.5f, windKnots * 0.5144f);        // knots -> m/s (JONSWAP needs >0)
  // Crests run DOWNWIND when the spectrum angle = 90 - bearing (the field samples
  // the FFT by world XZ and propagates along -k; raw bearing would be 90 deg off).
  float dir = 90.0f - fromBearingDeg;
  float chop = std::fmax(0.05f, std::fmin(1.0f, 0.05f + 0.95f * (windKnots / 24.0f)));
  float beaufortT = std::fmin(12.0f, std::floor(windKnots / 2.5f)) / 12.0f;

  float spectra[16];
  // Wind-driven local sea (the dominant, locally-generated chop + waves).
  spectra[0] = 0.5f;                                       // scale
  spectra[1] = dir / 180.0f * pi;                          // angle
  spectra[2] = 1.0f;                                       // spreadBlend
  spectra[3] = 0.198f;                                     // swell (WavesSettings default)
  spectra[4] = jonswapAlpha(g, 100000.0f, ms);
  spectra[5] = jonswapPeak(g, 100000.0f, ms);
  spectra[6] = 2.0f + 1.6f * beaufortT;                    // storms sharpen the spectral peak
  spectra[7] = 0.03f - 0.025f * chop;                      // rougher seas keep more fine chop
  // Long-period swell — slightly off the wind axis, grows with the sea state.
  float sws = ms * 0.85f + 1.0f;
  spectra[8]  = 0.2f + 0.4f * beaufortT;
  spectra[9]  = (dir + 25.0f) / 180.0f * pi;
  spectra[10] = 1.0f;
  spectra[11] = 1.0f;
  spectra[12] = jonswapAlpha(g, 300000.0f, sws);
  spectra[13] = jonswapPeak(g, 300000.0f, sws);
  spectra[14] = 3.3f;
  spectra[15] = 0.01f;
  wgpuQueueWriteBuffer(_queue, _spectrum, 0, spectra, sizeof(spectra));
  // Horizontal displacement (choppiness): pointier, breaking crests as it builds.
  _lambda = 0.7f + 0.6f * chop;
  initSpectrum();
}

void OceanFFT::update(float time, float deltaTime) {
  const uint32_t g = _size / 8;
  float dt = deltaTime > 0.5f ? 0.5f : deltaTime;

  wgpuQueueWriteBuffer(_queue, _timeParams, 0, &time, sizeof(float));
  struct { float lambda, dt; } mp{ _lambda, dt };
  wgpuQueueWriteBuffer(_queue, _mergerParams, 0, &mp, sizeof(mp));

  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(_device, nullptr);
  WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(enc, nullptr);

  // time-dependent spectrum: 1=H0, 3=WavesData, 4=params(Time), 5..8 = D* (w)
  wgpuComputePassEncoderSetPipeline(pass, _timeDep.pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_timeDep.bgl, {
    texE(1, _h0View), texE(3, _wavesDataView), bufE(4, _timeParams, 16),
    texE(5, _DxDzView), texE(6, _DyDxzView), texE(7, _DyxDyzView), texE(8, _DxxDzzView) }), 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);

  ifft2d(pass, _DxDz, _DxDzView);
  ifft2d(pass, _DyDxz, _DyDxzView);
  ifft2d(pass, _DyxDyz, _DyxDyzView);
  ifft2d(pass, _DxxDzz, _DxxDzzView);

  // merge -> displacement / derivatives / turbulence (ping-pong)
  _pingPong = !_pingPong;
  WGPUTextureView turbRead  = _pingPong ? _turbulenceView : _turbulence2View;
  WGPUTextureView turbWrite = _pingPong ? _turbulence2View : _turbulenceView;
  wgpuComputePassEncoderSetPipeline(pass, _merger.pipeline);
  wgpuComputePassEncoderSetBindGroup(pass, 0, bg(_merger.bgl, {
    bufE(0, _mergerParams, 16), texE(1, _displacementView), texE(2, _derivativesView),
    texE(3, turbRead), texE(4, turbWrite),
    texE(5, _DxDzView), texE(6, _DyDxzView), texE(7, _DyxDyzView), texE(8, _DxxDzzView) }), 0, nullptr);
  wgpuComputePassEncoderDispatchWorkgroups(pass, g, g, 1);

  wgpuComputePassEncoderEnd(pass);
  wgpuComputePassEncoderRelease(pass);
  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuQueueSubmit(_queue, 1, &cmd);
  wgpuCommandBufferRelease(cmd);
  wgpuCommandEncoderRelease(enc);

  for (WGPUBindGroup b : _transient) wgpuBindGroupRelease(b);
  _transient.clear();
}

bool OceanFFT::sanityCheck() {
  const size_t bytes = (size_t)_size * _size * 8;   // rgba16float
  WGPUBuffer rb = makeBuffer(_device, bytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
  WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(_device, nullptr);
  WGPUImageCopyTexture src = {}; src.texture = _displacement; src.aspect = WGPUTextureAspect_All;
  WGPUImageCopyBuffer dst = {}; dst.buffer = rb; dst.layout.bytesPerRow = _size * 8; dst.layout.rowsPerImage = _size;
  WGPUExtent3D ext = { _size, _size, 1 };
  wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &ext);
  WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
  wgpuQueueSubmit(_queue, 1, &cmd);
  wgpuCommandBufferRelease(cmd);
  wgpuCommandEncoderRelease(enc);

  struct S { bool done; } st{ false };
  wgpuBufferMapAsync(rb, WGPUMapMode_Read, 0, bytes,
    [](WGPUBufferMapAsyncStatus, void* ud) { ((S*)ud)->done = true; }, &st);
  while (!st.done) {
#if defined(WEBGPU_BACKEND_WGPU)
    wgpuDevicePoll(_device, true, nullptr);
#endif
  }
  const uint8_t* p = (const uint8_t*)wgpuBufferGetConstMappedRange(rb, 0, bytes);
  bool nonZero = false;
  for (size_t i = 0; i < bytes && !nonZero; ++i) if (p[i] != 0) nonZero = true;
  wgpuBufferUnmap(rb);
  wgpuBufferRelease(rb);
  std::printf("[ocean-fft] displacement sanity: %s\n", nonZero ? "non-zero (waves present)" : "ALL ZERO");
  return nonZero;
}

// IEEE half -> float, for decoding the rgba16float displacement on the CPU.
static float halfToFloat(uint16_t h) {
  uint32_t sign = (uint32_t)(h & 0x8000u) << 16;
  uint32_t exp  = (h >> 10) & 0x1Fu;
  uint32_t mant = h & 0x3FFu;
  uint32_t f;
  if (exp == 0) {
    if (mant == 0) { f = sign; }                       // +/- zero
    else {                                             // subnormal -> normalize
      exp = 1;
      while ((mant & 0x400u) == 0) { mant <<= 1; exp--; }
      mant &= 0x3FFu;
      f = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
  } else if (exp == 0x1F) {                            // inf / nan
    f = sign | 0x7F800000u | (mant << 13);
  } else {                                             // normal
    f = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  }
  float out; std::memcpy(&out, &f, 4); return out;
}

void OceanFFT::readbackDisplacement() {
  const size_t bytes = (size_t)_size * _size * 8;   // rgba16float
  if (!_readback)
    _readback = makeBuffer(_device, bytes, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);

  // 1. If a copy is in flight, advance the map without blocking; when it's ready,
  //    decode it (this is last frame's displacement — 1 frame is invisible here).
  if (_rbBusy) {
#if defined(WEBGPU_BACKEND_WGPU)
    wgpuDevicePoll(_device, false, nullptr);   // NON-blocking: just pump callbacks
#endif
    if (_rbReady) {
      const uint16_t* p = (const uint16_t*)wgpuBufferGetConstMappedRange(_readback, 0, bytes);
      const size_t n = (size_t)_size * _size * 4;
      if (_dispCPU.size() != n) _dispCPU.resize(n);
      if (p) for (size_t i = 0; i < n; ++i) _dispCPU[i] = halfToFloat(p[i]);
      wgpuBufferUnmap(_readback);
      _rbBusy = false; _rbReady = false;
    }
  }
  // 2. If idle, kick off the next copy + async map (no wait). It's read next frame.
  if (!_rbBusy) {
    WGPUCommandEncoder enc = wgpuDeviceCreateCommandEncoder(_device, nullptr);
    WGPUImageCopyTexture src = {}; src.texture = _displacement; src.aspect = WGPUTextureAspect_All;
    WGPUImageCopyBuffer dst = {}; dst.buffer = _readback;
    dst.layout.bytesPerRow = _size * 8; dst.layout.rowsPerImage = _size;
    WGPUExtent3D ext = { _size, _size, 1 };
    wgpuCommandEncoderCopyTextureToBuffer(enc, &src, &dst, &ext);
    WGPUCommandBuffer cmd = wgpuCommandEncoderFinish(enc, nullptr);
    wgpuQueueSubmit(_queue, 1, &cmd);
    wgpuCommandBufferRelease(cmd);
    wgpuCommandEncoderRelease(enc);
    _rbBusy = true; _rbReady = false;
    wgpuBufferMapAsync(_readback, WGPUMapMode_Read, 0, bytes,
      [](WGPUBufferMapAsyncStatus s, void* ud) { if (s == WGPUBufferMapAsyncStatus_Success) *(volatile bool*)ud = true; },
      (void*)&_rbReady);
  }
}

void OceanFFT::sampleDisplacement(float worldX, float worldZ, float& dx, float& dy, float& dz) const {
  dx = dy = dz = 0.0f;
  if (_dispCPU.empty()) return;
  const int S = (int)_size;
  // World -> tile UV (the tile repeats), then to a texel-centre coordinate.
  float u = worldX / _lengthScale, v = worldZ / _lengthScale;
  u -= std::floor(u); v -= std::floor(v);
  float fx = u * S - 0.5f, fz = v * S - 0.5f;
  int x0 = (int)std::floor(fx), z0 = (int)std::floor(fz);
  float tx = fx - (float)x0, tz = fz - (float)z0;
  auto texel = [&](int x, int z, int c) -> float {
    x = ((x % S) + S) % S; z = ((z % S) + S) % S;     // wrap (tile is periodic)
    return _dispCPU[((size_t)z * S + x) * 4 + (size_t)c];
  };
  float out[3];
  for (int c = 0; c < 3; ++c) {
    float a = texel(x0, z0, c)     * (1.0f - tx) + texel(x0 + 1, z0, c)     * tx;
    float b = texel(x0, z0 + 1, c) * (1.0f - tx) + texel(x0 + 1, z0 + 1, c) * tx;
    out[c] = a * (1.0f - tz) + b * tz;
  }
  dx = out[0]; dy = out[1]; dz = out[2];
}
