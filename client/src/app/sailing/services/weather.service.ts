import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Weather } from '../models';

/**
 * Client-side procedural weather that evolves gradually.
 *
 * Wind and cloudiness are independent state variables — a calm day can be
 * overcast; a gale can blow under blue skies.  Both evolve on their own
 * target/lerp cycles so transitions always feel natural.
 *
 * Rates:
 *  - Wind bearing:   max 1.2°/s   (90° shift takes ≥75 s)
 *  - Wind speed:     max 0.5 m/s² (10 m/s swing takes ≥20 s)
 *  - Cloudiness:     max 0.012/s  (full 0→1 swing takes ≥83 s)
 *  - Target change:  every 60–150 s; 10 % dramatic, 90 % gradual
 */
@Injectable({ providedIn: 'root' })
export class WeatherService {
  private zone = inject(NgZone);

  weather = signal<Weather | null>(null);

  // ── Current interpolated wind ─────────────────────────────────────────────
  private windBearing = 330;
  private windSpeed   = 8;

  // ── Current interpolated cloudiness ──────────────────────────────────────
  // 0 = crystal-clear blue sky, 1 = pitch-dark storm
  private cloudiness = 0.25;

  // ── Targets ───────────────────────────────────────────────────────────────
  private targetBearing   = 330;
  private targetSpeed     = 8;
  private targetCloudiness = 0.25;

  // ── Tick bookkeeping ──────────────────────────────────────────────────────
  private timeSec       = 0;
  private nextTargetSec = 30;

  private intervalId: ReturnType<typeof setInterval> | null = null;

  // ── Admin override ────────────────────────────────────────────────────────
  private adminOverride = false;

