import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { venueClientOrderId, type PlaceUserOrderIntent, type PreparedVenueAction } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore, ordersOf } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError, type BuilderFeeValue } from './user-venue-door.js';

// J-cex-spot-05 at the door: a resting venue order lowered in place, refused a raise before the wallet is asked, replaced
// at a new price in one signed action (a retry is the stored action), and several cancelled in one signed action. Against
// the TEST venue simulator over loopback HTTP. Every figure is TEST.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c5';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c5',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade J-cex-spot-05')));
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

const buy = (k: string, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'limit',
  amount: a('0.002'),
  price: a('50000'),
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:${k}`,
  builderFee: null,
  ...over,
});

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('UserVenueDoor: changing and cancelling resting orders (J-cex-spot-05)', { timeout: 60_000 }, () => {
  let venue: { server: http.Server; sim: TestVenueSimulator; url: string };
  let d: UserVenueDoor;
  let store: InMemoryPreparedActionStore;
  const cloid = (k: string) => venueClientOrderId(venue.sim.venue.id, `order:${owner}:${k}`);
  const account = () => ({ venueId: venue.sim.venue.id, owner, subAccount: null });
  const resting = async (k: string) => (await venue.sim.orderByClientId(account(), cloid(k))).value;
  const usdcLocked = async () => (await venue.sim.balances(account())).value.find((b) => b.asset === 'USDC')!.locked;

  beforeAll(async () => {
    venue = await startTestVenueServer({
      host: '127.0.0.1',
      port: 0,
      appEnv: 'test',
      chainId: 84532,
      amendsInPlace: true,
      cancelsPerAction: 20,
    });
    venue.sim.deposit(account(), 'USDC', a('100000'), 'deposit:test:js5-door');
    store = new InMemoryPreparedActionStore();
    d = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: venue.url, timeoutMs: 5000 }),
      appEnv: 'test',
      store,
      stepUp: noStepUp,
      builder: BUILDER,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'ETH-USDC'])),
      slippageCapBps: null,
    });
  });
  afterAll(async () => closeServer(venue.server));

  async function run(intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey?: string) {
    const prepared = await d.prepare(principal, { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
    return d.submit(principal, prepared.actionKey, await sign(prepared.prepared));
  }
  const refusalOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      if (error instanceof UserVenueDoorError) return error.code;
      throw error;
    }
    return 'none';
  };

  it('lowers an amount in place, and refuses a raise before anything is prepared or signed', async () => {
    await run(buy('a'));
    expect(
      (
        await run(
          { kind: 'amend_order', symbol: 'BTC-USDC', venueClientOrderId: cloid('a'), amount: a('0.001'), price: a('50000') },
          `amend:${owner}:a:0.001`,
        )
      ).outcome,
    ).toMatchObject({ accepted: true, order: { remaining: a('0.001'), locked: a('50') } });
    const before = await usdcLocked();
    const raise = d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'amend_order', symbol: 'BTC-USDC', venueClientOrderId: cloid('a'), amount: a('0.005'), price: a('50000') },
      actionKey: `amend:${owner}:a:0.005`,
    });
    expect(await refusalOf(raise)).toBe('trade.venue_order_amount_raise');
    expect(await store.find(USER, `amend:${owner}:a:0.005`)).toBeNull();
    const priced = d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'replace_order', symbol: 'BTC-USDC', venueClientOrderId: cloid('a'), order: buy('a-up', { price: a('49000') }) },
      actionKey: `replace:${owner}:a-up`,
    });
    expect(await refusalOf(priced)).toBe('trade.venue_order_amount_raise');
    expect(await usdcLocked()).toBe(before);
    expect(await resting('a')).toMatchObject({ remaining: a('0.001'), status: 'open' });
  });

  it('replaces at a new price in one signed action; asked again under its key, the first answer, and nothing new', async () => {
    await run(buy('b'));
    const intent = {
      kind: 'replace_order' as const,
      symbol: 'BTC-USDC',
      venueClientOrderId: cloid('b'),
      order: buy('b2', { price: a('48000') }),
    };
    const first = await run(intent, `replace:${owner}:b:1`);
    expect(first.outcome).toMatchObject({
      accepted: true,
      legs: [
        { accepted: true, order: { status: 'canceled' } },
        { accepted: true, order: { venueClientOrderId: cloid('b2') } },
      ],
    });
    const again = await d.prepare(principal, { owner, signer, intent, actionKey: `replace:${owner}:b:1` });
    expect(again).toMatchObject({ reused: true, signed: true });
    expect(again.lastOutcome).toEqual(first.outcome);
    // The replacement is an order of ours exactly as one placed alone (the builder-fee poster and the recon read it).
    const row = (await store.find(USER, `replace:${owner}:b:1`))!;
    expect(ordersOf(row)).toEqual([{ venueClientOrderId: cloid('b2'), feeBps: null, accepted: true }]);
    const open = (await venue.sim.openOrders(account())).value.filter((o) => o.venueClientOrderId === cloid('b2'));
    expect(open).toHaveLength(1);
  });

  it('refuses a change to an order no longer resting, naming it', async () => {
    const gone = d.prepare(principal, {
      owner,
      signer,
      intent: { kind: 'amend_order', symbol: 'BTC-USDC', venueClientOrderId: cloid('b'), amount: a('0.001'), price: a('50000') },
      actionKey: `amend:${owner}:b:0.001`,
    });
    expect(await refusalOf(gone)).toBe('trade.venue_order_not_resting');
  });

  it('cancels several in one signed action: each answered, an unknown id reported, the rest cancelled', async () => {
    await run(buy('c'));
    await run(buy('e', { symbol: 'ETH-USDC', price: a('2000'), amount: a('0.01') }));
    const answer = await run(
      {
        kind: 'cancel_orders',
        orders: [
          { symbol: 'BTC-USDC', venueClientOrderId: cloid('c') },
          { symbol: 'BTC-USDC', venueClientOrderId: '0xnot-an-order' },
          { symbol: 'ETH-USDC', venueClientOrderId: cloid('e') },
        ],
      },
      `cancel-batch:${owner}:1`,
    );
    expect(answer.outcome).toMatchObject({
      accepted: true,
      legs: [{ accepted: true }, { accepted: false, refusal: { code: 'unknown_order' } }, { accepted: true }],
    });
    expect(await resting('c')).toMatchObject({ status: 'canceled', locked: 0n });
    const twice = d.prepare(principal, {
      owner,
      signer,
      intent: {
        kind: 'cancel_orders',
        orders: [
          { symbol: 'BTC-USDC', venueClientOrderId: cloid('c') },
          { symbol: 'BTC-USDC', venueClientOrderId: cloid('c') },
        ],
      },
      actionKey: `cancel-batch:${owner}:2`,
    });
    expect(await refusalOf(twice)).toBe('trade.venue_request_invalid');
  });
});
