import Fastify from 'fastify';
import postgres from 'postgres';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext, retainRawBody, createIdentityOperationDecisionClient, s2sFromEnv } from '@intafaced/contracts';
import { TradingControls, TradingControlError } from './controls/trading-controls.js';
import { createLiveTradingOperator } from './controls/identity-port.js';
import { JetStreamEventBus } from '@intafaced/events';
import { assertNoLocalTestFixtures, edgeTrustFromEnv } from '@intafaced/config';
import { env } from './env.js';
import { MARKETS_LIMIT_MAX, TradeService } from './spot/trade-service.js';
import { createMatchingClient } from './spot/matching-client.js';
import { bindMatchingCloseS2s } from './spot/matching-close.js';
import { readOcoIntents } from './spot/oco-intent.js';
import { createTickerStatsReader } from './spot/ticker-stats.js';
import { createRankPerksClient } from './spot/rank-perks.js';
import { createAffiliateAccrueClient } from './spot/affiliate-accrue.js';
import { createAffiliatePayoutClient } from './spot/affiliate-payout.js';
import { createDropCopyIngestClient } from './spot/drop-copy-ingest.js';
import { createSubAccountOwnershipClient } from './spot/sub-account-ownership.js';
import { createLedgerClient } from './ledger-client.js';
import { registerClosureCheck } from './closure/closure-check.js';
import { subscribeMatchingEvents } from './events.js';
import { createTradeRouter, type TradeRouter } from './router.js';
import { identityApprovalBook } from './admin/identity-approval.js';
import { bindTradingRestrictApprovals, currentTradingRestrictApprovals } from './admin/trading-restrict.js';
import { operatorSeedAllows as readOperatorSeedAllows } from './admin/service.js';
import { wireTradeOpsAdmin } from './admin/wire.js';
import { InsuranceTopupAdmin } from './admin/insurance-topup.js';
import { SupportTradeSummaryReader } from './support/trade-summary.js';
import { registerPublicRest } from './public-rest.js';
import { registerFuturesTickerRest } from './futures/futures-ticker-rest.js';
import {
  conditionalTriggerScheduled,
  createConditionalOrderService,
  registerConditionalOrdersRest,
  refuseFuturesRestingLimit,
  startConditionalOrderJobs,
} from './futures/conditional-orders/index.js';
import { listCallerLiquidations, listFundingPayments, readFuturesTickerFacts } from './futures/futures-reads.js';
import { listPayoutsForUser } from './futures/futures-payouts.js';
import { registerPrivateRest } from './private-rest.js';
import { bindExpireAt, installGtdGttPlace } from './spot/gtd-gtt-place.js';
import { bindReduceOnly, installReduceOnlyPlace } from './spot/reduce-only-place.js';
import { attachBoundClosePosition } from './spot/close-position.js';
import { bindPostOnly, installPostOnlyPlace } from './spot/post-only-place.js';
import { bindIoc, installIocPlace } from './spot/ioc-place.js';
import { bindFok, installFokPlace } from './spot/fok-place.js';
import { bindIceberg, installIcebergPlace } from './spot/iceberg-place.js';
import { sqlIcebergDisplay } from './spot/iceberg-door.js';
import { sqlStopTrigger } from './spot/stop-trigger-door.js';
import { bindStopLimit, installStopLimitPlace } from './spot/stop-limit-place.js';
import { bindTrailingStop, installTrailingStopPlace } from './spot/trailing-stop-place.js';
import { bindOption, installOptionPlace } from './spot/option-place.js';
import { bindMinQty, installMinQtyPlace } from './spot/min-qty-place.js';
import { bindAon, installAonPlace } from './spot/aon-place.js';
import { bindPeg, installPegPlace } from './spot/peg-place.js';
import { bindAuction, installAuctionPlace } from './spot/auction-place.js';
import { installSelfTradePlace } from './spot/self-trade-place.js';
import { installMarketHaltPlace } from './spot/market-halt-place.js';
import { installVenueHaltPlace } from './spot/venue-halt-place.js';
import { installMarketReduceOnlyPlace } from './spot/market-reduce-only-place.js';
import { installMarketPostOnlyPlace } from './spot/market-post-only-place.js';
import { installMarketPrelaunchPlace } from './spot/market-prelaunch-place.js';
import { installMarketExpiredPlace } from './spot/market-expired-place.js';
import { installMarketDelistedPlace } from './spot/market-delisted-place.js';
import { bindCollar, installCollarPlace } from './spot/collar-place.js';
import { bindCombo, installComboPlace } from './spot/combo-place.js';
import { memoryOutcomeCatalogue, registerOutcomesRest } from './outcomes-rest.js';
import { registerPositionPreviewRest } from './futures/position-preview-rest.js';
import { registerGreeksWhatIfRest } from './greeks/what-if-rest.js';
import { registerDeltaHedgeRest } from './greeks/delta-hedge-rest.js';
import { registerQuantLiveDeployRest } from './quant/live-deploy-rest.js';
import { registerPromoRest } from './spot/promo-rest.js';
import { registerSpotOrderPreviewRest } from './spot/order-preview-rest.js';
import { parseFeeScheduleJson } from './spot/fee-schedule.js';
import { feeScheduleAt } from './spot/fee-schedule-store.js';
import { PositionService, FuturesError } from './futures/position-service.js';
import {
  ADL_DISCLOSURE_VERSION,
  assertAdlDisclosureAcked,
  presentAdlDisclosureWire,
  sqlAdlDisclosureStore,
  AdlDisclosureError,
} from './futures/adl-disclosure.js';
import { presentAdlActionDisclosureWire, sqlAdlDisclosureEventStore } from './futures/adl-last-resort.js';
import { derivativesAccessGate } from './futures/derivatives-access.js';
import { assessEligibility, presentQuestions, readEligibilityState, sqlEligibilityStore } from './futures/derivatives-eligibility.js';
import { acceptAgreement, AGREEMENT_KINDS, readAgreementView, sqlRiskAgreementStore } from './futures/risk-agreements.js';
import { optionalProfitSourceFromConfig } from './futures/profit-source.js';
import { parseConfiguredMaxLeverage } from './futures/initial-margin.js';
import { parseConfiguredSettleAssets } from './futures/contract-family.js';
import { parseFundingMarketIds, startFuturesJobs } from './futures/futures-jobs.js';
import { presentMarginCallWire } from './futures/margin-call-transport.js';
import { createConfiguredVenueMarkSource, createVenueMarketDataAdapter, parseVenueMarkSymbols } from './futures/mark-from-venue.js';
import { presentVenueLatencyHealth } from './futures/venue-latency-health.js';
import { presentInsuranceListingPolicy } from './futures/insurance-listing-gate.js';
import { presentFuturesJobsHealth } from './futures/futures-jobs-health.js';
import { sqlMarginModeSwitchAudit } from './futures/margin-mode.js';
import { MaintainedBook } from '@intafaced/venue-adapter';
import { registerInternalFundingRate } from './futures/internal-funding-rate.js';
import { memoryFundingHistory, registerFundingHistory } from './futures/funding-history.js';
import { createCopyLeaderFixturesStore } from './agents/copy-leader-fixtures-store.js';
import { registerCopyLeaderFixturesRoutes } from './agents/copy-leader-fixtures-routes.js';
import { resolveFundingMaxAbsRateForBoot } from './futures/funding-rate-bound.js';
import { parseMmSeedTargets, startMmSeedJobs } from './mm/seed-jobs.js';
import { presentMmSeedHealth } from './mm/seed-health.js';
import { createMmMidSourceFromConfig } from './mm/mid-source.js';
import { HOUSE_MM_API_KEY_ID } from './spot/auth-attribution.js';
import { HOUSE_MM_USER_UUID } from './spot/ids.js';
import { parseCandleMarketIds, parseCandleTimeframes } from './spot/candles.js';
import { startCandleJobs } from './spot/candle-jobs.js';
import { startTrailingMarkJobs } from './spot/trailing-mark-jobs.js';
import { markSourceFromDepth } from './futures/mark-from-depth.js';
import type { QuotedMarkSource } from './futures/liquidation-tick.js';
import { startEngineLedgerReconcileJobs } from './spot/engine-ledger-reconcile-jobs.js';
import { startHoldUnknownSweepJobs } from './spot/hold-unknown-sweep-jobs.js';
import type { CancelAllAfterHost } from './spot/cancel-all-after.js';
import './spot/cancel-all-after.js';
import { startAlgoJobs } from './algo/algo-jobs.js';
import { recordSchedulerHeartbeat, schedulerInstanceId } from './algo/scheduler-heartbeat.js';
import { startOptionsExerciseJobs } from './spot/options-exercise-jobs.js';
import { checkEngineSequences, describeRegressions, describeUnavailable, probeEngineSequence } from './spot/sequence-guard.js';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';
import { parseOtcDeskLawJson } from './otc/desk-law.js';
import { createOtcMidSourceFromConfig } from './otc/venue-mid-source.js';
import { describeOtcMidFeedWiring } from './otc/mid-feed.js';
import { OtcDeskService } from './otc/otc-service.js';
import { parseOtcMakerDirectoryJson } from './otc/maker-directory.js';
import { SqlOtcQuoteStore } from './otc/quote-store.js';
import { createOtcStakeSource } from './otc/stake-source.js';
import { canonicalizeCopyFillId } from './copy/fee-share.js';
import { parseCopyFeeShareLawJson, parseCopyJurisdictionLawJson } from './copy/fee-share-law.js';
import { parseCopyDisclosureLawJson } from './copy/disclosure.js';
import { CopyService } from './copy/copy-service.js';
import { SqlCopyFollowStore } from './copy/follow-store.js';
import { SqlMirrorEventLog } from './copy/mirror-events.js';
import { sqlLeaderDirectory } from './copy/leader-directory.js';
import { createFollowerFlattenPort } from './copy/follower-flatten-port.js';
import type { PlaceFollowerOrderPort } from './copy/auto-mirror-place.js';
import { SqlMarketLifecycleAuthority, SqlMarketLifecycleEvidenceStore, assertNoLocalTestLifecycleRows } from './market-lifecycle.js';
import { registerMarketLifecycleRoutes } from './market-lifecycle-routes.js';
import { logTrpcServerFault } from './trpc-error-log.js';

registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

// Local-test stand-ins (ZZ screening list, SCREENING_FAIL_CLOSED=off, `local-test:` lifecycle
// records) are refused unless APP_ENV is exactly dev/test. Reads the raw APP_ENV: unset = NOT dev.
assertNoLocalTestFixtures(process.env);

const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  ssl: env.DATABASE_SSL ? 'require' : false,
  connection: { search_path: 'trade,public', application_name: env.SERVICE_NAME },
  onnotice: () => undefined,
});
await sql`SELECT 1 FROM trade.markets LIMIT 1`.catch(() => {
  throw new Error('trade schema is missing — run migrations before starting svc-trade');
});
await assertNoLocalTestLifecycleRows(sql, process.env);

// Per-service keys (S2S v3): unset S2S_AUTH_MODE leaves the ledger calls on the shared secret alone.
const s2s = s2sFromEnv(env, 'svc-trade');
const doorS2s = s2s.serviceVerifier && s2s.s2sMode ? { verifier: s2s.serviceVerifier, mode: s2s.s2sMode } : undefined;
const outS2s = s2s.signer && s2s.s2sMode ? { signer: s2s.signer, mode: s2s.s2sMode } : undefined;
bindMatchingCloseS2s(outS2s);
const ledger = createLedgerClient(env.LEDGER_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
bindTradingRestrictApprovals(identityApprovalBook(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s));
const tradingControls = new TradingControls(
  sql,
  createLiveTradingOperator({ url: env.IDENTITY_URL, serviceSecret: env.INTERNAL_SERVICE_SECRET, s2s: outS2s }),
  createIdentityOperationDecisionClient({
    owner: 'svc-trade',
    identityUrl: env.IDENTITY_URL,
    secret:
      env.IDENTITY_ADMISSION_SECRET !== env.INTERNAL_SERVICE_SECRET && env.IDENTITY_ADMISSION_SECRET !== env.EDGE_PRINCIPAL_SECRET
        ? env.IDENTITY_ADMISSION_SECRET
        : undefined,
  }),
);
const matching = createMatchingClient(env.MATCHING_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
const perks = createRankPerksClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
const subAccounts = createSubAccountOwnershipClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
const affiliateAccrue = createAffiliateAccrueClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
const affiliatePayout = createAffiliatePayoutClient(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
const dropCopyIngest = createDropCopyIngestClient(env.TRADE_FIX_DROPCOPY_INGEST_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
const marketLifecycleStore = new SqlMarketLifecycleEvidenceStore(sql);
const marketLifecycle = new SqlMarketLifecycleAuthority(sql, matching, {
  spotEnabled: env.TRADE_SPOT_ENABLED,
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
});
const bus = await JetStreamEventBus.connect({
  servers: env.NATS_URL,
  producer: env.SERVICE_NAME,
  streamPrefix: env.NATS_STREAM_PREFIX,
  ownedStreams: ['trade'],
});
const feeSchedule = parseFeeScheduleJson(env.TRADE_FEE_SCHEDULE);
const app = Fastify({ logger: { level: env.LOG_LEVEL }, maxParamLength: 5_000 });
retainRawBody(app);
registerClosureCheck(app, { sql, secret: env.INTERNAL_SERVICE_SECRET, s2s: doorS2s });
// Matching's depth read carries no timestamp, so the read time is the observation time: the book was read from the
// live engine at this moment. A stale, one-sided or thin book still gives no mark.
const trailingMarkSource = markSourceFromDepth(async (marketId) => ({
  ...(await matching.depth(marketId, 1)),
  observedAt: new Date(),
}));
// Trailing stops are placed only on the markets the pump walks, and only while it runs: a stop on any other market
// would never move. Anything else has no mark, and placing refuses `trade.missing_mark`.
const trailingMarketIds = new Set(parseCandleMarketIds(env.TRADE_TRAILING_MARK_JOBS_MARKET_IDS));
const trailingPlacementMarkSource: QuotedMarkSource | undefined =
  env.TRADE_TRAILING_MARK_JOBS_ENABLED && env.TRADE_TRAILING_MARK_JOBS_INTERVAL_MS
    ? {
        ...trailingMarkSource,
        quote: async (input) => (trailingMarketIds.has(input.marketId) ? trailingMarkSource.quote(input) : null),
      }
    : undefined;
const trade = new TradeService(sql, ledger, matching, perks, bus, {
  trailingMarkSource: trailingPlacementMarkSource,
  accountAdmission: tradingControls,
  marketLifecycle,
  spotEnabled: env.TRADE_SPOT_ENABLED,
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
  futuresTestSeed: env.TRADE_FUTURES_TEST_SEED,
  optionsSettlementAssetLaw: env.TRADE_OPTIONS_SETTLEMENT_ASSET_LAW,
  optionsSettlementFixing: env.TRADE_OPTIONS_SETTLEMENT_FIXING,
  futuresSettlementFixing: env.TRADE_FUTURES_SETTLEMENT_FIXING,
  futuresSettleAssets: parseConfiguredSettleAssets(env.TRADE_FUTURES_SETTLE_ASSETS),
  marketSlippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
  convertEnabled: env.TRADE_CONVERT_ENABLED,
  standingInstructionsEnabled: env.TRADE_STANDING_INSTRUCTION_ENABLED,
  convertSpreadBps: env.TRADE_CONVERT_SPREAD_BPS,
  convertQuoteTtlMs: env.TRADE_CONVERT_QUOTE_TTL_MS,
  algoEnabled: env.TRADE_ALGO_ENABLED,
  algoJobsEnabled: env.TRADE_ALGO_JOBS_ENABLED,
  algoJobsIntervalMs: env.TRADE_ALGO_JOBS_INTERVAL_MS,
  seedPlaceEnabled: env.TRADE_MM_SEED_ENABLED,
  feeSchedule,
  subAccounts,
  affiliateAccrue,
  affiliatePayout,
  dropCopyIngest,
  holdUnknownTakerMaxAgeMs: env.TRADE_HOLD_UNKNOWN_TAKER_MAX_AGE_MS,
  onHoldUnknownAlert: (a) => app.log.error({ alert: a }, 'order.hold reply lost'),
});
const subscriptions = await subscribeMatchingEvents(bus, trade);
const venuePublicAdapter = createVenueMarketDataAdapter(env.TRADE_VENUE_MARK_VENUE);
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
const otcDeskLaw = parseOtcDeskLawJson(env.TRADE_OTC_DESK_LAW);
const otcStakes = createOtcStakeSource(env.TOKEN_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
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
  accountAdmission: tradingControls,
  law: otcDeskLaw,
  midSource: otcMidBuilt.source,
  liveObservationFeed: otcMidBuilt.liveObservationFeed,
  midFeedWiring: otcMidFeedWiring,
  store: new SqlOtcQuoteStore(sql),
  makerDirectory: parseOtcMakerDirectoryJson(env.TRADE_OTC_MAKER_DIRECTORY),
});
const copyFeeShareLaw = parseCopyFeeShareLawJson(env.TRADE_COPY_FEE_SHARE_LAW);
const copyJurisdictionLaw = parseCopyJurisdictionLawJson(env.TRADE_COPY_JURISDICTION_LAW);
const copyDisclosureLaw = parseCopyDisclosureLawJson(env.TRADE_COPY_DISCLOSURE_LAW);
const copyStore = new SqlCopyFollowStore(sql);
const placeFollowerOrder: PlaceFollowerOrderPort = async (principal, input) => {
  if (!input.followId) throw new TradingControlError('auth.credential_denied');
  const order = await trade.placeCopyMirror(
    principal,
    {
      symbol: input.symbol,
      marketId: input.marketId,
      side: input.side,
      type: 'limit',
      qty: input.qty,
      price: input.price,
      tif: 'GTC',
      clientOrderId: input.clientOrderId,
    },
    input.followId,
  );
  return { orderId: order.id };
};
const copy = new CopyService(ledger, {
  accountAdmission: tradingControls,
  feeShareLaw: copyFeeShareLaw,
  jurisdictionLaw: copyJurisdictionLaw,
  disclosureLaw: copyDisclosureLaw,
  store: copyStore,
  directory: sqlLeaderDirectory(sql, { now: () => new Date(), feeShareLaw: copyFeeShareLaw }),
  placeFollowerOrder,
  flattenCopyPosition: createFollowerFlattenPort({
    sql,
    ledger,
    store: copyStore,
    placeFollowerOrder,
    slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
    loadMarket: (symbol) => trade.marketBySymbol(symbol),
    bestBid: async (marketId) => {
      const depth = await matching.depth(marketId, 1);
      const best = depth.bids[0];
      return best ? parseAmount(best[0]) : null;
    },
  }),
  inspectMarket: async (symbol) => {
    const market = await trade.marketBySymbol(symbol);
    return market ? { paper: market.paper } : null;
  },
  lookupFollowerFillFee: async (fillId) => {
    const id = canonicalizeCopyFillId(fillId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      return null;
    }
    const [row] = await sql<
      Array<{ id: string; user_id: string; fee_asset: string; fee_amount: string; created_at: Date }>
    >`SELECT id, user_id, fee_asset, fee_amount, created_at FROM trade.fills WHERE id = ${id} LIMIT 1`;
    if (!row) return null;
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    return { fillId: row.id, userId: row.user_id, feeAsset: row.fee_asset, feeAmount: parseAmount(row.fee_amount), createdAt };
  },
  sql,
  mirrorEvents: new SqlMirrorEventLog(sql),
  lookupMark: async (marketId) => {
    const depth = await matching.depth(marketId, 1);
    const bid = depth.bids[0] ? parseAmount(depth.bids[0][0]) : null;
    const ask = depth.asks[0] ? parseAmount(depth.asks[0][0]) : null;
    if (bid === null || ask === null || bid <= 0n || ask <= 0n) return null;
    return { marketId, price: (bid + ask) / 2n, asOf: new Date(), quality: 'mid' as const };
  },
  lookupLeaderFill: async (fillId) => {
    const id = canonicalizeCopyFillId(fillId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      return null;
    }
    const [row] = await sql<
      Array<{ id: string; user_id: string; side: 'buy' | 'sell'; qty: string; quote_amount: string; price: string; symbol: string }>
    >`
      SELECT f.id, f.user_id, f.side, f.qty, f.quote_amount, f.price, m.symbol
      FROM trade.fills f
      INNER JOIN trade.markets m ON m.id = f.market_id
      WHERE f.id = ${id}
      LIMIT 1
    `;
    if (!row) return null;
    if (row.side !== 'buy' && row.side !== 'sell') return null;
    return {
      fillId: row.id,
      userId: row.user_id,
      marketId: row.symbol,
      side: row.side,
      qty: parseAmount(row.qty),
      notional: parseAmount(row.quote_amount),
      price: parseAmount(row.price),
    };
  },
});
trade.bindCopyMirrorFill((notice) => copy.observeFollowerFill(notice));
const tradeOpsApprovals = currentTradingRestrictApprovals() ?? identityApprovalBook(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s);
export const appRouter = createTradeRouter(
  trade,
  otc,
  copy,
  tradingControls,
  wireTradeOpsAdmin({
    sql,
    trade,
    ledger,
    approvals: tradeOpsApprovals,
  }),
  new InsuranceTopupAdmin({ sql, ledger, approvals: tradeOpsApprovals }),
  new SupportTradeSummaryReader({ sql }),
);
export type AppRouter = typeof appRouter;
const edgeContext = createEdgeContext({
  secret: env.EDGE_PRINCIPAL_SECRET,
  ...edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  ...(doorS2s ? { serviceVerifier: doorS2s.verifier, s2sMode: doorS2s.mode } : {}),
  bodyBindMode: 'require',
});
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
  console.warn(
    `[svc-trade] TRADE_VENUE_MARK_VENUE=${env.TRADE_VENUE_MARK_VENUE.trim()} is not a known public MarketDataAdapter; venue mark off (never invent). Supported: binance-spot, bybit-spot, okx-spot`,
  );
}
const fundingMarketIds = parseFundingMarketIds(env.TRADE_FUTURES_FUNDING_MARKET_IDS);
const fundingMaxAbsRate = resolveFundingMaxAbsRateForBoot({ fundingMarketIds, maxAbsRateRaw: env.TRADE_FUTURES_FUNDING_MAX_ABS_RATE });
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
    fundingComputerPollMs: env.TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS,
    fundingMarketIds,
    fundingMaxAbsRate,
    settlementFixing: env.TRADE_FUTURES_SETTLEMENT_FIXING,
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'futures job tick failed'),
});
const profitSource = optionalProfitSourceFromConfig(env.TRADE_FUTURES_PROFIT_SOURCE);
const maxLeverage = parseConfiguredMaxLeverage(env.TRADE_FUTURES_MAX_LEVERAGE);
if (profitSource) {
  app.log.info({ profitSource: profitSource.configured }, 'futures realised profit is bounded by this account');
} else {
  app.log.warn(
    { variable: 'TRADE_FUTURES_PROFIT_SOURCE' },
    'FUTURES IS DISABLED: no account is named to fund realised profit, so opens are refused and no profit can be paid.',
  );
}
const adlDisclosureAcks = sqlAdlDisclosureStore(sql);
const adlDisclosureEvents = sqlAdlDisclosureEventStore(sql);
// D-account-07: no switch. Until the owner publishes an agreement text for the region and the eligibility rules,
// a futures open is refused with the typed reason.
const riskAgreements = sqlRiskAgreementStore(sql);
const derivativesEligibility = sqlEligibilityStore(sql);
const derivativesGate = derivativesAccessGate({ agreements: riskAgreements, eligibility: derivativesEligibility });
const positions = new PositionService(sql, ledger, {
  accountAdmission: tradingControls,
  marks: futuresJobs.marks,
  profitSource,
  bus,
  maxLeverage,
  // The same ladder the liquidation tick rates against: a withdrawal is refused when the ladder
  // would liquidate what is left. `policy` is unset until the owner publishes the D3 table.
  ladder: futuresJobs.ladderGate,
  assertDerivativesAccess: derivativesGate,
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
const conditionalJobsConfig = {
  enabled: env.TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED,
  intervalMs: env.TRADE_FUTURES_CONDITIONAL_JOBS_INTERVAL_MS,
};
const conditionalOrders = createConditionalOrderService({
  sql,
  triggerScheduled: conditionalTriggerScheduled(conditionalJobsConfig),
  publishedMark: async (marketId, symbol) => {
    const mark = await futuresJobs.publicMark(marketId, symbol);
    return mark?.price ?? null;
  },
  closeQuantity: (userId, positionId, input) => positions.closeQuantity(userId, positionId, input),
  placeLimit: refuseFuturesRestingLimit,
});
const conditionalJobs = startConditionalOrderJobs({
  config: conditionalJobsConfig,
  evaluate: () => conditionalOrders.evaluate({ enabled: true }),
  onError: (name, err) => app.log.error({ err, job: name }, 'futures conditional job tick failed'),
});
const candleJobs = startCandleJobs({
  sql,
  config: {
    enabled: env.TRADE_CANDLE_JOBS_ENABLED,
    intervalMs: env.TRADE_CANDLE_JOBS_INTERVAL_MS,
    marketIds: parseCandleMarketIds(env.TRADE_CANDLE_JOBS_MARKET_IDS),
    timeframes: parseCandleTimeframes(env.TRADE_CANDLE_JOBS_TIMEFRAMES),
    limit: env.TRADE_CANDLE_JOBS_LIMIT,
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
const trailingMarkJobs = startTrailingMarkJobs({
  config: {
    enabled: env.TRADE_TRAILING_MARK_JOBS_ENABLED,
    intervalMs: env.TRADE_TRAILING_MARK_JOBS_INTERVAL_MS,
    marketIds: parseCandleMarketIds(env.TRADE_TRAILING_MARK_JOBS_MARKET_IDS),
  },
  source: trailingMarkSource,
  postMark: (marketId, mark) => matching.markTrailingStops(marketId, mark),
  onError: (name, err) => app.log.error({ err, job: name }, 'trailing mark tick failed'),
  onResult: (r) => {
    if (r.applied) app.log.info({ marketId: r.marketId }, 'trailing stops walked with the mark');
  },
});
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
  operatorSeedAllows: (marketId) => readOperatorSeedAllows(sql, marketId),
  recordSeededOrder: async (row) => {
    await sql`INSERT INTO trade.orders (id, user_id, market_id, side, type, price, qty, status, tif, hold_asset, hold_amount, fee_discount_bps, seeded, lifecycle_proof, session_id, api_key_id) VALUES (${row.orderId}, ${HOUSE_MM_USER_UUID}, ${row.marketId}, ${row.side}, ${'limit'}, ${row.price}::numeric, ${row.qty}::numeric, ${'open'}, ${'PO'}, ${row.holdAsset}, ${row.holdAmount}::numeric, ${0}, ${true}, ${JSON.stringify(row.lifecycleProof)}::text::jsonb, ${null}, ${HOUSE_MM_API_KEY_ID}) ON CONFLICT (id) DO NOTHING`;
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
const algoJobs = startAlgoJobs({
  trade,
  config: { enabled: env.TRADE_ALGO_JOBS_ENABLED, intervalMs: env.TRADE_ALGO_JOBS_INTERVAL_MS },
  recordHeartbeat: () => recordSchedulerHeartbeat(sql, schedulerInstanceId(), new Date()),
  onError: (name, err) => app.log.error({ err, job: name }, 'algo job tick failed'),
});
const optionsExerciseJobs = startOptionsExerciseJobs({
  sql,
  ledger,
  config: {
    enabled: env.TRADE_OPTIONS_JOBS_ENABLED,
    intervalMs: env.TRADE_OPTIONS_JOBS_INTERVAL_MS,
    settlementAssetLaw: env.TRADE_OPTIONS_SETTLEMENT_ASSET_LAW,
    settlementFixing: env.TRADE_OPTIONS_SETTLEMENT_FIXING,
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'options exercise job tick failed'),
});
const holdUnknownSweep = startHoldUnknownSweepJobs({
  trade,
  config: {
    enabled: env.TRADE_HOLD_UNKNOWN_SWEEP_ENABLED,
    intervalMs: env.TRADE_HOLD_UNKNOWN_SWEEP_INTERVAL_MS,
    cancelAllAfterIntervalMs: env.TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS,
  },
  onError: (name, err) => app.log.error({ err, job: name }, 'hold-unknown sweep tick failed'),
  onCancelAllAfterAlert: (r) =>
    app.log.error(r, 'cancel-all-after sweep — a countdown could not cancel (unresolved cancel, or its stored authority lapsed)'),
  onBracketAlert: (r) => app.log.error(r, 'bracket exit sweep — a filled entry has no exit (grant gone) or an exit could not be placed'),
  onResult: (r) => {
    if (r.alerts.length === 0) return;
    app.log.error(
      {
        examined: r.examined,
        booked: r.booked,
        absent: r.absent,
        stillUnknown: r.stillUnknown,
        alerts: r.alerts,
      },
      'hold-unknown sweep — order.hold reply was lost',
    );
  },
});
const reconcileJobs = startEngineLedgerReconcileJobs({
  sql,
  ledger,
  matching,
  config: { enabled: env.TRADE_RECONCILE_JOBS_ENABLED, intervalMs: env.TRADE_RECONCILE_JOBS_INTERVAL_MS },
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
        'engine-ledger market-id DRIFT',
      );
    }
    if (r.plan.refusals.length > 0) {
      app.log.warn({ checked: r.report.checked, refusals: r.plan.refusals.length }, 'engine-ledger reconcile REFUSE');
    }
    if (r.deleted.length > 0) {
      app.log.info({ deleted: r.deleted }, 'engine-ledger reconcile auto-deleted unfunded pending');
    }
  },
});
app.get('/health', async () => ({
  ok: true,
  service: env.SERVICE_NAME,
  venueLatency: presentVenueLatencyHealth(venuePublicAdapter, new Date(), { streamEnabled: env.TRADE_VENUE_MARK_STREAM }),
  mmSeed: presentMmSeedHealth({ enabled: env.TRADE_MM_SEED_ENABLED, targetCount: mmSeedTargets.length }),
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
  const sequences = await checkEngineSequences({
    sql,
    markets: () => trade.markets(MARKETS_LIMIT_MAX),
    // Null only for a positively missing book; an outage or malformed reply throws and is reported unavailable.
    engineSequence: (marketId) => probeEngineSequence((id) => matching.depth(id, 1), marketId),
  });
  if (sequences.regressions.length > 0) {
    const reason = describeRegressions(sequences.regressions);
    app.log.error({ regressions: sequences.regressions, unavailable: sequences.unavailable }, reason);
    return reply.code(503).send({
      ready: false,
      reason,
      markets: sequences.regressions.map((r) => r.symbol),
      unavailable: sequences.unavailable.map((u) => u.symbol),
    });
  }
  if (sequences.unavailable.length > 0) {
    const reason = describeUnavailable(sequences.unavailable);
    app.log.warn({ unavailable: sequences.unavailable }, reason);
    return reply.code(503).send({ ready: false, reason, markets: sequences.unavailable.map((u) => u.symbol) });
  }
  return { ready: true, engineSequences: { checked: sequences.checked, unjudged: sequences.unjudged } };
});
registerPublicRest(app, {
  markets: (limit) => trade.markets(limit),
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  depth: (marketId, limit) => matching.depth(marketId, limit),
  publicTape: (marketId, limit, sinceMs) => trade.publicTape(marketId, limit, sinceMs),
  candles: (marketId, timeframe, limit, sinceMs) => trade.candles(marketId, timeframe, limit, sinceMs),
  tickerStats: createTickerStatsReader(sql, { ttlMs: 3000 }),
  lifecycleForMarket: (market) => trade.marketLifecycleSnapshot(market),
  fundingRateForMarket: async (marketId, _symbol) => {
    const entry = futuresJobs.getPublishedRate(marketId);
    if (!entry) return null;
    return {
      fundingRate: entry.rate,
      fundingTimestamp: entry.asOfMs,
      fundingDatetime: new Date(entry.asOfMs).toISOString(),
      nextFundingTimestamp: null,
      markPrice: await futuresJobs.markPrice(marketId),
      indexPrice: null,
    };
  },
  futuresTestSeed: env.TRADE_FUTURES_TEST_SEED,
  algo: { createEnabled: env.TRADE_ALGO_ENABLED, jobsEnabled: env.TRADE_ALGO_JOBS_ENABLED },
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
registerConditionalOrdersRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  orders: conditionalOrders,
});
registerFuturesTickerRest(app, {
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  markForMarket: (marketId, symbol) => futuresJobs.publicMark(marketId, symbol),
  fundingForMarket: (marketId) => futuresJobs.getPublishedRate(marketId),
  factsForMarket: (marketId, nowMs) => readFuturesTickerFacts(sql, marketId, new Date(nowMs)),
});
registerPositionPreviewRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  markForMarket: (marketId, symbol) => futuresJobs.publicMark(marketId, symbol),
  leverageCap: maxLeverage,
});
registerGreeksWhatIfRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
});
registerDeltaHedgeRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  target: env.TRADE_DELTA_HEDGE_TARGET,
  range: env.TRADE_DELTA_HEDGE_RANGE,
  instrument: env.TRADE_DELTA_HEDGE_INSTRUMENT,
});
registerQuantLiveDeployRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  pin: env.TRADE_QUANT_LIVE_DEPLOY_PIN,
});
registerPromoRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  budget: env.TRADE_PROMO_BUDGET,
  end: env.TRADE_PROMO_END,
});
registerSpotOrderPreviewRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  now: () => new Date(),
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  marketLifecycle,
  stopLimitEnabled: true,
  bestAsk: async (marketId) => {
    const depth = await matching.depth(marketId, 1);
    const best = depth.asks[0];
    return best ? parseAmount(best[0]) : null;
  },
  bestBid: async (marketId) => {
    const depth = await matching.depth(marketId, 1);
    const best = depth.bids[0];
    return best ? parseAmount(best[0]) : null;
  },
  spotEnabled: env.TRADE_SPOT_ENABLED,
  futuresEnabled: env.TRADE_FUTURES_ENABLED,
  optionsSettlementLawStamped: env.TRADE_OPTIONS_SETTLEMENT_ASSET_LAW.trim().length > 0,
  slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
  feeSchedule,
  feeScheduleNow: () => feeScheduleAt(sql, feeSchedule, new Date()),
  feeDiscountBps: async (userId) => (await perks.perksOf(userId)).feeDiscountBps,
});
const fundingHistory = memoryFundingHistory();
registerInternalFundingRate(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  publishFundingRate: (entry) => futuresJobs.publishFundingRate(entry),
  recordFundingHistory: (row) => fundingHistory.record(row),
  maxAbsRate: fundingMaxAbsRate,
  installRawBody: false,
  approvals: currentTradingRestrictApprovals() ?? identityApprovalBook(env.IDENTITY_URL, env.INTERNAL_SERVICE_SECRET, outS2s),
});
registerFundingHistory(app, {
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  historyForMarket: async (marketId) => fundingHistory.list(marketId),
});
registerMarketLifecycleRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  store: marketLifecycleStore,
  installRawBody: false,
});
const copyLeaderFixturesStore = createCopyLeaderFixturesStore(sql);
registerCopyLeaderFixturesRoutes(app, {
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  store: copyLeaderFixturesStore,
  bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
  installRawBody: false,
});
registerOutcomesRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  s2s: doorS2s,
  installRawBody: false,
  catalogue: memoryOutcomeCatalogue([]),
});
installGtdGttPlace(TradeService);
installReduceOnlyPlace(TradeService);
attachBoundClosePosition(app);
installPostOnlyPlace(TradeService);
installIocPlace(TradeService);
installFokPlace(TradeService);
installIcebergPlace(TradeService);
installStopLimitPlace(TradeService);
installTrailingStopPlace(TradeService);
installOptionPlace(TradeService);
installMinQtyPlace(TradeService);
installAonPlace(TradeService);
installPegPlace(TradeService);
installAuctionPlace(TradeService);
installSelfTradePlace(TradeService);
installMarketHaltPlace(TradeService);
installVenueHaltPlace(TradeService);
installMarketReduceOnlyPlace(TradeService);
installMarketPostOnlyPlace(TradeService);
installMarketPrelaunchPlace(TradeService);
installMarketExpiredPlace(TradeService);
installMarketDelistedPlace(TradeService);
installCollarPlace(TradeService);
installComboPlace(TradeService);
registerPrivateRest(app, {
  edgeSecret: env.EDGE_PRINCIPAL_SECRET,
  edgeTrust: edgeTrustFromEnv(env),
  serviceName: env.SERVICE_NAME,
  openOrders: (principal, marketId, limit) => trade.openOrders(principal, marketId, limit),
  adminOpenOrders: (principal, limit) => trade.adminOpenOrders(principal, limit),
  orderHistory: (principal, input) => trade.orderHistory(principal, input),
  getOrder: (principal, orderId) => trade.getOrder(principal, orderId),
  orderAmendments: (principal, orderId) => trade.orderAmendments(principal, orderId),
  placeOrder: (principal, input) =>
    trade.placeOrder(
      principal,
      bindCombo(
        bindCollar(
          bindAuction(
            bindPeg(
              bindAon(
                bindMinQty(
                  bindOption(
                    bindTrailingStop(bindStopLimit(bindIceberg(bindFok(bindIoc(bindPostOnly(bindReduceOnly(bindExpireAt(input)))))))),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  cancelOrder: (principal, orderId) => trade.cancelOrder(principal, orderId),
  replaceOrder: (principal, orderId, input) => trade.replaceOrder(principal, orderId, input),
  amendOrder: (principal, orderId, input) => trade.amendOrder(principal, orderId, input),
  cancelAllOrders: (principal, marketId) => trade.cancelAllOrders(principal, marketId),
  armCancelAllAfter: (principal, timeoutSec) =>
    (trade as unknown as CancelAllAfterHost).armCancelAllAfter(
      principal,
      timeoutSec,
      env.TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC,
      env.TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS * 3,
    ),
  massCancelOrders: (principal, marketId) => trade.massCancelOrders(principal, marketId),
  myFills: (principal, limit, marketId, sinceMs) => trade.myFills(principal, limit, marketId, sinceMs),
  marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
  marketById: (marketId) => trade.marketById(marketId),
  markets: (limit) => trade.markets(limit),
  feeSchedule,
  feeScheduleNow: () => feeScheduleAt(sql, feeSchedule, new Date()),
  now: () => new Date(),
  lifecycleForMarket: (market) => trade.marketLifecycleSnapshot(market),
  userBalances: (userId) => ledger.balances('user', userId),
  listPositions: (principal, symbol, clientOpenId) => positions.listOpen(principal.userId, symbol, clientOpenId),
  listClosedPositions: (principal, input) => positions.listClosed(principal.userId, input),
  getPosition: (principal, positionId) => positions.get(principal.userId, positionId),
  openPosition: (principal, input) =>
    positions.open(
      {
        userId: principal.userId,
        symbol: input.symbol,
        side: input.side,
        size: parseAmount(input.size),
        leverage: parseAmount(input.leverage),
        marginMode: input.marginMode,
        collateralClass: input.collateralClass,
        clientOpenId: input.clientOpenId,
        ...(input.reduceOnly ? { reduceOnly: true as const } : {}),
        ...(input.positionMode ? { positionMode: input.positionMode } : {}),
      },
      principal,
      { region: input.region ?? null },
    ),
  closePosition: (principal, positionId) => positions.close(principal.userId, positionId),
  marginModeAudit: sqlMarginModeSwitchAudit(sql),
  closePositionQuantity: (principal, positionId, input) =>
    positions.closeQuantity(principal.userId, positionId, {
      quantity: parseAmount(input.quantity),
      clientCloseId: input.clientCloseId,
    }),
  closeAllPositions: (principal, input) => positions.closeAll(principal.userId, input),
  marginSummary: (principal) => positions.marginSummary(principal.userId),
  readAccountMode: (principal) => positions.readAccountMode(principal.userId),
  writeAccountMode: (principal, input) => positions.writeAccountMode(principal.userId, input),
  setLeverage: (principal, input) =>
    positions.setLeverage(
      {
        userId: principal.userId,
        symbol: input.symbol,
        leverage: parseAmount(input.leverage),
        positionId: input.positionId,
        clientAdjustmentId: input.clientAdjustmentId,
      },
      principal,
    ),
  addIsolatedMargin: (principal, input) =>
    positions.addIsolatedMargin({
      userId: principal.userId,
      symbol: input.symbol,
      amount: parseAmount(input.amount),
      positionId: input.positionId,
      clientAdjustmentId: input.clientAdjustmentId,
      collateralClass: input.collateralClass,
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
  ackAdlDisclosure: async (principal) =>
    presentAdlDisclosureWire(await adlDisclosureAcks.recordAck(principal.userId, ADL_DISCLOSURE_VERSION, new Date())),
  getAgreements: async (principal, region) =>
    Promise.all(AGREEMENT_KINDS.map((kind) => readAgreementView(riskAgreements, principal.userId, kind, region))),
  acceptAgreement: async (principal, input) => acceptAgreement(riskAgreements, { userId: principal.userId, ...input, now: new Date() }),
  getDerivativesEligibility: async (principal) => {
    const state = await readEligibilityState(derivativesEligibility, principal.userId, principal.tier);
    const rules = await derivativesEligibility.currentRules();
    return { state, questions: rules ? presentQuestions(rules) : null };
  },
  assessDerivativesEligibility: async (principal, input) =>
    assessEligibility(derivativesEligibility, {
      userId: principal.userId,
      submissionId: input.clientSubmissionId,
      answers: input.answers,
      now: new Date(),
    }),
  listAdlDisclosureEvents: async (principal, limit) =>
    (await adlDisclosureEvents.listForUser(principal.userId, limit)).map(presentAdlActionDisclosureWire),
  convertExport: (principal, query) => trade.convertExport(principal, query),
  copyExport: (principal, query) => copy.exportMirrorTrail(principal, query),
  rfqExport: (principal, query) => trade.rfqExport(principal, query),
  icebergDisplay: sqlIcebergDisplay(sql),
  stopTriggers: sqlStopTrigger(sql),
  ocoExits: (ids) => readOcoIntents(sql, ids),
  findClientOrder: (principal, input) => trade.findClientOrder(principal, input),
  listFundingPayments: (principal, positionId, cursor) => listFundingPayments(sql, principal.userId, positionId, cursor),
  listLiquidations: (principal) => listCallerLiquidations(sql, principal.userId),
  listFuturesPayouts: async (principal) => ({ payouts: await listPayoutsForUser(sql, principal.userId) }),
});
await app.register(fastifyTRPCPlugin, {
  prefix: '/trpc',
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }) => edgeContext(req),
    onError: ({ path, type, error }) => logTrpcServerFault(app.log, { path, type, error }),
  } satisfies FastifyTRPCPluginOptions<TradeRouter>['trpcOptions'],
});
await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info(
  {
    port: env.HTTP_PORT,
    spotEnabled: env.TRADE_SPOT_ENABLED,
    futuresEnabled: env.TRADE_FUTURES_ENABLED,
    futuresJobsEnabled: env.TRADE_FUTURES_JOBS_ENABLED,
    conditionalJobsEnabled: env.TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED,
    futuresJobs: futuresJobs.host.list(),
    venueMark: venueMarkConfigured ? { configured: true, symbolCount: venueMarkConfigured.symbolCount } : null,
    candleJobsEnabled: env.TRADE_CANDLE_JOBS_ENABLED,
    candleJobs: candleJobs.host.list(),
    trailingMarkJobsEnabled: env.TRADE_TRAILING_MARK_JOBS_ENABLED,
    trailingMarkJobs: trailingMarkJobs.host.list(),
    mmSeedEnabled: env.TRADE_MM_SEED_ENABLED,
    mmSeedJobs: mmSeedJobs.host.list(),
    algoJobsEnabled: env.TRADE_ALGO_JOBS_ENABLED,
    algoJobs: algoJobs.host.list(),
    optionsJobsEnabled: env.TRADE_OPTIONS_JOBS_ENABLED,
    optionsJobs: optionsExerciseJobs.host.list(),
    reconcileJobsEnabled: env.TRADE_RECONCILE_JOBS_ENABLED,
    reconcileJobs: reconcileJobs.host.list(),
    holdUnknownSweepEnabled: env.TRADE_HOLD_UNKNOWN_SWEEP_ENABLED,
    holdUnknownSweep: holdUnknownSweep.host.list(),
    trpc: true,
  },
  'svc-trade ready',
);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      futuresJobs.stop();
      conditionalJobs.stop();
      candleJobs.stop();
      trailingMarkJobs.stop();
      mmSeedJobs.stop();
      algoJobs.stop();
      optionsExerciseJobs.stop();
      reconcileJobs.stop();
      holdUnknownSweep.stop();
      await Promise.all([...venueMaintainedBooks.values()].map((b) => b.close()));
      await app.close();
      for (const subscription of subscriptions) await subscription.unsubscribe();
      await bus.close();
      await sql.end({ timeout: 5 });
      process.exit(0);
    })();
  });
}
