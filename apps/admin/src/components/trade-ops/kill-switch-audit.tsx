'use client';

import { Badge, EmptyState, Table, type TableColumn } from '@intafaced/ui';
import type { AuditEntry } from '@/lib/control-plane-contract';

/** The kill-switch audit tail for the trade module, newest first, in plain words. */
export function KillSwitchAudit({ entries }: { entries: readonly AuditEntry[] }) {
  const columns: TableColumn<AuditEntry>[] = [
    { id: 'at', header: 'At (UTC)', value: (e) => e.at.replace('T', ' ').slice(0, 19), width: 160 },
    {
      id: 'change',
      header: 'Change',
      cell: (e) =>
        e.changed ? (
          <Badge tone={e.next ? 'warn' : 'lime'} density="dense">
            {e.next ? 'Stopped' : 'Resumed'}
          </Badge>
        ) : (
          <Badge density="dense">No change</Badge>
        ),
      width: 110,
    },
    { id: 'actor', header: 'Changed by', value: (e) => e.actor, width: 300 },
    { id: 'confirm', header: 'Confirmed by', value: (e) => e.confirmOperatorId ?? null, width: 300 },
    { id: 'reason', header: 'Reason', value: (e) => e.reason, width: 320 },
  ];
  return (
    <Table<AuditEntry>
      label="Trade module kill switch audit"
      density="dense"
      columns={columns}
      rows={entries}
      getRowId={(e) => `${e.at}-${e.actor}-${e.next}`}
      emptyState={
        <EmptyState
          size="inline"
          title="No kill switch changes recorded"
          reason="The edge's audit holds no trade module change. This is what the edge reports, not a gap in this screen."
        />
      }
    />
  );
}
