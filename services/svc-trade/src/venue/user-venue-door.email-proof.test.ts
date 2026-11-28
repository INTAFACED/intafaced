import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, VenueSignature } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import type { EmailProofSource } from '../spot/email-proof.js';
import { TradeError } from '../spot/types.js';

// J-identity-01 #8: "a plain gate saying the email must be proved first" on the launch model. Until identity says the
// person proved the account's email, the user-venue door prepares and sends no new order that adds exposure, and refuses
// when the proof can't be read; a cancel and a reduce-only order still go, and once proved the same order goes. Against
// the TEST venue simulator over loopback.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111101e8';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333301e8',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-identity-01 #8 email proof')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
async function sign(prepared: PreparedVenueAction): Promise<VenueSignature> {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}
const noStepUp: StepUpCheck = { require: async () => ({ stepUpEventId: 'unused', consumedAt: null, replayed: false }) };
const order = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent =>
  ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.01'),
    price: a('30000'),
    timeInForce: 'GTC',
    reduceOnly: false,
    builderFee: null,
    ...over,
  }) as PlaceUserOrderIntent;

/** For tests: identity's answer, settable; `down` throws the client's own fail-closed error. */
class MemoryEmailProof implements EmailProofSource {
  proof: 'accepted' | 'pending' | 'never' = 'never';
  down = false;
  async get() {
    if (this.down) throw new TradeError('TEST: identity down', 'trade.identity_unavailable');
    return this.proof as never;
  }
}

describe('UserVenueDoor holds new orders until the email is proved', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  let n = 0;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('100000'), 'deposit:test:01e8');
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const openOnVenue = async () => (await sim.openOrders({ venueId: sim.venue.id, owner, subAccount: null })).value.length;

  function door(emailProof: MemoryEmailProof, store = new InMemoryPreparedActionStore()): UserVenueDoor {
    return new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }) as never,
      appEnv: 'test',
      store,
      stepUp: noStepUp,
      builder: null,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
      ordersPageMax: 50,
      slippageCapBps: null,
      closeSlippageBps: 1000,
      emailProof,
    });
  }
  const keyed = () => `order:${owner}:btc-usdc:e${++n}`;

  it('refuses a new order by name while the email is unproved: nothing prepared, stored or sent', async () => {
    const proof = new MemoryEmailProof();
    const store = new InMemoryPreparedActionStore();
    const d = door(proof, store);
    const before = await openOnVenue();
    for (const state of ['never', 'pending'] as const) {
      proof.proof = state;
      const clientOrderKey = keyed();
      await expect(d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey } })).rejects.toMatchObject({
        code: 'trade.email_proof_required',
        status: 403,
      });
      expect(await store.find(USER, clientOrderKey)).toBeNull();
    }
    expect(await openOnVenue()).toBe(before);
  });

  it('refuses while the proof cannot be read (fail closed)', async () => {
    const proof = new MemoryEmailProof();
    proof.down = true;
    await expect(door(proof).prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey: keyed() } })).rejects.toMatchObject({
      code: 'trade.identity_unavailable',
      status: 503,
    });
  });

  it('once proved, the same order goes and rests on the venue', async () => {
    const proof = new MemoryEmailProof();
    const d = door(proof);
    const clientOrderKey = keyed();
    await expect(d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey } })).rejects.toMatchObject({
      code: 'trade.email_proof_required',
    });
    proof.proof = 'accepted';
    const before = await openOnVenue();
    const prepared = await d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey } });
    const sent = await d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await openOnVenue()).toBe(before + 1);
  });

  it('an order prepared while proved is refused at its first send if the proof no longer reads accepted', async () => {
    const proof = new MemoryEmailProof();
    proof.proof = 'accepted';
    const d = door(proof);
    const before = await openOnVenue();
    const prepared = await d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey: keyed() } });
    proof.proof = 'pending';
    await expect(d.submit(principal, prepared.actionKey, await sign(prepared.prepared))).rejects.toMatchObject({
      code: 'trade.email_proof_required',
    });
    expect(await openOnVenue()).toBe(before);
  });

  it('a cancel of an order already resting still goes while unproved, so nobody is trapped', async () => {
    const proof = new MemoryEmailProof();
    proof.proof = 'accepted';
    const d = door(proof);
    const clientOrderKey = keyed();
    const placed = await d.prepare(principal, { owner, signer, intent: { ...order(), clientOrderKey } });
    await d.submit(principal, placed.actionKey, await sign(placed.prepared));
    const resting = await openOnVenue();
    proof.proof = 'never';
    const cancel = await d.prepare(principal, { owner, signer, intent: { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey } });
    const sent = await d.submit(principal, cancel.actionKey, await sign(cancel.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await openOnVenue()).toBe(resting - 1);
  });
});
