import type { PayoutApproval } from '@intafaced/contracts';
import { ageView } from './control-model';
import { buildCsv } from './csv';
import { formatAmount } from './money';

/**
 * The founder approvals queue: payouts that the merchant's own team approved and that now wait for two
 * founders. Filtering, sorting and the KPI strip are pure so they are tested without a page.
 */

export const APPROVAL_SORTS = ['oldest', 'newest', 'expiry'] as const;
export type ApprovalSort = (typeof APPROVAL_SORTS)[number];

export interface ApprovalQuery {
  readonly q: string;
  readonly asset: string;
  readonly sort: ApprovalSort;
  /** Only requests whose own validity window is nearly used up or already over. */
  readonly urgent: boolean;
}

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

export function parseApprovalQuery(sp: Record<string, string | string[] | undefined>): ApprovalQuery {
  const sort = one(sp.sort);
  return {
    q: one(sp.q).slice(0, 80),
    asset: one(sp.asset).slice(0, 16).toUpperCase(),
    sort: (APPROVAL_SORTS as readonly string[]).includes(sort) ? (sort as ApprovalSort) : 'oldest',
    urgent: one(sp.urgent) === '1',
  };
}

export function hasApprovalFilter(q: ApprovalQuery): boolean {
  return q.q !== '' || q.asset !== '' || q.urgent;
}

export function filterApprovals(
  rows: readonly PayoutApproval[],
  query: ApprovalQuery,
  names: ReadonlyMap<string, string | null>,
  now: Date,
): PayoutApproval[] {
  const needle = query.q.toLowerCase();
  return rows.filter((a) => {
    if (query.asset !== '' && a.assetCode !== query.asset) return false;
    if (query.urgent && ageView(a.createdAt, a.expiresAt, now).expiry.tone === 'live') return false;
    if (needle === '') return true;
    const name = names.get(a.merchantId)?.toLowerCase() ?? '';
    return name.includes(needle) || a.merchantId.toLowerCase().includes(needle) || a.approvalId.toLowerCase().includes(needle);
  });
}

export function sortApprovals(rows: readonly PayoutApproval[], sort: ApprovalSort): PayoutApproval[] {
  const by = {
    oldest: (a: PayoutApproval, b: PayoutApproval) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    newest: (a: PayoutApproval, b: PayoutApproval) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    expiry: (a: PayoutApproval, b: PayoutApproval) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt),
  }[sort];
  return [...rows].sort(by);
}

export interface ApprovalKpis {
  readonly waiting: number;
  readonly oldestCreatedAt: string | null;
  readonly expiringSoon: number;
  readonly expired: number;
  readonly involvingYou: number;
}

export function approvalKpis(rows: readonly PayoutApproval[], now: Date, currentUserId: string | undefined): ApprovalKpis {
  const tones = rows.map((a) => ageView(a.createdAt, a.expiresAt, now).expiry.tone);
  const me = currentUserId?.toLowerCase();
  return {
    waiting: rows.length,
    oldestCreatedAt:
      rows.length === 0 ? null : rows.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b)).createdAt,
    expiringSoon: tones.filter((t) => t === 'warn').length,
    expired: tones.filter((t) => t === 'danger').length,
    involvingYou: me ? rows.filter((a) => a.makerUserId.toLowerCase() === me || a.checkerUserId?.toLowerCase() === me).length : 0,
  };
}

/** True when the signed-in founder asked for, or approved, this payout. They cannot sign it; a different founder must. */
export function tookPart(a: PayoutApproval, currentUserId: string | undefined): boolean {
  const me = currentUserId?.toLowerCase();
  return !!me && (a.makerUserId.toLowerCase() === me || a.checkerUserId?.toLowerCase() === me);
}

export function approvalsCsv(
  rows: readonly PayoutApproval[],
  names: ReadonlyMap<string, string | null>,
  generatedAt: string,
  asOf: string,
  note: string,
): string {
  return buildCsv({
    header: [
      'merchant_name',
      'merchant_id',
      'approval_id',
      'amount',
      'asset',
      'status',
      'requested_at',
      'expires_at',
      'requested_by',
      'merchant_approver',
    ],
    rows: rows.map((a) => [
      names.get(a.merchantId) ?? '',
      a.merchantId,
      a.approvalId,
      a.amount,
      a.assetCode,
      a.status,
      a.createdAt,
      a.expiresAt,
      a.makerUserId,
      a.checkerUserId ?? '',
    ]),
    generatedAt,
    asOf,
    note,
  });
}

export const approvalAmountText = (a: Pick<PayoutApproval, 'amount' | 'assetCode'>): string => `${formatAmount(a.amount)} ${a.assetCode}`;
