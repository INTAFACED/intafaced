import { randomUUID } from 'node:crypto';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import type { ActionApprovalConsumer } from './action-approval-consume.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import {
  loadDestinationHoldSeconds,
  PAY_DESTINATION_STEP_UP,
  PayoutDestinationChange,
  verifyDestinationStepUp,
  type DestinationCaller,
} from './payout-destination-change.js';

const A = '0x0000000000000000000000000000000000000f01';
const B = '0x0000000000000000000000000000000000000f02';
const RAIL = 'crypto-native';

function caller(userId: string, patch: Partial<DestinationCaller> = {}): DestinationCaller {
  return { userId, sessionId: randomUUID(), viaApiKey: false, interactive: true, ...patch };
}

function approvals(): ActionApprovalConsumer {
  return {
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      const userId = input.principalUserId ?? 'missing';
      return {
        approvalId: input.approvalId,
        actionType: PAY_DESTINATION_STEP_UP,
        targetService: 'svc-pay',
        targetId: PAY_DESTINATION_STEP_UP,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: userId,
        approverId: userId,
        policyVersion: '1',
        createdAt: '2026-10-17T00:00:00.000Z',
        expiresAt: '2026-10-17T00:05:00.000Z',
        status: 'CONSUMED',
        operationId: input.operationId,
        kind: 'same_person',
      };
    },
  };
}

describe('loadDestinationHoldSeconds', () => {
  it('accepts a positive integer and refuses blank, zero, and junk', () => {
    expect(loadDestinationHoldSeconds(undefined)).toBeNull();
    expect(loadDestinationHoldSeconds('')).toBeNull();
    expect(loadDestinationHoldSeconds('  ')).toBeNull();
    expect(loadDestinationHoldSeconds('0')).toBeNull();
    expect(loadDestinationHoldSeconds('24h')).toBeNull();
    expect(loadDestinationHoldSeconds('86400')).toBe(86400);
  });
});

function harness(holdSeconds: number | null) {
  const merchantId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const financeId = '33333333-3333-4333-8333-333333333333';
  let now = new Date('2026-10-17T00:00:00.000Z');
  const notes: string[] = [];
  const book = memoryPayoutDestinations(() => now);
  const change = new PayoutDestinationChange(
    book,
    async (userId) => {
      if (userId === ownerId) return 'owner';
      if (userId === financeId) return 'finance';
      return null;
    },
    verifyDestinationStepUp,
    approvals(),
    holdSeconds,
    async (_merchantId, title, body) => {
      notes.push(`${title}|${body}`);
    },
    () => now,
  );
  return {
    merchantId,
    ownerId,
    financeId,
    book,
    change,
    notes,
    advance(iso: string) {
      now = new Date(iso);
    },
  };
}

