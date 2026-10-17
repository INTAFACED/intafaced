'use client';

import { useMemo, useState } from 'react';
import {
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  sortRows,
  type SortState,
  type TableColumn,
} from '@intafaced/ui';
import {
  NO_FILTER,
  WINDOW_LABEL,
  filterAudit,
  modulesOf,
  type AuditFilter,
  type AuditRow,
  type TimeWindow,
} from '@/lib/trade-ops/audit-rows';

/**
 * One audit table with its filter bar (actor, module, time window) and sortable columns:
 * time, actor, action, target, reason, outcome, request id. Rows arrive already read; a filter that hides
 * everything says so, instead of showing the same words as "no entries".
 */
export function AuditTable({ rows, label, emptyText }: { rows: readonly AuditRow[]; label: string; emptyText: string }) {
  const [filter, setFilter] = useState<AuditFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortState | null>({ columnId: 'at', direction: 'desc' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [rows, filter.window]);
  const modules = modulesOf(rows);
  const columns: TableColumn<AuditRow>[] = [
    {
      id: 'at',
      header: 'Time (UTC)',
      value: (r) => r.at.replace('T', ' ').slice(0, 19),
      sortValue: (r) => r.at,
      sortable: true,
      width: 160,
    },
    { id: 'actor', header: 'Actor', value: (r) => r.actor, sortable: true, width: 200 },
    { id: 'action', header: 'Action', value: (r) => r.action, sortable: true, width: 200 },
    { id: 'target', header: 'Target', value: (r) => r.target, sortable: true, width: 240 },
    { id: 'reason', header: 'Reason', value: (r) => r.reason, sortable: true, width: 280 },
    { id: 'outcome', header: 'Outcome', value: (r) => r.outcome, sortable: true, width: 200 },
    { id: 'requestId', header: 'Request id', value: (r) => r.requestId, width: 120 },
  ];
  const shown = sortRows(filterAudit(rows, filter, now), columns, sort);
  const filtered = rows.length > 0 && shown.length === 0;
  const windowItems = Object.fromEntries((Object.keys(WINDOW_LABEL) as TimeWindow[]).map((k) => [k, WINDOW_LABEL[k]]));
  const moduleItems = { all: 'All modules', ...Object.fromEntries(modules.map((m) => [m, m])) };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Actor" density="dense" className="w-52">
          <Input
            value={filter.actor}
            onValueChange={(actor) => setFilter({ ...filter, actor })}
            density="dense"
            placeholder="Part of a name or id"
            autoComplete="off"
          />
        </Field>
        <Field label="Module" density="dense">
          <Select items={moduleItems} value={filter.module} onValueChange={(v) => setFilter({ ...filter, module: String(v ?? 'all') })}>
            <SelectTrigger size={32} className="w-44" aria-label="Module">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(moduleItems).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Time" density="dense">
          <Select
            items={windowItems}
            value={filter.window}
            onValueChange={(v) => setFilter({ ...filter, window: String(v ?? 'all') as TimeWindow })}
          >
            <SelectTrigger size={32} className="w-44" aria-label="Time window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(windowItems).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <p className="pb-2 text-xs text-fg-3" aria-live="polite">
          Showing {shown.length} of {rows.length}
        </p>
      </div>
      <Table
        label={label}
        density="dense"
        columns={columns}
        rows={shown}
        getRowId={(r) => r.id}
        sort={sort}
        onSortChange={setSort}
        maxHeight={420}
        emptyState={
          <p className="p-4 text-sm text-fg-2">{filtered ? 'No entries match these filters. Clear them to see all of them.' : emptyText}</p>
        }
      />
    </div>
  );
}
