/**
 * Staking — lock tiers, stake weight, access gates, fee discounts.
 *
 * §4.3 stakes: `(id, user_id, amount, tier enum[flex,m3,m12], multiplier, started_at,
 * unlocks_at, status)`. This module is the arithmetic behind those columns — the row is
 * written by the service, the numbers in it come from here.
 *
 * Every multiplier and discount is basis points (10000 = 1.0x). A multiplier is a rate
 * applied to money, and a rate stored as a float is a rate that disagrees with itself
 * across two machines. There is no float anywhere in this file.
 *
 * Two consumers, §4.3: other services call `token.stakeOf(userId)` to "gate launchpad
 * allocations, OTC access, premium lobbies, vendor slots" (`accessTierFor`), and the
 * `feeCharge` recipe checks the "published decay schedule" (`feeDiscountBps`).
 *
 * The access ladder is code; the fee-discount ladder is NOT. §4.3 puts the latter in
 * `token_params.fee_discount_schedule`. The migration leaves that column blank.
 * `DEFAULT_FEE_DISCOUNT_SCHEDULE` is a pure-test fixture, not a live fee.
 */

import { createHash } from 'node:crypto';
import { type Amount, ZERO, formatAmount, mulBps, parseAmount } from '@intafaced/ledger-client';

export type StakeTier = 'flex' | 'm3' | 'm12';

export interface StakeTierSpec {
  /** 0 means withdrawable at any moment. */
  readonly lockDays: number;
  readonly multiplierBps: number;
  readonly label: string;
}

/**
 * The multiplier prices illiquidity, nothing else. Flex earns 1.0x because it takes no
 * duration risk and can exit the moment yield disappoints; m12 earns 2.5x because that
 * stake is committed through a full market cycle. The ladder must stay strictly increasing —
 * a flat step means the longer lock is strictly worse and nobody takes it.
 *
 * 365 rather than 360 days for m12: users read "12 months" as a year, and a lock that
 * releases five days late is a support ticket every time.
 */
export const STAKE_TIERS: Readonly<Record<StakeTier, StakeTierSpec>> = {
  flex: { lockDays: 0, multiplierBps: 10_000, label: 'Flexible' },
  m3: { lockDays: 90, multiplierBps: 15_000, label: '3-Month Lock' },
  m12: { lockDays: 365, multiplierBps: 25_000, label: '12-Month Lock' },
};

const MS_PER_DAY = 86_400_000;

function specFor(tier: StakeTier): StakeTierSpec {
  const spec = STAKE_TIERS[tier];
  if (!spec) throw new RangeError(`Unknown stake tier "${tier}"`);
  return spec;
}

