import { useMemo, useRef, useState } from 'react';
import { Button, DataTable, Tabs } from '../../../shared/ui';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import type { VenueMode } from '../../../features/trade/use-venue-mode';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import {
  canonicalDecimal,
  draftId,
  keys,
  leverageBpsOf,
  leverageTimes,
  onStep,
  partOf,
  sumDecimals,
  type AsOf,
  type OrderIntent,
  type VenueFill,
  type VenueMarginMode,
  type VenueMarket,
  type VenuePosition,
  type VenuePreview,
  type VenueUp,
} from '../../../features/trade/venue-api';
import {
  AsOfLine,
  BalancesPanel,
  FillsTable,
  Known,
  OrdersTable,
  OutcomeLine,
  ReadProblem,
  TestMark,
  VENUE_POLL_MS,
  VenueFrame,
  VenueHeader,
  WalletBar,
  heldKeys,
  outcomeText,
  keepsDraft,
  ReadBack,
  useOwner,
  useVenueAccount,
  useVenueActions,
  useVenueApi,
  word,
  type ActionResult,
  type RunAction,
  type VenueAccount,
} from '../../../features/trade/venue/VenueKit';
import { ReviewDialog } from '../../../features/trade/venue/VenueReview';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import { futuresVenueCopy } from './venue-copy';

/** Resting order types the futures desk names; any the venue does not list is shown with its refusal and sends nothing. */
const RESTING_TYPES = ['stop', 'take_profit', 'trailing_stop'] as const;
const MODES: readonly VenueMarginMode[] = ['isolated', 'cross'];
/** How far from the mark a close's worst price sits (its slippage limit), in percent. */
const CLOSE_SLIPPAGE_PERCENT = 5n;

/** The futures desk in venue mode: every perpetual the venue lists, on the customer's own venue account. */
export function VenueFuturesDesk({ mode, symbol }: { mode: Extract<VenueMode, { mode: 'on' }>; symbol: string | null }) {
  return (
    <VenueFrame mode={mode}>
      <Desk status={mode.status} requested={symbol} />
    </VenueFrame>
  );
}

function Desk({ status, requested }: { status: Extract<VenueMode, { mode: 'on' }>['status']; requested: string | null }) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const markets = usePolled((signal) => venue.markets(signal), 'venue-markets', 5_000);
  if (!status.available) {
    return (
      <div data-testid="if-futures" className="if-desk" data-venue="on">
        <p className="failure" role="alert" data-testid="venue-down">
          {v('Venue unavailable', { detail: status.refusal.detail })}
        </p>
      </div>
    );
  }
  const perps = (markets.data?.value ?? []).filter((m) => m.kind === 'perpetual');
  const down = markets.failure?.code === 'trade.venue.venue_down';
  return (
    <div data-testid="if-futures" className="if-desk" data-venue="on">
      <VenueHeader status={status} title={t('Futures on venue')} />
      {down || markets.failure ? <ReadProblem failure={markets.failure} venueName={status.venue.displayName} /> : null}
      <section className="dk-panel" aria-label={t('Contracts')} data-testid="venue-contracts">
        <h2 className="dk-tab-title">{t('Contracts')}</h2>
        {markets.data && perps.length === 0 ? (
          <div data-testid="venue-no-contract">
            <p>{t('No contract')}</p>
            <p className="muted">{t('No contract reason', { venue: status.venue.displayName })}</p>
          </div>
        ) : null}
      </section>
      {markets.data && perps.length > 0 ? <Contracts status={status} perps={perps} requested={requested} /> : null}
    </div>
  );
}

