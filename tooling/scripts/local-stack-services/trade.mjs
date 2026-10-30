import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/trade.json.`);
  return entry.value;
}

/** The TEST desk law, with its settle window, its minimum or its asset list left out when the switch says so. */
function otcDeskLaw() {
  const law = JSON.parse(testValue('TRADE_OTC_DESK_LAW'));
  if (process.env.LOCAL_STACK_TRADE_OTC_SETTLE_WINDOW === 'off') delete law.settleWindowMs;
  if (process.env.LOCAL_STACK_TRADE_OTC_MIN_NOTIONAL === 'off') delete law.minNotional;
  if (process.env.LOCAL_STACK_TRADE_OTC_ASSETS === 'off') delete law.assets;
  return JSON.stringify(law);
}

/** The TEST provider list, left blank when the switch says so. */
function otcMakerDirectory() {
  return process.env.LOCAL_STACK_TRADE_OTC_MAKERS === 'off' ? '' : testValue('TRADE_OTC_MAKER_DIRECTORY');
}

export default ({ c, secrets, dbUrl, urlOf, PORTS, TEST_FUTURES_LADDER_POLICY }) => ({
  name: 'trade',
  env: () => ({
    ...c('svc-trade', PORTS.trade),
    DATABASE_URL: dbUrl('svc_trade', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    MATCHING_URL: urlOf('matching'),
    TOKEN_URL: urlOf('token'), // OTC stake tiers; picked up the next time trade restarts
    IDENTITY_ADMISSION_SECRET: secrets.tradeAdmission,
    // LOCAL TEST owner risk limits, not owner decisions: the stack stands in for the owner
    // under Nitro's 2026-10-13 option B. pretrade-credit.ts only requires them to be published
    // integers; it does not compare orders against them. Test funds only.
    // LOCAL TEST tape history (local-test-market.mjs history): svc-trade's signed route that moves TEST tape fills
    // into the past. svc-trade refuses to start with it outside APP_ENV dev/test (spot/local-test-tape.ts).
    TRADE_LOCAL_TEST_TAPE_RETIME: 'on',
    // 100,000: an order above it is still one the TEST book's depth can mark when split (J-derivatives-02 #5).
    TRADE_MAX_ORDER: '100000',
    TRADE_MAX_POSITION: '5000000',
    TRADE_MAX_LOSS: '100000',
    // LOCAL TEST, not an owner decision (option B, 2026-10-13): realistic retail-exchange commercial values.
    // Market buys are funded at bestAsk x (1 + cap) and refuse trade.slippage_cap_unset without it
    // (services/svc-trade/src/env.ts TRADE_MARKET_SLIPPAGE_CAP_BPS): 50 bps.
    TRADE_MARKET_SLIPPAGE_CAP_BPS: '50',
    // House edge on Convert quotes; convert.quote refuses trade.convert_spread_unset without it: 20 bps.
    TRADE_CONVERT_SPREAD_BPS: '20',
    // How long a firm Convert quote binds; refuses trade.convert_quote_ttl_unset without it: 15 s.
    TRADE_CONVERT_QUOTE_TTL_MS: '15000',
    // LOCAL TEST, not an owner decision (option B, 2026-10-13): the dead-man switch (cancel-all-after) timeouts, in
    // seconds, as retail exchanges publish them (OKX accepts 10 to 120). Without them arming refuses
    // trade.cancel_all_after_unset. The sweep runs every second here so a journey does not wait on the 5 s default.
    TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC: '10,30,60,120',
    TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS: '1000',
    // LOCAL TEST, not an owner decision: how often the fee tier snapshot job looks for a due snapshot. It runs a
    // snapshot only when the schedule in force has a tier programme with a snapshot time (spot/fee-tier-jobs.ts), so
    // with the boot schedule below it does nothing; J-cex-spot-10 #5-#6 publishes a TEST programme. Blank is off.
    TRADE_FEE_TIER_JOBS_INTERVAL_MS: '5000',
    TRADE_VIP_PROOF_KEY: secrets.tradeVipProofKey,
    // LOCAL TEST, not an owner decision (option B, 2026-10-13). Fee schedule reference: OKX's public
    // regular-user spot tier, maker 8 bps, taker 10 bps, no maker rebate (makerRebateBps omitted).
    // Without it trade refuses every order with 400 trade.fee_schedule_blank
    // (services/svc-trade/src/spot/fee-schedule.ts, trade-service.ts assertOwnerFeeSchedulePublished).
    // The perpetual block is LOCAL TEST too: the regular-tier perpetual rates OKX is widely reported to publish,
    // maker 2 bps and taker 5 bps (not checked against its own page). Futures orders keep these rates; without the
    // block they refuse trade.fee_product_unpublished (svc-trade futures/matched-order-plan.ts perpetualFeeRates).
    TRADE_FEE_SCHEDULE: JSON.stringify({
      published: true,
      version: 'local-test:okx-regular-spot-reference',
      makerBps: '8',
      takerBps: '10',
      perpetual: { makerBps: '2', takerBps: '5' },
    }),
    // LOCAL TEST futures, not owner decisions (option B, 2026-10-13), for the derivatives journeys. The one listing is
    // the labelled TEST perpetual `local-test-gates.mjs futures` lists (`test = true`, shown only with TRADE_FUTURES_TEST_SEED).
    // Opens refuse trade.futures_unconfigured without a profit source, and liquidation prices stay unknown without
    // the ladder. The ladder is the coarse mechanism-test table (ladder-policy.test-harness.ts), not a risk opinion.
    TRADE_FUTURES_ENABLED: 'true',
    TRADE_FUTURES_TEST_SEED: 'true',
    TRADE_FUTURES_JOBS_ENABLED: 'true',
    TRADE_FUTURES_PROFIT_SOURCE: 'house:futures-loss:available',
    TRADE_FUTURES_LADDER_POLICY: JSON.stringify(TEST_FUTURES_LADDER_POLICY),
    // The code's own ceiling (DIRECTION §1); the TEST listing caps itself lower. Markets show orderable only with it.
    TRADE_FUTURES_MAX_LEVERAGE: '10',
    // Futures orders through the one book (futures ADR 2026-10-20): no open at mark. The TEST perpetual is marked
    // from the TEST spot book it names, so its own empty book can take a first order; the band is a LOCAL TEST 5%.
    TRADE_FUTURES_MATCHING_ENABLED: 'true',
    TRADE_FUTURES_PRICE_BAND: '0.05',
    // Take-profit, stop-loss and stop orders are armed only while their trigger job runs; a fired one places a
    // reduce-only order in the book. Every 2 s here so a journey sees a crossing promptly (the env allows 1 s to 1 h).
    TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED: 'true',
    TRADE_FUTURES_CONDITIONAL_JOBS_INTERVAL_MS: '2000',
    // LOCAL TEST collateral haircut, not an owner decision: 0 bps on cash in the settle asset, as large venues are widely
    // reported to count USDT margin in full. Without it every futures open refuses trade.haircut_unset.
    TRADE_COLLATERAL_HAIRCUT_BPS: '0',
    TRADE_FUTURES_INDEX_SPOT_MARKETS: 'BTC/USDT:USDT=BTC/USDT',
    // LOCAL TEST, not owner decisions: copy trading's leader fee share, country list, risk disclosure and lead-page
    // metric definitions, read from the labelled TEST profile so the copy journeys run on TEST money. Each one
    // blank refuses by name (services/svc-trade/src/env.ts); production stays blank until the owner sets it.
    TRADE_COPY_FEE_SHARE_LAW: testValue('TRADE_COPY_FEE_SHARE_LAW'),
    TRADE_COPY_JURISDICTION_LAW: testValue('TRADE_COPY_JURISDICTION_LAW'),
    TRADE_COPY_METRIC_DEFINITIONS: testValue('TRADE_COPY_METRIC_DEFINITIONS'),
    TRADE_COPY_MIN_TIER: testValue('TRADE_COPY_MIN_TIER'),
    // LOCAL TEST, not an owner decision: the lowest tier that may create a bot. Blank refuses every bot
    // (trade.bots_verification_level_not_set, algo/bots-verification.ts), which a unit test keeps proving.
    // `LOCAL_STACK_TRADE_BOTS_LEVEL=blank` on a restart leaves it blank, so J-copy-bots-otc-14 #2 sees every bot refused.
    TRADE_BOTS_VERIFICATION_LEVEL: process.env.LOCAL_STACK_TRADE_BOTS_LEVEL === 'blank' ? '' : testValue('TRADE_BOTS_VERIFICATION_LEVEL'),
    // LOCAL TEST, not owner decisions: the grid counts a spot grid bot may use. Either blank refuses every grid create
    // (trade.grid_count_range_not_set, grid/policy.ts); production stays blank until the owner sets them.
    TRADE_GRID_COUNT_MIN: testValue('TRADE_GRID_COUNT_MIN'),
    TRADE_GRID_COUNT_MAX: testValue('TRADE_GRID_COUNT_MAX'),
    // LOCAL TEST, not an owner decision: how far a grid bound may sit from the market price. Blank refuses every grid
    // create (trade.bots_grid_bounds_band_not_set, grid/policy.ts); production stays blank until the owner sets it.
    // `LOCAL_STACK_TRADE_GRID_BAND=blank` on a restart leaves it blank, so J-copy-bots-otc-14 #4 sees that refusal.
    TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS:
      process.env.LOCAL_STACK_TRADE_GRID_BAND === 'blank' ? '' : testValue('TRADE_GRID_BOUNDS_MAX_DISTANCE_BPS'),
    // LOCAL TEST, not an owner decision: the copy driver places each copy as the follower, so J-copy-bots-otc-01 #8
    // sees a first copied trade on TEST money. Production leaves it off until the owner turns copy placing on.
    TRADE_COPY_PLACE_MIRROR: 'on',
    // LOCAL TEST, not an owner decision: the TWAP slice scheduler runs, so a bot made on the stack is a live schedule on
    // TEST money. With it off every create refuses trade.algo_jobs_disabled (algo/jobs-gate.ts), which unit tests keep
    // proving. Production leaves it off until an operator turns it on.
    // LOCAL_STACK_TRADE_ALGO_JOBS=off restarts trade with it off, so J-copy-bots-otc-23 #2 sees the scheduler-off refusal.
    TRADE_ALGO_JOBS_ENABLED: process.env.LOCAL_STACK_TRADE_ALGO_JOBS === 'off' ? 'off' : 'on',
    // LOCAL TEST, not owner decisions: the quote desk's law and its reference price, read from the labelled TEST profile
    // so the OTC journeys price, accept and settle on TEST money against the house inventory.
    // Each one blank refuses by name (services/svc-trade/src/otc/); production stays blank until the owner sets it.
    // `LOCAL_STACK_TRADE_OTC_SETTLE_WINDOW=off` on a start or restart leaves the law's settle window blank (no deferral),
    // so its "Not set" state can be seen too (J-copy-bots-otc-24 #7). `LOCAL_STACK_TRADE_OTC_MIN_NOTIONAL=off` leaves the
    // desk minimum blank, so a request refuses `trade.rfq_size_not_set` (J-copy-bots-otc-24 #4).
    // `LOCAL_STACK_TRADE_OTC_MAKERS=off` leaves the provider list blank, so a request refuses "No providers set" (#2).
    // `LOCAL_STACK_TRADE_OTC_ASSETS=off` leaves the desk's asset list blank, so the overview reads "Not set" and a request
    // refuses `trade.otc_assets_unset` (#1).
    TRADE_OTC_DESK_LAW: otcDeskLaw(),
    TRADE_OTC_MAKER_DIRECTORY: otcMakerDirectory(),
    TRADE_OTC_MIDS: testValue('TRADE_OTC_MIDS'),
    // LOCAL TEST ONLY, not an owner decision: the developer portal's hosts, regional host rule and data terms
    // (J-developer-01 #2, #3, #6). `LOCAL_STACK_TRADE_DEVELOPER_HOSTS=off`, `LOCAL_STACK_TRADE_DEVELOPER_REGIONAL_RULE=off`
    // or `LOCAL_STACK_TRADE_DEVELOPER_DATA_TERMS=off` on a start or restart leaves that setting blank, so its refusal can be
    // seen too.
    ...(process.env.LOCAL_STACK_TRADE_DEVELOPER_HOSTS === 'off' ? {} : { TRADE_DEVELOPER_HOSTS: testValue('TRADE_DEVELOPER_HOSTS') }),
    ...(process.env.LOCAL_STACK_TRADE_DEVELOPER_REGIONAL_RULE === 'off'
      ? {}
      : { TRADE_DEVELOPER_REGIONAL_RULE: testValue('TRADE_DEVELOPER_REGIONAL_RULE') }),
    ...(process.env.LOCAL_STACK_TRADE_DEVELOPER_DATA_TERMS === 'off'
      ? {}
      : { TRADE_DEVELOPER_DATA_TERMS: testValue('TRADE_DEVELOPER_DATA_TERMS') }),
  }),
});
