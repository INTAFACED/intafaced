import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { div, mul, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { readyTestAdmission } from '../controls/test-admission.js';
import { TradingControlError } from '../controls/trading-controls.js';
import { HttpUserVenue } from '../venue/http-user-venue.js';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { UserVenueDoor } from '../venue/user-venue-door.js';
import { listedTestStore } from '../venue/venue-listing-store.js';
import { StoreVenueRoutingGate } from '../venue/venue-listing.js';
import { agentAddressFor } from '../venue/agent-key.js';
import { CopyService } from './copy-service.js';
import { CopyError } from './errors.js';
import type { CopyFeeShareLaw, CopyJurisdictionLaw } from './index.js';
import { InMemoryVenueCopyStore, VenueCopy, copyVenueApproveKey } from './venue-copy.js';

// J-copy-bots-otc-01 #7 #8 at the service, against the TEST venue simulator over loopback HTTP: a follow on the
// follower's own venue account, its agent permission signed by their wallet, and the copy driver placing the lead's
// fill as the follower's own venue order through that permission. INTAFACED holds and moves nothing. Every figure is TEST.

const a = parseAmount;
const FOLLOWER = '00000000-0000-4000-8000-0000000000c1';
const LEADER = '00000000-0000-4000-8000-0000000000c2';
const SEED = 'intafaced unit TEST copy venue seed';
const follower = {
  sub: FOLLOWER,
  userId: FOLLOWER,
  sid: '00000000-0000-4000-8000-0000000000c3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: true,
  expiresAt: new Date(Date.now() + 3600_000),
} as Principal;
const fee: CopyFeeShareLaw = { published: true, leaderShareBps: 1000, earningsCapPerFollower: '100', decayRoundTrips: 0, decayShareBps: 0 };
const jur: CopyJurisdictionLaw = { published: true, allowedRegions: ['DE'] };
const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};

async function signWith(key: PrivateKeyAccount, prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
}

async function refusedAs(promise: Promise<unknown>): Promise<CopyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CopyError);
    return error as CopyError;
  }
  throw new Error('expected a refusal');
}

