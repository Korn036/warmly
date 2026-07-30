import { test, expect } from '@playwright/test';

// Regression guard for the mailto header-injection class (SOV-SEC-001).
//
// mailUrl() must only ever emit a mailto: for a plain single address. The Batch 1
// (M2) fix stripped the literal '?cc=/?bcc=' smuggle by cutting everything after '?'.
// This guard also pins the percent-encoded CRLF bypass
// (victim@evil.com%0D%0ABcc:attacker%40example.com), which the earlier
// [^\s@<>"']+ pattern let through because it still permitted '%' and ':'. Once a
// mail client percent-decodes the URI per RFC 6068, %0D%0A becomes a real CRLF and
// the encoded 'Bcc:' becomes a live header, quietly copying a hidden recipient the
// moment the user taps Email.
//
// app.js loads as a classic `defer` script (app.html), so its top-level function
// declarations are global; we call window.mailUrl directly. Mutation check: the
// REJECT cases below each return a truthy mailto: under the pre-fix regex and ''
// under the strict-allowlist fix, so this spec fails before the edit and passes after.

test('mailUrl refuses header-injection vectors and still passes plain addresses', async ({ page }) => {
  await page.goto('/app.html#today');
  await page.waitForFunction(() => typeof window.mailUrl === 'function');

  const out = await page.evaluate(() => ({
    injectEncoded: window.mailUrl('victim@evil.com%0D%0ABcc:attacker%40example.com'),
    injectEncodedLocal: window.mailUrl('victim%0D%0Ax@evil.com'),
    injectColon: window.mailUrl('a@b.com:25'),
    literalQueryStripped: window.mailUrl('victim@evil.com?bcc=attacker@example.com'),
    plain: window.mailUrl('priya.nair@example.com'),
    plusAlias: window.mailUrl('kai+beta@gmail.com'),
    empty: window.mailUrl(''),
  }));

  // Every injection vector must be refused outright.
  expect(out.injectEncoded, 'percent-encoded CRLF Bcc must be rejected').toBe('');
  expect(out.injectEncodedLocal, 'percent-encoded CRLF in the local part must be rejected').toBe('');
  expect(out.injectColon, "a ':' in the address must be rejected").toBe('');

  // The literal '?bcc=' is stripped to a clean address (the original M2 behaviour).
  expect(out.literalQueryStripped, 'the literal ?bcc= smuggle is cut, leaving a clean address').toBe('mailto:victim@evil.com');

  // No false-negative regression: legitimate addresses must still work.
  expect(out.plain).toBe('mailto:priya.nair@example.com');
  expect(out.plusAlias, 'gmail +aliasing must still pass').toBe('mailto:kai+beta@gmail.com');
  expect(out.empty).toBe('');
});
