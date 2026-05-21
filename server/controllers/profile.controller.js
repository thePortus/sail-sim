const db   = require('../models');
const User = db.User;

exports.findOne = (req, res) => {
  User.findOne({
    where:      { username: req.params.username },
    attributes: { exclude: ['password'] },
  })
    .then(data => data ? res.send(data) : res.status(404).send({ message: 'User not found.' }))
    .catch(err => res.status(500).send({ message: err.message }));
};
