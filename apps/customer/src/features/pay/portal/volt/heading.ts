import { createContext, useContext, type ReactNode } from 'react';

/**
 * A portal page's title, purpose and one action, as the frame worked them out (the action already switched off, with its
 * reason, for a person whose role lacks the scope). A page on its Volt template draws these itself through the template's
 * title row, so the frame draws only the navigation (`ownTitle` on the page's room).
 */
export type PortalHeading = { title: string; purpose: string; action?: ReactNode };

export const PortalHeadingContext = createContext<PortalHeading | null>(null);

/** The heading the frame handed this page. A page drawn outside the frame (a unit test) gets an empty one. */
export function usePortalHeading(): PortalHeading {
  return useContext(PortalHeadingContext) ?? { title: '', purpose: '' };
}
