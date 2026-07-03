// Persisted user settings (~/.sailsim_settings, JSON) — the native equivalent
// of the client's localStorage keys (sfx-volume, ignis_music_enabled,
// ignis_music_volume). Loaded at startup, saved on every change.
#pragma once

namespace settings {

struct Values {
  float sfxVolume = 0.8f;     // client SfxService default
  float musicVolume = 0.1f;   // client MusicService default (gentle on first load)
  bool musicEnabled = true;   // client default: enabled
};

Values load();
void save(const Values& v);

}  // namespace settings
