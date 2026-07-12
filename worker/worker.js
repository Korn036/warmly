/* ===================================================================
   Warmly auth Worker  ·  permanent "Sign in with Google"
   -------------------------------------------------------------------
   This tiny server does the proper Google login (the "authorization
   code" flow) and securely stores the long-lived REFRESH TOKEN in KV.
   The browser only ever receives short-lived access tokens + a random
   session id, so the app never has to re-log-in.

   IMPORTANT: your CONTACTS never pass through this Worker. It only
   brokers your Google login; the app reads/writes your Drive directly.
   The Google client SECRET lives only here (env var), never in the app.
   =================================================================== */
const AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE     = 'https://www.googleapis.com/auth/drive.appdata';

function rand(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function corsHeaders(origin, allowed){
  const ok = allowed.includes(origin);
  /* Allow-Credentials is required because /auth/token and /auth/logout are now called with
     credentials:'include' so the HttpOnly session cookie rides along; it is safe to pair with
     Allow-Origin here because we always echo a SPECIFIC allow-listed origin, never '*'. */
  return { 'Access-Control-Allow-Origin': ok ? origin : 'null', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'content-type', 'Access-Control-Allow-Credentials':'true', 'Vary':'Origin' };
}
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status||200, headers: { 'Content-Type':'application/json', ...(extra||{}) } });

/* ---- Session cookie helpers ----
   The session id is a bearer credential (see worker-level comment above), so it must never be
   readable by page JS: HttpOnly keeps it out of `document.cookie`/localStorage/XSS reach, Secure
   keeps it off plaintext HTTP, and Path scopes it to only the /auth/* routes that need it (never
   sent on unrelated requests). Max-Age matches the KV session TTL so the cookie and the server-side
   record expire together.
   IMPORTANT DEPLOYMENT REQUIREMENT: SameSite=Strict cookies are only sent by the browser on
   SAME-SITE requests (same registrable domain, subdomains OK, e.g. auth.sovenn.app <-> sovenn.app).
   If this Worker is ever deployed on a different site than the app (e.g. a bare *.workers.dev host
   while the app lives on sovenn.app), the browser will NOT attach this cookie to the app's
   cross-site fetch('/auth/token', {credentials:'include'}) calls and sign-in will silently fail.
   Deploy the Worker on a route/subdomain that shares a registrable domain with the app before
   turning AUTH_WORKER on. */
const SESSION_COOKIE = 'warmly_session';
const SESSION_MAX_AGE = 7776000; // 90d, matches the KV expirationTtl below
function setSessionCookie(session){
  return `${SESSION_COOKIE}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=${SESSION_MAX_AGE}`;
}
function clearSessionCookie(){
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/auth; Max-Age=0`;
}
function readSessionCookie(req){
  const raw = req.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const allowed = (env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const redirectUri = url.origin + '/auth/callback';

    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin, allowed) });

    /* 1) START — send the user to Google to approve once */
    if (url.pathname === '/auth/start') {
      const app = url.searchParams.get('app') || allowed[0] || '';
      if (!allowed.some(o => app === o || app.startsWith(o + '/'))) return new Response('invalid app origin', { status: 400 });  /* prevent open-redirect / token exfiltration to an attacker URL */
      const state = rand(12);
      await env.SESSIONS.put('state:'+state, app, { expirationTtl: 600 });
      const p = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type:'code', scope: SCOPE, access_type:'offline', prompt:'consent', include_granted_scopes:'true', state });
      return Response.redirect(AUTH_URL + '?' + p.toString(), 302);
    }

    /* 2) CALLBACK — Google returns a code; swap it for tokens, store the refresh token */
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      const app = state ? await env.SESSIONS.get('state:'+state) : null;
      if (!code || !app) return new Response('bad request', { status: 400 });
      const body = new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type:'authorization_code' });
      const t = await (await fetch(TOKEN_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })).json();
      if (!t.access_token) return new Response('Sign-in could not be completed. Please try again.', { status: 502 });  /* generic error — do not echo Google's raw response */
      if (!allowed.some(o => app === o || app.startsWith(o + '/'))) return new Response('invalid app origin', { status: 400 });
      const session = rand(24);
      await env.SESSIONS.put('sess:'+session, JSON.stringify({ refresh_token: t.refresh_token || '' }), { expirationTtl: SESSION_MAX_AGE });  /* 90d: a session id is a bearer credential; never let it live forever */
      /* session id rides home as an HttpOnly cookie, never in the URL (fragment/query) and never
         touched by page JS: the app never sees it, so a future XSS bug can't read or replay it */
      return new Response(null, { status: 302, headers: { 'Location': app, 'Set-Cookie': setSessionCookie(session) } });
    }

    /* 3) TOKEN — the app asks for a fresh access token, silently, forever */
    if (url.pathname === '/auth/token') {
      const h = corsHeaders(origin, allowed);
      const session = readSessionCookie(req);
      const raw = session ? await env.SESSIONS.get('sess:'+session) : null;
      if (!raw) return json({ error:'no_session' }, 401, h);
      const { refresh_token } = JSON.parse(raw);
      if (!refresh_token) return json({ error:'no_refresh' }, 401, h);
      const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token, grant_type:'refresh_token' });
      const t = await (await fetch(TOKEN_URL, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })).json();
      if (!t.access_token) return json({ error:'refresh_failed' }, 401, h);
      return json({ access_token: t.access_token, expires_in: t.expires_in||3600 }, 200, h);
    }

    /* 4) LOGOUT — forget the stored refresh token */
    if (url.pathname === '/auth/logout') {
      if (!allowed.includes(origin)) return new Response('forbidden', { status: 403 });   /* block cross-site (CSRF) logout via <img>/<link>; SameSite=Strict cookie + this Origin check is belt-and-braces */
      const session = readSessionCookie(req);
      if (session) await env.SESSIONS.delete('sess:'+session);
      return new Response('ok', { headers: { ...corsHeaders(origin, allowed), 'Set-Cookie': clearSessionCookie() } });
    }

    return new Response('Sovenn auth worker is running.', { headers: { 'Content-Type':'text/plain' } });
  }
};
