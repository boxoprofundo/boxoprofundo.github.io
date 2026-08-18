/**
 * Pulls current scoreboards for the major leagues from ESPN's public
 * (unofficial, no-key-required) scoreboard endpoints, and simplifies each
 * game down to one readable line. Keeping this compact matters: the
 * consumer of this service's output is an LLM reading it through a
 * content-summarizing fetch tool, so a smaller, denser payload is less
 * likely to get mangled or truncated than raw ESPN JSON (which is huge).
 */

const LEAGUES = [
  { key: 'nfl', url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' },
  { key: 'nba', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard' },
  { key: 'mlb', url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard' },
  { key: 'nhl', url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard' },
  { key: 'ncaaf', url: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard' },
  { key: 'ncaab', url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard' },
];

function simplifyEvent(ev) {
  const comp = ev.competitions && ev.competitions[0];
  const competitors = (comp && comp.competitors) || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');
  const status =
    (comp && comp.status && comp.status.type && comp.status.type.shortDetail) ||
    (ev.status && ev.status.type && ev.status.type.shortDetail) ||
    'unknown status';
  const awayName = (away && away.team && away.team.displayName) || '?';
  const homeName = (home && home.team && home.team.displayName) || '?';
  const awayScore = away && away.score != null ? away.score : '-';
  const homeScore = home && home.score != null ? home.score : '-';
  return `${awayName} ${awayScore} @ ${homeName} ${homeScore} — ${status}`;
}

async function fetchLeague(league) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(league.url, { signal: controller.signal });
    if (!resp.ok) {
      return [`error fetching ${league.key}: HTTP ${resp.status}`];
    }
    const data = await resp.json();
    const events = data.events || [];
    if (events.length === 0) return ['no games currently scheduled/live'];
    return events.map(simplifyEvent);
  } catch (e) {
    return [`error fetching ${league.key}: ${e.message}`];
  } finally {
    clearTimeout(timeout);
  }
}

async function getSimplifiedScoreboards() {
  const entries = await Promise.all(
    LEAGUES.map(async (league) => [league.key, await fetchLeague(league)])
  );
  return Object.fromEntries(entries);
}

module.exports = { getSimplifiedScoreboards };
