// Music manager — see music.hpp. The MIDI parsing mirrors what @tonejs/midi
// gave the client: per-track notes with seconds-based times (via the tempo
// map), a GM instrument family per track (first program change), percussion
// (channel 10) skipped, and the makeSynthForTrack family->timbre table.

#include "music.hpp"
#include "audio.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <future>
#include <map>
#include <random>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

namespace music {
namespace {

// ── Minimal Standard MIDI File parser ────────────────────────────────────────

struct RawNote { double tick = 0; double durTick = 0; int note = 60; float vel = 0.8f; };
struct RawTrack { int program = 0; bool percussion = false; std::vector<RawNote> notes; };

struct Reader {
  const uint8_t* p; const uint8_t* end;
  bool ok = true;
  uint8_t u8() { if (p >= end) { ok = false; return 0; } return *p++; }
  uint32_t u32() { uint32_t v = 0; for (int i = 0; i < 4; ++i) v = (v << 8) | u8(); return v; }
  uint16_t u16() { uint16_t v = 0; for (int i = 0; i < 2; ++i) v = (uint16_t)((v << 8) | u8()); return v; }
  uint32_t vlq() {
    uint32_t v = 0;
    for (int i = 0; i < 4; ++i) { uint8_t b = u8(); v = (v << 7) | (b & 0x7F); if (!(b & 0x80)) break; }
    return v;
  }
  void skip(uint32_t n) { p = (p + n <= end) ? p + n : end; }
};

// Parse an SMF into per-track pitched notes (ticks) + a global tempo map.
static bool parseSmf(const std::string& bytes, std::vector<RawTrack>& outTracks,
                     std::vector<std::pair<double, double>>& tempoMap, int& tpq) {
  Reader r{ (const uint8_t*)bytes.data(), (const uint8_t*)bytes.data() + bytes.size() };
  if (r.u32() != 0x4D546864u) return false;   // "MThd"
  uint32_t hlen = r.u32();
  (void)r.u16();                              // format
  uint16_t ntrks = r.u16();
  uint16_t division = r.u16();
  if (division & 0x8000) return false;        // SMPTE timing unsupported
  tpq = division;
  r.skip(hlen > 6 ? hlen - 6 : 0);

  // No seeded default entry: tickToSec starts at 500000 (120 bpm) and only
  // real tempo events override it. (A seeded {0, 500000} pair sorted AFTER a
  // faster real tempo at tick 0 and clobbered it — every song played at 120.)
  tempoMap.clear();

  for (int t = 0; t < ntrks && r.ok; ++t) {
    if (r.u32() != 0x4D54726Bu) return false; // "MTrk"
    uint32_t len = r.u32();
    const uint8_t* trackEnd = r.p + len;
    if (trackEnd > r.end) return false;

    RawTrack track;
    double tick = 0;
    uint8_t running = 0;
    // (channel, note) -> onset (tick, velocity) for on/off pairing
    std::map<int, std::vector<std::pair<double, float>>> open;

    while (r.p < trackEnd && r.ok) {
      tick += r.vlq();
      uint8_t status = *r.p;
      if (status & 0x80) { r.u8(); running = status; } else { status = running; }
      const int type = status >> 4, chan = status & 0x0F;
      if (type == 0x9 || type == 0x8) {
        int note = r.u8(), vel = r.u8();
        const int key = chan * 128 + note;
        if (type == 0x9 && vel > 0) {
          open[key].push_back({ tick, (float)vel / 127.0f });
        } else if (!open[key].empty()) {
          auto on = open[key].back(); open[key].pop_back();
          if (chan == 9) track.percussion = true;
          track.notes.push_back({ on.first, std::max(1.0, tick - on.first), note, on.second });
        }
      } else if (type == 0xA || type == 0xB || type == 0xE) { r.skip(2); }
      else if (type == 0xC) { track.program = r.u8(); }
      else if (type == 0xD) { r.skip(1); }
      else if (status == 0xFF) {
        uint8_t meta = r.u8(); uint32_t mlen = r.vlq();
        if (meta == 0x51 && mlen == 3) {
          uint32_t us = ((uint32_t)r.u8() << 16) | ((uint32_t)r.u8() << 8) | r.u8();
          tempoMap.push_back({ tick, (double)us });
        } else { r.skip(mlen); }
      } else if (status == 0xF0 || status == 0xF7) { r.skip(r.vlq()); }
      else { return false; }
    }
    r.p = trackEnd;
    if (!track.notes.empty()) outTracks.push_back(std::move(track));
  }
  std::stable_sort(tempoMap.begin(), tempoMap.end(),
                   [](const std::pair<double, double>& a, const std::pair<double, double>& b) {
                     return a.first < b.first;
                   });
  return r.ok && !outTracks.empty();
}

// Ticks -> seconds through the tempo map.
static double tickToSec(double tick, const std::vector<std::pair<double, double>>& tempoMap, int tpq) {
  double sec = 0, prevTick = 0, us = 500000.0;
  for (const auto& [tTick, tUs] : tempoMap) {
    if (tTick >= tick) break;
    sec += (tTick - prevTick) * us / (1e6 * tpq);
    prevTick = tTick; us = tUs;
  }
  return sec + (tick - prevTick) * us / (1e6 * tpq);
}

// makeSynthForTrack: GM program number -> family -> oscillator + ADSR + volume.
static audio::MusicSynthSpec synthForProgram(int program) {
  audio::MusicSynthSpec s;   // defaults: triangle, 0.04/0.10/0.70/1.20, -14 dB
  float volDb = -14.0f;
  const int fam = program / 8;   // GM families in blocks of 8
  if (fam == 4) {                          // bass (32-39)
    s.osc = 1; s.attack = 0.02f; s.decay = 0.15f; s.sustain = 0.60f; s.release = 0.80f; volDb = -11.0f;
  } else if (fam == 7 || fam == 8) {       // brass (56-63) / reed (64-71)
    s.osc = 1; s.attack = 0.08f; s.decay = 0.12f; s.sustain = 0.80f; s.release = 0.60f;
  } else if (fam == 5 || fam == 6) {       // strings (40-47) / ensemble (48-55)
    s.osc = 0; s.attack = 0.14f; s.decay = 0.20f; s.sustain = 0.75f; s.release = 2.00f; volDb = -15.0f;
  } else if (fam == 2) {                   // organ (16-23)
    s.osc = 2; s.attack = 0.01f; s.decay = 0.05f; s.sustain = 0.90f; s.release = 0.25f;
  } else if (fam == 3) {                   // guitar (24-31)
    s.osc = 1; s.attack = 0.01f; s.decay = 0.35f; s.sustain = 0.20f; s.release = 0.50f;
  } else if (fam == 9) {                   // pipe (72-79)
    s.osc = 0; s.attack = 0.10f; s.decay = 0.08f; s.sustain = 0.85f; s.release = 0.40f;
  } else if (fam == 10) {                  // synth lead (80-87)
    s.osc = 1; s.attack = 0.02f; s.release = 0.80f;
  } else if (fam == 11) {                  // synth pad (88-95)
    s.osc = 0; s.attack = 0.20f; s.decay = 0.30f; s.sustain = 0.65f; s.release = 2.50f; volDb = -16.0f;
  } else if (fam == 0 || fam == 1) {       // piano / chromatic percussion
    s.osc = 0; s.attack = 0.01f; s.decay = 0.30f; s.sustain = 0.45f; s.release = 1.00f;
  }
  s.volLin = std::pow(10.0f, volDb / 20.0f);
  return s;
}

// Flatten a parsed SMF into an audio::MusicProgram (startCurrentTrack's job).
static bool buildProgram(const std::string& bytes, audio::MusicProgram& out) {
  std::vector<RawTrack> tracks;
  std::vector<std::pair<double, double>> tempoMap;
  int tpq = 480;
  if (!parseSmf(bytes, tracks, tempoMap, tpq)) return false;

  for (const RawTrack& tr : tracks) {
    if (tr.percussion) continue;   // drums: no pitched notes (client skip)
    const int synthIdx = (int)out.synths.size();
    out.synths.push_back(synthForProgram(tr.program));
    for (const RawNote& n : tr.notes) {
      const double t0 = tickToSec(n.tick, tempoMap, tpq);
      const double t1 = tickToSec(n.tick + n.durTick, tempoMap, tpq);
      audio::MusicNote mn;
      mn.t = t0;
      mn.dur = (float)std::max(0.03, t1 - t0);
      mn.freq = 440.0f * std::pow(2.0f, ((float)n.note - 69.0f) / 12.0f);
      mn.vel = n.vel;
      mn.synth = synthIdx;
      out.notes.push_back(mn);
      out.duration = std::max(out.duration, t1);
    }
  }
  if (out.notes.empty()) return false;
  std::sort(out.notes.begin(), out.notes.end(),
            [](const audio::MusicNote& a, const audio::MusicNote& b) { return a.t < b.t; });
  return true;
}

struct Track { std::string filename, name; };

}  // namespace

struct Manager::Impl {
  audio::System* audio = nullptr;
  std::vector<Track> tracks;
  std::map<std::string, audio::MusicProgram> cache;   // filename -> parsed program
  int index = 0;
  bool listReady = false;
  std::future<bool> fetchJob;
  // Filled by the fetch thread, adopted in update() (guarded by the future).
  std::vector<Track> fetchedTracks;
  std::map<std::string, audio::MusicProgram> fetchedCache;
};

Manager::~Manager() { delete impl; }

void Manager::init(const std::string& host, int port, audio::System* audio,
                   bool enabled, float volume) {
  if (impl) return;
  impl = new Impl();
  impl->audio = audio;
  enabled_ = enabled;
  volume_ = std::max(0.0f, std::min(1.0f, volume));
  impl->fetchJob = std::async(std::launch::async, [this, host, port] {
    httplib::Client cli(host, port);
    cli.set_read_timeout(20, 0);
    auto res = cli.Get("/music");
    if (!res || res->status != 200) {
      std::fprintf(stderr, "[music] could not fetch track list\n");
      return false;
    }
    try {
      for (const auto& j : nlohmann::json::parse(res->body)) {
        impl->fetchedTracks.push_back({ j.value("filename", ""), j.value("name", "") });
      }
    } catch (...) { return false; }
    // Preload + parse every MIDI file (client midiCache prefill).
    for (const Track& t : impl->fetchedTracks) {
      auto f = cli.Get("/music/" + t.filename);
      if (!f || f->status != 200) continue;
      audio::MusicProgram prog;
      if (buildProgram(f->body, prog)) impl->fetchedCache[t.filename] = std::move(prog);
      else std::fprintf(stderr, "[music] failed to parse %s\n", t.filename.c_str());
    }
    return !impl->fetchedCache.empty();
  });
}

void Manager::update() {
  if (!impl || !impl->audio) return;
  // Adopt the finished background fetch.
  if (!impl->listReady && impl->fetchJob.valid() &&
      impl->fetchJob.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
    if (impl->fetchJob.get()) {
      impl->tracks = std::move(impl->fetchedTracks);
      impl->cache = std::move(impl->fetchedCache);
      impl->listReady = true;
      std::printf("[music] %zu tracks ready (%zu parsed)\n", impl->tracks.size(), impl->cache.size());
      // Random starting track so every session feels fresh (client behaviour).
      std::mt19937 rng((uint32_t)std::random_device{}());
      impl->index = (int)(rng() % impl->tracks.size());
      if (enabled_) startCurrent();
    }
  }
  // Auto-advance when the audio thread reports the track (+gap) has ended.
  if (impl->audio->musicConsumeFinished()) next();
  // Drive the bus every frame: saved volume while enabled, silent otherwise
  // (the client's applyOutputVolume guarantee).
  impl->audio->musicSetGain(enabled_ ? volume_ : 0.0f);
}

void Manager::startCurrent() {
  // Before the list arrives this is a no-op — update() starts playback when
  // the background fetch lands (enabled_ is re-checked there).
  if (!impl || !impl->listReady || impl->tracks.empty()) return;
  if (!enabled_) return;   // HARD GUARD (client): never schedule while disabled
  for (size_t tries = 0; tries < impl->tracks.size(); ++tries) {
    const Track& t = impl->tracks[(size_t)impl->index % impl->tracks.size()];
    auto it = impl->cache.find(t.filename);
    if (it != impl->cache.end()) {
      std::printf("[music] now playing: %s (%zu notes, %.0fs)\n",
                  t.name.c_str(), it->second.notes.size(), it->second.duration);
      impl->audio->musicPlay(audio::MusicProgram(it->second));   // copy — cache retains
      return;
    }
    impl->index = (impl->index + 1) % (int)impl->tracks.size();  // unparsable: skip it
  }
}

void Manager::resume() {
  if (enabled_) startCurrent();
}

void Manager::toggle() {
  enabled_ = !enabled_;
  if (!impl || !impl->audio) return;
  if (enabled_) startCurrent();
  else impl->audio->musicStop();
}

void Manager::next() {
  if (!impl || impl->tracks.empty()) return;
  impl->audio->musicStop();
  impl->index = (impl->index + 1) % (int)impl->tracks.size();
  if (enabled_) startCurrent();
}

void Manager::setVolume(float v) {
  volume_ = std::max(0.0f, std::min(1.0f, v));
}

void Manager::stop() {
  if (impl && impl->audio) impl->audio->musicStop();
}

std::string Manager::currentName() const {
  if (!impl || !impl->listReady || impl->tracks.empty()) return "-";
  return impl->tracks[(size_t)impl->index % impl->tracks.size()].name;
}

}  // namespace music
