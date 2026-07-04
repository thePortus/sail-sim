// Crew animation (native port, Phase 0): a per-member skeletal animator over the
// shared crew rig (crew_spike.glb). It plays a LOOPING clip with a short
// cross-fade from the outgoing clip — the native analogue of the client's
// AnimationGroup weight blend (crew.service.ts tickBlend / play) — and outputs a
// matrix palette in the exact layout the rigged mesh shader consumes:
//   [0, nodes)            = node world matrices
//   [nodes, nodes+joints) = jointWorld x inverseBind (the skin)
// The geometry, GPU buffers and pipelines are the SHARED rigged Mesh (createMesh);
// each crew member is just its own Animator + palette slot + placement matrix.
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include "gltf_rig.hpp"

namespace crew {

// Cross-fade window between clips (s) — the client's CLIP_BLEND_S.
constexpr float kClipBlendS = 0.22f;

// One crew member's skeletal state. Cheap: a handful of per-node TRS scratch
// arrays + two clip cursors. update() re-samples every frame from rest, so bones
// a clip doesn't touch stay at their bind pose.
class Animator {
 public:
  // rig = the shared crew RiggedData (nodes/skins/clips). seed desyncs loop phases
  // so a deck of members doesn't move in lockstep.
  Animator(std::shared_ptr<const RiggedData> rig, uint32_t seed);

  // Cross-fade into a clip by (stripped) name. A no-op if it's already the current
  // looping clip. Unknown names fall back to "Idle" (the client's play() contract).
  void play(const std::string& clip, bool loop = true, float speed = 1.0f);

  // Advance cursors + blend, re-sample, recompute the palette.
  void update(float dt);

  const std::vector<glm::mat4>& palette() const { return palette_; }
  bool hasClip(const std::string& name) const { return clips_.count(name) != 0; }
  const std::string& currentClip() const { return curName_; }

 private:
  struct Clip { float tMin = 0, tMax = 0; const RigClip* src = nullptr; };

  const Clip* resolve(const std::string& name) const;   // by name, else "Idle", else null
  float rng();                                           // 0..1 deterministic
  void advance(const Clip* c, float& cursor, float speed, bool loop, float dt) const;
  // Sample one clip at absolute time t (s) into per-node TRS arrays (pre-reset to rest).
  void sampleInto(const Clip& c, float t,
                  std::vector<glm::vec3>& lt, std::vector<glm::quat>& lr,
                  std::vector<glm::vec3>& ls) const;
  void recomputePalette();

  std::shared_ptr<const RiggedData> rig_;
  std::map<std::string, Clip> clips_;
  uint32_t rngState_;

  const Clip* cur_ = nullptr;
  const Clip* prev_ = nullptr;   // outgoing clip while blend_ < 1, else null
  std::string curName_, prevName_;
  float curT_ = 0.0f, prevT_ = 0.0f;      // cursor (s) within [tMin, tMax]
  float curSpeed_ = 1.0f, prevSpeed_ = 1.0f;
  bool curLoop_ = true, prevLoop_ = true;
  float blend_ = 1.0f;                     // 0->1 fade-in of cur over prev (1 = done)

  // Scratch (sized to rig node count): current pose, previous pose, blended, worlds.
  std::vector<glm::vec3> ct_, cs_, pt_, ps_, bt_, bs_;
  std::vector<glm::quat> cr_, pr_, br_;
  std::vector<glm::mat4> worlds_, palette_;
};

}  // namespace crew
