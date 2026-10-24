import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createTestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount,
  recipes,
  staffHoldAccount,
  staffHoldConfirmAccount,
  userAvailable,
} from '@intafaced/ledger-client';
import { staffHoldConfirmFields, staffHoldReleaseFields, staffHoldTargetId, type ActionApproval } from '@intafaced/contracts';
import { migrateOutreach } from '../db/migrate.js';
import { approvalPayloadHash } from '../operator-desks.js';
import { StaffHoldDesk } from './desk.js';
import { SqlStaffHoldStore } from './store.js';

/**
 * Staff holds on real PostgreSQL (money path, so PG-hard: CI sets TEST_DATABASE_URL and this file never skips). The row
 * lock is what keeps a release and a confirm on one hold from both posting, and the movement trigger keeps a settled post
 * as it was answered.
 */

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '55555555-5555-4555-8555-555555555555';

function approvals() {
  let n = 0;
  const spent = new Set<string>();
  const fields = new Map<string, { actionType: string; holdNo: string; hash: string }>();
  return {
    propose(actionType: string, holdNo: string, f: Record<string, string>) {
      n += 1;
      fields.set(`ap_${n}`, { actionType, holdNo, hash: approvalPayloadHash(actionType, f) });
      return { approvalId: `ap_${n}`, operationId: `op_${n}` };
    },
    async consume(input: { approvalId: string; payloadHash: string }): Promise<ActionApproval> {
      const row = fields.get(input.approvalId);
      if (!row || row.hash !== input.payloadHash) throw new Error('action_approval.payload_mismatch');
      if (spent.has(input.approvalId)) throw new Error('action_approval.consumed');
      spent.add(input.approvalId);
      return {
        approvalId: input.approvalId,
        operationId: `op_${input.approvalId.slice(3)}`,
        payloadHash: row.hash,
        targetService: 'svc-ops',
        targetId: staffHoldTargetId(row.holdNo),
        expectedVersion: '1',
        actionType: row.actionType,
        requesterId: FOUNDER,
        approverId: APPROVER,
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

describe('staff holds on real PostgreSQL', () => {
  it('holds 40.00, releases 15.00, races a release against a confirm for the rest, and keeps settled posts as answered', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const sql = postgres(database.url, { max: 6, onnotice: () => undefined });
    try {
      await migrateOutreach(sql);
      const ledger = new MemoryLedger();
      await ledger.post(
        recipes.deposit({ userId: CUSTOMER, assetId: 'USD', amount: parseAmount('100'), rail: 'bank-sandbox', railRef: 'dep-pg' }),
      );
      const ids = approvals();
      const desk = new StaffHoldDesk({
        store: new SqlStaffHoldStore(sql),
        ledger,
        approvals: ids,
        settings: { confirmAccount: 'held-funds', expiryMaxHours: 24 },
        now: () => new Date(),
      });
      const bal = async (account: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(account)).amount);

      const placed = await desk.place(FOUNDER, {
        userId: CUSTOMER,
        assetId: 'USD',
        amount: '40.00',
        reason: 'suspected account takeover',
        idempotencyKey: 'console:place:pg-1',
      });
      const holdNo = placed.hold.holdNo;
      expect(placed).toMatchObject({ outcome: 'done', hold: { amount: '40', remaining: '40', state: 'active' } });
      expect(
        await desk.place(FOUNDER, {
          userId: CUSTOMER,
          assetId: 'USD',
          amount: '40',
          reason: 'suspected account takeover',
          idempotencyKey: 'console:place:pg-1',
        }),
      ).toMatchObject({ outcome: 'replayed' });
      expect(await bal(userAvailable(CUSTOMER, 'USD'))).toBe('60');

      const partial = await desk.release(FOUNDER, {
        holdNo,
        amount: '15',
        ...ids.propose('ops.hold.release', holdNo, staffHoldReleaseFields(holdNo, '15')),
      });
      expect(partial.hold).toMatchObject({ state: 'partially_released', remaining: '25' });

      const outcomes = await Promise.allSettled([
        desk.release(FOUNDER, { holdNo, amount: '25', ...ids.propose('ops.hold.release', holdNo, staffHoldReleaseFields(holdNo, '25')) }),
        desk.confirm(FOUNDER, { holdNo, ...ids.propose('ops.hold.confirm', holdNo, staffHoldConfirmFields(holdNo)) }),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect((outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
        code: 'ops.hold_state_illegal',
      });
      expect(await bal(staffHoldAccount(CUSTOMER, 'USD', holdNo))).toBe('0');
      const releasedWon = outcomes[0]!.status === 'fulfilled';
      expect(await bal(userAvailable(CUSTOMER, 'USD'))).toBe(releasedWon ? '100' : '75');
      expect(await bal(staffHoldConfirmAccount('held-funds', 'USD'))).toBe(releasedWon ? '0' : '25');

      const [listed] = (await desk.list(CUSTOMER)).holds;
      expect(listed).toMatchObject({ holdNo, state: releasedWon ? 'released' : 'confirmed', remaining: '0' });
      expect(listed!.movements.map((m) => m.idempotencyKey)).toEqual([
        `ops:hold:${holdNo}`,
        `ops:hold-release:${holdNo}:1`,
        releasedWon ? `ops:hold-release:${holdNo}:2` : `ops:hold-confirm:${holdNo}:1`,
      ]);

      await expect(sql`UPDATE ops.staff_hold_movements SET status = 'settling' WHERE kind = 'place'`).rejects.toThrow(/never changes/);
      await expect(sql`DELETE FROM ops.staff_hold_movements`).rejects.toThrow(/never deleted/);
      await expect(sql`UPDATE ops.staff_holds SET remaining = 41 WHERE hold_no = ${holdNo}`).rejects.toThrow(/check/i);
      await migrateOutreach(sql, 'down');
    } finally {
      await sql.end();
      await database.drop();
    }
  });
});
