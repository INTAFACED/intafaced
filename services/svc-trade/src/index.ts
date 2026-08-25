import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext } from '@intafaced/contracts';
import { JetStreamEventBus } from '@intafaced/events';
import { env } from './env.js';
import { TradeService } from './spot/trade-service.js';
import { createMatchingClient } from './spot/matching-close.js';
import { createRankPerksClient } from './spot/rank-perks.js';
import { createAffiliateAccrueClient } from './spot/affiliate-accrue.js';
import { createAffiliatePayoutClient } from './spot/affiliate-payout.js';
import { createSubAccountOwnershipClient } from './spot/sub-account-ownership.js';
import { createLedgerClient } from './ledger-client.js';
import { subscribeMatchingEvents } from './events.js';
import { createTradeRouter, type TradeRouter } from './router.js';
import { registerPublicRest } from './public-rest.js';
import { registerFuturesTickerRest } from './futures/futures-ticker-rest.js';
import { registerPrivateRest } from './private-rest.js';
import { attachExpireStash, bindExpireAt, installGtdGttPlace } from './spot/gtd-gtt-place.js';
import { attachReduceOnlyStash, bindReduceOnly, installReduceOnlyPlace } from './spot/reduce-only-place.js';
import { attachClosePosition, closeSpotPosition, installClosePosition } from './spot/close-position.js';
import { memoryOutcomeCatalogue, registerOutcomesRest } from './outcomes-rest.js';
import { registerPositionPreviewRest } from './futures/position-preview-rest.js';
import { registerSpotOrderPreviewRest } from './spot/order-preview-rest.js';
import { PositionService, FuturesError } from './futures/position-service.js';
import {
  ADL_DISCLOSURE_VERSION,
  assertAdlDisclosureAcked,
  presentAdlDisclosureWire,
  sqlAdlDisclosureStore,
  AdlDisclosureError,
} from './futures/adl-disclosure.js';
import { presentAdlActionDisclosureWire, sqlAdlDisclosureEventStore } from './futures/adl-last-resort.js';
import { optionalProfitSourceFromConfig } from './futures/profit-source.js';
import { parseConfiguredMaxLeverage } from './futures/initial-margin.js';
import { parseFundingMarketIds, startFuturesJobs } from './futures/futures-jobs.js';
import { presentMarginCallWire } from './futures/margin-call-transport.js';
import { createConfiguredVenueMarkSource, createVenueMarketDataAdapter, parseVenueMarkSymbols } from './futures/mark-from-venue.js';
import { presentVenueLatencyHealth } from './futures/venue-latency-health.js';
import { presentInsuranceListingPolicy } from './futures/insurance-listing-gate.js';
import { presentFuturesJobsHealth } from './futures/futures-jobs-health.js';
import { MaintainedBook } from '@intafaced/venue-adapter';
import { registerInternalFundingRate } from './futures/internal-funding-rate.js';
import { createCopyLeaderFixturesStore } from './agents/copy-leader-fixtures-store.js';
import { registerCopyLeaderFixturesRoutes } from './agents/copy-leader-fixtures-routes.js';
import { resolveFundingMaxAbsRateForBoot } from './futures/funding-rate-bound.js';
import { parseMmSeedTargets, startMmSeedJobs } from './mm/seed-jobs.js';
import { presentMmSeedHealth } from './mm/seed-health.js';
import { createMmMidSourceFromConfig } from './mm/mid-source.js';
import { HOUSE_MM_USER_UUID } from './spot/ids.js';
import { parseCandleMarketIds, parseCandleTimeframes } from './spot/candles.js';
import { startCandleJobs } from './spot/candle-jobs.js';
import { startEngineLedgerReconcileJobs } from './spot/engine-ledger-reconcile-jobs.js';
import { startAlgoJobs } from './algo/algo-jobs.js';
import { checkEngineSequences, describeRegressions } from './spot/sequence-guard.js';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { parseOtcDeskLawJson } from './otc/desk-law.js';
import { createOtcMidSourceFromConfig } from './otc/venue-mid-source.js';
import { describeOtcMidFeedWiring } from './otc/mid-feed.js';
import { OtcDeskService } from './otc/otc-service.js';
import { SqlOtcQuoteStore } from './otc/quote-store.js';
import { createOtcStakeSource } from './otc/stake-source.js';
import { canonicalizeCopyFillId } from './copy/fee-share.js';
import { parseCopyFeeShareLawJson, parseCopyJurisdictionLawJson } from './copy/fee-share-law.js';
import { CopyService } from './copy/copy-service.js';
import { SqlCopyFollowStore } from './copy/follow-store.js';
import { SqlMarketLifecycleAuthority, SqlMarketLifecycleEvidenceStore } from './market-lifecycle.js';
import { registerMarketLifecycleRoutes } from './market-lifecycle-routes.js';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-trade — the product layer over the matching engine (§5.2).
 *
 * Graph W1-R: mount tRPC; verify edge-signed principal (mount-boundary #48).
 */

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'trade,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});

await sql`SELECT 1 FROM trade.markets LIMIT 1`.catch(() => {
  throw new Error('trade schema is missing — run migrations before starting svc-trade');
});

// Value moves through svc-ledger, never through this service's own tables
// (Doctrine §0.6). This client is the only path.
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET);