describe("copy trading on the follower's own venue account (TEST venue)", () => {
  /** Followers whose account is frozen, and the copies the admission port let through. */
  const frozen = new Set<string>();
  const admitted: string[] = [];
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
  });
  afterAll(
    async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let runs = 0;
  let wallet: PrivateKeyAccount;
  let owner: string;
  let lead: PrivateKeyAccount;
  let copy: CopyService;
  let venueCopy: VenueCopy;
  let store: InMemoryVenueCopyStore;
  let door: UserVenueDoor;
  let submitFault: 'none' | 'lost_after_send' = 'none';
  const main = (who: string): UserVenueAccount => ({ venueId: sim.venue.id, owner: who, subAccount: null });

  beforeEach(async () => {
    runs += 1;
    wallet = privateKeyToAccount(keccak256(toHex(`intafaced TEST copy follower ${runs}`)));
    owner = wallet.address.toLowerCase();
    lead = privateKeyToAccount(keccak256(toHex(`intafaced TEST copy lead ${runs}`)));
    sim.deposit(main(owner), 'USDC', a('1000'), `deposit:test:copy-follower:${runs}`);
    sim.deposit(main(lead.address.toLowerCase()), 'USDC', a('1000'), `deposit:test:copy-lead:${runs}`);
    submitFault = 'none';
    door = new UserVenueDoor({
      connect: async () => {
        const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 15_000 });
        return new Proxy(venue, {
          get(target, prop, receiver) {
            if (prop === 'submit') {
              return async (...args: Parameters<UserVenue['submit']>) => {
                const fault = submitFault;
                submitFault = 'none';
                const answer = await target.submit(...args);
                if (fault === 'lost_after_send')
                  throw new VenueRefusalError({ venueId: target.venue.id, code: 'venue_down', detail: 'TEST: the answer was lost' });
                return answer;
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: noStepUp,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      slippageCapBps: null,
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
      now: () => new Date(),
    });
    store = new InMemoryVenueCopyStore();
    let vc: VenueCopy | null = null;
    const admission = readyTestAdmission();
    frozen.clear();
    admitted.length = 0;
    copy = new CopyService(new MemoryLedger(), {
      accountAdmission: admission,
      feeShareLaw: fee,
      jurisdictionLaw: jur,
      minTier: 'full',
      placeMirrorEnabled: true,
      placeFollowerOrder: (p, input) => vc!.placeFollowerOrder(p, input),
      inspectMarket: (symbol) => vc!.inspectMarket(symbol),
      listLeaderFillsSince: (leaderId, after, limit) => vc!.listLeaderFillsSince(leaderId, after, limit),
      lookupLeaderFill: (fillId) => vc!.lookupLeaderFill(fillId),
    });
    vc = new VenueCopy({
      copy,
      door,
      store,
      keySeed: SEED,
      // The production wiring's shape (index.ts): a delegated child of the follow's admitted start; a frozen account refuses.
      admitCopy: async (principal, businessId, payload, followId) => {
        if (frozen.has(principal.userId)) throw new TradingControlError('auth.account_frozen');
        const parent = await admission.original(principal.userId, `copy.follow:${followId}`);
        if (!parent?.grantId) throw new TradingControlError('auth.credential_denied');
        admitted.push(businessId);
        return admission.admit(principal, 'copy.mirror', businessId, payload, {
          parentBusinessId: `copy.follow:${followId}`,
          parentGrantId: parent.grantId,
        });
      },
      now: () => new Date(),
    });
    venueCopy = vc;
    await store.setLead({
      leaderUserId: LEADER,
      venueId: sim.venue.id,
      owner: lead.address.toLowerCase(),
      setBy: 'test',
      setAt: new Date(),
    });
  });

  const request = (over: Record<string, unknown> = {}) => ({
    leaderId: LEADER,
    region: 'DE',
    permittedMarkets: ['BTC-USDC'],
    maxNotionalPerOrder: '50',
    maxAggregateExposure: '200',
    fixedOrderSize: '20',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
    clientRequestId: `copy-start:test-${runs}`,
    owner,
    ...over,
  });

  /** Start, sign and send the follow's permission with the follower's wallet; then automatic copying is turned on. */
  async function followSigned(over: Record<string, unknown> = {}) {
    const started = await venueCopy.start(follower, request(over));
    expect(started.status).toBe('signing');
    expect(started.next?.step).toBe('approve_agent');
    const done = await venueCopy.submit(
      follower,
      started.followId,
      started.next!.actionKey,
      await signWith(wallet, started.next!.prepared),
    );
    expect(done.status).toBe('active');
    await copy.grantSessionKey(follower, { followId: started.followId });
    return done;
  }

  /** The lead buys `amount` at the venue's best ask, its own signed order on its own venue account. */
  async function leadBuys(amount: string, tag: string) {
    const ask = (await sim.book('BTC-USDC', 1)).value.asks[0]!.price;
    const intent: VenueIntent = {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: a(amount),
      price: ask,
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:lead:${runs}:${tag}`,
      builderFee: null,
    };
    const prepared = await sim.prepare(main(lead.address.toLowerCase()), { role: 'owner', address: lead.address.toLowerCase() }, intent);
    const outcome = await sim.submit(prepared, await signWith(lead, prepared));
    expect(outcome.definite && outcome.accepted).toBe(true);
    return ask;
  }

  it('refuses a zero amount, a fixed amount above the most per order and a total above the free USDC the venue reports, before anything is written', async () => {
    expect((await refusedAs(venueCopy.start(follower, request({ fixedOrderSize: '0' })))).code).toBe('trade.copy_envelope_invalid');
    expect((await refusedAs(venueCopy.start(follower, request({ fixedOrderSize: '60' })))).code).toBe('trade.copy_fixed_size_above_cap');
    const short = await refusedAs(
      venueCopy.start(follower, request({ maxNotionalPerOrder: '1001', maxAggregateExposure: '1001', fixedOrderSize: '1001' })),
    );
    expect(short.code).toBe('trade.copy_venue_balance_short');
    expect(short.message).toContain('1000 USDC');
    expect(short.message).toContain(sim.venue.displayName);
    expect(short.message).toMatch(/as of \d{4}-\d\d-\d\dT/);
    expect(await copy.listMyFollows(follower, 50)).toEqual([]);
    expect((await sim.agents(main(owner))).value).toEqual([]);
  });

  it('writes the follow only once the venue lists the signed permission, holds nothing, and the same key is the same follow', async () => {
    const before = (await sim.balances(main(owner))).value;
    const done = await followSigned();
    const agents = (await sim.agents(main(owner))).value.map((x) => x.address.toLowerCase());
    expect(agents).toEqual([agentAddressFor(SEED, FOLLOWER, `copy:${done.followId}`)]);
    const follows = await copy.listMyFollows(follower, 50);
    expect(follows).toHaveLength(1);
    expect(follows[0]!.followId).toBe(done.followId);
    expect((follows[0] as { reserve?: unknown }).reserve ?? null).toBeNull();
    expect((await sim.balances(main(owner))).value).toEqual(before);
    // The same request again: the same follow, nothing prepared or signed again.
    const again = await venueCopy.start(follower, request());
    expect(again.followId).toBe(done.followId);
    expect(again.status).toBe('active');
    expect(again.next).toBeNull();
    expect(await copy.listMyFollows(follower, 50)).toHaveLength(1);
  });

  it('a rejected signature leaves no follow, and the ended request is not started again under the same key', async () => {
    const started = await venueCopy.start(follower, request());
    const twice = await venueCopy.start(follower, request());
    expect(twice.next!.prepared.digest).toBe(started.next!.prepared.digest);
    const gone = await venueCopy.abandon(follower, started.followId);
    expect(gone.status).toBe('abandoned');
    expect(await copy.listMyFollows(follower, 50)).toEqual([]);
    expect((await sim.agents(main(owner))).value).toEqual([]);
    expect((await refusedAs(venueCopy.start(follower, request()))).code).toBe('trade.copy_venue_follow_abandoned');
    // A signature for an ended request is never sent.
    expect(
      (
        await refusedAs(
          venueCopy.submit(
            follower,
            started.followId,
            copyVenueApproveKey(started.followId),
            await signWith(wallet, started.next!.prepared),
          ),
        )
      ).code,
    ).toBe('trade.copy_state_invalid');
  });

  it("the follow's permission places orders and never withdraws", async () => {
    const done = await followSigned();
    await expect(
      door.prepare(follower, {
        owner,
        subAccount: null,
        signer: { role: 'agent', address: done.agentAddress },
        intent: { kind: 'withdraw', asset: 'USDC', amount: a('1'), destination: owner, withdrawalKey: `withdraw:copy:${runs}` },
      }),
    ).rejects.toMatchObject({ refusal: { code: 'agent_not_permitted' } });
  });

  it("copies the lead's venue fill once as the follower's own venue order, placed by the follow's key, at the fixed amount on the lot", async () => {
    const done = await followSigned();
    const price = await leadBuys('0.001', 'one');
    expect(await copy.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 0 });
    expect(await copy.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 0 });
    const orders = (await venueCopy.copiedOrders(follower, done.followId, await copy.placedMirrors(follower, done.followId))).orders;
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o.state).toBe('accepted');
    expect(o.signedBy).toBe(done.agentAddress);
    const lot = (await sim.markets(null)).value.find((m) => m.symbol === 'BTC-USDC')!.lotSize;
    const raw = div(a('20'), price, 'floor');
    const expected: Amount = mul(div(raw, lot, 'floor') - (div(raw, lot, 'floor') % a('1')), lot, 'floor');
    expect(o.order!.amount).toBe(expected);
    expect(o.order!.side).toBe('buy');
    // On the follower's own account, as the venue records it.
    const cloids = new Set((await sim.fills(main(owner), new Date(0))).value.map((f) => f.venueClientOrderId));
    expect([...cloids]).toEqual([o.venueClientOrderId]);
  });

  it('refuses a copy past the follow’s cap before the key signs: two lead fills under a cap that fits one place one order', async () => {
    const done = await followSigned({ maxNotionalPerOrder: '20', maxAggregateExposure: '25', fixedOrderSize: '20' });
    await leadBuys('0.001', 'one');
    await leadBuys('0.001', 'two');
    expect(await copy.runMirrorSweep()).toEqual({ placed: 1, refused: 1, failed: 0 });
    const orders = (await venueCopy.copiedOrders(follower, done.followId, await copy.placedMirrors(follower, done.followId))).orders;
    expect(orders).toHaveLength(1);
    expect(
      (await sim.openOrders(main(owner))).value.length +
        new Set((await sim.fills(main(owner), new Date(0))).value.map((f) => f.venueClientOrderId)).size,
    ).toBe(1);
  });

  it('admits every copy as the follow’s delegated child, and a follower frozen after the follow began gets no copy', async () => {
    const done = await followSigned();
    frozen.add(follower.userId);
    await leadBuys('0.001', 'frozen');
    const swept = await copy.runMirrorSweep();
    expect(swept.placed).toBe(0);
    expect((await sim.openOrders(main(owner))).value).toEqual([]);
    expect((await sim.fills(main(owner), new Date(0))).value).toEqual([]);
    expect(admitted, 'no copy was admitted').toEqual([]);
    expect(await copy.placedMirrors(follower, done.followId)).toEqual([]);
  });

  it('a copy whose answer was lost is read back by its key on the next sweep and never sent twice', async () => {
    const done = await followSigned();
    await leadBuys('0.001', 'lost');
    submitFault = 'lost_after_send';
    expect(await copy.runMirrorSweep()).toEqual({ placed: 0, refused: 0, failed: 1 });
    expect(await copy.runMirrorSweep()).toEqual({ placed: 1, refused: 0, failed: 0 });
    const cloids = new Set((await sim.fills(main(owner), new Date(0))).value.map((f) => f.venueClientOrderId));
    const open = (await sim.openOrders(main(owner))).value.length;
    expect(cloids.size + open).toBe(1);
    const orders = (await venueCopy.copiedOrders(follower, done.followId, await copy.placedMirrors(follower, done.followId))).orders;
    expect(orders).toHaveLength(1);
  });
});
