# Yankees Ticket Finder

A static web app (served by GitHub Pages at `/yankees-tickets/`) that takes a
ticket quantity and finds, for each section of Yankee Stadium, the cheapest
block of that size across **every remaining Yankees home game**, comparing
Ticketmaster, SeatGeek, StubHub, XP, Vivid Seats and TickPick.

## How it works

1. **Schedule** — every remaining home game (date, time, opponent) comes from
   the free, keyless MLB Stats API (`statsapi.mlb.com`), which allows
   cross-origin browser requests. This always works, no setup needed.
2. **Prices** — each marketplace has an adapter in `providers.js`:

   | Marketplace | Live data from the browser? | What you get |
   |---|---|---|
   | Ticketmaster | ✅ with a free [Discovery API key](https://developer.ticketmaster.com/) | Event link + standard price range; the range minimum doubles as the approximate **face value** (Ticketmaster is the Yankees' primary seller) |
   | SeatGeek | ✅ with a free [client ID](https://seatgeek.com/account/develop) | Lowest listed price per game + event link with your quantity pre-applied |
   | StubHub | ❌ | Direct search link for the exact game |
   | XP (xp.tickets) | ❌ | Direct search link for the exact game |
   | Vivid Seats | ❌ | Direct search link for the exact game |
   | TickPick | ❌ | Direct search link for the exact game |

3. **Aggregation** — all quotes are pooled and, for each stadium section, the
   single cheapest per-ticket price (and block total) across all games and
   marketplaces is shown with the game's date/time, opponent, marketplace,
   link and face value. Columns are sortable.

## Why not live per-section prices from all six sites?

GitHub Pages is static hosting — there is no server, so every request runs in
the visitor's browser, and browsers enforce CORS. StubHub, Vivid Seats,
TickPick and XP publish **no public API** and do not allow cross-origin
browser requests to their internal listing endpoints; section-level listing
feeds on all six sites are partner/enterprise APIs. That is a hard platform
constraint, not a missing feature — no purely static page can do it.

**Demo mode** (checkbox next to Search) generates realistic sample listings
for every section so the full aggregation UI can be exercised; demo rows are
clearly labeled.

### Extending to real per-section data

The clean path within this repo is a scheduled GitHub Action that runs
server-side (no CORS), collects listing data into
`yankees-tickets/data/listings.json`, commits it, and lets the page load that
file. Steps:

1. Add a workflow on a cron (e.g. every 6 h) running a Node script.
2. In the script, call whatever sources you have credentials for
   (e.g. Ticketmaster Discovery, SeatGeek, or a licensed listings API) and
   normalize to the `Quote` shape documented at the top of `providers.js`,
   one file per common quantity (1–8).
3. In `app.js`, merge `fetch("data/listings.json")` results into `quotes`
   before rendering — the aggregation and table code needs no changes.

Note that scraping marketplaces that prohibit it in their terms of service is
their call, not the app's; the adapter design keeps that decision (and any
credentials) out of the client entirely.

## Files

- `index.html` — UI shell, settings panel
- `style.css` — styling
- `app.js` — schedule fetch, orchestration, aggregation, rendering
- `providers.js` — one adapter per marketplace (documented `Quote` shape)
- `demo-data.js` — Yankee Stadium section chart + deterministic sample data

API keys are stored in `localStorage` in your browser only; they are never
committed or sent anywhere except to the marketplace that issued them.
