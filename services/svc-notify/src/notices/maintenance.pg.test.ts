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
import { MaintenanceLifecycle, moveVerdict, maintenanceState } from './maintenance.js';
import { SqlMaintenanceStore } from './maintenance.pg.js';

/** The maintenance lifecycle on the real tables: offsets stored, moves decided one at a time, reminders taken once. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const AUTHOR = 'de5c0000-3333-4333-8333-333333333333';
const APPROVER = 'de5c0000-4444-4444-8444-444444444444';

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
  await sql`DELETE FROM notify.maintenance_reminders WHERE notice_id IN (${mine})`;
  await sql`DELETE FROM notify.maintenance_moves WHERE notice_id IN (${mine})`;
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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify maintenance.pg.test');
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
  describe.skip('maintenance lifecycle on Postgres (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('maintenance lifecycle on Postgres', () => {
    const run = Date.now().toString(36);
    let n = 0;
    const T0 = Date.now();
    const clock = { at: T0 };
    const now = () => new Date(clock.at);
    const store = () => new SqlMaintenanceStore(client!);
    const board = () =>
      new NoticeBoard(
        new PostgresNoticeStore(client!),
        new Approvals(),
        new PostgresCommandLog(client!),
        now,
        async () => [],
        async () => undefined,
        (ids) => store().closedAmong(ids),
      );
    const publish = async (startInMinutes: number, reminderOffsets: number[] = []) => {
      n += 1;
      const b = board();
      const draft = await b.draft(AUTHOR, {
        kind: 'maintenance',
        title: `TEST pg maintenance ${run}-${n}`,
        body: 'TEST',
        startsAt: new Date(T0 + startInMinutes * 60_000).toISOString(),
        endsAt: new Date(T0 + (startInMinutes + 60) * 60_000).toISOString(),
        reminderOffsets,
        clientRequestId: `pg-m-${run}-${n}`,
      });
      return b.publish(AUTHOR, {
        id: draft.id,
        clientRequestId: `pg-mp-${run}-${n}`,
        approvalId: `pg-ma-${run}-${n}`,
        operationId: `o-${n}`,
      });
    };

    it('stores the offsets with the notice, and lists moves and a closed window', async () => {
      const window = await publish(-5, [15, 5]);
      expect((await board().maintenanceNotice(window.id))?.reminderOffsets).toEqual([15, 5]);
      // What the approval bound stays as published: the offsets are held by the published-row trigger too.
      await expect(client!`UPDATE notify.notices SET reminder_offsets = '{1}' WHERE id = ${window.id}`).rejects.toThrow(
        /notice_published_immutable/,
      );
      const s = store();
      const move = (state: 'verifying' | 'completed') => ({
        noticeId: window.id,
        state,
        movedBy: AUTHOR,
        reason: 'TEST',
        movedAt: new Date(),
      });
      const rule = (state: 'verifying' | 'completed') => (moves: readonly { state: string }[]) =>
        moveVerdict(maintenanceState({ startsAt: new Date(T0 - 300_000) }, moves as never, new Date()), state);
      expect(await s.applyMove(move('completed'), rule('completed'))).toBe('status.maintenance_illegal_move');
      expect((await s.applyMove(move('verifying'), rule('verifying'))) as unknown[]).toHaveLength(1);
      expect((await s.applyMove(move('completed'), rule('completed'))) as unknown[]).toHaveLength(2);
      expect([...(await s.closedAmong([window.id]))]).toEqual([window.id]);
      expect((await s.closedAmong([])).size).toBe(0);
      expect((await s.movesOf([window.id])).map((m) => m.state)).toEqual(['verifying', 'completed']);
      expect((await board().noticeStatus()).maintenance.some((m) => m.id === window.id)).toBe(false);
    });

    it('two moves at once on one window: one is decided after the other, so cancel and verify cannot both land', async () => {
      const window = await publish(-5);
      const lifecycle = new MaintenanceLifecycle({
        store: store(),
        notice: (id) => board().maintenanceNotice(id),
        upcoming: (at, limit) => board().upcomingMaintenance(at, limit),
        remind: async () => ({ undelivered: 0 }),
        now,
      });
      const outcomes = await Promise.allSettled([
        lifecycle.move(AUTHOR, { id: window.id, to: 'verifying', reason: 'TEST' }),
        lifecycle.move(APPROVER, { id: window.id, to: 'cancelled', reason: 'TEST' }),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect((await store().moves(window.id)).length).toBe(1);
    });

    it('reminder rows are made once per offset and taken by one sweep at a time', async () => {
      const window = await publish(60, [30, 10]);
      const reminded: number[] = [];
      const lifecycle = () =>
        new MaintenanceLifecycle({
          store: store(),
          notice: (id) => board().maintenanceNotice(id),
          upcoming: (at, limit) => board().upcomingMaintenance(at, limit),
          remind: async (notice, offset) => {
            if (notice.id === window.id) reminded.push(offset);
            return { undelivered: 0 };
          },
          now,
        });
      await lifecycle().sweep();
      await lifecycle().sweep();
      expect((await store().remindersOf([window.id])).map((r) => r.offsetMinutes).sort()).toEqual([10, 30]);
      clock.at = T0 + 31 * 60_000;
      await Promise.all([lifecycle().sweep(), lifecycle().sweep(), lifecycle().sweep()]);
      expect(reminded).toEqual([30]);
      clock.at = T0 + 51 * 60_000;
      await Promise.all([lifecycle().sweep(), lifecycle().sweep()]);
      expect(reminded).toEqual([30, 10]);
      const rows = await store().remindersOf([window.id]);
      expect(rows.every((r) => r.sentAt !== null && r.skipped === null)).toBe(true);
      clock.at = T0;
    });

    it('an offset already past at publish is stored late in the same insert as the ones still to come', async () => {
      const window = await publish(20, [60, 10]);
      await new MaintenanceLifecycle({
        store: store(),
        notice: (id) => board().maintenanceNotice(id),
        upcoming: (at, limit) => board().upcomingMaintenance(at, limit),
        remind: async () => ({ undelivered: 0 }),
        now,
      }).sweep();
      const rows = await store().remindersOf([window.id]);
      expect(rows.map((r) => [r.offsetMinutes, r.skipped]).sort()).toEqual([
        [10, null],
        [60, 'published_late'],
      ]);
    });
  });
