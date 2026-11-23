import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount as a } from '@intafaced/ledger-client/money';
import { partial } from '@intafaced/service-kit/testing';
import type { PlaceUserOrderIntent, UserVenue, UserVenueAccount, UserVenueMarket, UserVenuePosition } from '@intafaced/venue-contracts';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-derivatives-04 #6 in one place_orders batch: the batch's earlier orders count as resting beside the venue's own, so a
// batch can't place two whole take profits (or two whole stop losses) that one by one would be refused. Every figure is TEST.
describe('UserVenueDoor.prepare: J-derivatives-04 #6 whole-position close rule on place_orders', () => {
  it('judges each order of a batch with its earlier siblings as resting', async () => {
    const USER = '11111111-1111-4111-8111-1111111111f6';
    const OWNER = '0x1111111111111111111111111111111111111111';
    const VENUE_ID = 'sim-venue';
    const BUILDER = { address: '0x00000000000000000000000000000000000000b9', feeBps: a('1') };
    const now = new Date('2026-11-20T00:00:00Z');
    const principal = {
      sub: USER,
      userId: USER,
      sid: '33333333-3333-4333-8333-3333333333f6',
      scopes: ['trade:read', 'trade:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    } as Principal;

    const market: UserVenueMarket = {
      symbol: 'ETH-PERP',
      kind: 'perpetual',
      baseAsset: 'ETH',
      quoteAsset: 'USDC',
      tickSize: a('0.1'),
      lotSize: a('0.001'),
      minNotional: a('1'),
      makerFeeBps: { known: true, value: a('1') },
      takerFeeBps: { known: true, value: a('2') },
      mark: { known: true, value: a('3000') },
    };
    const pos: UserVenuePosition = {
      symbol: 'ETH-PERP',
      side: 'long',
      size: a('1'),
      entryPrice: a('3000'),
      markPrice: a('3000'),
      marginMode: 'isolated',
      margin: a('600'),
      leverageBps: 50_000,
      unrealisedPnl: 0n,
      liquidationPrice: a('2400'),
    };
    const venue = partial<UserVenue>({
      venue: { id: VENUE_ID, displayName: 'TEST Sim', environment: 'test', batchOrders: true },
      markets: async () => ({ value: [market], asOf: now }),
      positions: async () => ({ value: [pos], asOf: now }),
      openOrders: async () => ({ value: [], asOf: now }),
      builderFeeApproval: async () => ({ value: { approved: true, maxFeeBps: a('5') }, asOf: now }),
      prepare: async (acct: UserVenueAccount, signer: { role: 'owner'; address: string }, intent: unknown) => ({
        venueId: VENUE_ID,
        account: acct,
        signer,
        intent,
        typedData: {},
        digest: '0x' + '22'.repeat(32),
        nonce: '1',
        venueClientOrderId: null,
        preparedAt: now,
      }),
    });

    const store = new InMemoryPreparedActionStore();
    const door = new UserVenueDoor({
      connect: async () => venue,
      appEnv: 'test',
      store,
      stepUp: { require: async () => ({ stepUpEventId: 's', consumedAt: null, replayed: false }) } as StepUpCheck,
      builder: BUILDER,
      listings: new StoreVenueRoutingGate(listedTestStore(['ETH-PERP'], VENUE_ID)),
      slippageCapBps: null,
      now: () => now,
    });

    const tp = (actionKey: string, part: string, triggerPrice: string, amount = '1'): PlaceUserOrderIntent => ({
      kind: 'place_order',
      symbol: 'ETH-PERP',
      side: 'sell',
      type: 'market',
      amount: a(amount),
      price: a('3135'),
      timeInForce: 'IOC',
      reduceOnly: true,
      trigger: { price: a(triggerPrice), source: 'mark', role: 'take_profit' },
      clientOrderKey: `${actionKey}:${part}`,
      builderFee: null,
    });
    const sl = (actionKey: string, part: string, triggerPrice: string): PlaceUserOrderIntent => ({
      ...tp(actionKey, part, triggerPrice),
      price: a('2660'),
      trigger: { price: a(triggerPrice), source: 'mark', role: 'stop_loss' },
    });
    const limit = (actionKey: string, part: string): PlaceUserOrderIntent => ({
      ...tp(actionKey, part, '0'),
      type: 'limit',
      price: a('3300'),
      timeInForce: 'GTC',
      trigger: null,
    });
    const batch = (name: string, orders: (k: string) => PlaceUserOrderIntent[]) => {
      const actionKey = `batch:${OWNER}:${name}`;
      return door.prepare(principal, {
        owner: OWNER,
        signer: { role: 'owner', address: OWNER },
        intent: { kind: 'place_orders', actionKey, orders: orders(actionKey) },
      });
    };
    const taken = { code: 'trade.venue_whole_close_taken', status: 409 };

    // Two whole take profits, or two whole stop losses, in one batch: refused, and nothing is stored.
    await expect(batch('two-whole-tps', (k) => [tp(k, 'tp-1', '3300'), tp(k, 'tp-2', '3400')])).rejects.toMatchObject({
      ...taken,
      message: expect.stringContaining(`batch:${OWNER}:two-whole-tps:tp-1, earlier in this batch`),
    });
    await expect(batch('two-whole-sls', (k) => [sl(k, 'sl-1', '2800'), sl(k, 'sl-2', '2700')])).rejects.toMatchObject(taken);
    // A whole limit close after a whole take profit and a whole stop loss in the same batch: refused.
    await expect(batch('tp-sl-limit', (k) => [tp(k, 'tp', '3300'), sl(k, 'sl', '2800'), limit(k, 'limit')])).rejects.toMatchObject(taken);
    expect(await store.listByPrefix(USER, `batch:${OWNER}:`)).toEqual([]);

    // One whole take profit and one whole stop loss together, and part ones beside them, are prepared.
    await expect(batch('tp-sl', (k) => [tp(k, 'tp', '3300'), sl(k, 'sl', '2800')])).resolves.toMatchObject({
      actionKey: `batch:${OWNER}:tp-sl`,
    });
    await expect(
      batch('parts', (k) => [tp(k, 'tp-part', '3200', '0.4'), tp(k, 'tp', '3300'), tp(k, 'tp-part-2', '3400', '0.5')]),
    ).resolves.toMatchObject({ actionKey: `batch:${OWNER}:parts` });
  });
});
