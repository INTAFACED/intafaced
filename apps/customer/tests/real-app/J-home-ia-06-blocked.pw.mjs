import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { signUp } from './desk.mjs';
import { ORIGIN, ROOT, tool } from './stack.mjs';

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

test(`${J} #5 every shell control (bell and inbox, avatar menu, mode switch, Web3 switch) ends in success, a typed refusal or the one notice (BLOCKED shell_service_off until the shared notice lives in packages/ui and the shell controls use it)`, () => {
  // The notice is apps/customer/src/shared/service-off.tsx; packages/ui holds no ServiceOffNotice, so the shell has no
  // shared component to walk its controls against. Green only when packages/ui declares or re-exports it by name and the
  // shell (src/app) takes it from packages/ui; a barrel `export *` alone is followed to the file that declares it.
  const uiFiles = filesNaming('ServiceOffNotice', path.join(ROOT, 'packages/ui/src'));
  const declared = uiFiles.some((file) =>
    /^export (?:function|const) ServiceOffNotice\b|^export \{[^}]*\bServiceOffNotice\b/m.test(readFileSync(file, 'utf8')),
  );
  expect(declared, 'BLOCKED shell_service_off: packages/ui exports no ServiceOffNotice for the shell controls to use').toBe(true);
  const shell = ['Shell.tsx', 'TopBar.tsx', 'AccountMenu.tsx', 'Web3Shell.tsx'].map((f) =>
    readFileSync(path.join(ROOT, 'apps/customer/src/app', f), 'utf8'),
  );
  expect(
    shell.some((text) => /import \{[^}]*\bServiceOffNotice\b[^}]*\} from '@intafaced\/ui'/.test(text)),
    'BLOCKED shell_service_off: the shell controls do not take ServiceOffNotice from packages/ui',
  ).toBe(true);
});

test(`${J} #1 a blank strip count refuses home.notice_strip_limit_unset and the strip says "not set"`, async ({ browser }) => {
  test.setTimeout(180_000);
  // Home's strip shows as many of the latest announcements as the owner's strip count (svc-ops home.config,
  // OPS_HOME_NOTICE_STRIP_LIMIT). The stack sets a TEST count for the other steps; here svc-ops restarts with it blank.
  const blankCount = (blank) => {
    const before = process.env.LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT;
    if (blank) process.env.LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT = 'off';
    else delete process.env.LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT;
    try {
      tool('local-test-stack.mjs', 'restart', 'ops');
    } finally {
      if (before === undefined) delete process.env.LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT;
      else process.env.LOCAL_STACK_OPS_HOME_NOTICE_STRIP_LIMIT = before;
    }
  };
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
