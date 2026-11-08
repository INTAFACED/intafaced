import { useMemo, useRef, useState } from 'react';
import { Button, Tabs } from '../../../shared/ui';
import { useResource } from '../../../shared/resource';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import {
  draftId,
  keys,
  onStep,
  canonicalDecimal,
  type AsOf,
  type OrderIntent,
  type VenueMarket,
  type VenueOrder,
  type VenuePreview,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  BalancesPanel,
  FillsTable,
  OrdersTable,
  OutcomeLine,
  ReadProblem,
  VenueFrame,
  VenueHeader,
  WalletBar,
  WithdrawPanel,
  heldKeys,
  useOwner,
  useVenueAccount,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
} from '../../../features/trade/venue/VenueKit';
import { ReviewDialog } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { spotVenueCopy } from './venue-copy';

/** The desk's own symbol form ("BTC-USDC"), whichever way the address writes it. */
export const venueSymbolOf = (pair: string) => pair.replace(/[/_]/g, '-').toUpperCase();

/**
 * Which spot page shows in venue mode: today's desk only while the venue's markets are still being read or when the venue
 * does not list this pair as spot; the venue's notice when the venue is down or its market list could not be read (never
 * today's custodial desk in its place); otherwise the venue desk.
 */
export function spotGateChoice(
  available: boolean,
  markets: { status: 'loading' } | { status: 'failed' } | { status: 'ready'; listed: boolean },
): 'today' | 'down' | 'venue' {
  if (!available) return 'down';
  if (markets.status === 'loading') return 'today';
  if (markets.status === 'failed') return 'down';
  return markets.listed ? 'venue' : 'today';
}

/** The spot desk in venue mode: on when `/venue/status` says the door is on and the venue lists this pair as spot. */
export function VenueSpotGate({
  mode,
  pair,
  fallback,
}: {
  mode: Extract<VenueMode, { mode: 'on' }>;
  pair: string;
  fallback: React.ReactNode;
}) {
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const markets = useResource((signal) => venue.markets(signal), 'venue-markets');
  const symbol = venueSymbolOf(pair);
  const r = markets.resource;
  const market = r.status === 'ready' ? r.data.value.find((m) => m.kind === 'spot' && m.symbol === symbol) : undefined;
  const choice = spotGateChoice(
    mode.status.available,
    r.status === 'ready'
      ? { status: 'ready', listed: market !== undefined }
      : r.status === 'failed'
        ? { status: 'failed' }
        : { status: 'loading' },
  );
  if (choice === 'today') return <>{fallback}</>;
  if (choice === 'down' || !market || !mode.status.available) {
    return (
      <div data-testid="if-desk" className="if-desk" data-venue="on">
        {!mode.status.available ? (
          <p className="failure" role="alert" data-testid="venue-down">
            {v('Venue unavailable', { detail: mode.status.refusal.detail })}
          </p>
        ) : (
          <ReadProblem failure={r.status === 'failed' ? r.failure : null} venueName={mode.status.venue.displayName} />
        )}
      </div>
    );
  }
  return (
    <VenueFrame mode={mode}>
      <VenueSpotDesk status={mode.status} market={market} />
    </VenueFrame>
  );
}

type Side = 'buy' | 'sell';
const NOT_LIVE_TYPES = ['stop', 'stop_limit'] as const;

