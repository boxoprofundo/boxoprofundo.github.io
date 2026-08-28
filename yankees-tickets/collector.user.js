// ==UserScript==
// @name         NYY Aggregator — SeatGeek + StubHub collector
// @namespace    boxoprofundo.github.io/yankees-tickets
// @version      2.1.0
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
// @run-at       document-idle
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
      seatgeekWorker().catch((e) => console.error("[collector/SeatGeek]", e));
    } else if (active && /yankees-tickets|new-york-yankees/.test(location.pathname)) {
      seatgeekHarvest().catch((e) => console.error("[collector/SeatGeek harvest]", e));
    }
    return;
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
    // Wait for listings to render.
    for (let i = 0; i < 50; i++) {
      const t = document.body ? document.body.innerText : "";
      if ((t.match(/\$\s*\d{2,}/g) || []).length >= 3 &&
          /sec(tion)?/i.test(t)) break;
      if (i % 4 === 0) window.scrollTo(0, document.body.scrollHeight);
      await sleep(300);
    }
    for (let r = 0; r < 12; r++) {
      if (!clickMore(["show all", "show more", "view more", "load more", "see more tickets"])) break;
      await sleep(1200);
    }

    const diag = { url: location.href, strategies: {} };

    // Strategy A: __NEXT_DATA__ / embedded JSON listing arrays.
    let quotes = [];
    try {
      const nd = document.getElementById("__NEXT_DATA__");
      if (nd) {
        const s = nd.textContent || "";
        diag.strategies.next_len = s.length;
        // Capture candidate listing objects: {..."section"...,"price"...}.
        const secKeys = [...s.matchAll(/"(section|section_name|sectionName|sg_section|section_id)"\s*:\s*("?[^",}]{1,20})/gi)].slice(0, 8);
        const priceKeys = [...s.matchAll(/"(price|display_price|lp|list_price|p)"\s*:\s*([\d.]+)/gi)].slice(0, 8);
        diag.strategies.next_section_samples = secKeys.map((m) => m[0]);
        diag.strategies.next_price_samples = priceKeys.map((m) => m[0]);
      } else {
        diag.strategies.next = "no __NEXT_DATA__";
      }
    } catch (e) { diag.strategies.next_err = String(e).slice(0, 120); }

    // Strategy B: DOM text "Section X ... $Y" parsing (robust fallback).
    try {
      const body = document.body ? document.body.innerText : "";
      diag.strategies.body_len = body.length;
      const SEC = "(?:[A-Za-z]*\\d[A-Za-z0-9]*|GA|[A-Z]{1,3})";
      const re = new RegExp("(?=\\b[Ss]ec(?:tion)?\\.?\\s+" + SEC + "\\b)");
      const bySec = {};
      for (const chunk of body.split(re)) {
        const sm = chunk.match(new RegExp("^\\b[Ss]ec(?:tion)?\\.?\\s+(" + SEC + ")\\b"));
        if (!sm) continue;
        const sec = sm[1].trim().toUpperCase();
        const pm = [...chunk.slice(0, 120).matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
        if (!pm.length) continue;
        const price = parseFloat(pm[0][1].replace(/,/g, ""));
        if (!(price > 5 && price < 50000)) continue;
        const obstructed = /obstruct|limited view/i.test(chunk.slice(0, 120));
        if (!(sec in bySec) || price < bySec[sec].price) bySec[sec] = { price, obstructed };
      }
      quotes = Object.entries(bySec).map(([sec, v]) => ({
        provider: "SeatGeek",
        section: v.obstructed ? `${sec} (obstructed)` : sec,
        price: Math.round(v.price * 100) / 100, faceValue: null,
      }));
      diag.strategies.dom_sections = quotes.length;
      // A couple of raw DOM samples to see how a listing row reads.
      diag.strategies.body_head = body.slice(0, 400);
    } catch (e) { diag.strategies.dom_err = String(e).slice(0, 120); }

    console.log(`[collector/SeatGeek] ${quotes.length} sections`, diag);
    const eid = (location.pathname.match(/\/(\d{6,})/) || [])[1] || location.href;
    GM_setValue("yk_sg_result_" + eid, { ts: Date.now(), quotes, diag });
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

    if (!rows.length) {
      await publishDiag([]);
      GM_setValue("yk_sg_job", { active: false, startedAt: 0 });
      setChip("SeatGeek: 0 games harvested — diagnostic published");
      return 0;
    }

    // Cycle event pages. gamePk isn't known from SeatGeek yet — publish keyed by
    // URL + per-event diagnostics so the parser + gamePk-matching can be finalized.
    const entries = rows.slice(0, 20).map((r) => {
      const eid = (r.url.match(/\/(\d{5,})/) || [])[1] || r.url;
      return [eid, r.url, null];
    });
    const { qty, collected } = await cycle("SeatGeek", "yk_sg_job", entries,
      (eid) => "yk_sg_result_" + eid, true);

    const diags = entries.map(([eid]) => {
      const r = GM_getValue("yk_sg_result_" + eid, null);
      return { eid, sections: r ? r.quotes.length : 0, diag: r ? r.diag : "no result" };
    });
    await publishDiag(diags);
    if (collected.length) {
      await putFile(`/contents/yankees-tickets/data/listings-seatgeek-${qty}.json`,
        { fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), quotes: collected },
        `SeatGeek listings (blocks of ${qty}, browser collector)`);
    }
    GM_setValue("yk_sg_job", { active: false, startedAt: 0 });
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
