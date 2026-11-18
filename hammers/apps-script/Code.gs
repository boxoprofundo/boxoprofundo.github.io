/**
 * Hammers Thanksgiving Day Game Squares: sign-up and payment backend.
 *
 * Bound to the "Hammers Thanksgiving Squares – Sign-ups" Google Sheet
 * (Extensions > Apps Script), deployed as a Web app (Execute as: Me,
 * Who has access: Anyone). The sign-up page and the family page talk to the
 * /exec URL.
 *
 * Settings in the sheet:
 *   Summary!B5  price per box
 *   Summary!B6  boxes on the board (100)
 *   Summary!B7  sign-ups open (TRUE / FALSE)
 *   Summary!B8  online processing fee per box (added to Venmo, PayPal and card payments)
 *   Players!A2:A  player names shown on the page
 *   Players!G2:G  each family's private key for the cash/check page
 *
 * Settings in Project Settings > Script properties (never in this file):
 *   PAYPAL_ENV        "sandbox" or "live"
 *   PAYPAL_CLIENT_ID  from the PayPal developer dashboard (public)
 *   PAYPAL_SECRET     from the PayPal developer dashboard (keep private)
 *   ZELLE_FROM        optional: overrides the Zelle alert sender below
 *
 * Zelle: buyers send to ZELLE_TO with their reference number in the memo.
 * checkZelleEmails() runs every 10 minutes (installZelleTrigger() sets that up)
 * and marks a sign-up paid when a bank email from ZELLE_FROM mentions its
 * reference number and the right amount.
 */

var SIGNUPS = 'Sign-ups';
var SUMMARY = 'Summary';
var PLAYERS = 'Players';
var HOLD_MINUTES = 30;                            // unpaid online sign-ups release their boxes after this
var ZELLE_TO = 'mike@mikeboxer.com';              // where buyers send Zelle
var ZELLE_FROM = 'no.reply.alerts@chase.com';     // Chase's Zelle alert sender

// Sign-ups columns (1-based)
var C = { submitted: 1, name: 2, email: 3, phone: 4, player: 5, boxes: 6, amount: 7, method: 8,
          paid: 9, notes: 10, ref: 11, status: 12, fee: 13, paypalId: 14, confirmed: 15 };
var NCOLS = 15;

var ST = { awaiting: 'Awaiting online payment', paid: 'Paid', zelle: 'Waiting for Zelle', cash: 'Waiting for cash or check',
           received: 'Cash or check received', expired: 'Not completed' };

/* ---------------- HTTP entry points ---------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'family') return json_(familyView_(p.k));
  return json_(status_());
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  if (body.website) return json_({ ok: false, error: 'Something went wrong.' }); // honeypot

  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) {
    return json_({ ok: false, error: 'The sign-up sheet is busy. Please try again in a few seconds.' });
  }
  try {
    switch (body.action) {
      case 'createOrder': return json_(createOrder_(body));
      case 'captureOrder': return json_(captureOrder_(body));
      case 'reserveCash': return json_(reserve_(body, body.payWith === 'Check' ? 'Check' : body.payWith === 'Cash' ? 'Cash' : 'Cash or check', ST.cash));
      case 'reserveZelle': return json_(reserve_(body, 'Zelle', ST.zelle));
      case 'markReceived': return json_(markReceived_(body));
      default: return json_({ ok: false, error: 'Unknown request.' });
    }
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'Something went wrong on our end. Please try again.' });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Status ---------------- */

function settings_() {
  var sum = SpreadsheetApp.getActive().getSheetByName(SUMMARY);
  var v = sum.getRange('B5:B8').getValues();
  return {
    price: Number(v[0][0]) || 20,
    total: Number(v[1][0]) || 100,
    open: v[2][0] === true,
    feePerBox: v[3][0] === '' ? 1.25 : Number(v[3][0])
  };
}

function players_() {
  var ps = SpreadsheetApp.getActive().getSheetByName(PLAYERS);
  if (ps.getLastRow() < 2) return [];
  return ps.getRange(2, 1, ps.getLastRow() - 1, 7).getValues()
    .filter(function (r) { return String(r[0]).trim(); })
    .map(function (r) { return { name: String(r[0]).trim(), key: String(r[6]).trim() }; });
}

