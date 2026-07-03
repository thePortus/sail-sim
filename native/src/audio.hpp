// Procedural audio beds (ports of ocean-audio.service.ts + the cloud.service rain
// ambience): a continuous ocean wash driven by the wind, and a rain-patter noise
// bed driven by precipitation intensity. All synthesis happens in the miniaudio
// device callback; the game thread only pushes parameter targets.
#pragma once

namespace audio {

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
  // One-shot procedural thunder (cloud.service playThunder): vol 0..1 sets the
  // rumble's brightness, attack sharpness and length (distant rolls longer).
  void playThunder(float vol);
  // Master fade (login screen / docked menus mute the beds like leaving the scene).
  void setEnabled(bool on);
  void shutdown();

  struct Impl;   // public: the miniaudio C callback needs to name it

private:
  Impl* impl = nullptr;
};

}  // namespace audio
