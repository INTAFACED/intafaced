import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, postgresAvailable } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ReconciliationEvaluation, ReconciliationEvaluationFeed } from '@intafaced/contracts/ledger-reconciliation';
import { migrateOutreach } from '../db/migrate.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import type { EvaluationFeedPort, EvaluationFeedRead } from './feed-client.js';
import { ingestReconciliationEvaluations } from './ingest.js';
import { ReconciliationAlertStore } from './store.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const CONTROL = '00000000-0000-4000-8000-0000000000c1';
const PASSING = '00000000-0000-4000-8000-0000000000c2';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function caller(router: ReturnType<typeof createOpsRouter>, userId: string, mfa = true) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return router.createCaller(
    await edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-signed',
    }),
  );
}

function evaluation(
  n: number,
  control: string,
  status: 'PASS' | 'FAIL' | 'ERROR' | 'UNSET',
  differences: Record<string, string>,
): ReconciliationEvaluation {
  return {
    run: {
      id: runId(n),
      controlId: control,
      status,
      phase: { status: 'unset' },
      errorCode: { status: 'unset' },
      asOf: '2026-10-29T10:00:00.000Z',
      readAt: '2026-10-29T10:00:00.000Z',
      margin: { status: 'unset' },
      sources: { ledger: { asOf: '2026-10-29T10:00:00.000Z' }, outside: { asOf: 'unset' }, parity: { asOf: 'unset' } },
      outsideSide: 'not_applicable',
      periodStart: '2026-10-29T00:00:00.000Z',
      periodEnd: '2026-10-30T00:00:00.000Z',
      assets: Object.entries(differences).map(([assetId, difference]) => ({
        assetId,
        observed: difference,
        expected: '0',
        difference,
        tolerance: '0',
      })),
    },
    finishedAt: `2026-10-29T10:00:${String(n).padStart(2, '0')}.000${String(n).padStart(3, '0')}Z`,
    severity: { status: 'set', value: 'critical' },
  };
}

/** A fake ledger door that serves `rows` after the cursor asked, as the real one does. */
function fakeFeed(rows: ReconciliationEvaluation[], fail: { message: string | null } = { message: null }): EvaluationFeedPort {
  return {
    configured: true,
    async read(input): Promise<EvaluationFeedRead> {
      if (fail.message) return { ok: false, message: fail.message };
      const key = (e: ReconciliationEvaluation) => `${e.finishedAt}|${e.run.id}`;
      const from = input.after ? `${input.after.finishedAt}|${input.after.id}` : '';
      const evaluations = rows.filter((e) => key(e) > from).slice(0, input.limit);
      const last = evaluations.at(-1);
      const value: ReconciliationEvaluationFeed = {
        evaluations,
        next: last ? { finishedAt: last.finishedAt, id: last.run.id } : input.after,
      };
      return { ok: true, value };
    },
  };
}

const pg = await postgresAvailable();

