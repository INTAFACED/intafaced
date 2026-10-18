import type { ReactNode } from 'react';
import type { FounderMerchantSection, FounderMerchantSectionPage } from '@intafaced/contracts';
import { Chip } from '@/components/chip';
import { CopyButton } from '@/components/merchants/copy-button';
import { CsvButton } from '@/components/merchants/csv-button';
import { Card, FailureState, KpiTile, MoneyText, shortId, StateBlock, StatusChip } from '@/components/merchants/ui';
import { buildCsv } from '@/lib/merchants/csv';
import { FEE_NO_CAPTURE_SNAPSHOT, FEE_NO_SETTLEMENT_SNAPSHOT, FEE_RECORDED_AT_CAPTURE } from '@/lib/merchants/fee-story';
import type { PayCallResult } from '@/lib/merchants/pay-call';
import { formatUtc } from '@/lib/merchants/time';
import {
  cursorKey,
  hrefWith,
  one,
  PAGE_LIMIT,
  searchKey,
  SECTION_SPECS,
  SETTLEMENT_ROW_SECTIONS,
  settlementStatusChip,
  statusChip,
  statusKey,
  type Query,
} from '@/lib/founder-ops/read-model';

/**
 * The seventeen merchant sections of #4870 (F07-F23). One table per section, built from the exact rows the service
 * returned: money stays a decimal string, destinations stay masked, and nothing is added up here that the service did not
 * add up. An empty page, a failed read and an unbuilt catalog are three different pictures.
 */

/**
 * The contract types every list page with the whole section union as its tag, so a page cannot be narrowed by `section`.
 * Each row type is picked out by a field only that section's rows carry; a wrong guess here is a type error, not a runtime one.
 */
type Page = FounderMerchantSectionPage;
type AnyItem = Page['items'][number];
type ApiKeysPage = Extract<Page, { catalog: unknown }>;
type ProfilePage = Extract<Page, { current: unknown }>;
interface ItemMap {
  payments: Extract<AnyItem, { railAdapter: string }>;
  refunds: Extract<AnyItem, { refundId: string }>;
  disputes: Extract<AnyItem, { disputeId: string }>;
  settlements: Extract<AnyItem, { failedAt: string | null }>;
  payouts: Exclude<Extract<AnyItem, { window: string }>, { failedAt: unknown }>;
  destinations: Extract<AnyItem, { destinationMasked: string }>;
  customers: Extract<AnyItem, { customerRef: string; paymentCount: number }>;
  links: Extract<AnyItem, { prefix: string }>;
  invoices: Extract<AnyItem, { paymentLinkId: string | null }>;
  subscriptions: Extract<AnyItem, { mandateId: string }>;
  team: Extract<AnyItem, { userId: string; role: string }>;
  webhooks: Extract<AnyItem, { url: string }>;
  deliveries: Extract<AnyItem, { endpointId: string; eventType: string }>;
  activity: Extract<AnyItem, { objectType: string; action: string }>;
  exports: Extract<AnyItem, { jobId: string }>;
}
type Item<S extends keyof ItemMap> = ItemMap[S];

interface Col<T> {
  readonly label: string;
  readonly right?: boolean;
  /** Plain text for the CSV export: the raw decimal strings, not the formatted display. */
  readonly text: (row: T) => string;
  readonly cell?: (row: T) => ReactNode;
}

const dash = <span className="mp-muted">—</span>;
const when = (iso: string | null): ReactNode => (iso === null ? dash : <time dateTime={iso}>{formatUtc(iso)}</time>);
const whenText = (iso: string | null): string => iso ?? '';
const orDash = (value: string | null | undefined): ReactNode => (value === null || value === undefined || value === '' ? dash : value);
/** A payment without a pricing snapshot. The snapshot is written at capture, so the words depend on whether capture happened. */
export function NoFee({ status }: { status: string }) {
  if (status === 'failed') {
    return (
      <span className="mp-muted" title="The payment failed, so no pricing snapshot was written.">
        No fee: payment failed
      </span>
    );
  }
  if (status === 'created' || status === 'authorized') {
    return (
      <span className="mp-muted" title={FEE_RECORDED_AT_CAPTURE}>
        Recorded at capture
      </span>
    );
  }
  return (
    <span className="mp-muted" title={FEE_NO_CAPTURE_SNAPSHOT}>
      Not recorded: no pricing rule at capture
    </span>
  );
}

