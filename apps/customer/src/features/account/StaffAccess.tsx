import { useMemo } from 'react';
import { staffAccessMineInputSchema, staffAccessMineOutputSchema, type StaffAccessRow } from '@intafaced/contracts/staff-access';
import { contractProcedure, readContract } from '../../shared/contract-call';
import { defineCopy } from '../../shared/i18n';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading, Page } from '../../shared/ui';
import { useSession } from '../session/session';

const copy = defineCopy('staff-access', {
  title: 'Staff access',
  lead: 'Each time our staff looked at or acted on your trading account, with who did it and when. Nothing here is hidden from you.',
  colAt: 'Time',
  colWhat: 'What was done',
  colWho: 'Staff member',
  colOn: 'On',
  kind_venue_orders_get: 'Looked up one of your routed orders',
  kind_orders_get: 'Looked up one of your orders',
  kind_orders_list: 'Listed your orders',
  kind_other: 'Staff action: {kind}',
  empty: 'No staff member has looked at or acted on your trading account.',
  refresh: 'Refresh',
  loading: 'Reading who accessed your account…',
  back: 'Security',
  link: 'Staff access: who looked at your trading account',
});

/** The Security page's way in to the access list. */
export function StaffAccessLink() {
  const { t } = copy.useCopy();
  return (
    <p>
      <a className="text-link" href="/uc/safe/staff-access" data-testid="staff-access-link">
        {t('link')}
      </a>
    </p>
  );
}

/** The most rows one read shows. */
export const STAFF_ACCESS_ROWS = 100;

const staffAccessMine = contractProcedure('trade', 'staffAccess.mine', {
  input: staffAccessMineInputSchema,
  output: staffAccessMineOutputSchema,
});

type T = ReturnType<typeof copy.useCopy>['t'];

/** The operator record's kind in the person's own words; a kind with no words of its own is named as it is. */
export function kindWords(t: T, kind: string): string {
  if (kind === 'venue_orders.get') return t('kind_venue_orders_get');
  if (kind === 'orders.get') return t('kind_orders_get');
  if (kind === 'orders.list') return t('kind_orders_list');
  return t('kind_other', { kind });
}

/**
 * The person's own access list (J-cex-spot-18 #5, row d115: every read logged where the customer sees it): each staff
 * read or act that named their trading account, newest first, with the staff member, what they did, on what, and when.
 */
export function StaffAccess() {
  const { t, requestedLocale } = copy.useCopy();
  const { api, userId } = useSession();
  const { resource, reload } = useResource(
    (signal) => readContract(api, staffAccessMine, { limit: STAFF_ACCESS_ROWS }, { signal }),
    `staff-access:${userId}`,
  );
  const when = useMemo(
    () => new Intl.DateTimeFormat(requestedLocale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }),
    [requestedLocale],
  );
  const rows: readonly StaffAccessRow[] | null = resource.status === 'ready' ? resource.data.rows : null;
  return (
    <Page
      title={t('title')}
      actions={
        <a className="text-link" href="/uc/safe">
          {t('back')}
        </a>
      }
    >
      <section data-testid="staff-access" className="security__card" aria-labelledby="staff-access-title">
        <h2 id="staff-access-title">{t('title')}</h2>
        <p className="muted">{t('lead')}</p>
        {resource.status === 'loading' && <Loading label={t('loading')} />}
        {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
        {rows && rows.length === 0 && <p className="muted">{t('empty')}</p>}
        {rows && rows.length > 0 && (
          <div className="api-keys__table-wrap">
            <table className="api-keys__table" aria-labelledby="staff-access-title">
              <thead>
                <tr>
                  <th scope="col">{t('colAt')}</th>
                  <th scope="col">{t('colWhat')}</th>
                  <th scope="col">{t('colWho')}</th>
                  <th scope="col">{t('colOn')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid="staff-access-row"
                    data-access-id={row.id}
                    data-kind={row.kind}
                    data-object-id={row.objectId}
                  >
                    <td>
                      <time dateTime={row.occurredAt}>{`${when.format(new Date(row.occurredAt))} UTC`}</time>
                    </td>
                    <td>{kindWords(t, row.kind)}</td>
                    <td data-testid="staff-access-operator">
                      <code lang="und">{row.operatorId}</code>
                    </td>
                    <td>
                      <code lang="und">{row.objectId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Button variant="secondary" onClick={reload} disabled={resource.status === 'loading'}>
          {t('refresh')}
        </Button>
      </section>
    </Page>
  );
}
