import { describe, expect, it } from 'vitest';
import { MemoryLedger, formatAmount, houseFees, parseAmount, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';

import { AffiliatePayoutRefuseError } from './admin-tree-read.js';
import { accrueCommission, type CommissionRow, type FeeEvent, type TierRate } from './commission.js';
import { UNPUBLISHED_ACCRUAL_TIER_LAW, type AccrualTierLaw } from './commission-rate-law.js';
import { MemoryReferralTree, ReferralError } from './referral-tree.js';
import {
  AFFILIATE_PAYOUT_SOURCE_MODULE,
  MAX_PAYOUT_TIER_DEPTH,
  affiliatePayoutRowKey,
  assertAccrualRowCommissionMath,
  assertPayoutRateProvenance,
  payoutKeysAreBusinessDerived,
  payoutKeysAreDistinct,
  planAffiliatePayout,
  postAffiliatePayout,
} from './payout-engine.js';

/**
 * THE AFFILIATE PAYOUT ENGINE — assertions are on BALANCES, not on shapes.
 *
 * Every test that concerns value reads the ledger afterwards. A test that only
 * checks a returned object proves the engine can describe a payout, not that it
 * made one, and the two diverge exactly when it matters.
 */

const ASSET = 'USDT';

// Canonical lowercase UUIDs — the ledger's owner-identifier space rejects
// anything else for `user`, which is a real guard and not test ceremony.
const PAYER = '00000000-0000-4000-8000-00000000000a';
const HOP0 = '00000000-0000-4000-8000-00000000000b';
const HOP1 = '00000000-0000-4000-8000-00000000000c';
const HOP2 = '00000000-0000-4000-8000-00000000000d';

const FEE_EVENT = 'fee-evt-1';

/** Owner-published law fixture. These numbers are a TEST FIXTURE, never a default. */
/** Caller checked the freeze list and found nobody frozen. Omission is a different call. */
const NOBODY_FROZEN: ReadonlySet<string> = new Set();

const PUBLISHED: AccrualTierLaw = {
  published: true,
  tiers: [
    { hop: 0, rate: '0.10' },
    { hop: 1, rate: '0.05' },
    { hop: 2, rate: '0.02' },
  ],
};

function feeEvent(overrides: Partial<FeeEvent> = {}): FeeEvent {
  return {
    feeEventId: FEE_EVENT,
    userId: PAYER,
    feeAmount: '100',
    asset: ASSET,
    at: new Date('2026-08-09T12:00:00.000Z'),
    ...overrides,
  };
}

/** PAYER → HOP0 → HOP1 → HOP2 (payer's hop-0 ancestor is HOP0). */
function threeTierTree(): Map<string, string> {
  const tree = new MemoryReferralTree();
  tree.attribute({ userId: HOP1, referrerId: HOP2 });
  tree.attribute({ userId: HOP0, referrerId: HOP1 });
  tree.attribute({ userId: PAYER, referrerId: HOP0 });
  return new Map(tree.listEdges().map((e) => [e.userId, e.referrerId]));
}

function rows(law: AccrualTierLaw = PUBLISHED, fee: FeeEvent = feeEvent()): CommissionRow[] {
  const tiers = law.published ? law.tiers : ([] as readonly TierRate[]);
  return accrueCommission({ fee, parent: threeTierTree(), tiers });
}

/**
 * A ledger whose `identity` fee pool actually holds the fee.
 *
 * The pool is funded the way production funds it — a real deposit and a real
 * fee charge — because house accounts are hard non-negative, so a test that
 * skipped this would prove the fan-out works against a pot that cannot exist.
 */
async function fundedLedger(feeAmount = '100'): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({ userId: PAYER, assetId: ASSET, amount: parseAmount('1000'), rail: 'crypto-native', railRef: 'seed-1' }),
  );
  await ledger.post(
    recipes.feeCharge({
      mode: 'asset',
      chargeId: FEE_EVENT,
      userId: PAYER,
      module: AFFILIATE_PAYOUT_SOURCE_MODULE,
      assetId: ASSET,
      amount: parseAmount(feeAmount),
    }),
  );
  return ledger;
}

