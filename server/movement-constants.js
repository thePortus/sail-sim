'use strict';

/**
 * Canonical movement-authority tuning — the single source of truth for the kinematic limits the
 * server enforces on player position updates, plus the ship-to-ship collision capsule (used from
 * Phase 4) and the map version (used from Phase 5). Mirrors the role combat-constants.js plays for
 * combat. Keep the capsule dims in sync with the client COLL_DIMS_BY_SLUG (multiplayer.service.ts).
 */

const fs = require('fs');
const path = require('path');
const terrainConfig = require('./config/terrain.config');
const { worldBounds }  = terrainConfig;
const { TRAVEL_SCALE } = require('./combat-constants');

// Slack multiplier applied to every kinematic limit. Absorbs gusts, leeway, wave-surf nudges,
// network jitter, and a delayed update arriving with a larger-than-nominal dt. Generous enough that
// an honest client is never corrected; tight enough that teleports / speed-hacks are caught.
const SLACK = 1.5;

// The client can back the sails to a small negative speed (baseTarget bottoms out at -1.5 kn).
const REVERSE_MAX = 2.5;

// Absolute heading-change cap (deg/s). The client turn curve maxes at 30 deg/s; wave-wander adds a
// hair more. SLACK is applied on top inside validateMove.
const TURN_CAP_DEG = 30;

// dt clamp (s) for the per-update delta. Floor avoids div-by-zero / huge implied speed on a burst of
// updates; ceil bounds the allowed travel after a stall or tab-away so a long gap can't authorise a
// giant jump (a real client that was away simply gets gently corrected back onto a plausible path).
const DT_MIN = 0.02;
const DT_MAX = 0.5;

// Token-bucket burst window (s) for the movement-validation dt. The dt budget refills at real wall-clock
// rate (capped per packet at DT_MAX) and tops out here. This absorbs network JITTER: when a high-ping
// client's updates stall then arrive BUNCHED (several within a few ms), each can still spend a full
// send-interval of travel from the budget accrued during the stall — instead of being false-clamped to
// ~0 and rubber-banding (the bug a ~300 ms-ping player hit). Still bounds sustained speed-hacks: over any
// window, total travel ≤ maxSpeed·SLACK·elapsed + this burst. ~0.6 s covers typical intercontinental jitter.
const MOVE_BURST_SEC = 0.6;

// Ship-to-ship collision capsule per vessel slug (mirrors the client COLL_DIMS_BY_SLUG). Phase 4.
const COLL_DIMS_BY_SLUG = {
  sloop:       { halfLen: 5.0, radius: 2.2 },
  pinnace:     { halfLen: 3.8, radius: 1.4 },
  merchantman: { halfLen: 13.0, radius: 3.6 },   // the biggest hull (brig still falls back to sloop dims)
};
function collDims(slug) { return COLL_DIMS_BY_SLUG[slug] || COLL_DIMS_BY_SLUG.sloop; }

// Collision response (mirrors the client): restitution 0 = dead stop (head-on / T-bone), 1 = fully
// elastic. Below COLL_MIN_SPEED we don't re-aim the heading (avoids a spin at a near-standstill).
const COLL_RESTITUTION = 0.15;
const COLL_MIN_SPEED   = 0.4;

// Bump whenever the terrain is re-baked so stale saved positions are discarded on spawn. Phase 5.
// Map version: now AUTO-STAMPED into the manifest by the terrain build (build-terrain-region.mjs increments
// it every bake). Read it once at boot; any new map → a new version → saved player positions + economy reset.
// Falls back to 8 for legacy manifests baked before mapVersion was stamped (matches the last hand-set value).
function bakedMapVersion() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(terrainConfig.outputDir, 'manifest.json'), 'utf8'));
    if (Number.isFinite(m.mapVersion)) return m.mapVersion | 0;
  } catch { /* no manifest / parse error → legacy fallback */ }
  return 8;
}
const MAP_VERSION = bakedMapVersion();

module.exports = {
  worldBounds, TRAVEL_SCALE, SLACK, REVERSE_MAX, TURN_CAP_DEG, DT_MIN, DT_MAX, MOVE_BURST_SEC,
  COLL_DIMS_BY_SLUG, collDims, COLL_RESTITUTION, COLL_MIN_SPEED, MAP_VERSION,
};
