import { useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Field,
  Input,
  KeyValue,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  dec,
  fmtAmount,
  formatAsOf,
  type Loadable,
} from '../rooms/ui';
import type { ListedMarket, OptionsPolicy } from '../rooms/api';
import { roomWords, type Words } from '../rooms/refusals';
import { Refusal } from '../rooms/RoomNotices';
import { useNow } from '../rooms/read';
import type { RoomWriter } from '../rooms/write';
import { draftSchema, type Draft, type Preview } from '../../../features/trade/trade-api';
import { useDeskApi, useRefreshPrivate } from '../desk/data';
import { placesOf } from '../desk/text';
import { optionsCopy } from './copy';
import { isComplete, isOpen } from './ChainTab';
import { ticketBlock, ticketCost, timeLeft, type Side } from './model';

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
          { label: reviewCost.direction === 'pay' ? t('Premium you pay') : t('Premium you receive'), value: money(reviewCost.premium) },
          { label: t('Fee, estimate'), value: reviewCost.fee ? `${fmtAmount(reviewCost.fee, { places: 8 })} ${quote}` : null },
          { label: t('Held by the service'), value: t('Paper nothing held') },
        ]
      : [
          { label: reviewCost.direction === 'pay' ? t('Premium you pay') : t('Premium you receive'), value: money(reviewCost.premium) },
          { label: t('Collateral held, estimate'), value: reviewCost.collateral ? money(reviewCost.collateral) : t('None for a buy') },
          { label: t('Fee, estimate'), value: reviewCost.fee ? `${fmtAmount(reviewCost.fee, { places: 8 })} ${quote}` : null },
          {
            label: t('Held by the service'),
            value:
              review?.preview.holdAmount && review.preview.holdAsset
                ? `${fmtAmount(review.preview.holdAmount, { places: 8 })} ${review.preview.holdAsset}`
                : null,
          },
          { label: t('Total to commit'), value: money(reviewCost.total) },
        ]
    : [];
  const expiryAt = market?.expiryDatetime ? Date.parse(market.expiryDatetime) : Number.NaN;
  const expiresText = Number.isNaN(expiryAt)
    ? (market?.expiryDatetime ?? null)
    : `${formatAsOf(expiryAt, { now })} ${timeLeft(market?.expiryDatetime, now) ? t('in {time}', { time: timeLeft(market?.expiryDatetime, now)! }) : t('Expired')}`;

  return (
    <section aria-label={t('Order ticket')} className="flex flex-col gap-3 rounded-sm border border-line bg-panel p-4">
      <h2 className="m-0 text-md font-medium text-fg">{t('Order ticket')}</h2>
      {market ? (
        <KeyValue
          density="dense"
          items={[
            { label: t('Contract'), value: market.symbol, mono: true },
            { label: t('Call or put'), value: market.optionType ? (market.optionType === 'call' ? t('Call') : t('Put')) : null },
            { label: t('Strike'), value: market.strike ? fmtAmount(market.strike, { places: 8 }) : null },
            { label: t('Expires'), value: expiresText },
            { label: t('Settles in'), value: market.settle },
            { label: t('Kind'), value: market.paper ? t('Paper') : t('Live') },
          ]}
        />
      ) : (
        <p className="m-0 text-sm text-fg-2">{t('Pick a contract')}</p>
      )}

      <SegmentedControl
        aria-label={t('Buy or sell')}
        size={40}
        fullWidth
        value={side}
        onValueChange={(v) => setSide(v as Side)}
        items={[
          { value: 'buy', label: t('Buy'), tone: 'up' },
          { value: 'sell', label: t('Sell'), tone: 'down' },
        ]}
      />
      <p className="m-0 text-xs text-fg-2">{t('Limit only')}</p>

      <Field density="dense" label={t('Size in contracts')} hint={market ? t('Step {step}', { step: market.precision.amount }) : undefined}>
        <Input
          kind="decimal"
          precision={market ? placesOf(market.precision.amount) : 8}
          value={size}
          onValueChange={setSize}
          disabled={!market}
        />
      </Field>
      <Field density="dense" label={t('Limit price')} hint={market ? t('Step {step}', { step: market.precision.price }) : undefined}>
        <Input
          kind="decimal"
          precision={market ? placesOf(market.precision.price) : 8}
          value={price}
          onValueChange={setPrice}
          trailing={quote}
          disabled={!market}
        />
      </Field>
      <Field density="dense" label={t('Time in force')}>
        <Select
          items={{ GTC: t('Good till cancelled'), IOC: t('Fill now or cancel'), FOK: t('Fill all or cancel') }}
          value={tif}
          onValueChange={(v) => v && setTif(v as Tif)}
        >
          <SelectTrigger size={32} aria-label={t('Time in force')} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GTC">{t('Good till cancelled')}</SelectItem>
            <SelectItem value="IOC">{t('Fill now or cancel')}</SelectItem>
            <SelectItem value="FOK">{t('Fill all or cancel')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          {t('Post only')}
          <Switch checked={postOnly} onCheckedChange={setPostOnly} disabled={tif !== 'GTC'} aria-label={t('Post only')} />
        </label>
        <p className="m-0 text-xs text-fg-2">{tif !== 'GTC' ? t('Post only needs good till cancelled') : t('Post only hint')}</p>
      </div>

      {block ? (
        <p role="status" className="m-0 text-sm text-warn">
          {t(`Block ${block}`)}
        </p>
      ) : null}
      {failure ? <Refusal words={failure} size="inline" /> : null}

      {review && reviewCost ? (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-base font-medium text-fg">{t('Cost before you confirm')}</h3>
          <KeyValue density="dense" items={rows} />
          <p className="m-0 text-xs text-fg-2">{paperNothingHeld ? t('Paper cost note') : t('Cost note')}</p>
        </div>
      ) : null}

      {review ? (
        <Button
          variant={side === 'buy' ? 'buy' : 'sell'}
          size={40}
          fullWidth
          loading={writer.busy}
          disabled={block !== null}
          onClick={() => setOpen(true)}
        >
          {t('Place order')}
        </Button>
      ) : (
        <Button variant="secondary" size={40} fullWidth loading={reviewing} disabled={block !== null} onClick={() => void startReview()}>
          {t('Review order')}
        </Button>
      )}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void place();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Confirm order title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {review && reviewCost
                  ? t(paperNothingHeld ? 'Confirm paper body' : 'Confirm order body', {
                      side: side === 'buy' ? t('Buy') : t('Sell'),
                      size: fmtAmount(review.draft.amount, { places: 8 }),
                      contract: review.draft.symbol,
                      price: `${fmtAmount(review.draft.price ?? null, { places: 8 })} ${quote}`,
                      total: money(reviewCost.total),
                      kind: market?.paper ? t('Paper') : t('Live'),
                    })
                  : ''}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <KeyValue density="dense" items={rows} />
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="secondary" size={40} type="button" />}>{t('Go back')}</AlertDialogClose>
              <Button type="submit" size={40} variant={side === 'buy' ? 'buy' : 'sell'} autoFocus>
                {t('Place order')}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