/** A venue that is down is named above; its controls still answer, each with the venue's typed refusal and nothing sent. */
function Contracts({ status, perps, requested }: { status: VenueUp; perps: VenueMarket[]; requested: string | null }) {
  const { t } = futuresVenueCopy.useCopy();
  const [chosen, setChosen] = useState<string>(perps.find((m) => m.symbol === requested)?.symbol ?? perps[0]!.symbol);
  const market = perps.find((m) => m.symbol === chosen) ?? perps[0]!;
  const owner = useOwner();
  const account = useVenueAccount(owner, { positions: true });
  const { run } = useVenueActions(owner);
  return (
    <>
      <ul className="form-stack" aria-label={t('Contracts')} data-testid="venue-contract-list">
        {perps.map((m) => (
          <li key={m.symbol}>
            <Button
              variant={m.symbol === market.symbol ? 'primary' : 'secondary'}
              aria-pressed={m.symbol === market.symbol}
              onClick={() => setChosen(m.symbol)}
            >
              {t('Contract on venue', { symbol: m.symbol, venue: status.venue.displayName })}
            </Button>{' '}
            <TestMark test={status.test} />
          </li>
        ))}
      </ul>
      <ContractStrip market={market} positions={account.positions.data} test={status.test} />
      <WalletBar />
      <ReadProblem failure={account.balances.failure} venueName={status.venue.displayName} />
      {owner ? <BalancesPanel balances={account.balances.data} test={status.test} /> : null}
      {owner ? <MarginStep key={market.symbol} market={market} owner={owner} run={run} test={status.test} disabled={false} /> : null}
      {owner ? (
        <Ticket key={`t:${market.symbol}`} status={status} market={market} owner={owner} account={account} run={run} disabled={false} />
      ) : null}
      {owner ? <Blotter status={status} market={market} owner={owner} account={account} run={run} /> : null}
    </>
  );
}

