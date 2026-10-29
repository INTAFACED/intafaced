import {
  TradeMessage,
  tradeRefusal,
  tradeCopy as copy,
  CopyText,
  tradeLabels,
  choiceNode,
  tradeDate,
  TradeFailure as Failure,
} from './copy';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { positionSchema, type Position } from '@intafaced/exchange-contract/schemas';
import { useSession } from '../session/session';
import { Button, DataTable, Dialog, EmptyState, Field, Loading, Page, Tabs } from '../../shared/ui';
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
  clientCloseId: z.string().optional(),
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
      initial.available ? null : tradeRefusal('deviceStorageIsUnavailableTradingCannotPreserveARequestIdentity', { reason: 'error' }),
    ),
    [message, setMessage] = useState<ReactNode>(''),
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
      setFailure(tradeRefusal('theOutcomeIsConfirmedButItsDeviceMarkerCouldNotBea566ab', { reason: 'error' }));
      return false;
    }
  }
  async function run<T>(
    identity: {
      kind: 'convert' | 'rfq' | 'position' | 'algo' | 'copy';
      id: string;
      symbol: string;
      operation?: string;
      clientCloseId?: string;
    },
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
      setFailure(tradeRefusal('thisBrowserCannotCoordinateTradingRequestsAcrossTabsUseABrowser29685f', { reason: 'error' }));
      return;
    }
    ref.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await navigator.locks.request(`trade-account:${userId ?? 'signed-out'}`, { ifAvailable: true }, async (lock) => {
        if (!mounted.current || !lock || readMarker(key).blocked) {
          setMessage(<CopyText k={'anotherTradingRequestIsActive'} />);
          return;
        }
        const marker = { ...identity, startedAt: Date.now() };
        try {
          localStorage.setItem(key, JSON.stringify(marker));
          window.dispatchEvent(new Event('trade-pending-change'));
          setPending(marker);
        } catch {
          setFailure(tradeRefusal('theBrowserCannotPreserveThisRequestIdentityEnableDeviceStorageBefore', { reason: 'error' }));
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
            setMessage(
              <CopyText
                k={'outcomeUnknownPreserveRequestCheckItsAuthoritativeStatusBeforeAnotherTrading'}
                params={{ identityId: String(identity.id) }}
              />,
            );
          } else resolve(identity.id, marker);
        }
      });
    } catch {
      setLocked(true);
      setFailure(tradeRefusal('theRequestEndedWithoutAVerifiedOutcomePreserveTheOriginalRequest', { reason: 'uncertain' }));
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
        <p role="status" className="trade-note" lang="und">
          {guard.message}
        </p>
      )}
      {guard.locked && (
        <p className="trade-refusal" role="alert">
          <CopyText k="aPreviousTradeRequestIsUnresolvedNewActionsStayLocked" />{' '}
          {guard.pending && (
            <span>
              {' '}
              {guard.pending.kind} · {guard.pending.symbol} <CopyText k="request" />
              {guard.pending.id}.{' '}
            </span>
          )}{' '}
          <a href="/support" className="text-link">
            <CopyText k="contactSupportWithTheOriginalRequestId" />
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
      eyebrow={
        <CopyText
          k={'trade345b46'}
          params={{ simulationCopyTSimulated31fe29: String(simulation ? copy.t('simulated31fe29') : copy.t('personal845f92')) }}
        />
      }
      title={choiceNode(mode)}
      description={descriptions[mode]}
      actions={
        <a className="text-link" href={`/exchange${simulation ? '?simulated=true' : ''}`}>
          <CopyText k="backToSpotDesk" />
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
        ) : mode === 'Execution' ? (
          <Execution tools={tools} simulation={simulation} />
        ) : mode === 'Options' ? (
          <Options markets={markets} />
        ) : (
          <Margin simulation={simulation} />
        )}
      </div>
    </Page>
  );
}
const descriptions: Record<string, ReactNode> = {
  Convert: <CopyText k="reviewAFirmBookSourcedQuoteWithExactAssetsAndExpiry" />,
  Margin: <CopyText k="borrowingAndCollateralBelongToTheTradingAccount" />,
  Futures: <CopyText k="acceptedMarksIsolatedMarginRiskReviewAndYourActualPositions" />,
  Options: <CopyText k="callsAndPutsShareAStrikeLadderWhenContractTermsAre" />,
  Execution: <CopyText k="crossVenueRoutingExecutionAndOperationalControl" />,
  'Quote desk': <CopyText k="requestAFirmPriceFromTheDeskThenReviewItsNamed" />,
};
function PairField({ markets, symbol, onChange }: { markets: Listing[]; symbol: string; onChange: (symbol: string) => void }) {
  return (
    <label className="field">
      <CopyText k="market4af4ec" />
      <select value={symbol} onChange={(event) => onChange(event.target.value)}>
        <option value="">{copy.t('choosePublishedMarket')}</option>
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
    else guard.setFailure(result.ok ? tradeRefusal('thisQuoteDoesNotMatchTheRequestedConversion', { reason: 'invalid_response' }) : result);
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
        title={<CopyText k={'simulatedConvertIsUnavailable'} />}
        detail={<CopyText k={'theConvertContractSettlesAgainstHouseInventoryThroughTheLedgerIt'} />}
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
          <CopyText k="direction" />
          <select
            value={side}
            onChange={(event) => {
              setSide(event.target.value as typeof side);
              setQuote(null);
            }}
          >
            <option value="buy">{copy.t('buyBaseAsset')}</option>
            <option value="sell">{copy.t('sellBaseAsset')}</option>
          </select>
        </label>
        <Field
          label={<BaseQuantityLabel symbol={symbol} />}
          inputMode="decimal"
          value={qty}
          onChange={(event) => {
            setQty(event.target.value);
            setQuote(null);
          }}
        />
        <Button disabled={!guard.authenticated || guard.locked || loading || !symbol || !positive(qty)} onClick={request}>
          {loading ? <CopyText k={'requestingQuote'} /> : <CopyText k={'getFirmQuote'} />}
        </Button>
        {quote && (
          <>
            <dl className="trade-review">
              <div>
                <dt>
                  <CopyText k="youPay" />
                </dt>
                <dd>
                  {displayAmount(quote.inAmount)} {quote.inAsset}
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="youReceive" />
                </dt>
                <dd>
                  {displayAmount(quote.outAmount)} {quote.outAsset}
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="quoteSpread" />
                </dt>
                <dd>
                  {quote.convertSpreadBps} <CopyText k="bpsIncluded" />
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="expires" />
                </dt>
                <dd>{tradeDate(quote.expiresAt)}</dd>
              </div>
              <div>
                <dt>
                  <CopyText k="source" />
                </dt>
                <dd>
                  <span lang="zxx">{quote.source.symbol}</span> · {tradeDate(quote.source.asOf, 'time')}
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
                      <CopyText
                        k={'convertedIntoFill'}
                        params={{
                          dataInAmount: String(data.inAmount),
                          dataInAsset: String(data.inAsset),
                          dataOutAmount: String(data.outAmount),
                          dataOutAsset: String(data.outAsset),
                          dataFillId: String(data.fillId),
                        }}
                      />,
                    );
                    setQuote(null);
                  },
                );
              }}
            >
              {expired ? <CopyText k={'quoteExpiredRequestANewQuote'} /> : <CopyText k={'confirmConversion'} />}
            </Button>
            {!quote.fullyFilled && (
              <p className="trade-refusal">
                <CopyText k="availableDepthCannotFillTheRequestedQuantityRequestASmallerAmount" />
              </p>
            )}
          </>
        )}
        <GuardResult guard={guard} />
      </div>
      <Capability
        title={<CopyText k={'oneLedgerExactSettlement'} />}
        detail={<CopyText k={'aFirmQuoteIncludesTheHouseSpreadInTheAmountsYou'} />}
      />
    </>
  );
}
/** "Base quantity (BTC)", or just "Base quantity" before a market is picked (never empty parentheses). */
function BaseQuantityLabel({ symbol }: { symbol: string }) {
  const base = symbol.split('/')[0] ?? '';
  return base ? <CopyText k={'baseQuantitye5704f'} params={{ symbolSplitAsset: base }} /> : <CopyText k={'baseQuantity'} />;
}
function QuoteDesk({ tools, markets, simulation }: { tools: ToolApi; markets: Listing[]; simulation: boolean }) {
  const status = useResource((signal) => tools.otcStatus(signal), 'quote-desk');
  const makers = useResource((signal) => tools.otcMakers(signal), 'quote-desk-providers');
  const linkedQuoteId = new URLSearchParams(location.search).get('quoteId') ?? '';
  const [existingId, setExistingId] = useState(linkedQuoteId);
  const lookupIdentity = useRef('');
  const [symbol, setSymbol] = useState(''),
    [side, setSide] = useState<'buy' | 'sell'>('buy'),
    [qty, setQty] = useState(''),
    [picked, setPicked] = useState<string[]>([]),
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
      guard.setFailure(tradeRefusal('theReturnedQuoteBelongsToADifferentRequest', { reason: 'invalid_response' }));
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
  requestIdentity.current = JSON.stringify({ symbol, side, qty, picked });
  async function request() {
    const identity = requestIdentity.current;
    setLoading(true);
    const [baseAsset = '', quoteAsset = ''] = symbol.split('/');
    // The desk asks only providers from the owner's list (CB-otc-01); a pick the list no longer holds is dropped here.
    const listed = makers.resource.status === 'ready' ? makers.resource.data.makers.map((m) => m.id) : [];
    const result = await tools.otcQuote({ side, baseAsset, quoteAsset, qty, makerIds: picked.filter((id) => listed.includes(id)) });
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
        result.ok ? tradeRefusal('theDeskQuoteDoesNotMatchTheRequestedAssetsAndQuantity', { reason: 'invalid_response' }) : result,
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
      guard.setMessage(
        <CopyText k={'originalQuote'} params={{ originalId: String(original.id), dataLifecycle: String(data.lifecycle) }} />,
      );
    } else
      guard.setMessage(
        <TradeMessage
          k={'originalQuoteItsOutcomeRemainsUnresolved'}
          params={() => ({
            originalId: String(original.id),
            dataLifecycleDataStatus: String(data.lifecycle ?? data.status),
            originalOperationRequest: String(original.operation ?? copy.t('genericRequest')),
          })}
        />,
      );
  }
  return (
    <>
      {!simulation && (
        <div className="trade-tool-form">
          <Field label={<CopyText k={'existingQuoteId'} />} value={existingId} onChange={(event) => setExistingId(event.target.value)} />
          <Button variant="secondary" disabled={!existingId || loading} onClick={() => void lookup(existingId)}>
            <CopyText k="openQuotedOrder" />
          </Button>
        </div>
      )}
      <State value={status}>
        {(data) => (
          <Capability
            title={data.published ? <CopyText k={'quoteDeskPublished'} /> : <CopyText k={'quoteDeskRestricted'} />}
            detail={
              data.published ? (
                <CopyText k={'quotesRequireActualDeskPricingTheNamedCounterpartyAndYourAccount'} />
              ) : (
                // `data.residual` is the service's internal wording (a DIRECTION section citation, refuse-closed);
                // customers get the plain sentence for the same reason: the desk law is not published.
                <CopyText k={'deskSpreadStakeEligibilityCounterpartyRoutingOrReferencePricingAuthorityIs'} />
              )
            }
          />
        )}
      </State>
      {simulation ? (
        <Capability
          title={<CopyText k={'simulatedQuoteSettlementIsUnavailable'} />}
          detail={<CopyText k={'theRfqContractHasNoIsolatedSimulatedSettlementContractNoQuote'} />}
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
            <CopyText k="side90eb04" />
            <select
              value={side}
              onChange={(event) => {
                setSide(event.target.value as typeof side);
                setQuote(null);
              }}
            >
              <option value="buy">{copy.t('buy')}</option>
              <option value="sell">{copy.t('sell')}</option>
            </select>
          </label>
          <Field
            label={<BaseQuantityLabel symbol={symbol} />}
            value={qty}
            inputMode="decimal"
            onChange={(event) => {
              setQty(event.target.value);
              setQuote(null);
            }}
          />
          <fieldset>
            <legend>
              <CopyText k={'otcProviders'} />
            </legend>
            <State value={makers}>
              {(list) =>
                list.published ? (
                  list.makers.map((m) => (
                    <label key={m.id}>
                      <input
                        type="checkbox"
                        checked={picked.includes(m.id)}
                        onChange={(event) => {
                          setPicked(event.target.checked ? [...new Set([...picked, m.id])] : picked.filter((id) => id !== m.id));
                          setQuote(null);
                        }}
                      />
                      {m.name}
                    </label>
                  ))
                ) : (
                  <CopyText k={'otcProvidersNotSet'} />
                )
              }
            </State>
          </fieldset>
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
            <CopyText k="requestDeskPrice" />
          </Button>
          {quote && (
            <>
              <dl className="trade-review">
                <div>
                  <dt>
                    <CopyText k="quantity822bab" />
                  </dt>
                  <dd>
                    {displayAmount(quote.qty)} {quote.baseAsset}
                  </dd>
                </div>
                <div>
                  <dt>
                    <CopyText k="price93c91c" />
                  </dt>
                  <dd>
                    {displayAmount(quote.quotedPrice)} {quote.quoteAsset}
                  </dd>
                </div>
                <div>
                  <dt>
                    <CopyText k="valueSpreadIncluded" />
                  </dt>
                  <dd>
                    {displayAmount(quote.userNotional)} {quote.quoteAsset}
                  </dd>
                </div>
                <div>
                  <dt>
                    <CopyText k="counterparty" />
                  </dt>
                  <dd>
                    <span lang="und">{quote.counterparty}</span> · <span lang="zxx">{quote.counterpartyId}</span>
                  </dd>
                </div>
                <div>
                  <dt>
                    <CopyText k="expiry" />
                  </dt>
                  <dd>{tradeDate(quote.expiresAt)}</dd>
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
                        guard.setMessage(
                          <CopyText
                            k={'quoteSettledAt'}
                            params={{
                              dataQuoteId: String(data.quoteId),
                              dataFillPrice: String(data.fillPrice),
                              dataQuoteAsset: String(data.quoteAsset),
                            }}
                          />,
                        );
                        setQuote(null);
                      } else {
                        setBound(true);
                        guard.setMessage(<CopyText k={'quoteAcceptedReviewTheBoundFillAndSettleItToComplete'} />);
                      }
                    },
                  )
                }
              >
                {quote.lifecycle === 'settled' ? (
                  <CopyText k={'quoteAlreadySettled'} />
                ) : quote.lifecycle === 'expired' ? (
                  <CopyText k={'quoteExpired'} />
                ) : bound ? (
                  <CopyText k={'settleAcceptedQuote'} />
                ) : (
                  <CopyText k={'acceptFirmQuote'} />
                )}
              </Button>
            </>
          )}
          <GuardResult guard={guard} />
          {guard.pending?.kind === 'rfq' && (
            <Button variant="secondary" onClick={reconcileQuote}>
              <CopyText k="checkOriginalQuoteStatus" />
            </Button>
          )}
        </div>
      )}
      <Capability
        title={<CopyText k={'counterpartyAndConversation'} />}
        detail={<CopyText k={'theDeskReturnsItsCounterpartyIdentityWithAQuoteACustomer'} />}
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
      guard.setFailure(result.ok ? tradeRefusal('riskPreviewBelongsToADifferentPositionIntent', { reason: 'invalid_response' }) : result);
    setLoading(false);
  }
  if (simulation)
    return (
      <Capability
        title={<CopyText k={'simulatedDerivativePositionsAreUnavailable'} />}
        detail={<CopyText k={'theMountedPositionOpenCloseAndHistoryContractsDoNotPublish'} />}
      />
    );
  return (
    <>
      <Capability
        title={<CopyText k={'isolatedPositionMode'} />}
        detail={<CopyText k={'crossMarginAndLiveMarginModeChangesAreUnsupportedReversingA'} />}
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
              <CopyText k={'inspectedActualCandleClosePositionExecutionUsesItsAcceptedMarkChart'} params={{ price: String(price) }} />,
            )
          }
        />
      )}
      <p className="trade-note">
        <CopyText k="entryAcceptedMarkAndLiquidationOverlaysUsePublishedPositionValuesStop" />
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
          <CopyText k="direction" />
          <select
            value={side}
            onChange={(event) => {
              setSide(event.target.value as typeof side);
              setPreview(null);
            }}
          >
            <option value="long">{copy.t('long')}</option>
            <option value="short">{copy.t('short')}</option>
          </select>
        </label>
        <Field
          label={
            sizeUnit === 'contracts' ? (
              <CopyText k={'positionSizeContracts'} />
            ) : selectedMarket?.contractSize ? (
              <CopyText k={'positionSizeQuantity'} params={{ selectedMarketBase: String(selectedMarket.base) }} />
            ) : (
              <CopyText k={'positionSizeBaseQuantityContractMultiplierUnpublished'} />
            )
          }
          hint={
            canSizeContracts && selectedMarket ? (
              <CopyText
                k={'publishedLinearMultiplierPerContractRiskReviewReceivesExactBaseQuantity'}
                params={{
                  selectedMarketContractSize: String(selectedMarket.contractSize),
                  selectedMarketBase: String(selectedMarket.base),
                }}
              />
            ) : (
              <CopyText k={'contractSizingNeedsAPublishedLinearBaseMultiplierAnInverseOr'} />
            )
          }
          value={size}
          inputMode="decimal"
          onChange={(event) => {
            setSize(event.target.value);
            setPreview(null);
          }}
        />
        <label className="field">
          <CopyText k="positionSizeUnits" />
          <select
            aria-label={copy.t('positionSizeUnits417a24')}
            value={sizeUnit}
            onChange={(event) => {
              setSizeUnit(event.target.value as 'base' | 'contracts');
              setSize('');
              setPreview(null);
            }}
          >
            <option value="base">
              {selectedMarket?.base ?? copy.t('base7b4736')} {copy.t('quantity')}
            </option>
            <option value="contracts" disabled={!canSizeContracts}>
              {copy.t('contractsee5741')}
            </option>
          </select>
        </label>
        <Field
          label={<CopyText k={'leverageExactDecimal'} />}
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
          <CopyText k="reviewPositionRisk" />
        </Button>
        {preview && (
          <>
            <dl className="trade-review">
              {(
                [
                  [<CopyText k={'acceptedMark'} />, preview.markPrice],
                  [<CopyText k={'orderValuefa10dc'} />, preview.orderValue],
                  [<CopyText k={'initialMargin'} />, preview.initialMargin],
                  [<CopyText k={'estimatedFee'} />, preview.estimatedFee],
                  [<CopyText k={'liquidationPrice'} />, preview.liquidationPrice],
                ] as const
              ).map(([label, value], index) => (
                <div key={index}>
                  <dt>{label}</dt>
                  <dd>
                    {displayAmount(value)} {selectedMarket?.quote ?? ''}
                  </dd>
                </div>
              ))}
            </dl>
            {preview.refusals.map((row) => (
              <p className="trade-refusal" key={row.code} lang="und">
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
                guard.locked
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
                  guard.setMessage(<CopyText k={'riskValuesChangedReviewAgain'} />);
                  return;
                }
                const id = `position:${crypto.randomUUID()}`;
                void guard.run(
                  { kind: 'position', id, symbol },
                  () =>
                    simulationRef.current
                      ? Promise.resolve(tradeRefusal('simulatedModeCannotOpenALivePosition', { reason: 'not_supported' as const }))
                      : transport.rest('/positions', positionSchema, {
                          method: 'POST',
                          body: { symbol, side, size: positionSize, leverage, marginMode: 'isolated', clientOpenId: id },
                        }),
                  (data) => {
                    guard.setMessage(<CopyText k={'position'} params={{ dataId: String(data.id), dataStatus: String(data.status) }} />);
                    positions.reload();
                    setPreview(null);
                  },
                );
              }}
            >
              <CopyText k="confirmPosition" />
            </Button>
          </>
        )}
        <State value={disclosure}>
          {(data) => (
            <p className="trade-note" lang="und">
              {data.copy}
            </p>
          )}
        </State>
        <GuardResult guard={guard} />
      </div>
      <section>
        <h2>
          <CopyText k="yourPositions" />
        </h2>
        <Tabs
          labels={tradeLabels}
          items={['Open positions', 'Position history']}
          value={positionTab}
          onChange={setPositionTab}
          label={copy.t('positionRecords')}
        />
        <State value={positionTab === 'Open positions' ? positions : history}>
          {(rows) =>
            rows.length ? (
              <DataTable
                label={copy.t('futuresPositions')}
                headers={[
                  <CopyText k={'marketSide'} />,
                  <CopyText k={'size1af851'} />,
                  <CopyText k={'entryMark'} />,
                  <CopyText k={'margin'} />,
                  <CopyText k={'liquidation'} />,
                  <CopyText k={'state'} />,
                  <CopyText k={'action'} />,
                ]}
              >
                {rows.map((row) => (
                  <tr key={row.id ?? row.symbol}>
                    <td lang="zxx">
                      {row.symbol} · {row.side}
                    </td>
                    <td>
                      {displayAmount(row.contracts)} <CopyText k="base6a1213" />
                    </td>
                    <td>
                      {displayAmount(row.entryPrice)} / {displayAmount(row.markPrice)}
                    </td>
                    <td>{displayAmount(row.collateral)}</td>
                    <td>{displayAmount(row.liquidationPrice)}</td>
                    <td>
                      <span lang="zxx">{row.status}</span>
                      {row.closingReason && <small lang="und">{row.closingReason}</small>}
                    </td>
                    <td>
                      <button disabled={simulation || !row.id || guard.locked || row.status !== 'open'} onClick={() => setSelected(row)}>
                        <CopyText k="closePosition" />
                      </button>
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState
                title={
                  positionTab === 'Open positions' ? <CopyText k={'noOpenPositions'} /> : <CopyText k={'noClosedPositionsInThisPage'} />
                }
              />
            )
          }
        </State>
        <p className="trade-note">
          <CopyText k="positionHistoryShowsUpToServiceRecordsItIsNotA" />
        </p>
      </section>
      {selected && (
        <Dialog title={<CopyText k={'closeFuturesPosition'} />} onClose={() => setSelected(null)}>
          <p>
            {selected.symbol} · {selected.side} · {selected.contracts} <CopyText k="baseQuantityTheServerUsesItsAcceptedMarkIfNoUsable" />
          </p>
          <Button
            disabled={simulation || guard.busy || guard.locked}
            onClick={() => {
              if (simulationRef.current || !selected.id) return;
              const clientCloseId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
              const quantity = selected.contracts;
              void guard.run(
                { kind: 'position', id: selected.id, symbol: selected.symbol, clientCloseId },
                () =>
                  simulationRef.current
                    ? Promise.resolve(tradeRefusal('simulatedModeCannotCloseALivePosition', { reason: 'not_supported' as const }))
                    : tools.positionClose(selected.id as string, { quantity, clientCloseId }),
                (data) => {
                  guard.setMessage(<CopyText k={'position'} params={{ dataId: String(data.id), dataStatus: String(data.status) }} />);
                  positions.reload();
                  setSelected(null);
                },
              );
            }}
          >
            <CopyText k="confirmClose" />
          </Button>
        </Dialog>
      )}
    </>
  );
}
function Execution({ tools, simulation }: { tools: ToolApi; simulation: boolean }) {
  const spine = useResource((signal) => tools.executionSpine(signal), 'execution-spine');
  return (
    <>
      <Capability
        title={<CopyText k={'crossVenueExecutionRequiresServiceAuthority'} />}
        detail={<CopyText k={'omsPlanningRoutingAndExecutionAreGuardedBySignedServiceAuthority'} />}
      />
      <State value={spine}>
        {(data) => (
          <DataTable
            label={copy.t('executionCapabilities')}
            headers={[<CopyText k={'tool'} />, <CopyText k={'operation'} />, <CopyText k={'executionSource'} />]}
          >
            {data.doors.map((door) => (
              <tr key={door.id}>
                <td lang="zxx">{door.module.replace('execution.', '')}</td>
                <td lang="zxx">{door.kind}</td>
                <td>
                  {door.callerSubmit ? <CopyText k={'requiresAnAuthorizedVenueSubmitPort'} /> : <CopyText k={'planningOrObservation'} />}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </State>
      <div className="trade-capability-grid">
        {[
          [<CopyText k={'smartRouting'} />, <CopyText k={'comparePermittedExternalVenuesAndRouteAParentExecution'} />],
          [<CopyText k={'arbitrage'} />, <CopyText k={'planLinkedLegsWithTheServiceSRiskAndVenueAuthority'} />],
          [<CopyText k={'marketMaking'} />, <CopyText k={'quoteAndHedgeWithExplicitlyPublishedSpreadAndCapitalPolicy'} />],
        ].map(([title, detail], index) => (
          <Capability key={index} title={title ?? ''} detail={detail ?? ''} />
        ))}
      </div>
      <a className="text-link" href={`/quant/studio${simulation ? '?simulated=true' : ''}`}>
        <CopyText k="openQuantStudio" />
      </a>
    </>
  );
}
function Options({ markets }: { markets: Listing[] }) {
  return (
    <>
      <Capability
        title={<CopyText k={'optionsChainRequiresCompleteContractTerms'} />}
        detail={<CopyText k={'publishedOptionListingsCurrentlyExposeNoOptionChainSurfaceStrikeOption'} />}
      />
      <DataTable
        label={copy.t('publishedOptionsTerms')}
        headers={[
          <CopyText k={'contract'} />,
          <CopyText k={'callPut'} />,
          <CopyText k={'strike'} />,
          <CopyText k={'expiry'} />,
          <CopyText k={'sizeSettlement'} />,
          <CopyText k={'status'} />,
        ]}
      >
        {markets.map((market) => (
          <tr key={market.id}>
            <td lang="zxx">{market.symbol}</td>
            <td>{market.optionType ?? <CopyText k={'unpublished'} />}</td>
            <td>{displayAmount(market.strike)}</td>
            <td>{market.expiryDatetime ? tradeDate(market.expiryDatetime) : <CopyText k={'unpublished'} />}</td>
            <td>
              {displayAmount(market.contractSize)} / {market.settle ?? <CopyText k={'unpublished'} />}
            </td>
            <td>{market.orderable ? <CopyText k={'publishedForAdmission'} /> : <CopyText k={'restricted'} />}</td>
          </tr>
        ))}
      </DataTable>
      {!markets.length && <EmptyState title={<CopyText k={'noOptionContractsArePublished'} />} />}
      <p className="trade-note">
        <CopyText k="whenCompleteOptionTermsAreAvailableCallsAndPutsCanBe" />
      </p>
    </>
  );
}
function Margin({ simulation }: { simulation: boolean }) {
  return (
    <>
      <Capability
        title={<CopyText k={'spotMarginBorrowingIsNotConnected'} />}
        detail={<CopyText k={'theCustomerTradeContractsDoNotMountSpotBorrowRepayDebt'} />}
      />
      <div className="trade-capability-grid">
        <Capability
          title={<CopyText k={'crossMargin'} />}
          detail={<CopyText k={'aSharedCollateralPoolAndLiquidationRiskContractIsMissingNo'} />}
        />
        <Capability
          title={<CopyText k={'isolatedSpotMargin'} />}
          detail={<CopyText k={'aPerMarketBorrowAndRepaymentContractIsMissingSpotBuys'} />}
        />
      </div>
      <div className="actions">
        <a className="text-link" href={`/exchange${simulation ? '?simulated=true' : ''}`}>
          <CopyText k="tradeFullyFundedSpot" />
        </a>
        <a className="text-link" href={`/trade/futures${simulation ? '?simulated=true' : ''}`}>
          <CopyText k="viewIsolatedFuturesRisk" />
        </a>
      </div>
    </>
  );
}
function Capability({ title, detail }: { title: ReactNode; detail: ReactNode }) {
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
