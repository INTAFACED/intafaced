'use client';

import { Badge, Table, type TableColumn } from '@intafaced/ui';
import { ENGINE_CHECKS, type EngineCheck } from '@/lib/trade-ops/risk-limits-model';
import { BLOCKERS } from '@/lib/trade-ops/blockers';

/** Engine-side checks by name. The engine enforces them; the desk cannot read their values, and says so. */
export function RiskLimitsChecks() {
  const columns: TableColumn<EngineCheck>[] = [
    { id: 'name', header: 'Check', value: (c) => c.name, width: 180 },
    { id: 'what', header: 'What it does', value: (c) => c.what },
    {
      id: 'state',
      header: 'State',
      cell: () => (
        <Badge tone="warn" variant="outline" density="dense">
          Enforced, value not readable
        </Badge>
      ),
      width: 230,
    },
    { id: 'value', header: 'Value', value: () => null, align: 'end', width: 80 },
    {
      id: 'blocker',
      header: 'Blocked by',
      cell: () => <code className="if-num text-xs text-fg-2">{BLOCKERS.risk_limits_no_operator_api.key}</code>,
      width: 230,
    },
  ];
  return <Table<EngineCheck> label="Engine-side checks" density="dense" columns={columns} rows={ENGINE_CHECKS} getRowId={(c) => c.id} />;
}
