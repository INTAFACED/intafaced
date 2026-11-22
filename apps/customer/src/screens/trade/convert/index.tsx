import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownUp, ChevronDown, History, Info } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  CoinMark,
  DecimalField,
  Disclosure,
  EmptyState,
  Freshness,
  Progress,
  RefusalBox,
} from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, Skeleton } from '@intafaced/ui/lit/templates';
import { AssetPicker, type PickerItem } from '../buy/AssetPicker';
import {
  createToolApi,
  defaultPoller,
  fmtAmount,
  fmtPrice,
  refusalCopy,
  useMarkets,
  useSession,
  useTicker,
  type MarketRow,
} from '../buy/deps';
import { usePendingNote } from '../buy/order-flow';
import { useAvailable, useMarketLimits } from '../buy/quote-flow';
import { dec, fractionDigits, mulDown, toPlaces } from '../buy/trade-math';
import { TradeSubNav } from '../TradeSubNav';
import { convertCopy } from './copy';
import { OTC_DESK_ID, OtcConvert } from './OtcConvert';
import { RecentConversions } from './RecentConversions';
import { RouteCard } from './RouteCard';
import { LimitConvert } from './LimitConvert';
import { classifyRefusal } from '../../../data';
import { TradingHoldReason } from '../../../features/account/TradingHoldReason';
import { useConvertPairs } from './use-pairs';
import { canAccept, holdProgress, spreadPercent, validUntilClock } from './breakdown';
import { defaultPair, edgeFor, edges, fromAssets, planConvert, reviewAmount, spendCap, toAssets, type Edge } from './convert-model';
import { acceptQuote, holdMs, newClientConvertId, refOf, useQuote, type AcceptRef, type Fill, type Quote } from './convert-flow';
import type { ScreenProps } from '../../../app/screen-types';
import { useVenueMode } from '../../../features/trade/use-venue-mode';
import { VenueConvertRoom } from './VenueConvert';

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

/** One cost row: a blank figure (null) draws a dash and says "unknown" to assistive tech, never 0. */
type BreakdownItem = { key: string; label: string; value: string | null; hint?: string };

function BreakdownRows({ items, unknown }: { items: BreakdownItem[]; unknown: string }) {
  return (
    <KeyValue
      rows={items.map((item) => ({
        label: item.label,
        value:
          item.value === null ? (
            <>
              <span aria-hidden="true">—</span>
              <span className="lt-sr">{unknown}</span>
            </>
          ) : (
            item.value
          ),
        ...(item.value === null ? { unset: true } : {}),
        ...(item.hint ? { note: item.hint } : {}),
      }))}
    />
  );
}

