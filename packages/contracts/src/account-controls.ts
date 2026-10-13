import { z } from 'zod';
import type { Principal } from '@intafaced/auth';
import type { Context } from './trpc.js';
import { accountStateSchema, apiKeyOwnershipSchema, sessionOwnershipSchema, subAccountOwnershipSchema } from './identity.js';

/** Wire records only. Parsing a command, snapshot or receipt never grants authority. */
const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const businessId = z.string().trim().min(1).max(128);
const reason = z.string().trim().min(3).max(500);
const version = z
  .string()
  .max(40)
  .regex(/^(?:0|[1-9]\d*)$/);
const payloadHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const accountControlTargetSchema = z.discriminatedUnion('area', [
  z.object({ area: z.literal('identity'), userId: id }).strict(),
  z.object({ area: z.literal('trading'), userId: id }).strict(),
  z.object({ area: z.literal('merchant'), merchantId: id }).strict(),
]);
export type AccountControlTarget = z.infer<typeof accountControlTargetSchema>;

/** Actor and founder entitlement are resolved from authentication, never this body. */
export const accountControlInputSchema = z
  .object({
    requestId: id,
    target: accountControlTargetSchema,
    action: z.enum(['restrict', 'restore']),
    reason,
    expectedVersion: version,
  })
  .strict();
export type AccountControlInput = z.infer<typeof accountControlInputSchema>;

export const accountControlStateSchema = z.object({ target: accountControlTargetSchema, version, restricted: z.boolean() }).strict();
export type AccountControlState = z.infer<typeof accountControlStateSchema>;

export const accountControlLookupInputSchema = z.object({ target: accountControlTargetSchema }).strict();
export const accountControlHistoryInputSchema = accountControlLookupInputSchema
  .extend({ limit: z.number().int().min(1).max(200) })
  .strict();

function sameTarget(a: AccountControlTarget, b: AccountControlTarget): boolean {
  if (a.area === 'merchant' && b.area === 'merchant') return a.merchantId === b.merchantId;
  return a.area !== 'merchant' && b.area !== 'merchant' && a.area === b.area && a.userId === b.userId;
}

const auditFields = {
  auditId: id,
  requestId: id,
  target: accountControlTargetSchema,
  action: z.enum(['restrict', 'restore']),
  reason,
  occurredAt: timestamp,
};
const completedFields = { ...auditFields, actorUserId: id, before: accountControlStateSchema, after: accountControlStateSchema };

/** Failed/no-op attempts are audited too; they never claim a successful state change. */
export const accountControlResultSchema = z
  .discriminatedUnion('outcome', [
    z.object({ ...completedFields, outcome: z.literal('changed'), changed: z.literal(true) }).strict(),
    z.object({ ...completedFields, outcome: z.literal('noop'), changed: z.literal(false) }).strict(),
    z
      .object({
        ...auditFields,
        outcome: z.literal('refused'),
        changed: z.literal(false),
        actorUserId: id.nullable(),
        code: z.enum([
          'operator.denied',
          'mfa.required',
          'authority.unavailable',
          'target.not_found',
          'restore.not_permitted',
          'request.conflict',
        ]),
        current: accountControlStateSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...auditFields,
        outcome: z.literal('conflict'),
        changed: z.literal(false),
        actorUserId: id,
        code: z.literal('restriction.version_conflict'),
        current: accountControlStateSchema,
      })
      .strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.outcome === 'refused' && (result.code === 'operator.denied' || result.code === 'mfa.required') && result.current !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['current'], message: 'Unauthorized attempts cannot disclose target state' });
    }
    const states = 'before' in result ? [result.before, result.after] : result.current === null ? [] : [result.current];
    if (states.some((state) => !sameTarget(state.target, result.target))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'State belongs to a different target' });
    }
    if (!('before' in result)) return;
    // Zod runs refinements on dirty strings too. Refuse malformed/oversized
    // versions before BigInt conversion so safeParse remains non-throwing.
    if (!version.safeParse(result.before.version).success || !version.safeParse(result.after.version).success) return;
    const requested = result.action === 'restrict';
    const coherent =
      result.after.restricted === requested &&
      (result.outcome === 'changed'
        ? result.before.restricted !== result.after.restricted && BigInt(result.after.version) === BigInt(result.before.version) + 1n
        : result.before.restricted === result.after.restricted && result.before.version === result.after.version);
    if (!coherent) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['after'], message: 'Outcome, action and state versions disagree' });
  });