async function bal(ledger: MemoryLedger, ref: Parameters<MemoryLedger['balance']>[0]): Promise<string> {
  return formatAmount((await ledger.balance(ref)).amount);
}

// ── The refusal that is the whole point ──────────────────────────────────────

describe('payout refuses when the owner has published no rate', () => {
  it('unpublished law refuses with affiliate.payout.rates_unset and names DIRECTION §8', () => {
    const err = (() => {
      try {
        planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: UNPUBLISHED_ACCRUAL_TIER_LAW });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(AffiliatePayoutRefuseError);
    const e = err as AffiliatePayoutRefuseError;
    expect(e.code).toBe('affiliate.payout.rates_unset');
    expect(e.residual).toContain('DIRECTION §8');
    expect(e.residual).toContain('owner-only');
  });

  /**
   * THE GATE MUST FIRE WITH NOTHING TO INSPECT.
   *
   * The router calls `assertPayoutRateProvenance([], law)` as its FIRST act, so
   * an operator hears the rate refusal before any other complaint. A mutation
   * that deleted the `!law.published` branch was caught by only ONE assertion
   * without this test, because with rows present the per-row loop still refuses
   * — just with a neighbouring code and the SAME residual. This pins the
   * empty-row path, which is the one the mount actually depends on.
   */
  it('the rate gate refuses on an unpublished law even with no rows to inspect', () => {
    try {
      assertPayoutRateProvenance([], UNPUBLISHED_ACCRUAL_TIER_LAW);
      expect.unreachable('the gate must refuse before it has rows to look at');
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliatePayoutRefuseError);
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.rates_unset');
    }
  });

  it('refusing to pay moves NO value — asserted on balances, not on the throw', async () => {
    const ledger = await fundedLedger();
    const before = {
      pool: await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET)),
      hop0: await bal(ledger, userAvailable(HOP0, ASSET)),
      rewards: await bal(ledger, rewardsEngine(ASSET)),
    };

    await expect(
      (async () => {
        const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: UNPUBLISHED_ACCRUAL_TIER_LAW });
        return postAffiliatePayout(ledger, plan);
      })(),
    ).rejects.toBeInstanceOf(AffiliatePayoutRefuseError);

    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe(before.pool);
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe(before.hop0);
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe(before.rewards);
  });

  it('a rate the owner never published cannot be laundered through a durable row', () => {
    // Accrued under operator-supplied tiers (resolveAccrualTiers permits this at
    // accrual). Paying "the rate on the row" would make an operator's number
    // real money — the exact hole this closes.
    const operatorTiers: readonly TierRate[] = [{ hop: 0, rate: '0.90' }];
    const laundered = accrueCommission({ fee: feeEvent(), parent: threeTierTree(), tiers: operatorTiers });
    expect(laundered).toHaveLength(1);
    expect(laundered[0]!.rate).toBe('0.90');

    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: laundered, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse an operator-supplied rate');
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliatePayoutRefuseError);
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.rate_unpublished');
    }
  });

  it('a hop the owner priced with no tier refuses rather than paying zero or skipping', () => {
    const lawHop0Only: AccrualTierLaw = { published: true, tiers: [{ hop: 0, rate: '0.10' }] };
    // Rows exist for hops 0/1/2 (accrued when all three were published).
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: lawHop0Only });
      expect.unreachable('must refuse the unpriced hops');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.rate_unpublished');
    }
  });

  it('rate formatting is not a rate change — "0.10" matches a published "0.1"', () => {
    const sameRateDifferentText: AccrualTierLaw = {
      published: true,
      tiers: [
        { hop: 0, rate: '0.1' },
        { hop: 1, rate: '0.05' },
        { hop: 2, rate: '0.02' },
      ],
    };
    expect(() => assertPayoutRateProvenance(rows(), sameRateDifferentText)).not.toThrow();
  });
});

// ── The money actually moves, once the rate exists ───────────────────────────

