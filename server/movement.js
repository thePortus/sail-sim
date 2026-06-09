'use strict';

/**
 * Authoritative movement validation. The client still simulates its own boat for instant
 * responsiveness, but the server checks every claimed pose against the vessel's physical limits
 * (world bounds, max travel for the elapsed time, max heading change, speed band) relative to the
 * last ACCEPTED pose. Implausible claims (teleports, speed-hacks) are clamped back onto a plausible
 * path; the sender is told via a `correction` and snaps to it, while everyone else only ever sees
 * the clamped, authoritative pose. Mirrors combat.js's "validate the client's claim" philosophy.
 *
 * Land collision is added in Phase 3, ship-to-ship collision in Phase 4 — both layer onto the pose
 * this module produces.
 */

const M = require('./movement-constants');
const mask = require('./terrain-mask');
const piers = require('./pier-obstacles');
const { getVesselDef } = require('./controllers/vessels.controller');

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Shortest signed angular difference (b - a) in degrees, in (-180, 180]. */
function angleDelta(a, b) { return ((b - a + 540) % 360) - 180; }

/**
 * @param prev    last ACCEPTED pose { x, z, heading, speed } — or null for a player's first update
 *                (no baseline to diff against → trusted bootstrap; bounds/speed are still clamped).
 * @param claim   sanitised { x, z, heading, speed, vesselSlug } from the client.
 * @param dtSec   seconds since this player's last accepted update.
 * @param trusted true for Owner/Admin — they have a teleport ability, so their pose is accepted
 *                verbatim (no clamp, no correction). Identity/role come from the verified JWT, so
 *                this can't be spoofed by a regular client.
 * @returns { pose: { x, z, heading, speed }, corrected: boolean }
 */
function validateMove(prev, claim, dtSec, trusted = false) {
  const heading0 = ((claim.heading % 360) + 360) % 360;

  // Trusted roles bypass all kinematic checks (admin teleport, and later teleporting other players).
  if (trusted) {
    return { pose: { x: claim.x, z: claim.z, heading: heading0, speed: claim.speed }, corrected: false };
  }

  const vessel = getVesselDef(claim.vesselSlug);
  const maxSpeed = (vessel.physics && vessel.physics.maxSpeed) || 9.0;
  const wb = M.worldBounds;

  // Always-enforced clamps: world envelope + speed band.
  let x = clamp(claim.x, wb.minX, wb.maxX);
  let z = clamp(claim.z, wb.minZ, wb.maxZ);
  let heading = ((claim.heading % 360) + 360) % 360;
  let speed = clamp(claim.speed, -M.REVERSE_MAX, maxSpeed);
  let corrected = x !== claim.x || z !== claim.z || speed !== claim.speed;

  // First update: nothing to diff a delta against — accept the (bounds/speed-clamped) pose.
  if (!prev) return { pose: { x, z, heading, speed }, corrected };

  const dt = clamp(dtSec, M.DT_MIN, M.DT_MAX);

  // Max travel since the last accepted pose. If the step overshoots, clamp the position back along
  // the claimed direction (so a teleport lands the player at the furthest plausible point, facing
  // the way they claimed — no rubber-band to the origin).
  const maxDist = maxSpeed * M.TRAVEL_SCALE * dt * M.SLACK;
  const ddx = x - prev.x, ddz = z - prev.z;
  const dist = Math.hypot(ddx, ddz);
  if (dist > maxDist && dist > 1e-6) {
    const f = maxDist / dist;
    x = prev.x + ddx * f;
    z = prev.z + ddz * f;
    corrected = true;
  }

  // Max heading change for the elapsed time.
  const maxTurn = M.TURN_CAP_DEG * dt * M.SLACK;
  const dHead = angleDelta(prev.heading, heading);
  if (Math.abs(dHead) > maxTurn) {
    heading = (((prev.heading + Math.sign(dHead) * maxTurn) % 360) + 360) % 360;
    corrected = true;
  }

  // Land guard: a ship's hull centre may never end up on land. If the (already distance-clamped)
  // destination is on land, hold the last water position and stop (mirrors the client's grounding).
  // The boat may still turn in place. Honest clients never hit this — they stop at the shore
  // themselves, and their broadcast centre stays in water.
  if (mask.isOnLand(x, z)) {
    x = prev.x;
    z = prev.z;
    speed = 0;
    corrected = true;
  }

  // Pier guard: ships can't sail through a harbor pier (a static no-clip box around the deck).
  // Same response as the land guard — hold the prior pose + stop. (Admins already bypass above.)
  if (piers.blockedAt(x, z)) {
    x = prev.x;
    z = prev.z;
    speed = 0;
    corrected = true;
  }

  return { pose: { x, z, heading, speed }, corrected };
}

