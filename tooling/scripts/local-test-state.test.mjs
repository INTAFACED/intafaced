// State isolation, including the detached market child; no stack, database or real funds started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localStackState } from './local-test-state.mjs';
import { stackPaths as marketPaths } from './local-test-market.mjs';
import { stackPaths as worldPaths } from './local-test-world.mjs';
import { gatePaths } from './local-test-gates.mjs';

assert.equal(localStackState('/test-home', {}), '/test-home/.intafaced/local-test-stack');
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
  assert.ok(fs.existsSync(path.join(state, 'market-accounts.json')), 'detached child must use selected state');
  assert.match(fs.readFileSync(log, 'utf8'), /EXIT pid \d+ code 1: crashed/);
  assert.deepEqual(fs.readdirSync(oldState), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(oldState, 'sentinel'), 'utf8'), 'old state must stay untouched');
} finally {
  if (previous === undefined) delete process.env.LOCAL_STACK_STATE;
  else process.env.LOCAL_STACK_STATE = previous;
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('local-test-state: helper isolation, read-only plan, fund refusal and detached child checks passed');
