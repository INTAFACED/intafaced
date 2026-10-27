/**
 * The Futures ticket (TRFUT-SPEC §2.2). A position opens through an order on the futures book (futures ADR): market
 * (it fills at the best prices up to the price band's edge) or limit (it rests at the trader's price). The form is:
 * direction, order type, size, leverage, Review (the service's own preview at the mark), then Open behind a confirm
 * step that re-checks the numbers.
 * Every control that cannot work says the real reason in one line. Nothing is sent from here except through the
 * shared writer, and one intent keeps one request id until the numbers change.
 */
import { useEffect, useRef, useState } from 'react';
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTrigger,
  SegmentedControl,
  Skeleton,
  StateBlock,
  StatusChip,
  Switch,
  type KeyValueItem,
} from '@intafaced/ui';
import { dec, fractionDigits, isPositive, str } from '../../../data/decimal';
import { fmtAmount, fmtPct, fmtPctPoints, fmtPrice } from '../../../data/format';
import { bpsToRatio } from '../desk/form-logic';
import type { BalanceEntry } from '../../../data/derive';
import type { Loadable } from '../../../data/types';
import type { FuturesListing, FuturesOrder, OrderTypeEntry, PositionPreview, TickerStrip } from './api';
import { STALE_AFTER_MS, useFuturesApi, useFuturesRefresh, useOrderTypes } from './data';
import { entryLegProblem, legSide } from './protection-logic';
import { newNonce, useFuturesWriter, type Writer } from './hooks';
import { allInCost, isStale, leveragePresets, openId, reduceId, stateOf } from './model';
import { futuresRefusal, isPlaneOff, type FuturesRefusal } from './refusals';
import { ticketCopy } from './ticket-copy';
import {
  contractsAllowed,
  openBlock,
  percentSize,
  previewLiquidationDistance,
  previewsEqual,
  reviewBlock,
  sameForm,
  sizeInBase,
  splitPreview,
  sizePlaces,
  tierToConfirm,
  type FormKey,
  type OpenBlock,
  type ReviewBlock,
  type Side,
  type SizeUnit,
} from './ticket-logic';
import type { Pending } from '../buy/write-lock';
import type { WriteOutcome } from './write';

export interface TicketProps {
  market: FuturesListing;
  strip: Loadable<TickerStrip>;
  balances: Loadable<Record<string, BalanceEntry>>;
  /** The futures plane is switched off: the form is replaced by one block naming the switch. */
  planeOff: boolean;
  now: number;
  /** The order the book took: filled into a position, or resting. */
  onOpened(order: FuturesOrder | null): void;
}

type Review =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'refused'; refusal: FuturesRefusal }
  | { status: 'ready'; form: FormKey; data: PositionPreview; at: number };

interface Confirm {
  data: PositionPreview;
  changed: boolean;
  checking: boolean;
  /** Placed as the children the review named (`split`), not as one order. */
  split: boolean;
  /** The trader ticked the new margin tier the review named (`riskTier.confirmRequired`). */
  tierAccepted: boolean;
}

/** The two types the futures book takes; everything else the catalogue lists is shown with its refusal. */
type BookType = 'market' | 'limit';
const BOOK_TYPES: readonly BookType[] = ['market', 'limit'];
const PERCENTS = [25, 50, 75, 100] as const;
const note = 'text-xs text-fg-2';

/** Words for the order type ids the service's catalogue lists; an id without words is shown as sent. */
const TYPE_NAMES = {
  stop_market: 'Type stop market',
  stop_limit: 'Type stop limit',
  take_profit: 'Type take profit',
  trailing: 'Type trailing',
  trailing_stop: 'Type trailing',
  post_only: 'Type post only',
  ioc: 'Type ioc fok',
  fok: 'Type ioc fok',
  scaled: 'Type scaled',
  twap: 'Type twap',
} as const;

const COLLATERAL_CHOICES = ['cash', 'yield_bearing', 'staked', 'lending_idle'] as const;
type CollateralChoice = (typeof COLLATERAL_CHOICES)[number];

