/**
 * Standing-instruction convert (svc-bank auto-invest). PG-hard, never skipped.
 *
 * An unattended schedule has no session or API key, so the admission names the
 * `standing_instruction` authority instead of a credential. The convert settles
 * through the same quote, ledger recipes and idempotency as the interactive door.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TradeService, readyTestAdmission } from '../controls/test-admission.js';
import { TradingControlError, type TradingAdmissionPort } from '../controls/trading-controls.js';
import { PUBLISHED_TEST_FEE_SCHEDULE, READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from '../spot/testing.js';
import type { Market } from '../spot/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const INSTRUCTION = '99999999-9999-4999-8999-999999999999';
const SPREAD_BPS = 25;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_standing_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('standing-instruction convert (PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let admission: TradingAdmissionPort;
  let admitStanding: ReturnType<typeof vi.fn>;
  let admitInteractive: ReturnType<typeof vi.fn>;
  let market: Market;

  const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const fillPosts = () => ledger.journal().filter((tx) => tx.reason === 'trade.fill.mm_maker');

  function service(standingInstructionsEnabled: boolean | undefined) {
    return new TradeService(db.sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      convertEnabled: true,
      convertSpreadBps: SPREAD_BPS,
      convertQuoteTtlMs: 60_000,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      accountAdmission: admission,
      ...(standingInstructionsEnabled === undefined ? {} : { standingInstructionsEnabled }),
    });
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE trade.convert_quotes, trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    matching.asks = [['100', '5']];
    matching.bids = [['99', '5']];
    const base = readyTestAdmission();
    admitStanding = vi.fn(async (userId: string, _instruction: string, businessId: string, payload: unknown) =>
      base.admit(principalFor(userId), 'order.place', businessId, payload),
    );
    admitInteractive = vi.fn(base.admit.bind(base));
    admission = { ...base, admit: admitInteractive as TradingAdmissionPort['admit'], admitStanding: admitStanding as never };
    market = await service(true).listMarket({
      symbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      minNotional: amt('1'),
      makerBps: 10,
      takerBps: 20,
    });
    await ledger.post(
      recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `${ALICE}:${randomUUID()}` }),
    );
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'BTC', amount: amt('10'), seedId: `standing-btc-${randomUUID()}` }));
  });

  it('is off unless the operator turns it on: quote and execute refuse and touch nothing', async () => {
    const journalBefore = ledger.journal().length;
    for (const flag of [undefined, false]) {
      const trade = service(flag);
      await expect(
        trade.standingConvertQuote(ALICE, INSTRUCTION, { symbol: market.symbol, side: 'buy', qty: amt('1') }),
      ).rejects.toMatchObject({
        code: 'trade.standing_instruction_disabled',
      });
      await expect(trade.standingConvertExecute(ALICE, INSTRUCTION, { quoteId: 'q' })).rejects.toMatchObject({
        code: 'trade.standing_instruction_disabled',
      });
    }
    expect(admitStanding).not.toHaveBeenCalled();
    expect(ledger.journal()).toHaveLength(journalBefore);
  });

  it('quotes and settles for the named user under the standing authority, once, never as a credential', async () => {
    const trade = service(true);
    const quoted = await trade.standingConvertQuote(ALICE, INSTRUCTION, { symbol: market.symbol, side: 'buy', qty: amt('1') });
    const usdtBefore = amt(await avail(ALICE, 'USDT'));
    const settled = await trade.standingConvertExecute(ALICE, INSTRUCTION, { quoteId: quoted.quoteId });
    expect(settled.inAmount).toBe(quoted.inAmount);
    expect(settled.outAmount).toBe(quoted.outAmount);
    expect(admitStanding).toHaveBeenCalledTimes(1);
    expect(admitStanding).toHaveBeenCalledWith(ALICE, INSTRUCTION, `convert:${quoted.quoteId}`, expect.anything());
    expect(admitInteractive).not.toHaveBeenCalled();
    expect(fillPosts()).toHaveLength(1);
    expect(amt(await avail(ALICE, 'USDT'))).toBe(usdtBefore - amt(quoted.inAmount));
    expect(await avail(ALICE, 'BTC')).toBe(quoted.outAmount);
    expect(ledger.reconcile()).toEqual({ ok: true });

    const retry = await trade.standingConvertExecute(ALICE, INSTRUCTION, { quoteId: quoted.quoteId });
    expect(retry.fillId).toBe(settled.fillId);
    expect(fillPosts()).toHaveLength(1);
  });

  it("refuses another user's quote and posts nothing", async () => {
    const trade = service(true);
    const quoted = await trade.standingConvertQuote(ALICE, INSTRUCTION, { symbol: market.symbol, side: 'buy', qty: amt('1') });
    await expect(trade.standingConvertExecute(BOB, INSTRUCTION, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'trade.convert_not_owner',
    });
    expect(admitStanding).not.toHaveBeenCalled();
    expect(fillPosts()).toHaveLength(0);
  });

  it('identity refusal stops the convert before any ledger post, and a later retry can still settle', async () => {
    const trade = service(true);
    const quoted = await trade.standingConvertQuote(ALICE, INSTRUCTION, { symbol: market.symbol, side: 'buy', qty: amt('1') });
    admitStanding.mockRejectedValueOnce(new TradingControlError('auth.credential_denied'));
    await expect(trade.standingConvertExecute(ALICE, INSTRUCTION, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'auth.credential_denied',
    });
    expect(fillPosts()).toHaveLength(0);
    expect(await avail(ALICE, 'USDT')).toBe('1000');
    const settled = await trade.standingConvertExecute(ALICE, INSTRUCTION, { quoteId: quoted.quoteId });
    expect(settled.quoteId ?? quoted.quoteId).toBe(quoted.quoteId);
    expect(fillPosts()).toHaveLength(1);
  });

  it('fails closed when the admission port has no standing path', async () => {
    const { admitStanding: _drop, ...withoutStanding } = admission;
    admission = withoutStanding as TradingAdmissionPort;
    const trade = service(true);
    const quoted = await trade.standingConvertQuote(ALICE, INSTRUCTION, { symbol: market.symbol, side: 'buy', qty: amt('1') });
    await expect(trade.standingConvertExecute(ALICE, INSTRUCTION, { quoteId: quoted.quoteId })).rejects.toMatchObject({
      code: 'authority.unavailable',
    });
    expect(fillPosts()).toHaveLength(0);
  });
});
