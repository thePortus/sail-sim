'use strict';

/**
 * Player location READ — backed by the users table. Keyed by user.id (from the JWT), and gated by
 * MAP_VERSION so a position saved on a previous map isn't restored on a new one.
 *
 * Writes are SERVER-authoritative (multiplayer.js savePlayerLocation, from the validated movement
 * stream) — there is deliberately no write endpoint here, so a tampered client can't fake a location.
 *
 * Endpoint:
 *   GET /player-location/:callsign  → { x, z, heading, vesselSlug, savedAt }  (404 if none / stale map)
 */

const db   = require('../models');
const User = db.User;
const { MAP_VERSION } = require('../movement-constants');
const anchors = require('../quest-anchors');

exports.getLocation = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['lastX', 'lastZ', 'lastHeading', 'lastVesselSlug', 'lastCallsign', 'locationSavedAt', 'lastMapVersion'],
    });

    if (!user || user.lastX === null) {
      // Brand-new player → spawn at the intro tutorial anchor (the Saltmeadow, just off the start port), DERIVED
      // from the current map so it never goes stale. The intro itself is gated by questState in the ws login.
      // Anchors not ready (map still loading) → 404 so the client coastal-spawns on its own.
      const a = anchors.getAnchors();
      if (a && a.spawn) {
        return res.json({ x: a.spawn.x, z: a.spawn.z, heading: a.spawn.heading, vesselSlug: 'pinnace', callsign: null, savedAt: null });
      }
      return res.status(404).json({ message: 'No saved location' });
    }

    // Map-version gate: a position saved on a DIFFERENT map is stale → behave as "no saved location"
    // so the client coastal-spawns on the current map. NULL = legacy save (pre-column) → treated as
    // current, so deploying this feature doesn't wipe everyone's existing anchorage.
    if (user.lastMapVersion != null && user.lastMapVersion !== MAP_VERSION) {
      return res.status(404).json({ message: 'Saved location is from a previous map' });
    }

    res.json({
      x:          user.lastX,
      z:          user.lastZ,
      heading:    user.lastHeading    ?? 270,
      vesselSlug: user.lastVesselSlug ?? 'sloop',
      callsign:   user.lastCallsign,
      savedAt:    user.locationSavedAt,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * The player's OWNED vessel slug — map-INDEPENDENT (persists across map regens, unlike position). The client
 * fetches this before building its hull so a new map still opens in the ship you own. Defaults to 'pinnace'.
 *   GET /player-ship  → { ship }
 */
exports.getShip = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, { attributes: ['ship'] });
    res.json({ ship: (user && user.ship) || 'pinnace' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// NOTE: there is intentionally NO saveLocation here. Position is persisted SERVER-side from the
// validated movement stream (multiplayer.js savePlayerLocation) so a client can't write a fake one.
