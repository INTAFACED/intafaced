import { z } from 'zod';
import { edgeEnvSchema, loadEnv, serviceEnvSchema, internalServiceEnvSchema, s2sEnvSchema } from '@intafaced/config';
import { parseOwnerIntegerEnv } from './fee-bps-env.js';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase())));

/** Blank / unset / non-integer → null. Never a git-default magnitude. */
const ownerInt = z
  .union([z.string(), z.number()])
  .optional()
  .transform((raw) => parseOwnerIntegerEnv(raw));

// This service self-mounts /trpc, so it must be able to authenticate the edge.
// Releasing escrow is one `p2p:write` check away, and that check reads a
// principal it did not derive — so the header carrying it must be signed, or the
// check is decorative (docs/decisions/mount-boundary.md).
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-p2p'),
      HTTP_PORT: z.coerce.number().int().default(4004),

      /** svc-ledger's internal address. Escrowed value lives there, not here. */
      LEDGER_URL: z.string().url().default('http://localhost:4001'),

      /**
       * svc-identity base for affiliate accrue/payout after escrowRelease.
       * Unset → noop port (release still posts). No localhost default.
       */
      IDENTITY_URL: z.string().url().optional(),

      /**
       * KILL-SWITCH (§14 admin controls).
       *
       * OFF stops new offers and new takes. It deliberately does NOT stop
       * release, refund, dispute resolution or the sweeps: a switch that could
       * freeze settlement would be a switch that strands every open escrow, which
       * is the exact failure this service exists to make impossible.
       */
      P2P_TRADING_ENABLED: bool.default(true),

      /**
       * Platform fee, in bps, taken off the escrowed amount at release.
       * Blank / unset → null. Callers refuse `p2p.fee_bps_unset` — never invent 30.
       */
      P2P_FEE_BPS: ownerInt,

      /**
       * P-disputes-security-15. JSON table of per-tier buy caps in one fiat.
       * Empty is unset. A partial table or a JSON number is invalid, not a cap.
       * No default currency and no default amount.
       */
      P2P_VERIFICATION_LIMITS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional()),

      /**
       * Seconds a security-setting change would lock new sells. Empty is unset.
       * A positive value still cannot be applied until identity publishes the
       * change time; it is not 86400 by default.
       */
      P2P_SECURITY_CHANGE_LOCK_SECONDS: ownerInt,

      /**
       * P-trade-orders-03. Most ongoing orders (created, escrowed, paid, disputed) one person may hold as taker.
       * Empty is unset: every take then refuses `p2p.config_unset`. Not 5 by default.
       */
      P2P_ACTIVE_ORDER_CAP: ownerInt,

      /**
       * P-trade-orders-05. Cancelled orders (own cancels and lapsed payment windows) within P2P_BUYER_CANCEL_WINDOW_HOURS that pause buying.
       * Empty is unset: every buy then refuses `p2p.config_unset`. Not 3 by default.
       */
      P2P_BUYER_CANCEL_LIMIT: ownerInt,

      /**
       * P-trade-orders-05. The window, in hours, that P2P_BUYER_CANCEL_LIMIT counts cancelled orders over.
       * Empty is unset: every buy then refuses `p2p.config_unset`. Not 24 by default.
       */
      P2P_BUYER_CANCEL_WINDOW_HOURS: ownerInt,

      /**
       * P-trade-orders-15. Seconds the buyer of a paid order waits before reminding the seller to release, counted from
       * the mark-paid and again from each reminder. Empty is unset: every reminder then refuses `p2p.config_unset`.
       */
      P2P_REMIND_WAIT_SECONDS: ownerInt,

      /**
       * P-trade-orders-15. Most reminders one order may send the seller. Empty is unset: every reminder then refuses
       * `p2p.config_unset`.
       */
      P2P_REMIND_MAX: ownerInt,

      /**
       * P-ads-merchant-06. Ad edits one person may make per UTC day. Empty is unset: every ad edit then refuses
       * `p2p.config_unset`. No default.
       */
      P2P_OFFER_EDITS_PER_DAY: ownerInt,

      /**
       * P-trade-orders-20. Basis points of an order's fiat amount within which a reported under-, over- or part payment
       * lets the order go on (0 is the exact amount only, at most 10000). Empty is unset: no report is classified and
       * every one goes to a person through a dispute.
       */
      P2P_MISMATCH_TOLERANCE_BPS: ownerInt,

      /**
       * P-trade-orders-03. Per-order fiat bounds by pair, as JSON decimal strings: `{"USDT/EUR":{"min":"10","max":"5000"}}`.
       * Empty is unset and a pair missing from the table is unset for that pair: those takes refuse `p2p.config_unset`.
       */
      P2P_PAIR_LIMITS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional()),

      /**
       * P-ads-merchant-01. The advertiser terms version a person accepts before
       * posting an ad. Empty is unset: every post then refuses `p2p.config_unset`
       * naming this setting. Changing it asks every advertiser to accept again.
       */
      P2P_ADVERTISER_TERMS_VERSION: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.string().trim().min(1).max(64).optional(),
      ),

      /**
       * P-ads-merchant-05. Compliance's content rules for an ad's terms: a JSON
       * object of rule class to the phrases an ad may not carry, for example
       * `{"messenger":["telegram"],"link":["https://"]}`. Empty means no list is
       * published and the filter is off; anything else that is not a whole list
       * refuses every post `p2p.content_rules_invalid` (`ad-content-rules.ts`).
       */
      P2P_AD_CONTENT_RULES: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional()),

      /**
       * P-ads-merchant-12. Compliance's posting thresholds per fiat, JSON (`posting-eligibility.ts`): a fiat maps to
       * { minKycTier?, minCompletedOrders?, minCompletionRatePct? } as strings, or "none". Blank or a fiat not listed
       * refuses posting in it `p2p.config_unset`; a value that is not a whole list refuses every post.
       */
      P2P_POSTING_THRESHOLDS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional()),

      /**
       * Largest `maxAmt` an offer may advertise — the merchant badge's first
       * real entitlement (`merchant-limits.ts` argues why the numbers are not
       * invented in code).
       *
       * DECIMAL STRINGS, not numbers — or the literal `unlimited` when the
       * owner confirms no ceiling. An amount that arrives through
       * `z.coerce.number()` has already been through a float by the time
       * anything reads it. Left unset they are `null` with mode `unset`
       * (operationally still no cap, same as before Stage 2). That is not the
       * same claim as writing `unlimited`.
       */
      /**
       * Compose pass-through uses `${VAR:-}` so a clean clone injects "".
       * Empty is unset (same as omitted) — never a baked magnitude.
       */
      P2P_OFFER_MAX_STANDARD: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z
          .string()
          .regex(/^(unlimited|\d+(\.\d+)?)$/i, 'P2P_OFFER_MAX_STANDARD must be a non-negative decimal string or the literal unlimited')
          .optional(),
      ),
      /**
       * P-ads-merchant-21: seconds the author may edit a review after leaving it.
       * Empty is unset. Never invent a window. reviews.edit refuses p2p.config_unset.
       */
      P2P_REVIEW_EDIT_WINDOW_SECONDS: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        // At most a year: the edit check casts it to a Postgres int, and no window is longer than the order it reviews.
        z.coerce.number().int().min(1).max(31_536_000).optional(),
      ),
      /** P-trade-orders-21: hours support has to review a completion appeal. Empty is unset → appeal refuses p2p.config_unset. */
      P2P_APPEAL_REVIEW_HOURS: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.coerce.number().int().min(1).optional(),
      ),
      /**
       * P-trade-orders-14 owner caps (whole numbers ≥ 1). Empty is unset, and an
       * unset cap makes trades.exportFile / trades.receipt refuse p2p.config_unset.
       */
      P2P_EXPORT_MAX_RANGE_DAYS: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.coerce.number().int().min(1).optional(),
      ),
      P2P_EXPORT_MAX_ROWS: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.coerce.number().int().min(1).optional(),
      ),
      P2P_RECEIPT_DAILY_QUOTA: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.coerce.number().int().min(1).optional(),
      ),
      P2P_RECEIPT_PER_TRADE_QUOTA: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z.coerce.number().int().min(1).optional(),
      ),
      P2P_OFFER_MAX_MERCHANT: z.preprocess(
        (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
        z
          .string()
          .regex(/^(unlimited|\d+(\.\d+)?)$/i, 'P2P_OFFER_MAX_MERCHANT must be a non-negative decimal string or the literal unlimited')
          .optional(),
      ),

      /**
       * `created` → the take never finished escrowing. Nothing is locked yet.
       * Blank / unset → null. Callers refuse `p2p.escrow_deadline_unset` — never invent 120s.
       */
      P2P_ESCROW_DEADLINE_SECONDS: ownerInt,

      /**
       * `escrowed` → the buyer never marked the fiat sent. Refunds the seller.
       * Blank / unset → null. Callers refuse `p2p.payment_deadline_unset` — never invent 15m.
       */
      P2P_PAYMENT_DEADLINE_SECONDS: ownerInt,

      /**
       * `fiat_sent` → the seller never confirmed. Opens a dispute, never auto-releases.
       * Blank / unset → null. Callers refuse `p2p.release_deadline_unset` — never invent 30m.
       */
      P2P_RELEASE_DEADLINE_SECONDS: ownerInt,

      /**
       * `disputed` → THE MODERATOR SLA, and nothing more than that.
       *
       * Past this the dispute ESCALATES: it is raised, it keeps its (now past)
       * deadline so it stays at the top of the moderator queue, and the escrow
       * does not move. There is no setting here that resolves a dispute,
       * because there is no code path that does.
       *
       * `P2P_DISPUTE_BACKSTOP_SECONDS`, `P2P_DISPUTE_BACKSTOP_RESOLUTION` and
       * `P2P_BACKSTOP_MODERATOR_ID` are gone rather than deprecated. Leaving a
       * `…_RESOLUTION` knob in the environment would say the platform still has
       * an opinion about how to auto-settle a disagreement, and it does not.
       *
       * Blank / unset → null. Callers refuse `p2p.dispute_sla_unset` — never invent 7d.
       */
      P2P_DISPUTE_SLA_SECONDS: ownerInt,

      /**
       * How often an escalated dispute is raised again.
       *
       * `p2p_trades_live_has_deadline_ck` requires a live trade to carry a
       * deadline. This is the deadline it carries once the SLA is blown — a
       * re-check, not a disposition.
       *
       * Blank / unset → null. Callers refuse `p2p.dispute_escalation_recheck_unset`
       * — never invent 1h.
       */
      P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: ownerInt,

      /**
       * How often the timeout + settlement sweeps run.
       * Blank / unset → null. Callers refuse `p2p.sweep_interval_unset` — never invent 30s.
       */
      P2P_SWEEP_INTERVAL_SECONDS: ownerInt,

      /**
       * How long a CLOSED trade keeps the account details it showed the buyer.
       *
       * The API already refuses to disclose a terminal trade's snapshot; this
       * is the other half of the same promise, because "you cannot read it" and
       * "we no longer have it" are different statements and only the second
       * survives a database being copied. The purge keeps the fingerprint, so
       * a late appeal can still be told whether the account a seller now names
       * is the one the buyer was shown — without us holding the account to say
       * so.
       *
       * The NUMBER is an operator decision, not an engineering one: it trades
       * the ability to adjudicate a late appeal against holding personal data
       * we no longer need, and where a market imposes its own retention rule
       * that rule wins. Blank / unset → null. Callers refuse
       * `p2p.instrument_retention_unset` — never invent 90d. When both knobs
       * are published, the cross-field check after this object enforces that
       * retention (in seconds) is never shorter than `P2P_DISPUTE_SLA_SECONDS`,
       * so a purge cannot race an open appeal even if both knobs are retuned.
       */
      P2P_INSTRUMENT_RETENTION_DAYS: ownerInt,

      /**
       * HUMAN MODERATORS this deployment will actually serve.
       *
       * Comma-separated lowercase canonical UUIDs. Empty (the default) means
       * moderation is NOT configured: `disputes.list` / `disputes.resolve`
       * honest-refuse with `p2p.moderation_unreachable` rather than sitting
       * behind `admin:compliance` that no user session can hold (D-S-08).
       * Named ids moderate with ordinary `p2p:read`. This is not the
       * `p2p:moderate` scope split — that remains an owner sign-off.
       */
      P2P_MODERATOR_USER_IDS: z.string().default(''),

      /**
       * When true, disputes.resolve consumes a p2p.dispute_resolve approval
       * before escrow moves. Unset, blank, and every value other than an
       * explicit on is false. This ships off. Turning it on removes
       * single-moderator resolution and is a lead policy decision.
       */
      P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL: z.preprocess(
        (value) => {
          if (typeof value === 'boolean') return value ? 'true' : 'false';
          if (typeof value !== 'string' || value.trim() === '') return undefined;
          return value.trim().toLowerCase();
        },
        z
          .enum(['0', '1', 'false', 'true', 'off', 'on', 'no', 'yes'])
          .optional()
          .transform((value) => value === '1' || value === 'true' || value === 'on' || value === 'yes'),
      ),
    }),
  )
  .superRefine((value, ctx) => {
    const escrow = value.P2P_ESCROW_DEADLINE_SECONDS;
    if (escrow != null && (!Number.isInteger(escrow) || escrow < 30)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_ESCROW_DEADLINE_SECONDS'],
        message: `P2P_ESCROW_DEADLINE_SECONDS must be an integer ≥ 30, got ${escrow}`,
      });
    }

    const payment = value.P2P_PAYMENT_DEADLINE_SECONDS;
    if (payment != null && (!Number.isInteger(payment) || payment < 60)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_PAYMENT_DEADLINE_SECONDS'],
        message: `P2P_PAYMENT_DEADLINE_SECONDS must be an integer ≥ 60, got ${payment}`,
      });
    }

    const release = value.P2P_RELEASE_DEADLINE_SECONDS;
    if (release != null && (!Number.isInteger(release) || release < 60)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_RELEASE_DEADLINE_SECONDS'],
        message: `P2P_RELEASE_DEADLINE_SECONDS must be an integer ≥ 60, got ${release}`,
      });
    }

    const sla = value.P2P_DISPUTE_SLA_SECONDS;
    if (sla != null && (!Number.isInteger(sla) || sla < 3600)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_DISPUTE_SLA_SECONDS'],
        message: `P2P_DISPUTE_SLA_SECONDS must be an integer ≥ 3600, got ${sla}`,
      });
    }

    const recheck = value.P2P_DISPUTE_ESCALATION_RECHECK_SECONDS;
    if (recheck != null && (!Number.isInteger(recheck) || recheck < 60)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_DISPUTE_ESCALATION_RECHECK_SECONDS'],
        message: `P2P_DISPUTE_ESCALATION_RECHECK_SECONDS must be an integer ≥ 60, got ${recheck}`,
      });
    }

    const sweep = value.P2P_SWEEP_INTERVAL_SECONDS;
    if (sweep != null && (!Number.isInteger(sweep) || sweep < 5)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_SWEEP_INTERVAL_SECONDS'],
        message: `P2P_SWEEP_INTERVAL_SECONDS must be an integer ≥ 5, got ${sweep}`,
      });
    }

    const retention = value.P2P_INSTRUMENT_RETENTION_DAYS;
    if (retention != null && (!Number.isInteger(retention) || retention < 30 || retention > 3_650)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_INSTRUMENT_RETENTION_DAYS'],
        message: `P2P_INSTRUMENT_RETENTION_DAYS must be an integer in 30..3650, got ${retention}`,
      });
    }

    // Audit P4 (2026-08-08): a 60-day SLA with a 30-day retention floor was a
    // valid config before this check, and the purge then raced open appeals.
    // Unset knobs are typed refuses, not invented hours/days — skip until both published.
    if (retention == null || sla == null) return;
    const retentionSeconds = retention * 24 * 60 * 60;
    if (retentionSeconds < sla) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['P2P_INSTRUMENT_RETENTION_DAYS'],
        message:
          `P2P_INSTRUMENT_RETENTION_DAYS (${retention}d = ${retentionSeconds}s) ` +
          `must be at least P2P_DISPUTE_SLA_SECONDS (${sla}s), ` +
          `or a purge can race an open dispute appeal.`,
      });
    }
  });

export const env = loadEnv(schema);
export type Env = typeof env;
