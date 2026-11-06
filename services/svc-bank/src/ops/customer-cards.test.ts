import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import type { BankServices } from '../bank-service.js';
import type { CardRecord } from '../cards/card-service.js';
import { presentCard } from '../cards/card-view.js';

/**
 * `bank.ops.customerCards` through the real router and edge context: the console reads one customer's cards with
 * `admin:treasury` only, every status including closed, through the owner list's own query; every read is logged with operator
 * and customer before any card is read, and a customer's own session is refused.
 */

const SECRET = 'a-bank-customer-cards-edge-secret-long-enough';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

function signed(userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-desk',
  });
}

const card = (id: string, userId: string, status: CardRecord['status'], extra: Partial<CardRecord> = {}): CardRecord => ({
  id,
  userId,
  assetId: 'USDT',
  settlementAssetId: 'USDT',
  issuer: 'sim',
  simulated: true,
  issuerRef: 'issuer-secret-ref',
  panTail: '4242',
  status,
  cashbackBps: 0,
  perAuthorizationLimit: amt('50'),
  dailyLimit: null,
  monthlyLimit: null,
  cashLimit: null,
  online: true,
  contactless: true,
  atm: true,
  abroad: true,
  cardType: 'virtual',
  shippingAddress: null,
  replacesCardId: null,
  replacedByCardId: null,
  replaceReason: null,
  frozenBy: null,
  ...extra,
});

const OPEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLOSED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function build(rows: CardRecord[]) {
  const asked: Array<{ userId: string; limit: number }> = [];
  const cards = {
    cardsPage: async (userId: string, limit: number) => {
      asked.push({ userId, limit });
      return rows.filter((r) => r.userId === userId).slice(0, limit);
    },
  };
  const router = createBankRouter({ cards } as unknown as BankServices);
  return { asked, as: (userId: string, scopes: string[]) => router.createCaller(signed(userId, scopes)) };
}

describe('console customer cards', () => {
  it("lists the named customer's cards, a closed one included, with no secret, and logs the read first", async () => {
    const order: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => void order.push('audit'));
    const { as, asked } = build([
      card(OPEN, CUSTOMER, 'active', { activatedAt: null }),
      card(CLOSED, CUSTOMER, 'closed', {
        cardType: 'physical',
        shippingAddress: {
          name: 'TEST',
          line1: '1 Home Street',
          line2: null,
          city: 'Berlin',
          region: null,
          postalCode: '10115',
          country: 'DE',
        },
      }),
      card('cccccccc-cccc-4ccc-8ccc-cccccccccccc', OTHER, 'active'),
    ]);
    const caller = as(OPERATOR, ['admin:treasury']);
    const out = await caller.ops.customerCards({ userId: CUSTOMER, limit: 50 });
    expect(asked).toEqual([{ userId: CUSTOMER, limit: 50 }]);
    expect(out.userId).toBe(CUSTOMER);
    expect(out.cards.map((c) => [c.id, c.status])).toEqual([
      [OPEN, 'inactive'],
      [CLOSED, 'closed'],
    ]);
    expect(out.cards[1]).toMatchObject({ simulated: true, panTail: '4242', perAuthorizationLimit: '50', cardType: 'physical' });
    expect(out.cards[1]).not.toHaveProperty('shippingAddress');
    const text = JSON.stringify(out);
    expect(text).not.toContain('issuer-secret-ref');
    expect(text).not.toContain('Home Street');
    expect(text).not.toMatch(/shippingAddress|issuerRef|pan"|cvv|pin"/i);
    expect(order).toEqual(['audit']);
    const line = JSON.parse(String(info.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({ event: 'bank.ops.customer_cards_read', actorUserId: OPERATOR, ownerUserId: CUSTOMER });
    info.mockRestore();
  });

  it("gives the owner's own view of each card, field for field, without the shipping address", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const rows = [card(OPEN, CUSTOMER, 'frozen', { dailyLimit: amt('100'), usesAllowed: 1 }), card(CLOSED, CUSTOMER, 'closed')];
    const { as } = build(rows);
    const out = await as(OPERATOR, ['admin:treasury']).ops.customerCards({ userId: CUSTOMER, limit: 50 });
    expect(out.cards).toEqual(
      rows.map((r) => {
        const { shippingAddress: _home, ...view } = presentCard(r);
        return view;
      }),
    );
    info.mockRestore();
  });

  it('writes the audit line before the cards are read', async () => {
    const order: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => void order.push('audit'));
    const cards = {
      cardsPage: async () => {
        order.push('read');
        return [];
      },
    };
    const router = createBankRouter({ cards } as unknown as BankServices);
    const out = await router.createCaller(signed(OPERATOR, ['admin:treasury'])).ops.customerCards({ userId: CUSTOMER, limit: 10 });
    expect(out.cards).toEqual([]);
    expect(order).toEqual(['audit', 'read']);
    info.mockRestore();
  });

  it('refuses a customer session, even for their own id, and an operator without the treasury scope, and reads nothing', async () => {
    const { as, asked } = build([card(CLOSED, CUSTOMER, 'closed')]);
    await expect(as(CUSTOMER, ['bank:read', 'bank:write']).ops.customerCards({ userId: CUSTOMER, limit: 50 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(as(OPERATOR, ['admin:compliance', 'admin:read']).ops.customerCards({ userId: CUSTOMER, limit: 50 })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
    expect(asked).toEqual([]);
  });

  it('refuses a blank page size by its code, a smuggled field and a non-uuid customer, and reads nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { as, asked } = build([card(CLOSED, CUSTOMER, 'closed')]);
    const op = as(OPERATOR, ['admin:treasury']);
    await expect(op.ops.customerCards({ userId: CUSTOMER })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: expect.objectContaining({ code: 'bank.cards_list_limit_unset' }),
    });
    await expect(op.ops.customerCards({ userId: 'nope', limit: 5 })).rejects.toBeDefined();
    await expect(op.ops.customerCards({ userId: CUSTOMER, limit: 201 })).rejects.toBeDefined();
    await expect(op.ops.customerCards({ userId: CUSTOMER, limit: 5, extra: 1 } as never)).rejects.toBeDefined();
    expect(asked).toEqual([]);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('refuses the read when the audit line cannot be written, and reads nothing', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('log sink down');
    });
    const { as, asked } = build([card(CLOSED, CUSTOMER, 'closed')]);
    await expect(as(OPERATOR, ['admin:treasury']).ops.customerCards({ userId: CUSTOMER, limit: 50 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: expect.objectContaining({ code: 'bank.ops_audit_unavailable' }),
    });
    expect(asked).toEqual([]);
    info.mockRestore();
  });
});
