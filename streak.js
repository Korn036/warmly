/* =====================================================================
   streak.js  —  Sovenn habit loop  (the "kept warm" streak + ritual, moat #1)
   ---------------------------------------------------------------------
   WHAT: a tiny, pure-logic module that turns raw contact activity into a
   visible, kind signal that the keep-in-touch habit is working: a day
   streak ("5-day streak"), a weekly "kept N people warm" count with a
   gentle goal, and one short encouraging line. It also offers small,
   side-effect-free helpers to build a "contacted" log entry so the app
   can do one-tap logging without re-deriving the data shape.

   WHY: the moat is the habit, not the features. People keep a relationship
   app only if it rewards the ten-second daily ritual. This gives that
   reward warmly and HONESTLY (deterministic from real activity), with no
   dark patterns: a broken streak is never punished or guilt-tripped, just
   gently reframed. On-device, computed from data the app already stores.

   PERSONAS / THE MOMENT IT HELPS:
     - Dan, the introvert: opens the app, sees "Nice, 3 kept warm this
       week" instead of a scary backlog — a gentle win that keeps him going.
     - Everyone wanting a calm daily ritual: a glanceable streak that
       celebrates showing up, and softens (never scolds) on a quiet week.

   PRIVACY / SAFETY: ZERO network, no DOM, no storage, no eval, no globals
   beyond window.SovennStreak. Returns DATA (numbers/strings/objects); the
   app renders. Never throws on bad/missing/huge input — always a safe
   default. Deterministic: pass `today` (YYYY-MM-DD); nothing reads the clock.

   STATUS: standalone. NOT referenced by index.html / app.js / sw.js yet.
   INTEGRATION (later, additive): add <script src="streak.js"> before app.js
   (and to the sw.js shell list); on the home view render
   compute(DB.contacts,{today:TODAYISO()}).message + streak/weeklyProgress.

   PUBLIC API (window.SovennStreak):
     compute(contacts, opts)        -> full state object (see below)
     keptWarmThisWeek(contacts, today) -> count of distinct contacts reached
                                          in the last 7 days (inclusive today)
     streakDays(contacts, today)    -> consecutive reach-days ending today/yday
     encouragement(state)           -> one short warm line for that state
     logEntry(opts)                 -> a {date,type:'contacted',note} object
                                       the app may push onto contact.log
     _selftest()                    -> { pass, results:[...] }  (no app/DOM)

   compute(...) returns:
     { streakDays, reachedToday:boolean, keptWarmThisWeek, weeklyGoal,
       weeklyProgress (0..1), lastReached:"YYYY-MM-DD"|null, message }
   A "reach" = a log entry of type 'contacted' or 'call', or the contact's
   lastContacted date. opts = { today:"YYYY-MM-DD", weeklyGoal:int>=1 }.
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  var CFG = { weeklyGoal: 3, weekDays: 7 };

  /* ---- date helpers: string-based, no Date math drift, never throw ---- */
  /* Normalise any value to a "YYYY-MM-DD" string or '' if not a valid date. */
  function toYMD(v){
    if(v == null) return '';
    var s = String(v).slice(0, 10);
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
      var mo = +s.slice(5,7), da = +s.slice(8,10);  /* bounds: reject 0000-99-99 */
      if(mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return s;
    }
    return '';
  }
  /* Days from YMD a to YMD b (b - a) as an integer, via UTC to dodge DST. */
  function dayDiff(a, b){
    var ta = Date.parse(a + 'T00:00:00Z'), tb = Date.parse(b + 'T00:00:00Z');
    if(isNaN(ta) || isNaN(tb)) return NaN;
    return Math.round((tb - ta) / 86400000);
  }

  /* ---- gather every reach-date (deduped) into a YMD->true map ---- */
  /* A reach proves outreach: a 'contacted'/'call' log entry, or lastContacted. */
  function collectReachDates(contacts, into){
    var list = (contacts && contacts.length) ? contacts : [];
    for(var i = 0; i < list.length; i++){
      var c = list[i];
      if(!c || typeof c !== 'object') continue;
      var lc = toYMD(c.lastContacted);
      if(lc) into[lc] = true;
      var log = c.log;
      if(log && log.length){
        for(var j = 0; j < log.length; j++){
          var e = log[j];
          if(!e) continue;
          var t = e.type;
          /* only outreach counts toward the habit; ignore other log kinds */
          if(t === 'contacted' || t === 'call' || t == null){
            var d = toYMD(e.date);
            if(d) into[d] = true;
          }
        }
      }
    }
    return into;
  }

  /* ---- distinct contacts reached within the trailing 7-day window ---- */
  function keptWarmThisWeek(contacts, today){
    today = toYMD(today);
    if(!today) return 0;
    var list = (contacts && contacts.length) ? contacts : [];
    var win = CFG.weekDays;
    var count = 0;
    for(var i = 0; i < list.length; i++){
      var c = list[i];
      if(!c || typeof c !== 'object') continue;
      var dates = collectReachDates([c], {});  /* per-contact => distinct people */
      var hit = false;
      for(var d in dates){
        if(!dates.hasOwnProperty(d)) continue;
        var gap = dayDiff(d, today);
        if(gap >= 0 && gap < win){ hit = true; break; }  /* last 7 incl. today */
      }
      if(hit) count++;
    }
    return count;
  }

  /* ---- consecutive reach-days ending today or yesterday ---- */
  /* Counting from yesterday too is kinder: the streak isn't a false zero each
     morning before the user has had today to act. */
  function streakDays(contacts, today){
    today = toYMD(today);
    if(!today) return 0;
    var dates = collectReachDates(contacts, {});
    if(dates[today] === undefined && dates[isoShift(today, -1)] === undefined) return 0;
    var anchor = (dates[today] !== undefined) ? today : isoShift(today, -1);
    var streak = 0, cur = anchor;
    for(var guard = 0; guard < 36600; guard++){  /* cap: corrupt input can't loop forever */
      if(dates[cur] === undefined) break;
      streak++;
      cur = isoShift(cur, -1);
    }
    return streak;
  }

  /* shift a YMD string by n days; '' on bad input (never throws) */
  function isoShift(ymd, n){
    var t = Date.parse(ymd + 'T00:00:00Z');
    if(isNaN(t)) return '';
    var d = new Date(t + n * 86400000);
    var p = function(x){ return (x < 10 ? '0' : '') + x; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  /* ---- the full glanceable state ---- */
  function compute(contacts, opts){
    opts = opts || {};
    var today = toYMD(opts.today);
    var goal = opts.weeklyGoal;
    goal = (typeof goal === 'number' && goal >= 1) ? Math.floor(goal) : CFG.weeklyGoal;

    if(!today){
      /* no usable date -> safe, honest empty state */
      var emptyState = {
        streakDays: 0, reachedToday: false, keptWarmThisWeek: 0,
        weeklyGoal: goal, weeklyProgress: 0, lastReached: null, message: ''
      };
      emptyState.message = encouragement(emptyState);
      return emptyState;
    }

    var dates = collectReachDates(contacts, {});
    var kept = keptWarmThisWeek(contacts, today);

    /* most recent reach on or before today */
    var lastReached = null;
    for(var d in dates){
      if(!dates.hasOwnProperty(d)) continue;
      if(dayDiff(d, today) >= 0 && (lastReached === null || d > lastReached)) lastReached = d;
    }

    var state = {
      streakDays: streakDays(contacts, today),
      reachedToday: dates[today] !== undefined,
      keptWarmThisWeek: kept,
      weeklyGoal: goal,
      weeklyProgress: Math.min(1, kept / goal),
      lastReached: lastReached,
      message: ''
    };
    state.message = encouragement(state);
    return state;
  }

  /* ---- one short warm line; never guilt-trips, always forward-looking ---- */
  function encouragement(state){
    state = state || {};
    var kept = (typeof state.keptWarmThisWeek === 'number') ? state.keptWarmThisWeek : 0;
    var goal = (typeof state.weeklyGoal === 'number' && state.weeklyGoal >= 1) ? state.weeklyGoal : CFG.weeklyGoal;
    var streak = (typeof state.streakDays === 'number') ? state.streakDays : 0;
    var num = ['no one','one','two','three','four','five','six','seven','eight','nine','ten'];
    function word(n){ return (n >= 0 && n <= 10) ? num[n] : String(n); }
    function people(n){ return n === 1 ? 'person' : 'people'; }

    /* a healthy streak is the proudest signal */
    if(streak >= 2) return word(streak) + '-day streak. You keep showing up.';

    /* met or beat the gentle weekly goal */
    if(kept >= goal && kept > 0){
      if(kept === goal) return 'Nice, ' + word(kept) + ' kept warm this week.';
      return word(kept) + ' kept warm this week, a lovely week.';
    }

    /* some progress, framed as momentum (no "you missed" language) */
    if(kept > 0) return word(kept) + ' ' + people(kept) + ' kept warm this week. Keep it going.';

    /* a quiet week: encouraging, never scolding, no broken-streak shame */
    return 'A quiet week. One hello goes a long way.';
  }

  /* ---- helper: a clean log entry the app can push onto contact.log ---- */
  /* Returns DATA only; it does NOT mutate any contact or touch storage. */
  function logEntry(opts){
    opts = opts || {};
    var date = toYMD(opts.date) || toYMD(opts.today);
    var type = (opts.type === 'call') ? 'call' : 'contacted';
    var note = (opts.note == null) ? '' : String(opts.note);
    return { date: date || '', type: type, note: note };
  }

  /* ---- self-test: pure logic, NO app/DOM/network/model ---- */
  function _selftest(){
    var R = [];
    function eq(name, got, want){ R.push({ name: name, pass: got === want, got: got }); }
    function ok(name, cond, got){ R.push({ name: name, pass: !!cond, got: got }); }

    var T = '2026-06-25';
    function logged(dates, type){ return { id:'x', log: dates.map(function(d){ return { date:d, type:type||'contacted', note:'' }; }) }; }

    /* weekly window: inclusive of today, 7-day trailing, day 8 excluded */
    var within = [ logged(['2026-06-25']), logged(['2026-06-19']) ];  /* today + 6 days ago */
    eq('week-within-7', keptWarmThisWeek(within, T), 2);
    var edge = [ logged(['2026-06-19']) /*in*/, logged(['2026-06-18']) /*out*/ ];
    eq('week-edge-day7-excluded', keptWarmThisWeek(edge, T), 1);
    /* distinct contacts, not distinct days: one person reached twice = 1 */
    var twice = [ logged(['2026-06-25','2026-06-24']) ];
    eq('week-distinct-people', keptWarmThisWeek(twice, T), 1);
    eq('week-ignores-future', keptWarmThisWeek([ logged(['2026-07-01']) ], T), 0);
    eq('week-via-lastContacted', keptWarmThisWeek([{ id:'y', lastContacted:'2026-06-23' }], T), 1);

    /* streak: consecutive reach-days, gaps break it, stale runs are zero */
    var run = [ logged(['2026-06-25','2026-06-24','2026-06-23']) ];
    eq('streak-3-consecutive', streakDays(run, T), 3);
    var gap = [ logged(['2026-06-25','2026-06-24','2026-06-22']) ];
    eq('streak-stops-at-gap', streakDays(gap, T), 2);
    var yday = [ logged(['2026-06-24','2026-06-23']) ];  /* kind: can end yesterday */
    eq('streak-ends-yesterday', streakDays(yday, T), 2);
    var stale = [ logged(['2026-06-20','2026-06-19']) ]; /* ended 2+ days ago */
    eq('streak-stale-is-zero', streakDays(stale, T), 0);
    var split = [ logged(['2026-06-25']), logged(['2026-06-24']) ]; /* chains across contacts */
    eq('streak-across-contacts', streakDays(split, T), 2);
    var dup = [ logged(['2026-06-25','2026-06-25','2026-06-24']) ];
    eq('streak-dedupes-day', streakDays(dup, T), 2);

    /* graceful empties / bad input: never throw, safe defaults */
    eq('empty-week', keptWarmThisWeek([], T), 0);
    eq('empty-streak', streakDays([], T), 0);
    eq('null-contacts-week', keptWarmThisWeek(null, T), 0);
    eq('null-contacts-streak', streakDays(undefined, T), 0);
    eq('bad-today-week', keptWarmThisWeek(within, 'not-a-date'), 0);
    eq('bad-today-streak', streakDays(run, ''), 0);
    eq('garbage-dates-ignored', keptWarmThisWeek([ logged(['0000-99-99','banana']) ], T), 0);

    ok('survives-junk-contacts', (function(){  /* junk shapes skipped, not fatal */
      try { keptWarmThisWeek([null, 7, 'x', {}, { log:[null, {}, {date:'2026-06-25',type:'contacted'}] }], T); streakDays([null,{}], T); return true; }
      catch(e){ return false; }
    })(), 'no throw');

    /* compute(): wires it together */
    var st = compute(within, { today: T, weeklyGoal: 3 });
    ok('compute-kept', st.keptWarmThisWeek === 2, st.keptWarmThisWeek);
    ok('compute-reachedToday', st.reachedToday === true, st.reachedToday);
    ok('compute-progress', st.weeklyProgress === 2/3, st.weeklyProgress);
    ok('compute-lastReached', st.lastReached === '2026-06-25', st.lastReached);
    ok('compute-progress-capped', compute(twice.concat(within), { today:T, weeklyGoal:1 }).weeklyProgress === 1, 'cap@1');
    ok('compute-has-message', typeof st.message === 'string' && st.message.length > 0, st.message);

    var emptySt = compute([], { today: T });
    ok('compute-empty-defaults', emptySt.streakDays === 0 && emptySt.keptWarmThisWeek === 0 && emptySt.lastReached === null && emptySt.weeklyGoal === 3, JSON.stringify(emptySt));
    ok('compute-bad-today-safe', (function(){ var s = compute(within, { today:'nope' }); return s.streakDays === 0 && s.lastReached === null && typeof s.message === 'string'; })(), 'safe');
    ok('compute-bad-goal-default', compute([], { today:T, weeklyGoal:0 }).weeklyGoal === 3, 'goal>=1');

    /* encouragement(): warm, no dark patterns, no throw on junk */
    ok('enc-streak-line', /streak/.test(encouragement({ streakDays:5, keptWarmThisWeek:5, weeklyGoal:3 })), encouragement({ streakDays:5 }));
    ok('enc-goal-met', /kept warm this week/.test(encouragement({ streakDays:0, keptWarmThisWeek:3, weeklyGoal:3 })), 'goal');
    ok('enc-quiet-gentle', (function(){ var m = encouragement({ streakDays:0, keptWarmThisWeek:0, weeklyGoal:3 }); return /quiet|hello/.test(m) && !/miss|fail|broke|lost|streak/.test(m); })(), 'gentle');
    ok('enc-no-throw-on-junk', (function(){ try { encouragement(null); encouragement(undefined); encouragement({}); return true; } catch(e){ return false; } })(), 'safe');

    /* logEntry(): data only, correct shape */
    var le = logEntry({ today: T, note: 'coffee' });
    ok('logEntry-shape', le.date === T && le.type === 'contacted' && le.note === 'coffee', JSON.stringify(le));
    ok('logEntry-call-type', logEntry({ date:T, type:'call' }).type === 'call', 'call');
    ok('logEntry-safe-empty', (function(){ var x = logEntry(); return x.type === 'contacted' && x.note === '' && x.date === ''; })(), 'safe');

    var pass = true;
    for(var i = 0; i < R.length; i++){ if(!R[i].pass){ pass = false; break; } }
    return { pass: pass, results: R };
  }

  G.SovennStreak = {
    compute: compute,
    keptWarmThisWeek: keptWarmThisWeek,
    streakDays: streakDays,
    encouragement: encouragement,
    logEntry: logEntry,
    _selftest: _selftest,
    _cfg: CFG
  };
})();
