import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Weather } from '../models';

/**
 * Client-side procedural weather that evolves gradually.
 *
 * Design goals:
 *  - Wind direction shifts at most 1.2°/second (a 90° change takes ≥75 s).
 *  - Speed builds/fades at most 0.5 units/s² (a 10-knot swing takes ≥20 s).
 *  - Every 60–150 seconds a new target is chosen.
 *  - ~10 % of new targets are "dramatic" (shift up to ±120°, speed ±14).
 *  - 90 % are gradual (shift ±25°, speed ±6).
 *
 * One 1-second tick drives both the gradual lerp and the weather signal.
 * No server fetch required — all state lives in the client.
 */
@Injectable({ providedIn: 'root' })
export class WeatherService {
  private zone = inject(NgZone);

  weather = signal<Weather | null>(null);

  // ── Current interpolated wind (what the game sees) ─────────────────────────
  private windBearing = 330;   // degrees FROM (0 = N, 90 = E, clockwise)
  private windSpeed   = 8;     // units/s  (≈ m/s — matches Beaufort scale)

  // ── Target wind (slowly approaching over many seconds) ────────────────────
  private targetBearing = 330;
  private targetSpeed   = 8;

  // ── Tick bookkeeping ──────────────────────────────────────────────────────
  private timeSec       = 0;
  private nextTargetSec = 30;  // first target change 30 s after start

  private intervalId: ReturnType<typeof setInterval> | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  start(): void {
    // Randomise starting wind so each session feels different
    this.windBearing   = Math.random() * 360;
    this.windSpeed     = 5 + Math.random() * 9;   // 5–14 m/s
    this.targetBearing = this.windBearing;
    this.targetSpeed   = this.windSpeed;

    // Emit first reading synchronously
    this.zone.run(() => this.weather.set(this.buildWeather()));

    // 1-second tick — drives gradual evolution
    this.intervalId = setInterval(() => {
      this.zone.run(() => this.tick());
    }, 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // ── Internal tick (1 s) ───────────────────────────────────────────────────

  private tick(): void {
    this.timeSec++;

    // Occasionally choose a new target
    if (this.timeSec >= this.nextTargetSec) {
      this.pickNewTarget();
      // Next change in 60–150 s (drama events can be 30–90 s)
      this.nextTargetSec = this.timeSec + 60 + Math.random() * 90;
    }

    // ── Gradually move bearing toward target ───────────────────────────────
    // Max 1.2°/s — a 90° shift takes ≥75 s
    const bearingDiff = this.angularDiff(this.targetBearing, this.windBearing);
    const bearingStep = Math.sign(bearingDiff) * Math.min(Math.abs(bearingDiff), 1.2);
    this.windBearing  = (this.windBearing + bearingStep + 360) % 360;

    // ── Gradually move speed toward target ─────────────────────────────────
    // Max 0.5 units/s² — a 10 m/s swing takes ≥20 s
    const speedDiff = this.targetSpeed - this.windSpeed;
    this.windSpeed  = Math.max(2, Math.min(24,
      this.windSpeed + Math.sign(speedDiff) * Math.min(Math.abs(speedDiff), 0.5),
    ));

    this.weather.set(this.buildWeather());
  }

  // ── Target selection ──────────────────────────────────────────────────────

  private pickNewTarget(): void {
    const dramatic = Math.random() < 0.10;  // 10 % chance of dramatic shift

    if (dramatic) {
      // Major front: wind can veer/back up to ±120°, speed swings ±14 m/s.
      // Still takes 1–2 min to arrive at those extremes due to max rate limit.
      const shift = (Math.random() - 0.5) * 240;
      this.targetBearing = (this.windBearing + shift + 360) % 360;
      this.targetSpeed   = Math.max(4, Math.min(22,
        this.windSpeed + (Math.random() - 0.5) * 28,
      ));
    } else {
      // Normal: ±25° and speed ±6 m/s — feels like ordinary sea-state drift
      const shift = (Math.random() - 0.5) * 50;
      this.targetBearing = (this.windBearing + shift + 360) % 360;
      this.targetSpeed   = Math.max(4, Math.min(16,
        this.windSpeed + (Math.random() - 0.5) * 12,
      ));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Shortest signed angular difference target − current, in degrees (−180..180). */
  private angularDiff(target: number, current: number): number {
    let diff = ((target - current) + 360) % 360;
    if (diff > 180) diff -= 360;
    return diff;
  }

  /** Build a full Weather object from the current interpolated wind state. */
  private buildWeather(): Weather {
    const fromBearing = this.windBearing;
    // Convert FROM bearing to velocity components.
    // In the game's coordinate system: +Z = N, +X = E.
    // Wind blows FROM bearing B → toward (B+180)%360.
    const toRad  = ((fromBearing + 180) % 360) * Math.PI / 180;
    const windX  = parseFloat((Math.sin(toRad) * this.windSpeed).toFixed(2));
    const windZ  = parseFloat((Math.cos(toRad) * this.windSpeed).toFixed(2));
    const speed  = this.windSpeed;

    const beaufort  = Math.min(12, Math.floor(speed / 2.5));
    const waveHeight = parseFloat((0.3 + 3.2 * (speed / 24)).toFixed(2));
    const choppiness = parseFloat((0.05 + 0.95 * (speed / 24)).toFixed(2));

    const cardinalDirs = [
      'N','NNE','NE','ENE','E','ESE','SE','SSE',
      'S','SSW','SW','WSW','W','WNW','NW','NNW',
    ];
    const cardinalDir = cardinalDirs[Math.round(fromBearing / 22.5) % 16];

    let description = 'Calm seas';
    if      (speed > 20) description = 'Storm';
    else if (speed > 17) description = 'Near gale';
    else if (speed > 13) description = 'Strong breeze';
    else if (speed > 8)  description = 'Moderate breeze';
    else if (speed > 5)  description = 'Light breeze';

    // Light fog in very calm or very windy conditions
    const fogDensity = speed < 5
      ? 0.00018
      : 0.00004 + Math.max(0, speed - 18) * 0.000004;

    return {
      wind: {
        x: windX,
        z: windZ,
        speed:          Math.round(speed),
        fromBearingDeg: parseFloat(fromBearing.toFixed(1)),
        cardinalDir,
        beaufort,
      },
      sea:           { waveHeight, choppiness },
      turbulence:    speed > 16 ? parseFloat(((speed - 16) / 8).toFixed(2)) : 0,
      fog:           { density: fogDensity },
      precipitation: speed > 20 ? 'rain' : 'none',
      description,
    };
  }
}
