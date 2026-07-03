// Procedural audio (ports of ocean-audio.service.ts, the cloud.service rain
// ambience + thunder, and music.service.ts): weather-driven ocean/rain beds,
// one-shot thunder, and a polyphonic MIDI music synth with reverb. All
// synthesis happens in the miniaudio device callback; the game thread only
// pushes parameter targets and prepared note programs.
#pragma once

#include <vector>

namespace audio {

// A fully-prepared music track (music.service startCurrentTrack): per-MIDI-track
// synth voicings (the makeSynthForTrack GM-family table) + the flattened,
// time-sorted note events. Built on the game thread, consumed by the audio thread.
struct MusicSynthSpec {
  int osc = 0;              // 0 = triangle, 1 = sawtooth, 2 = square
  float attack = 0.04f, decay = 0.10f, sustain = 0.70f, release = 1.20f;
  float volLin = 0.2f;      // 10^(volumeDb/20)
};
struct MusicNote {
  double t = 0;             // seconds from track start
  float dur = 0.25f;        // seconds
  float freq = 440.0f;
  float vel = 0.8f;         // 0..1
  int synth = 0;            // index into MusicProgram::synths
};
struct MusicProgram {
  std::vector<MusicSynthSpec> synths;
  std::vector<MusicNote> notes;   // sorted by t
  double duration = 0;            // last note end (s); auto-advance at +1.5 s
};

class System {
public:
  System() = default;
  ~System();
  System(const System&) = delete;
  System& operator=(const System&) = delete;

  // Open the default output device (safe to skip/fail: everything else no-ops).
  bool init();
  // Ocean bed follows the wind (client: k = clamp(windSpeed/22)).
  void setWeather(float windSpeedMps);
  // Rain patter follows the eased precip intensity [0..1].
  void setRain(float intensity);
  // One-shot cannon fire (cannon.service playCannonSound, six synth layers) and
  // water-impact splash. vol 0..1 (callers distance-attenuate: 1 - d/800).
  void playCannon(float vol);
  void playSplash(float vol);
  // Demasting: creaking groan + volley of wood cracks (mast-crack.service).
  void playMastCrack(float vol);
  // One-shot procedural thunder (cloud.service playThunder): vol 0..1 sets the
  // rumble's brightness, attack sharpness and length (distant rolls longer).
  void playThunder(float vol);
  // SFX master volume (the client's Sound slider) — scales the beds + thunder.
  void setMasterVolume(float v);

  // ── Music (music.service.ts synth playback) ──
  // Swap in a prepared track and restart the playhead (game thread).
  void musicPlay(MusicProgram&& program);
  void musicStop();
  // Music bus gain, INDEPENDENT of the SFX master (the client's separate
  // Tone destination). Pass 0 while music is toggled off.
  void musicSetGain(float linear);
  // True exactly once when the current track has played out (+1.5 s gap) —
  // the caller advances to the next track (music.service auto-advance).
  bool musicConsumeFinished();
  // Master fade (login screen / docked menus mute the beds like leaving the scene).
  void setEnabled(bool on);
  void shutdown();

  struct Impl;   // public: the miniaudio C callback needs to name it

private:
  Impl* impl = nullptr;
};

}  // namespace audio
