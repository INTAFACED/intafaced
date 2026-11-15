import { useMemo, useState } from 'react';
import {
  taskClaimResultSchema,
  taskProgressSchema,
  type CampaignView,
  type RewardRecord,
  type TaskProgress,
} from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, Failure, Loading, Panel } from '../../shared/ui';
import { StatRow } from './depth-kit';
import { campaignTasksCopy } from './campaign-tasks-copy';

/**
 * A task campaign's steps, the caller's own progress, the claim and the reward record with its redemption log
 * (CM-tasks-quests-01, CM-payouts-ledger-02, J-campaigns-02). Everything shown is read from svc-campaigns; after any
 * claim answer, or none, the panel reads the stored reward again instead of claiming twice.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const CLAIM_CODES = [
  'campaigns.not_joined',
  'campaigns.tasks_incomplete',
  'campaigns.kyc_required',
  'campaigns.claim_expired',
  'campaigns.budget_exhausted',
  'campaigns.budget_asset_mismatch',
  'campaigns.reward_saga_unwired',
  'campaigns.participant_unread',
  'campaigns.claim_window_unset',
  'campaigns.hold_period_unset',
  'campaigns.reward_unset',
  'campaigns.per_customer_limit_unset',
  'campaigns.customer_limit_reached',
  'campaigns.redemption_limit_reached',
] as const;
type ClaimCode = (typeof CLAIM_CODES)[number];
const claimCode = (code: string | undefined): ClaimCode | null =>
  (CLAIM_CODES as readonly string[]).find((c) => c === code) as ClaimCode | null;

const UNITS = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
] as const;

function useFormat() {
  const { renderedLocale } = campaignTasksCopy.useCopy();
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
    const date = new Intl.DateTimeFormat(renderedLocale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    return {
      when: (isoTime: string) => time.format(new Date(isoTime)),
      /** A calendar day (`YYYY-MM-DD`) as the reader writes dates; the day is the platform zone's, so no zone shift. */
      day: (ymd: string) => date.format(new Date(`${ymd}T00:00:00Z`)),
      /** Whole seconds in the largest unit that divides them. */
      duration: (seconds: number) => {
        const [unit, size] = UNITS.find(([, s]) => seconds % s === 0)!;
        return new Intl.NumberFormat(renderedLocale, { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / size);
      },
    };
  }, [renderedLocale]);
}

