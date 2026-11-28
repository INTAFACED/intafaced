// volt-room: /trade/risk
import { useMemo, useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { Button, Checkbox } from '@intafaced/ui/lit';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { fmtAmount } from '../../../data/format';
import { useDataEnv } from '../../../data/hooks';
import { CloseAllDialog } from '../../../screens/trade/futures/close-all/CloseAllDialog';
import type { Loadable } from '../../../data/types';
import { useOpenPositions } from '../../../screens/trade/futures/data';
import { closeAllPlan, stateOf } from '../../../screens/trade/futures/model';
import { futuresRefusal, isPlaneOff } from '../../../screens/trade/futures/refusals';
import { FailureNote, Section, Waiting } from '../../more';
import { createTradeApi } from '../trade-api';
import { useVenueMode } from '../use-venue-mode';
import { VenueRisk } from './VenueRisk';
import { OPEN_ORDERS_LIMIT, judgeCancelEverything, summariseOpenOrders, type CancelEverythingVerdict } from './risk-model';
import { riskCopy } from './risk-copy';
import { CancelEverything, OtherSections, type T } from './risk-parts';

/** The count line of the Exposure section: states the read's real state, never a zero it did not read. */
function PositionsLine({ positions, t }: { positions: Loadable<Position[]>; t: T }) {
  if (positions.status === 'loading') return <Waiting label={t('positionsLoading')} />;
  if (positions.status === 'error') return <p role="alert">{t('positionsUnread')}</p>;
  if (positions.status === 'refused') return <p>{isPlaneOff(positions.code) ? t('positionsOff') : t('positionsUnread')}</p>;
  const live = positions.status === 'ready' ? closeAllPlan(positions.data) : [];
  return (
    <p>
      {live.length === 0
        ? t('positionsNone')
        : live.length === 1
          ? t('positionsCountOne')
          : t('positionsCount', { count: String(live.length) })}
    </p>
  );
}

function Reduce({ positions, t, onChanged }: { positions: Loadable<Position[]>; t: T; onChanged: () => void }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [closing, setClosing] = useState(false);
  const live: Position[] = positions.status === 'ready' ? closeAllPlan(positions.data) : [];
  const chosen = live.filter((position) => position.id !== null && picked.has(position.id));
  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  if (positions.status === 'loading') return <Waiting label={t('positionsLoading')} />;
  if (positions.status === 'error')
    return (
      <p role="alert">
        {t('retry')}:{' '}
        <Button tone="quiet" onClick={positions.retry}>
          {t('refresh')}
        </Button>
      </p>
    );
  if (positions.status === 'refused') {
    if (isPlaneOff(positions.code)) return <p>{t('positionsOff')}</p>;
    const words = futuresRefusal({ code: positions.code });
    return (
      <div role="alert">
        <strong>{words.title}</strong>
        <p>{words.body}</p>
        {words.code ? <small className="lt-ref">{words.code}</small> : null}
      </div>
    );
  }
  if (positions.status === 'empty' || live.length === 0) return <p>{t('positionsNone')}</p>;
  return (
    <>
      <ul className="lt-rows">
        {live.map((position) => {
          const id = position.id ?? '';
          return (
            <li key={id}>
              <Checkbox checked={picked.has(id)} onCheckedChange={() => toggle(id)}>
                {t('positionRow', {
                  symbol: position.symbol,
                  side: t(position.side === 'long' ? 'sideLong' : 'sideShort'),
                  size: fmtAmount(position.contracts, { places: 8 }),
                })}
                {stateOf(position) === 'closing' ? ` · ${t('closing')}` : ''}
              </Checkbox>
            </li>
          );
        })}
      </ul>
      <div className="lt-actions">
        <Button tone="secondary" onClick={() => setPicked(new Set(live.map((position) => position.id ?? '')))}>
          {t('reduceSelectAll')}
        </Button>
        <Button tone="secondary" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
          {t('reduceSelectNone')}
        </Button>
        <span className="lt-hint" role="status">
          {t('reduceSelected', { count: String(chosen.length) })}
        </span>
      </div>
      <div className="lt-actions">
        <Button tone="primary" disabled={chosen.length === 0} onClick={() => setClosing(true)}>
          {t('reduceButton')}
        </Button>
        {chosen.length === 0 ? <span className="lt-hint">{t('reduceNeedsSelection')}</span> : null}
      </div>
      {closing ? (
        <CloseAllDialog
          positions={chosen}
          onClose={() => {
            setClosing(false);
            setPicked(new Set());
          }}
          onDone={onChanged}
        />
      ) : null}
    </>
  );
}

/**
 * One phone-width room for acting on exposure: cancel every open order, close selected positions reduce-only, and see alerts,
 * approvals and incidents. Where the user-venue door is on (the launch money model: the person's own venue account holds
 * the orders and positions), the room reads and acts on the venue (`VenueRisk`); otherwise on our own book, where
 * cancel-all is the service's `DELETE /orders` and a close is the futures desk's own close. It adds no write path, and
 * nothing is cached across sessions.
 */
export function RiskControl() {
  const { t } = riskCopy.useCopy();
  const { userId } = useSession();
  const mode = useVenueMode();
  if (!userId)
    return (
      <MonitorTemplate
        title={t('title')}
        description={t('lead')}
        state={{
          kind: 'empty',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Ftrade%2Frisk' },
        }}
        mode="pro"
        figures={[]}
        explain={<p className="lt-hint">{t('explain')}</p>}
      />
    );
  if (mode.mode === 'checking')
    return (
      <MonitorTemplate
        title={t('title')}
        description={t('lead')}
        state={{ kind: 'loading' }}
        mode="pro"
        figures={[]}
        explain={<p className="lt-hint">{t('explain')}</p>}
      />
    );
  if (mode.mode === 'on' && mode.status.available) return <VenueRisk mode={mode} />;
  return <OwnBookRisk userId={userId} />;
}

/** The room on our own order book (the custody layer on): the trade service's orders and the futures desk's positions. */
function OwnBookRisk({ userId }: { userId: string }) {
  const { t } = riskCopy.useCopy();
  const { api } = useSession();
  const tradeApi = useMemo(() => createTradeApi(api), [api]);
  const env = useDataEnv();
  const positions = useOpenPositions();
  const orders = useResource((signal) => tradeApi.orders('open', undefined, OPEN_ORDERS_LIMIT, signal), `risk-orders:${userId}`);
  const summary = orders.resource.status === 'ready' ? summariseOpenOrders(orders.resource.data) : null;
  async function cancelEverything(): Promise<CancelEverythingVerdict> {
    env.poller.recordExternalRequest();
    const expected = summary?.total ?? 0;
    return judgeCancelEverything(expected, await tradeApi.cancelAllMarkets());
  }
  return (
    <MonitorTemplate
      title={t('title')}
      description={t('lead')}
      state={{ kind: 'ready' }}
      mode="pro"
      figures={[]}
      roomAction={
        <Button tone="secondary" onClick={orders.reload}>
          {t('refresh')}
        </Button>
      }
      explain={<p className="lt-hint">{t('explain')}</p>}
      panels={
        <div className="lt-stack">
          <Section title={t('exposure')}>
            <h3>{t('ordersHeading')}</h3>
            {orders.resource.status === 'loading' ? <Waiting label={t('ordersLoading')} /> : null}
            {orders.resource.status === 'failed' ? <FailureNote result={orders.resource.failure} retry={orders.reload} /> : null}
            {summary ? (
              summary.total === 0 ? (
                <p>{t('ordersNone')}</p>
              ) : (
                <>
                  <p>
                    {summary.capped
                      ? t('ordersAtLeast', { count: String(summary.total), limit: String(OPEN_ORDERS_LIMIT) })
                      : summary.total === 1
                        ? t('ordersCountOne')
                        : t('ordersCount', { count: String(summary.total) })}
                  </p>
                  <ul className="lt-rows">
                    {summary.markets.map((market) => (
                      <li key={market.symbol}>{t('ordersMarket', { symbol: market.symbol, count: String(market.count) })}</li>
                    ))}
                  </ul>
                </>
              )
            ) : null}
            <h3>{t('positionsHeading')}</h3>
            <PositionsLine positions={positions} t={t} />
          </Section>
          <Section title={t('cancelHeading')}>
            <p>{t('cancelLead')}</p>
            <CancelEverything count={summary?.total ?? 0} onSend={cancelEverything} onDone={orders.reload} t={t} />
          </Section>
          <Section title={t('reduceHeading')}>
            <p>{t('reduceLead')}</p>
            <Reduce positions={positions} t={t} onChanged={orders.reload} />
          </Section>
          <OtherSections t={t} />
        </div>
      }
    />
  );
}
