/**
 * Where the Get started steps and the Learn strip lead. Kept in one place so a route that goes live (or is renamed)
 * is a one-line change here and nowhere else.
 *
 * Deposit and Academy are not live yet, so they point at their Preview screens (the `/preview/*` routes come with the
 * M4 Preview registry). A Preview link always carries a "Preview" chip on screen.
 */
export const HOME_LINKS = {
  verification: '/verification',
  security: '/uc/safe',
  deposit: '/preview/deposit',
  firstTrade: '/trade/buy',
  academy: '/preview/academy',
  activity: '/money/activity',
  /**
   * Price alerts can only be created in the old trade view today, which a customer cannot reach from the new screens.
   * Until an alert entry point is live (M5 puts alerts on the chart) the step is shown as "Coming soon" without a
   * link. Set this to the live route to turn the step into a link.
   */
  priceAlert: null as string | null,
} as const;

/** Links in HOME_LINKS that lead to a Preview screen: they carry the Preview chip. */
export const isPreviewLink = (href: string | null): boolean => href !== null && href.startsWith('/preview/');
