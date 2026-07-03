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
  void bandpass(float sr, float freq, float q) {   // RBJ constant-skirt BPF
    float w = 2.0f * (float)M_PI * freq / sr, cw = std::cos(w), sw = std::sin(w);
    float alpha = sw / (2.0f * q);
    float a0 = 1 + alpha;
    b0 = alpha / a0; b1 = 0; b2 = -alpha / a0;
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

// A music synth voice: polyBLEP oscillator + ADSR (linear attack, exponential
// decay/release — Tone.Synth's default envelope shape).
struct MusicVoice {
  bool active = false;
  int synth = 0;
  float freq = 440, vel = 1, phase = 0;
  int stage = 0;            // 0 attack, 1 decay, 2 sustain, 3 release
  float env = 0;
  double releaseAt = 0;     // playhead time to enter release
};

inline float polyblep(float t, float dt) {
  if (t < dt) { float x = t / dt; return x + x - x * x - 1.0f; }
  if (t > 1.0f - dt) { float x = (t - 1.0f) / dt; return x * x + x + x + 1.0f; }
  return 0.0f;
}

// Schroeder/Freeverb-style mono reverb approximating Tone.Reverb(decay 3.5).
struct Reverb {
  static constexpr int kCombs = 6, kAllpass = 3;
  std::vector<float> comb[kCombs]; int ci[kCombs] = {};
  float cf[kCombs] = {};          // per-comb lowpass damping state
  std::vector<float> ap[kAllpass]; int ai[kAllpass] = {};
  void init(float sr) {
    static const float combMs[kCombs] = { 29.7f, 37.1f, 41.1f, 43.7f, 50.1f, 56.3f };
    static const float apMs[kAllpass] = { 5.0f, 1.7f, 12.3f };
    for (int i = 0; i < kCombs; ++i) comb[i].assign((size_t)(combMs[i] * 0.001f * sr) + 1, 0.0f);
    for (int i = 0; i < kAllpass; ++i) ap[i].assign((size_t)(apMs[i] * 0.001f * sr) + 1, 0.0f);
  }
  inline float process(float x) {
    float out = 0.0f;
    for (int i = 0; i < kCombs; ++i) {
      float y = comb[i][(size_t)ci[i]];
      cf[i] = y * 0.35f + cf[i] * 0.65f;                 // damping in the loop
      comb[i][(size_t)ci[i]] = x + cf[i] * 0.86f;        // ~3.5 s decay
      if (++ci[i] >= (int)comb[i].size()) ci[i] = 0;
      out += y;
    }
    out *= 1.0f / kCombs;
    for (int i = 0; i < kAllpass; ++i) {
      float b = ap[i][(size_t)ai[i]];
      ap[i][(size_t)ai[i]] = out + b * 0.5f;
      out = b - 0.5f * out;
      if (++ai[i] >= (int)ap[i].size()) ai[i] = 0;
    }
    return out;
  }
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

// One cannon shot: the client's six synth layers (cannon.service playCannonSound)
// — BANG (bandpass noise crack), BLAST (lowpass sweep roar), PUNCH + SUB (sine
// drops), ROLL + delayed ECHO (long lowpassed rumbles, fed through the reverb).
struct CannonDesc { float vol = 1, bangF = 1800, blastF0 = 880, punchF0 = 117, subF0 = 56; };
struct CannonVoice {
  CannonDesc d;
  Biquad bangBp, blastLp, rollLp, echoLp;
  double tau = 0;
  uint32_t rng = 1;
  bool active = false;
  float punchPh = 0, subPh = 0;
  inline float noise() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (float)(int32_t)rng * (1.0f / 2147483648.0f);
  }
  static float expEnv(float t, float g0, float dur) {   // exponentialRampTo 0.001
    if (t < 0 || t > dur) return 0.0f;
    return g0 * std::pow(0.001f / std::max(1e-4f, g0), t / dur);
  }
  // dry + wet (reverb send) for one sample at rate sr.
  void render(float sr, float& dry, float& wet) {
    const float t = (float)tau;
    const float v = d.vol;
    float o = 0.0f, send = 0.0f;
    if (t < 0.07f) {   // 1) BANG
      float g = t < 0.001f ? 0.85f * v * (t / 0.001f) : expEnv(t - 0.001f, 0.85f * v, 0.059f);
      o += bangBp.process(noise()) * g;
    }
    if (t < 1.1f) {    // 2) BLAST
      o += blastLp.process(noise()) * expEnv(t, 1.7f * v, 1.0f);
    }
    if (t < 0.43f) {   // 3) PUNCH
      float f = d.punchF0 * std::pow(34.0f / d.punchF0, std::min(1.0f, t / 0.20f));
      punchPh += 2.0f * (float)M_PI * f / sr;
      o += std::sin(punchPh) * expEnv(t, 1.0f * v, 0.42f);
    }
    if (t < 1.47f) {   // 4) SUB
      float f = d.subF0 * std::pow(18.0f / d.subF0, std::min(1.0f, t / 0.7f));
      subPh += 2.0f * (float)M_PI * f / sr;
      o += std::sin(subPh) * expEnv(t, 1.15f * v, 1.45f);
    }
    if (t < 3.6f) {    // 5) ROLL (reverb send)
      float g = t < 0.06f ? 0.80f * v * (t / 0.06f)
              : 0.80f * v * std::exp(-std::max(0.0f, t - 0.40f) / 1.05f);
      send += rollLp.process(noise()) * g;
    }
    const float te = t - 0.45f;
    if (te > 0 && te < 3.2f) {   // 6) ECHO (reverb send)
      float g = te < 0.18f ? 0.45f * v * (te / 0.18f)
              : 0.45f * v * std::exp(-std::max(0.0f, te - 0.6f) / 1.2f);
      send += echoLp.process(noise()) * g;
    }
    dry += o + send * 0.35f;
    wet += send;
    tau += 1.0 / (double)sr;
  }
};

// Demasting crack (mast-crack.service): a creaking-timber brown-noise groan
// under a volley of eight tapering wood cracks and a heavier final crash.
struct MastCrackDesc {
  float vol = 1;
  int n = 0;
  float t[10], inten[10], bpF[10], bpQ[10], thudF0[10];
};
struct MastCrackVoice {
  MastCrackDesc d;
  double tau = 0;
  bool active = false;
  // Groan: brown noise -> LP 320 Q5 with a 2.3 Hz LFO on the cutoff (+-170 Hz).
  float brownLast = 0;
  Biquad groanLp;
  double lfoPhase = 0;
  uint32_t rng = 3;
  // Crack channel (cracks are sequential; one biquad, reconfigured per crack).
  int crackIdx = -1;
  Biquad crackBp;
  float thudPh = 0;
  inline float noise() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (float)(int32_t)rng * (1.0f / 2147483648.0f);
  }
  float render(float sr) {
    const float t = (float)tau;
    float o = 0.0f;
    // Groan bed (0..2.4 s): env ramp 0.25 s -> hold -> fade over the last 1.18 s.
    if (t < 2.4f) {
      brownLast = (brownLast + 0.02f * noise()) / 1.02f;
      float env = t < 0.25f ? 0.2f * (t / 0.25f)
                : t < 1.32f ? 0.2f
                : 0.2f * std::max(0.0f, 1.0f - (t - 1.32f) / 1.08f);
      o += groanLp.process(brownLast * 3.5f) * env * 3.0f * d.vol;
    }
    // Advance to the crack whose window contains t.
    for (int i = crackIdx + 1; i < d.n; ++i) {
      if (t >= d.t[i]) {
        crackIdx = i;
        crackBp.bandpass(sr, d.bpF[i], d.bpQ[i]);
        thudPh = 0;
      } else break;
    }
    if (crackIdx >= 0) {
      const float ct = t - d.t[crackIdx];
      const float I = d.inten[crackIdx] * d.vol;
      if (ct < 0.14f) {   // splinter report: shaped noise through the bandpass
        float shaped = noise() * (1.0f - ct / 0.14f) * (1.0f - ct / 0.14f);
        float g = ct < 0.003f ? 0.6f * I * (ct / 0.003f) : 0.6f * I * std::exp(-(ct - 0.003f) / 0.05f);
        o += crackBp.process(shaped) * g;
      }
      if (ct < 0.22f) {   // low woody thud: triangle with a pitch drop to 55 Hz
        float f = d.thudF0[crackIdx] * std::pow(55.0f / d.thudF0[crackIdx], std::min(1.0f, ct / 0.13f));
        thudPh += f / sr;
        if (thudPh >= 1.0f) thudPh -= 1.0f;
        float tri = 4.0f * std::fabs(thudPh - 0.5f) - 1.0f;
        float g = ct < 0.005f ? 0.5f * I * (ct / 0.005f) : 0.5f * I * std::exp(-(ct - 0.005f) / 0.06f);
        o += tri * g;
      }
    }
    tau += 1.0 / (double)sr;
    return o * 0.6f;   // shared mix gain (client)
  }
};

