import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from './catalog.js';

const uid = () => crypto.randomUUID();
const ts = () => new Date().toISOString();

const transfer = () => ({
  transferId: 'send:u1:7',
  senderUserId: uid(),
  recipientUserId: uid(),
  amount: '0.000000000000000001',
  assetId: 'USDT',
  ledgerTxId: uid(),
  postedAt: ts(),
});

describe('PP-send-request-18 receipt events', () => {
  it('declares the subjects under svc-bank', () => {
    expect(EVENT_CATALOG.personalTransferPosted.subject).toBe('intafaced.bank.personal_transfer.posted');
    expect(EVENT_CATALOG.personalRefundPosted.subject).toBe('intafaced.bank.personal_refund.posted');
    expect(EVENT_CATALOG.personalDisputeUpdated.subject).toBe('intafaced.bank.personal_dispute.updated');
  });

  it('keeps 18dp amounts as decimal strings and refuses a JS number', () => {
    expect(EVENT_CATALOG.personalTransferPosted.schema.parse(transfer()).amount).toBe('0.000000000000000001');
    expect(EVENT_CATALOG.personalTransferPosted.schema.safeParse({ ...transfer(), amount: 12.5 }).success).toBe(false);
    expect(EVENT_CATALOG.personalTransferPosted.schema.safeParse({ ...transfer(), amount: '-1' }).success).toBe(false);
  });

  it('refuses a receipt without both parties', () => {
    const { recipientUserId: _r, ...noRecipient } = transfer();
    expect(EVENT_CATALOG.personalTransferPosted.schema.safeParse(noRecipient).success).toBe(false);
    expect(
      EVENT_CATALOG.personalRefundPosted.schema.safeParse({
        refundId: 'r1',
        origTransferId: 'send:u1:7',
        refunderUserId: 'alice',
        refundeeUserId: uid(),
        amount: '1',
        assetId: 'USDT',
        ledgerTxId: uid(),
        postedAt: ts(),
      }).success,
    ).toBe(false);
  });

  it('dispute updates need a sequence of 1 or more and a named status', () => {
    const base = {
      disputeId: 'd',
      activityId: 'a',
      userId: uid(),
      counterpartyUserId: null,
      status: 'opened',
      sequence: 1,
      changedAt: ts(),
    };
    expect(EVENT_CATALOG.personalDisputeUpdated.schema.safeParse(base).success).toBe(true);
    expect(EVENT_CATALOG.personalDisputeUpdated.schema.safeParse({ ...base, sequence: 0 }).success).toBe(false);
    expect(EVENT_CATALOG.personalDisputeUpdated.schema.safeParse({ ...base, status: '' }).success).toBe(false);
  });
});
