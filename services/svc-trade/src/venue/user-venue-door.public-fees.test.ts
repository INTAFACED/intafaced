import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';

// J-cex-spot-10 #2: the public fee page reads every listed market's rates and our builder fee now. A market the venue
// listed seconds ago is priced from the list just read, never refused from an older one, which would blank the page.
const a = parseAmount;
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b1', feeBps: a('0.5') };
const allowAll: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'test', consumedAt: null, replayed: false };
  },
};

describe('UserVenueDoor.publicFees (J-cex-spot-10 #2)', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('prices a market the venue listed after the door last read its markets', async () => {
    const d = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: allowAll,
      builder: BUILDER,
      slippageCapBps: null,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'TFEE-USDC'])),
    });
    // The door reads (and keeps) the venue's market list before TFEE-USDC exists.
    expect(await d.builderFeeFor('BTC-USDC', 'sell')).toEqual({ carries: true, feeBps: BUILDER.feeBps });
    sim.addMarket({
      symbol: 'TFEE-USDC',
      kind: 'spot',
      baseAsset: 'TFEE',
      quoteAsset: 'USDC',
      orderTypes: ['limit'],
      timeInForce: ['GTC', 'IOC'],
      marginModes: [],
      maxLeverageBps: null,
      tickSize: a('0.01'),
      lotSize: a('0.001'),
      makerFeeBps: { known: false },
      takerFeeBps: { known: false },
    });
    const fees = await d.publicFees();
    expect(fees.value.markets.map((m) => m.symbol).sort()).toEqual(['BTC-USDC', 'TFEE-USDC']);
    expect(fees.value.markets.find((m) => m.symbol === 'TFEE-USDC')).toMatchObject({
      kind: 'spot',
      makerFeeBps: { known: false },
      takerFeeBps: { known: false },
      builderFeeBps: { known: true, value: BUILDER.feeBps },
    });
  });
});
