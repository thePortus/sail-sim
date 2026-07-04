// Crew skeletal animator — see crew.hpp. The sampler mirrors vanim::scrubNorm
// (keyframe find + linear/slerp interpolation) but is TIME-based and LOOPING, and
// blends two clips per node so a clip switch cross-fades instead of snapping.

#include "crew.hpp"

#include <algorithm>
#include <cctype>
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

// ── Kit (look) selection — a native port of applyKitVariants ──────────────────
namespace {
struct KitRng {   // mulberry32, matching the Animator/client PRNG family
  uint32_t a;
  explicit KitRng(uint32_t s) : a(s ? s : 0x9e3779b9u) {}
  float operator()() {
    a += 0x6D2B79F5u; uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return ((t ^ (t >> 14)) >> 0) / 4294967296.0f;
  }
};
template <size_t N>
glm::vec3 pick(KitRng& r, const float (&tbl)[N][3]) {
  size_t i = (size_t)(r() * N); if (i >= N) i = N - 1;
  return glm::vec3(tbl[i][0], tbl[i][1], tbl[i][2]);
}
// Colour tables lifted verbatim from applyKitVariants.
const float SHIRT[5][3] = {{0.86f,0.80f,0.66f},{0.92f,0.92f,0.86f},{0.36f,0.46f,0.60f},{0.60f,0.15f,0.11f},{0.74f,0.62f,0.44f}};
const float COAT[5][3]  = {{0.24f,0.13f,0.08f},{0.07f,0.09f,0.18f},{0.05f,0.05f,0.06f},{0.34f,0.10f,0.08f},{0.09f,0.17f,0.11f}};
const float BREE[5][3]  = {{0.24f,0.17f,0.11f},{0.15f,0.10f,0.06f},{0.26f,0.26f,0.28f},{0.06f,0.06f,0.07f},{0.10f,0.12f,0.20f}};
const float SASH[5][3]  = {{0.60f,0.09f,0.07f},{0.66f,0.54f,0.11f},{0.16f,0.26f,0.52f},{0.11f,0.34f,0.14f},{0.05f,0.05f,0.06f}};
const float BAND[4][3]  = {{0.60f,0.09f,0.07f},{0.16f,0.26f,0.52f},{0.05f,0.05f,0.06f},{0.22f,0.14f,0.09f}};
const float BOOT[4][3]  = {{0.16f,0.09f,0.05f},{0.10f,0.06f,0.04f},{0.05f,0.04f,0.035f},{0.22f,0.12f,0.06f}};
const float VEST[6][3]  = {{0.24f,0.17f,0.10f},{0.30f,0.30f,0.32f},{0.14f,0.16f,0.26f},{0.40f,0.12f,0.10f},{0.18f,0.22f,0.15f},{0.10f,0.10f,0.12f}};
const float CAP[6][3]   = {{0.30f,0.20f,0.12f},{0.34f,0.34f,0.36f},{0.13f,0.17f,0.30f},{0.46f,0.13f,0.11f},{0.64f,0.56f,0.42f},{0.15f,0.24f,0.17f}};
const float TRI[3][3]   = {{0.05f,0.05f,0.06f},{0.17f,0.11f,0.07f},{0.10f,0.12f,0.22f}};
const float NECK[5][3]  = {{0.56f,0.11f,0.09f},{0.14f,0.23f,0.44f},{0.82f,0.80f,0.74f},{0.68f,0.54f,0.13f},{0.16f,0.35f,0.19f}};
const float HAIR[5][3]  = {{0.06f,0.045f,0.03f},{0.11f,0.07f,0.04f},{0.20f,0.14f,0.08f},{0.46f,0.43f,0.41f},{0.30f,0.16f,0.07f}};

std::string kitBase(const std::string& n) {
  std::string s = n;
  size_t p = s.find_last_of('.');   // strip '.NNN' + '_primitiveN'
  if (p != std::string::npos) s = s.substr(0, p);
  p = s.find("_primitive"); if (p != std::string::npos) s = s.substr(0, p);
  for (char& c : s) c = (char)std::tolower((unsigned char)c);
  return s;
}
bool has(const std::string& hay, const char* needle) { return hay.find(needle) != std::string::npos; }
}  // namespace

