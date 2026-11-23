// tooling-tests: alone. It runs `git fetch` into the checkout's own .git (FETCH_HEAD, objects/maintenance.lock).
// volt-off-kit.json only shrinks: a change may drop rooms from it, never add one that its fork point from main did not
// list. volt-count.test.ts holds the rest of the ratchet: every room off the kit is listed. A listed room now on the kit
// passes on every PR; tooling/design/volt-prune.mjs drops it in its own PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainRef } from '../ci/lint-ratchet.mjs';
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
  const before = JSON.parse(
    execFileSync('git', ['show', `${forkPoint(ref)}:${LIST}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  const now = JSON.parse(readFileSync(join(ROOT, LIST), 'utf8'));
  assert.deepEqual(added(before, now), [], 'a room added to the off-kit list: build it on its template from the kit instead');
});
