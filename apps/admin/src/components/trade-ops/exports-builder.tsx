'use client';

import { useState } from 'react';
import { Badge, Button, Field, Input, KeyValue, SegmentedControl, Switch } from '@intafaced/ui';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import { DATASET_LABEL, EXPORT_DATASETS, toCsv, type ExportDataset, type PreparedExport } from '@/lib/trade-ops/csv';
import type { Outcome } from '@/lib/trade-ops/outcome';
import { validateUserId } from '@/lib/trade-ops/restrictions';
import { OutcomeNotice } from './outcome-notice';

/**
 * Save what the desk can really read as a CSV. Three steps, so nothing is downloaded blind:
 * pick the data, read it (the console fetches the rows), then check the file name, row count, as-of time and
 * columns before pressing Download. The file is written in this browser from those rows.
 */
export function ExportsBuilder() {
  const [dataset, setDataset] = useState<ExportDataset>('open_orders');
  const [includeSeeded, setIncludeSeeded] = useState(false);
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Outcome<PreparedExport> | null>(null);

  const userCheck = dataset === 'restriction_history' ? validateUserId(userId) : null;
  const canRead = dataset !== 'restriction_history' || !!userCheck?.ok;

  async function read() {
    setBusy(true);
    setPrepared(null);
    const out = await tradeOpsAction<PreparedExport>('exports', { action: 'prepare', dataset, includeSeeded, userId });
    setBusy(false);
    setPrepared(out);
  }

  function download(p: PreparedExport) {
    const blob = new Blob([toCsv(p.columns, p.rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = p.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        aria-label="What to export"
        size={32}
        value={dataset}
        onValueChange={(v) => {
          setDataset((EXPORT_DATASETS as readonly string[]).includes(v) ? (v as ExportDataset) : 'open_orders');
          setPrepared(null);
        }}
        items={EXPORT_DATASETS.map((d) => ({ value: d, label: DATASET_LABEL[d] }))}
      />
      {dataset === 'open_orders' ? (
        <label className="flex items-center gap-3 text-sm text-fg">
          <Switch checked={includeSeeded} onCheckedChange={setIncludeSeeded} aria-label="Include seeded rows" />
          Include seeded rows (market-maker orders, marked seeded = yes)
        </label>
      ) : null}
      {dataset === 'restriction_history' ? (
        <Field
          label="Account user id"
          error={userId.trim() && userCheck && !userCheck.ok ? userCheck.message : undefined}
          density="dense"
          className="w-[26rem] max-w-full"
        >
          <Input
            value={userId}
            onValueChange={setUserId}
            density="dense"
            autoComplete="off"
            spellCheck={false}
            placeholder="3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f"
          />
        </Field>
      ) : null}
      <div>
        <Button type="button" variant="secondary" shape="rounded" size={32} loading={busy} disabled={!canRead} onClick={read}>
          Read the data
        </Button>
      </div>

      {prepared && prepared.kind !== 'ok' ? <OutcomeNotice outcome={prepared} /> : null}
      {prepared?.kind === 'ok' ? (
        <div className="flex flex-col gap-3 rounded-sm border border-line bg-panel p-3">
          <KeyValue
            density="dense"
            items={[
              { label: 'File name', value: prepared.data.filename, mono: true },
              { label: 'Rows', value: String(prepared.data.rows.length), hint: 'Not counting the header row.' },
              { label: 'As of (UTC)', value: prepared.asOf.replace('T', ' ').slice(0, 19) },
            ]}
          />
          <div className="text-sm">
            <p className="mb-1 text-fg-2">Columns ({prepared.data.columns.length}), in file order</p>
            <p className="flex flex-wrap gap-1">
              {prepared.data.columns.map((c) => (
                <Badge key={c} density="dense">
                  {c}
                </Badge>
              ))}
            </p>
          </div>
          {prepared.data.notes.map((n) => (
            <p key={n} className="text-xs text-fg-3">
              {n}
            </p>
          ))}
          {prepared.data.rows.length === 0 ? (
            <p className="text-sm text-warn">There are no rows to save. The file would hold only the header row.</p>
          ) : null}
          <p className="text-xs text-fg-3">
            Numbers are written exactly as the service sent them. Text that a spreadsheet could run as a formula is saved with a leading
            apostrophe.
          </p>
          <div>
            <Button type="button" variant="primary" shape="rounded" size={32} onClick={() => download(prepared.data)}>
              Download CSV
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
