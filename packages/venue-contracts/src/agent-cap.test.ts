import { describe, expect, it, vi } from 'vitest';
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import {
  AgentCapError,
  CappedAgentSigner,
  VenueRefusalError,
  assertAgentCapWithinCeiling,
  assertAgentFundingWithinCap,
  venueClientOrderId,
  type AgentCap,
  type AgentCapVenue,
  type MaybeKnown,
  type PreparedVenueAction,
  type UserVenueAccount,
  type UserVenueBalance,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenuePosition,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
} from './index.js';

const A = (s: string): Amount => parseAmount(s);
const T0 = new Date('2026-11-08T19:00:00Z');
const sub: UserVenueAccount = { venueId: 'test-sim', owner: '0xowner', subAccount: '0xsub1' };
const agent: VenueSigner = { role: 'agent', address: '0xagent' };
const cap: AgentCap = { account: sub, agentAddress: '0xagent', asset: 'USDC', cap: A('200'), validUntil: null, revokedAt: null };

const market = (symbol: string, kind: 'spot' | 'perpetual', base: string): UserVenueMarket => ({
  symbol,
  kind,
  baseAsset: base,
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
  marginModes: kind === 'spot' ? [] : ['cross', 'isolated'],
  maxLeverageBps: kind === 'spot' ? null : 200_000,
  tickSize: A('0.01'),
  lotSize: A('0.0001'),
  makerFeeBps: { known: false },
  takerFeeBps: { known: false },
});

interface World {
  balances: UserVenueBalance[];
  openOrders: UserVenueOrder[];
  positions: UserVenuePosition[];
  leverageBps: number | null;
}

function fakeVenue(world: World, withLeverage = true): AgentCapVenue {
  const asOf = <T>(value: T) => Promise.resolve({ venueId: 'test-sim', value, asOf: T0 });
  const venue: AgentCapVenue = {
    markets: () =>
      asOf([
        market('ETH-USDC', 'spot', 'ETH'),
        market('BTC-PERP', 'perpetual', 'BTC'),
        { ...market('SOL-USDT', 'spot', 'SOL'), quoteAsset: 'USDT' },
      ]),
    balances: () => asOf(world.balances),
    openOrders: () => asOf(world.openOrders),
    positions: () => asOf(world.positions),
  };
  if (withLeverage) {
    venue.leverage = () => asOf(world.leverageBps === null ? null : { leverageBps: world.leverageBps });
  }
  return venue;
}

let nonce = 0;
function prepared(intent: VenueIntent, opts: { account?: UserVenueAccount; signer?: VenueSigner } = {}): PreparedVenueAction {
  nonce += 1;
  const account = opts.account ?? sub;
  const isOrder = intent.kind === 'place_order';
  return {
    venueId: 'test-sim',
    account,
    signer: opts.signer ?? agent,
    intent,
    nonce: String(nonce),
    venueClientOrderId: isOrder ? venueClientOrderId('test-sim', intent.clientOrderKey) : null,
    typedData: { nonce },
    digest: `0xdigest${nonce}`,
    builderFee: null,
    preparedAt: T0,
  };
}

function buy(
  symbol: string,
  amount: string,
  price: string,
  key: string,
  extra: Partial<Extract<VenueIntent, { kind: 'place_order' }>> = {},
): VenueIntent {
  return {
    kind: 'place_order',
    symbol,
    side: 'buy',
    type: 'limit',
    amount: A(amount),
    price: A(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
    ...extra,
  };
}

function setup(world: Partial<World> = {}, opts: { marks?: Record<string, string>; withLeverage?: boolean } = {}) {
  const w: World = {
    balances: [{ asset: 'USDC', free: A('150'), locked: A('0'), total: A('150') }],
    openOrders: [],
    positions: [],
    leverageBps: null,
    ...world,
  };
  const raw = vi.fn(async (p: PreparedVenueAction): Promise<VenueSignature> => ({
    digest: p.digest,
    signature: '0xsig',
    signedBy: p.signer.address,
  }));
  const marks = (asset: string): MaybeKnown<Amount> =>
    opts.marks?.[asset] ? { known: true, value: A(opts.marks[asset]) } : { known: false };
  const signer = new CappedAgentSigner({ sign: raw, venue: fakeVenue(w, opts.withLeverage ?? true), marks, now: () => T0 });
  return { w, raw, signer };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; detail: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal;
  }
  throw new Error('expected a VenueRefusalError, the action was signed');
}

