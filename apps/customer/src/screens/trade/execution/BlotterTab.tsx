/**
 * Child orders and fills: open orders, recent closed orders and fills in one table. "Scaled" is matched by the id prefix
 * this room wrote; "Algo" by the children each schedule's own read lists, and otherwise only by market, side and time,
 * which the tab says and the export marks.
 */
import { useMemo, useState } from 'react';
import { Button, SegmentedControl } from '../rooms/ui';
import { Freshness } from '../rooms/RoomNotices';
import { useClosedOrders, useFills, useOpenOrders, useRefreshPrivate } from '../desk/data';
import { execCopy } from './copy';
import type { ParentRead } from './data';
import { algoWindows, blotterCsv, buildBlotter, childParents, filterBlotter, type BlotterFilter, type Source } from './blotter';
import { scaledGroupOf } from './model';
import { BlotterTable, useCancelFlow } from './OrdersView';
import { Gate, Pick, Why } from './parts';

function download(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'what-you-see.csv';
  link.click();
  URL.revokeObjectURL(url);
}

export function BlotterTab({ parents }: { parents: readonly ParentRead[] }) {
  const { t } = execCopy.useCopy();
  const open = useOpenOrders();
  const closed = useClosedOrders(true);
  const fills = useFills(false);
  const refresh = useRefreshPrivate();
  const cancel = useCancelFlow(refresh);
  const [filter, setFilter] = useState<BlotterFilter>({ market: 'all', side: 'all', source: 'all', parent: 'all' });

  const windows = useMemo(() => algoWindows(parents.flatMap((p) => (p.ok ? [p.parent] : []))), [parents]);
  const childOf = useMemo(() => childParents(parents.flatMap((p) => (p.ok ? [{ id: p.id, children: p.parent.children }] : []))), [parents]);
  const all = useMemo(
    () =>
      buildBlotter(
        open.status === 'ready' ? open.data : [],
        closed.status === 'ready' ? closed.data : [],
        fills.status === 'ready' ? fills.data : [],
        windows,
        childOf,
      ),
    [open, closed, fills, windows, childOf],
  );
  const shown = useMemo(() => filterBlotter(all, filter), [all, filter]);
  const markets = [...new Set(all.map((r) => r.symbol))].sort();
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of shown)
      if (r.kind === 'order') {
        const g = scaledGroupOf(r.clientOrderId);
        if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    return [...counts];
  }, [shown]);
  const asOf = [open, closed, fills].flatMap((l) => (l.status === 'ready' ? [l.asOf] : []));
  const partial = closed.status !== 'ready' || fills.status !== 'ready';
  const set = <K extends keyof BlotterFilter>(key: K, value: BlotterFilter[K]) => setFilter((f) => ({ ...f, [key]: value }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Pick
            label={t('Market')}
            value={filter.market}
            options={[{ value: 'all', label: t('All markets') }, ...markets.map((m) => ({ value: m, label: m }))]}
            onChange={(v) => set('market', v)}
          />
        </div>
        <div className="w-36">
          <Pick
            label={t('Side')}
            value={filter.side}
            options={[
              { value: 'all', label: t('Both sides') },
              { value: 'buy', label: t('Buy') },
              { value: 'sell', label: t('Sell') },
            ]}
            onChange={(v) => set('side', v)}
          />
        </div>
        <div className="w-56">
          <Pick
            label={t('Schedule')}
            value={filter.parent}
            options={[
              { value: 'all', label: t('All schedules') },
              ...parents.flatMap((p) =>
                p.ok
                  ? [
                      {
                        value: p.id,
                        label: t('{market} {kind} {id}', { market: p.parent.symbol, kind: p.parent.kind.toUpperCase(), id: p.id }),
                      },
                    ]
                  : [],
              ),
              // A chosen schedule that can no longer be read stays named, so the filter in force is never hidden.
              ...(filter.parent !== 'all' && !parents.some((p) => p.ok && p.id === filter.parent)
                ? [{ value: filter.parent, label: t('Schedule {id} not read', { id: filter.parent }) }]
                : []),
            ]}
            onChange={(v) => set('parent', v)}
          />
        </div>
        <SegmentedControl
          aria-label={t('Source')}
          size={32}
          value={filter.source}
          onValueChange={(v) => set('source', v as 'all' | Source)}
          items={[
            { value: 'all', label: t('Source all') },
            { value: 'scaled', label: t('Source scaled') },
            { value: 'algo', label: t('Source algo') },
            { value: 'manual', label: t('Source manual') },
          ]}
        />
        <Freshness asOf={asOf.length ? Math.min(...asOf) : null} />
        <Button variant="secondary" size={32} disabled={shown.length === 0} onClick={() => download(blotterCsv(shown))}>
          {t('Export what you see')}
        </Button>
      </div>
      <p className="m-0 text-sm text-fg-2">{t('How rows are matched')}</p>
      <p className="m-0 text-sm text-fg-2">{t('CSV is not a statement')}</p>
      {partial && open.status === 'ready' ? <Why>{t('History partly unread')}</Why> : null}
      {groups.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm text-fg-2" aria-label={t('Scaled groups')}>
          {groups.map(([prefix, n], i) => (
            <li key={prefix}>{t('Ladder {i}: {n} orders shown', { i: String(i + 1), n: String(n) })}</li>
          ))}
        </ul>
      ) : null}
      <Gate load={open}>
        {() => (
          <BlotterTable
            rows={shown}
            label={t('Orders and fills')}
            emptyText={all.length === 0 ? t('No orders or fills') : t('Nothing matches these filters')}
            onCancel={cancel.ask}
            cancelLocked={cancel.locked}
          />
        )}
      </Gate>
      {cancel.notice}
      {cancel.dialog}
    </div>
  );
}
