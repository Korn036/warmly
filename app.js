/* ===================================================================
   KITH  ·  personal keep-in-touch CRM  ·  Phase 1 (local, no backend)
   Everything stays in this browser (localStorage). Nothing is sent to
   anyone until you tap send in WhatsApp / confirm in Google Calendar.
   =================================================================== */

/* ---------- storage ---------- */
const KEY='kith.v1';
const DEFAULT_TEMPLATES=[
  {id:'t_b',occasion:'birthday',name:'Birthday',body:"Happy birthday, {first}! 🎉 Hope your day is a brilliant one. We're overdue a proper catch-up, let's fix that soon."},
  {id:'t_a',occasion:'anniversary',name:'Anniversary',body:"Happy anniversary, {first}! Wishing you both the very best today."},
  {id:'t_r',occasion:'reconnect',name:'Reconnect',body:"Hey {first}, you crossed my mind today, it's been too long! How have you been? Would genuinely love to catch up, free for a quick call sometime?"}
];
let DB = load();
function load(){
  try{ const d=JSON.parse(localStorage.getItem(KEY)); if(d&&d.contacts) return d; }catch(e){}
  return { v:1, contacts:[], templates:DEFAULT_TEMPLATES.slice(), settings:{ myName:'', country:'44', leadDays:1 } };
}
function save(){ localStorage.setItem(KEY, JSON.stringify(DB)); }

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
function uid(){ return 'c'+Math.random().toString(36).slice(2,9); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function firstName(n){ return (n||'').trim().split(/\s+/)[0]||''; }
function initials(n){ const p=(n||'?').trim().split(/\s+/); return ((p[0]||'?')[0]+(p.length>1?p[p.length-1][0]:'')).toUpperCase(); }
function avatarColor(n){ const colors=['#0E3B2E','#2E8C6A','#C9756B','#D99A2B','#6A655B','#3C6E91','#8A5A99']; let h=0; for(const c of (n||'x')) h=(h*31+c.charCodeAt(0))%colors.length; return colors[h]; }
const MONTHS=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function today(){ const t=new Date(); return new Date(t.getFullYear(),t.getMonth(),t.getDate()); }
function nextOccurrence(m,d){ const t=today(); let yr=t.getFullYear(); let occ=new Date(yr,m-1,d); if(occ<t) occ=new Date(yr+1,m-1,d); return occ; }
function daysUntil(date){ return Math.round((date-today())/86400000); }
function addMonths(iso,n){ const d=new Date(iso); d.setMonth(d.getMonth()+n); return d; }
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
  return (body||'').replace(/\{first\}/g,firstName(c.name)).replace(/\{name\}/g,c.name||'').replace(/\{me\}/g,DB.settings.myName||'');
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

/* ===================================================================
   ROUTER + VIEWS
   =================================================================== */
function go(view,arg){ location.hash = '#'+view+(arg?('/'+arg):''); }
window.addEventListener('hashchange',route);
function route(){
  const [view,arg]=location.hash.replace('#','').split('/');
  document.querySelectorAll('#tabs a').forEach(a=>a.classList.toggle('active',a.dataset.go===(view||'today')));
  $('#tabs').classList.remove('open');
  const v=view||'today';
  ({ today:viewToday, people:viewPeople, person:viewPerson, import:viewImport, templates:viewTemplates, settings:viewSettings }[v]||viewToday)(arg);
  window.scrollTo(0,0);
}

function viewToday(){
  const due=dueToReach(), up=upcoming(21);
  const soon=up.filter(x=>x.n<=DB.settings.leadDays+1);
  let h='<div class="view"><h1 class="title">Today</h1><p class="muted">'+(DB.settings.myName?('Hello '+esc(firstName(DB.settings.myName))+'. '):'')+'Keep your people warm.</p>';
  if(!DB.contacts.length){
    h+='<div class="empty"><div class="big">No one here yet.</div>Import your contacts to begin, then mark the handful who matter.<br><br><button class="btn primary" onclick="go(\'import\')">Import contacts</button></div></div>';
    return render(h);
  }
  /* reach out */
  h+='<div class="kick">Time to reach out ('+due.length+')</div>';
  if(!due.length) h+='<div class="card muted" style="text-align:center">Nobody is overdue. Nicely kept. ✦</div>';
  due.slice(0,12).forEach(({c,overdue})=>{ h+=personRow(c, overdue===0?'<span class="pill warm">due now</span>':'<span class="pill warm">'+(-overdue)+'d overdue</span>',
      '<button class="btn sm primary" onclick="compose(\''+c.id+'\',\'reconnect\')">Message</button> <button class="btn sm ghost" onclick="logToday(\''+c.id+'\')">Log call</button>'); });
  /* coming up */
  h+='<div class="kick">Coming up</div>';
  if(!up.length) h+='<div class="card muted" style="text-align:center">No birthdays or anniversaries in the next three weeks.</div>';
  up.slice(0,20).forEach(({c,o,n})=>{
    const pill='<span class="pill '+(o.type==='birthday'?'bday':o.type==='anniversary'?'anniv':'warm')+'">'+esc(o.label)+' '+whenLabel(n)+'</span>';
    h+=personRow(c, pill,
      '<button class="btn sm gold" onclick="compose(\''+c.id+'\',\''+(o.type==='anniversary'?'anniversary':o.type==='birthday'?'birthday':'reconnect')+'\')">Wish</button> '+
      '<button class="btn sm ghost" onclick="addCal(\''+c.id+'\','+(o.date.getMonth()+1)+','+o.date.getDate()+',\''+esc(o.label)+'\')">+ Calendar</button>');
  });
  h+='</div>'; render(h);
}
function personRow(c,pill,actions){
  return '<div class="card"><div class="row"><div class="avatar" style="background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
    +'<div class="grow" onclick="go(\'person\',\''+c.id+'\')" style="cursor:pointer"><div class="nm">'+esc(c.name)+'</div><div class="sub">'+(c.context?esc(c.context)+' · ':'')+pill+'</div></div></div>'
    +'<div class="btn-row" style="margin-top:12px">'+actions+'</div></div>';
}

function viewPeople(){
  const f=window._pfilter||{q:'',tier:0};
  let list=DB.contacts.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if(f.tier) list=list.filter(c=>c.tier===f.tier);
  if(f.q){ const q=f.q.toLowerCase(); list=list.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.context||'').toLowerCase().includes(q)); }
  let h='<div class="view"><div class="row between"><h1 class="title">People</h1><button class="btn primary sm" onclick="editContact()">+ Add</button></div>';
  h+='<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg><input id="pq" placeholder="search '+DB.contacts.length+' people" value="'+esc(f.q)+'" oninput="pSearch(this.value)"></div>';
  h+='<div class="chips">'+[[0,'all'],[1,'inner circle'],[2,'keep warm'],[3,'loose ties']].map(([t,l])=>'<span class="chip '+(f.tier===t?'on':'')+'" onclick="pTier('+t+')">'+l+'</span>').join('')+'</div>';
  if(!list.length) h+='<div class="empty">No matches.</div>';
  list.forEach(c=>{ const occ=contactOccasions(c)[0];
    h+='<div class="card row" style="cursor:pointer" onclick="go(\'person\',\''+c.id+'\')"><div class="avatar" style="background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
      +'<div class="grow"><div class="nm">'+esc(c.name)+'</div><div class="sub">'+(c.context?esc(c.context):'no notes yet')+(occ?(' · '+occ.label+' '+fmtDate(occ.date)):'')+'</div></div>'
      +'<span class="pill t'+(c.tier||3)+'">'+({1:'inner',2:'warm',3:'loose'}[c.tier||3])+'</span></div>';
  });
  h+='</div>'; render(h);
}
window.pSearch=v=>{ window._pfilter=Object.assign(window._pfilter||{tier:0},{q:v}); const list=document.querySelectorAll('.view .card.row'); viewPeople(); const i=$('#pq'); if(i){ i.focus(); i.setSelectionRange(v.length,v.length); } };
window.pTier=t=>{ window._pfilter=Object.assign(window._pfilter||{q:''},{tier:t}); viewPeople(); };

