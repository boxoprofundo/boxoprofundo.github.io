/**
 * Opens a real browser window at app.pikkit.com and waits for YOU to log in
 * (phone number + the SMS code Pikkit texts you -- that part can never be
 * automated; it's what 2FA is for). The moment a session_id cookie appears,
 * this prints it to stdout and exits.
 *
 * Prints ONLY the session value to stdout; all human-facing messages go to
 * stderr, so `SID=$(node grab-session.js)` captures the value cleanly.
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://app.pikkit.com/');

  console.error('');
  console.error('A browser window is open at app.pikkit.com.');
  console.error('Log in there (phone number, then the code Pikkit texts you).');
  console.error('Waiting up to 5 minutes for the login to complete...');

  const deadline = Date.now() + 5 * 60 * 1000;
  let sid = null;
  while (Date.now() < deadline) {
    const cookies = await context.cookies().catch(() => []);
    const c = cookies.find((k) => k.name === 'session_id' && k.value);
    if (c) {
      sid = c.value;
      break;
    }
    // Bail out early if the person closed the window without logging in.
    if (page.isClosed()) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  await browser.close().catch(() => {});

  if (!sid) {
    console.error('No session_id cookie appeared. Did the login finish? Run this again.');
    process.exit(1);
  }
  console.error('Got the new session. Not printing it here -- it goes straight to Railway.');
  process.stdout.write(sid);
})();
