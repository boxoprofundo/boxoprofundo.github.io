/**
 * Hammers Super Bowl Squares: sign-up backend.
 *
 * Paste this into Extensions > Apps Script of the "Hammers Super Bowl
 * Squares – Sign-ups" Google Sheet, then Deploy > New deployment > Web app,
 * Execute as: Me, Who has access: Anyone. The sign-up page talks to the
 * resulting /exec URL.
 *
 * Settings live in the sheet, not here:
 *   Summary!B5  price per square
 *   Summary!B6  squares on the board
 *   Summary!B7  sign-ups open (TRUE / FALSE)
 *   Players!A2:A  the player list shown on the page
 */

var SIGNUPS = 'Sign-ups';
var SUMMARY = 'Summary';
var PLAYERS = 'Players';
var MAX_PER_SIGNUP = 20;
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
    if (body.website) return json_({ ok: true, reference: 'HAM-0000', amount: 0 });

    var s = status_();
    if (!s.open) return json_({ ok: false, error: 'Sign-ups are closed.' });

    var name = clean_(body.name, 80);
    var email = clean_(body.email, 120);
    var phone = clean_(body.phone, 30);
    var player = clean_(body.player, 80);
    var method = clean_(body.method, 30);
    var notes = clean_(body.notes, 300);
    var squares = Math.floor(Number(body.squares));

    if (!name) return json_({ ok: false, error: 'Please enter your name.' });
    if (!email && !phone) return json_({ ok: false, error: 'Please enter an email or a phone number so we can reach you.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json_({ ok: false, error: 'That email address does not look right.' });
    if (!(squares >= 1 && squares <= MAX_PER_SIGNUP)) return json_({ ok: false, error: 'Choose between 1 and ' + MAX_PER_SIGNUP + ' squares.' });
    if (PAY_METHODS.indexOf(method) < 0) return json_({ ok: false, error: 'Please choose how you will pay.' });
    if (s.players.length && s.players.indexOf(player) < 0 && player !== 'The whole team') {
      return json_({ ok: false, error: 'Please choose a player from the list.' });
    }
    if (squares > s.left) {
      return json_({ ok: false, error: s.left > 0
        ? 'Only ' + s.left + ' square' + (s.left === 1 ? ' is' : 's are') + ' left.'
        : 'All squares are taken.' });
    }

    var sheet = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
    var row = sheet.getLastRow() + 1;
    var props = PropertiesService.getScriptProperties();
    var n = (Number(props.getProperty('lastRef')) || 0) + 1;
    props.setProperty('lastRef', String(n));
    var reference = 'HAM-' + ('000' + n).slice(-4);
    var amount = squares * s.price;
    sheet.getRange(row, 1, 1, 11).setValues([[
      new Date(), name, email, phone, player || 'The whole team', squares, amount, method, false, notes, reference
    ]]);
    sheet.getRange(row, 9).insertCheckboxes();
    sheet.getRange(row, 4).setNumberFormat('@');
    SpreadsheetApp.flush();

    return json_({ ok: true, reference: reference, amount: amount, squares: squares, left: s.left - squares });
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
  var claimed = 0;
  if (su.getLastRow() > 1) {
    su.getRange(2, 6, su.getLastRow() - 1, 1).getValues().forEach(function (r) {
      claimed += Number(r[0]) || 0;
    });
  }

  var players = [];
  var ps = ss.getSheetByName(PLAYERS);
  if (ps && ps.getLastRow() > 1) {
    players = ps.getRange(2, 1, ps.getLastRow() - 1, 1).getValues()
      .map(function (r) { return String(r[0]).trim(); })
      .filter(function (p) { return p; });
  }

  var left = Math.max(0, total - claimed);
  return { ok: true, open: open && left > 0, price: price, total: total, left: left, players: players, maxPerSignup: MAX_PER_SIGNUP };
}

function clean_(v, max) {
  // Strip leading characters that Sheets would treat as a formula.
  return String(v == null ? '' : v).trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
