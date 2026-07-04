// Crew skeletal animator — see crew.hpp. The sampler mirrors vanim::scrubNorm
// (keyframe find + linear/slerp interpolation) but is TIME-based and LOOPING, and
// blends two clips per node so a clip switch cross-fades instead of snapping.

#include "crew.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <fstream>
#include <limits>

#include <glm/gtc/matrix_transform.hpp>
#include <nlohmann/json.hpp>

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

// ── Deck (station/waypoint lifecycle) ────────────────────────────────────────
namespace {
constexpr float kPi2 = 6.28318530718f;
float mul32(uint32_t& a) {
  a += 0x6D2B79F5u; uint32_t t = a;
  t = (t ^ (t >> 15)) * (t | 1u);
  t ^= t + (t ^ (t >> 7)) * (t | 61u);
  return ((t ^ (t >> 14)) >> 0) / 4294967296.0f;
}
float wrapPi(float d) { while (d > 3.14159265f) d -= kPi2; while (d < -3.14159265f) d += kPi2; return d; }
}  // namespace

float Member::rand() { return mul32(rngState); }
float Deck::rand()   { return mul32(rootRng_); }

Deck::Deck(std::shared_ptr<const RiggedData> rig, const std::string& layoutPath, uint32_t seed,
           int count, const glm::mat4& inner, std::vector<glm::vec3> deckTris, float bowYaw, float walkSpeed)
    : rig_(std::move(rig)), deckTris_(std::move(deckTris)), walkSpeed_(walkSpeed), rootRng_(seed ? seed : 1u) {
  std::ifstream f(layoutPath);
  if (!f) { std::fprintf(stderr, "[crew] layout not found: %s\n", layoutPath.c_str()); return; }
  nlohmann::json j;
  try { j = nlohmann::json::parse(f); }
  catch (...) { std::fprintf(stderr, "[crew] layout parse failed: %s\n", layoutPath.c_str()); return; }

  auto toRL = [&](const nlohmann::json& a) {
    glm::vec3 raw((float)a[0], (float)a[1], (float)a[2]);
    return glm::vec3(inner * glm::vec4(raw, 1.0f));
  };
  deckLift_ = j.value("deck_lift", 0.0f);
  if (j.contains("waypoints"))
    for (auto it = j["waypoints"].begin(); it != j["waypoints"].end(); ++it) {
      glm::vec3 p = toRL(it.value()); deckSnap(p); waypoints_[it.key()] = p;
    }
  if (j.contains("edges"))
    for (const auto& e : j["edges"]) {
      const std::string a = e[0], b = e[1];
      std::string kind = e.size() > 2 && e[2].is_object() ? e[2].value("kind", "walk") : "walk";
      adj_[a].push_back({ b, kind }); adj_[b].push_back({ a, kind });
    }
  if (j.contains("stations"))
    for (const auto& s : j["stations"]) {
      Station st;
      st.id = s.value("id", ""); st.kind = s.value("kind", ""); st.clip = s.value("clip", "Idle");
      st.wp = s.value("wp", ""); st.pos = toRL(s["pos"]);
      st.yaw = glm::radians(s.value("heading_deg", 0.0f)) + bowYaw;
      if (st.kind != "seat") deckSnap(st.pos);
      stations_.push_back(std::move(st));
    }
  if (j.contains("climb_paths"))
    for (const auto& c : j["climb_paths"]) {
      Climb cl; cl.id = c.value("id", ""); cl.clip = c.value("clip", "Climb");
      cl.approachWp = c.value("approach_wp", "");
      for (const auto& p : c["polyline"]) cl.poly.push_back(toRL(p));
      climbs_.push_back(std::move(cl));
    }
  if (stations_.empty()) { std::fprintf(stderr, "[crew] layout has no stations: %s\n", layoutPath.c_str()); return; }

  const int n = std::min(count, (int)stations_.size());
  members_.reserve(n);
  const std::string firstWp = waypoints_.empty() ? std::string() : waypoints_.begin()->first;
  for (int i = 0; i < n; ++i) {
    uint32_t s = (seed * 1664525u + 1013904223u) ^ ((uint32_t)i * 0x9e3779b9u);
    if (!s) s = 1;
    Member m;
    m.anim = std::make_unique<Animator>(rig_, s);
    m.kit = makeKit(s);
    m.rngState = s;
    m.animSpeed = 0.92f + m.rand() * 0.16f;
    m.wpId = firstWp;
    m.dwell = 2.0f + m.rand() * 6.0f;
    members_.push_back(std::move(m));
    Station* st = pickStation(members_.back());
    if (st) arriveAt(members_.back(), *st, true);
  }
  ok_ = true;
}