// The book lives in svc-matching. This service never runs one of its own —
// §5.1 draws that line and a second book would be a second truth.
const matching = createMatchingClient(env.MATCHING_URL, env.INTERNAL_SERVICE_SECRET);
const perks = createRankPerksClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET);
const subAccounts = createSubAccountOwnershipClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET);
const affiliateAccrue = createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET);
const affiliatePayout = createAffiliatePayoutClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET);

// PX-S01 reads externally published authority/dossier evidence from SQL on
// every decision. Readiness is derived from this process's real kill switch and
// the matching service's explicit market membership; absent evidence remains a
// typed refusal and no process-local cache can become an authority replica.
const marketLifecycleStore = new SqlMarketLifecycleEvidenceStore(sql);
const marketLifecycle = new SqlMarketLifecycleAuthority(sql, matching, {
  spotEnabled: env.TRADE_SPOT_ENABLED,
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
});

const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  // Hosts `orderUpdated` (user-visible lifecycle for private streams).
  ownedStreams: ['trade'],
});

const trade = new TradeService(sql, ledger, matching, perks, bus, {
  marketLifecycle,
  spotEnabled: env.TRADE_SPOT_ENABLED,
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
  optionsSettlementAssetLaw: env.TRADE_OPTIONS_SETTLEMENT_ASSET_LAW,
  optionsSettlementFixing: env.TRADE_OPTIONS_SETTLEMENT_FIXING,
  marketSlippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
  convertEnabled: env.TRADE_CONVERT_ENABLED,
  convertSpreadBps: env.TRADE_CONVERT_SPREAD_BPS,
  algoEnabled: env.TRADE_ALGO_ENABLED,
  // SD-4: same kill as TRADE_MM_SEED_ENABLED — seeded placeOrder path stays OFF by default.
  seedPlaceEnabled: env.TRADE_MM_SEED_ENABLED,
  subAccounts,
  affiliateAccrue,
  affiliatePayout,
});

const subscriptions = await subscribeMatchingEvents(bus, trade);

// Venue fabric public mid (A-TRADE-VENUE-1). Empty venue = off. Shared with MM + OTC.
// Unknown venue id → null (refuse invent). Created before OTC so the desk can chain it.
const venuePublicAdapter = createVenueMarketDataAdapter(env.TRADE_VENUE_MARK_VENUE);

// Stream books start after Fastify (needs app.log). The map is filled then;
// lookups before run() returns null (unservable), never an invented mid.
const venueMarkSymbols = parseVenueMarkSymbols(env.TRADE_VENUE_MARK_SYMBOLS);
const otcVenueSymbols = parseVenueMarkSymbols(env.TRADE_OTC_VENUE_SYMBOLS);
const venueStreamSymbols = new Set([...venueMarkSymbols.values(), ...otcVenueSymbols.values()]);
const venueMaintainedBooks = new Map<string, MaintainedBook>();
const venueBookPort =
  env.TRADE_VENUE_MARK_STREAM && venuePublicAdapter && venueStreamSymbols.size > 0
    ? (symbol: string) => {
        const book = venueMaintainedBooks.get(symbol);
        if (!book) return null;
        return {
          get servable() {
            return book.servable;
          },
          top: () => book.top(),
          observedAt: () => book.tracker.observedAt,
        };
      }
    : undefined;

// trade.otc — D-S-02 / D26-P1-T2. Empty TRADE_OTC_DESK_LAW → refuse-closed (no invent).
// Empty TRADE_OTC_MIDS / unmapped venue pair → the desk can source no price and refuses.
// Boot-stamped mids carry asOf; venue observation refreshes asOf when opted in.
const otcDeskLaw = parseOtcDeskLawJson(env.TRADE_OTC_DESK_LAW);
const otcStakes = createOtcStakeSource(env.TOKEN_URL, env.INTERNAL_SERVICE_SECRET);
const otcMidBuilt = createOtcMidSourceFromConfig({
  midsEnv: env.TRADE_OTC_MIDS,
  midFromVenue: env.TRADE_OTC_MID_FROM_VENUE,
  venueAdapter: venuePublicAdapter,
  venueSymbols: env.TRADE_OTC_VENUE_SYMBOLS,
  ...(venueBookPort ? { bookForSymbol: venueBookPort } : {}),
});
const otcMidFeedWiring = describeOtcMidFeedWiring({
  midFromVenue: env.TRADE_OTC_MID_FROM_VENUE,
  venueAdapterInstalled: venuePublicAdapter != null,
  venueSymbolsConfigured: env.TRADE_OTC_VENUE_SYMBOLS.trim().length > 0,
  liveObservationFeed: otcMidBuilt.liveObservationFeed,
});
const otc = new OtcDeskService(ledger, otcStakes, {
  law: otcDeskLaw,
  midSource: otcMidBuilt.source,
  liveObservationFeed: otcMidBuilt.liveObservationFeed,
  midFeedWiring: otcMidFeedWiring,
  store: new SqlOtcQuoteStore(sql),
});

