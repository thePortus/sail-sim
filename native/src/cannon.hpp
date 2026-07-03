// Gunnery — faithful port of the client's cannon.service.ts state machine:
// per-side STOWED -> ARMING -> ENGAGED batteries with per-gun reload arrays,
// broadside ripple stagger, the soft aim-assist lock solver, and the shared
// cannonball pool with server-tof-deferred impacts. The SERVER adjudicates all
// hits; this module only flies the visuals and self-enforces the same limits.
#pragma once

#include <array>
#include <functional>
#include <string>
#include <vector>

#include <glm/glm.hpp>

#include "combat_constants.hpp"
#include "net_mp.hpp"

namespace combat {

struct Muz { float x, y, z; };                       // vessel-local (+Z bow, +X starboard)
struct GunLayout { std::vector<Muz> port, stbd; };
GunLayout cannonsFor(const std::string& slug);       // server vessels.controller.js layouts

enum class ShotKind { Round, Bar, Grape };
const char* shotName(ShotKind k);                    // wire string: round | bar | grape
enum class SideState { Stowed, Arming, Engaged };
enum class HudGunState { Stowed, Arming, Ready, Reloading };

struct ShipPose { float x = 0, z = 0, headingRad = 0; };
struct Enemy { std::string id; float x, z, headingDeg, speed; };

struct LockSolution {
  bool valid = false;
  float dirX = 0, dirZ = 0, vh = 0, vy0 = 0;
  float px = 0, pz = 0;        // lead point
  float cx = 0, cz = 0;        // target's current position (reticle)
  std::string lockId;
};

struct Ball {
  bool alive = false;
  ShotKind kind = ShotKind::Round;
  float ox = 0, oy = 0, oz = 0, vx = 0, vy = 0, vz = 0, t = 0;
  float spin = 0;              // accumulated visual roll angle
  std::string key;             // shooterId:seq (matches combat_hit)
  bool hasPending = false;
  mp::CombatHit pending;       // server-confirmed hit, played when t >= hitAt
  float hitAt = 0;
};

// A gun went off (visuals + network fan out from this).
struct FireEvent {
  int side = 0;                // 0 port, 1 stbd
  float mwx = 0, mwy = 0, mwz = 0;   // muzzle world
  float vx = 0, vy = 0, vz = 0;      // ball velocity
  float dirX = 0, dirZ = 0;          // raw beam (muzzle FX direction)
  int seq = 0;
  ShotKind kind = ShotKind::Round;
};

// A ball ended (water/land in phase 1; ship impacts via server combat_hit).
struct ImpactEvent {
  float x = 0, y = 0, z = 0;
  float vx = 0, vy = 0, vz = 0;
  ShotKind kind = ShotKind::Round;
  bool shipHit = false;        // true = executed a server combat_hit
  mp::CombatHit hit;           // valid when shipHit
};

class Guns {
 public:
  void configure(const std::string& slug);   // (re)size the battery for our hull

  // ── Input (client bindings: Z port, C stbd, G ammo, H/M presets, Shift/Ctrl) ──
  void armOrFire(int side);
  void cancel();                             // Esc: stand down both sides
  bool anyCancellable() const;
  void toggleShotType();                     // round -> bar -> grape -> round
  void setElevPreset(bool mast) { elevDeg_ = mast ? kElevMast : kElevHull; }
  void elevHold(float dir, float dt);        // +1 raise (Shift) / -1 lower (Ctrl)

  // Advance the state machine. Emits FireEvents for guns whose stagger arrived.
  void update(float dt, const ShipPose& pose, const std::vector<Enemy>& enemies,
              float crewFactor, const std::string& myId, std::vector<FireEvent>& outFires);

  // ── Ball pool (local + remote shots share it) ──
  void spawnBall(const std::string& key, ShotKind kind,
                 float ox, float oy, float oz, float vx, float vy, float vz);
  void onCombatHit(const mp::CombatHit& h, std::vector<ImpactEvent>& outImpacts);
  // groundH(x, z) = terrain elevation (<= 0 in water). Emits water/land impacts.
  void updateBalls(float dt, const std::function<float(float, float)>& groundH,
                   std::vector<ImpactEvent>& outImpacts);
  const std::array<Ball, (size_t)kBallPool>& balls() const { return balls_; }

  // ── Aim visuals ──
  const LockSolution& lock(int side) const { return lock_[side]; }
  // Predicted arc for one gun (kAimSamples points; green when locked, red free).
  std::vector<glm::vec3> arcPath(int side, int gunIdx, const ShipPose& pose) const;

  // ── HUD / animation state ──
  SideState sideState(int side) const { return side_[side].state; }
  HudGunState hudState(int side) const;
  float deploy(int side) const { return side_[side].deployCur; }
  float recoil(int side) const { return side_[side].recoil; }
  float reloadFrac(int side) const;
  int loadedCount(int side) const;
  int gunsPerSide() const { return (int)layout_.port.size(); }
  ShotKind shotType() const { return shot_; }
  float elevDeg() const { return elevDeg_; }
  // Deploy target changed since last consume (drives the gun_state broadcast).
  bool consumeDeployChange(int side, int& outDeploy);

 private:
  struct Side {
    SideState state = SideState::Stowed;
    float deployTarget = 0, deployCur = 0;     // eased at kGunDeployRate
    float recoil = 0;                          // decays at kGunRecoilDecay
    std::vector<double> loadAt, loadStart, fireAt;
    std::vector<float> factor;
    bool deployDirty = false; int deploySent = 0;
  };
  void armGunArrays(int side);
  LockSolution solveLock(int side, const ShipPose& pose, float beamX, float beamZ,
                         float mv, float muzzleY, const std::vector<Enemy>& enemies) const;
  float muzzleV() const;
  void fireOneCannon(int side, int idx, const ShipPose& pose,
                     const std::vector<Enemy>& enemies, const std::string& myId,
                     std::vector<FireEvent>& outFires);

  GunLayout layout_;
  Side side_[2];
  ShotKind shot_ = ShotKind::Round;
  float elevDeg_ = kElevHull;
  double elapsed_ = 0;
  int shotSeq_ = 0;
  float crewFactor_ = 1.0f;
  LockSolution lock_[2];
  std::vector<Enemy> enemies_;     // latest (for arcPath re-solve-free rendering)
  std::array<Ball, (size_t)kBallPool> balls_;
};

}  // namespace combat
