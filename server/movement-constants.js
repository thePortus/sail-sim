'use strict';

/**
 * Canonical movement-authority tuning — the single source of truth for the kinematic limits the
 * server enforces on player position updates, plus the ship-to-ship collision capsule (used from
 * Phase 4) and the map version (used from Phase 5). Mirrors the role combat-constants.js plays for
 * combat. Keep the capsule dims in sync with the client COLL_DIMS_BY_SLUG (multiplayer.service.ts).
 */

const { worldBounds }  = require('./config/terrain.config');
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

// Ship-to-ship collision capsule per vessel slug (mirrors the client COLL_DIMS_BY_SLUG). Phase 4.
const COLL_DIMS_BY_SLUG = {
  sloop:   { halfLen: 5.0, radius: 2.2 },
  pinnace: { halfLen: 3.8, radius: 1.4 },
};
function collDims(slug) { return COLL_DIMS_BY_SLUG[slug] || COLL_DIMS_BY_SLUG.sloop; }

// Collision response (mirrors the client): restitution 0 = dead stop (head-on / T-bone), 1 = fully
// elastic. Below COLL_MIN_SPEED we don't re-aim the heading (avoids a spin at a near-standstill).
const COLL_RESTITUTION = 0.15;
const COLL_MIN_SPEED   = 0.4;

// Bump whenever the terrain is re-baked so stale saved positions are discarded on spawn. Phase 5.
const MAP_VERSION = 2;

module.exports = {
  worldBounds, TRAVEL_SCALE, SLACK, REVERSE_MAX, TURN_CAP_DEG, DT_MIN, DT_MAX,
  COLL_DIMS_BY_SLUG, collDims, COLL_RESTITUTION, COLL_MIN_SPEED, MAP_VERSION,
};
