const express = require('express');
const { getLiveBets, validateSession, PikkitError } = require('./pikkit');
const { getSimplifiedScoreboards } = require('./scores');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => res.json({ ok: true }));

function authorized(req) {
  return Boolean(process.env.SERVICE_TOKEN) && req.query.token === process.env.SERVICE_TOKEN;
}

// GET /live-summary?token=YOUR_SERVICE_TOKEN
//
// On-demand, no caching, no schedule. Calls Pikkit's JSON API for whatever
// bets are currently live or open, and pairs them with simplified live
// scoreboards for the major US leagues.
//
// Typically ~1-2s (it's two sets of plain HTTP calls -- there is no browser
// involved; see pikkit.js for why the original scraping approach was dropped).
app.get(['/', '/live-summary'], async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const [live, scoreboards] = await Promise.all([
      getLiveBets(process.env.PIKKIT_SESSION_ID),
      getSimplifiedScoreboards(),
    ]);

    res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      liveBetCount: live.count,
      liveBets: live.bets,
      liveBetsText: live.summary,
      scoreboards,
    });
  } catch (e) {
    const isPikkit = e instanceof PikkitError;
    res.status(isPikkit && e.sessionExpired ? 401 : 502).json({
      ok: false,
      error: e.message,
      sessionExpired: isPikkit ? e.sessionExpired : false,
    });
  }
});

// GET /whoami?token=... -- cheap way to check the Pikkit session is still
// valid without pulling bets or scoreboards.
app.get('/whoami', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    res.json({ ok: true, user: await validateSession(process.env.PIKKIT_SESSION_ID) });
  } catch (e) {
    res.status(e instanceof PikkitError && e.sessionExpired ? 401 : 502).json({
      ok: false,
      error: e.message,
      sessionExpired: e instanceof PikkitError ? e.sessionExpired : false,
    });
  }
});

app.listen(PORT, () => {
  console.log(`pikkit-live-service listening on port ${PORT}`);
});
