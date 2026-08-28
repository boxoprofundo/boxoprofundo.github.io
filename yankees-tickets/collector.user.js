// ==UserScript==
// @name         NYY Aggregator — SeatGeek + StubHub collector
// @namespace    boxoprofundo.github.io/yankees-tickets
// @version      2.3.0
// @description  Scrapes SeatGeek and StubHub Yankees prices from YOUR real logged-in browser (where they render normally) and publishes them to the aggregator. Both sites block automated browsers, so this is the only way to get their per-section prices.
// @author       boxoprofundo
// @updateURL    https://boxoprofundo.github.io/yankees-tickets/collector.user.js
// @downloadURL  https://boxoprofundo.github.io/yankees-tickets/collector.user.js
// @match        https://boxoprofundo.github.io/yankees-tickets/*
// @match        https://www.stubhub.com/*
// @match        https://seatgeek.com/*
// @match        https://www.seatgeek.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// @run-at       document-start
// ==/UserScript==

/*
 * Why this exists: SeatGeek and StubHub serve *automation* browsers a blank or
 * blocked page, but your real Chrome renders them fine. This userscript runs
 * their scrape inside your genuine browser session, so the listings are there
 * to read, then commits them to the site via the GitHub token you saved in
 * Settings. The site merges listings-seatgeek-<qty>.json and
 * listings-stubhub-<qty>.json like every other source.
 *
 * It only works in the browser where it's installed. Refreshing from a phone
 * still updates the other five sites — just not these two.
 *
 * First-run note for SeatGeek: the very first SeatGeek run also publishes a
 * small diagnostic (yankees-tickets/data/_seatgeek-diag.json) describing the
 * page's listing structure, so the parser can be tuned to the real markup.
 */

