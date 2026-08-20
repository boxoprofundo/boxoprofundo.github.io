/**
 * Pikkit API client.
 *
 * REPLACES the old Playwright-based scraper.js. Here's why, so nobody
 * rebuilds the old approach:
 *
 * Pikkit has NO email/password login. Authentication is phone number ->
 * SMS/2FA code, and the phone-number step is gated by Cloudflare Turnstile
 * (site key is in the web app's config; the login screen literally reads
 * "Enter your 2FA Code"). Headless password login was never going to work,
 * because there is no password to submit.
 *
 * What the web app actually does is far simpler than scraping: it calls a
 * plain JSON API at prod-website.pikkit.app, authenticating with the value
 * of its `session_id` cookie sent as a raw `Authorization` header (no
 * "Bearer " prefix). So this service does exactly the same thing.
 *
 * That means: no browser, no Chromium, no CAPTCHA, no selectors to break
 * when Pikkit reskins a component. A call takes ~1s instead of ~20s.
 *
 * The tradeoffs, honestly stated:
 *   - This is an internal API, not a documented public one. Pikkit can
 *     change it without notice.
 *   - PIKKIT_SESSION_ID is a real session credential. Treat it like a
 *     password: env var only, never committed.
 *   - Sessions expire. When that happens every call returns a clean 401
 *     with `sessionExpired: true` rather than failing mysteriously; grab a
 *     fresh session_id cookie from a logged-in browser and update the var.
 */

const API_BASE = 'https://prod-website.pikkit.app';

// Verified against the live API: the "bet_statuses" filter is a
// comma-separated list, and these two values are what "currently running"
// means in Pikkit's own vocabulary (from GET /user/bets/filters):
//   live   -> in-play right now
//   PLACED -> open/unsettled, game not started or not yet graded
// Note: the `is_live` field on a bet means "was placed while in-play", NOT
// "is live now" -- do not filter on it.
const LIVE_STATUSES = 'live,PLACED';
const SETTLED_STATUSES = 'SETTLED_WIN,SETTLED_LOSS,SETTLED_PUSH,SETTLED_VOID';

class PikkitError extends Error {
  constructor(message, { status = null, sessionExpired = false } = {}) {
    super(message);
    this.name = 'PikkitError';
    this.status = status;
    this.sessionExpired = sessionExpired;
  }
}

