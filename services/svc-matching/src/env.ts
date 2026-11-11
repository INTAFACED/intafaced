import { z } from 'zod';
import { parseCustodyLayer, resolveOwnOrderBook } from '@intafaced/ledger-client';
import { parseOperatorIds } from './action-approval-consume.js';
import {
  baseEnvSchema,
  edgeEnvSchema,
  httpEnvSchema,
  internalServiceEnvSchema,
  loadEnv,
  natsEnvSchema,
  otelEnvSchema,
  redisEnvSchema,
  s2sEnvSchema,
} from '@intafaced/config';

/**
 * svc-matching environment.
 *
 * Composed from the slices rather than `serviceEnvSchema`, and the omission is
 * the point: **there is no `DATABASE_URL`.** §5.1 gives this service in-memory
 * books and an append-only journal, and nothing else. A service that demands a
 * database connection it never opens is a service someone will eventually give
 * a table to.
 */
const schema = baseEnvSchema
  .merge(redisEnvSchema)
  .merge(natsEnvSchema)
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  // The engine accepts ORDER WRITES, so it must tell svc-trade / svc-execution /
  // svc-fix from a stranger. No default: an engine that cannot must refuse to boot
  // rather than take unfunded orders from whoever found the port.
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-matching'),
      HTTP_PORT: z.coerce.number().int().default(4004),

      /**
       * Where the append-only journal lives (§5.1). Every input lands here and
       * is fsync'd before the book moves, so a cold start replays to exactly
       * the state the process died in.
       */
      MATCHING_JOURNAL_PATH: z.string().min(1).default('./.data/matching/engine_journal.ndjson'),

      /**
       * §5.1: "Snapshot every N events". Owner-published cadence. Blank / unset
       * refuses boot (never invent 500). Owner may set 500 explicitly. 0
       * disables snapshotting when the owner publishes 0 — empty string is not 0.
       */
      MATCHING_SNAPSHOT_EVERY: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.coerce.number().int().min(0),
      ),

      /**
       * Kill-switch, mirroring the `matching.engine` flag. When false the
       * engine refuses submissions **before** journalling them — the journal
       * means "processed, in this order", and an input that was never processed
       * does not belong in it.
       *
       * Trim first. After trim, `0` / `false` / `off` / `no`, blank, and
       * whitespace disable. `true` / `yes` / `on` / `1` enable. A boolean is
       * used as-is. Unset follows the custody switch (`resolveOwnOrderBook`,
       * ledger-client): enabled only when LEDGER_CUSTODY_LAYER is on, because
       * every fill of our own book settles as customer money in our ledger.
       * Enabled with custody off refuses boot.
       */
      MATCHING_ENGINE_ENABLED: z
        .union([z.boolean(), z.string()])
        .optional()
        .transform((v) => {
          if (v === undefined) return undefined;
          if (typeof v === 'boolean') return v;
          const token = v.trim().toLowerCase();
          return !['', '0', 'false', 'off', 'no'].includes(token);
        }),

      /**
       * The custody switch (OWNER 226), the same value svc-ledger reads, with its parser: unset or blank is `off`, any
       * value but `on` or `off` refuses to start. Read here only to decide whether our own engine runs.
       */
      LEDGER_CUSTODY_LAYER: z
        .string()
        .optional()
        .transform((raw, ctx) => {
          try {
            return parseCustodyLayer(raw);
          } catch (err) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
            return z.NEVER;
          }
        }),

      /**
       * Identity issuer for halt/resume/mode consume.
       * Blank / unset → those doors refuse (`action_approval.identity_unwired`).
       */
      IDENTITY_URL: z.string().url().optional(),

      /**
       * Who may propose and approve venue actions (open, halt, resume, ...):
       * comma-separated identity user ids, whitespace trimmed, compared without
       * case. REQUIRED, at least two distinct ids (a proposer and a different
       * approver). Blank, one id or duplicates refuse boot: a lost variable must
       * not leave journal-replayed markets trading with no reachable halt.
       */
      /**
       * svc-ledger base URL for the replay hold check. Blank / unset is unwired:
       * a book that replays resting orders stays closed (`matching.hold_check_unwired`)
       * rather than matching them. No default host — this service does not invent
       * a ledger. Read-only (`balances`); matching still has no DATABASE_URL.
       */
      LEDGER_URL: z.preprocess(
        (value) => (typeof value !== 'string' || value.trim() === '' ? undefined : value.trim()),
        z.string().url().optional(),
      ),

      /**
       * Founder door verifies the edge principal. Blank → `/operator/*` refuses
       * matching.operator_auth_unconfigured. S2S HMAC halt does not need it.
       * Never required at boot: a missing value must not crash-loop the book.
       */
      EDGE_PRINCIPAL_SECRET: z.preprocess(
        (value) => (typeof value !== 'string' || value.trim() === '' ? undefined : value.trim()),
        z.string().min(32).optional(),
      ),

      /** The edge's Ed25519 public key; with it the founder door also accepts public-key signatures. */
      EDGE_PRINCIPAL_PUBLIC_KEY: edgeEnvSchema.shape.EDGE_PRINCIPAL_PUBLIC_KEY,
      EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS: edgeEnvSchema.shape.EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS,
      EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS: edgeEnvSchema.shape.EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS,

      MATCHING_OPERATOR_IDS: z
        .string()
        .default('')
        .superRefine((raw, ctx) => {
          if (parseOperatorIds(raw).size < 2) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'FATAL: MATCHING_OPERATOR_IDS must list at least two distinct operator user ids (comma-separated). ' +
                'svc-matching refuses to boot without them: with no operators nobody could halt or open a market.',
            });
          }
        }),
    }),
  )
  .transform((raw, ctx) => {
    // The boot guard: our own order book never runs with the custodial layer off (OWNER 288).
    const book = resolveOwnOrderBook('MATCHING_ENGINE_ENABLED', raw.MATCHING_ENGINE_ENABLED, raw.LEDGER_CUSTODY_LAYER);
    if ('refusal' in book) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MATCHING_ENGINE_ENABLED'], message: book.refusal });
      return z.NEVER;
    }
    return { ...raw, MATCHING_ENGINE_ENABLED: book.enabled };
  });

export const matchingEnvSchema = schema;
export const env = loadEnv(schema);
export type Env = typeof env;
