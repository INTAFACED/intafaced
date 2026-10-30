import { z } from 'zod';
import { edgeEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema, internalServiceEnvSchema } from '@intafaced/config';

/**
 * svc-agents environment.
 *
 * ── Why the upstream is described here and named nowhere ────────────────────
 *
 * §1 puts a specific vendor first and Doctrine §0.5 makes providers swappable;
 * Doctrine §0.7 forbids third-party system names in anything shipped. All three
 * hold if the provider's identity lives in deployment configuration rather than
 * in source — so the variables below describe an upstream's *shape* (where it
 * is, how it authenticates, which aliases map to which of its model ids) and
 * the deployment supplies the values.
 *
 * The practical test of whether that is real: swapping providers is editing
 * `AGENTS_UPSTREAM_*` and restarting. No code changes, no redeploy of a
 * different build, nothing to review. That is what §8.2 means by
 * "provider-agnostic".
 *
 * `AGENTS_UPSTREAM_API_KEY` matches `packages/config`'s secret pattern
 * (`_KEY`), so `redactEnv` masks it anywhere env is logged. It is read once, in
 * `index.ts`, handed to the adapter, and never placed on a span or in an error.
 */

const jsonRecord = (label: string) =>
  z
    .string()
    .default('{}')
    .transform((raw, ctx) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v !== 'string') throw new Error(`value for "${k}" is not a string`);
          out[k] = v;
        }
        return out;
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a JSON object of string values: ${(err as Error).message}`,
        });
        return z.NEVER;
      }
    });

const METERING_TRUE = new Set(['1', 'true', 'yes', 'on']);
const METERING_FALSE = new Set(['0', 'false', 'no', 'off']);

/**
 * Kill-switch tokens. False-tokens → false (must NOT bill). Unset / blank
 * refuse boot (`agents.metering_enabled_unset`) — never invent true, never
 * silently kill billing. Garbage refuses boot — the denylist
 * `!['0','false','off','no']` treated `false ` and `garbage` as true.
 */
const meteringFlag = z.union([
  z.boolean(),
  z.string().transform((raw, ctx) => {
    const token = raw.trim().toLowerCase();
    if (METERING_TRUE.has(token)) return true;
    if (METERING_FALSE.has(token)) return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be true/false/1/0/on/off/yes/no (garbage must not bill)',
    });
    return z.NEVER;
  }),
]);

/** Compose interpolates unset optional URLs to "". Blank is absent, not an invalid URL. */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

// This service self-mounts /trpc, so it must be able to authenticate the edge.
// Only mounting services merge this — a service reached solely through the
// gateway has no edge header to verify, and demanding the secret there would
// make it boilerplate people copy without meaning it.
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-agents'),
      HTTP_PORT: z.coerce.number().int().default(4008),

      /**
       * svc-ledger's internal address. Metered usage is billed through it.
       * Required — no localhost default. Unset / blank refuses boot (EnvError)
       * rather than inventing http://localhost:4001 and posting feeCharge.
       */
      LEDGER_URL: z.string().url(),

      /**
       * svc-identity base for affiliate accrue + payout after usage feeCharge,
       * and for navigator identity.session.read.
       * Blank / unset → noop affiliate ports (feeCharge still posts) and no
       * navigator identity port. Live identity.session.read then refuses
       * `no_live_session` rather than using a caller fixture as live truth.
       * Never invent rates. No localhost default.
       */
      IDENTITY_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * Academy base URL for coach curriculum grounding
       * (`GET /internal/curriculum`). Unset / blank → envCoachGrounding() empty
       * catalog (chatbot refuse). Set → S2S fetch; 401/dark academy still empty.
       */
      ACADEMY_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * svc-support base for live KB/ticket reads (`/trpc/searchKb`, `/trpc/getKb`,
       * `/trpc/get`). Unset / blank → support live tools refuse `no_live_kb`.
       * No localhost default — unset is honest dark, not a guessed desk.
       */
      SUPPORT_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * svc-trade base for scanner live spot tickers (`GET /api/v1/tickers`).
       * Unset / blank → scanner rank runs refuse `no_live_tickers`.
       * No localhost default — unset is honest dark, not a guessed venue.
       */
      TRADE_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * Quote asset for portfolio.plan marks (`GET /api/v1/ticker/:asset/:quote`).
       * Blank / unset leaves the price port unwired: plan stays `portfolio.port_dark`.
       * Never invent a quote (no USD default). An asset with no ticker refuses
       * `portfolio.price_unset` once this and TRADE_URL are both set.
       */
      PORTFOLIO_QUOTE_ASSET: blankAsAbsent(z.string().trim().min(1).max(32).optional()),

      /**
       * svc-pay base for merchant approval-rate watch
       * (`GET /internal/agents/merchant-watch-metrics`). Unset / blank → merchant
       * watch refuses `no_live_metrics`. No localhost default.
       */
      PAY_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * svc-bank base for a business team's members (`POST /internal/agents/team-membership`). Unset / blank → every
       * team call refuses `agents.membership_unavailable`. No localhost default.
       */
      BANK_URL: blankAsAbsent(z.string().url().optional()),

      /**
       * Copy-intel live trade.copy leader plane (Class X). Only the literal `true`
       * opens the sealed plane; blank / unset stays refuse-closed.
       */
      LIVE_TRADE_COPY_LEADER_PLANE_OPEN: blankAsAbsent(z.literal('true').optional()),

      /**
       * Comma-separated owner allowlist of leader ids. Blank / unset → empty list
       * (refuse). Never seeded with invented leader ids in compose.
       */
      LIVE_TRADE_COPY_LEADER_IDS: blankAsAbsent(z.string().optional()),

      /**
       * Asset premium agent tiers are billed in (§8.2). Owner-published.
       * Trim, then min(1) — unset, blank, and whitespace-only refuse boot.
       * Never invent IFC. A padded owner id boots as the trimmed value.
       */
      AGENTS_FEE_ASSET_ID: z.string().trim().min(1),

      /**
       * Overage grace: how much usage, in the fee asset, a person may leave
       * unpaid and still start a run. Owner-published. Blank / unset is no
       * grace at all: any window that could not be paid refuses the next run
       * with `agents.overage_grace_unset`. Never a default amount.
       */
      AGENTS_OVERAGE_GRACE: blankAsAbsent(
        z
          .string()
          .trim()
          .regex(/^\d{1,20}(\.\d{1,18})?$/, 'a decimal amount, such as 0.5')
          .optional(),
      ),

      /**
       * Billing window length. Must divide 1440 so a window never straddles
       * midnight — a window that spans two days has an ambiguous id, and the id
       * is half of the ledger idempotency key.
       * No git default: blank refuses (never 60). Owner may set 60 explicitly.
       */
      AGENTS_USAGE_WINDOW_MINUTES: z.coerce
        .number()
        .int()
        .min(1)
        .max(1440)
        .refine((minutes) => 1440 % minutes === 0, {
          message: 'must divide 1440 so a billing window never straddles midnight',
        }),

      /**
       * Kill-switch for billing (§14 admin controls). When off (D26-P1-A6
       * product law, sealed): audit-only forever — no usage_records, no windows,
       * no feeCharge — including settle of leftover windows. Token counts stay
       * on the action audit only (knowable cost without inventing a deferred
       * bill). Dual-write of usage_records while off is forbidden.
       *
       * Unset / blank refuses (`agents.metering_enabled_unset`) — never invent
       * true (fail-open feeCharge) and never default false (silent kill-switch).
       * Owner may set true. Trimmed false tokens stay off. Garbage refuses boot.
       */
      AGENTS_METERING_ENABLED: z.preprocess((v, ctx) => {
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'agents.metering_enabled_unset',
          });
          return z.NEVER;
        }
        return typeof v === 'string' ? v.trim() : v;
      }, meteringFlag),

      /**
       * Which registered provider serves the logical id `primary` in the routing
       * table. `mock` is the default so a developer can run the fleet with no
       * upstream credential — and, more usefully, so starting this service by
       * accident cannot spend money.
       */
      AGENTS_PROVIDER: z.enum(['mock', 'upstream']).default('mock'),
      /** Milliseconds the mock engine takes to answer (test stacks only; ignored by the upstream provider). */
      AGENTS_MOCK_DELAY_MS: z.coerce.number().int().min(0).max(10_000).optional(),
      /**
       * TEST stand-in only: a file whose presence parks the mock engine's completions (`MockProviderOptions.holdFile`).
       * Read only when AGENTS_PROVIDER is mock; an upstream engine never parks.
       */
      AGENTS_MOCK_HOLD_FILE: z.string().trim().min(1).optional(),

      // ── Upstream shape ───────────────────────────────────────────────────────
      AGENTS_UPSTREAM_BASE_URL: z.string().url().optional(),
      AGENTS_UPSTREAM_API_KEY: z.string().min(1).optional(),
      AGENTS_UPSTREAM_AUTH_HEADER: z.string().default('x-api-key'),
      AGENTS_UPSTREAM_AUTH_PREFIX: z.string().default(''),
      /** Static headers — protocol version pins, tenant ids. JSON object. */
      AGENTS_UPSTREAM_HEADERS: jsonRecord('AGENTS_UPSTREAM_HEADERS'),
      AGENTS_UPSTREAM_COMPLETIONS_PATH: z.string().default('/v1/messages'),
      /** Set only when the upstream serves embeddings; gates the capability. */
      AGENTS_UPSTREAM_EMBEDDINGS_PATH: z.string().optional(),
      /** Routing alias → concrete upstream model id. JSON object. */
      AGENTS_UPSTREAM_MODELS: jsonRecord('AGENTS_UPSTREAM_MODELS'),
      AGENTS_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

      /**
       * Full routing table as JSON, overriding the built-in default (§8.2
       * "per-task model routing table"). Absent = the default table in
       * `gateway/routing.ts`, which is priced for development, not production.
       */
      AGENTS_ROUTING_TABLE: z.string().optional(),
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
