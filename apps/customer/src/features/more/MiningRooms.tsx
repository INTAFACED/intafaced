import { useState } from 'react';
import { useApi } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { displayAmount } from '../../shared/money';
import { useResource } from '../../shared/resource';
import { stamp } from '../../screens/money/time';
import { Button, DataTable, EmptyState, Field, Loading, Panel } from '../../shared/ui';
import { Read, Select } from './common';
import { DisabledAction, Journey, StatRow, type JourneyStep } from './depth-kit';
import { dependencyReading, MINING_STEPS, poolVerdict, type MiningHealth } from './mining-journey';
import { miningDepthCopy } from './mining-depth-copy';
import {
  bpsToPercent,
  minerShares,
  minerWorkers,
  payoutPage,
  PAYOUT_PAGE,
  pendingWindows,
  poolTerms,
  sumByAsset,
  sumWeights,
  WINDOW_MINUTES,
  type MinerShares,
  type MinerWorkers,
  type PayoutPage,
  type PendingWindows,
  type PoolTerms,
  type WindowMinutes,
} from './mining-reads';
import type { Resource } from '../../shared/resource';

type Room = 'Overview' | 'Workers' | 'Shares' | 'Rewards';
type Health = { resource: Resource<MiningHealth>; reload: () => void };
type Read<T> = { resource: Resource<T>; reload: () => void };
type Translate = ReturnType<typeof miningDepthCopy.useCopy>['t'];

export function MiningRooms({ room, health }: { room: Room; health: Health }) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const reading = health.resource.status === 'ready' ? health.resource.data : null;
  const loading = health.resource.status === 'loading';
  if (room === 'Workers') return <Workers />;
  if (room === 'Shares') return <Shares />;
  if (room === 'Rewards') return <Rewards />;
  const verdict = poolVerdict(reading);
  // The pool lists a customer's own workers, shares, open windows and paid credits. It still refuses to register a worker.
  const steps: JourneyStep[] = MINING_STEPS.map((step) => {
    const need = dependencyReading(reading, step);
    const canStart = step.access === 'read';
    return {
      id: step.id,
      title: t(`step_${step.id}`),
      body: t(`step_${step.id}_body`),
      state: canStart ? 'info' : 'blocked',
      stateLabel: canStart ? t('stepReadOnly') : t('stepBlocked'),
      reason: (
        <>
          <Copy k={`step_${step.id}_where`} />
          {step.dependency === 'ledger' || step.dependency === 'store' ? (
            <>
              {' '}
              <Copy k="needs" /> <Copy k={step.dependency === 'ledger' ? 'need_ledger' : 'need_store'} />:{' '}
              <Copy k={need === 'configured' ? 'configured' : need === 'absent' ? 'absent' : 'unknown'} />. <Copy k="checked" />.
            </>
          ) : null}
        </>
      ),
    };
  });
  return (
    <div className="more-grid">
      <Panel title={t('verdictTitle')}>
        {loading ? (
          <Loading />
        ) : (
          <>
            <p role="status">
              <Copy k={`verdict_${verdict}`} />
            </p>
            <StatRow
              items={[
                {
                  label: t('readingProcess'),
                  value: <Copy k={reading ? 'responding' : 'silent'} />,
                },
                {
                  label: t('readingLedger'),
                  value: <Copy k={reading ? (reading.ledger.status === 'configured' ? 'configured' : 'absent') : 'unknown'} />,
                  note: t('checked'),
                },
                {
                  label: t('readingStore'),
                  value: <Copy k={reading ? (reading.pg.status === 'configured' ? 'configured' : 'absent') : 'unknown'} />,
                  note: t('checked'),
                },
                { label: t('readingJobs'), value: reading ? reading.jobs.length : t('unknown'), note: t('checked') },
              ]}
            />
            <Button variant="secondary" onClick={health.reload}>
              <Copy k="tabStatus" />
            </Button>
          </>
        )}
      </Panel>
      <Panel title={t('journeyTitle')}>
        <Journey steps={steps} label={t('journeyLabel')} />
        <a className="button button--secondary" href="/support">
          <Copy k="support" />
        </a>
      </Panel>
    </div>
  );
}