// trade.copy — D-S-03 Stage product mount. Empty TRADE_COPY_* laws → refuse-closed
// (never invent leader_share_bps or jurisdiction allowlist). Sql store needs
// copy_follows + copy_mirrored_fills migrations; fee-share still ledger-only.
const copyFeeShareLaw = parseCopyFeeShareLawJson(env.TRADE_COPY_FEE_SHARE_LAW);
const copyJurisdictionLaw = parseCopyJurisdictionLawJson(env.TRADE_COPY_JURISDICTION_LAW);
const copy = new CopyService(ledger, {
  feeShareLaw: copyFeeShareLaw,
  jurisdictionLaw: copyJurisdictionLaw,
  store: new SqlCopyFollowStore(sql),
  placeFollowerOrder: async (principal, input) => {
    const order = await trade.placeOrder(principal, {
      symbol: input.symbol,
      marketId: input.marketId,
      side: input.side,
      type: 'limit',
      qty: input.qty,
      price: input.price,
      tif: 'GTC',
      clientOrderId: input.clientOrderId,
    });
    return { orderId: order.id };
  },
  inspectMarket: async (symbol) => {
    const market = await trade.marketBySymbol(symbol);
    return market ? { paper: market.paper } : null;
  },
  lookupFollowerFillFee: async (fillId) => {
    const id = canonicalizeCopyFillId(fillId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      return null;
    }
    const [row] = await sql<Array<{ id: string; user_id: string; fee_asset: string; fee_amount: string; created_at: Date }>>`
      SELECT id, user_id, fee_asset, fee_amount, created_at FROM trade.fills WHERE id = ${id} LIMIT 1
    `;
    if (!row) return null;
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    return {
      fillId: row.id,
      userId: row.user_id,
      feeAsset: row.fee_asset,
      feeAmount: parseAmount(row.fee_amount),
      createdAt,
    };
  },
});

export const appRouter = createTradeRouter(trade, otc, copy);
export type AppRouter = typeof appRouter;

const edgeContext = createEdgeContext({ secret: env.EDGE_PRINCIPAL_SECRET, serviceName: env.SERVICE_NAME });

const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });

// Venue fabric public mid → mark path (A-TRADE-VENUE-1). Adapter created above (OTC/MM share).
if (venueBookPort && venuePublicAdapter) {
  for (const symbol of venueStreamSymbols) {
    const book = new MaintainedBook(venuePublicAdapter, symbol);
    venueMaintainedBooks.set(symbol, book);
    void book.run().then((status) => {
      app.log.warn({ symbol, status }, 'venue maintained book ended');
    });
  }
}
const venueMarkConfigured = createConfiguredVenueMarkSource({
  venueId: env.TRADE_VENUE_MARK_VENUE,
  symbols: venueMarkSymbols,
  adapter: venuePublicAdapter,
  ...(venueBookPort ? { bookForSymbol: venueBookPort } : {}),
});
if (env.TRADE_VENUE_MARK_VENUE.trim() && !venueMarkConfigured) {
  // Typo / unsupported venue — say so once; do not invent a mid adapter.
  console.warn(
    `[svc-trade] TRADE_VENUE_MARK_VENUE=${env.TRADE_VENUE_MARK_VENUE.trim()} is not a known public MarketDataAdapter; venue mark off (never invent). Supported: binance-spot, bybit-spot, okx-spot`,
  );
}

// Futures residual jobs — default OFF. Rate book is process-local for public REST peeks.
// Marks: venue fabric preferred when configured, else matching depth mid — never invent.
//
// Funding magnitude bound (D2 / C12): when funding markets are listed the max
// abs rate is REQUIRED at boot. No product default — unset max refuses
// publish + settle. See futures/funding-rate-bound.ts.
const fundingMarketIds = parseFundingMarketIds(env.TRADE_FUTURES_FUNDING_MARKET_IDS);
const fundingMaxAbsRate = resolveFundingMaxAbsRateForBoot({
  fundingMarketIds,
  maxAbsRateRaw: env.TRADE_FUTURES_FUNDING_MAX_ABS_RATE,
});
if (fundingMaxAbsRate) {
  app.log.info({ fundingMaxAbsRate }, 'futures funding |rate| bound is configured');
} else if (fundingMarketIds.length === 0) {
  app.log.info(
    'TRADE_FUTURES_FUNDING_MAX_ABS_RATE unset — funding markets empty; publish/settle still refuse rates until a max is set (no invented ceiling)',
  );
}

