'use strict';

/**
 * Deterministic time-based weather with sailing-specific wind data.
 * All connected clients see the same conditions simultaneously — no DB required.
 */
exports.getWeather = (req, res) => {
  const t      = Date.now() / 1000;
  const period = 600;                    // 10-minute cycle
  const phase  = (t % period) / period;

  // Wind: direction rotates through 4π per cycle, speed oscillates 5–26 units/s
  const windAngle = phase * Math.PI * 4;
  const windSpeed = 5 + 21 * Math.abs(Math.sin(phase * Math.PI * 5));
  const windX     = parseFloat((Math.cos(windAngle) * windSpeed).toFixed(2));
  const windZ     = parseFloat((Math.sin(windAngle) * windSpeed).toFixed(2));

  // Wind FROM bearing (compass: 0=N, 90=E) — where the wind originates
  const windToBearingDeg  = ((Math.atan2(windX, windZ) * 180 / Math.PI) + 360) % 360;
  const windFromBearingDeg = (windToBearingDeg + 180) % 360;

  // Sea state driven by wind
  const waveHeight  = parseFloat((0.3 + 3.2 * (windSpeed / 26)).toFixed(2)); // 0.3–3.5 m
  const choppiness  = parseFloat((0.05 + 0.95 * (windSpeed / 26)).toFixed(2)); // 0.05–1.0

  // Beaufort scale (0–12)
  const beaufort = Math.min(12, Math.floor(windSpeed / 2.5));

  // Turbulence, fog, precipitation (independent phases)
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
      x:            windX,
      z:            windZ,
      speed:        Math.round(windSpeed),
      fromBearingDeg: parseFloat(windFromBearingDeg.toFixed(1)),
      cardinalDir,
      beaufort,
    },
    sea: { waveHeight, choppiness },
    turbulence,
    fog:           { density: fogDensity },
    precipitation: windSpeed > 22 ? 'rain' : 'none',
    description,
  });
};
