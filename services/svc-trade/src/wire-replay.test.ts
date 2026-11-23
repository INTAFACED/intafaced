import Fastify from 'fastify';
import type { AnyRouter } from '@trpc/server';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCOPES, type Principal, type Scope } from '@intafaced/auth';
import { z } from 'zod';
import {
  createEdgeContext,
  createIdentityOperationDecisionClient,
  createStepUpCheck,
  encodePrincipal,
  procedureCallers,
  retainRawBody,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { edgeTrustFromEnv } from '@intafaced/config';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { MaintainedBook } from '@intafaced/venue-adapter';
import { isTestVenue, VenueRefusalError } from '@intafaced/venue-contracts';
import { testAgeDoorOpen } from '@intafaced/service-kit';
import { env } from './env.js';
import { loadBotVerificationPolicy } from './algo/bots-verification.js';
import { TradingControls, TradingControlError } from './controls/trading-controls.js';
import { MARKETS_LIMIT_MAX, TradeService } from './spot/trade-service.js';
import { bookHaltFromBoard, MatchingUnavailableError } from './spot/matching-client.js';
import { bindMatchingCloseS2s } from './spot/matching-close.js';
import { readOcoIntents } from './spot/oco-intent.js';
import { readOrderLinks } from './spot/order-links.js';
import { readOrderHolds } from './spot/order-holds.js';
import { createMarketMaintenanceReader } from './market-maintenance-read.js';
import { createTickerStatsReader } from './spot/ticker-stats.js';
import { createDropCopyIngestClient } from './spot/drop-copy-ingest.js';
import type { createMatchingClient } from './spot/matching-client.js';
import type { createRankPerksClient } from './spot/rank-perks.js';
import type { createEmailProofClient } from './spot/email-proof.js';
import type { createLedgerClient } from './ledger-client.js';
import type { createLiveTierClient } from './signals/live-tier.js';
import { VenueStatements } from './venue/venue-statements.js';
import { StatementExports } from './statements/statement-export.js';
import { registerClosureCheck } from './closure/closure-check.js';
import { registerTrackRecord } from './signals/track-record.js';
import { leadOrderGate, registerLeadCheck } from './copy/lead-api.js';
import { readSupportOrder, registerSupportOrderRead } from './support/order-read.js';
import { FUTURES_PRICE_BAND_UNSET, parsePriceBand, perpetualFeeRates } from './futures/matched-order-plan.js';
import { createTradeRouter } from './router.js';
import { LeadDesk, parseLeadMinVenueUsdc, parseLeadReapplyWait } from './copy/lead-applications.js';
import { parseLeadDailyBuyCap, parseLeadPairHolding } from './copy/lead-trading.js';
import { leadFollowing, leadVenueUsdc } from './copy/lead-conditions.js';
import { SignalDesk, parseSignalMaxAge, parseSignalWebhookDays } from './signals/signal-desk.js';
import { registerSignalIntake } from './signals/intake-rest.js';
import { PlatformPauseDesk } from './copy/platform-pauses.js';
import { bindTradingRestrictApprovals, currentTradingRestrictApprovals } from './admin/trading-restrict.js';
import { wireTradeOpsAdmin } from './admin/wire.js';
import { parseMetricsWindowSeconds } from './admin/copy-bots-otc.js';
import { parseSweepEnabled, parseSweepLimit, parseSweepMinAgeSeconds } from './admin/bust.js';
import { chartOwnerValuesPublicReader, readChartScalars } from './admin/chart-owner-values.js';
import { chartFeedCandleGate, parseExportRowLimit, parseFallbackSources } from './admin/chart-feed-controls.js';
import { readQueuePosition } from './spot/queue-position.js';
import { InsuranceTopupAdmin } from './admin/insurance-topup.js';
import { SupportTradeSummaryReader } from './support/trade-summary.js';
import { orderableForListedMarket, registerPublicRest } from './public-rest.js';
import { readGatedList } from './futures/gated-list.js';
import { registerFuturesTickerRest } from './futures/futures-ticker-rest.js';
import {
  conditionalTriggerScheduled,
  createConditionalOrderService,
  registerConditionalOrdersRest,
  refuseFuturesRestingLimit,
} from './futures/conditional-orders/index.js';
import { createRiskStopService } from './futures/risk-stop.js';
import { registerRiskStopRest } from './futures/risk-stop-rest.js';
import { createReverseService } from './futures/reverse.js';
import { listCallerLiquidations, listFundingPayments, loadPositionLiquidation, readFuturesTickerFacts } from './futures/futures-reads.js';
import { listFuturesExecutions } from './futures/futures-executions.js';
import { listPayoutsForUser } from './futures/futures-payouts.js';
import { presentAccountFees, registerPrivateRest } from './private-rest.js';
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
import { resolveAdmissionLimits } from './futures/pretrade-limits.js';
import { registerGreeksWhatIfRest } from './greeks/what-if-rest.js';
import { registerDeltaHedgeRest } from './greeks/delta-hedge-rest.js';
import { registerQuantLiveDeployRest } from './quant/live-deploy-rest.js';
import { registerPromoRest } from './spot/promo-rest.js';
import { registerSpotOrderPreviewRest } from './spot/order-preview-rest.js';
import { registerFeeTierRest } from './spot/fee-tier-rest.js';
import { registerTierPassGrant } from './spot/tier-pass-internal.js';
import { registerVipRest } from './spot/vip-rest.js';
import { installRouteInventory } from './route-inventory.js';
import { SqlPreparedActionStore } from './venue/prepared-action-store.js';
import { UserVenueDoorError } from './venue/user-venue-door.js';
import { wireUserVenue } from './venue/wire.js';
import { wireVenueAgents } from './venue/agents-wire.js';
import { LiveRuns, parseLiveRunValues } from './quant/live-run/live-runs.js';
import { StrategyHaltDesk } from './quant/live-run/halts.js';
import { createQuantStrategySource } from './quant/live-run/ports.js';
import { SqlLiveRunStore } from './quant/live-run/sql-store.js';
import { VenueProtections } from './venue/protections.js';
import { SqlEngineProtectionStore } from './venue/protection-store.js';
import { VenueSpotConditionals } from './venue/spot-conditionals.js';
import { SqlSpotConditionalStore } from './venue/spot-conditional-store.js';
import { routingReport } from './venue/routing-report.js';
import { wireBuilderFees } from './builder-fee/wire.js';
import {
  parseDataTerms,
  parseDeveloperHosts,
  parseRegionalRule,
  parseBotPolicy,
  parseDeveloperStreamHosts,
  registerDeveloperPortalRest,
} from './developer-portal-rest.js';
import { VipApplicationStore, parseVipProofKey } from './spot/vip-applications.js';
import { assertMakerRebatesPayable, parseFeeScheduleJson } from './spot/fee-schedule.js';
import { feeScheduleAt } from './spot/fee-schedule-store.js';
import { feeTierAt } from './spot/fee-tier-store.js';
import { PositionService } from './futures/position-service.js';
import { readOpenInterestLimits } from './futures/open-interest-limits.js';
import {
  bandInForce,
  readPriceRangeSettings,
  sqlPriceBandStore,
  staticBandInForce,
  type BandInForce,
} from './futures/dynamic-price-band.js';
import { sqlVenueAdlAcks } from './venue/venue-adl-acks.js';
import { ADL_DISCLOSURE_VERSION, presentAdlDisclosureWire, sqlAdlDisclosureStore } from './futures/adl-disclosure.js';
import { presentAdlActionDisclosureWire, sqlAdlDisclosureEventStore } from './futures/adl-last-resort.js';
import { derivativesAccessGate } from './futures/derivatives-access.js';
import { sqlEligibilityStore } from './futures/derivatives-eligibility.js';
import { assertOperatorRiskOnPlace, currentRisk, currentRiskForMarkets, operatorSlippageCapBps } from './admin/risk.js';
import { presentPairRisk } from './spot/pair-rules.js';
import { optionalProfitSourceFromConfig } from './futures/profit-source.js';
import { parseConfiguredMaxLeverage } from './futures/initial-margin.js';
import { parseConfiguredSettleAssets } from './futures/contract-family.js';
import { parseFundingMarketIds, startFuturesJobs } from './futures/futures-jobs.js';
import type { MatchedLiquidationPort } from './futures/matched-liquidation.js';
import { presentMarginCallWire } from './futures/margin-call-transport.js';
import { createConfiguredVenueMarkSource, createVenueMarketDataAdapter, parseVenueMarkSymbols } from './futures/mark-from-venue.js';
import { presentVenueLatencyHealth } from './futures/venue-latency-health.js';
import { presentInsuranceListingPolicy } from './futures/insurance-listing-gate.js';
import { presentFuturesJobsHealth } from './futures/futures-jobs-health.js';
import { sqlMarginModeSwitchAudit } from './futures/margin-mode.js';
import { registerInternalFundingRate } from './futures/internal-funding-rate.js';
import { writeOperatorAudit } from './admin/common.js';
import { loadLiquidationFeeFraction } from './futures/liquidation-fee.js';
import { memoryFundingHistory, registerFundingHistory } from './futures/funding-history.js';
import { createCopyLeaderFixturesStore } from './agents/copy-leader-fixtures-store.js';
import { registerCopyLeaderFixturesRoutes } from './agents/copy-leader-fixtures-routes.js';
import { resolveFundingMaxAbsRateForBoot } from './futures/funding-rate-bound.js';
import { parseMmSeedTargets } from './mm/seed-jobs.js';
import { presentMmSeedHealth } from './mm/seed-health.js';
import { parseCandleMarketIds } from './spot/candles.js';
import { markSourceFromDepth } from './futures/mark-from-depth.js';
import { markBookResolver, parseIndexSpotMarkets } from './futures/mark-from-spot-index.js';
import { liquidationPriceFor } from './futures/liquidation-price.js';
import { registerRiskCalculatorRest } from './futures/risk-calculator-rest.js';
import { registerCollateralRest } from './futures/collateral-rest.js';
import { ownerLadderPolicy } from './futures/futures-ladder-owner-gate.js';
import { publishedLiquidationLimitsFrom } from './futures/liquidation-limits.js';
import type { QuotedMarkSource } from './futures/liquidation-tick.js';
import type { CancelAllAfterHost } from './spot/cancel-all-after.js';
import './spot/cancel-all-after.js';
import { checkEngineSequences, describeRegressions, describeUnavailable, probeEngineSequence } from './spot/sequence-guard.js';
import { parseOtcDeskLawJson } from './otc/desk-law.js';
import { createOtcMidSourceFromConfig } from './otc/venue-mid-source.js';
import { describeOtcMidFeedWiring } from './otc/mid-feed.js';
import { OtcDeskService } from './otc/otc-service.js';
import { loadOtcMakerDirectory } from './otc/maker-directory.js';
import { NO_OTC_CONVERT_BOUNDS, parseOtcConvertBoundsJson } from './otc/otc-convert-bounds.js';
import { SqlOtcQuoteStore } from './otc/quote-store.js';
import { canonicalizeCopyFillId } from './copy/fee-share.js';
import { parseCopyFeeShareLawJson, parseCopyJurisdictionLawJson } from './copy/fee-share-law.js';
import { parseCopyMetricDefinitionsJson } from './copy/leader-profile.js';
import { parseCopyMinTier } from './copy/follow-gate.js';
import { parseCopyMinInvestment, parseCopyOwnerDay } from './copy/follow-rules.js';
import { CopyService } from './copy/copy-service.js';
import { freeSpotBalance } from './copy/follow-gate.js';
import { GridService } from './grid/grid-service.js';
import { loadGridPolicy } from './grid/policy.js';
import { SqlGridStore } from './grid/store.js';
import { SqlCopyFollowStore } from './copy/follow-store.js';
import { SqlMirrorEventLog } from './copy/mirror-events.js';
import { sqlLeaderDirectory } from './copy/leader-directory.js';
import { createCopyClosePort } from './copy/copy-close.js';
import { createFollowerFlattenPort } from './copy/follower-flatten-port.js';
import { sqlCopiedPositions } from './copy/copied-positions.js';
import { VenueCopy, SqlVenueFollowStore, isVenueLeaderFillId, sqlPlacedMirrors } from './copy/venue-copy.js';
import type { PlaceFollowerOrderPort } from './copy/auto-mirror-place.js';
import { SqlMarketLifecycleAuthority, SqlMarketLifecycleEvidenceStore } from './market-lifecycle.js';
import { registerBuybackDoor } from './spot/buyback-door.js';
import { registerMarketLifecycleRoutes } from './market-lifecycle-routes.js';
import { localTestTapeRetimeEnabled } from './spot/local-test-tape.js';
import { registerLocalTestTapeRoutes } from './spot/local-test-tape-routes.js';
import { ageOtcQuote, registerTestAgeDoor } from './test-age-door.js';
import { logTrpcServerFault } from './trpc-error-log.js';

/**
 * The wire replay for svc-trade: every trade call's current answer, recorded before anyone moves its callers.
 *
 * `wire-replay.golden/` holds what svc-trade answered (main 2026-11-19, as it is, bugs included) to a matrix of
 * requests: every tRPC procedure of the router `index.ts` mounts and every HTTP route `index.ts` registers, with six
 * inputs, five people and the signed services that call trade, sent through one Fastify app built the way `index.ts`
 * builds it (route inventory, raw body, the doors in their order, then the tRPC mount with its edge context). A later
 * move of these calls must answer each one byte for byte the same; a wrong scope, a changed refusal code, a widened
 * input or a reshaped envelope shows here as a difference.
 *
 * No database, ledger, matching engine, bus, identity or token service: each is a recording stub that refuses any call
 * with its own name (`replay stub: <name>`), so the recording pins the boundary (who may call, what input is accepted,
 * how each refusal is shaped) and which dependency an accepted call reaches first. Every setting svc-trade reads is
 * blanked for the run (owner settings blank, as on a stack nobody configured), so a developer's shell can't change an
 * answer; the timers and jobs `index.ts` starts are not started, since none of them answers a request.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites the recording. Only for a change that is meant to change the wire, named in its PR.
 */

/**
 * Before any import reads the process: every setting `env.ts` and its shared schemas name, and every TRADE_ variable,
 * is removed; then the fixed values below are set. `env.js` is parsed once, at import, from what is left.
 */
const SAVED_ENV = vi.hoisted(() => {
  const saved = { ...process.env };
  // Every setting env.ts names outside TRADE_, its shared schemas', the screening switches and the TEST doors.
  const named = new Set([
    'AGENTS_URL',
    'APP_ENV',
    'CAMPAIGNS_URL',
    'DATABASE_POOL_MAX',
    'DATABASE_SSL',
    'DATABASE_URL',
    'EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS',
    'EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS',
    'EDGE_PRINCIPAL_PUBLIC_KEY',
    'EDGE_PRINCIPAL_SECRET',
    'HTTP_HOST',
    'HTTP_PORT',
    'IDENTITY_ADMISSION_SECRET',
    'IDENTITY_TRADING_RESTRICT_REQUIRES_APPROVAL',
    'IDENTITY_URL',
    'INTERNAL_SERVICE_BODY_BIND',
    'INTERNAL_SERVICE_SECRET',
    'LAUNCH_DROP',
    'LEDGER_CUSTODY_LAYER',
    'LEDGER_URL',
    'LOG_LEVEL',
    'MATCHING_URL',
    'NATS_STREAM_PREFIX',
    'NATS_URL',
    'NOTIFY_URL',
    'OTEL_ENABLED',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'QUANT_URL',
    'REDIS_URL',
    'S2S_AUTH_MODE',
    'S2S_KEYRING',
    'S2S_SIGNING_KEY',
    'S2S_SIGNING_KID',
    'SERVICE_NAME',
    'TEST_AGE_DOOR',
    'TEST_DATABASE_URL',
    'TOKEN_URL',
  ]);
  for (const name of Object.keys(process.env))
    if (named.has(name) || name.startsWith('TRADE_') || name.startsWith('INTAFACED_')) delete process.env[name];
  Object.assign(process.env, {
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://wire-replay@127.0.0.1:1/never-dialled',
    DATABASE_POOL_MAX: '2',
    EDGE_PRINCIPAL_SECRET: 'a-trade-wire-replay-edge-secret-long-enough',
    INTERNAL_SERVICE_SECRET: 'a-trade-wire-replay-internal-secret-long-enough',
    LOG_LEVEL: 'fatal',
  });
  return saved;
});

/** svc-trade calls with no `.output()`: the call-records codemod can't make their record. Lower it as each gains one; never raise it. */
const ANSWERLESS_AT_MOST = 135;
const GOLDEN = new URL('./wire-replay.golden/', import.meta.url);
/** One recorded JSON file in the recording folder. */
const goldenJson = (name: string) => new URL(`./wire-replay.golden/${name}.json`, import.meta.url);
/** One review part holds 400 KB and a new file is one hunk, so each recorded file stays under this. */
const SHARD_BYTES = 350_000;
const SECRET = 'a-trade-wire-replay-edge-secret-long-enough';
const INTERNAL = 'a-trade-wire-replay-internal-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

/** A dependency nobody wired: any property is another stub, any call refuses with the path it was reached by. */
function stub(name: string): never {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return stub(`${name}.${prop}`);
    },
    apply() {
      throw new Error(`replay stub: ${name}`);
    },
    construct() {
      throw new Error(`replay stub: new ${name}`);
    },
  }) as never;
}

