import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  formatAmount,
  parseAmount as amt,
  houseFees,
  railBoundary,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type PostRequest,
  type WithdrawInput,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './ledger/postgres-ledger.js';
import { handleS2sPost } from './s2s-http.js';
import type { LedgerService } from './service.js';
import { WITHDRAW_FEE_UNBOUND_CODE } from './withdraw-fee-binding.js';

/**
 * J-wallet-05 #6 (issue #6517): the ledger door settles or reverses a withdrawal only with the fee its posted hold carried,
 * whole, and only svc-pay posts a fee. Real Postgres ledger, through the S2S post handler.
 *
 * A person deposits 100 USDT on `crypto-native` and sends 25 out with a quoted 1.5 network fee on top.
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
      .withDatabase('intafaced_withdraw_fee_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => container.stop().then(() => undefined) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: withdrawal fees are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const USER = '66666666-6666-4666-8666-666666666666';
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

describe('a withdrawal fee bound to its posted hold (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  let door: LedgerService;
  const pay = { kind: 'bound', service: 'svc-pay' } as const;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_withdraw_fee', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
    door = {
      post: (req: PostRequest) => engine.post(req),
      getTxByKey: (key: string) => engine.getTxByKey(key),
      balance: (ref: Parameters<PostgresLedger['balance']>[0]) => engine.balance(ref),
    } as unknown as LedgerService;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (ref: Parameters<PostgresLedger['balance']>[0]) => formatAmount((await engine.balance(ref)).amount);
  const unbound = expect.objectContaining({ code: WITHDRAW_FEE_UNBOUND_CODE });
  const post = (p: PostRequest, caller: Parameters<typeof handleS2sPost>[2] = pay) => handleS2sPost(door, toWire(p), caller);

  async function funded(withdrawalId: string): Promise<WithdrawInput> {
    await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: RAIL, railRef: `in-${withdrawalId}` }));
    return { userId: USER, assetId: 'USDT', amount: amt('25'), fee: amt('1.5'), rail: RAIL, withdrawalId };
  }

  it('settles a fee-carrying hold whole: 25 to the rail, 1.5 to houseFees(pay), and the hold empties', async () => {
    const w = await funded('f1:0');
    const fees = amt(await bal(houseFees('pay', 'USDT')));
    await post(recipes.withdrawHold(w));
    await post(recipes.withdrawSettle(w));
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f1:0'))).toBe('0');
    expect(amt(await bal(houseFees('pay', 'USDT'))) - fees).toBe(amt('1.5'));
  });

  it('refuses a settle or reverse without the fee its hold carried, or with another fee, and posts nothing', async () => {
    const w = await funded('f2:0');
    await post(recipes.withdrawHold(w));
    for (const wrong of [{ fee: undefined }, { fee: amt('1') }]) {
      await expect(post(recipes.withdrawSettle({ ...w, ...wrong }))).rejects.toEqual(unbound);
      await expect(post(recipes.withdrawReverse({ ...w, ...wrong }))).rejects.toEqual(unbound);
    }
    expect(await engine.getTxByKey('withdraw.settle:f2:0')).toBeNull();
    expect(await engine.getTxByKey('withdraw.reverse:f2:0')).toBeNull();
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f2:0'))).toBe('26.5');
    // The right fee reverses it whole: everything goes back.
    await post(recipes.withdrawReverse(w));
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f2:0'))).toBe('0');
  });

  it('refuses a fee on a settle whose hold carried none, and a part settle of a fee-carrying hold', async () => {
    const w = await funded('f3:0');
    await post(recipes.withdrawHold({ ...w, fee: undefined }));
    await expect(post(recipes.withdrawSettle({ ...w, amount: amt('23.5') }))).rejects.toEqual(unbound);
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f3:0'))).toBe('25');

    const v = await funded('f4:0');
    await post(recipes.withdrawHold(v));
    await expect(post(recipes.withdrawSettle({ ...v, amount: amt('20') }))).rejects.toEqual(unbound);
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f4:0'))).toBe('26.5');
  });

  it('refuses a fee leg that is not the fee the post names', async () => {
    const w = await funded('f5:0');
    await post(recipes.withdrawHold(w));
    const settle = toWire(recipes.withdrawSettle(w));
    const skewed = {
      ...settle,
      entries: settle.entries.map((e) =>
        e.account.ownerType === 'house' ? { ...e, amount: '2' } : e.account.ownerType === 'treasury' ? { ...e, amount: '24.5' } : e,
      ),
    };
    await expect(handleS2sPost(door, skewed, pay)).rejects.toEqual(unbound);
    expect(await engine.getTxByKey('withdraw.settle:f5:0')).toBeNull();
  });

  it("a fee is svc-pay's alone: another verified service is refused a fee-carrying hold", async () => {
    const w = await funded('f6:0');
    await expect(post(recipes.withdrawHold(w), { kind: 'bound', service: 'svc-bank' })).rejects.toEqual(unbound);
    expect(await engine.getTxByKey('withdraw.hold:f6:0')).toBeNull();
  });

  it('refuses a fee-carrying post whose key or hold is another withdrawal than the one it names', async () => {
    const named = await funded('f8:0');
    const other = await funded('f9:0');
    await post(recipes.withdrawHold(named));
    await post(recipes.withdrawHold(other));
    // Names f8 (and its fee) but draws f9's hold.
    const settle = toWire(recipes.withdrawSettle(named));
    const otherHold = withdrawalHoldAccount(USER, 'USDT', 'f9:0');
    const drawsOther = { ...settle, entries: settle.entries.map((e) => (e.account.kind === 'hold' ? { ...e, account: otherHold } : e)) };
    await expect(handleS2sPost(door, drawsOther, pay)).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, { ...settle, idempotencyKey: 'withdraw.settle:f9:0' }, pay)).rejects.toEqual(unbound);
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f8:0'))).toBe('26.5');
    expect(await bal(otherHold)).toBe('26.5');
  });

  it('refuses a post whose meta names another withdrawal than its key and hold, fee or no fee', async () => {
    const x = await funded('f10:0');
    await post(recipes.withdrawHold(x));
    // A fee-less settle of x pointing its meta at another withdrawal would skip x's fee and strand it in the hold.
    const settle = toWire(recipes.withdrawSettle({ ...x, fee: undefined }));
    await expect(handleS2sPost(door, { ...settle, meta: { ...settle.meta, withdrawalId: 'f11:0' } }, pay)).rejects.toEqual(unbound);
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f10:0'))).toBe('26.5');
  });

  it('a fee-carrying reverse goes back to the hold owner only, and a settle only on the hold rail', async () => {
    const x = await funded('f12:0');
    await post(recipes.withdrawHold(x));
    const reverse = toWire(recipes.withdrawReverse(x));
    const toOther = {
      ...reverse,
      entries: reverse.entries.map((e) =>
        e.account.kind === 'available' ? { ...e, account: userAvailable('77777777-7777-4777-8777-777777777777', 'USDT') } : e,
      ),
    };
    await expect(handleS2sPost(door, toOther, pay)).rejects.toEqual(unbound);
    await expect(post(recipes.withdrawSettle({ ...x, rail: 'bank-sepa' }))).rejects.toEqual(unbound);
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f12:0'))).toBe('26.5');
  });

  it('refuses a hold retried with another fee than the posted one, either way, and replays the same hold', async () => {
    const x = await funded('f13:0');
    await post(recipes.withdrawHold({ ...x, amount: amt('26.5'), fee: undefined }));
    await expect(post(recipes.withdrawHold(x))).rejects.toEqual(unbound);
    const y = await funded('f14:0');
    await post(recipes.withdrawHold(y));
    await expect(post(recipes.withdrawHold({ ...y, amount: amt('26.5'), fee: undefined }))).rejects.toEqual(unbound);
    // The same hold again is a plain replay.
    await post(recipes.withdrawHold(y));
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f14:0'))).toBe('26.5');
    expect((await engine.getTxByKey('withdraw.hold:f13:0'))?.meta).not.toHaveProperty('fee');
  });

  it('leaves a fee-less withdrawal exactly as before, part settle and reverse included', async () => {
    const w = await funded('f7:0');
    const plain = { ...w, fee: undefined, amount: amt('10') };
    await post(recipes.withdrawHold(plain), { kind: 'bound', service: 'svc-bank' });
    await post(recipes.withdrawSettle({ ...plain, amount: amt('6') }), { kind: 'bound', service: 'svc-bank' });
    await post(recipes.withdrawReverse({ ...plain, amount: amt('4') }), { kind: 'bound', service: 'svc-bank' });
    expect(await bal(withdrawalHoldAccount(USER, 'USDT', 'f7:0'))).toBe('0');
  });
});
