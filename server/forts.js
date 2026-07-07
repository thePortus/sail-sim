'use strict';

/**
 * Harbor-fort COMBAT (server-authoritative). Forts are static gun batteries built from the terrain manifest's
 * `harbors[].forts[]` (placement + per-gun muzzle world positions come from deriveForts). They fire through the
 * SAME wait-and-see shot machinery as ships/NPCs (register a shot → combat.stepShot → resolveHit), and take
 * damage from ship balls via stepShotForts below.
 *
 * DESIGN (per the design pass):
 *  • SECTIONAL / degrading — each GUN is a section with its own HP. A ball hits the nearest gun; at 0 that gun
 *    stops firing (you suppress a face by battering its guns). All guns down → the fort is NEUTRALISED (silent).
 *  • FACTION-HOSTILE on sight — a fort shells any player at/below FORT_HOSTILE_REP with its nation (they've
 *    raided its shipping) plus flagged pirates; brand-new captains (intro tutorial) are always shielded.
 *  • LONG-RANGE GAUNTLET — forts out-range ships ~3–4× and fire ACCURATELY from a fixed platform (tight scatter
 *    + real target leading), so slow/straight-line ships get punished but a manoeuvring captain can still juke
 *    the multi-second flight.
 *  • Very hard to defeat — HP + accurate concentrated fire tuned so 3 brigs can't take a capital, and a lone
 *    brig only barely takes a small-town battery.
 *
 * DEFEAT → (future) TOWN CAPTURE. For now a neutralised fort stays silent and slowly rebuilds after REPAIR_MS,
 * so towns aren't permanently disarmed; the capture feature will replace that repair with a capture window.
 */

const C = require('./combat-constants');
const quest = require('./quest');

const DEG = Math.PI / 180;

// ── Per-tier tuning (playtest these against the difficulty targets) ──────────────────────────────────────────
//   gunHp   HP of each gun-section (a ship ball ≈ DMG_K·speed·caliber ≈ 40–55 per hit)
//   range   engage/fire range (world units) — ship practical range is ~150–260, so this is the 3–4× gauntlet
//   muzzleV ball speed; ≈ sqrt(range·G) so a target at max range is just reachable on the low arc
//   caliber ball damage multiplier vs SHIPS (heavier than any ship gun)
//   spread  aim scatter (radians, 1σ) — small = accurate fixed platform
const FORT = {
  // T1 has a lone gun (vs a brig's 4), so it leans on HP to make a single brig a real fight; T2/T3 lean on
  // gun count. STARTING POINTS — the 3-brigs-can't-take-a-capital / 1-brig-barely-takes-a-battery feel needs an
  // in-game playtest pass (watch: is T1 too easy? is T3 an instant delete? tune gunHp/caliber/reload/spread).
  // Per-shot caliber kept BELOW a brig's (1.7): a fort ball is already faster (more speed-damage) and tends to
  // strike the waterline (bonus), so high caliber made T2/T3 2-shot a brig. T1's lone gun keeps some punch.
  small:   { gunHp: 900, reloadMs: 4600, range: 450, muzzleV: 68, caliber: 1.30, spread: 0.016, height: 8  },
  medium:  { gunHp: 420, reloadMs: 6500, range: 550, muzzleV: 75, caliber: 0.75, spread: 0.016, height: 10 },
  capital: { gunHp: 440, reloadMs: 6000, range: 650, muzzleV: 82, caliber: 0.80, spread: 0.014, height: 14 },
};
const FORT_DMG_MULT   = 1.4;              // ship-ball damage to a fort gun-section (bumped so forts aren't a slog)
const FORT_HOSTILE_REP = -25;            // a player at/below this standing with the fort's nation is a target on sight
const REPAIR_MS       = 12 * 60 * 1000;  // interim: a neutralised fort rebuilds after this (until capture lands)
const GRUDGE_MS       = 90 * 1000;       // a fort returns fire on anyone who shells it for this long (self-defence)

