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
  return { 'Access-Control-Allow-Origin': ok ? origin : 'null', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'content-type', 'Vary':'Origin' };
}
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status||200, headers: { 'Content-Type':'application/json', ...(extra||{}) } });

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
      if (!t.access_token) return new Response('token exchange failed: ' + JSON.stringify(t), { status: 500 });
      const session = rand(24);
      await env.SESSIONS.put('sess:'+session, JSON.stringify({ refresh_token: t.refresh_token || '' }));
      const frag = '#warmly_session=' + session + '&access_token=' + t.access_token + '&expires_in=' + (t.expires_in||3600);
      return Response.redirect(app + frag, 302);
    }

    /* 3) TOKEN — the app asks for a fresh access token, silently, forever */
    if (url.pathname === '/auth/token') {
      const h = corsHeaders(origin, allowed);
      const session = url.searchParams.get('session');
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
      const session = url.searchParams.get('session');
      if (session) await env.SESSIONS.delete('sess:'+session);
      return new Response('ok', { headers: corsHeaders(origin, allowed) });
    }

    return new Response('Warmly auth worker is running.', { headers: { 'Content-Type':'text/plain' } });
  }
};
