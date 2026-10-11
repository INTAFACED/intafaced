import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { identityOperationIntentSchema, type IdentityOperationIntent, type IdentityOperationDecisionPort } from '@intafaced/contracts';
import {
  PayoutAdmissionError,
  ownedIdentityIntent,
  payoutTransaction,
  stable,
  verifiedDecision,
  withPayoutLock,
} from './payout-admission.js';
import type { OwnerIdentityAuthorityPort } from './payment-authority.js';

export interface PreparedPaymentOperation {
  paymentId: string;
  merchantId: string;
  kind: 'payment.create' | 'payment.authorize' | 'payment.capture';
  payload: Record<string, unknown>;
  authority?: IdentityOperationIntent['authority'];
}
export async function preparePaymentAdmission(
  tx: Sql,
  input: PreparedPaymentOperation,
  guard: (tx: Sql) => Promise<void>,
  authorityPort?: OwnerIdentityAuthorityPort,
): Promise<IdentityOperationIntent> {
  const businessId = `${input.kind}:${input.paymentId.toLowerCase()}`;
  const rows = await tx`SELECT user_id,operations_control_version FROM pay.merchants WHERE id=${input.merchantId} FOR SHARE`;
  if (!rows[0]) throw new Error('pay.merchant_not_found');
  const previous = await tx`SELECT payload,intent FROM pay.payment_admissions WHERE business_id=${businessId}`;
  if (previous[0]) {
    if (stable(previous[0].payload) !== stable(input.payload)) throw new PayoutAdmissionError('pay.identity_admission_conflict');
    return identityOperationIntentSchema.parse(previous[0].intent);
  }
  await guard(tx);
  const operation = { service: 'svc-pay' as const, kind: input.kind, userId: String(rows[0].user_id), merchantId: input.merchantId };
  const originalAuthority = input.authority ?? { kind: 'merchant_policy' as const, merchantId: input.merchantId };
  const authority = authorityPort ? await authorityPort.resolve(tx, operation, originalAuthority) : originalAuthority;
  const intent = ownedIdentityIntent({
    operation,
    businessId,
    payloadHash: `sha256:${createHash('sha256').update(stable(input.payload)).digest('hex')}`,
    authority,
  });
  await tx`INSERT INTO pay.payment_admissions(business_id,payment_id,merchant_id,merchant_control_version,intent,payload) VALUES(${businessId},${input.paymentId},${input.merchantId},${String(rows[0].operations_control_version)},${tx.json(intent)},${tx.json(JSON.parse(stable(input.payload)))})`;
  await tx`INSERT INTO pay.payment_admission_outcomes(business_id,kind,payload) VALUES(${businessId},'identity_requested',${tx.json(intent)})`;
  return intent;
}
/** Persist original owner intent and request marker before asking identity. */
export async function withPaymentAdmission<T>(
  sql: Sql,
  identity: IdentityOperationDecisionPort | undefined,
  input: PreparedPaymentOperation,
  guard: (tx: Sql) => Promise<void>,
  effect: (tx: Sql, admitted: boolean) => Promise<T>,
  authorityPort?: OwnerIdentityAuthorityPort,
): Promise<T> {
  if (!identity) return transaction(sql, (tx) => effect(tx, false), { isolation: 'read committed', maxAttempts: 5 });
  return withPayoutLock(sql, input.paymentId, async (connection) => {
    const businessId = `${input.kind}:${input.paymentId.toLowerCase()}`;
    const intent = await payoutTransaction(connection, (tx) => preparePaymentAdmission(tx, input, guard, authorityPort));
    const accepted = await payoutTransaction(connection, async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id=${input.merchantId} FOR SHARE`;
      const previous =
        await tx`SELECT kind FROM pay.payment_admission_outcomes WHERE business_id=${businessId} AND kind IN('identity_granted','identity_cancelled')`;
      if (previous[0]) return previous[0].kind === 'identity_granted';
      await guard(tx);
      await authorityPort?.validate(tx, intent.authority);
      const decision = verifiedDecision(intent, await identity.decide({ mode: 'grant', intent }));
      await tx`INSERT INTO pay.payment_admission_outcomes(business_id,kind,payload) VALUES(${businessId},${decision.status === 'granted' ? 'identity_granted' : 'identity_cancelled'},${tx.json(decision)})`;
      return decision.status === 'granted';
    });
    if (!accepted) throw new PayoutAdmissionError('pay.identity_admission_denied');
    // A committed grant is original admitted work, including after a cutoff.
    return payoutTransaction(connection, async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id=${input.merchantId} FOR SHARE`;
      return effect(tx, true);
    });
  });
}
/** Caller owns the merchant exclusive restriction guard. */
export async function drainPendingPaymentIdentityIntents(
  tx: Sql,
  merchantId: string,
  identity: IdentityOperationDecisionPort,
): Promise<void> {
  const rows =
    await tx`SELECT a.business_id,a.intent FROM pay.payment_admissions a WHERE a.merchant_id=${merchantId} AND NOT EXISTS(SELECT 1 FROM pay.payment_admission_outcomes o WHERE o.business_id=a.business_id AND o.kind IN('identity_granted','identity_cancelled'))`;
  for (const row of rows) {
    const intent = identityOperationIntentSchema.parse(row.intent);
    const decision = verifiedDecision(intent, await identity.decide({ mode: 'resolve_or_cancel', intent }));
    await tx`INSERT INTO pay.payment_admission_outcomes(business_id,kind,payload) VALUES(${row.business_id},${decision.status === 'granted' ? 'identity_granted' : 'identity_cancelled'},${tx.json(decision)}) ON CONFLICT DO NOTHING`;
  }
}
/** Exactly the pending records that an exclusive cutoff must drain. */
export async function pendingIdentityIntentCount(tx: Sql, merchantId: string): Promise<number> {
  const [row] = await tx`SELECT (
    (SELECT count(*) FROM pay.payout_admissions a WHERE a.merchant_id=${merchantId} AND a.identity_intent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pay.payout_outcomes o WHERE o.admission_id=a.id AND o.kind IN('identity_granted','identity_cancelled'))) +
    (SELECT count(*) FROM pay.payment_admissions a WHERE a.merchant_id=${merchantId} AND NOT EXISTS(SELECT 1 FROM pay.payment_admission_outcomes o WHERE o.business_id=a.business_id AND o.kind IN('identity_granted','identity_cancelled')))
  )::int AS pending`;
  return Number(row?.pending ?? 0);
}
