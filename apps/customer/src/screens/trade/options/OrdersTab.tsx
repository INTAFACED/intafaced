import { useState } from 'react';
import { Button, EmptyState, Tag } from '@intafaced/ui/lit';
import { Sheet, Skeleton, Table, type Column } from '@intafaced/ui/lit/templates';
import { dec, fmtAmount, fmtPrice, formatAsOf, type Loadable } from '../rooms/ui';
import type { Order } from '../../../features/trade/trade-api';
import type { ListedMarket } from '../rooms/api';
import { asOfOf, useNow } from '../rooms/read';
import { roomWords } from '../rooms/refusals';
import { BLOCK_WORDS, type RoomWriter } from '../rooms/write';
import { useDeskApi, useRefreshPrivate } from '../desk/data';
import { CANCEL_BUCKET_ORDER, bucketOf, cancelCounts, type CancelBucket, type CancelRow } from './cancelAll';
import { optionsCopy } from './copy';
import { Freshness, Refusal } from './notices';
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
  columns: Column<Order>[];
  emptyText: string;
}) {
  const now = useNow(15_000);
  if (load.status === 'refused') return <RefusedRegion code={load.code} />;
  return (
    <section aria-label={title} className="lt-stack">
      <div className="lt-toolbar">
        <h3 className="lt-heading">{title}</h3>
        <Freshness asOf={asOfOf(load)} now={now} />
      </div>
      {load.status === 'loading' || load.status === 'empty' ? (
        <Skeleton shape="rows" />
      ) : load.status === 'error' ? (
        <Refusal words={{ title, body: emptyText }} onRetry={load.retry} />
      ) : (
        <div className="lt-scroll-x">
          <Table caption={title} mode="pro" columns={columns} rows={rows} rowKey={(o) => o.id} empty={<EmptyState title={emptyText} />} />
        </div>
      )}
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
  const [batch, setBatch] = useState<{ total: number; rows: CancelRow[]; running: boolean } | null>(null);

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
    const rows: CancelRow[] = [];
    setBatch({ total: targets.length, rows, running: true });
    const record = (order: Order, bucket: CancelBucket, text: string) => {
      note(order.id, text);
      rows.push({ id: order.id, symbol: order.symbol, bucket, text });
      setBatch({ total: targets.length, rows: [...rows], running: true });
    };
    try {
      for (const order of targets) {
        const outcome = await writer.run({ kind: 'cancel', id: order.id, symbol: order.symbol, call: () => api.cancel(order) });
        const { bucket, stop } = bucketOf(outcome);
        if (bucket) {
          const text =
            outcome.kind === 'done'
              ? t('Cancelled row')
              : outcome.kind === 'refused'
                ? outcome.words.body
                : outcome.kind === 'blocked'
                  ? BLOCK_WORDS[outcome.reason]
                  : t('Cancel unconfirmed row');
          record(order, bucket, text);
        }
        if (stop) break;
      }
    } finally {
      setBatch({ total: targets.length, rows: [...rows], running: false });
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
    if (o.recoveryRequired) return <Tag tone="neutral">{t('Needs recovery')}</Tag>;
    if (o.status === 'open') return <Tag tone="accent">{dec(o.filled) !== null && o.filled !== '0' ? t('Partly filled') : t('Open')}</Tag>;
    const word = { closed: t('Filled'), canceled: t('Cancelled'), expired: t('Expired'), rejected: t('Rejected') }[o.status];
    return <Tag tone="neutral">{word ?? o.status}</Tag>;
  };

  const base: Column<Order>[] = [
    { key: 'symbol', label: t('Contract'), ltr: true, cell: (o) => o.symbol },
    { key: 'side', label: t('Side'), cell: (o) => (o.side === 'buy' ? t('Buy') : t('Sell')) },
    { key: 'type', label: t('Type'), cell: () => t('Limit') },
    { key: 'price', label: t('Price'), align: 'end', cell: (o) => fmtPrice(o.price, markets.get(o.symbol)?.precision.price) },
    { key: 'size', label: t('Size'), align: 'end', cell: (o) => fmtAmount(o.amount, { places: 8 }) },
    { key: 'filled', label: t('Filled'), align: 'end', cell: (o) => fmtAmount(o.filled, { places: 8 }) },
    { key: 'state', label: t('State'), cell: stateOf },
    { key: 'created', label: t('Created'), cell: (o) => formatAsOf(o.timestamp) },
  ];
  const openColumns: Column<Order>[] = [
    ...base,
    {
      key: 'actions',
      label: t('Actions'),
      align: 'end',
      cell: (o) => (
        <span className="lt-actions">
          {rowNote[o.id] ? <span className="lt-hint">{rowNote[o.id]}</span> : null}
          {o.recoveryRequired ? (
            <Button aria-busy={checking === o.id || undefined} disabled={checking === o.id} onClick={() => void checkRow(o)}>
              {t('Check status')}
            </Button>
          ) : null}
          <Button disabled={writer.busy} aria-label={t('Cancel order label', { contract: o.symbol })} onClick={() => setCancelling(o)}>
            {t('Cancel')}
          </Button>
        </span>
      ),
    },
  ];

  const rowsOf = (load: Loadable<Order[]>) => (load.status === 'ready' ? [...load.data].sort((a, b) => b.timestamp - a.timestamp) : []);

  return (
    <div className="lt-stack">
      {open.status === 'ready' && open.data.length > 1 ? (
        <div className="lt-actions">
          <Button disabled={writer.busy} onClick={() => setCancellingAll(true)}>
            {t('Cancel all orders')}
          </Button>
        </div>
      ) : null}
      {batch ? (
        <section aria-label={t('Cancel all result title')} aria-live="polite" className="lt-stack">
          <h3 className="lt-heading">{t('Cancel all result title')}</h3>
          <ul className="lt-list">
            {CANCEL_BUCKET_ORDER.map((bucket) => {
              const counts = cancelCounts(batch.rows, batch.total, { running: batch.running });
              if (bucket !== 'cancelled' && counts[bucket] === 0) return null;
              return (
                <li key={bucket}>
                  {t(`Cancel all summary ${bucket}` as 'Cancel all summary cancelled', {
                    count: String(counts[bucket]),
                    total: String(counts.total),
                  })}
                </li>
              );
            })}
            {batch.running ? (
              <li>
                {t('Cancel all summary pending', { count: String(cancelCounts(batch.rows, batch.total, { running: true }).pending) })}
              </li>
            ) : null}
          </ul>
          <ul className="lt-list">
            {batch.rows.map((r) => (
              <li key={r.id} className="lt-hint">
                <span className="lt-mono">{r.symbol}</span> {r.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Section title={t('Open orders')} load={open} rows={rowsOf(open)} columns={openColumns} emptyText={t('No open option orders')} />
      <Section title={t('Order history')} load={closed} rows={rowsOf(closed)} columns={base} emptyText={t('No closed option orders')} />
      <Sheet
        role="alertdialog"
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={t('Cancel this order')}
        description={
          cancelling
            ? t('Cancel order body', {
                side: cancelling.side === 'buy' ? t('Buy') : t('Sell'),
                size: fmtAmount(cancelling.remaining, { places: 8 }),
                contract: cancelling.symbol,
                price: fmtPrice(cancelling.price, markets.get(cancelling.symbol)?.precision.price),
              })
            : undefined
        }
      >
        {cancelling === null ? null : (
          <form
            className="lt-actions"
            onSubmit={(event) => {
              event.preventDefault();
              if (cancelling) void cancel(cancelling);
            }}
          >
            <Button size="lg" onClick={() => setCancelling(null)}>
              {t('Keep order')}
            </Button>
            <Button type="submit" size="lg" tone="primary" data-autofocus="">
              {t('Cancel order')}
            </Button>
          </form>
        )}
      </Sheet>
      <Sheet
        role="alertdialog"
        open={cancellingAll}
        onClose={() => setCancellingAll(false)}
        title={t('Cancel all title')}
        description={cancellingAll ? t('Cancel all body', { count: String(open.status === 'ready' ? open.data.length : 0) }) : undefined}
      >
        {cancellingAll ? (
          <div className="lt-actions">
            <Button size="lg" onClick={() => setCancellingAll(false)}>
              {t('Keep order')}
            </Button>
            <Button size="lg" tone="primary" onClick={() => void cancelAll()}>
              {t('Cancel all go', { count: String(open.status === 'ready' ? open.data.length : 0) })}
            </Button>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
