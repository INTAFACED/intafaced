import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { add, formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PlaceUserOrderIntent, type PreparedVenueAction } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';
import { InMemoryPreparedActionStore, type PreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { readOwnVenueActivity } from './own-activity.js';
import { ownVenueActivityRouter } from './own-activity-router.js';

// J-cex-spot-01 #11: svc-tax reads a person's own venue spot trading through `venue.ownActivity`. Against the TEST
// simulator over loopback HTTP, through the real door: the person's own wallet signs, and every figure is the venue's.
const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c1';
const OTHER_USER = '11111111-1111-4111-8111-1111111111c2';
const principal = (userId: string) =>
  ({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-3333333333c3',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 600_000),
  }) as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade own activity')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
/** A wallet the person never signed with: its account is read by address alone. */
const stranger = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade stranger'))).address.toLowerCase();

async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const approve: StepUpCheck = { require: async () => ({ stepUpEventId: 'step-up-test', consumedAt: null, replayed: false }) };

describe('venue.ownActivity against the TEST simulator', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const store = new InMemoryPreparedActionStore();
  let door: UserVenueDoor;

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('20000'), 'deposit:own-activity:1');
    sim.deposit({ venueId: sim.venue.id, owner: stranger, subAccount: null }, 'USDC', a('5'), 'deposit:own-activity:2');
    door = new UserVenueDoor({
      connect: async () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
      appEnv: 'test',
      store,
      stepUp: approve,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      // Blank: these orders are limits, which the owner's market price protection never bounds.
      slippageCapBps: null,
      now: () => new Date(),
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
    });
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const order = (n: number, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: a('0.1'),
    price: a('60010'),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:own-activity:${n}`,
    builderFee: null,
    ...over,
  });

  async function trade(
    intent: PlaceUserOrderIntent | { kind: 'approve_builder_fee'; builder: string; maxFeeBps: bigint },
    actionKey?: string,
  ) {
    const prepared = await door.prepare(principal(USER), { owner, signer, intent, ...(actionKey ? { actionKey } : {}) });
    return (await door.submit(principal(USER), prepared.actionKey, await sign(prepared.prepared))).outcome;
  }

  const read = (userId: string) => readOwnVenueActivity({ venue: () => door.venue(), store, userId });

  it('before the person signs anything, no venue account is theirs, though one can be read by address', async () => {
    await door.account(stranger);
    expect(await read(USER)).toEqual({ state: 'read', test: true, accounts: [] });
  });

  it("after a buy and a sale the person's wallet signed, lists the account with the venue's own fills, fees and balances", async () => {
    expect(
      await trade(
        { kind: 'approve_builder_fee', builder: '0x00000000000000000000000000000000000000b1', maxFeeBps: a('1') },
        `approve-builder:${USER}:1`,
      ),
    ).toMatchObject({
      accepted: true,
    });
    expect(await trade(order(1))).toMatchObject({ accepted: true });
    expect(await trade(order(2, { side: 'sell', amount: a('0.05'), price: a('59000') }))).toMatchObject({ accepted: true });

    const answer = await read(USER);
    expect(answer.state).toBe('read');
    if (answer.state !== 'read') return;
    expect(answer.accounts).toHaveLength(1);
    const account = answer.accounts[0]!;
    expect(account).toMatchObject({ venueId: sim.venue.id, owner, subAccount: null });

    // Every figure equals the venue's own, read straight from it.
    const venue = await door.venue();
    const own = { venueId: sim.venue.id, owner, subAccount: null };
    const fills = (await venue.fills(own, new Date(0))).value;
    const balances = (await venue.balances(own)).value;
    expect(account.fills.map((f) => f.fillId).sort()).toEqual(fills.map((f) => f.fillId).sort());
    for (const f of fills) {
      const shown = account.fills.find((x) => x.fillId === f.fillId)!;
      expect(shown).toEqual({
        fillId: f.fillId,
        symbol: 'BTC-USDC',
        base: 'BTC',
        quote: 'USDC',
        side: f.side,
        price: formatAmount(f.price),
        amount: formatAmount(f.amount),
        // The builder fee on a sale is charged by the venue too: the fee is everything it charged.
        fee: formatAmount(add(f.venueFee, f.builderFee)),
        feeAsset: f.feeAsset,
        filledAt: f.filledAt.toISOString(),
      });
    }
    expect(account.fills.some((f) => f.side === 'sell' && f.feeAsset === 'USDC')).toBe(true);
    expect(account.fills.some((f) => f.side === 'buy' && f.feeAsset === 'BTC')).toBe(true);
    expect(account.balances).toEqual(balances.map((b) => ({ asset: b.asset, total: formatAmount(b.total) })));
    // Oldest first.
    const times = account.fills.map((f) => Date.parse(f.filledAt));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(Number.isNaN(Date.parse(account.asOf))).toBe(false);
  });

  it("another person never sees this person's venue account", async () => {
    expect(await read(OTHER_USER)).toEqual({ state: 'read', test: true, accounts: [] });
  });

  it('an action signed by an agent, or never signed, names no account', async () => {
    const base = (await store.ownerSignedAccounts(USER, sim.venue.id))[0]!;
    expect(base).toEqual({ owner, subAccount: null });
    const memory: PreparedActionStore = new InMemoryPreparedActionStore();
    const prepared = (over: Partial<PreparedVenueAction>): PreparedVenueAction => ({
      venueId: sim.venue.id,
      account: { venueId: sim.venue.id, owner: stranger, subAccount: null },
      signer: { role: 'agent', address: owner },
      intent: { kind: 'revoke_agent', agentAddress: owner },
      nonce: '1',
      venueClientOrderId: null,
      typedData: {},
      digest: '0xabc',
      builderFee: null,
      preparedAt: new Date(),
      ...over,
    });
    await memory.insertOnce(USER, 'k:agent', prepared({}), new Date());
    await memory.signOnce(USER, 'k:agent', { digest: '0xabc', signature: '0x00', signedBy: owner }, new Date());
    await memory.insertOnce(USER, 'k:unsigned', prepared({ signer: { role: 'owner', address: stranger } }), new Date());
    // An owner role naming another address than the account's owner is not that owner's signature either.
    await memory.insertOnce(USER, 'k:mismatch', prepared({ signer: { role: 'owner', address: owner } }), new Date());
    await memory.signOnce(USER, 'k:mismatch', { digest: '0xabc', signature: '0x00', signedBy: owner }, new Date());
    expect(await memory.ownerSignedAccounts(USER, sim.venue.id)).toEqual([]);
    await memory.insertOnce(USER, 'k:owner', prepared({ signer: { role: 'owner', address: stranger } }), new Date());
    await memory.signOnce(USER, 'k:owner', { digest: '0xabc', signature: '0x00', signedBy: stranger }, new Date());
    expect(await memory.ownerSignedAccounts(USER, sim.venue.id)).toEqual([{ owner: stranger, subAccount: null }]);
    expect(await memory.ownerSignedAccounts(USER, 'another-venue')).toEqual([]);
    expect(await memory.ownerSignedAccounts(OTHER_USER, sim.venue.id)).toEqual([]);
  });

  it('through the router: svc-tax only, the door off answers off, and the venue down is an error, never "no trades"', async () => {
    const asTax = { service: 'svc-tax' } as never;
    const live = ownVenueActivityRouter({ venue: () => door.venue(), store }).createCaller(asTax);
    const answer = await live.ownActivity({ userId: USER });
    expect(answer.state === 'read' && answer.accounts.length).toBe(1);
    await expect(
      ownVenueActivityRouter({ venue: () => door.venue(), store })
        .createCaller({ service: 'svc-bank' } as never)
        .ownActivity({ userId: USER }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await ownVenueActivityRouter({ venue: null, store }).createCaller(asTax).ownActivity({ userId: USER })).toEqual({
      state: 'off',
    });
    expect(await ownVenueActivityRouter().createCaller(asTax).ownActivity({ userId: USER })).toEqual({ state: 'off' });
    const down = ownVenueActivityRouter({
      venue: async () => {
        throw new VenueRefusalError({ venueId: 'x', code: 'venue_down', detail: 'down' });
      },
      store,
    }).createCaller(asTax);
    await expect(down.ownActivity({ userId: USER })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('trade.venue.venue_down'),
    });
  });

  it("J-portfolio-04 #2: a move into the person's own sub-account is listed on the main account as the venue recorded it, and the sub-account it reached is theirs", async () => {
    const name = 'TEST own activity';
    const opened = await door.prepare(principal(USER), {
      owner,
      signer,
      intent: { kind: 'create_sub_account', name, subAccountKey: `own:sub-account:${owner}:${name}` },
    });
    const sub = ((await door.submit(principal(USER), opened.actionKey, await sign(opened.prepared))).outcome as { venueRef: string })
      .venueRef;
    const move = (n: number, amount: string) =>
      door.prepare(principal(USER), {
        owner,
        signer,
        intent: {
          kind: 'sub_account_transfer',
          subAccount: sub,
          direction: 'into_sub_account',
          asset: 'BTC',
          amount: a(amount),
          moveKey: `own:move:${owner}:${n}`,
        },
      });
    const signed = await move(1, '0.02');
    await door.submit(principal(USER), signed.actionKey, await sign(signed.prepared));
    // Prepared and never signed: it moved nothing, so it is not listed.
    await move(2, '0.01');

    const answer = await read(USER);
    if (answer.state !== 'read') throw new Error(answer.state);
    const main = answer.accounts.find((x) => x.subAccount === null)!;
    const record = (await sim.transfer({ venueId: sim.venue.id, owner, subAccount: null }, signed.prepared.nonce)).value!;
    expect(main.transfers).toEqual([
      {
        moveId: signed.prepared.nonce,
        subAccount: sub,
        direction: 'into_sub_account',
        asset: 'BTC',
        amount: '0.02',
        settledAt: record.settledAt.toISOString(),
      },
    ]);
    const reached = answer.accounts.find((x) => x.subAccount === sub)!;
    expect(reached).toMatchObject({ owner, subAccount: sub, fills: [], balances: [{ asset: 'BTC', total: '0.02' }] });
    expect(reached.transfers).toBeUndefined();
  });
});
