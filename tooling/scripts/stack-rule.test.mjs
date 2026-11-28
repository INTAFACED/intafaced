// The one rule for heavy work (stack-slots.json, owner decision A, project-state#4160): what an agent's start may run,
// and the queue for a shared slot.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BETA_SLOT as HOST_BETA } from '../beta/beta-host.mjs';
import { SLOTS } from './local-test-facts.mjs';
import { BETA_SLOT, RULE, SHARED_SLOTS, STACK_GIB, QUEUE_MINUTES, agentStart, queueTurn, startGate, visibleFiles } from './stack-rule.mjs';

const agent = { T3CODE_THREAD_ID: 't' };
const ui = ['apps/customer/src/routes/wallet.tsx'];

test('the rule: two shared slots, the beta its own, every one with ports; the beta host and the start read the same file', () => {
  assert.deepEqual(SHARED_SLOTS, [0, 1]);
  assert.equal(BETA_SLOT, 3);
  assert.equal(HOST_BETA, RULE.beta, 'beta-host.mjs takes its slot from stack-slots.json');
  assert.ok(!SHARED_SLOTS.includes(BETA_SLOT), "the beta's slot is never a shared one");
  for (const s of [...SHARED_SLOTS, BETA_SLOT]) assert.ok(SLOTS.includes(s), `slot ${s} has ports`);
  assert.ok(STACK_GIB > 0 && QUEUE_MINUTES > 0);
});

test('a person, CI, the beta and a checkout already holding a slot are never gated', () => {
  assert.equal(startGate({ env: {}, platform: 'linux', files: [] }), null, 'a person');
  assert.equal(startGate({ env: { ...agent, CI: 'true' }, platform: 'linux', files: [] }), null, 'CI');
  assert.equal(startGate({ env: { LOCAL_STACK_SLOT: '3' }, platform: 'linux', files: [] }), null, "the beta's supervisor is no agent");
  assert.equal(
    startGate({ env: agent, platform: 'linux', files: [], holdsClaim: true }),
    null,
    'a start under the old rule finishes under it',
  );
  assert.equal(agentStart({ CLAUDECODE: '1' }), true);
  assert.equal(agentStart({}), false);
});

test("an agent's start: only a visible change, only on the box, only in a shared slot; else CI", () => {
  assert.equal(startGate({ env: agent, platform: 'linux', files: ui }), null, 'a visible change queues for a shared slot');
  assert.equal(startGate({ env: { CLAUDECODE: '1', LOCAL_STACK_SLOT: '1' }, platform: 'linux', files: ui }), null);
  const refused = (o, re) => assert.match(startGate({ env: agent, platform: 'linux', files: ui, ...o }), re);
  refused(
    { files: ['services/svc-trade/src/x.ts', 'apps/customer/tests/real-app/J-x-01.pw.mjs'] },
    /^refusing: this change touches nothing a person sees.*CI proves it/,
  );
  refused({ files: [] }, /nothing a person sees/);
  refused({ files: null }, /could not be read/);
  refused({ platform: 'darwin' }, /^refusing: an agent starts no local stack on the Mac/);
  for (const slot of ['2', '3']) refused({ env: { ...agent, LOCAL_STACK_SLOT: slot } }, new RegExp(`slot ${slot} is not a shared slot`));
});

test('visible: an app outside its tests, and the UI and copy packages', () => {
  assert.deepEqual(
    visibleFiles([
      'apps/customer/src/a.tsx',
      'apps/admin/app/page.tsx',
      'apps/customer/tests/real-app/J-x-01.pw.mjs',
      'packages/ui/src/button.tsx',
      'packages/i18n/en.json',
      'packages/contracts/src/x.ts',
      'services/svc-edge/src/x.ts',
      'tooling/scripts/local-test-stack.mjs',
    ]),
    ['apps/customer/src/a.tsx', 'apps/admin/app/page.tsx', 'packages/ui/src/button.tsx', 'packages/i18n/en.json'],
  );
});

test('the queue: first come first served; a gone start leaves it', () => {
  const alive = (pid) => pid !== 9;
  const t = [
    { pid: 5, at: 300 },
    { pid: 9, at: 100 },
    { pid: 7, at: 200 },
  ];
  assert.deepEqual(queueTurn(t, { pid: 7, at: 200 }, alive), { ahead: 0, dead: [t[1]] }, 'the oldest live ticket goes first');
  assert.equal(queueTurn(t, { pid: 5, at: 300 }, alive).ahead, 1);
  assert.equal(queueTurn([], { pid: 5, at: 300 }, alive).ahead, 0, 'an empty queue: its own turn');
});

test("an agent's start that may not run a stack exits 3 before it claims anything", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-rule-'));
  const r = spawnSync(process.execPath, [new URL('./local-test-stack.mjs', import.meta.url).pathname, 'start'], {
    env: { PATH: process.env.PATH, HOME: home, T3CODE_THREAD_ID: 't', LOCAL_STACK_SLOT: '2' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /local-test-stack: refusing: (an agent starts no local stack on the Mac|slot 2 is not a shared slot)/);
  assert.equal(fs.existsSync(path.join(home, '.intafaced', 'slots')), false, 'no slot was claimed');
});
