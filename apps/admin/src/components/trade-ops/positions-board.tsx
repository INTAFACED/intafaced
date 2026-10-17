'use client';

import { useState } from 'react';
import { Badge, Button, EmptyState, Field, Input, KeyValue, Table, type TableColumn } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { checkLookup, marginRatioText, positionStatusWord, type PositionRow } from '@/lib/trade-ops/positions-model';
import { BlockerPanel } from './blocker-panel';
import { OutcomeNotice } from './outcome-notice';

/**
 * Positions room, fully laid out: lookup form (user id, position id), the table with every column an operator needs,
 * and the detail pane. A search is a real request; today it answers with the typed refusal positions_cross_user_missing,
 * shown above the empty column layout. There are no rows to show and none are invented.
 */

const rows: readonly PositionRow[] = [];

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
          {p.status === 'liquidation_in_progress' ? '◆ ' : ''}
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
  const [result, setResult] = useState<Outcome<unknown> | null>(null);
  const [selected, setSelected] = useState<PositionRow | null>(null);

  async function search() {
    const check = checkLookup({ userId, positionId });
    if (!check.ok) return setFormError(check.message);
    setFormError(null);
    setBusy(true);
    setResult(await tradeOpsAction('positions', check.value));
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
        result.kind === 'refused' && result.blocker ? (
          <div className="flex flex-col gap-2">
            <BlockerPanel blocker={result.blocker} title="Positions cannot be looked up by an operator" />
            <OutcomeNotice outcome={result} />
          </div>
        ) : (
          <OutcomeNotice outcome={result} />
        )
      ) : (
        <p className="text-sm text-fg-2">Search by user id, position id or both. The answer, or the reason there is none, appears here.</p>
      )}

      <p className="border border-line px-3 py-2 text-sm text-fg-2">
        <Badge tone="neutral" variant="outline" density="dense">
          Futures off
        </Badge>{' '}
        TRADE_FUTURES_ENABLED stays off: there is no futures market and no second matching book, so positions here will only ever appear for
        products that are switched on.
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
          emptyState={<EmptyState variant="empty" size="inline" title="No positions loaded: nothing has been read" />}
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
