// Run: node --test tooling/scripts/journey-shard-balance.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRun, verdict } from './journey-shard-balance.mjs';

const at = (m) => new Date(Date.UTC(2026, 10, 23, 8, 0) + m * 60_000).toISOString();
const shard = (n, from, to, conclusion = 'success') => ({
  name: `Journeys (shard ${n} of 3)`,
  started_at: at(from),
  completed_at: at(to),
  conclusion,
});

test("a run's longest shard job against its median shard job, other jobs and skipped shards left out", () => {
  const r = readRun({ databaseId: 1, createdAt: at(0), updatedAt: at(20) }, [
    { name: 'What this run runs', started_at: at(0), completed_at: at(3), conclusion: 'success' },
    shard(1, 5, 15),
    shard(2, 5, 16),
    shard(3, 5, 20),
    { name: 'Journeys (shard 4 of 4)', started_at: at(5), completed_at: at(5), conclusion: 'skipped' },
  ]);
  assert.equal(r.runMinutes, 20);
  assert.equal(r.shards, 3);
  assert.equal(r.medianShard, 11);
  assert.equal(r.longest.name, 'Journeys (shard 3 of 3)');
  assert.equal(r.ratio, 15 / 11);
});

test('the bar: 20 runs of 5 minutes or more, newest first, a median of 17 or less and no shard over 1.3 times', () => {
  const run = (id, runMinutes, ratio = 1.1) => ({ id, runMinutes, ratio });
  const ok = Array.from({ length: 20 }, (_, i) => run(i, 16));
  assert.equal(verdict(ok).holds, true);
  assert.equal(verdict([run(99, 2), ...ok]).counted.length, 20, 'a run under 5 minutes ran no journeys and is not counted');
  assert.equal(verdict(ok.slice(0, 19)).holds, false, 'fewer than 20 runs is no reading');
  assert.equal(verdict(ok.map((r) => ({ ...r, runMinutes: 18 }))).holds, false, 'median over 17');
  // Run 45138504039, 23 Nov 2026: shard 17 took 21.3 minutes against a median shard of 15.4.
  const past = verdict([run(45138504039, 21.6, 21.3 / 15.4), ...ok.slice(1)]);
  assert.equal(past.holds, false);
  assert.deepEqual(
    past.over.map((r) => r.id),
    [45138504039],
  );
});
