# Sovenn — a private, on-device keep-in-touch app

Remember the people who matter, never miss a birthday, and keep warm contacts from going
cold. Mark who's in your inner circle, store birthdays/anniversaries + a little context, get
nudged before each occasion, and send a warm WhatsApp message from **your own number with one
tap** (you review and send). Drop dates onto **Google Calendar**, and set "reconnect every N
months" so warm contacts don't drift.

**Private by design:** everything lives on your device (the browser's local storage). There's
no Sovenn server, no account, and no tracking. Nothing is sent to anyone until *you* tap send.

- **Live:** https://sovenn.app — installable PWA, published to Google Play as a TWA.
- **Stack:** single-page vanilla JS (no build step), a service worker (stale-while-revalidate),
  and a few feature modules. Hosted on Cloudflare Pages (`git push` → deploy).

## Run / edit locally
- Serve the folder over HTTP (e.g. `python -m http.server 8753`) and open it — a real origin is
  needed for the service worker, install, and the Contacts Picker.
- Everything is hand-editable: `app.js` (views + logic), `styles.css`, `index.html`,
  feature modules (`shuffle/memory/streak/capture/qr/ai/notify/enrich.js`), `sw.js`.

## Getting contacts in
- **Android:** the in-app Contacts Picker (no sign-in, on-device).
- **Google Contacts:** export → **Google CSV** → Import.
- **iPhone:** share a contact as `.vcf` and import it.
- You choose exactly who to keep — only the people you want to stay warm with.

## How the gentle automation works (all human-approved)
- **Today** surfaces who's due (birthdays, anniversaries, and overdue reconnects) as a swipeable
  deck. **Message** opens WhatsApp with a draft pre-filled — you review and send. **+ Calendar**
  pre-fills a recurring Google Calendar event. **Log** stamps "last contacted" and schedules the
  next reconnect.

## Backup & optional sync
- **Encrypted backup:** a passphrase-protected file (real AES-GCM) you save and restore yourself.
- **Google Drive sync (optional, default-off):** an encrypted copy to a hidden folder in *your own*
  Drive. Contacts never touch a Sovenn server; the app talks to Drive directly.

## Security headers
`_headers` ships the CSP, HSTS, and related headers automatically on Cloudflare Pages.

## Deploy
`git push origin main` → Cloudflare Pages builds and serves `sovenn.app`. Bump `VERSION` in
`app.js` and the cache name in `sw.js` each release so clients pick up the new build.
