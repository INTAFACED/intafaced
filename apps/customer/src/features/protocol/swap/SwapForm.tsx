import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatAsOf } from '@intafaced/ui';
import {
  PRICE_SETTINGS_UNSET,
  type ProtocolFeeSwapOrder,
  type ProtocolPoolQuote,
  type ProtocolRouteOptions,
  type ProtocolSwapPool,
  type ProtocolSwapToken,
} from '@intafaced/contracts/protocol-swap';
import { navigate } from '../../../app/location';
import { Button, Dialog, Failure, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { useApi } from '../../session/session';
import { createProtocolApi, type RepresentationStatus } from '../api';
import { networkLabel } from '../blockers';
import { REGION_BLOCKED_CODE, useRegionBlocked } from '../region';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import { RepresentationPanel } from '../wallet/RepresentationPanel';
import { shortContract, tokenLabel, toBaseUnits } from '../wallet/transfer';
import { useWallet } from '../wallet/WalletProvider';
import { swapCopy } from './copy';
import { keepMode, readMode, type SwapMode } from './mode';
import { chosenFee, feeFields, toGwei, type ChosenFee, type FeeChoice } from './fee';
import { chargedIn, NATIVE, payInRefusal, payInTokens, type TokenFee } from './fee-token';
import { feeRefusal, NetworkFee } from './NetworkFee';
import { RouteOptions } from './RouteOptions';
import { bpsToPercent, formatUnits, formatUsd, minimumOut, percentToBps, poolsFor, receivedIn } from './swap-math';
import {
  HOP_BELOW_MIN,
  PERMIT_ALLOWANCE_EXPIRED,
  PERMIT_ALLOWANCE_LOW,
  PERMIT_LIFETIME_OVER_CAP,
  PERMIT_LIFETIME_UNSET,
  ROUTE_MAX_HOPS_UNSET,
  ROUTE_OVER_MAX_HOPS,
  ROUTE_NO_PATH,
  type ProtocolApprovalRouteOutput,
  type ProtocolPathOutput,
} from '@intafaced/contracts/protocol-swap-v2';
import { createSwapV2Api } from './api-v2';
import {
  NATIVE_VALUE,
  STANDING_CHOICES,
  dateTime,
  limitsFor,
  parseDeadline,
  planV2Swap,
  type AllowanceChoice,
  type SwapKind,
} from './v2-flow';

/** The copy key that names each standing-allowance lifetime. */
const EXPIRES_KEY = {
  60: 'expires_60',
  3600: 'expires_3600',
  86400: 'expires_86400',
  604800: 'expires_604800',
  2592000: 'expires_2592000',
} as const;

type Quote = { pool: ProtocolSwapPool; quote: ProtocolPoolQuote; amountIn: bigint; readAt: number };
type Track = {
  hash: string | null;
  state: 'submitted' | 'confirming' | 'filled' | 'failed';
  amountIn: bigint;
  minOut: bigint;
  tokenIn: ProtocolSwapToken;
  tokenOut: ProtocolSwapToken;
  pool: string;
  received?: bigint;
  feeWei?: bigint;
  reason?: string;
  /**
   * Set when the fee is paid in a token through the fee relay: the most the person signed for, the relay that charges
   * it, and once mined what it actually took (its FeeCharged event).
   */
  feeIn?: { signed: bigint; relay: string; charged?: bigint; token: ProtocolSwapToken };
  /** A router v2 swap: its path, pools and kind, and each hop's minimum (exact input), to explain a revert. */
  v2?: { kind: SwapKind; path: string[]; pools: string[]; minOutPerHop: bigint[]; amount: bigint; hops: number };
  /** Exact output: `amountIn` is the most that may be paid. */
  paidAtMost?: boolean;
};
interface Receipt {
  status?: string;
  blockNumber?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
}

/**
 * The /dex swap form (D-swap-01, -02, -04, -10): token in, token out and the amount, in Simple or Manual mode, quoted
 * from the pools on the app's network as read now. Simple hides the route and slippage controls and uses the owner's
 * slippage ceiling; Manual shows them after a one-time notice and remembers the choice when the browser can.
 * A quote lives for the owner's quote lifetime and then must be read again. Swap runs the representation gate, then one
 * plain-words sheet with every step (an exact approve when the pool may not move the tokens yet, then the swap); the
 * person's wallet signs and sends each. The status card follows the swap on the chain. Nothing posts to the ledger and
 * nothing is invented: a blank setting, an unreadable chain or a missing pool refuses in words.
 */
export function SwapForm() {
  const { language } = usePreferences();
  const { t } = swapCopy.forLocale(language);
  const wallet = useWallet();
  const regionBlocked = useRegionBlocked();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const network = networkLabel(APP_CHAIN_ID).name;
  const pairs = useResource((signal) => api.ammPairs(signal), 'swap:pairs');
  const settings = useResource((signal) => api.swapSettings(signal), 'swap:settings');
  const [refresh, setRefresh] = useState(0);
  const prices = useResource((signal) => api.tokenPrices(signal), `swap:prices:${refresh}`);
  const tokens = pairs.resource.status === 'ready' ? pairs.resource.data.tokens : [];
  const pools = pairs.resource.status === 'ready' ? pairs.resource.data.pools : [];
  const setting = settings.resource.status === 'ready' ? settings.resource.data : null;

  const [kept] = useState(readMode);
  const [mode, setMode] = useState<SwapMode>(kept.mode);
  const [manualSeen, setManualSeen] = useState(kept.manualSeen);
  const [notice, setNotice] = useState(false);
  const [tokenInAddress, setTokenIn] = useState('');
  const [tokenOutAddress, setTokenOut] = useState('');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteProblem, setQuoteProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [representation, setRepresentation] = useState<{ address: string; status: RepresentationStatus } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  // A failed swap belongs to the quote it was sent on: Swap waits for a new read (new input, Refresh, Get a new quote). The
  // status card stays, so a reverted swap's hash and fee are not lost when the amount changes.
  const [needsQuote, setNeedsQuote] = useState(false);
  const [feeChoice, setFeeChoice] = useState<FeeChoice>('normal');
  const [customFee, setCustomFee] = useState('');
  // Paying the fee in a token (RC-dex-protocol-02): the choice, its fee as the relay prices it, and why a token was refused.
  const [payIn, setPayIn] = useState<string>(NATIVE);
  const [tokenFee, setTokenFee] = useState<TokenFee>({ status: 'idle' });
  const [payInProblem, setPayInProblem] = useState<string | null>(null);
  const feeTokens = useResource((signal) => api.feeTokens(signal), 'swap:fee-tokens');
  const [routes, setRoutes] = useState<ProtocolRouteOptions | null>(null);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const ids = { pay: useId(), receive: useId(), note: useId() };
  // Router v2 (D-swap-03, D-swap-intents-01, -02): exact output, native ETH, signature approvals and multi-hop paths.
  const v2Api = useMemo(() => createSwapV2Api(transport), [transport]);
  const v2Settings = useResource((signal) => v2Api.settings(signal), 'swap:v2-settings');
  const v2 = v2Settings.resource.status === 'ready' ? v2Settings.resource.data : null;
  const [kind, setKind] = useState<SwapKind>('exact_in');
  const [amountOutText, setAmountOut] = useState('');
  const [allowance, setAllowance] = useState<AllowanceChoice>('onchain');
  const [standingSeconds, setStandingSeconds] = useState<number>(STANDING_CHOICES[0]);
  const [renewStanding, setRenewStanding] = useState(false);
  const [deadlineText, setDeadlineText] = useState('');
  const [hopsText, setHopsText] = useState('1');
  const [maxHopsText, setMaxHopsText] = useState('');
  const [pathQuote, setPathQuote] = useState<{ path: ProtocolPathOutput; readAt: number } | null>(null);
  const [pathProblem, setPathProblem] = useState<string | null>(null);
  const [approvalRoute, setApprovalRoute] = useState<ProtocolApprovalRouteOutput | null>(null);

  const nativeIn = tokenInAddress === NATIVE_VALUE;
  const nativeToken: ProtocolSwapToken | null = v2 ? { address: v2.wrappedNative.address, name: 'ETH', symbol: 'ETH', decimals: 18 } : null;
  const tokenIn = nativeIn ? nativeToken : (tokens.find((token) => token.address.toLowerCase() === tokenInAddress.toLowerCase()) ?? null);
  const tokenOut = tokens.find((token) => token.address.toLowerCase() === tokenOutAddress.toLowerCase()) ?? null;
  const amountIn = tokenIn ? toBaseUnits(amount, tokenIn.decimals) : null;
  const candidates = tokenIn && tokenOut ? poolsFor(pools, tokenIn.address, tokenOut.address) : [];
  // Hops are chosen in Manual only; Simple is always the one best pool. A blank hop limit is null: no multi-hop route.
  const hops = mode === 'manual' ? (/^[1-9][0-9]?$/.test(hopsText.trim()) ? Number(hopsText.trim()) : null) : 1;
  const maxHops = /^[1-9][0-9]?$/.test(maxHopsText.trim()) ? Number(maxHopsText.trim()) : null;
  const useV2Quote = nativeIn || kind === 'exact_out' || hops !== 1;
  const v2Swap = useV2Quote || allowance !== 'onchain';
  const pathAmount = kind === 'exact_out' ? (tokenOut ? toBaseUnits(amountOutText, tokenOut.decimals) : null) : amountIn;
  const candidateKey = candidates.map((pool) => pool.pool).join(',');

  // Quote: the service ranks every pool for the pair at one block (amm.routes) and quotes each from that block; the
  // best usable leg is the quote. In Manual the pools the person excluded are left out; a stale, empty or unreadable
  // pool is never used. A new input or a refresh reads again. The last ranking stays on screen while the next is read,
  // unless the pair or amount changed, so the open route table keeps its place when a pool is excluded.
  const exclude = mode === 'manual' ? excluded : [];
  const excludeKey = exclude.join(',');
  const inputKey = `${tokenIn?.address ?? ''}:${tokenOut?.address ?? ''}:${amountIn?.toString() ?? ''}`.toLowerCase();
  useEffect(() => {
    setQuote(null);
    setQuoteProblem(null);
    setNeedsQuote(false);
    setRoutes((shown) => (shown && `${shown.tokenIn}:${shown.tokenOut}:${shown.amountIn}`.toLowerCase() === inputKey ? shown : null));
    if (useV2Quote || !tokenIn || !tokenOut || amountIn === null || candidates.length === 0) return setRoutes(null);
    const controller = new AbortController();
    void api
      .routes({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn: amountIn.toString(), exclude }, controller.signal)
      .then((ranked) => {
        if (controller.signal.aborted) return;
        if (!ranked.ok) {
          setRoutes(null);
          return setQuoteProblem(t('quoteRefused'));
        }
        setRoutes(ranked.data);
        const best = ranked.data.legs.find((leg) => leg.status === 'best');
        const pool = best ? candidates.find((candidate) => candidate.pool.toLowerCase() === best.pool.toLowerCase()) : undefined;
        if (!best || !best.quote) return setQuoteProblem(exclude.length > 0 ? t('routeNone') : t('noUsablePool'));
        if (!pool) return setQuoteProblem(t('quoteRefused'));
        setNow(Date.now());
        setQuote({ pool, quote: best.quote, amountIn, readAt: Date.now() });
      });
    return () => controller.abort();
    // The inputs are named by their values; the objects are rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, inputKey, candidateKey, excludeKey, refresh, useV2Quote]);

  // The v2 quote: the best path with the chosen hops, read by router v2 at one block (exact input or exact output).
  const pathKey = `${tokenIn?.address ?? ''}:${tokenOut?.address ?? ''}:${kind}:${pathAmount?.toString() ?? ''}:${hops ?? ''}:${maxHops ?? ''}`;
  useEffect(() => {
    setPathQuote(null);
    setPathProblem(null);
    if (!useV2Quote || !v2 || !tokenIn || !tokenOut || pathAmount === null || hops === null) return;
    if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) return;
    const controller = new AbortController();
    void v2Api
      .paths(
        { tokenIn: tokenIn.address, tokenOut: tokenOut.address, kind, amount: pathAmount.toString(), hops, maxHops },
        controller.signal,
      )
      .then((read) => {
        if (controller.signal.aborted) return;
        if (!read.ok)
          return setPathProblem(
            read.code === ROUTE_MAX_HOPS_UNSET
              ? t('hopLimitUnset', { hops: String(hops) })
              : read.code === ROUTE_OVER_MAX_HOPS
                ? t('hopLimitOver', { hops: String(hops) })
                : read.code === ROUTE_NO_PATH
                  ? t('noPath', { hops: String(hops) })
                  : t('quoteRefused'),
          );
        setNow(Date.now());
        setPathQuote({ path: read.data, readAt: Date.now() });
      });
    return () => controller.abort();
    // The inputs are named by their values in pathKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2Api, v2?.router, useV2Quote, pathKey, refresh]);

  // How the chosen input token may be approved (its own permit, the permit contract, or an approve transaction), read
  // again after each swap so a standing allowance's amount and expiry stay current.
  const routeOwner = wallet.address;
  useEffect(() => {
    setApprovalRoute(null);
    if (!v2 || !routeOwner || !tokenIn || nativeIn) return;
    const controller = new AbortController();
    void v2Api.approvalRoute({ owner: routeOwner, token: tokenIn.address }, controller.signal).then((read) => {
      if (!controller.signal.aborted && read.ok) setApprovalRoute(read.data);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v2Api, v2?.router, routeOwner, tokenIn?.address, nativeIn, track?.state]);
  // A token with no permit cannot take one signature: the choice falls back to Approve on chain.
  const noPermit = approvalRoute !== null && approvalRoute.route !== 'native_permit';
  useEffect(() => {
    if (noPermit && allowance === 'permit') setAllowance('onchain');
  }, [noPermit, allowance]);
  useEffect(() => setRenewStanding(false), [tokenIn?.address, allowance]);
  // An exclusion belongs to the pair it was made on: choosing other tokens starts with every pool in.
  useEffect(() => setExcluded([]), [tokenIn?.address, tokenOut?.address]);

  const activeReadAt = useV2Quote ? (pathQuote?.readAt ?? null) : (quote?.readAt ?? null);
  const expiresAt = activeReadAt !== null && setting ? activeReadAt + setting.quoteTtlSeconds * 1000 : null;
  const expired = expiresAt !== null && now >= expiresAt;
  useEffect(() => {
    if (expiresAt === null || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, expired]);

  const slippageBps = mode === 'manual' && slippage.trim() !== '' ? percentToBps(slippage) : (setting?.slippageCeilingBps ?? null);
  const overCeiling = setting !== null && slippageBps !== null && slippageBps > setting.slippageCeilingBps;
  const minOut = quote && slippageBps !== null && !overCeiling ? minimumOut(BigInt(quote.quote.amountOut), slippageBps) : null;
  const pathLimits = pathQuote && slippageBps !== null && !overCeiling ? limitsFor(pathQuote.path, slippageBps) : null;
  // The deadline: the person's own, or the quote's lifetime. A typed one in the past refuses before anything is built.
  const typedDeadline = deadlineText.trim() === '' ? null : parseDeadline(deadlineText);
  const deadlineSeconds = deadlineText.trim() !== '' ? typedDeadline : expiresAt !== null ? Math.ceil(expiresAt / 1000) : null;
  const deadlineProblem = !v2Swap
    ? null
    : deadlineText.trim() !== '' && typedDeadline === null
      ? t('deadlineInvalid')
      : typedDeadline !== null && typedDeadline <= Math.floor(now / 1000)
        ? t('deadlinePast')
        : null;
  // Price impact is already in the quote; the note says how far this trade moves the pool when that is more than the
  // slippage in use, so a person sees a thin pool before they swap. It does not stop the swap.
  const impactNoted = quote !== null && slippageBps !== null && quote.quote.priceImpactBps > slippageBps;
  // The network fee levels are read again with every quote, so they describe the same few blocks.
  const fees = useResource((signal) => api.feeLevels(signal), `swap:fees:${refresh}:${quote?.readAt ?? 0}`);
  const feeRead = fees.resource.status === 'ready' ? fees.resource.data : null;
  const fee = feeRead ? chosenFee(feeRead, feeChoice, customFee) : null;
  const feeAlert = feeRefusal(feeRead, fee, customFee, language);
  const payTokens = payInTokens(tokens, feeTokens.resource.status === 'ready' ? feeTokens.resource.data.tokens : []);
  const payToken = payIn === NATIVE ? null : (payTokens.find((token) => token.address.toLowerCase() === payIn.toLowerCase()) ?? null);
  /** A token the relay will not take puts the fee back on native currency, and says why in a sentence. */
  const refusePayIn = (token: ProtocolSwapToken, code: string | undefined) => {
    setPayIn(NATIVE);
    setTokenFee({ status: 'idle' });
    setPayInProblem(t(`payInRefused_${payInRefusal(code)}`, { token: token.name }));
  };
  const choosePayIn = (value: string) => {
    setPayInProblem(null);
    setPayIn(value);
  };
  // The fee in the chosen token, priced by the relay at the most per gas of the chosen level; read again with the levels.
  const maxFeeKey = fee?.ok ? fee.maxFeePerGas.toString() : '';
  useEffect(() => {
    if (!payToken || !maxFeeKey) return setTokenFee({ status: 'idle' });
    const token = payToken;
    setTokenFee((shown) => (shown.status === 'ready' && shown.token.address === token.address ? shown : { status: 'reading', token }));
    const controller = new AbortController();
    void api.feeQuote({ feeToken: token.address, maxFeePerGasWei: maxFeeKey }, controller.signal).then((read) => {
      if (controller.signal.aborted) return;
      if (read.ok) setTokenFee({ status: 'ready', token, quote: read.data });
      else refusePayIn(token, read.code);
    });
    return () => controller.abort();
    // Read again when the token or the per-gas fee changes; the token object is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, payToken?.address, maxFeeKey]);

  const choose = (next: SwapMode) => {
    setMode(next);
    if (next === 'manual' && !manualSeen) setNotice(true);
    else keepMode(next, manualSeen);
  };
  const closeNotice = (accepted: boolean) => {
    setNotice(false);
    if (accepted) {
      setManualSeen(true);
      keepMode('manual', true);
    } else setMode('simple');
  };

  const ready = wallet.status === 'connected' && wallet.address !== null && wallet.guard?.ok === true;
  const reason = regionBlocked
    ? t('regionBlocked')
    : !ready
      ? t('needsWallet')
      : pairs.resource.status === 'failed' || settings.resource.status === 'failed'
        ? t('needsReadable')
        : !tokenIn || !tokenOut
          ? t('needsTokens')
          : tokenIn.address === tokenOut.address
            ? t('sameToken')
            : amountIn === null
              ? t('needsAmount', { decimals: String(tokenIn.decimals) })
              : candidates.length === 0
                ? t('noPool')
                : quoteProblem
                  ? quoteProblem
                  : !quote
                    ? t('quoting')
                    : needsQuote
                      ? t('needsNewQuote')
                      : expired
                        ? t('needsRefresh')
                        : slippageBps === null
                          ? t('slippageInvalid')
                          : overCeiling
                            ? t('slippageOver', { ceiling: bpsToPercent(setting!.slippageCeilingBps) })
                            : minOut === null
                              ? t('minimumNone')
                              : fees.resource.status === 'failed'
                                ? t('feeUnread')
                                : !fee
                                  ? t('feeLoading')
                                  : !fee.ok
                                    ? (feeAlert ?? t('feeCustomNeeded'))
                                    : payToken && tokenFee.status !== 'ready'
                                      ? t('feeInTokenReading', { token: payToken.name })
                                      : null;
  const v2Reason = !v2Swap
    ? null
    : regionBlocked
      ? t('regionBlocked')
      : !ready
        ? t('needsWallet')
        : v2Settings.resource.status === 'failed'
          ? v2Settings.resource.failure.code === 'protocol.router_v2_unset'
            ? t('v2Unset')
            : t('v2Unread')
          : !v2
            ? t('quoting')
            : !tokenIn || !tokenOut
              ? t('needsTokens')
              : tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()
                ? t('sameToken')
                : pathAmount === null && useV2Quote
                  ? t('needsAmount', { decimals: String((kind === 'exact_out' ? tokenOut : tokenIn).decimals) })
                  : hops === null
                    ? t('hopsInvalid')
                    : allowance === 'permit' && noPermit
                      ? t('permitNotOffered', { token: tokenIn.name })
                      : deadlineProblem
                        ? deadlineProblem
                        : payToken
                          ? t('feeInTokenV2')
                          : null;
  const following = track?.state === 'submitted' || track?.state === 'confirming';
  // A v2 swap with its own quote: the path quote stands in for the pool quote and its checks.
  const v2QuoteReason = !useV2Quote
    ? null
    : pathProblem
      ? pathProblem
      : !pathQuote
        ? t('quoting')
        : needsQuote
          ? t('needsNewQuote')
          : expired
            ? t('needsRefresh')
            : slippageBps === null
              ? t('slippageInvalid')
              : overCeiling && setting
                ? t('slippageOver', { ceiling: bpsToPercent(setting.slippageCeilingBps) })
                : fees.resource.status === 'failed'
                  ? t('feeUnread')
                  : !fee
                    ? t('feeLoading')
                    : !fee.ok
                      ? (feeAlert ?? t('feeCustomNeeded'))
                      : null;
  const shownReason = v2Reason ?? (useV2Quote ? v2QuoteReason : reason);
  const canSwap = shownReason === null && !busy && !following;

  // Why a swap did not go through: the pool read again; under the minimum means the price moved.
  const whyFailed = async (pool: string, inToken: string, amountInUnits: bigint, min: bigint, otherwise?: string): Promise<string> => {
    const again = await api.poolQuote({ pool, tokenIn: inToken, amountIn: amountInUnits.toString() });
    return again.ok && BigInt(again.data.amountOut) < min ? t('failedPriceMoved') : (otherwise ?? t('failedOther'));
  };

  const sendSwap = async (shown: Quote, inToken: ProtocolSwapToken, outToken: ProtocolSwapToken, bps: number, owner: string) => {
    // The pool is read again right before the swap is built, and the minimum taken from that read at the slippage the
    // person chose: the service checks the minimum against its own fresh read, so a stale one would be refused.
    const fresh = await api.poolQuote({ pool: shown.pool.pool, tokenIn: inToken.address, amountIn: shown.amountIn.toString() });
    if (!fresh.ok) return setProblem(t('quoteRefused'));
    const from: Quote = { ...shown, quote: fresh.data, readAt: Date.now() };
    setQuote(from);
    setNow(Date.now());
    const min = minimumOut(BigInt(fresh.data.amountOut), bps);
    if (min === null) return setProblem(t('minimumNone'));
    const amountText = formatUnits(from.amountIn, inToken.decimals, inToken.decimals);
    // The fee levels are read again too, so the fee sent is priced from the latest blocks; a refused one stops here.
    const feesNow = await api.feeLevels();
    if (!feesNow.ok) return setProblem(t('feeUnread'));
    const feeNow = chosenFee(feesNow.data, feeChoice, customFee);
    if (!feeNow.ok) return setProblem(feeRefusal(feesNow.data, feeNow, customFee, language) ?? t('feeCustomNeeded'));
    if (payToken) return sendWithTokenFee(from, min, inToken, outToken, owner, payToken, feeNow);
    const feeRequest = feeFields(feeNow);
    const [approval, call] = await Promise.all([
      api.checkApproval({ owner, token: inToken.address, spender: from.pool.pool, amount: from.amountIn.toString() }),
      api.buildSwap({
        pool: from.pool.pool,
        tokenIn: inToken.address,
        amountIn: from.amountIn.toString(),
        minAmountOut: min.toString(),
        to: owner,
      }),
    ]);
    if (!approval.ok) return setProblem(t('approvalUnread'));
    if (!call.ok) return setProblem(call.code === 'protocol.swap_min_out_below_bound' ? t('minimumBelow') : t('buildRefused'));
    const steps = [
      ...approval.data.calls.map((approve, index) => ({
        label:
          approval.data.resetFirst && index === 0
            ? t('stepReset', { token: inToken.name })
            : t('stepApprove', { amount: amountText, token: inToken.name }),
        request: { kind: 'transaction' as const, to: approve.to, data: approve.data, ...feeRequest },
      })),
      {
        label: t('stepSwap', {
          amount: amountText,
          tokenIn: inToken.name,
          min: formatUnits(min, outToken.decimals),
          tokenOut: outToken.name,
        }),
        request: { kind: 'transaction' as const, to: call.data.to, data: call.data.data, ...feeRequest },
      },
    ];
    const base = { amountIn: from.amountIn, minOut: min, tokenIn: inToken, tokenOut: outToken, pool: from.pool.pool };
    // Anyone can list a token, so the sheet names each token's contract, not only its name.
    const facts = [
      { label: t('contractOf', { token: inToken.name }), value: inToken.address },
      { label: t('contractOf', { token: outToken.name }), value: outToken.address },
      {
        label: t('feeFact'),
        value: t('feeFactValue', {
          level: t(`fee_${feeChoice}`),
          max: toGwei(feeNow.maxFeePerGas),
          priority: toGwei(feeNow.maxPriorityFeePerGas),
        }),
      },
    ];
    const result = await wallet.sendSequence({ title: t('stepsTitle'), steps, facts });
    // Steps already sent stay sent: say so with their hashes, never "nothing was sent".
    const earlier =
      result.status === 'sent' ? '' : result.sent.length > 0 ? ` ${t('earlierSent', { hashes: result.sent.join(', ') })}` : '';
    if (result.status === 'rejected') return setProblem(`${result.sent.length > 0 ? t('rejectedAfter') : t('rejected')}${earlier}`);
    if (result.status === 'failed') {
      // The swap step itself failed before it was mined: say why in a sentence when the pool shows it.
      if (result.step === steps.length - 1) {
        const reason = `${await whyFailed(from.pool.pool, inToken.address, from.amountIn, min, result.message)}${earlier}`;
        setNeedsQuote(true);
        return setTrack({ ...base, hash: null, state: 'failed', reason });
      }
      return setProblem(`${result.message}${earlier}`);
    }
    setTrack({ ...base, hash: result.hashes[result.hashes.length - 1]!, state: 'submitted' });
  };

  /**
   * The swap with its network fee paid in `feeToken` (RC-dex-protocol-02): the service checks the minimum against a fresh
   * read and prices the fee through the relay; the person signs a permit for each token the relay takes and the order,
   * and sends nothing. The relay's sender submits it and pays the gas in native currency. The fee line shows the quote
   * that was signed.
   */
  const sendWithTokenFee = async (
    from: Quote,
    min: bigint,
    inToken: ProtocolSwapToken,
    outToken: ProtocolSwapToken,
    owner: string,
    feeToken: ProtocolSwapToken,
    feeNow: Extract<ChosenFee, { ok: true }>,
  ) => {
    const plan = await api.prepareFeeSwap({
      owner,
      pool: from.pool.pool,
      tokenIn: inToken.address,
      amountIn: from.amountIn.toString(),
      minAmountOut: min.toString(),
      feeToken: feeToken.address,
      maxFeePerGasWei: feeNow.maxFeePerGas.toString(),
    });
    if (!plan.ok) {
      if (payInRefusal(plan.code) !== 'unread') return refusePayIn(feeToken, plan.code);
      return setProblem(
        plan.code === 'protocol.swap_min_out_below_bound' ? t('minimumBelow') : t('feeTokenPlanRefused', { token: feeToken.name }),
      );
    }
    setTokenFee({ status: 'ready', token: feeToken, quote: plan.data.quote });
    const signatures: string[] = [];
    for (const typedData of [...plan.data.permits, plan.data.order]) {
      const signed = await wallet.sign({ kind: 'typedData', typedData });
      if (signed.status === 'rejected') return setProblem(t('signRejected'));
      if (signed.status !== 'signed') return setProblem(signed.status === 'failed' ? signed.message : t('signRejected'));
      signatures.push(signed.signature);
    }
    const sent = await api.relayFeeSwap({
      order: plan.data.order.message as unknown as ProtocolFeeSwapOrder,
      signature: signatures[signatures.length - 1]!,
      permits: plan.data.permits.map((permit, index) => ({
        token: permit.domain.verifyingContract,
        value: permit.message.value ?? '0',
        deadline: permit.message.deadline ?? '0',
        signature: signatures[index]!,
      })),
      maxFeePerGasWei: feeNow.maxFeePerGas.toString(),
      maxPriorityFeePerGasWei: feeNow.maxPriorityFeePerGas.toString(),
    });
    if (!sent.ok) {
      if (payInRefusal(sent.code) !== 'unread') return refusePayIn(feeToken, sent.code);
      return setProblem(t('relayRefused'));
    }
    setTrack({
      hash: sent.data.hash,
      state: 'submitted',
      amountIn: from.amountIn,
      minOut: min,
      tokenIn: inToken,
      tokenOut: outToken,
      pool: from.pool.pool,
      feeIn: { signed: BigInt(plan.data.quote.charge), relay: plan.data.quote.relay, token: feeToken },
    });
  };

  /**
   * A router v2 swap: the path read again, the approval the person chose (approve transaction, one signature for this
   * swap, or a standing allowance), then one swap call that carries the signatures. Every step is on one sheet first.
   */
  const sendSwapV2 = async (owner: string) => {
    if (!v2 || !tokenIn || !tokenOut || slippageBps === null || deadlineSeconds === null) return;
    const feesNow = await api.feeLevels();
    if (!feesNow.ok) return setProblem(t('feeUnread'));
    const feeNow = chosenFee(feesNow.data, feeChoice, customFee);
    if (!feeNow.ok) return setProblem(feeRefusal(feesNow.data, feeNow, customFee, language) ?? t('feeCustomNeeded'));
    const feeRequest = feeFields(feeNow);
    // The path: read again now (v2 quote), or the one best pool the form quoted (a permit on a one-pool swap).
    let path: ProtocolPathOutput;
    if (useV2Quote) {
      if (pathAmount === null || hops === null) return;
      const fresh = await v2Api.paths({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        kind,
        amount: pathAmount.toString(),
        hops,
        maxHops,
      });
      if (!fresh.ok) return setProblem(t('quoteRefused'));
      path = fresh.data;
      setPathQuote({ path, readAt: Date.now() });
    } else {
      if (!quote || amountIn === null) return;
      path = {
        kind: 'exact_in',
        path: [tokenIn.address, tokenOut.address],
        pools: [quote.pool.pool],
        hops: [
          {
            pool: quote.pool.pool,
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            amountIn: amountIn.toString(),
            amountOut: quote.quote.amountOut,
          },
        ],
        amountIn: amountIn.toString(),
        amountOut: quote.quote.amountOut,
        blockNumber: '0',
        blockTime: '0',
      };
    }
    setNow(Date.now());
    const limits = limitsFor(path, slippageBps);
    const amount = BigInt(kind === 'exact_out' ? path.amountOut : path.amountIn);
    const need = kind === 'exact_out' ? limits.maxIn! : amount;
    const minTotal = kind === 'exact_in' ? limits.minOutPerHop[limits.minOutPerHop.length - 1]! : amount;
    const inText = formatUnits(need, tokenIn.decimals, tokenIn.decimals);
    const outText = formatUnits(minTotal, tokenOut.decimals);
    const swapLabel =
      kind === 'exact_out'
        ? nativeIn
          ? t('stepWrapSwap', { max: inText, out: outText, tokenOut: tokenOut.name })
          : t('stepSwapExactOut', { max: inText, tokenIn: tokenIn.name, out: outText, tokenOut: tokenOut.name })
        : nativeIn
          ? t('stepWrapSwapIn', { amount: inText, min: outText, tokenOut: tokenOut.name })
          : path.pools.length > 1
            ? t('stepSwapHops', {
                amount: inText,
                tokenIn: tokenIn.name,
                min: outText,
                tokenOut: tokenOut.name,
                hops: String(path.pools.length),
              })
            : t('stepSwap', { amount: inText, tokenIn: tokenIn.name, min: outText, tokenOut: tokenOut.name });
    const plan = await planV2Swap({
      api: v2Api,
      settings: v2,
      owner,
      kind,
      path: path.path,
      pools: path.pools,
      amount,
      need,
      tokenIn: nativeIn ? null : tokenIn,
      tokenOut,
      native: nativeIn,
      slippageBps,
      deadline: BigInt(deadlineSeconds),
      allowance: nativeIn ? 'onchain' : allowance,
      standingSeconds,
      renewStanding,
      fee: feeRequest,
      labels: {
        approve: (a, token) => t('stepApprove', { amount: a, token }),
        permit: (a, token) => t('stepPermit', { amount: a, token }),
        permitContract: (a, token) => t('stepPermitContract', { amount: a, token }),
        standing: (a, token, until) => t('stepStanding', { amount: a, token, time: until }),
        swap: swapLabel,
      },
    });
    if (!plan.ok) {
      if (plan.code === PERMIT_ALLOWANCE_EXPIRED)
        return setProblem(t('standingExpired', { time: plan.expiredAt !== undefined ? dateTime(plan.expiredAt) : '' }));
      if (plan.code === PERMIT_ALLOWANCE_LOW) return setProblem(t('standingLow'));
      if (plan.code === PERMIT_LIFETIME_UNSET) return setProblem(t('permitLifetimeUnset'));
      if (plan.code === PERMIT_LIFETIME_OVER_CAP) return setProblem(t('permitLifetimeOver'));
      if (plan.code === 'protocol.deadline_past') return setProblem(t('deadlinePast'));
      if (plan.code === HOP_BELOW_MIN) return setProblem(t('failedPriceMoved'));
      return setProblem(t('buildRefused'));
    }
    const facts = [
      { label: t('contractOf', { token: tokenIn.name }), value: nativeIn ? v2.wrappedNative.address : tokenIn.address },
      { label: t('contractOf', { token: tokenOut.name }), value: tokenOut.address },
      ...plan.facts,
      ...(kind === 'exact_in' && path.pools.length > 1
        ? limits.minOutPerHop.map((min, index) => ({
            label: t('hopMinimumFact', { hop: String(index + 1) }),
            value: hopTokenText(min, path.path[index + 1]!),
          }))
        : []),
      {
        label: t('feeFact'),
        value: t('feeFactValue', {
          level: t(`fee_${feeChoice}`),
          max: toGwei(feeNow.maxFeePerGas),
          priority: toGwei(feeNow.maxPriorityFeePerGas),
        }),
      },
    ];
    const base = {
      amountIn: need,
      minOut: minTotal,
      tokenIn,
      tokenOut,
      pool: path.pools[0]!,
      paidAtMost: kind === 'exact_out',
      v2: { kind, path: path.path, pools: path.pools, minOutPerHop: limits.minOutPerHop, amount, hops: path.pools.length },
    };
    const result = await wallet.sendSequence({ title: t('stepsTitle'), steps: plan.steps, facts });
    const earlier =
      result.status === 'sent' ? '' : result.sent.length > 0 ? ` ${t('earlierSent', { hashes: result.sent.join(', ') })}` : '';
    if (result.status === 'rejected') return setProblem(`${result.sent.length > 0 ? t('rejectedAfter') : t('rejected')}${earlier}`);
    if (result.status === 'failed') {
      if (result.step === plan.steps.length - 1) {
        setNeedsQuote(true);
        return setTrack({ ...base, hash: null, state: 'failed', reason: `${result.message}${earlier}` });
      }
      return setProblem(`${result.message}${earlier}`);
    }
    if (plan.usesStanding === false && allowance === 'standing') setRenewStanding(false);
    setTrack({ ...base, hash: result.hashes[result.hashes.length - 1]!, state: 'submitted' });
  };

  /** An amount of the token at `address` (a hop's output), written with that token's own decimals and name. */
  const hopTokenText = (units: bigint, address: string): string => {
    const token = tokens.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    return token ? `${formatUnits(units, token.decimals)} ${token.name}` : `${units} (${address})`;
  };

  /** Why a mined v2 swap reverted: the path read again; the first hop now under its minimum is named. */
  const whyFailedV2 = async (v2Track: NonNullable<Track['v2']>): Promise<string> => {
    if (v2Track.kind !== 'exact_in') return t('failedPriceMoved');
    const again = await v2Api.paths({
      tokenIn: v2Track.path[0]!,
      tokenOut: v2Track.path[v2Track.path.length - 1]!,
      kind: 'exact_in',
      amount: v2Track.amount.toString(),
      hops: v2Track.hops,
      maxHops: v2Track.hops,
    });
    if (!again.ok || again.data.pools.join() !== v2Track.pools.join()) return t('failedPriceMoved');
    const hop = again.data.hops.findIndex((entry, index) => BigInt(entry.amountOut) < v2Track.minOutPerHop[index]!);
    return hop >= 0 ? t('failedHopBelowMin', { hop: String(hop + 1) }) : t('failedOther');
  };

  const startSwap = async () => {
    if (!canSwap || !tokenIn || !tokenOut || !wallet.address) return;
    if (!v2Swap && (!quote || minOut === null)) return;
    setProblem(null);
    setBusy(true);
    try {
      // A swap is a signing action: the representation gate comes first and never fails open.
      const gate = await api.representationStatus(wallet.address);
      if (!gate.ok)
        return setProblem(
          gate.code === REGION_BLOCKED_CODE
            ? t('regionBlocked')
            : gate.code === 'compliance.representation_unset'
              ? t('representationUnset')
              : t('representationUnread'),
        );
      if (!gate.data.accepted) return setRepresentation({ address: wallet.address, status: gate.data });
      if (v2Swap) await sendSwapV2(wallet.address);
      else await sendSwap(quote!, tokenIn, tokenOut, slippageBps!, wallet.address);
    } finally {
      setBusy(false);
    }
  };

  // The status card follows the swap: submitted until mined, confirming until the owner's confirmations, then filled.
  const trackRef = useRef(track);
  trackRef.current = track;
  useEffect(() => {
    if (!track?.hash || !following || !setting || !wallet.address) return;
    let stopped = false;
    const owner = wallet.address;
    const timer = setInterval(() => {
      void (async () => {
        const current = trackRef.current;
        if (stopped || !current?.hash) return;
        const receipt = (await wallet.read('eth_getTransactionReceipt', [current.hash])) as Receipt | null;
        if (stopped || !receipt?.blockNumber) return;
        const feeWei =
          receipt.gasUsed && receipt.effectiveGasPrice ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) : undefined;
        if (receipt.status === '0x0') {
          // Mined and reverted: nothing was swapped, but the network fee was paid.
          const reason = current.v2
            ? await whyFailedV2(current.v2)
            : await whyFailed(current.pool, current.tokenIn.address, current.amountIn, current.minOut);
          if (stopped) return;
          setNeedsQuote(true);
          setTrack({ ...current, state: 'failed', reason, feeWei });
          return;
        }
        const head = (await wallet.read('eth_blockNumber', [])) as string | null;
        const deep = head ? BigInt(head) - BigInt(receipt.blockNumber) >= BigInt(setting.confirmations) : false;
        if (stopped) return;
        const charged = current.feeIn ? chargedIn(receipt.logs ?? [], current.feeIn.relay, owner) : null;
        setTrack({
          ...current,
          state: deep ? 'filled' : 'confirming',
          received: receivedIn(receipt.logs ?? [], current.tokenOut.address, owner),
          feeWei,
          ...(current.feeIn && charged !== null ? { feeIn: { ...current.feeIn, charged } } : {}),
        });
      })();
    }, 500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // Follows one swap by its hash while it is in flight; the rest is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.hash, following, setting, wallet.address]);

  // A token's USD price as the pools read it, with the block's time; a token the filter leaves out says why.
  const priceLine = (address: string): string => {
    if (prices.resource.status === 'loading') return t('priceReading');
    if (prices.resource.status === 'failed') {
      // A refusal names its blocker; only an unexplained failure reads as a passing one.
      const code = prices.resource.failure.code;
      if (code === PRICE_SETTINGS_UNSET) return t('priceSettingsUnset');
      if (code === REGION_BLOCKED_CODE) return t('regionBlocked');
      if (code === 'protocol.amm_factory_unset') return t('priceFactoryUnset');
      return t('priceUnread');
    }
    const found = prices.resource.data.prices.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    // Pairs and prices are two reads and may land on different blocks: a token missing from the prices was not read.
    if (!found) return t('priceUnread');
    if (found.usd === null) return t(found.reason === 'thin_reserve' ? 'priceNone_thin_reserve' : 'priceNone_no_route');
    const time = formatAsOf(prices.resource.data.asOf, { locale: language, now }) ?? prices.resource.data.asOf;
    return t('priceLine', { price: formatUsd(found.usd), time });
  };

  const tokenSelect = (id: string, label: string, value: string, set: (value: string) => void) => (
    <label className="field">
      <span id={id}>{label}</span>
      {/* The chosen token's contract, so a copied name cannot pass for the token it copies. */}
      <select
        value={value}
        onChange={(event) => set(event.target.value)}
        aria-labelledby={id}
        aria-describedby={pairs.resource.status === 'ready' && tokens.length === 0 ? ids.note : undefined}
      >
        <option value="">{t('chooseToken')}</option>
        {id === ids.pay && v2 && <option value={NATIVE_VALUE}>ETH</option>}
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {tokenLabel(token, tokens)}
          </option>
        ))}
      </select>
      {value === NATIVE_VALUE && <small>{t('nativeLine')}</small>}
      {value && value !== NATIVE_VALUE && <small className="numeric">{t('contract', { address: shortContract(value) })}</small>}
      {value && value !== NATIVE_VALUE && (
        <small className="numeric" data-testid={id === ids.pay ? 'price-pay' : 'price-receive'}>
          {priceLine(value)}
        </small>
      )}
    </label>
  );
  const seconds = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));

  return (
    <>
      {representation && (
        <RepresentationPanel
          address={representation.address}
          status={representation.status}
          api={api}
          onEnd={(end) => {
            setRepresentation(null);
            if (end.kind === 'accepted') void startSwap();
            else if (end.kind === 'rejected') setProblem(t('rejected'));
            else if (end.kind === 'region') setProblem(t('regionBlocked'));
            else setProblem(end.message);
          }}
        />
      )}
      <Panel title={t('formTitle')}>
        <p className="muted">{t('formNote', { network })}</p>
        {pairs.resource.status === 'failed' && <Failure result={pairs.resource.failure} retry={pairs.reload} />}
        {settings.resource.status === 'failed' && <Failure result={settings.resource.failure} retry={settings.reload} />}
        <form
          aria-label={t('formTitle')}
          className="protocol-quote"
          onSubmit={(event) => {
            event.preventDefault();
            void startSwap();
          }}
        >
          <div role="radiogroup" aria-label={t('mode')} className="protocol-actions">
            {(['simple', 'manual'] as const).map((entry) => (
              <label key={entry} className="field field--check">
                <input type="radio" name="swap-mode" value={entry} checked={mode === entry} onChange={() => choose(entry)} />
                <span>{t(entry)}</span> <small className="muted">{t(entry === 'simple' ? 'simpleHint' : 'manualHint')}</small>
              </label>
            ))}
          </div>
          <div role="radiogroup" aria-label={t('swapKind')} className="protocol-actions">
            {(['exact_in', 'exact_out'] as const).map((entry) => (
              <label key={entry} className="field field--check">
                <input type="radio" name="swap-kind" value={entry} checked={kind === entry} onChange={() => setKind(entry)} />
                <span>{t(entry === 'exact_in' ? 'exactIn' : 'exactOut')}</span>{' '}
                <small className="muted">{t(entry === 'exact_in' ? 'exactInHint' : 'exactOutHint')}</small>
              </label>
            ))}
          </div>
          {tokenSelect(ids.pay, t('youPay'), tokenInAddress, setTokenIn)}
          {tokenSelect(ids.receive, t('youReceive'), tokenOutAddress, setTokenOut)}
          {pairs.resource.status === 'ready' && tokens.length === 0 && (
            <p className="muted" id={ids.note}>
              {t('noTokens', { network })}
            </p>
          )}
          {kind === 'exact_in' ? (
            <Field
              label={t('amountIn')}
              hint={t('amountHint')}
              inputMode="decimal"
              value={amount}
              autoComplete="off"
              onChange={(event) => setAmount(event.target.value)}
            />
          ) : (
            <Field
              label={t('amountOut')}
              hint={t('amountHint')}
              inputMode="decimal"
              value={amountOutText}
              autoComplete="off"
              onChange={(event) => setAmountOut(event.target.value)}
            />
          )}
          {useV2Quote && pathQuote && tokenIn && tokenOut && (
            <dl className="protocol-facts">
              <div>
                <dt>{t('youGet')}</dt>
                <dd className="numeric" data-testid="amount-out">
                  {formatUnits(BigInt(pathQuote.path.amountOut), tokenOut.decimals)} {tokenOut.name}
                </dd>
              </div>
              {!expired && seconds !== null && (
                <div>
                  <dt>{t('quoteLife')}</dt>
                  <dd className="numeric" data-testid="quote-countdown">
                    {t('refreshesIn', { seconds: String(seconds) })}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {useV2Quote && pathLimits?.maxIn != null && tokenIn && (
            <p className="numeric" data-testid="maximum-paid">
              {t('maximumPaid', { amount: formatUnits(pathLimits.maxIn, tokenIn.decimals), token: tokenIn.name })}
            </p>
          )}
          {useV2Quote && pathQuote && pathLimits && pathQuote.path.kind === 'exact_in' && tokenOut && (
            <p className="numeric" data-testid="minimum-received">
              {t('minimumReceived', {
                amount: formatUnits(pathLimits.minOutPerHop[pathLimits.minOutPerHop.length - 1]!, tokenOut.decimals),
                token: tokenOut.name,
              })}
            </p>
          )}
          {useV2Quote && pathQuote && pathLimits && pathQuote.path.kind === 'exact_in' && pathQuote.path.pools.length > 1 && (
            <ol aria-label={t('hopMinimums')} className="numeric">
              {pathQuote.path.hops.map((hop, index) => {
                const from = tokens.find((entry) => entry.address.toLowerCase() === hop.tokenIn.toLowerCase());
                const to = tokens.find((entry) => entry.address.toLowerCase() === hop.tokenOut.toLowerCase());
                return (
                  <li key={hop.pool}>
                    {t('hopMinimum', {
                      hop: String(index + 1),
                      tokenIn: from?.name ?? hop.tokenIn,
                      tokenOut: to?.name ?? hop.tokenOut,
                      amount: formatUnits(pathLimits.minOutPerHop[index]!, to?.decimals ?? 18),
                    })}
                  </li>
                );
              })}
            </ol>
          )}
          {quote && tokenOut && !useV2Quote && (
            <dl className="protocol-facts">
              <div>
                <dt>{t('youGet')}</dt>
                <dd className="numeric" data-testid="amount-out">
                  {formatUnits(BigInt(quote.quote.amountOut), tokenOut.decimals)} {tokenOut.name}
                </dd>
              </div>
              {!expired && seconds !== null && (
                <div>
                  <dt>{t('quoteLife')}</dt>
                  <dd className="numeric" data-testid="quote-countdown">
                    {t('refreshesIn', { seconds: String(seconds) })}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {(quote || pathQuote) && expired && (
            <>
              <p role="status">{t('quoteExpired')}</p>
              <Button variant="secondary" onClick={() => setRefresh((value) => value + 1)}>
                {t('refreshQuote')}
              </Button>
            </>
          )}
          {minOut !== null && tokenOut && !useV2Quote && (
            <p className="numeric" data-testid="minimum-received">
              {t('minimumReceived', { amount: formatUnits(minOut, tokenOut.decimals), token: tokenOut.name })}
            </p>
          )}
          {impactNoted && quote && <p role="note">{t('priceImpact', { impact: bpsToPercent(quote.quote.priceImpactBps) })}</p>}
          {mode === 'manual' && (
            <>
              <Field
                label={t('slippage')}
                hint={setting ? t('slippageHintCeiling', { ceiling: bpsToPercent(setting.slippageCeilingBps) }) : t('slippageHint')}
                inputMode="decimal"
                value={slippage}
                autoComplete="off"
                onChange={(event) => setSlippage(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={!routes && !useV2Quote && !(tokenIn && tokenOut)}
                aria-expanded={routesOpen}
                title={routes ? undefined : t('routeNeedsQuote')}
                onClick={() => setRoutesOpen((open) => !open)}
              >
                {t('routeOptions')}
              </Button>
              {routesOpen && (
                <>
                  <Field
                    label={t('hops')}
                    hint={t('hopsHint')}
                    type="number"
                    min={1}
                    step={1}
                    value={hopsText}
                    onChange={(event) => setHopsText(event.target.value)}
                  />
                  <Field
                    label={t('hopLimit')}
                    hint={t('hopLimitHint')}
                    type="number"
                    min={1}
                    step={1}
                    value={maxHopsText}
                    onChange={(event) => setMaxHopsText(event.target.value)}
                  />
                </>
              )}
              {routesOpen && routes && tokenOut && !useV2Quote && (
                <RouteOptions
                  routes={routes}
                  tokenOut={tokenOut}
                  excluded={excluded}
                  onExclude={(pool, out) => {
                    const key = pool.toLowerCase();
                    setExcluded((now) => [...now.filter((item) => item !== key), ...(out ? [key] : [])]);
                  }}
                />
              )}
            </>
          )}
          {overCeiling && setting && <p role="alert">{t('slippageOver', { ceiling: bpsToPercent(setting.slippageCeilingBps) })}</p>}
          {tokenIn && !nativeIn && (
            <>
              {noPermit && approvalRoute?.route === 'approve_only' && <p role="note">{t('noPermitNote', { token: tokenIn.name })}</p>}
              <div role="radiogroup" aria-label={t('allowance')} className="protocol-actions">
                {(['onchain', 'permit', 'standing'] as const).map((entry) => (
                  <label key={entry} className="field field--check">
                    <input
                      type="radio"
                      name="swap-allowance"
                      value={entry}
                      checked={allowance === entry}
                      disabled={entry !== 'onchain' && (!v2 || (entry === 'permit' && noPermit))}
                      onChange={() => setAllowance(entry)}
                    />
                    <span>{t(`allowance_${entry}`)}</span> <small className="muted">{t(`allowanceHint_${entry}`)}</small>
                  </label>
                ))}
              </div>
              {allowance === 'standing' && (
                <>
                  <label className="field">
                    <span id={`${ids.note}-expires`}>{t('allowanceExpires')}</span>
                    <select
                      aria-labelledby={`${ids.note}-expires`}
                      value={String(standingSeconds)}
                      onChange={(event) => setStandingSeconds(Number(event.target.value))}
                    >
                      {STANDING_CHOICES.filter(
                        (choice) => v2?.permitLifetimeCapSeconds == null || choice <= v2.permitLifetimeCapSeconds,
                      ).map((choice) => (
                        <option key={choice} value={choice}>
                          {t(EXPIRES_KEY[choice as keyof typeof EXPIRES_KEY])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="numeric" data-testid="allowance-expiry">
                    {t('allowanceExpiry', { time: dateTime(Math.floor(now / 1000) + standingSeconds) })}
                  </p>
                  {approvalRoute?.standing && (
                    <p className="numeric">
                      {t('standingInPlace', {
                        amount: formatUnits(BigInt(approvalRoute.standing.amount), tokenIn.decimals),
                        token: tokenIn.name,
                        time: dateTime(BigInt(approvalRoute.standing.expiration)),
                      })}
                    </p>
                  )}
                  {approvalRoute?.standing && !renewStanding && (
                    <Button variant="secondary" onClick={() => setRenewStanding(true)}>
                      {t('renewStanding')}
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {v2Swap && (
            <>
              <Field
                label={t('deadlineField')}
                hint={t('deadlineHint')}
                value={deadlineText}
                autoComplete="off"
                onChange={(event) => {
                  setProblem(null);
                  setDeadlineText(event.target.value);
                }}
              />
              {deadlineSeconds !== null && !deadlineProblem && (
                <p className="numeric" data-testid="deadline">
                  {t('deadlineLine', { time: dateTime(deadlineSeconds) })}
                </p>
              )}
              {deadlineProblem && <p role="alert">{deadlineProblem}</p>}
            </>
          )}
          {pathProblem && <p role="alert">{pathProblem}</p>}
          <NetworkFee
            fees={fees.resource}
            retry={fees.reload}
            choice={feeChoice}
            onChoice={setFeeChoice}
            custom={customFee}
            onCustom={setCustomFee}
            refusal={feeAlert}
            payIn={{
              value: payIn,
              tokens: payTokens,
              label: (token) => tokenLabel(token, payTokens),
              onChange: choosePayIn,
              fee: tokenFee,
              refusal: payInProblem,
            }}
          />
          <Button type="submit" disabled={!canSwap}>
            {t('swap')}
          </Button>
          {shownReason && !overCeiling && shownReason !== feeAlert && shownReason !== pathProblem && shownReason !== deadlineProblem && (
            <p className="protocol-actions__reason" data-swap-reason>
              {shownReason}
            </p>
          )}
          {problem && <p role="alert">{problem}</p>}
        </form>
        {notice && (
          <Dialog title={t('manualTitle')} onClose={() => closeNotice(false)}>
            <p>{t('manualBody')}</p>
            <Button onClick={() => closeNotice(true)}>{t('manualAccept')}</Button>
          </Dialog>
        )}
      </Panel>
      {track && (
        <SwapStatus
          track={track}
          onNewQuote={() => {
            setTrack(null);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

/**
 * The card's network fee: in TEST ETH from the receipt when the person's wallet paid it; in the fee token when the fee
 * relay did, as its FeeCharged event says it took. A relayed swap that reverted took no fee: the whole call undid itself.
 */
function feeShown(track: Track, t: ReturnType<typeof swapCopy.forLocale>['t']): string {
  if (track.feeIn) {
    if (track.feeIn.charged !== undefined)
      return `${formatUnits(track.feeIn.charged, track.feeIn.token.decimals, track.feeIn.token.decimals)} ${track.feeIn.token.name}`;
    if (track.state === 'failed') return track.feeWei !== undefined ? t('feeNoneReverted') : t('noFeeNotMined');
    return t('notMined');
  }
  if (track.feeWei !== undefined) return `${formatUnits(track.feeWei, 18, 9)} ETH`;
  return track.state === 'failed' ? t('noFeeNotMined') : t('notMined');
}

function SwapStatus({ track, onNewQuote }: { track: Track; onNewQuote: () => void }) {
  const { language } = usePreferences();
  const { t } = swapCopy.forLocale(language);
  return (
    <Panel title={t('statusTitle')}>
      <section aria-label={t('statusTitle')}>
        <p role="status" data-swap-state={track.state}>
          {t(`state_${track.state}`)}
        </p>
        {track.state === 'failed' && <p>{track.reason ?? t('failedOther')}</p>}
        <dl className="protocol-facts">
          <div>
            <dt>{t('paid')}</dt>
            <dd className="numeric">
              {track.state === 'failed'
                ? t('nothingPaid')
                : track.paidAtMost
                  ? t('paidAtMost', {
                      amount: formatUnits(track.amountIn, track.tokenIn.decimals, track.tokenIn.decimals),
                      token: track.tokenIn.name,
                    })
                  : `${formatUnits(track.amountIn, track.tokenIn.decimals, track.tokenIn.decimals)} ${track.tokenIn.name}`}
            </dd>
          </div>
          <div>
            <dt>{t('received')}</dt>
            <dd className="numeric">
              {track.received !== undefined
                ? `${formatUnits(track.received, track.tokenOut.decimals)} ${track.tokenOut.name}`
                : track.state === 'failed'
                  ? t('nothingReceived')
                  : t('notMined')}
            </dd>
          </div>
          <div>
            <dt>{t('networkFee')}</dt>
            <dd className="numeric">{feeShown(track, t)}</dd>
          </div>
        </dl>
        {track.hash && (
          <a
            className="text-link"
            href={`/chain/tx/${track.hash}`}
            onClick={(event) => {
              event.preventDefault();
              navigate(`/chain/tx/${track.hash}`);
            }}
          >
            {t('swapEvent')}
          </a>
        )}
        {track.state === 'failed' && <Button onClick={onNewQuote}>{t('newQuote')}</Button>}
      </section>
    </Panel>
  );
}
