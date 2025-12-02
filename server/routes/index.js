const auth = require('./auth');
const session = require('./session');
const subscription = require('./subscription');
const pubkey = require('./pubkey');
const turn = require('./turn');
const debug = require('./debug');

function setupRoutes(app) {
  app.use(auth);
  app.use(session.router);
  app.use(subscription);
  app.use(pubkey);
  app.use(turn);
  app.use(debug);
}

module.exports = setupRoutes;
