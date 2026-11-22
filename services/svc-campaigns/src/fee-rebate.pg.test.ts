import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LAYER_OFF_CODE,
  LedgerError,
  MemoryLedger,
  campaignBudgetAccount,
  movesCustomerBalance,
  parseAmount,
  recipes,
  rewardOwedAccount,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import type { CompetitionFill, CompetitionFillSource } from './competitions.js';
import { FeeRebateService } from './fee-rebates.js';
import { PayoutSaga, ledgerRewardId } from './payouts.js';
import { ageReward } from './test-age-door.js';
import { VoucherService } from './vouchers.js';

/**
 * Fee rebate coupons against real Postgres and the in-memory reference ledger (J-campaigns-09 #5 #6,
 * CM-vouchers-coupons-03). A claimed coupon accrues `rebateBps` of our builder fee on each eligible fill, once per fill,
 * never past its face value; each accrual is owed from the campaign's budget and held until its delay passes. Every test
 * ends with the invariant: no coupon accrued past its face, no fill accrued twice, each accrual is exactly one owed
 * redemption, the ledger owes exactly what the owed accruals say, and no customer balance holds anything.
 */

const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;
const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const db: TestDatabase | null =
  available && adminUrl ? await createTestDatabase({ url: adminUrl, service: 'campaigns', migrations }) : null;
afterAll(async () => {
  await db?.drop();
});

const A = 'operator-a';
const B = 'operator-b';
const ME = '00000000-0000-4000-8000-0000000000a7';
const FUNDER = '00000000-0000-4000-8000-0000000000c7';
const HOUR = 3_600_000;
const VENUE = 'test-venue';
const participants = {
  read: async (userId: string): Promise<CampaignParticipant> => ({
    userId,
    accountType: 'individual',
    region: 'DE',
    status: 'active',
    kycTier: 'basic',
  }),
};

let names = 0;
const definition = (
  feeRebate: { rebateBps: number; delaySeconds: number },
  face = '0.003',
  over: Partial<CampaignDefinitionInput> = {},
): CampaignDefinitionInput => ({
  name: `TEST fee rebate ${(names += 1)}`,
  type: 'voucher',
  rules: 'TEST fee rebate rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '10' },
  reward: { asset: 'USDC', amount: face },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  vouchers: { claimBy: new Date(Date.now() + 24 * HOUR).toISOString(), useBy: new Date(Date.now() + 48 * HOUR).toISOString(), feeRebate },
  ...over,
});
const campaigns = () => new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants });
async function live(def: CampaignDefinitionInput) {
  const s = campaigns();
  const c = await s.create({ definition: def, actor: A });
  await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  return s.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
}

/** svc-ledger with the custodial layer off: a post that touches a customer account is refused. */
function custodyOff(inner: MemoryLedger): LedgerClient {
  return {
    post: async (request: PostRequest) => {
      if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
      return inner.post(request);
    },
    balance: (ref) => inner.balance(ref),
    balances: (t, id) => inner.balances(t, id),
    getTx: (id) => inner.getTx(id),
    getTxByKey: (key) => inner.getTxByKey(key),
  };
}

/** A venue that answers each read with the fills the test put on it, every one every time (a redelivery each read). */
let venue: { fills: CompetitionFill[]; unread: string | null };
const fills: CompetitionFillSource = {
  async ourFills(_userId, since) {
    if (venue.unread) return { unread: venue.unread };
    return { venueId: VENUE, asOf: new Date().toISOString(), fills: venue.fills.filter((f) => new Date(f.filledAt) >= since) };
  },
};
let fillNo = 0;
const fill = (builderFee: string, over: Partial<CompetitionFill> = {}): CompetitionFill => ({
  fillId: `fill-${(fillNo += 1)}`,
  venueAccount: '0xabc',
  symbol: 'BTC-USDC',
  quoteAsset: 'USDC',
  notional: '60',
  builderFee,
  feeAsset: 'USDC',
  filledAt: new Date().toISOString(),
  ...over,
});

let book: MemoryLedger;
let saga: PayoutSaga;
let vouchers: VoucherService;
let rebates: FeeRebateService;

