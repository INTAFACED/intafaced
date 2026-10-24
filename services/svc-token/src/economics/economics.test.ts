/**
 * The economics suite.
 *
 * §5 of the agent protocol: every money path carries invariant tests, not example tests. The
 * bar here is "no input loses or invents a unit", so the split and distribution tests are
 * written as property loops over adversarial value tables — 1 wei, primes, values one below
 * a rounding boundary — rather than a handful of round numbers that would pass against a
 * float implementation too.
 */

import { describe, expect, it } from 'vitest';
import { type Amount, MAX_AMOUNT, MoneyError, ZERO, formatAmount, parseAmount as amt, sum } from '@intafaced/ledger-client';
import {
  DEFAULT_EMISSION_PARAMS,
  type EmissionParams,
  cumulativeEmission,
  epochReward,
  epochsUntilHalving,
  isExhausted,
  remainingSupply,
} from './emission.js';
import {
  ACCESS_TIERS,
  DEFAULT_FEE_DISCOUNT_SCHEDULE,
  MAX_FEE_DISCOUNT_BPS,
  STAKE_TIERS,
  type FeeDiscountSchedule,
  type StakeTier,
  accessTierFor,
  feeDiscountBps,
  feeDiscountSchedulePayload,
  feeDiscountScheduleVersion,
  isUnlocked,
  parseFeeDiscountSchedule,
  publishableFeeDiscountSchedule,
  stakeWeight,
  unlockDate,
} from './staking.js';
import { DEFAULT_BUYBACK_PARAMS, buybackBudget, distributeYield, sizeIocBuyFromAsks, splitBuyback } from './buyback.js';

const WEI = 1n;
const D = DEFAULT_EMISSION_PARAMS;
const INTERVAL = D.halvingIntervalEpochs;

/** Small params make a brute-force cross-check tractable without changing the arithmetic under test. */
const TINY: EmissionParams = {
  initialEpochReward: amt('100'),
  halvingIntervalEpochs: 10,
  maxSupply: amt('1000000'),
};

/** Sums the schedule the slow, obvious way — the oracle for the closed-form era sum. */
function bruteCumulative(throughEpoch: number, params: EmissionParams): Amount {
  let total = ZERO;
  for (let e = 0; e <= throughEpoch; e++) total += epochReward(e, params);
  return total > params.maxSupply ? params.maxSupply : total;
}

describe('emission — the mint schedule (§4.3)', () => {
  it('pays the initial reward in epoch 0', () => {
    expect(epochReward(0, D)).toBe(D.initialEpochReward);
  });

  it('defaults its params so the schedule can be queried without them', () => {
    expect(epochReward(0)).toBe(D.initialEpochReward);
    expect(cumulativeEmission(0)).toBe(D.initialEpochReward);
  });

  it('holds the reward flat across the whole of era 0', () => {
    expect(epochReward(1, D)).toBe(D.initialEpochReward);
    expect(epochReward(INTERVAL - 2, D)).toBe(D.initialEpochReward);
    expect(epochReward(INTERVAL - 1, D)).toBe(D.initialEpochReward);
  });

  it('halves ON the boundary epoch, not one past it', () => {
    expect(epochReward(INTERVAL - 1, D)).toBe(D.initialEpochReward);
    expect(epochReward(INTERVAL, D)).toBe(D.initialEpochReward / 2n);
    expect(epochReward(INTERVAL + 1, D)).toBe(D.initialEpochReward / 2n);
  });

  it('quarters at the second boundary and eighths at the third', () => {
    expect(epochReward(2 * INTERVAL, D)).toBe(D.initialEpochReward / 4n);
    expect(epochReward(3 * INTERVAL - 1, D)).toBe(D.initialEpochReward / 4n);
    expect(epochReward(3 * INTERVAL, D)).toBe(D.initialEpochReward / 8n);
  });

  it('never goes negative and never increases', () => {
    let previous = epochReward(0, D);
    for (let e = 1; e < 200_000; e += 137) {
      const reward = epochReward(e, D);
      expect(reward >= ZERO).toBe(true);
      expect(reward <= previous).toBe(true);
      previous = reward;
    }
  });

  it('floors to exactly 0 once the halvings pass one unit (10^-18)', () => {
    const bits = D.initialEpochReward.toString(2).length;
    const lastPayingEpoch = bits * INTERVAL - 1;

    expect(epochReward(lastPayingEpoch, D)).toBe(WEI);
    expect(epochReward(lastPayingEpoch + 1, D)).toBe(ZERO);
    expect(epochReward(lastPayingEpoch + 1_000_000, D)).toBe(ZERO);
  });

  it('reaches zero rather than dust for a 1-wei initial reward', () => {
    const oneWei: EmissionParams = { initialEpochReward: WEI, halvingIntervalEpochs: 5, maxSupply: amt('1') };
    expect(epochReward(4, oneWei)).toBe(WEI);
    expect(epochReward(5, oneWei)).toBe(ZERO);
  });

  it('handles an interval of 1 — a halving every epoch', () => {
    const fast: EmissionParams = { initialEpochReward: amt('8'), halvingIntervalEpochs: 1, maxSupply: amt('100') };
    expect(epochReward(0, fast)).toBe(amt('8'));
    expect(epochReward(1, fast)).toBe(amt('4'));
    expect(epochReward(3, fast)).toBe(amt('1'));
  });

  it('rejects epochs that are not non-negative integers', () => {
    expect(() => epochReward(-1, D)).toThrow(RangeError);
    expect(() => epochReward(1.5, D)).toThrow(RangeError);
    expect(() => epochReward(Number.NaN, D)).toThrow(RangeError);
    expect(() => cumulativeEmission(-1, D)).toThrow(RangeError);
    expect(() => epochsUntilHalving(-1, D)).toThrow(RangeError);
  });

  it('rejects a non-positive halving interval instead of dividing by zero', () => {
    expect(() => epochReward(0, { ...D, halvingIntervalEpochs: 0 })).toThrow(RangeError);
    expect(() => epochReward(0, { ...D, halvingIntervalEpochs: -4 })).toThrow(RangeError);
    expect(() => epochReward(0, { ...D, halvingIntervalEpochs: 1.5 })).toThrow(RangeError);
  });
});

