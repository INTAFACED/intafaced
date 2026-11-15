/**
 * shard-download.mjs: the journeys run's shard reports are downloaded with a spent API budget waited out, never swallowed.
 * The planted case is run 4084 (43127556856, 12 Nov 2026): its merge got "HTTP 403: API rate limit exceeded for
 * installation", carried on with 0 of 32 shard reports, and saved no report.json. Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_WAITS, downloadShards, primaryLimit, refused, waitFor } from './shard-download.mjs';

// Run 4084's own line, shortened (scoreboard job 130899706856, 01:09:40 UTC).
const LIMIT =
  'error fetching artifacts: HTTP 403: API rate limit exceeded for installation. If you reach out to GitHub Support for help, please include the request ID 7C40:7B849:26ECC19:7B49EEE:6AF511D4';
const SECONDARY = 'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
const NOT_FOUND = 'no valid artifacts found to download';
const fail = (stderr) => Object.assign(new Error(`Command failed: gh run download\n${stderr}`), { stderr });

/** A fake GitHub: `answers` the outcome of each download in turn (null is a success). */
function fake(answers, { reset = 1_794_451_200, now = 1_794_449_400_000 } = {}) {
  const calls = { downloads: 0, waits: [], logs: [] };
  let clock = now;
  return {
    calls,
    io: {
      download: () => {
        const a = answers[calls.downloads++];
        if (a) throw fail(a);
      },
      budget: () => ({ limit: 1000, used: 1000, remaining: 0, reset }),
      wait: (ms) => {
        calls.waits.push(ms);
        clock += ms;
      },
      now: () => clock,
      log: (l) => calls.logs.push(l),
    },
  };
}

test('run 4084 replayed: a spent budget is waited out until its reset, then the shards download', () => {
  // 01:09:40 UTC; the budget resets at 01:40:00 UTC.
  const { io, calls } = fake([LIMIT, null], { now: Date.parse('2026-11-12T01:09:40Z'), reset: Date.parse('2026-11-12T01:40:00Z') / 1000 });
  assert.deepEqual(downloadShards(io), { ok: true });
  assert.equal(calls.downloads, 2);
  assert.deepEqual(calls.waits, [(30 * 60 + 20) * 1000 + 5000]);
  assert.match(calls.logs[0], /rate-limited \(1000 of 1000 used, resets 2026-11-12T01:40:00.000Z\): waiting 1825 s/);
});

test('bounded: at most MAX_WAITS waits, never past the job, and the step fails by name', () => {
  const still = fake([LIMIT, LIMIT, LIMIT, LIMIT]);
  const got = downloadShards(still.io);
  assert.equal(got.ok, false);
  assert.match(got.why, new RegExp(`still rate-limited after ${MAX_WAITS} wait`));
  assert.equal(still.calls.waits.length, MAX_WAITS);

  const late = fake([LIMIT, null], { now: 0, reset: 1800 });
  const out = downloadShards(late.io, { deadline: 10 * 60_000 });
  assert.equal(out.ok, false);
  assert.match(out.why, /past this job's time/);
  assert.equal(late.calls.waits.length, 0);
});

test('a refusal (a secondary limit, a 401, a 429) is never retried; a dropped connection is, twice', () => {
  for (const said of [
    SECONDARY,
    'HTTP 401: Bad credentials',
    'HTTP 429: Too Many Requests',
    'HTTP 403: Resource not accessible by integration',
  ]) {
    const { io, calls } = fake([said, null]);
    const got = downloadShards(io);
    assert.equal(got.ok, false, said);
    assert.match(got.why, /refused, not retried/);
    assert.equal(calls.downloads, 1);
  }
  const flaky = fake(['read: connection reset by peer', 'HTTP 502', null]);
  assert.deepEqual(downloadShards(flaky.io, { pauses: [1, 2] }), { ok: true });
  assert.deepEqual(flaky.calls.waits, [1, 2]);
  const down = fake(['HTTP 502', 'HTTP 502', 'HTTP 502']);
  assert.match(downloadShards(down.io, { pauses: [1, 2] }).why, /failed 3 times: HTTP 502/);
});

test('no shard artifact at all (no shard started) is not a failure here: the next step names the missing shards', () => {
  const { io, calls } = fake([NOT_FOUND]);
  assert.deepEqual(downloadShards(io), { ok: true });
  assert.match(calls.logs[0], /no shard artifact to download/);
});

test('which answers are which', () => {
  assert.equal(primaryLimit(LIMIT), true);
  assert.equal(primaryLimit(SECONDARY), false);
  assert.equal(refused(LIMIT), false);
  assert.equal(refused(SECONDARY), true);
  assert.equal(refused('read: connection reset by peer'), false);
  assert.equal(waitFor(100, 50_000), 55_000);
  assert.equal(waitFor(100, 200_000), 5_000, 'a reset already past waits only the margin');
  assert.equal(waitFor(10_000, 0), null, 'a reset past the cap is not waited for');
});
