/**
 * Where the Get started steps and the Learn strip lead. Kept in one place so a renamed route is a one-line change
 * here and nowhere else. Every entry is a live route on this build.
 */
export const HOME_LINKS = {
  account: '/uc/account',
  verification: '/verification',
  security: '/uc/safe',
  deposit: '/uc/recharge',
  firstTrade: '/trade/buy',
  academy: '/academy',
  activity: '/money/activity',
  priceAlert: '/notifications?view=alerts',
  inbox: '/notifications',
} as const;
