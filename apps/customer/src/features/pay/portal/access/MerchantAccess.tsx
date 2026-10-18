import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { EmptyState } from '../../ui-kit';
import { useSession } from '../../../session/session';
import { useResource, type Resource } from '../../../../shared/resource';
import { createPortalApi } from '../api';
import { PortalFailure, PortalLoading } from '../components';
import { portalCopy } from '../copy';
import type { MemberRole, MerchantRecord } from '../schemas';
import type { Need } from './capabilities';
import { allows, canOwnerWrite as ownerMayWrite, resolveAccess, type Access, type Ready } from './resolve';
import type { MyAccess } from './schemas';
import { NoBusiness } from './NoBusiness';
import { publishAccess } from './shared-access';
import { moneyReasonFor, type MoneyKind, type PayoutAct } from './money-step';
import { scopesOfAccessToken } from './session-scopes';
import { StepUpHost } from './step-up';

type TeamMe = { merchantId: string; userId: string; role: MemberRole };

/**
 * What every portal page reads to know who is signed in to which business, and what they may do. The pages never
 * work this out themselves. See `resolve.ts` for the order of trust and `fallback.ts` for the review surface.
 */
export type MerchantAccessValue = {
  access: Access;
  /** `merchant.me`: the owner's own record. Null for a team member. */
  merchant: Resource<MerchantRecord | null>;
  team: Resource<TeamMe>;
  reloadMerchant: () => void;
  /** Ask again for everything the access depends on, for the retry button on a page that could not tell who is signed in. */
  reload: () => void;
  /** Does this person hold the permission (or, for `'owner'`, own the account)? */
  can: (need: Need) => boolean;
  /** Owner of an active account in a session that can change things. */
  canOwnerWrite: boolean;
  /** The scopes the signed-in session carries (read from its access token), or null when they cannot be read. */
  sessionScopes: ReadonlySet<string> | null;
  /** Why a refund or a payout cannot be started by this person, in words (who can), or null when they may begin: opening the action asks them to confirm it's them. One answer for every control. */
  moneyReason: (kind: MoneyKind, act?: PayoutAct) => string | null;
};

const Context = createContext<MerchantAccessValue | null>(null);
/** For tests and previews that draw a page with a fixed access value, without the reads the provider makes. */
export const MerchantAccessContext = Context;

export function MerchantAccessProvider({ children }: { children: ReactNode }) {
  const { api, userId, session } = useSession();
  const accessToken = session?.accessToken;
  const portal = useMemo(() => createPortalApi(api, userId), [api, userId]);
  const who = userId ?? 'anon';
  const myAccess = useResource<MyAccess>((s) => portal.myAccess(s), `portal:my-access:${who}`);
  const merchant = useResource((s) => portal.merchant(s), `portal:merchant:${who}`);
  const team = useResource((s) => portal.teamMe(s), `portal:team-me-shell:${who}`);
  const value = useMemo<MerchantAccessValue>(() => {
    const access = resolveAccess({ sessionUserId: userId, myAccess: myAccess.resource, merchant: merchant.resource, team: team.resource });
    const sessionScopes = scopesOfAccessToken(accessToken);
    return {
      access,
      merchant: merchant.resource,
      team: team.resource,
      reloadMerchant: merchant.reload,
      reload: () => {
        myAccess.reload();
        merchant.reload();
        team.reload();
      },
      can: (need) => allows(access, need),
      canOwnerWrite: ownerMayWrite(access),
      sessionScopes,
      moneyReason: (kind, act) => moneyReasonFor(kind, access, act),
    };
  }, [userId, accessToken, myAccess.resource, merchant.resource, team.resource, myAccess.reload, merchant.reload, team.reload]);
  useEffect(() => {
    publishAccess(value);
    return () => publishAccess(null);
  }, [value]);
  const merchantId = value.access.status === 'ready' ? value.access.merchantId : null;
  return (
    <Context.Provider value={value}>
      {children}
      {/* Asks "Confirm it's you" for a refund or a payout, and forgets the answer when the person or the business changes. */}
      <StepUpHost userId={userId} merchantId={merchantId} />
    </Context.Provider>
  );
}

export function useMerchantAccess(): MerchantAccessValue {
  const value = useContext(Context);
  if (!value) throw new Error('MerchantAccessProvider is required');
  return value;
}
/** For the frame, which also draws pages that sit outside the provider. Null there: nothing is granted. */
export function useOptionalMerchantAccess(): MerchantAccessValue | null {
  return useContext(Context);
}

/** The business the person is working in, when there is one. */
export function readyAccess(value: MerchantAccessValue | null): Ready | null {
  return value && value.access.status === 'ready' ? value.access : null;
}

/** Draws its children only for a person who holds the permission. Otherwise it says why, in words. No business shows the one calm setup state, never the page. */
export function Requires({ need, children }: { need: Need; children: ReactNode }) {
  const { t } = portalCopy.useCopy();
  const { access, can, reload } = useMerchantAccess();
  if (access.status === 'loading') return <PortalLoading rows={4} />;
  if (access.status === 'failed') return <PortalFailure result={access.failure} retry={reload} />;
  if (access.status === 'none') return <NoBusiness />;
  if (can(need)) return <>{children}</>;
  return <EmptyState title={t('noRoleTitle')}>{need === 'owner' ? t('ownerOnlyBody') : t('noRoleBody')}</EmptyState>;
}
