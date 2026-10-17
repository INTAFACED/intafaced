import { createContext, useContext, type ReactNode } from 'react';
import { z } from 'zod';
import { P2P } from './P2P';
import { BusinessPay, BusinessHomeSection } from './BusinessPay';
import { MerchantPortal } from './portal/MerchantPortal';
import { parsePortalRoute } from './portal/routes';
import { Checkout } from './Checkout';
import type { PayBusinessAuthority } from './pay-api';
import { payCopy } from './copy';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import './pay.css';

const starterFeeRead = z.object({
  starterFee: z.object({ bps: z.number().int().min(0).max(10_000), source: z.literal('local_test') }).nullable(),
});

const BusinessContext = createContext<PayBusinessAuthority | null>(null);
/** A future authoritative company membership source may supply this context.
 * Do not construct it from identity.me.modes, a strategy subaccount or merchant.me alone.
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
  if (current === '/pay' && authority) return <BusinessPay path="/pay/merchant" authority={authority} />;
  if (parsePortalRoute(path)) return <PortalEntry key={path} path={path} authority={authority} />;
  return <BusinessPay key={path} path={path} authority={authority} />;
}

function PortalEntry({ path, authority }: { path: string; authority: PayBusinessAuthority | null }) {
  const { api, userId } = useSession();
  const fee = useResource(
    (signal) => api.query('pay', 'merchant.starterFee', undefined, starterFeeRead, { signal }),
    `pay:starter-fee:${userId ?? 'anon'}`,
  );
  const starterFeeBps = fee.resource.status === 'ready' ? (fee.resource.data.starterFee?.bps ?? null) : null;
  return (
    <MerchantPortal
      path={path}
      authority={authority}
      starterFeeBps={starterFeeBps}
      legacyHome={authority ? <BusinessHomeSection authority={authority} /> : null}
    />
  );
}
export type { PayBusinessAuthority } from './pay-api';
