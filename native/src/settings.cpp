#include "settings.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

namespace settings {
namespace {

std::string path() {
  const char* home = std::getenv("HOME");
  if (!home) home = std::getenv("USERPROFILE");   // Windows
  std::string dir = home ? home : ".";
  return dir + "/.sailsim_settings";
}

float clamp01(float v) { return std::max(0.0f, std::min(1.0f, v)); }

}  // namespace

Values load() {
  Values v;
  std::ifstream f(path());
  if (!f) return v;
  try {
    nlohmann::json j = nlohmann::json::parse(f);
    v.sfxVolume = clamp01(j.value("sfxVolume", v.sfxVolume));
    v.musicVolume = clamp01(j.value("musicVolume", v.musicVolume));
    v.musicEnabled = j.value("musicEnabled", v.musicEnabled);
  } catch (...) { /* corrupt file: fall back to defaults */ }
  return v;
}

void save(const Values& v) {
  nlohmann::json j{
    { "sfxVolume", v.sfxVolume },
    { "musicVolume", v.musicVolume },
    { "musicEnabled", v.musicEnabled },
  };
  std::ofstream f(path(), std::ios::trunc);
  if (f) f << j.dump(2) << "\n";
}

}  // namespace settings
