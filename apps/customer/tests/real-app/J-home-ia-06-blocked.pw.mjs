import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { signUp } from './desk.mjs';
import { ORIGIN, ROOT } from './stack.mjs';

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

test(`${J} #1 a blank strip count refuses home.notice_strip_limit_unset and the strip says "not set" (BLOCKED notice_strip_limit until Home reads the notice list with an owner-set limit)`, async ({
  browser,
}) => {
  // Home reads only noticeStatus and the one announcement (src/screens/home/Notices.tsx); it never reads the notice list
  // with a limit, so no owner value sets a strip count and there is no blank value to restart with.
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  try {
    await signUp(page, 'hml');
    // Built means: with the strip count left blank (the stack sets none), Home's strip says it is not set, with the typed
    // code, rather than drawing any number of notices.
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    await expect(
      page.locator('[data-code="home.notice_strip_limit_unset"]'),
      'BLOCKED notice_strip_limit: Home never refuses a blank strip count with home.notice_strip_limit_unset',
    ).toContainText(/not set/i, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});