// ── Ship-to-ship collision ────────────────────────────────────────────────────
// Each hull is a capsule: a centreline segment (heading, half-length) with a radius. Ported from the
// client's tickCollisions/closestSegSeg/applyCollision so the authoritative result matches what the
// client used to compute locally.

const DEG = Math.PI / 180;

/** Closest points between two 2-D segments (centre, unit dir, half-length). 2-D port of Ericson's
 *  ClosestPtSegmentSegment. */
function closestSegSeg(ax, az, adx, adz, aHalf, bx, bz, bdx, bdz, bHalf) {
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const p1x = ax - adx * aHalf, p1z = az - adz * aHalf;
  const q1x = bx - bdx * bHalf, q1z = bz - bdz * bHalf;
  const d1x = adx * 2 * aHalf, d1z = adz * 2 * aHalf;
  const d2x = bdx * 2 * bHalf, d2z = bdz * 2 * bHalf;
  const rx = p1x - q1x, rz = p1z - q1z;
  const a = d1x * d1x + d1z * d1z;
  const e = d2x * d2x + d2z * d2z;
  const f = d2x * rx + d2z * rz;
  const EPS = 1e-8;
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) { /* both degenerate to points */ }
  else if (a <= EPS) { t = clamp01(f / e); }
  else {
    const c = d1x * rx + d1z * rz;
    if (e <= EPS) { s = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0)      { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return { pax: p1x + d1x * s, paz: p1z + d1z * s, pbx: q1x + d2x * t, pbz: q1z + d2z * t };
}

/** One half of the velocity response: cancel the component of (speed,heading) heading INTO the other
 *  hull along normal (nx,nz), plus restitution. Returns the new { heading, speed }. */
function bounceVelocity(heading, speed, nx, nz) {
  const fx = Math.sin(heading * DEG), fz = Math.cos(heading * DEG);
  const vx = speed * fx, vz = speed * fz;
  const into = vx * nx + vz * nz;
  if (into <= 0) return { heading, speed };   // already separating / sideways → unchanged
  const k = (1 + M.COLL_RESTITUTION) * into;
  const nvx = vx - k * nx, nvz = vz - k * nz;
  const newSpeed = Math.hypot(nvx, nvz);
  const newHeading = newSpeed > M.COLL_MIN_SPEED
    ? (Math.atan2(nvx, nvz) * 180 / Math.PI + 360) % 360
    : heading;
  return { heading: newHeading, speed: newSpeed };
}

/**
 * Resolve a potential collision between two authoritative poses. Symmetric — both ships are pushed
 * half the penetration apart and each gets its own velocity response. Returns { hit, a, b } where
 * a/b are the NEW poses (only present when hit). Pure math; the caller applies + broadcasts.
 *
 * @param a/b   { x, z, heading, speed }
 * @param dimA/dimB { halfLen, radius }
 */
function resolvePair(a, b, dimA, dimB) {
  const aFx = Math.sin(a.heading * DEG), aFz = Math.cos(a.heading * DEG);
  const bFx = Math.sin(b.heading * DEG), bFz = Math.cos(b.heading * DEG);
  const cp = closestSegSeg(a.x, a.z, aFx, aFz, dimA.halfLen, b.x, b.z, bFx, bFz, dimB.halfLen);
  const dx = cp.pbx - cp.pax, dz = cp.pbz - cp.paz;
  const dist = Math.hypot(dx, dz);
  const rsum = dimA.radius + dimB.radius;
  if (dist >= rsum || dist < 1e-4) return { hit: false };

  const pen = rsum - dist;
  const nx = dx / dist, nz = dz / dist;       // unit normal, points A → B
  const half = pen * 0.5;

  const av = bounceVelocity(a.heading, a.speed, nx, nz);          // A's "into" dir is +n
  const bv = bounceVelocity(b.heading, b.speed, -nx, -nz);        // B's "into" dir is -n
  return {
    hit: true,
    a: { x: a.x - nx * half, z: a.z - nz * half, heading: av.heading, speed: av.speed },
    b: { x: b.x + nx * half, z: b.z + nz * half, heading: bv.heading, speed: bv.speed },
  };
}

module.exports = { validateMove, angleDelta, clamp, resolvePair };