const futuresJobs = startFuturesJobs({
  sql,
  ledger,
  matching,
  bus,
  venueMarkSource: venueMarkConfigured?.source ?? null,
  config: {
    enabled: env.TRADE_FUTURES_JOBS_ENABLED,
    liqIntervalMs: env.TRADE_FUTURES_LIQ_INTERVAL_MS,
    fundingIntervalMs: env.TRADE_FUTURES_FUNDING_INTERVAL_MS,
    fundingMarketIds,
    fundingMaxAbsRate,
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'futures job tick failed'),
});

/**
 * WHERE REALISED FUTURES PROFIT COMES FROM.
 *
 * Still not defaulted, and a value that IS set is still validated right here at
 * boot: unparseable, or an account `futuresRealizeProfit` does not draw from,
 * and this process exits. Which account and how it is capitalised remains an
 * owner decision (`docs/adr/2026-08-05-futures-risk-and-mark-law.md`).
 *
 * What changed is what happens when nobody has decided YET. This line used to
 * call `profitSourceFromConfig`, which throws on an empty value — while
 * `.env.example` ships the variable commented out and compose passes
 * `${TRADE_FUTURES_PROFIT_SOURCE:-}`. So `pnpm platform:up` from a clean clone
 * crash-looped svc-trade. Not "futures": svc-trade. Spot orders, ticker,
 * orderbook, balances, fees, positions and the feeds behind the websocket all
 * went with it, over a pot that only matters when somebody closes a winning
 * perp. A refusal with exactly one legal answer is not a decision gate, it is
 * an outage.
 *
 * So the absence of a decision now disables the FEATURE: `null` here, `open()`
 * refuses, and a close that would realise profit refuses. Nothing is ever paid
 * out of an account nobody chose — which is what the ADR requires — and the
 * exchange stays up while the owner decides.
 */
const profitSource = optionalProfitSourceFromConfig(env.TRADE_FUTURES_PROFIT_SOURCE);
const maxLeverage = parseConfiguredMaxLeverage(env.TRADE_FUTURES_MAX_LEVERAGE);
if (profitSource) {
  app.log.info({ profitSource: profitSource.configured }, 'futures realised profit is bounded by this account');
} else {
  app.log.warn(
    { variable: 'TRADE_FUTURES_PROFIT_SOURCE' },
    'FUTURES IS DISABLED: no account is named to fund realised profit, so opens are refused and no profit can be paid. ' +
      'Losing and flat closes of existing positions still work, and the rest of svc-trade is serving normally. See .env.example.',
  );
}

/**
 * Positions price from `futuresJobs.marks` — the same venue-fabric-then-depth
 * port liquidation reads. Constructed after the jobs for that reason: there is
 * no second price path, and no request body anywhere near one.
 *
 * DIRECTION:34 — ADL disclosure gate is wired here so open refuses without ack
 * even if a caller bypasses the REST door.
 */
const adlDisclosureAcks = sqlAdlDisclosureStore(sql);
const adlDisclosureEvents = sqlAdlDisclosureEventStore(sql);
const positions = new PositionService(sql, ledger, {
  marks: futuresJobs.marks,
  profitSource,
  bus,
  maxLeverage,
  assertAdlDisclosureAcked: async (userId) => {
    try {
      await assertAdlDisclosureAcked(adlDisclosureAcks, userId);
    } catch (err) {
      if (err instanceof AdlDisclosureError) {
        throw new FuturesError(err.message, err.code, err.status);
      }
      throw err;
    }
  },
});

// Spot candle materialization — default OFF. REST OHLCV still live from fills.
const candleJobs = startCandleJobs({
  sql,
  config: {
    enabled: env.TRADE_CANDLE_JOBS_ENABLED,
    intervalMs: env.TRADE_CANDLE_JOBS_INTERVAL_MS,
    marketIds: parseCandleMarketIds(env.TRADE_CANDLE_JOBS_MARKET_IDS),
    timeframes: parseCandleTimeframes(env.TRADE_CANDLE_JOBS_TIMEFRAMES),
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'candle job tick failed'),
  onResult: (r) => {
    if (r.written > 0) {
      app.log.info(
        { marketId: r.marketId, timeframe: r.timeframe, candleCount: r.candleCount, written: r.written },
        'candle materialize ok',
      );
    }
  },
});

