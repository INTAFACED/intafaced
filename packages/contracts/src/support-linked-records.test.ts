import { describe, expect, it } from 'vitest';
import {
  SUPPORT_LINK_RECORD_ERROR_CODES,
  SUPPORT_LINKABLE_RECORD_KINDS,
  SUPPORT_LINKED_RECORD_OWNER,
  supportLinkedRecordListSchema,
  supportLinkedRecordSchema,
  supportLinkRecordInputSchema,
} from './support-linked-records.js';
import { SUPPORT_OWNED_RECORD_KINDS } from './support-record-ownership.js';
import * as root from './index.js';

const TICKET = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const input = { ticketId: TICKET, kind: 'withdrawal', recordId: RECORD };

describe('records linked to a support request', () => {
  it('links an order, a withdrawal or a deposit, each owned by one named service', () => {
    expect(SUPPORT_LINKABLE_RECORD_KINDS).toEqual(['order', 'withdrawal', 'deposit']);
    expect(SUPPORT_LINKED_RECORD_OWNER).toEqual({ order: 'svc-trade', withdrawal: 'svc-pay', deposit: 'svc-pay' });
    // Every svc-pay kind is one svc-pay's ownership door answers.
    for (const kind of SUPPORT_LINKABLE_RECORD_KINDS.filter((k) => SUPPORT_LINKED_RECORD_OWNER[k] === 'svc-pay'))
      expect(SUPPORT_OWNED_RECORD_KINDS).toContain(kind);
  });

  it('takes a ticket, a kind and a record id, and never a customer', () => {
    expect(supportLinkRecordInputSchema.parse(input)).toEqual(input);
    expect(supportLinkRecordInputSchema.safeParse({ ...input, userId: RECORD }).success).toBe(false);
    expect(supportLinkRecordInputSchema.safeParse({ ...input, kind: 'payment' }).success).toBe(false);
    expect(supportLinkRecordInputSchema.safeParse({ ...input, recordId: 'w-1' }).success).toBe(false);
    expect(supportLinkRecordInputSchema.safeParse({ ...input, ticketId: undefined }).success).toBe(false);
  });

  it('a link carries the kind and the id only: no amount, status or address rides along', () => {
    const link = { ticketId: TICKET, kind: 'deposit', recordId: RECORD, linkedBy: 'op-1', linkedAt: '2026-11-02T00:00:00.000Z' };
    expect(supportLinkedRecordSchema.parse(link)).toEqual(link);
    expect(supportLinkedRecordSchema.safeParse({ ...link, amount: '10' }).success).toBe(false);
    expect(supportLinkedRecordSchema.safeParse({ ...link, status: 'paid' }).success).toBe(false);
    expect(supportLinkedRecordListSchema.parse({ records: [link] }).records).toHaveLength(1);
  });

  it('names its refusals, and exports from the package root', () => {
    expect(SUPPORT_LINK_RECORD_ERROR_CODES).toEqual([
      'support.link_record_not_owned',
      'support.link_record_owner_unwired',
      'support.link_record_owner_unreachable',
    ]);
    expect(root.supportLinkRecordInputSchema).toBe(supportLinkRecordInputSchema);
  });
});
