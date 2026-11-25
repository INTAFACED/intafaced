import { describe, expect, it } from 'vitest';
import type { SupportTicket } from '@intafaced/contracts';
import { MemoryReadGrantBook, ReadGrants, type ReadOwners } from './read-grants.js';
import { SupportError } from './support-service.js';
import type { VerificationAuditRow } from './verification-checks.js';

/**
 * J-support-public-20 #2 (RC-support-public-01; owner row d115): the desk reads a customer's balance or withdrawal
 * destination only under the customer's own grant for a set time. The branches the router test does not reach: a closed
 * request, a read that cannot be listed, an owner that throws, and who may grant.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const TICKET = '55555555-5555-4555-8555-555555555555';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = new Date('2026-11-23T03:00:00.000Z');

function desk(owners: ReadOwners = { balance: async () => ({ USDT: { free: '20', used: '0', total: '20' } }) }) {
  const book = new MemoryReadGrantBook();
  const ticket = { status: 'open' as SupportTicket['status'] };
  const clock = { at: AT };
  const trail: VerificationAuditRow[] = [];
  const reads = new ReadGrants({
    book,
    support: {
      // The desk sees the request; its customer sees it; nobody else does.
      getTicket: async (input) => {
        if (input.ticketId !== TICKET || (input.asOperator !== true && input.userId !== CUSTOMER))
          throw new SupportError('ticket not found', 'support.not_found');
        return { id: TICKET, userId: CUSTOMER, status: ticket.status } as SupportTicket;
      },
    },
    linkedWithdrawals: async () => [W1],
    owners,
    audit: async (row) => void trail.push(row),
    now: () => clock.at,
  });
  return { reads, book, ticket, clock, trail };
}

describe("a customer's grant for support to read", () => {
  it('a closed request takes no grant and opens no read, even under a grant given before it closed', async () => {
    const { reads, ticket, book, trail } = desk();
    await reads.grant(CUSTOMER, { ticketId: TICKET, seconds: 600 });
    ticket.status = 'closed';
    await expect(reads.grant(CUSTOMER, { ticketId: TICKET, seconds: 60 })).rejects.toMatchObject({ code: 'support.ticket_closed' });
    await expect(reads.read(OPERATOR, TICKET, 'balance')).rejects.toMatchObject({ code: 'support.ticket_closed' });
    expect(book.grants).toHaveLength(1);
    expect(book.rows).toEqual([]);
    expect(trail.map((row) => row.outcome)).toEqual(['support.ticket_closed']);
  });

  it('only the request’s own customer grants: an operator who can open the request cannot give the permission', async () => {
    const { reads, book } = desk();
    await expect(reads.grant(OPERATOR, { ticketId: TICKET, seconds: 60 })).rejects.toMatchObject({ code: 'support.not_found' });
    await expect(reads.access(OPERATOR, TICKET)).rejects.toMatchObject({ code: 'support.not_found' });
    expect(book.grants).toEqual([]);
  });

  it('a read that cannot be listed to the customer is not answered', async () => {
    const { reads, book, trail } = desk();
    await reads.grant(CUSTOMER, { ticketId: TICKET, seconds: 60 });
    book.recordRead = async () => {
      throw new Error('the list is down');
    };
    await expect(reads.read(OPERATOR, TICKET, 'balance')).rejects.toThrow('the list is down');
    expect(trail.map((row) => row.outcome)).not.toContain('read');
  });

  it('an owner that throws is no answer: refused naming it, nothing listed, and the ask is on the desk’s audit', async () => {
    const { reads, book, trail } = desk({
      balance: async () => {
        throw new Error('timeout');
      },
    });
    await reads.grant(CUSTOMER, { ticketId: TICKET, seconds: 60 });
    await expect(reads.read(OPERATOR, TICKET, 'balance')).rejects.toMatchObject({
      code: 'support.disclosure_unwired',
      missingKey: 'svc-trade',
    });
    expect(book.rows).toEqual([]);
    expect(trail).toEqual([
      {
        ticketId: TICKET,
        action: 'disclosure',
        kind: 'balance',
        outcome: 'support.disclosure_unwired',
        operator: OPERATOR,
        at: AT.toISOString(),
      },
    ]);
  });

  it('an answered read is one row for the customer and one audit row for the desk, and stores no figure', async () => {
    const { reads, book, trail, clock } = desk();
    await reads.grant(CUSTOMER, { ticketId: TICKET, seconds: 60 });
    clock.at = new Date(AT.getTime() + 5_000);
    const answer = await reads.read(OPERATOR, TICKET, 'balance');
    expect(answer).toMatchObject({ kind: 'balance', balances: { USDT: { total: '20' } } });
    expect(book.rows).toEqual([{ ticketId: TICKET, kind: 'balance', readBy: OPERATOR, readAt: clock.at.toISOString() }]);
    expect(trail.map((row) => [row.action, row.kind, row.outcome, row.operator])).toEqual([['disclosure', 'balance', 'read', OPERATOR]]);
    expect(JSON.stringify([book.rows, book.grants, trail])).not.toContain('"20"');
  });
});
