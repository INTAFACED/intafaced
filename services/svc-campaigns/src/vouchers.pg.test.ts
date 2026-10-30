import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, houseFees, parseAmount, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import { PayoutSaga } from './payouts.js';
import { TaskService } from './tasks.js';
import { VoucherService, voucherRewardKeyOf, type AttemptLimits } from './vouchers.js';

/**
 * Vouchers against real Postgres and the in-memory reference ledger (J-campaigns-08, CM-vouchers-coupons-01). Every
 * money test ends with the invariant: what the posted voucher redemptions say was paid is exactly what the customers
 * hold, the pot paid exactly that, every ledger key is a redemption's own, and no voucher used more than its face value.
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
const ME = '00000000-0000-4000-8000-0000000000a1';
const YOU = '00000000-0000-4000-8000-0000000000b2';
const FUNDER = '00000000-0000-4000-8000-0000000000c3';
const HOUR = 3_600_000;

let people = new Map<string, CampaignParticipant>();
const participants = { read: async (userId: string) => people.get(userId) ?? null };
const person = (userId: string, over: Partial<CampaignParticipant> = {}): CampaignParticipant => ({
  userId,
  accountType: 'individual',
  region: 'DE',
  status: 'active',
  kycTier: 'basic',
  ...over,
});

let clock: Date | null = null;
const now = () => clock ?? new Date();
const later = (ms: number) => new Date(now().getTime() + ms).toISOString();

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST vouchers ${(names += 1)}`,
  type: 'voucher',
  rules: 'TEST voucher rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '100' },
  reward: { asset: 'USDT', amount: '10' },
  vouchers: { claimBy: later(24 * HOUR), useBy: later(48 * HOUR) },
  ...over,
});

const campaigns = () => new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants, now });

async function live(over: Partial<CampaignDefinitionInput> = {}) {
  const s = campaigns();
  const c = await s.create({ definition: definition(over), actor: A });
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

let book: MemoryLedger;
let tasks: TaskService;
let vouchers: VoucherService;
let saga: PayoutSaga;
let limits: AttemptLimits | null;
const ADDRESS = '203.0.113.7';

/** The reward pot, funded from earned trade fees as svc-campaigns funds it. */
async function fundPot(amount: string) {
  await book.post(
    recipes.deposit({ userId: FUNDER, assetId: 'USDT', amount: parseAmount(amount), rail: 'test', railRef: `fees-${amount}` }),
  );
  await book.post(
    recipes.feeCharge({
      chargeId: `test-${amount}`,
      userId: FUNDER,
      module: 'trade',
      mode: 'asset',
      assetId: 'USDT',
      amount: parseAmount(amount),
    }),
  );
  await tasks.requestFunding({ reference: `vouchers-${amount}`, sourceModule: 'trade', asset: 'USDT', amount, actor: A });
  await tasks.approveFunding({ reference: `vouchers-${amount}`, actor: B });
  expect((await book.balance(houseFees('trade', 'USDT'))).amount).toBe(0n);
}

const free = async (userId: string) => (await book.balance(userAvailable(userId, 'USDT'))).amount;

/** Posted redemptions are exactly what customers hold and what left the pot; no voucher used past its face value. */
async function reconciles(potFunded: bigint) {
  const paid = await db!.sql<{ amount: string; reward_key: string }[]>`
    SELECT amount::text AS amount, reward_key FROM campaigns.reward_intents WHERE state = 'posted'`;
  let total = 0n;
  for (const p of paid) {
    total += parseAmount(p.amount);
    expect(await book.getTxByKey(`reward:${p.reward_key}`)).not.toBeNull();
  }
  expect((await free(ME)) + (await free(YOU))).toBe(total);
  expect((await book.balance(rewardsEngine('USDT'))).amount).toBe(potFunded - total);
  const over = await db!.sql<{ id: string }[]>`
    SELECT v.id FROM campaigns.vouchers v
    WHERE COALESCE((SELECT sum(i.amount) FROM campaigns.reward_intents i
      WHERE i.campaign_id = v.campaign_id AND i.state NOT IN ('failed', 'forfeited', 'withheld')
        AND left(i.period, length('voucher:' || v.id || ':')) = 'voucher:' || v.id || ':'), 0) > v.face_amount`;
  expect(over).toEqual([]);
}

