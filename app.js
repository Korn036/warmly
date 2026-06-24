/* ===================================================================
   WARMLY  ·  personal keep-in-touch CRM  ·  Phase 1 (local, no backend)
   Everything stays in this browser (localStorage). Nothing is sent to
   anyone until you tap send in WhatsApp / confirm in Google Calendar.
   =================================================================== */

/* ---------- storage ---------- */
const KEY='kith.v1';
const VERSION='0.25.0', BUILT='2026-06-24';  /* bumped on every deploy, shown in Settings so you can verify the live site is current */
const DEFAULT_TEMPLATES=[
  {id:'t_b',occasion:'birthday',name:'Birthday',body:"Happy birthday, {first}! Hope your day is a brilliant one. We're overdue a proper catch-up, let's fix that soon."},
  {id:'t_a',occasion:'anniversary',name:'Anniversary',body:"Happy anniversary, {first}! Wishing you both the very best today."},
  {id:'t_r',occasion:'reconnect',name:'Reconnect',body:"Hey {first}, you crossed my mind today, it's been too long! How have you been? Would genuinely love to catch up, free for a quick call sometime?"}
];
/* Warm, varied reconnect openers, rotated per contact so the same nudge is never sent twice in a row.
   100% on-device, no AI, nothing leaves the phone. {first} becomes the calling name, {me} your name.
   You always edit before sending. The rotation walks through every opener before any repeats. */
const RECONNECT_OPENERS=[
  {id:'o1',body:"Hey {first}, you popped into my head today and I realized it's been a while. How have you been, really?"},
  {id:'o2',body:"Hi {first}! We're long overdue a proper catch up. How is everything with you lately?"},
  {id:'o3',body:"Hey {first}, no reason at all, just thinking of you and hoping life is treating you well. What have you been up to?"},
  {id:'o4',body:"{first}! It's been too long. Tell me something good that has happened with you recently."},
  {id:'o5',body:"Hey {first}, I keep meaning to reach out. How are things on your side these days?"},
  {id:'o6',body:"Hi {first}, hope you're doing well. We're overdue a chat, are you free for a quick call sometime this week?"},
  {id:'o7',body:"Hey {first}, a bit of a random message, but you came to mind and I wanted to say hi. How's life?"},
  {id:'o8',body:"{first}, it's been a minute! How have you been keeping? Would love to properly catch up soon."},
  {id:'o9',body:"Hi {first}, hope all is good with you. What's new in your world lately?"},
  {id:'o10',body:"Hey {first}, thinking of you today and hoping you're well. How are things going?"},
  {id:'o11',body:"Hey {first}, it struck me that we haven't spoken in too long. How are you, honestly?"},
  {id:'o12',body:"{first}, I miss our chats. How is everything going with you right now?"},
  {id:'o13',body:"Hey {first}, just checking in because you matter to me. How have things been lately?"},
  {id:'o14',body:"Hi {first}, hope this finds you well. Any chance you're free for a catch up soon?"}
];
let DB = load();
function load(){
  try{ const d=JSON.parse(localStorage.getItem(KEY)); if(d&&d.contacts) return d; }catch(e){}
  return { v:1, contacts:[], templates:DEFAULT_TEMPLATES.slice(), settings:{ myName:'', country:'44', leadDays:1 } };
}
/* change-tracking so devices merge cleanly (newest edit per contact wins) */
let _snap={};
function _csig(c){ const o=Object.assign({},c); delete o.updatedAt; return JSON.stringify(o); }
function snapInit(){ _snap={}; (DB.contacts||[]).forEach(c=>{ _snap[c.id]=_csig(c); }); }
function stampChanges(){ const now=Date.now(), cur={};
  (DB.contacts||[]).forEach(c=>{ cur[c.id]=1; if(_snap[c.id]!==_csig(c)) c.updatedAt=now; });
  DB.deleted=DB.deleted||{}; Object.keys(_snap).forEach(id=>{ if(!cur[id]) DB.deleted[id]=now; });
  snapInit();
}
function save(){ stampChanges(); DB.savedAt=Date.now(); localStorage.setItem(KEY, JSON.stringify(DB)); schedulePush(); }

/* ===== Google Drive sync — to a hidden folder in YOUR OWN Drive, no Warmly server ===== */
const GCLIENT_ID='331804388562-k4qajob707mft6f5vrvvtsq2cvjbukoa.apps.googleusercontent.com';
const GSCOPE='https://www.googleapis.com/auth/drive.appdata';
/* Permanent "Sign in with Google": after you deploy worker/, set this to its base URL
   (predicted: https://warmly-auth.karthikonteddu306.workers.dev). Empty = the in-browser
   login below, which re-prompts ~hourly. Flipping this on needs no other change. */
const AUTH_WORKER='';
let _gtok=null,_gclient=null,_gfile=null,_gsyncing=false,_gpush=null,_gpending=null;
function _gstatus(t){ const e=document.getElementById('gstat'); if(e) e.textContent=t; }
function gisReady(cb){ if(window.google&&google.accounts&&google.accounts.oauth2) return cb();
  const s=document.createElement('script'); s.src='https://accounts.google.com/gsi/client'; s.async=true; s.onload=cb; s.onerror=()=>_gstatus('Could not reach Google'); document.head.appendChild(s); }
function gCacheTok(r){ if(r&&r.access_token){ _gtok=r.access_token; try{ localStorage.setItem('warmly.gtok', JSON.stringify({t:_gtok, exp:Date.now()+((r.expires_in||3600)*1000)-90000})); }catch(e){} localStorage.setItem('warmly.gsync','1'); } }
function gCachedTok(){ try{ const o=JSON.parse(localStorage.getItem('warmly.gtok')); if(o&&o.t&&o.exp>Date.now()) return o.t; }catch(e){} return null; }
function gInitClient(){ if(_gclient) return; _gclient=google.accounts.oauth2.initTokenClient({ client_id:GCLIENT_ID, scope:GSCOPE,
  callback:(r)=>{ gCacheTok(r);
    if(_gpending){ const p=_gpending; _gpending=null; p(r); } else { syncNow(); } } }); }
/* ---- Permanent login via the auth Worker (used only when AUTH_WORKER is set; otherwise every branch below falls through to the original in-browser flow unchanged) ---- */
function gSession(){ try{ return localStorage.getItem('warmly.session')||''; }catch(e){ return ''; } }
function gReturn(){ if(!AUTH_WORKER||location.hash.indexOf('warmly_session')<0) return false;
  const p=new URLSearchParams(location.hash.slice(1)); const s=p.get('warmly_session'), at=p.get('access_token');
  if(s){ try{ localStorage.setItem('warmly.session',s); }catch(e){} }
  if(at) gCacheTok({access_token:at, expires_in:parseInt(p.get('expires_in')||'3600',10)});
  try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){}  /* strip the tokens out of the address bar */
  return !!s; }
async function gWorkerToken(){ const s=gSession(); if(!s) return null;
  try{ const r=await fetch(AUTH_WORKER+'/auth/token?session='+encodeURIComponent(s)); if(!r.ok) return null;
    const j=await r.json(); if(j.access_token){ gCacheTok(j); return j; } }catch(e){} return null; }
function gToken(interactive){ if(!interactive){ const c=gCachedTok(); if(c){ _gtok=c; return Promise.resolve({access_token:c}); } }
  if(AUTH_WORKER){ if(interactive){ window.location.href=AUTH_WORKER+'/auth/start?app='+encodeURIComponent(location.origin+location.pathname); return new Promise(()=>{}); } return gWorkerToken(); }
  return new Promise(res=>{ gInitClient(); _gpending=res; try{ _gclient.requestAccessToken({prompt:interactive?'consent':''}); }catch(e){ _gpending=null; res(null); } }); }
window.gConnect=()=>{ if(AUTH_WORKER){ _gstatus('Opening Google…'); gToken(true); return; } gisReady(async()=>{ _gstatus('Opening Google…'); const r=await gToken(true); if(r&&r.access_token) syncNow(); else _gstatus('Sign-in cancelled'); }); };
window.gDisconnect=()=>{ if(AUTH_WORKER&&gSession()){ try{ fetch(AUTH_WORKER+'/auth/logout?session='+encodeURIComponent(gSession())); }catch(e){} } _gtok=null; _gfile=null; localStorage.removeItem('warmly.gsync'); localStorage.removeItem('warmly.gtok'); localStorage.removeItem('warmly.session'); route(); };
async function gFetch(url,opts){ opts=opts||{}; opts.headers=Object.assign({'Authorization':'Bearer '+_gtok},opts.headers||{});
  let r=await fetch(url,opts);
  if(r.status===401){ try{ localStorage.removeItem('warmly.gtok'); }catch(e){} const t=await gToken(false); if(t&&t.access_token){ opts.headers['Authorization']='Bearer '+_gtok; r=await fetch(url,opts); } }
  return r; }
async function gFindFile(){ const r=await gFetch("https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id)&q="+encodeURIComponent("name='warmly.json'")); if(!r.ok) return null; const j=await r.json(); return j.files&&j.files[0]?j.files[0].id:null; }
async function gDownload(id){ const r=await gFetch('https://www.googleapis.com/drive/v3/files/'+id+'?alt=media'); return r.ok?await r.json():null; }
async function gUpload(id,data){ const body=JSON.stringify(data);
  if(id) return gFetch('https://www.googleapis.com/upload/drive/v3/files/'+id+'?uploadType=media',{method:'PATCH',headers:{'Content-Type':'application/json'},body});
  const meta={name:'warmly.json',parents:['appDataFolder']}; const form=new FormData();
  form.append('metadata',new Blob([JSON.stringify(meta)],{type:'application/json'})); form.append('file',new Blob([body],{type:'application/json'}));
  return gFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{method:'POST',body:form}); }
function mergeDB(local,remote){ const out=JSON.parse(JSON.stringify(local)); const byId={};
  (out.contacts||[]).forEach(c=>byId[c.id]=c);
  (remote.contacts||[]).forEach(rc=>{ const lc=byId[rc.id]; if(!lc||(rc.updatedAt||0)>(lc.updatedAt||0)) byId[rc.id]=rc; });
  const del={}; [remote.deleted||{},out.deleted||{}].forEach(m=>Object.keys(m).forEach(id=>{ del[id]=Math.max(del[id]||0,m[id]); }));
  out.contacts=Object.values(byId).filter(c=>{ const t=del[c.id]; return !(t&&t>=(c.updatedAt||0)); });
  out.deleted=del;
  if((remote.savedAt||0)>(local.savedAt||0)){ if(remote.templates)out.templates=remote.templates; if(remote.settings)out.settings=Object.assign({},out.settings,remote.settings); }
  return out; }
async function syncNow(){ if(!_gtok||_gsyncing) return; _gsyncing=true; _gstatus('Syncing…');
  try{ if(!_gfile) _gfile=await gFindFile();
    const remote=_gfile?await gDownload(_gfile):null; let changed=false;
    if(remote&&remote.contacts){ const before=JSON.stringify(DB.contacts); DB=mergeDB(DB,remote); snapInit(); changed=JSON.stringify(DB.contacts)!==before; }
    DB.savedAt=Date.now(); localStorage.setItem(KEY,JSON.stringify(DB));
    const up=await gUpload(_gfile,DB);
    if(up&&up.ok&&!_gfile){ const j=await up.json(); _gfile=j.id; }
    if(changed) route();
    _gstatus((up&&up.ok)?('Synced · '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})):'Sync failed, will retry');
  }catch(e){ _gstatus('Sync error'); }
  finally{ _gsyncing=false; } }
