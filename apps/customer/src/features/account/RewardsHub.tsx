import { useMemo } from 'react';
import { REWARD_STATUSES, myRewardsSchema, type MyReward, type MyRewards } from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { rewardsHubCopy } from './rewards-hub-copy';
import { timeLeft } from './time-left';

/**
 * My Rewards hub on /uc/promotion (CM-rewards-hub-01, J-campaigns-03): every campaign reward of the signed-in account in
 * plain status words, with the real reason, the time left on a hold and the transaction of a posted one. Everything is
 * read from svc-campaigns on each visit; totals come from the rows it returns. A failed read shows the error and no
 * number at all, never an earlier one.
 */

function useFormat() {
  const { renderedLocale } = rewardsHubCopy.useCopy();
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    return {
      when: (isoTime: string) => time.format(new Date(isoTime)),
      left: (seconds: number) => timeLeft(seconds, renderedLocale),
    };
  }, [renderedLocale]);
}

export function RewardsHub() {
  const api = useApi();
  const { t } = rewardsHubCopy.useCopy();
  const rewards = useResource((signal) => api.query('campaigns', 'rewards.mine', {}, myRewardsSchema, { signal }), 'rewards-hub');
  const r = rewards.resource;
  return (
    <section className="rewards-hub" aria-label={t('title')} data-testid="rewards-hub" data-state={r.status}>
      <Panel title={t('title')}>
        <p className="muted">{t('intro')}</p>
        {r.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : r.status === 'failed' ? (
          <div data-testid="rewards-failed">
            <Failure result={r.failure} retry={rewards.reload} />
          </div>
        ) : r.data.rewards.length === 0 ? (
          <div data-testid="rewards-empty">
            <EmptyState
              title={t('emptyTitle')}
              action={
                <a className="text-link" href="/campaigns">
                  {t('campaigns')}
                </a>
              }
            >
              {t('emptyBody')}
            </EmptyState>
          </div>
        ) : (
          <Rewards data={r.data} />
        )}
      </Panel>
    </section>
  );
}

function Rewards({ data }: { data: MyRewards }) {
  const { t } = rewardsHubCopy.useCopy();
  const totals = REWARD_STATUSES.flatMap((status) => data.totals.filter((line) => line.status === status));
  return (
    <>
      <dl className="rewards-hub__totals" aria-label={t('totalsLabel')} data-testid="rewards-totals">
        {totals.map((line) => (
          <div key={`${line.status}:${line.asset}`} data-testid="rewards-total" data-status={line.status} data-asset={line.asset}>
            <dt>{t(`total_${line.status}`)}</dt>
            <dd>
              <strong lang="zxx" data-testid="rewards-total-amount">
                {line.amount} {line.asset}
              </strong>{' '}
              <span className="muted">{t('totalCount', { count: String(line.count) })}</span>
            </dd>
          </div>
        ))}
      </dl>
      <DataTable label={t('listLabel')} headers={[t('colCampaign'), t('colAmount'), t('colStatus'), t('colDetail')]}>
        {data.rewards.map((reward) => (
          <Row key={reward.rewardKey} reward={reward} />
        ))}
      </DataTable>
      {data.more ? (
        <p className="muted" data-testid="rewards-more">
          {t('more', { count: String(data.rewards.length) })}
        </p>
      ) : null}
    </>
  );
}

function Row({ reward: r }: { reward: MyReward }) {
  const { t } = rewardsHubCopy.useCopy();
  const { when, left } = useFormat();
  const reason = r.reason ?? '';
  const leftSeconds = r.holdUntil ? (new Date(r.holdUntil).getTime() - Date.now()) / 1000 : 0;
  const why =
    lockWhy(r, t, when, left) ??
    (r.state === 'held' && r.holdUntil
      ? leftSeconds > 0
        ? t('why_held', { left: left(leftSeconds), when: when(r.holdUntil) })
        : t('why_held_ended', { when: when(r.holdUntil) })
      : r.state === 'posted' && r.postedAt
        ? t('why_posted', { when: when(r.postedAt) })
        : r.state === 'held' || r.state === 'posted'
          ? ''
          : t(`why_${r.state as Exclude<MyReward['state'], 'locked' | 'settling' | 'held' | 'posted'>}`, { reason }));
  return (
    <tr data-testid="reward-row" data-status={r.status} data-state={r.state} data-reward-key={r.rewardKey} data-campaign={r.campaignId}>
      <td>
        <a className="text-link" href={`/campaigns/${encodeURIComponent(r.campaignId)}`} lang="und">
          {r.campaignName}
        </a>
      </td>
      <td lang="zxx" data-testid="reward-amount">
        {r.amount} {r.asset}
      </td>
      <td data-testid="reward-status">{t(`status_${r.status}`)}</td>
      <td>
        <span
          data-testid="reward-why"
          data-reason={r.reason ?? ''}
          data-until={r.holdUntil ?? ''}
          data-form={r.form}
          data-lock-until={r.lock?.until ?? ''}
        >
          {why}
        </span>
        {r.lock && r.state !== 'posted' && r.state !== 'forfeited' ? (
          <>
            {' '}
            <span className="muted" data-testid="reward-lock-tx" data-tx={r.lock.txId} lang="zxx">
              {t('lockTx', { tx: r.lock.txId })}
            </span>
          </>
        ) : null}
        {r.ledgerTxId ? (
          <>
            {' '}
            <a
              className="text-link"
              data-testid="reward-tx"
              data-tx={r.ledgerTxId}
              href={`/money/activity/${encodeURIComponent(r.ledgerTxId)}`}
            >
              {t('txLink', { tx: r.ledgerTxId })}
            </a>
          </>
        ) : null}
      </td>
    </tr>
  );
}

type T = ReturnType<typeof rewardsHubCopy.useCopy>['t'];

/** What a locked reward or bonus says: its condition or expiry, and why it is not in the balance; null for any other. */
function lockWhy(r: MyReward, t: T, when: (iso: string) => string, left: (seconds: number) => string): string | null {
  const lock = r.lock;
  if (r.form === 'paid' || !lock) return null;
  const until = when(lock.until);
  const remaining = left((new Date(lock.until).getTime() - Date.now()) / 1000);
  const step = lock.condition?.title ?? '';
  if (r.state === 'locked') {
    return r.form === 'bonus'
      ? t('why_bonus', { products: lock.appliesTo.map((p) => t(`product_${p}`)).join(', '), when: until, left: remaining })
      : t('why_locked', {
          step,
          done: String(lock.condition?.done ?? 0),
          target: String(lock.condition?.target ?? 0),
          when: until,
          left: remaining,
        });
  }
  if (r.state === 'settling') return t(lock.outcome === 'unlock' ? 'why_settling_unlock' : 'why_settling_forfeit');
  if (r.state === 'forfeited' && r.reason === 'campaigns.bonus_expired') return t('why_bonus_expired', { when: until });
  if (r.state === 'forfeited' && r.reason === 'campaigns.lock_condition_failed')
    return t('why_lock_condition_failed', { step, when: until });
  return null;
}
