import { useMemo, useRef, useState } from 'react';
import { useResource } from '../../../shared/resource';
import { usePreferences } from '../../../shared/preferences';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  draftId,
  keys,
  type OrderIntent,
  type VenueMarket,
  type VenueOrder,
  type VenueTimeInForce,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  FillsTable,
  OrdersTable,
  OutcomeLine,
  ReadProblem,
  VENUE_POLL_MS,
  VenueHeader,
  heldKeys,
  heldTags,
  useOwner,
  useVenueAccount,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
} from '../../../features/trade/venue/VenueKit';
import { SubAccountsPanel } from '../../../features/trade/venue/SubAccounts';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { venueOrdersCopy } from '../../../features/trade/orders/venue-orders-copy';
import { deskCopy } from './copy';
import { navigate, Tabs, TabsList, TabsPanel, TabsTab } from './deps';
import { useDeviceSetting } from '../../../features/trade/hooks';
import { ChartTrade, clickAmountOk, type ChartPick, type RefusedChartType } from './ChartTrade';
import { OneClickBar, type CancelOutcome } from './OneClick';
import type { LadderPick } from './OrderFlow';
import { DEFAULT_DOM, isDomSetting, type DomSetting } from './order-flow';
import { flowCopy } from './order-flow-copy';
import { useInstantPlacement } from './instant';
import { VenueOrderFlow } from './VenueOrderFlow';
import { flowMarketOf } from './venue-flow';
import { spotVenueCopy } from './venue-copy';
import { VenueMarketPanel } from './VenueMarketData';
import { VenueChartOrders } from './VenueChartOrders';
import { NotOfferedTypes, VenueSelfTradeSelect, VenueTifSelect } from './VenueOrderOptions';
import { VenueConditionalOrders } from './VenueConditionalOrders';
import { VenueMarketRules } from './VenueMarketRules';
import { VenueCancelMany, VenueEditOrder } from './VenueOrderChanges';
import { VenueDeadMan } from './VenueDeadMan';
import { VenueStatement } from './VenueStatement';
import {
  OTHER_ORDER_TYPES,
  pendingOrders,
  slippageLimit,
  type DepositRoute,
  type PendingOrder,
  type VenueOrderType,
  type VenueSide,
} from './venue-desk';
import { useTradeAccess } from './venue-access';
import { FeeCurrencyRow } from './VenueReviewRows';
import { DepositDialog, VenueAccountPanel, WithdrawalTracker, WithdrawDialog, flattenable } from './VenueAccountPanel';
import { VenueSideForm, type TicketHandle } from './VenueSideForm';
import { PendingCheck } from './VenuePending';

