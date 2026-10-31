import { useMemo, useState } from 'react';
import {
  welcomeChecklistSchema,
  welcomeClaimResultSchema,
  type TaskEvent,
  type WelcomeChecklist as Checklist,
} from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { welcomeChecklistCopy } from './welcome-checklist-copy';
import { timeLeft } from './time-left';

/**
 * The welcome checklist on /uc/promotion (CM-rewards-hub-03, J-campaigns-04): the account's
 * welcome window and each task, ticked by svc-campaigns from real events (verified, a crypto deposit credited, a spot
 * fill), with its reward ("not set" when blank) and a claim per task. Everything is read from svc-campaigns; after any
 * claim answer, or none, the list is read again, so a lost reply never sends a second claim.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const REFUSALS = [
  'campaigns.reward_unset',
  'campaigns.tasks_incomplete',
  'campaigns.claim_expired',
  'campaigns.window_unset',
  'campaigns.kyc_required',
  'campaigns.budget_exhausted',
  'campaigns.budget_asset_mismatch',
  'campaigns.hold_period_unset',
  'campaigns.participant_unread',
  'campaigns.reward_saga_unwired',
  'campaigns.welcome_none',
  'campaign.not_active',
  'campaigns.per_customer_limit_unset',
  'campaigns.customer_limit_reached',
  'campaigns.redemption_limit_reached',
] as const;
type Refusal = (typeof REFUSALS)[number];
const refusalOf = (code: string | undefined) => (REFUSALS as readonly string[]).find((c) => c === code) as Refusal | undefined;
const key = (code: string) => code.replace(/\./g, '_') as 'identity_verified';

function useFormat() {
  const { renderedLocale } = welcomeChecklistCopy.useCopy();
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

export function WelcomeChecklist() {
  const api = useApi();
  const { t } = welcomeChecklistCopy.useCopy();
  const list = useResource(
    (signal) => api.query('campaigns', 'tasks.welcome.list', {}, welcomeChecklistSchema, { signal }),
    'welcome-checklist',
  );
  const [refusal, setRefusal] = useState<{ event: TaskEvent; result: Failed } | null>(null);
  const [busy, setBusy] = useState<TaskEvent | null>(null);
  const claim = async (event: TaskEvent) => {
    setBusy(event);
    const result = await api.mutate('campaigns', 'tasks.welcome.claim', { event }, welcomeClaimResultSchema);
    setBusy(null);
    setRefusal(result.ok ? null : { event, result });
    list.reload();
  };
  const r = list.resource;
  return (
    <section className="rewards-hub" aria-label={t('title')} data-testid="welcome-checklist" data-state={r.status}>
      <Panel title={t('title')}>
        <p className="muted">{t('intro')}</p>
        {r.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : r.status === 'failed' ? (
          <div data-testid="welcome-failed">
            <Failure result={r.failure} retry={list.reload} />
          </div>
        ) : !r.data.campaign ? (
          <div data-testid="welcome-empty">
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
          <Tasks data={r.data} busy={busy} refusal={refusal} onClaim={(event) => void claim(event)} />
        )}
      </Panel>
    </section>
  );
}

function Tasks({
  data,
  busy,
  refusal,
  onClaim,
}: {
  data: Checklist;
  busy: TaskEvent | null;
  refusal: { event: TaskEvent; result: Failed } | null;
  onClaim: (event: TaskEvent) => void;
}) {
  const { t } = welcomeChecklistCopy.useCopy();
  const { when, left } = useFormat();
  const w = data.window!;
  const remaining = w.closesAt ? (new Date(w.closesAt).getTime() - Date.now()) / 1000 : 0;
  // Claims are taken only while the window is open and the campaign runs.
  const running = data.campaign!.state === 'active';
  const claimable = w.state === 'open' && running;
  return (
    <>
      <p data-testid="welcome-campaign" lang="und">
        <strong>{data.campaign!.name}</strong>
      </p>
      <p data-testid="welcome-window" data-state={w.state} data-opens={w.opensAt} data-closes={w.closesAt ?? ''}>
        <strong>{t('window')}</strong>:{' '}
        {w.state === 'unset' || !w.closesAt
          ? t('windowUnset')
          : w.state === 'expired'
            ? t('windowExpired', { opens: when(w.opensAt), closes: when(w.closesAt) })
            : t('windowOpen', { opens: when(w.opensAt), closes: when(w.closesAt), left: left(remaining) })}
      </p>
      {running ? null : (
        <p role="status" data-testid="welcome-campaign-state" data-state={data.campaign!.state}>
          {t('campaignNotRunning')}
        </p>
      )}
      <DataTable label={t('listLabel')} headers={[t('colTask'), t('colReward'), t('colState'), t('colDetail')]}>
        {data.tasks.map((task) => {
          const failed = refusal?.event === task.event ? refusal.result : null;
          const code = failed ? refusalOf(failed.code) : undefined;
          return (
            <tr key={task.event} data-testid="welcome-task" data-event={task.event} data-state={task.state}>
              <td lang="und">{task.title}</td>
              <td lang="zxx" data-testid="welcome-reward">
                {task.reward ? `${task.reward.amount} ${task.reward.asset}` : t('rewardUnset')}
              </td>
              <td data-testid="welcome-state">{t(`state_${task.state}`)}</td>
              <td>
                <span data-testid="welcome-why">
                  {task.state === 'expired'
                    ? t('expiredWhy')
                    : task.record
                      ? task.record.state === 'posted' && task.record.postedAt
                        ? t('record_posted', { when: when(task.record.postedAt) })
                        : t('record_open', { state: task.record.state })
                      : task.doneAt
                        ? t('doneAt', { when: when(task.doneAt) })
                        : t(`openWhy_${key(task.event)}`)}
                </span>
                {task.record?.ledgerTxId ? (
                  <>
                    {' '}
                    <a
                      className="text-link"
                      data-testid="welcome-tx"
                      data-tx={task.record.ledgerTxId}
                      href={`/money/activity/${encodeURIComponent(task.record.ledgerTxId)}`}
                    >
                      {t('txLink', { tx: task.record.ledgerTxId })}
                    </a>
                  </>
                ) : null}
                {claimable && (task.state === 'done' || task.record?.state === 'withheld') ? (
                  <>
                    {' '}
                    <Button onClick={() => onClaim(task.event)} disabled={busy !== null} aria-label={t('claimTask', { task: task.title })}>
                      {busy === task.event ? t('claiming') : t('claim')}
                    </Button>
                  </>
                ) : null}
                {failed ? (
                  code ? (
                    <p role="status" className="muted" data-testid="welcome-refusal" data-code={code}>
                      {t(`refusal_${key(code)}` as 'refusal_campaigns_reward_unset')}
                    </p>
                  ) : (
                    <Failure result={failed} />
                  )
                ) : null}
              </td>
            </tr>
          );
        })}
      </DataTable>
    </>
  );
}
