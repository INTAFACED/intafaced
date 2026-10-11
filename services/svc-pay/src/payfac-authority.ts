import type { Sql } from 'postgres';
import { identityOperationIntentSchema, type IdentityOperationIntent, type IdentityOperationDecisionPort } from '@intafaced/contracts';
import type { SubMerchantService, PermissionAuthorityEvidence, PermissionEventRecord } from './submerchants.js';
import type { OwnerIdentityAuthorityPort } from './payment-authority.js';
import { PayoutAdmissionError, stable, verifiedDecision } from './payout-admission.js';
type Authority = IdentityOperationIntent['authority'];
type PayfacAuthority = Extract<Authority, { kind: 'payfac_credential' }>;
function proof(evidence: PermissionAuthorityEvidence): PayfacAuthority['proof'] {
  const ids = { actorMerchantId: evidence.actorMerchantId, subjectMerchantId: evidence.subjectMerchantId };
  return evidence.proof.kind === 'root_relation'
    ? { kind: 'root_relation', ...ids }
    : { kind: 'explicit_grant', ...ids, grantEventId: evidence.proof.grantEventId, grantSequence: evidence.proof.grantSequence };
}
async function evidence(trees: SubMerchantService, tx: Sql, userId: string, merchantId: string, area: PayfacAuthority['area']) {
  try {
    return await trees.permissionAuthorityEvidence(userId, merchantId, area, tx);
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('pay.submerchant_'))
      throw new PayoutAdmissionError('pay.identity_admission_denied');
    throw error;
  }
}
/** Only authenticated owner code supplies the original subject; proof comes from live owned rows. */
export function createPayfacAuthorityGuard(trees: SubMerchantService): OwnerIdentityAuthorityPort {
  const validate = async (tx: Sql, authority: Authority) => {
    if (authority.kind !== 'payfac_credential') return;
    const current = await evidence(trees, tx, authority.subject.userId, authority.proof.subjectMerchantId, authority.area);
    if (stable(proof(current)) !== stable(authority.proof)) throw new PayoutAdmissionError('pay.identity_admission_denied');
  };
  return {
    validate,
    resolve: async (tx, operation, authority) => {
      if (authority.kind === 'payfac_credential') {
        await validate(tx, authority);
        return authority;
      }
      if (authority.kind !== 'credential' || authority.subject.userId.toLowerCase() === operation.userId.toLowerCase()) return authority;
      const area = operation.kind === 'payout' ? 'settlement.payout' : 'payment';
      const current = await evidence(trees, tx, authority.subject.userId, operation.merchantId, area);
      return { kind: 'payfac_credential', subject: authority.subject, area, proof: proof(current) };
    },
  };
}
export async function pendingPayfacPermissionIntentCount(tx: Sql, current: PermissionEventRecord): Promise<number> {
  const [row] = await tx`SELECT (
  (SELECT count(*) FROM pay.payment_admissions a WHERE a.merchant_id=${current.subjectMerchantId}
   AND a.intent->'authority'->>'kind'='payfac_credential' AND a.intent->'authority'->>'area'=${current.area}
   AND a.intent->'authority'->'proof'->>'actorMerchantId'=${current.granteeMerchantId}
   AND NOT EXISTS(SELECT 1 FROM pay.payment_admission_outcomes o WHERE o.business_id=a.business_id AND o.kind IN('identity_granted','identity_cancelled'))) +
  (SELECT count(*) FROM pay.payout_admissions a WHERE a.merchant_id=${current.subjectMerchantId}
   AND a.identity_intent->'authority'->>'kind'='payfac_credential' AND a.identity_intent->'authority'->>'area'=${current.area}
   AND a.identity_intent->'authority'->'proof'->>'actorMerchantId'=${current.granteeMerchantId}
   AND NOT EXISTS(SELECT 1 FROM pay.payout_outcomes o WHERE o.admission_id=a.id AND o.kind IN('identity_granted','identity_cancelled')))
 )::int AS pending`;
  return Number(row?.pending ?? 0);
}
/** Caller owns subject FOR UPDATE; resolve/cancel every matching original request before revocation. */
export async function drainPayfacPermissionIntents(
  tx: Sql,
  current: PermissionEventRecord,
  identity: IdentityOperationDecisionPort,
): Promise<void> {
  const payments = await tx`SELECT a.business_id,a.intent FROM pay.payment_admissions a WHERE a.merchant_id=${current.subjectMerchantId}
   AND a.intent->'authority'->>'kind'='payfac_credential' AND a.intent->'authority'->>'area'=${current.area}
   AND a.intent->'authority'->'proof'->>'actorMerchantId'=${current.granteeMerchantId}
   AND NOT EXISTS(SELECT 1 FROM pay.payment_admission_outcomes o WHERE o.business_id=a.business_id AND o.kind IN('identity_granted','identity_cancelled'))`;
  for (const row of payments) {
    const intent = identityOperationIntentSchema.parse(row.intent);
    const decision = verifiedDecision(intent, await identity.decide({ mode: 'resolve_or_cancel', intent }));
    await tx`INSERT INTO pay.payment_admission_outcomes(business_id,kind,payload) VALUES(${row.business_id},${decision.status === 'granted' ? 'identity_granted' : 'identity_cancelled'},${tx.json(decision)}) ON CONFLICT DO NOTHING`;
  }
  const payouts = await tx`SELECT a.id,a.identity_intent FROM pay.payout_admissions a WHERE a.merchant_id=${current.subjectMerchantId}
   AND a.identity_intent->'authority'->>'kind'='payfac_credential' AND a.identity_intent->'authority'->>'area'=${current.area}
   AND a.identity_intent->'authority'->'proof'->>'actorMerchantId'=${current.granteeMerchantId}
   AND NOT EXISTS(SELECT 1 FROM pay.payout_outcomes o WHERE o.admission_id=a.id AND o.kind IN('identity_granted','identity_cancelled'))`;
  for (const row of payouts) {
    const intent = identityOperationIntentSchema.parse(row.identity_intent);
    const decision = verifiedDecision(intent, await identity.decide({ mode: 'resolve_or_cancel', intent }));
    await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${row.id},${decision.status === 'granted' ? 'identity_granted' : 'identity_cancelled'},${tx.json(decision)}) ON CONFLICT DO NOTHING`;
  }
}
