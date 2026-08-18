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
    const [live, rawBoards] = await Promise.all([
      getLiveBets(process.env.PIKKIT_SESSION_ID),
      getSimplifiedScoreboards(),
    ]);

    // format=text: a compact human-readable digest -- open/live bets plus
    // ONLY the games in progress right now (a phone's text-to-speech reading
    // 50 scheduled college games is useless).
    if (req.query.format === 'text') {
      const inProgress = [];
      for (const [league, games] of Object.entries(rawBoards)) {
        for (const g of games) {
          if (g.state === 'in') inProgress.push(`${league.toUpperCase()}: ${g.line}`);
        }
      }
      const parts = [
        `YOUR BETS (${live.count} open/live):`,
        live.summary,
        '',
        inProgress.length ? 'GAMES IN PROGRESS:' : 'No games in progress right now.',
        ...inProgress,
      ];
      return res.type('text/plain').send(parts.join('\n'));
    }

    const scoreboards = {};
    for (const [league, games] of Object.entries(rawBoards)) {
      scoreboards[league] = games.map((g) => g.line);
    }

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

// TEMPORARY diagnostic: what statuses do this account's recent bets actually
// carry? Pulls bets with NO status filter and reports just status fields --
// no stakes or bet details. Remove once the live/open filter is confirmed.
app.get('/diag-statuses', async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const sessionId = process.env.PIKKIT_SESSION_ID;
    const headers = { Authorization: sessionId, Accept: 'application/json' };
    const base = 'https://prod-website.pikkit.app';

    const [betsResp, filtersResp] = await Promise.all([
      fetch(`${base}/user/bets?offset=0&limit=30`, { headers }),
      fetch(`${base}/user/bets/filters`, { headers }),
    ]);
    const rawBets = betsResp.ok ? await betsResp.json() : `HTTP ${betsResp.status}`;
    const filters = filtersResp.ok ? await filtersResp.json() : `HTTP ${filtersResp.status}`;

    const arr = Array.isArray(rawBets) ? rawBets : Object.values(rawBets || {});
    const bets = arr
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        status: b.status,
        type: b.type,
        is_live: b.is_live,
        future: b.future,
        firstPick: Array.isArray(b.picks) && b.picks[0] ? b.picks[0].pick_name : null,
      }));
    const statusCounts = {};
    for (const b of bets) statusCounts[b.status] = (statusCounts[b.status] || 0) + 1;

    res.json({ ok: true, statusCounts, bets, availableFilters: filters });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`pikkit-live-service listening on port ${PORT}`);
});
