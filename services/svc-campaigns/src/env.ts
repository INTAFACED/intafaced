import { z } from 'zod';
import {
  baseEnvSchema,
  edgeEnvSchema,
  httpEnvSchema,
  loadEnv,
  natsEnvSchema,
  otelEnvSchema,
  postgresEnvSchema,
  s2sEnvSchema,
} from '@intafaced/config';

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
 * CAMPAIGNS_RULE_DEPTH_LIMIT and CAMPAIGNS_RULE_SIZE_LIMIT are the owner's limits on a rule tree (CM-eligibility-rules-02): the
 * deepest nesting of AND and OR groups, and the most groups and conditions in one tree. NO DEFAULT: blank boots, and every
 * rule try, library save and campaign rule refuses `campaigns.rule_depth_unset` or `campaigns.rule_size_unset`.
 *
 * IDENTITY_URL and INTERNAL_SERVICE_SECRET reach svc-identity's participant read. Without them a campaign with
 * exclusions or a region list cannot check anyone: its page reads `unread` and a join refuses
 * `campaigns.participant_unread`, and the service logs a warning at boot. A campaign open to every signed-in account
 * needs neither. With S2S_AUTH_MODE dual or keypair the read is signed with svc-campaigns' own key.
 *
 * LEDGER_URL reaches svc-ledger for the reward saga (`rewardPay`, `sweepFeesToRewards`, and reading back its own keys).
 * Unset: every claim and every pot funding approval refuses `campaigns.reward_saga_unwired` and writes nothing.
 *
 * TRADE_URL reaches svc-trade's public market list, to name the market a fill's id points at. Unset: a step that names
 * a market counts no fill (logged); a step for any market still counts.
 *
 * NATS_URL is the bus task progress is read from (`trade.fill.settled`). Unreachable at boot: the service runs, logs and
 * tries again every 15 seconds; JetStream keeps the events for the durable consumer once it attaches.
 *
 * CAMPAIGNS_RECONCILE_AFTER_SECONDS (owner value) is how long after an attempt the reconciler posts an open reward or
 * funding again under the same key. Blank: no reconciler runs, open intents wait, and /ready says
 * `campaigns.reconcile_unset`. CAMPAIGNS_ROLLBACK_WINDOW_SECONDS (owner value) is the rollback window every reward record
 * shows; blank reads "not set". A value-moving rollback needs a reversing recipe that does not exist, so none is offered.
 *
 * CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ACCOUNT, CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ADDRESS and CAMPAIGNS_VOUCHER_ATTEMPT_WINDOW_SECONDS
 * (owner values, CM-eligibility-rules-04): how many voucher code checks and claims one account, and one source address,
 * may make in the window. Any blank: every check and claim refuses `campaigns.attempt_limit_unset`. NO DEFAULT.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(edgeEnvSchema)
  .merge(postgresEnvSchema)
  .merge(natsEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-campaigns'),
      HTTP_PORT: z.coerce.number().int().positive().default(4024),
      CAMPAIGNS_TGE_SCHEDULE_JSON: blankAsAbsent(z.string().optional()),
      CAMPAIGNS_PLATFORM_TIME_ZONE: blankAsAbsent(z.string().optional()),
      CAMPAIGNS_RULE_DEPTH_LIMIT: blankAsAbsent(z.string().optional()),
      CAMPAIGNS_RULE_SIZE_LIMIT: blankAsAbsent(z.string().optional()),
      /** svc-identity, for the participant read (exclusions, region). Read only. Unset: every rule check reads unread. */
      IDENTITY_URL: blankAsAbsent(z.string().url().optional()),
      INTERNAL_SERVICE_SECRET: blankAsAbsent(z.string().min(32).optional()),
      LEDGER_URL: blankAsAbsent(z.string().url().optional()),
      TRADE_URL: blankAsAbsent(z.string().url().optional()),
      CAMPAIGNS_RECONCILE_AFTER_SECONDS: blankAsAbsent(z.coerce.number().int().min(1).max(86_400).optional()),
      CAMPAIGNS_ROLLBACK_WINDOW_SECONDS: blankAsAbsent(z.coerce.number().int().min(1).max(31_536_000).optional()),
      CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ACCOUNT: blankAsAbsent(z.coerce.number().int().min(1).max(1_000_000).optional()),
      CAMPAIGNS_VOUCHER_ATTEMPTS_PER_ADDRESS: blankAsAbsent(z.coerce.number().int().min(1).max(1_000_000).optional()),
      CAMPAIGNS_VOUCHER_ATTEMPT_WINDOW_SECONDS: blankAsAbsent(z.coerce.number().int().min(1).max(31_536_000).optional()),
    }),
  );

export type CampaignsEnv = z.infer<typeof schema>;
export const env: CampaignsEnv = loadEnv(schema);
