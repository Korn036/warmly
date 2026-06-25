import { test, expect } from '@playwright/test';

// 1) The app boots and renders the Today view with no uncaught error.
test('app boots and renders Today', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await expect(page.locator('#app')).toContainText(/Today|No one here yet|Import/i, { timeout: 10000 });
  expect(errors, 'no uncaught page errors on boot').toEqual([]);
});

// 2) The service worker API is present and registration does not throw.
test('service worker registers without error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  const ok = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    try { await navigator.serviceWorker.getRegistration(); return true; } catch { return false; }
  });
  expect(ok, 'serviceWorker API usable').toBeTruthy();
  expect(errors).toEqual([]);
});

// 3) XSS-render guard for the #1 client-side risk: a contact whose NAME is a
//    malicious payload must render as escaped TEXT and never execute. This
//    regression-guards the esc() discipline on every push.
test('XSS-render guard: malicious contact name does not execute', async ({ page }) => {
  await page.addInitScript(() => {
    const payload = '<img src=x onerror="window.__xss=1">';
    const DB = {
      v: 1,
      templates: [],
      settings: { myName: '', country: '44', leadDays: 1, localTouch: true },
      contacts: [{ id: 'x1', name: payload, callName: 'x', tier: 2 }],
    };
    localStorage.setItem('kith.v1', JSON.stringify(DB));
  });
  await page.goto('/index.html#people');
  await page.waitForTimeout(1500);
  const xss = await page.evaluate(() => window.__xss);
  expect(xss, 'onerror must NOT fire; user data must be escaped').toBeUndefined();
});