function Workers() {
  const api = useApi();
  const [minutes, setMinutes] = useState<WindowMinutes>(60);
  const read = useResource(
    (signal) => api.query('mining', 'workers.mine', { windowMinutes: minutes }, minerWorkers, { signal }),
    `mining-workers:${minutes}`,
  );
  return <WorkersView read={read} minutes={minutes} onMinutes={setMinutes} />;
}

export function WorkersView({
  read,
  minutes,
  onMinutes,
}: {
  read: Read<MinerWorkers>;
  minutes: WindowMinutes;
  onMinutes: (minutes: WindowMinutes) => void;
}) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const { timeZone } = usePreferences();
  const [name, setName] = useState('');
  return (
    <div className="more-columns">
      <Panel title={t('workersRegister')}>
        <Field
          label={t('workerName')}
          hint={t('workerNameHint')}
          value={name}
          maxLength={64}
          onChange={(event) => setName(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
        />
        <DisabledAction label={t('workerRegisterAction')} reason={t('workerRegisterReason')} />
      </Panel>
      <Panel title={t('workersRoster')}>
        <Select
          label={t('rosterWindow')}
          value={String(minutes)}
          onChange={(value) => onMinutes(WINDOW_MINUTES.find((option) => String(option) === value) ?? 60)}
          options={WINDOW_MINUTES.map((option) => ({ value: String(option), label: t(`window_${option}`) }))}
        />
        <Read resource={read.resource} retry={read.reload}>
          {(data) =>
            data.workers.length === 0 ? (
              <EmptyState title={<Copy k="workersEmpty" />}>
                <Copy k="workersEmptyBody" />
              </EmptyState>
            ) : (
              <>
                <DataTable headers={[t('rosterName'), t('rosterWeight'), t('rosterAdded')]} label={t('workersRoster')}>
                  {data.workers.map((worker) => (
                    <tr key={worker.id}>
                      <td lang="und">{worker.name}</td>
                      <td className="numeric">{worker.hashrate === null ? t('rosterNoShares') : displayAmount(worker.hashrate)}</td>
                      <td>{stamp(worker.createdAt, timeZone)}</td>
                    </tr>
                  ))}
                </DataTable>
                <p className="muted">
                  <Copy k="workersNote" />
                </p>
                <p className="muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
              </>
            )
          }
        </Read>
      </Panel>
    </div>
  );
}

function Shares() {
  const api = useApi();
  const read = useResource((signal) => api.query('mining', 'shares.mine', {}, minerShares, { signal }), 'mining-shares');
  return <SharesView read={read} />;
}

export function SharesView({ read }: { read: Read<MinerShares> }) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <div className="more-columns">
      <Panel title={t('sharesTitle')}>
        <Read resource={read.resource} retry={read.reload}>
          {(data) =>
            data.windows.length === 0 ? (
              <EmptyState title={<Copy k="sharesNone" />}>
                <Copy k="sharesNoneBody" />
              </EmptyState>
            ) : (
              <>
                <StatRow
                  items={[
                    { label: t('sharesCount'), value: data.windows.reduce((sum, row) => sum + row.acceptedCount, 0) },
                    { label: t('sharesRejected'), value: data.windows.reduce((sum, row) => sum + row.rejectedCount, 0) },
                    {
                      label: t('sharesWeight'),
                      value: (() => {
                        const total = sumWeights(data.windows.map((row) => row.acceptedWeight));
                        return total === null ? t('unknown') : displayAmount(total);
                      })(),
                    },
                  ]}
                />
                <DataTable
                  headers={[t('sharesWindowCol'), t('sharesAccepted'), t('sharesRefused'), t('sharesWeight')]}
                  label={t('sharesByWindow')}
                >
                  {data.windows.map((row, index) => (
                    <tr key={row.windowId}>
                      <td>{t('sharesWindowN', { n: index + 1 })}</td>
                      <td className="numeric">{row.acceptedCount}</td>
                      <td className="numeric">{row.rejectedCount}</td>
                      <td className="numeric">{row.acceptedWeight === null ? '—' : displayAmount(row.acceptedWeight)}</td>
                    </tr>
                  ))}
                </DataTable>
                <p className="muted">{t('asOf', { time: stamp(data.asOf, timeZone) })}</p>
              </>
            )
          }
        </Read>
      </Panel>
      <Panel title={t('sharesRuleTitle')}>
        <p className="muted">
          <Copy k="sharesRule" />
        </p>
      </Panel>
    </div>
  );
}