/** Rows of the Sign-ups tab as objects, with expired online holds marked. */
function rows_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
  var last = lastRow_(sh);
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, NCOLS).getValues();
  var now = Date.now();
  return vals.map(function (r, i) {
    var row = { row: i + 2, submitted: r[C.submitted - 1], name: r[C.name - 1], email: r[C.email - 1],
      phone: String(r[C.phone - 1]), player: r[C.player - 1], boxes: Number(r[C.boxes - 1]) || 0,
      amount: Number(r[C.amount - 1]) || 0, method: r[C.method - 1], paid: r[C.paid - 1] === true,
      ref: r[C.ref - 1], status: r[C.status - 1], fee: Number(r[C.fee - 1]) || 0, paypalId: r[C.paypalId - 1] };
    if (row.status === ST.awaiting && row.submitted instanceof Date &&
        now - row.submitted.getTime() > HOLD_MINUTES * 60000) {
      sh.getRange(row.row, C.status).setValue(ST.expired);
      row.status = ST.expired;
    }
    return row;
  });
}

function sold_(rows) {
  return rows.reduce(function (s, r) { return r.status === ST.expired || !r.ref ? s : s + r.boxes; }, 0);
}

function status_() {
  var s = settings_();
  var left = Math.max(0, s.total - sold_(rows_()));
  var props = PropertiesService.getScriptProperties();
  return {
    ok: true, open: s.open && left > 0, price: s.price, total: s.total, left: left, feePerBox: s.feePerBox,
    players: players_().map(function (p) { return p.name; }),
    paypal: { clientId: props.getProperty('PAYPAL_CLIENT_ID') || '', env: props.getProperty('PAYPAL_ENV') || 'sandbox' },
    zelle: ZELLE_TO
  };
}

/* ---------------- Sign-ups ---------------- */

/** Validates a sign-up and returns the cleaned values, or {error}. */
function validate_(body, s, rows) {
  var d = {
    name: clean_(body.name, 80), email: clean_(body.email, 120), phone: clean_(body.phone, 30),
    player: clean_(body.player, 80), notes: clean_(body.notes, 300), boxes: Math.floor(Number(body.boxes))
  };
  if (!s.open) return { error: 'Sign-ups are closed.' };
  if (!d.name) return { error: 'Please enter your name.' };
  if (!d.email && !d.phone) return { error: 'Please enter an email or a phone number so we can reach you.' };
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return { error: 'That email address does not look right.' };
  if (!(d.boxes >= 1)) return { error: 'Choose at least 1 box.' };
  if (players_().map(function (p) { return p.name; }).indexOf(d.player) < 0) return { error: 'Please choose a player from the list.' };
  var left = Math.max(0, s.total - sold_(rows));
  if (d.boxes > left) return { error: left > 0 ? 'Only ' + left + ' box' + (left === 1 ? ' is' : 'es are') + ' left.' : 'All boxes are taken.' };
  d.left = left;
  return d;
}

function appendSignup_(d, method, status, fee, paypalId) {
  var props = PropertiesService.getScriptProperties();
  var n = (Number(props.getProperty('lastRef')) || 0) + 1;
  props.setProperty('lastRef', String(n));
  var ref = 'HAM-' + ('000' + n).slice(-4);
  var s = settings_();
  var sh = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
  var row = lastRow_(sh) + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  var vals = [];
  vals[C.submitted - 1] = new Date(); vals[C.name - 1] = d.name; vals[C.email - 1] = d.email;
  vals[C.phone - 1] = d.phone ? "'" + d.phone : ''; vals[C.player - 1] = d.player; vals[C.boxes - 1] = d.boxes;
  vals[C.amount - 1] = d.boxes * s.price; vals[C.method - 1] = method; vals[C.paid - 1] = false;
  vals[C.notes - 1] = d.notes; vals[C.ref - 1] = ref; vals[C.status - 1] = status; vals[C.fee - 1] = fee;
  vals[C.paypalId - 1] = paypalId || ''; vals[C.confirmed - 1] = '';
  sh.getRange(row, 1, 1, NCOLS).setValues([vals]);
  sh.getRange(row, C.paid).insertCheckboxes();
  return { ref: ref, row: row, amount: d.boxes * s.price };
}

