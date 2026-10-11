import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, internalServiceEnvSchema, loadEnv, otelEnvSchema } from '@intafaced/config';

/**
 * svc-ops — durable outreach CRM / team / revenue / projects. No payroll, no
 * second money book. HTTP_PORT 4022: 4020 is tax; 4021 is reserved.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-ops'),
      HTTP_PORT: z.coerce.number().int().positive().default(4022),
      /** Outreach authority client URL. Legacy warehouse/team sources remain absent. */
      IDENTITY_URL: blankAsAbsent(z.string().url().optional()),
      /** Env URL only. This process does not fetch; /ready names hardcoded-absent. */
      SUPPORT_URL: blankAsAbsent(z.string().url().optional()),
      NOTIFY_URL: blankAsAbsent(z.string().url().optional()),
      /** Dedicated ops-to-guest ingress key; match NOTIFY_OPS_SERVICE_SECRET. */
      OPS_NOTIFY_SERVICE_SECRET: blankAsAbsent(z.string().min(32).optional()),
      /** Blank → custody wrap/execute refuse ops.custody_wrap_unset. Never invent a wrap key. */
      OPS_CUSTODY_WRAP: blankAsAbsent(z.string().optional()),
      /**
       * Owner freeze policy. Blank / unknown → execute and createApproval refuse
       * ops.custody_freeze_unset. `frozen` → ops.custody_frozen. `open` passes
       * the freeze gate only. Never invents thresholds or a send.
       */
      OPS_CUSTODY_FREEZE_POLICY: blankAsAbsent(z.string().optional()),
    }),
  );

export type OpsEnv = z.infer<typeof schema>;
export const env: OpsEnv = loadEnv(schema);
