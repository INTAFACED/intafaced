import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { ORIGIN, ROOT, restartWith } from './stack.mjs';

// J-home-ia-06's clauses that need a product change before they can run, each red by name. They sit in their own file
// so a red here never skips a built step of J-home-ia-06.pw.mjs, whose steps run serially. When the product lands,
// each is replaced by the step itself in the running app.
const J = 'J-home-ia-06';

/** Source files (tests left out) under `dir` that name `word`; none is an empty list. */
function filesNaming(word, dir) {
  const named = new RegExp(`\\b${word}\\b`);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => named.test(readFileSync(file, 'utf8')));
}

test(`${J} #5 the one service-off notice is the kit's: packages/ui declares it, and the customer's service-off states draw it from @intafaced/ui/lit/templates with no markup of their own`, () => {
  // HM-shell-03 (1): one shared notice. Each shell control may end in success, a typed refusal or this notice (3), so no
  // shell file has to import it; what has to hold is that there is one notice, the kit's, and that no customer room draws
  // its own copy of it (ruling by D, 2026-10-31).
  const templates = path.join(ROOT, 'packages/ui/src/lit/templates');
  const declared = filesNaming('ServiceOffNotice', templates).some((file) =>
    /^export function ServiceOffNotice\b/m.test(readFileSync(file, 'utf8')),
  );
  expect(declared, 'packages/ui/src/lit/templates declares no ServiceOffNotice').toBe(true);
  expect(readFileSync(path.join(templates, 'index.ts'), 'utf8'), 'the templates entry does not export ServiceOffNotice').toMatch(
    /\bServiceOffNotice\b/,
  );
  const shared = readFileSync(path.join(ROOT, 'apps/customer/src/shared/service-off.tsx'), 'utf8');
  expect(shared, "the customer's shared notice does not draw the kit's").toMatch(
    /import \{[^}]*\bServiceOffNotice\b[^}]*\} from '@intafaced\/ui\/lit\/templates'/,
  );
  // No customer source writes the notice's markup itself: the allowlist code attribute comes only from the kit.
  const ownMarkup = filesNaming('data-not-connected', path.join(ROOT, 'apps/customer/src')).filter((file) =>
    /data-not-connected=/.test(readFileSync(file, 'utf8')),
  );
  expect(ownMarkup, 'customer sources that draw their own service-off markup').toEqual([]);
});

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