async function seedRewardsEngine(amount: string) {
  const ref = `seed-${Date.now()}-${Math.random()}`;
  await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount(amount), rail: 'test', railRef: ref }));
  await book.post(
    recipes.feeCharge({ chargeId: ref, userId: FUNDER, module: 'trade', mode: 'asset', assetId: 'USDC', amount: parseAmount(amount) }),
  );
  await book.post(recipes.sweepFeesToRewards({ windowId: ref, sourceModule: 'trade', assetId: 'USDC', amount: parseAmount(amount) }));
}

async function claimed(feeRebate = { rebateBps: 5000, delaySeconds: 3600 }, face = '0.003') {
  const c = await live(definition(feeRebate, face));
  const code = `TEST-RB-${(names += 1)}`;
  await campaigns().issueVoucher({ campaignId: c.id, code, actor: A });
  return vouchers.claim({ code, accountId: ME, source: '203.0.113.7' });
}
const mine = async () => (await vouchers.mine({ accountId: ME })).vouchers;

/** The invariant, on every coupon and every accrual the database holds. */
async function invariant() {
  const over = await db!.sql`
    SELECT v.id FROM campaigns.vouchers v
    WHERE v.kind = 'fee_rebate' AND (SELECT COALESCE(sum(a.amount), 0) FROM campaigns.fee_rebate_accruals a WHERE a.voucher_id = v.id) > v.face_amount`;
  expect(over).toHaveLength(0);
  const rows = await db!.sql<
    { reward_key: string; campaign_id: string; account_id: string; amount: string; state: string; accrued: string }[]
  >`
    SELECT i.reward_key, i.campaign_id, i.account_id, i.amount::text AS amount, i.state, a.amount::text AS accrued
    FROM campaigns.fee_rebate_accruals a JOIN campaigns.reward_intents i ON i.reward_key = a.reward_key`;
  const counted = await db!.sql`SELECT count(*)::int AS n FROM campaigns.fee_rebate_accruals`;
  expect(rows).toHaveLength(Number(counted[0]?.n));
  for (const r of rows) {
    expect(parseAmount(r.amount), r.reward_key).toBe(parseAmount(r.accrued));
    const owed = (await book.balance(rewardOwedAccount(ledgerRewardId(r.campaign_id, r.reward_key)))).amount;
    expect(owed, r.reward_key).toBe(r.state === 'owed' ? parseAmount(r.amount) : 0n);
    expect((await book.balance(campaignBudgetAccount(r.campaign_id))).amount).toBe(0n);
    expect((await book.balance(userAvailable(r.account_id, 'USDC'))).amount).toBe(0n);
  }
  expect(book.reconcile()).toEqual({ ok: true });
}

