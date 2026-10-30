import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, postgresAvailable } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, type ActionApproval } from '@intafaced/contracts';
import { OPS_ALERT_ACCEPT_ACTION, opsAlertAcceptFields } from '@intafaced/contracts/ops-reconciliation-alerts';
import type { ReconciliationEvaluation, ReconciliationEvaluationFeed } from '@intafaced/contracts/ledger-reconciliation';
import { migrateOutreach } from '../db/migrate.js';
import { approvalPayloadHash } from '../operator-desks.js';
import { OpsService } from '../ops-service.js';
import { createOpsRouter } from '../router.js';
import { relayAlertEvents, subscribeRunFailed } from './events.js';
import type { EvaluationFeedPort } from './feed-client.js';
import { ingestReconciliationEvaluations } from './ingest.js';
import { evidenceHash, ReconciliationAlertStore } from './store.js';
import type { CorrectiveTxPort } from './transactions-client.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const CONTROL = '00000000-0000-4000-8000-0000000000c1';
const TX_BOOKED = '7a000000-0000-4000-8000-000000000001';
const TX_UNKNOWN = '7a000000-0000-4000-8000-0000000000ff';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });
const runId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function caller(router: ReturnType<typeof createOpsRouter>, userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write', 'admin:treasury'],
    tier: 'none',
    mfa: true,
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
  status: 'PASS' | 'FAIL' | 'ERROR',
  differences: Record<string, string>,
  error: { code: string; phase: string } | null = null,
): ReconciliationEvaluation {
  return {
    run: {
      id: runId(n),
      controlId: CONTROL,
      status,
      phase: error ? { status: 'set', value: error.phase } : { status: 'unset' },
      errorCode: error ? { status: 'set', value: error.code } : { status: 'unset' },
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

function fakeFeed(rows: ReconciliationEvaluation[]): EvaluationFeedPort {
  return {
    configured: true,
    async read(input) {
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

/** A ledger `transactionsExist` door that knows `booked`, counts its calls, and can be made to fail. */
function fakeLedger(booked: string[]) {
  const state = { calls: 0, down: false };
  const port: CorrectiveTxPort = {
    configured: true,
    async exist(txIds) {
      state.calls += 1;
      if (state.down) return { ok: false, message: 'The ledger did not answer the transaction check.' };
      return { ok: true, found: txIds.filter((id) => booked.includes(id)) };
    },
  };
  return { port, state };
}

/** Identity's approvals as svc-ops sees them: a founder proposes, a founder approves, a consume spends it once. */
function fakeApprovals() {
  let n = 0;
  const rows = new Map<string, { requester: string; approver: string; targetId: string; hash: string }>();
  const spent = new Set<string>();
  return {
    spent,
    propose(requester: string, approver: string, alertId: string, note: string, hash: string) {
      n += 1;
      const fields = opsAlertAcceptFields(alertId, note, hash);
      rows.set(`ap_${n}`, { requester, approver, targetId: fields.targetId, hash: approvalPayloadHash(OPS_ALERT_ACCEPT_ACTION, fields) });
      return { approvalId: `ap_${n}`, operationId: `op_${n}` };
    },
    async consume(input: { approvalId: string; payloadHash: string }): Promise<ActionApproval> {
      const row = rows.get(input.approvalId);
      if (!row || row.hash !== input.payloadHash) throw new Error('action_approval.payload_mismatch');
      if (spent.has(input.approvalId)) throw new Error('action_approval.consumed');
      spent.add(input.approvalId);
      return {
        approvalId: input.approvalId,
        operationId: `op_${input.approvalId.slice(3)}`,
        payloadHash: row.hash,
        targetService: 'svc-ops',
        targetId: row.targetId,
        expectedVersion: '1',
        actionType: OPS_ALERT_ACCEPT_ACTION,
        requesterId: row.requester,
        approverId: row.approver,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'p1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        status: 'CONSUMED',
      };
    },
  };
}

const pg = await postgresAvailable();

if (!pg) {
  describe.skip('reconciliation alert resolve and accept (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('reconciliation alert resolve, accept, reopen and events on real PostgreSQL', () => {
    it('resolves a FAIL only with booked corrective transactions, accepts with two founders, reopens, freezes and auto-resolves', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
      let clock = new Date('2026-10-29T10:01:00.000Z');
      const now = () => clock;
      try {
        await migrateOutreach(sql);
        const ledger = fakeLedger([TX_BOOKED]);
        const approvals = fakeApprovals();
        const store = new ReconciliationAlertStore(sql, { repeatSeconds: 90, now, approvals, correctiveTx: ledger.port });
        const router = createOpsRouter(new OpsService(), undefined, { reconciliationAlerts: store, reconciliationBus: () => 'attached' });
        const a = await caller(router, A);
        const rows: ReconciliationEvaluation[] = [evaluation(1, 'FAIL', { USDC: '5', EUR: '7' })];
        const feed = fakeFeed(rows);
        await ingestReconciliationEvaluations(store, feed);
        const listed = (await a.alerts.list({ after: null, limit: 10 })).alerts;
        const usdc = listed.find((alert) => alert.assetId === 'USDC')!;
        const eur = listed.find((alert) => alert.assetId === 'EUR')!;
        expect([usdc.cause, usdc.team, usdc.resolved, usdc.accepted]).toEqual(['fail', 'finance', null, null]);

        // Fixed needs transactions the ledger booked: an unknown id and a ledger that cannot answer both change nothing.
        await expect(
          a.alerts.resolve({ alertId: usdc.id, correctiveTxIds: [TX_UNKNOWN], idempotencyKey: 'resolve-unknown-01' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.resolve_transaction_not_found') });
        ledger.state.down = true;
        await expect(
          a.alerts.resolve({ alertId: usdc.id, correctiveTxIds: [TX_BOOKED], idempotencyKey: 'resolve-down-0001' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.resolve_ledger_unavailable') });
        expect((await a.alerts.get({ alertId: usdc.id })).alert).toEqual(usdc);
        ledger.state.down = false;

        const fixed = await a.alerts.resolve({
          alertId: usdc.id,
          correctiveTxIds: [TX_BOOKED.toUpperCase(), TX_BOOKED],
          note: '  Booked the missing fee  ',
          idempotencyKey: 'resolve-fixed-0001',
        });
        expect(fixed.alert.state).toBe('resolved');
        expect(fixed.alert.resolved).toMatchObject({
          resolution: 'fixed',
          by: A,
          correctiveTxIds: [TX_BOOKED],
          passingRunId: null,
          note: 'Booked the missing fee',
        });
        expect(fixed.timeline.at(-1)).toMatchObject({ kind: 'resolved', actor: A, txIds: [TX_BOOKED] });
        // The same key answers the stored result without asking the ledger again, even while it is down.
        const callsBefore = ledger.state.calls;
        ledger.state.down = true;
        expect(
          (await a.alerts.resolve({ alertId: usdc.id, correctiveTxIds: [TX_BOOKED], idempotencyKey: 'resolve-fixed-0001' })).alert,
        ).toEqual(fixed.alert);
        expect(ledger.state.calls).toBe(callsBefore);
        ledger.state.down = false;
        // A resolved alert does not resolve again under a new key.
        await expect(
          a.alerts.resolve({ alertId: usdc.id, correctiveTxIds: [TX_BOOKED], idempotencyKey: 'resolve-again-0001' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.alert_state_illegal') });

        // Accept: a blank note refuses before anything is spent; so does evidence that is not the alert's.
        const hash = evidenceHash(eur.evidence);
        const note = 'Rounding at the rail; accepted for this period';
        const proposal = approvals.propose(A, B, eur.id, note, hash);
        await expect(a.alerts.accept({ alertId: eur.id, note: '  ', evidenceHash: hash, ...proposal })).rejects.toMatchObject({
          message: expect.stringContaining('ops.resolve_note_required'),
        });
        await expect(a.alerts.accept({ alertId: eur.id, note, evidenceHash: '0'.repeat(64), ...proposal })).rejects.toMatchObject({
          message: expect.stringContaining('ops.alert_state_illegal'),
        });
        expect(approvals.spent.size).toBe(0);
        // A founder approving their own acceptance is not two founders.
        const self = approvals.propose(A, A, eur.id, note, hash);
        await expect(a.alerts.accept({ alertId: eur.id, note, evidenceHash: hash, ...self })).rejects.toMatchObject({
          message: expect.stringContaining('action_approval.not_founders'),
        });
        expect((await a.alerts.get({ alertId: eur.id })).alert.state).toBe('open');

        // A later run with the same EUR figures (a new run id and read time) counts on the alert and leaves the hash the
        // founders signed valid, so the approval in flight still runs.
        rows.push({ ...evaluation(11, 'FAIL', { EUR: '7' }), finishedAt: '2026-10-29T10:00:01.500011Z' });
        await ingestReconciliationEvaluations(store, feed);
        const counted = await a.alerts.get({ alertId: eur.id });
        expect([counted.alert.occurrences, counted.alert.evidence.run.id]).toEqual([2, runId(11)]);
        expect(evidenceHash(counted.alert.evidence)).toBe(hash);

        const accepted = await a.alerts.accept({ alertId: eur.id, note, evidenceHash: hash, ...proposal });
        expect(accepted.alert.state).toBe('accepted');
        expect(accepted.alert.accepted).toMatchObject({ requestedBy: A, approvedBy: B, note, evidenceHash: hash });
        expect(accepted.timeline.at(-1)).toMatchObject({ kind: 'accepted', actor: A, note });
        // Replaying the same approval answers the stored result.
        expect((await a.alerts.accept({ alertId: eur.id, note, evidenceHash: hash, ...proposal })).alert).toEqual(accepted.alert);
        await expect(
          sql`UPDATE ops.reconciliation_alerts SET occurrences = occurrences + 1, version = version + 1 WHERE id = ${eur.id}`,
        ).rejects.toThrow(/frozen/);

        // The same figures fail again: the fixed USDC alert reopens; the accepted EUR alert stays frozen.
        clock = new Date('2026-10-29T10:05:00.000Z');
        rows.push(evaluation(2, 'FAIL', { USDC: '5', EUR: '7' }));
        await ingestReconciliationEvaluations(store, feed);
        const reopened = await a.alerts.get({ alertId: usdc.id });
        expect([reopened.alert.state, reopened.alert.occurrences, reopened.alert.resolved, reopened.alert.acknowledged]).toEqual([
          'open',
          2,
          null,
          null,
        ]);
        expect(reopened.timeline.map((entry) => entry.kind)).toEqual(['opened', 'resolved', 'reopened']);
        expect((await a.alerts.get({ alertId: eur.id })).alert).toEqual(accepted.alert);

        // Other figures for the accepted asset open a new alert; the accepted one never changes.
        rows.push(evaluation(3, 'FAIL', { EUR: '9' }));
        await ingestReconciliationEvaluations(store, feed);
        const eurAlerts = (await a.alerts.list({ after: null, limit: 10 })).alerts.filter((alert) => alert.assetId === 'EUR');
        expect(eurAlerts.map((alert) => alert.state).sort()).toEqual(['accepted', 'open']);
        const eur2 = eurAlerts.find((alert) => alert.state === 'open')!;
        expect(eur2.evidence.asset?.difference).toBe('9');

        // A passing run of the control and period resolves every live alert on its own, never the accepted one.
        rows.push(evaluation(4, 'PASS', { USDC: '0', EUR: '0' }));
        await ingestReconciliationEvaluations(store, feed);
        for (const id of [usdc.id, eur2.id]) {
          const auto = await a.alerts.get({ alertId: id });
          expect(auto.alert.resolved).toMatchObject({ resolution: 'auto', by: 'auto', correctiveTxIds: [], passingRunId: runId(4) });
          expect(auto.timeline.at(-1)).toMatchObject({ kind: 'resolved', actor: 'auto' });
        }
        expect((await a.alerts.get({ alertId: eur.id })).alert).toEqual(accepted.alert);

        // The accepted figures again, after a newer EUR alert was opened and resolved: nothing changes on either.
        const eur2Resolved = await a.alerts.get({ alertId: eur2.id });
        rows.push({ ...evaluation(12, 'FAIL', { EUR: '7' }), finishedAt: '2026-10-29T10:00:04.500012Z' });
        await ingestReconciliationEvaluations(store, feed);
        expect((await a.alerts.get({ alertId: eur2.id })).alert).toEqual(eur2Resolved.alert);
        expect((await a.alerts.get({ alertId: eur.id })).alert).toEqual(accepted.alert);
        expect((await a.alerts.list({ after: null, limit: 10 })).alerts.filter((alert) => alert.assetId === 'EUR')).toHaveLength(2);

        // An ERROR run goes to the platform team as its own alert, never a finance one; only a passing run resolves it.
        rows.push(evaluation(5, 'ERROR', {}, { code: 'outside_unavailable', phase: 'outside' }));
        await ingestReconciliationEvaluations(store, feed);
        const platform = (await a.alerts.list({ after: null, limit: 10 })).alerts.find((alert) => alert.cause === 'error')!;
        expect([platform.team, platform.assetId, platform.error, platform.state]).toEqual([
          'platform',
          null,
          { code: 'outside_unavailable', phase: 'outside' },
          'open',
        ]);
        await expect(
          a.alerts.resolve({ alertId: platform.id, correctiveTxIds: [TX_BOOKED], idempotencyKey: 'resolve-platform-1' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.alert_state_illegal') });
        rows.push(evaluation(6, 'PASS', { USDC: '0' }));
        await ingestReconciliationEvaluations(store, feed);
        expect((await a.alerts.get({ alertId: platform.id })).alert.resolved).toMatchObject({ resolution: 'auto', passingRunId: runId(6) });

        // Every transition queued one event under its business key, sequence = the alert's version after the change.
        const events = await sql<{ alert_id: string; sequence: number; name: string; idempotency_key: string }[]>`
          SELECT alert_id, sequence, name, idempotency_key FROM ops.reconciliation_alert_events ORDER BY id
        `;
        const of = (id: string) => events.filter((event) => event.alert_id === id).map((event) => [event.sequence, event.name]);
        expect(of(usdc.id)).toEqual([
          [1, 'coreOpsReconciliationAlertOpened'],
          [2, 'coreOpsReconciliationAlertResolved'],
          [3, 'coreOpsReconciliationAlertUpdated'],
          [4, 'coreOpsReconciliationAlertResolved'],
        ]);
        expect(of(eur.id)).toEqual([
          [1, 'coreOpsReconciliationAlertOpened'],
          // Version 2 was the repeat count (run 11), which queues no event.
          [3, 'coreOpsReconciliationAlertAccepted'],
        ]);
        for (const event of events) expect(event.idempotency_key).toBe(`ops:reconciliation-alert:${event.alert_id}:${event.sequence}`);

        // The relay publishes each row once and marks it; a second tick has nothing to send.
        const bus = new MemoryEventBus('svc-ops');
        expect(await relayAlertEvents({ sql, bus, now })).toBe(events.length);
        expect(await relayAlertEvents({ sql, bus, now })).toBe(0);
        expect(bus.published.map((envelope) => envelope.idempotencyKey)).toEqual(events.map((event) => event.idempotency_key));
        const acceptedEnvelope = bus.emitted('coreOpsReconciliationAlertAccepted')[0]!;
        expect(acceptedEnvelope.payload).toMatchObject({ alertId: eur.id, requestedBy: A, approvedBy: B, evidenceHash: hash });
        expect(JSON.stringify(acceptedEnvelope.payload)).not.toContain(note);
        await expect(sql`UPDATE ops.reconciliation_alert_events SET published_at = now()`).rejects.toThrow(/never edited/);
        await expect(sql`DELETE FROM ops.reconciliation_alert_events`).rejects.toThrow(/never deleted/);

        // A ledger run that could not finish is one platform incident, however often the bus delivers it.
        await subscribeRunFailed({ sql, bus, now });
        const failed = { errorCode: 'reconcile_db_unavailable', phase: 'snapshot' as const, consecutiveIncomplete: 2, runId: null };
        await bus.publish('ledgerReconciliationRunFailed', failed, { idempotencyKey: 'ledger:reconcile-run-failed:t-1' });
        await bus.publish('ledgerReconciliationRunFailed', failed, { idempotencyKey: 'ledger:reconcile-run-failed:t-1' });
        const incidents = await a.alerts.platformIncidents({ limit: 10 });
        expect(incidents.bus).toBe('attached');
        expect(incidents.incidents).toEqual([
          expect.objectContaining({
            eventKey: 'ledger:reconcile-run-failed:t-1',
            team: 'platform',
            errorCode: 'reconcile_db_unavailable',
            phase: 'snapshot',
            consecutiveIncomplete: 2,
          }),
        ]);
      } finally {
        await sql.end();
        await database.drop();
      }
    });

    it('refuses a fix while the ledger door is not wired, with nothing changed', async () => {
      const database = await createTestDatabase({ service: 'ops' });
      const sql = postgres(database.url, { max: 4, onnotice: () => undefined });
      try {
        await migrateOutreach(sql);
        const store = new ReconciliationAlertStore(sql, { repeatSeconds: 90, now: () => new Date('2026-10-29T10:01:00.000Z') });
        const router = createOpsRouter(new OpsService(), undefined, { reconciliationAlerts: store });
        const a = await caller(router, A);
        await ingestReconciliationEvaluations(store, fakeFeed([evaluation(1, 'FAIL', { USDC: '5' })]));
        const [usdc] = (await a.alerts.list({ after: null, limit: 10 })).alerts;
        await expect(
          a.alerts.resolve({ alertId: usdc!.id, correctiveTxIds: [TX_BOOKED], idempotencyKey: 'resolve-unwired-1' }),
        ).rejects.toMatchObject({ message: expect.stringContaining('ops.resolve_ledger_unavailable') });
        expect((await a.alerts.get({ alertId: usdc!.id })).alert.state).toBe('open');
        expect((await a.alerts.platformIncidents({ limit: 10 })).bus).toBe('detached');
      } finally {
        await sql.end();
        await database.drop();
      }
    });
  });
}
