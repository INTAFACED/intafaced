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
