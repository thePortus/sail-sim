// Scatter system — native port of the Angular client's scatter.service /
// scatter-compute: coastal palms, forest beeches, rocks, driftwood placed by
// the SAME hash/fbm gate kernels (CPU twins of the WGSL compute), streamed in
// 40 m patches around the ship; plus the living layer — seagull flocks,
// porpoising dolphin pods, and fish schools in the shallows — animated on the
// CPU (paths) + in the vertex shader (wing flap / body undulation / wiggle).
// Everything draws through one instanced pipeline (mesh + per-instance 3x4
// transform + tint), before the ocean so submerged props show through the
// transparent shallows.
#pragma once
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <glm/glm.hpp>
#include <webgpu/webgpu.h>

namespace terrain { class Terrain; }

namespace scatter {

class System {
public:
  System();
  ~System();
  System(const System&) = delete;
  System& operator=(const System&) = delete;

  // Load meshes/textures (synchronous, from <geometryDir>/scatter) and build the
  // pipeline. Returns false if the asset directory is missing (system disabled).
  bool init(WGPUDevice device, WGPUQueue queue, WGPUTextureFormat colorFormat,
            const std::string& scatterDir);

  // Placement needs the world heightfield; call once terrain has loaded.
  void setTerrain(const terrain::Terrain* terr);

  // The player's boat, as the wildlife behaviours see it (bow-riding dolphins,
  // wake-following gulls, hull-fleeing fish, raft startle).
  struct ShipInfo { float x = 0, z = 0, headingRad = 0, speedMps = 0; bool anchored = false; };

  // Stream patches around the ship + advance the wildlife (exact client ports).
  // waveHeight(x, z) = the displaced ocean surface (the buoyancy fftHeight) so
  // swimmers clamp under the REAL surface — a storm trough must never expose a
  // dolphin or fish in mid-air. Null = flat sea level.
  void update(WGPUDevice device, WGPUQueue queue, float dt, double timeSec,
              const ShipInfo& ship, float storminess,
              const std::function<float(float, float)>& waveHeight = nullptr);

  // Draw everything (called inside the main pass, after terrain, before ocean).
  void draw(WGPURenderPassEncoder pass, WGPUQueue queue, const glm::mat4& viewProj,
            const glm::vec3& eye, const glm::vec3& lightDir, float dayK,
            double timeSec, float windAmp);

  // ── Gull-cry audio events (bird.service cryBurst / updateAmbientCalls) ──
  // update() queues cries at world positions (startled rafts burst 5-12 calls;
  // the nearest flock makes an occasional relaxed call). The caller drains them
  // each frame, attenuates by camera distance and pans by view space, then
  // hands them to the audio system.
  struct CryEvent { float x, y, z, level, pitch, delay; };
  std::vector<CryEvent> drainCries();

  // Flush every resting raft within `radius` of (x, z) — a cannon going off
  // (client BirdService.startleAt, CANNON_RADIUS 130 m). Startled rafts cry.
  void startleAt(float x, float z, float radius = 130.0f);

  struct Impl;   // public so the module's free helper functions can name it
private:
  std::unique_ptr<Impl> p_;
};

} // namespace scatter
