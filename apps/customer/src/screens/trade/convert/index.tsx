import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, ChevronDown, History, Info } from 'lucide-react';
import '../buy/buy.css';
import './convert.css';
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from '@intafaced/ui';
import { AssetPicker, type PickerItem } from '../buy/AssetPicker';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
  CoinIcon,
  createToolApi,
  defaultPoller,
  fmtAmount,
  fmtPrice,
  refusalCopy,
  Skeleton,
  StateBlock,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useMarkets,
  useSession,
  useTicker,
  type MarketRow,
} from '../buy/deps';
import { usePendingNote } from '../buy/order-flow';
import { useAvailable, useMarketLimits } from '../buy/quote-flow';
import { dec, fractionDigits, toPlaces } from '../buy/trade-math';
import { TradeSubNav } from '../TradeSubNav';
import { convertCopy } from './copy';
import { KeyValue, StatusChip, type KeyValueItem } from './deps';
import { OtcConvert } from './OtcConvert';
import { RecentConversions } from './RecentConversions';
import { canAccept, holdProgress, spreadPercent, validUntilClock } from './breakdown';
import { defaultPair, edgeFor, edges, fromAssets, planConvert, reviewAmount, spendCap, toAssets, type Edge } from './convert-model';
import { acceptQuote, holdMs, newClientConvertId, refOf, useQuote, type AcceptRef, type Fill, type Quote } from './convert-flow';
import type { ScreenProps } from '../../../app/screen-types';

const ACTIVITY_HREF = '/money/activity?tab=all';
/** "Available" shows the whole balance, as Money does (up to 8 places); only Max rounds down to the lot (critic M5). */
const BALANCE_PLACES = 8;
const isDollar = (asset: string) => asset === 'USDT' || asset === 'USDC' || asset === 'USD';

/** "$2,608.05" for a dollar-quoted market, "0.0123 BTC" otherwise. */
function priceText(price: string, market: MarketRow): string {
  const shown = fmtPrice(price, market.tickSize);
  return isDollar(market.quote) ? `$${shown}` : `${shown} ${market.quote}`;
}

type T = ReturnType<typeof convertCopy.useCopy>['t'];

/** The cost rows shown in the card and in the review dialog. A blank figure draws a dash, never 0. */
function breakdownItems(
  quote: Quote,
  market: MarketRow,
  placesFor: (asset: string) => number,
  secondsLeft: number | null,
  expired: boolean,
  t: T,
): KeyValueItem[] {
  const amountRow = (value: string, asset: string, side: 'pay' | 'get') =>
    dec(value) === null ? null : `${reviewAmount(value, placesFor(asset), side)} ${asset}`;
  const clock = validUntilClock(quote.expiresAt);
  const percent = spreadPercent(quote.convertSpreadBps);
  return [
    { key: 'pay', label: t('You pay'), value: amountRow(quote.inAmount, quote.inAsset, 'pay') },
    { key: 'get', label: t('You get'), value: amountRow(quote.outAmount, quote.outAsset, 'get') },
    {
      key: 'rate',
      label: t('Rate'),
      value: dec(quote.avgPrice) === null ? null : t('1 {base} ≈ {price}', { base: market.base, price: priceText(quote.avgPrice, market) }),
    },
    { key: 'spread', label: t('House spread'), value: percent, hint: percent ? t('Included in the rate') : undefined },
    { key: 'fee', label: t('Fee'), value: t('None separate') },
    { key: 'source', label: t('Price source'), value: t('House quote') },
    {
      key: 'valid',
      label: t('Valid until'),
      value: expired ? t('Valid until expired') : clock ? t('Valid until value', { time: clock, n: secondsLeft ?? 0 }) : null,
    },
  ];
}

function readSearch(search: string) {
  const query = new URLSearchParams(search);
  const clean = (key: string) => {
    const value = query.get(key)?.trim().toUpperCase() ?? '';
    return /^[A-Z0-9]{2,12}$/.test(value) ? value : null;
  };
  return { asset: clean('asset'), from: clean('from'), to: clean('to') };
}

