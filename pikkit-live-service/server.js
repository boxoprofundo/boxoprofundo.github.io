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

    // format=text: a bet-first, human-readable digest. Each bet leg is
    // matched to its scoreboard game (by the team abbreviations in the leg's
    // game context) and annotated with the current score and inning/clock,
    // or "hasn't started yet" for scheduled games.
    if (req.query.format === 'text') {
      const games = [];
      for (const arr of Object.values(rawBoards)) {
        for (const g of arr) if (g.abbrevs && g.abbrevs.length === 2) games.push(g);
      }

      // A leg's context looks like "STL - CIN"; require BOTH team
      // abbreviations to match one game so nothing is matched by accident.
      const findGame = (pick) => {
        const tokens = `${pick.context || ''} ${pick.name || ''}`
          .toUpperCase()
          .split(/[^A-Z0-9]+/)
          .filter((t) => t.length >= 2 && t.length <= 5);
        return games.find((g) => g.abbrevs.every((a) => tokens.includes(a))) || null;
      };

      const gameStatus = (pick) => {
        const g = findGame(pick);
        if (!g) return 'no score available for this game';
        if (g.state === 'pre') return `${g.matchup} — Hasn't started yet`;
        return g.line; // in progress (score + inning/clock) or final
      };

      const lines = [];
      if (live.bets.length === 0) {
        lines.push('No live or open bets right now.');
      } else {
        lines.push(`You have ${live.count} open bet${live.count === 1 ? '' : 's'}.`);
        for (const bet of live.bets) {
          lines.push('');
          const head = [
            bet.type === 'parlay' ? `${bet.picks.length}-leg parlay` : 'Straight bet',
            bet.oddsAmerican,
            bet.stake != null
              ? `$${bet.stake}${bet.payout != null ? ` pays $${bet.payout.toFixed(2)}` : ''}`
              : null,
          ]
            .filter(Boolean)
            .join(', ');
          lines.push(`${head}:`);
          for (const p of bet.picks) {
            lines.push(`  ${p.name}: ${gameStatus(p)}`);
          }
        }
      }
      return res.type('text/plain').send(lines.join('\n'));
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