describe('multi-tier fan-out across the tree', () => {
  it('pays every tier the published share, and the pool loses exactly the total', async () => {
    const ledger = await fundedLedger();
    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe('100');

    const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
    expect(plan.legs).toHaveLength(3);
    expect(plan.totalCommission).toBe('17'); // 10 + 5 + 2 on a fee of 100

    await postAffiliatePayout(ledger, plan);

    // Fan-out landed on every tier, at the published rate.
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('10');
    expect(await bal(ledger, userAvailable(HOP1, ASSET))).toBe('5');
    expect(await bal(ledger, userAvailable(HOP2, ASSET))).toBe('2');

    // Sum-to-zero per asset: the pool funded all of it, nothing was minted, and
    // the rewards engine is a pass-through that ends flat.
    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe('83');
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('0');
  });

  it('the whole book still sums to zero per asset after the fan-out', async () => {
    const ledger = await fundedLedger();
    await postAffiliatePayout(
      ledger,
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN }),
    );

    // treasury holds the negative of every custodial balance; the invariant the
    // ledger enforces per transaction must also hold across the book.
    const total =
      parseAmount(await bal(ledger, userAvailable(PAYER, ASSET))) +
      parseAmount(await bal(ledger, userAvailable(HOP0, ASSET))) +
      parseAmount(await bal(ledger, userAvailable(HOP1, ASSET))) +
      parseAmount(await bal(ledger, userAvailable(HOP2, ASSET))) +
      parseAmount(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))) +
      parseAmount(await bal(ledger, rewardsEngine(ASSET))) +
      (await ledger.balance({ ownerType: 'treasury', ownerId: 'rail:crypto-native', assetId: ASSET, kind: 'available' })).amount;
    expect(formatAmount(total)).toBe('0');
  });

  it('an unfunded fee pool fails rather than inventing the commission', async () => {
    const ledger = new MemoryLedger(); // no deposit, no fee charge
    const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });

    await expect(postAffiliatePayout(ledger, plan)).rejects.toThrow();

    // Nobody was paid out of a pool that never held the fee.
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('0');
  });

  it('sweeps the producer fee pool named on the accrual row (trade), not identity default', async () => {
    // THE NAMED HOLE this closes: a trading fee lands in houseFees("trade").
    // Before source_module, payout always swept houseFees("identity") and failed
    // as InsufficientFunds while trade held the fee.
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({ userId: PAYER, assetId: ASSET, amount: parseAmount('1000'), rail: 'crypto-native', railRef: 'seed-trade' }),
    );
    await ledger.post(
      recipes.feeCharge({
        mode: 'asset',
        chargeId: FEE_EVENT,
        userId: PAYER,
        module: 'trade',
        assetId: ASSET,
        amount: parseAmount('100'),
      }),
    );
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('100');
    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe('0');

    const tradeRows = rows(PUBLISHED, feeEvent({ sourceModule: 'trade' }));
    expect(tradeRows.every((r) => r.sourceModule === 'trade')).toBe(true);

    const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: tradeRows, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
    // Plan must name trade in every sweep key path — not identity.
    for (const leg of plan.legs) {
      expect(leg.sweep.idempotencyKey).toContain('trade');
    }

    await postAffiliatePayout(ledger, plan);

    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('10');
    expect(await bal(ledger, userAvailable(HOP1, ASSET))).toBe('5');
    expect(await bal(ledger, userAvailable(HOP2, ASSET))).toBe('2');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('83');
    // Identity pool was never funded and must stay empty (no cross-pool invent).
    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe('0');
  });

  it('wrong-pool residual: trade-funded fee fails when rows still say identity', async () => {
    const ledger = new MemoryLedger();
    await ledger.post(
      recipes.deposit({ userId: PAYER, assetId: ASSET, amount: parseAmount('1000'), rail: 'crypto-native', railRef: 'seed-wrong' }),
    );
    await ledger.post(
      recipes.feeCharge({
        mode: 'asset',
        chargeId: FEE_EVENT,
        userId: PAYER,
        module: 'trade',
        assetId: ASSET,
        amount: parseAmount('100'),
      }),
    );
    // Rows without producer stamp still default to identity — the old hole.
    const identityRows = rows(PUBLISHED, feeEvent()); // no sourceModule
    expect(identityRows.every((r) => r.sourceModule === 'identity')).toBe(true);

    await expect(
      postAffiliatePayout(
        ledger,
        planAffiliatePayout({ feeEventId: FEE_EVENT, rows: identityRows, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN }),
      ),
    ).rejects.toThrow();
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('0');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('100');
  });

  it('mixed sourceModule on one fee event refuses before any ledger post', async () => {
    // Accrue always stamps one module per fee. A hand-assembled / corrupt set
    // that names trade AND pay would debit two houseFees pools for one event.
    // Same corruption class as mixed_asset — refuse the plan, move nothing.
    const ledger = await fundedLedger();
    const base = rows(PUBLISHED, feeEvent({ sourceModule: 'trade' }));
    expect(base.length).toBeGreaterThanOrEqual(2);
    const mixed: CommissionRow[] = [
      { ...base[0]!, sourceModule: 'trade' },
      { ...base[1]!, sourceModule: 'pay' },
    ];
    const beforeHop0 = await bal(ledger, userAvailable(HOP0, ASSET));
    const beforePool = await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET));

    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: mixed, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse mixed fee pools on one fee event');
    } catch (err) {
      expect(err).toBeInstanceOf(AffiliatePayoutRefuseError);
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.mixed_source_module');
    }

    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe(beforeHop0);
    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe(beforePool);
  });
});