window.syncNow=syncNow;
function schedulePush(){ if(localStorage.getItem('warmly.gsync')!=='1'||!_gtok) return; clearTimeout(_gpush); _gpush=setTimeout(syncNow,2500); }
function gBoot(){ if(localStorage.getItem('warmly.gsync')!=='1') return; const c=gCachedTok(); if(c){ _gtok=c; syncNow(); return; }
  if(AUTH_WORKER){ gToken(false).then(r=>{ if(r&&r.access_token) syncNow(); else _gstatus('Tap Sign in to resume sync'); }); return; }
  gisReady(async()=>{ const r=await gToken(false); if(r&&r.access_token) syncNow(); else _gstatus('Tap Sign in to resume sync'); }); }

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
function uid(){ return 'c'+Math.random().toString(36).slice(2,9); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/* esc() is for HTML text. For a value placed inside an inline handler's JS string (onclick="fn('X')"),
   JS-escape FIRST then HTML-escape, so it can't break out of the string after the browser decodes the attribute. */
function jsq(s){ return esc(String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'")); }
function firstName(n){ return (n||'').trim().split(/\s+/)[0]||''; }
function callName(c){ return (c&&c.callName)?c.callName:firstName(c?c.name:''); }
/* ---- per-contact social deep-links: conditional, generated on-device, nothing leaves the phone ---- */
function _handle(s){ return String(s||'').trim().replace(/^@/,'').replace(/^https?:\/\/(www\.)?[^\/]+\//i,'').replace(/[\/?#].*$/,''); }
function _abs(u){ u=String(u||'').trim(); return /^https?:\/\//i.test(u)?u:('https://'+u); }
function liUrl(u){ return /linkedin\.com/i.test(u)?_abs(u):('https://www.linkedin.com/in/'+_handle(u)); }
function socialLinks(c){ const o=[];
  const wa=c.phone?normalizePhone(c.phone):''; if(wa) o.push(['wa','WhatsApp','https://wa.me/'+wa]);
  if(c.phone) o.push(['call','Call','tel:'+c.phone.replace(/[^\d+]/g,'')]);
  if(c.email) o.push(['mail','Email','mailto:'+c.email]);
  if(c.linkedin) o.push(['in','LinkedIn',liUrl(c.linkedin)]);
  if(c.instagram) o.push(['ig','Instagram','https://instagram.com/'+_handle(c.instagram)]);
  if(c.x) o.push(['x','X','https://x.com/'+_handle(c.x)]);
  if(c.telegram) o.push(['tg','Telegram','https://t.me/'+_handle(c.telegram)]);
  if(c.website) o.push(['web','Website',_abs(c.website)]);
  return o;
}
function socIcon(k){ const I={
  wa:'<path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.2 13.9c-.2.6-1.2 1.1-1.7 1.2-.5 0-1 .2-3.1-.9-2.6-1.3-4.2-4-4.3-4.2-.1-.2-1-1.3-1-2.6s.7-1.8.9-2 .4-.3.6-.3h.5c.2 0 .4 0 .6.4l.8 2c.1.1.1.3 0 .5l-.4.5c-.1.2-.3.3-.1.6.2.3.9 1.4 1.9 2 .8.5 1.3.6 1.5.6.2-.1.5-.6.7-.9.2-.2.4-.2.6-.1l1.8.9c.2.1.4.2.5.3.1.2.1.7-.1 1.3z"/>',
  call:'<path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11 11 0 0 0 3.5.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.4a1 1 0 0 1 1 1 11 11 0 0 0 .6 3.5 1 1 0 0 1-.3 1z"/>',
  text:'<path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3.4V16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>',
  mail:'<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm8 7L4 6.5V18h16V6.5z"/>',
  in:'<path d="M5 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.5h4V21H3zm6 0h3.8v1.6h.1c.5-.9 1.8-1.8 3.6-1.8 3.9 0 4.5 2.5 4.5 5.7V21h-4v-4.9c0-1.2 0-2.7-1.7-2.7s-2 1.3-2 2.6V21H9z"/>',
  ig:'<path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3zm5 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm5-1a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>',
  x:'<path d="M17.5 3h3l-6.7 7.6L22 21h-6.3l-4.7-5.9L5.5 21H2.5l7.2-8.1L2 3h6.4l4.3 5.5zm-1.1 16h1.7L7.7 4.8H5.9z"/>',
  tg:'<path d="M21.9 4.3 18.7 19c-.2 1-.9 1.2-1.8.8l-4.9-3.6-2.3 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.3-.1-.5-.6-.2L4.6 13l-3.9-1.2c-.8-.3-.9-.9.2-1.3L20.6 3c.7-.3 1.4.2 1.3 1.3z"/>',
  web:'<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.6a15 15 0 0 0-1.3-3.3A8 8 0 0 1 18.9 8zM12 4c.8 1 1.5 2.4 1.9 4h-3.8C10.5 6.4 11.2 5 12 4zM4.3 14a8 8 0 0 1 0-4h3a18 18 0 0 0 0 4zm.8 2h2.6c.3 1.2.8 2.3 1.3 3.3A8 8 0 0 1 5.1 16zM7.7 8H5.1a8 8 0 0 1 3.9-3.3C8.5 5.7 8 6.8 7.7 8zM12 20c-.8-1-1.5-2.4-1.9-4h3.8c-.4 1.6-1.1 3-1.9 4zm2.3-6H9.7a16 16 0 0 1 0-4h4.6a16 16 0 0 1 0 4zm.4 5.3c.5-1 1-2.1 1.3-3.3h2.6a8 8 0 0 1-3.9 3.3zM16.7 14a18 18 0 0 0 0-4h3a8 8 0 0 1 0 4z"/>'
}; return '<svg viewBox="0 0 24 24" aria-hidden="true">'+(I[k]||I.web)+'</svg>'; }
function socialRow(c, withAdd, skip){ let links=socialLinks(c); if(skip) links=links.filter(l=>!['wa','call','mail'].includes(l[0])); if(!links.length && !withAdd) return '';
  let h='<div class="socrow">';
  links.forEach(([k,label,url])=>{ h+='<a class="soc soc-'+k+'" href="'+esc(url)+'" target="_blank" rel="noopener" title="'+label+'" aria-label="'+label+'">'+socIcon(k)+'</a>'; });
  if(withAdd) h+='<button class="soc socadd" onclick="event.stopPropagation();editContact(\''+c.id+'\')" title="add a link" aria-label="add a link">+</button>';
  return h+'</div>';
}
/* ---- the Reach hub: every channel, one tap, the hero of a contact's page ---- */
function reachBar(c){ const id=c.id; const ph=c.phone? String(c.phone).replace(/[^\d+]/g,''):''; const wmsg=c.lastMsg||'';
  const items=[
    ['call','Call', ph?('tel:'+ph):'', ph],
    ['text','Text', ph?('sms:'+ph+(wmsg?('?body='+encodeURIComponent(wmsg)):'')):'', ph],
    ['wa','WhatsApp','', ph],
    ['mail','Email', c.email?('mailto:'+c.email):'', c.email]
  ];
  let h='<div class="reach-label">Reach '+esc(callName(c))+' &middot; one tap, any way</div><div class="reach">';
  items.forEach(([k,label,href,on])=>{
    const ic='<span class="ic">'+socIcon(k)+'</span><span class="lb">'+label+'</span>';
    if(!on) h+='<button class="act '+k+' off" title="Add their '+(k==='mail'?'email':'number')+'" onclick="editContact(\''+id+'\')">'+ic+'</button>';
    else if(k==='wa') h+='<button class="act wa" onclick="compose(\''+id+'\',\'reconnect\')">'+ic+'</button>';
    else h+='<a class="act '+k+'" href="'+esc(href)+'">'+ic+'</a>';
  });
  return h+'</div>';
}
/* ---- peer-to-peer "ask for their details": they fill a static page, the reply comes back to you on WhatsApp, no server ---- */
window.askDetails=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return; const me=DB.me||{};
  if(!me.phone){ alert('Add your own WhatsApp number in My Card first, so their reply comes back to you.'); go('mycard'); return; }
  if(!c.phone){ alert('Add their phone number first so you can message them.'); editContact(id); return; }
  const base=location.origin + location.pathname.replace(/[^\/]*$/, '');
  const link=base+'card.html?to='+encodeURIComponent(normalizePhone(me.phone))+'&from='+encodeURIComponent(me.name||DB.settings.myName||'a friend');
  const msg='Hey '+callName(c)+'! I keep the people I care about close on Warmly. Mind sharing a few details so I never miss your birthday? Takes 20 seconds: '+link;
  window.open(waLink(c.phone,msg),'_blank','noopener');
};
function initials(n){ const p=(n||'?').trim().split(/\s+/); return ((p[0]||'?')[0]+(p.length>1?p[p.length-1][0]:'')).toUpperCase(); }
function avatarColor(n){ const colors=['#0E3B2E','#2E8C6A','#C9756B','#D99A2B','#6A655B','#3C6E91','#8A5A99']; let h=0; for(const c of (n||'x')) h=(h*31+c.charCodeAt(0))%colors.length; return colors[h]; }
const MONTHS=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function today(){ const t=new Date(); return new Date(t.getFullYear(),t.getMonth(),t.getDate()); }
function nextOccurrence(m,d){ const t=today(); let yr=t.getFullYear(); let occ=new Date(yr,m-1,d); if(occ<t) occ=new Date(yr+1,m-1,d); return occ; }
function daysUntil(date){ return Math.round((date-today())/86400000); }
function addMonths(iso,n){ const p=String(iso).slice(0,10).split('-').map(Number); const d=new Date(p[0],(p[1]||1)-1,p[2]||1); d.setMonth(d.getMonth()+n); return d; }
function fmtDate(date){ return MONTHS[date.getMonth()+1]+' '+date.getDate(); }
function whenLabel(n){ return n===0?'today':n===1?'tomorrow':'in '+n+' days'; }
function normalizePhone(raw,country){
  if(!raw) return ''; let s=String(raw).replace(/[^\d+]/g,'');
  if(s.startsWith('+')) return s.slice(1);
  if(s.startsWith('00')) return s.slice(2);
  country=(country||DB.settings.country||'').replace(/\D/g,'');
  if(s.startsWith('0')) return country+s.slice(1);
  if(country && s.length<=10) return country+s;
  return s;
}
function parseDateStr(v){
  if(!v) return null; v=String(v).trim();
  let m=v.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return {y:+m[1]||null,m:+m[2],d:+m[3]};
  m=v.match(/^--(\d{2})-?(\d{2})$/); if(m) return {y:null,m:+m[1],d:+m[2]};
  m=v.match(/^(\d{4})(\d{2})(\d{2})$/); if(m) return {y:+m[1],m:+m[2],d:+m[3]};
  m=v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if(m){ return {y:+m[3]<100?2000+ +m[3]:+m[3], m:+m[1], d:+m[2]}; }
  const d=new Date(v); if(!isNaN(d)) return {y:d.getFullYear(),m:d.getMonth()+1,d:d.getDate()};
  return null;
}

/* ---------- reminder engine ---------- */
function contactOccasions(c){
  const out=[];
  if(c.bday&&c.bday.m) out.push({type:'birthday',label:'birthday',date:nextOccurrence(c.bday.m,c.bday.d),raw:c.bday});
  if(c.anniv&&c.anniv.m) out.push({type:'anniversary',label:'anniversary',date:nextOccurrence(c.anniv.m,c.anniv.d),raw:c.anniv});
  (c.customDates||[]).forEach(cd=>{ if(cd.m) out.push({type:'custom',label:cd.label||'date',date:nextOccurrence(cd.m,cd.d),raw:cd}); });
  return out;
}
function upcoming(within){
  within=within||21; const list=[];
  DB.contacts.forEach(c=>contactOccasions(c).forEach(o=>{ const n=daysUntil(o.date); if(n<=within) list.push({c,o,n}); }));
  return list.sort((a,b)=>a.n-b.n);
}
function nextDue(c){ if(!c.cadence) return null; return c.lastContacted? addMonths(c.lastContacted,c.cadence) : today(); }
function dueToReach(){
  const list=[];
  DB.contacts.forEach(c=>{ const nd=nextDue(c); if(nd && nd<=today()) list.push({c,overdue:daysUntil(nd)}); });
  return list.sort((a,b)=>a.overdue-b.overdue);
}

/* ---------- deep links (the "automation", human-approved) ---------- */
function waLink(phone,text){ const p=normalizePhone(phone); return 'https://wa.me/'+p+(text?('?text='+encodeURIComponent(text)):''); }
function gcalLink(title,date,details,yearly){
  const pad=n=>String(n).padStart(2,'0');
  const s=date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate());
  const e=new Date(date.getTime()+86400000); const ee=e.getFullYear()+pad(e.getMonth()+1)+pad(e.getDate());
  let u='https://calendar.google.com/calendar/render?action=TEMPLATE&text='+encodeURIComponent(title)+'&dates='+s+'/'+ee;
  if(details) u+='&details='+encodeURIComponent(details);
  if(yearly) u+='&recur='+encodeURIComponent('RRULE:FREQ=YEARLY');
  return u;
}
function fillTemplate(body,c){
  return (body||'').replace(/\{first\}/g,callName(c)).replace(/\{name\}/g,c.callName||c.name||'').replace(/\{me\}/g,DB.settings.myName||'');
}
/* ---- fresh-message engine: never suggest the same reconnect opener twice in a row (on-device only) ---- */
function warmFill(body,c){ const fn=callName(c)||'there'; return (body||'').replace(/\{first\}/g,fn).replace(/\{me\}/g,DB.settings.myName||''); }
function pickOpener(c, avoidId){
  const hist=(c&&c.msgHistory)||[]; const usedIds=hist.map(m=>m&&m.openerId).filter(Boolean);
  let pool=RECONNECT_OPENERS.filter(o=>o.id!==avoidId); if(!pool.length) pool=RECONNECT_OPENERS.slice();
  const unused=pool.filter(o=>usedIds.indexOf(o.id)<0); const choose=unused.length?unused:pool;
  return choose[Math.floor(Math.random()*choose.length)];
}
function freshDraft(c, occasion, avoidId){
  if(occasion!=='reconnect'){ const tpl=DB.templates.find(t=>t.occasion===occasion)||DB.templates.find(t=>t.occasion==='reconnect')||{body:''}; return { text: fillTemplate(tpl.body,c), openerId:null }; }
  const o=pickOpener(c, avoidId); return { text: warmFill(o.body,c), openerId:o.id };
}

/* ---------- parsers ---------- */
function parseCSV(text){
  const rows=[]; let i=0,f='',row=[],q=false;
  while(i<text.length){ const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=ch; }
    else { if(ch==='"') q=true; else if(ch===','){ row.push(f); f=''; } else if(ch==='\n'){ row.push(f); rows.push(row); row=[]; f=''; } else if(ch==='\r'){} else f+=ch; }
    i++;
  }
  if(f.length||row.length){ row.push(f); rows.push(row); }
  if(!rows.length) return [];
  const head=rows[0].map(h=>h.trim());
  const find=res=>{ for(let j=0;j<head.length;j++){ const h=head[j].toLowerCase(); if(res.some(r=>h.includes(r))) return j; } return -1; };
  const iName=find(['name']), iFirst=find(['first name','given name']), iLast=find(['last name','family name']);
  const iPhone=head.findIndex(h=>/phone|tel|mobile/i.test(h)&&/value|number/i.test(h)); const iPhone2=find(['phone','mobile','tel']);
  const iMail=find(['e-mail 1','email','e-mail','mail']);
  const iBday=find(['birthday','bday','date of birth']);
  const iOrg=find(['organization','company']);
  const out=[];
  for(let r=1;r<rows.length;r++){ const row=rows[r]; if(!row.length||row.every(x=>!String(x).trim())) continue;
    const g=k=>k>=0?(row[k]||'').trim():'';
    let name=g(iName); if(!name) name=[g(iFirst),g(iLast)].filter(Boolean).join(' ');
    const phone=g(iPhone>=0?iPhone:iPhone2);
    if(!name && !phone) continue;
    out.push({ name:name||phone, phone, email:g(iMail), bday:parseDateStr(g(iBday)), context:g(iOrg) });
  }
  return out;
}
function parseVCF(text){
  const cards=text.split(/END:VCARD/i); const out=[];
  cards.forEach(card=>{ if(!/BEGIN:VCARD/i.test(card)) return;
    const get=re=>{ const m=card.match(re); return m?m[1].trim():''; };
    let name=get(/\nFN[^:]*:(.*)/i);
    if(!name){ const n=get(/\nN[^:]*:(.*)/i); if(n){ const p=n.split(';'); name=[p[1],p[0]].filter(Boolean).join(' ').trim(); } }
    const phone=get(/\nTEL[^:]*:(.*)/i);
    const email=get(/\nEMAIL[^:]*:(.*)/i);
    const url=get(/\nURL[^:]*:(.*)/i);
    const note=get(/\nNOTE[^:]*:(.*)/i);
    const bday=parseDateStr(get(/\nBDAY[^:]*:(.*)/i));
    if(!name && !phone) return;
    out.push({ name:name||phone, phone, email, linkedin:/linkedin/i.test(url)?url:'', context:note, bday });
  });
  return out;
}

/* ---------- shape icons (replace emojis) ---------- */
function occShape(type,size){ size=size||34; const o='<svg class="ico" width="'+size+'" height="'+size+'" viewBox="0 0 48 48" aria-hidden="true">';
  if(type==='birthday') return o+'<circle cx="24" cy="28" r="13" fill="var(--gold-soft)"/><circle cx="24" cy="28" r="6.5" fill="var(--green)"/><circle cx="24" cy="8" r="4.2" fill="var(--rose)"/></svg>';
  if(type==='anniversary') return o+'<circle cx="20" cy="24" r="12.5" fill="var(--rose)"/><circle cx="30" cy="24" r="12.5" fill="var(--gold-soft)" style="mix-blend-mode:multiply"/></svg>';
  if(type==='reconnect'||type==='warm'||type==='call') return o+'<circle cx="24" cy="24" r="19" fill="none" stroke="var(--green-2)" stroke-width="4"/><circle cx="24" cy="24" r="11" fill="none" stroke="var(--green)" stroke-width="4"/><circle cx="24" cy="24" r="3.5" fill="var(--green)"/></svg>';
  if(type==='connection') return o+'<circle cx="19" cy="24" r="11" fill="none" stroke="var(--green)" stroke-width="5"/><circle cx="29" cy="24" r="11" fill="none" stroke="var(--gold)" stroke-width="5"/></svg>';
  return o+'<circle cx="24" cy="24" r="18" fill="none" stroke="var(--green-2)" stroke-width="4"/><circle cx="24" cy="24" r="4" fill="var(--green-2)"/></svg>';
}
/* ---------- offline geocoding for the world map (no network, stays private) ---------- */
const GEO={
 'london':[51.5,-0.12],'manchester':[53.48,-2.24],'birmingham':[52.48,-1.9],'edinburgh':[55.95,-3.19],'glasgow':[55.86,-4.25],'leeds':[53.8,-1.55],'bristol':[51.45,-2.59],
 'paris':[48.86,2.35],'berlin':[52.52,13.4],'munich':[48.14,11.58],'frankfurt':[50.11,8.68],'madrid':[40.42,-3.7],'barcelona':[41.39,2.17],'rome':[41.9,12.5],'milan':[45.46,9.19],'turin':[45.07,7.69],'amsterdam':[52.37,4.9],'warsaw':[52.23,21.01],'lisbon':[38.72,-9.14],'zurich':[47.37,8.54],'geneva':[46.2,6.14],'vienna':[48.21,16.37],'dublin':[53.35,-6.26],'brussels':[50.85,4.35],'stockholm':[59.33,18.06],'copenhagen':[55.68,12.57],'oslo':[59.91,10.75],'helsinki':[60.17,24.94],'prague':[50.08,14.44],'budapest':[47.5,19.04],'athens':[37.98,23.73],'moscow':[55.75,37.62],
 'new york':[40.71,-74.01],'san francisco':[37.77,-122.42],'los angeles':[34.05,-118.24],'chicago':[41.88,-87.63],'boston':[42.36,-71.06],'seattle':[47.61,-122.33],'austin':[30.27,-97.74],'washington':[38.9,-77.04],'miami':[25.76,-80.19],'toronto':[43.65,-79.38],'vancouver':[49.28,-123.12],'montreal':[45.5,-73.57],
 'dubai':[25.2,55.27],'abu dhabi':[24.45,54.38],'doha':[25.29,51.53],'riyadh':[24.71,46.68],'tel aviv':[32.08,34.78],'istanbul':[41.01,28.98],
 'mumbai':[19.08,72.88],'delhi':[28.61,77.21],'new delhi':[28.61,77.21],'bangalore':[12.97,77.59],'bengaluru':[12.97,77.59],'hyderabad':[17.39,78.49],'chennai':[13.08,80.27],'pune':[18.52,73.86],'kolkata':[22.57,88.36],'ahmedabad':[23.03,72.58],'gurgaon':[28.46,77.03],'gurugram':[28.46,77.03],'noida':[28.54,77.39],
 'singapore':[1.35,103.82],'hong kong':[22.32,114.17],'tokyo':[35.68,139.69],'seoul':[37.57,126.98],'shanghai':[31.23,121.47],'beijing':[39.9,116.4],'bangkok':[13.76,100.5],'jakarta':[-6.21,106.85],'kuala lumpur':[3.14,101.69],'manila':[14.6,120.98],'sydney':[-33.87,151.21],'melbourne':[-37.81,144.96],'auckland':[-36.85,174.76],
 'cairo':[30.04,31.24],'lagos':[6.52,3.38],'nairobi':[-1.29,36.82],'johannesburg':[-26.2,28.05],'cape town':[-33.92,18.42],'sao paulo':[-23.55,-46.63],'rio de janeiro':[-22.91,-43.17],'buenos aires':[-34.6,-58.38],'mexico city':[19.43,-99.13],'bogota':[4.71,-74.07],'santiago':[-33.45,-70.67],
 'india':[22,79],'uk':[54,-2],'united kingdom':[54,-2],'england':[52.5,-1.5],'usa':[39,-98],'united states':[39,-98],'america':[39,-98],'canada':[56,-106],'france':[46,2],'germany':[51,10],'spain':[40,-4],'italy':[42,12],'netherlands':[52,5],'poland':[52,19],'portugal':[39.5,-8],'switzerland':[47,8],'ireland':[53,-8],'sweden':[62,15],'uae':[24,54],'qatar':[25.3,51.2],'saudi arabia':[24,45],'china':[35,103],'japan':[36,138],'south korea':[36.5,127.8],'australia':[-25,134],'brazil':[-10,-55],'mexico':[23,-102],'south africa':[-29,24],'nigeria':[9,8],'kenya':[1,38],'egypt':[26,30],'thailand':[15,101],'indonesia':[-2,118],'malaysia':[4,102],'philippines':[13,122] };
function geocode(loc){ if(!loc) return null; const s=String(loc).toLowerCase().trim();
  if(GEO[s]) return {ll:GEO[s],key:s};
  const parts=s.split(/[,/|]/).map(x=>x.trim()).filter(Boolean);
  for(const p of parts){ if(GEO[p]) return {ll:GEO[p],key:p}; }
  for(const k in GEO){ if(k.length>3 && s.indexOf(k)>=0) return {ll:GEO[k],key:k}; }
  return null;
}
const WORLD_PATHS='<g class="map-land">'
 +'<polygon points="32,36 72,26 112,30 122,44 104,58 96,74 82,72 68,58 52,54 36,52"/>'
 +'<polygon points="104,78 120,82 110,92 100,88"/>'
 +'<polygon points="110,96 130,92 140,106 132,130 118,148 108,140 104,118"/>'
 +'<polygon points="168,34 196,26 214,32 210,46 192,50 176,48 170,42"/>'
 +'<polygon points="176,56 214,54 224,72 214,100 198,124 184,118 178,92 172,72"/>'
 +'<polygon points="216,30 266,22 312,28 330,46 318,62 286,66 252,58 232,70 222,52"/>'
 +'<polygon points="286,96 312,98 326,104 300,110 290,102"/>'
 +'<polygon points="300,110 332,106 340,122 318,134 300,124"/>'
 +'</g>';

/* ===================================================================
   ROUTER + VIEWS
   =================================================================== */
function go(view,arg){ location.hash = '#'+view+(arg?('/'+arg):''); }
window.addEventListener('hashchange',route);
let _lastView='', _shuffleId=null;
window.shuffleToday=()=>{ _shuffleId='reroll'; route(); };
function route(){
  const [view,arg]=location.hash.replace('#','').split('/');
  document.querySelectorAll('#tabs a').forEach(a=>a.classList.toggle('active',a.dataset.go===(view||'today')));
  $('#tabs').classList.remove('open');
  const v=view||'today';
  if(v==='today' && _lastView!=='today') _shuffleId='reroll';
  _lastView=v;
  ({ today:viewToday, people:viewPeople, person:viewPerson, map:viewMap, mycard:viewMyCard, import:viewImport, templates:viewTemplates, settings:viewSettings }[v]||viewToday)(arg);
  window.scrollTo(0,0);
}

function viewToday(){
  const due=dueToReach(), up=upcoming(21);
  let h='<div class="view"><h1 class="title">Today</h1><p class="muted">'+(DB.settings.myName?('Hello '+esc(firstName(DB.settings.myName))+'. '):'')+'Keep your people warm.</p>';
  if(!DB.contacts.length){
    h+='<div class="empty"><div class="big">No one here yet.</div>Import your contacts to begin, then mark the handful who matter.<br><br><button class="btn primary" onclick="go(\'import\')">Import contacts</button></div></div>';
    return render(h);
  }
  h+='<div class="today-top">';
  /* hero: the nearest upcoming celebration leads; otherwise the most overdue reconnect */
  let heroId=null, heroOcc=null;
  if(up.length){ const x=up[0]; heroId=x.c.id; heroOcc=x;
    h+=heroCard(x.c, x.o.label, whenLabel(x.n),
      '<button class="btn primary" onclick="compose(\''+x.c.id+'\',\''+(x.o.type==='anniversary'?'anniversary':x.o.type==='birthday'?'birthday':'reconnect')+'\')">Wish '+esc(callName(x.c))+'</button>'+
      '<button class="btn ghost" onclick="addCal(\''+x.c.id+'\','+(x.o.date.getMonth()+1)+','+x.o.date.getDate()+',\''+jsq(x.o.label)+'\')">+ Calendar</button>');
  } else if(due.length){ const c=due[0].c; heroId=c.id;
    h+=heroCard(c, 'time to reconnect', (due[0].overdue<0?(-due[0].overdue)+' days overdue':'due now'),
      '<button class="btn primary" onclick="compose(\''+c.id+'\',\'reconnect\')">Message '+esc(callName(c))+'</button>'+
      '<button class="btn ghost" onclick="logToday(\''+c.id+'\')">Log call</button>');
  }
  /* progress: warmth */
  const tracked=DB.contacts.filter(c=>c.cadence);
  const warm=Math.max(0, tracked.length - due.filter(d=>d.c.cadence).length);
  const pct=tracked.length?Math.max(4,Math.min(100,Math.round(warm/tracked.length*100))):100;
  h+='<div class="card prog"><div class="row between"><div><div class="kick" style="margin:0">Your warmth</div><div class="pstat">'+(tracked.length?('Keeping '+warm+' of '+tracked.length+' people warm'):'Set a reconnect rhythm on a few people')+'</div></div><span class="floaty">'+occShape('reconnect',42)+'</span></div><div class="bar"><span style="width:'+pct+'%"></span></div></div>';
  h+='</div>';
  /* serendipity shuffle: a different person each visit, so good names resurface */
  { const pool=DB.contacts.filter(c=>c.id!==heroId && !c.review);
    let shuf=null;
    if(pool.length){ if(_shuffleId && _shuffleId!=='reroll') shuf=pool.find(c=>c.id===_shuffleId); if(!shuf) shuf=pool[Math.floor(Math.random()*pool.length)]; _shuffleId=shuf?shuf.id:null; }
    if(shuf){ const seen=shuf.lastContacted?('last spoke '+shuf.lastContacted):'not spoken yet'; h+='<div class="kick">A nudge &middot; rekindle someone</div>'+personRow(shuf, '<span class="pill warm">'+esc(seen)+'</span>', '<button class="btn sm primary" onclick="compose(\''+shuf.id+'\',\'reconnect\')">Message '+esc(callName(shuf))+'</button> <button class="btn sm ghost" onclick="shuffleToday()">Shuffle</button>'); }
  }
  /* coming up FIRST: upcoming celebrations on top */
  h+='<div class="kick">Coming up'+(up.length?' ('+up.length+')':'')+'</div>';
  const upList=up.filter(x=>x!==heroOcc).slice(0,20);
  if(!up.length) h+='<div class="card muted" style="text-align:center">No birthdays or anniversaries in the next three weeks.</div>';
  else if(!upList.length) h+='<div class="card muted" style="text-align:center">The nearest celebration is up top.</div>';
  else { h+='<div class="grid">'; upList.forEach(({c,o,n})=>{
    const pill='<span class="pill '+(o.type==='birthday'?'bday':o.type==='anniversary'?'anniv':'warm')+'">'+esc(o.label)+' '+whenLabel(n)+'</span>';
    h+=personRow(c, pill,
      '<button class="btn sm gold" onclick="compose(\''+c.id+'\',\''+(o.type==='anniversary'?'anniversary':o.type==='birthday'?'birthday':'reconnect')+'\')">Wish</button> '+
      '<button class="btn sm ghost" onclick="addCal(\''+c.id+'\','+(o.date.getMonth()+1)+','+o.date.getDate()+',\''+jsq(o.label)+'\')">+ Calendar</button>');
  }); h+='</div>'; }
  /* reach out SECOND */
  h+='<div class="kick">Time to reach out ('+due.length+')</div>';
  const dueList=due.filter(d=>d.c.id!==heroId).slice(0,12);
  if(!due.length) h+='<div class="card muted" style="text-align:center">Nobody is overdue. Nicely kept.</div>';
  else if(!dueList.length) h+='<div class="card muted" style="text-align:center">Your most overdue person is up top.</div>';
  else { h+='<div class="grid">'; dueList.forEach(({c,overdue})=>{ h+=personRow(c, overdue===0?'<span class="pill warm">due now</span>':'<span class="pill warm">'+(-overdue)+'d overdue</span>',
      '<button class="btn sm primary" onclick="compose(\''+c.id+'\',\'reconnect\')">Message</button> <button class="btn sm ghost" onclick="logToday(\''+c.id+'\')">Log call</button>'); }); h+='</div>'; }
  h+='</div>'; render(h);
}
function heroCard(c, label, whenText, actions){
  return '<div class="hero"><svg class="blob" viewBox="0 0 64 44" aria-hidden="true"><circle cx="26" cy="22" r="13" fill="none" stroke="var(--hero-ink)" stroke-width="7" opacity=".5"/><circle cx="40" cy="22" r="13" fill="none" stroke="var(--hero-ink)" stroke-width="7"/></svg>'
    +'<div class="kick" style="color:var(--hero-ink);opacity:.85;margin:0 0 8px">'+esc(label)+'</div>'
    +'<div class="nm">'+esc(c.name)+'</div>'
    +'<div class="sub">'+(c.context?esc(c.context)+' · ':'')+'<span class="circ">'+esc(whenText)+'<svg viewBox="0 0 96 30" preserveAspectRatio="none"><path d="M82 7 C 98 13, 92 27, 48 28 C 8 29, 4 16, 12 9 C 20 3, 66 3, 90 12"/></svg></span></div>'
    +'<div class="btn-row" style="margin-top:14px">'+actions+'</div></div>';
}
function viewMap(){
  const groups={}, noloc=[];
  DB.contacts.forEach(c=>{ const raw=c.location||c.company||c.address||c.context||''; const g=raw?geocode(raw):null;
    if(g){ (groups[g.key]=groups[g.key]||{ll:g.ll,people:[]}).people.push(c); }
    else noloc.push(c); });
  const keys=Object.keys(groups).sort((a,b)=>groups[b].people.length-groups[a].people.length);
  const placed=keys.reduce((n,k)=>n+groups[k].people.length,0);
  let h='<div class="view"><h1 class="title">Where your people are</h1><p class="muted">'+placed+' of '+DB.contacts.length+' on the map. Add a city to anyone and they appear here.</p>';
  let dots='';
  keys.forEach(k=>{ const g=groups[k]; const cx=(g.ll[1]+180), cy=(90-g.ll[0]); const n=g.people.length; const r=Math.min(11,3+n*1.6);
    dots+='<circle class="map-dot'+(n>2?' big':'')+'" cx="'+cx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="'+r.toFixed(1)+'"><title>'+esc(k)+' · '+n+'</title></circle>'; });
  h+='<div class="map-wrap"><svg class="world" viewBox="0 0 360 180" preserveAspectRatio="xMidYMid meet">'+WORLD_PATHS+dots+'</svg></div>';
  if(keys.length){ h+='<div class="kick">By location</div><div class="card" style="padding:2px 14px">';
    keys.forEach(k=>{ h+='<div class="geo-row" style="cursor:pointer" onclick="pLoc(\''+k+'\')"><span class="geo-dot"></span><span style="text-transform:capitalize">'+esc(k)+'</span><span class="ct">'+groups[k].people.length+' &rarr;</span></div>'; });
    h+='</div>'; }
  if(noloc.length){ h+='<div class="kick">Not placed yet ('+noloc.length+')</div><div class="card muted" style="line-height:1.7">Add a city to these people (open them &rarr; Edit details &rarr; Location): '+noloc.slice(0,40).map(c=>esc(firstName(c.name)||c.name)).join(', ')+(noloc.length>40?'…':'')+'</div>'; }
  h+='</div>'; render(h);
}
function personRow(c,pill,actions){
  return '<div class="card" data-cid="'+c.id+'"><div class="row"><div class="avatar" style="background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
    +'<div class="grow" onclick="go(\'person\',\''+c.id+'\')" style="cursor:pointer"><div class="nm">'+esc(c.name)+'</div><div class="sub">'+(c.context?esc(c.context)+' · ':'')+pill+'</div></div>'+kebab(c.id)+'</div>'
    +'<div class="btn-row" style="margin-top:12px">'+actions+'</div></div>';
}

function peopleTile(c){ const occ=contactOccasions(c)[0];
  return '<div class="tile" data-cid="'+c.id+'" onclick="go(\'person\',\''+c.id+'\')">'+kebab(c.id)+'<div class="avatar" style="background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
    +'<div class="nm">'+esc(c.name)+'</div>'
    +'<div class="sub">'+esc(c.location||c.company||c.context||'—')+'</div>'
    +'<div class="sub" style="margin-top:2px">'+(occ?(esc(occ.label)+' '+fmtDate(occ.date)):(c.cadence?('reconnect every '+c.cadence+' mo'):'&nbsp;'))+'</div>'
    +'<span class="pill t'+(c.tier||3)+'" style="margin-top:10px;align-self:flex-start">'+({1:'inner',2:'warm',3:'loose'}[c.tier||3])+'</span>'+(c.review?'<span class="review-badge" style="margin-top:8px;align-self:flex-start">review</span>':'')+'</div>';
}
function peopleRow(c){ const occ=contactOccasions(c)[0];
  return '<div class="card row" data-cid="'+c.id+'" style="cursor:pointer" onclick="go(\'person\',\''+c.id+'\')"><div class="avatar" style="background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
    +'<div class="grow"><div class="nm">'+esc(c.name)+'</div><div class="sub">'+esc(c.location||c.company||c.context||'no notes yet')+(occ?(' · '+esc(occ.label)+' '+fmtDate(occ.date)):'')+'</div></div>'
    +'<span class="pill t'+(c.tier||3)+'">'+({1:'inner',2:'warm',3:'loose'}[c.tier||3])+'</span>'+(c.review?'<span class="review-badge">review</span>':'')+kebab(c.id)+'</div>';
}
function viewPeople(){
  const f=window._pfilter||{q:'',tier:0};
  const mode=localStorage.getItem('warmly.pview')||'tiles';
  const sort=localStorage.getItem('warmly.psort')||'name';
  const reviewN=DB.contacts.filter(c=>c.review).length;
  let list=DB.contacts.slice();
  if(f.tier) list=list.filter(c=>c.tier===f.tier);
  if(f.review) list=list.filter(c=>c.review);
  if(f.q){ const q=f.q.toLowerCase(); list=list.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.context||'').toLowerCase().includes(q)||(c.location||'').toLowerCase().includes(q)||(c.company||'').toLowerCase().includes(q)); }
  const byName=(a,b)=>(a.name||'').localeCompare(b.name||'');
  if(sort==='overdue') list.sort((a,b)=>overdueScore(b)-overdueScore(a)||byName(a,b));
  else if(sort==='recent') list.sort((a,b)=>lastTs(b)-lastTs(a)||byName(a,b));
  else if(sort==='close') list.sort((a,b)=>(a.tier||3)-(b.tier||3)||byName(a,b));
  else list.sort(byName);
  let h='<div class="view"><div class="row between"><h1 class="title">People</h1><button class="btn primary sm" onclick="quickAdd()">+ Add</button></div>';
  h+='<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input id="pq" placeholder="search '+DB.contacts.length+' people, cities, companies" value="'+esc(f.q)+'" oninput="pSearch(this.value)"></div>';
  h+='<div class="row between" style="flex-wrap:wrap;gap:8px;align-items:center">';
  h+='<div class="chips" style="margin:6px 0">'+[[0,'all'],[1,'inner circle'],[2,'keep warm'],[3,'loose ties']].map(([t,l])=>'<span class="chip '+((!f.review&&f.tier===t)?'on':'')+'" onclick="pTier('+t+')">'+l+'</span>').join('')+(reviewN?'<span class="chip '+(f.review?'on':'')+'" onclick="pReview()">to review ('+reviewN+')</span>':'')+'</div>';
  h+='<div class="seg">'+[['tiles','tiles'],['list','list'],['area','area']].map(([m,l])=>'<button class="'+(mode===m?'on':'')+'" onclick="pView(\''+m+'\')">'+l+'</button>').join('')+'</div>';
  h+='<select class="sortsel" onchange="pSort(this.value)">'+[['name','A to Z'],['overdue','most overdue'],['recent','recently contacted'],['close','closeness']].map(([v,l])=>'<option value="'+v+'"'+(sort===v?' selected':'')+'>'+l+'</option>').join('')+'</select>';
  h+='</div>';
  if(!list.length){ h+='<div class="empty">No matches.</div></div>'; return render(h); }
  if(mode==='area'){
    const groups={}, none=[];
    list.forEach(c=>{ const raw=c.location||c.company||c.address||c.context||''; const g=raw?geocode(raw):null; if(g){ (groups[g.key]=groups[g.key]||[]).push(c); } else none.push(c); });
    Object.keys(groups).sort((a,b)=>groups[b].length-groups[a].length).forEach(k=>{
      h+='<div class="gsec"><span style="text-transform:capitalize">'+esc(k)+'</span><span class="ct">'+groups[k].length+'</span></div><div class="grid">'+groups[k].map(peopleTile).join('')+'</div>'; });
    if(none.length) h+='<div class="gsec">No location yet <span class="ct">'+none.length+'</span></div><div class="grid">'+none.map(peopleTile).join('')+'</div>';
  } else if(mode==='list'){
    h+=list.map(peopleRow).join('');
  } else {
    h+='<div class="grid">'+list.map(peopleTile).join('')+'</div>';
  }
  h+='</div>'; render(h);
}
window.pView=m=>{ localStorage.setItem('warmly.pview',m); viewPeople(); };
window.pSort=v=>{ localStorage.setItem('warmly.psort',v); viewPeople(); };
window.pReview=()=>{ const f=window._pfilter||{}; window._pfilter={q:'',tier:0,review:!f.review}; viewPeople(); };
window.pLoc=k=>{ window._pfilter={q:k,tier:0}; localStorage.setItem('warmly.pview','area'); go('people'); };
function overdueScore(c){ if(!c.cadence) return -1e9; const nd=nextDue(c); if(!nd) return -1e9; return (today()-nd)/86400000; }
function lastTs(c){ const l=(c.log||[]).slice(-1)[0]; if(l&&l.date) return Date.parse(l.date)||0; return c.lastContacted?(Date.parse(c.lastContacted)||0):0; }
/* ---- quick actions: 3-dot menu + swipe, act without opening the page ---- */
function kebab(id){ return '<button class="kebab" onclick="event.stopPropagation();actions(\''+id+'\')" aria-label="more"><svg viewBox="0 0 4 16" width="4" height="16"><circle cx="2" cy="2" r="1.7"/><circle cx="2" cy="8" r="1.7"/><circle cx="2" cy="14" r="1.7"/></svg></button>'; }
window.actions=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return;
  let h='<button class="x" onclick="closeModal()">&times;</button><h3>'+esc(c.name)+'</h3>';
  const sub=c.location||c.company||c.context||''; if(sub) h+='<div class="sub" style="margin-bottom:12px">'+esc(sub)+'</div>';
  h+='<div class="btn-row">';
  if(c.phone) h+='<button class="btn wa sm" onclick="closeModal();compose(\''+id+'\',\'reconnect\')">Message</button>';
  h+='<button class="btn ghost sm" onclick="logToday(\''+id+'\')">Log call today</button>';
  h+='<button class="btn ghost sm" onclick="closeModal();go(\'person\',\''+id+'\')">Open page</button>';
  h+='<button class="btn ghost sm" onclick="closeModal();editContact(\''+id+'\')">Edit</button></div>';
  h+='<div class="kick" style="margin-top:14px">Closeness</div><div class="btn-row">'+[[1,'inner circle'],[2,'keep warm'],[3,'loose tie']].map(([t,l])=>'<button class="btn sm '+(c.tier===t?'primary':'ghost')+'" onclick="setTier(\''+id+'\','+t+');actions(\''+id+'\')">'+l+'</button>').join('')+'</div>';
  h+='<div class="kick" style="margin-top:12px">Reconnect every</div><div class="btn-row">'+[0,3,6,12].map(m=>'<button class="btn sm '+(((c.cadence||0)===m)?'primary':'ghost')+'" onclick="setCad(\''+id+'\','+m+');actions(\''+id+'\')">'+(m?m+' mo':'off')+'</button>').join('')+'</div>';
  h+='<div class="btn-row" style="margin-top:16px"><button class="btn sm" style="background:var(--rose);color:#fff" onclick="delContact(\''+id+'\')">Delete contact</button></div>';
  openModal(h); };
window.delContact=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return; if(!confirm('Delete '+(c.name||'this contact')+'? This removes them everywhere it syncs.')) return; DB.contacts=DB.contacts.filter(x=>x.id!==id); save(); closeModal(); route(); };
window.toggleSwipe=()=>{ localStorage.setItem('warmly.swipe', (localStorage.getItem('warmly.swipe')==='off')?'on':'off'); route(); };
/* ---- the + button: type / speak / scan ---- */
window.fabToggle=()=>{ const m=document.getElementById('fabMenu'),b=document.getElementById('fabBtn'); if(!m) return; const o=m.classList.toggle('open'); b.classList.toggle('open',o); };
function fabClose(){ const m=document.getElementById('fabMenu'),b=document.getElementById('fabBtn'); if(m){ m.classList.remove('open'); b.classList.remove('open'); } }
window.fabPick=(mode)=>{ fabClose(); if(mode==='manual') quickAdd(); else if(mode==='voice') voiceAdd(); else if(mode==='camera'){ const el=document.getElementById('cardCam'); if(el) el.click(); } };
window.voiceAdd=()=>{ const SR=window.SpeechRecognition||window.webkitSpeechRecognition; quickAdd();
  const blob=document.getElementById('qa_blob');
  if(!SR){ if(blob) blob.placeholder='Voice not supported in this browser. Tap the mic on your keyboard to dictate.'; return; }
  const bar=document.getElementById('qaVoice'); if(bar) bar.style.display='flex';
  let finalT='';
  const rec=new SR(); rec.lang='en-US'; rec.interimResults=true; rec.continuous=true; window._rec=rec;
  rec.onresult=(e)=>{ let interim=''; for(let i=e.resultIndex;i<e.results.length;i++){ const r=e.results[i]; if(r.isFinal) finalT+=r[0].transcript+' '; else interim+=r[0].transcript; }
    if(blob) blob.value=(finalT+interim).replace(/\s+/g,' ').trim(); };
  rec.onend=()=>{ const b=document.getElementById('qaVoice'); if(b) b.style.display='none'; window._rec=null; qaParse(); };
  rec.onerror=()=>{ const b=document.getElementById('qaVoice'); if(b) b.style.display='none'; window._rec=null; };
  try{ rec.start(); }catch(e){ if(bar) bar.style.display='none'; window._rec=null; }
};
window.voiceStop=()=>{ if(window._rec){ try{ window._rec.stop(); }catch(e){} } };
window.cardCaptured=(ev)=>{ const f=ev.target.files&&ev.target.files[0]; ev.target.value=''; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{ const img=new Image();
    img.onload=()=>{ const max=720; let w=img.width,h=img.height; if(w>h&&w>max){ h=Math.round(h*max/w); w=max; } else if(h>=w&&h>max){ w=Math.round(w*max/h); h=max; }
      let card=rd.result; try{ const cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h); card=cv.toDataURL('image/jpeg',0.55); }catch(e){}
      const c={id:uid(),customDates:[],log:[],createdAt:new Date().toISOString(),name:'New card',callName:'',tier:2,card:card,review:true};
      DB.contacts.push(c); save(); editContact(c.id);
    };
    img.onerror=()=>{ alert('Could not read that photo.'); };
    img.src=rd.result;
  };
  rd.readAsDataURL(f);
};
window.pSearch=v=>{ window._pfilter=Object.assign(window._pfilter||{tier:0},{q:v}); const list=document.querySelectorAll('.view .card.row'); viewPeople(); const i=$('#pq'); if(i){ i.focus(); i.setSelectionRange(v.length,v.length); } };
window.pTier=t=>{ window._pfilter=Object.assign(window._pfilter||{q:''},{tier:t,review:false}); viewPeople(); };