function assertValidDate(date: Date, label: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid Date`);
}

/**
 * When a lock releases, or null for flex — flex has no unlock date, and `stakes.unlocks_at`
 * is nullable for exactly that reason.
 *
 * A day is a fixed 86_400_000ms, deliberately. Calendar-month arithmetic would make a lock
 * started on 31 January release on a date that depends on the leap year, and DST would make
 * two locks of the same tier differ by an hour.
 */
export function unlockDate(tier: StakeTier, startedAt: Date): Date | null {
  const spec = specFor(tier);
  assertValidDate(startedAt, 'startedAt');
  if (spec.lockDays === 0) return null;
  return new Date(startedAt.getTime() + spec.lockDays * MS_PER_DAY);
}

/** Boundary-inclusive: at the exact unlock instant the stake is free. We do not hold funds one extra millisecond. */
export function isUnlocked(tier: StakeTier, startedAt: Date, now: Date): boolean {
  const unlocksAt = unlockDate(tier, startedAt);
  assertValidDate(now, 'now');
  if (unlocksAt === null) return true;
  return now.getTime() >= unlocksAt.getTime();
}

/**
 * Stake scaled by its tier multiplier — the weight used for real-yield distribution (§4.3)
 * and governance vote weight.
 *
 * Rounds `floor`: weight converts directly into a claim on the yield pool, so rounding up
 * would hand a fraction of someone else's share to whoever staked an awkward number.
 */
export function stakeWeight(amount: Amount, tier: StakeTier): Amount {
  const spec = specFor(tier);
  if (amount < ZERO) throw new RangeError('Stake amount must not be negative');
  return mulBps(amount, spec.multiplierBps, 'floor');
}

export interface AccessTier {
  readonly name: string;
  readonly minStake: Amount;
  /** 0 = no launchpad allocation; higher tiers get earlier windows and larger caps. */
  readonly launchpadAllocationTier: number;
  readonly otcAccess: boolean;
  readonly premiumLobbies: boolean;
  /** Concurrent marketplace vendor listings this tier may hold open. */
  readonly vendorSlots: number;
}

/**
 * Ordered ascending by `minStake`; `accessTierFor` depends on that order. The first entry
 * has `minStake: 0` so every user — including one who has never staked — resolves to a real
 * tier and no caller ever has to handle a null.
 *
 * OTC opens at Operator because §5.2 puts OTC behind a staked-tier gate and OTC fills post
 * directly to the ledger with spread to house; it is not a surface to open to a drive-by.
 */
export const ACCESS_TIERS: readonly AccessTier[] = [
  { name: 'Base', minStake: parseAmount('0'), launchpadAllocationTier: 0, otcAccess: false, premiumLobbies: false, vendorSlots: 0 },
  { name: 'Initiate', minStake: parseAmount('1000'), launchpadAllocationTier: 1, otcAccess: false, premiumLobbies: false, vendorSlots: 1 },
  { name: 'Operator', minStake: parseAmount('10000'), launchpadAllocationTier: 2, otcAccess: true, premiumLobbies: true, vendorSlots: 3 },
  {
    name: 'Architect',
    minStake: parseAmount('100000'),
    launchpadAllocationTier: 3,
    otcAccess: true,
    premiumLobbies: true,
    vendorSlots: 10,
  },
  {
    name: 'Sovereign',
    minStake: parseAmount('1000000'),
    launchpadAllocationTier: 4,
    otcAccess: true,
    premiumLobbies: true,
    vendorSlots: 50,
  },
];

/** Highest tier whose threshold the stake meets. Thresholds are inclusive — staking exactly 1,000 IFC is Initiate. */
export function accessTierFor(stakedAmount: Amount): AccessTier {
  if (stakedAmount < ZERO) throw new RangeError('Staked amount must not be negative');

  for (let i = ACCESS_TIERS.length - 1; i >= 0; i--) {
    const tier = ACCESS_TIERS[i];
    if (tier && stakedAmount >= tier.minStake) return tier;
  }
  // Unreachable while the first entry's threshold is 0; kept so a bad edit fails loudly.
  throw new RangeError('ACCESS_TIERS has no zero-threshold base tier');
}

export interface FeeDiscountStep {
  readonly minStake: Amount;
  readonly discountBps: number;
}

/**
 * Which quantity the ladder is keyed on.
 *
 * KNOWN DIVERGENCE, deliberately not resolved here: §4.3 says the discount keys on the
 * payer's IFC *balance*; this module and the seeded row both key on *staked* amount, which is
 * a different number for the same user. Picking one re-prices every discount in the economy,
 * so it is a governance decision and not a refactor. It is modelled as data so the
 * disagreement is visible rather than implicit, and the parser refuses a basis this code does
 * not implement instead of quietly applying a balance ladder to a stake.
 */
export type FeeDiscountBasis = 'staked' | 'balance';

/** `token_params.fee_discount_schedule` (§4.3), parsed. Same shape as the jsonb column. */
export interface FeeDiscountSchedule {
  readonly basis: FeeDiscountBasis;
  readonly tiers: readonly FeeDiscountStep[];
}

/**
 * §4.3: "`feeCharge` recipe checks payer's IFC balance + published decay schedule → discount
 * applied". Published means `token_params.fee_discount_schedule` — a governed row
 * (`proposal_kind = 'fee_param'`), which is the entire reason §4.3 makes it a jsonb column
 * and not a constant.
 *
 * It is not the authority and must not be read as one. A constant cannot be changed by
 * governance without a redeploy, so a service that answered from here would charge a discount
 * the database does not hold. `feeDiscountBps` therefore takes the schedule as a REQUIRED
 * argument — there is no default, because a default is how a request path ends up reading this
 * array by accident. The migration does not insert this table. A blank column refuses.
 */
export const DEFAULT_FEE_DISCOUNT_SCHEDULE: FeeDiscountSchedule = {
  basis: 'staked',
  tiers: [
    { minStake: parseAmount('0'), discountBps: 0 },
    { minStake: parseAmount('1000'), discountBps: 1_000 },
    { minStake: parseAmount('10000'), discountBps: 2_000 },
    { minStake: parseAmount('100000'), discountBps: 3_500 },
    { minStake: parseAmount('1000000'), discountBps: 5_000 },
  ],
};

/**
 * Policy ceiling on any fee discount.
 *
 * 10000 bps is the arithmetic wall: at a 100% discount the fee is zero, and past it the fee
 * inverts — the house pays the user to trade, and a trading loop becomes a money printer
 * pointed at the fee account. 5000 is the policy ceiling, set well short of the wall so that
 * a governance edit to the schedule can be wrong by a factor of two and still only cost
 * revenue, never principal.
 */
export const MAX_FEE_DISCOUNT_BPS = 5_000;

/**
 * Parse `token_params.fee_discount_schedule` into money-safe values.
 *
 * The column is jsonb, so it is whatever governance last wrote — untrusted input on a money
 * path, and the only place the running schedule is validated. Every rule below rejects rather
 * than repairs: a schedule that is quietly "fixed" at load is a schedule nobody can audit
 * against the row, which is the class of bug this function exists to end.
 *
 * `minStake` arrives as a decimal string and leaves as a scaled bigint via `parseAmount` —
 * a threshold is money, and money is never a `number` (doctrine, `money.ts`). A JSON number
 * is rejected outright because `1000000000000000000000` does not survive a JSON parse intact.
 */
export function parseFeeDiscountSchedule(raw: unknown): FeeDiscountSchedule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RangeError('fee_discount_schedule must be a JSON object of { basis, tiers }');
  }

  const { basis, tiers } = raw as { basis?: unknown; tiers?: unknown };

  // Only the staked basis is implemented. See FeeDiscountBasis: §4.3 says balance, the code
  // says stake, and loading a balance-keyed ladder into stake-keyed maths would silently
  // hand out the wrong discount rather than fail.
  if (basis !== 'staked') {
    throw new RangeError(`fee_discount_schedule basis "${String(basis)}" is not implemented — only "staked" is (§4.3 divergence)`);
  }
  if (!Array.isArray(tiers) || tiers.length === 0) throw new RangeError('fee_discount_schedule.tiers must be a non-empty array');

  const parsed: FeeDiscountStep[] = tiers.map((tier, i) => {
    if (typeof tier !== 'object' || tier === null) throw new RangeError(`fee_discount_schedule.tiers[${i}] must be an object`);
    const { minStake, discountBps } = tier as { minStake?: unknown; discountBps?: unknown };

    if (typeof minStake !== 'string') {
      throw new RangeError(`fee_discount_schedule.tiers[${i}].minStake must be a decimal string, not a JSON number`);
    }
    const threshold = parseAmount(minStake);
    if (threshold < ZERO) throw new RangeError(`fee_discount_schedule.tiers[${i}].minStake must not be negative`);

    if (typeof discountBps !== 'number' || !Number.isInteger(discountBps) || discountBps < 0) {
      throw new RangeError(`fee_discount_schedule.tiers[${i}].discountBps must be a non-negative integer`);
    }
    // Rejected, not clamped. A clamp would let a row that says 9000 behave as 5000 forever
    // while reading as 9000 to whoever audits the table.
    if (discountBps > MAX_FEE_DISCOUNT_BPS) {
      throw new RangeError(
        `fee_discount_schedule.tiers[${i}].discountBps ${discountBps} exceeds the policy ceiling ${MAX_FEE_DISCOUNT_BPS}`,
      );
    }

    return { minStake: threshold, discountBps };
  });

  // Without a zero-threshold step a user who has never staked resolves to nothing, and every
  // caller would have to handle a null discount. Same guarantee ACCESS_TIERS makes.
  if (!parsed.some((step) => step.minStake === ZERO)) {
    throw new RangeError('fee_discount_schedule must contain a step with minStake "0"');
  }

  return { basis, tiers: parsed };
}

/**
 * Fee discount for a stake, in bps off the gross fee. Monotonically non-decreasing in stake,
 * and always < 10000.
 *
 * `schedule` is REQUIRED and is the row loaded from `token_params` (§4.3). It deliberately has
 * no default: the previous signature read a module-level constant, which is how the running
 * discount came to disagree with the database for every non-zero step. Making the caller name
 * its source turns "which schedule answered this?" into something the type checker enforces
 * rather than something an audit has to discover.
 *
 * Takes the maximum matching step rather than the last one, so an unsorted row cannot produce
 * a discount that falls as stake rises.
 */
export function feeDiscountBps(stakedAmount: Amount, schedule: FeeDiscountSchedule): number {
  if (stakedAmount < ZERO) throw new RangeError('Staked amount must not be negative');

  let discount = 0;
  for (const step of schedule.tiers) {
    if (stakedAmount >= step.minStake && step.discountBps > discount) discount = step.discountBps;
  }
  return Math.min(discount, MAX_FEE_DISCOUNT_BPS);
}

/** The fee-decay row as the publish door stores it. */
export interface PublishedFeeDiscountSchedule {
  basis: 'staked';
  tiers: Array<{ minStake: string; discountBps: number }>;
}

/**
 * A ladder the owner may publish: it parses, its thresholds rise strictly from "0", and its discount never falls as
 * the stake rises. The read path takes the best matching step of any parsed ladder; the publish door is stricter, so
 * the stored row reads the way it charges. Returns the row as it is stored: thresholds as canonical decimal strings.
 */
export function publishableFeeDiscountSchedule(raw: unknown): PublishedFeeDiscountSchedule {
  const parsed = parseFeeDiscountSchedule(raw);
  parsed.tiers.forEach((step, i) => {
    const prev = parsed.tiers[i - 1];
    if (i === 0 && step.minStake !== ZERO) throw new RangeError('fee_discount_schedule.tiers[0].minStake must be "0"');
    if (prev && step.minStake <= prev.minStake) {
      throw new RangeError(`fee_discount_schedule.tiers[${i}].minStake must be above the step before it`);
    }
    if (prev && step.discountBps < prev.discountBps) {
      throw new RangeError(`fee_discount_schedule.tiers[${i}].discountBps must not be below the step before it`);
    }
  });
  return { basis: 'staked', tiers: parsed.tiers.map((step) => ({ minStake: formatAmount(step.minStake), discountBps: step.discountBps })) };
}

/** JSON with every object's keys sorted, so a jsonb round trip (which reorders keys) hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A blank column: null, an empty string or an empty object. The read refuses it as unset; its version is `unset`. */
export function feeDiscountScheduleBlank(raw: unknown): boolean {
  if (raw == null) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  if (typeof raw === 'object' && !Array.isArray(raw)) return Object.keys(raw).length === 0;
  return false;
}

/**
 * Version of a stored fee-decay schedule: `unset` while the column is blank, otherwise a hash of the row. A publish
 * names the version it replaces, so two owners publishing at once cannot both win.
 */
export function feeDiscountScheduleVersion(raw: unknown): string {
  if (feeDiscountScheduleBlank(raw)) return 'unset';
  return `sha256:${createHash('sha256').update(stableJson(raw)).digest('hex')}`;
}

/** The ladder as the approval binds it: same bytes whatever order the keys came in. */
export function feeDiscountSchedulePayload(schedule: unknown): string {
  return stableJson(schedule);
}
