// Procedural audio beds — exact ports of the client's WebAudio graphs.
//
// Ocean (ocean-audio.service.ts): two looping noise layers into a shared bed gain:
//   wash: brown noise -> lowpass(480+1500k, Q 0.6) -> swell gain (0.7 base, sine
//         LFO at 0.08+0.13k Hz, depth 0.10+0.32k) -> bed
//   hiss: white noise -> highpass(1600) -> gain k^2*0.16 -> bed
//   bed gain = 0.07 + 0.33k, k = clamp(windSpeed/22)  (gale ~= 22 m/s)
//   All parameter moves smoothed like setTargetAtTime(tc = 0.7 s).
//
// Rain (cloud.service updateRainAmbience): white noise -> highpass(600) ->
//   lowpass(7000) -> gain min(1,intensity)*0.14, smoothed with tc = 0.25 s.
//
// Master = the client's default SFX slider (0.8), overridable via SAILSIM_VOLUME.

#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#include "miniaudio.h"

#include "audio.hpp"

#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <random>
#include <vector>

namespace audio {
namespace {

// RBJ biquad (direct form 1) — the WebAudio BiquadFilterNode's underlying math.
struct Biquad {
  float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  float x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  void lowpass(float sr, float freq, float q) {
    float w = 2.0f * (float)M_PI * freq / sr, cw = std::cos(w), sw = std::sin(w);
    float alpha = sw / (2.0f * q);
    float a0 = 1 + alpha;
    b0 = (1 - cw) * 0.5f / a0; b1 = (1 - cw) / a0; b2 = b0;
    a1 = -2 * cw / a0; a2 = (1 - alpha) / a0;
  }
  void highpass(float sr, float freq, float q) {
    float w = 2.0f * (float)M_PI * freq / sr, cw = std::cos(w), sw = std::sin(w);
    float alpha = sw / (2.0f * q);
    float a0 = 1 + alpha;
    b0 = (1 + cw) * 0.5f / a0; b1 = -(1 + cw) / a0; b2 = b0;
    a1 = -2 * cw / a0; a2 = (1 - alpha) / a0;
  }
  inline float process(float x) {
    float y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  }
};

// One-pole exponential approach — WebAudio's setTargetAtTime(target, t, tc).
struct Smoothed {
  float value = 0, coefPerBlock = 0;
  void configure(float sr, float tc, uint32_t blockSize) {
    coefPerBlock = 1.0f - std::exp(-(float)blockSize / (tc * sr));
  }
  inline void step(float target) { value += (target - value) * coefPerBlock; }
};

constexpr uint32_t kBlock = 64;   // param-smoothing / coefficient-update granularity

// A one-shot thunder event (cloud.service playThunder): white noise through a
// lowpass whose frequency ramps exponentially (300+vol*700 -> 70 Hz) under a
// breakpoint gain envelope — sharp crack + rolling swells + decaying tail. The
// game thread precomputes the breakpoints; the audio thread just interpolates.
struct ThunderDesc {
  static constexpr int kMaxPts = 14;
  float dur = 4.0f, f0 = 600.0f;
  int nPts = 0;
  float pt[kMaxPts];    // breakpoint time (s)
  float pg[kMaxPts];    // breakpoint gain
  bool pe[kMaxPts];     // exponential (vs linear) ramp from the previous point
};

struct ThunderVoice {
  ThunderDesc d;
  Biquad lpf;
  double tau = 0;          // seconds into the event
  uint32_t rng = 1;        // xorshift white-noise state
  bool active = false;
  inline float noise() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (float)(int32_t)rng * (1.0f / 2147483648.0f);
  }
  float envAt(float t) const {
    if (d.nPts == 0 || t <= d.pt[0]) return d.nPts ? d.pg[0] : 0.0f;
    for (int i = 1; i < d.nPts; ++i) {
      if (t <= d.pt[i]) {
        float u = (t - d.pt[i - 1]) / std::max(1e-4f, d.pt[i] - d.pt[i - 1]);
        float g0 = std::max(1e-4f, d.pg[i - 1]), g1 = std::max(1e-4f, d.pg[i]);
        return d.pe[i] ? g0 * std::pow(g1 / g0, u) : g0 + (g1 - g0) * u;
      }
    }
    return d.pg[d.nPts - 1];
  }
};

}  // namespace

