import { z } from 'zod';
import { reconciliationRailSchema } from '@intafaced/contracts/ledger-reconciliation';
import { parseClockSkewBoundMs } from './ledger/clock-skew.js';
import { resolveIdempotencyConflictMode } from './idempotency-conflict-mode.js';
import { authEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';
import {
  DEFAULT_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE,
  DEFAULT_RECONCILE_MAX_STALE_HOURS,
  DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS,
  MAX_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE,
  MAX_RECONCILE_MAX_STALE_HOURS,
  MAX_RECONCILE_STATEMENT_TIMEOUT_MS,
  MIN_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE,
  MIN_RECONCILE_MAX_STALE_HOURS,
  MIN_RECONCILE_STATEMENT_TIMEOUT_MS,
} from './ledger/reconcile-config.js';

/** Unset or blank takes the published default; anything else must pass the bounds. */
const blankIsUnset = (v: unknown) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v);

// svc-ledger SERVES the internal money plane, so it must be able to
// authenticate the services calling it. No default: a ledger that cannot tell
// a caller from a stranger must refuse to boot (#50).
//
// `authEnvSchema` is merged for the OPERATOR surface only (`operator-http.ts`):
// the freeze is a human's decision carrying a human's identity, so it is
// authenticated with the platform's own access tokens rather than the internal
// service secret — a secret has no subject, and `posting_freeze.actor` must
// name somebody. It does NOT give a user token any power over `post`; there is
// still no `ledger:write` scope for one to carry.
const schema = serviceEnvSchema
  .merge(internalServiceEnvSchema)
  .merge(authEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-ledger'),
      HTTP_PORT: z.coerce.number().int().default(4001),

      /**
       * What happens when a key that already booked a movement is posted again with a DIFFERENT body.
       * `detect` answers with the original and logs `ledger.idempotency_mismatch` (rollout mode: several jobs rebuild
       * their body from live state when re-run, and refusing them first would wedge crash recovery). `refuse` answers
       * 409 `ledger.idempotency_conflict`. Flip to `refuse` once the mismatch log is quiet and the call sites are fixed.
       * A stricter-direction default is not available yet: refusing today would stop liquidations after a crash.
       */
      LEDGER_IDEMPOTENCY_CONFLICT_MODE: z.enum(['detect', 'refuse']).default('detect'),

      /**
       * Reconciliation cadence in minutes. §4.2 specifies hourly snapshots.
       * Owner-published. Blank / unset refuses boot (never invent 60).
       * Owner may set 60 explicitly. Empty string is not 0 — 0 is not a legal cadence.
       */
      RECONCILE_CRON_MINUTES: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.coerce.number().int().min(1),
      ),

      /**
       * `statement_timeout` for ONE reconciliation proof, set with `SET LOCAL` inside its own
       * transaction. Posts keep the pool-wide 15 s. Default 10 minutes.
       */
      LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS: z.preprocess(
        blankIsUnset,
        z.coerce
          .number()
          .int()
          .min(MIN_RECONCILE_STATEMENT_TIMEOUT_MS)
          .max(MAX_RECONCILE_STATEMENT_TIMEOUT_MS)
          .default(DEFAULT_RECONCILE_STATEMENT_TIMEOUT_MS),
      ),

      /**
       * Staleness reporting: an older or absent proof produces a fatal log each tick.
       * This threshold never changes posting. Default 24 hours.
       */
      LEDGER_RECONCILE_MAX_STALE_HOURS: z.preprocess(
        blankIsUnset,
        z.coerce
          .number()
          .int()
          .min(MIN_RECONCILE_MAX_STALE_HOURS)
          .max(MAX_RECONCILE_MAX_STALE_HOURS)
          .default(DEFAULT_RECONCILE_MAX_STALE_HOURS),
      ),

      /**
       * Consecutive Postgres/connection failures that may leave posting open.
       * The next one freezes with reason `reconcile_unproven` (D-128). Default 3.
       */
      RECONCILE_MAX_CONSECUTIVE_INCOMPLETE: z.preprocess(
        blankIsUnset,
        z.coerce
          .number()
          .int()
          .min(MIN_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE)
          .max(MAX_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE)
          .default(DEFAULT_RECONCILE_MAX_CONSECUTIVE_INCOMPLETE),
      ),

      /**
       * Emergency freeze. When false, every `post` is refused.
       *
       * This is the most consequential switch in the platform and it exists
       * because §4.2 requires it: on a reconciliation mismatch the diverging
       * module is frozen rather than allowed to keep writing to a book we no
       * longer trust.
       */
      LEDGER_POSTING_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : ['true', 'yes', 'on', '1'].includes(v.trim().toLowerCase()))),

      /**
       * Milliseconds the app clock may differ from `clock_timestamp()` before a new post
       * refuses `ledger.writes_blocked_clock_skew`. A committed key still replays. Blank /
       * unset stays unset (`ledger.skew_bound_unset` on the integrity read). No default.
       * Explicit 0 is a real bound.
       */
      LEDGER_CLOCK_SKEW_BOUND_MS: z.preprocess((v) => (v === undefined || v === null ? undefined : v), z.string().optional()),

      /**
       * Identity issuer for operator freeze/unfreeze/reconcile consume.
       * Blank / unset → those doors refuse (`action_approval.identity_unwired`).
       * Boot/cron freeze does not call identity.
       */
      IDENTITY_URL: z.string().url().optional(),

      /**
       * Owner value, no default: where an outside-balance control reads the rail's balance snapshot
       * (OPS-reconciliation-01/-02). Blank / unset → the outside side is `unset`. Set but unreadable → that run is
       * ERROR (`ledger.reconcile_source_unavailable`), never PASS. The balances a money control trusts travel only over
       * https; plain http is accepted for a loopback host alone (the local TEST stack), and anything else refuses boot.
       */
      LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL: z.preprocess(
        (v) => (v === '' ? undefined : v),
        z.string().url().refine(isOutsideSnapshotUrl, 'must be https (plain http only for a loopback host)').optional(),
      ),
    }),
  );

