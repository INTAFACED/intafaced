/**
 * The Futures ticket (TRFUT-SPEC §2.2). A position opens through an order on the futures book (futures ADR): market
 * (it fills at the best prices up to the price band's edge) or limit (it rests at the trader's price). The form is:
 * direction, order type, size, leverage, Review (the service's own preview at the mark), then Open behind a confirm
 * step that re-checks the numbers.
 * Every control that cannot work says the real reason in one line. Nothing is sent from here except through the
 * shared writer, and one intent keeps one request id until the numbers change.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Menu, Popover, PopoverContent, PopoverTrigger, Segmented, StateBlock, Switch } from '@intafaced/ui/lit';
import { Checkbox, DecimalInput, FreshnessChip, KeyValue, Sheet, Skeleton } from '@intafaced/ui/lit/templates';
import { dec, fractionDigits, isPositive, str } from '../../../data/decimal';
import { fmtAmount, fmtPct, fmtPctPoints, fmtPrice } from '../../../data/format';
import { bpsToRatio } from '../desk/form-logic';
import type { BalanceEntry } from '../../../data/derive';
import type { Loadable } from '../../../data/types';
import { ORDER_LABEL, type FuturesListing, type FuturesOrder, type OrderTypeEntry, type PositionPreview, type TickerStrip } from './api';
import { STALE_AFTER_MS, useFuturesApi, useFuturesRefresh, useOrderTypes } from './data';
import { entryLegProblem, legSide } from './protection-logic';
import { newNonce, useFuturesWriter, type Writer } from './hooks';
import { allInCost, isStale, leveragePresets, openId, reduceId, stateOf } from './model';
import { collateralRefusal, futuresRefusal, isPlaneOff, type FuturesRefusal } from './refusals';
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
import { kvRows, type KvItem } from './kv-rows';
import { RegionNote } from './notes';

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
const note = 'lt-note';
const warn = 'lt-note lt-note-warn';

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
  const [label, setLabel] = useState('');
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
  // The service's own rule for a label; checked here so a bad one is named before review, not after a refusal.
  const labelBad = label.trim() !== '' && !ORDER_LABEL.test(label.trim());
  const protectOff = legProblems.take_profit !== null || legProblems.stop_loss !== null ? ('protectionProblem' as const) : null;
  const labelOff = labelBad ? ('labelBad' as const) : null;
  const openOff = gate(shown) ?? typeOff ?? protectOff ?? labelOff;
  // Above the max-order the review names a split: it may be placed as those children when nothing else refuses.
  const splitShown = splitPreview(shown);
  const splitOff = splitShown ? (gate(splitShown) ?? typeOff ?? (protecting ? ('protectionSplit' as const) : null) ?? labelOff) : null;
  const reviewOff = reduceOnly
    ? ('reduceOnly' as const)
    : (reviewBlock({ planeOff, signedOut, markKnown: markNow !== null, markStale, size, leverage: lev }) ??
      (orderType === 'limit' && limitPrice === null ? 'noLimitPrice' : null));
  // A reduce-only order needs a size and its type's price; the service checks the position it lowers.
  const reduceOff =
    writer.note.state !== 'none' ? ('locked' as const) : size === null || !isPositive(size) ? ('noSize' as const) : (typeOff ?? labelOff);

  if (planeOff)
    return <RegionNote variant="unavailable" title={t('Plane off title')} reason={t('Plane off reason')} code="trade.futures_disabled" />;
  if (signedOut)
    return (
      <RegionNote
        variant="refused"
        title={t('Signed out title')}
        reason={t('Signed out body')}
        action={{ label: t('Sign in'), href: `/login?redirect=${encodeURIComponent(window.location.pathname)}` }}
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
          ...(label.trim() !== '' ? { orderLabel: label.trim() } : {}),
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
        ...(label.trim() !== '' ? { orderLabel: label.trim() } : {}),
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
  const costItems = (p: PositionPreview, at: number | null): KvItem[] => {
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
  const tierItems = (p: PositionPreview): KvItem[] => {
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
  const openInterestItems = (p: PositionPreview): KvItem[] => {
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
  const controlItems = (p: PositionPreview): KvItem[] => {
    if (p.band === undefined) return [];
    const items: KvItem[] = [
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
    Exclude<OpenBlock | ReviewBlock | typeof typeOff | 'protectionProblem' | 'protectionSplit' | 'reduceOnly' | 'labelBad', null>,
    string
  > = {
    reduceOnly: t('Off reduce review'),
    labelBad: t('Order label invalid'),
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
    <section aria-label={t('Ticket')} className="lt-stack">
      <Segmented
        label={t('Direction')}
        value={side}
        onChange={(v: Side) => {
          setSide(v);
          touch();
        }}
        // Reduce-only names what the order does, since a buy lowers a short and a sell lowers a long.
        options={[
          { value: 'long', label: reduceOnly ? t('Reduce direction buy') : t('Long') },
          { value: 'short', label: reduceOnly ? t('Reduce direction sell') : t('Short') },
        ]}
      />

      <div className="lt-row lt-row-between">
        <span className="lt-quiet">{t('Margin mode')}</span>
        <span className="lt-row">
          <Segmented
            label={t('Margin mode')}
            value="isolated"
            onChange={(v) =>
              // Only isolated is live. Choosing another mode changes nothing and sends nothing: it names the rule.
              setModeAsked(v === 'cross' ? 'trade.cross_margin_unsupported' : v === 'portfolio' ? 'trade.portfolio_margin_unset' : null)
            }
            options={[
              { value: 'isolated', label: t('Isolated') },
              { value: 'cross', label: t('Cross') },
              { value: 'portfolio', label: t('Portfolio') },
            ]}
          />
          <Popover>
            <PopoverTrigger render={<Button tone="quiet" size="sm" />}>{t('Why only isolated')}</PopoverTrigger>
            <PopoverContent>
              <p className="lt-note">{t('Isolated rule')}</p>
            </PopoverContent>
          </Popover>
        </span>
      </div>
      {modeAsked ? (
        <p role="status" className={warn} data-code={modeAsked}>
          {futuresRefusal({ code: modeAsked }).title}. {futuresRefusal({ code: modeAsked }).body}
        </p>
      ) : null}

      <div className="lt-row lt-row-between">
        <span className="lt-quiet">{t('Margin from')}</span>
        {/* Cash is the margin. Another choice is sent to the review as chosen, so the service names its own refusal. */}
        <Segmented
          label={t('Margin from')}
          value={collateral}
          onChange={(v: CollateralChoice) => {
            setCollateral(v);
            touch();
          }}
          options={COLLATERAL_CHOICES.map((c) => ({ value: c, label: t(`Margin from ${c}`), disabled: reduceOnly }))}
        />
      </div>

      <div className="lt-row lt-row-between">
        <span className="lt-quiet">{t('Order type')}</span>
        <span className="lt-row">
          <Segmented
            label={t('Order type')}
            value={orderType}
            onChange={(v: BookType) => {
              setOrderType(v);
              touch();
            }}
            options={BOOK_TYPES.map((id) => ({
              value: id,
              label: t(id === 'market' ? 'Type market' : 'Type limit'),
              disabled: !offered.includes(id),
            }))}
          />
          <Menu
            size="sm"
            triggerLabel={t('Other order types')}
            label={
              <>
                {t('More types')}
                <span aria-hidden="true"> ▾</span>
              </>
            }
            note={catalogue.status === 'ready' ? t('Order types off') : t('Off types loading')}
            items={refusedTypes.map((entry) => ({
              key: entry.id,
              disabled: true,
              onSelect: () => undefined,
              label: (
                <span className="lt-stack-tight lt-tight">
                  <span>{typeName(entry.id)}</span>
                  <span className="lt-note">{futuresRefusal({ code: entry.code ?? 'trade.order_type_unsupported' }).body}</span>
                </span>
              ),
            }))}
          />
        </span>
      </div>
      <p className={note}>{orderType === 'market' ? t('Market rule') : t('Limit rule')}</p>
      {orderType === 'limit' ? (
        <DecimalInput
          label={t('Limit price')}
          hint={t('Limit price hint')}
          value={limitRaw}
          precision={fractionDigits(market.precision.price) ?? 2}
          onValueChange={(v) => {
            setLimitRaw(v);
            touch();
          }}
          unit={asset}
        />
      ) : null}
      {orderType === 'limit' ? (
        <div className="lt-stack-tight lt-tight">
          <div className="lt-row lt-row-between">
            <span id="ticket-correct" className="lt-quiet">
              {t('Price correction')}
            </span>
            <Switch
              label={t('Price correction')}
              checked={adjust}
              onChange={(on) => {
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

      <div className="lt-row lt-row-between" aria-live="polite">
        <span className="lt-quiet">{t('Mark')}</span>
        <span className="lt-row">
          <span className="lt-num">{markNow === null ? '—' : price(markNow)}</span>
          <FreshnessChip
            kind={markNow === null && strip.status === 'ready' ? 'unknown' : undefined}
            asOf={markAsOf}
            now={now}
            staleAfterMs={STALE_AFTER_MS.strip}
            refused={strip.status === 'refused'}
            labels={{ stale: t('Stale mark'), unknown: t('No mark') }}
            reason={markNow === null ? t('No mark reason') : undefined}
          />
        </span>
      </div>

      <DecimalInput
        label={t('Size')}
        hint={baseNote ?? undefined}
        value={sizeRaw}
        precision={sizePlaces(market)}
        onValueChange={(v) => {
          setSizeRaw(v);
          touch();
        }}
        unit={unit === 'base' ? market.base : t('Contracts')}
      />
      {contractsAllowed(market) ? (
        <Segmented
          label={t('Size unit')}
          value={unit}
          onChange={(v: SizeUnit) => {
            // A converted number would need division and could round; starting empty keeps the size exact.
            setUnit(v);
            setSizeRaw('');
            touch();
          }}
          options={[
            { value: 'base', label: t('Base', { asset: market.base }) },
            { value: 'contracts', label: t('Contracts') },
          ]}
        />
      ) : (
        <p className={note}>{t('Contracts off')}</p>
      )}
      <div role="group" aria-label={t('Percent of max group')} className="lt-row">
        {PERCENTS.map((pct) => (
          <Button
            key={pct}
            tone="secondary"
            size="sm"
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

      <DecimalInput
        label={t('Leverage')}
        hint={reduceOnly ? t('Leverage reduce hint') : t('Leverage hint')}
        value={leverage}
        disabled={reduceOnly}
        precision={2}
        onValueChange={(v) => {
          setLeverage(v);
          touch();
        }}
        unit="x"
      />
      {presets.length > 0 ? (
        <div role="group" aria-label={t('Leverage presets')} className="lt-row">
          {presets.map((x) => (
            <Button
              key={x}
              tone="secondary"
              size="sm"
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

      <div className="lt-stack-tight lt-tight">
        <div className="lt-row lt-row-between">
          <span id="ticket-reduce" className="lt-quiet">
            {t('Reduce only')}
          </span>
          <Switch
            label={t('Reduce only')}
            checked={reduceOnly}
            onChange={(on) => {
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
      <section aria-labelledby="ticket-tpsl" className="lt-stack-tight">
        <h3 id="ticket-tpsl" className="lt-quiet">
          {t('Take profit stop loss')}
        </h3>
        <p className={note}>{reduceOnly ? t('Entry protection reduce') : t('Entry protection hint')}</p>
        {(['take_profit', 'stop_loss'] as const).map((leg) => {
          const value = leg === 'take_profit' ? takeProfit : stopLoss;
          const set = leg === 'take_profit' ? setTakeProfit : setStopLoss;
          const problem = legProblems[leg];
          return (
            <DecimalInput
              key={leg}
              label={t(leg === 'take_profit' ? 'Entry take profit' : 'Entry stop loss', { quote: asset })}
              hint={t(legSide(side, leg) === 'above' ? 'Entry side above' : 'Entry side below')}
              error={problem ? t(`Entry problem ${problem}`) : undefined}
              value={value}
              disabled={reduceOnly}
              precision={fractionDigits(market.precision.price) ?? 2}
              unit={asset}
              onValueChange={(v) => {
                set(v);
                // Part of the order's request, so a changed one is sent under a new id. The review stays: it does
                // not price the protection, and a review still loading must land.
                setNonce(newNonce());
                if (writer.outcome && writer.outcome.kind !== 'uncertain') writer.dismiss();
              }}
            />
          );
        })}
      </section>

      <Field
        label={t('Order label')}
        hint={t('Order label hint')}
        error={labelBad ? t('Order label invalid') : undefined}
        value={label}
        maxLength={36}
        onChange={(e) => {
          setLabel(e.currentTarget.value);
          // Part of the order's request, so a changed label is sent under a new id.
          setNonce(newNonce());
          if (writer.outcome && writer.outcome.kind !== 'uncertain') writer.dismiss();
        }}
      />

      <Button tone="secondary" block disabled={reviewOff !== null} busy={review.status === 'loading'} onClick={() => void runReview()}>
        {review.status === 'loading' ? t('Reviewing') : t('Review')}
      </Button>
      {reviewOff !== null ? <p className={note}>{offWords[reviewOff]}</p> : null}

      <h3 className="lt-strong">{t('All in cost')}</h3>
      {review.status === 'loading' ? <Skeleton shape="keys" /> : null}
      {review.status === 'error' ? <StateBlock kind="error" thing={t('Preview error')} onRetry={() => void runReview()} /> : null}
      {review.status === 'refused' ? (
        <RegionNote variant="refused" title={review.refusal.title} reason={review.refusal.body} code={review.refusal.code ?? undefined} />
      ) : null}
      {shown && review.status === 'ready' ? (
        <>
          <KeyValue rows={kvRows(costItems(shown, review.at), t('Unknown figure'), { now })} />
          {shown.refusals.map((r) => {
            const words = r.field === 'collateral' ? collateralRefusal(r.venue) : null;
            return (
              <p key={`${r.code}:${r.field}`} role="status" className={warn} data-code={r.code}>
                {words ? `${words.title}. ${words.body}` : r.message}
              </p>
            );
          })}
          {shown.split && splitShown ? (
            <section aria-label={t('Split title')} className="lt-callout">
              <h4 className="lt-strong">{t('Split title')}</h4>
              <p className={note}>
                {t('Split body', {
                  max: money(shown.maxOrderNotional ?? null) ?? '—',
                  parts: String(shown.split.parts),
                  sizes: shown.split.sizes.map((x) => `${fmtAmount(x)} ${market.base}`).join(', '),
                })}
              </p>
              <Button
                tone="secondary"
                size="sm"
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
        tone={side === 'long' ? 'up' : 'down'}
        block
        disabled={reduceOnly ? reduceOff !== null || writer.busy : openOff !== null}
        busy={writer.busy}
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

      {reduceConfirm ? (
        <Sheet
          open
          role="alertdialog"
          title={side === 'long' ? t('Confirm reduce buy', { symbol: market.symbol }) : t('Confirm reduce sell', { symbol: market.symbol })}
          description={side === 'long' ? t('Confirm reduce body buy') : t('Confirm reduce body sell')}
          onClose={() => setReduceConfirm(false)}
          footer={
            <>
              <Button tone="secondary" onClick={() => setReduceConfirm(false)}>
                {t('Cancel')}
              </Button>
              <Button tone={side === 'long' ? 'up' : 'down'} disabled={reduceOff !== null} onClick={() => void confirmReduce()}>
                {side === 'long' ? t('Confirm reduce buy button') : t('Confirm reduce sell button')}
              </Button>
            </>
          }
        >
          <KeyValue
            rows={kvRows(
              [
                { label: t('Direction'), value: side === 'long' ? t('Reduce direction buy') : t('Reduce direction sell') },
                { label: t('Size row'), value: size === null ? null : `${fmtAmount(size)} ${market.base}` },
                {
                  label: t('Order type'),
                  value: orderType === 'market' ? t('Type market') : t('Limit at', { price: price(limitPrice) ?? '—' }),
                },
                { label: t('Reduce only'), value: t('Reduce only yes') },
                { label: t('Mark price'), value: price(markNow) },
              ],
              t('Unknown figure'),
            )}
          />
        </Sheet>
      ) : null}

      {confirm ? (
        // A long review (the cost rows, a split, a new margin tier) scrolls inside the sheet on a short screen.
        <Sheet
          open
          role="alertdialog"
          title={side === 'long' ? t('Confirm title long', { symbol: market.symbol }) : t('Confirm title short', { symbol: market.symbol })}
          description={
            confirm.changed
              ? t('Confirm changed')
              : allInCost(confirm.data, free).totalToCommit === null
                ? t('Confirm body unknown')
                : t('Confirm body', { total: fmtAmount(allInCost(confirm.data, free).totalToCommit), asset })
          }
          onClose={() => {
            if (!confirm.checking) setConfirm(null);
          }}
          footer={
            <>
              <Button tone="secondary" disabled={confirm.checking} onClick={() => setConfirm(null)}>
                {t('Cancel')}
              </Button>
              <Button
                tone={side === 'long' ? 'up' : 'down'}
                busy={confirm.checking}
                disabled={
                  (confirm.split ? gate(splitPreview(confirm.data)) : gate(confirm.data)) !== null ||
                  (tierToConfirm(confirm.data) !== null && !confirm.tierAccepted)
                }
                onClick={() => void confirmOpen()}
              >
                {confirm.checking ? t('Checking') : side === 'long' ? t('Confirm open long') : t('Confirm open short')}
              </Button>
            </>
          }
        >
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
            rows={kvRows(
              [
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
              ],
              t('Unknown figure'),
            )}
          />
        </Sheet>
      ) : null}
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
    <section aria-label={t('Tier confirm title')} className="lt-callout lt-callout-warn">
      <h4 className="lt-strong">{t('Tier confirm heading', { tier: tierWord })}</h4>
      <p className="lt-note">
        {tier.current === null
          ? t('Tier confirm opens', { tier: tierWord })
          : t('Tier confirm moves', { from: String(tier.current), tier: tierWord })}{' '}
        {t('Tier confirm rate', { tier: tierWord, rate: fmtPct(tier.maintenanceRate, { signed: false }) })}
      </p>
      <p className="lt-note">
        {props.cap === null
          ? t('Tier confirm leverage no cap', { leverage: props.leverage ? `${fmtAmount(props.leverage)}x` : '—' })
          : t('Tier confirm leverage', {
              leverage: props.leverage ? `${fmtAmount(props.leverage)}x` : '—',
              cap: `${fmtAmount(props.cap)}x`,
            })}
      </p>
      <Checkbox
        label={t('Tier confirm accept', { tier: tierWord })}
        checked={props.accepted}
        disabled={props.disabled}
        onChange={(e) => props.onAccept(e.currentTarget.checked)}
      />
    </section>
  );
}

/** What the last write did, in place. An unconfirmed request keeps the ticket locked until "Check status" gets an answer. */
function Outcome({ writer, onCheck, onAgain }: { writer: Writer; onCheck(pending: Pending, resend?: boolean): void; onAgain(): void }) {
  const { t } = ticketCopy.useCopy();
  const { outcome, note: held } = writer;
  if (held.state === 'unreadable') return <RegionNote variant="refused" title={t('Unknown title')} reason={t('Unreadable body')} />;
  if (held.state === 'pending' || outcome?.kind === 'uncertain') {
    const pending = held.state === 'pending' ? held.pending : null;
    return (
      <div role="status" className="lt-callout">
        <h3 className="lt-strong">{t('Unknown title')}</h3>
        <p className={note}>{t('Unknown body')}</p>
        <p className="lt-note lt-mono">{t('Unknown id', { id: pending?.id ?? (outcome?.kind === 'uncertain' ? outcome.id : '—') })}</p>
        {pending ? (
          <Button tone="secondary" size="sm" busy={writer.busy} onClick={() => onCheck(pending)}>
            {t('Check status')}
          </Button>
        ) : null}
        {pending && outcome?.kind === 'uncertain' && outcome.notFound ? (
          <>
            <p className={note}>{outcome.found ? t('Split partly found', { count: String(outcome.found.length) }) : t('Not found body')}</p>
            <Button tone="secondary" size="sm" busy={writer.busy} onClick={() => onCheck(pending, true)}>
              {t('Send same request again')}
            </Button>
          </>
        ) : null}
        {outcome?.kind === 'blocked' ? <p className={warn}>{t(`Blocked ${outcome.reason}`)}</p> : null}
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
        <div role="status" className="lt-callout">
          <h3 className="lt-strong">
            {stopped
              ? t('Split stopped title', { placed: String(outcome.orders.length) })
              : t('Split placed title', { parts: String(outcome.orders.length) })}
          </h3>
          {stopped ? (
            <p className={warn} data-code={stopped.code ?? undefined}>
              {t('Split stopped body', { reason: `${stopped.title}. ${stopped.body}` })}
            </p>
          ) : null}
          <ul className="lt-list">
            {outcome.orders.map((child) => (
              <li key={child.orderId} className="lt-num">
                {child.status === 'open'
                  ? t('Split child resting', { qty: fmtAmount(child.qty), price: fmtAmount(child.limitPrice) })
                  : t('Split child filled', { filled: fmtAmount(child.filledQty), qty: fmtAmount(child.qty) })}
              </li>
            ))}
          </ul>
          <Button tone="secondary" size="sm" onClick={onAgain}>
            {t('Open another')}
          </Button>
        </div>
      );
    }
    return (
      <div role="status" className="lt-callout">
        <h3 className="lt-strong">{resting ? t('Resting title') : partly ? t('Partly title') : t('Opened title')}</h3>
        <p>
          {order
            ? resting
              ? t('Resting body', { qty: fmtAmount(order.qty), price: fmtAmount(order.limitPrice) })
              : t('Filled body', { filled: fmtAmount(order.filledQty), qty: fmtAmount(order.qty) })
            : outcome.position?.id
              ? t('Opened body', { id: outcome.position.id, status: word })
              : t('Opened no id', { status: word })}
        </p>
        <Button tone="secondary" size="sm" onClick={onAgain}>
          {order?.reduceOnly ? t('Place another') : t('Open another')}
        </Button>
      </div>
    );
  }
  if (outcome?.kind === 'refused')
    return (
      <RegionNote variant="refused" title={outcome.refusal.title} reason={outcome.refusal.body} code={outcome.refusal.code ?? undefined} />
    );
  if (outcome?.kind === 'blocked')
    return (
      <p role="status" className={warn}>
        {t(`Blocked ${outcome.reason}`)}
      </p>
    );
  return null;
}
