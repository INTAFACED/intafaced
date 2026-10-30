import { useEffect, useId, useState } from 'react';
import type { TokenBasics, TokenPageData } from '@intafaced/contracts/protocol-tokens';
import { Button, Failure, Field, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import type { ProtocolApi, RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE, useRegionBlocked } from '../region';
import { swapCopy } from '../swap/copy';
import { bpsToPercent, minimumOut } from '../swap/swap-math';
import { RepresentationPanel } from '../wallet/RepresentationPanel';
import { toBaseUnits } from '../wallet/transfer';
import { useWallet } from '../wallet/WalletProvider';
import type { TokensTranslate } from './copy';
import { exactUnits } from './format';
import { balanceOfCall, deepestPair, readUnits } from './quick-ticket';

type Side = 'buy' | 'sell';
type Pair = TokenPageData['pairs'][number];
type Quote = { key: string; amountOut: bigint; priceImpactBps: number } | { key: string; refused: true };
type Follow = { hash: string; state: 'pending' | 'mined' | 'reverted' };

/**
 * The token page's quick ticket (D-portfolio-wallet-07): buy or sell this token in one of its pools, with 25, 50 and 100
 * percent shortcuts of the wallet's balance of the token paid. It quotes like the swap form in Simple mode (the minimum at
 * the owner's slippage ceiling, a note when the trade moves the pool by more), and Review takes the same path: the
 * representation gate first, then a fresh quote, the allowance and the built swap, all under one plain-words sheet the
 * person's wallet signs. The ticket follows the swap until it is mined. Nothing posts to the ledger; a balance the wallet
 * cannot read, a blank setting or a refused quote stops the ticket in words.
 */
export function QuickTicket({ data, api, t }: { data: TokenPageData; api: ProtocolApi; t: TokensTranslate }) {
  const { language } = usePreferences();
  const swap = swapCopy.forLocale(language).t;
  const wallet = useWallet();
  const regionBlocked = useRegionBlocked();
  const settings = useResource((signal) => api.swapSettings(signal), 'swap:settings');
  const setting = settings.resource.status === 'ready' ? settings.resource.data : null;
  const [side, setSide] = useState<Side>('buy');
  const [poolAddress, setPool] = useState(() => deepestPair(data.pairs)?.pool ?? '');
  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<bigint | null | 'unread'>(null);
  const [reads, setReads] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [follow, setFollow] = useState<Follow | null>(null);
  const [representation, setRepresentation] = useState<{ address: string; status: RepresentationStatus } | null>(null);
  const ids = { pool: useId(), note: useId() };

  const pair: Pair | null = data.pairs.find((p) => p.pool.toLowerCase() === poolAddress.toLowerCase()) ?? null;
  const token: TokenBasics = data.token;
  const paid = pair ? (side === 'buy' ? pair.other : token) : null;
  const received = pair ? (side === 'buy' ? token : pair.other) : null;
  const connected = wallet.status === 'connected' && wallet.address !== null;
  const wrongNetwork = connected && wallet.guard !== null && !wallet.guard.ok;
  const owner = connected && wallet.guard?.ok === true ? wallet.address : null;
  const pending = follow?.state === 'pending';

  // The balance of the token paid, read through the person's own wallet; read again on request and once a swap is mined.
  useEffect(() => {
    setBalance(null);
    if (!owner || !paid) return;
    let stopped = false;
    void wallet.call(paid.address, balanceOfCall(owner)).then(
      (answer) => {
        if (!stopped) setBalance(readUnits(answer) ?? 'unread');
      },
      () => {
        if (!stopped) setBalance('unread');
      },
    );
    return () => {
      stopped = true;
    };
    // The wallet object is rebuilt each render; the read is named by the owner, the token and the read count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, paid?.address, reads]);

  const amountIn = paid ? toBaseUnits(amount, paid.decimals) : null;
  const quoteKey = pair && paid && amountIn !== null ? `${pair.pool}:${paid.address}:${amountIn}` : null;

  // The quote shown before Review, read from the pool now; Review reads it again right before it builds the swap.
  useEffect(() => {
    if (!quoteKey || !pair || !paid || amountIn === null) return;
    const controller = new AbortController();
    void api.poolQuote({ pool: pair.pool, tokenIn: paid.address, amountIn: amountIn.toString() }, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      setQuote(
        answer.ok
          ? { key: quoteKey, amountOut: BigInt(answer.data.amountOut), priceImpactBps: answer.data.priceImpactBps }
          : { key: quoteKey, refused: true },
      );
    });
    return () => controller.abort();
    // The quote is named by its key: the pool, the token paid and the amount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, quoteKey]);

  // Follows the last swap by its hash until it is mined, then reads the balance again.
  useEffect(() => {
    if (!follow || follow.state !== 'pending') return;
    let stopped = false;
    const timer = setInterval(() => {
      void (wallet.read('eth_getTransactionReceipt', [follow.hash]) as Promise<{ status?: string; blockNumber?: string } | null>).then(
        (receipt) => {
          if (stopped || !receipt?.blockNumber) return;
          setFollow({ hash: follow.hash, state: receipt.status === '0x0' ? 'reverted' : 'mined' });
          setReads((n) => n + 1);
        },
      );
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // Follows one hash; the wallet object is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow?.hash, follow?.state]);

  const shown = quote && quote.key === quoteKey ? quote : null;
  const minOut = shown && !('refused' in shown) && setting ? minimumOut(shown.amountOut, setting.slippageCeilingBps) : null;
  const reason = regionBlocked
    ? swap('regionBlocked')
    : !pair || !paid || !received
      ? t('quickNoPairs')
      : !owner
        ? swap('needsWallet')
        : settings.resource.status === 'failed'
          ? t('quickSettingsUnread')
          : !setting
            ? t('quickReadingSettings')
            : balance === 'unread'
              ? t('quickBalanceUnread')
              : balance === null
                ? t('quickReadingBalance')
                : amountIn === null
                  ? t('quickNeedsAmount', { decimals: String(paid.decimals) })
                  : amountIn > balance
                    ? t('quickOverBalance')
                    : !shown
                      ? swap('quoting')
                      : 'refused' in shown
                        ? swap('quoteRefused')
                        : minOut === null
                          ? swap('minimumNone')
                          : pending
                            ? t('quickPending')
                            : null;

  const share = (percent: bigint) => {
    if (typeof balance !== 'bigint' || !paid) return;
    setAmount(exactUnits(((balance * percent) / 100n).toString(), paid.decimals));
    setProblem(null);
  };
  const clear = () => {
    setAmount('');
    setProblem(null);
  };

  const send = async (from: string, chosen: Pair, inToken: TokenBasics, outToken: TokenBasics, units: bigint, bps: number) => {
    // The pool is read again right before the swap is built and the minimum taken from that read, as the swap form does:
    // the service checks the minimum against its own fresh read, so a stale one would be refused.
    const fresh = await api.poolQuote({ pool: chosen.pool, tokenIn: inToken.address, amountIn: units.toString() });
    if (!fresh.ok) return setProblem(swap('quoteRefused'));
    const min = minimumOut(BigInt(fresh.data.amountOut), bps);
    if (min === null) return setProblem(swap('minimumNone'));
    const [approval, call] = await Promise.all([
      api.checkApproval({ owner: from, token: inToken.address, spender: chosen.pool, amount: units.toString() }),
      api.buildSwap({ pool: chosen.pool, tokenIn: inToken.address, amountIn: units.toString(), minAmountOut: min.toString(), to: from }),
    ]);
    if (!approval.ok) return setProblem(swap('approvalUnread'));
    if (!call.ok) return setProblem(call.code === 'protocol.swap_min_out_below_bound' ? swap('minimumBelow') : swap('buildRefused'));
    const amountText = exactUnits(units.toString(), inToken.decimals);
    const name = (basics: TokenBasics) => basics.name || basics.symbol || basics.address;
    const steps = [
      ...approval.data.calls.map((approve, index) => ({
        label:
          approval.data.resetFirst && index === 0
            ? swap('stepReset', { token: name(inToken) })
            : swap('stepApprove', { amount: amountText, token: name(inToken) }),
        request: { kind: 'transaction' as const, to: approve.to, data: approve.data },
      })),
      {
        label: swap('stepSwap', {
          amount: amountText,
          tokenIn: name(inToken),
          min: exactUnits(min.toString(), outToken.decimals),
          tokenOut: name(outToken),
        }),
        request: { kind: 'transaction' as const, to: call.data.to, data: call.data.data },
      },
    ];
    // Anyone can list a token, so the sheet names each token's contract, not only its name.
    const facts = [
      { label: swap('contractOf', { token: name(inToken) }), value: inToken.address },
      { label: swap('contractOf', { token: name(outToken) }), value: outToken.address },
    ];
    const result = await wallet.sendSequence({ title: swap('stepsTitle'), steps, facts });
    // Steps already sent stay sent: say so with their hashes, never "nothing was sent".
    const earlier =
      result.status === 'sent' ? '' : result.sent.length > 0 ? ` ${swap('earlierSent', { hashes: result.sent.join(', ') })}` : '';
    if (result.status === 'rejected') return setProblem(`${result.sent.length > 0 ? swap('rejectedAfter') : swap('rejected')}${earlier}`);
    if (result.status === 'failed') return setProblem(`${result.message}${earlier}`);
    setFollow({ hash: result.hashes[result.hashes.length - 1]!, state: 'pending' });
    setAmount('');
  };

  const review = async () => {
    if (reason !== null || busy || !owner || !pair || !paid || !received || amountIn === null || !setting) return;
    setProblem(null);
    setFollow(null);
    setBusy(true);
    try {
      // A trade is a signing action: the representation gate comes first and never fails open.
      const gate = await api.representationStatus(owner);
      if (!gate.ok)
        return setProblem(
          gate.code === REGION_BLOCKED_CODE
            ? swap('regionBlocked')
            : gate.code === 'compliance.representation_unset'
              ? swap('representationUnset')
              : swap('representationUnread'),
        );
      if (!gate.data.accepted) return setRepresentation({ address: owner, status: gate.data });
      await send(owner, pair, paid, received, amountIn, setting.slippageCeilingBps);
    } finally {
      setBusy(false);
    }
  };

  const symbol = (basics: TokenBasics) => basics.symbol || t('noSymbol');
  const locked = busy || representation !== null;
  return (
    <Panel title={t('quickTitle')}>
      {settings.resource.status === 'failed' && <Failure result={settings.resource.failure} retry={settings.reload} />}
      <form
        aria-label={t('quickTitle')}
        aria-describedby={ids.note}
        onSubmit={(event) => {
          event.preventDefault();
          void review();
        }}
      >
        <p className="muted" id={ids.note}>
          {t('quickNote')}
        </p>
        <div className="protocol-actions" role="group" aria-label={t('quickSide')}>
          {(['buy', 'sell'] as const).map((id) => (
            <Button
              key={id}
              type="button"
              variant={side === id ? 'primary' : 'secondary'}
              aria-pressed={side === id}
              disabled={locked}
              onClick={() => {
                setSide(id);
                clear();
              }}
            >
              {t(id === 'buy' ? 'quickBuy' : 'quickSell', { symbol: symbol(token) })}
            </Button>
          ))}
        </div>
        {data.pairs.length > 1 && (
          <label className="field" htmlFor={ids.pool}>
            <span>{t('quickPool')}</span>
            <select
              id={ids.pool}
              value={poolAddress}
              disabled={locked}
              onChange={(event) => {
                // Another pool can be paid in another token, so an amount typed for the first one is not carried over.
                setPool(event.target.value);
                clear();
              }}
            >
              {data.pairs.map((p) => (
                <option key={p.pool} value={p.pool}>
                  {t('quickPoolOption', { symbol: symbol(p.other), address: p.other.address })}
                </option>
              ))}
            </select>
          </label>
        )}
        {!connected && !regionBlocked && pair && (
          <div className="protocol-actions">
            {wallet.wallets.length === 0 ? (
              <p className="muted">{t('quickNoWallet')}</p>
            ) : (
              wallet.wallets.map((entry) => (
                <Button
                  key={entry.info.uuid}
                  type="button"
                  disabled={wallet.status === 'connecting'}
                  onClick={() => void wallet.connect(entry)}
                >
                  {t('quickConnect', { name: entry.info.name })}
                </Button>
              ))
            )}
          </div>
        )}
        {wrongNetwork && (
          <Button type="button" onClick={() => void wallet.switchNetwork()}>
            {t('quickSwitch')}
          </Button>
        )}
        {wallet.problem && <p role="status">{wallet.problem}</p>}
        {paid && typeof balance === 'bigint' && (
          <p>
            {t('quickBalance')}{' '}
            <span data-testid="quick-balance" data-units={balance.toString()}>
              {exactUnits(balance.toString(), paid.decimals)}
            </span>{' '}
            {symbol(paid)}
          </p>
        )}
        {balance === 'unread' && (
          <Button type="button" variant="secondary" onClick={() => setReads((n) => n + 1)}>
            {t('quickReadAgain')}
          </Button>
        )}
        <Field
          label={t('quickAmount')}
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          disabled={locked}
          onChange={(event) => setAmount(event.target.value.trim())}
        />
        <div className="protocol-actions" role="group" aria-label={t('quickShares')}>
          {[25n, 50n, 100n].map((percent) => (
            <Button
              key={String(percent)}
              type="button"
              variant="secondary"
              disabled={locked || typeof balance !== 'bigint'}
              onClick={() => share(percent)}
            >
              {`${percent}%`}
            </Button>
          ))}
        </div>
        {received && shown && !('refused' in shown) && minOut !== null && (
          <p data-testid="quick-quote">
            {t('quickReceive', {
              amount: exactUnits(shown.amountOut.toString(), received.decimals),
              min: exactUnits(minOut.toString(), received.decimals),
              symbol: symbol(received),
            })}
          </p>
        )}
        {setting && shown && !('refused' in shown) && shown.priceImpactBps > setting.slippageCeilingBps && (
          <p role="note">{swap('priceImpact', { impact: bpsToPercent(shown.priceImpactBps) })}</p>
        )}
        {reason !== null && <p className="muted">{reason}</p>}
        <Button type="submit" disabled={reason !== null || locked}>
          {t('quickReview')}
        </Button>
        {problem && <p role="alert">{problem}</p>}
        {follow && <p role="status">{t(`quickFollow_${follow.state}`, { hash: follow.hash })}</p>}
      </form>
      {representation && (
        <RepresentationPanel
          address={representation.address}
          status={representation.status}
          api={api}
          onEnd={(end) => {
            setRepresentation(null);
            if (end.kind === 'accepted') void review();
            else if (end.kind === 'rejected') setProblem(swap('rejected'));
            else if (end.kind === 'region') setProblem(swap('regionBlocked'));
            else setProblem(end.message);
          }}
        />
      )}
    </Panel>
  );
}
