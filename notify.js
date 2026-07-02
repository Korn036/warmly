/* =====================================================================
   notify.js  —  Sovenn on-device nudges  (the "actually remind me" layer)
   ---------------------------------------------------------------------
   WHAT: pure logic that decides WHO is due a nudge today/soon and turns it
   into one warm, human "why now" line, plus a thin, feature-detected wrap
   over the Notification API to fire a LOCAL notification.

   WHY / HONEST WEB LIMITS: NO push server, NO network of any kind — that
   on-device property is the moat. A web app cannot reliably run a true
   background scheduler, so this surfaces due people on app open / on the
   visibilitychange event and fires a Notification when permission is
   granted. Installed as a TWA on Android, local Notifications work well;
   iOS Safari is limited (needs Home-Screen install, still throttled). When
   notifications are unavailable, dueToday/digest still work and the app
   shows the same nudges in-app — we never claim we sent what we did not.

   PERSONAS / THE MOMENT: the diaspora maintainer (friends across time
   zones) opens the app and instantly sees "2 birthdays today, 3 to
   reconnect with" with a reason each, before the day gets away; and
   everyone who just needs the app to actually remind them — one glanceable
   daily line, not a wall of numbers.

   STATUS: standalone. NOT yet referenced by index.html, app.js or sw.js.
   No side effects on load beyond defining window.SovennNotify.

   INTEGRATION (later, all additive): (1) load notify.js in index.html +
   add it to the sw.js SHELL list; (2) on app open / visibilitychange,
   dueToday(DB.contacts,{today}) -> render in-app always, and when
   permission()==='granted' notify({title,body:digest(...),tag:'daily-'+
   today}) (the tag de-dupes to one per day); (3) a Settings "Remind me"
   toggle calls requestPermission() — from a user tap only, NEVER on load.

   PUBLIC API (window.SovennNotify):
     dueToday(contacts, opts) -> ordered array of nudges (pure, testable)
     digest(contacts, today)  -> short one-line summary string (pure)
     permission()             -> 'granted'|'denied'|'default'|'unsupported'
     requestPermission()      -> Promise<same enum>  (guarded, no throw)
     notify({title,body,tag}) -> Promise<boolean>     (guarded, no throw)
     _selftest()              -> { pass, results }     (no browser needed)

   nudge = { contact, kind:'birthday'|'anniversary'|'custom'|'reconnect',
     reason } (reason = a ready-to-show "why now" string).
   opts = { today:'YYYY-MM-DD' (default local today), horizonDays (default
     0 = only today), includeOverdueCadence (default true) }.
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  var DAY = 86400000;
  /* kind ordering for a calm, human priority: celebrate first, then reconnect */
  var ORDER = { birthday: 0, anniversary: 1, custom: 2, reconnect: 3 };

  /* ---- safe date helpers (UTC math, no timezone drift, never throw) ---- */
  function pad2(n){ n = String(n); return n.length < 2 ? '0' + n : n; }

  /* parse 'YYYY-MM-DD' (or leading 10 chars of a longer ISO) -> UTC ms, else NaN */
  function isoToMs(iso){
    if(iso == null) return NaN;
    var m = String(iso).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return NaN;
    var y = +m[1], mo = +m[2], d = +m[3];
    if(mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
    var t = Date.UTC(y, mo - 1, d);
    var chk = new Date(t); /* reject overflow like 02-31 (JS rolls it into March) */
    if(chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return NaN;
    return t;
  }

  function msToIso(ms){
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /* local today's date as 'YYYY-MM-DD' (only fallback that touches the clock) */
  function localTodayIso(){
    try {
      var t = new Date();
      return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
    } catch(e){ return '1970-01-01'; }
  }

  /* resolve the anchor "today" ms; defaults to local today if missing/bad */
  function anchorMs(today){
    var ms = isoToMs(today);
    return isNaN(ms) ? isoToMs(localTodayIso()) : ms;
  }

  /* whole days until the next yearly (month,day) on/after anchor; Feb 29 clamps to month end */
  function daysUntilYearly(m, d, anchor){
    m = +m; d = +d;
    if(!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    var y = new Date(anchor).getUTCFullYear();
    function occ(year){
      var last = new Date(Date.UTC(year, m, 0)).getUTCDate(); /* day 0 of next month = last day */
      return Date.UTC(year, m - 1, d > last ? last : d);
    }
    var when = occ(y);
    if(when < anchor) when = occ(y + 1);
    return Math.round((when - anchor) / DAY);
  }

  /* add calendar months to an ISO date, clamping the day (Jan 31 +1mo = Feb 28); NaN if bad */
  function addMonthsMs(iso, n){
    var ms = isoToMs(iso);
    if(isNaN(ms)) return NaN;
    var d = new Date(ms);
    var y = d.getUTCFullYear(), mo = d.getUTCMonth() + (+n || 0), day = d.getUTCDate();
    var ny = y + Math.floor(mo / 12);
    var nm = ((mo % 12) + 12) % 12;
    var last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return Date.UTC(ny, nm, day > last ? last : day);
  }

  /* ---- presentation helpers (warm, human, NO raw numbers where avoidable) ---- */
  function callNameOf(c){
    if(!c) return 'them';
    var cn = c.callName != null ? String(c.callName).trim() : '';
    if(cn) return cn;
    var nm = c.name != null ? String(c.name).trim() : '';
    if(nm){ var first = nm.split(/\s+/)[0]; if(first) return first; }
    return 'them';
  }

  /* "today" | "tomorrow" | "in N days" — kept human */
  function whenPhrase(n){
    if(n <= 0) return 'today';
    if(n === 1) return 'tomorrow';
    return 'in ' + n + ' days';
  }

  /* "5 months" | "a month" etc., from a day count, for the reconnect reason */
  function overdueAge(days){
    if(days <= 0) return '';
    if(days >= 60){ var mo = Math.round(days / 30); return 'about ' + mo + ' months'; }
    if(days >= 26) return 'about a month';
    if(days >= 12){ var wk = Math.round(days / 7); return 'about ' + wk + ' weeks'; }
    if(days === 1) return 'a day';
    return days + ' days';
  }

  /* ---- the pure engine: who is due, and why ---- */

  /* collect dated occasions (birthday/anniversary/custom) for one contact */
  function occasionsFor(c, anchor, horizon){
    var out = [];
    if(!c || typeof c !== 'object') return out;
    var name = callNameOf(c);

    function push(kind, label, dt){
      if(!dt) return;
      var n = daysUntilYearly(dt.m, dt.d, anchor);
      if(n == null || n < 0 || n > horizon) return;
      var reason;
      if(kind === 'birthday') reason = "It's " + name + "'s birthday " + whenPhrase(n) + '.';
      else if(kind === 'anniversary') reason = name + "'s anniversary is " + whenPhrase(n) + '.';
      else reason = (label || 'A date') + ' for ' + name + ' is ' + whenPhrase(n) + '.';
      out.push({ contact: c, kind: kind, reason: reason, _n: n, _order: ORDER[kind] });
    }

    if(c.bday && c.bday.m) push('birthday', 'birthday', c.bday);
    if(c.anniv && c.anniv.m) push('anniversary', 'anniversary', c.anniv);
    var cds = c.customDates;
    if(cds && cds.length){
      for(var i = 0; i < cds.length; i++){
        var cd = cds[i];
        if(cd && cd.m) push('custom', cd.label, cd);
      }
    }
    return out;
  }

  /* reconnect nudge if a cadence is set and the next-due date has passed */
  function reconnectFor(c, anchor){
    if(!c || typeof c !== 'object') return null;
    var cad = +c.cadence;
    if(!cad || cad <= 0) return null;
    var name = callNameOf(c);
    var dueMs;
    if(c.lastContacted){
      dueMs = addMonthsMs(c.lastContacted, cad);
      if(isNaN(dueMs)) dueMs = anchor; /* unparseable -> treat as due now */
    } else {
      dueMs = anchor; /* never contacted but tracked -> due now */
    }
    if(dueMs > anchor) return null; /* not due yet */
    var over = Math.round((anchor - dueMs) / DAY);
    var age = overdueAge(over);
    var reason = c.lastContacted
      ? (age ? "It's been " + age + ' since you reached out to ' + name + '.'
             : 'Time to reconnect with ' + name + '.')
      : 'You set a reminder to keep up with ' + name + ' — say hi.';
    return { contact: c, kind: 'reconnect', reason: reason, _n: -over, _order: ORDER.reconnect };
  }

  /* dueToday: ordered nudges. Pure, deterministic given opts.today. Never throws. */
  function dueToday(contacts, opts){
    if(!contacts || typeof contacts.length !== 'number') return [];
    opts = opts || {};
    var anchor = anchorMs(opts.today);
    if(isNaN(anchor)) return [];
    var horizon = (typeof opts.horizonDays === 'number' && opts.horizonDays >= 0)
      ? Math.floor(opts.horizonDays) : 0;
    var wantReconnect = opts.includeOverdueCadence !== false; /* default true */

    var nudges = [];
    for(var i = 0; i < contacts.length; i++){
      var c = contacts[i];
      if(!c || typeof c !== 'object') continue;
      var occ = occasionsFor(c, anchor, horizon);
      for(var j = 0; j < occ.length; j++) nudges.push(occ[j]);
      if(wantReconnect){
        var rc = reconnectFor(c, anchor);
        if(rc) nudges.push(rc);
      }
    }

    /* human-first: celebrations before reconnects, then soonest/most-overdue, then name */
    nudges.sort(function(a, b){
      if(a._order !== b._order) return a._order - b._order;
      if(a._n !== b._n) return a._n - b._n;          /* sooner / more overdue first */
      var an = callNameOf(a.contact).toLowerCase();
      var bn = callNameOf(b.contact).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    /* strip private sort fields so callers get a clean shape */
    var clean = [];
    for(var k = 0; k < nudges.length; k++){
      clean.push({ contact: nudges[k].contact, kind: nudges[k].kind, reason: nudges[k].reason });
    }
    return clean;
  }

  /* pluralize a count + noun into "1 birthday" / "2 birthdays" */
  function plur(n, one, many){ return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* digest: one short, warm summary line for a single daily notification. Pure. */
  function digest(contacts, today){
    var nudges = dueToday(contacts, { today: today, horizonDays: 0, includeOverdueCadence: true });
    if(!nudges.length) return 'No nudges today — you are all caught up.';
    var counts = { birthday: 0, anniversary: 0, custom: 0, reconnect: 0 };
    for(var i = 0; i < nudges.length; i++) counts[nudges[i].kind]++;

    var parts = [];
    if(counts.birthday) parts.push(plur(counts.birthday, 'birthday') + ' today');
    if(counts.anniversary) parts.push(plur(counts.anniversary, 'anniversary', 'anniversaries'));
    if(counts.custom) parts.push(plur(counts.custom, 'reminder'));
    if(counts.reconnect) parts.push(plur(counts.reconnect, 'person', 'people') + ' to reconnect with');

    if(parts.length === 1) return cap(parts[0]) + '.';
    var last = parts.pop();
    return cap(parts.join(', ') + ' and ' + last) + '.';
  }

  function cap(s){ s = String(s == null ? '' : s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ---- Notification API: feature-detected + guarded EXACTLY like ai.js (never throws) ---- */
  function notifAPI(){
    try { return (typeof G.Notification !== 'undefined' && G.Notification) ? G.Notification : null; }
    catch(e){ return null; }
  }

  /* permission(): synchronous read of current state, or 'unsupported' */
  function permission(){
    var N = notifAPI();
    if(!N) return 'unsupported';
    try {
      var p = N.permission;
      return (p === 'granted' || p === 'denied' || p === 'default') ? p : 'default';
    } catch(e){ return 'unsupported'; }
  }

  /* requestPermission(): call ONLY from a user gesture, never on load. Resolves
     to the enum; 'unsupported' if the API is absent; never rejects. */
  function requestPermission(){
    var N = notifAPI();
    if(!N || typeof N.requestPermission !== 'function') return Promise.resolve('unsupported');
    return new Promise(function(resolve){
      var settled = false;
      function done(p){
        if(settled) return; settled = true;
        resolve(p === 'granted' || p === 'denied' || p === 'default' ? p : 'default');
      }
      try {
        var ret = N.requestPermission(done); /* old Safari: callback; modern: Promise */
        if(ret && typeof ret.then === 'function') ret.then(done, function(){ done('default'); });
      } catch(e){ done('default'); }
    });
  }

  /* notify(): show ONE local notification if permitted; else resolve false.
     Feature-detected, guarded, never throws, never auto-called on load. */
  function notify(o){
    o = o || {};
    var N = notifAPI();
    if(!N) return Promise.resolve(false);
    var perm;
    try { perm = N.permission; } catch(e){ return Promise.resolve(false); }
    if(perm !== 'granted') return Promise.resolve(false);

    var title = o.title != null ? String(o.title) : 'Sovenn';
    var opts = {};
    if(o.body != null) opts.body = String(o.body);
    if(o.tag != null) opts.tag = String(o.tag); /* tag de-dupes one daily digest */
    if(o.icon != null) opts.icon = String(o.icon);
    opts.silent = false;

    /* Android Chrome, installed PWAs, and TWAs REQUIRE ServiceWorkerRegistration.showNotification();
       the page-context `new Notification()` constructor THROWS there (the flagship daily nudge was
       silently dead on every Play-install device). Prefer the SW path; fall back to the constructor
       only on desktop where a SW may be absent. Never throw, never hang. */
    return new Promise(function(resolve){
      var settled = false; function done(v){ if(settled) return; settled = true; resolve(!!v); }
      function viaConstructor(){
        try {
          var n = new N(title, opts); /* constructing shows it; DATA only, no HTML */
          if(n && typeof n.addEventListener === 'function') n.addEventListener('error', function(){ done(false); });
          done(true);
        } catch(e){ done(false); }
      }
      try {
        if(typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.ready &&
           typeof ServiceWorkerRegistration !== 'undefined' && ServiceWorkerRegistration.prototype &&
           typeof ServiceWorkerRegistration.prototype.showNotification === 'function'){
          var to = setTimeout(function(){ done(false); }, 3000); /* don't hang if the SW never becomes ready */
          navigator.serviceWorker.ready
            .then(function(reg){ return reg.showNotification(title, opts); })
            .then(function(){ clearTimeout(to); done(true); },
                  function(){ clearTimeout(to); viaConstructor(); });
          return;
        }
      } catch(e){}
      viaConstructor();
    });
  }

  /* ---- self-test: PURE logic, runs with NO app/DOM/network/Notification ---- */
  function _selftest(){
    var R = [];
    function ok(name, pass, got){ R.push({ name: name, pass: !!pass, got: got }); }
    function eq(name, got, want){ R.push({ name: name, pass: got === want, got: got }); }

    var T = '2026-06-25'; /* fixed anchor for determinism */

    /* birthday exactly today: count, kind, warm reason */
    var bToday = [{ name: 'Aisha Khan', callName: 'Aisha', bday: { y: 1996, m: 6, d: 25 } }];
    var d1 = dueToday(bToday, { today: T });
    eq('bday-today-count', d1.length, 1);
    ok('bday-today-kind', d1[0] && d1[0].kind === 'birthday', d1[0] && d1[0].kind);
    ok('bday-today-reason', d1[0] && /Aisha.*birthday today/.test(d1[0].reason), d1[0] && d1[0].reason);

    /* horizon: tomorrow hidden at h0, visible at h7 */
    var bTom = [{ name: 'Tomo', bday: { m: 6, d: 26 } }];
    eq('bday-tomorrow-h0', dueToday(bTom, { today: T }).length, 0);
    eq('bday-tomorrow-h7', dueToday(bTom, { today: T, horizonDays: 7 }).length, 1);

    /* reconnect: overdue cadence fires with a human, NaN-free reason */
    var rec = [{ name: 'Sam Lee', callName: 'Sam', cadence: 3, lastContacted: '2026-01-01' }];
    var d2 = dueToday(rec, { today: T });
    eq('reconnect-count', d2.length, 1);
    ok('reconnect-kind', d2[0] && d2[0].kind === 'reconnect', d2[0] && d2[0].kind);
    ok('reconnect-reason-human', d2[0] && /Sam/.test(d2[0].reason) && !/NaN/.test(d2[0].reason), d2[0] && d2[0].reason);

    /* reconnect: recent = not due; never-contacted+tracked = due; toggle suppresses */
    eq('reconnect-not-due', dueToday([{ name: 'Fresh', cadence: 6, lastContacted: '2026-06-01' }], { today: T }).length, 0);
    eq('reconnect-never', dueToday([{ name: 'New', cadence: 6, lastContacted: null }], { today: T }).length, 1);
    eq('reconnect-suppressed', dueToday(rec, { today: T, includeOverdueCadence: false }).length, 0);

    /* Feb 29 in a non-leap year clamps to Feb 28 (still found) */
    eq('leap-feb29', dueToday([{ name: 'Leap', bday: { m: 2, d: 29 } }], { today: '2027-02-28', horizonDays: 1 }).length, 1);

    /* ordering: a birthday today comes before a long-overdue reconnect */
    var d3 = dueToday([{ name: 'Reco', cadence: 1, lastContacted: '2026-01-01' }, { name: 'Bday', bday: { m: 6, d: 25 } }], { today: T });
    ok('order-bday-first', d3.length === 2 && d3[0].kind === 'birthday' && d3[1].kind === 'reconnect',
       d3.map(function(x){ return x.kind; }).join(','));

    /* digest: counts, join word, trailing period, empty fallback */
    var many = [{ bday: { m: 6, d: 25 } }, { bday: { m: 6, d: 25 } },
      { cadence: 1, lastContacted: '2026-01-01' }, { cadence: 1, lastContacted: '2026-01-01' }, { cadence: 1, lastContacted: '2026-01-01' }];
    var dg = digest(many, T);
    ok('digest-birthdays', /2 birthdays today/.test(dg), dg);
    ok('digest-reconnect', /3 people to reconnect with/.test(dg), dg);
    ok('digest-joined', /and/.test(dg) && /\.$/.test(dg), dg);
    eq('digest-empty', digest([], T), 'No nudges today — you are all caught up.');

    /* robustness: garbage/missing input never throws, returns safe defaults */
    eq('null-contacts', dueToday(null).length, 0);
    eq('undefined-contacts', dueToday(undefined).length, 0);
    eq('not-array', dueToday({}).length, 0);
    eq('junk-rows', dueToday([null, undefined, 42, 'x', {}, { bday: {} }, { customDates: null }, { cadence: 0 }], { today: T }).length, 0);
    eq('bad-today', dueToday(bToday, { today: 'not-a-date' }).length >= 0, true);

    /* date guards: bad components rejected, valid parse exact */
    eq('bad-month', dueToday([{ bday: { m: 13, d: 1 } }], { today: T }).length, 0);
    eq('overflow-feb31', isNaN(isoToMs('2026-02-31')), true);
    eq('valid-iso', isoToMs('2026-06-25') === Date.UTC(2026, 5, 25), true);
    eq('addmonths-clamp', msToIso(addMonthsMs('2026-01-31', 1)), '2026-02-28');
    eq('addmonths-bad', isNaN(addMonthsMs('garbage', 1)), true);

    /* name fallback + permission enum (unsupported outside a browser) */
    eq('callname-fallback', callNameOf({ name: 'Maria Gomez' }), 'Maria');
    eq('callname-empty', callNameOf({}), 'them');
    var perm = permission();
    ok('permission-enum', perm === 'granted' || perm === 'denied' || perm === 'default' || perm === 'unsupported', perm);

    var pass = R.every(function(x){ return x.pass; });
    return { pass: pass, results: R };
  }

  G.SovennNotify = {
    dueToday: dueToday,
    digest: digest,
    permission: permission,
    requestPermission: requestPermission,
    notify: notify,
    _selftest: _selftest
  };
})();
