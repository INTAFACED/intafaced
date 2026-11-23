import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notices } from './pre-push-ci-running.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('a notice per replaced head with checks unfinished; none for a new branch, a finished head or an unread one', async () => {
  const counts = { [A]: 3, [B]: 0 };
  assert.deepEqual(await notices([A, '0'.repeat(40), B, A, 'not-a-sha'], async (s) => counts[s]), [
    'pre-push: notice: CI is still running on aaaaaaaaa, the head this push replaces (3 checks unfinished). This push restarts it; its verdict may name more to fix in the same push.',
  ]);
  assert.deepEqual(await notices([A], async () => null), [], 'gh missing or offline: nothing');
  assert.deepEqual(
    await notices([A], async () => {
      throw new Error('boom');
    }),
    [],
    'any error: nothing',
  );
});

// The script as the hook runs it, with a planted gh on PATH.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pre-push-ci-running.mjs');
const run = (gh) => {
  const bin = mkdtempSync(join(tmpdir(), 'gh-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${gh}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const t0 = Date.now();
  const r = spawnSync('node', [SCRIPT, A], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  rmSync(bin, { recursive: true, force: true });
  return { ...r, ms: Date.now() - t0 };
};

test("gh's count of unfinished checks on the replaced head makes the notice; offline, failing or hung gh prints nothing, fast", () => {
  const live = run(`case "$*" in *"commits/${A}/check-runs"*) echo 7;; *) exit 1;; esac`);
  assert.match(live.stdout, /notice: CI is still running on aaaaaaaaa, the head this push replaces \(7 checks unfinished\)/);
  for (const gh of ['echo 0', 'echo "error connecting to api.github.com" >&2; exit 1', 'sleep 20; echo 7']) {
    const r = run(gh);
    assert.deepEqual([r.status, r.stdout], [0, ''], gh);
    assert.ok(r.ms < 6000, `${gh}: ${r.ms} ms`);
  }
});
