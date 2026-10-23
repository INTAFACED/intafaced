/**
 * The customer step-up door (packages/contracts `bindCustomerStepUp`, run by identity) and the bank door
 * (`money-out-fields.ts`, re-hashed by svc-bank) must hash the same bytes for every send, or an approval the
 * person just gave can never be spent. A send to a person with a note, a reference or a request it settles
 * was the gap (J-bank-04 #4): identity refused those fields while the bank hashed them.
 */
import { describe, expect, it } from 'vitest';
import { bindCustomerStepUp } from '@intafaced/contracts';
import { bankActionPayloadHash } from '../action-approval-consume.js';
import { plainNote, plainReference } from '../transfers/personal-pay.js';
import { createTransferBinding, toUserBinding } from './money-out-fields.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const base = {
  transferId: 'transfer:jbank04:1',
  fromSpaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  assetId: 'USDT',
  amount: '40',
};

function identityHash(scope: string, purpose: string, target: string, fields: Record<string, string>): string {
  const bound = bindCustomerStepUp(ACTOR, { scope, purpose, amount: fields.amount, target, fields });
  if (!bound.ok) throw new Error(`identity refused the begin: ${bound.code}`);
  return bound.payloadHash;
}

describe('a step-up approval for a send is spendable at the bank door', () => {
  const toUserId = '99999999-9999-4999-8999-999999999999';
  const cases: Record<string, { note?: string; reference?: string; requestId?: string }> = {
    'no note or reference': {},
    'a note': { note: 'Lunch, TEST' },
    'a reference': { reference: 'INV-0042' },
    'a note, a reference and the request it settles': {
      note: 'Rent',
      reference: 'OCT',
      requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    },
  };
  for (const [name, extra] of Object.entries(cases)) {
    it(`to a person, with ${name}`, () => {
      // The router normalises the note and reference before it builds the binding; so does this test.
      const note = plainNote(extra.note) ?? undefined;
      const reference = plainReference(extra.reference) ?? undefined;
      const bank = toUserBinding({
        actor: ACTOR,
        ...base,
        toUserId,
        ...(note ? { note } : {}),
        ...(reference ? { reference } : {}),
        ...(extra.requestId ? { requestId: extra.requestId } : {}),
      });
      expect(identityHash('bank.step_up.transfers.toUser', 'transfers.toUser', toUserId, { ...base, toUserId, ...extra })).toBe(
        bankActionPayloadHash(bank.actionType, bank.fields),
      );
    });
  }
  it('to another person’s space, with a note and a reference', () => {
    const toSpaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const extra = { note: 'Split bill', reference: 'DIN-7' };
    const bank = createTransferBinding({ actor: ACTOR, ...base, toSpaceId, ...extra });
    expect(identityHash('bank.step_up.transfers.create', 'transfers.create', toSpaceId, { ...base, toSpaceId, ...extra })).toBe(
      bankActionPayloadHash(bank.actionType, bank.fields),
    );
  });
  it('an approval for one note is never spendable on a send with another', () => {
    const toUserId = '99999999-9999-4999-8999-999999999999';
    const approved = identityHash('bank.step_up.transfers.toUser', 'transfers.toUser', toUserId, { ...base, toUserId, note: 'Rent' });
    const sent = toUserBinding({ actor: ACTOR, ...base, toUserId, note: 'Rent, all of it' });
    expect(approved).not.toBe(bankActionPayloadHash(sent.actionType, sent.fields));
    const bare = toUserBinding({ actor: ACTOR, ...base, toUserId });
    expect(approved).not.toBe(bankActionPayloadHash(bare.actionType, bare.fields));
  });
});