// ── Build the fort registry from the terrain manifest ───────────────────────────────────────────────────────
function build(harbors) {
  const forts = [];
  for (const h of harbors || []) {
    for (const f of h.forts || []) {
      const spec = FORT[f.tier] || FORT.small;
      const guns = (f.guns || []).map((g, i) => ({
        i, x: g.x, y: g.y, z: g.z, hp: spec.gunHp, maxHp: spec.gunHp, lastShotAt: 0,
      }));
      if (!guns.length) continue;
      forts.push({
        id: `fort_${h.id}`, townId: h.id, name: h.name || 'a fort', faction: h.faction || null, tier: f.tier,
        x: f.x, y: f.y || 0, z: f.z, heading: f.heading || 0,
        hw: f.hw || 8, hd: f.hd || 8, spec, guns, neutralizedAt: 0,
      });
    }
  }
  return forts;
}

const gauss = (sigma) => sigma * (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.7071;

// Would this fort open fire on `p` (id `pid`)? Faction-hostile on sight, OR anyone who has SHELLED it recently
// (self-defence — regardless of standing). New captains are always shielded; pirates are always fair game.
function isTarget(fort, pid, p, nowMs) {
  if (!p.state || (p.combat && p.combat.sunk) || p.godmode) return false;
  if (p.isNpc) return !!p.isPirate;                                   // forts shell pirates, ignore honest traders
  if (p.questState && quest.inIntro(p.questState)) return false;      // brand-new captain — leave them be
  if (fort.grudges && fort.grudges.get(pid) > nowMs) return true;     // it fired on us → we fire back
  if (!fort.faction) return false;
  return ((p.factionRep && p.factionRep[fort.faction]) || 0) <= FORT_HOSTILE_REP;
}

/** Record that `shooterId` shelled this fort → it returns fire for GRUDGE_MS even at neutral standing. */
function markAttacker(fort, shooterId, nowMs) {
  if (!shooterId || String(shooterId).startsWith('fort_')) return;
  (fort.grudges || (fort.grudges = new Map())).set(shooterId, nowMs + GRUDGE_MS);
}

/** Leading ballistic solution from a fixed gun muzzle to a moving target, tight scatter. Returns
 *  world { ox,oy,oz, vx,vy,vz } or null (out of reach / out of range). */
function firingSolution(gun, fort, foeState) {
  const ox = gun.x, oy = gun.y, oz = gun.z;
  const dx = foeState.x - ox, dz = foeState.z - oz;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3 || dist > fort.spec.range) return null;
  const vW = (foeState.speed || 0) * C.TRAVEL_SCALE;
  const tvx = Math.sin(foeState.heading * DEG) * vW, tvz = Math.cos(foeState.heading * DEG) * vW;
  const v = fort.spec.muzzleV, v2 = v * v, dY = 0 - oy;              // target ~waterline; muzzle up high → drop
  let tof = dist / (v * 0.97), theta = 0, px = foeState.x, pz = foeState.z, R = dist;
  for (let k = 0; k < 3; k++) {
    px = foeState.x + tvx * tof; pz = foeState.z + tvz * tof;
    R = Math.hypot(px - ox, pz - oz);
    const disc = v2 * v2 - C.G * (C.G * R * R + 2 * dY * v2);
    if (disc < 0) return null;
    theta = Math.atan2(v2 - Math.sqrt(disc), C.G * R);               // low (direct-fire) arc
    tof = R / (v * Math.cos(theta));
  }
  const az = Math.atan2(px - ox, pz - oz) + gauss(fort.spec.spread);
  const el = theta + gauss(fort.spec.spread);
  const vhs = v * Math.cos(el);
  return { ox, oy, oz, vx: vhs * Math.sin(az), vy: v * Math.sin(el), vz: vhs * Math.cos(az) };
}

/** Per-tick: each fort with a live gun targets the nearest hostile in range and fires each ready gun. A fully
 *  neutralised fort stays silent and slowly rebuilds. `fireShot(fort, gun, sol)` registers + relays the ball. */
