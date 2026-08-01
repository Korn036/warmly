import { test, expect } from '@playwright/test';

// v0.71.0 regression guards (audit 2026-08-01, tests-High 2+3): Drive sync orchestration and People
// sync failure branches had zero coverage; both had already shipped silent-failure fixes with no
// guard. All Google endpoints are stubbed with page.route(); the REAL syncNow()/syncGoogleContacts()
// run in-page.

const REMOTE_DB = { v: 1, contacts: [{ id: 'r1', name: 'Remote Rhea', tier: 2, updatedAt: 5 }], deleted: {}, savedAt: 5 };

function stubDrive (page, { uploadStatus = 200 } = {}) {
  return page.route('https://www.googleapis.com/**', route => {
    const url = route.request().url();
    if (url.includes('alt=media')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REMOTE_DB) });
    if (url.includes('/upload/')) return route.fulfill({ status: uploadStatus, contentType: 'application/json', body: JSON.stringify({ id: 'f1' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{ id: 'f1' }] }) });
  });
}

async function armDrive (page) {
  await page.goto('/app.html#settings/data');
  // gToken stubbed to a failed silent refresh so gFetch's 401 retry path returns the 401 to syncNow
  // instead of throwing on the absent GIS library in the test browser.
  await page.evaluate(() => { _gtok = 'test-token'; _gfile = null; gToken = () => Promise.resolve(null); });
}

test('happy path: remote contacts merge in, upload lands, status says Synced', async ({ page }) => {
  await stubDrive(page);
  await armDrive(page);
  await page.evaluate(() => syncNow());
  await expect(page.locator('#gstat')).toContainText('Synced');
  const onDisk = await page.evaluate(() => JSON.parse(localStorage.getItem('kith.v1')).contacts.some(c => c.id === 'r1'));
  expect(onDisk, 'merged remote contact must be persisted, not just in memory').toBe(true);
});

test('401 on upload: token cleared, honest re-sign-in message, no retry loop', async ({ page }) => {
  await stubDrive(page, { uploadStatus: 401 });
  await armDrive(page);
  await page.evaluate(() => syncNow());
  await expect(page.locator('#gstat')).toContainText('Sign in again');
  expect(await page.evaluate(() => _gtok), 'expired token must be dropped').toBeNull();
});

test('404 on upload: file id reset so the next sync recreates the backup', async ({ page }) => {
  await stubDrive(page, { uploadStatus: 404 });
  await armDrive(page);
  await page.evaluate(() => { _gfile = 'f1'; return syncNow(); });
  await expect(page.locator('#gstat')).toContainText('saved on this device');
  expect(await page.evaluate(() => _gfile), 'vanished remote file id must be cleared').toBeNull();
});

test('local persist failure during sync: never claims Synced', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (window._failWrites && k === 'kith.v1') { const e = new Error('QuotaExceededError (simulated)'); e.name = 'QuotaExceededError'; throw e; }
      return orig.call(this, k, v);
    };
  });
  await stubDrive(page);
  await armDrive(page);
  await page.evaluate(() => { window._failWrites = true; return syncNow(); });
  await expect(page.locator('#gstat')).toContainText('Storage full');
});

// ---- People (contacts import) sync ----

test('D1: each auth failure reason gets its own actionable message', async ({ page }) => {
  await page.goto('/app.html#import');
  const cases = [
    ['popup_closed', 'closed before it finished'],
    ['popup_failed_to_open', 'blocked'],
    ['timeout', 'didn’t respond in time'],
    ['whatever_else', 'didn’t work']
  ];
  for (const [reason, expected] of cases) {
    const msg = await page.evaluate(async (r) => {
      gContactToken = () => Promise.resolve({ error: r });
      let captured = ''; const orig = window.alert; window.alert = m => { captured = String(m); };
      await syncGoogleContacts(); window.alert = orig; return captured;
    }, reason);
    expect(msg, reason + ' must produce its specific guidance').toContain(expected);
  }
});

test('D2: a dropped connection mid-pagination keeps the rows that arrived, honestly labelled', async ({ page }) => {
  let call = 0;
  await page.route('https://people.googleapis.com/**', route => {
    call++;
    if (call === 1) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: [{ names: [{ displayName: 'Page One Priya' }], phoneNumbers: [{ value: '+1 555 0100' }] }], nextPageToken: 'p2' }) });
    return route.abort('connectionreset');
  });
  await page.goto('/app.html#import');
  await page.evaluate(() => { gContactToken = () => Promise.resolve({ access_token: 't' }); return syncGoogleContacts(); });
  const state = await page.evaluate(() => ({ rows: (window._imp || []).length, partial: _impPartial && _impPartial.count }));
  expect(state.rows, 'already-fetched rows must survive the break').toBe(1);
  expect(state.partial, 'partial flag must carry the honest count').toBe(1);
  await expect(page.locator('#preview'), 'preview must admit the list is incomplete').toContainText('incomplete');
});
