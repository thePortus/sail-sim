// Vessel animation controllers (Phase 1): C++ ports of the four Angular rig
// drivers (SloopController, PinnaceController, BrigController,
// MerchantmanController). One generic Controller runs the shared machinery —
// normalized clip scrubbing over the retained RigClips, eased furl/trim/anchor
// state, composed free-bone spins (flags/wheel/boom), palette recompute — and a
// per-slug Profile captures each rig's quirks exactly as the TS classes did.
//
// Outputs per frame: the matrix palette (node worlds + skin joints) and the
// morph weight array, both uploaded to the vessel's per-instance GPU slots.
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include "gltf_rig.hpp"

namespace vanim {

// A morph reference resolved against RigMorph entries by node name + target
// name (fallback: target index) — mirrors the client's by-name morphIndex.
struct MorphRef {
  std::string node;
  std::string target;   // '' -> match by index
  int index = 0;
};

struct SailPair {
  std::string sail;
  MorphRef sailMorph;
  std::vector<MorphRef> rigging;   // sheet/tack/clew morphs driven in lockstep
};

class Controller {
public:
  // rig = the loaded model's retained scene data; slug picks the profile;
  // manifestPath = the companion <ship>.manifest.json (sail pairs etc.).
  Controller(std::shared_ptr<const RiggedData> rig, const std::string& slug,
             const std::string& manifestPath);

  // ── VesselController contract (vessel-controller.ts) ──
  void setRudder(float t);                                   // -1 port .. +1 stbd
  void setSailTrim(float sheetAngleDeg, bool isPortTack);
  void applySailState(int state, bool immediate = false);    // 0 reefed, 1 topsails, 2 full
  void dropAnchor(char side, float t);                       // 'S'/'P', 0 stowed .. 1 lowered
  // Mast damage (combat phase 3): health 1 intact .. 0 destroyed. tickRig eases
  // the collapse (MAST_FALL_RATE 0.4/s) so the rig falls / rises over seconds.
  void setMastDamage(float health01) { mastHealth_ = health01 < 0 ? 0.0f : health01 > 1 ? 1.0f : health01; }
  // Gunports + run-out (combat phase 1): deploy 0 stowed .. 1 run out; recoil
  // kicks the gun back briefly after firing. Values are pre-eased by the caller.
  void setGunDeploy(char side, float deploy01, float recoil01 = 0.0f) {
    int i = side == 'P' ? 0 : 1;
    gunDeploy_[i] = deploy01;
    gunRecoil_[i] = recoil01;
  }
  void idleWind(float windDirLocalRad, float strength, float t);
  void tickRig(float dt);

  // Renderer outputs (valid after tickRig).
  const std::vector<glm::mat4>& palette() const { return palette_; }
  const std::vector<float>& morphWeights() const { return morphW_; }

private:
  struct Clip {                     // pruned, name-stripped scrub clip
    float tMin = 0, tMax = 0;
    std::vector<const RigChannel*> channels;
  };
  struct FlagSpec { std::string node; float freq, phase, amp; };

  void scrubNorm(const std::string& clip, float t01);
  void setMorph(const MorphRef& m, float v);
  void applyFurl(const std::string& sail, float v);
  void composeSpinParent(int node, const glm::vec3& axis, float angle);   // sloop composeSpin
  void composeSpinLocal(int node, const glm::vec3& axis, float angle);    // wheel-style rest*spin
  void spinAboutWorldY(int node, float phi);                              // sloop flag stream
  void streamFlag(int node, float phi, float w);                          // brig/merch limp-aware
  void recomputePalette();
  int nodeByName(const std::string& name) const;

  std::shared_ptr<const RiggedData> rig_;
  std::string slug_;

