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

// This TEMPLATE is authored against the generic sloop (half-length ≈ 7 m, half-beam ≈ 2.2 m). update() scales it
// to each vessel's real footprint via (hullHalfLen/REF_HALF_LEN, hullHalfBeam/REF_HALF_BEAM) so a small open boat
// (pinnace) samples its OWN ~4 m hull instead of these sloop-sized arms — sampling far outside the real hull made
// it straddle separate crests in steep/shallow chop and let the anti-sink floor (long lever arms) launch it.
// Passing the sloop's own dimensions reproduces these exact numbers, so the sloop's tuned feel is unchanged.
const REF_HALF_LEN  = 7.0;
const REF_HALF_BEAM = 2.2;

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

// Default wave-tilt ceiling (rad, ~11.5°) when the server sends no maxTilt. The v3 oscillator (server-derived
// natural periods) replaced the old HEAVE_TAU / PITCH_SCALE / PITCH_SMOOTH low-pass constants.
const MAX_TILT    = 0.20;

// Scaling constants — tuned for "arcade with dramatic feel"
// Surf/broach now derive from the FFT surface SLOPE (central finite differences of getVisualHeightAt), not the
// old Gerstner WaveEngine. Gains map the (dimensionless) wave-face slope → effect; kept modest + clamped so the
// real swell nudges rather than throws the boat around ("not overreactive"). Tune these two for surf/broach feel.
const SURF_SLOPE_GAIN  = 2.5;   // fore-aft slope → speed modifier (clamped to −0.30…+0.20 below)
const STEER_SLOPE_GAIN = 14;    // cross-slope → broach steering °/s (clamped to ±6 below)
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
  // v3 damped-harmonic-oscillator velocities (heave m/s; pitch/roll rad/s).
  private heaveVel = 0;
  private pitchVel = 0;
  private rollVel  = 0;

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
    opts?: {
      pitchScale?: number; heaveTau?: number; tiltTau?: number;
      heaveOmega?: number; heaveZeta?: number;
      pitchOmega?: number; pitchZeta?: number; pitchGain?: number;
      rollOmega?: number;  rollZeta?: number;  rollGain?: number;
      heelGain?: number;   maxTilt?: number;
    },
    hullHalfLen?: number, hullHalfBeam?: number,
    heelRad = 0,   // signed sail heel (radians) — folded into the roll oscillator target (v3, both clients)
  ): BuoyancyState {
    // Scale the sloop-authored HULL_POINTS template to this vessel's real footprint (1.0 for the sloop).
    const sl = (hullHalfLen  ?? REF_HALF_LEN)  / REF_HALF_LEN;
    const sb = (hullHalfBeam ?? REF_HALF_BEAM) / REF_HALF_BEAM;
    // Per-vessel buoyancy feel (defaults = the generic sloop). heaveTau = how tightly the hull rises/falls
    // with the swell (LOWER = more responsive, rides waves instead of sitting at an average level); tiltTau =
    // the same for pitch/roll. v3 replaces the legacy pitchScale/heaveTau/tiltTau low-pass with the
    // server-derived oscillator params read below (opts.heaveOmega/… ); the old fields are ignored.
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
      const fwd = HULL_POINTS[i].fwd * sl;
      const rgt = HULL_POINTS[i].rgt * sb;
      // Transform local hull point to world XZ
      const pwx = wx + fwd * sinH + rgt * cosH;
      const pwz = wz + fwd * cosH - rgt * sinH;

      const h   = this.oceanService.getVisualHeightAt(pwx, pwz, t);
      waveH[i]   = h;
      sumH      += h;
      pitchTorq += h * fwd;
      rollTorq  += h * rgt;
      armFwd2   += fwd * fwd;
      armRgt2   += rgt * rgt;
    }

    const N = HULL_POINTS.length;
    const meanH     = sumH / N;

    // ── v3 DYNAMIC BUOYANCY: three damped harmonic oscillators driven by the wave field ──────────────────
    // The natural periods come from the server (deriveBuoyancy from displacement / waterplane / metacentric
    // height), so the hull SPRINGS toward the wave and rocks at its OWN period instead of low-pass-tracking
    // it: a heavy wide hull rolls slow and ponderous, a light narrow one quick and lively, and a small boat
    // whose natural period matches the chop RESONATES — all emergent from the physics. Sail heel folds into
    // the roll target so a gust eases the boat over with real roll inertia (matching the native client).
    const maxTilt   = opts?.maxTilt   ?? MAX_TILT;
    const pitchGain = opts?.pitchGain ?? 0.85;
    const rollGain  = opts?.rollGain  ?? 1.05;
    const heelGain  = opts?.heelGain  ?? 0.5;   // purely visual lean scale (leeway/spill use the raw heel)
    // TRUE least-squares wave slope (rad) = Σ(h·arm)/Σ(arm²). NO ×N: dividing by (arm²/N) over-drove it 8× —
    // a long hull (frigate) then pitched its bow/stern tens of metres. A long ship bridges wave crests so this
    // slope is naturally small. The cap is on END DISPLACEMENT, not angle: a fixed max ANGLE throws a 48 m
    // hull's ends metres up, so a long hull gets a smaller max pitch (bow travel ≤ END_CAP_M), a small boat
    // pitches freely. sl/sb scale HULL_POINTS to the real footprint (see above), so hull dims come from those.
    const halfLen = (hullHalfLen ?? REF_HALF_LEN);
    const halfBeam = (hullHalfBeam ?? REF_HALF_BEAM);
    const END_CAP_M = 1.4;
    const maxPitch = Math.min(maxTilt, END_CAP_M / Math.max(1, halfLen));
    const maxRoll  = Math.min(maxTilt, END_CAP_M / Math.max(1, halfBeam));
    const pitchTarget = Math.max(-maxPitch, Math.min(maxPitch, pitchTorq / Math.max(1e-3, armFwd2) * pitchGain));
    const rollWave    = Math.max(-maxRoll,  Math.min(maxRoll,  rollTorq  / Math.max(1e-3, armRgt2) * rollGain));
    const rollTarget  = rollWave + heelRad * heelGain;

    // Semi-implicit (symplectic) Euler, sub-stepped so a frame hitch can't blow up the spring (keep ω·h ≲ 0.35).
    const integrate = (x: number, vel: number, target: number, omega: number, zeta: number): [number, number] => {
      const steps = Math.max(1, Math.ceil(dt * omega / 0.35));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const acc = omega * omega * (target - x) - 2 * zeta * omega * vel;
        vel += acc * h;
        x   += vel * h;
      }
      return [x, vel];
    };
    [this.heaveFiltered, this.heaveVel] = integrate(this.heaveFiltered, this.heaveVel, meanH,
      Math.max(0.1, opts?.heaveOmega ?? 2.05), opts?.heaveZeta ?? 0.30);
    [this.pitchFiltered, this.pitchVel] = integrate(this.pitchFiltered, this.pitchVel, pitchTarget,
      Math.max(0.1, opts?.pitchOmega ?? 3.59), opts?.pitchZeta ?? 0.22);
    [this.rollFiltered, this.rollVel] = integrate(this.rollFiltered, this.rollVel, rollTarget,
      Math.max(0.1, opts?.rollOmega ?? 1.69), opts?.rollZeta ?? 0.16);
    // Position clamps: pitch has no heel → cap tight (target cap + a little overshoot); roll leaves room for
    // the steady sail heel (capped upstream at MAX_HEEL ≈ 26°) layered on the wave roll.
    const pHard = maxPitch * 1.3, rHard = maxRoll + (26 * Math.PI / 180) + 0.05;   // pitch overshoot ∝ cap (no heel); roll leaves heel headroom
    this.pitchFiltered = Math.max(-pHard, Math.min(pHard, this.pitchFiltered));
    this.rollFiltered  = Math.max(-rHard, Math.min(rHard, this.rollFiltered));

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
      const floor = waveH[i] - ANTI_SINK_TOLERANCE
        - HULL_POINTS[i].fwd * sl * this.pitchFiltered
        - HULL_POINTS[i].rgt * sb * this.rollFiltered;
      if (floor > heaveFloor) heaveFloor = floor;
    }

    // Smooth the floor with a 0.25 s time constant — fast enough to prevent
    // hull corners from going underwater in sharp chop, but slow enough to
    // eliminate the instantaneous snap-upward that raw heaveFloor caused.
    const floorAlpha = 1 - Math.exp(-dt / 0.25);
    this.heaveFloorFiltered += (heaveFloor - this.heaveFloorFiltered) * floorAlpha;

    // ── Wave slope + cross-slope from the FFT SURFACE (no Gerstner) ───────────────
    // Heave/pitch/roll above already sample the FFT (getVisualHeightAt → the FFT height provider). Surf-speed
    // and broach-steer used to come from the separate Gerstner WaveEngine; derive them from the SAME FFT
    // surface via central finite differences so EVERY buoyancy input is the real FFT swell. EPS ~ half a hull
    // so it reads the swell's face, not tiny ripples (also keeps it calm).
    const EPS = 4.0;
    const fSlope = (this.oceanService.getVisualHeightAt(wx + sinH * EPS, wz + cosH * EPS, t)
                  - this.oceanService.getVisualHeightAt(wx - sinH * EPS, wz - cosH * EPS, t)) / (2 * EPS);
    const rSlope = (this.oceanService.getVisualHeightAt(wx + cosH * EPS, wz - sinH * EPS, t)
                  - this.oceanService.getVisualHeightAt(wx - cosH * EPS, wz + sinH * EPS, t)) / (2 * EPS);
    const beaufortT = Math.min(1, this.waveEngine.beaufort / MAX_BEAUFORT);
    // Uphill ahead (fSlope > 0) → slow; downhill → surf. Gentle + asymmetric clamp (surf less than it brakes).
    const speedMod = Math.max(-0.30, Math.min(0.20, -fSlope * SURF_SLOPE_GAIN * beaufortT));
    // Cross-wave tilt nudges the bow (broaching) — small, clamped.
    const steeringBias = Math.max(-6, Math.min(6, rSlope * STEER_SLOPE_GAIN * beaufortT));

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
    this.heaveVel = 0;
    this.pitchVel = 0;
    this.rollVel  = 0;
  }
}
