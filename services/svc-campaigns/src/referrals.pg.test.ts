import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignDefinitionInput, CampaignReferral } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import { ReferralService, quoteOf, tierMeets } from './referrals.js';

/**
 * Referral programmes and invitee progress against real Postgres (CM-referral-02, J-campaigns-06 #1 #2). No money moves
 * here: the invariant is that each invitee qualifies at most once, from their own counted events only.
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
const REFERRER = '00000000-0000-4000-8000-0000000000a1';
const FRIEND = '00000000-0000-4000-8000-0000000000b2';
const OTHER = '00000000-0000-4000-8000-0000000000c3';
const EARLY = '00000000-0000-4000-8000-0000000000d4';
const MARKET = '11111111-1111-4111-8111-111111111111';
const HOUR = 3_600_000;

const PROGRAMME: CampaignReferral = {
  sides: 'double',
  criteria: { verification: 'full', asset: 'USDT', depositMin: '20', tradeVolumeMin: '50', windowSeconds: 7 * 24 * 3600 },
  rewards: { referrer: { asset: 'USDT', amount: '1' }, referee: { asset: 'USDT', amount: '0.5' } },
};

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST referral ${(names += 1)}`,
  type: 'referral',
  rules: 'TEST referral rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '100' },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  referral: PROGRAMME,
  ...over,
});

const participants = { read: async () => null };
const campaigns = () => new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants });

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

let referrals: ReferralService;
let events = 0;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const attach = (userId: string, at = ago(60_000)) => referrals.onAttached({ userId, referrerId: REFERRER, attachedAt: at });
const verify = (userId: string, tier = 'full', eventId = `kyc-${(events += 1)}`) =>
  referrals.onVerified({ userId, tier, eventId, at: new Date().toISOString() });
const deposit = (userId: string, amount: string, depositId = `dep-${(events += 1)}`, asset = 'USDT') =>
  referrals.onDeposit({ userId, depositId, asset, amount, at: new Date().toISOString() });
const fill = (userId: string, quoteAmount: string, fillId = `fill-${(events += 1)}`) =>
  referrals.onFill({ userId, fillId, marketId: MARKET, quoteAmount, at: new Date().toISOString() });
const listed = async () => (await referrals.myInvitees({ referrerId: REFERRER })).invitees;

// Without Postgres (a laptop with none) the store's tests do not run; CI requires it above, so they always run there.
if (db)
  describe('referral programmes and invitee progress (CM-referral-02)', () => {
    beforeEach(async () => {
      await db!.sql`TRUNCATE campaigns.referral_events, campaigns.referral_invitees, campaigns.audit_log`;
      await db!.sql`DELETE FROM campaigns.campaign_revisions`;
      await db!.sql`DELETE FROM campaigns.campaigns`;
      referrals = new ReferralService({ sql: db!.sql, markets: { symbolOf: async () => 'BTC/USDT' } });
    });

    it('refuses to go live while a criterion or a side’s reward is blank, naming each', async () => {
      const s = campaigns();
      const blank: CampaignReferral = {
        sides: 'double',
        criteria: { verification: null, asset: 'USDT', depositMin: null, tradeVolumeMin: '50', windowSeconds: null },
        rewards: { referrer: { asset: 'USDT', amount: '1' }, referee: null },
      };
      const c = await s.create({ definition: definition({ referral: blank }), actor: A });
      const gate = await s.validate({ id: c.id });
      expect(gate.missing.map((m) => `${m.code}:${m.field}`)).toEqual(
        expect.arrayContaining([
          'campaigns.criteria_unset:verification',
          'campaigns.criteria_unset:depositMin',
          'campaigns.criteria_unset:qualifyWindow',
          'campaigns.reward_unset:refereeReward',
        ]),
      );
      expect(await code(s.transition({ id: c.id, action: 'submit', revision: 1, actor: A }))).toBe('campaigns.criteria_unset');
      const none = await s.create({ definition: definition({ referral: null }), actor: A });
      expect((await s.validate({ id: none.id })).missing.map((m) => m.code)).toContain('campaigns.criteria_unset');
    });

    it('takes a programme only on a referral campaign, and a single-sided one names no invitee reward', async () => {
      const s = campaigns();
      expect(await code(s.create({ definition: definition({ type: 'task', referral: PROGRAMME }), actor: A }))).toBe(
        'campaigns.referral_invalid',
      );
      expect(await code(s.create({ definition: definition({ referral: { ...PROGRAMME, sides: 'single' } }), actor: A }))).toBe(
        'campaigns.referral_invalid',
      );
    });

    it('lists each invitee once, under the programme live when they were attached, with no private detail', async () => {
      expect(await attach(EARLY)).toBe(true);
      const programme = await live();
      expect(await attach(FRIEND)).toBe(true);
      expect(await attach(FRIEND)).toBe(false);
      const list = await referrals.myInvitees({ referrerId: REFERRER });
      expect(list.total).toBe(2);
      expect(list.invitees.map((i) => [i.place, i.state, i.programme?.id ?? null])).toEqual([
        [1, 'no_programme', null],
        [2, 'in_progress', programme.id],
      ]);
      expect(list.invitees[1]!.steps).toEqual({ verified: false, deposited: false, traded: false });
      // The bounded summary: no id, handle or amount of the invitee appears anywhere in it.
      const text = JSON.stringify(list);
      for (const id of [FRIEND, EARLY]) expect(text.includes(id)).toBe(false);
      expect(Object.keys(list.invitees[1]!).sort()).toEqual(
        ['attachedAt', 'place', 'programme', 'qualifiedAt', 'state', 'steps', 'windowClosesAt'].sort(),
      );
      // Another referrer sees none of them.
      expect((await referrals.myInvitees({ referrerId: OTHER })).invitees).toEqual([]);
    });

    it('qualifies exactly once when the last step is done, and a redelivered event changes nothing', async () => {
      await live();
      await attach(FRIEND);
      await verify(FRIEND, 'basic'); // below the programme's tier: not counted
      expect((await listed())[0]!.steps.verified).toBe(false);
      await verify(FRIEND, 'full', 'kyc-full');
      await deposit(FRIEND, '15', 'dep-1');
      await deposit(FRIEND, '15', 'dep-1'); // the same deposit again
      expect((await listed())[0]!.steps).toEqual({ verified: true, deposited: false, traded: false });
      await deposit(FRIEND, '5', 'dep-2');
      await fill(FRIEND, '30', 'fill-1');
      expect((await listed())[0]!.state).toBe('in_progress');
      await fill(FRIEND, '20', 'fill-2');
      const [done] = await listed();
      expect(done!.state).toBe('qualified');
      expect(done!.steps).toEqual({ verified: true, deposited: true, traded: true });
      // Every event delivered again, and a later one: qualified stays at the same moment, written once.
      await verify(FRIEND, 'full', 'kyc-full');
      await deposit(FRIEND, '15', 'dep-1');
      await fill(FRIEND, '20', 'fill-2');
      await fill(FRIEND, '100', 'fill-3');
      const [again] = await listed();
      expect(again!.qualifiedAt).toBe(done!.qualifiedAt);
      const audits = await db!.sql`SELECT * FROM campaigns.audit_log WHERE action = 'campaign.referral.qualify'`;
      expect(audits.count).toBe(1);
    });

    it('counts nothing that is not the invitee’s own deposit or trade in the programme’s asset, inside the window', async () => {
      await live();
      await attach(FRIEND);
      await deposit(FRIEND, '100', 'dep-btc', 'BTC');
      await deposit(OTHER, '100', 'dep-other'); // not an invitee
      expect((await listed())[0]!.steps.deposited).toBe(false);
      // A fill on a market quoted in another asset does not count.
      referrals = new ReferralService({ sql: db!.sql, markets: { symbolOf: async () => 'ETH/BTC' } });
      await fill(FRIEND, '1000');
      expect((await listed())[0]!.steps.traded).toBe(false);
      // An event from before the attach does not count.
      await referrals.onDeposit({ userId: FRIEND, depositId: 'dep-before', asset: 'USDT', amount: '100', at: ago(HOUR) });
      expect((await listed())[0]!.steps.deposited).toBe(false);
    });

    it('shows the window closed for an invitee who did not finish in time', async () => {
      await live({ referral: { ...PROGRAMME, criteria: { ...PROGRAMME.criteria, windowSeconds: 60 } } });
      await attach(FRIEND, ago(2 * 60_000));
      await verify(FRIEND);
      const [late] = await listed();
      expect(late!.state).toBe('window_closed');
      expect(late!.steps.verified).toBe(false);
    });

    it('keeps the terms an invitee was attached under', async () => {
      const c = await live();
      await attach(FRIEND);
      const [row] = await db!.sql<{ revision: number; terms: CampaignReferral }[]>`
      SELECT revision, terms FROM campaigns.referral_invitees WHERE invitee_id = ${FRIEND}`;
      expect(row).toMatchObject({ revision: c.revision, terms: PROGRAMME });
    });
  });

describe('referral helpers', () => {
  it('reads tiers and quote assets', () => {
    expect(tierMeets('institutional', 'full')).toBe(true);
    expect(tierMeets('basic', 'full')).toBe(false);
    expect(tierMeets('basic', null)).toBe(false);
    expect(quoteOf('BTC/USDT')).toBe('USDT');
    expect(quoteOf(null)).toBeNull();
  });
});