if (!db) {
  describe.skip('vouchers (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('vouchers (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.redemption_attempts, campaigns.reward_intents, campaigns.vouchers, campaigns.voucher_attempts,
        campaigns.campaign_revisions, campaigns.pot_fundings, campaigns.audit_log, campaigns.campaigns CASCADE`;
      people = new Map([
        [ME, person(ME)],
        [YOU, person(YOU)],
      ]);
      book = new MemoryLedger();
      clock = null;
      saga = new PayoutSaga({ sql: db.sql, ledger: book, reconcileAfterSeconds: 1 });
      tasks = new TaskService({
        sql: db.sql,
        participants,
        saga,
        markets: null,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
        now,
      });
      limits = { perAccount: 100, perAddress: 100, windowSeconds: 3600 };
      vouchers = new VoucherService({ sql: db.sql, participants, campaigns: campaigns(), saga, now, attemptLimits: () => limits });
    });

    it('a voucher keeps its revision’s claim-by and use-by; only a voucher campaign has them, never a use-by before the claim-by', async () => {
      const c = await live();
      const v = await campaigns().issueVoucher({ campaignId: c.id, code: 'test-one', actor: A });
      expect(v).toMatchObject({ code: 'TEST-ONE', claimBy: c.vouchers!.claimBy, useBy: c.vouchers!.useBy });
      expect(await code(campaigns().create({ definition: definition({ type: 'task' }), actor: A }))).toBe(
        'campaigns.voucher_window_invalid',
      );
      expect(
        await code(
          campaigns().create({ definition: definition({ vouchers: { claimBy: later(2 * HOUR), useBy: later(HOUR) } }), actor: A }),
        ),
      ).toBe('campaigns.voucher_window_invalid');
      // A code another campaign issued refuses: a customer types the code alone.
      const other = await live();
      expect(await code(campaigns().issueVoucher({ campaignId: other.id, code: 'TEST-ONE', actor: A }))).toBe(
        'campaigns.voucher_code_taken',
      );
    });

    it('a blank claim-by or use-by refuses the claim by name', async () => {
      const c = await live({ vouchers: { claimBy: later(HOUR), useBy: null } });
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-BLANK', actor: A });
      expect(await code(vouchers.validate({ code: 'TEST-BLANK', accountId: ME, source: ADDRESS }))).toBe('campaigns.voucher_window_unset');
      expect(await code(vouchers.claim({ code: 'TEST-BLANK', accountId: ME, source: ADDRESS }))).toBe('campaigns.voucher_window_unset');
    });

    it('validate changes nothing; two claims at once give one owner and one generic refusal', async () => {
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-RACE', actor: A });
      expect(await vouchers.validate({ code: 'test-race', accountId: ME, source: ADDRESS })).toMatchObject({
        claimable: true,
        face: { asset: 'USDT', amount: '10' },
      });
      expect((await vouchers.mine({ accountId: ME })).vouchers).toEqual([]);
      const tries = await Promise.allSettled([
        vouchers.claim({ code: 'TEST-RACE', accountId: ME, source: ADDRESS }),
        vouchers.claim({ code: 'TEST-RACE', accountId: YOU, source: ADDRESS }),
        vouchers.claim({ code: 'TEST-RACE', accountId: ME, source: ADDRESS }),
      ]);
      const won = tries.filter((t) => t.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const t of tries.filter((x) => x.status === 'rejected')) {
        expect(((t as PromiseRejectedResult).reason as CampaignsError).code).toBe('campaigns.voucher_invalid');
      }
      const [{ n }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.vouchers WHERE claimed_by IS NOT NULL`;
      expect(n).toBe(1);
    });

    it('a wrong code and a code someone else holds get the very same answer', async () => {
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-HELD', actor: A });
      await vouchers.claim({ code: 'TEST-HELD', accountId: YOU, source: ADDRESS });
      const answer = async (p: Promise<unknown>) => {
        const err = (await p.catch((e: unknown) => e)) as CampaignsError;
        return { code: err.code, message: err.message };
      };
      const wrong = await answer(vouchers.claim({ code: 'TEST-NOPE', accountId: ME, source: ADDRESS }));
      const held = await answer(vouchers.claim({ code: 'TEST-HELD', accountId: ME, source: ADDRESS }));
      expect(wrong).toEqual(held);
      expect(wrong.code).toBe('campaigns.voucher_invalid');
      expect(await answer(vouchers.validate({ code: 'TEST-HELD', accountId: ME, source: ADDRESS }))).toEqual(wrong);
      // Past its claim-by, a free code reads the same way.
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-LATE', actor: A });
      clock = new Date(Date.now() + 25 * HOUR);
      expect(await answer(vouchers.claim({ code: 'TEST-LATE', accountId: ME, source: ADDRESS }))).toEqual(wrong);
    });

    it('redeems in parts, once per sequence, never past the face value; the invariant holds', async () => {
      await fundPot('50');
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-PART', actor: A });
      const v = await vouchers.claim({ code: 'TEST-PART', accountId: ME, source: ADDRESS });
      // Someone else cannot redeem it.
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 1, accountId: YOU }))).toBe('campaigns.voucher_invalid');
      const [one, two] = await Promise.all([
        vouchers.redeem({ voucherId: v.id, amount: '2.5', sequence: 1, accountId: ME }),
        vouchers.redeem({ voucherId: v.id, amount: '2.5', sequence: 1, accountId: ME }),
      ]);
      expect([one.created, two.created].sort()).toEqual([false, true]);
      // Both answers name the one redemption; the duplicate may be read before the first one's post lands.
      expect(one.redemption.reward.rewardKey).toBe(voucherRewardKeyOf(v.id, ME, 1));
      expect(await book.getTxByKey(`reward:voucher:${v.id}:${ME}:1`)).not.toBeNull();
      expect(two.redemption.reward.rewardKey).toBe(one.redemption.reward.rewardKey);
      expect([one, two].find((r) => r.created)!.redemption.reward.state).toBe('posted');
      expect(await free(ME)).toBe(parseAmount('2.5'));
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '3', sequence: 1, accountId: ME }))).toBe(
        'campaigns.voucher_sequence_invalid',
      );
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 3, accountId: ME }))).toBe(
        'campaigns.voucher_sequence_invalid',
      );
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '7.6', sequence: 2, accountId: ME }))).toBe(
        'campaigns.voucher_exceeds_remaining',
      );
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '0', sequence: 2, accountId: ME }))).toBe(
        'campaigns.voucher_amount_invalid',
      );
      const rest = await vouchers.redeem({ voucherId: v.id, amount: '7.5', sequence: 2, accountId: ME });
      expect(rest.voucher).toMatchObject({ state: 'used', used: '10', remaining: '0' });
      expect(rest.voucher.redemptions.map((r) => r.amount)).toEqual(['2.5', '7.5']);
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '0.1', sequence: 3, accountId: ME }))).toBe(
        'campaigns.voucher_exceeds_remaining',
      );
      await reconciles(parseAmount('50'));
    });

    it('an empty pot leaves the redemption open, and the reconciler pays it once under the same key', async () => {
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-POT', actor: A });
      const v = await vouchers.claim({ code: 'TEST-POT', accountId: ME, source: ADDRESS });
      const first = await vouchers.redeem({ voucherId: v.id, amount: '4', sequence: 1, accountId: ME });
      expect(first.redemption.reward.state).toBe('pending_funding');
      expect(first.voucher.remaining).toBe('6');
      await fundPot('20');
      await db.sql`UPDATE campaigns.reward_intents SET last_attempt_at = now() - interval '1 hour'`;
      await saga.reconcile();
      await saga.reconcile();
      const [mine] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(mine!.redemptions.map((r) => r.reward.state)).toEqual(['posted']);
      expect(await free(ME)).toBe(parseAmount('4'));
      await reconciles(parseAmount('20'));
    });

    it('a redemption beyond the budget refuses and changes nothing', async () => {
      await fundPot('50');
      const c = await live({ budget: { asset: 'USDT', limit: '5' } });
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-BUDGET', actor: A });
      const v = await vouchers.claim({ code: 'TEST-BUDGET', accountId: ME, source: ADDRESS });
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '6', sequence: 1, accountId: ME }))).toBe('campaigns.budget_exhausted');
      const [mine] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(mine).toMatchObject({ used: '0', remaining: '10', state: 'claimed', redemptions: [] });
      await reconciles(parseAmount('50'));
    });

    it('expires once after its use-by; a late redemption refuses and nothing moves', async () => {
      await fundPot('50');
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-EXPIRE', actor: A });
      const v = await vouchers.claim({ code: 'TEST-EXPIRE', accountId: ME, source: ADDRESS });
      await vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 1, accountId: ME });
      clock = new Date(Date.now() + 49 * HOUR);
      // Before any sweep, the use-by alone refuses.
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 2, accountId: ME }))).toBe('campaigns.voucher_expired');
      // A read already shows it expired, and writes nothing: the sweep marks it.
      const [read] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(read).toMatchObject({ state: 'expired', expiredAt: null });
      expect(await vouchers.expire()).toBe(1);
      expect(await vouchers.expire()).toBe(0);
      const [mine] = (await vouchers.mine({ accountId: ME })).vouchers;
      expect(mine).toMatchObject({ state: 'expired', used: '1', remaining: '9' });
      expect(mine!.expiredAt).toBeTruthy();
      const [{ n }] = await db.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM campaigns.audit_log WHERE action = 'campaign.voucher.expire'`;
      expect(n).toBe(1);
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 2, accountId: ME }))).toBe('campaigns.voucher_expired');
      // The first redemption, asked again, still returns its answer.
      expect((await vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 1, accountId: ME })).created).toBe(false);
      await reconciles(parseAmount('50'));
    });

    it('a paused campaign pays nothing; resumed, the voucher redeems', async () => {
      await fundPot('50');
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-PAUSE', actor: A });
      const v = await vouchers.claim({ code: 'TEST-PAUSE', accountId: ME, source: ADDRESS });
      await campaigns().transition({ id: c.id, action: 'pause', revision: c.revision, actor: A });
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 1, accountId: ME }))).toBe('campaign.not_active');
      await campaigns()
        .issueVoucher({ campaignId: c.id, code: 'TEST-PAUSE2', actor: A })
        .catch(() => undefined);
      expect(await code(vouchers.claim({ code: 'TEST-PAUSE2', accountId: YOU, source: ADDRESS }))).toBe('campaigns.voucher_invalid');
      await campaigns().transition({ id: c.id, action: 'resume', revision: c.revision, actor: A });
      expect((await vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 1, accountId: ME })).redemption.reward.state).toBe('posted');
      await reconciles(parseAmount('50'));
    });

    it('a frozen account’s redemption is withheld before any ledger call and uses nothing of the voucher', async () => {
      await fundPot('50');
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-FROZEN', actor: A });
      const v = await vouchers.claim({ code: 'TEST-FROZEN', accountId: ME, source: ADDRESS });
      people.set(ME, person(ME, { status: 'frozen' }));
      const held = await vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 1, accountId: ME });
      expect(held.redemption.reward).toMatchObject({ state: 'withheld', reason: 'account.frozen', ledgerTxId: null });
      expect(held.voucher).toMatchObject({ remaining: '10', state: 'claimed' });
      expect(await book.getTxByKey(`reward:${held.redemption.reward.rewardKey}`)).toBeNull();
      people.delete(ME);
      expect(await code(vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 2, accountId: ME }))).toBe(
        'campaigns.participant_unread',
      );
      // Active again, the next use pays.
      people.set(ME, person(ME));
      expect((await vouchers.redeem({ voucherId: v.id, amount: '1', sequence: 2, accountId: ME })).redemption.reward.state).toBe('posted');
      await reconciles(parseAmount('50'));
    });

    it('checks and claims count per account and per address; blank limits refuse by name', async () => {
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-LIMIT', actor: A });
      limits = { perAccount: 2, perAddress: 3, windowSeconds: 3600 };
      // Two wrong guesses use my two; the real code then refuses too, and the generic answer was never a free try.
      expect(await code(vouchers.validate({ code: 'TEST-NOPE1', accountId: ME, source: ADDRESS }))).toBe('campaigns.voucher_invalid');
      expect(await code(vouchers.claim({ code: 'TEST-NOPE2', accountId: ME, source: ADDRESS }))).toBe('campaigns.voucher_invalid');
      expect(await code(vouchers.claim({ code: 'TEST-LIMIT', accountId: ME, source: '198.51.100.1' }))).toBe(
        'campaigns.attempt_limit_reached',
      );
      // Another account on the same address has one left there, then the address is spent.
      expect((await vouchers.validate({ code: 'TEST-LIMIT', accountId: YOU, source: ADDRESS })).claimable).toBe(true);
      expect(await code(vouchers.claim({ code: 'TEST-LIMIT', accountId: YOU, source: ADDRESS }))).toBe('campaigns.attempt_limit_reached');
      // The window passes: counting starts again.
      clock = new Date(Date.now() + 2 * HOUR);
      expect((await vouchers.claim({ code: 'TEST-LIMIT', accountId: YOU, source: ADDRESS })).state).toBe('claimed');
      limits = null;
      expect(await code(vouchers.validate({ code: 'TEST-LIMIT', accountId: ME, source: ADDRESS }))).toBe('campaigns.attempt_limit_unset');
    });
  });
}
