/**
 * Hammers Thanksgiving Day Game Squares: sign-up backend.
 *
 * Bound to the "Hammers Thanksgiving Boxes – Payment log" Google Sheet
 * (Extensions > Apps Script), deployed as a Web app (Execute as: Me,
 * Who has access: Anyone). The sign-up page talks to the /exec URL.
 *
 * Everything lives in that sheet:
 *   Summary!B5  price per box
 *   Summary!B6  boxes on the board (100)
 *   Summary!B7  sign-ups open (TRUE / FALSE)
 *   Players!A2:A  the player list shown on the page
 *   Sign-ups    one row per sign-up, written by this script
 */

var SIGNUPS = 'Sign-ups';
var SUMMARY = 'Summary';
var PLAYERS = 'Players';
var PAY_METHODS = ['Venmo', 'PayPal', 'Zelle', 'Cash or check'];

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

    var s = status_();
    if (!s.open) return json_({ ok: false, error: 'Sign-ups are closed.' });

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
    if (s.players.indexOf(player) < 0) return json_({ ok: false, error: 'Please choose a player from the list.' });
    if (boxes > s.left) {
      return json_({ ok: false, error: s.left > 0
        ? 'Only ' + s.left + ' box' + (s.left === 1 ? ' is' : 'es are') + ' left.'
        : 'All boxes are taken.' });
    }

    var props = PropertiesService.getScriptProperties();
    var n = (Number(props.getProperty('lastRef')) || 0) + 1;
    props.setProperty('lastRef', String(n));
    var reference = 'HAM-' + ('000' + n).slice(-4);
    var amount = boxes * s.price;

    var sheet = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
    var row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, 11).setValues([[
      new Date(), name, email, phone ? "'" + phone : '', player, boxes, amount, method, false, notes, reference
    ]]);
    sheet.getRange(row, 9).insertCheckboxes();
    SpreadsheetApp.flush();

    return json_({ ok: true, reference: reference, amount: amount, boxes: boxes, player: player, left: s.left - boxes });
  } finally {
    lock.releaseLock();
  }
}

function status_() {
  var ss = SpreadsheetApp.getActive();
  var sum = ss.getSheetByName(SUMMARY);
  var price = Number(sum.getRange('B5').getValue()) || 20;
  var total = Number(sum.getRange('B6').getValue()) || 100;
  var open = sum.getRange('B7').getValue() === true;

  var su = ss.getSheetByName(SIGNUPS);
  var sold = 0;
  if (su.getLastRow() > 1) {
    su.getRange(2, 6, su.getLastRow() - 1, 1).getValues().forEach(function (r) {
      sold += Number(r[0]) || 0;
    });
  }

  var players = [];
  var ps = ss.getSheetByName(PLAYERS);
  if (ps && ps.getLastRow() > 1) {
    players = ps.getRange(2, 1, ps.getLastRow() - 1, 1).getValues()
      .map(function (r) { return String(r[0]).trim(); })
      .filter(function (p) { return p; });
  }

  var left = Math.max(0, total - sold);
  return { ok: true, open: open && left > 0, price: price, total: total, left: left, players: players };
}

function clean_(v, max) {
  // Strip leading characters that Sheets would treat as a formula.
  return String(v == null ? '' : v).trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
