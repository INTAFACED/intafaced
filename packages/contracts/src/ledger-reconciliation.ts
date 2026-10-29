/**
 * Operator reconciliation controls (OPS-reconciliation-01).
 *
 * svc-ledger owns the rows. An outside balance is a snapshot of this shape,
 * read through this contract, never through another service's tables. No
 * snapshot is `unset` — not null and not zero.
 */

import { z } from 'zod';

export const OPS_CONTROL_POLICY_UNSET = 'ops.control_policy_unset' as const;
export const OPS_CONTROL_MARGIN_UNSET = 'ops.control_margin_unset' as const;
export const OPS_CONTROL_STATE_ILLEGAL = 'ops.control_state_illegal' as const;
export const OPS_CONTROL_ACTOR_UNSET = 'ops.control_actor_unset' as const;
export const OPS_CONTROL_REASON_REQUIRED = 'ops.control_reason_required' as const;
export const LEDGER_RECONCILE_ASOF_INVALID = 'ledger.reconcile_asof_invalid' as const;
export const LEDGER_RECONCILE_SOURCE_UNAVAILABLE = 'ledger.reconcile_source_unavailable' as const;
export const LEDGER_RECONCILE_BUILTIN_IMMUTABLE = 'ledger.reconcile_builtin_immutable' as const;
export const LEDGER_RECONCILE_CONTROL_NOT_FOUND = 'ledger.reconcile_control_not_found' as const;
/** A control names a rail whose outside statement URL is blank: the outside side is unset, never zero. */
export const LEDGER_RECONCILE_RAIL_SOURCE_UNSET = 'ledger.reconcile_rail_source_unset' as const;

/** A rail id as the ledger's boundary accounts carry it (`rail:<id>`), and as its statement env name is derived from. */
export const reconciliationRailSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const RECONCILIATION_TEMPLATES = ['ledger_invariant', 'outside_balance', 'threshold', 'source_parity'] as const;
export const RECONCILIATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const RECONCILIATION_PERIODS = ['hour', 'day', 'iso_week', 'month'] as const;
export const RECONCILIATION_CHECK_KINDS = ['replay', 'chain', 'netting', 'replay_and_netting'] as const;
/** OPS-reconciliation-02. Paused runs nothing until resumed; retired is final and keeps its history. */
export const RECONCILIATION_STATES = ['draft', 'active', 'paused', 'retired'] as const;
export const RECONCILIATION_LIFECYCLE = ['pause', 'resume', 'retire'] as const;
export type ReconciliationLifecycle = (typeof RECONCILIATION_LIFECYCLE)[number];
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];
/** The one transition table: the states each move leaves from, and the state it lands in. Anything else is illegal. */
export const RECONCILIATION_LIFECYCLE_MOVES: Readonly<
  Record<ReconciliationLifecycle, { readonly from: readonly ReconciliationState[]; readonly to: ReconciliationState }>
> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  retire: { from: ['draft', 'active', 'paused'], to: 'retired' },
};

/** Decimal string. No exponent. Zero is `0`, never a blank. */
export const reconciliationDecimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,18})?$/);
export const reconciliationSignedDecimalSchema = z.string().regex(/^-?(0|[1-9]\d*)(\.\d{1,18})?$/);

const assetIdSchema = z.string().regex(/^[A-Za-z0-9]{2,16}$/);

