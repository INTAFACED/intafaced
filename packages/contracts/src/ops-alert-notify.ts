/**
 * OPS-alerts-02 wire shapes. Blank owner values stay optional so svc-ops can
 * refuse them by name. Nothing here chooses a contact, a wait or a secret.
 */
import { z } from 'zod';

export const OPS_ALERT_DEFAULT_CONTACT_UNSET = 'ops.alert_default_contact_unset' as const;
export const OPS_CONTACT_POINT_IN_USE = 'ops.contact_point_in_use' as const;
export const OPS_CHANNEL_AUTH_CONFLICT = 'ops.channel_auth_conflict' as const;
export const OPS_GROUP_TIMING_UNSET = 'ops.group_timing_unset' as const;
export const OPS_FLAP_SUPPRESSION_UNSET = 'ops.flap_suppression_unset' as const;
export const OPS_MUTE_TIMING_UNSET = 'ops.mute_timing_unset' as const;
export const OPS_ACTIVE_TIME_UNSET = 'ops.active_time_unset' as const;
export const OPS_MATCHER_INVALID = 'ops.matcher_invalid' as const;
export const OPS_SILENCE_END_UNSET = 'ops.silence_end_unset' as const;
export const OPS_ALERT_CHANNEL_KEY_UNSET = 'ops.alert_channel_key_unset' as const;
export const OPS_CONTACT_POINT_NOT_FOUND = 'ops.contact_point_not_found' as const;
export const OPS_ALERT_ROUTE_VERSION_STALE = 'ops.alert_route_version_stale' as const;
export const OPS_CONTACT_VERSION_STALE = 'ops.contact_version_stale' as const;
export const OPS_SILENCE_NOT_FOUND = 'ops.silence_not_found' as const;
export const OPS_CHANNEL_TARGET_UNSET = 'ops.channel_target_unset' as const;
export const OPS_CHANNEL_SECRET_UNSET = 'ops.channel_secret_unset' as const;
export const OPS_CHANNEL_DELIVERY_FAILED = 'ops.channel_delivery_failed' as const;
export const OPS_ALERT_ROUTE_UNSET = 'ops.alert_route_unset' as const;
export const OPS_ALERT_ROUTE_INVALID = 'ops.alert_route_invalid' as const;
export const OPS_SILENCE_ID_TAKEN = 'ops.silence_id_taken' as const;

export const OPS_ALERT_NOTIFY_REFUSAL_CODES = [
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_CONTACT_POINT_IN_USE,
  OPS_CHANNEL_AUTH_CONFLICT,
  OPS_GROUP_TIMING_UNSET,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_MUTE_TIMING_UNSET,
  OPS_ACTIVE_TIME_UNSET,
  OPS_MATCHER_INVALID,
  OPS_SILENCE_END_UNSET,
  OPS_ALERT_CHANNEL_KEY_UNSET,
  OPS_CONTACT_POINT_NOT_FOUND,
  OPS_ALERT_ROUTE_VERSION_STALE,
  OPS_CONTACT_VERSION_STALE,
  OPS_SILENCE_NOT_FOUND,
  OPS_CHANNEL_TARGET_UNSET,
  OPS_CHANNEL_SECRET_UNSET,
  OPS_CHANNEL_DELIVERY_FAILED,
  OPS_ALERT_ROUTE_UNSET,
  OPS_ALERT_ROUTE_INVALID,
  OPS_SILENCE_ID_TAKEN,
] as const;

export const opsAlertMatcherSchema = z.object({
  label: z.string(),
  op: z.enum(['eq', 'neq', 'match', 'nmatch']),
  value: z.string(),
});
export type OpsAlertMatcher = z.infer<typeof opsAlertMatcherSchema>;

export const opsAlertTimingSchema = z.object({
  groupBy: z.array(z.string()).nullable(),
  groupWaitSeconds: z.number().int().nullable(),
  groupIntervalSeconds: z.number().int().nullable(),
  repeatSeconds: z.number().int().nullable(),
  flapSeconds: z.number().int().nullable(),
});

/** Days of the month, months, years, a clock range and a time zone. Every part is the owner's. */
export const opsAlertNoticeWindowSchema = z.object({
  days: z.array(z.number().int()),
  months: z.array(z.number().int()),
  years: z.array(z.number().int()),
  start: z.string(),
  end: z.string(),
  location: z.string(),
});
export type OpsAlertNoticeWindow = z.infer<typeof opsAlertNoticeWindowSchema>;

const opsAlertNoticeWindowInputSchema = z
  .object({
    days: z.array(z.number().int()).optional(),
    months: z.array(z.number().int()).optional(),
    years: z.array(z.number().int()).optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    location: z.string().optional(),
  })
  .nullable();

export type OpsAlertPolicyNode = {
  id: string;
  matchers: OpsAlertMatcher[];
  contactId: string | null;
  continue: boolean;
  timing: z.infer<typeof opsAlertTimingSchema> | null;
  children: OpsAlertPolicyNode[];
};