/**
 * The app as `index.ts` builds it, from `const app = Fastify(...)` to the tRPC mount, in its order and with its
 * arguments. Every client that would dial a service, the database or the bus is a stub; a port `index.ts` builds from
 * a setting that is blank here (no NOTIFY_URL, QUANT_URL, drop-copy URL or identity admission secret) is built as it is.
 */
async function serve(routes: Array<{ method: string; url: string; body: unknown }>) {
  const sql = stub('sql');
  const bus = stub('bus');
  bindMatchingCloseS2s(undefined);
  const ledger: ReturnType<typeof createLedgerClient> = stub('ledger');
  const ledgerPages = stub('ledgerPages');
  bindTradingRestrictApprovals(stub('identityApprovals'));
  const tradingControls = new TradingControls(
    sql,
    stub('liveTradingOperator'),
    createIdentityOperationDecisionClient({
      owner: 'svc-trade',
      identityUrl: env.IDENTITY_URL,
      secret:
        env.IDENTITY_ADMISSION_SECRET !== env.INTERNAL_SERVICE_SECRET && env.IDENTITY_ADMISSION_SECRET !== env.EDGE_PRINCIPAL_SECRET
          ? env.IDENTITY_ADMISSION_SECRET
          : undefined,
    }),
  );
  const matching: ReturnType<typeof createMatchingClient> = stub('matching');
  const perks: ReturnType<typeof createRankPerksClient> = stub('rankPerks');
  const subAccounts = stub('subAccounts');
  const emailProof: ReturnType<typeof createEmailProofClient> = stub('emailProof');
  const affiliateAccrue = stub('affiliateAccrue');
  const affiliatePayout = stub('affiliatePayout');
  const dropCopyIngest = createDropCopyIngestClient(env.TRADE_FIX_DROPCOPY_INGEST_URL, env.INTERNAL_SERVICE_SECRET, undefined);
  const marketLifecycleStore = new SqlMarketLifecycleEvidenceStore(sql);
  const marketLifecycle = new SqlMarketLifecycleAuthority(sql, matching, {
    spotEnabled: env.TRADE_SPOT_ENABLED,
    futuresEnabled: env.TRADE_FUTURES_ENABLED,
  });
  const feeSchedule = parseFeeScheduleJson(env.TRADE_FEE_SCHEDULE);
  assertMakerRebatesPayable(feeSchedule);
  // One fixed request id keeps an added call from shifting every later answer.
  const app = Fastify({ logger: false, maxParamLength: 5_000, genReqId: () => 'replay-request' });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || route.url.startsWith('/trpc')) continue;
      routes.push({ method, url: route.url, body: (route.schema as { body?: unknown } | undefined)?.body });
    }
  });
  installRouteInventory(app, { edgeSecret: env.EDGE_PRINCIPAL_SECRET, edgeTrust: edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME });
  retainRawBody(app);
  registerClosureCheck(app, { sql, secret: env.INTERNAL_SERVICE_SECRET, s2s: undefined });
  registerTrackRecord(app, { sql, secret: env.INTERNAL_SERVICE_SECRET, s2s: undefined });
  registerSupportOrderRead(app, { read: (orderId) => readSupportOrder(sql, orderId), secret: env.INTERNAL_SERVICE_SECRET, s2s: undefined });
  const trailingMarkSource = markSourceFromDepth(async (marketId) => ({
    ...(await matching.depth(marketId, 1)),
    observedAt: new Date(),
  }));
  const trailingMarketIds = new Set(parseCandleMarketIds(env.TRADE_TRAILING_MARK_JOBS_MARKET_IDS));
  const trailingPlacementMarkSource: QuotedMarkSource | undefined =
    env.TRADE_TRAILING_MARK_JOBS_ENABLED && env.TRADE_TRAILING_MARK_JOBS_INTERVAL_MS
      ? { ...trailingMarkSource, quote: async (input) => (trailingMarketIds.has(input.marketId) ? trailingMarkSource.quote(input) : null) }
      : undefined;
  const botVerification = loadBotVerificationPolicy({
    TRADE_BOTS_VERIFICATION: env.TRADE_BOTS_VERIFICATION,
    TRADE_BOTS_VERIFICATION_LEVEL: env.TRADE_BOTS_VERIFICATION_LEVEL,
  });
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
    botVerification,
    convertEnabled: env.TRADE_CONVERT_ENABLED,
    convertLimitSweepMs: env.TRADE_CONVERT_LIMIT_SWEEP_INTERVAL_MS,
    standingInstructionsEnabled: env.TRADE_STANDING_INSTRUCTION_ENABLED,
    convertSpreadBps: env.TRADE_CONVERT_SPREAD_BPS,
    convertQuoteTtlMs: env.TRADE_CONVERT_QUOTE_TTL_MS,
    algoEnabled: env.TRADE_ALGO_ENABLED,
    algoJobsEnabled: env.TRADE_ALGO_JOBS_ENABLED,
    algoJobsIntervalMs: env.TRADE_ALGO_JOBS_INTERVAL_MS,
    seedPlaceEnabled: env.TRADE_MM_SEED_ENABLED,
    feeSchedule,
    subAccounts,
    emailProof,
    affiliateAccrue,
    affiliatePayout,
    dropCopyIngest,
    holdUnknownTakerMaxAgeMs: env.TRADE_HOLD_UNKNOWN_TAKER_MAX_AGE_MS,
    ifcDiscount: stub('ifcDiscount'),
    onHoldUnknownAlert: (a) => app.log.error({ alert: a }, 'order.hold reply lost'),
  });
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
  const otcConvertBounds = (() => {
    try {
      return parseOtcConvertBoundsJson(env.TRADE_OTC_CONVERT_BOUNDS);
    } catch {
      return undefined;
    }
  })();
  const otc = new OtcDeskService(ledger, stub('otcStakes'), {
    accountAdmission: tradingControls,
    emailProof,
    law: otcDeskLaw,
    midSource: otcMidBuilt.source,
    liveObservationFeed: otcMidBuilt.liveObservationFeed,
    midFeedWiring: otcMidFeedWiring,
    convertBounds: otcConvertBounds,
    store: new SqlOtcQuoteStore(sql),
    makerDirectory: loadOtcMakerDirectory(env.TRADE_OTC_MAKER_DIRECTORY, () => undefined),
  });
  const copyFeeShareLaw = parseCopyFeeShareLawJson(env.TRADE_COPY_FEE_SHARE_LAW);
  const copyJurisdictionLaw = parseCopyJurisdictionLawJson(env.TRADE_COPY_JURISDICTION_LAW);
  const copyMetricDefinitions = parseCopyMetricDefinitionsJson(env.TRADE_COPY_METRIC_DEFINITIONS);
  const copyMinTier = parseCopyMinTier(env.TRADE_COPY_MIN_TIER);
  const copyMinInvestment = parseCopyMinInvestment(env.TRADE_COPY_MIN_INVESTMENT);
  const copyOwnerDay = parseCopyOwnerDay(env.TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES);
  const copyStore = new SqlCopyFollowStore(sql);
  const placeFollowerOrder: PlaceFollowerOrderPort = async (principal, input) => {
    if (!input.followId) throw new TradingControlError('auth.credential_denied');
    const order = await trade.placeCopyMirror(
      principal,
      {
        symbol: input.symbol,
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
  const leaderDirectory = sqlLeaderDirectory(sql, { now: () => new Date(), feeShareLaw: copyFeeShareLaw });
  registerLeadCheck(app, { read: (userId) => leaderDirectory.leadListing(userId), secret: env.INTERNAL_SERVICE_SECRET, s2s: undefined });
  const gridStore = new SqlGridStore(sql);
  const depthOf = (marketId: string) => matching.depth(marketId, 1);
  const copyBestBid = async (marketId: string) => {
    const depth = await depthOf(marketId);
    const best = depth.bids[0];
    return best ? parseAmount(best[0]) : null;
  };
  // IDENTITY_URL has a default, so `index.ts` wires identity's approvals here: a stub.
  const stepUp = createStepUpCheck({ service: 'svc-trade', approvals: stub('identityStepUpApprovals') });
  const userVenueWiring = wireUserVenue({ app, sql, bus, stepUp, perks, outS2s: undefined, doorS2s: undefined });
  const { userVenueDoors, userVenue, userVenueRouter, userVenueStore, venueListings, venueDelistingNotices, venueSellQuotes } =
    userVenueWiring;
  const {
    agentAccountStore,
    agentAccountValues,
    agentAccounts,
    agentOrders,
    agentActivity,
    agentDesk,
    ownAgentTrading,
    ownAgentRebalance,
  } = wireVenueAgents({ sql, userVenue, stepUp, outS2s: undefined });
  const protectionTier: ReturnType<typeof createLiveTierClient> = stub('protectionTier');
  const venueProtections = userVenue
    ? new VenueProtections({
        door: userVenue,
        store: new SqlEngineProtectionStore(sql),
        keySeed: env.TRADE_AGENT_KEY_SEED,
        liveTier: (userId) => protectionTier.tierOf(userId),
        freeze: stub('identityFreeze'),
        now: () => new Date(),
      })
    : null;
  const venueSpotConditionals = userVenue
    ? new VenueSpotConditionals({
        door: userVenue,
        store: new SqlSpotConditionalStore(sql),
        keySeed: env.TRADE_AGENT_KEY_SEED,
        liveTier: (userId) => protectionTier.tierOf(userId),
        freeze: stub('identityFreeze'),
        now: () => new Date(),
      })
    : null;
  const quantHalts = new StrategyHaltDesk({
    sql,
    approvals: { consume: (input) => tradeOpsApprovals.consume(input) },
    now: () => new Date(),
  });
  const liveRuns = userVenue
    ? new LiveRuns({
        door: userVenue,
        store: new SqlLiveRunStore(sql),
        values: parseLiveRunValues(
          {
            TRADE_QUANT_LIVE: env.TRADE_QUANT_LIVE,
            TRADE_QUANT_LIVE_HEARTBEAT_MS: env.TRADE_QUANT_LIVE_HEARTBEAT_MS,
            APP_ENV: process.env.APP_ENV,
          },
          { asset: agentAccountValues.asset, keySeed: agentAccountValues.keySeed, bounds: agentAccountValues.bounds },
        ),
        strategies: env.QUANT_URL.trim() ? createQuantStrategySource(env.QUANT_URL.trim()) : null,
        freeze: stub('identityFreeze'),
        liveTier: (userId) => (stub('liveRunTier') as ReturnType<typeof createLiveTierClient>).tierOf(userId),
        halts: quantHalts,
        now: () => new Date(),
      })
    : null;
  const builderFeeWiring = wireBuilderFees({ sql, ledger, userVenue, userVenueDoors, log: app.log });
  const { builderFees } = builderFeeWiring;
  const platformPauses = new PlatformPauseDesk({
    sql,
    approvals: { consume: (input) => tradeOpsApprovals.consume(input) },
    now: () => new Date(),
    leaderUserIdByRef: (leaderRef) => leaderDirectory.resolveLeaderId(undefined, leaderRef).catch(() => null),
    marketIdBySymbol: async (symbol) => (await trade.marketBySymbol(symbol))?.id ?? null,
  });
  const readPlatformPauses = () => platformPauses.snapshot();
  trade.bindPlatformPauses(readPlatformPauses);
  const venueCopy =
    userVenue && agentOrders
      ? new VenueCopy({
          venue: () => userVenue.venue(),
          orders: agentOrders,
          accounts: agentAccountStore,
          actions: userVenueStore,
          bindings: new SqlVenueFollowStore(sql),
          copyStore,
          placedMirrors: sqlPlacedMirrors(sql),
          slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
          admitCopy: (principal, businessId, payload, parent) =>
            trade.admitAccountOperation(principal, 'copy.mirror', businessId, payload, parent),
        })
      : null;
  const onVenue = async (followId: string | undefined) =>
    venueCopy && followId && (await venueCopy.isVenueFollow(followId)) ? venueCopy : null;
  const engineCopyClose = createCopyClosePort({
    sql,
    placeFollowerOrder,
    slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
    loadMarket: (symbol) => trade.marketBySymbol(symbol),
    bestBid: copyBestBid,
  });
  const engineFlatten = createFollowerFlattenPort({
    sql,
    ledger,
    store: copyStore,
    placeFollowerOrder,
    slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
    loadMarket: (symbol) => trade.marketBySymbol(symbol),
    bestBid: copyBestBid,
  });
  const engineCopiedPositions = sqlCopiedPositions(sql);
  const copy = new CopyService(ledger, {
    ...(venueCopy ? { venueFollows: venueCopy } : {}),
    copiedPositions: async (input) => {
      const v = await onVenue(input.followId);
      return (v ? await v.positions(input) : null) ?? engineCopiedPositions(input);
    },
    stepUp,
    platformPauses: readPlatformPauses,
    notices: stub('copyNotices'),
    gridUnusedReserves: (userId, asset) => gridStore.sumUnusedReserves(userId, asset),
    accountAdmission: tradingControls,
    feeShareLaw: copyFeeShareLaw,
    jurisdictionLaw: copyJurisdictionLaw,
    metricDefinitions: copyMetricDefinitions,
    minTier: copyMinTier,
    minInvestment: copyMinInvestment,
    ownerDay: copyOwnerDay,
    store: copyStore,
    directory: leaderDirectory,
    placeFollowerOrder: async (principal, input) => {
      const v = await onVenue(input.followId);
      return v ? v.placeMirror(principal, input) : placeFollowerOrder(principal, input);
    },
    flattenCopyPosition: async (principal, input) => {
      const v = await onVenue(input.followId);
      return (v ? await v.flatten(principal, input) : null) ?? engineFlatten(principal, input);
    },
    copyClose: venueCopy
      ? {
          latest: async (followId, closeKey) =>
            (await onVenue(followId)) ? venueCopy.closePort().latest(followId, closeKey) : engineCopyClose.latest(followId, closeKey),
          resume: async (principal, record) =>
            (await onVenue(record.followId)) ? venueCopy.closePort().resume(principal, record) : engineCopyClose.resume(principal, record),
          place: async (principal, input) =>
            (await onVenue(input.followId)) ? venueCopy.closePort().place(principal, input) : engineCopyClose.place(principal, input),
        }
      : engineCopyClose,
    inspectMarket: async (symbol) => {
      const market = await trade.marketBySymbol(symbol);
      if (market) return { paper: market.paper, lotSize: market.lotSize };
      return venueCopy ? venueCopy.inspectMarket(symbol).catch(() => null) : null;
    },
    // `index.ts` reads the leader's fills and a fill's fee with its own SQL here: the stub refuses them the same way.
    listLeaderFillsSince: async (leaderId, after, limit, followId) => {
      const v = await onVenue(followId);
      if (v) return v.leaderFillsSince(leaderId, after, limit);
      return (sql as () => never)();
    },
    lookupFollowerFillFee: async (fillId) => {
      const id = canonicalizeCopyFillId(fillId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
      return (sql as () => never)();
    },
    sql,
    mirrorEvents: new SqlMirrorEventLog(sql),
    lookupMark: async (marketId) => {
      const depth = await depthOf(marketId);
      const bid = depth.bids[0] ? parseAmount(depth.bids[0][0]) : null;
      const ask = depth.asks[0] ? parseAmount(depth.asks[0][0]) : null;
      if (bid === null || ask === null || bid <= 0n || ask <= 0n) return null;
      return { marketId, price: (bid + ask) / 2n, asOf: new Date(), quality: 'mid' as const };
    },
    lookupLeaderFill: async (fillId, leaderId) => {
      if (isVenueLeaderFillId(fillId)) return venueCopy && leaderId ? venueCopy.leaderFill(fillId, leaderId) : null;
      const id = canonicalizeCopyFillId(fillId);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
      return (sql as () => never)();
    },
  });
  trade.bindCopyMirrorFill((notice) => copy.observeFollowerFill(notice));
  const grid = new GridService({
    store: gridStore,
    policy: loadGridPolicy(process.env),
    verification: () => botVerification,
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    depth: (marketId) => depthOf(marketId),
    freeBalance: async (userId, asset) => freeSpotBalance(await ledger.balances('user', userId), asset),
    copyUnusedReserves: (userId, asset) => copyStore.sumUnusedReserves(userId, asset),
    admitStart: (principal, businessId, payload) => trade.admitAccountOperation(principal, 'strategy.start', businessId, payload),
    placeLevel: (principal, input, botId) => trade.placeGridLevel(principal, input, botId),
    findOrder: (orderId) => trade.findOrder(orderId),
    cancelOrder: (principal, orderId) => trade.cancelOrder(principal, orderId),
    fillsForOrder: (principal, orderId) => trade.everyFillOfOrder(principal, orderId),
    stepUp,
    platformPauses: readPlatformPauses,
  });
  const signalDesk = new SignalDesk({
    sql,
    now: () => new Date(),
    venueMarkets: async () => (userVenue ? (await userVenue.markets()).value.map((m) => m.symbol) : null),
    liveTier: (userId) => (stub('signalLiveTier') as ReturnType<typeof createLiveTierClient>).tierOf(userId),
    admitStart: (principal, businessId, payload) => trade.admitAccountOperation(principal, 'strategy.start', businessId, payload),
    admitAlert: (principal, businessId, payload, webhookId) =>
      tradingControls.admitStanding(principal.userId, webhookId, businessId, payload, 'svc-trade'),
    prepareOrder: async (principal, input) => {
      if (!userVenue) return { ok: false, code: 'trade.user_venue_off' };
      try {
        const answer = await userVenue.prepare(
          principal,
          { owner: input.owner, signer: { role: 'owner', address: input.owner }, intent: input.intent },
          { ownWorstPrice: true },
        );
        return { ok: true, actionKey: answer.actionKey, venueClientOrderId: answer.prepared.venueClientOrderId ?? null };
      } catch (err) {
        if (err instanceof UserVenueDoorError) return { ok: false, code: err.code };
        if (err instanceof VenueRefusalError) return { ok: false, code: `venue.${err.refusal.code}` };
        throw err;
      }
    },
    maxAlertAgeSeconds: parseSignalMaxAge(env.TRADE_SIGNAL_MAX_ALERT_AGE_SECONDS),
    webhookDays: parseSignalWebhookDays(env.TRADE_SIGNAL_WEBHOOK_DAYS),
  });
  registerSignalIntake(app, signalDesk);
  const tradeOpsApprovals = currentTradingRestrictApprovals() ?? stub('identityApprovals');
  const leadDesk = new LeadDesk({
    sql,
    approvals: tradeOpsApprovals,
    directory: leaderDirectory,
    now: () => new Date(),
    reapplyWaitSeconds: parseLeadReapplyWait(env.TRADE_COPY_LEAD_REAPPLY_WAIT_SECONDS),
    minVenueUsdc: parseLeadMinVenueUsdc(env.TRADE_COPY_LEAD_MIN_VENUE_USDC),
    following: (userId) => leadFollowing({ follows: copyStore, directory: leaderDirectory }, userId),
    venueUsdc: (userId) => leadVenueUsdc({ venue: userVenue ? () => userVenue.venue() : null, store: userVenueStore }, userId),
    missionMinUsdc: parseLeadMinVenueUsdc(env.TRADE_COPY_LEAD_MISSION_MIN_USDC),
    limits: {
      dailyBuyCap: parseLeadDailyBuyCap(env.TRADE_COPY_LEAD_DAILY_BUY_CAP),
      pairHolding: parseLeadPairHolding(env.TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS),
    },
    ownerDay: copyOwnerDay,
  });
  const router = createTradeRouter(
    trade,
    otc,
    copy,
    tradingControls,
    wireTradeOpsAdmin({
      sql,
      trade,
      ledger,
      approvals: tradeOpsApprovals,
      feeSchedule,
      vipProofKey: parseVipProofKey(env.TRADE_VIP_PROOF_KEY),
      otcLaw: otcDeskLaw,
      metricsWindowSeconds: parseMetricsWindowSeconds(env.TRADE_OPS_METRICS_WINDOW_SECONDS),
      chartFeed: {
        fallbackSources: parseFallbackSources(env.TRADE_CHART_FEED_FALLBACK_SOURCES),
        exportRowLimit: parseExportRowLimit(env.TRADE_CHART_CONTROL_EXPORT_ROW_LIMIT),
      },
      sweepLimit: parseSweepLimit(env.TRADE_OPERATOR_SWEEP_LIMIT),
      sweepMinAgeSeconds: parseSweepMinAgeSeconds(env.TRADE_OPERATOR_SWEEP_MIN_AGE_SECONDS),
      sweepEnabled: parseSweepEnabled(env.TRADE_OPERATOR_SWEEP_ENABLED),
      convert: {
        spreadBps: env.TRADE_CONVERT_SPREAD_BPS,
        quoteTtlMs: env.TRADE_CONVERT_QUOTE_TTL_MS,
        deskBounds: otcConvertBounds ?? NO_OTC_CONVERT_BOUNDS,
      },
      venueDesk: { venue: userVenue ? () => userVenue.venue() : null, store: venueListings, notices: venueDelistingNotices },
      venueOrders: { venue: userVenue ? () => userVenue.venue() : null, store: new SqlPreparedActionStore(sql) },
      venueRouting:
        userVenueDoors.length > 0 ? (from, to) => routingReport({ doors: userVenueDoors, store: userVenueStore }, from, to) : null,
      venueMarkets: async () => {
        if (!userVenue) return null;
        const venue = await userVenue.venue();
        const markets = await venue.markets(null);
        return {
          venueId: venue.venue.id,
          displayName: venue.venue.displayName,
          test: isTestVenue(venue.venue),
          markets: markets.value,
          asOf: markets.asOf,
        };
      },
    }),
    new InsuranceTopupAdmin({ sql, ledger, approvals: tradeOpsApprovals }),
    new SupportTradeSummaryReader({ sql }),
    leadDesk,
    grid,
    platformPauses,
    builderFees,
    { venue: userVenue ? () => userVenue.venue() : null, store: new SqlPreparedActionStore(sql) },
    signalDesk,
    agentDesk,
    quantHalts,
  );
  const edgeContext = createEdgeContext({
    secret: env.EDGE_PRINCIPAL_SECRET,
    ...edgeTrustFromEnv(env),
    serviceName: env.SERVICE_NAME,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    bodyBindMode: 'require',
  });
  const venueMarkConfigured = createConfiguredVenueMarkSource({
    venueId: env.TRADE_VENUE_MARK_VENUE,
    symbols: venueMarkSymbols,
    adapter: venuePublicAdapter,
    ...(venueBookPort ? { bookForSymbol: venueBookPort } : {}),
  });
  const fundingMarketIds = parseFundingMarketIds(env.TRADE_FUTURES_FUNDING_MARKET_IDS);
  const liquidationFeeFraction = loadLiquidationFeeFraction(process.env);
  const fundingMaxAbsRate = resolveFundingMaxAbsRateForBoot({ fundingMarketIds, maxAbsRateRaw: env.TRADE_FUTURES_FUNDING_MAX_ABS_RATE });
  const matchedLiquidation: { current: MatchedLiquidationPort | null } = { current: null };
  // With TRADE_FUTURES_JOBS_ENABLED blank no futures job starts; its reads (marks, ladder, published rates) still answer.
  const futuresJobs = startFuturesJobs({
    sql,
    ledger,
    matching,
    bus,
    venueMarkSource: venueMarkConfigured?.source ?? null,
    markBookFor: markBookResolver(parseIndexSpotMarkets(env.TRADE_FUTURES_INDEX_SPOT_MARKETS), {
      byId: (marketId) => trade.marketById(marketId),
      bySymbol: (symbol) => trade.marketBySymbol(symbol),
    }),
    stampDepthReads: env.TRADE_FUTURES_MATCHING_ENABLED,
    ladderPolicy: ownerLadderPolicy(env.TRADE_FUTURES_LADDER_POLICY),
    config: {
      enabled: env.TRADE_FUTURES_JOBS_ENABLED,
      liqIntervalMs: env.TRADE_FUTURES_LIQ_INTERVAL_MS,
      liquidationFeeFraction,
      liquidationLimits: publishedLiquidationLimitsFrom(env.TRADE_FUTURES_LIQUIDATION_LIMITS),
      fundingIntervalMs: env.TRADE_FUTURES_FUNDING_INTERVAL_MS,
      fundingComputerPollMs: env.TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS,
      fundingMarketIds,
      fundingMaxAbsRate,
      settlementFixing: env.TRADE_FUTURES_SETTLEMENT_FIXING,
    },
    onError: () => undefined,
    matchedLiquidation,
  });
  const profitSource = optionalProfitSourceFromConfig(env.TRADE_FUTURES_PROFIT_SOURCE);
  const maxLeverage = parseConfiguredMaxLeverage(env.TRADE_FUTURES_MAX_LEVERAGE);
  const adlDisclosureAcks = sqlAdlDisclosureStore(sql);
  const adlDisclosureEvents = sqlAdlDisclosureEventStore(sql);
  const derivativesGate = derivativesAccessGate({ eligibility: sqlEligibilityStore(sql) });
  const futuresPriceBand = parsePriceBand(env.TRADE_FUTURES_PRICE_BAND);
  const priceBands = sqlPriceBandStore(sql);
  const futuresBandInForce = async (staticBand: bigint, marketId: string): Promise<BandInForce> => {
    try {
      const risk = await currentRisk(sql, marketId);
      return bandInForce({
        staticBand,
        settings: readPriceRangeSettings(risk),
        riskVersion: risk?.version ?? '0',
        current: await priceBands.current(marketId),
        now: new Date(),
        jobIntervalMs: env.TRADE_FUTURES_LIQ_INTERVAL_MS,
      });
    } catch {
      return staticBandInForce(staticBand, 'unreadable');
    }
  };
  const futuresSlippageCapBps = async (marketId: string): Promise<number | null> =>
    (await operatorSlippageCapBps(sql, marketId)) ?? env.TRADE_MARKET_SLIPPAGE_CAP_BPS ?? null;
  const perksOf = (userId: string) => perks.perksOf(userId);
  const futuresFeeRates = async (userId: string) =>
    perpetualFeeRates(await feeScheduleAt(sql, feeSchedule, new Date()), (await perksOf(userId)).feeDiscountBps);
  const positions = new PositionService(sql, ledger, {
    accountAdmission: tradingControls,
    emailProof,
    marks: futuresJobs.marks,
    profitSource,
    bus,
    maxLeverage,
    ladder: futuresJobs.ladderGate,
    matchedOrders: {
      matching,
      enabled: env.TRADE_FUTURES_MATCHING_ENABLED,
      priceBand: futuresPriceBand,
      ...(futuresPriceBand !== null
        ? { priceBandFor: async (marketId: string) => (await futuresBandInForce(futuresPriceBand, marketId)).fraction }
        : {}),
      lifecycleProof: (marketId) => trade.placeLifecycleProofForMarket(marketId),
      feeRates: futuresFeeRates,
      slippageCapBps: futuresSlippageCapBps,
      openInterestLimits: async (marketId) => readOpenInterestLimits(await currentRisk(sql, marketId)),
    },
    assertDerivativesAccess: derivativesGate,
  });
  const stopTriggers = sqlStopTrigger(sql);
  matchedLiquidation.current = positions.matchedLiquidation;
  const reverses = createReverseService({
    sql,
    place: (principal, input, context) => positions.placeMatchedOrder(principal, input, context),
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
    placeReduce: env.TRADE_FUTURES_MATCHING_ENABLED
      ? (input, instructionId) => positions.placeMatchedOnInstruction({ ...input, leverage: 0n, reduceOnly: true }, instructionId)
      : null,
  });
  const riskStops = createRiskStopService({
    sql,
    triggerScheduled: conditionalTriggerScheduled(conditionalJobsConfig) && env.TRADE_FUTURES_MATCHING_ENABLED,
    figures: (userId, positionId, level) => positions.riskStopFigures(userId, positionId, level),
    fire: (input) => conditionalOrders.fireRiskStop(input),
    closeOrder: (userId, clientOrderId) => conditionalOrders.getByClientId(userId, clientOrderId),
    sync: (input) => conditionalOrders.syncRiskStop(input),
  });
  const mmSeedTargets = parseMmSeedTargets(env.TRADE_MM_SEED_MARKETS);
  app.get('/health', async () => ({
    ok: true,
    service: env.SERVICE_NAME,
    venueLatency: presentVenueLatencyHealth(venuePublicAdapter, new Date(), { streamEnabled: env.TRADE_VENUE_MARK_STREAM }),
    mmSeed: presentMmSeedHealth({
      enabled: env.TRADE_MM_SEED_ENABLED,
      targetCount: mmSeedTargets.length,
      operatorTick: env.TRADE_MM_SEED_INTERVAL_MS != null,
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
    const sequences = await checkEngineSequences({
      sql,
      markets: () => trade.markets(MARKETS_LIMIT_MAX),
      engineSequence: (marketId) => probeEngineSequence((id) => depthOf(id), marketId),
    });
    if (sequences.regressions.length > 0) {
      const reason = describeRegressions(sequences.regressions);
      return reply.code(503).send({
        ready: false,
        reason,
        markets: sequences.regressions.map((r) => r.symbol),
        unavailable: sequences.unavailable.map((u) => u.symbol),
      });
    }
    if (sequences.unavailable.length > 0) {
      const reason = describeUnavailable(sequences.unavailable);
      return reply.code(503).send({ ready: false, reason, markets: sequences.unavailable.map((u) => u.symbol) });
    }
    return { ready: true, engineSequences: { checked: sequences.checked, unjudged: sequences.unjudged } };
  });
  const listMarkets = () => matching.listMarkets();
  registerPublicRest(app, {
    markets: (limit) => trade.markets(limit),
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    publishedFeeRates: async (markets) => {
      const schedule = await feeScheduleAt(sql, feeSchedule, new Date());
      if (schedule.published !== true) return null;
      return new Map(Object.entries(presentAccountFees(markets, schedule)).map(([symbol, row]) => [symbol, row]));
    },
    chartOwnerValues: chartOwnerValuesPublicReader(sql),
    chartFeedGate: chartFeedCandleGate(sql),
    depth: (marketId, limit) => matching.depth(marketId, limit),
    publicTape: (marketId, limit, sinceMs) => trade.publicTape(marketId, limit, sinceMs),
    candles: (marketId, timeframe, limit, sinceMs) => trade.candles(marketId, timeframe, limit, sinceMs),
    tickerStats: createTickerStatsReader(sql, { ttlMs: 3000 }),
    lifecycleForMarket: (market) => trade.marketLifecycleSnapshot(market),
    maintenanceBoard: createMarketMaintenanceReader({ notifyUrl: env.NOTIFY_URL }),
    rulebook: stub('matchingRulebook'),
    bookHalt: async (market) => bookHaltFromBoard((await listMarkets()) as never, market.id),
    pairRiskForMarkets: async (markets) => {
      const risks = await currentRiskForMarkets(
        sql,
        markets.map((m) => m.id),
      );
      return new Map(markets.map((m) => [m.id, presentPairRisk(m, risks.get(m.id) ?? null, env.TRADE_MARKET_SLIPPAGE_CAP_BPS)]));
    },
    onPairRulesReadError: () => undefined,
    fundingRateForMarket: async (marketId) => {
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
    futuresMatchingEnabled: env.TRADE_FUTURES_MATCHING_ENABLED,
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
  const edge = { edgeSecret: env.EDGE_PRINCIPAL_SECRET, edgeTrust: edgeTrustFromEnv(env), serviceName: env.SERVICE_NAME };
  registerConditionalOrdersRest(app, { ...edge, orders: conditionalOrders, restingRefusal: !env.TRADE_FUTURES_MATCHING_ENABLED });
  registerRiskStopRest(app, { ...edge, stops: riskStops });
  registerFuturesTickerRest(app, {
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    markForMarket: (marketId, symbol) => futuresJobs.publicMark(marketId, symbol),
    fundingForMarket: (marketId) => futuresJobs.getPublishedRate(marketId),
    factsForMarket: (marketId, nowMs) => readFuturesTickerFacts(sql, marketId, new Date(nowMs)),
  });
  registerPositionPreviewRest(app, {
    ...edge,
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    markForMarket: (marketId, symbol) => futuresJobs.publicMark(marketId, symbol),
    leverageCap: maxLeverage,
    priceBand: futuresPriceBand,
    ...(futuresPriceBand !== null ? { priceBandInForce: (marketId: string) => futuresBandInForce(futuresPriceBand, marketId) } : {}),
    slippageCapBps: futuresSlippageCapBps,
    maxOrder: () => {
      const resolved = resolveAdmissionLimits();
      return 'refusal' in resolved ? null : resolved.limits.maxOrder;
    },
    takerFeeBps: async (userId) => (await futuresFeeRates(userId)).takerBps,
    liquidationPriceFor: async ({ market, side, size, markPrice, initialMargin }) => {
      const { policy, depth } = futuresJobs.ladderGate;
      if (!policy) return null;
      try {
        const depthNotional = await depth.depthNotional({ marketId: market.id, side, symbol: market.symbol });
        if (depthNotional == null || depthNotional <= 0n) return null;
        return liquidationPriceFor({ side, size, entryPrice: markPrice, margin: initialMargin, depthNotional, policy }).price;
      } catch {
        return null;
      }
    },
    riskTierFor: ({ userId, market, side, size, markPrice }) =>
      positions.riskTierCrossing({ userId, marketId: market.id, symbol: market.symbol, side, qty: size, mark: markPrice }),
    openInterestFor: ({ userId, market }) =>
      positions.openInterestRoom({ userId, marketId: market.id, symbol: market.symbol, lotSize: market.lotSize }),
  });
  registerRiskCalculatorRest(app, {
    ...edge,
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    publishedLadder: () => futuresJobs.ladderGate.policy,
    depthNotional: (input) => futuresJobs.ladderGate.depth.depthNotional(input),
    leverageCap: maxLeverage,
    takerFeeBps: async (userId) => (await futuresFeeRates(userId)).takerBps,
  });
  registerCollateralRest(app, {
    ...edge,
    settleAssets: async () => (await trade.markets(500)).filter((m) => m.kind === 'futures').map((m) => m.quoteAsset),
    figures: (userId, asset) => positions.collateralFigures(userId, asset),
  });
  registerGreeksWhatIfRest(app, { ...edge });
  registerDeltaHedgeRest(app, {
    ...edge,
    target: env.TRADE_DELTA_HEDGE_TARGET,
    range: env.TRADE_DELTA_HEDGE_RANGE,
    instrument: env.TRADE_DELTA_HEDGE_INSTRUMENT,
  });
  registerQuantLiveDeployRest(app, { ...edge, pin: env.TRADE_QUANT_LIVE_DEPLOY_PIN });
  registerPromoRest(app, { ...edge, budget: env.TRADE_PROMO_BUDGET, end: env.TRADE_PROMO_END });
  registerSpotOrderPreviewRest(app, {
    ...edge,
    now: () => new Date(),
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    marketLifecycle,
    stopLimitEnabled: true,
    matchingHalt: async (marketId) => {
      const board = await listMarkets();
      return { market: board.halted?.includes(marketId) === true, venue: board.venueHalted === true };
    },
    bestAsk: async (marketId) => {
      const best = (await depthOf(marketId)).asks[0];
      return best ? parseAmount(best[0]) : null;
    },
    bestBid: async (marketId) => {
      const best = (await depthOf(marketId)).bids[0];
      return best ? parseAmount(best[0]) : null;
    },
    operatorRisk: (market, userId, input) =>
      assertOperatorRiskOnPlace(sql, market, userId, input, async () => {
        const depth = await depthOf(market.id);
        const bid = depth.bids[0];
        const ask = depth.asks[0];
        return { bid: bid ? parseAmount(bid[0]) : null, ask: ask ? parseAmount(ask[0]) : null };
      }),
    spotEnabled: env.TRADE_SPOT_ENABLED,
    futuresEnabled: env.TRADE_FUTURES_ENABLED,
    optionsSettlementLawStamped: env.TRADE_OPTIONS_SETTLEMENT_ASSET_LAW.trim().length > 0,
    slippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
    stopMarketCapBps: futuresSlippageCapBps,
    feeSchedule,
    feeScheduleNow: () => feeScheduleAt(sql, feeSchedule, new Date()),
    feeDiscountBps: async (userId) => (await perksOf(userId)).feeDiscountBps,
    feeTier: (userId) => trade.feeTierAt(userId),
    availableBalance: async (userId, assetId) =>
      (await ledger.balances('user', userId))
        .filter((row) => row.account.kind === 'available' && row.account.assetId === assetId)
        .reduce((sum, row) => sum + row.amount, 0n),
  });
  registerFeeTierRest(app, {
    ...edge,
    sql,
    scheduleAt: (at) => feeScheduleAt(sql, feeSchedule, at),
    bootSchedule: feeSchedule,
    snapshotsRunning: env.TRADE_FEE_TIER_JOBS_INTERVAL_MS !== null && env.TRADE_FEE_TIER_JOBS_INTERVAL_MS > 0,
  });
  registerTierPassGrant(app, {
    sql,
    secret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
    scheduleAt: (at) => feeScheduleAt(sql, feeSchedule, at),
  });
  registerVipRest(app, {
    ...edge,
    store: new VipApplicationStore(sql, parseVipProofKey(env.TRADE_VIP_PROOF_KEY)),
    scheduleAt: (at) => feeScheduleAt(sql, feeSchedule, at),
  });
  const fundingHistory = memoryFundingHistory();
  registerInternalFundingRate(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
    publishFundingRate: (entry) => futuresJobs.publishFundingRate(entry),
    recordFundingHistory: (row) => fundingHistory.record(row),
    maxAbsRate: fundingMaxAbsRate,
    installRawBody: false,
    approvals: currentTradingRestrictApprovals() ?? stub('identityApprovals'),
    writeAudit: (row) => writeOperatorAudit(sql, row),
  });
  registerFundingHistory(app, {
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    historyForMarket: async (marketId) => fundingHistory.list(marketId),
  });
  registerDeveloperPortalRest(app, {
    hosts: parseDeveloperHosts(env.TRADE_DEVELOPER_HOSTS),
    dataTerms: parseDataTerms(env.TRADE_DEVELOPER_DATA_TERMS),
    regionalRule: parseRegionalRule(env.TRADE_DEVELOPER_REGIONAL_RULE),
    botPolicy: parseBotPolicy(env.TRADE_DEVELOPER_BOT_POLICY),
    streamHosts: parseDeveloperStreamHosts(env.TRADE_DEVELOPER_STREAM_HOSTS),
  });
  registerMarketLifecycleRoutes(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
    store: marketLifecycleStore,
    installRawBody: false,
  });
  registerBuybackDoor(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
    placeBuybackIocBuy: (input) => trade.placeBuybackIocBuy(input),
    installRawBody: false,
  });
  if (localTestTapeRetimeEnabled(process.env))
    registerLocalTestTapeRoutes(app, { internalSecret: env.INTERNAL_SERVICE_SECRET, s2s: undefined, sql, installRawBody: false });
  registerTestAgeDoor(app, {
    open: testAgeDoorOpen(process.env),
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
    subjects: { 'otc-quote': ageOtcQuote(sql) },
    installRawBody: false,
  });
  registerCopyLeaderFixturesRoutes(app, {
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
    store: createCopyLeaderFixturesStore(sql),
    bodyBind: env.INTERNAL_SERVICE_BODY_BIND,
    installRawBody: false,
  });
  registerOutcomesRest(app, {
    ...edge,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    s2s: undefined,
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
    userVenueSlippageCapBps: env.TRADE_MARKET_SLIPPAGE_CAP_BPS,
    userVenueSpreadLimitBps: env.TRADE_MARKET_SPREAD_LIMIT_BPS,
    apiKeyRotation: stub('apiKeyRotation'),
    ...edge,
    openOrders: (principal, marketId, limit) => trade.openOrders(principal, marketId, limit),
    adminOpenOrders: (principal, limit) => trade.adminOpenOrders(principal, limit),
    orderHistory: (principal, input) => trade.orderHistory(principal, input),
    getOrder: (principal, orderId) => trade.getOrder(principal, orderId),
    orderFills: (principal, orderId, limit) => trade.fillsForOrder(principal, orderId, limit),
    ordersFills: (principal, orderIds) => trade.everyFillOfOrders(principal, orderIds),
    orderAmendments: (principal, orderId) => trade.orderAmendments(principal, orderId),
    orderQueue: (principal, orderId) =>
      readQueuePosition(
        {
          getOrder: (p, id) => trade.getOrder(p, id),
          marketById: (marketId) => trade.marketById(marketId),
          l3Queue: async (marketId, limit) => {
            if (!matching.l3Queue)
              throw new MatchingUnavailableError('the matching client has no native L3 read', 'trade.queue_unavailable');
            return matching.l3Queue(marketId, limit);
          },
          queueFillWindowSeconds: async () => (await readChartScalars(sql)).values.queueFillWindowSeconds,
          tradedThrough: (marketId, side, price, sinceMs) => trade.tradedThrough(marketId, side, price, sinceMs),
          now: () => new Date(),
        },
        principal,
        orderId,
      ),
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
    cancelAllOrders: (principal, marketId, kind) => trade.cancelAllOrders(principal, marketId, kind),
    armCancelAllAfter: (principal, timeoutSec) =>
      (trade as TradeService & CancelAllAfterHost).armCancelAllAfter(
        principal,
        timeoutSec,
        env.TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC,
        env.TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS * 3,
      ),
    readCancelAllAfter: async (principal) => ({
      ...(await (trade as TradeService & CancelAllAfterHost).readCancelAllAfter(principal)),
      published: env.TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC,
    }),
    massCancelOrders: (principal, marketId) => trade.massCancelOrders(principal, marketId),
    myFills: (principal, limit, marketId, sinceMs) => trade.myFills(principal, limit, marketId, sinceMs),
    marketBySymbol: (symbol) => trade.marketBySymbol(symbol),
    marketById: (marketId) => trade.marketById(marketId),
    markets: (limit) => trade.markets(limit),
    feeSchedule,
    feeScheduleNow: () => feeScheduleAt(sql, feeSchedule, new Date()),
    feeTier: (userId, schedule) => feeTierAt(sql, schedule, userId, new Date()),
    feeDiscountBps: async (userId) => (await perksOf(userId)).feeDiscountBps,
    now: () => new Date(),
    lifecycleForMarket: (market) => trade.marketLifecycleSnapshot(market),
    userBalances: (userId) => ledger.balances('user', userId),
    subAccountBalances: (subAccountId) => ledger.balances('subaccount', subAccountId),
    ...(env.TRADE_FUTURES_MATCHING_ENABLED
      ? {
          futuresOrders: {
            place: (principal, input, context) => positions.placeMatchedOrder(principal, input, context),
            placeSplit: (principal, input, context) => positions.placeMatchedSplit(principal, input, context),
            cancel: (principal, orderId) => positions.cancelMatchedOrder(principal, orderId),
            list: (principal, input) => positions.listMatchedOrders(principal.userId, input),
            get: (principal, orderId) => positions.getMatchedOrder(principal.userId, orderId),
            executions: (principal, input) => listFuturesExecutions(sql, principal.userId, input),
            entryProtection: { record: (userId, input) => conditionalOrders.recordEntryProtection(userId, input) },
            reverse: (principal, input, context) => reverses.reverse(principal, input, context),
          },
        }
      : {}),
    gatedList: (subject) =>
      readGatedList(
        {
          markets: () => trade.markets(500),
          planeRefusal: () => positions.futuresExposureRefusal(),
          orderPathRefusal: () =>
            !env.TRADE_FUTURES_MATCHING_ENABLED
              ? { code: 'trade.futures_matching_disabled', message: 'Futures orders through the book are switched off on this deployment.' }
              : futuresPriceBand === null
                ? { code: FUTURES_PRICE_BAND_UNSET, message: 'The futures price band is unset on this deployment.' }
                : null,
          emailProved: async (userId) => (await emailProof.get(userId)) === 'accepted',
          orderable: (market) => orderableForListedMarket(market, env.TRADE_FUTURES_ENABLED),
          checkAccess: (who) => derivativesGate(who),
        },
        subject,
      ),
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
      positions.closeQuantity(principal.userId, positionId, { quantity: parseAmount(input.quantity), clientCloseId: input.clientCloseId }),
    closeAllPositions: (principal, input) => positions.closeAll(principal.userId, input),
    marginSummary: (principal, asset) => positions.marginSummary(principal.userId, asset),
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
    getAdlDisclosure: async (principal) =>
      presentAdlDisclosureWire(await adlDisclosureAcks.getAck(principal.userId, ADL_DISCLOSURE_VERSION)),
    ackAdlDisclosure: async (principal) =>
      presentAdlDisclosureWire(await adlDisclosureAcks.recordAck(principal.userId, ADL_DISCLOSURE_VERSION, new Date())),
    listAdlDisclosureEvents: async (principal, limit) =>
      (await adlDisclosureEvents.listForUser(principal.userId, limit)).map(presentAdlActionDisclosureWire),
    convertExport: (principal, query) => trade.convertExport(principal, query),
    convert: trade,
    copyExport: (principal, query) => copy.exportMirrorTrail(principal, query),
    leadOrderGate: leadOrderGate((userId) => leaderDirectory.leadListing(userId)),
    leadTrading: leadDesk.trading,
    grid,
    userVenue: userVenueRouter,
    agentAccounts,
    agentOrders,
    agentActivity,
    ownAgentTrading,
    ownAgentRebalance,
    venueProtections,
    venueSpotConditionals,
    liveRuns,
    venueSellQuotes,
    venueStatements: userVenueRouter ? new VenueStatements(sql) : null,
    venueAdlAcks: userVenueRouter ? sqlVenueAdlAcks(sql) : null,
    venueBuilderFees: userVenueRouter ? builderFees.ofUser : null,
    algo: trade,
    rfqExport: (principal, query) => trade.rfqExport(principal, query),
    statements: { ledger: ledgerPages, exports: new StatementExports(sql, ledgerPages) },
    icebergDisplay: sqlIcebergDisplay(sql),
    stopTriggers,
    stopMarketCapBps: futuresSlippageCapBps,
    ocoExits: (ids) => readOcoIntents(sql, ids),
    orderLinks: (ids) => readOrderLinks(sql, ids),
    orderHolds: (orders) => readOrderHolds(sql, orders),
    findClientOrder: (principal, input) => trade.findClientOrder(principal, input),
    listFundingPayments: (principal, positionId, cursor) => listFundingPayments(sql, principal.userId, positionId, cursor),
    listLiquidations: (principal) => listCallerLiquidations(sql, principal.userId),
    positionLiquidation: (principal, positionId) => loadPositionLiquidation(sql, principal.userId, positionId),
    listFuturesPayouts: async (principal) => ({ payouts: await listPayoutsForUser(sql, principal.userId) }),
  });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }: { req: unknown }) => edgeContext(req as never),
      onError: ({ path, type, error }: { path?: string; type: string; error: Error }) =>
        logTrpcServerFault(app.log, { path, type, error } as never),
    },
  });
  await app.ready();
  return { app, router };
}

function headers(caller: Caller): Record<string, string> {
  if (caller.scopes === null) return {};
  const principal = {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: caller.scopes,
    tier: caller.tier,
    mfa: caller.mfa,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, caller.region),
    'x-intafaced-region': caller.region,
  };
}