export type AccountControlResult = z.infer<typeof accountControlResultSchema>;

export const accountCredentialReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: id }).strict(),
  z.object({ kind: z.literal('api_key'), apiKeyId: id }).strict(),
]);
export const currentAuthorityInputSchema = z
  .object({ userId: id, credential: accountCredentialReferenceSchema, subAccountId: id.optional() })
  .strict();
export type CurrentAuthorityInput = z.infer<typeof currentAuthorityInputSchema>;

/** Identity's revocable founder entitlement; it does not assert session MFA or grant a scope. */
export const accountOperatorEntitlementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('enabled'), userId: id, version, changedAt: timestamp }).strict(),
  z.object({ status: z.literal('revoked'), userId: id, version, changedAt: timestamp }).strict(),
  z.object({ status: z.literal('unconfigured'), userId: id }).strict(),
  z.object({ status: z.literal('not_operator'), userId: id }).strict(),
]);
export type AccountOperatorEntitlement = z.infer<typeof accountOperatorEntitlementSchema>;

const ownership = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), ownership: sessionOwnershipSchema.strict() }).strict(),
  z.object({ kind: z.literal('api_key'), ownership: apiKeyOwnershipSchema.strict() }).strict(),
]);
const authorityFields = { subject: currentAuthorityInputSchema, checkedAt: timestamp };

/**
 * Read-only snapshot, NOT admission. Lease bounds private-read access, never new
 * money actions. Consumers check their trusted clock and expire access even if
 * renewal hangs; parsing does not establish freshness or authenticate the source.
 */
export const currentAuthorityResultSchema = z
  .discriminatedUnion('status', [
    z
      .object({
        ...authorityFields,
        status: z.literal('eligible'),
        account: accountStateSchema.strict(),
        credential: ownership,
        subAccount: subAccountOwnershipSchema.strict().nullable(),
        version,
        leaseExpiresAt: timestamp,
      })
      .strict(),
    z
      .object({
        ...authorityFields,
        status: z.literal('denied'),
        code: z.enum([
          'auth.account_frozen',
          'auth.credential_denied',
          'auth.credential_revoked',
          'auth.credential_expired',
          'auth.sub_account_denied',
        ]),
      })
      .strict(),
    z.object({ ...authorityFields, status: z.literal('unavailable'), code: z.literal('authority.unavailable') }).strict(),
  ])
  .superRefine((result, ctx) => {
    if (result.status !== 'eligible') return;
    const ref = result.subject.credential;
    const credentialId = ref.kind === 'session' ? ref.sessionId : ref.apiKeyId;
    const row = result.credential.ownership;
    if (
      result.account.userId !== result.subject.userId ||
      result.account.status !== 'active' ||
      result.credential.kind !== ref.kind ||
      row.id !== credentialId ||
      row.userId !== result.subject.userId ||
      row.revoked
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credential'],
        message: 'Eligible authority must match an active identity and live credential',
      });
    }
    const sub = result.subAccount;
    if (
      result.subject.subAccountId === undefined
        ? sub !== null
        : sub === null || sub.id !== result.subject.subAccountId || sub.parentUserId !== result.subject.userId || sub.revoked
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subAccount'], message: 'Sub-account proof does not match the subject' });
    }
    const leaseMs = Date.parse(result.leaseExpiresAt) - Date.parse(result.checkedAt);
    if (!(leaseMs > 0 && leaseMs <= 5000)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['leaseExpiresAt'],
        message: 'Private authority lease must be positive and at most 5000ms',
      });
    }
  });
export type CurrentAuthorityResult = z.infer<typeof currentAuthorityResultSchema>;

