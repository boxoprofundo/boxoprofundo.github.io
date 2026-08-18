# pikkit-live-service

> **Status: written and locally exercised, but never run against the real
> app.pikkit.com, and not yet deployed.** The environment that was meant to
> deploy and verify this had `app.pikkit.com`, `railway.app`, and
> `site.api.espn.com` blocked by egress policy. See **[DEPLOY.md](DEPLOY.md)**
> for the exact steps to deploy and debug from a machine with real network
> access, and `local-debug.js` for a fast local selector-fixing loop.

An on-demand HTTP service: call it, and it logs into your Pikkit account
with a headless browser, grabs whatever is on your live-bets view, and
pairs it with current live scoreboards for the major US leagues (NFL,
NBA, MLB, NHL, NCAAF, NCAAB) from ESPN's public scoreboard endpoints.

No schedule, no cron, no caching -- it only does anything when you hit
`/live-summary`.

## Why it's built this way

This was written without the ability to actually load app.pikkit.com in a
browser (it's a JavaScript single-page app, and the environment writing
this code had no direct network access to it). So instead of scraping
specific fields with hand-picked CSS selectors -- which would be a guess
and would break silently the moment Pikkit changes a class name -- the
scraper grabs the raw visible text of the page after login and lets
whatever reads the response (an LLM) interpret it. That's much more
resilient to markup changes than brittle selectors would be.

**This means the very first real run is a genuine test.** If login or
navigation doesn't work the way the code guesses, the error response
includes a screenshot (base64 PNG) and the page URL/title at the point of
failure -- that's meant to make it fixable, not to be a finished product
on the first try.

## Setup

1. **Deploy this repo to Railway** (or any host that can run a Node app /
   Dockerfile with enough memory for headless Chromium -- at least 512MB,
   ideally 1GB+).
2. In Railway's dashboard, set these environment variables directly
   there -- do not put real credentials in this repo or in any chat:
   - `PIKKIT_EMAIL` -- your Pikkit login email
   - `PIKKIT_PASSWORD` -- your Pikkit login password
   - `SERVICE_TOKEN` -- a random string you make up (e.g. `openssl rand -hex 24`).
     This just protects the endpoint from strangers; it has nothing to do
     with your Pikkit password.
3. Deploy. Railway will build the Dockerfile, which installs Chromium at
   build time.
4. Test it:

   ```
   curl "https://<your-railway-domain>/live-summary?token=<SERVICE_TOKEN>"
   ```

   Expect this to take 10-25 seconds -- it's doing a real login and page
   load every time, on purpose (no caching).

## If login fails

The JSON error response includes a `debug` object with `url`, `title`,
and `screenshotBase64`. Decode the screenshot
(`echo "<base64>" | base64 -d > debug.png`) to see exactly what the
headless browser saw -- a CAPTCHA, a 2FA prompt, a changed login form,
etc. That's the starting point for fixing `scraper.js`.

Known things that would break this outright:
- **2FA on your Pikkit account** -- automated login can't get past most
  2FA flows.
- **A CAPTCHA on login** -- same issue.
- **Pikkit changing their login page structure** -- the selector
  fallbacks in `scraper.js` try to be flexible, but there's no guarantee.

## Endpoints

- `GET /health` -- basic liveness check, no auth.
- `GET /live-summary?token=...` -- does the real work. Returns:

```json
{
  "ok": true,
  "scrapedAt": "2026-08-18T...",
  "pikkitRawText": "<everything visible on the live bets page>",
  "scoreboards": {
    "nfl": ["Away Team 14 @ Home Team 10 — Q3 8:41", "..."],
    "nba": [],
    "...": []
  },
  "debug": { "url": "...", "title": "..." }
}
```
