# Deploying to Railway

This service is a small Node app with one dependency (`express`) and no
browser. Builds take seconds and it runs fine on the smallest instance.

## 0. Get your Pikkit session

Pikkit can't be logged into programmatically (phone + SMS 2FA behind
Cloudflare Turnstile — see [README.md](README.md)), so the service reuses a
session from a browser you already logged in with.

1. Log in at <https://app.pikkit.com>.
2. DevTools → **Application** → **Cookies** → `app.pikkit.com` → `session_id`.
3. Copy the value. Treat it like a password.

Sanity-check it locally before deploying anything:

```bash
npm install
read -rs PIKKIT_SESSION_ID && export PIKKIT_SESSION_ID
node local-debug.js
```

That prints who the session belongs to and any live/open bets. `SCORES=1` also
dumps the scoreboards. Using `read -rs` keeps the value out of your shell
history.

## Option A — deploy from the Railway dashboard (no CLI, no Node needed)

If you don't have Node installed locally, skip the CLI entirely — Railway can
build straight from GitHub in the browser.

1. <https://railway.com> → **New Project** → **Deploy from GitHub repo**
2. Pick `boxoprofundo/boxoprofundo.github.io`, branch
   `claude/pikkit-live-bets-railway-132nbq`
3. **Settings → Root Directory** → set to `pikkit-live-service`
   (the repo root is a personal website; without this Railway builds the wrong
   thing)
4. **Variables** → add `PIKKIT_SESSION_ID` and `SERVICE_TOKEN`
5. **Settings → Networking** → **Generate Domain**
6. Open `https://<domain>/health` in a browser — expect `{"ok":true}`

Then jump to [step 4](#4-test).

## Option B — CLI

### 1. Prereqs

```bash
npm i -g @railway/cli
railway login            # add --browserless for a device-code flow
railway whoami           # confirm the right account
railway list             # check existing projects so you don't collide
```

### 2. Create the project and deploy

From inside `pikkit-live-service/`:

```bash
railway init             # choose "Empty Project", name it e.g. pikkit-live-service
railway up               # builds the Dockerfile and deploys
```

### 3. Set the environment variables

Never paste secrets as literals — prompt for them so they stay out of history:

```bash
read -rs PIKKIT_SESSION_ID && railway variables --set "PIKKIT_SESSION_ID=$PIKKIT_SESSION_ID" && unset PIKKIT_SESSION_ID

# Your own random endpoint secret (nothing to do with Pikkit):
railway variables --set "SERVICE_TOKEN=$(openssl rand -hex 24)"

# Read it back so you know what to put in the curl below:
railway variables | grep SERVICE_TOKEN
```

> Older Railway CLI versions used `railway variables set KEY=value` (no
> `--set`). If the above errors, check `railway variables --help`.

Setting variables triggers a redeploy. Then expose it publicly:

```bash
railway domain           # prints https://<something>.up.railway.app
```

## 4. Test

```bash
curl --max-time 30 "https://<your-domain>/health"
curl --max-time 30 "https://<your-domain>/whoami?token=<SERVICE_TOKEN>"
curl --max-time 30 "https://<your-domain>/live-summary?token=<SERVICE_TOKEN>"
```

Expect ~1–2s. `/whoami` is the fastest way to tell a dead session from a
broken deploy.

Any of these can also just be opened in a browser tab — they're plain GETs.

## 5. Troubleshooting

| symptom | meaning |
|---|---|
| `401` + `"sessionExpired": true` | the `session_id` expired or is wrong → grab a fresh cookie (step 0) and re-set the variable |
| `401 unauthorized` (no `sessionExpired`) | wrong or missing `?token=` — that's `SERVICE_TOKEN`, not Pikkit |
| `502` + a Pikkit API message | Pikkit returned an unexpected status; the message includes their response |
| `liveBetCount: 0` | **not an error** — you have no live or open bets right now |
| build succeeds but `/health` 404s | Root Directory isn't set to `pikkit-live-service` |

If Pikkit changes the API shape, `pikkit.js` is the only file that needs to
change; `GET /user/bets/filters` is the authoritative source for valid
`bet_statuses` values.
