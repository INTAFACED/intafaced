'use client';

import { Table, type TableColumn } from '@intafaced/ui';
import { SWITCH_EXPLAINERS, TRADE_ALWAYS_ALLOWED, type SwitchExplainer } from '@/lib/trade-ops/kill-switch-model';

/** What each switch does and does not do, so an operator never reaches for the wrong one (TRD-0193). */
export function KillSwitchExplainer() {
  const columns: TableColumn<SwitchExplainer>[] = [
    { id: 'name', header: 'Switch', value: (r) => r.name, width: 220 },
    { id: 'stops', header: 'What it stops', value: (r) => r.stops },
    { id: 'not', header: 'What it does not do', value: (r) => r.doesNotStop },
  ];
  return (
    <div className="flex flex-col gap-3">
      <Table<SwitchExplainer>
        label="What each switch does and does not do"
        density="dense"
        columns={columns}
        rows={SWITCH_EXPLAINERS}
        getRowId={(r) => r.name}
      />
      <div className="text-sm text-fg-2">
        <p className="font-medium text-fg">While the trade module is stopped, the edge still lets these through</p>
        <ul className="mt-1 list-disc pl-5">
          {TRADE_ALWAYS_ALLOWED.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="mt-2">
          Everything else that commits a new order is refused with <code className="if-num text-xs">edge.module_killed</code> (503,
          retry-after 30).
        </p>
      </div>
    </div>
  );
}
