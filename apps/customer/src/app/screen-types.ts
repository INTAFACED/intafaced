/** Redesigned screens (UI-SPEC 3.2 and 7.2). Each id maps to one folder under `apps/customer/src/screens/`. */
export type ScreenId =
  | 'home'
  | 'money'
  | 'coin'
  | 'trade/markets'
  | 'trade/desk'
  | 'trade/buy'
  | 'trade/convert'
  | 'pay'
  | 'more'
  | 'notifications'
  | 'account'
  | 'account-tools/api-keys'
  | 'account-tools/sub-accounts'
  | 'account-tools/fees';

/** What the shell hands to a screen: the matched route's path, its query string and its `:param` values. */
export interface ScreenProps {
  path: string;
  /** Includes the leading `?`, or is empty. */
  search: string;
  params: Record<string, string>;
}
