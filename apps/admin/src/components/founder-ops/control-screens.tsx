import type { ReactNode } from 'react';
import type { FounderApprovalQueueItem, PayCap } from '@intafaced/contracts';
import { CopyButton } from '@/components/merchants/copy-button';
import { CsvButton } from '@/components/merchants/csv-button';
import { AsOf, Card, FailureState, KpiTile, MoneyText, shortId, StateBlock, StatusChip } from '@/components/merchants/ui';
import { payoutApprovalChip } from '@/lib/merchants/chips';
import { CAP_LABEL, ageView, bpsText, ttlText, type TierView } from '@/lib/merchants/control-model';
import { buildCsv } from '@/lib/merchants/csv';
import { formatMoney } from '@/lib/merchants/money';
import type { PayFailure } from '@/lib/merchants/pay-call';
import { formatUtc } from '@/lib/merchants/time';
import { auditFilterOf, hasAuditFilter, jsonPreview } from '@/lib/founder-ops/control-model';
import type { OpsData } from '@/lib/founder-ops/loaders';
import { hrefWith, one, PAGE_LIMIT, statusChip, type Query } from '@/lib/founder-ops/read-model';
import { Pager, RowsTable } from './section-panels';

/**
 * Founder pages on the control-room reads: one approval (F25), tiers (F54), limit requests (F58) and activity and audit (F64).
 * Every amount is the decimal string the service returned. A destination is only ever the masked form. A failed read is a named
 * state with Try again, never an empty list.
 */

const when = (iso: string | null): ReactNode =>
  iso === null ? <span className="mp-muted">—</span> : <time dateTime={iso}>{formatUtc(iso)}</time>;
const dash = <span className="mp-muted">—</span>;
const merchantLink = (merchantId: string): ReactNode => (
  <a className="mp-id" href={`/merchants/${merchantId}`} title={merchantId}>
    <code>{shortId(merchantId)}</code>
  </a>
);
const idCell = (id: string): ReactNode => (
  <code className="mp-sub" title={id}>
    {shortId(id)}
  </code>
);

/** A failed read in plain English. A procedure that is switched off is named by what it feeds, never by its internal name. */
export function ReadFailure({ failure, what, retryHref }: { failure: PayFailure; what: string; retryHref: string }) {
  if (failure.kind === 'not_built')
    return (
      <StateBlock
        kind="not_built"
        title="Not switched on in this deployment"
        requestId={failure.requestId}
        action={
          <a className="mp-btn" href={retryHref}>
            Try again
          </a>
        }
      >
        {what} comes from a service read that is not switched on here. Nothing is shown rather than a made-up number.
      </StateBlock>
    );
  return <FailureState failure={failure} what={what} retryHref={retryHref} />;
}

// ── F25 Approval detail ──────────────────────────────────────────────────────