/** The cost rows shown in the card and in the review dialog. A blank figure draws a dash, never 0. */
function breakdownItems(
  quote: Quote,
  market: MarketRow,
  placesFor: (asset: string) => number,
  secondsLeft: number | null,
  expired: boolean,
  t: T,
): BreakdownItem[] {
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
    {
      key: 'spread',
      label: t('House spread'),
      value: percent ? t('Spread value', { bps: quote.convertSpreadBps, percent }) : null,
      hint: percent ? t('Included in the rate') : undefined,
    },
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
  // Asked for a pair no market joins (a cash currency to a coin): the service names why, and nothing is priced (#11).
  const routeAsked =
    asked.from && asked.to && !chosen && markets.status === 'ready' && !edgeFor(all, asked.from, asked.to)
      ? { from: asked.from, to: asked.to }
      : null;
  const shown = routeAsked ?? (chosen && edgeFor(all, chosen.from, chosen.to) ? chosen : pair);
  // Venue mode (the launch money model): the conversion is one order on the person's own venue account, signed by their
  // wallet. The card and Recent conversions are the venue's; our own book's card is the custodial layer, kept off.
  const venue = useVenueMode();

  let card: ReactNode;
  if (venue.mode === 'on') card = <VenueConvertRoom mode={venue} asked={{ from: asked.from, to: asked.to }} />;
  else if (venue.mode === 'checking') card = <div data-testid="cvt-card--skeleton" aria-busy="true" />;
  else if (markets.status === 'loading')
    card = (
      <div data-testid="cvt-card--skeleton" aria-busy="true">
        <Skeleton shape="form" />
      </div>
    );
  else if (markets.status === 'error')
    card = (
      <div data-testid="cvt-card">
        <RefusalBox role="alert" data-kind="error" refusal={{ variant: 'unreachable', title: t('Couldn’t load assets'), body: '' }}>
          <Button onClick={markets.retry}>{t('Retry')}</Button>
        </RefusalBox>
      </div>
    );
  else if (markets.status === 'refused') {
    const copy = refusalCopy(markets.code);
    card = (
      <div data-testid="cvt-card">
        <RefusalBox data-kind="refused" refusal={refusalOf(copy)} />
      </div>
    );
  } else if (routeAsked) card = <RouteCard key={`${routeAsked.from}>${routeAsked.to}`} from={routeAsked.from} to={routeAsked.to} />;
  else if (!shown)
    card = (
      <div data-testid="cvt-card">
        <EmptyState
          data-kind="empty"
          title={t('No convert title')}
          body={t('No convert body')}
          action={
            <a className="lt-button lt-button-secondary" href="/trade">
              {t('Go to Markets')}
            </a>
          }
        />
      </div>
    );
  else card = <ConvertCard key={`${shown.from}>${shown.to}`} all={all} from={shown.from} to={shown.to} onPair={setChosen} />;

  return (
    <>
      <TradeSubNav active="convert" />
      <FlowTemplate
        title={t('Convert')}
        description={t('Convert tagline')}
        state={{ kind: 'ready' }}
        step={
          <div data-testid="if-convert">
            <header data-testid="cvt-hero">
              <p data-testid="headline-pair">
                {shown && venue.mode === 'off' ? t('{from} to {to}', { from: shown.from, to: shown.to }) : ''}
              </p>
            </header>
            {card}
            <OtcConvert />
            {signedIn && venue.mode === 'off' ? <RecentConversions /> : null}
          </div>
        }
        summary={
          <section data-testid="cvt-faq" aria-labelledby="cvt-faq-title">
            <h2 id="cvt-faq-title">{t('Questions')}</h2>
            {(
              [
                ['Q price', 'A price'],
                ['Q expire', 'A expire'],
                ['Q where', 'A where'],
              ] as const
            ).map(([question, answer]) => (
              <Disclosure key={question} summary={t(question)}>
                {t(answer)}
              </Disclosure>
            ))}
          </section>
        }
      />
    </>
  );
}

/** A refusal in the kit's shape: its words, its reference and its one next step. */
function refusalOf(copy: {
  title: string;
  body: string;
  reference?: string | undefined;
  action?: { label: string; href: string } | undefined;
}) {
  return {
    variant: 'refused' as const,
    title: copy.title,
    body: copy.body,
    ...(copy.reference ? { reference: copy.reference } : {}),
    ...(copy.action ? { action: copy.action } : {}),
  };
}

type Reviewing = { quote: Quote; changed: boolean } | null;

/**
 * True when the quote now on screen is not the one the customer reviewed. Every replacement is a new price, even one with
 * the same numbers: it is accepted first, and only the next click converts (a price held for a stated time is that price).
 */
