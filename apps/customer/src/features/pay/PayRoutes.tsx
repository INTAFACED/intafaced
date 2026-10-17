import { createContext, useContext, type ReactNode } from 'react';
import { P2P } from './P2P';
import { BusinessPay } from './BusinessPay';
import { MerchantPortal, PortalFrame } from './portal/MerchantPortal';
import { NoBusiness } from './portal/access/NoBusiness';
import { isLegacyTool, parsePortalRoute, portalRedirect } from './portal/routes';
import { Checkout } from './Checkout';
import type { PayBusinessAuthority } from './pay-api';
import { payCopy } from './copy';
import { PortalNotFound, Redirect } from './portal/chrome/PortalNotFound';
import { MerchantAccessProvider, useMerchantAccess } from './portal/access/MerchantAccess';
import { authorityFromAccess } from './portal/access/authority';
import { useSession } from '../session/session';
import './pay.css';

const BusinessContext = createContext<PayBusinessAuthority | null>(null);
/** A future authoritative company membership source may supply this context.
 * Do not construct it from identity.me.modes, a strategy subaccount or merchant.me alone.
 * The merchant portal makes its own from the resolved business access (`portal/access/`); this wins when supplied.
 */
export function PayBusinessProvider({ authority, children }: { authority: PayBusinessAuthority | null; children: ReactNode }) {
  return <BusinessContext.Provider value={authority}>{children}</BusinessContext.Provider>;
}
export function PayRoutes({ path }: { path: string }) {
  const { languageFor } = payCopy.useCopy();
  return (
    <div lang={languageFor('pay')} style={{ display: 'contents' }}>
      <PayRooms path={path} />
    </div>
  );
}
function PayRooms({ path }: { path: string }) {
  const authority = useContext(BusinessContext);
  const current = path.split('?')[0] ?? '/pay';
  const query = new URLSearchParams(
    path.includes('?') ? path.slice(path.indexOf('?')) : typeof location === 'undefined' ? '' : location.search,
  );
  if (current === '/pay/checkout' && (query.has('token') || query.has('session')))
    return <Checkout key={path + query.toString()} path={path} />;
  if (
    current.startsWith('/p2p') ||
    current === '/ctc' ||
    current === '/chat' ||
    current === '/checkuser' ||
    current === '/uc/order' ||
    current.startsWith('/uc/ad')
  )
    return <P2P key={path} path={path} />;
  const redirect = portalRedirect(path);
  if (redirect) return <Redirect to={redirect} />;
  if (parsePortalRoute(path))
    return <MerchantPortal key={path} path={path} authority={authority} />;
  // The older sandbox tools stay reachable by address only (`?view=tools`).
  if (isLegacyTool(path))
    return (
      <MerchantAccessProvider>
        <LegacyTools key={path} path={path} authority={authority} />
      </MerchantAccessProvider>
    );
  return <PortalNotFound />;
}
export type { PayBusinessAuthority } from './pay-api';

function LegacyTools({ path, authority }: { path: string; authority: PayBusinessAuthority | null }) {
  const { userId } = useSession();
  const { access } = useMerchantAccess();
  // The older sandbox tools need a business too: no account means the one calm state, like every other business page.
  if (access.status === 'none' && !authority)
    return (
      <PortalFrame route={{ room: 'dashboard' }}>
        <NoBusiness />
      </PortalFrame>
    );
  return <BusinessPay path={path} authority={authority ?? authorityFromAccess(access, userId)} />;
}
