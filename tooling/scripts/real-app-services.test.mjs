// The world restore's stack heal (apps/customer/tests/real-app/services.mjs, docs/runbooks/harness-rewrite-plan.md
// piece 5): after a file that restarts a service, a stack whose status is not healthy is started again, and what was
// done is said in words; a healthy stack is left alone. Run: node tooling/scripts/real-app-services.test.mjs
import assert from 'node:assert/strict';

const { healStack, downRows } = await import('../../apps/customer/tests/real-app/services.mjs');

const TABLE_DOWN = [
  'INTAFACED local test stack',
  '  svc-edge      14500 101 ok',
  '  svc-identity  14502 -   DOWN (0)',
  '  svc-indexer   14520 107 HALTED (behind)',
  '  postgres      15460 owned ok',
].join('\n');

/** A fake stack tool: answers each call from `answers` in order, and records the calls. */
const fake = (...answers) => {
  const calls = [];
  const run = async (args, timeout) => {
    calls.push([args.join(' '), timeout]);
    return answers.shift() ?? { code: 0, timedOut: false, stdout: '', stderr: '' };
  };
  return { run, calls };
};
const ok = { code: 0, timedOut: false, stdout: '', stderr: '' };

{
  // Healthy: one status, nothing started, nothing said.
  const f = fake(ok);
  assert.deepEqual(await healStack({ run: f.run, healMs: 100_000 }), []);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['status'],
  );
}
{
  // Down, healed: status, start, status; the down rows are named.
  const f = fake({ code: 1, timedOut: false, stdout: TABLE_DOWN, stderr: '' }, ok, ok);
  const said = await healStack({ run: f.run, statusMs: 7, healMs: 60_000 });
  assert.deepEqual(f.calls, [
    ['status', 7],
    ['start', 60_000],
    ['status', 7],
  ]);
  assert.equal(said.length, 2);
  assert.match(
    said[0],
    /^stack not healthy \(status exit 1: svc-identity +14502 - +DOWN \(0\); svc-indexer +14520 107 HALTED \(behind\)\); starting what is down$/,
  );
  assert.equal(said[1], 'stack healthy again');
}
{
  // Down, the start times out and the stack stays down: said, never thrown.
  const f = fake(
    { code: null, timedOut: true, stdout: '', stderr: '' },
    { code: null, timedOut: true, stdout: '', stderr: '' },
    {
      code: 1,
      timedOut: false,
      stdout: TABLE_DOWN,
      stderr: '',
    },
  );
  const said = await healStack({ run: f.run, statusMs: 20_000, healMs: 80_000 });
  assert.deepEqual(said, [
    'stack not healthy (status timed out after 20s); starting what is down',
    'start timed out after 80s',
    'stack still not healthy: svc-identity  14502 -   DOWN (0); svc-indexer   14520 107 HALTED (behind); later files may fail on it',
  ]);
}
{
  // Too little time left in the restore: it says what is down and starts nothing (a start cut off part-way helps no one).
  const f = fake({ code: 1, timedOut: false, stdout: TABLE_DOWN, stderr: '' });
  const said = await healStack({ run: f.run, healMs: 10_000 });
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['status'],
  );
  assert.equal(said[1], 'not started again: 10s left in this restore, under 60s; later files may fail on it');
}
// The restore's budget: a restart file gets about 100 s for the start; one that also moves the market gets too little.
{
  const { RESTORE_MS, BOOK_RESERVE_MS, MAKER_QUOTING_MS } = await import('../../apps/customer/tests/real-app/world-restore.mjs');
  const { STATUS_MS, MIN_START_MS } = await import('../../apps/customer/tests/real-app/services.mjs');
  assert.ok(RESTORE_MS - BOOK_RESERVE_MS - 2 * STATUS_MS >= MIN_START_MS, 'a restart file can be healed');
  assert.ok(RESTORE_MS <= 150_000, "within journey.mjs's worldBetweenFiles time");
  assert.ok(RESTORE_MS - MAKER_QUOTING_MS - BOOK_RESERVE_MS - 2 * STATUS_MS < MIN_START_MS, 'a restart and market file only says');
}
// Rows that aren't the status table's, or that name a credential, are never shown.
assert.deepEqual(downRows('secret=abcdefghijklmnopqrstuvwxyz0123 DOWN\n  svc-ws 14510 - DOWN (0)'), ['svc-ws 14510 - DOWN (0)']);
console.log('real-app services: a stack left down after a restart is started again before the next file, and said');
