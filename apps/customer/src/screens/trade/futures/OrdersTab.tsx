import { useState } from 'react';
import { Amount, Badge, Button, ChoiceGroup, EmptyState, Price, StatusTag, Table, type StatusKind, type TableColumn } from '@intafaced/ui';
import { isPositive } from '../../../data/decimal';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { FuturesOrder } from './api';
import { useFuturesApi } from './data';
import { LoadGate, TabHeader } from './HistoryTab';
import { futuresRefusal } from './refusals';
import { tabsCopy } from './tabs-copy';

type Scope = 'open' | 'all';

/** States in which an order may still rest or fill, so a cancel is offered. `submit_unknown` is asked of the book first. */
const LIVE = new Set(['pending', 'held', 'submitting', 'open', 'submit_unknown']);

function statusOf(order: FuturesOrder): StatusKind {
  if (order.status === 'filled') return 'filled';
  if (order.status === 'submit_unknown') return 'pending';
  if (LIVE.has(order.status)) return 'working';
  if (order.status === 'cancelled') return isPositive(order.filledQty) ? 'filled' : 'cancelled';
  return 'failed';
}

/** Futures orders through the book: what rests now (with cancel), and the recent record of every order. */
export function OrdersTab({
  open,
  all,
  onChanged,
}: {
  open: Loadable<FuturesOrder[]>;
  all: Loadable<FuturesOrder[]>;
  onChanged: () => void;
}) {
  const { t } = tabsCopy.useCopy();
  const { timeZone } = usePreferences();
  const api = useFuturesApi();
  const [scope, setScope] = useState<Scope>('open');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = scope === 'open' ? open : all;

  const cancel = async (order: FuturesOrder) => {
    setCancelling(order.orderId);
    setFailure(null);
    // Safe to press twice: the order id names the one order, and an order already off the book answers as it stands.
    const result = await api.cancelOrder(order.orderId);
    setCancelling(null);
    if (!result.ok) setFailure(futuresRefusal(result).title);
    onChanged();
  };

  const statusWord = (order: FuturesOrder) => {
    if (order.status === 'cancelled' && isPositive(order.filledQty)) return t('Order part filled');
    const words: Record<string, string> = {
      pending: t('Order working'),
      held: t('Order working'),
      submitting: t('Order working'),
      open: t('Order resting'),
      submit_unknown: t('Order checking'),
      filled: t('Order filled'),
      cancelled: t('Order cancelled'),
      rejected: t('Order rejected'),
      refused: t('Order rejected'),
    };
    return words[order.status] ?? order.status;
  };

  const columns: TableColumn<FuturesOrder>[] = [
    { id: 'time', header: t('Order time'), value: (o) => (o.createdAt ? dayTime(Date.parse(o.createdAt), timeZone) : '') },
    { id: 'contract', header: t('Contract'), value: (o) => o.symbol ?? o.marketId },
    {
      id: 'side',
      header: t('Side'),
      cell: (o) => (
        <span className="flex items-center gap-1">
          <Badge variant="outline" tone={o.side === 'buy' ? 'up' : 'down'}>
            {o.side === 'buy' ? t('Buy') : t('Sell')}
          </Badge>
          {o.reduceOnly ? <Badge>{t('Reduce only')}</Badge> : null}
        </span>
      ),
    },
    { id: 'type', header: t('Order type'), value: (o) => (o.type === 'limit' ? t('Limit') : t('Market')) },
    { id: 'price', header: t('Order price'), numeric: true, cell: (o) => <Price value={fmtPrice(o.limitPrice, undefined)} /> },
    { id: 'size', header: t('Size'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.qty, { places: 8 })} /> },
    { id: 'filled', header: t('Order filled qty'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.filledQty, { places: 8 })} /> },
    { id: 'held', header: t('Order margin held'), numeric: true, cell: (o) => <Amount value={fmtAmount(o.holdAmount, { places: 4 })} /> },
    {
      id: 'status',
      header: t('Status'),
      cell: (o) => (
        <span className="flex flex-col">
          <StatusTag status={statusOf(o)} label={statusWord(o)} />
          {o.refusalCode ? <span className="text-2xs text-fg-3">{futuresRefusal({ code: o.refusalCode }).title}</span> : null}
        </span>
      ),
    },
    {
      id: 'action',
      header: t('Order action'),
      cell: (o) =>
        LIVE.has(o.status) ? (
          <Button variant="secondary" size={28} loading={cancelling === o.orderId} onClick={() => void cancel(o)}>
            {t('Cancel order')}
          </Button>
        ) : null,
    },
  ];

  return (
    <section aria-label={t('Orders table')} className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
        <ChoiceGroup
          items={['open', 'all']}
          value={scope}
          onChange={(value) => setScope(value as Scope)}
          label={t('Orders scope')}
          labels={{ open: t('Orders open'), all: t('Orders all') }}
        />
      </div>
      <TabHeader title={scope === 'open' ? t('Orders open heading') : t('Orders all heading')} load={load} />
      {failure ? (
        <p role="status" className="m-0 px-3 text-xs text-warn">
          {t('Cancel failed', { reason: failure })}
        </p>
      ) : null}
      <LoadGate load={load} thing={t('Thing orders')}>
        {(orders) => (
          <>
            <Table
              label={t('Orders table')}
              density="dense"
              columns={columns}
              rows={orders}
              getRowId={(o) => o.orderId}
              emptyState={
                <EmptyState
                  size="inline"
                  title={scope === 'open' ? t('Orders open empty') : t('Orders all empty')}
                  reason={t('Orders empty reason')}
                />
              }
            />
            <p className="m-0 px-3 py-2 text-xs text-fg-2">{t('Orders footer')}</p>
          </>
        )}
      </LoadGate>
    </section>
  );
}
