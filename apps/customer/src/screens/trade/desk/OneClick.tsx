/**
 * One-click trading on the DOM (J-charts-desk-14 #6 and #7, C-trade-dom-02):
 * - Instant placement: off by default. Turning it on shows the settings summary first, and it turns on only once the
 *   person accepts it; the account then holds the agreement and its time (`trade.instant`). Off, every ladder click, chart
 *   Buy or Sell, one-click close and one-click cancel opens its review. On, each sends at once; the order check, the fresh
 *   preview and every refusal still apply. Turning it off is one click.
 * - Size presets: the person's own quick sizes (Account, Trading). A preset fills the click size and sends nothing.
 * - One-click close: a limit sell of all the base asset free on this market at the best bid, reviewed or instant.
 * - A market order (the chart's Market kind) always opens the review, instant placement or not: its price can move
 *   (SP-desk-account-01, "Always on for market orders").
 * - One-click cancel: on a ladder row holding my orders, cancels them, after a review unless instant placement is on.
 *   One cancel request per order per press; a doubtful answer is never retried.
 */
import { useRef, useState } from 'react';
import type { Order } from '../../../features/trade/trade-api';
import { fitsPlaces } from '../../../features/account/trading-settings';
import { useDataEnv } from '../../../data/hooks';
import { useDeskApi } from './data';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  fmtAmount,
  fmtPrice,
} from './deps';
import type { InstantState, InstantWrite } from './instant';
import type { DeskMarket } from './market';
import { flowCopy } from './order-flow-copy';
import { placesOf } from './text';
import type { Preferences } from '../../../shared/preferences';
import { dayTime } from './time';

type Zone = Preferences['timeZone'];

export interface InstantControl {
  state: InstantState;
  on: boolean;
  turnOn: (agreedAt: Date) => Promise<InstantWrite>;
  turnOff: () => Promise<InstantWrite>;
}

