import { useEffect, useId, useMemo, useState } from 'react';
import type { LiquidityQuoteAdd, LiquidityQuoteSwapAdd } from '@intafaced/contracts/protocol-liquidity';
import { navigate } from '../../../app/location';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { ServiceOffNotice } from '../../../shared/service-off';
import { Button, Field, Loading, Panel } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { networkLabel } from '../blockers';
import { WatchShell } from '../watch/AddressPage';
import { APP_CHAIN_ID } from '../wallet/eip1193';
import { liquidityCopy } from './copy';
import { amountText, bpsPercent, toUnits } from './format';
import { refusalCode } from './liquidity-api';
import { NoWalletNote, useLiquiditySigning } from './signing';

const SHARE_DECIMALS = 18;
const NO_NETWORK = new Set(['protocol.amm_factory_unset', 'protocol.chain_unreachable', 'protocol.liquidity_router_unset']);

type Quoted = { kind: 'pair'; quote: LiquidityQuoteAdd; at: number } | { kind: 'one'; quote: LiquidityQuoteSwapAdd; at: number };

/**
 * /dex/pools/:poolId/add (D-liquidity-02, -04, J-dex-protocol-12 #4, #7): what to offer of both tokens, of which only
 * the pool's ratio is taken, or one token with swap-and-add, which swaps about half first and adds both in the same
 * transaction. The quote is read from the pool now and lives for the owner's quote lifetime; after it, the form asks to
 * refresh it. The person's minimum shares bounds the call: a pool that would mint fewer reverts, and the contract's
 * reason is shown.
 */
