import { test, expect } from '@playwright/test';

// v0.71.0 regression guards (audit 2026-08-01, tests-Critical): the notification delivery path had
// ZERO coverage despite a documented past incident where the daily nudge was silently dead on every
// Play-install device. These tests pin the SW-first behavior, the 3s never-ready constructor
// fallback, and the permission gate, using the REAL in-page SovennNotify.notify().

test('prefers ServiceWorkerRegistration.showNotification when the SW is ready', async ({ page }) => {
  await page.addInitScript(() => {
    window._swCalls = 0; window._ctorCalls = 0;
    ServiceWorkerRegistration.prototype.showNotification = function () { window._swCalls++; return Promise.resolve(); };
    // permission stubbed to granted so the test pins OUR routing logic, not Chromium's permission plumbing
    window.Notification = class { constructor () { window._ctorCalls++; } static get permission () { return 'granted'; } static requestPermission () { return Promise.resolve('granted'); } };
  });
  await page.goto('/app.html#today');
  await page.evaluate(() => navigator.serviceWorker.ready); // wait until the SW path is live
  const shown = await page.evaluate(() => SovennNotify.notify({ title: 'Sovenn', body: 'guard', tag: 'digest' }));
  expect(shown, 'notify() must report success').toBe(true);
  const calls = await page.evaluate(() => ({ sw: window._swCalls, ctor: window._ctorCalls }));
  expect(calls.sw, 'must go through the SW (the only path that works on Android PWA/TWA)').toBe(1);
  expect(calls.ctor, 'must NOT also fire the page constructor (duplicate)').toBe(0);
});

test('falls back to the page constructor when serviceWorker.ready never resolves', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window._ctorCalls = 0;
    Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: () => new Promise(() => {}) });
    window.Notification = class { constructor () { window._ctorCalls++; } static get permission () { return 'granted'; } static requestPermission () { return Promise.resolve('granted'); } };
  });
  await page.goto('/app.html#today');
  const pending = page.evaluate(() => SovennNotify.notify({ title: 'Sovenn', body: 'guard' }));
  await page.clock.runFor(3500); // jump past the 3s never-ready timeout without a real wait
  expect(await pending, 'fallback must still deliver').toBe(true);
  expect(await page.evaluate(() => window._ctorCalls), 'constructor fallback must have fired exactly once').toBe(1);
});

test('resolves false without touching any API when permission is not granted', async ({ page }) => {
  await page.addInitScript(() => {
    window._ctorCalls = 0;
    window.Notification = class { constructor () { window._ctorCalls++; } static get permission () { return 'denied'; } };
  });
  await page.goto('/app.html#today');
  expect(await page.evaluate(() => SovennNotify.notify({ title: 'x' }))).toBe(false);
  expect(await page.evaluate(() => window._ctorCalls)).toBe(0);
});
