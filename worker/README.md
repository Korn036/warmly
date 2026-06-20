# Warmly auth Worker — permanent "Sign in with Google"

A tiny Cloudflare Worker that holds your Google **refresh token** so Warmly never
re-asks you to log in. **Your contacts never pass through it** — it only brokers
your Google login. The Google client **secret** lives only here, never in the app.

## What you need
- A free Cloudflare account (you already have one).
- Node.js installed, then: `npm install -g wrangler` and `wrangler login`.
  (No Node? You can also do all of this in the Cloudflare dashboard — see "Dashboard route" at the bottom.)

## Steps

### 1. Get your Google client secret + add the redirect URL
- Google Cloud Console → **Clients** → open **Warmly Web**.
- Under **Authorized redirect URIs**, click **Add URI** and paste (you'll confirm the exact host after step 5, then come back and fix it if needed):
  `https://warmly-auth.<your-workers-subdomain>.workers.dev/auth/callback`
- Copy the **Client secret** shown on that page (starts with `GOCSPX-`). Keep it handy for step 4.

### 2. Open this folder in a terminal
```
cd worker
```

### 3. Create the storage (KV) and paste its id
```
wrangler kv namespace create SESSIONS
```
Copy the `id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_KV_ID`).

### 4. Set the secret (never goes in any file)
```
wrangler secret put GOOGLE_CLIENT_SECRET
```
Paste the `GOCSPX-...` value when prompted.

### 5. Deploy
```
wrangler deploy
```
It prints your Worker URL, e.g. `https://warmly-auth.<subdomain>.workers.dev`.

### 6. Finish
- Make sure the **redirect URI** in step 1 exactly matches `<that URL>/auth/callback` (fix it in Google if the subdomain differs).
- **Send Karthik's assistant that Worker URL.** It then flips Warmly's "Sign in with Google" to use it — and you'll never be asked to log in again.

---

## Dashboard route (no Node)
1. Cloudflare dashboard → **Workers & Pages → Create → Worker** → name it `warmly-auth` → paste the contents of `worker.js` → **Deploy**.
2. **Settings → Variables**: add `GOOGLE_CLIENT_ID` (the value from `wrangler.toml`) and `ALLOWED_ORIGINS`. Add `GOOGLE_CLIENT_SECRET` as an **Encrypted** variable.
3. **Settings → KV namespace bindings**: create a KV namespace, bind it as `SESSIONS`.
4. Do step 1 above (redirect URI) and step 6 (send the URL).

## Security notes
- The **refresh token** stays in Cloudflare KV; the browser only ever holds a short access token + a random session id.
- Access is limited to the **`drive.appdata`** scope — even a stolen session can only touch Warmly's own hidden file, never your wider Drive.
- `ALLOWED_ORIGINS` restricts which sites may call the token endpoint (your CORS lock).
