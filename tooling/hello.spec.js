import { test, expect } from '@playwright/test';

// Regression guard for the onboarding C4 screen (Concept C, Phase 2 plan / Phase 3 build,
// "the first-hello graft"): the wizard step rendered by viewOnboard('hello') in app.js,
// reached after the circle (spotlight) step. This is the payoff screen the whole redesign
// was built around: the wizard must not end on a completed filing task, it must end on a
// drafted message for the top pick and one tap to send.
//
// The contract under test:
//   - viewOnboard('hello') always uses obTopInner() (unmodified) to pick who this screen is
//     about: the FIRST tier-1 contact in DB.contacts array order, falling back to
//     DB.contacts[0] if nobody is tier 1 yet. Never a re-ranked or re-sorted pick.
//   - the drafted message comes from freshDraft(c,'reconnect') (the same function compose()
//     already uses), rendered into a #msg textarea, exactly like compose()'s modal does.
//   - the circle step's CTA ("Start keeping them warm" / "Skip for now") now advances to
//     #onboard/hello instead of finishing onboarding directly.
//   - "Send on WhatsApp" (obHelloSend) finishes onboarding (DB.settings.onboarded=true) and
//     then hands off to the existing, unmodified sendChannel()/_confirmSent() mechanic, the
//     same one every other send in the app uses.
//   - "Not now" finishes onboarding (via the existing obFinish()) without sending anything.
//   - "Pick someone else" returns to the circle step without finishing onboarding.
//   - this screen only reads: nobody's tier changes just from viewing or leaving it.
//
// app.js has no unit-test seam, so these drive the real in-page functions through a live
// browser, matching the idiom already established in spotlight.spec.js / tier.spec.js /
// merge.spec.js (same local-harness note: /app.html, not /app, for the plain python
// http.server this suite's webServer runs).

const STORAGE_KEY = 'kith.v1'; // re-verified against app.js's `const KEY='kith.v1'` (line 8) just now, not assumed from memory

function baseSeed(contacts){
  return { v: 1, contacts, templates: [], settings: { myName: 'Tester', country: '91', leadDays: 1, localTouch: true } };
}

// Heavy path: seed BEFORE the page's own scripts run (kith.v1 exists at script-eval time),
// so whichever onboarding step the hash names renders correctly on first paint.
async function seedAndGoto(page, contacts, hash){
  await page.addInitScript(([key, db]) => { localStorage.setItem(key, JSON.stringify(db)); }, [STORAGE_KEY, baseSeed(contacts)]);
  await page.goto('/app.html#' + hash);
}

// Light path, mirrors tier.spec.js's openTidy() / spotlight.spec.js's openCircleWith():
// goto first (DB.contacts is empty so viewOnboard('hello') falls back to 'import' on that
// very first paint, per the new guard), then stamp DB.contacts directly and re-route.
async function openHelloWith(page, contacts){
  await page.goto('/app.html#onboard/hello');
  await page.evaluate((cs) => { DB.contacts = cs; route(); }, contacts);
}

async function readDB(page){
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
}