describe('emission — cumulative', () => {
  it('equals the epoch-by-epoch sum across the first three eras', () => {
    for (const e of [0, 1, 9, 10, 11, 19, 20, 25, 29, 30, 31]) {
      expect(cumulativeEmission(e, TINY)).toBe(bruteCumulative(e, TINY));
    }
  });

  it('equals the epoch-by-epoch sum at default-parameter boundaries', () => {
    for (const e of [0, INTERVAL - 1, INTERVAL, INTERVAL + 1, 2 * INTERVAL]) {
      expect(cumulativeEmission(e, D)).toBe(bruteCumulative(e, D));
    }
  });

  it('never decreases', () => {
    let previous = cumulativeEmission(0, D);
    for (let e = 1; e < 20_000; e += 97) {
      const total = cumulativeEmission(e, D);
      expect(total >= previous).toBe(true);
      previous = total;
    }
  });

  it('never exceeds maxSupply, at any depth', () => {
    for (const e of [0, 1, INTERVAL, 10 * INTERVAL, 100_000, 1_000_000, 10_000_000]) {
      expect(cumulativeEmission(e, D) <= D.maxSupply).toBe(true);
    }
  });

  it('clamps to maxSupply rather than throwing when the curve outruns the cap', () => {
    const capped: EmissionParams = { initialEpochReward: amt('100'), halvingIntervalEpochs: 10, maxSupply: amt('250') };
    expect(cumulativeEmission(0, capped)).toBe(amt('100'));
    expect(cumulativeEmission(1, capped)).toBe(amt('200'));
    expect(cumulativeEmission(2, capped)).toBe(amt('250'));
    expect(cumulativeEmission(9_999, capped)).toBe(amt('250'));
  });

  it('answers a millionth-epoch query fast — eras are summed, not epochs', () => {
    const started = Date.now();
    for (let i = 0; i < 50; i++) cumulativeEmission(1_000_000, D);
    expect(Date.now() - started).toBeLessThan(250);
  });

  /**
   * SCOPE: this describes `DEFAULT_EMISSION_PARAMS`, a test shape. The migration
   * does not publish a supply or an emission amount. A blank row refuses.
   */
  it('converges below the SEED cap — a property of constants that never run, not of the economy', () => {
    const terminal = cumulativeEmission(1_000_000, D);
    const geometricLimit = 2n * D.initialEpochReward * BigInt(INTERVAL);

    expect(terminal < D.maxSupply).toBe(true);
    // Integer halving truncates a wei per era, so the real total lands just under the
    // geometric limit — under it by less than a single IFC across the entire schedule.
    expect(terminal < geometricLimit).toBe(true);
    expect(geometricLimit - terminal < amt('1')).toBe(true);
    expect(formatAmount(geometricLimit)).toBe('397120000');
  });

  it('stops growing once the reward is zero', () => {
    const bits = D.initialEpochReward.toString(2).length;
    const lastPayingEpoch = bits * INTERVAL - 1;
    expect(cumulativeEmission(lastPayingEpoch + 1, D)).toBe(cumulativeEmission(lastPayingEpoch, D));
    expect(cumulativeEmission(5_000_000, D)).toBe(cumulativeEmission(lastPayingEpoch, D));
  });
});

describe('emission — remaining supply and exhaustion', () => {
  it('reports remaining as cap minus minted, never negative', () => {
    for (const e of [0, 1, INTERVAL, 250_000, 1_000_000]) {
      const remaining = remainingSupply(e, D);
      expect(remaining >= ZERO).toBe(true);
      expect(remaining).toBe(D.maxSupply - cumulativeEmission(e, D));
    }
  });

  it('is not exhausted while the schedule still pays', () => {
    expect(isExhausted(0, D)).toBe(false);
    expect(isExhausted(INTERVAL, D)).toBe(false);
    expect(isExhausted(100_000, D)).toBe(false);
  });

  it('is exhausted the epoch before the reward hits zero, and stays exhausted', () => {
    const bits = D.initialEpochReward.toString(2).length;
    const lastPayingEpoch = bits * INTERVAL - 1;
    expect(isExhausted(lastPayingEpoch - 1, D)).toBe(false);
    expect(isExhausted(lastPayingEpoch, D)).toBe(true);
    expect(isExhausted(1_000_000, D)).toBe(true);
  });

  it('is exhausted when the cap is consumed even though the curve would still pay', () => {
    const capped: EmissionParams = { initialEpochReward: amt('100'), halvingIntervalEpochs: 10, maxSupply: amt('250') };
    expect(isExhausted(1, capped)).toBe(false);
    expect(remainingSupply(2, capped)).toBe(ZERO);
    expect(isExhausted(2, capped)).toBe(true);
    expect(epochReward(3, capped)).toBe(amt('100'));
  });
});

