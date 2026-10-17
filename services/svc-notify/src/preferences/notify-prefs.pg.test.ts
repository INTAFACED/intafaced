import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { PostgresDeliveryStore } from '../channel-store.js';
import { type NotificationChannel, type OutboundMessage } from '../channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { PostgresNoticeStore } from '../notices/board.pg.js';
import { NoticeBoard, type NoticeApprovalConsumer } from '../notices/board.js';
import { AccountPrefs, MemoryCommandLog } from './account.js';
import { PostgresCommandLog, PostgresDigestPrefStore, PostgresTopicPrefStore } from './account.pg.js';

/**
 * Durable rows on the shared test database named `test`.
 * This file does not call assertTestDatabase: that helper refuses any name
 * that does not end in `_test`, and the lead database is named `test`.
 * It never drops or truncates a table. Cleanup deletes only this file's ids.
 */

const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const USER = 'n0t1f7be-1111-4111-8111-111111111111';
const OTHER = 'n0t1f7be-2222-4222-8222-222222222222';
const AUTHOR = 'n0t1f7be-3333-4333-8333-333333333333';
const APPROVER = 'n0t1f7be-4444-4444-8444-444444444444';

if (!URL) throw new Error('TEST_DATABASE_URL is unset. Source ~/.codex/context/work/runs/test-db.env.');

const sql = postgres(URL, { max: 2, onnotice: () => undefined });