function reserve_(body, method, status) {
  var s = settings_();
  var rows = rows_();
  var d = validate_(body, s, rows);
  if (d.error) return { ok: false, error: d.error };
  var r = appendSignup_(d, method, status, 0, '');
  SpreadsheetApp.flush();
  return { ok: true, reference: r.ref, amount: r.amount, boxes: d.boxes, player: d.player, left: d.left - d.boxes };
}

/* ---------------- PayPal ---------------- */

function paypalBase_() {
  return PropertiesService.getScriptProperties().getProperty('PAYPAL_ENV') === 'live'
    ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function paypalToken_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('pp_token');
  if (t) return t;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('PAYPAL_CLIENT_ID'), secret = props.getProperty('PAYPAL_SECRET');
  if (!id || !secret) throw new Error('PayPal is not set up: missing PAYPAL_CLIENT_ID or PAYPAL_SECRET.');
  var res = UrlFetchApp.fetch(paypalBase_() + '/v1/oauth2/token', {
    method: 'post', payload: { grant_type: 'client_credentials' }, muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) }
  });
  var j = JSON.parse(res.getContentText());
  if (!j.access_token) throw new Error('PayPal token failed: ' + res.getContentText());
  cache.put('pp_token', j.access_token, Math.min(21600, Math.max(60, (j.expires_in || 3600) - 300)));
  return j.access_token;
}

function paypal_(method, path, payload, requestId) {
  var opts = { method: method, muteHttpExceptions: true, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + paypalToken_(), Prefer: 'return=representation' } };
  if (requestId) opts.headers['PayPal-Request-Id'] = requestId;
  if (payload) opts.payload = JSON.stringify(payload);
  var res = UrlFetchApp.fetch(paypalBase_() + path, opts);
  var text = res.getContentText();
  return { code: res.getResponseCode(), body: text ? JSON.parse(text) : {} };
}

function money_(n) { return (Math.round(n * 100) / 100).toFixed(2); }

function createOrder_(body) {
  var s = settings_();
  var rows = rows_();
  var d = validate_(body, s, rows);
  if (d.error) return { ok: false, error: d.error };
  var boxesTotal = d.boxes * s.price;
  var fee = Math.round(d.boxes * s.feePerBox * 100) / 100;
  var r = appendSignup_(d, 'Online (pending)', ST.awaiting, fee, '');

  var order = paypal_('post', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: r.ref, custom_id: r.ref, invoice_id: r.ref,
      description: 'NY Hammers 12U Thanksgiving Day Game Squares: ' + d.boxes + ' box' + (d.boxes === 1 ? '' : 'es') + ' for ' + d.player,
      amount: { currency_code: 'USD', value: money_(boxesTotal + fee), breakdown: {
        item_total: { currency_code: 'USD', value: money_(boxesTotal) },
        handling: { currency_code: 'USD', value: money_(fee) } } },
      items: [{ name: 'Thanksgiving Day Game Square (' + d.player + ')', quantity: String(d.boxes),
        unit_amount: { currency_code: 'USD', value: money_(s.price) }, category: 'DIGITAL_GOODS' }]
    }],
    payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', brand_name: 'NY Hammers 12U', user_action: 'PAY_NOW' } } }
  }, r.ref + '-create');

  if (order.code >= 300 || !order.body.id) {
    SpreadsheetApp.getActive().getSheetByName(SIGNUPS).getRange(r.row, C.status).setValue(ST.expired);
    console.error('PayPal create failed', JSON.stringify(order.body));
    return { ok: false, error: 'We could not start the payment. Please try again.' };
  }
  SpreadsheetApp.getActive().getSheetByName(SIGNUPS).getRange(r.row, C.paypalId).setValue(order.body.id);
  SpreadsheetApp.flush();
  return { ok: true, orderID: order.body.id, reference: r.ref };
}

