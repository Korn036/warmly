import { test, expect } from '@playwright/test';

// v0.71.0 regression guards (audit 2026-08-01, Critical-2): the iOS Add-to-Home-Screen nudge must
// show for iOS-Safari-tab users once contacts exist, be dismissible, stay dismissed, and never show
// on non-iOS browsers.

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

test.describe('on iPhone Safari (browser tab)', () => {
  test.use({ userAgent: IPHONE_UA });

  test('nudge appears once contacts exist, dismiss sticks across reload', async ({ page }) => {
    await page.goto('/app.html#today');
    await expect(page.locator('.ios-nudge'), 'no contacts yet, nothing to lose, no nudge').toHaveCount(0);
    await page.evaluate(() => { DB.contacts.push({ id: 'a', name: 'Amma', tier: 1, updatedAt: Date.now() }); save(); route(); });
    await expect(page.locator('.ios-nudge')).toContainText('Add to Home Screen');
    await page.click('.ios-nudge >> text=Got it');
    await expect(page.locator('.ios-nudge')).toHaveCount(0);
    await page.reload();
    await page.goto('/app.html#today');
    await expect(page.locator('.ios-nudge'), 'dismissal must persist on this device').toHaveCount(0);
  });

  test('durability line shows in Settings > Sync and backup', async ({ page }) => {
    await page.goto('/app.html#settings/data');
    await expect(page.locator('main')).toContainText('Add Sovenn to your Home Screen');
  });
});

test('no nudge on non-iOS browsers', async ({ page }) => {
  await page.goto('/app.html#today');
  await page.evaluate(() => { DB.contacts.push({ id: 'a', name: 'Amma', tier: 1, updatedAt: Date.now() }); save(); route(); });
  await expect(page.locator('.ios-nudge')).toHaveCount(0);
});