function Rewards() {
  const api = useApi();
  const terms = useResource((signal) => api.query('mining', 'terms', undefined, poolTerms, { signal }), 'mining-terms');
  const pending = useResource((signal) => api.query('mining', 'windows.pending', undefined, pendingWindows, { signal }), 'mining-pending');
  const firstPage = useResource(
    (signal) => api.query('mining', 'payouts.mine', { limit: PAYOUT_PAGE }, payoutPage, { signal }),
    'mining-payouts',
  );
  const [more, setMore] = useState<{ rows: PayoutPage['payouts']; next: string | null; busy: boolean; failed: boolean } | null>(null);
  const first = firstPage.resource.status === 'ready' ? firstPage.resource.data : null;
  const next = more ? more.next : (first?.nextCursor ?? null);
  async function showMore() {
    if (!next || more?.busy) return;
    setMore({ rows: more?.rows ?? [], next, busy: true, failed: false });
    const result = await api.query('mining', 'payouts.mine', { limit: PAYOUT_PAGE, cursor: next }, payoutPage);
    setMore((current) => ({
      rows: [...(current?.rows ?? []), ...(result.ok ? result.data.payouts : [])],
      next: result.ok ? result.data.nextCursor : next,
      busy: false,
      failed: !result.ok,
    }));
  }
  return (
    <RewardsView
      terms={terms}
      pending={pending}
      payouts={firstPage}
      extra={more?.rows ?? []}
      hasMore={next !== null}
      busy={more?.busy ?? false}
      moreFailed={more?.failed ?? false}
      onMore={() => void showMore()}
    />
  );
}

