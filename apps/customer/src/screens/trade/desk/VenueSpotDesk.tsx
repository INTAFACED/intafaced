import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button as KitButton, Dialog, Field } from '../../../shared/ui';
import { useResource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import { useSession } from '../../../features/session/session';
import { verificationStatus } from '../../../features/account/verification-guards';
import { StepUpConfirm } from '../../../features/money/StepUpConfirm';
import { withdrawStepUpCopy } from '../../../features/money/withdraw-step-up-copy';
import { useWallet } from '../../../features/protocol/wallet/WalletProvider';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import {
  canonicalDecimal,
  draftId,
  keys,
  type AsOf,
  type OrderIntent,
  type VenueBalance,
  type VenueMarket,
  type VenueOrder,
  type VenuePreview,
  type VenueUp,
  type VenueWithdrawal,
} from '../../../features/trade/venue-api';
import {
  FillsTable,
  Known,
  OrdersTable,
  OutcomeLine,
  ReadProblem,
  TestMark,
  VENUE_POLL_MS,
  VenueFrame,
  VenueHeader,
  heldKeys,
  keepsDraft,
  useOwner,
  useVenueAccount,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
  type VenueAccount,
} from '../../../features/trade/venue/VenueKit';
import { builderApproved, carriesBuilderFee } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { tradeAccess } from '../markets/TradeAccess';
import { deskCopy } from './copy';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AmountInput,
  Button,
  refusalCopy,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
} from './deps';
import { placesOf } from './text';
import { zoneName } from './time';
import { spotVenueCopy } from './venue-copy';
import {
  DEFAULT_SLIPPAGE_BPS,
  HeldDraft,
  SLIPPAGE_CHOICES_BPS,
  depositTransfer,
  draftSignature,
  intentOf,
  shortAddress,
  slippageLimit,
  ticketProblem,
  withdrawStep,
  type DepositRoute,
  type SlippageBps,
  type TicketFields,
  type VenueOrderType,
  type VenueSide,
} from './venue-desk';

/** The desk's own symbol form ("BTC-USDC"), whichever way the address writes it. */
export const venueSymbolOf = (pair: string) => pair.replace(/[/_]/g, '-').toUpperCase();

/**
 * Which spot page shows in venue mode: a neutral reading state while the venue's markets are still being read (never
 * today's custodial desk, which could take an order in that window); today's desk only when the venue does not list this
 * pair as spot; the venue's notice when the venue is down or its market list could not be read; otherwise the venue desk.
 */
