import { replyAccepted } from '@intafaced/contracts/procedure';
import { BANK_TRANSFERS_CREATE } from '@intafaced/contracts/bank-transfers-2-procedures';
import { describe, expect, it } from 'vitest';
import { BANK_BUSINESS_RESOLVE_RECIPIENT_SPACE } from '@intafaced/contracts/bank-business-procedures';
import { BANK_CARDS_ISSUE, BANK_CARDS_SET_CHANNELS, BANK_CARDS_SET_LIMITS } from '@intafaced/contracts/bank-cards-2-procedures';
import { cardSchema, myRoleSchema, pendingApprovalsSchema, teamSchema } from './contracts';

const card = {
  id: '7d0a2cd4-6a46-4f6b-9d8f-0d5f27ec7b11',
  assetId: 'USDT',
  settlementAssetId: 'USDT',
  issuer: 'card-sim',
  simulated: true,
  panTail: '4242',
  status: 'active',
  cashbackBps: 0,
  perAuthorizationLimit: '250.5',
  dailyLimit: null,
  monthlyLimit: '5000',
  cashLimit: null,
  online: true,
  contactless: true,
  atm: false,
  abroad: true,
  cardType: 'physical',
  shippingAddress: { name: 'Ada', line1: '1 High St', line2: null, city: 'London', region: null, postalCode: 'N1 9GU', country: 'GB' },
};

describe('what the card service returns', () => {
  it('reads the limits as exact strings, with a blank cap as null', () => {
    expect(cardSchema.parse(card)).toMatchObject({ dailyLimit: null, monthlyLimit: '5000', atm: false, cardType: 'physical' });
  });
  it('refuses a card reply that leaves out its limits or channels, rather than inventing them', () => {
    const { dailyLimit: _daily, ...noLimit } = card;
    expect(cardSchema.safeParse(noLimit).success).toBe(false);
    const { atm: _atm, ...noChannel } = card;
    expect(cardSchema.safeParse(noChannel).success).toBe(false);
    expect(cardSchema.safeParse({ ...card, perAuthorizationLimit: 250.5 }).success).toBe(false);
    expect(cardSchema.safeParse({ ...card, dailyLimit: 1000 }).success).toBe(false);
  });
  it('uses the same card shape for an order, a limits change and a channels change', () => {
    // The bank's answer carries these beside the app's card view.
    const answer = { ...card, usesAllowed: null, designId: null, deliverySpeed: null, replacesCardId: null, replacedByCardId: null };
    for (const record of [BANK_CARDS_ISSUE, BANK_CARDS_SET_LIMITS, BANK_CARDS_SET_CHANNELS])
      expect(record.output.safeParse(answer).success, record.path).toBe(true);
  });
});

describe('what the team reads return', () => {
  it('reads members with their role and handle', () => {
    expect(
      teamSchema.parse({
        members: [{ accountId: 'a', userId: 'u', role: 'checker', handle: 'ada' }],
        pendingControls: [],
      }),
    ).toEqual({ members: [{ accountId: 'a', userId: 'u', role: 'checker', handle: 'ada' }] });
    expect(teamSchema.safeParse({ members: [{ accountId: 'a', userId: 'u', role: 'owner', handle: 'ada' }] }).success).toBe(false);
  });
  it('reads a recipient lookup as found with an account, found without one, or not found', () => {
    const read = BANK_BUSINESS_RESOLVE_RECIPIENT_SPACE.output;
    expect(read.parse({ found: false })).toEqual({ found: false });
    expect(read.parse({ found: true, handle: 'ada', assetId: 'USDT', spaceId: null })).toMatchObject({ spaceId: null });
    expect(read.safeParse({ found: true, handle: 'ada', assetId: 'USDT', spaceId: 'not-a-uuid' }).success).toBe(false);
  });
  it('names the people on a waiting payment where the bank could, and says where it could not', () => {
    const waiting = {
      id: 'a',
      accountId: 'b',
      makerUserId: 'u1',
      checkerUserId: null,
      fromSpaceId: 'f',
      toSpaceId: 't',
      assetId: 'USDT',
      amount: '12.5',
      status: 'pending',
      transferId: null,
      holdLedgerTxId: null,
      ledgerTxId: null,
      createdAt: '2026-10-18T00:00:00Z',
      makerHandle: null,
      makerHandleReason: 'handle_unresolved',
      receiverOwnerHandle: 'zed',
      receiverOwnerHandleReason: null,
      receiverOwnerName: 'Zed Z',
    };
    expect(pendingApprovalsSchema.parse([waiting])[0]).toMatchObject({
      receiverOwnerHandle: 'zed',
      makerHandleReason: 'handle_unresolved',
    });
  });
  it('reads a role as one of the three the bank has', () => {
    expect(myRoleSchema.parse({ role: 'maker' })).toEqual({ role: 'maker' });
    expect(myRoleSchema.safeParse({ role: 'owner' }).success).toBe(false);
  });
});

describe('what a move into a space returns (transfers.create)', () => {
  // The record's schema and its own `accept` checks, as `api.call` runs them for every caller.
  const reply = {
    safeParse: (data: unknown) => ({
      success: BANK_TRANSFERS_CREATE.output.safeParse(data).success && replyAccepted(BANK_TRANSFERS_CREATE, data),
    }),
  };
  const move = { id: 'test-partner-move-1', label: 'TEST partner bank', movedAt: '2026-11-15T00:00:00.000Z' };

  it('is confirmed by the ledger’s transaction, or by the partner bank’s one move with no ledger transaction', () => {
    expect(reply.safeParse({ ledgerTxId: 'tx-1', amount: '5' }).success).toBe(true);
    expect(reply.safeParse({ ledgerTxId: 'tx-1', amount: '5', partnerMove: null }).success).toBe(true);
    expect(reply.safeParse({ ledgerTxId: null, amount: '5', partnerMove: move }).success).toBe(true);
  });

  it('is never a confirmation when it names neither book, or both', () => {
    expect(reply.safeParse({ ledgerTxId: null, amount: '5' }).success).toBe(false);
    expect(reply.safeParse({ ledgerTxId: null, amount: '5', partnerMove: null }).success).toBe(false);
    expect(reply.safeParse({ ledgerTxId: 'tx-1', amount: '5', partnerMove: move }).success).toBe(false);
    expect(reply.safeParse({ ledgerTxId: '', amount: '5' }).success).toBe(false);
  });
});
