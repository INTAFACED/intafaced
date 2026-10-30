import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { signUp } from './desk.mjs';
import { ORIGIN, ROOT } from './stack.mjs';

// J-home-ia-06's clauses that need a product change before they can run, each red by name. They sit in their own file
// so a red here never skips a built step of J-home-ia-06.pw.mjs, whose steps run serially. When the product lands,
// each is replaced by the step itself in the running app.
const J = 'J-home-ia-06';

test(`${J} #5 every shell control (bell and inbox, avatar menu, mode switch, Web3 switch) ends in success, a typed refusal or the one notice (BLOCKED shell_service_off until the shared notice lives in packages/ui and the shell controls use it)`, () => {
  // The notice is apps/customer/src/shared/service-off.tsx; packages/ui exports no ServiceOffNotice, so the shell has no
  // shared component to walk its controls against.
  const ui = readFileSync(path.join(ROOT, 'packages/ui/src/index.ts'), 'utf8');
  expect(
    /export \{[^}]*\bServiceOffNotice\b[^}]*\}|export (function|const) ServiceOffNotice\b/.test(ui),
    'BLOCKED shell_service_off: packages/ui exports no ServiceOffNotice for the shell controls to use',
  ).toBe(true);
});

test(`${J} #1 a blank strip count refuses home.notice_strip_limit_unset and the strip says "not set" (BLOCKED notice_strip_limit until Home reads the notice list with an owner-set limit)`, async ({
  browser,
}) => {
  // Home reads only noticeStatus and the one announcement (src/screens/home/Notices.tsx); it never reads the notice list
  // with a limit, so no owner value sets a strip count and there is no blank value to restart with.
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  try {
    await signUp(page, 'hml');
    const listed = page.waitForRequest((req) => req.url().includes('/notify.notices'), { timeout: 15_000 }).catch(() => null);
    await page.goto('/home');
    expect(await listed, 'BLOCKED notice_strip_limit: Home never reads the notice list with a strip count').not.toBeNull();
  } finally {
    await context.close();
  }
});
