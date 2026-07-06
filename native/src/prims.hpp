// Dynamic primitive renderer — CPU-tessellated coloured triangles rebuilt per
// frame and drawn in one (opaque) + one (translucent) pipeline. Serves the
// combat visuals: cannonballs / bar-shot dumbbells (opaque), aim-arc tubes and
// the lock reticle (translucent, additive-ish alpha).
#pragma once

#include <vector>

#include <glm/glm.hpp>
#include <webgpu/webgpu.h>

namespace prims {

class System {
 public:
  bool init(WGPUDevice device, WGPUTextureFormat colorFormat);

  // ── Per-frame immediate-mode builders (world space) ──
  void clear();
  void tri(const glm::vec3& a, const glm::vec3& b, const glm::vec3& c,
           const glm::vec4& color, bool translucent);
  // Per-vertex colours (radial-fade fans: scorch decals).
  void tri3(const glm::vec3& a, const glm::vec3& b, const glm::vec3& c,
            const glm::vec4& ca, const glm::vec4& cb, const glm::vec4& cc, bool translucent);
  // Low-poly UV sphere (balls; lit by a fixed pseudo-light for cheap shading).
  void sphere(const glm::vec3& center, float radius, const glm::vec4& color,
              const glm::mat3& orient = glm::mat3(1.0f));
  // Axis cylinder between two points (bar-shot bars, tube segments).
  void cylinder(const glm::vec3& a, const glm::vec3& b, float radius,
                const glm::vec4& color, int sides, bool translucent);
  // Polyline tube (aim arcs).
  void tube(const std::vector<glm::vec3>& path, float radius,
            const glm::vec4& color, int sides = 6);
  // Camera-facing quad (reticle brackets).
  void billboard(const glm::vec3& center, const glm::vec3& camRight, const glm::vec3& camUp,
                 float w, float h, const glm::vec4& color);

  // ── Textured decal triangles (town roads / ground): a separate batch sampled from
  //    ONE decal texture set via setDecalTexture(). Alpha-blended, no depth write
  //    (draped on the terrain). UV convention: U across (clamp), V along (wraps). ──
  void setDecalTexture(WGPUDevice device, WGPUTextureView view);   // call once after init()
  void triTex(const glm::vec3& a, const glm::vec3& b, const glm::vec3& c,
              const glm::vec2& ua, const glm::vec2& ub, const glm::vec2& uc);

  // Upload + draw into the current pass (main pass, after the ocean).
  void flush(WGPUDevice device, WGPUQueue queue, WGPURenderPassEncoder pass,
             const glm::mat4& viewProj);

 private:
  struct Vtx { glm::vec3 pos; glm::vec4 color; };
  struct TVtx { glm::vec3 pos; glm::vec2 uv; };
  std::vector<Vtx> opaque_, trans_;
  std::vector<TVtx> tex_;
  WGPURenderPipeline pipeOpaque_ = nullptr, pipeTrans_ = nullptr, pipeTex_ = nullptr;
  WGPUBindGroup bind_ = nullptr, texBind_ = nullptr;
  WGPUBindGroupLayout texBgl_ = nullptr;
  WGPUSampler texSampler_ = nullptr;
  WGPUBuffer ubuf_ = nullptr, vbuf_ = nullptr, tvbuf_ = nullptr;
  uint64_t vbufCap_ = 0, tvbufCap_ = 0;
};

}  // namespace prims
