'use strict';

const verifyAdminToken = require('../middleware/auth').verifyAdminToken;

module.exports = app => {
  const controller = require('../controllers/admin.controller');
  const router     = require('express').Router();

  // All routes under /admin require a valid admin JWT.
  router.post('/teleport', verifyAdminToken, controller.teleport);

  app.use('/admin', router);
};