/** Closed operation list: recovery of a parent never admits fresh child exposure. */
export const controlledOperationSchema = z.discriminatedUnion('service', [
  z
    .object({
      service: z.literal('svc-trade'),
      kind: z.enum(['order.place', 'order.increase', 'strategy.start', 'algo.child', 'copy.mirror']),
      userId: id,
    })
    .strict(),
  z
    .object({
      service: z.literal('svc-pay'),
      kind: z.enum(['payment.create', 'payment.authorize', 'payment.capture', 'payout']),
      userId: id,
      merchantId: id,
    })
    .strict(),
]);
export type ControlledOperation = z.infer<typeof controlledOperationSchema>;

/** Internal service request. Hash canonical immutable parameters; store the original payload in its owner. */
export const operationAdmissionInputSchema = z.object({ operation: controlledOperationSchema, businessId, payloadHash }).strict();
export type OperationAdmissionInput = z.infer<typeof operationAdmissionInputSchema>;

/**
 * Only the authenticated owner returns this after durable, serialized admission.
 * Times/versions describe evidence; neither they nor schema parsing serialize a
 * cross-service identity freeze. Recovery remains valid after credentials revoke.
 */
export const committedOperationAdmissionSchema = operationAdmissionInputSchema
  .extend({
    status: z.literal('committed'),
    admissionId: id,
    admittedAt: timestamp,
    identityVersion: version,
    restrictionVersion: version,
  })
  .strict();
export type CommittedOperationAdmission = z.infer<typeof committedOperationAdmissionSchema>;

export const operationAdmissionResultSchema = z.discriminatedUnion('status', [
  committedOperationAdmissionSchema,
  z
    .object({
      status: z.literal('denied'),
      code: z.enum(['auth.account_frozen', 'trade.account_restricted', 'pay.merchant_inactive', 'operation.conflict']),
    })
    .strict(),
  z.object({ status: z.literal('unavailable'), code: z.literal('authority.unavailable') }).strict(),
]);
export type OperationAdmissionResult = z.infer<typeof operationAdmissionResultSchema>;

/** Reference only, never a caller-supplied permission to recover or replacement payload. */
export const operationRecoveryInputSchema = operationAdmissionInputSchema.extend({ admissionId: id }).strict();
export type OperationRecoveryInput = z.infer<typeof operationRecoveryInputSchema>;

/** Compare against a record loaded from trusted persistence, never a client-supplied receipt. */
export function recoveryMatchesAdmission(input: unknown, stored: unknown): boolean {
  const recovery = operationRecoveryInputSchema.safeParse(input);
  const admission = committedOperationAdmissionSchema.safeParse(stored);
  if (!recovery.success || !admission.success) return false;
  const a = recovery.data;
  const b = admission.data;
  return (
    a.admissionId === b.admissionId &&
    a.businessId === b.businessId &&
    a.payloadHash === b.payloadHash &&
    a.operation.service === b.operation.service &&
    a.operation.kind === b.operation.kind &&
    a.operation.userId === b.operation.userId &&
    (a.operation.service !== 'svc-pay' || (b.operation.service === 'svc-pay' && a.operation.merchantId === b.operation.merchantId))
  );
}

/**
 * Implementations authenticate context, check current founder entitlement/MFA,
 * and atomically audit changes. Either founder may act independently. Service
 * credentials alone cannot restrict accounts. Admission/recovery require an
 * authenticated owning service. Authority reads require an authenticated service
 * or the matching subject principal. This interface supplies no authorization
 * guard. Resolving recovery only loads the original admission; the owner performs
 * and reports its domain recovery, without treating this receipt as completion.
 */
export interface AccountControlsContract {
  change(context: Context & { principal: Principal }, input: AccountControlInput): Promise<AccountControlResult>;
  getState(context: Context & { principal: Principal }, input: { target: AccountControlTarget }): Promise<AccountControlState | null>;
  history(
    context: Context & { principal: Principal },
    input: { target: AccountControlTarget; limit: number },
  ): Promise<AccountControlResult[]>;
  operatorEntitlement(context: Context, input: { userId: string }): Promise<AccountOperatorEntitlement>;
  currentAuthority(context: Context, input: CurrentAuthorityInput): Promise<CurrentAuthorityResult>;
  admit(context: Context, input: OperationAdmissionInput): Promise<OperationAdmissionResult>;
  resolveRecovery(context: Context, input: OperationRecoveryInput): Promise<CommittedOperationAdmission>;
}