  // ─────────────────────────────────────────────────────────────────────────
  start(): void {
    this.windBearing      = Math.random() * 360;
    this.windSpeed        = 5 + Math.random() * 9;
    this.cloudiness       = Math.random() * 0.6;   // start with a random but not extreme sky
    this.targetBearing    = this.windBearing;
    this.targetSpeed      = this.windSpeed;
    this.targetCloudiness = this.cloudiness;

    this.zone.run(() => this.weather.set(this.buildWeather()));

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

  // ── Admin overrides ───────────────────────────────────────────────────────

  /**
   * Immediately freeze wind and optionally cloudiness to specified values.
   * Bypasses all gradual lerp until clearAdminOverride() is called.
   */
  setAdminOverride(windBearing: number, windSpeed: number, cloudiness?: number): void {
    this.adminOverride = true;
    this.windBearing   = ((windBearing % 360) + 360) % 360;
    this.windSpeed     = Math.max(0, Math.min(30, windSpeed));
    this.targetBearing = this.windBearing;
    this.targetSpeed   = this.windSpeed;
    if (cloudiness !== undefined) {
      this.cloudiness       = Math.max(0, Math.min(1, cloudiness));
      this.targetCloudiness = this.cloudiness;
    }
    this.zone.run(() => this.weather.set(this.buildWeather()));
  }

  /** Resume natural evolution from current values. */
  clearAdminOverride(): void {
    this.adminOverride = false;
  }

  // ── Internal tick (1 s) ───────────────────────────────────────────────────

  private tick(): void {
    this.timeSec++;

    if (this.adminOverride) {
      this.weather.set(this.buildWeather());
      return;
    }

    if (this.timeSec >= this.nextTargetSec) {
      this.pickNewTarget();
      this.nextTargetSec = this.timeSec + 60 + Math.random() * 90;
    }

    // ── Wind bearing (max 1.2°/s) ──────────────────────────────────────────
    const bearingDiff = this.angularDiff(this.targetBearing, this.windBearing);
    const bearingStep = Math.sign(bearingDiff) * Math.min(Math.abs(bearingDiff), 1.2);
    this.windBearing  = (this.windBearing + bearingStep + 360) % 360;

    // ── Wind speed (max 0.5 m/s²) ─────────────────────────────────────────
    const speedDiff = this.targetSpeed - this.windSpeed;
    this.windSpeed  = Math.max(2, Math.min(24,
      this.windSpeed + Math.sign(speedDiff) * Math.min(Math.abs(speedDiff), 0.5),
    ));

    // ── Cloudiness (max 0.012/s — gradual sky transitions) ────────────────
    const cloudDiff  = this.targetCloudiness - this.cloudiness;
    this.cloudiness  = Math.max(0, Math.min(1,
      this.cloudiness + Math.sign(cloudDiff) * Math.min(Math.abs(cloudDiff), 0.012),
    ));

    this.weather.set(this.buildWeather());
  }

  // ── Target selection ──────────────────────────────────────────────────────

  private pickNewTarget(): void {
    const dramatic = Math.random() < 0.10;

    if (dramatic) {
      const shift = (Math.random() - 0.5) * 240;
      this.targetBearing = (this.windBearing + shift + 360) % 360;
      this.targetSpeed   = Math.max(4, Math.min(22, this.windSpeed + (Math.random() - 0.5) * 28));
      // Dramatic fronts often bring dramatic skies
      this.targetCloudiness = Math.random() < 0.6
        ? 0.70 + Math.random() * 0.30   // build to overcast/storm
        : Math.random() * 0.30;          // or clear out fast after a front
    } else {
      const shift = (Math.random() - 0.5) * 50;
      this.targetBearing = (this.windBearing + shift + 360) % 360;
      this.targetSpeed   = Math.max(4, Math.min(16, this.windSpeed + (Math.random() - 0.5) * 12));
      // Weighted cloudiness: 35 % clear, 40 % partial, 25 % heavy/rainy
      const r = Math.random();
      if      (r < 0.35) this.targetCloudiness = Math.random() * 0.22;              // clear
      else if (r < 0.75) this.targetCloudiness = 0.20 + Math.random() * 0.45;       // partial
      else               this.targetCloudiness = 0.65 + Math.random() * 0.35;       // heavy
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private angularDiff(target: number, current: number): number {
    let diff = ((target - current) + 360) % 360;
    if (diff > 180) diff -= 360;
    return diff;
  }

  private buildWeather(): Weather {
    const fromBearing = this.windBearing;
    const toRad  = ((fromBearing + 180) % 360) * Math.PI / 180;
    const windX  = parseFloat((Math.sin(toRad) * this.windSpeed).toFixed(2));
    const windZ  = parseFloat((Math.cos(toRad) * this.windSpeed).toFixed(2));
    const speed  = this.windSpeed;
    const c      = this.cloudiness;

    const beaufort   = Math.min(12, Math.floor(speed / 2.5));
    const waveHeight = parseFloat((0.3 + 3.2 * (speed / 24)).toFixed(2));
    const choppiness = parseFloat((0.05 + 0.95 * (speed / 24)).toFixed(2));

    const cardinalDirs = [
      'N','NNE','NE','ENE','E','ESE','SE','SSE',
      'S','SSW','SW','WSW','W','WNW','NW','NNW',
    ];
    const cardinalDir = cardinalDirs[Math.round(fromBearing / 22.5) % 16];

    // ── Precipitation from cloudiness ──────────────────────────────────────
    // Independent of wind — you can have light drizzle in a calm or heavy rain in a gale.
    let precipitation: Weather['precipitation'] = 'none';
    if      (c > 0.94) precipitation = 'storm';
    else if (c > 0.82) precipitation = 'rain';
    else if (c > 0.68) precipitation = 'drizzle';

    // ── Description: composite of wind + sky ──────────────────────────────
    let skyDesc = 'Clear';
    if      (c > 0.94) skyDesc = 'Storm';
    else if (c > 0.82) skyDesc = 'Rain';
    else if (c > 0.68) skyDesc = 'Drizzle';
    else if (c > 0.50) skyDesc = 'Overcast';
    else if (c > 0.28) skyDesc = 'Partly cloudy';

    let windDesc = 'calm seas';
    if      (speed > 20) windDesc = 'violent storm';
    else if (speed > 17) windDesc = 'near gale';
    else if (speed > 13) windDesc = 'strong breeze';
    else if (speed > 8)  windDesc = 'moderate breeze';
    else if (speed > 5)  windDesc = 'light breeze';

    const description = `${skyDesc}, ${windDesc}`;

    // ── Fog: more on heavy overcast/rain, also in flat calm ───────────────
    const rainFog    = c > 0.68 ? (c - 0.68) * 0.00045 : 0;
    const windFog    = speed < 5 ? 0.00018 : Math.max(0, (speed - 18) * 0.000004);
    const fogDensity = parseFloat((0.000035 + rainFog + windFog).toFixed(7));

    return {
      wind: {
        x: windX, z: windZ,
        speed:          Math.round(speed),
        fromBearingDeg: parseFloat(fromBearing.toFixed(1)),
        cardinalDir,
        beaufort,
      },
      sea:           { waveHeight, choppiness },
      turbulence:    speed > 16 ? parseFloat(((speed - 16) / 8).toFixed(2)) : 0,
      fog:           { density: fogDensity },
      cloudiness:    parseFloat(c.toFixed(3)),
      precipitation,
      description,
    };
  }

  receiveServerState(windBearing: number, windSpeed: number): void {
    this.targetBearing = ((windBearing % 360) + 360) % 360;
    this.targetSpeed   = Math.max(2, Math.min(22, windSpeed));
  }
}