function ApprovalCards({ a, now, readAt }: { a: FounderApprovalQueueItem; now: Date; readAt: string }) {
  const { age, expiry } = ageView(a.createdAt, a.expiresAt, now);
  return (
    <>
      <AsOf freshness={{ asOf: readAt, lagSeconds: 0 }} label="Approval" />
      <Card id="payout" title="Requested payout" sub="Read from the queue of payouts waiting for two founders.">
        <dl className="mp-facts">
          <div>
            <dt className="mp-facts__k">Amount</dt>
            <dd className="mp-facts__v">
              <MoneyText amount={a.amount} assetCode={a.assetCode} />
            </dd>
          </div>
          <div>
            <dt className="mp-facts__k">Status</dt>
            <dd className="mp-facts__v">
              <StatusChip spec={payoutApprovalChip(a.status)} /> <span className="mp-sub">needs two founders</span>
            </dd>
          </div>
          <div>
            <dt className="mp-facts__k">Merchant</dt>
            <dd className="mp-facts__v">
              {merchantLink(a.merchantId)} <a href={`/merchants/${a.merchantId}?tab=approvals`}>Open merchant approvals</a>
            </dd>
          </div>
          <div>
            <dt className="mp-facts__k">Settlement</dt>
            <dd className="mp-facts__v">
              <code title={a.settlementId}>{shortId(a.settlementId)}</code> <CopyButton value={a.settlementId} label="Copy settlement id" />
            </dd>
          </div>
        </dl>
      </Card>
      <Card id="people" title="Maker and checker" sub="Neither the person who asked nor the merchant’s own approver may sign as a founder.">
        <dl className="mp-facts">
          <div>
            <dt className="mp-facts__k">Asked by (maker)</dt>
            <dd className="mp-facts__v">
              <code title={a.makerUserId}>{a.makerUserId}</code>
            </dd>
          </div>
          <div>
            <dt className="mp-facts__k">Merchant’s approver (checker)</dt>
            <dd className="mp-facts__v">{a.checkerUserId ? <code title={a.checkerUserId}>{a.checkerUserId}</code> : 'Not recorded'}</dd>
          </div>
          <div>
            <dt className="mp-facts__k">First founder to sign</dt>
            <dd className="mp-facts__v">
              {a.founderFirstUserId ? <code title={a.founderFirstUserId}>{a.founderFirstUserId}</code> : 'No founder has signed yet'}
            </dd>
          </div>
        </dl>
      </Card>
      <Card id="destination" title="Destination" sub="Only the masked form is shown on this page.">
        <dl className="mp-facts">
          <div>
            <dt className="mp-facts__k">Rail</dt>
            <dd className="mp-facts__v">{a.railId}</dd>
          </div>
          <div>
            <dt className="mp-facts__k">Kind</dt>
            <dd className="mp-facts__v">{a.destinationKind}</dd>
          </div>
          <div>
            <dt className="mp-facts__k">Destination</dt>
            <dd className="mp-facts__v">
              <code>{a.destinationMasked}</code>
            </dd>
          </div>
        </dl>
      </Card>
      <Card
        id="timeline"
        title="Timeline and hash"
        sub="A decision is bound to this exact payload hash. If the payout changes, the approval is void."
      >
        <ol className="mp-timeline">
          <li>
            Requested · {when(a.createdAt)} <span className="mp-sub">{age}</span>
          </li>
          <li>
            Expires · {when(a.expiresAt)} <StatusChip spec={{ label: expiry.label, tone: expiry.tone, hint: expiry.hint }} />
          </li>
          <li>Decided · {a.decidedAt ? when(a.decidedAt) : <span className="mp-muted">Not decided</span>}</li>
        </ol>
        <p>
          Payload hash <code>{a.payloadHash}</code> <CopyButton value={a.payloadHash} label="Copy payload hash" />
        </p>
        <a className="mp-btn mp-btn--primary" href="/merchants/approvals">
          Open the decision queue
        </a>
      </Card>
    </>
  );
}

export function ApprovalDetailView({
  data,
  path,
  resourceId,
  gap,
}: {
  data: OpsData;
  path: string;
  resourceId: string | undefined;
  gap: string;
}) {
  const queue = data.approvals;
  if (!queue) return null;
  if (queue.kind !== 'ok') return <ReadFailure failure={queue} what="This approval" retryHref={path} />;
  const wanted = resourceId?.toLowerCase();
  const approval = queue.data.approvals.find((a) => a.approvalId.toLowerCase() === wanted);
  return (
    <>
      {approval ? (
        <ApprovalCards a={approval} now={new Date(data.readAt)} readAt={data.readAt} />
      ) : (
        <StateBlock
          kind="empty"
          title="This approval is not waiting for founders"
          action={
            <a className="mp-btn" href="/merchants/approvals">
              Open the decision queue
            </a>
          }
        >
          {queue.data.truncated
            ? 'It is not in the part of the queue this page reads, and the queue is longer than that part.'
            : 'It may already be decided, may have expired, or the reference does not match a payout that needs founders.'}{' '}
          Nothing is inferred about it.
        </StateBlock>
      )}
      <StateBlock kind="info" title="Decision history of one approval">
        {gap}
      </StateBlock>
    </>
  );
}

// ── F54 Merchant tiers ───────────────────────────────────────────────────────

const capText = (cap: PayCap): string =>
  cap.kind === 'beneficiaries_per_day'
    ? `${CAP_LABEL[cap.kind]}: ${cap.limit}`
    : `${CAP_LABEL[cap.kind]}: ${formatMoney(cap.limit, cap.assetCode)}`;
