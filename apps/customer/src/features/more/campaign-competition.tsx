import { useMemo } from 'react';
import { type CampaignView, type CompetitionBoard } from '@intafaced/contracts/campaigns-catalogue';
import { CAMPAIGNS_COMPETITION_BOARD } from '@intafaced/contracts/campaigns-procedures';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { EmptyNote, FailureNote, ScrollTable, Section, Waiting } from './volt-parts';
import { campaignCompetitionCopy } from './campaign-competition-copy';

/**
 * A trading competition's board (CM-promotions-events-01, J-campaigns-11): its rules' terms (ranking basis, threshold,
 * seats left, prize table), the leaderboard read from the venue's own fills, the caller's entry and milestones, and
 * the results once the period closed. Everything shown is read from svc-campaigns; entrants are shown by seat, never by
 * who they are. `version` changes after a join, so the board is read again.
 */
export function CampaignCompetition({ campaign, version }: { campaign: CampaignView; version: string }) {
  const api = useApi();
  const { t, renderedLocale } = campaignCompetitionCopy.useCopy();
  const board = useResource(
    (signal) => api.call(CAMPAIGNS_COMPETITION_BOARD, { campaignId: campaign.id }, { signal }),
    `competition-${campaign.id}-${version}`,
  );
  const when = useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
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
      <Section title={t('title')}>
        <Waiting label={t('loading')} />
      </Section>
    );
  }
  if (board.resource.status === 'failed') {
    return (
      <Section title={t('title')}>
        <FailureNote result={board.resource.failure} retry={board.reload} />
      </Section>
    );
  }
  const b: CompetitionBoard = board.resource.data;
  return (
    <div data-testid="competition" data-closed={String(b.closed)}>
      <Section title={t('title')}>
        <KeyValue
          rows={[
            {
              label: t('basis'),
              value: (
                <span data-testid="competition-basis" data-basis={b.basis}>
                  {t(`basis_${b.basis}`)}
                </span>
              ),
            },
            {
              label: t('threshold'),
              value: (
                <span data-testid="competition-threshold" lang="zxx">
                  {t('thresholdValue', { amount: b.threshold, asset: b.volumeAsset })}
                </span>
              ),
            },
            {
              label: t('seatsLeft'),
              value: (
                <span data-testid="competition-seats-left" data-left={b.seatsLeft} lang="zxx">
                  {t('seatsLeftValue', { left: b.seatsLeft, seats: b.seats })}
                </span>
              ),
            },
            {
              label: b.closed ? t('closed') : t('closes'),
              value: <span data-testid="competition-closes">{when(b.closesAt)}</span>,
            },
            {
              label: t('pool'),
              value: (
                <span data-testid="competition-pool" lang="zxx">
                  {t('poolValue', { amount: b.pool, asset: b.prizeAsset })}
                </span>
              ),
            },
          ]}
        />
        <p className="lt-hint">{t('volumeNote')}</p>
      </Section>
      <Section title={t('prizesTitle')}>
        <ScrollTable label={t('prizesLabel')} headers={[t('colPlace'), t('colPrize')]}>
          {b.prizes.map((p) => (
            <tr key={p.rank} data-testid="competition-prize" data-rank={p.rank}>
              <th scope="row">{t('placeValue', { rank: p.rank })}</th>
              <td lang="zxx" data-testid="competition-prize-amount">
                {t('prizeValue', { amount: p.amount, asset: b.prizeAsset })}
              </td>
            </tr>
          ))}
        </ScrollTable>
      </Section>
      <Section title={t('mineTitle')}>
        {b.mine ? (
          <p role="status" data-testid="competition-mine" data-rank={b.mine.rank} data-seat={b.mine.seat} data-volume={b.mine.volume}>
            {t('mineValue', { seat: b.mine.seat, rank: b.mine.rank, volume: b.mine.volume, asset: b.volumeAsset })}
          </p>
        ) : (
          <p className="lt-hint" data-testid="competition-mine-none">
            {t('mineNone')}
          </p>
        )}
        {b.unread ? (
          <p role="status" className="lt-hint" data-testid="competition-unread" data-code={b.unread}>
            {t('unread', { code: b.unread })}
          </p>
        ) : b.asOf ? (
          <p className="lt-hint" data-testid="competition-as-of">
            {t('asOf', { when: when(b.asOf) })}
          </p>
        ) : null}
      </Section>
      <Section title={t('boardTitle')}>
        {b.standings.length === 0 ? (
          <EmptyNote title={t('boardNone')} />
        ) : (
          <ScrollTable label={t('boardLabel')} headers={[t('colRank'), t('colEntrant'), t('colVolume'), t('colFills'), t('colQualifies')]}>
            {b.standings.map((s) => (
              <tr
                key={s.seat}
                data-testid="competition-standing"
                data-rank={s.rank}
                data-seat={s.seat}
                data-you={String(s.you)}
                data-volume={s.volume}
                data-fills={s.fills}
              >
                <th scope="row">{s.rank}</th>
                <td>{s.you ? t('entrantYou', { seat: s.seat }) : t('entrant', { seat: s.seat })}</td>
                <td lang="zxx" data-testid="competition-standing-volume">
                  {s.volume} {b.volumeAsset}
                </td>
                <td lang="zxx">{s.fills}</td>
                <td>{s.qualifies ? t('yes') : t('no')}</td>
              </tr>
            ))}
          </ScrollTable>
        )}
        <p className="lt-hint">{t('boardOrder')}</p>
      </Section>
      <Section title={t('milestonesTitle')}>
        {b.milestones.length === 0 ? (
          <p className="lt-hint">{t('milestonesNone')}</p>
        ) : (
          <ScrollTable label={t('milestonesLabel')} headers={[t('colTier'), t('colAt'), t('colPrize'), t('colState')]}>
            {b.milestones.map((m) => (
              <tr
                key={m.tier}
                data-testid="competition-milestone"
                data-tier={m.tier}
                data-reached={String(m.reached)}
                data-reward-key={m.rewardKey ?? ''}
              >
                <th scope="row">{m.tier}</th>
                <td lang="zxx">
                  {m.volume} {b.volumeAsset}
                </td>
                <td lang="zxx">{t('prizeValue', { amount: m.amount, asset: b.prizeAsset })}</td>
                <td data-testid="competition-milestone-state">{m.reached ? t('milestoneReached') : t('milestoneOpen')}</td>
              </tr>
            ))}
          </ScrollTable>
        )}
        <p className="lt-hint">{t('milestoneNote')}</p>
      </Section>
      <Section title={t('settlementTitle')}>
        {b.settlement ? (
          <div data-testid="competition-settlement">
            <p data-testid="competition-settled">
              {t('settledAt', {
                when: when(b.settlement.settledAt),
                total: b.settlement.prizesTotal,
                remainder: b.settlement.remainder,
                asset: b.prizeAsset,
              })}
            </p>
            {b.settlement.winners.length === 0 ? (
              <p className="lt-hint">{t('noWinners')}</p>
            ) : (
              <ScrollTable label={t('winnersLabel')} headers={[t('colPlace'), t('colWinner'), t('colPrize')]}>
                {b.settlement.winners.map((w) => (
                  <tr key={w.rank} data-testid="competition-winner" data-rank={w.rank} data-seat={w.seat} data-you={String(w.you)}>
                    <th scope="row">{t('placeValue', { rank: w.rank })}</th>
                    <td>{w.you ? t('entrantYou', { seat: w.seat }) : t('entrant', { seat: w.seat })}</td>
                    <td lang="zxx">{t('prizeValue', { amount: w.amount, asset: b.prizeAsset })}</td>
                  </tr>
                ))}
              </ScrollTable>
            )}
            {b.settlement.winners
              .filter((w) => w.you)
              .map((w) => (
                <p key={w.rank} role="status" data-testid="competition-you-won">
                  {t('youWon', { rank: w.rank, amount: w.amount, asset: b.prizeAsset })}{' '}
                  <a className="lt-link" href="/uc/promotion">
                    {t('seeRewards')}
                  </a>
                </p>
              ))}
          </div>
        ) : (
          <p className="lt-hint" data-testid="competition-settlement-none">
            {t('settlementNone')}
          </p>
        )}
      </Section>
    </div>
  );
}
