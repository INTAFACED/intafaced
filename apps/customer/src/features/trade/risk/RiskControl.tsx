import { useMemo, useRef, useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@intafaced/ui';
import { EmptyState, Failure, Loading, Page } from '../../../shared/ui';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { fmtAmount } from '../../../data/format';
import { useDataEnv } from '../../../data/hooks';
import { defaultDeskPair } from '../../../app/navigation';
import { CloseAllDialog } from '../../../screens/trade/futures/PositionDialogs';
import type { Loadable } from '../../../data/types';
import { useOpenPositions } from '../../../screens/trade/futures/data';
import { closeAllPlan, stateOf } from '../../../screens/trade/futures/model';
import { futuresRefusal, isPlaneOff } from '../../../screens/trade/futures/refusals';
import { readStatusFeed } from '../../developers/developers-api';
import { createTradeApi, type Order } from '../trade-api';
import { OPEN_ORDERS_LIMIT, judgeCancelEverything, openIncidents, summariseOpenOrders, type CancelEverythingVerdict } from './risk-model';
import { riskCopy } from './risk-copy';
import './risk.css';

type T = ReturnType<typeof riskCopy.useCopy>['t'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="risk-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function CancelEverything({
  count,
  onSend,
  onDone,
  t,
}: {
  count: number;
  onSend: () => Promise<CancelEverythingVerdict>;
  onDone: () => void;
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [verdict, setVerdict] = useState<CancelEverythingVerdict | null>(null);
  async function confirm() {
    // One request per confirm, and never a second while the first has no answer.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setVerdict(await onSend());
    busyRef.current = false;
    setBusy(false);
    onDone();
  }
  function close() {
    if (busyRef.current) return;
    setOpen(false);
    setVerdict(null);
  }
  const note =
    verdict === null
      ? null
      : verdict.kind === 'done'
        ? { tone: 'good', text: t('cancelDone', { count: String(verdict.cancelled) }) }
        : verdict.kind === 'partial'
          ? { tone: 'bad', text: t('cancelPartial', { count: String(verdict.cancelled), left: String(verdict.left) }) }
          : { tone: 'bad', text: t('cancelUncertain') };
  return (
    <>
      <Button variant="secondary" disabled={count === 0} onClick={() => setOpen(true)}>
        {t('cancelButton')}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        {open ? (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {count === 1 ? t('cancelIntroOne') : t('cancelIntro', { count: String(count) })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {note ? (
              <p className={`risk-note risk-note--${note.tone}`} role={note.tone === 'good' ? 'status' : 'alert'}>
                {note.text}
              </p>
            ) : null}
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={busy} onClick={close}>
                {verdict ? t('cancelClose') : t('cancelKeep')}
              </Button>
              {verdict ? null : (
                <Button variant="primary" shape="pill" size={40} loading={busy} onClick={() => void confirm()}>
                  {t('cancelConfirm')}
                </Button>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}

/** The count line of the Exposure section: states the read's real state, never a zero it did not read. */
function PositionsLine({ positions, t }: { positions: Loadable<Position[]>; t: T }) {
  if (positions.status === 'loading') return <Loading label={t('positionsLoading')} />;
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
  if (positions.status === 'loading') return <Loading label={t('positionsLoading')} />;
  if (positions.status === 'error')
    return (
      <p role="alert">
        {t('retry')}:{' '}
        <button type="button" className="text-link" onClick={positions.retry}>
          {t('refresh')}
        </button>
      </p>
    );
  if (positions.status === 'refused') {
    if (isPlaneOff(positions.code)) return <p>{t('positionsOff')}</p>;
    const words = futuresRefusal({ code: positions.code });
    return (
      <div role="alert">
        <strong>{words.title}</strong>
        <p>{words.body}</p>
        {words.code ? <small className="muted">{words.code}</small> : null}
      </div>
    );
  }
  if (positions.status === 'empty' || live.length === 0) return <p>{t('positionsNone')}</p>;
  return (
    <>
      <ul className="risk-list">
        {live.map((position) => {
          const id = position.id ?? '';
          return (
            <li key={id}>
              <label className="risk-pick">
                <input type="checkbox" checked={picked.has(id)} onChange={() => toggle(id)} />
                <span>
                  {t('positionRow', {
                    symbol: position.symbol,
                    side: t(position.side === 'long' ? 'sideLong' : 'sideShort'),
                    size: fmtAmount(position.contracts, { places: 8 }),
                  })}
                  {stateOf(position) === 'closing' ? ` · ${t('closing')}` : ''}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="risk-actions">
        <Button variant="secondary" size={40} onClick={() => setPicked(new Set(live.map((position) => position.id ?? '')))}>
          {t('reduceSelectAll')}
        </Button>
        <Button variant="secondary" size={40} disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
          {t('reduceSelectNone')}
        </Button>
        <span className="muted" role="status">
          {t('reduceSelected', { count: String(chosen.length) })}
        </span>
      </div>
      <div className="risk-actions">
        <Button variant="sell" disabled={chosen.length === 0} onClick={() => setClosing(true)}>
          {t('reduceButton')}
        </Button>
        {chosen.length === 0 ? <span className="muted">{t('reduceNeedsSelection')}</span> : null}
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

function Incidents({ t }: { t: T }) {
  const { api } = useSession();
  const { resource, reload } = useResource((signal) => readStatusFeed(api, signal), 'risk-incidents');
  if (resource.status === 'loading') return <Loading label={t('incidentsLoading')} />;
  if (resource.status === 'failed')
    return (
      <div role="alert">
        <p>{t('incidentsFailed')}</p>
        <p className="muted">
          {t('codeLabel')}: <code>{t('incidentsFailedCode')}</code>
        </p>
        <Button variant="secondary" size={40} onClick={reload}>
          {t('retry')}
        </Button>
      </div>
    );
  const incidents = openIncidents(resource.data);
  return incidents.length === 0 ? (
    <p>{t('incidentsNone')}</p>
  ) : (
    <>
      <ul className="risk-list">
        {incidents.map((incident) => (
          <li key={incident.id}>
            <strong>{incident.title}</strong>
            <span className="muted"> · {t('incidentsOpen', { since: incident.openedAt })}</span>
          </li>
        ))}
      </ul>
      <a className="text-link" href="/developers/status">
        {t('incidentsOpenPage')}
      </a>
    </>
  );
}

/**
 * One phone-width room for acting on exposure: cancel every open order, close selected positions reduce-only, and see alerts,
 * approvals and incidents. It adds no write path: cancel-all is the service's `DELETE /orders`, a close is the futures desk's
 * own close with its own request identity, and nothing is cached across sessions.
 */
export function RiskControl() {
  const { t } = riskCopy.useCopy();
  const { api, userId } = useSession();
  const tradeApi = useMemo(() => createTradeApi(api), [api]);
  const env = useDataEnv();
  const positions = useOpenPositions();
  const orders = useResource(
    (signal) =>
      userId ? tradeApi.orders('open', undefined, OPEN_ORDERS_LIMIT, signal) : Promise.resolve({ ok: true as const, data: [] as Order[] }),
    `risk-orders:${userId ?? 'out'}`,
  );
  if (!userId)
    return (
      <Page eyebrow={t('eyebrow')} title={t('title')} description={t('lead')}>
        <EmptyState
          title={t('signedOutTitle')}
          action={
            <a className="button button--primary" href="/login?redirect=%2Ftrade%2Frisk">
              {t('signIn')}
            </a>
          }
        >
          {t('signedOutBody')}
        </EmptyState>
      </Page>
    );
  const summary = orders.resource.status === 'ready' ? summariseOpenOrders(orders.resource.data) : null;
  async function cancelEverything(): Promise<CancelEverythingVerdict> {
    env.poller.recordExternalRequest();
    const expected = summary?.total ?? 0;
    return judgeCancelEverything(expected, await tradeApi.cancelAllMarkets());
  }
  return (
    <Page
      eyebrow={t('eyebrow')}
      title={t('title')}
      description={t('lead')}
      actions={
        <Button variant="secondary" size={40} onClick={orders.reload}>
          {t('refresh')}
        </Button>
      }
    >
      <div className="risk-room">
        <Section title={t('exposure')}>
          <h3>{t('ordersHeading')}</h3>
          {orders.resource.status === 'loading' ? <Loading label={t('ordersLoading')} /> : null}
          {orders.resource.status === 'failed' ? <Failure result={orders.resource.failure} retry={orders.reload} /> : null}
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
                <ul className="risk-list">
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
        <Section title={t('alertsHeading')}>
          <p>{t('alertsLead')}</p>
          <div className="risk-actions">
            <a className="text-link" href="/notifications">
              {t('alertsOpenNotifications')}
            </a>
            <a className="text-link" href={`/trade/spot/${defaultDeskPair}`}>
              {t('alertsOpenChart')}
            </a>
          </div>
        </Section>
        <Section title={t('approvalsHeading')}>
          <p>{t('approvalsBlocker')}</p>
          <p className="muted">
            {t('codeLabel')}: <code>{t('approvalsCode')}</code>
          </p>
          <Button variant="secondary" size={40} disabled>
            {t('approvalsButton')}
          </Button>
        </Section>
        <Section title={t('incidentsHeading')}>
          <Incidents t={t} />
        </Section>
      </div>
    </Page>
  );
}
