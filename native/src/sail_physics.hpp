// Vessel sailing physics + buoyancy — port of the client's force-based model
// (vessel.service.ts physicsStep + vessel-buoyancy.service.ts). Apparent-wind
// polar drive vs quadratic drag with mass momentum; speed-dependent turn with
// yaw inertia; heel-driven leeway; 8-point wave buoyancy (heave/pitch/roll).
// Heading is radians, 0 = +Z (north), +toward +X (east) — matches the renderer.
#pragma once
#include <glm/glm.hpp>
#include <glm/gtc/constants.hpp>
#include <algorithm>
#include <cmath>
#include <functional>
#include <string>
#include <vector>

namespace sail {

// Per-vessel rig + hull physics (client VESSEL_RIGS sail + server vessels.controller).
struct Rig {
  std::vector<glm::vec2> polar;   // [apparentAngleDeg, driveCoeff] breakpoints
  float forceK = 0.26f;           // SAIL_FORCE_K default
  float trimForgive = 1.0f, leewayK = 1.0f;
  float weight = 2800, maxSpeed = 9, accelRate = 0.22f;
  float minTackAngle = 32, sailAreaFactor = 0.40f;
  float hullHalfLen = 7.0f, hullHalfBeam = 2.2f;
  float pitchScale = 0.14f, heaveTau = 1.5f, tiltTau = -1.0f;   // tiltTau<0 => use default smoothing
};

inline Rig rigForSlug(const std::string& s) {
  // Base = the SLOOP rig — also the fallback for "sloop" and any unknown slug, so
  // the polar is never empty. The other vessels override it below.
  Rig r;
  r.polar = {{32,0.46f},{45,0.64f},{60,0.80f},{90,0.93f},{120,1.00f},{150,0.82f},{180,0.66f}};
  r.forceK = 0.26f; r.trimForgive = 1.0f; r.leewayK = 1.0f;
  r.weight = 2800; r.maxSpeed = 9.0f; r.accelRate = 0.22f; r.minTackAngle = 32; r.sailAreaFactor = 0.40f;
  r.hullHalfLen = 7.0f; r.hullHalfBeam = 2.2f;   // pitchScale/heaveTau default to the generic sloop feel

  if (s == "pinnace") {
    r.polar = {{34,0.42f},{55,0.62f},{80,0.82f},{100,0.92f},{125,0.97f},{150,0.90f},{180,0.80f}};
    r.forceK = 0.26f; r.trimForgive = 1.25f; r.leewayK = 1.4f;
    r.weight = 1400; r.maxSpeed = 8.0f; r.accelRate = 0.30f; r.minTackAngle = 34; r.sailAreaFactor = 0.34f;
    r.hullHalfLen = 4.1f; r.hullHalfBeam = 1.1f; r.pitchScale = 0.16f; r.heaveTau = 0.45f; r.tiltTau = 0.30f;
  } else if (s == "brig") {
    r.polar = {{50,0.40f},{70,0.62f},{90,0.82f},{120,1.00f},{150,0.95f},{180,0.86f}};
    r.forceK = 1.12f; r.trimForgive = 1.1f; r.leewayK = 0.9f;
    r.weight = 5200; r.maxSpeed = 9.5f; r.accelRate = 0.16f; r.minTackAngle = 50; r.sailAreaFactor = 0.48f;
    r.hullHalfLen = 12.0f; r.hullHalfBeam = 3.2f; r.pitchScale = 0.07f; r.heaveTau = 1.0f; r.tiltTau = 0.6f;
  } else if (s == "merchantman") {
    r.polar = {{52,0.38f},{72,0.60f},{92,0.80f},{120,1.00f},{150,0.96f},{180,0.88f}};
    r.forceK = 1.18f; r.trimForgive = 1.15f; r.leewayK = 0.85f;
    r.weight = 6500; r.maxSpeed = 8.6f; r.accelRate = 0.12f; r.minTackAngle = 52; r.sailAreaFactor = 0.50f;
    r.hullHalfLen = 15.0f; r.hullHalfBeam = 3.6f; r.pitchScale = 0.06f; r.heaveTau = 1.1f; r.tiltTau = 0.65f;
  }
  // else: sloop — the base rig set above (matches VESSEL_RIGS 'sloop').
  return r;
}

// Sail plan: 0 = furled/reefed (no drive), 1 = topsails/half, 2 = full.
struct Vessel {
  float x = 0, z = 0, heading = 0;   // heading radians
  float speed = 0;                   // knots
  float yawRate = 0;                 // rad/s
  float heelDeg = 0;                 // wind side-force heel (visual + leeway)
  int   sailState = 1;
  bool  anchored = false;
  float anchorX = 0, anchorZ = 0;
  float heaveF = 0, pitchF = 0, rollF = 0;   // filtered buoyancy
  // Sheet (sail trim), player-set: 5 = hauled hard in .. 88 = fully eased.
  float sheetAngleDeg = 30.0f;       // client default (reaching start)
  float trimQ = 1.0f;                // last tick's trim quality 0..1 (for the HUD)
  float driveAngle = 90.0f;          // last tick's apparent-wind angle (for auto-trim/HUD)
};

// Ideal sheet angle (deg from centreline) for a wind angle — client table.
inline float optimalSheetAngle(float a) {
  if (a < 38.0f)  return 5.0f;
  if (a < 60.0f)  return 18.0f;
  if (a < 90.0f)  return 35.0f;
  if (a < 115.0f) return 52.0f;
  if (a < 145.0f) return 68.0f;
  if (a < 165.0f) return 82.0f;
  return 88.0f;
}

namespace detail {
inline float polarDrive(float a, const Rig& r) {
  float noGo = r.minTackAngle;
  if (a < noGo) return -0.30f * (1.0f - a / std::max(1.0f, noGo));
  const auto& p = r.polar;
  if (a <= p[0].x) return p[0].y;
  for (size_t i = 1; i < p.size(); ++i)
    if (a <= p[i].x) {
      float t = (a - p[i-1].x) / (p[i].x - p[i-1].x);
      return p[i-1].y + (p[i].y - p[i-1].y) * t;
    }
  return p.back().y;
}
inline float turnRate(float speed, float maxSpeed) {
  float sf = std::fabs(speed) / std::max(0.1f, maxSpeed);
  if (sf < 0.03f) return 4.0f;
  float rate = 155.0f * sf / (1.0f + (sf / 0.28f) * (sf / 0.28f));
  return std::clamp(rate, 4.0f, 30.0f);
}
inline float smooth01(float v, float a, float b) {
  float t = std::clamp((v - a) / (b - a), 0.0f, 1.0f);
  return t * t * (3.0f - 2.0f * t);
}
// v2 trim quality (client trimFactorV2): upwind the sail is an airfoil (tight
// tolerance, stalls/luffs toward 0); dead downwind it's a drag device (wide
// tolerance, high floor, cannot stall).
inline float trimFactorV2(float sheetAngleDeg, float absAngle, const Rig& r) {
  float optimal  = optimalSheetAngle(absAngle);
  float mismatch = sheetAngleDeg - optimal;             // <0 too tight, >0 eased too far
  float dw       = smooth01(absAngle, 100.0f, 160.0f);  // 0 airfoil -> 1 drag device
  float floorQ   = 0.70f * dw;
  float tightW   = (20.0f + 56.0f * dw) * r.trimForgive;
  float easeW    = (32.0f + 58.0f * dw) * r.trimForgive;
  float width    = std::max(1.0f, mismatch < 0.0f ? tightW : easeW);
  float x        = std::min(1.0f, std::fabs(mismatch) / width);
  return floorQ + (1.0f - floorQ) * (1.0f - x * x);
}
}  // namespace detail

// One physics tick. windFromDeg = wind FROM bearing (deg); windSpeed knots; rudder -1/0/+1.
// seaRough 0..1. Drive is scaled by the player-set sheet trim (v.sheetAngleDeg);
// sheetDir eases (+1, Q) / hauls (-1, E) at the client's 28 deg/s.
inline void step(Vessel& v, const Rig& r, float dt, float windFromDeg, float windSpeed,
                 float seaRough, int rudder, float travelScale, int sheetDir = 0) {
  const float SHEET_RATE = 28.0f;   // deg/s while Q/E held (client SHEET_RATE)
  if (sheetDir > 0) v.sheetAngleDeg = std::min(88.0f, v.sheetAngleDeg + SHEET_RATE * dt);
  if (sheetDir < 0) v.sheetAngleDeg = std::max(5.0f, v.sheetAngleDeg - SHEET_RATE * dt);
  const float DEG = glm::pi<float>() / 180.0f;
  const float HEEL_K = 0.22f, COMFORT_HEEL = 16.0f, SPILL_RANGE = 14.0f, SPILL_MAX = 0.75f, MAX_HEEL = 26.0f;
  const float DRAG_K = 1.0f, TURN_SCRUB = 0.06f, SEA_DRAG_K = 0.06f, FORCE_RESPONSE = 0.04f, WEIGHT_REF = 2800.0f;
  const float YAW_RESPONSE = 4.0f, IRONS_FALLOFF = 6.0f;

  float hr = v.heading;
  float windFrom = windFromDeg * DEG;

  // Tack side (which side the wind is on), from heading vs wind-FROM bearing.
  float diff = std::fmod((v.heading / DEG) - windFromDeg + 360.0f, 360.0f);
  bool isPortTack = diff <= 180.0f;

  // Apparent wind = true-wind vector - boat-velocity vector.
  float bvx = std::sin(hr) * v.speed, bvz = std::cos(hr) * v.speed;
  float wvx = -std::sin(windFrom) * windSpeed, wvz = -std::cos(windFrom) * windSpeed;
  float ax = wvx - bvx, az = wvz - bvz;
  float appWind = std::hypot(ax, az);
  float cosA = (-ax * std::sin(hr) - az * std::cos(hr)) / (appWind > 1e-4f ? appWind : 1.0f);
  float driveAngle = std::acos(std::clamp(cosA, -1.0f, 1.0f)) / DEG;   // 0 = bow into apparent wind

  // Drive coefficient × trim quality (client sailEfficiency: trim penalty is 1
  // inside the no-go zone, and reefed sails report perfect trim with no drive).
  v.driveAngle = driveAngle;
  float trim = (v.sailState == 0 || driveAngle < r.minTackAngle)
             ? 1.0f : detail::trimFactorV2(v.sheetAngleDeg, driveAngle, r);
  v.trimQ = trim;
  float eff = (v.sailState == 0) ? 0.0f
            : detail::polarDrive(driveAngle, r) * (v.sailState == 1 ? 0.5f : 1.0f) * trim;

  // Heel from wind side-force; over comfort the sail spills wind (drive falls off).
  float canvas = (v.sailState == 2) ? 1.0f : (v.sailState == 1 ? 0.5f : 0.0f);
  float heelRaw = HEEL_K * r.sailAreaFactor * canvas * appWind * appWind * std::sin(driveAngle * DEG);
  float heelSpill = std::clamp((heelRaw - COMFORT_HEEL) / SPILL_RANGE, 0.0f, 1.0f);
  // Signed: heels to leeward — on port tack (wind from port) the boat leans to
  // starboard (stbd-down = positive, matching the buoyancy roll convention).
  float heelSign = isPortTack ? 1.0f : -1.0f;
  v.heelDeg = heelSign * std::min(MAX_HEEL, heelRaw * (1.0f - 0.45f * heelSpill));

  // Force model: a = (thrust - drag)*response/mass.
  float driveC = eff * (1.0f - SPILL_MAX * heelSpill);
  float thrust = r.forceK * r.sailAreaFactor * driveC * appWind * appWind;
  float intoSea = 1.0f - driveAngle / 180.0f;
  float drag = DRAG_K * v.speed * std::fabs(v.speed)
             + TURN_SCRUB * std::fabs(v.yawRate) * std::fabs(v.speed)
             + SEA_DRAG_K * seaRough * (0.5f + intoSea) * std::fabs(v.speed);
  float massK = std::max(0.2f, r.weight / WEIGHT_REF);
  v.speed += (thrust - drag) * FORCE_RESPONSE / massK * dt;
  v.speed = std::clamp(v.speed, -1.5f, r.maxSpeed);
  if (std::fabs(v.speed) < 0.001f) v.speed = 0.0f;

  // Steering: helm sets a target yaw the boat eases toward (angular inertia).
  float maxYaw = detail::turnRate(v.speed, r.maxSpeed) * DEG;
  float targetYaw = (float)rudder * maxYaw;
  v.yawRate += (targetYaw - v.yawRate) * std::min(1.0f, YAW_RESPONSE * dt);
  v.heading = v.heading + v.yawRate * dt;
  // In irons and losing way: the wind blows the bow off the eye.
  if (rudder == 0 && driveAngle < r.minTackAngle && std::fabs(v.speed) < 1.5f) {
    float signed_ = diff > 180.0f ? diff - 360.0f : diff;
    float fall = (signed_ >= 0 ? 1.0f : -1.0f) * IRONS_FALLOFF * (1.0f - std::fabs(v.speed) / 1.5f);
    v.heading += fall * DEG * dt;
  }
  v.heading = std::fmod(v.heading, glm::two_pi<float>());

  // Leeway: side-slip proportional to heel; per-rig leewayK.
  float leewayDeg = v.heelDeg * 0.28f * r.leewayK;
  float leewayRad = leewayDeg * DEG;
  float leewaySign = isPortTack ? 1.0f : -1.0f;
  float hr2 = v.heading;
  float lwyX = std::cos(hr2) * leewaySign * std::fabs(v.speed) * leewayRad * dt * travelScale;
  float lwyZ = -std::sin(hr2) * leewaySign * std::fabs(v.speed) * leewayRad * dt * travelScale;
  float newX = v.x + std::sin(hr2) * v.speed * dt * travelScale + lwyX;
  float newZ = v.z + std::cos(hr2) * v.speed * dt * travelScale + lwyZ;

  if (v.anchored) {
    const float ANCHOR_RADIUS = 6.0f;
    float dx = newX - v.anchorX, dz = newZ - v.anchorZ, d = std::hypot(dx, dz);
    if (d > ANCHOR_RADIUS) { newX = v.anchorX + dx / d * ANCHOR_RADIUS; newZ = v.anchorZ + dz / d * ANCHOR_RADIUS; v.speed = 0; }
  }
  v.x = newX; v.z = newZ;
}

struct Buoy { float heave, pitchRad, rollRad; };

// 8-point wave buoyancy (client vessel-buoyancy.service). waveHeight(worldX, worldZ)
// returns the FFT surface height. Filters heave/pitch/roll into the vessel state.
inline Buoy buoyancy(Vessel& v, const Rig& r, float dt,
                     const std::function<float(float, float)>& waveHeight) {
  static const glm::vec2 HULL[8] = {   // (fwd, rgt) sloop template
    {5.5f,0.0f},{3.5f,-2.0f},{3.5f,2.0f},{0.0f,-2.2f},{0.0f,2.2f},{-3.5f,-2.0f},{-3.5f,2.0f},{-4.5f,0.0f}};
  const float REF_LEN = 7.0f, REF_BEAM = 2.2f, MAX_TILT = 0.20f;
  float sl = r.hullHalfLen / REF_LEN, sb = r.hullHalfBeam / REF_BEAM;
  float sh = std::sin(v.heading), ch = std::cos(v.heading);

  float meanH = 0, pitchTorq = 0, rollTorq = 0, armFwd2 = 0, armRgt2 = 0;
  for (const glm::vec2& p : HULL) {
    float fwd = p.x * sl, rgt = p.y * sb;
    float wx = v.x + sh * fwd + ch * rgt;   // forward=(sin,cos), right=(cos,-sin)
    float wz = v.z + ch * fwd - sh * rgt;
    float h = waveHeight(wx, wz);
    meanH += h; pitchTorq += h * fwd; rollTorq += h * rgt;
    armFwd2 += fwd * fwd; armRgt2 += rgt * rgt;
  }
  const int N = 8;
  meanH /= N;
  float pitchRaw = pitchTorq / std::max(1e-3f, armFwd2 / N) * r.pitchScale;
  float rollRaw  = rollTorq  / std::max(1e-3f, armRgt2 / N) * r.pitchScale;
  pitchRaw = std::clamp(pitchRaw, -MAX_TILT, MAX_TILT);
  rollRaw  = std::clamp(rollRaw,  -MAX_TILT, MAX_TILT);

  float hAlpha = 1.0f - std::exp(-dt / std::max(0.05f, r.heaveTau));
  v.heaveF += (meanH - v.heaveF) * hAlpha;
  float pAlpha = (r.tiltTau > 0.0f) ? (1.0f - std::exp(-dt / r.tiltTau)) : std::min(1.0f, 0.028f + dt * 2.5f);
  v.pitchF += (pitchRaw - v.pitchF) * pAlpha;
  v.rollF  += (rollRaw  - v.rollF)  * pAlpha;
  return { v.heaveF, v.pitchF, v.rollF };
}

}  // namespace sail
