// Analytic Gerstner-wave ocean, shared between CPU (ship buoyancy) and the GPU
// (ocean surface displacement in shaders/ocean.wgsl). KEEP THE WAVE SET BELOW IN
// SYNC with the `kWaves` constants in ocean.wgsl.
//
// This mirrors, in spirit, the client's wave-engine.ts: a small sum of Gerstner
// waves gives a height field the hull samples to heave, pitch, and roll.
#pragma once
#include <cmath>
#include <glm/glm.hpp>

struct GerstnerWave {
  float dirX, dirZ;   // direction (normalized on use)
  float length;       // wavelength (m)
  float amplitude;    // crest height (m)
  float steepness;    // 0..1 horizontal pinch (visual only; CPU uses vertical sum)
};

inline constexpr GerstnerWave kWaves[4] = {
  { 1.0f,  0.0f, 60.0f, 0.60f, 0.55f },
  { 0.7f,  0.7f, 31.0f, 0.32f, 0.55f },
  {-0.6f,  0.8f, 18.0f, 0.16f, 0.45f },
  { 0.2f, -1.0f,  9.0f, 0.08f, 0.35f },
};
inline constexpr float kGravity = 9.81f;

// Vertical wave height at world (x,z) and time t. (Horizontal Gerstner pinch is
// applied only on the GPU for crest shape; for floating, the vertical sum is
// what the hull rides — matching the client's height-only buoyancy sampling.)
inline float oceanHeight(float x, float z, float t) {
  float y = 0.0f;
  for (const GerstnerWave& w : kWaves) {
    float len = std::sqrt(w.dirX * w.dirX + w.dirZ * w.dirZ);
    float dx = w.dirX / len, dz = w.dirZ / len;
    float k = 6.2831853f / w.length;
    float omega = std::sqrt(kGravity * k);
    float phase = k * (dx * x + dz * z) - omega * t;
    y += w.amplitude * std::sin(phase);
  }
  return y;
}

// Surface normal from the analytic height gradient (for hull pitch/roll).
inline glm::vec3 oceanNormal(float x, float z, float t) {
  float dhdx = 0.0f, dhdz = 0.0f;
  for (const GerstnerWave& w : kWaves) {
    float len = std::sqrt(w.dirX * w.dirX + w.dirZ * w.dirZ);
    float dx = w.dirX / len, dz = w.dirZ / len;
    float k = 6.2831853f / w.length;
    float omega = std::sqrt(kGravity * k);
    float phase = k * (dx * x + dz * z) - omega * t;
    float d = w.amplitude * std::cos(phase) * k;
    dhdx += d * dx;
    dhdz += d * dz;
  }
  return glm::normalize(glm::vec3(-dhdx, 1.0f, -dhdz));
}
