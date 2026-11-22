import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TEST_STAKING, TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-cex-spot-21 at the venue: staking is the venue's. Each move into or out of staking and each delegation is the owner's
 * own signed action, applied once; the venue keeps the delegation lock-up and refuses an early undelegation before
 * anything is signed, queues a move back to spot for its own time, refuses a new one at its pending limit when the signed
 * move arrives, and takes its staking discount off its own fee only. Every figure is TEST.
 */

const a = parseAmount;
const BTC_USDC = { ...TEST_VENUE_MARKETS.find((m) => m.symbol === 'BTC-USDC')! };
const [ONE, TWO, JAILED] = TEST_STAKING.validators;
const DAY = 86_400_000;

function testWallet(name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role: 'owner', address } as const,
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

async function world() {
  let now = Date.UTC(2026, 10, 22, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [BTC_USDC] });
  const person = testWallet('js21-person');
  const account: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  sim.deposit(account, 'HYPE', a('1000'), 'chain:js21:person');
  let n = 0;
  const transfer = (direction: 'to_staking' | 'to_spot', amount: string): VenueIntent => ({
    kind: 'staking_transfer',
    direction,
    asset: 'HYPE',
    amount: a(amount),
    moveKey: `stake-move:js21:${direction}:${++n}`,
  });
  const delegate = (validator: string, direction: 'delegate' | 'undelegate', amount: string): VenueIntent => ({
    kind: 'staking_delegate',
    validator,
    direction,
    asset: 'HYPE',
    amount: a(amount),
    moveKey: `delegation:js21:${direction}:${++n}`,
  });
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, person.signer, intent);
    const signature = await person.sign(prepared);
    const outcome = await sim.submit(prepared, signature);
    now += 1000;
    return { outcome, prepared, signature };
  };
  const hype = async () => (await sim.balances(account)).value.find((b) => b.asset === 'HYPE')!;
  const mine = async () => (await sim.stakingAccount(account)).value;
  const later = (ms: number) => (now += ms);
  return { sim, account, transfer, delegate, run, hype, mine, later };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof VenueRefusalError) return e.refusal;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('J-cex-spot-21 staking on the TEST venue', () => {
  it('publishes its validators, reward rate, discount tiers, lock-up, queue and limit; the reward rate can be withheld', async () => {
    const { sim } = await world();
    const terms = (await sim.staking()).value;
    expect(terms).toMatchObject({
      asset: 'HYPE',
      rewardRateBps: 230,
      delegationLockUpSeconds: 86_400,
      unstakingQueueSeconds: 7 * 86_400,
      maxPendingWithdrawals: 5,
    });
    expect(terms.validators.map((v) => [v.name, v.commissionBps, v.status])).toEqual([
      ['TEST Validator One', 300, 'active'],
      ['TEST Validator Two', 500, 'active'],
      ['TEST Validator Three', 1_000, 'jailed'],
    ]);
    expect(terms.discountTiers!.map((t) => t.discountBps)).toEqual([500, 1_000, 1_500, 2_000, 3_000, 4_000]);
    sim.testStakingPublished({ rewardRate: false });
    expect((await sim.staking()).value.rewardRateBps).toBeNull();
  });

  it('moves spot to staking and delegates, each once; the coins stay in the balance as locked, split as the venue holds them', async () => {
    const { sim, transfer, delegate, run, hype, mine } = await world();
    const staked = await run(transfer('to_staking', '200'));
    expect(staked.outcome).toMatchObject({ definite: true, accepted: true });
    expect(await sim.submit(staked.prepared, staked.signature)).toEqual(staked.outcome);
    expect(formatAmount((await hype()).free)).toBe('800');
    expect((await mine()).staked).toBe(a('200'));
    await run(delegate(ONE!.address, 'delegate', '150'));
    const after = await mine();
    expect(after.staked).toBe(a('50'));
    expect(after.delegations).toEqual([expect.objectContaining({ validator: ONE!.address, amount: a('150') })]);
    expect(after.delegations[0]!.lockUpEndsAt.getTime()).toBeGreaterThan(Date.UTC(2026, 10, 23, 5, 0, 0));
    const b = await hype();
    expect(b.total).toBe(a('1000'));
    expect(b.lockedBy).toEqual({ inOrders: 0n, margin: 0n, staked: a('50'), delegated: a('150'), unstaking: 0n });
    const validator = (await sim.staking()).value.validators.find((v) => v.address === ONE!.address)!;
    expect(validator.totalStake).toBe(a('10150'));
  });

  it('refuses more than free, more than staked, a jailed validator, and an undelegation before the lock-up, at prepare', async () => {
    const { sim, account, transfer, delegate, run } = await world();
    const signer = { role: 'owner', address: account.owner } as const;
    expect((await refusal(sim.prepare(account, signer, transfer('to_staking', '1001')))).code).toBe('insufficient_balance');
    await run(transfer('to_staking', '100'));
    expect((await refusal(sim.prepare(account, signer, delegate(ONE!.address, 'delegate', '101')))).code).toBe('insufficient_balance');
    expect((await refusal(sim.prepare(account, signer, delegate(JAILED!.address, 'delegate', '10')))).detail).toContain('jailed');
    await run(delegate(ONE!.address, 'delegate', '100'));
    const ends = (await sim.stakingAccount(account)).value.delegations[0]!.lockUpEndsAt;
    const early = await refusal(sim.prepare(account, signer, delegate(ONE!.address, 'undelegate', '100')));
    expect(early).toMatchObject({ code: 'venue_rejected' });
    expect(early.detail).toContain(ends.toISOString());
  });

  it('after the lock-up undelegates; to spot waits in the queue, then arrives', async () => {
    const { sim, account, transfer, delegate, run, hype, mine, later } = await world();
    await run(transfer('to_staking', '200'));
    await run(delegate(ONE!.address, 'delegate', '150'));
    later(DAY + 1000);
    expect((await run(delegate(ONE!.address, 'undelegate', '150'))).outcome).toMatchObject({ accepted: true });
    expect((await mine()).staked).toBe(a('200'));
    expect((await mine()).delegations).toEqual([]);
    const out = await run(transfer('to_spot', '50'));
    expect(out.outcome).toMatchObject({ accepted: true });
    const pending = (await mine()).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.arrivesAt.getTime() - pending[0]!.requestedAt.getTime()).toBe(7 * DAY);
    expect(formatAmount((await hype()).free)).toBe('800');
    sim.testStaking(account, { passQueue: true });
    expect((await mine()).pending).toEqual([]);
    expect((await mine()).arrived).toHaveLength(1);
    expect(formatAmount((await hype()).free)).toBe('850');
    expect((await hype()).total).toBe(a('1000'));
  });

  it('a reward adds to the delegation and the total; the parts still add to the total', async () => {
    const { sim, account, transfer, delegate, run, hype, mine } = await world();
    await run(transfer('to_staking', '200'));
    await run(delegate(TWO!.address, 'delegate', '100'));
    sim.testStaking(account, { reward: { validator: TWO!.address, amount: a('1.5'), rewardRef: 'r1' } });
    sim.testStaking(account, { reward: { validator: TWO!.address, amount: a('1.5'), rewardRef: 'r1' } });
    expect((await mine()).rewards.total).toBe(a('1.5'));
    const b = await hype();
    expect(b.total).toBe(a('1001.5'));
    const s = b.lockedBy!;
    expect(s.inOrders + s.margin + s.staked + s.delegated! + s.unstaking! + b.free).toBe(b.total);
  });

  it("refuses a further move to spot at the venue's pending limit when the signed move arrives, naming the limit", async () => {
    const { sim, account, transfer, run, mine } = await world();
    await run(transfer('to_staking', '100'));
    sim.testStaking(account, { fillPending: a('1') });
    expect((await mine()).pending).toHaveLength(5);
    // Prepared and signed: the limit is the venue's to apply on arrival.
    const sent = await run(transfer('to_spot', '1'));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'venue_rejected' } });
    const o = sent.outcome;
    if (!o.definite || o.accepted) throw new Error('expected a definite refusal');
    expect(o.refusal.detail).toContain('at most 5');
    expect((await mine()).pending).toHaveLength(5);
    expect((await mine()).staked).toBe(a('95'));
  });

  it("takes the staking discount off the venue's fee only, from the tier the delegated stake reaches", async () => {
    const { sim, account, transfer, delegate, run } = await world();
    const before = (await sim.feeStatus(account)).value.account!.stakingDiscount!;
    expect(before).toMatchObject({ countedStake: 0n, tierName: null, discountBps: 0 });
    await run(transfer('to_staking', '200'));
    await run(delegate(ONE!.address, 'delegate', '150'));
    const d = (await sim.feeStatus(account)).value.account!.stakingDiscount!;
    expect(d).toMatchObject({ asset: 'HYPE', countedStake: a('150'), tierName: 'Bronze', discountBps: 1_000 });
    const m = d.markets.find((x) => x.symbol === 'BTC-USDC')!;
    expect(m.before.takerFeeBps).toEqual(BTC_USDC.takerFeeBps);
    if (!m.before.takerFeeBps.known || !m.after.takerFeeBps.known) throw new Error('BTC-USDC publishes a taker fee');
    expect(m.after.takerFeeBps.value).toBe((m.before.takerFeeBps.value * 9_000n) / 10_000n);
  });

  it('refuses an agent key and a sub-account', async () => {
    const { sim, account, transfer } = await world();
    const agent = { role: 'agent', address: '0x00000000000000000000000000000000000a6e71' } as const;
    expect((await refusal(sim.prepare(account, agent, transfer('to_staking', '1')))).code).toBe('agent_not_permitted');
    expect(
      (
        await refusal(
          sim.prepare({ ...account, subAccount: '0xsub' }, { role: 'owner', address: account.owner }, transfer('to_staking', '1')),
        )
      ).code,
    ).toBe('not_offered');
  });
});