export const reconciliationScheduleSchema = z.discriminatedUnion('cadence', [
  z.object({ cadence: z.literal('hourly'), minute: z.number().int().min(0).max(59) }).strict(),
  z
    .object({
      cadence: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z
    .object({
      cadence: z.literal('weekly'),
      isoWeekday: z.number().int().min(1).max(7),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z
    .object({
      cadence: z.literal('monthly'),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
]);
export type ReconciliationSchedule = z.infer<typeof reconciliationScheduleSchema>;

export const reconciliationToleranceSchema = z
  .object({
    default: reconciliationDecimalSchema.optional(),
    byAsset: z.record(assetIdSchema, reconciliationDecimalSchema).optional(),
  })
  .strict();
export type ReconciliationTolerance = z.infer<typeof reconciliationToleranceSchema>;

export const reconciliationThresholdSchema = z
  .object({
    bound: z.enum(['min', 'max']),
    byAsset: z.record(assetIdSchema, reconciliationDecimalSchema),
  })
  .strict()
  .refine((value) => Object.keys(value.byAsset).length > 0, { message: OPS_CONTROL_POLICY_UNSET });
export type ReconciliationThreshold = z.infer<typeof reconciliationThresholdSchema>;

const ownerTypeSchema = z.enum(['user', 'subaccount', 'module', 'house', 'treasury']);
const accountKindSchema = z.enum(['available', 'hold', 'escrow', 'stake', 'collateral']);

const explicitAccountSetSchema = z
  .object({
    mode: z.literal('explicit'),
    accountIds: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();

const queryAccountSetSchema = z
  .object({
    mode: z.literal('query'),
    ownerType: ownerTypeSchema.optional(),
    ownerIdPrefix: z.string().trim().min(1).max(128).optional(),
    /** One rail's boundary: treasury accounts whose owner id is exactly `rail:<rail>`. Excludes ownerType and ownerIdPrefix. */
    rail: reconciliationRailSchema.optional(),
    kind: accountKindSchema.optional(),
    purpose: z.string().max(128).optional(),
    assetId: assetIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.rail !== undefined && (value.ownerType !== undefined || value.ownerIdPrefix !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_CONTROL_POLICY_UNSET, path: ['rail'] });
    }
    const predicated =
      value.rail !== undefined ||
      value.ownerType !== undefined ||
      value.ownerIdPrefix !== undefined ||
      value.kind !== undefined ||
      value.purpose !== undefined ||
      value.assetId !== undefined;
    if (!predicated) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_CONTROL_POLICY_UNSET });
    }
  });

export const operatorAccountSetSchema = z.union([explicitAccountSetSchema, queryAccountSetSchema]);
export type OperatorAccountSet = z.infer<typeof operatorAccountSetSchema>;

/** Built-in controls cover the whole book. Operators cannot choose this mode. */
export const reconciliationAccountSetSchema = z.union([operatorAccountSetSchema, z.object({ mode: z.literal('all') }).strict()]);
export type ReconciliationAccountSet = z.infer<typeof reconciliationAccountSetSchema>;

const reasonSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(12).max(500));

export const defineReconciliationControlInputSchema = z
  .object({
    template: z.enum(RECONCILIATION_TEMPLATES),
    explanation: z.string().max(2000).optional(),
    labels: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
    schedule: reconciliationScheduleSchema.optional(),
    severity: z.enum(RECONCILIATION_SEVERITIES).optional(),
    tolerance: reconciliationToleranceSchema.optional(),
    margin: reconciliationDecimalSchema.optional(),
    accountSet: operatorAccountSetSchema,
    threshold: reconciliationThresholdSchema.optional(),
    reason: reasonSchema,
    activate: z.boolean().optional(),
  })
  .strict();
export type DefineReconciliationControlInput = z.infer<typeof defineReconciliationControlInputSchema>;

export const updateReconciliationControlInputSchema = z
  .object({
    controlId: z.string().uuid(),
    explanation: z.string().max(2000).optional(),
    labels: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
    schedule: reconciliationScheduleSchema.optional(),
    severity: z.enum(RECONCILIATION_SEVERITIES).optional(),
    tolerance: reconciliationToleranceSchema.optional(),
    margin: reconciliationDecimalSchema.optional(),
    accountSet: operatorAccountSetSchema.optional(),
    threshold: reconciliationThresholdSchema.optional(),
    reason: reasonSchema,
    activate: z.boolean().optional(),
    /**
     * A lifecycle move travels alone: with it, only the control id, the reason and the two-founder approval it consumes.
     * The approval ids ride only with a lifecycle move, and a lifecycle move always carries them.
     */
    lifecycle: z.enum(RECONCILIATION_LIFECYCLE).optional(),
    approvalId: z.string().min(1).max(128).optional(),
    operationId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const present = Object.keys(value).filter((key) => value[key as keyof typeof value] !== undefined);
    if (value.lifecycle === undefined) {
      const stray = present.filter((key) => key === 'approvalId' || key === 'operationId');
      if (stray.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_CONTROL_STATE_ILLEGAL, path: stray });
      return;
    }
    const allowed = ['controlId', 'reason', 'lifecycle', 'approvalId', 'operationId'];
    const extra = present.filter((key) => !allowed.includes(key));
    if (extra.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: OPS_CONTROL_STATE_ILLEGAL, path: extra });
    for (const key of ['approvalId', 'operationId'] as const) {
      if (value[key] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'action_approval.missing', path: [key] });
    }
  });
export type UpdateReconciliationControlInput = z.infer<typeof updateReconciliationControlInputSchema>;

export const runReconciliationControlInputSchema = z
  .object({
    controlId: z.string().uuid(),
    asOf: z.string().datetime({ offset: true }).optional(),
    margin: reconciliationDecimalSchema.optional(),
    reason: reasonSchema,
    approvalId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
  })
  .strict();
export type RunReconciliationControlInput = z.infer<typeof runReconciliationControlInputSchema>;

const unsetSchema = z.object({ status: z.literal('unset') }).strict();

export const reconciliationControlViewSchema = z
  .object({
    id: z.string().uuid(),
    builtin: z.boolean(),
    template: z.enum(RECONCILIATION_TEMPLATES),
    checkKind: z.union([unsetSchema, z.object({ status: z.literal('set'), value: z.enum(RECONCILIATION_CHECK_KINDS) }).strict()]),
    state: z.enum(RECONCILIATION_STATES),
    explanation: z.string(),
    labels: z.array(z.string()),
    schedule: z.union([
      unsetSchema,
      z
        .object({
          status: z.literal('set'),
          value: reconciliationScheduleSchema,
          period: z.enum(RECONCILIATION_PERIODS),
        })
        .strict(),
    ]),
    severity: z.union([unsetSchema, z.object({ status: z.literal('set'), value: z.enum(RECONCILIATION_SEVERITIES) }).strict()]),
    tolerance: z.union([
      unsetSchema,
      z
        .object({
          status: z.literal('set'),
          default: reconciliationDecimalSchema,
          byAsset: z.record(assetIdSchema, reconciliationDecimalSchema),
        })
        .strict(),
    ]),
    margin: z.union([unsetSchema, z.object({ status: z.literal('set'), value: reconciliationDecimalSchema }).strict()]),
    accountSet: reconciliationAccountSetSchema,
    threshold: z.union([
      unsetSchema,
      z
        .object({
          status: z.literal('set'),
          bound: z.enum(['min', 'max']),
          byAsset: z.record(assetIdSchema, reconciliationDecimalSchema),
        })
        .strict(),
    ]),
    version: z.number().int().positive(),
  })
  .strict();
