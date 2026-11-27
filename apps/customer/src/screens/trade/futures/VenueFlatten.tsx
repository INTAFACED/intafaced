import { useRef, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { displayAmount } from '../../../shared/money';
import { draftId, keys, type VenueMarket, type VenueOrder, type VenuePosition } from '../../../features/trade/venue-api';
import { outcomeText, useDeskSigning, useVenueApi, type RunAction } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { futuresVenueCopy } from './venue-copy';
import { laterOf, legAnswer, planLegs, verdictOf, type FlattenLeg, type FlattenVerdict } from './flatten-logic';

/** How long Flatten is held before it sends: long enough that a stray click never closes anything, and no longer. */
const FLATTEN_HOLD_MS = 650;

/**
 * Flatten everything (J-derivatives-33): hold the button 0.65 s and every open order on this venue account is cancelled
 * and every position closed whole, each by one reduce-only IOC market order no worse than the owner's close tolerance
 * from the mark (`closeWorst`). Letting go earlier sends nothing. No passkey and no confirm step: on a venue whose trades a
 * trading session signs, the session key signs each leg with no wallet prompt. Each leg is its own line, marked sent, then
 * done or failed in the venue's words; an answer that is not known is read back from the venue, never sent again blind.
 * "All clear" appears only once the venue's own read of the account shows no position and no open order, with the time
 * it was read. A failed leg is retried alone: a refused close goes again under the same client order id. A hold while a
 * flatten runs starts nothing.
 */
export function FlattenHold({
  positions,
  orders,
  markets,
  owner,
  run,
  closeSlippageBps,
  closeWorst,
  cancelsPerAction,
  heldKey,
  venueName,
  onSettled,
}: {
  positions: readonly VenuePosition[];
  orders: readonly VenueOrder[];
  markets: readonly VenueMarket[];
  owner: string;
  run: RunAction;
  /** The owner's close tolerance (status `closeSlippageBps`): null is blank, and svc-trade refuses every close. */
  closeSlippageBps: number | null;
  closeWorst: (position: VenuePosition, tick: string, closeSlippageBps: number | null) => string;
  /** How many cancels the venue takes in one signed action (status `cancelsPerAction`); a cancel by the order's own id needs one. */
  cancelsPerAction: number | null;
  /** The key this browser placed an order under, by its venue client id: such an order is cancelled by that key. */
  heldKey: (venueClientOrderId: string) => string | undefined;
  venueName: string;
  /** The account's rooms read again from the venue once a flatten or a retry is settled. */
  onSettled: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const signing = useDeskSigning();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One flatten (or retry) at a time, held in a ref so a second hold in the same moment sees it at once.
  const running = useRef(false);
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [legs, setLegs] = useState<readonly FlattenLeg[]>([]);
  const [verdict, setVerdict] = useState<FlattenVerdict | null>(null);
  const live = useRef<FlattenLeg[]>([]);
  // A close whose answer is not known keeps its client order key for the next hold, so that hold reads it back under the
  // same id instead of sending a new close (J-derivatives-33 Money: never resent blind).
  const unanswered = useRef(new Map<string, string>());
  const closeId = (p: VenuePosition) => `${p.symbol}:${p.side}:${p.size}`;

  const anything = positions.length > 0 || orders.length > 0;
  if (!anything && legs.length === 0) return null;
  const sessionSigns = signing?.live != null;

  const show = (next: FlattenLeg[]) => {
    live.current = next;
    setLegs(next);
  };
  const update = (id: string, change: Partial<FlattenLeg>) =>
    show(live.current.map((l) => (l.id === id ? ({ ...l, ...change } as FlattenLeg) : l)));
  const tickOf = (symbol: string) => markets.find((m) => m.symbol === symbol)?.tickSize ?? null;

  /** The venue's own read of the account now: positions and open orders, each with its time. */
  async function readAccount() {
    const [p, o] = await Promise.all([venue.positions(owner), venue.openOrders(owner)]);
    if (!p.ok) return { failed: p.message };
    if (!o.ok) return { failed: o.message };
    return { positions: p.data.value, orders: o.data.value, readAt: laterOf(p.data.asOf, o.data.asOf) };
  }

  /** One leg sent once, and its line set from the venue's answer; an unknown answer is read back by the order's id. */
  async function send(leg: FlattenLeg, opts: { retry: boolean }) {
    update(leg.id, { state: 'sent', reason: null });
    const words = {
      notFilled: (status: string) => t('Flatten not filled', { status }),
      other: (r: Parameters<typeof outcomeText>[1]) => outcomeText(v, r),
    };
    if (leg.kind === 'cancel') {
      const id = leg.order.venueClientOrderId!;
      const key = heldKey(id);
      const tries = leg.tries + 1;
      const answer = key
        ? await run(
            { kind: 'cancel_order', symbol: leg.symbol, clientOrderKey: key },
            tries > 1 ? { actionKey: `${keys.cancel(key)}:${tries}` } : {},
          )
        : (cancelsPerAction ?? 0) >= 1
          ? await run(
              { kind: 'cancel_orders', orders: [{ symbol: leg.symbol, venueClientOrderId: id }] },
              { actionKey: keys.cancelBatch(owner, `flatten-${id.slice(2)}-${tries}`) },
            )
          : null;
      if (answer === null) return update(leg.id, { state: 'failed', reason: t('Flatten cancel not offered', { venue: venueName }), tries });
      const { state, reason } = legAnswer(leg, answer, words);
      if (state !== 'unknown') return update(leg.id, { state, reason, tries });
      // Not known: the venue's own record of the order says whether it is still open.
      const back = await venue.orderByClientId(owner, id).catch(() => null);
      const still = back?.ok ? back.data.value : undefined;
      return update(leg.id, {
        state: still === undefined ? 'unknown' : still === null || still.status !== 'open' ? 'done' : 'failed',
        reason: still === undefined ? t('Flatten unknown') : still && still.status === 'open' ? t('Flatten still open') : null,
        tries,
      });
    }
    const p = leg.position;
    const answer = await run(
      {
        kind: 'place_order',
        symbol: p.symbol,
        side: p.side === 'long' ? 'sell' : 'buy',
        type: 'market',
        amount: p.size,
        price: leg.worst,
        timeInForce: 'IOC',
        reduceOnly: true,
        clientOrderKey: leg.clientOrderKey,
        builderFee: null,
      },
      opts.retry && leg.refused ? { retryRefused: true } : {},
    );
    const { state, reason, refused } = legAnswer(leg, answer, words);
    if (state !== 'unknown') {
      unanswered.current.delete(closeId(p));
      return update(leg.id, { state, reason, refused });
    }
    const id = answer.kind === 'unknown' ? answer.clientOrderId : null;
    const back = id ? await venue.orderByClientId(owner, id).catch(() => null) : null;
    const order = back?.ok ? back.data.value : undefined;
    if (order) unanswered.current.delete(closeId(p));
    else unanswered.current.set(closeId(p), leg.clientOrderKey);
    return update(leg.id, {
      state: order?.status === 'filled' ? 'done' : order ? 'failed' : 'unknown',
      reason: order?.status === 'filled' ? null : order ? t('Flatten not filled', { status: order.status }) : t('Flatten unknown'),
      refused: false,
    });
  }

  /** The venue's read once every leg is answered: the verdict, and the rooms read again. */
  async function settle() {
    setVerdict(verdictOf(await readAccount()));
    onSettled();
  }

  async function guarded(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setVerdict({ kind: 'running' });
    try {
      await work();
      await settle();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const flatten = () =>
    guarded(async () => {
      // What to flatten, as the venue reads the account at the end of the hold; the desk's last read if that read fails.
      const read = await readAccount();
      const nowOrders = 'failed' in read ? orders : read.orders;
      const nowPositions = 'failed' in read ? positions : read.positions;
      const draft = draftId();
      const plan = planLegs(nowOrders, nowPositions, (p) => {
        const tick = tickOf(p.symbol);
        return {
          clientOrderKey: unanswered.current.get(closeId(p)) ?? keys.close(owner, p.symbol, `flat${draft}`),
          worst: tick ? closeWorst(p, tick, closeSlippageBps) : p.markPrice,
        };
      });
      show(plan);
      for (const leg of plan) await send(leg, { retry: false });
    });

  const retry = (leg: FlattenLeg) =>
    guarded(async () => {
      if (leg.kind === 'close' && !leg.refused) {
        // The venue took the close and did not fill all of it: what is left closes under a new id of its own.
        const read = await readAccount();
        const now = 'failed' in read ? null : read.positions.find((p) => p.symbol === leg.symbol && p.side === leg.position.side);
        if (!now) return update(leg.id, { state: 'done', reason: null });
        const tick = tickOf(now.symbol);
        const next: FlattenLeg = {
          ...leg,
          position: now,
          clientOrderKey: keys.close(owner, now.symbol, `flat${draftId()}`),
          worst: tick ? closeWorst(now, tick, closeSlippageBps) : now.markPrice,
        };
        update(leg.id, next);
        return send(next, { retry: false });
      }
      return send(leg, { retry: true });
    });

  const start = () => {
    if (running.current || timer.current || !anything) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      void flatten();
    }, FLATTEN_HOLD_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  const pct = closeSlippageBps === null ? null : String(closeSlippageBps / 100);

  return (
    <div className="xd-flatten" data-testid="venue-flatten">
      <Button
        tone="secondary"
        className="xd-hold"
        data-holding={holding || undefined}
        aria-disabled={busy || !anything || undefined}
        aria-describedby="venue-flatten-how"
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={stop}
      >
        {busy ? t('Flattening') : t('Flatten')}
      </Button>
      <span id="venue-flatten-how" className="xd-risk-note">
        {t('Flatten how', { orders: String(orders.length), positions: String(positions.length), pct: pct ?? '—' })}{' '}
        {sessionSigns ? t('Flatten session signs') : t('Flatten wallet signs')}
      </span>
      {legs.length > 0 ? (
        <ol className="xd-risk-note" data-testid="venue-flatten-legs" aria-label={t('Flatten legs')}>
          {legs.map((leg) => (
            <li key={leg.id} data-leg={leg.kind} data-symbol={leg.symbol} data-state={leg.state}>
              {leg.kind === 'cancel'
                ? t('Flatten cancel line', {
                    symbol: leg.symbol,
                    side: leg.order.side,
                    amount: displayAmount(leg.order.remaining),
                    price: displayAmount(leg.order.price),
                  })
                : t('Flatten close line', {
                    symbol: leg.symbol,
                    side: leg.position.side,
                    size: displayAmount(leg.position.size),
                    worst: displayAmount(leg.worst),
                    pct: pct ?? '—',
                    mark: displayAmount(leg.position.markPrice),
                  })}{' '}
              <span data-testid="venue-flatten-leg-state">{t(`Flatten state ${leg.state}`)}</span>
              {leg.reason ? <span data-testid="venue-flatten-leg-reason">{t('Flatten reason', { reason: leg.reason })}</span> : null}
              {leg.state === 'failed' && !busy ? (
                <Button tone="secondary" size="sm" onClick={() => void retry(leg)}>
                  {t('Flatten retry', { symbol: leg.symbol })}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {verdict && verdict.kind !== 'running' ? (
        <p role="status" data-testid="venue-flatten-verdict" data-verdict={verdict.kind}>
          {verdict.kind === 'clear' ? (
            <>
              {t('All clear', { venue: venueName })} <time dateTime={verdict.readAt}>{verdict.readAt}</time>
            </>
          ) : verdict.readFailed ? (
            t('Not all clear read failed', { venue: venueName, detail: verdict.readFailed })
          ) : (
            <>
              {t('Not all clear', {
                markets: verdict.open
                  .map((symbol) => {
                    const why = legs.find((l) => l.symbol === symbol && l.state !== 'done' && l.reason)?.reason;
                    return why ? t('Still open why', { symbol, reason: why }) : symbol;
                  })
                  .join('; '),
                venue: venueName,
              })}{' '}
              {verdict.readAt ? <time dateTime={verdict.readAt}>{verdict.readAt}</time> : null}
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