// ── Retry pays once ──────────────────────────────────────────────────────────

describe('a retried payout pays once', () => {
  it('re-posting the same plan leaves every balance unchanged', async () => {
    const ledger = await fundedLedger();
    const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });

    const first = await postAffiliatePayout(ledger, plan);
    const after = {
      hop0: await bal(ledger, userAvailable(HOP0, ASSET)),
      hop1: await bal(ledger, userAvailable(HOP1, ASSET)),
      hop2: await bal(ledger, userAvailable(HOP2, ASSET)),
      pool: await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET)),
    };

    // Retry the identical business event — as a crashed worker would.
    const second = await postAffiliatePayout(ledger, plan);

    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe(after.hop0);
    expect(await bal(ledger, userAvailable(HOP1, ASSET))).toBe(after.hop1);
    expect(await bal(ledger, userAvailable(HOP2, ASSET))).toBe(after.hop2);
    expect(await bal(ledger, houseFees(AFFILIATE_PAYOUT_SOURCE_MODULE, ASSET))).toBe(after.pool);

    // A deduped post STILL RETURNS A TRANSACTION, so the honest assertion is on
    // the keys and the resulting tx identity — never on how many times `post`
    // was called.
    expect(second.idempotencyKeys).toEqual(first.idempotencyKeys);
    expect(second.txIds).toEqual(first.txIds);
  });

  it('a replanned payout derives identical keys — no clock, no random id', async () => {
    const planA = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
    // A different process, a different day, the same business event.
    const planB = planAffiliatePayout({
      feeEventId: FEE_EVENT,
      rows: rows(PUBLISHED, feeEvent({ at: new Date('2027-01-01T00:00:00.000Z') })),
      law: PUBLISHED,
      frozenBeneficiaryIds: NOBODY_FROZEN,
    });

    const keysOf = (p: typeof planA) => p.legs.flatMap((l) => [l.sweep.idempotencyKey, l.payout.idempotencyKey]);
    expect(keysOf(planB)).toEqual(keysOf(planA));
  });

  /**
   * THE GUARD ITSELF, TESTED AGAINST THE SHAPES IT CLAIMS TO CATCH.
   *
   * Without this, `payoutKeysAreBusinessDerived` was free to be wrong and still
   * green — and its first version WAS wrong in exactly the expensive direction:
   * it allowed a trailing uuid, which is where a generated id gets appended. A
   * guard nothing adversarial is pointed at is a comment.
   */
  it('the business-key guard rejects a clock reading and an appended random id', () => {
    const good = { idempotencyKeys: [`affiliate:${FEE_EVENT}:${HOP0}:h0`] } as never;
    expect(payoutKeysAreBusinessDerived(good)).toBe(true);

    // The shape that drained a pot: `close:${id}:${randomUUID()}`.
    const trailingUuid = {
      idempotencyKeys: [`affiliate:${FEE_EVENT}:${HOP0}:h0:11111111-2222-4333-8444-555555555555`],
    } as never;
    expect(payoutKeysAreBusinessDerived(trailingUuid)).toBe(false);

    const isoClock = { idempotencyKeys: [`affiliate:${FEE_EVENT}:${HOP0}:h0:2026-08-09T12:00:00.000Z`] } as never;
    expect(payoutKeysAreBusinessDerived(isoClock)).toBe(false);

    const epochClock = { idempotencyKeys: [`affiliate:${FEE_EVENT}:${HOP0}:h0:1786000000000`] } as never;
    expect(payoutKeysAreBusinessDerived(epochClock)).toBe(false);
  });

  it('every key is distinct and derived from the business event', async () => {
    const ledger = await fundedLedger();
    const receipt = await postAffiliatePayout(
      ledger,
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN }),
    );

    expect(payoutKeysAreDistinct(receipt)).toBe(true);
    expect(payoutKeysAreBusinessDerived(receipt)).toBe(true);
    for (const key of receipt.idempotencyKeys) {
      expect(key).toContain(FEE_EVENT);
    }
  });

  it('the row key is the accrual table unique constraint (feeEventId, beneficiary, hop)', () => {
    expect(affiliatePayoutRowKey({ feeEventId: FEE_EVENT, beneficiaryId: HOP0, hop: 0 })).toBe(`affiliate:${FEE_EVENT}:${HOP0}:h0`);
    // Same beneficiary at a different hop is a different payment.
    expect(affiliatePayoutRowKey({ feeEventId: FEE_EVENT, beneficiaryId: HOP0, hop: 1 })).not.toBe(
      affiliatePayoutRowKey({ feeEventId: FEE_EVENT, beneficiaryId: HOP0, hop: 0 }),
    );
  });

  it('a partial fan-out completes on replay and pays nobody twice', async () => {
    const ledger = await fundedLedger();
    const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });

    // Simulate a crash after the first leg: post only leg 0.
    await ledger.post(plan.legs[0]!.sweep);
    await ledger.post(plan.legs[0]!.payout);
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('10');
    expect(await bal(ledger, userAvailable(HOP1, ASSET))).toBe('0'); // half-paid tree

    // Replay the whole plan.
    await postAffiliatePayout(ledger, plan);

    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('10'); // not 20
    expect(await bal(ledger, userAvailable(HOP1, ASSET))).toBe('5');
    expect(await bal(ledger, userAvailable(HOP2, ASSET))).toBe('2');
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('0');
  });
});

