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
    if (j.contains("gfx")) {
      const auto& g = j["gfx"];
      Graphics& x = v.gfx;
      x.preset = g.value("preset", x.preset);
      x.renderScale = std::max(0.5f, std::min(1.0f, g.value("renderScale", x.renderScale)));
      x.adaptiveRes = g.value("adaptiveRes", x.adaptiveRes);
      x.adaptiveTargetMs = std::max(16.7f, std::min(66.0f, g.value("adaptiveTargetMs", x.adaptiveTargetMs)));
      x.aa = std::max(0, std::min(1, g.value("aa", x.aa)));
      x.shadows = std::max(0, std::min(3, g.value("shadows", x.shadows)));
      x.ssao = g.value("ssao", x.ssao);
      x.dof = g.value("dof", x.dof);
      x.bloom = g.value("bloom", x.bloom);
      x.reflections = g.value("reflections", x.reflections);
      x.waterTransparency = g.value("waterTransparency", x.waterTransparency);
      x.scatter = std::max(0, std::min(4, g.value("scatter", x.scatter)));
    }
  } catch (...) { /* corrupt file: fall back to defaults */ }
  return v;
}

void save(const Values& v) {
  const Graphics& g = v.gfx;
  nlohmann::json j{
    { "sfxVolume", v.sfxVolume },
    { "musicVolume", v.musicVolume },
    { "musicEnabled", v.musicEnabled },
    { "gfx", {
      { "preset", g.preset }, { "renderScale", g.renderScale },
      { "adaptiveRes", g.adaptiveRes }, { "adaptiveTargetMs", g.adaptiveTargetMs },
      { "aa", g.aa }, { "shadows", g.shadows }, { "ssao", g.ssao }, { "dof", g.dof },
      { "bloom", g.bloom }, { "reflections", g.reflections },
      { "waterTransparency", g.waterTransparency }, { "scatter", g.scatter },
    } },
  };
  std::ofstream f(path(), std::ios::trunc);
  if (f) f << j.dump(2) << "\n";
}

int shadowRes(int level) {
  switch (level) { case 1: return 1024; case 2: return 2048; case 3: return 4096; default: return 0; }
}

void applyPreset(Graphics& g, int preset) {
  // Columns mirror the client's settings-menu preset table, mapped to the
  // native systems: render scale, shadows, AA, SSAO, DOF, bloom, reflections,
  // water transparency, scatter. (The native folds SSAO/DOF/bloom into the tier
  // the way the client's presets fold clouds/wildlife.)
  struct P { float render; int shadows, aa; bool ssao, dof, bloom, refl, transp; int scatter; };
  static const P table[5] = {
    // Potato
    { 0.50f, 0, 0, false, false, false, false, false, 0 },
    // Low
    { 0.65f, 1, 1, false, false, true,  false, false, 1 },
    // Medium
    { 0.80f, 2, 1, true,  false, true,  false, true,  2 },
    // High
    { 1.00f, 2, 1, true,  true,  true,  true,  true,  3 },
    // Ultra
    { 1.00f, 3, 1, true,  true,  true,  true,  true,  4 },
  };
  if (preset < 0 || preset > 4) return;
  const P& p = table[preset];
  g.preset = preset;
  g.renderScale = p.render; g.shadows = p.shadows; g.aa = p.aa;
  g.ssao = p.ssao; g.dof = p.dof; g.bloom = p.bloom;
  g.reflections = p.refl; g.waterTransparency = p.transp; g.scatter = p.scatter;
}

}  // namespace settings