struct System::Impl {
  ma_device device{};
  bool started = false;
  float sr = 48000.0f;
  float masterVol = 0.8f;   // client SFX default

  // Looping noise beds (client buffer lengths: brown 3 s, white 2 s, rain 2 s).
  std::vector<float> brown, white, rainNoise;
  size_t bi = 0, wi = 0, ri = 0;

  Biquad washLpf, hissHpf, rainHpf, rainLpf;
  double lfoPhase = 0;

  // Game-thread targets.
  std::atomic<float> tBed{0.07f}, tWashF{480.0f}, tHiss{0.0f};
  std::atomic<float> tSwellDepth{0.10f}, tSwellFreq{0.08f};
  std::atomic<float> tRain{0.0f}, tMaster{0.0f};

  // Audio-thread smoothed params.
  Smoothed sBed, sWashF, sHiss, sSwellDepth, sSwellFreq, sRain, sMaster;
  float lastWashF = -1.0f;

  // Thunder hand-off: game thread fills a free slot then flips it to QUEUED;
  // the audio thread claims QUEUED slots into voices (the state transition
  // orders the descriptor write). Up to 4 overlapping rumbles.
  static constexpr int kThunder = 4;
  ThunderDesc thunderDesc[kThunder];
  std::atomic<int> thunderState[kThunder]{};   // 0 free, 1 queued, 2 playing
  ThunderVoice thunderVoice[kThunder];

  void buildNoise() {
    std::mt19937 rng(1717);
    std::uniform_real_distribution<float> uni(-1.0f, 1.0f);
    // Brown noise: integrated white (the client's leaky integrator).
    brown.resize((size_t)(sr * 3));
    float last = 0;
    for (float& v : brown) { float w = uni(rng); last = (last + 0.02f * w) / 1.02f; v = last * 2.6f; }
    white.resize((size_t)(sr * 2));
    for (float& v : white) v = uni(rng);
    rainNoise.resize((size_t)(sr * 2));
    for (float& v : rainNoise) v = uni(rng);
  }

