import { Injectable, inject } from '@angular/core';
import { WaveEngine } from './wave-engine';
import { OceanService } from './ocean.service';

// ── Public state produced each physics tick ────────────────────────────────────

export interface BuoyancyState {
  heave:         number;   // vertical offset of hull centre (metres, smoothed)
  heaveFloor:    number;   // minimum heave so no hull corner goes below its wave — anti-sink floor
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
// 1.5 s gives a long, rolling response that follows the swell envelope without
// snapping to individual chop crests.  The anti-sink floor catches any lag-
// induced submersion, so a long tau is safe.
const HEAVE_TAU = 1.5;

// Pitch/roll sensitivity scale for Voronoi waves.
// The torque-normalisation formula (pitchTorq / armFwd2) was designed for
// smooth sinusoidal waves.  Voronoi crests are sharp and tall, so the raw
// value reaches ≈1.5 rad (90°) in heavy seas — wildly unrealistic.
// PITCH_SCALE = 0.20 reduces a raw 1.5 rad result to ≈0.30 rad (17°).
// Lowered to 0.14 for the FFT ocean (taller, real swell drives more tilt than the old
// procedural model), and hard-capped by MAX_TILT so a big swell can't dunk the deck.
const PITCH_SCALE = 0.14;
const MAX_TILT    = 0.20;   // rad (~11.5°) — ceiling on wave-induced pitch/roll

// Scaling constants — tuned for "arcade with dramatic feel"
const SURF_SCALE    = 0.30;   // max ±30 % speed change from wave slope
const BROACH_SCALE  = 1.80;   // degrees/s per unit of lateral orbital velocity
const PITCH_SMOOTH  = 0.028;  // lerp factor per frame for pitch/roll (lower = smoother)
const MAX_BEAUFORT  = 8;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class VesselBuoyancyService {
  private waveEngine   = inject(WaveEngine);
  private oceanService = inject(OceanService);

  private heaveFiltered      = 0;
  private heaveFloorFiltered = 0;
  private pitchFiltered      = 0;
  private rollFiltered       = 0;

  /**
   * Evaluate wave-hull interaction for one physics tick.
   *
   * @param wx         World X of hull centre
   * @param wz         World Z of hull centre
   * @param headingRad Vessel heading in radians (BabylonJS convention: 0=North/+Z, π/2=East/+X)
   * @param t          Elapsed simulation time (seconds)
   * @param dt         Physics frame delta-time (seconds)
   */
  update(
    wx: number, wz: number, headingRad: number, t: number, dt: number,
    opts?: { pitchScale?: number; heaveTau?: number; tiltTau?: number },
  ): BuoyancyState {
    // Per-vessel buoyancy feel (defaults = the generic sloop). heaveTau = how tightly the hull rises/falls
    // with the swell (LOWER = more responsive, rides waves instead of sitting at an average level); tiltTau =
    // the same for pitch/roll; pitchScale = how much the wave slope tilts it. A small open boat (the pinnace)
    // wants SHORT taus so its low freeboard stays on top of a wave instead of being swamped by lag.
    const pitchScale = opts?.pitchScale ?? PITCH_SCALE;
    const heaveTau   = opts?.heaveTau   ?? HEAVE_TAU;
    const tiltTau    = opts?.tiltTau;

    const sinH = Math.sin(headingRad);
    const cosH = Math.cos(headingRad);

    // ── Sample wave heights at all hull points ─────────────────────────────
    let sumH      = 0;
    let pitchTorq = 0;
    let rollTorq  = 0;
    let armFwd2   = 0;
    let armRgt2   = 0;

    // Store per-point heights for the anti-sink floor calculation below.
    const waveH = new Array<number>(HULL_POINTS.length);

    for (let i = 0; i < HULL_POINTS.length; i++) {
      const pt  = HULL_POINTS[i];
      // Transform local hull point to world XZ
      const pwx = wx + pt.fwd * sinH + pt.rgt * cosH;
      const pwz = wz + pt.fwd * cosH - pt.rgt * sinH;

      const h   = this.oceanService.getVisualHeightAt(pwx, pwz, t);
      waveH[i]   = h;
      sumH      += h;
      pitchTorq += h * pt.fwd;
      rollTorq  += h * pt.rgt;
      armFwd2   += pt.fwd * pt.fwd;
      armRgt2   += pt.rgt * pt.rgt;
    }

    const N = HULL_POINTS.length;
    const meanH     = sumH / N;
    // pitchScale damps the raw torque-normalised angle for Voronoi crests.
    const pitchRaw  = pitchTorq / (armFwd2 / N) * pitchScale;
    const rollRaw   = rollTorq  / (armRgt2 / N) * pitchScale;

    // ── Smooth heave with exponential filter ──────────────────────────────
    const alpha = 1 - Math.exp(-dt / heaveTau);
    this.heaveFiltered += (meanH - this.heaveFiltered) * alpha;

    // ── Smooth pitch and roll ──────────────────────────────────────────────
    // A per-vessel time constant (tiltTau) when given — a short one snaps the bow/stern onto the wave slope and
    // lets gravity drop them back the instant the crest passes; otherwise the framerate-scaled default.
    const pAlpha = tiltTau != null ? (1 - Math.exp(-dt / tiltTau)) : Math.min(1, PITCH_SMOOTH + dt * 2.5);
    this.pitchFiltered += (pitchRaw - this.pitchFiltered) * pAlpha;
    this.rollFiltered  += (rollRaw  - this.rollFiltered)  * pAlpha;
    // Hard ceiling so even a heavy FFT swell can't tilt the deck into the water.
    this.pitchFiltered = Math.max(-MAX_TILT, Math.min(MAX_TILT, this.pitchFiltered));
    this.rollFiltered  = Math.max(-MAX_TILT, Math.min(MAX_TILT, this.rollFiltered));

    // ── Anti-sink floor ────────────────────────────────────────────────────
    // The smoothed heave always lags the instantaneous wave, and pitch/roll
    // tilt the bow/stern corners further up or down.  Without a floor the lag
    // + tilt can push a corner below its wave surface.
    //
    // For hull point i at lever arms (fwd, rgt), the world-Y of the hull's
    // local-Y=0 plane at that corner is approximately:
    //
    //   Y_corner ≈ heave + fwd·pitch + rgt·roll   (small-angle)
    //
    // For no corner to go below its wave:
    //   heave ≥ waveH[i] − fwd·pitch − rgt·roll   ∀ i
    //
    // heaveFloor is the tightest (maximum) such constraint across all points.
    // ANTI_SINK_TOLERANCE: minor spray over a corner is visually fine and
    // nautically realistic — we only floor against *significant* submersion.
    // 0.55 m gives generous lee-way before the floor activates.  A lower value
    // locks the boat to whichever corner sits on the highest crest, pulling the
    // whole hull up into an unrealistically elevated "bouncing" position.
    const ANTI_SINK_TOLERANCE = 0.55;   // metres of submersion before floor activates
    let heaveFloor = -Infinity;
    for (let i = 0; i < HULL_POINTS.length; i++) {
      const pt    = HULL_POINTS[i];
      const floor = waveH[i] - ANTI_SINK_TOLERANCE
        - pt.fwd * this.pitchFiltered
        - pt.rgt * this.rollFiltered;
      if (floor > heaveFloor) heaveFloor = floor;
    }

    // Smooth the floor with a 0.25 s time constant — fast enough to prevent
    // hull corners from going underwater in sharp chop, but slow enough to
    // eliminate the instantaneous snap-upward that raw heaveFloor caused.
    const floorAlpha = 1 - Math.exp(-dt / 0.25);
    this.heaveFloorFiltered += (heaveFloor - this.heaveFloorFiltered) * floorAlpha;

    // ── Wave slope → speed modifier ───────────────────────────────────────
    const slope       = this.waveEngine.getWaveSlopeInHeading(wx, wz, headingRad, t);
    const beaufortT   = Math.min(1, this.waveEngine.beaufort / MAX_BEAUFORT);
    const speedMod    = Math.max(-0.30, Math.min(0.20, -slope * SURF_SCALE * beaufortT));

    // ── Lateral orbital velocity → steering bias ──────────────────────────
    const lateralV    = this.waveEngine.getLateralOrbitalVelocity(wx, wz, headingRad, t);
    const steeringBias = Math.max(-6, Math.min(6,
      lateralV * BROACH_SCALE * beaufortT,
    ));

    return {
      heave:         this.heaveFiltered,
      heaveFloor:    this.heaveFloorFiltered,
      pitchRad:      this.pitchFiltered,
      rollRad:       this.rollFiltered,
      speedModifier: speedMod,
      steeringBias,
    };
  }

  /** Reset smoothing accumulators (call on refloat / spawn). */
  reset(): void {
    this.heaveFiltered      = 0;
    this.heaveFloorFiltered = 0;
    this.pitchFiltered      = 0;
    this.rollFiltered       = 0;
  }
}
