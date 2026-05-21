'use strict';

/**
 * Player location persistence — backed by the users table.
 *
 * Both endpoints require a valid JWT (verifyToken middleware in the route file).
 * Location is keyed by user.id (from the decoded token), so two sailors that
 * happen to share a callsign never overwrite each other's position.
 *
 * Endpoints:
 *   GET  /player-location/:callsign  → { x, z, heading, vesselSlug, savedAt }
 *   PUT  /player-location/:callsign  ← { x, z, heading, vesselSlug }
 */

const db   = require('../models');
const User = db.User;

exports.getLocation = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['lastX', 'lastZ', 'lastHeading', 'lastVesselSlug', 'lastCallsign', 'locationSavedAt'],
    });

    if (!user || user.lastX === null) {
      return res.status(404).json({ message: 'No saved location' });
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

exports.saveLocation = async (req, res) => {
  const { x, z, heading, vesselSlug } = req.body;
  const callsign = (req.params.callsign ?? '').trim().slice(0, 16) || null;

  if (typeof x !== 'number' || typeof z !== 'number') {
    return res.status(400).json({ message: 'x and z must be numbers' });
  }

  try {
    await User.update(
      {
        lastX:           x,
        lastZ:           z,
        lastHeading:     typeof heading    === 'number' ? heading    : 270,
        lastVesselSlug:  typeof vesselSlug === 'string' ? vesselSlug : 'sloop',
        lastCallsign:    callsign,
        locationSavedAt: new Date(),
      },
      { where: { id: req.user.id } },
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
