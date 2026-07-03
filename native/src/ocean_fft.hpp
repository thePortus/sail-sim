// One cascade of the FFT ocean: JONSWAP spectrum -> conjugate -> per-frame time
// evolution -> 4x inverse FFT -> merge into displacement / derivatives /
// turbulence(foam) textures for the ocean surface to sample. Ported from the
// client's ocean-fft/ services. Single cascade for now (multi-cascade = follow-up).
#pragma once
#include <webgpu/webgpu.h>
#include <cstdint>
#include <vector>

class OceanFFT {
public:
  OceanFFT(WGPUDevice device, WGPUQueue queue, uint32_t size, float lengthScale,
           float cutoffLow, float cutoffHigh);

  void initSpectrum();                       // once (spectrum + conjugate + twiddles)
  void update(float time, float deltaTime);  // per frame (evolve + IFFT + merge)

  // Live weather -> JONSWAP respectrum (client updateWeather port): the wave
  // field emerges from the physics — stronger wind = larger, sharper,
  // wind-aligned seas; choppier = pointier crests (lambda) + more foam.
  // Rebuilds the initial spectrum, so call it throttled (the client: >0.3 m/s
  // or >2 deg change, at most ~every 400 ms).
  void updateWeather(float windKnots, float fromBearingDeg);

  WGPUTextureView displacement() const { return _displacementView; }
  WGPUTextureView derivatives() const { return _derivativesView; }
  WGPUTextureView turbulence() const { return _pingPong ? _turbulence2View : _turbulenceView; }
  float lengthScale() const { return _lengthScale; }

  // Read a few displacement texels back; true if finite and not all-zero.
  bool sanityCheck();

  // CPU-side buoyancy: copy this cascade's displacement texture back and bilinearly
  // sample the wave-displacement vector at a world (x,z). readbackDisplacement() must
  // run after update() each frame it's needed; sampleDisplacement() reads the cache.
  void readbackDisplacement();
  void sampleDisplacement(float worldX, float worldZ, float& dx, float& dy, float& dz) const;

private:
  WGPUDevice _device;
  WGPUQueue  _queue;
  uint32_t   _size;
  uint32_t   _logSize;
  float      _lengthScale;
  bool       _pingPong = false;

  // pipelines (auto-layout) + their bind group layouts
  struct Pipe { WGPUComputePipeline pipeline; WGPUBindGroupLayout bgl; };
  Pipe _initial, _conjugate, _timeDep, _precompute, _horizontal, _vertical, _permute, _merger, _copy2;

  // textures + views
  WGPUTexture _noise, _wavesData, _h0k, _h0, _twiddle;
  WGPUTexture _DxDz, _DyDxz, _DyxDyz, _DxxDzz, _buffer;
  WGPUTexture _displacement, _derivatives, _turbulence, _turbulence2;
  WGPUTextureView _wavesDataView, _h0kView, _h0View, _twiddleView;
  WGPUTextureView _DxDzView, _DyDxzView, _DyxDyzView, _DxxDzzView, _bufferView, _noiseView;
  WGPUTextureView _displacementView, _derivativesView, _turbulenceView, _turbulence2View;

  // uniform / storage buffers
  WGPUBuffer _params;          // Size + LengthScale + cutoffs + g + depth
  WGPUBuffer _spectrum;        // storage: 2 SpectrumParameter
  WGPUBuffer _timeParams;      // Time
  WGPUBuffer _mergerParams;    // Lambda, DeltaTime
  WGPUBuffer _copyParams;      // width, height
  std::vector<WGPUBuffer> _stepParams;   // {Step, Size} per butterfly stage
  float _lambda = 1.0f;

  // transient bind groups created during a frame; released after submit
  std::vector<WGPUBindGroup> _transient;

  // persistent displacement readback for CPU buoyancy
  WGPUBuffer _readback = nullptr;
  std::vector<float> _dispCPU;   // _size*_size*4 floats, decoded from rgba16f

  void ifft2d(WGPUComputePassEncoder pass, WGPUTexture input, WGPUTextureView inputView);
  WGPUBindGroup bg(WGPUBindGroupLayout bgl, const std::vector<WGPUBindGroupEntry>& entries);
};
