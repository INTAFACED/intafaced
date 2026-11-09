import { describe, expect, it } from 'vitest';
import type { SupportTicket } from '@intafaced/contracts';
import { MemoryLinkBook, TicketLinks, type PayOwnership } from './ticket-links.js';
import { rankOperatorQueue, RECOVERY_LINK_WEIGHT, CATEGORY_WEIGHT } from './operator-queue.js';
import type { TicketOrderReadResult, TicketOrderSource } from './ticket-order.js';

/**
 * A request's links to the customer's own records (J-support-public-20 #1): only a record its owning service says is the
 * ticket's customer's is linked; another customer's and a missing one refuse the same way; an owner with no answer links
 * nothing; a request linked to a recovery-required order ranks above a withdrawal request of the same age.
 */

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = 'op-1';
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-11-09T12:00:00.000Z');

const ticket = (over: Partial<SupportTicket> = {}): SupportTicket =>
  ({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    userId: CUSTOMER,
    category: 'deposit_withdraw',
    status: 'open',
    subject: 'TEST withdrawal missing',
    createdAt: '2026-11-09T10:00:00.000Z',
    assigneeId: null,
    ...over,
  }) as SupportTicket;

function orders(): TicketOrderSource {
  const snap = (orderId: string, userId: string, status: string): TicketOrderReadResult => ({
    kind: 'order',
    order: { orderId, userId, status, symbol: 'BTC/USDT', side: 'buy', filledQuantity: '0', feeAsset: 'USDT', feeAmount: '0' } as never,
  });
  return {
    async read(id) {
      if (id === MINE) return snap(MINE, CUSTOMER, 'recovery_required');
      if (id === THEIRS) return snap(THEIRS, OTHER, 'open');
      return { kind: 'missing' };
    },
  };
}
const pay = (answer: boolean | null): PayOwnership => ({
  owned: async ({ recordId, userId }) => (answer === null ? null : answer && recordId === MINE && userId === CUSTOMER),
});

function links(t = ticket(), o: TicketOrderSource | null = orders(), p: PayOwnership | null = pay(true)) {
  const book = new MemoryLinkBook();
  return { book, links: new TicketLinks(book, { getTicket: async () => t }, o, p, () => NOW) };
}
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'linked',
    (err: { code?: string }) => err.code,
  );

describe("linking a request to the customer's own record", () => {
  it("links the customer's own order, marking one svc-trade reports recovery_required; linking again is the same link", async () => {
    const { links: desk } = links();
    const first = await desk.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE });
    expect(first).toMatchObject({ kind: 'order', recordId: MINE, recoveryRequired: true, linkedBy: OPERATOR });
    expect(await desk.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE })).toEqual(first);
    expect(await desk.list(OPERATOR, ticket().id)).toHaveLength(1);
  });

  it("refuses another customer's record and a missing one with the same code, and links neither", async () => {
    const { links: desk, book } = links();
    for (const [kind, recordId] of [
      ['order', THEIRS],
      ['order', MISSING],
      ['withdrawal', THEIRS],
      ['deposit', MISSING],
      ['withdrawal', 'not-a-uuid'],
    ] as const)
      expect(await code(desk.link(OPERATOR, { ticketId: ticket().id, kind, recordId }))).toBe('support.link_record_not_owned');
    expect(await book.list(ticket().id)).toEqual([]);
  });

  it("links the customer's own withdrawal on svc-pay's word, never marked recovery-required", async () => {
    const { links: desk } = links();
    expect(await desk.link(OPERATOR, { ticketId: ticket().id, kind: 'withdrawal', recordId: MINE })).toMatchObject({
      kind: 'withdrawal',
      recoveryRequired: false,
    });
  });

  it("links nothing when the owner gave no answer or isn't wired, and nothing on a closed request", async () => {
    const silent: TicketOrderSource = { read: async () => ({ kind: 'unknown', reason: 'trade_silent' }) };
    expect(await code(links(ticket(), silent).links.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE }))).toBe(
      'support.link_record_unverifiable',
    );
    expect(await code(links(ticket(), null).links.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE }))).toBe(
      'support.link_record_unverifiable',
    );
    expect(
      await code(links(ticket(), orders(), pay(null)).links.link(OPERATOR, { ticketId: ticket().id, kind: 'deposit', recordId: MINE })),
    ).toBe('support.link_record_unverifiable');
    expect(
      await code(links(ticket(), orders(), null).links.link(OPERATOR, { ticketId: ticket().id, kind: 'withdrawal', recordId: MINE })),
    ).toBe('support.link_record_unverifiable');
    expect(
      await code(links(ticket({ status: 'closed' })).links.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE })),
    ).toBe('support.ticket_closed');
  });
});

