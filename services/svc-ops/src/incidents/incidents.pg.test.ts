import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  INCIDENT_ALREADY_RESOLVED,
  INCIDENT_ASSIGNEE_NOT_PARTICIPANT,
  INCIDENT_NOT_FOUND,
  INCIDENT_REQUEST_KEY_REUSED,
  declaredSeverity,
  parseIncidentSeverities,
} from '@intafaced/contracts';
import { createTestDatabase } from '@intafaced/db';
import { migrateOutreach } from '../db/migrate.js';
import { SqlIncidentStore } from './store.js';

/**
 * Staff incidents on real PostgreSQL (OPS-oncall-02, J-ops-console-19 #10): pending when no severity is given; a private
 * incident is not-found, unlisted and uncounted for a non-participant; a note under one key twice is one; a task for a
 * non-participant refuses; resolving stores the end time and the mean time to resolve comes from the stored times; with no
 * incidents the metrics are empty.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const codeOf = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

describe('staff incidents on real PostgreSQL', () => {
  it('declares, keeps a timeline, guards private incidents and tasks, resolves once and measures from stored times', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const store = new SqlIncidentStore(sql);

      // No incidents: every metric is empty, nothing is a sample figure.
      expect(await store.metrics(A, '2026-11-07T08:00:00.000Z')).toEqual({
        byStatus: [],
        bySeverity: [],
        resolvedCount: 0,
        meanSecondsToResolve: null,
        asOf: '2026-11-07T08:00:00.000Z',
      });

      // No severity is pending; the declare under the same key is the same incident.
      const values = { requestKey: 'console:declare:pg-1', title: 'TEST ledger lag', module: 'ledger' as const, private: false };
      const first = await store.declare({ ...values, severity: 'pending' }, A, '2026-11-07T08:00:00.000Z');
      expect(first.incident).toMatchObject({ severity: 'pending', status: 'active', module: 'ledger', endedAt: null });
      expect(first.participants.map((p) => p.userId)).toEqual([A]);
      const again = await store.declare({ ...values, severity: 'pending' }, A, '2026-11-07T08:00:05.000Z');
      expect(again.incident.id).toBe(first.incident.id);
      expect(await codeOf(store.declare({ ...values, title: 'another', severity: 'pending' }, A, '2026-11-07T08:00:06.000Z'))).toBe(
        INCIDENT_REQUEST_KEY_REUSED,
      );
      expect(declaredSeverity(undefined, null)).toEqual({ ok: true, severity: 'pending' });
      expect(declaredSeverity('major', null)).toEqual({ ok: false, code: 'ops.incident_severities_unset' });
      expect(declaredSeverity('apocalyptic', ['critical', 'major'])).toEqual({ ok: false, code: 'ops.severity_unknown' });
      expect(declaredSeverity('major', ['critical', 'major'])).toEqual({ ok: true, severity: 'major' });
      expect(parseIncidentSeverities('')).toBeNull();
      expect(parseIncidentSeverities('critical, major')).toEqual(['critical', 'major']);
      expect(() => parseIncidentSeverities('critical,pending')).toThrow();
      expect(() => parseIncidentSeverities('Major')).toThrow();
      const id = first.incident.id;

      // A timeline note added twice under one key is one note.
      await store.change(A, id, 'console:note:pg-1', { kind: 'note', body: 'TEST: lag seen on replica' }, '2026-11-07T08:01:00.000Z');
      const noted = await store.change(
        A,
        id,
        'console:note:pg-1',
        { kind: 'note', body: 'TEST: lag seen on replica' },
        '2026-11-07T08:01:30.000Z',
      );
      expect(noted.timeline.filter((t) => t.kind === 'note')).toHaveLength(1);

      // A task for someone who does not take part refuses; once invited they can be given it.
      expect(
        await codeOf(
          store.change(
            A,
            id,
            'console:task:pg-1',
            { kind: 'task', title: 'TEST check replica', assigneeId: B },
            '2026-11-07T08:02:00.000Z',
          ),
        ),
      ).toBe(INCIDENT_ASSIGNEE_NOT_PARTICIPANT);
      await store.change(A, id, 'console:invite:pg-1', { kind: 'participant', userId: B }, '2026-11-07T08:02:10.000Z');
      const tasked = await store.change(
        A,
        id,
        'console:task:pg-2',
        { kind: 'task', title: 'TEST check replica', assigneeId: B },
        '2026-11-07T08:02:20.000Z',
      );
      expect(tasked.tasks).toMatchObject([{ assigneeId: B, status: 'open' }]);

      // Resolving stores the end time from the call; a second resolve under a new key refuses.
      const resolved = await store.change(A, id, 'console:resolve:pg-1', { kind: 'resolved' }, '2026-11-07T08:10:00.000Z');
      expect(resolved.incident).toMatchObject({ status: 'resolved', endedAt: '2026-11-07T08:10:00.000Z' });
      expect(await codeOf(store.change(A, id, 'console:resolve:pg-2', { kind: 'resolved' }, '2026-11-07T08:11:00.000Z'))).toBe(
        INCIDENT_ALREADY_RESOLVED,
      );

      // A private incident: its participants see it; anyone else gets not-found, never sees it listed or counted.
      const secret = await store.declare(
        { requestKey: 'console:declare:pg-2', title: 'TEST legal matter', module: null, severity: 'major', private: true },
        B,
        '2026-11-07T08:20:00.000Z',
      );
      expect(await store.get(C, secret.incident.id, '2026-11-07T08:21:00.000Z')).toBeNull();
      expect(
        await codeOf(store.change(C, secret.incident.id, 'console:note:pg-2', { kind: 'note', body: 'x' }, '2026-11-07T08:21:00.000Z')),
      ).toBe(INCIDENT_NOT_FOUND);
      expect((await store.list(C, { limit: 50 })).map((i) => i.id)).toEqual([id]);
      expect((await store.list(B, { limit: 50 })).map((i) => i.id)).toEqual([secret.incident.id, id]);
      expect(await store.get(B, secret.incident.id, '2026-11-07T08:21:00.000Z')).not.toBeNull();

      // The mean time to resolve uses the stored start and end: 10 minutes.
      const forC = await store.metrics(C, '2026-11-07T08:30:00.000Z');
      expect(forC).toMatchObject({ byStatus: [{ status: 'resolved', count: 1 }], resolvedCount: 1, meanSecondsToResolve: 600 });
      expect(forC.bySeverity).toEqual([{ severity: 'pending', count: 1 }]);
      const forB = await store.metrics(B, '2026-11-07T08:30:00.000Z');
      expect(forB.byStatus).toEqual([
        { status: 'active', count: 1 },
        { status: 'resolved', count: 1 },
      ]);

      // The timeline is append-only.
      expect(await codeOf(sql`DELETE FROM ops.incident_timeline WHERE incident_id = ${id}`)).not.toBeNull();
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
