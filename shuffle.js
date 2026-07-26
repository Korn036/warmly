/* =====================================================================
   shuffle.js  —  Sovenn Smart Surfacing 2.0  (the daily-open habit hook, moat #1)
   ---------------------------------------------------------------------
   WHAT: an INTELLIGENT replacement for the dumb random shuffle. Given the
   contact list and "today", it scores everyone and returns the people who
   most deserve a warm nudge right now, best-first, each with a ready human
   "why now" reason ("birthday in 3 days", "it has been about 5 months").
   This is THE daily ritual: open the app, see one kind nudge.

   WHY: random surfacing wastes the one moment of attention we get per day.
   A smart score surfaces the RIGHT person — birthday near, drifting past
   cadence, or an inner-circle tie kept close — so the habit feels caring,
   not noisy. The daily-stable rotation varies day to day yet never jitters
   within a day, and never repeats the same top person two mornings running
   when anyone else is worth surfacing.

   PERSONAS + THE MOMENT IT HELPS:
     - Dan (introvert who forgets): opens once a day, wants one answer to
       "who should I reach out to today?" — zero decisions.
     - Maya (diaspora maintainer): keeps faraway family warm on a cadence;
       overdue + upcoming dates should rise.
     - Aisha (deliberate super-networker): works a large list on purpose,
       wants a ranked queue (limit>1) that rotates fairly day to day.

   PRIVACY / SAFETY: ZERO network, no DOM, no storage, no eval, no Date or
   Math.random inside the scorer. Deterministic given (contacts,today,seed).
   Never throws on bad/missing/huge input — always a safe default. Returns
   DATA only; the app renders. No global leakage beyond window.SovennShuffle.

   STATUS: standalone. NOT referenced by index.html / app.js / sw.js. No
   side effects on load beyond defining window.SovennShuffle.

   INTEGRATION (later, additive): in the daily view, call
     var top = SovennShuffle.pick(DB.contacts, {today:todayISO(), seed:daySeed, limit:1});
     // top[0] -> { contact, score, reason, factors }; render contact + reason.
   Persist nothing here; pass yesterday's surfaced id as opts.avoidId for an
   extra hard guard against repeats.

   PUBLIC API (window.SovennShuffle):
     pick(contacts, opts)      -> [{ contact, score, reason, factors }] best-first
     score(contact, opts)      -> { score, reason, factors }
     reasonFor(contact, today) -> short warm "why now" string
     hasRealReason(contact, today) -> bool, true only when reasonFor's answer is a
       genuine signal (event/overdue/gap), not the generic tier fallback
     daysBetween(aISO, bISO)   -> integer day delta (b - a), or null
     addMonths(iso, n)         -> "YYYY-MM-DD" with month-end clamp
     _selftest()               -> { pass, results }  (no app/DOM/net/model)

   opts: { today:"YYYY-MM-DD", limit (default 1), seed (number, daily-stable
     rotation), now (hour 0-23, time-of-day nudge), avoidId (id surfaced
     yesterday, demoted if alternatives exist) }
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  /* ---- tunables: weights chosen so each factor can lead when it matters ---- */
  var W = {
    tier:      [0, 30, 18, 8], /* by tier 1/2/3; tier 1 kept closest */
    overdue:   1.4,            /* points per day past the cadence due date */
    overdueCap:120,            /* cap so one ancient contact cannot dominate */
    eventNear: 80,             /* a date within the window, scaled by closeness */
    eventWindow:14,            /* days ahead a date counts as "imminent" */
    recency:   0.10,           /* gentle pull per day since last contact */
    recencyCap:120,            /* cap recency contribution */
    neverCad:  22,             /* nudge for cadence set but never contacted */
    rotation:  9,              /* daily-stable jitter span (tie-breaker) */
    dirAlpha:  3,              /* directory-mode: A-first tie-break span, kept under the
                                   weakest in-window event score so a real date always wins */
    dirReal:   6                /* directory-mode: flat band bonus added once hasRealReason()
                                   is true. Strictly greater than dirAlpha's max span (3) so
                                   the real-reason band and the no-signal band can never
                                   interleave, regardless of name (review correction) */
  };

  /* ---- safe primitives (never throw) ---- */
  function num(v){ var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function clampN(n, lo, hi){ return n < lo ? lo : (n > hi ? hi : n); }
  function str(v){ return v == null ? '' : String(v); }
  function arr(v){ return (v && typeof v.length === 'number' && typeof v !== 'string') ? v : []; }

  /* ---- date math (parse "YYYY-MM-DD", days-between, add-months w/ clamp) ---- */
  /* Returns {y,m,d} from an ISO-ish string, or null. Tolerates extra time chars. */
  function parseISO(iso){
    var s = str(iso).slice(0, 10);
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if(!m) return null;
    var y = +m[1], mo = +m[2], da = +m[3];
    if(mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return { y: y, m: mo, d: da };
  }
  /* days since a fixed epoch via a pure proleptic-Gregorian count (no Date). */
  function toDayNumber(p){
    if(!p) return null;
    var a = Math.floor((14 - p.m) / 12);   /* shift Jan/Feb to prior year */
    var yy = p.y + 4800 - a, mm = p.m + 12 * a - 3;
    return p.d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
           Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  }
  function isoToDay(iso){ var p = parseISO(iso); return p ? toDayNumber(p) : null; }
  /* b - a in whole days; null if either is unparseable. */
  function daysBetween(aISO, bISO){
    var a = isoToDay(aISO), b = isoToDay(bISO);
    return (a == null || b == null) ? null : b - a;
  }
  function lastDayOfMonth(y, m){ /* m: 1-12 */
    if(m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
    return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
  }
  function pad2(n){ n = String(n); return n.length < 2 ? '0' + n : n; }
  /* add-months with month-end clamp (Jan 31 +1mo -> Feb 28/29). Returns ISO or ''. */
  function addMonths(iso, n){
    var p = parseISO(iso);
    if(!p) return '';
    n = Math.round(num(n));
    var total = (p.y * 12 + (p.m - 1)) + n;
    var y = Math.floor(total / 12);
    var m = (total % 12) + 1;
    var d = Math.min(p.d, lastDayOfMonth(y, m));
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  /* ---- days until the next yearly recurrence of a month/day from `today` ---- */
  /* Pure: derives the year from `today`, clamps Feb-29 to Feb-28 in non-leap years. */
  function daysUntilRecurring(m, d, todayISO){
    m = Math.round(num(m)); d = Math.round(num(d));
    if(m < 1 || m > 12 || d < 1 || d > 31) return null;
    var t = parseISO(todayISO);
    if(!t) return null;
    var tDay = toDayNumber(t);
    for(var dy = 0; dy <= 1; dy++){
      var y = t.y + dy;
      var dd = Math.min(d, lastDayOfMonth(y, m));
      var occ = toDayNumber({ y: y, m: m, d: dd });
      if(occ >= tDay) return occ - tDay;
    }
    return null;
  }

  /* ---- daily-stable rotation: a deterministic [0,1) jitter from seed + id ---- */
  /* xorshift-ish hash; same (seed,id) -> same value, different days -> reshuffled. */
  function rotationUnit(seed, id){
    var h = (num(seed) | 0) ^ 0x9e3779b9;
    var s = str(id);
    for(var i = 0; i < s.length; i++){
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = (h * 16777619) >>> 0;     /* FNV-style mix, kept in uint32 */
    }
    h ^= h >>> 13; h = (h * 0x85ebca6b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;  /* [0,1) */
  }

  /* ---- directory mode: stable A-first rank derived from a name, no rotation/Date ---- */
  /* same name -> same value always; earlier alphabetically -> closer to 1. Ranks on the
     first two letters as a base-26 pair so the output genuinely spans [0,1] (a name
     starting "Aa" -> ~1, "Zz" -> ~0); non-letters clamp into the a-z range instead of
     blowing up the scale, and a missing name pins to 0, below every real name. */
  function alphaUnit(name){
    var s = str(name).toLowerCase();
    var c0 = s.length > 0 ? clampN(s.charCodeAt(0) - 97, 0, 25) : 26;
    var c1 = s.length > 1 ? clampN(s.charCodeAt(1) - 97, 0, 25) : 0;
    var v = c0 * 26 + c1;
    return 1 - clampN(v / 676, 0, 1);
  }

  /* ---- collect this contact's nearest upcoming date within the window ---- */
  function nearestEvent(c, todayISO){
    var best = null; /* { kind, label, days } */
    function consider(kind, label, mm, dd){
      var n = daysUntilRecurring(mm, dd, todayISO);
      if(n == null || n > W.eventWindow) return;
      if(!best || n < best.days) best = { kind: kind, label: label, days: n };
    }
    if(c.bday && c.bday.m) consider('birthday', 'birthday', c.bday.m, c.bday.d);
    if(c.anniv && c.anniv.m) consider('anniversary', 'anniversary', c.anniv.m, c.anniv.d);
    var cds = arr(c.customDates);
    for(var i = 0; i < cds.length; i++){
      var cd = cds[i]; if(cd && cd.m) consider('custom', str(cd.label) || 'date', cd.m, cd.d);
    }
    return best;
  }

  /* ---- warm "why now" string ---- */
  function eventPhrase(ev){
    var when = ev.days === 0 ? 'today' : ev.days === 1 ? 'tomorrow' : 'in ' + ev.days + ' days';
    if(ev.kind === 'birthday') return ev.days === 0 ? 'birthday today' : 'birthday ' + when;
    if(ev.kind === 'anniversary') return ev.days === 0 ? 'anniversary today' : 'anniversary ' + when;
    return ev.label + ' ' + when;
  }
  function sincePhrase(days){
    if(days < 31) return 'it has been ' + days + ' day' + (days === 1 ? '' : 's');
    var months = Math.round(days / 30);
    if(months <= 1) return 'it has been about a month';
    if(months < 12) return 'it has been about ' + months + ' months';
    var years = Math.round(days / 365);
    return years <= 1 ? 'it has been about a year' : 'it has been about ' + years + ' years';
  }
  /* warm "why now", in priority order: event > overdue > recency > tier */
  function reasonFor(c, todayISO){
    c = c || {};
    var ev = nearestEvent(c, todayISO);
    if(ev) return eventPhrase(ev);
    if(c.cadence != null && num(c.cadence) > 0){
      if(!c.lastContacted) return 'time for a first hello';
      var over = daysBetween(addMonths(c.lastContacted, c.cadence), todayISO);
      if(over != null && over > 0) return over > 45 ? 'overdue reconnect' : 'about time to reconnect';
    }
    if(c.lastContacted){
      var since = daysBetween(c.lastContacted, todayISO);
      if(since != null && since >= 14) return sincePhrase(since);
    }
    var tier = Math.round(num(c.tier));
    if(tier === 1) return 'you keep them close';
    if(tier === 2) return 'worth keeping warm';
    return 'a good moment to reconnect';
  }

  /* ---- true only when reasonFor found a genuine signal (event, overdue cadence, or a
     real gap in touch), not the generic tier-based fallback. Mirrors reasonFor's first
     three branches so a caller can show the "why now" line without ever showing filler. */
  function hasRealReason(c, todayISO){
    c = c || {};
    if(nearestEvent(c, todayISO)) return true;
    if(c.cadence != null && num(c.cadence) > 0){
      if(!c.lastContacted) return true;
      var over = daysBetween(addMonths(c.lastContacted, c.cadence), todayISO);
      if(over != null && over > 0) return true;
    }
    if(c.lastContacted){
      var since = daysBetween(c.lastContacted, todayISO);
      if(since != null && since >= 14) return true;
    }
    return false;
  }

  /* ---- the core scorer: each factor can lead when it genuinely matters ---- */
  function score(c, opts){
    c = c || {}; opts = opts || {};
    var todayISO = str(opts.today);
    var f = { tier: 0, overdue: 0, event: 0, recency: 0, rotation: 0, timeOfDay: 0, avoid: 0, real: 0 };

    if(opts.mode === 'serendipity'){
      /* VARIETY-first: rotation dominates so the WHOLE list (incl. loose ties) cycles
         day to day, with only a gentle pull toward people gone quiet. This is the
         "rekindle someone you'd forget" slot, deliberately NOT the priority ranking. */
      f.rotation = rotationUnit(opts.seed, c.id) * 100;
      if(c.lastContacted){ var qs = daysBetween(c.lastContacted, todayISO); if(qs != null && qs > 0) f.recency = clampN(qs, 0, W.recencyCap) * 0.15; }
      else { f.recency = 8; }
      if(opts.avoidId != null && str(c.id) === str(opts.avoidId)) f.avoid = -1000;
      var stot = f.rotation + f.recency + f.avoid;
      return { score: Math.round(stot * 100) / 100, reason: reasonFor(c, todayISO), factors: f };
    }

    if(opts.mode === 'directory'){
      /* DIRECTORY-first: browsing the whole list, where most contacts sit at
         tier 3 so W.tier's 30-point spread goes flat and cannot drive order.
         Overdue and an imminent date still lead when real, recency still
         pulls up drift; what is left is broken by a stable A-first rank on
         the name instead of the day-rotating jitter, so a set with nothing
         else going on still reads as a sensible, repeatable order. Never
         reads or writes a tier here beyond that already-flat baseline. */
      if(c.cadence != null && num(c.cadence) > 0){
        if(!c.lastContacted){
          f.overdue = W.neverCad;
        } else {
          var dOver = daysBetween(addMonths(c.lastContacted, c.cadence), todayISO);
          if(dOver != null && dOver > 0) f.overdue = clampN(dOver, 0, W.overdueCap) * W.overdue;
        }
      }

      var dEv = nearestEvent(c, todayISO);
      if(dEv){
        var dCloseness = (W.eventWindow - dEv.days + 1) / (W.eventWindow + 1);
        var dKindBoost = dEv.kind === 'birthday' ? 1 : dEv.kind === 'anniversary' ? 0.95 : 0.8;
        f.event = W.eventNear * dCloseness * dKindBoost;
      }

      if(c.lastContacted){
        var dSince = daysBetween(c.lastContacted, todayISO);
        if(dSince != null && dSince > 0) f.recency = clampN(dSince, 0, W.recencyCap) * W.recency;
      }

      f.rotation = alphaUnit(c.name) * W.dirAlpha; /* stable A-first tie-break, not day rotation */

      /* band bonus (review correction): a genuine reason must ALWAYS outrank a
         no-signal contact, regardless of name. hasRealReason mirrors reasonFor's
         first three branches, so this is exactly "does the row get a reason line".
         dirReal is picked strictly greater than dirAlpha's max span, so the two
         bands can never interleave; within a band, the other factors still order. */
      if(hasRealReason(c, todayISO)) f.real = W.dirReal;

      if(opts.avoidId != null && str(c.id) === str(opts.avoidId)) f.avoid = -100;

      var dtot = f.overdue + f.event + f.recency + f.rotation + f.real + f.avoid;
      return { score: Math.round(dtot * 100) / 100, reason: reasonFor(c, todayISO), factors: f };
    }

    var tier = Math.round(num(c.tier));        /* closer ties get a standing baseline */
    if(tier < 1 || tier > 3) tier = 3;
    f.tier = W.tier[tier] || 0;

    if(c.cadence != null && num(c.cadence) > 0){  /* overdue = lastContacted+cadence vs today */
      if(!c.lastContacted){
        f.overdue = W.neverCad;                /* cadence set but never logged: surface gently */
      } else {
        var over = daysBetween(addMonths(c.lastContacted, c.cadence), todayISO);
        if(over != null && over > 0) f.overdue = clampN(over, 0, W.overdueCap) * W.overdue;
      }
    }

    var ev = nearestEvent(c, todayISO);        /* upcoming date: closer = bigger boost */
    if(ev){
      var closeness = (W.eventWindow - ev.days + 1) / (W.eventWindow + 1); /* (0,1] */
      var kindBoost = ev.kind === 'birthday' ? 1 : ev.kind === 'anniversary' ? 0.95 : 0.8;
      f.event = W.eventNear * closeness * kindBoost;
    }

    if(c.lastContacted){                       /* recency: longer silence pulls up (drift catcher) */
      var since = daysBetween(c.lastContacted, todayISO);
      if(since != null && since > 0) f.recency = clampN(since, 0, W.recencyCap) * W.recency;
    }

    f.rotation = rotationUnit(opts.seed, c.id) * W.rotation; /* daily-stable tie-breaker */

    if(opts.now != null){                      /* gentle time-of-day nudge */
      var hr = Math.round(num(opts.now));
      if(hr >= 18 && hr <= 23 && tier === 1) f.timeOfDay = 4;        /* evenings: reflect on close ties */
      else if(hr >= 6 && hr <= 10 && ev) f.timeOfDay = 4;           /* mornings: act on a date */
    }

    if(opts.avoidId != null && str(c.id) === str(opts.avoidId)) f.avoid = -100; /* don't repeat yesterday */

    var total = f.tier + f.overdue + f.event + f.recency + f.rotation + f.timeOfDay + f.avoid;
    return { score: Math.round(total * 100) / 100, reason: reasonFor(c, todayISO), factors: f };
  }

  /* ---- pick: rank everyone best-first, return the top `limit` ---- */
  function pick(contacts, opts){
    opts = opts || {};
    var list = arr(contacts);
    if(!list.length) return [];
    var limit = opts.limit == null ? 1 : Math.round(num(opts.limit));
    if(limit < 1) limit = 1;

    var scored = [];
    for(var i = 0; i < list.length; i++){
      var c = list[i];
      if(!c || typeof c !== 'object') continue;
      var s = score(c, opts);
      scored.push({ contact: c, score: s.score, reason: s.reason, factors: s.factors, _i: i });
    }
    scored.sort(function(a, b){ return b.score !== a.score ? b.score - a.score : a._i - b._i; });
    var out = [];
    for(var k = 0; k < scored.length && out.length < limit; k++){
      out.push({ contact: scored[k].contact, score: scored[k].score, reason: scored[k].reason, factors: scored[k].factors });
    }
    return out;
  }

  /* ---- self-test: pure logic, no app/DOM/network/model ---- */
  function _selftest(){
    var R = [];
    function ok(name, pass, got){ R.push({ name: name, pass: !!pass, got: got }); }

    var T = '2026-06-25';

    /* date math */
    ok('daysBetween-basic', daysBetween('2026-06-01', T) === 24, daysBetween('2026-06-01', T));
    ok('daysBetween-yearwrap', daysBetween('2025-12-31', '2026-01-01') === 1, daysBetween('2025-12-31', '2026-01-01'));
    ok('daysBetween-bad', daysBetween('nope', T) === null, daysBetween('nope', T));
    ok('addMonths-clamp', addMonths('2026-01-31', 1) === '2026-02-28', addMonths('2026-01-31', 1));
    ok('addMonths-leap', addMonths('2024-01-31', 1) === '2024-02-29', addMonths('2024-01-31', 1));
    ok('addMonths-yearroll', addMonths('2026-11-15', 3) === '2027-02-15', addMonths('2026-11-15', 3));
    ok('addMonths-bad', addMonths('xx', 2) === '', addMonths('xx', 2));
    ok('recur-soon', daysUntilRecurring(7, 1, T) === 6, daysUntilRecurring(7, 1, T));
    ok('recur-today', daysUntilRecurring(6, 25, T) === 0, daysUntilRecurring(6, 25, T));
    ok('recur-wraps-next-year', daysUntilRecurring(1, 1, T) === 190, daysUntilRecurring(1, 1, T));

    /* never throws on garbage; always returns a safe shape */
    var safe = true;
    try {
      score(null, null); score({}, {}); score({ tier: 'x', cadence: 'y', bday: { m: 99, d: 99 } }, { today: 'bad' });
      pick(null, null); pick(undefined); pick([null, 5, {}], { today: T });
      pick([{ id: 'a' }], { limit: -3, today: T });
    } catch(e){ safe = false; }
    ok('never-throws', safe, safe);
    ok('empty-returns-array', pick([]).length === 0, pick([]).length);

    /* overdue cadence ranks UP vs an identical, recently-contacted peer */
    var sOver = score({ id: 'od', tier: 3, cadence: 3, lastContacted: '2025-12-01' }, { today: T }).score; /* due 2026-03-01 */
    var sFresh = score({ id: 'fr', tier: 3, cadence: 3, lastContacted: '2026-06-20' }, { today: T }).score; /* not yet due */
    ok('overdue-outscores-fresh', sOver > sFresh, [sOver, sFresh]);

    /* imminent birthday (in 3 days) ranks UP vs a loose tie with nothing going on */
    var rBday = score({ id: 'bd', tier: 3, bday: { m: 6, d: 28 } }, { today: T });
    var sPlain = score({ id: 'pl', tier: 3 }, { today: T }).score;
    ok('birthday-outscores-plain', rBday.score > sPlain, [rBday.score, sPlain]);
    ok('birthday-reason', rBday.reason === 'birthday in 3 days', rBday.reason);

    /* tier breaks ties: same id (=> identical rotation) isolates tier; inner circle wins */
    var sT1 = score({ id: 'same', tier: 1 }, { today: T, seed: 5 }).score;
    var sT3 = score({ id: 'same', tier: 3 }, { today: T, seed: 5 }).score;
    ok('tier-breaks-tie', sT1 > sT3, [sT1, sT3]);

    /* deterministic: same (contacts, today, seed) => identical ordering & scores */
    var roster = [{ id: 'a', tier: 2 }, { id: 'b', tier: 2 }, { id: 'c', tier: 2 }, { id: 'd', tier: 2 }, { id: 'e', tier: 2 }];
    var run1 = pick(roster, { today: T, seed: 100, limit: 5 });
    var run2 = pick(roster, { today: T, seed: 100, limit: 5 });
    var stable = run1.length === run2.length;
    for(var i = 0; i < run1.length && stable; i++){
      if(run1[i].contact.id !== run2[i].contact.id || run1[i].score !== run2[i].score) stable = false;
    }
    ok('stable-within-day', stable, stable);

    /* rotation: different seeds (different days) reshuffle the all-equal roster */
    function ids(x){ return x.contact.id; }
    var dayA = pick(roster, { today: T, seed: 1, limit: 5 }).map(ids).join('');
    var dayB = pick(roster, { today: T, seed: 2, limit: 5 }).map(ids).join('');
    ok('rotation-varies-by-day', dayA !== dayB, [dayA, dayB]);

    /* avoidId: yesterday's top does not repeat today when alternatives exist */
    var topToday = pick(roster, { today: T, seed: 1, limit: 1 })[0].contact.id;
    var topNext = pick(roster, { today: T, seed: 1, limit: 1, avoidId: topToday })[0].contact.id;
    ok('avoid-prevents-repeat', topNext !== topToday, [topToday, topNext]);

    /* reasonFor stays a warm non-empty string even on empty input; limit honored */
    var rd = reasonFor({}, T);
    ok('reason-safe-default', typeof rd === 'string' && rd.length > 0, rd);
    ok('limit-respected', pick(roster, { today: T, seed: 1, limit: 3 }).length === 3, pick(roster, { today: T, seed: 1, limit: 3 }).length);

    /* directory mode: an all-tier-3, no-signal roster still gets a real order
       (A-first on name), not the input order and not a coin-flip */
    var dirRoster = [
      { id: 'd1', tier: 3, name: 'Dana' },
      { id: 'a1', tier: 3, name: 'Amir' },
      { id: 'e1', tier: 3, name: 'Elan' },
      { id: 'c1', tier: 3, name: 'Chen' },
      { id: 'b1', tier: 3, name: 'Bella' }
    ];
    var dirInput = dirRoster.map(function(c){ return c.id; }).join(',');
    var dirOrder = pick(dirRoster, { today: T, seed: 1, limit: 5, mode: 'directory' }).map(ids).join(',');
    ok('directory-alpha-orders-flat-tier3', dirOrder === 'a1,b1,c1,d1,e1' && dirOrder !== dirInput, [dirOrder, dirInput]);

    /* directory order comes from the name, not the day: two different seeds agree */
    var dirSeedA = pick(dirRoster, { today: T, seed: 1, limit: 5, mode: 'directory' }).map(ids).join(',');
    var dirSeedB = pick(dirRoster, { today: T, seed: 77, limit: 5, mode: 'directory' }).map(ids).join(',');
    ok('directory-stable-across-seeds', dirSeedA === dirSeedB, [dirSeedA, dirSeedB]);

    /* alphaUnit must genuinely span [0,1] so dirAlpha's points are not squeezed into
       a sliver by the letter-code math; the fresh-roster-per-case rule applies since
       an earlier bug here hid behind roster reuse */
    var alphaFirst = score({ id: 'af', tier: 3, name: 'Aaron' }, { today: T, mode: 'directory' }).score;
    var alphaLast = score({ id: 'al', tier: 3, name: 'Zylas' }, { today: T, mode: 'directory' }).score;
    var alphaSpread = alphaFirst - alphaLast;
    ok('directory-alpha-spans-full-weight', alphaSpread > W.dirAlpha * 0.9, [alphaFirst, alphaLast, alphaSpread, W.dirAlpha]);

    /* a genuine upcoming birthday must outrank a merely-early alphabetical name with
       no signal at all, worst case: the birthday contact gets the weakest possible
       alpha (a Z name) and still has to win on the event score alone */
    var sBdayLateAlpha = score({ id: 'bl', tier: 3, name: 'Zara', bday: { m: 7, d: 1 } }, { today: T, mode: 'directory' }).score; /* birthday in 6 days */
    var sFlatEarlyAlpha = score({ id: 'fe', tier: 3, name: 'Aaron' }, { today: T, mode: 'directory' }).score;
    ok('directory-birthday-outranks-alpha', sBdayLateAlpha > sFlatEarlyAlpha, [sBdayLateAlpha, sFlatEarlyAlpha]);

    /* hasRealReason: true for a genuine signal, false for the generic tier fallback */
    ok('has-real-reason-true-for-event', hasRealReason({ id: 'hr1', tier: 3, bday: { m: 6, d: 28 } }, T) === true, hasRealReason({ id: 'hr1', tier: 3, bday: { m: 6, d: 28 } }, T));
    ok('has-real-reason-false-for-fallback', hasRealReason({ id: 'hr2', tier: 3 }, T) === false, hasRealReason({ id: 'hr2', tier: 3 }, T));

    /* same all-tier-3, no-signal roster under DEFAULT mode has nothing but the
       daily rotation jitter to go on, so its order is arbitrary day to day;
       this is the flat/degenerate case directory mode exists to fix */
    var defSeedA = pick(dirRoster, { today: T, seed: 1, limit: 5 }).map(ids).join(',');
    var defSeedB = pick(dirRoster, { today: T, seed: 77, limit: 5 }).map(ids).join(',');
    ok('default-flat-varies-by-seed-tier3', defSeedA !== defSeedB, [defSeedA, defSeedB]);

    /* directory mode never mutates a contact it is handed (fresh objects,
       never touched by an earlier case, so a mutating bug has nowhere to hide) */
    var mutRoster = [
      { id: 'm1', tier: 3, name: 'Fay', cadence: 2, lastContacted: '2026-03-01', bday: { m: 6, d: 27 } },
      { id: 'm2', tier: 3, name: 'Gus' }
    ];
    var mutSnapshot = JSON.stringify(mutRoster);
    score(mutRoster[0], { today: T, mode: 'directory' });
    pick(mutRoster, { today: T, seed: 1, limit: 2, mode: 'directory' });
    var dirUnmutated = JSON.stringify(mutRoster) === mutSnapshot;
    ok('directory-no-mutation', dirUnmutated, dirUnmutated);

    /* regression guard: adding mode:'directory' must not shift default-mode ranking */
    var regRoster = [
      { id: 'r1', tier: 1, name: 'Rae' },
      { id: 'r2', tier: 2, cadence: 2, lastContacted: '2026-03-01', name: 'Nia' },
      { id: 'r3', tier: 3, bday: { m: 6, d: 27 }, name: 'Oz' },
      { id: 'r4', tier: 3, name: 'Kip' },
      { id: 'r5', tier: 2, lastContacted: '2025-01-01', name: 'Wren' }
    ];
    var regOrder = pick(regRoster, { today: T, seed: 42, limit: 5 }).map(ids).join(',');
    ok('default-order-unchanged-by-directory-addition', regOrder === 'r2,r3,r5,r1,r4', regOrder);

    /* CORRECTION 2 (review): directory-mode banding. A real reason must ALWAYS
       outrank a no-signal contact, regardless of name. Every case below uses a
       fresh object, never a shared roster (an earlier bug here hid behind
       roster reuse). */

    /* band invariant at the alphabetical extremes: the weakest possible real
       reason (since exactly 14, the hasRealReason threshold) on the worst
       possible name ("Zzz") still outranks the strongest possible no-signal
       contact (since 13, just under the threshold, best possible name "Aaa"). */
    var bandRealWorstName = score({ id: 'bz1', tier: 3, name: 'Zzz', lastContacted: '2026-06-11' }, { today: T, mode: 'directory' }).score; /* since=14 */
    var bandNoSigBestName = score({ id: 'ba1', tier: 3, name: 'Aaa', lastContacted: '2026-06-12' }, { today: T, mode: 'directory' }).score; /* since=13 */
    ok('directory-real-reason-always-outranks-no-signal', bandRealWorstName > bandNoSigBestName, [bandRealWorstName, bandNoSigBestName]);

    /* within the signal band, a stronger signal still leads: a birthday 6 days
       out outranks a 20-day recency gap, same name so rotation cannot decide it */
    var bandBday = score({ id: 'bb1', tier: 3, name: 'Mid', bday: { m: 7, d: 1 } }, { today: T, mode: 'directory' }).score; /* birthday in 6 days */
    var bandGap20 = score({ id: 'bg1', tier: 3, name: 'Mid', lastContacted: '2026-06-05' }, { today: T, mode: 'directory' }).score; /* since=20 */
    ok('directory-signal-band-birthday-outranks-recency-gap', bandBday > bandGap20, [bandBday, bandGap20]);

    /* within the no-signal band, A-first ordering still holds once neither
       contact has a real reason at all */
    var bandNoSigA = score({ id: 'na1', tier: 3, name: 'Apple' }, { today: T, mode: 'directory' }).score;
    var bandNoSigB = score({ id: 'nb1', tier: 3, name: 'Banana' }, { today: T, mode: 'directory' }).score;
    ok('directory-no-signal-band-alpha-still-orders', bandNoSigA > bandNoSigB, [bandNoSigA, bandNoSigB]);

    var pass = R.every(function(x){ return x.pass; });
    return { pass: pass, results: R };
  }

  G.SovennShuffle = {
    pick: pick,
    score: score,
    reasonFor: reasonFor,
    hasRealReason: hasRealReason,
    daysBetween: daysBetween,
    addMonths: addMonths,
    _selftest: _selftest,
    _cfg: W
  };
})();
