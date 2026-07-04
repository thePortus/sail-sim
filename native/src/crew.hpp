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
#include <set>
#include <string>
#include <utility>
#include <vector>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include "gltf_rig.hpp"

namespace crew {

// Cross-fade window between clips (s) — the client's CLIP_BLEND_S.
constexpr float kClipBlendS = 0.22f;

// Per-member look, a native port of crew.service applyKitVariants' SELECTION
// (body build + which outer layer / hat / hair / neckerchief). Phase 1a drives
// the body-build morphs, stature and layer visibility; Phase 1b adds the garment
// colour tints on top. Deterministic from a seed so a member is stable.
struct Kit {
  float fem = 0.0f, heavy = 0.0f, lean = 0.0f;   // body-morph weights (targets 0/1/2)
  float stature = 1.0f;                          // uniform height scale (~0.9..1.06)
  int   outer = 0;                               // 0 none, 1 vest, 2 coat
  int   hat = 0;                                 // 0 bare, 1 bandana, 2 cap, 3 tricorn
  bool  hairLong = false;
  bool  neckerchief = false;
  bool  female = false;
  // Phase 1b garment tints (linear RGB), one per garment slot. Identity (1,1,1)
  // means "leave the GLB colour". Filled by makeKit; consumed by the tint upload.
  glm::vec3 tintShirt{1}, tintCoat{1}, tintVest{1}, tintBreeches{1}, tintSash{1},
            tintBoots{1}, tintHat{1}, tintHair{1}, tintNeck{1}, tintSkin{1};
};

// Deterministic kit from a seed (mirrors applyKitVariants' probabilities).
Kit makeKit(uint32_t seed);

// Whether a submesh (by its RigSubmesh name) is drawn for this kit — hides the
// unchosen outer layer / hat / hair / neckerchief so each member wears one combo.
bool kitShowsSubmesh(const Kit& k, const std::string& submeshName);

// Garment tint slot (0..N) for a submesh, or -1 if it takes no per-member tint.
// Used to pack the kit colours into the palette's spare morph-weight region.
int garmentTintSlot(const std::string& submeshName);
glm::vec3 kitTintFor(const Kit& k, int slot);
constexpr int kTintSlotCount = 9;

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

// ── Station/waypoint lifecycle (Phase 2, a port of CrewHandle) ────────────────
// The authored layout (crew_stations.<slug>.json) converted into root-local space
// (the frame the ship's deck triangles live in), so a member's position/heading
// apply verbatim and the ship's heel/pitch come from the outer transform.
struct Station { std::string id, kind, clip, wp; glm::vec3 pos{0}; float yaw = 0; };
struct Climb   { std::string id, clip, approachWp; std::vector<glm::vec3> poly; };
struct PathLeg { glm::vec3 to{0}; std::string kind; };

enum class State { Station, Walk, Climb, Dead, Reserve };

struct Member {
  std::unique_ptr<Animator> anim;
  Kit kit;
  State state = State::Station;
  std::string stationId, wpId, targetStation, targetClimb, stationClip = "Idle";
  glm::vec3 pos{0};                 // current root-local position
  glm::vec3 stationPos{0};          // reserved station anchor
  float yaw = 0, yawTarget = 0, stationYaw = 0;
  float dwell = 0;
  std::vector<PathLeg> legs; float legT = 0; glm::vec3 legFrom{0};
  std::vector<glm::vec3> climbPoly; int climbSeg = 0; float climbT = 0, climbPause = 0; int climbDir = 1;
  float animSpeed = 1.0f;
  uint32_t rngState = 1;
  // Presence (Phase 3): a desynced idle sway + the brace/lean this member rides.
  float swayPhase = 0, swayFreq = 1.0f, railDamp = 1.0f;
  // Combat reactions (Phase 4): transient startles that decay 1->0 over their own
  // window (additive duck/lurch pose), a one-shot reaction-clip timer, and morale.
  float flinch = 0, stagger = 0; int staggerDir = 1;
  float reactT = 0, reactCD = 0, panicT = 0; bool fleeing = false;
  float workBurst = 0;   // >0 -> gun crew heaving after their broadside
  // Output pose modifiers (computed each tick), applied by the renderer on top of
  // pos/yaw: a body lean (roll about the bow axis, pitch about the beam) + a small
  // positional weight-shift/breathing offset in root-local axes.
  float leanRoll = 0, leanPitch = 0;
  glm::vec3 swayOffset{0};
  float rand();
};

// One ship's crew: owns the members + the station graph, runs the state machine
// each frame in root-local space. main.cpp renders members()' poses (pos+yaw+kit
// + anim palette) exactly like Phase 1.
class Deck {
 public:
  // inner = the ship model's bowYaw*scale*(-keel) (converts the authored raw coords
  // to root-local); deckTris = the ship's root-local deck triangles (feet snapping);
  // bowYaw re-aims the authored headings into root-local; walkSpeed m/s.
  Deck(std::shared_ptr<const RiggedData> rig, const std::string& layoutPath, uint32_t seed,
       int count, const glm::mat4& inner, std::vector<glm::vec3> deckTris, float bowYaw,
       float walkSpeed = 1.2f);
  bool ok() const { return ok_; }
  // shipHeel/shipPitch = the deck's current world tilt (rad) — the members brace
  // against them so they ride the swell instead of standing rigid on a heeled deck.
  void tick(float dt, float shipHeel = 0.0f, float shipPitch = 0.0f);
  std::vector<Member>& members() { return members_; }

