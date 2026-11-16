// local-test-facts.mjs holds the stack's facts the journeys read: it imports node built-ins only, so a journey that
// reads a fact takes in none of the stack's code, and every script that kept one of these names hands out the same
// value from here (docs/runbooks/harness-rewrite-plan.md, piece 3). Run: node tooling/scripts/local-test-facts.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FACTS = fileURLToPath(new URL('./local-test-facts.mjs', import.meta.url));

/** The module specifiers a source imports, static or dynamic. */
export function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(
    /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
  ))
    out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const stray = (src) => importsOf(src).filter((s) => !s.startsWith('node:'));
assert.deepEqual(stray(readFileSync(FACTS, 'utf8')), [], 'local-test-facts.mjs imports node built-ins only');
// Planted faults the rule must catch.
assert.deepEqual(stray("import { loadProfile } from '../owner-settings.mjs';\n"), ['../owner-settings.mjs']);
assert.deepEqual(stray("const x = await import('./local-test-state.mjs');\n"), ['./local-test-state.mjs']);
assert.deepEqual(stray("export { a } from './local-test-chain.mjs';\n"), ['./local-test-chain.mjs']);

// Every script that kept a name hands out the facts' own value.
const facts = await import('./local-test-facts.mjs');
const kept = {
  './local-test-device.mjs': ['LOCAL_TEST_DEVICE_KEY', 'localTestDeviceState', 'localTestDeviceCookie', 'localTestAdminDeviceCookie'],
  './local-test-state.mjs': ['localStackState'],
  './local-test-founders.mjs': ['FOUNDER_VAULT_NAME'],
  './local-test-entry.mjs': ['OUTBOX_NAME'],
  './local-test-chain.mjs': ['TEST_CHAIN_ID', 'CHAIN_PORTS', 'GATE_URL', 'chainRecordPath'],
  './local-test-home.mjs': [
    'HOME_ASSET',
    'HOME_NETWORK',
    'HOME_DEPOSIT_AMOUNT',
    'HOME_DEPOSIT_CONFIRMATIONS',
    'HOME_DEPOSIT_LABEL',
    'HOME_NOTICE_TITLE',
    'HOME_NOTICE_BODY',
    'HOME_NOTICE_DAYS',
  ],
  './local-stack-services/bank.mjs': ['LOCAL_TEST_SANCTIONED_ADDRESS'],
};
for (const [file, names] of Object.entries(kept)) {
  const mod = await import(file);
  for (const n of names) assert.equal(mod[n], facts[n], `${file} ${n} is the facts' own`);
}
assert.equal(facts.localStackState('/home/u', {}), '/home/u/.intafaced/local-test-stack');
assert.throws(() => facts.localStackState('/home/u', { LOCAL_STACK_STATE: 'relative' }), /must be an absolute folder path/);
console.log('local-test-facts: node built-ins only, and every script hands out the same facts');

// Slots (LOCAL_STACK_SLOT, local-test-stack.mjs takeSlot): two starts can never hold one slot. Failure it prevents: two
// builders started cold on the fixed ports at 09:02 and 09:03 UTC, 15 Nov; neither was refused, since a stack still
// building holds no port, and the first failed after six minutes on `pg_ctl start failed (port 15460 busy?)`.
{
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'slots-'));
  const other = (slot, pid, state = join(home, 'none')) => {
    mkdirSync(join(home, '.intafaced', 'slots'), { recursive: true });
    writeFileSync(join(home, '.intafaced', 'slots', `${slot}.json`), JSON.stringify({ repo: '/elsewhere', pid, state }));
  };
  const dead = 2 ** 22 + 12345; // above every macOS and Linux pid limit: never a running process
  assert.equal(facts.localStackSlot({}, home), 0, 'no claim: slot 0, the stack as it always was');
  other(0, process.pid);
  assert.match(
    facts.anotherCheckoutsStack({}, home),
    /refusing: this checkout has no stack of its own, and slot 0 is \/elsewhere's .*1, 2, 3 free now/,
    "a checkout with no claim never acts on slot 0 when it is another checkout's live stack",
  );
  assert.equal(facts.anotherCheckoutsStack({ LOCAL_STACK_SLOT: '0' }, home), null, 'LOCAL_STACK_SLOT names one by hand');
  assert.equal(facts.claimSlot(0, { state: 's', home }), false, "a live claim of another checkout's start is never taken");
  assert.equal(facts.claimSlot(1, { state: 's', home }), true, 'the next free slot is');
  assert.equal(facts.localStackSlot({}, home), 1, "this checkout's scripts and journeys read the slot it claimed");
  assert.equal(facts.anotherCheckoutsStack({}, home), null, 'a checkout with its own claim acts on its own slot');
  assert.equal(facts.claimSlot(1, { state: 's', home }), true, 'its own claim is kept on the next start');
  other(2, dead);
  assert.equal(facts.slotClaims(home)[2].live, false, 'a start killed mid-build, with no stack process left, is a dead claim');
  const running = join(home, 'running');
  mkdirSync(join(running, 'run'), { recursive: true });
  writeFileSync(join(running, 'run', 'processes.json'), JSON.stringify({ edge: { pid: process.pid } }));
  other(3, dead, running);
  assert.equal(facts.slotClaims(home)[3].live, true, 'a claim whose start ended is live while its stack runs');
  facts.releaseSlot(home);
  assert.equal(existsSync(join(home, '.intafaced', 'slots', '1.json')), false, 'a full stop lets the slot go');
  other(1, dead);
  assert.equal(facts.claimSlot(1, { state: 's', home }), true, 'a dead claim is taken over');
  assert.equal(facts.localStackSlot({ LOCAL_STACK_SLOT: '2' }, home), 2, 'LOCAL_STACK_SLOT names one by hand');
  assert.throws(() => facts.localStackSlot({ LOCAL_STACK_SLOT: '4' }, home), /must be 0, 1, 2 or 3/);
  other(2, dead);
  const gone = JSON.parse(readFileSync(join(home, '.intafaced', 'slots', '2.json'), 'utf8'));
  assert.equal(facts.dropClaim(2, { ...gone, pid: 1 }, home), false, 'a reap lets go only of the claim it read');
  assert.equal(facts.dropClaim(2, gone, home), true, "a reaped owner's dead claim is let go");
  assert.equal(existsSync(join(home, '.intafaced', 'slots', '2.json')), false, 'and its slot is free');
  assert.equal(facts.dropClaim(3, facts.slotClaims(home)[3].claim, home), false, 'a live stack keeps its claim');
  console.log('local-test-facts: a live slot claim is never taken, a dead one is, and a stop lets it go');
}
