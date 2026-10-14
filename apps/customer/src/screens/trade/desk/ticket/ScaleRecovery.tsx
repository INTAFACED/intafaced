import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../../../shared/api';
import { useDataEnv } from '../../../../data/hooks';
import type { Draft, TradeApi } from '../../../../features/trade/trade-api';
import { deskCopy } from '../copy';
import { isInFlight, markInFlight, onCheckRequested, release, unmarkInFlight, type Pending } from '../pending';
import { ticketCopy } from './copy';
import { fmtAmount, fmtPrice } from './deps';
import { findPlaced, sendBatch } from './scale-flow';
import { clearScaleMarker, writeScaleMarker, type ScaleMarkerState } from './scale-marker';
import type { DeskMarket } from '../market';
import { placesOf } from '../text';
import './ticket.css';

/** Is this pending marker the one a scale batch took? (The one-order recovery must leave it alone.) */
export const isScaleSlot = (pending: Pick<Pending, 'id'> | null | undefined): boolean => pending?.id.startsWith('scale:') === true;

/**
 * Shown while a scale batch is unconfirmed: the desk blocks new orders until every order in it is accounted for.
 * It looks each order up by its own number (reads), releases the block by itself when all are found, and on the person's
 * click sends the missing ones again under the same numbers. The service keeps one order per number, so an order that
 * did arrive is returned, never placed a second time.
 */
export function ScaleRecovery({
  userId,
  pending,
  marker,
  api,
  client,
  market,
  onChanged,
}: {
  userId: string;
  pending: Pending;
  marker: ScaleMarkerState;
  api: TradeApi;
  client: ApiClient;
  market: DeskMarket;
  onChanged: () => void;
}) {
  const { t } = ticketCopy.useCopy();
  const desk = deskCopy.useCopy().t;
  const env = useDataEnv();
  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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

  const drafts: Draft[] = marker.state === 'pending' ? marker.value.drafts : [];
  const symbol = marker.state === 'pending' ? marker.value.symbol : '';
  const batchId = pending.id.slice('scale:'.length);

  /** Everything is accounted for: free the account's order slot. */
  const finish = () => {
    release(userId, pending.id);
    clearScaleMarker(userId);
    onChanged();
  };

  async function check() {
    const current = markerRef.current;
    if (current.state !== 'pending' || busy.current || isInFlight(pending.id)) return;
    busy.current = true;
    setChecking(true);
    setNote(null);
    const ids = current.value.drafts.map((d) => d.clientOrderId);
    const found = await findPlaced(api, current.value.symbol, ids, () => env.poller.recordExternalRequest());
    if (mounted.current) {
      if (!found.ok) setNote(desk('Still checking'));
      else {
        const left = current.value.drafts.filter((d) => !found.found.has(d.clientOrderId));
        if (left.length === 0) {
          finish();
          setNote(t('Scale recovery cleared'));
        } else if (left.length !== current.value.drafts.length) {
          writeScaleMarker(userId, { ...current.value, drafts: left });
        }
      }
      setChecking(false);
    }
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
    let outcome: Awaited<ReturnType<typeof sendBatch>>;
    try {
      outcome = await sendBatch(client, current.value.drafts);
    } finally {
      unmarkInFlight(pending.id);
    }
    const left = current.value.drafts.filter((_, i) => outcome.items[i]?.kind === 'unknown');
    if (left.length === 0) {
      finish();
      if (mounted.current) setNote(t('Scale recovery cleared'));
    } else {
      writeScaleMarker(userId, { ...current.value, drafts: left });
      if (mounted.current) setNote(t('Scale resend unsure'));
    }
    onChanged();
    busy.current = false;
    if (mounted.current) setResending(false);
  }

  if (marker.state !== 'pending') {
    return (
      <div className="dk-note dk-note--warn" role="status">
        <p className="dk-note-title">{t('Scale recovery title')}</p>
        <p>{t('Scale recovery unreadable')}</p>
        <div className="dk-note-actions">
          <button
            type="button"
            className="dk-link"
            onClick={() => {
              release(userId, pending.id);
              clearScaleMarker(userId);
              onChanged();
            }}
          >
            {t('Scale recovery clear')}
          </button>
        </div>
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