export const opsAlertPolicyNodeSchema: z.ZodType<OpsAlertPolicyNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    matchers: z.array(opsAlertMatcherSchema),
    contactId: z.string().nullable(),
    continue: z.boolean(),
    timing: opsAlertTimingSchema.nullable(),
    children: z.array(opsAlertPolicyNodeSchema),
  }),
);

export const opsAlertRouteTreeSchema = z.object({
  version: z.number().int().min(1),
  defaultContactId: z.string().min(1),
  timing: opsAlertTimingSchema,
  mute: opsAlertNoticeWindowSchema.nullable(),
  active: opsAlertNoticeWindowSchema.nullable(),
  policies: z.array(opsAlertPolicyNodeSchema),
  actor: z.string().min(1),
  reason: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OpsAlertRouteTree = z.infer<typeof opsAlertRouteTreeSchema>;

/** Input leaves every owner value optional. svc-ops refuses a blank; this schema does not fill one. */
export const opsAlertPolicyInputSchema: z.ZodType<OpsAlertPolicyInput> = z.lazy(() =>
  z.object({
    id: z.string().optional(),
    matchers: z.array(opsAlertMatcherSchema).optional(),
    contactId: z.string().nullable().optional(),
    continue: z.boolean().optional(),
    inheritTiming: z.boolean().optional(),
    groupBy: z.array(z.string()).nullable().optional(),
    groupWaitSeconds: z.number().int().nullable().optional(),
    groupIntervalSeconds: z.number().int().nullable().optional(),
    repeatSeconds: z.number().int().nullable().optional(),
    flapSeconds: z.number().int().nullable().optional(),
    children: z.array(opsAlertPolicyInputSchema).optional(),
  }),
);

export interface OpsAlertPolicyInput {
  readonly id?: string;
  readonly matchers?: readonly OpsAlertMatcher[];
  readonly contactId?: string | null;
  readonly continue?: boolean;
  readonly inheritTiming?: boolean;
  readonly groupBy?: readonly string[] | null;
  readonly groupWaitSeconds?: number | null;
  readonly groupIntervalSeconds?: number | null;
  readonly repeatSeconds?: number | null;
  readonly flapSeconds?: number | null;
  readonly children?: readonly OpsAlertPolicyInput[];
}

export const opsAlertRouteSaveSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: z.string(),
  reason: z.string(),
  defaultContactId: z.string().optional(),
  groupBy: z.array(z.string()).nullable().optional(),
  groupWaitSeconds: z.number().int().nullable().optional(),
  groupIntervalSeconds: z.number().int().nullable().optional(),
  repeatSeconds: z.number().int().nullable().optional(),
  flapSeconds: z.number().int().nullable().optional(),
  mute: opsAlertNoticeWindowInputSchema.optional(),
  active: opsAlertNoticeWindowInputSchema.optional(),
  policies: z.array(opsAlertPolicyInputSchema).optional(),
});

export const opsAlertIntegrationInputSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['email', 'sms', 'push', 'webhook', 'chat', 'paging']).optional(),
  address: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  secret: z.string().nullable().optional(),
  basicUser: z.string().nullable().optional(),
  basicPassword: z.string().nullable().optional(),
  bearer: z.string().nullable().optional(),
});

export const opsAlertContactSaveSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  expectedVersion: z.number().int().min(1).optional(),
  idempotencyKey: z.string(),
  reason: z.string(),
  integrations: z.array(opsAlertIntegrationInputSchema).optional(),
});

const masked = z.enum(['********']).nullable();

export const opsAlertIntegrationSchema = z.object({
  id: z.string(),
  kind: z.enum(['email', 'sms', 'push', 'webhook', 'chat', 'paging']),
  address: z.string().nullable(),
  url: z.string().nullable(),
  secret: masked,
  basicUser: z.string().nullable(),
  basicPassword: masked,
  bearer: masked,
});

export const opsAlertContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  retiredAt: z.string().nullable(),
  integrations: z.array(opsAlertIntegrationSchema),
  actor: z.string(),
  reason: z.string(),
  updatedAt: z.string(),
});
export type OpsAlertContact = z.infer<typeof opsAlertContactSchema>;

export const opsAlertSilenceSchema = z.object({
  id: z.string(),
  matchers: z.array(opsAlertMatcherSchema),
  endsAt: z.string(),
  actor: z.string(),
  reason: z.string(),
  createdAt: z.string(),
});
export type OpsAlertSilence = z.infer<typeof opsAlertSilenceSchema>;

export const opsAlertResolveSchema = z.object({
  contacts: z.array(z.string()),
  policyIds: z.array(z.string()),
});

export const VENDOR_EMAIL = 'vendor.email' as const;
export const VENDOR_SMS = 'vendor.sms' as const;
export const VENDOR_PUSH = 'vendor.push' as const;