export function CampaignTasks({ campaign }: { campaign: CampaignView }) {
  const api = useApi();
  const { t } = campaignTasksCopy.useCopy();
  const { when, duration } = useFormat();
  const tasks = campaign.tasks!;
  const progress = useResource(
    (signal) => api.query('campaigns', 'tasks.progress', { campaignId: campaign.id }, taskProgressSchema, { signal }),
    `campaign-tasks-${campaign.id}`,
  );
  const [refusal, setRefusal] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  const claim = async () => {
    setBusy(true);
    const result = await api.mutate('campaigns', 'tasks.claim', { campaignId: campaign.id }, taskClaimResultSchema);
    setBusy(false);
    setRefusal(result.ok ? null : result);
    // Whatever came back, or nothing, the stored reward is read again: a lost answer never sends a second claim.
    progress.reload();
  };
  const p = progress.resource.status === 'ready' ? progress.resource.data : null;
  const code = refusal ? claimCode(refusal.code) : null;
  return (
    <>
      <Panel title={t('stepsTitle')}>
        <StatRow
          items={[
            {
              label: t('claimWindow'),
              value: (
                <span data-testid="task-claim-window">
                  {tasks.claimWindowSeconds
                    ? t('claimWindowValue', { duration: duration(tasks.claimWindowSeconds) })
                    : t('claimWindowUnset')}
                </span>
              ),
            },
            {
              label: t('hold'),
              value: (
                <span data-testid="task-hold">
                  {tasks.holdSeconds === null || tasks.holdSeconds === undefined
                    ? t('holdUnset')
                    : tasks.holdSeconds === 0
                      ? t('holdNone')
                      : t('holdValue', { duration: duration(tasks.holdSeconds) })}
                </span>
              ),
            },
            { label: t('verification'), value: <span data-testid="task-gate">{t(`gate_${tasks.kycGate}`)}</span> },
            ...(p
              ? [
                  {
                    label: t('budget'),
                    value: p.budget ? (
                      <span
                        data-testid="task-budget"
                        data-limit={p.budget.limit}
                        data-reserved={p.budget.reserved}
                        data-spent={p.budget.spent}
                        data-left={p.budget.left}
                      >
                        {t('budgetValue', { ...p.budget })}
                      </span>
                    ) : (
                      <span data-testid="task-budget">{t('budgetUnset')}</span>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {progress.resource.status === 'loading' ? (
          <Loading label={t('progressLoading')} />
        ) : progress.resource.status === 'failed' ? (
          <Failure result={progress.resource.failure} retry={progress.reload} />
        ) : (
          <Steps progress={progress.resource.data} />
        )}
        <p className="muted">{t('stepsFromEvents')}</p>
      </Panel>
      <Panel title={t('rewardTitle')}>
        {p?.reward ? (
          <>
            <Reward reward={p.reward} when={when} duration={duration} desk={deskOf(tasks)} />
            {/* A withheld reward is looked at again on a later claim, once the account is active. */}
            {p.reward.state === 'withheld' ? (
              <Button onClick={() => void claim()} disabled={busy}>
                {busy ? t('claiming') : t('claimAgain')}
              </Button>
            ) : null}
          </>
        ) : p ? (
          <>
            <p data-testid="task-reward-none">{t('rewardNone')}</p>
            {p.claimClosesAt ? <p data-testid="task-claim-by">{t('claimBy', { when: when(p.claimClosesAt) })}</p> : null}
            {p.joined ? (
              <Button onClick={() => void claim()} disabled={busy}>
                {busy ? t('claiming') : t('claim')}
              </Button>
            ) : null}
            <p className="muted">{t('claimNote')}</p>
          </>
        ) : null}
        {refusal ? (
          code ? (
            <p role="status" className="muted" data-testid="task-refusal" data-code={code}>
              {code === 'campaigns.kyc_required' ? t(code, { gate: t(`gate_${tasks.kycGate}`) }) : t(code)}
            </p>
          ) : refusal.reason === 'unreachable' || refusal.reason === 'uncertain' || refusal.reason === 'aborted' ? (
            <p role="status" className="muted" data-testid="task-checking">
              {t('checking')}
            </p>
          ) : (
            <Failure result={refusal} />
          )
        ) : null}
      </Panel>
    </>
  );
}

function Steps({ progress: p }: { progress: TaskProgress }) {
  const { t } = campaignTasksCopy.useCopy();
  return (
    <>
      <p data-testid="task-progress" data-done={p.completed} data-total={p.total}>
        {p.joined ? t('progressValue', { done: String(p.completed), total: String(p.total) }) : t('progressNotJoined')}
      </p>
      <ol className="depth-list" aria-label={t('stepsLabel')}>
        {p.steps.map((s) => (
          <li key={s.index} data-testid="task-step" data-complete={s.complete ? 'true' : 'false'}>
            <strong lang="und">{s.title}</strong>:{' '}
            {s.streak
              ? t('streakCount', { done: String(s.done), target: String(s.target) })
              : t('stepCount', { done: String(s.done), target: String(s.target) })}
            , {s.complete ? t('stepDone') : t('stepOpen')}
            {s.streak && !s.complete ? <StreakState streak={s.streak} /> : null}
          </li>
        ))}
      </ol>
      {p.deposit ? <DepositRead deposit={p.deposit} /> : null}
    </>
  );
}

/** How a deposit step was read from the venue just now: read with its as-of time, unread, or no wallet to read. */
function DepositRead({ deposit }: { deposit: NonNullable<TaskProgress['deposit']> }) {
  const { t } = campaignTasksCopy.useCopy();
  const { when } = useFormat();
  return (
    <p data-testid="task-deposit-source" data-source={deposit.source} data-as-of={deposit.asOf ?? undefined}>
      {deposit.source === 'read' && deposit.asOf
        ? t('depositRead', { when: when(deposit.asOf) })
        : deposit.source === 'no_wallet'
          ? t('depositNoWallet')
          : t('depositUnread')}
      {deposit.source === 'no_wallet' ? (
        <>
          {' '}
          <a className="text-link" href="/wallet/venue">
            {t('connectWallet')}
          </a>
        </>
      ) : null}
    </p>
  );
}

/** Why a reward INTAFACED owes is not in the wallet yet, from its typed reason. */
const WHY: Record<string, 'why_no_wallet' | 'why_wallet_short' | 'why_frozen'> = {
  'campaigns.no_connected_wallet': 'why_no_wallet',
  'campaigns.reward_wallet_short': 'why_wallet_short',
  'ledger.frozen': 'why_frozen',
};

/** A streak's run: alive until the zone midnight, or reset after a missed day. Times are the platform zone's. */
function StreakState({ streak }: { streak: NonNullable<TaskProgress['steps'][number]['streak']> }) {
  const { t } = campaignTasksCopy.useCopy();
  const { when, day } = useFormat();
  return (
    <p data-testid="task-streak" data-days={streak.days} data-best={streak.best} data-reset={streak.reset ? 'true' : 'false'}>
      {streak.reset
        ? t('streakReset', { run: String(streak.lastRun), day: streak.lastDay ? day(streak.lastDay) : '' })
        : streak.resetsAt
          ? t('streakAlive', { when: when(streak.resetsAt) })
          : t('streakNone')}
    </p>
  );
}

/** The spot desk whose Ledger tab lists the reward: the first step's market, else the market list. */
const deskOf = (tasks: NonNullable<CampaignView['tasks']>) => {
  const market = tasks.steps.find((s) => s.market)?.market;
  return market ? `/trade/spot/${market.replace('/', '-')}` : '/trade';
};

function Reward({
  reward: r,
  when,
  duration,
  desk,
}: {
  reward: RewardRecord;
  when: (iso: string) => string;
  duration: (seconds: number) => string;
  desk: string;
}) {
  const { t } = campaignTasksCopy.useCopy();
  const window = r.rollback.windowSeconds;
  return (
    <div data-testid="task-reward" data-state={r.state} data-reward-key={r.rewardKey}>
      <p>
        <strong data-testid="task-reward-amount">{t('rewardAmount', { amount: r.amount, asset: r.asset })}</strong>:{' '}
        <span data-testid="task-reward-state">{t(`state_${r.state}`)}</span>
      </p>
      {/* An owed reward on its review hold is paid after the hold; a held one (custodial) likewise. */}
      {(r.state === 'held' || (r.state === 'owed' && (!r.reason || r.reason === 'campaigns.reward_payout_unavailable'))) &&
      r.holdUntil &&
      Date.parse(r.holdUntil) > Date.now() ? (
        <p data-testid="task-reward-held-until" data-until={r.holdUntil}>
          {t('rewardHeldUntil', { when: when(r.holdUntil) })}
        </p>
      ) : null}
      {r.lock && (r.state === 'locked' || r.state === 'settling') ? (
        <p data-testid="task-reward-locked-until" data-until={r.lock.until}>
          {t('rewardLockedUntil', { when: when(r.lock.until) })}
        </p>
      ) : null}
      {r.state === 'owed' ? (
        <p data-testid="task-reward-why" data-reason={r.reason ?? undefined}>
          {t(r.reason && WHY[r.reason] ? WHY[r.reason]! : 'why_waiting')}
          {r.reason === 'campaigns.no_connected_wallet' ? (
            <>
              {' '}
              <a className="text-link" href="/wallet/venue">
                {t('connectWallet')}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {r.payout ? (
        <>
          <p data-testid="task-reward-paid-to" data-wallet={r.payout.toWallet}>
            {t('paidTo', { wallet: r.payout.toWallet, when: when(r.payout.at) })}{' '}
            {/* The chain's own record of the payment, in the app's explorer. */}
            <a
              className="text-link"
              data-testid="task-reward-chain-tx"
              data-tx={r.payout.chainTx}
              href={`/chain/tx/${encodeURIComponent(r.payout.chainTx)}`}
            >
              {t('chainTx', { tx: r.payout.chainTx })}
            </a>
          </p>
          <p
            data-testid="task-reward-network-fee"
            data-asset={r.payout.networkFee?.asset}
            data-amount={r.payout.networkFee?.amount}
            data-paid-by="intafaced"
          >
            {r.payout.networkFee
              ? t('networkFee', { amount: r.payout.networkFee.amount, asset: r.payout.networkFee.asset })
              : t('networkFeeUnread')}
          </p>
        </>
      ) : null}
      {r.ledgerTxId && r.state === 'posted' ? (
        <p>
          <span data-testid="task-reward-tx" data-tx={r.ledgerTxId}>
            {t('rewardTx', { tx: r.ledgerTxId })}
          </span>{' '}
          <a className="text-link" href={desk}>
            {t('rewardLedger')}
          </a>
        </p>
      ) : null}
      <h3>{t('logTitle')}</h3>
      <DataTable label={t('logLabel')} headers={[t('logWhen'), t('logOutcome'), t('logReason'), t('logChain')]}>
        {r.attempts.map((a, i) => (
          <tr key={`${a.at}-${i}`} data-testid="redemption-attempt" data-outcome={a.outcome}>
            <td>{when(a.at)}</td>
            <td>{t(`outcome_${a.outcome}`)}</td>
            <td data-testid="redemption-reason">
              <code>{a.reason ?? t('reasonNone')}</code>
            </td>
            {/* The chain reference once paid: the payment line names the transaction that paid it. */}
            <td data-testid="redemption-chain-tx" data-tx={a.outcome === 'paid' && r.payout ? r.payout.chainTx : undefined}>
              {a.outcome === 'paid' && r.payout ? <code>{r.payout.chainTx}</code> : t('chainNone')}
            </td>
          </tr>
        ))}
      </DataTable>
      <p
        data-testid="task-rollback"
        data-code={r.rollback.blocker}
        data-closes-on={r.rollback.closesOn}
        data-closes-at={r.rollback.closesAt ?? undefined}
        data-open={rollbackOpen(r) ? 'true' : 'false'}
      >
        <strong>{t('rollbackWindow')}</strong>:{' '}
        {window === null
          ? t('rollbackUnset')
          : r.rollback.closesOn === 'payment'
            ? r.payout && r.rollback.closesAt === r.payout.at
              ? t('rollbackClosedPaid', { when: when(r.rollback.closesAt) })
              : r.rollback.closesAt && !rollbackOpen(r)
                ? t('rollbackClosedOwed', { when: when(r.rollback.closesAt) })
                : r.rollback.closesAt
                  ? t('rollbackOpenUntilPaid', { duration: duration(window), when: when(r.rollback.closesAt) })
                  : t('rollbackPending', { duration: duration(window) })
            : r.rollback.closesAt
              ? t('rollbackValue', { duration: duration(window), when: when(r.rollback.closesAt) })
              : t('rollbackPending', { duration: duration(window) })}
        . {t('rollbackBlocked')}
      </p>
    </div>
  );
}

/** Whether the rollback window is still open now: a paid reward's closed at its payment, any other's at its end. */
function rollbackOpen(r: RewardRecord): boolean {
  if (r.rollback.windowSeconds === null) return false;
  if (r.rollback.closesOn === 'payment' && r.payout) return false;
  return r.rollback.closesAt === null || Date.parse(r.rollback.closesAt) > Date.now();
}
