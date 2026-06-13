'use strict';

/**
 * Authoritative combat logic. The server owns every ship's pose (from `update`) and
 * every shot (from `cannon_shot`), so it re-flies each shot's ballistic trajectory
 * against its OWN dead-reckoned victim positions and decides hit / zone / damage. This
 * makes lag / fake-hit / teleport-fire / fire-rate exploits impossible — the client
 * only renders what the server adjudicates.
 *
 * Conventions (see combat-constants.js): vessel-local +Z = bow, +X = starboard,
 * heading 0deg = North(+Z). lat = beam (+starboard), lon = fore-aft (+bow).
 */

const C = require('./combat-constants');

/** Fresh full-HP hull for a player, seeded from their vessel's per-zone HP (slug → vessel). */
function newCombatState(slug) {
  const hp = C.zoneHpFor(slug);
  const zones = {};
  for (const z of C.ZONES) zones[z] = hp[z];
  // maxHp travels in the combat_state broadcast so clients can size the HUD severity bands
  // per vessel without a separate slug lookup.
  return { zones, maxHp: { ...hp }, slug: slug || 'sloop', sunk: false, shotTimes: [] };
}

/** Which hull zone (if any) contains a point in vessel-local space. null = no hit. */
function zoneAtLocal(lat, lon, y) {
  if (y > C.DECK_Y) {
    // Above the deck: only the centreline mast column counts; otherwise it flies over.
    if (Math.abs(lat) < C.MAST_LAT && Math.abs(lon) < C.MAST_LON && y < C.MAST_Y_TOP) return 'masts';
    return null;
  }
  if (y < -0.5) return null;                                  // well underwater — miss
  if (Math.abs(lon) > C.HALF_LEN || Math.abs(lat) > C.HALF_BEAM) return null;
  if (lon >  C.BOW_LON) return 'bow';
  if (lon < -C.BOW_LON) return 'stern';
  return lat < 0 ? 'port' : 'starboard';
}

/** Project a ship's pose forward by `t` seconds (curving through its turn). */
function deadReckon(state, t) {
  const turn    = (state.turnRate || 0) * t;                 // degrees over the flight
  const hr      = ((state.heading + turn) * Math.PI) / 180;  // heading at impact
  const hrMid   = ((state.heading + turn * 0.5) * Math.PI) / 180;
  const vWorld  = (state.speed || 0) * C.TRAVEL_SCALE;       // world units/s
  const dist    = vWorld * t;
  return {
    x:   state.x + dist * Math.sin(hrMid),
    z:   state.z + dist * Math.cos(hrMid),
    hr,
    vvx: vWorld * Math.sin(hr),
    vvz: vWorld * Math.cos(hr),
  };
}

/**
 * Damage from a hit: heavier when fast + head-on (closing), lighter when slow + glancing,
 * and amplified for a strike at/near the waterline (`hy` = hull-local impact height).
 */
function computeDamage(bvx, bvy, bvz, pose, zone, hy, shotType) {
  const relSpeed = Math.hypot(bvx - pose.vvx, bvy, bvz - pose.vvz);
  let perp;
  if (zone === 'masts') {
    perp = 1;                                                // a pole faces the ball from any side
  } else {
    const hLen = Math.hypot(bvx, bvz) || 1;
    const dirX = bvx / hLen, dirZ = bvz / hLen;
    const c = Math.cos(pose.hr), s = Math.sin(pose.hr);
    const dirLat = dirX * c - dirZ * s;                      // world dir → vessel-local
    const dirLon = dirX * s + dirZ * c;
    const n = C.ZONE_NORMAL[zone];
    perp = Math.min(1, Math.abs(dirLat * n.lat + dirLon * n.lon));
  }
  // Waterline amplifier — full bonus at/below the waterline, fading to none up the hull.
  let waterline = 1;
  if (zone !== 'masts') {
    const prox = Math.max(0, Math.min(1, (C.WATERLINE_BAND - hy) / C.WATERLINE_BAND));
    waterline = 1 + C.WATERLINE_BONUS_MAX * prox;
  }
  // Ammunition multiplier: round shot barely scratches rigging (×0.33 mast); bar shot is the
  // dismaster (×1.6 mast, ×0.6 hull). `hull` covers every non-mast zone.
  const ammo = C.shotDef(shotType).dmg[zone === 'masts' ? 'masts' : 'hull'];
  return C.DMG_K * relSpeed * Math.pow(perp, C.DMG_PERP_EXP) * waterline * ammo;
}

