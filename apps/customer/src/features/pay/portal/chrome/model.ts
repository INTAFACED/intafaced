import { groups } from '../home-layout/Navigation';

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
