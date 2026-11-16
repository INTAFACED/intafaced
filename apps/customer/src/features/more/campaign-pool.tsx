import { useMemo } from 'react';
import { poolBoardSchema, type CampaignView, type PoolBoard } from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { DataTable, Failure, Loading, Panel } from '../../shared/ui';
import { StatRow } from './depth-kit';
import { campaignPoolCopy } from './campaign-pool-copy';

/**
 * A reward pool paying daily (CM-airdrop-campaigns-02, J-campaigns-13 #4 #5): its slice, the per-user cap and the minimum
 * balance; today, with the caller's venue balance read from the venue with its as-of time ("nothing today" below the
 * minimum); and for each settled day the caller's activity, share and payment. Everything shown is read from
 * svc-campaigns. `version` changes after a join, so the board is read again.
 */
export function CampaignPool({ campaign, version }: { campaign: CampaignView; version: string }) {
  const api = useApi();
  const { t, renderedLocale } = campaignPoolCopy.useCopy();
  const board = useResource(
    (signal) => api.query('campaigns', 'pool.board', { campaignId: campaign.id }, poolBoardSchema, { signal }),
    `pool-${campaign.id}-${version}`,
  );
  const when = useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
    return (iso: string) => format.format(new Date(iso));
  }, [renderedLocale]);
  if (board.resource.status === 'loading') {
    return (
      <Panel title={t('title')}>
        <Loading label={t('loading')} />
      </Panel>
    );
  }
  if (board.resource.status === 'failed') {
    return (
      <Panel title={t('title')}>
        <Failure result={board.resource.failure} retry={board.reload} />
      </Panel>
    );
  }
  const b: PoolBoard = board.resource.data;
  const money = (amount: string) => t('amountValue', { amount, asset: b.asset });
  return (
    <div data-testid="pool" data-joined={String(b.joined)}>
      <Panel title={t('title')}>
        <StatRow
          items={[
            {
              label: t('pool'),
              value: (
                <span data-testid="pool-total" lang="zxx">
                  {money(b.pool)}
                </span>
              ),
            },
            {
              label: t('slice'),
              value: (
                <span data-testid="pool-slice" lang="zxx">
                  {money(b.dailySlice)}
                </span>
              ),
            },
            {
              label: t('cap'),
              value: (
                <span data-testid="pool-cap" lang="zxx">
                  {money(b.perUserCap)}
                </span>
              ),
            },
            {
              label: t('minBalance'),
              value: (
                <span data-testid="pool-min-balance" lang="zxx">
                  {t('amountValue', { amount: b.minBalance, asset: b.activityAsset })}
                </span>
              ),
            },
            {
              label: t('dayLength'),
              value: <span data-testid="pool-day-length">{t('dayLengthValue', { minutes: Math.round(b.daySeconds / 60) })}</span>,
            },
          ]}
        />
        <h3>{t('howTitle')}</h3>
        <p className="muted">{t('how', { asset: b.activityAsset })}</p>
      </Panel>
      <Panel title={t('todayTitle')}>
        {!b.joined ? (
          <p className="muted" data-testid="pool-today-none">
            {t('todayNotJoined')}
          </p>
        ) : b.today === null ? null : b.today.unread || b.today.balance === null || b.today.balanceAsOf === null ? (
          <p role="status" className="muted" data-testid="pool-today" data-unread={b.today.unread ?? ''}>
            {t('todayUnread', { code: b.today.unread ?? '' })}
          </p>
        ) : (
          <p
            role="status"
            data-testid="pool-today"
            data-day={b.today.day}
            data-below-minimum={String(b.today.belowMinimum)}
            data-balance={b.today.balance}
            data-as-of={b.today.balanceAsOf}
          >
            {b.today.belowMinimum
              ? t('todayBelow', {
                  balance: b.today.balance,
                  asset: b.activityAsset,
                  asOf: when(b.today.balanceAsOf),
                  min: b.minBalance,
                })
              : t('todayOk', {
                  day: b.today.day,
                  ends: when(b.today.endsAt),
                  balance: b.today.balance,
                  asset: b.activityAsset,
                  asOf: when(b.today.balanceAsOf),
                })}
          </p>
        )}
      </Panel>
      <Panel title={t('daysTitle')}>
        {b.days.length === 0 ? (
          <p className="muted">{t('noDays')}</p>
        ) : (
          <DataTable label={t('daysLabel')} headers={[t('colDay'), t('colActivity'), t('colShare'), t('colPaid')]}>
            {b.days.map((d) => {
              const m = d.mine;
              return (
                <tr
                  key={d.day}
                  data-testid="pool-day"
                  data-day={d.day}
                  data-settled={String(d.settledAt !== null)}
                  data-eligible={m ? String(m.eligible) : ''}
                  data-share={m ? m.share : ''}
                  data-capped={m ? String(m.capped) : ''}
                  data-state={m?.state ?? ''}
                  data-reward-key={m?.rewardKey ?? ''}
                >
                  <th scope="row">{t('dayValue', { day: d.day })}</th>
                  <td lang="zxx" data-testid="pool-day-activity">
                    {m ? t('amountValue', { amount: m.activity, asset: b.activityAsset }) : '—'}
                  </td>
                  <td data-testid="pool-day-share">
                    {d.settledAt === null
                      ? t('dayOpen')
                      : !m
                        ? t('noShare')
                        : !m.eligible
                          ? t('nothingToday', { balance: m.balance, asset: b.activityAsset, asOf: when(m.balanceAsOf) })
                          : m.capped
                            ? t('shareCapped', { amount: m.share, asset: b.asset })
                            : money(m.share)}
                    {d.settledAt !== null && d.sharesTotal !== null && d.remainder !== null ? (
                      <>
                        <br />
                        <span className="muted" data-testid="pool-day-remainder" data-remainder={d.remainder}>
                          {t('remainder', { shares: d.sharesTotal, slice: d.slice, asset: b.asset, remainder: d.remainder })}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td data-testid="pool-day-paid">
                    {m?.chainTx ? (
                      <>
                        {t('paid')}{' '}
                        <code lang="zxx" data-testid="pool-day-chain-tx" data-tx={m.chainTx}>
                          {m.chainTx}
                        </code>
                      </>
                    ) : m?.rewardKey ? (
                      t('owed')
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
