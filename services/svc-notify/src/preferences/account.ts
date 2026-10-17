/**
 * Account-scoped notification choices: one row per topic and out-of-app
 * channel, plus digest mode and an optional quiet window. Reads are the
 * caller's own rows. A replay of a client request returns the first result.
 */

import { randomUUID } from 'node:crypto';
import type { ChannelStatus } from '../channels/registry.js';
import { CHANNEL_IDS, type ChannelId } from '../channels/channel.js';
import { NOTIFY_TOPICS, isNotifyTopic, topicPrefEnabled, type NotifyTopic } from './combined.js';
import { assertDigestMode, holdUntilFor, type DigestMode } from './digest.js';
import type { MuteableChannel } from './mute.js';
import { assertQuietWindow, type QuietWindow } from './quiet-hours.js';

export type PreferenceCode =
  | 'notify.preferences_unavailable'
  | 'notify.topic_unknown'
  | 'notify.topic_channel_unknown'
  | 'notify.topic_channel_not_preferable'
  | 'notify.digest_mode_unknown';

export class PreferenceError extends Error {
  constructor(readonly code: PreferenceCode) {
    super(code);
    this.name = 'PreferenceError';
  }
}

export type TopicPrefRow = {
  readonly topic: NotifyTopic;
  readonly channel: ChannelId;
  readonly enabled: boolean;
  readonly configured: boolean;
};

export type DigestView = {
  readonly mode: DigestMode;
  readonly quietHours: QuietWindow | null;
};

export type DigestSummary = {
  readonly id: string;
  readonly userId: string;
  readonly releasedAt: string;
  readonly noticeIds: readonly string[];
};

type TopicKey = `${string}\0${NotifyTopic}\0${MuteableChannel}`;

type HoldRow = {
  userId: string;
  notificationId: string;
  channel: MuteableChannel;
  holdUntil: Date;
  summaryId: string | null;
};

export interface CommandLog {
  find(userId: string, procedure: string, clientRequestId: string): Promise<unknown | null>;
  /** Insert the first result. A conflicting key leaves the first result in place. */
  put(userId: string, procedure: string, clientRequestId: string, result: unknown): Promise<void>;
}

export interface TopicPrefStore {
  get(userId: string, topic: NotifyTopic, channel: MuteableChannel): Promise<boolean>;
  list(userId: string): Promise<ReadonlyArray<{ topic: NotifyTopic; channel: MuteableChannel; enabled: boolean }>>;
  set(userId: string, topic: NotifyTopic, channel: MuteableChannel, enabled: boolean): Promise<void>;
}

export interface DigestPrefStore {
  get(userId: string): Promise<DigestView>;
  set(userId: string, view: DigestView): Promise<void>;
}

export interface HoldStore {
  has(notificationId: string, channel: MuteableChannel): Promise<boolean>;
  hold(input: { userId: string; notificationId: string; channel: MuteableChannel; holdUntil: Date }): Promise<'inserted' | 'exists'>;
  releaseDue(userId: string, now: Date): Promise<DigestSummary | null>;
  releaseDueAll(now: Date): Promise<readonly DigestSummary[]>;
}

const PREFERABLE: readonly MuteableChannel[] = ['email', 'push', 'sms'];

function isPreferable(channel: string): channel is MuteableChannel {
  return (PREFERABLE as readonly string[]).includes(channel);
}

function topicKey(userId: string, topic: NotifyTopic, channel: MuteableChannel): TopicKey {
  return `${userId}\0${topic}\0${channel}`;
}

export class MemoryCommandLog implements CommandLog {
  private readonly rows = new Map<string, unknown>();

  async find(userId: string, procedure: string, clientRequestId: string): Promise<unknown | null> {
    return this.rows.get(`${userId}\0${procedure}\0${clientRequestId}`) ?? null;
  }

  async put(userId: string, procedure: string, clientRequestId: string, result: unknown): Promise<void> {
    const key = `${userId}\0${procedure}\0${clientRequestId}`;
    if (!this.rows.has(key)) this.rows.set(key, result);
  }
}

export class MemoryTopicPrefStore implements TopicPrefStore {
  private readonly rows = new Map<TopicKey, boolean>();

  async get(userId: string, topic: NotifyTopic, channel: MuteableChannel): Promise<boolean> {
    return topicPrefEnabled(this.rows.get(topicKey(userId, topic, channel)));
  }

  async list(userId: string): Promise<ReadonlyArray<{ topic: NotifyTopic; channel: MuteableChannel; enabled: boolean }>> {
    const out: { topic: NotifyTopic; channel: MuteableChannel; enabled: boolean }[] = [];
    for (const [key, enabled] of this.rows) {
      const [owner, topic, channel] = key.split('\0') as [string, NotifyTopic, MuteableChannel];
      if (owner === userId) out.push({ topic, channel, enabled });
    }
    return out;
  }

  async set(userId: string, topic: NotifyTopic, channel: MuteableChannel, enabled: boolean): Promise<void> {
    this.rows.set(topicKey(userId, topic, channel), enabled);
  }
}