interface Caller {
  readonly scopes: readonly Scope[] | null;
  readonly tier: 'none' | 'basic' | 'full';
  readonly mfa: boolean;
  readonly region: string;
}

/** Nobody; a signed-in person holding no scope; a verified trader holding trade's own scopes; a holder of every scope, in a served and an unserved region. */
const CALLERS: ReadonlyArray<[string, Caller]> = [
  ['anon', { scopes: null, tier: 'none', mfa: false, region: 'DE' }],
  ['no-scope', { scopes: [], tier: 'basic', mfa: false, region: 'DE' }],
  ['trader', { scopes: ['trade:read', 'trade:write', 'copy:follow'], tier: 'full', mfa: true, region: 'DE' }],
  ['all', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'DE' }],
  ['all-US', { scopes: [...SCOPES], tier: 'full', mfa: true, region: 'US' }],
];

/** The signed services svc-trade's calls and doors name (its own jobs and every service a door admits), each with a body-bound signature. */
const SERVICES = [
  'svc-trade',
  'svc-ops',
  'svc-identity',
  'svc-campaigns',
  'svc-bank',
  'svc-token',
  'svc-support',
  'svc-market',
  'svc-fix',
  'svc-agents',
  'svc-tax',
] as const;

type Json = { [k: string]: unknown };

