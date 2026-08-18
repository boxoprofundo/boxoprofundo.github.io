# Deploying to Railway

> **Status:** this service has **not** been deployed or run against the real
> app.pikkit.com. The session that was supposed to do that had its egress
> blocked for `app.pikkit.com`, `railway.app`/`backboard.railway.app`, and
> `site.api.espn.com` (only package registries and GitHub are reachable), so
> steps 3-6 of the original plan have to run from your machine. Everything
> below is the exact sequence to do that.

## 0. Prereqs (once)

```bash
npm i -g @railway/cli
railway login          # opens a browser
railway whoami         # confirm the right account
railway list           # check existing projects so you don't collide
```

## 1. Create the project and deploy

From inside `pikkit-live-service/`:

```bash
railway init            # choose "Empty Project", name it e.g. pikkit-live-service
railway up              # builds the Dockerfile (installs Chromium) and deploys
```

## 2. Set the environment variables

**Do not paste your password into a chat — set it directly.** Either use the
Railway dashboard (Project → Variables), or run these locally:

```bash
railway variables --set "PIKKIT_EMAIL=you@example.com"

# Prompt for the password so it never lands in your shell history:
read -rs PIKKIT_PASSWORD && railway variables --set "PIKKIT_PASSWORD=$PIKKIT_PASSWORD" && unset PIKKIT_PASSWORD

# Your own random endpoint secret (nothing to do with your Pikkit password):
railway variables --set "SERVICE_TOKEN=$(openssl rand -hex 24)"

# Read it back so you know what to put in the curl below:
railway variables | grep SERVICE_TOKEN
```

> Older Railway CLI versions used `railway variables set KEY=value` (no `--set`).
> If the above errors, run `railway variables --help` and use whichever form
> your version supports.

Setting variables triggers a redeploy. Then expose the service publicly:

```bash
railway domain          # prints the generated https://<something>.up.railway.app
```

## 3. Test it

```bash
curl --max-time 90 "https://<your-domain>.up.railway.app/health"

curl --max-time 90 "https://<your-domain>.up.railway.app/live-summary?token=<SERVICE_TOKEN>"
```

The first call takes 10-25s (real login + page load). Give it a generous timeout.

## 4. When the first run fails

It very likely will — the login/nav selectors in `scraper.js` are guesses that
have never been checked against the real page. The error response carries a
`debug` object:

```bash
curl -s --max-time 90 "https://<domain>/live-summary?token=<TOKEN>" > resp.json

# what failed and where:
python3 -c "import json;d=json.load(open('resp.json'));print(d['error']);print(d.get('debug',{}).get('label'),d.get('debug',{}).get('url'),d.get('debug',{}).get('title'))"

# see exactly what the headless browser saw:
python3 -c "import json,base64;d=json.load(open('resp.json'));open('debug.png','wb').write(base64.b64decode(d['debug']['screenshotBase64']))"
```

`debug.label` tells you which checkpoint blew up:

| label | meaning |
|---|---|
| `initial-navigation-failed` | couldn't even load the page (site down, egress blocked, Cloudflare) |
| `login-form-not-found` | loaded, but no email/password field matched the guessed selectors |
| `login-appears-to-have-failed` | submitted, but a password field is still visible → wrong creds, CAPTCHA, or 2FA |

### Faster loop: debug locally instead of redeploying

Redeploying to read a screenshot is slow. Use the local harness against the
real site from your own machine:

```bash
npm install
npx playwright install chromium
export PIKKIT_EMAIL=you@example.com
read -rs PIKKIT_PASSWORD && export PIKKIT_PASSWORD
HEADED=1 node local-debug.js     # watch it drive a real browser window
PAUSE=1 HEADED=1 node local-debug.js   # Playwright Inspector: pick selectors by hand
```

Fix the selector lists at the top of `scraper.js` (`EMAIL_SELECTORS`,
`PASSWORD_SELECTORS`) and the `goToLiveBets()` "Live" tab locator until
`node local-debug.js` prints your real bets. Then `railway up` again.

If the screenshot shows a **CAPTCHA or a 2FA prompt**, this approach is dead as
designed — headless login can't get past it. Fallbacks at that point: reuse a
saved browser session (`storageState`) captured from a real logged-in browser,
or drop back to pasting bet info in manually.
