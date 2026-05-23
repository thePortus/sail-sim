import { Injectable } from '@angular/core';
import { Vector3 } from '@babylonjs/core';
import { Wind, SeaConditions } from '../models';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GerstnerWave {
  k:     number;  // wavenumber  = 2π / wavelength  (rad/m)
  amp:   number;  // amplitude   (metres, half peak-to-trough)
  Q:     number;  // steepness   (0 = sine, 1 = sharp trochoidal crest)
  omega: number;  // angular frequency = √(g·k)  (deep-water dispersion)
  dx:    number;  // wave travel direction, x component (unit vector)
  dz:    number;  // wave travel direction, z component (unit vector)
}

// Shape descriptor pushed to GPU per wave: vec4(k, amp, Q, omega) + vec2(dx, dz)
export interface WaveGPUPack {
  wp: [number, number, number, number];   // k, amp, Q, omega
  wd: [number, number];                   // dx, dz
}

const G = 9.81;
// Wave crests travel at sqrt(g/k) in deep water.  With the game world
// spatially compressed by TRAVEL_SCALE=5, that is visually ~5× too fast.
// Multiplying omega by this factor gives a realistic perceived swell speed.
const PHASE_SPEED_SCALE = 0.20;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hierarchical Gerstner-wave physics engine.
 *
 * Wave hierarchy (8 total):
 *   Wave 0   — Primary swell: long wavelength, high amplitude, travels
 *               directly downwind.  Creates the visible "hills on the horizon".
 *   Waves 1–3 — Secondary waves: medium wavelength, these are the "waves
 *               coming at you".  The boat pitches and surfs in these.
 *   Waves 4–7 — Wind chop: short wavelength, gives the surface its choppy
 *               texture and whitecap character.
 *
 * All parameters are driven directly from the Beaufort number (0–8) so the
 * sea state is fully deterministic from wind speed — no hidden magic constants.
 *
 * New physics API (used by VesselBuoyancyService):
 *   getWaveSlopeInHeading(wx, wz, headingRad, t) → slope [−1..+1]
 *   getLateralOrbitalVelocity(wx, wz, headingRad, t) → m/s
 */
@Injectable({ providedIn: 'root' })
export class WaveEngine {
  static readonly NUM = 8;
  private static readonly TRANSITION_SEC = 15.0;

  waves: GerstnerWave[] = [];
  private fromWaves:     GerstnerWave[] = [];   // snapshot at transition start
  private targetWaves:   GerstnerWave[] = [];
  private transitionT    = 0;
  private transitioning  = false;

  // Current Beaufort number (0–8) — exposed so OceanService can pass it as a
  // uniform to the fragment shader for Beaufort-scaled foam.
  beaufort = 0;
  private fromBeaufort   = 0;
  private targetBeaufort = 0;

  constructor() { this.applyCalm(); }

  // ── Public wave-physics API ───────────────────────────────────────────────

