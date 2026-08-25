/*
 * Demo mode: deterministic sample listings so the full per-section
 * aggregation UI can be exercised without API keys. Prices are generated,
 * not real — every row is labeled "demo" in the UI when this mode is on.
 */

(function () {
  "use strict";

  // Representative Yankee Stadium seating chart, grouped by level.
  const LEVELS = [
    { name: "Legends",    face: 350, base: 420, sections: range(14, 27) },
    { name: "Field",      face: 110, base: 135, sections: range(105, 136) },
    { name: "Bleachers",  face: 25,  base: 28,  sections: range(201, 204).concat(range(235, 239)) },
    { name: "Main",       face: 70,  base: 85,  sections: range(205, 234) },
    { name: "Terrace",    face: 45,  base: 52,  sections: range(305, 334) },
    { name: "Grandstand", face: 30,  base: 34,  sections: range(405, 433) },
  ];

  const PROVIDER_NAMES = [
    "Ticketmaster", "SeatGeek", "StubHub", "XP", "Vivid Seats", "TickPick",
  ];

  // Marquee opponents command higher resale prices.
  const HOT_OPPONENTS = /red sox|mets|dodgers|astros|phillies/i;

  function range(a, b) {
    const out = [];
    for (let i = a; i <= b; i++) out.push(String(i).padStart(3, "0"));
    return out;
  }

  // Small deterministic PRNG so demo results are stable between searches.
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // Canonical section list, exported so the results table can show every
  // section in the stadium (including ones with no listings found).
  window.STADIUM_SECTIONS = LEVELS.flatMap((l) =>
    l.sections.map((s) => ({ section: s, level: l.name }))
  );

  window.demoQuotes = function (games, qty) {
    const quotes = [];
    for (const game of games) {
      const hot = HOT_OPPONENTS.test(game.opponent) ? 1.45 : 1.0;
      const weekend = [5, 6].includes(game.dateUTC.getUTCDay()) ? 1.15 : 1.0;
      for (const level of LEVELS) {
        for (const section of level.sections) {
          for (const provider of PROVIDER_NAMES) {
            const rand = rng(hash(`${game.gamePk}|${section}|${provider}|${qty}`));
            if (rand() < 0.35) continue; // not every section listed everywhere
            const price =
              level.base * hot * weekend * (0.8 + rand() * 0.7) *
              (1 + (qty > 4 ? 0.08 : 0)); // large blocks are scarcer
            quotes.push({
              gamePk: game.gamePk,
              provider,
              section,
              price: Math.round(price * 100) / 100,
              faceValue: level.face,
              url: "#demo",
              demo: true,
            });
          }
        }
      }
    }
    return quotes;
  };
})();
