/**
 * Hammers Thanksgiving Day Boxes: sign-up backend.
 *
 * A standalone Apps Script (script.google.com > New project), deployed as a
 * Web app (Execute as: Me, Who has access: Anyone). The sign-up page talks to
 * the resulting /exec URL.
 *
 * It writes each box a buyer takes into the team's sheet, in the chosen
 * player's block: Buyer Name (C), Email (G), Phone (H). It changes nothing
 * else there. Every sign-up is also logged, with the payment method and a
 * reference number, to the separate "Sign-ups" log sheet.
 */

var TEAM_SHEET_ID = '1WDeyvSTw9-cB0GR8S_PlZr6ysg_T-pcXtbY2oJk0GzE';
var TEAM_TAB = 'Sheet1';
var LOG_SHEET_ID = '16DZm9rnE2Us0fP92j3HUKioY67Ahjh067el2-luoMQc';
var LOG_TAB = 'Sign-ups';
var SETTINGS_TAB = 'Summary';     // B5 = price per box, B7 = sign-ups open (TRUE/FALSE)
var SKIP_BLOCKS = ['Extra'];      // blocks not offered on the page
var PAY_METHODS = ['Venmo', 'PayPal', 'Zelle', 'Cash or check'];

// Team sheet columns (1-based).
var COL_PLAYER = 1, COL_BOX = 2, COL_BUYER = 3, COL_EMAIL = 7, COL_PHONE = 8;

function doGet() {
  return json_(status_());
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'The sign-up sheet is busy. Please try again in a few seconds.' });
  }
  try {
    var body = {};
    try { body = JSON.parse(e.postData.contents); } catch (err) {}

    // Honeypot: real people never fill this hidden field.
    if (body.website) return json_({ ok: true, reference: 'HAM-0000', amount: 0, boxes: 0 });

    var settings = settings_();
    if (!settings.open) return json_({ ok: false, error: 'Sign-ups are closed.' });

    var name = clean_(body.name, 80);
    var email = clean_(body.email, 120);
    var phone = clean_(body.phone, 30);
    var player = clean_(body.player, 80);
    var method = clean_(body.method, 30);
    var notes = clean_(body.notes, 300);
    var boxes = Math.floor(Number(body.boxes));

    if (!name) return json_({ ok: false, error: 'Please enter your name.' });
    if (!email && !phone) return json_({ ok: false, error: 'Please enter an email or a phone number so we can reach you.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json_({ ok: false, error: 'That email address does not look right.' });
    if (!(boxes >= 1)) return json_({ ok: false, error: 'Choose at least 1 box.' });
    if (PAY_METHODS.indexOf(method) < 0) return json_({ ok: false, error: 'Please choose how you will pay.' });

    var sheet = SpreadsheetApp.openById(TEAM_SHEET_ID).getSheetByName(TEAM_TAB);
    var block = readBlocks_(sheet).filter(function (b) { return b.player === player; })[0];
    if (!block || SKIP_BLOCKS.indexOf(player) >= 0) return json_({ ok: false, error: 'Please choose a player from the list.' });
    if (boxes > block.open.length) {
      return json_({ ok: false, error: block.open.length
        ? player + ' has only ' + block.open.length + ' box' + (block.open.length === 1 ? '' : 'es') + ' left.'
        : player + ' has no boxes left. Please choose another player.' });
    }

    var rows = block.open.slice(0, boxes);
    rows.forEach(function (r) {
      sheet.getRange(r.row, COL_BUYER).setValue(name);
      if (email) sheet.getRange(r.row, COL_EMAIL).setValue(email);
      if (phone) sheet.getRange(r.row, COL_PHONE).setValue("'" + phone);
    });

    var props = PropertiesService.getScriptProperties();
    var n = (Number(props.getProperty('lastRef')) || 0) + 1;
    props.setProperty('lastRef', String(n));
    var reference = 'HAM-' + ('000' + n).slice(-4);
    var amount = boxes * settings.price;
    var boxNums = rows.map(function (r) { return r.box; }).join(', ');

    var log = SpreadsheetApp.openById(LOG_SHEET_ID).getSheetByName(LOG_TAB);
    var logRow = log.getLastRow() + 1;
    log.getRange(logRow, 1, 1, 11).setValues([[
      new Date(), name, email, phone ? "'" + phone : '', player, boxes, amount, method, false,
      notes ? notes + ' (box ' + boxNums + ')' : 'Box ' + boxNums, reference
    ]]);
    log.getRange(logRow, 9).insertCheckboxes();
    SpreadsheetApp.flush();

    return json_({ ok: true, reference: reference, amount: amount, boxes: boxes, player: player, left: block.open.length - boxes });
  } finally {
    lock.releaseLock();
  }
}

/** Finds each player's block: a "Player Name" header row, then box rows until "Total". */
function readBlocks_(sheet) {
  var last = sheet.getLastRow();
  var v = sheet.getRange(1, 1, last, COL_PHONE).getValues();
  var blocks = [];
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][COL_PLAYER - 1]).trim() !== 'Player Name') continue;
    var player = String((v[i + 1] || [])[COL_PLAYER - 1] || '').trim();
    if (!player) continue;
    var block = { player: player, open: [], total: 0 };
    for (var j = i + 1; j < v.length; j++) {
      var a = String(v[j][COL_PLAYER - 1]).trim();
      if (a === 'Total' || a === 'Player Name') break;
      var box = v[j][COL_BOX - 1];
      if (box === '' || isNaN(Number(box))) continue;
      block.total++;
      if (String(v[j][COL_BUYER - 1]).trim() === '') block.open.push({ row: j + 1, box: Number(box) });
    }
    blocks.push(block);
    i = j - 1;
  }
  return blocks;
}

function status_() {
  var settings = settings_();
  var blocks = readBlocks_(SpreadsheetApp.openById(TEAM_SHEET_ID).getSheetByName(TEAM_TAB))
    .filter(function (b) { return SKIP_BLOCKS.indexOf(b.player) < 0; });
  var players = blocks.map(function (b) { return { name: b.player, left: b.open.length }; });
  var left = players.reduce(function (s, p) { return s + p.left; }, 0);
  return { ok: true, open: settings.open && left > 0, price: settings.price, left: left, players: players };
}

function settings_() {
  var s = SpreadsheetApp.openById(LOG_SHEET_ID).getSheetByName(SETTINGS_TAB);
  return {
    price: Number(s.getRange('B5').getValue()) || 20,
    open: s.getRange('B7').getValue() === true
  };
}

function clean_(v, max) {
  // Strip leading characters that Sheets would treat as a formula.
  return String(v == null ? '' : v).trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
