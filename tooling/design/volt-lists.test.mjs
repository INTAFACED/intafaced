// tooling-tests: alone. It runs `git fetch` into the checkout's own .git (FETCH_HEAD, objects/maintenance.lock).
// volt-off-kit.json only shrinks: a change may drop rooms from it, never add one that its fork point from main did not
// list (main-bisect's proven revert of X: nor X^). volt-count.test.ts holds the rest of the ratchet: every room off the kit is listed, and, but on a
// batch into a Volt layer, every listed room is off the kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainRef } from '../ci/lint-ratchet.mjs';
import { judgedCopy } from '../ci/exact-revert.mjs';
import { ROOT, forkPoint } from '../lint/kit-ceilings.mjs';

const LIST = 'apps/customer/src/app/volt-off-kit.json';

/** The rooms `now` lists that `before` did not: each one a room let off the kit by hand. */
const added = (before, now) => now.filter((key) => !new Set(before).has(key));

test('added: a dropped room passes, an added one is named', () => {
  assert.deepEqual(added(['/a', '/b'], ['/a']), []);
  assert.deepEqual(added(['/a', '/b'], ['/a', '/b']), []);
  assert.deepEqual(added(['/a'], ['/a', '/new']), ['/new']);
});

test(`${LIST} lists no room its fork point from main did not`, () => {
  const ref = mainRef();
  assert.ok(ref, "cannot fetch main: main's list is what a change's is judged against");
  // A revert of X by main-bisect may list again the rooms X^ listed, never more (exact-revert.mjs judgedCopy).
  const read = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  const before = judgedCopy(LIST, { env: process.env, main: ref, fork: forkPoint(ref), read }) ?? [];
  const now = JSON.parse(readFileSync(join(ROOT, LIST), 'utf8'));
  assert.deepEqual(added(before, now), [], 'a room added to the off-kit list: build it on its template from the kit instead');
});
