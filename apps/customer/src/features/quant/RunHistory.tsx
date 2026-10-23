import {
  QUANT_RUN_LABEL_MAX,
  quantBacktestHistorySchema,
  quantBacktestResultSchema,
  type QuantBacktestHistoryRow,
  type QuantBacktestMetrics,
  type QuantBacktestResult,
  type QuantMetric,
} from '@intafaced/contracts/quant-algo';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Panel } from '../../shared/ui';
import { Read } from '../more/common';
import { useApi } from '../session/session';
import './algo.css';
import { backtestCopy } from './backtest-copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const HISTORY_PAGE = 20;
const renamed = z.object({ runId: z.string(), label: z.string() });

/** The figures a comparison shows, in a fixed order. Runs are never sorted by return. */
type Figure = keyof QuantBacktestMetrics['returns'] | keyof QuantBacktestMetrics['risk'] | keyof QuantBacktestMetrics['trades'];
const COMPARED: readonly (readonly ['returns' | 'risk' | 'trades', Figure])[] = [
  ['returns', 'net'],
  ['returns', 'netPercent'],
  ['returns', 'profitFactor'],
  ['returns', 'expectedPayoff'],
  ['risk', 'maxDrawdown'],
  ['risk', 'maxDrawdownPercent'],
  ['risk', 'maxRunUp'],
  ['trades', 'roundTrips'],
  ['trades', 'winRate'],
];

const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/**
 * Run history (AL-backtest-03): the account's own bar backtests newest first, with label, version and outcome. Open
 * shows a stored run; Rename names it without touching its result; two ticked runs compare side by side, in the order
 * the list shows them.
 */
export function RunHistory({ refresh, onOpen }: { refresh: string; onOpen: (result: QuantBacktestResult) => void }) {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useResource(
    (signal) => api.query('quant', 'backtest.history', { limit: HISTORY_PAGE, cursor }, quantBacktestHistorySchema, { signal }),
    `quant-backtest-history:${refresh}:${cursor ?? ''}`,
  );
  const [editing, setEditing] = useState<{ runId: string; label: string } | null>(null);
  const [renameFailure, setRenameFailure] = useState<Failed | null>(null);
  // The ticked rows themselves, so a pick on another page is kept, and compared newest first as the list orders them.
  const [picked, setPicked] = useState<QuantBacktestHistoryRow[]>([]);
  // A new run is stored at the top of the list, so the list goes back to its first page to show it.
  useEffect(() => setCursor(null), [refresh]);
  const [openFailure, setOpenFailure] = useState<Failed | null>(null);

  async function open(runId: string) {
    setOpenFailure(null);
    const res = await api.query('quant', 'backtest.result', { runId }, quantBacktestResultSchema);
    if (res.ok) onOpen(res.data);
    else setOpenFailure(res);
  }

  async function rename() {
    if (!editing) return;
    setRenameFailure(null);
    const res = await api.mutate('quant', 'backtest.rename', editing, renamed);
    if (!res.ok) {
      setRenameFailure(res);
      return;
    }
    setEditing(null);
    list.reload();
  }

  const isPicked = (runId: string) => picked.some((row) => row.runId === runId);
  // At most two: ticking a third is refused (the box stays clear) rather than silently dropping an earlier pick.
  const toggle = (row: QuantBacktestHistoryRow) =>
    setPicked((now) =>
      now.some((one) => one.runId === row.runId) ? now.filter((one) => one.runId !== row.runId) : now.length < 2 ? [...now, row] : now,
    );

  return (
    <Panel title={t('historyTitle')}>
      <div data-testid="quant-run-history">
        <p className="muted">{t('historyIntro')}</p>
        <Read resource={list.resource} retry={list.reload}>
          {(data) => {
            if (!data.runs.length) return <EmptyState title={t('historyNone')}>{t('historyNoneBody')}</EmptyState>;
            const ordered = [...picked].sort((a, b) =>
              a.started === b.started ? (a.runId < b.runId ? 1 : -1) : a.started < b.started ? 1 : -1,
            );
            return (
              <>
                <DataTable
                  headers={[t('compareTick'), t('runLabel'), t('runVersion'), t('runOutcome'), t('runStarted'), t('runActions')]}
                  label={t('historyTitle')}
                >
                  {data.runs.map((row) => (
                    <HistoryRow
                      key={row.runId}
                      row={row}
                      picked={isPicked(row.runId)}
                      full={picked.length === 2}
                      onPick={() => toggle(row)}
                      editing={editing?.runId === row.runId ? editing.label : null}
                      onEdit={(label) => setEditing({ runId: row.runId, label })}
                      onCancel={() => setEditing(null)}
                      onSave={() => void rename()}
                      onOpen={() => void open(row.runId)}
                    />
                  ))}
                </DataTable>
                {cursor !== null && (
                  <Button type="button" onClick={() => setCursor(null)}>
                    {t('historyNewest')}
                  </Button>
                )}
                {data.nextCursor && (
                  <Button type="button" onClick={() => setCursor(data.nextCursor)}>
                    {t('historyMore')}
                  </Button>
                )}
                {renameFailure && <Failure result={renameFailure} retry={() => void rename()} />}
                {openFailure && <Failure result={openFailure} />}
                {ordered.length === 2 ? <Compare runs={ordered} /> : <p className="muted">{t('compareHint')}</p>}
              </>
            );
          }}
        </Read>
      </div>
    </Panel>
  );
}

