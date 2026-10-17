import { z } from 'zod';
import { authEnvSchema, internalServiceEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';
import { assertDistinctCallerSecrets, CALLER_SECRET_ENV_NAMES, type CallerSecretEnvName } from './caller-allowlist.js';

function blankToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function callerSecretSchema() {
  return z.preprocess(blankToUndefined, z.string().min(32).optional());
}

type CallerSecretShape = {
  [K in CallerSecretEnvName]: ReturnType<typeof callerSecretSchema>;
};

/** One schema per tuple entry, so the parsed env keeps each secret's key name. */
function callerSecretFields(): CallerSecretShape {
  const fields = {} as CallerSecretShape;
  for (const name of CALLER_SECRET_ENV_NAMES) fields[name] = callerSecretSchema();
  return fields;
}

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
       * OPS-0001. `report` (default) still accepts the shared internal secret and
       * still posts. Each shared-secret post is counted as unbound. `enforce`
       * refuses that post. Set enforce only when the unbound count is 0 for
       * every posting service and allowlist violations are 0 for a full business
       * cycle. A quiet warning log is not that signal. Blank is report, so a
       * local stack that never set this keeps posting after a pull.
       */
      LEDGER_CALLER_BINDING: z.preprocess(blankToUndefined, z.enum(['report', 'enforce']).default('report')),

      /**
       * One HMAC secret per calling service. The env name is the key id
       * (`LEDGER_CALLER_SECRET_SVC_PAY` verifies `x-intafaced-service: svc-pay`).
       * Blank or unset means that caller has no dedicated secret yet. Do not
       * invent one here.
       */
      ...callerSecretFields(),

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
       * Identity issuer for operator freeze/unfreeze/reconcile consume.
       * Blank / unset → those doors refuse (`action_approval.identity_unwired`).
       * Boot/cron freeze does not call identity.
       */
      IDENTITY_URL: z.string().url().optional(),
    }),
  )
  .superRefine((parsed, ctx) => {
    const named: Array<readonly [string, string]> = [];
    for (const name of CALLER_SECRET_ENV_NAMES) {
      const value = parsed[name];
      if (typeof value === 'string' && value.length > 0) named.push([name, value]);
    }
    try {
      assertDistinctCallerSecrets(named, parsed.INTERNAL_SERVICE_SECRET);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'dedicated caller secret is not distinct',
      });
    }
  });

export const env = loadEnv(schema);
export type Env = typeof env;