/**
 * "Wait-and-see" adjudication. Instead of predicting the whole flight at fire time, the
 * server flies each shot over WALL-CLOCK time (driven by a step loop) and tests it against
 * each victim's ACTUAL, current pose — so a ship that manoeuvres during the ball's flight
 * genuinely dodges it. This advances one shot across the real-time sub-interval (tFrom,tTo]
 * (flight-seconds since launch) and returns the first hull hit found in that window.
 *
 * Victim poses are their latest reported `state`, micro-dead-reckoned only over the small
 * lag since their last `update` (≤~100 ms) — NOT extrapolated across the full flight.
 *
 * @param shot     {ox,oy,oz,vx,vy,vz, shooterId} world-space origin + velocity
 * @param tFrom    flight-seconds already tested (exclusive)
 * @param tTo      flight-seconds now reached (inclusive)
 * @param players  the server players Map (id -> { state, combat, lastUpdateMs, ... })
 * @param nowMs    current server time (Date.now()) for the victim lag calc
 * @returns {victimId, zone, hx,hy,hz, side, dmg, tof} on hit · {expired:true} once the ball
 *          hits the sea or outlives SIM_MAX_T · null if still in flight with no hit yet.
 */
function stepShot(shot, tFrom, tTo, players, nowMs) {
  if (tFrom >= C.SIM_MAX_T) return { expired: true };

  const victims = [];
  for (const [pid, p] of players) {
    if (pid === shot.shooterId || !p.state || !p.combat || p.combat.sunk) continue;
    const lag = Math.min(0.2, Math.max(0, (nowMs - (p.lastUpdateMs || nowMs)) / 1000));
    victims.push({ pid, pose: deadReckon(p.state, lag) });
  }

  const { ox, oy, oz, vx, vy, vz } = shot;
  const reach2 = (C.HALF_LEN + C.BROADPHASE_PAD) * (C.HALF_LEN + C.BROADPHASE_PAD);

  // Sub-step the ball through the freshly-elapsed window so a fast ball can't tunnel a hull.
  const tEnd = Math.min(tTo, C.SIM_MAX_T);
  for (let t = Math.max(tFrom, 0) + C.SIM_DT; t <= tEnd + 1e-6; t += C.SIM_DT) {
    const bx = ox + vx * t;
    const by = oy + vy * t - 0.5 * C.G * t * t;
    const bz = oz + vz * t;
    if (by < C.SIM_WATER_Y && t > 0.1) return { expired: true };   // into the sea → miss

    for (const v of victims) {
      const pose = v.pose;
      const ddx = bx - pose.x, ddz = bz - pose.z;
      if (ddx * ddx + ddz * ddz > reach2) continue;                // broad-phase reject
      const lat = ddx * Math.cos(pose.hr) - ddz * Math.sin(pose.hr);
      const lon = ddx * Math.sin(pose.hr) + ddz * Math.cos(pose.hr);
      const zone = zoneAtLocal(lat, lon, by);
      if (!zone) continue;
      const side = lat < 0 ? 'port' : 'stbd';
      const dmg  = computeDamage(vx, vy - C.G * t, vz, pose, zone, by, shot.shotType);
      return { victimId: v.pid, zone, hx: bx, hy: by, hz: bz, side, dmg, tof: t };
    }
  }
  return null;
}

