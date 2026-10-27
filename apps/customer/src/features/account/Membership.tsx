import { useRef } from 'react';
import { z } from 'zod';
import type { ApiClient } from '../../shared/api';
import { useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { DepthPanel, Fact } from '../money/DepthParts';
import { membershipCopy as copy } from './membership-copy';

/**
 * Membership tier on Account (W-balances-04, J-wallet-01 #6): identity's `membership.offer`, read-only. Tiers, prices and
 * perks are owner values; while none is published identity answers `identity.membership_not_offered` and this says so,
 * with no tier, price or join control in its place. There is no purchase door yet, so a published tier is listed with
 * its price and perks and nothing to press.
 */

// hand-declared-ok: svc-identity's membership.offer output lives in the service (membership-router.ts), not in @intafaced/contracts.
const tier = z
  .object({
    id: z.string(),
    name: z.string(),
    price: z.string(),
    assetId: z.string(),
    periodDays: z.number().int(),
    perks: z.array(z.string()),
  })
  .strict();

export const membershipOfferSchema = z.union([
  z.object({ offered: z.literal(false), code: z.literal('identity.membership_not_offered') }).strict(),
  z.object({ offered: z.literal(true), tiers: z.array(tier), current: z.null() }).strict(),
]);
export type MembershipOffer = z.infer<typeof membershipOfferSchema>;

export function MembershipView({ offer }: { offer: MembershipOffer }) {
  const { t } = copy.useCopy();
  if (!offer.offered) {
    return (
      <div className="bd-address" role="status" data-testid="membership" data-state="not-offered">
        <strong>{t('notOffered')}</strong>
        <p>{t('notOfferedBody')}</p>
      </div>
    );
  }
  return (
    <div className="bd-stack" data-testid="membership" data-state="offered">
      <dl className="bd-facts">
        <Fact label={t('yours')}>{t('noTier')}</Fact>
      </dl>
      <ul className="bd-list">
        {offer.tiers.map((row) => (
          <li key={row.id} data-tier={row.id}>
            <strong lang="und">{row.name}</strong>
            <p lang="und">{t('price', { price: row.price, asset: row.assetId, days: row.periodDays })}</p>
            {row.perks.length === 0 ? (
              <p className="money-caption">{t('noPerks')}</p>
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
      <p className="money-caption">{t('notForSale')}</p>
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
  const client = useRef({ api, version: 0 });
  if (client.current.api !== api) client.current = { api, version: client.current.version + 1 };
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'membership.offer', undefined, membershipOfferSchema, { signal }),
    `account-membership:${userId}:${client.current.version}`,
  );
  return (
    <DepthPanel title={t('title')} lead={t('lead')} id="membership">
      <MembershipBody resource={resource} reload={reload} />
    </DepthPanel>
  );
}

export function Membership() {
  const { api, userId } = useSession();
  return userId ? <MembershipRead api={api} userId={userId} /> : null;
}