// MM seed job — default OFF. Empty markets or missing mids → no invent.
// Mid port (A-TRADE-MM-3): env map first; optional venue public mid when enabled.
const mmMidSource = createMmMidSourceFromConfig({
  midsEnv: env.TRADE_MM_SEED_MIDS,
  midFromVenue: env.TRADE_MM_SEED_MID_FROM_VENUE,
  venueAdapter: venuePublicAdapter,
  resolveVenueSymbol: (marketId) => venueMarkSymbols.get(marketId) ?? null,
  ...(venueBookPort ? { bookForSymbol: venueBookPort } : {}),
});
const mmSeedTargets = parseMmSeedTargets(env.TRADE_MM_SEED_MARKETS);
const mmSeedJobs = startMmSeedJobs({
  ledger,
  matching,
  midSource: mmMidSource,
  // Same catalog + futures flag as placeOrder (handoff §7 assertTradable).
  marketFor: async (marketId) => {
    const m = await trade.marketById(marketId);
    if (!m) return null;
    return m;
  },
  marketLifecycle,
  now: () => new Date(),
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
  config: {
    enabled: env.TRADE_MM_SEED_ENABLED,
    intervalMs: env.TRADE_MM_SEED_INTERVAL_MS,
    halfSpreadBps: env.TRADE_MM_SEED_HALF_SPREAD_BPS,
    stepBps: env.TRADE_MM_SEED_STEP_BPS,
    levels: env.TRADE_MM_SEED_LEVELS,
    qtyPerLevel: env.TRADE_MM_SEED_QTY,
    targets: mmSeedTargets,
  },
  statePath: env.TRADE_MM_SEED_STATE_PATH,
  // SD-2: flag resting MM seed orders so public tape excludes them before fill.
  recordSeededOrder: async (row) => {
    await sql`
      INSERT INTO trade.orders (
        id, user_id, market_id, side, type, price, qty, status, tif,
        hold_asset, hold_amount, fee_discount_bps, seeded, lifecycle_proof
      ) VALUES (
        ${row.orderId}, ${HOUSE_MM_USER_UUID}, ${row.marketId}, ${row.side}, ${'limit'},
        ${row.price}::numeric, ${row.qty}::numeric, ${'open'}, ${'PO'},
        ${row.holdAsset}, ${row.holdAmount}::numeric, ${0}, ${true}, ${JSON.stringify(row.lifecycleProof)}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `;
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'mm seed job tick failed'),
  onResult: (marketId, result) => {
    if ('skipped' in result) {
      app.log.info({ marketId, skipped: result.skipped }, 'mm seed skipped');
    } else if (result.ok) {
      app.log.info({ marketId, mid: result.mid, placements: result.placements.length }, 'mm seed ok');
    } else {
      app.log.warn({ marketId, reason: result.reason }, 'mm seed failed');
    }
  },
});

// TWAP scheduler — default OFF. Until this runs, a created schedule persists
// and never places a child; `tickAllAlgos` had no caller at all before it.
// ADR 2026-08-08 re-space + cancel honesty land with this mount.
const algoJobs = startAlgoJobs({
  trade,
  config: {
    enabled: env.TRADE_ALGO_JOBS_ENABLED,
    intervalMs: env.TRADE_ALGO_JOBS_INTERVAL_MS,
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'algo job tick failed'),
});

// Engine ↔ ledger reconcile sweep — default OFF (A10). Refuse = alert only;
// auto-delete only unfunded pending. Never silent-release funded missing.
const reconcileJobs = startEngineLedgerReconcileJobs({
  sql,
  ledger,
  matching,
  config: {
    enabled: env.TRADE_RECONCILE_JOBS_ENABLED,
    intervalMs: env.TRADE_RECONCILE_JOBS_INTERVAL_MS,
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'engine-ledger reconcile job tick failed'),
  onResult: (r) => {
    if (r.marketIdDrift.drifted) {
      app.log.warn(
        {
          tradeCount: r.marketIdDrift.tradeCount,
          engineCount: r.marketIdDrift.engineCount,
          onlyInTrade: r.marketIdDrift.onlyInTrade,
          onlyInEngine: r.marketIdDrift.onlyInEngine,
        },
        'engine-ledger market-id DRIFT — alarm only; no invent/delete of markets',
      );
    }
    if (r.plan.refusals.length > 0) {
      app.log.warn(
        {
          checked: r.report.checked,
          refusals: r.plan.refusals.length,
          findings: r.plan.refusals.map((f) => ({
            orderId: f.orderId,
            case: f.case,
            engine: f.engine,
            counterpart: f.counterpart,
          })),
        },
        'engine-ledger reconcile REFUSE — no write; operator must resolve',
      );
    }
    if (r.deleted.length > 0) {
      app.log.info({ deleted: r.deleted }, 'engine-ledger reconcile auto-deleted unfunded pending');
    }
    if (r.plan.autoNonDelete.length > 0) {
      app.log.info(
        { autoNonDelete: r.plan.autoNonDelete.map((f) => ({ orderId: f.orderId, case: f.case })) },
        'engine-ledger reconcile auto findings not deleted (pending-only rule)',
      );
    }
  },
});