/** Strings tried against a schema's pattern, in order: the first that matches is the sample. */
const PATTERN_TRIES = [
  '1.50',
  '1',
  '1.5',
  'BTC',
  'BTC-USDC',
  'USDC',
  'DE',
  'placeholder',
  ID,
  '2026-01-01',
  '2026-01-01T00:00:00Z',
  'a-b',
  'A',
  '0x' + 'a'.repeat(40),
];

/** A plain sample of what an input's own JSON schema asks for. Not always accepted (custom checks are not in the schema): that answer is recorded too. */
function sample(schema: unknown, depth = 0): unknown {
  if (typeof schema !== 'object' || schema === null || depth > 8) return null;
  const s = schema as Json;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(s[k])) {
      const options = (s[k] as Json[]).filter((o) => o.type !== 'null');
      if (k === 'allOf') return Object.assign({}, ...options.map((o) => sample(o, depth + 1)));
      return sample(options[0] ?? s[k][0], depth + 1);
    }
  }
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const out: Json = {};
      for (const key of (s.required ?? []) as string[]) out[key] = sample(props[key], depth + 1);
      return out;
    }
    case 'array':
      return typeof s.minItems === 'number' && s.minItems > 0 ? Array.from({ length: s.minItems }, () => sample(s.items, depth + 1)) : [];
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 1;
    case 'boolean':
      return true;
    case 'string': {
      if (s.format === 'uuid') return ID;
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'date') return '2026-01-01';
      if (s.format === 'email') return 'a@example.com';
      if (s.format === 'uri' || s.format === 'url') return 'https://example.com/';
      if (typeof s.pattern === 'string') {
        const re = new RegExp(s.pattern as string, 'u');
        return PATTERN_TRIES.find((t) => re.test(t)) ?? 'x';
      }
      // A sample says it is a placeholder, so the secret scan never reads a sample `key` as a committed credential.
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
      return 'placeholder'.length <= max ? 'placeholder'.padEnd(min, 'x') : 'x'.repeat(Math.max(1, min));
    }
    default:
      return null;
  }
}

