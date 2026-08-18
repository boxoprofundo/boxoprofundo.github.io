# pikkit-live-service

> **Status:** rewritten to use Pikkit's JSON API instead of browser scraping,
> and **run end-to-end against a real account** on 2026-08-18 —
> `/live-summary` returns HTTP 200 in 0.66s with live scoreboards. Not yet
> deployed to Railway. See **[Verification status](#verification-status)** for
> exactly what is and isn't proven.

An on-demand HTTP service: call it, and it asks Pikkit which of your bets are
currently live or open, and pairs that with current live scoreboards for the
major US leagues (NFL, NBA, MLB, NHL, NCAAF, NCAAB) from ESPN's public
scoreboard endpoints.

No schedule, no cron, no caching — it only does anything when you hit
`/live-summary`.

## Why this is not a scraper anymore

The original design logged in with Playwright using an email and password.
**That could never have worked: Pikkit has no password login.**

Recon against the real site established:

- Authentication is **phone number → SMS/2FA code**. The login screen's own
  copy is `"Enter your 2FA Code"`, with `"Phone Number"` and `"MFA Code"`
  inputs. Searching the entire app bundle for a password field returns zero
  hits.
- The phone-number step is gated by **Cloudflare Turnstile** (a live site key
  ships in the app config).
- So `EMAIL_SELECTORS` / `PASSWORD_SELECTORS` had nothing to match. They were
  not "wrong selectors" — they described a form that does not exist.

What the web app actually does is much simpler. It calls a plain JSON API and
authenticates with the value of its `session_id` cookie, sent as a raw
`Authorization` header. This service does the same thing.

The result: no browser, no Chromium, no CAPTCHA surface, and no CSS selectors
to break when Pikkit reskins a component. Calls take ~1–2s instead of ~20s,
and the image is small enough for the cheapest instance.

## The API contract

| | |
|---|---|
| Base | `https://prod-website.pikkit.app` |
| Auth | `Authorization: <session_id>` — raw value, **no** `Bearer ` prefix |
| Session check | `GET /login/validate` → user profile |
| Live/open bets | `GET /user/bets?bet_statuses=live,PLACED&offset=0&limit=100` |

`bet_statuses` is a comma-separated list. Valid values come from
`GET /user/bets/filters`: `live`, `PLACED` (open), `future`, `SETTLED_WIN`,
`SETTLED_LOSS`, `SETTLED_PUSH`, `SETTLED_VOID`.

> **Gotcha worth keeping:** the `is_live` field on a bet means *"was placed
> while the game was in play"*, **not** *"is live right now"*. Filtering on it
> returns settled bets from weeks ago. Use `bet_statuses` instead.

## Setup

1. Deploy to Railway (or anywhere that runs a small Node app). See
   **[DEPLOY.md](DEPLOY.md)**.
2. Set two environment variables:
   - `PIKKIT_SESSION_ID` — the `session_id` cookie from a browser you're
     logged into Pikkit with. In Chrome: DevTools → Application → Cookies →
     `app.pikkit.com` → `session_id`. **Treat this like a password.**
   - `SERVICE_TOKEN` — a random string you generate (`openssl rand -hex 24`).
     Protects the endpoint from strangers; unrelated to Pikkit.
3. Test:

   ```
   curl "https://<your-domain>/live-summary?token=<SERVICE_TOKEN>"
   ```

## Endpoints

- `GET /health` — liveness, no auth.
- `GET /whoami?token=...` — cheap session check; returns your profile.
- `GET /live-summary?token=...` — the real work:

```json
{
  "ok": true,
  "fetchedAt": "2026-08-18T...",
  "liveBetCount": 0,
  "liveBets": [],
  "liveBetsText": "No live or open bets right now.",
  "scoreboards": { "nfl": ["..."], "mlb": ["..."] }
}
```

`liveBets` is structured (stake, odds in American, per-leg status and live
game context); `liveBetsText` is the same thing flattened to dense lines for
an LLM or a phone screen. **An empty list is a correct answer**, not an error
— it means nothing is running.

## When the session expires

Sessions don't last forever. When one dies, `/live-summary` and `/whoami`
return **HTTP 401** with `"sessionExpired": true` and a message telling you
what to do — rather than failing in some ambiguous way. Grab a fresh
`session_id` cookie and update the variable.

This is the main ongoing maintenance cost of this approach, and it is the
honest tradeoff for the fact that Pikkit's login cannot be automated at all.

## Verification status

Verified by real calls against the live API:

- `Authorization: <session_id>` is accepted; `/login/validate` returns the
  account profile.
- `/user/bets` requires `offset`/`limit`; `bet_statuses` filtering genuinely
  works — `SETTLED_WIN` returns only wins and `SETTLED_LOSS` only losses, so
  an empty result for `live,PLACED` is a true empty state and not a silently
  ignored parameter.
- ESPN scoreboard endpoints in `scores.js` return parseable data — all six
  leagues fetched and simplified correctly (e.g. `Detroit Lions 14 @
  Cincinnati Bengals 16 — Final`).
- **Pikkit returns HTTP 500, not 401/403, for an invalid session.** Found by
  calling the live API with a junk `session_id`. Status code alone therefore
  cannot distinguish "your session died" from "Pikkit is down", so `apiGet`
  disambiguates by probing `/login/validate` on the error path. Confirmed:
  both `/whoami` and `/live-summary` now return HTTP 401 with
  `"sessionExpired": true` for a bad session instead of a misleading 502.
- The server boots, `/health` returns `{"ok":true}`, and a missing or wrong
  `SERVICE_TOKEN` returns HTTP 401 `unauthorized`.
- Odds conversion is correct at the `+100` boundary and either side of it.
- **End-to-end with a valid session.** `/whoami` returns the correct account,
  `/live-summary` returns HTTP 200 in **0.66s** with populated scoreboards
  (16 NFL / 15 MLB / 25 NCAAF lines) and a correct empty bet list. For
  comparison, the old browser-scraping design budgeted 10–25s per call.
- **The populated bet path, against real bets** — not a fixture. Since the
  account had no live bets, the formatter was run over real `SETTLED_WIN`
  bets, which share the identical schema. Output:
  `straight · -185 · $214.00 to win $115.68 · SETTLED_WIN · (placed live)`
  with leg context `STL 2 - 1 CIN`. Odds conversion, money formatting, and
  context flattening all correct on real data.

Not yet verified at the time of this commit:

- Deployment to Railway.
- Rendering of a bet that is **genuinely live right now** (status `live`
  rather than `PLACED`/settled). The account had nothing running during
  development. Same schema and code path as the verified cases, but the
  literal `live` status string has not been seen in a response.