// Impact one-shots (cannon.service playSplashSound / playLandImpactSound /
// playShipHitSound): a schedule of filtered-noise / sine-sweep / spiky-crunch
// layers, each with its own filter, sweep and envelope — built by the play*()
// functions with the client's exact numbers.
struct ImpLayer {
  int kind = 0;        // 0 = noise, 1 = sine, 2 = spiky crunch noise
  int filt = 0;        // 0 = bandpass, 1 = lowpass, 2 = highpass 2400 + lowpass 8500
  float t0 = 0, dur = 0.3f;
  float f0 = 500, f1 = 500, sweepDur = 0.3f, q = 1.0f;
  float g0 = 1.0f;
  int env = 0;         // 0 = exp decay g0 -> 0.001 over dur; 1 = ramp(attack) then exp(-x/tauD)
  float attack = 0.002f, tauD = 0.3f;
};
struct ImpactDesc { float vol = 1; int n = 0; ImpLayer L[36]; };

// Gull cry (bird.service playCry): a reedy band-passed sawtooth with a
// rising->falling pitch contour, a fast square-wave tremolo "laugh", a
// piecewise strike/decay envelope, and constant-power stereo pan. The caller
// pre-attenuates gain by camera distance and derives pan from view space.
struct GullDesc { float gain = 0.3f, pitch = 1000, pan = 0, lfoHz = 15, delay = 0; };
struct GullVoice {
  GullDesc d;
  double tau = 0;
  bool active = false;
  Biquad bp;                       // fixed bandpass at 1.8x pitch, Q 3.5
  float ph = 0;                    // sawtooth phase
  double lfoPh = 0;                // tremolo square LFO phase
  float gl = 0.7071f, gr = 0.7071f;   // equal-power pan gains
  void render(float sr, float& L, float& R) {
    const float lt = (float)tau - d.delay;
    tau += 1.0 / (double)sr;
    if (lt < 0.0f || lt > 0.48f) return;
    // Pitch contour: 0.95p -> 1.22p by 70 ms -> 0.80p by 340 ms, then hold.
    float f;
    if (lt < 0.07f)      f = d.pitch * (0.95f + 0.27f * (lt / 0.07f));
    else if (lt < 0.34f) f = d.pitch * (1.22f - 0.42f * ((lt - 0.07f) / 0.27f));
    else                 f = d.pitch * 0.80f;
    const float pdt = f / sr;
    ph += pdt;
    if (ph >= 1.0f) ph -= 1.0f;
    const float saw = 2.0f * ph - 1.0f - polyblep(ph, pdt);
    // Envelope: 20 ms strike to gain, exp to gain/2 by 180 ms, exp to 0.0006 by 420 ms.
    float g;
    const float half = std::max(0.0008f, d.gain * 0.5f);
    if (lt < 0.02f)      g = d.gain * (lt / 0.02f);
    else if (lt < 0.18f) g = d.gain * std::pow(half / std::max(1e-4f, d.gain), (lt - 0.02f) / 0.16f);
    else                 g = half * std::pow(0.0006f / half, (lt - 0.18f) / 0.24f);
    // Tremolo: gain 0.7 +- 0.3 square (the gull "laugh").
    lfoPh += d.lfoHz / sr;
    if (lfoPh >= 1.0) lfoPh -= 1.0;
    const float trem = lfoPh < 0.5 ? 1.0f : 0.4f;
    const float x = bp.process(saw) * trem * g;
    L += x * gl;
    R += x * gr;
  }
};
struct ImpactVoice {
  ImpactDesc d;
  double tau = 0;
  bool active = false;
  uint32_t rng = 5;
  Biquad flt[36], flt2[36];   // flt2 = the spray's second (lowpass) stage
  float ph[36] = {};
  bool fltInit[36] = {};
  float total = 1.0f;
  inline float noise() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (float)(int32_t)rng * (1.0f / 2147483648.0f);
  }
  void refreshFilters(float sr) {   // block-rate frequency sweeps
    const float t = (float)tau;
    for (int i = 0; i < d.n; ++i) {
      ImpLayer& L = d.L[i];
      const float lt = t - L.t0;
      if (lt < -0.05f || lt > L.dur) continue;
      float f = L.f1 != L.f0
              ? L.f0 * std::pow(L.f1 / L.f0, std::min(1.0f, std::max(0.0f, lt / std::max(0.01f, L.sweepDur))))
              : L.f0;
      if (L.kind == 1) continue;   // sine: no filter
      if (L.filt == 0) flt[i].bandpass(sr, std::max(30.0f, f), L.q);
      else if (L.filt == 1) flt[i].lowpass(sr, std::max(30.0f, f), 0.8f);
      else if (!fltInit[i]) { flt[i].highpass(sr, 2400.0f, 0.7f); flt2[i].lowpass(sr, 8500.0f, 0.7f); }
      fltInit[i] = true;
    }
  }
  float render(float sr) {
    const float t = (float)tau;
    float o = 0.0f;
    for (int i = 0; i < d.n; ++i) {
      const ImpLayer& L = d.L[i];
      const float lt = t - L.t0;
      if (lt < 0 || lt > L.dur) continue;
      float g;
      if (L.env == 0) g = L.g0 * std::pow(0.001f / std::max(1e-4f, L.g0), lt / L.dur);
      else g = lt < L.attack ? L.g0 * (lt / L.attack)
             : L.g0 * std::exp(-(lt - L.attack) / L.tauD);
      g *= d.vol;
      float x;
      if (L.kind == 1) {
        float f = L.f0 * std::pow(L.f1 / L.f0, std::min(1.0f, lt / std::max(0.01f, L.sweepDur)));
        ph[i] += f / sr;
        if (ph[i] >= 1.0f) ph[i] -= 1.0f;
        x = std::sin(ph[i] * 2.0f * (float)M_PI);
        o += x * g;
        continue;
      }
      if (L.kind == 2) {   // spiky crunch: sparse full-scale clicks over a quiet bed
        float u = lt / L.dur;
        float envP = std::pow(1.0f - u, 1.6f);
        float r = noise();
        float spike = std::fabs(noise()) < 0.07f ? r : r * 0.22f;
        x = spike * envP;
      } else x = noise();
      float y = flt[i].process(x);
      if (L.filt == 2) y = flt2[i].process(y);
      o += y * g;
    }
    tau += 1.0 / (double)sr;
    return o;
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

  // Cannon + splash one-shots (same queued/playing hand-off as thunder).
  static constexpr int kCannon = 6;
  CannonDesc cannonDesc[kCannon];
  std::atomic<int> cannonState[kCannon]{};
  CannonVoice cannonVoice[kCannon];
  static constexpr int kMastCrack = 2;
  MastCrackDesc mastCrackDesc[kMastCrack];
  std::atomic<int> mastCrackState[kMastCrack]{};
  MastCrackVoice mastCrackVoice[kMastCrack];
  static constexpr int kImpact = 6;
  ImpactDesc impactDesc[kImpact];
  std::atomic<int> impactState[kImpact]{};
  ImpactVoice impactVoice[kImpact];
  // Gull cries: a startled raft bursts 5-12 overlapping calls, so the pool is
  // deeper than the other one-shots.
  static constexpr int kGull = 12;
  GullDesc gullDesc[kGull];
  std::atomic<int> gullState[kGull]{};
  GullVoice gullVoice[kGull];
  Reverb cannonReverb;

  // ── Music engine ──
  // Program hand-off: game thread parks the next program in `musicPending`;
  // the audio thread swaps it into `musicCurrent` at a block boundary and parks
  // the old one in `musicRetired` for the game thread to delete (no frees on
  // the audio thread). All three are exchanged atomically.
  std::atomic<MusicProgram*> musicPending{nullptr};
  std::atomic<MusicProgram*> musicRetired{nullptr};
  std::atomic<bool> musicStopReq{false};
  std::atomic<bool> musicFinishedFlag{false};
  std::atomic<float> tMusicGain{0.0f};
  MusicProgram* musicCurrent = nullptr;   // audio thread only
  size_t musicCursor = 0;                 // next note event
  double musicPlayhead = 0;               // seconds into the track
  bool musicDone = false;                  // finished flag already raised
  static constexpr int kMusicVoices = 64;
  MusicVoice musicVoice[kMusicVoices];
  Smoothed sMusicGain;
  Reverb musicReverb;

  void musicNoteOn(const MusicNote& n) {
    // Free voice, else steal the quietest releasing voice.
    int pick = -1; float quiet = 1e9f;
    for (int i = 0; i < kMusicVoices; ++i) {
      if (!musicVoice[i].active) { pick = i; break; }
      float score = musicVoice[i].env + (musicVoice[i].stage == 3 ? 0.0f : 10.0f);
      if (score < quiet) { quiet = score; pick = i; }
    }
    MusicVoice& v = musicVoice[pick];
    v.active = true; v.synth = n.synth; v.freq = n.freq; v.vel = n.vel;
    v.phase = 0; v.stage = 0; v.env = 0;
    v.releaseAt = n.t + (double)n.dur;
  }

  float renderMusicSample() {
    if (!musicCurrent) return 0.0f;
    const double dt = 1.0 / (double)sr;
    float mix = 0.0f;
    for (int i = 0; i < kMusicVoices; ++i) {
      MusicVoice& v = musicVoice[i];
      if (!v.active) continue;
      const MusicSynthSpec& s = musicCurrent->synths[(size_t)v.synth];
      // Envelope.
      if (v.stage != 3 && musicPlayhead >= v.releaseAt) v.stage = 3;
      switch (v.stage) {
        case 0: v.env += (float)dt / std::max(0.003f, s.attack);
                if (v.env >= 1.0f) { v.env = 1.0f; v.stage = 1; } break;
        case 1: v.env = s.sustain + (v.env - s.sustain) * std::exp(-(float)dt * 4.6f / std::max(0.01f, s.decay));
                if (v.env - s.sustain < 0.01f) v.stage = 2; break;
        case 2: v.env = s.sustain; break;
        case 3: v.env *= std::exp(-(float)dt * 4.6f / std::max(0.02f, s.release));
                if (v.env < 1e-4f) { v.active = false; continue; } break;
      }
      // polyBLEP oscillator.
      float pdt = v.freq / sr;
      v.phase += pdt;
      if (v.phase >= 1.0f) v.phase -= 1.0f;
      float osc;
      if (s.osc == 1) {         // sawtooth
        osc = 2.0f * v.phase - 1.0f - polyblep(v.phase, pdt);
      } else if (s.osc == 2) {  // square
        osc = (v.phase < 0.5f ? 1.0f : -1.0f) + polyblep(v.phase, pdt);
        float p2 = v.phase + 0.5f; if (p2 >= 1.0f) p2 -= 1.0f;
        osc -= polyblep(p2, pdt);
      } else {                  // triangle
        osc = 4.0f * std::fabs(v.phase - 0.5f) - 1.0f;
      }
      mix += osc * v.env * v.vel * s.volLin;
    }
    // Shared reverb bus (Tone.Reverb decay 3.5, wet 0.35).
    return mix * 0.65f + musicReverb.process(mix) * 0.35f;
  }

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

      // Music: adopt a pending program / stop request at the block boundary.
      if (musicStopReq.exchange(false, std::memory_order_acquire)) {
        if (musicCurrent) {
          MusicProgram* old = musicRetired.exchange(musicCurrent, std::memory_order_release);
          delete old;   // (previous retiree unclaimed — safe: we're its only producer)
          musicCurrent = nullptr;
        }
        for (auto& v : musicVoice) v.active = false;
        musicDone = false;
      }
      if (MusicProgram* next = musicPending.exchange(nullptr, std::memory_order_acquire)) {
        if (musicCurrent) {
          MusicProgram* old = musicRetired.exchange(musicCurrent, std::memory_order_release);
          delete old;
        }
        musicCurrent = next;
        musicCursor = 0; musicPlayhead = 0; musicDone = false;
        for (auto& v : musicVoice) v.active = false;
      }
      sMusicGain.step(tMusicGain.load(std::memory_order_relaxed));
      if (musicCurrent) {
        // Fire note-ons that fall inside this block.
        const double blockEnd = musicPlayhead + (double)n / (double)sr;
        while (musicCursor < musicCurrent->notes.size() &&
               musicCurrent->notes[musicCursor].t <= blockEnd) {
          musicNoteOn(musicCurrent->notes[musicCursor]);
          ++musicCursor;
        }
        // Track played out (+ the client's 1.5 s gap) -> raise the advance flag.
        if (!musicDone && musicPlayhead > musicCurrent->duration + 1.5) {
          musicDone = true;
          musicFinishedFlag.store(true, std::memory_order_release);
        }
      }

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

      // Claim queued cannon/splash voices + refresh their filter sweeps.
      for (int v = 0; v < kCannon; ++v) {
        int q = 1;
        if (cannonState[v].compare_exchange_strong(q, 2, std::memory_order_acquire)) {
          CannonVoice& cv = cannonVoice[v];
          cv = CannonVoice();
          cv.d = cannonDesc[v];
          cv.rng = 0xB5297A4Du + (uint32_t)v * 0x68E31DA4u;
          cv.bangBp.bandpass(sr, cv.d.bangF, 0.7f);
          cv.active = true;
        }
        CannonVoice& cv = cannonVoice[v];
        if (!cv.active) continue;
        if (cv.tau >= 4.2) {
          cv.active = false;
          cannonState[v].store(0, std::memory_order_release);
          continue;
        }
        float tb = (float)cv.tau;
        float fBlast = cv.d.blastF0 * std::pow(70.0f / cv.d.blastF0, std::min(1.0f, tb / 0.6f));
        cv.blastLp.lowpass(sr, std::max(70.0f, fBlast), 0.8f);
        float fRoll = 360.0f * std::pow(75.0f / 360.0f, std::min(1.0f, tb / 2.6f));
        cv.rollLp.lowpass(sr, std::max(75.0f, fRoll), 0.5f);
        float teB = std::max(0.0f, tb - 0.45f);
        float fEcho = 230.0f * std::pow(55.0f / 230.0f, std::min(1.0f, teB / 2.4f));
        cv.echoLp.lowpass(sr, std::max(55.0f, fEcho), 0.5f);
      }
      for (int v = 0; v < kMastCrack; ++v) {
        int q = 1;
        if (mastCrackState[v].compare_exchange_strong(q, 2, std::memory_order_acquire)) {
          MastCrackVoice& mv = mastCrackVoice[v];
          mv = MastCrackVoice();
          mv.d = mastCrackDesc[v];
          mv.rng = 0xC0FFEEu + (uint32_t)v * 0x9E3779B9u;
          mv.active = true;
        }
        MastCrackVoice& mv = mastCrackVoice[v];
        if (!mv.active) continue;
        if (mv.tau >= 3.0) {
          mv.active = false;
          mastCrackState[v].store(0, std::memory_order_release);
          continue;
        }
        // Groan LP cutoff wobbles at 2.3 Hz (+-170 Hz around 320).
        mv.lfoPhase += 2.0 * M_PI * 2.3 * 128.0 / sr;   // block-rate-ish update
        float f = 320.0f + 170.0f * (float)std::sin(mv.lfoPhase);
        mv.groanLp.lowpass(sr, std::max(60.0f, f), 5.0f);
      }
      for (int v = 0; v < kImpact; ++v) {
        int q = 1;
        if (impactState[v].compare_exchange_strong(q, 2, std::memory_order_acquire)) {
          ImpactVoice& iv = impactVoice[v];
          iv = ImpactVoice();
          iv.d = impactDesc[v];
          iv.rng = 0x1234567u + (uint32_t)v * 0x9E3779B9u;
          float tmax = 0.1f;
          for (int i = 0; i < iv.d.n; ++i) tmax = std::max(tmax, iv.d.L[i].t0 + iv.d.L[i].dur);
          iv.total = tmax + 0.05f;
          iv.active = true;
        }
        ImpactVoice& iv = impactVoice[v];
        if (!iv.active) continue;
        if (iv.tau >= iv.total) {
          iv.active = false;
          impactState[v].store(0, std::memory_order_release);
          continue;
        }
        iv.refreshFilters(sr);
      }
      // Claim queued gull cries (fixed bandpass + pan gains set once here).
      for (int v = 0; v < kGull; ++v) {
        int q = 1;
        if (gullState[v].compare_exchange_strong(q, 2, std::memory_order_acquire)) {
          GullVoice& gv = gullVoice[v];
          gv = GullVoice();
          gv.d = gullDesc[v];
          gv.bp.bandpass(sr, gv.d.pitch * 1.8f, 3.5f);
          const float a = (gv.d.pan + 1.0f) * 0.7853982f;   // equal-power pan
          gv.gl = std::cos(a); gv.gr = std::sin(a);
          gv.active = true;
        }
        GullVoice& gv = gullVoice[v];
        if (gv.active && gv.tau >= (double)gv.d.delay + 0.5) {
          gv.active = false;
          gullState[v].store(0, std::memory_order_release);
        }
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
        // Cannon shots: six-layer synth + shared reverb (the rolling boom).
        float cannonDry = 0.0f, cannonSend = 0.0f;
        for (int v = 0; v < kCannon; ++v)
          if (cannonVoice[v].active) cannonVoice[v].render(sr, cannonDry, cannonSend);
        float cannon = cannonDry * 0.5f + cannonReverb.process(cannonSend * 0.5f) * 0.85f;
        cannon = std::tanh(cannon * 1.4f) / 1.4f;   // the client's cannon-bus limiter
        // Demasting cracks.
        float mastCrack = 0.0f;
        for (int v = 0; v < kMastCrack; ++v)
          if (mastCrackVoice[v].active) mastCrack += mastCrackVoice[v].render(sr);
        // Impact one-shots (splash / land thud / ship crunch).
        float splash = 0.0f;
        for (int v = 0; v < kImpact; ++v)
          if (impactVoice[v].active) splash += impactVoice[v].render(sr);
        // Gull cries — the only stereo voices (client StereoPanner by view pos).
        float gullL = 0.0f, gullR = 0.0f;
        for (int v = 0; v < kGull; ++v)
          if (gullVoice[v].active) gullVoice[v].render(sr, gullL, gullR);
        // Music synth — its own bus/gain, independent of the SFX master.
        float music = 0.0f;
        if (musicCurrent) {
          music = renderMusicSample() * sMusicGain.value;
          musicPlayhead += 1.0 / (double)sr;
        }

        const float mono = (bed + rain + thunder + cannon + mastCrack + splash) * sMaster.value + music;
        float sL = mono + gullL * sMaster.value;
        float sR = mono + gullR * sMaster.value;
        out[(done + i) * 2 + 0] = std::tanh(sL * 1.2f) / 1.2f;   // gentle safety limiter
        out[(done + i) * 2 + 1] = std::tanh(sR * 1.2f) / 1.2f;
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
  impl->sMusicGain.configure(impl->sr, 0.15f, kBlock);
  impl->musicReverb.init(impl->sr);
  impl->cannonReverb.init(impl->sr);
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

// One cannon shot (client playCannonSound, six layers). vol 0..1 (distance-set).
void System::playCannon(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  if (vol < 0.01f) return;
  int slot = -1;
  for (int v = 0; v < Impl::kCannon; ++v)
    if (impl->cannonState[v].load(std::memory_order_relaxed) == 0) { slot = v; break; }
  if (slot < 0) return;
  CannonDesc d;
  d.vol = vol;
  auto rnd = [](float a, float b) { return a + (float)std::rand() / RAND_MAX * (b - a); };
  d.bangF = rnd(1400.0f, 2200.0f);
  d.blastF0 = rnd(780.0f, 980.0f);
  d.punchF0 = rnd(108.0f, 126.0f);
  d.subF0 = rnd(52.0f, 60.0f);
  impl->cannonDesc[slot] = d;
  impl->cannonState[slot].store(1, std::memory_order_release);
}

// Demasting crack (mast-crack.service): groan + 8 tapering cracks + final crash.
void System::playMastCrack(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  if (vol < 0.01f) return;
  int slot = -1;
  for (int v = 0; v < Impl::kMastCrack; ++v)
    if (impl->mastCrackState[v].load(std::memory_order_relaxed) == 0) { slot = v; break; }
  if (slot < 0) return;
  auto rnd = [](float a, float b) { return a + (float)std::rand() / RAND_MAX * (b - a); };
  MastCrackDesc d;
  d.vol = vol;
  static const float base[8] = { 0.0f, 0.16f, 0.4f, 0.72f, 1.08f, 1.45f, 1.9f, 2.25f };
  for (int i = 0; i < 8; ++i) {
    float jit = rnd(-0.06f, 0.06f);
    d.t[i] = std::max(0.0f, base[i] + (i == 0 ? 0.0f : jit));
    d.inten[i] = i == 0 ? 1.0f : std::max(0.25f, 0.9f - i * 0.07f + rnd(-0.1f, 0.1f));
    d.bpF[i] = rnd(220.0f, 970.0f);
    d.bpQ[i] = rnd(1.4f, 4.4f);
    d.thudF0[i] = rnd(110.0f - 70.0f, 110.0f + 70.0f);
  }
  d.t[8] = 2.5f; d.inten[8] = 1.15f;             // the heavier final crash
  d.bpF[8] = rnd(220.0f, 600.0f); d.bpQ[8] = 2.0f; d.thudF0[8] = rnd(70.0f, 110.0f);
  d.n = 9;
  impl->mastCrackDesc[slot] = d;
  impl->mastCrackState[slot].store(1, std::memory_order_release);
}

static float rnd2(float a, float b) { return a + (float)std::rand() / RAND_MAX * (b - a); }

static bool queueImpact(System::Impl* impl, const ImpactDesc& d) {
  for (int v = 0; v < System::Impl::kImpact; ++v) {
    if (impl->impactState[v].load(std::memory_order_relaxed) == 0) {
      impl->impactDesc[v] = d;
      impl->impactState[v].store(1, std::memory_order_release);
      return true;
    }
  }
  return false;
}

// Water splash (client playSplashSound): resonant gloop + low whoomp + sub
// thump + a foamy spray that swells in then rains down.
void System::playSplash(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  if (vol < 0.01f) return;
  ImpactDesc d;
  d.vol = vol;
  d.L[d.n++] = { 0, 0, 0.0f, 0.48f, rnd2(520, 640), 120, 0.30f, 4.0f, 1.5f, 0, 0.002f, 0.3f };
  d.L[d.n++] = { 0, 1, 0.0f, 0.50f, 700, 110, 0.32f, 0.8f, 1.1f, 0, 0.002f, 0.3f };
  d.L[d.n++] = { 1, 0, 0.0f, 0.40f, rnd2(85, 100), 34, 0.22f, 1.0f, 0.85f, 0, 0.002f, 0.3f };
  { ImpLayer L; L.kind = 0; L.filt = 2; L.t0 = 0; L.dur = 1.2f; L.f0 = L.f1 = 2400;
    L.g0 = 0.55f; L.env = 1; L.attack = 0.10f; L.tauD = 0.34f; d.L[d.n++] = L; }
  queueImpact(impl, d);
}

// Land impact (client playLandImpactSound): hard thud + gritty crack + a
// clatter of nine debris ticks settling over ~0.9 s.
void System::playLandImpact(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  if (vol < 0.01f) return;
  ImpactDesc d;
  d.vol = vol;
  d.L[d.n++] = { 1, 0, 0.0f, 0.35f, rnd2(120, 140), 32, 0.18f, 1.0f, 1.35f, 0, 0.002f, 0.3f };
  d.L[d.n++] = { 0, 1, 0.0f, 0.16f, 2800, 400, 0.12f, 0.8f, 1.1f, 0, 0.002f, 0.3f };
  for (int k = 0; k < 9; ++k) {
    float dt = rnd2(0.06f, 0.85f);
    ImpLayer L; L.kind = 0; L.filt = 0; L.t0 = dt; L.dur = 0.05f;
    L.f0 = L.f1 = rnd2(800, 3200); L.q = rnd2(2, 6);
    L.g0 = std::max(0.02f, rnd2(0.12f, 0.40f) * (1.0f - dt));
    L.env = 1; L.attack = 0.002f; L.tauD = 0.012f;
    d.L[d.n++] = L;
  }
  queueImpact(impl, d);
}

// Ship hit (client playShipHitSound): the land impact PLUS two crunch passes
// (the ball crushing planking), four splintering cracks, and a long shatter
// of woody ticks — the hull breaking apart.
void System::playShipHit(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  if (vol < 0.01f) return;
  ImpactDesc d;
  d.vol = vol;
  d.L[d.n++] = { 1, 0, 0.0f, 0.35f, rnd2(120, 140), 32, 0.18f, 1.0f, 1.35f, 0, 0.002f, 0.3f };
  d.L[d.n++] = { 0, 1, 0.0f, 0.16f, 2800, 400, 0.12f, 0.8f, 1.1f, 0, 0.002f, 0.3f };
  d.L[d.n++] = { 2, 0, 0.00f, 0.30f, 1100, 240, 0.24f, 0.8f, 1.5f, 0, 0.002f, 0.3f };
  d.L[d.n++] = { 2, 0, 0.10f, 0.34f,  800, 180, 0.27f, 0.8f, 1.0f, 0, 0.002f, 0.3f };
  for (int k = 0; k < 4; ++k) {
    ImpLayer L; L.kind = 0; L.filt = 0; L.t0 = k * 0.045f; L.dur = 0.10f;
    L.f0 = rnd2(900, 1500); L.f1 = rnd2(300, 500); L.sweepDur = 0.09f; L.q = 1.2f;
    L.g0 = 0.9f; L.env = 1; L.attack = 0.002f; L.tauD = 0.02f;
    d.L[d.n++] = L;
  }
  for (int k = 0; k < 18 && d.n < 36; ++k) {
    float dt = rnd2(0.02f, 1.10f);
    ImpLayer L; L.kind = 0; L.filt = 0; L.t0 = dt; L.dur = 0.05f;
    L.f0 = L.f1 = rnd2(260, 1900); L.q = rnd2(3, 9);
    L.g0 = std::max(0.02f, rnd2(0.10f, 0.35f) * (1.0f - dt / 1.2f));
    L.env = 1; L.attack = 0.002f; L.tauD = 0.012f;
    d.L[d.n++] = L;
  }
  queueImpact(impl, d);
}

// Ship's bell (ship-bell.service ring/strike): two strikes 0.5 s apart. Each is
// six inharmonic sine partials on f0 920 Hz with a 4 ms attack and long
// exponential ring-outs, plus a short band-passed noise transient for the
// metallic "clang". Output gain 0.22 (the partials sum to ~3.4 at the peak).
void System::playBell(float vol) {
  if (!impl) return;
  vol = std::max(0.0f, std::min(1.0f, vol));
  if (vol < 0.01f) return;
  ImpactDesc d;
  d.vol = 0.22f * vol;
  static const float kPartials[6][3] = {   // ratio, gain, decay seconds
    { 1.00f, 1.00f, 3.0f }, { 2.00f, 0.70f, 2.5f }, { 2.76f, 0.62f, 2.1f },
    { 4.07f, 0.46f, 1.6f }, { 5.43f, 0.34f, 1.3f }, { 6.80f, 0.24f, 1.0f },
  };
  const float f0 = 920.0f;
  for (int strike = 0; strike < 2; ++strike) {
    const float t0 = strike * 0.5f;
    for (const auto& pr : kPartials) {
      ImpLayer L; L.kind = 1; L.t0 = t0; L.dur = pr[2];
      L.f0 = L.f1 = f0 * pr[0]; L.g0 = pr[1];
      // env 1 (attack + exp decay); tau chosen so the ring hits the client's
      // 0.0001 ramp target exactly at the partial's decay time.
      L.env = 1; L.attack = 0.004f; L.tauD = pr[2] / std::log(pr[1] / 0.0001f);
      d.L[d.n++] = L;
    }
    ImpLayer N; N.kind = 0; N.filt = 0; N.t0 = t0; N.dur = 0.05f;   // strike transient
    N.f0 = N.f1 = f0 * 3.0f; N.q = 0.8f; N.g0 = 0.7f; N.env = 0;
    d.L[d.n++] = N;
  }
  queueImpact(impl, d);
}

// One gull cry (bird.service playCry). gain is pre-attenuated by the caller
// (distance falloff (1 - d/320)^2 x level, skipped below 0.012); pan -1..1
// from the cry's view-space position; lfoHz = the 12-19 Hz tremolo rate.
void System::playGullCry(float gain, float pitch, float pan, float lfoHz, float delay) {
  if (!impl) return;
  if (gain < 0.012f) return;
  for (int v = 0; v < Impl::kGull; ++v) {
    if (impl->gullState[v].load(std::memory_order_relaxed) == 0) {
      impl->gullDesc[v] = { gain, pitch, std::max(-1.0f, std::min(1.0f, pan)),
                            lfoHz, std::max(0.0f, delay) };
      impl->gullState[v].store(1, std::memory_order_release);
      return;
    }
  }
}

void System::setMasterVolume(float v) {
  if (!impl) return;
  impl->masterVol = std::max(0.0f, std::min(1.0f, v));
  // Re-assert through the enable gate (harmless if currently muted: enable
  // path re-stores on the next setEnabled call every frame).
}

void System::musicPlay(MusicProgram&& program) {
  if (!impl) return;
  delete impl->musicRetired.exchange(nullptr, std::memory_order_acquire);
  MusicProgram* p = new MusicProgram(std::move(program));
  delete impl->musicPending.exchange(p, std::memory_order_release);   // replace an unconsumed pending
  impl->musicFinishedFlag.store(false, std::memory_order_relaxed);
}

void System::musicStop() {
  if (!impl) return;
  delete impl->musicRetired.exchange(nullptr, std::memory_order_acquire);
  delete impl->musicPending.exchange(nullptr, std::memory_order_acquire);
  impl->musicStopReq.store(true, std::memory_order_release);
  impl->musicFinishedFlag.store(false, std::memory_order_relaxed);
}

void System::musicSetGain(float linear) {
  if (!impl) return;
  impl->tMusicGain.store(std::max(0.0f, std::min(1.0f, linear)), std::memory_order_relaxed);
}

bool System::musicConsumeFinished() {
  if (!impl) return false;
  delete impl->musicRetired.exchange(nullptr, std::memory_order_acquire);
  return impl->musicFinishedFlag.exchange(false, std::memory_order_acq_rel);
}

void System::shutdown() {
  if (!impl) return;
  if (impl->started) ma_device_uninit(&impl->device);
  delete impl->musicPending.load();
  delete impl->musicRetired.load();
  delete impl->musicCurrent;
  delete impl;
  impl = nullptr;
}

}  // namespace audio