app.get('/health', async () => ({
  ok: true,
  service: env.SERVICE_NAME,
  venueLatency: presentVenueLatencyHealth(venuePublicAdapter, new Date(), {
    streamEnabled: env.TRADE_VENUE_MARK_STREAM,
  }),
  mmSeed: presentMmSeedHealth({
    enabled: env.TRADE_MM_SEED_ENABLED,
    targetCount: mmSeedTargets.length,
  }),
  futuresJobs: presentFuturesJobsHealth({
    enabled: env.TRADE_FUTURES_JOBS_ENABLED,
    fundingMarketCount: fundingMarketIds.length,
    fundingMaxAbsRateConfigured: fundingMaxAbsRate !== null,
    fundingIntervalConfigured: env.TRADE_FUTURES_FUNDING_INTERVAL_MS != null,
    venueMarkConfigured: venueMarkConfigured != null,
  }),
  insuranceListing: presentInsuranceListingPolicy(),
}));

app.get('/ready', async (_req, reply) => {
  if (!env.TRADE_SPOT_ENABLED) return reply.code(503).send({ ready: false, reason: 'trade.spot flag is off' });

  /**
   * Is the engine behind what we have already settled? (`spot/sequence-guard.ts`)
   *
   * A restart that lost the journal while Postgres kept `trade.fills` leaves the
   * engine re-issuing sequences that already identify settled trades — and
   * `fillIdFor(market, sequence)` is the ledger's idempotency key.
   *
   * `insertFillLeg` already refuses that at settlement, so nothing is
   * mis-settled either way. What this adds is WHEN it is noticed: on a probe a
   * load balancer reads, rather than on the first user whose order is refused.
   * A replica in this state was unfit the moment it finished booting.
   */
  const sequences = await checkEngineSequences({
    sql,
    markets: () => trade.markets(),
    engineSequence: async (marketId) => {
      try {
        return (await matching.depth(marketId, 1)).sequence;
      } catch {
        // Matching being unreachable is a different readiness question and not
        // this check's to answer — reported as unjudged, never as healthy.
        return null;
      }
    },
  });

  if (sequences.regressions.length > 0) {
    const reason = describeRegressions(sequences.regressions);
    app.log.error({ regressions: sequences.regressions }, reason);
    return reply.code(503).send({ ready: false, reason, markets: sequences.regressions.map((r) => r.symbol) });
  }

  // Counts, not a bare boolean: "checked 12" and "checked 0 because nothing has
  // traded yet" are different facts, and a probe that renders both as `true`
  // cannot tell an operator which one they are looking at.
  return { ready: true, engineSequences: { checked: sequences.checked, unjudged: sequences.unjudged } };
});

// Public CCXT-style REST (markets, orderbook, ticker, tickers, trades, ohlcv).
// No auth — market data is public. Paths match packages/exchange-contract
// REST_ROUTES; edge routes /api/v1 → here with path preserve and principal
// exchange (private routes below verify the edge signature).
// OHLCV is aggregated in SQL from the real taker fill tape — no candle is
// invented, and a bucket with no fills is absent rather than zero-filled.
registerPublicRest(app, {
  markets: () => trade.markets(),
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  depth: (marketId, limit) => matching.depth(marketId, limit),
  publicTape: (marketId, limit, sinceMs) => trade.publicTape(marketId, limit, sinceMs),
  candles: (marketId, timeframe, limit, sinceMs) => trade.candles(marketId, timeframe, limit, sinceMs),
  lifecycleForMarket: (market) => trade.marketLifecycleSnapshot(market),
  fundingRateForMarket: async (marketId, _symbol) => {
    const entry = futuresJobs.getPublishedRate(marketId);
    if (!entry) return null;
    const fundingDatetime = new Date(entry.asOfMs).toISOString();
    // Public mark: same non-inventing port as liquidation (venue fabric → depth).
    // Null when no book / unmapped — never invent index or mark.
    const markPrice = await futuresJobs.markPrice(marketId);
    return {
      fundingRate: entry.rate,
      fundingTimestamp: entry.asOfMs,
      fundingDatetime,
      nextFundingTimestamp: null,
      markPrice,
      indexPrice: null,
    };
  },
  algo: {
    createEnabled: env.TRADE_ALGO_ENABLED,
    jobsEnabled: env.TRADE_ALGO_JOBS_ENABLED,
  },
  futures: {
    jobsEnabled: env.TRADE_FUTURES_JOBS_ENABLED,
    orderableEnabled: env.TRADE_FUTURES_ENABLED,
    profitSourceConfigured: profitSource != null,
    fundingMaxAbsRateConfigured: env.TRADE_FUTURES_FUNDING_MAX_ABS_RATE.trim() !== '',
    fundingMarketCount: fundingMarketIds.length,
    venueMarkConfigured: venueMarkConfigured != null,
    fundingIntervalConfigured: env.TRADE_FUTURES_FUNDING_INTERVAL_MS != null,
    maxLeverage: maxLeverage == null ? null : formatAmount(maxLeverage),
  },
});

