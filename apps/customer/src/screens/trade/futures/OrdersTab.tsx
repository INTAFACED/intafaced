import { useState } from 'react';
import { Amount, Badge, Button, Price, Segmented } from '@intafaced/ui/lit';
import { Table, type Column } from '@intafaced/ui/lit/templates';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { usePreferences } from '../../../shared/preferences';
import { dayTime } from '../desk/time';
import type { FuturesOrder } from './api';
import { useFuturesApi } from './data';
import { LoadGate, TabHeader } from './HistoryTab';
import { cancellable, FuturesOrderOrigin, FuturesOrderStatus } from './OrderStatus';
import { futuresRefusal } from './refusals';
import { tabsCopy } from './tabs-copy';
import { RegionNote } from './notes';

type Scope = 'open' | 'all';

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

  const columns: Column<FuturesOrder>[] = [
    { key: 'time', label: t('Order time'), cell: (o) => (o.createdAt ? dayTime(Date.parse(o.createdAt), timeZone) : '') },
    { key: 'contract', label: t('Contract'), cell: (o) => o.symbol ?? o.marketId },
    {
      key: 'side',
      label: t('Side'),
      cell: (o) => (
        <span className="lt-row">
          <Badge tone={o.side === 'buy' ? 'up' : 'down'}>{o.side === 'buy' ? t('Buy') : t('Sell')}</Badge>
          {o.reduceOnly ? <Badge>{t('Reduce only')}</Badge> : null}
        </span>
      ),
    },
    { key: 'type', label: t('Order type'), cell: (o) => (o.type === 'limit' ? t('Limit') : t('Market')) },
    { key: 'price', label: t('Order price'), align: 'end', cell: (o) => <Price value={fmtPrice(o.limitPrice, undefined)} /> },
    { key: 'size', label: t('Size'), align: 'end', cell: (o) => <Amount value={fmtAmount(o.qty, { places: 8 })} /> },
    { key: 'filled', label: t('Order filled qty'), align: 'end', cell: (o) => <Amount value={fmtAmount(o.filledQty, { places: 8 })} /> },
    { key: 'held', label: t('Order margin held'), align: 'end', cell: (o) => <Amount value={fmtAmount(o.holdAmount, { places: 4 })} /> },
    { key: 'origin', label: t('Order origin'), cell: (o) => <FuturesOrderOrigin origin={o.origin} label={o.orderLabel} /> },
    { key: 'status', label: t('Status'), cell: (o) => <FuturesOrderStatus order={o} /> },
    {
      key: 'action',
      label: t('Order action'),
      cell: (o) =>
        cancellable(o) ? (
          <Button tone="secondary" size="sm" busy={cancelling === o.orderId} onClick={() => void cancel(o)}>
            {t('Cancel order')}
          </Button>
        ) : null,
    },
  ];

  return (
    <section aria-label={t('Orders table')} className="lt-stack">
      <div className="lt-row lt-row-between">
        <Segmented
          options={[
            { value: 'open', label: t('Orders open') },
            { value: 'all', label: t('Orders all') },
          ]}
          value={scope}
          onChange={(value: Scope) => setScope(value)}
          label={t('Orders scope')}
        />
      </div>
      <TabHeader title={scope === 'open' ? t('Orders open heading') : t('Orders all heading')} load={load} />
      {failure ? (
        <p role="status" className="lt-note lt-note-warn">
          {t('Cancel failed', { reason: failure })}
        </p>
      ) : null}
      <LoadGate load={load} thing={t('Thing orders')}>
        {(orders) => (
          <>
            <Table
              mode="pro"
              dense
              caption={t('Orders table')}
              columns={columns}
              rows={orders}
              rowKey={(o) => o.orderId}
              empty={
                <RegionNote title={scope === 'open' ? t('Orders open empty') : t('Orders all empty')} reason={t('Orders empty reason')} />
              }
            />
            <p className="lt-note">{t('Orders footer')}</p>
          </>
        )}
      </LoadGate>
    </section>
  );
}