function viewPerson(id){
  const c=DB.contacts.find(x=>x.id===id); if(!c){ go('people'); return; }
  const occ=contactOccasions(c); const nd=nextDue(c);
  const last=(c.log||[]).slice(-1)[0];
  const work=[c.jobTitle,c.company].filter(Boolean).join(' at ');
  let h='<div class="view"><a class="btn ghost sm" onclick="go(\'people\')">← People</a>';
  /* header: quick glance */
  h+='<div class="card" style="margin-top:14px"><div class="row"><div class="avatar" style="width:56px;height:56px;font-size:22px;background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
    +'<div class="grow"><div class="nm" style="font-size:20px;font-family:var(--serif)">'+esc(c.name)+'</div>'
    +'<div class="sub">'+esc(work||c.context||'')+'</div>'
    +'<div class="sub" style="margin-top:2px">'+(last?('last contacted '+esc(last.date)):'not contacted yet')+(c.activities&&c.activities.length?(' · last activity '+esc(c.activities.slice(-1)[0].date)):'')+'</div></div>'
    +'<span class="pill t'+(c.tier||3)+'">'+({1:'inner circle',2:'keep warm',3:'loose tie'}[c.tier||3])+'</span></div>';
  h+='<div class="chips" style="margin-top:10px">'+(c.tags||[]).map((t,i)=>'<span class="chip on" onclick="delTag(\''+id+'\','+i+')">'+esc(t)+' ×</span>').join('')+'<span class="chip" onclick="addTag(\''+id+'\')">+ tag</span></div>';
  h+='<div class="btn-row" style="margin-top:6px">';
  if(c.phone) h+='<button class="btn ghost sm" onclick="askDetails(\''+id+'\')">Ask for details</button>';
  h+='<button class="btn ghost sm" onclick="logCall(\''+id+'\')">Log a call</button>';
  h+='<button class="btn ghost sm" onclick="editContact(\''+id+'\')">Edit details</button></div></div>';
  h+=reachBar(c);
  h+=socialRow(c,true,true);

  /* quick triage */
  h+='<div class="card"><div class="kick" style="margin-top:0">Quick triage</div><div class="btn-row">'+[[1,'inner circle'],[2,'keep warm'],[3,'loose tie']].map(([t,l])=>'<button class="btn sm '+(c.tier===t?'primary':'ghost')+'" onclick="setTier(\''+id+'\','+t+')">'+l+'</button>').join('')+'</div>'
    +'<div class="btn-row" style="margin-top:8px;align-items:center"><span class="sub" style="margin-right:2px">reconnect every</span>'+[0,3,6,12].map(m=>'<button class="btn sm '+(((c.cadence||0)===m)?'primary':'ghost')+'" onclick="setCad(\''+id+'\','+m+')">'+(m?m+' mo':'off')+'</button>').join('')+'</div></div>';

  /* relationships */
  h+='<div class="card"><div class="kick" style="margin-top:0">The people &amp; pets around them</div>';
  h+='<div class="row between" style="padding:7px 0;border-bottom:0.5px solid var(--line)"><span class="sub">Significant other</span><span style="font-size:14px">'+(c.partner?esc(c.partner.name)+(c.partner.note?' <span class="sub">('+esc(c.partner.note)+')</span>':''):'')+' <a style="color:var(--green-2)" onclick="setPartner(\''+id+'\')">'+(c.partner?'edit':'add')+'</a></span></div>';
  h+='<div class="row between" style="padding:7px 0;border-bottom:0.5px solid var(--line)"><span class="sub">Children</span><span style="font-size:14px">'+((c.children||[]).map(k=>esc(k.name)+(k.age?' ('+esc(k.age)+')':'')).join(', ')||'—')+' <a style="color:var(--green-2)" onclick="addChild(\''+id+'\')">+</a></span></div>';
  h+='<div class="row between" style="padding:7px 0"><span class="sub">Pets</span><span style="font-size:14px">'+((c.pets||[]).map(p=>esc(p.name)+(p.kind?' ('+esc(p.kind)+')':'')).join(', ')||'—')+' <a style="color:var(--green-2)" onclick="addPet(\''+id+'\')">+</a></span></div></div>';

  /* notes timeline */
  h+='<div class="card"><div class="kick" style="margin-top:0">Notes <span class="sub" style="text-transform:none;letter-spacing:0">· private to you</span></div>';
  h+='<textarea id="newnote" placeholder="Add a note about '+esc(firstName(c.name))+'... what they said, what matters to them"></textarea><div class="btn-row" style="margin-top:8px"><button class="btn primary sm" onclick="addNote(\''+id+'\')">Add note</button></div>';
  (c.notes||[]).slice().reverse().forEach(n=>{ h+='<div style="background:var(--bg);border:0.5px solid var(--line);border-radius:12px;padding:12px;margin-top:10px"><div class="row between"><span class="sub">'+(n.fav?'★ ':'')+esc(n.date)+'</span><span style="font-size:13px"><a style="color:var(--green-2)" onclick="favNote(\''+id+'\',\''+n.id+'\')">'+(n.fav?'unstar':'star')+'</a> · <a style="color:var(--rose)" onclick="delNote(\''+id+'\',\''+n.id+'\')">delete</a></span></div><div style="margin-top:6px">'+esc(n.text)+'</div></div>'; });
  h+='</div>';

  /* details */
  h+='<div class="card"><div class="kick" style="margin-top:0">Details</div>';
  h+=detailRow('Phone',c.phone||'—'); h+=detailRow('Email',c.email||'—');
  h+=detailRow('LinkedIn', c.linkedin?'<a style="color:var(--green-2)" target="_blank" rel="noopener" href="'+esc(c.linkedin)+'">profile ↗</a>':'—');
  h+=detailRow('Address', c.address?esc(c.address):'—');
  h+=detailRow('How we met', c.howMet?esc(c.howMet):'—');
  h+=detailRow('Work', work?esc(work):'—');
  h+=detailRow('Food / drink', c.food?esc(c.food):'—');
  occ.forEach(o=>{ const age=o.raw.y?(' (turns '+(o.date.getFullYear()-o.raw.y)+')'):''; h+=detailRow(o.label[0].toUpperCase()+o.label.slice(1), fmtDate(o.date)+esc(age)+' · '+whenLabel(daysUntil(o.date))+' <a style="color:var(--green-2)" onclick="addCal(\''+id+'\','+(o.date.getMonth()+1)+','+o.date.getDate()+',\''+jsq(o.label)+'\')">+ cal</a>'); });
  h+=detailRow('Keep in touch', c.cadence?('every '+c.cadence+' months'+(nd?(' · next '+(nd<=today()?'now':fmtDate(nd))):'')):'not set');
  h+='</div>';

  /* reminders */
  h+='<div class="card"><div class="row between"><div class="kick" style="margin-top:0">Reminders</div><button class="btn ghost sm" onclick="addRemind(\''+id+'\')">+ Add</button></div>';
  if(c.bday&&c.bday.m) h+=detailRow(occShape('birthday',22)+' Wish happy birthday', MONTHS[c.bday.m]+' '+c.bday.d+' · every year');
  (c.customDates||[]).forEach((cd,i)=>h+=detailRow(esc(cd.label||'reminder'), MONTHS[cd.m]+' '+cd.d+' · yearly <a style="color:var(--rose)" onclick="delRemind(\''+id+'\','+i+')">×</a>'));
  if(!(c.bday&&c.bday.m)&&!(c.customDates||[]).length) h+='<div class="muted">No reminders yet. Birthdays add one automatically.</div>';
  h+='</div>';

  /* calls & activities */
  h+='<div class="card"><div class="row between"><div class="kick" style="margin-top:0">Calls &amp; activities</div><button class="btn ghost sm" onclick="addActivity(\''+id+'\')">+ Activity</button></div>';
  const tl=[].concat((c.log||[]).map(l=>({d:l.date,t:(l.type==='call'?'Call':'Contacted'),n:l.note})),(c.activities||[]).map(a=>({d:a.date,t:a.text,n:''}))).sort((x,y)=>(y.d||'').localeCompare(x.d||''));
  if(!tl.length) h+='<div class="muted">Nothing logged. Log a call you had, or an activity you did together.</div>';
  tl.forEach(e=>h+='<div class="row between" style="padding:8px 0;border-bottom:0.5px solid var(--line)"><span style="font-size:14px">'+esc(e.t)+(e.n?' <span class="sub">— '+esc(e.n)+'</span>':'')+'</span><span class="sub">'+esc(e.d)+'</span></div>');
  h+='</div>';

  /* tasks */
  h+='<div class="card"><div class="kick" style="margin-top:0">Tasks</div>';
  (c.tasks||[]).forEach(t=>h+='<div class="row" style="padding:5px 0"><input type="checkbox" '+(t.done?'checked':'')+' onchange="toggleTask(\''+id+'\',\''+t.id+'\')" style="width:18px;height:18px;flex:0 0 auto"><span class="grow" style="'+(t.done?'text-decoration:line-through;color:var(--ink-faint)':'')+'">'+esc(t.text)+'</span><a class="sub" style="color:var(--rose)" onclick="delTask(\''+id+'\',\''+t.id+'\')">×</a></div>');
  h+='<div class="row" style="margin-top:8px;gap:8px"><input id="newtask" placeholder="Add a task, e.g. buy flowers for his birthday"><button class="btn primary sm" onclick="addTask(\''+id+'\')">Add</button></div></div>';

  /* gifts */
  h+='<div class="card"><div class="row between"><div class="kick" style="margin-top:0">Gifts</div><button class="btn ghost sm" onclick="addGift(\''+id+'\')">+ Gift</button></div>';
  if(!(c.gifts||[]).length) h+='<div class="muted">Gift ideas you have, or gifts you have given.</div>';
  (c.gifts||[]).forEach(g=>h+='<div class="row between" style="padding:6px 0;border-bottom:0.5px solid var(--line)"><span style="font-size:14px">'+(g.status==='idea'?'💡 ':'🎁 ')+esc(g.desc)+(g.amount?' <span class="sub">'+esc(g.amount)+'</span>':'')+'</span><span class="sub">'+esc(g.date||(g.status==='idea'?'idea':''))+' <a style="color:var(--rose)" onclick="delGift(\''+id+'\',\''+g.id+'\')">×</a></span></div>');
  h+='</div>';

  /* money / debts */
  h+='<div class="card"><div class="row between"><div class="kick" style="margin-top:0">Money</div><button class="btn ghost sm" onclick="addDebt(\''+id+'\')">+ Add</button></div>';
  if(!(c.debts||[]).length) h+='<div class="muted">Track if you owe them, or they owe you.</div>';
  (c.debts||[]).forEach(d=>h+='<div class="row between" style="padding:6px 0;border-bottom:0.5px solid var(--line)"><span style="font-size:14px">'+(d.dir==='owe'?'You owe ':'You are owed ')+'<b>'+esc(d.amount)+'</b>'+(d.note?' <span class="sub">'+esc(d.note)+'</span>':'')+'</span><a class="sub" style="color:var(--rose)" onclick="delDebt(\''+id+'\',\''+d.id+'\')">×</a></div>');
  h+='</div>';

  h+='</div>'; render(h);
}
function detailRow(k,v){ return '<div class="row between" style="padding:8px 0;border-bottom:0.5px solid var(--line)"><span class="sub">'+k+'</span><span style="text-align:right;font-size:14px">'+v+'</span></div>'; }
window.saveCtx=(id,v)=>{ const c=DB.contacts.find(x=>x.id===id); if(c){ c.context=v; save(); } };
/* ---- rich-detail handlers (relationships, notes, activities, tasks, gifts, debts, reminders) ---- */
function patch(id,fn){ const c=DB.contacts.find(x=>x.id===id); if(c){ fn(c); save(); route(); } }
const TODAYISO=()=>new Date().toISOString().slice(0,10);
window.addTag=id=>{ const t=prompt('Tag (e.g. the office, uni, climbing):'); if(t&&t.trim()) patch(id,c=>{ c.tags=c.tags||[]; c.tags.push(t.trim()); }); };
window.delTag=(id,i)=>patch(id,c=>{ (c.tags||[]).splice(i,1); });
window.setPartner=id=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return; const name=prompt('Significant other name (blank to remove):', c.partner?c.partner.name:''); if(name===null) return; if(!name.trim()){ patch(id,x=>x.partner=null); return; } const note=prompt('A note (optional, e.g. married 2021):', c.partner?(c.partner.note||''):'')||''; patch(id,x=>x.partner={name:name.trim(),note}); };
window.addChild=id=>{ const name=prompt("Child's name:"); if(!name||!name.trim()) return; const age=prompt('Age (optional):')||''; patch(id,c=>{ c.children=c.children||[]; c.children.push({name:name.trim(),age}); }); };
window.addPet=id=>{ const name=prompt("Pet's name:"); if(!name||!name.trim()) return; const kind=prompt('Type (dog, cat...):')||''; patch(id,c=>{ c.pets=c.pets||[]; c.pets.push({name:name.trim(),kind}); }); };
window.addNote=id=>{ const el=document.getElementById('newnote'); const t=(el?el.value:'').trim(); if(!t) return; patch(id,c=>{ c.notes=c.notes||[]; c.notes.push({id:uid(),date:TODAYISO(),text:t,fav:false}); }); };
window.delNote=(id,nid)=>patch(id,c=>{ c.notes=(c.notes||[]).filter(n=>n.id!==nid); });
window.favNote=(id,nid)=>patch(id,c=>{ (c.notes||[]).forEach(n=>{ if(n.id===nid) n.fav=!n.fav; }); });
window.logCall=id=>{ const note=prompt('What did you talk about? (optional)')||''; patch(id,c=>{ c.log=c.log||[]; c.log.push({date:TODAYISO(),type:'call',note}); c.lastContacted=TODAYISO(); }); };
window.addActivity=id=>{ const t=prompt('What did you do together? (e.g. went skiing)'); if(!t||!t.trim()) return; const d=prompt('Date (YYYY-MM-DD):',TODAYISO())||TODAYISO(); patch(id,c=>{ c.activities=c.activities||[]; c.activities.push({id:uid(),date:d,text:t.trim()}); }); };
window.addTask=id=>{ const el=document.getElementById('newtask'); let t=(el?el.value:'').trim(); if(!t) t=(prompt('Task:')||'').trim(); if(!t) return; patch(id,c=>{ c.tasks=c.tasks||[]; c.tasks.push({id:uid(),text:t,done:false}); }); };
window.toggleTask=(id,tid)=>patch(id,c=>{ (c.tasks||[]).forEach(t=>{ if(t.id===tid) t.done=!t.done; }); });
window.delTask=(id,tid)=>patch(id,c=>{ c.tasks=(c.tasks||[]).filter(t=>t.id!==tid); });
window.addGift=id=>{ const desc=prompt('Gift (an idea, or one you gave):'); if(!desc||!desc.trim()) return; const given=confirm('Already given it?  OK = given,  Cancel = just an idea'); const amount=prompt('Value (optional, e.g. £30):')||''; const date=given?(prompt('Date given (YYYY-MM-DD):',TODAYISO())||''):''; patch(id,c=>{ c.gifts=c.gifts||[]; c.gifts.push({id:uid(),desc:desc.trim(),amount,status:given?'given':'idea',date}); }); };
window.delGift=(id,gid)=>patch(id,c=>{ c.gifts=(c.gifts||[]).filter(g=>g.id!==gid); });
window.addDebt=id=>{ const owe=confirm('Who owes whom?  OK = YOU owe them,  Cancel = THEY owe you'); const amount=prompt('Amount (e.g. £20):'); if(!amount||!amount.trim()) return; const note=prompt('What for? (optional)')||''; patch(id,c=>{ c.debts=c.debts||[]; c.debts.push({id:uid(),dir:owe?'owe':'owed',amount:amount.trim(),note}); }); };
window.delDebt=(id,did)=>patch(id,c=>{ c.debts=(c.debts||[]).filter(d=>d.id!==did); });
window.addRemind=id=>{ const label=prompt('Reminder (e.g. their work anniversary):'); if(!label||!label.trim()) return; const ds=prompt('Date each year as MM-DD (e.g. 03-04):'); const p=parseDateStr('--'+(ds||'')); if(!p){ alert('Please use MM-DD, e.g. 03-04'); return; } patch(id,c=>{ c.customDates=c.customDates||[]; c.customDates.push({label:label.trim(),m:p.m,d:p.d}); }); };
window.delRemind=(id,i)=>patch(id,c=>{ (c.customDates||[]).splice(i,1); });

