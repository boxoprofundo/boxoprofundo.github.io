/*
 * Server-side price collector, run on a schedule by GitHub Actions
 * (.github/workflows/update-listings.yml). Because it runs on GitHub's
 * servers rather than in a visitor's browser, it isn't subject to CORS.
 *
 * It fetches the remaining Yankees home schedule plus Ticketmaster and
 * SeatGeek prices (when the corresponding repo secrets are configured) and
 * writes yankees-tickets/data/listings.json, which the web app merges into
 * its results so every visitor sees live prices with zero setup.
 *
 * Env: TICKETMASTER_API_KEY, SEATGEEK_CLIENT_ID (both optional).
 */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TEAM_ID = 147;
const YANKEE_STADIUM = /yankee stadium/i;

const etDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
});

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("?")[0]}`);
  return res.json();
}

export async function fetchGames() {
  const today = etDate.format(new Date());
  const year = new Date().getFullYear();
  const data = await getJSON(
    "https://statsapi.mlb.com/api/v1/schedule?sportId=1" +
      `&teamId=${TEAM_ID}&startDate=${today}&endDate=${year}-11-15` +
      "&gameTypes=R,F,D,L,W"
  );
  const games = [];
  for (const day of data.dates ?? []) {
    for (const g of day.games ?? []) {
      if (g.teams.home.team.id !== TEAM_ID) continue;
      if (g.status.abstractGameState === "Final") continue;
      const dateUTC = new Date(g.gameDate);
      if (dateUTC.getTime() < Date.now() - 4 * 3600 * 1000) continue;
      games.push({
        gamePk: g.gamePk,
        dateUTC,
        opponent: g.teams.away.team.name,
        isoDateET: etDate.format(dateUTC),
      });
    }
  }
  return games;
}

export async function ticketmasterQuotes(games, apiKey) {
  if (!apiKey || !games.length) return [];
  const last = games[games.length - 1];
  const end = new Date(last.dateUTC.getTime() + 12 * 3600 * 1000);
  const params = new URLSearchParams({
    apikey: apiKey,
    keyword: "New York Yankees",
    classificationName: "Baseball",
    size: "199",
    sort: "date,asc",
    startDateTime: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    endDateTime: end.toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  const data = await getJSON(
    "https://app.ticketmaster.com/discovery/v2/events.json?" + params
  );
  const events = data._embedded?.events ?? [];
  const quotes = [];
  for (const g of games) {
    const ev = events.find((e) => {
      const venue = e._embedded?.venues?.[0];
      if (!venue || !YANKEE_STADIUM.test(venue.name ?? "")) return false;
      if (/parking/i.test(e.name ?? "")) return false;
      return e.dates?.start?.localDate === g.isoDateET;
    });
    if (!ev) continue;
    const std =
      (ev.priceRanges ?? []).find((p) => p.type === "standard") ??
      (ev.priceRanges ?? [])[0];
    quotes.push({
      gamePk: g.gamePk,
      provider: "Ticketmaster",
      section: null,
      price: std ? money(std.min) : null,
      faceValue: std ? money(std.min) : null,
      url: ev.url ?? null,
    });
  }
  return quotes;
}

export async function seatgeekQuotes(games, clientId) {
  if (!clientId || !games.length) return [];
  const params = new URLSearchParams({
    client_id: clientId,
    per_page: "100",
    sort: "datetime_utc.asc",
    "datetime_utc.gte": new Date().toISOString().slice(0, 19),
  });
  params.append("performers[home_team].slug", "new-york-yankees");
  const data = await getJSON("https://api.seatgeek.com/2/events?" + params);
  const events = data.events ?? [];
  const quotes = [];
  for (const g of games) {
    const ev = events.find(
      (e) =>
        Math.abs(Date.parse(e.datetime_utc + "Z") - g.dateUTC.getTime()) <
        6 * 3600 * 1000
    );
    if (!ev) continue;
    quotes.push({
      gamePk: g.gamePk,
      provider: "SeatGeek",
      section: null,
      price: money(ev.stats?.lowest_price),
      faceValue: null,
      url: ev.url ?? null,
    });
  }
  return quotes;
}

export async function run(env = process.env) {
  const games = await fetchGames();
  console.log(`Remaining home games: ${games.length}`);

  const results = await Promise.allSettled([
    ticketmasterQuotes(games, env.TICKETMASTER_API_KEY),
    seatgeekQuotes(games, env.SEATGEEK_CLIENT_ID),
  ]);
  const quotes = [];
  for (const r of results) {
    if (r.status === "fulfilled") quotes.push(...r.value.filter((q) => q.price != null));
    else console.error("Source failed:", r.reason?.message ?? r.reason);
  }
  console.log(`Priced quotes collected: ${quotes.length}`);

  if (!quotes.length) {
    console.log(
      "Nothing to write (no API secrets configured, or no prices returned). " +
        "Add TICKETMASTER_API_KEY / SEATGEEK_CLIENT_ID repo secrets to enable."
    );
    return null;
  }

  const out = { fetchedAt: new Date().toISOString(), quotes };
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "yankees-tickets", "data"
  );
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "listings.json");
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  console.log("Wrote", file);
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
