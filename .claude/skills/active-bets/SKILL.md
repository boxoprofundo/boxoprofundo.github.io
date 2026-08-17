---
name: active-bets
description: >
  Look up Mike's open/active sports bets and read them back as spoken-style
  text meant to be heard, not read. Use this whenever he asks for an update on
  his current bets, what he has going or riding, what's still live or pending,
  how much is at risk, what he'd collect if everything hit, or asks to
  hear/read/recite/dictate his bets — including questions scoped to one
  sportsbook (DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock,
  Fanatics, bet365, ESPN BET) or one sport. Trigger it even if he never says
  the word "Pikkit" and even if he phrases it casually ("update me on my
  bets", "what do I got tonight?", "anything still alive?").
---

# Active bets

Mike tracks every bet across ~8 sportsbooks in Pikkit, which syncs them
automatically via BookSync. He asks for these on his phone, usually by voice,
and wants to listen rather than read. So the output is prose meant for a
speaker, and the data has to come from somewhere reachable without his laptop.

## Where the data comes from

**Pikkit has no public API**, and Pikkit Web is behind a login that can't be
scripted. So the data arrives through one of the paths below. Try them in
order and stop at the first that works.

1. **Public profile page.** Pikkit is a social product — records are public
   unless hidden, and profiles have share links. If a profile URL is recorded
   in `references/source.md`, fetch it and pull the open bets off the page.
   This is the only path that needs nothing from Mike at request time, so it's
   worth preferring whenever it's configured and working.
2. **Google Drive.** Search his Drive for a recent Pikkit CSV export, download
   it, and read it. Works from the phone since it goes through the connector,
   not the filesystem.
3. **A local file**, if he names a path or one is sitting in `~/Downloads`
   matching `pikkit`, `bet`, or `wager`. Desktop only.

If none of these produce anything, don't guess and don't reconstruct bets from
memory or from old messages in the conversation — a confidently wrong bet
rundown is worse than no answer. Say which paths you tried and ask him to
export from Pikkit (**Pikkit → Settings → Export Bets → CSV**, save to Drive).

### Staleness is the main way this goes wrong

Every path except a live profile fetch returns a *snapshot*. Check the
timestamp of whatever you loaded and say so whenever it isn't from today. A
bet marked "pending" in a two-day-old export may have settled long ago, and
reading it as current is the failure mode that actually matters here. When the
data is stale and the answer matters, say so and offer to get a fresh copy
rather than reading old bets as though they're live.

## Turning it into speech

The renderer is the same regardless of source, which is the point — phrasing
shouldn't drift depending on where the bets came from.

```bash
python3 scripts/active_bets.py <export.csv>              # spoken rundown
python3 scripts/active_bets.py <export.csv> --json       # structured records
python3 scripts/active_bets.py <export.csv> --book FanDuel
python3 scripts/active_bets.py <export.csv> --sport NBA
python3 scripts/active_bets.py <export.csv> --all        # settled ones too
python3 scripts/active_bets.py <export.csv> --columns    # header mapping
python3 scripts/active_bets.py --from-json bets.json     # any other source
```

For anything that isn't a CSV — a profile page, a screenshot, a pasted slip —
normalize what you found into JSON records and pipe them through
`--from-json` (`-` reads stdin). Fields: `book`, `event`, `market`,
`selection`, `line`, `odds`, `stake`, `payout`, `status`, `event_at`, and
`legs[]` for parlays. Everything is optional; odds accept American or decimal,
money accepts strings like `"$20.00"`.

Print the result as-is. Resist reformatting it into a table or adding bullets
and bold — markdown furniture is exactly what breaks text that's about to be
read aloud.

Use `--json` for analytical questions ("how much am I into FanDuel for?",
"what's my biggest ticket?") and answer in a sentence instead of reciting the
whole rundown.

If no code execution is available, follow the conventions below by hand.

## How it should sound

| Written | Spoken |
|---|---|
| `-150` | minus one fifty |
| `-105` | minus one oh five |
| `+250` | plus two fifty |
| `+1200` | twelve hundred |
| `+100` / `-100` | even money |
| `-3.5` | minus three and a half |
| `o8.5` | over eight and a half |
| `$166.67` | one hundred sixty six dollars and sixty seven cents |

A headline, then numbered bets:

> You have five open bets across four books. Two hundred thirty five dollars at
> risk, five hundred ninety five dollars and two cents back if everything hits.
>
> Number one. DraftKings. One hundred dollars on New York Yankees moneyline at
> minus one fifty. Yankees vs Red Sox. Starts today at seven oh five p m.
> Returns one hundred sixty six dollars and sixty seven cents if it hits.

Parlays announce their leg count before walking the legs — a listener needs to
know how many are coming before they start arriving.

Don't say the same thing twice. A line already implies its market: "minus one
and a half" is obviously a spread, so adding "spread" is noise. Same for a
selection that already contains the event name.

## When a CSV has unfamiliar headers

Pikkit's export columns aren't documented and have changed between app
versions, so headers are matched loosely against an alias table. If output
looks wrong — missing stakes, no odds, everything lumped into one bet — run
`--columns` to see what matched, then add the real names to `COLUMN_ALIASES`
in `scripts/active_bets.py`. That table is the only place a column name is
hardcoded.

Bets with an unrecognized status are treated as **open** deliberately. For a
"what do I have riding" question, showing a settled bet is a small annoyance;
silently hiding a live one is a real failure.

## Scope

This reports what Pikkit already recorded. It doesn't place bets, doesn't
recommend bets, and doesn't project outcomes. If Mike wants a read on something
he's considering, answer that directly rather than routing it through here.
