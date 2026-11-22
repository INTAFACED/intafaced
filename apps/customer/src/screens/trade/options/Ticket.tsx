import { useEffect, useState } from 'react';
import { Button, Segmented, Switch } from '@intafaced/ui/lit';
import { DecimalInput, KeyValue, Select, Sheet } from '@intafaced/ui/lit/templates';
import { dec, fmtAmount, formatAsOf, type Loadable } from '../rooms/ui';
import type { ListedMarket, OptionsPolicy } from '../rooms/api';
import { roomWords, type Words } from '../rooms/refusals';
import { useNow } from '../rooms/read';
import type { RoomWriter } from '../rooms/write';
import { draftSchema, type Draft, type Preview } from '../../../features/trade/trade-api';
import { useDeskApi, useRefreshPrivate } from '../desk/data';
import { placesOf } from '../desk/text';
import { optionsCopy } from './copy';
import { isComplete, isOpen } from './ChainTab';
import { ticketBlock, ticketCost, timeLeft, type Side } from './model';
import { kvRow, Refusal } from './notices';

type Tif = 'GTC' | 'IOC' | 'FOK';
interface Review {
  draft: Draft;
  preview: Preview;
}

export function Ticket({ market, policy, writer }: { market: ListedMarket | null; policy: Loadable<OptionsPolicy>; writer: RoomWriter }) {
  const { t } = optionsCopy.useCopy();
  const now = useNow(30_000);
  const api = useDeskApi();
  const refresh = useRefreshPrivate();
  const [side, setSide] = useState<Side>('buy');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [tif, setTif] = useState<Tif>('GTC');
  const [postOnly, setPostOnly] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [failure, setFailure] = useState<Words | null>(null);
  const [open, setOpen] = useState(false);

  const symbol = market?.symbol ?? null;
  // Any edit, or another contract, makes the reviewed numbers stale: review again, and the next send is a new intent with a new id.
  useEffect(() => {
    setReview(null);
    setFailure(null);
  }, [symbol, side, size, price, tif, postOnly]);
  useEffect(() => {
    if (tif !== 'GTC') setPostOnly(false);
  }, [tif]);

  const allowed = policy.status === 'ready' ? policy.data.allowed : null;
  const block = ticketBlock({
    signedIn: writer.signedIn,
    pending: writer.note.state !== 'none',
    contract: market
      ? {
          paper: market.paper,
          open: isOpen(market),
          complete: isComplete(market),
          tick: market.precision.price,
          lot: market.precision.amount,
        }
      : null,
    allowed: allowed ? { options: allowed.optionsOrders, paper: allowed.paperOptionsOrders, live: allowed.liveOptionsOrders } : null,
    size,
    price,
  });

  const cost = (preview: Preview | null) =>
    market && market.strike && market.optionType
      ? ticketCost({
          side,
          right: market.optionType,
          strike: market.strike,
          price,
          size,
          contractSize: market.contractSize ?? '',
          base: market.base,
          quote: market.quote,
          settle: market.settle,
          fee: preview && preview.feeAsset === market.quote ? preview.estimatedFee : null,
        })
      : null;

  async function startReview() {
    if (!market || block) return;
    setReviewing(true);
    setFailure(null);
    const draft: Draft = {
      symbol: market.symbol,
      side,
      type: 'limit',
      amount: size,
      price,
      timeInForce: tif,
      postOnly,
      clientOrderId: `opt:${crypto.randomUUID()}`,
    };
    const parsed = draftSchema.safeParse(draft);
    if (!parsed.success) setFailure({ title: t('Check the order'), body: parsed.error.issues.map((i) => i.message).join(' ') });
    else {
      const result = await api.preview(parsed.data);
      if (!result.ok) setFailure(roomWords({ reason: result.reason, message: result.message, code: result.code }));
      else if (!result.data.orderable || result.data.refusals.length > 0) {
        const first = result.data.refusals[0];
        setFailure(roomWords({ code: first?.code, message: result.data.refusals.map((r) => r.message).join(' ') }));
      } else setReview({ draft: parsed.data, preview: result.data });
    }
    setReviewing(false);
  }

  async function place() {
    if (!review) return;
    const { draft, preview } = review;
    setOpen(false);
    const outcome = await writer.run({
      kind: 'place',
      id: draft.clientOrderId,
      symbol: draft.symbol,
      call: async () => {
        const result = await api.place(draft, preview);
        if (!result.ok && result.reason === 'changed') {
          setReview({ draft, preview: result.preview });
          return { ok: false as const, reason: 'aborted' as const, message: t('Numbers changed') };
        }
        return result;
      },
    });
    if (outcome.kind === 'done') {
      setReview(null);
      setSize('');
      refresh();
    }
  }

  const quote = market?.quote ?? '';
  const reviewCost = review ? cost(review.preview) : null;
  const money = (a: { amount: string; asset: string }) => `${fmtAmount(a.amount, { places: 8 })} ${a.asset}`;
  // The service records a paper order with no hold (svc-trade preview returns holdAmount 0 for paper). Only then is
  // "nothing is held" true; any other figure the service sends is shown as it is.
  const heldAmount = review?.preview.holdAmount ?? null;
  const paperNothingHeld = Boolean(market?.paper) && heldAmount !== null && dec(heldAmount) === 0n;
  const rows = reviewCost
    ? paperNothingHeld
      ? [
          kvRow(reviewCost.direction === 'pay' ? t('Premium you pay') : t('Premium you receive'), money(reviewCost.premium)),
          kvRow(t('Fee, estimate'), reviewCost.fee ? `${fmtAmount(reviewCost.fee, { places: 8 })} ${quote}` : null),
          kvRow(t('Held by the service'), t('Paper nothing held')),
        ]
      : [
          kvRow(reviewCost.direction === 'pay' ? t('Premium you pay') : t('Premium you receive'), money(reviewCost.premium)),
          kvRow(t('Collateral held, estimate'), reviewCost.collateral ? money(reviewCost.collateral) : t('None for a buy')),
          kvRow(t('Fee, estimate'), reviewCost.fee ? `${fmtAmount(reviewCost.fee, { places: 8 })} ${quote}` : null),
          kvRow(
            t('Held by the service'),
            review?.preview.holdAmount && review.preview.holdAsset
              ? `${fmtAmount(review.preview.holdAmount, { places: 8 })} ${review.preview.holdAsset}`
              : null,
          ),
          kvRow(t('Total to commit'), money(reviewCost.total)),
        ]
    : [];
  const expiryAt = market?.expiryDatetime ? Date.parse(market.expiryDatetime) : Number.NaN;
  const expiresText = Number.isNaN(expiryAt)
    ? (market?.expiryDatetime ?? null)
    : `${formatAsOf(expiryAt, { now })} ${timeLeft(market?.expiryDatetime, now) ? t('in {time}', { time: timeLeft(market?.expiryDatetime, now)! }) : t('Expired')}`;

  return (
    <section aria-label={t('Order ticket')} className="lt-stack">
      <h2 className="lt-heading">{t('Order ticket')}</h2>
      {market ? (
        <KeyValue
          rows={[
            { ...kvRow(t('Contract'), market.symbol), ltr: true },
            kvRow(t('Call or put'), market.optionType ? (market.optionType === 'call' ? t('Call') : t('Put')) : null),
            kvRow(t('Strike'), market.strike ? fmtAmount(market.strike, { places: 8 }) : null),
            kvRow(t('Expires'), expiresText),
            kvRow(t('Settles in'), market.settle),
            kvRow(t('Kind'), market.paper ? t('Paper') : t('Live')),
          ]}
        />
      ) : (
        <p className="lt-hint">{t('Pick a contract')}</p>
      )}

      <Segmented
        label={t('Buy or sell')}
        value={side}
        onChange={(v) => setSide(v as Side)}
        options={[
          { value: 'buy', label: t('Buy') },
          { value: 'sell', label: t('Sell') },
        ]}
      />
      <p className="lt-hint">{t('Limit only')}</p>

      <DecimalInput
        label={t('Size in contracts')}
        hint={market ? t('Step {step}', { step: market.precision.amount }) : undefined}
        precision={market ? placesOf(market.precision.amount) : 8}
        value={size}
        onValueChange={setSize}
        disabled={!market}
      />
      <DecimalInput
        label={t('Limit price')}
        hint={market ? t('Step {step}', { step: market.precision.price }) : undefined}
        precision={market ? placesOf(market.precision.price) : 8}
        value={price}
        onValueChange={setPrice}
        unit={quote || undefined}
        disabled={!market}
      />
      <div className="lt-field">
        <span aria-hidden="true">{t('Time in force')}</span>
        <Select
          label={t('Time in force')}
          value={tif}
          onChange={(v) => setTif(v as Tif)}
          options={[
            { value: 'GTC', label: t('Good till cancelled') },
            { value: 'IOC', label: t('Fill now or cancel') },
            { value: 'FOK', label: t('Fill all or cancel') },
          ]}
        />
      </div>
      <div className="lt-stack">
        <div className="lt-toolbar">
          <span>{t('Post only')}</span>
          <Switch checked={postOnly} onChange={setPostOnly} disabled={tif !== 'GTC'} label={t('Post only')} />
        </div>
        <p className="lt-hint">{tif !== 'GTC' ? t('Post only needs good till cancelled') : t('Post only hint')}</p>
      </div>

      {block ? (
        <p role="status" className="lt-alert">
          {t(`Block ${block}`)}
        </p>
      ) : null}
      {failure ? <Refusal words={failure} /> : null}

      {review && reviewCost ? (
        <div className="lt-stack">
          <h3 className="lt-heading">{t('Cost before you confirm')}</h3>
          <KeyValue rows={rows} />
          <p className="lt-hint">{paperNothingHeld ? t('Paper cost note') : t('Cost note')}</p>
        </div>
      ) : null}

      {review ? (
        <Button
          tone="primary"
          size="lg"
          block
          aria-busy={writer.busy || undefined}
          disabled={block !== null || writer.busy}
          onClick={() => setOpen(true)}
        >
          {t('Place order')}
        </Button>
      ) : (
        <Button
          size="lg"
          block
          aria-busy={reviewing || undefined}
          disabled={block !== null || reviewing}
          onClick={() => void startReview()}
        >
          {t('Review order')}
        </Button>
      )}

      <Sheet
        role="alertdialog"
        open={open}
        onClose={() => setOpen(false)}
        title={t('Confirm order title')}
        description={
          open && review && reviewCost
            ? t(paperNothingHeld ? 'Confirm paper body' : 'Confirm order body', {
                side: side === 'buy' ? t('Buy') : t('Sell'),
                size: fmtAmount(review.draft.amount, { places: 8 }),
                contract: review.draft.symbol,
                price: `${fmtAmount(review.draft.price ?? null, { places: 8 })} ${quote}`,
                total: money(reviewCost.total),
                kind: market?.paper ? t('Paper') : t('Live'),
              })
            : undefined
        }
      >
        {open ? (
          <form
            className="lt-stack"
            onSubmit={(event) => {
              event.preventDefault();
              void place();
            }}
          >
            <KeyValue rows={rows} />
            <div className="lt-actions">
              <Button size="lg" onClick={() => setOpen(false)}>
                {t('Go back')}
              </Button>
              <Button type="submit" size="lg" tone="primary" data-autofocus="">
                {t('Place order')}
              </Button>
            </div>
          </form>
        ) : null}
      </Sheet>
    </section>
  );
}
