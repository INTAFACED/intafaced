import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { ROOT } from './stack.mjs';

// J-home-ia-06's clauses that need a product change before they can run, each red by name. They sit in their own file
// so a red here never skips a built step of J-home-ia-06.pw.mjs, whose steps run serially.
const J = 'J-home-ia-06';

/** Files under `dir` (from the repo root) that contain `text`. */
const filesWith = (text, dir) => spawnSync('grep', ['-rl', text, dir], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

test(`${J} #5 every shell control (bell and inbox, avatar menu, mode switch, Web3 switch) ends in success, a typed refusal or the one notice (BLOCKED shell_service_off until the shared notice lives in packages/ui and the shell controls use it)`, async () => {
  // The notice is apps/customer/src/shared/service-off.tsx, not a packages/ui component, and no shell control under
  // src/app renders it, so there is no inventory of shell controls to walk. Red by name until both exist.
  expect(
    filesWith('data-not-connected', 'packages/ui/src') !== '' && filesWith('data-not-connected', 'apps/customer/src/app') !== '',
    'BLOCKED shell_service_off: the shared notice is not in packages/ui and no shell control renders it',
  ).toBe(true);
});

test(`${J} #1 a blank strip count refuses home.notice_strip_limit_unset and the strip says "not set" (BLOCKED notice_strip_limit until Home reads the notice list with an owner-set limit)`, async () => {
  // Home reads only noticeStatus and the one announcement (src/screens/home/Notices.tsx); no owner value sets a strip
  // count, so there is no blank value to restart with. Red by name until that reader and its typed refusal exist.
  expect(
    filesWith('home.notice_strip_limit_unset', 'apps/customer/src'),
    'BLOCKED notice_strip_limit: no Home code refuses home.notice_strip_limit_unset',
  ).not.toBe('');
});
