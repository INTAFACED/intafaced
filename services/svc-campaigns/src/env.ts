import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, loadEnv, otelEnvSchema, postgresEnvSchema } from '@intafaced/config';

/**
 * svc-campaigns: seasons, limited drops and the TGE claim. Its rows live in its own `campaigns` schema and move no
 * money. HTTP_PORT 4024: 4000-4023 are taken by the existing fleet.
 *
 * CAMPAIGNS_TGE_SCHEDULE_JSON is the owner's token generation event schedule, `{"claimOpensAt":"<ISO time>"}`. Blank is
 * allowed at boot: every TGE claim refuses `launch.schedule_unset`. Never a default date.
 *
 * CAMPAIGNS_PLATFORM_TIME_ZONE is the owner's platform time zone, an IANA name such as `UTC`. Campaign time frames,
 * weekday and hour windows and the calendar are read in it. NO DEFAULT: blank boots, and every campaign activation and
 * every join refuses `campaigns.timezone_unset`; a name the runtime does not know refuses at boot.
 *
 * IDENTITY_URL and INTERNAL_SERVICE_SECRET reach svc-identity's participant read. Without them a campaign with
 * exclusions or a region list cannot check anyone: its page reads `unread` and a join refuses
 * `campaigns.participant_unread`. A campaign open to every signed-in account needs neither.
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
      CAMPAIGNS_PLATFORM_TIME_ZONE: blankAsAbsent(z.string().optional()),
      /** svc-identity, for the participant read (exclusions, region). Read only. Unset: every rule check reads unread. */
      IDENTITY_URL: blankAsAbsent(z.string().url().optional()),
      INTERNAL_SERVICE_SECRET: blankAsAbsent(z.string().min(32).optional()),
    }),
  );

export type CampaignsEnv = z.infer<typeof schema>;
export const env: CampaignsEnv = loadEnv(schema);
