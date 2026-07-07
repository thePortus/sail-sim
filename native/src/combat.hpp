// Combat state + zone math — faithful ports of client combat.constants.ts
// helpers (listingFor, capsizeFor, mast drivers, severity bands) and the
// per-vessel zone HP tables. The SERVER owns all the numbers; these formulas
// only turn its authoritative zone HP into display state.
#pragma once

#include <string>

namespace combat {

// Zone HP, in the server's canonical order. A value < 0 means "unknown yet"
// (the server omits maxHp after the first combat_state).
struct Zones {
  float bow = -1, stern = -1, port = -1, starboard = -1, masts = -1;
  bool known() const { return bow >= 0; }
};

// Per-vessel zone maxima (combat-constants.js ZONE_HP_BY_SLUG). Armor upgrade
// multiplies the four hull zones by 1.25 (never masts).
Zones zoneHpFor(const std::string& slug, bool armorUpgrade);

enum class Severity { None, Green, Yellow, Red, Destroyed };
Severity severityFor(float hp, float maxHp);

// In-combat damage listing: roll toward the holed beam, pitch toward the
// damaged end (rad). LIST_CURVE makes partial damage list early.
struct Listing { float roll = 0, pitch = 0; };
Listing listingFor(const Zones& z, const Zones& maxHp);

// Full-sink capsize pose at sinkProgress = 1 (forces a tip if the damage is
// too even to pick a side).
Listing capsizeFor(const Zones& z, const Zones& maxHp);

// Smoothstepped 0..1 over kSinkDur.
float sinkProgress(float elapsedSec);

// Mast drivers (health = masts hp / max, 0..1).
float mastHealth(const Zones& z, const Zones& maxHp);
float mastDownAmount(float health);    // 0 upright .. 1 collapsed (sqrt-fronted lean)
float mastBreakAmount(float health);   // splinter morph 0..1 (linear below onset)
float mastSpeedMult(float health);     // sail drive multiplier (floor 0.30, 0 when down)

}  // namespace combat
