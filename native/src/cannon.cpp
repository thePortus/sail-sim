#include "cannon.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>

namespace combat {

static float frand() { return (float)std::rand() / (float)RAND_MAX; }

// Per-vessel batteries, verbatim from server/controllers/vessels.controller.js
// (vessel-local, +Z bow, +X starboard; port guns already sit at -X).
GunLayout cannonsFor(const std::string& slug) {
  if (slug == "pinnace")
    return { { { -0.95f, 0.85f, 0.15f } },
             { {  0.95f, 0.85f, -0.15f } } };
  if (slug == "brig")
    return { { { -2.7f, 2.25f, 9.0f }, { -3.5f, 1.32f, 1.5f }, { -3.4f, 2.34f, -6.5f }, { -3.1f, 2.44f, -9.0f } },
             { {  2.7f, 2.25f, 9.0f }, {  3.5f, 1.32f, 1.5f }, {  3.4f, 2.34f, -6.5f }, {  3.1f, 2.44f, -9.0f } } };
  if (slug == "merchantman")
    return { { { -3.4f, 2.5f, 4.1f }, { -3.4f, 2.5f, -2.4f }, { -3.4f, 2.5f, -5.9f } },
             { {  3.4f, 2.5f, 4.1f }, {  3.4f, 2.5f, -2.4f }, {  3.4f, 2.5f, -5.9f } } };
  if (slug.rfind("frigate", 0) == 0) {
    // Frigate: gun-deck LONG guns (FRIG_LONG) + spar-deck CARRONADES (FRIG_CARR), verbatim from server
    // vessels.controller.js battery(). Positions are the barrel muzzle tips AT RUN-OUT (glTF +X stbd,
    // +Y up, +Z bow) = the rest tip + the 0.8m run-out translation. The gun fires + aims only when run
    // out (Engaged), so the muzzle flash / volumetric / aim tube sit at the projected barrel mouth just
    // OUTSIDE the hull (rest tips were inside the hull -> the fireball spawned half-occluded).
    static const float L[15][3] = {
      {5.09f,4.01f,16.55f},{5.65f,3.80f,14.13f},{6.03f,3.62f,11.60f},{6.36f,3.47f,9.10f},{6.60f,3.35f,6.60f},
      {6.77f,3.26f,4.08f},{6.85f,3.18f,1.58f},{6.85f,3.17f,-0.92f},{6.84f,3.24f,-3.42f},{6.78f,3.32f,-5.93f},
      {6.63f,3.42f,-8.43f},{6.50f,3.50f,-10.93f},{6.30f,3.56f,-13.44f},{6.03f,3.61f,-15.96f},{5.85f,3.70f,-18.60f} };
    static const float C[11][3] = {
      {4.44f,5.90f,13.98f},{4.85f,5.64f,10.61f},{5.15f,5.45f,7.19f},{5.30f,5.31f,3.80f},{5.32f,5.21f,0.40f},
      {5.33f,5.28f,-3.00f},{5.30f,5.41f,-6.40f},{5.21f,5.53f,-9.79f},{5.06f,5.64f,-13.19f},{4.86f,5.74f,-16.45f},
      {4.62f,5.85f,-19.98f} };
    // Variant slices (match server battery(): heavy 15L+11C, medium 15L+C[1:9], light L[0:13]+C[2:8]).
    int nL = 15, cA = 0, cB = 11;
    if (slug == "frigate_medium")     { cA = 1; cB = 9; }
    else if (slug == "frigate_light") { nL = 13; cA = 2; cB = 8; }
    GunLayout g;
    for (int i = 0; i < nL; ++i) { g.port.push_back({ -L[i][0], L[i][1], L[i][2], false }); g.stbd.push_back({ L[i][0], L[i][1], L[i][2], false }); }
    for (int i = cA; i < cB; ++i) { g.port.push_back({ -C[i][0], C[i][1], C[i][2], true  }); g.stbd.push_back({ C[i][0], C[i][1], C[i][2], true  }); }
    return g;
  }
  // Sloop battery = the client's DEFAULT_MUZZLES (3 per side).
  return { { { -1.98f, 1.50f, 1.36f }, { -1.87f, 1.65f, 2.40f }, { -1.72f, 1.90f, 3.44f } },
           { {  1.98f, 1.50f, 1.36f }, {  1.87f, 1.65f, 2.40f }, {  1.72f, 1.90f, 3.44f } } };
}

const char* shotName(ShotKind k) {
  return k == ShotKind::Bar ? "bar" : k == ShotKind::Grape ? "grape" : "round";
}

float Guns::muzzleV() const {
  return shot_ == ShotKind::Bar ? kMuzzleVBar
       : shot_ == ShotKind::Grape ? kMuzzleVGrape : kMuzzleVRound;
}

void Guns::configure(const std::string& slug) {
  layout_ = cannonsFor(slug);
  for (Side& s : side_) {
    s.loadAt.clear(); s.loadStart.clear(); s.fireAt.clear(); s.factor.clear();
    s.state = SideState::Stowed;
    s.deployTarget = 0;
  }
}

// Fresh battery starts loaded; a re-arm of an existing battery preserves the
// per-gun reload timers (the fire->stow->re-arm exploit fix from the client).
void Guns::armGunArrays(int side) {
  Side& g = side_[side];
  const size_t n = layout_.port.size();
  if (g.loadAt.size() != n) {
    g.loadAt.assign(n, 0.0);
    g.loadStart.assign(n, 0.0);
    g.factor.resize(n);
    for (float& f : g.factor) f = 1.0f + (frand() * 2.0f - 1.0f) * kReloadVar;
  }
  g.fireAt.assign(n, 1e18);
}

void Guns::armOrFire(int side) {
  Side& g = side_[side];
  if (g.state == SideState::Stowed) {
    armGunArrays(side);
    g.state = SideState::Arming;
    g.deployTarget = 1.0f;
    g.deployDirty = true;
  } else if (g.state == SideState::Engaged) {
    // Queue every loaded gun, rippled down the side by a human stagger. Carronades AUTO-HOLD: skip them
    // unless an enemy is within their short reach on this side — they stay loaded (no wasted reload) until
    // you close the range, then the next fire order looses the full battery (client cannon.service parity).
    const bool carrOk = hasTargetInCarronadeRange(side);
    const auto& muzzles = side == 0 ? layout_.port : layout_.stbd;
    int order = 0;
    for (size_t i = 0; i < g.loadAt.size(); ++i) {
      if (i < muzzles.size() && muzzles[i].carronade && !carrOk) continue;   // out-of-range smasher → hold
      if (elapsed_ >= g.loadAt[i] && g.fireAt[i] > 1e17) {
        g.fireAt[i] = elapsed_ + order * (kStaggerMin + frand() * (kStaggerMax - kStaggerMin));
        order++;
      }
    }
  }
}

// True if an enemy sits on `side` within carronade reach — the auto-hold gate (uses the latest own pose
// + enemy snapshot cached in update()). Mirrors cannon.service.ts hasTargetInCarronadeRange.
bool Guns::hasTargetInCarronadeRange(int side) const {
  if (enemies_.empty()) return false;
  const float sinH = std::sin(pose_.headingRad), cosH = std::cos(pose_.headingRad);
  const float beamX = side == 0 ? -cosH : cosH;   // outboard normal for this side
  const float beamZ = side == 0 ?  sinH : -sinH;
  const float r2 = kCarronadeRange * kCarronadeRange;
  for (const Enemy& e : enemies_) {
    const float dx = e.x - pose_.x, dz = e.z - pose_.z;
    if (dx * dx + dz * dz > r2) continue;
    if (dx * beamX + dz * beamZ > 0.0f) return true;   // in reach AND on the firing side
  }
  return false;
}

void Guns::cancel() {
  for (Side& g : side_) {
    if (g.state == SideState::Arming || g.state == SideState::Engaged) {
      g.state = SideState::Stowed;
      g.deployTarget = 0.0f;
      g.deployDirty = true;
      std::fill(g.fireAt.begin(), g.fireAt.end(), 1e18);   // queued-not-fired shots cancel
    }
  }
}

bool Guns::anyCancellable() const {
  for (const Side& g : side_)
    if (g.state == SideState::Arming || g.state == SideState::Engaged) return true;
  return false;
}

void Guns::toggleShotType() {
  shot_ = shot_ == ShotKind::Round ? ShotKind::Bar
        : shot_ == ShotKind::Bar ? ShotKind::Grape : ShotKind::Round;
}

void Guns::elevHold(float dir, float dt) {
  elevDeg_ = std::clamp(elevDeg_ + dir * kElevRate * dt, kElevMin, kElevMax);
}

bool Guns::consumeDeployChange(int side, int& outDeploy) {
  Side& g = side_[side];
  int want = g.deployTarget > 0.5f ? 1 : 0;
  if (!g.deployDirty && want == g.deploySent) return false;
  g.deployDirty = false;
  if (want == g.deploySent) return false;
  g.deploySent = want;
  outDeploy = want;
  return true;
}

HudGunState Guns::hudState(int side) const {
  const Side& g = side_[side];
  if (g.state == SideState::Arming) return HudGunState::Arming;
  if (g.state != SideState::Engaged) return HudGunState::Stowed;
  return loadedCount(side) > 0 ? HudGunState::Ready : HudGunState::Reloading;
}

int Guns::loadedCount(int side) const {
  const Side& g = side_[side];
  int n = 0;
  for (double at : g.loadAt) if (elapsed_ >= at) n++;
  return n;
}

bool Guns::gunLoaded(int side, int gunIdx) const {
  const Side& g = side_[side];
  if (gunIdx < 0 || gunIdx >= (int)g.loadAt.size()) return false;
  return elapsed_ >= g.loadAt[gunIdx];
}

float Guns::reloadFrac(int side) const {
  const Side& g = side_[side];
  if (g.loadAt.empty()) return 0;
  float sum = 0;
  for (size_t i = 0; i < g.loadAt.size(); ++i) {
    double span = g.loadAt[i] - g.loadStart[i];
    sum += span <= 0 ? 1.0f : (float)std::clamp((elapsed_ - g.loadStart[i]) / span, 0.0, 1.0);
  }
  return sum / (float)g.loadAt.size();
}

// Soft aim-assist — verbatim solveLock() (client cannon.service.ts).
LockSolution Guns::solveLock(int side, const ShipPose& vs, float beamX, float beamZ,
                             float mv, float muzzleY, const std::vector<Enemy>& enemies) const {
  (void)side;
  LockSolution out;
  if (enemies.empty()) return out;
  const float beamAng = std::atan2(beamX, beamZ);
  auto norm = [](float a) { return std::atan2(std::sin(a), std::cos(a)); };

  const Enemy* best = nullptr;
  float bestOff = kLockArcDeg * 3.14159265f / 180.0f;
  for (const Enemy& e : enemies) {
    float dx = e.x - vs.x, dz = e.z - vs.z, dist = std::hypot(dx, dz);
    if (dist < 2.0f || dist > kLockMaxRange) continue;
    float off = std::fabs(norm(std::atan2(dx, dz) - beamAng));
    if (off < bestOff) { bestOff = off; best = &e; }
  }
  if (!best) return out;

  const float tf = std::clamp((elevDeg_ - kElevHull) / (kElevMast - kElevHull), 0.0f, 1.0f);
  const float aimY = kAimLowY + (kAimHighY - kAimLowY) * tf;
  const float tvx = std::sin(best->headingDeg * 3.14159265f / 180.0f) * best->speed * kTravelScale;
  const float tvz = std::cos(best->headingDeg * 3.14159265f / 180.0f) * best->speed * kTravelScale;
  const float v = mv, v2 = v * v, dY = aimY - muzzleY, ox = vs.x, oz = vs.z;
  float tof = std::hypot(best->x - ox, best->z - oz) / (v * 0.97f);
  float theta = 0, px = best->x, pz = best->z, R = 0;
  for (int k = 0; k < 3; ++k) {
    px = best->x + tvx * tof;
    pz = best->z + tvz * tof;
    R = std::hypot(px - ox, pz - oz);
    float disc = v2 * v2 - kGravity * (kGravity * R * R + 2.0f * dY * v2);
    if (disc < 0) return out;                                    // out of ballistic reach
    theta = std::atan2(v2 - std::sqrt(disc), kGravity * R);      // low arc
    tof = R / (v * std::cos(theta));
  }
  const float cone = kAimConeDeg * 3.14159265f / 180.0f;
  const float az = beamAng + std::clamp(norm(std::atan2(px - ox, pz - oz) - beamAng), -cone, cone);
  out.valid = true;
  out.dirX = std::sin(az); out.dirZ = std::cos(az);
  out.vh = v * std::cos(theta); out.vy0 = v * std::sin(theta);
  out.px = px; out.pz = pz; out.cx = best->x; out.cz = best->z;
  out.lockId = best->id;
  return out;
}

void Guns::fireOneCannon(int side, int idx, const ShipPose& vs,
                         const std::vector<Enemy>& enemies, const std::string& myId,
                         std::vector<FireEvent>& outFires) {
  const float sinH = std::sin(vs.headingRad), cosH = std::cos(vs.headingRad);
  // Beam direction (perpendicular to the hull): port out -X, starboard out +X.
  const float dirX = side == 0 ? -cosH : cosH;
  const float dirZ = side == 0 ?  sinH : -sinH;
  const float elevRad = elevDeg_ * 3.14159265f / 180.0f;
  const auto& muzzles = side == 0 ? layout_.port : layout_.stbd;
  const Muz& muz = muzzles[(size_t)idx < muzzles.size() ? idx : 0];
  const bool isCarr = muz.carronade;                            // spar-deck smasher → slow ball, short range
  const float mv = muzzleV() * (isCarr ? kCarronadeVFactor : 1.0f);
  const float mwx = vs.x + muz.x * cosH + muz.z * sinH;
  const float mwy = muz.y;
  const float mwz = vs.z - muz.x * sinH + muz.z * cosH;

  // One shared solution per broadside (solved from the ship centre).
  LockSolution sol = shot_ != ShotKind::Grape
                   ? solveLock(side, vs, dirX, dirZ, mv, muz.y, enemies) : LockSolution{};
  const int pellets = shot_ == ShotKind::Grape ? kGrapePellets : 1;
  for (int k = 0; k < pellets; ++k) {
    float bvx, vyk, bvz;
    if (shot_ == ShotKind::Grape) {
      float az = (frand() * 2 - 1) * kGrapeSpreadRad;
      float ca = std::cos(az), sa = std::sin(az);
      float ddx = dirX * ca - dirZ * sa, ddz = dirX * sa + dirZ * ca;
      float el = elevRad + (frand() * 2 - 1) * kGrapeElevRad;
      float vh = mv * std::cos(el);
      vyk = mv * std::sin(el);
      bvx = ddx * vh; bvz = ddz * vh;
    } else if (sol.valid) {
      bvx = sol.dirX * sol.vh; vyk = sol.vy0; bvz = sol.dirZ * sol.vh;
    } else {
      float vh = mv * std::cos(elevRad);
      vyk = mv * std::sin(elevRad);
      bvx = dirX * vh; bvz = dirZ * vh;
    }
    const int seq = ++shotSeq_;
    spawnBall(myId + ":" + std::to_string(seq), shot_, mwx, mwy, mwz, bvx, vyk, bvz);
    FireEvent fe;
    fe.side = side;
    fe.mwx = mwx; fe.mwy = mwy; fe.mwz = mwz;
    fe.vx = bvx; fe.vy = vyk; fe.vz = bvz;
    fe.dirX = dirX; fe.dirZ = dirZ;
    fe.seq = seq; fe.kind = shot_;
    fe.carronade = isCarr;
    outFires.push_back(fe);
  }
  side_[side].recoil = 1.0f;   // gun slides back, then eases forward again
}

void Guns::update(float dt, const ShipPose& pose, const std::vector<Enemy>& enemies,
                  float crewFactor, const std::string& myId, std::vector<FireEvent>& outFires) {
  elapsed_ += dt;
  crewFactor_ = std::clamp(crewFactor, 0.5f, 1.0f);
  enemies_ = enemies;
  pose_ = pose;               // cache for the carronade auto-hold gate (armOrFire has no pose/enemies args)

  // Guard against running before configure(): until the vessel slug resolves the gun layout is empty, and the
  // per-side muzzle lookup below (`layout_.port[0]`) would dereference an empty vector — UB that reads a null
  // hull in some builds. No layout means no battery to aim or fire, so simply wait.
  if (layout_.port.empty() || layout_.stbd.empty()) return;

  for (int s = 0; s < 2; ++s) {
    Side& g = side_[s];
    // Deploy ease (the client's controller-side GUN_DEPLOY_RATE) + recoil decay.
    float d = g.deployTarget - g.deployCur;
    float step = kGunDeployRate * dt;
    g.deployCur += std::clamp(d, -step, step);
    g.recoil = std::max(0.0f, g.recoil - kGunRecoilDecay * dt * g.recoil);
    if (g.state == SideState::Arming && g.deployCur >= 0.99f) g.state = SideState::Engaged;

    // Live lock (round/bar; drives the tubes/reticle even between shots).
    const float sinH = std::sin(pose.headingRad), cosH = std::cos(pose.headingRad);
    const float bx = s == 0 ? -cosH : cosH, bz = s == 0 ? sinH : -sinH;
    const float muzY = (s == 0 ? layout_.port : layout_.stbd)[0].y;
    lock_[s] = (g.state == SideState::Engaged && shot_ != ShotKind::Grape)
             ? solveLock(s, pose, bx, bz, muzzleV(), muzY, enemies) : LockSolution{};

    if (g.state != SideState::Engaged) continue;
    // Fire queued guns whose stagger arrived; each begins its own reload.
    for (size_t i = 0; i < g.fireAt.size(); ++i) {
      if (g.fireAt[i] < 1e17 && elapsed_ >= g.fireAt[i]) {
        g.fireAt[i] = 1e18;
        fireOneCannon(s, (int)i, pose, enemies, myId, outFires);
        double dur = (kReloadBase / crewFactor_) * g.factor[i]
                   * (1.0 + (frand() * 2 - 1) * kReloadJitter);
        g.loadStart[i] = elapsed_;
        g.loadAt[i] = elapsed_ + std::max((double)kReloadMin, dur);
      }
    }
  }
}

void Guns::spawnBall(const std::string& key, ShotKind kind,
                     float ox, float oy, float oz, float vx, float vy, float vz) {
  // Reuse a dead slot; else steal the oldest (client BALL_POOL behaviour).
  Ball* slot = nullptr;
  for (Ball& b : balls_) if (!b.alive) { slot = &b; break; }
  if (!slot) {
    slot = &balls_[0];
    for (Ball& b : balls_) if (b.t > slot->t) slot = &b;
  }
  *slot = Ball{};
  slot->alive = true;
  slot->kind = kind;
  slot->ox = ox; slot->oy = oy; slot->oz = oz;
  slot->vx = vx; slot->vy = vy; slot->vz = vz;
  slot->key = key;
}

void Guns::onCombatHit(const mp::CombatHit& h, std::vector<ImpactEvent>& outImpacts) {
  const std::string key = h.shooterId + ":" + std::to_string(h.seq);
  for (Ball& b : balls_) {
    if (!b.alive || b.key != key) continue;
    if (h.tof > 0 && b.t < h.tof) {
      b.hasPending = true;      // defer the cosmetic until the ball arrives
      b.pending = h;
      b.hitAt = h.tof;
      return;
    }
    ImpactEvent e;
    e.x = h.hx; e.y = h.hy; e.z = h.hz;
    e.vx = b.vx; e.vy = b.vy - kGravity * b.t; e.vz = b.vz;
    e.kind = b.kind; e.shipHit = true; e.hit = h;
    outImpacts.push_back(e);
    b.alive = false;
    return;
  }
  // Ball unknown (pool recycled / we joined late): play at the server point now.
  ImpactEvent e;
  e.x = h.hx; e.y = h.hy; e.z = h.hz;
  e.kind = ShotKind::Round; e.shipHit = true; e.hit = h;
  outImpacts.push_back(e);
}

void Guns::updateBalls(float dt, const std::function<float(float, float)>& groundH,
                       std::vector<ImpactEvent>& outImpacts) {
  for (Ball& b : balls_) {
    if (!b.alive) continue;
    b.t += dt;
    b.spin += dt * (b.kind == ShotKind::Bar ? 26.0f : b.kind == ShotKind::Grape ? 14.0f : 5.0f);
    const float bx = b.ox + b.vx * b.t;
    const float by = b.oy + b.vy * b.t - 0.5f * kGravity * b.t * b.t;
    const float bz = b.oz + b.vz * b.t;
    if (b.hasPending && b.t >= b.hitAt) {
      ImpactEvent e;
      e.x = b.pending.hx; e.y = b.pending.hy; e.z = b.pending.hz;
      e.vx = b.vx; e.vy = b.vy - kGravity * b.t; e.vz = b.vz;
      e.kind = b.kind; e.shipHit = true; e.hit = b.pending;
      outImpacts.push_back(e);
      b.alive = false;
      continue;
    }
    const float surf = groundH ? groundH(bx, bz) : 0.0f;
    const float floorY = surf > 0.0f ? surf : 0.0f;
    if ((by < floorY + 0.5f && b.t > 0.4f) || b.t > 25.0f) {
      ImpactEvent e;
      e.x = bx; e.y = by; e.z = bz;
      e.vx = b.vx; e.vy = b.vy - kGravity * b.t; e.vz = b.vz;
      e.kind = b.kind; e.shipHit = false;
      outImpacts.push_back(e);
      b.alive = false;
    }
  }
}

// Predicted arc (client buildArcPath): the solved leading shot when locked
// (ends AT the intercept), else the free-aim beam arc down to the waterline.
std::vector<glm::vec3> Guns::arcPath(int side, int gunIdx, const ShipPose& vs) const {
  std::vector<glm::vec3> path;
  const Side& g = side_[side];
  if (g.state != SideState::Engaged || shot_ == ShotKind::Grape) return path;
  const float sinH = std::sin(vs.headingRad), cosH = std::cos(vs.headingRad);
  const auto& muzzles = side == 0 ? layout_.port : layout_.stbd;
  const Muz& muz = muzzles[(size_t)gunIdx < muzzles.size() ? gunIdx : 0];
  const float ox = vs.x + muz.x * cosH + muz.z * sinH;
  const float oy = muz.y;
  const float oz = vs.z - muz.x * sinH + muz.z * cosH;
  const bool isCarr = muz.carronade;
  const LockSolution& sol = lock_[side];

  float vh, vy0, bvx, bvz, tEnd;
  if (sol.valid && !isCarr) {   // long guns trace the shared lock; carronades draw their own short arc
    vh = sol.vh; vy0 = sol.vy0;
    bvx = sol.dirX * vh; bvz = sol.dirZ * vh;
    tEnd = std::hypot(sol.px - ox, sol.pz - oz) / std::max(1.0f, vh);
  } else {
    const float elevRad = elevDeg_ * 3.14159265f / 180.0f;
    const float mv = muzzleV() * (isCarr ? kCarronadeVFactor : 1.0f);   // reduced-v → falls short (~100 m)
    vh = mv * std::cos(elevRad); vy0 = mv * std::sin(elevRad);
    const float dirX = side == 0 ? -cosH : cosH;
    const float dirZ = side == 0 ?  sinH : -sinH;
    bvx = dirX * vh; bvz = dirZ * vh;
    // Solve oy + vy0 t - g/2 t^2 = kAimWaterY for the splash-down time.
    float disc = vy0 * vy0 + 2.0f * kGravity * (oy - kAimWaterY);
    tEnd = (vy0 + std::sqrt(std::max(0.0f, disc))) / kGravity;
  }
  path.reserve(kAimSamples);
  for (int i = 0; i < kAimSamples; ++i) {
    float tt = tEnd * (float)i / (float)(kAimSamples - 1);
    path.emplace_back(ox + bvx * tt, oy + vy0 * tt - 0.5f * kGravity * tt * tt, oz + bvz * tt);
  }
  return path;
}

}  // namespace combat
