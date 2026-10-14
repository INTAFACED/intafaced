import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../../shared/api';
import { useDataEnv } from '../../../../data/hooks';
import type { Draft, Order, TradeApi } from '../../../../features/trade/trade-api';
import { deskCopy } from '../copy';
import type { DeskMarket } from '../market';
import { isInFlight, markInFlight, onCheckRequested, release, unmarkInFlight, type Pending } from '../pending';
import { placesOf } from '../text';
import { ticketCopy } from './copy';
import { fmtAmount, fmtPrice, refusalCopy } from './deps';
import { orderWord } from './outcome-words';
import { batchPrefix, clearWaitLeft, findByPrefix, findPlaced, sendBatch, settleResend } from './scale-flow';
import { clearScaleMarker, writeScaleMarker, type ScaleMarkerState } from './scale-marker';
import './ticket.css';

/** Is this pending marker the one a scale batch took? (The one-order recovery must leave it alone.) */
export const isScaleSlot = (pending: Pick<Pending, 'id'> | null | undefined): boolean => pending?.id.startsWith('scale:') === true;

/**
 * Shown while a scale batch is unconfirmed: the desk blocks new orders until every order in it is accounted for.
 *
 * Nothing here clears the block on a guess. Each order is looked up by its own number (reads). The block frees when the
 * service shows every one of them, or when a re-send was refused AND a lookup that itself succeeded finds nothing. A refused
 * or lost re-send never clears anything: the first send may have gone in. With no saved list, the batch is looked up by its
 * number prefix in Open orders and Order history, and clearing is offered only after that lookup succeeds and a minimum wait.
 */
