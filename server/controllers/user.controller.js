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

exports.register = (req, res) => {
  const { username, callsign, password } = req.body;
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
  const updates = {};
  if (req.body.callsign)    updates.callsign    = req.body.callsign;
  if (req.body.password) updates.password = md5(req.body.password);
  User.update(updates, { where: { username: req.params.username } })
    .then(() => res.send({ message: 'Updated successfully.' }))
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