describe('emission — halving countdown', () => {
  it('returns a full interval at a boundary epoch, having just reset', () => {
    expect(epochsUntilHalving(0, D)).toBe(INTERVAL);
    expect(epochsUntilHalving(INTERVAL, D)).toBe(INTERVAL);
    expect(epochsUntilHalving(2 * INTERVAL, D)).toBe(INTERVAL);
  });

  it('counts down to 1 on the last epoch of an era', () => {
    expect(epochsUntilHalving(INTERVAL - 1, D)).toBe(1);
    expect(epochsUntilHalving(INTERVAL - 2, D)).toBe(2);
    expect(epochsUntilHalving(2 * INTERVAL - 1, D)).toBe(1);
  });

  it('lands exactly on the epoch where the reward halves, from anywhere in the era', () => {
    for (const e of [0, 1, 7, 999, INTERVAL - 1, INTERVAL + 500, 5 * INTERVAL + 3]) {
      const next = e + epochsUntilHalving(e, D);
      expect(epochReward(next, D)).toBe(epochReward(e, D) / 2n);
      expect(epochReward(next - 1, D)).toBe(epochReward(e, D));
    }
  });

  it('always returns a value in [1, interval]', () => {
    for (let e = 0; e < 5_000; e += 13) {
      const remaining = epochsUntilHalving(e, D);
      expect(remaining).toBeGreaterThanOrEqual(1);
      expect(remaining).toBeLessThanOrEqual(INTERVAL);
    }
  });
});

describe('staking — tiers and multipliers (§4.3)', () => {
  it('orders multipliers m12 > m3 > flex, with flex at exactly 1.0x', () => {
    expect(STAKE_TIERS.flex.multiplierBps).toBe(10_000);
    expect(STAKE_TIERS.m3.multiplierBps).toBeGreaterThan(STAKE_TIERS.flex.multiplierBps);
    expect(STAKE_TIERS.m12.multiplierBps).toBeGreaterThan(STAKE_TIERS.m3.multiplierBps);
  });

  it('orders lock durations the same way as the multipliers', () => {
    expect(STAKE_TIERS.flex.lockDays).toBe(0);
    expect(STAKE_TIERS.m3.lockDays).toBe(90);
    expect(STAKE_TIERS.m12.lockDays).toBe(365);
  });

  it('never prices a longer lock below a shorter one', () => {
    const ladder: StakeTier[] = ['flex', 'm3', 'm12'];
    for (let i = 1; i < ladder.length; i++) {
      const lower = STAKE_TIERS[ladder[i - 1] as StakeTier];
      const upper = STAKE_TIERS[ladder[i] as StakeTier];
      expect(upper.multiplierBps).toBeGreaterThan(lower.multiplierBps);
      expect(upper.lockDays).toBeGreaterThan(lower.lockDays);
    }
  });
});

describe('staking — unlock dates', () => {
  const started = new Date('2026-01-15T12:34:56.789Z');
  const DAY = 86_400_000;

  it('has no unlock date for flex', () => {
    expect(unlockDate('flex', started)).toBeNull();
  });

  it('computes the m3 unlock to the millisecond', () => {
    const unlocks = unlockDate('m3', started);
    expect(unlocks?.getTime()).toBe(started.getTime() + 90 * DAY);
    expect(unlocks?.toISOString()).toBe('2026-04-15T12:34:56.789Z');
  });

  it('computes the m12 unlock to the millisecond', () => {
    const unlocks = unlockDate('m12', started);
    expect(unlocks?.getTime()).toBe(started.getTime() + 365 * DAY);
    expect(unlocks?.toISOString()).toBe('2027-01-15T12:34:56.789Z');
  });

  it('does not let DST or month length move an unlock date', () => {
    const springForward = new Date('2026-03-01T00:00:00.000Z');
    expect(unlockDate('m3', springForward)?.getTime()).toBe(springForward.getTime() + 90 * DAY);
  });

  it('rejects an invalid start date rather than producing an Invalid Date unlock', () => {
    expect(() => unlockDate('m3', new Date('nonsense'))).toThrow(RangeError);
    expect(() => isUnlocked('m3', started, new Date('nonsense'))).toThrow(RangeError);
  });

  it('rejects an unknown tier', () => {
    expect(() => unlockDate('m6' as StakeTier, started)).toThrow(RangeError);
    expect(() => stakeWeight(amt('1'), 'm24' as StakeTier)).toThrow(RangeError);
  });
});

describe('staking — isUnlocked at the boundary instant', () => {
  const started = new Date('2026-01-15T00:00:00.000Z');
  const DAY = 86_400_000;

  it('treats flex as always unlocked, even before it started', () => {
    expect(isUnlocked('flex', started, new Date(started.getTime() - 1))).toBe(true);
    expect(isUnlocked('flex', started, started)).toBe(true);
  });

  it('is locked one millisecond before the unlock instant', () => {
    const oneMsEarly = new Date(started.getTime() + 90 * DAY - 1);
    expect(isUnlocked('m3', started, oneMsEarly)).toBe(false);
  });

  it('is unlocked AT the unlock instant — not one millisecond later', () => {
    const exactly = new Date(started.getTime() + 90 * DAY);
    expect(isUnlocked('m3', started, exactly)).toBe(true);
    expect(isUnlocked('m3', started, new Date(exactly.getTime() + 1))).toBe(true);
  });

  it('is locked at its own start instant', () => {
    expect(isUnlocked('m3', started, started)).toBe(false);
    expect(isUnlocked('m12', started, started)).toBe(false);
  });

  it('keeps m12 locked long after m3 released', () => {
    const sixMonths = new Date(started.getTime() + 180 * DAY);
    expect(isUnlocked('m3', started, sixMonths)).toBe(true);
    expect(isUnlocked('m12', started, sixMonths)).toBe(false);
  });
});

