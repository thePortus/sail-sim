'use strict';

/**
 * Admin weather / time-of-day controls. These mutate the single server-authoritative
 * weather state (weather-state.js) that the multiplayer WS layer ticks and broadcasts,
 * so an override here changes conditions for EVERY connected player at once. GET
 * returns the current snapshot (handy for tooling / non-WS consumers).
 */

const weatherState = require('../weather-state');

// ── GET /api/weather ──────────────────────────────────────────────────────────
exports.getWeather = (req, res) => {
  res.json(weatherState.snapshot());
};

// ── POST /api/weather/override  { windSpeed, fromBearingDeg, cloudiness? } ─────
exports.setOverride = (req, res) => {
  const { windSpeed, fromBearingDeg, cloudiness } = req.body;
  if (
    typeof windSpeed      !== 'number' || windSpeed < 0 || windSpeed > 35 ||
    typeof fromBearingDeg !== 'number'
  ) {
    return res.status(400).json({ error: 'windSpeed (0–35) and fromBearingDeg required' });
  }
  if (cloudiness !== undefined && (typeof cloudiness !== 'number' || cloudiness < 0 || cloudiness > 1)) {
    return res.status(400).json({ error: 'cloudiness must be 0–1 when provided' });
  }
  // Tag the override with the admin's callsign (from the verified JWT) so it can be
  // auto-cleared when they disconnect — a stale windSpeed-0 override otherwise becalms
  // everyone who logs in afterward.
  const owner = req.user && typeof req.user.callsign === 'string' ? req.user.callsign : null;
  weatherState.setOverride({ windSpeed, fromBearingDeg, cloudiness, owner });
  res.json({ ok: true, snapshot: weatherState.snapshot() });
};

// ── DELETE /api/weather/override ─────────────────────────────────────────────
exports.clearOverride = (req, res) => {
  weatherState.clearOverride();
  res.json({ ok: true });
};

// ── POST /api/weather/time-offset  { targetGameHour } ────────────────────────
// Computes the offset (in game-cycle seconds) so the day/night clock reads the
// requested hour, then applies it server-wide.
exports.setTimeOffset = (req, res) => {
  const { targetGameHour } = req.body;
  if (typeof targetGameHour !== 'number' || targetGameHour < 0 || targetGameHour >= 24) {
    return res.status(400).json({ error: 'targetGameHour (0–23.99) required' });
  }
  const SECS_PER_CYCLE = 1440;   // 24 game-hours × 60 real-seconds
  const nowCycleSecs   = (Date.now() / 1000) % SECS_PER_CYCLE;
  const targetSecs     = targetGameHour * 60;
  const offset = ((targetSecs - nowCycleSecs) + SECS_PER_CYCLE) % SECS_PER_CYCLE;
  weatherState.setTimeOffset(offset);
  res.json({ ok: true, timeOffsetSec: offset });
};

// ── DELETE /api/weather/time-offset ──────────────────────────────────────────
exports.clearTimeOffset = (req, res) => {
  weatherState.clearTimeOffset();
  res.json({ ok: true });
};
