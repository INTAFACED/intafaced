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

  it('hashes a note, reference or settled request on a send only when the send carries one, and refuses an empty one', () => {
    const fields = { transferId: 'transfer-1', fromSpaceId: 'space-from', toUserId: 'user-2', assetId: 'USDT', amount: '10.50' };
    const begin = (extra: Record<string, string>) =>
      bindCustomerStepUp(ACTOR, {
        scope: 'bank.step_up.transfers.toUser',
        purpose: 'transfers.toUser',
        amount: '10.50',
        target: 'user-2',
        fields: { ...fields, ...extra },
      });
    const withNote = begin({ note: 'Lunch', reference: 'INV-1', requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    expect(withNote).toMatchObject({
      ok: true,
      payloadHash: customerStepUpPayloadHash('bank.step_up.transfers.toUser', {
        actor: ACTOR,
        ...fields,
        note: 'Lunch',
        reference: 'INV-1',
        requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    });
    expect(begin({})).toMatchObject({ ok: true, payloadHash: 'sha256:ed94a0f0e49b1c63f030f1b90ba43575e859339a9ce3e63783f546024d22d406' });
    // Only the shape the bank keeps after its own trimming: anything else would hash bytes the bank never hashes.
    for (const extra of [
      { note: '' } as Record<string, string>,
      { note: '   ' },
      { note: ' Lunch ' },
      { note: 'x'.repeat(141) },
      { note: 'line\nbreak' },
      { reference: 'INV-1 ' },
      { reference: 'Café' },
      { reference: 'r'.repeat(65) },
      { requestId: 'req-1' },
    ])
      expect(begin(extra), JSON.stringify(extra)).toEqual({ ok: false, code: 'step_up.fields' });
    expect(begin({ memo: 'x' })).toEqual({ ok: false, code: 'step_up.fields' });
    // An own-space-style door keeps its exact field list: a request id is not one of its fields.
    expect(
      bindCustomerStepUp(ACTOR, {
        scope: 'bank.step_up.transfers.create',
        purpose: 'transfers.create',
        amount: '10.50',
        target: 'space-2',
        fields: {
          transferId: 'transfer-1',
          fromSpaceId: 'space-from',
          toSpaceId: 'space-2',
          assetId: 'USDT',
          amount: '10.50',
          requestId: 'r',
        },
      }),
    ).toEqual({ ok: false, code: 'step_up.fields' });
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

    const issued = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.cards.issue',
      purpose: 'cards.issue',
      amount: '10',
      target: 'card-1',
      fields: {
        cardId: 'card-1',
        assetId: 'USDT',
        settlementAssetId: '',
        cashbackBps: '',
        perAuthorizationLimit: '10',
        cardType: 'virtual',
        shippingAddress: '',
      },
    });
    expect(issued.ok).toBe(true);
    if (issued.ok) {
      expect(issued.payloadHash).toBe(
        customerStepUpPayloadHash('bank.step_up.cards.issue', {
          actor: ACTOR,
          cardId: 'card-1',
          assetId: 'USDT',
          settlementAssetId: '',
          cashbackBps: '',
          perAuthorizationLimit: '10',
          cardType: 'virtual',
          shippingAddress: '',
        }),
      );
    }

    const limits = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.cards.setLimits',
      purpose: 'cards.setLimits',
      amount: '90',
      target: 'card-1',
      fields: {
        cardId: 'card-1',
        commandId: 'cmd-1',
        perAuthorizationLimit: '90',
        dailyLimit: 'null',
        monthlyLimit: '',
        cashLimit: '',
      },
    });
    expect(limits.ok).toBe(true);

    const reveal = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.cards.reveal',
      purpose: 'cards.reveal',
      target: 'card-1',
      fields: { cardId: 'card-1', revealId: 'rev-1' },
    });
    expect(reveal.ok).toBe(true);

    const pinReveal = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.cards.pinReveal',
      purpose: 'cards.pinReveal',
      target: 'card-1',
      fields: { cardId: 'card-1', revealId: 'rev-2' },
    });
    expect(pinReveal.ok).toBe(true);

    const pinSet = bindCustomerStepUp(ACTOR, {
      scope: 'bank.step_up.cards.pinSet',
      purpose: 'cards.pinSet',
      target: 'card-1',
      fields: { cardId: 'card-1', commandId: 'cmd-2' },
    });
    expect(pinSet.ok).toBe(true);

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

  it('binds an email change and a phone change to the address, and a phone removal to the number', () => {
    const email = bindCustomerStepUp(ACTOR, {
      scope: 'identity.step_up.email_change',
      purpose: 'account.email.change',
      target: 'next@example.com',
      fields: { newEmail: 'next@example.com' },
    });
    expect(email.ok).toBe(true);
    if (email.ok) expect(email.target).toBe('next@example.com');

    const phone = bindCustomerStepUp(ACTOR, {
      scope: 'identity.step_up.phone_change',
      purpose: 'account.phone.change',
      target: '+14155552671',
      fields: { newPhone: '+14155552671' },
    });
    expect(phone.ok).toBe(true);

    const remove = bindCustomerStepUp(ACTOR, {
      scope: 'identity.step_up.phone_remove',
      purpose: 'account.phone.remove',
      target: '+14155552671',
      fields: { phone: '+14155552671' },
    });
    expect(remove.ok).toBe(true);
    const close = bindCustomerStepUp(ACTOR, {
      scope: 'identity.step_up.close_account',
      purpose: 'account.close',
      target: '11111111-1111-4111-8111-111111111111',
      fields: { intent: 'request', clientRequestId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(close.ok).toBe(true);
    if (!close.ok) return;
    expect(close.payloadHash).toBe(
      customerStepUpPayloadHash('identity.step_up.close_account', {
        actor: ACTOR,
        intent: 'request',
        clientRequestId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    if (!email.ok) return;
    expect(email.payloadHash).toBe(
      customerStepUpPayloadHash('identity.step_up.email_change', { actor: ACTOR, newEmail: 'next@example.com' }),
    );
  });
});
