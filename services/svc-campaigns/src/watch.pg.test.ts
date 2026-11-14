import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, houseFees, parseAmount, recipes } from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import { PayoutSaga } from './payouts.js';
import { TaskService } from './tasks.js';
import { VoucherService } from './vouchers.js';
import { WatchService, csvCell, exportKeyOf, type WatchLimits } from './watch.js';

/**
 * The watch desk against real Postgres (J-campaigns-17): counts equal a direct count of rows, every budget split adds up
 * to its limit, batch codes are stored as hashes and last four characters only and never returned twice, a deactivated
 * voucher's claim and use refuse, and the same export twice runs one job whose link refuses after its validity.
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
const ADDRESS = '203.0.113.7';

const person = (userId: string): CampaignParticipant => ({
  userId,
  accountType: 'individual',
  region: 'DE',
  status: 'active',
  kycTier: 'basic',
});
const participants = { read: async (userId: string) => person(userId) };

let clock: Date | null = null;
const now = () => clock ?? new Date();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST watch ${(names += 1)}`,
  type: 'voucher',
  rules: 'TEST voucher rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '100' },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
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

const sha = (c: string) => createHash('sha256').update(c.trim().toUpperCase(), 'utf8').digest('hex');

let limits: WatchLimits;
let watch: WatchService;
let vouchers: VoucherService;
let tasks: TaskService;
let book: MemoryLedger;

/** Every text a `campaigns` table holds, as one string: a plain code must be in none of it. */
async function everythingStored(): Promise<string> {
  const tables = await db!.sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'campaigns' AND table_type = 'BASE TABLE'`;
  let out = '';
  for (const { table_name: t } of tables) {
    const rows = await db!.sql`SELECT row_to_json(x)::text AS raw FROM ${db!.sql('campaigns')}.${db!.sql(t)} x`;
    out += rows.map((r) => r.raw).join('\n');
  }
  return out.toUpperCase();
}

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
  await tasks.requestFunding({ reference: `watch-${amount}`, sourceModule: 'trade', asset: 'USDT', amount, actor: A });
  await tasks.approveFunding({ reference: `watch-${amount}`, actor: B });
  expect((await book.balance(houseFees('trade', 'USDT'))).amount).toBe(0n);
}

if (!db) {
  describe.skip('watch desk (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('watch desk (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.export_jobs, campaigns.alert_settings, campaigns.code_publications, campaigns.redemption_attempts,
        campaigns.reward_intents, campaigns.vouchers, campaigns.code_batches, campaigns.voucher_attempts, campaigns.participations,
        campaigns.campaign_revisions, campaigns.pot_fundings, campaigns.audit_log, campaigns.campaigns CASCADE`;
      clock = null;
      limits = { codeBatchMax: 50, exportLinkSeconds: 60, alerts: { budget_low: null, redemptions_spike: null } };
      watch = new WatchService({ sql: db.sql, campaigns: campaigns(), limits: () => limits, now });
      book = new MemoryLedger();
      const saga = new PayoutSaga({ sql: db.sql, ledger: book, reconcileAfterSeconds: 1 });
      tasks = new TaskService({
        sql: db.sql,
        participants,
        saga,
        markets: null,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
        now,
      });
      vouchers = new VoucherService({
        sql: db.sql,
        participants,
        campaigns: campaigns(),
        saga,
        now,
        attemptLimits: () => ({ perAccount: 100, perAddress: 100, windowSeconds: 3600 }),
      });
    });

    it('#3 #4 a generated batch: unique codes, stored as hashes and last four only, returned once and never again', async () => {
      const c = await live();
      const made = await watch.generate({ campaignId: c.id, reference: 'TEST batch', count: 25, actor: A });
      expect(made.created).toBe(true);
      expect(made.codes).toHaveLength(25);
      expect(new Set(made.codes).size).toBe(25);
      const rows = await db.sql<{ code: string | null; code_hash: string; code_last4: string; state: string }[]>`
        SELECT code, code_hash, code_last4, state FROM campaigns.vouchers WHERE batch_id = ${made.batch.id} ORDER BY code_hash`;
      expect(rows).toHaveLength(25);
      expect(rows.every((r) => r.code === null && r.state === 'generated')).toBe(true);
      expect(rows.map((r) => r.code_hash).sort()).toEqual(made.codes!.map(sha).sort());
      expect(rows.map((r) => r.code_last4).sort()).toEqual(made.codes!.map((x) => x.slice(-4)).sort());
      const stored = await everythingStored();
      for (const plain of made.codes!) expect(stored).not.toContain(plain);
      // The same generate again returns the batch and no code; a different count under the name refuses.
      const again = await watch.generate({ campaignId: c.id, reference: 'TEST batch', count: 25, actor: B });
      expect(again).toEqual({ batch: made.batch, codes: null, created: false });
      expect(await code(watch.generate({ campaignId: c.id, reference: 'TEST batch', count: 3, actor: A }))).toBe(
        'campaigns.code_batch_reference_taken',
      );
      // No read returns a plain code.
      const seen = JSON.stringify([
        await watch.campaign({ id: c.id }),
        await watch.overview(),
        await campaigns().listVouchers({ campaignId: c.id }),
      ]);
      for (const plain of made.codes!) expect(seen.toUpperCase()).not.toContain(plain);
    });

    it('#3 a blank or exceeded batch limit refuses generate and import, storing nothing', async () => {
      const c = await live();
      limits.codeBatchMax = null;
      expect(await code(watch.generate({ campaignId: c.id, reference: 'g', count: 1, actor: A }))).toBe('campaigns.code_batch_limit_unset');
      expect(await code(watch.importCodes({ campaignId: c.id, reference: 'i', codes: ['TEST-AAAA'], actor: A }))).toBe(
        'campaigns.code_batch_limit_unset',
      );
      limits.codeBatchMax = 2;
      expect(await code(watch.generate({ campaignId: c.id, reference: 'g', count: 3, actor: A }))).toBe(
        'campaigns.code_batch_limit_exceeded',
      );
      expect(
        await code(watch.importCodes({ campaignId: c.id, reference: 'i', codes: ['TEST-AAAA', 'TEST-BBBB', 'TEST-CCCC'], actor: A })),
      ).toBe('campaigns.code_batch_limit_exceeded');
      const [stored] = await db.sql<{ n: string }[]>`
        SELECT (SELECT count(*) FROM campaigns.vouchers) + (SELECT count(*) FROM campaigns.code_batches) AS n`;
      expect(Number(stored!.n)).toBe(0);
    });

    it('#3 an import: hashes and last four only; a repeated or already issued code refuses the whole file', async () => {
      const c = await live();
      await campaigns().issueVoucher({ campaignId: c.id, code: 'TEST-TYPED', actor: A });
      expect(await code(watch.importCodes({ campaignId: c.id, reference: 'dup', codes: ['TEST-AAAA', 'test-aaaa'], actor: A }))).toBe(
        'campaigns.code_import_duplicate',
      );
      expect(await code(watch.importCodes({ campaignId: c.id, reference: 'taken', codes: ['TEST-BBBB', 'TEST-TYPED'], actor: A }))).toBe(
        'campaigns.voucher_code_taken',
      );
      expect((await db.sql`SELECT id FROM campaigns.code_batches`).length).toBe(0);
      const done = await watch.importCodes({ campaignId: c.id, reference: 'csv', codes: ['TEST-CSV1', 'TEST-CSV2'], actor: A });
      expect(done).toMatchObject({ created: true, codes: null, batch: { source: 'imported', count: 2 } });
      const stored = await everythingStored();
      expect(stored).not.toContain('TEST-CSV1');
      expect(stored).not.toContain('TEST-CSV2');
      // A typed code from another campaign and an imported one collide by hash, across campaigns.
      const other = await live();
      expect(await code(campaigns().issueVoucher({ campaignId: other.id, code: 'TEST-CSV1', actor: A }))).toBe(
        'campaigns.voucher_code_taken',
      );
    });

    it('#5 published codes are claimable; a deactivated voucher refuses its claim and its use', async () => {
      await fundPot('50');
      const c = await live();
      const made = await watch.generate({ campaignId: c.id, reference: 'TEST pub', count: 3, actor: A });
      const [first, second, third] = made.codes!;
      // Not published yet: the generic refusal.
      expect(await code(vouchers.claim({ code: first!, accountId: ME, source: ADDRESS }))).toBe('campaigns.voucher_invalid');
      const published = await watch.publish({ batchId: made.batch.id, actor: B });
      expect(published).toMatchObject({ state: 'published', publishedBy: B });
      expect(await watch.publish({ batchId: made.batch.id, actor: A })).toEqual(published);
      expect((await db.sql`SELECT id FROM campaigns.code_publications`).length).toBe(1);
      const mine = await vouchers.claim({ code: first!, accountId: ME, source: ADDRESS });
      expect(mine.code).toBe(`…${first!.slice(-4)}`);
      await vouchers.redeem({ voucherId: mine.id, amount: '1', sequence: 1, accountId: ME });
      // Deactivate the claimed one and an unclaimed one.
      await watch.deactivate({ voucherId: mine.id, actor: A });
      const [unclaimed] = await db.sql<{ id: string }[]>`SELECT id FROM campaigns.vouchers WHERE code_hash = ${sha(second!)}`;
      expect((await watch.deactivate({ voucherId: unclaimed!.id, actor: A })).state).toBe('deactivated');
      expect(await code(vouchers.redeem({ voucherId: mine.id, amount: '1', sequence: 2, accountId: ME }))).toBe(
        'campaigns.voucher_deactivated',
      );
      expect(await code(vouchers.claim({ code: second!, accountId: YOU, source: ADDRESS }))).toBe('campaigns.voucher_invalid');
      expect((await vouchers.mine({ accountId: ME })).vouchers[0]).toMatchObject({ state: 'deactivated', used: '1' });
      // The one still published is claimable.
      expect((await vouchers.claim({ code: third!, accountId: YOU, source: ADDRESS })).state).toBe('claimed');
      // What it already paid stays paid: the first redemption is posted once.
      expect(await book.getTxByKey(`reward:voucher:${mine.id}:${ME}:1`)).not.toBeNull();
    });

    it('#1 #2 counts equal a direct count of rows, and every budget is reserved plus spent plus left', async () => {
      await fundPot('50');
      const c = await live();
      await campaigns().join({ campaignId: c.id, accountId: ME });
      await campaigns().join({ campaignId: c.id, accountId: YOU });
      const made = await watch.generate({ campaignId: c.id, reference: 'TEST counts', count: 4, actor: A });
      await watch.publish({ batchId: made.batch.id, actor: A });
      const v = await vouchers.claim({ code: made.codes![0]!, accountId: ME, source: ADDRESS });
      await vouchers.redeem({ voucherId: v.id, amount: '3', sequence: 1, accountId: ME });
      // A reward that is still open reserves budget: written qualified, not posted.
      await db.sql`
        INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, form)
        VALUES (${`task:${c.id}:${YOU}:once`}, ${c.id}, ${YOU}, 'once', 'USDT', '2', 'qualified', 'paid')`;
      const one = await watch.campaign({ id: c.id });
      const direct = async (t: string) =>
        Number((await db.sql`SELECT count(*) AS n FROM ${db.sql('campaigns')}.${db.sql(t)} WHERE campaign_id = ${c.id}`)[0]!.n);
      expect(one.participation.count).toBe(await direct('participations'));
      expect(one.vouchers.count).toBe(await direct('vouchers'));
      expect(one.redemptions.count).toBe(await direct('reward_intents'));
      expect(one.publications.count).toBe(await direct('code_publications'));
      expect(one.vouchers.byState.reduce((n, s) => n + s.count, 0)).toBe(one.vouchers.count);
      expect(one.budget).toEqual({ asset: 'USDT', limit: '100', reserved: '2', spent: '3', left: '95' });
      const add = (b: { reserved: string; spent: string; left: string }) =>
        parseAmount(b.reserved) + parseAmount(b.spent) + parseAmount(b.left);
      expect(add(one.budget!)).toBe(parseAmount(one.budget!.limit));
      const overview = await watch.overview();
      expect(overview.kpis).toEqual({ running: 1, live: 1, participants: 2, vouchersIssued: 4, vouchersClaimed: 1, redemptions: 2 });
      for (const b of overview.budgets) expect(add(b)).toBe(parseAmount(b.limit));
      expect(overview.trend).toHaveLength(14);
      expect(overview.trend.at(-1)!.redemptions).toBe(2);
      expect(overview.top[0]).toMatchObject({ campaignId: c.id, redemptions: 2, participants: 2 });
      // The views write nothing, and no money moves from them.
      const posts = vi.spyOn(book, 'post');
      await watch.overview();
      await watch.campaign({ id: c.id });
      expect(posts).not.toHaveBeenCalled();
    });

    it('#1 a blank alert threshold reads not set and refuses to switch on; a set one switches on and fires', async () => {
      const c = await live({ budget: { asset: 'USDT', limit: '10' } });
      const alerts = (await watch.overview()).alerts;
      expect(alerts.map((a) => [a.kind, a.threshold, a.enabled])).toEqual([
        ['budget_low', null, false],
        ['redemptions_spike', null, false],
      ]);
      expect(await code(watch.setAlert({ kind: 'budget_low', enabled: true, actor: A }))).toBe('campaigns.alert_threshold_unset');
      expect((await db.sql`SELECT kind FROM campaigns.alert_settings`).length).toBe(0);
      limits.alerts.budget_low = 50;
      await db.sql`
        INSERT INTO campaigns.reward_intents (reward_key, campaign_id, account_id, period, asset, amount, state, form)
        VALUES (${`task:${c.id}:${YOU}:once`}, ${c.id}, ${YOU}, 'once', 'USDT', '6', 'qualified', 'paid')`;
      const on = await watch.setAlert({ kind: 'budget_low', enabled: true, actor: A });
      expect(on).toMatchObject({ threshold: '50', enabled: true, firing: [{ campaignId: c.id, detail: '4 of 10 USDT left' }] });
      // Switching off needs no threshold.
      limits.alerts.budget_low = null;
      expect((await watch.setAlert({ kind: 'budget_low', enabled: false, actor: A })).enabled).toBe(false);
    });

    it('#6 the same export twice runs one job; the file has the selected fields only; past its validity the link refuses', async () => {
      const c = await live();
      await campaigns().join({ campaignId: c.id, accountId: ME });
      limits.exportLinkSeconds = null;
      expect(await code(watch.requestExport({ campaignId: c.id, dataset: 'participants', fields: ['accountId'], actor: A }))).toBe(
        'campaigns.export_validity_unset',
      );
      limits.exportLinkSeconds = 60;
      const asks = await Promise.all([
        watch.requestExport({ campaignId: c.id, dataset: 'vouchers', fields: ['state', 'voucherId'], actor: A }),
        watch.requestExport({ campaignId: c.id, dataset: 'vouchers', fields: ['voucherId', 'state'], actor: B }),
      ]);
      expect(asks.map((a) => a.created).sort()).toEqual([false, true]);
      expect(asks[0]!.job.id).toBe(asks[1]!.job.id);
      expect((await db.sql`SELECT id FROM campaigns.export_jobs`).length).toBe(1);
      const p = await watch.requestExport({ campaignId: c.id, dataset: 'participants', fields: ['accountId'], actor: A });
      expect(p.job).toMatchObject({ state: 'ready', rows: 1, fields: ['accountId'] });
      const file = await watch.download({ id: p.job.id, actor: A });
      expect(file.body).toBe(`accountId\n${ME}\n`);
      // Past its validity the link refuses, a new ask makes a new job, and the sweep deletes the old file.
      clock = new Date(Date.now() + 61_000);
      expect(await code(watch.download({ id: p.job.id, actor: A }))).toBe('campaigns.export_expired');
      expect((await watch.requestExport({ campaignId: c.id, dataset: 'participants', fields: ['accountId'], actor: A })).created).toBe(
        true,
      );
      expect(await watch.sweepExports()).toBe(2);
      const [old] = await db.sql<{ file: string | null }[]>`SELECT file FROM campaigns.export_jobs WHERE id = ${p.job.id}`;
      expect(old!.file).toBeNull();
      expect(exportKeyOf(c.id, 'vouchers', ['state', 'voucherId'])).toBe(`export:${c.id}:vouchers:voucherId,state`);
    });

    it('a CSV cell is quoted when it must be and never starts a formula', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('=1+1')).toBe("'=1+1");
      expect(csvCell(null)).toBe('');
    });
  });
}
