const db     = require('../models');
const config = require('../config/db.config');
const jwt    = require('jsonwebtoken');
const md5    = require('md5');

const User = db.User;

exports.login = (req, res) => {
  const { username, password } = req.body;
  User.findOne({ where: { username } })
    .then(user => {
      if (!user) return res.status(404).send({ message: 'User not found.' });
      if (user.password !== md5(password))
        return res.status(401).send({ message: 'Invalid password.' });

      const token = jwt.sign(
        { data: { id: user.id, username: user.username, callsign: user.callsign, role: user.role } },
        config.JWT_SECRET,
        { expiresIn: '24h' }
      );
      res.send({ id: user.id, username: user.username, callsign: user.callsign, role: user.role, token });
    })
    .catch(err => res.status(500).send({ message: err.message }));
};

// Roles, highest privilege first.
const ROLES = ['Owner', 'Admin', 'Editor', 'Viewer'];

/**
 * Whether a requester with `requesterRole` may set a user's role to `targetRole`.
 *  - Only an Owner may grant Owner.
 *  - Owner or Admin may grant Admin / Editor / Viewer (so admins can promote regular
 *    users to Admin and demote them back — per product spec).
 *  - Editors and Viewers may never change roles.
 * Returns false for any unrecognised target role.
 */
function canAssignRole(requesterRole, targetRole) {
  if (!ROLES.includes(targetRole)) return false;
  if (targetRole === 'Owner') return requesterRole === 'Owner';
  return requesterRole === 'Owner' || requesterRole === 'Admin';
}

exports.register = (req, res) => {
  const { username, callsign, password } = req.body;
  // Disallow quotes in callsigns — chat commands (e.g. /t "Red Sail" hi) use double
  // quotes to wrap callsigns that contain spaces, so a literal quote would break parsing.
  if (typeof callsign === 'string' && /["']/.test(callsign)) {
    return res.status(400).send({ message: 'Callsign may not contain quote characters.' });
  }
  User.create({ username, callsign, password: md5(password), role: 'Viewer' })
    .then(user => res.status(201).send({
      message: 'Registered successfully.',
      user: { id: user.id, username: user.username, callsign: user.callsign }
    }))
    .catch(err => res.status(500).send({ message: err.message }));
};

exports.findAll = (req, res) => {
  User.findAll({ attributes: { exclude: ['password'] } })
    .then(data => res.send(data))
    .catch(err => res.status(500).send({ message: err.message }));
};

exports.findOne = (req, res) => {
  User.findOne({ where: { username: req.params.username }, attributes: { exclude: ['password'] } })
    .then(data => data ? res.send(data) : res.status(404).send({ message: 'User not found.' }))
    .catch(err => res.status(500).send({ message: err.message }));
};

exports.update = (req, res) => {
  // Type-guard every accepted field up front (tests expect a 500 with this shape).
  for (const field of ['username', 'password', 'callsign', 'theme', 'role']) {
    if (req.body[field] !== undefined && typeof req.body[field] !== 'string') {
      return res.status(500).send({ message: [`'${field}' must be of type 'string'!`] });
    }
  }

  const updates = {};
  if (req.body.callsign) {
    if (/["']/.test(req.body.callsign)) {
      return res.status(400).send({ message: 'Callsign may not contain quote characters.' });
    }
    updates.callsign = req.body.callsign;
  }
  if (req.body.password) updates.password = md5(req.body.password);

  // Role changes require sufficient privilege (req.user is set by verifyToken).
  if (req.body.role !== undefined) {
    const requesterRole = req.user?.role;
    if (!canAssignRole(requesterRole, req.body.role)) {
      return res.status(401).send({
        message: 'User is unauthorized to change to the desired role level or password (or the role level was invalid).',
      });
    }
    updates.role = req.body.role;
  }

  User.findOne({ where: { username: req.params.username } })
    .then(user => {
      if (!user) {
        return res.status(500).send({
          message: `Cannot update User with username=${req.params.username}. Maybe User was not found!`,
        });
      }
      return user.update(updates)
        .then(() => res.send({ message: 'User was updated successfully.' }));
    })
    .catch(err => res.status(500).send({ message: err.message }));
};

/**
 * Promote/demote by CALLSIGN (chat-command friendly — the client only knows other
 * players by callsign, which may contain spaces). Body: { role }. Rules:
 *  - Requester must be Owner or Admin (route guard) AND authorised for the target role.
 *  - The Owner's role can never be changed (demoting the Owner is forbidden).
 */
exports.setRoleByCallsign = (req, res) => {
  const targetRole = req.body.role;
  if (typeof targetRole !== 'string' || !canAssignRole(req.user?.role, targetRole)) {
    return res.status(401).send({
      message: 'User is unauthorized to change to the desired role level (or the role level was invalid).',
    });
  }
  User.findOne({ where: { callsign: req.params.callsign } })
    .then(user => {
      if (!user) return res.status(404).send({ message: 'User not found.' });
      if (user.role === 'Owner') {
        return res.status(401).send({ message: 'The Owner\'s role cannot be changed.' });
      }
      return user.update({ role: targetRole })
        .then(() => res.send({ message: 'User was updated successfully.', callsign: user.callsign, role: targetRole }));
    })
    .catch(err => res.status(500).send({ message: err.message }));
};

exports.delete = (req, res) => {
  User.destroy({ where: { username: req.params.username } })
    .then(() => res.send({ message: 'Deleted successfully.' }))
    .catch(err => res.status(500).send({ message: err.message }));
};

// Lightweight token-validity check — returns the decoded identity so the client
// can confirm the JWT is still honoured by this server instance (guards against
// stale tokens surviving a server wipe / secret rotation).
exports.me = (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role });
};