  void render(float* out, ma_uint32 frames) {
    ma_uint32 done = 0;
    while (done < frames) {
      ma_uint32 n = frames - done;
      if (n > kBlock) n = kBlock;

      // Per-block parameter smoothing + coefficient updates.
      sBed.step(tBed.load(std::memory_order_relaxed));
      sWashF.step(tWashF.load(std::memory_order_relaxed));
      sHiss.step(tHiss.load(std::memory_order_relaxed));
      sSwellDepth.step(tSwellDepth.load(std::memory_order_relaxed));
      sSwellFreq.step(tSwellFreq.load(std::memory_order_relaxed));
      sRain.step(tRain.load(std::memory_order_relaxed));
      sMaster.step(tMaster.load(std::memory_order_relaxed));
      if (std::fabs(sWashF.value - lastWashF) > 1.0f) {
        washLpf.lowpass(sr, sWashF.value, 0.6f);
        lastWashF = sWashF.value;
      }
      const double lfoInc = 2.0 * M_PI * (double)sSwellFreq.value / (double)sr;

      // Claim queued thunder and refresh live voices' block-rate params.
      for (int v = 0; v < kThunder; ++v) {
        int q = 1;
        if (thunderState[v].compare_exchange_strong(q, 2, std::memory_order_acquire)) {
          thunderVoice[v].d = thunderDesc[v];
          thunderVoice[v].tau = 0;
          thunderVoice[v].rng = 0x9e3779b9u + (uint32_t)v * 0x85ebca6bu;
          thunderVoice[v].lpf = Biquad();
          thunderVoice[v].active = true;
        }
        ThunderVoice& tv = thunderVoice[v];
        if (!tv.active) continue;
        if (tv.tau >= tv.d.dur) {
          tv.active = false;
          thunderState[v].store(0, std::memory_order_release);
          continue;
        }
        // Lowpass sweeps exponentially down to 70 Hz — deep, dark rumble.
        float f = tv.d.f0 * std::pow(70.0f / tv.d.f0, (float)(tv.tau / tv.d.dur));
        tv.lpf.lowpass(sr, f, 0.4f);
      }

      for (ma_uint32 i = 0; i < n; ++i) {
        // Wash: brown -> LPF -> swell (0.7 base + LFO*depth) -> bed.
        float wash = washLpf.process(brown[bi]);
        if (++bi >= brown.size()) bi = 0;
        lfoPhase += lfoInc;
        if (lfoPhase > 2.0 * M_PI) lfoPhase -= 2.0 * M_PI;
        wash *= 0.7f + sSwellDepth.value * (float)std::sin(lfoPhase);
        // Hiss: white -> HPF -> gain -> bed.
        float hiss = hissHpf.process(white[wi]) * sHiss.value;
        if (++wi >= white.size()) wi = 0;
        float bed = (wash + hiss) * sBed.value;
        // Rain patter: white -> HPF 600 -> LPF 7000 -> gain.
        float rain = rainLpf.process(rainHpf.process(rainNoise[ri])) * sRain.value;
        if (++ri >= rainNoise.size()) ri = 0;
        // Thunder voices: filtered noise under their breakpoint envelopes.
        float thunder = 0.0f;
        for (int v = 0; v < kThunder; ++v) {
          ThunderVoice& tv = thunderVoice[v];
          if (!tv.active) continue;
          thunder += tv.lpf.process(tv.noise()) * tv.envAt((float)tv.tau);
          tv.tau += 1.0 / (double)sr;
        }

        float s = (bed + rain + thunder) * sMaster.value;
        s = std::tanh(s * 1.2f) / 1.2f;   // gentle safety limiter
        out[(done + i) * 2 + 0] = s;
        out[(done + i) * 2 + 1] = s;
      }
      done += n;
    }
  }
};

static void dataCallback(ma_device* dev, void* output, const void*, ma_uint32 frames) {
  auto* impl = (System::Impl*)dev->pUserData;
  impl->render((float*)output, frames);
}

System::~System() { shutdown(); }

bool System::init() {
  if (impl) return true;
  impl = new Impl();
  if (const char* v = std::getenv("SAILSIM_VOLUME"))
    impl->masterVol = std::max(0.0f, std::min(1.0f, (float)std::atof(v)));

  ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
  cfg.playback.format = ma_format_f32;
  cfg.playback.channels = 2;
  cfg.sampleRate = 0;   // device native
  cfg.dataCallback = dataCallback;
  cfg.pUserData = impl;
  if (ma_device_init(nullptr, &cfg, &impl->device) != MA_SUCCESS) {
    std::fprintf(stderr, "[audio] no output device — running silent\n");
    delete impl; impl = nullptr;
    return false;
  }
  impl->sr = (float)impl->device.sampleRate;
  impl->buildNoise();
  impl->hissHpf.highpass(impl->sr, 1600.0f, 0.7071f);
  impl->rainHpf.highpass(impl->sr, 600.0f, 0.7071f);
  impl->rainLpf.lowpass(impl->sr, 7000.0f, 0.7071f);
  impl->washLpf.lowpass(impl->sr, 480.0f, 0.6f);
  impl->lastWashF = 480.0f;
  // Smoothing time constants: 0.7 s for the ocean params, 0.25 s for the rain
  // gain (the client's setTargetAtTime values); master fades at 0.5 s.
  impl->sBed.configure(impl->sr, 0.7f, kBlock);
  impl->sWashF.configure(impl->sr, 0.7f, kBlock);
  impl->sHiss.configure(impl->sr, 0.7f, kBlock);
  impl->sSwellDepth.configure(impl->sr, 0.7f, kBlock);
  impl->sSwellFreq.configure(impl->sr, 0.7f, kBlock);
  impl->sRain.configure(impl->sr, 0.25f, kBlock);
  impl->sMaster.configure(impl->sr, 0.5f, kBlock);
  impl->sWashF.value = 480.0f; impl->sSwellFreq.value = 0.08f;
  if (ma_device_start(&impl->device) != MA_SUCCESS) {
    ma_device_uninit(&impl->device);
    delete impl; impl = nullptr;
    return false;
  }
  impl->started = true;
  return true;
}

