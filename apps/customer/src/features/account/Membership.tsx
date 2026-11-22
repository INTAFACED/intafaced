import { useId, useRef } from 'react';
import type { z } from 'zod';
import { membershipOfferSchema } from '@intafaced/contracts/identity-account-room';
import type { ApiClient } from '../../shared/api';
import { useSession } from '../session';
import { useResource, type Resource } from '../../shared/resource';
import { Failure, Loading } from './kit-parts';
import { membershipCopy as copy } from './membership-copy';

/**
 * Membership tier on Account (W-balances-04, J-wallet-01 #6): identity's `membership.offer`, read-only. Tiers, prices and
 * perks are owner values; while none is published identity answers `identity.membership_not_offered` and this says so,
 * with no tier, price or join control in its place. There is no purchase door yet, so a published tier is listed with
 * its price and perks and nothing to press.
 */

export { membershipOfferSchema };
export type MembershipOffer = z.infer<typeof membershipOfferSchema>;

export function MembershipView({ offer }: { offer: MembershipOffer }) {
  const { t } = copy.useCopy();
  if (!offer.offered) {
    return (
      <div role="status" data-testid="membership" data-state="not-offered">
        <strong>{t('notOffered')}</strong>
        <p>{t('notOfferedBody')}</p>
      </div>
    );
  }
  return (
    <div data-testid="membership" data-state="offered">
      <dl>
        <div>
          <dt>{t('yours')}</dt>
          <dd>{t('noTier')}</dd>
        </div>
      </dl>
      <ul>
        {offer.tiers.map((row) => (
          <li key={row.id} data-tier={row.id}>
            <strong lang="und">{row.name}</strong>
            <p lang="und">{t('price', { price: row.price, asset: row.assetId, days: row.periodDays })}</p>
            {row.perks.length === 0 ? (
              <p className="lt-hint">{t('noPerks')}</p>
            ) : (
              <ul aria-label={t('perks')}>
                {row.perks.map((perk, index) => (
                  <li key={`${index}:${perk}`} lang="und">
                    {perk}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="lt-hint">{t('notForSale')}</p>
    </div>
  );
}

export function MembershipBody({ resource, reload }: { resource: Resource<MembershipOffer>; reload: () => void }) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <MembershipView offer={resource.data} />;
}

/** Asks identity only once someone is signed in, and again whenever the session's client changes. */
function MembershipRead({ api, userId }: { api: ApiClient; userId: string }) {
  const { t } = copy.useCopy();
  const heading = useId();
  const client = useRef({ api, version: 0 });
  if (client.current.api !== api) client.current = { api, version: client.current.version + 1 };
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'membership.offer', undefined, membershipOfferSchema, { signal }),
    `account-membership:${userId}:${client.current.version}`,
  );
  return (
    <section aria-labelledby={heading} id="membership">
      <h3 id={heading}>{t('title')}</h3>
      <p className="lt-hint">{t('lead')}</p>
      <MembershipBody resource={resource} reload={reload} />
    </section>
  );
}

export function Membership() {
  const { api, userId } = useSession();
  return userId ? <MembershipRead api={api} userId={userId} /> : null;
}
