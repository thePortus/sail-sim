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

  WGPUTextureView displacement() const { return _displacementView; }
  WGPUTextureView derivatives() const { return _derivativesView; }
  WGPUTextureView turbulence() const { return _pingPong ? _turbulence2View : _turbulenceView; }
  float lengthScale() const { return _lengthScale; }

  // Read a few displacement texels back; true if finite and not all-zero.
  bool sanityCheck();

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

  void ifft2d(WGPUComputePassEncoder pass, WGPUTexture input, WGPUTextureView inputView);
  WGPUBindGroup bg(WGPUBindGroupLayout bgl, const std::vector<WGPUBindGroupEntry>& entries);
};
