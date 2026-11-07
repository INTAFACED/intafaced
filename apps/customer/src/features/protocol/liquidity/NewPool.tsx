import { useEffect, useId, useMemo, useState } from 'react';
import { POOL_FEE_CAP_BPS } from '@intafaced/contracts/protocol-liquidity';
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
import { amountText, bpsPercent, percentToBps, priceText, toUnits } from './format';
import { refusalCode } from './liquidity-api';
import { NoWalletNote, useLiquiditySigning } from './signing';

const CUSTOM = 'custom';
/** The refusals that mean the network's pool factory or node is not there: shown as the crypto network notice. */
const NO_NETWORK = new Set(['protocol.amm_factory_unset', 'protocol.chain_unreachable', 'protocol.liquidity_router_unset']);

/**
 * /dex/pools/new (D-liquidity-03, J-dex-protocol-12 #2, #3): two tokens, a fee tier from the owner's published list or a
 * custom fee up to the pool contract's 10% cap, and the first deposit, which sets the starting price. A pair that already
 * has a pool at the chosen fee says so and offers Add liquidity instead. The person's wallet signs the exact approvals and
 * the one create-and-seed call. With no factory or node on the network the form keeps its layout and shows the crypto
 * network notice; with no tier list, only the custom entry.
 */
export function NewPool() {
  const { language } = usePreferences();
  const { t } = liquidityCopy.forLocale(language);
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const signing = useLiquiditySigning(t);
  const { wallet, liquidity } = signing;
  const ids = { a: useId(), b: useId(), tier: useId() };
  const pairs = useResource((signal) => protocol.ammPairs(signal), 'liquidity:new:pairs');
  const tiers = useResource((signal) => liquidity.feeTiers(signal), 'liquidity:new:tiers');
  const [tokenA, setTokenA] = useState('');
  const [tokenB, setTokenB] = useState('');
  const [tier, setTier] = useState('');
  const [customFee, setCustomFee] = useState('');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ words: string } | { notice: true } | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const tokens = pairs.resource.status === 'ready' ? pairs.resource.data.tokens : [];
  const tierList = tiers.resource.status === 'ready' ? tiers.resource.data.tiers : [];
  const tiersUnset = tiers.resource.status === 'failed' && refusalCode(tiers.resource.failure) === 'amm.fee_tiers_unset';
  const noNetwork =
    (pairs.resource.status === 'failed' && NO_NETWORK.has(refusalCode(pairs.resource.failure) ?? '')) ||
    (problem !== null && 'notice' in problem);

  const feeBps = tier === CUSTOM ? percentToBps(customFee) : tier === '' ? null : Number(tier);
  const feeProblem =
    tier !== CUSTOM || customFee.trim() === ''
      ? null
      : feeBps === null
        ? t('feeNotPercent')
        : feeBps > POOL_FEE_CAP_BPS
          ? t('feeAboveCap')
          : null;
  const a = tokens.find((x) => x.address === tokenA) ?? null;
  const b = tokens.find((x) => x.address === tokenB) ?? null;
  const unitsA = a ? toUnits(amountA, a.decimals) : null;
  const unitsB = b ? toUnits(amountB, b.decimals) : null;
  const usableFee = feeBps !== null && feeProblem === null && feeBps <= POOL_FEE_CAP_BPS ? feeBps : null;

  // Whether the pair already has a pool at this fee, read whenever the pair or the fee changes.
  const [exists, setExists] = useState<{ key: string; pool: string | null } | null>(null);
  const existsKey = a && b && a.address !== b.address && usableFee !== null ? `${a.address}:${b.address}:${usableFee}` : null;
  useEffect(() => {
    if (!existsKey || !a || !b || usableFee === null) return;
    const controller = new AbortController();
    void liquidity.poolExists({ tokenA: a.address, tokenB: b.address, feeBps: usableFee }, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      if (answer.ok) setExists({ key: existsKey, pool: answer.data.exists ? answer.data.pool : null });
      else if (NO_NETWORK.has(refusalCode(answer) ?? '')) setProblem({ notice: true });
    });
    return () => controller.abort();
  }, [existsKey, liquidity]); // eslint-disable-line react-hooks/exhaustive-deps
  const existing = exists && exists.key === existsKey ? exists.pool : null;

  const create = async () => {
    if (!a || !b || unitsA === null || unitsB === null || usableFee === null || !wallet.address) return;
    setProblem(null);
    setBusy(true);
    try {
      const gate = await signing.withRepresentation(async () => {
        const built = await liquidity.buildCreate({
          owner: wallet.address!,
          tokenA: a.address,
          tokenB: b.address,
          feeBps: usableFee,
          amountA: unitsA.toString(),
          amountB: unitsB.toString(),
        });
        if (!built.ok) {
          const code = refusalCode(built);
          if (NO_NETWORK.has(code ?? '')) return setProblem({ notice: true });
          if (code === 'amm.fee_out_of_range') return setProblem({ words: t('feeAboveCap') });
          if (code === 'amm.pool_exists') return setProblem({ words: t('revert_PoolExists') });
          return setProblem({ words: t('refused', { reason: built.message.replace(/^[a-z_]+\.[a-z_.]+: /, '') }) });
        }
        const shownA = amountText(unitsA, a.decimals);
        const shownB = amountText(unitsB, b.decimals);
        const [approveA, approveB] = await Promise.all([
          signing.approvals(a, built.data.router, unitsA, shownA),
          signing.approvals(b, built.data.router, unitsB, shownB),
        ]);
        if (!approveA.ok) return setProblem({ words: approveA.reason });
        if (!approveB.ok) return setProblem({ words: approveB.reason });
        const outcome = await signing.send(
          {
            title: t('stepsCreate'),
            steps: [
              ...approveA.steps,
              ...approveB.steps,
              {
                label: t('stepCreate', { amountA: shownA, tokenA: a.name, amountB: shownB, tokenB: b.name }),
                request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data },
              },
            ],
            facts: [
              { label: a.name, value: a.address },
              { label: b.name, value: b.address },
            ],
          },
          built.data.call,
        );
        if (outcome.ok) setCreated(built.data.pool);
        else setProblem({ words: outcome.reason });
      });
      if (gate) setProblem({ words: gate });
    } finally {
      setBusy(false);
    }
  };

  const network = networkLabel(APP_CHAIN_ID).name;
  const ready =
    !busy && !!wallet.address && !!a && !!b && a.address !== b.address && unitsA !== null && unitsB !== null && usableFee !== null;
  const select = (id: string, label: string, value: string, set: (v: string) => void) => (
    <label className="field">
      <span id={id}>{label}</span>
      <select value={value} onChange={(event) => set(event.target.value)} aria-labelledby={id}>
        <option value="">{t('chooseToken')}</option>
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {token.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <WatchShell title={t('newTitle')} description={t('network', { network })}>
      {signing.panel}
      <Panel title={t('newTitle')}>
        {!wallet.address && <NoWalletNote t={t} />}
        {noNetwork && <ServiceOffNotice code="rail.crypto" action={t('actionCreate')} role="status" />}
        {pairs.resource.status === 'loading' && <Loading label={t('newTitle')} />}
        <form
          aria-label={t('newTitle')}
          className="protocol-quote"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {select(ids.a, t('firstToken'), tokenA, setTokenA)}
          {select(ids.b, t('secondToken'), tokenB, setTokenB)}
          <label className="field">
            <span id={ids.tier}>{t('feeTier')}</span>
            <select value={tier} onChange={(event) => setTier(event.target.value)} aria-labelledby={ids.tier}>
              <option value="">{t('chooseTier')}</option>
              {tierList.map((bps) => (
                <option key={bps} value={String(bps)}>
                  {`${bpsPercent(bps)}%`}
                </option>
              ))}
              <option value={CUSTOM}>{t('customTier')}</option>
            </select>
          </label>
          {tiersUnset && <p role="note">{t('tiersUnset')}</p>}
          {tiers.resource.status === 'failed' && !tiersUnset && (
            <p role="note">{t('tiersUnread', { reason: tiers.resource.failure.message })}</p>
          )}
          {tier === CUSTOM && (
            <Field
              label={t('customFee')}
              hint={t('customFeeHint')}
              inputMode="decimal"
              value={customFee}
              onChange={(event) => setCustomFee(event.target.value)}
            />
          )}
          {feeProblem && <p role="alert">{feeProblem}</p>}
          {existing ? (
            <>
              <p role="status">{t('exists')}</p>
              <p className="muted">{t('existsNote')}</p>
              <a className="button button--primary" href={`/dex/pools/${existing.toLowerCase()}/add`}>
                {t('addLiquidity')}
              </a>
            </>
          ) : (
            <>
              <Field
                label={t('firstAmount')}
                hint={a?.name}
                inputMode="decimal"
                value={amountA}
                onChange={(event) => setAmountA(event.target.value)}
              />
              <Field
                label={t('secondAmount')}
                hint={b?.name}
                inputMode="decimal"
                value={amountB}
                onChange={(event) => setAmountB(event.target.value)}
              />
              {a && b && unitsA !== null && unitsB !== null && (
                <p className="numeric" data-testid="starting-price">
                  {t('startingPrice', { a: a.name, price: priceText(unitsA, a.decimals, unitsB, b.decimals), b: b.name })}
                </p>
              )}
              <p className="muted">{t('firstDepositor')}</p>
              <Button type="submit" disabled={!ready}>
                {t('createPool')}
              </Button>
            </>
          )}
        </form>
        {created && (
          <p role="status">
            {t('created', { address: created })} <a href={`/dex/pools/${created.toLowerCase()}`}>{created}</a>
          </p>
        )}
        {problem && 'words' in problem && <p role="alert">{problem.words}</p>}
        {signing.gateProblem && <p role="alert">{signing.gateProblem}</p>}
      </Panel>
      <Button variant="secondary" onClick={() => navigate('/dex/pools')}>
        {t('backToPools')}
      </Button>{' '}
      <Button variant="secondary" onClick={() => navigate('/dex')}>
        {t('backToDex')}
      </Button>
    </WatchShell>
  );
}