describe('staking — stake weight', () => {
  it('leaves flex stake unchanged', () => {
    expect(stakeWeight(amt('1234.5'), 'flex')).toBe(amt('1234.5'));
  });

  it('applies the m3 and m12 multipliers exactly', () => {
    expect(stakeWeight(amt('1000'), 'm3')).toBe(amt('1500'));
    expect(stakeWeight(amt('1000'), 'm12')).toBe(amt('2500'));
  });

  it('floors sub-unit weight rather than inventing a claim on the pool', () => {
    expect(stakeWeight(WEI, 'flex')).toBe(WEI);
    expect(stakeWeight(WEI, 'm3')).toBe(WEI);
    expect(stakeWeight(WEI, 'm12')).toBe(2n);
    expect(stakeWeight(3n, 'm3')).toBe(4n);
  });

  it('weighs zero as zero and rejects a negative stake', () => {
    expect(stakeWeight(ZERO, 'm12')).toBe(ZERO);
    expect(() => stakeWeight(-1n, 'flex')).toThrow(RangeError);
  });

  it('orders weight by tier for an identical stake', () => {
    const stake = amt('777.777777777777777777');
    expect(stakeWeight(stake, 'm12') > stakeWeight(stake, 'm3')).toBe(true);
    expect(stakeWeight(stake, 'm3') > stakeWeight(stake, 'flex')).toBe(true);
  });
});

describe('staking — access tiers (§4.3 gates)', () => {
  it('lists tiers in ascending threshold order', () => {
    for (let i = 1; i < ACCESS_TIERS.length; i++) {
      expect((ACCESS_TIERS[i]?.minStake ?? ZERO) > (ACCESS_TIERS[i - 1]?.minStake ?? ZERO)).toBe(true);
    }
  });

  it('starts at a zero threshold so no user resolves to null', () => {
    expect(ACCESS_TIERS[0]?.minStake).toBe(ZERO);
    expect(accessTierFor(ZERO).name).toBe('Base');
  });

  it('grants a tier at its exact threshold', () => {
    for (const tier of ACCESS_TIERS) {
      expect(accessTierFor(tier.minStake).name).toBe(tier.name);
    }
  });

  it('withholds a tier one wei below its threshold', () => {
    for (let i = 1; i < ACCESS_TIERS.length; i++) {
      const tier = ACCESS_TIERS[i];
      if (!tier) continue;
      const justBelow = accessTierFor(tier.minStake - WEI);
      expect(justBelow.name).toBe(ACCESS_TIERS[i - 1]?.name);
    }
  });

  it('returns the highest tier for a stake far above every threshold', () => {
    const top = ACCESS_TIERS[ACCESS_TIERS.length - 1];
    expect(accessTierFor(amt('999999999')).name).toBe(top?.name);
  });

  it('never un-grants a perk as stake increases', () => {
    let previous = accessTierFor(ZERO);
    for (const tier of ACCESS_TIERS) {
      const current = accessTierFor(tier.minStake);
      expect(current.launchpadAllocationTier).toBeGreaterThanOrEqual(previous.launchpadAllocationTier);
      expect(current.vendorSlots).toBeGreaterThanOrEqual(previous.vendorSlots);
      expect(Number(current.otcAccess)).toBeGreaterThanOrEqual(Number(previous.otcAccess));
      expect(Number(current.premiumLobbies)).toBeGreaterThanOrEqual(Number(previous.premiumLobbies));
      previous = current;
    }
  });

  it('gates OTC and premium lobbies behind a real stake', () => {
    expect(accessTierFor(ZERO).otcAccess).toBe(false);
    expect(accessTierFor(amt('999')).otcAccess).toBe(false);
    expect(accessTierFor(amt('10000')).otcAccess).toBe(true);
    expect(accessTierFor(amt('10000')).premiumLobbies).toBe(true);
  });

  it('rejects a negative stake', () => {
    expect(() => accessTierFor(-WEI)).toThrow(RangeError);
  });
});

/**
 * THE SCHEDULE, WRITTEN OUT.
 *
 * Hardcoded on purpose. The previous version of these tests asserted
 * `feeDiscountBps(step.minStake) === step.discountBps` by reading the expectation back out of
 * the same array it was testing, so it passed for ANY set of numbers — and it did, while the
 * TS table used to be copied out of itself, so any numbers passed. An expectation that is
 * derived from the thing under test cannot fail, and a test that cannot fail is not a test.
 *
 * Change a number in `staking.ts` and this table must be changed to match, deliberately, by
 * hand. That friction is the feature.
 */
const PUBLISHED_FEE_DISCOUNTS: ReadonlyArray<readonly [minStake: string, discountBps: number]> = [
  ['0', 0],
  ['1000', 1_000],
  ['10000', 2_000],
  ['100000', 3_500],
  ['1000000', 5_000],
];

/** The seed, named for what it is at every call site below. It is never the authority. */
const SEED = DEFAULT_FEE_DISCOUNT_SCHEDULE;

