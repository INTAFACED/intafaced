import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, compare, formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  hasSubAccountReads,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { MAX_AGENT_VALIDITY_MS, TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import { buildTypedData, digestOf, type TestVenueTypedData } from './signing.js';

/**
 * J-agents-21 at the venue: the person's own sub-account for their assistant.
 * The owner's wallet opens it and moves free USDC in and out, both signed on
 * the main account; an agent approved on the sub-account trades it and
 * nothing else; a loss there never reaches the main account. Every figure is
 * the simulator's own record (TEST).
 */

const a = parseAmount;

function testWallet(name: string, role: 'owner' | 'agent' = 'owner') {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role, address } as const,
    async sign(prepared: PreparedVenueAction) {
      const typed = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

const SPOT: SimMarketConfig = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1') },
  takerFeeBps: { known: true, value: a('3.5') },
};

const PERP: SimMarketConfig = {
  symbol: 'BTC-PERP',
  kind: 'perpetual',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['isolated'],
  maxLeverageBps: 200_000,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1.5') },
  takerFeeBps: { known: true, value: a('4.5') },
  maintenanceMarginRate: a('0.005'),
  markPrice: a('60000'),
};

function world() {
  let now = Date.UTC(2026, 10, 9, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [SPOT, PERP] });
  const wallet = testWallet('j21-person');
  const agent = testWallet('j21-agent', 'agent');
  const maker = testWallet('j21-maker');
  const main: UserVenueAccount = { venueId: sim.venue.id, owner: wallet.address, subAccount: null };
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(main, 'USDC', a('1000'), 'chain:j21:person');
  const run = async (who: ReturnType<typeof testWallet>, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const outcome = await sim.submit(prepared, await who.sign(prepared));
    now += 1000;
    return { prepared, outcome };
  };
  const openSub = async (name = 'TEST assistant', key = 'agent:account:j21-1') => {
    const { outcome } = await run(wallet, main, { kind: 'create_sub_account', name, subAccountKey: key });
    const id = accepted(outcome).venueRef!;
    return { venueId: sim.venue.id, owner: wallet.address, subAccount: id } satisfies UserVenueAccount;
  };
  const usdc = async (account: UserVenueAccount) =>
    (await sim.balances(account)).value.find((b) => b.asset === 'USDC') ?? { free: ZERO, locked: ZERO, total: ZERO };
  const move = (
    sub: UserVenueAccount,
    direction: 'into_sub_account' | 'out_of_sub_account',
    amount: string,
    moveKey: string,
  ): VenueIntent => ({ kind: 'sub_account_transfer', subAccount: sub.subAccount!, direction, asset: 'USDC', amount: a(amount), moveKey });
  return { sim, wallet, agent, maker, main, makerAccount, run, openSub, usdc, move, tick: () => (now += 1000), at: () => now };
}

function accepted(outcome: VenueSubmitOutcome) {
  if (!outcome.definite || !outcome.accepted) throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
  return outcome;
}

function refusedCode(outcome: VenueSubmitOutcome): string {
  if (!outcome.definite) return 'not-definite';
  return outcome.accepted ? 'accepted' : outcome.refusal.code;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal.code;
  }
  throw new Error('expected a refusal');
}

const total = (b: { total: Amount }) => b.total;

