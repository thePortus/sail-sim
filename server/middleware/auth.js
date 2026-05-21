/**
 * @file provides middleware (implemented in routes) that ensures
 * that users accessing routes are either logged in, or, are editors/owners.
 * @author David J. Thomas
 */


const jwt = require('jsonwebtoken');

const config = require('../config/db.config');

function extractToken(authHeader) {
  if (!authHeader) return null;
  // If header starts with "Bearer ", strip it
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return authHeader;
}

/**
 * Ensures that request was sent by an authorized user.
 * 
 * @param {*} req Request object
 * @param {*} res Response data from database
 * @param {*} next Next function to execute, upon completion
 */
module.exports.verifyToken = (req, res, next) => {
  const token = extractToken(req.headers.authorization);
  if (!token) {
    res.status(401).send({ message: 'Unauthorized' });
  }
  else {
    jwt.verify(token, config.JWT_SECRET, function (err, decoded) {
      if(decoded) {
        req.user = decoded.data;
        next();
      }
      /* istanbul ignore next */
      else {
        res.status(401).send({ message: 'Unauthorized' });
      }
    });
  }
};

/**
 * Ensures that request was sent by an authorized editor, admin, or owner
 * 
 * @param {*} req Request object
 * @param {*} res Response data from database
 * @param {*} next Next function to execute, upon completion
 */
module.exports.verifyEditorToken = (req, res, next) => {
  const editorRoles = ['Owner', 'Editor', 'Admin'];
  const token = extractToken(req.headers.authorization);
  if (!token) {
    res.status(401).send({ message: 'Unauthorized' });
  }
  else {
    jwt.verify(token, config.JWT_SECRET, function (err, decoded) {
      if(decoded) {
        req.user = decoded.data;
        if(!editorRoles.includes(req.user.role)) {
          res.status(401).send({ message: 'User is not an approved editor or administrator'});
        }
        else {
          next();
        }
      }
      /* istanbul ignore next */
      else {
        res.status(401).send({ message: 'Unauthorized' });
      }
    });
  }
};

/**
 * Ensures that request was sent by an authorized editor or owner.
 * 
 * @param {*} req Request object
 * @param {*} res Response data from database
 * @param {*} next Next function to execute, upon completion
 */
module.exports.verifyAdminToken = (req, res, next) => {
  const adminRoles = ['Owner', 'Admin'];
  const token = extractToken(req.headers.authorization);
  if (!token) {
    res.status(401).send({ message: 'Unauthorized' });
  }
  else {
    jwt.verify(token, config.JWT_SECRET, function (err, decoded) {
      if(decoded) {
        req.user = decoded.data;
        if(!adminRoles.includes(req.user.role)) {
          res.status(401).send({ message: 'User is not an approved administrator'});
        }
        else {
          next();
        }
      }
      /* istanbul ignore next */
      else {
        res.status(401).send({ message: 'Unauthorized' });
      }
    });
  }
};

/**
 * Ensures that request was sent by the owner.
 * 
 * @param {*} req Request object
 * @param {*} res Response data from database
 * @param {*} next Next function to execute, upon completion
 */
module.exports.verifyOwnerToken = (req, res, next) => {
  const adminRoles = ['Owner'];
  const token = extractToken(req.headers.authorization);
  if (!token) {
    res.status(401).send({ message: 'Unauthorized' });
  }
  else {
    jwt.verify(token, config.JWT_SECRET, function (err, decoded) {
      if(decoded) {
        req.user = decoded.data;
        if(!adminRoles.includes(req.user.role)) {
          res.status(401).send({ message: 'User is not the owner'});
        }
        else {
          next();
        }
      }
      else {
        res.status(401).send({ message: 'Unauthorized' });
      }
    });
  }
};