describe('staking — fee discount schedule', () => {
  it('gives no discount to an unstaked user', () => {
    expect(feeDiscountBps(ZERO, SEED)).toBe(0);
    expect(feeDiscountBps(WEI, SEED)).toBe(0);
  });

  it('publishes exactly the steps written down here — nothing added, nothing re-tuned quietly', () => {
    expect(SEED.basis).toBe('staked');
    expect(SEED.tiers.map((s) => [formatAmount(s.minStake), s.discountBps])).toEqual(
      PUBLISHED_FEE_DISCOUNTS.map(([minStake, bps]) => [minStake, bps]),
    );
  });

  it('applies each published step at its exact threshold', () => {
    for (const [minStake, expected] of PUBLISHED_FEE_DISCOUNTS) {
      expect(feeDiscountBps(amt(minStake), SEED)).toBe(expected);
    }
  });

  it('withholds a step one wei below its threshold', () => {
    for (let i = 1; i < PUBLISHED_FEE_DISCOUNTS.length; i++) {
      const [minStake] = PUBLISHED_FEE_DISCOUNTS[i]!;
      const [, belowBps] = PUBLISHED_FEE_DISCOUNTS[i - 1]!;
      expect(feeDiscountBps(amt(minStake) - WEI, SEED)).toBe(belowBps);
    }
  });

  it('reads the schedule it is handed, not the compiled-in seed', () => {
    // The whole point of the fix: `token_params` is the authority, so a caller passing a
    // loaded row must get that row's numbers even where they contradict the seed.
    const governed: FeeDiscountSchedule = {
      basis: 'staked',
      tiers: [
        { minStake: amt('0'), discountBps: 0 },
        { minStake: amt('1000'), discountBps: 4_200 },
      ],
    };
    expect(feeDiscountBps(amt('1000'), governed)).toBe(4_200);
    expect(feeDiscountBps(amt('1000000'), governed)).toBe(4_200);
    // …and the seed is untouched by having passed one.
    expect(feeDiscountBps(amt('1000'), SEED)).toBe(1_000);
  });

  it('is monotonically non-decreasing in stake', () => {
    let previous = feeDiscountBps(ZERO, SEED);
    let stake = WEI;
    for (let i = 0; i < 400; i++) {
      const discount = feeDiscountBps(stake, SEED);
      expect(discount).toBeGreaterThanOrEqual(previous);
      previous = discount;
      stake = stake * 3n + 7n;
    }
  });

  it('NEVER reaches 10000 bps — a 100% discount means the house pays the user to trade', () => {
    const probes: Amount[] = [ZERO, WEI, amt('1'), amt('999.999999999999999999'), amt('1000'), amt('1000000'), amt('10000000000000')];
    for (const stake of probes) {
      expect(feeDiscountBps(stake, SEED)).toBeLessThan(10_000);
      expect(feeDiscountBps(stake, SEED)).toBeLessThanOrEqual(MAX_FEE_DISCOUNT_BPS);
    }
    expect(MAX_FEE_DISCOUNT_BPS).toBeLessThan(10_000);
  });

  it('caps an absurd stake at the policy ceiling', () => {
    // The largest stake numeric(38,18) can store. 10^20 whole tokens is one digit past that column.
    const stake = amt(formatAmount(MAX_AMOUNT));
    expect(feeDiscountBps(stake, SEED)).toBeLessThan(10_000);
    expect(feeDiscountBps(stake, SEED)).toBeLessThanOrEqual(MAX_FEE_DISCOUNT_BPS);
  });

  it('refuses a stake that does not fit the amount column', () => {
    expect(() => amt('100000000000000000000')).toThrow(MoneyError);
    expect(() => amt('100000000000000000000')).toThrow(/numeric\(38,18\)/);
  });

  it('rejects a negative stake', () => {
    expect(() => feeDiscountBps(-WEI, SEED)).toThrow(RangeError);
  });
});

describe('fee discount schedule — parsing a governed row (§4.3)', () => {
  const ok = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };

  it('parses thresholds into scaled bigints, never numbers', () => {
    const parsed = parseFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: '1000.5', discountBps: 250 }, ...ok.tiers] });
    const step = parsed.tiers[0]!;
    expect(typeof step.minStake).toBe('bigint');
    expect(step.minStake).toBe(amt('1000.5'));
  });

  it('refuses a basis this code does not implement rather than mis-applying it', () => {
    // §4.3 says the discount keys on BALANCE; this code keys on STAKE. Loading a
    // balance-keyed ladder into stake-keyed maths would hand out a wrong discount silently.
    expect(() => parseFeeDiscountSchedule({ ...ok, basis: 'balance' })).toThrow(/not implemented/);
    expect(() => parseFeeDiscountSchedule({ ...ok, basis: undefined })).toThrow(RangeError);
  });

  it('refuses a threshold written as a JSON number', () => {
    expect(() => parseFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: 1000, discountBps: 0 }] })).toThrow(/decimal string/);
  });

  it('refuses a discount above the policy ceiling instead of clamping it', () => {
    // A clamp would let a row reading 9000 behave as 5000 forever, with nothing to audit.
    expect(() =>
      parseFeeDiscountSchedule({ basis: 'staked', tiers: [...ok.tiers, { minStake: '1', discountBps: MAX_FEE_DISCOUNT_BPS + 1 }] }),
    ).toThrow(/policy ceiling/);
    expect(
      parseFeeDiscountSchedule({ basis: 'staked', tiers: [...ok.tiers, { minStake: '1', discountBps: MAX_FEE_DISCOUNT_BPS }] }).tiers,
    ).toHaveLength(2);
  });

  it('refuses a schedule with no zero-threshold base step', () => {
    expect(() => parseFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: '1000', discountBps: 100 }] })).toThrow(/minStake "0"/);
  });

  it('refuses negative thresholds, fractional bps, and empty or non-object rows', () => {
    expect(() => parseFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: '-1', discountBps: 0 }] })).toThrow(RangeError);
    expect(() => parseFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: '0', discountBps: 1.5 }] })).toThrow(RangeError);
    expect(() => parseFeeDiscountSchedule({ basis: 'staked', tiers: [] })).toThrow(RangeError);
    expect(() => parseFeeDiscountSchedule([])).toThrow(RangeError);
    expect(() => parseFeeDiscountSchedule(null)).toThrow(RangeError);
  });

  it('cannot produce a discount that falls as stake rises, even from an unsorted row', () => {
    const unsorted = parseFeeDiscountSchedule({
      basis: 'staked',
      tiers: [
        { minStake: '1000000', discountBps: 5_000 },
        { minStake: '0', discountBps: 0 },
        { minStake: '1000', discountBps: 1_000 },
      ],
    });
    let previous = 0;
    let stake = ZERO;
    for (let i = 0; i < 200; i++) {
      const discount = feeDiscountBps(stake, unsorted);
      expect(discount).toBeGreaterThanOrEqual(previous);
      previous = discount;
      stake = stake * 3n + 7n;
    }
  });
});

