'use client';

import Link from 'next/link';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Chip } from '@/components/chip';
import { AmbassadorActions, VendorActions } from '@/components/ops-actions';
import type { Part } from '@/lib/desk/part';
import { fetchDesk } from '@/lib/ops-desk/browser';
import { formatCell, rowCountText, tableCells } from '@/lib/ops-desk/model';
import type { Cell, DeskSection, DeskSpec, DeskView, ReadData, ReadOutcome, ReadSpec, Row } from '@/lib/ops-desk/types';
import './desk.css';

/**
 * A MODULE OPS DESK: lists, then detail, then figures with the time they were read, then actions.
 *
 * Everything on the page is a field a service returned, stamped with when this console read it. A figure a service does
 * not give is printed as "Not available" with the reason and the number of the back-end need that would fix it, never
 * as a zero. A read that was refused or is down says so in words and does not hide the reads beside it.
 */

function Failed({ title, part }: { title: string; part: Extract<Part<unknown>, { kind: 'failed' }> }) {
  const label = part.notBuilt ? 'not switched on' : part.forbidden ? 'refused your session' : 'unavailable';
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid="read-failed">
      <strong>
        {title}: {label}
      </strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Nothing is shown here rather than a guess.</p>
    </div>
  );
}

export function CellValueView({ cell }: { cell: Cell }) {
  return <>{formatCell(cell)}</>;
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
}

export function ListView({ spec, data, ctx, openKey, onOpen }: ListViewProps) {
  if (data.rows.length === 0) {
    return (
      <p className="dk-muted" data-testid="list-empty">
        {spec.emptyText}
      </p>
    );
  }
  const head = tableCells(data.rows[0]!);
  return (
    <div className="dk-stack" data-testid="list">
      <p className="dk-muted" data-testid="list-count">
        {rowCountText(data.rows.length, data.pageFull, spec.page)}
      </p>
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

export interface ReadBlockProps {
  readonly spec: ReadSpec;
  readonly outcome: ReadOutcome | undefined;
  readonly ctx: RowActionContext;
  readonly openKey: string | null;
  readonly onOpen: (key: string | null) => void;
}

export function ReadBlock({ spec, outcome, ctx, openKey, onOpen }: ReadBlockProps) {
  return (
    <section className="dk-stack" data-testid={`read-${spec.id}`} aria-label={spec.title}>
      <div>
        <h3>{spec.title}</h3>
        <p className="dk-muted">{spec.note}</p>
        <p className="dk-asof">{outcome ? `As of ${outcome.asOf} (when this console read ${spec.module})` : 'Not read yet'}</p>
      </div>
      {!outcome && <p className="dk-why">This part was not read. Nothing is shown rather than a guess.</p>}
      {outcome?.part.kind === 'failed' && <Failed title={spec.title} part={outcome.part} />}
      {outcome?.part.kind === 'ok' && outcome.part.data.shape === 'record' && <RecordFacts cells={outcome.part.data.cells} />}
      {outcome?.part.kind === 'ok' && outcome.part.data.shape === 'list' && (
        <ListView spec={spec} data={outcome.part.data} ctx={ctx} openKey={openKey} onOpen={onOpen} />
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
        <ReadBlock key={spec.id} spec={spec} outcome={view?.reads[spec.id]} ctx={ctx} openKey={openKey} onOpen={onOpen} />
      ))}
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
  const counts = view ? Object.values(view.reads) : [];
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
        <span className="dk-asof">{view ? `Read started ${view.asOf}` : 'No read yet'}</span>
        {view && (
          <Chip tone={failed === 0 ? 'live' : 'warn'}>
            {counts.length - failed} of {counts.length} reads answered
          </Chip>
        )}
      </div>
      {stale && view && (
        <p className="dk-why" role="alert" data-testid="stale">
          The last refresh did not reach the console’s server, so this is the earlier read, from {view.asOf}.
        </p>
      )}
      {!view && <p className="dk-why">The console could not reach its own server for this desk. Nothing is shown rather than a guess.</p>}
      <nav aria-label="Sections" className="dk-row">
        {spec.sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.title}
          </a>
        ))}
      </nav>
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
    const next = await fetchDesk(spec.id);
    if (mine === sequence.current) {
      // A failed refresh keeps the last good read on screen with its own time, rather than blanking the page.
      if (next) setView(next);
      setStale(next === null);
      setLoading(false);
    }
  }, [spec.id]);
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