describe('TEST venue simulator: J-agents-21 sub-accounts', () => {
  it('the simulator offers the sub-account reads', () => {
    expect(hasSubAccountReads(world().sim)).toBe(true);
  });

  it('the owner opens a sub-account on the main account; the venue names it and lists it', async () => {
    const w = world();
    const sub = await w.openSub();
    expect(sub.subAccount).toMatch(/^0x[0-9a-f]{40}$/);
    expect((await w.sim.subAccounts(w.main)).value).toEqual([{ subAccount: sub.subAccount, name: 'TEST assistant' }]);
    expect(await w.usdc(sub)).toMatchObject({ free: ZERO, locked: ZERO });
  });

  it('a rejected signature opens no sub-account and moves nothing', async () => {
    const w = world();
    const intruder = testWallet('j21-intruder');
    const prepared = await w.sim.prepare(w.main, w.wallet.signer, {
      kind: 'create_sub_account',
      name: 'x',
      subAccountKey: 'agent:account:j21-r',
    });
    expect(await refusal(w.sim.submit(prepared, await intruder.sign(prepared)))).toBe('signature_mismatch');
    expect((await w.sim.subAccounts(w.main)).value).toEqual([]);

    const sub = await w.openSub();
    const p = await w.sim.prepare(w.main, w.wallet.signer, w.move(sub, 'into_sub_account', '150', 'agent:move:j21-r'));
    const forged = { ...(await intruder.sign(p)), signedBy: w.wallet.address };
    expect(await refusal(w.sim.submit(p, forged))).toBe('signature_mismatch');
    expect(total(await w.usdc(w.main))).toBe(a('1000'));
    expect(total(await w.usdc(sub))).toBe(ZERO);
  });

  it('funding moves exactly the signed amount from main to sub, once, even when the answer is lost and the bytes re-sent', async () => {
    const w = world();
    const sub = await w.openSub();
    const prepared = await w.sim.prepare(w.main, w.wallet.signer, w.move(sub, 'into_sub_account', '150', 'agent:move:j21-1'));
    const signature = await w.wallet.sign(prepared);
    w.sim.switches.loseAnswers = 1;
    expect((await w.sim.submit(prepared, signature)).definite).toBe(false);
    // Read back by nonce: it landed.
    expect((await w.sim.transfer(w.main, prepared.nonce)).value).toEqual({
      nonce: prepared.nonce,
      subAccount: sub.subAccount,
      direction: 'into_sub_account',
      asset: 'USDC',
      amount: a('150'),
      status: 'done',
    });
    // The same stored bytes re-sent: the venue's first answer, no second move.
    expect(accepted(await w.sim.submit(prepared, signature)).venueRef).toBe(prepared.nonce);
    expect(await w.usdc(sub)).toMatchObject({ free: a('150'), total: a('150') });
    expect(total(await w.usdc(w.main))).toBe(a('850'));
  });

  it('a move larger than the free balance is refused and nothing moves, either way', async () => {
    const w = world();
    const sub = await w.openSub();
    expect(refusedCode((await w.run(w.wallet, w.main, w.move(sub, 'into_sub_account', '1000.01', 'agent:move:j21-big'))).outcome)).toBe(
      'insufficient_balance',
    );
    accepted((await w.run(w.wallet, w.main, w.move(sub, 'into_sub_account', '150', 'agent:move:j21-2'))).outcome);
    expect(refusedCode((await w.run(w.wallet, w.main, w.move(sub, 'out_of_sub_account', '150.01', 'agent:move:j21-out'))).outcome)).toBe(
      'insufficient_balance',
    );
    expect(total(await w.usdc(w.main))).toBe(a('850'));
    expect(total(await w.usdc(sub))).toBe(a('150'));
  });

  it('margin held by an open position on the sub-account stays there: only free balance moves back', async () => {
    const w = world();
    const sub = await w.openSub();
    accepted((await w.run(w.wallet, w.main, w.move(sub, 'into_sub_account', '150', 'agent:move:j21-3'))).outcome);
    accepted(
      (await w.run(w.wallet, sub, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST assistant', validUntil: null }))
        .outcome,
    );
    w.sim.deposit(w.makerAccount, 'USDC', a('100000'), 'chain:j21:maker');
    accepted(
      (await w.run(w.maker, w.makerAccount, { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' }))
        .outcome,
    );
    accepted(
      (
        await w.run(w.maker, w.makerAccount, {
          kind: 'place_order',
          symbol: 'BTC-PERP',
          side: 'sell',
          type: 'limit',
          amount: a('0.01'),
          price: a('60000'),
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey: 'order:j21-maker:1',
          builderFee: null,
        })
      ).outcome,
    );
    // The assistant's agent key opens a perp on the sub-account: margin 60 at 10x, taken there.
    accepted(
      (await w.run(w.agent, sub, { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' })).outcome,
    );
    accepted(
      (
        await w.run(w.agent, sub, {
          kind: 'place_order',
          symbol: 'BTC-PERP',
          side: 'buy',
          type: 'limit',
          amount: a('0.01'),
          price: a('60000'),
          timeInForce: 'IOC',
          reduceOnly: false,
          clientOrderKey: 'order:j21-agent:1',
          builderFee: null,
        })
      ).outcome,
    );
    const subUsdc = await w.usdc(sub);
    expect(compare(subUsdc.free, a('150'))).toBeLessThan(0);
    expect((await w.sim.positions(sub)).value).toHaveLength(1);
    expect((await w.sim.positions(w.main)).value).toHaveLength(0);
    expect(total(await w.usdc(w.main))).toBe(a('850'));
    expect(refusedCode((await w.run(w.wallet, w.main, w.move(sub, 'out_of_sub_account', '150', 'agent:move:j21-4'))).outcome)).toBe(
      'insufficient_balance',
    );
    accepted((await w.run(w.wallet, w.main, w.move(sub, 'out_of_sub_account', formatAmount(subUsdc.free), 'agent:move:j21-5'))).outcome);
    expect((await w.usdc(sub)).free).toBe(ZERO);
    expect(total(await w.usdc(w.main))).toBe(add(a('850'), subUsdc.free));
  });

  it('an order costing more than the sub-account holds is refused by the venue; the main account is never drawn', async () => {
    const w = world();
    const sub = await w.openSub();
    accepted((await w.run(w.wallet, w.main, w.move(sub, 'into_sub_account', '150', 'agent:move:j21-6'))).outcome);
    accepted(
      (await w.run(w.wallet, sub, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST assistant', validUntil: null }))
        .outcome,
    );
    const { outcome } = await w.run(w.agent, sub, {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: a('0.01'),
      price: a('60000'),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: 'order:j21-agent:big',
      builderFee: null,
    });
    expect(refusedCode(outcome)).toBe('insufficient_balance');
    expect(await w.usdc(sub)).toMatchObject({ free: a('150'), locked: ZERO });
    expect(total(await w.usdc(w.main))).toBe(a('850'));
  });

  it('an agent approved on the sub-account trades it only: it cannot move, withdraw, or trade the main account', async () => {
    const w = world();
    const sub = await w.openSub();
    accepted(
      (await w.run(w.wallet, sub, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'TEST assistant', validUntil: null }))
        .outcome,
    );
    expect((await w.sim.agents(w.main)).value).toEqual([]);
    expect(await refusal(w.sim.prepare(w.main, w.agent.signer, w.move(sub, 'out_of_sub_account', '1', 'agent:move:j21-a')))).toBe(
      'agent_not_permitted',
    );
    expect(await refusal(w.sim.prepare(sub, w.agent.signer, w.move(sub, 'out_of_sub_account', '1', 'agent:move:j21-b')))).toBe(
      'agent_not_permitted',
    );
    expect(
      await refusal(
        w.sim.prepare(sub, w.agent.signer, {
          kind: 'withdraw',
          asset: 'USDC',
          amount: a('1'),
          destination: w.agent.address,
          withdrawalKey: 'withdraw:j21:a',
        }),
      ),
    ).toBe('agent_not_permitted');
    expect(
      await refusal(
        w.sim.prepare(w.main, w.agent.signer, { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:j21-agent:x' }),
      ),
    ).toBe('signer_not_authorised');
  });

  it('a move or an action on a sub-account the owner never opened is refused unknown_sub_account', async () => {
    const w = world();
    const other = testWallet('j21-other');
    const otherMain: UserVenueAccount = { venueId: w.sim.venue.id, owner: other.address, subAccount: null };
    const { outcome } = await w.run(other, otherMain, { kind: 'create_sub_account', name: 'theirs', subAccountKey: 'agent:account:o-1' });
    const theirs = { ...otherMain, subAccount: accepted(outcome).venueRef! };
    expect(await refusal(w.sim.prepare(w.main, w.wallet.signer, w.move(theirs, 'into_sub_account', '10', 'agent:move:j21-x')))).toBe(
      'unknown_sub_account',
    );
    const ghost = { ...w.main, subAccount: '0x00000000000000000000000000000000000000aa' };
    expect(
      await refusal(
        w.sim.prepare(ghost, w.wallet.signer, { kind: 'approve_agent', agentAddress: w.agent.address, agentName: 'x', validUntil: null }),
      ),
    ).toBe('unknown_sub_account');
    expect(total(await w.usdc(w.main))).toBe(a('1000'));
  });

  it('a create or a move is signed on the main account, never on the sub-account', async () => {
    const w = world();
    const sub = await w.openSub();
    expect(await refusal(w.sim.prepare(sub, w.wallet.signer, w.move(sub, 'out_of_sub_account', '1', 'agent:move:j21-s')))).toBe(
      'not_offered',
    );
    expect(
      await refusal(w.sim.prepare(sub, w.wallet.signer, { kind: 'create_sub_account', name: 'n', subAccountKey: 'agent:account:n' })),
    ).toBe('not_offered');
    expect(await refusal(w.sim.subAccounts(sub))).toBe('not_offered');
  });

  it('a second sub-account under a name in use is refused', async () => {
    const w = world();
    await w.openSub('TEST assistant', 'agent:account:j21-a');
    expect(
      await refusal(
        w.sim.prepare(w.main, w.wallet.signer, {
          kind: 'create_sub_account',
          name: 'TEST assistant',
          subAccountKey: 'agent:account:j21-b',
        }),
      ),
    ).toBe('venue_rejected');
    expect((await w.sim.subAccounts(w.main)).value).toHaveLength(1);
  });

  it('a hand-built move into another owner’s sub-account is refused at submit', async () => {
    const w = world();
    const other = testWallet('j21-other2');
    const otherMain: UserVenueAccount = { venueId: w.sim.venue.id, owner: other.address, subAccount: null };
    const theirs = accepted(
      (await w.run(other, otherMain, { kind: 'create_sub_account', name: 't', subAccountKey: 'agent:account:o-2' })).outcome,
    ).venueRef!;
    const mine = await w.openSub();
    const p = await w.sim.prepare(w.main, w.wallet.signer, w.move(mine, 'into_sub_account', '10', 'agent:move:j21-h'));
    const intent = { ...(p.intent as Extract<VenueIntent, { kind: 'sub_account_transfer' }>), subAccount: theirs };
    const td = buildTypedData(w.sim.venue.id, w.main, w.wallet.signer, intent, p.nonce);
    const forged = { ...p, intent, typedData: td, digest: digestOf(td) };
    expect(refusedCode(await w.sim.submit(forged, await w.wallet.sign(forged)))).toBe('unknown_sub_account');
    expect(total(await w.usdc(w.main))).toBe(a('1000'));
  });
});

describe('TEST venue simulator: agent keys as the venue keeps them', () => {
  const approve = (agentAddress: string, agentName: string, validUntil: Date | null = null): VenueIntent => ({
    kind: 'approve_agent',
    agentAddress,
    agentName,
    validUntil,
  });

  it('at most two named agents on a sub-account; a third is refused until one is revoked', async () => {
    const w = world();
    const sub = await w.openSub();
    const [k1, k2, k3] = ['j21-k1', 'j21-k2', 'j21-k3'].map((n) => testWallet(n, 'agent'));
    accepted((await w.run(w.wallet, sub, approve(k1!.address, 'one'))).outcome);
    accepted((await w.run(w.wallet, sub, approve(k2!.address, 'two'))).outcome);
    expect(await refusal(w.sim.prepare(sub, w.wallet.signer, approve(k3!.address, 'three')))).toBe('venue_rejected');
    accepted((await w.run(w.wallet, sub, { kind: 'revoke_agent', agentAddress: k1!.address })).outcome);
    accepted((await w.run(w.wallet, sub, approve(k3!.address, 'three'))).outcome);
    expect((await w.sim.agents(sub)).value.map((x) => x.name).sort()).toEqual(['three', 'two']);
  });

  it('a revoked agent address is never approved again on that account', async () => {
    const w = world();
    const sub = await w.openSub();
    accepted((await w.run(w.wallet, sub, approve(w.agent.address, 'TEST assistant'))).outcome);
    accepted((await w.run(w.wallet, sub, { kind: 'revoke_agent', agentAddress: w.agent.address })).outcome);
    expect(await refusal(w.sim.prepare(sub, w.wallet.signer, approve(w.agent.address, 'TEST assistant')))).toBe('venue_rejected');
    expect(
      await refusal(w.sim.prepare(sub, w.agent.signer, { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:j21-agent:c' })),
    ).toBe('signer_not_authorised');
  });

  it('a new key under a name in use replaces the old key, which then signs nothing and is never re-approved', async () => {
    const w = world();
    const sub = await w.openSub();
    const next = testWallet('j21-next', 'agent');
    accepted((await w.run(w.wallet, sub, approve(w.agent.address, 'TEST assistant'))).outcome);
    accepted((await w.run(w.wallet, sub, approve(next.address, 'TEST assistant'))).outcome);
    expect((await w.sim.agents(sub)).value.map((x) => x.address)).toEqual([next.address]);
    expect(
      await refusal(w.sim.prepare(sub, w.agent.signer, { kind: 'cancel_order', symbol: 'BTC-USDC', clientOrderKey: 'order:j21-agent:d' })),
    ).toBe('signer_not_authorised');
    expect(await refusal(w.sim.prepare(sub, w.wallet.signer, approve(w.agent.address, 'other')))).toBe('venue_rejected');
  });

  it('an expiry more than 180 days ahead, or in the past, is refused', async () => {
    const w = world();
    const sub = await w.openSub();
    expect(
      await refusal(w.sim.prepare(sub, w.wallet.signer, approve(w.agent.address, 'a', new Date(w.at() + MAX_AGENT_VALIDITY_MS + 1)))),
    ).toBe('venue_rejected');
    expect(await refusal(w.sim.prepare(sub, w.wallet.signer, approve(w.agent.address, 'a', new Date(w.at() - 1))))).toBe('venue_rejected');
    accepted((await w.run(w.wallet, sub, approve(w.agent.address, 'a', new Date(w.at() + MAX_AGENT_VALIDITY_MS)))).outcome);
  });

  it('the owner wallet cannot be approved as its own agent', async () => {
    const w = world();
    expect(await refusal(w.sim.prepare(w.main, w.wallet.signer, approve(w.wallet.address, 'self')))).toBe('venue_rejected');
  });
});
