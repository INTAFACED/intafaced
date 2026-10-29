'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Chip } from '@/components/chip';
import {
  AmbassadorActions,
  AppointAmbassadorAction,
  CardStatusAction,
  DisputeActions,
  ListingActions,
  ResidencyActions,
  VendorActions,
} from '@/components/ops-actions';
import { CustomerBalances } from '@/components/customer-balances';
import { DeskSectionSet } from '@/components/desk-section-set';
import { DepositAddressActions } from '@/components/deposit-address-actions';
import { DepositTravelRuleActions } from '@/components/deposit-travel-rule-actions';
import { KycDocumentOpen } from '@/components/kyc-document-open';
import { KycSelfieDecide } from '@/components/kyc-selfie-decide';
import { TransferLookup, TransferRecord } from '@/components/pay-transfer';
import { ProtocolBlockers } from '@/components/protocol-blockers';
import type { Part } from '@/lib/desk/part';
import { fetchDesk, fetchPage } from '@/lib/ops-desk/browser';
import { DESKS } from '@/lib/ops-desk/catalog';
import { ownServerFailureText } from '@/lib/ops-desk/own-server';
import { csvFilename, exportNote, listToCsv } from '@/lib/ops-desk/csv';
import { downloadCsv } from '@/lib/ops-desk/csv-browser';
import { displayCell, rowCountText, tableCells, withNames } from '@/lib/ops-desk/model';
import type { Cell, DeskSection, DeskSpec, DeskView, ReadData, ReadOutcome, ReadSpec, Row } from '@/lib/ops-desk/types';
import './desk.css';
import { formatAsOf } from '@/lib/as-of';

/**
 * A MODULE OPS DESK: lists, then detail, then figures with the time they were read, then actions.
 *
 * Everything on the page is a field a service returned, stamped with when this console read it. A figure a service does
 * not give is printed as "Not available" with the reason and the number of the back-end need that would fix it, never
 * as a zero. A read that was refused or is down says so in words and does not hide the reads beside it.
 */

