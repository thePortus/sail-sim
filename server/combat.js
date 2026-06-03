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

/** Fresh full-HP hull for a newly connected player. */
function newCombatState() {
  const zones = {};
  for (const z of C.ZONES) zones[z] = C.ZONE_HP[z];
  return { zones, sunk: false, shotTimes: [] };
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
function computeDamage(bvx, bvy, bvz, pose, zone, hy) {
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
  return C.DMG_K * relSpeed * Math.pow(perp, C.DMG_PERP_EXP) * waterline;
}

/**
 * Re-fly a shot and return the first hull hit, or null (miss).
 * @param shot     {ox,oy,oz,vx,vy,vz} world-space origin + velocity
 * @param players  the server players Map (id -> { state, combat, ... })
 * @returns {victimId, zone, hx,hy,hz, side, dmg} | null
 */
function simulateShot(shot, shooterId, players) {
  const victims = [];
  for (const [pid, p] of players) {
    if (pid === shooterId || !p.state || !p.combat || p.combat.sunk) continue;
    victims.push({ pid, p });
  }
  if (!victims.length) return null;

  const { ox, oy, oz, vx, vy, vz } = shot;
  const reach2 = (C.HALF_LEN + C.BROADPHASE_PAD) * (C.HALF_LEN + C.BROADPHASE_PAD);

  for (let t = 0; t <= C.SIM_MAX_T; t += C.SIM_DT) {
    const bx = ox + vx * t;
    const by = oy + vy * t - 0.5 * C.G * t * t;
    const bz = oz + vz * t;
    if (by < C.SIM_WATER_Y && t > 0.1) break;                // into the sea → miss

    for (const v of victims) {
      const pose = deadReckon(v.p.state, t);
      const ddx = bx - pose.x, ddz = bz - pose.z;
      if (ddx * ddx + ddz * ddz > reach2) continue;          // broad-phase reject
      const lat = ddx * Math.cos(pose.hr) - ddz * Math.sin(pose.hr);
      const lon = ddx * Math.sin(pose.hr) + ddz * Math.cos(pose.hr);
      const zone = zoneAtLocal(lat, lon, by);
      if (!zone) continue;
      const side = lat < 0 ? 'port' : 'stbd';
      const dmg  = computeDamage(vx, vy - C.G * t, vz, pose, zone, by);
      return { victimId: v.pid, zone, hx: bx, hy: by, hz: bz, side, dmg };
    }
  }
  return null;
}

/** Plausibility check on a claimed shot (origin near shooter, speed in band). */
function validateShot(shot, shooterState) {
  if (!shooterState) return false;
  const speed = Math.hypot(shot.vx, shot.vy, shot.vz);
  if (speed < C.VALID_V_MIN || speed > C.VALID_V_MAX) return false;
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

module.exports = {
  newCombatState, zoneAtLocal, deadReckon, computeDamage,
  simulateShot, validateShot, allowShot, applyDamage,
};