type Proc = { _def: { type: 'query' | 'mutation' | 'subscription'; inputs: unknown[] } };

function sampleInput(proc: Proc): unknown {
  const input = proc._def.inputs[0];
  if (input === undefined) return undefined;
  try {
    return sample(z.toJSONSchema(input as z.ZodType, { io: 'input', unrepresentable: 'any' }));
  } catch {
    return {};
  }
}

/**
 * The two inputs made from a call's own schema, recorded in the golden file so a changed schema cannot change its own
 * requests. Kept as the JSON text that is sent, byte for byte.
 */
type Samples = { readonly sample: string; readonly 'sample-nulls': string };

function nulls(valid: unknown): unknown {
  return valid !== null && typeof valid === 'object' && !Array.isArray(valid)
    ? Object.fromEntries(Object.keys(valid).map((k) => [k, null]))
    : null;
}

function samplesOf(valid: unknown): Samples {
  return { sample: JSON.stringify(valid ?? null), 'sample-nulls': JSON.stringify(nulls(valid)) };
}

/** Each call gets: nothing; null; a wrong type; an object missing every field; a sample; the sample with every field null. */
function inputs(samples: Samples): Array<[string, unknown]> {
  return [
    ['absent', undefined],
    ['null', null],
    ['wrong-type', 7],
    ['empty', {}],
    ['sample', JSON.parse(samples.sample)],
    ['sample-nulls', JSON.parse(samples['sample-nulls'])],
  ];
}

