module.exports = app => {
  const music = require('../controllers/music.controller');
  app.get('/music',          music.listTracks);
  app.get('/music/:filename', music.streamTrack);
};
