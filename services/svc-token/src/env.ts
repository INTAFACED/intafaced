import { z } from 'zod';
import { edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';

// Self-mounts /trpc — must authenticate the edge principal. And it CALLS
// svc-ledger, so it must also identify itself as a service. The two are
// orthogonal: one says which user, the other says which service (#50).
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-token'),
      HTTP_PORT: z.coerce.number().int().default(4003),

      /** The native asset. Configurable so a testnet can run its own symbol. */
      TOKEN_ASSET_ID: z.string().default('IFC'),

      /** svc-ledger's internal address. All value movement goes through it. */
      LEDGER_URL: z.string().url().default('http://localhost:4001'),

      /**
       * Emergency stop for minting. §4.3 makes this service the only minter, so
       * this switch is the only thing between a mis-tuned curve and permanent
       * supply inflation — and inflation cannot be un-minted.
       *
       * Gates both the `mintEpoch` tRPC procedure and the optional auto-tick.
       */
      EMISSIONS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * When true, svc-token mints the next sequential epoch on an interval.
       * Default OFF: minting is operator/cron-driven via `mintEpoch` so a
       * redeploy cannot silently open the faucet. Prefer an external cron
       * calling `mintEpoch` (admin:treasury) when possible — an in-process
       * timer is invisible to operators (see svc-bank's job endpoints).
       */
      EMISSIONS_AUTO_TICK: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Emission epoch length in ms: a NEW epoch cannot start sooner than this
       * after the previous epoch was claimed (`token.epoch_too_early`, measured on
       * the database clock). Default 86400000 = 1 day — owner-present, Nitro's
       * pick 2026-10-14. Positive integer only. This is the cadence, NOT the
       * amount: reward per epoch, supply cap and halving interval stay unset in
       * `token_params` and owner-only.
       */
      EMISSIONS_EPOCH_MS: z.preprocess(
        // A blank compose pass-through (`${EMISSIONS_EPOCH_MS:-}`) is "not set", not 0.
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.coerce.number().int().positive().default(86_400_000),
      ),

      /**
       * Auto-tick POLL interval in ms (how often the in-process timer asks
       * "is the next epoch due?"). The time gate above is what enforces the epoch
       * length, so a poll that is too early is refused harmlessly. Blank / missing
       * falls back to a poll of min(EMISSIONS_EPOCH_MS, 60000) in index.ts; an
       * explicit value below 1000 or non-integer is still
       * `token.emissions_tick_unset`. Keep it well under EMISSIONS_EPOCH_MS: a
       * tick equal to the epoch length can land a few ms before the gate opens and
       * wait a whole extra epoch.
       */
      EMISSIONS_TICK_MS: z.string().optional(),

      /**
       * Weekly yield aggregation job. Default OFF: unset must refuse
       * `token.yield_job_unset` rather than invent fee totals. Host `.env`
       * turns it on; do not default true.
       */
      YIELD_JOB_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /**
       * Real-yield distribution cadence in hours. No default — `168` is a live
       * weekly magnitude; blank / missing is `token.yield_job_unset`. Explicit
       * `168` is owner-present. Never git-default a cron.
       */
      YIELD_DISTRIBUTION_CRON_HOURS: z.string().optional(),

      /**
       * Buyback market-buy job. Default OFF: unset must refuse
       * `token.buyback_job_unset` rather than invent a fill. Host `.env`
       * turns it on; do not default true.
       */
      BUYBACK_JOB_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(v.toLowerCase()))),

      /** svc-trade — public orderbook for buyback depth. Place is not this URL's user REST door. */
      TRADE_URL: z.string().url().default('http://localhost:4004'),

      /**
       * Internal-book symbol for the IOC market-buy. Blank is refuse-closed
       * (`token.buyback_job_unset`) — do not default a listing.
       */
      BUYBACK_SYMBOL: z.string().default(''),

      /**
       * Quote asset whose houseFees size the spend. Blank is refuse-closed —
       * do not default USDT.
       */
      BUYBACK_QUOTE_ASSET: z.string().default(''),

      /**
       * Owner quorum for `closeProposal`, in bps of active stake. No default —
       * blank / missing is `token.governance_quorum_unset`. Never invent a bar.
       */
      TOKEN_GOVERNANCE_QUORUM_BPS: z.string().optional(),

      /**
       * Owner for-threshold for `closeProposal`, in bps of (for+against).
       * Same blank-refuse as quorum. Explicit `0` is owner-present.
       */
      TOKEN_GOVERNANCE_THRESHOLD_BPS: z.string().optional(),

      /**
       * Who may open a proposal. NO DEFAULT. Blank is `token.proposer_rule_unset`.
       * `stake:<decimal>`, `authors:<account>,<account>`, or `listed:<account>,<account>`.
       * Used only when the stored proposer row is still blank. A stored row wins.
       */
      TOKEN_PROPOSER_RULE: z.string().optional(),

      /**
       * Who may vote (MC-token-03). NO DEFAULT. Blank is `token.vote_rule_unset`.
       * `power:<decimal>`: least voting power, at the proposal's creation
       * snapshot, that may vote. `power:0` is a deliberate zero.
       */
      TOKEN_VOTE_RULE: z.string().optional(),

      /**
       * How many proposals one author may open per period. NO DEFAULT.
       * Blank is `token.proposal_limit_unset`. Shape `count:period_ms`.
       * `0` is a deliberate zero. Used only when the stored row is still blank.
       */
      TOKEN_PROPOSAL_LIMIT: z.string().optional(),

      /**
       * Who may take part in a launch. NO DEFAULT. Blank is `launch.min_kyc_tier_unset`.
       * The least identity verification: `none`, `basic`, `full` or `institutional`.
       */
      TOKEN_LAUNCH_MIN_KYC_TIER: z.string().optional(),

      /**
       * Regions that may not take part in a launch: two-letter codes, comma separated, or `none`.
       * NO DEFAULT. Blank is `launch.restricted_regions_unset`.
       */
      TOKEN_LAUNCH_RESTRICTED_REGIONS: z.string().optional(),

      /**
       * Identity issuer for operator treasury consume (distributeRevenue /
       * recordBuyback). Blank / unset → those doors refuse
       * (`action_approval.identity_unwired`). HMAC jobs do not call identity.
       */
      IDENTITY_URL: z.string().url().optional(),
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