function viewPerson(id){
  const c=DB.contacts.find(x=>x.id===id); if(!c){ go('people'); return; }
  const occ=contactOccasions(c); const nd=nextDue(c);
  let h='<div class="view"><a class="btn ghost sm" onclick="go(\'people\')">← People</a>';
  h+='<div class="card" style="margin-top:14px"><div class="row"><div class="avatar" style="width:56px;height:56px;font-size:22px;background:'+avatarColor(c.name)+'">'+esc(initials(c.name))+'</div>'
    +'<div class="grow"><div class="nm" style="font-size:20px;font-family:var(--serif)">'+esc(c.name)+'</div><div class="sub">'+(c.context?esc(c.context):'')+'</div></div>'
    +'<span class="pill t'+(c.tier||3)+'">'+({1:'inner circle',2:'keep warm',3:'loose tie'}[c.tier||3])+'</span></div>';
  h+='<div class="btn-row" style="margin-top:14px">';
  if(c.phone) h+='<button class="btn wa sm" onclick="compose(\''+c.id+'\',\'reconnect\')">Message on WhatsApp</button>';
  h+='<button class="btn ghost sm" onclick="logToday(\''+c.id+'\')">Log a call today</button>';
  h+='<button class="btn ghost sm" onclick="editContact(\''+c.id+'\')">Edit</button></div></div>';
  /* details */
  h+='<div class="card"><div class="kick" style="margin-top:0">Details</div>';
  h+=detailRow('Phone',c.phone||'—'); h+=detailRow('Email',c.email||'—');
  h+=detailRow('LinkedIn', c.linkedin?'<a style="color:var(--green-2)" target="_blank" rel="noopener" href="'+esc(c.linkedin)+'">profile ↗</a>':'—');
  occ.forEach(o=>{ const age=o.raw.y?(' (turns '+(o.date.getFullYear()-o.raw.y)+')'):''; h+=detailRow(o.label[0].toUpperCase()+o.label.slice(1), fmtDate(o.date)+esc(age)+' · '+whenLabel(daysUntil(o.date))+' &nbsp; <a style="color:var(--green-2)" onclick="addCal(\''+c.id+'\','+(o.date.getMonth()+1)+','+o.date.getDate()+',\''+esc(o.label)+'\')">+ calendar</a>'); });
  h+=detailRow('Keep in touch', c.cadence?('every '+c.cadence+' months'+(nd?(' · next '+(nd<=today()?'now':fmtDate(nd))):'')):'not set');
  h+='</div>';
  /* context note */
  h+='<div class="card"><div class="kick" style="margin-top:0">Notes</div><textarea id="ctx" placeholder="how you know them, what you last spoke about, what matters to them..." oninput="saveCtx(\''+c.id+'\',this.value)">'+esc(c.context||'')+'</textarea></div>';
  /* history */
  h+='<div class="card"><div class="kick" style="margin-top:0">History</div>';
  if(!(c.log&&c.log.length)) h+='<div class="muted">No interactions logged yet.</div>';
  (c.log||[]).slice().reverse().forEach(l=>{ h+='<div class="row" style="padding:7px 0;border-bottom:0.5px solid var(--line)"><div class="grow"><b style="font-size:14px">'+esc(l.type)+'</b> <span class="sub">'+esc(l.note||'')+'</span></div><span class="sub">'+esc(l.date)+'</span></div>'; });
  h+='</div></div>'; render(h);
}
function detailRow(k,v){ return '<div class="row between" style="padding:8px 0;border-bottom:0.5px solid var(--line)"><span class="sub">'+k+'</span><span style="text-align:right;font-size:14px">'+v+'</span></div>'; }
window.saveCtx=(id,v)=>{ const c=DB.contacts.find(x=>x.id===id); if(c){ c.context=v; save(); } };

