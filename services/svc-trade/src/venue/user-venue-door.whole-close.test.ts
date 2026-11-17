import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PlaceUserOrderIntent, type PreparedVenueAction, type VenueTrigger } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError, type BuilderFeeValue } from './user-venue-door.js';

// J-derivatives-04 #6 at the door (row d115, 17 Nov 2026): one take profit and one stop loss for the whole position may
// rest together; part ones don't count; another whole close is refused before anything is prepared. Against the TEST
// venue simulator over loopback HTTP, on a TEST long of 1 ETH-PERP. Every figure is TEST.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111f6';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333f6',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-derivatives-04 whole close')));
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
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b9', feeBps: a('1') };

const sell = (k: string, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'ETH-PERP',
  side: 'sell',
  type: 'limit',
  amount: a('1'),
  price: a('3300'),
  timeInForce: 'GTC',
  reduceOnly: true,
  clientOrderKey: `order:${owner}:${k}`,
  builderFee: null,
  ...over,
});
/** A trigger order closing the long: a take profit above the TEST mark (3000), a stop loss below it. */
const trigger = (k: string, role: VenueTrigger['role'], amount = '1'): PlaceUserOrderIntent =>
  sell(k, {
    type: 'market',
    timeInForce: 'IOC',
    amount: a(amount),
    price: role === 'take_profit' ? a('3135') : a('2660'),
    trigger: { price: role === 'take_profit' ? a('3300') : a('2800'), source: 'mark', role },
  });

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('UserVenueDoor: one whole take profit and one whole stop loss (J-derivatives-04 #6)', { timeout: 60_000 }, () => {
  let venue: { server: http.Server; sim: TestVenueSimulator; url: string };
  let d: UserVenueDoor;
  const account = () => ({ venueId: venue.sim.venue.id, owner, subAccount: null });

  beforeAll(async () => {
    venue = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 });
    await seedTestVenue(venue.sim);
    venue.sim.deposit(account(), 'USDC', a('100000'), 'deposit:test:jd4-whole-close');
    d = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: venue.url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: noStepUp,
      builder: BUILDER,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['ETH-PERP'])),
      slippageCapBps: null,
    });
    await run({ kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') }, `builder:${owner}:jd4`);
    await run({ kind: 'update_leverage', symbol: 'ETH-PERP', leverageBps: 50_000, marginMode: 'isolated' }, `leverage:${owner}:jd4`);
    const entry = sell('entry', { side: 'buy', type: 'market', timeInForce: 'IOC', price: a('3100'), reduceOnly: false });
    expect((await run(entry)).outcome).toMatchObject({ accepted: true, order: { status: 'filled' } });
    expect((await venue.sim.positions(account())).value.find((p) => p.symbol === 'ETH-PERP')).toMatchObject({
      side: 'long',
      size: a('1'),
    });
  });
  afterAll(async () => closeServer(venue.server));

  async function run(intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey?: string) {
    const prepared = await d.prepare(principal, { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
    return d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
  }
  /** Our door's refusal, or null when the door let the order through to the venue (which may still refuse it itself). */
  async function refusal(intent: PlaceUserOrderIntent): Promise<UserVenueDoorError | null> {
    try {
      await d.prepare(principal, { owner, signer, intent });
    } catch (error) {
      if (error instanceof UserVenueDoorError) return error;
      if (error instanceof VenueRefusalError) return null;
      throw error;
    }
    return null;
  }
  const resting = async () => (await venue.sim.openOrders(account())).value.filter((o) => o.symbol === 'ETH-PERP');

  it('a part take profit rests beside a whole one, and neither part counts toward the one of each', async () => {
    expect((await run(trigger('tp-part', 'take_profit', '0.4'))).outcome).toMatchObject({ accepted: true });
    expect((await run(trigger('tp-whole', 'take_profit'))).outcome).toMatchObject({ accepted: true });
    expect((await run(trigger('sl-part', 'stop_loss', '0.5'))).outcome).toMatchObject({ accepted: true });
    expect((await run(trigger('sl-whole', 'stop_loss'))).outcome).toMatchObject({ accepted: true });
    // A second part one still rests: parts don't count.
    expect((await run(trigger('tp-part-2', 'take_profit', '0.3'))).outcome).toMatchObject({ accepted: true });
    expect(await resting()).toHaveLength(5);
  });

  it('with both whole ones resting, another whole close is refused by name, and nothing is prepared', async () => {
    const before = await resting();
    for (const [k, intent] of [
      ['tp-whole-2', trigger('tp-whole-2', 'take_profit')],
      ['sl-whole-2', trigger('sl-whole-2', 'stop_loss')],
      ['limit-whole', sell('limit-whole')],
      // More than the position is a whole close too.
      ['limit-more', sell('limit-more', { amount: a('1.5') })],
    ] as const) {
      const refused = await refusal(intent);
      expect(refused?.code, k).toBe('trade.venue_whole_close_taken');
      expect(refused?.status).toBe(409);
      expect(refused?.message).toContain('one take profit and one stop loss for the whole position may rest together on ETH-PERP');
      expect(refused?.message).toContain("part take profits and stop losses don't count");
    }
    expect(await resting()).toEqual(before);
  });

  it('a part close is never refused here, nor a market close, which rests nothing', async () => {
    expect(await refusal(sell('limit-part', { amount: a('0.2') }))).toBeNull();
    expect(await refusal(trigger('tp-part-3', 'take_profit', '0.2'))).toBeNull();
    expect(await refusal(sell('market-whole', { type: 'market', timeInForce: 'IOC', price: a('2700') }))).toBeNull();
  });

  it('only its own role is taken while the other whole one is missing', async () => {
    const sl = (await resting()).find((o) => o.trigger?.role === 'stop_loss' && o.remaining === a('1'))!;
    expect((await run({ kind: 'cancel_order', symbol: 'ETH-PERP', clientOrderKey: `order:${owner}:sl-whole` })).outcome).toMatchObject({
      accepted: true,
    });
    expect((await resting()).some((o) => o.venueClientOrderId === sl.venueClientOrderId)).toBe(false);
    expect((await refusal(trigger('tp-whole-3', 'take_profit')))?.code).toBe('trade.venue_whole_close_taken');
    // A whole limit close is refused only while both rest; a whole stop loss may rest again.
    expect(await refusal(sell('limit-whole-2'))).toBeNull();
    expect((await run(trigger('sl-whole-again', 'stop_loss'))).outcome).toMatchObject({ accepted: true });
  });
});
