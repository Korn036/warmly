import { test, expect } from '@playwright/test';

// The APP shell is app.html (served at /app). index.html is the marketing LANDING.
// Before the v0.59 landing/app split these tests pointed at /index.html, so the boot
// check failed every push and the XSS guard was vacuous (the landing never renders
// contacts). They now target /app.html so the whole browser-level net is real again.

// 1) The app boots and renders the Today view with no uncaught error.
test('app boots and renders Today', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app.html#today');
  await expect(page.locator('#app')).toContainText(/Today|circle|Add|Import|caught up/i, { timeout: 10000 });
  expect(errors, 'no uncaught page errors on boot').toEqual([]);
});

// 2) The service worker API is present and registration does not throw.
test('service worker registers without error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/app.html');
  const ok = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    try { await navigator.serviceWorker.getRegistration(); return true; } catch { return false; }
  });
  expect(ok, 'serviceWorker API usable').toBeTruthy();
  expect(errors).toEqual([]);
});

// 3) XSS-render guard for the #1 client-side risk. Two payloads: a contact NAME
//    (must render as escaped text) and a LinkedIn field (must never become a
//    javascript: href — regression-guards the v0.63 safeUrl fix). Neither may execute.
test('XSS-render guard: malicious contact fields never execute', async ({ page }) => {
  await page.addInitScript(() => {
    const DB = {
      v: 1, templates: [], deleted: {}, savedAt: 1,
      settings: { myName: '', country: '91', leadDays: 1, localTouch: true },
      contacts: [{
        id: 'x1', name: '<img src=x onerror="window.__xss=1">', callName: 'x', tier: 2,
        linkedin: 'javascript:window.__xss=2', updatedAt: 1,
      }],
    };
    localStorage.setItem('kith.v1', JSON.stringify(DB));
  });
  await page.goto('/app.html#person/x1');
  await page.waitForTimeout(1200);
  const xss = await page.evaluate(() => window.__xss);
  expect(xss, 'no injected payload may execute').toBeUndefined();
  const liHref = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => /profile/i.test(x.textContent || ''));
    return a ? a.getAttribute('href') : '';
  });
  expect(liHref, 'linkedin href must be an https scheme, not javascript:').toMatch(/^https:\/\//);
});

// 4) The landing page itself renders its hero and throws no uncaught error.
test('landing page renders without error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await expect(page.locator('body')).toContainText(/Sovenn/i, { timeout: 10000 });
  expect(errors, 'no uncaught page errors on the landing').toEqual([]);
});
