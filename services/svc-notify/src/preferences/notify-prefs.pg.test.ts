import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { PostgresDeliveryStore, PostgresTargetStore } from '../channel-store.js';
import { type NotificationChannel, type OutboundMessage } from '../channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';
import { PostgresNoticeStore } from '../notices/board.pg.js';
import { NoticeBoard, type NoticeApprovalConsumer } from '../notices/board.js';
import { PostgresNotifyStore } from '../store.js';
import { AccountPrefs, type DigestSummary, type HoldStore, MemoryCommandLog } from './account.js';
import { PostgresCommandLog, PostgresDigestPrefStore, PostgresHoldStore, PostgresTopicPrefStore } from './account.pg.js';
import { encodeRecentCursor } from './recent.js';

/**
 * Durable rows on a test database: the lead shared database named `test`,
 * or any name `assertTestDatabase` accepts (`intafaced_test` and other `*_test`).
 * It never drops or truncates a table. Cleanup deletes only this file's ids.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const USER = 'n0t1f7be-1111-4111-8111-111111111111';
const OTHER = 'n0t1f7be-2222-4222-8222-222222222222';
const AUTHOR = 'n0t1f7be-3333-4333-8333-333333333333';
const APPROVER = 'n0t1f7be-4444-4444-8444-444444444444';
const PAGE_USER = 'n0t1f7be-5555-4555-8555-555555555555';
const RELEASE_USER = 'n0t1f7be-6666-4666-8666-666666666666';
const PAGE_OTHER = 'n0t1f7be-7777-4777-8777-777777777777';

/**
 * Neither URL means this file is not the caller (`describe.skipIf` skips).
 * A set URL is probed with `postgresAvailable`: a dead local database skips,
 * and CI / REQUIRE_POSTGRES throws instead of skipping.
 */
const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

/**
 * The lead shared database is named `test`. CI and compose use `*_test`.
 * `assertTestDatabase` is the repo guard for the suffix; the exact name `test`
 * is the one extra it does not already allow. Anything else is refused.
 */
async function assertNotifyPrefsDatabase(db: Sql): Promise<void> {
  const rows = await db<{ db: string }[]>`SELECT current_database() AS db`;
  if (rows[0]?.db === 'test') return;
  await assertTestDatabase(db, 'svc-notify notify-prefs.pg.test');
}

const REQUIRED_TABLES = [
  'notify.topic_prefs',
  'notify.digest_prefs',
  'notify.digest_holds',
  'notify.digest_summaries',
  'notify.preference_commands',
  'notify.notices',
  'notify.notice_approval_uses',
] as const;

/**
 * Sibling suites apply 0000-0004 at import and ignore errors. Replaying 0002
 * inside a transaction then aborts this file (`delivered_at` is already
 * `accepted_at`). Apply each file the same way they do, then refuse a schema
 * that is still missing a table this file reads or writes.
 */
async function applyMigrations(db: Sql): Promise<void> {
  await assertNotifyPrefsDatabase(db);
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    const body = readFileSync(join(migrationsDir, file), 'utf8');
    await db.unsafe(body).catch(() => undefined);
  }
  await assertMigratedShape(db);
}

