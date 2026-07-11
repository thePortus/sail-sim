#include "combat.hpp"

#include <algorithm>
#include <cmath>

#include "combat_constants.hpp"

namespace combat {

Zones zoneHpFor(const std::string& slug, bool armorUpgrade) {
  Zones z;
  if (slug == "pinnace")          z = { 55, 55, 80, 80, 60 };
  else if (slug == "brig")        z = { 140, 140, 200, 200, 150 };
  else if (slug == "merchantman") z = { 150, 150, 220, 220, 160 };
  else if (slug == "frigate_heavy")  z = { 250, 250, 360, 360, 250 };
  else if (slug == "frigate_medium") z = { 230, 230, 320, 320, 230 };
  else if (slug == "frigate_light")  z = { 210, 210, 280, 280, 210 };
  else                            z = { 90, 90, 130, 130, 100 };   // sloop default
  if (armorUpgrade) { z.bow *= 1.25f; z.stern *= 1.25f; z.port *= 1.25f; z.starboard *= 1.25f; }
  return z;
}

Severity severityFor(float hp, float maxHp) {
  if (maxHp <= 0) return Severity::None;
  float frac = hp / maxHp;
  if (frac >= 1.0f) return Severity::None;
  if (frac >= kSevGreenMin) return Severity::Green;
  if (frac >= kSevYellowMin) return Severity::Yellow;
  if (frac > 0.0f) return Severity::Red;
  return Severity::Destroyed;
}

// Damage fraction with the listing curve applied (client listingFor's dmg()).
static float dmgCurve(float hp, float maxHp) {
  if (maxHp <= 0) return 0.0f;
  float frac = 1.0f - std::clamp(hp < 0 ? 1.0f : hp / maxHp, 0.0f, 1.0f);
  return std::pow(frac, kListCurve);
}
static float dmgLin(float hp, float maxHp) {
  if (maxHp <= 0) return 0.0f;
  return 1.0f - std::clamp(hp < 0 ? 1.0f : hp / maxHp, 0.0f, 1.0f);
}

Listing listingFor(const Zones& z, const Zones& maxHp) {
  Listing l;
  l.roll  = kListRollMax  * (dmgCurve(z.port, maxHp.port) - dmgCurve(z.starboard, maxHp.starboard));
  l.pitch = kListPitchMax * (dmgCurve(z.bow, maxHp.bow)   - dmgCurve(z.stern, maxHp.stern));
  return l;
}

Listing capsizeFor(const Zones& z, const Zones& maxHp) {
  float rollN  = dmgLin(z.port, maxHp.port) - dmgLin(z.starboard, maxHp.starboard);
  float pitchN = dmgLin(z.bow, maxHp.bow)   - dmgLin(z.stern, maxHp.stern);
  // Force a tip if neither beam nor end dominates (avoid a flat settle).
  if (std::fabs(rollN) < 0.15f && std::fabs(pitchN) < 0.35f)
    rollN = (rollN >= 0 ? 1.0f : -1.0f) * 0.6f;
  Listing l;
  l.roll  = kCapsizeRollMax  * std::clamp(rollN, -1.0f, 1.0f);
  l.pitch = kCapsizePitchMax * std::clamp(pitchN, -1.0f, 1.0f);
  return l;
}

float sinkProgress(float elapsedSec) {
  float t = std::clamp(elapsedSec / kSinkDur, 0.0f, 1.0f);
  return t * t * (3.0f - 2.0f * t);
}

float mastHealth(const Zones& z, const Zones& maxHp) {
  if (!z.known() || maxHp.masts <= 0) return 1.0f;
  return std::clamp(z.masts / maxHp.masts, 0.0f, 1.0f);
}

float mastDownAmount(float health) {
  if (health <= 0.0f) return 1.0f;
  if (health >= kMastDamageOnset) return 0.0f;
  float t = (kMastDamageOnset - health) / kMastDamageOnset;
  return std::sqrt(t) * 0.55f;   // sqrt front-loads the lean
}

float mastBreakAmount(float health) {
  if (health >= kMastDamageOnset) return 0.0f;
  return (kMastDamageOnset - std::max(0.0f, health)) / kMastDamageOnset;
}

float mastSpeedMult(float health) {
  if (health <= 0.0f) return 0.0f;
  if (health >= kMastDamageOnset) return 1.0f;
  return kMastSlowFloor + (1.0f - kMastSlowFloor) * (health / kMastDamageOnset);
}

}  // namespace combat