/* ---------- import ---------- */
function viewImport(){
  let h='<div class="view"><h1 class="title">Import contacts</h1><p class="muted">Bring people in from your phone, a Google CSV, or a vCard. Everything stays on this device, and you pick exactly who to keep.</p>';
  const hasPicker = !!(navigator.contacts && navigator.contacts.select);
  if(hasPicker){
    h+='<div class="card" style="text-align:center;padding:24px"><button class="btn primary block" onclick="pickContacts()">Import from this phone&rsquo;s contacts</button><div class="muted" style="margin-top:10px;font-size:12.5px">Opens your address book (including SIM contacts saved to the phone) so you can pick who to add. Nothing is read until you choose.</div></div>';
  } else {
    h+='<div class="note">On iPhone, browsers can&rsquo;t read your address book directly (Apple blocks it for privacy) and the SIM isn&rsquo;t reachable from the web. Quickest route: open <b>iCloud.com &rarr; Contacts</b> &rarr; select all &rarr; <b>Export vCard</b>, then drop that <b>.vcf</b> below. (Or use the iOS <b>Shortcuts</b> app to export contacts to a file.)</div>';
  }
  h+='<div class="card" style="text-align:center;padding:30px"><input type="file" id="file" accept=".csv,.vcf,.vcard,text/csv,text/vcard" onchange="onFile(event)" style="display:none"><button class="'+(hasPicker?'btn ghost':'btn primary')+'" onclick="document.getElementById(\'file\').click()">Choose a file (CSV or vCard)</button>'
    +'<div class="muted" style="margin-top:12px">In Google Contacts: Export &rarr; Google CSV. On iPhone: export a .vcf as above.</div></div>';
  h+='<div id="preview"></div></div>'; render(h);
}
window.onFile=(ev)=>{ const f=ev.target.files[0]; if(!f) return; const rd=new FileReader();
  rd.onload=()=>{ const text=rd.result; const rows = /vcard|vcf/i.test(f.name)? parseVCF(text) : parseCSV(text);
    window._imp=rows.map(r=>Object.assign({_keep:true,_tier:2},r)); renderPreview(); };
  rd.readAsText(f);
};
window.pickContacts=async()=>{
  if(!(navigator.contacts && navigator.contacts.select)){ alert('This browser cannot read device contacts. Use the file option instead.'); return; }
  try{
    let props=['name','tel'];
    try{ const sup=await navigator.contacts.getProperties(); if(sup.includes('email')) props.push('email'); }catch(e){}
    const sel=await navigator.contacts.select(props,{multiple:true});
    if(!sel||!sel.length) return;
    const rows=sel.map(c=>({ name:(c.name&&c.name[0])||((c.tel&&c.tel[0])||''), phone:(c.tel&&c.tel[0])||'', email:(c.email&&c.email[0])||'', bday:null, context:'' })).filter(r=>r.name||r.phone);
    if(!rows.length){ alert('No usable contacts were selected.'); return; }
    window._imp=rows.map(r=>Object.assign({_keep:true,_tier:2},r)); renderPreview();
    const pv=document.getElementById('preview'); if(pv) pv.scrollIntoView({behavior:'smooth'});
  }catch(e){ /* user cancelled the picker */ }
};
function renderPreview(){
  const rows=window._imp||[]; const box=$('#preview');
  if(!rows.length){ box.innerHTML='<div class="empty">Could not read any contacts from that file. Try a Google CSV or a .vcf.</div>'; return; }
  let h='<div class="kick">Found '+rows.length+' contacts · tick who to keep, set how close</div>';
  h+='<div class="note">Tip: only import people you actually want to stay warm with. You can always add more later.</div>';
  h+='<div class="row between" style="margin:8px 0"><button class="btn ghost sm" onclick="impAll(true)">Select all</button><button class="btn ghost sm" onclick="impAll(false)">None</button><button class="btn primary sm" onclick="doImport()">Import selected</button></div>';
  h+='<div style="overflow-x:auto"><table class="tbl"><thead><tr><th></th><th>Name</th><th>Phone</th><th>Birthday</th><th>Closeness</th></tr></thead><tbody>';
  rows.forEach((r,i)=>{ h+='<tr><td><input type="checkbox" '+(r._keep?'checked':'')+' onchange="impSet('+i+',\'_keep\',this.checked)"></td>'
    +'<td>'+esc(r.name)+'</td><td>'+esc(r.phone||'—')+'</td><td>'+(r.bday?(MONTHS[r.bday.m]+' '+r.bday.d):'—')+'</td>'
    +'<td><select onchange="impSet('+i+',\'_tier\',+this.value)"><option value="1"'+(r._tier===1?' selected':'')+'>inner</option><option value="2"'+(r._tier===2?' selected':'')+'>warm</option><option value="3"'+(r._tier===3?' selected':'')+'>loose</option></select></td></tr>'; });
  h+='</tbody></table></div>'; box.innerHTML=h;
}
window.impSet=(i,k,v)=>{ window._imp[i][k]=v; };
window.impAll=(v)=>{ window._imp.forEach(r=>r._keep=v); renderPreview(); };
window.doImport=()=>{ const keep=(window._imp||[]).filter(r=>r._keep); if(!keep.length){ alert('Tick at least one contact.'); return; }
  let added=0;
  keep.forEach(r=>{ DB.contacts.push({ id:uid(), name:r.name, phone:r.phone||'', email:r.email||'', linkedin:r.linkedin||'', context:r.context||'', tier:r._tier||2, bday:r.bday||null, anniv:null, customDates:[], cadence:r._tier===1?3:r._tier===2?6:null, lastContacted:null, log:[], createdAt:new Date().toISOString() }); added++; });
  save(); window._imp=null; alert('Imported '+added+' contacts. Set their birthdays/cadence anytime.'); go('people');
};

