import { z } from 'zod';
import { edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';
import { parseOwnerIntegerEnv } from './owner-int-env.js';

// Both, and they are not alternatives. `edgeEnvSchema` authenticates the USER a
// request claims to carry; `internalServiceEnvSchema` authenticates the SERVICE
// making the call. A mounted money service needs both — see #50.
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-trade'),

      /** CB-bots-10 bot verification switch: `required` (unset) or `off`, written explicitly. See algo/bots-verification.ts. */
      TRADE_BOTS_VERIFICATION: z.enum(['required', 'off']).optional(),
      /** CB-bots-10 lowest tier allowed to create a bot (basic|full|institutional). Blank refuses every bot create. */
      TRADE_BOTS_VERIFICATION_LEVEL: z.string().default(''),
      /**
       * CB-ops-05 window the operator desk's RFQ counts cover, whole seconds. Owner value: blank refuses
       * `trade.ops_metrics_window_not_set` (admin/copy-bots-otc.ts), never a guessed window.
       */
      TRADE_OPS_METRICS_WINDOW_SECONDS: z.string().default(''),
      HTTP_PORT: z.coerce.number().int().default(4004),

      /** svc-ledger's internal address. All value movement goes through it. */
      LEDGER_URL: z.string().url().default('http://localhost:4001'),

      /** svc-identity — rank perks at order accept + sub-account ownership gate. */
      IDENTITY_URL: z.string().url().default('http://localhost:4002'),
      /** Dedicated trading decision key; blank disables new exposure, never founder/read auth. */
      IDENTITY_ADMISSION_SECRET: z.string().default(''),

      /** svc-matching — the book. This service never runs one of its own. */
      MATCHING_URL: z.string().url().default('http://localhost:4005'),

      /**
       * svc-fix drop-copy ingest base URL. Owner-set only.
       * Blank → no POST (ingest dark). Never invent a host.
       */
      TRADE_FIX_DROPCOPY_INGEST_URL: z.string().default(''),

      /**
       * Kill-switch mirror of the `trade.spot` flag (§14 admin controls).
       *
       * OFF stops NEW orders. It deliberately does not stop cancellations: an
       * operator halting the market must be able to let users out of their
       * positions, and a switch that traps funds is not a safety control.
       */
      TRADE_SPOT_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * Worst price a market BUY may be funded at, above the best ask.
       *
       * A market buy has no price, so there is no honest amount to hold for it
       * until one is chosen. This is that choice: the order is funded at
       * `bestAsk x (1 + cap)` and submitted to the engine as a marketable IOC
       * LIMIT at exactly that price, so the engine physically cannot fill it above
       * what was held.
       *
       * NO DEFAULT. Blank / unset / non-integer → null; market-buy
       * `protectionPriceFor` refuses `trade.slippage_cap_unset`. Never invent 200.
       */
      TRADE_MARKET_SLIPPAGE_CAP_BPS: z.string().default('').transform(parseOwnerIntegerEnv),

      /**
       * Cancel-all-after timeouts the owner publishes, in seconds, comma separated (for example "10,30,60").
       *
       * NO DEFAULT. Blank / unset / any non-integer entry → null; arming refuses `trade.cancel_all_after_unset`.
       * Timeout 0 (disarm) is always allowed. Never invent 10 or 120.
       */
      TRADE_CANCEL_ALL_AFTER_TIMEOUTS_SEC: z
        .string()
        .default('')
        .transform((raw) => {
          const parts = raw
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p !== '');
          if (parts.length === 0) return null;
          const values = parts.map((p) => parseOwnerIntegerEnv(p));
          if (values.some((v) => v === null || v <= 0)) return null;
          return values as number[];
        }),

      /** How often the dead-man switch checks for countdowns past their deadline. Default 5s. */
      TRADE_CANCEL_ALL_AFTER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),

      /**
       * Opens the svc-bank standing-instruction convert door (auto-invest). Default OFF:
       * turn it on only once svc-identity decides the `standing_instruction` authority.
       */
      TRADE_STANDING_INSTRUCTION_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** Kill-switch for one-tap Convert (`trade.convert`). */
      TRADE_CONVERT_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * House edge shown on convert RFQs, in bps of book notional.
       * Execution still settles through the normal market IOC money path.
       *
       * NO DEFAULT. Blank / unset / non-integer → null; convert quote/execute
       * refuse `trade.convert_spread_unset`. Never invent 10.
       */
      TRADE_CONVERT_SPREAD_BPS: z.string().default('').transform(parseOwnerIntegerEnv),

      /**
       * How long a firm convert quote binds, in milliseconds.
       *
       * NO DEFAULT. Blank / unset / non-integer → null; convert quote/execute
       * refuse `trade.convert_quote_ttl_unset`. Never invent 15000.
       */
      TRADE_CONVERT_QUOTE_TTL_MS: z.string().default('').transform(parseOwnerIntegerEnv),

      /**
       * Kill-switch for TWAP algo execution (D-S-04 / trade.algo).
       * OFF refuses new schedules; cancel/pause of existing still work.
       */
      TRADE_ALGO_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * TWAP slice scheduler (D-S-04 / trade.algo). Default OFF.
       *
       * Distinct from TRADE_ALGO_ENABLED: that one decides whether a user may
       * CREATE a schedule, this one decides whether anything ever executes it.
       * Off, a TWAP is accepted, persisted, and never places a child — which is
       * exactly the pre-mount state, so this defaults off until an operator
       * turns it on deliberately (denylist: only 1/true/on/yes enable).
       *
       * Mount is legal only with ADR 2026-08-08 re-space + cancel honesty.
       */
      TRADE_ALGO_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * How often the TWAP scheduler asks the engine for the next due slice.
       * Cap 1000ms: the engine's floor for sliceIntervalMs is 1s, so anything
       * above 1s here can under-run a legal schedule. Refuse at boot.
       */
      TRADE_ALGO_JOBS_INTERVAL_MS: z.coerce.number().int().min(250).max(1_000).default(1_000),

      /**
       * MAY A FUTURES MARKET ACCEPT AN ORDER? (`trade.futures` / D-S-01.)
       *
       * DEFAULT OFF, and off is a product state rather than an outage. With this
       * unset svc-trade boots normally and serves everything it serves today;
       * a futures market is listed, visible, quotable and readable, and an
       * ORDER into one is refused by name with `trade.futures_disabled` — a
       * 403, not a 500 and not a crash-loop. `#883`/`#950` established the
       * distinction: a refusal whose only legal answer is one value is an
       * outage, and this one has a legal answer on both settings.
       *
       * It follows `TRADE_SPOT_ENABLED`'s shape and inverts its DEFAULT, for
       * the reason `TRADE_FUTURES_JOBS_ENABLED` and `TRADE_MM_SEED_ENABLED`
       * already default off: a capability that moves money in a way nobody has
       * yet run in anger must be switched on deliberately, by an operator, and
       * never arrive as a side effect of a deploy.
       *
       * WHAT IT DOES NOT DO, stated because a flag named `FUTURES_ENABLED`
       * invites the assumption that it turns futures on:
       *
       *   · It does not enable FUNDING for any market. That is reserved to the
       *     owner (`docs/adr/2026-08-05-futures-risk-and-mark-law.md`), and
       *     funding still needs `TRADE_FUTURES_JOBS_ENABLED` plus an explicit
       *     `TRADE_FUTURES_FUNDING_MARKET_IDS`.
       *   · It does not name the profit source. `TRADE_FUTURES_PROFIT_SOURCE`
       *     has no default on purpose (`#950`) and this does not supply one.
       *   · It does not RAISE a leverage or margin parameter, and it does not
       *     remove the one ceiling there is. Orders on a futures book are funded
       *     by the same hold as spot (`holdFor` / `assertTradable` in
       *     `spot/risk.ts`), and a MARGIN position opened through
       *     `futures/position-service.ts` is refused above the DIRECTION §1
       *     10× cap (D26-P0-07), or a tighter `TRADE_FUTURES_MAX_LEVERAGE`.
       *     Empty env is 10× in code — not refuse-closed, not a raise.
       *   · It does not lower the mark bar. `DEFAULT_MIN_BEST_LEVEL_NOTIONAL`
       *     still refuses a dust book, which is the whole reason this flag
       *     could be added at all (`c7dfb5e4`, `cc90c2f4`) — and
       *     `DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL` now additionally refuses a
       *     book that is real money but thin for the position it would price,
       *     which is what the dust floor alone did not cover.
       *
       * Kill-switch direction, same as spot: OFF stops NEW orders and never
       * stops cancellations. A switch that traps funds is not a safety control.
       */
      TRADE_FUTURES_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Local TEST swap listing on GET /markets. Default OFF.
       * Does not enable TRADE_FUTURES_ENABLED or TRADE_FUTURES_JOBS_ENABLED,
       * and does not publish a leverage cap, a mark, or a liquidation policy.
       * The listing itself comes only from the local seed script.
       */
      TRADE_FUTURES_TEST_SEED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * OPTIONS SETTLEMENT ASSET LAW stamp (trade.options / D26-P0-05).
       *
       * EMPTY BY DEFAULT — and empty is a refusal, not a crash. listMarket with
       * kind=options throws `trade.options_settlement_law_unset` until this is a
       * non-empty opaque string meaning the P0-05 ADR (live set, settlement asset,
       * refuse matrix) is published. The string is NEVER parsed for assets or
       * matrix rows — inventing those is SOCKET §13
       * `socket.options-settlement-asset-law`. Stamp only after the ADR exists.
       */
      TRADE_OPTIONS_SETTLEMENT_ASSET_LAW: z.string().default(''),

      /**
       * OPTIONS SETTLEMENT FIXING CONFIG (trade.options / D7).
       *
       * EMPTY BY DEFAULT — and empty is a refusal, not a crash. listMarket with
       * kind=options throws `trade.options_fixing_unconfigured` until this is
       * set to a non-empty opaque string (and P0-05 law is also stamped). The
       * string is stamped on the market row as `settlement_fixing`; it is NOT
       * parsed for source, window, expiry clock, or funded payor account. Those
       * are owner law (D7) and inventing them here would be the exact failure
       * this thin slice exists to prevent.
       *
       * No IV surface. No pricing model. Orders on options remain refused by
       * `assertTradable` (`trade.market_kind_unsupported`) until an engine exists.
       */
      TRADE_OPTIONS_SETTLEMENT_FIXING: z.string().default(''),

      /**
       * Options exercise / assignment / expiry jobs (R-E5 / PTX-M11-R08).
       * Default OFF. Blank TRADE_OPTIONS_SETTLEMENT_FIXING / settlement asset
       * still refuse by name when on. Does not unlock live listing (R-E8).
       */
      TRADE_OPTIONS_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** Exercise scan interval when jobs enabled. Default 15s. Does not invent a fixing. */
      TRADE_OPTIONS_JOBS_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),

      /**
       * Auto delta-hedge owner sockets (R-E6 / PTX-M11-R09 / PX-S08-O11).
       * EMPTY BY DEFAULT — blank target/range/instrument refuse by name.
       * Decimal strings. Never invent 0 / MMP thresholds / a hedge instrument.
       * Does not unlock live listing.
       */
      TRADE_DELTA_HEDGE_TARGET: z.string().default(''),
      TRADE_DELTA_HEDGE_RANGE: z.string().default(''),
      TRADE_DELTA_HEDGE_INSTRUMENT: z.string().default(''),

      /**
       * Quant live-deploy eligibility pin (R-quant / PX-S15).
       * EMPTY BY DEFAULT — blank refuses `trade.quant_live_deploy_unpinned`.
       * Opaque owner string. Never invent eligibility JSON or launch a runtime.
       */
      TRADE_QUANT_LIVE_DEPLOY_PIN: z.string().default(''),

      /**
       * Promotion budget/end (R-promo / PTX-M21-R06 / socket.promotion-law).
       * EMPTY BY DEFAULT — blank budget or end refuses create-promo by name.
       * Decimal-string budget. Never invent rebate bps. Absent funding = no rebate.
       */
      TRADE_PROMO_BUDGET: z.string().default(''),
      TRADE_PROMO_END: z.string().default(''),

      /**
       * DATED FUTURES SETTLEMENT FIXING CONFIG (trade.futures / PTX-M10-R03).
       *
       * EMPTY BY DEFAULT — and empty is a refusal, not a crash. listMarket with
       * futuresContractStyle=dated throws `trade.dated_futures_fixing_unconfigured`
       * until this is a non-empty opaque string. The string is stamped on the
       * market row as `futures_settlement_fixing`; it is NOT parsed for source,
       * window, expiry clock, or settlement *price*. Those are owner law
       * (PX-S07-O03). Inventing last trade / mark as settlement is the failure
       * this gate exists to prevent. Perpetual listings ignore this env.
       */
      TRADE_FUTURES_SETTLEMENT_FIXING: z.string().default(''),

      /**
       * FUTURES SETTLE ASSETS the owner has switched on (D-instruments-03). Comma-separated asset codes.
       *
       * EMPTY BY DEFAULT — and empty is a refusal, not a crash. A linear USDT contract settles in its quote
       * asset and needs nothing here. listMarket for a USDC-settled linear contract throws
       * `trade.futures_settle_asset_unconfigured` until `USDC` is named. Presence only: this never picks a
       * settle asset for a listing and never converts between assets.
       */
      TRADE_FUTURES_SETTLE_ASSETS: z.string().default(''),

      /**
       * Futures residual jobs (liquidation scan + funding ticks).
       * Default OFF — must be explicitly enabled. Never invents markets/rates.
       */
      TRADE_FUTURES_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Conditional-order trigger (stop, stop-limit, take-profit, trailing).
       * Default OFF. Does not enable TRADE_FUTURES_ENABLED or TRADE_FUTURES_JOBS_ENABLED.
       * A blank interval does not start the timer and does not invent a cadence.
       */
      TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Tick interval for the conditional-order job, in milliseconds.
       * EMPTY = do not schedule. There is no product cadence. A set value must
       * be an integer 1000–3600000, the same window as the liquidation scan.
       */
      TRADE_FUTURES_CONDITIONAL_JOBS_INTERVAL_MS: z
        .string()
        .default('')
        .transform((raw, ctx) => {
          const s = raw.trim();
          if (s === '') return null;
          const n = Number(s);
          if (!Number.isInteger(n) || n < 1_000 || n > 3_600_000) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'TRADE_FUTURES_CONDITIONAL_JOBS_INTERVAL_MS must be an integer 1000–3600000, or empty (no invented cadence)',
            });
            return z.NEVER;
          }
          return n;
        }),

      /** Liquidation scan interval when jobs enabled. Default 15s. */
      TRADE_FUTURES_LIQ_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),

      /**
       * Owner-published D3 ladder policy JSON (`FuturesLadderPolicy`).
       * Empty = refuse — never invent `DEFAULT_FUTURES_LADDER_POLICY`.
       */
      TRADE_FUTURES_LADDER_POLICY: z.string().default(''),

      /**
       * Funding tick interval per market when jobs enabled.
       * EMPTY = do not schedule funding ticks. D2: there is no product 8h default.
       * A set value must be an integer 60000–86400000.
       */
      TRADE_FUTURES_FUNDING_INTERVAL_MS: z
        .string()
        .default('')
        .transform((raw, ctx) => {
          const s = raw.trim();
          if (s === '') return null;
          const n = Number(s);
          if (!Number.isInteger(n) || n < 60_000 || n > 86_400_000) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'TRADE_FUTURES_FUNDING_INTERVAL_MS must be an integer 60000–86400000, or empty (no invented 8h schedule)',
            });
            return z.NEVER;
          }
          return n;
        }),

      /**
       * Poll interval of the funding rate computer (D-instruments-01), in ms.
       * EMPTY (default) = the computer is not scheduled and the funding tick reads only the rate book the S2S
       * publish route fills. When set, each funding market is sampled and its latest closed period computed at this
       * interval; every owner number the formula needs still lives in `admin.fundingParams` and refuses when blank.
       * A set value must be an integer 1000-86400000.
       */
      TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS: z
        .string()
        .default('')
        .transform((raw, ctx) => {
          const s = raw.trim();
          if (s === '') return null;
          const n = Number(s);
          if (!Number.isInteger(n) || n < 1_000 || n > 86_400_000) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS must be an integer 1000–86400000, or empty (computer not scheduled)',
            });
            return z.NEVER;
          }
          return n;
        }),

      /**
       * Comma-separated market UUIDs for funding ticks.
       * Empty (default) = funding jobs not scheduled — never invent market list.
       */
      TRADE_FUTURES_FUNDING_MARKET_IDS: z.string().default(''),

      /**
       * Absolute max |period funding rate| as a positive decimal string
       * (same units as published rates — absolute, not bps).
       *
       * NO DEFAULT. The product ceiling is owner residual D2
       * (`docs/BUILD-STOP-TRADE-2026-08-08.md`). Inventing e.g. "0.01" here
       * would dress an interim number as law.
       *
       * Empty: publish + settlement refuse rate application (fail-closed).
       * Non-empty funding market list without this set: boot fails.
       * See `futures/funding-rate-bound.ts`.
       */
      TRADE_FUTURES_FUNDING_MAX_ABS_RATE: z.string().default(''),

      /**
       * THE ACCOUNT REALISED FUTURES PROFIT IS PAID FROM: the futures clearing
       * pot that realised losses fill (docs/adr/2026-10-20-futures-matched-traders.md).
       * What it cannot cover yet is owed, not refused (`futures/futures-payouts.ts`).
       *
       * `ownerType:ownerId:kind[:purpose]`, i.e. `house:futures-loss:available`.
       *
       * NO DEFAULT, and that is the decision. `futuresRealizeProfit` used to
       * draw on a fee pot with no ceiling — a house account is not an insurance
       * fund and a fee balance is not a risk budget. Which account funds profit,
       * and how it is capitalised, is a fee and revenue recipe and an owner
       * decision (`docs/adr/2026-08-05-futures-risk-and-mark-law.md`,
       * `DIRECTION` §8 item 6). A default here would BE that decision, made
       * silently by whoever wrote this line.
       *
       * Unset, the service refuses to boot rather than picking a pot. See
       * `futures/profit-source.ts`.
       */
      TRADE_FUTURES_PROFIT_SOURCE: z.string().default(''),

      /**
       * Maximum leverage on a futures open (decimal string, same units as the
       * request). EMPTY = DIRECTION §1 10× in code (D26-P0-07). Set only to
       * tighten (≤ 10). A value above 10× fails boot — that is a raise.
       */
      TRADE_FUTURES_MAX_LEVERAGE: z.string().default(''),

      /**
       * FUTURES ORDERS THROUGH svc-matching (docs/adr/2026-10-20-futures-matched-traders.md slice 6). OFF by default,
       * so main keeps today's futures behaviour until slice 6b retires open and close at mark.
       *
       * Off refuses NEW matched futures orders only. Settling a fill the engine has already matched, and releasing a
       * hold, keep running: a kill switch that traps margin is not a safety control.
       */
      TRADE_FUTURES_MATCHING_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * The futures collateral haircut, in whole bps of posted cash (0 to 10000). An opening order's hold, and an at-mark
       * open, must fit inside the account's posted cash less this cut. NO DEFAULT — empty refuses an opening order with
       * `trade.haircut_unset`, and the Collateral read shows "haircut not set". Read by futures/haircut-credit.ts.
       */
      TRADE_COLLATERAL_HAIRCUT_BPS: z.string().default(''),

      /**
       * The futures price band (slice 6): a decimal fraction of the mark, for example 0.05 for five per cent either
       * side. EMPTY BY DEFAULT — and empty refuses a matched futures order with `trade.futures_price_band_unset`.
       * The number is the owner's; a value that is not a fraction strictly between 0 and 1 fails boot.
       */
      TRADE_FUTURES_PRICE_BAND: z.string().default(''),

      /**
       * Market-maker seed job (trade.mm-bot residual).
       * Default OFF — ops must enable + fund pot + set markets + mids.
       * Never invents mid or market list.
       */
      TRADE_MM_SEED_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** Seed scan interval when enabled. Unset keeps the host unscheduled. */
      TRADE_MM_SEED_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).optional(),

      /**
       * Explicit seed targets: `marketId:base:quote,...`
       * Empty (default) = job not scheduled even when enabled.
       */
      TRADE_MM_SEED_MARKETS: z.string().default(''),

      /**
       * External mids for seed: `marketId:mid,...`
       * Missing mid for a market → skip that market (never invent).
       */
      TRADE_MM_SEED_MIDS: z.string().default(''),

      /**
       * When true, after env mid map miss, try public venue book mid
       * (same venue id + symbol map as TRADE_VENUE_MARK_*). Default OFF.
       * Never invents if venue down / unmapped / empty book.
       */
      TRADE_MM_SEED_MID_FROM_VENUE: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * First-level half-spread from mid, in bps. NO DEFAULT. Blank / unset /
       * non-integer → null; seed refuses `trade.mm_seed_bps_unset`. Never invent 10.
       */
      TRADE_MM_SEED_HALF_SPREAD_BPS: z.string().default('').transform(parseOwnerIntegerEnv),
      /**
       * Extra bps between successive seed levels. NO DEFAULT. Blank / unset /
       * non-integer → null; seed refuses `trade.mm_seed_bps_unset`. Never invent 10.
       */
      TRADE_MM_SEED_STEP_BPS: z.string().default('').transform(parseOwnerIntegerEnv),
      TRADE_MM_SEED_LEVELS: z.coerce.number().int().min(1).max(50).default(3),
      TRADE_MM_SEED_QTY: z.string().default('1'),

      /**
       * Durable last-run map for MM seed cancel/reseed across process restarts.
       * Empty = in-memory only (legacy). Relative paths resolve from process cwd.
       */
      TRADE_MM_SEED_STATE_PATH: z.string().default('.data/mm-seed-last-run.json'),

      /**
       * Futures mark from our own spot book: `<futures symbol>=<spot symbol>`, comma-separated
       * (`futures/mark-from-spot-index.ts`). The owner's pairing. Empty (default) = off, and a futures market is
       * marked by its own book's mid as before. A malformed pair fails boot; a pair whose spot market does not share
       * the futures market's base and quote marks nothing (never a nearby price).
       */
      TRADE_FUTURES_INDEX_SPOT_MARKETS: z.string().default(''),

      /**
       * Venue fabric mark source (A-TRADE-VENUE-1 / venue.aggregation).
       * Empty (default) = off — marks fall back to matching depth mid only.
       * Known ids: `binance-spot`, `bybit-spot`, `okx-spot` — PUBLIC MarketDataAdapters,
       * none holding a credential.
       * Unknown id → no adapter (refuse invent). Never invents mid.
       */
      TRADE_VENUE_MARK_VENUE: z.string().default(''),

      /**
       * Map our market UUIDs to venue unified symbols for the mark port:
       * `marketId:BTC/USDT,other:ETH/USDT`.
       * Unmapped market → null mark for that id (never invent symbol).
       */
      TRADE_VENUE_MARK_SYMBOLS: z.string().default(''),

      /**
       * When true, futures venue marks read the sequenced MaintainedBook
       * (stream-first + snapshot join) instead of polling snapshotBook each tick.
       * Default OFF. Empty symbol map still starts nothing. Desynced feed → null mark.
       */
      TRADE_VENUE_MARK_STREAM: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Spot candle materialization job (A-TRADE-SPOT-1).
       * Default OFF — REST OHLCV always reads live fills; this job only
       * copies closed non-seeded buckets into trade.spot_candles.
       * Never invents empty candles, a market list, 1m, or 500.
       */
      TRADE_CANDLE_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** Materialization tick interval when enabled. Default 60s. */
      TRADE_CANDLE_JOBS_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

      /**
       * Comma-separated market UUIDs to materialize.
       * Empty (default) = job not scheduled even when enabled.
       */
      TRADE_CANDLE_JOBS_MARKET_IDS: z.string().default(''),

      /**
       * Comma-separated timeframes (e.g. `1m,1h`). Invalid tokens dropped.
       * NO DEFAULT. Blank / unset → []; enabled + markets refuse
       * `trade.candle_jobs_timeframes_unset`. Never invent 1m. Owner may set `1m`.
       */
      TRADE_CANDLE_JOBS_TIMEFRAMES: z.string().default(''),

      /**
       * Max closed buckets per market/timeframe per tick.
       * NO DEFAULT. Blank / unset / non-integer → null; enabled + markets
       * refuse `trade.candle_jobs_limit_unset`. Never invent 500. Owner may set 500.
       */
      TRADE_CANDLE_JOBS_LIMIT: z.string().default('').transform(parseOwnerIntegerEnv),

      /**
       * Trailing-stop mark pump. Default OFF. Reads a mark from the market's own book and posts it to svc-matching,
       * which walks that market's trailing stops. Never invents a market list, a tick rate or a mark.
       */
      TRADE_TRAILING_MARK_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Tick interval in ms. NO DEFAULT. Blank / unset / non-integer → null; enabled + markets refuse
       * `trade.trailing_mark_jobs_interval_unset`. Never invent a tick rate.
       */
      TRADE_TRAILING_MARK_JOBS_INTERVAL_MS: z.string().default('').transform(parseOwnerIntegerEnv),

      /** Comma-separated market UUIDs. Empty (default) = job not scheduled even when enabled. */
      TRADE_TRAILING_MARK_JOBS_MARKET_IDS: z.string().default(''),

      /**
       * Fee tier snapshot check interval in ms (fee-tier-jobs.ts). NO DEFAULT: blank → the job is not scheduled, no
       * snapshot runs and every tier stays where the last one left it. The snapshot time itself is the owner's, in
       * the fee schedule's `tierProgram`.
       */
      TRADE_FEE_TIER_JOBS_INTERVAL_MS: z.string().default('').transform(parseOwnerIntegerEnv),

      /**
       * The key VIP application proof files are encrypted with (spot/vip-applications.ts): 32 bytes as base64 or 64 hex
       * characters. NO DEFAULT: blank or malformed → every application refuses `vip.proof_key_unset`; no key is improvised.
       */
      TRADE_VIP_PROOF_KEY: z.string().default(''),

      /**
       * Engine ↔ ledger reconcile sweep (A10 / ENGINE-LEDGER-RECONCILE-HANDOFF).
       * Default OFF — builds counterpart view from trade.orders + hold balances,
       * POSTs matching `/reconcile`, alerts on refuse, auto-deletes only
       * unfunded pending. Never releases funded missing silently.
       */
      TRADE_RECONCILE_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** Reconcile sweep interval when enabled. Default 60s. */
      TRADE_RECONCILE_JOBS_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

      /**
       * Lost order.hold reply sweep (TRD-0540). Default ON — a timeout after
       * the hold is booked leaves the row in hold_unknown, and this pass reads
       * order.hold:<orderId>. Set false to stop the timer; the place path
       * still resolves a reply it can read.
       */
      TRADE_HOLD_UNKNOWN_SWEEP_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** Hold-unknown sweep interval when enabled. Default 60s. */
      TRADE_HOLD_UNKNOWN_SWEEP_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),

      /**
       * A market, IOC, or FOK order left in hold_unknown is released instead of
       * submitted once it is older than this on the database clock. The customer
       * was told the outcome was unknown. Default 30s. Min 1s. Max 10 minutes.
       */
      TRADE_HOLD_UNKNOWN_TAKER_MAX_AGE_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

      /**
       * OTC RFQ desk law (trade.otc / D-S-02). JSON or empty.
       *
       * Empty (default) = unpublished → refuse-closed. Never invent spread bps,
       * min stake, or principal-vs-maker — DIRECTION §8 owner-only.
       * Published shape: {"published":true,"spreadBps":N,"minStake":"…","counterparty":"platform"|"maker","quoteTtlMs":30000,"maxMidAgeSeconds":N}
       * maxMidAgeSeconds is required when published — never invent mid freshness.
       */
      TRADE_OTC_DESK_LAW: z.string().default(''),
      /** CB-otc-01 owner provider directory + selection cap. Blank → "No providers set". */
      TRADE_OTC_MAKER_DIRECTORY: z.string().default(''),

      /**
       * OTC reference mids, ops-published: `BASE/QUOTE:mid,BASE/QUOTE:mid`.
       *
       * Empty (default) = the desk can source no price and every quote refuses
       * `trade.otc_no_reference_price`. Boot-stamped asOf + desk-law
       * `maxMidAgeSeconds` makes a static map go dark after the owner window.
       * Boot-stamped map is not a live feed. When TRADE_OTC_MID_FROM_VENUE is
       * on, production uses the venue observation source instead (no boot fallback).
       * Deliberately not a caller input.
       */
      TRADE_OTC_MIDS: z.string().default(''),

      /**
       * When true, OTC quotes source mid from the same public venue adapter as
       * TRADE_VENUE_MARK_VENUE. Default OFF. With TRADE_VENUE_MARK_STREAM also
       * on, uses the same MaintainedBook port as futures marks / MM (desynced
       * → null). Never invents if venue down / unmapped / empty book. Boot
       * TRADE_OTC_MIDS is not mixed in when this is on.
       */
      TRADE_OTC_MID_FROM_VENUE: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * OTC pairKey → venue unified symbol: `BTC/USDT:BTC/USDT,ETH/USDT:ETH/USDT`.
       * Empty (default) = every pair unmapped → null mid (never invent symbols).
       * Keys are OTC pair keys, not trade.markets UUIDs (those stay on TRADE_VENUE_MARK_SYMBOLS).
       */
      TRADE_OTC_VENUE_SYMBOLS: z.string().default(''),
      /** CB-otc-12 owner amount bounds for one-click buy / convert at OTC pricing. Blank → both refuse. */
      TRADE_OTC_CONVERT_BOUNDS: z.string().default(''),

      /**
       * Copy fee-share law (trade.copy / D-S-03 / D26-P0-02). JSON or empty.
       *
       * Empty (default) = unpublished → refuse-closed. Never invent
       * leader_share_bps / caps / decay — DIRECTION §8 owner-only.
       * Published shape: {"published":true,"leaderShareBps":N,"earningsCapPerFollower":"…",
       * "decayRoundTrips":N,"decayShareBps":N}
       */
      TRADE_COPY_FEE_SHARE_LAW: z.string().default(''),

      /**
       * Copy jurisdiction allowlist (trade.copy / D-S-03 / D26-P0-15).
       *
       * Empty (default) = unpublished → follow refuses. Never invent a second
       * list in callers (adr/2026-08-15-copy-jurisdiction-refuse-closed.md).
       * Counsel has not supplied a served-region list; `.env.example` and
       * compose therefore remain blank.
       * Published shape: {"published":true,"allowedRegions":["…"]}
       * Published empty array = serve none (still fail closed).
       */
      TRADE_COPY_JURISDICTION_LAW: z.string().default(''),

      /**
       * Verification level a follower needs to copy (CB-copy-03): basic, full or institutional.
       *
       * Empty (default) = unset → every Start copying refuses `trade.copy_tier_unset`.
       * Owner and compliance content. Never invent a level.
       */
      TRADE_COPY_MIN_TIER: z.string().default(''),

      /**
       * How often the copy driver (CB-copy-10) looks for new leader fills to copy. It runs only while
       * TRADE_COPY_PLACE_MIRROR is on; off, nothing is copied and copy.placeMirror refuses by name.
       */
      TRADE_COPY_MIRROR_SWEEP_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),

      /**
       * Copy lead-page metric definitions (CB-copy-02). JSON or empty.
       *
       * Empty (default) = unpublished → every metric on a lead page reads
       * "Not set by the platform". Never invent what a metric means.
       * Published shape: {"published":true,"version":"…","definitions":{"publishedReturn":"…","maximumDrawdown":"…"}}
       * Keys: publishedReturn, maximumDrawdown, winRate, sharpeRatio. The text is owner content.
       */
      TRADE_COPY_METRIC_DEFINITIONS: z.string().default(''),

      /**
       * Spot maker/taker fee/rebate schedule (PTX-M21). JSON or empty.
       *
       * Empty (default) = unpublished → preview and place/fill refuse.
       * Never invent bps. Magnitudes are owner-only. Listing row 10/20 is not
       * a schedule.
       * Published shape: {"published":true,"version":"…","makerBps":"10","takerBps":"20"}
       * Bps are decimal strings of integer 0..9999 — never a JSON number.
       */
      TRADE_FEE_SCHEDULE: z.string().default(''),

      /**
       * The API hosts the developer portal publishes (developer-portal-rest.ts). JSON or empty, for example
       * {"rest":{"production":"api.example.test","sandbox":"…"},"fix":{"production":"fix.example.test:9878"}}.
       *
       * NO DEFAULT. Empty → GET /developer-portal/hosts refuses trade.developer_hosts_unset and every host reads
       * "host not set". A host left out reads "host not set" on its own. Malformed refuses boot. Never invent a host.
       */
      TRADE_DEVELOPER_HOSTS: z.string().default(''),

      /**
       * The market data terms per product the developer portal publishes (developer-portal-rest.ts). JSON or empty:
       * {"ticker":{"entitlement":"…","redistribution":"…","retention":"…","privacy":"…","commercial":"…"},…}.
       *
       * NO DEFAULT. Empty → GET /developer-portal/data-terms refuses trade.developer_data_terms_unset and every term
       * reads "not set". A product left out reads "not set". Malformed refuses boot. The text is owner content.
       */
      TRADE_DEVELOPER_DATA_TERMS: z.string().default(''),

      /**
       * The rule for the regional hosts the developer portal states under its base-address table (developer-portal-rest.ts):
       * plain text, who may use a regional host and when.
       *
       * NO DEFAULT. Empty → GET /developer-portal/regional-rule refuses trade.developer_regional_rule_unset and the page says
       * the rule waits for the owner. Longer than 1000 characters refuses boot. The text is owner content.
       */
      TRADE_DEVELOPER_REGIONAL_RULE: z.string().default(''),

      /** svc-token — stakeOf for OTC staked-tier gate. */
      TOKEN_URL: z.string().url().default('http://localhost:4003'),
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
