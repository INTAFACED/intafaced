/**
 * Unit tests for local-test-seed. Fixtures only: no Docker, no database, no stack.
 * Run: node --test tooling/scripts/local-test-seed.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FUNDS_LABEL,
  GuardError,
  LOAN_RESERVE_AMOUNT,
  LOAN_RESERVE_FUNDING_ID,
  MAX_AGE_DAYS,
  MAX_POOL_FUNDING,
  NAME_PREFIX,
  NAME_SUFFIX,
  P2P_COUNTRY,
  P2P_LABEL,
  P2P_METHOD_ID,
  TEST_EARN,
  TEST_HOUSE_INVENTORY,
  TEST_LOAN_POLICY,
  TEST_LOANS,
  TEST_P2P_FIELDS,
  applyAll,
  applyEarn,
  applyHomeContent,
  applyHouse,
  applyLoans,
  applyP2p,
  ageLoan,
  earnFundingId,
  earnPoolName,
  fundEarnPool,
  guardSeed,
  houseSeedId,
  main,
  parseArgs,
  statusReport,
  toWire,
  unseedAll,
} from './local-test-seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const scriptPath = path.join(here, 'local-test-seed.mjs');
const SCALE = 10n ** 18n;
const PROD_URL = 'postgres://prod:secret@db.prod.example.com:5432/intafaced';

function parseAmount(input) {
  if (typeof input === 'bigint') return input;
  if (typeof input !== 'string' || !/^\d+(\.\d+)?$/.test(input)) throw new Error(`bad amount ${input}`);
  const [whole, frac = ''] = input.split('.');
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(18, '0').slice(0, 18));
}

function formatAmount(value) {
  const abs = value < 0n ? -value : value;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  const text = frac ? `${whole}.${frac}` : `${whole}`;
  return value < 0n ? `-${text}` : text;
}

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'local-test-seed-'));
}

function marker(over = {}) {
  return {
    kind: 'intafaced-local-test-stack',
    ports: { postgres: 15460, ledger: 14501, ...(over.ports ?? {}) },
    database: {
      host: '127.0.0.1',
      port: 15460,
      name: 'intafaced_local_test',
      ...(over.database ?? {}),
    },
  };
}

function writeState(dir, mark, secrets) {
  writeFileSync(path.join(dir, 'LOCAL-TEST-STACK.json'), JSON.stringify(mark));
  writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ pgService: 'fixture-secret', databaseUrl: PROD_URL, ...(secrets ?? {}) }));
}

function spyIo() {
  const io = {
    writes: 0,
    connects: 0,
    existsSync: (file) => statExists(file),
    readFileSync: (file, enc) => readFileSync(file, enc),
    writeFileSync() {
      io.writes += 1;
      throw new Error('write');
    },
    connect() {
      io.connects += 1;
      throw new Error('connect');
    },
  };
  return io;
}

function statExists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

function listing(dir) {
  if (!statExists(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const st = statSync(path.join(dir, name));
      return `${name}:${st.size}`;
    });
}

function envProxy(base) {
  let hostileReads = 0;
  const env = new Proxy(base, {
    get(target, prop) {
      if (prop === 'DATABASE_URL' || prop === 'LEDGER_URL') {
        hostileReads += 1;
        return PROD_URL;
      }
      return target[prop];
    },
  });
  return {
    env,
    get hostileReads() {
      return hostileReads;
    },
  };
}

async function refused(dir, env) {
  const io = spyIo();
  const before = listing(dir);
  const errors = [];
  let loaded = 0;
  let thrown;
  try {
    guardSeed(env, dir, io);
  } catch (err) {
    thrown = err;
  }
  const code = await main(['apply', '--state', dir], env, {
    io,
    log: (line) => errors.push(line),
    load() {
      loaded += 1;
      throw new Error('connected');
    },
  });
  assert.equal(io.writes, 0);
  assert.equal(io.connects, 0);
  assert.equal(loaded, 0);
  assert.deepEqual(listing(dir), before);
  assert.equal(code, 2);
  assert.ok(thrown instanceof GuardError);
  return { thrown, errors };
}

function railBoundary(assetId) {
  return { ownerType: 'treasury', ownerId: 'rail:local-test', assetId, kind: 'available' };
}

function marketMaker(assetId) {
  return { ownerType: 'house', ownerId: 'market-maker', assetId, kind: 'available' };
}

function userAvailable(userId, assetId) {
  return { ownerType: 'user', ownerId: userId, assetId, kind: 'available' };
}

function accountKey(account) {
  return [account.ownerType, account.ownerId, account.assetId, account.kind, account.purpose ?? ''].join('\0');
}

function recipesFixture() {
  return {
    deposit({ userId, assetId, amount, rail, railRef }) {
      return {
        idempotencyKey: `deposit:${rail}:${railRef}`,
        module: 'ledger',
        reason: 'deposit.credited',
        meta: { rail, railRef },
        entries: [
          { account: { ownerType: 'treasury', ownerId: `rail:${rail}`, assetId, kind: 'available' }, direction: 'credit', amount },
          { account: userAvailable(userId, assetId), direction: 'debit', amount },
        ],
      };
    },
    earnPoolFund({ poolId, fundingId, assetId, amount, from }) {
      return {
        idempotencyKey: `bank.earn.fund:${poolId}:${fundingId}`,
        module: 'bank',
        reason: 'bank.earn.pool.funded',
        meta: { poolId, fundingId },
        entries: [
          {
            account: from ?? { ownerType: 'house', ownerId: 'fees:bank', assetId, kind: 'available' },
            direction: 'credit',
            amount,
          },
          { account: { ownerType: 'module', ownerId: `bank:earn:${poolId}`, assetId, kind: 'available' }, direction: 'debit', amount },
        ],
      };
    },
    loanReserveFund({ fundingId, debtAssetId, amount, from }) {
      return {
        idempotencyKey: `bank.loan.reserve.fund:${debtAssetId}:${fundingId}`,
        module: 'bank',
        reason: 'loan.reserve.funded',
        meta: { fundingId },
        entries: [
          {
            account: from ?? { ownerType: 'house', ownerId: 'fees:bank', assetId: debtAssetId, kind: 'available' },
            direction: 'credit',
            amount,
          },
          {
            account: { ownerType: 'module', ownerId: 'bank:loan-reserve', assetId: debtAssetId, kind: 'available' },
            direction: 'debit',
            amount,
          },
        ],
      };
    },
    marketMakerSeedFund({ assetId, amount, seedId, rail }) {
      return {
        idempotencyKey: `mm.seed.fund:${seedId}:${assetId}`,
        module: 'trade',
        reason: 'mm.seed.funded',
        meta: { seedId, rail },
        entries: [
          { account: railBoundary(assetId), direction: 'credit', amount },
          { account: marketMaker(assetId), direction: 'debit', amount },
        ],
      };
    },
  };
}

/** Stand-in for EarnService.createPool / listPools, including the native-asset refusal. */
function earnService() {
  const pools = [];
  return {
    pools,
    async listPools(_asset, limit) {
      if (typeof limit !== 'number') {
        const err = new Error('limit unset');
        err.code = 'bank.earn_pools_list_limit_unset';
        throw err;
      }
      const open = pools.filter((pool) => pool.status === 'open');
      if (open.length === 0) {
        const err = new Error('No earn rates are configured');
        err.code = 'bank.earn_rate_unset';
        throw err;
      }
      return open.map((pool) => ({ ...pool }));
    },
    async createPool(input) {
      if (input.assetId === 'IFC') {
        const err = new Error('IFC is staked through svc-token, not through bank earn pools');
        err.code = 'bank.native_asset_not_earnable';
        throw err;
      }
      const row = {
        id: `pool-${pools.length + 1}`,
        assetId: input.assetId,
        kind: input.kind,
        name: input.name,
        aprBps: input.aprBps,
        termDays: input.termDays ?? null,
        status: 'open',
      };
      pools.push(row);
      return { ...row };
    },
  };
}

