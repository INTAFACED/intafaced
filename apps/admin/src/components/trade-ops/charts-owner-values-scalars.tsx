'use client';

import { useEffect, useState } from 'react';
import { Badge, Input, Table, type TableColumn } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import {
  CHART_SCALARS,
  READ_ONLY_TEXT,
  parseWholeNumberText,
  scalarText,
  typedText,
  type ChartOwnerValuesView,
  type ChartScalarKey,
} from '@/lib/trade-ops/charts-owner-values-model';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { ConfirmAction } from './confirm-action';

/**
 * The five counts. Each row is one write: type the new whole number (blank clears it), then confirm with a reason. The
 * service decides the bounds and refuses an out-of-range count in words. A count that is not set refuses the customer
 * action that needs it, which is why the page says "Not set" plainly rather than showing a default.
 */
export function ChartScalarsForm({ view, onChanged }: { view: ChartOwnerValuesView; onChanged: (next: ChartOwnerValuesView) => void }) {
  const [draft, setDraft] = useState<Record<ChartScalarKey, string>>(() => typedText(view.scalars.values));
  useEffect(() => setDraft(typedText(view.scalars.values)), [view]);
  const version = view.scalars.version ?? '0';

  const columns: TableColumn<(typeof CHART_SCALARS)[number]>[] = [
    { id: 'setting', header: 'Setting', width: 220, value: (s) => s.label },
    { id: 'meaning', header: 'What it sets', value: (s) => s.meaning },
    {
      id: 'current',
      header: 'Current',
      numeric: true,
      width: 120,
      value: (s) => scalarText(view.scalars.values[s.key]),
      cell: (s) =>
        view.scalars.values[s.key] === null ? (
          <Badge tone="neutral" variant="outline" density="dense">
            Not set
          </Badge>
        ) : (
          <span className="if-num">{scalarText(view.scalars.values[s.key])}</span>
        ),
    },
    {
      id: 'next',
      header: 'New value (blank clears it)',
      width: 200,
      value: () => null,
      cell: (s) => {
        const typed = parseWholeNumberText(draft[s.key]);
        return (
          <Input
            aria-label={`${s.label}: new value`}
            value={draft[s.key]}
            onValueChange={(v) => setDraft((prev) => ({ ...prev, [s.key]: v }))}
            density="dense"
            autoComplete="off"
            spellCheck={false}
            disabled={!view.canWrite}
            aria-invalid={!typed.ok}
          />
        );
      },
    },
    {
      id: 'save',
      header: '',
      width: 130,
      value: () => null,
      cell: (s) => {
        const typed = parseWholeNumberText(draft[s.key]);
        const unchanged = typed.ok && typed.value === view.scalars.values[s.key];
        const disabledReason = !view.canWrite ? READ_ONLY_TEXT : !typed.ok ? typed.message : unchanged ? 'Nothing to change.' : undefined;
        return (
          <ConfirmAction
            trigger="Save"
            title={`Change ${s.label}?`}
            consequence={`${s.label} changes from ${scalarText(view.scalars.values[s.key])} to ${
              typed.ok && typed.value !== null ? typed.value : 'not set'
            }. ${s.meaning} The customer action that needs it refuses while it is not set.`}
            confirmLabel="Save value"
            reasonMin={12}
            disabled={disabledReason !== undefined}
            disabledReason={disabledReason}
            run={(reason): Promise<Outcome<unknown>> =>
              tradeOpsAction<ChartOwnerValuesView>('charts-settings', {
                action: 'set',
                key: s.key,
                value: draft[s.key],
                expectedVersion: version,
                reason,
              })
            }
            onDone={(o) => {
              if (o.kind === 'ok') onChanged(o.data as ChartOwnerValuesView);
            }}
          />
        );
      },
    },
  ];

  return (
    <Table<(typeof CHART_SCALARS)[number]>
      label="Owner counts"
      density="dense"
      columns={columns}
      rows={CHART_SCALARS}
      getRowId={(s) => s.key}
    />
  );
}
