'use strict';

const limitRate = require('../middleware/limit-rate');

module.exports = app => {
  const controller = require('../controllers/weather.controller');
  const router     = require('express').Router();

  // GET /api/weather  — returns current computed weather conditions
  router.get('/', limitRate, controller.getWeather);

  app.use('/weather', router);
};
