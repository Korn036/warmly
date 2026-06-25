# Sovenn release checklist (solo-dev, low-bug discipline)

Gate every release on CI being green, then run this short manual pass. The three
files marked [CRITICAL] must get a deliberate diff-read on every change.

## Automated (CI must be green before you tag a release)
- [ ] `selftest` job green (all module `_selftest()` pass)
- [ ] `smoke` job green (boot + service worker + XSS-render guard)
- [ ] Dependabot PRs reviewed/merged; `npm` deps current

## Manual, before pushing a deploy
- [ ] Bumped `VERSION` + `BUILT` in app.js AND the cache name in sw.js together
- [ ] Added any new file to the sw.js SHELL list (so it is cached/offline)
- [ ] [CRITICAL] sw.js diff-read (it is a persistent man-in-the-middle for the origin)
- [ ] [CRITICAL] CSP / index.html `<head>` diff-read (no new inline script holes)
- [ ] [CRITICAL] assetlinks.json (TWA): SHA-256 == the Play **App Signing** key, not the upload key
- [ ] Grep the diff for `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `eval` / `document.write` on any user data
- [ ] Decode the My Card QR once (it broke silently before; cv2 or a phone scan)
- [ ] Drive sync round-trips on a clean profile (export -> import / sync)
- [ ] Opt-in telemetry (if/when added) still OFF by default
- [ ] Manual install-as-PWA + offline launch on a real Android device (CI cannot fake this)
- [ ] WhatsApp / Calendar deep-link hand-off works inside the TWA on a real device

## After deploy
- [ ] Poll the live `app.js` VERSION to confirm the deploy went live
- [ ] Spot-check the live site loads + Today renders
