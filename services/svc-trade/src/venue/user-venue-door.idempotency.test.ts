import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { encodeVenueWire, type PlaceUserOrderIntent, type PreparedVenueAction } from '@intafaced/venue-contracts';
import { answerTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, orderKeyOfIdempotencyKey, parseOrdersPageMax } from './user-venue-door.js';

// J-developer-05 (DV-auth-03, DV-rest-01): an order placed over the API with an Idempotency-Key is placed on the venue
// once per key, however it is retried, and the person's orders list a page at a time with each order once. Against the
// TEST venue simulator over loopback HTTP, with its per-account switches.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111d5';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333d5',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-developer-05')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};

/** A limit buy resting under the TEST ladder, so it stays open. The header supplies its key. */
const buy = (amount = '0.01'): PlaceUserOrderIntent =>
  ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a(amount),
    price: a('30000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    builderFee: null,
  }) as unknown as PlaceUserOrderIntent;

describe('UserVenueDoor: an order over the API with an Idempotency-Key (J-developer-05)', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('100000'), 'deposit:test:dev05');
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const switches = async (body: Record<string, unknown>) => {
    const [status] = await answerTestVenue(sim, 'POST', '/test/account-switches', JSON.stringify(encodeVenueWire({ owner, ...body })));
    expect(status).toBe(200);
  };

  function door(ordersPageMax: number | null = 50) {
    const store = new InMemoryPreparedActionStore();
    return {
      store,
      d: new UserVenueDoor({
        connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
        appEnv: 'test',
        store,
        stepUp: noStepUp,
        builder: null,
        now: () => new Date(),
        listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
        ordersPageMax,
      }),
    };
  }

  const openWithId = async (cloid: string) =>
    (await sim.openOrders({ venueId: sim.venue.id, owner, subAccount: null })).value.filter((o) => o.venueClientOrderId === cloid);

  it('the key is sent as the client order id; a retry of the same key and body is the stored answer and one venue order', async () => {
    const { d } = door();
    const header = 'bot-1:order:0001';
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: header });
    expect(prepared.actionKey).toBe(orderKeyOfIdempotencyKey(header));
    expect((prepared.prepared.intent as PlaceUserOrderIntent).clientOrderKey).toBe(orderKeyOfIdempotencyKey(header));
    const signature = await sign(prepared.prepared);
    const first = await d.submit(principal, prepared.actionKey, signature);
    expect(first).toMatchObject({ replayed: false, outcome: { definite: true, accepted: true, order: { status: 'open' } } });

    const again = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: header });
    expect(again).toMatchObject({ reused: true, signed: true });
    const second = await d.submit(principal, again.actionKey, signature);
    expect(second.replayed).toBe(true);
    expect(second.outcome).toEqual(first.outcome);
    expect(await openWithId(prepared.prepared.venueClientOrderId!)).toHaveLength(1);
  });

  it('the same key with a changed quantity is idempotency.conflict, and nothing new reaches the venue', async () => {
    const { d } = door();
    const header = 'bot-1:order:0002';
    const prepared = await d.prepare(principal, { owner, signer, intent: buy('0.01'), idempotencyKey: header });
    await d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
    await expect(d.prepare(principal, { owner, signer, intent: buy('0.02'), idempotencyKey: header })).rejects.toMatchObject({
      code: 'idempotency.conflict',
      status: 409,
    });
    expect(await openWithId(prepared.prepared.venueClientOrderId!)).toHaveLength(1);
  });

  it('a second request with the key while the first is still sending gets idempotency.in_progress', async () => {
    const { d } = door();
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: 'bot-1:order:0003' });
    const signature = await sign(prepared.prepared);
    await switches({ submitDelayMs: 600 });
    try {
      const first = d.submit(principal, prepared.actionKey, signature);
      await new Promise((r) => setTimeout(r, 100));
      await expect(d.submit(principal, prepared.actionKey, signature)).rejects.toMatchObject({
        code: 'idempotency.in_progress',
        status: 409,
      });
      expect((await first).outcome).toMatchObject({ definite: true, accepted: true });
    } finally {
      await switches({ submitDelayMs: 0 });
    }
    // Once the first answered, the claim is given back: a retry is the stored answer.
    expect((await d.submit(principal, prepared.actionKey, signature)).replayed).toBe(true);
    expect(await openWithId(prepared.prepared.venueClientOrderId!)).toHaveLength(1);
  });

  it('a lost answer reads unknown by key while the venue is away, then the venue record once it answers; a retry never makes a second order', async () => {
    const { d, store } = door();
    const header = 'bot-1:order:0004';
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: header });
    const signature = await sign(prepared.prepared);
    await switches({ loseAnswers: 1 });
    const sent = await d.submit(principal, prepared.actionKey, signature);
    expect(sent.outcome).toEqual({ definite: false, reason: 'timeout' });
    expect(sent.readBack).toEqual({ venueClientOrderId: prepared.prepared.venueClientOrderId });

    await switches({ down: true });
    try {
      expect(await d.orderByKey(principal, orderKeyOfIdempotencyKey(header))).toMatchObject({
        state: 'unknown',
        reason: 'venue_down',
        order: null,
      });
      // A retry while the venue is away keeps the answer not definite: never failed, never a new order.
      const retry = await d.submit(principal, prepared.actionKey, signature);
      expect(retry.outcome).toEqual({ definite: false, reason: 'timeout' });
    } finally {
      await switches({ down: false });
    }
    const read = await d.orderByKey(principal, orderKeyOfIdempotencyKey(header));
    expect(read).toMatchObject({ state: 'accepted', order: { status: 'open', venueClientOrderId: prepared.prepared.venueClientOrderId } });
    expect((await store.find(USER, prepared.actionKey))?.lastOutcome).toMatchObject({ definite: true, accepted: true });
    expect((await d.submit(principal, prepared.actionKey, signature)).replayed).toBe(true);
    expect(await openWithId(prepared.prepared.venueClientOrderId!)).toHaveLength(1);
  });

  it('a 5xx after the order was sent is not definite and reads accepted by key once the venue answers; one venue order', async () => {
    const { d } = door();
    const header = 'bot-1:order:0005';
    const prepared = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: header });
    const signature = await sign(prepared.prepared);
    await switches({ failAfterSend: 1 });
    const sent = await d.submit(principal, prepared.actionKey, signature);
    expect(sent.outcome).toEqual({ definite: false, reason: 'venue_error_after_send' });
    expect(await d.orderByKey(principal, orderKeyOfIdempotencyKey(header))).toMatchObject({
      state: 'accepted',
      order: { venueClientOrderId: prepared.prepared.venueClientOrderId },
    });
    expect((await d.submit(principal, prepared.actionKey, signature)).replayed).toBe(true);
    expect(await openWithId(prepared.prepared.venueClientOrderId!)).toHaveLength(1);
  });

  it('lists the orders a page at a time, each once, with an empty next cursor at the end; a blank largest page refuses', async () => {
    const { d } = door();
    const keys: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      const p = await d.prepare(principal, { owner, signer, intent: buy(), idempotencyKey: `bot-1:list:${n}` });
      await d.submit(principal, p.actionKey, await sign(p.prepared));
      keys.push(p.actionKey);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await d.orders(principal, owner, cursor, '2');
      pages += 1;
      expect(page.orders.length).toBeLessThanOrEqual(2);
      seen.push(...page.orders.map((o) => o.actionKey));
      expect(page.orders.every((o) => o.state === 'accepted')).toBe(true);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(keys);

    await expect(d.orders(principal, owner, undefined, '51')).rejects.toMatchObject({ code: 'trade.venue_orders_limit_invalid' });
    await expect(d.orders(principal, owner, 'not-a-cursor', '2')).rejects.toMatchObject({ code: 'trade.invalid_cursor' });
    await expect(door(null).d.orders(principal, owner, undefined, '2')).rejects.toMatchObject({
      code: 'trade.venue_orders_page_max_unset',
      status: 503,
    });
  });

  it('refuses a malformed key, and reads the owner value for the largest page strictly', () => {
    expect(() => orderKeyOfIdempotencyKey('')).toThrow(/Idempotency-Key/);
    expect(() => orderKeyOfIdempotencyKey('has space')).toThrow(/Idempotency-Key/);
    expect(() => orderKeyOfIdempotencyKey('x'.repeat(256))).toThrow(/Idempotency-Key/);
    expect(orderKeyOfIdempotencyKey('x'.repeat(255))).toMatch(/^order:api:[0-9a-f]{64}$/);
    expect(parseOrdersPageMax('')).toBeNull();
    expect(parseOrdersPageMax('50')).toBe(50);
    expect(() => parseOrdersPageMax('0')).toThrow();
    expect(() => parseOrdersPageMax('ten')).toThrow();
  });
});