function HistoryRow({
  row,
  picked,
  full,
  onPick,
  editing,
  onEdit,
  onCancel,
  onSave,
  onOpen,
}: {
  row: QuantBacktestHistoryRow;
  picked: boolean;
  full: boolean;
  onPick: () => void;
  editing: string | null;
  onEdit: (label: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onOpen: () => void;
}) {
  const { t } = backtestCopy.useCopy();
  const outcome =
    row.outcome === null ? t('outcomeRunning') : row.outcome === 'ok' ? t('outcomeOk') : t('outcomeRefused', { code: row.outcome });
  return (
    <tr data-testid="quant-run-row" data-run-id={row.runId} data-started={row.started} data-label={row.label ?? ''}>
      <td>
        <input
          type="checkbox"
          className="quant-run-check"
          checked={picked}
          onChange={onPick}
          disabled={row.outcome !== 'ok' || (full && !picked)}
          aria-label={t('compareThis', { run: row.label ?? row.runId })}
        />
      </td>
      <td>
        {editing === null ? (
          <span data-testid="quant-run-label">{row.label ?? t('runUnnamed')}</span>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
          >
            <Field label={t('runLabel')} value={editing} maxLength={QUANT_RUN_LABEL_MAX} onChange={(e) => onEdit(e.target.value)} />
            <Button type="submit">{t('renameSave')}</Button>
            <Button type="button" onClick={onCancel}>
              {t('renameCancel')}
            </Button>
          </form>
        )}
      </td>
      <td lang="zxx">{row.strategyVersion === null ? '—' : t('versionOf', { version: row.strategyVersion })}</td>
      <td>{outcome}</td>
      <td lang="zxx">{minute(row.started)}</td>
      <td>
        <Button type="button" onClick={onOpen} disabled={row.outcome !== 'ok'}>
          {t('runOpen')}
        </Button>
        {editing === null && (
          <Button type="button" onClick={() => onEdit(row.label ?? '')}>
            {t('rename')}
          </Button>
        )}
      </td>
    </tr>
  );
}

/** Two stored runs side by side: the same figures in the same order, columns in the order the list shows them. */
function Compare({ runs }: { runs: readonly QuantBacktestHistoryRow[] }) {
  const api = useApi();
  const { t } = backtestCopy.useCopy();
  const [first, second] = runs as [QuantBacktestHistoryRow, QuantBacktestHistoryRow];
  const read = useResource(async (signal) => {
    const [a, b] = await Promise.all(
      [first, second].map((row) => api.query('quant', 'backtest.result', { runId: row.runId }, quantBacktestResultSchema, { signal })),
    );
    if (!a!.ok) return a!;
    if (!b!.ok) return b!;
    return { ok: true as const, data: [a!.data, b!.data] as const };
  }, `quant-compare:${first.runId}:${second.runId}`);
  const shown = (metric: QuantMetric | number) =>
    typeof metric === 'number' ? String(metric) : (metric.value ?? t('compareUndefined', { reason: metric.reason ?? '' }));
  return (
    <section aria-label={t('compareTitle')} data-testid="quant-run-compare">
      <h4>{t('compareTitle')}</h4>
      <p className="muted">{t('compareIntro')}</p>
      {read.resource.status === 'loading' && <Loading />}
      {read.resource.status === 'failed' && <Failure result={read.resource.failure} retry={read.reload} />}
      {read.resource.status === 'ready' && (
        <DataTable headers={[t('compareFigure'), ...runs.map((row) => row.label ?? row.runId)]} label={t('compareTitle')}>
          {COMPARED.map(([group, key]) => (
            <tr key={key} data-testid="quant-compare-row" data-metric={key}>
              <td>{t(`m_${key}`)}</td>
              {read.resource.status === 'ready' &&
                read.resource.data.map((result) => {
                  const figures = result.metrics[group] as unknown as Record<string, QuantMetric | number>;
                  return (
                    <td key={result.runId} lang="zxx" data-run-id={result.runId}>
                      {shown(figures[key]!)}
                    </td>
                  );
                })}
            </tr>
          ))}
        </DataTable>
      )}
    </section>
  );
}
