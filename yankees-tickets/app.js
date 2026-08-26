/*
 * NYY Ticket Aggregator — orchestration and rendering.
 *
 * 1. Pull every remaining Yankees home game from the free MLB Stats API
 *    (statsapi.mlb.com, keyless and CORS-enabled).
 * 2. Ask each marketplace adapter (providers.js) for quotes at the chosen
 *    block size, and merge in prices collected out-of-browser by the scraper.
 * 3. Aggregate: for every stadium section, the single cheapest block across
 *    the games in scope and all marketplaces.
 *
 * Two search scopes share the same machinery: "all" (every remaining home
 * game) and "specific" (only the games ticked in the picker).
 */

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const TEAM_ID = 147; // New York Yankees
  const SETTINGS_KEY = "ytf-settings";
  const PRICE_HISTORY_KEY = "ytf-price-history"; // { "qty|section": price } from last run

  const state = {
    games: null,          // all remaining home games
    picked: null,         // Set of gamePk chosen in the specific-games picker
    sectionRows: [],
    sortKey: "section",
    sortAsc: true,
    lastQty: 2,
  };

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
    const note = $("#settings-saved");
    note.hidden = false;
    setTimeout(() => (note.hidden = true), 2500);
    return s;
  }

  function loadPriceHistory() {
    try {
      return JSON.parse(localStorage.getItem(PRICE_HISTORY_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePriceHistory(map) {
    try {
      localStorage.setItem(PRICE_HISTORY_KEY, JSON.stringify(map));
    } catch {
      /* storage full / disabled — arrows just won't show next time */
    }
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
    games.sort((a, b) => a.dateUTC - b.dateUTC);
    return games;
  }

  /* --------------------- cached / collected listings -------------------- */

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

  // Prices collected outside the browser, freshest source first:
  //  1. published/ in the scraper repo (needs the access key);
  //  2. this site's own data/ files (for visitors without a key).
  // A quantity-specific file (listings-4.json) wins over the generic one.
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

  // The cloud run writes "listings" (everything but StubHub); a home run
  // writes "listings-stubhub". Merge both.
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

  // Persistent face-value store: { "gamePk|section": number }. "Prices may
  // fluctuate, but face value is forever," so the scraper accumulates these.
  async function fetchFaceValues() {
    const { ghToken } = loadSettings();
    const sources = [];
    if (ghToken) {
      sources.push({
        url: `${SCRAPER_API}/contents/published/face-values.json?ref=main`,
        opts: { headers: ghHeaders(ghToken, true), cache: "no-cache" },
      });
    }
    sources.push({ url: "data/face-values.json", opts: { cache: "no-cache" } });
    for (const s of sources) {
      try {
        const res = await fetch(s.url, s.opts);
        if (!res.ok) continue;
        const data = await res.json();
        return data && typeof data === "object" ? data.faces || data : {};
      } catch {
        /* try next */
      }
    }
    return {};
  }

  /* --------------------------- refresh prices --------------------------- */

  let pollTimer = null;

  async function refreshPrices(scope) {
    const qty = readQty(scope);
    const { ghToken } = loadSettings();
    if (!ghToken) {
      selectTab("settings");
      $("#gh-token").focus();
      setStatus(
        "The Refresh button needs a one-time access key — add it in Settings " +
        "(opened for you), then press Save.",
        true
      );
      return;
    }
    $$(".refresh-btn").forEach((b) => (b.disabled = true));
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
        "Fresh prices will load here automatically when it finishes."
      );
      watchScrape(scope, qty, startedAt);
    } catch (err) {
      console.error(err);
      $$(".refresh-btn").forEach((b) => (b.disabled = false));
      setStatus(
        "Couldn't start the scraper: " + err.message +
        " — check the access key in Settings.",
        true
      );
    }
  }

  function watchScrape(scope, qty, startedAt) {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      const mins = Math.round((Date.now() - startedAt) / 60000);
      if (Date.now() - startedAt > 25 * 60000) {
        clearInterval(pollTimer);
        $$(".refresh-btn").forEach((b) => (b.disabled = false));
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
        $$(".refresh-btn").forEach((b) => (b.disabled = false));
        if (run.conclusion === "success") {
          setStatus("Scrape finished — loading fresh prices…");
          await runSearch(scope);
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

  function readQty(scope) {
    const el = scope === "specific" ? $("#qty-specific") : $("#qty-all");
    return Math.max(1, Math.min(12, parseInt(el.value, 10) || 2));
  }

  function gamesInScope(scope) {
    if (scope !== "specific") return state.games;
    const picked = state.picked || new Set();
    return state.games.filter((g) => picked.has(g.gamePk));
  }

  async function runSearch(scope) {
    if (!state.games) {
      try {
        state.games = await fetchRemainingHomeGames();
        renderGamePicker();
      } catch (err) {
        setStatus("Couldn't load the schedule: " + err.message, true);
        return;
      }
    }
    const qty = readQty(scope);
    state.lastQty = qty;
    const settings = loadSettings();
    const allGames = state.games;
    const games = gamesInScope(scope);

    if (!allGames.length) {
      setStatus("No remaining Yankees home games were found on the MLB schedule.", true);
      return;
    }
    if (!games.length) {
      setStatus("Pick at least one game to search.", true);
      return;
    }

    $$(".search-btn").forEach((b) => (b.disabled = true));
    setStatus(`Searching ${games.length} game${games.length > 1 ? "s" : ""} across ${window.PROVIDERS.length} marketplaces…`);

    try {
      // Provider adapters query all games; cached listings + face values too.
      const [cached, faces, ...results] = await Promise.allSettled([
        fetchCachedListings(qty),
        fetchFaceValues(),
        ...window.PROVIDERS.map((p) => p.search(allGames, qty, settings)),
      ]);

      const quotes = [];
      const failed = [];
      let cachedAt = null;

      const listings = cached.status === "fulfilled" ? cached.value : null;
      if (listings && Array.isArray(listings.quotes)) {
        quotes.push(...listings.quotes);
        cachedAt = listings.fetchedAt || null;
      }
      results.forEach((r, i) => {
        if (r.status === "fulfilled") quotes.push(...r.value);
        else {
          failed.push(window.PROVIDERS[i].name);
          console.error(window.PROVIDERS[i].name, r.reason);
        }
      });
      const faceMap = faces.status === "fulfilled" ? faces.value : {};

      render(allGames, games, quotes, qty, faceMap);

      let note = failed.length
        ? `Some sources failed and were skipped: ${failed.join(", ")}. `
        : "";
      if (cachedAt) {
        note += `Includes prices auto-collected ${new Date(cachedAt).toLocaleString()}. `;
      } else {
        note +=
          "No collected prices loaded yet for this block size — press " +
          "↻ Refresh prices to run the scraper, then they'll load here " +
          "automatically. Store links below work either way.";
      }
      setStatus(note || null, !!failed.length);
    } catch (err) {
      console.error(err);
      setStatus("Search failed: " + err.message, true);
    } finally {
      $$(".search-btn").forEach((b) => (b.disabled = false));
    }
  }

  /* ------------------------------ rendering ------------------------------ */

  function fmtMoney(v) {
    return v == null
      ? "—"
      : "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function render(allGames, scopeGames, quotes, qty, faceMap) {
    const byGame = new Map(allGames.map((g) => [g.gamePk, g]));
    const scopeSet = new Set(scopeGames.map((g) => g.gamePk));

    // Ticketmaster event-level minimum, a fallback face when the persistent
    // per-section store has nothing for that game.
    const tmFace = new Map();
    for (const q of quotes) {
      if (q.provider === "Ticketmaster" && q.faceValue != null && !tmFace.has(q.gamePk)) {
        tmFace.set(q.gamePk, q.faceValue);
      }
    }

    renderSectionTable(scopeGames, scopeSet, quotes, qty, byGame, tmFace, faceMap);
    renderGameTable(scopeGames, quotes);
  }

  // Look up a stored face value for a game/section, trying the section's
  // canonical code and its raw form.
  function faceFor(faceMap, gamePk, cls, rawSection, tmFace) {
    const keys = [`${gamePk}|${cls.code}`, `${gamePk}|${rawSection}`];
    for (const k of keys) {
      if (faceMap && faceMap[k] != null) return faceMap[k];
    }
    return tmFace.get(gamePk) ?? null;
  }

  function renderSectionTable(games, scopeSet, quotes, qty, byGame, tmFace, faceMap) {
    const wrap = $("#section-results");
    const soonest = games[0]; // games are date-sorted; used for empty-row StubHub links

    // Union of every real section seen anywhere in the data (all games), so
    // sections with no block in the current scope still get a row + StubHub
    // link. Fold raw codes to canonical form to kill duplicates.
    const canon = new Map(); // code -> classified
    for (const q of quotes) {
      if (!q.section) continue;
      const cls = window.Sections.classify(q.section);
      if (!cls.code) continue;
      if (!canon.has(cls.code)) canon.set(cls.code, cls);
    }

    if (!canon.size) {
      wrap.hidden = true;
      return;
    }

    // Cheapest in-scope block per canonical section.
    const best = new Map(); // code -> { q, cls }
    for (const q of quotes) {
      if (!q.section || q.price == null) continue;
      if (!scopeSet.has(q.gamePk)) continue;
      const cls = window.Sections.classify(q.section);
      if (!cls.code) continue;
      const cur = best.get(cls.code);
      if (!cur || q.price < cur.q.price) best.set(cls.code, { q, cls });
    }

    const history = loadPriceHistory();
    const nextHistory = {};

    state.sectionRows = [...canon.values()].map((cls) => {
      const hit = best.get(cls.code);
      const q = hit ? hit.q : null;
      const game = q ? byGame.get(q.gamePk) : null;
      const face = q
        ? faceFor(faceMap, q.gamePk, cls, q.section, tmFace)
        : null;
      const price = q ? q.price : null;

      // Price-change arrow vs the previous run at this block size.
      const histKey = `${qty}|${cls.code}`;
      const prev = history[histKey];
      let trend = 0; // -1 down, +1 up, 0 same/new
      if (price != null && prev != null) {
        if (price < prev - 0.005) trend = -1;
        else if (price > prev + 0.005) trend = 1;
      }
      if (price != null) nextHistory[histKey] = price;

      // StubHub link: this game if we have one, else the soonest in scope.
      const linkGame = game || soonest;

      return {
        code: cls.code,
        cls,
        level: cls.level,
        label: cls.label,
        num: cls.num,
        price,
        trend,
        total: price != null ? price * qty : null,
        face,
        pctFace: price != null && face ? (price / face) * 100 : null,
        date: game ? game.dateUTC.getTime() : null,
        dateLabel: game ? game.displayET : "",
        opponent: game ? game.opponent : "",
        provider: q ? q.provider : "",
        url: q ? q.url : "",
        stubhub: linkGame
          ? window.stubhubLink(linkGame.gamePk, qty, linkGame.opponent, linkGame.dateShort)
          : "",
        stubSection: cls.code,
      };
    });

    savePriceHistory(nextHistory);

    $("#section-sub").textContent =
      `— block of ${qty} ticket${qty > 1 ? "s" : ""}, cheapest across ` +
      `${games.length} game${games.length > 1 ? "s" : ""} in scope`;
    sortAndPaintSections();
    wrap.hidden = false;
  }

  // Map a % of face value to a green→red gradient across the visible range.
  function pctColor(pct, lo, hi) {
    if (pct == null) return "";
    let t = hi > lo ? (pct - lo) / (hi - lo) : 0;
    t = Math.max(0, Math.min(1, t));
    const hue = 120 - 120 * t; // 120 green → 0 red
    return `hsl(${hue}, 70%, 38%)`;
  }

  function sortAndPaintSections() {
    const { sortKey, sortAsc } = state;
    const rows = [...state.sectionRows];

    rows.sort((a, b) => {
      if (sortKey === "section") {
        const c = window.Sections.compare(a.cls, b.cls);
        return sortAsc ? c : -c;
      }
      let va = a[sortKey], vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;  // nulls sink regardless of direction
      if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sortAsc ? c : -c;
    });

    // % of face gradient bounds across rows that have a value.
    const pcts = rows.map((r) => r.pctFace).filter((v) => v != null);
    const lo = pcts.length ? Math.min(...pcts) : 0;
    const hi = pcts.length ? Math.max(...pcts) : 1;

    const tbody = $("#section-table tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");

      const stubCell =
        `<td><a href="${r.stubhub}" target="_blank" rel="noopener" ` +
        `title="Opens a game on StubHub; then pick section ${r.code} on the seat map">` +
        `Check §${r.code} ↗</a></td>`;

      const sectionCell =
        `<td><span class="badge lvl-${r.level.replace(/\s/g, "")}">${r.level}</span> ${r.code}` +
        (r.cls.obstructed ? ' <span class="obstructed">obstructed</span>' : "") +
        `</td>`;

      if (r.price == null) {
        tr.innerHTML =
          sectionCell +
          `<td class="na" colspan="7">No block of ${state.lastQty} found in scope</td>` +
          stubCell;
      } else {
        const arrow =
          r.trend < 0 ? '<span class="trend down">▼</span>'
          : r.trend > 0 ? '<span class="trend up">▲</span>'
          : "";
        const priceCls =
          r.trend < 0 ? "price down" : r.trend > 0 ? "price up" : "price";
        const pctStyle = r.pctFace != null
          ? ` style="color:${pctColor(r.pctFace, lo, hi)};font-weight:700"`
          : "";
        const pctText = r.pctFace != null ? Math.round(r.pctFace) + "%" : "—";
        tr.innerHTML =
          sectionCell +
          `<td class="${priceCls}">${arrow}${fmtMoney(r.price)}</td>` +
          `<td${pctStyle}>${pctText}</td>` +
          `<td>${fmtMoney(r.total)}</td>` +
          `<td>${r.face != null ? fmtMoney(r.face) : "—"}</td>` +
          `<td>${r.dateLabel}</td>` +
          `<td>${r.opponent}</td>` +
          `<td>${r.provider}</td>` +
          `<td><a href="${r.url}" target="_blank" rel="noopener">View →</a></td>` +
          stubCell;
      }
      tbody.appendChild(tr);
    }
  }

  function renderGameTable(games, quotes) {
    // Provider columns ordered alphabetically by site name.
    const providerNames = window.PROVIDERS.map((p) => p.name)
      .sort((a, b) => a.localeCompare(b));

    const byGameProvider = new Map();
    for (const q of quotes) {
      const key = q.gamePk + "|" + q.provider;
      const prev = byGameProvider.get(key);
      if (q.price == null) {
        if (!prev) byGameProvider.set(key, q);
      } else if (!prev || prev.price == null || q.price < prev.price) {
        byGameProvider.set(key, q);
      }
    }

    // Header: Game | Date | <providers…>
    const head = $("#game-head");
    head.innerHTML =
      "<th>Game</th><th>Date &amp; time</th>" +
      providerNames.map((n) => `<th>${n}</th>`).join("");

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

  /* --------------------------- game picker ------------------------------ */

  function renderGamePicker() {
    const host = $("#game-list");
    if (!state.games) return;
    if (!state.picked) state.picked = new Set(state.games.map((g) => g.gamePk));
    host.innerHTML = "";
    for (const g of state.games) {
      const id = "game-" + g.gamePk;
      const row = document.createElement("label");
      row.className = "game-opt";
      row.innerHTML =
        `<input type="checkbox" id="${id}" value="${g.gamePk}" ` +
        `${state.picked.has(g.gamePk) ? "checked" : ""}>` +
        `<span class="g-date">${g.displayET}</span>` +
        `<span class="g-opp">vs ${g.opponent}</span>`;
      row.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) state.picked.add(g.gamePk);
        else state.picked.delete(g.gamePk);
      });
      host.appendChild(row);
    }
  }

  function setAllPicked(on) {
    if (!state.games) return;
    state.picked = new Set(on ? state.games.map((g) => g.gamePk) : []);
    $$("#game-list input[type=checkbox]").forEach((cb) => (cb.checked = on));
  }

  /* ------------------------------- tabs --------------------------------- */

  function selectTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $("#panel-all").hidden = name !== "all";
    $("#panel-specific").hidden = name !== "specific";
    $("#panel-settings").hidden = name !== "settings";
    // Results hide on the Settings tab (settings only), reappear elsewhere.
    const showResults = name !== "settings";
    const secHas = $("#section-table tbody").children.length > 0;
    const gameHas = $("#game-table tbody").children.length > 0;
    $("#section-results").hidden = !(showResults && secHas);
    $("#game-results").hidden = !(showResults && gameHas);
  }

  /* --------------------------- stadium map ------------------------------ */

  const LEVEL_COLORS = {
    Legends: "#b3132a", Field: "#0c2340", Main: "#1c7a3f",
    Bleachers: "#8a6d1f", Terrace: "#5a3a8a", Grandstand: "#0f5f78",
  };

  function stadiumMapSVG() {
    // Concentric decks, home plate at the bottom — a quick orientation aid.
    const decks = [
      { level: "Grandstand", ry: 150, label: "Grandstand (400s)" },
      { level: "Terrace",    ry: 122, label: "Terrace (300s)" },
      { level: "Main",       ry: 96,  label: "Main / Bleachers (200s)" },
      { level: "Field",      ry: 70,  label: "Field (100s)" },
      { level: "Legends",    ry: 44,  label: "Legends (infield)" },
    ];
    const rings = decks.map((d) =>
      `<ellipse cx="200" cy="150" rx="${d.ry * 1.35}" ry="${d.ry}" ` +
      `fill="${LEVEL_COLORS[d.level]}" fill-opacity="0.85" stroke="#fff" stroke-width="2"/>`
    ).join("");
    const legend = decks.map((d, i) =>
      `<g transform="translate(300,${40 + i * 22})">` +
      `<rect width="14" height="14" rx="3" fill="${LEVEL_COLORS[d.level]}"/>` +
      `<text x="20" y="12" font-size="12" fill="#1b2733">${d.label}</text></g>`
    ).join("");
    return (
      `<svg viewBox="0 0 440 320" width="100%" role="img" aria-label="Yankee Stadium seating levels">` +
      `<rect width="440" height="320" fill="#f5f6f8"/>` +
      rings +
      `<circle cx="200" cy="150" r="6" fill="#fff" stroke="#1b2733"/>` +
      `<polygon points="200,236 192,244 200,252 208,244" fill="#fff" stroke="#1b2733"/>` +
      `<text x="200" y="270" font-size="12" text-anchor="middle" fill="#1b2733">Home plate</text>` +
      legend +
      `</svg>`
    );
  }

  function openMap() {
    $("#map-holder").innerHTML = stadiumMapSVG();
    $("#map-modal").hidden = false;
  }
  function closeMap() {
    $("#map-modal").hidden = true;
  }

  /* -------------------------------- wiring ------------------------------- */

  document.addEventListener("DOMContentLoaded", () => {
    const s = loadSettings();
    $("#tm-key").value = s.tmKey || "";
    $("#sg-key").value = s.sgKey || "";
    $("#gh-token").value = s.ghToken || "";

    $$(".tab").forEach((t) =>
      t.addEventListener("click", () => selectTab(t.dataset.tab))
    );

    $$(".search-btn").forEach((b) =>
      b.addEventListener("click", () => runSearch(b.dataset.scope))
    );
    $$(".refresh-btn").forEach((b) =>
      b.addEventListener("click", () => refreshPrices(b.dataset.scope))
    );
    $$(".qty").forEach((el) =>
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const scope = el.id === "qty-specific" ? "specific" : "all";
          runSearch(scope);
        }
      })
    );

    $("#save-settings").addEventListener("click", saveSettings);

    $("#pick-all").addEventListener("click", (e) => { e.preventDefault(); setAllPicked(true); });
    $("#pick-none").addEventListener("click", (e) => { e.preventDefault(); setAllPicked(false); });

    $("#open-map").addEventListener("click", (e) => { e.preventDefault(); openMap(); });
    $("#map-close").addEventListener("click", closeMap);
    $("#map-modal").addEventListener("click", (e) => {
      if (e.target.id === "map-modal") closeMap();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMap();
    });

    $$("#section-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) state.sortAsc = !state.sortAsc;
        else { state.sortKey = key; state.sortAsc = true; }
        if (state.sectionRows.length) sortAndPaintSections();
      });
    });

    // Populate the game picker up front so the "specific" tab is usable.
    fetchRemainingHomeGames()
      .then((games) => { state.games = games; renderGamePicker(); })
      .catch((err) => {
        $("#game-list").textContent = "Couldn't load games: " + err.message;
      });
  });
})();
