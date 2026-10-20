/**
 * D-instruments-03 backend acceptance: contract families, expiry schedule, pre-market params.
 * Real Postgres via TEST_DATABASE_URL. No Docker here. Every figure below is a TEST figure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { AuthError } from '@intafaced/auth';
import { TradeService } from '../controls/test-admission.js';
import { TradeError } from '../spot/types.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from '../spot/testing.js';
import { presentCcxtMarket, registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { MemoryApprovalBook, payloadHash } from './common.js';
import { TradeOpsAdmin } from './service.js';
import { tradeOpsAdminRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
/** Same host and role as TEST_DATABASE_URL; assertTestDatabase wants an admin database ending in `_test`. */
const url = (() => {
  const parsed = new URL(rawUrl);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const ALICE = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const FEE_PAYER = '55555555-5555-4555-8555-555555555555';
const operator = () => principalFor(OP, ['admin:read']);
const operatorWriter = () => principalFor(OP, ['admin:read', 'admin:write']);
const customer = () => principalFor(ALICE, ['trade:read']);

const REASON = 'list the september contract';
const EXPIRY = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();

interface ListingArgs {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  lotSize: string;
  minQty: string;
  maxQty: string | null;
  minNotional: string;
  makerBps: number;
  takerBps: number;
  expiryAt: string;
  status?: 'pending' | 'active';
  family?: 'linear' | 'inverse' | null;
  settleAsset?: string | null;
  displayName?: string | null;
}

const BTC_SEP: ListingArgs = {
  symbol: 'BTC/USDT-SEP26',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  tickSize: '0.1',
  lotSize: '0.001',
  minQty: '0.001',
  maxQty: null,
  minNotional: '5',
  makerBps: 2,
  takerBps: 5,
  expiryAt: EXPIRY,
  status: 'pending',
};

/** The exact body the approval is bound to; the service builds the same one. */
function listingBody(args: ListingArgs, reason: string) {
  return {
    actionType: 'trade.futures_listing_create',
    symbol: args.symbol,
    baseAsset: args.baseAsset,
    quoteAsset: args.quoteAsset,
    tickSize: formatAmount(amt(args.tickSize)),
    lotSize: formatAmount(amt(args.lotSize)),
    minQty: formatAmount(amt(args.minQty)),
    maxQty: args.maxQty === null ? null : formatAmount(amt(args.maxQty)),
    minNotional: formatAmount(amt(args.minNotional)),
    makerBps: args.makerBps,
    takerBps: args.takerBps,
    expiryAt: new Date(args.expiryAt).toISOString(),
    status: args.status ?? 'active',
    family: args.family ?? null,
    settleAsset: args.settleAsset?.trim() || null,
    displayName: args.displayName?.trim() || null,
    reason,
  };
}

describe('futures contract families, expiry schedule and pre-market', () => {
  let db: TestDatabase;
  let trade: TradeService;
  let usdcTrade: TradeService;
  let ledger: MemoryLedger;
  let book: MemoryApprovalBook;
  let admin: TradeOpsAdmin;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  function tradeService(extra: { futuresSettleAssets?: readonly string[] } = {}): TradeService {
    return new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      marketSlippageCapBps: 150,
      feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
      futuresSettlementFixing: 'TEST-FIXING-STAMP',
      ...extra,
    });
  }

  beforeEach(async () => {
    await db.sql`TRUNCATE
      trade.operator_audit,
      trade.operator_requests,
      trade.operator_premarket_params,
      trade.futures_expiry_schedule,
      trade.market_status_transitions,
      trade.fills,
      trade.orders,
      trade.positions,
      trade.markets
      RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    trade = tradeService();
    usdcTrade = tradeService({ futuresSettleAssets: ['USDC'] });
    book = new MemoryApprovalBook();
    admin = new TradeOpsAdmin({
      sql: db.sql,
      approvals: book,
      ledger,
      reconcileOrder: (orderId) => trade.reconcileOrder(orderId),
      cancelOrder: async (orderId, userId) => {
        await trade.cancelOrder(principalFor(userId), orderId);
      },
      listMarket: (input) => trade.listMarket(input),
    });
  });

  afterEach(async () => {
    await db.sql`DROP TRIGGER IF EXISTS test_boom ON trade.market_status_transitions`;
  });

  function allow(input: { approvalId: string; actionType: string; targetId: string; expectedVersion: string; body: unknown }): void {
    book.put({
      approvalId: input.approvalId,
      actionType: input.actionType,
      targetService: 'svc-trade',
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: payloadHash(input.body),
      requesterId: OP,
      approverId: APPROVER,
    });
  }

  function allowListing(approvalId: string, args: ListingArgs, reason = REASON): void {
    allow({
      approvalId,
      actionType: 'trade.futures_listing_create',
      targetId: args.symbol,
      expectedVersion: '0',
      body: listingBody(args, reason),
    });
  }

  async function createListing(approvalId: string, clientRequestId: string, args: ListingArgs = BTC_SEP) {
    allowListing(approvalId, args);
    return admin.futuresContracts.listingCreate(operatorWriter(), { ...args, reason: REASON, approvalId, clientRequestId });
  }

  async function setParams(
    marketId: string,
    values: { flatFundingRate: string | null; markClampBps: number | null },
    version: string,
    tag: string,
  ) {
    const reason = 'owner pre-market numbers';
    allow({
      approvalId: `appr-${tag}`,
      actionType: 'trade.premarket_params_set',
      targetId: marketId,
      expectedVersion: version,
      body: {
        actionType: 'trade.premarket_params_set',
        market: marketId,
        flatFundingRate: values.flatFundingRate === null ? null : formatAmount(amt(values.flatFundingRate)),
        markClampBps: values.markClampBps,
        expectedVersion: version,
        reason,
      },
    });
    return admin.futuresContracts.premarketSet(operatorWriter(), {
      market: marketId,
      ...values,
      expectedVersion: version,
      reason,
      approvalId: `appr-${tag}`,
      clientRequestId: `req-${tag}`,
    });
  }

  function allowConvert(approvalId: string, marketId: string, params: { version: string; rate: string; clamp: number }, reason: string) {
    allow({
      approvalId,
      actionType: 'trade.premarket_convert',
      targetId: marketId,
      expectedVersion: params.version,
      body: {
        actionType: 'trade.premarket_convert',
        market: marketId,
        paramsVersion: params.version,
        flatFundingRate: formatAmount(amt(params.rate)),
        markClampBps: params.clamp,
        reason,
      },
    });
  }

  /** Real-money futures go active only against a funded insurance pot, which is built the way production builds it. */
  async function fundInsurance(): Promise<void> {
    await ledger.post(recipes.deposit({ userId: FEE_PAYER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: randomUUID() }));
    await ledger.post(
      recipes.feeCharge({ chargeId: 'fee-ins-1', userId: FEE_PAYER, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('100') }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: 'ins-topup-1', assetId: 'USDT', amount: amt('100') }));
  }

  async function marketCount(): Promise<number> {
    const [row] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM trade.markets`;
    return Number(row?.n ?? '0');
  }

  describe('listing: family and settle asset', () => {
    it('refuses the inverse family with trade.inverse_family_unsupported and lists nothing', async () => {
      await expect(
        trade.listMarket({
          symbol: 'BTC/USDT-INV',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          tickSize: amt('0.1'),
          lotSize: amt('0.001'),
          minQty: amt('0.001'),
          minNotional: amt('5'),
          makerBps: 2,
          takerBps: 5,
          kind: 'futures',
          status: 'pending',
          futuresFamily: 'inverse',
        }),
      ).rejects.toMatchObject({ code: 'trade.inverse_family_unsupported' });
      expect(await marketCount()).toBe(0);

      const inverse = { ...BTC_SEP, symbol: 'BTC/USDT-INV-SEP26', family: 'inverse' as const };
      allowListing('appr-inverse', inverse);
      await expect(
        admin.futuresContracts.listingCreate(operatorWriter(), {
          ...inverse,
          reason: REASON,
          approvalId: 'appr-inverse',
          clientRequestId: 'req-inverse',
        }),
      ).rejects.toMatchObject({ code: 'trade.inverse_family_unsupported' });
      expect(await marketCount()).toBe(0);
    });

    it('stamps linear with the quote asset as settle asset, and never any other asset', async () => {
      const created = await createListing('appr-linear', 'req-linear');
      expect(created).toMatchObject({
        created: true,
        market: { symbol: 'BTC/USDT-SEP26', family: 'linear', settleAsset: 'USDT', status: 'pending' },
      });
      await expect(
        trade.listMarket({
          symbol: 'BTC/USDT-MISMATCH',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          tickSize: amt('0.1'),
          lotSize: amt('0.001'),
          minQty: amt('0.001'),
          minNotional: amt('5'),
          makerBps: 2,
          takerBps: 5,
          kind: 'futures',
          status: 'pending',
          futuresSettleAsset: 'USDC',
        }),
      ).rejects.toMatchObject({ code: 'trade.futures_settle_asset_mismatch' });
    });

    it('lists USDC linear only when a USDC settle asset is configured', async () => {
      const usdc = {
        symbol: 'ETH/USDC-PERP',
        baseAsset: 'ETH',
        quoteAsset: 'USDC',
        tickSize: amt('0.01'),
        lotSize: amt('0.01'),
        minQty: amt('0.01'),
        minNotional: amt('5'),
        makerBps: 2,
        takerBps: 5,
        kind: 'futures' as const,
        status: 'pending' as const,
      };
      await expect(trade.listMarket(usdc)).rejects.toMatchObject({ code: 'trade.futures_settle_asset_unconfigured' });
      await expect(trade.listMarket({ ...usdc, futuresSettleAsset: 'USDC' })).rejects.toMatchObject({
        code: 'trade.futures_settle_asset_unconfigured',
      });
      expect(await marketCount()).toBe(0);
      const listed = await usdcTrade.listMarket({ ...usdc, futuresSettleAsset: 'USDC' });
      expect(listed.futuresFamily).toBe('linear');
      expect(listed.futuresSettleAsset).toBe('USDC');
    });

    it('refuses family terms on a non-futures listing, in code and in the schema', async () => {
      const spot = {
        symbol: 'SOL/USDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.01'),
        minQty: amt('0.01'),
        minNotional: amt('5'),
        makerBps: 10,
        takerBps: 20,
      };
      await expect(trade.listMarket({ ...spot, futuresFamily: 'linear' })).rejects.toMatchObject({
        code: 'trade.futures_family_terms_incomplete',
      });
      await expect(trade.listMarket({ ...spot, futuresSettleAsset: 'USDT' })).rejects.toBeInstanceOf(TradeError);
      const listed = await trade.listMarket(spot);
      expect(listed.futuresFamily).toBeNull();
      expect(listed.futuresSettleAsset).toBeNull();
      await expect(
        db.sql`UPDATE trade.markets SET futures_family = 'linear', futures_settle_asset = 'USDT' WHERE id = ${listed.id}`,
      ).rejects.toMatchObject({ constraint_name: 'markets_futures_family_terms_ck' });
    });

    it('backfills existing futures rows as linear settled in their quote asset', async () => {
      // The 0078 backfill statement, run against a row shaped like one that predates the columns.
      await db.sql`INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional, status, maker_bps, taker_bps, listed_at, display_name
      ) VALUES (${randomUUID()}, 'OLD/USDT-PERP', 'OLD', 'USDT', 'futures', 1, 1, 1, 1, 'active', 2, 5, now(), 'Old perp')`;
      const migration = migrations.find((sql) => sql.includes('futures_family_terms_ck'));
      expect(migration).toBeDefined();
      await db.sql.unsafe(migration!);
      const [row] = await db.sql<Array<{ futures_family: string; futures_settle_asset: string }>>`
        SELECT futures_family, futures_settle_asset FROM trade.markets WHERE symbol = 'OLD/USDT-PERP'`;
      expect(row).toEqual({ futures_family: 'linear', futures_settle_asset: 'USDT' });
    });
  });

  describe('admin.futuresListing.create', () => {
    it('lists a dated pre-market future, and a second create returns the first and leaves positions alone', async () => {
      const first = await createListing('appr-1', 'req-1');
      expect(first.created).toBe(true);
      expect(first.market).toMatchObject({
        symbol: 'BTC/USDT-SEP26',
        futuresContractStyle: 'dated',
        futuresExpiryAt: new Date(EXPIRY).toISOString(),
        family: 'linear',
        settleAsset: 'USDT',
        status: 'pending',
        premarket: true,
      });
      const positionId = randomUUID();
      await db.sql`INSERT INTO trade.positions (
        id, user_id, market_id, side, status, size, entry_price, margin_initial, margin_current, margin_asset
      ) VALUES (${positionId}, ${ALICE}, ${first.market.id}, 'long', 'open', 3, 100, 30, 30, 'USDT')`;
      const before = await db.sql`SELECT * FROM trade.positions WHERE id = ${positionId}`;
      const [marketBefore] = await db.sql`
        SELECT status::text, futures_expiry_at, futures_settlement_fixing, futures_family, futures_settle_asset, maker_bps, taker_bps
          FROM trade.markets WHERE id = ${first.market.id}`;

      // A second operator asks for the same symbol, with other numbers, a new request id and no new approval.
      const second = await admin.futuresContracts.listingCreate(operatorWriter(), {
        ...BTC_SEP,
        makerBps: 9,
        status: 'active',
        reason: 'list it again',
        approvalId: 'appr-never-allowed',
        clientRequestId: 'req-2',
      });
      expect(second).toEqual({ created: false, market: first.market });
      expect(await marketCount()).toBe(1);
      const after = await db.sql`SELECT * FROM trade.positions WHERE id = ${positionId}`;
      expect(after).toEqual(before);
      const [marketAfter] = await db.sql`
        SELECT status::text, futures_expiry_at, futures_settlement_fixing, futures_family, futures_settle_asset, maker_bps, taker_bps
          FROM trade.markets WHERE id = ${first.market.id}`;
      expect(marketAfter).toEqual(marketBefore);

      // The same request id replays the stored result.
      const replay = await admin.futuresContracts.listingCreate(operatorWriter(), {
        ...BTC_SEP,
        reason: REASON,
        approvalId: 'appr-1',
        clientRequestId: 'req-1',
      });
      expect(replay).toEqual(first);
      const audit = await db.sql<Array<{ kind: string; approver_id: string }>>`
        SELECT kind, approver_id FROM trade.operator_audit WHERE kind = 'futures_listing.create'`;
      expect(audit).toEqual([{ kind: 'futures_listing.create', approver_id: APPROVER }]);
    });

    it('refuses a symbol that is already something other than a dated future', async () => {
      await trade.listMarket({
        symbol: 'BTC/USDT-SEP26',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.1'),
        lotSize: amt('0.001'),
        minQty: amt('0.001'),
        minNotional: amt('5'),
        makerBps: 2,
        takerBps: 5,
      });
      allowListing('appr-clash', BTC_SEP);
      await expect(
        admin.futuresContracts.listingCreate(operatorWriter(), {
          ...BTC_SEP,
          reason: REASON,
          approvalId: 'appr-clash',
          clientRequestId: 'req-clash',
        }),
      ).rejects.toMatchObject({ code: 'futures_listing_symbol_conflict' });
    });

    it('refuses a non-operator, a read-only operator, a missing approvalId and a blank fixing', async () => {
      const args = { ...BTC_SEP, reason: REASON, approvalId: 'appr-x', clientRequestId: 'req-x' };
      await expect(admin.futuresContracts.listingCreate(customer(), args)).rejects.toBeInstanceOf(AuthError);
      await expect(admin.futuresContracts.listingCreate(operator(), args)).rejects.toBeInstanceOf(AuthError);
      await expect(admin.futuresContracts.listingCreate(operatorWriter(), { ...args, approvalId: '  ' })).rejects.toMatchObject({
        code: 'approval_required',
      });
      await expect(admin.futuresContracts.listingCreate(operatorWriter(), args)).rejects.toMatchObject({ code: 'approval_missing' });
      expect(await marketCount()).toBe(0);

      // Blank fixing config refuses on the existing listing path; the approval is spent but nothing is listed.
      const noFixing = new TradeService(db.sql, ledger, new StubMatching(), new StubPerks(), new MemoryEventBus('svc-trade'), {
        marketLifecycle: READY_MARKET_LIFECYCLE,
      });
      const bare = new TradeOpsAdmin({
        sql: db.sql,
        approvals: book,
        ledger,
        reconcileOrder: (orderId) => noFixing.reconcileOrder(orderId),
        cancelOrder: async () => undefined,
        listMarket: (input) => noFixing.listMarket(input),
      });
      allowListing('appr-nofix', BTC_SEP);
      await expect(
        bare.futuresContracts.listingCreate(operatorWriter(), { ...args, approvalId: 'appr-nofix', clientRequestId: 'req-nofix' }),
      ).rejects.toMatchObject({ code: 'trade.dated_futures_fixing_unconfigured' });
      expect(await marketCount()).toBe(0);
    });

    it('refuses an approval bound to different terms', async () => {
      allowListing('appr-other', { ...BTC_SEP, makerBps: 9 });
      await expect(
        admin.futuresContracts.listingCreate(operatorWriter(), {
          ...BTC_SEP,
          reason: REASON,
          approvalId: 'appr-other',
          clientRequestId: 'req-other',
        }),
      ).rejects.toMatchObject({ code: 'approval_mismatch' });
      expect(await marketCount()).toBe(0);
    });

    it('refuses an expiry that has passed', async () => {
      await expect(
        admin.futuresContracts.listingCreate(operatorWriter(), {
          ...BTC_SEP,
          expiryAt: '2020-01-01T00:00:00.000Z',
          reason: REASON,
          approvalId: 'appr-old',
          clientRequestId: 'req-old',
        }),
      ).rejects.toMatchObject({ code: 'futures_expiry_in_past' });
    });
  });

  describe('admin.futuresSchedule', () => {
    const TENORS = [
      { tenor: 'monthly' as const, enabled: true },
      { tenor: 'weekly' as const, enabled: false },
    ];

    function allowSchedule(
      approvalId: string,
      tenors: readonly { tenor: 'weekly' | 'monthly' | 'quarterly'; enabled: boolean }[],
      version: string,
      reason: string,
    ) {
      allow({
        approvalId,
        actionType: 'trade.futures_schedule_set',
        targetId: 'futures_expiry_schedule',
        expectedVersion: version,
        body: {
          actionType: 'trade.futures_schedule_set',
          tenors: [...tenors].sort(
            (a, b) => ['weekly', 'monthly', 'quarterly'].indexOf(a.tenor) - ['weekly', 'monthly', 'quarterly'].indexOf(b.tenor),
          ),
          expectedVersion: version,
          reason,
        },
      });
    }

    it('answers no_schedule_published on a blank table and lists nothing', async () => {
      await expect(admin.futuresContracts.scheduleGet(operator())).resolves.toEqual({
        version: null,
        tenors: [],
        reason: 'no_schedule_published',
      });
      await expect(admin.futuresContracts.scheduleGet(customer())).rejects.toBeInstanceOf(AuthError);
      expect(await marketCount()).toBe(0);
    });

    it('versions each set, returns the latest, and still lists nothing', async () => {
      allowSchedule('appr-s1', TENORS, '0', 'first table');
      const v1 = await admin.futuresContracts.scheduleSet(operatorWriter(), {
        tenors: TENORS,
        expectedVersion: '0',
        reason: 'first table',
        approvalId: 'appr-s1',
        clientRequestId: 'req-s1',
      });
      expect(v1).toMatchObject({
        version: '1',
        reason: null,
        tenors: [
          { tenor: 'weekly', enabled: false },
          { tenor: 'monthly', enabled: true },
        ],
        operatorId: OP,
        approverId: APPROVER,
      });

      const next = [{ tenor: 'quarterly' as const, enabled: true }];
      allowSchedule('appr-s2', next, '1', 'second table');
      const v2 = await admin.futuresContracts.scheduleSet(operatorWriter(), {
        tenors: next,
        expectedVersion: '1',
        reason: 'second table',
        approvalId: 'appr-s2',
        clientRequestId: 'req-s2',
      });
      expect(v2).toMatchObject({ version: '2', tenors: [{ tenor: 'quarterly', enabled: true }] });
      await expect(admin.futuresContracts.scheduleGet(operator())).resolves.toMatchObject({ version: '2' });
      const rows = await db.sql<Array<{ version: string }>>`SELECT version::text FROM trade.futures_expiry_schedule ORDER BY version`;
      expect(rows.map((row) => row.version)).toEqual(['1', '2']);
      expect(await marketCount()).toBe(0);

      // A replayed request returns the stored answer and does not spend the approval again.
      await expect(
        admin.futuresContracts.scheduleSet(operatorWriter(), {
          tenors: next,
          expectedVersion: '1',
          reason: 'second table',
          approvalId: 'appr-s2',
          clientRequestId: 'req-s2',
        }),
      ).resolves.toMatchObject({ version: '2' });
      // The table is append-only.
      await expect(db.sql`UPDATE trade.futures_expiry_schedule SET reason = 'rewritten'`).rejects.toThrow(/append-only/);
    });

    it('refuses a stale version, a missing approval, a non-operator and a malformed table', async () => {
      allowSchedule('appr-stale', TENORS, '4', 'stale');
      await expect(
        admin.futuresContracts.scheduleSet(operatorWriter(), {
          tenors: TENORS,
          expectedVersion: '4',
          reason: 'stale',
          approvalId: 'appr-stale',
          clientRequestId: 'req-stale',
        }),
      ).rejects.toMatchObject({ code: 'futures_schedule_stale' });
      const base = { tenors: TENORS, expectedVersion: '0', reason: 'no approval', clientRequestId: 'req-na' };
      await expect(admin.futuresContracts.scheduleSet(operatorWriter(), { ...base, approvalId: '' })).rejects.toMatchObject({
        code: 'approval_required',
      });
      await expect(admin.futuresContracts.scheduleSet(operatorWriter(), { ...base, approvalId: 'ghost' })).rejects.toMatchObject({
        code: 'approval_missing',
      });
      await expect(admin.futuresContracts.scheduleSet(customer(), { ...base, approvalId: 'x' })).rejects.toBeInstanceOf(AuthError);
      await expect(admin.futuresContracts.scheduleSet(operator(), { ...base, approvalId: 'x' })).rejects.toBeInstanceOf(AuthError);
      await expect(
        admin.futuresContracts.scheduleSet(operatorWriter(), {
          ...base,
          tenors: [
            { tenor: 'weekly', enabled: true },
            { tenor: 'weekly', enabled: false },
          ],
          approvalId: 'x',
        }),
      ).rejects.toMatchObject({ code: 'futures_schedule_invalid' });
      await expect(admin.futuresContracts.scheduleGet(operator())).resolves.toMatchObject({ version: null });
    });
  });

  describe('pre-market params and conversion', () => {
    async function listPremarket(): Promise<string> {
      const listed = await createListing('appr-pm-list', 'req-pm-list');
      return listed.market.id;
    }

    async function marketRow(id: string) {
      const [row] = await db.sql<Array<{ status: string; updated_at: Date }>>`
        SELECT status::text AS status, updated_at FROM trade.markets WHERE id = ${id}`;
      return row!;
    }

    it('refuses conversion with blank params, leaves the market row unchanged and keeps the approval', async () => {
      const marketId = await listPremarket();
      await fundInsurance();
      const before = await marketRow(marketId);
      await expect(admin.futuresContracts.premarketGet(operator(), marketId)).resolves.toEqual({
        market: marketId,
        version: null,
        flatFundingRate: null,
        markClampBps: null,
        reason: 'trade.premarket_params_unset',
      });
      allowConvert('appr-conv-blank', marketId, { version: '0', rate: '0', clamp: 1 }, 'go live');
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-conv-blank',
          clientRequestId: 'req-conv-blank',
        }),
      ).rejects.toMatchObject({ code: 'trade.premarket_params_unset' });
      expect(await marketRow(marketId)).toEqual(before);
      const transitions = await db.sql`SELECT 1 FROM trade.market_status_transitions WHERE market_id = ${marketId}`;
      expect(transitions).toHaveLength(0);

      // One blank field is still blank.
      await setParams(marketId, { flatFundingRate: '0.0001', markClampBps: null }, '0', 'half');
      allowConvert('appr-conv-half', marketId, { version: '1', rate: '0.0001', clamp: 1 }, 'go live');
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-conv-half',
          clientRequestId: 'req-conv-half',
        }),
      ).rejects.toMatchObject({ code: 'trade.premarket_params_unset' });
      expect((await marketRow(marketId)).status).toBe('pending');
    });

    it('stores versioned owner params four-eyes and converts to active in one step', async () => {
      const marketId = await listPremarket();
      await fundInsurance();
      const set = await setParams(marketId, { flatFundingRate: '0.0001', markClampBps: 500 }, '0', 'p1');
      expect(set).toEqual({ market: marketId, version: '1', flatFundingRate: '0.0001', markClampBps: 500, reason: null });
      const stale = setParams(marketId, { flatFundingRate: '0.0002', markClampBps: 400 }, '0', 'p-stale');
      await expect(stale).rejects.toMatchObject({ code: 'premarket_params_stale' });
      const set2 = await setParams(marketId, { flatFundingRate: '-0.0002', markClampBps: 400 }, '1', 'p2');
      expect(set2).toMatchObject({ version: '2', flatFundingRate: '-0.0002', markClampBps: 400 });

      allowConvert('appr-conv', marketId, { version: '2', rate: '-0.0002', clamp: 400 }, 'go live');
      const converted = await admin.futuresContracts.premarketConvert(operatorWriter(), {
        market: marketId,
        reason: 'go live',
        approvalId: 'appr-conv',
        clientRequestId: 'req-conv',
      });
      expect(converted).toMatchObject({
        fromStatus: 'pending',
        toStatus: 'active',
        paramsVersion: '2',
        market: { id: marketId, status: 'active', premarket: false },
      });
      expect((await marketRow(marketId)).status).toBe('active');
      const transitions = await db.sql<Array<{ from_status: string; to_status: string; approver_id: string }>>`
        SELECT from_status, to_status, approver_id FROM trade.market_status_transitions WHERE market_id = ${marketId}`;
      expect(transitions).toEqual([{ from_status: 'pending', to_status: 'active', approver_id: APPROVER }]);
      const audit = await db.sql<Array<{ kind: string }>>`
        SELECT kind FROM trade.operator_audit WHERE kind LIKE 'futures_premarket.%' ORDER BY occurred_at, kind`;
      expect(audit.map((row) => row.kind).sort()).toEqual(['futures_premarket.convert', 'futures_premarket.set', 'futures_premarket.set']);

      // Replay answers the same; a fresh request on an active market refuses; params can no longer be set.
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-conv',
          clientRequestId: 'req-conv',
        }),
      ).resolves.toEqual(converted);
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-again',
          clientRequestId: 'req-again',
        }),
      ).rejects.toMatchObject({ code: 'premarket_not_pending' });
      await expect(setParams(marketId, { flatFundingRate: '0', markClampBps: 1 }, '2', 'p3')).rejects.toMatchObject({
        code: 'premarket_not_pending',
      });
    });

    it('leaves the old state when the transaction fails part way', async () => {
      const marketId = await listPremarket();
      await fundInsurance();
      await setParams(marketId, { flatFundingRate: '0.0001', markClampBps: 500 }, '0', 'p1');
      await db.sql.unsafe(
        `CREATE OR REPLACE FUNCTION trade.test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END; $$`,
      );
      await db.sql.unsafe(
        `CREATE TRIGGER test_boom BEFORE INSERT ON trade.market_status_transitions FOR EACH ROW EXECUTE FUNCTION trade.test_boom()`,
      );
      const before = await marketRow(marketId);
      allowConvert('appr-crash', marketId, { version: '1', rate: '0.0001', clamp: 500 }, 'go live');
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-crash',
          clientRequestId: 'req-crash',
        }),
      ).rejects.toThrow();
      expect(await marketRow(marketId)).toEqual(before);
      const stored = await db.sql`SELECT 1 FROM trade.operator_requests WHERE client_request_id = 'req-crash'`;
      expect(stored).toHaveLength(0);

      await db.sql`DROP TRIGGER test_boom ON trade.market_status_transitions`;
      allowConvert('appr-retry', marketId, { version: '1', rate: '0.0001', clamp: 500 }, 'go live');
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-retry',
          clientRequestId: 'req-crash',
        }),
      ).resolves.toMatchObject({ toStatus: 'active' });
    });

    it('refuses conversion to active against an empty insurance fund and leaves the row alone', async () => {
      const marketId = await listPremarket();
      await setParams(marketId, { flatFundingRate: '0.0001', markClampBps: 500 }, '0', 'p1');
      allowConvert('appr-noins', marketId, { version: '1', rate: '0.0001', clamp: 500 }, 'go live');
      await expect(
        admin.futuresContracts.premarketConvert(operatorWriter(), {
          market: marketId,
          reason: 'go live',
          approvalId: 'appr-noins',
          clientRequestId: 'req-noins',
        }),
      ).rejects.toMatchObject({ code: 'trade.insurance_fund_empty' });
      expect((await marketRow(marketId)).status).toBe('pending');
    });

    it('refuses a non-operator, a missing approvalId and a market that is not pre-market', async () => {
      const marketId = await listPremarket();
      const base = { market: marketId, reason: 'go live', approvalId: 'x', clientRequestId: 'req-na' };
      await expect(admin.futuresContracts.premarketConvert(customer(), base)).rejects.toBeInstanceOf(AuthError);
      await expect(admin.futuresContracts.premarketConvert(operator(), base)).rejects.toBeInstanceOf(AuthError);
      await expect(admin.futuresContracts.premarketConvert(operatorWriter(), { ...base, approvalId: '' })).rejects.toMatchObject({
        code: 'approval_required',
      });
      await expect(
        admin.futuresContracts.premarketSet(customer(), {
          market: marketId,
          flatFundingRate: '0',
          markClampBps: 1,
          expectedVersion: '0',
          reason: 'owner numbers',
          approvalId: 'x',
          clientRequestId: 'req-na2',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      await expect(
        admin.futuresContracts.premarketSet(operatorWriter(), {
          market: marketId,
          flatFundingRate: '0',
          markClampBps: 1,
          expectedVersion: '0',
          reason: 'owner numbers',
          approvalId: '',
          clientRequestId: 'req-na3',
        }),
      ).rejects.toMatchObject({ code: 'approval_required' });

      const spot = await trade.listMarket({
        symbol: 'SOL/USDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.01'),
        minQty: amt('0.01'),
        minNotional: amt('5'),
        makerBps: 10,
        takerBps: 20,
        status: 'pending',
      });
      await expect(admin.futuresContracts.premarketConvert(operatorWriter(), { ...base, market: spot.id })).rejects.toMatchObject({
        code: 'premarket_not_pending',
      });
      await expect(admin.futuresContracts.premarketConvert(operatorWriter(), { ...base, market: randomUUID() })).rejects.toMatchObject({
        code: 'market_not_found',
      });
    });

    it('refuses malformed owner numbers', async () => {
      const marketId = await listPremarket();
      const base = { market: marketId, expectedVersion: '0', reason: 'owner numbers', approvalId: 'x', clientRequestId: 'req-bad' };
      await expect(
        admin.futuresContracts.premarketSet(operatorWriter(), { ...base, flatFundingRate: '1e-4', markClampBps: 5 }),
      ).rejects.toMatchObject({ code: 'premarket_param_invalid' });
      await expect(
        admin.futuresContracts.premarketSet(operatorWriter(), { ...base, flatFundingRate: '0.0001', markClampBps: 0 }),
      ).rejects.toMatchObject({ code: 'premarket_param_invalid' });
      await expect(
        admin.futuresContracts.premarketSet(operatorWriter(), { ...base, flatFundingRate: '0.0001', markClampBps: 2.5 }),
      ).rejects.toMatchObject({ code: 'premarket_param_invalid' });
    });
  });

  describe('public market read', () => {
    it('shows family, settle asset, contract size and the pre-market label', async () => {
      const listed = await createListing('appr-pub', 'req-pub');
      await trade.listMarket({
        symbol: 'BTC/USDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
      const perp = await trade.listMarket({
        symbol: 'BTC/USDT-PERP',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.1'),
        lotSize: amt('0.001'),
        minQty: amt('0.001'),
        minNotional: amt('5'),
        makerBps: 2,
        takerBps: 5,
        kind: 'futures',
        status: 'pending',
      });
      // A contract multiplier is only ever a stored owner figure; this one is a TEST figure.
      await db.sql`UPDATE trade.markets SET contract_size = 0.01 WHERE id = ${perp.id}`;

      const app = Fastify();
      registerPublicRest(app, {
        markets: (limit: number) => trade.markets(limit),
        marketBySymbol: (symbol: string) => trade.marketBySymbol(symbol),
        depth: async () => ({ bids: [], asks: [], sequence: 1 }),
        publicTape: async () => [],
        candles: async () => [],
      } as unknown as PublicRestDeps);
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/v1/markets?limit=50' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<Record<string, unknown>>;
      const bySymbol = new Map(body.map((row) => [row.symbol as string, row]));

      expect(bySymbol.get('BTC/USDT-PERP')).toMatchObject({
        family: 'linear',
        settleAsset: 'USDT',
        settle: 'USDT',
        linear: true,
        inverse: false,
        contractSize: '0.01',
        premarket: true,
        active: false,
      });
      expect(bySymbol.get('BTC/USDT-SEP26')).toMatchObject({
        id: listed.market.id,
        family: 'linear',
        settleAsset: 'USDT',
        contractSize: null,
        premarket: true,
        type: 'future',
      });
      // Spot carries no contract terms and is never Pre-market.
      expect(bySymbol.get('BTC/USDT')).toMatchObject({ family: null, settleAsset: null, settle: null, linear: null, premarket: false });
      await app.close();

      const single = await trade.marketBySymbol('BTC/USDT-PERP');
      expect(presentCcxtMarket(single!, Date.now()).contractSize).toBe('0.01');
    });

    it('serves the same terms on the tRPC market read', async () => {
      await createListing('appr-trpc', 'req-trpc');
      const [market] = await trade.markets(10);
      expect(market?.futuresFamily).toBe('linear');
      expect(market?.futuresSettleAsset).toBe('USDT');
      const caller = tradeOpsAdminRouter(admin).createCaller({
        principal: operator(),
        region: 'XX',
        service: null,
        requestId: randomUUID(),
      });
      await expect(caller.futuresSchedule.get()).resolves.toEqual({
        version: null,
        tenors: [],
        reason: 'no_schedule_published',
      });
      await expect(
        caller.futuresPremarket.convert({ market: market!.id, reason: 'go live', approvalId: 'x', clientRequestId: 'r1' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const writer = tradeOpsAdminRouter(admin).createCaller({
        principal: operatorWriter(),
        region: 'XX',
        service: null,
        requestId: randomUUID(),
      });
      await expect(
        writer.futuresPremarket.convert({ market: market!.id, reason: 'go live', approvalId: '', clientRequestId: 'r2' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