function InstantSwitch({ instant, zone }: { instant: InstantControl; zone: Zone }) {
  const { t } = flowCopy.useCopy();
  const [asking, setAsking] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ready = instant.state.status === 'ready';
  const agreedAt = instant.state.status === 'ready' && instant.state.value.on ? instant.state.value.agreedAt : null;

  const outcome = (written: InstantWrite) =>
    written === 'saved' ? null : written === 'unknown' ? t('Instant unknown') : t('Instant not saved');

  const press = async () => {
    setNote(null);
    if (!instant.on) {
      setAgreed(false);
      setAsking(true);
      return;
    }
    setSaving(true);
    setNote(outcome(await instant.turnOff()));
    setSaving(false);
  };
  const accept = async () => {
    if (!agreed) return;
    setSaving(true);
    const written = await instant.turnOn(new Date());
    setSaving(false);
    setAsking(false);
    setNote(outcome(written));
  };

  let status: string;
  if (instant.state.status === 'signed-out') status = t('Instant signed out');
  else if (instant.state.status === 'loading') status = t('Instant loading');
  else if (instant.state.status === 'failed') status = t('Instant unreadable');
  else if (instant.on && agreedAt) status = t('Instant on since', { at: dayTime(Date.parse(agreedAt), zone) });
  else status = t('Instant off');

  return (
    <div className="of-instant">
      <button
        type="button"
        role="switch"
        aria-checked={instant.on}
        data-testid="of-instant"
        data-on={instant.on ? 'true' : 'false'}
        disabled={!ready || saving}
        onClick={() => void press()}
      >
        {t('Instant placement')}
      </button>
      <span className="of-note" role="status" data-testid="of-instant-status" data-agreed-at={agreedAt ?? ''}>
        {status}
      </span>
      {note ? (
        <span className="of-note of-note--bad" role="alert">
          {note}
        </span>
      ) : null}
      <AlertDialog open={asking} onOpenChange={(next) => (next ? setAsking(true) : !saving && setAsking(false))}>
        {asking ? (
          <AlertDialogContent className="dk-review" data-testid="of-instant-summary">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Instant summary title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Instant summary intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="of-summary">
              <li>{t('Instant summary sends')}</li>
              <li>{t('Instant summary market')}</li>
              <li>{t('Instant summary one click')}</li>
              <li>{t('Instant summary checks')}</li>
              <li>{t('Instant summary off')}</li>
            </ul>
            <label className="of-check">
              <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
              <span>{t('Instant agree')}</span>
            </label>
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={saving} onClick={() => setAsking(false)}>
                {t('Instant keep off')}
              </Button>
              <Button variant="primary" shape="pill" size={40} loading={saving} disabled={!agreed} onClick={() => void accept()}>
                {t('Instant turn on')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}

/** The one-click strip above the ladder: instant placement, size presets and one-click close. */
export function OneClickBar({
  market,
  instant,
  zone,
  presets,
  clickAmount,
  onAmount,
  free,
  bestBid,
  onCloseAll,
}: {
  market: DeskMarket;
  instant: InstantControl;
  zone: Zone;
  /** The person's quick sizes, in the base asset. */
  presets: readonly string[];
  clickAmount: string;
  onAmount: (amount: string) => void;
  /** The base asset free to sell on this market, or null while unknown or signed out. */
  free: string | null;
  /** The book's best bid: the price one-click close sells at. */
  bestBid: string | null;
  onCloseAll: (amount: string, price: string) => void;
}) {
  const { t } = flowCopy.useCopy();
  const amountPlaces = placesOf(market.lotSize);
  const canClose = market.open && free !== null && free !== '' && bestBid !== null;
  return (
    <section className="of-oneclick" aria-label={t('One-click trading')} data-testid="of-oneclick" data-instant={instant.on ? 'on' : 'off'}>
      <InstantSwitch instant={instant} zone={zone} />
      <div className="of-presets" role="group" aria-label={t('Size presets')}>
        {presets.length === 0 ? (
          <span className="of-note" data-testid="of-presets-empty">
            {t('Presets none')}
          </span>
        ) : (
          presets.map((size) => (
            <button
              key={size}
              type="button"
              data-testid="of-preset"
              data-size={size}
              aria-pressed={clickAmount.trim() === size}
              disabled={!fitsPlaces(size, amountPlaces)}
              onClick={() => onAmount(size)}
            >
              {t('Preset', { size, asset: market.base })}
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        className="of-close-all"
        data-testid="of-close-all"
        data-amount={free ?? ''}
        data-price={bestBid ?? ''}
        disabled={!canClose}
        onClick={() => free && bestBid && onCloseAll(free, bestBid)}
      >
        {canClose && free && bestBid
          ? t('Close all', {
              amount: fmtAmount(free, { places: amountPlaces }),
              asset: market.base,
              price: fmtPrice(bestBid, market.tickSize),
            })
          : t('Close none', { asset: market.base })}
      </button>
      <p className="of-note">{instant.on ? t('One click instant hint') : t('One click review hint')}</p>
    </section>
  );
}

type CancelState = 'idle' | 'busy' | 'done' | 'uncertain' | 'refused';

/**
 * One-click cancel on a ladder row: my orders in that row's bucket. Off: a review naming each order, then one cancel per
 * order. On: the same cancels at once. A press while one is running does nothing.
 */
export function RowCancel({
  market,
  orders,
  instant,
  onDone,
}: {
  market: DeskMarket;
  orders: readonly Order[];
  instant: boolean;
  onDone: () => void;
}) {
  const { t } = flowCopy.useCopy();
  const env = useDataEnv();
  const api = useDeskApi();
  const busy = useRef(false);
  const [state, setState] = useState<CancelState>('idle');
  const [asking, setAsking] = useState(false);
  const amountPlaces = placesOf(market.lotSize);
  const describe = (order: Order) =>
    t('Cancel line', {
      side: order.side === 'buy' ? t('Side buy') : t('Side sell'),
      amount: fmtAmount(order.remaining, { places: amountPlaces }),
      asset: market.base,
      price: fmtPrice(order.price ?? '', market.tickSize),
    });

  async function cancel() {
    if (busy.current) return;
    busy.current = true;
    setState('busy');
    let outcome: CancelState = 'done';
    for (const order of orders) {
      env.poller.recordExternalRequest();
      // One DELETE per order per press. Nothing retries it: on a doubtful answer the person checks Open orders.
      const result = await api.cancel(order);
      if (!result.ok) outcome = result.reason === 'uncertain' ? 'uncertain' : outcome === 'uncertain' ? outcome : 'refused';
    }
    busy.current = false;
    setState(outcome);
    setAsking(false);
    onDone();
  }

  if (orders.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="of-row-cancel"
        data-testid="of-row-cancel"
        data-state={state}
        disabled={state === 'busy'}
        aria-label={t(orders.length === 1 ? 'Cancel mine at one' : 'Cancel mine at many', {
          n: orders.length,
          price: fmtPrice(orders[0]?.price ?? '', market.tickSize),
        })}
        onClick={() => (instant ? void cancel() : setAsking(true))}
      >
        ×
      </button>
      {state === 'uncertain' || state === 'refused' ? (
        <span className="of-note of-note--bad" role="alert" data-testid="of-row-cancel-note">
          {state === 'uncertain' ? t('Cancel unsure') : t('Cancel not done')}
        </span>
      ) : null}
      <AlertDialog open={asking} onOpenChange={(next) => (next ? setAsking(true) : state !== 'busy' && setAsking(false))}>
        {asking ? (
          <AlertDialogContent className="dk-review" data-testid="of-cancel-review">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t(orders.length === 1 ? 'Cancel review title one' : 'Cancel review title many', { n: orders.length })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('Cancel review intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="of-summary">
              {orders.map((order) => (
                <li key={order.id} data-testid="of-cancel-line" data-order-id={order.id}>
                  {describe(order)}
                </li>
              ))}
            </ul>
            <AlertDialogFooter>
              <Button variant="secondary" size={40} disabled={state === 'busy'} onClick={() => setAsking(false)}>
                {t('Keep orders')}
              </Button>
              <Button variant="primary" shape="pill" size={40} loading={state === 'busy'} onClick={() => void cancel()}>
                {t(orders.length === 1 ? 'Cancel review confirm one' : 'Cancel review confirm many', { n: orders.length })}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </>
  );
}
