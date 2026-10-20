import { matchPath } from '../../app/path-match';

/** What a personal Pay address shows. `device`: read from what this device remembers. `refusal`: a typed refusal naming the missing source. `paste`: the scan room's paste box. */
export type PersonalRouteKind = 'contacts' | 'request' | 'transfer' | 'scan' | 'refusal';
export type PersonalTitle =
  | 'request'
  | 'scheduled'
  | 'contacts'
  | 'transfer'
  | 'claim'
  | 'cases'
  | 'case'
  | 'limits'
  | 'fees'
  | 'preferences'
  | 'scan'
  | 'link'
  | 'invoice'
  | 'group'
  | 'pool';
export interface PersonalRoute {
  pattern: string;
  kind: PersonalRouteKind;
  title: PersonalTitle;
  /** Whether the last segment is a record id the address names. */
  detail: boolean;
  /** The personal room the page belongs to. */
  parent: '/pay' | '/pay/request' | '/pay/send' | '/pay/bills';
}

/**
 * The one list of personal Pay addresses beyond the five tabs (PP-order-02). Every one is listed in the navigation
 * table before the business catch-alls `/pay/:page` and `/pay/:page/:child`, so none of them can be taken for a business page.
 * Literal sections come before the parameter route that shares their prefix.
 */
export const PERSONAL_ROUTES: readonly PersonalRoute[] = [
  { pattern: '/pay/request/:requestId', kind: 'request', title: 'request', detail: true, parent: '/pay/request' },
  { pattern: '/pay/scheduled', kind: 'refusal', title: 'scheduled', detail: false, parent: '/pay/send' },
  { pattern: '/pay/contacts', kind: 'contacts', title: 'contacts', detail: false, parent: '/pay/send' },
  { pattern: '/pay/contacts/groups/:groupId', kind: 'refusal', title: 'group', detail: true, parent: '/pay/send' },
  { pattern: '/pay/contacts/pools/:poolId', kind: 'refusal', title: 'pool', detail: true, parent: '/pay/send' },
  { pattern: '/pay/history/:transferId', kind: 'transfer', title: 'transfer', detail: true, parent: '/pay' },
  { pattern: '/pay/claim/:token', kind: 'refusal', title: 'claim', detail: true, parent: '/pay' },
  { pattern: '/pay/cases', kind: 'refusal', title: 'cases', detail: false, parent: '/pay' },
  { pattern: '/pay/cases/:caseId', kind: 'refusal', title: 'case', detail: true, parent: '/pay' },
  { pattern: '/pay/send/limits', kind: 'refusal', title: 'limits', detail: false, parent: '/pay/send' },
  { pattern: '/pay/fees', kind: 'refusal', title: 'fees', detail: false, parent: '/pay' },
  { pattern: '/pay/preferences', kind: 'refusal', title: 'preferences', detail: false, parent: '/pay' },
  { pattern: '/pay/scan', kind: 'scan', title: 'scan', detail: false, parent: '/pay/send' },
  { pattern: '/pay/l/:linkId', kind: 'refusal', title: 'link', detail: true, parent: '/pay/request' },
  { pattern: '/pay/bills/invoices/:invoiceId', kind: 'refusal', title: 'invoice', detail: true, parent: '/pay/bills' },
];

/** What an id in a path may look like. Checked after one URL-decode, before any request, and never taken as authority. */
const idShape = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type PersonalMatch = { route: PersonalRoute; id?: string; invalid?: true };

/** The personal page `path` (no query) opens, or undefined when it is not one. A detail address with a malformed id still matches, flagged `invalid`. */
export function matchPersonalRoute(path: string): PersonalMatch | undefined {
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  for (const route of PERSONAL_ROUTES) {
    const params = matchPath(route.pattern, clean);
    if (!params) continue;
    if (!route.detail) return { route };
    const raw = Object.values(params)[0] ?? '';
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return { route, invalid: true };
    }
    return idShape.test(id) ? { route, id } : { route, invalid: true };
  }
  return undefined;
}
