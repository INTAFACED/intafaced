import type { Sql } from 'postgres';
import { DISPUTE_FEE_NOTE } from './chargeback-ledger.js';

/** Append-only snapshot the founder dispute projection reads. */
export const CHARGEBACK_LEDGER_EFFECT_EVENT = 'chargeback.ledger_effect';

export interface ChargebackLedgerEffect {
  readonly openingTxId: string | null;
  readonly shortfallTxId: string | null;
  readonly wonTxId: string | null;
  readonly recoveredTxId: string | null;
  /** Pay pricing has no dispute fee. This is always false. */
  readonly feePosted: false;
  readonly feeNote: string;
}

export function chargebackLedgerEffect(input: {
  openingTxId: string | null;
  shortfallTxId: string | null;
  wonTxId: string | null;
  recoveredTxId: string | null;
}): ChargebackLedgerEffect {
  return {
    openingTxId: input.openingTxId,
    shortfallTxId: input.shortfallTxId,
    wonTxId: input.wonTxId,
    recoveredTxId: input.recoveredTxId,
    feePosted: false,
    feeNote: DISPUTE_FEE_NOTE,
  };
}

function asTxId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function parseChargebackLedgerEffect(payload: unknown): ChargebackLedgerEffect | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  return chargebackLedgerEffect({
    openingTxId: asTxId(row.openingTxId),
    shortfallTxId: asTxId(row.shortfallTxId),
    wonTxId: asTxId(row.wonTxId),
    recoveredTxId: asTxId(row.recoveredTxId),
  });
}

/** Latest effect per dispute, from the append-only payment event log. */
export async function loadChargebackLedgerEffects(sql: Sql, disputeIds: readonly string[]): Promise<Map<string, ChargebackLedgerEffect>> {
  const out = new Map<string, ChargebackLedgerEffect>();
  if (disputeIds.length === 0) return out;
  const rows = await sql<Array<{ dispute_id: string; payload: unknown }>>`
    SELECT DISTINCT ON (payload->>'disputeId')
           payload->>'disputeId' AS dispute_id,
           payload
      FROM pay.payment_events
     WHERE event = ${CHARGEBACK_LEDGER_EFFECT_EVENT}
       AND payload->>'disputeId' IN ${sql([...disputeIds])}
     ORDER BY payload->>'disputeId', seq DESC`;
  for (const row of rows) {
    const effect = parseChargebackLedgerEffect(row.payload);
    if (row.dispute_id && effect) out.set(row.dispute_id, effect);
  }
  return out;
}