/** Stand-in for LoanService.createProduct. Incoherent policy is refused here, not in the seed. */
function loanService() {
  const products = [];
  return {
    products,
    async listProducts(_asset, limit) {
      if (typeof limit !== 'number') {
        const err = new Error('limit unset');
        err.code = 'bank.loan_products_list_limit_unset';
        throw err;
      }
      return products.filter((product) => product.status === 'open').map((product) => ({ ...product }));
    },
    async createProduct(input) {
      const policy = input.policy;
      const ordered =
        input.maxLtvBps < policy.marginCallLtvBps &&
        policy.marginCallLtvBps < policy.liquidationLtvBps &&
        policy.liquidationLtvBps <= policy.insolvencyLtvBps &&
        policy.targetLtvBps < policy.marginCallLtvBps &&
        policy.maxTrancheBps > 0 &&
        policy.maxTrancheBps <= 10000 &&
        policy.graceSeconds >= 0;
      if (!ordered || input.debtAssetId === input.collateralAssetId) {
        const err = new Error('Incoherent policy');
        err.code = 'bank.policy_incoherent';
        throw err;
      }
      const row = { id: `product-${products.length + 1}`, name: input.name, status: 'open', ...input };
      products.push(row);
      return { ...row };
    },
  };
}

function instrumentService() {
  const rows = new Map();
  const keyOf = (methodId, country) => `${methodId}\0${country}`;
  return {
    rows,
    async registerMethodSchema(input) {
      const key = keyOf(input.methodId, input.country);
      const row = {
        methodId: input.methodId,
        country: input.country,
        label: input.label,
        fields: input.fields,
        enabled: input.enabled ?? true,
      };
      rows.set(key, row);
      return { ...row };
    },
    async setMethodSchemaEnabled(methodId, country, enabled, reason) {
      // As svc-p2p: switching a method off needs a retirement reason.
      if (!enabled && !reason) {
        const err = new Error('Retiring a payment method needs a reason');
        err.code = 'p2p.delist_reason_required';
        throw err;
      }
      const row = rows.get(keyOf(methodId, country));
      if (!row) {
        const err = new Error(`No schema for "${methodId}" in ${country}`);
        err.code = 'p2p.instrument_method_unknown';
        throw err;
      }
      row.enabled = enabled;
      return { ...row };
    },
    async enabledMethodKeys() {
      return new Set([...rows.values()].filter((row) => row.enabled).map((row) => row.methodId));
    },
    async findMethod(methodId, country) {
      const row = rows.get(keyOf(methodId, country));
      return row ? { ...row } : null;
    },
  };
}

