'use client';

import { useState } from 'react';
import { Badge, Table, sortRows, type SortState, type TableColumn } from '@intafaced/ui';
import type { RestrictionHistoryRow } from '@/lib/trade-ops/restrictions';

/** Restriction history of one account, newest first by default; every outcome the service recorded, in words. */
export function ApprovalsHistory({ rows, label = 'Restriction history' }: { rows: readonly RestrictionHistoryRow[]; label?: string }) {
  const [sort, setSort] = useState<SortState | null>({ columnId: 'at', direction: 'desc' });
  const columns: TableColumn<RestrictionHistoryRow>[] = [
    {
      id: 'at',
      header: 'Time (UTC)',
      value: (r) => r.at.replace('T', ' ').slice(0, 19),
      sortValue: (r) => r.at,
      sortable: true,
      width: 160,
    },
    { id: 'action', header: 'Asked', value: (r) => (r.action === 'restrict' ? 'Restrict' : 'Lift'), sortable: true, width: 90 },
    {
      id: 'outcome',
      header: 'Outcome',
      cell: (r) => (
        <Badge tone={r.outcome === 'changed' ? 'lime' : r.outcome === 'noop' ? 'neutral' : 'error'} density="dense">
          {r.outcome === 'changed' ? 'Changed' : r.outcome === 'noop' ? 'No change' : r.outcome === 'conflict' ? 'Conflict' : 'Refused'}
        </Badge>
      ),
      sortValue: (r) => r.outcome,
      sortable: true,
      width: 110,
    },
    { id: 'summary', header: 'What happened', value: (r) => r.summary },
    { id: 'reason', header: 'Reason', value: (r) => r.reason, width: 200 },
  ];
  const sorted = sort ? sortRows(rows, columns, sort) : [...rows];
  return (
    <Table
      label={label}
      density="dense"
      columns={columns}
      rows={sorted}
      getRowId={(r) => r.auditId}
      sort={sort}
      onSortChange={setSort}
      maxHeight={360}
      emptyState={<p className="p-4 text-sm text-fg-2">The service has no restriction entries for this account.</p>}
    />
  );
}
