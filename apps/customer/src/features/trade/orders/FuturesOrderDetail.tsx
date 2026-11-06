import { useEffect, useState, type ReactNode } from 'react';
import { fmtAmount, fmtPrice } from '../../../data/format';
import type { ApiResult } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import { dayTime } from '../../../screens/trade/desk/time';
import type { FuturesExecution, FuturesOrder } from '../../../screens/trade/futures/api';
import { useFuturesApi } from '../../../screens/trade/futures/data';
import { FuturesOrderOrigin, FuturesOrderStatus } from '../../../screens/trade/futures/OrderStatus';
import { useSession } from '../../session/session';
import { futuresOrdersCopy, type FuturesOrdersT } from './futures-orders-copy';
import { ordersCopy } from './orders-copy';
import './orders.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Read<T> = { status: 'loading' } | { status: 'failed'; failure: Refusal } | { status: 'missing' } | { status: 'ready'; data: T };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="orders-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** What placed the order, by name: the conditional order, liquidation step or reverse request it came from. */
function originRef(order: FuturesOrder, t: FuturesOrdersT): string | null {
  if (!order.originRef) return null;
  if (order.origin === 'liquidation') return t('originRefLiquidation', { ref: order.originRef });
  if (order.origin === 'reverse') return t('originRefReverse', { ref: order.originRef });
  return t('originRefStop', { ref: order.originRef });
}

/**
 * One futures order (`/trade/orders/<id>?product=futures`, J-derivatives-04 step 2): where it came from and any label,
 * its terms, what its hold did, and its fills. Read only; cancelling is on the room and the desk.
 */
export function FuturesOrderDetail({ orderId }: { orderId: string }) {
  const { t } = futuresOrdersCopy.useCopy();
  const orders = ordersCopy.useCopy().t;
  const { userId } = useSession();
  const api = useFuturesApi();
  const { timeZone } = usePreferences();
  const [order, setOrder] = useState<Read<FuturesOrder>>({ status: 'loading' });
  const [fills, setFills] = useState<Read<FuturesExecution[]>>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setOrder({ status: 'loading' });
    setFills({ status: 'loading' });
    void api.order(orderId, controller.signal).then((result) => {
      if (result.ok) setOrder({ status: 'ready', data: result.data });
      else if (result.code === 'trade.futures_order_not_found') setOrder({ status: 'missing' });
      else setOrder({ status: 'failed', failure: result });
    });
    void api.executions({ limit: 200, orderId }, controller.signal).then((result) => {
      if (result.ok) setFills({ status: 'ready', data: result.data.executions });
      else setFills({ status: 'failed', failure: result });
    });
    return () => controller.abort();
  }, [orderId, userId, revision]);

  const back = (
    <a className="text-link" href="/trade/orders?product=futures">
      {t('back')}
    </a>
  );
  if (!userId)
    return (
      <Page eyebrow={orders('eyebrow')} title={t('detailTitle')}>
        <EmptyState
          title={orders('signedOutTitle')}
          action={
            <a
              className="button button--primary"
              href={`/login?redirect=${encodeURIComponent(`/trade/orders/${orderId}?product=futures`)}`}
            >
              {orders('signIn')}
            </a>
          }
        >
          {orders('signedOutBody')}
        </EmptyState>
      </Page>
    );
  if (order.status === 'loading')
    return (
      <Page eyebrow={orders('eyebrow')} title={t('detailTitle')}>
        <Loading label={t('detailLoading')} />
      </Page>
    );
  if (order.status === 'missing')
    return (
      <Page eyebrow={orders('eyebrow')} title={t('detailTitle')}>
        <EmptyState title={t('notFoundTitle')} action={back}>
          {t('notFoundBody')}
        </EmptyState>
      </Page>
    );
  if (order.status === 'failed')
    return (
      <Page eyebrow={orders('eyebrow')} title={t('detailTitle')}>
        <Failure result={order.failure} retry={() => setRevision((n) => n + 1)} />
      </Page>
    );

  const o = order.data;
  const amount = (value: string, places = 8) => fmtAmount(value, { places });
  const ref = originRef(o, t);
  return (
    <Page
      eyebrow={orders('eyebrow')}
      title={t('heading', { side: o.side === 'buy' ? t('buy') : t('sell'), symbol: o.symbol ?? o.marketId })}
      actions={back}
    >
      <div className="orders-room">
        <dl className="orders-list" aria-label={t('detailTitle')}>
          <Row label={t('fieldOrigin')}>
            <FuturesOrderOrigin origin={o.origin} />
          </Row>
          {ref ? <Row label={t('fieldOriginRef')}>{ref}</Row> : null}
          <Row label={t('fieldLabel')}>{o.orderLabel ?? t('fieldLabelNone')}</Row>
          <Row label={t('fieldStatus')}>
            <FuturesOrderStatus order={o} />
          </Row>
          {o.createdAt ? <Row label={t('fieldPlaced')}>{dayTime(Date.parse(o.createdAt), timeZone)}</Row> : null}
          <Row label={t('fieldType')}>
            {o.type === 'limit' ? t('limit') : t('market')}
            {o.reduceOnly ? `, ${t('reduceOnly')}` : ''}
          </Row>
          <Row label={t('fieldPrice')}>{fmtPrice(o.limitPrice, undefined)}</Row>
          <Row label={t('fieldMark')}>{fmtPrice(o.markPrice, undefined)}</Row>
          <Row label={t('fieldBand')}>
            {t('fieldBandValue', { low: fmtPrice(o.bandLow, undefined), high: fmtPrice(o.bandHigh, undefined) })}
          </Row>
          <Row label={t('fieldSize')}>{amount(o.qty)}</Row>
          <Row label={t('fieldFilled')}>{amount(o.filledQty)}</Row>
          <Row label={t('fieldHeld')}>{amount(o.holdAmount, 4)}</Row>
          <Row label={t('fieldApplied')}>{amount(o.appliedAmount, 4)}</Row>
          {o.feesPaid !== undefined ? <Row label={t('fieldFees')}>{amount(o.feesPaid, 6)}</Row> : null}
          <Row label={t('fieldReleased')}>{amount(o.releasedAmount, 4)}</Row>
          {o.bankruptcyPrice ? <Row label={t('fieldBankruptcy')}>{fmtPrice(o.bankruptcyPrice, undefined)}</Row> : null}
          {o.positionId ? <Row label={t('fieldPosition')}>{o.positionId}</Row> : null}
          <Row label={t('fieldOrderId')}>{o.orderId}</Row>
          {o.clientOrderId ? <Row label={t('fieldClientId')}>{o.clientOrderId}</Row> : null}
        </dl>
        <section className="orders-section" aria-label={t('executionsHeading')}>
          <h3>{t('executionsHeading')}</h3>
          {fills.status === 'loading' ? <Loading /> : null}
          {fills.status === 'failed' ? <p role="alert">{t('executionsFailed')}</p> : null}
          {fills.status === 'ready' && fills.data.length === 0 ? <p className="muted">{t('executionsNone')}</p> : null}
          {fills.status === 'ready' && fills.data.length > 0 ? (
            <ul className="orders-list">
              {fills.data.map((fill) => (
                <li key={fill.id}>
                  {dayTime(Date.parse(fill.at), timeZone)}:{' '}
                  {t('executionLine', { qty: amount(fill.qty), price: fmtPrice(fill.price, undefined) })}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </Page>
  );
}