/** Values chosen to break naive rounding: 1 wei, primes, odd tails, and values one below a clean split. */
const ADVERSARIAL_AMOUNTS: Amount[] = [
  ZERO,
  WEI,
  2n,
  3n,
  7n,
  9_999n,
  10_000n,
  10_001n,
  amt('0.000000000000000007'),
  amt('0.5'),
  amt('1'),
  amt('1.000000000000000001'),
  amt('3.333333333333333333'),
  amt('7.7'),
  amt('99.999999999999999999'),
  amt('123456.789'),
  amt('1000000'),
  amt('999999999.999999999999999999'),
  1_000_000_000_000_000_000_000_001n,
  2n ** 90n - 1n,
];

describe('buyback — budget', () => {
  it('takes the published share of revenue', () => {
    expect(buybackBudget(amt('1000'), { buybackBps: 5_000, burnSplitBps: 6_000 })).toBe(amt('500'));
    expect(buybackBudget(amt('1000'), DEFAULT_BUYBACK_PARAMS)).toBe(amt('500'));
  });

  it('spends nothing at 0 bps and everything at 10000 bps', () => {
    expect(buybackBudget(amt('1234.5'), { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 0 })).toBe(ZERO);
    expect(buybackBudget(amt('1234.5'), { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 10_000 })).toBe(amt('1234.5'));
  });

  it('floors — it never spends a unit the window did not earn', () => {
    expect(buybackBudget(WEI, { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 5_000 })).toBe(ZERO);
    expect(buybackBudget(3n, { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 5_000 })).toBe(1n);
    expect(buybackBudget(9_999n, { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 1 })).toBe(ZERO);
  });

  it('never budgets more than the revenue it was given', () => {
    for (const revenue of ADVERSARIAL_AMOUNTS) {
      for (const bps of [0, 1, 4_999, 5_000, 9_999, 10_000]) {
        const budget = buybackBudget(revenue, { ...DEFAULT_BUYBACK_PARAMS, buybackBps: bps });
        expect(budget >= ZERO).toBe(true);
        expect(budget <= revenue).toBe(true);
      }
    }
  });

  it('rejects negative revenue and out-of-range bps', () => {
    expect(() => buybackBudget(-WEI)).toThrow(RangeError);
    expect(() => buybackBudget(amt('1'), { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 10_001 })).toThrow(RangeError);
    expect(() => buybackBudget(amt('1'), { ...DEFAULT_BUYBACK_PARAMS, buybackBps: -1 })).toThrow(RangeError);
    expect(() => buybackBudget(amt('1'), { ...DEFAULT_BUYBACK_PARAMS, buybackBps: 50.5 })).toThrow(RangeError);
  });
});

describe('buyback — IOC size from real asks', () => {
  it('empty book is zero — never invents a mid', () => {
    expect(sizeIocBuyFromAsks([], amt('100'))).toBe(ZERO);
  });

  it('walks asks until the quote budget is spent, flooring the last take', () => {
    const qty = sizeIocBuyFromAsks(
      [
        { price: amt('2'), qty: amt('10') },
        { price: amt('4'), qty: amt('10') },
      ],
      amt('24'),
    );
    // 10 @ 2 = 20 spent, 4 remaining → floor(4/4) = 1
    expect(qty).toBe(amt('11'));
  });

  it('budget of one wei below the first ask is zero, not a guessed partial', () => {
    expect(sizeIocBuyFromAsks([{ price: amt('10'), qty: amt('1') }], WEI)).toBe(ZERO);
  });
});

describe('buyback — split to burn and rewards', () => {
  it('splits the default 60/40', () => {
    const split = splitBuyback(amt('1000'), DEFAULT_BUYBACK_PARAMS);
    expect(split.toBurn).toBe(amt('600'));
    expect(split.toRewards).toBe(amt('400'));
  });

  it('sums back to exactly the tokens bought — every value, every split', () => {
    const splits = [0, 1, 2_500, 3_333, 5_000, 6_000, 6_667, 9_999, 10_000];
    let checked = 0;

    for (const tokensBought of ADVERSARIAL_AMOUNTS) {
      for (const burnSplitBps of splits) {
        const { toBurn, toRewards } = splitBuyback(tokensBought, { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps });
        expect(toBurn + toRewards).toBe(tokensBought);
        expect(toBurn >= ZERO).toBe(true);
        expect(toRewards >= ZERO).toBe(true);
        checked++;
      }
    }

    expect(checked).toBe(ADVERSARIAL_AMOUNTS.length * splits.length);
  });

  it('sums exactly across a dense sweep where naive double-rounding would drift', () => {
    for (let i = 0n; i < 500n; i++) {
      const tokensBought = i * 7n + 1n;
      for (const burnSplitBps of [1, 3_333, 6_000, 9_999]) {
        const { toBurn, toRewards } = splitBuyback(tokensBought, { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps });
        expect(toBurn + toRewards).toBe(tokensBought);
      }
    }
  });

  it('sends the unsplittable wei to rewards, never to the burn address', () => {
    // 1 wei at a 60% burn is 0.6 wei — floor means the residual stays recoverable.
    const split = splitBuyback(WEI, { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps: 6_000 });
    expect(split.toBurn).toBe(ZERO);
    expect(split.toRewards).toBe(WEI);

    // Even a 99.99% burn cannot round a single wei into an irreversible destination.
    const nearlyAllBurn = splitBuyback(WEI, { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps: 9_999 });
    expect(nearlyAllBurn.toBurn).toBe(ZERO);
    expect(nearlyAllBurn.toRewards).toBe(WEI);
  });

  it('burns everything at 10000 bps and nothing at 0 bps', () => {
    const all = splitBuyback(amt('12345.678'), { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps: 10_000 });
    expect(all.toBurn).toBe(amt('12345.678'));
    expect(all.toRewards).toBe(ZERO);

    const none = splitBuyback(amt('12345.678'), { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps: 0 });
    expect(none.toBurn).toBe(ZERO);
    expect(none.toRewards).toBe(amt('12345.678'));
  });

  it('splits zero into zero', () => {
    const split = splitBuyback(ZERO);
    expect(split.toBurn).toBe(ZERO);
    expect(split.toRewards).toBe(ZERO);
  });

  it('rejects negative tokens and a burn split above 100%', () => {
    expect(() => splitBuyback(-WEI)).toThrow(RangeError);
    expect(() => splitBuyback(amt('1'), { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps: 10_001 })).toThrow(RangeError);
    expect(() => splitBuyback(amt('1'), { ...DEFAULT_BUYBACK_PARAMS, burnSplitBps: -1 })).toThrow(RangeError);
  });

  it('keeps the default parameters inside their legal range', () => {
    expect(DEFAULT_BUYBACK_PARAMS.buybackBps).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_BUYBACK_PARAMS.buybackBps).toBeLessThanOrEqual(10_000);
    expect(DEFAULT_BUYBACK_PARAMS.burnSplitBps).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_BUYBACK_PARAMS.burnSplitBps).toBeLessThanOrEqual(10_000);
  });
});