const reserveText = (r: TierView['reserve']): string =>
  r === null || (r.rollingReserveBps === null && r.holdDays === null)
    ? 'No rolling reserve'
    : `${r.rollingReserveBps === null ? 'No percentage' : bpsText(r.rollingReserveBps)} held ${
        r.holdDays === null ? 'for no set time' : `${r.holdDays} day${r.holdDays === 1 ? '' : 's'}`
      }`;
const thresholdText = (list: TierView['approvalThresholds']): string =>
  list.length === 0 ? 'None' : list.map((t) => `${formatMoney(t.amount, t.assetCode)} or more`).join(' · ');

export function TiersView({ data, path }: { data: OpsData; path: string }) {
  const tiers = data.tiers;
  if (!tiers) return null;
  if (tiers.kind !== 'ok') return <ReadFailure failure={tiers} what="The tier list" retryHref={path} />;
  const rows = [...tiers.data].sort((a, b) => a.id.localeCompare(b.id));
  const assigned = rows.reduce((sum, t) => sum + t.merchants, 0);
  const cols = [
    {
      label: 'Tier',
      text: (t: TierView) => `${t.name} (${t.id})`,
      cell: (t: TierView) => (
        <span className="mp-merchant">
          <strong>
            <bdi>{t.name}</bdi>
          </strong>
          <code className="mp-sub mp-merchant__id">{t.id}</code>
        </span>
      ),
    },
    { label: 'Archetype', text: (t: TierView) => t.archetype },
    {
      label: 'Merchants',
      right: true,
      text: (t: TierView) => String(t.merchants),
      cell: (t: TierView) => <span className="mp-num">{t.merchants}</span>,
    },
    {
      label: 'Caps',
      text: (t: TierView) => t.caps.map(capText).join('; '),
      cell: (t: TierView) => (
        <ul className="mp-list">
          {t.caps.map((c, i) => (
            <li key={i}>{capText(c)}</li>
          ))}
        </ul>
      ),
    },
    { label: 'Reserve', text: (t: TierView) => reserveText(t.reserve) },
    { label: 'Second team member from', text: (t: TierView) => thresholdText(t.approvalThresholds) },
    { label: 'Two founders from', text: (t: TierView) => thresholdText(t.founderThresholds) },
    { label: 'Approval valid for', text: (t: TierView) => ttlText(t.approvalTtlSeconds) },
    { label: 'Version', right: true, text: (t: TierView) => t.version },
  ];
  const csv = buildCsv({
    header: cols.map((c) => c.label),
    rows: rows.map((t) => cols.map((c) => c.text(t))),
    generatedAt: data.readAt,
    asOf: data.readAt,
    note: `${data.testData ? 'TEST DATA. ' : ''}Every tier definition, one read.`,
  });
  return (
    <>
      <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Tier list" />
      <div className="mp-kpis" role="group" aria-label="Tiers">
        <KpiTile
          label="Tiers defined"
          value={<span className="mp-num">{rows.length}</span>}
          period="Every tier, one read"
          href="#records"
        />
        <KpiTile
          label="Merchants on a tier"
          value={<span className="mp-num">{assigned}</span>}
          period="Counted by the service, per tier"
          href="#records"
        />
      </div>
      <Card
        id="records"
        title="Tier definitions"
        sub="Caps, reserve and approval thresholds as stored. The service returns every tier in one read, so this list has no pages."
        actions={<CsvButton csv={csv} filename="tiers.csv" count={rows.length} />}
      >
        {rows.length === 0 ? (
          <StateBlock kind="empty" title="No tier is defined">
            A tier appears here once a founder pair has created one. This is a successful read, not an error.
          </StateBlock>
        ) : (
          <RowsTable caption="Merchant tiers" cols={cols} rows={rows} rowKey={(t) => t.id} />
        )}
      </Card>
    </>
  );
}

// ── F58 Limit requests ───────────────────────────────────────────────────────

