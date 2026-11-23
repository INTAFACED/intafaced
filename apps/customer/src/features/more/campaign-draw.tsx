import { useMemo } from 'react';
import { type CampaignView, type DrawBoard } from '@intafaced/contracts/campaigns-catalogue';
import { CAMPAIGNS_DRAW_BOARD } from '@intafaced/contracts/campaigns-procedures';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { FailureNote, ScrollTable, Section, Waiting } from './volt-parts';
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
    (signal) => api.call(CAMPAIGNS_DRAW_BOARD, { campaignId: campaign.id }, { signal }),
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
  const b: DrawBoard = board.resource.data;
  const mine = b.mine;
  return (
    <div data-testid="draw" data-closed={String(b.closed)}>
      <Section title={t('title')}>
        <KeyValue
          rows={[
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
      </Section>
      <Section title={t('prizesTitle')}>
        <ScrollTable label={t('prizesLabel')} headers={[t('colPlace'), t('colPrize')]}>
          {b.prizes.map((p) => (
            <tr key={p.rank} data-testid="draw-prize" data-rank={p.rank}>
              <th scope="row">{t('placeValue', { rank: p.rank })}</th>
              <td lang="zxx" data-testid="draw-prize-amount">
                {t('prizeValue', { amount: p.amount, asset: b.prizeAsset })}
              </td>
            </tr>
          ))}
        </ScrollTable>
      </Section>
      <Section title={t('oddsTitle')}>
        <p data-testid="draw-odds" data-mine={mine?.chances ?? 0} data-total={b.totalChances}>
          {b.totalChances > 0 ? t('odds', { mine: mine?.chances ?? 0, total: b.totalChances }) : t('oddsNone')}
        </p>
      </Section>
      <Section title={t('earnTitle')}>
        <p data-testid="draw-earn" data-per-fill={b.chancesPerFill}>
          {t('earn', { n: b.chancesPerFill })}
        </p>
        <ScrollTable label={t('capsLabel')} headers={[t('colUserType'), t('colCap')]}>
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
        </ScrollTable>
      </Section>
      <Section title={t('mineTitle')}>
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
          <p className="lt-hint" data-testid="draw-mine-none">
            {t('mineNone')}
          </p>
        )}
        {b.unread ? (
          <p role="status" className="lt-hint" data-testid="draw-unread" data-code={b.unread}>
            {t('unread', { code: b.unread })}
          </p>
        ) : b.asOf ? (
          <p className="lt-hint" data-testid="draw-as-of">
            {t('asOf', { when: when(b.asOf) })}
          </p>
        ) : null}
      </Section>
      <Section title={t('auditTitle')}>
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
        <p className="lt-hint">{t('auditNote')}</p>
      </Section>
      <Section title={t('runTitle')}>
        <p role="status" data-testid="draw-not-running" data-code={b.running.code}>
          {t('notRunning', { question: b.running.question })}
        </p>
        <p className="lt-hint" data-testid="draw-nothing-paid">
          {t('nothingPaid')}
        </p>
      </Section>
    </div>
  );
}