describe('buyback — real-yield distribution (§4.3)', () => {
  const tiers: StakeTier[] = ['flex', 'm3', 'm12'];

  it('distributes nothing when there are no stakes — the caller keeps the yield', () => {
    expect(distributeYield(amt('1000'), [])).toEqual([]);
  });

  it('distributes nothing when every stake is zero, rather than dividing by zero weight', () => {
    const stakes = [
      { userId: 'a', amount: ZERO, tier: 'flex' as StakeTier },
      { userId: 'b', amount: ZERO, tier: 'm12' as StakeTier },
    ];
    expect(distributeYield(amt('1000'), stakes)).toEqual([]);
  });

  it('gives a sole staker everything, down to the last wei', () => {
    const shares = distributeYield(amt('1234.567890123456789'), [{ userId: 'solo', amount: amt('1'), tier: 'flex' }]);
    expect(shares).toHaveLength(1);
    expect(shares[0]?.userId).toBe('solo');
    expect(shares[0]?.share).toBe(amt('1234.567890123456789'));
  });

  it('splits evenly between two identical stakers', () => {
    const shares = distributeYield(amt('100'), [
      { userId: 'a', amount: amt('50'), tier: 'm3' },
      { userId: 'b', amount: amt('50'), tier: 'm3' },
    ]);
    expect(shares[0]?.share).toBe(amt('50'));
    expect(shares[1]?.share).toBe(amt('50'));
  });

  it('gives an odd wei to exactly one of two identical stakers, not to both and not to neither', () => {
    const shares = distributeYield(3n, [
      { userId: 'a', amount: amt('50'), tier: 'flex' },
      { userId: 'b', amount: amt('50'), tier: 'flex' },
    ]);
    expect(sum(shares.map((s) => s.share))).toBe(3n);
    expect([shares[0]?.share, shares[1]?.share].sort()).toEqual([1n, 2n]);
  });

  it('weights by tier multiplier, not by raw stake', () => {
    const shares = distributeYield(amt('350'), [
      { userId: 'flexer', amount: amt('100'), tier: 'flex' },
      { userId: 'locker', amount: amt('100'), tier: 'm12' },
    ]);
    // 1.0x vs 2.5x on equal principal → 100 / 250 of a 350 pool.
    expect(shares[0]?.share).toBe(amt('100'));
    expect(shares[1]?.share).toBe(amt('250'));
  });

  it('sums to exactly the total across 1000 uneven stakers', () => {
    const total = amt('987654.321987654321987654');
    const stakes = Array.from({ length: 1000 }, (_, i) => ({
      userId: `u${i}`,
      amount: BigInt(i + 1) * 1_000_000_007n + BigInt(i * i),
      tier: tiers[i % 3] as StakeTier,
    }));

    const shares = distributeYield(total, stakes);
    expect(shares).toHaveLength(1000);
    expect(sum(shares.map((s) => s.share))).toBe(total);
    expect(shares.every((s) => s.share >= ZERO)).toBe(true);
  });

  it('sums exactly when the total is smaller than the number of stakers', () => {
    const stakes = Array.from({ length: 100 }, (_, i) => ({
      userId: `u${i}`,
      amount: BigInt(i + 1) * amt('1'),
      tier: tiers[i % 3] as StakeTier,
    }));

    const shares = distributeYield(7n, stakes);
    expect(sum(shares.map((s) => s.share))).toBe(7n);
    expect(shares.filter((s) => s.share > ZERO)).toHaveLength(7);
  });

  it('sums exactly for a lone wei of dust across two stakers', () => {
    const shares = distributeYield(WEI, [
      { userId: 'a', amount: amt('1'), tier: 'flex' },
      { userId: 'b', amount: amt('1'), tier: 'flex' },
    ]);
    expect(sum(shares.map((s) => s.share))).toBe(WEI);
  });

  it('sums exactly across a sweep of totals and staker counts', () => {
    for (const stakerCount of [1, 2, 3, 7, 13, 64]) {
      const stakes = Array.from({ length: stakerCount }, (_, i) => ({
        userId: `u${i}`,
        amount: BigInt(i * 31 + 1),
        tier: tiers[i % 3] as StakeTier,
      }));

      for (const total of [ZERO, WEI, 2n, 99n, amt('0.000000000000012345'), amt('1'), amt('123456.789')]) {
        const shares = distributeYield(total, stakes);
        expect(sum(shares.map((s) => s.share))).toBe(total);
      }
    }
  });

  it('keeps stakes positional, so one user with two stakes receives two shares', () => {
    const shares = distributeYield(amt('350'), [
      { userId: 'same', amount: amt('100'), tier: 'flex' },
      { userId: 'same', amount: amt('100'), tier: 'm12' },
    ]);
    expect(shares.map((s) => s.userId)).toEqual(['same', 'same']);
    expect(sum(shares.map((s) => s.share))).toBe(amt('350'));
  });

  it('ignores a zero stake among real ones without stranding its share', () => {
    const shares = distributeYield(amt('100'), [
      { userId: 'zero', amount: ZERO, tier: 'm12' },
      { userId: 'real', amount: amt('10'), tier: 'flex' },
    ]);
    expect(shares[0]?.share).toBe(ZERO);
    expect(shares[1]?.share).toBe(amt('100'));
  });

  it('rejects negative yield and a negative stake', () => {
    expect(() => distributeYield(-WEI, [{ userId: 'a', amount: amt('1'), tier: 'flex' }])).toThrow(RangeError);
    expect(() => distributeYield(amt('1'), [{ userId: 'a', amount: -amt('1'), tier: 'flex' }])).toThrow(RangeError);
  });
});

