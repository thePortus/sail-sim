/**
 * @file Routes for getting user profile data
 * @author David J. Thomas
 */

const auth = require('../middleware/auth');
const limitRate = require('../middleware/limit-rate');

module.exports = app => {
  const controller = require('../controllers/profile.controller.js');
  var router = require('express').Router();
  // Retrieve user profile
  router.get('/:username', limitRate, auth.verifyToken, controller.findOne);
  app.use('/profile/', router);
};