type Answer = { status: number; body: string };

interface Golden {
  readonly callers: unknown;
  /** The requests made from each call's schema when the recording was written: replayed as they are. */
  readonly inputs: Record<string, Samples>;
  /** Per call, per `<input> <caller>`: the answer. */
  readonly answers: Record<string, Record<string, Answer>>;
}

/**
 * The shard a call is kept in: its namespace (`ops`), or for REST its first two fixed path parts (`rest-api-v1`);
 * `depth` adds one more part when a shard would pass SHARD_BYTES.
 */
function shardOf(call: string, depth: number): string {
  const rest = /^[A-Z]+ (\/.*)$/.exec(call);
  if (rest)
    return [
      'rest',
      ...rest[1]!
        .split('/')
        .filter((x) => x && !x.startsWith(':') && x !== '*')
        .slice(0, depth + 1),
    ]
      .join('-')
      .replace(/[^A-Za-z0-9._-]/g, '_');
  return call.split('.').slice(0, depth).join('.');
}

/** One shard file: each distinct body once, every answer a status and that body's index. One line per body and per call. */
function shardText(calls: string[], g: Golden): string {
  const bodies: string[] = [];
  const index = new Map<string, number>();
  const rows = calls.map((call) => {
    const answers = Object.entries(g.answers[call]!).map(([k, a]) => {
      if (!index.has(a.body)) index.set(a.body, bodies.push(a.body) - 1);
      return `${JSON.stringify(k)}: [${a.status}, ${index.get(a.body)}]`;
    });
    return `    ${JSON.stringify(call)}: { ${answers.join(', ')} }`;
  });
  const inputs = calls.filter((c) => g.inputs[c]).map((c) => `    ${JSON.stringify(c)}: ${JSON.stringify(g.inputs[c])}`);
  return [
    '{',
    `  "inputs": {\n${inputs.join(',\n')}\n  },`,
    `  "bodies": [\n${bodies.map((b) => `    ${JSON.stringify(b)}`).join(',\n')}\n  ],`,
    `  "answers": {\n${rows.join(',\n')}\n  }`,
    '}',
    '',
  ].join('\n');
}

