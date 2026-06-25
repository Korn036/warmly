/* =====================================================================
   memory.js  —  Sovenn accumulated relationship memory  (moat #1 / #3)
   ---------------------------------------------------------------------
   WHAT: turns the pile of notes, log entries and message history stored
   about a person into a FEW warm, human lines shown the moment you open
   that contact (or get surfaced): "You last spoke about 4 months ago.",
   "You said you would send the book.", "Birthday in 9 days." Pure
   derivation from stored data — NO AI model, no network, nothing leaves
   the phone.

   WHY: the memory is the real switching cost. A rival copies the UI in a
   weekend; they cannot copy what you remember about your people. Making
   that memory feel alive on every card is the moat. Deterministic and
   offline by design, so it always works instantly — even in airplane mode.

   PERSONAS / THE MOMENT IT HELPS:
     - Marco (founder): before a call, instantly recalls "met at the Lisbon
       summit, runs ops, owes me an intro" without re-reading a wall of notes.
     - The connector: returning after months, sees the open threads
       ("promised to introduce them to Sara") so nothing is dropped.
     - Anyone reopening a contact cold: the recap makes the relationship
       feel remembered, not abandoned.

   GUARDRAILS: never throws — always a safe default ([] / {days:null,…} / '').
   Every field is treated as untrusted. Deterministic: pass today as an ISO
   "YYYY-MM-DD" string; nothing calls new Date()/Math.random(), so it is
   testable. ZERO network, no eval/new Function, no DOM, no localStorage, no
   globals beyond window.SovennMemory. Returns PLAIN TEXT only (no HTML),
   the app renders and escapes.

   STATUS: standalone, additive. NOT referenced by index.html/app.js/sw.js
   yet; integrate by calling SovennMemory.surface(c,{today}) on a card.

   PUBLIC API (window.SovennMemory):
     surface(contact, opts)      -> [string]  (max ~4 warm lines for a card)
     lastSpoke(contact, today)   -> { days:number|null, label:string }
     openThreads(contact)        -> [string]  (promises/todos/owes, deduped)
     recap(contact, today)       -> string    (one warm combined sentence)
     _selftest()                 -> { pass, results:[{name,pass,got}] }
   today is an ISO "YYYY-MM-DD" string (opts.today for surface). It is
   optional and only affects time lines (lastSpoke / dates); when absent,
   those lines are simply omitted, never guessed.
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  var CFG = {
    maxLines: 4,        /* surface(): never overwhelm the card */
    maxThreads: 4,      /* openThreads(): cap so a chatty log can't flood */
    maxPhraseLen: 90,   /* a single open-thread phrase clamp */
    scanChars: 4000,    /* per-source text scan cap (huge notes stay cheap) */
    horizonDays: 30     /* birthdays/anniversaries shown within this window */
  };

  /* ---------- tiny safe helpers (no throwing, ever) ---------- */
  function isObj(x){ return !!x && typeof x === 'object'; }
  function arr(x){ return Array.isArray(x) ? x : []; }
  function str(x){ return (x == null) ? '' : String(x); }
  function clip(s, n){ s = str(s); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s; }
  function trimDot(s){ return str(s).replace(/^[\s"'“”‘’\-–—•*]+/, '').replace(/[\s]+$/, ''); }

  /* ---- deterministic date math on ISO "YYYY-MM-DD" (null if unparseable) ---- */
  function isoDays(iso){
    var m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str(iso));
    if(!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if(mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var t = Date.UTC(y, mo - 1, d);
    if(isNaN(t)) return null;
    return Math.floor(t / 86400000);
  }
  function daysBetween(fromIso, toIso){
    var a = isoDays(fromIso), b = isoDays(toIso);
    if(a == null || b == null) return null;
    return b - a;
  }
  /* days until the next yearly occurrence of {m,d} relative to todayIso (0..364) */
  function daysToAnnual(m, d, todayIso){
    var t = isoDays(todayIso);
    if(t == null || !m) return null;
    var tD = new Date(t * 86400000);
    var y = tD.getUTCFullYear();
    function mk(yy){
      var day = d || 1, dt = new Date(Date.UTC(yy, m - 1, day));
      if(dt.getUTCMonth() !== (m - 1)) dt = new Date(Date.UTC(yy, m, 0)); /* clamp e.g. Feb 30 */
      return Math.floor(dt.getTime() / 86400000);
    }
    var occ = mk(y);
    if(occ < t) occ = mk(y + 1);
    return occ - t;
  }

  /* ---- humanise a day-gap into a warm duration phrase ---- */
  function durationPhrase(days){
    if(days == null) return '';
    if(days < 0) days = 0;
    if(days === 0) return 'today';
    if(days === 1) return 'yesterday';
    if(days < 7) return days + ' days ago';
    if(days < 14) return 'about a week ago';
    if(days < 45){ var w = Math.round(days / 7); return 'about ' + w + ' week' + (w === 1 ? '' : 's') + ' ago'; }
    if(days < 365){ var mo = Math.round(days / 30); return 'about ' + mo + ' month' + (mo === 1 ? '' : 's') + ' ago'; }
    var yr = Math.round(days / 365);
    return 'about ' + yr + ' year' + (yr === 1 ? '' : 's') + ' ago';
  }
  function whenPhraseFuture(days){
    if(days == null) return '';
    if(days === 0) return 'today';
    if(days === 1) return 'tomorrow';
    return 'in ' + days + ' days';
  }

  /* ---- last contact: most recent of lastContacted and any dated log entry ---- */
  function latestContactIso(c){
    if(!isObj(c)) return null;
    var best = null, bestD = null;
    function consider(iso){
      var d = isoDays(iso);
      if(d == null) return;
      if(bestD == null || d > bestD){ bestD = d; best = str(iso).slice(0, 10); }
    }
    consider(c.lastContacted);
    arr(c.log).forEach(function(e){ if(isObj(e)) consider(e.date); });
    return best;
  }

  function lastSpoke(c, today){
    var safe = { days: null, label: 'No conversations logged yet.' };
    if(!isObj(c)) return safe;
    var iso = latestContactIso(c);
    if(!iso) return safe;
    var days = daysBetween(iso, today);
    if(days == null) return { days: null, label: 'No conversations logged yet.' };
    if(days < 0) days = 0;
    var ph = durationPhrase(days);
    var label = (days === 0) ? 'You spoke today.'
              : (days === 1) ? 'You spoke yesterday.'
              : 'You last spoke ' + ph + '.';
    return { days: days, label: label };
  }

  /* ---- open-thread extraction (promises / todos / owes) ----
     Scan free text (notes + log notes + msgHistory text) for a small set of
     intent cues, returning the cleaned clause carrying the cue. Conservative
     by design: only a phrase that ACTUALLY contains a cue is surfaced — we
     never invent or infer an action that is not written. \b keeps cues
     word-bounded. */
  var CUES = [
    /\b(?:i|we|you|they|he|she)\s+(?:promised|owe[ds]?)\b/i,
    /\bpromised\b/i,
    /\bowe[ds]?\b/i,
    /\b(?:will|would|gonna|going to|need to|have to|should|must|to)\s+(?:send|share|email|call|text|ping|introduce|intro|connect|forward|get back|loop|follow up|check in|circle back)\b/i,
    /\b(?:send|share|email|forward)\s+(?:them|him|her|over|the|me|you|us|a|an|that|this)\b/i,
    /\bfollow(?:[\s-]?up|\sup)?\b/i,
    /\bget\s+back\s+to\b/i,
    /\bcircle\s+back\b/i,
    /\b(?:introduce|intro|connect)\s+(?:them|him|her|to|with|me|you)\b/i,
    /\bloop\s+(?:them|him|her|in)\b/i,
    /\bwaiting\s+(?:on|for)\b/i,
    /\b(?:to-?do|todo|action item|next step)s?\b[:\-\s]/i
  ];

  function hasCue(s){
    for(var i = 0; i < CUES.length; i++){ if(CUES[i].test(s)) return true; }
    return false;
  }

  /* split a blob into clauses on sentence enders / newlines / bullets, so each
     promise is its own line. No lookbehind (ES5-engine-safe): newline AFTER
     sentence enders, then split on newlines only. */
  function clauses(text){
    var s = str(text).slice(0, CFG.scanChars);
    if(!s) return [];
    s = s.replace(/[\r\n]+/g, '\n').replace(/[•·▪‣–—]\s*/g, '\n');
    s = s.replace(/([.!?;])\s+/g, '$1\n');
    var parts = s.split(/\n+/);
    var out = [];
    for(var i = 0; i < parts.length; i++){
      var p = trimDot(parts[i]);
      if(p) out.push(p);
    }
    return out;
  }

  function normKey(s){ return str(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  function collectThreadText(c){
    var blobs = [];
    /* Sovenn stores notes as an array of {id,date,text,fav}; tolerate a legacy free-text string too */
    if(Array.isArray(c.notes)){ for(var i = 0; i < c.notes.length; i++){ var n = c.notes[i]; if(isObj(n) && n.text != null) blobs.push(str(n.text)); else if(typeof n === 'string') blobs.push(n); } }
    else if(c.notes != null) blobs.push(str(c.notes));
    arr(c.log).forEach(function(e){ if(isObj(e) && e.note != null) blobs.push(str(e.note)); });
    arr(c.msgHistory).forEach(function(m){ if(isObj(m) && m.text != null) blobs.push(str(m.text)); });
    return blobs;
  }

  function openThreads(c){
    if(!isObj(c)) return [];
    var blobs = collectThreadText(c);
    var seen = {}, out = [];
    for(var b = 0; b < blobs.length && out.length < CFG.maxThreads; b++){
      var cs = clauses(blobs[b]);
      for(var i = 0; i < cs.length && out.length < CFG.maxThreads; i++){
        var phrase = cs[i];
        if(phrase.length < 4) continue;          /* "owe" alone isn't actionable */
        if(!hasCue(phrase)) continue;
        var clipped = clip(phrase, CFG.maxPhraseLen);
        var key = normKey(clipped);
        if(!key || seen[key]) continue;          /* dedupe on normalised text */
        seen[key] = 1;
        out.push(clipped);
      }
    }
    return out;
  }

  /* ---- upcoming dates (bday/anniv/custom) within horizon -> warm one-liners ---- */
  function dateLines(c, today){
    var lines = [];
    if(isoDays(today) == null) return lines;     /* no today -> never guess time */
    function add(label, dd){
      if(dd == null || dd > CFG.horizonDays) return;
      lines.push(cap(label) + ' ' + whenPhraseFuture(dd) + '.');
    }
    if(isObj(c.bday) && c.bday.m) add('Birthday', daysToAnnual(c.bday.m, c.bday.d, today));
    if(isObj(c.anniv) && c.anniv.m) add('Anniversary', daysToAnnual(c.anniv.m, c.anniv.d, today));
    arr(c.customDates).forEach(function(cd){
      if(isObj(cd) && cd.m){ var lbl = trimDot(cd.label) || 'A date'; add(lbl, daysToAnnual(cd.m, cd.d, today)); }
    });
    return lines;
  }
  function cap(s){ s = str(s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* turn an open-thread phrase into a gentle reminder sentence */
  function threadLine(phrase){
    var p = trimDot(phrase);
    if(!p) return '';
    /* if it already reads like a full reminder, keep it; else frame it softly */
    if(/^you\b/i.test(p) || /\bpromised\b|\bowe/i.test(p)) return ensureDot(cap(p));
    return ensureDot('Open thread: ' + p);
  }
  function ensureDot(s){ s = str(s).replace(/\s+$/, ''); return /[.!?…]$/.test(s) ? s : s + '.'; }

  /* ---- surface(): the few warm lines shown on a card, in priority order:
     (1) time since last contact, (2) upcoming dates, (3) open threads ---- */
  function surface(c, opts){
    if(!isObj(c)) return [];
    opts = isObj(opts) ? opts : {};
    var today = opts.today, lines = [];
    var ls = lastSpoke(c, today);
    if(ls.days != null) lines.push(ls.label);                 /* only with a date + today */
    dateLines(c, today).forEach(function(l){ if(lines.length < CFG.maxLines) lines.push(l); });
    var threads = openThreads(c);
    for(var i = 0; i < threads.length && lines.length < CFG.maxLines; i++){
      var tl = threadLine(threads[i]);
      if(tl) lines.push(tl);
    }
    return lines.slice(0, CFG.maxLines);
  }

  /* ---- recap(): ONE warm sentence combining the strongest signals ---- */
  function recap(c, today){
    if(!isObj(c)) return '';
    var name = firstNameOf(c), bits = [];
    var ls = lastSpoke(c, today);
    if(ls.days != null){
      bits.push(ls.days === 0 ? 'you spoke today'
            : ls.days === 1 ? 'you spoke yesterday'
            : 'you last spoke ' + durationPhrase(ls.days));
    }
    var dls = dateLines(c, today);                            /* strongest upcoming date */
    if(dls.length) bits.push(lower(dls[0].replace(/\.$/, '')));
    var threads = openThreads(c);                             /* one open thread, depunctuated */
    if(threads.length) bits.push(softLower(trimDot(threads[0]).replace(/[.!?…]+$/, '')));
    if(!bits.length) return '';
    var lead = name ? name + ': ' : '';
    return cap(stripLead(lead + joinHuman(bits))) + '.';
  }

  function firstNameOf(c){
    var n = trimDot(c && c.callName) || trimDot(c && c.name);
    return n ? n.split(/\s+/)[0] : '';
  }
  function lower(s){ s = str(s); return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  /* lowercase for mid-sentence joining, but keep a leading standalone "I" */
  function softLower(s){ s = str(s); return /^I\b/.test(s) ? s : lower(s); }
  function stripLead(s){ return str(s).replace(/^\s*—\s*/, ''); }
  function joinHuman(parts){
    parts = arr(parts).filter(function(p){ return !!p; });
    if(parts.length <= 1) return parts.join('');
    if(parts.length === 2) return parts[0] + ', and ' + parts[1];
    return parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1];
  }

  /* ---- self-test: pure logic, NO app/DOM/network/model, deterministic ---- */
  function _selftest(){
    var R = [];
    function t(name, pass, got){ R.push({ name: name, pass: !!pass, got: got }); }

    /* synthetic contact: promises in notes + log + history, plus a date */
    var demo = {
      name: 'Marco Reis', callName: 'Marco', tier: 1,
      notes: 'Met at the Lisbon summit, runs ops at a fintech.\nI said I would send the book on pricing.',
      bday: { m: 7, d: 4 },
      lastContacted: '2026-02-20',
      log: [
        { date: '2026-02-20', type: 'call', note: 'Caught up. Promised to introduce him to Sara.' },
        { date: '2026-01-05', type: 'note', note: 'Nothing pending here, just a nice chat.' }
      ],
      msgHistory: [
        { text: 'Will send you that deck this week!', at: 1700000000000 },
        { text: 'happy new year my friend', at: 1690000000000 }
      ]
    };

    /* lastSpoke labelling, deterministic vs a fixed today (Feb 20 -> Jun 25) */
    var ls = lastSpoke(demo, '2026-06-25');
    t('lastSpoke-days', ls.days === 125, ls.days);
    t('lastSpoke-label-months', /month/.test(ls.label), ls.label);
    t('lastSpoke-prefers-recent', latestContactIso(demo) === '2026-02-20', latestContactIso(demo));

    /* open-thread extraction across notes + log + msgHistory; skips chit-chat */
    var th = openThreads(demo), blob = th.join(' || ').toLowerCase();
    t('thread-send-book', blob.indexOf('send the book') >= 0, th);
    t('thread-introduce', blob.indexOf('introduce') >= 0, th);
    t('thread-will-send-deck', blob.indexOf('deck') >= 0, th);
    t('thread-skips-noise', blob.indexOf('nice chat') < 0 && blob.indexOf('new year') < 0, th);
    t('thread-capped', th.length <= CFG.maxThreads, th.length);
    t('thread-dedupe', openThreads({ notes: 'I will send them the file. I will send them the file.' }).length === 1, null);

    /* surface(): a few warm lines = time line + upcoming date + threads */
    var sf = surface(demo, { today: '2026-06-25' });
    t('surface-array', Array.isArray(sf), typeof sf);
    t('surface-capped', sf.length <= CFG.maxLines, sf.length);
    t('surface-has-lastspoke', sf.length > 0 && /last spoke/.test(sf[0]), sf[0]);
    t('surface-birthday', sf.some(function(l){ return /Birthday/.test(l); }), sf);

    /* date horizon: July 4 from June 25 = "in 9 days"; far-off date is hidden */
    var bsf = surface({ bday: { m: 7, d: 4 } }, { today: '2026-06-25' });
    t('birthday-9-days', bsf.length === 1 && /in 9 days/.test(bsf[0]), bsf);
    t('birthday-far-hidden', surface({ bday: { m: 12, d: 25 } }, { today: '2026-06-25' }).length === 0, null);

    /* recap: one warm sentence naming the person, ending in a period */
    var rc = recap(demo, '2026-06-25');
    t('recap-string', typeof rc === 'string' && rc.length > 0, rc);
    t('recap-has-name', rc.indexOf('Marco') >= 0, rc);
    t('recap-ends-dot', /\.$/.test(rc), rc);

    /* safety / edge cases: never throw, always safe defaults */
    t('empty-surface', JSON.stringify(surface({}, {})) === '[]', surface({}, {}));
    t('null-surface', JSON.stringify(surface(null)) === '[]', surface(null));
    t('null-threads', JSON.stringify(openThreads(null)) === '[]', openThreads(null));
    t('null-lastspoke', lastSpoke(null).days === null, lastSpoke(null));
    t('no-today-no-timeline', surface({ lastContacted: '2026-01-01', notes: '' }, {}).length === 0, null);
    t('empty-recap', recap({}, '2026-06-25') === '', recap({}, '2026-06-25'));
    t('bad-date-safe', lastSpoke({ lastContacted: 'not a date' }, '2026-06-25').days === null, null);

    /* hostile shapes (wrong types, nulls) must not crash */
    var crashed = false;
    try {
      surface({ notes: { weird: true }, log: 'nope', msgHistory: 42, bday: 'x' }, { today: 'bad' });
      openThreads({ log: [null, 5, { note: null }], msgHistory: [undefined] });
      lastSpoke({ log: [{ date: 12345 }] }, null);
      recap({ name: 12345 }, 'bad');
    } catch(e){ crashed = true; }
    t('hostile-input-no-throw', !crashed, crashed);

    /* huge note stays cheap (scanChars cap) and still returns an array */
    t('huge-input-bounded', Array.isArray(openThreads({ notes: 'I will send them the file. ' + new Array(5000).join('x ') })), null);

    var pass = R.every(function(x){ return x.pass; });
    return { pass: pass, results: R };
  }

  G.SovennMemory = {
    surface: surface,
    lastSpoke: lastSpoke,
    openThreads: openThreads,
    recap: recap,
    _selftest: _selftest,
    _cfg: CFG
  };
})();
