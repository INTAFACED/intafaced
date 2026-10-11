import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { OwnerIdentityAuthorityPort } from './payment-authority.js';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  identityOperationIntentSchema,
  identityOperationDecisionSchema,
  normalizeIdentityOperationInput,
  canonicalIdentityOperationIntent,
  type IdentityOperationDecisionPort,
  type IdentityOperationIntent,
} from '@intafaced/contracts';
export type IdentityPayoutAdmissionPort = IdentityOperationDecisionPort;
export class PayoutAdmissionError extends Error {
  constructor(readonly code: 'pay.identity_admission_unavailable' | 'pay.identity_admission_denied' | 'pay.identity_admission_conflict') {
    super(code);
  }
}
export function ownedIdentityIntent(raw: unknown): IdentityOperationIntent {
  const result = identityOperationIntentSchema.safeParse(normalizeIdentityOperationInput(raw));
  if (!result.success) throw new PayoutAdmissionError('pay.identity_admission_denied');
  return result.data;
}
export type PayoutAdmission = {
  id: string;
  settlement_id: string;
  merchant_id: string;
  merchant_user_id: string;
  attempt: number;
  business_id: string;
  net: string;
  asset_id: string;
  rail_id: string;
  destination_kind: string;
  destination_ref: string;
  window: string;
  merchant_control_version: string;
  identity_intent: unknown | null;
};
export function stable(value: unknown): string {
  return canonicalIdentityOperationIntent(value === undefined ? null : JSON.parse(JSON.stringify(value)));
}
export function payoutPayloadHash(record: Omit<PayoutAdmission, 'id' | 'merchant_control_version' | 'identity_intent'>): string {
  const data = {
    settlementId: record.settlement_id,
    merchantId: record.merchant_id,
    userId: record.merchant_user_id,
    attempt: record.attempt,
    businessId: record.business_id,
    amount: formatAmount(parseAmount(record.net)),
    assetId: record.asset_id,
    railId: record.rail_id,
    destination: { kind: record.destination_kind, ref: record.destination_ref },
    window: record.window,
  };
  return `sha256:${createHash('sha256').update(stable(data)).digest('hex')}`;
}
export async function withPayoutLock<T>(sql: Sql, settlementId: string, fn: (connection: Sql) => Promise<T>): Promise<T> {
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(hashtext('pay.payout:'||${settlementId.toLowerCase()}))`;
    return await fn(connection);
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(hashtext('pay.payout:'||${settlementId.toLowerCase()}))`;
    } finally {
      connection.release();
    }
  }
}
/** ReservedSql's inherited begin() typing does not match its runtime API. */
export async function payoutTransaction<T>(connection: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  await connection`BEGIN ISOLATION LEVEL READ COMMITTED`;
  try {
    const result = await fn(connection);
    await connection`COMMIT`;
    return result;
  } catch (error) {
    await connection`ROLLBACK`;
    throw error;
  }
}
export async function loadPayoutAdmission(sql: Sql, settlementId: string, attempt: number): Promise<PayoutAdmission | null> {
  const rows = await sql<PayoutAdmission[]>`SELECT * FROM pay.payout_admissions WHERE settlement_id=${settlementId} AND attempt=${attempt}`;
  return rows[0] ?? null;
}
export async function insertPayoutAdmission(
  sql: Sql,
  record: Omit<PayoutAdmission, 'id' | 'merchant_control_version' | 'identity_intent'>,
  guard: (tx: Sql) => Promise<void>,
  identity?: IdentityPayoutAdmissionPort,
  authority?: IdentityOperationIntent['authority'],
  authorityPort?: OwnerIdentityAuthorityPort,
): Promise<PayoutAdmission> {
  return payoutTransaction(sql, async (tx) => {
    const rows = await tx`SELECT operations_control_version FROM pay.merchants WHERE id=${record.merchant_id} FOR SHARE`;
    if (!rows[0]) throw new Error('pay.merchant_not_found');
    await guard(tx);
    const id = randomUUID();
    const operation = {
      service: 'svc-pay' as const,
      kind: 'payout' as const,
      userId: record.merchant_user_id,
      merchantId: record.merchant_id,
    };
    const originalAuthority = authority ?? { kind: 'merchant_policy' as const, merchantId: record.merchant_id };
    const resolvedAuthority = authorityPort ? await authorityPort.resolve(tx, operation, originalAuthority) : originalAuthority;
    const intent = identity
      ? ownedIdentityIntent({
          operation,
          businessId: record.business_id,
          payloadHash: payoutPayloadHash(record),
          authority: resolvedAuthority,
        })
      : null;
    const result = await tx<
      PayoutAdmission[]
    >`INSERT INTO pay.payout_admissions(id,settlement_id,merchant_id,merchant_user_id,attempt,business_id,net,asset_id,rail_id,destination_kind,destination_ref,"window",merchant_control_version,identity_intent)
   VALUES(${id},${record.settlement_id},${record.merchant_id},${record.merchant_user_id},${record.attempt},${record.business_id},${record.net},${record.asset_id},${record.rail_id},${record.destination_kind},${record.destination_ref},${record.window},${String(rows[0].operations_control_version)},${intent ? tx.json(intent) : null}) RETURNING *`;
    if (intent) await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${id},'identity_requested',${tx.json(intent)})`;
    return result[0]!;
  });
}
export function verifiedDecision(intent: IdentityOperationIntent, raw: unknown) {
  const decision = identityOperationDecisionSchema.parse(raw);
  if (decision.status === 'unavailable') throw new PayoutAdmissionError('pay.identity_admission_unavailable');
  if (decision.status === 'conflict' || stable(decision.intent) !== stable(intent))
    throw new PayoutAdmissionError('pay.identity_admission_conflict');
  return decision;
}
export async function finalizePayoutIdentity(
  sql: Sql,
  record: PayoutAdmission,
  guard: (tx: Sql) => Promise<void>,
  identity?: IdentityPayoutAdmissionPort,
  authorityPort?: OwnerIdentityAuthorityPort,
): Promise<void> {
  if (record.identity_intent === null) return;
  const intent = identityOperationIntentSchema.parse(record.identity_intent);
  const previous =
    await sql`SELECT kind FROM pay.payout_outcomes WHERE admission_id=${record.id} AND kind IN('identity_granted','identity_cancelled')`;
  if (previous[0]?.kind === 'identity_granted') return;
  if (previous[0]?.kind === 'identity_cancelled') throw new PayoutAdmissionError('pay.identity_admission_denied');
  if (!identity) throw new PayoutAdmissionError('pay.identity_admission_unavailable');
  const accepted = await payoutTransaction(sql, async (tx) => {
    await tx`SELECT id FROM pay.merchants WHERE id=${record.merchant_id} FOR SHARE`;
    const resolved =
      await tx`SELECT kind FROM pay.payout_outcomes WHERE admission_id=${record.id} AND kind IN('identity_granted','identity_cancelled')`;
    if (resolved[0]) return resolved[0].kind === 'identity_granted';
    await guard(tx);
    await authorityPort?.validate(tx, intent.authority);
    const decision = verifiedDecision(intent, await identity.decide({ mode: 'grant', intent }));
    await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${record.id},${decision.status === 'granted' ? 'identity_granted' : 'identity_cancelled'},${tx.json(decision)})`;
    return decision.status === 'granted';
  });
  if (!accepted) throw new PayoutAdmissionError('pay.identity_admission_denied');
}
/** Call only while the founder writer owns the merchant FOR UPDATE guard. */
export async function drainPendingPayoutIdentityIntents(tx: Sql, merchantId: string, identity: IdentityPayoutAdmissionPort): Promise<void> {
  const rows = await tx<
    PayoutAdmission[]
  >`SELECT a.* FROM pay.payout_admissions a WHERE a.merchant_id=${merchantId} AND a.identity_intent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pay.payout_outcomes o WHERE o.admission_id=a.id AND o.kind IN('identity_granted','identity_cancelled'))`;
  for (const record of rows) {
    const intent = identityOperationIntentSchema.parse(record.identity_intent);
    const decision = verifiedDecision(intent, await identity.decide({ mode: 'resolve_or_cancel', intent }));
    await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${record.id},${decision.status === 'granted' ? 'identity_granted' : 'identity_cancelled'},${tx.json(decision)}) ON CONFLICT DO NOTHING`;
  }
}
