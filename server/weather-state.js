'use strict';

/**
 * @file Single server-authoritative weather + time-of-day state.
 *
 * This is the ONE source of truth for weather across all connected clients. The
 * multiplayer WS layer ticks it once per second and broadcasts a full snapshot to
 * every player on a fixed cadence (and immediately whenever an admin overrides it),
 * so everyone shares the exact same conditions. Clients only INTERPOLATE toward the
 * snapshots — they never invent their own weather.
 *
 * Evolution is momentum-based, not freshly random each step:
 *   - Wind bearing and speed each carry a velocity that persists and mean-reverts.
 *   - Velocities get small random nudges often, and a large "front" impulse only
 *     rarely — so direction generally keeps drifting one way and only occasionally
 *     reverses; speed picks up or eases gradually rather than jumping.
 *   - Cloudiness drifts the same way (gradual), which drives precipitation/fog.
 *
 * Admin override freezes wind + cloud to fixed values for everyone until cleared.
 * Admin time-offset shifts the day/night clock for everyone.
 */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function randn() { // approx standard normal via sum of uniforms
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.5;
}

const SPEED_MIN = 2, SPEED_MAX = 24;
const SPEED_BASELINE = 9;   // gentle mean-reversion target for wind speed
const CLOUD_BASELINE = 0.35;

const state = {
  // Live values
  bearing: 200 + Math.random() * 120,   // degrees the wind blows FROM
  speed:   7 + Math.random() * 5,        // m/s
  cloud:   0.2 + Math.random() * 0.3,    // 0 clear → 1 storm

  // Momentum (per-second velocities) — persistence is what makes it feel natural.
  bearingVel: (Math.random() - 0.5) * 0.6,   // deg/s
  speedVel:   0,                              // (m/s)/s
  cloudVel:   0,                              // (1)/s

  // Admin
  override:      null,   // { bearing, speed, cloud } | null
  timeOffsetSec: 0,      // added to the day/night clock for everyone

  t: 0,                  // seconds since start
};

// Registered listeners fired on an immediate-change event (admin override/time).
const changeListeners = [];
function emitChange() { for (const cb of changeListeners) { try { cb(); } catch { /* ignore */ } } }

function beaufortFromSpeed(speed) {
  return Math.min(8, Math.max(0, Math.floor(speed / 2.8)));
}

/**
 * Advance the simulation by one second (called at 1 Hz by the WS layer).
 * No-op evolution while an override is active (state stays pinned).
 */
function tick() {
  state.t++;
  if (state.override) return;

  // ── Wind bearing: persistent drift + occasional nudges, rare reversal ──────
  // Small nudge most ticks; a rare "front" gives a larger, possibly reversing push.
  if (Math.random() < 0.20) state.bearingVel += randn() * 0.25;
  if (Math.random() < 0.015) state.bearingVel += randn() * 1.6;     // rare gust/front
  state.bearingVel *= 0.96;                                          // mean-revert to ~0
  state.bearingVel = clamp(state.bearingVel, -2.2, 2.2);             // cap turn rate (deg/s)
  state.bearing = (state.bearing + state.bearingVel + 360) % 360;

  // ── Wind speed: momentum + gentle pull toward a moderate baseline ──────────
  if (Math.random() < 0.20) state.speedVel += randn() * 0.05;
  if (Math.random() < 0.012) state.speedVel += randn() * 0.5;        // rare surge/lull
  state.speedVel += (SPEED_BASELINE - state.speed) * 0.0008;         // weak reversion
  state.speedVel *= 0.95;
  state.speedVel = clamp(state.speedVel, -0.35, 0.35);               // cap accel ((m/s)/s)
  state.speed = clamp(state.speed + state.speedVel, SPEED_MIN, SPEED_MAX);

  // ── Cloudiness: gradual drift toward a baseline, rare weather systems ───────
  if (Math.random() < 0.18) state.cloudVel += randn() * 0.004;
  if (Math.random() < 0.010) state.cloudVel += randn() * 0.05;       // rare front
  state.cloudVel += (CLOUD_BASELINE - state.cloud) * 0.0006;
  state.cloudVel *= 0.95;
  state.cloudVel = clamp(state.cloudVel, -0.02, 0.02);               // cap (1)/s
  state.cloud = clamp(state.cloud + state.cloudVel, 0, 1);
}

/**
 * Full broadcast payload — wind, derived sea/sky, precipitation, fog, the day/night
 * offset, and whether an admin override is active. Clients interpolate toward this.
 */
function snapshot() {
  const bearing = state.override ? state.override.bearing : state.bearing;
  const speed   = state.override ? state.override.speed   : state.speed;
  const cloud   = state.override && state.override.cloud != null
    ? state.override.cloud : state.cloud;

  let precipitation = 'none';
  if      (cloud > 0.94) precipitation = 'storm';
  else if (cloud > 0.82) precipitation = 'rain';
  else if (cloud > 0.68) precipitation = 'drizzle';

  return {
    type:          'wave_state',
    windBearing:   +bearing.toFixed(2),
    windSpeed:     +speed.toFixed(2),
    cloudiness:    +cloud.toFixed(3),
    precipitation,
    beaufort:      beaufortFromSpeed(speed),
    timeOffsetSec: state.timeOffsetSec,
    override:      !!state.override,
    t:             state.t,
  };
}

// ── Admin controls ──────────────────────────────────────────────────────────

function setOverride({ windSpeed, fromBearingDeg, cloudiness }) {
  state.override = {
    bearing: ((fromBearingDeg % 360) + 360) % 360,
    speed:   clamp(windSpeed, 0, 35),
    cloud:   cloudiness != null ? clamp(cloudiness, 0, 1) : null,
  };
  // Seed live values so clearing later resumes smoothly from the overridden look.
  state.bearing = state.override.bearing;
  state.speed   = state.override.speed;
  if (state.override.cloud != null) state.cloud = state.override.cloud;
  emitChange();
}

function clearOverride() { state.override = null; emitChange(); }

function setTimeOffset(secs) {
  state.timeOffsetSec = ((Number(secs) % 1440) + 1440) % 1440;   // 24 game-min cycle
  emitChange();
}
function clearTimeOffset() { state.timeOffsetSec = 0; emitChange(); }

function onChange(cb) { changeListeners.push(cb); }

module.exports = {
  tick, snapshot, setOverride, clearOverride, setTimeOffset, clearTimeOffset, onChange,
};
