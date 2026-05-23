'use strict';

/**
 * Deterministic time-based weather with sailing-specific wind data.
 * All connected clients see the same conditions simultaneously — no DB required.
 *
 * Admin overrides are kept in memory — they reset on server restart.
 */

let weatherOverride = null;  // { windSpeed, fromBearingDeg } | null
let timeOffsetSecs  = 0;     // seconds added to epoch when computing game hour

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWeatherPayload(windSpeed, windFromBearingDeg, overrideActive) {
  // Convert "from" bearing back to a direction vector for legacy consumers
  const windToBearingDeg = (windFromBearingDeg + 180) % 360;
  const windAngleRad     = windToBearingDeg * Math.PI / 180;
  const windX = parseFloat((Math.cos(windAngleRad - Math.PI / 2) * windSpeed).toFixed(2));
  const windZ = parseFloat((Math.sin(windAngleRad - Math.PI / 2) * windSpeed).toFixed(2));

  const waveHeight  = parseFloat((0.3 + 3.2 * (windSpeed / 26)).toFixed(2));
  const choppiness  = parseFloat((0.05 + 0.95 * (windSpeed / 26)).toFixed(2));
  const beaufort    = Math.min(12, Math.floor(windSpeed / 2.5));

  const cardinalDirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const cardinalDir  = cardinalDirs[Math.round(windFromBearingDeg / 22.5) % 16];

  let description = 'Calm seas';
  if      (windSpeed > 22) description = 'Storm';
  else if (windSpeed > 18) description = 'Near gale';
  else if (windSpeed > 13) description = 'Strong breeze';
  else if (windSpeed > 8)  description = 'Moderate breeze';

  return {
    wind: {
      x: windX,
      z: windZ,
      speed: Math.round(windSpeed),
      fromBearingDeg: parseFloat(windFromBearingDeg.toFixed(1)),
      cardinalDir,
      beaufort,
    },
    sea: { waveHeight, choppiness },
    turbulence:    0,
    fog:           { density: 0.00004 },
    precipitation: windSpeed > 22 ? 'rain' : 'none',
    description,
    adminControlled: true,
    timeOffsetSecs,
  };
}

// ── GET /api/weather ──────────────────────────────────────────────────────────

exports.getWeather = (req, res) => {
  if (weatherOverride) {
    return res.json(buildWeatherPayload(
      weatherOverride.windSpeed,
      weatherOverride.fromBearingDeg,
      true,
    ));
  }

  const t      = Date.now() / 1000;
  const period = 600;
  const phase  = (t % period) / period;

  const windAngle = phase * Math.PI * 4;
  const windSpeed = 5 + 21 * Math.abs(Math.sin(phase * Math.PI * 5));
  const windX     = parseFloat((Math.cos(windAngle) * windSpeed).toFixed(2));
  const windZ     = parseFloat((Math.sin(windAngle) * windSpeed).toFixed(2));

  const windToBearingDeg   = ((Math.atan2(windX, windZ) * 180 / Math.PI) + 360) % 360;
  const windFromBearingDeg = (windToBearingDeg + 180) % 360;

  const waveHeight  = parseFloat((0.3 + 3.2 * (windSpeed / 26)).toFixed(2));
  const choppiness  = parseFloat((0.05 + 0.95 * (windSpeed / 26)).toFixed(2));
  const beaufort    = Math.min(12, Math.floor(windSpeed / 2.5));

  const turbulence = parseFloat((Math.max(0, Math.sin(phase * Math.PI * 9)) * 0.7).toFixed(2));
  const fogDensity = parseFloat((0.00004 + 0.00018 * Math.abs(Math.sin(phase * Math.PI * 3))).toFixed(6));

  const cardinalDirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const cardinalDir  = cardinalDirs[Math.round(windFromBearingDeg / 22.5) % 16];

  let description = 'Calm seas';
  if      (windSpeed > 22)       description = 'Storm';
  else if (windSpeed > 18)       description = 'Near gale';
  else if (windSpeed > 13)       description = 'Strong breeze';
  else if (windSpeed > 8)        description = 'Moderate breeze';
  else if (turbulence > 0.35)    description = 'Gusty';
  else if (fogDensity > 0.00015) description = 'Foggy';

  res.json({
    wind: {
      x:              windX,
      z:              windZ,
      speed:          Math.round(windSpeed),
      fromBearingDeg: parseFloat(windFromBearingDeg.toFixed(1)),
      cardinalDir,
      beaufort,
    },
    sea: { waveHeight, choppiness },
    turbulence,
    fog:           { density: fogDensity },
    precipitation: windSpeed > 22 ? 'rain' : 'none',
    description,
    adminControlled: false,
    timeOffsetSecs,
  });
};

// ── POST /api/weather/override  { windSpeed, fromBearingDeg } ─────────────────

exports.setOverride = (req, res) => {
  const { windSpeed, fromBearingDeg } = req.body;
  if (
    typeof windSpeed      !== 'number' || windSpeed < 0 || windSpeed > 35 ||
    typeof fromBearingDeg !== 'number'
  ) {
    return res.status(400).json({ error: 'windSpeed (0–35) and fromBearingDeg required' });
  }
  weatherOverride = { windSpeed, fromBearingDeg: ((fromBearingDeg % 360) + 360) % 360 };
  res.json({ ok: true, override: weatherOverride });
};

// ── DELETE /api/weather/override ─────────────────────────────────────────────

exports.clearOverride = (req, res) => {
  weatherOverride = null;
  res.json({ ok: true });
};

// ── POST /api/weather/time-offset  { targetGameHour } ────────────────────────
// Computes offsetSecs so that the next poll returns the requested game hour.

exports.setTimeOffset = (req, res) => {
  const { targetGameHour } = req.body;
  if (typeof targetGameHour !== 'number' || targetGameHour < 0 || targetGameHour >= 24) {
    return res.status(400).json({ error: 'targetGameHour (0–23.99) required' });
  }
  const SECS_PER_CYCLE = 1440; // 24 game-hours × 60 real-seconds
  const nowCycleSecs   = (Date.now() / 1000) % SECS_PER_CYCLE;
  const targetSecs     = targetGameHour * 60;
  timeOffsetSecs = ((targetSecs - nowCycleSecs) + SECS_PER_CYCLE) % SECS_PER_CYCLE;
  res.json({ ok: true, timeOffsetSecs });
};

// ── DELETE /api/weather/time-offset ──────────────────────────────────────────

exports.clearTimeOffset = (req, res) => {
  timeOffsetSecs = 0;
  res.json({ ok: true });
};