float Deck::deckHeight(float lx, float lz, float footRef) const {
  const float roY = footRef + 2.2f;
  float best = std::numeric_limits<float>::quiet_NaN();
  const auto& t = deckTris_;
  for (size_t i = 0; i + 2 < t.size(); i += 3) {
    const glm::vec3& a = t[i]; const glm::vec3& b = t[i + 1]; const glm::vec3& c = t[i + 2];
    const float d0x = b.x - a.x, d0z = b.z - a.z, d1x = c.x - a.x, d1z = c.z - a.z;
    const float den = d0x * d1z - d1x * d0z;
    if (std::fabs(den) < 1e-9f) continue;
    const float px = lx - a.x, pz = lz - a.z;
    const float u = (px * d1z - d1x * pz) / den;
    const float v = (d0x * pz - px * d0z) / den;
    if (u < 0.0f || v < 0.0f || u + v > 1.0f) continue;
    const float hy = a.y + u * (b.y - a.y) + v * (c.y - a.y);
    if (hy > roY || hy < footRef - 3.0f || hy > footRef + 0.9f) continue;
    if (std::isnan(best) || hy > best) best = hy;
  }
  return best;
}

void Deck::deckSnap(glm::vec3& p) const {
  const float dY = deckHeight(p.x, p.z, p.y);
  if (!std::isnan(dY)) p.y = dY + deckLift_;
}

Station* Deck::pickStation(Member& m, bool excludeCurrent) {
  std::vector<Station*> free;
  for (auto& s : stations_)
    if (!reserved_.count(s.id) && (!excludeCurrent || s.id != m.stationId)) free.push_back(&s);
  if (free.empty()) return nullptr;
  return free[(size_t)(m.rand() * free.size()) % free.size()];
}

void Deck::releaseStation(Member& m) {
  if (!m.stationId.empty()) { reserved_.erase(m.stationId); m.stationId.clear(); }
}

void Deck::arriveAt(Member& m, const Station& st, bool teleport) {
  if (!m.stationId.empty() && m.stationId != st.id) releaseStation(m);
  reserved_.insert(st.id);
  m.stationId = st.id; m.wpId = st.wp; m.state = State::Station;
  m.stationPos = st.pos; m.stationClip = st.clip;
  // SAILSIM_CREW_FAST shortens the station dwell so walking/climbing can be
  // exercised in seconds instead of minutes (test-only).
  static const bool fast = std::getenv("SAILSIM_CREW_FAST") != nullptr;
  m.dwell = fast ? 2.0f + m.rand() * 3.0f : 45.0f + m.rand() * 75.0f;
  m.yawTarget = m.stationYaw = st.yaw;
  if (teleport) { m.pos = st.pos; m.yaw = m.yawTarget; }
  m.targetStation.clear(); m.targetClimb.clear();
  play(m, st.clip, true);
}

void Deck::beginWalk(Member& m, const std::string& goalWp, const Station* target, const Climb* climb) {
  releaseStation(m);
  if (target) { reserved_.insert(target->id); m.stationId = target->id; }
  const std::vector<std::string> ids = bfs(m.wpId, goalWp);
  m.legs.clear(); m.legFrom = m.pos;
  std::string prev = m.wpId;
  for (const std::string& id : ids) {
    auto w = waypoints_.find(id);
    if (w != waypoints_.end()) m.legs.push_back({ w->second, edgeKind(prev, id) });
    prev = id;
  }
  if (target) m.legs.push_back({ target->pos, "walk" });
  if (climb && !climb->poly.empty()) m.legs.push_back({ climb->poly[0], "walk" });
  m.wpId = goalWp;
  m.targetStation = target ? target->id : std::string();
  m.targetClimb = climb ? climb->id : std::string();
  if (climb) climbBusy_ = true;
  ++walkers_;
  m.state = State::Walk; m.legT = 0.0f;
  playLeg(m, m.legs.empty() ? "walk" : m.legs.front().kind);
}

float Deck::legSpeed(const std::string& kind) const {
  if (kind == "squeeze")   return walkSpeed_ * 0.4f;
  if (kind == "ladder")    return 0.5f;
  if (kind == "step")      return walkSpeed_ * 0.6f;
  if (kind == "step_over") return walkSpeed_ * 0.75f;
  return walkSpeed_;
}

void Deck::playLeg(Member& m, const std::string& kind) {
  if (kind == "ladder") { m.anim->play("Climb", true, m.animSpeed); return; }
  const float sr = m.animSpeed * std::max(0.35f, legSpeed(kind) / walkSpeed_);
  m.anim->play("Walk", true, sr);
}

void Deck::play(Member& m, const std::string& clip, bool loop) { m.anim->play(clip, loop, m.animSpeed); }

void Deck::tickWalk(Member& m, float dt) {
  if (m.legs.empty()) { finishWalk(m); return; }
  PathLeg& leg = m.legs.front();
  const float span = glm::distance(m.legFrom, leg.to);
  const float dx = leg.to.x - m.legFrom.x, dz = leg.to.z - m.legFrom.z;
  if (dx * dx + dz * dz > 0.01f) m.yawTarget = std::atan2(dx, dz);
  const float err = wrapPi(m.yawTarget - m.yaw);
  const float turnSlow = std::max(0.25f, std::cos(std::min(std::fabs(err), 1.5707963f)));
  const float speed = legSpeed(leg.kind) * turnSlow;
  m.legT = span > 1e-4f ? std::min(1.0f, m.legT + speed * dt / span) : 1.0f;
  m.pos = glm::mix(m.legFrom, leg.to, m.legT);
  if (leg.kind == "step_over") m.pos.y += 0.45f * std::sin(3.14159265f * m.legT);
  if (m.legT >= 1.0f) {
    m.legFrom = leg.to; m.legs.erase(m.legs.begin()); m.legT = 0.0f;
    if (m.legs.empty()) { finishWalk(m); return; }
    playLeg(m, m.legs.front().kind);
  }
}