export class MemoryDigestPrefStore implements DigestPrefStore {
  private readonly rows = new Map<string, DigestView>();

  async get(userId: string): Promise<DigestView> {
    return this.rows.get(userId) ?? { mode: 'immediate', quietHours: null };
  }

  async set(userId: string, view: DigestView): Promise<void> {
    this.rows.set(userId, view);
  }
}

export class MemoryHoldStore implements HoldStore {
  private readonly holds: HoldRow[] = [];
  private readonly summaries: DigestSummary[] = [];

  async has(notificationId: string, channel: MuteableChannel): Promise<boolean> {
    return this.holds.some((row) => row.notificationId === notificationId && row.channel === channel);
  }

  async hold(input: { userId: string; notificationId: string; channel: MuteableChannel; holdUntil: Date }): Promise<'inserted' | 'exists'> {
    if (await this.has(input.notificationId, input.channel)) return 'exists';
    this.holds.push({ ...input, summaryId: null });
    return 'inserted';
  }

  async releaseDue(userId: string, now: Date): Promise<DigestSummary | null> {
    const due = this.holds.filter((row) => row.userId === userId && row.summaryId === null && row.holdUntil.getTime() <= now.getTime());
    if (due.length === 0) return null;
    const noticeIds = [...new Set(due.map((row) => row.notificationId))].sort();
    const summary: DigestSummary = {
      id: randomUUID(),
      userId,
      releasedAt: now.toISOString(),
      noticeIds,
    };
    this.summaries.push(summary);
    for (const row of due) row.summaryId = summary.id;
    return summary;
  }

  async releaseDueAll(now: Date): Promise<readonly DigestSummary[]> {
    const users = new Set(
      this.holds.filter((row) => row.summaryId === null && row.holdUntil.getTime() <= now.getTime()).map((row) => row.userId),
    );
    const released: DigestSummary[] = [];
    for (const userId of users) {
      const summary = await this.releaseDue(userId, now);
      if (summary) released.push(summary);
    }
    return released;
  }
}

export class AccountPrefs {
  constructor(
    private readonly topics: TopicPrefStore,
    private readonly digests: DigestPrefStore,
    private readonly commands: CommandLog,
    private readonly channelStatus: () => readonly ChannelStatus[],
  ) {}

  async topicPrefs(userId: string): Promise<readonly TopicPrefRow[]> {
    const stored = await this.topics.list(userId);
    const configured = new Map(this.channelStatus().map((row) => [row.channel, row.configured]));
    const rows: TopicPrefRow[] = [];
    for (const topic of NOTIFY_TOPICS) {
      for (const channel of CHANNEL_IDS) {
        const match = stored.find((row) => row.topic === topic && row.channel === channel);
        rows.push({
          topic,
          channel,
          enabled: channel === 'inapp' ? true : topicPrefEnabled(match?.enabled),
          configured: channel === 'inapp' ? true : (configured.get(channel) ?? false),
        });
      }
    }
    return rows;
  }

  async setTopicPref(
    userId: string,
    input: { topic: string; channel: string; enabled: boolean; clientRequestId: string },
  ): Promise<readonly TopicPrefRow[]> {
    const replay = await this.commands.find(userId, 'setTopicPref', input.clientRequestId);
    if (replay) return replay as TopicPrefRow[];
    if (!isNotifyTopic(input.topic)) throw new PreferenceError('notify.topic_unknown');
    if (input.channel === 'inapp') throw new PreferenceError('notify.topic_channel_not_preferable');
    if (!isPreferable(input.channel)) throw new PreferenceError('notify.topic_channel_unknown');
    await this.topics.set(userId, input.topic, input.channel, input.enabled);
    const snapshot = await this.topicPrefs(userId);
    await this.commands.put(userId, 'setTopicPref', input.clientRequestId, snapshot);
    return snapshot;
  }

  async digestPrefs(userId: string): Promise<DigestView> {
    return this.digests.get(userId);
  }

  async setDigest(
    userId: string,
    input: { mode: string; quietHours?: { start: string; end: string; timeZone: string } | null; clientRequestId: string },
  ): Promise<DigestView> {
    const replay = await this.commands.find(userId, 'setDigest', input.clientRequestId);
    if (replay) return replay as DigestView;
    let mode: DigestMode;
    try {
      mode = assertDigestMode(input.mode);
    } catch (err) {
      if (err instanceof Error && err.message === 'notify.digest_mode_unknown') {
        throw new PreferenceError('notify.digest_mode_unknown');
      }
      throw err;
    }
    const quietHours = input.quietHours == null ? null : assertQuietWindow(input.quietHours);
    const view: DigestView = { mode, quietHours };
    await this.digests.set(userId, view);
    await this.commands.put(userId, 'setDigest', input.clientRequestId, view);
    return view;
  }

  /** Used by dispatch. Critical never holds. */
  async holdUntil(userId: string, severity: 'info' | 'action' | 'critical', now: Date): Promise<Date | null> {
    const view = await this.digests.get(userId);
    return holdUntilFor({ mode: view.mode, quiet: view.quietHours, severity, now });
  }
}
