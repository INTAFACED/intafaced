import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  formatAmount,
  houseFees,
  parseAmount as amt,
  recipes,
  userAvailable,
  type PostRequest,
  type TradeFillMakerRebateInput,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './ledger/postgres-ledger.js';
import { MAKER_REBATE_UNBOUND_CODE } from './maker-rebate-binding.js';
import { handleS2sPost } from './s2s-http.js';
import type { LedgerService } from './service.js';

/**
 * SP-fees-vip-01: the ledger door pays a maker rebate only against the posted fill it rebates. Real Postgres ledger,
 * through the S2S post handler. House trade fees already hold other fills' fees in every test, so a refusal is the
 * binding's, never an empty house account.
 *
 * Fill: a taker buys 1 BTC for 900 USDT from a resting maker, maker fee 0, taker fee 10 bps = 0.001 BTC, rebate 5 bps
 * = 0.0005 BTC from house trade fees to the maker.
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
      .withDatabase('intafaced_maker_rebate_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => container.stop().then(() => undefined) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: maker rebates are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const TAKER = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

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

describe('maker rebate bound to its posted fill (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  let door: LedgerService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_maker_rebate', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
    door = {
      post: (req: PostRequest) => engine.post(req),
      getTxByKey: (key: string) => engine.getTxByKey(key),
      balance: (ref: Parameters<PostgresLedger['balance']>[0]) => engine.balance(ref),
    } as unknown as LedgerService;
    // Other fills' fees already in house trade fees: 1 BTC.
    await engine.post(recipes.deposit({ userId: OTHER, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: 'pool-btc' }));
    await engine.post({
      idempotencyKey: 'test.pool:btc',
      module: 'trade',
      reason: 'test.pool',
      entries: [
        { account: userAvailable(OTHER, 'BTC'), direction: 'credit', amount: amt('1') },
        { account: houseFees('trade', 'BTC'), direction: 'debit', amount: amt('1') },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (ref: Parameters<PostgresLedger['balance']>[0]) => formatAmount((await engine.balance(ref)).amount);

  function fill(fillId: string, over: Partial<TradeFillMakerRebateInput> = {}): TradeFillMakerRebateInput {
    return {
      fillId,
      makerId: MAKER,
      takerId: TAKER,
      makerOrderId: `maker-${fillId}`,
      takerOrderId: `taker-${fillId}`,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: amt('1'),
      quoteAmount: amt('900'),
      takerSide: 'buy',
      makerFeeBps: 0,
      takerFeeBps: 10,
      makerRebateBps: 5,
      ...over,
    };
  }

  async function postFill(input: TradeFillMakerRebateInput) {
    await engine.post(recipes.deposit({ userId: TAKER, assetId: 'USDT', amount: amt('900'), rail: 'test', railRef: `t-${input.fillId}` }));
    await engine.post(recipes.deposit({ userId: MAKER, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: `m-${input.fillId}` }));
    await engine.post(recipes.orderHold({ orderId: input.takerOrderId, userId: TAKER, assetId: 'USDT', amount: amt('900') }));
    await engine.post(recipes.orderHold({ orderId: input.makerOrderId, userId: MAKER, assetId: 'BTC', amount: amt('1') }));
    await engine.post(recipes.tradeFill(input));
  }

  const unbound = expect.objectContaining({ code: MAKER_REBATE_UNBOUND_CODE });

  it('pays the posted fill maker once, and the house keeps the rest of that fill fee', async () => {
    const input = fill('f1');
    await postFill(input);
    const makerBefore = await bal(userAvailable(MAKER, 'BTC'));
    const houseBefore = await bal(houseFees('trade', 'BTC'));

    const first = await handleS2sPost(door, toWire(recipes.tradeFillMakerRebate(input)));
    const again = await handleS2sPost(door, toWire(recipes.tradeFillMakerRebate(input)));

    expect(again.txId).toBe(first.txId);
    expect(amt(await bal(userAvailable(MAKER, 'BTC'))) - amt(makerBefore)).toBe(amt('0.0005'));
    expect(amt(await bal(houseFees('trade', 'BTC'))) - amt(houseBefore)).toBe(-amt('0.0005'));
  });

  it('refuses a rebate for a fill that never posted, although house fees could pay it', async () => {
    await expect(handleS2sPost(door, toWire(recipes.tradeFillMakerRebate(fill('f-none'))))).rejects.toEqual(unbound);
    expect(await engine.getTxByKey('trade.fill.rebate:f-none')).toBeNull();
  });

  it('refuses a larger amount than the rate on what the maker paid', async () => {
    const input = fill('f2');
    await postFill(input);
    const wire = toWire(recipes.tradeFillMakerRebate(input));
    const forged = { ...wire, entries: wire.entries.map((e) => ({ ...e, amount: '0.0009' })) };
    await expect(handleS2sPost(door, forged)).rejects.toEqual(unbound);
    expect(await engine.getTxByKey('trade.fill.rebate:f2')).toBeNull();
  });

  it('refuses a rebate to someone other than the fill maker', async () => {
    const input = fill('f3');
    await postFill(input);
    const wire = toWire(recipes.tradeFillMakerRebate(input));
    const forged = {
      ...wire,
      entries: wire.entries.map((e) => (e.account.ownerType === 'user' ? { ...e, account: userAvailable(OTHER, 'BTC') } : e)),
    };
    await expect(handleS2sPost(door, forged)).rejects.toEqual(unbound);
  });

  it('refuses a rate that is not below the fill taker rate', async () => {
    const input = fill('f4');
    await postFill(input);
    const wire = toWire(recipes.tradeFillMakerRebate(input));
    const forged = {
      ...wire,
      meta: { ...wire.meta, makerRebateBps: 10 },
      entries: wire.entries.map((e) => ({ ...e, amount: '0.001' })),
    };
    await expect(handleS2sPost(door, forged)).rejects.toEqual(unbound);
  });

  it('refuses a rebate on a fill where the maker paid a fee', async () => {
    const input = fill('f5', { makerFeeBps: 2 });
    await postFill(input);
    const wire = toWire(recipes.tradeFillMakerRebate({ ...input, makerFeeBps: 0 }));
    await expect(handleS2sPost(door, wire)).rejects.toEqual(unbound);
  });

  it('refuses a key that names another fill, or another maker order', async () => {
    const input = fill('f6');
    await postFill(input);
    const wire = toWire(recipes.tradeFillMakerRebate(input));
    await expect(handleS2sPost(door, { ...wire, idempotencyKey: 'trade.fill.rebate:f1' })).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, { ...wire, meta: { ...wire.meta, makerOrderId: 'maker-f1' } })).rejects.toEqual(unbound);
  });

  it('a taker selling: the rebate is in the USDT the maker paid', async () => {
    const input = fill('f7', { takerSide: 'sell' });
    await engine.post(recipes.deposit({ userId: TAKER, assetId: 'BTC', amount: amt('1'), rail: 'test', railRef: 't-f7' }));
    await engine.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: amt('900'), rail: 'test', railRef: 'm-f7' }));
    await engine.post(recipes.orderHold({ orderId: input.takerOrderId, userId: TAKER, assetId: 'BTC', amount: amt('1') }));
    await engine.post(recipes.orderHold({ orderId: input.makerOrderId, userId: MAKER, assetId: 'USDT', amount: amt('900') }));
    await engine.post(recipes.tradeFill(input));
    const before = await bal(userAvailable(MAKER, 'USDT'));
    await handleS2sPost(door, toWire(recipes.tradeFillMakerRebate(input)));
    expect(amt(await bal(userAvailable(MAKER, 'USDT'))) - amt(before)).toBe(amt('0.45'));
  });
});
