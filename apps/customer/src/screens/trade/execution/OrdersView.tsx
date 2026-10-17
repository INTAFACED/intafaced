/**
 * One orders-and-fills table and the single-order cancel flow, shared by the blotter, the scaled tab and the iceberg tab.
 * Cancel is one DELETE per order behind a confirm; an uncertain answer is settled by reading that order back.
 */
import { useState } from 'react';
import { isTerminalOrder, type Order } from '../../../features/trade/trade-api';
import { Badge, Button, EmptyState, Table, fmtAmount, fmtPrice, type TableColumn } from '../rooms/ui';
import { WriteNotice } from '../rooms/RoomNotices';
import { useRoomWriter } from '../rooms/write';
import { execCopy } from './copy';
import { useTradeApi } from './data';
import type { BlotterRow, RowState } from './blotter';
import { ConfirmDialog, useWhen } from './parts';

const TONE: Record<RowState, 'neutral' | 'lime' | 'warn' | 'error' | 'up'> = {
  open: 'lime',
  partial: 'lime',
  recovery: 'warn',
  filled: 'up',
  fill: 'up',
  cancelled: 'neutral',
  expired: 'neutral',
  rejected: 'error',
};

export function BlotterTable({
  rows,
  label,
  status = 'ready',
  onCancel,
  cancelLocked,
  emptyText,
}: {
  rows: readonly BlotterRow[];
  label: string;
  status?: 'ready' | 'loading';
  onCancel?: (order: Order) => void;
  cancelLocked?: boolean;
  emptyText: string;
}) {
  const { t } = execCopy.useCopy();
  const when = useWhen();
  const typeWord = (type: string): string =>
    type === 'limit' || type === 'market' || type === 'fill' ? t(`Type ${type}`) : type.charAt(0).toUpperCase() + type.slice(1);
  const columns: TableColumn<BlotterRow>[] = [
    { id: 'time', header: t('Time'), pin: 'start', value: (r) => when(r.time), sortable: false },
    { id: 'market', header: t('Market'), value: (r) => r.symbol },
    { id: 'side', header: t('Side'), value: (r) => (r.side === 'buy' ? t('Buy') : t('Sell')) },
    { id: 'type', header: t('Type'), value: (r) => typeWord(r.type) },
    {
      id: 'price',
      header: t('Price'),
      numeric: true,
      value: (r) => r.price,
      cell: (r) => (r.price === null ? t('Market') : fmtPrice(r.price, null)),
    },
    { id: 'size', header: t('Size'), numeric: true, value: (r) => r.size, cell: (r) => fmtAmount(r.size) },
    { id: 'filled', header: t('Filled'), numeric: true, value: (r) => r.filled, cell: (r) => fmtAmount(r.filled) },
    { id: 'avg', header: t('Average'), numeric: true, value: (r) => r.avg, cell: (r) => (r.avg === null ? null : fmtPrice(r.avg, null)) },
    { id: 'state', header: t('State'), cell: (r) => <Badge tone={TONE[r.state]}>{t(`Row ${r.state}`)}</Badge> },
    { id: 'source', header: t('Source'), cell: (r) => <Badge variant="outline">{t(`Source ${r.source}`)}</Badge> },
    ...(onCancel
      ? [
          {
            id: 'actions',
            header: t('Actions'),
            cell: (r: BlotterRow) =>
              r.order ? (
                <Button
                  variant="secondary"
                  size={28}
                  disabled={cancelLocked}
                  aria-label={t('Cancel order {id}', { id: r.order.id })}
                  onClick={() => onCancel(r.order!)}
                >
                  {t('Cancel')}
                </Button>
              ) : null,
          } satisfies TableColumn<BlotterRow>,
        ]
      : []),
  ];
  return (
    <Table
      label={label}
      density="dense"
      status={status}
      columns={columns}
      rows={rows}
      minWidth={onCancel ? 1000 : 900}
      getRowId={(r) => r.id}
      emptyState={<EmptyState variant="empty" size="inline" title={emptyText} />}
    />
  );
}

/** Ask, confirm, cancel one order. `dialog` and `notice` are placed by the caller. */
export function useCancelFlow(onDone: () => void) {
  const { t } = execCopy.useCopy();
  const trade = useTradeApi();
  const writer = useRoomWriter();
  const [order, setOrder] = useState<Order | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function confirm() {
    if (!order) return;
    const target = order;
    await writer.run({ kind: 'cancel', id: target.id, symbol: target.symbol, call: () => trade.cancel(target) });
    setOrder(null);
    onDone();
  }

  async function check(id: string) {
    const symbol = writer.note.state === 'pending' ? writer.note.pending.symbol : (order?.symbol ?? '');
    const result = await trade.order({ id, symbol });
    if (result.ok) {
      writer.resolve(id);
      setNote(isTerminalOrder(result.data) ? t('Checked: that order is closed') : t('Checked: that order is still open'));
      onDone();
    } else setNote(t('Could not check yet, try again'));
  }

  return {
    ask: setOrder,
    locked: writer.busy || writer.note.state !== 'none',
    notice: (
      <>
        <WriteNotice writer={writer} onCheck={(id) => void check(id)} done={t('Order cancelled')} />
        {note ? (
          <p role="status" className="m-0 text-sm text-fg">
            {note}
          </p>
        ) : null}
      </>
    ),
    dialog: (
      <ConfirmDialog
        open={order !== null}
        title={t('Cancel this order?')}
        description={t('Cancel order body')}
        rows={
          order
            ? [
                { label: t('Order'), value: order.id, mono: true },
                { label: t('Market'), value: order.symbol },
                { label: t('Side'), value: order.side === 'buy' ? t('Buy') : t('Sell') },
                { label: t('Price'), value: order.price === null ? t('Market') : fmtPrice(order.price, null) },
                { label: t('Left to fill'), value: fmtAmount(order.remaining) },
              ]
            : []
        }
        confirmLabel={t('Cancel order')}
        tone="secondary"
        busy={writer.busy}
        onConfirm={() => void confirm()}
        onCancel={() => setOrder(null)}
      />
    ),
  };
}
