import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { ControlRefusal, type ControlRefusalCode } from './errors.js';

/**
 * ROW-LOCKED CAP COUNTERS.
 *
 * `consumeMoney` / `consumeBeneficiary` run INSIDE the caller's admission
 * transaction, after the merchant lock (seams/guards.ts lock order). The counter
 * row is taken FOR UPDATE, so concurrent admissions for one merchant queue on it
 * and each sees the committed total of the one before: a cap cannot be exceeded
 * by even one minor unit.
 *
 * IDEMPOTENT BY BUSINESS KEY. The event row `(event_key, cap_kind)` is written in
 * the same transaction as the increment. A key that is already there means this
 * work was counted by an earlier call; it is neither added again nor refused, so
 * a hook that runs twice for one payment never double counts and never refuses
 * its own repeat. A rolled-back transaction rolls the event back with it.
 *
 * LOCK ORDER among the counters of one call: the caller passes them in a fixed
 * order (daily, then monthly), so two calls cannot deadlock on each other.
 */

export type MoneyCapKind = 'daily_intake' | 'monthly_intake' | 'daily_payout';

const EXCEEDED: Record<MoneyCapKind, ControlRefusalCode> = {
  daily_intake: 'pay.cap_daily_intake_exceeded',
  monthly_intake: 'pay.cap_monthly_intake_exceeded',
  daily_payout: 'pay.cap_daily_payout_exceeded',
};

async function lockCounter(tx: Sql, merchantId: string, kind: string, assetCode: string, periodKey: string): Promise<Amount> {
  await tx`
    INSERT INTO pay.control_cap_usage (merchant_id, cap_kind, asset_code, period_key)
    VALUES (${merchantId}, ${kind}, ${assetCode}, ${periodKey})
    ON CONFLICT DO NOTHING
  `;
  const rows = await tx<Array<{ used: string }>>`
    SELECT used FROM pay.control_cap_usage
     WHERE merchant_id = ${merchantId} AND cap_kind = ${kind} AND asset_code = ${assetCode} AND period_key = ${periodKey}
       FOR UPDATE
  `;
  return parseAmount(rows[0]!.used);
}

/** Take the cap counter FOR UPDATE, creating the row at 0 when this period has none yet. */
export function lockMoneyUsage(tx: Sql, merchantId: string, kind: MoneyCapKind, assetCode: string, periodKey: string): Promise<Amount> {
  return lockCounter(tx, merchantId, kind, assetCode, periodKey);
}

export interface ConsumeResult {
  /** True when this call added to the counter; false when the key was already counted. */
  readonly counted: boolean;
  /** Counter value before this call's addition (the committed total it saw under the lock). */
  readonly usedBefore: Amount;
}

/** Add `amount` to a money counter if it stays at or under `limit`; refuse otherwise. */
export async function consumeMoney(
  tx: Sql,
  input: {
    merchantId: string;
    kind: MoneyCapKind;
    assetCode: string;
    periodKey: string;
    eventKey: string;
    amount: Amount;
    limit: Amount;
    /**
     * False = add to the counter WITHOUT checking the limit. Only for finishing work
     * whose value has already moved (a recovered capture): it must be counted so the
     * book and the counter agree, and it must never be refused (seams/guards.ts).
     */
    enforce?: boolean;
  },
): Promise<ConsumeResult> {
  const used = await lockCounter(tx, input.merchantId, input.kind, input.assetCode, input.periodKey);
  const seen = await tx`SELECT 1 FROM pay.control_cap_events WHERE event_key = ${input.eventKey} AND cap_kind = ${input.kind}`;
  if (seen.length > 0) return { counted: false, usedBefore: used };
  if (input.enforce !== false && used + input.amount > input.limit) throw new ControlRefusal(EXCEEDED[input.kind]);
  await tx`
    INSERT INTO pay.control_cap_events (event_key, cap_kind, merchant_id, asset_code, period_key, amount)
    VALUES (${input.eventKey}, ${input.kind}, ${input.merchantId}, ${input.assetCode}, ${input.periodKey}, ${formatAmount(input.amount)}::numeric)
  `;
  await tx`
    UPDATE pay.control_cap_usage SET used = used + ${formatAmount(input.amount)}::numeric, updated_at = now()
     WHERE merchant_id = ${input.merchantId} AND cap_kind = ${input.kind} AND asset_code = ${input.assetCode} AND period_key = ${input.periodKey}
  `;
  return { counted: true, usedBefore: used };
}

/**
 * Count a payout destination toward the day's distinct-beneficiary cap. A
 * destination already used today costs nothing; a new one is refused past `limit`.
 */
export async function consumeBeneficiary(
  tx: Sql,
  input: { merchantId: string; periodKey: string; destination: string; eventKey: string; limit: number },
): Promise<void> {
  const used = await lockCounter(tx, input.merchantId, 'beneficiaries_per_day', '', input.periodKey);
  const known = await tx`
    SELECT 1 FROM pay.control_beneficiaries
     WHERE merchant_id = ${input.merchantId} AND period_key = ${input.periodKey} AND destination = ${input.destination}
  `;
  if (known.length > 0) return;
  const seen = await tx`SELECT 1 FROM pay.control_cap_events WHERE event_key = ${input.eventKey} AND cap_kind = 'beneficiaries_per_day'`;
  if (seen.length > 0) return;
  if (used + 1n * 10n ** 18n > BigInt(input.limit) * 10n ** 18n) throw new ControlRefusal('pay.cap_beneficiaries_exceeded');
  await tx`INSERT INTO pay.control_beneficiaries (merchant_id, period_key, destination) VALUES (${input.merchantId}, ${input.periodKey}, ${input.destination})`;
  await tx`
    INSERT INTO pay.control_cap_events (event_key, cap_kind, merchant_id, asset_code, period_key, amount)
    VALUES (${input.eventKey}, 'beneficiaries_per_day', ${input.merchantId}, '', ${input.periodKey}, 1)
  `;
  await tx`
    UPDATE pay.control_cap_usage SET used = used + 1, updated_at = now()
     WHERE merchant_id = ${input.merchantId} AND cap_kind = 'beneficiaries_per_day' AND asset_code = '' AND period_key = ${input.periodKey}
  `;
}

/** Read-only usage for display; no lock, missing row = 0. */
export async function readUsage(q: Sql, merchantId: string, kind: string, assetCode: string, periodKey: string): Promise<Amount> {
  const rows = await q<Array<{ used: string }>>`
    SELECT used FROM pay.control_cap_usage
     WHERE merchant_id = ${merchantId} AND cap_kind = ${kind} AND asset_code = ${assetCode} AND period_key = ${periodKey}
  `;
  return rows[0] ? parseAmount(rows[0].used) : 0n;
}

/** Record that a business key was admitted, without adding to any counter (amount 0). Idempotent. */
export async function markCounted(
  tx: Sql,
  input: { eventKey: string; kind: string; merchantId: string; assetCode: string; periodKey: string },
): Promise<void> {
  await tx`
    INSERT INTO pay.control_cap_events (event_key, cap_kind, merchant_id, asset_code, period_key, amount)
    VALUES (${input.eventKey}, ${input.kind}, ${input.merchantId}, ${input.assetCode}, ${input.periodKey}, 0)
    ON CONFLICT DO NOTHING
  `;
}

/** Has this business key already been counted for this cap? Read inside the admission transaction. */
export async function alreadyCounted(tx: Sql, eventKey: string, kind: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM pay.control_cap_events WHERE event_key = ${eventKey} AND cap_kind = ${kind}`;
  return rows.length > 0;
}
