import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { PostgresCommandLog } from '../preferences/account.pg.js';
import { NoticeBoard, type NoticeApprovalConsumer } from './board.js';
import { PostgresNoticeStore } from './board.pg.js';
import type { AudienceMembership, MemberAudience } from './audiences.js';

/** Notice audiences on the real table: a merchants' notice stays off every public read, and its audience is held once published. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const AUTHOR = 'de5c0000-7777-4777-8777-777777777777';
const APPROVER = 'de5c0000-8888-4888-8888-888888888888';

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

class Approvals implements NoticeApprovalConsumer {
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
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

async function cleanup(sql: Sql): Promise<void> {
  const mine = sql`SELECT id FROM notify.notices WHERE author_id = ${AUTHOR}`;
  await sql`ALTER TABLE notify.notices DISABLE TRIGGER notice_published_immutable`;
  try {
    await sql`DELETE FROM notify.notice_approval_uses WHERE publisher_id = ${AUTHOR}`;
    await sql`DELETE FROM notify.notices WHERE author_id = ${AUTHOR}`;
    await sql`DELETE FROM notify.preference_commands WHERE user_id = ${AUTHOR}`;
  } finally {
    await sql`ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable`;
  }
}

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify audiences.pg.test');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
  await cleanup(client);
});

afterAll(async () => {
  if (!client) return;
  await cleanup(client).catch(() => undefined);
  await client.end({ timeout: 1 }).catch(() => undefined);
});

if (!available) {
  describe.skip('notice audiences on Postgres (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('notice audiences on Postgres', () => {
    const run = Date.now().toString(36);
    const MERCHANT = 'de5c0000-9999-4999-8999-999999999999';
    const merchants: AudienceMembership = {
      audiencesOf: async (userId) => new Set<MemberAudience>(userId === MERCHANT ? ['p2p-merchants'] : []),
    };
    const board = () =>
      new NoticeBoard(
        new PostgresNoticeStore(client!),
        new Approvals(),
        new PostgresCommandLog(client!),
        () => new Date(),
        async () => [],
        async () => undefined,
        async () => new Set(),
        async () => null,
        merchants,
      );

    it('stores the audience, keeps the notice off the public reads, reads it to members, and holds it once published', async () => {
      const b = board();
      const draft = await b.draft(AUTHOR, {
        kind: 'announcement',
        title: `TEST pg merchants ${run}`,
        body: 'TEST',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 600_000).toISOString(),
        audience: 'p2p-merchants',
        clientRequestId: `pg-aud-${run}`,
      });
      expect(draft.audience).toBe('p2p-merchants');
      await b.publish(AUTHOR, { id: draft.id, clientRequestId: `pg-aud-p-${run}`, approvalId: `pg-aud-a-${run}`, operationId: 'o' });
      expect((await b.notices({ limit: 50 })).map((n) => n.id)).not.toContain(draft.id);
      expect((await b.notices({ kind: 'announcement', limit: 50 })).map((n) => n.id)).not.toContain(draft.id);
      await expect(b.notice(draft.id)).rejects.toMatchObject({ code: 'notify.notice_not_found' });
      expect((await b.memberNotices(MERCHANT, { limit: 50 })).map((n) => n.id)).toContain(draft.id);
      expect((await b.memberNotices(AUTHOR, { limit: 50 })).map((n) => n.id)).not.toContain(draft.id);
      await expect(client!`UPDATE notify.notices SET audience = 'everyone' WHERE id = ${draft.id}`).rejects.toThrow(
        /notice_published_immutable/,
      );
    });

    it('the table refuses a member audience on anything but an announcement, and an audience it does not know', async () => {
      const insert = (kind: string, audience: string, key: string) => client!`
        INSERT INTO notify.notices (id, kind, title, body, status, version, audience, author_id, client_request_id)
        VALUES (gen_random_uuid(), ${kind}, 'TEST', 'TEST', 'draft', 1, ${audience}, ${AUTHOR}, ${`pg-aud-${key}-${run}`})
      `;
      await expect(insert('maintenance', 'p2p-merchants', 'm')).rejects.toThrow(/notices_audience_announcement_only/);
      await expect(insert('announcement', 'whales', 'w')).rejects.toThrow(/audience/);
    });
  });