/* ---------- templates ---------- */
function viewTemplates(){
  let h='<div class="view"><div class="row between"><h1 class="title">Message templates</h1><button class="btn primary sm" onclick="addTemplate()">+ New</button></div><p class="muted">Write these once, in your voice. {first} becomes their calling name, {me} your name. You always edit before sending.</p>';
  DB.templates.forEach(t=>{ const def=['t_b','t_a','t_r'].indexOf(t.id)>=0;
    h+='<div class="card"><div class="row between"><div class="kick" style="margin-top:0">'+esc(t.name)+' · '+esc(t.occasion)+'</div>'+(def?'':'<a class="sub" style="color:var(--rose);cursor:pointer" onclick="delTemplate(\''+t.id+'\')">delete</a>')+'</div><textarea oninput="tplSet(\''+t.id+'\',this.value)">'+esc(t.body)+'</textarea></div>'; });
  h+='</div>'; render(h);
}
window.tplSet=(id,v)=>{ const t=DB.templates.find(x=>x.id===id); if(t){ t.body=v; save(); } };
window.addTemplate=()=>{ let h='<button class="x" onclick="closeModal()">&times;</button><h3>New template</h3>';
  h+='<label class="fl">Name</label><input id="t_name" placeholder="e.g. Festival wishes">';
  h+='<label class="fl">When it is for</label><select id="t_occ"><option value="reconnect">reconnect</option><option value="birthday">birthday</option><option value="anniversary">anniversary</option><option value="custom">custom</option></select>';
  h+='<label class="fl">Message &middot; {first} = their name, {me} = you</label><textarea id="t_body" style="min-height:110px" placeholder="Hey {first}, ..."></textarea>';
  h+='<div class="btn-row" style="margin-top:14px"><button class="btn primary block" onclick="saveTemplate()">Save template</button></div>';
  openModal(h); };
window.saveTemplate=()=>{ const name=$('#t_name').value.trim()||'My template'; const occasion=$('#t_occ').value; const body=$('#t_body').value.trim(); if(!body){ alert('Write the message first.'); return; } DB.templates.push({id:uid(),name:name,occasion:occasion,body:body}); save(); closeModal(); go('templates'); };
window.delTemplate=(id)=>{ if(['t_b','t_a','t_r'].indexOf(id)>=0) return; if(!confirm('Delete this template?')) return; DB.templates=DB.templates.filter(t=>t.id!==id); save(); route(); };

