const express = require('express');
const { getLiveBets, getSettledBets, validateSession, PikkitError } = require('./pikkit');
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
    const [live, settled, rawBoards] = await Promise.all([
      getLiveBets(process.env.PIKKIT_SESSION_ID),
      getSettledBets(process.env.PIKKIT_SESSION_ID),
      getSimplifiedScoreboards(),
    ]);

    // "Settled today" in the bettor's timezone (US Eastern). Pikkit provides
    // no settle timestamp at all, so this uses the placement time recovered
    // from the bet's ObjectId: a settled bet that was PLACED today settled
    // today. Known edge: a bet placed before midnight that settles after
    // won't appear the next day.
    const nyDate = (d) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
    const now = new Date();
    const today = nyDate(now);
    // Between midnight and 5am Eastern, yesterday's slate is still "tonight":
    // include bets from yesterday too, so late West Coast finishes don't
    // vanish at 12:01am.
    const nyHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now)
    );
    const windowDates = new Set([today]);
    if (nyHour < 5) windowDates.add(nyDate(new Date(now.getTime() - 24 * 3600 * 1000)));
    const anyDates = settled.bets.some((b) => b.placedAt && !isNaN(new Date(b.placedAt)));
    const settledToday = anyDates
      ? settled.bets.filter(
          (b) => b.placedAt && !isNaN(new Date(b.placedAt)) && windowDates.has(nyDate(new Date(b.placedAt)))
        )
      : settled.bets;

    // format=text: plain English, one short paragraph per bet. The wager,
    // then where its game stands. Ordered by start time; parlays always
    // last. Today's settled results are mixed in alongside the open bets.
    if (req.query.format === 'text') {
      // Guard against relic games: ESPN boards can serve years-old entries
      // (the CFL board's only game was the 2022 Grey Cup), and matching a
      // current bet to one would report a phantom result.
      const STALE_MS = 3 * 24 * 3600 * 1000;
      const games = [];
      for (const arr of Object.values(rawBoards)) {
        for (const g of arr) {
          if (!g.abbrevs || g.abbrevs.length !== 2) continue;
          const t = g.start ? Date.parse(g.start) : NaN;
          if (!isNaN(t) && Date.now() - t > STALE_MS) continue;
          games.push(g);
        }
      }

      // Pikkit and ESPN disagree on a handful of team abbreviations
      // (Pikkit's WAS is ESPN's WSH, etc.). Normalize both sides to one
      // spelling before comparing.
      const CANON = {
        WAS: 'WSH', // Washington Nationals
        AZ: 'ARI', // Arizona Diamondbacks
        CWS: 'CHW', // White Sox
        SFG: 'SF',
        TBR: 'TB',
        KCR: 'KC',
        SDP: 'SD',
        OAK: 'ATH', // Athletics
        WIN: 'WPG', // Winnipeg Jets
      };
      const canon = (a) => CANON[a] || a;

      // A leg's context looks like "STL - CIN"; require BOTH team
      // abbreviations to match one game so nothing is matched by accident.
      // If that fails and exactly ONE game involves the picked team, use it
      // -- unambiguous, and it covers any alias the table above missed.
      const findGame = (pick) => {
        const tokens = `${pick.context || ''} ${pick.name || ''}`
          .toUpperCase()
          .split(/[^A-Z0-9+.]+/)
          .filter((t) => t.length >= 2 && t.length <= 12)
          .map(canon);
        const strict = games.find((g) => g.abbrevs.every((a) => tokens.includes(canon(a))));
        if (strict) return strict;
        // Fallback: a pick that names the team outright ("Winnipeg Blue
        // Bombers") instead of by abbreviation. Match on abbreviation or on
        // a distinctive word of the team name; accept only if exactly one
        // game qualifies, so ambiguity never guesses.
        const nameHit = (t) =>
          tokens.includes(canon(t.abbr)) ||
          t.name
            .toUpperCase()
            .split(/[^A-Z0-9]+/)
            .some((w) => w.length > 3 && tokens.includes(w));
        const partial = games.filter((g) => nameHit(g.away) || nameHit(g.home));
        return partial.length === 1 ? partial[0] : null;
      };

      const fmt = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

      // "Top 3rd, 2 outs" -> "with 2 outs in the top of the 3rd"
      // "Bot 4th"         -> "in the bottom of the 4th"
      // non-baseball ("Q3 8:41") -> "(Q3 8:41)" -- never invented.
      const situationPhrase = (detail) => {
        const m = /^(Top|Bot|Bottom|Mid|End)\s+(\d+\w{2})(?:,\s*(\d+)\s*outs?)?$/i.exec(detail || '');
        if (!m) return detail ? `(${detail})` : '';
        const half = { top: 'top', bot: 'bottom', bottom: 'bottom', mid: 'middle', end: 'end' }[m[1].toLowerCase()];
        const inning = m[2];
        if (half === 'middle' || half === 'end' || m[3] == null) return `in the ${half} of the ${inning}`;
        const outs = Number(m[3]);
        const outsTxt = outs === 0 ? 'nobody out' : outs === 1 ? '1 out' : `${outs} outs`;
        return `with ${outsTxt} in the ${half} of the ${inning}`;
      };

      // Which side of the matched game did this pick take? ("SF · Moneyline"
      // -> away/home index; "CHI +1.5 · Spread" keeps "+1.5" as a modifier;
      // "Over 8.5 · Total" has no side.)
      const pickSide = (pick, g) => {
        if (!g) return null;
        const teamPart = String(pick.name || '').split('\u00b7')[0].trim();
        const words = teamPart.split(/\s+/);
        // The numeric bit of a spread ("CHI +1.5") is the modifier; every
        // other word may be part of the team's name or abbreviation.
        const modifier = words.filter((w) => /^[+-]?\d/.test(w)).join(' ');
        const nameWords = words.filter((w) => !/^[+-]?\d/.test(w)).map((w) => canon(w.toUpperCase()));
        const overlap = (t) => {
          const target = new Set([
            canon(t.abbr),
            ...t.name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean),
          ]);
          return nameWords.filter((w) => target.has(w)).length;
        };
        const a = overlap(g.away);
        const h = overlap(g.home);
        if (a > h) return { idx: 0, modifier };
        if (h > a) return { idx: 1, modifier };
        return null;
      };

      const teamStatus = (subject, preSubject, g, idx) => {
        const mine = idx === 0 ? g.away : g.home;
        const opp = idx === 0 ? g.home : g.away;
        if (g.state === 'pre') return `${preSubject} game against the ${opp.name} hasn't started yet.`;
        const scores = `${mine.score}-${opp.score}`;
        const ms = Number(mine.score);
        const os = Number(opp.score);
        if (g.state === 'post') {
          if (ms > os) return `${subject} beat the ${opp.name} ${scores}.`;
          if (ms < os) return `${subject} lost to the ${opp.name} ${scores}.`;
          return `${subject} tied the ${opp.name} ${scores}.`;
        }
        const phrase = situationPhrase(g.detail);
        const tail = phrase ? ` ${phrase}` : '';
        if (ms > os) return `${subject} are beating the ${opp.name} ${scores}${tail}.`;
        if (ms < os) return `${subject} are losing to the ${opp.name} ${scores}${tail}.`;
        return `${subject} are tied with the ${opp.name} ${scores}${tail}.`;
      };

      const gameStatus = (g) => {
        if (g.state === 'pre') return `That game hasn't started yet.`;
        const scores = `${g.away.name} ${g.away.score}, ${g.home.name} ${g.home.score}`;
        if (g.state === 'post') return `Final score: ${scores}.`;
        const phrase = situationPhrase(g.detail);
        return `The score is ${scores}${phrase ? ` ${phrase}` : ''}.`;
      };

      const settleFallback = (bet) => {
        if (bet.status === 'SETTLED_WIN')
          return `That bet won${typeof bet.toWin === 'number' ? ` ${fmt(Math.abs(bet.toWin))}` : ''}.`;
        if (bet.status === 'SETTLED_LOSS') return 'That bet lost.';
        if (bet.status === 'SETTLED_PUSH') return 'That bet pushed -- stake returned.';
        if (bet.status === 'SETTLED_VOID') return 'That bet was voided -- stake returned.';
        return "I can't find a score for that game.";
      };

      const betParagraph = (bet) => {
        const head = `You bet ${fmt(bet.stake ?? 0)}${bet.payout != null ? ` to win ${fmt(bet.payout)}` : ''}`;
        if (bet.type !== 'parlay') {
          const p = bet.picks[0] || { name: 'unknown pick' };
          const g = findGame(p);
          const side = g && pickSide(p, g);
          if (side) {
            const mine = side.idx === 0 ? g.away : g.home;
            const onWhat = `the ${mine.name}${side.modifier ? ` ${side.modifier}` : ''}`;
            return `${head} on ${onWhat}. ${teamStatus('They', 'Their', g, side.idx)}`;
          }
          if (g) return `${head} on ${p.name} in ${g.away.name} at ${g.home.name}. ${gameStatus(g)}`;
          return `${head} on ${p.name}. ${settleFallback(bet)}`;
        }
        const lines = [`${head} on a ${bet.picks.length}-leg parlay:`];
        for (const p of bet.picks) {
          const g = findGame(p);
          const side = g && pickSide(p, g);
          if (side) {
            const mine = side.idx === 0 ? g.away : g.home;
            const subject = `The ${mine.name}${side.modifier ? ` (${side.modifier})` : ''}`;
            lines.push(teamStatus(subject, subject, g, side.idx));
          } else if (g) {
            lines.push(`${p.name}: ${gameStatus(g)}`);
          } else {
            lines.push(`${p.name}: no score available.`);
          }
        }
        return lines.join('\n');
      };

      const LAST = Number.MAX_SAFE_INTEGER;
      const startTime = (bet) => {
        let min = LAST;
        for (const p of bet.picks) {
          const g = findGame(p);
          const t = g && g.start ? Date.parse(g.start) : NaN;
          if (!isNaN(t)) min = Math.min(min, t);
        }
        return min;
      };

      // Identical tickets (same picks, same open/settled outcome) combine
      // into one line with stakes and payouts summed -- the same bet placed
      // at two books, or repeated, reads as a single position.
      // Books spell the same pick differently ("Winnipeg Blue Bombers" vs
      // "WPG Blue Bombers"), so merge on the matched game, side and market
      // -- falling back to normalized text only when no game matched.
      const pickKey = (pk) => {
        const g = findGame(pk);
        const market = String(pk.name || '').split('\u00b7').slice(1).join(' ').trim().toUpperCase();
        if (g) {
          const side = pickSide(pk, g);
          return `${g.away.abbr}@${g.home.abbr}|${side ? side.idx : '?'}${side && side.modifier ? `|${side.modifier}` : ''}|${market}`;
        }
        // No game matched: merge on the team's nickname (books agree on
        // "Bombers" even when they disagree on "Winnipeg" vs "WPG"), the
        // spread/total number if any, and the market.
        const teamPart = String(pk.name || '').split('\u00b7')[0].trim();
        const rawWords = teamPart.split(/\s+/);
        const nums = rawWords.filter((w) => /^[+-]?\d/.test(w)).join(' ');
        const nameWords = rawWords.filter((w) => !/^[+-]?\d/.test(w));
        const nick = nameWords.length ? canon(nameWords[nameWords.length - 1].toUpperCase()) : '';
        return `${nick}${nums ? `|${nums}` : ''}|${market}`;
      };
      const merged = new Map();
      for (const b of [...live.bets, ...settledToday]) {
        const key = JSON.stringify([
          b.type,
          String(b.status).startsWith('SETTLED') ? b.status : 'OPEN',
          b.picks.map(pickKey),
        ]);
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, { ...b });
          continue;
        }
        prev.stake = (prev.stake ?? 0) + (b.stake ?? 0);
        prev.payout =
          prev.payout != null || b.payout != null ? (prev.payout ?? 0) + (b.payout ?? 0) : null;
        prev.toWin =
          prev.toWin != null || b.toWin != null ? (prev.toWin ?? 0) + (b.toWin ?? 0) : null;
      }
      const all = [...merged.values()];
      const straights = all.filter((b) => b.type !== 'parlay');
      const parlays = all.filter((b) => b.type === 'parlay');
      for (const group of [straights, parlays]) {
        const keyed = group.map((b) => [startTime(b), b]);
        keyed.sort((a, b) => a[0] - b[0]);
        group.length = 0;
        group.push(...keyed.map(([, b]) => b));
      }

      const paragraphs = [...straights, ...parlays].map(betParagraph);
      return res
        .type('text/plain')
        .send(paragraphs.length ? paragraphs.join('\n\n') : 'No bets today.');
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
      settledTodayCount: settledToday.length,
      settledToday,
      settledDatesAvailable: anyDates,
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

    // Full key list plus any date-looking values from one settled bet, to
    // pin down which field carries the settle timestamp.
    const sample = arr.find((b) => b && typeof b === 'object' && String(b.status).startsWith('SETTLED'));
    const sampleBetFields = sample
      ? {
          keys: Object.keys(sample),
          dateLike: Object.fromEntries(
            Object.entries(sample).filter(
              ([, v]) =>
                (typeof v === 'string' && /\d{4}-\d{2}-\d{2}|\d{10,}/.test(v)) ||
                (typeof v === 'number' && v > 1e12)
            )
          ),
        }
      : null;

    // What does each ESPN board actually hold right now? Line counts per
    // league, plus the CFL lines in full -- for debugging match failures.
    let boards = null;
    try {
      const raw = await require('./scores').getSimplifiedScoreboards();
      boards = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, k === 'cfl' ? v : v.length])
      );
    } catch (e) {
      boards = { error: e.message };
    }

    res.json({ ok: true, statusCounts, bets, sampleBetFields, boards, availableFilters: filters });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`pikkit-live-service listening on port ${PORT}`);
});
