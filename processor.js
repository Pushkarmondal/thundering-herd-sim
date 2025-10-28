// processor.js
function pickRandomUser(userContext, events, done) {
  userContext.vars.userId = Math.floor(Math.random() * 100) + 1001;
  return done();
}

module.exports = { pickRandomUser };