/** Writes the recording in the repo's own format (the format check reads JSON), each shard under SHARD_BYTES. */
async function writeGolden(g: Golden) {
  const prettier = await import('prettier');
  const format = async (name: string, text: string) => {
    const file = goldenJson(name).pathname;
    return prettier.format(text, { ...(await prettier.resolveConfig(file)), filepath: file });
  };
  const files = new Map<string, string>();
  const place = async (calls: string[], depth: number) => {
    const groups = new Map<string, string[]>();
    for (const c of calls) groups.set(shardOf(c, depth), [...(groups.get(shardOf(c, depth)) ?? []), c]);
    for (const [name, group] of groups) {
      const text = await format(name, shardText(group, g));
      if (Buffer.byteLength(text) <= SHARD_BYTES) files.set(name, text);
      else if (depth < 6 && new Set(group.map((c) => shardOf(c, depth + 1))).size > 1) await place(group, depth + 1);
      else throw new Error(`shard ${name} is ${Buffer.byteLength(text)} bytes, over ${SHARD_BYTES}`);
    }
  };
  await place(Object.keys(g.answers), 1);
  rmSync(GOLDEN, { recursive: true, force: true });
  mkdirSync(GOLDEN);
  writeFileSync(goldenJson('callers'), await format('callers', JSON.stringify(g.callers)));
  for (const [name, text] of files) writeFileSync(goldenJson(name), text);
}

