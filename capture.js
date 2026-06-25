/* =====================================================================
   capture.js  —  Sovenn Frictionless Capture v2  (window.SovennCapture)
   ---------------------------------------------------------------------
   WHAT: an on-device free-text parser. Paste anything — a LinkedIn line, an
   email signature, "Met Aisha, ESCP Paris, +33..." — and it returns the
   facts as plain DATA (no DOM, no network) for the app to confirm. The SPINE
   of Step 1 capture: the facts in under ten seconds with one confirm, so
   upkeep never death-spirals.

   WHY: REPLACES app.js quickParse() later. That parser misses company AND
   jobTitle (breaking "pulls out every detail") and has false positives
   ("Jerome"->"rome"; "resume.pdf"->website). This fixes both, fully testable.

   PERSONAS / the moment it helps:
     - The founder pasting a one-line LinkedIn intro between meetings.
     - Tom (recent grad) scanning an email signature after a coffee chat.
     - The networker dumping a stack of details right after an event.

   PRIVACY / SECURITY: ZERO network (no fetch/XHR/WS/import/beacon), no eval/
   Function, no DOM, no storage. Data only; the app renders it. Never throws —
   bad/empty/huge input returns safe defaults.

   INTEGRATION (later, additive; does NOT depend on app.js, no load side
   effects beyond window.SovennCapture): add <script src="capture.js"> BEFORE
   app.js + add 'capture.js' to sw.js SHELL (bump cache); then point
   quickParse callers at SovennCapture.parse(text) — a superset of the old
   result (adds company, jobTitle, callName, website).

   API: parse(text) -> { name, callName, email, phone, company, jobTitle,
     location, linkedin, instagram, x, telegram, website, bday, context }
     (missing = '' ; bday '' when absent).  _selftest() -> {pass, results}.
   ===================================================================== */