export function VenueSpotDesk({ status, market }: { status: VenueUp; market: VenueMarket }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const owner = useOwner();
  const venue = useVenueApi();
  const account = useVenueAccount(owner);
  const { run } = useVenueActions(owner);
  const [tab, setTab] = useState<'open' | 'history' | 'positions'>('open');
  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<'limit' | 'market'>('limit');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [tif, setTif] = useState(market.timeInForce[0] ?? 'GTC');
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<{ intent: OrderIntent; preview: AsOf<VenuePreview> } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  // The orders this page cancelled, kept by client order key only, so a repeat cancel names the same action.
  const [cancelledKeys, setCancelledKeys] = useState<Array<{ key: string; clientOrderId: string }>>([]);
  const placedKeys = useMemo(() => (owner ? heldKeys(owner) : null), [owner]);
  const counter = useRef(0);
  const sending = useRef(false);

  const fee = (m: VenueMarket['makerFeeBps']) => (m.known ? v('Fee bps', { bps: m.value }) : v('Not known'));
  const feeLine = v('Fee line', {
    symbol: market.symbol,
    maker: fee(market.makerFeeBps),
    taker: fee(market.takerFeeBps),
    builder: status.builder ? v('Fee bps', { bps: status.builder.feeBps }) : v('Builder fee blank'),
  });

  const cancelled = useCancelledOrders(owner, cancelledKeys);

  async function openReview() {
    setProblem(null);
    setResult(null);
    if (!owner) return setProblem(v('Connect first'));
    if (!amount.trim()) return setProblem(v('Enter amount'));
    if (!price.trim()) return setProblem(v('Enter price'));
    if (!onStep(amount, market.lotSize)) return setProblem(v('Not a step', { field: v('Amount'), step: market.lotSize }));
    if (!onStep(price, market.tickSize)) return setProblem(v('Not a step', { field: v('Price'), step: market.tickSize }));
    const draft = draftId(Date.now(), counter.current++);
    const intent: OrderIntent = {
      kind: 'place_order',
      symbol: market.symbol,
      side,
      type,
      amount: canonicalDecimal(amount),
      price: canonicalDecimal(price),
      timeInForce: type === 'market' ? 'IOC' : tif,
      reduceOnly: false,
      clientOrderKey: keys.order(owner, market.symbol, draft),
      builderFee: null,
    };
    const preview = await venue.preview(owner, intent);
    if (!preview.ok) return setProblem(v('Outcome refused', { detail: preview.message }));
    setReview({ intent, preview: preview.data });
  }

  async function confirm() {
    if (!review || sending.current) return;
    sending.current = true;
    const answer = await run(review.intent);
    sending.current = false;
    if (answer.kind === 'outcome' || answer.kind === 'unknown') {
      if (answer.clientOrderId) placedKeys?.set(answer.clientOrderId, review.intent.clientOrderKey);
    }
    setResult(answer);
    setLastResult(answer);
    account.reload();
    if (answer.kind === 'outcome' && answer.outcome.accepted) setTab('open');
  }

  async function cancel(order: VenueOrder) {
    if (!order.venueClientOrderId) return;
    const key = placedKeys?.get(order.venueClientOrderId) ?? cancelledKeys.find((c) => c.clientOrderId === order.venueClientOrderId)?.key;
    if (!key) return;
    const answer = await run({ kind: 'cancel_order', symbol: order.symbol, clientOrderKey: key });
    setLastResult(answer);
    if (answer.kind === 'outcome' && answer.outcome.accepted)
      setCancelledKeys((now) => (now.some((c) => c.key === key) ? now : [...now, { key, clientOrderId: order.venueClientOrderId! }]));
    account.reload();
  }

  const offeredTypes = market.orderTypes.filter((x): x is 'limit' | 'market' => x === 'limit' || x === 'market');
  return (
    <div data-testid="if-desk" className="if-desk" data-market={market.symbol} data-venue="on">
      <VenueHeader status={status} title={t('Spot on venue', { symbol: market.symbol })} feeLine={feeLine} />
      <WalletBar />
      <ReadProblem failure={account.balances.failure} venueName={status.venue.displayName} />
      {owner ? <BalancesPanel balances={account.balances.data} test={status.test} /> : <p className="muted">{v('Connect first')}</p>}
      <section className="dk-panel form-stack" aria-label={t('Order ticket')} data-testid="venue-ticket">
        <h2 className="dk-tab-title">{t('Order ticket')}</h2>
        <Tabs
          items={['buy', 'sell']}
          value={side}
          onChange={(s) => setSide(s as Side)}
          label={t('Order ticket')}
          labels={{ buy: t('Buy'), sell: t('Sell') }}
        />
        <div role="group" aria-label={t('Order type')}>
          {offeredTypes.map((x) => (
            <Button key={x} variant={type === x ? 'primary' : 'secondary'} aria-pressed={type === x} onClick={() => setType(x)}>
              {x === 'limit' ? t('Limit') : t('Market')}
            </Button>
          ))}
          {NOT_LIVE_TYPES.filter((x) => !market.orderTypes.includes(x)).map((x) => (
            <Button key={x} variant="secondary" disabled aria-disabled="true" data-not-offered={x}>
              {word(v, 'type', x)}: {v('Not offered')}
            </Button>
          ))}
        </div>
        <label className="field">
          <span>{type === 'market' ? t('Worst price') : t('Price')}</span>
          <input
            inputMode="decimal"
            aria-label={type === 'market' ? t('Worst price') : t('Price')}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('Amount', { asset: market.baseAsset })}</span>
          <input
            inputMode="decimal"
            aria-label={t('Amount', { asset: market.baseAsset })}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        {type === 'limit' ? (
          <label className="field">
            <span>{t('Time in force')}</span>
            <select value={tif} onChange={(e) => setTif(e.target.value as typeof tif)} aria-label={t('Time in force')}>
              {market.timeInForce.map((x) => (
                <option key={x} value={x}>
                  {word(v, 'tif', x)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button disabled={!owner} onClick={() => void openReview()}>
          {side === 'buy' ? t('Review buy') : t('Review sell')}
        </Button>
        {problem ? (
          <p className="failure" role="alert">
            {problem}
          </p>
        ) : null}
        <OutcomeLine result={review ? null : lastResult} owner={owner} />
      </section>
      {review && owner ? (
        <ReviewDialog
          title={v('Review side', { side: word(v, 'side', review.intent.side).toLowerCase() })}
          preview={review.preview}
          intent={review.intent}
          status={status}
          account={account}
          owner={owner}
          run={run}
          confirmLabel={v('Confirm and sign')}
          result={result}
          onConfirm={() => void confirm()}
          onClose={() => {
            setReview(null);
            setResult(null);
          }}
        />
      ) : null}
      <section className="dk-panel" data-testid="venue-bottom">
        <Tabs
          items={['open', 'history', 'positions']}
          value={tab}
          onChange={(x) => setTab(x as typeof tab)}
          label={v('Open orders')}
          labels={{ open: v('Open orders'), history: v('Trade history'), positions: v('Positions') }}
        />
        {tab === 'open' ? (
          <OrdersTable orders={account.openOrders.data} test={status.test} onCancel={(o) => void cancel(o)} cancelled={cancelled} />
        ) : tab === 'history' ? (
          <FillsTable fills={account.fills.data} test={status.test} symbol={market.symbol} />
        ) : (
          <p data-testid="venue-positions-na">{t('Positions not applicable')}</p>
        )}
      </section>
      {owner ? <WithdrawPanel owner={owner} balances={account.balances.data} test={status.test} /> : null}
    </div>
  );
}

/** The orders this page cancelled, read back from the venue by their client ids, so they stay listed with their status. */
function useCancelledOrders(owner: string | null, cancelled: Array<{ key: string; clientOrderId: string }>): VenueOrder[] {
  const venue = useVenueApi();
  const ids = cancelled.map((c) => c.clientOrderId).join(',');
  const read = useResource(async (signal) => {
    if (!owner || cancelled.length === 0) return { ok: true as const, data: [] as VenueOrder[] };
    const rows: VenueOrder[] = [];
    for (const c of cancelled) {
      const r = await venue.orderByClientId(owner, c.clientOrderId, signal);
      if (r.ok && r.data.value) rows.push(r.data.value);
    }
    return { ok: true as const, data: rows };
  }, `cancelled:${owner}:${ids}`);
  return useMemo(() => (read.resource.status === 'ready' ? read.resource.data : []), [read.resource]);
}
