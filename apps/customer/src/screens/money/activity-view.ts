import type { ActivityItem, ActivityKind } from './deps';

/** The four tabs of Activity (UI-SPEC 5.4, brief B9). The server has no kind filter, so a tab filters the rows loaded. */
export const TABS = ['all', 'deposits', 'transfers', 'trades'] as const;
export type Tab = (typeof TABS)[number];

const KINDS: Readonly<Record<Exclude<Tab, 'all'>, ReadonlySet<ActivityKind>>> = {
  deposits: new Set<ActivityKind>(['deposit', 'welcome_funds']),
  transfers: new Set<ActivityKind>(['transfer_in', 'transfer_out', 'space_move']),
  trades: new Set<ActivityKind>(['trade']),
};

/** `?tab=deposits`. Anything else (including the old `?tab=orders` links) reads as All. */
export function tabFromSearch(search: string): Tab {
  const value = new URLSearchParams(search).get('tab');
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'all';
}

export function tabHref(tab: Tab): string {
  return tab === 'all' ? '/money/activity' : `/money/activity?tab=${tab}`;
}

export function inTab(item: ActivityItem, tab: Tab): boolean {
  return tab === 'all' || KINDS[tab].has(item.kind);
}

/** The sentence-case title of a row, in plain money words. `t` is the screen's copy function. */
export function titleOf(
  item: ActivityItem,
  t: (
    key:
      | 'Deposit'
      | 'Welcome test funds'
      | 'Received'
      | 'Sent'
      | 'Trade'
      | 'Fee'
      | 'Payment received'
      | 'Payment sent'
      | 'Withdrawal'
      | 'Moved between your accounts'
      | 'Other activity',
  ) => string,
  withHandle: (key: 'Received from {handle}' | 'Sent to {handle}', handle: string) => string,
): string {
  const handle = item.counterparty?.handle ?? null;
  switch (item.kind) {
    case 'deposit':
      return t('Deposit');
    case 'welcome_funds':
      return t('Welcome test funds');
    case 'transfer_in':
      return handle ? withHandle('Received from {handle}', handle) : t('Received');
    case 'transfer_out':
      return handle ? withHandle('Sent to {handle}', handle) : t('Sent');
    case 'trade':
      return t('Trade');
    case 'fee':
      return t('Fee');
    case 'payment':
      return item.direction === 'in' ? t('Payment received') : t('Payment sent');
    case 'withdrawal':
      return t('Withdrawal');
    case 'space_move':
      return t('Moved between your accounts');
    case 'other':
      return t('Other activity');
  }
}
