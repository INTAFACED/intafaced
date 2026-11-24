import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createTestDatabase } from '@intafaced/db';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { opsReversalApprovalFields, opsReversalTargetId } from '@intafaced/contracts/ops-ledger-reversals';
import { migrateOutreach } from '../db/migrate.js';
import { approvalPayloadHash } from '../operator-desks.js';
import { LedgerReversalDesk } from './desk.js';
import type { ReversalLedger, ReverseOutcome } from './ledger.js';
import { SqlReversalStore } from './store.js';

/**
 * Operator reversals on real PostgreSQL (money path, so PG-hard: CI sets TEST_DATABASE_URL and this file never skips). The
 * row lock keeps one approval per request, the per-original lock gives each request the next ordinal, the partial index
 * keeps one posted reversal per original, and the trigger keeps a request as it was asked and a settled one as answered.
 */

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ask = { originalTxId: ORIGINAL, reason: 'LOCAL TEST posted to the wrong account', caseRef: 'CASE-7' };

function identity() {
  const rows = new Map<string, { requestNo: string; hash: string; spent: boolean }>();
  let n = 0;
  return {
    propose(requestNo: string, caseRef = ask.caseRef) {
      n += 1;
      const hash = approvalPayloadHash(
        'ops.ledger.reverse',
        opsReversalApprovalFields({ requestNo, originalTxId: ORIGINAL, reason: ask.reason, caseRef }),
      );
      rows.set(`ap_${n}`, { requestNo, hash, spent: false });
      return { approvalId: `ap_${n}`, operationId: `op_${n}` };
    },
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const row = rows.get(input.approvalId);
      if (!row || row.hash !== input.payloadHash) throw new Error('action_approval.payload_mismatch');
      if (row.spent) throw new Error('action_approval.consumed');
      row.spent = true;
      return {
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: row.hash,
        targetService: 'svc-ops',
        targetId: opsReversalTargetId(row.requestNo),
        expectedVersion: '1',
        actionType: 'ops.ledger.reverse',
        requesterId: FOUNDER,
        approverId: APPROVER,
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        status: 'CONSUMED',
      };
    },
  };
}

/**
 * svc-ledger's door as `reversal.rs` answers: one booking per key, one reversal per original. `lose` loses the next reply.
 * `together`: no send books until that many have arrived, so concurrent sends are really in flight at once.
 */
function book(together = 1) {
  const byKey = new Map<string, string>();
  const first = new Map<string, string>();
  const sent: string[] = [];
  let lose = 0;
  let arrived = 0;
  let release: () => void = () => undefined;
  const allIn = new Promise<void>((resolve) => (release = resolve));
  const ledger: ReversalLedger = {
    async reverse(call, key): Promise<ReverseOutcome> {
      sent.push(key);
      arrived += 1;
      if (arrived >= together) release();
      await allIn;
      const winner = first.get(call.originalTxId);
      if (winner && winner !== key) return { kind: 'refused', code: 'ledger.reversal_already_reversed', reversedBy: byKey.get(winner)! };
      if (!byKey.has(key)) {
        byKey.set(key, `bbbbbbbb-bbbb-4bbb-8bbb-${String(byKey.size + 1).padStart(12, '0')}`);
        first.set(call.originalTxId, key);
      }
      if (lose > 0) {
        lose -= 1;
        return { kind: 'retry', code: 'ledger.reply_lost' };
      }
      return { kind: 'posted', txId: byKey.get(key)! };
    },
  };
  return { ledger, sent, bookings: () => byKey.size, loseNext: () => (lose += 1) };
}