export function RewardsView({
  terms,
  pending,
  payouts,
  extra = [],
  hasMore = false,
  busy = false,
  moreFailed = false,
  onMore = () => undefined,
}: {
  terms: Read<PoolTerms>;
  pending: Read<PendingWindows>;
  payouts: Read<PayoutPage>;
  extra?: PayoutPage['payouts'];
  hasMore?: boolean;
  busy?: boolean;
  moreFailed?: boolean;
  onMore?: () => void;
}) {
  const { Copy, t } = miningDepthCopy.useCopy();
  const { timeZone } = usePreferences();
  const amounts = (rows: { assetId: string; amount: string }[]) =>
    rows.length ? rows.map((row) => `${displayAmount(row.amount)} ${row.assetId}`).join(', ') : null;
  const termsData = terms.resource.status === 'ready' ? terms.resource.data : null;
  const pendingData = pending.resource.status === 'ready' ? pending.resource.data : null;
  const rows = payouts.resource.status === 'ready' ? [...payouts.resource.data.payouts, ...extra] : null;
  const credited = rows ? amounts(sumByAsset(rows)) : null;
  const estimated = pendingData
    ? amounts(sumByAsset(pendingData.windows.map((row) => ({ assetId: row.assetId, amount: row.estimate?.estimatedGross ?? null }))))
    : null;
  const loadingOf = (read: Read<unknown>) => read.resource.status === 'loading';
  const unknown = t('unknown');
  return (
    <div className="more-columns">
      <Panel title={t('rewardsTitle')}>
        <StatRow
          items={[
            {
              label: t('rewardsCredited'),
              value: loadingOf(payouts) ? '…' : rows ? (credited ?? displayAmount('0')) : unknown,
              ...(rows && hasMore ? { note: t('payoutsSoFar') } : {}),
            },
            {
              label: t('rewardsPending'),
              value: loadingOf(pending) ? '…' : pendingData ? (estimated ?? t('noEstimate')) : unknown,
              ...(pendingData ? { note: t('pendingEstimateNote') } : {}),
            },
            {
              label: t('rewardsFee'),
              value: loadingOf(terms)
                ? '…'
                : termsData
                  ? termsData.feeBps === null
                    ? t('notSet')
                    : t('feeValue', { percent: bpsToPercent(termsData.feeBps) })
                  : unknown,
            },
            {
              label: t('rewardsWindow'),
              value: loadingOf(terms)
                ? '…'
                : termsData
                  ? termsData.windowSize === null
                    ? t('notSet')
                    : t('windowSizeValue', { count: termsData.windowSize })
                  : unknown,
            },
          ]}
        />
        <p className="muted">
          <Copy k="rewardsMethod" />
        </p>
        <Read resource={payouts.resource} retry={payouts.reload}>
          {(page) => {
            const all = [...page.payouts, ...extra];
            return all.length === 0 ? (
              <EmptyState title={<Copy k="payoutsNone" />}>
                <Copy k="payoutsNoneBody" />
              </EmptyState>
            ) : (
              <>
                <DataTable headers={[t('payoutPaid'), t('payoutAmount')]} label={t('payoutsTitle')}>
                  {all.map((row) => (
                    <tr key={`${row.windowId}:${row.minerId}`}>
                      <td>{row.paidAt ? stamp(row.paidAt, timeZone) : '—'}</td>
                      <td className="numeric">
                        {row.amount === null ? t('payoutAmountMissing') : `${displayAmount(row.amount)} ${row.assetId}`}
                      </td>
                    </tr>
                  ))}
                </DataTable>
                {hasMore ? (
                  <Button variant="ghost" disabled={busy} onClick={onMore}>
                    <Copy k="payoutsMore" />
                  </Button>
                ) : null}
                {moreFailed ? (
                  <p role="status" className="muted">
                    <Copy k="moreFailed" />
                  </p>
                ) : null}
                <p className="muted">{t('asOf', { time: stamp(page.asOf, timeZone) })}</p>
              </>
            );
          }}
        </Read>
        <DisabledAction label={t('rewardsExport')} reason={t('rewardsExportReason')} />
      </Panel>
      <Panel title={t('openWindows')}>
        <Read resource={pending.resource} retry={pending.reload}>
          {(data) =>
            data.windows.length === 0 ? (
              <EmptyState title={<Copy k="pendingNone" />}>
                <Copy k="pendingNoneBody" />
              </EmptyState>
            ) : (
              <DataTable
                headers={[t('sharesWindowCol'), t('pendingMine'), t('pendingTotal'), t('pendingReward'), t('pendingEstimate')]}
                label={t('openWindows')}
              >
                {data.windows.map((row, index) => (
                  <tr key={row.windowId}>
                    <td>{t('sharesWindowN', { n: index + 1 })}</td>
                    <td className="numeric">{displayAmount(row.callerWeight)}</td>
                    <td className="numeric">{row.totalWeight === null ? '—' : displayAmount(row.totalWeight)}</td>
                    <td className="numeric">{row.reward === null ? '—' : `${displayAmount(row.reward)} ${row.assetId}`}</td>
                    <td className="numeric">
                      {row.estimate ? `${displayAmount(row.estimate.estimatedGross)} ${row.assetId}` : t('noEstimate')}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )
          }
        </Read>
        <p>
          <Copy k="rewardsDestinationBody" />
        </p>
      </Panel>
    </div>
  );
}