async function applyMigrations(db: Sql): Promise<void> {
  const name = await db<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') {
    throw new Error(`refusing notify prefs pg test: current_database is ${name[0]?.db ?? 'unknown'}, expected test`);
  }
  await db`CREATE SCHEMA IF NOT EXISTS notify`;
  await db`
    CREATE TABLE IF NOT EXISTS notify.__migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), 'utf8');
    await db.begin(async (tx) => {
      const claimed = await tx<{ name: string }[]>`
        INSERT INTO notify.__migrations (name) VALUES (${file})
        ON CONFLICT (name) DO NOTHING
        RETURNING name
      `;
      if (claimed.length === 0) return;
      await tx.unsafe(body);
    });
  }
}

async function cleanup(db: Sql): Promise<void> {
  await db`DELETE FROM notify.digest_holds WHERE user_id IN (${USER}, ${OTHER})`;
  await db`DELETE FROM notify.digest_summaries WHERE user_id IN (${USER}, ${OTHER})`;
  await db`DELETE FROM notify.deliveries WHERE notification_id IN (
    SELECT id FROM notify.notifications WHERE user_id IN (${USER}, ${OTHER})
  )`;
  await db`DELETE FROM notify.notifications WHERE user_id IN (${USER}, ${OTHER})`;
  await db`DELETE FROM notify.topic_prefs WHERE user_id IN (${USER}, ${OTHER})`;
  await db`DELETE FROM notify.digest_prefs WHERE user_id IN (${USER}, ${OTHER})`;
  await db`DELETE FROM notify.preference_commands WHERE user_id IN (${USER}, ${OTHER}, ${AUTHOR})`;
  await db`ALTER TABLE notify.notices DISABLE TRIGGER notice_published_immutable`;
  try {
    await db`DELETE FROM notify.notice_approval_uses WHERE publisher_id = ${AUTHOR}`;
    await db`DELETE FROM notify.notices WHERE author_id = ${AUTHOR}`;
  } finally {
    await db`ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable`;
  }
}

class OneApproval implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

beforeAll(async () => {
  await applyMigrations(sql);
  await cleanup(sql);
});

afterAll(async () => {
  await cleanup(sql).catch(() => undefined);
  await sql.end({ timeout: 1 }).catch(() => undefined);
});

class ReadyEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  async deliver(_message: OutboundMessage) {
    return { reference: 'pg-email' };
  }
}

function channelStatus() {
  return new ChannelRegistry([
    new InAppChannel(),
    new ReadyEmail(),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]).status();
}

describe('notify prefs on the shared test database', () => {
  it('keeps one account topic mute invisible to another, and replays the first snapshot', async () => {
    const account = new AccountPrefs(
      new PostgresTopicPrefStore(sql),
      new PostgresDigestPrefStore(sql),
      new PostgresCommandLog(sql),
      channelStatus,
    );
    const first = await account.setTopicPref(USER, {
      topic: 'trade',
      channel: 'email',
      enabled: false,
      clientRequestId: 'pg-topic-1',
    });
    expect(first.find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(false);
    const replay = await account.setTopicPref(USER, {
      topic: 'trade',
      channel: 'email',
      enabled: true,
      clientRequestId: 'pg-topic-1',
    });
    expect(replay.find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(false);
    const other = await account.topicPrefs(OTHER);
    expect(other.find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(true);
    const reloaded = new AccountPrefs(
      new PostgresTopicPrefStore(sql),
      new PostgresDigestPrefStore(sql),
      new PostgresCommandLog(sql),
      channelStatus,
    );
    expect((await reloaded.topicPrefs(USER)).find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(false);
  });

  it('pages one account deliveries and leaves the other account out', async () => {
    const older = 'a1111111-1111-4111-8111-111111111111';
    const newer = 'b1111111-1111-4111-8111-111111111111';
    const foreign = 'c1111111-1111-4111-8111-111111111111';
    await sql`
      INSERT INTO notify.notifications (id, user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key)
      VALUES
        (${older}, ${USER}, 'trade.fill', 'notify.trade.fill.title', 'notify.trade.fill.body', 'info', 'intafaced.trade.fill.settled', 'pg-recent-older'),
        (${newer}, ${USER}, 'trade.fill', 'notify.trade.fill.title', 'notify.trade.fill.body', 'info', 'intafaced.trade.fill.settled', 'pg-recent-newer'),
        (${foreign}, ${OTHER}, 'trade.fill', 'notify.trade.fill.title', 'notify.trade.fill.body', 'info', 'intafaced.trade.fill.settled', 'pg-recent-foreign')
    `;
    const deliveries = new PostgresDeliveryStore(sql);
    for (const id of [older, newer, foreign]) {
      const claim = await deliveries.claim(id, 'email', 3);
      if (!claim.claimed) throw new Error('claim failed');
      await deliveries.settle({ id: claim.id, attempt: claim.attempt, status: 'accepted', refusalCode: null, attempted: true });
    }
    await sql`UPDATE notify.deliveries SET created_at = '2026-06-01T00:00:00.000Z' WHERE notification_id = ${older}`;
    await sql`UPDATE notify.deliveries SET created_at = '2026-06-01T00:00:02.000Z' WHERE notification_id = ${newer}`;
    await sql`UPDATE notify.deliveries SET created_at = '2026-06-01T00:00:03.000Z' WHERE notification_id = ${foreign}`;
    const page = await deliveries.listOwnedRecent({ userId: USER, limit: 1, before: null });
    expect(page.map((row) => row.notificationId)).toEqual([newer]);
    const rest = await deliveries.listOwnedRecent({
      userId: USER,
      limit: 5,
      before: { createdAt: page[0]!.createdAt, id: page[0]!.id },
    });
    expect(rest.map((row) => row.notificationId)).toEqual([older]);
    const other = await deliveries.listOwnedRecent({ userId: OTHER, limit: 5, before: null });
    expect(other.map((row) => row.notificationId)).toEqual([foreign]);
  });

  it('refuses a published notice edit and keeps the id', async () => {
    const board = new NoticeBoard(
      new PostgresNoticeStore(sql),
      new OneApproval(),
      new MemoryCommandLog(),
      () => new Date('2026-10-17T12:00:00.000Z'),
    );
    const draft = await board.draft(AUTHOR, {
      kind: 'incident',
      title: 'Test incident',
      body: 'Test incident body',
      clientRequestId: 'pg-draft-1',
    });
    const published = await board.publish(AUTHOR, {
      id: draft.id,
      clientRequestId: 'pg-publish-1',
      approvalId: 'pg-approval-1',
      operationId: 'pg-op-1',
    });
    expect(published.id).toBe(draft.id);
    expect(published.status).toBe('published');
    const listed = await board.notices({ limit: 20 });
    expect(listed.some((row) => row.id === draft.id && row.status === 'draft')).toBe(false);
    expect(listed.find((row) => row.id === published.id)?.status).toBe('published');
    await expect(sql`UPDATE notify.notices SET title = 'Changed' WHERE id = ${published.id}`).rejects.toThrow(
      /notify\.notice_published_immutable/,
    );
    const again = await board.publish(AUTHOR, {
      id: draft.id,
      clientRequestId: 'pg-publish-1',
      approvalId: 'pg-approval-other',
      operationId: 'pg-op-other',
    });
    expect(again.id).toBe(published.id);
    expect(again.title).toBe('Test incident');
  });
});