Kit makeKit(uint32_t seed) {
  KitRng r(seed);
  Kit k;
  k.female = r() < 0.16f;
  const float bulk = r();
  k.heavy = bulk > 0.64f ? 0.45f + r() * 0.5f : 0.0f;
  k.lean  = (k.heavy == 0.0f && bulk < 0.34f) ? 0.35f + r() * 0.5f : 0.0f;
  k.fem   = k.female ? 0.9f + r() * 0.1f : 0.0f;
  // Shirt: ~30% striped (texture in the client; here just a bluish/red tint), else linen.
  if (r() < 0.3f) { k.tintShirt = r() < 0.6f ? glm::vec3(0.20f,0.24f,0.42f) : glm::vec3(0.55f,0.14f,0.12f); }
  else            { k.tintShirt = pick(r, SHIRT); }
  k.tintBreeches = pick(r, BREE);
  k.tintSash     = pick(r, SASH);
  k.tintBoots    = pick(r, BOOT);
  // Outer layer.
  const float ro = r();
  k.outer = k.female ? (ro < 0.30f ? 1 : ro < 0.45f ? 2 : 0)
                     : (ro < 0.28f ? 1 : ro < 0.60f ? 2 : 0);
  if (k.outer == 1) k.tintVest = pick(r, VEST);
  else if (k.outer == 2) k.tintCoat = pick(r, COAT);
  // Headwear.
  const float rh = r();
  k.hat = k.female ? (rh < 0.55f ? 1 : rh < 0.74f ? 2 : rh < 0.82f ? 3 : 0)
                   : (rh < 0.30f ? 1 : rh < 0.58f ? 2 : rh < 0.72f ? 3 : 0);
  if (k.hat == 1) k.tintHat = pick(r, BAND);
  else if (k.hat == 2) k.tintHat = pick(r, CAP);
  else if (k.hat == 3) k.tintHat = pick(r, TRI);
  // Neckerchief (~35%).
  k.neckerchief = r() < 0.35f;
  if (k.neckerchief) k.tintNeck = pick(r, NECK);
  // Long hair only on a bare head (the client also gates on a haired face texture).
  k.hairLong = k.hat == 0 && r() < (k.female ? 0.8f : 0.4f);
  if (k.hairLong) k.tintHair = pick(r, HAIR);
  // Stature.
  k.stature = 0.93f + r() * 0.13f;
  if (k.female) k.stature *= 0.95f;
  if (k.heavy > 0.0f) k.stature *= 1.02f;
  return k;
}

bool kitShowsSubmesh(const Kit& k, const std::string& submeshName) {
  const std::string b = kitBase(submeshName);
  if (has(b, "vest"))       return k.outer == 1;
  if (has(b, "coat"))       return k.outer == 2;
  if (has(b, "bandana"))    return k.hat == 1;
  if (has(b, "cap"))        return k.hat == 2;
  if (has(b, "tricorn"))    return k.hat == 3;
  if (has(b, "hair"))       return k.hairLong;
  if (has(b, "neckerchief"))return k.neckerchief;
  return true;   // shirt / breeches / boots / sash / base / eyes always show
}

int garmentTintSlot(const std::string& submeshName) {
  const std::string b = kitBase(submeshName);
  if (has(b, "shirt"))      return 0;
  if (has(b, "coat"))       return 1;
  if (has(b, "vest"))       return 2;
  if (has(b, "breeches"))   return 3;
  if (has(b, "sash"))       return 4;
  if (has(b, "boots"))      return 5;
  if (has(b, "bandana") || has(b, "cap") || has(b, "tricorn")) return 6;
  if (has(b, "hair"))       return 7;
  if (has(b, "neckerchief"))return 8;
  return -1;   // base / eyes: skin, no per-member tint yet
}

glm::vec3 kitTintFor(const Kit& k, int slot) {
  switch (slot) {
    case 0: return k.tintShirt; case 1: return k.tintCoat; case 2: return k.tintVest;
    case 3: return k.tintBreeches; case 4: return k.tintSash; case 5: return k.tintBoots;
    case 6: return k.tintHat; case 7: return k.tintHair; case 8: return k.tintNeck;
    default: return glm::vec3(1.0f);
  }
}

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
