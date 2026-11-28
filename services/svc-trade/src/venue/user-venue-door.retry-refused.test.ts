import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { encodeVenueWire, type PlaceUserOrderIntent, type PreparedVenueAction, type VenueIntent } from '@intafaced/venue-contracts';
import { answerTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';

// J-derivatives-33 #5: a close the venue definitely refused is retried alone under its own client order id, signed afresh
// (a new nonce), and nothing else under a key is ever sent again this way: an order the venue took, or one whose answer is
// not known, answers as stored. Against the TEST venue simulator over loopback HTTP, with its per-account switches.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111d6';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333d6',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-derivatives-33 retry')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000ba', feeBps: a('1') };
const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};

/** A resting limit buy on BTC-USDC under `clientOrderKey`, under the TEST ladder, so it stays open. */
const order = (clientOrderKey: string): PlaceUserOrderIntent =>
  ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.01'),
    price: a('30000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  }) as PlaceUserOrderIntent;
/** A TEST long of 1 ETH-PERP opened at the TEST ladder's asks, and its whole reduce-only market close. */
const perp = (clientOrderKey: string, side: 'buy' | 'sell'): PlaceUserOrderIntent =>
  ({
    kind: 'place_order',
    symbol: 'ETH-PERP',
    side,
    type: 'market',
    amount: a('1'),
    price: a(side === 'buy' ? '3100' : '2800'),
    timeInForce: 'IOC',
    reduceOnly: side === 'sell',
    clientOrderKey,
    builderFee: null,
  }) as PlaceUserOrderIntent;

describe('UserVenueDoor: a refused order retried under its own client order id (J-derivatives-33 #5)', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('100000'), 'deposit:test:retry');
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

  let store = new InMemoryPreparedActionStore();
  const door = () =>
    new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
      appEnv: 'test',
      store: (store = new InMemoryPreparedActionStore()),
      stepUp: noStepUp,
      builder: BUILDER,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'ETH-PERP'])),
      ordersPageMax: 50,
      slippageCapBps: 500,
      closeSlippageBps: 1000,
    });

  it('a definitely refused order is prepared afresh under the same key and client order id, and sent once more', async () => {
    const d = door();
    const run = async (intent: VenueIntent, actionKey?: string) => {
      const p = await d.prepare(principal, { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
      return (await d.submit(principal, p.actionKey, await sign(p.prepared))).outcome;
    };
    expect(await run({ kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') }, `builder:${owner}:retry`)).toMatchObject(
      {
        accepted: true,
      },
    );
    expect(
      await run({ kind: 'update_leverage', symbol: 'ETH-PERP', leverageBps: 50_000, marginMode: 'isolated' }, `leverage:${owner}:retry`),
    ).toMatchObject({ accepted: true });
    expect(await run(perp(`order:${owner}:eth-perp:retry-open`, 'buy'))).toMatchObject({ accepted: true, order: { status: 'filled' } });
    const key = `close:${owner}:eth-perp:retry1`;
    await switches({ refuseClose: { symbol: 'ETH-PERP', reason: 'TEST close refused' } });
    const first = await d.prepare(principal, { owner, signer, intent: perp(key, 'sell') });
    const refused = await d.submit(principal, first.actionKey, await sign(first.prepared));
    expect(refused.outcome).toMatchObject({ definite: true, accepted: false, refusal: { detail: 'TEST close refused (TEST switch)' } });

    // Without the retry, the key answers its stored refusal: nothing is sent.
    expect(await d.prepare(principal, { owner, signer, intent: perp(key, 'sell') })).toMatchObject({ reused: true, signed: true });

    // Refused again: each try is its own stored action under the same client order id, never a new order.
    const second = await d.prepare(principal, { owner, signer, intent: perp(key, 'sell'), retryRefused: true });
    expect(second).toMatchObject({ actionKey: `${key}:retry:2`, reused: false, signed: false, lastOutcome: null });
    expect((await d.submit(principal, second.actionKey, await sign(second.prepared))).outcome).toMatchObject({ accepted: false });

    await switches({ refuseClose: null });
    const retry = await d.prepare(principal, { owner, signer, intent: perp(key, 'sell'), retryRefused: true });
    expect(retry).toMatchObject({ actionKey: `${key}:retry:3`, reused: false, signed: false, lastOutcome: null });
    expect((retry.prepared.intent as PlaceUserOrderIntent).clientOrderKey).toBe(key);
    expect(retry.prepared.venueClientOrderId).toBe(first.prepared.venueClientOrderId);
    expect(new Set([first.prepared.nonce, second.prepared.nonce, retry.prepared.nonce]).size).toBe(3);
    const sent = await d.submit(principal, retry.actionKey, await sign(retry.prepared));
    expect(sent.replayed).toBe(false);
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true, order: { status: 'filled' } });
    // One venue order under the client order id, and the position closed.
    const history = (await sim.orderHistory({ venueId: sim.venue.id, owner, subAccount: null })).value;
    expect(history.filter((r) => r.order.venueClientOrderId === first.prepared.venueClientOrderId)).toHaveLength(1);
    expect((await sim.positions({ venueId: sim.venue.id, owner, subAccount: null })).value).toEqual([]);
    // Once taken, a retry asked again is that stored answer: nothing more is sent.
    const after = await d.prepare(principal, { owner, signer, intent: perp(key, 'sell'), retryRefused: true });
    expect(after).toMatchObject({ actionKey: `${key}:retry:3`, reused: true, signed: true, lastOutcome: { accepted: true } });
    // Our record of the order under its client id is the try the venue took.
    expect((await store.placedOrder(USER, first.prepared.venueClientOrderId!))?.businessKey).toBe(`${key}:retry:3`);
  });

  it('an order the venue took, or one whose answer is not known, is never sent again by a retry', async () => {
    const d = door();
    const taken = await d.prepare(principal, { owner, signer, intent: order(`order:${owner}:retry:taken`) });
    const first = await d.submit(principal, taken.actionKey, await sign(taken.prepared));
    expect(first.outcome).toMatchObject({ definite: true, accepted: true });
    const again = await d.prepare(principal, { owner, signer, intent: order(`order:${owner}:retry:taken`), retryRefused: true });
    expect(again).toMatchObject({ reused: true, signed: true, lastOutcome: { definite: true, accepted: true } });
    expect(again.prepared.nonce).toBe(taken.prepared.nonce);

    await switches({ loseAnswers: 1 });
    const lost = await d.prepare(principal, { owner, signer, intent: order(`order:${owner}:retry:lost`) });
    expect((await d.submit(principal, lost.actionKey, await sign(lost.prepared))).outcome).toMatchObject({ definite: false });
    const after = await d.prepare(principal, { owner, signer, intent: order(`order:${owner}:retry:lost`), retryRefused: true });
    expect(after).toMatchObject({ reused: true, signed: true });
    expect(after.prepared.nonce).toBe(lost.prepared.nonce);
  });
});
