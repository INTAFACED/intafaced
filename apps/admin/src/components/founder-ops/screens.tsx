import type { PayoutApproval } from '@intafaced/contracts';
import type { FounderScreen } from '@/lib/founder-ops/screens';
import { DRILLDOWN } from '@/lib/founder-ops/screens';
import type { OpsData, FraudRow } from '@/lib/founder-ops/loaders';
import { AsOf, Card, FailureState, KpiTile, MoneyText, PageHead, StateBlock } from '@/components/merchants/ui';
import { CopyButton } from '@/components/merchants/copy-button';
import { CsvButton } from '@/components/merchants/csv-button';
import { buildCsv } from '@/lib/merchants/csv';
import { Chip } from '@/components/chip';
import { HaltHistoryTable, HaltStatesTable } from '@/components/merchants/halts-panels';
import { TreasuryView } from '@/components/merchants/treasury-view';
import { LiveRefresh } from './navigation';
import { MetricsCharts } from './metrics';
import './screens.css';

export function Arrives({ reason }: { reason: string }) {
  return (
    <StateBlock
      kind="not_built"
      title="Arrives with the next backend update"
      action={
        <a className="mp-btn" href="/merchants">
          Open available overview
        </a>
      }
    >
      {reason} No activity or amount is inferred from missing data.
    </StateBlock>
  );
}
export function FounderScreenView({
  screen,
  data,
  path,
  resourceId,
  merchantId,
  merchantFilter = '',
}: {
  screen: FounderScreen;
  data: OpsData;
  path: string;
  resourceId?: string | undefined;
  merchantId?: string | undefined;
  merchantFilter?: string | undefined;
}) {
  const isList = screen.type === 'LIST' || screen.type === 'QUEUE';
  const fraud = data.fraud?.kind === 'ok' ? data.fraud.data : null;
  const review = resourceId ? fraud?.find((r) => r.id === resourceId) : undefined;
  const approval = data.approvals?.kind === 'ok' ? data.approvals.data.approvals.find((a) => a.approvalId === resourceId) : undefined;
  return (
    <div className="mp-page" data-screen={screen.id}>
      <PageHead
        title={screen.title}
        purpose={screen.purpose}
        back={{ href: merchantId ? `/merchants/${merchantId}` : '/merchants', label: merchantId ? 'Merchant overview' : 'Global overview' }}
        actions={
          <a className="mp-btn mp-btn--primary" href={path}>
            Refresh
          </a>
        }
      />
      {merchantId ? (
        <>
          <div className="mp-facts">
            <span>
              Merchant <code>{merchantId}</code> <CopyButton value={merchantId} label="Copy merchant id" />
            </span>
            <Chip tone="warn" title="Restricted founder context; these fields are not visible to the merchant.">
              Operator only · not visible to merchant
            </Chip>
          </div>
          <nav className="mp-tabs" aria-label="Merchant drilldown sections">
            <a href={`/merchants/${merchantId}`}>Overview</a>
            {DRILLDOWN.map((r) => (
              <a key={r[1]} href={`/merchants/${merchantId}/${r[1]}`} aria-current={screen.id === r[0] ? 'page' : undefined}>
                {r[2]}
              </a>
            ))}
            {['controls', 'approvals', 'halts'].map((tab) => (
              <a key={tab} href={`/merchants/${merchantId}?tab=${tab}`}>
                {tab}
              </a>
            ))}
          </nav>
        </>
      ) : null}
      {resourceId ? (
        <div className="mp-facts">
          <span>
            Requested reference <code>{resourceId}</code> <CopyButton value={resourceId} label="Copy reference" />
          </span>
          <span className="mp-muted">Reference supplied in the URL; existence is not verified unless a record appears below.</span>
        </div>
      ) : null}
      {screen.id === 'F02' ? <LiveRefresh readAt={data.readAt} /> : null}
      {data.fraud && data.fraud.kind !== 'ok' ? <FailureState failure={data.fraud} what="Open fraud reviews" retryHref={path} /> : null}
      {fraud && !resourceId ? (
        <FraudQueue rows={fraud} readAt={data.readAt} merchantFilter={merchantFilter} testData={data.testData ?? false} />
      ) : null}
      {data.approvals && data.approvals.kind !== 'ok' ? (
        <FailureState failure={data.approvals} what="Approval context" retryHref={path} />
      ) : null}
      {approval ? <ApprovalFacts approval={approval} /> : null}
      {review ? <FraudDetail row={review} /> : null}
      {fraud && resourceId && !review ? (
        <StateBlock kind="empty" title="Review unavailable">
          This review was not found in the bounded open queue. It may be closed or outside this read. No decision is available here.
        </StateBlock>
      ) : null}
      {screen.id === 'F73' ? <FounderAccess data={data} path={path} /> : null}
      {data.metrics ? <MetricsCharts data={data.metrics} path={path} /> : null}
      {data.treasury ? (
        screen.id === 'F03' || screen.id === 'F51' ? (
          <TreasuryView data={data.treasury} showHeader={false} />
        ) : (
          <>
            <Card title="Halts in force" sub="Current store state; an unreadable store never means operations are running.">
              <AsOf freshness={{ asOf: data.treasury.readAt, lagSeconds: 0 }} label="Halt read" />
              {data.treasury.status.kind === 'ok' ? (
                <>
                  {!data.treasury.status.data.readable ? (
                    <StateBlock kind="error" title="Halt store unreadable">
                      Treat money operations as paused until the store can be verified.
                    </StateBlock>
                  ) : null}
                  <HaltStatesTable states={data.treasury.status.data.states} caption="Current halt switches" />
                </>
              ) : (
                <FailureState failure={data.treasury.status} what="Halt state" retryHref={path} />
              )}
            </Card>
            {screen.id === 'F61' ? (
              <Card title="Recent halt events">
                {data.treasury.halts.kind === 'ok' ? (
                  <HaltHistoryTable events={data.treasury.halts.data} />
                ) : (
                  <FailureState failure={data.treasury.halts} what="Halt history" retryHref={path} />
                )}
              </Card>
            ) : null}
          </>
        )
      ) : null}
      <Arrives reason={screen.gap} />
      {screen.id === 'F65' ? (
        <StateBlock kind="info" title="Enabling is configuration only">
          No enable control is provided. Licence attestation, a bank rail and matched bank-statement reconciliation must be verified before
          bank-settled intake can be used. Runtime flag state: not available.
        </StateBlock>
      ) : null}
      {screen.id.startsWith('F6') && ['F66', 'F67', 'F68'].includes(screen.id) ? (
        <StateBlock kind="info" title="TEST DATA only">
          Synthetic PSP, broker and gaming presets are sandbox scenarios, not operating merchants. Iteration cap: unavailable. No run is
          launched here.
        </StateBlock>
      ) : null}
      {isList && screen.id !== 'F30' && screen.id !== 'F73' ? (
        <>
          <div className="mp-kpis">
            {screen.sections.slice(0, 4).map((label) => (
              <KpiTile
                key={label}
                label={label}
                value="Unavailable"
                period="Requested reporting period"
                href="#records"
                note="No verified aggregate"
              />
            ))}
          </div>
          <Card
            id="records"
            title={`${screen.title} records`}
            sub="Row count unavailable. Search, server filters, pagination and export arrive with the list reader."
            actions={
              <button className="mp-btn" disabled title="No authoritative filtered list is available to export.">
                Export CSV unavailable
              </button>
            }
          >
            <fieldset disabled className="fo-filters">
              <legend>Search and filters · awaiting backend</legend>
              <label className="mp-field">
                Search
                <input className="mp-input" placeholder="ID or reference" />
              </label>
              <label className="mp-field">
                Status
                <select className="mp-input">
                  <option>All statuses</option>
                </select>
              </label>
              <label className="mp-field">
                Asset
                <input className="mp-input" placeholder="All assets" />
              </label>
              <label className="mp-field">
                From
                <input className="mp-input" type="date" />
              </label>
              <label className="mp-field">
                To
                <input className="mp-input" type="date" />
              </label>
            </fieldset>
            <div className="mp-tablewrap">
              <table className="mp-table">
                <thead>
                  <tr>
                    {screen.sections.map((s) => (
                      <th key={s} scope="col">
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={screen.sections.length}>Records cannot be read yet. This is not an empty queue.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
      {!isList && !data.metrics && !data.treasury && !fraud && !data.approvals ? (
        <div className="fo-sections">
          {screen.sections.map((title) => (
            <Card key={title} title={title}>
              <p className="mp-muted">Not available from the current backend.</p>
            </Card>
          ))}
        </div>
      ) : null}
      {screen.type === 'DASH' && !data.metrics ? (
        <Card title="Daily volume and count" sub="Charts need verified series; gaps are never rendered as zeros.">
          <nav className="mp-pills" aria-label="Reporting periods">
            {['Today', '7d', '30d', 'Lifetime'].map((s) => (
              <span className="mp-muted" key={s}>
                {s} · unavailable
              </span>
            ))}
          </nav>
          <p className="mp-footnote">Table fallback and per-asset series arrive with the analytics reader.</p>
        </Card>
      ) : null}
      {['FORM', 'CONFIG', 'DETAIL'].includes(screen.type) ? (
        <Card
          title="Change review and audit"
          sub="No change can be submitted from this screen until the required reads and approval context are available."
        >
          <p className="mp-muted">
            Last changed by: unavailable. Before / after, reason, actor and second approver must come from the immutable history.
          </p>
          <span title={screen.gap}>
            <button className="mp-btn" disabled>
              {screen.action === 'Refresh' ? 'Change unavailable' : screen.action}
            </button>
          </span>
          {merchantId ? (
            <a className="mp-btn" href={`/merchants/${merchantId}?tab=controls`}>
              Open existing Controls
            </a>
          ) : (
            <a className="mp-btn" href="/merchants/approvals">
              Open existing approvals
            </a>
          )}
        </Card>
      ) : null}
      <p className="mp-footnote">
        As of: unavailable for unbuilt projections. Snapshot request: <time dateTime={data.readAt}>{data.readAt}</time>. Unknown freshness
        is never displayed as live. Missing thresholds stay not configured.
      </p>
    </div>
  );
}
function FraudQueue({
  rows,
  readAt,
  merchantFilter,
  testData,
}: {
  rows: FraudRow[];
  readAt: string;
  merchantFilter: string;
  testData: boolean;
}) {
  const csv = buildCsv({
    header: ['Review', 'Merchant', 'Payment', 'Amount', 'Asset', 'Status', 'Created at'],
    rows: rows.map((r) => [r.id, r.merchantId, r.paymentId ?? '', r.amount, r.assetId, r.status, r.createdAt]),
    generatedAt: readAt,
    asOf: readAt,
    note: `${testData ? 'TEST DATA. ' : ''}Bounded process-local open review snapshot, up to 100 rows. Not a global aggregate.`,
  });
  return (
    <>
      <AsOf freshness={{ asOf: readAt, lagSeconds: null }} label="Queue snapshot" />
      <div className="mp-kpis">
        <KpiTile label="Open reviews read" value={rows.length} period="Current bounded snapshot" href="#fraud-records" />
        <KpiTile label="Read cap" value="100 rows" period="This request" href="#fraud-records" />
        <KpiTile
          label="Oldest loaded"
          value={rows.length ? rows.reduce((a, r) => (a < r.createdAt ? a : r.createdAt), rows[0]!.createdAt).slice(0, 10) : 'None loaded'}
          period="Loaded rows only"
          href="#fraud-records"
        />
        <KpiTile label="SLA policy" value="Not configured" period="No SLA read" href="#fraud-records" />
      </div>
      <form className="mp-filters" method="get" action="/fraud">
        <label className="mp-field">
          Merchant ID
          <input className="mp-input" name="merchant" defaultValue={merchantFilter} maxLength={128} />
        </label>
        <button className="mp-btn" type="submit">
          Apply merchant filter
        </button>
        <a href="/fraud">Clear</a>
      </form>
      <Card
        id="fraud-records"
        title={`${rows.length} open reviews loaded`}
        sub="Process-local queue, capped at 100; this is not a durable global count. No next-page cursor is available."
        actions={<CsvButton csv={csv} filename="open-fraud-reviews.csv" count={rows.length} />}
      >
        {rows.length === 0 ? (
          <StateBlock kind="empty" title="No open reviews returned">
            A review appears here when payment scoring requests a manual decision. Refresh after new payment activity.
          </StateBlock>
        ) : (
          <div className="mp-tablewrap">
            <table className="mp-table">
              <thead>
                <tr>
                  {['Review', 'Merchant', 'Amount', 'Status', 'Age / SLA'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                  .map((r) => (
                    <tr key={r.id}>
                      <td>
                        <a href={`/fraud/${encodeURIComponent(r.id)}`}>{r.id}</a>
                      </td>
                      <td>
                        <a href={`/merchants/${encodeURIComponent(r.merchantId)}`}>{r.merchantId}</a>
                      </td>
                      <td>
                        <MoneyText amount={r.amount} assetCode={r.assetId} />
                      </td>
                      <td>
                        <Chip tone="warn" title="The payment is awaiting manual review; no decision has been recorded.">
                          {r.status}
                        </Chip>
                      </td>
                      <td>
                        <Chip tone="warn" title={`Created ${r.createdAt}. No SLA threshold has been configured.`}>
                          {Math.max(0, Math.floor((Date.parse(readAt) - Date.parse(r.createdAt)) / 60000))} min · SLA unset
                        </Chip>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
function FraudDetail({ row }: { row: FraudRow }) {
  return (
    <>
      <Card title="Review facts">
        <p>
          <MoneyText amount={row.amount} assetCode={row.assetId} /> · {row.status}
        </p>
        <a href={`/merchants/${encodeURIComponent(row.merchantId)}`}>Open merchant</a>
        {row.paymentId ? (
          <p>
            Payment <code>{row.paymentId}</code>
            <CopyButton value={row.paymentId} label="Copy payment id" />
          </p>
        ) : null}
      </Card>
      <Card title="Signals">
        {row.reasons.map((r, i) => (
          <p key={i}>
            {r.ruleId}: {r.detail}
          </p>
        ))}
      </Card>
      <Card title="Lifecycle">
        <ol>
          <li>
            Review created · <time dateTime={row.createdAt}>{row.createdAt}</time>
          </li>
          <li>Decision: awaiting founder review</li>
        </ol>
        <a className="mp-btn" href="/tools">
          Open existing operator tools
        </a>
      </Card>
    </>
  );
}
function FounderAccess({ data, path }: { data: OpsData; path: string }) {
  return (
    <>
      <AsOf freshness={{ asOf: data.readAt, lagSeconds: 0 }} label="Founder authority checked" />
      <Card
        title="Current founder"
        sub="Verified by the live founder entitlement guard for this request. This is not the full founder roster."
      >
        <div className="mp-facts">
          <span>
            User <code>{data.userId}</code>
            <CopyButton value={data.userId} label="Copy founder id" />
          </span>
          <Chip tone="live" title="The current entitlement check accepted this founder session.">
            Enabled founder
          </Chip>
          <span>
            Session expires <time dateTime={data.expiresAt}>{data.expiresAt}</time>
          </span>
        </div>
        <p>MFA is enforced by the existing sign-in and session authority. Enrolled factors and last sign-in are not exposed as a roster.</p>
      </Card>
      <Card title="Founder enrolment">
        {data.enrolment?.kind === 'ok' ? (
          <Chip tone={data.enrolment.data.open ? 'warn' : 'neutral'} title="Read from the identity enrolment status procedure.">
            {data.enrolment.data.open ? 'Enrolment door open · invite required' : 'Enrolment door closed'}
          </Chip>
        ) : data.enrolment ? (
          <FailureState failure={data.enrolment} what="Enrolment status" retryHref={path} />
        ) : null}
        <p className="mp-footnote">
          Treasury operator, compliance analyst, finance viewer and support roles are reserved; assignment is unavailable.
        </p>
      </Card>
    </>
  );
}

function ApprovalFacts({ approval: a }: { approval: PayoutApproval }) {
  return (
    <Card title="Requested payout" sub="Read from the existing bounded pending approvals queue; no missing context is inferred.">
      <div className="mp-facts">
        <MoneyText amount={a.amount} assetCode={a.assetCode} />
        <span>Status: {a.status}</span>
        <a href={`/merchants/${a.merchantId}?tab=approvals`}>Open merchant approvals</a>
      </div>
      <p>
        Maker: <code>{a.makerUserId}</code>. Checker: <code>{a.checkerUserId ?? 'Not recorded'}</code>.
      </p>
      <p>
        Created <time dateTime={a.createdAt}>{a.createdAt}</time>. Expires <time dateTime={a.expiresAt}>{a.expiresAt}</time>.
      </p>
      <p>
        Payload hash <code>{a.payloadHash}</code> <CopyButton value={a.payloadHash} label="Copy payload hash" />
      </p>
      <a className="mp-btn" href="/merchants/approvals">
        Open existing decision flow
      </a>
    </Card>
  );
}
