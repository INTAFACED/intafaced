import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CI_WORKFLOW_PATH, ciRunFor, jobResults, judgeCiJobs } from './ci-jobs-seal.mjs';

const SHA = 'a'.repeat(40);
const run = (id, over = {}) => ({ id, head_sha: SHA, event: 'pull_request', path: CI_WORKFLOW_PATH, status: 'completed', ...over });
const job = (id, name, conclusion = 'success', status = 'completed') => ({ id, name, status, conclusion });
const green = (tests = ['Tests (changed)']) => [
  job(1, 'Affected tests'),
  job(2, 'Doctrine gates'),
  job(3, 'Format'),
  job(4, 'Typecheck & build'),
  ...tests.map((t, i) => job(10 + i, t)),
];
const product = ['services/svc-pay/src/a.ts'];

test('the newest ci.yml run of the event on the head decides; other workflows, events and heads never do', () => {
  const runs = [
    run(5),
    run(9, { path: '.github/workflows/fake.yml' }),
    run(8, { event: 'pull_request_target' }),
    run(7, { head_sha: 'b'.repeat(40) }),
    run(6),
  ];
  assert.equal(ciRunFor(runs, { sha: SHA, event: 'pull_request' }).id, 6);
  assert.equal(ciRunFor([], { sha: SHA, event: 'pull_request' }), null);
});

test('known good: every job green passes', () => {
  const v = judgeCiJobs({ run: run(1), jobs: green(), files: product });
  assert.equal(v.ok, true, v.lines.join('\n'));
});

test('a run still going, or none, waits (red), and says the seal re-runs', () => {
  for (const r of [null, run(1, { status: 'in_progress' })]) {
    const v = judgeCiJobs({ run: r, jobs: [], files: product });
    assert.equal(v.ok, false);
    assert.equal(v.wait, true);
    assert.match(v.lines[0], /re-runs when it finishes/);
  }
});

test('planted: a red or missing required job fails', () => {
  assert.equal(
    judgeCiJobs({ run: run(1), jobs: green().map((j) => (j.name === 'Format' ? { ...j, conclusion: 'failure' } : j)), files: product }).ok,
    false,
  );
  assert.equal(judgeCiJobs({ run: run(1), jobs: green().filter((j) => j.name !== 'Doctrine gates'), files: product }).ok, false);
});

test('planted: a pull request whose own ci.yml skips the tests its change needs fails (the base classifies)', () => {
  const v = judgeCiJobs({ run: run(1), jobs: green([]), files: product });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /tests-full was missing/);
  const skipped = judgeCiJobs({
    run: run(1),
    jobs: green(['Tests (changed)']).map((j) => (j.name.startsWith('Tests') ? { ...j, conclusion: 'skipped' } : j)),
    files: product,
  });
  assert.equal(skipped.ok, false);
});

test('one red shard of many fails; docs only needs no test job', () => {
  const shards = Array.from({ length: 16 }, (_, i) => `Tests (${i + 1}/16)`);
  const jobs = green(shards).map((j) => (j.name === 'Tests (7/16)' ? { ...j, conclusion: 'failure' } : j));
  assert.equal(judgeCiJobs({ run: run(1), jobs, files: ['.github/workflows/x.yml'] }).ok, false);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([]), files: ['docs/a.md'] }).ok, true);
});

test('files unreadable whole (null) or a merge queue commit need the full suite', () => {
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([]), files: null }).ok, false);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green([]), files: [], forceFull: true }).ok, false);
});

test('jobResults counts a repeated name by its newest job', () => {
  const r = jobResults([job(1, 'Format', 'failure'), job(2, 'Format', 'success')]);
  assert.equal(r.format, 'success');
});

test('planted: a full-suite change whose own ci.yml ran one shard fails; the whole matrix passes', () => {
  const full = ['packages/ledger-client/src/a.ts', '.github/workflows/ci.yml'];
  const one = judgeCiJobs({ run: run(1), jobs: green(['Tests (changed)']), files: full });
  assert.equal(one.ok, false);
  assert.match(one.lines.join('\n'), /16 shards never ran|of its 16 shards never ran/);
  const all = Array.from({ length: 16 }, (_, i) => `Tests (${i + 1}/16)`);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green(all), files: full }).ok, true);
  assert.equal(judgeCiJobs({ run: run(1), jobs: green(all.slice(1)), files: full }).ok, false, 'one shard short');
});

test('a CI run back in progress only because its own seal job is being re-run is still judged (CI review on 7a7eb9a0)', () => {
  const jobs = [...green(), { id: 99, name: 'CI merge seal', status: 'in_progress', conclusion: null }];
  assert.equal(judgeCiJobs({ run: run(1, { status: 'in_progress', run_attempt: 2 }), jobs, files: product }).ok, true);
  // Planted: a required job still running keeps it waiting.
  const running = jobs.map((j) => (j.name === 'Format' ? { ...j, status: 'in_progress', conclusion: null } : j));
  assert.equal(judgeCiJobs({ run: run(1, { status: 'in_progress' }), jobs: running, files: product }).wait, true);
  assert.equal(judgeCiJobs({ run: run(1, { status: 'in_progress' }), jobs: [], files: product }).wait, true, 'no jobs read yet');
});
