// State isolation, including the detached market child; no stack, database or real funds started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localStackState, localPgOsUser, assertStackOwnership, processRecordMatches, postgresProcessMatches } from './local-test-state.mjs';
import { stackPaths as marketPaths } from './local-test-market.mjs';
import { stackPaths as worldPaths } from './local-test-world.mjs';
import { gatePaths } from './local-test-gates.mjs';

assert.equal(localStackState('/test-home', {}), '/test-home/.intafaced/local-test-stack');
assert.equal(localStackState('/root', { LOCAL_STACK_STATE: '/srv/stack' }), '/srv/stack');
assert.equal(localPgOsUser({}, 501), null);
assert.equal(localPgOsUser({}, 0), 'postgres');
assert.equal(localPgOsUser({ LOCAL_STACK_PG_USER: 'pgrunner' }, 0), 'pgrunner');
for (const value of ['', ' ', 'relative/path']) {
  assert.throws(() => localStackState('/test-home', { LOCAL_STACK_STATE: value }), /absolute folder path/);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-test-state-'));
const state = path.join(home, 'fresh-test-state');
const oldState = path.join(home, '.intafaced', 'local-test-stack');
const previous = process.env.LOCAL_STACK_STATE;
const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, LOCAL_STACK_STATE: state };
const run = (script, ...args) => spawnSync(process.execPath, [path.join(here, script), ...args], { env, encoding: 'utf8' });
try {
  fs.mkdirSync(oldState, { recursive: true });
  fs.writeFileSync(path.join(oldState, 'sentinel'), 'old state must stay untouched');
  process.env.LOCAL_STACK_STATE = state;
  for (const paths of [marketPaths(home), worldPaths(home), gatePaths(home)]) {
    assert.equal(paths.stateDir, state);
    assert.equal(paths.marker, path.join(state, 'LOCAL-TEST-STACK.json'));
    assert.equal(paths.secrets, path.join(state, 'secrets.json'));
  }
  let result = run('local-test-stack.mjs', 'plan', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).stateDir, state);
  assert.equal(fs.existsSync(state), false, 'plan must remain read-only');
  // Every mutation helper must refuse the selected missing marker rather than using old state.
  for (const [script, args] of [
    ['local-test-stack.mjs', ['fund', 'test@example.invalid', 'USDT', '1']],
    ['local-test-market.mjs', ['ensure']],
    ['local-test-world.mjs', ['watch']],
    ['local-test-gates.mjs', ['apply']],
  ]) {
    result = run(script, ...args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(state), result.stderr);
  }
  fs.mkdirSync(path.join(state, 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(state, 'LOCAL-TEST-STACK.json'),
    JSON.stringify({
      kind: 'intafaced-local-test-stack',
      ports: { edge: 14500, closed: 1 },
    }),
  );
  fs.writeFileSync(
    path.join(state, 'run', 'market.json'),
    JSON.stringify({
      pid: 999999999,
      args: ['--edge-url', 'http://127.0.0.1:1'],
    }),
  );
  result = run('local-test-market.mjs', 'ensure');
  assert.equal(result.status, 0, result.stderr);
  const log = path.join(state, 'logs', 'market.log');
  const deadline = Date.now() + 5_000;
  while ((!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes('EXIT pid')) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(path.join(state, 'market-accounts.json')), false, 'ownership refusal must precede account creation');
  assert.match(fs.readFileSync(log, 'utf8'), /EXIT pid \d+ code 1: crashed/);
  assert.match(fs.readFileSync(log, 'utf8'), /missing ownership records/);
  assert.deepEqual(fs.readdirSync(oldState), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(oldState, 'sentinel'), 'utf8'), 'old state must stay untouched');
} finally {
  if (previous === undefined) delete process.env.LOCAL_STACK_STATE;
  else process.env.LOCAL_STACK_STATE = previous;
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('local-test-state: helper isolation, read-only plan, fund refusal and detached child checks passed');

// A valid marker plus stale records must not authorize traffic to a different stack on the same ports.
const stateDir = '/fixture/fresh';
const repo = '/fixture/checkout';
const startedAt = Date.parse('2026-10-15T12:00:00Z');
const command = '/usr/bin/node /fixture/checkout/services/svc-edge/dist/index.js';
const processRecord = { pid: 20, argv: command.split(' '), startedAt: new Date(startedAt + 123).toISOString() };
const processIdentity = { command, startedAt };
assert.equal(processRecordMatches(processRecord, processIdentity), true, 'correct process matches without any other services');
assert.equal(processRecordMatches(processRecord, null), false, 'dead process');
assert.equal(
  processRecordMatches(processRecord, { ...processIdentity, startedAt: startedAt + 2124 }),
  false,
  'outside ps precision allowance',
);
assert.equal(
  processRecordMatches(processRecord, { ...processIdentity, startedAt: startedAt + 10_000 }),
  false,
  'reused PID, identical argv',
);
assert.equal(processRecordMatches(processRecord, { ...processIdentity, command: `${command} --other-root` }), false, 'extra argv');
assert.equal(
  processRecordMatches(processRecord, { ...processIdentity, command: command.replace('/checkout/', '/other-checkout/') }),
  false,
  'other checkout',
);
assert.equal(processRecordMatches({ ...processRecord, startedAt: undefined }, processIdentity), false, 'missing birth time refuses');
assert.equal(processRecordMatches({ ...processRecord, argv: undefined }, processIdentity), false, 'missing argv refuses');
assert.equal(
  postgresProcessMatches('/fixture/fresh/data/postgres', startedAt, {
    command: '/bin/postgres -D /fixture/fresh/data/postgres -p 15460',
    startedAt,
  }),
  true,
);
assert.equal(
  postgresProcessMatches('/fixture/fresh/data/postgres', startedAt, {
    command: '/bin/postgres -D /fixture/fresh/data/postgres-other -p 15460',
    startedAt,
  }),
  false,
  'Postgres data-dir prefix',
);
assert.equal(
  postgresProcessMatches('/fixture/fresh/data/postgres', startedAt, {
    command: '/bin/postgres -D /fixture/fresh/data/postgres -p 15460',
    startedAt: startedAt + 10_000,
  }),
  false,
  'Postgres PID reuse',
);
const fixture = () => ({
  stateDir,
  marker: { kind: 'intafaced-local-test-stack', repo, ports: { postgres: 15460, edge: 14500 } },
  records: { edge: { pid: 20, argv: command.split(' '), startedAt: new Date(startedAt + 123).toISOString() } },
  postgres: ['10', '/fixture/fresh/data/postgres', String(startedAt / 1000), '15460'],
  processes: new Map([
    [10, { command: '/bin/postgres -D /fixture/fresh/data/postgres -p 15460', startedAt }],
    [20, { command, startedAt }],
  ]),
  listeners: new Map([
    [10, new Set(['127.0.0.1:15460'])],
    [20, new Set(['127.0.0.1:14500'])],
  ]),
  services: ['edge'],
});
assert.doesNotThrow(() => assertStackOwnership(fixture()));
for (const alter of [
  (f) => {
    f.postgres[1] = '/fixture/old/data/postgres';
  },
  (f) => {
    f.processes.delete(20);
  },
  (f) => {
    f.processes.get(20).command = '/usr/bin/node /fixture/old/services/svc-edge/dist/index.js';
  },
  (f) => {
    f.processes.get(20).startedAt += 10_000;
  },
  (f) => {
    f.listeners.set(20, new Set());
    f.listeners.set(30, new Set(['127.0.0.1:14500']));
  },
  (f) => {
    f.listeners.set(20, new Set(['*:14500']));
  },
]) {
  const example = fixture();
  alter(example);
  assert.throws(() => assertStackOwnership(example), /refusing: selected local stack is not active/);
}
console.log('local-test-state: database, process reuse, checkout and listener ownership checks passed');
