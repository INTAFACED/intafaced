import { useMemo, useState, type ReactNode } from 'react';
import { liquidityIncentiveCallOutputSchema, liquidityIncentivesOutputSchema, type LiquidityIncentiveRow } from '@intafaced/contracts/protocol-liquidity';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Loading, Panel } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { liquidityCopy, type LiquidityTranslate } from './copy';
import { amountText, bpsPercent } from './format';
import { plainReason, refusalCode } from './liquidity-api';
import { useLiquiditySigning } from './signing';

/**
 * A pool's on-chain incentives (D-liquidity-09, J-dex-protocol-13 #8): each one an incentivizer announced, funded from
 * its own wallet and started. The connected wallet stakes its pool shares, sees its share of what is staked and what
 * that share earns over the period, unstakes (accrual stops at once), and claims. An unfunded incentive cannot start.
 * Nothing here is the platform's: the reward is the incentivizer's, the shares are the wallet's.
 */
export function IncentivesPanel({ pool }: { pool: string }) {
  const { language } = usePreferences();
  const { t } = liquidityCopy.forLocale(language);
  const transport = useApi();
  const signing = useLiquiditySigning(t);
  const { wallet } = signing;
  const [revision, setRevision] = useState(0);
  const api = useMemo(
    () => ({
      list: (signal?: AbortSignal) =>
        transport.query('protocol', 'amm.incentives', { pool, ...(wallet.address ? { account: wallet.address } : {}) }, liquidityIncentivesOutputSchema, { signal }),
      build: (input: { account: string; id: number; action: 'stake' | 'unstake' | 'claim' | 'start' }) =>
        transport.query('protocol', 'amm.buildIncentiveCall', input, liquidityIncentiveCallOutputSchema),
    }),
    [transport, pool, wallet.address],
  );
  const list = useResource((signal) => api.list(signal), `liquidity:incentives:${pool}:${wallet.address ?? 'none'}:${revision}`);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<{ id: number; words: string } | null>(null);

  const act = async (row: LiquidityIncentiveRow, action: 'stake' | 'unstake' | 'claim' | 'start') => {
    if (!wallet.address) return;
    setProblem(null);
    setBusy(row.id);
    try {
      const gate = await signing.withRepresentation(async () => {
        const built = await api.build({ account: wallet.address!, id: row.id, action });
        if (!built.ok) return setProblem({ id: row.id, words: t('refused', { reason: plainReason(built.message) }) });
        const approve =
          action === 'stake'
            ? await signing.approvals({ address: built.data.pool, name: 'LP' }, built.data.contract, BigInt(built.data.shares), amountText(built.data.shares, 18, 18))
            : { ok: true as const, steps: [] };
        if (!approve.ok) return setProblem({ id: row.id, words: approve.reason });
        const steps = approve.steps.map((step) => ({ ...step, label: t('stepApproveShares', { shares: amountText(built.data.shares, 18, 18) }) }));
        const outcome = await signing.send(
          {
            title: t('stepsIncentive'),
            steps: [...steps, { label: t(`incentive_${action}`), request: { kind: 'transaction', to: built.data.call.to, data: built.data.call.data } }],
          },
          built.data.call,
        );
        if (!outcome.ok) setProblem({ id: row.id, words: outcome.reason });
        setRevision((n) => n + 1);
      }, () => void act(row, action));
      if (gate) setProblem({ id: row.id, words: gate });
    } finally {
      setBusy(null);
    }
  };

  const headers = [t('hdrIncentive'), t('hdrIncentiveState'), t('hdrYourSplit'), t('hdrYourReward'), t('hdrActions')];
  const { resource } = list;
  let body: ReactNode;
  const note = (content: ReactNode) => (
    <tr>
      <td colSpan={headers.length}>{content}</td>
    </tr>
  );
  if (resource.status === 'loading') body = note(<Loading label={t('incentivesTitle')} />);
  else if (resource.status === 'failed')
    body = note(
      <p role="status">
        {refusalCode(resource.failure) === 'protocol.liquidity_incentives_unset'
          ? t('incentivesUnset')
          : t('incentivesUnread', { reason: plainReason(resource.failure.message) })}
      </p>,
    );
  else if (resource.data.incentives.length === 0) body = note(<EmptyState title={t('incentivesEmpty')} />);
  else
    body = resource.data.incentives.map((row) => (
      <IncentiveRow
        key={row.id}
        row={row}
        t={t}
        mine={!!wallet.address && wallet.address.toLowerCase() === row.incentivizer.toLowerCase()}
        connected={!!wallet.address}
        busy={busy === row.id}
        problem={problem?.id === row.id ? problem.words : null}
        act={(action) => void act(row, action)}
      />
    ));
  return (
    <Panel title={t('incentivesTitle')} aria-label={t('incentivesTitle')}>
      {signing.panel}
      <p className="muted">{t('incentivesNote')}</p>
      <DataTable label={t('incentivesTitle')} headers={headers}>
        {body}
      </DataTable>
      {resource.status === 'ready' && <p className="muted">{t('readAt', { block: resource.data.blockNumber })}</p>}
      {signing.gateProblem && <p role="alert">{signing.gateProblem}</p>}
    </Panel>
  );
}

function IncentiveRow({
  row,
  t,
  mine,
  connected,
  busy,
  problem,
  act,
}: {
  row: LiquidityIncentiveRow;
  t: LiquidityTranslate;
  mine: boolean;
  connected: boolean;
  busy: boolean;
  problem: string | null;
  act: (action: 'stake' | 'unstake' | 'claim' | 'start') => void;
}) {
  const reward = (raw: string) => `${amountText(raw, row.rewardToken.decimals)} ${row.rewardToken.name}`;
  const staking = BigInt(row.yourStake) > 0n;
  const projected = (BigInt(row.total) * BigInt(row.yourSplitBps)) / 10_000n;
  return (
    <tr>
      <th scope="row">{t('incentiveName', { total: reward(row.total), blocks: String(row.blocks) })}</th>
      <td>
        {row.state === 'unfunded' ? t('incentiveUnfunded') : t(`incentiveState_${row.state}`)}
        {row.endBlock !== null && ` · ${t('incentiveBlocks', { start: String(row.startBlock), end: String(row.endBlock) })}`}
      </td>
      <td className="numeric" data-testid="your-split">
        {staking ? t('yourSplit', { percent: bpsPercent(row.yourSplitBps), amount: amountText(projected, row.rewardToken.decimals), total: reward(row.total) }) : '—'}
      </td>
      <td className="numeric">
        <span data-testid="your-reward">{reward(row.yourReward)}</span>
        <br />
        <span role="status">{staking && row.state === 'running' ? t('earning') : t('notEarning')}</span>
      </td>
      <td>
        {connected && !staking && row.state !== 'ended' && (
          <Button variant="secondary" disabled={busy} onClick={() => act('stake')}>
            {t('stake')}
          </Button>
        )}
        {connected && staking && (
          <Button variant="secondary" disabled={busy} onClick={() => act('unstake')}>
            {t('unstake')}
          </Button>
        )}
        {connected && BigInt(row.yourReward) > 0n && (
          <Button variant="secondary" disabled={busy} onClick={() => act('claim')}>
            {t('claim')}
          </Button>
        )}
        {(row.state === 'unfunded' || row.state === 'ready') && (
          <Button variant="secondary" disabled={busy || !mine || row.state === 'unfunded'} onClick={() => act('start')}>
            {t('start')}
          </Button>
        )}
        {problem && <p role="alert">{problem}</p>}
      </td>
    </tr>
  );
}
