/**
 * One orders-and-fills table and the single-order cancel flow, shared by the blotter, the scaled tab and the iceberg tab.
 * Cancel is one DELETE per order behind a confirm; an uncertain answer is settled by reading that order back.
 */
import { useState } from 'react';
import { isTerminalOrder, type Order } from '../../../features/trade/trade-api';
import { Button, Tag } from '@intafaced/ui/lit';
import { Skeleton, StatusChip, Table, type Column } from '@intafaced/ui/lit/templates';
import { UNKNOWN, fmtAmount, fmtPrice } from '../rooms/ui';
import { useRoomWriter } from '../rooms/write';
import { execCopy } from './copy';
import { useTradeApi } from './data';
import type { BlotterRow, RowState } from './blotter';
import { ownsNote } from './model';
import { ConfirmDialog, Empty, WriteNotice, useWhen } from './parts';

/** Each row state as the kit's status mark: working is in progress, filled is done, refused failed, ended or unsure open. */
const MARK: Record<RowState, 'pending' | 'done' | 'failed' | 'unknown'> = {
  open: 'pending',
  partial: 'pending',
  recovery: 'unknown',
  filled: 'done',
  fill: 'done',
  cancelled: 'unknown',
  expired: 'unknown',
  rejected: 'failed',
};

/** The order a row is or belongs to: the order's own id, or a fill's order id. */
function orderIdOf(row: BlotterRow): string {
  return row.orderId ?? '';
}

export function BlotterTable({
  rows,
  label,
  status = 'ready',
  onCancel,
  cancelLocked,
  emptyText,
  showOrderId = false,
}: {
  rows: readonly BlotterRow[];
  label: string;
  /** Adds the order's id as a column, so each row can be matched to the book (the terminal's views). */
  showOrderId?: boolean;
  status?: 'ready' | 'loading';
  onCancel?: (order: Order) => void;
  cancelLocked?: boolean;
  emptyText: string;
}) {
  const { t } = execCopy.useCopy();
  const when = useWhen();
  const typeWord = (type: string): string =>
    type === 'limit' || type === 'market' || type === 'fill' ? t(`Type ${type}`) : type.charAt(0).toUpperCase() + type.slice(1);
  const columns: Column<BlotterRow>[] = [
    { key: 'time', label: t('Time'), cell: (r) => when(r.time) ?? UNKNOWN },
    ...(showOrderId
      ? [
          {
            key: 'order',
            label: t('Order'),
            ltr: true,
            cell: (r: BlotterRow) => <span data-testid="order-id">{orderIdOf(r)}</span>,
          } satisfies Column<BlotterRow>,
        ]
      : []),
    { key: 'market', label: t('Market'), cell: (r) => r.symbol },
    { key: 'side', label: t('Side'), cell: (r) => (r.side === 'buy' ? t('Buy') : t('Sell')) },
    { key: 'type', label: t('Type'), cell: (r) => typeWord(r.type) },
    { key: 'price', label: t('Price'), align: 'end', cell: (r) => (r.price === null ? t('Market') : fmtPrice(r.price, null)) },
    { key: 'size', label: t('Size'), align: 'end', cell: (r) => fmtAmount(r.size) },
    { key: 'filled', label: t('Filled'), align: 'end', cell: (r) => fmtAmount(r.filled) },
    { key: 'avg', label: t('Average'), align: 'end', cell: (r) => (r.avg === null ? UNKNOWN : fmtPrice(r.avg, null)) },
    { key: 'state', label: t('State'), cell: (r) => <StatusChip status={MARK[r.state]} label={t(`Row ${r.state}`)} /> },
    { key: 'source', label: t('Source'), cell: (r) => <Tag tone="neutral">{t(`Source ${r.source}`)}</Tag> },
    ...(onCancel
      ? [
          {
            key: 'actions',
            label: t('Actions'),
            cell: (r: BlotterRow) =>
              r.order ? (
                <Button disabled={cancelLocked} aria-label={t('Cancel order {id}', { id: r.order.id })} onClick={() => onCancel(r.order!)}>
                  {t('Cancel')}
                </Button>
              ) : null,
          } satisfies Column<BlotterRow>,
        ]
      : []),
  ];
  return (
    <Table
      caption={label}
      mode="pro"
      columns={columns}
      rows={status === 'loading' ? [] : rows}
      rowKey={(r) => r.id}
      empty={status === 'loading' ? <Skeleton shape="rows" /> : <Empty title={emptyText} />}
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
    if (writer.note.state === 'pending' && !ownsNote('execCancel', writer.note.pending)) {
      setNote(t('Check in another room'));
      return;
    }
    const symbol = writer.note.state === 'pending' ? writer.note.pending.symbol : (order?.symbol ?? '');
    const result = await trade.order({ id, symbol });
    if (result.ok) {
      writer.resolve(id);
      setNote(isTerminalOrder(result.data) ? t('Checked: that order is closed') : t('Checked: that order is still open'));
      onDone();
    } else setNote(t('Could not check, try again'));
  }

  return {
    ask: setOrder,
    locked: writer.busy || writer.note.state !== 'none',
    notice: (
      <>
        <WriteNotice writer={writer} onCheck={(id) => void check(id)} done={t('Order cancelled')} />
        {note ? <p role="status">{note}</p> : null}
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