/* ---------- settings + backup ---------- */
/* ---- My Card: your shareable profile + offline QR (nothing leaves the phone) ---- */
let _qrT=null;
function myVCard(){ const me=DB.me||{}; const L=['BEGIN:VCARD','VERSION:3.0','FN:'+(me.name||'')];
  if(me.title) L.push('TITLE:'+me.title);
  if(me.phone) L.push('TEL;TYPE=CELL:'+me.phone);
  if(me.email) L.push('EMAIL:'+me.email);
  if(me.website) L.push('URL:'+_abs(me.website));
  if(me.linkedin) L.push('URL:'+liUrl(me.linkedin));
  if(me.instagram) L.push('URL:https://instagram.com/'+_handle(me.instagram));
  if(me.x) L.push('URL:https://x.com/'+_handle(me.x));
  L.push('END:VCARD'); return L.join('\n');
}
function myVCardFull(){ const me=DB.me||{}; let v=myVCard();
  if(me.photo){ const b=me.photo.replace(/^data:[^,]+,/,''); v=v.replace('END:VCARD','PHOTO;ENCODING=b;TYPE=JPEG:'+b+'\nEND:VCARD'); }
  return v;
}
function renderQR(text, el){ if(!el) return; const q=window.QR&&QR.matrix(text);
  if(!q){ el.innerHTML='<div class="muted" style="text-align:center;padding:20px">Your card has a lot of links. Remove one or two so it fits a QR (Share and .vcf still include everything).</div>'; return; }
  const n=q.size, quiet=4, total=n+quiet*2, scale=Math.max(3,Math.floor(264/total));
  const cv=document.createElement('canvas'); cv.width=cv.height=total*scale; const ctx=cv.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,cv.width,cv.height); ctx.fillStyle='#000';
  for(let r=0;r<n;r++) for(let c=0;c<n;c++){ if(q.modules[r][c]) ctx.fillRect((c+quiet)*scale,(r+quiet)*scale,scale,scale); }
  cv.className='qrcanvas'; el.innerHTML=''; el.appendChild(cv);
}
window.setMe=(k,v)=>{ DB.me=DB.me||{}; DB.me[k]=v; save(); clearTimeout(_qrT); _qrT=setTimeout(()=>{ const el=document.getElementById('qrbox'); if(el) renderQR(myVCard(), el); },400); };
window.mePhoto=(ev)=>{ const f=ev.target.files&&ev.target.files[0]; ev.target.value=''; if(!f) return;
  const rd=new FileReader(); rd.onload=()=>{ const img=new Image();
    img.onload=()=>{ const s=Math.min(1,256/Math.max(img.width,img.height)); const w=Math.round(img.width*s), h=Math.round(img.height*s); const cv=document.createElement('canvas'); cv.width=w; cv.height=h; cv.getContext('2d').drawImage(img,0,0,w,h); DB.me=DB.me||{}; try{ DB.me.photo=cv.toDataURL('image/jpeg',0.6); }catch(e){ DB.me.photo=rd.result; } save(); route(); };
    img.onerror=()=>alert('Could not read that photo.'); img.src=rd.result; }; rd.readAsDataURL(f);
};
window.shareCard=async()=>{ const full=myVCardFull();
  try{ const file=new File([full],'warmly-card.vcf',{type:'text/vcard'}); if(navigator.canShare && navigator.canShare({files:[file]})){ await navigator.share({files:[file], title:(DB.me&&DB.me.name)||'My card'}); return; } }catch(e){}
  try{ if(navigator.share){ await navigator.share({title:'My contact card', text:myVCard()}); return; } }catch(e){}
  downloadCard();
};
window.downloadCard=()=>download('warmly-card.vcf', new Blob([myVCardFull()],{type:'text/vcard'}));
let _editCard=false;
const CARDSTYLES=['lava','oil','marble','ember','aurora','royal'];
window.setCardStyle=(s)=>{ DB.me=DB.me||{}; DB.me.cardStyle=s; save(); route(); };
window.toggleEditCard=()=>{ _editCard=!_editCard; route(); if(_editCard) setTimeout(()=>{ const e=document.getElementById('cardedit'); if(e) e.scrollIntoView({behavior:'smooth',block:'center'}); },60); };
window.saveCard=()=>{ _editCard=false; route(); };
function interestIcon(w){ w=w.toLowerCase(); const M=[
  [/anime|manga|otaku/, '<path d="M5 8c2-3 12-3 14 0M4 11c0 5 4 9 8 9s8-4 8-9"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>'],
  [/dog|pup|cat|pet/, '<circle cx="6" cy="9" r="1.5"/><circle cx="18" cy="9" r="1.5"/><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><path d="M12 11c-3 0-5 2-5 4s2 3 5 3 5-1 5-3-2-4-5-4z"/>'],
  [/plant|garden|nature|tree|green/, '<path d="M12 21V9M12 13C8 13 6 10 6 6c4 0 6 3 6 7zM12 11c4 0 6-2 6-6-4 0-6 2-6 6z"/>'],
  [/music|guitar|sing|song|dj|piano/, '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'],
  [/travel|trip|wander|explore|fly/, '<path d="M2 22l20-10L2 2v7l14 3-14 3z"/>'],
  [/coffee|tea|cafe|chai/, '<path d="M4 9h13v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM17 10h2a2 2 0 0 1 0 4h-2"/>'],
  [/gym|fitness|lift|workout|muscle/, '<path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/>'],
  [/run|marathon|jog/, '<circle cx="14" cy="5" r="1.6"/><path d="M5 20l3-4 3 1 1-5 3 3 3 1"/>'],
  [/art|paint|draw|design/, '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2 0-1.5 1-2 2.5-2H18a3 3 0 0 0 3-3c0-5-4-9-9-9z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="16" cy="11" r="1"/>'],
  [/game|gaming|gamer|xbox|playstation/, '<rect x="3" y="8" width="18" height="9" rx="4"/><path d="M7 12h3M8.5 10.5v3"/><circle cx="16" cy="11.5" r="0.8"/><circle cx="18" cy="13.5" r="0.8"/>'],
  [/book|read|novel|writ/, '<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>'],
  [/film|movie|cinema|netflix/, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>'],
  [/food|cook|chef|eat|foodie/, '<path d="M5 3v8a2 2 0 0 0 4 0V3M7 3v18M14 3c-1 2-1 5 1 6v12"/>'],
  [/photo|camera|shoot/, '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7l1.5-2h5L16 7"/><circle cx="12" cy="13" r="3.2"/>']
];
  for(var i=0;i<M.length;i++){ if(M[i][0].test(w)) return '<svg viewBox="0 0 24 24">'+M[i][1]+'</svg>'; }
  return '';
}
function bizTags(me){ if(!me||!me.interests) return ''; const items=String(me.interests).split(',').map(s=>s.trim()).filter(Boolean).slice(0,6);
  if(!items.length) return '';
  return '<div class="biz-tags">'+items.map(function(w){ return '<span class="biz-tag">'+interestIcon(w)+esc(w)+'</span>'; }).join('')+'</div>';
}
function viewMyCard(){ const me=DB.me=DB.me||{}; const style=me.cardStyle||'ember';
  const pseudo={id:'me',name:me.name,phone:me.phone,email:me.email,linkedin:me.linkedin,instagram:me.instagram,x:me.x,website:me.website};
  let h='<div class="view"><h1 class="title">My Card</h1><p class="muted">Your funky, shareable card. Anyone can scan the QR to save you. Nothing leaves your phone.</p>';
  h+='<div class="biz mc-'+style+'"><button class="biz-edit" onclick="toggleEditCard()" aria-label="edit card"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>'
    +'<div class="biz-photo" onclick="document.getElementById(\'mephoto\').click()">'+(me.photo?('<img src="'+me.photo+'">'):esc(initials(me.name||'You')))+'</div>'
    +'<div class="biz-name">'+esc(me.name||'Your name')+'</div>'
    +'<div class="biz-title">'+esc(me.title||'tap the pencil to fill your card')+'</div>'
    +bizTags(me)
    +socialRow(pseudo,false)+'</div>';
  h+='<input type="file" id="mephoto" accept="image/*" style="display:none" onchange="mePhoto(event)">';
  h+='<div class="biz-styles">'+CARDSTYLES.map(function(s){ return '<button class="biz-sw mc-'+s+(style===s?' on':'')+'" onclick="setCardStyle(\''+s+'\')" title="'+s+'"></button>'; }).join('')+'</div>';
  h+='<div class="qrwrap"><div id="qrbox" class="qrbox"></div><div class="muted" style="text-align:center;font-size:12px;margin-top:6px">Point a phone camera at this to save me. Test-scan once to confirm.</div></div>';
  h+='<div class="btn-row" style="justify-content:center;margin:12px 0 16px"><button class="btn primary" onclick="shareCard()">Share my card</button><button class="btn ghost" onclick="downloadCard()">Download .vcf</button></div>';
  if(_editCard){
    h+='<div id="cardedit" class="kick">Fill your details</div><div class="card">';
    [['name','Name'],['title','Title / what you do'],['interests','Interests / your vibe (comma separated, e.g. anime, coffee, dogs)'],['phone','Phone (with country code)'],['email','Email'],['linkedin','LinkedIn'],['instagram','Instagram'],['x','X / Twitter'],['website','Website']].forEach(function(f){ h+='<label class="fl">'+f[1]+'</label><input value="'+esc(me[f[0]]||'')+'" oninput="setMe(\''+f[0]+'\',this.value)">'; });
    h+='<div class="btn-row" style="margin-top:16px"><button class="btn primary block" onclick="saveCard()">Save card</button></div></div>';
  }
  h+='</div>'; render(h);
  renderQR(myVCard(), document.getElementById('qrbox'));
}
function viewSettings(){
  const s=DB.settings;
  const connected=localStorage.getItem('warmly.gsync')==='1';
  const swon=localStorage.getItem('warmly.swipe')!=='off';
  let h='<div class="view"><h1 class="title">Settings</h1>';
  h+='<div class="card"><label class="fl">Your name (for {me} in templates)</label><input value="'+esc(s.myName)+'" oninput="setS(\'myName\',this.value)">';
  h+='<label class="fl">Default country code (for phone numbers without +)</label><input value="'+esc(s.country)+'" oninput="setS(\'country\',this.value.replace(/[^0-9]/g,\'\'))" placeholder="44 for UK, 91 for India">';
  h+='<label class="fl">Remind me this many days before</label><input type="number" min="0" max="14" value="'+(s.leadDays)+'" oninput="setS(\'leadDays\',+this.value)"></div>';
  h+='<div class="kick">Your calendar · the important bit</div><div class="card"><div class="muted">Warmly turns every birthday, anniversary and reconnect into events on your Google Calendar, so your calendar nudges you even when this app is closed. Your time is your only currency, this protects it.</div><div class="btn-row" style="margin-top:12px"><button class="btn primary" onclick="exportICS()">Add all my dates to Google Calendar</button></div><div class="muted" style="margin-top:10px;font-size:12.5px">Downloads one calendar file. On your phone or laptop, open it and add it to Google Calendar (or Google Calendar &rarr; Settings &rarr; Import). Each event has a reminder and a tap-to-WhatsApp link. New people you add later: tap "+ cal" on their page, or re-export. Your contacts themselves now sync across your devices, see &ldquo;Sync&rdquo; below.</div></div>';
  h+='<div class="kick">Sync across your devices</div><div class="card"><div class="muted">Link your Google account once on each device. Warmly keeps a private copy in a hidden folder of <b>your own</b> Google Drive (invisible in your Drive, app-only) and syncs automatically. No Warmly server ever touches your contacts. The synced copy isn&rsquo;t password-encrypted (your exported backup is), but it lives in a hidden app-only folder only your Google account can open.</div>'
    +'<div class="btn-row" style="margin-top:12px">'+(connected?'<button class="btn primary sm" onclick="syncNow()">Sync now</button><button class="btn ghost sm" onclick="gDisconnect()">Disconnect</button>':'<button class="btn primary sm" onclick="gConnect()">Sign in with Google</button>')+'</div>'
    +'<div id="gstat" class="muted" style="margin-top:10px;font-size:12.5px">'+(connected?'Connected · auto-syncs on changes':'Not connected')+'</div></div>';
  h+='<div class="kick">Backup &amp; move to another device</div><div class="card"><div class="muted">Your data lives only in this browser. Export an encrypted backup file to keep it safe or move it to your laptop/phone.</div>'
    +'<div class="btn-row" style="margin-top:12px"><button class="btn primary sm" onclick="exportEnc()">Encrypted backup</button><button class="btn ghost sm" onclick="exportJSON()">Plain JSON</button>'
    +'<button class="btn ghost sm" onclick="document.getElementById(\'imp\').click()">Restore backup</button><input type="file" id="imp" accept=".kith,.json" style="display:none" onchange="importFile(event)"></div></div>';
  h+='<div class="kick">Gestures</div><div class="card"><div class="row between"><div class="grow"><div class="nm" style="font-size:15px">Swipe for quick actions</div><div class="sub">Swipe left on anyone to open Message, triage and Delete. The 3-dot button does the same.</div></div><button class="btn sm '+(swon?'primary':'ghost')+'" onclick="toggleSwipe()">'+(swon?'On':'Off')+'</button></div></div>';
  h+=lockSection();
  h+='<div class="kick">Danger zone</div><div class="card"><button class="btn ghost sm" style="color:var(--rose)" onclick="wipe()">Erase everything on this device</button></div>';
  h+='<div class="muted" style="margin-top:24px;font-size:12.5px">Warmly v'+VERSION+' · built '+BUILT+' · '+DB.contacts.length+' contacts · all local, no tracking.</div></div>'; render(h);
}
window.setS=(k,v)=>{ DB.settings[k]=v; save(); };
window.wipe=()=>{ if(confirm('Erase ALL contacts and notes on this device? Export a backup first if unsure.')){ DB={ v:1, contacts:[], templates:DEFAULT_TEMPLATES.slice(), settings:DB.settings }; save(); go('today'); } };
function download(name,blob){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); }
window.exportJSON=()=>download('warmly-backup.json', new Blob([JSON.stringify(DB,null,2)],{type:'application/json'}));
/* ---- Google Calendar export (.ics): the keystone. Your calendar is your source of truth. ---- */
function icsEsc(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;'); }
function icsFold(l){ let o=''; while(l.length>72){ o+=l.slice(0,72)+'\r\n '; l=l.slice(72); } return o+l; }
function icsYMD(d){ return d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0'); }
function icsEvent(uid,date,rrule,summary,desc,trigger){
  const end=new Date(date.getTime()+86400000);
  const L=['BEGIN:VEVENT','UID:'+uid,'DTSTART;VALUE=DATE:'+icsYMD(date),'DTEND;VALUE=DATE:'+icsYMD(end)];
  if(rrule) L.push('RRULE:'+rrule);
  L.push('SUMMARY:'+icsEsc(summary)); if(desc) L.push('DESCRIPTION:'+icsEsc(desc)); L.push('TRANSP:TRANSPARENT');
  L.push('BEGIN:VALARM','ACTION:DISPLAY','TRIGGER:'+trigger,'DESCRIPTION:'+icsEsc(summary),'END:VALARM','END:VEVENT');
  return L.map(icsFold).join('\r\n');
}
window.exportICS=()=>{
  const tb=occ=>{ const t=DB.templates.find(x=>x.occasion===occ); return t?t.body:''; };
  const out=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Warmly//Keep in touch//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH']; let n=0;
  DB.contacts.forEach(c=>{
    const fn=callName(c)||c.name||'someone';
    contactOccasions(c).forEach(o=>{
      const sum=(o.type==='birthday'?'Wish '+fn+' a happy birthday':o.type==='anniversary'?fn+"'s anniversary":fn+', '+o.label);
      const msg=o.type==='birthday'?fillTemplate(tb('birthday'),c):o.type==='anniversary'?fillTemplate(tb('anniversary'),c):'';
      const desc=(c.context?c.context+'. ':'')+(c.phone?('Message on WhatsApp: '+waLink(c.phone,msg)):'');
      out.push(icsEvent('warmly-'+c.id+'-'+o.type+'-'+o.raw.m+'-'+o.raw.d+'@warmly.app', o.date, 'FREQ=YEARLY', sum, desc, '-PT15H')); n++;
    });
    if(c.cadence){ const nd=nextDue(c)||today(); const d=nd<today()?today():nd;
      const desc=(c.context?c.context+'. ':'')+(c.phone?('Call or message: '+waLink(c.phone,fillTemplate(tb('reconnect'),c))):'');
      out.push(icsEvent('warmly-'+c.id+'-reconnect@warmly.app', d, 'FREQ=MONTHLY;INTERVAL='+c.cadence, 'Reconnect with '+fn+', keep it warm', desc, 'PT9H')); n++;
    }
  });
  out.push('END:VCALENDAR');
  if(!n){ alert('Add some birthdays, or set a reconnect cadence on a few people, then sync.'); return; }
  download('warmly-calendar.ics', new Blob([out.join('\r\n')],{type:'text/calendar'}));
  alert('Downloaded '+n+' calendar entries. Open the file and add it to Google Calendar, you will get a reminder before every birthday, anniversary and reconnect.');
};
async function deriveKey(pass,salt){ const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:150000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']); }
window.exportEnc=async()=>{ const pass=prompt('Set a passphrase for this backup (remember it, it cannot be recovered):'); if(!pass) return;
  const salt=crypto.getRandomValues(new Uint8Array(16)), iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(pass,salt); const data=new TextEncoder().encode(JSON.stringify(DB));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data));
  const b64=u=>btoa(String.fromCharCode(...u));
  download('kith-backup.kith', new Blob([JSON.stringify({kith:1,salt:b64(salt),iv:b64(iv),data:b64(ct)})],{type:'application/octet-stream'}));
};
window.importFile=(ev)=>{ const f=ev.target.files[0]; if(!f) return; const rd=new FileReader();
  rd.onload=async()=>{ try{ let obj=JSON.parse(rd.result);
      if(obj.kith&&obj.data){ const pass=prompt('Passphrase for this backup:'); if(!pass) return;
        const dec=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
        const key=await deriveKey(pass,dec(obj.salt));
        const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:dec(obj.iv)},key,dec(obj.data));
        obj=JSON.parse(new TextDecoder().decode(pt));
      }
      if(!obj.contacts) throw 0;
      if(confirm('Restore '+obj.contacts.length+' contacts? This replaces what is on this device.')){ DB=obj; save(); go('today'); }
    }catch(e){ alert('Could not read that backup (wrong file or passphrase).'); }
  }; rd.readAsText(f);
};

/* ===================================================================
   MODALS  (edit, compose, calendar, log)
   =================================================================== */
function openModal(html){ $('#modal').innerHTML=html; $('#modalBg').classList.add('show'); }
window.closeModal=()=>{ if(window._rec){ try{ window._rec.stop(); }catch(e){} } $('#modalBg').classList.remove('show'); };
$('#modalBg').addEventListener('click',e=>{ if(e.target.id==='modalBg') closeModal(); });