export function spotGateChoice(
  available: boolean,
  markets: { status: 'loading' } | { status: 'failed' } | { status: 'ready'; listed: boolean },
): 'loading' | 'today' | 'down' | 'venue' {
  if (!available) return 'down';
  if (markets.status === 'loading') return 'loading';
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
  if (choice === 'loading') {
    return (
      <div data-testid="if-desk" className="if-desk" data-venue="on">
        <p role="status" aria-busy="true" data-testid="venue-reading">
          {v('Reading markets')}
        </p>
      </div>
    );
  }
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

/** The lowest level the desk takes orders from, read as the Trade door reads it (identity's own kyc.status). */
type Access = 'loading' | 'unread' | 'verified' | 'verify';
function useTradeAccess(): Access {
  const { api, userId } = useSession();
  const { resource } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'kyc.status', { limit: 1 }, verificationStatus(userId, 1), { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `venue-desk-access:${userId ?? 'guest'}`,
  );
  if (resource.status === 'loading') return 'loading';
  if (resource.status !== 'ready' || resource.data === null) return 'unread';
  const state = tradeAccess(resource.data);
  if (state.kind === 'verified') return 'verified';
  return state.kind === 'unread' ? 'unread' : 'verify';
}

/** The venue's time, as the person's own clock shows it ("9 Nov 2026, 14:03:22"). */
function useClock(): (iso: string) => string {
  const { timeZone } = usePreferences();
  return (iso: string) => {
    try {
      const text = new Intl.DateTimeFormat('en-GB', { timeZone: zoneName(timeZone), dateStyle: 'medium', timeStyle: 'medium' }).format(
        new Date(iso),
      );
      return timeZone === 'device' ? text : `${text} ${timeZone}`;
    } catch {
      return iso;
    }
  };
}

export function VenueSpotDesk({ status, market }: { status: VenueUp; market: VenueMarket }) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const d = deskCopy.useCopy().t;
  const owner = useOwner();
  const venue = useVenueApi();
  const account = useVenueAccount(owner);
  const { run } = useVenueActions(owner);
  const access = useTradeAccess();
  const [type, setType] = useState<VenueOrderType>('limit');
  const [slippage, setSlippage] = useState<SlippageBps>(DEFAULT_SLIPPAGE_BPS);
  const [tab, setTab] = useState<'open' | 'history' | 'positions'>('open');
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);
  const [cancelledKeys, setCancelledKeys] = useState<Array<{ key: string; clientOrderId: string }>>([]);
  const [dialog, setDialog] = useState<'deposit' | 'withdraw' | null>(null);
  const [withdrawalNonce, setWithdrawalNonce] = useState<string | null>(null);
  const placedKeys = useMemo(() => (owner ? heldKeys(owner) : null), [owner]);
  const best = usePolled((signal) => venue.bestPrices(market.symbol, signal), `best:${market.symbol}`, VENUE_POLL_MS);
  const cancelled = useCancelledOrders(owner, cancelledKeys);

  const fee = (m: VenueMarket['makerFeeBps']) => (m.known ? v('Fee bps', { bps: m.value }) : v('Not known'));
  const feeLine = v('Fee line spot', {
    symbol: market.symbol,
    maker: fee(market.makerFeeBps),
    taker: fee(market.takerFeeBps),
    builder: status.builder ? v('Fee bps', { bps: status.builder.feeBps }) : v('Builder fee blank spot'),
  });

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

  const placed = (intent: OrderIntent, answer: ActionResult) => {
    if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId)
      placedKeys?.set(answer.clientOrderId, intent.clientOrderKey);
    setLastResult(answer);
    account.reload();
    if (answer.kind === 'outcome' && answer.outcome.accepted) setTab('open');
  };

  const offeredTypes = market.orderTypes.filter((x): x is VenueOrderType => x === 'limit' || x === 'market');
  const route: DepositRoute | null = status.deposit ?? null;
  return (
    <div data-testid="if-desk" className="if-desk" data-market={market.symbol} data-venue="on">
      <VenueHeader status={status} title={t('Spot on venue', { symbol: market.symbol })} feeLine={feeLine} />
      <ReadProblem failure={account.balances.failure} venueName={status.venue.displayName} />
      <VenueAccountPanel
        status={status}
        market={market}
        balances={account.balances.data}
        onDeposit={() => setDialog('deposit')}
        onWithdraw={() => setDialog('withdraw')}
        withdrawal={owner && withdrawalNonce ? <WithdrawalTracker owner={owner} nonce={withdrawalNonce} /> : null}
      />
      <Tabs value={type} onValueChange={(value) => setType(value as VenueOrderType)} data-testid="dk-order" className="dk-panel dk-order">
        <div className="dk-order-head">
          <TabsList className="dk-tabs" aria-label={t('Order type')}>
            {offeredTypes.map((x) => (
              <TabsTab key={x} value={x}>
                {x === 'limit' ? d('Limit') : d('Market')}
              </TabsTab>
            ))}
          </TabsList>
          {type === 'market' ? (
            <label className="dk-tif">
              <span className="dk-tif-label">{t('Slippage limit')}</span>
              <select value={slippage} onChange={(e) => setSlippage(e.target.value as SlippageBps)} aria-label={t('Slippage limit')}>
                {SLIPPAGE_CHOICES_BPS.map((choice) => (
                  <option key={choice.bps} value={choice.bps}>
                    {t('Slippage choice', { percent: choice.percent })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <TabsPanel value={type} className="dk-order-body">
          <div className="dk-forms">
            {(['buy', 'sell'] as const).map((side) => (
              <VenueSideForm
                key={`${side}:${owner ?? ''}`}
                side={side}
                type={type}
                market={market}
                status={status}
                owner={owner}
                access={access}
                account={account}
                worst={type === 'market' ? slippageLimit(side, best.data?.value ?? null, slippage, market.tickSize) : null}
                run={run}
                onPlaced={placed}
              />
            ))}
          </div>
        </TabsPanel>
      </Tabs>
      <Tabs value={tab} onValueChange={(x) => setTab(x as typeof tab)} className="dk-panel dk-bottom" data-testid="venue-bottom">
        <TabsList divider className="dk-tabs dk-tabs--grow" aria-label={v('Open orders')}>
          <TabsTab value="open">{v('Open orders')}</TabsTab>
          <TabsTab value="history">{v('Trade history')}</TabsTab>
          <TabsTab value="positions">{v('Positions')}</TabsTab>
        </TabsList>
        <OutcomeLine result={lastResult} owner={owner} />
        <TabsPanel value="open">
          <OrdersTable orders={account.openOrders.data} test={status.test} onCancel={(o) => void cancel(o)} cancelled={cancelled} />
        </TabsPanel>
        <TabsPanel value="history">
          <FillsTable fills={account.fills.data} test={status.test} symbol={market.symbol} />
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

/**
 * The person's own venue account, the venue's figures only: the wallet that owns it (Connect until connected, then its
 * short address), the quote and base balances free and used with the venue's as-of time, and Deposit and Withdraw.
 */
function VenueAccountPanel({
  status,
  market,
  balances,
  onDeposit,
  onWithdraw,
  withdrawal,
}: {
  status: VenueUp;
  market: VenueMarket;
  balances: AsOf<VenueBalance[]> | null;
  onDeposit: () => void;
  onWithdraw: () => void;
  withdrawal: ReactNode;
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const wallet = useWallet();
  const owner = useOwner();
  const clock = useClock();
  const rowOf = (asset: string) => balances?.value.find((b) => b.asset === asset) ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Venue account')} data-testid="venue-account">
      <h2 className="dk-tab-title">
        {t('Venue account')} <TestMark test={status.test} />
      </h2>
      <p className="muted">{t('Venue account note')}</p>
      {wallet.status === 'connected' && wallet.address ? (
        <div>
          <p>
            {t('Connected')}:{' '}
            <span className="numeric" data-testid="venue-wallet-address" title={wallet.address.toLowerCase()}>
              {shortAddress(wallet.address.toLowerCase())}
            </span>{' '}
            <KitButton variant="secondary" onClick={wallet.disconnect}>
              {v('Disconnect')}
            </KitButton>
          </p>
          {wallet.guard && !wallet.guard.ok ? (
            <p role="alert">
              {v('Wrong network', { observed: String(wallet.guard.observed ?? ''), configured: String(wallet.guard.configured) })}{' '}
              <KitButton onClick={() => void wallet.switchNetwork()}>{v('Switch network')}</KitButton>
            </p>
          ) : null}
        </div>
      ) : wallet.wallets.length === 0 ? (
        <p className="muted">{v('No wallet')}</p>
      ) : (
        <p>
          {wallet.wallets.map((entry) => (
            <KitButton key={entry.info.uuid} disabled={wallet.status === 'connecting'} onClick={() => void wallet.connect(entry)}>
              {v('Connect wallet', { name: entry.info.name })}
            </KitButton>
          ))}
        </p>
      )}
      {wallet.problem ? (
        <p className="failure" role="alert">
          {wallet.problem}
        </p>
      ) : null}
      {owner && balances
        ? [market.quoteAsset, market.baseAsset].map((asset) => {
            const row = rowOf(asset);
            return (
              <dl className="protocol-facts" key={asset} data-asset={asset}>
                <div>
                  <dt>{v('Asset')}</dt>
                  <dd>{asset}</dd>
                </div>
                <div>
                  <dt>{t('Free')}</dt>
                  <dd className="numeric" data-cell="free">
                    {displayAmount(row?.free ?? '0')} {asset}
                  </dd>
                </div>
                <div>
                  <dt>{t('Used')}</dt>
                  <dd className="numeric" data-cell="used">
                    {displayAmount(row?.locked ?? '0')} {asset}
                  </dd>
                </div>
                <div>
                  <dt>{t('As of')}</dt>
                  <dd className="numeric">{clock(balances.asOf)}</dd>
                </div>
              </dl>
            );
          })
        : null}
      <p>
        <KitButton disabled={!owner} onClick={onDeposit}>
          {t('Deposit')}
        </KitButton>{' '}
        <KitButton variant="secondary" disabled={!owner} onClick={onWithdraw}>
          {t('Withdraw')}
        </KitButton>
      </p>
      {withdrawal}
    </section>
  );
}

type Live =
  | { signature: string; state: 'checking' }
  | { signature: string; state: 'ok'; preview: AsOf<VenuePreview> }
  | {
      signature: string;
      state: 'refused';
      message: string;
    };

/** How long the ticket waits after the last keystroke before it asks the venue for its preview. */
const PREVIEW_DEBOUNCE_MS = 250;

/**
 * One side's ticket, today's desk's controls: Price and Amount, the venue's own preview asked for as the order is typed,
 * the Buy or Sell button with its reason under it, and the Review sheet with the venue's lines. The client order key is
 * held for the order while it is unchanged, so a closed and reopened review names the same venue order.
 */
function VenueSideForm({
  side,
  type,
  market,
  status,
  owner,
  access,
  account,
  worst,
  run,
  onPlaced,
}: {
  side: VenueSide;
  type: VenueOrderType;
  market: VenueMarket;
  status: VenueUp;
  owner: string | null;
  access: Access;
  account: VenueAccount;
  worst: string | null;
  run: ReturnType<typeof useVenueActions>['run'];
  onPlaced: (intent: OrderIntent, answer: ActionResult) => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  const d = deskCopy.useCopy().t;
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [live, setLive] = useState<Live | null>(null);
  const [review, setReview] = useState<{ intent: OrderIntent; preview: AsOf<VenuePreview> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const [approving, setApproving] = useState<ActionResult | null>(null);

  /** A sell that carries our builder fee, with no approval on the venue: the wallet signs the approval first. */
  async function approve() {
    if (!status.builder || sending.current) return;
    sending.current = true;
    const answer = await run(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      { actionKey: keys.builderApproval(owner ?? '', status.builder.address, status.builder.feeBps) },
    );
    sending.current = false;
    setApproving(answer);
    account.reload();
  }
  const draft = useMemo(() => (owner ? new HeldDraft(owner, market.symbol) : null), [owner, market.symbol]);
  const fields: TicketFields = { side, type, price, amount };
  const issue = ticketProblem(fields, market, worst);
  const intent = draft && issue === null ? intentOf(fields, market, worst, draft.keyFor(fields)) : null;
  const signature = intent ? `${draftSignature(fields)}|${intent.price}|${intent.clientOrderKey}` : null;

  // The venue's preview as the order is typed: one ask per settled order, the latest answer kept.
  useEffect(() => {
    if (!owner || !intent || !signature) {
      setLive(null);
      return;
    }
    setLive({ signature, state: 'checking' });
    let gone = false;
    const timer = setTimeout(() => {
      void venue.preview(owner, intent).then((answer) => {
        if (gone) return;
        setLive(answer.ok ? { signature, state: 'ok', preview: answer.data } : { signature, state: 'refused', message: answer.message });
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
    // The signature names every part of the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, signature, venue]);

  const verb = side === 'buy' ? d('Buy asset', { asset: market.baseAsset }) : d('Sell asset', { asset: market.baseAsset });
  const canSend = access === 'verified' && owner !== null && intent !== null && !busy;
  const amountPlaces = placesOf(market.lotSize);
  const pricePlaces = placesOf(market.tickSize);
  const verify = refusalCopy('denied.kyc_required', {});

  async function startReview(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || !intent || !owner) return;
    setProblem(null);
    setResult(null);
    const fresh = live && live.signature === signature && live.state === 'ok' ? live.preview : null;
    if (fresh) return setReview({ intent, preview: fresh });
    const answer = await venue.preview(owner, intent);
    if (!answer.ok) return setProblem(v('Outcome refused', { detail: answer.message }));
    setReview({ intent, preview: answer.data });
  }

  async function confirm() {
    if (!review || sending.current) return;
    sending.current = true;
    const sent = review.intent;
    // The review closes on Confirm: what follows is the wallet's, then the venue's answer under the ticket.
    setReview(null);
    setBusy(true);
    const answer = await run(sent);
    sending.current = false;
    setBusy(false);
    setResult(answer);
    if (!keepsDraft(answer)) draft?.settle(sent.clientOrderKey);
    onPlaced(sent, answer);
  }

  const edit = (apply: () => void) => {
    apply();
    setResult(null);
    setProblem(null);
  };

  return (
    <form
      data-testid="dk-form"
      className="dk-form"
      data-side={side}
      aria-label={side === 'buy' ? d('Buy form', { asset: market.baseAsset }) : d('Sell form', { asset: market.baseAsset })}
      onSubmit={(event) => void startReview(event)}
    >
      {type === 'limit' ? (
        <AmountInput
          label={d('Price')}
          value={price}
          onValueChange={(next) => edit(() => setPrice(next))}
          precision={pricePlaces}
          tick={market.tickSize}
          min={market.tickSize}
          unit={market.quoteAsset}
          stepLabels={{ up: d('Price up one step'), down: d('Price down one step') }}
          aria-label={d('Price')}
        />
      ) : (
        <AmountInput
          label={d('Price')}
          value=""
          onValueChange={() => undefined}
          precision={pricePlaces}
          readOnly
          disabled
          unit={market.quoteAsset}
          placeholder={d('Market price word')}
          aria-label={d('Price')}
        />
      )}
      <AmountInput
        label={d('Amount')}
        value={amount}
        onValueChange={(next) => edit(() => setAmount(next))}
        precision={amountPlaces}
        unit={market.baseAsset}
        placeholder="0"
        aria-label={d('Amount')}
      />
      {type === 'market' && worst ? (
        <p className="dk-note-small if-num" data-testid="venue-worst-price">
          {t('Worst price line', { price: displayAmount(worst), quote: market.quoteAsset })}
        </p>
      ) : null}
      <Button
        type="submit"
        variant={side}
        shape="rounded"
        size={40}
        fullWidth
        loading={busy}
        disabled={!canSend}
        aria-describedby={`dk-reason-${side}`}
      >
        {verb}
      </Button>
      <div className="dk-reason" id={`dk-reason-${side}`} aria-live="polite">
        {access === 'verify' ? (
          <div data-testid="dk-note--bad" className="dk-note dk-note--bad" role="alert">
            <p className="dk-note-title">{verify.title}</p>
            <p>{verify.body}</p>
            {verify.action ? (
              <a className="dk-link" href={verify.action.href}>
                {verify.action.label}
              </a>
            ) : null}
          </div>
        ) : access === 'loading' ? (
          <p className="dk-note">{t('Checking verification')}</p>
        ) : access === 'unread' ? (
          <p className="dk-note">{t('Verification unread')}</p>
        ) : !owner ? (
          <p className="dk-note">{t('Connect to trade')}</p>
        ) : issue === 'no_book' ? (
          <p className="dk-note">{t('No book side')}</p>
        ) : issue === 'amount_step' && amount ? (
          <p className="dk-note">{t('Not a step', { field: d('Amount'), step: market.lotSize })}</p>
        ) : issue === 'price_step' && price ? (
          <p className="dk-note">{t('Not a step', { field: d('Price'), step: market.tickSize })}</p>
        ) : live?.state === 'checking' ? (
          <p className="dk-note">{t('Checking venue')}</p>
        ) : live?.state === 'refused' ? (
          <p className="dk-note dk-note--bad" role="alert">
            {v('Outcome refused', { detail: live.message })}
          </p>
        ) : null}
        {busy ? <p className="dk-note">{t('Waiting wallet')}</p> : null}
        {problem ? (
          <p className="dk-note dk-note--bad" role="alert">
            {problem}
          </p>
        ) : null}
        {result ? <OutcomeLine result={result} owner={owner} /> : null}
      </div>
      <AlertDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !sending.current) setReview(null);
        }}
      >
        {review ? (
          <AlertDialogContent className="dk-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{side === 'buy' ? d('Review buy') : d('Review sell')}</AlertDialogTitle>
              <AlertDialogDescription>{t('Review intro')}</AlertDialogDescription>
            </AlertDialogHeader>
            <VenueReviewRows intent={review.intent} preview={review.preview} status={status} approved={builderApproved(account, status)} />
            {carriesBuilderFee(review.preview.value.builderFee) && builderApproved(account, status) === false ? (
              <Button variant="secondary" size={40} onClick={() => void approve()}>
                {v('Approve in wallet')}
              </Button>
            ) : null}
            <OutcomeLine result={approving} owner={owner} />
            <AlertDialogFooter>
              <Button variant="secondary" size={40} onClick={() => setReview(null)}>
                {t('Cancel')}
              </Button>
              <Button
                variant={side}
                shape="pill"
                size={40}
                disabled={carriesBuilderFee(review.preview.value.builderFee) && builderApproved(account, status) !== true}
                onClick={() => void confirm()}
              >
                {side === 'buy' ? t('Confirm buy') : t('Confirm sell')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </form>
  );
}

/**
 * The review's lines, every one the venue's own preview: what it locks, the venue's fee, our builder fee as its own
 * line (none on a known zero, and then no approval is asked), the fee role, the time in force, a market order's worst
 * price, and the client id held for retry. An order that carries our builder fee and has no approval says so; it is
 * approved on the venue desk's own approval step, never here by default.
 */
export function VenueReviewRows({
  intent,
  preview,
  status,
  approved,
}: {
  intent: OrderIntent;
  preview: AsOf<VenuePreview>;
  status: Pick<VenueUp, 'builder' | 'test'>;
  approved: boolean | null;
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const clock = useClock();
  const p = preview.value;
  const carries = carriesBuilderFee(p.builderFee);
  return (
    <div data-testid="venue-review" className="form-stack">
      <TestMark test={status.test} />
      <dl className="protocol-facts">
        <div>
          <dt>{t('Venue locks')}</dt>
          <dd className="numeric" data-line="lock">
            {displayAmount(p.lock.amount)} {p.lock.asset}
          </dd>
        </div>
        <div>
          <dt>{t('Venue fee')}</dt>
          <dd className="numeric" data-line="venue-fee">
            <Known value={p.venueFee.known ? { known: true, value: p.venueFee.value.amount } : { known: false }} />{' '}
            {p.venueFee.known ? p.venueFee.value.asset : ''}
          </dd>
        </div>
        <div>
          <dt>{t('Our builder fee')}</dt>
          <dd className="numeric" data-line="builder-fee">
            {!carries ? (
              v('Builder none spot buy')
            ) : status.builder ? (
              <>
                <Known value={p.builderFee.known ? { known: true, value: p.builderFee.value.amount } : { known: false }} />{' '}
                {p.builderFee.known ? p.builderFee.value.asset : ''}
                {approved === false ? ` · ${v('Builder not approved', { bps: status.builder.feeBps })}` : ''}
              </>
            ) : (
              <span role="alert">{v('Builder fee owner blank')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Fee role')}</dt>
          <dd data-line="role">{word(v, 'role', p.role)}</dd>
        </div>
        <div>
          <dt>{t('Time in force')}</dt>
          <dd data-line="tif">{word(v, 'tif', intent.timeInForce)}</dd>
        </div>
        {intent.type === 'market' ? (
          <div>
            <dt>{t('Worst price review')}</dt>
            <dd className="numeric" data-line="worst">
              {displayAmount(intent.price)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t('Client id')}</dt>
          <dd className="numeric" data-line="client-id" data-testid="client-order-id">
            {intent.clientOrderKey}
          </dd>
        </div>
        <div>
          <dt>{t('As of')}</dt>
          <dd className="numeric">{clock(preview.asOf)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Deposit: the person's own token transfer from their wallet to the venue's deposit address, signed in their wallet.
 * The venue credits it when it sees the transfer; INTAFACED moves nothing and the ledger posts nothing.
 */
function DepositDialog({ route, test, onClose }: { route: DepositRoute | null; test: boolean; onClose: () => void }) {
  const { t } = spotVenueCopy.useCopy();
  const wallet = useWallet();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState<{ good: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const asset = route?.asset ?? '';

  async function send() {
    if (busy) return;
    setNote(null);
    if (!route) return setNote({ good: false, text: t('Deposit no route') });
    if (wallet.chainId !== null && wallet.chainId !== route.chainId)
      return setNote({ good: false, text: t('Deposit wrong network', { chainId: String(route.chainId) }) });
    const transfer = depositTransfer(route, amount);
    if (!transfer) return setNote({ good: false, text: t('Deposit amount bad', { asset, places: String(route.tokenDecimals) }) });
    setBusy(true);
    const sent = await wallet.sign({ kind: 'transaction', to: transfer.to, data: transfer.data });
    setBusy(false);
    if (sent.status === 'sent') setNote({ good: true, text: t('Deposit sent', { amount: canonicalDecimal(amount), asset }) });
    else if (sent.status === 'rejected') setNote({ good: false, text: t('Deposit rejected') });
    else setNote({ good: false, text: t('Deposit failed', { detail: sent.status === 'failed' ? sent.message : '' }) });
  }

  return (
    <Dialog title={t('Deposit title')} onClose={onClose}>
      <div className="form-stack" data-testid="venue-deposit">
        <TestMark test={test} />
        {route ? (
          <>
            <p className="muted">{t('Deposit why', { asset })}</p>
            <Field
              label={t('Deposit amount', { asset })}
              name="venue-deposit-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <dl className="protocol-facts">
              <div>
                <dt>{t('Deposit to')}</dt>
                <dd className="numeric">{route.address}</dd>
              </div>
              <div>
                <dt>{t('Deposit token')}</dt>
                <dd className="numeric">
                  {asset} · {route.token}
                </dd>
              </div>
              <div>
                <dt>{t('Deposit network')}</dt>
                <dd className="numeric">{route.chainId}</dd>
              </div>
            </dl>
            <KitButton disabled={busy || amount.trim() === ''} onClick={() => void send()}>
              {t('Deposit send')}
            </KitButton>
          </>
        ) : (
          <p role="alert">{t('Deposit no route')}</p>
        )}
        {busy ? <p className="muted">{t('Waiting wallet')}</p> : null}
        {note ? (
          <p role={note.good ? 'status' : 'alert'} className={note.good ? '' : 'failure'}>
            {note.text}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Withdraw from the venue account to the connected wallet: "Confirm it’s you" first (identity's
 * `trade.step_up.venue.withdraw`, bound to the key, account, asset, amount and destination), and only after it the
 * door prepares the withdrawal and the wallet signs. Closing the step-up asks nothing of the wallet.
 */
function WithdrawDialog({
  owner,
  asset,
  test,
  onClose,
  onSigned,
}: {
  owner: string;
  asset: string;
  test: boolean;
  onClose: () => void;
  onSigned: (nonce: string) => void;
}) {
  const { t } = spotVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const s = withdrawStepUpCopy.useCopy().t;
  const { run } = useVenueActions(owner);
  const draft = useRef(draftId());
  const [amount, setAmount] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const withdrawalKey = keys.withdraw(owner, draft.current);
  let canonical: string | null = null;
  try {
    canonical = amount.trim() ? canonicalDecimal(amount) : null;
  } catch {
    canonical = null;
  }

  function press() {
    setProblem(null);
    const next = withdrawStep(amount, null);
    if (next.step === 'refuse' || !canonical) return setProblem(t('Withdraw amount bad'));
    setStepUp(true);
  }

  async function signed(stepUpApprovalId: string | null) {
    const next = withdrawStep(amount, { id: stepUpApprovalId });
    if (next.step !== 'sign' || !canonical) return;
    setStepUp(false);
    setBusy(true);
    const answer = await run(
      { kind: 'withdraw', asset, amount: canonical, destination: owner, withdrawalKey },
      { stepUpApprovalId: next.stepUpApprovalId },
    );
    setBusy(false);
    setResult(answer);
    const nonce = answer.kind === 'outcome' && answer.outcome.accepted ? answer.nonce : answer.kind === 'unknown' ? answer.nonce : null;
    if (nonce) {
      onSigned(nonce);
      onClose();
    }
  }

  return (
    <>
      <Dialog title={t('Withdraw title')} onClose={onClose}>
        <div className="form-stack" data-testid="venue-withdraw">
          <TestMark test={test} />
          <Field
            label={t('Withdraw amount', { asset })}
            name="venue-withdraw-amount"
            inputMode="decimal"
            value={amount}
            disabled={busy}
            onChange={(e) => {
              setAmount(e.target.value);
              setResult(null);
              // A changed amount is a new withdrawal: a new key, and a new confirmation.
              draft.current = draftId();
            }}
          />
          <p>
            {t('Withdraw to')}:{' '}
            <span className="numeric" title={owner}>
              {shortAddress(owner)}
            </span>
          </p>
          {problem ? (
            <p className="failure" role="alert">
              {problem}
            </p>
          ) : null}
          {busy ? <p className="muted">{v('Waiting wallet')}</p> : null}
          <OutcomeLine result={result} owner={owner} />
          <KitButton disabled={busy} onClick={press}>
            {t('Withdraw send')}
          </KitButton>
        </div>
      </Dialog>
      {stepUp && canonical ? (
        <Dialog title={s('title')} onClose={() => setStepUp(false)}>
          <StepUpConfirm
            request={() => ({
              scope: 'trade.step_up.venue.withdraw',
              purpose: 'venue.withdraw',
              target: withdrawalKey,
              amount: canonical!,
              fields: { withdrawalKey, owner, subAccount: '', asset, amount: canonical!, destination: owner },
            })}
            words={{
              why: v('Withdraw step up why'),
              code: s('code'),
              codeHint: v('Authenticator hint'),
              codeShort: v('Enter six'),
              noFactor: v('No factor'),
              sendWithout: v('Send without'),
            }}
            disabled={busy}
            onApproved={(id) => void signed(id)}
          />
        </Dialog>
      ) : null}
    </>
  );
}

/** The venue's withdrawal by its nonce: pending, then done, with its fee or "not known", and the venue's as-of time. */
function WithdrawalTracker({ owner, nonce }: { owner: string; nonce: string }) {
  const venue = useVenueApi();
  const tracked = usePolled((signal) => venue.withdrawal(owner, nonce, signal), `w:${owner}:${nonce}`, VENUE_POLL_MS);
  const value = tracked.data?.value ?? null;
  if (!value || !tracked.data) return null;
  return <WithdrawalLine withdrawal={value} asOf={tracked.data.asOf} />;
}

export function WithdrawalLine({ withdrawal, asOf }: { withdrawal: VenueWithdrawal; asOf: string }) {
  const v = venueCopy.useCopy().t;
  const { t } = spotVenueCopy.useCopy();
  const clock = useClock();
  return (
    <dl className="protocol-facts" data-testid="venue-withdrawal" data-status={withdrawal.status} data-nonce={withdrawal.nonce}>
      <div>
        <dt>{v('Withdrawal status')}</dt>
        <dd>{word(v, 'withdrawal', withdrawal.status)}</dd>
      </div>
      <div>
        <dt>{v('Amount')}</dt>
        <dd className="numeric">
          {displayAmount(withdrawal.amount)} {withdrawal.asset}
        </dd>
      </div>
      <div>
        <dt>{v('Withdrawal fee')}</dt>
        <dd className="numeric" data-cell="fee">
          <Known value={withdrawal.fee} />
        </dd>
      </div>
      <div>
        <dt>{t('As of')}</dt>
        <dd className="numeric">{clock(asOf)}</dd>
      </div>
    </dl>
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