function memoryLedger() {
  const seen = new Map();
  const balances = new Map();
  const attempts = [];
  return {
    attempts,
    balances,
    async post(wire) {
      const canonical = JSON.stringify(wire);
      const prev = seen.get(wire.idempotencyKey);
      if (prev) {
        if (prev.canonical !== canonical) {
          const err = new Error('idempotency conflict');
          err.code = 'ledger.idempotency_conflict';
          throw err;
        }
        attempts.push({ wire, noop: true });
        return { txId: prev.txId, noop: true };
      }
      const houseInventory = wire.entries.some((entry) => entry.account.ownerType === 'house' && entry.account.ownerId === 'market-maker');
      if (houseInventory) {
        for (const entry of wire.entries) {
          if (entry.account.ownerType === 'user') throw new Error('user account touched');
        }
      }
      const pending = new Map();
      for (const entry of wire.entries) {
        const key = accountKey(entry.account);
        const amount = parseAmount(entry.amount);
        const signed = entry.direction === 'debit' ? amount : -amount;
        const slot = pending.get(key) ?? { ownerType: entry.account.ownerType, next: balances.get(key) ?? 0n };
        slot.next += signed;
        pending.set(key, slot);
      }
      for (const slot of pending.values()) {
        if (slot.ownerType !== 'treasury' && slot.next < 0n) {
          const err = new Error('insufficient funds');
          err.code = 'ledger.insufficient_funds';
          throw err;
        }
      }
      for (const [key, slot] of pending) balances.set(key, slot.next);
      const txId = `tx-${seen.size + 1}`;
      seen.set(wire.idempotencyKey, { canonical, txId });
      attempts.push({ wire, noop: false });
      return { txId, noop: false };
    },
    async balance(query) {
      const value = balances.get(accountKey(query)) ?? 0n;
      return { amount: formatAmount(value) };
    },
  };
}

function world() {
  const earn = earnService();
  const loans = loanService();
  const instruments = instrumentService();
  const ledger = memoryLedger();
  const deps = {
    earn,
    loans,
    instruments,
    ledger,
    recipes: recipesFixture(),
    userAvailable,
    parseAmount,
    formatAmount,
    async readPools(names) {
      return earn.pools.filter((pool) => names.includes(pool.name)).map((pool) => ({ ...pool }));
    },
    async readPoolById(poolId) {
      const pool = earn.pools.find((row) => row.id === poolId);
      return pool ? { ...pool } : null;
    },
    async readProducts(names) {
      return loans.products.filter((product) => names.includes(product.name)).map((product) => ({ ...product }));
    },
    async closePools(names) {
      let n = 0;
      for (const pool of earn.pools) {
        if (names.includes(pool.name) && pool.status !== 'closed') {
          pool.status = 'closed';
          n += 1;
        }
      }
      return n;
    },
    async closeProducts(names) {
      let n = 0;
      for (const product of loans.products) {
        if (names.includes(product.name) && product.status !== 'closed') {
          product.status = 'closed';
          n += 1;
        }
      }
      return n;
    },
  };
  return { deps, earn, loans, instruments, ledger };
}