// ── Cycles, self-referral, depth ─────────────────────────────────────────────

describe('a cycle is refused', () => {
  it('the tree refuses closing a cycle at write time', () => {
    const tree = new MemoryReferralTree();
    tree.attribute({ userId: HOP0, referrerId: HOP1 });
    tree.attribute({ userId: PAYER, referrerId: HOP0 });

    try {
      // HOP1 → PAYER would close PAYER → HOP0 → HOP1 → PAYER.
      tree.attribute({ userId: HOP1, referrerId: PAYER });
      expect.unreachable('must refuse the cycle');
    } catch (err) {
      expect(err).toBeInstanceOf(ReferralError);
      expect((err as ReferralError).code).toBe('referral.cycle');
    }
  });

  it('a cyclic parent map cannot be walked into an infinite payout', () => {
    // A corrupt map that bypassed the write guard (concurrent race, bad restore).
    const cyclic = new Map<string, string>([
      [PAYER, HOP0],
      [HOP0, HOP1],
      [HOP1, PAYER],
    ]);
    expect(() => accrueCommission({ fee: feeEvent(), parent: cyclic, tiers: PUBLISHED.tiers })).toThrowError(ReferralError);
  });

  it('no accrual row survives a cycle, so the payout has nothing to pay forever', () => {
    const cyclic = new Map<string, string>([
      [PAYER, HOP0],
      [HOP0, PAYER],
    ]);
    expect(() => accrueCommission({ fee: feeEvent(), parent: cyclic, tiers: PUBLISHED.tiers })).toThrow();
  });
});

