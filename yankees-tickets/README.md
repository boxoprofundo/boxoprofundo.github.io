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

## When do prices update?

**At search time.** With API keys saved in the app's Settings panel, every
press of Search queries Ticketmaster and SeatGeek live from your browser at
that moment — nothing runs on a schedule.

## Optional: shared cached prices for visitors without keys

A manual-only GitHub Action (`.github/workflows/update-listings.yml`, run
from the repo's Actions tab whenever you like) executes
`scripts/fetch-listings.mjs` on GitHub's servers (server-side, so no CORS),
collects Ticketmaster and SeatGeek prices, and commits them to
`yankees-tickets/data/listings.json`. The app merges that file into every
search, so visitors without keys still see those prices. Live quotes fetched
in the browser always override the cached file.

To enable it, add the API keys as repository secrets — they stay private on
GitHub and never appear in the site's code:

1. Get the free keys: a Ticketmaster "Consumer Key" from
   [developer.ticketmaster.com](https://developer.ticketmaster.com/) and a
   SeatGeek "client ID" from
   [seatgeek.com/account/develop](https://seatgeek.com/account/develop).
2. On GitHub: repo **Settings → Secrets and variables → Actions →
   New repository secret**. Add `TICKETMASTER_API_KEY` and
   `SEATGEEK_CLIENT_ID` with those values.
3. Trigger a run from the **Actions** tab → "Update ticket listings" →
   "Run workflow".

Until secrets are added, the workflow runs harmlessly and writes nothing.

The same mechanism is the extension point for real per-section data: any
source you have credentials for can be normalized in
`scripts/fetch-listings.mjs` to the `Quote` shape documented at the top of
`providers.js` (with `section` filled in), and the aggregation and table code
needs no changes. Scraping marketplaces that prohibit it in their terms of
service is their call, not the app's; this design keeps that decision (and
any credentials) out of the client entirely.

## Files

- `index.html` — UI shell, settings panel
- `style.css` — styling
- `app.js` — schedule fetch, orchestration, aggregation, rendering
- `providers.js` — one adapter per marketplace (documented `Quote` shape)
- `demo-data.js` — Yankee Stadium section chart + deterministic sample data

API keys are stored in `localStorage` in your browser only; they are never
committed or sent anywhere except to the marketplace that issued them.
