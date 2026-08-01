import { test, expect } from '@playwright/test';

// v0.71.0 regression guards (audit 2026-08-01, Critical-3): a quota-failed save must never fake
// success. Simulates QuotaExceededError by making writes to the DB key throw while _failWrites is on,
// then drives the REAL quick-add UI so the rollback + savebar + retry behavior is what users get.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (window._failWrites && k === 'kith.v1') { const e = new Error('QuotaExceededError (simulated)'); e.name = 'QuotaExceededError'; throw e; }
      return orig.call(this, k, v);
    };
  });
  await page.goto('/app.html#today');
});

test('quota-failed quick add: no navigation, no ghost contact, persistent savebar; retry succeeds', async ({ page }) => {
  page.on('dialog', d => d.accept()); // the first failure still raises the blocking alert
  await page.evaluate(() => { window._failWrites = true; window.quickAdd(); });
  await page.fill('#qa_name', 'Quota Test');
  await page.click('text=Add person');
  await expect(page.locator('#savebar'), 'persistent banner must appear').toContainText('not saved');
  expect(page.url(), 'must not navigate to the person page on a failed save').not.toContain('person');
  const inMemory = await page.evaluate(() => DB.contacts.filter(c => c.name === 'Quota Test').length);
  expect(inMemory, 'failed add must be rolled back so a retry cannot duplicate').toBe(0);

  await page.evaluate(() => { window._failWrites = false; });
  await page.click('text=Add person');
  await expect(page.locator('#savebar'), 'banner must clear once a save lands').toHaveCount(0);
  expect(page.url()).toContain('person');
  const onDisk = await page.evaluate(() => JSON.parse(localStorage.getItem('kith.v1')).contacts.filter(c => c.name === 'Quota Test').length);
  expect(onDisk, 'retry must really persist to disk').toBe(1);
});

test('soft storage meter warns before the wall and can be snoozed', async ({ page }) => {
  await page.evaluate(() => {
    DB.contacts.push({ id: 'big', name: 'Big', notes: [{ id: 'n', text: 'x'.repeat(4000001) }] });
    save();
  });
  await expect(page.locator('#savebar'), 'meter must warn above the threshold').toContainText('Back up now');
  await page.click('#savebar >> text=Later');
  await expect(page.locator('#savebar')).toHaveCount(0);
});
