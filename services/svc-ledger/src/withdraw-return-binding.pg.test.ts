import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  type PostRequest,
  type WithdrawInput,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './ledger/postgres-ledger.js';
import { handleS2sPost } from './s2s-http.js';
import type { LedgerService } from './service.js';
import { WITHDRAW_RETURN_UNBOUND_CODE } from './withdraw-return-binding.js';

/**
 * W-withdraw-07: the ledger door books a returned withdrawal only against the posted settle it returns. Real Postgres
 * ledger, through the S2S post handler. The rail boundary already holds other people's deposits in every test, so a
 * refusal is the binding's, never an empty account.
 *
 * A person deposits 100 USDT on `crypto-native` and sends 40 out; the rail settles it, then some or all of it comes back.
 *
 * H8a PG-hard: this file never skips. CI uses TEST_DATABASE_URL. Local without that env starts Testcontainers.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_withdraw_return_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => container.stop().then(() => undefined) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: returned withdrawals are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const USER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const RAIL = 'crypto-native';

type Wire = {
  idempotencyKey: string;
  module: string;
  reason: string;
  meta?: Record<string, unknown>;
  entries: { account: PostRequest['entries'][number]['account']; direction: string; amount: string }[];
};

const toWire = (post: PostRequest): Wire => ({
  idempotencyKey: post.idempotencyKey,
  module: post.module,
  reason: post.reason,
  ...(post.meta ? { meta: post.meta } : {}),
  entries: post.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
});

describe('returned withdrawal bound to its posted settle (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  let door: LedgerService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_withdraw_return', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
    door = {
      post: (req: PostRequest) => engine.post(req),
      getTxByKey: (key: string) => engine.getTxByKey(key),
      balance: (ref: Parameters<PostgresLedger['balance']>[0]) => engine.balance(ref),
    } as unknown as LedgerService;
    // Someone else's 1000 USDT already came in on the same rail.
    await engine.post(recipes.deposit({ userId: OTHER, assetId: 'USDT', amount: amt('1000'), rail: RAIL, railRef: 'other-in' }));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (ref: Parameters<PostgresLedger['balance']>[0]) => formatAmount((await engine.balance(ref)).amount);

  const withdrawal = (withdrawalId: string, over: Partial<WithdrawInput> = {}): WithdrawInput => ({
    userId: USER,
    assetId: 'USDT',
    amount: amt('40'),
    rail: RAIL,
    withdrawalId,
    ...over,
  });

  async function settled(w: WithdrawInput) {
    await engine.post(
      recipes.deposit({ userId: w.userId, assetId: w.assetId, amount: amt('100'), rail: RAIL, railRef: `in-${w.withdrawalId}` }),
    );
    await engine.post(recipes.withdrawHold(w));
    await engine.post(recipes.withdrawSettle(w));
  }

  const unbound = expect.objectContaining({ code: WITHDRAW_RETURN_UNBOUND_CODE });

  it('puts what the settle sent back in the person available balance once', async () => {
    const w = withdrawal('w1:0');
    await settled(w);
    const before = await bal(userAvailable(USER, 'USDT'));

    const first = await handleS2sPost(door, toWire(recipes.withdrawReturned(w)));
    const again = await handleS2sPost(door, toWire(recipes.withdrawReturned(w)));

    expect(again.txId).toBe(first.txId);
    expect(amt(await bal(userAvailable(USER, 'USDT'))) - amt(before)).toBe(amt('40'));
  });

  it('takes a part back, and refuses more than the settle sent', async () => {
    const w = withdrawal('w2:0');
    await settled(w);
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, amount: amt('40.000001') })))).rejects.toEqual(unbound);
    expect(await engine.getTxByKey('withdraw.returned:w2:0')).toBeNull();
    const before = await bal(userAvailable(USER, 'USDT'));
    await handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, amount: amt('15') })));
    expect(amt(await bal(userAvailable(USER, 'USDT'))) - amt(before)).toBe(amt('15'));
  });

  it('a settle with a fee leg takes back at most what went to the rail, never the fee', async () => {
    const w = withdrawal('w-fee:0', { amount: amt('25'), fee: amt('1.5') });
    await settled(w);
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, fee: undefined, amount: amt('26.5') })))).rejects.toEqual(
      unbound,
    );
    expect(await engine.getTxByKey('withdraw.returned:w-fee:0')).toBeNull();
    const before = await bal(userAvailable(USER, 'USDT'));
    await handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, fee: undefined, amount: amt('25') })));
    expect(amt(await bal(userAvailable(USER, 'USDT'))) - amt(before)).toBe(amt('25'));
  });

  it('refuses a return for a withdrawal that never settled: held, reversed or never made', async () => {
    const held = withdrawal('w3:0');
    await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: RAIL, railRef: 'in-w3' }));
    await engine.post(recipes.withdrawHold(held));
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned(held)))).rejects.toEqual(unbound);
    await engine.post(recipes.withdrawReverse(held));
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned(held)))).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned(withdrawal('w-none:0'))))).rejects.toEqual(unbound);
    expect(await engine.getTxByKey('withdraw.returned:w3:0')).toBeNull();
  });

  it('refuses a return to someone other than the person who sent it', async () => {
    const w = withdrawal('w4:0');
    await settled(w);
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, userId: OTHER })))).rejects.toEqual(unbound);
    expect(await bal(userAvailable(OTHER, 'USDT'))).toBe('1000');
  });

  it('refuses another asset or another rail than the settle', async () => {
    const w = withdrawal('w5:0');
    await settled(w);
    await engine.post(recipes.deposit({ userId: OTHER, assetId: 'USDC', amount: amt('100'), rail: RAIL, railRef: 'other-usdc' }));
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, assetId: 'USDC' })))).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, toWire(recipes.withdrawReturned({ ...w, rail: 'card-sandbox' })))).rejects.toEqual(unbound);
    // The meta names the settle's rail while the boundary leg is another rail's.
    const wire = toWire(recipes.withdrawReturned(w));
    const forged = {
      ...wire,
      entries: wire.entries.map((e) => (e.account.ownerType === 'treasury' ? { ...e, account: railBoundary('card-sandbox', 'USDT') } : e)),
    };
    await expect(handleS2sPost(door, forged)).rejects.toEqual(unbound);
  });

  it('refuses a key that names another withdrawal than its meta', async () => {
    const w = withdrawal('w6:0');
    await settled(w);
    const wire = toWire(recipes.withdrawReturned(w));
    await expect(handleS2sPost(door, { ...wire, idempotencyKey: 'withdraw.returned:w1:0' })).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, { ...wire, meta: { ...wire.meta, withdrawalId: 'w1:0' } })).rejects.toEqual(unbound);
  });
});
