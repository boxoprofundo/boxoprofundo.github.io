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
      ghToken: $("#gh-token").value.trim(),
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

  // Prices collected outside the browser, freshest source first:
  // 1. published/ in the scraper repo, read via the GitHub API with the
  //    access key — this is where every scrape run drops its results, so
  //    with a key the site needs no separate publish step at all;
  // 2. this site's own data/ files (for visitors without a key).
  // A quantity-specific file (listings-4.json for blocks of 4) wins over the
  // generic listings.json; a 404 just means no collector has run yet.
  async function fetchOneListing(qty, base) {
    const { ghToken } = loadSettings();
    const sources = [];
    for (const name of [`${base}-${qty}.json`, `${base}.json`]) {
      if (ghToken) {
        sources.push({
          url: `${SCRAPER_API}/contents/published/${name}?ref=main`,
          opts: { headers: ghHeaders(ghToken, true), cache: "no-cache" },
        });
      }
      sources.push({ url: `data/${name}`, opts: { cache: "no-cache" } });
    }
    for (const s of sources) {
      try {
        const res = await fetch(s.url, s.opts);
        if (!res.ok) continue;
        return await res.json();
      } catch {
        /* try next */
      }
    }
    return null;
  }

  // The cloud run writes "listings" (everything but StubHub); a home-computer
  // run writes "listings-stubhub" (StubHub only, scraped over a residential
  // connection). Merge both so StubHub prices appear whenever the home run
  // last refreshed them.
  async function fetchCachedListings(qty) {
    const [main, stub] = await Promise.all([
      fetchOneListing(qty, "listings"),
      fetchOneListing(qty, "listings-stubhub"),
    ]);
    if (!main && !stub) return null;
    const quotes = []
      .concat(main && Array.isArray(main.quotes) ? main.quotes : [])
      .concat(stub && Array.isArray(stub.quotes) ? stub.quotes : []);
    const times = [main, stub].filter((x) => x && x.fetchedAt).map((x) => x.fetchedAt);
    return { fetchedAt: times.sort().slice(-1)[0] || null, quotes };
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

  /* --------------------------- refresh prices --------------------------- */

  const SCRAPER_REPO = "boxoprofundo/ticket-scraper";
  const SCRAPER_API = `https://api.github.com/repos/${SCRAPER_REPO}`;
  const SCRAPE_WORKFLOW = "yankees-scrape.yml";
  const POLL_MS = 20000;

  function ghHeaders(token, raw) {
    return {
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      Authorization: "Bearer " + token,
    };
  }

  // One button does the whole loop: start the scraper on GitHub's servers,
  // watch the run, and reload prices automatically when it finishes.
  let pollTimer = null;

  async function refreshPrices() {
    const qty = Math.max(1, Math.min(12, parseInt($("#qty").value, 10) || 2));
    const { ghToken } = loadSettings();
    if (!ghToken) {
      $("#settings").hidden = false;
      $("#gh-token").focus();
      setStatus(
        "The Refresh button needs a one-time access key — follow the short " +
        "steps next to the highlighted box in Settings (opened below).",
        true
      );
      return;
    }
    const btn = $("#refresh-btn");
    btn.disabled = true;
    try {
      const startedAt = Date.now();
      const res = await fetch(
        `${SCRAPER_API}/actions/workflows/${SCRAPE_WORKFLOW}/dispatches`,
        {
          method: "POST",
          headers: ghHeaders(ghToken),
          body: JSON.stringify({ ref: "main", inputs: { qty: String(qty) } }),
        }
      );
      if (res.status !== 204) {
        const body = await res.text();
        throw new Error(`GitHub answered ${res.status}: ${body.slice(0, 200)}`);
      }
      setStatus(
        `Price scrape started for blocks of ${qty} — usually 5–10 minutes. ` +
        "This page will load the fresh prices automatically when it's done."
      );
      watchScrape(qty, startedAt);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      setStatus(
        "Couldn't start the scraper: " + err.message +
        " — check the access key in Settings.",
        true
      );
    }
  }

  function watchScrape(qty, startedAt) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const mins = Math.round((Date.now() - startedAt) / 60000);
      if (Date.now() - startedAt > 25 * 60000) {
        clearInterval(pollTimer);
        $("#refresh-btn").disabled = false;
        setStatus(
          "The scrape is taking unusually long. Hit Search later to check " +
          "for new prices, or try Refresh again.",
          true
        );
        return;
      }
      try {
        const { ghToken } = loadSettings();
        const res = await fetch(
          `${SCRAPER_API}/actions/workflows/${SCRAPE_WORKFLOW}/runs?per_page=1`,
          { headers: ghHeaders(ghToken) }
        );
        if (!res.ok) return;
        const run = ((await res.json()).workflow_runs || [])[0];
        // Ignore stale runs from before this button press.
        if (!run || Date.parse(run.created_at) < startedAt - 60000) {
          setStatus(`Scrape starting… (${mins} min)`);
          return;
        }
        if (run.status !== "completed") {
          setStatus(
            `Scraper is running on GitHub's servers — usually 5–10 minutes ` +
            `(${mins} elapsed). Fresh prices will load here automatically.`
          );
          return;
        }
        clearInterval(pollTimer);
        $("#refresh-btn").disabled = false;
        if (run.conclusion === "success") {
          setStatus("Scrape finished — loading fresh prices…");
          await runSearch();
        } else {
          setStatus(
            `The scrape run ended with status "${run.conclusion}" — try ` +
            "Refresh again in a few minutes.",
            true
          );
        }
      } catch (err) {
        console.error(err);
      }
    }, POLL_MS);
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
        fetchCachedListings(qty),
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
          "No prices loaded yet for this block size — press ↻ Refresh prices " +
          "to run the price scraper (a short one-time setup the first time), " +
          "then they'll load here automatically. The games and store links " +
          "below work either way.";
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
        // StubHub isn't scrapeable, so link to that game's exact StubHub
        // event page for a quick manual check of this section's price.
        stubhub: game
          ? window.stubhubLink(game.gamePk, qty, game.opponent, game.dateShort)
          : "",
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
      const stubCell = r.stubhub
        ? `<td><a href="${r.stubhub}" target="_blank" rel="noopener" ` +
          `title="Opens this game on StubHub; then pick section ${r.section} on the seat map">` +
          `Check §${r.section} ↗</a></td>`
        : `<td class="na">—</td>`;
      if (r.price == null) {
        tr.innerHTML =
          `<td><span class="badge">${r.level}</span> ${r.section}</td>` +
          `<td class="na" colspan="8">No block of this size found</td>`;
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
          `<td>${r.face != null ? fmtMoney(r.face) : "—"}</td>` +
          stubCell;
      }
      tbody.appendChild(tr);
    }
  }

  function renderGameTable(games, quotes, byGame) {
    const providerNames = window.PROVIDERS.map((p) => p.name);
    const byGameProvider = new Map();
    for (const q of quotes) {
      if (q.demo) continue;
      const key = q.gamePk + "|" + q.provider;
      const prev = byGameProvider.get(key);
      // Keep each provider's cheapest priced quote for the game (section-level
      // quotes count too); link-only quotes just fill otherwise-empty cells.
      if (q.price == null) {
        if (!prev) byGameProvider.set(key, q);
      } else if (!prev || prev.price == null || q.price < prev.price) {
        byGameProvider.set(key, q);
      }
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
    $("#gh-token").value = s.ghToken || "";

    $("#search-btn").addEventListener("click", runSearch);
    $("#refresh-btn").addEventListener("click", refreshPrices);
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
