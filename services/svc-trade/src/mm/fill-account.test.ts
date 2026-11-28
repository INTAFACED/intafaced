/**
 * trade.mm-bot — orderFilled accountId recovery.
 *
 * Seeded MM fills must carry a recoverable house STP id. Empty / house
 * bookkeeping UUID looks like an anonymous customer fill and must fail.
 */
import { describe, expect, it } from 'vitest';
import { mmSeedJobsArmed } from './seed-honesty.js';
import { HOUSE_MM_USER_UUID, MM_MATCHING_ACCOUNT_ID, looksLikeAnonymousCustomerFill, recoverMatchingAccountId } from './fill-account.js';
import { MemoryEventBus } from '@intafaced/events';
import { subscribeMatchingEvents } from '../events.js';
import { settleFillEvent } from '../spot/trade-service/events.js';
import type { TradeService } from '../spot/trade-service.js';
import type { OrderRecord } from '../spot/types.js';
import { fakeMarket } from '../public-rest.js';
import { partial } from '@intafaced/service-kit/testing';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';

const FILL = {
  marketId: '33333333-3333-4333-8333-333333333333',
  makerOrderId: '44444444-4444-4444-8444-444444444444',
  takerOrderId: '55555555-5555-4555-8555-555555555555',
  price: '100',
  qty: '1',
  sequence: 7,
};

/** The settle path over orders whose rows name these users, recording the accounts each fill settles with. */
function recordingTrade(users: { maker: string; taker: string }) {
  const settled: { makerAccountId: string; takerAccountId: string }[] = [];
  const svc = partial<Parameters<typeof settleFillEvent>[0]>({
    marketById: async (id: string) => fakeMarket({ id }),
    findOrder: async (id: string) =>
      id === FILL.makerOrderId
        ? partial<OrderRecord>({ id, userId: users.maker, side: 'sell' })
        : id === FILL.takerOrderId
          ? partial<OrderRecord>({ id, userId: users.taker, side: 'buy' })
          : null,
    settleFill: async (_market, fill) => void settled.push({ makerAccountId: fill.makerAccountId, takerAccountId: fill.takerAccountId }),
    finalizeIfComplete: async () => undefined,
  });
  return { svc, settled };
}

describe('recoverMatchingAccountId — house MM seed fills', () => {
  it('event house STP id is already recoverable', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: MM_MATCHING_ACCOUNT_ID,
      orderUserId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('omitted event accountId recovers house STP id from recorded seed row', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: '',
      orderUserId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('undefined event accountId recovers the same way as empty', () => {
    const recovered = recoverMatchingAccountId({
      orderUserId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('bookkeeping UUID on the event is rewritten — never left as a customer-looking id', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: HOUSE_MM_USER_UUID,
    });
    expect(recovered).toBe(MM_MATCHING_ACCOUNT_ID);
    expect(looksLikeAnonymousCustomerFill(HOUSE_MM_USER_UUID)).toBe(true);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });

  it('fails the seeded-fill contract when accountId is missing and no house row exists', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: '',
      orderUserId: '',
    });
    expect(recovered).toBe('');
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(true);
  });

  it('does not invent house MM from a live customer order row', () => {
    const recovered = recoverMatchingAccountId({
      eventAccountId: '',
      orderUserId: CUSTOMER,
    });
    expect(recovered).toBe(CUSTOMER);
    expect(looksLikeAnonymousCustomerFill(recovered)).toBe(false);
  });
});

describe('TRADE_MM_SEED_ENABLED kill is unchanged', () => {
  it('jobs stay unarmed when the seed flag is off (same kill as placeOrder seeded path)', () => {
    expect(mmSeedJobsArmed(false, 3)).toBe(false);
    expect(mmSeedJobsArmed(true, 0)).toBe(false);
    expect(mmSeedJobsArmed(true, 2)).toBe(true);
  });
});

describe('production fill/event path — not tests-only', () => {
  it('settleFillEvent recovers maker and taker via recoverMatchingAccountId', async () => {
    // Over a recorded seed row for each leg and an event that names neither account: both legs settle as the house
    // STP id, never as the bookkeeping UUID that would look like an anonymous customer.
    const { svc, settled } = recordingTrade({ maker: HOUSE_MM_USER_UUID, taker: HOUSE_MM_USER_UUID });
    await settleFillEvent(svc, { ...FILL, makerAccountId: '', takerAccountId: undefined });
    expect(settled).toEqual([{ makerAccountId: MM_MATCHING_ACCOUNT_ID, takerAccountId: MM_MATCHING_ACCOUNT_ID }]);
    // A customer's legs fall back to the customer's own id from the order rows.
    const customer = recordingTrade({ maker: CUSTOMER, taker: CUSTOMER });
    await settleFillEvent(customer.svc, { ...FILL, makerAccountId: '', takerAccountId: '' });
    expect(customer.settled).toEqual([{ makerAccountId: CUSTOMER, takerAccountId: CUSTOMER }]);
    // An event that names the account wins over the row.
    const named = recordingTrade({ maker: CUSTOMER, taker: CUSTOMER });
    await settleFillEvent(named.svc, { ...FILL, makerAccountId: MM_MATCHING_ACCOUNT_ID, takerAccountId: CUSTOMER });
    expect(named.settled).toEqual([{ makerAccountId: MM_MATCHING_ACCOUNT_ID, takerAccountId: CUSTOMER }]);
  });

  it('orderFilled bus consumer calls settleFillEvent (live recovery path)', async () => {
    const bus = new MemoryEventBus('svc-matching');
    const delivered: Parameters<TradeService['settleFillEvent']>[0][] = [];
    const { svc, settled } = recordingTrade({ maker: HOUSE_MM_USER_UUID, taker: CUSTOMER });
    const trade = partial<TradeService>({
      settleFillEvent: async (input: Parameters<TradeService['settleFillEvent']>[0]) => {
        delivered.push(input);
        await settleFillEvent(svc, input);
      },
      releaseOnCancelEvent: async () => undefined,
    });
    await subscribeMatchingEvents(bus, trade);
    await bus.publish(
      'orderFilled',
      { ...FILL, ts: '2026-11-28T00:00:00.000Z', makerAccountId: MM_MATCHING_ACCOUNT_ID, takerAccountId: CUSTOMER },
      { idempotencyKey: 'fill:mm:1' },
    );
    // The event's accounts ride through to the settle untouched, and the house maker settles as the house.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      makerOrderId: FILL.makerOrderId,
      makerAccountId: MM_MATCHING_ACCOUNT_ID,
      takerAccountId: CUSTOMER,
    });
    expect(settled).toEqual([{ makerAccountId: MM_MATCHING_ACCOUNT_ID, takerAccountId: CUSTOMER }]);
  });
});
