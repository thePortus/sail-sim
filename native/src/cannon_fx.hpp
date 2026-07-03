// Combat visual effects — faithful ports of the client's shader FX + particle
// systems: the raymarched volumetric muzzle fireball (muzzle-explosion.ts, 44/26
// step tiers), simplex-fbm billboard smoke with soft depth fade (muzzle-smoke.ts
// belch + lingering pall), and the cannon.service particle bursts (water spout,
// land dirt + pall, ship splinters + fire gust + sooty smoke).
#pragma once

#include <string>
#include <vector>

#include <glm/glm.hpp>
#include <webgpu/webgpu.h>

namespace fx {

class System {
 public:
  // sceneDepth = the pre-ocean depth snapshot view (ships + terrain) the smoke
  // soft-fades against; proj = (p00, p11, p22, p32) to linearise it.
  bool init(WGPUDevice device, WGPUTextureFormat colorFormat);

  // ── Spawns (world space) ──
  // Full muzzle effect: fireball + smoke belch + lingering pall (client
  // muzzleEffect). camDist picks the fireball's quality tier once at spawn.
  void muzzleBlast(const glm::vec3& muzzle, float dirX, float dirZ, float camDist);
  void shipHit(const glm::vec3& p, const glm::vec3& dirIn);   // splinters + fire + soot
  void waterSplash(const glm::vec3& p, const glm::vec3& velIn);
  void landHit(const glm::vec3& p, const glm::vec3& velIn);   // dirt burst + dust pall

  void update(float dt, float windX, float windZ);

  // Draw into the main pass AFTER the ocean. camRight/camUp/camFwd from the view
  // matrix rows; camPos for the smoke soft-fade view distance.
  void draw(WGPUDevice device, WGPUQueue queue, WGPURenderPassEncoder pass,
            const glm::mat4& viewProj, const glm::vec3& camRight, const glm::vec3& camUp,
            const glm::vec3& camFwd, const glm::vec3& camPos,
            WGPUTextureView sceneDepth, const glm::vec4& proj);

  bool anyActive() const;

 private:
  struct Impl;
  Impl* p_ = nullptr;
};

}  // namespace fx
