import { useMemo } from 'react';
import { myInviteesSchema, type MyInvitee } from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { DataTable, EmptyState, Failure, Loading, Panel } from '../../shared/ui';
import { referralInviteesCopy } from './referral-invitees-copy';

/**
 * The referrer's invitees on /uc/promotion/mypromotion (CM-referral-02, J-campaigns-06 #1 #2): each one's place in the
 * order they joined, when, each step (verified, deposited, traded) done or not, and their state. svc-campaigns ticks the
 * steps from the invitee's own events and returns only this bounded summary: no name, handle, id, amount or event of the
 * invitee reaches this page.
 */

const STEPS = ['verified', 'deposited', 'traded'] as const;
const COLUMN = { verified: 'colVerified', deposited: 'colDeposited', traded: 'colTraded' } as const;

function useWhen() {
  const { renderedLocale } = referralInviteesCopy.useCopy();
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (iso: string) => f.format(new Date(iso));
  }, [renderedLocale]);
}

export function ReferralInvitees() {
  const api = useApi();
  const { t } = referralInviteesCopy.useCopy();
  const list = useResource((signal) => api.query('campaigns', 'referral.invitees', {}, myInviteesSchema, { signal }), 'referral-invitees');
  const r = list.resource;
  return (
    <section className="referral-block referral-section" aria-label={t('title')} data-testid="referral-invitees" data-state={r.status}>
      <Panel title={t('title')}>
        <p className="muted">{t('intro')}</p>
        {r.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : r.status === 'failed' ? (
          <div data-testid="referral-invitees-failed">
            {r.failure.code === 'campaigns.store_unwired' ? (
              <p role="status" className="muted">
                {t('refusal_campaigns_store_unwired')}
              </p>
            ) : (
              <Failure result={r.failure} retry={list.reload} />
            )}
          </div>
        ) : r.data.invitees.length === 0 ? (
          <div data-testid="referral-invitees-empty">
            <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>
          </div>
        ) : (
          <>
            <DataTable label={t('listLabel')} headers={[t('colInvitee'), t('colJoined'), ...STEPS.map((s) => t(COLUMN[s])), t('colState')]}>
              {r.data.invitees.map((row) => (
                <Row key={row.place} row={row} />
              ))}
            </DataTable>
            {r.data.total > r.data.invitees.length ? (
              <p className="muted" data-testid="referral-invitees-more">
                {t('more', { shown: String(r.data.invitees.length), total: String(r.data.total) })}
              </p>
            ) : null}
          </>
        )}
      </Panel>
    </section>
  );
}

function Row({ row }: { row: MyInvitee }) {
  const { t } = referralInviteesCopy.useCopy();
  const when = useWhen();
  const why =
    row.state === 'qualified' && row.qualifiedAt
      ? t('why_qualified', { when: when(row.qualifiedAt) })
      : row.state === 'no_programme'
        ? t('why_no_programme')
        : row.windowClosesAt
          ? t(row.state === 'window_closed' ? 'why_window_closed' : 'why_in_progress', { closes: when(row.windowClosesAt) })
          : '';
  return (
    <tr data-testid="referral-invitee" data-place={row.place} data-state={row.state}>
      <td>{t('invitee', { place: String(row.place) })}</td>
      <td>
        <time dateTime={row.attachedAt}>{when(row.attachedAt)}</time>
      </td>
      {STEPS.map((step) => (
        <td key={step} data-testid={`invitee-step-${step}`} data-done={row.steps[step] ? 'true' : 'false'}>
          {row.steps[step] ? t('stepDone') : t('stepOpen')}
        </td>
      ))}
      <td>
        <strong data-testid="invitee-state">{t(`state_${row.state}`)}</strong>
        {why ? (
          <span className="muted" data-testid="invitee-why">
            {' '}
            {why}
          </span>
        ) : null}
        {row.programme ? (
          <span className="muted" lang="und">
            {' '}
            {t('programme', { name: row.programme.name })}
          </span>
        ) : null}
      </td>
    </tr>
  );
}