void System::setWeather(float windSpeedMps) {
  if (!impl) return;
  const float k = std::max(0.0f, std::min(1.0f, windSpeedMps / 22.0f));
  impl->tBed.store(0.07f + 0.33f * k, std::memory_order_relaxed);
  impl->tWashF.store(480.0f + 1500.0f * k, std::memory_order_relaxed);
  impl->tHiss.store(k * k * 0.16f, std::memory_order_relaxed);
  impl->tSwellDepth.store(0.10f + 0.32f * k, std::memory_order_relaxed);
  impl->tSwellFreq.store(0.08f + 0.13f * k, std::memory_order_relaxed);
}

void System::setRain(float intensity) {
  if (!impl) return;
  impl->tRain.store(std::min(1.0f, std::max(0.0f, intensity)) * 0.14f, std::memory_order_relaxed);
}

void System::playThunder(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  // Find a free slot (drop the strike if all four rumbles are still rolling).
  int slot = -1;
  for (int v = 0; v < Impl::kThunder; ++v) {
    if (impl->thunderState[v].load(std::memory_order_relaxed) == 0) { slot = v; break; }
  }
  if (slot < 0) return;

  // The client's WebAudio envelope, verbatim: sharp crack for close strikes,
  // soft build for distant ones, then a few rolling swells and a decaying tail.
  ThunderDesc d;
  d.dur = 3.0f + (1.0f - vol) * 3.0f;   // distant thunder rolls longer
  d.f0 = 300.0f + vol * 700.0f;
  const float peak = 0.9f * std::max(0.05f, vol);
  auto pt = [&](float t, float g, bool exp) {
    if (d.nPts >= ThunderDesc::kMaxPts) return;
    if (d.nPts > 0) t = std::max(t, d.pt[d.nPts - 1] + 0.001f);   // keep breakpoints sorted
    d.pt[d.nPts] = t; d.pg[d.nPts] = g; d.pe[d.nPts] = exp; ++d.nPts;
  };
  auto frand = [] { return (float)std::rand() / (float)RAND_MAX; };
  pt(0.0f, 0.0001f, false);
  if (vol > 0.6f) pt(0.03f, peak, true);
  else            pt(0.2f, peak * 0.6f, false);
  float tt = 0.25f;
  for (int k = 0; k < 4 && tt < d.dur - 0.4f; ++k) {
    float p = std::max(0.001f, peak * (0.35f + frand() * 0.6f));
    pt(tt + 0.22f, p, true);
    pt(tt + 0.5f, std::max(0.001f, p * 0.4f), true);
    tt += 0.45f + frand() * 0.5f;
  }
  pt(d.dur, 0.0001f, true);

  impl->thunderDesc[slot] = d;
  impl->thunderState[slot].store(1, std::memory_order_release);
}

void System::setEnabled(bool on) {
  if (!impl) return;
  impl->tMaster.store(on ? impl->masterVol : 0.0f, std::memory_order_relaxed);
}

void System::shutdown() {
  if (!impl) return;
  if (impl->started) ma_device_uninit(&impl->device);
  delete impl;
  impl = nullptr;
}

}  // namespace audio