if (!pg) {
  describe.skip('reconciliation alerts (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('reconciliation alerts on real PostgreSQL', () => {
    it('opens one alert per failing asset, counts repeats once, races an acknowledgement, snoozes and keeps periods red', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
      let clock = new Date('2026-10-29T10:01:00.000Z');
      try {
        await migrateOutreach(sql);
        const store = new ReconciliationAlertStore(sql, { repeatSeconds: 90, now: () => clock });
        const router = createOpsRouter(new OpsService(), undefined, { reconciliationAlerts: store });
        const a = await caller(router, A);
        const b = await caller(router, B);
        const rows: ReconciliationEvaluation[] = [];
        const fail = { message: null as string | null };
        const feed = fakeFeed(rows, fail);

        // Before any read the source says so; never an empty list that looks like "nothing failed".
        expect((await a.alerts.list({ after: null, limit: 10 })).source).toEqual({ status: 'never_read' });

        // A failed read names its code, keeps the cursor, and the list shows it.
        fail.message = 'The ledger refused the evaluation read (403).';
        await ingestReconciliationEvaluations(store, feed);
        const down = await a.alerts.list({ after: null, limit: 10 });
        expect(down.source).toMatchObject({
          status: 'unavailable',
          code: 'ops.alert_source_unavailable',
          message: fail.message,
          lastOkAt: null,
        });
        fail.message = null;

        rows.push(evaluation(1, CONTROL, 'FAIL', { USDC: '5', EUR: '7', BTC: '0' }), evaluation(2, PASSING, 'PASS', { USDC: '0' }));
        expect(await ingestReconciliationEvaluations(store, feed)).toBe(2);
        // Read again from the start: run ids already taken change nothing.
        await sql`UPDATE ops.reconciliation_feed SET cursor_finished_at = NULL, cursor_run_id = NULL`;
        expect(await ingestReconciliationEvaluations(store, feed)).toBe(0);

        const first = await a.alerts.list({ after: null, limit: 10 });
        expect(first.source).toMatchObject({ status: 'ok' });
        expect(first.alerts.map((alert) => alert.assetId).sort()).toEqual(['EUR', 'USDC']);
        const usdc = first.alerts.find((alert) => alert.assetId === 'USDC')!;
        expect(usdc).toMatchObject({
          state: 'open',
          controlId: CONTROL,
          occurrences: 1,
          severity: { status: 'set', value: 'critical' },
          firstSeen: '2026-10-29T10:00:01.000Z',
          evidence: { finishedAt: '2026-10-29T10:00:01.000001Z', asset: { assetId: 'USDC', difference: '5' } },
          notices: {
            sent: 1,
            lastSentAt: clock.toISOString(),
            repeat: { status: 'set', seconds: 90, nextDueAt: '2026-10-29T10:02:30.000Z' },
          },
        });

        // Paging walks every alert exactly once.
        const p1 = await a.alerts.list({ after: null, limit: 1 });
        const p2 = await a.alerts.list({ after: p1.next, limit: 1 });
        expect(p2.next).toBeNull();
        expect([...p1.alerts, ...p2.alerts].map((alert) => alert.id).sort()).toEqual(first.alerts.map((alert) => alert.id).sort());

        // A second failure inside the interval counts on the same alert and is not due to notify.
        clock = new Date('2026-10-29T10:01:30.000Z');
        rows.push(evaluation(3, CONTROL, 'FAIL', { USDC: '6' }));
        await ingestReconciliationEvaluations(store, feed);
        let detail = await a.alerts.get({ alertId: usdc.id });
        expect(detail.alert).toMatchObject({ occurrences: 2, lastSeen: '2026-10-29T10:00:03.000Z', notices: { sent: 1 } });
        expect(detail.timeline.map((entry) => [entry.kind, entry.notice, entry.runId])).toEqual([
          ['opened', 'sent', runId(1)],
          ['repeated', 'not_due', runId(3)],
        ]);
        expect((await a.alerts.list({ after: null, limit: 10 })).alerts).toHaveLength(2);

        // Acknowledge needs a note, and refuses with the alert unchanged.
        await expect(a.alerts.acknowledge({ alertId: usdc.id, note: '   ', idempotencyKey: 'ack-blank-0001' })).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: expect.stringContaining('ops.alert_note_required'),
        });
        expect((await a.alerts.get({ alertId: usdc.id })).alert).toEqual(detail.alert);

        // Two founders at once: exactly one wins, the other is refused and the stored owner and note are the winner's.
        const race = await Promise.allSettled([
          a.alerts.acknowledge({ alertId: usdc.id, note: 'A looks', idempotencyKey: 'ack-a-000001' }),
          b.alerts.acknowledge({ alertId: usdc.id, note: 'B looks', idempotencyKey: 'ack-b-000001' }),
        ]);
        const won = race.filter((r) => r.status === 'fulfilled');
        const lost = race.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0]!.reason).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('ops.alert_state_illegal') });
        detail = await a.alerts.get({ alertId: usdc.id });
        const winner = detail.alert.acknowledged!;
        expect([
          { by: A, note: 'A looks' },
          { by: B, note: 'B looks' },
        ]).toContainEqual({ by: winner.by, note: winner.note });
        expect(lost[0]!.reason.message).toContain(winner.by);
        expect(detail.alert.state).toBe('acknowledged');
        // The winner's retry answers the stored result; the key on another action is a conflict.
        const winnerCaller = winner.by === A ? a : b;
        const winnerKey = winner.by === A ? 'ack-a-000001' : 'ack-b-000001';
        expect(
          (await winnerCaller.alerts.acknowledge({ alertId: usdc.id, note: 'again', idempotencyKey: winnerKey })).alert.acknowledged,
        ).toEqual(winner);
        await expect(winnerCaller.alerts.unsnooze({ alertId: usdc.id, idempotencyKey: winnerKey })).rejects.toMatchObject({
          code: 'CONFLICT',
        });
        expect(detail.timeline.filter((entry) => entry.kind === 'acknowledged')).toHaveLength(1);

        // Without a second factor a write is forbidden.
        const noMfa = await caller(router, A, false);
        await expect(
          noMfa.alerts.snooze({ alertId: usdc.id, endsAt: '2026-10-29T12:00:00.000Z', idempotencyKey: 'snz-nomfa-01' }),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });

        // Acknowledged is not green: the period still counts the alert.
        let periods = await a.alerts.periods({ limit: 10 });
        expect(periods.periods.find((p) => p.controlId === CONTROL)).toMatchObject({
          evaluations: 2,
          open: 1,
          acknowledged: 1,
          green: false,
          lastStatus: 'FAIL',
        });
        expect(periods.periods.find((p) => p.controlId === PASSING)).toMatchObject({
          evaluations: 1,
          open: 0,
          acknowledged: 0,
          green: true,
          lastStatus: 'PASS',
        });

        // A snooze that ends in the past is refused; a valid one mutes the next due notice but still counts.
        await expect(
          a.alerts.snooze({ alertId: usdc.id, endsAt: '2026-10-29T10:00:00.000Z', idempotencyKey: 'snz-past-001' }),
        ).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_snooze_end_invalid'),
        });
        const first_snooze = await a.alerts.snooze({
          alertId: usdc.id,
          endsAt: '2026-10-29T11:00:00.000Z',
          reason: 'fix running',
          idempotencyKey: 'snz-0000001',
        });
        expect(first_snooze.alert.snooze).toMatchObject({
          by: A,
          reason: 'fix running',
          endsAt: '2026-10-29T11:00:00.000Z',
          expiredAt: null,
        });
        const second_snooze = await a.alerts.snooze({
          alertId: usdc.id,
          endsAt: '2026-10-29T12:00:00.000Z',
          idempotencyKey: 'snz-0000002',
        });
        expect(second_snooze.snoozes.map((s) => [s.endsAt, s.expiredAt === null])).toEqual([
          ['2026-10-29T12:00:00.000Z', true],
          ['2026-10-29T11:00:00.000Z', false],
        ]);
        clock = new Date('2026-10-29T10:03:00.000Z');
        rows.push(evaluation(4, CONTROL, 'FAIL', { USDC: '6' }));
        await ingestReconciliationEvaluations(store, feed);
        detail = await a.alerts.get({ alertId: usdc.id });
        expect(detail.alert).toMatchObject({ occurrences: 3, notices: { sent: 1 } });
        expect(detail.timeline.at(-1)).toMatchObject({ kind: 'repeated', notice: 'snoozed', runId: runId(4) });

        // Lifting the snooze, then lifting again, changes nothing the second time; the next due failure notifies.
        await a.alerts.unsnooze({ alertId: usdc.id, idempotencyKey: 'unsnz-000001' });
        const again = await a.alerts.unsnooze({ alertId: usdc.id, idempotencyKey: 'unsnz-000002' });
        expect(again.alert.snooze).toBeNull();
        expect(again.timeline.filter((entry) => entry.kind === 'unsnoozed')).toHaveLength(1);
        clock = new Date('2026-10-29T10:04:00.000Z');
        rows.push(evaluation(5, CONTROL, 'FAIL', { USDC: '6' }));
        await ingestReconciliationEvaluations(store, feed);
        detail = await a.alerts.get({ alertId: usdc.id });
        expect(detail.alert).toMatchObject({ occurrences: 4, notices: { sent: 2, lastSentAt: clock.toISOString() } });

        // A FAIL with no asset evidence (a broken chain) opens an alert with no asset.
        rows.push(evaluation(6, PASSING, 'FAIL', {}));
        await ingestReconciliationEvaluations(store, feed);
        const chain = (await a.alerts.list({ after: null, limit: 10 })).alerts.find((alert) => alert.controlId === PASSING)!;
        expect(chain).toMatchObject({ assetId: null, evidence: { asset: null } });
        periods = await a.alerts.periods({ controlId: PASSING, limit: 10 });
        expect(periods.periods).toEqual([expect.objectContaining({ green: false, open: 1, evaluations: 2 })]);

        // The timeline is append-only; a snooze is never rewritten; an alert keeps its fingerprint.
        await expect(sql`UPDATE ops.reconciliation_alert_timeline SET note = 'x'`).rejects.toThrow(/append-only/);
        await expect(sql`DELETE FROM ops.reconciliation_alert_timeline`).rejects.toThrow(/append-only/);
        await expect(sql`UPDATE ops.reconciliation_alert_snoozes SET reason = 'x'`).rejects.toThrow(/never edited/);
        await expect(sql`UPDATE ops.reconciliation_alerts SET asset_id = 'X', version = version + 1`).rejects.toThrow(/fingerprint/);
        await expect(
          sql`UPDATE ops.reconciliation_alerts SET ack_note = 'rewritten', version = version + 1 WHERE ack_by IS NOT NULL`,
        ).rejects.toThrow(/never rewritten/);

        await expect(a.alerts.get({ alertId: runId(777) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        await sql.end();
        await database.drop();
      }
    });
    it('never shows an ERROR or UNSET period green, and records a run it cannot store as the source failing', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      try {
        await migrateOutreach(sql);
        const store = new ReconciliationAlertStore(sql, { repeatSeconds: 90, now: () => new Date('2026-10-29T10:01:00.000Z') });
        const router = createOpsRouter(new OpsService(), undefined, { reconciliationAlerts: store });
        const a = await caller(router, A);
        const rows = [evaluation(1, CONTROL, 'ERROR', {}), evaluation(2, PASSING, 'UNSET', {})];
        expect(await ingestReconciliationEvaluations(store, fakeFeed(rows))).toBe(2);
        const periods = await a.alerts.periods({ limit: 10 });
        expect(periods.periods.map((p) => [p.controlId, p.lastStatus, p.open, p.green]).sort()).toEqual([
          [CONTROL, 'ERROR', 0, false],
          [PASSING, 'UNSET', 0, false],
        ]);

        // A store failure holds the cursor and shows as the source failing, never as a healthy empty list.
        const failing = Object.create(store) as ReconciliationAlertStore;
        failing.ingest = async (evaluation) => {
          if (evaluation.run.id === runId(3)) throw new Error('disk full');
          return store.ingest(evaluation);
        };
        rows.push(evaluation(3, CONTROL, 'FAIL', { USDC: '5' }));
        expect(await ingestReconciliationEvaluations(failing, fakeFeed(rows))).toBe(0);
        const down = await a.alerts.list({ after: null, limit: 10 });
        expect(down.source).toMatchObject({
          status: 'unavailable',
          code: 'ops.alert_source_unavailable',
          message: `svc-ops could not store evaluation ${runId(3)}. It reads it again on the next tick.`,
        });
        expect(down.alerts).toEqual([]);
        // The next healthy tick reads the same run again and opens its alert.
        expect(await ingestReconciliationEvaluations(store, fakeFeed(rows))).toBe(1);
        const up = await a.alerts.list({ after: null, limit: 10 });
        expect(up.source).toMatchObject({ status: 'ok' });
        expect(up.alerts.map((alert) => alert.assetId)).toEqual(['USDC']);

        // A run whose commit landed behind the cursor (finished before the last one read) is still taken, once, by the
        // overlap, and the cursor never moves back.
        const cursorBefore = await store.cursor();
        rows.push({ ...evaluation(4, CONTROL, 'FAIL', { EUR: '3' }), finishedAt: '2026-10-29T10:00:02.500000Z' });
        expect(await ingestReconciliationEvaluations(store, fakeFeed(rows))).toBe(1);
        expect(await ingestReconciliationEvaluations(store, fakeFeed(rows))).toBe(0);
        expect(await store.cursor()).toEqual(cursorBefore);
        expect((await a.alerts.list({ after: null, limit: 10 })).alerts.map((alert) => alert.assetId).sort()).toEqual(['EUR', 'USDC']);
      } finally {
        await sql.end();
        await database.drop();
      }
    });
  });
}
