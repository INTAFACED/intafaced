import { z } from 'zod';
import { PROTOCOL_OPS_REASON_CODE_PATTERN } from '@intafaced/contracts';
import {
  baseEnvSchema,
  edgeEnvSchema,
  httpEnvSchema,
  internalServiceEnvSchema,
  loadEnv,
  otelEnvSchema,
  s2sEnvSchema,
} from '@intafaced/config';

/**
 * svc-ops — durable outreach CRM / team / revenue / projects. No payroll, no
 * second money book. HTTP_PORT 4022: 4020 is tax; 4021 is reserved.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

export const opsEnvSchema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-ops'),
      HTTP_PORT: z.coerce.number().int().positive().default(4022),
      /** Outreach authority client URL. Legacy warehouse/team sources remain absent. */
      IDENTITY_URL: blankAsAbsent(z.string().url().optional()),
      /** Env URL only. This process does not fetch; /ready names hardcoded-absent. */
      SUPPORT_URL: blankAsAbsent(z.string().url().optional()),
      /** svc-ledger base URL for the fee revenue read. Blank → the venue report says ops.fee_revenue_unconfigured and gives no net. */
      LEDGER_URL: blankAsAbsent(z.string().url().optional()),
      NOTIFY_URL: blankAsAbsent(z.string().url().optional()),
      /** Dedicated ops-to-guest ingress key; match NOTIFY_OPS_SERVICE_SECRET. */
      OPS_NOTIFY_SERVICE_SECRET: blankAsAbsent(z.string().min(32).optional()),
      /** Blank → custody wrap/execute refuse ops.custody_wrap_unset. Never invent a wrap key. */
      OPS_ERASURE_ARCHIVE_URL: blankAsAbsent(z.string().url().optional()),
      OPS_ERASURE_ARCHIVE_SECRET: blankAsAbsent(z.string().min(32).optional()),
      OPS_CUSTODY_WRAP: blankAsAbsent(z.string().optional()),
      /**
       * Owner freeze policy. Blank / unknown → execute and createApproval refuse
       * ops.custody_freeze_unset. `frozen` → ops.custody_frozen. `open` passes
       * the freeze gate only. Never invents thresholds or a send.
       */
      OPS_CUSTODY_FREEZE_POLICY: blankAsAbsent(z.string().optional()),
      /**
       * Joint-restore archive. Blank → restore.record refuses
       * ops.restore_archive_unconfigured, and restore.backups lists nothing.
       * A set URL is probed; a failed read stays ops.restore_archive_unprobed.
       */
      OPS_RESTORE_ARCHIVE_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * Owner storage target for restored data. Blank → restore.start and restore.finalize refuse
       * ops.restore_target_unset. Never invented.
       */
      OPS_RESTORE_TARGET: blankAsAbsent(z.string().min(1).max(256).optional()),
      /**
       * Owner setting: the `ops:hold-confirm:<slug>` account a confirmed staff hold moves to (lowercase letters, digits and
       * dashes). Blank → a confirm refuses `owner.decision` before any approval is spent, and nothing posts.
       */
      OPS_STAFF_HOLD_CONFIRM_ACCOUNT: blankAsAbsent(
        z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,62}$/, 'OPS_STAFF_HOLD_CONFIRM_ACCOUNT must be a lowercase slug (a-z, 0-9, -).')
          .optional(),
      ),
      /**
       * Owner setting: the longest expiry a staff hold may be given, in hours. Blank → no expiry is offered
       * (`ops.hold_expiry_unset`, the desk says "not set"); holds without an expiry still work. Never invented.
       */
      OPS_STAFF_HOLD_EXPIRY_MAX_HOURS: blankAsAbsent(z.coerce.number().int().positive().max(8760).optional()),
      /**
       * Home's owner values (`home.config`, read by `homeConfigFromEnv`): the work list's cap (1-50) and order of kinds
       * (comma separated, each once), and the header search's help result cap (1-20). Blank stays blank; never invented.
       */
      OPS_HOME_WORK_LIST_CAP: blankAsAbsent(z.string().optional()),
      OPS_HOME_WORK_LIST_ORDER: blankAsAbsent(z.string().optional()),
      OPS_HOME_SEARCH_RESULT_CAP: blankAsAbsent(z.string().optional()),
      /** svc-bank and svc-pay base URLs for the joint-restore watermark reads. Blank → that service reads as unavailable. */
      BANK_URL: blankAsAbsent(z.string().url().optional()),
      PAY_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * How often a still-failing reconciliation alert may notify again, in seconds (OPS-reconciliation-03).
       * Blank → nothing is re-sent and each repeat names ops.alert_repeat_unset; the alert still counts. Never invented.
       */
      OPS_RECON_ALERT_REPEAT_SECONDS: blankAsAbsent(z.coerce.number().int().positive().optional()),
      /**
       * How long a recorded heartbeat may age before it is overdue, in seconds.
       * Blank → heartbeatStatus reports ops.heartbeat_window_unset and overdue stays null. Never invented.
       */
      OPS_ALERT_HEARTBEAT_MAX_AGE_SECONDS: blankAsAbsent(z.coerce.number().int().positive().optional()),
      /**
       * Optional deployment reason codes for hiding a pool or delisting a market, comma separated, lower snake case.
       * Blank → the built-in default list applies; an admin edit overrides both. A misspelt code refuses at boot.
       */
      OPS_PROTOCOL_REASON_CODES: blankAsAbsent(
        z
          .string()
          .optional()
          .refine(
            (value) =>
              value === undefined ||
              value
                .split(',')
                .map((code) => code.trim())
                .filter(Boolean)
                .every((code) => PROTOCOL_OPS_REASON_CODE_PATTERN.test(code)),
            'OPS_PROTOCOL_REASON_CODES must be comma separated lower snake case codes (a-z, 0-9, _).',
          ),
      ),
    }),
  );

export type OpsEnv = z.infer<typeof opsEnvSchema>;
export const env: OpsEnv = loadEnv(opsEnvSchema);
