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

/** A fake ledger switch that answers `reads` in order (then its last answer), and a lift that records its calls. */
function stack(reads, liftResult = () => 'ledger posting open (approval A1)') {
  const seen = [...reads];
  const lifts = [];
  return {
    lifts,
    readPosting: async () => (seen.length > 1 ? seen.shift() : seen[0]),
    lift: async () => {
      lifts.push(1);
      return liftResult();
    },
    sleep: async () => {},
  };
}

test('verdicts: a freeze is blamed on the test after which posting is off and was not seen off before', () => {
  assert.equal(freezeVerdict(true, true), 'clean');
  assert.equal(freezeVerdict(true, false), 'leaked');
  assert.equal(freezeVerdict(false, false), 'inherited');
  assert.equal(freezeVerdict(false, true), 'clean');
  assert.equal(freezeVerdict(null, false), 'leaked', 'a ledger that did not answer before still gets its freeze lifted');
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
    throw new Error('posting-freeze lift-leaked refused: frozen for a reason no journey gives');
  });
  await assert.rejects(
    guardPostingFreeze({ title: 'J-x-01 #1', ...s, body: async () => {} }),
    /FREEZE LEAK: "J-x-01 #1" .* could NOT lift it \(posting-freeze lift-leaked refused: .*\); every journey after this one runs frozen/,
  );
});

test("a timed-out test's own finally that lifts within the grace is not a leak", async () => {
  // Playwright does not cancel a timed-out body: its finally lifts while the guard waits.
  const s = stack([true, false, false, true]);
  await guardPostingFreeze({ title: 'J-identity-08 #7', ...s, body: async () => {} });
  assert.equal(s.lifts.length, 0);
});

test("a lift refused because the test's own cleanup won the race still fails, and says posting is open", async () => {
  const s = stack([true, false, false, false, false, true], () => {
    throw new Error('approval version already consumed');
  });
  await assert.rejects(
    guardPostingFreeze({ title: 'J-x-01 #1', ...s, graceMs: 3_000, body: async () => {} }),
    /posting is open again, though the guard's own lift was refused \(approval version already consumed\)/,
  );
});

test('a freeze after a test the ledger did not answer before is lifted and named as such', async () => {
  const s = stack([null, false]);
  await assert.rejects(
    guardPostingFreeze({ title: 'J-x-01 #1', ...s, body: async () => {} }),
    /FREEZE LEAK: "J-x-01 #1" left the platform posting freeze on \(the ledger did not answer before it, so it may have been frozen already\); the guard lifted it/,
  );
  assert.equal(s.lifts.length, 1);
});

test('no leak: nothing is lifted, and a freeze already on before the test is not its', async () => {
  const open = stack([true, true]);
  await guardPostingFreeze({ title: 'J-pay-03 #1', ...open, body: async () => {} });
  assert.equal(open.lifts.length, 0);

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
  for (const reason of [
    'LOCAL TEST J-identity-08 #7 posting freeze',
    'LOCAL TEST J-campaigns-03 #3 hold release t1',
    'LOCAL TEST J-ops-console-03 #7 t1',
    'LOCAL TEST — not a real approval: platform posting freeze for a journey step',
  ])
    assert.deepEqual(leakedFreezePlan({ frozen: true, version: v, reason }), { action: 'run' }, reason);
  assert.equal(leakedFreezePlan({ frozen: true, version: v, reason: 'reconciliation self-freeze: residual 4.20' }).action, 'refuse');
  assert.equal(leakedFreezePlan({ frozen: true, version: v, reason: 'NOT LOCAL TEST' }).action, 'refuse');
  assert.equal(leakedFreezePlan({ frozen: true, reason: 'LOCAL TEST x' }).action, 'refuse', 'no version to bind an approval to');
  assert.equal(leakedFreezePlan(null).action, 'refuse');
});

test('the posting-freeze lift-leaked command uses that plan and names itself when it refuses', () => {
  const gates = readFileSync(join(ROOT, 'tooling/scripts/local-test-gates.mjs'), 'utf8');
  assert.match(gates, /'lift-leaked'\s*\n?\s*\? await setPostingFreeze\(ctx, false, leakedFreezePlan, 'lift-leaked'\)/);
  assert.match(gates, /throw new Error\(`posting-freeze \$\{verb\} refused: \$\{step\.why\}`\)/);
});

/** Every module under the journeys folder, in subfolders too. */
function journeyModules(dir = JOURNEYS) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? journeyModules(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [],
  );
}

/** Whether an import of Playwright's test module brings in `test` (by any name), a namespace or a default. */
export function bringsPlaywrightTest(source) {
  for (const m of source.matchAll(/import\s+([^;]*?)\s+from\s+['"]@playwright\/test['"]/g)) {
    const clause = m[1];
    if (/\*\s*as\s/.test(clause) || /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim())) return true;
    if (/\{[^}]*\btest\b[^}]*\}/.test(clause)) return true;
  }
  return false;
}

test('the import check catches every way to take Playwright test directly', () => {
  for (const bad of [
    "import { test, expect } from '@playwright/test';",
    'import { expect, test } from "@playwright/test";',
    "import { test as base } from '@playwright/test';",
    "import * as pw from '@playwright/test';",
    "import pw from '@playwright/test';",
    "import pw, { expect } from '@playwright/test';",
  ])
    assert.equal(bringsPlaywrightTest(bad), true, bad);
  for (const ok of ["import { expect } from '@playwright/test';", "import { test, expect } from './journey.mjs';"])
    assert.equal(bringsPlaywrightTest(ok), false, ok);
});

test('every journey module takes `test` from journey.mjs, so the guard wraps every step', () => {
  const files = journeyModules();
  assert.ok(files.filter((f) => f.endsWith('.pw.mjs')).length > 100, 'the journeys folder holds the journeys');
  const own = new Set([join(JOURNEYS, 'journey.mjs'), join(JOURNEYS, 'real-app.playwright.config.mjs')]);
  const direct = files.filter((f) => !own.has(f) && bringsPlaywrightTest(readFileSync(f, 'utf8'))).map((f) => f.slice(JOURNEYS.length + 1));
  assert.deepEqual(
    direct,
    [],
    "these take test from '@playwright/test' directly, which skips the posting-freeze guard; import { test, expect } from './journey.mjs' instead",
  );
  assert.match(readFileSync(join(JOURNEYS, 'journey.mjs'), 'utf8'), /postingFreezeGuard: \[[\s\S]*auto: true/);
});
