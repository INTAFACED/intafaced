'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Panel } from '@intafaced/ui';
import { Chip } from '@/components/chip';
import {
  isQueueStale,
  KYC_QUEUE_TOOL_ID,
  maskUserId,
  queueAgeSeconds,
  snapshotFromKycResponse,
  type KycQueueRow,
  type KycQueueSnapshot,
} from '@/lib/operator-queue-contract';
import { invokeOperatorToolBrowser, type ToolListItem, type ToolListResponse } from '@/lib/operator-tools-browser';

export interface QueueActionContext {
  readonly recordId: string;
  readonly status: 'pending';
  readonly version: string;
}

interface OperatorQueuesProps {
  readonly catalog: ToolListResponse;
  readonly pending: boolean;
  readonly refreshToken: number;
  readonly onOpenTool: (toolId: string, fields: Record<string, string>, context: QueueActionContext) => void;
}

type SortKey = 'oldest' | 'newest' | 'record';

export function OperatorQueues({ catalog, pending, refreshToken, onOpenTool }: OperatorQueuesProps) {
  const kycTool = catalog.tools.find((tool) => tool.id === KYC_QUEUE_TOOL_ID) ?? null;
  const approveTool = catalog.tools.find((tool) => tool.id === 'identity.kyc.approve') ?? null;
  const rejectTool = catalog.tools.find((tool) => tool.id === 'identity.kyc.reject') ?? null;
  const [limit, setLimit] = useState(50);
  const [snapshot, setSnapshot] = useState<KycQueueSnapshot>(() => queueInitialState(kycTool, 50));
  const [filter, setFilter] = useState('');
  const [tier, setTier] = useState('all');
  const [sort, setSort] = useState<SortKey>('oldest');
  const [now, setNow] = useState(() => new Date());
  const requestId = useRef(0);

  function refresh(nextLimit = limit) {
    const currentRequest = ++requestId.current;
    if (!kycTool || kycTool.wire !== 'wired') {
      setSnapshot(queueInitialState(kycTool, nextLimit));
      return;
    }
    setSnapshot({ kind: 'loading', requestedLimit: nextLimit });
    void invokeOperatorToolBrowser(KYC_QUEUE_TOOL_ID, { limit: String(nextLimit) }).then((result) => {
      if (requestId.current !== currentRequest) return;
      setSnapshot(snapshotFromKycResponse(result, nextLimit));
      setNow(new Date());
    });
  }

  useEffect(() => {
    refresh(limit);
    // A catalog wire change, a completed row action, or a limit change is a new source read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kycTool?.wire, limit, refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <OperatorQueuesView
      snapshot={snapshot}
      kycTool={kycTool}
      approveTool={approveTool}
      rejectTool={rejectTool}
      filter={filter}
      tier={tier}
      sort={sort}
      now={now}
      pending={pending}
      onFilter={setFilter}
      onTier={setTier}
      onSort={setSort}
      onLimit={setLimit}
      onRefresh={() => refresh()}
      onOpenTool={onOpenTool}
    />
  );
}

function queueInitialState(tool: ToolListItem | null, requestedLimit: number): KycQueueSnapshot {
  if (!tool) {
    return {
      kind: 'unavailable',
      reason: 'identity.kyc.pending is absent from the mounted operator catalog.',
      missing: [],
      requestedLimit,
    };
  }
  if (tool.wire === 'not-wired') {
    return {
      kind: 'unavailable',
      reason: tool.detail ?? 'The KYC queue is not wired on this console.',
      missing: tool.missing,
      requestedLimit,
    };
  }
  return { kind: 'loading', requestedLimit };
}

export interface OperatorQueuesViewProps {
  readonly snapshot: KycQueueSnapshot;
  readonly kycTool: ToolListItem | null;
  readonly approveTool: ToolListItem | null;
  readonly rejectTool: ToolListItem | null;
  readonly filter: string;
  readonly tier: string;
  readonly sort: SortKey;
  readonly now: Date;
  readonly pending: boolean;
  readonly onFilter: (value: string) => void;
  readonly onTier: (value: string) => void;
  readonly onSort: (value: SortKey) => void;
  readonly onLimit: (value: number) => void;
  readonly onRefresh: () => void;
  readonly onOpenTool: (toolId: string, fields: Record<string, string>, context: QueueActionContext) => void;
}

export function OperatorQueuesView(props: OperatorQueuesViewProps) {
  const rows = useMemo(
    () => visibleRows(props.snapshot, props.filter, props.tier, props.sort),
    [props.snapshot, props.filter, props.tier, props.sort],
  );
  const hasRows = props.snapshot.kind === 'live' || props.snapshot.kind === 'partial' || props.snapshot.kind === 'empty';
  const stale = hasRows && isQueueStale(props.snapshot.receivedAt, props.now);
  const age = hasRows ? queueAgeSeconds(props.snapshot.receivedAt, props.now) : null;

  return (
    <section aria-labelledby="daily-queues-title" className="adm-stack adm-queue-section">
      <div className="adm-pagehead adm-pagehead--compact">
        <div>
          <h2 id="daily-queues-title">Daily queues</h2>
          <p>
            Only service query contracts become tables. Missing pagination or procedures stay visible as limitations, never simulated
            controls.
          </p>
        </div>
      </div>

      <Panel
        title="Users · pending KYC"
        className="adm-flush adm-queue-panel"
        actions={
          <>
            <Chip
              tone={
                props.snapshot.kind === 'live' && !stale
                  ? 'live'
                  : props.snapshot.kind === 'partial' || stale
                    ? 'warn'
                    : props.snapshot.kind === 'empty'
                      ? 'neutral'
                      : 'danger'
              }
            >
              {stale ? 'stale' : props.snapshot.kind}
            </Chip>
            {age != null && <Chip tone="neutral">age {age}s</Chip>}
          </>
        }
      >
        {(hasRows || props.snapshot.kind === 'loading') && (
          <div className="adm-queue-toolbar" aria-label="KYC queue controls">
            <label className="adm-field">
              <span>Filter loaded window</span>
              <input
                className="adm-input"
                type="search"
                value={props.filter}
                placeholder="record id, masked user, jurisdiction"
                onChange={(event) => props.onFilter(event.target.value)}
                disabled={!hasRows}
              />
            </label>
            <label className="adm-field">
              <span>Tier</span>
              <select className="adm-select" value={props.tier} onChange={(event) => props.onTier(event.target.value)} disabled={!hasRows}>
                <option value="all">All loaded tiers</option>
                <option value="basic">Basic</option>
                <option value="full">Full</option>
                <option value="institutional">Institutional</option>
              </select>
            </label>
            <label className="adm-field">
              <span>Sort loaded window</span>
              <select
                className="adm-select"
                value={props.sort}
                onChange={(event) => props.onSort(event.target.value as SortKey)}
                disabled={!hasRows}
              >
                <option value="oldest">Oldest first (service order)</option>
                <option value="newest">Newest first</option>
                <option value="record">Record id</option>
              </select>
            </label>
            <label className="adm-field">
              <span>Requested window</span>
              <select
                className="adm-select"
                value={props.snapshot.requestedLimit}
                onChange={(event) => props.onLimit(Number(event.target.value))}
                disabled={props.snapshot.kind === 'loading'}
              >
                {[25, 50, 100, 200].map((value) => (
                  <option key={value} value={value}>
                    First {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="adm-btn"
              onClick={props.onRefresh}
              disabled={props.snapshot.kind === 'loading' || props.pending}
            >
              Refresh
            </button>
          </div>
        )}

        <div className="adm-queue-facts" aria-live="polite">
          {hasRows ? (
            <>
              <strong>{rows.length} visible</strong> · {props.snapshot.rows.length} returned · requested first{' '}
              {props.snapshot.requestedLimit} · total and next page unavailable from the service contract · received{' '}
              <time dateTime={props.snapshot.receivedAt}>{props.snapshot.receivedAt}</time> · source order oldest first
            </>
          ) : (
            queueStateCopy(props.snapshot)
          )}
        </div>

        {props.snapshot.kind === 'partial' && (
          <div className="adm-callout" data-tone="warn" role="status">
            <strong>Partial response</strong>
            {props.snapshot.rejectedRows} malformed row{props.snapshot.rejectedRows === 1 ? ' was' : 's were'} refused and not painted.
          </div>
        )}
        {props.snapshot.kind === 'failure' && (
          <div className="adm-callout" data-tone="danger" role="alert">
            <strong>{props.snapshot.failure}</strong>
            {props.snapshot.detail}
          </div>
        )}
        {props.snapshot.kind === 'unavailable' && (
          <div className="adm-callout" data-tone="warn" role="status">
            <strong>Unavailable</strong>
            {props.snapshot.reason}{' '}
            {props.snapshot.missing.map((name) => (
              <code key={name}>{name} </code>
            ))}
          </div>
        )}
        {hasRows && (
          <div className="adm-scroll" tabIndex={0} role="region" aria-label="Operator queue records">
            <table className="adm-table adm-queue-table">
              <caption className="adm-visually-hidden">Pending KYC records returned by identity.kyc.pending</caption>
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">User</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Age</th>
                  <th scope="col">State</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <KycRow key={row.id} row={row} tools={props} />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="adm-empty">
                      {props.snapshot.kind === 'empty'
                        ? 'The service answered with an empty pending queue.'
                        : 'No rows in the loaded window match these local filters.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <UnavailableQueueRows />
    </section>
  );
}

function KycRow({ row, tools }: { row: KycQueueRow; tools: OperatorQueuesViewProps }) {
  const context: QueueActionContext = { recordId: row.id, status: row.status, version: row.createdAt };
  const age = queueAgeSeconds(row.createdAt, tools.now);
  const approvalAvailable = tools.approveTool?.wire === 'wired';
  const rejectionAvailable = tools.rejectTool?.wire === 'wired';
  return (
    <tr id={`kyc-${row.id}`}>
      <th scope="row" className="adm-key">
        <a className="adm-record-link" href={`#kyc-${row.id}`} aria-label={`Deep link to KYC record ${row.id}`}>
          {row.id}
        </a>
      </th>
      <td>
        <code title="User identifier masked in the operator table">{maskUserId(row.userId)}</code>
      </td>
      <td>{row.tier}</td>
      <td>{row.jurisdiction}</td>
      <td>
        <time dateTime={row.createdAt}>{row.createdAt}</time>
      </td>
      <td className="adm-num">{age}s</td>
      <td>
        <Chip tone="warn">pending</Chip>
      </td>
      <td>
        <div className="adm-inline">
          <button
            type="button"
            className="adm-btn adm-btn--compact"
            disabled={tools.pending || !approvalAvailable}
            onClick={() => tools.onOpenTool('identity.kyc.approve', { recordId: row.id }, context)}
            title={approvalAvailable ? 'Open a version-labelled approval review' : 'Approval procedure is not wired'}
          >
            {approvalAvailable ? 'Review approval' : 'Approval unavailable'}
          </button>
          <button
            type="button"
            className="adm-btn adm-btn--compact"
            disabled={tools.pending || !rejectionAvailable}
            onClick={() => tools.onOpenTool('identity.kyc.reject', { recordId: row.id }, context)}
            title={rejectionAvailable ? 'Open a version-labelled rejection review' : 'Rejection procedure is not wired'}
          >
            {rejectionAvailable ? 'Review rejection' : 'Rejection unavailable'}
          </button>
        </div>
      </td>
    </tr>
  );
}

function visibleRows(snapshot: KycQueueSnapshot, filter: string, tier: string, sort: SortKey): readonly KycQueueRow[] {
  if (snapshot.kind !== 'live' && snapshot.kind !== 'empty' && snapshot.kind !== 'partial') return [];
  const needle = filter.trim().toLowerCase();
  const rows = snapshot.rows.filter((row) => {
    if (tier !== 'all' && row.tier !== tier) return false;
    if (!needle) return true;
    return [row.id, maskUserId(row.userId), row.jurisdiction].some((value) => value.toLowerCase().includes(needle));
  });
  return [...rows].sort((a, b) => {
    if (sort === 'record') return a.id.localeCompare(b.id);
    const order = a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    return sort === 'newest' ? -order : order;
  });
}

function queueStateCopy(snapshot: KycQueueSnapshot): string {
  if (snapshot.kind === 'loading') return 'Loading the first source-backed window…';
  if (snapshot.kind === 'unavailable') return 'Queue unavailable: the query contract is not wired on this console.';
  if (snapshot.kind === 'failure') return `${snapshot.failure}: ${snapshot.detail}`;
  return 'The source-backed queue is available.';
}

function UnavailableQueueRows() {
  return (
    <Panel title="Unavailable lanes · no queue mounted" className="adm-flush adm-boundary-panel">
      <div className="adm-boundary-head">
        <strong>Capability boundary</strong>
        <span>These are contract gaps, not empty work queues. No records were requested or returned.</span>
      </div>
      <div className="adm-boundary-grid" role="list" aria-label="Operator queue capabilities that are not mounted">
        <UnavailableLane
          lane="Orders"
          queue="Withdrawal approvals"
          fact="No withdrawal list or approval procedure is mounted on svc-edge."
        />
        <UnavailableLane
          lane="Orders"
          queue="Platform order review"
          fact="No admin-scoped paginated order query is mounted. Member order APIs are not an operator queue."
        />
        <UnavailableLane
          lane="Finance"
          queue="Due standing transfers"
          fact={
            <>
              <code>bank.ops.runDueTransfers</code> is a consequential sweep command, not a read/list contract.
            </>
          }
        />
        <UnavailableLane
          lane="Finance"
          queue="Pending loan recovery"
          fact={
            <>
              <code>bank.ops.resumePendingLoans</code> is a consequential recovery command, not a read/list contract.
            </>
          }
        />
        <UnavailableLane
          lane="Users"
          queue="KYC pagination and totals"
          state="PARTIAL CONTRACT"
          fact={
            <>
              <code>identity.kyc.pending</code> returns only an oldest-first limited window; no total, cursor, or version predicate exists.
            </>
          }
        />
        <UnavailableLane
          lane="Matching"
          queue="Surveillance cases"
          fact={
            <>
              <code>GET /surveillance/cases</code> exists on svc-matching as evidence. No admin case UI is mounted on this console. This is
              not an empty case list.
            </>
          }
        />
      </div>
    </Panel>
  );
}

function UnavailableLane({
  lane,
  queue,
  fact,
  state = 'NOT MOUNTED',
}: {
  lane: string;
  queue: string;
  fact: ReactNode;
  state?: 'NOT MOUNTED' | 'PARTIAL CONTRACT';
}) {
  return (
    <article className="adm-boundary-row" data-state={state === 'NOT MOUNTED' ? 'unmounted' : 'partial'} role="listitem">
      <span className="adm-boundary-row__lane">{lane}</span>
      <strong className="adm-boundary-row__queue">{queue}</strong>
      <span className="adm-boundary-row__state">{state}</span>
      <span className="adm-boundary-row__fact">{fact}</span>
    </article>
  );
}
