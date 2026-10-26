import type { layoutCopy as c } from './copy';

type Key = Exclude<Parameters<typeof c.t>[0], 'paymentReference'>;
/**
 * `match` is the address prefix that keeps the item lit (defaults to its own address). `when` hides it unless the
 * business is of that kind: Network and Permissions are for platforms only.
 */
export type NavOptions = { match?: string; when?: 'payfac' };
export type NavItem = [href: string, label: Key, options?: NavOptions];
export type NavGroup = { label: Key; items: NavItem[] };

/** Five tabs, at most seven items under each. Developers live under Settings. */
export const groups: NavGroup[] = [
  {
    label: 'overview',
    items: [
      ['/pay/merchant', 'summary'],
      ['/pay/analytics', 'analytics'],
      ['/pay/analytics/fees', 'fees'],
      ['/pay/reports', 'reports'],
      ['/pay/activity', 'activity'],
    ],
  },
  {
    label: 'payments',
    items: [
      ['/pay/payments', 'paymentList'],
      ['/pay/refunds', 'refunds'],
      ['/pay/disputes', 'disputes'],
      ['/pay/links', 'links'],
      ['/pay/products', 'products'],
      ['/pay/checkout', 'checkout'],
    ],
  },
  {
    label: 'moneyOut',
    items: [
      ['/pay/money', 'money'],
      ['/pay/payouts', 'payouts'],
      ['/pay/settlements', 'settlements'],
      ['/pay/approvals', 'approvals'],
      ['/pay/payouts/destinations', 'destinations'],
      ['/pay/conversion', 'conversion'],
      ['/pay/limits', 'limits'],
    ],
  },
  {
    label: 'billing',
    items: [
      ['/pay/customers', 'customers'],
      ['/pay/invoices', 'invoices'],
      ['/pay/subscriptions', 'subscriptions'],
      ['/pay/network', 'network', { when: 'payfac' }],
      ['/pay/permissions', 'permissions', { when: 'payfac' }],
    ],
  },
  {
    label: 'settings',
    items: [
      ['/pay/settings', 'business'],
      ['/pay/team', 'team'],
      ['/pay/settings/security', 'security'],
      ['/pay/developer/keys', 'developers', { match: '/pay/developer' }],
      ['/pay/settings/notifications', 'notifications'],
      ['/pay/compliance', 'compliance'],
      ['/pay/pricing', 'pricing'],
    ],
  },
];