/** Plausibility check on a claimed shot (origin near shooter, speed in band). */
function validateShot(shot, shooterState, shotType) {
  if (!shooterState) return false;
  const speed = Math.hypot(shot.vx, shot.vy, shot.vz);
  const band = C.shotDef(shotType);   // bar shot has a lower plausible-velocity band than round
  if (speed < band.vMin || speed > band.vMax) return false;
  const dx = shot.ox - shooterState.x, dz = shot.oz - shooterState.z;
  return dx * dx + dz * dz <= C.VALID_ORIGIN_RADIUS * C.VALID_ORIGIN_RADIUS;
}

/** Fire-rate gate (sliding window + min spacing). Mutates combat.shotTimes. */
function allowShot(combat, nowMs) {
  if (!combat) return false;
  const times = combat.shotTimes;
  while (times.length && nowMs - times[0] > C.RATE_WINDOW_MS) times.shift();
  if (times.length >= C.RATE_MAX_SHOTS) return false;
  if (times.length && nowMs - times[times.length - 1] < C.RATE_MIN_GAP_MS) return false;
  times.push(nowMs);
  return true;
}

/** Apply damage to a zone; returns { sunk } where sunk=true the instant a non-mast zone hits 0. */
function applyDamage(combat, zone, dmg) {
  combat.zones[zone] = Math.max(0, combat.zones[zone] - dmg);
  let justSunk = false;
  if (zone !== 'masts' && combat.zones[zone] === 0 && !combat.sunk) {
    combat.sunk = true;
    justSunk = true;
  }
  return { justSunk };
}

/**
 * Mast self-repair tick (call ~1 Hz per player). The first time the masts zone is at 0 (and the ship
 * isn't sunk) this arms a jury-rig timer; once it elapses the mast is restored to MAST_REPAIR_FRAC of
 * max (a partial fix — full repair still needs a port). Returns true the instant it repairs, so the
 * caller broadcasts the new combat_state. The timer rides on `combat.mastRepairUntil`, so it clears
 * itself on any newCombatState (respawn / port repair / vessel change) and is never persisted.
 */
function tickMastRepair(combat, nowMs) {
  if (!combat || combat.sunk) return null;    // sinking ships respawn (which resets the mast) — don't repair
  if (combat.mastRepairUntil) {
    if (nowMs >= combat.mastRepairUntil) {
      combat.zones.masts = Math.round(combat.maxHp.masts * C.MAST_REPAIR_FRAC);
      combat.mastRepairUntil = 0;
      return 'repaired';
    }
  } else if (combat.zones.masts <= 0) {
    // Arm the jury-rig. Flat MAST_REPAIR_MS for now; crew/morale will scale this later — keep that decision
    // HERE (the single source of truth), since the client is TOLD the duration and just follows it.
    combat.mastRepairUntil = nowMs + C.MAST_REPAIR_MS;
    return 'armed';
  }
  return null;
}

/**
 * Rebuild a combat state from persisted per-zone HP (damage persistence). Starts from a fresh full hull for
 * the vessel (so maxHp/zone list are authoritative for the current vessel), then clamps in the saved current
 * HP and recomputes the sunk flag. Used on reconnect to restore battle damage.
 */
function restoreCombatState(slug, savedZones) {
  const s = newCombatState(slug);
  if (savedZones && typeof savedZones === 'object') {
    for (const z of C.ZONES) {
      const v = savedZones[z];
      if (typeof v === 'number' && isFinite(v)) s.zones[z] = Math.max(0, Math.min(s.maxHp[z], v));
    }
    for (const z of C.ZONES) {
      if (z !== 'masts' && s.zones[z] === 0) s.sunk = true;
    }
  }
  return s;
}

module.exports = {
  newCombatState, restoreCombatState, zoneAtLocal, deadReckon, computeDamage,
  stepShot, validateShot, allowShot, applyDamage, tickMastRepair,
};
