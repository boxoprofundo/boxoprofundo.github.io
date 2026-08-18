/**
 * Fast local check, no deploy needed.
 *
 *   export PIKKIT_SESSION_ID=...      # the `session_id` cookie from a
 *                                     # logged-in app.pikkit.com browser tab
 *   node local-debug.js
 *
 * Prints who the session belongs to, then whatever bets are live/open.
 * An empty list is a correct result, not a failure -- it just means nothing
 * is running right now.
 */

const { getLiveBets, validateSession, PikkitError } = require('./pikkit');
const { getSimplifiedScoreboards } = require('./scores');

(async () => {
  const sessionId = process.env.PIKKIT_SESSION_ID;
  if (!sessionId) {
    console.error('PIKKIT_SESSION_ID is not set.\n');
    console.error('Get it from a logged-in app.pikkit.com tab:');
    console.error('  DevTools -> Application -> Cookies -> app.pikkit.com -> session_id');
    process.exit(1);
  }

  try {
    const user = await validateSession(sessionId);
    console.log(`session OK -> ${user.name} (@${user.username}), balance $${user.balance}\n`);
  } catch (e) {
    console.error('session check FAILED:', e.message);
    process.exit(1);
  }

  try {
    const live = await getLiveBets(sessionId);
    console.log(`=== LIVE / OPEN BETS (${live.count}) ===`);
    console.log(live.summary);
  } catch (e) {
    console.error('live bets FAILED:', e.message);
    if (e instanceof PikkitError && e.sessionExpired) {
      console.error('-> grab a fresh session_id cookie and retry.');
    }
    process.exit(1);
  }

  if (process.env.SCORES) {
    const boards = await getSimplifiedScoreboards();
    console.log('\n=== SCOREBOARDS ===');
    for (const [league, lines] of Object.entries(boards)) {
      console.log(`${league}: ${lines.length} line(s)`);
      lines.slice(0, 3).forEach((l) => console.log(`  ${l}`));
    }
  }
})();