/** Convert (UI-SPEC 5.8): headline left, the card right, three questions below. */
export default function TradeConvertScreen({ search }: ScreenProps) {
  const { t } = convertCopy.useCopy();
  const markets = useMarkets();
  const { session: signedIn } = useSession();
  const asked = useMemo(() => readSearch(search), [search]);
  const all = useMemo(() => (markets.status === 'ready' ? edges(markets.data) : []), [markets]);
  const pair = useMemo(() => defaultPair(all, asked), [all, asked]);
  const [chosen, setChosen] = useState<{ from: string; to: string } | null>(null);
  const shown = chosen && edgeFor(all, chosen.from, chosen.to) ? chosen : pair;

  let card: React.ReactNode;
  if (markets.status === 'loading')
    card = (
      <div data-testid="cvt-card--skeleton" className="cvt-card cvt-card--skeleton" aria-busy="true">
        <Skeleton height={28} width={120} />
        <Skeleton height={132} />
        <Skeleton height={132} />
        <Skeleton height={56} circle />
      </div>
    );
  else if (markets.status === 'error')
    card = (
      <div data-testid="cvt-card" className="cvt-card">
        <StateBlock kind="error" title={t('Couldn’t load assets')} onRetry={markets.retry} retryLabel={t('Retry')} />
      </div>
    );
  else if (markets.status === 'refused') {
    const copy = refusalCopy(markets.code);
    card = (
      <div data-testid="cvt-card" className="cvt-card">
        <StateBlock kind="refused" title={copy.title} body={copy.body} code={copy.reference} action={copy.action} />
      </div>
    );
  } else if (!shown)
    card = (
      <div data-testid="cvt-card" className="cvt-card">
        <StateBlock
          kind="empty"
          title={t('No convert title')}
          body={t('No convert body')}
          action={{ label: t('Go to Markets'), href: '/trade' }}
        />
      </div>
    );
  else card = <ConvertCard key={`${shown.from}>${shown.to}`} all={all} from={shown.from} to={shown.to} onPair={setChosen} />;

  return (
    <>
      <TradeSubNav active="convert" />
      <div data-testid="if-convert" className="if-convert">
        <div className="cvt-grid">
          <header data-testid="cvt-hero" className="cvt-hero">
            <h1>
              <span>{t('Convert')}</span>
              <span data-testid="headline-pair">{shown ? t('{from} to {to}', { from: shown.from, to: shown.to }) : ''}</span>
            </h1>
            <p>{t('Convert tagline')}</p>
          </header>
          {card}
        </div>
        <OtcConvert />
        {signedIn ? <RecentConversions /> : null}
        <section data-testid="cvt-faq" className="cvt-faq" aria-labelledby="cvt-faq-title">
          <h2 id="cvt-faq-title">{t('Questions')}</h2>
          <Accordion>
            {(
              [
                ['Q price', 'A price'],
                ['Q expire', 'A expire'],
                ['Q where', 'A where'],
              ] as const
            ).map(([question, answer]) => (
              <AccordionItem key={question} value={question}>
                <AccordionTrigger>{t(question)}</AccordionTrigger>
                <AccordionPanel>{t(answer)}</AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
        </section>
      </div>
    </>
  );
}

type Reviewing = { quote: Quote; changed: boolean } | null;

/** True when a replacement quote would charge or pay something different from the one the customer reviewed. */
function numbersChanged(reviewed: Quote, current: Quote): boolean {
  return (
    reviewed.quoteId !== current.quoteId &&
    (dec(reviewed.inAmount) !== dec(current.inAmount) ||
      dec(reviewed.outAmount) !== dec(current.outAmount) ||
      reviewed.inAsset !== current.inAsset ||
      reviewed.outAsset !== current.outAsset)
  );
}

function ConvertCard({
  all,
  from,
  to,
  onPair,
}: {
  all: Edge[];
  from: string;
  to: string;
  onPair: (pair: { from: string; to: string }) => void;
}) {
  const { t } = convertCopy.useCopy();
  const { session, api, userId } = useSession();
  const tools = useMemo(() => createToolApi(api), [api]);
  const edge = edgeFor(all, from, to) as Edge;
  const { market } = edge;
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const [reviewing, setReviewing] = useState<Reviewing>(null);
  const [accepting, setAccepting] = useState(false);
  const [dialogMessage, setDialogMessage] = useState<{ text: string; action?: { label: string; href: string } } | null>(null);
  const [result, setResult] = useState<Fill | null>(null);
  const [attempt, setAttempt] = useState<{ ref: AcceptRef; id: string } | null>(null);
  const swappedAt = useRef(0);
  const [rechecking, setRechecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ticker = useTicker(market.symbol);
  const limits = useMarketLimits();
  const available = useAvailable(from);
  const note = usePendingNote(userId);
  const limitRow = limits.status === 'ready' ? limits.data[market.symbol] : undefined;
  const price = ticker.status === 'ready' ? ((edge.side === 'buy' ? ticker.data.ask : ticker.data.bid) ?? ticker.data.last) : null;
  const coinPlaces = fractionDigits(market.lotSize) ?? 8;
  const fromPlaces = edge.side === 'buy' ? 6 : coinPlaces;
  /** Decimals the review shows an asset in: the coin's lot, six for the dollar coin. */
  const placesFor = (asset: string) => (asset === market.base ? coinPlaces : 6);

  const plan = useMemo(
    () => planConvert({ edge, amount, price, minAmount: limitRow?.minAmount ?? null, minCost: limitRow?.minCost ?? null }),
    [edge, amount, price, limitRow],
  );
  const insufficient = useMemo(() => {
    const typed = dec(amount);
    const have = dec(available.value);
    return available.state === 'ready' && typed !== null && have !== null && typed > have;
  }, [amount, available]);
  const inlineError = insufficient
    ? (() => {
        const words = refusalCopy('ledger.insufficient_funds', {
          asset: from,
          available: fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' }),
        });
        return `${words.title}. ${words.body}`;
      })()
    : !plan.ok && plan.problem.kind === 'tooSmall'
      ? plan.problem.asset === edge.market.quote
        ? t('Minimum is about {min} {asset}.', { min: plan.problem.min, asset: plan.problem.asset })
        : t('Minimum is {min} {asset}.', { min: plan.problem.min, asset: plan.problem.asset })
      : !plan.ok && plan.problem.kind === 'notOnLot'
        ? t('Use steps of {step} {asset}.', { step: plan.problem.step, asset: market.base })
        : null;

  const request =
    plan.ok && !insufficient && session && note.state === 'none'
      ? {
          symbol: market.symbol,
          side: edge.side,
          qty: plan.base,
          typed: amount,
          // Never quote more than was typed or than the balance holds: our spread is added ON TOP of the book price.
          cap: spendCap(amount, available.value) ?? amount,
          // Paying with the quote asset (a buy): the service sizes the order to the spend. A sell keeps the coin amount.
          spend: edge.side === 'buy' ? amount : null,
          lot: market.lotSize,
          pair: market.symbol,
        }
      : null;
  const { state, secondsLeft, expired, retry } = useQuote(tools, request);
  const quote = state.status === 'ready' ? state.quote : null;
  // A second look at the answer itself: a quote that costs more than the customer holds is never offered for review.
  const quoteOverBalance = (() => {
    if (!quote || available.state !== 'ready') return false;
    const cost = dec(quote.inAmount);
    const have = dec(available.value);
    return cost !== null && have !== null && cost > have;
  })();
  const shortText = (() => {
    const words = refusalCopy('ledger.insufficient_funds', {
      asset: from,
      available: fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' }),
    });
    return `${words.title}. ${words.body}`;
  })();
  // A reload or another tab loses the screen's own memory of the request, but not the device note: the quote id travels in it.
  const recheck: { ref: AcceptRef; id: string } | null =
    attempt ??
    (note.state === 'pending' && note.pending.kind === 'convert' && note.pending.orderId
      ? {
          ref: { quoteId: note.pending.orderId, symbol: note.pending.symbol, inAsset: null, outAsset: null, cost: null },
          id: note.pending.id,
        }
      : null);
  const ownNote = note.state === 'pending' && recheck !== null && recheck.id === note.pending.id;

  const toList = toAssets(all, from);
  const fromList = fromAssets(all);
  const pickerItems = (assets: string[], showBalance: boolean): PickerItem[] =>
    assets.map((asset) => ({ asset, name: null, detail: showBalance ? <Balance asset={asset} /> : undefined }));

  function pick(side: 'from' | 'to', asset: string) {
    setAmount('');
    if (side === 'from') {
      const reachable = toAssets(all, asset);
      onPair({ from: asset, to: reachable.includes(to) ? to : (reachable[0] ?? to) });
    } else onPair({ from, to: asset });
  }

  function swap() {
    if (edgeFor(all, to, from)) onPair({ from: to, to: from });
  }

  function onMax() {
    if (available.state !== 'ready') return;
    const have = dec(available.value);
    if (have === null || have <= 0n) return;
    // Quotes carry the spread inside the price, so there is no separate fee to hold back: the whole balance, in whole lots when it is a coin.
    setAmount(
      edge.side === 'buy'
        ? toPlaces(have, fromPlaces)
        : (() => {
            const lot = dec(market.lotSize) ?? 0n;
            return lot > 0n ? toPlaces((have / lot) * lot, coinPlaces) : '';
          })(),
    );
  }

  function openReview() {
    if (!quote || expired || !canAccept(quote)) return;
    setDialogMessage(null);
    setReviewing({ quote, changed: false });
  }

  async function onConvert() {
    if (!reviewing || accepting || !quote || expired || state.status !== 'ready' || !canAccept(quote)) return;
    // The customer confirms the numbers they SEE. If a fresh quote with other numbers replaced the reviewed one, this
    // click only acknowledges it; the next click converts.
    if (numbersChanged(reviewing.quote, quote)) {
      setReviewing({ quote, changed: true });
      setDialogMessage(null);
      swappedAt.current = Date.now();
      return;
    }
    // The click that swapped the numbers in must not also be the one that converts them: a quick second click is ignored.
    if (Date.now() - swappedAt.current < 700) return;
    if (quoteOverBalance) {
      setDialogMessage({ text: shortText });
      return;
    }
    // A second click before the screen has redrawn must not send a second request: the ref answers at once, state does not.
    if (sending.current) return;
    sending.current = true;
    const shown = quote;
    const id = newClientConvertId();
    setAccepting(true);
    setDialogMessage(null);
    setAttempt({ ref: refOf(shown), id });
    const outcome = await acceptQuote(tools, userId, refOf(shown), id, {
      asset: from,
      available: fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' }),
      availableRaw: available.value,
    }).finally(() => {
      sending.current = false;
    });
    if (!mounted.current) return;
    setAccepting(false);
    switch (outcome.kind) {
      case 'done':
        setReviewing(null);
        if (userId) defaultPoller().refresh(`balance:${userId}`);
        setResult(outcome.fill);
        return;
      case 'refused': {
        const action = outcome.copy.action;
        setDialogMessage({
          text: `${outcome.copy.title}. ${outcome.copy.body}${outcome.code ? ` (Ref ${outcome.code.trim().slice(0, 80)})` : ''}`,
          action,
        });
        setAttempt(null);
        // The balance may be why: read it again now rather than in half a minute.
        if (userId) defaultPoller().refresh(`balance:${userId}`);
        retry();
        return;
      }
      case 'uncertain':
        setReviewing(null);
        return;
      case 'blocked':
        setDialogMessage({
          text:
            outcome.reason === 'otherTab'
              ? t('Other tab')
              : outcome.reason === 'signedOut'
                ? t('Sign in again')
                : outcome.reason === 'pending'
                  ? t('Earlier body')
                  : t('No safe storage'),
        });
        setAttempt(null);
        return;
    }
  }

  async function onRecheck() {
    if (!recheck || note.state !== 'pending' || note.pending.id !== recheck.id || rechecking) return;
    setRechecking(true);
    setCheckNote(null);
    // Same quote, same request id: the service answers with the original conversion and cannot make a second one.
    const outcome = await acceptQuote(tools, userId, recheck.ref, recheck.id, {}, { recheck: true });
    if (!mounted.current) return;
    setRechecking(false);
    if (outcome.kind === 'done') {
      if (userId) defaultPoller().refresh(`balance:${userId}`);
      setResult(outcome.fill);
    } else if (outcome.kind === 'refused') setCheckNote(`${outcome.copy.title}. ${outcome.copy.body}`);
    else setCheckNote(t('Couldn’t check'));
  }

  const signedOut = !session;
  const loginHref = `/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  const quoteLoading = state.status === 'loading' || (quote !== null && expired);
  const canReview =
    quote !== null &&
    !expired &&
    !insufficient &&
    !quoteOverBalance &&
    canAccept(quote) &&
    !signedOut &&
    note.state === 'none' &&
    available.state === 'ready' &&
    !accepting;
  const rate = quote ? priceText(quote.avgPrice, market) : null;

  if (result)
    return (
      <div className="cvt-card" data-testid="cvt-receipt">
        <div className="buy-receipt" role="status">
          <span className="buy-receipt__badge" aria-hidden="true" data-tone="ok">
            ✓
          </span>
          <h2 data-testid="buy-receipt__title" className="buy-receipt__title">
            {t('Converted {from} to {to}', {
              from: `${fmtAmount(result.inAmount, { places: 18 })} ${result.inAsset}`,
              to: `${fmtAmount(result.outAmount, { places: 18 })} ${result.outAsset}`,
            })}
          </h2>
          <dl className="buy-receipt__rows">
            <div>
              <dt>{t('Paid')}</dt>
              <dd data-testid="cvt-paid">
                {fmtAmount(result.inAmount, { places: 18 })} {result.inAsset}
              </dd>
            </div>
            <div>
              <dt>{t('Received')}</dt>
              <dd data-testid="cvt-received">
                {fmtAmount(result.outAmount, { places: 18 })} {result.outAsset}
              </dd>
            </div>
            <div>
              <dt>{t('Rate')}</dt>
              <dd>{priceText(result.fillPrice, market)}</dd>
            </div>
          </dl>
          <div className="buy-receipt__actions">
            <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={ACTIVITY_HREF} />}>
              {t('View activity')}
            </Button>
            <Button
              variant="secondary"
              size={56}
              fullWidth
              onClick={() => {
                setResult(null);
                setAmount('');
                setAttempt(null);
              }}
            >
              {t('Done')}
            </Button>
          </div>
        </div>
      </div>
    );

  return (
    <section data-testid="cvt-card" className="cvt-card" aria-label={t('Convert')}>
      <div data-testid="cvt-card__head" className="cvt-card__head">
        <h2>{t('Convert')}</h2>
        <a className="cvt-card__history" href={ACTIVITY_HREF} aria-label={t('Conversion history')}>
          <History size={20} aria-hidden="true" />
        </a>
      </div>

      <div className="cvt-fields">
        <div className="cvt-field" data-testid="from-field">
          <span className="cvt-field__label">{t('From')}</span>
          <div className="cvt-field__main">
            <button type="button" className="cvt-asset" onClick={() => setPicker('from')} aria-label={t('Change From asset')}>
              <CoinIcon asset={from} size={28} />
              <span>{from}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <AmountInput
              size="hero"
              aria-label={t('Amount to convert')}
              value={amount}
              onValueChange={setAmount}
              precision={fromPlaces}
              placeholder="0"
              error={inlineError ?? undefined}
              disabled={signedOut}
              className="cvt-amount"
            />
          </div>
          <div className="cvt-field__foot">
            <span data-testid="cvt-available">
              {available.state === 'ready'
                ? t('Available {value}', { value: `${fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' })} ${from}` })
                : t('Available loading')}
            </span>
            {available.state === 'ready' && !signedOut ? (
              <button type="button" className="cvt-max" onClick={onMax}>
                {t('Max')}
              </button>
            ) : null}
          </div>
        </div>

        <button type="button" data-testid="cvt-swap" className="cvt-swap" onClick={swap} aria-label={t('Swap')}>
          <ArrowDownUp size={18} aria-hidden="true" />
        </button>

        <div className="cvt-field" data-testid="to-field">
          <span className="cvt-field__label">{t('To')}</span>
          <div className="cvt-field__main">
            <button type="button" className="cvt-asset" onClick={() => setPicker('to')} aria-label={t('Change To asset')}>
              <CoinIcon asset={to} size={28} />
              <span>{to}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <div
              className="cvt-to"
              data-loading={quoteLoading || undefined}
              data-testid="to-amount"
              title={quote ? `${quote.outAmount} ${quote.outAsset}` : undefined}
            >
              <AmountInput
                size="hero"
                aria-label={t('To')}
                value={quote ? fmtAmount(quote.outAmount, { places: placesFor(quote.outAsset), round: 'down' }) : ''}
                onValueChange={() => undefined}
                precision={18}
                placeholder="0"
                readOnly
                className="cvt-amount"
              />
            </div>
          </div>
        </div>
      </div>

      {quote ? (
        <div className="cvt-breakdown" data-testid="cvt-breakdown" aria-label={t('Price details')} role="group">
          <KeyValue density="dense" items={breakdownItems(quote, market, placesFor, secondsLeft, expired, t)} />
        </div>
      ) : null}

      {rate ? (
        <div className="cvt-rate">
          <span className="cvt-rate__line">
            <span data-testid="rate">{t('Rate: 1 {base} ≈ {price}', { base: market.base, price: rate })}</span>
            <Tooltip>
              <TooltipTrigger className="cvt-rate__tip" render={<button type="button" aria-label={t('Rate label')} />}>
                <Info size={14} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="top">{t('Rate tip', { spread: spreadPercent(quote!.convertSpreadBps) ?? '—' })}</TooltipContent>
            </Tooltip>
            <StatusChip
              asOf={quote!.source.asOf}
              staleAfterMs={holdMs(quote!) || 15_000}
              refused={state.status === 'refused'}
              density="dense"
            />
          </span>
          <span className="cvt-rate__hold" data-testid="hold">
            {expired ? t('Price expired') : t('Price held for {n}s', { n: secondsLeft ?? 0 })}
          </span>
          <HoldBar secondsLeft={secondsLeft} holdLengthMs={holdMs(quote!)} label={t('Price held bar')} />
          {expired ? (
            <Button variant="secondary" size={40} onClick={retry}>
              {t('Get a new price')}
            </Button>
          ) : null}
        </div>
      ) : state.status === 'loading' ? (
        <p className="cvt-rate cvt-rate--wait">{t('Getting your price')}</p>
      ) : null}

      {state.status === 'refused' ? (
        <StateBlock
          kind="refused"
          className="buy-state"
          title={state.copy.title}
          body={state.copy.body}
          code={state.copy.reference ?? (state.code ? `Ref ${state.code.trim().slice(0, 80)}` : undefined)}
          action={state.copy.action}
        />
      ) : null}
      {state.status === 'depth' ? (
        <p data-testid="cvt-note" className="cvt-note">
          {t('Too big')}
        </p>
      ) : null}
      {state.status === 'overCost' ? (
        <p className="cvt-note" data-testid="over-cost">
          {dec(amount) === dec(available.value) ? shortText : t('Too small after price')}
        </p>
      ) : null}
      {quoteOverBalance ? (
        <p data-testid="cvt-note" className="cvt-note" role="alert">
          {shortText}
        </p>
      ) : null}
      {note.state !== 'pending' && checkNote ? (
        <p className="cvt-note" role="status" data-testid="check-note">
          {checkNote}
        </p>
      ) : null}
      {state.status === 'error' ? (
        <StateBlock kind="error" className="buy-state" title={t('Price error title')} onRetry={retry} retryLabel={t('Get a new price')} />
      ) : null}

      {note.state === 'pending' ? (
        <div className="buy-pending" role="alert" data-testid="pending">
          <p className="buy-pending__title">{ownNote ? t('Not confirmed title') : t('Earlier title')}</p>
          <p className="buy-pending__body">{ownNote ? t('Not confirmed body') : t('Earlier body')}</p>
          {checkNote ? <p className="buy-pending__body">{checkNote}</p> : null}
          <div className="buy-pending__actions">
            {ownNote ? (
              <Button variant="secondary" size={40} loading={rechecking} onClick={onRecheck}>
                {rechecking ? t('Checking again') : t('Check again')}
              </Button>
            ) : null}
            <Button variant="ghost" size={40} nativeButton={false} render={<a href={ACTIVITY_HREF} />}>
              {t('View activity')}
            </Button>
          </div>
        </div>
      ) : null}
      {note.state === 'unreadable' ? (
        <p className="buy-pending__body" role="alert">
          {t('No safe storage')}
        </p>
      ) : null}

      {state.status === 'refused' && state.kind === 'convertSpreadUnset' ? null : signedOut ? (
        <Button variant="primary" size={56} fullWidth nativeButton={false} render={<a href={loginHref} />}>
          {t('Log in to convert')}
        </Button>
      ) : (
        <Button variant="primary" size={56} fullWidth disabled={!canReview} onClick={openReview}>
          {!plan.ok && plan.problem.kind === 'empty'
            ? t('Enter an amount')
            : quoteLoading && request
              ? t('Getting your price')
              : t('Preview conversion')}
        </Button>
      )}

      <AlertDialog
        open={reviewing !== null}
        onOpenChange={(open) => {
          if (!open && !accepting) {
            setReviewing(null);
            setDialogMessage(null);
          }
        }}
      >
        <AlertDialogContent className="buy-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Review conversion')}</AlertDialogTitle>
            <AlertDialogDescription>{t('Review hint')}</AlertDialogDescription>
          </AlertDialogHeader>
          {quote ? (
            <div data-testid="dlg-breakdown" aria-busy={expired || undefined}>
              <KeyValue items={breakdownItems(quote, market, placesFor, secondsLeft, expired, t)} />
            </div>
          ) : (
            <p className="buy-dialog__note" role="status">
              {t('Waiting for price')}
            </p>
          )}
          {quote ? (
            <p className="cvt-hold" data-testid="dlg-hold">
              {expired ? t('Waiting for price') : t('Price held for {n}s', { n: secondsLeft ?? 0 })}
            </p>
          ) : null}
          {quote && !canAccept(quote) ? (
            <p className="buy-dialog__error" role="alert" data-testid="dlg-missing">
              <strong>{t('Missing price details')}.</strong> {t('Missing price body')}
            </p>
          ) : null}
          {reviewing?.changed || (reviewing && quote && numbersChanged(reviewing.quote, quote)) ? (
            <p className="buy-dialog__note" role="status" data-testid="dlg-changed">
              <strong>{t('Price changed')}.</strong> {t('Price changed body')}
            </p>
          ) : null}
          {dialogMessage ? (
            <p className="buy-dialog__error" role="alert" data-testid="dlg-error">
              {dialogMessage.text} {dialogMessage.action ? <a href={dialogMessage.action.href}>{dialogMessage.action.label}</a> : null}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="secondary" size={40} />} disabled={accepting}>
              {t('Cancel')}
            </AlertDialogClose>
            <Button variant="primary" size={40} loading={accepting} disabled={!quote || expired || !canAccept(quote)} onClick={onConvert}>
              {accepting
                ? t('Sending')
                : reviewing && quote && numbersChanged(reviewing.quote, quote)
                  ? t('Accept new price')
                  : t('Convert now')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AssetPicker
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        title={t('Choose asset')}
        searchLabel={t('Search assets')}
        noMatch={(query) => t('No asset matches', { query })}
        items={picker === 'to' ? pickerItems(toList, false) : pickerItems(fromList, true)}
        selected={picker === 'to' ? to : from}
        onPick={(asset) => pick(picker === 'to' ? 'to' : 'from', asset)}
      />
    </section>
  );
}

/** The remaining hold as a bar. The kit has no progress part, so this is a plain div with the progressbar role. */
function HoldBar({ secondsLeft, holdLengthMs, label }: { secondsLeft: number | null; holdLengthMs: number; label: string }) {
  const { now, max } = holdProgress(secondsLeft, holdLengthMs);
  return (
    <div
      className="cvt-holdbar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      aria-valuetext={`${now}s`}
      data-testid="hold-bar"
    >
      <div className="cvt-holdbar__fill" style={{ width: `${Math.round((now / max) * 100)}%` }} />
    </div>
  );
}

function Balance({ asset }: { asset: string }) {
  const available = useAvailable(asset);
  return (
    <span className="if-num">
      {available.state === 'ready' ? fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' }) : '—'}
    </span>
  );
}
