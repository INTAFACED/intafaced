// The one setting that bounds local checks on a shared machine (local-jobs.mjs, project-state#3420), and vitest's part
// of it reaching every package through TEST_BUDGET.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localJobs, localWorkers } from './local-jobs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('unset or empty, nothing is bounded; a whole number bounds; anything else throws naming the setting', () => {
  assert.equal(localJobs({}), null);
  assert.equal(localJobs({ INTAFACED_LOCAL_JOBS: '' }), null);
  assert.deepEqual(localWorkers({}), {});
  assert.equal(localJobs({ INTAFACED_LOCAL_JOBS: '4' }), 4);
  assert.deepEqual(localWorkers({ INTAFACED_LOCAL_JOBS: '12' }), { maxWorkers: 12 });
  for (const bad of ['0', '-2', 'four', '2.5', '04', ' 4'])
    assert.throws(() => localJobs({ INTAFACED_LOCAL_JOBS: bad }), /INTAFACED_LOCAL_JOBS must be a whole number/);
});

test("TEST_BUDGET, which every package's vitest config spreads, carries the bound only when it is set", () => {
  const read = (extra) => {
    const { INTAFACED_LOCAL_JOBS: _unset, ...env } = process.env;
    const r = spawnSync(
      'node',
      ['--input-type=module', '-e', "import { TEST_BUDGET } from './tooling/vitest/budget.mjs'; console.log(JSON.stringify(TEST_BUDGET));"],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...env, ...extra },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(read({}), { testTimeout: 30_000, hookTimeout: 30_000 });
  assert.deepEqual(read({ INTAFACED_LOCAL_JOBS: '3' }), { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 3 });
});
