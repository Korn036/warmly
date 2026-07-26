import { test, expect } from '@playwright/test';

// Regression guard for the onboarding SPOTLIGHT screen (Concept C, Phase 2, Unit C):
// step 3 ("circle") of the onboarding wizard, rendered by viewOnboard('circle') into
// #obSpotList via obSpotListHTML(q) in app.js.
//
// The contract under test:
//   - #obSpotQ is the search input, .ob-search its wrapper, #obSpotList the row container.
//   - each row is button.ob-person (plus .sel when tier===1), holding span.nm (name),
//     an optional sub-line, and span.heart (heart-full when tier 1, heart-empty otherwise).
//     The row's onclick calls obTogglePin('<id>').
//   - sub-line: a genuine SovennShuffle ranking reason renders as span.rel.why; a
//     user-entered context line (no genuine reason) renders as span.rel with no "why"
//     class; a contact with neither renders no sub-line at all.
//   - an empty query renders a 6-row shortlist (mode:'directory'); a non-empty query
//     filters the FULL directory with no cap, ranked the same way.
//   - the ranking invariant: every span.rel.why row sorts above every row without one.
//
// This is the ONLY way to test this screen: app.js has no unit-test seam, so these
// drive the real in-page functions (obSpotListHTML via render, obTogglePin, obSpotFilter)
// through a live browser exactly like tier.spec.js and merge.spec.js do.
//
// Local-harness note: the app shell 200s at /app.html on the plain python http.server this
// suite's webServer runs (see playwright.config.js). "/app" only clean-URL-maps to it on the
// real Cloudflare deploy (sw.js precaches literal 'app', which 404s locally, harmlessly, via
// Promise.allSettled). tier.spec.js, merge.spec.js and smoke.spec.js all navigate to
// /app.html for exactly this reason, so these tests match that idiom rather than /app.

const STORAGE_KEY = 'kith.v1'; // re-verified against app.js's `const KEY='kith.v1'` (line 8) just now, not assumed from memory

// ---------------------------------------------------------------------------
// Fixture: 500 directory contacts, one of them ("Zzz FindMe500") planted at the
// very end of the array AND sorted last alphabetically, so it can never ride into
// the default 6-row shortlist and is reachable ONLY by typing a search that matches it.
// This is the exact shape of the old slice(0,40) bug: with 500 contacts, anyone past
// position 40 in array order was permanently unreachable no matter what you typed.
// ---------------------------------------------------------------------------
const TOTAL = 500;
const TARGET_ID = 'c500';
const TARGET_NAME = 'Zzz FindMe500';

function makeDirectory500(){
  const contacts = [];
  for (let i = 1; i <= TOTAL; i++) {
    if (i === TOTAL) {
      contacts.push({ id: TARGET_ID, name: TARGET_NAME, tier: 3, cadence: null, log: [], customDates: [] });
    } else {
      contacts.push({ id: 'c' + i, name: 'Person ' + String(i).padStart(4, '0'), tier: 3, cadence: null, log: [], customDates: [] });
    }
  }
  return contacts;
}

// Seeds kith.v1 in localStorage BEFORE the page's own scripts run (same idiom as
// smoke.spec.js's XSS guard), then navigates straight to step 3. app.js's `let DB = load()`
// reads this seed synchronously at script-eval time, so the circle step renders from it
// on the very first paint, no extra route() nudge required.
async function seedDirectoryAndGoto(page, contacts){
  const seed = { v: 1, contacts, templates: [], settings: { myName: 'Tester', country: '91', leadDays: 1, localTouch: true } };
  await page.addInitScript(([key, db]) => { localStorage.setItem(key, JSON.stringify(db)); }, [STORAGE_KEY, seed]);
  await page.goto('/app.html#onboard/circle');
}

// Lighter-weight setup for fixtures that do not need the 500-scale seed or the storage
// round-trip: mirrors tier.spec.js's openTidy() idiom (goto first, since viewOnboard falls
// back to the import step while DB.contacts is still empty, then stamp DB and re-route).
async function openCircleWith(page, contacts){
  await page.goto('/app.html#onboard/circle');
  await page.evaluate((cs) => { DB.contacts = cs; route(); }, contacts);
}

// Reads tiers back out of the PERSISTED store (not just the in-page DB object), so a
// "no mutation" assertion is proving nothing changed on disk, not just that the in-memory
// object still looks right. obTogglePin is the only place this screen ever sets .tier, and
// it always pairs that with save(), so a real bug here would show up here too.
async function storageTiers(page){
  return page.evaluate((key) => {
    const d = JSON.parse(localStorage.getItem(key));
    return d.contacts.map((c) => [c.id, c.tier]);
  }, STORAGE_KEY);
}

test('search reaches contact 500: the full directory has no cap on a non-empty query', async ({ page }) => {
  const contacts = makeDirectory500();
  await seedDirectoryAndGoto(page, contacts);
  await page.locator('#obSpotQ').fill('FindMe500');
  const row = page.locator('#obSpotList button.ob-person', { hasText: TARGET_NAME });
  await expect(row, 'contact 500 must be reachable by search, or the slice(0,40)-class bug is back').toBeVisible();
  await expect(row).toBeEnabled();
});

test('no tier mutation from merely rendering the shortlist', async ({ page }) => {
  const contacts = makeDirectory500();
  await seedDirectoryAndGoto(page, contacts);
  // empty query -> the 6-row shortlist; wait for it so the snapshot is taken post-render, not mid-render
  await expect(page.locator('#obSpotList .ob-person')).toHaveCount(6);
  const after = await storageTiers(page);
  const expected = contacts.map((c) => [c.id, c.tier]);
  expect(after, 'opening the screen must never itself change anyone\'s tier').toEqual(expected);
});

