import { describe, expect, it } from 'vitest';
import { bankReads, bankWrites, cardSchema } from './contracts';

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
    for (const procedure of ['cards.issue', 'cards.setLimits', 'cards.setChannels'] as const)
      expect(bankWrites[procedure].safeParse(card).success, procedure).toBe(true);
  });
});

describe('what the team reads return', () => {
  it('reads members with their role and handle', () => {
    expect(
      bankReads['business.members'].parse({
        members: [{ accountId: 'a', userId: 'u', role: 'checker', handle: 'ada' }],
        pendingControls: [],
      }),
    ).toEqual({ members: [{ accountId: 'a', userId: 'u', role: 'checker', handle: 'ada' }] });
    expect(
      bankReads['business.members'].safeParse({ members: [{ accountId: 'a', userId: 'u', role: 'owner', handle: 'ada' }] }).success,
    ).toBe(false);
  });
  it('reads a recipient lookup as found with an account, found without one, or not found', () => {
    const read = bankReads['business.resolveRecipientSpace'];
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
    expect(bankReads['business.pending'].parse([waiting])[0]).toMatchObject({
      receiverOwnerHandle: 'zed',
      makerHandleReason: 'handle_unresolved',
    });
  });
  it('reads a role as one of the three the bank has', () => {
    expect(bankReads['business.myRole'].parse({ role: 'maker' })).toEqual({ role: 'maker' });
    expect(bankReads['business.myRole'].safeParse({ role: 'owner' }).success).toBe(false);
  });
});