registerFuturesTickerRest(app, {
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  markForMarket: (marketId, symbol) => futuresJobs.publicMark(marketId, symbol),
  fundingForMarket: (marketId) => futuresJobs.getPublishedRate(marketId),
});

registerPositionPreviewRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  markForMarket: (marketId, symbol) => futuresJobs.publicMark(marketId, symbol),
  leverageCap: maxLeverage,
  // No maintenance/depth calculator is supplied until owner policy exists.
  // The route returns liquidationPrice:null + a typed refusal meanwhile.
});

registerSpotOrderPreviewRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  now: () => new Date(),
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  marketLifecycle,
  bestAsk: async (marketId) => {
    const depth = await matching.depth(marketId, 1);
    const best = depth.asks[0];
    return best ? parseAmount(best[0]) : null;
  },
  spotEnabled: env.TRADE_SPOT_ENABLED,
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
  optionsSettlementLawStamped: env.TRADE_OPTIONS_SETTLEMENT_ASSET_LAW.trim().length > 0,
  slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
});

// S2S: oracle/ops publish funding rates (public GET only reflects published).
// maxAbsRate gates absurd magnitudes before the rate book accepts them.
registerInternalFundingRate(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  publishFundingRate: (entry) => futuresJobs.publishFundingRate(entry),
  maxAbsRate: fundingMaxAbsRate,
});

registerMarketLifecycleRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  store: marketLifecycleStore,
});

const copyLeaderFixturesStore = createCopyLeaderFixturesStore(sql);
registerCopyLeaderFixturesRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  store: copyLeaderFixturesStore,
});

// Custodial outcome doors start with no invented listings. Order and settlement
// ports remain absent until their ledger-backed implementations are configured.
registerOutcomesRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  catalogue: memoryOutcomeCatalogue([]),
});

// Private CCXT REST — edge-signed principal, same trust boundary as tRPC.
// Create/cancel/cancelAll are the money path: TradeService only (no second hold).
// Balance is a self-only ledger projection (principal.userId → ledger.balances).
installGtdGttPlace(TradeService);
attachExpireStash(app);
installReduceOnlyPlace(TradeService);
attachReduceOnlyStash(app);
installClosePosition(TradeService);
attachClosePosition(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  closeSpotPosition: (principal, input) => closeSpotPosition(trade, principal, input),
});
registerPrivateRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  serviceName: env.SERVICE_NAME,
  openOrders: (principal, marketId) => trade.openOrders(principal, marketId),
  adminOpenOrders: (principal, limit) => trade.adminOpenOrders(principal, limit),
  orderHistory: (principal, input) => trade.orderHistory(principal, input),
  getOrder: (principal, orderId) => trade.getOrder(principal, orderId),
  placeOrder: (principal, input) => trade.placeOrder(principal, bindReduceOnly(bindExpireAt(input))),
  cancelOrder: (principal, orderId) => trade.cancelOrder(principal, orderId),
  replaceOrder: (principal, orderId, input) => trade.replaceOrder(principal, orderId, input),
  amendOrder: (principal, orderId, input) => trade.amendOrder(principal, orderId, input),
  cancelAllOrders: (principal, marketId) => trade.cancelAllOrders(principal, marketId),
  myFills: (principal, limit, marketId, sinceMs) => trade.myFills(principal, limit, marketId, sinceMs),
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  marketById: (marketId) => trade.marketById(marketId),
  markets: () => trade.markets(),
  lifecycleForMarket: (market) => trade.marketLifecycleSnapshot(market),
  // Self-only: route always passes principal.userId — never client ownerId.
  userBalances: (userId) => ledger.balances('user', userId),
  listPositions: (principal, symbol) => positions.listOpen(principal.userId, symbol),
  listClosedPositions: (principal, input) => positions.listClosed(principal.userId, input),
  getPosition: (principal, positionId) => positions.get(principal.userId, positionId),
  openPosition: (principal, input) =>
    positions.open({
      userId: principal.userId,
      symbol: input.symbol,
      side: input.side,
      size: parseAmount(input.size),
      leverage: parseAmount(input.leverage),
      marginMode: input.marginMode,
      clientOpenId: input.clientOpenId,
    }),
  closePosition: (principal, positionId) => positions.close(principal.userId, positionId),
  setLeverage: (principal, input) =>
    positions.setLeverage({
      userId: principal.userId,
      symbol: input.symbol,
      leverage: parseAmount(input.leverage),
      positionId: input.positionId,
      clientAdjustmentId: input.clientAdjustmentId,
    }),
  addIsolatedMargin: (principal, input) =>
    positions.addIsolatedMargin({
      userId: principal.userId,
      symbol: input.symbol,
      amount: parseAmount(input.amount),
      positionId: input.positionId,
      clientAdjustmentId: input.clientAdjustmentId,
    }),
  reduceIsolatedMargin: (principal, input) =>
    positions.reduceIsolatedMargin({
      userId: principal.userId,
      symbol: input.symbol,
      amount: parseAmount(input.amount),
      positionId: input.positionId,
      clientAdjustmentId: input.clientAdjustmentId,
    }),
  getOpenMarginCall: async (principal, positionId) => {
    const row = await futuresJobs.marginCalls.getOpenForPosition(positionId);
    if (!row || row.userId !== principal.userId) return null;
    return presentMarginCallWire(row);
  },
  getAdlDisclosure: async (principal) => presentAdlDisclosureWire(await adlDisclosureAcks.getAck(principal.userId, ADL_DISCLOSURE_VERSION)),
  ackAdlDisclosure: async (principal) => {
    const row = await adlDisclosureAcks.recordAck(principal.userId, ADL_DISCLOSURE_VERSION, new Date());
    return presentAdlDisclosureWire(row);
  },
  listAdlDisclosureEvents: async (principal) => {
    const rows = await adlDisclosureEvents.listForUser(principal.userId);
    return rows.map(presentAdlActionDisclosureWire);
  },
});