describe('operator reversals on real PostgreSQL', () => {
  it('intent first; approved, one reversal posts once even after a lost reply; a second is refused by name', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const ids = identity();
      const ledger = book();
      const desk = new LedgerReversalDesk({
        store: new SqlReversalStore(sql),
        ledger: ledger.ledger,
        approvals: ids,
        now: () => new Date(),
      });

      const intent = await desk.request(FOUNDER, ask);
      expect(intent).toMatchObject({ requestNo: '1', ordinal: '1', state: 'intent', ledgerKey: `ops:reversal:${ORIGINAL}:1` });
      expect(ledger.sent).toHaveLength(0);
      const [stored] = await sql`SELECT state, approval_id, attempts FROM ops.ledger_reversals WHERE request_no = 1`;
      expect(stored).toEqual({ state: 'intent', approval_id: null, attempts: 0 });

      const approval = ids.propose('1');
      ledger.loseNext();
      expect(await desk.execute(FOUNDER, { requestNo: '1', ...approval })).toMatchObject({
        state: 'pending_retry',
        code: 'ledger.reply_lost',
      });
      const posted = await desk.execute(FOUNDER, { requestNo: '1', ...approval });
      expect(posted).toMatchObject({ state: 'posted', attempts: 2, approverId: APPROVER });
      expect(ledger.sent).toEqual([`ops:reversal:${ORIGINAL}:1`, `ops:reversal:${ORIGINAL}:1`]);
      expect(ledger.bookings()).toBe(1);

      await expect(desk.request(FOUNDER, { ...ask, caseRef: 'CASE-8' })).rejects.toMatchObject({
        code: 'ops.reversal_already_reversed',
        message: expect.stringContaining(posted.reversingTxId!),
      });
      expect(await sql`SELECT request_no FROM ops.ledger_reversals`).toHaveLength(1);

      // A settled row is history, and nothing is deleted.
      await expect(sql`UPDATE ops.ledger_reversals SET code = 'x' WHERE request_no = 1`).rejects.toThrow(/never changes/);
      await expect(sql`DELETE FROM ops.ledger_reversals`).rejects.toThrow(/never deleted/);
    } finally {
      await sql.end();
      await database.drop();
    }
  });

  it('two approved requests on one original run at once: one posts, the other is refused with the first named', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const ids = identity();
      const ledger = book(2);
      const desk = new LedgerReversalDesk({
        store: new SqlReversalStore(sql),
        ledger: ledger.ledger,
        approvals: ids,
        now: () => new Date(),
      });
      const [a, b] = await Promise.all([desk.request(FOUNDER, ask), desk.request(FOUNDER, { ...ask, caseRef: 'CASE-9' })]);
      expect([a!.ordinal, b!.ordinal].sort()).toEqual(['1', '2']);
      const [ra, rb] = await Promise.all([
        desk.execute(FOUNDER, { requestNo: a!.requestNo, ...ids.propose(a!.requestNo, a!.caseRef) }),
        desk.execute(FOUNDER, { requestNo: b!.requestNo, ...ids.propose(b!.requestNo, b!.caseRef) }),
      ]);
      const results = [ra!, rb!];
      const winner = results.find((r) => r.state === 'posted')!;
      const loser = results.find((r) => r.state === 'refused')!;
      expect(loser).toMatchObject({ code: 'ledger.reversal_already_reversed', reversedBy: winner.reversingTxId });
      expect(ledger.bookings()).toBe(1);
      expect(await sql`SELECT request_no FROM ops.ledger_reversals WHERE state = 'posted'`).toHaveLength(1);
    } finally {
      await sql.end();
      await database.drop();
    }
  });

  it('the table refuses a request leaving intent without a different approver, and a request that changes its words', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 2, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const desk = new LedgerReversalDesk({
        store: new SqlReversalStore(sql),
        ledger: book().ledger,
        approvals: identity(),
        now: () => new Date(),
      });
      await desk.request(FOUNDER, ask);
      await expect(sql`UPDATE ops.ledger_reversals SET state = 'posting' WHERE request_no = 1`).rejects.toThrow(/check/i);
      await expect(
        sql`UPDATE ops.ledger_reversals SET state = 'posting', approval_id = 'ap_x', approver_id = ${FOUNDER} WHERE request_no = 1`,
      ).rejects.toThrow(/check/i);
      await expect(sql`UPDATE ops.ledger_reversals SET reason = 'other words' WHERE request_no = 1`).rejects.toThrow(/keeps its/);
      await expect(
        sql`INSERT INTO ops.ledger_reversals (original_tx_id, ordinal, reason, case_ref, requested_by, requested_at, state, ledger_key)
            VALUES (${ORIGINAL}, 2, 'r', 'c', ${FOUNDER}, now(), 'intent', ${`ops:reversal:${ORIGINAL}:7`})`,
      ).rejects.toThrow(/check/i);
      await migrateOutreach(sql, 'down');
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
