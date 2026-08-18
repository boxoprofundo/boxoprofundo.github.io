---
name: refresh-pikkit-session
description: >
  Refresh the Pikkit session used by Mike's live-bets service on Railway.
  Use when he says his Pikkit session expired, the bet tracker says
  sessionExpired, asks to "refresh my Pikkit session", or the live-bets
  endpoint returns 401 with sessionExpired true. Opens a browser for him to
  log in (he types the SMS code himself), captures the fresh session cookie,
  pushes it to Railway, and verifies the service works again.
---

# Refresh the Pikkit session

The live-bets service (Railway project with the `mblivebets.up.railway.app`
domain) authenticates to Pikkit with a `session_id` cookie stored in the
Railway variable `PIKKIT_SESSION_ID`. When Pikkit expires that session, the
service returns HTTP 401 with `"sessionExpired": true`. This skill replaces
the dead session with a fresh one.

**The human types the SMS code themselves.** Pikkit login is phone + texted
code behind a bot-check; never attempt to automate, intercept, or read that
code. Your job is everything around it.

**Never** print the session value into chat, write it to a file, or put it
anywhere except the Railway variable. It is a live credential for his
betting account.

## Steps

Run everything from this skill's directory.

1. **One-time setup, only if missing.**
   - If `node_modules/` is absent: `npm install && npx playwright install chromium`
   - If `railway whoami` fails or the CLI is missing:
     `npm i -g @railway/cli && railway login` (opens a browser; he clicks approve).
   - If `railway status` shows no linked project: run `railway link` and have
     him pick the project whose domain is `mblivebets.up.railway.app`
     (service `boxoprofundo.github.io` / project created for pikkit-live-service).

2. **Capture the fresh session.** Tell him a browser window is about to open
   and he should log into Pikkit in it, then run:

   ```bash
   SID=$(node grab-session.js) && echo "captured"
   ```

   The script waits up to 5 minutes while he logs in. If it exits non-zero,
   the login didn't finish -- tell him and offer to rerun.

3. **Push it to Railway** (same shell so `$SID` is still set):

   ```bash
   railway variables --set "PIKKIT_SESSION_ID=$SID" && unset SID
   ```

   Older CLI versions use `railway variables set KEY=value` -- adapt if
   `--set` errors. Setting the variable triggers a redeploy (~1 minute).

4. **Verify it actually works.** Read `SERVICE_TOKEN` from
   `railway variables`, wait for the redeploy, then:

   ```bash
   curl --max-time 30 "https://mblivebets.up.railway.app/whoami?token=<SERVICE_TOKEN>"
   ```

   Retry for up to ~2 minutes if the redeploy is still in flight. Success is
   `"ok": true` with his account (`Mike`, `@pianoguy51`). Report that plainly.
   If it still says `sessionExpired`, the capture went wrong -- start over at
   step 2 rather than declaring success.

## Notes

- The service's own repo lives in `pikkit-live-service/` two levels up;
  its README documents the API contract if something deeper is broken.
- If Railway's dashboard is easier in the moment: the manual fallback is
  DevTools → Application → Cookies → app.pikkit.com → `session_id`, pasted
  into the `PIKKIT_SESSION_ID` variable at railway.com. This skill exists so
  he doesn't have to do that.
