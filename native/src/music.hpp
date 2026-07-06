// Music manager (music.service.ts port): fetches the server's MIDI track list,
// parses every file up front (so every play is instant), starts on a random
// track, auto-advances with the 1.5 s gap, and exposes the same controls the
// client had: enable toggle, volume, next-track skip. Synthesis itself runs in
// audio::System (per-track GM-family synth voicings + shared reverb).
#pragma once

#include <string>

namespace audio { class System; }

namespace music {

class Manager {
public:
  // Kick off the background fetch+parse of the whole track list.
  void init(const std::string& host, int port, audio::System* audio,
            bool enabled, float volume);
  // Per-frame (game thread): adopt finished fetches, auto-advance, apply gain.
  void update();
  void toggle();
  void next();
  // Restart the current track if music is enabled — used on (re-)entering the
  // game after a logout stopped playback (the client re-inits on game entry).
  void resume();
  void setVolume(float v);          // 0..1 linear
  void stop();                      // teardown on logout (client dispose())
  bool enabled() const { return enabled_; }
  float volume() const { return volume_; }
  // Display name of the current track ("—" until the list arrives).
  std::string currentName() const;

  ~Manager();

private:
  void startCurrent();
  struct Impl;
  Impl* impl = nullptr;
  bool enabled_ = true;
  float volume_ = 0.1f;
};

}  // namespace music