/* ---------- import ---------- */
function viewImport(){
  let h='<div class="view"><h1 class="title">Import contacts</h1><p class="muted">Drop a CSV (Google Contacts export) or a vCard (.vcf). It stays on this device. You choose exactly who to keep.</p>';
  h+='<div class="card" style="text-align:center;padding:30px"><input type="file" id="file" accept=".csv,.vcf,.vcard,text/csv,text/vcard" onchange="onFile(event)" style="display:none"><button class="btn primary" onclick="document.getElementById(\'file\').click()">Choose a file</button>'
    +'<div class="muted" style="margin-top:12px">In Google Contacts: Export → Google CSV. On iPhone: share a contact / use a .vcf.</div></div>';
  h+='<div id="preview"></div></div>'; render(h);
}
window.onFile=(ev)=>{ const f=ev.target.files[0]; if(!f) return; const rd=new FileReader();
  rd.onload=()=>{ const text=rd.result; const rows = /vcard|vcf/i.test(f.name)? parseVCF(text) : parseCSV(text);
    window._imp=rows.map(r=>Object.assign({_keep:true,_tier:2},r)); renderPreview(); };
  rd.readAsText(f);
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
  let h='<div class="view"><h1 class="title">Message templates</h1><p class="muted">Write these once, in your voice. {first} becomes their first name, {me} your name. You always edit before sending.</p>';
  DB.templates.forEach(t=>{ h+='<div class="card"><div class="kick" style="margin-top:0">'+esc(t.name)+' · '+esc(t.occasion)+'</div><textarea oninput="tplSet(\''+t.id+'\',this.value)">'+esc(t.body)+'</textarea></div>'; });
  h+='</div>'; render(h);
}
window.tplSet=(id,v)=>{ const t=DB.templates.find(x=>x.id===id); if(t){ t.body=v; save(); } };

