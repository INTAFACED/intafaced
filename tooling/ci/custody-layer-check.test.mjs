import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { customerRecipeCalls, judgeCustodyLayer, runCustodyLayerCheck, switchDefaultProblems } from './custody-layer-check.mjs';

const CUSTOMER = ['deposit', 'feeCharge', 'rewardPay'];
const ROOT = process.cwd();

test('finds a recipe posted through recipes., an alias, a named import and a dynamic call; ignores platform recipes', () => {
  assert.deepEqual(customerRecipeCalls(`import { recipes } from '@intafaced/ledger-client';\nledger.post(recipes.deposit(x));`, CUSTOMER), [
    'deposit',
  ]);
  assert.deepEqual(customerRecipeCalls(`import { recipes as R } from '@intafaced/ledger-client';\nR.feeCharge(x);`, CUSTOMER), [
    'feeCharge',
  ]);
  assert.deepEqual(customerRecipeCalls(`import { rewardPay as pay, type Amount } from '@intafaced/ledger-client';\npay(x);`, CUSTOMER), [
    'rewardPay',
  ]);
  assert.deepEqual(customerRecipeCalls(`import * as lc from '@intafaced/ledger-client';\nlc.recipes.deposit(x);`, CUSTOMER), ['deposit']);
  assert.deepEqual(customerRecipeCalls(`import { recipes } from '@intafaced/ledger-client';\nrecipes[name](x);`, CUSTOMER), ['*']);
  assert.deepEqual(
    customerRecipeCalls(`import { recipes } from '@intafaced/ledger-client';\nrecipes.sweepFeesToRewards(x);`, CUSTOMER),
    [],
  );
});

test('a new site or a new recipe at a listed site is a violation; a vanished row is only a notice', () => {
  const { violations, stale } = judgeCustodyLayer(
    { 'services/a.ts': ['deposit'], 'services/b.ts': ['deposit', 'feeCharge'] },
    { 'services/b.ts': ['deposit'], 'services/gone.ts': ['rewardPay'] },
  );
  assert.deepEqual(violations, [
    { file: 'services/a.ts', recipes: ['deposit'] },
    { file: 'services/b.ts', recipes: ['feeCharge'] },
  ]);
  assert.deepEqual(stale, [{ file: 'services/gone.ts', recipes: ['rewardPay'] }]);
});

test('the repo as it stands passes: the switch is off by default and every site is in the inventory', () => {
  assert.deepEqual(switchDefaultProblems(ROOT), []);
  assert.deepEqual(runCustodyLayerCheck(ROOT).violations, []);
});

/** A copy of just the files check 4 reads, so a plant never touches the working tree. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'custody-layer-'));
  for (const p of [
    'tooling/ci/custody-layer-inventory.json',
    'packages/ledger-client/src/custody-layer.ts',
    'services/svc-ledger/src/env.ts',
    'services/svc-ledger/src/service.ts',
  ]) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    cpSync(join(ROOT, p), join(dir, p));
  }
  return dir;
}

test('planted: a customer-balance posting in a service outside the inventory fails, with the custody switch off', () => {
  const dir = sandbox();
  try {
    assert.deepEqual(runCustodyLayerCheck(dir).violations, []);
    mkdirSync(join(dir, 'services/svc-agents/src'), { recursive: true });
    writeFileSync(
      join(dir, 'services/svc-agents/src/planted.ts'),
      `import { recipes } from '@intafaced/ledger-client';\nexport const p = (l, u) => l.post(recipes.deposit({ userId: u }));\n`,
    );
    const v = runCustodyLayerCheck(dir).violations;
    assert.equal(v.length, 1);
    assert.equal(v[0].check, 'customer-balance-posting');
    assert.equal(v[0].file, 'services/svc-agents/src/planted.ts');
    // The same plant in a test file is not a posting site.
    rmSync(join(dir, 'services/svc-agents/src/planted.ts'));
    writeFileSync(
      join(dir, 'services/svc-agents/src/planted.test.ts'),
      `import { recipes } from '@intafaced/ledger-client';\nrecipes.deposit({});\n`,
    );
    assert.deepEqual(runCustodyLayerCheck(dir).violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planted: turning the default on, or removing the runtime refusal, fails', () => {
  for (const [file, from, to] of [
    ['services/svc-ledger/src/service.ts', "options.custodyLayer ?? 'off'", "options.custodyLayer ?? 'on'"],
    ['services/svc-ledger/src/service.ts', "this.custodyLayer === 'off' && movesCustomerBalance(", 'false && movesCustomerBalance('],
    ['packages/ledger-client/src/custody-layer.ts', "raw.trim() === '') return 'off'", "raw.trim() === '') return 'on'"],
  ]) {
    const dir = sandbox();
    try {
      const p = join(dir, file);
      const text = readText(p);
      assert.ok(text.includes(from), `${file} no longer contains ${from}`);
      writeFileSync(p, text.replace(from, to));
      const v = runCustodyLayerCheck(dir).violations;
      assert.ok(
        v.some((x) => x.check === 'custody-switch-default' && x.file === file),
        `${file}: ${to} was not caught`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a missing inventory fails closed', () => {
  const dir = sandbox();
  try {
    rmSync(join(dir, 'tooling/ci/custody-layer-inventory.json'));
    assert.throws(() => runCustodyLayerCheck(dir), /custody-layer-inventory\.json is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readText(p) {
  return readFileSync(p, 'utf8');
}
