/**
 * Durable topic choices, digest windows, command replay, and held summaries.
 * SQL matches drizzle/0010_notify_topic_digest.sql.
 */

import type { Sql } from 'postgres';
import { isNotifyTopic, topicPrefEnabled, type NotifyTopic } from './combined.js';
import { assertDigestMode } from './digest.js';
import type { MuteableChannel } from './mute.js';
import type { QuietWindow } from './quiet-hours.js';
import type { CommandLog, DigestPrefStore, DigestSummary, DigestView, DueHold, HoldStore, TopicPrefStore } from './account.js';

type TopicPg = { topic: string; channel: string; enabled: boolean };
type DigestPg = { mode: string; quiet_start: string | null; quiet_end: string | null; quiet_zone: string | null };
type HoldDuePg = { id: string; user_id: string; notification_id: string; channel: string };

function asTopic(value: string): NotifyTopic {
  if (!isNotifyTopic(value)) throw new Error(`notify.topic_unknown`);
  return value;
}

function asChannel(value: string): MuteableChannel {
  if (value !== 'email' && value !== 'push' && value !== 'sms') throw new Error('notify.topic_channel_unknown');
  return value;
}

export class PostgresCommandLog implements CommandLog {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, procedure: string, clientRequestId: string): Promise<unknown | null> {
    const rows = await this.sql<{ result: unknown }[]>`
      SELECT result FROM notify.preference_commands
       WHERE user_id = ${userId} AND procedure = ${procedure} AND client_request_id = ${clientRequestId}
    `;
    return rows[0]?.result ?? null;
  }

  async put(userId: string, procedure: string, clientRequestId: string, result: unknown): Promise<void> {
    await this.sql`
      INSERT INTO notify.preference_commands (user_id, procedure, client_request_id, result)
      VALUES (${userId}, ${procedure}, ${clientRequestId}, ${this.sql.json(JSON.parse(JSON.stringify(result)))})
      ON CONFLICT (user_id, procedure, client_request_id) DO NOTHING
    `;
  }
}

export class PostgresTopicPrefStore implements TopicPrefStore {
  constructor(private readonly sql: Sql) {}

  async get(userId: string, topic: NotifyTopic, channel: MuteableChannel): Promise<boolean> {
    const rows = await this.sql<{ enabled: boolean }[]>`
      SELECT enabled FROM notify.topic_prefs
       WHERE user_id = ${userId} AND topic = ${topic} AND channel = ${channel}
    `;
    return topicPrefEnabled(rows[0]?.enabled);
  }

  async list(userId: string): Promise<ReadonlyArray<{ topic: NotifyTopic; channel: MuteableChannel; enabled: boolean }>> {
    const rows = await this.sql<TopicPg[]>`
      SELECT topic, channel, enabled FROM notify.topic_prefs WHERE user_id = ${userId}
    `;
    return rows.map((row) => ({ topic: asTopic(row.topic), channel: asChannel(row.channel), enabled: row.enabled }));
  }

  async set(userId: string, topic: NotifyTopic, channel: MuteableChannel, enabled: boolean): Promise<void> {
    await this.sql`
      INSERT INTO notify.topic_prefs (user_id, topic, channel, enabled)
      VALUES (${userId}, ${topic}, ${channel}, ${enabled})
      ON CONFLICT (user_id, topic, channel) DO UPDATE
        SET enabled = EXCLUDED.enabled, updated_at = now()
    `;
  }
}

export class PostgresDigestPrefStore implements DigestPrefStore {
  constructor(private readonly sql: Sql) {}

  async get(userId: string): Promise<DigestView> {
    const rows = await this.sql<DigestPg[]>`
      SELECT mode, quiet_start, quiet_end, quiet_zone FROM notify.digest_prefs WHERE user_id = ${userId}
    `;
    const row = rows[0];
    if (!row) return { mode: 'immediate', quietHours: null };
    const quietHours: QuietWindow | null =
      row.quiet_start && row.quiet_end && row.quiet_zone ? { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_zone } : null;
    return { mode: assertDigestMode(row.mode), quietHours };
  }

  async set(userId: string, view: DigestView): Promise<void> {
    await this.sql`
      INSERT INTO notify.digest_prefs (user_id, mode, quiet_start, quiet_end, quiet_zone)
      VALUES (
        ${userId},
        ${view.mode},
        ${view.quietHours?.start ?? null},
        ${view.quietHours?.end ?? null},
        ${view.quietHours?.timeZone ?? null}
      )
      ON CONFLICT (user_id) DO UPDATE
        SET mode = EXCLUDED.mode,
            quiet_start = EXCLUDED.quiet_start,
            quiet_end = EXCLUDED.quiet_end,
            quiet_zone = EXCLUDED.quiet_zone,
            updated_at = now()
    `;
  }
}

export class PostgresHoldStore implements HoldStore {
  constructor(private readonly sql: Sql) {}

  async has(notificationId: string, channel: MuteableChannel): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM notify.digest_holds
       WHERE notification_id = ${notificationId} AND channel = ${channel}
       LIMIT 1
    `;
    return rows.length > 0;
  }

  async hold(input: { userId: string; notificationId: string; channel: MuteableChannel; holdUntil: Date }): Promise<'inserted' | 'exists'> {
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO notify.digest_holds (user_id, notification_id, channel, hold_until)
      VALUES (${input.userId}, ${input.notificationId}, ${input.channel}, ${input.holdUntil})
      ON CONFLICT (notification_id, channel) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0 ? 'inserted' : 'exists';
  }

  async listDue(now: Date): Promise<readonly DueHold[]> {
    const due = await this.sql<HoldDuePg[]>`
      SELECT id, user_id, notification_id, channel FROM notify.digest_holds
       WHERE summary_id IS NULL AND hold_until <= ${now}
    `;
    return due.map((row) => ({
      id: row.id,
      userId: row.user_id,
      notificationId: row.notification_id,
      channel: asChannel(row.channel),
    }));
  }

  async markReleased(userId: string, now: Date, holdIds: readonly string[]): Promise<DigestSummary | null> {
    if (holdIds.length === 0) return null;
    return this.sql.begin(async (tx) => {
      const due = await tx<{ id: string; notification_id: string }[]>`
        SELECT id, notification_id FROM notify.digest_holds
         WHERE user_id = ${userId}
           AND summary_id IS NULL
           AND id = ANY(${holdIds as unknown as string[]}::uuid[])
         FOR UPDATE
      `;
      if (due.length === 0) return null;
      const noticeIds = [...new Set(due.map((row) => row.notification_id))].sort();
      const lockedIds = due.map((row) => row.id);
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO notify.digest_summaries (user_id, released_at, notice_ids)
        VALUES (${userId}, ${now}, ${tx.json(noticeIds)})
        RETURNING id
      `;
      const summaryId = inserted[0]!.id;
      await tx`
        UPDATE notify.digest_holds
           SET summary_id = ${summaryId}
         WHERE id = ANY(${lockedIds as unknown as string[]}::uuid[])
      `;
      return { id: summaryId, userId, releasedAt: now.toISOString(), noticeIds };
    });
  }
}
