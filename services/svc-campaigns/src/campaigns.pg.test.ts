import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, ParticipationRules, RuleGroup } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService, effectiveState, eligibilityOf, participationKeyOf, reviewKeyOf, zonedClock } from './campaigns.js';
import { CampaignsError } from './codes.js';

/**
 * The campaign object against real Postgres (CM-campaign-types-01, J-campaigns-01 #1-#3, #6, #7): a private database per
 * run with the service's real migrations, so the unique name, the second-person CHECK and the participation key are the
 * ones that ship.
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
const ME = 'account-me';
// A Saturday, 12:00 UTC.
const NOW = new Date('2026-10-24T12:00:00.000Z');
let now = NOW;
let zone: string | null = 'UTC';
// Identity's answers by account, as svc-identity's participant read returns them; an account not listed reads null.
let people = new Map<string, CampaignParticipant>();
let identityReads = 0;
const participants = {
  read: async (userId: string) => {
    identityReads += 1;
    return people.get(userId) ?? null;
  },
};
const who = (over: Partial<CampaignParticipant> = {}): CampaignParticipant => ({
  userId: '00000000-0000-4000-8000-000000000001',
  accountType: 'individual',
  region: 'DE',
  status: 'active',
  kycTier: 'basic',
  ...over,
});
const service = () =>
  new CampaignService({ sql: db!.sql, timeZone: () => zone, now: () => now, participants, ruleLimits: () => ({ depth: 3, size: 10 }) });

async function code(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CampaignsError);
  return (err as CampaignsError).code;
}

const full = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: 'TEST campaign',
  type: 'task',
  rules: 'TEST rules',
  startsAt: '2026-10-24T11:00:00Z',
  endsAt: '2026-11-24T11:00:00Z',
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '1000' },
  reward: { asset: 'USDT', amount: '10' },
  ...over,
});

/** A creates and submits, B approves, A activates. */
async function live(over: Partial<CampaignDefinitionInput> = {}) {
  const s = service();
  const c = await s.create({ definition: full(over), actor: A });
  await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  return s.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
}

