import { z } from 'zod';
import {
  baseEnvSchema,
  httpEnvSchema,
  internalServiceEnvSchema,
  loadEnv,
  natsEnvSchema,
  otelEnvSchema,
  redisEnvSchema,
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
       * whitespace disable. Unset stays enabled. `true` / `yes` / `on` / `1`
       * enable. A boolean is used as-is.
       */
      MATCHING_ENGINE_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => {
          if (typeof v === 'boolean') return v;
          const token = v.trim().toLowerCase();
          return !['', '0', 'false', 'off', 'no'].includes(token);
        }),

      /**
       * Public rulebook version (M00). Blank is unpublished: GET /rulebook
       * refuses and best-execution / certified-venue claims refuse. A set
       * value is the version string only — this service does not invent
       * rule text, fees, or haircuts.
       */
      MATCHING_RULEBOOK_VERSION: z.string().default(''),

      /**
       * Identity issuer for halt/resume/mode consume.
       * Blank / unset → those doors refuse (`action_approval.identity_unwired`).
       */
      IDENTITY_URL: z.string().url().optional(),

      /**
       * Who may open a market: comma-separated user ids of the venue's
       * operators. Both the proposer and the approver of a `matching.open`
       * approval must be on this list. Blank / unset → nobody may open
       * (`action_approval.operators_unset`); matching does not guess a role.
       */
      MATCHING_OPERATOR_IDS: z.string().default(''),
    }),
  );

export const matchingEnvSchema = schema;
export const env = loadEnv(schema);
export type Env = typeof env;
