import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  EmptyState,
  Table,
  dec,
  fmtAmount,
  fmtPrice,
  formatAsOf,
  type Loadable,
  type TableColumn,
} from '../rooms/ui';
import type { Order } from '../../../features/trade/trade-api';
import type { ListedMarket } from '../rooms/api';
import { Freshness } from '../rooms/RoomNotices';
import { asOfOf, useNow } from '../rooms/read';
import { roomWords } from '../rooms/refusals';
import type { RoomWriter } from '../rooms/write';
import { useDeskApi, useRefreshPrivate } from '../desk/data';
import { optionsCopy } from './copy';
import { RefusedRegion } from './shared';

function Section({
  title,
  load,
  rows,
  columns,
  emptyText,
}: {
  title: string;
  load: Loadable<Order[]>;
  rows: Order[];
  columns: TableColumn<Order>[];
  emptyText: string;
}) {
  const now = useNow(15_000);
  if (load.status === 'refused') return <RefusedRegion code={load.code} />;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-md font-medium text-fg">{title}</h3>
        <Freshness asOf={asOfOf(load)} now={now} />
      </div>
      <Table
        label={title}
        density="dense"
        columns={columns}
        rows={rows}
        getRowId={(o) => o.id}
        status={load.status === 'loading' || load.status === 'empty' ? 'loading' : load.status === 'error' ? 'error' : 'ready'}
        onRetry={load.status === 'error' ? load.retry : undefined}
        errorState={<EmptyState variant="refused" title={title} reason={emptyText} />}
        emptyState={<EmptyState title={emptyText} />}
        minWidth={1100}
        maxHeight={320}
      />
    </section>
  );
}

