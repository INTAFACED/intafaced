// The world restore's stack heal (apps/customer/tests/real-app/services.mjs, docs/runbooks/harness-rewrite-plan.md
// piece 5): after a file that restarts a service, a stack whose status is not healthy is started again, and what was
// done is said in words; a healthy stack is left alone. Run: node tooling/scripts/real-app-services.test.mjs
import assert from 'node:assert/strict';

const { healStack, downRows, withoutOff, blankServices } = await import('../../apps/customer/tests/real-app/services.mjs');

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
  const envs = [];
  const run = async (args, timeout, env) => {
    calls.push([args.join(' '), timeout]);
    envs.push(env);
    return answers.shift() ?? { code: 0, timedOut: false, stdout: '', stderr: '' };
  };
  return { run, calls, envs };
};
const ok = { code: 0, timedOut: false, stdout: '', stderr: '' };

{
  // Healthy, nothing left blank: status and overrides, nothing started, nothing said.
  const f = fake(ok, ok);
  assert.deepEqual(await healStack({ run: f.run, healMs: 100_000 }), []);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['status', 'overrides'],
  );
}
{
  // Down, healed: status, start, status; the down rows are named.
  const f = fake({ code: 1, timedOut: false, stdout: TABLE_DOWN, stderr: '' }, ok, ok, ok);
  const said = await healStack({ run: f.run, statusMs: 7, healMs: 60_000 });
  assert.deepEqual(f.calls, [
    ['status', 7],
    ['overrides', 7],
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
    ok,
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
  const f = fake({ code: 1, timedOut: false, stdout: TABLE_DOWN, stderr: '' }, ok);
  const said = await healStack({ run: f.run, healMs: 10_000 });
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['status', 'overrides'],
  );
  assert.equal(said[1], 'not started again: 10s left in this restore, under 60s; later files may fail on it');
}
const BLANK = { code: 0, timedOut: false, stdout: '{"agents":["LOCAL_STACK_AGENTS_RATES"]}\n', stderr: '' };
{
  // Healthy, but a file left svc-agents started with its rates off: it is restarted without them, then status.
  const env = { PATH: '/bin', LOCAL_STACK_AGENTS_RATES: 'off', LOCAL_STACK_STATE: '/tmp/s', LOCAL_STACK_S2S: 'on' };
  const f = fake(ok, BLANK, ok, ok);
  const said = await healStack({ run: f.run, statusMs: 7, healMs: 90_000, env });
  assert.deepEqual(f.calls, [
    ['status', 7],
    ['overrides', 7],
    ['restart agents', 90_000],
    ['status', 7],
  ]);
  assert.deepEqual(f.envs[2], { PATH: '/bin', LOCAL_STACK_STATE: '/tmp/s', LOCAL_STACK_S2S: 'on' }, 'restarted without the off value only');
  assert.deepEqual(said, [
    'started with an owner value off: agents (LOCAL_STACK_AGENTS_RATES)',
    'restarting agents without it',
    'stack healthy again',
  ]);
}
{
  // Down and blank at once: one restart (which also starts what is down), not a start and a restart.
  const f = fake({ code: 1, timedOut: false, stdout: TABLE_DOWN, stderr: '' }, BLANK, ok, ok);
  const said = await healStack({ run: f.run, healMs: 90_000, env: {} });
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['status', 'overrides', 'restart agents', 'status'],
  );
  assert.match(said[0], /^stack not healthy \(status exit 1: /);
  assert.equal(said.at(-1), 'stack healthy again');
}
{
  // Blank with too little time: said, nothing restarted.
  const f = fake(ok, BLANK);
  const said = await healStack({ run: f.run, healMs: 30_000 });
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['status', 'overrides'],
  );
  assert.equal(said.at(-1), 'not restarted: 30s left in this restore, under 60s; later files may fail on it');
}
{
  // An overrides answer that can't be read is said; a healthy stack is then left alone.
  const f = fake(ok, { code: 0, timedOut: false, stdout: 'not json', stderr: '' });
  assert.deepEqual(await healStack({ run: f.run, healMs: 90_000 }), [
    'could not read which services run with an owner value off (overrides answer is not JSON)',
  ]);
  assert.deepEqual(blankServices({ code: null, timedOut: true, stdout: '' }), { blank: {}, error: 'overrides timed out' });
  // Names and variables that aren't a service's or a LOCAL_STACK value are dropped, never passed to restart.
  assert.deepEqual(blankServices({ code: 0, stdout: '{"agents; rm":["X"],"ws":["LOCAL_STACK_WS_UPSTREAM","PATH"]}' }), {
    blank: { ws: ['LOCAL_STACK_WS_UPSTREAM'] },
  });
  assert.deepEqual(withoutOff({ LOCAL_STACK_HOSTS: 'off', LOCAL_STACK_HOSTS_X: 'on', HOME: 'off' }), {
    LOCAL_STACK_HOSTS_X: 'on',
    HOME: 'off',
  });
}
// The stack records the off values each process started with (local-test-stack.mjs offOverrides).
{
  const src = (await import('node:fs')).readFileSync(new URL('./local-test-stack.mjs', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(off\.length \? \{ offOverrides: off \} : \{\}\)/, 'startProc records offOverrides');
  assert.match(src, /cmd === 'overrides'/, "the stack tool answers 'overrides'");
}
// The restore's budget: a restart file gets about 100 s for the start; one that also moves the market gets too little.
{
  const { RESTORE_MS, BOOK_RESERVE_MS } = await import('../../apps/customer/tests/real-app/world-restore.mjs');
  const { MAKER_SETTLE_MS } = await import('../../apps/customer/tests/real-app/market.mjs');
  const { STATUS_MS, MIN_START_MS } = await import('../../apps/customer/tests/real-app/services.mjs');
  assert.ok(RESTORE_MS - BOOK_RESERVE_MS - 2 * STATUS_MS >= MIN_START_MS, 'a restart file can be healed');
  assert.ok(RESTORE_MS <= 150_000, "within journey.mjs's worldBetweenFiles time");
  assert.ok(RESTORE_MS - MAKER_SETTLE_MS - BOOK_RESERVE_MS - 2 * STATUS_MS < MIN_START_MS, 'a restart and market file only says');
}
// Rows that aren't the status table's, or that name a credential, are never shown.
assert.deepEqual(downRows('secret=abcdefghijklmnopqrstuvwxyz0123 DOWN\n  svc-ws 14510 - DOWN (0)'), ['svc-ws 14510 - DOWN (0)']);
console.log(
  'real-app services: a stack left down, or a service left with an owner value off, after a restart is put back before the next file, and said',
);
