'use strict';

const limitRate       = require('../middleware/limit-rate');
const verifyAdminToken = require('../middleware/auth').verifyAdminToken;

module.exports = app => {
  const controller = require('../controllers/weather.controller');
  const router     = require('express').Router();

  // Public
  router.get('/',                  limitRate,        controller.getWeather);

  // Admin-only
  router.post(  '/override',       verifyAdminToken, controller.setOverride);
  router.delete('/override',       verifyAdminToken, controller.clearOverride);
  router.post(  '/time-offset',    verifyAdminToken, controller.setTimeOffset);
  router.delete('/time-offset',    verifyAdminToken, controller.clearTimeOffset);

  app.use('/weather', router);
};
