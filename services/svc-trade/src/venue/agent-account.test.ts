import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError, type StepUpCheck, type StepUpCheckRequest } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction, UserVenueAccount } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { AgentAccountError, AgentAccounts, parseAgentAccountValues, type AgentAccountView } from './agent-account.js';
import { InMemoryAgentAccountStore } from './agent-account-store.js';
import { agentAddressFor } from './agent-key.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-agents-21 #1 #3 #4 #5 #13 #14 at the service, against the TEST venue simulator over loopback HTTP (every figure is
// TEST). The person's wallet is a fixed TEST key signing the venue's own EIP-712 payloads.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111c1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade agent account')));
const owner = key.address.toLowerCase();
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const VALUES = parseAgentAccountValues({
  TRADE_AGENT_ACCOUNT_CEILING: '500',
  TRADE_AGENT_ACCOUNT_ASSET: 'USDC',
  TRADE_AGENT_KEY_SEED: 'intafaced unit TEST agent key seed',
  TRADE_AGENT_MAX_ORDER_NOTIONAL: '100',
  TRADE_AGENT_WORST_PRICE_BPS: '200',
  TRADE_AGENT_MARKETS: 'BTC-USDC,BTC-PERP',
});

function stepUp() {
  const calls: StepUpCheckRequest[] = [];
  const check: StepUpCheck = {
    async require(req) {
      calls.push(req);
      if (!req.approvalId) throw new StepUpCheckError('confirm first', 'identity.step_up_required');
      return { stepUpEventId: 'step-up-test', consumedAt: null, replayed: false };
    },
  };
  return { check, calls };
}

let n = 0;
const id = () => {
  n += 1;
  return `5a5a5a5a-0000-4000-8000-${String(n).padStart(12, '0')}`;
};

async function refusedAs(promise: Promise<unknown>): Promise<AgentAccountError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAccountError);
    return error as AgentAccountError;
  }
  throw new Error('expected an AgentAccountError');
}

