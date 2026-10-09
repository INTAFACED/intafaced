import { createContext, useContext, type ReactNode } from 'react';
import { PersonalPay } from './PersonalPay';
import { P2P } from './P2P';
import { BusinessPay } from './BusinessPay';
import { Checkout } from './Checkout';
import type { PayBusinessAuthority } from './pay-api';
import { payCopy } from './copy';
import './pay.css';

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
  if (['/pay', '/pay/send', '/pay/receive', '/pay/request', '/pay/bills', '/pay/global'].includes(current))
    return <PersonalPay key={path} path={path} />;
  return <BusinessPay key={path} path={path} authority={authority} />;
}
export type { PayBusinessAuthority } from './pay-api';
