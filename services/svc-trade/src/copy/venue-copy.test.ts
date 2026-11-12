import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError, type StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction, UserVenueAccount } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { AgentAccounts, parseAgentAccountValues, type AgentAccountView } from '../venue/agent-account.js';
import { InMemoryAgentAccountStore } from '../venue/agent-account-store.js';
import { InMemoryAgentConnectionStore } from '../venue/agent-connection-store.js';
import { AgentOrders } from '../venue/agent-orders.js';
import { HttpUserVenue } from '../venue/http-user-venue.js';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { UserVenueDoor } from '../venue/user-venue-door.js';
import { listedTestStore } from '../venue/venue-listing-store.js';
import { StoreVenueRoutingGate } from '../venue/venue-listing.js';
import { copyMirrorClientOrderId } from './auto-mirror-place.js';
import { copyCloseKey } from './copy-close.js';
import { MemoryCopyFollowStore } from './follow-store.js';
import type { CopyFollow } from './follows.js';
import {
  InMemoryVenueFollowStore,
  VenueCopy,
  parseVenueLeaderFillId,
  venueFlattenKey,
  venueMirrorKey,
  type VenueMirrorRow,
} from './venue-copy.js';

// J-copy-bots-otc-03 #3 #4 at the service: copy trading on the venue, against the TEST venue simulator over loopback
// HTTP. Every figure is TEST. The leader and the follower are fixed TEST wallet keys; the follower's copies and closes
// are placed by the agent permission of their own agent account.

