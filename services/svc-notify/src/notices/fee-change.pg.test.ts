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

/** Fee change notices on the real table: the effective time is held once published, and the table refuses one with an end or none. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const AUTHOR = 'fee0c000-7777-4777-8777-777777777777';
const APPROVER = 'fee0c000-8888-4888-8888-888888888888';

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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify fee-change.pg.test');
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
  describe.skip('fee change notices on Postgres (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('fee change notices on Postgres', () => {
    const run = Date.now().toString(36);
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
      );

    it('stores the effective time with no end, reads it publicly before then, and holds it once published', async () => {
      const b = board();
      const effective = new Date(Date.now() + 3_600_000).toISOString();
      const draft = await b.draft(AUTHOR, {
        kind: 'fee_change',
        title: `TEST pg fee change ${run}`,
        body: 'TEST',
        startsAt: effective,
        clientRequestId: `pg-fee-${run}`,
      });
      // A draft's time may still be corrected; a published one's may not.
      await client!`UPDATE notify.notices SET starts_at = ${effective} WHERE id = ${draft.id}`;
      await b.publish(AUTHOR, { id: draft.id, clientRequestId: `pg-fee-p-${run}`, approvalId: `pg-fee-a-${run}`, operationId: 'o' });
      expect((await b.notices({ limit: 50 })).find((n) => n.id === draft.id)).toMatchObject({ startsAt: effective, endsAt: null });
      await expect(
        client!`UPDATE notify.notices SET starts_at = ${new Date(Date.now() + 7_200_000).toISOString()} WHERE id = ${draft.id}`,
      ).rejects.toThrow(/notice_published_immutable/);
    });

    it('the table refuses a fee change with no effective time or with an end', async () => {
      const insert = (startsAt: string | null, endsAt: string | null, key: string) => client!`
        INSERT INTO notify.notices (id, kind, title, body, status, version, starts_at, ends_at, author_id, client_request_id)
        VALUES (gen_random_uuid(), 'fee_change', 'TEST', 'TEST', 'draft', 1, ${startsAt}, ${endsAt}, ${AUTHOR}, ${`pg-fee-${key}-${run}`})
      `;
      const at = new Date(Date.now() + 3_600_000).toISOString();
      await expect(insert(null, null, 'none')).rejects.toThrow(/notices_fee_change_effective_ck/);
      await expect(insert(at, at, 'end')).rejects.toThrow(/notices_fee_change_effective_ck/);
    });
  });
