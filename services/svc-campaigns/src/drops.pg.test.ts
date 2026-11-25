import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LAYER_OFF_CODE,
  LedgerError,
  MemoryLedger,
  movesCustomerBalance,
  parseAmount,
  recipes,
  rewardOwedAccount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { DropService, claimKeyOf } from './drops.js';
import { CampaignsError } from './codes.js';
import { PayoutSaga, ledgerRewardId } from './payouts.js';
import { partial } from '@intafaced/service-kit/testing';

/**
 * Seasons and limited drops against real Postgres (RC-campaigns-04, J-campaigns-20 #5): a private database per run with
 * the service's real migrations, so the row lock, the unique claim key and the publish CHECK are the ones that ship.
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
const NOW = new Date('2026-10-24T12:00:00.000Z');
const service = () => new DropService({ sql: db!.sql, tgeSchedule: () => null, now: () => NOW });

async function code(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignsError);
  return (err as CampaignsError).code;
}

async function publishedDrop(count: string, opensAt = '2026-10-24T11:00:00Z', closesAt?: string) {
  const drops = service();
  const drop = await drops.createDrop({ title: 'TEST drop', count, opensAt, closesAt: closesAt ?? null, actor: A });
  return drops.publishDrop({ id: drop.id, actor: B });
}

if (!db) {
  describe.skip('limited drops (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('limited drops (Postgres)', () => {
    beforeEach(async () => {
      await db!.truncateAll();
    });

    it('ten concurrent claims by ten accounts on a drop of three: exactly three succeed, seven are sold out', async () => {
      const drop = await publishedDrop('3');
      const drops = service();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => drops.claim({ dropId: drop.id, accountId: `acct-${i}` })),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(3);
      expect(lost).toHaveLength(7);
      for (const r of lost) expect((r.reason as CampaignsError).code).toBe('drop.sold_out');
      const [row] = await db!.sql<{ remaining: number; claims: number }[]>`
      SELECT d.remaining, (SELECT count(*)::int FROM campaigns.drop_claims c WHERE c.drop_id = d.id) AS claims
      FROM campaigns.drops d WHERE d.id = ${drop.id}`;
      expect(row).toEqual({ remaining: 0, claims: 3 });
    });

    it('the same account claiming twice keeps one claim and gets the first back, even once sold out', async () => {
      const drop = await publishedDrop('1');
      const drops = service();
      const first = await drops.claim({ dropId: drop.id, accountId: 'acct-1' });
      expect(first).toMatchObject({ created: true, remaining: 0 });
      expect(first.claim.claimKey).toBe(claimKeyOf(drop.id, 'acct-1'));
      const again = await drops.claim({ dropId: drop.id, accountId: 'acct-1' });
      expect(again).toEqual({ claim: first.claim, created: false, remaining: 0 });
      expect(await code(drops.claim({ dropId: drop.id, accountId: 'acct-2' }))).toBe('drop.sold_out');
      const [claims] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.drop_claims`;
      expect(claims!.n).toBe(1);
    });

    it('two concurrent claims by one account write one row', async () => {
      const drop = await publishedDrop('5');
      const drops = service();
      const both = await Promise.all([1, 2].map(() => drops.claim({ dropId: drop.id, accountId: 'acct-1' })));
      expect(both.filter((r) => r.created)).toHaveLength(1);
      expect(both[0]!.claim).toEqual(both[1]!.claim);
      const [row] = await db!.sql<{ remaining: number }[]>`SELECT remaining FROM campaigns.drops WHERE id = ${drop.id}`;
      expect(row!.remaining).toBe(4);
    });

    it('refuses a blank or malformed count, a valued drop, and blank or offset-less times, writing nothing', async () => {
      const drops = service();
      const base = { title: 'TEST drop', opensAt: '2026-10-24T11:00:00Z', actor: A };
      expect(await code(drops.createDrop({ ...base, count: '' }))).toBe('drop.count_unset');
      expect(await code(drops.createDrop({ ...base, count: '  ' }))).toBe('drop.count_unset');
      expect(await code(drops.createDrop({ ...base, count: '0' }))).toBe('drop.count_invalid');
      expect(await code(drops.createDrop({ ...base, count: '2.5' }))).toBe('drop.count_invalid');
      expect(await code(drops.createDrop({ ...base, count: '3', campaignId: 'campaign_any' }))).toBe('campaigns.reward_saga_unwired');
      expect(await code(drops.createDrop({ ...base, count: '3', opensAt: '' }))).toBe('campaigns.window_unset');
      expect(await code(drops.createDrop({ ...base, count: '3', opensAt: '2026-10-24T11:00:00' }))).toBe('campaigns.timezone_unset');
      const [dropRows] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.drops`;
      expect(dropRows!.n).toBe(0);
    });

    it('a second person publishes: the creator is refused, and the database refuses it too', async () => {
      const drops = service();
      const drop = await drops.createDrop({ title: 'TEST drop', count: '2', opensAt: '2026-10-24T11:00:00Z', actor: A });
      expect(await code(drops.publishDrop({ id: drop.id, actor: A }))).toBe('campaigns.second_person_required');
      await expect(
        db!.sql`UPDATE campaigns.drops SET status = 'published', published_by = ${A}, published_at = now() WHERE id = ${drop.id}`,
      ).rejects.toThrow(/drops_publish_ck/);
      const published = await drops.publishDrop({ id: drop.id, actor: B });
      expect(published).toMatchObject({ status: 'published', publishedBy: B, createdBy: A });
      expect(await code(drops.publishDrop({ id: drop.id, actor: B }))).toBe('campaigns.already_published');
      const actions = await db!.sql<{ action: string; actor: string }[]>`SELECT action, actor FROM campaigns.audit_log ORDER BY id`;
      expect(actions).toEqual([
        { action: 'drop.create', actor: A },
        { action: 'drop.publish', actor: B },
      ]);
    });

    it('an unpublished drop is unknown to customers; outside its window it is not open', async () => {
      const drops = service();
      const draft = await drops.createDrop({ title: 'TEST draft', count: '2', opensAt: '2026-10-24T11:00:00Z', actor: A });
      expect(await code(drops.claim({ dropId: draft.id, accountId: 'acct-1' }))).toBe('drop.unknown');
      expect((await drops.room('acct-1')).drops).toEqual([]);
      const later = await publishedDrop('2', '2026-10-25T00:00:00Z');
      expect(await code(drops.claim({ dropId: later.id, accountId: 'acct-1' }))).toBe('drop.not_open');
      const closed = await publishedDrop('2', '2026-10-23T00:00:00Z', '2026-10-24T00:00:00Z');
      expect(await code(drops.claim({ dropId: closed.id, accountId: 'acct-1' }))).toBe('drop.not_open');
    });

    it("the room shows the live season with zero task campaigns, each published drop's state and only the caller's claims", async () => {
      const drops = service();
      const season = await drops.createSeason({
        name: 'TEST season',
        startsAt: '2026-10-24T00:00:00Z',
        endsAt: '2026-11-24T00:00:00Z',
        actor: A,
      });
      expect((await drops.room('acct-1')).season).toBeNull();
      await drops.publishSeason({ id: season.id, actor: B });
      const open = await publishedDrop('2');
      await drops.claim({ dropId: open.id, accountId: 'acct-1' });
      const room = await drops.room('acct-1');
      expect(room.season).toEqual({
        id: season.id,
        name: 'TEST season',
        startsAt: '2026-10-24T00:00:00.000Z',
        endsAt: '2026-11-24T00:00:00.000Z',
        state: 'live',
        points: '0',
        taskCampaigns: 0,
        pointsBlocker: 'owner.decision',
      });
      expect(room.drops).toEqual([
        expect.objectContaining({ id: open.id, state: 'open', remaining: 1, count: 2, mine: expect.objectContaining({ dropId: open.id }) }),
      ]);
      expect((await drops.room('acct-2')).drops[0]!.mine).toBeNull();
      expect(room.tge.networks.map((n) => n.blocker)).toEqual(['launch.schedule_unset', 'audit.external']);
    });

    it('shows the live season that started last, else the next to start', async () => {
      const drops = service();
      const make = async (name: string, startsAt: string, endsAt: string) => {
        const s = await drops.createSeason({ name, startsAt, endsAt, actor: A });
        await drops.publishSeason({ id: s.id, actor: B });
      };
      await make('TEST later', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
      expect((await drops.room('acct-1')).season).toMatchObject({ name: 'TEST later', state: 'upcoming' });
      await make('TEST older live', '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z');
      await make('TEST newer live', '2026-10-20T00:00:00Z', '2026-11-20T00:00:00Z');
      await make('TEST ended', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
      expect((await drops.room('acct-1')).season).toMatchObject({ name: 'TEST newer live', state: 'live' });
    });

    it('refuses a season with a blank or reversed window', async () => {
      const drops = service();
      expect(await code(drops.createSeason({ name: 'TEST', startsAt: '', endsAt: '2026-11-24T00:00:00Z', actor: A }))).toBe(
        'campaigns.window_unset',
      );
      expect(
        await code(drops.createSeason({ name: 'TEST', startsAt: '2026-11-24T00:00:00Z', endsAt: '2026-10-24T00:00:00Z', actor: A })),
      ).toBe('campaigns.window_invalid');
      expect(await code(drops.createSeason({ name: 'TEST', startsAt: 'tomorrow+0', endsAt: '2026-11-24T00:00:00Z', actor: A }))).toBe(
        'campaigns.window_invalid',
      );
      expect(await code(drops.createSeason({ name: 'TEST', startsAt: '2026-10-24T00:00', endsAt: '2026-11-24T00:00:00Z', actor: A }))).toBe(
        'campaigns.timezone_unset',
      );
    });

    it('a drop in a season sits inside its window, and publishes only once its season is published', async () => {
      const drops = service();
      const season = await drops.createSeason({ name: 'TEST', startsAt: '2026-10-24T00:00:00Z', endsAt: '2026-11-24T00:00:00Z', actor: A });
      const base = { title: 'TEST drop', seasonId: season.id, count: '2', actor: A };
      expect(await code(drops.createDrop({ ...base, opensAt: '2026-10-23T00:00:00Z' }))).toBe('campaigns.window_invalid');
      expect(await code(drops.createDrop({ ...base, opensAt: '2026-10-25T00:00:00Z', closesAt: '2026-12-01T00:00:00Z' }))).toBe(
        'campaigns.window_invalid',
      );
      expect(await code(drops.createDrop({ ...base, seasonId: 'season_missing', opensAt: '2026-10-25T00:00:00Z' }))).toBe('season.unknown');
      const drop = await drops.createDrop({ ...base, opensAt: '2026-10-25T00:00:00Z' });
      expect(await code(drops.publishDrop({ id: drop.id, actor: B }))).toBe('season.not_published');
      await drops.publishSeason({ id: season.id, actor: B });
      await expect(drops.publishDrop({ id: drop.id, actor: B })).resolves.toMatchObject({ status: 'published' });
    });
  });

  describe('limited drops with value (Postgres, the reward saga on the in-memory ledger)', () => {
    const acct = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const FUNDER = '00000000-0000-4000-8000-0000000000f6';
    const HOUR = 3_600_000;
    let book: MemoryLedger;
    let saga: PayoutSaga;
    let campaigns: CampaignService;
    let paidTo: string[];
    const participants = {
      read: async (userId: string): Promise<CampaignParticipant> => ({
        userId,
        accountType: 'individual',
        region: 'DE',
        status: 'active',
        kycTier: 'full',
      }),
    };

    beforeEach(async () => {
      await db!.truncateAll();
      book = new MemoryLedger();
      const ledger: LedgerClient = {
        post: async (request: PostRequest) => {
          if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
          return book.post(request);
        },
        balance: (ref) => book.balance(ref),
        balances: (t, id) => book.balances(t, id),
        getTx: (id) => book.getTx(id),
        getTxByKey: (key) => book.getTxByKey(key),
      };
      await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount('100'), rail: 'test', railRef: 'seed' }));
      await book.post(
        recipes.feeCharge({
          chargeId: 'seed',
          userId: FUNDER,
          module: 'trade',
          mode: 'asset',
          assetId: 'USDC',
          amount: parseAmount('100'),
        }),
      );
      await book.post(recipes.sweepFeesToRewards({ windowId: 'seed', sourceModule: 'trade', assetId: 'USDC', amount: parseAmount('100') }));
      saga = new PayoutSaga({
        sql: db!.sql,
        ledger,
        reconcileAfterSeconds: 0,
        rewardCeiling: { perCampaign: parseAmount('100'), total: parseAmount('1000') },
      });
      campaigns = new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants });
      paidTo = [];
    });

    const valued = () =>
      new DropService({
        sql: db!.sql,
        tgeSchedule: () => null,
        saga,
        payTo: async (accountId) => {
          paidTo.push(accountId);
          return false;
        },
        campaigns,
        now: () => new Date(),
      });

    async function dropCampaign(over: Partial<CampaignDefinitionInput> = {}) {
      const definition: CampaignDefinitionInput = {
        name: `TEST drop campaign ${Math.random().toString(36).slice(2, 8)}`,
        type: 'drop',
        rules: 'TEST rules: each claim of the drop is worth the reward, paid to your connected wallet.',
        startsAt: new Date(Date.now() - HOUR).toISOString(),
        endsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
        budget: { asset: 'USDC', limit: '0.03' },
        limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
        reward: { asset: 'USDC', amount: '0.01' },
        ...over,
      };
      const c = await campaigns.create({ definition, actor: A });
      await campaigns.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
      await campaigns.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
      await campaigns.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
      return c;
    }

    async function valuedDrop(campaignId: string, count: string) {
      const drops = valued();
      const drop = await drops.createDrop({
        title: 'TEST valued drop',
        count,
        opensAt: new Date(Date.now() - HOUR).toISOString(),
        campaignId,
        actor: A,
      });
      return drops.publishDrop({ id: drop.id, actor: B });
    }

    const intents = () =>
      db!.sql<{ reward_key: string; account_id: string; amount: string; state: string }[]>`
        SELECT reward_key, account_id, amount::text AS amount, state FROM campaigns.reward_intents ORDER BY reward_key`;

    it('a drop with value names a live drop campaign with its reward set; anything else refuses and writes nothing', async () => {
      const drops = valued();
      const base = { title: 'TEST', count: '3', opensAt: new Date().toISOString(), actor: A };
      expect(await code(drops.createDrop({ ...base, campaignId: 'campaign_missing' }))).toBe('drop.campaign_invalid');
      const airdrop = await campaigns.create({
        definition: {
          name: 'TEST not a drop',
          type: 'task',
          rules: 'TEST rules',
          startsAt: new Date(Date.now() - HOUR).toISOString(),
          endsAt: new Date(Date.now() + HOUR).toISOString(),
          participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
          budget: { asset: 'USDC', limit: '1' },
          limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
          reward: { asset: 'USDC', amount: '0.01' },
        },
        actor: A,
      });
      expect(await code(drops.createDrop({ ...base, campaignId: airdrop.id }))).toBe('drop.campaign_invalid');
      const [n] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.drops`;
      expect(n!.n).toBe(0);
      const c = await dropCampaign();
      const drop = await valuedDrop(c.id, '3');
      expect(drop).toMatchObject({ kind: 'value', value: { campaignId: c.id, asset: 'USDC', amount: '0.01' } });
    });

    it('five concurrent claims of a valued drop of three: three claims, three rewards owed once each, the ledger owing exactly that', async () => {
      const c = await dropCampaign();
      const drop = await valuedDrop(c.id, '3');
      const drops = valued();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => drops.claim({ dropId: drop.id, accountId: acct(i), forwarded: { 'x-test': '1' } })),
      );
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(3);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect((r.reason as CampaignsError).code).toBe('drop.sold_out');
      }
      const rows = await intents();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.reward_key).toBe(claimKeyOf(drop.id, row.account_id));
        expect(row.state).toBe('owed');
        expect(parseAmount(row.amount)).toBe(parseAmount('0.01'));
        expect((await book.balance(rewardOwedAccount(ledgerRewardId(c.id, row.reward_key)))).amount).toBe(parseAmount('0.01'));
      }
      // Each claimer's wallet was noted on their own claim, before it was owed.
      expect(paidTo.sort()).toEqual(rows.map((r) => r.account_id).sort());
      // The room shows each winner's reward, owed, with no chain reference until it is paid.
      const winner = rows[0]!.account_id;
      const mine = (await drops.room(winner)).drops[0]!.mine!;
      expect(mine).toMatchObject({
        kind: 'value',
        reward: { rewardKey: claimKeyOf(drop.id, winner), asset: 'USDC', amount: '0.01', state: 'owed', chainTx: null },
      });
    });

    it('a second claim returns the first and owes nothing more; a crash after the commit leaves it for the reconciler', async () => {
      const c = await dropCampaign();
      const drop = await valuedDrop(c.id, '2');
      const first = await valued().claim({ dropId: drop.id, accountId: acct(1) });
      const again = await valued().claim({ dropId: drop.id, accountId: acct(1) });
      expect(again).toMatchObject({ created: false, claim: { claimKey: first.claim.claimKey } });
      expect((await intents()).map((r) => r.state)).toEqual(['owed']);
      // A saga that never answers (the process stopped after the commit): the claim and its reward stand, open, and the
      // reconciler owes the same key once.
      const silent = new DropService({
        sql: db!.sql,
        tgeSchedule: () => null,
        saga: partial<PayoutSaga>({
          attempt: async () => {
            throw new Error('TEST: stopped');
          },
        }),
        now: () => new Date(),
      });
      const second = await silent.claim({ dropId: drop.id, accountId: acct(2) });
      expect(second.created).toBe(true);
      expect((await intents()).find((r) => r.account_id === acct(2))?.state).toBe('qualified');
      await saga.reconcile();
      await saga.reconcile();
      const rows = await intents();
      expect(rows.map((r) => r.state)).toEqual(['owed', 'owed']);
      const key = claimKeyOf(drop.id, acct(2));
      expect((await book.balance(rewardOwedAccount(ledgerRewardId(c.id, key)))).amount).toBe(parseAmount('0.01'));
    });

    it('a claim by an account its campaign’s participation rules leave out refuses and claims or owes nothing', async () => {
      const c = await dropCampaign({ participation: { exclusions: [], regionScope: 'listed', restrictedRegions: ['DE'] } });
      const drop = await valuedDrop(c.id, '3');
      expect(await code(valued().claim({ dropId: drop.id, accountId: acct(1) }))).toBe('campaigns.region_blocked');
      // With no way to read the rules, the claim refuses rather than skipping them.
      const blind = new DropService({ sql: db!.sql, tgeSchedule: () => null, saga });
      expect(await code(blind.claim({ dropId: drop.id, accountId: acct(2) }))).toBe('campaigns.participant_unread');
      // An account that cannot be read is refused too.
      const unread = new DropService({
        sql: db!.sql,
        tgeSchedule: () => null,
        saga,
        campaigns: new CampaignService({
          sql: db!.sql,
          timeZone: () => 'UTC',
          participants: { read: async () => Promise.reject(new Error('identity down')) },
        }),
      });
      expect(await code(unread.claim({ dropId: drop.id, accountId: acct(3) }))).toBe('campaigns.participant_unread');
      const [row] = await db!.sql<{ remaining: number; claims: number }[]>`
        SELECT d.remaining, (SELECT count(*)::int FROM campaigns.drop_claims c WHERE c.drop_id = d.id) AS claims
        FROM campaigns.drops d WHERE d.id = ${drop.id}`;
      expect(row).toEqual({ remaining: 3, claims: 0 });
      expect(await intents()).toHaveLength(0);
      expect(paidTo).toEqual([]);
    });

    it('a claim the budget has no room for refuses and claims nothing', async () => {
      const c = await dropCampaign({ budget: { asset: 'USDC', limit: '0.01' } });
      const drop = await valuedDrop(c.id, '3');
      const drops = valued();
      await drops.claim({ dropId: drop.id, accountId: acct(1) });
      expect(await code(drops.claim({ dropId: drop.id, accountId: acct(2) }))).toBe('campaigns.budget_exhausted');
      const [row] = await db!.sql<{ remaining: number; claims: number }[]>`
        SELECT d.remaining, (SELECT count(*)::int FROM campaigns.drop_claims c WHERE c.drop_id = d.id) AS claims
        FROM campaigns.drops d WHERE d.id = ${drop.id}`;
      expect(row).toEqual({ remaining: 2, claims: 1 });
      expect(await intents()).toHaveLength(1);
    });
  });
}