  // ── Combat hooks (a port of CrewHandle's public reaction API) ──
  void reactToFire(int side);         // a gun fired -> non-gun crew flinch/duck
  void emphasizeGun(int side);        // that side's gun crews heave for a beat
  void reactToHit(int side);          // ship took a hit -> everyone staggers
  void reactCheer();                  // a kill -> stationed crew cheer
  void crewPanic(float frac, float dur);   // morale breaks -> flee / cower
  void setAliveCount(int target);     // reconcile living crew to the server count
  int  aliveCount() const;

 private:
  void  computePresence(Member& m);                           // brace + idle sway/bob/lean
  void  playReact(Member& m, const std::string& clip, float dur);
  void  startFlee(Member& m);
  bool  killOne();
  bool  reviveOne();
  void  hideMember(Member& m);
  std::string randomFleeWp(Member& m);
  float deckHeight(float lx, float lz, float footRef) const;   // deckLocalHeight port
  void  deckSnap(glm::vec3& p) const;                          // snap y to the planks
  Station* pickStation(Member& m, bool excludeCurrent = false);
  void  releaseStation(Member& m);
  void  arriveAt(Member& m, const Station& st, bool teleport);
  void  beginWalk(Member& m, const std::string& goalWp, const Station* target, const Climb* climb);
  void  tickMember(Member& m, float dt);
  void  tickWalk(Member& m, float dt);
  void  tickClimb(Member& m, float dt);
  void  finishWalk(Member& m);
  std::vector<std::string> bfs(const std::string& from, const std::string& to) const;
  std::string edgeKind(const std::string& a, const std::string& b) const;
  float legSpeed(const std::string& kind) const;
  void  playLeg(Member& m, const std::string& kind);
  void  play(Member& m, const std::string& clip, bool loop);

  std::shared_ptr<const RiggedData> rig_;
  std::vector<Member> members_;
  std::map<std::string, glm::vec3> waypoints_;
  std::map<std::string, std::vector<std::pair<std::string, std::string>>> adj_;   // id -> [(to,kind)]
  std::vector<Station> stations_;
  std::vector<Climb> climbs_;
  std::set<std::string> reserved_;
  std::vector<glm::vec3> deckTris_;
  float walkSpeed_ = 1.2f, deckLift_ = 0.0f;
  int walkers_ = 0; bool climbBusy_ = false;
  uint32_t rootRng_ = 1;
  bool ok_ = false;
  // Presence: a running clock for the idle sway + the rail-proxy (widest station
  // beam) that damps motion near the bulwark; beamAxis picks the across-ship axis.
  float clock_ = 0.0f, maxBeam_ = 1.0f, shipHeel_ = 0.0f, shipPitch_ = 0.0f;
  bool beamAxisZ_ = false;
  bool firstFill_ = true;   // first setAliveCount hides the surplus as reserve
  float rand();
};

}  // namespace crew
