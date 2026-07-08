#include "settings.hpp"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "paths.hpp"

namespace settings {
namespace {

std::string path() { return paths::dataFile("settings.json"); }

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
    v.profanityFilter = j.value("profanityFilter", v.profanityFilter);
    v.invertCameraY = j.value("invertCameraY", v.invertCameraY);
    if (j.contains("gfx")) {
      const auto& g = j["gfx"];
      Graphics& x = v.gfx;
      x.preset = g.value("preset", x.preset);
      x.renderScale = std::max(0.5f, std::min(1.0f, g.value("renderScale", x.renderScale)));
      x.adaptiveRes = g.value("adaptiveRes", x.adaptiveRes);
      x.adaptiveTargetMs = std::max(16.7f, std::min(66.0f, g.value("adaptiveTargetMs", x.adaptiveTargetMs)));
      x.aa = std::max(0, std::min(2, g.value("aa", x.aa)));
      x.taa = g.value("taa", x.taa);
      x.taaUpscale = std::max(0.5f, std::min(1.0f, g.value("taaUpscale", x.taaUpscale)));
      x.ssaa = std::max(0, std::min(2, g.value("ssaa", x.ssaa)));
      x.shadows = std::max(0, std::min(4, g.value("shadows", x.shadows)));
      x.ssao = g.value("ssao", x.ssao);
      x.dof = g.value("dof", x.dof);
      x.bloom = g.value("bloom", x.bloom);
      x.reflections = g.value("reflections", x.reflections);
      x.ssr = g.value("ssr", x.ssr);
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
    { "profanityFilter", v.profanityFilter },
    { "invertCameraY", v.invertCameraY },
    { "gfx", {
      { "preset", g.preset }, { "renderScale", g.renderScale },
      { "adaptiveRes", g.adaptiveRes }, { "adaptiveTargetMs", g.adaptiveTargetMs },
      { "aa", g.aa }, { "taa", g.taa }, { "taaUpscale", g.taaUpscale },
      { "ssaa", g.ssaa }, { "shadows", g.shadows }, { "ssao", g.ssao }, { "dof", g.dof },
      { "bloom", g.bloom }, { "reflections", g.reflections }, { "ssr", g.ssr },
      { "waterTransparency", g.waterTransparency }, { "scatter", g.scatter },
    } },
  };
  std::ofstream f(path(), std::ios::trunc);
  if (f) f << j.dump(2) << "\n";
}

int shadowRes(int level) {
  switch (level) { case 1: return 1024; case 2: return 2048; case 3: return 4096; case 4: return 8192; default: return 0; }
}

float ssaaFactor(int level) {
  switch (level) { case 1: return 1.5f; case 2: return 2.0f; default: return 1.0f; }
}

void applyPreset(Graphics& g, int preset) {
  // Columns mirror the client's settings-menu preset table, mapped to the
  // native systems: render scale, shadows, AA, SSAO, DOF, bloom, reflections,
  // water transparency, scatter. (The native folds SSAO/DOF/bloom into the tier
  // the way the client's presets fold clouds/wildlife.)
  struct P { float render; int shadows, aa, ssaa; bool ssao, dof, bloom, refl, transp; int scatter; };
  static const P table[5] = {
    // Potato
    { 0.50f, 0, 0, 0, false, false, false, false, false, 0 },
    // Low
    { 0.65f, 1, 1, 0, false, false, true,  false, false, 1 },
    // Medium
    { 0.80f, 2, 1, 0, true,  false, true,  false, true,  2 },
    // High
    { 1.00f, 2, 1, 0, true,  true,  true,  true,  true,  3 },
    // Ultra — full render scale + 2x supersampling + the 8192 shadow tier.
    { 1.00f, 4, 1, 2, true,  true,  true,  true,  true,  4 },
  };
  if (preset < 0 || preset > 4) return;
  const P& p = table[preset];
  g.preset = preset;
  g.renderScale = p.render; g.shadows = p.shadows; g.aa = p.aa; g.ssaa = p.ssaa;
  g.ssao = p.ssao; g.dof = p.dof; g.bloom = p.bloom;
  g.reflections = p.refl; g.waterTransparency = p.transp; g.scatter = p.scatter;
}

}  // namespace settings
