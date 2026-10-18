/**
 * SUP-0007. A support:ops read of an order is accepted only when the order
 * user is the ticket user. The read returns status (including
 * recovery_required), symbol, side, filled quantity, fee asset, and fee
 * amount. It posts nothing and does not cancel, amend, or delete the order.
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { type SupportOrderSnapshot, type TicketOrderReadResult, type TicketOrderSource } from './ticket-order.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'a-support-mount-test-edge-secret-long';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-support' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '44444444-4444-4444-8444-444444444444',
    scopes: ['support:ops'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-s28',
  });
}

interface StoredOrder extends SupportOrderSnapshot {
  readonly deleted: boolean;
}

class TradeBook implements TicketOrderSource {
  readonly posts: string[] = [];
  readonly cancels: string[] = [];
  readonly amends: string[] = [];
  readonly deletes: string[] = [];
  silent = false;
  matcherDown = false;

  constructor(private readonly orders: Map<string, StoredOrder>) {}

  async read(orderId: string): Promise<TicketOrderReadResult> {
    if (this.matcherDown) return { kind: 'unknown', reason: 'matcher_down' };
    if (this.silent) return { kind: 'unknown', reason: 'trade_silent' };
    const order = this.orders.get(orderId);
    if (!order || order.deleted) return { kind: 'unknown', reason: 'trade_silent' };
    return {
      kind: 'order',
      order: {
        orderId: order.orderId,
        userId: order.userId,
        status: order.status,
        symbol: order.symbol,
        side: order.side,
        filledQuantity: order.filledQuantity,
        feeAsset: order.feeAsset,
        feeAmount: order.feeAmount,
      },
    };
  }

  laterRead(orderId: string): StoredOrder | undefined {
    return this.orders.get(orderId);
  }
}

function recoveryOrder(userId: string): StoredOrder {
  return {
    orderId: ORDER,
    userId,
    status: 'recovery_required',
    symbol: 'BTC/USDT',
    side: 'buy',
    filledQuantity: '0.00',
    feeAsset: 'USDT',
    feeAmount: '0.00',
    deleted: false,
  };
}

async function desk(book: TradeBook) {
  const support = new SupportService(undefined, undefined, undefined, undefined, book);
  const ticket = await support.createTicket({
    userId: USER,
    category: 'trading',
    subject: 'Order stuck',
    body: 'Please read the order',
  });
  return { support, ticket };
}

describe('SUP-0007 support reads the ticket user order', () => {
  it('returns recovery_required and a later trade read still shows that order', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    const { support, ticket } = await desk(book);

    const read = await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });

    expect(read).toEqual({
      outcome: 'read',
      orderId: ORDER,
      status: 'recovery_required',
      symbol: 'BTC/USDT',
      side: 'buy',
      filledQuantity: '0.00',
      feeAsset: 'USDT',
      feeAmount: '0.00',
    });
    expect(book.laterRead(ORDER)).toMatchObject({ status: 'recovery_required', deleted: false, userId: USER });
    expect(book.posts).toEqual([]);
    expect(book.cancels).toEqual([]);
    expect(book.amends).toEqual([]);
    expect(book.deletes).toEqual([]);
  });

  it('refuses an order whose user is not the ticket user and leaves that order unchanged', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(OTHER)]]));
    const { support, ticket } = await desk(book);

    await expect(support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER })).rejects.toMatchObject({
      code: 'support.order.user_mismatch',
    });
    expect(book.laterRead(ORDER)).toMatchObject({ status: 'recovery_required', userId: OTHER, deleted: false });
    expect(book.cancels).toEqual([]);
    expect(book.deletes).toEqual([]);
    expect(book.posts).toEqual([]);
  });

  it('returns unknown and not cancelled when trade does not answer', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    book.silent = true;
    const { support, ticket } = await desk(book);

    const read = await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });

    expect(read).toEqual({ outcome: 'unknown', orderId: ORDER, reason: 'trade_silent', cancelled: false });
    expect(book.laterRead(ORDER)?.status).toBe('recovery_required');
    expect(book.cancels).toEqual([]);
  });

  it('a second read does not cancel', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    const { support, ticket } = await desk(book);

    const first = await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });
    const second = await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });

    expect(first).toMatchObject({ outcome: 'read', status: 'recovery_required' });
    expect(second).toMatchObject({ outcome: 'read', status: 'recovery_required' });
    expect(book.laterRead(ORDER)?.status).toBe('recovery_required');
    expect(book.cancels).toEqual([]);
    expect(book.deletes).toEqual([]);
  });

  it('matcher down does not delete the order', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    book.matcherDown = true;
    const { support, ticket } = await desk(book);

    const read = await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });

    expect(read).toEqual({ outcome: 'unknown', orderId: ORDER, reason: 'matcher_down', cancelled: false });
    expect(book.laterRead(ORDER)).toMatchObject({ status: 'recovery_required', deleted: false });
    expect(book.deletes).toEqual([]);
    expect(book.cancels).toEqual([]);
  });

  it('the read posts nothing', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    const { support, ticket } = await desk(book);

    await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });

    expect(book.posts).toEqual([]);
    expect(book.laterRead(ORDER)?.status).toBe('recovery_required');
  });

  it('keeps the fee and filled quantity as the decimal strings trade returned', async () => {
    const stored = recoveryOrder(USER);
    const exact = { ...stored, filledQuantity: '1.250000000000000000', feeAmount: '0.100000000000000000' };
    const book = new TradeBook(new Map([[ORDER, exact]]));
    const { support, ticket } = await desk(book);

    const read = await support.readTicketOrder({ operatorId: OP, ticketId: ticket.id, orderId: ORDER });

    expect(read).toMatchObject({
      outcome: 'read',
      filledQuantity: '1.250000000000000000',
      feeAmount: '0.100000000000000000',
    });
  });

  it('exposes the read on support:ops and refuses a caller without that scope', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    const { support, ticket } = await desk(book);
    const router = createSupportRouter(support);
    const operator = router.createCaller(signed());
    const customer = router.createCaller(signed(principal({ userId: USER, sub: USER, scopes: ['support:read', 'support:write'] })));

    expect(await operator.ticketOrder({ ticketId: ticket.id, orderId: ORDER })).toMatchObject({
      outcome: 'read',
      status: 'recovery_required',
    });
    await expect(customer.ticketOrder({ ticketId: ticket.id, orderId: ORDER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(book.laterRead(ORDER)?.status).toBe('recovery_required');
    expect(book.cancels).toEqual([]);
  });

  it('refuses a userId on the read so the ticket, not the caller, names the customer', async () => {
    const book = new TradeBook(new Map([[ORDER, recoveryOrder(USER)]]));
    const { support, ticket } = await desk(book);
    const operator = createSupportRouter(support).createCaller(signed());

    await expect(
      operator.ticketOrder({ ticketId: ticket.id, orderId: ORDER, userId: OTHER } as { ticketId: string; orderId: string }),
    ).rejects.toBeTruthy();
    expect(book.cancels).toEqual([]);
  });
});
