/* =====================================================================
   ai.js  —  Sovenn on-device AI  (the "draft in your voice" moat layer)
   ---------------------------------------------------------------------
   WHAT: an OPTIONAL, fully on-device drafting helper. It writes a short,
   warm message the user reviews and sends themselves. It layers ON TOP of
   the existing rule-based rotation (freshDraft/pickOpener): if the device
   has no on-device model, every call returns null and the app keeps using
   the rotation. Nothing here ever degrades the current experience.

   WHY ON-DEVICE: it runs on the browser's built-in model (Chrome Prompt
   API / Gemini Nano). No servers, no Claude, no network, nothing leaves
   the phone. That privacy property is the moat: cloud-first rivals cannot
   match it without breaking their own model. This is intentionally NOT the
   Anthropic API.

   STATUS: standalone. NOT yet referenced by index.html or app.js. Develop
   and test in isolation; integrate when ready (see INTEGRATION below).

   INTEGRATION (later, ~3 small edits, all additive):
     1) index.html: add <script src="ai.js"></script> BEFORE app.js, and
        add 'ai.js' to the sw.js SHELL list (bump the cache).
     2) app.js freshMsg(id): try the model first, fall back to rotation:
          const ai = await SovennAI.draft({
            name:c.name, callName:callName(c), occasion:'reconnect',
            context:c.context, lastContacted:c.lastContacted,
            locale:(DB.settings.country||navigator.language),
            voiceSamples:(c.msgHistory||[]).map(m=>m.text),
            avoid:(c.msgHistory||[]).slice(-4).map(m=>m.text)
          });
          if(ai && $('#msg')) $('#msg').value = ai;        // else keep freshDraft()
     3) Settings: an "Enable on-device AI" toggle that calls
        SovennAI.warmUp(onProgress) to trigger the one-time model download,
        and shows SovennAI.status() so the user knows it is ready.

   PUBLIC API (window.SovennAI):
     isSupported()                 -> boolean (the API surface exists)
     status()                      -> 'ready'|'downloadable'|'downloading'|'unavailable'
     warmUp(onProgress)            -> 'ready'|'unavailable'  (triggers download)
     draft(opts)                   -> string | null          (the main entry)
     rewrite({text,instruction})   -> string | null          (tweak an existing draft)
     _setBackend(fn) / _selftest() -> testing hooks (no model needed)

   draft(opts): { name, callName, occasion:'birthday'|'anniversary'|
     'reconnect'|'custom', occasionText, context, lastContacted, locale,
     voiceSamples:[past messages by the user], avoid:[recent messages to
     not repeat], maxLen, onProgress }
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  var CFG = { maxLen: 320, timeoutMs: 12000, temperature: 0.8, topK: 6 };

  /* ---- capability detection (never throws if the API is absent) ---- */
  function stdAPI(){ try{ return G.LanguageModel || (typeof LanguageModel!=='undefined'?LanguageModel:null) || null; }catch(e){ return null; } }
  function otAPI(){ try{ return (G.ai && G.ai.languageModel) ? G.ai.languageModel : null; }catch(e){ return null; } }

  var _session = null;   /* cached live model session */
  var _backend = null;   /* test override: a fn(prompt)->string */

  function isSupported(){ return !!_backend || !!stdAPI() || !!otAPI(); }

  function status(){
    if(_backend) return Promise.resolve('ready');
    var std = stdAPI();
    if(std && std.availability){
      return Promise.resolve().then(function(){ return std.availability(); }).then(function(a){
        return a==='available' ? 'ready' : a==='downloadable' ? 'downloadable' : a==='downloading' ? 'downloading' : 'unavailable';
      }).catch(function(){ return 'unavailable'; });
    }
    var ot = otAPI();
    if(ot && ot.capabilities){
      return Promise.resolve().then(function(){ return ot.capabilities(); }).then(function(c){
        var a = c && c.available;
        return a==='readily' ? 'ready' : a==='after-download' ? 'downloadable' : 'unavailable';
      }).catch(function(){ return 'unavailable'; });
    }
    return Promise.resolve('unavailable');
  }

  /* ---- session lifecycle ---- */
  function getSession(onProgress){
    if(_backend) return Promise.resolve({ prompt: function(t){ return Promise.resolve(_backend(t)); }, destroy: function(){} });
    if(_session) return Promise.resolve(_session);
    var sys = systemPrompt();
    var std = stdAPI();
    if(std && std.create){
      return std.create({
        temperature: CFG.temperature,
        topK: CFG.topK,
        initialPrompts: [{ role: 'system', content: sys }],
        monitor: function(m){ if(m && m.addEventListener) m.addEventListener('downloadprogress', function(e){ if(onProgress) onProgress(e.loaded, e.total); }); }
      }).then(function(s){ _session = s; return s; });
    }
    var ot = otAPI();
    if(ot && ot.create){
      return ot.create({ temperature: CFG.temperature, topK: CFG.topK, systemPrompt: sys }).then(function(s){ _session = s; return s; });
    }
    return Promise.reject(new Error('on-device model unavailable'));
  }

  /* ---- prompts ---- */
  function systemPrompt(){
    return [
      'You help someone keep their personal relationships warm by drafting ONE short message they will review and send themselves from their own phone.',
      'Voice: a real person texting a friend they genuinely care about. Warm, specific, human.',
      'Hard rules:',
      '- One to three short sentences. No more.',
      '- No emojis, no hashtags, no markdown.',
      '- No greeting line and no sign-off name. Just the message body.',
      '- Never invent facts about the person; use only what is given.',
      '- Not salesy, not corporate, no generic filler, no "just checking in" cliches.',
      '- Use their calling name at most once.',
      'Output ONLY the message text, with no surrounding quotes and no preamble.'
    ].join('\n');
  }

  function regionHint(loc){
    loc = (loc==null ? '' : String(loc)).toUpperCase();
    if(/\bIN\b|HIN|HINGLISH|INDIA/.test(loc)) return 'A subtle, natural Hinglish touch is welcome if it fits, but keep it mostly English and never forced.';
    if(/\bDE\b|GERMAN|DEUTSCH/.test(loc)) return 'A single warm German word is welcome if it feels natural, otherwise English.';
    if(/\bNL\b|DUTCH|NEDERLAND/.test(loc)) return 'A single warm Dutch word is welcome if it feels natural, otherwise English.';
    return '';
  }

  function clip(s, n){ s = String(s==null?'':s); return s.length > n ? s.slice(0, n) + '…' : s; }

  function buildPrompt(o){
    var name = o.callName || o.name || 'them';
    var occ = o.occasion || 'reconnect';
    var occLine = ({
      birthday: 'It is ' + name + "'s birthday today.",
      anniversary: 'It is ' + name + "'s anniversary.",
      reconnect: 'You have not spoken with ' + name + ' in a while and want to reconnect warmly, with no agenda.',
      custom: o.occasionText || ('You want to send ' + name + ' a warm note.')
    })[occ] || ('You want to send ' + name + ' a warm note.');

    var lines = [];
    lines.push('Write a short message I will send to ' + name + '.');
    lines.push(occLine);
    if(o.context) lines.push('What I know about them: ' + clip(o.context, 240));
    if(o.lastContacted) lines.push('We last connected on ' + o.lastContacted + '.');
    var hint = regionHint(o.locale != null ? o.locale : o.region);
    if(hint) lines.push(hint);
    if(o.voiceSamples && o.voiceSamples.length){
      lines.push('Here are messages I have sent before. Match this voice and warmth, do not copy them:');
      o.voiceSamples.slice(-4).forEach(function(s){ if(s) lines.push('- ' + clip(s, 160)); });
    }
    if(o.avoid && o.avoid.length){
      lines.push('Do NOT repeat or closely echo these recent messages:');
      o.avoid.slice(-4).forEach(function(s){ if(s) lines.push('- ' + clip(s, 160)); });
    }
    lines.push('Output only the message text.');
    return lines.join('\n');
  }

  /* ---- output hygiene: enforce the brand rules regardless of model output ---- */
  function sanitize(raw, maxLen){
    var s = String(raw==null ? '' : raw).trim();
    /* drop a chatty preamble like "Sure! Here's a message:" */
    s = s.replace(/^\s*(sure[,!.\s]*)?(here(?:'s| is)[^:\n]*:\s*)/i, '');
    s = s.replace(/^\s*(message|draft|response|reply)\s*:\s*/i, '');
    /* strip wrapping quotes (straight or curly) */
    s = s.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();
    /* remove emojis / pictographs / ZWJ / variation selectors (brand: no emojis) */
    try { s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, ''); } catch(e){}
    /* collapse whitespace and newlines into a single clean line/space run */
    s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    /* tidy spaces left before punctuation after emoji removal (e.g. "Aisha !" -> "Aisha!") */
    s = s.replace(/\s+([,.!?;:])/g, '$1').trim();
    /* clamp length, preferring a sentence boundary */
    maxLen = maxLen || CFG.maxLen;
    if(s.length > maxLen){
      var cut = s.slice(0, maxLen);
      var stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      s = (stop > maxLen * 0.5 ? cut.slice(0, stop + 1) : cut).trim();
    }
    return s;
  }

  function withTimeout(p, ms){
    return new Promise(function(res, rej){
      var t = setTimeout(function(){ rej(new Error('timeout')); }, ms);
      Promise.resolve(p).then(function(v){ clearTimeout(t); res(v); }, function(e){ clearTimeout(t); rej(e); });
    });
  }

  /* ---- public: draft ---- */
  function draft(o){
    o = o || {};
    return status().then(function(st){
      if(!_backend && st !== 'ready') return null;   /* not ready -> caller falls back to rotation instantly */
      return getSession(o.onProgress).then(function(session){
        return withTimeout(session.prompt(buildPrompt(o)), CFG.timeoutMs);
      }).then(function(raw){
        var out = sanitize(raw, o.maxLen || CFG.maxLen);
        return out || null;
      });
    }).catch(function(e){
      try { if(G.console) G.console.warn('SovennAI.draft fell back:', e && e.message); } catch(_){}
      return null;
    });
  }

  /* ---- public: rewrite an existing draft ("warmer", "shorter", "more casual") ---- */
  function rewrite(o){
    o = o || {};
    return status().then(function(st){
      if(!_backend && st !== 'ready') return null;
      return getSession().then(function(session){
        var prompt = 'Rewrite this message to be ' + (o.instruction || 'warmer and more natural') +
          '. Keep it short, no emojis, no quotes, output only the message:\n\n' + (o.text || '');
        return withTimeout(session.prompt(prompt), CFG.timeoutMs);
      }).then(function(raw){ return sanitize(raw, o.maxLen || CFG.maxLen) || null; });
    }).catch(function(){ return null; });
  }

  /* ---- public: warm up (trigger the one-time model download) ---- */
  function warmUp(onProgress){
    return status().then(function(st){
      if(st === 'unavailable') return 'unavailable';
      return getSession(onProgress).then(function(){ return 'ready'; });
    }).catch(function(){ return 'unavailable'; });
  }

  /* ---- self-test: pure logic, runs with NO model (for parallel dev + CI) ---- */
  function _selftest(){
    var R = [];
    function eq(name, got, want){ R.push({ name: name, pass: got === want, got: got, want: want }); }
    function inc(name, got, sub){ R.push({ name: name, pass: String(got).indexOf(sub) >= 0, got: clip(got, 60) }); }

    eq('dequote', sanitize('"Hey there"'), 'Hey there');
    eq('preamble', sanitize("Sure! Here's a message: Long time no talk."), 'Long time no talk.');
    eq('label-strip', sanitize('Message: see you soon'), 'see you soon');
    eq('emoji-strip', sanitize('Happy birthday 🎉🎂 friend'), 'Happy birthday friend');
    eq('newline-collapse', sanitize('line one\n\nline two'), 'line one line two');
    var cl = sanitize('Sentence one. ' + 'word '.repeat(200), 80);
    R.push({ name: 'clamp', pass: cl.length <= 80 && cl.length > 0, got: cl.length });

    var p = buildPrompt({ callName: 'Aisha', occasion: 'birthday', context: 'met at ESCP Paris', voiceSamples: ['yo long time!'], locale: 'IN' });
    inc('prompt-name', p, 'Aisha');
    inc('prompt-occasion', p, 'birthday');
    inc('prompt-context', p, 'ESCP');
    inc('prompt-voice', p, 'long time');
    inc('prompt-region', p, 'Hinglish');

    R.push({ name: 'isSupported-boolean', pass: typeof isSupported() === 'boolean', got: typeof isSupported() });

    var pass = R.every(function(x){ return x.pass; });
    return { pass: pass, results: R };
  }

  G.SovennAI = {
    isSupported: isSupported,
    status: status,
    warmUp: warmUp,
    draft: draft,
    rewrite: rewrite,
    _setBackend: function(fn){ _backend = fn; _session = null; },
    _selftest: _selftest,
    _cfg: CFG
  };
})();
