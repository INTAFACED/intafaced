import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignDefinitionInput } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService, effectiveState, participationKeyOf, zonedClock } from './campaigns.js';
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
const service = () => new CampaignService({ sql: db!.sql, timeZone: () => zone, now: () => now });

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
  participation: { exclusions: [], regionScope: 'platform' },
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
      expect((await s.catalogue(ME)).campaigns).toEqual([]);
      const gate = await s.validate({ id: (await s.create({ definition: { name: 'TEST empty', type: 'task' }, actor: A })).id });
      expect(gate.missing.map((m) => m.code)).toEqual([
        'campaigns.budget_unset',
        'campaigns.rules_unset',
        'campaigns.time_frame_unset',
        'campaigns.timezone_unset',
        'campaigns.reward_unset',
      ]);
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
      expect(await code(make({ participation: { exclusions: ['business'], regionScope: 'platform' } }))).toBe(
        'campaigns.eligibility_unwired',
      );
      expect(await code(make({ participation: { exclusions: [], regionScope: 'listed' } }))).toBe('campaigns.eligibility_unwired');
    });

    it('a business name is unique among campaigns that are not archived; the same draft again comes back', async () => {
      const s = service();
      const first = await s.create({ definition: full(), actor: A });
      expect((await s.create({ definition: full(), actor: A })).id).toBe(first.id);
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
      expect((await s.transition({ id: c.id, action: 'activate', revision: 1, actor: A })).state).toBe('active');
      expect(await code(s.update({ id: c.id, revision: 1, definition: full({ rules: 'changed' }), actor: A }))).toBe('campaign.not_draft');
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
      expect((await service().catalogue(ME)).campaigns).toEqual([]);
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
        budget: { asset: 'USDT', limit: '1000', reserved: '0', spent: '0', left: '1000' },
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
      const [{ n }] = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.participations`;
      expect(n).toBe(1);
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