export function Ticket(props: TicketProps) {
  const { market, strip, balances, now, onOpened } = props;
  const { t } = ticketCopy.useCopy();
  const api = useFuturesApi();
  const refresh = useFuturesRefresh();
  const writer = useFuturesWriter(refresh);
  const asset = market.settle ?? market.quote;

  const [side, setSide] = useState<Side>('long');
  const [orderType, setOrderType] = useState<BookType>('market');
  const [limitRaw, setLimitRaw] = useState('');
  const [adjust, setAdjust] = useState(false);
  const catalogue = useOrderTypes();
  const [unit, setUnit] = useState<SizeUnit>('base');
  const [sizeRaw, setSizeRaw] = useState('');
  const [leverage, setLeverage] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  // What the last open asked to be protected with, shown once it is placed.
  const [protectedOpen, setProtectedOpen] = useState<{ takeProfit: string | null; stopLoss: string | null } | null>(null);
  const [nonce, setNonce] = useState(newNonce);
  const [review, setReview] = useState<Review>({ status: 'idle' });
  const [modeAsked, setModeAsked] = useState<string | null>(null);
  const [collateral, setCollateral] = useState<CollateralChoice>('cash');
  const [cap, setCap] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [offSeen, setOffSeen] = useState(false);
  // Reduce-only: the order can only lower a position on the other side, so it is sent without a cost review.
  const [reduceOnly, setReduceOnly] = useState(false);
  const [reduceConfirm, setReduceConfirm] = useState(false);

  const size = sizeInBase(sizeRaw, unit, market);
  const lev = dec(leverage) === null ? '' : str(dec(leverage)!);
  const limitPrice = orderType === 'limit' && isPositive(limitRaw) ? str(dec(limitRaw)!) : null;
  const entries: OrderTypeEntry[] =
    catalogue.status === 'ready' ? (catalogue.data.markets.find((m) => m.market === market.symbol)?.orderTypes ?? []) : [];
  const offered = BOOK_TYPES.filter((id) => entries.some((e) => e.id === id && e.state === 'available'));
  const refusedTypes = entries.filter((e) => e.state === 'refused');
  const typeName = (id: string) => {
    const key = Object.hasOwn(TYPE_NAMES, id) ? TYPE_NAMES[id as keyof typeof TYPE_NAMES] : null;
    return key ? t(key) : id;
  };
  const form: FormKey | null =
    size !== null && isPositive(size) && isPositive(lev) && (orderType === 'market' || limitPrice !== null)
      ? {
          symbol: market.symbol,
          side,
          size,
          leverage: lev,
          ...(collateral === 'cash' ? {} : { collateralClass: collateral }),
          type: orderType,
          ...(limitPrice !== null ? { limitPrice } : {}),
          ...(orderType === 'limit' && adjust ? { priceCorrection: 'adjust' as const } : {}),
        }
      : null;
  const formRef = useRef(form);
  formRef.current = form;
  const request = useRef(0);

  /** Any change to the numbers is a new intent: new request id, old review and any open dialog dropped, late answers ignored. */
  const touch = () => {
    request.current++;
    setNonce(newNonce());
    setReview({ status: 'idle' });
    setConfirm(null);
    setReduceConfirm(false);
    if (writer.outcome && writer.outcome.kind !== 'uncertain') writer.dismiss();
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    touch();
    setSizeRaw('');
    setTakeProfit('');
    setStopLoss('');
    setProtectedOpen(null);
    setCap(null);
    setOffSeen(false);
    // Only a different contract resets the form; `touch` reads fresh state each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.symbol]);

  const signedOut = balances.status === 'refused' && balances.code === 'auth.required';
  const planeOff = props.planeOff || offSeen;
  const free = balances.status === 'ready' ? (balances.data[asset]?.free ?? '0') : null; // a ready balance list without the asset holds none of it
  const markNow = strip.status === 'ready' ? strip.data.markPrice : null;
  const markAsOf = strip.status === 'ready' ? strip.asOf : null;
  const markStale = isStale(markAsOf, now, STALE_AFTER_MS.strip);
  const shown = review.status === 'ready' && form && sameForm(review.form, form) ? review.data : null;
  const gate = (preview: PositionPreview | null) =>
    openBlock({
      planeOff,
      signedOut,
      locked: writer.locked,
      markKnown: markNow !== null,
      markStale,
      preview,
      leverage: lev,
      free,
    });
  const typeOff = !offered.includes(orderType) ? 'typeUnavailable' : orderType === 'limit' && limitPrice === null ? 'noLimitPrice' : null;
  // A take profit or stop loss on the order: checked against the mark here, and again by the service.
  const legProblems = {
    take_profit: entryLegProblem(side, 'take_profit', takeProfit, markNow),
    stop_loss: entryLegProblem(side, 'stop_loss', stopLoss, markNow),
  };
  const protecting = takeProfit.trim() !== '' || stopLoss.trim() !== '';
  const protectOff = legProblems.take_profit !== null || legProblems.stop_loss !== null ? ('protectionProblem' as const) : null;
  const openOff = gate(shown) ?? typeOff ?? protectOff;
  // Above the max-order the review names a split: it may be placed as those children when nothing else refuses.
  const splitShown = splitPreview(shown);
  const splitOff = splitShown ? (gate(splitShown) ?? typeOff ?? (protecting ? ('protectionSplit' as const) : null)) : null;
  const reviewOff = reduceOnly
    ? ('reduceOnly' as const)
    : (reviewBlock({ planeOff, signedOut, markKnown: markNow !== null, markStale, size, leverage: lev }) ??
      (orderType === 'limit' && limitPrice === null ? 'noLimitPrice' : null));
  // A reduce-only order needs a size and its type's price; the service checks the position it lowers.
  const reduceOff = writer.note.state !== 'none' ? ('locked' as const) : size === null || !isPositive(size) ? ('noSize' as const) : typeOff;

  if (planeOff)
    return (
      <EmptyState
        variant="unavailable"
        size="panel"
        title={t('Plane off title')}
        reason={t('Plane off reason')}
        code="trade.futures_disabled"
      />
    );
  if (signedOut)
    return (
      <EmptyState
        variant="refused"
        size="panel"
        title={t('Signed out title')}
        reason={t('Signed out body')}
        action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent(window.location.pathname)}`, variant: 'secondary' }}
      />
    );
  if (balances.status === 'error') return <StateBlock kind="error" thing={t('Balance error')} onRetry={balances.retry} />;

  const settle = (failure: Parameters<typeof futuresRefusal>[0]) => {
    const refusal = futuresRefusal(failure);
    if (isPlaneOff(refusal.code)) setOffSeen(true);
    return refusal;
  };

  async function runReview() {
    const asked = formRef.current;
    if (!asked) return;
    const id = ++request.current;
    setReview({ status: 'loading' });
    const result = await api.preview(asked);
    // A late answer for numbers the trader has since changed must not show or enable anything.
    const current = formRef.current;
    if (id !== request.current || !current || !sameForm(asked, current)) return;
    if (result.ok) {
      setCap(result.data.leverageCap);
      setReview({ status: 'ready', form: asked, data: result.data, at: Date.now() });
    } else if (result.reason === 'uncertain' || result.reason === 'unreachable' || result.reason === 'error')
      setReview({ status: 'error' });
    else setReview({ status: 'refused', refusal: settle(result) });
  }

  async function confirmOpen() {
    const asked = formRef.current;
    if (!confirm || !asked) return;
    if (!confirm.changed) {
      // The mark moves: re-ask now and compare with what the trader reviewed. A difference is shown, never sent.
      setConfirm({ ...confirm, checking: true });
      const result = await api.preview(asked);
      const current = formRef.current;
      if (!current || !sameForm(asked, current)) return;
      if (!result.ok) {
        setConfirm(null);
        setReview(
          result.reason === 'uncertain' || result.reason === 'unreachable' || result.reason === 'error'
            ? { status: 'error' }
            : { status: 'refused', refusal: settle(result) },
        );
        return;
      }
      if (!previewsEqual(result.data, confirm.data)) {
        setCap(result.data.leverageCap);
        setReview({ status: 'ready', form: asked, data: result.data, at: Date.now() });
        setConfirm({ data: result.data, changed: true, checking: false, split: confirm.split, tierAccepted: false });
        return;
      }
    }
    const tier = tierToConfirm(confirm.data);
    if (tier !== null && !confirm.tierAccepted) return;
    setConfirm(null);
    if (typeOff !== null) return;
    const { limitPrice: askedPrice, ...rest } = asked;
    finish(
      await writer.run({
        op: 'open',
        input: {
          ...rest,
          type: orderType,
          ...(askedPrice !== undefined ? { price: askedPrice } : {}),
          ...(confirm.split ? { split: true as const } : {}),
          ...(tier !== null ? { confirmTier: tier } : {}),
          ...(!confirm.split && takeProfit.trim() !== '' ? { takeProfit: takeProfit.trim() } : {}),
          ...(!confirm.split && stopLoss.trim() !== '' ? { stopLoss: stopLoss.trim() } : {}),
          clientOpenId: openId(nonce),
        },
      }),
    );
  }

  async function confirmReduce() {
    if (reduceOff !== null || size === null) return;
    setReduceConfirm(false);
    const outcome = await writer.run({
      op: 'reduce',
      input: {
        symbol: market.symbol,
        side: side === 'long' ? 'buy' : 'sell',
        size,
        type: orderType,
        ...(limitPrice !== null ? { price: limitPrice } : {}),
        ...(orderType === 'limit' && adjust ? { priceCorrection: 'adjust' as const } : {}),
        clientOrderId: reduceId(nonce),
      },
    });
    // A refused reduce is final: the next press is a new request, not a replay of the refused one.
    if (outcome.kind === 'refused') setNonce(newNonce());
    finish(outcome);
  }

  function finish(outcome: WriteOutcome) {
    if (outcome.kind === 'done') {
      // The open is finished: a new request id and a fresh review are needed for another, so a second click cannot re-send this one.
      request.current++;
      setNonce(newNonce());
      setReview({ status: 'idle' });
      setConfirm(null);
      const asked = outcome.order?.protection;
      setProtectedOpen(asked ? { takeProfit: asked.takeProfit, stopLoss: asked.stopLoss } : null);
      if (asked) {
        setTakeProfit('');
        setStopLoss('');
      }
      onOpened(outcome.order ?? null);
    } else if (outcome.kind === 'refused' && isPlaneOff(outcome.refusal.code)) setOffSeen(true);
  }

  const money = (v: string | null) => (v === null ? null : `${fmtAmount(v)} ${asset}`);
  const price = (v: string | null) => (v === null ? null : fmtPrice(v, market.precision.price));
  const costItems = (p: PositionPreview, at: number | null): KeyValueItem[] => {
    const cost = allInCost(p, free);
    const distance = previewLiquidationDistance(p);
    const source = typeof p.markSource === 'string' ? t('Mark source', { source: p.markSource }) : undefined;
    return [
      { label: t('Mark price'), value: price(p.markPrice), hint: source, asOf: at ?? undefined },
      { label: t('Order value'), value: money(cost.orderValue) },
      { label: t('Initial margin'), value: money(cost.initialMargin) },
      { label: t('Estimated fee'), value: money(cost.estimatedFee) },
      { label: t('Total to commit'), value: money(cost.totalToCommit), hint: t('Total hint') },
      { label: t('Free balance'), value: money(free) },
      { label: t('Free balance after'), value: money(cost.freeAfter) },
      { label: t('Liquidation price'), value: price(p.liquidationPrice) },
      {
        label: t('Distance to liquidation'),
        value: distance === null ? null : fmtPctPoints(distance, { signed: false }),
        hint: t('Distance hint'),
      },
      { label: t('Leverage cap'), value: p.leverageCap === null ? null : `${fmtAmount(p.leverageCap)}x` },
      ...tierItems(p),
      ...openInterestItems(p),
      ...controlItems(p),
    ];
  };
  /** The margin tier the order carries this side into, from the service's own ladder at today's depth. */
  const tierItems = (p: PositionPreview): KeyValueItem[] => {
    if (p.riskTier === undefined) return [];
    const tier = p.riskTier;
    return [
      {
        label: t('Margin tier'),
        value:
          tier === null ? null : t('Tier value', { tier: String(tier.projected), rate: fmtPct(tier.maintenanceRate, { signed: false }) }),
        hint: tier?.confirmRequired ? t('Tier confirm hint') : t('Tier hint'),
      },
    ];
  };
  /** The open interest this account may still add on the contract, and the limit that sets it (D-margin-05). */
  const openInterestItems = (p: PositionPreview): KeyValueItem[] => {
    if (p.openInterest === undefined) return [];
    const oi = p.openInterest;
    const base = market.base;
    if (oi === null) {
      // Only a blank limit reads "not published"; a room that could not be read is an unknown figure, named on its line.
      const unset = p.refusals.some((r) => r.code === 'trade.oi_limit_unset');
      return [
        unset
          ? { label: t('Open interest room'), value: t('Open interest unset'), hint: t('Open interest unset hint') }
          : { label: t('Open interest room'), value: null },
      ];
    }
    return [
      {
        label: t('Open interest room'),
        value: t('Open interest room value', { room: fmtAmount(oi.room), base }),
        hint:
          oi.binding === 'market'
            ? t('Open interest market hint', { limit: fmtAmount(oi.limit), base })
            : t('Open interest share hint', {
                cap: fmtAmount(oi.accountCap),
                limit: fmtAmount(oi.limit),
                base,
                pct: fmtPct(bpsToRatio(oi.shareBps), { signed: false }),
              }),
      },
    ];
  };
  /** The band's width and, while the dynamic range has widened it, by how much and why. */
  const bandHint = (band: NonNullable<PositionPreview['band']>): string => {
    const pct = (v: string) => fmtPct(v, { signed: false });
    if (band.source !== 'dynamic' || !band.staticFraction) return t('Band hint', { pct: pct(band.fraction) });
    return t(band.reason === 'capped' ? 'Band wider capped hint' : 'Band wider hint', {
      pct: pct(band.fraction),
      usual: pct(band.staticFraction),
      premium: band.premium == null ? '' : pct(band.premium),
    });
  };
  /** The band, the price the order is held and sent at, the slippage cap and the max-order: the limits this order meets. */
  const controlItems = (p: PositionPreview): KeyValueItem[] => {
    if (p.band === undefined) return [];
    const items: KeyValueItem[] = [
      {
        label: t('Price band'),
        value: p.band === null ? t('Not set') : t('Band range', { low: price(p.band.low) ?? '', high: price(p.band.high) ?? '' }),
        hint: p.band === null ? t('Band unset hint') : bandHint(p.band),
      },
      { label: p.type === 'limit' ? t('Order price limit') : t('Order price market'), value: price(p.orderPrice ?? null) },
    ];
    if (p.type !== 'limit') {
      items.push({
        label: t('Slippage cap'),
        value: p.slippageCapBps == null ? t('Not set') : t('Slippage bps', { bps: String(p.slippageCapBps) }),
        hint: p.slippageCapBps == null ? t('Slippage unset hint') : t('Slippage hint'),
      });
    }
    if (p.priceCorrection) {
      items.push({
        label: t('Price corrected'),
        value: t('Corrected from to', { asked: price(p.priceCorrection.asked) ?? '', applied: price(p.priceCorrection.applied) ?? '' }),
      });
    }
    items.push({ label: t('Max order'), value: p.maxOrderNotional == null ? t('Not set') : money(p.maxOrderNotional) });
    return items;
  };

  const offWords: Record<
    Exclude<OpenBlock | ReviewBlock | typeof typeOff | 'protectionProblem' | 'protectionSplit' | 'reduceOnly', null>,
    string
  > = {
    reduceOnly: t('Off reduce review'),
    protectionProblem: t('Off protection problem'),
    protectionSplit: t('Off protection split'),
    typeUnavailable: catalogue.status === 'ready' ? t('Off type unavailable') : t('Off types loading'),
    noLimitPrice: t('Off no limit price'),
    planeOff: t('Off plane'),
    signedOut: t('Off signed out'),
    locked: t('Off locked'),
    markUnknown: t('Off mark unknown'),
    markStale: t('Off mark stale'),
    noSize: t('Off no size'),
    noLeverage: t('Off no leverage'),
    notReviewed: t('Off not reviewed'),
    notOrderable: t('Off not orderable'),
    missingFigures: t('Off missing figures'),
    overCap: t('Off over cap'),
    balanceUnknown: t('Off balance unknown'),
    insufficient: t('Off insufficient'),
  };
  // Before a review the most useful reason is what is missing from the form, not "review first".
  const openWhy = openOff === 'notReviewed' && reviewOff ? offWords[reviewOff] : openOff ? offWords[openOff] : null;
  const actionWhy = reduceOnly ? (reduceOff === null ? null : offWords[reduceOff]) : openWhy;

  const percentOff = leverage === '' || lev === '' ? t('Percent needs leverage') : null;
  const percentTo = (pct: number) => percentSize({ free, leverage: lev, mark: markNow, pct, unit, places: sizePlaces(market) }, market);
  const baseNote = unit === 'contracts' && size !== null ? t('In base', { size: fmtAmount(size), asset: market.base }) : null;
  const presets = leveragePresets(cap);
  const sideWord = side === 'long' ? t('Long') : t('Short');

  return (
    <section aria-label={t('Ticket')} className="flex flex-col gap-3 p-3">
      <SegmentedControl
        aria-label={t('Direction')}
        size={40}
        fullWidth
        value={side}
        onValueChange={(v) => {
          setSide(v as Side);
          touch();
        }}
        // Reduce-only names what the order does, since a buy lowers a short and a sell lowers a long.
        items={[
          { value: 'long', label: reduceOnly ? t('Reduce direction buy') : t('Long'), tone: 'up' },
          { value: 'short', label: reduceOnly ? t('Reduce direction sell') : t('Short'), tone: 'down' },
        ]}
      />

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg-2">{t('Margin mode')}</span>
        <span className="flex items-center gap-2">
          <SegmentedControl
            aria-label={t('Margin mode')}
            size={28}
            value="isolated"
            onValueChange={(v) =>
              // Only isolated is live. Choosing another mode changes nothing and sends nothing: it names the rule.
              setModeAsked(v === 'cross' ? 'trade.cross_margin_unsupported' : v === 'portfolio' ? 'trade.portfolio_margin_unset' : null)
            }
            items={[
              { value: 'isolated', label: t('Isolated') },
              { value: 'cross', label: t('Cross') },
              { value: 'portfolio', label: t('Portfolio') },
            ]}
          />
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size={28} />}>{t('Why only isolated')}</PopoverTrigger>
            <PopoverContent>
              <PopoverDescription>{t('Isolated rule')}</PopoverDescription>
            </PopoverContent>
          </Popover>
        </span>
      </div>
      {modeAsked ? (
        <p role="status" className="text-xs text-warn" data-code={modeAsked}>
          {futuresRefusal({ code: modeAsked }).title}. {futuresRefusal({ code: modeAsked }).body}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg-2">{t('Margin from')}</span>
        {/* Cash is the margin. Another choice is sent to the review as chosen, so the service names its own refusal. */}
        <SegmentedControl
          aria-label={t('Margin from')}
          size={28}
          value={collateral}
          onValueChange={(v) => {
            setCollateral(v as CollateralChoice);
            touch();
          }}
          items={COLLATERAL_CHOICES.map((c) => ({ value: c, label: t(`Margin from ${c}`), disabled: reduceOnly }))}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg-2">{t('Order type')}</span>
        <span className="flex items-center gap-2">
          <SegmentedControl
            aria-label={t('Order type')}
            size={32}
            value={orderType}
            onValueChange={(v) => {
              setOrderType(v as BookType);
              touch();
            }}
            items={BOOK_TYPES.map((id) => ({
              value: id,
              label: t(id === 'market' ? 'Type market' : 'Type limit'),
              disabled: !offered.includes(id),
            }))}
          />
          <Menu>
            <MenuContent align="end">
              <MenuGroup>
                <MenuLabel>{catalogue.status === 'ready' ? t('Order types off') : t('Off types loading')}</MenuLabel>
                {refusedTypes.map((entry) => (
                  <MenuItem key={entry.id} disabled>
                    <span className="flex flex-col">
                      <span>{typeName(entry.id)}</span>
                      <span className="text-2xs text-fg-3">
                        {futuresRefusal({ code: entry.code ?? 'trade.order_type_unsupported' }).body}
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuContent>
            <MenuTrigger render={<Button variant="ghost" size={32} aria-label={t('Other order types')} />}>
              {t('More types')}
              <span aria-hidden="true"> ▾</span>
            </MenuTrigger>
          </Menu>
        </span>
      </div>
      <p className={note}>{orderType === 'market' ? t('Market rule') : t('Limit rule')}</p>
      {orderType === 'limit' ? (
        <Field label={t('Limit price')} hint={t('Limit price hint')}>
          <Input
            kind="decimal"
            value={limitRaw}
            precision={fractionDigits(market.precision.price) ?? 2}
            onValueChange={(v) => {
              setLimitRaw(v);
              touch();
            }}
            trailing={asset}
          />
        </Field>
      ) : null}
      {orderType === 'limit' ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span id="ticket-correct" className="text-sm text-fg-2">
              {t('Price correction')}
            </span>
            <Switch
              checked={adjust}
              onCheckedChange={(on) => {
                setAdjust(on);
                touch();
              }}
              aria-labelledby="ticket-correct"
              aria-describedby="ticket-correct-why"
            />
          </div>
          <p id="ticket-correct-why" className={note}>
            {adjust ? t('Price correction on') : t('Price correction off')}
          </p>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2" aria-live="polite">
        <span className="text-sm text-fg-2">{t('Mark')}</span>
        <span className="flex items-center gap-2">
          <span className="if-num">{markNow === null ? '—' : price(markNow)}</span>
          <StatusChip
            kind={markNow === null && strip.status === 'ready' ? 'unknown' : undefined}
            asOf={markAsOf}
            now={now}
            staleAfterMs={STALE_AFTER_MS.strip}
            refused={strip.status === 'refused'}
            labels={{ stale: t('Stale mark'), unknown: t('No mark') }}
            reason={markNow === null ? t('No mark reason') : undefined}
            density="dense"
          />
        </span>
      </div>

      <Field label={t('Size')} hint={baseNote ?? undefined}>
        <Input
          kind="decimal"
          value={sizeRaw}
          precision={sizePlaces(market)}
          onValueChange={(v) => {
            setSizeRaw(v);
            touch();
          }}
          trailing={unit === 'base' ? market.base : t('Contracts')}
        />
      </Field>
      {contractsAllowed(market) ? (
        <SegmentedControl
          aria-label={t('Size unit')}
          size={28}
          value={unit}
          onValueChange={(v) => {
            // A converted number would need division and could round; starting empty keeps the size exact.
            setUnit(v as SizeUnit);
            setSizeRaw('');
            touch();
          }}
          items={[
            { value: 'base', label: t('Base', { asset: market.base }) },
            { value: 'contracts', label: t('Contracts') },
          ]}
        />
      ) : (
        <p className={note}>{t('Contracts off')}</p>
      )}
      <div role="group" aria-label={t('Percent of max group')} className="flex flex-wrap gap-2">
        {PERCENTS.map((pct) => (
          <Button
            key={pct}
            variant="secondary"
            size={28}
            disabled={reduceOnly || percentTo(pct) === null}
            onClick={() => {
              setSizeRaw(percentTo(pct) ?? '');
              touch();
            }}
          >
            {t('Percent of max', { pct: String(pct) })}
          </Button>
        ))}
      </div>
      <p className={note}>
        {reduceOnly
          ? t('Percent reduce')
          : (percentOff ?? (markNow === null || free === null ? t('Percent needs mark') : t('Percent is estimate')))}
      </p>

      <Field label={t('Leverage')} hint={reduceOnly ? t('Leverage reduce hint') : t('Leverage hint')}>
        <Input
          kind="decimal"
          value={leverage}
          disabled={reduceOnly}
          precision={2}
          onValueChange={(v) => {
            setLeverage(v);
            touch();
          }}
          trailing="x"
        />
      </Field>
      {presets.length > 0 ? (
        <div role="group" aria-label={t('Leverage presets')} className="flex flex-wrap gap-2">
          {presets.map((x) => (
            <Button
              key={x}
              variant="secondary"
              size={28}
              disabled={reduceOnly}
              onClick={() => {
                setLeverage(x);
                touch();
              }}
            >
              {t('Leverage preset', { x })}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span id="ticket-reduce" className="text-sm text-fg-2">
            {t('Reduce only')}
          </span>
          <Switch
            checked={reduceOnly}
            onCheckedChange={(on) => {
              setReduceOnly(on);
              // A take profit or stop loss attaches only to an order that opens or adds.
              if (on) {
                setTakeProfit('');
                setStopLoss('');
              }
              touch();
            }}
            aria-labelledby="ticket-reduce"
            aria-describedby="ticket-reduce-why"
          />
        </div>
        <p id="ticket-reduce-why" className={note}>
          {reduceOnly ? t('Reduce only on') : t('Reduce only off')}
        </p>
      </div>
      <section aria-labelledby="ticket-tpsl" className="flex flex-col gap-2">
        <h3 id="ticket-tpsl" className="text-sm text-fg-2">
          {t('Take profit stop loss')}
        </h3>
        <p className={note}>{reduceOnly ? t('Entry protection reduce') : t('Entry protection hint')}</p>
        {(['take_profit', 'stop_loss'] as const).map((leg) => {
          const value = leg === 'take_profit' ? takeProfit : stopLoss;
          const set = leg === 'take_profit' ? setTakeProfit : setStopLoss;
          const problem = legProblems[leg];
          return (
            <Field
              key={leg}
              label={t(leg === 'take_profit' ? 'Entry take profit' : 'Entry stop loss', { quote: asset })}
              hint={t(legSide(side, leg) === 'above' ? 'Entry side above' : 'Entry side below')}
              error={problem ? t(`Entry problem ${problem}`) : undefined}
            >
              <Input
                kind="decimal"
                value={value}
                disabled={reduceOnly}
                precision={fractionDigits(market.precision.price) ?? 2}
                trailing={asset}
                onValueChange={(v) => {
                  set(v);
                  // Part of the order's request, so a changed one is sent under a new id. The review stays: it does
                  // not price the protection, and a review still loading must land.
                  setNonce(newNonce());
                  if (writer.outcome && writer.outcome.kind !== 'uncertain') writer.dismiss();
                }}
              />
            </Field>
          );
        })}
      </section>

      <Button
        variant="secondary"
        fullWidth
        disabled={reviewOff !== null}
        loading={review.status === 'loading'}
        onClick={() => void runReview()}
      >
        {review.status === 'loading' ? t('Reviewing') : t('Review')}
      </Button>
      {reviewOff !== null ? <p className={note}>{offWords[reviewOff]}</p> : null}

      <h3 className="text-sm font-medium">{t('All in cost')}</h3>
      {review.status === 'loading' ? <Skeleton className="h-40 w-full" /> : null}
      {review.status === 'error' ? <StateBlock kind="error" thing={t('Preview error')} onRetry={() => void runReview()} /> : null}
      {review.status === 'refused' ? (
        <EmptyState
          variant="refused"
          size="inline"
          title={review.refusal.title}
          reason={review.refusal.body}
          code={review.refusal.code ?? undefined}
        />
      ) : null}
      {shown && review.status === 'ready' ? (
        <>
          <KeyValue density="dense" items={costItems(shown, review.at)} unknownLabel={t('Unknown figure')} now={now} />
          {shown.refusals.map((r) => {
            const words = r.field === 'collateral' ? futuresRefusal({ code: r.code }) : null;
            return (
              <p key={`${r.code}:${r.field}`} role="status" className="text-xs text-warn" data-code={r.code}>
                {words ? `${words.title}. ${words.body}` : r.message}
              </p>
            );
          })}
          {shown.split && splitShown ? (
            <section aria-label={t('Split title')} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <h4 className="text-sm font-medium">{t('Split title')}</h4>
              <p className={note}>
                {t('Split body', {
                  max: money(shown.maxOrderNotional ?? null) ?? '—',
                  parts: String(shown.split.parts),
                  sizes: shown.split.sizes.map((x) => `${fmtAmount(x)} ${market.base}`).join(', '),
                })}
              </p>
              <Button
                variant="secondary"
                size={32}
                disabled={splitOff !== null}
                onClick={() => setConfirm({ data: shown, changed: false, checking: false, split: true, tierAccepted: false })}
              >
                {t('Split button', { parts: String(shown.split.parts) })}
              </Button>
              {splitOff !== null ? <p className={note}>{offWords[splitOff]}</p> : null}
            </section>
          ) : null}
        </>
      ) : !reduceOnly && (review.status === 'idle' || (review.status === 'ready' && !shown)) ? (
        <p className={note}>{t('Review to see cost')}</p>
      ) : null}

      <Button
        variant={side === 'long' ? 'buy' : 'sell'}
        fullWidth
        disabled={reduceOnly ? reduceOff !== null || writer.busy : openOff !== null}
        loading={writer.busy}
        onClick={() =>
          reduceOnly
            ? setReduceConfirm(true)
            : shown && setConfirm({ data: shown, changed: false, checking: false, split: false, tierAccepted: false })
        }
      >
        {reduceOnly ? (side === 'long' ? t('Reduce buy') : t('Reduce sell')) : side === 'long' ? t('Open long') : t('Open short')}
      </Button>
      {actionWhy !== null ? <p className={note}>{actionWhy}</p> : null}

      {protectedOpen ? (
        <p role="status" className={note}>
          {t('Entry protection placed', {
            takeProfit: price(protectedOpen.takeProfit) ?? t('Entry protection none'),
            stopLoss: price(protectedOpen.stopLoss) ?? t('Entry protection none'),
          })}
        </p>
      ) : null}
      <Outcome
        writer={writer}
        onCheck={(p, resend) => void writer.check(p, { resend }).then(finish)}
        onAgain={() => {
          writer.dismiss();
          touch();
        }}
      />

      <AlertDialog open={reduceConfirm} onOpenChange={(open) => !open && setReduceConfirm(false)}>
        {reduceConfirm ? (
          <AlertDialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {side === 'long' ? t('Confirm reduce buy', { symbol: market.symbol }) : t('Confirm reduce sell', { symbol: market.symbol })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {side === 'long' ? t('Confirm reduce body buy') : t('Confirm reduce body sell')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <KeyValue
              density="dense"
              unknownLabel={t('Unknown figure')}
              items={[
                { label: t('Direction'), value: side === 'long' ? t('Reduce direction buy') : t('Reduce direction sell') },
                { label: t('Size row'), value: size === null ? null : `${fmtAmount(size)} ${market.base}` },
                {
                  label: t('Order type'),
                  value: orderType === 'market' ? t('Type market') : t('Limit at', { price: price(limitPrice) ?? '—' }),
                },
                { label: t('Reduce only'), value: t('Reduce only yes') },
                { label: t('Mark price'), value: price(markNow) },
              ]}
            />
            <AlertDialogFooter>
              <Button variant="secondary" onClick={() => setReduceConfirm(false)}>
                {t('Cancel')}
              </Button>
              <Button variant={side === 'long' ? 'buy' : 'sell'} disabled={reduceOff !== null} onClick={() => void confirmReduce()}>
                {side === 'long' ? t('Confirm reduce buy button') : t('Confirm reduce sell button')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !confirm?.checking && setConfirm(null)}>
        {confirm ? (
          // A long review (the cost rows, a split, a new margin tier) scrolls inside the dialog on a short screen.
          <AlertDialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {side === 'long' ? t('Confirm title long', { symbol: market.symbol }) : t('Confirm title short', { symbol: market.symbol })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.changed
                  ? t('Confirm changed')
                  : allInCost(confirm.data, free).totalToCommit === null
                    ? t('Confirm body unknown')
                    : t('Confirm body', { total: fmtAmount(allInCost(confirm.data, free).totalToCommit), asset })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {confirm.data.riskTier?.confirmRequired ? (
              <TierConfirm
                tier={confirm.data.riskTier}
                leverage={form?.leverage ?? null}
                cap={confirm.data.leverageCap}
                accepted={confirm.tierAccepted}
                disabled={confirm.checking}
                onAccept={(accepted) => setConfirm({ ...confirm, tierAccepted: accepted })}
              />
            ) : null}
            <KeyValue
              density="dense"
              unknownLabel={t('Unknown figure')}
              items={[
                { label: t('Direction'), value: sideWord },
                { label: t('Size row'), value: form ? `${fmtAmount(form.size)} ${market.base}` : null },
                ...(confirm.split && confirm.data.split
                  ? [{ label: t('Split row'), value: t('Split as', { parts: String(confirm.data.split.parts) }) }]
                  : []),
                { label: t('Leverage row'), value: form ? `${fmtAmount(form.leverage)}x` : null },
                {
                  label: t('Order type'),
                  value: orderType === 'market' ? t('Type market') : t('Limit at', { price: price(limitPrice) ?? '—' }),
                },
                ...(!confirm.split && protecting
                  ? [
                      { label: t('Take profit row'), value: price(takeProfit.trim() || null) ?? t('Entry protection none') },
                      { label: t('Stop loss row'), value: price(stopLoss.trim() || null) ?? t('Entry protection none') },
                    ]
                  : []),
                ...costItems(confirm.data, null),
              ]}
            />
            <AlertDialogFooter>
              <Button variant="secondary" disabled={confirm.checking} onClick={() => setConfirm(null)}>
                {t('Cancel')}
              </Button>
              <Button
                variant={side === 'long' ? 'buy' : 'sell'}
                loading={confirm.checking}
                disabled={
                  (confirm.split ? gate(splitPreview(confirm.data)) : gate(confirm.data)) !== null ||
                  (tierToConfirm(confirm.data) !== null && !confirm.tierAccepted)
                }
                onClick={() => void confirmOpen()}
              >
                {confirm.checking ? t('Checking') : side === 'long' ? t('Confirm open long') : t('Confirm open short')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </section>
  );
}

type RiskTier = NonNullable<PositionPreview['riskTier']>;

/**
 * The confirm step before an order moves the position into a higher margin tier (D-orders-10): the tier, its
 * maintenance rate and the leverage that applies, and a tick the trader must give before the order can be sent.
 */
function TierConfirm(props: {
  tier: RiskTier;
  leverage: string | null;
  cap: string | null;
  accepted: boolean;
  disabled: boolean;
  onAccept(accepted: boolean): void;
}) {
  const { t } = ticketCopy.useCopy();
  const { tier } = props;
  const tierWord = String(tier.projected);
  return (
    <section aria-label={t('Tier confirm title')} className="mb-4 flex flex-col gap-2 rounded-lg border border-warn p-3">
      <h4 className="text-sm font-medium">{t('Tier confirm heading', { tier: tierWord })}</h4>
      <p className="text-xs text-fg-2">
        {tier.current === null
          ? t('Tier confirm opens', { tier: tierWord })
          : t('Tier confirm moves', { from: String(tier.current), tier: tierWord })}{' '}
        {t('Tier confirm rate', { tier: tierWord, rate: fmtPct(tier.maintenanceRate, { signed: false }) })}
      </p>
      <p className="text-xs text-fg-2">
        {props.cap === null
          ? t('Tier confirm leverage no cap', { leverage: props.leverage ? `${fmtAmount(props.leverage)}x` : '—' })
          : t('Tier confirm leverage', {
              leverage: props.leverage ? `${fmtAmount(props.leverage)}x` : '—',
              cap: `${fmtAmount(props.cap)}x`,
            })}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={props.accepted} disabled={props.disabled} onCheckedChange={(v) => props.onAccept(v === true)} />
        <span>{t('Tier confirm accept', { tier: tierWord })}</span>
      </label>
    </section>
  );
}

/** What the last write did, in place. An unconfirmed request keeps the ticket locked until "Check status" gets an answer. */
function Outcome({ writer, onCheck, onAgain }: { writer: Writer; onCheck(pending: Pending, resend?: boolean): void; onAgain(): void }) {
  const { t } = ticketCopy.useCopy();
  const { outcome, note: held } = writer;
  if (held.state === 'unreadable')
    return <EmptyState variant="refused" size="inline" title={t('Unknown title')} reason={t('Unreadable body')} />;
  if (held.state === 'pending' || outcome?.kind === 'uncertain') {
    const pending = held.state === 'pending' ? held.pending : null;
    return (
      <div role="status" className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <h3 className="text-sm font-medium">{t('Unknown title')}</h3>
        <p className={note}>{t('Unknown body')}</p>
        <p className="if-mono break-all text-xs text-fg-2">
          {t('Unknown id', { id: pending?.id ?? (outcome?.kind === 'uncertain' ? outcome.id : '—') })}
        </p>
        {pending ? (
          <Button variant="secondary" size={32} loading={writer.busy} onClick={() => onCheck(pending)}>
            {t('Check status')}
          </Button>
        ) : null}
        {pending && outcome?.kind === 'uncertain' && outcome.notFound ? (
          <>
            <p className={note}>{outcome.found ? t('Split partly found', { count: String(outcome.found.length) }) : t('Not found body')}</p>
            <Button variant="secondary" size={32} loading={writer.busy} onClick={() => onCheck(pending, true)}>
              {t('Send same request again')}
            </Button>
          </>
        ) : null}
        {outcome?.kind === 'blocked' ? <p className="text-xs text-warn">{t(`Blocked ${outcome.reason}`)}</p> : null}
      </div>
    );
  }
  if (outcome?.kind === 'done') {
    const order = outcome.order;
    const status = outcome.position ? stateOf(outcome.position) : 'unknown';
    const word = status === 'unknown' ? t('Status unknown') : status;
    // What the book did: filled (a position is open), resting (a limit waits on the book), or partly filled.
    const resting = order?.status === 'open';
    const partly = order !== undefined && order.status === 'cancelled' && isPositive(order.filledQty);
    if (outcome.orders && (outcome.orders.length > 1 || outcome.stopped)) {
      const stopped = outcome.stopped ? futuresRefusal({ code: outcome.stopped.code, message: outcome.stopped.message }) : null;
      return (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <h3 className="text-sm font-medium">
            {stopped
              ? t('Split stopped title', { placed: String(outcome.orders.length) })
              : t('Split placed title', { parts: String(outcome.orders.length) })}
          </h3>
          {stopped ? (
            <p className="text-xs text-warn" data-code={stopped.code ?? undefined}>
              {t('Split stopped body', { reason: `${stopped.title}. ${stopped.body}` })}
            </p>
          ) : null}
          <ul className="flex flex-col gap-1 text-sm">
            {outcome.orders.map((child) => (
              <li key={child.orderId} className="if-num">
                {child.status === 'open'
                  ? t('Split child resting', { qty: fmtAmount(child.qty), price: fmtAmount(child.limitPrice) })
                  : t('Split child filled', { filled: fmtAmount(child.filledQty), qty: fmtAmount(child.qty) })}
              </li>
            ))}
          </ul>
          <Button variant="secondary" size={32} onClick={onAgain}>
            {t('Open another')}
          </Button>
        </div>
      );
    }
    return (
      <div role="status" className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <h3 className="text-sm font-medium">{resting ? t('Resting title') : partly ? t('Partly title') : t('Opened title')}</h3>
        <p className="text-sm">
          {order
            ? resting
              ? t('Resting body', { qty: fmtAmount(order.qty), price: fmtAmount(order.limitPrice) })
              : t('Filled body', { filled: fmtAmount(order.filledQty), qty: fmtAmount(order.qty) })
            : outcome.position?.id
              ? t('Opened body', { id: outcome.position.id, status: word })
              : t('Opened no id', { status: word })}
        </p>
        <Button variant="secondary" size={32} onClick={onAgain}>
          {order?.reduceOnly ? t('Place another') : t('Open another')}
        </Button>
      </div>
    );
  }
  if (outcome?.kind === 'refused')
    return (
      <EmptyState
        variant="refused"
        size="inline"
        title={outcome.refusal.title}
        reason={outcome.refusal.body}
        code={outcome.refusal.code ?? undefined}
      />
    );
  if (outcome?.kind === 'blocked')
    return (
      <p role="status" className="text-xs text-warn">
        {t(`Blocked ${outcome.reason}`)}
      </p>
    );
  return null;
}
