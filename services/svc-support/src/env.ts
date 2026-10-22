import { supportSurveyCapEnv } from './survey-cap-env.js';
import { z } from 'zod';
import { edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';

/**
 * svc-support — durable tickets in Postgres (schema `support`).
 * DATABASE_URL is required (serviceEnvSchema) so the desk survives restarts
 * and multi-replica claims stay exclusive. Still no ledger, and never one.
 *
 * INTERNAL_SERVICE_SECRET is now required, and the reason is narrow: reading
 * account state from svc-identity is an S2S call and `/internal/account/:userId`
 * hard-401s an unauthenticated caller. Required rather than optional because a
 * desk that boots without it looks healthy and then reports every account as
 * unread — a degraded mode that is indistinguishable, from the operator's
 * chair, from every account genuinely being unreadable. Refusing to start says
 * it once, loudly, at deploy time. (`compose-secret-parity` holds the other
 * half: the compose block must actually supply it.)
 *
 * IDENTITY_URL is optional with a dev default, matching `svc-trade`. It is not
 * a secret and a missing one is a wrong address, not a silent authority hole.
 */
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      HTTP_PORT: z.coerce.number().int().positive().default(4017),
      /** svc-identity, for the account-state read port. Never written to. */
      IDENTITY_URL: z.string().url().default('http://localhost:4002'),
      /**
       * svc-trade, for the order read port. Unset means the desk reports
       * unknown rather than calling a guessed address. Never a ledger URL.
       */
      TRADE_URL: z.string().url().optional(),
      /**
       * Seconds without a heartbeat before an online or busy agent reads as
       * offline. Blank is an owner value left unset: availability stays as
       * last set and the desk says so. Never defaulted.
       */
      /**
       * Staff roles the owner marks as seeing every group once groups exist,
       * comma separated (agent, lead). Blank marks none: scope then follows
       * group membership and assignment only. Never defaulted.
       */
      SUPPORT_ALL_GROUPS_ROLES: z
        .string()
        .optional()
        .transform((v) =>
          (v ?? '')
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
        )
        .pipe(z.array(z.enum(['agent', 'lead']))),
      /**
       * Seconds between passes that scan again the attachments a crash or a scanner outage left held, and how many one
       * pass takes. Both are owner values: while either is blank no pass runs, held files wait for the owner's retry, and
       * the desk says so. Never defaulted.
       */
      SUPPORT_ATTACHMENT_RESCAN_SECONDS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
      SUPPORT_ATTACHMENT_RESCAN_BATCH: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
      /**
       * LOCAL-TEST attachment adapters (`local-test-memory`, `local-test-eicar`). Blank installs none and attach refuses
       * with the missing piece named. Refused at boot unless APP_ENV is exactly dev or test. Never set in production.
       */
      SUPPORT_ATTACHMENT_STORE: z.string().optional(),
      SUPPORT_MALWARE_SCANNER: z.string().optional(),
      /**
       * How many requests one bulk change may hold. Blank is an owner value left unset: a bulk change refuses
       * support.bulk_cap_unset and the desk says so. Never defaulted.
       */
      /** SP-csat-02: owner cap on how many surveys exist; blank allows only the first. */
      SUPPORT_SURVEY_CAP: supportSurveyCapEnv,
      SUPPORT_BULK_CAP: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
      STAFF_HEARTBEAT_WINDOW_SECONDS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().optional()),
    }),
  );

export type SupportEnv = z.infer<typeof schema>;
export const env: SupportEnv = loadEnv(schema);
