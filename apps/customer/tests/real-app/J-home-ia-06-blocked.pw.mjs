// World: restart
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { ORIGIN, restartWith } from './stack.mjs';

// J-home-ia-06's clauses that need a product change before they can run, each red by name. They sit in their own file
// so a red here never skips a built step of J-home-ia-06.pw.mjs, whose steps run serially. When the product lands,
// each is replaced by the step itself in the running app. That #5's notice is the kit's one, drawn by no room's own
// markup, is a source check, kept in apps/customer/src/shared/service-off.one-notice.test.ts.
const J = 'J-home-ia-06';

test(`${J} #1 a blank strip count refuses home.notice_strip_limit_unset and the strip says "not set"`, async ({ browser }) => {
  test.setTimeout(300_000);
  // Home's strip shows as many of the latest announcements as the owner's strip count (svc-ops home.config,
  // OPS_HOME_NOTICE_STRIP_LIMIT). The stack sets a TEST count for the other steps; here svc-ops restarts with it blank.
  const blankCount = (blank) => restartWith('ops', 'LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT', !blank);
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  blankCount(true);
  try {
    await signUp(page, 'hml');
    // With the strip count blank, Home's strip says it is not set, with the typed code, rather than drawing any number
    // of notices.
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    const unset = page.locator('[data-code="home.notice_strip_limit_unset"]');
    await expect(unset).toContainText(/not set/i, { timeout: 15_000 });
    await expect(page.locator('[data-testid="home-notice"][data-kind="announcement"]')).toHaveCount(0);
  } finally {
    blankCount(false);
    await context.close();
  }
});
