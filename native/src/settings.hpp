// Persisted user settings (~/.sailsim_settings, JSON) — the native equivalent
// of the client's localStorage keys. Loaded at startup, saved on every change.
#pragma once

namespace settings {

// Graphics quality, mirroring the client's settings-menu dials (keyed into the
// native's own systems). Presets bundle these; any manual tweak drops to Custom.
struct Graphics {
  int   preset = 3;              // -1 Custom, 0 Potato, 1 Low, 2 Medium, 3 High, 4 Ultra
  float renderScale = 1.0f;      // 0.5..1.0 — offscreen render res / swapchain res (perf lever)
  bool  adaptiveRes = false;     // fps-driven render-scale nudge (never above renderScale)
  float adaptiveTargetMs = 33.3f;// target frame time (16.7=60fps .. 66=15fps)
  int   aa = 1;                  // 0 Off, 1 FXAA (post edge-blur), 2 SMAA (morphological)
  int   ssaa = 0;                // supersampling: 0 Off(1x), 1 1.5x, 2 2x — multiplies render res; stacks with FXAA
  int   shadows = 2;             // 0 Off, 1 Low(1024), 2 Medium(2048), 3 High(4096)
  bool  ssao = true;
  bool  dof = true;
  bool  bloom = true;
  bool  reflections = true;      // planar water reflections (mirror pass) vs analytic sky only
  bool  waterTransparency = true;// shallow-water see-through
  int   scatter = 3;             // 0 Off, 1 Low .. 4 Ultra (foliage density + draw distance)
};

struct Values {
  float sfxVolume = 0.8f;     // client SfxService default
  float musicVolume = 0.1f;   // client MusicService default (gentle on first load)
  bool musicEnabled = true;   // client default: enabled
  Graphics gfx;
};

Values load();
void save(const Values& v);

// Overwrite g with the named preset (0..4); leaves g.preset set to that index.
// Mirrors the client settings-menu preset table (adapted to the native systems).
void applyPreset(Graphics& g, int preset);

// Shadow-map resolution (texels) for a shadows level (0 returns 0 = off).
int shadowRes(int level);

// Supersampling render-resolution multiplier for an ssaa level (0=1x,1=1.5x,2=2x).
float ssaaFactor(int level);

}  // namespace settings
