import { test, expect } from '@playwright/test';

// Regression guard for the TIER-3 IMPORT INVARIANT (Concept C, Phase 1).
//
// The promise: a bulk import never creates an obligation. Everyone who arrives via an
// import lands in the directory (tier 3, cadence null) and only a deliberate choice
// promotes someone to a tier that carries a cadence. And it is FORWARD-ONLY: an import
// must never re-tier a person who is already in the book.
//
// These call the REAL in-page onFile()/doImport() rather than a copy of the logic, so a
// future edit cannot silently reintroduce the "import 2500 people, inherit 2500 monthly
// obligations" problem that this phase exists to kill. There is no migration system and
// DB.v gates nothing, so a re-tier that ships is not un-shippable.

test.beforeEach(async ({ page }) => { await page.goto('/app.html#import'); });

// Seed the book, stage a preview exactly as given, run the real doImport(), hand back the book.
async function importInto(page, existing, previewRows) {
  return page.evaluate(([ex, rows]) => {
    DB.contacts = ex;
    window._obFlow = false;
    window._imp = rows;
    doImport();
    return DB.contacts;
  }, [existing, previewRows]);
}

test('the file-import preview defaults every row to tier 3', async ({ page }) => {
  // drives the real onFile() -> parseCSV() -> preview path, not a hand-built _imp
  await page.evaluate(() => {
    const csv = 'Name,Phone,E-mail 1\n'
      + 'Ada Lovelace,+441234567890,ada@example.com\n'
      + 'Grace Hopper,+441234567891,grace@example.com\n';
    const f = new File([csv], 'contacts.csv', { type: 'text/csv' });
    window._imp = null;
    window.onFile({ target: { files: [f] } });
  });
  await page.waitForFunction(() => Array.isArray(window._imp) && window._imp.length > 0);
  const tiers = await page.evaluate(() => window._imp.map(r => r._tier));
  expect(tiers.length, 'the CSV must actually have parsed, or this test proves nothing').toBe(2);
  expect(tiers, 'an imported batch must arrive as directory entries').toEqual([3, 3]);
});

test('end to end: a real CSV import writes people as tier 3 with no cadence', async ({ page }) => {
  // the whole user journey in one guard: real onFile() -> real preview -> real doImport().
  // Nothing here stages a tier, so it fails the moment any link in that chain reverts to 2.
  await page.evaluate(() => {
    const csv = 'Name,Phone\nAda Lovelace,+441234567890\nGrace Hopper,+441234567891\n';
    DB.contacts = [];
    window._obFlow = false;
    window._imp = null;
    window.onFile({ target: { files: [new File([csv], 'contacts.csv', { type: 'text/csv' })] } });
  });
  await page.waitForFunction(() => Array.isArray(window._imp) && window._imp.length === 2);
  const book = await page.evaluate(() => { doImport(); return DB.contacts; });
  expect(book).toHaveLength(2);
  expect(book.map(c => c.tier), 'imported people belong in the directory').toEqual([3, 3]);
  expect(book.map(c => c.cadence), 'tier 3 must carry no recurring obligation').toEqual([null, null]);
});

test('a row with no tier at all still falls back to 3, never 2', async ({ page }) => {
  // guards the doImport() fallback itself (tier:r._tier||3) in case a future caller
  // stages preview rows without stamping _tier
  const book = await importInto(page, [], [{ _keep: true, name: 'Grace', phone: '+441234567891' }]);
  expect(book[0].tier, 'the fallback must not quietly re-open the tier-2 firehose').toBe(3);
  expect(book[0].cadence).toBeNull();
});

test('a deliberate promotion in the preview is still honoured', async ({ page }) => {
  // the tier dropdown must keep working: this phase removes the DEFAULT obligation,
  // it does not remove the ability to choose one
  const book = await importInto(page, [], [
    { _keep: true, _tier: 1, name: 'Inner', phone: '+441111111111' },
    { _keep: true, _tier: 2, name: 'Warm', phone: '+442222222222' },
  ]);
  const inner = book.find(c => c.name === 'Inner');
  const warm = book.find(c => c.name === 'Warm');
  expect([inner.tier, inner.cadence], 'explicit inner circle keeps its 3-month cadence').toEqual([1, 3]);
  expect([warm.tier, warm.cadence], 'explicit keep-warm keeps its 6-month cadence').toEqual([2, 6]);
});

test('FORWARD-ONLY: importing does not re-tier people already in the book', async ({ page }) => {
  const existing = [
    { id: 'a', name: 'Old Inner', phone: '+449999999999', tier: 1, cadence: 3, log: [], customDates: [] },
    { id: 'b', name: 'Old Warm', phone: '+448888888888', tier: 2, cadence: 6, log: [], customDates: [] },
  ];
  const book = await importInto(page, existing, [{ _keep: true, _tier: 3, name: 'New Person', phone: '+441234567890' }]);
  const a = book.find(c => c.id === 'a');
  const b = book.find(c => c.id === 'b');
  expect([a.tier, a.cadence], 'an existing inner-circle tie must survive an import untouched').toEqual([1, 3]);
  expect([b.tier, b.cadence], 'an existing keep-warm tie must survive an import untouched').toEqual([2, 6]);
});

test('FORWARD-ONLY: re-importing someone you already have does not demote them', async ({ page }) => {
  // the dedupe path (match on normalized phone) updates blank fields in place; it must
  // never write tier, or a routine re-sync would silently strip a real cadence
  const existing = [
    { id: 'a', name: 'Ada Lovelace', phone: '+441234567890', email: '', tier: 1, cadence: 3, log: [], customDates: [] },
  ];
  const book = await importInto(page, existing, [
    { _keep: true, _tier: 3, name: 'Ada Lovelace', phone: '+441234567890', email: 'ada@example.com' },
  ]);
  expect(book, 'the dedupe must still merge rather than duplicate').toHaveLength(1);
  expect(book[0].email, 'a blank field should still fill in from the import').toBe('ada@example.com');
  expect([book[0].tier, book[0].cadence], 're-syncing must not demote an existing tie').toEqual([1, 3]);
});