export function LimitRequestsView({ data, path, query }: { data: OpsData; path: string; query: Query | undefined }) {
  const result = data.limitRequests;
  if (!result) return null;
  if (result.kind !== 'ok') return <ReadFailure failure={result} what="The limit requests" retryHref={hrefWith(path, query, {})} />;
  const rows = result.data.requests;
  type Row = (typeof rows)[number];
  const capsText = (r: Row): string => (Array.isArray(r.caps) ? r.caps.map(capText).join('; ') : '');
  const merchants = new Set(rows.map((r) => r.merchantId)).size;
  const cols = [
    { label: 'Request', text: (r: Row) => r.requestId, cell: (r: Row) => idCell(r.requestId) },
    { label: 'Merchant', text: (r: Row) => r.merchantId, cell: (r: Row) => merchantLink(r.merchantId) },
    {
      label: 'Asking for',
      text: capsText,
      cell: (r: Row) =>
        Array.isArray(r.caps) ? (
          <ul className="mp-list">
            {r.caps.map((c, i) => (
              <li key={i}>{capText(c)}</li>
            ))}
          </ul>
        ) : (
          <span className="mp-muted">The stored caps could not be read</span>
        ),
    },
    { label: 'Reason', text: (r: Row) => r.reason, cell: (r: Row) => <bdi>{r.reason}</bdi> },
    { label: 'Asked by', text: (r: Row) => r.requestedBy, cell: (r: Row) => idCell(r.requestedBy) },
    { label: 'Asked at', text: (r: Row) => r.createdAt, cell: (r: Row) => when(r.createdAt) },
    {
      label: 'Compare',
      text: () => '',
      cell: (r: Row) => <a href={`/merchants/${r.merchantId}?tab=controls`}>Open Controls</a>,
    },
  ];
  const csv = buildCsv({
    header: cols.slice(0, -1).map((c) => c.label),
    rows: rows.map((r) => cols.slice(0, -1).map((c) => c.text(r))),
    generatedAt: data.readAt,
    asOf: data.readAt,
    note: `${data.testData ? 'TEST DATA. ' : ''}Open limit requests: this page only, up to ${PAGE_LIMIT} rows.`,
  });
  return (
    <>
      <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Limit requests" />
      <div className="mp-kpis" role="group" aria-label="Limit requests on this page">
        <KpiTile
          label="Open requests on this page"
          value={<span className="mp-num">{rows.length}</span>}
          period={result.data.nextCursor ? 'More on the next page' : 'End of list'}
          href="#records"
        />
        <KpiTile label="Merchants asking" value={<span className="mp-num">{merchants}</span>} period="On this page" href="#records" />
      </div>
      <Card
        id="records"
        title="Open limit requests"
        sub="Merchants asking for higher caps. Reading a request changes no cap; caps change only in a merchant’s Controls, with two founders."
        actions={<CsvButton csv={csv} filename="limit-requests.csv" count={rows.length} />}
      >
        {rows.length === 0 ? (
          <StateBlock kind="empty" title={one(query, 'cursor') ? 'No more requests' : 'No merchant is asking for higher limits'}>
            A request appears here when a merchant asks for higher caps and no founder has closed it. This is a successful read, not an
            error.
          </StateBlock>
        ) : (
          <RowsTable caption="Open limit requests" cols={cols} rows={rows} rowKey={(r) => r.requestId} />
        )}
        <Pager path={path} query={query} cursorParam="cursor" nextCursor={result.data.nextCursor} />
      </Card>
    </>
  );
}

// ── F64 Activity and audit ───────────────────────────────────────────────────