describe('self-referral is refused', () => {
  it('the tree refuses a user referring themselves', () => {
    const tree = new MemoryReferralTree();
    try {
      tree.attribute({ userId: PAYER, referrerId: PAYER });
      expect.unreachable('must refuse self-referral');
    } catch (err) {
      expect((err as ReferralError).code).toBe('referral.self');
    }
  });

  it('payout refuses a row that pays the fee payer their own commission', async () => {
    const ledger = await fundedLedger();
    const selfRow: CommissionRow = {
      feeEventId: FEE_EVENT,
      beneficiaryId: PAYER,
      payerId: PAYER,
      hop: 0,
      rate: '0.10',
      feeAmount: '100',
      commissionAmount: '10',
      asset: ASSET,
      accruedAt: new Date('2026-08-09T12:00:00.000Z'),
      sourceModule: AFFILIATE_PAYOUT_SOURCE_MODULE,
    };

    const before = await bal(ledger, userAvailable(PAYER, ASSET));
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: [selfRow], law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse self-referral payout');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.self_referral');
    }
    expect(await bal(ledger, userAvailable(PAYER, ASSET))).toBe(before);
  });
});

describe('the depth bound is enforced', () => {
  it('the bound lives in one named constant', () => {
    expect(MAX_PAYOUT_TIER_DEPTH).toBe(5);
  });

  it('the tree refuses an edge past the bound', () => {
    const tree = new MemoryReferralTree(1); // chains may be one hop deep
    tree.attribute({ userId: HOP0, referrerId: HOP1 }); // HOP0 is now at depth 1
    // PAYER → HOP0 would put PAYER at depth 2, one past the cap.
    expect(() => tree.attribute({ userId: PAYER, referrerId: HOP0 })).toThrowError(expect.objectContaining({ code: 'referral.depth' }));
  });

  it('payout refuses a row past the bound even when the row exists', async () => {
    const ledger = await fundedLedger();
    const deepRow: CommissionRow = {
      feeEventId: FEE_EVENT,
      beneficiaryId: HOP2,
      payerId: PAYER,
      hop: MAX_PAYOUT_TIER_DEPTH, // one past the last payable hop (0-indexed)
      rate: '0.02',
      feeAmount: '100',
      commissionAmount: '2',
      asset: ASSET,
      accruedAt: new Date('2026-08-09T12:00:00.000Z'),
      sourceModule: AFFILIATE_PAYOUT_SOURCE_MODULE,
    };
    const law: AccrualTierLaw = { published: true, tiers: [{ hop: MAX_PAYOUT_TIER_DEPTH, rate: '0.02' }] };

    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: [deepRow], law, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse past the depth bound');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.depth_exceeded');
    }
    expect(await bal(ledger, userAvailable(HOP2, ASSET))).toBe('0');
  });

  it('an explicit tighter bound is honoured over the default', () => {
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN, maxTierDepth: 1 });
      expect.unreachable('must refuse hop 1 and 2 under a bound of 1');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.depth_exceeded');
    }
  });
});

// ── The other ways a fan-out goes wrong ──────────────────────────────────────