function ContractStrip({ market, positions, test }: { market: VenueMarket; positions: AsOf<VenuePosition[]> | null; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const held = positions?.value.find((p) => p.symbol === market.symbol);
  return (
    <section className="dk-panel" aria-label={t('Contract strip')} data-testid="venue-contract-strip">
      <h2 className="dk-tab-title">
        {market.symbol} <TestMark test={test} />
      </h2>
      <dl className="protocol-facts">
        <div>
          <dt>{t('Family')}</dt>
          <dd>{t('family_perpetual')}</dd>
        </div>
        <div>
          <dt>{t('Settle asset')}</dt>
          <dd>{market.quoteAsset}</dd>
        </div>
        <div>
          <dt>{t('Lot size')}</dt>
          <dd className="numeric">{t('Lot size value', { lot: market.lotSize, base: market.baseAsset })}</dd>
        </div>
        <div>
          <dt>{t('Tick size')}</dt>
          <dd className="numeric">{market.tickSize}</dd>
        </div>
        <div>
          <dt>{t('Max leverage')}</dt>
          <dd className="numeric">
            {market.maxLeverageBps === null ? <Known value={{ known: false }} /> : `${leverageTimes(market.maxLeverageBps)}x`}
          </dd>
        </div>
        <div>
          <dt>{t('Mark price')}</dt>
          <dd className="numeric">
            <Known value={held ? { known: true, value: held.markPrice } : { known: false }} />
          </dd>
        </div>
        <div>
          <dt>{t('Funding')}</dt>
          <dd>
            <Known value={{ known: false }} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** The margin step: the modes the venue offers for this contract, the others listed as not offered, and a signed leverage setting. */
function MarginStep({
  market,
  owner,
  run,
  test,
  disabled,
}: {
  market: VenueMarket;
  owner: string;
  run: RunAction;
  test: boolean;
  disabled: boolean;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const current = usePolled((signal) => venue.leverage(owner, market.symbol, signal), `lev:${owner}:${market.symbol}`, VENUE_POLL_MS);
  const [mode, setMode] = useState<VenueMarginMode>(market.marginModes[0] ?? 'isolated');
  const [times, setTimes] = useState('10');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const draft = useRef(draftId());
  const max = market.maxLeverageBps === null ? null : leverageTimes(market.maxLeverageBps);

  async function sign() {
    setProblem(null);
    const n = Number(times);
    if (!Number.isInteger(n) || n < 1 || (max !== null && n > max)) return setProblem(t('Leverage whole', { max: String(max ?? '') }));
    const bps = leverageBpsOf(n);
    const answer = await run(
      { kind: 'update_leverage', symbol: market.symbol, leverageBps: bps, marginMode: mode },
      { actionKey: keys.leverage(owner, market.symbol, mode, bps, draft.current) },
    );
    setResult(answer);
    if (!keepsDraft(answer)) draft.current = draftId();
    current.reload();
  }

  const set = current.data?.value ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Margin step')} data-testid="venue-margin">
      <h2 className="dk-tab-title">
        {t('Margin step')} <TestMark test={test} />
      </h2>
      <div role="radiogroup" aria-label={t('Margin mode')}>
        {MODES.map((m) => {
          const offered = market.marginModes.includes(m);
          return (
            <label key={m} className="field" data-mode={m} data-offered={offered ? 'true' : 'false'}>
              <input
                type="radio"
                name={`mode-${market.symbol}`}
                value={m}
                checked={mode === m}
                disabled={!offered}
                onChange={() => setMode(m)}
              />
              <span>
                {t(`mode_${m}`)}
                {offered ? '' : ` · ${v('Not offered')}`}
              </span>
            </label>
          );
        })}
      </div>
      <p data-testid="venue-leverage-current">
        {set
          ? t('Leverage set', { times: String(leverageTimes(set.leverageBps)), mode: t(`mode_${set.marginMode}`) })
          : current.data
            ? t('Leverage not set')
            : ''}
      </p>
      <label className="field">
        <span>{t('Leverage x')}</span>
        <input inputMode="numeric" aria-label={t('Leverage x')} value={times} onChange={(e) => setTimes(e.target.value)} />
      </label>
      <Button disabled={disabled} onClick={() => void sign()}>
        {t('Sign leverage')}
      </Button>
      {problem ? (
        <p className="failure" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={result} owner={owner} />
    </section>
  );
}

function Ticket({
  status,
  market,
  owner,
  account,
  run,
  disabled,
}: {
  status: VenueUp;
  market: VenueMarket;
  owner: string;
  account: VenueAccount;
  run: RunAction;
  disabled: boolean;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'limit' | 'market'>(market.orderTypes.includes('market') ? 'market' : 'limit');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [marginAsset, setMarginAsset] = useState(market.quoteAsset);
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<{ intent: OrderIntent; preview: AsOf<VenuePreview> } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [last, setLast] = useState<ActionResult | null>(null);
  const counter = useRef(0);
  const sending = useRef(false);
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const assets = [...new Set([market.quoteAsset, ...(account.balances.data?.value.map((b) => b.asset) ?? [])])];
  const offered = market.orderTypes.filter((x): x is 'limit' | 'market' => x === 'limit' || x === 'market');

  async function openReview() {
    setProblem(null);
    setResult(null);
    if (marginAsset !== market.quoteAsset)
      return setProblem(t('Margin mismatch', { symbol: market.symbol, settle: market.quoteAsset, asset: marginAsset }));
    if (!size.trim()) return setProblem(v('Enter amount'));
    if (!price.trim()) return setProblem(v('Enter price'));
    if (!onStep(size, market.lotSize)) return setProblem(v('Not a step', { field: v('Amount'), step: market.lotSize }));
    if (!onStep(price, market.tickSize)) return setProblem(v('Not a step', { field: v('Price'), step: market.tickSize }));
    const intent: OrderIntent = {
      kind: 'place_order',
      symbol: market.symbol,
      side,
      type,
      amount: canonicalDecimal(size),
      price: canonicalDecimal(price),
      timeInForce: type === 'market' ? 'IOC' : (market.timeInForce[0] ?? 'GTC'),
      reduceOnly: false,
      clientOrderKey: keys.order(owner, market.symbol, draftId(Date.now(), counter.current++)),
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
    if ((answer.kind === 'outcome' || answer.kind === 'unknown') && answer.clientOrderId)
      keysHeld.set(answer.clientOrderId, review.intent.clientOrderKey);
    setResult(answer);
    setLast(answer);
    account.reload();
  }

  const perp = review?.preview.value.perpetual ?? null;
  const total = review ? totalToCommit(review.preview.value) : null;
  return (
    <section className="dk-panel form-stack" aria-label={t('Ticket')} data-testid="venue-ticket">
      <h2 className="dk-tab-title">{t('Ticket')}</h2>
      <Tabs
        items={['buy', 'sell']}
        value={side}
        onChange={(s) => setSide(s as 'buy' | 'sell')}
        label={t('Ticket')}
        labels={{ buy: t('Long'), sell: t('Short') }}
      />
      <div role="group" aria-label={t('Order types')} data-testid="venue-order-types">
        {offered.map((x) => (
          <Button key={x} variant={type === x ? 'primary' : 'secondary'} aria-pressed={type === x} onClick={() => setType(x)}>
            {word(v, 'type', x)}
          </Button>
        ))}
        {RESTING_TYPES.filter((x) => !market.orderTypes.includes(x)).map((x) => (
          <Button key={x} variant="secondary" disabled aria-disabled="true" data-not-offered={x}>
            {word(v, 'type', x)}: {v('Not offered')}
          </Button>
        ))}
      </div>
      <label className="field">
        <span>{t('Size', { asset: market.baseAsset })}</span>
        <input
          inputMode="decimal"
          aria-label={t('Size', { asset: market.baseAsset })}
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
      </label>
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
        <span>{t('Margin asset')}</span>
        <select aria-label={t('Margin asset')} value={marginAsset} onChange={(e) => setMarginAsset(e.target.value)}>
          {assets.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <Button disabled={disabled} onClick={() => void openReview()}>
        {side === 'buy' ? t('Review long') : t('Review short')}
      </Button>
      {problem ? (
        <p className="failure" role="alert">
          {problem}
        </p>
      ) : null}
      <OutcomeLine result={review ? null : last} owner={owner} />
      {review ? (
        <ReviewDialog
          title={t('Review open', { side: side === 'buy' ? t('Long').toLowerCase() : t('Short').toLowerCase() })}
          preview={review.preview}
          intent={review.intent}
          status={status}
          account={account}
          owner={owner}
          run={run}
          confirmLabel={side === 'buy' ? t('Open long') : t('Open short')}
          result={result}
          onConfirm={() => void confirm()}
          onClose={() => {
            setReview(null);
            setResult(null);
          }}
          extra={
            perp ? (
              <>
                <div>
                  <dt>{t('Initial margin')}</dt>
                  <dd className="numeric" data-line="initial-margin">
                    <Known value={perp.initialMargin} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Liquidation price')}</dt>
                  <dd className="numeric" data-line="liquidation">
                    <Known value={perp.liquidationPrice} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Leverage and mode')}</dt>
                  <dd data-line="leverage">
                    {t('Leverage value', { times: String(leverageTimes(perp.leverageBps)), mode: t(`mode_${perp.marginMode}`) })}
                  </dd>
                </div>
                <div>
                  <dt>{t('Total to commit')}</dt>
                  <dd className="numeric" data-line="total">
                    <Known value={total === null ? { known: false } : { known: true, value: total }} /> {market.quoteAsset}
                  </dd>
                </div>
              </>
            ) : null
          }
        />
      ) : null}
    </section>
  );
}

/** Initial margin plus the venue's fee plus our builder fee, all the venue's figures in the settle asset; null when any is not known. */
export function totalToCommit(p: VenuePreview): string | null {
  const perp = p.perpetual;
  if (!perp || !perp.initialMargin.known || !p.venueFee.known || !p.builderFee.known) return null;
  if (p.venueFee.value.asset !== p.lock.asset || p.builderFee.value.asset !== p.lock.asset) return null;
  return sumDecimals([perp.initialMargin.value, p.venueFee.value.amount, p.builderFee.value.amount]);
}

/** A close's worst price: CLOSE_SLIPPAGE_PERCENT from the mark, on the tick, against the position. */
export function closeWorstPrice(position: VenuePosition, tick: string): string {
  const mark = parseAmount(position.markPrice);
  const step = parseAmount(tick);
  const raw = position.side === 'long' ? (mark * (100n - CLOSE_SLIPPAGE_PERCENT)) / 100n : (mark * (100n + CLOSE_SLIPPAGE_PERCENT)) / 100n;
  const onTick = step > 0n ? (position.side === 'long' ? (raw / step) * step : ((raw + step - 1n) / step) * step) : raw;
  return formatAmount(onTick);
}

function Blotter({
  status,
  market,
  owner,
  account,
  run,
}: {
  status: VenueUp;
  market: VenueMarket;
  owner: string;
  account: VenueAccount;
  run: RunAction;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions');
  const keysHeld = useMemo(() => heldKeys(owner), [owner]);
  const [cancelResult, setCancelResult] = useState<ActionResult | null>(null);
  const positions = account.positions.data;
  return (
    <section className="dk-panel" data-testid="venue-blotter">
      <Tabs
        items={['positions', 'orders', 'history']}
        value={tab}
        onChange={(x) => setTab(x as typeof tab)}
        label={t('Positions')}
        labels={{ positions: t('Positions'), orders: t('Orders'), history: t('History') }}
      />
      {tab === 'positions' ? (
        <PositionsTable positions={positions} market={market} owner={owner} run={run} test={status.test} onDone={account.reload} />
      ) : tab === 'orders' ? (
        <>
          <OrdersTable
            orders={account.openOrders.data}
            test={status.test}
            cancelled={[]}
            onCancel={(o) => {
              const key = o.venueClientOrderId ? keysHeld.get(o.venueClientOrderId) : undefined;
              if (key)
                void run({ kind: 'cancel_order', symbol: o.symbol, clientOrderKey: key }).then(
                  (r) => (setCancelResult(r), account.reload()),
                );
            }}
          />
          <OutcomeLine result={cancelResult} owner={owner} />
        </>
      ) : (
        <History fills={account.fills.data} test={status.test} />
      )}
    </section>
  );
}

function PositionsTable({
  positions,
  market,
  owner,
  run,
  test,
  onDone,
}: {
  positions: AsOf<VenuePosition[]> | null;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  test: boolean;
  onDone: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const rows = positions?.value ?? [];
  return (
    <div data-testid="venue-positions">
      <TestMark test={test} />
      {rows.length === 0 ? (
        <p className="muted">{t('No positions')}</p>
      ) : (
        <DataTable
          label={t('Positions')}
          headers={[
            v('Market'),
            v('Side'),
            t('Size', { asset: market.baseAsset }),
            t('Entry'),
            t('Mark'),
            t('Unrealised'),
            t('Margin'),
            t('Leverage'),
            t('Liquidation price'),
            '',
          ]}
        >
          {rows.map((p) => (
            <tr key={p.symbol} data-symbol={p.symbol}>
              <td>{p.symbol}</td>
              <td>{word(v, 'side', p.side)}</td>
              <td className="numeric" data-cell="size">
                {p.size}
              </td>
              <td className="numeric" data-cell="entry">
                {p.entryPrice}
              </td>
              <td className="numeric" data-cell="mark">
                {p.markPrice}
              </td>
              <td className="numeric" data-cell="unrealised">
                {p.unrealisedPnl}
              </td>
              <td className="numeric" data-cell="margin">
                {p.margin}
              </td>
              <td className="numeric" data-cell="leverage">
                {`${leverageTimes(p.leverageBps)}x ${t(`mode_${p.marginMode}`)}`}
              </td>
              <td className="numeric" data-cell="liquidation">
                <Known value={p.liquidationPrice} render={(x) => x} />
              </td>
              <td>
                <CloseControl position={p} market={market} owner={owner} run={run} onDone={onDone} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <AsOfLine asOf={positions?.asOf ?? null} />
    </div>
  );
}

/**
 * Close part of a position: one reduce-only order at the market with its own close id. The id is held until the venue
 * answers definitely, so a double press or a lost answer is the same close, sent once: an answer that is not definite is
 * read back by its client id and Close waits for it. After a definite answer (filled, or a refused or cancelled IOC) the
 * next press is a new close with a new id.
 */
function CloseControl({
  position,
  market,
  owner,
  run,
  onDone,
}: {
  position: VenuePosition;
  market: VenueMarket;
  owner: string;
  run: RunAction;
  onDone: () => void;
}) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const [percent, setPercent] = useState('40');
  const [result, setResult] = useState<{ amount: string; result: ActionResult } | null>(null);
  const draft = useRef<{ percent: string; size: string; id: string } | null>(null);
  // The client id of a not-definite close the venue's own record has since settled.
  const [settledId, setSettledId] = useState<string | null>(null);
  const read = result?.result.kind === 'unknown' ? result.result : null;
  const unknown = read && read.clientOrderId !== settledId ? read : null;

  async function close() {
    if (unknown) return;
    const p = Number(percent);
    if (!Number.isInteger(p) || p < 1 || p > 100) return;
    // One close id per (percent, size) until a definite answer: a second press is the same close.
    if (!draft.current || draft.current.percent !== percent || draft.current.size !== position.size)
      draft.current = { percent, size: position.size, id: draftId() };
    const amount = p === 100 ? position.size : partOf(position.size, p, market.lotSize);
    const answer = await run({
      kind: 'place_order',
      symbol: position.symbol,
      side: position.side === 'long' ? 'sell' : 'buy',
      type: market.orderTypes.includes('market') ? 'market' : 'limit',
      amount,
      price: closeWorstPrice(position, market.tickSize),
      timeInForce: 'IOC',
      reduceOnly: true,
      clientOrderKey: keys.close(owner, position.symbol, draft.current.id),
      builderFee: null,
    });
    if (!keepsDraft(answer)) draft.current = null;
    setResult({ amount, result: answer });
    onDone();
  }

  return (
    <div className="form-stack" data-testid="venue-close">
      <label className="field">
        <span>{t('Close percent', { symbol: position.symbol })}</span>
        <input
          inputMode="numeric"
          aria-label={t('Close percent', { symbol: position.symbol })}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </label>
      <Button disabled={unknown !== null} onClick={() => void close()}>
        {t('Close button', { percent })}
      </Button>
      {result ? (
        <p role="status" data-testid="venue-close-outcome">
          {t('Close sent', { amount: displayAmount(result.amount), asset: market.baseAsset, outcome: outcomeText(v, result.result) })}
        </p>
      ) : null}
      {read?.clientOrderId ? (
        <ReadBack
          owner={owner}
          clientOrderId={read.clientOrderId}
          onSettled={() => {
            if (settledId === read.clientOrderId) return;
            // The venue's own record settled the close: the next press is a new close.
            draft.current = null;
            setSettledId(read.clientOrderId);
            onDone();
          }}
        />
      ) : null}
    </div>
  );
}

/** History: the closed positions' realised result and fees, summed from the venue's fills, then every fill. */
function History({ fills, test }: { fills: AsOf<VenueFill[]> | null; test: boolean }) {
  const { t } = futuresVenueCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const closing = (fills?.value ?? []).filter((f) => f.realisedPnl !== null);
  const bySymbol = new Map<string, VenueFill[]>();
  for (const f of fills?.value ?? [])
    if (closing.some((c) => c.symbol === f.symbol)) bySymbol.set(f.symbol, [...(bySymbol.get(f.symbol) ?? []), f]);
  return (
    <div data-testid="venue-history">
      {bySymbol.size > 0 ? (
        <DataTable label={t('Closed positions')} headers={[v('Market'), v('Realised result'), v('Venue fee'), v('Our builder fee')]}>
          {[...bySymbol.entries()].map(([symbol, list]) => (
            <tr key={symbol} data-closed={symbol}>
              <td>{symbol}</td>
              <td className="numeric" data-cell="realised">
                {sumSigned(list.filter((f) => f.realisedPnl !== null).map((f) => f.realisedPnl!))}
              </td>
              <td className="numeric" data-cell="venue-fees">
                {sumSigned(list.map((f) => f.venueFee))}
              </td>
              <td className="numeric" data-cell="builder-fees">
                {sumDecimals(list.map((f) => f.builderFee))}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : null}
      <FillsTable fills={fills} test={test} />
    </div>
  );
}

const sumSigned = (values: string[]) => formatAmount(values.reduce((total, x) => total + parseAmount(x), 0n));
