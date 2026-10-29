import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ProtocolPoolQuote, ProtocolSwapPool, ProtocolSwapToken } from '@intafaced/contracts/protocol-swap';
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
import { tokenLabel, toBaseUnits } from '../wallet/transfer';
import { useWallet } from '../wallet/WalletProvider';
import { swapCopy } from './copy';
import { keepMode, readMode, type SwapMode } from './mode';
import { bpsToPercent, formatUnits, minimumOut, percentToBps, poolsFor, receivedIn } from './swap-math';

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
  const [refresh, setRefresh] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteProblem, setQuoteProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [representation, setRepresentation] = useState<{ address: string; status: RepresentationStatus } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const ids = { pay: useId(), receive: useId(), note: useId() };

  const tokenIn = tokens.find((token) => token.address.toLowerCase() === tokenInAddress.toLowerCase()) ?? null;
  const tokenOut = tokens.find((token) => token.address.toLowerCase() === tokenOutAddress.toLowerCase()) ?? null;
  const amountIn = tokenIn ? toBaseUnits(amount, tokenIn.decimals) : null;
  const candidates = tokenIn && tokenOut ? poolsFor(pools, tokenIn.address, tokenOut.address) : [];
  const candidateKey = candidates.map((pool) => pool.pool).join(',');

  // Quote: every pool for the pair, read now; the most received wins. A new input or a refresh reads again.
  useEffect(() => {
    setQuote(null);
    setQuoteProblem(null);
    if (!tokenIn || !tokenOut || amountIn === null || candidates.length === 0) return;
    const controller = new AbortController();
    void Promise.all(
      candidates.map(async (pool) => ({
        pool,
        result: await api.poolQuote({ pool: pool.pool, tokenIn: tokenIn.address, amountIn: amountIn.toString() }, controller.signal),
      })),
    ).then((answers) => {
      if (controller.signal.aborted) return;
      const quoted = answers.flatMap((answer) => (answer.result.ok ? [{ pool: answer.pool, quote: answer.result.data }] : []));
      if (quoted.length === 0) return setQuoteProblem(t('quoteRefused'));
      const best = quoted.reduce((a, b) => (BigInt(b.quote.amountOut) > BigInt(a.quote.amountOut) ? b : a));
      setNow(Date.now());
      setQuote({ ...best, amountIn, readAt: Date.now() });
    });
    return () => controller.abort();
    // The inputs are named by their values; the objects are rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tokenIn?.address, tokenOut?.address, amountIn?.toString(), candidateKey, refresh]);

  const expiresAt = quote && setting ? quote.readAt + setting.quoteTtlSeconds * 1000 : null;
  const expired = expiresAt !== null && now >= expiresAt;
  useEffect(() => {
    if (expiresAt === null || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, expired]);

  const slippageBps = mode === 'manual' && slippage.trim() !== '' ? percentToBps(slippage) : (setting?.slippageCeilingBps ?? null);
  const overCeiling = setting !== null && slippageBps !== null && slippageBps > setting.slippageCeilingBps;
  const minOut = quote && slippageBps !== null && !overCeiling ? minimumOut(BigInt(quote.quote.amountOut), slippageBps) : null;
  // Price impact is already in the quote; the note says how far this trade moves the pool when that is more than the
  // slippage in use, so a person sees a thin pool before they swap. It does not stop the swap.
  const impactNoted = quote !== null && slippageBps !== null && quote.quote.priceImpactBps > slippageBps;

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
                    : expired
                      ? t('needsRefresh')
                      : slippageBps === null
                        ? t('slippageInvalid')
                        : overCeiling
                          ? t('slippageOver', { ceiling: bpsToPercent(setting!.slippageCeilingBps) })
                          : minOut === null
                            ? t('minimumNone')
                            : null;
  const following = track?.state === 'submitted' || track?.state === 'confirming';
  const canSwap = reason === null && !busy && !following;

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
        request: { kind: 'transaction' as const, to: approve.to, data: approve.data },
      })),
      {
        label: t('stepSwap', {
          amount: amountText,
          tokenIn: inToken.name,
          min: formatUnits(min, outToken.decimals),
          tokenOut: outToken.name,
        }),
        request: { kind: 'transaction' as const, to: call.data.to, data: call.data.data },
      },
    ];
    const base = { amountIn: from.amountIn, minOut: min, tokenIn: inToken, tokenOut: outToken, pool: from.pool.pool };
    const result = await wallet.sendSequence({ title: t('stepsTitle'), steps });
    // Steps already sent stay sent: say so with their hashes, never "nothing was sent".
    const earlier =
      result.status === 'sent' ? '' : result.sent.length > 0 ? ` ${t('earlierSent', { hashes: result.sent.join(', ') })}` : '';
    if (result.status === 'rejected') return setProblem(`${result.sent.length > 0 ? t('rejectedAfter') : t('rejected')}${earlier}`);
    if (result.status === 'failed') {
      // The swap step itself failed before it was mined: say why in a sentence when the pool shows it.
      if (result.step === steps.length - 1)
        return setTrack({
          ...base,
          hash: null,
          state: 'failed',
          reason: `${await whyFailed(from.pool.pool, inToken.address, from.amountIn, min, result.message)}${earlier}`,
        });
      return setProblem(`${result.message}${earlier}`);
    }
    setTrack({ ...base, hash: result.hashes[result.hashes.length - 1]!, state: 'submitted' });
  };

  const startSwap = async () => {
    if (!canSwap || !quote || !tokenIn || !tokenOut || minOut === null || !wallet.address) return;
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
      await sendSwap(quote, tokenIn, tokenOut, slippageBps!, wallet.address);
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
          const reason = await whyFailed(current.pool, current.tokenIn.address, current.amountIn, current.minOut);
          if (!stopped) setTrack({ ...current, state: 'failed', reason, feeWei });
          return;
        }
        const head = (await wallet.read('eth_blockNumber', [])) as string | null;
        const deep = head ? BigInt(head) - BigInt(receipt.blockNumber) >= BigInt(setting.confirmations) : false;
        if (stopped) return;
        setTrack({
          ...current,
          state: deep ? 'filled' : 'confirming',
          received: receivedIn(receipt.logs ?? [], current.tokenOut.address, owner),
          feeWei,
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

  const tokenSelect = (id: string, label: string, value: string, set: (value: string) => void) => (
    <label className="field">
      <span id={id}>{label}</span>
      <select
        value={value}
        onChange={(event) => set(event.target.value)}
        aria-labelledby={id}
        aria-describedby={pairs.resource.status === 'ready' && tokens.length === 0 ? ids.note : undefined}
      >
        <option value="">{t('chooseToken')}</option>
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {tokenLabel(token, tokens)}
          </option>
        ))}
      </select>
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
          {tokenSelect(ids.pay, t('youPay'), tokenInAddress, setTokenIn)}
          {tokenSelect(ids.receive, t('youReceive'), tokenOutAddress, setTokenOut)}
          {pairs.resource.status === 'ready' && tokens.length === 0 && (
            <p className="muted" id={ids.note}>
              {t('noTokens', { network })}
            </p>
          )}
          <Field
            label={t('amountIn')}
            hint={t('amountHint')}
            inputMode="decimal"
            value={amount}
            autoComplete="off"
            onChange={(event) => setAmount(event.target.value)}
          />
          {quote && tokenOut && (
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
          {quote && expired && (
            <>
              <p role="status">{t('quoteExpired')}</p>
              <Button variant="secondary" onClick={() => setRefresh((value) => value + 1)}>
                {t('refreshQuote')}
              </Button>
            </>
          )}
          {minOut !== null && tokenOut && (
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
              <Button variant="secondary" disabled aria-disabled="true" title={t('routeNeedsQuote')}>
                {t('routeOptions')}
              </Button>
            </>
          )}
          {overCeiling && setting && <p role="alert">{t('slippageOver', { ceiling: bpsToPercent(setting.slippageCeilingBps) })}</p>}
          <Button type="submit" disabled={!canSwap}>
            {t('swap')}
          </Button>
          {reason && !overCeiling && (
            <p className="protocol-actions__reason" data-swap-reason>
              {reason}
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
            <dd className="numeric">
              {track.feeWei !== undefined
                ? `${formatUnits(track.feeWei, 18, 9)} ETH`
                : track.state === 'failed'
                  ? t('noFeeNotMined')
                  : t('notMined')}
            </dd>
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
