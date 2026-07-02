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
#include <memory>
#include <string>

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
  void update(WGPUDevice device, WGPUQueue queue, float dt, double timeSec,
              const ShipInfo& ship, float storminess);

  // Draw everything (called inside the main pass, after terrain, before ocean).
  void draw(WGPURenderPassEncoder pass, WGPUQueue queue, const glm::mat4& viewProj,
            const glm::vec3& eye, const glm::vec3& lightDir, float dayK,
            double timeSec, float windAmp);

  struct Impl;   // public so the module's free helper functions can name it
private:
  std::unique_ptr<Impl> p_;
};

} // namespace scatter
