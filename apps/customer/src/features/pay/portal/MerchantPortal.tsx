import { useMemo, type ReactNode } from 'react';
import { useSession } from '../../session/session';
import { createPortalApi } from './api';
import { portalCopy } from './copy';
import { parsePortalRoute, type PortalRoute } from './routes';
import './portal.css';
import { ExactMoneyContext } from './presentation';
import { LayoutFrame } from './home-layout/Frame';
import { rooms } from './rooms';
import type { PayBusinessAuthority } from '../pay-api';
import { MerchantAccessProvider, useMerchantAccess } from './access/MerchantAccess';
import { authorityFromAccess } from './access/authority';

/**
 * The merchant portal shell (W3a). Every page here is scoped by the server from the signed session, so the
 * browser never names a merchant. `starterFeeBps` is the fee INTAFACED has published for new accounts: null
 * until one is, and a null fee means an account cannot be opened from onboarding.
 * `legacyHome` is the older rails and checkout-domain section, shown under the dashboard when it applies.
 * `MerchantAccessProvider` sits at the root: every page and the frame read who is signed in from it.
 */
export function MerchantPortal(props: {
  path: string;
  authority?: PayBusinessAuthority | null;
  starterFeeBps?: number | null;
  legacyHome?: ReactNode | ((authority: PayBusinessAuthority | null) => ReactNode);
}) {
  return (
    <MerchantAccessProvider>
      <PortalRooms {...props} />
    </MerchantAccessProvider>
  );
}

function PortalRooms({
  path,
  authority = null,
  starterFeeBps = null,
  legacyHome = null,
}: {
  path: string;
  authority?: PayBusinessAuthority | null;
  starterFeeBps?: number | null;
  legacyHome?: ReactNode | ((authority: PayBusinessAuthority | null) => ReactNode);
}) {
  const { api, userId } = useSession();
  const portal = useMemo(() => createPortalApi(api, userId), [api, userId]);
  const access = useMerchantAccess();
  const route = parsePortalRoute(path);
  if (!route) return null;
  // A page that needs a `PayBusinessAuthority` gets one made from the resolved access, for the owner only.
  const effective = authority ?? authorityFromAccess(access.access, userId);
  return (
    <PortalFrame route={route}>
      {rooms[route.room].render(route, {
        portal,
        authority: effective,
        access,
        starterFeeBps,
        legacyHome: typeof legacyHome === 'function' ? legacyHome(effective) : legacyHome,
      })}
    </PortalFrame>
  );
}

export function PortalFrame({ route, children }: { route: PortalRoute; children: ReactNode }) {
  // Subscribes the header to the language preference; the room headers read the same catalogs.
  portalCopy.useCopy();
  const room = rooms[route.room];
  const copy = room.header(route);
  const here = typeof room.here === 'function' ? room.here(route) : (room.here ?? `/pay/${route.room}`);
  return (
    <LayoutFrame here={here} title={copy.title} purpose={copy.purpose} action={copy.action}>
      <ExactMoneyContext.Provider
        value={Boolean(route.param || route.step) || route.room.endsWith('-new') || route.room === 'money-activity'}
      >
        {children}
      </ExactMoneyContext.Provider>
    </LayoutFrame>
  );
}
