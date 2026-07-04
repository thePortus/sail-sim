// Crew skeletal animator — see crew.hpp. The sampler mirrors vanim::scrubNorm
// (keyframe find + linear/slerp interpolation) but is TIME-based and LOOPING, and
// blends two clips per node so a clip switch cross-fades instead of snapping.

#include "crew.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

#include <glm/gtc/matrix_transform.hpp>

namespace crew {
namespace {

// Strip the loader's 'NLA_' prefix + trailing '.NNN' duplicate-datablock suffix,
// matching vanim::stripName so clip names line up with the client's.
std::string stripName(std::string n) {
  if (n.rfind("NLA_", 0) == 0) n = n.substr(4);
  size_t dot = n.find_last_of('.');
  if (dot != std::string::npos && dot + 1 < n.size() && n.size() - dot - 1 >= 3 &&
      n.find_first_not_of("0123456789", dot + 1) == std::string::npos) {
    n = n.substr(0, dot);
  }
  return n;
}

glm::mat4 composeTRS(const glm::vec3& t, const glm::quat& r, const glm::vec3& s) {
  glm::mat4 m = glm::translate(glm::mat4(1.0f), t);
  m *= glm::mat4_cast(r);
  return glm::scale(m, s);
}

}  // namespace

Animator::Animator(std::shared_ptr<const RiggedData> rig, uint32_t seed)
    : rig_(std::move(rig)), rngState_(seed ? seed : 0x9e3779b9u) {
  for (const RigClip& c : rig_->clips) {
    Clip clip;
    clip.tMin = c.tMin; clip.tMax = c.tMax; clip.src = &c;
    clips_[stripName(c.name)] = clip;
  }
  const size_t n = rig_->nodes.size();
  ct_.resize(n); cs_.resize(n); cr_.resize(n);
  pt_.resize(n); ps_.resize(n); pr_.resize(n);
  bt_.resize(n); bs_.resize(n); br_.resize(n);
  worlds_.resize(n);
  palette_ = rig_->restPalette;

  // Start on Idle at a random loop phase so a crew doesn't breathe in unison.
  play("Idle", true, 1.0f);
  if (cur_) curT_ = cur_->tMin + rng() * std::max(1e-4f, cur_->tMax - cur_->tMin);
  blend_ = 1.0f; prev_ = nullptr;
}

float Animator::rng() {
  // mulberry32 — deterministic, matches the client's crew PRNG family.
  uint32_t& a = rngState_;
  a += 0x6D2B79F5u;
  uint32_t t = a;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return ((t ^ (t >> 14)) >> 0) / 4294967296.0f;
}

const Animator::Clip* Animator::resolve(const std::string& name) const {
  auto it = clips_.find(name);
  if (it != clips_.end()) return &it->second;
  it = clips_.find("Idle");
  return it != clips_.end() ? &it->second : nullptr;
}

void Animator::play(const std::string& clip, bool loop, float speed) {
  const Clip* next = resolve(clip);
  if (!next) return;
  const std::string resolved = (clips_.count(clip) ? clip : std::string("Idle"));
  if (next == cur_ && loop && curLoop_) { curSpeed_ = speed; return; }   // already looping this

  // Push the current clip to the outgoing slot and cross-fade the new one in.
  prev_ = cur_; prevName_ = curName_;
  prevT_ = curT_; prevSpeed_ = curSpeed_; prevLoop_ = curLoop_;
  cur_ = next; curName_ = resolved;
  curLoop_ = loop; curSpeed_ = speed;
  curT_ = next->tMin + (loop ? rng() * std::max(1e-4f, next->tMax - next->tMin) : 0.0f);
  blend_ = prev_ ? 0.0f : 1.0f;
}

void Animator::advance(const Clip* c, float& cursor, float speed, bool loop, float dt) const {
  if (!c) return;
  const float span = std::max(1e-4f, c->tMax - c->tMin);
  cursor += dt * speed;
  if (loop) {
    float u = std::fmod(cursor - c->tMin, span);
    if (u < 0.0f) u += span;
    cursor = c->tMin + u;
  } else {
    cursor = std::min(cursor, c->tMax);
  }
}

void Animator::sampleInto(const Clip& c, float t,
                          std::vector<glm::vec3>& lt, std::vector<glm::quat>& lr,
                          std::vector<glm::vec3>& ls) const {
  // Reset to the bind pose so untouched bones hold rest.
  for (size_t i = 0; i < rig_->nodes.size(); ++i) {
    lt[i] = rig_->nodes[i].t; lr[i] = rig_->nodes[i].r; ls[i] = rig_->nodes[i].s;
  }
  for (const RigChannel& ch : c.src->channels) {
    if (ch.times.empty() || ch.node < 0) continue;
    const auto& times = ch.times;
    size_t k = 0;
    while (k + 1 < times.size() && times[k + 1] < t) ++k;
    glm::vec4 v;
    if (k + 1 >= times.size() || ch.step) {
      v = ch.values[std::min(k, ch.values.size() - 1)];
    } else {
      const float u = glm::clamp((t - times[k]) / std::max(1e-6f, times[k + 1] - times[k]), 0.0f, 1.0f);
      if (ch.path == 1) {   // rotation: slerp the quaternions
        glm::quat a(ch.values[k].w, ch.values[k].x, ch.values[k].y, ch.values[k].z);
        glm::quat b(ch.values[k + 1].w, ch.values[k + 1].x, ch.values[k + 1].y, ch.values[k + 1].z);
        lr[(size_t)ch.node] = glm::slerp(a, b, u);
        continue;
      }
      v = glm::mix(ch.values[k], ch.values[k + 1], u);
    }
    if (ch.path == 0) lt[(size_t)ch.node] = glm::vec3(v);
    else if (ch.path == 1) lr[(size_t)ch.node] = glm::quat(v.w, v.x, v.y, v.z);
    else ls[(size_t)ch.node] = glm::vec3(v);
  }
}

void Animator::recomputePalette() {
  const size_t n = rig_->nodes.size();
  for (size_t i = 0; i < n; ++i) {
    const int p = rig_->nodes[i].parent;
    const glm::mat4 local = composeTRS(bt_[i], br_[i], bs_[i]);
    worlds_[i] = p < 0 ? local : worlds_[(size_t)p] * local;
  }
  // glTF doesn't guarantee parent-before-child ordering; converge with a few
  // cheap passes (trees are shallow) — same as vanim::recomputePalette.
  for (int pass = 0; pass < 4; ++pass) {
    bool changed = false;
    for (size_t i = 0; i < n; ++i) {
      const int p = rig_->nodes[i].parent;
      const glm::mat4 expect = (p < 0 ? glm::mat4(1.0f) : worlds_[(size_t)p]) * composeTRS(bt_[i], br_[i], bs_[i]);
      if (std::memcmp(&expect, &worlds_[i], sizeof(glm::mat4)) != 0) { worlds_[i] = expect; changed = true; }
    }
    if (!changed) break;
  }
  for (size_t i = 0; i < n; ++i) palette_[i] = worlds_[i];
  size_t base = n;
  for (const RigSkin& skin : rig_->skins) {
    for (size_t j = 0; j < skin.joints.size(); ++j)
      palette_[base + j] = worlds_[(size_t)skin.joints[j]] * skin.invBind[j];
    base += skin.joints.size();
  }
}

void Animator::update(float dt) {
  if (!cur_) return;
  advance(cur_, curT_, curSpeed_, curLoop_, dt);

  sampleInto(*cur_, curT_, ct_, cr_, cs_);
  if (prev_ && blend_ < 1.0f) {
    advance(prev_, prevT_, prevSpeed_, prevLoop_, dt);
    sampleInto(*prev_, prevT_, pt_, pr_, ps_);
    blend_ = std::min(1.0f, blend_ + dt / kClipBlendS);
    const float w = blend_;   // 0 = all prev, 1 = all cur
    for (size_t i = 0; i < rig_->nodes.size(); ++i) {
      bt_[i] = glm::mix(pt_[i], ct_[i], w);
      bs_[i] = glm::mix(ps_[i], cs_[i], w);
      br_[i] = glm::slerp(pr_[i], cr_[i], w);
    }
    if (blend_ >= 1.0f) prev_ = nullptr;
  } else {
    bt_ = ct_; bs_ = cs_; br_ = cr_;
    prev_ = nullptr;
  }
  recomputePalette();
}

}  // namespace crew
