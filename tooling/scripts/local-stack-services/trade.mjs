import { startCustodyLayer } from '../local-test-state.mjs';
import path from 'node:path';
import { userVenueCount, userVenueKind, userVenueSwitchOn } from '../local-test-venue.mjs';
import { loadProfile } from '../owner-settings.mjs';

/** One labelled TEST value from this service's profile file; a missing one names the file instead of a bare TypeError. */
function testValue(name) {
  const entry = loadProfile().values[name];
  if (!entry) throw new Error(`${name} is missing from tooling/profiles/test-owner-values/trade.json.`);
  return entry.value;
}

/**
 * The TEST developer hosts. `LOCAL_STACK_TRADE_DEVELOPER_HOSTS=regional` adds a TEST regional host for every protocol,
 * named from its production host under the reserved .test domain, so J-developer-01 #3 can see the redundant endpoint
 * with its hosts set; the profile leaves regional out, so by default those rows read "host not set".
 */
/** The least venue balance to lead on a restart: `blank` leaves it blank, a decimal sets it, unset is the TEST value. */
function leadBalance(raw, testDefault) {
  if (raw === 'blank') return '';
  if (raw && /^\d+(\.\d+)?$/.test(raw)) return raw;
  return testDefault;
}

function developerHosts() {
  const hosts = JSON.parse(testValue('TRADE_DEVELOPER_HOSTS'));
  if (process.env.LOCAL_STACK_TRADE_DEVELOPER_HOSTS === 'regional') {
    for (const protocol of Object.keys(hosts)) hosts[protocol].regional = `regional.${hosts[protocol].production}`;
  }
  return JSON.stringify(hosts);
}

/** The TEST desk law, with its settle window, its minimum, its asset list or its level left out when the switch says so. */
function otcDeskLaw() {
  const law = JSON.parse(testValue('TRADE_OTC_DESK_LAW'));
  if (process.env.LOCAL_STACK_TRADE_OTC_SETTLE_WINDOW === 'off') delete law.settleWindowMs;
  if (process.env.LOCAL_STACK_TRADE_OTC_MIN_NOTIONAL === 'off') delete law.minNotional;
  if (process.env.LOCAL_STACK_TRADE_OTC_ASSETS === 'off') delete law.assets;
  if (process.env.LOCAL_STACK_TRADE_OTC_MIN_TIER === 'off') delete law.minTier;
  return JSON.stringify(law);
}

/** The TEST size range for a conversion at the desk price, left blank when the switch says so. */
function otcConvertBounds() {
  return process.env.LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS === 'off' ? '' : testValue('TRADE_OTC_CONVERT_BOUNDS');
}

/** The TEST provider list, left blank when the switch says so. */
function otcMakerDirectory() {
  if (process.env.LOCAL_STACK_TRADE_OTC_MAKERS === 'off') return '';
  const directory = JSON.parse(testValue('TRADE_OTC_MAKER_DIRECTORY'));
  // Blank spreads: every outside provider loses its LOCAL TEST spread, so a request to one refuses by name (#5).
  if (process.env.LOCAL_STACK_TRADE_OTC_SPREADS === 'off') for (const maker of directory.makers) delete maker.spreadBps;
  return JSON.stringify(directory);
}

