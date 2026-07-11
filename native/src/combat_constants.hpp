// Combat constants — verbatim ports of client combat.constants.ts /
// cannon.service.ts and server combat-constants.js. The server is unchanged and
// enforces the same numbers; the client must self-limit identically or its
// shots are silently dropped.
#pragma once

namespace combat {

// ── Ballistics (cannon.service.ts) ──
inline constexpr float kGravity        = 9.81f;
inline constexpr float kTravelScale    = 3.0f;    // world velocity per physics speed unit
inline constexpr float kMuzzleVRound   = 55.0f;   // m/s — solid shot (anti-hull)
inline constexpr float kMuzzleVBar     = 37.0f;   // m/s — bar shot (anti-rigging)
inline constexpr float kMuzzleVGrape   = 26.0f;   // m/s — grape (anti-crew)
inline constexpr int   kGrapePellets   = 5;
inline constexpr float kGrapeSpreadRad = 7.0f  * 3.14159265f / 180.0f;   // azimuth half-cone
inline constexpr float kGrapeElevRad   = 4.0f  * 3.14159265f / 180.0f;   // elevation jitter

// ── Carronades (spar-deck "smashers"): short range, heavy ball (cannon.service.ts) ──
// A muzzle tagged carronade fires at a reduced velocity (range ∝ v²) so it splashes
// short (~100 m); the battery AUTO-HOLDS these guns until an enemy is inside reach on
// that side. The server validates the short shot against carronadeBand + applies the
// close-range damage multiplier — the client just fires the flagged, slow ball.
inline constexpr float kCarronadeVFactor = 0.56f;    // × ammo muzzle velocity
inline constexpr float kCarronadeRange   = 110.0f;   // m — auto-hold cutoff (tracks VFactor² × long reach)

// ── Elevation control (deg) ──
inline constexpr float kElevMin   = 0.0f;
inline constexpr float kElevMax   = 18.0f;
inline constexpr float kElevHull  = 3.0f;
inline constexpr float kElevMast  = 12.0f;
inline constexpr float kElevRate  = 7.0f;    // deg/s while held

// ── Aim assist (soft lock) ──
inline constexpr float kLockArcDeg   = 42.0f;    // acquisition cone off the beam
inline constexpr float kAimConeDeg   = 52.0f;    // max azimuth correction from the beam
inline constexpr float kLockMaxRange = 320.0f;   // m
inline constexpr float kAimLowY      = 0.6f;     // waterline aim height (elev=hull)
inline constexpr float kAimHighY     = 14.0f;    // masthead aim height (elev=mast)
inline constexpr float kAimWaterY    = 0.5f;     // free-aim arc terminates at this height
inline constexpr int   kAimSamples   = 40;       // trajectory tube samples

// ── Broadside timing ──
inline constexpr float kStaggerMin    = 0.18f;   // s between rippled guns
inline constexpr float kStaggerMax    = 0.42f;
inline constexpr float kReloadBase    = 6.0f;    // s, / crewFactor (server token refill matches)
inline constexpr float kReloadVar     = 0.16f;   // ±16% fixed per-gun factor
inline constexpr float kReloadJitter  = 0.07f;   // ±7% per reload cycle
inline constexpr float kReloadMin     = 0.3f;    // s floor
inline constexpr float kGunDeployRate = 1.4f;    // deploy units/s (~0.7 s to arm)
inline constexpr float kGunRecoilDecay= 5.0f;    // recoil impulse decay /s

// ── Visuals ──
inline constexpr float kFlashDur         = 0.60f;
inline constexpr int   kBallPool         = 24;
inline constexpr int   kDecalMaxPerShip  = 16;

// ── Damage listing / capsize (combat.constants.ts) ──
inline constexpr float kListRollMax    = 0.32f;   // rad (~18 deg) at total beam loss
inline constexpr float kListPitchMax   = 0.24f;   // rad (~14 deg) at total end loss
inline constexpr float kListCurve      = 0.55f;   // pow curve — partial damage lists sooner
inline constexpr float kSinkDur        = 3.2f;    // s to full wreck (smoothstep)
inline constexpr float kSinkDepth      = 3.2f;    // m the hull settles
inline constexpr float kCapsizeRollMax = 0.96f;   // rad (~55 deg)
inline constexpr float kCapsizePitchMax= 0.49f;   // rad (~28 deg)
inline constexpr float kSinkRevealMs   = kSinkDur * 1000.0f + 700.0f;   // "you were sunk" card delay

// ── Masts ──
inline constexpr float kMastDamageOnset = 0.60f;  // damage shows / penalty begins below 60% hp
inline constexpr float kMastSlowFloor   = 0.30f;  // worst partial sail-power multiplier
inline constexpr float kMastDownTurnMax = 6.0f;   // deg/s helm cap once fully down

// ── Severity bands (HUD) ──
inline constexpr float kSevGreenMin  = 0.60f;
inline constexpr float kSevYellowMin = 0.30f;

// ── Salvage (salvage.service.ts / salvage.js) ──
inline constexpr float kCrateW = 2.4f, kCrateH = 1.6f, kCrateD = 2.4f;   // m
inline constexpr float kCrateCollectR = 40.0f;    // client request radius (server re-checks 60)

}  // namespace combat
