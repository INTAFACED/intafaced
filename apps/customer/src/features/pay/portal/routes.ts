/** Every page the portal renders. The registry test checks each one has exactly one owner. */
export const PORTAL_ROOMS = [
  'conversion',
  'conversion-new',
  'conversion-order',
  'subscriptions',
  'subscription',
  'subscription-new',
  'compliance',
  'settings',
  'settings-notifications',
  'developer-keys',
  'developer-signing',
  'developer-webhooks',
  'developer-endpoint',
  'developer-deliveries',
  'invoices',
  'invoice',
  'money',
  'money-activity',
  'money-top-up',
  'reports',
  'report-exports',
  'links',
  'link-new',
  'link',
  'refunds',
  'refund-new',
  'refund',
  'dashboard',
  'onboarding',
  'team',
  'disputes',
  'dispute',
  'customers',
  'customer',
  'notifications',
  'payments',
  'payment',
  'settlements',
  'settlement',
  'payouts',
  'payout',
  'approvals',
  'pricing',
  'limits',
  'payout-new',
  'payout-destinations',
  'network',
  'network-child',
  'permissions',
  'checkout-settings',
  'developer-sandbox',
  'developer-docs',
  'analytics',
  'analytics-fees',
  'settings-security',
  'activity',
  'invoice-new',
  'products',
  'product-new',
  'product-import',
  'product',
  'settings-stores',
] as const;
export type PortalRoom = (typeof PORTAL_ROOMS)[number];
export type OnboardingStep = 'business' | 'verification' | 'go-live';
export type PortalRoute = { room: PortalRoom; param?: string; step?: OnboardingStep };

/**
 * Old addresses that now live somewhere else. The portal sends the browser there (replacing the history entry), so a
 * saved link or a bookmark keeps working and no page has two addresses. Anything after `?` is kept.
 */
export function portalRedirect(path: string): string | null {
  const [pathname = '', query = ''] = path.split('?');
  const clean = pathname.replace(/\/+$/, '');
  const suffix = query ? `?${query}` : '';
  if (clean === '/pay/settings/team') return `/pay/team${suffix}`;
  if (clean === '/pay/exports') return `/pay/reports/exports${suffix}`;
  if (clean === '/pay/developer') return `/pay/developer/keys${suffix}`;
  return null;
}

/** The older sandbox tools (create, capture, refund, run a settlement, request a payout) stay reachable at `?view=tools`, by address only. */
export function isLegacyTool(path: string): boolean {
  const [pathname = '', query = ''] = path.split('?');
  const a = pathname.split('/').filter(Boolean)[1];
  return (
    (a === 'payments' || a === 'settlements' || a === 'payouts' || a === 'links') && new URLSearchParams(query).get('view') === 'tools'
  );
}

/** The rooms W3a and W3b own. Detail rooms carry their id in the path, so a link can be shared and survives a reload. */
export function parsePortalRoute(path: string): PortalRoute | null {
  const [pathname = ''] = path.split('?');
  const clean = pathname.replace(/\/+$/, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments[0] !== 'pay') return null;
  if (isLegacyTool(path) || portalRedirect(path)) return null;
  const [, a, b, extra] = segments;
  if (extra !== undefined && !(a === 'developer' && b === 'webhooks' && segments.length === 4)) return null;
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  if (a === 'conversion')
    return b === undefined
      ? { room: 'conversion' }
      : b === 'new'
        ? { room: 'conversion-new' }
        : { room: 'conversion-order', param: decode(b) };
  if (a === 'subscriptions')
    return b === undefined
      ? { room: 'subscriptions' }
      : b === 'new'
        ? { room: 'subscription-new' }
        : { room: 'subscription', param: decode(b) };
  if (a === 'compliance' && b === undefined) return { room: 'compliance' };
  if (a === 'settings') {
    if (b === undefined || b === 'profile') return { room: 'settings' };
    if (b === 'notifications') return { room: 'settings-notifications' };
    if (b === 'security') return { room: 'settings-security' };
    if (b === 'stores') return { room: 'settings-stores' };
    return null;
  }
  if (a === 'developer') {
    if (b === 'webhooks') return extra ? { room: 'developer-endpoint', param: decode(extra) } : { room: 'developer-webhooks' };
    if (b === 'keys' || b === 'signing' || b === 'deliveries' || b === 'sandbox' || b === 'docs') return { room: `developer-${b}` };
    return null;
  }
  if (a === 'invoices')
    return b === undefined ? { room: 'invoices' } : b === 'new' ? { room: 'invoice-new' } : { room: 'invoice', param: decode(b) };
  if (a === 'money')
    return b === undefined
      ? { room: 'money' }
      : b === 'activity'
        ? { room: 'money-activity' }
        : b === 'top-up'
          ? { room: 'money-top-up' }
          : null;
  if (a === 'reports') return b === undefined ? { room: 'reports' } : b === 'exports' ? { room: 'report-exports' } : null;
  if (a === 'products')
    return b === undefined
      ? { room: 'products' }
      : b === 'new'
        ? { room: 'product-new' }
        : b === 'import'
          ? { room: 'product-import' }
          : { room: 'product', param: decode(b) };
  if (a === 'links') return b === undefined ? { room: 'links' } : b === 'new' ? { room: 'link-new' } : { room: 'link', param: decode(b) };
  if (a === 'refunds')
    return b === undefined ? { room: 'refunds' } : b === 'new' ? { room: 'refund-new' } : { room: 'refund', param: decode(b) };
  if (a === 'merchant' && b === undefined) return { room: 'dashboard' };
  if (a === 'onboarding') {
    if (b === undefined) return { room: 'onboarding' };
    if (b === 'business' || b === 'verification' || b === 'go-live') return { room: 'onboarding', step: b };
    return null;
  }
  if (a === 'team' && b === undefined) return { room: 'team' };
  if (a === 'notifications' && b === undefined) return { room: 'notifications' };
  if (a === 'approvals' && b === undefined) return { room: 'approvals' };
  if (a === 'pricing' && b === undefined) return { room: 'pricing' };
  if (a === 'limits' && b === undefined) return { room: 'limits' };
  if (a === 'analytics') return b === undefined ? { room: 'analytics' } : b === 'fees' ? { room: 'analytics-fees' } : null;
  if (a === 'activity' && b === undefined) return { room: 'activity' };
  if (a === 'network') return b === undefined ? { room: 'network' } : { room: 'network-child', param: decode(b) };
  if (a === 'permissions' && b === undefined) return { room: 'permissions' };
  // Without a token this is the merchant's checkout settings; with one the payer's hosted checkout answers first (PayRoutes).
  if (a === 'checkout' && b === undefined) return { room: 'checkout-settings' };
  if (a === 'payments') return b === undefined ? { room: 'payments' } : { room: 'payment', param: decode(b) };
  if (a === 'settlements') return b === undefined ? { room: 'settlements' } : { room: 'settlement', param: decode(b) };
  if (a === 'payouts')
    return b === undefined
      ? { room: 'payouts' }
      : b === 'new'
        ? { room: 'payout-new' }
        : b === 'destinations'
          ? { room: 'payout-destinations' }
          : { room: 'payout', param: decode(b) };
  if (a === 'customers') return b === undefined ? { room: 'customers' } : { room: 'customer', param: decode(b) };
  if (a === 'disputes') return b === undefined ? { room: 'disputes' } : { room: 'dispute', param: decode(b) };
  return null;
}
