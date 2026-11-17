/**
 * main-first.mjs: when a run off main defers to main's run, the cap on hand-dispatched full runs, the one-read decision
 * and the release, on fixtures with no GitHub. tooling-tests.mjs runs it with every other tooling test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFER_MARK,
  DISPATCH_MARK,
  RELEASE_JOB,
  TOUCH_JOB,
  decide,
  deferWhy,
  dispatchBusy,
  mainWaiting,
  toRelease,
} from './main-first.mjs';

const touch = (status, marked, deferred = false) => [
  {
    name: TOUCH_JOB,
    status,
    steps: [
      { name: DISPATCH_MARK, conclusion: marked ? 'success' : 'skipped' },
      { name: DEFER_MARK, conclusion: deferred ? 'success' : 'skipped' },
    ],
  },
];

test('mainWaiting: a main run still taking runners, and the runs that hold nothing back', async () => {
  const problems = [];
  const jobs = {
    1: [{ name: 'What this run runs', status: 'queued' }],
    2: [
      { name: 'What this run runs', status: 'in_progress' },
      { name: 'Build the stack once', status: 'completed', conclusion: 'skipped' },
    ],
    3: [
      { name: 'What this run runs', status: 'completed', conclusion: 'success' },
      { name: 'Journeys (shard 1 of 2)', status: 'in_progress' },
      { name: 'Journeys (shard 2 of 2)', status: 'queued' },
    ],
    4: [
      { name: 'What this run runs', status: 'completed', conclusion: 'success' },
      { name: 'Journeys (shard 1 of 2)', status: 'in_progress' },
      { name: 'Journeys (shard 2 of 2)', status: 'in_progress' },
    ],
    5: [{ name: 'What this run runs', status: 'completed', conclusion: 'failure' }],
    6: [{ name: 'What this run runs', status: 'in_progress' }],
    7: [{ name: 'What this run runs', status: 'completed', conclusion: 'success' }], // shards skipped after the plan
    // Shards waiting for runners, but the release already ran, so nothing would let a run deferred now go.
    10: [
      { name: 'What this run runs', status: 'completed', conclusion: 'success' },
      { name: RELEASE_JOB, status: 'completed', conclusion: 'success' },
      { name: 'Journeys (shard 1 of 2)', status: 'queued' },
    ],
    11: [
      { name: 'What this run runs', status: 'completed', conclusion: 'success' },
      { name: RELEASE_JOB, status: 'in_progress' },
      { name: 'Journeys (shard 1 of 2)', status: 'queued' },
    ],
  };
  const jobsOf = async (id) => jobs[id];
  const run = (id, status, over = {}) => ({ id, status, head_branch: 'main', event: 'push', ...over });
  const cases = [
    [[run(1, 'in_progress')], /1 job\(s\) waiting/],
    [[run(2, 'in_progress')], /not queued its shards/],
    [[run(3, 'in_progress')], /1 job\(s\) waiting/],
    [[run(4, 'in_progress')], null],
    [[run(5, 'in_progress')], null], // a failed plan queues no shards
    [[run(6, 'in_progress')], /not queued its shards/], // still deciding what it runs
    [[run(7, 'in_progress')], null],
    [[run(8, 'in_progress'), run(1, 'in_progress')], /run 1 has 1 job/], // run 8's jobs can't be read: passed over
    [[run(9, 'queued')], /queued for a runner/],
    [[run(10, 'queued')], null], // its release ran: deferring now would strand the run
    [[run(10, 'in_progress')], null],
    [[run(11, 'in_progress')], /1 job\(s\) waiting/], // its release still running: it reads runs as they are now
    [[run(10, 'queued'), run(9, 'queued')], /run 9 is queued/], // another main run still waits
    [[run(9, 'pending')], null], // waiting behind the running main run in its group: no runner asked for
    [[run(1, 'in_progress', { head_branch: 'feature' })], null],
    [[run(1, 'in_progress', { event: 'pull_request' })], null], // a pull request from a branch named main
    [[run(4, 'in_progress'), run(1, 'in_progress')], /run 1 has 1 job/],
    [[], null],
  ];
  for (const [runs, want] of cases) {
    const got = await mainWaiting(runs, jobsOf);
    if (want === null ? got !== null : !want.test(got ?? '')) problems.push(`${JSON.stringify(runs)} → ${got}`);
  }
  assert.deepEqual(problems, []);
});

test("the cap: two running, marked full dispatch runs make a third wait; a deferred, targeted, main or own run doesn't count", async () => {
  const problems = [];
  const djobs = {
    11: touch('completed', true),
    12: touch('completed', true),
    13: touch('in_progress', true),
    14: touch('completed', false),
    16: touch('completed', true, true),
  };
  const dOf = async (id) => djobs[id];
  const d = (id, over = {}) => ({ id, status: 'in_progress', event: 'workflow_dispatch', head_branch: `b${id}`, ...over });
  const capCases = [
    [[d(11), d(12)], 99, /2 hand-dispatched full runs/],
    [[d(11), d(12)], 12, null], // itself doesn't count
    [[d(11), d(13)], 99, null], // 13 is still deciding in its own touch job
    [[d(11), d(14)], 99, null], // 14 is a targeted run
    [[d(11), d(16)], 99, null], // 16 was deferred
    [[d(11), d(12, { head_branch: 'main' })], 99, null], // main's runs never count against branches
    [[d(11), d(12, { event: 'pull_request' })], 99, null],
    [[d(11), d(12, { status: 'completed' })], 99, null],
    [[d(11), d(12), d(15)], 99, /2 hand-dispatched/], // 15's jobs can't be read: passed over
  ];
  for (const [runs, self, want] of capCases) {
    const got = await dispatchBusy(runs, dOf, self);
    if (want === null ? got !== null : !want.test(got ?? '')) problems.push(`cap ${JSON.stringify(runs)} ${self} → ${got}`);
  }
  assert.deepEqual(problems, []);
});

test('the decision defers while main waits, goes on when it does not or GitHub cannot be read, and reads once', async () => {
  let reads = 0;
  const waiting = await decide(async () => (reads++, "main's run 1 is queued for a runner"));
  assert.ok(waiting.defer && reads === 1, `did not defer while main waits, or read more than once: ${JSON.stringify(waiting)} ${reads}`);
  assert.ok(!(await decide(async () => null)).defer, 'deferred with main not waiting');
  const broken = await decide(async () => {
    throw new Error('HTTP 502');
  });
  assert.ok(!broken.defer && /could not be read/.test(broken.why), `deferred on an unreadable API: ${JSON.stringify(broken)}`);
});

test("deferWhy: a released re-run and a targeted run don't wait for main; the cap still holds; a first full attempt waits", async () => {
  let mainRead = 0;
  const mainBusy = async () => (mainRead++, "main's run 1 has 44 job(s) waiting for a runner");
  assert.ok((await deferWhy({ attempt: '2', main: mainBusy })) === null && !mainRead, 'a released re-run deferred for main again');
  assert.ok(await deferWhy({ attempt: '2', main: mainBusy, cap: async () => 'the cap is full' }), 'a released dispatch skipped the cap');
  assert.ok(await deferWhy({ attempt: '1', main: mainBusy }), "a first attempt didn't wait for main");
  assert.ok(!(await deferWhy({ attempt: '1', main: async () => null })), 'deferred with nothing waiting');
  mainRead = 0;
  assert.ok((await deferWhy({ attempt: '1', main: mainBusy, targeted: true })) === null && !mainRead, 'a targeted run waited for main');
  assert.ok(await deferWhy({ attempt: '1', main: mainBusy, targeted: false }), "a full run didn't wait for main");
});

test('the release: the newest deferred run per branch and event, completed, recent; never main or a superseded one', async () => {
  const now = Date.parse('2026-11-09T11:00:00Z');
  const at = (m) => new Date(now - m * 60_000).toISOString();
  const r = (id, branch, mins, over = {}) => ({
    id,
    head_branch: branch,
    event: 'pull_request',
    status: 'completed',
    created_at: at(mins),
    ...over,
  });
  const rjobs = {
    21: touch('completed', false, true),
    22: touch('completed', false, true),
    23: touch('completed', false, false),
    24: touch('completed', false, true),
    25: touch('completed', false, true),
    26: touch('completed', false, true),
    27: touch('completed', false, true),
  };
  const rOf = async (id) => rjobs[id];
  const runs = [
    r(21, 'a', 30), // deferred, newest on a: released
    r(22, 'b', 40), // deferred but superseded by 28 on b: not released
    r(28, 'b', 10, { status: 'queued' }),
    r(23, 'c', 20), // ran normally: not released
    r(24, 'main', 20, { event: 'push' }), // main: never
    r(25, 'd', 8 * 60), // older than the window: not released
    r(26, 'e', 15, { event: 'workflow_dispatch' }), // a deferred dispatch: released
    r(27, 'a', 50, { event: 'workflow_dispatch' }), // a's dispatch, its own newest: released
  ];
  assert.deepEqual(await toRelease(runs, rOf, now), [27, 21, 26], 'release picked');
  // A run whose jobs page answers 502 every time (a 64-shard run) is passed over; the deferred runs still go.
  const big = r(29, 'f', 25);
  const brokenOf = async (id) => {
    if (id === 29) throw new Error('GitHub 502 on /actions/runs/29/jobs?filter=latest&per_page=100');
    return rjobs[id];
  };
  const past502 = await toRelease([...runs, big], brokenOf, now).catch((e) => e.message);
  assert.deepEqual(past502, [27, 21, 26], 'a 502 on one run stopped the release');
  // A 403 or 429 still stops it: never read past a refusal.
  const refusedOf = async (id) => {
    if (id === 29) throw new Error('GitHub 429 on /actions/runs/29/jobs: stopping, not retrying');
    return rjobs[id];
  };
  const refused = await toRelease([...runs, big], refusedOf, now).catch(() => 'stopped');
  assert.equal(refused, 'stopped', 'a 429 did not stop the release');
});