test('no tier mutation from typing, clearing, and retyping searches', async ({ page }) => {
  const contacts = makeDirectory500();
  await seedDirectoryAndGoto(page, contacts);
  await expect(page.locator('#obSpotList .ob-person')).toHaveCount(6);

  const q = page.locator('#obSpotQ');
  await q.fill('Person 0001');
  await expect(page.locator('#obSpotList button.ob-person', { hasText: 'Person 0001' })).toBeVisible();
  await q.fill('Person 0250');
  await expect(page.locator('#obSpotList button.ob-person', { hasText: 'Person 0250' })).toBeVisible();
  await q.fill('');
  await expect(page.locator('#obSpotList .ob-person')).toHaveCount(6);
  await q.fill('FindMe500');
  await expect(page.locator('#obSpotList button.ob-person', { hasText: TARGET_NAME })).toBeVisible();
  await q.fill('');
  await expect(page.locator('#obSpotList .ob-person')).toHaveCount(6);

  const after = await storageTiers(page);
  const expected = contacts.map((c) => [c.id, c.tier]);
  expect(after, 'searching, clearing and retyping must never itself change anyone\'s tier').toEqual(expected);
});

test('no tier mutation from scrolling the results list', async ({ page }) => {
  const contacts = makeDirectory500();
  await seedDirectoryAndGoto(page, contacts);
  // a query that returns many rows (all 499 fillers, not the target) so there is real
  // scroll distance in the .ob overlay, which is the actual overflow-y:auto container
  await page.locator('#obSpotQ').fill('Person');
  await expect(page.locator('#obSpotList .ob-person')).toHaveCount(499);
  await page.evaluate(() => {
    const el = document.querySelector('.ob');
    if (el) el.scrollTop = el.scrollHeight;
  });
  const after = await storageTiers(page);
  const expected = contacts.map((c) => [c.id, c.tier]);
  expect(after, 'scrolling the list must never itself change anyone\'s tier').toEqual(expected);
});

test('an explicit tap promotes exactly the tapped contact and nothing else', async ({ page }) => {
  const contacts = makeDirectory500();
  await seedDirectoryAndGoto(page, contacts);
  await page.locator('#obSpotQ').fill('FindMe500');
  const row = page.locator('#obSpotList button.ob-person', { hasText: TARGET_NAME });
  await expect(row).toBeVisible();
  await row.locator('.heart').click();

  await expect(row, 'a tapped row must gain .sel').toHaveClass(/\bsel\b/);
  await expect(row.locator('.heart'), 'a tapped heart must fill in').toHaveText('♥');

  const after = await storageTiers(page);
  const afterMap = new Map(after);
  expect(afterMap.get(TARGET_ID), 'the tapped contact must become tier 1').toBe(1);

  const expectedOthers = contacts.filter((c) => c.id !== TARGET_ID).map((c) => [c.id, c.tier]);
  const actualOthers = after.filter(([id]) => id !== TARGET_ID);
  expect(actualOthers, 'a single tap must never move any OTHER contact\'s tier').toEqual(expectedOthers);
});

test('an empty query renders exactly six rows, the shortlist cap', async ({ page }) => {
  // small, varied-name fixture; the cap is independent of total directory size as long
  // as there are at least 6 to choose from
  const contacts = [];
  for (let i = 1; i <= 12; i++) contacts.push({ id: 's' + i, name: 'Shortlist Person ' + i, tier: 3, cadence: null, log: [], customDates: [] });
  await openCircleWith(page, contacts);
  await expect(page.locator('#obSpotList .ob-person'), 'an empty query must render exactly 6 rows, never more').toHaveCount(6);
});

test('reason-band order: every real-reason row sorts above every reasonless row', async ({ page }) => {
  // 5 contacts with a genuine upcoming-birthday signal (SovennShuffle.hasRealReason -> true,
  // so obSpotListHTML must mark their sub-line span.rel.why) mixed with 5 contacts that have
  // no bday/cadence/lastContacted/context at all (no genuine reason, no sub-line). A shared
  // name fragment lets one search pull all 10 back together with no cap, so the invariant is
  // checked across the real ranked set, not just whatever happens to land in the 6-row cap.
  function addDaysMD(n){
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n);
    return { m: d.getMonth() + 1, d: d.getDate() };
  }
  const contacts = [];
  for (let i = 1; i <= 5; i++) contacts.push({ id: 'plain' + i, name: 'Zzz8Band Plain ' + i, tier: 3, cadence: null, log: [], customDates: [] });
  const offsets = [2, 4, 6, 8, 10]; // all inside SovennShuffle's 14-day event window
  for (let i = 1; i <= 5; i++) contacts.push({ id: 'bday' + i, name: 'Zzz8Band Bday ' + i, tier: 3, cadence: null, log: [], customDates: [], bday: addDaysMD(offsets[i - 1]) });

  await openCircleWith(page, contacts);
  await page.locator('#obSpotQ').fill('Zzz8Band');
  await expect(page.locator('#obSpotList .ob-person')).toHaveCount(10);

  const hasWhy = await page.evaluate(() => [...document.querySelectorAll('#obSpotList .ob-person')].map((el) => !!el.querySelector('.rel.why')));
  expect(hasWhy.includes(true), 'the fixture must produce at least one real-reason row or this test proves nothing').toBe(true);
  expect(hasWhy.includes(false), 'the fixture must produce at least one reasonless row or this test proves nothing').toBe(true);

  const firstReasonless = hasWhy.indexOf(false);
  const tailAfterFirstReasonless = hasWhy.slice(firstReasonless);
  expect(tailAfterFirstReasonless.every((v) => v === false), 'once a reasonless row appears, no real-reason row may appear below it in the DOM (above it visually is earlier in the list)').toBe(true);
});
