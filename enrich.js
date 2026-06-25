/* =====================================================================
   enrich.js  —  Sovenn on-device import enrichment, dedupe & cold-start
   ---------------------------------------------------------------------
   WHAT: pure, on-device logic that makes IMPORT safe and smart. It turns a
   raw incoming list (phone address book, Google CSV, vCard) into clean
   decisions: who is new (toAdd), who already exists and only needs blank
   fields filled (toUpdate, never clobbering), and who is a straight
   duplicate (duplicates). It also collapses duplicates WITHIN one list
   (dedupe) and backfills birthdays/anniversaries hiding in free-text notes.
   Dedupe is a confirmed gap in the current app; this fills it.

   WHY ON-DEVICE: every contact is the user's own private graph. None of it
   may leave the phone — no servers, no enrichment APIs, no network of any
   kind. The intelligence is deterministic string/date logic, so it is
   private by construction and testable with no backend. That privacy is the
   moat: cloud CRMs upload your address book; Sovenn never does.

   PERSONAS / THE MOMENT IT HELPS:
     - Elena the caregiver imports the whole extended family at once and must
       not end up with three "Mum" cards after the second import.
     - The new user onboarding 200 contacts wants them in clean, birthdays
       already pulled out of the messy notes column.
     - Anyone re-syncing months later: merges, never multiplies.

   STATUS: standalone. NOT yet referenced by index.html, app.js or sw.js.
   Develop and test in isolation; integrate when ready (see INTEGRATION).

   INTEGRATION (later, all additive):
     1) index.html: add <script src="enrich.js"></script> BEFORE app.js,
        and add 'enrich.js' to the sw.js SHELL list (bump the cache).
     2) app.js doImport(keep): before pushing rows, run
          var plan = SovennEnrich.diffImport(DB.contacts, keep,
                       { country: DB.settings.country });
        then add plan.toAdd, apply plan.toUpdate[i].fills to the matched
        cards, and show plan.duplicates.length as "skipped (already saved)".
     3) Optionally run SovennEnrich.dedupe(DB.contacts, {country}) once as a
        clean-up, and SovennEnrich.backfillDates(c) on a card with no bday.

   PUBLIC API (window.SovennEnrich) — all pure, never mutate, never throw:
     normalizeKey(contact[, opts])    -> match key string ('' if none)
     diffImport(existing, incoming, opts) -> { toAdd, toUpdate, duplicates }
     mergeContact(existing, incoming) -> new contact, blanks filled only
     backfillDates(contact)           -> { bday?, anniv? } from free text
     dedupe(contacts[, opts])         -> { kept, merged }
     _selftest()                      -> { pass, results } (no app/DOM/net)

   opts (optional): { country:'44'|'91'|... default code for bare national
     numbers; fields:[...] which fields are fillable, default below }
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  /* Fields we are allowed to fill on an existing card. Deliberately excludes
     id/createdAt/log/msgHistory and other history we must never overwrite. */
  var FILLABLE = [
    'name','callName','phone','email','linkedin','instagram','x','telegram',
    'website','jobTitle','company','location','context','notes',
    'bday','anniv','cadence','tier'
  ];

  /* ---- tiny safe helpers (no throw, no globals) ---- */
  function isObj(v){ return v != null && typeof v === 'object'; }
  function str(v){ return v == null ? '' : String(v); }
  function low(v){ return str(v).trim().toLowerCase(); }

  /* blank = null/undefined, empty/whitespace string, empty array, or a date
     object with no month. Filled scalars (incl. 0) are NOT blank. */
  function isBlank(v){
    if(v == null) return true;
    if(typeof v === 'string') return v.trim() === '';
    if(typeof v === 'number') return false;
    if(Array.isArray(v)) return v.length === 0;
    if(typeof v === 'object'){
      if('m' in v || 'd' in v || 'y' in v) return !v.m;   /* date object */
      var k; for(k in v){ if(Object.prototype.hasOwnProperty.call(v,k)) return false; }
      return true;
    }
    return false;
  }

  /* ---- phone normalization (self-contained; mirrors app.js intent but does
     NOT depend on it, and never reads DB.settings) ---- */
  function normPhone(raw, country){
    if(raw == null) return '';
    var s = str(raw).trim();
    country = str(country).replace(/\D/g, '');
    var digits;
    if(s.charAt(0) === '+'){ digits = s.replace(/\D/g, ''); return digits.length >= 7 ? digits : ''; }
    if(s.indexOf('00') === 0){ digits = s.replace(/\D/g, '').replace(/^0+/, ''); return digits.length >= 7 ? digits : ''; }
    digits = s.replace(/\D/g, '');
    if(digits.length < 7) return '';                       /* 'n/a', extensions, junk */
    if(digits.charAt(0) === '0') return country + digits.slice(1);  /* trunk 0 -> country code */
    if(digits.length >= 11) return digits;                 /* long enough to already carry a CC */
    return country ? country + digits : digits;            /* short local -> prepend default CC */
  }

  function normEmail(raw){
    var e = low(raw);
    /* a real email has exactly one @ with text either side and a dot after */
    if(!e || e.indexOf('@') < 1) return '';
    var at = e.split('@');
    if(at.length !== 2 || !at[0] || at[1].indexOf('.') < 1) return '';
    return e;
  }

  /* ---- normalizeKey: a stable match key from phone and/or email ----
     We prefer phone (most reliable across exports) then email. Returns a
     prefixed key so a phone and an email can never collide, '' if neither. */
  function normalizeKey(c, opts){
    if(!isObj(c)) return '';
    opts = opts || {};
    var p = normPhone(c.phone, opts.country);
    if(p) return 'p:' + p;
    var e = normEmail(c.email);
    if(e) return 'e:' + e;
    return '';
  }

  /* ---- date backfill from free text: "birthday June 3", "anniv 12/04",
     "wedding 3rd of August". Only returns dates not already set. ---- */
  var MONTHS = {
    jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,
    jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,
    oct:10,october:10,nov:11,november:11,dec:12,december:12
  };
  var MLEN = [0,31,29,31,30,31,30,31,31,30,31,30,31];   /* allow 29 Feb */

  function validMD(m, d){ return m >= 1 && m <= 12 && d >= 1 && d <= MLEN[m]; }

  /* Find one date near a keyword inside a text blob. kw is a regex fragment.*/
  function findDate(text, kw){
    text = str(text);
    if(!text) return null;
    /* search a window after the keyword so "loves June; bday is Aug 4" works */
    var re = new RegExp('(?:' + kw + ')[^0-9a-zA-Z]{0,12}([^\\n.;]{0,28})', 'i');
    var m = re.exec(text);
    if(!m) return null;
    var seg = m[1];

    /* numeric: 12/04, 12-04, 12.04  (day/month, day-first like the app) */
    var n = seg.match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*[\/.\-]\s*(\d{2,4}))?/);
    if(n){
      var d1 = +n[1], m1 = +n[2];
      var y1 = n[3] ? (+n[3] < 100 ? 2000 + +n[3] : +n[3]) : null;
      if(validMD(m1, d1)) return { y:y1, m:m1, d:d1 };     /* day-first */
      if(validMD(d1, m1)) return { y:y1, m:d1, d:m1 };     /* fall back to month-first */
      return null;
    }

    /* worded, day-before-month FIRST so "3rd of August 1990" binds 3 as the
       day (not 19 from the year). \b stops a 4-digit year being read as a day.*/
    var w2 = seg.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*\.?\s*(?:of\s+)?([a-zA-Z]{3,9})\b(?:[,\s]+(\d{4}))?/);
    if(w2 && MONTHS[w2[2].toLowerCase()]){
      return mk(MONTHS[w2[2].toLowerCase()], +w2[1], w2[3] ? +w2[3] : null);
    }
    /* month-before-day: "June 3", "Aug 4th 1990". The day must be a whole
       token (ordinal or boundary), never the leading digits of a year. */
    var w = seg.match(/([a-zA-Z]{3,9})\s*\.?\s*(\d{1,2})(?:st|nd|rd|th|\b)(?!\d)(?:[,\s]+(\d{4}))?/);
    if(w && MONTHS[w[1].toLowerCase()]){
      return mk(MONTHS[w[1].toLowerCase()], +w[2], w[3] ? +w[3] : null);
    }
    return null;
  }
  function mk(m, d, y){ return validMD(m, d) ? { y:y || null, m:m, d:d } : null; }

  function backfillDates(c){
    var out = {};
    if(!isObj(c)) return out;
    var text = str(c.notes) + ' \n ' + str(c.context);
    if(!text.trim()) return out;
    if(isBlank(c.bday)){
      var b = findDate(text, 'birthday|b-?day|born');
      if(b) out.bday = b;
    }
    if(isBlank(c.anniv)){
      var a = findDate(text, 'anniversary|anniv|wedding');
      if(a) out.anniv = a;
    }
    return out;
  }

  /* ---- non-destructive merge: only fill EXISTING's blank fields from
     INCOMING; never overwrite a value the user already has. ---- */
  /* computeFills: the diff of what mergeContact would change ({} if nothing).*/
  function computeFills(existing, incoming, fields){
    var fills = {};
    if(!isObj(existing) || !isObj(incoming)) return fills;
    fields = fields || FILLABLE;
    for(var i = 0; i < fields.length; i++){
      var f = fields[i];
      if(isBlank(existing[f]) && !isBlank(incoming[f])) fills[f] = incoming[f];
    }
    /* also rescue dates from the incoming card's free text, if still blank */
    var merged = shallow(existing);
    for(var k in fills){ if(has(fills,k)) merged[k] = fills[k]; }
    var dates = backfillDates({
      bday: merged.bday, anniv: merged.anniv,
      notes: incoming.notes, context: incoming.context
    });
    if(dates.bday && isBlank(existing.bday)) fills.bday = dates.bday;
    if(dates.anniv && isBlank(existing.anniv)) fills.anniv = dates.anniv;
    return fills;
  }

  function mergeContact(existing, incoming){
    if(!isObj(existing)) return isObj(incoming) ? shallow(incoming) : {};
    var out = shallow(existing);
    if(!isObj(incoming)) return out;
    var fills = computeFills(existing, incoming, FILLABLE);
    for(var k in fills){ if(has(fills, k)) out[k] = fills[k]; }
    return out;
  }

  function shallow(o){ var r = {}, k; for(k in o){ if(has(o,k)) r[k] = o[k]; } return r; }
  function has(o, k){ return Object.prototype.hasOwnProperty.call(o, k); }

  /* ---- diffImport: classify incoming vs existing in O(n) via a key index.
     Same key + adds nothing -> duplicate; + fills blanks -> toUpdate;
     no key match (or keyless) -> toAdd. ---- */
  function diffImport(existing, incoming, opts){
    var res = { toAdd: [], toUpdate: [], duplicates: [] };
    opts = opts || {};
    existing = Array.isArray(existing) ? existing : [];
    incoming = Array.isArray(incoming) ? incoming : [];
    var fields = opts.fields || FILLABLE;

    var index = {};   /* key -> existing contact */
    for(var i = 0; i < existing.length; i++){
      var ec = existing[i];
      if(!isObj(ec)) continue;
      var ek = normalizeKey(ec, opts);
      if(ek && !has(index, ek)) index[ek] = ec;
    }

    /* track keys added in THIS run so two incoming rows with the same key
       don't both become toAdd (the second is a duplicate of the first add) */
    var addedKeys = {};

    for(var j = 0; j < incoming.length; j++){
      var inc = incoming[j];
      if(!isObj(inc)) continue;
      var key = normalizeKey(inc, opts);
      var match = key ? index[key] : null;

      if(match){
        var fills = computeFills(match, inc, fields);
        if(emptyObj(fills)) res.duplicates.push(inc);
        else res.toUpdate.push({ existing: match, incoming: inc, fills: fills });
        continue;
      }
      if(key && addedKeys[key]){            /* dup within the incoming batch */
        res.duplicates.push(inc);
        continue;
      }
      res.toAdd.push(inc);
      if(key) addedKeys[key] = true;
    }
    return res;
  }

  function emptyObj(o){ var k; for(k in o){ if(has(o,k)) return false; } return true; }

  /* ---- dedupe: collapse duplicates WITHIN one list by key. Returns
     { kept (unique, blanks cross-filled), merged (absorbed records) }.
     Keyless contacts are always kept; first-appearance order preserved. ---- */
  function dedupe(contacts, opts){
    var out = { kept: [], merged: [] };
    contacts = Array.isArray(contacts) ? contacts : [];
    opts = opts || {};
    var byKey = {};   /* key -> index into out.kept */

    for(var i = 0; i < contacts.length; i++){
      var c = contacts[i];
      if(!isObj(c)){ continue; }
      var key = normalizeKey(c, opts);
      if(!key){ out.kept.push(shallow(c)); continue; }   /* unmatchable -> keep as-is */
      if(has(byKey, key)){
        var idx = byKey[key];
        out.kept[idx] = mergeContact(out.kept[idx], c);   /* fold blanks in */
        out.merged.push(c);
      } else {
        byKey[key] = out.kept.length;
        out.kept.push(shallow(c));
      }
    }
    return out;
  }

  /* ---- self-test: pure logic, runs with NO app / DOM / network / model ---- */
  function _selftest(){
    var R = [];
    function ok(name, cond, got){ R.push({ name: name, pass: !!cond, got: got }); }
    function jd(o){ return o ? (o.y || '?') + '-' + o.m + '-' + o.d : 'null'; }   /* date -> short string, no JSON dep */

    /* normalizeKey: phone preferred, email fallback, prefixed, junk -> '' */
    ok('key-phone', normalizeKey({ phone: '+1 (415) 555-2671' }) === 'p:14155552671');
    ok('key-email', normalizeKey({ email: '  Bob@Example.COM ' }) === 'e:bob@example.com');
    ok('key-prefers-phone', normalizeKey({ phone: '+447700900123', email: 'x@y.com' }) === 'p:447700900123');
    ok('key-junk-empty', normalizeKey({ phone: 'n/a', email: 'not-an-email' }) === '');
    ok('key-bad-input', normalizeKey(null) === '' && normalizeKey(undefined) === '');

    /* TRICKY 1: two cards, same phone in different formats -> one dedupe */
    var d = dedupe([
      { id: 'a', name: 'Mum', phone: '+44 7700 900123', email: '' },
      { id: 'b', name: 'Mum Mobile', phone: '07700900123', email: 'mum@home.com' }
    ], { country: '44' });
    ok('dedupe-collapses', d.kept.length === 1 && d.merged.length === 1, 'kept=' + d.kept.length + ' merged=' + d.merged.length);
    ok('dedupe-keeps-first-name', d.kept[0] && d.kept[0].name === 'Mum', d.kept[0] && d.kept[0].name);
    ok('dedupe-fills-blank-email', d.kept[0] && d.kept[0].email === 'mum@home.com', d.kept[0] && d.kept[0].email);
    var dk = dedupe([{ name: 'No Contact Info' }, { name: 'Also None' }]);   /* keyless: always kept */
    ok('dedupe-keyless-kept', dk.kept.length === 2 && dk.merged.length === 0, 'kept=' + dk.kept.length);

    /* TRICKY 2: blank-only fill must NOT clobber a non-empty existing field */
    var existing = { id: 'e1', name: 'Aisha', phone: '+447700900999', email: 'aisha@old.com', company: '' };
    var incoming = { name: 'Aisha K', phone: '07700900999', email: 'aisha@new.com', company: 'ESCP' };
    var merged = mergeContact(existing, incoming);
    ok('merge-no-clobber-email', merged.email === 'aisha@old.com', merged.email);
    ok('merge-no-clobber-name', merged.name === 'Aisha', merged.name);
    ok('merge-fills-blank-company', merged.company === 'ESCP', merged.company);
    ok('merge-no-mutate', existing.company === '' && incoming.company === 'ESCP');
    ok('merge-returns-new-object', merged !== existing && merged !== incoming);

    /* diffImport: blank-filling dup -> toUpdate; identical -> duplicate; new -> toAdd */
    var plan = diffImport(
      [ { id: 'x', name: 'Sam', phone: '+12025550100', email: '' } ],
      [ { name: 'Sam', phone: '12025550100', email: 'sam@work.com' },
        { name: 'Sam Again', phone: '+1 202 555 0100' },
        { name: 'Brand New', phone: '+15125550000' } ]
    );
    ok('diff-toUpdate', plan.toUpdate.length === 1 && plan.toUpdate[0].fills.email === 'sam@work.com', 'upd=' + plan.toUpdate.length);
    ok('diff-duplicate', plan.duplicates.length === 1, 'dup=' + plan.duplicates.length);
    ok('diff-toAdd', plan.toAdd.length === 1 && plan.toAdd[0].name === 'Brand New', 'add=' + plan.toAdd.length);

    /* two NEW incoming rows sharing a key -> one add, one duplicate */
    var plan2 = diffImport([], [
      { name: 'Twin A', phone: '+19998887777' },
      { name: 'Twin B', phone: '09998887777', email: '' }
    ], { country: '1' });
    ok('diff-batch-internal-dup', plan2.toAdd.length === 1 && plan2.duplicates.length === 1, 'add=' + plan2.toAdd.length + ' dup=' + plan2.duplicates.length);

    /* TRICKY 3: date backfill from free text, only when not already set */
    var b1 = backfillDates({ notes: 'met in Lisbon, her birthday June 3', context: '' });
    ok('backfill-worded', b1.bday && b1.bday.m === 6 && b1.bday.d === 3, jd(b1.bday));
    var b2 = backfillDates({ notes: 'anniv 12/04', context: '' });
    ok('backfill-numeric-dayfirst', b2.anniv && b2.anniv.m === 4 && b2.anniv.d === 12, jd(b2.anniv));
    var b3 = backfillDates({ bday: { y: null, m: 1, d: 1 }, notes: 'birthday Aug 9' });
    ok('backfill-skips-when-set', !b3.bday, jd(b3.bday));
    var b4 = backfillDates({ notes: 'wedding 3rd of August 1990' });
    ok('backfill-day-of-month', b4.anniv && b4.anniv.m === 8 && b4.anniv.d === 3 && b4.anniv.y === 1990, jd(b4.anniv));
    ok('backfill-none', (function(x){ return !x.bday && !x.anniv; })(backfillDates({ notes: 'no dates here at all' })));
    ok('backfill-invalid-ignored', !backfillDates({ notes: 'birthday 99/99' }).bday);   /* invalid -> no throw */

    /* robustness: never throw on garbage */
    var safe = true;
    try {
      diffImport(null, null); dedupe(null); mergeContact(null, null);
      backfillDates(null); normalizeKey('not an object');
      diffImport([1, 'x', null], [undefined, 42]);
    } catch(e){ safe = false; }
    ok('no-throw-on-garbage', safe, 'all guarded');

    var pass = true;
    for(var i = 0; i < R.length; i++){ if(!R[i].pass){ pass = false; break; } }
    return { pass: pass, results: R };
  }

  G.SovennEnrich = {
    normalizeKey: normalizeKey,
    diffImport: diffImport,
    mergeContact: mergeContact,
    backfillDates: backfillDates,
    dedupe: dedupe,
    _selftest: _selftest
  };
})();
