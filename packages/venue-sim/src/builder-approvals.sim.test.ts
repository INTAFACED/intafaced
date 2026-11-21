import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_BUILDER_APPROVAL_LIMIT, TestVenueSimulator } from './simulator.js';
import { buildTypedData, digestOf, type TestVenueTypedData } from './signing.js';
import { TEST_VENUE_MARKETS } from './http-server.js';

// J-derivatives-30: a person sees, revokes and is refused builder-fee approvals as the venue keeps them. As the venue it
// stands for publishes (Hyperliquid `trading/builder-codes.md`, read 20 Nov 2026): a user "can revoke permissions at any
// time" (an approval of zero), and "can have a maximum of 10 active builder code approvals at a time".
const a = parseAmount;
const OURS = '0x7e57000000000000000000000000000000000b1d';
const other = (i: number) => `0x0be7${i.toString(16).padStart(36, '0')}`;

function world() {
  const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 21, 10, 0, 0)), markets: TEST_VENUE_MARKETS });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet builder-approvals')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const sign = async (prepared: PreparedVenueAction) => {
    const typed = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    return { digest: prepared.digest, signature, signedBy: owner };
  };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
    return sim.submit(prepared, await sign(prepared));
  };
  const approve = (builder: string, bps: string) => run({ kind: 'approve_builder_fee', builder, maxFeeBps: a(bps) });
  const approved = async (builder: string) => (await sim.builderFeeApproval(account, builder)).value;
  return { sim, account, signer, sign, run, approve, approved };
}

async function refusal(p: Promise<unknown>): Promise<VenueRefusalError['refusal']> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(VenueRefusalError);
    return (error as VenueRefusalError).refusal;
  }
  throw new Error('expected a refusal');
}

describe("the venue's builder-fee approvals", () => {
  it('a revoke is an approval of zero: the venue then reports no approval, and an order carrying the fee is refused', async () => {
    const w = world();
    expect((await w.approve(OURS, '0.5')).definite).toBe(true);
    expect(await w.approved(OURS)).toBe(a('0.5'));
    const revoked = await w.approve(OURS, '0');
    expect(revoked).toMatchObject({ definite: true, accepted: true });
    expect(await w.approved(OURS)).toBe(0n);
    const order: VenueIntent = {
      kind: 'place_order',
      symbol: 'BTC-PERP',
      side: 'buy',
      type: 'limit',
      amount: a('0.01'),
      price: a('50000'),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: 'order:revoked:1',
      builderFee: { builder: OURS, feeBps: a('0.5') },
    };
    await w.run({ kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' });
    expect((await refusal(w.sim.prepare(w.account, w.signer, order))).code).toBe('builder_fee_not_approved');
  });

  it(`an account holding ${TEST_VENUE_BUILDER_APPROVAL_LIMIT} active approvals is refused another builder's, in the venue's words with its limit`, async () => {
    const w = world();
    for (let i = 0; i < TEST_VENUE_BUILDER_APPROVAL_LIMIT; i++) await w.approve(other(i), '1');
    const r = await refusal(w.sim.prepare(w.account, w.signer, { kind: 'approve_builder_fee', builder: OURS, maxFeeBps: a('0.5') }));
    expect(r.code).toBe('builder_approval_limit');
    expect(r.detail).toBe(
      `this account already holds 10 active builder fee approvals, the most ${w.sim.venue.displayName} allows at a time (10)`,
    );
    expect(await w.approved(OURS)).toBe(0n);
    // One already approved may still be raised, lowered or revoked: none of those takes a new place.
    expect((await w.approve(other(0), '2')).definite).toBe(true);
    expect(await w.approved(other(0))).toBe(a('2'));
    // Revoking one of the others frees a place, and ours is then taken.
    await w.approve(other(1), '0');
    expect(await w.approve(OURS, '0.5')).toMatchObject({ definite: true, accepted: true });
    expect(await w.approved(OURS)).toBe(a('0.5'));
  });

  it('a hand-built approval past the limit, signed, is refused again at submit and approves nothing', async () => {
    const w = world();
    for (let i = 0; i < TEST_VENUE_BUILDER_APPROVAL_LIMIT; i++) await w.approve(other(i), '1');
    const intent: VenueIntent = { kind: 'approve_builder_fee', builder: OURS, maxFeeBps: a('0.5') };
    const nonce = String(Date.UTC(2026, 10, 21, 10, 0, 1) * 1000);
    const typedData = buildTypedData(w.sim.venue.id, w.account, w.signer, intent, nonce, w.sim.chainId);
    const prepared: PreparedVenueAction = {
      venueId: w.sim.venue.id,
      account: w.account,
      signer: w.signer,
      intent,
      nonce,
      venueClientOrderId: null,
      typedData,
      digest: digestOf(typedData),
      builderFee: null,
      preparedAt: new Date(),
    };
    const outcome = await w.sim.submit(prepared, await w.sign(prepared));
    expect(outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'builder_approval_limit' } });
    expect(await w.approved(OURS)).toBe(0n);
  });

  it('an agent key signs neither an approval nor a revoke', async () => {
    const w = world();
    await w.approve(OURS, '0.5');
    const agent = { role: 'agent' as const, address: other(99) };
    for (const bps of ['0.5', '0'])
      expect((await refusal(w.sim.prepare(w.account, agent, { kind: 'approve_builder_fee', builder: OURS, maxFeeBps: a(bps) }))).code).toBe(
        'agent_not_permitted',
      );
    expect(await w.approved(OURS)).toBe(a('0.5'));
  });
});
