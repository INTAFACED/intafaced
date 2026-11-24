import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { add, formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { InMemoryAutoTopUpStore } from './auto-top-up-store.js';
import { AutoTopUpError, VenueAutoTopUp, autoTopUpChangeKey } from './auto-top-up.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-derivatives-06 #4 in svc-trade: auto top-up of an isolated position's margin on the person's own venue account,
// against the TEST venue simulator over HTTP. The venue holds the position and its margin; nothing here is posted. Every
// figure is TEST. Money line: the set amount through the agent permission once each time margin falls to the set level,
// stops at its cap and the permission's own cap, and replays after a crash without a second send.

const a = parseAmount;
const ETH = 'ETH-PERP';
const BUILDER = '0x00000000000000000000000000000000000000b3';
const SEED = 'intafaced unit TEST auto top-up seed';

describe('venue auto top-up (J-derivatives-06 #4)', { timeout: 60_000 }, () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let door: UserVenueDoor;
  let actions: InMemoryPreparedActionStore;
  let store: InMemoryAutoTopUpStore;
  let freeze: MemoryFreezeRead;
  let engine: VenueAutoTopUp;
  let n = 0;
  const id = (tag: string) => `${tag}-${(n += 1)}`;

  /** A fresh TEST person and wallet for each test, so each test's position is its own. */
  let wallet: PrivateKeyAccount;
  let owner: string;
  let person: Principal;

  const newEngine = () => new VenueAutoTopUp({ door, store, keySeed: SEED, freeze, now: () => new Date() });

  beforeEach(async () => {
    sim.setMark(ETH, a('3000'));
    sim.setIndex(ETH, a('3000'));
    await seedTestVenue(sim);
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: (actions = new InMemoryPreparedActionStore()),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore([ETH])),
      ordersPageMax: 100,
      now: () => new Date(),
    } as never);
    store = new InMemoryAutoTopUpStore();
    freeze = new MemoryFreezeRead();
    engine = newEngine();
    const tag = id('person');
    wallet = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet svc-trade auto top-up ${tag}`)));
    owner = wallet.address.toLowerCase();
    const userId = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    person = {
      sub: userId,
      userId,
      sid: '33333333-3333-4333-8333-3333333333d4',
      scopes: ['trade:read', 'trade:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    } as Principal;
  });

  async function signed(prepared: { digest: string; typedData: unknown }) {
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { digest: prepared.digest, signature, signedBy: owner };
  }
  async function send(prepared: { actionKey: string; prepared: PreparedVenueAction }) {
    return door.submit(person, prepared.actionKey, await signed(prepared.prepared));
  }
  async function ownerAct(intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey?: string) {
    const answer = await send(await door.prepare(person, { owner, signer: { role: 'owner', address: owner }, intent, actionKey }));
    expect(answer.outcome).toMatchObject({ definite: true, accepted: true });
  }

  /** The Starts line: a TEST isolated long of 1 ETH-PERP at 5x on the person's own venue account. */
  async function isolatedLong() {
    const account = await door.account(owner);
    sim.deposit(account, 'USDC', a('100000'), `chain:auto-top-up:${id('d')}`);
    await ownerAct({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' }, `leverage:${owner}:${id('lev')}`);
    await ownerAct({ kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') }, `builder-fee:${owner}:${id('fee')}`);
    await ownerAct({
      kind: 'place_order',
      symbol: ETH,
      side: 'buy',
      type: 'market',
      amount: a('1'),
      price: a('3100'),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${owner}:${id('open')}`,
      builderFee: null,
    });
  }

  async function position() {
    const p = (await sim.positions(await door.account(owner))).value.find((x) => x.symbol === ETH)!;
    return { ...p, withResult: add(p.margin, p.unrealisedPnl) };
  }

  /** Moves the TEST mark so the position's margin with its result is `target` (a 1 ETH long: one USDC per dollar). */
  async function marginTo(target: Amount) {
    const p = await position();
    sim.setMark(ETH, sub(p.markPrice, sub(p.withResult, target)));
    expect((await position()).withResult).toBe(target);
  }

  /** Turns auto top-up on and signs the agent permission in the wallet, as the margin panel does. */
  async function turnOn(terms: { level: Amount; each: string; cap: string; permissionCap: string }) {
    const view = await engine.set(person, {
      owner,
      symbol: ETH,
      triggerLevel: formatAmount(terms.level),
      amountEach: terms.each,
      cap: terms.cap,
      permissionCap: terms.permissionCap,
    });
    expect(view.permission).toMatchObject({ approved: false, cap: terms.permissionCap, used: '0' });
    expect(view.next).not.toBeNull();
    const after = await engine.submitPermission(person, {
      owner,
      symbol: ETH,
      actionKey: view.next!.actionKey,
      signature: await signed(view.next!),
    });
    expect(after.permission).toMatchObject({ approved: true, agentName: 'auto-top-up' });
    expect(after.next).toBeNull();
    return after;
  }

  const view = () => engine.get(person, owner, ETH);

  it('adds the set amount once each time margin falls to the level, and stops at its own cap', async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    await turnOn({ level, each: '10', cap: '25', permissionCap: '100' });

    // Above the level: nothing is sent.
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect((await position()).margin).toBe(start.margin);

    // Crossing 1: margin falls to one below the level; one top-up of exactly 10, under sequence 1.
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 1 });
    expect((await position()).margin).toBe(add(start.margin, a('10')));
    // Still the same crossing on every later pass (the margin rose above the level, which re-arms it): nothing more.
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect((await position()).margin).toBe(add(start.margin, a('10')));

    // Crossing 2: one more.
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 1 });
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect((await position()).margin).toBe(add(start.margin, a('20')));

    // Crossing 3: 20 added and 10 more would pass the cap of 25: nothing is sent, and the cap is named.
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect((await position()).margin).toBe(add(start.margin, a('20')));

    const v = await view();
    expect(v.setting).toMatchObject({ on: true, added: '20', room: '5', stopped: 'cap' });
    expect(v.permission).toMatchObject({ cap: '100', used: '20', room: '80' });
    expect(v.topUps.map((t) => [t.sequence, t.changeKey, t.amount, t.state])).toEqual([
      [1, `margin:${owner}:eth-perp:auto:1`, '10', 'added'],
      [2, `margin:${owner}:eth-perp:auto:2`, '10', 'added'],
    ]);
    // Each top-up was signed by the auto top-up agent key, never the person's wallet, and stored under its business key.
    const agent = engine.agentKey(person.userId, owner).address.toLowerCase();
    for (const sequence of [1, 2]) {
      const stored = await actions.find(person.userId, autoTopUpChangeKey(owner, ETH, sequence));
      expect(stored?.prepared.signer).toEqual({ role: 'agent', address: agent });
      expect(stored?.prepared.intent).toMatchObject({ kind: 'update_isolated_margin', direction: 'add', amount: a('10') });
      expect(stored?.lastOutcome).toMatchObject({ definite: true, accepted: true });
    }
  });

  it("stops at the agent permission's own cap, across a raised position cap", async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    await turnOn({ level, each: '10', cap: '100', permissionCap: '15' });

    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 1 });
    expect(await engine.tick()).toEqual({ sent: 0 });
    // Crossing 2: 10 more would pass the permission's 15, though the position's cap of 100 has room.
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect((await position()).margin).toBe(add(start.margin, a('10')));
    const v = await view();
    expect(v.setting).toMatchObject({ added: '10', room: '90', stopped: 'permission_cap' });
    expect(v.permission).toMatchObject({ cap: '15', used: '10', room: '5' });

    // The permission's cap is set once, with the wallet's approval: a different one is refused in words.
    await expect(
      engine.set(person, { owner, symbol: ETH, triggerLevel: formatAmount(level), amountEach: '10', cap: '100', permissionCap: '50' }),
    ).rejects.toMatchObject({ code: 'trade.auto_top_up_field_invalid', field: 'Agent permission cap' });
  });

  it('replays a top-up after a crash before it was sent, with no second send', async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    await turnOn({ level, each: '10', cap: '50', permissionCap: '50' });
    await marginTo(sub(level, a('1')));

    // The worker stops after the crossing is claimed and before anything is prepared: the top-up row is left sending.
    const prepare = vi.spyOn(door, 'prepare').mockRejectedValueOnce(new Error('TEST: the worker stopped here'));
    expect(await engine.tick()).toEqual({ sent: 0 });
    prepare.mockRestore();
    expect(store.rows.map((r) => [r.sequence, r.state])).toEqual([[1, 'sending']]);
    expect((await position()).margin).toBe(start.margin);

    // A new worker sends the same key once.
    engine = newEngine();
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect(store.rows.map((r) => [r.sequence, r.changeKey, r.state])).toEqual([[1, `margin:${owner}:eth-perp:auto:1`, 'added']]);
    expect((await position()).margin).toBe(add(start.margin, a('10')));
    for (let i = 0; i < 3; i += 1) await engine.tick();
    expect((await position()).margin).toBe(add(start.margin, a('10')));
    expect(store.rows).toHaveLength(1);
  });

  it('replays a top-up after a crash once the venue applied it, with no second send', async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    await turnOn({ level, each: '10', cap: '50', permissionCap: '50' });
    await marginTo(sub(level, a('1')));

    // The venue applies the signed change, and the worker stops before it records the answer.
    const submit = door.submit.bind(door);
    const lost = vi.spyOn(door, 'submit').mockImplementationOnce(async (...args) => {
      await submit(...args);
      throw new Error('TEST: the worker stopped after the venue answered');
    });
    await engine.tick();
    lost.mockRestore();
    expect(store.rows.map((r) => r.state)).toEqual(['sending']);
    expect((await position()).margin).toBe(add(start.margin, a('10')));

    // Replayed under the same key: the stored answer settles it, and the venue's margin rose by 10 once, not 20.
    engine = newEngine();
    await engine.tick();
    await engine.tick();
    expect(store.rows.map((r) => r.state)).toEqual(['added']);
    expect((await position()).margin).toBe(add(start.margin, a('10')));
  });

  it('two workers on the same crossing send one top-up', async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    await turnOn({ level, each: '10', cap: '50', permissionCap: '50' });
    await marginTo(sub(level, a('1')));
    const [x, y] = await Promise.all([newEngine().tick(), newEngine().tick()]);
    expect(x.sent + y.sent).toBe(1);
    expect((await position()).margin).toBe(add(start.margin, a('10')));
  });

  it('sends nothing before the venue lists the agent permission, or while the account is frozen', async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    // Turned on, but the wallet has not signed the permission: the engine signs nothing.
    const v = await engine.set(person, {
      owner,
      symbol: ETH,
      triggerLevel: formatAmount(level),
      amountEach: '10',
      cap: '50',
      permissionCap: '50',
    });
    expect(v.permission?.approved).toBe(false);
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect(store.rows).toHaveLength(0);

    await engine.submitPermission(person, { owner, symbol: ETH, actionKey: v.next!.actionKey, signature: await signed(v.next!) });
    freeze.frozenUsers.add(person.userId);
    expect(await engine.tick()).toEqual({ sent: 0 });
    expect(store.rows).toHaveLength(0);
    freeze.frozenUsers.delete(person.userId);
    expect(await engine.tick()).toEqual({ sent: 1 });
    expect((await position()).margin).toBe(add(start.margin, a('10')));
  });

  it('refuses a setting in words before anything is stored', async () => {
    await isolatedLong();
    const terms = { owner, symbol: ETH, triggerLevel: '100', amountEach: '10', cap: '5', permissionCap: '50' };
    await expect(engine.set(person, terms)).rejects.toMatchObject({ code: 'trade.auto_top_up_field_invalid', field: 'Cap' });
    await expect(engine.set(person, { ...terms, cap: '50', amountEach: '0' })).rejects.toMatchObject({
      field: 'Amount each top-up',
    });
    await expect(engine.set(person, { ...terms, cap: '50', triggerLevel: '' })).rejects.toBeInstanceOf(AutoTopUpError);
    await expect(engine.set(person, { ...terms, cap: '50', permissionCap: null })).rejects.toMatchObject({
      field: 'Agent permission cap',
    });
    expect(store.settings.size).toBe(0);
    expect(store.permissions.size).toBe(0);
  });

  it('turned off, it sends nothing; turned on again, its cap counts afresh and its keys never repeat', async () => {
    await isolatedLong();
    const start = await position();
    const level = sub(start.withResult, a('20'));
    await turnOn({ level, each: '10', cap: '10', permissionCap: '100' });
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 1 });
    await engine.tick();
    await engine.off(person, owner, ETH);
    await marginTo(sub(level, a('1')));
    expect(await engine.tick()).toEqual({ sent: 0 });
    const on = await engine.set(person, { owner, symbol: ETH, triggerLevel: formatAmount(level), amountEach: '10', cap: '10' });
    expect(on.setting).toMatchObject({ on: true, added: '0', room: '10' });
    expect(await engine.tick()).toEqual({ sent: 1 });
    expect(store.rows.map((r) => r.changeKey)).toEqual([`margin:${owner}:eth-perp:auto:1`, `margin:${owner}:eth-perp:auto:2`]);
    expect((await position()).margin).toBe(add(start.margin, a('20')));
  });
});
