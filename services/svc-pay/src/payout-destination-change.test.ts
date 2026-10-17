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

  it('activates the first destination immediately and stages a change until the hold passes', async () => {
    const h = harness(3600);
    const added = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) });
    expect(added).toMatchObject({ status: 'active', ref: A, activatesAt: null });
    const pending = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), ref: B });
    expect(pending.status).toBe('pending');
    expect(pending.activatesAt).toBe('2026-10-17T01:00:00.000Z');
    expect((await h.book.require({ merchantId: h.merchantId, railId: RAIL })).ref).toBe(A);
    h.advance('2026-10-17T01:00:00.000Z');
    expect((await h.book.require({ merchantId: h.merchantId, railId: RAIL })).ref).toBe(B);
    expect(h.notes.join('\n')).not.toContain(A);
    expect(h.notes.join('\n')).not.toContain(B);
    expect(h.notes).toEqual([
      'Payout destination added|A payout destination for crypto-native is active.',
      'Payout destination change pending|A payout destination for crypto-native is pending until 2026-10-17T01:00:00.000Z.',
    ]);
  });

  it('refuses a change when the hold is unset and still activates a first destination', async () => {
    const h = harness(null);
    const first = await h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId) });
    expect(first.status).toBe('active');
    await expect(h.change.set({ ...open(h.merchantId), caller: caller(h.ownerId), ref: B })).rejects.toMatchObject({
      code: 'pay.destination_hold_unset',
    });
    expect((await h.book.require({ merchantId: h.merchantId, railId: RAIL })).ref).toBe(A);
  });
});