  std::map<std::string, Clip> clips_;          // stripped name -> pruned clip
  std::vector<glm::vec3> lt_; std::vector<glm::quat> lr_; std::vector<glm::vec3> ls_;   // local TRS scratch
  std::vector<glm::mat4> worlds_;
  std::vector<glm::mat4> palette_;
  std::vector<float> morphW_;                  // aligned with rig_->morphs

  std::vector<SailPair> pairs_;                // from the manifest
  std::map<std::string, float> furlCur_, furlTarget_;

  // Eased state (client rates).
  float rudderCur_ = 0, rudderTarget_ = 0;
  float trimCur_ = 0.5f, trimTarget_ = 0.5f;   // sloop uses 0..1 one-sided; others symmetric
  bool trimInit_ = false;
  float boomCur_ = 0, boomTarget_ = 0;         // sloop boom/gaff swing (rad)
  float anchorCur_[2] = { 0, 0 }, anchorReq_[2] = { 0, 0 };   // [0]=S, [1]=P
  // Mast-damage zones: single-mast rigs use the combat.constants curves; multi-
  // mast rigs map the one masts-zone HP onto per-mast collapse windows.
  struct MastZone {
    std::string fallClip;
    MorphRef breakMorph;        // node "" = no splinter morph
    float from = -1, to = 1;    // window over damage fraction; from < 0 = curve mode
    float downCur = 0, breakCur = 0;
  };
  std::vector<MastZone> mastZones_;
  float mastHealth_ = 1.0f;
  // Gun deploy/recoil per side ([0]=P, [1]=S), pre-eased by the caller.
  float gunDeploy_[2] = { 0, 0 };
  float gunRecoil_[2] = { 0, 0 };
  // Flag state (written by idleWind, applied in tickRig after the clip scrubs).
  float flagPhi_[4] = { 0, 0, 0, 0 };
  float flagW_ = 0;
  bool flagActive_ = false;

  // ── Per-rig profile ──
  enum class TrimMode { SloopHybrid, SymmetricLug, SymmetricSquare };
  enum class RudderMode { SloopBone, PinnaceAbsolute, SymmetricClip, SymmetricClipReversed };
  TrimMode trimMode_ = TrimMode::SymmetricSquare;
  RudderMode rudderMode_ = RudderMode::SymmetricClip;
  float trimRate_ = 1.6f, rudderRate_ = 4.0f, furlRate_ = 0.6f, anchorRate_ = 0.7f;
  float boomSwingRate_ = 1.8f;
  // Code-driven fore-and-aft boom/gaff swing (the Trim clip can't represent a
  // tack-dependent side). Sloop: swing = side*(sheet-90) — its boom rest is
  // athwartships. Brig: swing = side*sheet — its gaff rig rests on the
  // centreline and the asset's Trim clip holds it CONSTANT (verified; the
  // browser shares that flaw, fixed here). Merchantman's spanker trims via its
  // clip, so it needs none.
  enum class BoomMap { None, SheetMinus90, SheetDirect };
  BoomMap boomMap_ = BoomMap::None;
  float boomSign_ = 1.0f;
  std::vector<std::string> boomNodes_;
  float rudderMaxRad_ = 0.61f, rudderSign_ = 1.0f, trimTackSign_ = 1.0f;
  std::string rudderNode_, wheelNode_;
  glm::vec3 wheelAxis_ = glm::vec3(0, 1, 0);
  float wheelMaxRad_ = 6.2831853f;
  bool singleAnchor_ = false;
  MorphRef cableS_, cableP_;                   // anchor cable morphs (pinnace/brig)
  MorphRef lidMorphS_, lidMorphP_;             // frigate gun-port lids — MORPHS (Frigate_Ports), not bone clips
  std::vector<FlagSpec> flags_;
  float flagYawOffset_ = 0.0f;
  bool flagChainRipple_ = false;               // pinnace Flag1>2>3 travelling wave
  std::map<std::string, float> furlTables_[3]; // [0]=reefed, [1]=topsails, [2]=full
};

}  // namespace vanim
