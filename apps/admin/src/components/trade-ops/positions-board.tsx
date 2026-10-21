'use client';

import { useState } from 'react';
import { Badge, Button, EmptyState, Field, Input, KeyValue, Table, type TableColumn } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { checkLookup, marginRatioText, positionStatusWord, type PositionRow, type PositionsAnswer } from '@/lib/trade-ops/positions-model';
import { OutcomeNotice } from './outcome-notice';

/**
 * Positions room: lookup form (user id, position id), the table and the detail pane. A search is a real request to
 * svc-trade's operator read. Mark price, liquidation price, margin ratio and PnL are not served yet, so they draw a
 * dash (not read, never zero). A refusal is shown in words with the service's own code.
 */

const columns: TableColumn<PositionRow>[] = [
  { id: 'market', header: 'Market', value: (p) => p.market, sortable: true },
  { id: 'side', header: 'Side', value: (p) => (p.side === 'long' ? '▲ Long' : '▼ Short'), width: 80 },
  { id: 'size', header: 'Size', numeric: true, sortable: true, value: (p) => p.size },
  { id: 'entry', header: 'Entry price', numeric: true, sortable: true, value: (p) => p.entryPrice },
  { id: 'mark', header: 'Mark price', numeric: true, sortable: true, value: (p) => p.markPrice },
  { id: 'liq', header: 'Liquidation price', numeric: true, sortable: true, value: (p) => p.liquidationPrice },
  {
    id: 'margin',
    header: 'Margin ratio',
    numeric: true,
    sortable: true,
    value: (p) => p.marginRatio,
    cell: (p) => marginRatioText(p.marginRatio) ?? '—',
  },
  { id: 'pnl', header: 'Unrealised PnL', numeric: true, sortable: true, value: (p) => p.unrealisedPnl },
  {
    id: 'status',
    header: 'Status',
    width: 170,
    value: (p) => positionStatusWord(p.status).label,
    cell: (p) => {
      const w = positionStatusWord(p.status);
      return (
        <Badge tone={w.tone} variant="outline" density="dense">
          {p.status === 'liquidation_in_progress' || p.status === 'liquidated' ? '◆ ' : ''}
          {w.label}
        </Badge>
      );
    },
  },
];

export function PositionsBoard() {
  const [userId, setUserId] = useState('');
  const [positionId, setPositionId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome<PositionsAnswer> | null>(null);
  const [selected, setSelected] = useState<PositionRow | null>(null);
  const rows: readonly PositionRow[] = result?.kind === 'ok' ? result.data.rows : [];

  async function search() {
    const check = checkLookup({ userId, positionId });
    if (!check.ok) return setFormError(check.message);
    setFormError(null);
    setBusy(true);
    setSelected(null);
    setResult(await tradeOpsAction<PositionsAnswer>('positions', check.value));
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Field label="User id" density="dense">
          <Input value={userId} onValueChange={setUserId} density="dense" />
        </Field>
        <Field label="Position id" density="dense">
          <Input value={positionId} onValueChange={setPositionId} density="dense" />
        </Field>
        <Button type="submit" size={32} variant="secondary" shape="rounded" loading={busy}>
          Look up positions
        </Button>
      </form>
      {formError ? (
        <p role="alert" className="text-sm text-error-text">
          {formError}
        </p>
      ) : null}

      {result ? (
        <OutcomeNotice outcome={result} doneText={`${rows.length} read`} />
      ) : (
        <p className="text-sm text-fg-2">Search by user id, position id or both. The answer, or the reason there is none, appears here.</p>
      )}
      {result?.kind === 'ok' && result.data.nextCursor ? (
        <p className="text-sm text-fg-2">More positions exist for this user than one page shows; narrow the search with a position id.</p>
      ) : null}

      <p className="border border-line px-3 py-2 text-sm text-fg-2">
        <Badge tone="neutral" variant="outline" density="dense">
          Futures
        </Badge>{' '}
        Positions exist only for products that are switched on. Mark price, liquidation price, margin ratio and PnL are not served by the
        operator read, so those columns show a dash.
      </p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Table
          label="Positions"
          columns={columns}
          rows={rows}
          getRowId={(p) => p.id}
          density="dense"
          selection="single"
          selectedIds={new Set(selected ? [selected.id] : [])}
          onSelectionChange={(ids) => setSelected(rows.find((r) => ids.has(r.id)) ?? null)}
          emptyState={
            <EmptyState
              variant="empty"
              size="inline"
              title={result?.kind === 'ok' ? 'No positions found for that search' : 'No positions loaded: nothing has been read'}
            />
          }
        />
        <section aria-label="Position detail" className="border border-line p-3">
          <h2 className="mb-2 text-sm font-medium">Position detail</h2>
          <KeyValue
            density="dense"
            items={[
              { label: 'Position id', value: selected?.id ?? null, mono: true },
              { label: 'User id', value: selected?.userId ?? null, mono: true },
              { label: 'Market', value: selected?.market ?? null },
              { label: 'Side', value: selected ? selected.side : null },
              { label: 'Size', value: selected?.size ?? null },
              { label: 'Opened', value: selected?.openedAt ?? null },
              { label: 'Entry price', value: selected?.entryPrice ?? null },
              { label: 'Mark price', value: selected?.markPrice ?? null },
              { label: 'Liquidation price', value: selected?.liquidationPrice ?? null },
              {
                label: 'Margin ratio',
                value: selected ? marginRatioText(selected.marginRatio) : null,
                hint: 'Maintenance margin / margin balance',
              },
              { label: 'Unrealised PnL', value: selected?.unrealisedPnl ?? null },
              { label: 'Status', value: selected ? positionStatusWord(selected.status).label : null },
            ]}
          />
          <p className="mt-2 text-xs text-fg-3">Select a row to fill this pane. A dash means not read, never zero.</p>
        </section>
      </div>
    </div>
  );
}