export function ScaleRecovery({
  userId,
  pending,
  marker,
  api,
  client,
  market,
  onChanged,
  onResolved,
}: {
  userId: string;
  pending: Pending;
  marker: ScaleMarkerState;
  api: TradeApi;
  client: ApiClient;
  market: DeskMarket;
  onChanged: () => void;
  /** The block is gone: say why, where the panel still shows it (this view disappears with the block). */
  onResolved: (message: string) => void;
}) {
  const { t } = ticketCopy.useCopy();
  const desk = deskCopy.useCopy().t;
  const env = useDataEnv();
  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Only for a batch with no saved list: what the lookup by number prefix found (null: not looked up yet; 'failed': read failed).
  const [lookup, setLookup] = useState<{ orders: Order[] } | 'failed' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);
  const mounted = useRef(true);
  const markerRef = useRef(marker);
  markerRef.current = marker;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const unreadable = marker.state !== 'pending';
  const drafts: Draft[] = marker.state === 'pending' ? marker.value.drafts : [];
  const symbol = marker.state === 'pending' ? marker.value.symbol : pending.symbol;
  const batchId = pending.id.slice('scale:'.length);

  // The clock only runs while the person is waiting to be allowed to clear.
  useEffect(() => {
    if (!unreadable) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [unreadable]);

  /** Everything is accounted for: free the account's order slot. */
  const finish = (message?: string) => {
    release(userId, pending.id);
    clearScaleMarker(userId);
    onChanged();
    if (message) onResolved(message);
  };

  async function check() {
    const current = markerRef.current;
    if (busy.current || isInFlight(pending.id)) return;
    busy.current = true;
    setChecking(true);
    setNote(null);
    if (current.state !== 'pending') {
      const found = await findByPrefix(api, symbol, batchPrefix(batchId), () => env.poller.recordExternalRequest());
      if (mounted.current) setLookup(found.ok ? { orders: found.orders } : 'failed');
    } else {
      const ids = current.value.drafts.map((d) => d.clientOrderId);
      const found = await findPlaced(api, current.value.symbol, ids, () => env.poller.recordExternalRequest());
      if (mounted.current) {
        if (!found.ok) setNote(desk('Still checking'));
        else {
          const left = current.value.drafts.filter((d) => !found.found.has(d.clientOrderId));
          if (left.length === 0) {
            finish(t('Scale recovery cleared'));
          } else if (left.length !== current.value.drafts.length) {
            writeScaleMarker(userId, { ...current.value, drafts: left });
          }
        }
      }
    }
    if (mounted.current) setChecking(false);
    busy.current = false;
  }
  const checkRef = useRef(check);
  checkRef.current = check;

  // One look when this appears (also after a reload), and whenever a send asks for one.
  useEffect(() => {
    void checkRef.current();
    return onCheckRequested(() => void checkRef.current());
  }, [pending.id]);

  async function sendAgain() {
    const current = markerRef.current;
    if (current.state !== 'pending' || busy.current || isInFlight(pending.id)) return;
    busy.current = true;
    setResending(true);
    setNote(null);
    env.poller.recordExternalRequest();
    markInFlight(pending.id);
    try {
      const outcome = await sendBatch(client, current.value.drafts);
      const settled = await settleResend(api, current.value.symbol, current.value.drafts, outcome, () =>
        env.poller.recordExternalRequest(),
      );
      const firstRefusal = outcome.items.find((item) => item.kind === 'refused');
      if (settled.left.length === 0) {
        finish(
          settled.refused.length > 0 ? t('Scale recovery done refused', { count: settled.refused.length }) : t('Scale recovery cleared'),
        );
      } else {
        writeScaleMarker(userId, { ...current.value, drafts: settled.left });
        if (mounted.current) {
          if (outcome.request === 'refused' && firstRefusal?.kind === 'refused') {
            const words = refusalCopy(firstRefusal.code ?? 'unknown');
            setNote(`${words.title} ${t('Scale resend refused')}`);
          } else setNote(t('Scale resend unsure'));
        }
      }
    } finally {
      unmarkInFlight(pending.id);
    }
    onChanged();
    busy.current = false;
    if (mounted.current) setResending(false);
  }

  if (unreadable) {
    const waitLeft = clearWaitLeft(pending.startedAt, now);
    const looked = lookup !== null && lookup !== 'failed';
    const canClear = looked && waitLeft === 0;
    const found = looked ? lookup.orders : [];
    return (
      <div className="dk-note dk-note--warn" role="status" data-batch={batchId}>
        <p className="dk-note-title">{t('Scale recovery title')}</p>
        <p>{t('Scale recovery unreadable')}</p>
        {lookup === 'failed' ? <p>{t('Scale lookup failed')}</p> : null}
        {looked ? (
          found.length === 0 ? (
            <p>{t('Scale lookup none')}</p>
          ) : (
            <>
              <p>{t('Scale lookup found', { count: found.length })}</p>
              <div className="tk-list">
                <table className="tk-table">
                  <tbody>
                    {found.map((order) => (
                      <tr key={order.id} data-side={order.side}>
                        <td>{order.symbol}</td>
                        <td className="dk-num if-num">
                          {fmtPrice(order.price ?? '', market.symbol === order.symbol ? market.tickSize : undefined)}
                        </td>
                        <td className="dk-num if-num">{fmtAmount(order.amount, { places: placesOf(market.lotSize) })}</td>
                        <td>{orderWord(order, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : null}
        <div className="dk-note-actions">
          <button type="button" className="dk-link" disabled={checking} onClick={() => void check()}>
            {checking ? t('Scale checking now') : t('Scale lookup')}
          </button>
          <button type="button" className="dk-link" disabled={!canClear || checking} onClick={() => finish()}>
            {t('Scale recovery clear')}
          </button>
        </div>
        {!looked ? <p className="dk-note-small">{t('Scale clear needs lookup')}</p> : null}
        {looked && waitLeft > 0 ? <p className="dk-note-small">{t('Scale clear wait', { seconds: Math.ceil(waitLeft / 1000) })}</p> : null}
      </div>
    );
  }
  const amountPlaces = placesOf(drafts[0]?.amount ?? '0.00000001');
  return (
    <div className="dk-note dk-note--warn" role="status" data-batch={batchId}>
      <p className="dk-note-title">{t('Scale recovery title')}</p>
      <p>{t('Scale recovery body')}</p>
      <p>{t('Scale recovery missing', { count: drafts.length })}</p>
      <div className="tk-list">
        <table className="tk-table">
          <tbody>
            {drafts.map((draft) => (
              <tr key={draft.clientOrderId} data-side={draft.side}>
                <td>{symbol}</td>
                <td className="dk-num if-num">
                  {fmtPrice(draft.price ?? '', draft.symbol === market.symbol ? market.tickSize : undefined)}
                </td>
                <td className="dk-num if-num">{fmtAmount(draft.amount, { places: Math.max(amountPlaces, 0) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dk-note-actions">
        <button type="button" className="dk-link" disabled={checking || resending} onClick={() => void check()}>
          {checking ? t('Scale checking now') : t('Scale check')}
        </button>
        <button type="button" className="dk-link" disabled={checking || resending} onClick={() => void sendAgain()}>
          {resending ? t('Scale resending') : t('Scale resend')}
        </button>
      </div>
      <p className="dk-note-small">{t('Scale resend hint')}</p>
      {note ? <p role="status">{note}</p> : null}
    </div>
  );
}
