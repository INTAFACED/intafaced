import { z } from 'zod';
import { authEnvSchema, internalServiceEnvSchema, loadEnv, serviceEnvSchema } from '@intafaced/config';

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
  );

export const env = loadEnv(schema);
export type Env = typeof env;