window.editContact=(id)=>{ const c=id?DB.contacts.find(x=>x.id===id):{tier:2,customDates:[]};
  const dv=o=>o&&o.m?(o.y?o.y+'-':'')+String(o.m).padStart(2,'0')+'-'+String(o.d).padStart(2,'0'):'';
  let h='<button class="x" onclick="closeModal()">&times;</button><h3>'+(id?'Edit':'New')+' contact</h3>';
  if(c.card) h+='<img class="card-img" src="'+c.card+'">';
  if(c.review) h+='<div class="note">Quick-added &mdash; fill the details and Save to clear the review flag.</div>';
  h+='<label class="fl">Name &middot; how you find them, e.g. &ldquo;John from school&rdquo;</label><input id="e_name" value="'+esc(c.name||'')+'">';
  h+='<label class="fl">Calling name &middot; used in your messages (required)</label><input id="e_call" value="'+esc(c.callName||firstName(c.name)||'')+'" placeholder="John">';
  h+='<div class="two"><div><label class="fl">Phone (with country code)</label><input id="e_phone" value="'+esc(c.phone||'')+'" placeholder="+44 7..."></div><div><label class="fl">Closeness</label><select id="e_tier"><option value="1"'+(c.tier===1?' selected':'')+'>inner circle</option><option value="2"'+(c.tier===2?' selected':'')+'>keep warm</option><option value="3"'+(c.tier===3?' selected':'')+'>loose tie</option></select></div></div>';
  h+='<div class="two"><div><label class="fl">Email</label><input id="e_email" value="'+esc(c.email||'')+'"></div><div><label class="fl">LinkedIn URL</label><input id="e_li" value="'+esc(c.linkedin||'')+'"></div></div>';
  h+='<div class="two"><div><label class="fl">Instagram (handle)</label><input id="e_ig" value="'+esc(c.instagram||'')+'" placeholder="username"></div><div><label class="fl">X / Twitter (handle)</label><input id="e_x" value="'+esc(c.x||'')+'" placeholder="username"></div></div>';
  h+='<div class="two"><div><label class="fl">Telegram (handle)</label><input id="e_tg" value="'+esc(c.telegram||'')+'"></div><div><label class="fl">Website</label><input id="e_web" value="'+esc(c.website||'')+'" placeholder="example.com"></div></div>';
  h+='<div class="two"><div><label class="fl">Birthday (YYYY-MM-DD or --MM-DD)</label><input id="e_bday" value="'+dv(c.bday)+'" placeholder="1996-04-21"></div><div><label class="fl">Anniversary</label><input id="e_anniv" value="'+dv(c.anniv)+'"></div></div>';
  h+='<label class="fl">Reconnect every (months, blank = off)</label><input id="e_cad" type="number" min="1" value="'+(c.cadence||'')+'" placeholder="5">';
  h+='<label class="fl">Address</label><input id="e_addr" value="'+esc(c.address||'')+'">';
  h+='<label class="fl">Location for the map (city, country)</label><input id="e_loc" value="'+esc(c.location||'')+'" placeholder="London, UK">';
  h+='<div class="two"><div><label class="fl">Job title</label><input id="e_job" value="'+esc(c.jobTitle||'')+'"></div><div><label class="fl">Company</label><input id="e_co" value="'+esc(c.company||'')+'"></div></div>';
  h+='<div class="two"><div><label class="fl">How you met</label><input id="e_met" value="'+esc(c.howMet||'')+'"></div><div><label class="fl">Food / drink they like</label><input id="e_food" value="'+esc(c.food||'')+'"></div></div>';
  h+='<label class="fl">How you talk to them (tone, nicknames, inside jokes)</label><input id="e_style" value="'+esc(c.style||'')+'" placeholder="casual, call him bro, no emojis">';
  h+='<label class="fl">Quick summary (shown in lists)</label><textarea id="e_ctx" style="min-height:58px">'+esc(c.context||'')+'</textarea>';
  h+='<div class="btn-row" style="margin-top:16px"><button class="btn primary block" onclick="saveContact(\''+(id||'')+'\')">Save</button></div>';
  openModal(h);
};
window.saveContact=(id)=>{ const g=i=>$('#'+i).value.trim();
  let c=id?DB.contacts.find(x=>x.id===id):null;
  if(!c){ c={id:uid(),customDates:[],log:[],createdAt:new Date().toISOString()}; DB.contacts.push(c); }
  c.name=g('e_name')||'Unnamed'; c.callName=g('e_call')||firstName(c.name)||c.name; c.style=g('e_style'); c.review=false; c.phone=g('e_phone'); c.tier=+$('#e_tier').value; c.email=g('e_email'); c.linkedin=g('e_li'); c.instagram=g('e_ig'); c.x=g('e_x'); c.telegram=g('e_tg'); c.website=g('e_web');
  c.bday=parseDateStr(g('e_bday')); c.anniv=parseDateStr(g('e_anniv')); c.cadence=+g('e_cad')||null; c.context=g('e_ctx');
  c.address=g('e_addr'); c.location=g('e_loc'); c.jobTitle=g('e_job'); c.company=g('e_co'); c.howMet=g('e_met'); c.food=g('e_food');
  save(); closeModal(); route();
};
/* ---- Quick add: paste anything, we extract the details ---- */
const _MON={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
/* normalise any one date fragment into YYYY-MM-DD (year known) or --MM-DD (no year) */
function normBday(s){ if(!s) return ''; s=String(s).trim(); const pad=n=>String(n).padStart(2,'0');
  /* numeric slash/dot/dash date, locale-aware: DD/MM by default, MM/DD only if country code is 1 (US/Canada) */
  let sm=s.match(/^([0-9]{1,2})[\/.\-]([0-9]{1,2})(?:[\/.\-]([0-9]{2,4}))?$/);
  if(sm){ let a=+sm[1], b=+sm[2], y=sm[3]?+sm[3]:null, d, mo;
    const usOrder=/^1$/.test((DB.settings&&DB.settings.country)||'');
    if(a>12){ d=a; mo=b; } else if(b>12){ mo=a; d=b; } else if(usOrder){ mo=a; d=b; } else { d=a; mo=b; }
    if(y&&y<100) y=(y>40?1900:2000)+y;
    if(mo>=1&&mo<=12&&d>=1&&d<=31) return (y?y+'-':'--')+pad(mo)+'-'+pad(d);
    return '';
  }
  /* "14 March 1992" / "14 Mar" */
  let mm=s.match(/^([0-9]{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:,?\s+([0-9]{4}))?$/);
  if(mm && _MON[mm[2].slice(0,3).toLowerCase()]) return ((mm[3]?mm[3]+'-':'--'))+pad(_MON[mm[2].slice(0,3).toLowerCase()])+'-'+pad(+mm[1]);
  /* "March 14, 1992" / "Mar 14" */
  let mn=s.match(/^([A-Za-z]{3,9})\s+([0-9]{1,2})(?:st|nd|rd|th)?(?:,?\s+([0-9]{4}))?$/);
  if(mn && _MON[mn[1].slice(0,3).toLowerCase()]) return ((mn[3]?mn[3]+'-':'--'))+pad(_MON[mn[1].slice(0,3).toLowerCase()])+'-'+pad(+mn[2]);
  /* fall back to the strict parser (ISO, etc.) */
  const p=parseDateStr(s); if(p&&p.m&&p.d) return (p.y?p.y+'-':'--')+pad(p.m)+'-'+pad(p.d);
  return '';
}
/* find a birthday anywhere in free text; returns {str (matched text to strip), val (normalised)} */
function findBirthday(t){
  const DATE='([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[\\/.\\-][0-9]{1,2}(?:[\\/.\\-][0-9]{2,4})?|[0-9]{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}(?:,?\\s+[0-9]{4})?|[A-Za-z]{3,9}\\s+[0-9]{1,2}(?:st|nd|rd|th)?(?:,?\\s+[0-9]{4})?)';
  let m=t.match(new RegExp('(?:birthday|bday|b-day|dob|d\\.o\\.b|born)[:\\s]*'+DATE,'i'));
  if(m){ const v=normBday(m[1]); if(v) return {str:m[0], val:v}; }
  m=t.match(/\b[0-9]{4}-[0-9]{2}-[0-9]{2}\b/); if(m){ const v=normBday(m[0]); if(v) return {str:m[0], val:v}; }
  m=t.match(/\b[0-9]{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}(?:,?\s+[0-9]{4})?\b/);
  if(m && _MON[m[0].replace(/^[0-9]{1,2}(?:st|nd|rd|th)?\s+/,'').slice(0,3).toLowerCase()]){ const v=normBday(m[0]); if(v) return {str:m[0], val:v}; }
  m=t.match(/\b[A-Za-z]{3,9}\s+[0-9]{1,2}(?:st|nd|rd|th)?(?:,?\s+[0-9]{4})?\b/);
  if(m && _MON[m[0].slice(0,3).toLowerCase()]){ const v=normBday(m[0]); if(v) return {str:m[0], val:v}; }
  m=t.match(/\b[0-9]{1,2}[\/.][0-9]{1,2}[\/.][0-9]{2,4}\b/); if(m){ const v=normBday(m[0]); if(v) return {str:m[0], val:v}; }
  return {str:'', val:''};
}
function quickParse(t){ t=t||'';
  const email=(t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)||[])[0]||'';
  const linkedin=(t.match(/(https?:\/\/)?(www\.)?linkedin\.com\/[^\s,]+/i)||[])[0]||'';
  const instagram=(t.match(/instagram\.com\/([A-Za-z0-9_.]+)/i)||[])[1]||'';
  const x=(t.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i)||[])[1]||'';
  const telegram=(t.match(/t\.me\/([A-Za-z0-9_]+)/i)||[])[1]||'';
  const bj=findBirthday(t); const bday=bj.val;
  const phone=((bj.str?t.replace(bj.str,' '):t).match(/\+?\d[\d ()\-]{7,}\d/)||[])[0]||'';
  /* website: a generic URL that is not one of the socials or an email domain */
  let clean=t.replace(email,' ')
    .replace(/(https?:\/\/)?(www\.)?linkedin\.com\/[^\s,]+/ig,' ')
    .replace(/(https?:\/\/)?(www\.)?instagram\.com\/[^\s,]+/ig,' ')
    .replace(/(https?:\/\/)?(www\.)?(x|twitter)\.com\/[^\s,]+/ig,' ')
    .replace(/(https?:\/\/)?(www\.)?t\.me\/[^\s,]+/ig,' ')
    .replace(/(https?:\/\/)?(www\.)?facebook\.com\/[^\s,]+/ig,' ');
  const um=clean.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*\.[a-z]{2,}(?:\/[^\s,]*)?/i);
  let website=um?um[0]:''; if(/^(jpg|png|gif|e\.g|i\.e)/i.test(website)) website='';
  let location=''; const low=t.toLowerCase(); for(const k in GEO){ if(k.length>3 && low.indexOf(k)>=0){ location=k; break; } }
  let name=''; const lines=t.split(/[\n,]/).map(x=>x.trim()).filter(Boolean);
  for(const ln of lines){ if(/@|linkedin|instagram|https?:|t\.me|\d{4,}/i.test(ln)) continue; if(/^[A-Za-z][A-Za-z .'\-]{1,40}$/.test(ln)){ name=ln; break; } }
  return {name,email,linkedin,instagram,x,telegram,bday,phone,location,website};
}
window.quickAdd=()=>{ let h='<button class="x" onclick="closeModal()">&times;</button><h3>Quick add</h3>';
  h+='<div class="note">Paste anything &mdash; a signature, a LinkedIn line, "Met Aisha, ESCP Paris, +33..." &mdash; and Warmly pulls out the details. Refine later on their page.</div>';
  h+='<div id="qaVoice" class="voicebar" style="display:none"><span class="vbars"><i></i><i></i><i></i><i></i><i></i></span><span class="vtext">Listening, speak now</span><button class="btn sm" style="background:var(--hero-ink);color:var(--accent)" onclick="voiceStop()">Done</button></div>';
  h+='<textarea id="qa_blob" placeholder="Paste, type, or tap Speak it: name, city, where you met" style="min-height:78px" oninput="qaParse()"></textarea>';
  h+='<div class="qa-chips" id="qaChips"></div>';
  h+='<div class="two"><div><label class="fl">Name</label><input id="qa_name"></div><div><label class="fl">Phone</label><input id="qa_phone"></div></div>';
  h+='<label class="fl">Calling name &middot; used in messages</label><input id="qa_call" placeholder="John">';
  h+='<div class="two"><div><label class="fl">City / location</label><input id="qa_loc"></div><div><label class="fl">Closeness</label><select id="qa_tier"><option value="2">keep warm</option><option value="1">inner circle</option><option value="3">loose tie</option></select></div></div>';
  h+='<label class="fl">Birthday (optional)</label><input id="qa_bday" type="date">';
  h+='<input id="qa_email" type="hidden"><input id="qa_li" type="hidden"><input id="qa_ig" type="hidden"><input id="qa_x" type="hidden"><input id="qa_tg" type="hidden"><input id="qa_web" type="hidden"><input id="qa_bdayraw" type="hidden">';
  h+='<div class="btn-row" style="margin-top:14px"><button class="btn primary block" onclick="quickSave()">Add person</button></div>';
  openModal(h); };
window.qaParse=()=>{ const p=quickParse($('#qa_blob').value);
  if(p.name&&!$('#qa_name').value) $('#qa_name').value=p.name;
  if(p.name&&!$('#qa_call').value) $('#qa_call').value=firstName(p.name);
  if(p.phone&&!$('#qa_phone').value) $('#qa_phone').value=p.phone;
  if(p.location&&!$('#qa_loc').value) $('#qa_loc').value=p.location;
  if(p.email) $('#qa_email').value=p.email; if(p.linkedin) $('#qa_li').value=p.linkedin;
  if(p.instagram) $('#qa_ig').value=p.instagram; if(p.x) $('#qa_x').value=p.x; if(p.telegram) $('#qa_tg').value=p.telegram;
  if(p.website) $('#qa_web').value=p.website;
  if(p.bday){ $('#qa_bdayraw').value=p.bday; if(/^\d{4}-\d{2}-\d{2}$/.test(p.bday)&&$('#qa_bday')) $('#qa_bday').value=p.bday; }
  renderQaChips(p); };
function renderQaChips(p){ const el=document.getElementById('qaChips'); if(!el) return;
  const defs=[['name','Name'],['phone','Phone'],['email','Email'],['bday','Birthday'],['location','City'],['linkedin','LinkedIn'],['instagram','Instagram'],['x','X'],['telegram','Telegram'],['website','Website']];
  let n=0; const chips=defs.map(([k,lb])=>{ const on=!!p[k]; if(on)n++; return '<span class="qchip'+(on?' on':'')+'">'+(on?'&#10003; ':'')+lb+'</span>'; }).join('');
  el.innerHTML = chips + (n?'<div class="qa-found">Found '+n+' detail'+(n>1?'s':'')+' automatically. Check them, then Add.</div>':''); }
window.quickSave=()=>{ const name=$('#qa_name').value.trim(); if(!name){ alert('Add a name first.'); return; }
  const g=i=>{ const el=$('#'+i); return el?el.value.trim():''; };
  const phone=g('qa_phone'), norm=phone?normalizePhone(phone):'', bd=parseDateStr(g('qa_bday')||g('qa_bdayraw'));
  let c=norm? DB.contacts.find(x=>x.id!=='me' && x.phone && normalizePhone(x.phone)===norm) : null;
  if(c){ /* a returned card: merge into the existing contact, fill blanks, never clobber */
    if(!c.name||c.name==='Unnamed') c.name=name;
    if(g('qa_call')) c.callName=g('qa_call');
    if(g('qa_loc')&&!c.location) c.location=g('qa_loc');
    if(g('qa_email')&&!c.email) c.email=g('qa_email');
    if(g('qa_li')&&!c.linkedin) c.linkedin=g('qa_li');
    if(g('qa_ig')&&!c.instagram) c.instagram=g('qa_ig');
    if(g('qa_x')&&!c.x) c.x=g('qa_x');
    if(g('qa_tg')&&!c.telegram) c.telegram=g('qa_tg');
    if(g('qa_web')&&!c.website) c.website=g('qa_web');
    if(bd&&!c.bday) c.bday=bd;
    c.review=false; save(); closeModal(); alert('Updated '+(callName(c)||c.name)+' from their details.'); go('person',c.id); return;
  }
  const nc={id:uid(),customDates:[],log:[],createdAt:new Date().toISOString(),name:name,callName:(g('qa_call')||firstName(name)),phone:phone,location:g('qa_loc'),tier:+$('#qa_tier').value,email:g('qa_email'),linkedin:g('qa_li'),instagram:g('qa_ig'),x:g('qa_x'),telegram:g('qa_tg'),website:g('qa_web'),bday:bd,review:true};
  DB.contacts.push(nc); save(); closeModal(); go('person',nc.id); };

/* ===== Capture hub: every effortless way to add someone, in one place ===== */
function capIcon(k){ const I={
  share:'<circle cx="6" cy="12" r="2.4"/><circle cx="17.5" cy="6" r="2.4"/><circle cx="17.5" cy="18" r="2.4"/><path d="M8.1 11l7.3-4M8.1 13l7.3 4"/>',
  paste:'<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>',
  scan:'<rect x="3.5" y="6" width="17" height="12" rx="2.2"/><circle cx="9" cy="12" r="2.2"/><path d="M14 10.5h3.5M14 13.5h3.5"/>',
  voice:'<rect x="9.5" y="3.5" width="5" height="10" rx="2.5"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3"/>',
  import:'<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16.5c.8-1.9 2.4-3 3.5-3s2.7 1.1 3.5 3M15 10h3M15 13h3"/>',
  type:'<path d="M12 20h8"/><path d="M16.5 3.6a2 2 0 0 1 2.9 2.8L7.5 18.3l-3.6 1 1-3.5z"/>'
}; return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(I[k]||I.type)+'</svg>'; }
window.captureHub=()=>{
  let h='<button class="x" onclick="closeModal()">&times;</button><h3>Add someone</h3>';
  h+='<div class="sub" style="margin:-6px 0 14px">Three effortless ways. You almost never type.</div>';
  const row=(cls,k,ti,ds,act)=>'<button class="cap '+cls+'" onclick="closeModal();'+act+'"><span class="capic">'+capIcon(k)+'</span><span class="capt"><span class="ti">'+ti+'</span><span class="ds">'+ds+'</span></span></button>';
  h+=row('hero','share','Let them share their card','Send a warm link. They fill it in, it comes back to you. Zero typing.','shareRequest()');
  h+=row('','paste','Paste anything','A signature, a bio, a line. Warmly pulls out every detail.','quickAdd()');
  h+=row('','scan','Scan a card','Snap a business card and start from the photo.','fabPick(\'camera\')');
  h+=row('','voice','Speak it','Just say who they are.','voiceAdd()');
  h+=row('','import','Import from your phone','Bring in contacts you already have.','go(\'import\')');
  h+=row('dim','type','Add by hand','Old-fashioned. Always here if you want it.','editContact(\'\')');
  openModal(h);
};
window.shareRequest=()=>{ const me=DB.me||{}; const phone=me.phone||'';
  if(!phone){ alert('Add your own WhatsApp number in My Card first, so their details can come back to you.'); go('mycard'); return; }
  const base=location.origin + location.pathname.replace(/[^\/]*$/, '');
  const link=base+'card.html?to='+encodeURIComponent(normalizePhone(phone))+'&from='+encodeURIComponent(me.name||DB.settings.myName||'a friend');
  const msg='Hey! I keep the people I care about close on Warmly. Mind sharing a few details so we stay in touch and I never miss your birthday? Takes 20 seconds: '+link;
  if(navigator.share){ navigator.share({text:msg}).catch(()=>{}); }
  else { window.open('https://wa.me/?text='+encodeURIComponent(msg),'_blank','noopener'); }
};

let _curMsgMeta={id:null,openerId:null,occasion:null};
window.compose=(id,occasion)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return;
  const fr=freshDraft(c,occasion); let draft=fr.text; _curMsgMeta={id:id,openerId:fr.openerId,occasion:occasion};
  let h='<button class="x" onclick="closeModal()">&times;</button><h3>Message '+esc(callName(c))+'</h3>';
  const _last=(c.log||[]).slice(-1)[0]; const _bits=[];
  if(c.jobTitle||c.company) _bits.push([c.jobTitle,c.company].filter(Boolean).join(' at '));
  if(c.location) _bits.push(c.location);
  if(c.howMet) _bits.push('met: '+c.howMet);
  if(c.partner&&c.partner.name) _bits.push('partner '+c.partner.name);
  if(c.children&&c.children.length) _bits.push('kids: '+c.children.map(k=>k.name).join(', '));
  if(c.food) _bits.push('likes '+c.food);
  if(c.style) _bits.push('tone: '+c.style);
  if(_last||_bits.length){ h+='<div class="ctx">'+(_last?'<div class="sub">last contacted '+esc(_last.date)+(_last.note?' &mdash; &ldquo;'+esc(_last.note)+'&rdquo;':'')+'</div>':'')+(_bits.length?'<div class="sub">'+esc(_bits.join(' · '))+'</div>':'')+'</div>'; }
  h+='<div class="btn-row" style="margin:10px 0">'+(occasion==='reconnect'?'<button class="btn ghost sm" onclick="freshMsg(\''+id+'\')">&#8635; fresh idea</button>':'')+(c.lastMsg?'<button class="btn ghost sm" onclick="useLast(\''+id+'\')">last message</button>':'')+DB.templates.map(t=>'<button class="btn ghost sm" onclick="useTpl(\''+id+'\',\''+t.id+'\')">'+esc(t.name)+'</button>').join('')+'</div>';
  if(occasion==='reconnect') h+='<div class="sub" style="margin:-4px 0 4px;opacity:.75">A fresh nudge, different from last time. Tap "fresh idea" for another.</div>';
  h+='<textarea id="msg" style="min-height:130px">'+esc(draft)+'</textarea>';
  h+='<div class="note">Tapping the button opens WhatsApp with this message pre-filled, sent from <b>your</b> number. You review and tap send yourself, nothing goes automatically.</div>';
  h+='<div class="btn-row">'+(c.phone?'<button class="btn wa block" onclick="sendWA(\''+id+'\')">Open WhatsApp with this message</button>':'<div class="muted">No phone number on file. Add one to message on WhatsApp.</div>')+'</div>';
  h+='<div class="btn-row" style="margin-top:8px"><button class="btn ghost sm" onclick="logToday(\''+id+'\')">Mark as contacted today</button></div>';
  openModal(h);
};
window.useTpl=(id,tid)=>{ const c=DB.contacts.find(x=>x.id===id), t=DB.templates.find(x=>x.id===tid); $('#msg').value=fillTemplate(t.body,c); };
window.sendWA=(id)=>{ const c=DB.contacts.find(x=>x.id===id); const txt=$('#msg').value;
  if(c&&txt){ c.lastMsg=txt; c.msgHistory=c.msgHistory||[]; const meta=(_curMsgMeta.id===id)?_curMsgMeta:{};
    c.msgHistory.push({text:txt, at:Date.now(), occasion:meta.occasion||'reconnect', openerId:meta.openerId||null});
    if(c.msgHistory.length>20) c.msgHistory=c.msgHistory.slice(-20); save(); }
  window.open(waLink(c.phone,txt),'_blank','noopener'); };
window.useLast=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(c&&c.lastMsg && $('#msg')) $('#msg').value=c.lastMsg; };
window.freshMsg=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return;
  const fr=freshDraft(c,'reconnect',(_curMsgMeta.id===id?_curMsgMeta.openerId:null));
  if($('#msg')) $('#msg').value=fr.text; _curMsgMeta={id:id,openerId:fr.openerId,occasion:'reconnect'}; };