function captureOrder_(body) {
  var orderID = clean_(body.orderID, 40);
  var rows = rows_();
  var row = rows.filter(function (r) { return orderID && String(r.paypalId).split(' ')[0] === orderID; })[0];
  if (!row) return { ok: false, error: 'We could not find that order. Please contact the team.' };
  if (row.paid) return done_(row);
  if (row.status === ST.expired) {
    // The 30-minute hold ran out. Charge only if the boxes are still free.
    var s = settings_();
    if (row.boxes > s.total - sold_(rows)) {
      return { ok: false, error: 'Sorry, your hold expired and those boxes have since been taken. You have not been charged.' };
    }
  }

  var cap = paypal_('post', '/v2/checkout/orders/' + encodeURIComponent(orderID) + '/capture', null, row.ref + '-capture');
  var b = cap.body;
  if (cap.code === 422 && /ORDER_ALREADY_CAPTURED/.test(JSON.stringify(b))) {
    b = paypal_('get', '/v2/checkout/orders/' + encodeURIComponent(orderID)).body;
  } else if (cap.code === 422 && /INSTRUMENT_DECLINED/.test(JSON.stringify(b))) {
    return { ok: false, declined: true, error: 'That payment method was declined. Please try another one.' };
  }
  var capture = b.purchase_units && b.purchase_units[0] && b.purchase_units[0].payments &&
                b.purchase_units[0].payments.captures && b.purchase_units[0].payments.captures[0];
  var expected = money_(row.amount + row.fee);
  if (b.status !== 'COMPLETED' || !capture || capture.status !== 'COMPLETED' ||
      capture.custom_id !== row.ref || capture.amount.value !== expected) {
    console.error('Capture not completed', JSON.stringify(b));
    return { ok: false, error: 'The payment did not go through. You have not been charged; please try again.' };
  }
  var src = b.payment_source ? Object.keys(b.payment_source)[0] : 'paypal';
  var label = { paypal: 'PayPal', venmo: 'Venmo', card: 'Card' }[src] || src;
  var sh = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
  sh.getRange(row.row, C.method).setValue(label);
  sh.getRange(row.row, C.paid).setValue(true);
  sh.getRange(row.row, C.status).setValue(ST.paid);
  sh.getRange(row.row, C.paypalId).setValue(orderID + ' capture ' + capture.id);
  sh.getRange(row.row, C.confirmed).setValue(new Date());
  SpreadsheetApp.flush();
  row.paid = true;
  return done_(row);
}

function done_(row) {
  var s = settings_();
  return { ok: true, paid: true, reference: row.ref, amount: row.amount, fee: row.fee, boxes: row.boxes,
           player: row.player, left: Math.max(0, s.total - sold_(rows_())) };
}

/* ---------------- Family page (cash and check) ---------------- */

function family_(key) {
  key = String(key || '').trim();
  if (key.length < 12) return null;
  return players_().filter(function (p) { return p.key === key; })[0] || null;
}