async function assertMigratedShape(db: Sql): Promise<void> {
  const missing: string[] = [];
  for (const name of REQUIRED_TABLES) {
    const rows = await db<{ rel: string | null }[]>`SELECT to_regclass(${name}) AS rel`;
    if (rows[0]?.rel == null) missing.push(name);
  }
  const accepted = await db<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = to_regclass('notify.deliveries')
        AND attname = 'accepted_at'
        AND NOT attisdropped
    ) AS present
  `;
  if (!accepted[0]?.present) missing.push('notify.deliveries.accepted_at');
  if (missing.length > 0) {
    throw new Error(`notify-prefs.pg.test: migrations did not leave a usable schema. Missing: ${missing.join(', ')}.`);
  }
}

async function cleanup(db: Sql): Promise<void> {
  await db`DELETE FROM notify.digest_holds WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
  await db`DELETE FROM notify.digest_summaries WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
  await db`DELETE FROM notify.deliveries WHERE notification_id IN (
    SELECT id FROM notify.notifications WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})
  )`;
  await db`DELETE FROM notify.notifications WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
  await db`DELETE FROM notify.channel_targets WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
  await db`DELETE FROM notify.topic_prefs WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
  await db`DELETE FROM notify.digest_prefs WHERE user_id IN (${USER}, ${OTHER}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
  await db`DELETE FROM notify.preference_commands WHERE user_id IN (${USER}, ${OTHER}, ${AUTHOR}, ${PAGE_USER}, ${PAGE_OTHER}, ${RELEASE_USER})`;
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

function db(): Sql {
  if (!client) throw new Error('TEST_DATABASE_URL_NOTIFY and TEST_DATABASE_URL are unset');
  return client;
}

beforeAll(async () => {
  if (!client) return;
  await applyMigrations(client);
  await cleanup(client);
});

afterAll(async () => {
  if (!client) return;
  await cleanup(client).catch(() => undefined);
  await client.end({ timeout: 1 }).catch(() => undefined);
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

describe.skipIf(!URL || !available)('notify prefs on the shared test database', () => {
  it('keeps one account topic mute invisible to another, and replays the first snapshot', async () => {
    const account = new AccountPrefs(
      new PostgresTopicPrefStore(db()),
      new PostgresDigestPrefStore(db()),
      new PostgresCommandLog(db()),
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
      new PostgresTopicPrefStore(db()),
      new PostgresDigestPrefStore(db()),
      new PostgresCommandLog(db()),
      channelStatus,
    );
    expect((await reloaded.topicPrefs(USER)).find((row) => row.topic === 'trade' && row.channel === 'email')?.enabled).toBe(false);
  });

  it('pages one account deliveries and leaves the other account out', async () => {
    const older = 'a1111111-1111-4111-8111-111111111111';
    const newer = 'b1111111-1111-4111-8111-111111111111';
    const foreign = 'c1111111-1111-4111-8111-111111111111';
    await db()`
      INSERT INTO notify.notifications (id, user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key)
      VALUES
        (${older}, ${USER}, 'trade.fill', 'notify.trade.fill.title', 'notify.trade.fill.body', 'info', 'intafaced.trade.fill.settled', 'pg-recent-older'),
        (${newer}, ${USER}, 'trade.fill', 'notify.trade.fill.title', 'notify.trade.fill.body', 'info', 'intafaced.trade.fill.settled', 'pg-recent-newer'),
        (${foreign}, ${OTHER}, 'trade.fill', 'notify.trade.fill.title', 'notify.trade.fill.body', 'info', 'intafaced.trade.fill.settled', 'pg-recent-foreign')
    `;
    const deliveries = new PostgresDeliveryStore(db());
    for (const id of [older, newer, foreign]) {
      const claim = await deliveries.claim(id, 'email', 3);
      if (!claim.claimed) throw new Error('claim failed');
      await deliveries.settle({ id: claim.id, attempt: claim.attempt, status: 'accepted', refusalCode: null, attempted: true });
    }
    await db()`UPDATE notify.deliveries SET created_at = '2026-06-01T00:00:00.000Z' WHERE notification_id = ${older}`;
    await db()`UPDATE notify.deliveries SET created_at = '2026-06-01T00:00:02.000Z' WHERE notification_id = ${newer}`;
    await db()`UPDATE notify.deliveries SET created_at = '2026-06-01T00:00:03.000Z' WHERE notification_id = ${foreign}`;
    const page = await deliveries.listOwnedRecent({ userId: USER, limit: 1, beforeId: null });
    expect(page.map((row) => row.notificationId)).toEqual([newer]);
    const rest = await deliveries.listOwnedRecent({
      userId: USER,
      limit: 5,
      beforeId: page[0]!.id,
    });
    expect(rest.map((row) => row.notificationId)).toEqual([older]);
    const other = await deliveries.listOwnedRecent({ userId: OTHER, limit: 5, beforeId: null });
    expect(other.map((row) => row.notificationId)).toEqual([foreign]);
  });

  it('refuses a published notice edit and keeps the id', async () => {
    const board = new NoticeBoard(
      new PostgresNoticeStore(db()),
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
    await expect(db()`UPDATE notify.notices SET title = 'Changed' WHERE id = ${published.id}`).rejects.toThrow(
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

  it('returns each same-millisecond delivery once, newest first', async () => {
    const store = new PostgresNotifyStore(db());
    const deliveries = new PostgresDeliveryStore(db());
    const channels = new ChannelRegistry([
      new InAppChannel(),
      new ReadyEmail(),
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const notify = new NotifyService(
      store,
      { fanoutEnabled: false },
      {
        targets: new PostgresTargetStore(db()),
        deliveries,
        channels,
        dispatcher: new NotificationDispatcher(channels, new PostgresTargetStore(db()), deliveries, {
          maxAttempts: 3,
          outOfAppEnabled: true,
        }),
      },
    );
    const stamps = [
      ['2026-06-01T00:00:00.000100Z', 'pg-us-oldest'],
      ['2026-06-01T00:00:00.000500Z', 'pg-us-middle'],
      ['2026-06-01T00:00:00.000900Z', 'pg-us-newest'],
    ] as const;
    const ids: Record<(typeof stamps)[number][1], string> = {
      'pg-us-oldest': '',
      'pg-us-middle': '',
      'pg-us-newest': '',
    };
    for (const [stamp, key] of stamps) {
      const inserted = await store.insert({
        userId: PAGE_USER,
        kind: 'trade.fill',
        titleKey: 'notify.trade.fill.title',
        bodyKey: 'notify.trade.fill.body',
        severity: 'info',
        sourceSubject: 'intafaced.trade.fill.settled',
        sourceIdempotencyKey: key,
      });
      const id = inserted.notification!.id;
      ids[key] = id;
      const claim = await deliveries.claim(id, 'email', 3);
      if (!claim.claimed) throw new Error('claim failed');
      await deliveries.settle({ id: claim.id, attempt: claim.attempt, status: 'accepted', refusalCode: null, attempted: true });
      await db()`UPDATE notify.deliveries SET created_at = ${stamp}::text::timestamptz WHERE notification_id = ${id}`;
    }
    const foreign = await store.insert({
      userId: PAGE_OTHER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'pg-us-foreign',
    });
    const foreignClaim = await deliveries.claim(foreign.notification!.id, 'email', 3);
    if (!foreignClaim.claimed) throw new Error('claim failed');
    await deliveries.settle({
      id: foreignClaim.id,
      attempt: foreignClaim.attempt,
      status: 'accepted',
      refusalCode: null,
      attempted: true,
    });
    await db()`UPDATE notify.deliveries SET created_at = ${'2026-06-01T00:00:00.000700Z'}::text::timestamptz WHERE notification_id = ${foreign.notification!.id}`;

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const result = await notify.recentDeliveries(PAGE_USER, 1, cursor);
      expect(result.rows).toHaveLength(1);
      seen.push(result.rows[0]!.notificationId);
      cursor = result.nextCursor;
      if (page < 2) expect(cursor).toEqual(expect.any(String));
      else expect(cursor).toBeNull();
    }
    expect(seen).toEqual([ids['pg-us-newest'], ids['pg-us-middle'], ids['pg-us-oldest']]);
    expect(new Set(seen).size).toBe(3);
    expect(seen).not.toContain(foreign.notification!.id);

    const foreignRows = await deliveries.listOwnedRecent({ userId: PAGE_OTHER, limit: 5, beforeId: null });
    await expect(notify.recentDeliveries(PAGE_USER, 1, encodeRecentCursor(foreignRows[0]!))).rejects.toMatchObject({
      code: 'notify.recent_deliveries_cursor_invalid',
    });
  });

  it('delivers a held email once when the hold ends and does not send it again', async () => {
    const store = new PostgresNotifyStore(db());
    const targets = new PostgresTargetStore(db());
    const deliveries = new PostgresDeliveryStore(db());
    const holds = new PostgresHoldStore(db());
    const channels = new ChannelRegistry([
      new InAppChannel(),
      new ReadyEmail(),
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const dispatcher = new NotificationDispatcher(channels, targets, deliveries, {
      maxAttempts: 3,
      outOfAppEnabled: true,
      loadNotification: (userId, notificationId) => store.findById(userId, notificationId),
    });
    const token = 'ab'.repeat(32);
    await targets.upsert({
      userId: RELEASE_USER,
      channel: 'email',
      address: 'release@example.com',
      locale: 'en',
      verifyTokenHash: token,
      verifyExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(await targets.markVerified(RELEASE_USER, 'email', token, new Date('2026-06-01T00:00:00.000Z'))).toBe(true);
    const inserted = await store.insert({
      userId: RELEASE_USER,
      kind: 'p2p.escrow.released',
      titleKey: 'notify.p2p.escrow.released.title',
      bodyKey: 'notify.p2p.escrow.released.body',
      severity: 'info',
      sourceSubject: 'intafaced.p2p.escrow.released',
      sourceIdempotencyKey: 'pg-release-hold',
    });
    const notificationId = inserted.notification!.id;
    const releaseAt = new Date('2026-06-02T00:00:00.000Z');
    expect(
      await holds.hold({
        userId: RELEASE_USER,
        notificationId,
        channel: 'email',
        holdUntil: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ).toBe('inserted');

    const first = await releaseHeldSummaries(holds, dispatcher, releaseAt);
    expect(first.map((row) => row.noticeIds)).toEqual([[notificationId]]);
    const delivered = await db()`
      SELECT status FROM notify.deliveries WHERE notification_id = ${notificationId} AND channel = 'email'
    `;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.status).toBe('accepted');
    const marked = await db()`
      SELECT summary_id FROM notify.digest_holds WHERE notification_id = ${notificationId} AND channel = 'email'
    `;
    expect(marked[0]?.summary_id).toBeTruthy();

    const second = await releaseHeldSummaries(holds, dispatcher, new Date('2026-06-02T01:00:00.000Z'));
    expect(second).toEqual([]);
    const again = await db()`
      SELECT status FROM notify.deliveries WHERE notification_id = ${notificationId} AND channel = 'email'
    `;
    expect(again).toHaveLength(1);
    expect(again[0]?.status).toBe('accepted');
  });
});

type ReleaseFn = (holds: HoldStore, dispatcher: NotificationDispatcher, now: Date) => Promise<readonly DigestSummary[]>;

function isMissingReleaseModule(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message);
}

async function releaseHeldSummaries(
  holds: PostgresHoldStore,
  dispatcher: NotificationDispatcher,
  now: Date,
): Promise<readonly DigestSummary[]> {
  let releaseDueHolds: ReleaseFn | undefined;
  try {
    const mod = (await import('./release.js')) as { releaseDueHolds?: ReleaseFn };
    releaseDueHolds = mod.releaseDueHolds;
  } catch (err) {
    if (!isMissingReleaseModule(err)) throw err;
  }
  if (releaseDueHolds && typeof dispatcher.releaseHeld === 'function') return releaseDueHolds(holds, dispatcher, now);
  const legacy = holds as PostgresHoldStore & {
    releaseDueAll(now: Date): Promise<readonly DigestSummary[]>;
  };
  return legacy.releaseDueAll(now);
}