const a = parseAmount;
const LEADER = '11111111-1111-4111-8111-11111111aa01';
const FOLLOWER = '11111111-1111-4111-8111-11111111aa02';
const FOLLOW = '22222222-2222-4222-8222-22222222aa03';
const principal = (userId: string) =>
  ({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-3333333333a4',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

const leaderKey = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue copy leader')));
const followerKey = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue copy follower')));
async function sign(key: PrivateKeyAccount, prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: key.address.toLowerCase() };
}

const VALUES = parseAgentAccountValues({
  TRADE_AGENT_ACCOUNT_CEILING: '500',
  TRADE_AGENT_ACCOUNT_ASSET: 'USDC',
  TRADE_AGENT_KEY_SEED: 'intafaced unit TEST venue copy seed',
  TRADE_AGENT_MAX_ORDER_NOTIONAL: '1000',
  TRADE_AGENT_WORST_PRICE_BPS: '200',
  TRADE_AGENT_MARKETS: 'BTC-USDC',
});

describe('copy trading on the venue (TEST venue)', { timeout: 120_000 }, () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const main = (owner: string): UserVenueAccount => ({ venueId: sim.venue.id, owner: owner.toLowerCase(), subAccount: null });

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

  let door: UserVenueDoor;
  let actions: InMemoryPreparedActionStore;
  let accounts: AgentAccounts;
  let accountStore: InMemoryAgentAccountStore;
  let orders: AgentOrders;
  let copyStore: MemoryCopyFollowStore;
  let mirrors: VenueMirrorRow[];
  let desk: VenueCopy;
  let sub: UserVenueAccount;
  let accountId: string;
  let run = 0;

  const stepUp: StepUpCheck = {
    async require(req) {
      if (!req.approvalId) throw new StepUpCheckError('confirm first', 'identity.step_up_required');
      return { stepUpEventId: 'step-up-test', consumedAt: null, replayed: false };
    },
  };

  beforeEach(async () => {
    run += 1;
    actions = new InMemoryPreparedActionStore();
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 20_000 }),
      appEnv: 'test',
      store: actions,
      stepUp,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      slippageCapBps: null,
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC'])),
      now: () => new Date(),
    });
    accountStore = new InMemoryAgentAccountStore();
    accounts = new AgentAccounts({ door, store: accountStore, stepUp, values: VALUES, now: () => new Date() });
    orders = new AgentOrders({
      door,
      accounts: accountStore,
      connections: new InMemoryAgentConnectionStore(),
      keys: { read: async () => ({ state: 'none' }) },
      stepUp,
      values: VALUES,
      now: () => new Date(),
    });
    copyStore = new MemoryCopyFollowStore();
    mirrors = [];
    desk = new VenueCopy({
      venue: () => door.venue(),
      orders,
      accounts: accountStore,
      actions,
      bindings: new InMemoryVenueFollowStore(),
      copyStore,
      placedMirrors: async () => mirrors,
      slippageCapBps: 50,
    });
    sim.deposit(main(leaderKey.address), 'USDC', a('5000'), `deposit:test:venue-copy:leader:${run}`);
    sim.deposit(main(followerKey.address), 'USDC', a('1000'), `deposit:test:venue-copy:follower:${run}`);
    // The follower's own agent account: a sub-account under their wallet with the agent permission, funded 300.
    let v: AgentAccountView = await accounts.create(principal(FOLLOWER), {
      accountId: `aaaaaaaa-0000-4000-8000-${String(run).padStart(12, '0')}`,
      owner: followerKey.address.toLowerCase(),
      asset: 'USDC',
      cap: '400',
      fund: '300',
      stepUpApprovalId: 'approval-1',
    });
    for (let i = 0; v.next && i < 5; i += 1)
      v = await accounts.submit(principal(FOLLOWER), v.accountId, v.next.actionKey, await sign(followerKey, v.next.prepared));
    expect(v.status).toBe('open');
    accountId = v.accountId;
    sub = { ...main(followerKey.address), subAccount: v.subAccount };
    // Our builder fee rides on every door order: each wallet approves it once, the follower on their agent sub-account.
    await approveBuilder(principal(LEADER), leaderKey, null);
    await approveBuilder(principal(FOLLOWER), followerKey, v.subAccount);
    const follow: CopyFollow = {
      followId: FOLLOW,
      followerId: FOLLOWER,
      leaderId: LEADER,
      envelope: {} as CopyFollow['envelope'],
      region: 'TEST',
      createdAt: new Date(),
      feeShareKilled: false,
      relationshipState: 'ACTIVE',
    };
    await copyStore.saveFollow(follow);
    await desk.bind(FOLLOWER, FOLLOW, accountId, 'USDC', new Date(Date.now() - 1000));
  });

  async function approveBuilder(who: Principal, key: PrivateKeyAccount, subAccount: string | null) {
    const owner = key.address.toLowerCase();
    const answer = await door.prepare(who, {
      owner,
      subAccount,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_builder_fee', builder: '0x00000000000000000000000000000000000000b1', maxFeeBps: a('1') },
      actionKey: `approve:venue-copy:${run}:${subAccount ?? 'main'}`,
    });
    await door.submit(who, answer.actionKey, await sign(key, answer.prepared));
  }

  /** The leader buys on their own venue account, signed by their own wallet, through our door. */
  async function leaderBuys(amount: string, n: number) {
    const answer = await door.prepare(principal(LEADER), {
      owner: leaderKey.address.toLowerCase(),
      signer: { role: 'owner', address: leaderKey.address.toLowerCase() },
      intent: {
        kind: 'place_order',
        symbol: 'BTC-USDC',
        side: 'buy',
        type: 'limit',
        amount: a(amount),
        price: a('60500'),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${LEADER}:venue-copy-${run}-${n}`,
        builderFee: null,
      },
    });
    await door.submit(principal(LEADER), answer.actionKey, await sign(leaderKey, answer.prepared));
  }

  /** The copy desk's copy of every new leader fill, as the driver plans and places it: same side and amount, the leader's price. */
  async function copyNewFills(since: Date) {
    const fills = await desk.leaderFillsSince(LEADER, { at: since, fillId: null }, 20);
    for (const f of fills) {
      const fill = (await desk.leaderFill(f.fillId, LEADER))!;
      const clientOrderId = copyMirrorClientOrderId(FOLLOW, f.fillId);
      const placed = await desk.placeMirror(principal(FOLLOWER), {
        followId: FOLLOW,
        symbol: fill.marketId,
        marketId: fill.marketId,
        side: fill.side,
        qty: fill.qty,
        price: a('60500'),
        clientOrderId,
      });
      mirrors.push({
        leaderFillId: f.fillId,
        orderKey: placed.orderId,
        symbol: fill.marketId,
        side: fill.side,
        qty: fill.qty,
        placedAt: new Date(),
      });
    }
    return fills;
  }

  const subFills = async () => (await sim.fills(sub, new Date(0))).value;

  it("reads the leader's fills from the leader's own venue account, and refuses a fill that is not on one the leader signed for", async () => {
    const since = new Date(Date.now() - 1);
    await leaderBuys('0.002', 1);
    const fills = await desk.leaderFillsSince(LEADER, { at: since, fillId: null }, 20);
    expect(fills.length).toBeGreaterThan(0);
    const parsed = parseVenueLeaderFillId(fills[0]!.fillId)!;
    expect(parsed.owner).toBe(leaderKey.address.toLowerCase());
    const fill = await desk.leaderFill(fills[0]!.fillId, LEADER);
    expect(fill).toMatchObject({ userId: LEADER, marketId: 'BTC-USDC', side: 'buy' });
    // The same fill named for someone who never signed for that account is not theirs.
    expect(await desk.leaderFill(fills[0]!.fillId, FOLLOWER)).toBeNull();
  });

  it('places each copy as one venue order on the agent sub-account, sent once, and reads the position as the venue reports it', async () => {
    const since = new Date(Date.now() - 1);
    await leaderBuys('0.002', 1);
    const [first] = await copyNewFills(since);
    const key = venueMirrorKey(FOLLOW, copyMirrorClientOrderId(FOLLOW, first!.fillId));
    // A retry of the same copy sends nothing new: one order on the venue under its client order id.
    await desk.placeMirror(principal(FOLLOWER), {
      followId: FOLLOW,
      symbol: 'BTC-USDC',
      side: 'buy',
      qty: mirrors[0]!.qty,
      price: a('60500'),
      clientOrderId: copyMirrorClientOrderId(FOLLOW, first!.fillId),
    });
    const cloid = (await actions.find(FOLLOWER, key))!.prepared.venueClientOrderId!;
    const onVenue = (await subFills()).filter((f) => f.venueClientOrderId === cloid);
    const bought = onVenue.reduce((s, f) => s + f.amount, 0n);
    expect(bought).toBe(mirrors[0]!.qty);
    // The main venue account is never named: the copy filled on the sub-account only.
    expect((await sim.fills(main(followerKey.address), since)).value.filter((f) => f.venueClientOrderId === cloid)).toEqual([]);
    const [position] = (await desk.positions({ followId: FOLLOW, followerId: FOLLOWER }))!;
    expect(position).toMatchObject({ orderId: key, status: 'open', reportedBy: { test: true } });
    expect(position!.bought).toBe(bought - onVenue.filter((f) => f.feeAsset === 'BTC').reduce((s, f) => s + f.venueFee + f.builderFee, 0n));
  });

  it('closes one copied position with one venue order under copy.close:<followId>:<fillId>, sent once; the position reads closed as the venue reports it', async () => {
    const since = new Date(Date.now() - 1);
    await leaderBuys('0.002', 1);
    await copyNewFills(since);
    const [position] = (await desk.positions({ followId: FOLLOW, followerId: FOLLOWER }))!;
    const closeKey = copyCloseKey(FOLLOW, position!.leaderFillId, null);
    expect(closeKey).toBe(`copy.close:${FOLLOW}:${position!.leaderFillId}`);
    const port = desk.closePort();
    expect(await port.latest(FOLLOW, closeKey)).toBeNull();
    const placed = await port.place(principal(FOLLOWER), {
      closeKey,
      followId: FOLLOW,
      followerId: FOLLOWER,
      leaderFillId: position!.leaderFillId,
      symbol: position!.symbol,
      baseAsset: position!.baseAsset,
      qty: position!.open,
    });
    expect(placed.orderId).toBe(closeKey);
    const stored = (await actions.find(FOLLOWER, closeKey))!;
    expect(stored.prepared.signer).toMatchObject({ role: 'agent' });
    expect(stored.prepared.account.subAccount).toBe(sub.subAccount);
    const cloid = stored.prepared.venueClientOrderId!;
    const sold = (await subFills()).filter((f) => f.venueClientOrderId === cloid && f.side === 'sell');
    expect(sold.reduce((s, f) => s + f.amount, 0n)).toBe(position!.open);
    // Asked again under the same key: the venue's record is read back, nothing is sent twice.
    await port.resume(principal(FOLLOWER), (await port.latest(FOLLOW, closeKey))!.record);
    expect((await subFills()).filter((f) => f.venueClientOrderId === cloid)).toHaveLength(sold.length);
    expect((await port.latest(FOLLOW, closeKey))!.settled).toBe(true);
    const [after] = (await desk.positions({ followId: FOLLOW, followerId: FOLLOWER }))!;
    expect(after).toMatchObject({ status: 'closed', open: 0n });
  });

  it('closes all with one venue order per open position after fencing new copies; a replay finds them and sends nothing', async () => {
    const since = new Date(Date.now() - 1);
    await leaderBuys('0.002', 1);
    await leaderBuys('0.001', 2);
    await copyNewFills(since);
    const open = (await desk.positions({ followId: FOLLOW, followerId: FOLLOWER }))!.filter((p) => p.open > 0n);
    expect(open.length).toBeGreaterThanOrEqual(2);
    const done = (await desk.flatten(principal(FOLLOWER), { followId: FOLLOW, followerId: FOLLOWER }))!;
    expect(done.refuse).toBeUndefined();
    expect([...done.orderIds].sort()).toEqual(open.map((p) => venueFlattenKey(FOLLOW, p.leaderFillId)).sort());
    expect((await copyStore.getFollow(FOLLOW))!.relationshipState).toBe('STOPPING');
    const after = (await desk.positions({ followId: FOLLOW, followerId: FOLLOWER }))!;
    expect(after.every((p) => p.status === 'closed')).toBe(true);
    const before = (await subFills()).length;
    const replay = (await desk.flatten(principal(FOLLOWER), { followId: FOLLOW, followerId: FOLLOWER, lookupOnly: true }))!;
    expect([...replay.orderIds].sort()).toEqual([...done.orderIds].sort());
    expect(replay.unplaced).toBeUndefined();
    expect((await subFills()).length).toBe(before);
  });

  it('refuses a close with no owner protection floor before anything is sent', async () => {
    const since = new Date(Date.now() - 1);
    await leaderBuys('0.002', 1);
    await copyNewFills(since);
    const blank = new VenueCopy({
      venue: () => door.venue(),
      orders,
      accounts: accountStore,
      actions,
      bindings: (desk as unknown as { deps: { bindings: InMemoryVenueFollowStore } }).deps.bindings,
      copyStore,
      placedMirrors: async () => mirrors,
      slippageCapBps: null,
    });
    const [position] = (await blank.positions({ followId: FOLLOW, followerId: FOLLOWER }))!;
    const closeKey = copyCloseKey(FOLLOW, position!.leaderFillId, null);
    await expect(
      blank.closePort().place(principal(FOLLOWER), {
        closeKey,
        followId: FOLLOW,
        followerId: FOLLOWER,
        leaderFillId: position!.leaderFillId,
        symbol: position!.symbol,
        baseAsset: position!.baseAsset,
        qty: position!.open,
      }),
    ).rejects.toMatchObject({ code: 'trade.copy_close_unavailable' });
    expect(await actions.find(FOLLOWER, closeKey)).toBeNull();
  });

  it("refuses to bind a follow to an agent account that is not the follower's own open one", async () => {
    await expect(desk.bind(LEADER, '22222222-2222-4222-8222-22222222aa09', accountId, 'USDC', new Date())).rejects.toMatchObject({
      code: 'trade.copy_venue_account_not_open',
    });
    await expect(desk.bind(FOLLOWER, '22222222-2222-4222-8222-22222222aa10', accountId, 'USDT', new Date())).rejects.toMatchObject({
      code: 'trade.copy_venue_account_not_open',
    });
  });
});