  /**
   * Vertical displacement at world position (wx, wz) at elapsed time t.
   */
  getHeightAt(wx: number, wz: number, t: number): number {
    let y = 0;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * wx + w.dz * wz) - w.omega * t;
      y += w.amp * Math.sin(theta);
    }
    return y;
  }

  /**
   * Analytical Gerstner surface normal at (wx, wz, t).
   * Used for hull tilt (pitch / roll).
   */
  getSurfaceNormal(wx: number, wz: number, t: number): Vector3 {
    let nx = 0, ny = 1, nz = 0;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * wx + w.dz * wz) - w.omega * t;
      const cosT  = Math.cos(theta);
      const sinT  = Math.sin(theta);
      const kA    = w.k * w.amp;
      nx -= w.dx * kA * cosT;
      nz -= w.dz * kA * cosT;
      ny -= w.Q  * kA * sinT;
    }
    return Vector3.Normalize(new Vector3(nx, ny, nz));
  }

  /**
   * Wave slope in the vessel heading direction.
   * Positive → boat is climbing the face of an oncoming wave (slow down).
   * Negative → boat is descending the back face (speed up / surf).
   *
   * Derived analytically: dY/ds = Σ amp·k·cos(θ)·(dx·headX + dz·headZ)
   */
  getWaveSlopeInHeading(wx: number, wz: number, headingRad: number, t: number): number {
    const headX = Math.sin(headingRad);
    const headZ = Math.cos(headingRad);
    let slope = 0;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * wx + w.dz * wz) - w.omega * t;
      const alignment = w.dx * headX + w.dz * headZ;
      slope += w.amp * w.k * Math.cos(theta) * alignment;
    }
    return slope;
  }

  /**
   * Horizontal orbital velocity component perpendicular to heading (rightward).
   * This is the cross-wave push that drives broaching in following seas.
   *
   * For Gerstner: vx = Σ amp·ω·cos(θ)·dx,  vz = Σ amp·ω·cos(θ)·dz
   * Perpendicular (rightward) component = vx·cos(hdg) − vz·sin(hdg)
   */
  getLateralOrbitalVelocity(wx: number, wz: number, headingRad: number, t: number): number {
    let vx = 0, vz = 0;
    for (const w of this.waves) {
      const theta  = w.k * (w.dx * wx + w.dz * wz) - w.omega * t;
      const cosT   = Math.cos(theta);
      vx += w.amp * w.omega * cosT * w.dx;
      vz += w.amp * w.omega * cosT * w.dz;
    }
    const cosH = Math.cos(headingRad);
    const sinH = Math.sin(headingRad);
    return vx * cosH - vz * sinH;
  }

  /** Sum of all wave amplitudes — used as the foam crest threshold uniform. */
  get totalAmplitude(): number {
    return this.waves.reduce((s, w) => s + w.amp, 0);
  }

  // ── GPU packing ────────────────────────────────────────────────────────────

  /** Returns 8 wave descriptors ready for upload to the vertex shader. */
  packForGPU(): WaveGPUPack[] {
    const packs: WaveGPUPack[] = [];
    for (let i = 0; i < WaveEngine.NUM; i++) {
      const w = this.waves[i] ?? ZERO_WAVE;
      packs.push({ wp: [w.k, w.amp, w.Q, w.omega], wd: [w.dx, w.dz] });
    }
    return packs;
  }

  /**
   * Pack for GPU with amplitude zeroed for waves above `maxWaveIndex`.
   * Used by outer LOD materials to suppress short-wavelength chop that would
   * alias at their coarser vertex spacing.
   */
  packForGPULimited(maxWaveIndex: number): WaveGPUPack[] {
    const packs: WaveGPUPack[] = [];
    for (let i = 0; i < WaveEngine.NUM; i++) {
      const w = this.waves[i] ?? ZERO_WAVE;
      if (i <= maxWaveIndex) {
        packs.push({ wp: [w.k, w.amp, w.Q, w.omega], wd: [w.dx, w.dz] });
      } else {
        packs.push({ wp: [w.k, 0, w.Q, w.omega], wd: [w.dx, w.dz] });
      }
    }
    return packs;
  }

  // ── Weather update ─────────────────────────────────────────────────────────

  updateWeather(wind: Wind, sea: SeaConditions): void {
    // Snapshot the current wave state so tick() always interpolates from a
    // fixed baseline — avoids the compounding-lerp bug that slams waves in
    // ~1 s instead of the full TRANSITION_SEC.
    this.fromWaves      = this.waves.map(w => ({ ...w }));
    this.fromBeaufort   = this.beaufort;
    this.targetWaves    = this.buildFromBeaufort(wind.beaufort, wind.fromBearingDeg);
    this.targetBeaufort = wind.beaufort;
    this.transitionT    = 0;
    this.transitioning  = true;
  }

  // ── Per-frame tick ────────────────────────────────────────────────────────

  tick(dt: number): void {
    if (!this.transitioning) return;
    this.transitionT += dt;
    if (this.transitionT >= WaveEngine.TRANSITION_SEC) {
      this.waves    = this.targetWaves.map(w => ({ ...w }));
      this.beaufort = this.targetBeaufort;
      this.transitioning = false;
      return;
    }
    const tf = this.transitionT / WaveEngine.TRANSITION_SEC;
    // Always interpolate from the snapshotted fromWaves — true linear blend.
    this.waves    = lerpWaveSets(this.fromWaves, this.targetWaves, tf);
    this.beaufort = lerp(this.fromBeaufort, this.targetBeaufort, tf);
  }

  // ── Wave-set builders ──────────────────────────────────────────────────────

  private applyCalm(): void {
    this.waves       = this.buildFromBeaufort(1, 200);
    this.fromWaves   = this.waves.map(w => ({ ...w }));
    this.targetWaves = this.waves.map(w => ({ ...w }));
    this.beaufort    = 1;
    this.fromBeaufort   = 1;
    this.targetBeaufort = 1;
  }

  /**
   * Build a full 8-wave set from a Beaufort number (0–8) and wind bearing.
   *
   * Wave 0  — PRIMARY SWELL: very long, high amplitude.  One visible "hill"
   *            travelling directly downwind.
   * Waves 1–3 — SECONDARY: medium wavelength, the dominant pitch/surf driver.
   * Waves 4–7 — CHOP: short wavelength, texture and whitecap character.
   *
   * Amplitude scaling:
   *   b² growth ensures calm is near-flat and storms are dramatic.
   *   At B7: primary ~2.0 m, secondary peak ~0.9 m, total ~4.2 m amplitude.
   *   Significant wave height (4× RMS amp) ≈ 3.8 m — matches real Beaufort 7.
   *
   * Steepness (Q):
   *   Low at calm (gentle sinusoids), high in storm (trochoidal peaked crests).
   *   Clamped to prevent Gerstner self-intersection.
   */
  private buildFromBeaufort(beaufort: number, windBearingDeg: number): GerstnerWave[] {
    const b = Math.max(0, Math.min(8, beaufort));
    const b2 = b * b;
    // Waves travel downwind — "from" bearing + 180°
    const waveDir = (windBearingDeg + 180) % 360;

    // ── Primary swell ──────────────────────────────────────────────────────
    // Wavelength 30–286 m; amplitude 0.03–2.1 m.
    const L0  = 30 + b2 * 4.0;
    const A0  = 0.03 + b2 * 0.033;
    const Q0  = 0.10 + b * 0.055;

    // ── Secondary waves ────────────────────────────────────────────────────
    // The boat actually pitches in these — they are the dominant gameplay waves.
    // Wavelength 15–92 m; amplitude 0.02–1.1 m.
    const L1  = 15 + b2 * 1.20;
    const A1  = 0.02 + b2 * 0.017;
    const Q1  = 0.18 + b * 0.068;

    const L2  = L1 * 0.70;
    const A2  = A1 * 0.60;
    const Q2  = Q1 * 1.05;

    const L3  = L1 * 0.50;
    const A3  = A1 * 0.38;
    const Q3  = Q1 * 1.10;

    // ── Wind chop ──────────────────────────────────────────────────────────
    // Short waves; whitecap texture.  Spread across wider angular range.
    // Wavelength 6–28 m; amplitude 0.005–0.22 m.
    const Lc  = 6  + b * 2.8;
    const Ac  = 0.005 + b * 0.027;
    const Qc  = 0.30 + b * 0.060;

    return [
      makeWave(L0,           A0,        Q0,   waveDir),
      makeWave(L1,           A1,        Q1,   waveDir + 12),
      makeWave(L2,           A2,        Q2,   waveDir - 22),
      makeWave(L3,           A3,        Q3,   waveDir + 38),
      makeWave(Lc,           Ac,        Qc,   waveDir - 15),
      makeWave(Lc * 0.65,    Ac * 0.62, Qc,   waveDir + 55),
      makeWave(Lc * 0.45,    Ac * 0.38, Qc * 0.9, waveDir - 70),
      makeWave(Lc * 0.30,    Ac * 0.22, Qc * 0.8, waveDir + 88),
    ];
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function makeWave(wavelength: number, amp: number, Q: number, dirDeg: number): GerstnerWave {
  const kVal = (2 * Math.PI) / Math.max(0.5, wavelength);
  const ang  = (dirDeg * Math.PI) / 180;
  // Clamp Q so the wave never tries to self-intersect.
  const Qclamped = amp > 0.001 ? Math.min(Q, 0.90 / (kVal * amp)) : Q;
  return {
    k:     kVal,
    amp,
    Q:     Qclamped,
    omega: Math.sqrt(G * kVal) * PHASE_SPEED_SCALE,
    dx:    Math.sin(ang),
    dz:    Math.cos(ang),
  };
}

const ZERO_WAVE: GerstnerWave = { k: 1, amp: 0, Q: 0, omega: Math.sqrt(G) * PHASE_SPEED_SCALE, dx: 0, dz: 1 };

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function lerpDir(adx: number, adz: number, bdx: number, bdz: number, t: number): [number, number] {
  const a    = Math.atan2(adx, adz);
  const b    = Math.atan2(bdx, bdz);
  let   diff = b - a;
  if (diff >  Math.PI) diff -= 2 * Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  const ang  = a + diff * t;
  return [Math.sin(ang), Math.cos(ang)];
}

function lerpWaveSets(a: GerstnerWave[], b: GerstnerWave[], t: number): GerstnerWave[] {
  const result: GerstnerWave[] = [];
  for (let i = 0; i < WaveEngine.NUM; i++) {
    const wa = a[i] ?? ZERO_WAVE;
    const wb = b[i] ?? ZERO_WAVE;
    const wl   = lerp(2 * Math.PI / wa.k, 2 * Math.PI / wb.k, t);
    const kNew = (2 * Math.PI) / Math.max(0.5, wl);
    const amp  = lerp(wa.amp, wb.amp, t);
    const Q    = lerp(wa.Q, wb.Q, t);
    const [dx, dz] = lerpDir(wa.dx, wa.dz, wb.dx, wb.dz, t);
    result.push({
      k:     kNew,
      amp,
      Q:     amp > 0.001 ? Math.min(Q, 0.90 / (kNew * amp)) : Q,
      omega: Math.sqrt(G * kNew) * PHASE_SPEED_SCALE,
      dx,
      dz,
    });
  }
  return result;
}

