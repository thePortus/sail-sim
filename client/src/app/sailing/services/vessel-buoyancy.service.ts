import { Injectable, inject } from '@angular/core';
import { WaveEngine } from './wave-engine';

// ── Public state produced each physics tick ────────────────────────────────────

export interface BuoyancyState {
  heave:         number;   // vertical offset of hull centre (metres, smoothed)
  pitchRad:      number;   // rotation.x — positive = bow up
  rollRad:       number;   // rotation.z — positive = stbd down (lean to starboard)
  speedModifier: number;   // multiply target speed by (1 + speedModifier)
                            //   negative = fighting uphill, positive = surfing downhill
  steeringBias:  number;   // °/s added to yaw — cross-wave push / broaching tendency
}

// ── Hull geometry ──────────────────────────────────────────────────────────────
// Eight sample points in local vessel space (forward = +Z, right = +X, up = +Y).
// These match the approximate shape of the generic sloop hull in vessel.service.ts.
//
//   fwd  = metres forward of hull centre (+5.5 = bow, −4.5 = stern)
//   rgt  = metres to starboard of centre (+2 = stbd, −2 = port)
//
// Lever arms for torque:
//   Pitch  arm = fwd   (positive bow, negative stern)
//   Roll   arm = rgt   (positive stbd, negative port)
//
// Beaufort note:
//   At B7 the primary swell is ~230 m long.  The 10 m bow-stern span sits
//   across a tiny fraction of the wavelength, so pitch from the primary is
//   small (correct — long ocean swells pass under a boat smoothly).
//   The secondary waves (~74 m at B7) produce 4–8° of pitch, which is
//   dramatic and clearly visible.
//   Short chop (<30 m) produces rapid, small-amplitude pitching (choppy sea feel).

const HULL_POINTS: { fwd: number; rgt: number }[] = [
  { fwd:  5.5, rgt:  0.0 },   // 0  bow centre
  { fwd:  3.5, rgt: -2.0 },   // 1  fore-port
  { fwd:  3.5, rgt:  2.0 },   // 2  fore-stbd
  { fwd:  0.0, rgt: -2.2 },   // 3  amidships-port
  { fwd:  0.0, rgt:  2.2 },   // 4  amidships-stbd
  { fwd: -3.5, rgt: -2.0 },   // 5  aft-port
  { fwd: -3.5, rgt:  2.0 },   // 6  aft-stbd
  { fwd: -4.5, rgt:  0.0 },   // 7  stern centre
];

// Low-pass filter time constant for heave (seconds).
// 0.8 s smooths out short-wavelength chop while still following swell.
const HEAVE_TAU = 0.8;

// Scaling constants — tuned for "arcade with dramatic feel"
const SURF_SCALE    = 0.30;   // max ±30 % speed change from wave slope
const BROACH_SCALE  = 1.80;   // degrees/s per unit of lateral orbital velocity
const PITCH_SMOOTH  = 0.05;   // lerp factor per frame for pitch/roll (lower = smoother)
const MAX_BEAUFORT  = 8;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class VesselBuoyancyService {
  private waveEngine = inject(WaveEngine);

  private heaveFiltered = 0;
  private pitchFiltered = 0;
  private rollFiltered  = 0;

  /**
   * Evaluate wave-hull interaction for one physics tick.
   *
   * @param wx         World X of hull centre
   * @param wz         World Z of hull centre
   * @param headingRad Vessel heading in radians (BabylonJS convention: 0=North/+Z, π/2=East/+X)
   * @param t          Elapsed simulation time (seconds)
   * @param dt         Physics frame delta-time (seconds)
   */
  update(wx: number, wz: number, headingRad: number, t: number, dt: number): BuoyancyState {
    const sinH = Math.sin(headingRad);
    const cosH = Math.cos(headingRad);

    // ── Sample wave heights at all hull points ─────────────────────────────
    let sumH      = 0;
    let pitchTorq = 0;
    let rollTorq  = 0;
    let armFwd2   = 0;
    let armRgt2   = 0;

    for (const pt of HULL_POINTS) {
      // Transform local hull point to world XZ
      const pwx = wx + pt.fwd * sinH + pt.rgt * cosH;
      const pwz = wz + pt.fwd * cosH - pt.rgt * sinH;

      const h = this.waveEngine.getHeightAt(pwx, pwz, t);
      sumH      += h;
      pitchTorq += h * pt.fwd;
      rollTorq  += h * pt.rgt;
      armFwd2   += pt.fwd * pt.fwd;
      armRgt2   += pt.rgt * pt.rgt;
    }

    const N = HULL_POINTS.length;
    const meanH     = sumH / N;
    const pitchRaw  = pitchTorq / (armFwd2 / N);  // radians ≈ atan2(height, lever)
    const rollRaw   = rollTorq  / (armRgt2 / N);

    // ── Smooth heave with exponential filter ──────────────────────────────
    const alpha = 1 - Math.exp(-dt / HEAVE_TAU);
    this.heaveFiltered += (meanH - this.heaveFiltered) * alpha;

    // ── Smooth pitch and roll ──────────────────────────────────────────────
    // Faster tracking than heave so the tilt matches the wave geometry.
    const pAlpha = Math.min(1, PITCH_SMOOTH + dt * 2.5);
    this.pitchFiltered += (pitchRaw - this.pitchFiltered) * pAlpha;
    this.rollFiltered  += (rollRaw  - this.rollFiltered)  * pAlpha;

    // ── Wave slope → speed modifier ───────────────────────────────────────
    // Positive slope (climbing) slows the boat; negative slope (descending)
    // provides a mild speed boost — the "surfing down the face" feeling.
    // Effect scales with sea state so it's imperceptible at B0–2.
    const slope       = this.waveEngine.getWaveSlopeInHeading(wx, wz, headingRad, t);
    const beaufortT   = Math.min(1, this.waveEngine.beaufort / MAX_BEAUFORT);
    const speedMod    = Math.max(-0.30, Math.min(0.20, -slope * SURF_SCALE * beaufortT));

    // ── Lateral orbital velocity → steering bias ──────────────────────────
    // Cross-wave push creates broaching tendency in following seas at B6+.
    // Capped to ±6 °/s so it feels dramatic but doesn't instantly spin the boat.
    const lateralV    = this.waveEngine.getLateralOrbitalVelocity(wx, wz, headingRad, t);
    const steeringBias = Math.max(-6, Math.min(6,
      lateralV * BROACH_SCALE * beaufortT,
    ));

    return {
      heave:         this.heaveFiltered,
      pitchRad:      this.pitchFiltered,
      rollRad:       this.rollFiltered,
      speedModifier: speedMod,
      steeringBias,
    };
  }

  /** Reset smoothing accumulators (call on refloat / spawn). */
  reset(): void {
    this.heaveFiltered = 0;
    this.pitchFiltered = 0;
    this.rollFiltered  = 0;
  }
}