/* ---------- settings + backup ---------- */
function viewSettings(){
  const s=DB.settings;
  let h='<div class="view"><h1 class="title">Settings</h1>';
  h+='<div class="card"><label class="fl">Your name (for {me} in templates)</label><input value="'+esc(s.myName)+'" oninput="setS(\'myName\',this.value)">';
  h+='<label class="fl">Default country code (for phone numbers without +)</label><input value="'+esc(s.country)+'" oninput="setS(\'country\',this.value.replace(/[^0-9]/g,\'\'))" placeholder="44 for UK, 91 for India">';
  h+='<label class="fl">Remind me this many days before</label><input type="number" min="0" max="14" value="'+(s.leadDays)+'" oninput="setS(\'leadDays\',+this.value)"></div>';
  h+='<div class="kick">Backup &amp; move to another device</div><div class="card"><div class="muted">Your data lives only in this browser. Export an encrypted backup file to keep it safe or move it to your laptop/phone.</div>'
    +'<div class="btn-row" style="margin-top:12px"><button class="btn primary sm" onclick="exportEnc()">Encrypted backup</button><button class="btn ghost sm" onclick="exportJSON()">Plain JSON</button>'
    +'<button class="btn ghost sm" onclick="document.getElementById(\'imp\').click()">Restore backup</button><input type="file" id="imp" accept=".kith,.json" style="display:none" onchange="importFile(event)"></div></div>';
  h+='<div class="kick">Danger zone</div><div class="card"><button class="btn ghost sm" style="color:var(--rose)" onclick="wipe()">Erase everything on this device</button></div>';
  h+='<div class="muted" style="margin-top:24px;font-size:12.5px">Kith v1 · '+DB.contacts.length+' contacts · all local, no tracking.</div></div>'; render(h);
}
window.setS=(k,v)=>{ DB.settings[k]=v; save(); };
window.wipe=()=>{ if(confirm('Erase ALL contacts and notes on this device? Export a backup first if unsure.')){ DB={ v:1, contacts:[], templates:DEFAULT_TEMPLATES.slice(), settings:DB.settings }; save(); go('today'); } };
function download(name,blob){ const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); }
window.exportJSON=()=>download('kith-backup.json', new Blob([JSON.stringify(DB,null,2)],{type:'application/json'}));
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
window.closeModal=()=>$('#modalBg').classList.remove('show');
$('#modalBg').addEventListener('click',e=>{ if(e.target.id==='modalBg') closeModal(); });

window.editContact=(id)=>{ const c=id?DB.contacts.find(x=>x.id===id):{tier:2,customDates:[]};
  const dv=o=>o&&o.m?(o.y?o.y+'-':'')+String(o.m).padStart(2,'0')+'-'+String(o.d).padStart(2,'0'):'';
  let h='<button class="x" onclick="closeModal()">&times;</button><h3>'+(id?'Edit':'New')+' contact</h3>';
  h+='<label class="fl">Name</label><input id="e_name" value="'+esc(c.name||'')+'">';
  h+='<div class="two"><div><label class="fl">Phone (with country code)</label><input id="e_phone" value="'+esc(c.phone||'')+'" placeholder="+44 7..."></div><div><label class="fl">Closeness</label><select id="e_tier"><option value="1"'+(c.tier===1?' selected':'')+'>inner circle</option><option value="2"'+(c.tier===2?' selected':'')+'>keep warm</option><option value="3"'+(c.tier===3?' selected':'')+'>loose tie</option></select></div></div>';
  h+='<div class="two"><div><label class="fl">Email</label><input id="e_email" value="'+esc(c.email||'')+'"></div><div><label class="fl">LinkedIn URL</label><input id="e_li" value="'+esc(c.linkedin||'')+'"></div></div>';
  h+='<div class="two"><div><label class="fl">Birthday (YYYY-MM-DD or --MM-DD)</label><input id="e_bday" value="'+dv(c.bday)+'" placeholder="1996-04-21"></div><div><label class="fl">Anniversary</label><input id="e_anniv" value="'+dv(c.anniv)+'"></div></div>';
  h+='<label class="fl">Reconnect every (months, blank = off)</label><input id="e_cad" type="number" min="1" value="'+(c.cadence||'')+'" placeholder="5">';
  h+='<label class="fl">Notes / context</label><textarea id="e_ctx">'+esc(c.context||'')+'</textarea>';
  h+='<div class="btn-row" style="margin-top:16px"><button class="btn primary block" onclick="saveContact(\''+(id||'')+'\')">Save</button></div>';
  openModal(h);
};
window.saveContact=(id)=>{ const g=i=>$('#'+i).value.trim();
  let c=id?DB.contacts.find(x=>x.id===id):null;
  if(!c){ c={id:uid(),customDates:[],log:[],createdAt:new Date().toISOString()}; DB.contacts.push(c); }
  c.name=g('e_name')||'Unnamed'; c.phone=g('e_phone'); c.tier=+$('#e_tier').value; c.email=g('e_email'); c.linkedin=g('e_li');
  c.bday=parseDateStr(g('e_bday')); c.anniv=parseDateStr(g('e_anniv')); c.cadence=+g('e_cad')||null; c.context=g('e_ctx');
  save(); closeModal(); route();
};