export type ReconciliationControlView = z.infer<typeof reconciliationControlViewSchema>;

export const reconciliationControlListSchema = z.object({ controls: z.array(reconciliationControlViewSchema) }).strict();

const sourceAsOfSchema = z.union([
  z.object({ asOf: z.string().datetime({ offset: true }) }).strict(),
  z.object({ asOf: z.literal('unset') }).strict(),
]);

export const reconciliationAssetEvidenceSchema = z
  .object({
    assetId: assetIdSchema,
    observed: reconciliationSignedDecimalSchema,
    expected: z.union([reconciliationSignedDecimalSchema, z.literal('unset')]),
    difference: z.union([reconciliationSignedDecimalSchema, z.literal('unset')]),
    tolerance: z.union([reconciliationDecimalSchema, z.literal('unset')]),
  })
  .strict();

export const reconciliationControlRunSchema = z
  .object({
    id: z.string().uuid(),
    controlId: z.string().uuid(),
    status: z.enum(['started', 'PASS', 'FAIL', 'ERROR', 'UNSET']),
    phase: z.union([unsetSchema, z.object({ status: z.literal('set'), value: z.string().min(1) }).strict()]),
    errorCode: z.union([unsetSchema, z.object({ status: z.literal('set'), value: z.string().min(1) }).strict()]),
    asOf: z.string().datetime({ offset: true }),
    readAt: z.string().datetime({ offset: true }),
    margin: z.union([unsetSchema, z.object({ status: z.literal('set'), value: reconciliationDecimalSchema }).strict()]),
    sources: z
      .object({
        ledger: z.object({ asOf: z.string().datetime({ offset: true }) }).strict(),
        outside: sourceAsOfSchema,
        parity: sourceAsOfSchema,
      })
      .strict(),
    outsideSide: z.enum(['unset', 'snapshot', 'unavailable', 'not_applicable']),
    periodStart: z.string().datetime({ offset: true }),
    periodEnd: z.string().datetime({ offset: true }),
    accounts: z.array(z.string().uuid()),
    assets: z.array(reconciliationAssetEvidenceSchema),
  })
  .strict();
export type ReconciliationControlRunView = z.infer<typeof reconciliationControlRunSchema>;

/** OPS-reconciliation-02: a control's evaluations, newest first. A paused or retired control keeps every one readable. */
export const RECONCILIATION_RUN_LIST_MAX = 500;
/** How many runs a list returns when it names no limit. */
export const RECONCILIATION_RUN_LIST_DEFAULT = 100;
export const listReconciliationControlRunsInputSchema = z
  .object({
    controlId: z.string().uuid(),
    limit: z.number().int().min(1).max(RECONCILIATION_RUN_LIST_MAX).optional(),
  })
  .strict();
export type ListReconciliationControlRunsInput = z.infer<typeof listReconciliationControlRunsInputSchema>;
export const reconciliationControlRunListSchema = z
  .object({
    controlId: z.string().uuid(),
    /** Every evaluation the control has; `runs` holds the newest `limit` of them, by when each run started. */
    total: z.number().int().nonnegative(),
    runs: z.array(reconciliationControlRunSchema),
  })
  .strict();
export type ReconciliationControlRunList = z.infer<typeof reconciliationControlRunListSchema>;

/** What a rail snapshot must look like when a partner has one. Amounts are decimal strings. */
export const railBalanceSnapshotSchema = z
  .object({
    source: z.literal('rail'),
    asOf: z.string().datetime({ offset: true }),
    balances: z.array(
      z
        .object({
          assetId: assetIdSchema,
          amount: reconciliationSignedDecimalSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type RailBalanceSnapshot = z.infer<typeof railBalanceSnapshotSchema>;

/**
 * One rail's outside statement (OPS-reconciliation-04 per-rail controls): a rail snapshot that names its rail. Amounts are in
 * the ledger's signed form for that rail's boundary account (`rail:<rail>`), never flipped by the reader.
 */
export const railStatementSchema = z
  .object({
    source: z.literal('rail'),
    rail: reconciliationRailSchema,
    asOf: z.string().datetime({ offset: true }),
    balances: z.array(
      z
        .object({
          assetId: assetIdSchema,
          amount: reconciliationSignedDecimalSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type RailStatement = z.infer<typeof railStatementSchema>;
