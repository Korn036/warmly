import { test, expect } from '@playwright/test';

// Regression guard for Concept C Phase 4 (copy and palette):
//   - SOV-UX-007: --coral must resolve to the true brand coral #E0552E (rgb(224, 85, 46)),
//     never the undefined-var fallback #F2683C (rgb(242, 104, 60)), anywhere onboarding uses it.
//   - SOV-UX-006: the true empty-state (viewToday() with zero contacts) carries the honest,
//     short "Your directory is quiet." copy, not the old 64-word block.
//   - The deck-empty card on Today must not claim "Everyone is warm" once contacts exist but
//     nobody has been promoted to tier 1 yet (a fresh silent import lands everyone at tier 3).
//   - C1/C2 wizard copy matches the approved mockup verbatim.
//   - The Spotlight (C3) shortlist gets an "A few to start with" kicker only on the default
//     (query-empty) shortlist, and a directory contact with no real ranking reason and no
//     context note gets the honest "In your directory" fallback, never a blank sub-line.
//
// app.js has no unit-test seam, so these drive the real in-page functions through a live
// browser, matching the idiom already established in spotlight.spec.js / hello.spec.js /
// tier.spec.js (same local-harness note: /app.html, not /app, for the plain python
// http.server this suite's webServer runs).

const STORAGE_KEY = 'kith.v1'; // re-verified against app.js's `const KEY='kith.v1'` (line 8) just now, not assumed from memory

function baseSeed(contacts, settings) {
  return { v: 1, contacts, templates: [], settings: Object.assign({ myName: 'Tester', country: '91', leadDays: 1, localTouch: true }, settings || {}) };
}

async function seedAndGoto(page, contacts, hash, settings) {
  await page.addInitScript(([key, db]) => { localStorage.setItem(key, JSON.stringify(db)); }, [STORAGE_KEY, baseSeed(contacts, settings)]);
  await page.goto('/app.html#' + hash);
}

function isoToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// SOV-UX-007: the coral palette fix
// ---------------------------------------------------------------------------

test('the onboarding wordmark dot renders true brand coral, not the undefined-var fallback', async ({ page }) => {
  await page.goto('/app.html#onboard/welcome');
  const color = await page.locator('.ob-wm .dot').evaluate((el) => getComputedStyle(el).color);
  expect(color, '--coral must resolve to #E0552E (rgb(224, 85, 46)), never fall through to #F2683C').toBe('rgb(224, 85, 46)');
});

test('C4\'s "Send on WhatsApp" button is ob-btn.coral and renders true brand coral', async ({ page }) => {
  const contacts = [{ id: 'p1', name: 'Priya Nair', phone: '+919812345678', tier: 1, cadence: 3, log: [], customDates: [] }];
  await seedAndGoto(page, contacts, 'onboard/hello');
  const btn = page.getByRole('button', { name: 'Send on WhatsApp' });
  await expect(btn, 'once --coral is defined, C4 should switch off the primary-class workaround').toHaveClass(/\bob-btn coral\b|\bcoral\b/);
  const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, 'the button must actually paint the true brand coral, not just carry the class').toBe('rgb(224, 85, 46)');
});

test('C3\'s circle CTA and C2\'s import icon carry the mockup\'s coral', async ({ page }) => {
  // mockup C3 (line 506) paints the step CTA coral, and C2 (line 448) gives the Google import
  // option a coral icon chip; only C4's Send button had been switched over before this test.
  const contacts = [{ id: 'p1', name: 'Priya Nair', phone: '+919812345678', tier: 3, cadence: null, log: [], customDates: [] }];
  await seedAndGoto(page, contacts, 'onboard/circle');
  const cta = page.getByRole('button', { name: 'Skip for now' }); // tier-3-only seed: nobody chosen yet
  await expect(cta).toHaveClass(/\bcoral\b/);
  const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, 'the C3 CTA must paint true brand coral').toBe('rgb(224, 85, 46)');

  await page.goto('/app.html#onboard/import');
  const ic = page.locator('.ob-opt .ic').first();
  await expect(ic).toHaveClass(/\bcor\b/);
  const icBg = await ic.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(icBg, 'the C2 import icon chip must paint true brand coral').toBe('rgb(224, 85, 46)');
});

// ---------------------------------------------------------------------------
// SOV-UX-006: the true empty-state, and its deck-empty sibling
// ---------------------------------------------------------------------------

