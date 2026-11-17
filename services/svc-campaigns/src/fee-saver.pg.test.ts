import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import type { PayoutSaga } from './payouts.js';
import { VoucherService } from './vouchers.js';

/**
 * Fee-saver coupons against real Postgres (J-campaigns-09 #1-#3, CM-vouchers-coupons-02). A coupon takes a fraction of
 * our builder fee off up to N venue orders and moves no value: svc-trade signs the lower fee into the order. Each order
 * takes one use, once, by its own key; the last use goes to one order only; a quote writes nothing. The invariant ends
 * every test: no coupon was taken on more orders than its face, and no order took two uses.
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
const ME = '00000000-0000-4000-8000-0000000000a9';
const YOU = '00000000-0000-4000-8000-0000000000b9';
const HOUR = 3_600_000;
const participants = {
  read: async (userId: string): Promise<CampaignParticipant> => ({
    userId,
    accountType: 'individual',
    region: 'DE',
    status: 'active',
    kycTier: 'basic',
  }),
};
let clock: Date | null = null;
const now = () => clock ?? new Date();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
let names = 0;
const definition = (
  feeSaver: { discountBps: number; orders: number },
  over: Partial<CampaignDefinitionInput> = {},
): CampaignDefinitionInput => ({
  name: `TEST fee saver ${(names += 1)}`,
  type: 'voucher',
  rules: 'TEST fee-saver rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  vouchers: { claimBy: later(24 * HOUR), useBy: later(48 * HOUR), feeSaver },
  ...over,
});
const campaigns = () => new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants, now });
async function live(feeSaver: { discountBps: number; orders: number }, over: Partial<CampaignDefinitionInput> = {}) {
  const s = campaigns();
  const c = await s.create({ definition: definition(feeSaver, over), actor: A });
  await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  return s.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
}
async function code(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignsError);
  return (err as CampaignsError).code;
}

let vouchers: VoucherService;
async function claimed(feeSaver: { discountBps: number; orders: number }, codeText: string, who = ME) {
  const c = await live(feeSaver);
  await campaigns().issueVoucher({ campaignId: c.id, code: codeText, actor: A });
  return vouchers.claim({ code: codeText, accountId: who, source: '203.0.113.9' });
}

/** No coupon on more orders than its face; no order with two uses. */
async function invariant() {
  const over = await db!.sql<{ id: string }[]>`
    SELECT v.id FROM campaigns.vouchers v
    WHERE v.kind = 'fee_saver' AND (SELECT count(*) FROM campaigns.fee_saver_uses u WHERE u.voucher_id = v.id) > v.face_amount`;
  expect(over).toEqual([]);
  const twice = await db!.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM campaigns.fee_saver_uses GROUP BY account_id, order_key HAVING count(*) > 1`;
  expect(twice).toEqual([]);
  // Nothing was paid: a fee-saver writes no reward intent.
  expect(await db!.sql`SELECT 1 FROM campaigns.reward_intents`).toHaveLength(0);
}

if (!db) {
  describe.skip('fee-saver coupons (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('fee-saver coupons (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.fee_saver_uses, campaigns.redemption_attempts, campaigns.reward_intents, campaigns.vouchers,
        campaigns.voucher_attempts, campaigns.campaign_revisions, campaigns.audit_log, campaigns.campaigns CASCADE`;
      clock = null;
      const limits = { perAccount: 100, perAddress: 100, windowSeconds: 3600 };
      vouchers = new VoucherService({ sql: db.sql, participants, campaigns: campaigns(), saga: null, now, attemptLimits: () => limits });
    });

    it('#1 a fee-saver campaign needs no budget or reward; its voucher shows its kind, what it does and its orders', async () => {
      const c = await live({ discountBps: 5000, orders: 2 });
      const issued = await campaigns().issueVoucher({ campaignId: c.id, code: 'test-saver-1', actor: A });
      expect(issued).toMatchObject({
        kind: 'fee_saver',
        feeSaver: { discountBps: 5000, orders: 2 },
        face: { asset: 'ORDERS', amount: '2' },
      });
      const check = await vouchers.validate({ code: 'TEST-SAVER-1', accountId: ME, source: null });
      expect(check.feeSaver).toEqual({ discountBps: 5000, orders: 2 });
      await vouchers.claim({ code: 'TEST-SAVER-1', accountId: ME, source: null });
      const [mine] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(mine).toMatchObject({
        kind: 'fee_saver',
        state: 'claimed',
        used: '0',
        remaining: '2',
        feeSaver: { discountBps: 5000, orders: 2, uses: [] },
      });
      // It is never redeemed for cash, even with the ledger connected (a saga that would fail the test if it were asked).
      const wired = new VoucherService({
        sql: db.sql,
        participants,
        campaigns: campaigns(),
        saga: { attempt: async () => expect.fail('a fee-saver asked the reward saga') } as unknown as PayoutSaga,
        now,
        attemptLimits: () => ({ perAccount: 100, perAddress: 100, windowSeconds: 3600 }),
      });
      expect(await code(wired.redeem({ voucherId: mine!.id, amount: '1', sequence: 1, accountId: ME }))).toBe('campaigns.voucher_not_cash');
      await invariant();
    });

    it('#2 a quote writes nothing; a take is one use per order key, the same key again is the same use', async () => {
      const v = await claimed({ discountBps: 5000, orders: 3 }, 'TEST-SAVER-2');
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:1', mode: 'quote' })).toEqual({
        coupon: { voucherId: v.id, code: 'TEST-SAVER-2', discountBps: 5000, sequence: null },
      });
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:1', mode: 'read' })).toEqual({ coupon: null });
      const first = await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:1', mode: 'take' });
      expect(first.coupon).toMatchObject({ voucherId: v.id, sequence: 1 });
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:1', mode: 'take' })).toEqual(first);
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:1', mode: 'read' })).toEqual(first);
      const [mine] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(mine).toMatchObject({ state: 'partially_used', used: '1', remaining: '2' });
      expect(mine!.feeSaver!.uses).toEqual([{ sequence: 1, orderKey: 'order:me:1', at: expect.any(String) }]);
      // Another person's coupon is never theirs.
      expect(await vouchers.feeSaver({ accountId: YOU, orderKey: 'order:you:1', mode: 'take' })).toEqual({ coupon: null });
      await invariant();
    });

    it('#3 the last use goes to one order only, even at once; then there is no coupon and the next order carries the rank rate', async () => {
      await claimed({ discountBps: 5000, orders: 1 }, 'TEST-SAVER-3');
      const both = await Promise.all([
        vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:a', mode: 'take' }),
        vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:b', mode: 'take' }),
      ]);
      expect(both.filter((x) => x.coupon !== null)).toHaveLength(1);
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:c', mode: 'quote' })).toEqual({ coupon: null });
      const [mine] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(mine).toMatchObject({ state: 'used', remaining: '0' });
      // The order that took it still reads its use.
      const winner = both[0]!.coupon ? 'order:me:a' : 'order:me:b';
      expect((await vouchers.feeSaver({ accountId: ME, orderKey: winner, mode: 'read' })).coupon).toMatchObject({ sequence: 1 });
      await invariant();
    });

    it('the largest discount is taken first; a coupon past its use-by, or of a paused campaign, is never taken', async () => {
      const small = await claimed({ discountBps: 2000, orders: 5 }, 'TEST-SAVER-S');
      const big = await claimed({ discountBps: 6000, orders: 1 }, 'TEST-SAVER-B');
      expect((await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:1', mode: 'take' })).coupon?.voucherId).toBe(big.id);
      expect((await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:2', mode: 'take' })).coupon?.voucherId).toBe(small.id);
      await campaigns().transition({ id: small.campaignId, action: 'pause', revision: 1, actor: A });
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:3', mode: 'take' })).toEqual({ coupon: null });
      await campaigns().transition({ id: small.campaignId, action: 'resume', revision: 1, actor: A });
      clock = new Date(Date.now() + 49 * HOUR);
      expect(await vouchers.feeSaver({ accountId: ME, orderKey: 'order:me:4', mode: 'take' })).toEqual({ coupon: null });
      await invariant();
    });
  });
}