void Deck::finishWalk(Member& m) {
  if (walkers_ > 0) --walkers_;
  if (!m.targetClimb.empty()) {
    for (const Climb& c : climbs_)
      if (c.id == m.targetClimb && !c.poly.empty()) {
        m.state = State::Climb; m.climbPoly = c.poly; m.climbSeg = 0; m.climbT = 0.0f;
        m.climbDir = 1; m.climbPause = 0.0f; m.pos = c.poly.front();
        play(m, "Climb", true); return;
      }
  }
  if (!m.targetStation.empty()) {
    for (const Station& s : stations_) if (s.id == m.targetStation) { arriveAt(m, s, false); return; }
  }
  m.state = State::Station; m.dwell = 5.0f; play(m, "Idle", true);
}

void Deck::tickClimb(Member& m, float dt) {
  if (m.climbPause > 0.0f) { m.climbPause -= dt; if (m.climbPause <= 0.0f) m.climbDir = -1; return; }
  const int nseg = (int)m.climbPoly.size();
  if (nseg < 2) { climbBusy_ = false; m.state = State::Station; m.dwell = 0.5f; play(m, "Idle", true); return; }
  const float speed = 0.45f;
  const glm::vec3& a = m.climbPoly[m.climbSeg];
  const glm::vec3& b = m.climbPoly[m.climbSeg + 1];
  const float span = glm::distance(a, b);
  m.climbT += speed * dt / std::max(span, 1e-4f) * (float)m.climbDir;
  if (m.climbT >= 1.0f || m.climbT < 0.0f) {
    m.climbSeg += m.climbDir; m.climbT = m.climbT >= 1.0f ? 0.0f : 1.0f;
    if (m.climbDir > 0 && m.climbSeg >= nseg - 1) {
      m.climbSeg = nseg - 2; m.climbT = 1.0f; m.climbPause = 3.0f + m.rand() * 5.0f; return;
    }
    if (m.climbDir < 0 && m.climbSeg < 0) {
      climbBusy_ = false; m.state = State::Station; m.dwell = 0.5f; play(m, "Idle", true); return;
    }
  }
  const glm::vec3& p0 = m.climbPoly[m.climbSeg];
  const glm::vec3& p1 = m.climbPoly[m.climbSeg + 1];
  m.pos = glm::mix(p0, p1, m.climbT);
  const float dx = (p1.x - p0.x) * (float)m.climbDir, dz = (p1.z - p0.z) * (float)m.climbDir;
  if (dx * dx + dz * dz > 1e-4f) m.yawTarget = std::atan2(dx, dz);
}

std::string Deck::edgeKind(const std::string& a, const std::string& b) const {
  auto it = adj_.find(a);
  if (it != adj_.end()) for (const auto& e : it->second) if (e.first == b) return e.second;
  return "walk";
}

std::vector<std::string> Deck::bfs(const std::string& from, const std::string& to) const {
  if (from == to || from.empty()) return {};
  std::map<std::string, std::string> prev;
  std::deque<std::string> q{ from };
  prev[from] = "";
  while (!q.empty()) {
    std::string cur = q.front(); q.pop_front();
    if (cur == to) break;
    auto it = adj_.find(cur);
    if (it == adj_.end()) continue;
    for (const auto& e : it->second)
      if (!prev.count(e.first)) { prev[e.first] = cur; q.push_back(e.first); }
  }
  if (!prev.count(to)) return { to };   // disconnected — beeline
  std::vector<std::string> path;
  for (std::string cur = to; cur != from; cur = prev[cur]) path.insert(path.begin(), cur);
  return path;
}

void Deck::tickMember(Member& m, float dt) {
  const float d = wrapPi(m.yawTarget - m.yaw);
  m.yaw += d * std::min(1.0f, dt * 8.0f);
  switch (m.state) {
    case State::Station: {
      m.dwell -= dt;
      if (m.dwell > 0.0f) return;
      if (walkers_ >= 2) { m.dwell = 4.0f + m.rand() * 6.0f; return; }   // walker cap
      if (!climbBusy_ && !climbs_.empty() && m.rand() < 0.08f) {
        const Climb& cl = climbs_[(size_t)(m.rand() * climbs_.size()) % climbs_.size()];
        beginWalk(m, cl.approachWp, nullptr, &cl);
      } else {
        Station* st = pickStation(m, true);
        if (st) beginWalk(m, st->wp, st, nullptr);
        else m.dwell = 10.0f + m.rand() * 15.0f;
      }
      return;
    }
    case State::Walk:  tickWalk(m, dt);  return;
    case State::Climb: tickClimb(m, dt); return;
  }
}

void Deck::tick(float dt) {
  for (Member& m : members_) { tickMember(m, dt); m.anim->update(dt); }
}

}  // namespace crew
