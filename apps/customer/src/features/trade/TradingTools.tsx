import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { positionSchema, type Position } from '@intafaced/exchange-contract/schemas';
import { useSession } from '../session/session';
import { Button, DataTable, Dialog, EmptyState, Failure, Field, Loading, Page, Tabs } from '../../shared/ui';
import { useResource } from '../../shared/resource';
import { decimalSchema, displayAmount, parseAmount, formatAmount } from '../../shared/money';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Listing, TradeApi } from './trade-api';
import { createToolApi, copyFollowSchema, type ToolApi } from './tool-api';
import { MarketChart } from './Chart';

function State<T>({
  value,
  children,
  retry,
}: {
  value: ReturnType<typeof useResource<T>>;
  children: (data: T) => ReactNode;
  retry?: () => void;
}) {
  return value.resource.status === 'loading' ? (
    <Loading />
  ) : value.resource.status === 'failed' ? (
    <Failure result={value.resource.failure} retry={retry ?? value.reload} />
  ) : (
    children(value.resource.data)
  );
}
const markerSchema = z.object({
  kind: z.string(),
  id: z.string(),
  symbol: z.string(),
  operation: z.string().optional(),
  startedAt: z.number(),
});
type Marker = z.infer<typeof markerSchema>;
function readMarker(key: string) {
  try {
    const wire = localStorage.getItem(key);
    if (!wire) return { pending: null, blocked: false, available: true };
    const parsed = markerSchema.safeParse(JSON.parse(wire));
    return { pending: parsed.success ? parsed.data : null, blocked: true, available: true };
  } catch {
    return { pending: null, blocked: true, available: false };
  }
}
function useWriteGuard() {
  const { userId, session } = useSession(),
    key = `trade-pending:${userId ?? 'signed-out'}`,
    initial = readMarker(key);
  const [busy, setBusy] = useState(false),
    [locked, setLocked] = useState(initial.blocked),
    [pending, setPending] = useState<Marker | null>(initial.pending),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(
      initial.available
        ? null
        : { ok: false, reason: 'error', message: 'Device storage is unavailable. Trading cannot preserve a request identity.' },
    ),
    [message, setMessage] = useState(''),
    ref = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      const stored = readMarker(key);
      setLocked(stored.blocked);
      setPending(stored.pending);
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('trade-pending-change', refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('storage', refresh);
      window.removeEventListener('trade-pending-change', refresh);
    };
  }, [key]);
  function resolve(id: string, expected: Marker | null = pending) {
    const stored = readMarker(key);
    if (
      !stored.available ||
      !expected ||
      stored.pending?.id !== id ||
      stored.pending.kind !== expected.kind ||
      stored.pending.startedAt !== expected.startedAt ||
      stored.pending.operation !== expected.operation
    ) {
      setLocked(stored.blocked);
      setPending(stored.pending);
      return false;
    }
    try {
      localStorage.removeItem(key);
      window.dispatchEvent(new Event('trade-pending-change'));
      setLocked(false);
      setPending(null);
      return true;
    } catch {
      setLocked(true);
      setFailure({
        ok: false,
        reason: 'error',
        message: 'The outcome is confirmed, but its device marker could not be cleared. Storage access must return before another action.',
      });
      return false;
    }
  }
  async function run<T>(
    identity: { kind: 'convert' | 'rfq' | 'position' | 'algo' | 'copy'; id: string; symbol: string; operation?: string },
    call: () => Promise<ApiResult<T>>,
    done: (data: T) => void,
  ) {
    const stored = readMarker(key);
    if (!mounted.current || !session || ref.current || stored.blocked) {
      setLocked(stored.blocked);
      setPending(stored.pending);
      return;
    }
    if (!navigator.locks) {
      setFailure({
        ok: false,
        reason: 'error',
        message: 'This browser cannot coordinate trading requests across tabs. Use a browser with Web Locks.',
      });
      return;
    }
    ref.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await navigator.locks.request(`trade-account:${userId ?? 'signed-out'}`, { ifAvailable: true }, async (lock) => {
        if (!mounted.current || !lock || readMarker(key).blocked) {
          setMessage('Another trading request is active.');
          return;
        }
        const marker = { ...identity, startedAt: Date.now() };
        try {
          localStorage.setItem(key, JSON.stringify(marker));
          window.dispatchEvent(new Event('trade-pending-change'));
          setPending(marker);
        } catch {
          setFailure({
            ok: false,
            reason: 'error',
            message: 'The browser cannot preserve this request identity. Enable device storage before submitting.',
          });
          return;
        }
        const result = await call();
        if (result.ok) {
          done(result.data);
          resolve(identity.id, marker);
        } else {
          setFailure(result);
          if (result.reason === 'uncertain') {
            setLocked(true);
            setMessage(`Outcome unknown. Preserve request ${identity.id}; check its authoritative status before another trading action.`);
          } else resolve(identity.id, marker);
        }
      });
    } catch {
      setLocked(true);
      setFailure({
        ok: false,
        reason: 'uncertain',
        message: 'The request ended without a verified outcome. Preserve the original request identity and check its status.',
      });
    } finally {
      setBusy(false);
      ref.current = false;
    }
  }
  return { busy, locked, pending, failure, message, run, resolve, setMessage, setFailure, authenticated: Boolean(session) };
}
function GuardResult({ guard }: { guard: ReturnType<typeof useWriteGuard> }) {
  return (
    <>
      {guard.failure && <Failure result={guard.failure} />}{' '}
      {guard.message && (
        <p role="status" className="trade-note">
          {guard.message}
        </p>
      )}
      {guard.locked && (
        <p className="trade-refusal" role="alert">
          A previous trade request is unresolved. New actions stay locked.{' '}
          {guard.pending && (
            <span>
              {' '}
              {guard.pending.kind} · {guard.pending.symbol} · Request {guard.pending.id}.{' '}
            </span>
          )}{' '}
          <a href="/support" className="text-link">
            Contact support with the original request ID.
          </a>
        </p>
      )}
    </>
  );
}
export function TradingTools({
  api,
  transport,
  mode,
  markets,
  simulation,
}: {
  api: TradeApi;
  transport: ApiClient;
  mode: string;
  markets: Listing[];
  simulation: boolean;
}) {
  const tools = useMemo(() => createToolApi(transport), [transport]);
  return (
    <Page
      eyebrow={`${simulation ? 'Simulated' : 'Personal'} · Trade`}
      title={mode}
      description={descriptions[mode]}
      actions={
        <a className="text-link" href="/exchange">
          Back to spot desk ↗
        </a>
      }
    >
      <div className="trade-tools">
        {mode === 'Convert' ? (
          <Convert tools={tools} markets={markets} simulation={simulation} />
        ) : mode === 'Quote desk' ? (
          <QuoteDesk tools={tools} markets={markets} simulation={simulation} />
        ) : mode === 'Futures' ? (
          <Futures api={api} tools={tools} transport={transport} markets={markets} simulation={simulation} />
        ) : mode === 'Copy' ? (
          <Copy tools={tools} transport={transport} simulation={simulation} />
        ) : mode === 'Bots' ? (
          <Bots tools={tools} simulation={simulation} />
        ) : mode === 'Execution' ? (
          <Execution tools={tools} />
        ) : mode === 'Options' ? (
          <Options markets={markets} />
        ) : (
          <Margin />
        )}
      </div>
    </Page>
  );
}
const descriptions: Record<string, string> = {
  Convert: 'Review a firm book-sourced quote, with exact assets and expiry.',
  Margin: 'Borrowing and collateral belong to the trading account.',
  Futures: 'Accepted marks, isolated margin, risk review, and your actual positions.',
  Options: 'Calls and puts share a strike ladder when contract terms are published.',
  Copy: 'Explicit leader permissions and risk limits. Existing exposure stays visible.',
  Bots: 'Scheduled execution progress and control, linked to its child orders.',
  Execution: 'Cross-venue routing, execution, and operational control.',
  'Quote desk': 'Request a firm price from the desk, then review its named counterparty.',
};
function PairField({ markets, symbol, onChange }: { markets: Listing[]; symbol: string; onChange: (symbol: string) => void }) {
  return (
    <label className="field">
      Market
      <select value={symbol} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose published market</option>
        {markets.map((market) => (
          <option value={market.symbol} key={market.id}>
            {market.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}
function Convert({ tools, markets, simulation }: { tools: ToolApi; markets: Listing[]; simulation: boolean }) {
  const asset = new URLSearchParams(location.search).get('asset');
  const [symbol, setSymbol] = useState(markets.find((row) => row.base === asset)?.symbol ?? ''),
    [side, setSide] = useState<'buy' | 'sell'>('buy'),
    [qty, setQty] = useState(''),
    [quote, setQuote] = useState<z.infer<typeof import('./tool-api').convertQuoteSchema> | null>(null),
    [loading, setLoading] = useState(false),
    [clock, setClock] = useState(Date.now());
  const guard = useWriteGuard();
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const requestIdentity = useRef('');
  requestIdentity.current = JSON.stringify({ symbol, side, qty });
  async function request() {
    const identity = requestIdentity.current;
    if (!symbol || !positive(qty)) return;
    setLoading(true);
    const result = await tools.convertQuote({ symbol, side, qty });
    if (identity !== requestIdentity.current) {
      setLoading(false);
      return;
    }
    if (
      result.ok &&
      result.data.symbol === symbol &&
      result.data.side === side &&
      parseAmount(result.data.requestedQty) === parseAmount(qty)
    )
      setQuote(result.data);
    else
      guard.setFailure(
        result.ok ? { ok: false, reason: 'invalid_response', message: 'This quote does not match the requested conversion.' } : result,
      );
    setLoading(false);
  }
  useEffect(() => {
    if (asset && !symbol) {
      const matched = markets.find((row) => row.base === asset);
      if (matched) setSymbol(matched.symbol);
    }
  }, [markets, asset]);
  const expired = quote ? Date.parse(quote.expiresAt) <= clock : true;
  if (simulation)
    return (
      <Capability
        title="Simulated convert is unavailable"
        detail="The convert contract settles against house inventory through the ledger. It does not publish a simulated settlement route; simulated markets cannot enter this form."
      />
    );
  return (
    <>
      <div className="trade-tool-form">
        <PairField
          markets={markets}
          symbol={symbol}
          onChange={(value) => {
            setSymbol(value);
            setQuote(null);
          }}
        />
        <label className="field">
          Direction
          <select
            value={side}
            onChange={(event) => {
              setSide(event.target.value as typeof side);
              setQuote(null);
            }}
          >
            <option value="buy">Buy base asset</option>
            <option value="sell">Sell base asset</option>
          </select>
        </label>
        <Field
          label={`Base quantity (${symbol.split('/')[0] ?? 'asset'})`}
          inputMode="decimal"
          value={qty}
          onChange={(event) => {
            setQty(event.target.value);
            setQuote(null);
          }}
        />
        <Button disabled={!guard.authenticated || guard.locked || loading || !symbol || !positive(qty)} onClick={request}>
          {loading ? 'Requesting quote…' : 'Get firm quote'}
        </Button>
        {quote && (
          <>
            <dl className="trade-review">
              <div>
                <dt>You pay</dt>
                <dd>
                  {displayAmount(quote.inAmount)} {quote.inAsset}
                </dd>
              </div>
              <div>
                <dt>You receive</dt>
                <dd>
                  {displayAmount(quote.outAmount)} {quote.outAsset}
                </dd>
              </div>
              <div>
                <dt>Quote spread</dt>
                <dd>{quote.convertSpreadBps} bps · included</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{new Date(quote.expiresAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {quote.source.symbol} · {new Date(quote.source.asOf).toLocaleTimeString()}
                </dd>
              </div>
            </dl>
            <Button
              disabled={expired || !quote.fullyFilled || guard.busy || guard.locked}
              onClick={() => {
                const id = `convert:${crypto.randomUUID()}`;
                void guard.run(
                  { kind: 'convert', symbol, id },
                  () => tools.convertAccept(quote.quoteId, id),
                  (data) => {
                    guard.setMessage(
                      `Converted ${data.inAmount} ${data.inAsset} into ${data.outAmount} ${data.outAsset}. Fill ${data.fillId}.`,
                    );
                    setQuote(null);
                  },
                );
              }}
            >
              {expired ? 'Quote expired — request a new quote' : 'Confirm conversion'}
            </Button>
            {!quote.fullyFilled && (
              <p className="trade-refusal">Available depth cannot fill the requested quantity. Request a smaller amount.</p>
            )}
          </>
        )}
        <GuardResult guard={guard} />
      </div>
      <Capability
        title="One ledger, exact settlement"
        detail="A firm quote includes the house spread in the amounts you review. Accept uses its quote ID and a durable conversion identity. Missing inventory, spread authority, price, or expiry refuses the conversion."
      />
    </>
  );
}
function QuoteDesk({ tools, markets, simulation }: { tools: ToolApi; markets: Listing[]; simulation: boolean }) {
  const status = useResource((signal) => tools.otcStatus(signal), 'quote-desk');
  const linkedQuoteId = new URLSearchParams(location.search).get('quoteId') ?? '';
  const [existingId, setExistingId] = useState(linkedQuoteId);
  const lookupIdentity = useRef('');
  const [symbol, setSymbol] = useState(''),
    [side, setSide] = useState<'buy' | 'sell'>('buy'),
    [qty, setQty] = useState(''),
    [makerId, setMaker] = useState(''),
    [quote, setQuote] = useState<z.infer<typeof import('./tool-api').otcQuoteSchema> | null>(null),
    [bound, setBound] = useState(false),
    [loading, setLoading] = useState(false);
  const guard = useWriteGuard();
  async function lookup(id: string) {
    if (!id || simulation) return;
    lookupIdentity.current = id;
    setLoading(true);
    const result = await tools.otcGet(id);
    if (lookupIdentity.current !== id) return;
    setLoading(false);
    if (!result.ok) {
      guard.setFailure(result);
      return;
    }
    if (result.data.quoteId !== id) {
      guard.setFailure({ ok: false, reason: 'invalid_response', message: 'The returned quote belongs to a different request.' });
      return;
    }
    setQuote(result.data);
    setSymbol(`${result.data.baseAsset}/${result.data.quoteAsset}`);
    setSide(result.data.side);
    setQty(result.data.qty);
    setBound(result.data.lifecycle === 'bound');
  }
  useEffect(() => {
    if (linkedQuoteId && !simulation) {
      setExistingId(linkedQuoteId);
      void lookup(linkedQuoteId);
    }
  }, [linkedQuoteId, simulation]);
  const requestIdentity = useRef('');
  requestIdentity.current = JSON.stringify({ symbol, side, qty });
  async function request() {
    const identity = requestIdentity.current;
    setLoading(true);
    const [baseAsset = '', quoteAsset = ''] = symbol.split('/');
    const result = await tools.otcQuote({ side, baseAsset, quoteAsset, qty, ...(makerId ? { makerId } : {}) });
    if (identity !== requestIdentity.current) {
      setLoading(false);
      return;
    }
    if (
      result.ok &&
      result.data.baseAsset === baseAsset &&
      result.data.quoteAsset === quoteAsset &&
      parseAmount(result.data.qty) === parseAmount(qty)
    ) {
      setQuote(result.data);
      setBound(false);
    } else
      guard.setFailure(
        result.ok
          ? { ok: false, reason: 'invalid_response', message: 'The desk quote does not match the requested assets and quantity.' }
          : result,
      );
    setLoading(false);
  }
  async function reconcileQuote() {
    const original = guard.pending;
    if (!original || original.kind !== 'rfq') return;
    const result = await tools.otcGet(original.id);
    if (!result.ok) {
      guard.setFailure(result);
      return;
    }
    const data = result.data;
    setQuote(data);
    setSymbol(`${data.baseAsset}/${data.quoteAsset}`);
    setSide(data.side);
    setQty(data.qty);
    setBound(data.lifecycle === 'bound');
    if (data.lifecycle === 'settled' || data.lifecycle === 'expired' || (data.lifecycle === 'bound' && original.operation === 'accept')) {
      guard.resolve(original.id);
      guard.setMessage(`Original quote ${original.id}: ${data.lifecycle}.`);
    } else
      guard.setMessage(
        `Original quote ${original.id}: ${data.lifecycle ?? data.status}. Its ${original.operation ?? 'request'} outcome remains unresolved.`,
      );
  }
  return (
    <>
      {!simulation && (
        <div className="trade-tool-form">
          <Field label="Existing quote ID" value={existingId} onChange={(event) => setExistingId(event.target.value)} />
          <Button variant="secondary" disabled={!existingId || loading} onClick={() => void lookup(existingId)}>
            Open quoted order
          </Button>
        </div>
      )}
      <State value={status}>
        {(data) => (
          <Capability
            title={data.published ? 'Quote desk published' : 'Quote desk restricted'}
            detail={
              data.published
                ? 'Quotes require actual desk pricing, the named counterparty, and your account eligibility.'
                : (data.residual ?? 'Desk spread, stake eligibility, counterparty routing, or reference pricing authority is unpublished.')
            }
          />
        )}
      </State>
      {simulation ? (
        <Capability
          title="Simulated quote settlement is unavailable"
          detail="The RFQ contract has no isolated simulated settlement contract. No quote request is routed from simulation into a live desk."
        />
      ) : (
        <div className="trade-tool-form">
          <PairField
            markets={markets}
            symbol={symbol}
            onChange={(value) => {
              setSymbol(value);
              setQuote(null);
            }}
          />
          <label className="field">
            Side
            <select
              value={side}
              onChange={(event) => {
                setSide(event.target.value as typeof side);
                setQuote(null);
              }}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <Field
            label={`Base quantity (${symbol.split('/')[0] ?? 'asset'})`}
            value={qty}
            inputMode="decimal"
            onChange={(event) => {
              setQty(event.target.value);
              setQuote(null);
            }}
          />
          <Field label="Maker identity, if desk routing requires one" value={makerId} onChange={(event) => setMaker(event.target.value)} />
          <Button
            disabled={
              !guard.authenticated ||
              loading ||
              !symbol ||
              !positive(qty) ||
              status.resource.status !== 'ready' ||
              !status.resource.data.published
            }
            onClick={request}
          >
            Request desk price
          </Button>
          {quote && (
            <>
              <dl className="trade-review">
                <div>
                  <dt>Quantity</dt>
                  <dd>
                    {displayAmount(quote.qty)} {quote.baseAsset}
                  </dd>
                </div>
                <div>
                  <dt>Price</dt>
                  <dd>
                    {displayAmount(quote.quotedPrice)} {quote.quoteAsset}
                  </dd>
                </div>
                <div>
                  <dt>Value, spread included</dt>
                  <dd>
                    {displayAmount(quote.userNotional)} {quote.quoteAsset}
                  </dd>
                </div>
                <div>
                  <dt>Counterparty</dt>
                  <dd>
                    {quote.counterparty} · {quote.counterpartyId}
                  </dd>
                </div>
                <div>
                  <dt>Expiry</dt>
                  <dd>{new Date(quote.expiresAt).toLocaleString()}</dd>
                </div>
              </dl>
              <Button
                disabled={
                  guard.locked ||
                  guard.busy ||
                  quote.lifecycle === 'settled' ||
                  quote.lifecycle === 'expired' ||
                  (Date.parse(quote.expiresAt) <= Date.now() && !bound)
                }
                onClick={() =>
                  void guard.run(
                    { kind: 'rfq', id: quote.quoteId, symbol, operation: bound ? 'settle' : 'accept' },
                    () => (bound ? tools.otcSettle(quote.quoteId) : tools.otcAccept(quote.quoteId, quote.quotedPrice)),
                    (data) => {
                      if (bound) {
                        guard.setMessage(`Quote ${data.quoteId} settled at ${data.fillPrice} ${data.quoteAsset}.`);
                        setQuote(null);
                      } else {
                        setBound(true);
                        guard.setMessage('Quote accepted. Review the bound fill and settle it to complete the exchange.');
                      }
                    },
                  )
                }
              >
                {quote.lifecycle === 'settled'
                  ? 'Quote already settled'
                  : quote.lifecycle === 'expired'
                    ? 'Quote expired'
                    : bound
                      ? 'Settle accepted quote'
                      : 'Accept firm quote'}
              </Button>
            </>
          )}
          <GuardResult guard={guard} />
          {guard.pending?.kind === 'rfq' && (
            <Button variant="secondary" onClick={reconcileQuote}>
              Check original quote status
            </Button>
          )}
        </div>
      )}
      <Capability
        title="Counterparty and conversation"
        detail="The desk returns its counterparty identity with a quote. A customer counterparty verification and quote chat contract is not mounted in svc-trade; a quote ID does not provide permission to read a person’s identity or create a chat."
      />
    </>
  );
}
function Futures({
  api,
  tools,
  transport,
  markets,
  simulation,
}: {
  api: TradeApi;
  tools: ToolApi;
  transport: ApiClient;
  markets: Listing[];
  simulation: boolean;
}) {
  const { userId } = useSession();
  const positions = useResource((signal) => api.positions(undefined, signal), 'futures-positions'),
    disclosure = useResource((signal) => tools.disclosure(signal), 'futures-adl'),
    history = useResource((signal) => tools.positionHistory(signal), 'futures-position-history');
  const [positionTab, setPositionTab] = useState('Open positions');
  const [symbol, setSymbol] = useState(''),
    [side, setSide] = useState<'long' | 'short'>('long'),
    [size, setSize] = useState(''),
    [sizeUnit, setSizeUnit] = useState<'base' | 'contracts'>('base'),
    [leverage, setLeverage] = useState(''),
    [preview, setPreview] = useState<z.infer<typeof import('./tool-api').positionPreviewSchema> | null>(null),
    [selected, setSelected] = useState<Position | null>(null),
    [loading, setLoading] = useState(false);
  const guard = useWriteGuard();
  const simulationRef = useRef(simulation);
  const selectedMarket = markets.find((market) => market.symbol === symbol);
  const canSizeContracts = Boolean(
    selectedMarket?.linear === true &&
    selectedMarket.inverse !== true &&
    selectedMarket.contractSize &&
    parseAmount(selectedMarket.contractSize) > 0n,
  );
  let positionSize = size;
  if (sizeUnit === 'contracts') {
    try {
      positionSize =
        canSizeContracts && selectedMarket?.contractSize
          ? formatAmount((parseAmount(size) * parseAmount(selectedMarket.contractSize)) / parseAmount('1'))
          : '';
    } catch {
      positionSize = '';
    }
  }
  simulationRef.current = simulation;
  useEffect(() => {
    setPreview(null);
    setSelected(null);
  }, [simulation]);
  const requestIdentity = useRef('');
  requestIdentity.current = JSON.stringify({ symbol, side, size: positionSize, leverage, simulation });
  async function risk() {
    const identity = requestIdentity.current;
    setLoading(true);
    const result = await tools.positionPreview({ symbol, side, size: positionSize, leverage, marginMode: 'isolated' });
    if (identity !== requestIdentity.current) {
      setLoading(false);
      return;
    }
    if (
      result.ok &&
      result.data.symbol === symbol &&
      result.data.side === side &&
      parseAmount(result.data.size) === parseAmount(positionSize) &&
      parseAmount(result.data.leverage) === parseAmount(leverage)
    )
      setPreview(result.data);
    else
      guard.setFailure(
        result.ok ? { ok: false, reason: 'invalid_response', message: 'Risk preview belongs to a different position intent.' } : result,
      );
    setLoading(false);
  }
  if (simulation)
    return (
      <Capability
        title="Simulated derivative positions are unavailable"
        detail="The mounted position open, close, and history contracts do not publish a separate simulated account. This switch cannot display a live account as simulated or submit a ledger-funded position."
      />
    );
  return (
    <>
      <Capability
        title="Isolated position mode"
        detail="Cross margin and live margin-mode changes are unsupported. Reversing a position has no atomic reversal contract. A new position requires accepted mark, published leverage and liquidation policy, ADL acknowledgment, and a complete authoritative risk preview."
      />
      {selectedMarket && (
        <MarketChart
          key={`${symbol}:${userId ?? 'guest'}`}
          api={api}
          market={selectedMarket}
          orders={[]}
          positions={positions.resource.status === 'ready' ? positions.resource.data : []}
          accountKey={userId ?? 'signed-out'}
          onStagePrice={(price) =>
            guard.setMessage(
              `Inspected actual candle close ${price}. Position execution uses its accepted mark; chart selection does not set an execution price.`,
            )
          }
        />
      )}
      <p className="trade-note">
        Entry, accepted mark, and liquidation overlays use published position values. Stop placement, liquidation-risk modification, and
        atomic reversal are not mounted customer contracts; these lines do not imply those actions.
      </p>
      <div className="trade-tool-form">
        <PairField
          markets={markets}
          symbol={symbol}
          onChange={(value) => {
            setSymbol(value);
            setPreview(null);
            setSizeUnit('base');
            setSize('');
          }}
        />
        <label className="field">
          Direction
          <select
            value={side}
            onChange={(event) => {
              setSide(event.target.value as typeof side);
              setPreview(null);
            }}
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <Field
          label={
            sizeUnit === 'contracts'
              ? 'Position size (contracts)'
              : selectedMarket?.contractSize
                ? `Position size (${selectedMarket.base} quantity)`
                : 'Position size (base quantity; contract multiplier unpublished)'
          }
          hint={
            canSizeContracts && selectedMarket
              ? `Published linear multiplier ${selectedMarket.contractSize} ${selectedMarket.base} per contract. Risk review receives exact base quantity.`
              : 'Contract sizing needs a published linear base multiplier. An inverse or unspecified multiplier cannot be treated as base quantity.'
          }
          value={size}
          inputMode="decimal"
          onChange={(event) => {
            setSize(event.target.value);
            setPreview(null);
          }}
        />
        <label className="field">
          Position size units
          <select
            aria-label="Position size units"
            value={sizeUnit}
            onChange={(event) => {
              setSizeUnit(event.target.value as 'base' | 'contracts');
              setSize('');
              setPreview(null);
            }}
          >
            <option value="base">{selectedMarket?.base ?? 'Base'} quantity</option>
            <option value="contracts" disabled={!canSizeContracts}>
              Contracts
            </option>
          </select>
        </label>
        <Field
          label="Leverage (exact decimal)"
          value={leverage}
          inputMode="decimal"
          onChange={(event) => {
            setLeverage(event.target.value);
            setPreview(null);
          }}
        />
        <Button
          disabled={simulation || !guard.authenticated || loading || !symbol || !positive(positionSize) || !positive(leverage)}
          onClick={risk}
        >
          Review position risk
        </Button>
        {preview && (
          <>
            <dl className="trade-review">
              {[
                ['Accepted mark', preview.markPrice],
                ['Order value', preview.orderValue],
                ['Initial margin', preview.initialMargin],
                ['Estimated fee', preview.estimatedFee],
                ['Liquidation price', preview.liquidationPrice],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    {displayAmount(value)} {selectedMarket?.quote ?? ''}
                  </dd>
                </div>
              ))}
            </dl>
            {preview.refusals.map((row) => (
              <p className="trade-refusal" key={row.code}>
                {row.message}
              </p>
            ))}
            <Button
              disabled={
                simulation ||
                !preview.orderable ||
                preview.markPrice === null ||
                preview.orderValue === null ||
                preview.initialMargin === null ||
                preview.estimatedFee === null ||
                preview.liquidationPrice === null ||
                preview.leverageCap === null ||
                preview.refusals.length > 0 ||
                guard.busy ||
                guard.locked ||
                disclosure.resource.status !== 'ready' ||
                !disclosure.resource.data.acknowledged
              }
              onClick={async () => {
                if (simulationRef.current) return;
                const refreshed = await tools.positionPreview({ symbol, side, size: positionSize, leverage, marginMode: 'isolated' });
                if (simulationRef.current) return;
                if (!refreshed.ok) {
                  guard.setFailure(refreshed);
                  return;
                }
                if (JSON.stringify(refreshed.data) !== JSON.stringify(preview)) {
                  setPreview(refreshed.data);
                  guard.setMessage('Risk values changed. Review again.');
                  return;
                }
                const id = `position:${crypto.randomUUID()}`;
                void guard.run(
                  { kind: 'position', id, symbol },
                  () =>
                    simulationRef.current
                      ? Promise.resolve({
                          ok: false as const,
                          reason: 'not_supported' as const,
                          message: 'Simulated mode cannot open a live position.',
                        })
                      : transport.rest('/positions', positionSchema, {
                          method: 'POST',
                          body: { symbol, side, size: positionSize, leverage, marginMode: 'isolated', clientOpenId: id },
                        }),
                  (data) => {
                    guard.setMessage(`Position ${data.id}: ${data.status}.`);
                    positions.reload();
                    setPreview(null);
                  },
                );
              }}
            >
              Confirm position
            </Button>
          </>
        )}
        <State value={disclosure}>
          {(data) => (
            <>
              <p className="trade-note">{data.copy}</p>
              {!data.acknowledged && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void guard.run(
                      { kind: 'position', id: `adl:${data.version}`, symbol: 'ADL' },
                      () =>
                        transport.rest(
                          '/futures/adl-disclosure/ack',
                          z.object({ version: z.string(), copy: z.string(), acknowledged: z.boolean() }),
                          { method: 'POST', body: {} },
                        ),
                      () => disclosure.reload(),
                    )
                  }
                >
                  Acknowledge ADL disclosure
                </Button>
              )}
            </>
          )}
        </State>
        <GuardResult guard={guard} />
      </div>
      <section>
        <h2>Your positions</h2>
        <Tabs items={['Open positions', 'Position history']} value={positionTab} onChange={setPositionTab} label="Position records" />
        <State value={positionTab === 'Open positions' ? positions : history}>
          {(rows) =>
            rows.length ? (
              <DataTable
                label="Futures positions"
                headers={['Market / side', 'Size', 'Entry / mark', 'Margin', 'Liquidation', 'State', 'Action']}
              >
                {rows.map((row) => (
                  <tr key={row.id ?? row.symbol}>
                    <td>
                      {row.symbol} · {row.side}
                    </td>
                    <td>{displayAmount(row.contracts)} base</td>
                    <td>
                      {displayAmount(row.entryPrice)} / {displayAmount(row.markPrice)}
                    </td>
                    <td>{displayAmount(row.collateral)}</td>
                    <td>{displayAmount(row.liquidationPrice)}</td>
                    <td>
                      {row.status}
                      {row.closingReason && <small>{row.closingReason}</small>}
                    </td>
                    <td>
                      <button disabled={simulation || !row.id || guard.locked || row.status !== 'open'} onClick={() => setSelected(row)}>
                        Close position
                      </button>
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title={positionTab === 'Open positions' ? 'No open positions' : 'No closed positions in this page'} />
            )
          }
        </State>
        <p className="trade-note">Position history shows up to 100 service records; it is not a complete account history.</p>
      </section>
      {selected && (
        <Dialog title="Close futures position" onClose={() => setSelected(null)}>
          <p>
            {selected.symbol} · {selected.side} · {selected.contracts} base quantity. The server uses its accepted mark. If no usable mark
            exists, the position may remain closing.
          </p>
          <Button
            disabled={simulation || guard.busy || guard.locked}
            onClick={() => {
              if (simulationRef.current || !selected.id) return;
              void guard.run(
                { kind: 'position', id: selected.id, symbol: selected.symbol },
                () =>
                  simulationRef.current
                    ? Promise.resolve({
                        ok: false as const,
                        reason: 'not_supported' as const,
                        message: 'Simulated mode cannot close a live position.',
                      })
                    : tools.positionClose(selected.id as string),
                (data) => {
                  guard.setMessage(`Position ${data.id}: ${data.status}.`);
                  positions.reload();
                  setSelected(null);
                },
              );
            }}
          >
            Confirm close
          </Button>
        </Dialog>
      )}
    </>
  );
}
function Copy({ tools, transport, simulation }: { tools: ToolApi; transport: ApiClient; simulation: boolean }) {
  const status = useResource((signal) => tools.copyStatus(signal), 'copy-status'),
    follows = useResource((signal) => tools.copyFollows(signal), 'copy-follows');
  const [leader, setLeader] = useState(''),
    [region, setRegion] = useState(''),
    [market, setMarket] = useState(''),
    [orderLimit, setOrderLimit] = useState(''),
    [aggregate, setAggregate] = useState(''),
    [expiry, setExpiry] = useState(''),
    [confirm, setConfirm] = useState(false);
  const guard = useWriteGuard();
  if (simulation)
    return (
      <Capability
        title="Simulated copy permissions are unavailable"
        detail="Copy has no separate simulated permission list. This mode cannot create or alter a live follower grant."
      />
    );
  return (
    <>
      <State value={status}>
        {(data) => (
          <Capability
            title={data.feeSharePublished && data.jurisdictionPublished ? 'Copy permissions published' : 'Copy permission restricted'}
            detail={data.residual ?? data.statusLine}
          />
        )}
      </State>
      <div className="trade-tool-form">
        <Field
          label="Leader identity"
          value={leader}
          onChange={(event) => {
            setLeader(event.target.value);
            setConfirm(false);
          }}
        />
        <Field
          label="Account jurisdiction"
          value={region}
          onChange={(event) => {
            setRegion(event.target.value);
            setConfirm(false);
          }}
        />
        <Field
          label="Permitted market symbol"
          value={market}
          onChange={(event) => {
            setMarket(event.target.value);
            setConfirm(false);
          }}
        />
        <Field
          label="Maximum notional per order (quote units)"
          inputMode="decimal"
          value={orderLimit}
          onChange={(event) => {
            setOrderLimit(event.target.value);
            setConfirm(false);
          }}
        />
        <Field
          label="Maximum aggregate exposure (quote units)"
          inputMode="decimal"
          value={aggregate}
          onChange={(event) => {
            setAggregate(event.target.value);
            setConfirm(false);
          }}
        />
        <Field
          label="Permission expires"
          type="datetime-local"
          value={expiry}
          onChange={(event) => {
            setExpiry(event.target.value);
            setConfirm(false);
          }}
        />
        <Button
          disabled={
            simulation ||
            guard.locked ||
            guard.busy ||
            !guard.authenticated ||
            !leader ||
            !region ||
            !market ||
            !positive(orderLimit) ||
            !positive(aggregate) ||
            !expiry ||
            status.resource.status !== 'ready' ||
            !status.resource.data.feeSharePublished ||
            !status.resource.data.jurisdictionPublished
          }
          onClick={() => {
            if (!confirm) {
              setConfirm(true);
              return;
            }
            const id = `follow:${leader}:${Date.now()}`;
            void guard.run(
              { kind: 'copy', id, symbol: market },
              () =>
                transport.mutate(
                  'trade',
                  'copy.follow',
                  {
                    leaderId: leader,
                    region,
                    permittedMarkets: [market],
                    maxNotionalPerOrder: orderLimit,
                    maxAggregateExposure: aggregate,
                    expiresAt: new Date(expiry).toISOString(),
                  },
                  copyFollowSchema,
                ),
              (data) => {
                guard.setMessage(`Follow ${data.followId}: ${data.relationshipState}.`);
                follows.reload();
                setConfirm(false);
              },
            );
          }}
        >
          {confirm ? 'Confirm leader permission' : 'Review leader permission'}
        </Button>
        {confirm && (
          <p className="trade-note">
            Leader {leader} may mirror only {market}, up to {orderLimit} quote per order and {aggregate} aggregate, until {expiry}. Existing
            position exits remain your responsibility.
          </p>
        )}
        <GuardResult guard={guard} />
      </div>
      <section>
        <h2>Your follows</h2>
        <State value={follows}>
          {(rows) =>
            rows.length ? (
              <DataTable label="Copy follows" headers={['Leader', 'Markets', 'Current / remaining exposure', 'Permission', 'Controls']}>
                {rows.map((row) => (
                  <tr key={row.followId}>
                    <td>{row.leaderId}</td>
                    <td>{row.permittedMarkets.join(', ')}</td>
                    <td>
                      {displayAmount(row.currentExposure)} / {displayAmount(row.remainingExposure)}
                    </td>
                    <td>
                      {row.relationshipState} · {new Date(row.expiresAt).toLocaleDateString()}
                    </td>
                    <td>
                      <div className="trade-row-actions">
                        {(['pause', 'stop', 'detach', 'resume'] as const).map((action) => (
                          <button
                            key={action}
                            disabled={guard.locked || guard.busy}
                            onClick={() =>
                              void guard.run(
                                { kind: 'copy', id: row.followId, symbol: row.permittedMarkets.join(',') },
                                () => tools.copyAction(action, row.followId),
                                (data) => {
                                  guard.setMessage(`Follow ${data.followId}: ${data.relationshipState}. Existing positions are retained.`);
                                  follows.reload();
                                },
                              )
                            }
                          >
                            {action}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title="No copy permissions" />
            )
          }
        </State>
      </section>
      <Capability
        title="Limits follow your permission"
        detail="Leader rankings and profit-based fees are prohibited by the current copy policy. Pausing, stopping, or detaching fences new mirrors; it does not silently flatten existing positions. A simulated leader cannot place a live follower order."
      />
    </>
  );
}
function Bots({ tools, simulation }: { tools: ToolApi; simulation: boolean }) {
  const [id, setId] = useState(''),
    [active, setActive] = useState('');
  const parent = useResource(
      (signal) =>
        active
          ? tools.algoGet(active, signal)
          : Promise.resolve({
              ok: false as const,
              reason: 'not_supported' as const,
              message: 'Enter a schedule ID to read an existing execution schedule.',
            }),
      active,
    ),
    progress = useResource(
      (signal) =>
        active
          ? tools.algoProgress(active, signal)
          : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, message: 'Choose an existing schedule.' }),
      active,
    );
  const guard = useWriteGuard();
  if (simulation)
    return (
      <Capability
        title="Simulated schedules are unavailable"
        detail="The schedule query does not publish a simulation discriminator or separate simulated management list. This switch cannot open or alter a live schedule."
      />
    );
  return (
    <>
      <Capability
        title="TWAP, VWAP, and participation schedules"
        detail="Scheduled child orders use the existing matching engine and settle through the ledger. New schedule creation currently has no authoritative aggregate fee/reservation preview; the review requirement blocks starting a new money-moving schedule here. Existing schedules can still be inspected, paused, resumed, or stopped."
      />
      <div className="trade-tool-form">
        <Field label="Existing schedule ID" value={id} onChange={(event) => setId(event.target.value)} />
        <Button disabled={!id} onClick={() => setActive(id)}>
          Open schedule
        </Button>
        {active && (
          <>
            <State value={parent}>
              {(data) => (
                <>
                  <h3>
                    {data.symbol} · {data.kind.toUpperCase()}
                  </h3>
                  <dl className="trade-review">
                    <div>
                      <dt>Total base quantity</dt>
                      <dd>{displayAmount(data.totalQty)}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{data.status}</dd>
                    </div>
                    <div>
                      <dt>Children emitted</dt>
                      <dd>
                        {data.childrenEmitted} / {data.slicesPlanned}
                      </dd>
                    </div>
                    <div>
                      <dt>Projected end</dt>
                      <dd>{new Date(data.projectedEndsAt).toLocaleString()}</dd>
                    </div>
                  </dl>
                  <div className="actions">
                    {(['pause', 'resume', 'cancel'] as const).map((action) => (
                      <Button
                        key={action}
                        variant="secondary"
                        disabled={guard.locked || guard.busy}
                        onClick={() =>
                          void guard.run(
                            { kind: 'algo', id: data.id, symbol: data.symbol },
                            () => tools.algoAction(action, data.id),
                            (updated) => {
                              guard.setMessage(`Schedule ${updated.id}: ${updated.status}.`);
                              parent.reload();
                              progress.reload();
                            },
                          )
                        }
                      >
                        {action === 'cancel' ? 'Stop remaining slices' : action}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </State>
            <State value={progress}>
              {(data) => (
                <p>
                  Actual filled quantity: {displayAmount(data.filledQty)} / {displayAmount(data.totalQty)}. {data.haltReason ?? ''}
                </p>
              )}
            </State>
            <Button
              variant="ghost"
              onClick={() => {
                parent.reload();
                progress.reload();
              }}
            >
              Refresh schedule
            </Button>
          </>
        )}
        <GuardResult guard={guard} />
      </div>
      <Capability
        title="Grid and custom bots"
        detail="The mounted trade algo contract provides TWAP, VWAP, and participation schedules. A grid strategy catalogue, bot creation schema, and customer bot listing query are not mounted. No generic bot is sent through the spot ticket."
      />
    </>
  );
}
function Execution({ tools }: { tools: ToolApi }) {
  const spine = useResource((signal) => tools.executionSpine(signal), 'execution-spine');
  return (
    <>
      <Capability
        title="Cross-venue execution requires service authority"
        detail="OMS planning, routing, and execution are guarded by signed service authority. Customer authentication cannot submit these service writes. The mounted read surface is operator-scoped; no browser credentials are substituted for that authority."
      />
      <State value={spine}>
        {(data) => (
          <DataTable label="Execution capabilities" headers={['Tool', 'Operation', 'Execution source']}>
            {data.doors.map((door) => (
              <tr key={door.id}>
                <td>{door.module.replace('execution.', '')}</td>
                <td>{door.kind}</td>
                <td>{door.callerSubmit ? 'Requires an authorized venue submit port' : 'Planning or observation'}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </State>
      <div className="trade-capability-grid">
        {[
          ['Smart routing', 'Compare permitted external venues and route a parent execution.'],
          ['Arbitrage', 'Plan linked legs with the service’s risk and venue authority.'],
          ['Market making', 'Quote and hedge with explicitly published spread and capital policy.'],
        ].map(([title, detail]) => (
          <Capability key={title} title={title ?? ''} detail={detail ?? ''} />
        ))}
      </div>
      <a className="text-link" href="/quant/studio">
        Open Quant studio ↗
      </a>
    </>
  );
}
function Options({ markets }: { markets: Listing[] }) {
  return (
    <>
      <Capability
        title="Options chain requires complete contract terms"
        detail="Published option listings currently expose no option-chain surface. Strike, option right, settlement asset, contract size, and exercise policy cannot be inferred from a symbol. Options cannot submit through the spot preview path."
      />
      <DataTable label="Published options terms" headers={['Contract', 'Call / put', 'Strike', 'Expiry', 'Size / settlement', 'Status']}>
        {markets.map((market) => (
          <tr key={market.id}>
            <td>{market.symbol}</td>
            <td>{market.optionType ?? 'Unpublished'}</td>
            <td>{displayAmount(market.strike)}</td>
            <td>{market.expiryDatetime ? new Date(market.expiryDatetime).toLocaleString() : 'Unpublished'}</td>
            <td>
              {displayAmount(market.contractSize)} / {market.settle ?? 'Unpublished'}
            </td>
            <td>{market.orderable ? 'Published for admission' : 'Restricted'}</td>
          </tr>
        ))}
      </DataTable>
      {!markets.length && <EmptyState title="No option contracts are published" />}
      <p className="trade-note">
        When complete option terms are available, calls and puts can be joined by exact strike and expiry. No synthetic chain is drawn.
      </p>
    </>
  );
}
function Margin() {
  return (
    <>
      <Capability
        title="Spot margin borrowing is not connected"
        detail="The customer trade contracts do not mount spot borrow, repay, debt-interest, or collateral-risk preview. Leveraged futures positions use their own isolated margin path; that path cannot fund a margin spot order."
      />
      <div className="trade-capability-grid">
        <Capability
          title="Cross margin"
          detail="A shared collateral pool and liquidation-risk contract is missing. No collateral amount, interest rate, or borrowing limit can be displayed."
        />
        <Capability
          title="Isolated spot margin"
          detail="A per-market borrow and repayment contract is missing. Spot buys and sells continue to use your available base and quote funds."
        />
      </div>
      <div className="actions">
        <a className="text-link" href="/exchange">
          Trade fully funded spot ↗
        </a>
        <a className="text-link" href="/trade/futures">
          View isolated futures risk ↗
        </a>
      </div>
    </>
  );
}
function Capability({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="trade-capability">
      <h2>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}
function positive(value: string) {
  const result = decimalSchema.safeParse(value);
  return result.success && parseAmount(result.data) > 0n;
}