function readGolden(): Golden {
  const g: Golden = {
    callers: JSON.parse(readFileSync(new URL('./wire-replay.golden/callers.json', import.meta.url), 'utf8')),
    inputs: {},
    answers: {},
  };
  for (const file of readdirSync(GOLDEN).filter((f) => f !== 'callers.json')) {
    const shard = JSON.parse(readFileSync(goldenJson(file.replace(/\.json$/, '')), 'utf8')) as {
      inputs: Record<string, Samples>;
      bodies: string[];
      answers: Record<string, Record<string, [number, number]>>;
    };
    Object.assign(g.inputs, shard.inputs);
    for (const [call, answers] of Object.entries(shard.answers))
      g.answers[call] = Object.fromEntries(Object.entries(answers).map(([k, [status, i]]) => [k, { status, body: shard.bodies[i]! }]));
  }
  return g;
}

async function send(
  app: Awaited<ReturnType<typeof serve>>['app'],
  method: string,
  url: string,
  payload: string | undefined,
  h: Record<string, string>,
) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: payload === undefined ? h : { ...h, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload }),
  });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit; an unexpected failure's
  // reference is a fresh random id; a time the service reads from its clock moves with every run.
  return {
    status: res.statusCode,
    body: res.body
      .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, (id) => (id === USER || id === ID ? id : '<uuid>'))
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (t) =>
        t.startsWith('2026-01-01T00:00:00') || t.startsWith('2099') ? t : '<time>',
      )
      .replace(/"(asOf|asOfMs|serverTime|now|at|observedAt|generatedAt)":\d{12,}/g, '"$1":"<ms>"'),
  };
}

async function replay(recorded: Golden['inputs'] | null): Promise<Golden> {
  const routes: Array<{ method: string; url: string; body: unknown }> = [];
  const { app, router } = await serve(routes);
  const anyRouter: AnyRouter = router;
  const procedures: Record<string, Proc> = anyRouter._def.procedures;
  const answers: Golden['answers'] = {};
  const samples: Golden['inputs'] = {};
  try {
    for (const path of Object.keys(procedures).sort()) {
      const proc = procedures[path]!;
      if (proc._def.type === 'subscription') continue;
      // A call missing from the recording gets samples from its schema; its answers then match no recorded key and fail.
      samples[path] = recorded?.[path] ?? samplesOf(sampleInput(proc));
      const query = proc._def.type === 'query';
      for (const [inputName, input] of inputs(samples[path])) {
        const url = `/trpc/${path}${query && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
        const payload = query ? undefined : input === undefined ? '' : JSON.stringify(input);
        for (const [callerName, caller] of CALLERS)
          (answers[path] ??= {})[`${inputName} ${callerName}`] = await send(app, query ? 'GET' : 'POST', url, payload, headers(caller));
        // Every call is also sent signed by each service, with no person.
        for (const service of SERVICES)
          (answers[path] ??= {})[`${inputName} ${service}`] = await send(
            app,
            query ? 'GET' : 'POST',
            url,
            payload,
            serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
          );
      }
    }
    // HTTP: every route, path parameters filled with one id; a body-taking route gets the same six bodies.
    for (const route of [...routes].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`))) {
      const name = `${route.method} ${route.url}`;
      const url = route.url.replace(/:[A-Za-z_]+/g, ID).replace(/\*$/, 'any');
      const takesBody = route.method !== 'GET' && route.method !== 'DELETE';
      if (takesBody) samples[name] = recorded?.[name] ?? samplesOf(route.body === undefined ? {} : sample(route.body));
      const bodies: Array<[string, unknown]> = takesBody ? inputs(samples[name]!) : [['absent', undefined]];
      for (const [inputName, input] of bodies) {
        const payload = takesBody ? (input === undefined ? '' : JSON.stringify(input)) : undefined;
        for (const [callerName, caller] of CALLERS)
          (answers[name] ??= {})[`${inputName} ${callerName}`] = await send(app, route.method, url, payload, headers(caller));
        for (const service of SERVICES)
          (answers[name] ??= {})[`${inputName} ${service}`] = await send(
            app,
            route.method,
            url,
            payload,
            serviceAuthHeadersForBody(service, INTERNAL, payload ?? ''),
          );
      }
    }
  } finally {
    await app.close();
  }
  return { callers: procedureCallers(router as never), inputs: samples, answers };
}

describe('the wire replay: svc-trade answers every trade call as recorded', () => {
  beforeEach(() => {
    // The package's setup file turns the futures switches on before each test; this stack has every setting blank.
    for (const name of ['TRADE_FUTURES_ENABLED', 'TRADE_FUTURES_JOBS_ENABLED', 'TRADE_COLLATERAL_HAIRCUT_BPS']) delete process.env[name];
  });
  afterAll(() => {
    for (const name of Object.keys(process.env)) if (!(name in SAVED_ENV)) delete process.env[name];
    Object.assign(process.env, SAVED_ENV);
  });

  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const write = process.env.WIRE_REPLAY_WRITE === '1';
    const now = await replay(write ? null : readGolden().inputs);
    if (write) await writeGolden(now);
    const golden = readGolden();
    expect(now.callers).toEqual(golden.callers);
    expect(now.inputs).toEqual(golden.inputs);
    const flat = (g: Golden) =>
      Object.fromEntries(Object.entries(g.answers).flatMap(([call, a]) => Object.entries(a).map(([k, v]) => [`${call} ${k}`, v])));
    const was = flat(golden);
    const is = flat(now);
    expect(Object.keys(is).sort()).toEqual(Object.keys(was).sort());
    const diffs = Object.entries(was)
      .filter(([key, a]) => is[key]?.status !== a.status || is[key]?.body !== a.body)
      .map(([key, a]) => `${key}: ${a.status} ${a.body.slice(0, 160)} != ${is[key]?.status} ${is[key]?.body.slice(0, 160)}`);
    expect(diffs).toEqual([]);
  }, 600_000);
  it('names an answer schema on every call but the ones still to do, and that count only falls', async () => {
    const { app, router } = await serve([]);
    try {
      const anyRouter: AnyRouter = router;
      const procedures: Record<string, { _def: { type: string; output?: unknown } }> = anyRouter._def.procedures;
      const answerless = Object.keys(procedures)
        .filter((path) => procedures[path]!._def.type !== 'subscription' && procedures[path]!._def.output === undefined)
        .sort();
      expect(answerless.length).toBeLessThanOrEqual(ANSWERLESS_AT_MOST);
    } finally {
      await app.close();
    }
  }, 600_000);
});
