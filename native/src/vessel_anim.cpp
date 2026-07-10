// Vessel animation controllers — see vessel_anim.hpp. Every tickRig resets the
// node-local TRS to rest, re-scrubs the active clips (sparse composition, like
// the client's paused-AnimationGroup goToFrame scheme), applies the code-driven
// bone spins on top (boom swing AFTER the trim clip, flags after everything),
// then recomputes the palette — the same ordering the TS controllers enforce.

#include "vessel_anim.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>

#include <glm/gtc/matrix_transform.hpp>
#include <nlohmann/json.hpp>

namespace vanim {
namespace {

constexpr float kPi = 3.14159265359f;

std::string stripName(std::string n) {
  if (n.rfind("NLA_", 0) == 0) n = n.substr(4);
  // trailing '.NNN' duplicate-datablock suffix
  size_t dot = n.find_last_of('.');
  if (dot != std::string::npos && dot + 1 < n.size() &&
      n.size() - dot - 1 >= 3 &&
      n.find_first_not_of("0123456789", dot + 1) == std::string::npos) {
    n = n.substr(0, dot);
  }
  return n;
}

bool channelConstant(const RigChannel& c) {
  if (c.values.size() <= 1) return true;
  for (size_t i = 1; i < c.values.size(); ++i) {
    glm::vec4 d = glm::abs(c.values[i] - c.values[0]);
    if (std::max(std::max(d.x, d.y), std::max(d.z, d.w)) > 1e-5f) return false;
  }
  return true;
}

float approach(float cur, float target, float maxStep) {
  if (cur == target) return cur;
  float d = target - cur;
  return cur + (d > 0 ? 1.0f : -1.0f) * std::min(std::fabs(d), maxStep);
}

glm::mat4 composeTRS(const glm::vec3& t, const glm::quat& r, const glm::vec3& s) {
  glm::mat4 m = glm::translate(glm::mat4(1.0f), t);
  m *= glm::mat4_cast(r);
  m = glm::scale(m, s);
  return m;
}

}  // namespace

Controller::Controller(std::shared_ptr<const RiggedData> rig, const std::string& slug,
                       const std::string& manifestPath)
    : rig_(std::move(rig)), slug_(slug) {
  // Index clips by stripped name, pruning constant channels (the sloop/brig
  // clips are full-skeleton bakes — without pruning, layered scrubs clobber).
  for (const RigClip& c : rig_->clips) {
    Clip clip;
    clip.tMin = c.tMin; clip.tMax = c.tMax;
    for (const RigChannel& ch : c.channels)
      if (!channelConstant(ch)) clip.channels.push_back(&ch);
    clips_[stripName(c.name)] = std::move(clip);
  }

  const size_t n = rig_->nodes.size();
  lt_.resize(n); lr_.resize(n); ls_.resize(n);
  worlds_.resize(n);
  palette_ = rig_->restPalette;
  morphW_.assign(rig_->morphs.size(), 0.0f);

  // ── Manifest: sail -> furl morph (+rope morphs in lockstep) ──
  try {
    std::ifstream f(manifestPath);
    if (f) {
      nlohmann::json j = nlohmann::json::parse(f);
      const auto& sp = j["sail_sheet_pairs"];
      auto ref = [](const nlohmann::json& m) {
        MorphRef r;
        r.node = m.value("node", m.value("object", ""));
        r.target = m.value("target", m.value("shape_key", ""));
        r.index = m.value("index", 0);
        return r;
      };
      if (sp.is_array()) {              // sloop / pinnace / brig
        for (const auto& p : sp) {
          SailPair pair;
          pair.sail = p.value("sail", "");
          if (p.contains("sail_morph")) pair.sailMorph = ref(p["sail_morph"]);
          if (p.contains("sheet_morph") && !p["sheet_morph"].is_null())
            pair.rigging.push_back(ref(p["sheet_morph"]));
          for (const auto& r : p.value("rigging_morphs", nlohmann::json::array()))
            pair.rigging.push_back(ref(r));
          pairs_.push_back(std::move(pair));
        }
      } else if (sp.is_object()) {      // merchantman: sailNode -> rope list
        for (auto it = sp.begin(); it != sp.end(); ++it) {
          if (it.key() == "note") continue;
          SailPair pair;
          pair.sail = it.key();
          pair.sailMorph = { it.key(), "Furl", 0 };
          for (const auto& r : it.value()) pair.rigging.push_back(ref(r));
          pairs_.push_back(std::move(pair));
        }
      }
    }
  } catch (...) {
    std::fprintf(stderr, "[vanim] %s: manifest parse failed (%s)\n", slug.c_str(), manifestPath.c_str());
  }

  // ── Per-rig profiles (the four TS controllers' constants) ──
  auto table = [&](std::initializer_list<std::pair<const char*, float>> t) {
    std::map<std::string, float> m;
    for (const auto& [k, v] : t) m[k] = v;
    return m;
  };
  if (slug_ == "sloop") {
    trimMode_ = TrimMode::SloopHybrid; rudderMode_ = RudderMode::SloopBone;
    trimRate_ = 2.0f; boomSwingRate_ = 1.8f; furlRate_ = 0.6f;
    rudderNode_ = "B_Rudder"; rudderMaxRad_ = 35.0f * kPi / 180.0f; rudderSign_ = 1.0f;
    wheelNode_ = "B_Wheel"; wheelAxis_ = glm::vec3(0, 1, 0);
    boomMap_ = BoomMap::SheetMinus90; boomNodes_ = { "B_Boom", "B_Gaff" };
    flags_ = { { "B_Flag", 2.0f, 0.0f, 0.15f }, { "B_Pennant", 1.6f, -0.4f, 0.30f } };
    flagYawOffset_ = kPi;   // rest streams ~180° off downwind (client FLAG_YAW_OFFSET)
    furlTables_[2] = table({ {"Mainsail",0},{"Topsail",0},{"Topgallant",0},{"Course",0},{"ForeStaysail",0},{"Jib",0} });
    furlTables_[1] = table({ {"Mainsail",1},{"Topsail",0},{"Topgallant",1},{"Course",1},{"ForeStaysail",0},{"Jib",0} });
    furlTables_[0] = table({ {"Mainsail",1},{"Topsail",1},{"Topgallant",1},{"Course",1},{"ForeStaysail",1},{"Jib",1} });
    trimCur_ = trimTarget_ = 0.0f;   // one-sided clip: 0 = square
    mastZones_ = { { "MastDown", { "Sloop_Mast", "Break", 0 }, -1, 1, 0, 0 } };
  } else if (slug_ == "pinnace") {
    trimMode_ = TrimMode::SymmetricLug; rudderMode_ = RudderMode::PinnaceAbsolute;
    trimRate_ = 1.6f; furlRate_ = 0.6f;
    rudderNode_ = "Rudder"; rudderMaxRad_ = 30.0f * kPi / 180.0f; rudderSign_ = 1.0f;
    singleAnchor_ = true;
    cableS_ = cableP_ = { "AnchorCable", "Drop", 0 };
    flagChainRipple_ = true;
    flags_ = { { "Flag1", 3.0f, 0.0f, 0.05f }, { "Flag2", 3.0f, -0.5f, 0.10f }, { "Flag3", 3.0f, -1.0f, 0.17f } };
    furlTables_[2] = table({ {"Mainsail",0},{"Jib",0} });
    furlTables_[1] = table({ {"Mainsail",0.5f},{"Jib",0} });   // main reefed ~50%, jib up
    furlTables_[0] = table({ {"Mainsail",1},{"Jib",1} });
    mastZones_ = { { "MastDown", { "Pinnace_Mast", "Break", 0 }, -1, 1, 0, 0 } };
  } else if (slug_ == "brig") {
    trimMode_ = TrimMode::SymmetricSquare; rudderMode_ = RudderMode::SymmetricClip;
    trimRate_ = 1.4f; furlRate_ = 0.5f;
    wheelNode_ = "B_Wheel"; wheelAxis_ = glm::vec3(1, 0, 0);   // axle = local X
    boomMap_ = BoomMap::SheetDirect; boomNodes_ = { "B_Boom", "B_Gaff" };
    boomSign_ = -1.0f;   // leeward under this hull's handedness (verified: wind on port -> gaff to starboard)
    // Cat-tackle cable morphs are raw model-side while the AnchorDrop clips are
    // game-side — SWAPPED on purpose (BrigController cableIdx).
    cableS_ = { "CatTackle", "Drop_P", 1 };
    cableP_ = { "CatTackle", "Drop_S", 0 };
    flags_ = { { "B_Flag_Ensign", 2.0f, 0.0f, 0.18f }, { "B_Flag_Burgee", 2.4f, 0.3f, 0.24f },
               { "B_Flag_Pennant", 1.6f, -0.4f, 0.38f } };
    flagYawOffset_ = 0.0f;
    const char* ALL[] = { "ForeCourse","ForeLowerTops","ForeUpperTops","ForeTGallant","ForeRoyal","MainGaff",
                          "GaffTopsail","ForeStaysail","InnerJib","FlyingJib","MainStaysail","MainTopStaysail","MainTGallStaysail" };
    const char* KITES[] = { "ForeRoyal","ForeTGallant","GaffTopsail","FlyingJib","MainTGallStaysail","MainTopStaysail" };
    for (const char* s : ALL) { furlTables_[2][s] = 0; furlTables_[1][s] = 0; furlTables_[0][s] = 1; }
    for (const char* k : KITES) furlTables_[1][k] = 1;   // topsails: strike the light kites
    // Foremast topples first (down by ~30% HP left); the main only at 0 HP.
    mastZones_ = { { "MastDown_Fore", { "Mast_Fore_Lower", "Break_Fore", 0 }, 0.40f, 0.70f, 0, 0 },
                   { "MastDown_Main", { "Mast_Main_Lower", "Break_Main", 0 }, 0.70f, 1.00f, 0, 0 } };
  } else if (slug_.rfind("frigate", 0) == 0) {   // frigate_heavy / _medium / _light (shared rig)
    trimMode_ = TrimMode::SymmetricSquare; rudderMode_ = RudderMode::SymmetricClip;   // rudder authored non-reversed
    trimRate_ = 1.4f; furlRate_ = 0.5f;
    wheelNode_ = "B_Wheel"; wheelAxis_ = glm::vec3(0, 1, 0);   // axle = local Y (like the merchantman)
    // 4 streamed flags (flagPhi_ caps at 4); the mizzen signal stays static — a minor cosmetic omission.
    flags_ = { { "B_Flag_Ensign", 2.0f, 0.0f, 0.18f }, { "B_Flag_Jack", 2.4f, 0.3f, 0.22f },
               { "B_Flag_Pennant", 1.6f, -0.4f, 0.40f }, { "B_Flag_ForeSignal", 2.3f, 0.5f, 0.24f } };
    flagYawOffset_ = 0.0f;
    const char* ALL[] = { "Sail_Fore_Course","Sail_Fore_Topsail","Sail_Fore_Topgallant","Sail_Fore_Royal",
                          "Sail_Main_Course","Sail_Main_Topsail","Sail_Main_Topgallant","Sail_Main_Royal",
                          "Sail_Mizzen_Topsail","Sail_Mizzen_Topgallant","Sail_Mizzen_Royal","Sail_ForeTopmastStaysail",
                          "Sail_Jib","Sail_FlyingJib","Sail_MainTopmastStaysail","Sail_MizzenTopmastStaysail","Sail_Spanker" };
    const char* KITES[] = { "Sail_Fore_Royal","Sail_Main_Royal","Sail_Mizzen_Royal","Sail_FlyingJib" };
    for (const char* s : ALL) { furlTables_[2][s] = 0; furlTables_[1][s] = 0; furlTables_[0][s] = 1; }
    for (const char* k : KITES) furlTables_[1][k] = 1;   // topsails: strike the light kites (royals + flying jib)
    mastZones_ = { { "MastDown_Fore",   { "", "", 0 }, 0.40f, 0.60f, 0, 0 },
                   { "MastDown_Mizzen", { "", "", 0 }, 0.60f, 0.80f, 0, 0 },
                   { "MastDown_Main",   { "", "", 0 }, 0.80f, 1.00f, 0, 0 } };
    lidMorphS_ = { "Frigate_Ports", "Lid_S", 0 };   // gun-port lids are MORPHS (not the merchantman's bone clips)
    lidMorphP_ = { "Frigate_Ports", "Lid_P", 0 };
  } else {   // merchantman (also the fallback)
    trimMode_ = TrimMode::SymmetricSquare; rudderMode_ = RudderMode::SymmetricClipReversed;
    trimRate_ = 1.4f; furlRate_ = 0.5f;
    wheelNode_ = "B_Wheel"; wheelAxis_ = glm::vec3(0, 1, 0);   // axle = local Y (unlike the brig)
    flags_ = { { "B_Flag_Ensign", 2.0f, 0.0f, 0.18f }, { "B_Flag_Fore", 2.4f, 0.3f, 0.24f },
               { "B_Flag_Pennant", 1.6f, -0.4f, 0.38f }, { "B_Flag_Mizzen", 2.2f, 0.6f, 0.22f } };
    flagYawOffset_ = 0.0f;
    const char* ALL[] = { "Sail_Fore_Course","Sail_Fore_Tops","Sail_Fore_TGallant","Sail_Main_Course","Sail_Main_Tops",
                          "Sail_Main_TGallant","Sail_Mizzen_Course","Sail_Mizzen_Tops","Sail_Mizzen_TGallant",
                          "Sail_InnerJib","Sail_MiddleJib","Sail_OuterJib","Sail_Spanker" };
    const char* KITES[] = { "Sail_Fore_TGallant","Sail_Main_TGallant","Sail_Mizzen_TGallant","Sail_OuterJib" };
    for (const char* s : ALL) { furlTables_[2][s] = 0; furlTables_[1][s] = 0; furlTables_[0][s] = 1; }
    for (const char* k : KITES) furlTables_[1][k] = 1;
    mastZones_ = { { "MastDown_Fore",   { "", "", 0 }, 0.40f, 0.60f, 0, 0 },
                   { "MastDown_Mizzen", { "", "", 0 }, 0.60f, 0.80f, 0, 0 },
                   { "MastDown_Main",   { "", "", 0 }, 0.80f, 1.00f, 0, 0 } };
  }

  applySailState(2, true);   // default pose: full sail
  tickRig(0.0f);             // pose rudder centred / trim square / anchors stowed
}

int Controller::nodeByName(const std::string& name) const {
  for (size_t i = 0; i < rig_->nodes.size(); ++i)
    if (rig_->nodes[i].name == name) return (int)i;
  return -1;
}

// ── control surface ───────────────────────────────────────────────────────────

void Controller::setRudder(float t) { rudderTarget_ = glm::clamp(t, -1.0f, 1.0f); }

void Controller::setSailTrim(float sheetAngleDeg, bool isPortTack) {
  switch (trimMode_) {
    case TrimMode::SloopHybrid: {
      // Yards brace from the eased sheet; boom/gaff swing handled below.
      trimTarget_ = glm::clamp((88.0f - sheetAngleDeg) / 83.0f, 0.0f, 1.0f);
      break;
    }
    case TrimMode::SymmetricLug: {
      // Amidships (0.5) close-hauled, swung to the leeward tack end as it eases.
      const float amount = glm::clamp((sheetAngleDeg - 5.0f) / 83.0f, 0.0f, 1.0f);
      const float tackDir = isPortTack ? 1.0f : -1.0f;
      trimTarget_ = 0.5f + tackDir * amount * 0.5f;
      break;
    }
    case TrimMode::SymmetricSquare: {
      // Yards square (0.5) running, braced to the tack close-hauled.
      const float eased = glm::clamp((sheetAngleDeg - 5.0f) / 83.0f, 0.0f, 1.0f);
      const float brace = 1.0f - eased;
      const float tackDir = (isPortTack ? -1.0f : 1.0f) * trimTackSign_;
      trimTarget_ = glm::clamp(0.5f + tackDir * brace * 0.5f, 0.0f, 1.0f);
      break;
    }
  }
  // Fore-and-aft boom/gaff: swing to the leeward side by the sheet angle
  // (offset per rig — see BoomMap in the header).
  const float swingSide = (isPortTack ? -1.0f : 1.0f) * boomSign_;
  if (boomMap_ == BoomMap::SheetMinus90)     boomTarget_ = swingSide * (sheetAngleDeg - 90.0f) * kPi / 180.0f;
  else if (boomMap_ == BoomMap::SheetDirect) boomTarget_ = swingSide * sheetAngleDeg * kPi / 180.0f;
  if (!trimInit_) { trimCur_ = trimTarget_; boomCur_ = boomTarget_; trimInit_ = true; }
}

void Controller::applySailState(int state, bool immediate) {
  const auto& t = furlTables_[glm::clamp(state, 0, 2)];
  for (const auto& [sail, v] : t) {
    furlTarget_[sail] = v;
    if (immediate || !furlCur_.count(sail)) { furlCur_[sail] = v; applyFurl(sail, v); }
  }
}

void Controller::dropAnchor(char side, float t) {
  anchorReq_[side == 'P' ? 1 : 0] = glm::clamp(t, 0.0f, 1.0f);
}

void Controller::idleWind(float windDirLocalRad, float strength, float t) {
  const float s = glm::clamp(strength, 0.0f, 1.5f);
  flagW_ = glm::clamp((s - 0.02f) / 0.10f, 0.0f, 1.0f);   // limp in dead air
  for (size_t i = 0; i < flags_.size() && i < 4; ++i) {
    const FlagSpec& f = flags_[i];
    if (flagChainRipple_) {
      flagPhi_[i] = std::sin(t * f.freq + f.phase) * f.amp * s;   // pinnace: local ripple only
    } else {
      flagPhi_[i] = windDirLocalRad + flagYawOffset_ + std::sin(t * f.freq + f.phase) * f.amp * s;
    }
  }
  flagActive_ = true;
}

// ── per-frame ────────────────────────────────────────────────────────────────

void Controller::scrubNorm(const std::string& clipName, float t01) {
  auto it = clips_.find(clipName);
  if (it == clips_.end()) return;
  const Clip& c = it->second;
  const float t = c.tMin + glm::clamp(t01, 0.0f, 1.0f) * (c.tMax - c.tMin);
  for (const RigChannel* ch : c.channels) {
    const auto& times = ch->times;
    if (times.empty() || ch->node < 0) continue;
    size_t k = 0;
    while (k + 1 < times.size() && times[k + 1] < t) ++k;
    glm::vec4 v;
    if (k + 1 >= times.size() || ch->step) {
      v = ch->values[std::min(k, ch->values.size() - 1)];
    } else {
      const float span = std::max(1e-6f, times[k + 1] - times[k]);
      const float u = glm::clamp((t - times[k]) / span, 0.0f, 1.0f);
      if (ch->path == 1) {
        glm::quat a(ch->values[k].w, ch->values[k].x, ch->values[k].y, ch->values[k].z);
        glm::quat b(ch->values[k + 1].w, ch->values[k + 1].x, ch->values[k + 1].y, ch->values[k + 1].z);
        glm::quat q = glm::slerp(a, b, u);
        lr_[(size_t)ch->node] = q;
        continue;
      }
      v = glm::mix(ch->values[k], ch->values[k + 1], u);
    }
    if (ch->path == 0) lt_[(size_t)ch->node] = glm::vec3(v);
    else if (ch->path == 1) lr_[(size_t)ch->node] = glm::quat(v.w, v.x, v.y, v.z);
    else ls_[(size_t)ch->node] = glm::vec3(v);
  }
}

void Controller::setMorph(const MorphRef& m, float v) {
  for (size_t i = 0; i < rig_->morphs.size(); ++i) {
    const RigMorph& rm = rig_->morphs[i];
    const RigSubmesh& sm = rig_->submeshes[(size_t)rm.submesh];
    if (sm.name != m.node) continue;
    const bool byName = !m.target.empty() && !rm.targetName.empty();
    if (byName ? (rm.targetName == m.target) : (rm.target == m.index)) morphW_[i] = v;
  }
}

void Controller::applyFurl(const std::string& sail, float v) {
  for (const SailPair& p : pairs_) {
    if (p.sail != sail) continue;
    setMorph(p.sailMorph, v);
    for (const MorphRef& r : p.rigging) setMorph(r, v);
  }
}

void Controller::composeSpinParent(int node, const glm::vec3& axis, float angle) {
  if (node < 0) return;
  lr_[(size_t)node] = glm::angleAxis(angle, axis) * rig_->nodes[(size_t)node].r;
}

void Controller::composeSpinLocal(int node, const glm::vec3& axis, float angle) {
  if (node < 0) return;
  lr_[(size_t)node] = rig_->nodes[(size_t)node].r * glm::angleAxis(angle, axis);
}

// Parent's CURRENT world rotation (from this frame's scratch TRS).
static glm::quat parentWorldRot(const RiggedData& rig, const std::vector<glm::quat>& lr, int node) {
  glm::quat q(1, 0, 0, 0);
  int p = rig.nodes[(size_t)node].parent;
  std::vector<int> chain;
  while (p >= 0) { chain.push_back(p); p = rig.nodes[(size_t)p].parent; }
  for (auto it = chain.rbegin(); it != chain.rend(); ++it) q = q * lr[(size_t)*it];
  return q;
}

void Controller::spinAboutWorldY(int node, float phi) {
  // World-up yaw composed onto rest, preserving the staff's tilt (sloop flags):
  // local = inv(parentRot) * RotY(phi) * parentRot * rest.
  if (node < 0) return;
  const glm::quat pq = parentWorldRot(*rig_, lr_, node);
  const glm::quat rot = glm::angleAxis(phi, glm::vec3(0, 1, 0));
  lr_[(size_t)node] = glm::inverse(pq) * rot * pq * rig_->nodes[(size_t)node].r;
}

void Controller::streamFlag(int node, float phi, float w) {
  // Brig/merchantman: spin about the bone's OWN staff axis (local Y), cancel the
  // parent's trim deviation from rest, slerp from rest by w (limp in dead air).
  if (node < 0) return;
  const glm::quat rest = rig_->nodes[(size_t)node].r;
  if (w <= 0.0001f) { lr_[(size_t)node] = rest; return; }
  glm::quat q = rest * glm::angleAxis(phi, glm::vec3(0, 1, 0));
  const int parent = rig_->nodes[(size_t)node].parent;
  if (parent >= 0) {
    const glm::quat pRest = rig_->nodes[(size_t)parent].r;
    const glm::quat pCur = lr_[(size_t)parent];
    q = glm::inverse(pCur) * pRest * q;   // undo the parent's trim deviation
  }
  lr_[(size_t)node] = glm::slerp(rest, q, w);
}

void Controller::recomputePalette() {
  const size_t n = rig_->nodes.size();
  for (size_t i = 0; i < n; ++i) {
    const int p = rig_->nodes[i].parent;
    const glm::mat4 local = composeTRS(lt_[i], lr_[i], ls_[i]);
    worlds_[i] = p < 0 ? local : worlds_[(size_t)p] * local;   // parents precede children in vessel GLBs? no — handle below
  }
  // glTF does not guarantee parent-before-child ordering; redo any node whose
  // parent came later (cheap second pass, converges because trees are shallow).
  for (int pass = 0; pass < 4; ++pass) {
    bool changed = false;
    for (size_t i = 0; i < n; ++i) {
      const int p = rig_->nodes[i].parent;
      const glm::mat4 expect = (p < 0 ? glm::mat4(1.0f) : worlds_[(size_t)p]) * composeTRS(lt_[i], lr_[i], ls_[i]);
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

void Controller::tickRig(float dt) {
  // 1. Reset local TRS to rest — clips + spins re-compose from scratch each frame.
  for (size_t i = 0; i < rig_->nodes.size(); ++i) {
    lt_[i] = rig_->nodes[i].t; lr_[i] = rig_->nodes[i].r; ls_[i] = rig_->nodes[i].s;
  }

  // 2. Eased state.
  rudderCur_ = approach(rudderCur_, rudderTarget_, rudderRate_ * dt);
  trimCur_ = approach(trimCur_, trimTarget_, trimRate_ * dt);
  boomCur_ = approach(boomCur_, boomTarget_, boomSwingRate_ * dt);
  for (int i = 0; i < 2; ++i) anchorCur_[i] = approach(anchorCur_[i], anchorReq_[i], anchorRate_ * dt);
  const float furlStep = furlRate_ * dt;
  for (auto& [sail, target] : furlTarget_) {
    float& cur = furlCur_[sail];
    cur = approach(cur, target, furlStep);
    applyFurl(sail, cur);   // re-apply every frame (never stuck at a stale weight)
  }

  // 3. Clip scrubs (sparse channels compose across clips).
  switch (trimMode_) {
    case TrimMode::SloopHybrid: scrubNorm("Trim", trimCur_); break;
    default: scrubNorm("Trim", trimCur_); break;
  }
  if (rudderMode_ == RudderMode::SymmetricClip) scrubNorm("Rudder", 0.5f + rudderCur_ * 0.5f);
  else if (rudderMode_ == RudderMode::SymmetricClipReversed) scrubNorm("Rudder", 0.5f - rudderCur_ * 0.5f);
  if (singleAnchor_) {
    const float a = std::max(anchorCur_[0], anchorCur_[1]);
    scrubNorm("AnchorDrop", a);
    setMorph(cableS_, a);
  } else {
    scrubNorm("AnchorDrop_S", anchorCur_[0]);
    scrubNorm("AnchorDrop_P", anchorCur_[1]);
    if (!cableS_.node.empty()) { setMorph(cableS_, anchorCur_[0]); setMorph(cableP_, anchorCur_[1]); }
  }
  // Mast damage: map the masts-zone health onto each zone's collapse window
  // (or the single-mast curves), ease at MAST_FALL_RATE 0.4/s, scrub the fall
  // clip + ramp the splinter morph over the last ~40% of the fall.
  {
    const float frac = 1.0f - mastHealth_;
    for (auto& z : mastZones_) {
      float downTgt, breakTgt;
      if (z.from < 0.0f) {
        // Single-mast rigs: the client's combat.constants curves.
        const float onset = 0.60f;
        if (mastHealth_ <= 0.0f) downTgt = 1.0f;
        else if (mastHealth_ >= onset) downTgt = 0.0f;
        else downTgt = std::sqrt((onset - mastHealth_) / onset) * 0.55f;
        breakTgt = mastHealth_ >= onset ? 0.0f : (onset - std::max(0.0f, mastHealth_)) / onset;
      } else {
        const float span = std::max(0.0001f, z.to - z.from);
        downTgt = std::clamp((frac - z.from) / span, 0.0f, 1.0f);
        breakTgt = std::clamp((downTgt - 0.6f) / 0.4f, 0.0f, 1.0f);
      }
      z.downCur = approach(z.downCur, downTgt, 0.4f * dt);
      z.breakCur = approach(z.breakCur, breakTgt, 0.4f * dt);
      if (z.downCur > 0.0001f || downTgt > 0.0f) {
        scrubNorm(z.fallClip, z.downCur);
        if (!z.breakMorph.node.empty()) setMorph(z.breakMorph, z.breakCur);
      }
    }
  }
  // Guns: lids open over the first half of the deploy, the gun runs out over the
  // second half minus the recoil kick (the client controllers' applyGunPose).
  // Rigs without lid clips (pinnace open mounts) run out over the whole deploy.
  // HANDEDNESS: native reads glTF node TRS RAW (right-handed) and renders through
  // an X-mirrored projection (proj[0][0] negated), so the model's authored port/
  // starboard gun bones land on the OPPOSITE visual side from Babylon's RH->LH glTF
  // import. The clips are named for the GAME side (Gun_S = game starboard, like the
  // TS controllers), so drive the OPPOSITE-named clip to run the guns out on the
  // correct (firing) side — the cannonsFor muzzles already render on the right side,
  // and without this swap the run-out animation is mirrored relative to the shots
  // (verified across all four hulls: arm-starboard was animating the port battery).
  for (int i = 0; i < 2; ++i) {
    const std::string sd = i == 0 ? "S" : "P";   // gunDeploy_[0]=game PORT -> S clip, [1]=game STBD -> P clip
    const float dep = gunDeploy_[i], rec = gunRecoil_[i];
    if (clips_.count("Lid_" + sd)) {
      scrubNorm("Lid_" + sd, std::clamp(dep * 2.0f, 0.0f, 1.0f));
      scrubNorm("Gun_" + sd, std::clamp(std::clamp(dep * 2.0f - 1.0f, 0.0f, 1.0f) - rec, 0.0f, 1.0f));
    } else if (!lidMorphS_.node.empty()) {   // frigate: lids are MORPHS (Frigate_Ports), run-out is a clip
      setMorph(sd == "S" ? lidMorphS_ : lidMorphP_, std::clamp(dep * 2.0f, 0.0f, 1.0f));
      scrubNorm("Gun_" + sd, std::clamp(std::clamp(dep * 2.0f - 1.0f, 0.0f, 1.0f) - rec, 0.0f, 1.0f));
    } else if (clips_.count("Gun_" + sd)) {
      scrubNorm("Gun_" + sd, std::clamp(dep - rec, 0.0f, 1.0f));
    }
  }

  // 4. Code-driven bones ON TOP of the clips.
  if (boomMap_ != BoomMap::None) {
    // Boom/gaff swing overrides the Trim clip's channels (tack-correct side).
    for (const std::string& bn : boomNodes_)
      composeSpinParent(nodeByName(bn), glm::vec3(0, 1, 0), boomCur_);
  }
  if (rudderMode_ == RudderMode::SloopBone) {
    composeSpinParent(nodeByName(rudderNode_), glm::vec3(0, 1, 0), rudderCur_ * rudderMaxRad_ * rudderSign_);
  } else if (rudderMode_ == RudderMode::PinnaceAbsolute) {
    // The pinnace Rudder node's animation is a pure Y-yaw with bind = hard-over,
    // so set the local yaw ABSOLUTELY (t=0 is dead centre).
    const int rn = nodeByName(rudderNode_);
    if (rn >= 0) lr_[(size_t)rn] = glm::angleAxis(rudderCur_ * rudderMaxRad_ * rudderSign_, glm::vec3(0, 1, 0));
  }
  if (!wheelNode_.empty()) {
    composeSpinLocal(nodeByName(wheelNode_), wheelAxis_, rudderCur_ * wheelMaxRad_);
  }

  // 5. Flags (after trim so the parent-cancel sees this frame's trim pose).
  if (flagActive_) {
    for (size_t i = 0; i < flags_.size() && i < 4; ++i) {
      const int node = nodeByName(flags_[i].node);
      if (node < 0) continue;
      if (flagChainRipple_) composeSpinLocal(node, glm::vec3(0, 1, 0), flagPhi_[i]);
      else if (slug_ == "sloop") spinAboutWorldY(node, flagPhi_[i]);
      else streamFlag(node, flagPhi_[i], flagW_);
    }
  }

  // 6. Palette (the "skeleton.prepare" equivalent).
  recomputePalette();
}

}  // namespace vanim