const chipOf = (value: string): ReactNode => <StatusChip spec={statusChip(value)} />;
const settlementChipOf = (value: string): ReactNode => <StatusChip spec={settlementStatusChip(value)} />;
const idCell = (value: string): ReactNode => (
  <span className="mp-idcell">
    <code title={value}>{shortId(value)}</code> <CopyButton value={value} label="Copy" />
  </span>
);
const moneyCell = (amount: string, asset: string): ReactNode => <MoneyText amount={amount} assetCode={asset} />;
const moneyText = (amount: string, asset: string): string => `${amount} ${asset}`;

const COLUMNS: { [S in keyof ItemMap]: readonly Col<Item<S>>[] } = {
  payments: [
    { label: 'Payment', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'Amount', right: true, text: (r) => moneyText(r.amount, r.assetId), cell: (r) => moneyCell(r.amount, r.assetId) },
    {
      label: 'Captured',
      right: true,
      text: (r) => moneyText(r.capturedAmount, r.assetId),
      cell: (r) => moneyCell(r.capturedAmount, r.assetId),
    },
    {
      label: 'Refunded',
      right: true,
      text: (r) => moneyText(r.refundedAmount, r.assetId),
      cell: (r) => moneyCell(r.refundedAmount, r.assetId),
    },
    {
      label: 'Status',
      text: (r) => (r.failureCode ? `${r.status} (${r.failureCode})` : r.status),
      cell: (r) => (
        <>
          {chipOf(r.status)}
          {r.failureCode ? <code className="mp-sub"> {r.failureCode}</code> : null}
        </>
      ),
    },
    {
      label: 'Method and rail',
      text: (r) => `${r.method} / ${r.railAdapter}${r.railRef ? ` / ${r.railRef}` : ''}`,
      cell: (r) => (
        <>
          {r.method} · {r.railAdapter}
          {r.railRef ? (
            <>
              {' '}
              <code className="mp-sub" title="Reference on the rail">
                {shortId(r.railRef)}
              </code>
            </>
          ) : null}
        </>
      ),
    },
    {
      label: 'Fee applied',
      right: true,
      text: (r) => (r.pricing ? `${moneyText(r.pricing.fee, r.pricing.assetCode)} (${r.pricing.appliedLayer})` : ''),
      cell: (r) =>
        r.pricing ? (
          <>
            {moneyCell(r.pricing.fee, r.pricing.assetCode)}{' '}
            <Chip tone="info" title={`The ${r.pricing.appliedLayer} pricing rule set this fee. Rule ${r.pricing.ruleId}.`}>
              {r.pricing.appliedLayer}
            </Chip>
          </>
        ) : (
          <NoFee status={r.status} />
        ),
    },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
  ],
  refunds: [
    { label: 'Refund', text: (r) => r.refundId, cell: (r) => idCell(r.refundId) },
    { label: 'Payment', text: (r) => r.paymentId, cell: (r) => idCell(r.paymentId) },
    { label: 'Amount', right: true, text: (r) => moneyText(r.amount, r.assetId), cell: (r) => moneyCell(r.amount, r.assetId) },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    { label: 'Reason', text: (r) => r.reason ?? '', cell: (r) => orDash(r.reason) },
    {
      label: 'Ledger effect',
      text: (r) => (r.ledgerEffect.recorded ? `${r.ledgerEffect.direction ?? ''} ${r.ledgerEffect.pot ?? ''}`.trim() : 'not recorded'),
      cell: (r) =>
        r.ledgerEffect.recorded ? (
          <>
            {r.ledgerEffect.direction ?? '—'} · {r.ledgerEffect.pot ?? '—'}
          </>
        ) : (
          <span className="mp-muted" title="No ledger transaction is recorded for this refund.">
            Not recorded
          </span>
        ),
    },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Settled', text: (r) => whenText(r.settledAt), cell: (r) => when(r.settledAt) },
  ],
  disputes: [
    { label: 'Dispute', text: (r) => r.disputeId, cell: (r) => idCell(r.disputeId) },
    { label: 'Payment', text: (r) => r.paymentId, cell: (r) => idCell(r.paymentId) },
    { label: 'Amount', right: true, text: (r) => moneyText(r.amount, r.assetId), cell: (r) => moneyCell(r.amount, r.assetId) },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    { label: 'Reason', text: (r) => r.reasonCode ?? '', cell: (r) => orDash(r.reasonCode) },
    {
      label: 'Response due',
      text: (r) => whenText(r.responseDueAt),
      cell: (r) =>
        r.responseDueAt ? (
          <>
            {when(r.responseDueAt)} <span className="mp-sub">from the rail</span>
          </>
        ) : (
          <span className="mp-muted" title="The rail has not sent a response deadline.">
            No deadline from the rail
          </span>
        ),
    },
    {
      label: 'Ledger',
      text: (r) => (r.ledgerRefuseCode ? `${r.ledgerWire} (${r.ledgerRefuseCode})` : r.ledgerWire),
      cell: (r) => (
        <>
          {r.ledgerWire === 'posted' ? (
            chipOf('posted')
          ) : (
            <Chip tone="danger" title="The ledger refused the chargeback posting. See the code.">
              refused
            </Chip>
          )}
          {r.ledgerRefuseCode ? <code className="mp-sub"> {r.ledgerRefuseCode}</code> : null}
        </>
      ),
    },
    { label: 'Opened', text: (r) => r.openedAt, cell: (r) => when(r.openedAt) },
  ],
  settlements: [
    { label: 'Settlement', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'Window', text: (r) => r.window },
    { label: 'Gross', right: true, text: (r) => moneyText(r.gross, r.assetId), cell: (r) => moneyCell(r.gross, r.assetId) },
    { label: 'Fees', right: true, text: (r) => moneyText(r.fees, r.assetId), cell: (r) => moneyCell(r.fees, r.assetId) },
    { label: 'Net', right: true, text: (r) => moneyText(r.net, r.assetId), cell: (r) => moneyCell(r.net, r.assetId) },
    {
      label: 'Status',
      text: (r) => (r.failureCode ? `${r.status} (${r.failureCode})` : r.status),
      cell: (r) => (
        <>
          {settlementChipOf(r.status)}
          {r.failureCode ? <code className="mp-sub"> {r.failureCode}</code> : null}
        </>
      ),
    },
    {
      label: 'Payout',
      text: (r) => `${r.payoutMethod ?? ''} ${r.payoutReference ?? ''}`.trim(),
      cell: (r) => (r.payoutMethod || r.payoutReference ? `${r.payoutMethod ?? ''} ${r.payoutReference ?? ''}`.trim() : dash),
    },
    {
      label: 'Fee snapshot',
      right: true,
      text: (r) => (r.pricing ? `${moneyText(r.pricing.fee, r.pricing.assetCode)} (${r.pricing.appliedLayer})` : ''),
      cell: (r) =>
        r.pricing ? (
          <>
            {moneyCell(r.pricing.fee, r.pricing.assetCode)} <Chip tone="info">{r.pricing.appliedLayer}</Chip>
          </>
        ) : (
          <span className="mp-muted" title={FEE_NO_SETTLEMENT_SNAPSHOT}>
            Not recorded
          </span>
        ),
    },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Settled', text: (r) => whenText(r.settledAt), cell: (r) => when(r.settledAt) },
  ],
  payouts: [
    { label: 'Settlement', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'Window', text: (r) => r.window },
    { label: 'Gross', right: true, text: (r) => moneyText(r.gross, r.assetId), cell: (r) => moneyCell(r.gross, r.assetId) },
    { label: 'Fees', right: true, text: (r) => moneyText(r.fees, r.assetId), cell: (r) => moneyCell(r.fees, r.assetId) },
    { label: 'Net', right: true, text: (r) => moneyText(r.net, r.assetId), cell: (r) => moneyCell(r.net, r.assetId) },
    { label: 'Status', text: (r) => r.status, cell: (r) => settlementChipOf(r.status) },
    { label: 'Method', text: (r) => r.payoutMethod ?? '', cell: (r) => orDash(r.payoutMethod) },
    { label: 'Reference', text: (r) => r.payoutReference ?? '', cell: (r) => orDash(r.payoutReference) },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
  ],
  destinations: [
    { label: 'Destination (masked)', text: (r) => r.destinationMasked, cell: (r) => <code>{r.destinationMasked}</code> },
    { label: 'Rail', text: (r) => r.railId },
    { label: 'Kind', text: (r) => r.kind },
    {
      label: 'Screening',
      text: () => 'not recorded',
      cell: () => (
        <span className="mp-muted" title="No screening result is stored against this destination, so none is shown.">
          Not recorded
        </span>
      ),
    },
    {
      label: 'Default',
      text: () => 'unset',
      cell: () => (
        <span className="mp-muted" title="The pay service does not store a default flag for destinations.">
          Unset
        </span>
      ),
    },
    { label: 'Added', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Last used', text: (r) => whenText(r.lastUsedAt), cell: (r) => when(r.lastUsedAt) },
  ],
  customers: [
    { label: 'Customer reference', text: (r) => r.customerRef, cell: (r) => idCell(r.customerRef) },
    { label: 'Payments', right: true, text: (r) => String(r.paymentCount) },
    { label: 'Subscriptions', right: true, text: (r) => String(r.subscriptionCount) },
    { label: 'Mandates', right: true, text: (r) => String(r.mandateCount) },
    {
      label: 'Captured / refunded',
      text: (r) => r.totals.map((t) => `${t.assetId} captured ${t.capturedAmount} refunded ${t.refundedAmount}`).join('; '),
      cell: (r) =>
        r.totals.length === 0 ? (
          dash
        ) : (
          <span className="mp-amounts">
            {r.totals.map((t) => (
              <span key={t.assetId} className="mp-amount">
                <MoneyText amount={t.capturedAmount} assetCode={t.assetId} /> <span className="mp-sub">captured</span> ·{' '}
                <MoneyText amount={t.refundedAmount} assetCode={t.assetId} /> <span className="mp-sub">refunded</span>
              </span>
            ))}
          </span>
        ),
    },
    { label: 'First seen', text: (r) => r.firstSeenAt, cell: (r) => when(r.firstSeenAt) },
    { label: 'Last seen', text: (r) => r.lastSeenAt, cell: (r) => when(r.lastSeenAt) },
  ],
  links: [
    { label: 'Link', text: (r) => r.prefix, cell: (r) => idCell(r.prefix) },
    { label: 'Label', text: (r) => r.label, cell: (r) => (r.label === '' ? dash : <bdi>{r.label}</bdi>) },
    {
      label: 'Amount',
      right: true,
      text: (r) => (r.amount && r.currency ? moneyText(r.amount, r.currency) : ''),
      cell: (r) => (r.amount && r.currency ? moneyCell(r.amount, r.currency) : <span className="mp-muted">Payer chooses the amount</span>),
    },
    {
      label: 'State',
      text: (r) => (r.active ? 'active' : 'inactive'),
      cell: (r) => chipOf(r.active ? 'active' : 'disabled'),
    },
    {
      label: 'Used',
      right: true,
      text: (r) => (r.maxUses === null ? String(r.uses) : `${r.uses} of ${r.maxUses}`),
    },
    {
      label: 'Expires',
      text: (r) => whenText(r.expiresAt),
      cell: (r) => (r.expiresAt ? when(r.expiresAt) : <span className="mp-muted">Never</span>),
    },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
  ],
  invoices: [
    { label: 'Invoice', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    { label: 'Amount', right: true, text: (r) => moneyText(r.amount, r.assetId), cell: (r) => moneyCell(r.amount, r.assetId) },
    { label: 'Customer', text: (r) => r.customerRef ?? '', cell: (r) => orDash(r.customerRef) },
    { label: 'Description', text: (r) => r.description ?? '', cell: (r) => (r.description ? <bdi>{r.description}</bdi> : dash) },
    { label: 'Payment', text: (r) => r.paymentId ?? '', cell: (r) => (r.paymentId ? idCell(r.paymentId) : dash) },
    { label: 'Sent', text: (r) => whenText(r.sentAt), cell: (r) => when(r.sentAt) },
    { label: 'Paid', text: (r) => whenText(r.paidAt), cell: (r) => when(r.paidAt) },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
  ],
  subscriptions: [
    { label: 'Subscription', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'Customer', text: (r) => r.customerId, cell: (r) => idCell(r.customerId) },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    { label: 'Path', text: (r) => r.path },
    { label: 'Next run', text: (r) => r.nextRunAt, cell: (r) => when(r.nextRunAt) },
    {
      label: 'Stalled',
      text: (r) => r.stallReason ?? '',
      cell: (r) =>
        r.stallReason ? (
          <Chip tone="danger" title="The last run could not go ahead for this reason.">
            {r.stallReason}
          </Chip>
        ) : (
          dash
        ),
    },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Ended', text: (r) => whenText(r.cancelledAt ?? r.pausedAt), cell: (r) => when(r.cancelledAt ?? r.pausedAt) },
  ],
  team: [
    { label: 'Person', text: (r) => r.userId, cell: (r) => idCell(r.userId) },
    { label: 'Label', text: (r) => r.label ?? '', cell: (r) => (r.label ? <bdi>{r.label}</bdi> : dash) },
    { label: 'Role', text: (r) => r.role },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    { label: 'Invited by', text: (r) => r.invitedBy ?? '', cell: (r) => orDash(r.invitedBy) },
    { label: 'Added', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Active since', text: (r) => whenText(r.activatedAt), cell: (r) => when(r.activatedAt) },
    { label: 'Removed', text: (r) => whenText(r.removedAt), cell: (r) => when(r.removedAt) },
  ],
  webhooks: [
    { label: 'Endpoint', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'URL', text: (r) => r.url, cell: (r) => <code className="mp-wrap">{r.url}</code> },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    {
      label: 'Failures in a row',
      right: true,
      text: (r) => String(r.consecutiveFailures),
      cell: (r) => (
        <span className="mp-num" data-warn={r.consecutiveFailures > 0 ? 'true' : undefined}>
          {r.consecutiveFailures}
        </span>
      ),
    },
    { label: 'Disabled because', text: (r) => r.disabledReason ?? '', cell: (r) => orDash(r.disabledReason) },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Updated', text: (r) => r.updatedAt, cell: (r) => when(r.updatedAt) },
  ],
  deliveries: [
    { label: 'Delivery', text: (r) => r.id, cell: (r) => idCell(r.id) },
    { label: 'Endpoint', text: (r) => r.endpointId, cell: (r) => idCell(r.endpointId) },
    { label: 'Event', text: (r) => r.eventType },
    { label: 'Status', text: (r) => r.status, cell: (r) => chipOf(r.status) },
    { label: 'Attempts', right: true, text: (r) => String(r.attempts) },
    {
      label: 'Last HTTP status',
      right: true,
      text: (r) => (r.lastStatusCode === null ? '' : String(r.lastStatusCode)),
      cell: (r) => (r.lastStatusCode === null ? dash : <span className="mp-num">{r.lastStatusCode}</span>),
    },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Delivered', text: (r) => whenText(r.deliveredAt), cell: (r) => when(r.deliveredAt) },
  ],
  activity: [
    { label: 'When', text: (r) => r.occurredAt, cell: (r) => when(r.occurredAt) },
    { label: 'Who', text: (r) => r.actorId, cell: (r) => idCell(r.actorId) },
    { label: 'Action', text: (r) => r.action },
    {
      label: 'Object',
      text: (r) => `${r.objectType} ${r.objectId}`,
      cell: (r) => (
        <>
          {r.objectType} · <code title={r.objectId}>{shortId(r.objectId)}</code>
        </>
      ),
    },
    {
      label: 'Detail',
      text: (r) =>
        Object.entries(r.detail)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      cell: (r) =>
        Object.keys(r.detail).length === 0 ? (
          dash
        ) : (
          <span className="mp-sub">
            {Object.entries(r.detail)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ')}
          </span>
        ),
    },
  ],
  exports: [
    { label: 'Job', text: (r) => r.jobId, cell: (r) => idCell(r.jobId) },
    { label: 'Kind', text: (r) => r.kind.replace(/_/g, ' ') },
    {
      label: 'Status',
      text: (r) => (r.failureCode ? `${r.status} (${r.failureCode})` : r.status),
      cell: (r) => (
        <>
          {chipOf(r.status)}
          {r.failureCode ? <code className="mp-sub"> {r.failureCode}</code> : null}
        </>
      ),
    },
    { label: 'File', text: (r) => r.fileName ?? '', cell: (r) => orDash(r.fileName) },
    {
      label: 'Size (bytes)',
      right: true,
      text: (r) => r.sizeBytes ?? '',
      cell: (r) => (r.sizeBytes ? <span className="mp-num">{r.sizeBytes}</span> : dash),
    },
    {
      label: 'Rows',
      right: true,
      text: (r) => (r.rowCount === null ? '' : String(r.rowCount)),
      cell: (r) => (r.rowCount === null ? dash : <span className="mp-num">{r.rowCount}</span>),
    },
    { label: 'Asked by', text: (r) => r.requestedBy, cell: (r) => idCell(r.requestedBy) },
    { label: 'Created', text: (r) => r.createdAt, cell: (r) => when(r.createdAt) },
    { label: 'Finished', text: (r) => whenText(r.completedAt), cell: (r) => when(r.completedAt) },
  ],
};

/** A generic table for a list of columns and rows. Column order is the contract with the CSV. */
export function RowsTable<T>({
  cols,
  rows,
  caption,
  rowKey,
}: {
  cols: readonly Col<T>[];
  rows: readonly T[];
  caption: string;
  rowKey: (row: T, i: number) => string;
}) {
  return (
    <div className="mp-scroll" tabIndex={0} role="region" aria-label={`${caption}, scrolls sideways on small screens`}>
      <table className="mp-table mp-table--rows">
        <caption className="mp-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.label} scope="col" className={c.right ? 'mp-right' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {cols.map((c) => (
                <td key={c.label} className={c.right ? 'mp-right' : undefined}>
                  {c.cell ? c.cell(row) : c.text(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Next page and first page. The service pages by cursor, so there is no Previous: the browser's back button is that. */
export function Pager({
  path,
  query,
  cursorParam,
  nextCursor,
}: {
  path: string;
  query: Query | undefined;
  cursorParam: string;
  nextCursor: string | null;
}) {
  const onLaterPage = one(query, cursorParam) !== undefined;
  if (!onLaterPage && nextCursor === null) return null;
  return (
    <nav className="mp-pager" aria-label="Pages">
      {onLaterPage ? (
        <a className="mp-btn" href={hrefWith(path, query, { [cursorParam]: undefined })}>
          ← First page
        </a>
      ) : (
        <span />
      )}
      {nextCursor !== null ? (
        <a className="mp-btn" href={hrefWith(path, query, { [cursorParam]: nextCursor })} rel="next">
          Next page →
        </a>
      ) : (
        <span className="mp-btn" aria-disabled="true" data-disabled="true">
          End of list
        </span>
      )}
    </nav>
  );
}

/** A GET form that keeps every other list's state on the page. Changing a filter drops that list's cursor. */
export function ListFilters({
  path,
  query,
  statusParam,
  statuses,
  searchParam,
  extraDropKeys,
  label,
  statusLabel,
}: {
  path: string;
  query: Query | undefined;
  statusParam?: string | undefined;
  statuses?: readonly string[] | undefined;
  searchParam?: string | undefined;
  extraDropKeys: readonly string[];
  label: string;
  statusLabel?: ((status: string) => string) | undefined;
}) {
  const own = new Set([statusParam, searchParam, ...extraDropKeys].filter((k): k is string => k !== undefined));
  const kept = Object.entries(query ?? {}).flatMap(([key, raw]) => {
    const value = Array.isArray(raw) ? raw[0] : raw;
    return !own.has(key) && typeof value === 'string' && value !== '' ? [[key, value] as const] : [];
  });
  const status = statusParam ? one(query, statusParam) : undefined;
  const search = searchParam ? one(query, searchParam) : undefined;
  const active = (status !== undefined && statuses?.includes(status)) || search !== undefined;
  if (!(statusParam && statuses) && !searchParam) return null;
  return (
    <form className="mp-filters" method="get" action={path} aria-label={`${label} filters`}>
      {kept.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {statusParam && statuses ? (
        <div className="mp-field">
          <label htmlFor={statusParam}>Status</label>
          <select id={statusParam} name={statusParam} className="mp-input" defaultValue={status ?? ''}>
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {(statusLabel ?? ((v: string) => statusChip(v).label))(s)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {searchParam ? (
        <div className="mp-field mp-field--grow">
          <label htmlFor={searchParam}>Search</label>
          <input
            id={searchParam}
            name={searchParam}
            className="mp-input"
            defaultValue={search ?? ''}
            maxLength={200}
            placeholder="Id or reference"
          />
        </div>
      ) : null}
      <div className="mp-filters__actions">
        <button type="submit" className="mp-btn mp-btn--primary">
          Apply
        </button>
        {active ? (
          <a className="mp-btn" href={hrefWith(path, query, { ...Object.fromEntries([...own].map((k) => [k, undefined])) })}>
            Clear
          </a>
        ) : null}
      </div>
    </form>
  );
}

function ProfilePanel({ page }: { page: ProfilePage }) {
  const c = page.current;
  return (
    <>
      <dl className="mp-facts" aria-label="Current business profile">
        <div>
          <dt className="mp-facts__k">Display name</dt>
          <dd className="mp-facts__v">{c.displayName === null ? <span className="mp-muted">Not set</span> : <bdi>{c.displayName}</bdi>}</dd>
        </div>
        <div>
          <dt className="mp-facts__k">Legal name</dt>
          <dd className="mp-facts__v">{c.legalName === null ? <span className="mp-muted">Not set</span> : <bdi>{c.legalName}</bdi>}</dd>
        </div>
        <div>
          <dt className="mp-facts__k">Account status</dt>
          <dd className="mp-facts__v">{chipOf(c.status)}</dd>
        </div>
        <div>
          <dt className="mp-facts__k">Mode</dt>
          <dd className="mp-facts__v">{c.mode}</dd>
        </div>
        <div>
          <dt className="mp-facts__k">KYB</dt>
          <dd className="mp-facts__v">
            {chipOf(c.kybStatus)} {c.kybRef ? <code className="mp-sub">{c.kybRef}</code> : null}
          </dd>
        </div>
      </dl>
      {page.items.length === 0 ? (
        <StateBlock kind="empty" title="No verification history yet">
          Each submission and decision appears here, oldest changes last, and is never edited afterwards.
        </StateBlock>
      ) : (
        <RowsTable
          caption="KYB history"
          rows={page.items}
          rowKey={(r) => r.seq}
          cols={[
            { label: '#', right: true, text: (r) => r.seq },
            { label: 'From', text: (r) => r.fromStatus, cell: (r) => chipOf(r.fromStatus) },
            { label: 'To', text: (r) => r.toStatus, cell: (r) => chipOf(r.toStatus) },
            { label: 'Decided by', text: (r) => r.decidedBy },
            { label: 'Reference', text: (r) => r.kybRef ?? '', cell: (r) => orDash(r.kybRef) },
            { label: 'Reason', text: (r) => r.reason ?? '', cell: (r) => orDash(r.reason) },
            { label: 'When', text: (r) => r.at, cell: (r) => when(r.at) },
          ]}
        />
      )}
    </>
  );
}

export interface SectionPanelProps {
  readonly section: FounderMerchantSection;
  readonly result: PayCallResult<FounderMerchantSectionPage> | undefined;
  readonly path: string;
  readonly query: Query | undefined;
  readonly readAt: string;
  readonly testData: boolean;
}

export function SectionPanel({ section, result, path, query, readAt, testData }: SectionPanelProps) {
  const spec = SECTION_SPECS[section];
  const retry = hrefWith(path, query, {});
  const frame = (sub: string, body: ReactNode, actions?: ReactNode) => (
    <Card id={section} title={spec.title} sub={sub} actions={actions}>
      {body}
    </Card>
  );
  if (!result)
    return frame(
      spec.sub,
      <StateBlock kind="info" title="Not read">
        This list was not requested for this page.
      </StateBlock>,
    );
  if (result.kind !== 'ok') return frame(spec.sub, <FailureState failure={result} what={spec.title} retryHref={retry} />);
  const page = result.data;

  if ('catalog' in page) {
    return frame(
      spec.sub,
      <StateBlock kind="not_built" title="The pay service holds no API key catalog">
        The pay service does not hold the merchant&apos;s API keys: the key catalog and its signing settings live elsewhere and have no
        founder read. This is not an empty list, and no key, prefix or secret is shown. Webhook endpoints and deliveries below are read from
        the pay service.
      </StateBlock>,
    );
  }
  if ('current' in page) {
    return frame(spec.sub, <ProfilePanel page={page} />, undefined);
  }

  const cols = (COLUMNS as Record<string, readonly Col<unknown>[] | undefined>)[page.section];
  const filters = (
    <ListFilters
      path={path}
      query={query}
      statusParam={spec.statuses ? statusKey(section) : undefined}
      statuses={spec.statuses}
      searchParam={spec.searchable ? searchKey(section) : undefined}
      extraDropKeys={[cursorKey(section)]}
      label={spec.title}
      statusLabel={SETTLEMENT_ROW_SECTIONS.includes(section) ? (v) => settlementStatusChip(v).label : undefined}
    />
  );
  const filtered = one(query, statusKey(section)) !== undefined || one(query, searchKey(section)) !== undefined;
  const onLater = one(query, cursorKey(section)) !== undefined;
  if (!cols)
    return frame(
      spec.sub,
      <StateBlock kind="error" title={`${spec.title} cannot be shown`}>
        This console has no columns for this list.
      </StateBlock>,
    );
  const csv = buildCsv({
    header: cols.map((c) => c.label),
    rows: (page.items as unknown[]).map((row) => cols.map((c) => c.text(row))),
    generatedAt: readAt,
    asOf: readAt,
    note: `${testData ? 'TEST DATA. ' : ''}${spec.title}: this page only, up to ${PAGE_LIMIT} rows${filtered ? ', filtered' : ''}. Destinations are masked.`,
  });
  const rows = page.items as readonly unknown[];
  return frame(
    `${spec.sub} ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} on this page${page.nextCursor ? ', more on the next page' : ''}.`,
    <>
      {filters}
      {rows.length === 0 ? (
        <StateBlock
          kind="empty"
          title={
            filtered
              ? `No ${spec.title.toLowerCase()} match these filters`
              : onLater
                ? 'No more rows'
                : `No ${spec.title.toLowerCase()} yet`
          }
        >
          {filtered
            ? 'Clear the filters to see everything for this merchant.'
            : onLater
              ? 'This page is past the end of the list. Go back to the first page.'
              : 'Rows appear here as soon as the merchant has any. This is a successful read, not an error.'}
        </StateBlock>
      ) : (
        <RowsTable cols={cols} rows={rows} caption={spec.title} rowKey={(_r, i) => `${section}-${i}`} />
      )}
      <Pager path={path} query={query} cursorParam={cursorKey(section)} nextCursor={page.nextCursor} />
    </>,
    <CsvButton csv={csv} filename={`${section}.csv`} count={rows.length} />,
  );
}

/** One tile per list on the page: how many rows this page holds, and whether there is more. Never a total the service did not give. */
export function SectionKpis({
  sections,
  results,
}: {
  sections: readonly FounderMerchantSection[];
  results: Partial<Record<FounderMerchantSection, PayCallResult<FounderMerchantSectionPage>>>;
}) {
  return (
    <div className="mp-kpis" role="group" aria-label="Lists on this page">
      {sections.map((section) => {
        const r = results[section];
        const ok = r?.kind === 'ok' ? r.data : null;
        const catalog = ok !== null && 'catalog' in ok;
        const profile: ProfilePage | null = ok !== null && 'current' in ok ? ok : null;
        const rows = ok && !catalog ? ok.items.length : null;
        return (
          <KpiTile
            key={section}
            label={SECTION_SPECS[section].kpiLabel ?? SECTION_SPECS[section].title}
            value={
              catalog ? (
                <span className="mp-muted">Not in pay service</span>
              ) : profile ? (
                <span className="mp-num">{statusChip(profile.current.kybStatus).label}</span>
              ) : rows === null ? (
                <span className="mp-muted">Unavailable</span>
              ) : (
                <span className="mp-num">{rows}</span>
              )
            }
            period={
              profile
                ? 'KYB status now'
                : ok && !catalog
                  ? `Rows on this page${ok.nextCursor ? ' · more pages' : ' · end of list'}`
                  : 'Could not be read'
            }
            href={`#${section}`}
          />
        );
      })}
    </div>
  );
}