test('guard: LOCAL_TEST missing refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker());
    const { thrown, errors } = await refused(dir, {});
    assert.match(thrown.message, /LOCAL_TEST=1/);
    assert.match(errors.join('\n'), /refusing:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: LOCAL_TEST=true refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker());
    const { thrown } = await refused(dir, { LOCAL_TEST: 'true' });
    assert.match(thrown.message, /exactly "1"/);
    assert.match(thrown.message, /true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: missing marker refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    const { thrown } = await refused(dir, { LOCAL_TEST: '1' });
    assert.match(thrown.message, /marker/);
    assert.match(thrown.message, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: wrong marker kind refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker());
    const bad = marker();
    bad.kind = 'production-stack';
    writeFileSync(path.join(dir, 'LOCAL-TEST-STACK.json'), JSON.stringify(bad));
    const { thrown } = await refused(dir, { LOCAL_TEST: '1' });
    assert.match(thrown.message, /not a local test stack marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: non-loopback host refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker({ database: { host: 'db.prod.example.com', port: 15460, name: 'intafaced_local_test' } }));
    const { thrown } = await refused(dir, { LOCAL_TEST: '1' });
    assert.match(thrown.message, /not loopback/);
    assert.match(thrown.message, /db\.prod\.example\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: wrong postgres port refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker({ database: { host: '127.0.0.1', port: 5432, name: 'intafaced_local_test' } }));
    const { thrown } = await refused(dir, { LOCAL_TEST: '1' });
    assert.match(thrown.message, /5432/);
    assert.match(thrown.message, /15460/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: NODE_ENV=production refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker());
    const { thrown } = await refused(dir, { LOCAL_TEST: '1', NODE_ENV: 'production' });
    assert.match(thrown.message, /NODE_ENV is "production"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: APP_ENV=staging refuses, writes nothing, opens nothing', async () => {
  const dir = tmp();
  try {
    writeState(dir, marker());
    const { thrown } = await refused(dir, { LOCAL_TEST: '1', APP_ENV: 'staging' });
    assert.match(thrown.message, /APP_ENV/);
    assert.match(thrown.message, /staging/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: a production DATABASE_URL in the environment is ignored', () => {
  const dir = tmp();
  try {
    writeState(dir, marker());
    const io = spyIo();
    const before = listing(dir);
    const { env, hostileReads } = envProxy({ LOCAL_TEST: '1' });
    const plan = guardSeed(env, dir, io);
    assert.equal(hostileReads, 0);
    assert.equal(io.writes, 0);
    assert.equal(io.connects, 0);
    assert.deepEqual(listing(dir), before);
    for (const url of [plan.bankUrl, plan.p2pUrl]) {
      assert.equal(url.includes('prod.example.com'), false);
      assert.equal(url.includes('DATABASE_URL'), false);
      const parsed = new URL(url);
      assert.equal(parsed.hostname, '127.0.0.1');
      assert.equal(parsed.port, '15460');
    }
    assert.equal(new URL(plan.bankUrl).username, 'svc_bank');
    assert.equal(new URL(plan.p2pUrl).username, 'svc_p2p');
    assert.equal(plan.ledgerUrl, 'http://127.0.0.1:14501');
    assert.equal(plan.ledgerUrl.includes('prod.example.com'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: a fixture marker on loopback passes, including localhost', () => {
  const dir = tmp();
  const other = tmp();
  try {
    writeState(dir, marker());
    const io = spyIo();
    const plan = guardSeed({ LOCAL_TEST: '1' }, dir, io);
    assert.equal(io.writes, 0);
    assert.equal(io.connects, 0);
    assert.equal(new URL(plan.bankUrl).hostname, '127.0.0.1');
    assert.equal(new URL(plan.ledgerUrl).hostname, '127.0.0.1');
    writeState(other, marker({ database: { host: 'localhost', port: 15460, name: 'intafaced_local_test' } }));
    const local = guardSeed({ LOCAL_TEST: '1', APP_ENV: 'dev', NODE_ENV: 'development' }, other, spyIo());
    assert.equal(new URL(local.bankUrl).hostname, 'localhost');
    assert.equal(guardSeed({ LOCAL_TEST: '1', APP_ENV: 'test' }, dir, spyIo()).ledgerUrl, 'http://127.0.0.1:14501');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('earn: first apply creates every pool, second creates none and posts nothing new', async () => {
  const { deps, earn, ledger } = world();
  const first = await applyEarn(deps);
  assert.equal(first.created, TEST_EARN.length);
  assert.equal(first.skipped, 0);
  assert.equal(earn.pools.length, TEST_EARN.length);
  for (const pool of earn.pools) {
    assert.ok(pool.name.startsWith(NAME_PREFIX));
    assert.ok(pool.name.endsWith(NAME_SUFFIX));
  }
  const listed = await earn.listPools(undefined, 200);
  assert.equal(listed.length, TEST_EARN.length);
  assert.deepEqual(listed.map((pool) => pool.name).sort(), TEST_EARN.map((row) => earnPoolName(row)).sort());
  assert.deepEqual(
    ledger.attempts.map((attempt) => attempt.wire.idempotencyKey),
    TEST_EARN.flatMap((row, index) => [
      `deposit:local-test:LOCAL-TEST-seed-funder-${row.slug}-v1`,
      `bank.earn.fund:pool-${index + 1}:${earnFundingId(row)}`,
    ]),
  );
  for (const row of TEST_EARN) {
    assert.equal(earnFundingId(row), `local-test-seed-${row.slug}`);
  }
  for (const attempt of ledger.attempts) {
    assert.equal(attempt.noop, false);
    assert.equal(attempt.wire.meta.label, FUNDS_LABEL);
  }
  const applied = ledger.attempts.length;
  const second = await applyEarn(deps);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, TEST_EARN.length);
  assert.equal(earn.pools.length, TEST_EARN.length);
  assert.equal(ledger.attempts.length, applied * 2);
  assert.ok(ledger.attempts.slice(applied).every((attempt) => attempt.noop));
  assert.deepEqual(
    ledger.attempts.slice(applied).map((attempt) => attempt.wire),
    ledger.attempts.slice(0, applied).map((attempt) => attempt.wire),
  );
});

test('earn: the service refuses an IFC pool', async () => {
  const { deps, earn, ledger } = world();
  await assert.rejects(
    () => applyEarn(deps, [{ slug: 'ifc-flexible', assetId: 'IFC', kind: 'flexible', aprBps: 100, termDays: null, reserve: '1' }]),
    (err) => err.code === 'bank.native_asset_not_earnable',
  );
  assert.equal(earn.pools.length, 0);
  assert.equal(ledger.attempts.length, 0);
});

test('earn: unseed closes pools and keeps the rows', async () => {
  const { deps, earn, ledger } = world();
  await applyEarn(deps);
  const ids = earn.pools.map((pool) => pool.id);
  ledger.post = async () => {
    throw new Error('unseed must not post');
  };
  const report = await unseedAll(deps);
  assert.equal(report.pools, TEST_EARN.length);
  assert.equal(earn.pools.length, ids.length);
  assert.deepEqual(
    earn.pools.map((pool) => pool.id),
    ids,
  );
  assert.ok(earn.pools.every((pool) => pool.status === 'closed'));
  await assert.rejects(
    () => earn.listPools(undefined, 200),
    (err) => err.code === 'bank.earn_rate_unset',
  );
});

test('loans: first apply creates both products, second creates none and posts nothing new', async () => {
  const { deps, loans, ledger } = world();
  const first = await applyLoans(deps);
  assert.equal(first.created, 2);
  assert.equal(first.skipped, 0);
  for (const product of loans.products) {
    assert.ok(product.name.startsWith(NAME_PREFIX));
    assert.ok(product.name.endsWith(NAME_SUFFIX));
    assert.equal(product.quoteAssetId, 'USDT');
    assert.deepEqual(product.policy, TEST_LOAN_POLICY);
  }
  assert.deepEqual(
    loans.products.map((product) => product.collateralAssetId),
    ['BTC', 'ETH'],
  );
  const reserve = ledger.attempts.at(-1);
  assert.equal(reserve.wire.idempotencyKey, `bank.loan.reserve.fund:USDT:${LOAN_RESERVE_FUNDING_ID}`);
  assert.equal(reserve.wire.meta.label, FUNDS_LABEL);
  const debit = reserve.wire.entries.find((entry) => entry.direction === 'debit');
  assert.equal(debit.account.ownerType, 'module');
  assert.equal(debit.account.ownerId, 'bank:loan-reserve');
  assert.equal(debit.amount, LOAN_RESERVE_AMOUNT);
  const applied = ledger.attempts.length;
  const second = await applyLoans(deps);
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 2);
  assert.equal(loans.products.length, 2);
  assert.ok(ledger.attempts.slice(applied).every((attempt) => attempt.noop));
  assert.equal(ledger.attempts.at(-1).wire.idempotencyKey, reserve.wire.idempotencyKey);
});

test('loans: the service refuses an incoherent policy', async () => {
  const { deps, loans, ledger } = world();
  await assert.rejects(
    () => applyLoans(deps, [{ ...TEST_LOANS[0], maxLtvBps: 7500 }]),
    (err) => err.code === 'bank.policy_incoherent',
  );
  assert.equal(loans.products.length, 0);
  assert.equal(ledger.attempts.length, 0);
});

test('loans: unseed closes products and keeps the rows', async () => {
  const { deps, loans } = world();
  await applyLoans(deps);
  const ids = loans.products.map((product) => product.id);
  const report = await unseedAll(deps);
  assert.equal(report.products, 2);
  assert.equal(loans.products.length, 2);
  assert.deepEqual(
    loans.products.map((product) => product.id),
    ids,
  );
  assert.ok(loans.products.every((product) => product.status === 'closed'));
  assert.deepEqual(await loans.listProducts(undefined, 200), []);
});

test('house: exact amounts, deterministic ids, second apply is a ledger no-op, house account only', async () => {
  const { deps, ledger } = world();
  const calls = [];
  const real = deps.recipes.marketMakerSeedFund;
  deps.recipes.marketMakerSeedFund = (input) => {
    calls.push(input);
    return real(input);
  };
  await applyHouse(deps);
  assert.equal(calls.length, TEST_HOUSE_INVENTORY.length);
  for (const row of TEST_HOUSE_INVENTORY) {
    const call = calls.find((input) => input.assetId === row.assetId);
    assert.equal(call.seedId, `LOCAL-TEST-seed-house-${row.assetId}-v1`);
    assert.equal(houseSeedId(row.assetId), call.seedId);
    assert.equal(call.rail, 'local-test');
    assert.equal(call.amount, parseAmount(row.amount));
    assert.equal(typeof call.amount, 'bigint');
    const wire = ledger.attempts.find((attempt) => attempt.wire.idempotencyKey === `mm.seed.fund:${call.seedId}:${row.assetId}`).wire;
    assert.equal(wire.meta.label, FUNDS_LABEL);
    assert.equal(wire.entries.find((entry) => entry.direction === 'debit').amount, row.amount);
    assert.deepEqual(
      wire.entries.map((entry) => entry.account),
      [railBoundary(row.assetId), marketMaker(row.assetId)],
    );
    assert.ok(wire.entries.every((entry) => entry.account.ownerType !== 'user'));
    assert.equal(formatAmount(ledger.balances.get(accountKey(marketMaker(row.assetId)))), row.amount);
  }
  const firstWires = ledger.attempts.map((attempt) => attempt.wire);
  await applyHouse(deps);
  const second = ledger.attempts.slice(firstWires.length);
  assert.equal(second.length, firstWires.length);
  assert.ok(second.every((attempt) => attempt.noop));
  assert.deepEqual(
    second.map((attempt) => attempt.wire),
    firstWires,
  );
  for (const row of TEST_HOUSE_INVENTORY) {
    assert.equal(formatAmount(ledger.balances.get(accountKey(marketMaker(row.assetId)))), row.amount);
  }
});

test('house inventory stocks both sides of the stack default markets', () => {
  const marketSrc = readFileSync(path.join(here, 'local-test-market.mjs'), 'utf8');
  const found = marketSrc.match(/const DEFAULT_SYMBOLS = (\[[^\]]+\])/);
  assert.ok(found, 'DEFAULT_SYMBOLS missing');
  const symbols = JSON.parse(found[1].replaceAll("'", '"'));
  const stocked = new Set(TEST_HOUSE_INVENTORY.map((row) => row.assetId));
  for (const symbol of symbols) {
    // A perpetual names its settle asset after a colon (`BTC/USDT:USDT`); every asset it names is stocked.
    const [base, rest] = symbol.split('/');
    for (const asset of [base, ...rest.split(':')]) assert.ok(stocked.has(asset), asset);
  }
  const quoteSrc = readFileSync(path.join(repo, 'services/svc-trade/src/convert/quote.ts'), 'utf8');
  assert.match(quoteSrc, /baseAsset/);
  assert.match(quoteSrc, /quoteAsset/);
  assert.match(quoteSrc, /kind: 'book'/);
});

test('p2p: apply twice leaves one row; unseed disables it; enabledMethodKeys follows', async () => {
  const { deps, instruments } = world();
  await applyP2p(deps);
  await applyP2p(deps);
  assert.equal(instruments.rows.size, 1);
  const row = [...instruments.rows.values()][0];
  assert.equal(row.methodId, P2P_METHOD_ID);
  assert.equal(row.country, P2P_COUNTRY);
  assert.equal(row.label, P2P_LABEL);
  assert.equal(row.enabled, true);
  assert.equal(row.fields.length, 2);
  assert.deepEqual(
    row.fields.map((field) => field.key),
    TEST_P2P_FIELDS.map((field) => field.key),
  );
  assert.ok((await instruments.enabledMethodKeys()).has(P2P_METHOD_ID));
  const report = await unseedAll(deps);
  assert.equal(report.method, 'disabled');
  assert.equal(instruments.rows.size, 1);
  assert.equal([...instruments.rows.values()][0].enabled, false);
  assert.equal((await instruments.enabledMethodKeys()).has(P2P_METHOD_ID), false);
});

test('status on an empty fixture says nothing seeded', async () => {
  const { deps } = world();
  const lines = await statusReport(deps, new Date('2026-10-17T00:00:00.000Z'));
  const text = lines.join('\n');
  assert.match(text, /nothing seeded/);
  assert.match(text, /as of 2026-10-17T00:00:00.000Z/);
  assert.match(text, new RegExp(FUNDS_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(text, /BTC|ETH|USDT|USDC|IFC|local_test_bank|created/);
});

test('status after apply names the TEST rows and the house balances it read back', async () => {
  const { deps } = world();
  await applyAll(deps);
  const text = (await statusReport(deps, new Date('2026-10-17T00:00:00.000Z'))).join('\n');
  assert.doesNotMatch(text, /nothing seeded/);
  for (const row of TEST_EARN) assert.match(text, new RegExp(earnPoolName(row).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const row of TEST_LOANS) assert.match(text, new RegExp(row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, new RegExp(P2P_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /BTC {2}100/);
  assert.match(text, /USDT {2}5000000/);
});

test('apply never asks for the founder pair, so it makes no Home content and leaves the notice board alone', async () => {
  const { deps } = world();
  let asked = 0;
  deps.home = async () => {
    asked += 1;
    return null;
  };
  const report = await applyAll(deps);
  assert.equal(asked, 0);
  assert.doesNotMatch(report.lines.join('\n'), /home/);
});

test('home without an enrolled founder pair fails by name and makes nothing', async () => {
  const { deps } = world();
  deps.home = async () => null;
  await assert.rejects(applyHomeContent(deps), {
    message: 'home: no enrolled founder pair on this stack, so Home cannot be seeded (run local-founder-seed.mjs enrol)',
  });
});

test('home takes a notice window in whole minutes, for home only, up to the 30-day default', () => {
  assert.deepEqual(parseArgs(['home', '--notice-minutes', '6', '--state', '/x']), {
    command: 'home',
    operands: [],
    noticeMinutes: 6,
    stateDir: '/x',
  });
  assert.equal(parseArgs(['home', '--notice-minutes', String(30 * 24 * 60)]).noticeMinutes, 30 * 24 * 60);
  for (const bad of ['0', '-1', '1.5', '6m', String(30 * 24 * 60 + 1)]) {
    assert.throws(() => parseArgs(['home', '--notice-minutes', bad]), {
      name: 'GuardError',
      message: /--notice-minutes needs a whole number/,
    });
  }
  assert.throws(() => parseArgs(['home', '--notice-minutes']), /--notice-minutes needs a whole number/);
  assert.throws(() => parseArgs(['apply', '--notice-minutes', '6']), /--notice-minutes is for home only/);
});

test('money tables are decimal strings and the seed does not touch service trees', () => {
  for (const row of TEST_HOUSE_INVENTORY) assert.equal(typeof row.amount, 'string');
  for (const row of TEST_EARN) assert.equal(typeof row.reserve, 'string');
  assert.equal(typeof LOAN_RESERVE_AMOUNT, 'string');
  const src = readFileSync(scriptPath, 'utf8');
  assert.match(src, /services\/svc-bank\/dist\/earn\/earn-service\.js/);
  assert.match(src, /services\/svc-bank\/dist\/loans\/loan-service\.js/);
  assert.match(src, /services\/svc-p2p\/dist\/instrument-service\.js/);
  assert.match(src, /createPool\(/);
  assert.match(src, /createProduct\(/);
  assert.match(src, /registerMethodSchema\(/);
  assert.match(src, /setMethodSchemaEnabled\(/);
  assert.match(src, /earnPoolFund\(/);
  assert.match(src, /loanReserveFund\(/);
  assert.match(src, /marketMakerSeedFund\(/);
  assert.match(src, /SET status = 'closed'/);
  assert.doesNotMatch(src, /DELETE FROM/);
  assert.doesNotMatch(src, /env\.DATABASE_URL/);
  assert.doesNotMatch(src, /env\.LEDGER_URL/);
  assert.doesNotMatch(src, /native_asset_not_earnable/);
  assert.doesNotMatch(src, /assertPolicyCoherent/);
  const wire = toWire(
    {
      idempotencyKey: 'k',
      module: 'trade',
      reason: 'mm.seed.funded',
      meta: { seedId: 's' },
      entries: [{ account: marketMaker('BTC'), direction: 'debit', amount: parseAmount('100') }],
    },
    formatAmount,
  );
  assert.equal(wire.meta.label, FUNDS_LABEL);
  assert.equal(wire.entries[0].amount, '100');

  const needles = ['local-test-seed', 'TEST_HOUSE_INVENTORY', 'local_test_bank', 'LOCAL-TEST-seed-house', 'TEST_EARN'];
  const skip = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo', 'vendor']);
  // What ships: docs may describe the seed and tests may name it as a caller or fixture; runtime code may not.
  // Playwright journeys (`*.pw.mjs`) are tests too: J-bank-11 calls `age-loan` as its starting state.
  const notShipped = (name) => /\.(test|spec|pw)\.[cm]?[jt]sx?$/.test(name) || name.endsWith('.md');
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size < 2_000_000 && !notShipped(name)) {
        let text;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        for (const needle of needles) {
          if (text.includes(needle)) hits.push(`${path.relative(repo, full)}: ${needle}`);
        }
      }
    }
  };
  for (const tree of ['services', 'apps', 'packages']) walk(path.join(repo, tree));
  assert.deepEqual(hits, []);
});

test('applyAll funds each reserve from a labelled TEST deposit and a second apply is a no-op', async () => {
  const { deps, ledger } = world();
  await applyAll(deps);
  const mod = await import('./local-test-seed.mjs');
  const funderId = mod.LOCAL_TEST_FUNDER_ID;
  assert.match(funderId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  TEST_EARN.forEach((row, index) => {
    const reserve = {
      ownerType: 'module',
      ownerId: `bank:earn:pool-${index + 1}`,
      assetId: row.assetId,
      kind: 'available',
    };
    assert.equal(formatAmount(ledger.balances.get(accountKey(reserve)) ?? 0n), row.reserve);
  });
  assert.equal(
    formatAmount(
      ledger.balances.get(accountKey({ ownerType: 'module', ownerId: 'bank:loan-reserve', assetId: 'USDT', kind: 'available' })) ?? 0n,
    ),
    LOAN_RESERVE_AMOUNT,
  );

  const assets = new Set([...TEST_EARN.map((row) => row.assetId), 'USDT', ...TEST_HOUSE_INVENTORY.map((row) => row.assetId)]);
  for (const assetId of assets) {
    assert.equal(ledger.balances.get(accountKey(userAvailable(funderId, assetId))) ?? 0n, 0n);
  }

  const deposited = new Map();
  for (const row of TEST_EARN) deposited.set(row.assetId, (deposited.get(row.assetId) ?? 0n) + parseAmount(row.reserve));
  deposited.set('USDT', (deposited.get('USDT') ?? 0n) + parseAmount(LOAN_RESERVE_AMOUNT));
  const house = new Map(TEST_HOUSE_INVENTORY.map((row) => [row.assetId, parseAmount(row.amount)]));
  for (const assetId of new Set([...deposited.keys(), ...house.keys()])) {
    const expected = -((deposited.get(assetId) ?? 0n) + (house.get(assetId) ?? 0n));
    assert.equal(ledger.balances.get(accountKey(railBoundary(assetId))) ?? 0n, expected);
  }

  for (const attempt of ledger.attempts) {
    for (const entry of attempt.wire.entries) {
      assert.equal(String(entry.account.ownerId).startsWith('fees:'), false);
    }
    assert.equal(attempt.wire.meta.label, FUNDS_LABEL);
  }

  const first = ledger.attempts.length;
  await applyAll(deps);
  const replay = ledger.attempts.slice(first);
  assert.equal(replay.length, first);
  assert.ok(replay.every((attempt) => attempt.noop));
});

test('resolvePostgres loads the postgres package svc-bank declares', async () => {
  const mod = await import('./local-test-seed.mjs');
  assert.equal(typeof mod.resolvePostgres, 'function');
  const fixture = tmp();
  const bare = tmp();
  try {
    const bank = path.join(fixture, 'services', 'svc-bank');
    const stubDir = path.join(bank, 'node_modules', 'postgres');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(path.join(bank, 'package.json'), JSON.stringify({ name: '@intafaced/svc-bank', dependencies: { postgres: '0.0.0' } }));
    writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: 'postgres', main: 'index.js' }));
    writeFileSync(
      path.join(stubDir, 'index.js'),
      'function localTestPostgresStub(){ return "local-test-postgres-stub"; }\nmodule.exports = localTestPostgresStub;\n',
    );
    const loaded = mod.resolvePostgres(fixture);
    assert.equal(typeof loaded, 'function');
    assert.equal(loaded(), 'local-test-postgres-stub');

    const bareBank = path.join(bare, 'services', 'svc-bank');
    mkdirSync(bareBank, { recursive: true });
    writeFileSync(path.join(bareBank, 'package.json'), JSON.stringify({ name: '@intafaced/svc-bank' }));
    assert.throws(
      () => mod.resolvePostgres(bare),
      (err) => {
        assert.match(err.message, /postgres/);
        assert.doesNotMatch(err.message, /packages are not built/);
        return true;
      },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test('age-loan: whole days from 1 to the cap on a loan id, and only the TEST products are offered as agable', async () => {
  const LOAN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const calls = [];
  const deps = {
    async ageLoanRows(loanId, days, products) {
      calls.push({ loanId, days, products });
      return { openedAt: '2026-10-09T10:00:00.000Z', drawnAt: '2026-10-09T10:00:01.000Z' };
    },
  };
  for (const bad of ['0', '-1', '1.5', String(MAX_AGE_DAYS + 1), 'x']) {
    await assert.rejects(ageLoan(deps, LOAN, bad), GuardError, `days ${bad}`);
  }
  await assert.rejects(ageLoan(deps, 'not-a-loan', '15'), GuardError);
  assert.equal(calls.length, 0);
  const report = await ageLoan(deps, LOAN, '15');
  assert.deepEqual(calls, [{ loanId: LOAN, days: 15, products: TEST_LOANS.map((row) => row.name) }]);
  assert.match(report.lines[0], /moved back 15 days/);
  assert.equal(report.lines[1], FUNDS_LABEL);
});

test('age-loan: a loan the database refuses to age is a guard refusal naming why', async () => {
  const deps = { ageLoanRows: async () => ({ refused: 'already has events after its opening' }) };
  await assert.rejects(ageLoan(deps, '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '3'), /already has events after its opening/);
});

test('fund-earn-pool: one TEST pool funded once per ref from a labelled TEST deposit; anything else refused', async () => {
  const { deps, earn, ledger } = world();
  const journey = { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'TEST J-bank-08 flexible local-1', status: 'open', assetId: 'USDT' };
  const real = { id: '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Instant access', status: 'open', assetId: 'USDT' };
  const closed = { id: '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'TEST closed', status: 'closed', assetId: 'USDT' };
  earn.pools.push(journey, real, closed);
  const report = await fundEarnPool(deps, journey.id, '25', 'jb08-local-1');
  assert.deepEqual(
    ledger.attempts.map((attempt) => attempt.wire.idempotencyKey),
    [
      `deposit:local-test:LOCAL-TEST-seed-funder-pool-${journey.id}-jb08-local-1-v1`,
      `bank.earn.fund:${journey.id}:local-test-jb08-local-1`,
    ],
  );
  for (const attempt of ledger.attempts) assert.equal(attempt.wire.meta.label, FUNDS_LABEL);
  assert.match(report.lines[0], /reserve funded 25 USDT/);
  // The same ref again is the same two keys: the ledger answers them and nothing moves twice.
  await fundEarnPool(deps, journey.id, '25', 'jb08-local-1');
  assert.ok(ledger.attempts.slice(2).every((attempt) => attempt.noop));
  const before = ledger.attempts.length;
  for (const [poolId, amount, ref, why] of [
    [real.id, '25', 'jb08-x', /not a TEST pool/],
    [closed.id, '25', 'jb08-x', /is closed/],
    ['3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '25', 'jb08-x', /not on this stack/],
    ['not-a-pool', '25', 'jb08-x', /pool id/],
    [journey.id, '0', 'jb08-x', /above 0/],
    [journey.id, formatAmount(parseAmount(MAX_POOL_FUNDING) + parseAmount('1')), 'jb08-x', /at most/],
    [journey.id, '-1', 'jb08-x', /exact decimal/],
    [journey.id, '25', 'x', /ref/],
  ]) {
    await assert.rejects(fundEarnPool(deps, poolId, amount, ref), why, `${poolId} ${amount} ${ref}`);
  }
  assert.equal(ledger.attempts.length, before);
});

test('age-loan takes exactly its two operands; every other command still takes none', () => {
  assert.deepEqual(parseArgs(['age-loan', 'id', '3', '--state', '/x']), { command: 'age-loan', operands: ['id', '3'], stateDir: '/x' });
  assert.throws(() => parseArgs(['age-loan', 'id']), GuardError);
  assert.throws(() => parseArgs(['age-loan', 'id', '3', 'extra']), /unknown argument "extra"/);
  assert.throws(() => parseArgs(['apply', 'extra']), /unknown argument "extra"/);
  assert.deepEqual(parseArgs(['fund-earn-pool', 'id', '25', 'ref1', '--state', '/x']), {
    command: 'fund-earn-pool',
    operands: ['id', '25', 'ref1'],
    stateDir: '/x',
  });
  assert.throws(() => parseArgs(['fund-earn-pool', 'id', '25']), /needs <poolId> <amount> <ref>/);
});
