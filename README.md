# Warmly — personal keep-in-touch CRM (Phase 1)

A simple, private relationship manager. Import your contacts, mark who matters, store
birthdays/anniversaries + a little context, get nudged before each occasion, send a warm
WhatsApp message from **your own number with one tap** (you review + tap send yourself),
drop dates onto **Google Calendar**, and set "reconnect every N months" so warm contacts
don't go cold.

Everything lives **on your device** (the browser's local storage). Nothing is sent to anyone
until you tap send in WhatsApp or confirm in Google Calendar. No tracking, no accounts, $0.

## Try it right now
- Double-click `index.html` to open it in your browser. (The app works; the installable
  "add to home screen" / offline bits only kick in once it's hosted over HTTPS.)
- Go to **Import** → choose `sample-contacts.csv` → tick a few → Import. Then open **Today**.

## Get your real contacts in
- **Google Contacts:** contacts.google.com → Export → **Google CSV** → import that file.
- **iPhone:** share a contact as a `.vcf`, or export via iCloud, and import the `.vcf`.
- You choose exactly who to keep (only import people you actually want to stay warm with).

## How the "automation" works (all human-approved)
- **Birthday/keep-in-touch reminder** appears under **Today** (a day before, by default).
- **Message:** opens WhatsApp with a template-filled draft pre-filled to that person — *you*
  review and tap send. This is the only safe, free, ban-proof way (auto-send gets numbers banned).
- **+ Calendar:** opens Google Calendar pre-filled with a yearly-recurring event so your iPhone
  reminds you natively.
- **Log a call** stamps "last contacted" and schedules the next reconnect automatically.

## Deploy it (so it installs on your iPhone)
1. Cloudflare → Workers & Pages → Create → Pages → **Upload assets**.
2. Upload this whole folder (index.html, app.js, styles.css, manifest.webmanifest, sw.js,
   icon.svg, `_headers`). Skip the README and sample CSV if you like.
3. Optional: set a custom domain like `kith.karthikonteddu.com`.
4. On your iPhone, open the site in Safari → Share → **Add to Home Screen**.

`_headers` adds the security headers (CSP, HSTS, etc.) automatically on Cloudflare Pages.

## Backup / move between devices
Settings → **Encrypted backup** (passphrase-protected `.kith` file) → restore it on your laptop
or phone. (Phase 2 replaces this with real live sync.)

## Honest limits (Phase 1)
- Data is per-device; sync across phone+laptop is manual via the encrypted backup for now.
- Reminders surface in-app + via the calendar events you add; there's no background push yet.
- Can't auto-rank contacts by WhatsApp activity (WhatsApp exposes nothing) — you triage, fast.

## Phase 2 (when you want to go public/paid)
A small Cloudflare Workers + D1 backend for true cross-device sync, real Google Calendar
auto-sync, multi-user accounts + Stripe. The data model already carries this design, so it's an
add-on, not a rewrite. (At that point, tighten the CSP off `'unsafe-inline'` — fine for a private
local app, worth hardening once data is multi-user.)