describe('the queue ranks a recovery-required order first', () => {
  it('a request linked to a recovery-required order ranks above a withdrawal request of the same age', () => {
    expect(RECOVERY_LINK_WEIGHT).toBeGreaterThan(CATEGORY_WEIGHT.deposit_withdraw!);
    const withdrawal = ticket({
      id: '11111111-0000-4000-8000-000000000001',
      category: 'deposit_withdraw',
      createdAt: '2026-11-09T09:00:00.000Z',
    });
    const stuck = ticket({ id: '11111111-0000-4000-8000-000000000002', category: 'trading', createdAt: '2026-11-09T09:00:00.000Z' });
    expect(rankOperatorQueue([withdrawal, stuck], NOW).map((e) => e.ticketId)).toEqual([withdrawal.id, stuck.id]);
    expect(rankOperatorQueue([withdrawal, stuck], NOW, new Set([stuck.id])).map((e) => e.ticketId)).toEqual([stuck.id, withdrawal.id]);
  });
});

describe('the queue reads each linked order from svc-trade as it ranks', () => {
  const T1 = '11111111-0000-4000-8000-0000000000a1';
  const T2 = '11111111-0000-4000-8000-0000000000a2';
  const T3 = '11111111-0000-4000-8000-0000000000a3';
  const O1 = 'aaaaaaaa-0000-4000-8000-0000000000b1';
  const O2 = 'aaaaaaaa-0000-4000-8000-0000000000b2';
  const O3 = 'aaaaaaaa-0000-4000-8000-0000000000b3';
  const link = (ticketId: string, recordId: string, recoveryRequired: boolean) => ({
    ticketId,
    kind: 'order' as const,
    recordId,
    recoveryRequired,
    linkedBy: OPERATOR,
    linkedAt: NOW.toISOString(),
  });
  const snap = (orderId: string, status: string): TicketOrderReadResult => ({
    kind: 'order',
    order: {
      orderId,
      userId: CUSTOMER,
      status,
      symbol: 'BTC/USDT',
      side: 'buy',
      filledQuantity: '0',
      feeAsset: 'USDT',
      feeAmount: '0',
    } as never,
  });

  it('a hold resolved since the link stops ranking first, one now unresolved starts, and a silent read keeps the link-time status', async () => {
    const book = new MemoryLinkBook();
    await book.put(link(T1, O1, true)); // recovery_required at link time, filled now
    await book.put(link(T2, O2, false)); // open at link time, hold_unknown now
    await book.put(link(T3, O3, true)); // recovery_required at link time, svc-trade silent now
    const now: TicketOrderSource = {
      async read(id) {
        if (id === O1) return snap(O1, 'filled');
        if (id === O2) return snap(O2, 'hold_unknown');
        return { kind: 'unknown', reason: 'trade_silent' };
      },
    };
    const desk = new TicketLinks(book, { getTicket: async () => ticket() }, now, null, () => NOW);
    expect([...(await desk.recoveryTickets())].sort()).toEqual([T2, T3]);
  });

  it('with svc-trade not wired, every link ranks by its link-time status', async () => {
    const book = new MemoryLinkBook();
    await book.put(link(T1, O1, true));
    await book.put(link(T2, O2, false));
    expect([...(await new TicketLinks(book, { getTicket: async () => ticket() }, null, null, () => NOW).recoveryTickets())]).toEqual([T1]);
  });
});

describe('an order whose fees were charged in more than one asset', () => {
  it('links on its owner and status alone, and refuses it for another customer', async () => {
    const mixed = (userId: string, status: string): TicketOrderSource => ({
      read: async (orderId) => ({ kind: 'fee_mixed', owner: { orderId, userId, status } as never }),
    });
    expect(
      await links(ticket(), mixed(CUSTOMER, 'hold_unknown')).links.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE }),
    ).toMatchObject({
      kind: 'order',
      recoveryRequired: true,
    });
    expect(
      await code(links(ticket(), mixed(OTHER, 'open')).links.link(OPERATOR, { ticketId: ticket().id, kind: 'order', recordId: MINE })),
    ).toBe('support.link_record_not_owned');
  });
});
