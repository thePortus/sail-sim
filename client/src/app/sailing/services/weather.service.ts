import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Weather } from '../models';

/**
 * Server-authoritative weather. The server (weather-state.js) is the single source of
 * truth: it evolves wind + cloudiness and broadcasts a snapshot to every client over
 * the multiplayer WS. This service does NOT invent weather — it only smoothly
 * INTERPOLATES the locally-displayed values toward the latest server target so all
 * players share the same conditions (with pleasant transitions between the ~5 s
 * snapshots). Day/night offset comes from the server too (see timeOffsetSec signal).
 */
@Injectable({ providedIn: 'root' })
export class WeatherService {
  private zone = inject(NgZone);

  weather = signal<Weather | null>(null);

  /** Day/night clock offset (game-cycle seconds) set by the server / admin. The
   *  SceneService reads this so the whole server shares one time of day. */
  timeOffsetSec = signal<number>(0);

  // ── Locally-displayed (interpolated) values ───────────────────────────────
  private windBearing = 200;
  private windSpeed   = 8;
  private cloudiness  = 0.25;

  // ── Server targets (from the latest wave_state snapshot) ──────────────────
  private targetBearing  = 200;
  private targetSpeed    = 8;
  private targetCloud    = 0.25;
  private serverPrecip: Weather['precipitation'] = 'none';

  private haveServerState = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    // Publish an initial (provisional) weather so the scene has something until the
    // first server snapshot arrives a moment later.
    this.zone.run(() => this.weather.set(this.buildWeather()));
    this.intervalId = setInterval(() => this.zone.run(() => this.tick()), 1000);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  /**
   * Receive a full weather snapshot from the server (multiplayer wave_state). Wind +
   * cloud become interpolation targets; precipitation and the day/night offset apply
   * directly (those are discrete, server-owned). Called for every connected client,
   * so everyone converges on identical conditions.
   */
  receiveServerState(snap: {
    windBearing: number; windSpeed: number;
    cloudiness?: number; precipitation?: Weather['precipitation'];
    timeOffsetSec?: number;
  }): void {
    this.targetBearing = ((snap.windBearing % 360) + 360) % 360;
    this.targetSpeed   = Math.max(0, Math.min(35, snap.windSpeed));
    if (typeof snap.cloudiness === 'number') this.targetCloud = Math.max(0, Math.min(1, snap.cloudiness));
    if (snap.precipitation) this.serverPrecip = snap.precipitation;
    if (typeof snap.timeOffsetSec === 'number') this.timeOffsetSec.set(snap.timeOffsetSec);

    // First snapshot: snap straight to the server values so we don't drift in from a
    // stale provisional state.
    if (!this.haveServerState) {
      this.haveServerState = true;
      this.windBearing = this.targetBearing;
      this.windSpeed   = this.targetSpeed;
      this.cloudiness  = this.targetCloud;
    }
    this.zone.run(() => this.weather.set(this.buildWeather()));
  }

  // ── Smooth interpolation toward the server targets (1 s) ──────────────────
  // Rates are capped so motion stays gentle between snapshots; since the server
  // already evolves gradually, these only smooth the ~5 s snapshot steps.
  private tick(): void {
    // Exponential approach: close ~40% of the remaining gap per second, with a small
    // minimum step so we don't crawl forever near the target. This tracks the server
    // (including admin overrides) within a few seconds while still smoothing the 5 s
    // snapshot steps — the server itself enforces the *gradual* evolution, so the
    // client just needs to follow it promptly rather than re-limit it.
    const APPROACH = 0.4;

    const bearingDiff = this.angularDiff(this.targetBearing, this.windBearing);
    const bearingStep = Math.abs(bearingDiff) < 0.1 ? bearingDiff
      : Math.sign(bearingDiff) * Math.max(0.5, Math.abs(bearingDiff) * APPROACH);
    this.windBearing  = (this.windBearing + bearingStep + 360) % 360;

    const speedDiff = this.targetSpeed - this.windSpeed;
    this.windSpeed  = Math.abs(speedDiff) < 0.05 ? this.targetSpeed
      : this.windSpeed + Math.sign(speedDiff) * Math.max(0.2, Math.abs(speedDiff) * APPROACH);

    const cloudDiff = this.targetCloud - this.cloudiness;
    this.cloudiness = Math.abs(cloudDiff) < 0.005 ? this.targetCloud
      : this.cloudiness + Math.sign(cloudDiff) * Math.max(0.01, Math.abs(cloudDiff) * APPROACH);

    this.weather.set(this.buildWeather());
  }

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

    // Precipitation follows the server's value when present; otherwise derive from cloud.
    let precipitation: Weather['precipitation'] = this.serverPrecip ?? 'none';
    if (!this.haveServerState) {
      if      (c > 0.94) precipitation = 'storm';
      else if (c > 0.82) precipitation = 'rain';
      else if (c > 0.68) precipitation = 'drizzle';
      else               precipitation = 'none';
    }

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
}
