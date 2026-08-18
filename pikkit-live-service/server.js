const express = require('express');
const { chromium } = require('playwright');
const { scrapeLiveBets } = require('./scraper');
const { getSimplifiedScoreboards } = require('./scores');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => res.json({ ok: true }));

// GET /live-summary?token=YOUR_SERVICE_TOKEN
//
// Synchronous, on-demand endpoint: every call launches a fresh headless
// browser, logs into Pikkit, grabs the live-bets page's text, and pairs it
// with a simplified live scoreboard bundle for the major leagues. No
// caching, no schedule -- it only runs when called, since that's all
// this is meant to do.
//
// Expect this to take roughly 10-25 seconds per call (real login + page
// load). If it becomes a problem, the timeout on whatever is calling this
// should be generous (30s+).
app.get('/live-summary', async (req, res) => {
  if (!process.env.SERVICE_TOKEN || req.query.token !== process.env.SERVICE_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    const [{ text, debug }, scoreboards] = await Promise.all([
      scrapeLiveBets(page),
      getSimplifiedScoreboards(),
    ]);

    res.json({
      ok: true,
      scrapedAt: new Date().toISOString(),
      pikkitRawText: text,
      scoreboards,
      debug,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      debug: e.debug || null,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`pikkit-live-service listening on port ${PORT}`);
});