describe('CappedAgentSigner: an agent order past the cap is refused before the key signs', () => {
  it('PLANTED: a 250 USDC buy on a 200 USDC cap is refused, and the agent key is never asked', async () => {
    const { raw, signer } = setup({ balances: [{ asset: 'USDC', free: A('1000'), locked: A('0'), total: A('1000') }] });
    const r = await refusal(signer.sign(prepared(buy('ETH-USDC', '0.1', '2500', 'order:agent-1:planted:1')), cap));
    expect(r.code).toBe('agent_cap_exceeded');
    expect(r.detail).toContain('commits 250 USDC');
    expect(r.detail).toContain('200 USDC of room');
    expect(raw).not.toHaveBeenCalled();
  });

  it('signs an order inside the cap and reports the figures it judged on', async () => {
    const { raw, signer } = setup();
    const out = await signer.sign(prepared(buy('ETH-USDC', '0.05', '2000', 'order:agent-1:a:1')), cap);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(out.check.commitment).toBe(A('100'));
    expect(out.check.room).toBe(A('200'));
  });

  it('counts what is already in use: quote locked by resting orders, position margin and holdings at their mark', async () => {
    const resting: UserVenueOrder = {
      venueOrderId: 'v1',
      venueClientOrderId: '0xother',
      symbol: 'ETH-USDC',
      side: 'buy',
      type: 'limit',
      timeInForce: 'GTC',
      price: A('2000'),
      amount: A('0.02'),
      filled: A('0'),
      remaining: A('0.02'),
      averagePrice: null,
      status: 'open',
      locked: A('40'),
      lockedAsset: 'USDC',
      reduceOnly: false,
    };
    const position: UserVenuePosition = {
      symbol: 'BTC-PERP',
      side: 'long',
      size: A('0.01'),
      entryPrice: A('60000'),
      markPrice: A('60000'),
      unrealisedPnl: A('0'),
      marginMode: 'isolated',
      margin: A('60'),
      leverageBps: 100_000,
      liquidationPrice: { known: false },
    };
    const { raw, signer } = setup(
      {
        balances: [
          { asset: 'USDC', free: A('500'), locked: A('40'), total: A('540') },
          { asset: 'ETH', free: A('0.025'), locked: A('0'), total: A('0.025') },
        ],
        openOrders: [resting],
        positions: [position],
      },
      { marks: { ETH: '2000' } },
    );
    // in use: 40 locked + 60 margin + 0.025 ETH × 2000 = 150; room 50.
    const r = await refusal(signer.sign(prepared(buy('ETH-USDC', '0.026', '2000', 'order:agent-1:b:1')), cap));
    expect(r.code).toBe('agent_cap_exceeded');
    expect(r.detail).toContain('50 USDC of room');
    expect((await signer.sign(prepared(buy('ETH-USDC', '0.025', '2000', 'order:agent-1:b:2')), cap)).check.inUse).toBe(A('150'));
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('a perpetual commits its margin at the leverage the venue records, and the whole notional when it reports none', async () => {
    const tenX = setup({ leverageBps: 100_000 });
    const perp = () => prepared(buy('BTC-PERP', '0.025', '60000', 'order:agent-1:p:1')); // notional 1500
    expect((await tenX.signer.sign(perp(), cap)).check.commitment).toBe(A('150'));

    const noLeverageRead = setup({}, { withLeverage: false });
    expect((await refusal(noLeverageRead.signer.sign(perp(), cap))).code).toBe('agent_cap_exceeded');
    expect(noLeverageRead.raw).not.toHaveBeenCalled();

    const notSet = setup({ leverageBps: null });
    expect((await refusal(notSet.signer.sign(perp(), cap))).code).toBe('agent_cap_exceeded');
  });

  it('a perp short commits margin too; a spot sell and a reduce-only order commit nothing', async () => {
    const { raw, signer } = setup({ balances: [{ asset: 'USDC', free: A('1000'), locked: A('0'), total: A('1000') }] });
    const short = buy('BTC-PERP', '0.01', '60000', 'order:agent-1:s:1', { side: 'sell' });
    expect((await refusal(signer.sign(prepared(short), cap))).code).toBe('agent_cap_exceeded');
    await signer.sign(prepared(buy('ETH-USDC', '10', '2000', 'order:agent-1:s:2', { side: 'sell' })), cap);
    await signer.sign(prepared(buy('BTC-PERP', '1', '60000', 'order:agent-1:s:3', { reduceOnly: true })), cap);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it('a holding with no known mark makes the room unknown: a buy is refused, a sell still signs', async () => {
    const { raw, signer } = setup({
      balances: [
        { asset: 'USDC', free: A('100'), locked: A('0'), total: A('100') },
        { asset: 'ETH', free: A('0.01'), locked: A('0'), total: A('0.01') },
      ],
    });
    const r = await refusal(signer.sign(prepared(buy('ETH-USDC', '0.001', '2000', 'order:agent-1:m:1')), cap));
    expect(r.code).toBe('agent_cap_unmeasured');
    expect(r.detail).toContain('ETH');
    await signer.sign(prepared(buy('ETH-USDC', '0.01', '2000', 'order:agent-1:m:2', { side: 'sell' })), cap);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('a market quoted in another asset than the cap is refused as unmeasured', async () => {
    const { raw, signer } = setup();
    expect((await refusal(signer.sign(prepared(buy('SOL-USDT', '1', '1', 'order:agent-1:q:1')), cap))).code).toBe('agent_cap_unmeasured');
    expect(raw).not.toHaveBeenCalled();
  });

  it('two orders checked at once cannot both fit in the same room', async () => {
    const { raw, signer } = setup({ balances: [{ asset: 'USDC', free: A('1000'), locked: A('0'), total: A('1000') }] });
    const results = await Promise.allSettled([
      signer.sign(prepared(buy('ETH-USDC', '0.06', '2000', 'order:agent-1:c:1')), cap),
      signer.sign(prepared(buy('ETH-USDC', '0.06', '2000', 'order:agent-1:c:2')), cap),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(((results[1] as PromiseRejectedResult).reason as VenueRefusalError).refusal.code).toBe('agent_cap_exceeded');
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('a reservation stays until settled, is counted once the venue shows the order resting, and re-signing one key does not double it', async () => {
    const { w, signer } = setup({ balances: [{ asset: 'USDC', free: A('1000'), locked: A('0'), total: A('1000') }] });
    const first = prepared(buy('ETH-USDC', '0.06', '2000', 'order:agent-1:r:1')); // 120
    await signer.sign(first, cap);
    await signer.sign(first, cap); // the same stored action signed again: still one reservation
    expect((await refusal(signer.sign(prepared(buy('ETH-USDC', '0.05', '2000', 'order:agent-1:r:2')), cap))).code).toBe(
      'agent_cap_exceeded',
    );
    // The venue now shows it resting with its lock: counted by the lock, not twice.
    w.openOrders = [
      {
        venueOrderId: 'v9',
        venueClientOrderId: first.venueClientOrderId,
        symbol: 'ETH-USDC',
        side: 'buy',
        type: 'limit',
        timeInForce: 'GTC',
        price: A('2000'),
        amount: A('0.06'),
        filled: A('0'),
        remaining: A('0.06'),
        averagePrice: null,
        status: 'open',
        locked: A('120'),
        lockedAsset: 'USDC',
        reduceOnly: false,
      },
    ];
    expect((await signer.sign(prepared(buy('ETH-USDC', '0.04', '2000', 'order:agent-1:r:3')), cap)).check.inUse).toBe(A('120'));
    signer.settle(first.venueClientOrderId!);
  });

  it('an amend is judged with the order it replaces taken out', async () => {
    const key = 'order:agent-1:am:1';
    const resting: UserVenueOrder = {
      venueOrderId: 'v2',
      venueClientOrderId: venueClientOrderId('test-sim', key),
      symbol: 'ETH-USDC',
      side: 'buy',
      type: 'limit',
      timeInForce: 'GTC',
      price: A('2000'),
      amount: A('0.09'),
      filled: A('0'),
      remaining: A('0.09'),
      averagePrice: null,
      status: 'open',
      locked: A('180'),
      lockedAsset: 'USDC',
      reduceOnly: false,
    };
    const { raw, signer } = setup({ openOrders: [resting] });
    await signer.sign(prepared({ kind: 'amend_order', symbol: 'ETH-USDC', clientOrderKey: key, amount: A('0.1'), price: A('2000') }), cap);
    expect(
      (
        await refusal(
          signer.sign(prepared({ kind: 'amend_order', symbol: 'ETH-USDC', clientOrderKey: key, amount: A('0.11'), price: A('2000') }), cap),
        )
      ).code,
    ).toBe('agent_cap_exceeded');
    expect(
      (
        await refusal(
          signer.sign(
            prepared({
              kind: 'amend_order',
              symbol: 'ETH-USDC',
              clientOrderKey: 'order:agent-1:am:none',
              amount: A('0.01'),
              price: A('2000'),
            }),
            cap,
          ),
        )
      ).code,
    ).toBe('unknown_order');
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('a revoked or expired cap allows cancels only', async () => {
    for (const c of [
      { ...cap, revokedAt: T0 },
      { ...cap, validUntil: T0 },
    ]) {
      const { raw, signer } = setup();
      expect((await refusal(signer.sign(prepared(buy('ETH-USDC', '0.001', '2000', 'order:agent-1:x:1')), c))).code).toBe(
        'agent_cap_inactive',
      );
      expect(
        (
          await refusal(
            signer.sign(prepared({ kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' }), c),
          )
        ).code,
      ).toBe('agent_cap_inactive');
      await signer.sign(prepared({ kind: 'cancel_order', symbol: 'ETH-USDC', clientOrderKey: 'order:agent-1:x:0' }), c);
      expect(raw).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses another key, another account, and an owner-only action, with nothing signed', async () => {
    const { raw, signer } = setup();
    const order = buy('ETH-USDC', '0.001', '2000', 'order:agent-1:o:1');
    expect((await refusal(signer.sign(prepared(order, { signer: { role: 'agent', address: '0xother' } }), cap))).code).toBe(
      'agent_outside_capped_account',
    );
    expect((await refusal(signer.sign(prepared(order, { signer: { role: 'owner', address: '0xowner' } }), cap))).code).toBe(
      'agent_outside_capped_account',
    );
    expect((await refusal(signer.sign(prepared(order, { account: { ...sub, subAccount: null } }), cap))).code).toBe(
      'agent_outside_capped_account',
    );
    expect((await refusal(signer.sign(prepared(order, { account: { ...sub, subAccount: '0xsub2' } }), cap))).code).toBe(
      'agent_outside_capped_account',
    );
    const withdraw: VenueIntent = {
      kind: 'withdraw',
      asset: 'USDC',
      amount: A('1'),
      destination: '0xowner',
      withdrawalKey: 'withdraw:x:1',
    };
    expect((await refusal(signer.sign(prepared(withdraw), cap))).code).toBe('agent_not_permitted');
    expect(raw).not.toHaveBeenCalled();
  });

  it('a signature for another payload is refused and reserves nothing', async () => {
    const raw = vi.fn(async (p: PreparedVenueAction): Promise<VenueSignature> => ({
      digest: '0xelse',
      signature: '0xsig',
      signedBy: p.signer.address,
    }));
    const w: World = { balances: [], openOrders: [], positions: [], leverageBps: null };
    const signer = new CappedAgentSigner({ sign: raw, venue: fakeVenue(w), marks: () => ({ known: false }), now: () => T0 });
    expect((await refusal(signer.sign(prepared(buy('ETH-USDC', '0.09', '2000', 'order:agent-1:g:1')), cap))).code).toBe(
      'signature_mismatch',
    );
    const ok = new CappedAgentSigner({
      sign: async (p) => ({ digest: p.digest, signature: '0xs', signedBy: p.signer.address }),
      venue: fakeVenue(w),
      marks: () => ({ known: false }),
      now: () => T0,
    });
    expect((await ok.sign(prepared(buy('ETH-USDC', '0.1', '2000', 'order:agent-1:g:2')), cap)).check.room).toBe(A('200'));
  });
});

describe('the funding cap and the owner ceiling (J-agents-21 steps 1, 4, 5)', () => {
  function capError(fn: () => void): AgentCapError {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCapError);
      return error as AgentCapError;
    }
    throw new Error('expected an AgentCapError');
  }

  it('a blank ceiling refuses every cap; a cap above the ceiling is refused naming it', () => {
    expect(capError(() => assertAgentCapWithinCeiling(A('200'), null, 'USDC')).code).toBe('agents.account_ceiling_unset');
    const above = capError(() => assertAgentCapWithinCeiling(A('600'), A('500'), 'USDC'));
    expect(above.code).toBe('agents.account_cap_above_ceiling');
    expect(above.room).toBe(A('500'));
    expect(capError(() => assertAgentCapWithinCeiling(A('0'), A('500'), 'USDC')).code).toBe('agents.account_cap_invalid');
    assertAgentCapWithinCeiling(A('500'), A('500'), 'USDC');
  });

  it('funding 150 then 100 more on a 200 cap is refused naming 50 of room; moves out give room back', () => {
    assertAgentFundingWithinCap(cap, A('0'), A('0'), A('150'));
    const e = capError(() => assertAgentFundingWithinCap(cap, A('150'), A('0'), A('100')));
    expect(e.code).toBe('agents.account_cap_exceeded');
    expect(e.room).toBe(A('50'));
    expect(e.detail).toContain('50 USDC of room');
    assertAgentFundingWithinCap(cap, A('150'), A('0'), A('50'));
    assertAgentFundingWithinCap(cap, A('150'), A('100'), A('150'));
    expect(capError(() => assertAgentFundingWithinCap(cap, A('0'), A('0'), A('-1'))).code).toBe('agents.account_cap_invalid');
  });
});
