'use client';

import { useState, type ReactNode } from 'react';
import { Badge, KeyValue, Table, type TableColumn } from '@intafaced/ui';
import type { SurveillanceCase } from '@/lib/trade-ops/surveillance-model';
import { SurveillanceAdjudicate } from './surveillance-adjudicate';

/**
 * Case list, detail and decision form. The rows are exactly what svc-matching presents (account, market, the detector's
 * reason, status). When the cases cannot be read, `unreadable` is drawn in place of rows, so an empty table is never
 * mistaken for "no cases"; `noCases` is only true after a successful read that returned none.
 */
const keyOf = (c: SurveillanceCase) => `${c.accountId}|${c.marketId}|${c.reason}`;

export function SurveillanceCases({
  cases,
  unreadable,
  noCases = false,
}: {
  cases: readonly SurveillanceCase[];
  unreadable: ReactNode | null;
  noCases?: boolean;
}) {
  const [selected, setSelected] = useState<SurveillanceCase | null>(null);
  const columns: TableColumn<SurveillanceCase>[] = [
    { id: 'account', header: 'Account', value: (c) => c.accountId, sortable: true },
    { id: 'market', header: 'Market', value: (c) => c.marketId, sortable: true, width: 200 },
    { id: 'reason', header: 'Reason', value: (c) => c.reason },
    {
      id: 'status',
      header: 'State',
      cell: () => (
        <Badge tone="warn" variant="outline" density="dense">
          Open
        </Badge>
      ),
      value: (c) => c.status,
      width: 100,
    },
  ];
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <Table<SurveillanceCase>
          label="Surveillance cases"
          density="dense"
          columns={columns}
          rows={cases}
          getRowId={keyOf}
          selection="single"
          selectedIds={new Set(selected ? [keyOf(selected)] : [])}
          onSelectionChange={(ids) => setSelected(cases.find((c) => ids.has(keyOf(c))) ?? null)}
          onRowActivate={setSelected}
          emptyState={
            unreadable ?? (noCases ? <p className="p-4 text-sm text-fg-2">The matching engine reports no open cases.</p> : undefined)
          }
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {selected ? (
          <KeyValue
            density="dense"
            items={[
              { label: 'Account', value: selected.accountId, mono: true },
              { label: 'Market', value: selected.marketId, mono: true },
              { label: 'Reason', value: selected.reason },
              { label: 'State', value: 'Open' },
            ]}
          />
        ) : (
          <p className="text-sm text-fg-2">
            {unreadable ? 'No case can be opened: the cases are not readable (see the left panel).' : 'Select a case to see its detail.'}
          </p>
        )}
        <SurveillanceAdjudicate caseId={selected ? keyOf(selected) : ''} />
      </div>
    </div>
  );
}