export function VenueSpotDesk({
  status,
  market,
  markets = [market],
}: {
  status: VenueUp;
  market: VenueMarket;
  /** The venue's listed markets: an order's own market rules when it is changed, and which orders are spot. */
  markets?: readonly VenueMarket[];
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const d = deskCopy.useCopy().t;
  const orders = venueOrdersCopy.useCopy().t;
  const owner = useOwner();
  const venue = useVenueApi();
  const account = useVenueAccount(owner);
  const { run, resend, keptSignature } = useVenueActions(owner);
  const access = useTradeAccess();
  const [type, setType] = useState<VenueOrderType>('limit');
  const [tif, setTif] = useState<VenueTimeInForce>('GTC');
  const [tab, setTab] = useState<'open' | 'history' | 'positions'>('open');
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  const [cancelledKeys, setCancelledKeys] = useState<Array<{ key: string; clientOrderId: string }>>([]);
  // Orders placed elsewhere that this page cancelled by their client id: listed as the venue reads them, Cancelled, as
  // the ones it placed are (J-cex-spot-06 #7: the same state words on the desk as in the history).
  const [cancelledElsewhere, setCancelledElsewhere] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'deposit' | 'withdraw' | null>(null);
  const [withdrawalNonce, setWithdrawalNonce] = useState<string | null>(null);
  const [editing, setEditing] = useState<VenueOrder | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Flatten (J-cex-spot-05 #8): the sell ticket is filled with all the free base as a market sell and its review opened.
  // A ladder click, a chart Buy or Sell and one-click close (J-charts-desk-14) fill a ticket the same way.
  const buyHandle = useRef<TicketHandle>(null);
  const sellHandle = useRef<TicketHandle>(null);
  const flattenHandle = sellHandle;
  const placedKeys = useMemo(() => (owner ? heldKeys(owner) : null), [owner]);
  // Orders with no definite answer yet (J-cex-spot-02 #3, #4): kept across a reload; while one is listed, no new order goes.
  const pendingStore = useMemo(() => (owner ? pendingOrders(owner) : null), [owner]);
  // Read from this tab's store when the owner's store changes (during render, so a reload shows them at once).
  const [pendingOf, setPendingOf] = useState(() => ({ store: pendingStore, list: pendingStore?.list() ?? [] }));
  if (pendingOf.store !== pendingStore) setPendingOf({ store: pendingStore, list: pendingStore?.list() ?? [] });
  const pending = pendingOf.store === pendingStore ? pendingOf.list : (pendingStore?.list() ?? []);
  const setPending = (list: PendingOrder[]) => setPendingOf({ store: pendingStore, list });
  const [found, setFound] = useState<string | null>(null);
  // The keys of orders the venue has since named: each side's ticket lets go of a key it still holds for one.
  const [settledKeys, setSettledKeys] = useState<string[]>([]);
  const tags = useMemo(() => (owner ? heldTags(owner) : null), [owner]);
  const tagOf = (clientOrderId: string) => tags?.get(clientOrderId);
  const best = usePolled((signal) => venue.bestPrices(market.symbol, signal), `best:${market.symbol}`, VENUE_POLL_MS);
  const cancelled = useCancelledOrders(owner, [
    ...cancelledKeys,
    ...cancelledElsewhere.map((clientOrderId) => ({ key: '', clientOrderId })),
  ]);
  // The orders behind the venue's own fills on this market (newest last), and any this page placed: the filled ones
  // stay listed, Filled, read from the venue by client id.
  const filledIds = [
    ...new Set([
      ...(account.fills.data?.value ?? [])
        .filter((f) => f.symbol === market.symbol && f.venueClientOrderId)
        .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt))
        .map((f) => f.venueClientOrderId!),
      ...(placedKeys?.ids() ?? []),
    ]),
  ];
  const filled = useFilledOrders(owner, filledIds, account.openOrders.data?.value ?? null, cancelledKeys);
  // The owner's market price protection, as svc-trade answers it with the venue's best prices; blank refuses a market order.
  const cap = best.data?.slippageCapBps ?? null;
  // A market order needs both owner values: the price protection and the spread limit. Either blank: "protection not set".
  const spreadSet = best.data?.spreadLimitBps?.known === true;
  const capSet = cap?.known === true && spreadSet;

  const offeredTypes = market.orderTypes.filter((x): x is VenueOrderType => x === 'limit' || x === 'market');
  const fee = (m: VenueMarket['makerFeeBps']) => (m.known ? v('Fee bps', { bps: m.value }) : v('Not known'));
  const feeLine = v('Fee line spot', {
    symbol: market.symbol,
    maker: fee(market.makerFeeBps),
    taker: fee(market.takerFeeBps),
    builder: status.builder ? v('Fee bps', { bps: status.builder.feeBps }) : v('Builder fee blank spot'),
  });

  async function cancel(order: VenueOrder): Promise<CancelOutcome> {
    if (!order.venueClientOrderId) return 'refused';
    const key = placedKeys?.get(order.venueClientOrderId) ?? cancelledKeys.find((c) => c.clientOrderId === order.venueClientOrderId)?.key;
    if (!key) {
      // An order this page did not place (another tab or device): named by the venue's client id, where the venue
      // cancels by it in a signed action.
      if (!owner || (status.cancelsPerAction ?? 0) < 1) return 'refused';
      const id = order.venueClientOrderId;
      const batch = await run(
        { kind: 'cancel_orders', orders: [{ symbol: order.symbol, venueClientOrderId: id }] },
        { actionKey: keys.cancelBatch(owner, `one-${draftId()}`) },
      );
      setLastResult(batch);
      if (batch.kind === 'outcome' && batch.outcome.accepted) setCancelledElsewhere((now) => (now.includes(id) ? now : [...now, id]));
      account.reload();
      return cancelOutcome(batch);
    }
    const answer = await run({ kind: 'cancel_order', symbol: order.symbol, clientOrderKey: key });
    setLastResult(answer);
    if (answer.kind === 'outcome' && answer.outcome.accepted)
      setCancelledKeys((now) => (now.some((c) => c.key === key) ? now : [...now, { key, clientOrderId: order.venueClientOrderId! }]));
    account.reload();
    return cancelOutcome(answer);
  }

  // The DOM (J-charts-desk-14), bound to this desk's market: open or not and its ladder and tape settings are kept per
  // device, as on today's desk; the symbol is never kept, so another market re-binds it with the same settings.
  const { timeZone, quickSizes } = usePreferences();
  const [dom, setDom] = useDeviceSetting<DomSetting>('trade-desk-dom', DEFAULT_DOM, isDomSetting);
  const toggleDom = () => setDom((now) => ({ ...now, open: !now.open }));
  const closeDom = () => setDom((now) => ({ ...now, open: false }));
  // Instant placement: the account's own `trade.instant`, as on today's desk. Off, every click opens the venue review.
  const instant = useInstantPlacement();
  // The amount a ladder click or a chart Buy or Sell puts on the ticket.
  const [clickAmount, setClickAmount] = useState('');
  const flowMarket = useMemo(() => flowMarketOf(market), [market]);
  const bestBid = best.data?.value.bid ?? null;
  const bestAsk = best.data?.value.ask ?? null;
  const reference = useMemo(() => (best.data ? { bestBid, bestAsk } : null), [best.data !== null, bestBid, bestAsk]); // eslint-disable-line react-hooks/exhaustive-deps -- a new read with the same prices keeps the same reference, so the chart group does not redraw
  /**
   * A draft from the DOM or the chart on one side's ticket: a limit at its price or a market order at the protection's
   * worst price. It opens the venue review unless instant placement is on and it is a limit; a market order always reviews.
   */
  const pick = (side: VenueSide, kind: VenueOrderType, price: string, amount: string) => {
    if (!offeredTypes.includes(kind)) return;
    setType(kind);
    const worstNow = kind === 'market' && cap?.known ? slippageLimit(side, best.data?.value ?? null, cap.value, market.tickSize) : null;
    (side === 'buy' ? buyHandle : sellHandle).current?.pick({
      type: kind,
      price: kind === 'limit' ? price : '',
      amount,
      worst: worstNow,
      instant: instant.on && kind === 'limit',
    });
  };
  const onLadderPick = (p: LadderPick) =>
    pick(p.side, 'limit', p.price, clickAmountOk(clickAmount, market.lotSize) ? clickAmount.trim() : '');
  const onChartTrade = (p: ChartPick) => pick(p.side, p.type, p.price, p.amount);
  // An order placed on the chart itself (J-charts-desk-15): its key kept as the ticket's are, so the desk's Cancel names it.
  const chartPlaced = (intent: OrderIntent, answer: ActionResult) => {
    if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId)
      placedKeys?.set(answer.clientOrderId, intent.clientOrderKey);
    account.reload();
  };
  // One-click close: every free lot of the base sold as a limit at the venue's best bid, the price the button shows.
  const freeBase = account.balances.data?.value.find((b) => b.asset === market.baseAsset)?.free ?? null;
  const closable = freeBase === null ? null : (flattenable(freeBase, market.lotSize) ?? '');
  const notOffered: RefusedChartType[] = OTHER_ORDER_TYPES.filter((x) => !market.orderTypes.includes(x)).map((x) => ({
    id: x,
    label: word(v, 'type', x),
    reason: `${word(v, 'type', x)}: ${v('Not offered')}`,
    code: 'trade.venue.not_offered',
  }));
  const f = flowCopy.useCopy().t;
  const spotMarkets = markets.filter((m) => m.kind === 'spot');

  const placed = (intent: OrderIntent, answer: ActionResult, tag: string) => {
    if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId) {
      placedKeys?.set(answer.clientOrderId, intent.clientOrderKey);
      if (tag) tags?.set(answer.clientOrderId, tag);
    }
    if (answer.kind === 'unknown' && answer.clientOrderId && pendingStore) {
      // No definite answer: the order is looked up on the venue by its client id, and nothing new is sent meanwhile.
      const signature = keptSignature(intent.clientOrderKey) ?? pendingStore.list().find((p) => p.key === intent.clientOrderKey)?.signature;
      pendingStore.add({ clientOrderId: answer.clientOrderId, key: intent.clientOrderKey, intent, ...(signature ? { signature } : {}) });
      setPending(pendingStore.list());
      setFound(null);
    } else {
      const answeredId = answer.kind === 'outcome' ? answer.clientOrderId : null;
      const wasPending = answeredId ? pendingStore?.list().find((p) => p.clientOrderId === answeredId) : undefined;
      if (answer.kind === 'outcome' && wasPending && pendingStore) {
        // The same order sent again was answered definitely: it is named as the look-up names it, and the draft let go.
        pendingStore.remove(wasPending.clientOrderId);
        setPending(pendingStore.list());
        setSettledKeys((now) => [...now, wasPending.key]);
        const status = answer.outcome.accepted ? answer.outcome.order?.status : undefined;
        if (status) setFound(t('Pending found', { id: wasPending.clientOrderId, status: word(v, 'status', status) }));
      }
      setLastResult(answer);
    }
    account.reload();
    if (answer.kind === 'outcome' && answer.outcome.accepted) setTab('open');
  };

  const onFound = (entry: PendingOrder, order: VenueOrder) => {
    pendingStore?.remove(entry.clientOrderId);
    setPending(pendingStore?.list() ?? []);
    setSettledKeys((now) => [...now, entry.key]);
    setFound(t('Pending found', { id: entry.clientOrderId, status: word(v, 'status', order.status) }));
    account.reload();
  };
  // The same order again under the same key: the same signed bytes when this tab kept them, so the wallet is not asked.
  const sendAgain = async (entry: PendingOrder) =>
    placed(
      entry.intent,
      await resend(entry.intent, entry.signature ? { signature: entry.signature } : {}),
      tagOf(entry.clientOrderId) ?? '',
    );

  const route: DepositRoute | null = status.deposit ?? null;
  return (
    <div data-testid="if-desk" className="if-desk" data-market={market.symbol} data-venue="on">
      <VenueHeader status={status} title={t('Spot on venue', { symbol: market.symbol })} feeLine={feeLine} />
      <FeeCurrencyRow />
      <VenueMarketPanel
        market={market}
        test={status.test}
        venueName={status.venue.displayName}
        chartTools={
          <div className="dk-chips dk-chips--right">
            {spotMarkets.length > 1 ? (
              <label className="of-field">
                <span>{f('Chart market')}</span>
                <select value={market.symbol} onChange={(event) => navigate(`/trade/spot/${event.target.value}`)}>
                  {spotMarkets.map((m) => (
                    <option key={m.symbol} value={m.symbol}>
                      {m.symbol}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="button" aria-pressed={dom.open} data-testid="dk-open-dom" onClick={toggleDom}>
              {dom.open ? f('Close DOM') : f('Open DOM')}
            </button>
          </div>
        }
        chartTrade={
          <ChartTrade
            market={flowMarket}
            reference={reference}
            amount={clickAmount}
            onAmount={setClickAmount}
            onTrade={onChartTrade}
            refused={notOffered}
          />
        }
        chartOrders={(host) => (
          <VenueChartOrders
            host={host}
            market={market}
            venueName={status.venue.displayName}
            owner={owner}
            openOrders={account.openOrders.data?.value ?? null}
            run={run}
            resend={(intent) => resend(intent)}
            onPlaced={chartPlaced}
            onChanged={account.reload}
          />
        )}
      />
      {dom.open ? (
        <VenueOrderFlow
          market={market}
          test={status.test}
          openOrders={account.openOrders.data?.value ?? null}
          zone={timeZone}
          setting={dom}
          onSetting={setDom}
          onPick={onLadderPick}
          onClose={closeDom}
          instant={instant.on}
          oneClick={
            <OneClickBar
              market={flowMarket}
              instant={instant}
              zone={timeZone}
              presets={quickSizes}
              clickAmount={clickAmount}
              onAmount={setClickAmount}
              free={owner ? closable : null}
              bestBid={bestBid}
              onCloseAll={(amount, price) => pick('sell', 'limit', price, amount)}
            />
          }
          cancelOne={cancel}
          onCancelled={account.reload}
        />
      ) : null}
      <ReadProblem failure={account.balances.failure} venueName={status.venue.displayName} />
      <VenueAccountPanel
        status={status}
        market={market}
        balances={account.balances.data}
        onDeposit={() => setDialog('deposit')}
        onWithdraw={() => setDialog('withdraw')}
        onFlatten={(amount) => {
          setType('market');
          flattenHandle.current?.flatten(
            amount,
            cap?.known ? slippageLimit('sell', best.data?.value ?? null, cap.value, market.tickSize) : null,
          );
        }}
        withdrawal={owner && withdrawalNonce ? <WithdrawalTracker owner={owner} nonce={withdrawalNonce} /> : null}
      />
      {owner ? (
        <SubAccountsPanel owner={owner} balances={account.balances.data} test={status.test} run={run} onMoved={account.reload} />
      ) : null}
      {owner && pending.length > 0 ? (
        <section className="dk-panel form-stack" data-testid="venue-pending" aria-label={t('Pending title')}>
          <h2 className="dk-tab-title">{t('Pending title')}</h2>
          {pending.map((entry) => (
            <PendingCheck key={entry.clientOrderId} owner={owner} entry={entry} onFound={onFound} onSendAgain={sendAgain} />
          ))}
          <p className="dk-note" role="status">
            {t('Pending wait')}
          </p>
        </section>
      ) : found ? (
        <p className="dk-note" role="status" data-testid="venue-pending-found">
          {found}
        </p>
      ) : null}
      <VenueMarketRules market={market} venueName={status.venue.displayName} />
      <Tabs value={type} onValueChange={(value) => setType(value as VenueOrderType)} data-testid="dk-order" className="dk-panel dk-order">
        <div className="dk-order-head">
          <TabsList className="dk-tabs" aria-label={t('Order type')}>
            {offeredTypes.map((x) => (
              <TabsTab key={x} value={x}>
                {x === 'limit' ? d('Limit') : d('Market')}
              </TabsTab>
            ))}
          </TabsList>
          <NotOfferedTypes market={market} />
        </div>
        <div className="dk-order-opts">
          {type === 'limit' ? <VenueTifSelect market={market} tif={tif} onTif={setTif} /> : null}
          <VenueSelfTradeSelect market={market} />
        </div>
        <TabsPanel value={type} className="dk-order-body">
          <div className="dk-forms">
            {(['buy', 'sell'] as const).map((side) => (
              <VenueSideForm
                key={`${side}:${owner ?? ''}`}
                side={side}
                type={type}
                tif={tif}
                protectionBps={cap?.known ? cap.value : null}
                market={market}
                status={status}
                owner={owner}
                access={access}
                account={account}
                worst={type === 'market' && cap?.known ? slippageLimit(side, best.data?.value ?? null, cap.value, market.tickSize) : null}
                capSet={capSet}
                run={run}
                onPlaced={placed}
                waiting={pending.length > 0}
                settledKeys={settledKeys}
                handle={side === 'sell' ? sellHandle : buyHandle}
              />
            ))}
          </div>
        </TabsPanel>
      </Tabs>
      <VenueConditionalOrders market={market} owner={owner} venueName={status.venue.displayName} />
      <Tabs value={tab} onValueChange={(x) => setTab(x as typeof tab)} className="dk-panel dk-bottom" data-testid="venue-bottom">
        <TabsList divider className="dk-tabs dk-tabs--grow" aria-label={v('Open orders')}>
          <TabsTab value="open">{v('Open orders')}</TabsTab>
          <TabsTab value="history">{v('Trade history')}</TabsTab>
          <TabsTab value="positions">{v('Positions')}</TabsTab>
        </TabsList>
        <OutcomeLine result={lastResult} owner={owner} />
        <a className="text-link" data-testid="venue-history-link" href="/trade/orders?product=venue">
          {orders('historyTitle')}
        </a>
        <VenueStatement status={status} owner={owner} />
        <TabsPanel value="open">
          <OrdersTable
            orders={account.openOrders.data}
            test={status.test}
            onCancel={(o) => void cancel(o)}
            cancelled={cancelled}
            filled={filled}
            tagOf={tagOf}
            onEdit={owner ? setEditing : undefined}
            select={{
              selected,
              header: t('Select'),
              label: (id) => t('Select order', { id }),
              onToggle: (id) =>
                setSelected((now) => {
                  const next = new Set(now);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                }),
            }}
          />
          <VenueDeadMan status={status} owner={owner} run={run} />
          <VenueCancelMany
            orders={account.openOrders.data?.value ?? []}
            market={market}
            markets={markets}
            status={status}
            owner={owner}
            run={run}
            selected={(account.openOrders.data?.value ?? []).filter((o) => o.venueClientOrderId && selected.has(o.venueClientOrderId))}
            onDone={() => {
              setSelected(new Set());
              account.reload();
            }}
          />
          {editing && owner ? (
            <VenueEditOrder
              key={editing.venueClientOrderId ?? ''}
              order={editing}
              market={markets.find((m) => m.symbol === editing.symbol) ?? null}
              status={status}
              owner={owner}
              run={run}
              onDone={account.reload}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </TabsPanel>
        <TabsPanel value="history">
          <FillsTable fills={account.fills.data} test={status.test} symbol={market.symbol} tagOf={tagOf} />
        </TabsPanel>
        <TabsPanel value="positions">
          <p data-testid="venue-positions-na">{t('Positions not applicable')}</p>
        </TabsPanel>
      </Tabs>
      {dialog === 'deposit' && owner ? <DepositDialog route={route} test={status.test} onClose={() => setDialog(null)} /> : null}
      {dialog === 'withdraw' && owner ? (
        <WithdrawDialog
          owner={owner}
          asset={market.quoteAsset}
          test={status.test}
          onClose={() => setDialog(null)}
          onSigned={(nonce) => {
            setWithdrawalNonce(nonce);
            account.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** What one signed venue cancel came to, as one-click cancel reports it: a doubtful answer is never retried. */
function cancelOutcome(answer: ActionResult): CancelOutcome {
  if (answer.kind === 'outcome') return answer.outcome.accepted ? 'done' : 'refused';
  return answer.kind === 'unknown' ? 'uncertain' : 'refused';
}

/**
 * The orders behind the venue's fills, and those this page placed, that have left the venue's open orders and not been
 * cancelled here, read back by client id: the ones the venue reads as filled stay listed, Filled (J-cex-spot-01 #8). The
 * latest 20 are read.
 */
function useFilledOrders(
  owner: string | null,
  placed: string[],
  open: VenueOrder[] | null,
  cancelled: Array<{ key: string; clientOrderId: string }>,
): VenueOrder[] {
  const venue = useVenueApi();
  const gone = open
    ? placed.filter((id) => !open.some((o) => o.venueClientOrderId === id) && !cancelled.some((c) => c.clientOrderId === id)).slice(-20)
    : [];
  const ids = gone.join(',');
  const read = useResource(async (signal) => {
    if (!owner || gone.length === 0) return { ok: true as const, data: [] as VenueOrder[] };
    const rows: VenueOrder[] = [];
    for (const id of gone) {
      const r = await venue.orderByClientId(owner, id, signal);
      if (r.ok && r.data.value?.status === 'filled') rows.push(r.data.value);
    }
    return { ok: true as const, data: rows };
  }, `filled:${owner}:${ids}`);
  return useMemo(() => (read.resource.status === 'ready' ? read.resource.data : []), [read.resource]);
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