function familyView_(key) {
  var fam = family_(key);
  if (!fam) return { ok: false, error: 'This link is not valid. Ask the team for your family link.' };
  var list = rows_().filter(function (r) {
    return r.player === fam.name && (r.status === ST.cash || r.status === ST.received);
  }).map(function (r) {
    return { reference: r.ref, name: r.name, email: r.email, phone: r.phone.replace(/^'/, ''), boxes: r.boxes,
             amount: r.amount, received: r.status === ST.received,
             submitted: r.submitted instanceof Date ? r.submitted.toISOString() : '' };
  });
  return { ok: true, player: fam.name, signups: list };
}

function markReceived_(body) {
  var fam = family_(body.k);
  if (!fam) return { ok: false, error: 'This link is not valid.' };
  var ref = clean_(body.reference, 20);
  var row = rows_().filter(function (r) { return r.ref === ref && r.player === fam.name; })[0];
  if (!row || (row.status !== ST.cash && row.status !== ST.received)) return { ok: false, error: 'Sign-up not found.' };
  var received = body.received !== false;
  var sh = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
  sh.getRange(row.row, C.paid).setValue(received);
  sh.getRange(row.row, C.status).setValue(received ? ST.received : ST.cash);
  sh.getRange(row.row, C.confirmed).setValue(received ? new Date() : '');
  SpreadsheetApp.flush();
  return familyView_(body.k);
}

/* ---------------- Zelle ---------------- */

/**
 * Marks Zelle sign-ups paid from Chase's "You received money with Zelle" emails.
 * An email counts only if it is from ZELLE_FROM, addressed to ZELLE_TO, its memo
 * contains the sign-up's reference number (e.g. HAM-0004), and its amount is at
 * least the amount due. Each email confirms one sign-up at most. Runs on a timer.
 */
function checkZelleEmails() {
  var from = PropertiesService.getScriptProperties().getProperty('ZELLE_FROM') || ZELLE_FROM;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    var all = rows_();
    var waiting = all.filter(function (r) { return r.status === ST.zelle; });
    if (!waiting.length) return;
    var used = {};
    all.forEach(function (r) { var m = /Zelle email (\w+)/.exec(String(r.paypalId)); if (m) used[m[1]] = true; });
    var q = 'from:' + from + ' to:' + ZELLE_TO + ' subject:"received money with Zelle" newer_than:30d';
    var sh = SpreadsheetApp.getActive().getSheetByName(SIGNUPS);
    GmailApp.search(q, 0, 100).forEach(function (t) {
      t.getMessages().forEach(function (m) {
        if (used[m.getId()]) return;
        if (m.getFrom().toLowerCase().indexOf(from.toLowerCase()) < 0) return;
        var text = zelleText_(m);
        var memo = (/Memo (.*?)(?: [A-Z][A-Z .,&'-]+ is registered|$)/.exec(text) || [])[1] || '';
        var amt = Number(((/Amount \$([\d,]+\.\d{2})/.exec(text) || [])[1] || '0').replace(/,/g, ''));
        var ref = (/HAM[- ]?(\d{4})/i.exec(memo) || [])[1];
        if (!ref) return;
        var r = waiting.filter(function (w) { return !w.done && w.ref === 'HAM-' + ref; })[0];
        if (!r || amt < r.amount) return;
        sh.getRange(r.row, C.paid).setValue(true);
        sh.getRange(r.row, C.status).setValue(ST.paid);
        sh.getRange(r.row, C.paypalId).setValue('Zelle email ' + m.getId() + ' ($' + amt.toFixed(2) + ')');
        sh.getRange(r.row, C.confirmed).setValue(m.getDate());
        r.done = true; used[m.getId()] = true;
      });
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/** Email text as one line: table pipes, markup and extra spaces removed, so
 *  "| Amount | $40.00 |" and "Amount $40.00" both read as "Amount $40.00". */
function zelleText_(m) {
  var raw = m.getPlainBody() || m.getBody().replace(/<[^>]+>/g, ' ');
  return raw.replace(/&nbsp;|&#160;/g, ' ').replace(/[|*#]/g, ' ').replace(/\s+/g, ' ');
}

/** Run once from the editor: checks Zelle emails every 10 minutes. */
function installZelleTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkZelleEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkZelleEmails').timeBased().everyMinutes(10).create();
  console.log('Zelle check scheduled every 10 minutes.');
}

/* ---------------- Helpers ---------------- */

/** Last row with a reference number (ignores checkboxes and formatting further down). */
function lastRow_(sh) {
  var n = sh.getMaxRows();
  if (n < 2) return 1;
  var refs = sh.getRange(2, C.ref, n - 1, 1).getValues();
  for (var i = refs.length - 1; i >= 0; i--) if (String(refs[i][0]).trim()) return i + 2;
  return 1;
}

function clean_(v, max) {
  // Strip leading characters that Sheets would treat as a formula.
  return String(v == null ? '' : v).trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to check the PayPal keys: View > Logs shows the result. */
function testPayPalConnection() {
  CacheService.getScriptCache().remove('pp_token');
  paypalToken_();
  console.log('PayPal ' + (PropertiesService.getScriptProperties().getProperty('PAYPAL_ENV') || 'sandbox') + ' connection OK');
}