describe('end to end — a revenue window through the flywheel', () => {
  it('moves every unit of a window from revenue to burn, rewards, and stakers with nothing stranded', () => {
    const revenue = amt('84213.550000000000000007');
    const budget = buybackBudget(revenue, DEFAULT_BUYBACK_PARAMS);
    expect(budget <= revenue).toBe(true);

    // The market-buy is not this module's business; assume an awkward fill price.
    const tokensBought = (budget * 10_000n) / 6_133n;
    const { toBurn, toRewards } = splitBuyback(tokensBought, DEFAULT_BUYBACK_PARAMS);
    expect(toBurn + toRewards).toBe(tokensBought);

    const stakes = Array.from({ length: 37 }, (_, i) => ({
      userId: `u${i}`,
      amount: BigInt(i + 1) * amt('137.5'),
      tier: (['flex', 'm3', 'm12'] as StakeTier[])[i % 3] as StakeTier,
    }));

    const shares = distributeYield(toRewards, stakes);
    expect(sum(shares.map((s) => s.share))).toBe(toRewards);
    expect(sum(shares.map((s) => s.share)) + toBurn).toBe(tokensBought);
  });
});

describe('fee discount schedule — what the owner may publish', () => {
  const ladder = {
    basis: 'staked',
    tiers: [
      { minStake: '0', discountBps: 0 },
      { minStake: '1000.50', discountBps: 1_000 },
      { minStake: '10000', discountBps: 2_500 },
    ],
  };

  it('stores a rising ladder with canonical decimal thresholds', () => {
    expect(publishableFeeDiscountSchedule(ladder)).toEqual({
      basis: 'staked',
      tiers: [
        { minStake: '0', discountBps: 0 },
        { minStake: '1000.5', discountBps: 1_000 },
        { minStake: '10000', discountBps: 2_500 },
      ],
    });
  });

  it('refuses a ladder the read path would charge differently from how it reads', () => {
    const [zero, mid, top] = ladder.tiers;
    // Unsorted: the read takes the best matching step, so the row would not read the way it charges.
    expect(() => publishableFeeDiscountSchedule({ basis: 'staked', tiers: [zero, top, mid] })).toThrow(/above the step before it/);
    expect(() => publishableFeeDiscountSchedule({ basis: 'staked', tiers: [top, zero] })).toThrow(/tiers\[0\]\.minStake must be "0"/);
    expect(() => publishableFeeDiscountSchedule({ basis: 'staked', tiers: [zero, mid, { ...mid }] })).toThrow(/above the step before it/);
    expect(() =>
      publishableFeeDiscountSchedule({ basis: 'staked', tiers: [zero, { ...mid, discountBps: 3_000 }, { ...top, discountBps: 2_000 }] }),
    ).toThrow(/must not be below the step before it/);
  });

  it('keeps every rule of the read parser: basis, ceiling, decimal strings, a zero step', () => {
    expect(() => publishableFeeDiscountSchedule({ ...ladder, basis: 'balance' })).toThrow(/not implemented/);
    expect(() =>
      publishableFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: '0', discountBps: MAX_FEE_DISCOUNT_BPS + 1 }] }),
    ).toThrow(/policy ceiling/);
    expect(() => publishableFeeDiscountSchedule({ basis: 'staked', tiers: [{ minStake: 0, discountBps: 0 }] })).toThrow(/decimal string/);
    expect(() => publishableFeeDiscountSchedule({ basis: 'staked', tiers: [] })).toThrow(/non-empty/);
  });

  it('versions the stored row the same whatever order its keys come back in', () => {
    const stored = publishableFeeDiscountSchedule(ladder);
    const reordered = JSON.parse(
      '{"tiers":[{"discountBps":0,"minStake":"0"},{"discountBps":1000,"minStake":"1000.5"},{"discountBps":2500,"minStake":"10000"}],"basis":"staked"}',
    );
    expect(feeDiscountScheduleVersion(stored)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(feeDiscountScheduleVersion(reordered)).toBe(feeDiscountScheduleVersion(stored));
    expect(feeDiscountScheduleVersion({ ...stored, tiers: stored.tiers.slice(0, 2) })).not.toBe(feeDiscountScheduleVersion(stored));
    expect(feeDiscountScheduleVersion(null)).toBe('unset');
  });

  it('binds the approval to the ladder as typed, not to a reordering of its keys', () => {
    const typed = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };
    const sameKeysOtherOrder = { tiers: [{ discountBps: 0, minStake: '0' }], basis: 'staked' };
    expect(feeDiscountSchedulePayload(sameKeysOtherOrder)).toBe(feeDiscountSchedulePayload(typed));
    expect(feeDiscountSchedulePayload(typed)).toBe('{"basis":"staked","tiers":[{"discountBps":0,"minStake":"0"}]}');
    expect(feeDiscountSchedulePayload({ basis: 'staked', tiers: [{ minStake: '0.0', discountBps: 0 }] })).not.toBe(
      feeDiscountSchedulePayload(typed),
    );
  });
});
