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

// v0.71.0 regression guards (audit 2026-08-01, Critical-1): the eight array fields that used to fall
// through to whole-object newer-wins. Each test fails on pre-fix mergeDB (verified by mutation check).

test('gift added on the older device survives a newer scalar edit on the other device', async ({ page }) => {
  const local = { contacts: [{ id: 'x', updatedAt: 1, gifts: [{ id: 'g1', desc: 'book', status: 'idea' }] }], deleted: {}, savedAt: 1 };
  const remote = { contacts: [{ id: 'x', updatedAt: 2, context: 'met at expo' }], deleted: {}, savedAt: 2 };
  const out = await merge(page, local, remote);
  expect(out.contacts[0].context, 'newer scalar must still win').toBe('met at expo');
  expect((out.contacts[0].gifts || []).map(g => g.id), 'older side gift must survive').toEqual(['g1']);
});

test('tags, children, pets, customDates union across devices', async ({ page }) => {
  const local = { contacts: [{ id: 'x', updatedAt: 2, tags: ['uni'], children: [{ name: 'Mia', age: '4' }], customDates: [{ label: 'work anniversary', m: 3, d: 4 }] }], deleted: {}, savedAt: 2 };
  const remote = { contacts: [{ id: 'x', updatedAt: 1, tags: ['climbing'], pets: [{ name: 'Rex', kind: 'dog' }], customDates: [{ label: 'moved abroad', m: 7, d: 1 }] }], deleted: {}, savedAt: 1 };
  const out = await merge(page, local, remote);
  const c = out.contacts[0];
  expect(c.tags.sort(), 'tags from both devices').toEqual(['climbing', 'uni']);
  expect(c.children.map(k => k.name), 'children survive').toEqual(['Mia']);
  expect(c.pets.map(p => p.name), 'pets from the older side survive').toEqual(['Rex']);
  expect(c.customDates.map(d => d.label).sort(), 'custom reminders union').toEqual(['moved abroad', 'work anniversary']);
});

test('same task id on both sides: the newer contact side wins the collision (done state kept)', async ({ page }) => {
  const local = { contacts: [{ id: 'x', updatedAt: 1, tasks: [{ id: 't1', text: 'call back', done: false }] }], deleted: {}, savedAt: 1 };
  const remote = { contacts: [{ id: 'x', updatedAt: 2, tasks: [{ id: 't1', text: 'call back', done: true }] }], deleted: {}, savedAt: 2 };
  const out = await merge(page, local, remote);
  expect(out.contacts[0].tasks, 'no duplicate task rows').toHaveLength(1);
  expect(out.contacts[0].tasks[0].done, 'newer side done state must win').toBe(true);
});

test('fields empty on both sides stay absent, not empty arrays (DB size guard)', async ({ page }) => {
  const local = { contacts: [{ id: 'x', updatedAt: 2, name: 'A' }], deleted: {}, savedAt: 2 };
  const remote = { contacts: [{ id: 'x', updatedAt: 1, name: 'A' }], deleted: {}, savedAt: 1 };
  const out = await merge(page, local, remote);
  for (const f of ['tags', 'children', 'pets', 'activities', 'tasks', 'gifts', 'debts', 'customDates'])
    expect(f in out.contacts[0], f + ' must not be materialized as []').toBe(false);
});

test('a restored contact (freshly stamped) beats a stale tombstone', async ({ page }) => {
  // mirrors the restore path: contact stamped now, so a pre-existing tombstone can't re-delete it
  const now = Date.now();
  const out = await merge(page,
    { contacts: [{ id: 'r', updatedAt: now }], deleted: {} },
    { contacts: [], deleted: { r: now - 5000 } });
  expect(out.contacts.find(c => c.id === 'r'), 'restore must survive an older tombstone').toBeTruthy();
});