function Failed({
  title,
  part,
  plainName,
  asOf,
}: {
  title: string;
  part: Extract<Part<unknown>, { kind: 'failed' }>;
  plainName?: string | undefined;
  asOf?: string | undefined;
}) {
  const label = part.notBuilt ? 'not switched on' : part.forbidden ? 'refused your session' : 'unavailable';
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid="read-failed">
      <strong>{plainName ? `Could not load ${plainName}` : `${title}: ${label}`}</strong>
      {plainName && (
        <p className="dk-muted">
          {label.charAt(0).toUpperCase() + label.slice(1)}. As of {asOf ? formatAsOf(asOf) : 'an unknown time'}.
        </p>
      )}
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

export function CellValueView({ cell }: { cell: Cell }) {
  return <>{displayCell(cell)}</>;
}

function RecordFacts({ cells }: { cells: readonly Cell[] }) {
  return (
    <dl className="dk-kv" data-testid="record">
      {cells.map((c) => (
        <div key={c.key} className="dk-kv-row">
          <dt>{c.label}</dt>
          <dd>
            <CellValueView cell={c} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface RowActionContext {
  readonly userId: string;
  readonly onChanged: () => void;
}

function DetailPanel({ spec, row, ctx }: { spec: ReadSpec; row: Row; ctx: RowActionContext }) {
  return (
    <div className="dk-stack" data-testid="row-detail">
      <dl className="dk-kv">
        {row.cells.map((c) => (
          <div key={c.key} className="dk-kv-row">
            <dt>{c.label}</dt>
            <dd className={c.kind === 'text' && c.label.toLowerCase().includes('id') ? 'dk-packet' : undefined}>
              <CellValueView cell={c} />
            </dd>
          </div>
        ))}
      </dl>
      {spec.rowAction === 'market.vendor.vet' && <VendorActions row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'academy.ambassador' && <AmbassadorActions row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'academy.residency' && <ResidencyActions row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'market.listing.takedown' && <ListingActions row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'p2p.dispute.escalate' && <DisputeActions row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'pay.transfer.detail' && <TransferRecord key={row.id} id={row.id} />}
      {spec.rowAction === 'identity.kyc_document.open' && <KycDocumentOpen row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'identity.kyc_selfie.decide' && (
        <KycSelfieDecide key={row.id} row={row} userId={ctx.userId} onChanged={ctx.onChanged} />
      )}
      {spec.rowAction === 'pay.deposit_address' && <DepositAddressActions row={row} userId={ctx.userId} onChanged={ctx.onChanged} />}
      {spec.rowAction === 'pay.deposit_travel_rule' && <DepositTravelRuleActions row={row} onChanged={ctx.onChanged} />}
    </div>
  );
}

export interface ListViewProps {
  readonly spec: ReadSpec;
  readonly data: Extract<ReadData, { shape: 'list' }>;
  readonly ctx: RowActionContext;
  /** The row open across the whole desk, as `${readId}:${rowId}`, so only one detail (and one form) is open at a time. */
  readonly openKey: string | null;
  readonly onOpen: (key: string | null) => void;
  /** When the console read this list. It goes into the CSV filename and the note beside the button. */
  readonly asOf?: string;
}

/** "Export CSV": the rows on screen, nothing more. The note beside it says so, and says when the page was full. */
export function ExportCsv({ spec, data, asOf }: { spec: ReadSpec; data: Extract<ReadData, { shape: 'list' }>; asOf: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="dk-row" data-testid="export-csv">
      <button type="button" className="adm-btn" onClick={() => setFailed(!downloadCsv(csvFilename(spec.id, asOf), listToCsv(spec, data)))}>
        Export CSV ({data.rows.length} {data.rows.length === 1 ? 'row' : 'rows'} shown)
      </button>
      <span className="dk-muted" data-testid="export-note">
        {exportNote(data.rows.length, data.pageFull, spec.page, asOf, data.nextCursor !== undefined)}
      </span>
      {failed && (
        <span className="dk-why" role="alert">
          The browser did not allow the download. Nothing was saved.
        </span>
      )}
    </div>
  );
}

export function ListView({ spec, data, ctx, openKey, onOpen, asOf }: ListViewProps) {
  if (data.rows.length === 0) {
    return (
      <p className="dk-muted" data-testid="list-empty">
        {spec.emptyText}
      </p>
    );
  }
  const head = tableCells(data.rows[0]!);
  const table = (
    <div className="dk-table-wrap" role="region" aria-label={spec.title} tabIndex={0}>
      <table className="adm-table">
        <thead>
          <tr>
            {head.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th>
              <span className="adm-sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const key = `${spec.id}:${row.id}`;
            const open = openKey === key;
            return (
              <RowFragment key={row.id} columns={head.length + 1} open={open} detail={<DetailPanel spec={spec} row={row} ctx={ctx} />}>
                {tableCells(row).map((c) => (
                  <td key={c.key} className={c.kind === 'text' && c.label.toLowerCase().includes('id') ? 'dk-packet' : undefined}>
                    <CellValueView cell={c} />
                  </td>
                ))}
                <td>
                  <button type="button" className="adm-btn" aria-expanded={open} onClick={() => onOpen(open ? null : key)}>
                    {open ? 'Close' : 'Open'}
                  </button>
                </td>
              </RowFragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="dk-stack" data-testid="list">
      <p className="dk-muted" data-testid="list-count">
        {rowCountText(data.rows.length, data.pageFull, spec.page, data.nextCursor !== undefined)}
      </p>
      {asOf !== undefined && <ExportCsv spec={spec} data={data} asOf={asOf} />}
      {spec.collapsed ? (
        <details data-testid="list-collapsed">
          <summary>
            Show all {data.rows.length} {data.rows.length === 1 ? 'row' : 'rows'}
          </summary>
          {table}
        </details>
      ) : (
        table
      )}
    </div>
  );
}

function RowFragment({ children, open, detail, columns }: { children: ReactNode; open: boolean; detail: ReactNode; columns: number }) {
  return (
    <>
      <tr data-open={open ? 'true' : undefined}>{children}</tr>
      {open && (
        <tr>
          <td colSpan={columns}>{detail}</td>
        </tr>
      )}
    </>
  );
}

/**
 * A list whose service gives a page marker: the rows read so far, and a button that reads the next page when the service says one
 * exists. The next page is read on request through the console's own server; rows already shown are never repeated, and a refused
 * or failed page keeps what is already on screen and says why.
 */
export function PagedList({ spec, data, ctx, openKey, onOpen, asOf }: ListViewProps) {
  const [extra, setExtra] = useState<readonly Row[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(data.nextCursor);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lock = useRef(false);
  const rows = [...data.rows, ...extra];
  async function next() {
    if (lock.current || typeof cursor !== 'string') return;
    lock.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await fetchPage(spec.id, cursor);
      if (!result.ok) return setProblem(ownServerFailureText(result, 'page'));
      const { part } = result.outcome;
      if (part.kind === 'failed') return setProblem(part.message);
      const page = part.data;
      if (page.shape !== 'list') return setProblem('The page came back in a shape this console does not understand.');
      const seen = new Set(rows.map((r) => r.id));
      setExtra((now) => [...now, ...page.rows.filter((r) => !seen.has(r.id))]);
      setCursor(page.nextCursor ?? null);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const more = typeof cursor === 'string';
  return (
    <div className="dk-stack" data-testid="paged-list">
      <ListView
        spec={spec}
        data={{ ...data, rows, pageFull: more, nextCursor: cursor ?? null }}
        ctx={ctx}
        openKey={openKey}
        onOpen={onOpen}
        {...(asOf ? { asOf } : {})}
      />
      {more && (
        <div className="dk-row">
          <button type="button" className="adm-btn" disabled={busy} onClick={() => void next()} data-testid="next-page">
            {busy ? 'Reading…' : `Next ${spec.page ?? ''}`.trim()}
          </button>
          <span className="dk-muted">svc-bank says more rows exist. Each page is read on request.</span>
        </div>
      )}
      {problem && (
        <p className="dk-why" role="alert" data-testid="page-problem">
          {problem}
        </p>
      )}
    </div>
  );
}

export interface ReadBlockProps {
  readonly spec: ReadSpec;
  readonly outcome: ReadOutcome | undefined;
  readonly ctx: RowActionContext;
  readonly openKey: string | null;
  readonly onOpen: (key: string | null) => void;
  /** The desk read that names this list's rows (`spec.namesFrom`), when it has one. */
  readonly names?: ReadOutcome | undefined;
}

export function ReadBlock({ spec, outcome: raw, ctx, openKey, onOpen, names }: ReadBlockProps) {
  const outcome =
    raw?.part.kind === 'ok' && raw.part.data.shape === 'list' && spec.namesFrom
      ? { ...raw, part: { ...raw.part, data: withNames(spec, raw.part.data, names) } }
      : raw;
  return (
    <section className="dk-stack" data-testid={`read-${spec.id}`} aria-label={spec.title}>
      <div>
        <h3>{spec.title}</h3>
        <p className="dk-muted">{spec.note}</p>
        <p className="dk-asof">{outcome ? `As of ${formatAsOf(outcome.asOf)} (when this console read ${spec.module})` : 'Not read yet'}</p>
      </div>
      {!outcome && <p className="dk-why">This part was not read. Nothing is shown rather than a guess.</p>}
      {outcome?.part.kind === 'failed' && <Failed title={spec.title} part={outcome.part} plainName={spec.plainName} asOf={outcome.asOf} />}
      {outcome?.part.kind === 'ok' && outcome.part.data.shape === 'record' && <RecordFacts cells={outcome.part.data.cells} />}
      {outcome?.part.kind === 'ok' && outcome.part.data.shape === 'list' && spec.cursorKey === undefined && (
        <ListView spec={spec} data={outcome.part.data} ctx={ctx} openKey={openKey} onOpen={onOpen} asOf={outcome.asOf} />
      )}
      {outcome?.part.kind === 'ok' && outcome.part.data.shape === 'list' && spec.cursorKey !== undefined && (
        <PagedList
          key={outcome.asOf}
          spec={spec}
          data={outcome.part.data}
          ctx={ctx}
          openKey={openKey}
          onOpen={onOpen}
          asOf={outcome.asOf}
        />
      )}
    </section>
  );
}

export function SectionView({
  section,
  view,
  ctx,
  openKey,
  onOpen,
}: {
  section: DeskSection;
  view: DeskView | null;
  ctx: RowActionContext;
  openKey: string | null;
  onOpen: (key: string | null) => void;
}) {
  return (
    <section className="dk-stack" id={section.id} data-testid={`section-${section.id}`} aria-labelledby={`h-${section.id}`}>
      <div>
        <h2 id={`h-${section.id}`}>{section.title}</h2>
        <p className="dk-muted">{section.intro}</p>
      </div>
      {section.reads.map((spec) => (
        <ReadBlock
          key={spec.id}
          spec={spec}
          outcome={view?.reads[spec.id]}
          ctx={ctx}
          openKey={openKey}
          onOpen={onOpen}
          names={spec.namesFrom ? view?.reads[spec.namesFrom.read] : undefined}
        />
      ))}
      {section.panel === 'protocol.blockers' && <ProtocolBlockers view={view} />}
      {section.unavailable.length > 0 && (
        <div className="dk-stack" data-testid="unavailable">
          {section.unavailable.map((u) => (
            <div key={u.id} className="adm-callout" data-tone="warn" data-testid={`unavailable-${u.id}`}>
              <strong>Not available: {u.label}</strong>
              <p>{u.reason}</p>
              <p className="dk-muted">
                {u.need === null ? 'Waiting on a decision, not on code.' : `Back-end need ${u.need} in the console’s needs list.`}
              </p>
            </div>
          ))}
        </div>
      )}
      {section.sectionAction === 'academy.ambassador.appoint' && <AppointAmbassadorAction userId={ctx.userId} onChanged={ctx.onChanged} />}
      {section.sectionAction === 'bank.card.status' && <CardStatusAction userId={ctx.userId} onChanged={ctx.onChanged} />}
      {section.sectionAction === 'pay.transfer.lookup' && <TransferLookup />}
      {section.sectionAction === 'bank.customer.balances' && <CustomerBalances />}
      {section.disabledActions.length > 0 && (
        <div className="dk-stack" data-testid="disabled-actions">
          {section.disabledActions.map((a) => (
            <div key={a.id} className="dk-row">
              <button type="button" className="adm-btn" disabled aria-describedby={`why-${a.id}`}>
                {a.label}
              </button>
              <span id={`why-${a.id}`} className="dk-why">
                {a.reason}
              </span>
            </div>
          ))}
        </div>
      )}
      {section.links.length > 0 && (
        <ul className="dk-stack" data-testid="links">
          {section.links.map((l) => (
            <li key={l.href + l.label}>
              <Link href={l.href}>{l.label}</Link> <span className="dk-muted">{l.why}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface OpsDeskViewProps {
  readonly spec: DeskSpec;
  readonly view: DeskView | null;
  readonly loading: boolean;
  readonly userId: string;
  readonly openKey: string | null;
  readonly onOpen: (key: string | null) => void;
  readonly onRefresh: () => void;
  /** The last refresh did not reach the server, so what is shown is the earlier read. */
  readonly stale?: boolean;
}

export function OpsDeskView({ spec, view, loading, userId, openKey, onOpen, onRefresh, stale = false }: OpsDeskViewProps) {
  const ctx: RowActionContext = { userId, onChanged: onRefresh };
  // Only this desk's own reads: the mining desk shares the More modules read, which also answers for agents, market and the rest.
  const counts = view ? spec.sections.flatMap((s) => s.reads.map((r) => view.reads[r.id])).filter((o) => o !== undefined) : [];
  const failed = counts.filter((o) => o.part.kind === 'failed').length;
  return (
    <div className="dk" data-testid={`ops-desk-${spec.id}`}>
      <div className="adm-pagehead">
        <div>
          <h1>{spec.title}</h1>
          <p>{spec.intro}</p>
        </div>
      </div>
      <div className="dk-row">
        <button type="button" className="adm-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
        <span className="dk-asof">{view ? `Read started ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
        {view && (
          <Chip tone={failed === 0 ? 'live' : 'warn'}>
            {counts.length - failed} of {counts.length} reads answered
          </Chip>
        )}
      </div>
      {stale && view && (
        <p className="dk-why" role="alert" data-testid="stale">
          The last refresh did not reach the console’s server, so this is the earlier read, from {formatAsOf(view.asOf)}.
        </p>
      )}
      {!view && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      {spec.commonSet && <DeskSectionSet setId={spec.commonSet} spec={spec} view={view} />}
      {spec.pages ? (
        <nav aria-label="Sections" className="dk-row">
          {spec.pages.map((p) => {
            const here = spec.sections.length === 1 && spec.sections[0]!.id === p.id;
            return (
              <Link key={p.id} href={p.href} aria-current={here ? 'page' : undefined}>
                {p.title}
              </Link>
            );
          })}
        </nav>
      ) : (
        <nav aria-label="Sections" className="dk-row">
          {spec.sections.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.title}
            </a>
          ))}
        </nav>
      )}
      {spec.sections.map((s) => (
        <SectionView key={s.id} section={s} view={view} ctx={ctx} openKey={openKey} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function OpsDesk({ spec, initial, userId }: { spec: DeskSpec; initial: DeskView | null; userId: string }) {
  const [view, setView] = useState<DeskView | null>(initial);
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++sequence.current;
    setLoading(true);
    // A desk page that shows part of a desk (mining) refreshes only that part.
    const next = await fetchDesk(spec.id, undefined, spec === DESKS[spec.id] ? undefined : spec.sections.map((s) => s.id));
    if (mine === sequence.current) {
      // A failed refresh keeps the last good read on screen with its own time, rather than blanking the page.
      if (next) setView(next);
      setStale(next === null);
      setLoading(false);
    }
  }, [spec]);
  return (
    <OpsDeskView
      spec={spec}
      view={view}
      loading={loading}
      userId={userId}
      openKey={openKey}
      onOpen={setOpenKey}
      onRefresh={() => void reload()}
      stale={stale}
    />
  );
}
