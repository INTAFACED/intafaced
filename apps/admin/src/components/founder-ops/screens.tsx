import type { FounderMerchantSection } from '@intafaced/contracts';
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
import { NotesPanel } from './notes-panel';
import { SectionKpis, SectionPanel } from './section-panels';
import { ApprovalDetailView, AuditView, LimitRequestsView, TiersView } from './control-screens';
import { DisputesView, LiveView, PayoutsView, RecentMerchantsView, RiskView } from './wired-screens';
import { SCREEN_SECTIONS, slugOf, type Query } from '@/lib/founder-ops/read-model';
import './screens.css';

export function NotConnected({ reason }: { reason: string }) {
  return (
    <StateBlock
      kind="not_built"
      title="Not connected"
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
  query,
}: {
  screen: FounderScreen;
  data: OpsData;
  path: string;
  resourceId?: string | undefined;
  merchantId?: string | undefined;
  merchantFilter?: string | undefined;
  query?: Query | undefined;
}) {
  const isList = screen.type === 'LIST' || screen.type === 'QUEUE';
  const slug = merchantId ? slugOf(screen.route) : '';
  const sectionList = merchantId ? SCREEN_SECTIONS[slug] : undefined;
  /** Pages whose data now comes from the founder reads: they show real lists, not the "not connected" state. */
  const wired = ['F02', 'F03', 'F05', 'F25', 'F32', 'F35', 'F37', 'F54', 'F58', 'F64'].includes(screen.id);
  const drilled = sectionList !== undefined || (merchantId !== undefined && ['F22'].includes(screen.id));
  const handled = wired || drilled;
  const fraud = data.fraud?.kind === 'ok' ? data.fraud.data : null;
  const review = resourceId ? fraud?.find((r) => r.id === resourceId) : undefined;
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
            {['notes', 'controls', 'approvals', 'halts'].map((tab) => (
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
      {screen.id === 'F02' ? <LiveView data={data} path={path} /> : null}
      {screen.id === 'F03' ? <RiskView data={data} path={path} /> : null}
      {screen.id === 'F05' ? <RecentMerchantsView data={data} path={path} query={query} /> : null}
      {screen.id === 'F32' ? <DisputesView data={data} path={path} query={query} /> : null}
      {screen.id === 'F37' ? <PayoutsView data={data} path={path} query={query} /> : null}
      {screen.id === 'F35' ? <PayoutsView data={data} path={path} query={query} variant="settlements" /> : null}
      {screen.id === 'F25' ? <ApprovalDetailView data={data} path={path} resourceId={resourceId} gap={screen.gap} /> : null}
      {screen.id === 'F54' ? <TiersView data={data} path={path} /> : null}
      {screen.id === 'F54' ? (
        <StateBlock kind="info" title="Tiers are read only here">
          {screen.gap}
        </StateBlock>
      ) : null}
      {screen.id === 'F58' ? <LimitRequestsView data={data} path={path} query={query} /> : null}
      {screen.id === 'F58' ? (
        <StateBlock kind="info" title="Cap usage across merchants is not available">
          {screen.gap}
        </StateBlock>
      ) : null}
      {screen.id === 'F64' ? <AuditView data={data} path={path} query={query} gap={screen.gap} /> : null}
      {merchantId && sectionList ? (
        <DrilldownSections screen={screen} sections={sectionList} data={data} path={path} query={query} merchantId={merchantId} />
      ) : null}
      {merchantId && screen.id === 'F22' ? <NotesPanel merchantId={merchantId} result={data.notes} path={path} query={query} /> : null}
      {data.fraud && data.fraud.kind !== 'ok' ? <FailureState failure={data.fraud} what="Open fraud reviews" retryHref={path} /> : null}
      {fraud && !resourceId ? (
        <FraudQueue rows={fraud} readAt={data.readAt} merchantFilter={merchantFilter} testData={data.testData ?? false} />
      ) : null}
      {review ? <FraudDetail row={review} /> : null}
      {fraud && resourceId && !review ? (
        <StateBlock kind="empty" title="Review unavailable">
          This review was not found in the bounded open queue. It may be closed or outside this read. No decision is available here.
        </StateBlock>
      ) : null}
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
      {!handled && !noPointer(screen.id) ? <NotConnected reason={screen.gap} /> : null}
      {screen.id === 'F05' ? <NamedBlocker title="The pay service does not create merchants for someone else" reason={screen.gap} /> : null}
      {screen.id === 'F12' ? <NamedBlocker title="There is no conversion order reader" reason={screen.gap} /> : null}
      {screen.id === 'F13' || screen.id === 'F14' ? <ControlsPointer merchantId={merchantId} what={screen.title} /> : null}
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
      {isList && screen.id !== 'F30' && !handled ? (
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
            sub="Row count unavailable. Search, server filters, pagination and export are not available: there is no list reader."
            actions={
              <button className="mp-btn" disabled title="No authoritative filtered list is available to export.">
                Export CSV unavailable
              </button>
            }
          >
            <fieldset disabled className="fo-filters">
              <legend>Search and filters · not connected</legend>
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
                    <td colSpan={screen.sections.length}>Records cannot be read. This is not an empty queue.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
      {!isList && !handled && !noPointer(screen.id) && !data.metrics && !data.treasury && !fraud && !data.approvals ? (
        <div className="fo-sections">
          {screen.sections.map((title) => (
            <Card key={title} title={title}>
              <p className="mp-muted">Not available from the current backend.</p>
            </Card>
          ))}
        </div>
      ) : null}
      {screen.type === 'DASH' && !data.metrics && !handled ? (
        <Card title="Daily volume and count" sub="Charts need verified series; gaps are never rendered as zeros.">
          <nav className="mp-pills" aria-label="Reporting periods">
            {['Today', '7d', '30d', 'Lifetime'].map((s) => (
              <span className="mp-muted" key={s}>
                {s} · unavailable
              </span>
            ))}
          </nav>
          <p className="mp-footnote">Table fallback and per-asset series are not available: there is no analytics reader.</p>
        </Card>
      ) : null}
      {['FORM', 'CONFIG', 'DETAIL'].includes(screen.type) && !handled && !noPointer(screen.id) ? (
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
        {handled || noPointer(screen.id)
          ? 'Read from the pay service at '
          : 'As of: unavailable for unbuilt projections. Snapshot request: '}
        <time dateTime={data.readAt}>{data.readAt}</time>
        {handled || noPointer(screen.id)
          ? '. Each list shows exactly what the service returned at that moment; nothing is estimated and missing values stay missing.'
          : '. Unknown freshness is never displayed as live. Missing thresholds stay not configured.'}
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
/** F13 and F14 read their data in the merchant's Controls tab, so these pages point there instead of repeating it. */
function noPointer(id: string): boolean {
  return id === 'F12' || id === 'F13' || id === 'F14' || id === 'F23';
}

/** A genuine external blocker, named: what is missing, and that nothing is shown in its place. */
export function NamedBlocker({ title, reason }: { title: string; reason: string }) {
  return (
    <StateBlock kind="not_built" title={title}>
      {reason} Nothing is shown in its place.
    </StateBlock>
  );
}

function ControlsPointer({ merchantId, what }: { merchantId: string | undefined; what: string }) {
  return (
    <Card title={what} sub="Read in the merchant's Controls tab, next to the change flow that edits it.">
      <p className="mp-muted">
        Effective pricing rules (global, tier and merchant layers), cap usage and the tier all load in Controls from the same founder reads.
        Fee snapshots for individual payments and settlements are on the payments and settlements pages.
      </p>
      {merchantId ? (
        <a className="mp-btn mp-btn--primary" href={`/merchants/${merchantId}?tab=controls`}>
          Open Controls
        </a>
      ) : null}
    </Card>
  );
}

function DrilldownSections({
  screen,
  sections,
  data,
  path,
  query,
  merchantId,
}: {
  screen: FounderScreen;
  sections: readonly FounderMerchantSection[];
  data: OpsData;
  path: string;
  query: Query | undefined;
  merchantId: string;
}) {
  const results = data.sections ?? {};
  return (
    <>
      <SectionKpis sections={sections} results={results} />
      {screen.id === 'F11' ? <Balances result={data.balances} path={path} /> : null}
      {sections.map((section) => (
        <SectionPanel
          key={section}
          section={section}
          result={results[section]}
          path={path}
          query={query}
          readAt={data.readAt}
          testData={data.testData ?? false}
        />
      ))}
      {screen.id === 'F23' ? (
        <Card title="Change this merchant" sub="Status, archetype, pricing and caps change only through the hash-bound two-founder flow.">
          <p className="mp-muted">{screen.gap}</p>
          <a className="mp-btn mp-btn--primary" href={`/merchants/${merchantId}?tab=controls`}>
            Open Controls
          </a>
        </Card>
      ) : null}
    </>
  );
}

function Balances({ result, path }: { result: OpsData['balances']; path: string }) {
  if (!result) return null;
  return (
    <Card
      id="balances"
      title="Balances"
      sub="Per asset, from the merchant's 30-day snapshot. Clearing is captured and not yet settled; available can be paid out."
    >
      {result.kind !== 'ok' ? (
        <FailureState failure={result} what="The merchant's balances" retryHref={path} />
      ) : result.data.balances.length === 0 ? (
        <StateBlock kind="empty" title="No balances yet">
          A balance appears after this merchant&apos;s first captured payment.
        </StateBlock>
      ) : (
        <>
          <AsOf freshness={result.data.freshness} label="Balances" />
          <div className="mp-scroll" tabIndex={0} role="region" aria-label="Balances, scrolls sideways on small screens">
            <table className="mp-table">
              <caption className="mp-visually-hidden">Merchant balances per asset</caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col" className="mp-right">
                    Clearing
                  </th>
                  <th scope="col" className="mp-right">
                    Available
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.balances.map((b) => (
                  <tr key={b.assetCode}>
                    <th scope="row">{b.assetCode}</th>
                    <td className="mp-right">
                      <MoneyText amount={b.clearing} assetCode={b.assetCode} />
                    </td>
                    <td className="mp-right">
                      <MoneyText amount={b.available} assetCode={b.assetCode} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