export function AuditView({ data, path, query, gap }: { data: OpsData; path: string; query: Query | undefined; gap: string }) {
  const filter = auditFilterOf(query);
  const filtered = hasAuditFilter(filter);
  const retry = hrefWith(path, query, {});
  const form = (
    <form className="mp-filters" method="get" action={path} aria-label="Audit filters">
      <div className="mp-field mp-field--grow">
        <label htmlFor="au-merchant">Merchant id</label>
        <input id="au-merchant" name="merchant" className="mp-input" defaultValue={filter.merchant} maxLength={64} autoComplete="off" />
      </div>
      <div className="mp-field">
        <label htmlFor="au-kind">Action</label>
        <input id="au-kind" name="kind" className="mp-input" defaultValue={filter.kind} maxLength={128} placeholder="Exact action name" />
      </div>
      <div className="mp-field">
        <label htmlFor="au-from">From (UTC)</label>
        <input id="au-from" name="from" type="date" className="mp-input" defaultValue={filter.from} />
      </div>
      <div className="mp-field">
        <label htmlFor="au-to">To (UTC)</label>
        <input id="au-to" name="to" type="date" className="mp-input" defaultValue={filter.to} />
      </div>
      <div className="mp-filters__actions">
        <button type="submit" className="mp-btn mp-btn--primary">
          Apply
        </button>
        {filtered ? (
          <a className="mp-btn" href={path}>
            Clear
          </a>
        ) : null}
      </div>
    </form>
  );
  if (data.auditErrors)
    return (
      <>
        {form}
        <StateBlock kind="error" title="These filters cannot be applied">
          {data.auditErrors.join(' ')} Nothing was read.
        </StateBlock>
      </>
    );
  const audit = data.audit;
  if (!audit) return null;
  if (audit.kind !== 'ok')
    return (
      <>
        {form}
        <ReadFailure failure={audit} what="The audit list" retryHref={retry} />
      </>
    );
  const rows = audit.data.entries;
  type Row = (typeof rows)[number];
  const beforeAfter = (r: Row): string =>
    r.before === null && r.after === null ? '' : `Before: ${jsonPreview(r.before) || 'none'}\nAfter: ${jsonPreview(r.after) || 'none'}`;
  const cols = [
    { label: 'When', text: (r: Row) => r.createdAt, cell: (r: Row) => when(r.createdAt) },
    {
      label: 'Action',
      text: (r: Row) => `${r.kind} (${r.scope} ${r.scopeId})`,
      cell: (r: Row) => (
        <span className="mp-merchant">
          <code>{r.kind}</code>
          <span className="mp-sub">
            {r.scope} · <span title={r.scopeId}>{shortId(r.scopeId)}</span>
          </span>
        </span>
      ),
    },
    { label: 'Merchant', text: (r: Row) => r.merchantId ?? '', cell: (r: Row) => (r.merchantId ? merchantLink(r.merchantId) : dash) },
    { label: 'Outcome', text: (r: Row) => r.outcome, cell: (r: Row) => <StatusChip spec={statusChip(r.outcome)} /> },
    { label: 'Actor', text: (r: Row) => r.actorId, cell: (r: Row) => idCell(r.actorId) },
    {
      label: 'Second approver',
      text: (r: Row) => r.secondActorId ?? '',
      cell: (r: Row) => (r.secondActorId ? idCell(r.secondActorId) : <span className="mp-muted">None</span>),
    },
    { label: 'Reason', text: (r: Row) => r.reason, cell: (r: Row) => <bdi>{r.reason}</bdi> },
    {
      label: 'Before / after',
      text: beforeAfter,
      cell: (r: Row) =>
        r.before === null && r.after === null ? (
          dash
        ) : (
          <details>
            <summary>Show</summary>
            <pre className="mp-pre">{beforeAfter(r)}</pre>
          </details>
        ),
    },
  ];
  const csv = buildCsv({
    header: cols.map((c) => c.label),
    rows: rows.map((r) => cols.map((c) => c.text(r))),
    generatedAt: data.readAt,
    asOf: data.readAt,
    note: `${data.testData ? 'TEST DATA. ' : ''}Control audit: this page only, up to ${PAGE_LIMIT} rows${filtered ? ', filtered' : ''}.`,
  });
  return (
    <>
      <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Audit list" />
      {form}
      <Card
        id="records"
        title="Control changes"
        sub="Append-only, newest first. Each row names who acted, who approved second, and what changed."
        actions={<CsvButton csv={csv} filename="control-audit.csv" count={rows.length} />}
      >
        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            title={
              filtered ? 'No entry matches these filters' : one(query, 'cursor') ? 'No more entries' : 'No control change has been recorded'
            }
          >
            {filtered ? 'Clear the filters to see every entry.' : 'This is a successful read, not an error.'}
          </StateBlock>
        ) : (
          <RowsTable caption="Control audit" cols={cols} rows={rows} rowKey={(r) => r.seq} />
        )}
        <Pager path={path} query={query} cursorParam="cursor" nextCursor={audit.data.nextCursor} />
        <p className="mp-footnote mp-mt">{gap}</p>
      </Card>
    </>
  );
}