describe('PayoutDestinationChange', () => {
  const open = (merchantId: string) => ({
    merchantId,
    railId: RAIL,
    kind: 'crypto',
    ref: A,
    stepUpApprovalId: 'step-up-ok',
  });

  it('refuses a change without step-up and leaves the book empty', async () => {
    const h = harness(3600);
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), stepUpApprovalId: undefined })).rejects.toMatchObject({
      code: 'pay.destination_step_up_required',
    });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toBeNull();
    expect(h.notes).toEqual([]);
  });

  it('refuses an API key before any write', async () => {
    const h = harness(3600);
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId, { viaApiKey: true }) })).rejects.toMatchObject({
      code: 'pay.destination_api_key_refused',
    });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toBeNull();
  });

  it('refuses a pay:payout finance role', async () => {
    const h = harness(3600);
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.financeId) })).rejects.toMatchObject({
      code: 'pay.destination_role_forbidden',
    });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toBeNull();
  });

  it('verifies a first destination into the hold, reads Active at activatesAt, and stages a change until its own hold passes', async () => {
    const h = harness(3600);
    const verified = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) });
    expect(verified).toEqual({ status: 'held', railId: RAIL, kind: 'crypto', ref: A, activatesAt: '2026-10-17T01:00:00.000Z' });
    // Held: nothing is paid to it before activatesAt.
    await expect(h.book.require({ merchantId: h.merchantId, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_held',
    });
    h.advance('2026-10-17T00:59:59.999Z');
    await expect(h.book.require({ merchantId: h.merchantId, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_held',
    });
    h.advance('2026-10-17T01:00:00.000Z');
    expect(await h.book.require({ merchantId: h.merchantId, railId: RAIL })).toEqual({ kind: 'crypto', ref: A });
    const pending = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), ref: B });
    expect(pending.status).toBe('pending');
    expect(pending.activatesAt).toBe('2026-10-17T02:00:00.000Z');
    expect((await h.book.require({ merchantId: h.merchantId, railId: RAIL })).ref).toBe(A);
    h.advance('2026-10-17T02:00:00.000Z');
    expect((await h.book.require({ merchantId: h.merchantId, railId: RAIL })).ref).toBe(B);
    expect(h.notes.join('\n')).not.toContain(A);
    expect(h.notes.join('\n')).not.toContain(B);
    expect(h.notes).toEqual([
      'Payout destination verified|A payout destination for crypto-native (0x0000…0f01) is verified and becomes active at 2026-10-17T01:00:00.000Z.',
      'Payout destination change pending|A payout destination change for crypto-native to 0x0000…0f02 is pending until 2026-10-17T02:00:00.000Z.',
    ]);
  });

  it('verifying the same destination again keeps the hold end and writes nothing', async () => {
    const h = harness(3600);
    const first = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) });
    h.advance('2026-10-17T00:30:00.000Z');
    const again = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) });
    expect(again).toEqual(first);
    h.advance('2026-10-17T01:00:00.000Z');
    expect(await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) })).toEqual({
      status: 'active',
      railId: RAIL,
      kind: 'crypto',
      ref: A,
      activatesAt: null,
    });
    expect(h.notes).toHaveLength(1);
  });

  it('refuses to verify a first destination and to change a verified one when the hold is unset, writing nothing', async () => {
    const h = harness(null);
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) })).rejects.toMatchObject({
      code: 'pay.destination_hold_unset',
    });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toBeNull();
    // A saved, unverified one stays unverified.
    await h.change.add({ ...open(h.merchantId), caller: caller(h.ownerId) });
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) })).rejects.toMatchObject({
      code: 'pay.destination_hold_unset',
    });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toMatchObject({ verified: false, ref: A });
    // A verified one is not changed.
    await h.book.seedVerified({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A });
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), ref: B })).rejects.toMatchObject({
      code: 'pay.destination_hold_unset',
    });
    expect((await h.book.require({ merchantId: h.merchantId, railId: RAIL })).ref).toBe(A);
    expect(h.notes).toEqual([
      'Payout destination added|A payout destination for crypto-native (0x0000…0f01) was saved. It is unverified and cannot receive a payout until it is verified.',
    ]);
  });

  it('saves a destination unverified without step-up; it cannot be paid until verified, then waits out the hold', async () => {
    const h = harness(45);
    const saved = await h.change.add({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A, caller: caller(h.ownerId) });
    expect(saved).toEqual({ status: 'unverified', railId: RAIL, kind: 'crypto', ref: A, activatesAt: null });
    await expect(h.book.require({ merchantId: h.merchantId, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_unverified',
    });
    // Saving the same one again changes nothing and tells nobody twice.
    expect(await h.change.add({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A, caller: caller(h.ownerId) })).toEqual(
      saved,
    );
    expect(h.notes).toHaveLength(1);
    // Saving another while unverified replaces it, still unverified.
    await h.change.add({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: B, caller: caller(h.ownerId) });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toMatchObject({ verified: false, ref: B, pending: null });
    // Verifying it with the step-up: held for 45 s, then active.
    const verified = await h.change.set({ ...open(h.merchantId), ref: B, caller: caller(h.ownerId) });
    expect(verified).toEqual({ status: 'held', railId: RAIL, kind: 'crypto', ref: B, activatesAt: '2026-10-17T00:00:45.000Z' });
    await expect(h.book.require({ merchantId: h.merchantId, railId: RAIL })).rejects.toMatchObject({
      code: 'pay.payout_destination_held',
    });
    h.advance('2026-10-17T00:00:45.000Z');
    expect(await h.book.require({ merchantId: h.merchantId, railId: RAIL })).toEqual({ kind: 'crypto', ref: B });
  });

  it('refuses an unverified save over a verified destination, and the same caller rules as a change', async () => {
    const h = harness(45);
    await h.book.seedVerified({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A });
    await expect(
      h.change.add({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: B, caller: caller(h.ownerId) }),
    ).rejects.toMatchObject({ code: 'pay.payout_destination_verified_locked' });
    await expect(
      h.change.add({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A, caller: caller(h.ownerId) }),
    ).rejects.toMatchObject({ code: 'pay.payout_destination_verified_locked' });
    expect(await h.book.require({ merchantId: h.merchantId, railId: RAIL })).toEqual({ kind: 'crypto', ref: A });
    const other = harness(45);
    const add = (who: DestinationCaller) =>
      other.change.add({ merchantId: other.merchantId, railId: RAIL, kind: 'crypto', ref: A, caller: who });
    await expect(add(caller(other.financeId))).rejects.toMatchObject({ code: 'pay.destination_role_forbidden' });
    await expect(add(caller(other.ownerId, { viaApiKey: true }))).rejects.toMatchObject({ code: 'pay.destination_api_key_refused' });
    await expect(add(caller(other.ownerId, { interactive: false }))).rejects.toMatchObject({ code: 'pay.destination_session_required' });
    await expect(add(caller('44444444-4444-4444-8444-444444444444'))).rejects.toMatchObject({ code: 'pay.merchant_not_found' });
    await expect(
      other.change.add({
        merchantId: other.merchantId,
        railId: RAIL,
        kind: 'crypto',
        ref: '0xnot-an-address',
        caller: caller(other.ownerId),
      }),
    ).rejects.toMatchObject({ code: 'pay.invalid_destination_ref' });
    expect(await other.book.read({ merchantId: other.merchantId, railId: RAIL })).toBeNull();
    expect(other.notes).toEqual([]);
  });

  it('refuses, by name, confirming the current address while a change of it is pending, and writes nothing', async () => {
    const h = harness(3600);
    await h.book.seedVerified({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A });
    await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), ref: B });
    const before = await h.book.read({ merchantId: h.merchantId, railId: RAIL });
    expect(before).toMatchObject({ ref: A, pending: { ref: B } });
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) })).rejects.toMatchObject({
      code: 'pay.destination_change_pending',
    });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toEqual(before);
    expect(h.notes).toHaveLength(1);
  });

  it('a held destination changed to another address is verified afresh: the new one waits the whole hold, nothing pending', async () => {
    const h = harness(3600);
    await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) });
    h.advance('2026-10-17T00:30:00.000Z');
    const again = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), ref: B });
    expect(again).toEqual({ status: 'held', railId: RAIL, kind: 'crypto', ref: B, activatesAt: '2026-10-17T01:30:00.000Z' });
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toMatchObject({ ref: B, pending: null });
    h.advance('2026-10-17T01:00:00.000Z');
    await expect(h.book.require({ merchantId: h.merchantId, railId: RAIL })).rejects.toMatchObject({ code: 'pay.payout_destination_held' });
    h.advance('2026-10-17T01:30:00.000Z');
    expect(await h.book.require({ merchantId: h.merchantId, railId: RAIL })).toEqual({ kind: 'crypto', ref: B });
  });

  it('verify verifies the saved address: another kind or ref is refused before the step-up is spent, and nothing is written', async () => {
    const h = harness(3600);
    let consumed = 0;
    const counting: ActionApprovalConsumer = {
      consume: async (input) => {
        consumed += 1;
        return approvals().consume(input);
      },
    };
    const change = new PayoutDestinationChange(
      h.book,
      async () => 'owner',
      verifyDestinationStepUp,
      counting,
      3600,
      async () => undefined,
      () => new Date('2026-10-17T00:00:00.000Z'),
    );
    await change.add({ merchantId: h.merchantId, railId: RAIL, kind: 'crypto', ref: A, caller: caller(h.ownerId) });
    await expect(change.set({ ...open(h.merchantId), ref: B, caller: caller(h.ownerId) })).rejects.toMatchObject({
      code: 'pay.destination_verify_mismatch',
    });
    expect(consumed).toBe(0);
    expect(await h.book.read({ merchantId: h.merchantId, railId: RAIL })).toMatchObject({ ref: A, verified: false, activatesAt: null });
    // The saved one verifies; and with no row at all, one call saves and verifies (the go-live save).
    expect((await change.set({ ...open(h.merchantId), caller: caller(h.ownerId) })).status).toBe('held');
    expect(consumed).toBe(1);
    const fresh = harness(3600);
    expect((await fresh.change.set({ ...open(fresh.merchantId), ref: B, caller: caller(fresh.ownerId) })).status).toBe('held');
  });
});
