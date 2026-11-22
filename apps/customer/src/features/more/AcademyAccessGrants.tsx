import { type AcademyAccessGrant } from '@intafaced/contracts/academy-catalogue';
import { usePreferences } from '../../shared/preferences';
import { useResource } from '../../shared/resource';
import { EmptyState, Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session';
import { Details } from './common';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyCourseHref, formatDay } from './academy-lms';
import { AcademyRefusal, pathLabel } from './AcademyLmsParts';
import { ACADEMY_MY_ACCESS_GRANTS } from '@intafaced/contracts/academy-my-access-grants-procedures';

const SOURCE_KEYS = {
  free: 'accessSourceFree',
  purchase: 'accessSourcePurchase',
  staff: 'accessSourceStaff',
  invitation: 'accessSourceInvitation',
} as const satisfies Record<AcademyAccessGrant['source'], string>;

/** The access records on /academy/progress (AC-access-grants-01): one per course, with source and expiry. */
export function AcademyAccessGrants() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const grants = useResource((signal) => api.call(ACADEMY_MY_ACCESS_GRANTS, undefined, { signal }), `access-grants:${userId}`);
  return (
    <Panel title={t('accessTitle')}>
      {grants.resource.status === 'loading' ? (
        <Loading />
      ) : grants.resource.status === 'failed' ? (
        <AcademyRefusal failure={grants.resource.failure} retry={grants.reload} />
      ) : (
        <AccessGrantsView grants={grants.resource.data} />
      )}
    </Panel>
  );
}

export function AccessGrantsView({ grants }: { grants: readonly AcademyAccessGrant[] }) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  if (grants.length === 0) return <EmptyState title={t('accessNone')} />;
  return (
    <ul className="academy-public-cards" data-academy-access="true">
      {grants.map((row) => (
        <li key={row.slug} className="academy-lms-card" data-access-grant={row.slug}>
          <a className="academy-learning-link" href={academyCourseHref(row.slug)}>
            {pathLabel(t, row.slug)}
          </a>
          <Details
            items={[
              [t('accessSource'), t(SOURCE_KEYS[row.source])],
              [t('accessGranted'), <time dateTime={row.grantedAt}>{formatDay(row.grantedAt, language)}</time>],
              [
                t('accessExpires'),
                row.expiresAt ? <time dateTime={row.expiresAt}>{formatDay(row.expiresAt, language)}</time> : t('accessNoExpiry'),
              ],
            ]}
          />
        </li>
      ))}
    </ul>
  );
}
