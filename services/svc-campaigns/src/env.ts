import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, loadEnv, otelEnvSchema, postgresEnvSchema } from '@intafaced/config';

/**
 * svc-campaigns: seasons, limited drops and the TGE claim. Its rows live in its own `campaigns` schema and move no
 * money. HTTP_PORT 4024: 4000-4023 are taken by the existing fleet.
 *
 * CAMPAIGNS_TGE_SCHEDULE_JSON is the owner's token generation event schedule, `{"claimOpensAt":"<ISO time>"}`. Blank is
 * allowed at boot: every TGE claim refuses `launch.schedule_unset`. Never a default date.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(edgeEnvSchema)
  .merge(postgresEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-campaigns'),
      HTTP_PORT: z.coerce.number().int().positive().default(4024),
      CAMPAIGNS_TGE_SCHEDULE_JSON: blankAsAbsent(z.string().optional()),
    }),
  );

export type CampaignsEnv = z.infer<typeof schema>;
export const env: CampaignsEnv = loadEnv(schema);
