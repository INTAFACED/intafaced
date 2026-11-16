import { useRef, useState } from 'react';
import { displayAmount, parseAmount } from '../../../shared/money';
import {
  draftId,
  keys,
  type OrderIntent,
  type VenueMarket,
  type VenueOrder,
  type VenuePreview,
  type VenueUp,
} from '../../../features/trade/venue-api';
import { useVenueApi, type ActionResult, type RunAction } from '../../../features/trade/venue/VenueKit';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
} from './deps';
import { placesOf } from './text';
import { spotVenueCopy } from './venue-copy';

// J-cex-spot-05 on the venue spot desk: a resting venue order lowered (in place where the venue amends in place, else a
// cancel-and-replace signed once), refused a raise, replaced at a new price after a review, and cancelled by market, by
// selection, across markets or spot only, in one signed action. Every answer is the venue's; nothing is posted on our
// ledger, and a doubtful answer is never sent again as a new action.

type Note = { tone: 'good' | 'bad'; text: string; code?: string } | null;
type T = ReturnType<typeof spotVenueCopy.useCopy>['t'];

const isLive = (o: VenueOrder) => o.status === 'open' || o.status === 'partially_filled';
const cmp = (a: string, b: string) => {
  const x = parseAmount(a);
  const y = parseAmount(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Words for an answer that is not the venue's definite yes: the wallet, a refusal, or no definite answer. */
function notDone(t: T, answer: ActionResult): Note {
  switch (answer.kind) {
    case 'rejected':
      return { tone: 'bad', text: t('Change wallet rejected') };
    case 'waiting':
      return { tone: 'bad', text: t('Change waiting') };
    case 'wallet_failed':
      return { tone: 'bad', text: t('Change wallet failed', { message: answer.message }) };
    case 'unknown':
      return { tone: 'bad', text: t('Change unknown') };
    case 'refused':
      return { tone: 'bad', text: t('Change refused', { detail: answer.message }), ...(answer.code ? { code: answer.code } : {}) };
    case 'outcome':
      return answer.outcome.accepted
        ? null
        : { tone: 'bad', text: t('Change refused', { detail: answer.outcome.refusal.detail }), code: answer.outcome.refusal.code };
  }
}

/** The answer of a cancel-and-replace, in words that never call the original safe once its cancel may have gone. */
function replaced(t: T, answer: ActionResult, newId: string): Note {
  const first = notDone(t, answer);
  if (first || answer.kind !== 'outcome' || !answer.outcome.accepted) return first;
  const [cancel, placed] = answer.outcome.legs ?? [];
  if (!cancel?.accepted) return { tone: 'bad', text: t('Replace nothing changed', { detail: cancel ? cancel.refusal.detail : '' }) };
  if (!placed?.accepted) return { tone: 'bad', text: t('Replace refused after cancel', { detail: placed ? placed.refusal.detail : '' }) };
  const order = placed.order;
  return {
    tone: 'good',
    text: t('Replace done', {
      id: order?.venueClientOrderId ?? newId,
      price: displayAmount(order?.price ?? ''),
      lock: `${displayAmount(order?.locked ?? '')} ${order?.lockedAsset ?? ''}`,
    }),
  };
}

/**
 * Change one resting order. A lower amount at the same price is the venue's amend in place where it offers one (the
 * order keeps its place in the queue), otherwise a cancel-and-replace, reviewed first and signed once. A new price is
 * always a cancel-and-replace, reviewed first. A higher amount is refused by the door from the venue's own record.
 */
export function VenueEditOrder({
  order,
  market,
  status,
  owner,
  run,
  onDone,
  onClose,
}: {
  order: VenueOrder;
  market: VenueMarket | null;
  status: VenueUp;
  owner: string;
  run: RunAction;
  onDone: () => void;
  onClose: () => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  const venue = useVenueApi();
  const [amount, setAmount] = useState(order.remaining);
  const [price, setPrice] = useState(order.price);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [review, setReview] = useState<{ intent: OrderIntent; key: string; preview: VenuePreview } | null>(null);
  // One reviewed replacement keeps its draft (and so its keys) until the venue answers definitely: a second press, a
  // lost answer or a press after the answer is the same action, answered with the first.
  const draft = useRef<string | null>(null);
  const cloid = order.venueClientOrderId ?? '';
  const inPlace = status.amendsInPlace === true;
  const samePrice = price.trim() !== '' && cmp(price, order.price) === 0;
  const amountOk = amount.trim() !== '' && cmp(amount, '0') > 0;

  async function send(fn: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      sending.current = false;
      setBusy(false);
      onDone();
    }
  }

  const replacementOf = (d: string): OrderIntent => ({
    kind: 'place_order',
    symbol: order.symbol,
    side: order.side,
    type: 'limit',
    amount: amount.trim(),
    price: price.trim(),
    timeInForce: order.timeInForce,
    reduceOnly: order.reduceOnly,
    clientOrderKey: keys.replacement(owner, order.symbol, d),
    builderFee: null,
  });

  /** A new amount at the same price, where the venue amends in place: the same order, its place in the queue kept. */
  const changeAmount = () =>
    send(async () => {
      setNote(null);
      const answer = await run(
        { kind: 'amend_order', symbol: order.symbol, venueClientOrderId: cloid, amount: amount.trim(), price: order.price },
        { actionKey: keys.amend(owner, cloid, amount) },
      );
      const bad = notDone(t, answer);
      if (bad) return setNote(bad);
      const after = answer.kind === 'outcome' && answer.outcome.accepted ? answer.outcome.order : null;
      setNote({
        tone: 'good',
        text: t('Amend done', {
          amount: displayAmount(after?.remaining ?? amount),
          lock: `${displayAmount(after?.locked ?? '')} ${after?.lockedAsset ?? ''}`,
        }),
      });
    });

  /**
   * A new price, or a new amount where the venue has no amend in place: the venue's preview of the replacement first, then
   * Confirm sends the one signed cancel-and-replace.
   */
  const startReview = () =>
    send(async () => {
      setNote(null);
      draft.current ??= draftId();
      const intent = replacementOf(draft.current);
      const answer = await venue.preview(owner, intent);
      if (!answer.ok) return setNote({ tone: 'bad', text: t('Change refused', { detail: answer.message }), code: answer.code });
      setReview({ intent, key: keys.replace(owner, draft.current), preview: answer.data.value });
    });

  const confirm = () =>
    send(async () => {
      if (!review) return;
      const answer = await run(
        { kind: 'replace_order', symbol: order.symbol, venueClientOrderId: cloid, order: review.intent },
        { actionKey: review.key },
      );
      if (answer.kind === 'outcome') draft.current = null;
      setNote(replaced(t, answer, review.intent.clientOrderKey));
    });

  const pricePlaces = placesOf(market?.tickSize ?? order.price);
  const amountPlaces = placesOf(market?.lotSize ?? order.remaining);
  return (
    <AlertDialog open onOpenChange={(next) => (next || busy ? null : onClose())}>
      <AlertDialogContent className="dk-review" data-testid="venue-edit">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('Edit title', { side: order.side, symbol: order.symbol })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('Edit intro', { amount: displayAmount(order.remaining), price: displayAmount(order.price), id: cloid })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {review ? (
          <div data-testid="venue-replace-review">
            <p>
              {t('Replace review', {
                old: displayAmount(order.price),
                amount: displayAmount(review.intent.amount),
                price: displayAmount(review.intent.price),
              })}
            </p>
            <p data-testid="venue-replace-id">{t('Replace id', { id: review.intent.clientOrderKey })}</p>
            <p data-testid="venue-replace-lock">
              {t('Replace lock', { lock: `${displayAmount(review.preview.lock.amount)} ${review.preview.lock.asset}` })}
            </p>
          </div>
        ) : (
          <>
            <AmountInput
              label={t('Price')}
              value={price}
              onValueChange={(next) => {
                setPrice(next);
                setNote(null);
              }}
              precision={pricePlaces}
              aria-label={t('Price')}
            />
            <AmountInput
              label={t('Amount left')}
              value={amount}
              onValueChange={(next) => {
                setAmount(next);
                setNote(null);
              }}
              precision={amountPlaces}
              aria-label={t('Amount left')}
            />
            <p className="dk-note">{samePrice ? (inPlace ? t('Amend in place note') : t('Amend replace note')) : t('New price note')}</p>
          </>
        )}
        {note ? (
          <p
            className={note.tone === 'good' ? 'dk-note dk-note--good' : 'dk-note dk-note--bad'}
            role={note.tone === 'good' ? 'status' : 'alert'}
            data-testid="venue-edit-note"
            data-code={note.code ?? ''}
          >
            {note.text}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('Close')}
          </Button>
          {review ? (
            <Button disabled={busy} onClick={() => void confirm()}>
              {t('Confirm replace')}
            </Button>
          ) : samePrice && inPlace ? (
            <Button disabled={busy || !amountOk} onClick={() => void changeAmount()}>
              {t('Change amount')}
            </Button>
          ) : samePrice ? (
            <Button disabled={busy || !amountOk} onClick={() => void startReview()}>
              {t('Review new amount')}
            </Button>
          ) : (
            <Button disabled={busy || !amountOk || price.trim() === ''} onClick={() => void startReview()}>
              {t('Review new price')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Scope = { kind: 'market'; symbol: string } | { kind: 'selected' } | { kind: 'all' } | { kind: 'spot' };

/**
 * Cancel several resting orders in one signed action, asked first: this market's, the ones selected, every market's, or
 * spot only. The venue answers each id; an unknown or already final one is reported and the rest are cancelled.
 */
export function VenueCancelMany({
  orders,
  market,
  markets,
  status,
  owner,
  run,
  selected,
  onDone,
}: {
  orders: readonly VenueOrder[];
  market: VenueMarket;
  /** The listed markets, so "Spot only" knows each order's kind; an order on a market not listed here is not spot. */
  markets: readonly VenueMarket[];
  status: VenueUp;
  owner: string | null;
  run: RunAction;
  selected: readonly VenueOrder[];
  onDone: () => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  const [scope, setScope] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [lines, setLines] = useState<Array<{ id: string; text: string; ok: boolean }> | null>(null);
  const [note, setNote] = useState<Note>(null);
  const draft = useRef<string | null>(null);
  const most = status.cancelsPerAction ?? 0;
  const live = orders.filter((o) => isLive(o) && o.venueClientOrderId);
  const spot = new Set(markets.filter((m) => m.kind === 'spot').map((m) => m.symbol));
  const inScope = (s: Scope): VenueOrder[] =>
    s.kind === 'market'
      ? live.filter((o) => o.symbol === s.symbol)
      : s.kind === 'selected'
        ? selected.filter((o) => o.venueClientOrderId)
        : s.kind === 'spot'
          ? live.filter((o) => spot.has(o.symbol))
          : live;
  const chosen = scope ? inScope(scope) : [];

  function open(s: Scope) {
    draft.current = null;
    setLines(null);
    setNote(null);
    setScope(s);
  }
  function close() {
    if (sending.current) return;
    setScope(null);
  }

  async function confirm() {
    if (!owner || !scope || sending.current || chosen.length === 0) return;
    sending.current = true;
    setBusy(true);
    draft.current ??= draftId();
    const sent = chosen.map((o) => ({ symbol: o.symbol, venueClientOrderId: o.venueClientOrderId! }));
    const answer = await run({ kind: 'cancel_orders', orders: sent }, { actionKey: keys.cancelBatch(owner, draft.current) });
    sending.current = false;
    setBusy(false);
    const bad = notDone(t, answer);
    if (bad) setNote(bad);
    else if (answer.kind === 'outcome' && answer.outcome.accepted) {
      draft.current = null;
      const legs = answer.outcome.legs ?? [];
      setLines(
        sent.map((o, i) => {
          const leg = legs[i];
          const ok = leg?.accepted === true;
          return {
            id: o.venueClientOrderId,
            ok,
            text: ok
              ? t('Cancel line done', { symbol: o.symbol, id: o.venueClientOrderId })
              : leg && !leg.accepted && leg.refusal.code === 'unknown_order'
                ? t('Cancel line unknown', { symbol: o.symbol, id: o.venueClientOrderId })
                : t('Cancel line refused', {
                    symbol: o.symbol,
                    id: o.venueClientOrderId,
                    detail: leg && !leg.accepted ? leg.refusal.detail : '',
                  }),
          };
        }),
      );
    }
    onDone();
  }

  const here = inScope({ kind: 'market', symbol: market.symbol }).length;
  const title =
    scope?.kind === 'market'
      ? t('Cancel market title', { symbol: scope.symbol })
      : scope?.kind === 'selected'
        ? t('Cancel selected title')
        : scope?.kind === 'spot'
          ? t('Cancel spot title')
          : t('Cancel every title');
  const intro =
    scope?.kind === 'market'
      ? t('Cancel market intro', { count: chosen.length, symbol: scope.symbol })
      : scope?.kind === 'spot'
        ? t('Cancel spot intro', { count: chosen.length })
        : t('Cancel many intro', { count: chosen.length });
  return (
    <div className="dk-cancel-many" data-testid="venue-cancel-many">
      {most < 1 ? (
        <p className="muted" data-testid="venue-cancel-one-by-one">
          {t('Cancel one by one', { venue: status.venue.displayName })}
        </p>
      ) : (
        <p>
          <Button variant="secondary" disabled={!owner || here === 0} onClick={() => open({ kind: 'market', symbol: market.symbol })}>
            {t('Cancel all market', { symbol: market.symbol, count: here })}
          </Button>{' '}
          <Button variant="secondary" disabled={!owner || selected.length === 0} onClick={() => open({ kind: 'selected' })}>
            {t('Cancel selected', { count: selected.length })}
          </Button>{' '}
          <Button variant="secondary" disabled={!owner || live.length === 0} onClick={() => open({ kind: 'all' })}>
            {t('Cancel every market')}
          </Button>{' '}
          <Button variant="secondary" disabled={!owner || live.length === 0} onClick={() => open({ kind: 'spot' })}>
            {t('Cancel spot only')}
          </Button>
        </p>
      )}
      <AlertDialog open={scope !== null} onOpenChange={(next) => (next ? null : close())}>
        {scope ? (
          <AlertDialogContent className="dk-review" data-testid="venue-cancel-ask">
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{intro}</AlertDialogDescription>
            </AlertDialogHeader>
            {chosen.length > most ? (
              <p className="dk-note dk-note--bad" role="alert">
                {t('Cancel too many', { count: chosen.length, most, venue: status.venue.displayName })}
              </p>
            ) : null}
            {lines ? (
              <ul data-testid="venue-cancel-lines">
                {lines.map((l) => (
                  <li key={l.id} data-client-order-id={l.id} data-ok={l.ok ? 'yes' : 'no'}>
                    {l.text}
                  </li>
                ))}
              </ul>
            ) : null}
            {note ? (
              <p className="dk-note dk-note--bad" role="alert" data-code={note.code ?? ''}>
                {note.text}
              </p>
            ) : null}
            <AlertDialogFooter>
              <Button variant="secondary" disabled={busy} onClick={close}>
                {lines ? t('Close') : t('Keep orders')}
              </Button>
              {lines ? null : (
                <Button disabled={busy || chosen.length === 0 || chosen.length > most} onClick={() => void confirm()}>
                  {t('Confirm cancel', { count: chosen.length })}
                </Button>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
