/**
 * Notification centre owner values — page size, unread display cap, retention.
 *
 * Every value is the owner's. A blank value is reported as unset with its typed
 * code; none of them defaults to a number here. Retention blank keeps every row.
 */

export const NOTIFY_UNREAD_CAP_UNSET = 'notify.unread_cap_unset' as const;

export type InboxSettings = {
  /** `notify.list` page size the app should ask for. Null = unpublished. */
  readonly pageSize: number | null;
  /** Largest unread count the bell shows before it prints "<cap>+". Null = unpublished. */
  readonly unreadCap: number | null;
  /** Days a row is kept. Null = every row is kept. */
  readonly retentionDays: number | null;
};

export const BLANK_INBOX_SETTINGS: InboxSettings = { pageSize: null, unreadCap: null, retentionDays: null };

/** Unread display cap unpublished. Blank is not 99. */
export class NotifyUnreadCapUnsetError extends Error {
  readonly code = NOTIFY_UNREAD_CAP_UNSET;
  constructor() {
    super(NOTIFY_UNREAD_CAP_UNSET);
    this.name = 'NotifyUnreadCapUnsetError';
  }
}

/** Owner-published unread cap. Blank / non-finite / <1 refuses. Never invent 99. */
export function assertNotifyUnreadCap(cap: number | null | undefined): number {
  if (cap === undefined || cap === null || typeof cap !== 'number' || !Number.isFinite(cap) || Math.floor(cap) < 1) {
    throw new NotifyUnreadCapUnsetError();
  }
  return Math.floor(cap);
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) >= 1 ? Math.floor(value) : null;
}

/** Public read for the bell and the inbox. Reports what is set and what refuses; invents nothing. */
export function describeInboxPolicy(settings: InboxSettings = BLANK_INBOX_SETTINGS) {
  const pageSize = positive(settings.pageSize);
  const unreadCap = positive(settings.unreadCap);
  const retentionDays = positive(settings.retentionDays);
  return {
    pageSize,
    pageSizeUnsetCode: pageSize === null ? ('notify.list_limit_unset' as const) : null,
    unreadCap,
    unreadCapUnsetCode: unreadCap === null ? NOTIFY_UNREAD_CAP_UNSET : null,
    retentionDays,
    retention: retentionDays === null ? ('keeps_every_row' as const) : ('days' as const),
    inventsLimits: false as const,
  };
}

export type InboxPolicySummary = ReturnType<typeof describeInboxPolicy>;
