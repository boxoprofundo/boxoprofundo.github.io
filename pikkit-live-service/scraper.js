/**
 * Logs into app.pikkit.com and returns the raw visible text of the live-bets
 * area of the page.
 *
 * IMPORTANT CONTEXT FOR WHOEVER DEBUGS THIS:
 * app.pikkit.com is a JavaScript single-page app. It was not possible to
 * inspect its real DOM/selectors ahead of time (the environment that wrote
 * this code has no network access to reach the site directly). Everything
 * below is a best-effort, multi-strategy guess at how the login form and
 * live-bets view are structured. It is EXPECTED that this may need
 * adjustment after a real run -- that's what the debug info (page URL,
 * page title, and a screenshot) attached to any thrown error is for.
 *
 * Rather than trying to parse individual bet fields with brittle CSS
 * selectors (which would break the moment Pikkit changes a class name),
 * this deliberately returns the raw visible text of the page. Parsing
 * "what bets are on this page and what are they" from plain text is done
 * downstream by an LLM, which is far more robust to markup/copy changes
 * than hand-written selectors would be.
 */

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
  'input[placeholder*="Email" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
];

async function findFirstVisible(page, selectors) {
  for (const sel of selectors) {
    const locator = page.locator(sel).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible())) {
        return locator;
      }
    } catch (_) {
      // element may have detached mid-check; just try the next selector
    }
  }
  return null;
}

async function captureDebug(page, label) {
  let screenshotBase64 = null;
  try {
    const buf = await page.screenshot({ fullPage: true });
    screenshotBase64 = buf.toString('base64');
  } catch (_) {
    // ignore screenshot failures, debug info is best-effort
  }
  return {
    label,
    url: page.url(),
    title: await page.title().catch(() => null),
    screenshotBase64,
  };
}

async function login(page) {
  // The very first navigation can fail outright: site down, DNS/egress
  // blocked, a Cloudflare interstitial, or a plain timeout. Without this
  // wrapper the raised error carries no debug payload at all -- which is
  // exactly the case you most need a screenshot and URL for.
  try {
    await page.goto('https://app.pikkit.com/', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });
  } catch (e) {
    const debug = await captureDebug(page, 'initial-navigation-failed');
    const err = new Error(
      `Failed to load https://app.pikkit.com/ -- ${e.message}`
    );
    err.debug = debug;
    throw err;
  }
  // Give the SPA a moment to hydrate after networkidle.
  await page.waitForTimeout(2500);

  let emailInput = await findFirstVisible(page, EMAIL_SELECTORS);
  let passwordInput = await findFirstVisible(page, PASSWORD_SELECTORS);

  // If the form isn't visible yet, there may be a "Sign in" link/button to
  // click first (e.g. a marketing page rather than the login form directly).
  if (!emailInput || !passwordInput) {
    const signInTrigger = page.getByText(/sign in|log in/i).first();
    if ((await signInTrigger.count()) > 0) {
      await signInTrigger.click().catch(() => {});
      await page.waitForTimeout(2000);
      emailInput = await findFirstVisible(page, EMAIL_SELECTORS);
      passwordInput = await findFirstVisible(page, PASSWORD_SELECTORS);
    }
  }

  if (!emailInput || !passwordInput) {
    const debug = await captureDebug(page, 'login-form-not-found');
    const err = new Error(
      'Could not locate email/password fields on app.pikkit.com. The page structure likely differs from what this script expects.'
    );
    err.debug = debug;
    throw err;
  }

  await emailInput.fill(process.env.PIKKIT_EMAIL || '');
  await passwordInput.fill(process.env.PIKKIT_PASSWORD || '');

  // Try a submit button first; fall back to pressing Enter in the password field.
  const submitButton = page
    .locator('button[type="submit"]')
    .or(page.getByRole('button', { name: /sign in|log in/i }))
    .first();

  if ((await submitButton.count()) > 0) {
    await submitButton.click().catch(() => {});
  } else {
    await passwordInput.press('Enter').catch(() => {});
  }

  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  // Sanity check: if a password field is still visible, login likely failed
  // (wrong credentials, a CAPTCHA, or 2FA prompt).
  const stillOnLogin = await findFirstVisible(page, PASSWORD_SELECTORS);
  if (stillOnLogin) {
    const debug = await captureDebug(page, 'login-appears-to-have-failed');
    const err = new Error(
      'A password field is still visible after attempting to submit login. This could mean wrong credentials, a CAPTCHA, or a 2FA prompt blocking automated login.'
    );
    err.debug = debug;
    throw err;
  }
}

async function goToLiveBets(page) {
  // Best-effort: look for a nav item/tab literally labeled "Live".
  const liveTab = page.getByText(/^live$/i).first();
  if ((await liveTab.count()) > 0) {
    await liveTab.click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  // If no explicit "Live" tab was found, we just fall through and return
  // whatever is on the post-login landing page -- often the bet list is
  // there directly.
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ text: string, debug: object }>}
 */
async function scrapeLiveBets(page) {
  await login(page);
  await goToLiveBets(page);

  const text = await page.locator('body').innerText();
  const debug = await captureDebug(page, 'post-scrape-snapshot');
  // Don't ship a screenshot on the happy path -- it's large and unnecessary
  // once we already have usable text. Keep it only for error cases.
  debug.screenshotBase64 = null;

  return { text, debug };
}

module.exports = { scrapeLiveBets };