if (!db) {
  describe.skip('fee rebate coupons (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('fee rebate coupons (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.fee_rebate_accruals, campaigns.fee_saver_uses, campaigns.redemption_attempts,
        campaigns.reward_intents, campaigns.vouchers, campaigns.voucher_attempts, campaigns.campaign_revisions,
        campaigns.audit_log, campaigns.campaigns CASCADE`;
      book = new MemoryLedger();
      saga = new PayoutSaga({
        sql: db.sql,
        ledger: custodyOff(book),
        reconcileAfterSeconds: 1,
        rewardCeiling: { perCampaign: parseAmount('100'), total: parseAmount('1000') },
      });
      const limits = { perAccount: 100, perAddress: 100, windowSeconds: 3600 };
      vouchers = new VoucherService({ sql: db.sql, participants, campaigns: campaigns(), saga, attemptLimits: () => limits });
      rebates = new FeeRebateService({ sql: db.sql, saga, fills, payDecimals: 6 });
      venue = { fills: [], unread: null };
      await seedRewardsEngine('5');
    });

    it('#5 the coupon shows its kind and terms, its face in USDC; it is never redeemed for cash', async () => {
      const v = await claimed();
      expect(v).toMatchObject({
        kind: 'fee_rebate',
        face: { asset: 'USDC', amount: '0.003' },
        remaining: '0.003',
        feeRebate: { rebateBps: 5000, delaySeconds: 3600, accruals: [] },
      });
      const err = await vouchers.redeem({ voucherId: v.id, amount: '0.001', sequence: 1, accountId: ME }).catch((e: unknown) => e);
      expect((err as CampaignsError).code).toBe('campaigns.voucher_not_cash');
      await invariant();
    });

    it('#5 each eligible fill accrues once; a redelivered fill does not double it; a zero-fee fill accrues nothing; the total stops at the face', async () => {
      await claimed();
      const first = fill('0.0024');
      venue.fills.push(first);
      expect(await rebates.accrueFor(ME, new Date(Date.now() - HOUR))).toHaveLength(1);
      // The same fill again, read by the next passes and two at once: nothing more accrues.
      await Promise.all([rebates.tick(), rebates.tick()]);
      await rebates.tick();
      let [v] = await mine();
      expect(v!.feeRebate!.accruals).toEqual([
        expect.objectContaining({ sequence: 1, fillId: first.fillId, builderFee: '0.0024', amount: '0.0012' }),
      ]);
      // A zero-fee fill (svc-trade leaves it out; here it is answered anyway) accrues nothing.
      venue.fills.push(fill('0'));
      await rebates.tick();
      [v] = await mine();
      expect(v!.feeRebate!.accruals).toHaveLength(1);
      // Two more fills: the first takes another 0.0012, the second only the 0.0006 left; a fourth accrues nothing.
      venue.fills.push(fill('0.0024'), fill('0.0024'), fill('0.0024'));
      await rebates.tick();
      await rebates.tick();
      [v] = await mine();
      expect(v!.feeRebate!.accruals.map((a) => a.amount)).toEqual(['0.0012', '0.0012', '0.0006']);
      expect(v).toMatchObject({ state: 'used', used: '0.003', remaining: '0' });
      // Each accrual is one redemption, owed now and held until its delay passes.
      expect(v!.redemptions.map((r) => [r.sequence, r.amount, r.reward.state])).toEqual([
        [1, '0.0012', 'owed'],
        [2, '0.0012', 'owed'],
        [3, '0.0006', 'owed'],
      ]);
      for (const a of v!.feeRebate!.accruals) {
        expect(Date.parse(a.payableAt)).toBeGreaterThan(Date.now() + 3590_000);
      }
      await invariant();
    });

    it('#5 a fill before the claim, after the use-by or in another asset accrues nothing; a rebate that rounds to nothing accrues nothing', async () => {
      await claimed({ rebateBps: 1, delaySeconds: 0 });
      venue.fills.push(
        fill('5', { filledAt: new Date(Date.now() - 2 * HOUR).toISOString() }),
        fill('5', { filledAt: new Date(Date.now() + 72 * HOUR).toISOString() }),
        fill('5', { feeAsset: 'BTC' }),
        // 1 bp of 0.00001 USDC is below a millionth: it rounds to nothing in the paying token.
        fill('0.00001'),
      );
      await rebates.accrueFor(ME, new Date(Date.now() - 3 * HOUR));
      const [v] = await mine();
      expect(v!.feeRebate!.accruals).toEqual([]);
      await invariant();
    });

    it('#5 an unread venue accrues nothing and the next read accrues the fill once', async () => {
      await claimed();
      venue.fills.push(fill('0.0024'));
      venue.unread = 'trade.venue.unavailable';
      await rebates.tick();
      expect((await mine())[0]!.feeRebate!.accruals).toEqual([]);
      venue.unread = null;
      await rebates.tick();
      await rebates.tick();
      expect((await mine())[0]!.feeRebate!.accruals).toHaveLength(1);
      await invariant();
    });

    it('#6 once the delay passes each accrual is released for payment, still owed once', async () => {
      await claimed({ rebateBps: 5000, delaySeconds: 600 });
      venue.fills.push(fill('0.0024'));
      await rebates.tick();
      const [v] = await mine();
      const key = v!.redemptions[0]!.reward.rewardKey;
      const [held] = await db.sql<{ hold_until: Date }[]>`SELECT hold_until FROM campaigns.reward_intents WHERE reward_key = ${key}`;
      expect(held!.hold_until.getTime()).toBeGreaterThan(Date.now());
      const aged = await ageReward(db.sql)(key, 601_000);
      expect(aged).toMatchObject({ state: 'owed' });
      expect(Date.parse(aged!.holdUntil!)).toBeLessThan(Date.now());
      await saga.reconcile();
      expect((await mine())[0]!.redemptions[0]!.reward.state).toBe('owed');
      await invariant();
    });
  });
}