(function () {
  "use strict";

  const PAGES_REPO = "boxoprofundo/boxoprofundo.github.io";
  const JOB_TTL = 30 * 60000;

  /* ── StubHub event map (gamePk -> URL) ──────────────────────────────── */
  const SH = (slug, id) =>
    `https://www.stubhub.com/new-york-yankees-bronx-tickets-${slug}/event/${id}/`;
  const STUBHUB_EVENTS = {
    823505: SH("8-25-2026", 159257453), 823506: SH("8-26-2026", 159257454),
    823503: SH("8-27-2026", 159257455), 823504: SH("8-28-2026", 159257456),
    823539: SH("8-29-2026", 159257421), 823501: SH("8-29-2026", 159257457),
    823502: SH("8-30-2026", 159257458), 823500: SH("9-8-2026", 159257459),
    823497: SH("9-9-2026", 159257460),  823499: SH("9-10-2026", 159257461),
    823498: SH("9-11-2026", 159257462), 823496: SH("9-12-2026", 159257463),
    823495: SH("9-13-2026", 159257464), 823543: SH("9-22-2026", 159257415),
    823494: SH("9-22-2026", 159257465), 823492: SH("9-23-2026", 159257466),
    823493: SH("9-24-2026", 159257467), 823491: SH("9-25-2026", 159257468),
    823489: SH("9-26-2026", 159257469), 823490: SH("9-27-2026", 159257470),
  };
  const SH_ID_TO_GAME = {};
  for (const [pk, url] of Object.entries(STUBHUB_EVENTS)) {
    const m = url.match(/event\/(\d+)/);
    if (m) SH_ID_TO_GAME[m[1]] = Number(pk);
  }

  /* ── SeatGeek event map ──────────────────────────────────────────────
   * SeatGeek doesn't expose gamePk, so each event page's real date+time is
   * read from __NEXT_DATA__ and mapped to a gamePk here. That makes the map
   * self-correcting: even a guessed eventId only contributes if its actual
   * date matches a Yankees home game. Confirmed eventIds come from the team
   * page harvest; 17691597–17691600 are sequential guesses for 9/24–9/27
   * (validated on load).                                                     */
  const SGU = (d, id) =>
    `https://seatgeek.com/new-york-yankees-tickets/${d}-bronx-new-york-yankee-stadium/mlb/${id}`;
  const SEATGEEK_URLS = [
    SGU("8-28-2026", 17691586), SGU("8-29-2026", 17691587), SGU("8-29-2026", 17691551),
    SGU("8-30-2026", 17691588), SGU("9-8-2026", 17691589),  SGU("9-9-2026", 17691590),
    SGU("9-10-2026", 17691591), SGU("9-11-2026", 17691592), SGU("9-12-2026", 17691593),
    SGU("9-13-2026", 17691594), SGU("9-22-2026", 17691595), SGU("9-22-2026", 17691545),
    SGU("9-23-2026", 17691596), SGU("9-24-2026", 17691597), SGU("9-25-2026", 17691598),
    SGU("9-26-2026", 17691599), SGU("9-27-2026", 17691600),
  ];
  // Single-game dates -> gamePk (derived from the StubHub date slugs).
  const SG_PK_BY_DATE = {
    "2026-08-28": 823504, "2026-08-30": 823502, "2026-09-08": 823500,
    "2026-09-09": 823497, "2026-09-10": 823499, "2026-09-11": 823498,
    "2026-09-12": 823496, "2026-09-13": 823495, "2026-09-23": 823492,
    "2026-09-24": 823493, "2026-09-25": 823491, "2026-09-26": 823489,
    "2026-09-27": 823490,
  };
  // Doubleheaders: day game (≈1pm) vs night game (≈7pm).
  const SG_PK_DH = {
    "2026-08-29": { day: 823539, night: 823501 },
    "2026-09-22": { day: 823543, night: 823494 },
  };
  function sgGamePk(date, hour) {
    if (!date) return null;
    if (SG_PK_DH[date]) return (hour != null && hour < 16) ? SG_PK_DH[date].day : SG_PK_DH[date].night;
    return SG_PK_BY_DATE[date] || null;
  }
  // Normalize a SeatGeek section slug to a plain section id that matches the
  // other providers: "bleachers-204"->"204", "320-b"->"320", "318"->"318".
  function normSGSection(raw) {
    let s = String(raw || "").trim().toLowerCase();
    s = s.replace(/^(sections?|sec)[-_ ]+/, "");
    const m = s.match(/\d{1,3}/);
    if (m) return m[0];
    const named = s.replace(/[^a-z0-9]+/g, " ").trim().toUpperCase();
    return named ? named.slice(0, 14) : null;
  }

  const host = location.host;
  const onStubHub = host.includes("stubhub.com");
  const onSeatGeek = host.includes("seatgeek.com");
  const onAggregator = host.includes("boxoprofundo.github.io");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ════════════════════════ StubHub worker ═══════════════════════════════ */
  if (onStubHub) {
    const idMatch = location.pathname.match(/event\/(\d+)/);
    const gamePk = idMatch ? SH_ID_TO_GAME[idMatch[1]] : null;
    const job = GM_getValue("yk_sh_job", null);
    if (gamePk && job && job.active && (Date.now() - job.startedAt) < JOB_TTL) {
      stubhubWorker(gamePk).catch((e) => console.error("[collector/StubHub]", e));
    }
    return;
  }

  async function stubhubWorker(pk) {
    for (let i = 0; i < 40; i++) {
      const t = document.body ? document.body.innerText : "";
      if ((t.match(/\$\s*\d{2,}/g) || []).length >= 3) break;
      await sleep(300);
    }
    for (let round = 0; round < 15; round++) {
      if (!clickMore(["show more", "view more", "load more", "see more", "show all"])) break;
      await sleep(1400);
    }
    const body = document.body ? document.body.innerText : "";
    const SECTION_CODE = "(?:NORD[A-Za-z0-9]*|FLOOR[A-Za-z0-9]*|[A-Za-z]*\\d[A-Za-z0-9]*|[A-Z]{1,2})";
    const url = STUBHUB_EVENTS[pk];
    const re = new RegExp("(?=\\bSection\\s+" + SECTION_CODE + "\\b)");
    const bySec = {};
    for (const chunk of body.split(re)) {
      const sm = chunk.match(new RegExp("^\\bSection\\s+(" + SECTION_CODE + ")\\b"));
      if (!sm) continue;
      const sec = sm[1].trim().toUpperCase();
      const fees = chunk.match(/incl\.?\s*fees/i);
      if (!fees) continue;
      const before = chunk.slice(0, fees.index);
      const pm = [...before.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
      if (!pm.length) continue;
      const price = parseFloat(pm[pm.length - 1][1].replace(/,/g, ""));
      if (!(price > 5 && price < 50000)) continue;
      const obstructed = /obstruct/i.test(chunk.slice(0, (fees.index || 0) + 20));
      if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
    }
    const quotes = Object.entries(bySec).map(([sec, v]) => ({
      gamePk: pk, provider: "StubHub",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100, faceValue: null, url,
    }));
    console.log(`[collector/StubHub] game ${pk}: ${quotes.length} sections`);
    GM_setValue("yk_sh_result_" + pk, { ts: Date.now(), quotes });
  }

  /* ════════════════════════ SeatGeek worker ══════════════════════════════ */
  if (onSeatGeek) {
    const job = GM_getValue("yk_sg_job", null);
    const active = job && job.active && (Date.now() - job.startedAt) < JOB_TTL;
    // The team page is used to harvest event URLs; event pages to scrape.
    const isEvent = /\/\d{6,}(?:\?|$|\/)/.test(location.pathname);
    if (active && isEvent) {
      // SeatGeek loads per-section listings over the network AFTER page load —
      // they're not in __NEXT_DATA__ — so install a page-context capture of
      // fetch/XHR responses NOW (document-start), before the page calls them.
      installSGNetHook();
      seatgeekWorker().catch((e) => console.error("[collector/SeatGeek]", e));
    } else if (active && /yankees-tickets|new-york-yankees/.test(location.pathname)) {
      // Harvest runs on the team page after render.
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", () =>
          seatgeekHarvest().catch((e) => console.error("[collector/SeatGeek harvest]", e)));
      else seatgeekHarvest().catch((e) => console.error("[collector/SeatGeek harvest]", e));
    }
    return;
  }

  // Inject a page-context hook that records fetch/XHR responses whose bodies
  // look like ticket listings, into a hidden DOM node the worker reads. Runs in
  // the page's real context (not the userscript sandbox) so it wraps the actual
  // window.fetch / XMLHttpRequest the SeatGeek bundle uses.
  function installSGNetHook() {
    try {
      const code = `(function(){
        if (window.__ykSGHooked) return; window.__ykSGHooked = 1;
        function sink(url, text){
          try{
            if(!text || text.length < 40) return;
            if(!/"section"|section_id|"lp"|"dp"|"price|listings?"/i.test(text)) return;
            var el = document.getElementById("__yk_sg_cap");
            if(!el){ el=document.createElement("div"); el.id="__yk_sg_cap"; el.style.display="none";
                     (document.documentElement||document.body).appendChild(el); }
            el.setAttribute("data-count", String((+el.getAttribute("data-count")||0)+1));
            el.textContent += "\\n@@YKREC@@" + JSON.stringify({url:String(url||""), body:text.slice(0,3000000)});
          }catch(e){}
        }
        var of = window.fetch;
        if(of){ window.fetch = function(){ var a=arguments;
          return of.apply(this,a).then(function(r){ try{ r.clone().text().then(function(t){ sink(r.url||a[0], t); }); }catch(e){} return r; }); }; }
        var XO=XMLHttpRequest.prototype.open, XS=XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open=function(m,u){ this.__ykUrl=u; return XO.apply(this,arguments); };
        XMLHttpRequest.prototype.send=function(){ var x=this;
          this.addEventListener("load", function(){ try{ sink(x.__ykUrl, x.responseText); }catch(e){} });
          return XS.apply(this,arguments); };
      })();`;
      const s = document.createElement("script");
      s.textContent = code;
      (document.documentElement || document.head || document.body).appendChild(s);
      s.remove();
    } catch (e) { console.error("[collector/SeatGeek] hook install failed", e); }
  }

  // Read + clear captured network records from the hidden sink node.
  function readSGCaptures() {
    const el = document.getElementById("__yk_sg_cap");
    if (!el) return [];
    const raw = el.textContent || "";
    return raw.split("@@YKREC@@").slice(1).map((r) => {
      try { return JSON.parse(r); } catch (e) { return null; }
    }).filter(Boolean);
  }

  // Harvest home-game event URLs from the SeatGeek Yankees team page (real
  // browser renders it). Primary source is the Next.js __NEXT_DATA__ blob
  // (reliable); DOM anchors are a fallback. Always emits a rich diagnostic so
  // the team-page structure is visible even when nothing is harvested.
  async function seatgeekHarvest() {
    for (let i = 0; i < 40; i++) {
      const t = document.body ? document.body.innerText : "";
      if (/\$\s*\d/.test(t) || document.querySelectorAll("a[href]").length > 40) break;
      await sleep(300);
    }
    const diag = { url: location.href };
    try { diag.title = document.title; } catch (e) {}
    const bodyText = document.body ? document.body.innerText : "";
    diag.body_len = bodyText.length;
    diag.blocked = /are you a robot|verify you are human|captcha|access denied|pardon the interruption/i.test(bodyText);

    const rows = [], seen = new Set();
    const pushRow = (url, text) => {
      if (!url) return;
      url = String(url).replace(/\\\//g, "/").split("?")[0];
      if (!/^https?:\/\/(www\.)?seatgeek\.com\//.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url); rows.push({ url, text: (text || "").slice(0, 90) });
    };

    // Primary: parse __NEXT_DATA__ and deep-walk for event-like objects.
    const ndEl = document.getElementById("__NEXT_DATA__");
    diag.next_present = !!ndEl;
    let nd = null;
    if (ndEl) {
      diag.next_len = (ndEl.textContent || "").length;
      try { nd = JSON.parse(ndEl.textContent); }
      catch (e) { diag.next_parse_err = String(e).slice(0, 100); }
    }
    const eventSamples = [];
    if (nd) {
      const stack = [nd]; let steps = 0;
      while (stack.length && steps < 300000) {
        steps++;
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        const url = o.url || o.href;
        const title = o.title || o.short_title || o.name;
        const venue = o.venue || {};
        const vname = (venue && (venue.name || venue.name_v2)) || "";
        const vcity = (venue && venue.city) || "";
        const looksEvent =
          (typeof url === "string" && /seatgeek\.com\/.+\/\d{5,}/.test(url)) ||
          (o.id && title && /yankee/i.test(String(title)));
        if (looksEvent) {
          const home = /yankee stadium/i.test(vname) || /bronx/i.test(vcity) ||
            /yankees tickets|vs\.?\s*.*yankees|yankees\s*vs/i.test(String(title || url));
          if (home && typeof url === "string") pushRow(url, title);
          if (eventSamples.length < 6) eventSamples.push({
            id: o.id, title: String(title).slice(0, 60), url: String(url).slice(0, 120),
            vname, vcity, dt: o.datetime_utc || o.datetime_local || o.datetime,
          });
        }
        for (const k in o) { const v = o[k]; if (v && typeof v === "object") stack.push(v); }
      }
    }
    diag.next_event_samples = eventSamples;

    // Secondary: regex event URLs straight out of the raw blob.
    if (ndEl) {
      const raw = ndEl.textContent || "";
      const re = /"url":"(https:[^"]*?\/\d{5,})"/g;
      let m, c = 0;
      while ((m = re.exec(raw)) && c < 80) { c++; const u = m[1]; if (/yankee/i.test(u)) pushRow(u); }
      diag.next_url_hits = c;
    }

    // Fallback + diagnostic: DOM anchors.
    const anchors = [...document.querySelectorAll("a[href]")].map((a) => ({
      href: a.getAttribute("href") || "", text: (a.innerText || "").trim().slice(0, 50),
    }));
    diag.anchor_count = anchors.length;
    diag.anchor_samples = anchors.filter((a) => /\/\d{5,}/.test(a.href)).slice(0, 15);
    anchors.forEach((a) => {
      if (/\/\d{5,}(?:\?|$|\/)/.test(a.href) && /yankee|bronx/i.test(a.text + " " + a.href)) {
        pushRow(a.href.startsWith("http") ? a.href : "https://seatgeek.com" + a.href, a.text);
      }
    });

    diag.rows_found = rows.length;
    console.log(`[collector/SeatGeek harvest] ${rows.length} event links`, diag);
    GM_setValue("yk_sg_harvest", { ts: Date.now(), rows, diag });
  }

  async function seatgeekWorker() {
    // Per-section listings arrive over the NETWORK after load (not in the DOM
    // or __NEXT_DATA__). installSGNetHook() (called at document-start) records
    // those responses into a hidden node; here we wait for them, parse each,
    // and deep-walk for listing objects (a string `section` + a price). The
    // event's date/time still comes from __NEXT_DATA__, for the gamePk.
    const diag = { url: location.href };
    const bySec = {};
    let sampleListing = null, sampleSection = null, listingCount = 0;

    const PRICE_KEYS = ["price", "pf", "display_price", "lowest_price",
      "list_price", "p", "amount", "total_price", "dp", "sp", "ep"];
    const readPrice = (o) => {
      for (const k of PRICE_KEYS) {
        let v = o[k];
        if (v == null) continue;
        if (typeof v === "object")
          v = (v.total != null ? v.total : v.amount != null ? v.amount :
               v.value != null ? v.value : v.price);
        const n = typeof v === "string" ? parseFloat(v.replace(/[^\d.]/g, "")) : Number(v);
        if (isFinite(n) && n > 3 && n < 100000) return n;
      }
      return null;
    };
    // Deep-walk one parsed JSON root, folding any listing objects into bySec.
    const walk = (root) => {
      const stack = [root]; let steps = 0;
      while (stack.length && steps < 800000) {
        steps++;
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        if (Array.isArray(o)) {
          for (const v of o) if (v && typeof v === "object") stack.push(v);
          continue;
        }
        const secRaw = (typeof o.section === "string" && o.section) ? o.section :
          (typeof o.section_id === "string" && o.section_id) ? o.section_id : null;
        // Ignore i18n template strings like "Section {{section}}".
        if (secRaw && !/\{\{|\}\}/.test(secRaw)) {
          if (!sampleSection) sampleSection = JSON.stringify(o).slice(0, 900);
          const price = readPrice(o);
          if (price != null) {
            listingCount++;
            if (!sampleListing) sampleListing = JSON.stringify(o).slice(0, 900);
            const sec = normSGSection(secRaw);
            if (sec) {
              const meta = JSON.stringify(o.deal_types || o.tags || o.notes || o.disclosures || o.dp || "");
              const obstructed = /obstruct|limited/i.test(meta);
              if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
            }
          }
        }
        for (const k in o) { const v = o[k]; if (v && typeof v === "object") stack.push(v); }
      }
    };

    // 1) Event date/hour from __NEXT_DATA__ (present at load), for gamePk.
    let eventDate = null, eventHour = null, eventTitle = null;
    for (let i = 0; i < 30; i++) {
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd && (nd.textContent || "").length > 20000) break;
      await sleep(200);
    }
    try {
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd) {
        diag.next_len = (nd.textContent || "").length;
        const data = JSON.parse(nd.textContent);
        const st = [data]; let steps = 0;
        while (st.length && steps < 400000 && !eventDate) {
          steps++;
          const o = st.pop();
          if (!o || typeof o !== "object") continue;
          if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") st.push(v); continue; }
          const dt = o.datetime_local || o.datetime_utc || o.datetime;
          if (typeof dt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(dt) &&
              /yankee/i.test(JSON.stringify(o.title || o.short_title || o.name || ""))) {
            eventDate = dt.slice(0, 10);
            eventHour = parseInt(dt.slice(11, 13), 10);
            eventTitle = String(o.title || o.short_title || o.name || "").slice(0, 80);
            break;
          }
          for (const k in o) { const v = o[k]; if (v && typeof v === "object") st.push(v); }
        }
      }
    } catch (e) { diag.next_err = String(e).slice(0, 160); }

    // 2) Wait for the network capture to populate, nudging the page to load
    //    listings (scroll; the map's listing panel loads on view).
    let caps = [];
    for (let i = 0; i < 50; i++) {                    // up to ~25s
      caps = readSGCaptures();
      if (caps.length && Object.keys(bySec).length) break;
      // (re)parse whatever we have so far
      for (const c of caps) { try { walk(JSON.parse(c.body)); } catch (e) {} }
      if (Object.keys(bySec).length) break;
      if (i % 4 === 0) { window.scrollTo(0, document.body.scrollHeight); }
      if (i % 6 === 3) { try { clickMore(["all areas", "list", "list view", "lowest price", "sort"]); } catch (e) {} }
      await sleep(500);
    }
    caps = readSGCaptures();
    for (const c of caps) { try { walk(JSON.parse(c.body)); } catch (e) {} }

    const quotes = Object.entries(bySec).map(([sec, v]) => ({
      provider: "SeatGeek",
      section: v.obstructed ? `${sec} (obstructed)` : sec,
      price: Math.round(v.price * 100) / 100, faceValue: null,
    }));

    diag.cap_count = caps.length;
    diag.cap_urls = caps.map((c) => String(c.url).split("?")[0]).slice(0, 12);
    diag.listing_count = listingCount;
    diag.sections = quotes.length;
    diag.sample_listing = sampleListing;
    diag.sample_section = sampleSection;
    // If nothing parsed, keep a trimmed sample of the most listing-like body.
    if (!quotes.length && caps.length) {
      const best = caps.slice().sort((a, b) =>
        (b.body.match(/"section"/g) || []).length - (a.body.match(/"section"/g) || []).length)[0];
      diag.cap_body_head = best ? { url: String(best.url).split("?")[0], head: best.body.slice(0, 1200) } : null;
    }
    diag.event_date = eventDate;
    diag.event_hour = eventHour;
    diag.event_title = eventTitle;

    console.log(`[collector/SeatGeek] ${quotes.length} sections, date=${eventDate}, caps=${caps.length}`, diag);
    const eid = (location.pathname.match(/\/(\d{5,})/) || [])[1] || location.href;
    GM_setValue("yk_sg_result_" + eid, { ts: Date.now(), quotes, eventDate, eventHour, diag });
  }

  /* ── shared: click a "show more"-style control ──────────────────────── */
  function clickMore(labels) {
    window.scrollTo(0, document.body.scrollHeight);
    const els = document.querySelectorAll('button, a, [role="button"], div[tabindex], span[tabindex]');
    for (const el of els) {
      const t = (el.innerText || "").trim().toLowerCase();
      if (labels.includes(t)) { el.scrollIntoView({ block: "center" }); el.click(); return true; }
    }
    return false;
  }

  /* ════════════════════════ Aggregator controller ════════════════════════ */
  if (!onAggregator) return;

  function settings() {
    try { return JSON.parse(localStorage.getItem("ytf-settings")) || {}; }
    catch { return {}; }
  }
  function qtyNow() {
    const el = document.querySelector("#qty-all") || document.querySelector("#qty-specific");
    return Math.max(1, Math.min(12, parseInt(el && el.value, 10) || 2));
  }

  async function ghApi(method, path, body) {
    const token = settings().ghToken;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url: "https://api.github.com/repos/" + PAGES_REPO + path,
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => resolve({ status: r.status, json: safeJson(r.responseText) }),
        onerror: (e) => reject(e),
      });
    });
  }
  function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }

  async function putFile(path, obj, message) {
    let sha;
    const cur = await ghApi("GET", path + "?ref=main");
    if (cur.status === 200 && cur.json && cur.json.sha) sha = cur.json.sha;
    const res = await ghApi("PUT", path, {
      message, content: b64(JSON.stringify(obj, null, 2) + "\n"), sha, branch: "main",
    });
    if (res.status >= 300) throw new Error("GitHub PUT " + res.status + " for " + path);
  }

  let chip;
  function setChip(text, busy) {
    if (!chip) {
      chip = document.createElement("div");
      chip.style.cssText =
        "position:fixed;right:12px;bottom:12px;z-index:9999;background:#0c2340;color:#fff;" +
        "font:600 12px/1.35 -apple-system,system-ui,sans-serif;padding:.5rem .7rem;border-radius:8px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:17rem;cursor:pointer;";
      chip.title = "SeatGeek + StubHub collector (this browser). Click to run both now.";
      chip.addEventListener("click", () => runAll());
      document.body.appendChild(chip);
    }
    chip.textContent = (busy ? "⏳ " : "🎟️ ") + text;
  }

  // Generic game-cycler: opens each URL in a background tab, waits for the
  // worker in that tab to post a result under `resultKey(key)`, collects them.
  async function cycle(label, jobKey, entries, resultKey, stampUrl) {
    const qty = qtyNow();
    GM_setValue(jobKey, { active: true, startedAt: Date.now() });
    entries.forEach(([k]) => GM_deleteValue(resultKey(k)));
    const collected = [];
    for (let i = 0; i < entries.length; i++) {
      const [key, url, gamePk] = entries[i];
      setChip(`${label} ${i + 1}/${entries.length}…`, true);
      const tab = GM_openInTab(url + (url.includes("?") ? "&" : "?") + "quantity=" + qty,
                               { active: false, insert: true });
      let result = null;
      for (let w = 0; w < 70; w++) { result = GM_getValue(resultKey(key), null); if (result) break; await sleep(500); }
      try { tab.close(); } catch {}
      if (result && result.quotes) {
        for (const q of result.quotes) {
          collected.push(Object.assign({ gamePk, url: stampUrl ? url : q.url }, q, { gamePk, url: url }));
        }
      }
      await sleep(6000 + Math.random() * 4000);
    }
    GM_setValue(jobKey, { active: false, startedAt: 0 });
    return { qty, collected };
  }

  let running = false;
  async function runStubHub() {
    const entries = Object.entries(STUBHUB_EVENTS).map(([pk, url]) => [Number(pk), url, Number(pk)]);
    const { qty, collected } = await cycle("StubHub", "yk_sh_job", entries,
      (pk) => "yk_sh_result_" + pk, false);
    setChip(`Publishing ${collected.length} StubHub prices…`, true);
    await putFile(`/contents/yankees-tickets/data/listings-stubhub-${qty}.json`,
      { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
      `StubHub listings (blocks of ${qty}, browser collector)`);
    return collected.length;
  }

  async function runSeatGeek() {
    // 1) Harvest event URLs from the team page in a background tab.
    GM_deleteValue("yk_sg_harvest");
    GM_setValue("yk_sg_job", { active: true, startedAt: Date.now() });
    const htab = GM_openInTab("https://seatgeek.com/new-york-yankees-tickets", { active: false, insert: true });
    let harvest = null;
    for (let w = 0; w < 60; w++) { harvest = GM_getValue("yk_sg_harvest", null); if (harvest) break; await sleep(500); }
    try { htab.close(); } catch {}
    const rows = (harvest && harvest.rows) || [];
    const harvestDiag = (harvest && harvest.diag) ||
      { note: "harvest tab produced no result — the script may not have run on the team page (check @match / the page 403'd)" };

    // Always publish the harvest diagnostic so the team-page structure is
    // visible for tuning, even when zero games were harvested.
    const publishDiag = (perEvent) => putFile(
      `/contents/yankees-tickets/data/_seatgeek-diag.json`,
      { fetchedAt: new Date().toISOString(), harvestDiag, harvested: rows, perEvent: perEvent || [] },
      "SeatGeek collector diagnostic (tuning)");

    // Event list = the static URL map (all 17 home games, incl. sequential
    // guesses for 9/24–9/27) unioned with anything freshly harvested, deduped
    // by eventId. gamePk is resolved per-event from the real date/time the
    // worker reads off the page, so a wrong guess simply contributes nothing.
    const byEid = new Map();
    for (const u of SEATGEEK_URLS) {
      const eid = (u.match(/\/(\d{5,})/) || [])[1];
      if (eid) byEid.set(eid, u);
    }
    for (const r of rows) {
      const eid = (r.url.match(/\/(\d{5,})/) || [])[1];
      if (eid && !byEid.has(eid)) byEid.set(eid, r.url);
    }
    const entries = [...byEid.entries()].map(([eid, url]) => [eid, url, null]);

    const { qty } = await cycle("SeatGeek", "yk_sg_job", entries,
      (eid) => "yk_sg_result_" + eid, true);

    // Rebuild results with gamePk resolved from each event's actual date/time.
    const collected = [];
    const diags = entries.map(([eid, url]) => {
      const r = GM_getValue("yk_sg_result_" + eid, null);
      const pk = r ? sgGamePk(r.eventDate, r.eventHour) : null;
      if (r && r.quotes) {
        for (const q of r.quotes) {
          if (pk) collected.push(Object.assign({}, q, { gamePk: pk, url }));
        }
      }
      return {
        eid, url, gamePk: pk,
        date: r ? r.eventDate : null, hour: r ? r.eventHour : null,
        sections: r ? r.quotes.length : 0,
        matched: pk ? (r ? r.quotes.length : 0) : 0,
        diag: r ? r.diag : "no result",
      };
    });
    await publishDiag(diags);
    if (collected.length) {
      await putFile(`/contents/yankees-tickets/data/listings-seatgeek-${qty}.json`,
        { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
        `SeatGeek listings (blocks of ${qty}, browser collector)`);
    }
    GM_setValue("yk_sg_job", { active: false, startedAt: 0 });
    const games = new Set(collected.map((q) => q.gamePk)).size;
    setChip(`SeatGeek: ${collected.length} prices across ${games} games`);
    return collected.length;
  }

  async function runAll() {
    if (running) return;
    if (!settings().ghToken) { setChip("Set the access key in Settings first"); return; }
    running = true;
    try {
      setChip("StubHub…", true);
      const sh = await runStubHub();
      setChip("SeatGeek…", true);
      const sg = await runSeatGeek();
      setChip(`Done: StubHub ${sh}, SeatGeek ${sg}. Press Search.`);
    } catch (e) {
      console.error("[collector]", e);
      setChip("Collector error — see console");
    } finally { running = false; }
  }

  GM_registerMenuCommand("Collect SeatGeek + StubHub now", runAll);
  GM_registerMenuCommand("Collect StubHub only", async () => { if (!running) { running = true; try { const n = await runStubHub(); setChip(`StubHub done: ${n}`); } finally { running = false; } } });
  GM_registerMenuCommand("Collect SeatGeek only", async () => { if (!running) { running = true; try { const n = await runSeatGeek(); setChip(`SeatGeek done: ${n}`); } finally { running = false; } } });

  function wire() {
    document.querySelectorAll(".refresh-btn").forEach((b) => {
      if (b.dataset.collWired) return;
      b.dataset.collWired = "1";
      b.addEventListener("click", () => runAll());
    });
    setChip("SeatGeek + StubHub ready (this browser)");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
