import { describe, expect, it } from 'vitest';
import { SAME_PERSON_ACTION_TYPES, SAME_PERSON_APPROVAL_TTL_SECONDS } from './action-approval.js';
import {
  CUSTOMER_STEP_UP_CHALLENGE_TTL_SECONDS,
  CUSTOMER_STEP_UP_DOORS,
  bindCustomerStepUp,
  canonicalPayrollLines,
  customerStepUpPayloadHash,
} from './customer-step-up.js';

const ACTOR = 'user-1';

describe('customer step-up binding', () => {
  it('pins the challenge at 120 seconds and the approval at the existing five minutes', () => {
    expect(CUSTOMER_STEP_UP_CHALLENGE_TTL_SECONDS).toBe(120);
    expect(SAME_PERSON_APPROVAL_TTL_SECONDS).toBe(300);
  });

  it('covers every same-person scope once, including withdrawals', () => {
    expect(CUSTOMER_STEP_UP_DOORS.map((door) => door.scope).sort()).toEqual([...SAME_PERSON_ACTION_TYPES].sort());
  });

  it('hashes the transfer the way the bank door recomputes it', () => {
    const fields = {
      actor: 'user-1',
      amount: '10.50',
      assetId: 'USDT',
      fromSpaceId: 'space-from',
      toUserId: 'user-2',
      transferId: 'transfer-1',
    };
    expect(customerStepUpPayloadHash('bank.step_up.transfers.toUser', fields)).toBe(
      'sha256:ed94a0f0e49b1c63f030f1b90ba43575e859339a9ce3e63783f546024d22d406',
    );
  });

  it('sorts payroll lines by space id then amount string', () => {
    expect(
      canonicalPayrollLines([
        { toSpaceId: 'b', amount: '2' },
        { toSpaceId: 'a', amount: '10' },
        { toSpaceId: 'a', amount: '2' },
      ]),
    ).toBe('[["a","10"],["a","2"],["b","2"]]');
  });

  it('binds a send to the signed-in user and refuses a client-supplied actor', () => {
    const bound = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.transfers.toUser',
      purpose: 'transfers.toUser',
      amount: '10.50',
      target: 'user-2',
      fields: {
        transferId: 'transfer-1',
        fromSpaceId: 'space-from',
        toUserId: 'user-2',
        assetId: 'USDT',
        amount: '10.50',
      },
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.payloadHash).toBe('sha256:ed94a0f0e49b1c63f030f1b90ba43575e859339a9ce3e63783f546024d22d406');
    expect(bound.amount).toBe('10.50');
    expect(bound.target).toBe('user-2');

    const spoofed = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.transfers.toUser',
      purpose: 'transfers.toUser',
      amount: '10.50',
      target: 'user-2',
      fields: {
        actor: 'someone-else',
        transferId: 'transfer-1',
        fromSpaceId: 'space-from',
        toUserId: 'user-2',
        assetId: 'USDT',
        amount: '10.50',
      },
    });
    expect(spoofed).toEqual({ ok: false, code: 'step_up.fields' });
  });

  it('refuses an amount or target that does not match the fields', () => {
    const base = {
      scope: 'bank.step_up.transfers.toUser',
      purpose: 'transfers.toUser',
      target: 'user-2',
      fields: {
        transferId: 'transfer-1',
        fromSpaceId: 'space-from',
        toUserId: 'user-2',
        assetId: 'USDT',
        amount: '10.50',
      },
    };
    expect(bindCustomerStepUp(ACTOR, { ...base, amount: '11.00' })).toEqual({ ok: false, code: 'step_up.amount' });
    expect(bindCustomerStepUp(ACTOR, { ...base, amount: '10.50', target: 'user-3' })).toEqual({ ok: false, code: 'step_up.target' });
    expect(bindCustomerStepUp(ACTOR, { ...base, amount: '10.50', purpose: 'transfers.create' })).toEqual({
      ok: false,
      code: 'step_up.purpose',
    });
  });

  it('requires no amount on add-member and allows an empty withdraw destination', () => {
    const member = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.business.addMember',
      purpose: 'business.addMember',
      target: 'user-2',
      fields: { accountId: 'acct-1', userId: 'user-2', role: 'checker' },
    });
    expect(member.ok).toBe(true);
    if (member.ok) expect(member.amount).toBeNull();

    const removed = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.business.removeMember',
      purpose: 'business.removeMember',
      target: 'user-2',
      fields: { accountId: 'acct-1', userId: 'user-2', requestId: 'req-1' },
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.amount).toBeNull();
      expect(removed.payloadHash).toBe(
        customerStepUpPayloadHash('bank.step_up.business.removeMember', {
          actor: ACTOR,
          accountId: 'acct-1',
          userId: 'user-2',
          requestId: 'req-1',
        }),
      );
    }

    const role = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.business.setMemberRole',
      purpose: 'business.setMemberRole',
      target: 'user-2',
      fields: { accountId: 'acct-1', userId: 'user-2', role: 'checker', requestId: 'req-2' },
    });
    expect(role.ok).toBe(true);
    if (role.ok) expect(role.target).toBe('user-2');

    const ramp = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.ramps.offramp',
      purpose: 'ramps.offramp',
      amount: '5.00',
      fields: {
        offrampId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDT',
        amount: '5.00',
        kind: 'crypto',
        destinationRef: '',
        clientRef: 'client-1',
      },
    });
    expect(ramp.ok).toBe(true);
    if (ramp.ok) expect(ramp.target).toBeNull();
  });
});
