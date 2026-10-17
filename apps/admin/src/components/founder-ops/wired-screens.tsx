import type { ReactNode } from 'react';
import { Chip } from '@/components/chip';
import { CopyButton } from '@/components/merchants/copy-button';
import { CsvButton } from '@/components/merchants/csv-button';
import { AsOf, Card, FailureState, KpiTile, MoneyText, shortId, StateBlock, StatusChip, Amounts } from '@/components/merchants/ui';
import { kybStatusChip, merchantStatusChip } from '@/lib/merchants/chips';
import { buildCsv } from '@/lib/merchants/csv';
import { sumByAsset } from '@/lib/merchants/money';
import { formatUtc } from '@/lib/merchants/time';
import type { OpsData } from '@/lib/founder-ops/loaders';
import {
  countOf,
  formatAge,
  hrefWith,
  one,
  PAGE_LIMIT,
  RISK_TOP_N,
  RISK_WINDOWS,
  shareAsPercent,
  statusChip,
  totalOf,
  type Query,
} from '@/lib/founder-ops/read-model';
import { DISPUTE_STATUSES, PAYOUT_STATUSES } from '@/lib/founder-ops/reads';
import { ListFilters, Pager, RowsTable } from './section-panels';

/**
 * The five founder-wide pages that #4870 now feeds: live counters (F02), risk (F03), recent merchants (F05), disputes (F32) and
 * payouts (F37). Every number is what the service returned; the only arithmetic is integer addition of counts and exact
 * per-asset addition of decimal strings, both labelled "on this page" where they cover one page.
 */

const when = (iso: string | null): ReactNode =>
  iso === null ? <span className="mp-muted">—</span> : <time dateTime={iso}>{formatUtc(iso)}</time>;
const merchantLink = (merchantId: string): ReactNode => (
  <a className="mp-id" href={`/merchants/${merchantId}`} title={merchantId}>
    <code>{shortId(merchantId)}</code>
  </a>
);

// ── F02 Live monitor ─────────────────────────────────────────────────────────

const KINDS = [
  ['payments', 'Payments'],
  ['payouts', 'Payouts'],
  ['refunds', 'Refunds'],
] as const;

