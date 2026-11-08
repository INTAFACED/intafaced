import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  CappedAgentSigner,
  VenueRefusalError,
  type AgentCap,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
  type VenueSignature,
  type VenueSigner,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * The agent cap (venue-contracts `agent-cap.ts`) on the real TEST venue: the agent key's
 * signatures are real EIP-712 signatures the simulator verifies, and the cap reads the
 * simulator's own record. A planted over-cap order is refused before the key signs.
 */

const a = parseAmount;

function key(name: string) {
  return privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
}

async function signWith(k: ReturnType<typeof key>, prepared: PreparedVenueAction): Promise<VenueSignature> {
  const typed = prepared.typedData as TestVenueTypedData;
  const signature = await k.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return { digest: prepared.digest, signature, signedBy: k.address.toLowerCase() };
}

const SPOT: SimMarketConfig = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
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

function buy(symbol: string, amount: string, price: string, clientOrderKey: string): PlaceUserOrderIntent {
  return {
    kind: 'place_order',
    symbol,
    side: 'buy',
    type: 'limit',
    amount: a(amount),
    price: a(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey,
    builderFee: null,
  };
}

async function setup() {
  let now = Date.UTC(2026, 10, 8, 20, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [SPOT, PERP] });
  const ownerKey = key('cap-owner');
  const agentKey = key('cap-owner-agent');
  const owner: VenueSigner = { role: 'owner', address: ownerKey.address.toLowerCase() };
  const agent: VenueSigner = { role: 'agent', address: agentKey.address.toLowerCase() };
  const account: UserVenueAccount = { venueId: sim.venue.id, owner: owner.address, subAccount: null };
  sim.deposit(account, 'USDC', a('1000'), 'deposit:test-chain:0xcap:0');
  const approve = await sim.prepare(account, owner, {
    kind: 'approve_agent',
    agentAddress: agent.address,
    agentName: 'TEST assistant',
    validUntil: null,
  });
  expect((await sim.submit(approve, await signWith(ownerKey, approve))).definite).toBe(true);
  now += 1000;

  const raw = vi.fn((prepared: PreparedVenueAction) => signWith(agentKey, prepared));
  const signer = new CappedAgentSigner({
    sign: raw,
    venue: sim,
    marks: (asset) => (asset === 'BTC' ? { known: true, value: a('60000') } : { known: false }),
    now: () => new Date(now),
  });
  const cap: AgentCap = { account, agentAddress: agent.address, asset: 'USDC', cap: a('200'), validUntil: null, revokedAt: null };
  /** Prepare on the venue, sign only through the cap, submit, and settle the reservation on a definite answer. */
  const act = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, agent, intent);
    const { signature } = await signer.sign(prepared, cap);
    const outcome = await sim.submit(prepared, signature);
    now += 1000;
    if (outcome.definite) signer.settle(prepared.venueClientOrderId ?? prepared.nonce);
    return outcome;
  };
  return { sim, account, raw, act };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; detail: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal;
  }
  throw new Error('expected a refusal; the agent key signed');
}

describe('the agent cap on the TEST venue simulator', () => {
  it('PLANTED: an over-cap agent order is refused before the agent key signs, and the venue never sees it', async () => {
    const { sim, account, raw, act } = await setup();
    const first = await act(buy('BTC-USDC', '0.003', '60000', 'order:cap-agent:sim:1')); // 180 USDC, rests
    expect(first).toMatchObject({ definite: true, accepted: true });
    expect(raw).toHaveBeenCalledTimes(1);

    const r = await refusal(act(buy('BTC-USDC', '0.001', '60000', 'order:cap-agent:sim:2'))); // 60 more on a 200 cap
    expect(r.code).toBe('agent_cap_exceeded');
    expect(raw).toHaveBeenCalledTimes(1);
    const open = (await sim.openOrders(account)).value;
    expect(open).toHaveLength(1);
  });

  it("a leverage cut that would take a resting perp order past the cap is refused, on the venue's own leverage record", async () => {
    const { sim, account, raw, act } = await setup();
    expect(await act({ kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' })).toMatchObject({
      definite: true,
      accepted: true,
    });
    expect((await sim.leverage(account, 'BTC-PERP')).value?.leverageBps).toBe(100_000);
    expect(await act(buy('BTC-PERP', '0.02', '59000', 'order:cap-agent:sim:p1'))).toMatchObject({ definite: true, accepted: true }); // 1180 / 10x ≈ 118 margin
    const r = await refusal(act({ kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 20_000, marginMode: 'isolated' })); // 1180 / 2x = 590
    expect(r.code).toBe('agent_cap_exceeded');
    expect(raw).toHaveBeenCalledTimes(2);
    expect((await sim.leverage(account, 'BTC-PERP')).value?.leverageBps).toBe(100_000);
  });
});
