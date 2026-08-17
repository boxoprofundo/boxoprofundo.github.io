#!/usr/bin/env python3
"""
Turn a Pikkit CSV export into a spoken-style rundown of open bets.

Pikkit has no public API, so this reads the CSV export (Pikkit Pro -> Export
Bets). Pikkit's export headers are not publicly documented and have shifted
between app versions, so columns are matched loosely against the alias table
below rather than by exact name. If a real export shows up with headers we
don't recognize, add them to COLUMN_ALIASES -- that's the one place that
should ever need editing.

Usage:
    active_bets.py BETS.csv                 # spoken text (default)
    active_bets.py BETS.csv --json          # normalized records
    active_bets.py BETS.csv --all           # include settled bets too
    active_bets.py BETS.csv --book FanDuel  # filter to one sportsbook
    active_bets.py BETS.csv --columns       # show detected header mapping
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime, date
from pathlib import Path

# --------------------------------------------------------------------------
# Column matching
# --------------------------------------------------------------------------

# Canonical field -> candidate header names (normalized: lowercase, non-alnum
# collapsed to underscore). Order matters, first hit wins.
COLUMN_ALIASES = {
    "bet_id": ["bet_id", "id", "wager_id", "parlay_id", "ticket_id", "bet_slip_id"],
    "book": ["sportsbook", "book", "site", "operator", "bookmaker"],
    "placed_at": ["date_placed", "placed_at", "placed", "time_placed", "date",
                  "bet_date", "created_at", "wager_date", "placed_date"],
    "event_at": ["event_start", "event_date", "game_time", "start_time",
                 "event_time", "game_date", "scheduled", "start"],
    "sport": ["sport"],
    "league": ["league", "competition"],
    "event": ["event", "game", "matchup", "match", "teams", "event_name"],
    "bet_type": ["bet_type", "type", "wager_type", "slip_type", "category"],
    "market": ["market", "bet_market", "market_type", "prop", "bet_name"],
    "selection": ["selection", "pick", "description", "bet", "wager",
                  "bet_description", "selection_name", "outcome", "side"],
    "line": ["line", "handicap", "spread", "total", "points", "number"],
    "odds": ["odds", "american_odds", "price", "odds_american", "bet_odds",
             "decimal_odds", "closing_odds"],
    "stake": ["stake", "wager_amount", "amount", "risk", "bet_amount",
              "amount_wagered", "wagered", "size"],
    "to_win": ["to_win", "win_amount", "potential_win", "profit_potential"],
    "payout": ["potential_payout", "payout", "return", "potential_return",
               "total_payout", "collect"],
    "status": ["status", "result", "outcome_status", "bet_status", "state",
               "settlement", "grade"],
    "leg_no": ["leg", "leg_number", "leg_index", "leg_num"],
}

# Statuses that mean "this bet is still live". Anything we can't classify is
# treated as open on purpose -- for a rundown of what you have riding, a false
# positive you can dismiss is much cheaper than silently dropping a live bet.
OPEN_STATUSES = {
    "pending", "open", "unsettled", "active", "live", "in_progress",
    "inprogress", "placed", "accepted", "not_settled", "outstanding", "",
}
SETTLED_STATUSES = {
    "won", "win", "lost", "loss", "lose", "push", "tie", "void", "voided",
    "cancelled", "canceled", "settled", "cashed_out", "cashout", "cash_out",
    "half_won", "half_lost", "refunded", "refund", "dead_heat", "graded",
}


def norm_header(h: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (h or "").strip().lower()).strip("_")


def build_mapping(fieldnames: list[str]) -> dict[str, str]:
    """Map canonical field -> actual CSV header present in this file."""
    normalized = {norm_header(f): f for f in fieldnames if f}
    mapping: dict[str, str] = {}
    for canonical, candidates in COLUMN_ALIASES.items():
        for cand in candidates:
            if cand in normalized:
                mapping[canonical] = normalized[cand]
                break
    return mapping


def get(row: dict, mapping: dict, field: str) -> str:
    header = mapping.get(field)
    if not header:
        return ""
    return (row.get(header) or "").strip()


# --------------------------------------------------------------------------
# Value parsing
# --------------------------------------------------------------------------


def parse_money(raw: str) -> float | None:
    if not raw:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", raw.replace("(", "-").replace(")", ""))
    if cleaned in ("", "-", ".", "-."):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_odds(raw: str) -> int | None:
    """Return American odds. Accepts American (+250/-150) or decimal (3.50)."""
    if not raw:
        return None
    cleaned = raw.strip().replace(",", "")
    if not re.search(r"\d", cleaned):
        return None
    try:
        value = float(re.sub(r"[^0-9.\-+]", "", cleaned))
    except ValueError:
        return None
    if value == 0:
        return None
    # Decimal odds live in a narrow band and always carry a fraction; American
    # odds are integers of magnitude >= 100. A bare "2.5" is decimal, "+250"
    # is American even though both are small numbers.
    is_decimal = (
        1.01 <= value <= 100.0
        and "." in cleaned
        and not cleaned.lstrip().startswith(("+", "-"))
    )
    if is_decimal:
        return round((value - 1) * 100) if value >= 2.0 else -round(100 / (value - 1))
    return int(round(value))


DATE_FORMATS = [
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
    "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y", "%m/%d/%y %H:%M", "%m/%d/%y",
    "%d/%m/%Y", "%b %d, %Y", "%B %d, %Y",
]


def parse_dt(raw: str) -> datetime | None:
    if not raw:
        return None
    cleaned = raw.strip().replace("Z", "").split("+")[0].strip()
    try:
        return datetime.fromisoformat(cleaned)
    except ValueError:
        pass
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt)
        except ValueError:
            continue
    return None


def is_open(status_raw: str) -> bool:
    key = norm_header(status_raw)
    if key in SETTLED_STATUSES:
        return False
    if key in OPEN_STATUSES:
        return True
    return True  # unknown -> keep it, see note on OPEN_STATUSES


# --------------------------------------------------------------------------
# Number -> speech
# --------------------------------------------------------------------------

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
         "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
        "eighty", "ninety"]


def spell_two(n: int) -> str:
    if n < 10:
        return ONES[n]
    if n < 20:
        return TEENS[n - 10]
    tens, ones = divmod(n, 10)
    return TENS[tens] + (f" {ONES[ones]}" if ones else "")


def spell_int(n: int) -> str:
    """Plain English integer: 1584 -> 'one thousand five hundred eighty four'."""
    if n < 0:
        return "negative " + spell_int(-n)
    if n < 100:
        return spell_two(n)
    parts = []
    for divisor, label in ((1_000_000, "million"), (1000, "thousand"), (100, "hundred")):
        if n >= divisor:
            count, n = divmod(n, divisor)
            parts.append(f"{spell_int(count) if divisor > 100 else ONES[count]} {label}")
    if n:
        parts.append(spell_two(n))
    return " ".join(parts)


def spell_odds(odds: int | None) -> str:
    """American odds the way bettors actually say them: -110 -> 'minus one ten'."""
    if odds is None:
        return "unknown odds"
    if abs(odds) == 100:
        return "even money"
    sign = "minus" if odds < 0 else "plus"
    n = abs(odds)
    if n < 100:
        body = spell_two(n)
    elif n < 1000:
        hundreds, rest = divmod(n, 100)
        if rest == 0:
            body = f"{ONES[hundreds]} hundred"
        elif rest < 10:
            body = f"{ONES[hundreds]} oh {ONES[rest]}"
        else:
            body = f"{ONES[hundreds]} {spell_two(rest)}"
    elif n < 10000 and n % 1000 == 0:
        body = f"{ONES[n // 1000]} thousand"
    elif n < 10000 and n % 100 == 0:
        body = f"{spell_two(n // 100)} hundred"
    else:
        body = spell_int(n)
    return f"{sign} {body}"


def spell_money(amount: float | None) -> str:
    if amount is None:
        return "an unknown amount"
    negative = amount < 0
    amount = abs(amount)
    dollars = int(amount)
    cents = int(round((amount - dollars) * 100))
    if cents == 100:
        dollars, cents = dollars + 1, 0
    text = f"{spell_int(dollars)} dollar{'' if dollars == 1 else 's'}"
    if cents:
        text += f" and {spell_int(cents)} cent{'' if cents == 1 else 's'}"
    return ("negative " if negative else "") + text


def spell_line(raw: str) -> str:
    """'o8.5' -> 'over eight and a half', '-3.5' -> 'minus three and a half'."""
    if not raw:
        return ""
    text = raw.strip()
    prefix = ""
    lowered = text.lower()
    if lowered.startswith(("o", "over")):
        prefix, text = "over ", re.sub(r"^(over|o)\s*", "", text, flags=re.I)
    elif lowered.startswith(("u", "under")):
        prefix, text = "under ", re.sub(r"^(under|u)\s*", "", text, flags=re.I)
    elif text.startswith("+"):
        prefix, text = "plus ", text[1:]
    elif text.startswith("-"):
        prefix, text = "minus ", text[1:]
    try:
        value = float(text)
    except ValueError:
        return raw.strip()
    whole = int(abs(value))
    half = abs(value) - whole >= 0.5
    body = spell_int(whole) + (" and a half" if half else "")
    return prefix + body


def spell_date(dt: datetime | None, today: date | None = None) -> str:
    if dt is None:
        return ""
    today = today or date.today()
    delta = (dt.date() - today).days
    if delta == 0:
        return "today"
    if delta == -1:
        return "yesterday"
    if delta == 1:
        return "tomorrow"
    if -6 <= delta < 0:
        return f"last {dt.strftime('%A')}"
    if 0 < delta <= 6:
        return f"this {dt.strftime('%A')}"
    return dt.strftime("%B %-d") if sys.platform != "win32" else dt.strftime("%B %d")


def spell_time(dt: datetime | None) -> str:
    if dt is None or (dt.hour == 0 and dt.minute == 0):
        return ""
    hour = dt.hour % 12 or 12
    if dt.minute == 0:
        return f"{spell_int(hour)} {'a m' if dt.hour < 12 else 'p m'}"
    minute = f"oh {spell_int(dt.minute)}" if dt.minute < 10 else spell_int(dt.minute)
    return f"{spell_int(hour)} {minute} {'a m' if dt.hour < 12 else 'p m'}"


# --------------------------------------------------------------------------
# Loading and normalizing
# --------------------------------------------------------------------------


def split_legs(text: str) -> list[str]:
    """Parlay legs crammed into one cell, split on common separators."""
    if not text:
        return []
    parts = re.split(r"\s*(?:\n|\||;|\s/\s|\s\+\s|,\s*(?=[A-Z]))\s*", text)
    return [p.strip() for p in parts if p.strip()]


def load_bets(path: Path) -> tuple[list[dict], dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as fh:
        sample = fh.read(8192)
        fh.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(fh, dialect=dialect)
        mapping = build_mapping(reader.fieldnames or [])
        rows = [r for r in reader if any((v or "").strip() for v in r.values())]

    # Rows sharing a bet id are legs of one slip.
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for idx, row in enumerate(rows):
        key = get(row, mapping, "bet_id") or f"__row{idx}"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)

    bets = []
    for key in order:
        bets.append(build_bet(groups[key], mapping))
    return bets, mapping


def build_bet(rows: list[dict], mapping: dict) -> dict:
    head = rows[0]
    stake = parse_money(get(head, mapping, "stake"))
    payout = parse_money(get(head, mapping, "payout"))
    to_win = parse_money(get(head, mapping, "to_win"))
    if payout is None and stake is not None and to_win is not None:
        payout = stake + to_win

    odds = parse_odds(get(head, mapping, "odds"))
    if payout is None and stake is not None and odds is not None:
        payout = stake * (1 + (odds / 100 if odds > 0 else 100 / abs(odds)))

    legs = []
    if len(rows) > 1:
        # Some exports carry a slip-level header row (stake and combined odds,
        # no selection) followed by one row per leg. Rows without a selection
        # aren't legs -- counting them turns a 3-leg parlay into a 4-leg one.
        for row in rows:
            selection = get(row, mapping, "selection")
            if not selection:
                continue
            legs.append({
                "selection": selection,
                "line": get(row, mapping, "line"),
                "odds": parse_odds(get(row, mapping, "odds")),
                "event": get(row, mapping, "event"),
                "market": get(row, mapping, "market"),
            })
    if not legs and len(rows) == 1:
        inline = split_legs(get(head, mapping, "selection"))
        if len(inline) > 1:
            legs = [{"selection": s, "line": "", "odds": None, "event": "",
                     "market": ""} for s in inline]

    # A group that resolves to one leg is a straight bet, not a "one leg
    # parlay" -- fold the leg up so it reads naturally. This happens with
    # header-plus-one-row exports and with parlays whose other legs voided.
    if len(legs) == 1:
        only = legs[0]
        legs = []
        selection = get(head, mapping, "selection") or only["selection"]
        line = get(head, mapping, "line") or only["line"]
        market = get(head, mapping, "market") or only["market"]
        event = get(head, mapping, "event") or only["event"]
        odds = odds if odds is not None else only["odds"]
    else:
        selection = get(head, mapping, "selection")
        line = get(head, mapping, "line")
        market = get(head, mapping, "market")
        event = get(head, mapping, "event")

    status = get(head, mapping, "status")
    return {
        "bet_id": get(head, mapping, "bet_id"),
        "book": get(head, mapping, "book"),
        "placed_at": get(head, mapping, "placed_at"),
        "event_at": get(head, mapping, "event_at"),
        "sport": get(head, mapping, "sport"),
        "league": get(head, mapping, "league"),
        "event": event,
        "bet_type": get(head, mapping, "bet_type"),
        "market": market,
        "selection": selection,
        "line": line,
        "odds": odds,
        "stake": stake,
        "payout": round(payout, 2) if payout is not None else None,
        "status": status,
        "is_open": is_open(status),
        "legs": legs,
    }


# --------------------------------------------------------------------------
# Speech rendering
# --------------------------------------------------------------------------

ORDINALS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight",
            "nine", "ten", "eleven", "twelve"]

# Market labels that carry no information when spoken aloud -- "Aaron Judge to
# hit a home run, player prop" just wastes breath.
GENERIC_MARKETS = {"player prop", "prop", "props", "straight", "game prop",
                   "game line", "other", "n_a", "na", ""}


def mostly_redundant(candidate: str, existing: str) -> bool:
    """True if `candidate` adds little over what `existing` already said.

    Substring matching isn't enough: an event of "Aaron Judge Home Run" beside
    a selection of "Aaron Judge to hit a home run" isn't a substring but is
    still nothing new to a listener. Compare word overlap instead.
    """
    words = set(re.findall(r"[a-z0-9]+", (candidate or "").lower()))
    known = set(re.findall(r"[a-z0-9]+", (existing or "").lower()))
    if not words:
        return True
    return len(words - known) / len(words) < 0.34


def cap(text: str) -> str:
    """Capitalize a sentence opener without touching the rest of the string."""
    return text[:1].upper() + text[1:] if text else text


def describe_selection(bet: dict) -> str:
    """Phrase what was actually bet, without saying the same thing twice.

    A line already implies its market -- "minus one and a half" is obviously a
    spread, "over eight and a half" is obviously a total -- so the market label
    is only spoken when there's no line to carry the meaning.
    """
    text = (bet["selection"] or "").strip()
    line_raw = (bet["line"] or "").strip()
    line_spoken = spell_line(line_raw)
    market = (bet["market"] or "").strip()

    if line_spoken:
        # "Dodgers vs Padres Over" + "over eight and a half" would stutter.
        if line_spoken.startswith(("over", "under")):
            text = re.sub(r"\s*\b(over|under)\s*$", "", text, flags=re.I).strip()
        if line_raw not in text:
            text = f"{text} {line_spoken}".strip()
    elif market and market.lower() not in GENERIC_MARKETS \
            and market.lower() not in text.lower():
        text = f"{text} {market.lower()}".strip()

    return text or "an unlabeled selection"


def render_bet(bet: dict, index: int) -> str:
    lead = f"Number {ORDINALS[index] if index < len(ORDINALS) else index}."
    parts = [lead]
    if bet["book"]:
        parts.append(f"{bet['book']}.")

    stake_text = spell_money(bet["stake"])
    if bet["legs"]:
        leg_count = len(bet["legs"])
        parts.append(
            f"A {spell_int(leg_count)} leg parlay, {stake_text} at "
            f"{spell_odds(bet['odds'])}."
        )
    else:
        parts.append(f"{cap(stake_text)} on {describe_selection(bet)} at "
                     f"{spell_odds(bet['odds'])}.")
        if bet["event"] and not mostly_redundant(bet["event"], bet["selection"]):
            parts.append(f"{bet['event']}.")

    event_dt = parse_dt(bet["event_at"])
    if event_dt:
        when = spell_date(event_dt)
        clock = spell_time(event_dt)
        if when or clock:
            parts.append(f"Starts {when}{' at ' + clock if clock else ''}.")

    if bet["payout"] is not None:
        parts.append(f"Returns {spell_money(bet['payout'])} if it hits.")

    text = " ".join(parts)

    if bet["legs"]:
        leg_lines = []
        for i, leg in enumerate(bet["legs"], start=1):
            label = ORDINALS[i] if i < len(ORDINALS) else str(i)
            desc = describe_selection(leg)
            if leg["odds"] is not None:
                desc = f"{desc} at {spell_odds(leg['odds'])}"
            leg_lines.append(f"Leg {label}, {desc}.")
        text += "\n" + " ".join(leg_lines)
    return text


def render_speech(bets: list[dict], settled_count: int = 0) -> str:
    if not bets:
        base = "You have no open bets right now."
        if settled_count:
            base += (f" The export had {spell_int(settled_count)} "
                     f"bet{'s' if settled_count != 1 else ''}, all settled.")
        return base

    books = sorted({b["book"] for b in bets if b["book"]})
    at_risk = sum(b["stake"] for b in bets if b["stake"] is not None)
    to_return = sum(b["payout"] for b in bets if b["payout"] is not None)

    header = (f"You have {spell_int(len(bets))} open "
              f"bet{'s' if len(bets) != 1 else ''}")
    if books:
        header += (f" across {spell_int(len(books))} "
                   f"book{'s' if len(books) != 1 else ''}")
    header += f". {spell_money(at_risk).capitalize()} at risk"
    if to_return:
        header += f", {spell_money(to_return)} back if everything hits"
    header += "."

    body = [render_bet(bet, i) for i, bet in enumerate(bets, start=1)]
    return header + "\n\n" + "\n\n".join(body)


# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv_path", type=Path, help="Pikkit CSV export")
    ap.add_argument("--json", action="store_true", help="emit normalized records")
    ap.add_argument("--all", action="store_true", help="include settled bets")
    ap.add_argument("--book", help="filter to one sportsbook (substring match)")
    ap.add_argument("--sport", help="filter to one sport/league (substring match)")
    ap.add_argument("--columns", action="store_true",
                    help="print detected header mapping and exit")
    args = ap.parse_args()

    if not args.csv_path.exists():
        print(f"No such file: {args.csv_path}", file=sys.stderr)
        return 1

    bets, mapping = load_bets(args.csv_path)

    if args.columns:
        missing = [f for f in COLUMN_ALIASES if f not in mapping]
        print(json.dumps({"matched": mapping, "unmatched": missing}, indent=2))
        return 0

    settled_count = sum(1 for b in bets if not b["is_open"])
    if not args.all:
        bets = [b for b in bets if b["is_open"]]
    if args.book:
        bets = [b for b in bets if args.book.lower() in b["book"].lower()]
    if args.sport:
        needle = args.sport.lower()
        bets = [b for b in bets
                if needle in b["sport"].lower() or needle in b["league"].lower()]

    if args.json:
        print(json.dumps(bets, indent=2))
    else:
        print(render_speech(bets, settled_count))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
