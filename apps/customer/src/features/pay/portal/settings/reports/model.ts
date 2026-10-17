import type { ExportJob, ExportKind } from './schemas';
import { exportKinds } from './schemas';

/** The columns each report can carry. This mirrors the service's allowlist: anything else is refused there. */
export const kindColumns: Record<ExportKind, readonly string[]> = {
  payments: [
    'payment_id',
    'created_at',
    'status',
    'asset',
    'amount',
    'captured_amount',
    'refunded_amount',
    'method',
    'rail',
    'rail_reference',
    'customer_reference',
  ],
  settlements: ['settlement_id', 'window', 'asset', 'gross', 'fees', 'net', 'status', 'payout_method', 'payout_reference', 'created_at'],
  payouts: ['settlement_id', 'window', 'asset', 'net_paid', 'status', 'payout_method', 'payout_reference', 'created_at'],
  refunds: ['event_id', 'payment_id', 'occurred_at', 'amount', 'asset'],
  ledger_statement: ['account', 'asset', 'kind', 'available'],
  disputes: ['dispute_id', 'payment_id', 'status', 'amount', 'asset', 'opened_at', 'reason_code'],
  fees: ['subject_kind', 'subject_id', 'asset', 'fee', 'recorded_at', 'fee_bps', 'applied_layer'],
};

/** Viewers and developers get the fee amount but not the pricing level behind it. */
const pricingLevelColumns = new Set(['fee_bps', 'applied_layer']);
export function columnsFor(kind: ExportKind, role: string | null): readonly string[] {
  const all = kindColumns[kind];
  return kind === 'fees' && (role === 'viewer' || role === 'developer') ? all.filter((c) => !pricingLevelColumns.has(c)) : all;
}

const paymentStatuses = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;
const settlementStatuses = ['pending', 'posted', 'paid_out', 'failed'] as const;
const disputeStatuses = ['open', 'contested', 'accepted', 'won', 'lost'] as const;
/** The status filter each kind accepts. Null means the kind has no status filter, so none is offered. */
export function statusesFor(kind: ExportKind): readonly string[] | null {
  return kind === 'payments'
    ? paymentStatuses
    : kind === 'settlements' || kind === 'payouts'
      ? settlementStatuses
      : kind === 'disputes'
        ? disputeStatuses
        : null;
}
/** Which filters a kind accepts, so the form shows only controls that do something. */
export const hasAssetFilter = (_kind: ExportKind) => true;
/** The ledger statement is a balance at one moment, so a date range does not apply to it. */
export const hasDateRange = (kind: ExportKind) => kind !== 'ledger_statement';

export const isKnownKind = (kind: string): kind is ExportKind => (exportKinds as readonly string[]).includes(kind);

const overrides: Record<string, string> = {
  fee_bps: 'Fee rate (bps)',
  applied_layer: 'Pricing level',
  rail: 'Payment route',
  window: 'Settlement window',
  net_paid: 'Net paid',
  reason_code: 'Reason',
};
export function columnLabel(key: string): string {
  if (overrides[key]) return overrides[key]!;
  const words = key.split('_').map((w) => (w === 'id' ? 'ID' : w));
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatBytes(raw: string | null | undefined): string {
  if (raw == null || !/^\d+$/.test(raw)) return '—';
  const n = Number(raw);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A day picked in the form, as the window the service wants: the end is the start of the next day, so the picked day is included. */
export function windowOf(from: string, to: string): { from?: string; to?: string } {
  const start = from ? `${from}T00:00:00.000Z` : undefined;
  const end = to ? new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString() : undefined;
  return { ...(start ? { from: start } : {}), ...(end ? { to: end } : {}) };
}
export const windowProblem = (from: string, to: string) => Boolean(from && to && from > to);

/** What a job covers, for a list: the days (end shown as the last included day), the status and the asset. */
export function rangeParts(job: Pick<ExportJob, 'filters'>): {
  from: string | null;
  to: string | null;
  status: string | null;
  asset: string | null;
} {
  const to = job.filters.to ? new Date(Date.parse(job.filters.to) - 1).toISOString().slice(0, 10) : null;
  return { from: job.filters.from?.slice(0, 10) ?? null, to, status: job.filters.status ?? null, asset: job.filters.assetId ?? null };
}

export const isBuilding = (job: Pick<ExportJob, 'status'>) => job.status === 'queued' || job.status === 'running';
/** A file can be deleted unless it is being built right now or is already gone. */
export const canDelete = (job: Pick<ExportJob, 'status'>) => job.status !== 'running' && job.status !== 'expired';
