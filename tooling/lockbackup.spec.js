import { test, expect } from '@playwright/test';

// v0.71.0 regression guards (audit 2026-08-01, tests-High 4): App Lock PIN/cooldown and the encrypted
// backup round-trip had zero coverage on security-relevant logic. Real in-page functions throughout;
// the backup test drives the REAL export download and re-imports the same file.

test('PIN: right unlocks, wrong fails, config survives in its own key', async ({ page }) => {
  await page.goto('/app.html#today');
  const r = await page.evaluate(async () => {
    await lockSetPin('4821');
    return { right: await lockVerifyPin('4821'), wrong: await lockVerifyPin('0000'), empty: await lockVerifyPin(''), cfg: !!localStorage.getItem('warmly.lock') };
  });
  expect(r.right, 'correct PIN must verify').toBe(true);
  expect(r.wrong, 'wrong PIN must fail closed').toBe(false);
  expect(r.empty, 'empty PIN must fail closed').toBe(false);
  expect(r.cfg, 'lock config must persist outside the DB key').toBe(true);
});

test('cooldown: active lockout blocks, expiry unblocks, failure state persists', async ({ page }) => {
  await page.goto('/app.html#today');
  const r = await page.evaluate(() => {
    lockFailSet({ n: 5, until: Date.now() + 60000 });
    const during = lockCoolMsg();
    lockFailSet({ n: 5, until: Date.now() - 1000 });
    const after = lockCoolMsg();
    return { during, after, persisted: JSON.parse(localStorage.getItem('warmly.lockfail')).n };
  });
  expect(r.during, 'an active cooldown must report blocking').toBe(true);
  expect(r.after, 'an expired cooldown must not block').toBe(false);
  expect(r.persisted, 'failure count must survive a reload attempt').toBe(5);
});

test('encrypted backup: export then import round-trips the DB; wrong passphrase restores nothing', async ({ page }, testInfo) => {
  await page.goto('/app.html#settings/data');
  await page.evaluate(() => { DB.contacts.push({ id: 'enc1', name: 'Cipher Cass', tier: 1, updatedAt: 1 }); save(); });

  const prompts = ['pw-correct-horse'];
  page.on('dialog', d => { d.type() === 'prompt' ? d.accept(prompts.shift() || '') : d.accept(); });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => exportEnc())
  ]);
  const file = testInfo.outputPath('backup.enc');
  await download.saveAs(file);

  // wipe, then restore with the RIGHT passphrase
  await page.evaluate(() => { DB.contacts = []; save(); });
  prompts.push('pw-correct-horse');
  await page.locator('input[type=file]').first().setInputFiles(file);
  await expect.poll(() => page.evaluate(() => DB.contacts.some(c => c.id === 'enc1')), { message: 'restore must bring the contact back' }).toBe(true);

  // wipe again, then a WRONG passphrase must restore nothing (AES-GCM auth failure)
  await page.goto('/app.html#settings/data');
  await page.evaluate(() => { DB.contacts = []; save(); });
  prompts.push('pw-wrong');
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.waitForTimeout(800); // give the (expected-to-fail) decrypt a moment
  expect(await page.evaluate(() => DB.contacts.length), 'wrong passphrase must not restore data').toBe(0);
});
