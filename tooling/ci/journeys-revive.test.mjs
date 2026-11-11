/**
 * journeys-revive.mjs: a finished journeys run on main with no report is re-run, spaced out and bounded, then named.
 * The planted case is run 4005 (43037279979) of 11 Nov 2026, which died at "Install the browser" with no report.json.
 * Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTEMPT, WAIT_MINUTES, candidates, decide, issueTitle, tick } from './journeys-revive.mjs';

const REPO = 'INTAFACED/intafaced';
const NOW = Date.parse('2026-11-11T16:30:00Z');
const run = (over = {}) => ({
  id: 43037279979,
  run_number: 4005,
  head_branch: 'main',
  head_repository: { full_name: REPO },
  head_sha: 'f20569a2d0000000000000000000000000000000',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 2,
  created_at: '2026-11-11T14:18:58Z',
  updated_at: '2026-11-11T15:23:40Z',
  ...over,
});

/** A fake GitHub: `reports` the run ids that have a report.json; records every write. */
function fakeIo(runs, { reports = new Set(), open = new Set(), rerunStatus = 201 } = {}) {
  const calls = { rerun: [], created: [], checked: [] };
  return {
    calls,
    io: {
      listRuns: async () => runs,
      hasReport: async (r) => {
        calls.checked.push(r.id);
        return reports.has(r.id);
      },
      rerun: async (r) => {
        calls.rerun.push(r.id);
        return { ok: rerunStatus >= 200 && rerunStatus < 300, status: rerunStatus };
      },
      openIssue: async (title) => (open.has(title) ? { title } : null),
      createIssue: async (title, body) => calls.created.push({ title, body }),
    },
  };
}

test('a finished main run with no report is re-run once its wait has passed', async () => {
  const { io, calls } = fakeIo([run()]);
  const lines = await tick({ repo: REPO, now: NOW, io });
  assert.deepEqual(calls.rerun, [43037279979]);
  assert.deepEqual(calls.created, []);
  assert.match(lines[0], /run 4005 .* re-run of failed jobs requested/);
});

test('a run with a report is left alone', async () => {
  const { io, calls } = fakeIo([run()], { reports: new Set([43037279979]) });
  assert.deepEqual(await tick({ repo: REPO, now: NOW, io }), []);
  assert.deepEqual(calls.rerun, []);
  assert.deepEqual(calls.created, []);
});

test('a run still going (a first run or a re-run attempt) is left alone, its report not even read', async () => {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    const { io, calls } = fakeIo([run({ status, conclusion: null, run_attempt: 3 })]);
    assert.deepEqual(await tick({ repo: REPO, now: NOW, io }), []);
    assert.deepEqual(calls.checked, []);
    assert.deepEqual(calls.rerun, []);
  }
});

test('cancelled, skipped and green runs, pull request and fork runs, and runs older than the window are not read', () => {
  const left = [
    run({ conclusion: 'cancelled' }),
    run({ conclusion: 'skipped' }),
    run({ conclusion: 'success' }),
    run({ event: 'pull_request' }),
    run({ head_branch: 'feature' }),
    run({ head_repository: { full_name: 'someone/fork' } }),
    run({ created_at: '2026-11-09T14:00:00Z' }),
  ];
  assert.deepEqual(candidates(left, { repo: REPO, now: NOW }), []);
  for (const conclusion of ['failure', 'timed_out', 'startup_failure'])
    assert.equal(candidates([run({ conclusion })], { repo: REPO, now: NOW }).length, 1, conclusion);
});

test('the tries are spaced: a run that ended inside its wait is not re-run yet', async () => {
  // Attempt 2 ended 15:23:40; its wait is 60 min, so 16:20 is too soon and 16:24 is not.
  const { io, calls } = fakeIo([run()]);
  const lines = await tick({ repo: REPO, now: Date.parse('2026-11-11T16:20:00Z'), io });
  assert.deepEqual(calls.rerun, []);
  assert.match(lines[0], /waiting 60 min/);
  assert.equal(decide(run(), Date.parse('2026-11-11T16:24:00Z')), 'rerun');
  // The waits grow with each attempt, so the tries outlast an outage of hours.
  const waits = Object.values(WAIT_MINUTES);
  assert.ok(waits.every((w, i) => i === 0 || w > waits[i - 1]));
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 6 * 60, 'the waits alone span at least six hours');
});

test('the tries are bounded: no re-run is asked for at or past the last attempt; the run is named in one issue, once', async () => {
  assert.equal(MAX_ATTEMPT, 5);
  for (let attempt = 1; attempt < MAX_ATTEMPT; attempt++) assert.ok(WAIT_MINUTES[attempt] > 0, `attempt ${attempt} has a wait`);
  const late = Date.parse('2026-11-12T12:00:00Z');
  for (const attempt of [MAX_ATTEMPT, MAX_ATTEMPT + 1]) {
    const { io, calls } = fakeIo([run({ run_attempt: attempt })]);
    const lines = await tick({ repo: REPO, now: late, io });
    assert.deepEqual(calls.rerun, [], `attempt ${attempt}: no re-run`);
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].title, 'Journeys run on main has no report: run 4005');
    assert.match(calls.created[0].body, /actions\/runs\/43037279979/);
    assert.match(lines[0], /after its last try, issue opened/);
  }
  const { io, calls } = fakeIo([run({ run_attempt: MAX_ATTEMPT })], { open: new Set([issueTitle(run())]) });
  await tick({ repo: REPO, now: late, io });
  assert.deepEqual(calls.created, [], 'an open issue is not opened again');
});

test('a re-run GitHub does not take is named at once, not asked for again every hour', async () => {
  const { io, calls } = fakeIo([run()], { rerunStatus: 422 });
  const lines = await tick({ repo: REPO, now: NOW, io });
  assert.deepEqual(calls.rerun, [43037279979]);
  assert.equal(calls.created.length, 1);
  assert.match(lines[0], /did not take its re-run \(422\), issue opened/);
});

test('11 Nov replayed: hourly ticks from attempt 2 re-run run 4005 at most three more times, then name it', async () => {
  // Each re-run attempt is planted to last 40 minutes and die again with no report.
  let r = run();
  const reruns = [];
  let issues = 0;
  for (let t = Date.parse('2026-11-11T15:43:00Z'); t < Date.parse('2026-11-13T00:00:00Z'); t += 3600_000) {
    const { io, calls } = fakeIo([r], { open: new Set(issues ? [issueTitle(r)] : []) });
    await tick({ repo: REPO, now: t, io });
    issues += calls.created.length;
    if (calls.rerun.length) {
      reruns.push(new Date(t).toISOString().slice(11, 16));
      r = run({ run_attempt: r.run_attempt + 1, updated_at: new Date(t + 40 * 60_000).toISOString() });
    }
  }
  assert.equal(reruns.length, MAX_ATTEMPT - 2, `re-runs at ${reruns.join(', ')} UTC`);
  assert.equal(r.run_attempt, MAX_ATTEMPT);
  assert.equal(issues, 1);
});
