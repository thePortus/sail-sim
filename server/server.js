// call app core logic
const http = require('http');
const app  = require('./app.js');
const { attachMultiplayer } = require('./multiplayer.js');

// start webserver
const PORT   = process.env.WEB_PORT || 8080;
const server = http.createServer(app);

attachMultiplayer(server);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});