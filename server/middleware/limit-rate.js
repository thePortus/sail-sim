/**
 * @file Provides middleware (implemented in routes) that ensures
 * that users don't spam requests.
 * @author David J. Thomas
 */

const rateLimit = require('express-rate-limit');

const allowlist = ['127.0.0.1'];

module.exports = rateLimit({
  max: 1000,
  windowMs: 60 * 60 * 1000,
  message: 'too many requests sent by this ip, please try again in an hour !',
  skip: (request, response) => allowlist.includes(request.ip),
});
