module.exports = app => {
  const islands = require('../controllers/islands.controller');
  app.get('/islands',     islands.getIslands);
  app.get('/islands/:id', islands.getIslandById);
};