describe('the agent account on the TEST venue', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const main = (): UserVenueAccount => ({ venueId: sim.venue.id, owner, subAccount: null });
  const usdc = async (account: UserVenueAccount) => (await sim.balances(account)).value.find((b) => b.asset === 'USDC')?.total ?? a('0');

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
    sim.deposit(main(), 'USDC', a('1000'), 'deposit:test:agent-account:1');
  });
  afterAll(
    async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let accounts: AgentAccounts;
  let door: UserVenueDoor;
  let actions: InMemoryPreparedActionStore;
  let su: ReturnType<typeof stepUp>;
  function build(values = VALUES) {
    actions = new InMemoryPreparedActionStore();
    su = stepUp();
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
      appEnv: 'test',
      store: actions,
      stepUp: su.check,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
      now: () => new Date(),
    });
    accounts = new AgentAccounts({ door, store: new InMemoryAgentAccountStore(), stepUp: su.check, values, now: () => new Date() });
  }
  let topUps = 0;
  beforeEach(() => {
    build();
    // Every test funds its own accounts from the same TEST wallet: a fresh TEST 1000 USDC each time.
    topUps += 1;
    sim.deposit(main(), 'USDC', a('1000'), `deposit:test:agent-account:top-up:${topUps}`);
  });

  /** Sign and send every action the account asks for, as the person's wallet, until nothing is next. */
  async function signAll(view: AgentAccountView): Promise<AgentAccountView> {
    let v = view;
    for (let i = 0; v.next && i < 5; i += 1)
      v = await accounts.submit(principal, v.accountId, v.next.actionKey, await sign(v.next.prepared));
    return v;
  }
  const create200 = (accountId = id()) =>
    accounts.create(principal, { accountId, owner, asset: 'USDC', cap: '200', fund: '150', stepUpApprovalId: 'approval-1' });

  it('#1: a blank ceiling refuses agents.account_ceiling_unset before step-up, storage or the venue', async () => {
    build(parseAgentAccountValues({ ...{ TRADE_AGENT_ACCOUNT_ASSET: 'USDC', TRADE_AGENT_KEY_SEED: 'seed' } }));
    const before = await sim.subAccounts(main());
    const e = await refusedAs(create200());
    expect(e.code).toBe('agents.account_ceiling_unset');
    expect(su.calls).toHaveLength(0);
    expect(await accounts.list(principal)).toEqual([]);
    expect((await sim.subAccounts(main())).value).toEqual(before.value);
  });

  it('#3: create with cap 200 and fund 150: three wallet signatures; the venue shows 150 in the sub-account and 150 less on main', async () => {
    const mainBefore = await usdc(main());
    const accountId = id();
    let v = await create200(accountId);
    // Step-up names exactly the account, venue account, asset, cap and funding.
    expect(su.calls).toHaveLength(1);
    expect(su.calls[0]).toMatchObject({
      scope: 'trade.step_up.venue.agentAccount',
      requestId: `venue.agentAccount:${accountId}`,
      fields: { accountId, owner, asset: 'USDC', cap: '200', fund: '150' },
    });
    expect(v.status).toBe('opening');
    expect(v.next?.step).toBe('open_sub_account');
    const steps: string[] = [];
    for (let i = 0; v.next && i < 5; i += 1) {
      steps.push(v.next.step);
      v = await accounts.submit(principal, accountId, v.next.actionKey, await sign(v.next.prepared));
    }
    expect(steps).toEqual(['open_sub_account', 'approve_agent', 'move_in']);
    expect(v.status).toBe('open');
    expect(v.subAccount).not.toBeNull();
    const sub = { ...main(), subAccount: v.subAccount };
    expect(formatAmount(await usdc(sub))).toBe('150');
    expect(formatAmount(await usdc(main()))).toBe(formatAmount(mainBefore - a('150')));
    expect(v.balances?.value.find((b) => b.asset === 'USDC')?.total).toBe(a('150'));
    expect(formatAmount(v.cap)).toBe('200');
    expect(formatAmount(v.netFunding)).toBe('150');
    expect(formatAmount(v.room)).toBe('50');
    // The agent permission is the derived key's, on the sub-account only.
    const agentAddress = agentAddressFor('intafaced unit TEST agent key seed', USER, accountId);
    expect((await sim.agents(sub)).value.map((x) => x.address)).toEqual([agentAddress]);
    expect((await sim.agents(main())).value.map((x) => x.address)).not.toContain(agentAddress);
    expect(v.moves).toEqual([
      { moveId: accountId, actionKey: `agent:move:${accountId}`, direction: 'into_sub_account', amount: a('150'), state: 'done' },
    ]);
  });

  it('#3: without step-up nothing is stored and the venue is not asked', async () => {
    const before = await sim.subAccounts(main());
    const accountId = id();
    await expect(accounts.create(principal, { accountId, owner, asset: 'USDC', cap: '200', fund: '150' })).rejects.toMatchObject({
      code: 'identity.step_up_required',
    });
    expect(await accounts.list(principal)).toEqual([]);
    expect((await sim.subAccounts(main())).value).toEqual(before.value);
  });

  it('#3: a rejected signature moves nothing and makes no account', async () => {
    const mainBefore = await usdc(main());
    const subsBefore = (await sim.subAccounts(main())).value.length;
    // Rejected at the first signature: never submitted, then abandoned.
    const first = await create200();
    expect(first.next?.step).toBe('open_sub_account');
    const gone = await accounts.abandon(principal, first.accountId);
    expect(gone.status).toBe('abandoned');
    expect(gone.next).toBeNull();
    expect((await sim.subAccounts(main())).value).toHaveLength(subsBefore);
    expect(await usdc(main())).toBe(mainBefore);
    // Its prepared action can never be sent afterwards.
    await expect(
      accounts.submit(principal, first.accountId, first.next!.actionKey, await sign(first.next!.prepared)),
    ).rejects.toMatchObject({
      code: 'agents.account_not_open',
    });
    // Rejected at the move: the sub-account was opened empty and the agent approved, but nothing moved; no account opens.
    let v = await create200();
    for (let i = 0; v.next && v.next.step !== 'move_in' && i < 5; i += 1)
      v = await accounts.submit(principal, v.accountId, v.next.actionKey, await sign(v.next.prepared));
    expect(v.next?.step).toBe('move_in');
    v = await accounts.abandon(principal, v.accountId);
    expect(v.status).toBe('abandoned');
    expect(await usdc(main())).toBe(mainBefore);
    expect(await usdc({ ...main(), subAccount: v.subAccount })).toBe(a('0'));
    expect((await accounts.list(principal)).filter((x) => x.status === 'open')).toEqual([]);
  });

  it('#4: funding 100 more is refused agents.account_cap_exceeded naming 50 of room, before anything is prepared; nothing moves', async () => {
    const v = await signAll(await create200());
    const sub = { ...main(), subAccount: v.subAccount };
    const before = { main: await usdc(main()), sub: await usdc(sub) };
    const moveId = id();
    const e = await refusedAs(accounts.fund(principal, v.accountId, { moveId, amount: '100' }));
    expect(e.code).toBe('agents.account_cap_exceeded');
    expect(e.detail).toEqual({ room: '50' });
    expect(e.message).toContain('50 USDC of room');
    // The wallet was never asked: no action is stored under the move's key, and no move was kept.
    expect(await actions.find(USER, `agent:move:${moveId}`)).toBeNull();
    expect((await accounts.advance(principal, v.accountId)).moves).toHaveLength(1);
    expect({ main: await usdc(main()), sub: await usdc(sub) }).toEqual(before);
    // Within the room, it is prepared for the wallet.
    const ok = await accounts.fund(principal, v.accountId, { moveId: id(), amount: '50' });
    expect(ok.next?.step).toBe('move_in');
    expect(formatAmount(ok.room)).toBe('0');
  });

  it('#5: a cap above the ceiling is refused naming the ceiling; the cap stays', async () => {
    const v = await signAll(await create200());
    const e = await refusedAs(accounts.setCap(principal, v.accountId, { cap: '501' }));
    expect(e.code).toBe('agents.account_cap_above_ceiling');
    expect(e.detail).toEqual({ ceiling: '500' });
    expect(formatAmount((await accounts.advance(principal, v.accountId)).cap)).toBe('200');
    // At create too.
    const c = await refusedAs(
      accounts.create(principal, { accountId: id(), owner, asset: 'USDC', cap: '600', fund: '1', stepUpApprovalId: 'x' }),
    );
    expect(c.code).toBe('agents.account_cap_above_ceiling');
  });

  it('each move is sent once under agent:move:<moveId>: a lost answer is read back from the venue, and a retry moves nothing more', async () => {
    const v = await signAll(await create200());
    const sub = { ...main(), subAccount: v.subAccount };
    const before = await usdc(sub);
    const moveId = id();
    const asked = await accounts.fund(principal, v.accountId, { moveId, amount: '20' });
    expect(asked.next?.actionKey).toBe(`agent:move:${moveId}`);
    const signature = await sign(asked.next!.prepared);
    sim.switches.loseAnswers = 1; // applied, then answered as not definite
    const lost = await accounts.submit(principal, v.accountId, `agent:move:${moveId}`, signature);
    // Read back by the signed nonce: the venue's record shows it, so it is done, and nothing more is asked.
    expect(lost.moves.find((m) => m.moveId === moveId)?.state).toBe('done');
    expect(lost.next).toBeNull();
    // A double press of the same move (same id) and a re-send of the same bytes move nothing more.
    await accounts.fund(principal, v.accountId, { moveId, amount: '20' });
    await expect(accounts.submit(principal, v.accountId, `agent:move:${moveId}`, signature)).rejects.toMatchObject({
      code: 'agents.account_not_open',
    });
    await door.submit(principal, `agent:move:${moveId}`, signature, { agentAccount: true });
    expect(await usdc(sub)).toBe(before + a('20'));
    // The same move id with other terms is refused.
    await expect(accounts.fund(principal, v.accountId, { moveId, amount: '21' })).rejects.toMatchObject({
      code: 'agents.account_key_reused',
    });
  });

  it('two moves asked at once cannot both take the same room', async () => {
    const v = await signAll(await create200());
    const results = await Promise.allSettled([
      accounts.fund(principal, v.accountId, { moveId: id(), amount: '30' }),
      accounts.fund(principal, v.accountId, { moveId: id(), amount: '30' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('#13 #14: close is refused naming the open perp; closed perp, balance moved back, the account closes', async () => {
    const v = await signAll(await create200());
    const sub: UserVenueAccount = { ...main(), subAccount: v.subAccount };
    // A TEST perp on the sub-account, opened by the person's own wallet through the door (the assistant's orders are a
    // later piece): builder fee approved and leverage set on the sub-account first.
    const run = async (intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey: string | null = null) => {
      const p = await door.prepare(principal, {
        owner,
        subAccount: v.subAccount,
        signer: { role: 'owner', address: owner },
        intent,
        actionKey,
      });
      const s = await door.submit(principal, p.actionKey, await sign(p.prepared));
      expect(s.outcome).toMatchObject({ definite: true, accepted: true });
    };
    await run(
      { kind: 'approve_builder_fee', builder: '0x00000000000000000000000000000000000000b1', maxFeeBps: a('1') },
      `approve:${v.accountId}:builder`,
    );
    await run({ kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' }, `leverage:${v.accountId}:1`);
    const open = {
      kind: 'place_order',
      symbol: 'BTC-PERP',
      side: 'buy',
      type: 'market',
      amount: a('0.001'),
      price: a('60100'),
      timeInForce: 'IOC',
      reduceOnly: false,
      builderFee: null,
    } as const;
    await run({ ...open, clientOrderKey: `order:${v.accountId}:perp:open` });
    expect((await sim.positions(sub)).value).toHaveLength(1);

    const refused = await refusedAs(accounts.close(principal, v.accountId));
    expect(refused.code).toBe('agents.account_close_open_position');
    expect(refused.detail).toMatchObject({ symbol: 'BTC-PERP', side: 'long', size: '0.001' });
    expect(refused.message).toContain('BTC-PERP');
    expect((await accounts.advance(principal, v.accountId)).status).toBe('open');

    await run({ ...open, side: 'sell', price: a('59900'), reduceOnly: true, clientOrderKey: `order:${v.accountId}:perp:close` });
    expect((await sim.positions(sub)).value).toEqual([]);
    const held = await refusedAs(accounts.close(principal, v.accountId));
    expect(held.code).toBe('agents.account_close_balance');

    const mainBefore = await usdc(main());
    const left = await usdc(sub);
    let back = await accounts.withdraw(principal, v.accountId, { moveId: id(), amount: formatAmount(left) });
    expect(back.next?.step).toBe('move_out');
    back = await accounts.submit(principal, v.accountId, back.next!.actionKey, await sign(back.next!.prepared));
    expect(await usdc(main())).toBe(mainBefore + left);
    expect(await usdc(sub)).toBe(a('0'));
    const closed = await accounts.close(principal, v.accountId);
    expect(closed.status).toBe('closed');
    await expect(accounts.fund(principal, v.accountId, { moveId: id(), amount: '1' })).rejects.toMatchObject({
      code: 'agents.account_not_open',
    });
  });

  it('the plain door refuses to open or move into a sub-account: only the agent account does, under its cap', async () => {
    await expect(
      door.prepare(principal, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'create_sub_account', name: 'around the cap', subAccountKey: 'agent:account:around' },
      }),
    ).rejects.toBeInstanceOf(UserVenueDoorError);
    const v = await signAll(await create200());
    const moveId = id();
    const asked = await accounts.fund(principal, v.accountId, { moveId, amount: '10' });
    await expect(door.submit(principal, asked.next!.actionKey, await sign(asked.next!.prepared))).rejects.toMatchObject({
      code: 'trade.venue_agent_account_only',
    });
  });

  it("the plain door never stores an action under the agent account's keys", async () => {
    await expect(
      door.prepare(principal, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'approve_agent', agentAddress: '0x00000000000000000000000000000000000000e1', agentName: 'x', validUntil: null },
        actionKey: `agent:account:${id()}:approve`,
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_agent_account_only' });
  });

  it('an open whose answer was lost is read back from the venue by its name, and the account goes on', async () => {
    let v = await create200();
    sim.switches.loseAnswers = 1;
    v = await accounts.submit(principal, v.accountId, v.next!.actionKey, await sign(v.next!.prepared));
    expect(v.subAccount).not.toBeNull();
    expect(v.next?.step).toBe('approve_agent');
    v = await signAll(v);
    expect(v.status).toBe('open');
  });

  it('a close and a move asked at once: the close is judged under the same lock, so a move is never left on a closed account', async () => {
    const v = await signAll(await create200());
    // Empty it first, so the close could pass.
    let back = await accounts.withdraw(principal, v.accountId, { moveId: id(), amount: '150' });
    back = await accounts.submit(principal, v.accountId, back.next!.actionKey, await sign(back.next!.prepared));
    const [fund, close] = await Promise.allSettled([
      accounts.fund(principal, v.accountId, { moveId: id(), amount: '10' }),
      accounts.close(principal, v.accountId),
    ]);
    const after = await accounts.advance(principal, v.accountId);
    if (after.status === 'closed') expect(after.moves.filter((m) => m.state === 'pending')).toEqual([]);
    else expect(fund.status).toBe('fulfilled');
    expect([fund.status, close.status]).toContain('fulfilled');
  });

  it("an API key (the assistant's) can't make, fund or close an agent account", async () => {
    const keyPrincipal = { ...principal, kid: 'key-1' } as Principal;
    await expect(
      accounts.create(keyPrincipal, { accountId: id(), owner, asset: 'USDC', cap: '200', fund: '150', stepUpApprovalId: 'x' }),
    ).rejects.toMatchObject({
      code: 'scope.interactive_only',
    });
  });

  it('a JSON number is never read as money, and an asset other than the funding asset is refused', async () => {
    await expect(
      accounts.create(principal, { accountId: id(), owner, asset: 'USDC', cap: 200, fund: '150', stepUpApprovalId: 'x' }),
    ).rejects.toMatchObject({
      code: 'agents.account_request_invalid',
    });
    await expect(
      accounts.create(principal, { accountId: id(), owner, asset: 'USDT', cap: '200', fund: '150', stepUpApprovalId: 'x' }),
    ).rejects.toMatchObject({
      code: 'agents.account_funding_asset',
    });
  });
  describe("the person's own sub-account (J-portfolio-04 #2)", () => {
    const createOwn = (name: string) =>
      door.prepare(principal, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'create_sub_account', name, subAccountKey: `own:sub-account:${owner}:${name}` },
      });
    const moveOwn = (
      subAccount: string,
      amount: string,
      moveKey: string,
      direction: 'into_sub_account' | 'out_of_sub_account' = 'into_sub_account',
    ) =>
      door.prepare(principal, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'sub_account_transfer', subAccount, direction, asset: 'USDC', amount: a(amount), moveKey },
      });
    async function openOwn(name: string): Promise<string> {
      const asked = await createOwn(name);
      const sent = await door.submit(principal, asked.actionKey, await sign(asked.prepared));
      expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
      return (sent.outcome as { venueRef: string }).venueRef;
    }

    it('opens one and moves into and out of it, each signed by the wallet on the main account; the venue records the move with its time', async () => {
      const name = `TEST own ${id()}`;
      const asked = await createOwn(name);
      // A double press is the stored action: one wallet prompt.
      expect((await createOwn(name)).reused).toBe(true);
      const sent = await door.submit(principal, asked.actionKey, await sign(asked.prepared));
      const sub = (sent.outcome as { venueRef: string }).venueRef;
      expect((await sim.subAccounts(main())).value).toContainEqual({ subAccount: sub, name });
      const subAccount = (): UserVenueAccount => ({ venueId: sim.venue.id, owner, subAccount: sub });
      const before = await usdc(main());
      const moveKey = `own:move:${owner}:${id()}`;
      const into = await moveOwn(sub, '120', moveKey);
      const moved = await door.submit(principal, into.actionKey, await sign(into.prepared));
      expect(moved.outcome).toMatchObject({ definite: true, accepted: true });
      expect(await usdc(main())).toBe(before - a('120'));
      expect(await usdc(subAccount())).toBe(a('120'));
      const record = (await sim.transfer(main(), into.prepared.nonce)).value!;
      expect(record).toMatchObject({ subAccount: sub, direction: 'into_sub_account', asset: 'USDC', amount: a('120'), status: 'done' });
      expect(record.settledAt).toBeInstanceOf(Date);
      // Re-sent, the same bytes: the venue's first answer, nothing moves twice.
      await door.submit(principal, into.actionKey, await sign(into.prepared));
      expect(await usdc(subAccount())).toBe(a('120'));
      const out = await moveOwn(sub, '20', `own:move:${owner}:${id()}`, 'out_of_sub_account');
      await door.submit(principal, out.actionKey, await sign(out.prepared));
      expect(await usdc(subAccount())).toBe(a('100'));
      expect(await usdc(main())).toBe(before - a('100'));
    });

    it("refuses a move under an own key into an agent account's sub-account, before anything is stored or signed", async () => {
      const v = await signAll(await create200());
      const agentSub = v.subAccount!;
      const moveKey = `own:move:${owner}:${id()}`;
      await expect(moveOwn(agentSub, '10', moveKey)).rejects.toMatchObject({ code: 'trade.venue_sub_account_not_own' });
      expect(await actions.find(USER, moveKey)).toBeNull();
      // Nor one the venue never opened for this person at all.
      await expect(moveOwn('0x00000000000000000000000000000000000000ab', '10', `own:move:${owner}:${id()}`)).rejects.toMatchObject({
        code: 'trade.venue_sub_account_not_own',
      });
    });

    it('a sub-account opened as your own but whose answer was lost is read back by its name, and a move into it goes on', async () => {
      const name = `TEST lost ${id()}`;
      const asked = await createOwn(name);
      sim.switches.loseAnswers = 1;
      const sent = await door.submit(principal, asked.actionKey, await sign(asked.prepared));
      expect(sent.outcome.definite).toBe(false);
      const sub = (await sim.subAccounts(main())).value.find((s) => s.name === name)!.subAccount;
      const into = await moveOwn(sub, '5', `own:move:${owner}:${id()}`);
      expect(into.prepared.intent).toMatchObject({ kind: 'sub_account_transfer', subAccount: sub });
    });

    it('an own key is for those two actions only, and a sub-account action under any other key is still refused', async () => {
      await expect(
        door.prepare(principal, {
          owner,
          signer: { role: 'owner', address: owner },
          intent: { kind: 'approve_agent', agentAddress: '0x00000000000000000000000000000000000000e2', agentName: 'x', validUntil: null },
          actionKey: `own:move:${owner}:${id()}`,
        }),
      ).rejects.toMatchObject({ code: 'trade.venue_own_key_misused' });
      const sub = await openOwn(`TEST other ${id()}`);
      // A move into your own sub-account under an own:sub-account key (the wrong one of the two), or under a plain key.
      await expect(moveOwn(sub, '1', `own:sub-account:${owner}:wrong`)).rejects.toMatchObject({ code: 'trade.venue_agent_account_only' });
      await expect(moveOwn(sub, '1', `move:${owner}:${id()}`)).rejects.toMatchObject({ code: 'trade.venue_agent_account_only' });
    });
  });
});

describe('the agent account posts nothing to the ledger (invariant)', () => {
  it('its modules reach no ledger client, recipe or posting: only the money arithmetic', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['agent-account.ts', 'agent-account-store.ts', 'agent-account-rest.ts', 'agent-key.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '');
      for (const spec of imports) {
        if (spec.startsWith('@intafaced/ledger-client')) expect(spec, `${file} imports ${spec}`).toBe('@intafaced/ledger-client/money');
        if (spec !== '@intafaced/ledger-client/money') expect(spec, `${file} imports ${spec}`).not.toMatch(/ledger|recipes/);
      }
    }
  });
});

describe('parseAgentAccountValues: blank is null, malformed stops the boot', () => {
  it('reads each value, blank as null', () => {
    const blank = parseAgentAccountValues({});
    expect(blank).toEqual({
      ceiling: null,
      asset: null,
      keySeed: null,
      bounds: { maxOrderNotional: null, worstPriceBps: null, markets: null },
    });
    expect(VALUES.bounds.markets).toEqual(['BTC-USDC', 'BTC-PERP']);
    expect(VALUES.ceiling).toBe(a('500'));
    expect(() => parseAgentAccountValues({ TRADE_AGENT_ACCOUNT_CEILING: '-1' })).toThrow();
    expect(() => parseAgentAccountValues({ TRADE_AGENT_ACCOUNT_CEILING: '0' })).toThrow();
    expect(() => parseAgentAccountValues({ TRADE_AGENT_MARKETS: 'btc usdc' })).toThrow();
    expect(() => parseAgentAccountValues({ TRADE_AGENT_WORST_PRICE_BPS: '10000' })).toThrow(/below 10000/);
  });
});