(function(){
  'use strict';
  var G = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);

  var MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

  /* compact hub list, word-boundary matched so "rome" != "Jerome". Lean for
     footprint; the app's full GEO can be swapped in at integration. */
  var PLACES = ('london manchester paris berlin munich madrid barcelona rome milan amsterdam '
    + 'lisbon zurich geneva vienna dublin stockholm copenhagen boston seattle austin chicago '
    + 'miami toronto vancouver dubai istanbul mumbai delhi bangalore bengaluru hyderabad chennai '
    + 'pune kolkata gurgaon singapore tokyo seoul shanghai bangkok sydney melbourne cairo lagos '
    + 'nairobi england ireland france germany spain italy portugal switzerland india china japan '
    + 'australia canada brazil mexico').split(' ');
  var MULTI = ('new york|san francisco|los angeles|new delhi|abu dhabi|hong kong|cape town|'
    + 'sao paulo|mexico city|united kingdom|united states|saudi arabia|south korea|south africa').split('|');

  var LEADIN = /^(met|meet|spoke to|spoke with|talked to|talked with|chatted with|chatted to|call with|this is|name is|introducing|intro to|intro with|saw|with|re|fyi|contact)\s+/i;
  var ROLE = /(engineer|developer|designer|manager|director|founder|ceo|cto|coo|cfo|cmo|vp|head of|lead|analyst|consultant|architect|scientist|researcher|recruiter|advisor|partner|associate|intern|product manager|pm|marketer|accountant|lawyer|attorney|teacher|professor|doctor|nurse|student|specialist|coordinator|officer|executive|strategist|writer|editor|producer|owner|principal)/i;
  var FILE_EXT = /^(pdf|docx?|pptx?|xlsx?|csv|txt|png|jpe?g|gif|svg|webp|heic|zip|rar|gz|mp[34]|mov|avi|wav|md|rtf|pages|key|numbers|json|xml|html?|js|css)$/i;
  var TLD = /^(com|org|net|io|co|app|dev|me|ai|in|de|nl|uk|us|edu|gov|info|biz|xyz|so|gg|tech|store|online|site|page|link|sh|fm|tv|cc|live|design|studio|to|ly|eu|ca|au|fr|es|it|jp|cn|br)$/i;

  /* ---- safe primitives (never throw) ---- */
  function S(v){ return v == null ? '' : String(v); }
  function rxEsc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clean(s){ return S(s).replace(/[ \t]+/g, ' ').trim(); }
  function firstWord(name){ var p = clean(name).split(/\s+/); return p[0] || ''; }
  /* ---- email / socials: strip domain even without a protocol ---- */
  function findEmail(t){ var m = t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/); return m ? m[0] : ''; }
  function findSocial(t, host){
    var m = t.match(new RegExp('(?:https?:\\/\\/)?(?:www\\.)?' + rxEsc(host) + '\\/(@?[A-Za-z0-9_.\\-]+)', 'i'));
    return m ? m[1].replace(/^@/, '').replace(/[\/.\-]+$/, '') : '';
  }
  function findLinkedin(t){ var m = t.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s,;]+/i); return m ? m[0] : ''; }
  /* ---- birthday: {str, val}; val is YYYY-MM-DD, --MM-DD, or '' ----
     Handles ISO (1992-03-14), numeric (14/3/92, day-first default), and
     word forms (14 March 1992 / Mar 14). Returns plain data, never throws. */
  function pad(n){ n = String(n); return n.length < 2 ? '0' + n : n; }
  function normBday(s){
    s = clean(s); if(!s) return '';
    var m = s.match(/^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$/);
    if(m){ var Y = +m[1], M = +m[2], D = +m[3]; return (M>=1&&M<=12&&D>=1&&D<=31) ? Y+'-'+pad(M)+'-'+pad(D) : ''; }
    m = s.match(/^([0-9]{1,2})[\/.\-]([0-9]{1,2})(?:[\/.\-]([0-9]{2,4}))?$/);
    if(m){ var a = +m[1], b = +m[2], y = m[3] ? +m[3] : null, d, mo;
      if(a > 12){ d = a; mo = b; } else if(b > 12){ mo = a; d = b; } else { d = a; mo = b; } /* day-first */
      if(y && y < 100) y = (y > 40 ? 1900 : 2000) + y;
      return (mo>=1&&mo<=12&&d>=1&&d<=31) ? (y?y+'-':'--')+pad(mo)+'-'+pad(d) : '';
    }
    m = s.match(/^([0-9]{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:,?\s+([0-9]{4}))?$/);
    if(m && MON[m[2].slice(0,3).toLowerCase()]) return (m[3]?m[3]+'-':'--')+pad(MON[m[2].slice(0,3).toLowerCase()])+'-'+pad(+m[1]);
    m = s.match(/^([A-Za-z]{3,9})\s+([0-9]{1,2})(?:st|nd|rd|th)?(?:,?\s+([0-9]{4}))?$/);
    if(m && MON[m[1].slice(0,3).toLowerCase()]) return (m[3]?m[3]+'-':'--')+pad(MON[m[1].slice(0,3).toLowerCase()])+'-'+pad(+m[2]);
    return '';
  }
  var DATE = '([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[\\/.\\-][0-9]{1,2}(?:[\\/.\\-][0-9]{2,4})?|[0-9]{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}(?:,?\\s+[0-9]{4})?|[A-Za-z]{3,9}\\s+[0-9]{1,2}(?:st|nd|rd|th)?(?:,?\\s+[0-9]{4})?)';
  function findBirthday(t){
    var m = t.match(new RegExp('(?:birthday|bday|b-day|dob|d\\.o\\.b|born)[:\\s]*' + DATE, 'i'));
    if(m){ var v = normBday(m[1]); if(v) return { str: m[0], val: v }; }
    m = t.match(/\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/);
    if(m){ var v2 = normBday(m[0]); if(v2) return { str: m[0], val: v2 }; }
    return { str: '', val: '' };
  }

  /* ---- phone: reject junk like "n/a"; need a real run of digits ---- */
  function findPhone(t){
    var m = t.match(/\+?\d[\d ()\-.]{6,}\d/);
    if(!m) return '';
    var digits = m[0].replace(/\D/g, '');
    if(digits.length < 7 || digits.length > 15) return '';   /* E.164 sane range */
    return m[0].replace(/[ .]+$/, '').trim();
  }

  var SOCIAL_HOST = /(?:linkedin|instagram|x|twitter|facebook|github|t)\.(?:com|me)/i;
  /* ---- website: need a real TLD or explicit protocol; reject files & socials.
     email is removed first so an email domain never becomes a website. ---- */
  function findWebsite(t, email){
    var src = email ? t.split(email).join(' ') : t;
    src = src.replace(/(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|instagram\.com|(?:x|twitter)\.com|facebook\.com|github\.com|t\.me)\/[^\s,;]*/ig, ' ');
    var re = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9\-]*(?:\.[a-z0-9\-]+)*\.[a-z]{2,}(?:\/[^\s,;]*)?/ig;
    var m;
    while((m = re.exec(src))){
      var w = m[0], hasProto = /^https?:\/\//i.test(w);
      var host = w.replace(/^https?:\/\//i, '').replace(/[\/?#].*$/, '');
      if(SOCIAL_HOST.test(host)) continue;
      var tld = (host.match(/\.([a-z]{2,})$/i) || [])[1] || '';
      if(FILE_EXT.test(tld)) continue;                /* resume.pdf, slides.pptx */
      if(!hasProto && !TLD.test(tld)) continue;       /* St.Pancras, re.invent */
      return w;
    }
    return '';
  }

  /* ---- location: word-boundary so "rome" != "Jerome" ---- */
  function findLocation(low){
    var i, rx;
    for(i = 0; i < MULTI.length; i++){
      if(low.indexOf(MULTI[i]) >= 0){
        rx = new RegExp('\\b' + rxEsc(MULTI[i]) + '\\b');
        if(rx.test(low)) return MULTI[i];
      }
    }
    for(i = 0; i < PLACES.length; i++){
      if(new RegExp('\\b' + PLACES[i] + '\\b').test(low)) return PLACES[i];
    }
    return '';
  }

  /* ---- company + jobTitle, in priority order per line:
       (1) "<title> at|@ <company>"   (2) "..,<role>,<company>,.."   (3) a bare role line.
     The first strong match (1 or 2, with a company) wins; (3) only fills the title. */
  function findRole(t, email){
    var lines = t.split(/\n/), fallbackTitle = '', i, ln, m;
    for(i = 0; i < lines.length; i++){
      ln = clean(lines[i]);
      if(!ln || (email && ln.replace(/\s/g, '') === email)) continue;
      var social = /@|https?:|linkedin|instagram|t\.me|\d{4,}/i.test(ln);
      /* (1) title at|@ company */
      m = ln.match(/^(.*?)\s+(?:at|@)\s+([A-Z0-9][A-Za-z0-9&.\-' ]{1,40})$/);
      if(m && !/\.[a-z]{2,}$/i.test(m[2]) && !/@/.test(m[1])){
        var title = clean(m[1]).replace(LEADIN, '');
        if(title && title.length <= 48 && (ROLE.test(title) || title.split(/\s+/).length <= 5))
          return { jobTitle: title, company: clean(m[2]) };
      }
      if(social) continue;
      /* (2) comma list: a role segment immediately followed by a company segment */
      var seg = ln.split(/\s*,\s*/), s;
      for(s = 0; s < seg.length - 1; s++){
        var role = clean(seg[s]), co = clean(seg[s + 1]);
        if(role && ROLE.test(role) && role.length <= 40 && /^[A-Z0-9]/.test(co) &&
           co.length <= 40 && !ROLE.test(co) && !findLocation(co.toLowerCase()) && !/\.[a-z]{2,}$/i.test(co))
          return { jobTitle: role, company: co };
      }
      /* (3) a bare standalone role line ("Senior PM" under the name) */
      if(!fallbackTitle && ln.indexOf(',') < 0 && ROLE.test(ln) && ln.split(/\s+/).length <= 6 && ln.length <= 40)
        fallbackTitle = ln.replace(LEADIN, '');
    }
    return { jobTitle: fallbackTitle, company: '' };
  }

  /* lowercase noise words that are never a name token (run breakers) */
  var STOP = (' the a an and or of in on at to from with for met meetup event conference '
    + 'party dinner lunch coffee call chat intro is was are were he she they i you we my his her '
    + 'their our who works work working live lives based located near via about re fyi ').toLowerCase();
  function isStop(w){ return STOP.indexOf(' ' + w.toLowerCase() + ' ') >= 0; }
  function nameWord(w){ return /^[A-Za-z][A-Za-z.'\-]*$/.test(w) && !isStop(w); }
  function isLeadinWord(w){ return LEADIN.test(w + ' '); }
  function looksName(s, taken){
    s = clean(s).replace(LEADIN, '').trim();
    if(!s) return '';
    if(taken && taken.indexOf(s.toLowerCase()) >= 0) return '';   /* it is company/title/place */
    if(!/^[A-Za-z][A-Za-z .'\-]{1,40}$/.test(s)) return '';
    if(ROLE.test(s)) return '';
    var w = s.split(/\s+/);
    if(w.length > 4) return '';                                   /* a sentence, not a name */
    for(var j = 0; j < w.length; j++){ if(!nameWord(w[j])) return ''; }
    return s;
  }
  /* ---- name: first clean person-like fragment, lead-in verb stripped.
     2nd pass only accepts a run that is Capitalized OR follows a lead-in verb,
     so "met aisha" works but "follow him"/"check stripe" do not. ---- */
  function findName(t, taken, place){
    var i, n;
    if(place){ t = t.replace(new RegExp('\\b' + rxEsc(place) + '\\b', 'ig'), ' '); }
    var pieces = t.split(/[\n,]/);
    for(i = 0; i < pieces.length; i++){
      var ln = clean(pieces[i]);
      if(!ln || /@|linkedin|instagram|https?:|t\.me|\d{3,}|\bat\b/i.test(ln)) continue;
      n = looksName(ln, taken);
      if(n) return n;
    }
    /* drop emails/urls/handles so their local-parts don't masquerade as names */
    var flat = t.replace(/[\n,]/g, ' ')
               .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
               .replace(/(?:https?:\/\/)?(?:www\.)?[a-z0-9.\-]+\.[a-z]{2,}(?:\/[^\s]*)?/ig, ' ')
               .replace(/@[A-Za-z0-9_.]+/g, ' ');
    var tokens = clean(flat).split(/\s+/);
    var run = [], endorsed = false, prevLeadin = false;
    for(i = 0; i <= tokens.length; i++){
      var tk = tokens[i] || '';
      if(tk && nameWord(tk) && !isLeadinWord(tk) && run.length < 4){
        if(!run.length && (/^[A-Z]/.test(tk) || prevLeadin)) endorsed = true;
        run.push(tk);
      } else {
        if(run.length && endorsed){
          n = looksName(run.join(' '), taken);
          if(n) return n;
        }
        run = []; endorsed = false;
      }
      prevLeadin = isLeadinWord(tk);
    }
    return '';
  }

  /* ---- main entry: returns plain data; context stays '' so we never inject
     noisy guesses into a confirmable field. Never throws. ---- */
  function parse(text){
    var out = { name: '', callName: '', email: '', phone: '', company: '', jobTitle: '',
      location: '', linkedin: '', instagram: '', x: '', telegram: '', website: '', bday: '', context: '' };
    try {
      var t = S(text);
      if(!t.trim()) return out;
      if(t.length > 20000) t = t.slice(0, 20000);   /* cap pathological input */
      out.email = findEmail(t);
      out.linkedin = findLinkedin(t);
      out.instagram = findSocial(t, 'instagram.com');
      out.x = findSocial(t, 'x.com') || findSocial(t, 'twitter.com');
      out.telegram = findSocial(t, 't.me');
      if(!out.instagram){ var bare = t.match(/(?:^|\s)@([A-Za-z0-9_.]{2,30})\b/); if(bare && !out.email) out.instagram = bare[1]; } /* bare @handle -> IG */
      var bj = findBirthday(t);
      out.bday = bj.val;
      out.phone = findPhone(bj.str ? t.replace(bj.str, ' ') : t);   /* don't read a date as a phone */
      out.website = findWebsite(t, out.email);
      out.location = findLocation(t.toLowerCase());
      var role = findRole(t, out.email);
      out.jobTitle = role.jobTitle; out.company = role.company;
      var taken = [];
      if(out.company) taken.push(out.company.toLowerCase());
      if(out.jobTitle) taken.push(out.jobTitle.toLowerCase());
      if(out.location) taken.push(out.location.toLowerCase());
      out.name = findName(t, taken, out.location);
      out.callName = out.name ? firstWord(out.name) : '';
    } catch(e){ /* CODE INTEGRITY: never throw; return what we have */ }
    return out;
  }

  /* ---- self-test: pure logic, NO app/DOM/network/model ---- */
  function _selftest(){
    var R = [], a;
    function eq(n, g, w){ R.push({ name: n, pass: g === w, got: g }); }
    function rx(n, g, re){ R.push({ name: n, pass: re.test(g), got: g }); }

    a = parse('Met Aisha, ESCP Paris, +33 6 12 34 56 78');
    eq('leadin-name', a.name, 'Aisha'); rx('leadin-phone', a.phone, /^\+?33/); eq('leadin-place', a.location, 'paris');

    a = parse('Aisha Khan\nSenior PM at Stripe\naisha@stripe.com');
    rx('role-title', a.jobTitle, /pm/i); eq('role-company', a.company, 'Stripe');
    eq('role-email', a.email, 'aisha@stripe.com'); eq('role-name', a.name, 'Aisha Khan'); eq('role-callname', a.callName, 'Aisha');

    a = parse('Jerome Smith jerome@acme.com');
    eq('no-rome-falsepos', a.location, ''); eq('jerome-email', a.email, 'jerome@acme.com'); eq('jerome-name', a.name, 'Jerome Smith');

    eq('reject-file-website', parse('see resume.pdf attached').website, '');
    eq('ig-from-domain', parse('instagram.com/john').instagram, 'john');
    eq('ig-from-handle', parse('reach me @john on insta').instagram, 'john');

    a = parse('Sam, phone n/a, lives in Berlin');
    eq('phone-junk-empty', a.phone, ''); eq('phone-junk-place', a.location, 'berlin');

    a = parse('Priya Rao\nProduct Designer @ Figma\npriya@figma.com\nfigma.com');
    eq('at-symbol-company', a.company, 'Figma'); rx('website-not-social', a.website, /figma\.com/); eq('designer-title', a.jobTitle, 'Product Designer');

    a = parse('Carlos, Software Engineer, Google');
    eq('title-company-comma', a.company, 'Google'); rx('title-company-title', a.jobTitle, /engineer/i);

    a = parse('San Francisco meetup with Dana');
    eq('multiword-place', a.location, 'san francisco'); eq('multiword-name', a.name, 'Dana');

    eq('bday-iso', parse('born 1992-03-14, Tomas').bday, '1992-03-14');

    a = parse('follow him x.com/elonmusk');
    eq('no-website-leak', a.website, ''); eq('x-handle', a.x, 'elonmusk');

    /* never-throw safety: empty / null / undefined all return safe defaults */
    var bad = ['', null, void 0], names = ['empty-safe', 'null-safe', 'undefined-safe'], i;
    for(i = 0; i < bad.length; i++){ var r = parse(bad[i]); R.push({ name: names[i], pass: !!(r && r.name === '' && r.email === ''), got: r && r.name }); }

    return { pass: R.every(function(x){ return x.pass; }), results: R };
  }

  G.SovennCapture = {
    parse: parse,
    _selftest: _selftest
  };
})();