test('completing the wizard from the circle step lands on the C4 hello screen with a drafted message for the person just promoted', async ({ page }) => {
  const contacts = [
    { id: 'p1', name: 'Priya Nair', phone: '+919812345678', tier: 3, cadence: null, log: [], customDates: [] },
    { id: 'p2', name: 'Arjun Mehta', phone: '+919812349999', tier: 3, cadence: null, log: [], customDates: [] },
  ];
  await seedAndGoto(page, contacts, 'onboard/circle');

  // promote Priya via the same explicit tap the invariant requires (obTogglePin), then advance
  await page.locator('#obSpotQ').fill('Priya');
  const row = page.locator('#obSpotList button.ob-person', { hasText: 'Priya Nair' });
  await expect(row).toBeVisible();
  await row.locator('.heart').click();

  await page.getByRole('button', { name: 'Start keeping them warm' }).click();

  await expect(page).toHaveURL(/#onboard\/hello$/);
  await expect(page.locator('.ob-screen h1')).toHaveText('Say hello to Priya.');
  const draft = await page.locator('#msg').inputValue();
  expect(draft.trim().length, 'the wizard must end with a real drafted message, not a blank box').toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Send on WhatsApp' })).toBeVisible();
});

test('the top pick is exactly obTopInner()\'s contact: first tier-1 in array order, never re-ranked', async ({ page }) => {
  // Zed sorts last alphabetically and has no signal; Aaron sorts first alphabetically. If
  // anything reorders by name or by SovennShuffle score instead of reusing obTopInner() as
  // written, Aaron would win and this assertion would catch it.
  const contacts = [
    { id: 'z1', name: 'Zed Zephyr', tier: 1, cadence: 3, log: [], customDates: [] },
    { id: 'a1', name: 'Aaron Apple', tier: 1, cadence: 3, log: [], customDates: [] },
  ];
  await openHelloWith(page, contacts);
  await expect(page.locator('.ob-screen h1')).toHaveText('Say hello to Zed.');
});

test('Send on WhatsApp finishes onboarding and hands off to the existing, unmodified send flow', async ({ page }) => {
  const contacts = [
    { id: 'p1', name: 'Priya Nair', phone: '+919812345678', tier: 1, cadence: 3, log: [], customDates: [] },
  ];
  // heavy/persisted seed: this test reads storage BEFORE any save() has happened, so the
  // fixture must already be on disk rather than only in the in-page DB object
  await seedAndGoto(page, contacts, 'onboard/hello');

  const before = await readDB(page);
  expect(before.settings.onboarded, 'must not be onboarded before the send').not.toBe(true);

  // fulfill wa.me directly instead of letting the popup follow WhatsApp's real redirect chain
  // out to api.whatsapp.com: keeps the assertion on the exact URL sendChannel()/waLink() built,
  // and keeps this test hermetic (no live network dependency)
  await page.context().route('https://wa.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'stub' }));

  const [popup] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('button', { name: 'Send on WhatsApp' }).click(),
  ]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  expect(popup.url()).toContain('wa.me/919812345678');
  await popup.close();

  // the exact same "did your message send?" confirm modal every other send in the app opens
  await expect(page.locator('#modalBg')).toHaveClass(/show/);
  await expect(page.locator('#modal')).toContainText('Did your message to Priya send?');

  const after = await readDB(page);
  expect(after.settings.onboarded, 'the send is the finishing action: onboarding must be marked complete').toBe(true);
});

test('Not now finishes onboarding without opening any send flow', async ({ page }) => {
  const contacts = [
    { id: 'p1', name: 'Priya Nair', phone: '+919812345678', tier: 1, cadence: 3, log: [], customDates: [] },
  ];
  await openHelloWith(page, contacts);

  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page).toHaveURL(/#today$/);

  const after = await readDB(page);
  expect(after.settings.onboarded, '"Not now" must still finish onboarding, same as the existing obFinish() path').toBe(true);
  expect(after.contacts.find((c) => c.id === 'p1').tier, 'declining to send must never touch anyone\'s tier').toBe(1);
});

test('Pick someone else returns to the circle step without finishing onboarding', async ({ page }) => {
  const contacts = [
    { id: 'p1', name: 'Priya Nair', phone: '+919812345678', tier: 1, cadence: 3, log: [], customDates: [] },
  ];
  // heavy/persisted seed: "Pick someone else" never calls save() itself, so the fixture must
  // already be on disk or the "after" read would just see a null store either way
  await seedAndGoto(page, contacts, 'onboard/hello');

  await page.getByRole('button', { name: 'Pick someone else' }).click();
  await expect(page).toHaveURL(/#onboard\/circle$/);
  await expect(page.locator('#obSpotList')).toBeVisible();

  const after = await readDB(page);
  expect(after.settings.onboarded, 'going back to pick someone else must not finish onboarding').not.toBe(true);
});

// v0.71.0 (audit Medium-8): a quick add taken from INSIDE the wizard must return to the circle
// step, not orphan onboarding on the person page (which also hid the setup checklist forever,
// since DB.settings.onboarded was never set on that path).
test('quick add during onboarding returns to the circle step instead of abandoning the wizard', async ({ page }) => {
  await page.goto('/app.html#onboard/import');
  await page.evaluate(() => { window._obFlow = true; window.quickAdd(); });
  await page.fill('#qa_name', 'Wizard Wanda');
  await page.evaluate(() => quickSave()); // the modal's Add person button; real-click coverage lives in quota.spec.js
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#onboard/circle');
  const saved = await page.evaluate(() => DB.contacts.some(c => c.name === 'Wizard Wanda'));
  expect(saved, 'the contact must still be saved').toBe(true);
});

// (review finding) leaving the wizard by plain navigation must end the onboarding flow flag, so a
// LATER unrelated quick-add goes to the person page, not back into the wizard.
test('back-navigating out of onboarding clears the flow: later quick add goes to the person page', async ({ page }) => {
  await page.goto('/app.html#onboard/import');
  await page.evaluate(() => { window.obAddByHand(); closeModal(); });    // enter the flow, then bail out
  await page.evaluate(() => { location.hash = '#today'; });              // back/away navigation
  await expect.poll(() => page.evaluate(() => window._obFlow)).toBe(false);
  await page.evaluate(() => { window.quickAdd(); });
  await page.fill('#qa_name', 'Later Lena');
  await page.evaluate(() => quickSave());
  await expect.poll(() => page.evaluate(() => location.hash), 'must go to the person page, not the wizard').toContain('#person/');
});
