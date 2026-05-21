/**
 * @file Routes for registering, updating, and logging users in.
 * @author David J. Thomas
 */

const auth = require('../middleware/auth');
const limitRate = require('../middleware/limit-rate');

module.exports = app => {
  const controller = require('../controllers/user.controller.js');
  var router = require('express').Router();
  // Verify token — returns decoded identity; 401 if expired/invalid
  router.get('/me', auth.verifyToken, controller.me);
  // Login
  router.post('/login', limitRate, controller.login);
  // Register
  router.post('/register', limitRate, controller.register);
  // Retrieve all Users
  router.get('/', limitRate, auth.verifyAdminToken, controller.findAll);
  // Retrieve user profile
  router.get('/profile/:username', limitRate, auth.verifyToken, controller.findOne);
  // Update
  router.put('/update/:username', limitRate, auth.verifyToken, controller.update);
  // Delete
  router.delete('/delete/:username', limitRate, auth.verifyAdminToken, controller.delete);
  app.use('/user', router);
};