test('the true empty-state (zero contacts) carries the short, honest directory copy', async ({ page }) => {
  await seedAndGoto(page, [], 'today');
  await expect(page.locator('.empty .big')).toHaveText('Your directory is quiet.');
  await expect(page.locator('.empty')).toContainText('Pick a few to keep warm and we will write the first line.');
  await expect(page.getByRole('button', { name: 'Add your first person' })).toBeVisible();
});

test('deck-empty: nobody chosen yet says so honestly, instead of claiming everyone is warm', async ({ page }) => {
  // one directory (tier 3) contact, no cadence, no upcoming dates: the deck is empty AND
  // nobody has ever been promoted, so "Everyone is warm" would be a false claim here.
  const contacts = [{ id: 'd1', name: 'Directory Dana', tier: 3, cadence: null, log: [], customDates: [] }];
  await seedAndGoto(page, contacts, 'today');
  const card = page.locator('.card', { hasText: 'No one chosen yet' });
  await expect(card.locator('.kick')).toHaveText('No one chosen yet');
  await expect(card).toContainText('1 person is in your directory');
  await expect(card).not.toContainText('Everyone is warm');
});

test('deck-empty: "All caught up" still shows once someone has actually been chosen', async ({ page }) => {
  // regression guard for the branch this phase did NOT change: a tier-1 contact, contacted
  // today so nothing is due, and no upcoming dates, must still read the original honest copy.
  const contacts = [{ id: 'k1', name: 'Kept Warm Kai', tier: 1, cadence: 3, lastContacted: isoToday(), log: [], customDates: [] }];
  await seedAndGoto(page, contacts, 'today');
  const card = page.locator('.card', { hasText: 'All caught up' });
  await expect(card.locator('.kick')).toHaveText('All caught up');
  await expect(card).toContainText('Everyone is warm');
});

// ---------------------------------------------------------------------------
// C1 / C2 wizard copy, verbatim from the mockup
// ---------------------------------------------------------------------------

test('C1 welcome and C2 import carry the approved mockup copy', async ({ page }) => {
  await page.goto('/app.html#onboard/welcome');
  await expect(page.locator('.ob-sub')).toHaveText('Bring your contacts in quietly. Then pick the few who matter most.');

  await page.goto('/app.html#onboard/import');
  await expect(page.locator('.ob-screen h1')).toHaveText('Bring in everyone.');
  await expect(page.locator('.ob-sub')).toHaveText('Your whole address book, silent and searchable.');
  await expect(page.locator('.ob-opt h3').first()).toHaveText('Import from Google');
  await expect(page.locator('.ob-opt p').first()).toHaveText('One tap. Nobody is added to your day.');
  await expect(page.locator('.ob-fine')).toHaveText('Not one person becomes a task.');
});

// ---------------------------------------------------------------------------
// C3 Spotlight: the "a few to start with" kicker, and the honest fallback sub-line
// ---------------------------------------------------------------------------

test('the default shortlist gets "A few to start with"; a search query hides it', async ({ page }) => {
  const contacts = [];
  for (let i = 1; i <= 8; i++) contacts.push({ id: 'c' + i, name: 'Kicker Person ' + i, tier: 3, cadence: null, log: [], customDates: [] });
  await seedAndGoto(page, contacts, 'onboard/circle');

  await expect(page.locator('#obSpotList .kick', { hasText: 'A few to start with' })).toBeVisible();

  await page.locator('#obSpotQ').fill('Kicker Person 1');
  await expect(page.locator('#obSpotList .kick', { hasText: 'A few to start with' })).toHaveCount(0);

  await page.locator('#obSpotQ').fill('');
  await expect(page.locator('#obSpotList .kick', { hasText: 'A few to start with' })).toBeVisible();
});

test('a directory contact with no real reason and no context note gets the honest fallback, never a blank sub-line', async ({ page }) => {
  const contacts = [{ id: 'plain1', name: 'Zzz9Plain Contact', tier: 3, cadence: null, log: [], customDates: [] }];
  await seedAndGoto(page, contacts, 'onboard/circle');
  await page.locator('#obSpotQ').fill('Zzz9Plain');
  const row = page.locator('#obSpotList button.ob-person', { hasText: 'Zzz9Plain Contact' });
  await expect(row).toBeVisible();
  await expect(row.locator('.rel')).toHaveText('In your directory');
  await expect(row.locator('.rel.why')).toHaveCount(0);
});