/** https anywhere, or http on a loopback host only. */
function isOutsideSnapshotUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export const env = loadEnv(schema);
export type Env = typeof env;

const RAIL_STATEMENT_KEY = /^LEDGER_RECONCILE_RAIL_(.*)_URL$/i;

/**
 * Per-rail outside statement URLs (OPS-reconciliation-04): `LEDGER_RECONCILE_RAIL_<RAIL>_URL`, RAIL upper-cased with `-` as
 * `_` (`crypto-native` reads `LEDGER_RECONCILE_RAIL_CRYPTO_NATIVE_URL`). Owner values with no default: a blank one leaves
 * that rail's outside side unset. A name that is not a rail id, or a URL that is not https (plain http only for a loopback
 * host), refuses boot rather than being ignored.
 */
export function railStatementUrlsFrom(source: Record<string, string | undefined>): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    const match = RAIL_STATEMENT_KEY.exec(key);
    if (!match || value === undefined || value === '') continue;
    // Only the canonical spelling maps back to a rail id; anything else (lower case, a dash, an empty rail) refuses boot.
    const rail = match[1]!.toLowerCase().replaceAll('_', '-');
    if (!/^[A-Z0-9_]+$/.test(match[1]!) || !reconciliationRailSchema.safeParse(rail).success) throw new Error(`${key}: not a rail id`);
    let ok = false;
    try {
      ok = isOutsideSnapshotUrl(value);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${key}: must be https (plain http only for a loopback host)`);
    urls.set(rail, value);
  }
  return urls;
}

export const railStatementUrls: ReadonlyMap<string, string> = railStatementUrlsFrom(process.env);

const OPEN_ITEMS_KEY = /^LEDGER_RECONCILE_OPEN_ITEMS_(.*)_URL$/i;

/**
 * Per-rail open-items URLs (lead ruling 2026-10-30): `LEDGER_RECONCILE_OPEN_ITEMS_<RAIL>_URL`, spelled like the statement
 * URLs (`crypto-native` reads `LEDGER_RECONCILE_OPEN_ITEMS_CRYPTO_NATIVE_URL`), each the svc-pay door that lists that rail's
 * open items. A blank one leaves the rail without items, as today. A name that is not a rail id, or a URL that is not https
 * (plain http only for a loopback host), refuses boot.
 */
export function openItemsUrlsFrom(source: Record<string, string | undefined>): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    const match = OPEN_ITEMS_KEY.exec(key);
    if (!match || value === undefined || value === '') continue;
    const rail = match[1]!.toLowerCase().replaceAll('_', '-');
    if (!/^[A-Z0-9_]+$/.test(match[1]!) || !reconciliationRailSchema.safeParse(rail).success) throw new Error(`${key}: not a rail id`);
    let ok = false;
    try {
      ok = isOutsideSnapshotUrl(value);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`${key}: must be https (plain http only for a loopback host)`);
    urls.set(rail, value);
  }
  return urls;
}

export const openItemsUrls: ReadonlyMap<string, string> = openItemsUrlsFrom(process.env);

/** Parsed owner bound. Blank stays null; a bad string refuses boot rather than becoming a number. */
export const clockSkewBoundMs: number | null = parseClockSkewBoundMs(env.LEDGER_CLOCK_SKEW_BOUND_MS);

export const idempotencyConflictMode: 'detect' | 'refuse' = resolveIdempotencyConflictMode(
  env.LEDGER_IDEMPOTENCY_CONFLICT_MODE,
  process.env,
);
