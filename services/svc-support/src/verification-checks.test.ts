import { describe, expect, it } from 'vitest';
import type { SupportTicket } from '@intafaced/contracts';
import { MemoryCheckBook, tradeOrderOwnership, VerificationChecks, type RecordOwnershipAnswer } from './verification-checks.js';
import type { TicketOrderReadResult, TicketOrderSource } from './ticket-order.js';
import { SupportError } from './support-service.js';

/**
 * J-support-public-20 #2: the customer's balance or withdrawal destination is refused until two checks the customer can
 * confirm are recorded. A check is a record the owning service says is the ticket customer's; nothing else counts, and the
 * open gate still reads nothing.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';
const TICKET = '55555555-5555-4555-8555-555555555555';
const HIDDEN = '77777777-7777-4777-8777-777777777777';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = '00000000-0000-4000-8000-000000000000';
const AT = new Date('2026-11-02T02:00:00.000Z');

/** svc-pay as a table of (kind, id) → owner; every question asked is kept. */
function svcPay(answer?: boolean | null): RecordOwnershipAnswer & { asked: unknown[] } {
  const records: Record<string, string> = { [`withdrawal:${W1}`]: CUSTOMER, [`deposit:${D1}`]: CUSTOMER, [`deposit:${THEIRS}`]: OTHER };
  const asked: unknown[] = [];
  return {
    asked,
    async owns(input) {
      asked.push(input);
      if (answer !== undefined) return answer;
      return records[`${input.recordKind}:${input.recordId}`] === input.userId;
    },
  };
}

function desk(owners: ConstructorParameters<typeof VerificationChecks>[2] = {}) {
  const reads: unknown[] = [];
  const ticket = { status: 'open' as SupportTicket['status'] };
  const checks = new VerificationChecks(
    new MemoryCheckBook(),
    {
      getTicket: async (input) => {
        reads.push(input);
        if (input.ticketId !== TICKET) throw new SupportError('ticket not found', 'support.not_found');
        return { id: TICKET, userId: CUSTOMER, status: ticket.status } as SupportTicket;
      },
    },
    owners,
    () => AT,
  );
  return { checks, reads, ticket };
}

const owned = (recordKind: 'withdrawal' | 'deposit' | 'order', recordId: string, ticketId = TICKET) =>
  ({ ticketId, kind: 'owned_record', recordKind, recordId }) as const;

describe('the balance disclosure gate', () => {
  it('as on main, no owner answers: the balance and the destination refuse for want of checks, and no check can be written', async () => {
    const { checks } = desk();
    await expect(checks.customerBalance(OPERATOR, TICKET)).rejects.toMatchObject({
      code: 'support.verification_checks_required',
      missingKey: '0 of 2 recorded',
    });
    await expect(checks.customerWithdrawalDestination(OPERATOR, TICKET)).rejects.toMatchObject({
      code: 'support.verification_checks_required',
    });
    await expect(checks.record(OPERATOR, owned('withdrawal', W1))).rejects.toMatchObject({
      code: 'support.verification_check_owner_unwired',
      missingKey: 'svc-pay',
    });
    await expect(checks.record(OPERATOR, owned('order', W1))).rejects.toMatchObject({
      code: 'support.verification_check_owner_unwired',
      missingKey: 'svc-trade',
    });
    expect(await checks.list(OPERATOR, TICKET)).toEqual({ required: 2, checks: [] });
  });

  it("records a check only for a record the owner says is the ticket customer's, and asks about the ticket's customer", async () => {
    const pay = svcPay();
    const { checks } = desk({ 'svc-pay': pay });
    const check = await checks.record(OPERATOR, owned('withdrawal', W1.toUpperCase()));
    expect(check).toEqual({
      ticketId: TICKET,
      kind: 'owned_record',
      recordKind: 'withdrawal',
      recordId: W1,
      recordedBy: OPERATOR,
      recordedAt: AT.toISOString(),
    });
    expect(pay.asked).toEqual([{ recordKind: 'withdrawal', recordId: W1, userId: CUSTOMER }]);
    // Another customer's record, a missing one and the right id under the wrong kind refuse alike, and write nothing.
    for (const [kind, id] of [
      ['deposit', THEIRS],
      ['withdrawal', MISSING],
      ['deposit', W1],
    ] as const)
      await expect(checks.record(OPERATOR, owned(kind, id))).rejects.toMatchObject({
        code: 'support.verification_check_not_owned',
        missingKey: undefined,
      });
    expect((await checks.list(OPERATOR, TICKET)).checks).toEqual([check]);
  });

  it('one record recorded twice is one check, and the gate stays shut', async () => {
    const pay = svcPay();
    const { checks } = desk({ 'svc-pay': pay });
    const first = await checks.record(OPERATOR, owned('withdrawal', W1));
    expect(await checks.record('another-operator', owned('withdrawal', W1))).toEqual(first);
    expect(pay.asked).toHaveLength(1);
    await expect(checks.customerBalance(OPERATOR, TICKET)).rejects.toMatchObject({
      code: 'support.verification_checks_required',
      missingKey: '1 of 2 recorded',
    });
  });

  it('two checks on two records open the gate, and the read still refuses: the desk has no read of either', async () => {
    const { checks } = desk({ 'svc-pay': svcPay() });
    await checks.record(OPERATOR, owned('withdrawal', W1));
    await checks.record(OPERATOR, owned('deposit', D1));
    await expect(checks.customerBalance(OPERATOR, TICKET)).rejects.toMatchObject({ code: 'support.balance_read_unwired' });
    await expect(checks.customerWithdrawalDestination(OPERATOR, TICKET)).rejects.toMatchObject({
      code: 'support.withdrawal_destination_read_unwired',
    });
  });

  it('an owner that gives no verified answer refuses naming it, and writes nothing', async () => {
    const { checks } = desk({ 'svc-pay': svcPay(null) });
    await expect(checks.record(OPERATOR, owned('deposit', D1))).rejects.toMatchObject({
      code: 'support.verification_check_owner_unreachable',
      missingKey: 'svc-pay',
    });
    expect((await checks.list(OPERATOR, TICKET)).checks).toEqual([]);
  });

  it('a ticket the operator may not see answers as not found on every door, before any owner is asked', async () => {
    const pay = svcPay(true);
    const { checks, reads } = desk({ 'svc-pay': pay });
    for (const call of [
      () => checks.record(OPERATOR, owned('withdrawal', W1, HIDDEN)),
      () => checks.list(OPERATOR, HIDDEN),
      () => checks.customerBalance(OPERATOR, HIDDEN),
      () => checks.customerWithdrawalDestination(OPERATOR, HIDDEN),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'support.not_found' });
    expect(pay.asked).toEqual([]);
    expect(reads.every((r) => JSON.stringify(r) === JSON.stringify({ userId: OPERATOR, ticketId: HIDDEN, asOperator: true }))).toBe(true);
  });

  it('a closed request takes no check and opens no read, even with two checks recorded before it closed', async () => {
    const pay = svcPay();
    const { checks, ticket } = desk({ 'svc-pay': pay });
    await checks.record(OPERATOR, owned('withdrawal', W1));
    await checks.record(OPERATOR, owned('deposit', D1));
    ticket.status = 'closed';
    await expect(checks.record(OPERATOR, owned('withdrawal', MISSING))).rejects.toMatchObject({ code: 'support.ticket_closed' });
    await expect(checks.customerBalance(OPERATOR, TICKET)).rejects.toMatchObject({ code: 'support.ticket_closed' });
    await expect(checks.customerWithdrawalDestination(OPERATOR, TICKET)).rejects.toMatchObject({ code: 'support.ticket_closed' });
    expect(pay.asked).toHaveLength(2);
  });
});

