// The journey harness's posting-freeze guard (journey-freeze-guard.mjs; apps/customer/tests/real-app/journey.mjs).
// Run: node --test tooling/scripts/journey-freeze-guard.test.mjs (also by the tooling-tests Doctrine gate).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { freezeVerdict, guardPostingFreeze, leakedFreezePlan, postingFromHealth } from './journey-freeze-guard.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JOURNEYS = join(ROOT, 'apps/customer/tests/real-app');

/** A fake ledger switch that answers `reads` in order, and a lift that records its calls. */
function stack(reads, liftResult = () => 'ledger posting open (approval A1)') {
  const seen = [...reads];
  const lifts = [];
  return {
    lifts,
    readPosting: async () => seen.shift() ?? null,
    lift: async () => {
      lifts.push(1);
      return liftResult();
    },
  };
}

test('verdicts: a freeze is blamed only on the test that turned posting off and left it off', () => {
  assert.equal(freezeVerdict(true, true), 'clean');
  assert.equal(freezeVerdict(true, false), 'leaked');
  assert.equal(freezeVerdict(false, false), 'inherited');
  assert.equal(freezeVerdict(false, true), 'clean');
  assert.equal(freezeVerdict(null, false), 'clean', 'an unreadable switch before gives nothing to compare');
  assert.equal(freezeVerdict(true, null), 'clean', 'an unreadable switch after blames no one');
});

test('a test that leaks the freeze on purpose fails by name, after the guard lifts it', async () => {
  const s = stack([true, false]);
  await assert.rejects(
    guardPostingFreeze({ title: 'J-identity-08 #7 leaks on purpose', ...s, body: async () => {} }),
    /^Error: FREEZE LEAK: "J-identity-08 #7 leaks on purpose" left the platform posting freeze on; the guard lifted it: ledger posting open \(approval A1\)$/,
  );
  assert.equal(s.lifts.length, 1);
});

test('a leak the guard cannot lift still fails by name and says the shard runs frozen', async () => {
  const s = stack([true, false], () => {
    throw new Error('posting-freeze off refused: frozen for a reason no journey gives');
  });
  await assert.rejects(
    guardPostingFreeze({ title: 'J-x-01 #1', ...s, body: async () => {} }),
    /FREEZE LEAK: "J-x-01 #1" .* could NOT lift it \(posting-freeze off refused: .*\); every journey after this one runs frozen/,
  );
});

test('a test that timed out inside its freeze is the one blamed: the leak replaces its own error', async () => {
  const s = stack([true, false]);
  await assert.rejects(
    guardPostingFreeze({
      title: 'J-identity-08 #7',
      ...s,
      body: async () => {
        throw new Error('Test timeout of 240000ms exceeded.');
      },
    }),
    /FREEZE LEAK: "J-identity-08 #7"/,
  );
  assert.equal(s.lifts.length, 1);
});

test('no leak: the test passes or fails on its own, and nothing is lifted', async () => {
  const open = stack([true, true]);
  await guardPostingFreeze({ title: 'J-pay-03 #1', ...open, body: async () => {} });
  assert.equal(open.lifts.length, 0);

  const ownFailure = stack([true, true]);
  await assert.rejects(
    guardPostingFreeze({
      title: 'J-pay-03 #1',
      ...ownFailure,
      body: async () => {
        throw new Error('its own assertion');
      },
    }),
    /^Error: its own assertion$/,
  );

  // A freeze already on before the test (an earlier leak, or a stack frozen on purpose) is not this test's.
  const inherited = stack([false, false]);
  await guardPostingFreeze({ title: 'J-ops-console-22 #1', ...inherited, body: async () => {} });
  assert.equal(inherited.lifts.length, 0);
});

test("the ledger's /health body: postingEnabled, or nothing", () => {
  assert.equal(postingFromHealth({ ok: true, postingEnabled: false }), false);
  assert.equal(postingFromHealth({ ok: true, postingEnabled: true }), true);
  assert.equal(postingFromHealth({ ok: true }), null);
  assert.equal(postingFromHealth(null), null);
});

test('lift-leaked lifts only a LOCAL TEST freeze', () => {
  const v = 'v7';
  assert.deepEqual(leakedFreezePlan({ frozen: false, version: v }), { action: 'skip' });
  assert.deepEqual(leakedFreezePlan({ frozen: true, version: v, reason: 'LOCAL TEST J-identity-08 #7 posting freeze' }), {
    action: 'run',
  });
  assert.deepEqual(
    leakedFreezePlan({ frozen: true, version: v, reason: 'LOCAL TEST — not a real approval: platform posting freeze for a journey step' }),
    { action: 'run' },
  );
  assert.equal(leakedFreezePlan({ frozen: true, version: v, reason: 'reconciliation self-freeze: residual 4.20' }).action, 'refuse');
  assert.equal(leakedFreezePlan({ frozen: true, version: v, reason: 'NOT LOCAL TEST' }).action, 'refuse');
  assert.equal(leakedFreezePlan({ frozen: true, reason: 'LOCAL TEST x' }).action, 'refuse', 'no version to bind an approval to');
  assert.equal(leakedFreezePlan(null).action, 'refuse');
});

test('every journey file takes `test` from journey.mjs, so the guard wraps every step', () => {
  const files = readdirSync(JOURNEYS).filter((f) => f.endsWith('.mjs') && f !== 'journey.mjs');
  assert.ok(files.filter((f) => f.endsWith('.pw.mjs')).length > 100, 'the journeys folder holds the journeys');
  const direct = files.filter((f) =>
    /import\s*\{[^}]*\btest\b(?!\s+as\s+base)[^}]*\}\s*from\s*'@playwright\/test'/.test(readFileSync(join(JOURNEYS, f), 'utf8')),
  );
  assert.deepEqual(
    direct,
    [],
    `these import test from '@playwright/test' directly, which skips the posting-freeze guard; import { test, expect } from './journey.mjs' instead`,
  );
  assert.match(readFileSync(join(JOURNEYS, 'journey.mjs'), 'utf8'), /postingFreezeGuard: \[[\s\S]*auto: true/);
});
