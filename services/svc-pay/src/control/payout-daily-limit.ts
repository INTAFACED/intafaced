import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { lockMoneyUsage, readUsage } from './counters.js';
import { ControlError } from './errors.js';
import { dayKey, effectiveCaps, loadMerchantControl, moneyCapLimit } from './store.js';

/**
 * Test seam. Two approvals wait here, after the limit is known and before the
 * counter lock, so a test can prove they meet on that lock. Unset outside that test.
 */
let beforeDailyPayoutLock: (() => Promise<void>) | undefined;

export function setBeforeDailyPayoutLock(next: (() => Promise<void>) | undefined): void {
  beforeDailyPayoutLock = next;
}

export interface DailyPayoutRemainingRow {
  readonly assetCode: string;
  /** Exact decimal headroom. Null means no daily payout limit is configured. */
  readonly remaining: string | null;
}

export interface DailyPayoutApprovalSubject {
  readonly approvalId: string;
  readonly merchantId: string;
  readonly assetCode: string;
  readonly amount: string;
}

/** Approvals that already hold today's headroom and have not been paid out. */
export async function reservedLivePayoutAmount(
  q: Sql,
  merchantId: string,
  assetCode: string,
  at: Date,
  excludeApprovalId: string | null = null,
): Promise<Amount> {
  const rows = await q<Array<{ reserved: string }>>`
    SELECT COALESCE(SUM(amount), 0)::text AS reserved
      FROM pay.control_payout_approvals
     WHERE merchant_id = ${merchantId}
       AND asset_code = ${assetCode}
       AND expires_at > ${at}
       AND (${excludeApprovalId}::uuid IS NULL OR id <> ${excludeApprovalId}::uuid)
       AND (
         status = 'approved'
         OR (status = 'pending' AND checker_user_id IS NOT NULL)
       )
  `;
  return parseAmount(rows[0]?.reserved ?? '0');
}

function configuredLimit(caps: ReturnType<typeof effectiveCaps>, assetCode: string): Amount | null {
  if (!caps) return null;
  return moneyCapLimit(caps, 'daily_payout', assetCode);
}

function headroom(limit: Amount, used: Amount, reserved: Amount): Amount {
  const committed = used + reserved;
  return limit > committed ? limit - committed : 0n;
}

/**
 * Remaining daily payout limit for the portal list. A configured cap is always
 * included. An asset on the page with no cap is included with `remaining: null`
 * (refuse, never unlimited).
 */
export async function dailyPayoutRemainingRows(
  q: Sql,
  merchantId: string,
  at: Date,
  assetCodes: readonly string[],
): Promise<DailyPayoutRemainingRow[]> {
  const control = await loadMerchantControl(q, merchantId);
  const caps = effectiveCaps(control);
  const limits = new Map<string, Amount>();
  if (caps) {
    for (const cap of caps) {
      if (cap.kind === 'daily_payout') limits.set(cap.assetCode, parseAmount(cap.limit));
    }
  }
  const assets = new Set<string>(limits.keys());
  for (const assetCode of assetCodes) assets.add(assetCode);
  const period = dayKey(at);
  const rows: DailyPayoutRemainingRow[] = [];
  for (const assetCode of [...assets].sort()) {
    const limit = limits.get(assetCode);
    if (limit === undefined) {
      rows.push({ assetCode, remaining: null });
      continue;
    }
    const used = await readUsage(q, merchantId, 'daily_payout', assetCode, period);
    const reserved = await reservedLivePayoutAmount(q, merchantId, assetCode, at);
    rows.push({ assetCode, remaining: formatAmount(headroom(limit, used, reserved)) });
  }
  return rows;
}

/**
 * Refuse an approval that would exceed today's remaining payout limit.
 *
 * Runs inside the approval transaction, which already holds this approval row.
 * The daily payout counter is the next lock, the same order `beforePayoutAdmit`
 * uses (approval row, then the counter). Two approvals therefore queue on the
 * counter and the second sees the first's committed reservation. A missing cap
 * refuses; it is not treated as unlimited.
 */
export async function assertApprovalWithinDailyPayoutLimit(tx: Sql, subject: DailyPayoutApprovalSubject, at: Date): Promise<void> {
  const control = await loadMerchantControl(tx, subject.merchantId);
  const limit = configuredLimit(effectiveCaps(control), subject.assetCode);
  if (limit === null) throw new ControlError('pay.caps_unconfigured');
  if (beforeDailyPayoutLock) await beforeDailyPayoutLock();
  const used = await lockMoneyUsage(tx, subject.merchantId, 'daily_payout', subject.assetCode, dayKey(at));
  const reserved = await reservedLivePayoutAmount(tx, subject.merchantId, subject.assetCode, at, subject.approvalId);
  const remaining = headroom(limit, used, reserved);
  if (parseAmount(subject.amount) > remaining) {
    throw new ControlError('pay.payout_daily_limit_exceeded', undefined, formatAmount(remaining));
  }
}