window.addCal=(id,m,d,label)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return; const date=nextOccurrence(+m,+d);
  const title=callName(c)+"'s "+label; const details=(c.context?c.context+' · ':'')+(c.phone?('WhatsApp: '+waLink(c.phone,'')):'');
  window.open(gcalLink(title,date,details,true),'_blank','noopener');
};
window.logToday=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return;
  const note=prompt('Quick note about this catch-up (optional):')||'';
  const t=new Date().toISOString().slice(0,10); c.log=c.log||[]; c.log.push({date:t,type:'contacted',note}); c.lastContacted=t; save(); closeModal(); route();
};
window.setTier=(id,t)=>{ const c=DB.contacts.find(x=>x.id===id); if(c){ c.tier=t; save(); route(); } };
window.setCad=(id,m)=>{ const c=DB.contacts.find(x=>x.id===id); if(c){ c.cadence=m||null; save(); route(); } };

/* ===================================================================
   APP LOCK — local passcode + optional Face ID / fingerprint (WebAuthn).
   Device-local only (key 'warmly.lock'), never synced. The PIN is stored
   as a PBKDF2 hash; biometric is a local WebAuthn platform assertion.
   =================================================================== */
const LOCK_KEY='warmly.lock';
let _unlocked=true, _entered='', _bgAt=0, _bioOK=false;
function lockCfg(){ try{ return JSON.parse(localStorage.getItem(LOCK_KEY))||null; }catch(e){ return null; } }
function lockSave(c){ localStorage.setItem(LOCK_KEY, JSON.stringify(c)); }
function lockEnabled(){ const c=lockCfg(); return !!(c&&c.enabled&&c.hash); }
function _b64e(buf){ return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
function _b64d(s){ return Uint8Array.from(atob(s), c=>c.charCodeAt(0)); }
async function _lockDerive(pin, salt){ const base=await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2', salt:salt, iterations:150000, hash:'SHA-256'}, base, 256); return _b64e(bits); }
async function lockSetPin(pin){ const salt=crypto.getRandomValues(new Uint8Array(16)); const hash=await _lockDerive(pin, salt);
  const c=lockCfg()||{}; c.enabled=true; c.salt=_b64e(salt); c.hash=hash; c.len=pin.length; if(!c.autolock) c.autolock='now'; lockSave(c); }
async function lockVerifyPin(pin){ const c=lockCfg(); if(!c||!c.hash) return false; try{ const h=await _lockDerive(pin, _b64d(c.salt)); return h===c.hash; }catch(e){ return false; } }
async function lockBioAvail(){ try{ return !!(window.PublicKeyCredential) && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }catch(e){ return false; } }
async function lockBioRegister(){ try{
    if(!(await lockBioAvail())) return false;
    const cred=await navigator.credentials.create({publicKey:{
      challenge:crypto.getRandomValues(new Uint8Array(32)), rp:{name:'Warmly'},
      user:{id:crypto.getRandomValues(new Uint8Array(16)), name:'warmly', displayName:'Warmly'},
      pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
      authenticatorSelection:{authenticatorAttachment:'platform', userVerification:'required'}, timeout:60000, attestation:'none'
    }});
    if(!cred) return false; const c=lockCfg()||{}; c.bio={credId:_b64e(cred.rawId)}; lockSave(c); return true;
  }catch(e){ return false; } }
async function lockBioVerify(){ const c=lockCfg(); if(!c||!c.bio) return false; try{
    await navigator.credentials.get({publicKey:{ challenge:crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials:[{type:'public-key', id:_b64d(c.bio.credId)}], userVerification:'required', timeout:60000 }});
    return true;
  }catch(e){ return false; } }
const LOCKI={
  shut:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.3" r="1.2" fill="currentColor" stroke="none"/></svg>',
  open:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.4"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.6"/><circle cx="12" cy="15.3" r="1.2" fill="currentColor" stroke="none"/></svg>',
  face:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16"/><circle cx="9" cy="10.5" r=".6" fill="currentColor"/><circle cx="15" cy="10.5" r=".6" fill="currentColor"/><path d="M12 10v3M10 15.6s.8.8 2 .8 2-.8 2-.8"/></svg>',
  del:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H9L4 12l5 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z"/><path d="M13 9.5l4 5M17 9.5l-4 5"/></svg>'
};
function lockMarkup(){ const c=lockCfg()||{}; const len=c.len||4;
  let dots='<div class="lk-dots" id="lkDots">'; for(let i=0;i<len;i++) dots+='<i></i>'; dots+='</div>';
  const keys=['1','2','3','4','5','6','7','8','9','bio','0','del']; let pad='<div class="lk-pad">';
  keys.forEach(k=>{
    if(k==='bio') pad+= (c.bio? '<button class="lk-key fn bio" aria-label="unlock with biometrics" onclick="lockTapBio()">'+LOCKI.face+'</button>' : '<span class="lk-key fn ghost"></span>');
    else if(k==='del') pad+='<button class="lk-key fn" aria-label="delete" onclick="lockDel()">'+LOCKI.del+'</button>';
    else pad+='<button class="lk-key" onclick="lockTap(\''+k+'\')">'+k+'</button>';
  }); pad+='</div>';
  return '<div class="lk-inner"><div class="lk-brand">Warmly<span class="dot">.</span></div><div class="lk-icon" id="lkIcon">'+LOCKI.shut+'</div><div class="lk-msg" id="lkMsg">Enter your passcode</div>'+dots+pad+'</div>';
}
function lockPaint(){ const d=document.getElementById('lkDots'); if(!d) return; const n=_entered.length;
  Array.prototype.forEach.call(d.children,(el,i)=>el.classList.toggle('full', i<n)); }
function lockShow(){ _unlocked=false; _entered=''; const el=document.getElementById('lockScreen'); if(!el) return;
  el.innerHTML=lockMarkup(); el.style.display='flex'; el.classList.remove('unlocked'); lockPaint();
  const c=lockCfg(); if(c&&c.bio) setTimeout(()=>{ if(!_unlocked) lockTapBio(); }, 350); }
function lockHide(){ _unlocked=true; _entered=''; const el=document.getElementById('lockScreen'); if(!el) return;
  const ic=document.getElementById('lkIcon'); if(ic) ic.innerHTML=LOCKI.open; const m=document.getElementById('lkMsg'); if(m){ m.textContent='Welcome back'; m.classList.remove('err'); }
  el.classList.add('unlocked'); setTimeout(()=>{ el.style.display='none'; el.classList.remove('unlocked'); }, 480); }
window.lockTap=(n)=>{ const c=lockCfg(); const len=(c&&c.len)||4; if(_entered.length>=len) return;
  _entered+=n; lockPaint(); const m=document.getElementById('lkMsg'); if(m){ m.textContent='Enter your passcode'; m.classList.remove('err'); }
  if(_entered.length>=len) setTimeout(lockTry, 130); };
window.lockDel=()=>{ _entered=_entered.slice(0,-1); lockPaint(); };
async function lockTry(){ const ok=await lockVerifyPin(_entered);
  if(ok){ lockHide(); return; }
  const m=document.getElementById('lkMsg'); if(m){ m.textContent='Wrong passcode, try again'; m.classList.add('err'); }
  const d=document.getElementById('lkDots'); if(d){ d.classList.add('shake'); setTimeout(()=>d.classList.remove('shake'),420); }
  _entered=''; setTimeout(lockPaint, 60); }
window.lockTapBio=async()=>{ const m=document.getElementById('lkMsg'); if(m){ m.textContent='Verifying…'; m.classList.remove('err'); }
  const ok=await lockBioVerify(); if(ok){ lockHide(); } else if(m && !_unlocked){ m.textContent='Enter your passcode'; } };
function lockShouldRelock(){ const c=lockCfg(); if(!c) return true; const mode=c.autolock||'now'; if(mode==='now') return true;
  const mins=mode==='5'?5:1; return (Date.now()-_bgAt) > mins*60000; }
document.addEventListener('visibilitychange',()=>{ if(document.hidden){ _bgAt=Date.now(); }
  else if(lockEnabled() && _unlocked && lockShouldRelock()){ lockShow(); } });
function lockSection(){ const c=lockCfg()||{}; const on=lockEnabled();
  let h='<div class="kick">App lock</div><div class="card">';
  h+='<div class="row between"><div class="grow"><div class="nm" style="font-size:15px">Lock Warmly</div><div class="sub">Ask for a passcode every time the app opens, so your people stay private on this device. Stored only here, never synced.</div></div><button class="btn sm '+(on?'primary':'ghost')+'" onclick="lockToggle()">'+(on?'On':'Off')+'</button></div>';
  if(on){
    h+='<div class="lk-divider"></div><div class="row between"><div class="grow"><div class="nm" style="font-size:15px">Face ID / fingerprint</div><div class="sub">'+(_bioOK?'Unlock with your phone’s own biometrics. The passcode always works as a backup.':'Not available in this browser, so the passcode protects the app on its own.')+'</div></div>'+(_bioOK?('<button class="btn sm '+(c.bio?'primary':'ghost')+'" onclick="lockBioToggle()">'+(c.bio?'On':'Off')+'</button>'):'<span class="sub">—</span>')+'</div>';
    h+='<div class="lk-divider"></div><div class="nm" style="font-size:15px">Auto-lock</div><div class="sub" style="margin-bottom:8px">When to ask again after you leave the app.</div><div class="seg" id="lkAuto">'+[['now','Immediately'],['1','After 1 min'],['5','After 5 min']].map(([k,l])=>'<button class="'+(((c.autolock||'now')===k)?'on':'')+'" onclick="lockAuto(\''+k+'\')">'+l+'</button>').join('')+'</div>';
    h+='<div class="lk-divider"></div><div class="row between"><div class="grow"><div class="nm" style="font-size:15px">Passcode</div><div class="sub">'+(c.len||4)+'-digit PIN on this device.</div></div><button class="btn sm ghost" onclick="lockChangePin()">Change</button></div>';
  }
  return h+'</div>';
}
window.lockToggle=async()=>{ if(lockEnabled()){ const pin=prompt('Enter your current passcode to turn the lock OFF:'); if(pin===null) return; if(!(await lockVerifyPin((pin||'').trim()))){ alert('That passcode is not right.'); return; } localStorage.removeItem(LOCK_KEY); route(); return; }
  const a=prompt('Set a passcode (4 to 6 digits):'); if(a===null) return; const pin=(a||'').trim(); if(!/^\d{4,6}$/.test(pin)){ alert('Use 4 to 6 digits.'); return; }
  const b=prompt('Confirm your passcode:'); if(b===null) return; if((b||'').trim()!==pin){ alert('The two passcodes did not match.'); return; }
  await lockSetPin(pin); alert('App lock is on. You will need this passcode the next time Warmly opens.'); route(); };
window.lockChangePin=async()=>{ const cur=prompt('Enter your current passcode:'); if(cur===null) return; if(!(await lockVerifyPin((cur||'').trim()))){ alert('That passcode is not right.'); return; }
  const a=prompt('New passcode (4 to 6 digits):'); if(a===null) return; const pin=(a||'').trim(); if(!/^\d{4,6}$/.test(pin)){ alert('Use 4 to 6 digits.'); return; }
  const b=prompt('Confirm new passcode:'); if(b===null) return; if((b||'').trim()!==pin){ alert('The two passcodes did not match.'); return; }
  await lockSetPin(pin); alert('Passcode updated.'); route(); };
window.lockBioToggle=async()=>{ const c=lockCfg(); if(!c) return; if(c.bio){ delete c.bio; lockSave(c); route(); return; }
  const ok=await lockBioRegister(); alert(ok?'Face ID / fingerprint unlock is on.':'Could not set up biometric unlock on this device. Your passcode still works.'); route(); };
window.lockAuto=(k)=>{ const c=lockCfg(); if(!c) return; c.autolock=k; lockSave(c); route(); };

/* ---------- render + boot ---------- */
function render(h){ $('#app').innerHTML=h; }
(function(){ const bv=document.getElementById('brandVer'); if(bv) bv.textContent='v'+VERSION; })();
document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.go)));
$('#menuBtn').addEventListener('click',()=>$('#tabs').classList.toggle('open'));
const tb=$('#themeBtn');
if(localStorage.getItem('warmly.skin')==='brutal') document.documentElement.dataset.theme='brutal';
tb.textContent = (document.documentElement.dataset.theme==='brutal')?'A':'D';
tb.title='Switch skin: Warm Ember (A) / Brutalist (D)';
tb.addEventListener('click',()=>{ const isB=document.documentElement.dataset.theme==='brutal'; document.documentElement.dataset.theme=isB?'':'brutal'; tb.textContent=isB?'D':'A'; localStorage.setItem('warmly.skin', isB?'ember':'brutal'); });
gReturn();
if(!location.hash) location.hash='#today';
snapInit();
route();
gBoot();
/* app lock: detect biometric support, and gate the app if a passcode is set */
lockBioAvail().then(v=>{ _bioOK=v; });
if(lockEnabled()) lockShow();
/* swipe-left on a person opens their quick-action sheet */
let _swS=null;
document.addEventListener('touchstart',e=>{ if(localStorage.getItem('warmly.swipe')==='off') return; if(e.target.closest('.kebab')) return; const t=e.target.closest('[data-cid]'); if(!t) return; _swS={x:e.touches[0].clientX,y:e.touches[0].clientY,id:t.getAttribute('data-cid')}; },{passive:true});
document.addEventListener('touchend',e=>{ if(!_swS) return; const dx=e.changedTouches[0].clientX-_swS.x, dy=e.changedTouches[0].clientY-_swS.y, id=_swS.id; _swS=null; if(dx<-55 && Math.abs(dy)<35 && id && window.actions) actions(id); },{passive:true});