describe("svc-trade's answer for an order", () => {
  const ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const snapshot = (orderId: string, userId: string): TicketOrderReadResult => ({
    kind: 'order',
    order: { orderId, userId, status: 'filled', symbol: 'BTC/USDT', side: 'buy', filledQuantity: '1', feeAsset: 'USDT', feeAmount: '0' },
  });
  const trade = (read: (id: string) => TicketOrderReadResult): TicketOrderSource & { asked: string[] } => {
    const asked: string[] = [];
    return { asked, read: async (id) => (asked.push(id), read(id)) };
  };

  it("records an order the read says is the ticket customer's, and refuses another customer's with nothing written", async () => {
    const orders = trade((id) => snapshot(id, id === ORDER ? CUSTOMER.toUpperCase() : OTHER));
    const { checks } = desk({ 'svc-trade': tradeOrderOwnership(orders) });
    expect(await checks.record(OPERATOR, owned('order', ORDER))).toMatchObject({ recordKind: 'order', recordId: ORDER });
    await expect(checks.record(OPERATOR, owned('order', THEIRS))).rejects.toMatchObject({ code: 'support.verification_check_not_owned' });
    expect((await checks.list(OPERATOR, TICKET)).checks).toHaveLength(1);
    expect(orders.asked).toEqual([ORDER, THEIRS]);
  });

  it('no order read (route unserved, trade silent, matcher down) or a snapshot of another order is no answer, never a yes', async () => {
    for (const read of [
      (): TicketOrderReadResult => ({ kind: 'unknown', reason: 'trade_silent' }),
      (): TicketOrderReadResult => ({ kind: 'unknown', reason: 'matcher_down' }),
      (): TicketOrderReadResult => snapshot(THEIRS, CUSTOMER),
    ]) {
      const { checks } = desk({ 'svc-trade': tradeOrderOwnership(trade(read)) });
      await expect(checks.record(OPERATOR, owned('order', ORDER))).rejects.toMatchObject({
        code: 'support.verification_check_owner_unreachable',
        missingKey: 'svc-trade',
      });
      expect((await checks.list(OPERATOR, TICKET)).checks).toEqual([]);
    }
  });

  it('answers for orders alone', async () => {
    const orders = trade((id) => snapshot(id, CUSTOMER));
    expect(await tradeOrderOwnership(orders).owns({ recordKind: 'withdrawal', recordId: W1, userId: CUSTOMER })).toBeNull();
    expect(orders.asked).toEqual([]);
  });
});