if (!db) {
  describe.skip('campaigns (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('campaigns (Postgres)', () => {
    beforeEach(async () => {
      await db!.truncateAll();
      people = new Map([[ME, who()]]);
      identityReads = 0;
      now = NOW;
      zone = 'UTC';
    });

    it('an empty catalogue lists the types, parked ones with owner.decision, and no campaign', async () => {
      const out = await service().catalogue(ME);
      expect(out.campaigns).toEqual([]);
      expect(out.types.find((t) => t.type === 'gift_card')?.blocker).toBe('owner.decision');
      expect(out.types.find((t) => t.type === 'points')?.blocker).toBe('owner.decision');
      expect(out.types.find((t) => t.type === 'task')?.blocker).toBeNull();
    });

    it('the gate names each blank by its own code, in order, and nothing goes live', async () => {
      const s = service();
      const blanks: [Partial<CampaignDefinitionInput>, string][] = [
        [{ budget: null }, 'campaigns.budget_unset'],
        [{ budget: { asset: 'USDT', limit: ' ' } }, 'campaigns.budget_unset'],
        [{ participation: null }, 'campaigns.rules_unset'],
        [{ startsAt: null }, 'campaigns.time_frame_unset'],
        [{ endsAt: '' }, 'campaigns.time_frame_unset'],
        [{ reward: null }, 'campaigns.reward_unset'],
        [{ type: 'gift_card' }, 'owner.decision'],
        [{ type: 'points' }, 'owner.decision'],
      ];
      for (const [i, [over, expected]] of blanks.entries()) {
        const c = await s.create({ definition: full({ name: `TEST blank ${i}`, ...over }), actor: A });
        expect(await code(s.transition({ id: c.id, action: 'submit', revision: 1, actor: A }))).toBe(expected);
        expect((await s.validate({ id: c.id })).missing[0]?.code).toBe(expected);
        expect(await code(s.transition({ id: c.id, action: 'activate', revision: 1, actor: A }))).toBe(expected);
      }
      zone = null;
      const c = await s.create({ definition: full({ name: 'TEST no zone' }), actor: A });
      expect(await code(s.transition({ id: c.id, action: 'submit', revision: 1, actor: A }))).toBe('campaigns.timezone_unset');
      // With the zone blank a customer read refuses by name instead of listing nothing.
      expect(await code(s.catalogue(ME))).toBe('campaigns.timezone_unset');
      expect(await code(s.myCampaigns(ME))).toBe('campaigns.timezone_unset');
      expect(await code(s.join({ campaignId: c.id, accountId: ME }))).toBe('campaigns.timezone_unset');
      const gate = await s.validate({ id: (await s.create({ definition: { name: 'TEST empty', type: 'task' }, actor: A })).id });
      expect(gate.missing.map((m) => m.code)).toEqual([
        'campaigns.budget_unset',
        'campaigns.rules_unset',
        'campaigns.time_frame_unset',
        'campaigns.timezone_unset',
        'campaigns.reward_unset',
      ]);
    });

    it('a campaign time zone left blank by the builder refuses activation; only the platform zone is accepted', async () => {
      const s = service();
      const c = await s.create({ definition: full({ timeZone: null }), actor: A });
      expect(c).toMatchObject({ timeZone: null, timeZoneBlank: true });
      expect((await s.validate({ id: c.id })).missing.map((m) => m.code)).toEqual(['campaigns.timezone_unset']);
      expect(await code(s.transition({ id: c.id, action: 'submit', revision: 1, actor: A }))).toBe('campaigns.timezone_unset');
      expect(await code(s.update({ id: c.id, revision: 1, definition: full({ timeZone: 'Europe/Berlin' }), actor: A }))).toBe(
        'campaigns.timezone_not_platform',
      );
      const picked = await s.update({ id: c.id, revision: 1, definition: full({ timeZone: 'UTC' }), actor: A });
      expect(picked.timeZone).toBe('UTC');
      expect((await s.validate({ id: c.id })).missing).toEqual([]);
      // A caller that sends no zone reads the platform zone, as before the builder.
      expect((await s.create({ definition: full({ name: 'TEST no zone sent' }), actor: A })).timeZone).toBe('UTC');
      zone = null;
      expect(await code(s.create({ definition: full({ name: 'TEST zone without platform', timeZone: 'UTC' }), actor: A }))).toBe(
        'campaigns.timezone_unset',
      );
    });

    it('refuses malformed values when they arrive: numbers on the wire, a bad type, a bad window, exclusions', async () => {
      const s = service();
      const make = (over: Partial<CampaignDefinitionInput>) => s.create({ definition: full(over), actor: A });
      expect(await code(make({ budget: { asset: 'USDT', limit: 1000 } }))).toBe('campaigns.number_on_wire');
      expect(await code(make({ reward: { asset: 'USDT', amount: 10 } }))).toBe('campaigns.number_on_wire');
      expect(await code(make({ budget: { asset: 'USDT', limit: '0' } }))).toBe('campaigns.budget_unset');
      expect(await code(make({ reward: { asset: 'USDT', amount: '1e3' } }))).toBe('campaigns.reward_unset');
      expect(await code(make({ type: 'lottery' }))).toBe('campaign.type_unknown');
      expect(await code(make({ startsAt: '2026-10-24T11:00:00' }))).toBe('campaigns.timezone_unset');
      expect(await code(make({ endsAt: '2026-10-24T10:00:00Z' }))).toBe('campaigns.window_invalid');
      expect(await code(make({ hours: { from: '18:00', to: '09:00' } }))).toBe('campaigns.window_invalid');
      // Identity holds no market-maker or staff mark, so neither can be excluded yet.
      const rules = (exclusions: ParticipationRules['exclusions']) =>
        make({ participation: { exclusions, regionScope: 'platform', restrictedRegions: null } });
      expect(await code(rules(['market_maker']))).toBe('campaigns.eligibility_unwired');
      expect(await code(rules(['business', 'staff']))).toBe('campaigns.eligibility_unwired');
    });

    it('a listed campaign with a blank region list cannot go live; rules are stored normalised', async () => {
      const s = service();
      const blank = await s.create({
        definition: full({ name: 'TEST blank list', participation: { exclusions: [], regionScope: 'listed', restrictedRegions: [] } }),
        actor: A,
      });
      expect(blank.participation).toEqual({ exclusions: [], regionScope: 'listed', restrictedRegions: null });
      expect((await s.validate({ id: blank.id })).missing).toEqual([{ code: 'campaigns.region_list_unset', field: 'restrictedRegions' }]);
      expect(await code(s.transition({ id: blank.id, action: 'submit', revision: 1, actor: A }))).toBe('campaigns.region_list_unset');
      const listed = await s.create({
        definition: full({
          name: 'TEST listed',
          participation: {
            exclusions: ['institution', 'business', 'business'],
            regionScope: 'listed',
            restrictedRegions: ['US', 'FR', 'US'],
          },
        }),
        actor: A,
      });
      expect(listed.participation).toEqual({
        exclusions: ['business', 'institution'],
        regionScope: 'listed',
        restrictedRegions: ['FR', 'US'],
      });
      expect((await s.validate({ id: listed.id })).missing).toEqual([]);
      // A platform campaign drops a stray list.
      const platform = await s.create({
        definition: full({ name: 'TEST platform', participation: { exclusions: [], regionScope: 'platform', restrictedRegions: ['FR'] } }),
        actor: A,
      });
      expect(platform.participation?.restrictedRegions).toBeNull();
    });

    it('review requests sent at once for one account make one review, and none of them raises (#6337, #6398)', async () => {
      const s = service();
      const c = await live({
        name: 'TEST no business, many at once',
        participation: { exclusions: ['business'], regionScope: 'platform', restrictedRegions: null },
      });
      for (let round = 0; round < 5; round += 1) {
        const accountId = `account-firm-race-${round}`;
        people.set(accountId, who({ accountType: 'business' }));
        const answers = await Promise.all(Array.from({ length: 8 }, () => s.requestReview({ campaignId: c.id, accountId })));
        expect(answers.filter((a) => a.created)).toHaveLength(1);
        for (const a of answers) expect(a.review).toEqual(answers[0]!.review);
      }
      const [count] = await db!.sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM campaigns.eligibility_reviews WHERE campaign_id = ${c.id}`;
      expect(count?.n).toBe(5);
    });

    it('an excluded account kind reads not_eligible, cannot join, and may ask for one review', async () => {
      const s = service();
      const c = await live({
        name: 'TEST no business',
        participation: { exclusions: ['business'], regionScope: 'platform', restrictedRegions: null },
      });
      people.set('account-firm', who({ accountType: 'business' }));
      const page = await s.get({ id: c.id, accountId: 'account-firm' });
      expect(page.eligibility).toEqual({ state: 'not_eligible', review: null });
      expect(await code(s.join({ campaignId: c.id, accountId: 'account-firm' }))).toBe('campaigns.not_eligible');
      const [one, two] = await Promise.all([
        s.requestReview({ campaignId: c.id, accountId: 'account-firm' }),
        s.requestReview({ campaignId: c.id, accountId: 'account-firm' }),
      ]);
      expect([one.created, two.created].sort()).toEqual([false, true]);
      expect(two.review).toEqual(one.review);
      const [count] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.eligibility_reviews`;
      expect(count?.n).toBe(1);
      const [row] = await db!.sql<{ review_key: string; reason: string }[]>`SELECT review_key, reason FROM campaigns.eligibility_reviews`;
      expect(row).toEqual({ review_key: reviewKeyOf(c.id, 'account-firm'), reason: 'not_eligible' });
      expect((await s.get({ id: c.id, accountId: 'account-firm' })).eligibility?.review).toEqual({ requestedAt: one.review.requestedAt });
      // An individual account takes part; it has nothing to review.
      expect((await s.get({ id: c.id, accountId: ME })).eligibility).toEqual({ state: 'eligible', review: null });
      expect(await code(s.requestReview({ campaignId: c.id, accountId: ME }))).toBe('campaigns.review_not_needed');
      expect((await s.join({ campaignId: c.id, accountId: ME })).created).toBe(true);
      // Once joined, the page does not ask identity again.
      identityReads = 0;
      expect((await s.get({ id: c.id, accountId: ME })).eligibility).toBeNull();
      expect((await s.join({ campaignId: c.id, accountId: ME })).created).toBe(false);
      expect(identityReads).toBe(0);
      // Once the campaign has ended there is nothing to review, and identity is not asked.
      await s.transition({ id: c.id, action: 'end', revision: 1, actor: A });
      people.set('account-firm-2', who({ accountType: 'business' }));
      expect((await s.get({ id: c.id, accountId: 'account-firm-2' })).eligibility).toBeNull();
      expect(await code(s.requestReview({ campaignId: c.id, accountId: 'account-firm-2' }))).toBe('campaign.not_active');
      expect(identityReads).toBe(0);
      // Institutions, and frozen accounts, are left out too.
      const noInst = await live({
        name: 'TEST no institutions',
        participation: { exclusions: ['institution'], regionScope: 'platform', restrictedRegions: null },
      });
      people.set('account-inst', who({ kycTier: 'institutional' }));
      people.set('account-frozen', who({ status: 'frozen' }));
      expect(await code(s.join({ campaignId: noInst.id, accountId: 'account-inst' }))).toBe('campaigns.not_eligible');
      expect(await code(s.join({ campaignId: noInst.id, accountId: 'account-frozen' }))).toBe('campaigns.not_eligible');
    });

    it('a restricted region, or no region recorded, reads region_blocked with one answer for everyone', async () => {
      const s = service();
      const c = await live({ name: 'TEST region', participation: { exclusions: [], regionScope: 'listed', restrictedRegions: ['FR'] } });
      people.set('account-fr1', who({ region: 'FR' }));
      people.set('account-fr2', who({ region: 'FR' }));
      people.set('account-none', who({ region: null }));
      for (const id of ['account-fr1', 'account-fr2', 'account-none']) {
        expect((await s.get({ id: c.id, accountId: id })).eligibility?.state).toBe('region_blocked');
        expect(await code(s.join({ campaignId: c.id, accountId: id }))).toBe('campaigns.region_blocked');
      }
      expect((await s.requestReview({ campaignId: c.id, accountId: 'account-fr1' })).created).toBe(true);
      expect((await s.join({ campaignId: c.id, accountId: ME })).created).toBe(true);
    });

    it('identity not answering is unread, never eligible; a campaign open to everyone never asks it', async () => {
      const s = service();
      const ruled = await live({
        name: 'TEST ruled',
        participation: { exclusions: ['business'], regionScope: 'platform', restrictedRegions: null },
      });
      expect((await s.get({ id: ruled.id, accountId: 'account-unknown' })).eligibility?.state).toBe('unread');
      expect(await code(s.join({ campaignId: ruled.id, accountId: 'account-unknown' }))).toBe('campaigns.participant_unread');
      expect(await code(s.requestReview({ campaignId: ruled.id, accountId: 'account-unknown' }))).toBe('campaigns.participant_unread');
      const [count] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.participations`;
      expect(count?.n).toBe(0);
      const open = await live({ name: 'TEST open' });
      identityReads = 0;
      expect((await s.get({ id: open.id, accountId: 'account-unknown' })).eligibility).toEqual({ state: 'eligible', review: null });
      expect((await s.join({ campaignId: open.id, accountId: 'account-unknown' })).created).toBe(true);
      expect(identityReads).toBe(0);
    });

    it('a business name is unique among campaigns that are not archived; the same draft again comes back', async () => {
      const s = service();
      const first = await s.create({ definition: full(), actor: A });
      expect((await s.create({ definition: full(), actor: A })).id).toBe(first.id);
      // The same name with a different definition is not a lost reply.
      expect(await code(s.create({ definition: full({ budget: { asset: 'USDT', limit: '5000' } }), actor: A }))).toBe(
        'campaign.name_taken',
      );
      expect(await code(s.create({ definition: full({ name: 'test CAMPAIGN' }), actor: B }))).toBe('campaign.name_taken');
      await s.transition({ id: first.id, action: 'archive', revision: 1, actor: A });
      expect((await s.create({ definition: full(), actor: B })).id).not.toBe(first.id);
    });

    it('one person asks, a different person approves; activation needs the approval', async () => {
      const s = service();
      const c = await s.create({ definition: full(), actor: A });
      expect(await code(s.transition({ id: c.id, action: 'activate', revision: 1, actor: A }))).toBe('campaigns.approval_required');
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 1, actor: B }))).toBe('campaign.invalid_transition');
      await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
      expect(await code(s.transition({ id: c.id, action: 'activate', revision: 1, actor: B }))).toBe('campaigns.approval_required');
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 1, actor: A }))).toBe('campaigns.second_person_required');
      // The database refuses it too.
      await expect(db!.sql`UPDATE campaigns.campaigns SET approved_by = submitted_by WHERE id = ${c.id}`).rejects.toThrow(
        /campaigns_second_person_ck/,
      );
      const approved = await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
      expect(approved).toMatchObject({ state: 'approved', submittedBy: A, approvedBy: B });
      // The same move again returns the stored campaign.
      expect((await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B })).state).toBe('approved');
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 2, actor: B }))).toBe('campaign.revision_conflict');
      // The same approval sent again by anyone else still refuses.
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 1, actor: A }))).toBe('campaigns.second_person_required');
      expect((await s.transition({ id: c.id, action: 'activate', revision: 1, actor: A })).state).toBe('active');
      // Past approval an edit is a change at the next revision, beside the live one (J-campaigns-16 #9).
      expect((await s.update({ id: c.id, revision: 1, definition: full({ rules: 'changed' }), actor: A })).pendingChange?.revision).toBe(2);
    });

    it('whoever wrote the draft cannot approve it, even when someone else asked', async () => {
      const s = service();
      const c = await s.create({ definition: full(), actor: A });
      await s.transition({ id: c.id, action: 'submit', revision: 1, actor: B });
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 1, actor: A }))).toBe('campaigns.second_person_required');
      await expect(
        db!.sql`UPDATE campaigns.campaigns SET approved_by = created_by, approved_revision = 1 WHERE id = ${c.id}`,
      ).rejects.toThrow(/campaigns_second_person_ck/);
      expect((await s.transition({ id: c.id, action: 'approve', revision: 1, actor: 'operator-c' })).approvedBy).toBe('operator-c');
    });

    it('each draft edit is a new revision, so a stale edit or move refuses', async () => {
      const s = service();
      const c = await s.create({ definition: full(), actor: A });
      const edited = await s.update({ id: c.id, revision: 1, definition: full({ rules: 'TEST edited' }), actor: A });
      expect(edited).toMatchObject({ revision: 2, rules: 'TEST edited' });
      expect(await code(s.update({ id: c.id, revision: 1, definition: full({ rules: 'TEST stale' }), actor: B }))).toBe(
        'campaign.revision_conflict',
      );
      expect(await code(s.transition({ id: c.id, action: 'submit', revision: 1, actor: A }))).toBe('campaign.revision_conflict');
      expect((await s.transition({ id: c.id, action: 'submit', revision: 2, actor: A })).state).toBe('pending_approval');
    });

    it('moves out of order refuse; an active campaign cannot be archived', async () => {
      const s = service();
      const c = await live();
      expect(await code(s.transition({ id: c.id, action: 'close', revision: 1, actor: A }))).toBe('campaign.invalid_transition');
      expect(await code(s.transition({ id: c.id, action: 'submit', revision: 1, actor: A }))).toBe('campaign.invalid_transition');
      expect(await code(s.transition({ id: c.id, action: 'archive', revision: 1, actor: A }))).toBe('campaign.archive_active');
      await s.transition({ id: c.id, action: 'end', revision: 1, actor: A });
      expect((await s.transition({ id: c.id, action: 'close', revision: 1, actor: A })).state).toBe('closed');
      expect((await s.transition({ id: c.id, action: 'archive', revision: 1, actor: A })).state).toBe('archived');
      await expect(s.get({ id: c.id, accountId: ME })).rejects.toThrow(/No such campaign/);
    });

    it('a campaign that starts later is scheduled, then active from its start time, then ended', async () => {
      const c = await live({ startsAt: '2026-10-25T00:00:00Z', endsAt: '2026-10-26T00:00:00Z' });
      expect(c.state).toBe('scheduled');
      expect(await code(service().join({ campaignId: c.id, accountId: ME }))).toBe('campaign.not_active');
      now = new Date('2026-10-25T00:00:00Z');
      expect((await service().get({ id: c.id, accountId: ME })).state).toBe('active');
      expect((await service().join({ campaignId: c.id, accountId: ME })).created).toBe(true);
      now = new Date('2026-10-26T00:00:00Z');
      expect((await service().get({ id: c.id, accountId: ME })).state).toBe('ended');
      // My join again after the end returns my participation; a new one refuses.
      expect((await service().join({ campaignId: c.id, accountId: ME })).created).toBe(false);
      expect(await code(service().join({ campaignId: c.id, accountId: 'account-late' }))).toBe('campaign.not_active');
      expect((await service().catalogue(ME)).campaigns).toEqual([]);
    });

    it('an edit of a live campaign is revision n+1 beside it; a second person puts it live; joins keep their revision', async () => {
      const s = service();
      const c = await live();
      expect((await s.join({ campaignId: c.id, accountId: ME })).participation.revision).toBe(1);
      // A stale revision, a new type or a taken name refuse; the live row is untouched.
      expect(await code(s.update({ id: c.id, revision: 2, definition: full({ rules: 'TEST v2' }), actor: A }))).toBe(
        'campaign.revision_conflict',
      );
      expect(await code(s.update({ id: c.id, revision: 1, definition: full({ type: 'voucher' }), actor: A }))).toBe('campaign.type_locked');
      const changed = await s.update({
        id: c.id,
        revision: 1,
        definition: full({ rules: 'TEST v2', reward: { asset: 'USDT', amount: '12' } }),
        actor: A,
      });
      expect(changed).toMatchObject({
        revision: 1,
        rules: 'TEST rules',
        state: 'active',
        pendingChange: { revision: 2, state: 'draft', createdBy: A },
      });
      expect(changed.pendingChange?.definition).toMatchObject({ rules: 'TEST v2', reward: { asset: 'USDT', amount: '12' } });
      // Editing the change again is the next revision; the old one is gone.
      const again = await s.update({
        id: c.id,
        revision: 2,
        definition: full({ rules: 'TEST v3', reward: { asset: 'USDT', amount: '12' } }),
        actor: A,
      });
      expect(again.pendingChange).toMatchObject({ revision: 3, state: 'draft' });
      // A blank in the change is what the check names, and what refuses its approval request.
      await s.update({ id: c.id, revision: 3, definition: full({ rules: 'TEST v4', budget: null }), actor: A });
      expect((await s.validate({ id: c.id })).missing.map((m) => m.code)).toEqual(['campaigns.budget_unset']);
      expect(await code(s.transition({ id: c.id, action: 'submit', revision: 4, actor: A }))).toBe('campaigns.budget_unset');
      await s.update({ id: c.id, revision: 4, definition: full({ rules: 'TEST v5', reward: { asset: 'USDT', amount: '12' } }), actor: A });
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 5, actor: B }))).toBe('campaign.invalid_transition');
      expect((await s.transition({ id: c.id, action: 'submit', revision: 5, actor: A })).pendingChange?.state).toBe('pending_approval');
      expect(await code(s.transition({ id: c.id, action: 'pause', revision: 5, actor: A }))).toBe('campaign.invalid_transition');
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 5, actor: A }))).toBe('campaigns.second_person_required');
      const out = await s.transition({ id: c.id, action: 'approve', revision: 5, actor: B });
      expect(out).toMatchObject({
        revision: 5,
        rules: 'TEST v5',
        reward: { amount: '12' },
        state: 'active',
        approvedBy: B,
        pendingChange: null,
      });
      // The same approval again returns the campaign; my join still names revision 1; a new join takes revision 5.
      expect((await s.transition({ id: c.id, action: 'approve', revision: 5, actor: B })).revision).toBe(5);
      expect((await s.join({ campaignId: c.id, accountId: ME })).participation.revision).toBe(1);
      people.set('account-new', who());
      expect((await s.join({ campaignId: c.id, accountId: 'account-new' })).participation.revision).toBe(5);
      const history = await db!.sql<{ revision: number; approved_by: string }[]>`
        SELECT revision, approved_by FROM campaigns.campaign_revisions WHERE campaign_id = ${c.id} ORDER BY revision`;
      expect(history.map((h) => [h.revision, h.approved_by])).toEqual([
        [1, B],
        [5, B],
      ]);
      // Moves on the live campaign use its live revision; archive still refuses.
      expect(await code(s.transition({ id: c.id, action: 'archive', revision: 5, actor: A }))).toBe('campaign.archive_active');
    });

    it('a change goes live only on a running campaign, and only if its name is still free when it is approved', async () => {
      const s = service();
      const c = await live();
      await s.update({ id: c.id, revision: 1, definition: full({ rules: 'TEST v2' }), actor: A });
      await s.transition({ id: c.id, action: 'submit', revision: 2, actor: A });
      // Ended while the change waited: approving it would bring the campaign back, so it refuses.
      await s.transition({ id: c.id, action: 'end', revision: 1, actor: A });
      expect(await code(s.transition({ id: c.id, action: 'approve', revision: 2, actor: B }))).toBe('campaign.invalid_transition');
      expect((await s.listForOps()).find((x) => x.id === c.id)).toMatchObject({ state: 'ended', rules: 'TEST rules', revision: 1 });

      const d = await live({ name: 'TEST other' });
      await s.update({ id: d.id, revision: 1, definition: full({ name: 'TEST renamed' }), actor: A });
      await s.transition({ id: d.id, action: 'submit', revision: 2, actor: A });
      // Another campaign takes the name before the approval.
      await s.create({ definition: full({ name: 'TEST renamed' }), actor: A });
      expect(await code(s.transition({ id: d.id, action: 'approve', revision: 2, actor: B }))).toBe('campaign.name_taken');
    });

    it('a campaign that ended or waits for its first approval is not edited', async () => {
      const s = service();
      const c = await s.create({ definition: full(), actor: A });
      await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
      expect(await code(s.update({ id: c.id, revision: 1, definition: full({ rules: 'TEST x' }), actor: A }))).toBe('campaign.not_draft');
    });

    it('the rule library keeps each save as the next revision; a campaign holds a copy and every join is checked by it', async () => {
      const s = service();
      const tree: RuleGroup = { kind: 'group', op: 'and', parts: [{ kind: 'condition', field: 'accountType', is: 'individual' }] };
      const first = await s.saveRule({ name: 'TEST individuals', tree, actor: A });
      expect(first).toMatchObject({ name: 'TEST individuals', revision: 1, createdBy: A });
      // The same tree again is the same revision; a changed tree is the next one, under the name as first written.
      expect((await s.saveRule({ name: 'test INDIVIDUALS', tree, actor: B })).revision).toBe(1);
      const wider: RuleGroup = {
        kind: 'group',
        op: 'or',
        parts: [...tree.parts, { kind: 'condition', field: 'kycTier', atLeast: 'full' }],
      };
      expect(await s.saveRule({ name: 'test individuals', tree: wider, actor: B })).toMatchObject({
        name: 'TEST individuals',
        revision: 2,
      });
      expect((await s.listRules()).map((r) => [r.name, r.revision])).toEqual([['TEST individuals', 2]]);
      // A campaign's copy must be a library revision as stored.
      const rule = { name: 'TEST individuals', revision: 1, tree };
      const participation = { exclusions: [], regionScope: 'platform' as const, restrictedRegions: null };
      expect(
        await code(
          s.create({
            definition: full({ name: 'TEST forged', participation: { ...participation, rule: { ...rule, tree: wider } } }),
            actor: A,
          }),
        ),
      ).toBe('campaigns.rule_unknown');
      const c = await live({ participation: { ...participation, rule } });
      people.set('account-biz', who({ accountType: 'business' }));
      expect(await code(s.join({ campaignId: c.id, accountId: 'account-biz' }))).toBe('campaigns.not_eligible');
      expect((await s.join({ campaignId: c.id, accountId: ME })).created).toBe(true);
      // An edit of the library never reaches the campaign's copy.
      expect((await s.getForOps({ id: c.id })).participation?.rule?.revision).toBe(1);
    });

    it('earning rules are part of the definition: a known trigger and a formula in the grammar, one name each', async () => {
      const s = service();
      const rule = { name: 'TEST per fill', trigger: 'trade.fill.settled', minAmount: '10', formula: 'min(amount * 0.01, 5)' };
      const c = await s.create({ definition: full({ earning: [rule] }), actor: A });
      expect(c.earning).toEqual([rule]);
      expect(
        await code(s.update({ id: c.id, revision: 1, definition: full({ earning: [{ ...rule, formula: 'amount * * 2' }] }), actor: A })),
      ).toBe('campaigns.formula_invalid');
      expect(
        await code(
          s.update({ id: c.id, revision: 1, definition: full({ earning: [{ ...rule, trigger: 'trade.order.placed' }] }), actor: A }),
        ),
      ).toBe('campaigns.trigger_unknown');
      expect(
        await code(
          s.update({ id: c.id, revision: 1, definition: full({ earning: [rule, { ...rule, name: 'test PER fill' }] }), actor: A }),
        ),
      ).toBe('campaigns.earning_rule_name_taken');
      // A deposit rule reads only the names its trigger has.
      expect(
        await code(
          s.update({
            id: c.id,
            revision: 1,
            definition: full({ earning: [{ ...rule, trigger: 'pay.deposit_credit.posted', formula: 'fee' }] }),
            actor: A,
          }),
        ),
      ).toBe('campaigns.formula_invalid');
      // A live campaign's earning rules change only through its next revision.
      await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
      await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
      const changed = await s.update({ id: c.id, revision: 1, definition: full({ earning: [{ ...rule, formula: '2' }] }), actor: A });
      expect(changed.earning).toEqual([rule]);
      expect(changed.pendingChange?.definition.earning).toEqual([{ ...rule, formula: '2' }]);
    });

    it('a paused campaign cannot be archived either; one campaign reads by id at any age', async () => {
      const s = service();
      const c = await live();
      await s.transition({ id: c.id, action: 'pause', revision: 1, actor: A });
      expect(await code(s.transition({ id: c.id, action: 'archive', revision: 1, actor: A }))).toBe('campaign.archive_active');
      expect((await s.getForOps({ id: c.id })).state).toBe('paused');
      expect(await code(s.getForOps({ id: 'cmp_missing' }))).toBe('campaign.unknown');
    });

    it('a scheduled campaign cannot be archived (customers already see it); it can be ended before it starts', async () => {
      const s = service();
      const c = await live({ startsAt: '2026-10-25T00:00:00Z', endsAt: '2026-10-26T00:00:00Z' });
      expect(c.state).toBe('scheduled');
      expect(await code(s.transition({ id: c.id, action: 'archive', revision: 1, actor: A }))).toBe('campaign.archive_active');
      expect((await s.transition({ id: c.id, action: 'end', revision: 1, actor: A })).state).toBe('ended');
      expect((await s.transition({ id: c.id, action: 'archive', revision: 1, actor: A })).state).toBe('archived');
    });

    it('customers see published campaigns only, with the budget read from its counters', async () => {
      const s = service();
      await s.create({ definition: full({ name: 'TEST draft' }), actor: A });
      const c = await live();
      const out = await s.catalogue(ME);
      expect(out.campaigns.map((x) => x.id)).toEqual([c.id]);
      expect(out.campaigns[0]).toMatchObject({
        state: 'active',
        timeZone: 'UTC',
        budget: { asset: 'USDT', limit: '1000', left: '1000' },
        reward: { asset: 'USDT', amount: '10' },
        mine: null,
      });
      expect(JSON.stringify(out)).not.toContain(A);
    });

    it('joining twice is one participation under the business key; a paused campaign refuses a new join', async () => {
      const s = service();
      const c = await live();
      const [one, two] = await Promise.all([s.join({ campaignId: c.id, accountId: ME }), s.join({ campaignId: c.id, accountId: ME })]);
      expect([one.created, two.created].sort()).toEqual([false, true]);
      expect(one.participation.participationKey).toBe(participationKeyOf(c.id, ME));
      expect(two.participation).toEqual(one.participation);
      const [count] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.participations`;
      expect(count?.n).toBe(1);
      expect((await s.myCampaigns(ME)).campaigns.map((m) => m.campaign.id)).toEqual([c.id]);
      expect((await s.get({ id: c.id, accountId: ME })).mine).toEqual(one.participation);

      await s.transition({ id: c.id, action: 'pause', revision: 1, actor: A });
      expect(await code(s.join({ campaignId: c.id, accountId: 'account-other' }))).toBe('campaign.not_active');
      // Mine is kept while paused.
      expect((await s.join({ campaignId: c.id, accountId: ME })).created).toBe(false);
      await s.transition({ id: c.id, action: 'resume', revision: 1, actor: A });
      expect((await s.join({ campaignId: c.id, accountId: 'account-other' })).created).toBe(true);
    });

    it('a weekday or hour window in the platform time zone refuses a join outside it', async () => {
      const s = service();
      // NOW is Saturday 12:00 UTC.
      const weekdays = await live({ name: 'TEST weekdays', weekdays: [1, 2, 3, 4, 5] });
      expect(await code(s.join({ campaignId: weekdays.id, accountId: ME }))).toBe('campaign.outside_window');
      const hours = await live({ name: 'TEST hours', hours: { from: '13:00', to: '14:00' } });
      expect(await code(s.join({ campaignId: hours.id, accountId: ME }))).toBe('campaign.outside_window');
      const midnight = await live({ name: 'TEST to midnight', hours: { from: '11:00', to: '24:00' } });
      expect((await s.join({ campaignId: midnight.id, accountId: ME })).created).toBe(true);
      const inside = await live({ name: 'TEST inside', weekdays: [6], hours: { from: '12:00', to: '12:30' } });
      expect((await s.join({ campaignId: inside.id, accountId: ME })).created).toBe(true);
      // The same instant is Saturday 21:00 in Tokyo: outside the hour window there.
      zone = 'Asia/Tokyo';
      expect(await code(s.join({ campaignId: inside.id, accountId: 'account-tokyo' }))).toBe('campaign.outside_window');
    });

    it('the calendar lists every campaign with a time frame by start, archived ones left out', async () => {
      const s = service();
      const later = await live({ name: 'TEST later', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-02T00:00:00Z' });
      const sooner = await live({ name: 'TEST sooner' });
      await s.create({ definition: { name: 'TEST no frame', type: 'task' }, actor: A });
      const cal = await s.calendar();
      expect(cal.timeZone).toBe('UTC');
      expect(cal.entries.map((e) => e.id)).toEqual([sooner.id, later.id]);
    });

    it('every operator move and every join writes an audit row', async () => {
      const c = await live();
      await service().join({ campaignId: c.id, accountId: ME });
      const rows = await db!.sql<{ action: string }[]>`SELECT action FROM campaigns.audit_log WHERE target = ${c.id} ORDER BY id`;
      expect(rows.map((r) => r.action)).toEqual([
        'campaign.create',
        'campaign.submit',
        'campaign.approve',
        'campaign.activate',
        'campaign.join',
      ]);
    });
  });
}

describe('campaign eligibility', () => {
  it('names one generic reason per rule', () => {
    const rules = { exclusions: ['business' as const], regionScope: 'listed' as const, restrictedRegions: ['FR'] };
    expect(eligibilityOf(rules, null)).toBe('unread');
    expect(eligibilityOf(rules, who())).toBe('eligible');
    expect(eligibilityOf(rules, who({ accountType: 'business', region: 'FR' }))).toBe('not_eligible');
    expect(eligibilityOf(rules, who({ region: 'FR' }))).toBe('region_blocked');
    expect(eligibilityOf({ exclusions: [], regionScope: 'platform', restrictedRegions: null }, null)).toBe('eligible');
  });
});

describe('campaign clocks', () => {
  it('reads the weekday and hour in a time zone, and the state by the time frame', () => {
    expect(zonedClock(NOW, 'UTC')).toEqual({ weekday: 6, hhmm: '12:00' });
    expect(zonedClock(NOW, 'America/New_York')).toEqual({ weekday: 6, hhmm: '08:00' });
    const row = { state: 'scheduled' as const, starts_at: new Date('2026-10-25T00:00:00Z'), ends_at: new Date('2026-10-26T00:00:00Z') };
    expect(effectiveState(row, NOW)).toBe('scheduled');
    expect(effectiveState(row, new Date('2026-10-25T00:00:00Z'))).toBe('active');
    expect(effectiveState({ ...row, state: 'paused' }, new Date('2026-10-26T00:00:00Z'))).toBe('ended');
  });
});
