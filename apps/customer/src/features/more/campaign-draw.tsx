import { useMemo } from 'react';
import { drawBoardSchema, type CampaignView, type DrawBoard } from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { DataTable, Failure, Loading, Panel } from '../../shared/ui';
import { StatRow } from './depth-kit';
import { campaignDrawCopy } from './campaign-draw-copy';

/**
 * A lucky draw (CM-promotions-events-02, J-campaigns-12): its prize table, how chances are earned and the cap for each user
 * type, the odds as they stand, the caller's own chances, the seed's commitment and the entry list's hash, and why the
 * draw does not run. Everything shown is read from svc-campaigns. `version` changes after a join, so the board is read
 * again.
 */
export function CampaignDraw({ campaign, version }: { campaign: CampaignView; version: string }) {
  const api = useApi();
  const { t, renderedLocale } = campaignDrawCopy.useCopy();
  const board = useResource(
    (signal) => api.query('campaigns', 'draw.board', { campaignId: campaign.id }, drawBoardSchema, { signal }),
    `draw-${campaign.id}-${version}`,
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
  const b: DrawBoard = board.resource.data;
  const mine = b.mine;
  return (
    <div data-testid="draw" data-closed={String(b.closed)}>
      <Panel title={t('title')}>
        <StatRow
          items={[
            {
              label: t('pool'),
              value: (
                <span data-testid="draw-pool" lang="zxx">
                  {t('poolValue', { amount: b.pool, asset: b.prizeAsset })}
                </span>
              ),
            },
            { label: b.closed ? t('closed') : t('closes'), value: <span data-testid="draw-closes">{when(b.closesAt)}</span> },
            { label: t('entrants'), value: <span data-testid="draw-entrants">{b.entrants}</span> },
            { label: t('totalChances'), value: <span data-testid="draw-total-chances">{b.totalChances}</span> },
          ]}
        />
      </Panel>
      <Panel title={t('prizesTitle')}>
        <DataTable label={t('prizesLabel')} headers={[t('colPlace'), t('colPrize')]}>
          {b.prizes.map((p) => (
            <tr key={p.rank} data-testid="draw-prize" data-rank={p.rank}>
              <th scope="row">{t('placeValue', { rank: p.rank })}</th>
              <td lang="zxx" data-testid="draw-prize-amount">
                {t('prizeValue', { amount: p.amount, asset: b.prizeAsset })}
              </td>
            </tr>
          ))}
        </DataTable>
      </Panel>
      <Panel title={t('oddsTitle')}>
        <p data-testid="draw-odds" data-mine={mine?.chances ?? 0} data-total={b.totalChances}>
          {b.totalChances > 0 ? t('odds', { mine: mine?.chances ?? 0, total: b.totalChances }) : t('oddsNone')}
        </p>
      </Panel>
      <Panel title={t('earnTitle')}>
        <p data-testid="draw-earn" data-per-fill={b.chancesPerFill}>
          {t('earn', { n: b.chancesPerFill })}
        </p>
        <DataTable label={t('capsLabel')} headers={[t('colUserType'), t('colCap')]}>
          {b.caps.map((c) => (
            <tr
              key={c.userType}
              data-testid="draw-cap"
              data-user-type={c.userType}
              data-cap={c.cap}
              data-mine={String(mine?.userType === c.userType)}
            >
              <th scope="row">{t(`userType_${c.userType}`)}</th>
              <td lang="zxx">{c.cap}</td>
            </tr>
          ))}
        </DataTable>
      </Panel>
      <Panel title={t('mineTitle')}>
        {mine ? (
          <div
            data-testid="draw-mine"
            data-chances={mine.chances}
            data-cap={mine.cap ?? ''}
            data-fills={mine.fills}
            data-capped={String(mine.capped)}
          >
            <p role="status" data-testid="draw-mine-chances">
              {t('mineValue', { chances: mine.chances, cap: mine.cap ?? '—', fills: mine.fills })}
            </p>
            <p data-testid="draw-mine-user-type" data-user-type={mine.userType ?? ''}>
              {mine.userType && mine.cap !== null
                ? t('mineUserType', { type: t(`userType_${mine.userType}`), cap: mine.cap })
                : t('mineUserTypeUnread')}
            </p>
            {mine.capped ? (
              <p role="status" data-testid="draw-mine-capped">
                {t('mineCapped')}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="muted" data-testid="draw-mine-none">
            {t('mineNone')}
          </p>
        )}
        {b.unread ? (
          <p role="status" className="muted" data-testid="draw-unread" data-code={b.unread}>
            {t('unread', { code: b.unread })}
          </p>
        ) : b.asOf ? (
          <p className="muted" data-testid="draw-as-of">
            {t('asOf', { when: when(b.asOf) })}
          </p>
        ) : null}
      </Panel>
      <Panel title={t('auditTitle')}>
        <dl>
          <dt>{t('commitment')}</dt>
          <dd lang="zxx" data-testid="draw-commitment">
            <code>{b.commitment}</code>
          </dd>
          <dt>{t('entryHash')}</dt>
          <dd lang="zxx" data-testid="draw-entry-hash">
            <code>{b.entryHash}</code>
          </dd>
        </dl>
        <p className="muted">{t('auditNote')}</p>
      </Panel>
      <Panel title={t('runTitle')}>
        <p role="status" data-testid="draw-not-running" data-code={b.running.code}>
          {t('notRunning', { question: b.running.question })}
        </p>
        <p className="muted" data-testid="draw-nothing-paid">
          {t('nothingPaid')}
        </p>
      </Panel>
    </div>
  );
}