function tickForts(forts, players, nowMs, fireShot) {
  for (const fort of forts) {
    const live = fort.guns.filter((g) => g.hp > 0);
    if (!live.length) {                                              // neutralised → interim slow rebuild
      if (fort.neutralizedAt && nowMs - fort.neutralizedAt >= REPAIR_MS) {
        for (const g of fort.guns) g.hp = g.maxHp;
        fort.neutralizedAt = 0; fort.dirty = true;
      }
      continue;
    }
    let target = null, bd = fort.spec.range * fort.spec.range;
    for (const [pid, p] of players) {
      if (!isTarget(fort, pid, p, nowMs)) continue;
      const dx = p.state.x - fort.x, dz = p.state.z - fort.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; target = p; }
    }
    if (!target) continue;
    for (const g of live) {
      if (nowMs - g.lastShotAt < fort.spec.reloadMs) continue;
      const sol = firingSolution(g, fort, target.state);
      if (sol) { fireShot(fort, g, sol); g.lastShotAt = nowMs; }
    }
  }
}

/** Test one ship ball across (tFrom,tTo] against every fort's footprint box; on the first hit return the fort +
 *  nearest live gun + damage. Fort-fired shots (shooterId `fort_*`) are ignored (forts don't shell each other).
 *  Mirrors combat.stepShot's sub-stepping so a fast ball can't tunnel the box. `caliber` = the SHOOTER's. */
function stepShotForts(shot, tFrom, tTo, forts, caliber) {
  if (String(shot.shooterId).startsWith('fort_')) return null;
  const { ox, oy, oz, vx, vy, vz } = shot;
  const tEnd = Math.min(tTo, C.SIM_MAX_T);
  for (let t = Math.max(tFrom, 0) + C.SIM_DT; t <= tEnd + 1e-6; t += C.SIM_DT) {
    const bx = ox + vx * t, by = oy + vy * t - 0.5 * C.G * t * t, bz = oz + vz * t;
    if (by < C.SIM_WATER_Y && t > 0.1) return null;                 // into the sea — combat.stepShot expires it
    for (const fort of forts) {
      if (!fort.guns.some((g) => g.hp > 0)) continue;               // neutralised ruins don't block shot
      if (by < fort.y - 2 || by > fort.y + fort.spec.height) continue;
      const ddx = bx - fort.x, ddz = bz - fort.z;
      const hr = fort.heading * DEG;
      const lat = ddx * Math.cos(hr) - ddz * Math.sin(hr);          // across the frontage
      const lon = ddx * Math.sin(hr) + ddz * Math.cos(hr);          // seaward
      if (Math.abs(lat) > fort.hw || Math.abs(lon) > fort.hd) continue;
      let gi = -1, gd = Infinity;                                   // damage the nearest LIVE gun
      for (const g of fort.guns) { if (g.hp <= 0) continue; const dd = (g.x - bx) ** 2 + (g.z - bz) ** 2; if (dd < gd) { gd = dd; gi = g.i; } }
      if (gi < 0) continue;
      const dmg = C.DMG_K * Math.hypot(vx, vy - C.G * t, vz) * (caliber || 1) * FORT_DMG_MULT;
      return { fort, gunIdx: gi, dmg, hx: bx, hy: by, hz: bz, tof: t };
    }
  }
  return null;
}

/** Apply a resolved fort hit. Returns { gunDown, neutralized } so the caller can announce + broadcast. */
function applyFortHit(fort, gunIdx, dmg, nowMs) {
  const g = fort.guns[gunIdx];
  if (!g || g.hp <= 0) return { gunDown: false, neutralized: false };
  const was = g.hp;
  g.hp = Math.max(0, g.hp - dmg);
  const gunDown = was > 0 && g.hp === 0;
  let neutralized = false;
  if (gunDown && fort.guns.every((x) => x.hp <= 0) && !fort.neutralizedAt) {
    fort.neutralizedAt = nowMs; neutralized = true;
  }
  return { gunDown, neutralized };
}

/** Client-facing state for a fort (per-gun HP + neutralised flag). */
function serialize(fort) {
  return {
    id: fort.id, guns: fort.guns.map((g) => ({ hp: Math.round(g.hp), maxHp: g.maxHp })),
    neutralized: !!fort.neutralizedAt,
  };
}

module.exports = { build, tickForts, stepShotForts, applyFortHit, markAttacker, isTarget, serialize, FORT, FORT_HOSTILE_REP };
