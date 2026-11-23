import { z } from 'zod';
import { OPS_ALERT_STATES, OPS_ALERT_HEALTH, opsAlertRuleSchema } from './ops-alert-rules.js';
// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-ops's records share, moved from the service so the records and every caller read one copy. */

export const OPS_RESTORE_ARCHIVE_UNCONFIGURED = 'ops.restore_archive_unconfigured' as const;

export const OPS_RESTORE_ARCHIVE_UNPROBED = 'ops.restore_archive_unprobed' as const;

export const OPS_RESTORE_STORAGE_UNCONFIGURED = 'ops.restore_storage_unconfigured' as const;

export const cursorSchema = z.string().min(1).max(600);

export const rule = opsAlertRuleSchema;

export const stateSchema = z.object({
  instance: z.string(),
  state: z.enum(OPS_ALERT_STATES),
  health: z.enum(OPS_ALERT_HEALTH),
  epoch: z.number().int(),
  pendingSince: z.string().nullable(),
  firingSince: z.string().nullable(),
  lastEvaluatedAt: z.string(),
  lastValue: z.string().nullable(),
  lastCode: z.string().nullable(),
  /** The rule says keep last and the latest check was unhealthy: the state is the earlier one. */
  kept: z.boolean(),
});