async function apiGet(path, sessionId, { timeoutMs = 15000 } = {}) {
  if (!sessionId) {
    throw new PikkitError('PIKKIT_SESSION_ID is not set.', { sessionExpired: true });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: sessionId,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (e) {
    throw new PikkitError(
      `Request to ${path} failed: ${e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');

    // Pikkit does NOT return 401/403 for a bad session -- verified by calling
    // it with a junk session_id, which produces a bare HTTP 500
    // {"message":"Internal Server Error"}. So status code alone cannot tell
    // "your session died" apart from "Pikkit is having a bad day", and naive
    // 401-checking would report every expired session as a server fault.
    //
    // Resolve it by probing /login/validate, which is the one endpoint whose
    // meaning is unambiguous: it succeeds iff the session is good. Only done
    // on the error path, so the happy path stays a single request.
    const expired = await sessionLooksDead(path, sessionId);

    throw new PikkitError(
      expired
        ? `Pikkit rejected the session (HTTP ${resp.status} on ${path}). The session_id has expired or been invalidated -- log in to app.pikkit.com, copy the fresh \`session_id\` cookie, and update PIKKIT_SESSION_ID.`
        : `Pikkit API ${path} returned HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      { status: resp.status, sessionExpired: expired }
    );
  }

  return resp.json();
}

/**
 * Is this failure the session's fault? Returns true if /login/validate also
 * fails, false if it still works (so the session is fine and the original
 * endpoint is genuinely broken). Never throws -- on any doubt returns true,
 * because "re-copy your cookie" is the cheap, safe thing to tell someone.
 */
async function sessionLooksDead(originalPath, sessionId) {
  if (originalPath.startsWith('/login/validate')) return true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const probe = await fetch(`${API_BASE}/login/validate`, {
        headers: { Authorization: sessionId, Accept: 'application/json' },
        signal: controller.signal,
      });
      return !probe.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return true;
  }
}

/** Decimal odds -> American, the way Mike's account displays them. */
function toAmerican(decimal) {
  if (typeof decimal !== 'number' || !isFinite(decimal) || decimal <= 1) return null;
  const american = decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
  return american > 0 ? `+${american}` : `${american}`;
}

/**
 * Pikkit renders bet context as an array of typed fragments
 * ({type:'string'|'image', value, color}). Flatten to the readable text.
 */
function flattenContext(fragments) {
  if (!Array.isArray(fragments)) return '';
  // Image fragments become a space rather than being dropped outright: they
  // sit between text fragments as team logos, so deleting them outright
  // welds the neighbours together ("DET8 - 5PIT" instead of "DET 8 - 5 PIT").
  return fragments
    .filter((f) => f && (f.type === 'string' || f.type === 'image'))
    .map((f) => (f.type === 'image' ? ' ' : typeof f.value === 'string' ? f.value : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** MongoDB ObjectIds embed their creation time in the first 4 bytes. */
function objectIdTime(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id)) return null;
  return new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString();
}

function money(n) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Trim a raw bet down to the fields that actually matter downstream. */
function simplifyBet(bet) {
  const picks = Array.isArray(bet.picks) ? bet.picks : [];
  return {
    id: bet._id,
    type: bet.type,
    status: bet.status,
    placedLive: !!bet.is_live,
    isFuture: !!bet.future,
    stake: bet.amount,
    // Pikkit only fills profit in after settling. For open bets, compute the
    // potential win from the decimal odds: stake * (odds - 1).
    toWin:
      typeof bet.profit === 'number'
        ? bet.profit
        : typeof bet.amount === 'number' && typeof bet.odds === 'number' && bet.odds > 1
          ? Math.round(bet.amount * (bet.odds - 1) * 100) / 100
          : null,
    oddsDecimal: bet.odds,
    oddsAmerican: toAmerican(bet.odds),
    // Total returned if the bet cashes: stake back plus the profit.
    payout:
      typeof bet.amount === 'number' && typeof bet.odds === 'number' && bet.odds > 1
        ? Math.round(bet.amount * bet.odds * 100) / 100
        : null,
    // Pikkit's bet objects carry NO explicit timestamps (confirmed against
    // production: no date-like field exists on a settled bet). But _id is a
    // MongoDB ObjectId, whose first 4 bytes are the creation time -- i.e.
    // when the bet was placed/synced. That's the only date signal available.
    placedAt: objectIdTime(bet._id),
    settledAt: null,
    tags: Array.isArray(bet.user_tags) ? bet.user_tags.map((t) => t.display_value || t.hash || t) : [],
    picks: picks.map((p) => ({
      name: p.pick_name,
      status: p.status,
      oddsAmerican: toAmerican(p.odds),
      context: flattenContext(p.short_pick_context),
    })),
  };
}

/** One dense, readable line per bet -- cheap for a human or an LLM to scan. */
function summarizeBet(bet) {
  const head = [
    bet.type === 'parlay' ? `${bet.picks.length}-leg parlay` : 'straight',
    bet.oddsAmerican || (bet.oddsDecimal != null ? `${bet.oddsDecimal}d` : null),
    bet.stake != null
      ? `${money(bet.stake)}${bet.toWin != null ? ` to win ${money(bet.toWin)}` : ''}`
      : null,
    bet.status,
    bet.placedLive ? '(placed live)' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const legs = bet.picks.map((p) => {
    const bits = [p.name, p.oddsAmerican, p.status, p.context].filter(Boolean);
    return `    - ${bits.join(' | ')}`;
  });

  return [head, ...legs].join('\n');
}

/** GET /login/validate -- confirms the session and returns the profile. */
async function validateSession(sessionId) {
  const user = await apiGet('/login/validate', sessionId);
  return {
    id: user._id,
    username: user.username,
    name: user.name,
    balance: user.balance,
  };
}

/**
 * The whole point of the service: what is running right now.
 * Returns { bets, summary, count } -- an empty list is a valid, correct
 * answer, not an error.
 */
// One request PER status, merged client-side. The comma-list form
// (bet_statuses=live,PLACED) silently matches ZERO bets -- found in
// production against an account that verifiably had 7 PLACED bets open.
// Single-status queries are the only form actually proven to work.
async function fetchByStatuses(sessionId, statuses, limit) {
  const perStatus = await Promise.all(
    statuses.split(',').map(async (status) => {
      const query = `bet_statuses=${status}&offset=0&limit=${encodeURIComponent(limit)}`;
      const raw = await apiGet(`/user/bets?${query}`, sessionId);
      return Array.isArray(raw) ? raw : Object.values(raw || {});
    })
  );
  const seen = new Set();
  return perStatus
    .flat()
    .filter((b) => b && typeof b === 'object')
    .filter((b) => {
      const id = b._id || JSON.stringify(b);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map(simplifyBet);
}

async function getLiveBets(sessionId, { limit = 100 } = {}) {
  const bets = await fetchByStatuses(sessionId, LIVE_STATUSES, limit);
  return {
    count: bets.length,
    bets,
    summary: bets.length
      ? bets.map(summarizeBet).join('\n')
      : 'No live or open bets right now.',
  };
}

/** Most recently settled bets (won/lost/push/void), newest first as Pikkit
 * returns them. Date filtering ("settled today") happens downstream, where
 * the caller knows the user's timezone. */
async function getSettledBets(sessionId, { limit = 15 } = {}) {
  const bets = await fetchByStatuses(sessionId, SETTLED_STATUSES, limit);
  return { count: bets.length, bets };
}

module.exports = {
  API_BASE,
  LIVE_STATUSES,
  SETTLED_STATUSES,
  PikkitError,
  getLiveBets,
  getSettledBets,
  summarizeBet,
  validateSession,
  toAmerican,
};
