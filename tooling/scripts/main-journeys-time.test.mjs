import assert from 'node:assert/strict';
import test from 'node:test';

import { pushWaits, quantile, runTimes, summarise } from './main-journeys-time.mjs';

const run = (id, created, extra = {}) => ({
  id,
  run_number: id,
  created_at: created,
  status: 'completed',
  conclusion: 'success',
  ...extra,
});
const step = (name, a, b) => ({ name, started_at: a, completed_at: b });
const shard = (n, start, end, steps) => ({
  name: `Journeys (shard ${n} of 2)`,
  status: 'completed',
  started_at: start,
  completed_at: end,
  steps,
});

test('a run that ran: wait to its first job, boot on the last shard to end, wall to its last job', () => {
  const jobs = [
    {
      name: 'What this run runs',
      status: 'completed',
      started_at: '2026-11-13T07:05:00Z',
      completed_at: '2026-11-13T07:06:00Z',
      steps: [],
    },
    shard(1, '2026-11-13T07:06:00Z', '2026-11-13T07:30:00Z', [
      step('Start the local test stack (TEST funds only)', '2026-11-13T07:08:00Z', '2026-11-13T07:09:00Z'),
    ]),
    shard(2, '2026-11-13T07:06:00Z', '2026-11-13T07:40:00Z', [
      step("Wait for the run's build", '2026-11-13T07:06:00Z', '2026-11-13T07:08:00Z'),
      step('Start the local test stack (TEST funds only)', '2026-11-13T07:08:00Z', '2026-11-13T07:09:30Z'),
      step('Open the TEST markets, write TEST chart history, start the TEST market maker', '2026-11-13T07:09:30Z', '2026-11-13T07:13:30Z'),
      step('Load the TEST content', '2026-11-13T07:13:30Z', '2026-11-13T07:13:36Z'),
      step('Journeys in the running app (this shard)', '2026-11-13T07:14:00Z', '2026-11-13T07:39:00Z'),
    ]),
    { name: 'Real-app journeys', status: 'completed', started_at: '2026-11-13T07:40:10Z', completed_at: '2026-11-13T07:42:00Z', steps: [] },
  ];
  const t = runTimes(run(1, '2026-11-13T07:00:00Z'), jobs);
  assert.equal(t.ran, true);
  assert.equal(t.wait, 5);
  assert.equal(Math.round(t.boot * 10) / 10, 5.6, 'start 1.5 + markets 4 + content 0.1; the build wait and journeys are not boot');
  assert.equal(t.wall, 42);
});

test('a replaced run ran nothing, and its push waits for the next run that ran', () => {
  const rows = [
    runTimes(run(1, '2026-11-13T06:00:00Z', { conclusion: 'cancelled' }), []),
    runTimes(run(2, '2026-11-13T06:10:00Z'), [
      {
        name: 'What this run runs',
        status: 'completed',
        started_at: '2026-11-13T06:30:00Z',
        completed_at: '2026-11-13T06:31:00Z',
        steps: [],
      },
    ]),
    runTimes(run(3, '2026-11-13T06:40:00Z', { status: 'in_progress', conclusion: null }), []),
  ];
  assert.equal(rows[0].ran, false);
  assert.deepEqual(pushWaits(rows), [30, 20], "run 1 waits for run 2's first job; run 3 has no later run that ran yet");
  const s = summarise(rows);
  assert.equal(s.replaced, 2);
  assert.equal(s.finished, 1);
  assert.equal(s.waitRun.median, 20, 'the run measure counts run 2 only');
  assert.equal(s.waitPush.median, 25);
});

test('a run cancelled after it ran counts as a push but not in the run measures', () => {
  const ranJob = (a) => [{ name: 'What this run runs', status: 'completed', started_at: a, completed_at: a, steps: [] }];
  const rows = [
    runTimes(run(1, '2026-11-13T06:00:00Z', { conclusion: 'cancelled' }), ranJob('2026-11-13T06:02:00Z')),
    runTimes(run(2, '2026-11-13T06:10:00Z'), ranJob('2026-11-13T06:14:00Z')),
  ];
  const s = summarise(rows);
  assert.equal(s.finished, 1);
  assert.equal(s.waitRun.median, 4);
  assert.deepEqual(pushWaits(rows), [2, 4]);
});

test('quantile: median of odd and even counts, p90 between ranks, none for no values', () => {
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([null, Number.NaN], 0.5), null);
});
