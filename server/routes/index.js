module.exports = app => {
  require('./user.routes')(app);
  require('./profile.routes')(app);
  require('./weather.routes')(app);
  require('./islands.routes')(app);
  require('./vessels.routes')(app);
  require('./player-location.routes')(app);
  require('./music.routes')(app);
};
