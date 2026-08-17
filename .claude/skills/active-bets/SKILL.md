---
name: active-bets
description: >
  Look up Mike's open/active sports bets from his Pikkit export and read them
  back as spoken-style text meant to be dictated aloud. Use this whenever he
  asks what bets he has going, what's still live or pending, what he has riding
  today, how much is at risk, what he'd collect if everything hit, or asks to
  hear/read/recite/dictate his bets — including questions scoped to one
  sportsbook (DraftKings, FanDuel, BetMGM, Caesars, BetRivers, Hard Rock,
  Fanatics, bet365, ESPN BET) or one sport. Trigger it even if he never says
  the word "Pikkit" and even if he phrases it casually ("what do I got
  tonight?", "anything still alive?", "read me my bets").
---

# Active bets

Mike tracks every bet across ~8 sportsbooks in Pikkit, which syncs them
automatically via BookSync. This skill turns that data into something he can
listen to instead of squinting at a phone.

## The one constraint that shapes everything

**Pikkit has no public API.** There's no endpoint to call, and Pikkit Web is
behind an authenticated login that can't be scripted from here. The only
supported way out of Pikkit is the **Pro CSV export**, which Mike has (Pikkit
Pro Annual).

That means the data is always a *snapshot*, never live. Two things follow, and
both matter more than they sound:

- **Always check how old the export is** (`stat` the file) and say so if it's
  not from today. A bet that reads "pending" in a three-day-old export may have
  settled hours ago. Leading with "this is from Tuesday" is the difference
  between a useful rundown and a confidently wrong one.
- **If the export is stale and the answer matters**, say so plainly and ask him
  to re-export rather than reading old bets as if they're current.

## Finding the export

Look in this order, and stop at the first hit:

1. A path Mike names directly in the request.
2. Most recent `*.csv` in `~/Downloads` matching `pikkit`, `bet`, or `wager`.
3. Google Drive — search for a Pikkit export, download it, then read it.

If nothing turns up, don't guess or reconstruct from memory. Tell him how to
produce one: **Pikkit → Profile/Settings → Export Bets → CSV**, then save it to
Downloads or Drive.

## Reading it

```bash
python3 scripts/active_bets.py <export.csv>              # spoken rundown
python3 scripts/active_bets.py <export.csv> --json       # structured records
python3 scripts/active_bets.py <export.csv> --book FanDuel
python3 scripts/active_bets.py <export.csv> --sport NBA
python3 scripts/active_bets.py <export.csv> --all        # settled ones too
python3 scripts/active_bets.py <export.csv> --columns    # header mapping
```

Default output is open bets only, already phrased for speech. Print it as-is —
resist the urge to "improve" it into a table or add bullets and bold. The whole
point is text that survives being read aloud, and markdown furniture is exactly
what breaks that.

Use `--json` when he asks something analytical ("how much am I into FanDuel
for?", "what's my biggest ticket?") — compute from the records and answer in a
sentence rather than dumping the full rundown.

## When the CSV has unfamiliar headers

Pikkit's export columns aren't publicly documented and have changed between app
versions, so the script matches headers loosely against an alias table. If
output looks wrong — missing stakes, no odds, everything lumped as one bet —
run `--columns` to see what matched and what didn't, then add the real header
names to `COLUMN_ALIASES` in `scripts/active_bets.py`. That table is the single
place to fix header drift; nothing else in the script hardcodes a column name.

Bets with an unrecognized status are treated as **open** on purpose. For a "what
do I have riding" question, showing a bet that already settled is a small
annoyance; silently hiding a live one is a real failure.

## How the speech should sound

The script already handles this, but if you're ever composing by hand or
adjusting output, these are the conventions that make it sound like a person
and not a screen reader:

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

Structure is a headline followed by numbered bets:

> You have five open bets across four books. Two hundred thirty five dollars at
> risk, five hundred ninety five dollars and two cents back if everything hits.
>
> Number one. DraftKings. One hundred dollars on New York Yankees moneyline at
> minus one fifty. Yankees vs Red Sox. Starts today at seven oh five p m.
> Returns one hundred sixty six dollars and sixty seven cents if it hits.

Parlays announce their leg count first, then walk the legs — a listener needs to
know how many are coming before they start arriving.

Don't say the same thing twice. A line already implies its market: "minus one
and a half" is obviously a spread, so adding "spread" is noise. Same for a
selection that already contains the event name.

## Scope

This reports what Pikkit already recorded. It doesn't place bets, doesn't
recommend bets, and doesn't project outcomes. If Mike asks for a read on
something he's considering, that's a different conversation — answer it
directly, don't route it through this skill.
