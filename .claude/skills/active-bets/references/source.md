# Data source configuration

## Pikkit public profile URL

    NOT YET CONFIGURED

Replace the line above with the profile URL once it's confirmed to load in a
logged-out browser. Until then, skip path 1 and go to Google Drive.

**How this was meant to be filled in:** Pikkit records are public unless
hidden, and profiles have share links. In the app: your profile → share / copy
link. The test that matters is opening that link in a **private/incognito
window** — if it renders bets while logged out, it's usable here; if it
redirects to a login or just deep-links into the app, it isn't, and this path
stays off.

Two things to check before trusting it, because either one silently breaks the
rundown:

- **Does it show open bets, or only settled ones?** Some public records
  deliberately hide pending action so followers can't tail live positions. A
  profile that only publishes graded bets is useless for "what do I have
  riding right now."
- **Does it show everything, or only bets shared to the feed?** If bets reach
  the public profile only when explicitly shared, coverage will be partial —
  which is worse than no data, because the total at risk will read low and
  sound authoritative.

If the page is client-rendered, a plain fetch may return an empty shell rather
than bets. That's not a "no" for the approach, but it means the page needs
JavaScript execution to read, which is a heavier setup.

## Google Drive

Fallback. Search Drive for a recent Pikkit CSV export. Nothing to configure —
the connector handles auth — but it depends on an export existing, so check
the file's date before reading anything from it as current.
