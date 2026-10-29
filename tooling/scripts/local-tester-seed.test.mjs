/**
 * Unit tests for local-tester-seed (the compose `seed` service's entrypoint). No process is started: `spawn` is watched.
 * Run: node --test tooling/scripts/local-tester-seed.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_STEPS, GuardError, STEPS, assertTesterBuild, main, parseArgs } from './local-tester-seed.mjs';

function watch(codes = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ script: path.basename(args[0]), args: args.slice(1), env: opts.env });
    return { status: codes[`${path.basename(args[0])} ${args[1]}`] ?? 0 };
  };
  const lines = [];
  return { calls, lines, spawn, log: (line) => lines.push(line) };
}

for (const appEnv of ['staging', 'prod', 'production', 'Dev', '', undefined]) {
  test(`APP_ENV ${JSON.stringify(appEnv)} refuses with exit 2 and runs no step`, () => {
    const w = watch();
    const env = appEnv === undefined ? {} : { APP_ENV: appEnv };
    assert.equal(main([], env, w), 2);
    assert.deepEqual(w.calls, []);
    const shown = appEnv === undefined || appEnv === '' ? 'not set' : `"${appEnv}"`;
    assert.deepEqual(w.lines, [
      `refusing: APP_ENV is ${shown}; the tester seed runs only when it is exactly "dev" or "test", and seeded nothing.`,
    ]);
  });
}

test('NODE_ENV production refuses even on a dev APP_ENV', () => {
  const w = watch();
  assert.equal(main([], { APP_ENV: 'dev', NODE_ENV: 'production' }, w), 2);
  assert.deepEqual(w.calls, []);
  assert.throws(() => assertTesterBuild({ APP_ENV: 'test', NODE_ENV: 'production' }), GuardError);
});

test('an unknown step refuses before any step runs', () => {
  const w = watch();
  assert.equal(main(['local-founder-seed.mjs init', 'local-test-seed.mjs wipe'], { APP_ENV: 'dev' }, w), 2);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.lines, ['refusing: unknown seed step "local-test-seed.mjs wipe"']);
  assert.throws(() => parseArgs(['--state']), GuardError);
});

test('a dev build runs every step in order, each with only its own flag, and passes --state to the content seed', () => {
  const w = watch();
  assert.equal(main([...DEFAULT_STEPS, '--state', '/tmp/stack'], { APP_ENV: 'test' }, w), 0);
  assert.deepEqual(
    w.calls.map((call) => [call.script, ...call.args]),
    [
      ['local-founder-seed.mjs', 'init'],
      ['local-founder-seed.mjs', 'enrol'],
      ['local-test-seed.mjs', 'apply', '--state', '/tmp/stack'],
      ['local-test-seed.mjs', 'home', '--state', '/tmp/stack'],
      ['local-test-seed.mjs', 'status', '--state', '/tmp/stack'],
    ],
  );
  for (const call of w.calls.slice(0, 2)) {
    assert.equal(call.env.INTAFACED_LOCAL_FOUNDER, '1');
    assert.equal(call.env.LOCAL_TEST, undefined);
  }
  for (const call of w.calls.slice(2)) {
    assert.equal(call.env.LOCAL_TEST, '1');
    assert.equal(call.env.INTAFACED_LOCAL_FOUNDER, undefined);
  }
  assert.equal(w.lines.at(-1), 'seed: done (5 steps)');
  assert.deepEqual(Object.keys(STEPS), [...DEFAULT_STEPS]);
});

test('a failing step stops the run with its exit code; the steps after it do not run', () => {
  const w = watch({ 'local-founder-seed.mjs enrol': 3 });
  assert.equal(main([], { APP_ENV: 'dev' }, w), 3);
  assert.deepEqual(
    w.calls.map((call) => `${call.script} ${call.args[0]}`),
    ['local-founder-seed.mjs init', 'local-founder-seed.mjs enrol'],
  );
  assert.equal(w.lines.at(-1), 'seed: local-founder-seed.mjs enrol exited 3; the steps after it did not run');
});

test('a step killed by a signal (no status) counts as a failure', () => {
  const w = watch();
  const spawn = (...args) => ({ ...w.spawn(...args), status: null });
  assert.equal(main(['local-test-seed.mjs apply'], { APP_ENV: 'dev' }, { spawn, log: w.log }), 1);
});