describe('fan-out integrity', () => {
  it('a frozen beneficiary stops the payout instead of paying a partial tree', async () => {
    const ledger = await fundedLedger();
    try {
      planAffiliatePayout({
        feeEventId: FEE_EVENT,
        rows: rows(),
        law: PUBLISHED,
        frozenBeneficiaryIds: new Set([HOP1]),
      });
      expect.unreachable('must refuse while a beneficiary is frozen');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.beneficiary_frozen');
    }
    // Critically: HOP0 was NOT paid before the refusal reached HOP1.
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('0');
  });

  it('an omitted freeze roster refuses and yields no payout rows', () => {
    const accrued = rows();
    expect(accrued.length).toBeGreaterThan(0);
    let refused: unknown;
    let legs: readonly unknown[] = [];
    try {
      legs = planAffiliatePayout({
        feeEventId: FEE_EVENT,
        rows: accrued,
        law: PUBLISHED,
      }).legs;
    } catch (err) {
      refused = err;
    }
    expect(refused, `planner returned ${legs.length} payout rows`).toBeInstanceOf(AffiliatePayoutRefuseError);
    expect((refused as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.freeze_roster_required');
    expect(legs).toEqual([]);
  });

  it('no accrual rows refuses rather than reporting a paid zero', () => {
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: [], law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.nothing_accrued');
    }
  });

  it('a mixed-asset fan-out is refused — sum-to-zero is per asset', () => {
    const mixed = [...rows(), { ...rows()[0]!, asset: 'BTC', beneficiaryId: HOP2, hop: 2, rate: '0.02', commissionAmount: '2' }];
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: mixed, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse mixed assets');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.mixed_asset');
    }
  });

  it('rows from another fee event cannot be smuggled into a plan', () => {
    const foreign = { ...rows()[0]!, feeEventId: 'fee-evt-other' };
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: [foreign], law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse a mixed-event plan');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.invalid');
    }
  });

  it('a duplicated row cannot pay one accrual twice inside one plan', () => {
    const first = rows()[0]!;
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: [first, { ...first }], law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse a duplicate row');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.invalid');
    }
  });

  it('a zero-fee event accrues nothing, and payout says so rather than posting nothing', () => {
    const zero = rows(PUBLISHED, feeEvent({ feeAmount: '0' }));
    expect(zero).toEqual([]);
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: zero, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.nothing_accrued');
    }
  });

  it('a fractional fee pays fractional commission without touching a float', async () => {
    const ledger = await fundedLedger('33.333333333333333333');
    const fee = feeEvent({ feeAmount: '33.333333333333333333' });
    const plan = planAffiliatePayout({
      feeEventId: FEE_EVENT,
      rows: rows(PUBLISHED, fee),
      law: PUBLISHED,
      frozenBeneficiaryIds: NOBODY_FROZEN,
    });
    await postAffiliatePayout(ledger, plan);

    // 10% of 33.333333333333333333, truncated at 18dp by decimalMul.
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('3.333333333333333333');
    expect(await bal(ledger, rewardsEngine(ASSET))).toBe('0');
  });

  it('tampered commissionAmount refuses even when the rate matches owner law', async () => {
    const ledger = await fundedLedger();
    const base = rows()[0]!;
    const inflated: CommissionRow = { ...base, commissionAmount: '99' };
    expect(() => assertAccrualRowCommissionMath(inflated)).toThrow(AffiliatePayoutRefuseError);
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: [inflated], law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse tampered commission');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.commission_mismatch');
    }
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe('0');
  });

  it('mixed feeAmount on one fee event refuses before any ledger post', async () => {
    const ledger = await fundedLedger();
    const base = rows();
    expect(base.length).toBeGreaterThanOrEqual(2);
    const mixed: CommissionRow[] = [base[0]!, { ...base[1]!, feeAmount: '50' }];
    const beforeHop0 = await bal(ledger, userAvailable(HOP0, ASSET));
    try {
      planAffiliatePayout({ feeEventId: FEE_EVENT, rows: mixed, law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
      expect.unreachable('must refuse mixed fee amounts');
    } catch (err) {
      expect((err as AffiliatePayoutRefuseError).code).toBe('affiliate.payout.fee_mismatch');
    }
    expect(await bal(ledger, userAvailable(HOP0, ASSET))).toBe(beforeHop0);
  });

  it('every leg sweep and payout wire the same amount as the row claims', () => {
    const plan = planAffiliatePayout({ feeEventId: FEE_EVENT, rows: rows(), law: PUBLISHED, frozenBeneficiaryIds: NOBODY_FROZEN });
    for (const leg of plan.legs) {
      const claimed = parseAmount(leg.commissionAmount);
      const sweepCredit = leg.sweep.entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount, 0n);
      const payoutCredit = leg.payout.entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount, 0n);
      expect(sweepCredit).toBe(claimed);
      expect(payoutCredit).toBe(claimed);
    }
  });
});