export default ({ c, secrets, dbUrl, urlOf, PORTS, P, TEST_FUTURES_LADDER_POLICY }) => ({
  name: 'trade',
  env: () => ({
    ...c('svc-trade', PORTS.trade),
    DATABASE_URL: dbUrl('svc_trade', secrets),
    LEDGER_URL: urlOf('ledger'),
    IDENTITY_URL: urlOf('identity'),
    BANK_URL: urlOf('bank'), // the partner's cash leg of a cash convert, asked as the person (J-cex-spot-11 #11)
    AGENTS_URL: urlOf('agents'), // the own agent's gate before its allowance or order (J-agents-08 #4 #6)
    CAMPAIGNS_URL: urlOf('campaigns'), // a person's fee-saver coupon on our builder fee (J-campaigns-09 #2 #3)
    QUANT_URL: urlOf('quant'), // the strategy version a live run trades, read as the person (J-algo-dev-07)
    MATCHING_URL: urlOf('matching'),
    // Our own order book's spot plane follows the custody switch (OWNER 288): unset, TRADE_SPOT_ENABLED is on only with
    // LEDGER_CUSTODY_LAYER on. The same value as svc-ledger's (ledger.mjs, startCustodyLayer), as matching.mjs carries.
    LEDGER_CUSTODY_LAYER: startCustodyLayer(),
    NOTIFY_URL: urlOf('notify'), // market maintenance windows on the lifecycle read (J-cex-spot-14 #5)
    TOKEN_URL: urlOf('token'), // OTC stake tiers; picked up the next time trade restarts
    IDENTITY_ADMISSION_SECRET: secrets.tradeAdmission,
    // LOCAL TEST owner risk limits, not owner decisions: the stack stands in for the owner
    // under Nitro's 2026-10-13 option B. pretrade-credit.ts only requires them to be published
    // integers; it does not compare orders against them. Test funds only.
    // LOCAL TEST tape history (local-test-market.mjs history): svc-trade's signed route that moves TEST tape fills
    // into the past. svc-trade refuses to start with it outside APP_ENV dev/test (spot/local-test-tape.ts).
    TRADE_LOCAL_TEST_TAPE_RETIME: 'on',
    // The TEST age door (packages/service-kit test-age.ts): a journey makes one TEST OTC quote older instead of waiting
    // out its expiry or settle window. svc-trade refuses to start with it outside APP_ENV dev/test or under NODE_ENV=production.
    TEST_AGE_DOOR: 'on',
    // 100,000: an order above it is still one the TEST book's depth can mark when split (J-derivatives-02 #5).
    TRADE_MAX_ORDER: '100000',
    TRADE_MAX_POSITION: '5000000',
    TRADE_MAX_LOSS: '100000',
    // LOCAL TEST, not an owner decision (option B, 2026-10-13): realistic retail-exchange commercial values.
    // Market buys are funded at bestAsk x (1 + cap) and refuse trade.slippage_cap_unset without it
    // (services/svc-trade/src/env.ts TRADE_MARKET_SLIPPAGE_CAP_BPS): 50 bps. `LOCAL_STACK_TRADE_SLIPPAGE_CAP=off` on a restart
    // leaves it blank, so J-derivatives-02 #5 sees a market open refused by name (trade.slippage_cap_unset).
    TRADE_MARKET_SLIPPAGE_CAP_BPS: process.env.LOCAL_STACK_TRADE_SLIPPAGE_CAP === 'off' ? '' : '50',
    // LOCAL TEST, not an owner decision: the spread limit a venue spot market order is refused past (services/svc-trade/src/
    // env.ts TRADE_MARKET_SPREAD_LIMIT_BPS): 100 bps, wide of the TEST venue's ladder. `LOCAL_STACK_TRADE_SPREAD_LIMIT=off`
    // on a restart leaves it blank, so J-cex-spot-03 #2 sees a market order refused "protection not set".
    TRADE_MARKET_SPREAD_LIMIT_BPS: process.env.LOCAL_STACK_TRADE_SPREAD_LIMIT === 'off' ? '' : '100',
    // LOCAL TEST: the close tolerance a stop's market exit and a reduce-only close cross by (services/svc-trade/src/env.ts
    // TRADE_CLOSE_SLIPPAGE_BPS): 1000 bps, 10%. `LOCAL_STACK_TRADE_CLOSE_SLIPPAGE=off` on a restart leaves it blank, so every
    // such close is refused by name (trade.close_slippage_unset).
    TRADE_CLOSE_SLIPPAGE_BPS: process.env.LOCAL_STACK_TRADE_CLOSE_SLIPPAGE === 'off' ? '' : '1000',
    // The operator's Convert kill-switch, on as in production. `LOCAL_STACK_TRADE_CONVERT=off` on a restart turns it off,
    // so J-cex-spot-11 #7 sees Convert paused: every quote refuses trade.convert_disabled and the room says Use Spot.
    TRADE_CONVERT_ENABLED: process.env.LOCAL_STACK_TRADE_CONVERT === 'off' ? 'false' : 'true',
    // House edge on Convert quotes; convert.quote refuses trade.convert_spread_unset without it: 20 bps.
    TRADE_CONVERT_SPREAD_BPS: '20',
    // LOCAL TEST, not owner decisions: the operator reconcile sweep (J-cex-spot-18 #3) is switched on here, with a size and
    // an age floor. Off or blank, the sweep refuses (reconcile_sweep_disabled, reconcile_sweep_unconfigured). 15 s is the
    // stack's own guess at how long a fill takes to reach trade.fills; a hold is released only on a second sighting of
    // its order's engine miss at least that long after the first.
    TRADE_OPERATOR_SWEEP_ENABLED: 'true',
    TRADE_OPERATOR_SWEEP_LIMIT: '500',
    TRADE_OPERATOR_SWEEP_MIN_AGE_SECONDS: '15',
    // LOCAL TEST, not an owner decision: how often the limit-convert sweep prices each waiting limit convert. Without it
    // no sweep runs and placing one refuses trade.convert_limit_unset; every 2 s so J-cex-spot-11 #8 sees its fill soon.
    TRADE_CONVERT_LIMIT_SWEEP_INTERVAL_MS: '2000',
    // LOCAL TEST, not an owner decision: how often the seed job looks at the operator-written seeding configuration
    // (J-cex-spot-20 #5). Seeding itself stays off: TRADE_MM_SEED_ENABLED is unset and no market has an approved row
    // until a journey writes one. Every 5 s (the env's floor) so J-cex-spot-20 #4 sees the seed soon.
    TRADE_MM_SEED_INTERVAL_MS: '5000',
    // The seed job's last-run record, in the stack's own state folder. Its default is relative to the service's folder in
    // the checkout, where the build stamp reads it as a source edit, so the next restart rebuilds everything (#7463).
    TRADE_MM_SEED_STATE_PATH: path.join(P.data, 'mm-seed-last-run.json'),
    // How long a firm Convert quote binds; refuses trade.convert_quote_ttl_unset without it: 15 s.
    TRADE_CONVERT_QUOTE_TTL_MS: '15000',
    // How long a venue Convert price may be accepted before a fresh one must be (J-cex-spot-11 #4); the venue holds no
    // price. The labelled TEST value; venue convert quotes refuse trade.convert_window_unset without it.
    TRADE_CONVERT_ACCEPT_WINDOW_MS: testValue('TRADE_CONVERT_ACCEPT_WINDOW_MS'),
    // LOCAL TEST, not an owner decision (option B, 2026-10-13): the dead-man switch (cancel-all-after) timeouts, in
    // seconds, as retail exchanges publish them (OKX accepts 10 to 120). Without them arming refuses
    // trade.cancel_all_after_unset. The sweep runs every second here so a journey does not wait on the 5 s default.
    TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC: '10,30,60,120',
    TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS: '1000',
    // LOCAL TEST, not an owner decision: how often the fee tier snapshot job looks for a due snapshot. It runs a
    // snapshot only when the schedule in force has a tier programme with a snapshot time (spot/fee-tier-jobs.ts), so
    // with the boot schedule below it does nothing; J-cex-spot-10 #5-#6 publishes a TEST programme. Blank is off.
    TRADE_FEE_TIER_JOBS_INTERVAL_MS: '5000',
    // LOCAL TEST, not an owner decision (RC-cex-spot-05; J-cex-spot-15 #10): book snapshot capture interval and
    // historical dataset materializer tick. `LOCAL_STACK_TRADE_HISTORY_BOOK_INTERVAL=off` leaves the owner book
    // interval blank so book datasets refuse `trade.history_book_interval_unset`.
    TRADE_HISTORY_BOOK_INTERVAL_MS:
      process.env.LOCAL_STACK_TRADE_HISTORY_BOOK_INTERVAL === 'off' ? '' : testValue('TRADE_HISTORY_BOOK_INTERVAL_MS'),
    TRADE_HISTORY_JOBS_INTERVAL_MS: '2000',
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
    // `LOCAL_STACK_TEST_MARKETS=off` (the beta's stack, tooling/beta/beta-host.mjs) keeps every `test = true` listing off
    // the board and refuses it by symbol: the journeys' TEST fixtures (an untraded book, a shut session, a delisting) are
    // not markets a tester can use (#10599). The rows stay in the database and come back with the switch.
    TRADE_FUTURES_TEST_SEED: process.env.LOCAL_STACK_TEST_MARKETS === 'off' ? 'false' : 'true',
    TRADE_FUTURES_JOBS_ENABLED: 'true',
    TRADE_FUTURES_PROFIT_SOURCE: 'house:futures-loss:available',
    // `LOCAL_STACK_TRADE_FUTURES_LADDER=off` on a restart leaves the ladder blank, so J-derivatives-02 #2 sees "tiers
    // not published" and an open refused on the ladder code.
    TRADE_FUTURES_LADDER_POLICY: process.env.LOCAL_STACK_TRADE_FUTURES_LADDER === 'off' ? '' : JSON.stringify(TEST_FUTURES_LADDER_POLICY),
    // LOCAL TEST liquidation mark limits, not an owner publication (MKT-0057): the code's own compiled 300 s / 60 s /
    // 2000 bps, set here so the TEST perpetual's liquidation runs on the stack (J-derivatives-04 #2). Blank, as in
    // production until the owner publishes them, the tick refuses every liquidation with trade.mark_unusable.
    TRADE_FUTURES_LIQUIDATION_LIMITS: JSON.stringify({ maxAgeSeconds: 300, liquidationMaxAgeSeconds: 60, maxDeviationBps: 2000 }),
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
    // LOCAL TEST, not owner decisions: the charts module's fallback feed source list and its audit export row limit
    // (J-charts-desk-19 #3 #4). `LOCAL_STACK_TRADE_CHART_FALLBACK=blank` on a restart leaves the list blank, so a switch
    // to a fallback refuses trade.chart_feed.fallback_sources_unset. Production stays blank until the owner sets both.
    TRADE_CHART_FEED_FALLBACK_SOURCES:
      process.env.LOCAL_STACK_TRADE_CHART_FALLBACK === 'blank' ? '' : testValue('TRADE_CHART_FEED_FALLBACK_SOURCES'),
    TRADE_CHART_CONTROL_EXPORT_ROW_LIMIT: testValue('TRADE_CHART_CONTROL_EXPORT_ROW_LIMIT'),
    // `LOCAL_STACK_TRADE_COPY_JURISDICTION=blank` on a restart leaves the country list blank, so J-copy-bots-otc-01 #5
    // sees every follow refused.
    TRADE_COPY_JURISDICTION_LAW:
      process.env.LOCAL_STACK_TRADE_COPY_JURISDICTION === 'blank' ? '' : testValue('TRADE_COPY_JURISDICTION_LAW'),
    TRADE_COPY_METRIC_DEFINITIONS: testValue('TRADE_COPY_METRIC_DEFINITIONS'),
    TRADE_COPY_MIN_TIER: testValue('TRADE_COPY_MIN_TIER'),
    TRADE_COPY_LEAD_REAPPLY_WAIT_SECONDS: testValue('TRADE_COPY_LEAD_REAPPLY_WAIT_SECONDS'),
    // `LOCAL_STACK_TRADE_COPY_LEAD_BALANCE=blank` on a restart leaves the least venue balance to lead blank, so
    // J-copy-bots-otc-04 #1 sees every application refused naming the threshold; a decimal there sets it instead, so
    // J-copy-bots-otc-04 #7 sees a lead under the equity minimum refused. Unset: the TEST value.
    TRADE_COPY_LEAD_MIN_VENUE_USDC: leadBalance(
      process.env.LOCAL_STACK_TRADE_COPY_LEAD_BALANCE,
      testValue('TRADE_COPY_LEAD_MIN_VENUE_USDC'),
    ),
    TRADE_COPY_LEAD_MISSION_MIN_USDC: testValue('TRADE_COPY_LEAD_MISSION_MIN_USDC'),
    TRADE_COPY_LEAD_DAILY_BUY_CAP: testValue('TRADE_COPY_LEAD_DAILY_BUY_CAP'),
    TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS: testValue('TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS'),
    // `LOCAL_STACK_TRADE_COPY_MIN_INVESTMENT=off` on a restart leaves the minimum blank, so J-copy-bots-otc-02 #2 sees
    // every follow refused with `trade.copy_min_not_set`.
    TRADE_COPY_MIN_INVESTMENT: process.env.LOCAL_STACK_TRADE_COPY_MIN_INVESTMENT === 'off' ? '' : testValue('TRADE_COPY_MIN_INVESTMENT'),
    // `LOCAL_STACK_TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES=<whole minutes>` on a restart moves the TEST owner day, so
    // J-copy-bots-otc-02 #3 can see a real owner day begin within its run; it puts the TEST value back after.
    TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES:
      process.env.LOCAL_STACK_TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES ?? testValue('TRADE_COPY_DAY_START_UTC_OFFSET_MINUTES'),
    TRADE_SIGNAL_MAX_ALERT_AGE_SECONDS: testValue('TRADE_SIGNAL_MAX_ALERT_AGE_SECONDS'),
    TRADE_SIGNAL_WEBHOOK_DAYS: testValue('TRADE_SIGNAL_WEBHOOK_DAYS'),
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
    // LOCAL TEST, not an owner decision: the daily cap on grid bot profit withdrawals (owner setting
    // trade.bots_withdraw_daily_cap). Blank refuses every withdrawal (trade.bots_withdraw_cap_unset, grid/policy.ts);
    // production stays blank until the owner sets it. `LOCAL_STACK_TRADE_BOTS_WITHDRAW_CAP=blank` on a restart leaves it
    // blank, so J-copy-bots-otc-14 #7 sees that refusal.
    TRADE_BOTS_WITHDRAW_DAILY_CAP:
      process.env.LOCAL_STACK_TRADE_BOTS_WITHDRAW_CAP === 'blank' ? '' : testValue('TRADE_BOTS_WITHDRAW_DAILY_CAP'),
    // LOCAL TEST, not an owner decision: the window the operator module counts quotes in. Blank refuses the metrics read
    // (trade.ops_metrics_window_not_set, admin/copy-bots-otc.ts), which a unit test keeps proving.
    // `LOCAL_STACK_TRADE_OPS_METRICS_WINDOW=off` on a start or restart leaves it blank, so J-copy-bots-otc-13 #1 sees
    // that refusal on the screen.
    ...(process.env.LOCAL_STACK_TRADE_OPS_METRICS_WINDOW === 'off'
      ? {}
      : { TRADE_OPS_METRICS_WINDOW_SECONDS: testValue('TRADE_OPS_METRICS_WINDOW_SECONDS') }),
    // LOCAL TEST, not an owner decision: the copy driver places each copy as the follower, so J-copy-bots-otc-01 #8
    // sees a first copied trade on TEST money. Production leaves it off until the owner turns copy placing on.
    TRADE_COPY_PLACE_MIRROR: 'on',
    // LOCAL TEST, not an owner decision: the TWAP slice scheduler runs, so a bot made on the stack is a live schedule on
    // TEST money. With it off every create refuses trade.algo_jobs_disabled (algo/jobs-gate.ts), which unit tests keep
    // proving. Production leaves it off until an operator turns it on.
    // LOCAL_STACK_TRADE_ALGO_JOBS=off restarts trade with it off, so J-copy-bots-otc-23 #2 sees the scheduler-off refusal.
    TRADE_ALGO_JOBS_ENABLED: process.env.LOCAL_STACK_TRADE_ALGO_JOBS === 'off' ? 'off' : 'on',
    // LOCAL TEST only: `LOCAL_STACK_TEST_REGION_SERVED=off` on a restart adds a TEST business block for the TEST region AA
    // (packages/config jurisdiction.ts testBusinessBlocksFromEnv), and edge.mjs then stamps every request from AA, so the
    // venue door's region gate blocks this account, named on the gated list (J-derivatives-01 #2), as bank.mjs does.
    ...(process.env.LOCAL_STACK_TEST_REGION_SERVED === 'off' ? { INTAFACED_TEST_BUSINESS_BLOCKS: 'TEST:AA' } : {}),
    // LOCAL TEST, not owner decisions: the quote desk's law and its reference price, read from the labelled TEST profile
    // so the OTC journeys price, accept and settle on TEST money against the house inventory.
    // Each one blank refuses by name (services/svc-trade/src/otc/); production stays blank until the owner sets it.
    // `LOCAL_STACK_TRADE_OTC_SETTLE_WINDOW=off` on a start or restart leaves the law's settle window blank (no deferral),
    // so its "Not set" state can be seen too (J-copy-bots-otc-24 #7). `LOCAL_STACK_TRADE_OTC_MIN_NOTIONAL=off` leaves the
    // desk minimum blank, so a request refuses `trade.rfq_size_not_set` (J-copy-bots-otc-24 #4).
    // `LOCAL_STACK_TRADE_OTC_MAKERS=off` leaves the provider list blank, so a request refuses "No providers set" (#2).
    // `LOCAL_STACK_TRADE_OTC_SPREADS=off` leaves every outside provider's spread blank, so asking one refuses
    // `trade.otc_provider_spread_unset` (#5).
    // `LOCAL_STACK_TRADE_OTC_ASSETS=off` leaves the desk's asset list blank, so the overview reads "Not set" and a request
    // refuses `trade.otc_assets_unset` (#1). `LOCAL_STACK_TRADE_OTC_MIN_TIER=off` leaves the desk's verification level
    // blank, so every request refuses `trade.otc_level_unset` (#3). `LOCAL_STACK_TRADE_OTC_CONVERT_BOUNDS=off` leaves the
    // size range for a conversion at the desk price blank, so Convert reads "Not set" and refuses
    // `trade.convert_bounds_not_set` (#9).
    TRADE_OTC_DESK_LAW: otcDeskLaw(),
    TRADE_OTC_MAKER_DIRECTORY: otcMakerDirectory(),
    TRADE_OTC_CONVERT_BOUNDS: otcConvertBounds(),
    TRADE_OTC_MIDS: testValue('TRADE_OTC_MIDS'),
    // LOCAL TEST ONLY, not an owner decision: the developer portal's hosts, regional host rule and data terms
    // (J-developer-01 #2, #3, #6). `LOCAL_STACK_TRADE_DEVELOPER_HOSTS=off`, `LOCAL_STACK_TRADE_DEVELOPER_REGIONAL_RULE=off`
    // or `LOCAL_STACK_TRADE_DEVELOPER_DATA_TERMS=off` on a start or restart leaves that setting blank, so its refusal can be
    // seen too; `LOCAL_STACK_TRADE_DEVELOPER_HOSTS=regional` adds TEST regional hosts (developerHosts).
    // The same switch blanks the stream endpoint hosts (J-developer-09 #1), so the WebSocket page reads "host not set" too.
    ...(process.env.LOCAL_STACK_TRADE_DEVELOPER_HOSTS === 'off'
      ? {}
      : { TRADE_DEVELOPER_HOSTS: developerHosts(), TRADE_DEVELOPER_STREAM_HOSTS: testValue('TRADE_DEVELOPER_STREAM_HOSTS') }),
    ...(process.env.LOCAL_STACK_TRADE_DEVELOPER_REGIONAL_RULE === 'off'
      ? {}
      : { TRADE_DEVELOPER_REGIONAL_RULE: testValue('TRADE_DEVELOPER_REGIONAL_RULE') }),
    ...(process.env.LOCAL_STACK_TRADE_DEVELOPER_DATA_TERMS === 'off'
      ? {}
      : { TRADE_DEVELOPER_DATA_TERMS: testValue('TRADE_DEVELOPER_DATA_TERMS') }),
    // B1 user-venue door: on only with LOCAL_STACK_USER_VENUE=on (the stack validates it and starts the TEST venue,
    // local-test-venue.mjs). Off, trade gets no TRADE_USER_VENUE_URL and nothing changes. The builder address and fee are
    // the labelled LOCAL TEST values; `LOCAL_STACK_USER_VENUE_BUILDER_FEE=off` leaves the fee blank, so every venue order
    // refuses builder_fee_not_published.
    ...(userVenueSwitchOn(process.env.LOCAL_STACK_USER_VENUE)
      ? {
          TRADE_USER_VENUE_URL: urlOf('test-venue'),
          // J-derivatives-28: LOCAL_STACK_USER_VENUE=two adds the second TEST venue; the ticket then routes over both.
          ...(userVenueCount(process.env.LOCAL_STACK_USER_VENUE) === 2 ? { TRADE_USER_VENUE_URLS: urlOf('test-venue-b') } : {}),
          // J-cex-spot-16: the TEST markets the other venue journeys trade, listed as a LOCAL TEST seed (svc-trade
          // venue/venue-listing.ts): the two BTC markets, J-derivatives-03's TEST perpetual ETH-PERP (its trigger orders),
          // J-derivatives-21's TEST gold perpetual XAU-PERP and J-derivatives-27's TEST stock perpetuals XSTK-PERP and
          // XSTD-PERP, J-derivatives-02's TEST perpetual XRSK-PERP (its margin tiers, collateral and open-interest cap), and
          // J-derivatives-07's TEST perpetual XLIQ-PERP (the one the TEST venue liquidates on), and J-derivatives-08's TEST
          // perpetual XFND-PERP (the one whose funding the TEST venue builds and settles).
          // ETH-USDC is left unlisted, for two operators to review.
          // J-derivatives-12's TEST perpetual XBIL-PERP (the one its bills come from: funding, a close and a liquidation).
          // J-derivatives-26's TEST perpetual XCRS-PERP (cross margin, liquidated at the account's cross level).
          // J-derivatives-14's TEST perpetual XDEV-PERP (the one a developer reads and trades through our API).
          // J-charts-desk-21's TEST perpetual XTGM-PERP (isolated margin; its mark moves margin use past 80% and 90%).
          // J-portfolio-19's TEST perpetual XJRN-PERP (the one its journal's "keeping my rules" trades are made on).
          // J-derivatives-32's TEST perpetuals XEXA-PERP and XEXB-PERP (a long's and a short's stops and targets on the chart).
          // PURR-USDC: the one spot pair Hyperliquid's test network trades every day, so the beta's spot desk shows a live book, tape and chart; the TEST venue lists no
          // PURR-USDC, so the seed skips it there.
          // On Hyperliquid's test network, the live stock, index and gold perpetuals of its `xyz` HIP-3 DEX
          // (local-test-venue.mjs HL_TESTNET_PERP_DEXS); the TEST venue lists none of them, so the seed skips them there.
          // Hyperliquid's test network gets no BTC-USDC: that pair has no bids, one stray ask far below BTC and no print since
          // 10 Nov 2026, so it showed a BTC price ten times below the venue's BTC perpetual. The seed delists it on a kept
          // database (svc-trade seedTestListings). A replay of the test network (`hl-recorded`) lists what the live run did.
          TRADE_USER_VENUE_TEST_LISTINGS: [
            ...(userVenueKind(process.env.LOCAL_STACK_USER_VENUE)?.startsWith('hl-') ? [] : ['BTC-USDC']),
            'PURR-USDC,BTC-PERP,ETH-PERP,XAU-PERP,XSTK-PERP,XSTD-PERP,XRSK-PERP,XLIQ-PERP,XFND-PERP,XBIL-PERP,XCRS-PERP,XDEV-PERP,XJRN-PERP,XTGM-PERP,XEXA-PERP,XEXB-PERP',
            'xyz:TSLA-PERP,xyz:NVDA-PERP,xyz:AAPL-PERP,xyz:XYZ100-PERP,xyz:GOLD-PERP,xyz:SILVER-PERP',
          ].join(','),
          // J-derivatives-12 #5: the labelled TEST eligibility level for the venue's perpetuals;
          // `LOCAL_STACK_USER_VENUE_ELIGIBILITY=off` leaves it blank, so the eligible list is empty with its reason.
          TRADE_USER_VENUE_ELIGIBILITY_LEVEL:
            process.env.LOCAL_STACK_USER_VENUE_ELIGIBILITY === 'off' ? '' : testValue('TRADE_USER_VENUE_ELIGIBILITY_LEVEL'),
          TRADE_USER_VENUE_BUILDER_ADDRESS: testValue('TRADE_USER_VENUE_BUILDER_ADDRESS'),
          TRADE_USER_VENUE_BUILDER_FEE_BPS:
            process.env.LOCAL_STACK_USER_VENUE_BUILDER_FEE === 'off' ? '' : testValue('TRADE_USER_VENUE_BUILDER_FEE_BPS'),
          // J-agents-21's agent account on the TEST venue: the labelled LOCAL TEST ceiling, funding asset, agent key seed
          // and drain bounds. `LOCAL_STACK_AGENT_ACCOUNT_CEILING=off` leaves the ceiling blank for one restart, so a create
          // refuses agents.account_ceiling_unset (J-agents-21 #1).
          TRADE_AGENT_ACCOUNT_CEILING:
            process.env.LOCAL_STACK_AGENT_ACCOUNT_CEILING === 'off' ? '' : testValue('TRADE_AGENT_ACCOUNT_CEILING'),
          TRADE_AGENT_ACCOUNT_ASSET: testValue('TRADE_AGENT_ACCOUNT_ASSET'),
          TRADE_AGENT_KEY_SEED: testValue('TRADE_AGENT_KEY_SEED'),
          // J-derivatives-03: our engine judges the venue-lacking protections (a trailing stop, a stop on the index) each second.
          TRADE_PROTECTION_ENGINE_INTERVAL_MS: '1000',
          // J-cex-spot-15 #9's balance watch reads two balances per watched account on each pass. Hyperliquid's test network
          // allows 1200 weight a minute per IP, shared by everything on the box, and each balance read weighs 2: at the
          // engine's second, seven testers' accounts alone spent it (25 Nov 2026, every funding read answered 429). On the
          // test network the watch reads each account every 15 s; the TEST venue keeps the engine's second.
          // Read every 15 s, every account still grew the box's weight with the account count (about ten accounts,
          // no desk open, spent 160 a minute on balances alone): there the watch reads 24 accounts a minute in turn, at most
          // 96 weight a minute however many accounts there are (each account is read less often as they grow).
          ...(userVenueKind(process.env.LOCAL_STACK_USER_VENUE) === 'hl-testnet'
            ? { TRADE_VENUE_BALANCE_WATCH_INTERVAL_MS: '15000', TRADE_VENUE_BALANCE_WATCH_ACCOUNTS_PER_MINUTE: '24' }
            : {}),
          TRADE_AGENT_MAX_ORDER_NOTIONAL: testValue('TRADE_AGENT_MAX_ORDER_NOTIONAL'),
          TRADE_AGENT_WORST_PRICE_BPS: testValue('TRADE_AGENT_WORST_PRICE_BPS'),
          // `LOCAL_STACK_AGENT_MARKETS_ADD=<symbols>` adds a journey's own TEST markets to the list for one restart, so an
          // assistant may copy on a market no other file trades (J-copy-bots-otc-06 #1).
          TRADE_AGENT_MARKETS: [testValue('TRADE_AGENT_MARKETS'), process.env.LOCAL_STACK_AGENT_MARKETS_ADD?.trim()]
            .filter(Boolean)
            .join(','),
          // J-agents-21 #16: the ceilings of the person's own leverage and daily-loss caps (the per-order cap's is the
          // largest agent order above).
          TRADE_AGENT_MAX_LEVERAGE: testValue('TRADE_AGENT_MAX_LEVERAGE'),
          TRADE_AGENT_MAX_DAILY_LOSS: testValue('TRADE_AGENT_MAX_DAILY_LOSS'),
          // J-developer-05 #6: `LOCAL_STACK_USER_VENUE_ORDERS_PAGE_MAX=off` leaves the largest page blank, so a list refuses.
          // J-algo-dev-07: live strategy runs on the person's own TEST venue sub-account, on for the TEST venue only, and
          // the labelled LOCAL TEST heartbeat interval their process is watched by.
          TRADE_QUANT_LIVE: 'on',
          TRADE_QUANT_LIVE_HEARTBEAT_MS: testValue('TRADE_QUANT_LIVE_HEARTBEAT_MS'),
          TRADE_USER_VENUE_ORDERS_PAGE_MAX:
            process.env.LOCAL_STACK_USER_VENUE_ORDERS_PAGE_MAX === 'off' ? '' : testValue('TRADE_USER_VENUE_ORDERS_PAGE_MAX'),
          // The builder-fee poster (J-derivatives-17): every 2 seconds on the TEST venue; `LOCAL_STACK_BUILDER_FEE_POSTER=off`
          // stops it, so a fill waits unposted and the recon lists it as a break. On the test network each pass reads every
          // account's fills at 20 weight or more, against the box's one 1200 a minute: every 30 s there.
          TRADE_BUILDER_FEE_POSTER: process.env.LOCAL_STACK_BUILDER_FEE_POSTER === 'off' ? 'off' : 'on',
          TRADE_BUILDER_FEE_POSTER_INTERVAL_MS: userVenueKind(process.env.LOCAL_STACK_USER_VENUE) === 'hl-testnet' ? '30000' : '2000',
          // There it reads 6 accounts' fills a minute in turn, 20 weight or more each, whatever the account count.
          ...(userVenueKind(process.env.LOCAL_STACK_USER_VENUE) === 'hl-testnet'
            ? { TRADE_BUILDER_FEE_POSTER_ACCOUNTS_PER_MINUTE: '6' }
            : {}),
          // Collect (J-derivatives-17, J-campaigns-03): every 2 seconds the TEST venue's own claim record is read and each
          // claim posts once; a claim exists only once a journey asks the TEST venue for one (`/test/builder-claim`).
          TRADE_BUILDER_FEE_COLLECT_INTERVAL_MS: '2000',
          // J-ops-console-28: our builder address's mode at each TEST venue is checked every 2 seconds (and on each read of the
          // console's view), and an alert out of the required mode goes to the labelled TEST contact.
          TRADE_BUILDER_MODE_CHECK_INTERVAL_MS: '2000',
          TRADE_BUILDER_MODE_ALERT_CONTACT: testValue('TRADE_BUILDER_MODE_ALERT_CONTACT'),
          // Move own funds (OWNER 288 Q4; J-campaigns-03): the labelled TEST float, schedule, rewards wallet and builder key
          // seed, so what the TEST builder account holds above the float is swept to the TEST rewards wallet.
          TRADE_OWN_FUNDS_FLOAT: testValue('TRADE_OWN_FUNDS_FLOAT'),
          TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS: testValue('TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS'),
          TRADE_OWN_FUNDS_WALLET: testValue('TRADE_OWN_FUNDS_WALLET'),
          TRADE_BUILDER_KEY_SEED: testValue('TRADE_BUILDER_KEY_SEED'),
          // On the test network those seconds were the box's weight with no desk open (#11041): the sweep's one balance read
          // 20 times a minute, the mode check 30 and the claim read 60. There each runs once a minute; the TEST venue keeps
          // its seconds, so a journey sees a sweep, a mode alert and a claim inside its run.
          ...(userVenueKind(process.env.LOCAL_STACK_USER_VENUE) === 'hl-testnet'
            ? {
                TRADE_OWN_FUNDS_SWEEP_INTERVAL_MS: '60000',
                TRADE_BUILDER_MODE_CHECK_INTERVAL_MS: '60000',
                TRADE_BUILDER_FEE_COLLECT_INTERVAL_MS: '60000',
              }
            : {}),
        }
      : {}),
  }),
});
