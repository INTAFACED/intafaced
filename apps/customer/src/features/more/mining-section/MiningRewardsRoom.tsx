// volt-room: /mining/rewards
import { Button } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { displayAmount } from '../../../shared/money';
import { usePreferences } from '../../../shared/preferences';
import type { Resource } from '../../../shared/resource';
import { stamp } from '../../../screens/money/time';
import { useMiningRewards } from '../MiningRooms';
import { miningCopy } from '../mining-copy';
import { miningDepthCopy } from '../mining-depth-copy';
import { bpsToPercent, sumByAsset } from '../mining-reads';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { EmptyNote, KitRead, ScrollTable, Section } from '../volt-parts';
import { MiningSections } from './MiningStatusRoom';

type Read<T> = { resource: Resource<T>; reload: () => void };

/**
 * `/mining/rewards` on the record-list template: paid credits, open windows, pool fee and window size terms. Uses the
 * same reads and words as `../MiningRooms.tsx`.
 */
export function MiningRewardsRoom({ paper }: { paper: boolean }) {
  const { terms, pending, payouts, extra, hasMore, busy, moreFailed, onMore } = useMiningRewards();
  const { Copy, t } = miningDepthCopy.useCopy();
  const scope = miningCopy.useCopy().t('scope');
  const routes = moreRoomRoutesCopy.useCopy();
  const { timeZone } = usePreferences();

  const amounts = (rows: { assetId: string; amount: string }[]) =>
    rows.length ? rows.map((row) => `${displayAmount(row.amount)} ${row.assetId}`).join(', ') : null;
  const termsData = terms.resource.status === 'ready' ? terms.resource.data : null;
  const pendingData = pending.resource.status === 'ready' ? pending.resource.data : null;
  const rows = payouts.resource.status === 'ready' ? [...payouts.resource.data.payouts, ...extra] : null;
  const credited = rows ? amounts(sumByAsset(rows)) : null;
  // A payout whose amount can't be read is left out of the total, and the total says so. It is never counted as zero.
  const missing = rows?.some((row) => row.amount === null) ?? false;
  const estimated = pendingData
    ? amounts(sumByAsset(pendingData.windows.map((row) => ({ assetId: row.assetId, amount: row.estimate?.estimatedGross ?? null }))))
    : null;
  const loadingOf = (read: Read<unknown>) => read.resource.status === 'loading';
  const unknown = t('unknown');

  return (
    <RecordListTemplate
      title={routes.t('rewards')}
      description={scope}
      state={{ kind: 'ready' }}
      filters={<MiningSections value="Rewards" paper={paper} />}
      summary={
        <div className="lt-stack">
          <dl className="lt-kv">
            <div>
              <dt>{t('rewardsCredited')}</dt>
              <dd>
                {loadingOf(payouts) ? '…' : rows ? (rows.length === 0 ? displayAmount('0') : (credited ?? unknown)) : unknown}
                {rows && missing && credited ? (
                  <span className="lt-kv-note">{t('creditedIncomplete')}</span>
                ) : rows && hasMore ? (
                  <span className="lt-kv-note">{t('payoutsSoFar')}</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>{t('rewardsPending')}</dt>
              <dd>
                {loadingOf(pending) ? '…' : pendingData ? (estimated ?? t('noEstimate')) : unknown}
                {pendingData ? <span className="lt-kv-note">{t('pendingEstimateNote')}</span> : null}
              </dd>
            </div>
            <div>
              <dt>{t('rewardsFee')}</dt>
              <dd>
                {loadingOf(terms)
                  ? '…'
                  : termsData
                    ? termsData.feeBps === null
                      ? t('notSet')
                      : t('feeValue', { percent: bpsToPercent(termsData.feeBps) })
                    : unknown}
              </dd>
            </div>
            <div>
              <dt>{t('rewardsWindow')}</dt>
              <dd>
                {loadingOf(terms)
                  ? '…'
                  : termsData
                    ? termsData.windowSize === null
                      ? t('notSet')
                      : t('windowSizeValue', { count: termsData.windowSize })
                    : unknown}
              </dd>
            </div>
          </dl>
          <p className="lt-muted">
            <Copy k="rewardsMethod" />
          </p>
        </div>
      }
      list={
        <Section title={t('rewardsTitle')} className="lt-stack">
          <KitRead resource={payouts.resource} retry={payouts.reload}>
            {(page) => {
              const all = [...page.payouts, ...extra];
              return all.length === 0 ? (
                <EmptyNote title={<Copy k="payoutsNone" />}>
                  <Copy k="payoutsNoneBody" />
                </EmptyNote>
              ) : (
                <>
                  <ScrollTable headers={[t('payoutPaid'), t('payoutAmount')]} label={t('payoutsTitle')}>
                    {all.map((row) => (
                      <tr key={`${row.windowId}:${row.minerId}`}>
                        <td>
                          {row.paidAt ? stamp(row.paidAt, timeZone) : '—'}
                          {row.ledgerReason ? (
                            <>
                              <br />
                              <small className="lt-muted">{t('payoutUnconfirmed')}</small>
                            </>
                          ) : null}
                        </td>
                        <td className="lt-num">
                          {row.amount === null ? t('payoutAmountMissing') : `${displayAmount(row.amount)} ${row.assetId}`}
                        </td>
                      </tr>
                    ))}
                  </ScrollTable>
                  {hasMore ? (
                    <div className="lt-actions">
                      <Button tone="quiet" disabled={busy} onClick={onMore}>
                        <Copy k="payoutsMore" />
                      </Button>
                    </div>
                  ) : null}
                  {moreFailed ? (
                    <p role="status" className="lt-muted">
                      <Copy k="moreFailed" />
                    </p>
                  ) : null}
                  <p className="lt-muted">{t('asOf', { time: stamp(page.asOf, timeZone) })}</p>
                </>
              );
            }}
          </KitRead>
          <div className="lt-stack">
            <div className="lt-actions">
              <Button tone="secondary" disabled aria-disabled="true">
                {t('rewardsExport')}
              </Button>
            </div>
            <p className="lt-hint" role="note">
              {t('rewardsExportReason')}
            </p>
          </div>
        </Section>
      }
      detail={
        <Section title={t('openWindows')} className="lt-stack">
          <KitRead resource={pending.resource} retry={pending.reload}>
            {(data) =>
              data.windows.length === 0 ? (
                <EmptyNote title={<Copy k="pendingNone" />}>
                  <Copy k="pendingNoneBody" />
                </EmptyNote>
              ) : (
                <ScrollTable
                  headers={[t('sharesWindowCol'), t('pendingMine'), t('pendingTotal'), t('pendingReward'), t('pendingEstimate')]}
                  label={t('openWindows')}
                >
                  {data.windows.map((row, index) => (
                    <tr key={row.windowId}>
                      <td>{t('openWindowN', { n: index + 1 })}</td>
                      <td className="lt-num">{displayAmount(row.callerWeight)}</td>
                      <td className="lt-num">{row.totalWeight === null ? '—' : displayAmount(row.totalWeight)}</td>
                      <td className="lt-num">{row.reward === null ? '—' : `${displayAmount(row.reward)} ${row.assetId}`}</td>
                      <td className="lt-num">
                        {row.estimate ? `${displayAmount(row.estimate.estimatedGross)} ${row.assetId}` : t('noEstimate')}
                      </td>
                    </tr>
                  ))}
                </ScrollTable>
              )
            }
          </KitRead>
          <p>
            <Copy k="rewardsDestinationBody" />
          </p>
        </Section>
      }
    />
  );
}