export function AddLiquidity({ pool }: { pool: string }) {
  const { language } = usePreferences();
  const { t } = liquidityCopy.forLocale(language);
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const signing = useLiquiditySigning(t);
  const { wallet, liquidity } = signing;
  const pairs = useResource((signal) => protocol.ammPairs(signal), `liquidity:add:pairs:${pool}`);
  const [oneToken, setOneToken] = useState(false);
  const [amount0, setAmount0] = useState('');
  const [amount1, setAmount1] = useState('');
  const [single, setSingle] = useState<'0' | '1'>('0');
  const [singleAmount, setSingleAmount] = useState('');
  const [minShares, setMinShares] = useState('');
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [noNetwork, setNoNetwork] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const toggleId = useId();

  const row =
    pairs.resource.status === 'ready' ? pairs.resource.data.pools.find((p) => p.pool.toLowerCase() === pool.toLowerCase()) : undefined;
  const token = (address: string | undefined) =>
    pairs.resource.status === 'ready' && address
      ? (pairs.resource.data.tokens.find((x) => x.address.toLowerCase() === address.toLowerCase()) ?? null)
      : null;
  const token0 = token(row?.token0);
  const token1 = token(row?.token1);
  const units0 = token0 ? toUnits(amount0, token0.decimals) : null;
  const units1 = token1 ? toUnits(amount1, token1.decimals) : null;
  const singleToken = single === '0' ? token0 : token1;
  const singleUnits = singleToken ? toUnits(singleAmount, singleToken.decimals) : null;

  // The quote, read again whenever the offer changes or the person refreshes it.
  const quoteKey = oneToken ? `one:${single}:${singleUnits ?? ''}` : `pair:${units0 ?? ''}:${units1 ?? ''}`;
  useEffect(() => {
    setQuoted(null);
    if (!row) return;
    const controller = new AbortController();
    const at = Date.now();
    const read = oneToken
      ? singleUnits !== null && singleToken
        ? liquidity
            .quoteSwapAdd({ pool: row.pool, tokenIn: singleToken.address, amountIn: singleUnits.toString() }, controller.signal)
            .then((answer) => (answer.ok ? ({ kind: 'one', quote: answer.data, at } as Quoted) : answer))
        : null
      : units0 !== null && units1 !== null
        ? liquidity
            .quoteAdd({ pool: row.pool, amount0Desired: units0.toString(), amount1Desired: units1.toString() }, controller.signal)
            .then((answer) => (answer.ok ? ({ kind: 'pair', quote: answer.data, at } as Quoted) : answer))
        : null;
    void read?.then((answer) => {
      if (controller.signal.aborted) return;
      if ('kind' in answer) {
        setQuoted(answer);
        setMinShares(amountText(answer.quote.shares, SHARE_DECIMALS, SHARE_DECIMALS));
        setProblem(null);
      } else if (NO_NETWORK.has(refusalCode(answer) ?? '')) setNoNetwork(true);
      else setProblem(t('refused', { reason: answer.message.replace(/^[a-z_]+\.[a-z_.]+: /, '') }));
    });
    return () => controller.abort();
  }, [row?.pool, quoteKey, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const ttl = quoted ? quoted.quote.quoteTtlSeconds : null;
  const left = quoted && ttl !== null ? Math.max(0, Math.ceil((quoted.at + ttl * 1000 - now) / 1000)) : null;
  const stale = left === 0;
  const minUnits = toUnits(minShares, SHARE_DECIMALS);

  const add = async () => {
    if (!row || !token0 || !token1 || !quoted || stale || minUnits === null || !wallet.address) return;
    setProblem(null);
    setDone(null);
    setBusy(true);
    try {
      const gate = await signing.withRepresentation(async () => {
        const owner = wallet.address!;
        if (quoted.kind === 'pair' && units0 !== null && units1 !== null) {
          const built = await liquidity.buildAdd({
            owner,
            pool: row.pool,
            amount0Desired: units0.toString(),
            amount1Desired: units1.toString(),
            minShares: minUnits.toString(),
          });
          if (!built.ok) return setProblem(t('refused', { reason: built.message.replace(/^[a-z_]+\.[a-z_.]+: /, '') }));
          const [shown0, shown1] = [amountText(quoted.quote.amount0, token0.decimals), amountText(quoted.quote.amount1, token1.decimals)];
          const [a0, a1] = await Promise.all([
            signing.approvals(token0, built.data.router, BigInt(quoted.quote.amount0), shown0),
            signing.approvals(token1, built.data.router, BigInt(quoted.quote.amount1), shown1),
          ]);
          if (!a0.ok) return setProblem(a0.reason);
          if (!a1.ok) return setProblem(a1.reason);
          const outcome = await signing.send(
            {
              title: t('stepsAdd'),
              steps: [
                ...a0.steps,
                ...a1.steps,
                {
                  label: t('stepAdd', { amount0: shown0, symbol0: token0.name, amount1: shown1, symbol1: token1.name, shares: minShares }),
                  request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data },
                },
              ],
              facts: [
                { label: token0.name, value: token0.address },
                { label: token1.name, value: token1.address },
              ],
            },
            built.data.call,
          );
          if (outcome.ok) setDone(t('added', { shares: amountText(quoted.quote.shares, SHARE_DECIMALS) }));
          else setProblem(outcome.reason);
          return;
        }
        if (quoted.kind === 'one' && singleToken && singleUnits !== null) {
          const built = await liquidity.buildSwapAdd({
            owner,
            pool: row.pool,
            tokenIn: singleToken.address,
            amountIn: singleUnits.toString(),
            minShares: minUnits.toString(),
          });
          if (!built.ok) return setProblem(t('refused', { reason: built.message.replace(/^[a-z_]+\.[a-z_.]+: /, '') }));
          const shown = amountText(singleUnits, singleToken.decimals);
          const approve = await signing.approvals(singleToken, built.data.router, singleUnits, shown);
          if (!approve.ok) return setProblem(approve.reason);
          const outcome = await signing.send(
            {
              title: t('stepsAdd'),
              steps: [
                ...approve.steps,
                {
                  label: t('stepSwapAdd', { amount: shown, symbol: singleToken.name, shares: minShares }),
                  request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data },
                },
              ],
              facts: [{ label: singleToken.name, value: singleToken.address }],
            },
            built.data.call,
          );
          if (outcome.ok) setDone(t('added', { shares: amountText(quoted.quote.shares, SHARE_DECIMALS) }));
          // One transaction: a failed add undid the swap with it, which the person is told in so many words.
          else setProblem(`${outcome.reason} ${t('nothingHalfDone')}`);
        }
      });
      if (gate) setProblem(gate);
    } finally {
      setBusy(false);
    }
  };

  const network = networkLabel(APP_CHAIN_ID).name;
  const title = token0 && token1 ? `${t('addTitle')}: ${token0.symbol} / ${token1.symbol} · ${bpsPercent(row!.feeBps)}%` : t('addTitle');
  return (
    <WatchShell title={title} description={t('network', { network })}>
      {signing.panel}
      <Panel title={t('addTitle')}>
        {!wallet.address && <NoWalletNote t={t} />}
        {(noNetwork || (pairs.resource.status === 'failed' && NO_NETWORK.has(refusalCode(pairs.resource.failure) ?? ''))) && (
          <ServiceOffNotice code="rail.crypto" action={t('addTitle')} role="status" />
        )}
        {pairs.resource.status === 'loading' && <Loading label={t('addTitle')} />}
        {pairs.resource.status === 'ready' && !row && <p role="status">{t('positionUnread', { reason: pool })}</p>}
        <form
          aria-label={t('addTitle')}
          className="protocol-quote"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="field field--check" htmlFor={toggleId}>
            <input id={toggleId} type="checkbox" checked={oneToken} onChange={(event) => setOneToken(event.target.checked)} />
            <span>{t('swapAddToggle')}</span>
          </label>
          {!oneToken ? (
            <>
              <Field label={token0?.name ?? '—'} inputMode="decimal" value={amount0} onChange={(event) => setAmount0(event.target.value)} />
              <Field label={token1?.name ?? '—'} inputMode="decimal" value={amount1} onChange={(event) => setAmount1(event.target.value)} />
              {quoted?.kind === 'pair' && token0 && token1 && (
                <>
                  <p className="numeric" data-testid="pulled">
                    {t('pulled', {
                      amount0: amountText(quoted.quote.amount0, token0.decimals),
                      symbol0: token0.name,
                      amount1: amountText(quoted.quote.amount1, token1.decimals),
                      symbol1: token1.name,
                    })}
                  </p>
                  <p className="muted">{t('pulledNote')}</p>
                  <p className="numeric">
                    {t('willMint', {
                      shares: amountText(quoted.quote.shares, SHARE_DECIMALS),
                      share: bpsPercent(quoted.quote.shareOfPoolBps),
                    })}
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>{t('oneToken')}</span>
                <select value={single} onChange={(event) => setSingle(event.target.value as '0' | '1')} aria-label={t('oneToken')}>
                  {token0 && <option value="0">{token0.name}</option>}
                  {token1 && <option value="1">{token1.name}</option>}
                </select>
              </label>
              <Field
                label={singleToken?.name ?? '—'}
                inputMode="decimal"
                value={singleAmount}
                onChange={(event) => setSingleAmount(event.target.value)}
              />
              {quoted?.kind === 'one' && singleToken && (
                <>
                  <p className="numeric" data-testid="swap-half">
                    {t('swapHalf', { amount: amountText(quoted.quote.swapped, singleToken.decimals, 2), symbol: singleToken.name })}
                  </p>
                  <p className="numeric">{t('willMint', { shares: amountText(quoted.quote.shares, SHARE_DECIMALS), share: '—' })}</p>
                </>
              )}
              <p role="note">{t('atomic')}</p>
            </>
          )}
          <Field
            label={t('minShares')}
            hint={t('minSharesHint')}
            inputMode="decimal"
            value={minShares}
            onChange={(event) => setMinShares(event.target.value)}
          />
          {quoted && !stale && left !== null && <p className="muted">{t('quoteValid', { seconds: String(left) })}</p>}
          {stale && ttl !== null && (
            <>
              <p role="status">{t('quoteStale', { seconds: String(ttl) })}</p>
              <Button variant="secondary" onClick={() => setRefresh((n) => n + 1)}>
                {t('refreshQuote')}
              </Button>
            </>
          )}
          <Button type="submit" disabled={busy || !quoted || stale || minUnits === null || !wallet.address}>
            {t('add')}
          </Button>
          {problem && <p role="alert">{problem}</p>}
          {signing.gateProblem && <p role="alert">{signing.gateProblem}</p>}
        </form>
        {done && <p role="status">{done}</p>}
      </Panel>
      <Button variant="secondary" onClick={() => navigate(`/dex/pools/${pool}`)}>
        {t('backToPools')}
      </Button>
    </WatchShell>
  );
}
