'use strict';

/**
 * Admin-only actions that require server-side authorization before the client
 * is allowed to proceed.  These endpoints do not mutate server state themselves;
 * they act as an authorization gate — the caller performs the actual action
 * locally after receiving a 200 response.
 */

exports.teleport = (req, res) => {
  const { x, z } = req.body ?? {};

  if (typeof x !== 'number' || typeof z !== 'number' || !isFinite(x) || !isFinite(z)) {
    return res.status(400).json({ message: 'x and z must be finite numbers' });
  }

  // Authorization is enforced by the verifyAdminToken middleware upstream.
  // Return 200 so the client knows it may proceed with the local teleport.
  return res.json({ ok: true, x, z });
};