export function OrdersTab({
  open,
  closed,
  markets,
  writer,
}: {
  open: Loadable<Order[]>;
  closed: Loadable<Order[]>;
  markets: ReadonlyMap<string, ListedMarket>;
  writer: RoomWriter;
}) {
  const { t } = optionsCopy.useCopy();
  const api = useDeskApi();
  const refresh = useRefreshPrivate();
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const [rowNote, setRowNote] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [batch, setBatch] = useState<{ total: number; rows: Array<{ id: string; symbol: string; ok: boolean; text: string }> } | null>(
    null,
  );

  const note = (id: string, text: string) => setRowNote((prev) => ({ ...prev, [id]: text }));

  async function cancel(order: Order) {
    setCancelling(null);
    const outcome = await writer.run({ kind: 'cancel', id: order.id, symbol: order.symbol, call: () => api.cancel(order) });
    refresh();
    if (outcome.kind === 'refused') note(order.id, outcome.words.body);
    if (outcome.kind === 'blocked') note(order.id, t('Cancel blocked'));
  }

  async function cancelAll() {
    setCancellingAll(false);
    if (open.status !== 'ready') return;
    const targets = [...open.data];
    const rows: Array<{ id: string; symbol: string; ok: boolean; text: string }> = [];
    setBatch({ total: targets.length, rows });
    const record = (order: Order, ok: boolean, text: string) => {
      note(order.id, text);
      rows.push({ id: order.id, symbol: order.symbol, ok, text });
      setBatch({ total: targets.length, rows: [...rows] });
    };
    for (const order of targets) {
      const outcome = await writer.run({ kind: 'cancel', id: order.id, symbol: order.symbol, call: () => api.cancel(order) });
      if (outcome.kind === 'done') record(order, true, t('Cancelled row'));
      else if (outcome.kind === 'refused') record(order, false, outcome.words.body);
      else if (outcome.kind === 'blocked') {
        record(order, false, t('Cancel blocked'));
        break;
      } else {
        if (outcome.kind === 'uncertain') record(order, false, outcome.words.body);
        break;
      }
    }
    refresh();
  }

  async function checkRow(order: Order) {
    setChecking(order.id);
    const result = await api.order(order);
    setChecking(null);
    if (result.ok && !result.data.recoveryRequired) {
      if (order.clientOrderId) writer.resolve(order.clientOrderId);
      refresh();
      note(order.id, t('Checked order', { status: result.data.status }));
    } else if (result.ok) note(order.id, t('Still recovering'));
    else note(order.id, roomWords({ reason: result.reason, message: result.message, code: result.code }).body);
  }

  const stateOf = (o: Order) => {
    if (o.recoveryRequired) return <Badge tone="warn">{t('Needs recovery')}</Badge>;
    if (o.status === 'open')
      return <Badge tone="lime">{dec(o.filled) !== null && o.filled !== '0' ? t('Partly filled') : t('Open')}</Badge>;
    const word = { closed: t('Filled'), canceled: t('Cancelled'), expired: t('Expired'), rejected: t('Rejected') }[o.status];
    return <Badge>{word ?? o.status}</Badge>;
  };

  const base: TableColumn<Order>[] = [
    {
      id: 'symbol',
      header: t('Contract'),
      width: 220,
      pin: 'start',
      value: (o) => o.symbol,
      cell: (o) => <span className="font-mono">{o.symbol}</span>,
    },
    { id: 'side', header: t('Side'), width: 64, cell: (o) => (o.side === 'buy' ? t('Buy') : t('Sell')) },
    { id: 'type', header: t('Type'), width: 70, cell: () => t('Limit') },
    {
      id: 'price',
      header: t('Price'),
      width: 100,
      numeric: true,
      value: (o) => o.price,
      cell: (o) => fmtPrice(o.price, markets.get(o.symbol)?.precision.price),
    },
    { id: 'size', header: t('Size'), width: 90, numeric: true, value: (o) => o.amount, cell: (o) => fmtAmount(o.amount, { places: 8 }) },
    {
      id: 'filled',
      header: t('Filled'),
      width: 90,
      numeric: true,
      value: (o) => o.filled,
      cell: (o) => fmtAmount(o.filled, { places: 8 }),
    },
    { id: 'state', header: t('State'), width: 120, cell: stateOf },
    { id: 'created', header: t('Created'), width: 130, cell: (o) => formatAsOf(o.timestamp) },
  ];
  const openColumns: TableColumn<Order>[] = [
    ...base,
    {
      id: 'actions',
      header: t('Actions'),
      headerLabel: t('Actions'),
      width: 260,
      align: 'end',
      cell: (o) => (
        <span className="inline-flex items-center gap-2">
          {rowNote[o.id] ? <span className="text-xs text-fg-2">{rowNote[o.id]}</span> : null}
          {o.recoveryRequired ? (
            <Button variant="secondary" size={28} loading={checking === o.id} onClick={() => void checkRow(o)}>
              {t('Check status')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size={28}
            disabled={writer.busy}
            aria-label={t('Cancel order label', { contract: o.symbol })}
            onClick={() => setCancelling(o)}
          >
            {t('Cancel')}
          </Button>
        </span>
      ),
    },
  ];

  const rowsOf = (load: Loadable<Order[]>) => (load.status === 'ready' ? [...load.data].sort((a, b) => b.timestamp - a.timestamp) : []);

  return (
    <div className="flex flex-col gap-5">
      {open.status === 'ready' && open.data.length > 1 ? (
        <div className="flex justify-end">
          <Button variant="secondary" size={28} disabled={writer.busy} onClick={() => setCancellingAll(true)}>
            {t('Cancel all orders')}
          </Button>
        </div>
      ) : null}
      {batch ? (
        <section
          aria-label={t('Cancel all result title')}
          aria-live="polite"
          className="flex flex-col gap-1 rounded-sm border border-line bg-panel p-3"
        >
          <h3 className="m-0 text-base font-medium text-fg">{t('Cancel all result title')}</h3>
          <p className="m-0 text-sm text-fg">
            {t('Cancel all result summary', {
              cancelled: String(batch.rows.filter((r) => r.ok).length),
              refused: String(batch.rows.filter((r) => !r.ok).length),
              untried: String(batch.total - batch.rows.length),
              total: String(batch.total),
            })}
          </p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-fg-2">
            {batch.rows.map((r) => (
              <li key={r.id}>
                <span className="font-mono text-fg">{r.symbol}</span> {r.ok ? t('Cancelled row') : r.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Section title={t('Open orders')} load={open} rows={rowsOf(open)} columns={openColumns} emptyText={t('No open option orders')} />
      <Section title={t('Order history')} load={closed} rows={rowsOf(closed)} columns={base} emptyText={t('No closed option orders')} />
      <AlertDialog open={cancelling !== null} onOpenChange={(next) => !next && setCancelling(null)}>
        <AlertDialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (cancelling) void cancel(cancelling);
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Cancel this order')}</AlertDialogTitle>
              <AlertDialogDescription>
                {cancelling
                  ? t('Cancel order body', {
                      side: cancelling.side === 'buy' ? t('Buy') : t('Sell'),
                      size: fmtAmount(cancelling.remaining, { places: 8 }),
                      contract: cancelling.symbol,
                      price: fmtPrice(cancelling.price, markets.get(cancelling.symbol)?.precision.price),
                    })
                  : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="secondary" size={40} type="button" />}>{t('Keep order')}</AlertDialogClose>
              <Button type="submit" size={40} variant="primary" autoFocus>
                {t('Cancel order')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={cancellingAll} onOpenChange={(next) => !next && setCancellingAll(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Cancel all title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Cancel all body', { count: String(open.status === 'ready' ? open.data.length : 0) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="secondary" size={40} type="button" />}>{t('Keep order')}</AlertDialogClose>
            <Button size={40} variant="primary" onClick={() => void cancelAll()}>
              {t('Cancel all go', { count: String(open.status === 'ready' ? open.data.length : 0) })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
