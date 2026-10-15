import type { PlainKey } from './copy';

export type PortalRoom =
  'dashboard' | 'onboarding' | 'team' | 'disputes' | 'dispute' | 'customers' | 'customer' | 'exports' | 'notifications';
export type PortalRoute = { room: PortalRoom; param?: string };

/** The rooms W3a owns. Detail rooms carry their id in the path, so a link can be shared and survives a reload. */
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
  if (a === 'merchant' && b === undefined) return { room: 'dashboard' };
  if (a === 'onboarding' && b === undefined) return { room: 'onboarding' };
  if (a === 'team' && b === undefined) return { room: 'team' };
  if (a === 'exports' && b === undefined) return { room: 'exports' };
  if (a === 'notifications' && b === undefined) return { room: 'notifications' };
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
  ['/pay/onboarding', 'navOnboarding'],
  ['/pay/team', 'navTeam'],
  ['/pay/exports', 'navExports'],
  ['/pay/notifications', 'navNotifications'],
];
