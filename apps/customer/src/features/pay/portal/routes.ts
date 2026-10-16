import type { PlainKey } from './copy';

export type PortalRoom =
  | 'invoices'
  | 'invoice'
  | 'money'
  | 'money-activity'
  | 'reports'
  | 'report-exports'
  | 'links'
  | 'link-new'
  | 'link'
  | 'refunds'
  | 'refund-new'
  | 'refund'
  | 'dashboard'
  | 'onboarding'
  | 'team'
  | 'disputes'
  | 'dispute'
  | 'customers'
  | 'customer'
  | 'exports'
  | 'notifications'
  | 'payments'
  | 'payment'
  | 'settlements'
  | 'settlement'
  | 'payouts'
  | 'payout'
  | 'approvals'
  | 'pricing'
  | 'limits';
export type OnboardingStep = 'business' | 'verification' | 'go-live';
export type PortalRoute = { room: PortalRoom; param?: string; step?: OnboardingStep };

/** The rooms W3a and W3b own. Detail rooms carry their id in the path, so a link can be shared and survives a reload. */
export function parsePortalRoute(path: string): PortalRoute | null {
  const [pathname = '', query = ''] = path.split('?');
  const clean = pathname.replace(/\/+$/, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments[0] !== 'pay') return null;
  const [, a, b, extra] = segments;
  if (extra !== undefined) return null;
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  if (a === 'invoices') return b === undefined ? { room: 'invoices' } : { room: 'invoice', param: decode(b) };
  if (a === 'money') return b === undefined ? { room: 'money' } : b === 'activity' ? { room: 'money-activity' } : null;
  if (a === 'reports') return b === undefined ? { room: 'reports' } : b === 'exports' ? { room: 'report-exports' } : null;
  if (a === 'links') {
    if (new URLSearchParams(query).get('view') === 'tools') return null;
    return b === undefined ? { room: 'links' } : b === 'new' ? { room: 'link-new' } : { room: 'link', param: decode(b) };
  }
  if (a === 'refunds')
    return b === undefined ? { room: 'refunds' } : b === 'new' ? { room: 'refund-new' } : { room: 'refund', param: decode(b) };
  if (a === 'merchant' && b === undefined) return { room: 'dashboard' };
  if (a === 'onboarding') {
    if (b === undefined) return { room: 'onboarding' };
    if (b === 'business' || b === 'verification' || b === 'go-live') return { room: 'onboarding', step: b };
    return null;
  }
  if (a === 'team' && b === undefined) return { room: 'team' };
  if (a === 'exports' && b === undefined) return { room: 'exports' };
  if (a === 'notifications' && b === undefined) return { room: 'notifications' };
  if (a === 'approvals' && b === undefined) return { room: 'approvals' };
  if (a === 'pricing' && b === undefined) return { room: 'pricing' };
  if (a === 'limits' && b === undefined) return { room: 'limits' };
  // The older sandbox tools (create, capture, refund, run a settlement, request a payout) stay reachable at ?view=tools.
  if ((a === 'payments' || a === 'settlements' || a === 'payouts') && new URLSearchParams(query).get('view') === 'tools') return null;
  if (a === 'payments') return b === undefined ? { room: 'payments' } : { room: 'payment', param: decode(b) };
  if (a === 'settlements') return b === undefined ? { room: 'settlements' } : { room: 'settlement', param: decode(b) };
  // /pay/payouts/new and /pay/payouts/destinations belong to other pages.
  if (a === 'payouts' && b !== 'new' && b !== 'destinations')
    return b === undefined ? { room: 'payouts' } : { room: 'payout', param: decode(b) };
  if (a === 'customers') return b === undefined ? { room: 'customers' } : { room: 'customer', param: decode(b) };
  if (a === 'disputes') {
    // The older "disputed payments" list stays reachable at ?view=payments until the dispute service is live.
    if (new URLSearchParams(query).get('view') === 'payments') return null;
    return b === undefined ? { room: 'disputes' } : { room: 'dispute', param: decode(b) };
  }
  return null;
}

/** Links added to the Business Pay menu, in the order they are shown. */
export const portalLinks: ReadonlyArray<readonly [string, PlainKey]> = [
  ['/pay/refunds', 'navRefunds'],
  ['/pay/onboarding', 'navOnboarding'],
  ['/pay/team', 'navTeam'],
  ['/pay/exports', 'navExports'],
  ['/pay/notifications', 'navNotifications'],
  ['/pay/approvals', 'navApprovals'],
  ['/pay/pricing', 'navPricing'],
  ['/pay/limits', 'navLimits'],
];