export function LiveView({ data, path }: { data: OpsData; path: string }) {
  const live = data.live;
  if (!live) return null;
  if (live.kind !== 'ok') return <FailureState failure={live} what="The live counters" retryHref={path} />;
  const s = live.data;
  const windows = [
    ['h1', 'Last hour', s.h1],
    ['h24', 'Last 24 hours', s.h24],
  ] as const;
  return (
    <>
      <AsOf freshness={{ asOf: s.asOf, lagSeconds: 0 }} label="Live counters" />
      <div className="mp-kpis" role="group" aria-label="Live counters">
        <KpiTile
          label="Payments, last hour"
          value={<span className="mp-num">{totalOf(s.h1.payments)}</span>}
          period="Created in the last 60 minutes"
          href="#h1"
        />
        <KpiTile
          label="Payments failed, last hour"
          value={<span className="mp-num">{countOf(s.h1.payments, 'failed')}</span>}
          period="Created in the last 60 minutes"
          href="#h1"
        />
        <KpiTile
          label="Payouts, last 24 hours"
          value={<span className="mp-num">{totalOf(s.h24.payouts)}</span>}
          period="All states"
          href="#h24"
        />
        <KpiTile
          label="Oldest payout approval waiting"
          value={<span className="mp-num">{formatAge(s.queues.oldestPendingApprovalAgeSeconds)}</span>}
          period="Age at the time of the read"
          href="#queues"
        />
        <KpiTile
          label="Oldest payout pending"
          value={<span className="mp-num">{formatAge(s.queues.oldestPendingPayoutAgeSeconds)}</span>}
          period="Age at the time of the read"
          href="#queues"
        />
        <KpiTile
          label="Earliest dispute deadline"
          value={
            s.queues.earliestDisputeDeadlineAt ? (
              when(s.queues.earliestDisputeDeadlineAt)
            ) : (
              <span className="mp-muted">No deadline set</span>
            )
          }
          period="Open disputes with a rail deadline"
          href="/disputes"
        />
      </div>
      {windows.map(([id, label, counts]) => (
        <Card
          key={id}
          id={id}
          title={`Money flow, ${label.toLowerCase()}`}
          sub="Counts by state, created in this window. A state with no rows is left out, not shown as zero."
        >
          <div className="mp-scroll" tabIndex={0} role="region" aria-label={`${label} counts, scrolls sideways on small screens`}>
            <table className="mp-table">
              <caption className="mp-visually-hidden">{label} counts by state</caption>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col" className="mp-right">
                    Total
                  </th>
                  <th scope="col">By state</th>
                </tr>
              </thead>
              <tbody>
                {KINDS.map(([kind, name]) => (
                  <tr key={kind}>
                    <th scope="row">{name}</th>
                    <td className="mp-right mp-num">{totalOf(counts[kind])}</td>
                    <td>
                      {counts[kind].length === 0 ? (
                        <span className="mp-muted">None in this window</span>
                      ) : (
                        <span className="mp-inline">
                          {counts[kind].map((c) => (
                            <span key={c.status} className="mp-inline">
                              <StatusChip spec={statusChip(c.status)} /> <span className="mp-num">{c.count}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      <Card id="queues" title="Queue ages" sub="How long the oldest item has been waiting, and since when.">
        <dl className="mp-facts">
          <div>
            <dt className="mp-facts__k">Oldest payout approval waiting</dt>
            <dd className="mp-facts__v">
              {when(s.queues.oldestPendingApprovalAt)} · {formatAge(s.queues.oldestPendingApprovalAgeSeconds)}{' '}
              {s.queues.oldestPendingApprovalAt ? <a href="/merchants/approvals">Open approvals</a> : null}
            </dd>
          </div>
          <div>
            <dt className="mp-facts__k">Oldest payout pending</dt>
            <dd className="mp-facts__v">
              {when(s.queues.oldestPendingPayoutAt)} · {formatAge(s.queues.oldestPendingPayoutAgeSeconds)}{' '}
              {s.queues.oldestPendingPayoutAt ? <a href="/payouts?status=pending">Open pending payouts</a> : null}
            </dd>
          </div>
          <div>
            <dt className="mp-facts__k">Earliest dispute deadline</dt>
            <dd className="mp-facts__v">{when(s.queues.earliestDisputeDeadlineAt)}</dd>
          </div>
        </dl>
      </Card>
      <StateBlock kind="not_built" title="Event stream and pipeline counters not in the live summary yet">
        The live summary counts payments, payouts and refunds by state. It does not carry the event stream, duplicate markers, ledger-posted
        counts, conversions or webhook deliveries, so none of those are shown and none are estimated.
      </StateBlock>
    </>
  );
}

// ── F03 Risk board ───────────────────────────────────────────────────────────

export function RiskView({ data, path }: { data: OpsData; path: string }) {
  const risk = data.risk;
  if (!risk) return null;
  const current = data.riskWindow ?? 'all';
  const pills = (
    <nav className="mp-pills" aria-label="Concentration window">
      {RISK_WINDOWS.map((w) => (
        <a key={w.key} href={`${path}?window=${w.key}`} aria-current={w.key === current ? 'true' : undefined}>
          {w.label}
        </a>
      ))}
    </nav>
  );
  if (risk.kind !== 'ok')
    return (
      <>
        {pills}
        <FailureState failure={risk} what="The risk summary" retryHref={`${path}?window=${current}`} />
      </>
    );
  const r = risk.data;
  const f = r.failedWorkflows;
  const through = r.projectedThrough;
  return (
    <>
      {pills}
      <div className="mp-asof" data-state={through === null ? 'unknown' : 'stale'} role="status">
        <span className="mp-asof__dot" aria-hidden="true" />
        <span>
          <strong>Concentration {through === null ? 'has no projected days' : `projected through ${through} (UTC)`}</strong> · It comes from
          the daily metrics projection, so it can lag the live ledger by up to a day. Treat it as possibly lagging, not as live. Showing the
          top {RISK_TOP_N} merchants per asset.
        </span>
      </div>
      <Card
        id="concentration"
        title="Merchant concentration"
        sub={`${r.window === null ? 'Every projected day' : r.window.kind === 'preset' ? r.window.preset.replace(/_/g, ' ') : 'Chosen range'}. Captured amounts per asset; a share is that merchant's part of the asset's total.`}
      >
        {r.concentration.length === 0 ? (
          <StateBlock kind="empty" title="No captured volume in the projection">
            Concentration appears once payments are captured and projected into the daily metrics. This is a successful read, not an error.
          </StateBlock>
        ) : (
          r.concentration.map((c) => (
            <section key={c.assetCode} aria-label={`${c.assetCode} concentration`} className="mp-block">
              <p>
                <strong>{c.assetCode}</strong> · total captured <MoneyText amount={c.totalCaptured} assetCode={c.assetCode} /> · top{' '}
                {c.merchants.length} hold{' '}
                {c.topShare === null ? (
                  <span className="mp-muted">no share (total is zero)</span>
                ) : (
                  <span className="mp-num" title="Exact fraction from the service">
                    {shareAsPercent(c.topShare) ?? '—'}% ({c.topShare})
                  </span>
                )}
              </p>
              <RowsTable
                caption={`${c.assetCode} top merchants`}
                rows={c.merchants}
                rowKey={(m) => m.merchantId}
                cols={[
                  { label: 'Merchant', text: (m) => m.merchantId, cell: (m) => merchantLink(m.merchantId) },
                  {
                    label: 'Captured',
                    right: true,
                    text: (m) => m.captured,
                    cell: (m) => <MoneyText amount={m.captured} assetCode={c.assetCode} />,
                  },
                  {
                    label: 'Share of total',
                    right: true,
                    text: (m) => m.share ?? '',
                    cell: (m) =>
                      m.share === null ? (
                        <span className="mp-muted">—</span>
                      ) : (
                        <span className="mp-num" title={`Exact fraction ${m.share}`}>
                          {shareAsPercent(m.share) ?? '—'}%
                        </span>
                      ),
                  },
                ]}
              />
            </section>
          ))
        )}
      </Card>
      <Card
        id="failed"
        title="Failed workflows"
        sub="Counts of everything that failed, over all time. They are not limited by the window above."
      >
        <div className="mp-kpis">
          <KpiTile label="Payments failed" value={<span className="mp-num">{f.paymentsFailed}</span>} period="All time" href="/payments" />
          <KpiTile
            label="Settlements failed"
            value={<span className="mp-num">{f.payoutsFailed}</span>}
            period="All time"
            href="/payouts?status=failed"
          />
          <KpiTile
            label="Refunds reversed"
            value={<span className="mp-num">{f.refundsReversed}</span>}
            period="All time"
            href="/payments"
          />
          <KpiTile
            label="Webhook deliveries failed"
            value={<span className="mp-num">{f.webhookDeliveriesFailed}</span>}
            period="All time, still retrying"
            href="/webhooks"
          />
          <KpiTile
            label="Webhook deliveries dead"
            value={<span className="mp-num">{f.webhookDeliveriesDead}</span>}
            period="All time, retries used up"
            href="/webhooks"
          />
          <KpiTile
            label="Exports failed"
            value={<span className="mp-num">{f.exportsFailed}</span>}
            period="All time"
            href="/merchants/all"
          />
        </div>
      </Card>
      <StateBlock kind="not_built" title="Risk thresholds and liquidity pressure not in the risk summary yet">
        No risk threshold has been agreed or stored, so no indicator says &quot;over the limit&quot;. Venue health and execution failures
        need the conversion readers, which are not built. Reserve and exposure per asset are in the treasury section below.
      </StateBlock>
    </>
  );
}

// ── F05 Merchants, newest first ──────────────────────────────────────────────

export function RecentMerchantsView({ data, path, query }: { data: OpsData; path: string; query: Query | undefined }) {
  const recent = data.recent;
  if (!recent) return null;
  if (recent.kind !== 'ok')
    return <FailureState failure={recent} what="Recently created merchants" retryHref={hrefWith(path, query, {})} />;
  const rows = recent.data.items;
  return (
    <Card
      id="recent"
      title="Recently created merchants"
      sub={`Newest first. ${rows.length} ${rows.length === 1 ? 'merchant' : 'merchants'} on this page${recent.data.nextCursor ? ', more on the next page' : ''}.`}
    >
      {rows.length === 0 ? (
        <StateBlock kind="empty" title={one(query, 'cursor') ? 'No more merchants' : 'No merchant has been created yet'}>
          Merchants show here as soon as one exists. This is a successful read, not an error.
        </StateBlock>
      ) : (
        <RowsTable
          caption="Recently created merchants"
          rows={rows}
          rowKey={(m) => m.merchantId}
          cols={[
            {
              label: 'Merchant',
              text: (m) => m.displayName ?? m.merchantId,
              cell: (m) => (
                <span className="mp-merchant">
                  <a className="mp-id" href={`/merchants/${m.merchantId}`}>
                    {m.displayName === null ? <span className="mp-muted">Unnamed merchant</span> : <bdi>{m.displayName}</bdi>}
                  </a>
                  <code className="mp-sub mp-merchant__id" title={m.merchantId}>
                    {shortId(m.merchantId)}
                  </code>{' '}
                  <CopyButton value={m.merchantId} label="Copy id" />
                </span>
              ),
            },
            {
              label: 'Legal name',
              text: (m) => m.legalName ?? '',
              cell: (m) => (m.legalName === null ? <span className="mp-muted">—</span> : <bdi>{m.legalName}</bdi>),
            },
            { label: 'Status', text: (m) => m.status, cell: (m) => <StatusChip spec={merchantStatusChip(m.status)} /> },
            { label: 'KYB', text: (m) => m.kybStatus, cell: (m) => <StatusChip spec={kybStatusChip(m.kybStatus)} /> },
            { label: 'Created', text: (m) => m.createdAt, cell: (m) => when(m.createdAt) },
          ]}
        />
      )}
      <Pager path={path} query={query} cursorParam="cursor" nextCursor={recent.data.nextCursor} />
    </Card>
  );
}

// ── F32 Disputes and F37 Payouts across merchants ───────────────────────────

function Filters({
  path,
  query,
  statuses,
  extra,
}: {
  path: string;
  query: Query | undefined;
  statuses: readonly string[];
  extra?: ReactNode;
}) {
  return (
    <>
      <ListFilters path={path} query={query} statusParam="status" statuses={statuses} extraDropKeys={['cursor']} label="List" />
      {extra ? <div className="mp-inline">{extra}</div> : null}
    </>
  );
}

export function DisputesView({ data, path, query }: { data: OpsData; path: string; query: Query | undefined }) {
  const disputes = data.disputes;
  if (!disputes) return null;
  const retry = hrefWith(path, query, {});
  const filtered = one(query, 'status') !== undefined || one(query, 'deadline') !== undefined;
  const deadline = one(query, 'deadline');
  const deadlinePills = (
    <nav className="mp-pills" aria-label="Response deadline">
      {[
        ['', 'Any deadline'],
        ['set', 'Has a deadline'],
        ['unset', 'No deadline'],
      ].map(([key, label]) => (
        <a
          key={key}
          href={hrefWith(path, query, { deadline: key || undefined, cursor: undefined })}
          aria-current={(deadline ?? '') === key ? 'true' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
  if (disputes.kind !== 'ok')
    return (
      <>
        <Filters path={path} query={query} statuses={DISPUTE_STATUSES} extra={deadlinePills} />
        <FailureState failure={disputes} what="The dispute list" retryHref={retry} />
      </>
    );
  const rows = disputes.data.items;
  const atRisk = sumByAsset(
    rows.filter((d) => d.status === 'open' || d.status === 'contested').map((d) => ({ assetCode: d.assetId, amount: d.amount })),
  );
  const due =
    rows
      .map((d) => d.responseDueAt)
      .filter((v): v is string => v !== null)
      .sort()[0] ?? null;
  const cols = [
    {
      label: 'Dispute',
      text: (d: (typeof rows)[number]) => d.disputeId,
      cell: (d: (typeof rows)[number]) => <code title={d.disputeId}>{shortId(d.disputeId)}</code>,
    },
    { label: 'Merchant', text: (d: (typeof rows)[number]) => d.merchantId, cell: (d: (typeof rows)[number]) => merchantLink(d.merchantId) },
    {
      label: 'Payment',
      text: (d: (typeof rows)[number]) => d.paymentId,
      cell: (d: (typeof rows)[number]) => <code title={d.paymentId}>{shortId(d.paymentId)}</code>,
    },
    {
      label: 'Amount',
      right: true,
      text: (d: (typeof rows)[number]) => `${d.amount} ${d.assetId}`,
      cell: (d: (typeof rows)[number]) => <MoneyText amount={d.amount} assetCode={d.assetId} />,
    },
    {
      label: 'Status',
      text: (d: (typeof rows)[number]) => d.status,
      cell: (d: (typeof rows)[number]) => <StatusChip spec={statusChip(d.status)} />,
    },
    {
      label: 'Reason',
      text: (d: (typeof rows)[number]) => d.reasonCode ?? '',
      cell: (d: (typeof rows)[number]) => d.reasonCode ?? <span className="mp-muted">—</span>,
    },
    {
      label: 'Response due',
      text: (d: (typeof rows)[number]) => d.responseDueAt ?? '',
      cell: (d: (typeof rows)[number]) =>
        d.responseDueAt ? (
          <>
            {when(d.responseDueAt)} <span className="mp-sub">from the rail</span>
          </>
        ) : (
          <span className="mp-muted" title="The rail has not sent a response deadline.">
            No deadline from the rail
          </span>
        ),
    },
    {
      label: 'Ledger',
      text: (d: (typeof rows)[number]) => (d.ledgerRefuseCode ? `${d.ledgerWire} (${d.ledgerRefuseCode})` : d.ledgerWire),
      cell: (d: (typeof rows)[number]) =>
        d.ledgerWire === 'posted' ? (
          <StatusChip spec={statusChip('posted')} />
        ) : (
          <Chip tone="danger" title="The ledger refused the chargeback posting.">
            refused{d.ledgerRefuseCode ? ` · ${d.ledgerRefuseCode}` : ''}
          </Chip>
        ),
    },
    { label: 'Opened', text: (d: (typeof rows)[number]) => d.openedAt, cell: (d: (typeof rows)[number]) => when(d.openedAt) },
  ];
  const csv = buildCsv({
    header: cols.map((c) => c.label),
    rows: rows.map((d) => cols.map((c) => c.text(d))),
    generatedAt: data.readAt,
    asOf: data.readAt,
    note: `${data.testData ? 'TEST DATA. ' : ''}Disputes across merchants: this page only, up to ${PAGE_LIMIT} rows${filtered ? ', filtered' : ''}.`,
  });
  return (
    <>
      <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Dispute list" />
      <div className="mp-kpis" role="group" aria-label="Disputes on this page">
        <KpiTile
          label="Disputes on this page"
          value={<span className="mp-num">{rows.length}</span>}
          period={disputes.data.nextCursor ? 'More on the next page' : 'End of list'}
          href="#records"
        />
        <KpiTile
          label="Open or contested"
          value={<span className="mp-num">{rows.filter((d) => d.status === 'open' || d.status === 'contested').length}</span>}
          period="On this page"
          href="#records"
        />
        <KpiTile
          label="Amount at risk"
          value={<Amounts rows={atRisk.totals} empty="None" />}
          period="Open or contested, on this page"
          href="#records"
        />
        <KpiTile
          label="Soonest response due"
          value={due ? when(due) : <span className="mp-muted">None on this page</span>}
          period="On this page"
          href="#records"
        />
      </div>
      <Filters path={path} query={query} statuses={DISPUTE_STATUSES} extra={deadlinePills} />
      <Card
        id="records"
        title="Disputes across merchants"
        sub="Server paged. The rail's response deadline is shown when it sent one."
        actions={<CsvButton csv={csv} filename="disputes.csv" count={rows.length} />}
      >
        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            title={filtered ? 'No dispute matches these filters' : one(query, 'cursor') ? 'No more disputes' : 'No dispute has been opened'}
          >
            {filtered
              ? 'Clear the filters to see every dispute.'
              : 'A dispute appears here when a rail reports one. This is a successful read, not an error.'}
          </StateBlock>
        ) : (
          <RowsTable caption="Disputes across merchants" cols={cols} rows={rows} rowKey={(d) => `${d.merchantId}-${d.disputeId}`} />
        )}
        <Pager path={path} query={query} cursorParam="cursor" nextCursor={disputes.data.nextCursor} />
      </Card>
    </>
  );
}

export function PayoutsView({ data, path, query }: { data: OpsData; path: string; query: Query | undefined }) {
  const payouts = data.payouts;
  if (!payouts) return null;
  const retry = hrefWith(path, query, {});
  const filtered = one(query, 'status') !== undefined;
  if (payouts.kind !== 'ok')
    return (
      <>
        <Filters path={path} query={query} statuses={PAYOUT_STATUSES} />
        <FailureState failure={payouts} what="The payout list" retryHref={retry} />
      </>
    );
  const rows = payouts.data.items;
  const net = sumByAsset(rows.map((p) => ({ assetCode: p.assetId, amount: p.net })));
  type Row = (typeof rows)[number];
  const cols = [
    { label: 'Payout', text: (p: Row) => p.id, cell: (p: Row) => <code title={p.id}>{shortId(p.id)}</code> },
    { label: 'Merchant', text: (p: Row) => p.merchantId, cell: (p: Row) => merchantLink(p.merchantId) },
    { label: 'Window', text: (p: Row) => p.window },
    {
      label: 'Gross',
      right: true,
      text: (p: Row) => `${p.gross} ${p.assetId}`,
      cell: (p: Row) => <MoneyText amount={p.gross} assetCode={p.assetId} />,
    },
    {
      label: 'Fees',
      right: true,
      text: (p: Row) => `${p.fees} ${p.assetId}`,
      cell: (p: Row) => <MoneyText amount={p.fees} assetCode={p.assetId} />,
    },
    {
      label: 'Net',
      right: true,
      text: (p: Row) => `${p.net} ${p.assetId}`,
      cell: (p: Row) => <MoneyText amount={p.net} assetCode={p.assetId} />,
    },
    { label: 'Status', text: (p: Row) => p.status, cell: (p: Row) => <StatusChip spec={statusChip(p.status)} /> },
    { label: 'Method', text: (p: Row) => p.payoutMethod ?? '', cell: (p: Row) => p.payoutMethod ?? <span className="mp-muted">—</span> },
    {
      label: 'Reference',
      text: (p: Row) => p.payoutReference ?? '',
      cell: (p: Row) => p.payoutReference ?? <span className="mp-muted">—</span>,
    },
    { label: 'Created', text: (p: Row) => p.createdAt, cell: (p: Row) => when(p.createdAt) },
  ];
  const csv = buildCsv({
    header: cols.map((c) => c.label),
    rows: rows.map((p) => cols.map((c) => c.text(p))),
    generatedAt: data.readAt,
    asOf: data.readAt,
    note: `${data.testData ? 'TEST DATA. ' : ''}Payouts across merchants: this page only, up to ${PAGE_LIMIT} rows${filtered ? ', filtered' : ''}.`,
  });
  return (
    <>
      <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Payout list" />
      <div className="mp-kpis" role="group" aria-label="Payouts on this page">
        <KpiTile
          label="Payouts on this page"
          value={<span className="mp-num">{rows.length}</span>}
          period={payouts.data.nextCursor ? 'More on the next page' : 'End of list'}
          href="#records"
        />
        <KpiTile
          label="Pending or posted"
          value={<span className="mp-num">{rows.filter((p) => p.status === 'pending' || p.status === 'posted').length}</span>}
          period="On this page"
          href="#records"
        />
        <KpiTile
          label="Failed"
          value={<span className="mp-num">{rows.filter((p) => p.status === 'failed').length}</span>}
          period="On this page"
          href="/payouts?status=failed"
        />
        <KpiTile label="Net amount" value={<Amounts rows={net.totals} empty="None" />} period="Every state, on this page" href="#records" />
      </div>
      <Filters path={path} query={query} statuses={PAYOUT_STATUSES} />
      <Card
        id="records"
        title="Payouts across merchants"
        sub="Server paged, newest first."
        actions={<CsvButton csv={csv} filename="payouts.csv" count={rows.length} />}
      >
        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            title={filtered ? 'No payout matches this status' : one(query, 'cursor') ? 'No more payouts' : 'No payout yet'}
          >
            {filtered
              ? 'Clear the filter to see every payout.'
              : 'Payouts appear here after the first settlement. This is a successful read, not an error.'}
          </StateBlock>
        ) : (
          <RowsTable caption="Payouts across merchants" cols={cols} rows={rows} rowKey={(p) => p.id} />
        )}
        <Pager path={path} query={query} cursorParam="cursor" nextCursor={payouts.data.nextCursor} />
        <p className="mp-footnote mp-mt">
          This list shows the settlement and its payout method. The two-founder approval state and the masked destination of a payout are on
          the <a href="/merchants/approvals">approvals queue</a> and on each merchant&apos;s payouts page.
        </p>
      </Card>
    </>
  );
}
