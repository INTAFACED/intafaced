import { groups } from '../home-layout/Navigation';

/** The two portal frames Nitro is choosing between. Development builds only; a customer build always renders "tabs". */
export type PortalFrameOption = 'tabs' | 'side';

const KEY = 'pfo-frame';
const isOption = (value: string | null | undefined): value is PortalFrameOption => value === 'tabs' || value === 'side';

/** `?frame=tabs|side` picks a frame and is remembered for the tab, so links and redirects keep it without carrying the query. */
export function frameOption(search: string, dev: boolean = import.meta.env.DEV): PortalFrameOption {
  if (!dev) return 'tabs';
  const asked = new URLSearchParams(search).get('frame');
  try {
    if (isOption(asked)) {
      sessionStorage.setItem(KEY, asked);
      return asked;
    }
    const kept = sessionStorage.getItem(KEY);
    if (isOption(kept)) return kept;
  } catch {
    // Storage can be blocked; the frame then follows the query only.
  }
  return isOption(asked) ? asked : 'tabs';
}

/** The merchant portal pages (everything in the portal menu except the customer-facing checkout). */
export function isMerchantArea(path: string): boolean {
  return path !== '/pay/checkout' && groups.some((group) => group.items.some(([href]) => path === href || path.startsWith(`${href}/`)));
}

/** The one menu item that matches this page: the longest href that the path equals or sits under. */
export function currentHref(path: string): string | undefined {
  let best: string | undefined;
  for (const group of groups)
    for (const [href] of group.items)
      if ((path === href || path.startsWith(`${href}/`)) && (best === undefined || href.length > best.length)) best = href;
  return best;
}