window.compose=(id,occasion)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return;
  const tpl=DB.templates.find(t=>t.occasion===occasion)||DB.templates.find(t=>t.occasion==='reconnect')||{body:''};
  const draft=fillTemplate(tpl.body,c);
  let h='<button class="x" onclick="closeModal()">&times;</button><h3>Message '+esc(firstName(c.name))+'</h3>';
  h+='<div class="btn-row" style="margin:10px 0">'+DB.templates.map(t=>'<button class="btn ghost sm" onclick="useTpl(\''+id+'\',\''+t.id+'\')">'+esc(t.name)+'</button>').join('')+'</div>';
  h+='<textarea id="msg" style="min-height:130px">'+esc(draft)+'</textarea>';
  h+='<div class="note">Tapping the button opens WhatsApp with this message pre-filled, sent from <b>your</b> number. You review and tap send yourself, nothing goes automatically.</div>';
  h+='<div class="btn-row">'+(c.phone?'<button class="btn wa block" onclick="sendWA(\''+id+'\')">Open WhatsApp with this message</button>':'<div class="muted">No phone number on file. Add one to message on WhatsApp.</div>')+'</div>';
  h+='<div class="btn-row" style="margin-top:8px"><button class="btn ghost sm" onclick="logToday(\''+id+'\')">Mark as contacted today</button></div>';
  openModal(h);
};
window.useTpl=(id,tid)=>{ const c=DB.contacts.find(x=>x.id===id), t=DB.templates.find(x=>x.id===tid); $('#msg').value=fillTemplate(t.body,c); };
window.sendWA=(id)=>{ const c=DB.contacts.find(x=>x.id===id); const txt=$('#msg').value; window.open(waLink(c.phone,txt),'_blank'); };

window.addCal=(id,m,d,label)=>{ const c=DB.contacts.find(x=>x.id===id); const date=nextOccurrence(+m,+d);
  const title=esc(firstName(c.name))+"'s "+label; const details=(c.context?c.context+' · ':'')+(c.phone?('WhatsApp: '+waLink(c.phone,'')):'');
  window.open(gcalLink(title,date,details,true),'_blank');
};
window.logToday=(id)=>{ const c=DB.contacts.find(x=>x.id===id); if(!c) return;
  const note=prompt('Quick note about this catch-up (optional):')||'';
  const t=new Date().toISOString().slice(0,10); c.log=c.log||[]; c.log.push({date:t,type:'contacted',note}); c.lastContacted=t; save(); closeModal(); route();
};

/* ---------- render + boot ---------- */
function render(h){ $('#app').innerHTML=h; }
document.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>go(el.dataset.go)));
$('#menuBtn').addEventListener('click',()=>$('#tabs').classList.toggle('open'));
const tb=$('#themeBtn');
if(localStorage.getItem('kith.theme')==='dark'){ document.documentElement.dataset.theme='dark'; tb.textContent='☀'; }
tb.addEventListener('click',()=>{ const d=document.documentElement.dataset.theme==='dark'; document.documentElement.dataset.theme=d?'':'dark'; tb.textContent=d?'☾':'☀'; localStorage.setItem('kith.theme',d?'light':'dark'); });
if(!location.hash) location.hash='#today';
route();
