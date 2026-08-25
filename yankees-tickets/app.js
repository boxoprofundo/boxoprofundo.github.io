/*
 * Yankees Ticket Finder — orchestration and rendering.
 *
 * 1. Pull every remaining Yankees home game from the free MLB Stats API
 *    (statsapi.mlb.com, keyless and CORS-enabled).
 * 2. Ask each marketplace adapter (providers.js) for quotes at the chosen
 *    block size.
 * 3. Aggregate: for every stadium section, the single cheapest block across
 *    all remaining games and all marketplaces.
 */

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const TEAM_ID = 147; // New York Yankees
  const SETTINGS_KEY = "ytf-settings";

  const state = { games: null, sectionRows: [], sortKey: "section", sortAsc: true };

  /* ------------------------------ settings ------------------------------ */

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings() {
    const s = {
      tmKey: $("#tm-key").value.trim(),
      sgKey: $("#sg-key").value.trim(),
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    $("#settings").hidden = true;
    setStatus("Settings saved.");
    return s;
  }

  /* ------------------------------- status ------------------------------- */

  function setStatus(msg, isError) {
    const el = $("#status");
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle("error", !!isError);
  }

  /* ------------------------------ schedule ------------------------------ */

  const fmtET = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  const fmtISO = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const fmtShort = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric", day: "numeric", year: "numeric",
  });

  // Prices collected server-side by the scheduled GitHub Action
  // (.github/workflows/update-listings.yml). Optional — a 404 just means the
  // Action hasn't run yet (or no API secrets are configured).
  async function fetchCachedListings() {
    try {
      const res = await fetch("data/listings.json", { cache: "no-cache" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function fetchRemainingHomeGames() {
    const today = fmtISO.format(new Date());
    const year = new Date().getFullYear();
    const url =
      "https://statsapi.mlb.com/api/v1/schedule?sportId=1" +
      `&teamId=${TEAM_ID}&startDate=${today}&endDate=${year}-11-15` +
      "&gameTypes=R,F,D,L,W";
    const res = await fetch(url);
    if (!res.ok) throw new Error("MLB schedule HTTP " + res.status);
    const data = await res.json();
    const games = [];
    for (const day of data.dates || []) {
      for (const g of day.games || []) {
        if (g.teams.home.team.id !== TEAM_ID) continue;
        if (g.status.abstractGameState === "Final") continue;
        const dateUTC = new Date(g.gameDate);
        if (dateUTC.getTime() < Date.now() - 4 * 3600 * 1000) continue;
        games.push({
          gamePk: g.gamePk,
          dateUTC,
          opponent: g.teams.away.team.name,
          displayET: fmtET.format(dateUTC) + " ET",
          isoDateET: fmtISO.format(dateUTC),
          dateShort: fmtShort.format(dateUTC),
        });
      }
    }
    return games;
  }

  /* ------------------------------- search ------------------------------- */

  async function runSearch() {
    const qty = Math.max(1, Math.min(12, parseInt($("#qty").value, 10) || 2));
    const demo = $("#demo-mode").checked;
    const settings = loadSettings();
    const btn = $("#search-btn");
    btn.disabled = true;
    setStatus("Loading remaining home games…");

    try {
      if (!state.games) state.games = await fetchRemainingHomeGames();
      const games = state.games;
      if (!games.length) {
        setStatus("No remaining Yankees home games were found on the MLB schedule.", true);
        return;
      }

      setStatus(`Searching ${games.length} remaining home games across 6 marketplaces…`);
      const [cached, ...results] = await Promise.allSettled([
        fetchCachedListings(),
        ...window.PROVIDERS.map((p) => p.search(games, qty, settings)),
      ]);
      const quotes = [];
      const failed = [];

      // Server-collected prices go first so fresher in-browser quotes win.
      let cachedAt = null;
      const listings = cached.status === "fulfilled" ? cached.value : null;
      if (listings && Array.isArray(listings.quotes)) {
        const valid = new Set(games.map((g) => g.gamePk));
        quotes.push(...listings.quotes.filter((q) => valid.has(q.gamePk)));
        cachedAt = listings.fetchedAt || null;
      }
      results.forEach((r, i) => {
        if (r.status === "fulfilled") quotes.push(...r.value);
        else {
          failed.push(window.PROVIDERS[i].name);
          console.error(window.PROVIDERS[i].name, r.reason);
        }
      });
      if (demo) quotes.push(...window.demoQuotes(games, qty));

      render(games, quotes, qty, demo);

      let note = failed.length
        ? `Some sources failed and were skipped: ${failed.join(", ")}. `
        : "";
      if (cachedAt) {
        note += `Includes prices auto-collected ${new Date(cachedAt).toLocaleString()}. `;
      } else if (!settings.tmKey && !settings.sgKey && !demo) {
        note +=
          "No API keys configured — showing games with direct marketplace links only. " +
          "Add free Ticketmaster/SeatGeek keys in Settings for live prices, or turn on Demo mode to preview the per-section view.";
      }
      setStatus(note || null, !!failed.length);
    } catch (err) {
      console.error(err);
      setStatus("Search failed: " + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------ rendering ------------------------------ */

  function fmtMoney(v) {
    return v == null
      ? "—"
      : "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function render(games, quotes, qty, demo) {
    const byGame = new Map(games.map((g) => [g.gamePk, g]));

    // Approximate face value per game = Ticketmaster (primary market) minimum.
    const tmFace = new Map();
    for (const q of quotes) {
      if (q.provider === "Ticketmaster" && !q.demo && q.faceValue != null) {
        tmFace.set(q.gamePk, q.faceValue);
      }
    }

    renderSectionTable(games, quotes, qty, byGame, tmFace, demo);
    renderGameTable(games, quotes, byGame);
  }

  function renderSectionTable(games, quotes, qty, byGame, tmFace, demo) {
    const sectionQuotes = quotes.filter((q) => q.section && q.price != null);
    const wrap = $("#section-results");

    if (!sectionQuotes.length) {
      wrap.hidden = true;
      return;
    }

    // Cheapest block per section across every game and marketplace.
    const best = new Map();
    for (const q of sectionQuotes) {
      const cur = best.get(q.section);
      if (!cur || q.price < cur.price) best.set(q.section, q);
    }

    const known = new Set(window.STADIUM_SECTIONS.map((s) => s.section));
    const levelBySection = new Map(
      window.STADIUM_SECTIONS.map((s) => [s.section, s.level])
    );
    const allSections = window.STADIUM_SECTIONS.map((s) => s.section)
      .concat([...best.keys()].filter((s) => !known.has(s)));

    state.sectionRows = allSections.map((section) => {
      const q = best.get(section);
      const game = q && byGame.get(q.gamePk);
      return {
        section,
        level: levelBySection.get(section) || "",
        price: q ? q.price : null,
        total: q ? q.price * qty : null,
        date: game ? game.dateUTC.getTime() : null,
        dateLabel: game ? game.displayET : "",
        opponent: game ? game.opponent : "",
        provider: q ? q.provider : "",
        url: q ? q.url : "",
        demoRow: q ? !!q.demo : false,
        face: q && q.faceValue != null ? q.faceValue
          : q ? tmFace.get(q.gamePk) ?? null : null,
      };
    });

    $("#section-sub").textContent =
      `— block of ${qty} ticket${qty > 1 ? "s" : ""}, cheapest across ` +
      `${games.length} remaining home games${demo ? " · includes DEMO data" : ""}`;
    sortAndPaintSections();
    wrap.hidden = false;
  }

  function sortAndPaintSections() {
    const { sortKey, sortAsc } = state;
    const rows = [...state.sectionRows].sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === "section") {
        va = parseInt(va, 10); vb = parseInt(vb, 10);
      }
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sortAsc ? c : -c;
    });

    const tbody = $("#section-table tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.price == null) {
        tr.innerHTML =
          `<td><span class="badge">${r.level}</span> ${r.section}</td>` +
          `<td class="na" colspan="7">No block of this size found</td>`;
      } else {
        const link = r.demoRow
          ? `<span class="na">demo</span>`
          : `<a href="${r.url}" target="_blank" rel="noopener">View tickets →</a>`;
        tr.innerHTML =
          `<td><span class="badge">${r.level}</span> ${r.section}</td>` +
          `<td class="price">${fmtMoney(r.price)}</td>` +
          `<td>${fmtMoney(r.total)}</td>` +
          `<td>${r.dateLabel}</td>` +
          `<td>${r.opponent}</td>` +
          `<td>${r.provider}${r.demoRow ? " (demo)" : ""}</td>` +
          `<td>${link}</td>` +
          `<td>${r.face != null ? fmtMoney(r.face) : "—"}</td>`;
      }
      tbody.appendChild(tr);
    }
  }

  function renderGameTable(games, quotes, byGame) {
    const providerNames = window.PROVIDERS.map((p) => p.name);
    const byGameProvider = new Map();
    for (const q of quotes) {
      if (q.section || q.demo) continue; // event-level live quotes only
      const key = q.gamePk + "|" + q.provider;
      const prev = byGameProvider.get(key);
      // A priced quote always beats a link-only one, regardless of order.
      if (prev && prev.price != null && q.price == null) continue;
      byGameProvider.set(key, q);
    }

    const tbody = $("#game-table tbody");
    tbody.innerHTML = "";
    for (const g of games) {
      const cells = providerNames.map((name) => {
        const q = byGameProvider.get(g.gamePk + "|" + name);
        if (!q) return `<td class="na">—</td>`;
        const label = q.price != null ? fmtMoney(q.price) : "search →";
        const cls = q.price != null ? "price" : "";
        if (!q.url) return `<td class="${cls}">${label}</td>`;
        return `<td class="${cls}"><a href="${q.url}" target="_blank" rel="noopener">${label}</a></td>`;
      });
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>vs ${g.opponent}</td><td>${g.displayET}</td>` + cells.join("");
      tbody.appendChild(tr);
    }
    $("#game-results").hidden = false;
  }

  /* -------------------------------- wiring ------------------------------- */

  document.addEventListener("DOMContentLoaded", () => {
    const s = loadSettings();
    $("#tm-key").value = s.tmKey || "";
    $("#sg-key").value = s.sgKey || "";

    $("#search-btn").addEventListener("click", runSearch);
    $("#qty").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch();
    });
    $("#settings-btn").addEventListener("click", () => {
      $("#settings").hidden = !$("#settings").hidden;
    });
    $("#save-settings").addEventListener("click", saveSettings);

    document.querySelectorAll("#section-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortAsc = !state.sortAsc;
        else {
          state.sortKey = key;
          state.sortAsc = true;
        }
        if (state.sectionRows.length) sortAndPaintSections();
      });
    });
  });
})();