function numbersChanged(reviewed: Quote, current: Quote): boolean {
  return reviewed.quoteId !== current.quoteId;
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
  const [mode, setMode] = useState<'instant' | 'limit'>('instant');
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const [reviewing, setReviewing] = useState<Reviewing>(null);
  const [accepting, setAccepting] = useState(false);
  const [dialogMessage, setDialogMessage] = useState<{
    text: string;
    action?: { label: string; href: string };
    code?: string | null;
  } | null>(null);
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

  const pairs = useConvertPairs(tools);
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
  // Only coins the service would quote now; each names its per-conversion limit, or that none is set.
  const offered = pairs.status === 'ready' ? new Map(pairs.data.assets.map((a) => [a.asset, a.maxPerConvert])) : null;
  // The operator paused Convert: no price is asked for; the way on is Spot (J-cex-spot-11 #7).
  const pausedByService = pairs.status === 'ready' && pairs.data.paused;
  // Over the per-conversion limit: not priced here; the quote desk takes large amounts (J-cex-spot-11 #9).
  const fromLimit = offered?.get(from) ?? null;
  // The accept counts the limit in this pair's quote asset: a buy's spend as typed, a sell's coins at the price now.
  const tooLarge = useMemo(() => {
    const typed = dec(amount);
    const cap = dec(fromLimit?.amount);
    if (!fromLimit || typed === null || cap === null) return false;
    if (edge.side === 'buy') return typed > cap;
    const at = dec(price);
    return at !== null && mulDown(typed, at) > cap;
  }, [amount, fromLimit, edge.side, price]);
  const insufficient = useMemo(() => {
    const typed = dec(amount);
    const have = dec(available.value);
    return available.state === 'ready' && typed !== null && have !== null && typed > have;
  }, [amount, available]);
  // Not enough is its own card below the field, with the way to deposit; the field names what is wrong with the amount.
  const inlineError = insufficient
    ? null
    : !plan.ok && plan.problem.kind === 'tooSmall'
      ? plan.problem.asset === edge.market.quote
        ? t('Minimum is about {min} {asset}.', { min: plan.problem.min, asset: plan.problem.asset })
        : t('Minimum is {min} {asset}.', { min: plan.problem.min, asset: plan.problem.asset })
      : !plan.ok && plan.problem.kind === 'notOnLot'
        ? t('Use steps of {step} {asset}.', { step: plan.problem.step, asset: market.base })
        : null;

  const request =
    mode === 'instant' && plan.ok && !insufficient && !pausedByService && !tooLarge && session && note.state === 'none'
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
  const paused = pausedByService || (state.status === 'refused' && state.code === 'trade.convert_disabled');
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
    assets
      .filter((asset) => offered === null || offered.has(asset))
      .map((asset) => {
        const limit = offered?.get(asset);
        return {
          asset,
          name: null,
          note:
            offered === null
              ? undefined
              : limit
                ? t('Limit per conversion', { amount: fmtAmount(limit.amount, { places: 0 }), asset: limit.asset })
                : t('Limit not set'),
          detail: showBalance ? <Balance asset={asset} /> : undefined,
        };
      });

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
          code: outcome.code,
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
    !accepting &&
    !paused &&
    !tooLarge;
  const rate = quote ? priceText(quote.avgPrice, market) : null;

  if (result)
    return (
      <div data-testid="cvt-receipt">
        <div role="status">
          <h2 data-testid="buy-receipt__title">
            {t('Converted {from} to {to}', {
              from: `${fmtAmount(result.inAmount, { places: 18 })} ${result.inAsset}`,
              to: `${fmtAmount(result.outAmount, { places: 18 })} ${result.outAsset}`,
            })}
          </h2>
          <dl className="lt-kv">
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
          <div className="lt-actions">
            <a className="lt-button lt-button-primary" href={ACTIVITY_HREF}>
              {t('View activity')}
            </a>
            <Button
              tone="secondary"
              size="lg"
              block
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
    <section data-testid="cvt-card" aria-label={t('Convert')}>
      <div data-testid="cvt-card__head" className="lt-title-row">
        <h2>{t('Convert')}</h2>
        <a className="lt-link" href={ACTIVITY_HREF} aria-label={t('Conversion history')}>
          <History size={20} aria-hidden="true" />
        </a>
      </div>
      {signedOut ? null : (
        <div role="tablist" aria-label={t('Convert mode')} className="lt-tabs">
          {(
            [
              ['instant', t('Instant')],
              ['limit', t('Limit')],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              role="tab"
              tone="quiet"
              aria-selected={mode === value}
              tabIndex={mode === value ? 0 : -1}
              onClick={() => setMode(value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') setMode(mode === 'instant' ? 'limit' : 'instant');
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {mode === 'limit' && !signedOut ? (
        <LimitConvert
          tools={tools}
          market={market}
          side={edge.side}
          from={from}
          to={to}
          available={available.state === 'ready' ? available.value : null}
          price={price}
          paused={paused}
        />
      ) : (
        <>
          <div data-testid="from-field">
            <p className="lt-hint">{t('From')}</p>
            <div className="lt-toolbar">
              <Button onClick={() => setPicker('from')} aria-label={t('Change From asset')}>
                <CoinMark asset={from} size="sm" />
                <span>{from}</span>
                <ChevronDown size={16} aria-hidden="true" />
              </Button>
              <DecimalField
                label={t('Amount to convert')}
                labelHidden
                size="hero"
                typedMark="either"
                value={amount}
                onValueChange={setAmount}
                precision={fromPlaces}
                placeholder="0"
                {...(inlineError ? { error: inlineError } : {})}
                disabled={signedOut}
              />
            </div>
            <div className="lt-toolbar">
              <span data-testid="cvt-available">
                {available.state === 'ready'
                  ? t('Available {value}', { value: `${fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' })} ${from}` })
                  : t('Available loading')}
              </span>
              {available.state === 'ready' && !signedOut ? (
                <Button tone="quiet" onClick={onMax}>
                  {t('Max')}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="lt-actions">
            <Button tone="quiet" data-testid="cvt-swap" onClick={swap} aria-label={t('Swap')}>
              <ArrowDownUp size={18} aria-hidden="true" />
            </Button>
          </div>

          <div data-testid="to-field">
            <p className="lt-hint">{t('To')}</p>
            <div className="lt-toolbar">
              <Button onClick={() => setPicker('to')} aria-label={t('Change To asset')}>
                <CoinMark asset={to} size="sm" />
                <span>{to}</span>
                <ChevronDown size={16} aria-hidden="true" />
              </Button>
              <div
                data-loading={quoteLoading || undefined}
                data-testid="to-amount"
                title={quote ? `${quote.outAmount} ${quote.outAsset}` : undefined}
              >
                <DecimalField
                  label={t('To')}
                  labelHidden
                  size="hero"
                  typedMark="either"
                  value={quote ? fmtAmount(quote.outAmount, { places: placesFor(quote.outAsset), round: 'down' }) : ''}
                  onValueChange={() => undefined}
                  precision={18}
                  placeholder="0"
                  readOnly
                />
              </div>
            </div>
          </div>

          {insufficient ? (
            <div role="alert" data-testid="cvt-short">
              <p>{shortText}</p>
              <div className="lt-actions">
                <a className="lt-link" href={`/uc/recharge?asset=${encodeURIComponent(from)}`}>
                  {t('Deposit {asset}', { asset: from })}
                </a>
              </div>
            </div>
          ) : null}
          {paused ? (
            <div role="alert" data-testid="cvt-paused" data-code="trade.convert_disabled">
              <p>
                <strong>{t('Paused title')}.</strong> {t('Paused body')}
              </p>
              <div className="lt-actions">
                <a className="lt-link" href={`/trade/spot/${encodeURIComponent(market.base)}-${encodeURIComponent(market.quote)}`}>
                  {t('Use Spot')}
                </a>
              </div>
            </div>
          ) : null}
          {tooLarge && fromLimit ? (
            <div role="note" data-testid="cvt-too-large">
              <p>
                <strong>{t('Too large title')}.</strong>{' '}
                {t('Too large body', { amount: fmtAmount(fromLimit.amount, { places: 0 }), asset: market.quote })}
              </p>
              <div className="lt-actions">
                <a
                  className="lt-link"
                  href={`#${OTC_DESK_ID}`}
                  onClick={(event) => {
                    event.preventDefault();
                    const desk = document.getElementById(OTC_DESK_ID);
                    desk?.scrollIntoView({ block: 'start' });
                    desk?.focus();
                  }}
                >
                  {t('Use the quote desk')}
                </a>
              </div>
            </div>
          ) : null}
          {quote ? (
            <div data-testid="cvt-breakdown" aria-label={t('Price details')} role="group">
              <BreakdownRows items={breakdownItems(quote, market, placesFor, secondsLeft, expired, t)} unknown={t('Value unknown')} />
            </div>
          ) : null}

          {rate ? (
            <div>
              <div className="lt-toolbar">
                <span data-testid="rate">{t('Rate: 1 {base} ≈ {price}', { base: market.base, price: rate })}</span>
                <Disclosure variant="inline" summary={<Info size={14} aria-hidden="true" />} summaryLabel={t('Rate label')}>
                  {t('Rate tip', { spread: spreadPercent(quote!.convertSpreadBps) ?? '—' })}
                </Disclosure>
                <Freshness
                  asOf={quote!.source.asOf}
                  staleAfterMs={holdMs(quote!) || 15_000}
                  words={{ live: t('Fresh live'), stale: t('Fresh stale'), unknown: t('Fresh unknown'), asOf: t('Fresh as of') }}
                />
              </div>
              <p className="lt-hint" data-testid="hold">
                {expired ? t('Price expired') : t('Price held for {n}s', { n: secondsLeft ?? 0 })}
              </p>
              <HoldBar secondsLeft={secondsLeft} holdLengthMs={holdMs(quote!)} label={t('Price held bar')} />
              {expired ? (
                <div className="lt-actions">
                  <Button onClick={retry}>{t('Get a new price')}</Button>
                </div>
              ) : null}
            </div>
          ) : state.status === 'loading' ? (
            <p className="lt-hint">{t('Getting your price')}</p>
          ) : null}

          {state.status === 'refused' && !paused ? (
            <RefusalBox
              data-kind="refused"
              refusal={refusalOf({
                ...state.copy,
                reference: state.copy.reference ?? (state.code ? `Ref ${state.code.trim().slice(0, 80)}` : undefined),
              })}
            />
          ) : null}
          {state.status === 'refused' && !paused && state.kind === 'tradingOnHold' ? <TradingHoldReason /> : null}
          {state.status === 'depth' ? <p data-testid="cvt-note">{t('Too big')}</p> : null}
          {state.status === 'overCost' ? (
            <p data-testid="over-cost">{dec(amount) === dec(available.value) ? shortText : t('Too small after price')}</p>
          ) : null}
          {quoteOverBalance ? (
            <p data-testid="cvt-note" role="alert">
              {shortText}
            </p>
          ) : null}
          {note.state !== 'pending' && checkNote ? (
            <p role="status" data-testid="check-note">
              {checkNote}
            </p>
          ) : null}
          {state.status === 'error' ? (
            <RefusalBox role="alert" data-kind="error" refusal={{ variant: 'unreachable', title: t('Price error title'), body: '' }}>
              <Button onClick={retry}>{t('Get a new price')}</Button>
            </RefusalBox>
          ) : null}

          {note.state === 'pending' ? (
            <div role="alert" data-testid="pending">
              <p>
                <strong>{ownNote ? t('Not confirmed title') : t('Earlier title')}</strong>
              </p>
              <p>{ownNote ? t('Not confirmed body') : t('Earlier body')}</p>
              {checkNote ? <p>{checkNote}</p> : null}
              <div className="lt-actions">
                {ownNote ? (
                  <Button disabled={rechecking} aria-busy={rechecking || undefined} onClick={onRecheck}>
                    {rechecking ? t('Checking again') : t('Check again')}
                  </Button>
                ) : null}
                <a className="lt-link" href={ACTIVITY_HREF}>
                  {t('View activity')}
                </a>
              </div>
            </div>
          ) : null}
          {note.state === 'unreadable' ? <p role="alert">{t('No safe storage')}</p> : null}

          {state.status === 'refused' && state.kind === 'convertSpreadUnset' ? null : signedOut ? (
            <div className="lt-actions">
              <a className="lt-button lt-button-primary" href={loginHref}>
                {t('Log in to convert')}
              </a>
            </div>
          ) : (
            <Button tone="primary" size="lg" block disabled={!canReview} onClick={openReview}>
              {!plan.ok && plan.problem.kind === 'empty'
                ? t('Enter an amount')
                : quoteLoading && request
                  ? t('Getting your price')
                  : t('Preview conversion')}
            </Button>
          )}
        </>
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Review conversion')}</AlertDialogTitle>
            <AlertDialogDescription>{t('Review hint')}</AlertDialogDescription>
          </AlertDialogHeader>
          {quote ? (
            <div data-testid="dlg-breakdown" aria-busy={expired || undefined}>
              <BreakdownRows items={breakdownItems(quote, market, placesFor, secondsLeft, expired, t)} unknown={t('Value unknown')} />
            </div>
          ) : (
            <p role="status">{t('Waiting for price')}</p>
          )}
          {quote ? (
            <p className="lt-hint" data-testid="dlg-hold">
              {expired ? t('Waiting for price') : t('Price held for {n}s', { n: secondsLeft ?? 0 })}
            </p>
          ) : null}
          {quote && !canAccept(quote) ? (
            <p role="alert" data-testid="dlg-missing">
              <strong>{t('Missing price details')}.</strong> {t('Missing price body')}
            </p>
          ) : null}
          {reviewing?.changed || (reviewing && quote && numbersChanged(reviewing.quote, quote)) ? (
            <p role="status" data-testid="dlg-changed">
              <strong>{t('Price changed')}.</strong> {t('Price changed body')}
            </p>
          ) : null}
          {dialogMessage ? (
            <p role="alert" data-testid="dlg-error">
              {dialogMessage.text}{' '}
              {dialogMessage.action ? (
                <a className="lt-link" href={dialogMessage.action.href}>
                  {dialogMessage.action.label}
                </a>
              ) : null}
            </p>
          ) : null}
          {/* J-identity-14 #2: a trading hold gives the restriction's stored reason here too, in the status page's words. */}
          {dialogMessage && classifyRefusal(dialogMessage.code) === 'tradingOnHold' ? <TradingHoldReason /> : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button tone="secondary" />} disabled={accepting}>
              {t('Cancel')}
            </AlertDialogClose>
            <Button
              tone="primary"
              aria-busy={accepting || undefined}
              disabled={accepting || !quote || expired || !canAccept(quote)}
              onClick={onConvert}
            >
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

/** The remaining hold as the kit's progress bar (role progressbar), named and read out in seconds. */
function HoldBar({ secondsLeft, holdLengthMs, label }: { secondsLeft: number | null; holdLengthMs: number; label: string }) {
  const { now, max } = holdProgress(secondsLeft, holdLengthMs);
  return <Progress label={label} value={now} max={max} valueText={`${now}s`} data-testid="hold-bar" />;
}

function Balance({ asset }: { asset: string }) {
  const available = useAvailable(asset);
  return <span>{available.state === 'ready' ? fmtAmount(available.value, { places: BALANCE_PLACES, round: 'down' }) : '—'}</span>;
}