await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
  } satisfies FastifyTRPCPluginOptions<TradeRouter>['trpcOptions'],
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    spotEnabled: env.TRADE_SPOT_ENABLED,
    // Logged next to `spotEnabled` because an operator asking "is futures on
    // here" must be able to answer it from the boot line rather than by reading
    // a refusal off a user's failed order.
    futuresEnabled: env.TRADE_FUTURES_ENABLED,
    futuresJobsEnabled: env.TRADE_FUTURES_JOBS_ENABLED,
    futuresJobs: futuresJobs.host.list(),
    venueMark: venueMarkConfigured ? { configured: true, symbolCount: venueMarkConfigured.symbolCount } : null,
    candleJobsEnabled: env.TRADE_CANDLE_JOBS_ENABLED,
    candleJobs: candleJobs.host.list(),
    mmSeedEnabled: env.TRADE_MM_SEED_ENABLED,
    mmSeedJobs: mmSeedJobs.host.list(),
    algoJobsEnabled: env.TRADE_ALGO_JOBS_ENABLED,
    algoJobs: algoJobs.host.list(),
    reconcileJobsEnabled: env.TRADE_RECONCILE_JOBS_ENABLED,
    reconcileJobs: reconcileJobs.host.list(),
    trpc: true,
    publicRest: [
      '/api/v1/capabilities',
      '/api/v1/markets',
      '/api/v1/orderbook/:symbol',
      '/api/v1/ticker/:symbol',
      '/api/v1/tickers',
      '/api/v1/trades/:symbol',
      '/api/v1/ohlcv/:symbol',
      '/api/v1/funding-rate/:symbol',
    ],
    privateRest: [
      'POST /api/v1/orders',
      'POST /api/v1/orders/preview',
      'POST /api/v1/orders/batch',
      'POST /api/v1/positions/preview',
      'DELETE /api/v1/orders',
      'DELETE /api/v1/orders/:id',
      'GET /api/v1/orders/:id',
      'GET /api/v1/orders/open',
      'GET /api/v1/orders/closed',
      'GET /api/v1/account/trades',
      'GET /api/v1/account/fees',
      'GET /api/v1/account/balance',
      'GET /api/v1/positions',
      'GET /api/v1/positions/closed',
      'GET /api/v1/positions/:id',
      'GET /api/v1/positions/:id/margin-call',
      'GET /api/v1/futures/adl-disclosure',
      'POST /api/v1/futures/adl-disclosure/ack',
      'GET /api/v1/futures/adl-events',
      'POST /api/v1/positions',
      'DELETE /api/v1/positions/:id',
      'POST /api/v1/positions/leverage',
      'POST /api/v1/positions/margin',
      'POST /api/v1/positions/margin/reduce',
      'POST /api/v1/positions/margin-mode',
    ],
  },
  'svc-trade ready',
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      futuresJobs.stop();
      candleJobs.stop();
      mmSeedJobs.stop();
      algoJobs.stop();
      reconcileJobs.stop();
      await Promise.all([...venueMaintainedBooks.values()].map((b) => b.close()));
      await app.close();
      for (const subscription of subscriptions) await subscription.unsubscribe();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
