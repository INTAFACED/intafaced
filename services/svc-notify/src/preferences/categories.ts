/**
 * Account notification choices by category and channel. A missing row means
 * on. `security` is locked on for every channel and the inbox is locked on for
 * every category, so neither can be switched off through this API. A replay of
 * a client request returns the first result.
 */

import type { ChannelStatus } from '../channels/registry.js';
import type { CommandLog } from './account.js';
import type { MuteableChannel } from './mute.js';

export const NOTIFY_CATEGORIES = ['security', 'orders', 'price_alerts', 'promotions', 'news', 'status'] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

/** Categories a person can switch off. `security` is not one of them. */
export type SwitchableCategory = Exclude<NotifyCategory, 'security'>;

export const CATEGORY_CHANNELS = ['email', 'push', 'sms', 'in_app'] as const;
export type CategoryChannel = (typeof CATEGORY_CHANNELS)[number];

export type NotConnectedCode = 'vendor.email' | 'vendor.push' | 'vendor.sms';

const NOT_CONNECTED: Record<MuteableChannel, NotConnectedCode> = {
  email: 'vendor.email',
  push: 'vendor.push',
  sms: 'vendor.sms',
};

export type CategoryPrefCode = 'notify.category_unknown' | 'notify.category_channel_unknown';

export class CategoryPrefError extends Error {
  constructor(readonly code: CategoryPrefCode) {
    super(code);
    this.name = 'CategoryPrefError';
  }
}

export type CategoryPrefRow = {
  readonly category: NotifyCategory;
  readonly channel: CategoryChannel;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly configured: boolean;
  /** The allowlisted code for a channel with no delivery vendor. Null when the channel can send. */
  readonly notConnected: NotConnectedCode | null;
};

export type CategoryPrefResult = {
  readonly rows: readonly CategoryPrefRow[];
  /** True when the write named a locked cell. Nothing was stored. */
  readonly locked: boolean;
};

export function isNotifyCategory(value: string): value is NotifyCategory {
  return (NOTIFY_CATEGORIES as readonly string[]).includes(value);
}

function isCategoryChannel(value: string): value is CategoryChannel {
  return (CATEGORY_CHANNELS as readonly string[]).includes(value);
}

/**
 * The category a notification kind belongs to. A kind outside this list has no
 * category choice, so it follows the topic choice and the channel rules alone.
 */
export function categoryFromKind(kind: string): NotifyCategory | null {
  const prefix = kind.split('.')[0] ?? '';
  switch (prefix) {
    case 'identity':
    case 'notify':
      return 'security';
    case 'trade':
    case 'p2p':
    case 'pay':
    case 'bank':
    case 'token':
    case 'agents':
      return 'orders';
    case 'alert':
      return 'price_alerts';
    case 'promo':
      return 'promotions';
    case 'news':
      return 'news';
    case 'status':
      return 'status';
    default:
      return null;
  }
}

export function categoryCellLocked(category: NotifyCategory, channel: CategoryChannel): boolean {
  return category === 'security' || channel === 'in_app';
}

export interface CategoryPrefStore {
  get(userId: string, category: SwitchableCategory, channel: MuteableChannel): Promise<boolean>;
  list(userId: string): Promise<ReadonlyArray<{ category: SwitchableCategory; channel: MuteableChannel; enabled: boolean }>>;
  /** Last write wins. A write that changes nothing adds no history. */
  set(userId: string, category: SwitchableCategory, channel: MuteableChannel, enabled: boolean): Promise<{ changed: boolean }>;
}

export type CategoryHistoryRow = {
  readonly category: SwitchableCategory;
  readonly channel: MuteableChannel;
  readonly enabled: boolean;
};

export class MemoryCategoryPrefStore implements CategoryPrefStore {
  private readonly rows = new Map<string, boolean>();
  readonly history: Array<CategoryHistoryRow & { readonly userId: string }> = [];

  async get(userId: string, category: SwitchableCategory, channel: MuteableChannel): Promise<boolean> {
    return this.rows.get(`${userId}\0${category}\0${channel}`) !== false;
  }

  async list(userId: string): Promise<ReadonlyArray<{ category: SwitchableCategory; channel: MuteableChannel; enabled: boolean }>> {
    const out: { category: SwitchableCategory; channel: MuteableChannel; enabled: boolean }[] = [];
    for (const [key, enabled] of this.rows) {
      const [owner, category, channel] = key.split('\0') as [string, SwitchableCategory, MuteableChannel];
      if (owner === userId) out.push({ category, channel, enabled });
    }
    return out;
  }

  async set(userId: string, category: SwitchableCategory, channel: MuteableChannel, enabled: boolean) {
    const key = `${userId}\0${category}\0${channel}`;
    if (this.rows.get(key) === enabled) return { changed: false };
    this.rows.set(key, enabled);
    this.history.push({ userId, category, channel, enabled });
    return { changed: true };
  }
}

export class CategoryPrefs {
  constructor(
    private readonly store: CategoryPrefStore,
    private readonly commands: CommandLog,
    private readonly channelStatus: () => readonly ChannelStatus[],
  ) {}

  async rows(userId: string): Promise<readonly CategoryPrefRow[]> {
    const stored = await this.store.list(userId);
    const configured = new Map(this.channelStatus().map((row) => [row.channel, row.configured]));
    const out: CategoryPrefRow[] = [];
    for (const category of NOTIFY_CATEGORIES) {
      for (const channel of CATEGORY_CHANNELS) {
        const locked = categoryCellLocked(category, channel);
        const isConfigured = channel === 'in_app' ? true : (configured.get(channel) ?? false);
        const match = locked ? undefined : stored.find((row) => row.category === category && row.channel === channel);
        out.push({
          category,
          channel,
          enabled: locked ? true : match?.enabled !== false,
          locked,
          configured: isConfigured,
          notConnected: channel === 'in_app' || isConfigured ? null : NOT_CONNECTED[channel],
        });
      }
    }
    return out;
  }

  async set(
    userId: string,
    input: { category: string; channel: string; enabled: boolean; clientRequestId: string },
  ): Promise<CategoryPrefResult> {
    const replay = await this.commands.find(userId, 'setCategoryPref', input.clientRequestId);
    if (replay) return replay as CategoryPrefResult;
    if (!isNotifyCategory(input.category)) throw new CategoryPrefError('notify.category_unknown');
    if (!isCategoryChannel(input.channel)) throw new CategoryPrefError('notify.category_channel_unknown');
    const locked = categoryCellLocked(input.category, input.channel);
    if (!locked) {
      await this.store.set(userId, input.category as SwitchableCategory, input.channel as MuteableChannel, input.enabled);
    }
    const result: CategoryPrefResult = { rows: await this.rows(userId), locked };
    await this.commands.put(userId, 'setCategoryPref', input.clientRequestId, result);
    return result;
  }

  /** Read at send time, so a replayed event honours the current choice. */
  async allows(userId: string, kind: string, channel: MuteableChannel): Promise<boolean> {
    const category = categoryFromKind(kind);
    if (!category || category === 'security') return true;
    return this.store.get(userId, category, channel);
  }
}
