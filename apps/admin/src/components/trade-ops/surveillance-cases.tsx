'use client';

import { useState, type ReactNode } from 'react';
import { Badge, KeyValue, Table, type TableColumn } from '@intafaced/ui';
import { STATE_LABEL, type SurveillanceCase } from '@/lib/trade-ops/surveillance-model';
import { SurveillanceAdjudicate } from './surveillance-adjudicate';

/**
 * Case list, detail and decision form. The table is fully built. When the cases cannot be read, `unreadable`
 * is drawn in place of rows, so an empty table is never mistaken for "no cases". Detail shows the selected case.
 */
export function SurveillanceCases({ cases, unreadable }: { cases: readonly SurveillanceCase[]; unreadable: ReactNode | null }) {
  const [selected, setSelected] = useState<SurveillanceCase | null>(null);
  const columns: TableColumn<SurveillanceCase>[] = [
    { id: 'id', header: 'Case', value: (c) => c.id, sortable: true, width: 160 },
    { id: 'market', header: 'Market', value: (c) => c.market, sortable: true, width: 120 },
    { id: 'account', header: 'Account', value: (c) => c.accountId },
    { id: 'detector', header: 'Detector', cell: (c) => <Badge density="dense">{c.detector}</Badge>, value: (c) => c.detector, width: 110 },
    {
      id: 'window',
      header: 'Window (UTC)',
      value: (c) => `${c.windowStart.slice(0, 19).replace('T', ' ')} to ${c.windowEnd.slice(11, 19)}`,
    },
    {
      id: 'state',
      header: 'State',
      cell: (c) => (
        <Badge tone={c.state === 'adjudicated' ? 'lime' : 'warn'} variant="outline" density="dense">
          {STATE_LABEL[c.state]}
        </Badge>
      ),
      value: (c) => c.state,
      width: 130,
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
          getRowId={(c) => c.id}
          selection="single"
          selectedIds={new Set(selected ? [selected.id] : [])}
          onSelectionChange={(ids) => setSelected(cases.find((c) => ids.has(c.id)) ?? null)}
          onRowActivate={setSelected}
          emptyState={unreadable ?? undefined}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {selected ? (
          <KeyValue
            density="dense"
            items={[
              { label: 'Case', value: selected.id, mono: true },
              { label: 'Market', value: selected.market },
              { label: 'Account', value: selected.accountId, mono: true },
              { label: 'Detector', value: selected.detector },
              { label: 'Window start (UTC)', value: selected.windowStart },
              { label: 'Window end (UTC)', value: selected.windowEnd },
              { label: 'State', value: STATE_LABEL[selected.state] },
              { label: 'Evidence', value: selected.evidence.length ? selected.evidence.join('; ') : null },
            ]}
          />
        ) : (
          <p className="text-sm text-fg-2">
            {unreadable ? 'No case can be opened: the cases are not readable (see the left panel).' : 'Select a case to see its detail.'}
          </p>
        )}
        <SurveillanceAdjudicate caseId={selected?.id ?? ''} />
      </div>
    </div>
  );
}
