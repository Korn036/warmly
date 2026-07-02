import { test, expect } from '@playwright/test';

// Regression guard for the Drive-sync / multi-device merge — the data-loss class fixed in v0.63.
// Calls the REAL in-page mergeDB() so a future edit to the merge logic can't silently reintroduce
// note loss, a broken My Card sync, or tombstone resurrection without turning CI red.

async function merge(page, a, b) {
  return page.evaluate(([x, y]) => mergeDB(x, y), [a, b]);
}

test.beforeEach(async ({ page }) => { await page.goto('/app.html#today'); });

test('offline dual-edit unions notes instead of clobbering', async ({ page }) => {
  const local = { contacts: [{ id: 'x', updatedAt: 2, notes: [{ id: 'n1', text: 'a' }] }], deleted: {}, savedAt: 2 };
  const remote = { contacts: [{ id: 'x', updatedAt: 1, notes: [{ id: 'n2', text: 'b' }] }], deleted: {}, savedAt: 1 };
  const out = await merge(page, local, remote);
  const ids = out.contacts[0].notes.map(n => n.id).sort();
  expect(ids, 'both devices notes must survive').toEqual(['n1', 'n2']);
});

test('newer record wins on scalar fields', async ({ page }) => {
  const local = { contacts: [{ id: 'x', updatedAt: 1, context: 'old' }], deleted: {}, savedAt: 1 };
  const remote = { contacts: [{ id: 'x', updatedAt: 2, context: 'new' }], deleted: {}, savedAt: 2 };
  const out = await merge(page, local, remote);
  expect(out.contacts[0].context).toBe('new');
});

test('My Card (me) propagates to other devices, newest wins', async ({ page }) => {
  const out = await merge(page,
    { contacts: [], me: { name: 'old', updatedAt: 1 }, deleted: {} },
    { contacts: [], me: { name: 'new', updatedAt: 2 }, deleted: {} });
  expect(out.me.name).toBe('new');
});

test('a recent deletion tombstone still removes the contact', async ({ page }) => {
  const out = await merge(page,
    { contacts: [{ id: 'y', updatedAt: 1 }], deleted: {} },
    { contacts: [], deleted: { y: Date.now() } });
  expect(out.contacts.find(c => c.id === 'y')).toBeUndefined();
});

test('tombstones older than 90 days are pruned so DB.deleted cannot grow forever', async ({ page }) => {
  const old = Date.now() - 100 * 24 * 3600 * 1000;
  const out = await merge(page,
    { contacts: [], deleted: { z: old } },
    { contacts: [], deleted: {} });
  expect('z' in out.deleted, 'stale tombstone should be gone').toBe(false);
});

test('a restored contact (freshly stamped) beats a stale tombstone', async ({ page }) => {
  // mirrors the restore path: contact stamped now, so a pre-existing tombstone can't re-delete it
  const now = Date.now();
  const out = await merge(page,
    { contacts: [{ id: 'r', updatedAt: now }], deleted: {} },
    { contacts: [], deleted: { r: now - 5000 } });
  expect(out.contacts.find(c => c.id === 'r'), 'restore must survive an older tombstone').toBeTruthy();
});
