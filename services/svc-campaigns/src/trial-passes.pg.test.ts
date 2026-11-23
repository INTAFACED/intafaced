import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, TrialPassGrant } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { CampaignsError } from './codes.js';
import { TrialPassService, type TierPassDoor } from './trial-passes.js';

/**
 * A VIP trial pass campaign (CM-vip-tiers-01, J-campaigns-14 #2 #3) on Postgres: it activates with its tier and span set
 * and no budget or reward (it pays nothing), refuses activation while either is blank, and grants its pass through
 * svc-trade's door to one account with the operator's reason audited. A campaign that is not a live trial pass, or a
 * door that refuses or cannot be reached, grants nothing and says why. TEST tiers and people only.
 */
const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL is required');
}
const available = await postgresAvailable(adminUrl);
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
const ANN = '00000000-0000-4000-8000-0000000000a1';
const HOUR = 3_600_000;

const participants = {
  read: async (userId: string): Promise<CampaignParticipant> => ({
    userId,
    accountType: 'individual',
    region: 'DE',
    status: 'active',
    kycTier: 'full',
  }),
};

let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST trial pass ${(names += 1)}`,
  type: 'trial_pass',
  rules: 'TEST rules: a VIP trial pass at the TEST tier for two minutes, granted as a reward.',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
  trialPass: { tierId: 'test-vip-1', seconds: 120 },
  ...over,
});

let campaigns: CampaignService;
let sent: Parameters<TierPassDoor['grant']>[0][];
let answer: Awaited<ReturnType<TierPassDoor['grant']>> | null;
const door: TierPassDoor = {
  grant: async (input) => {
    sent.push(input);
    if (answer) return answer;
    const pass = {
      passKey: `trial-pass:${input.campaignId}:${input.userId}`,
      campaignId: input.campaignId,
      tierId: input.tierId,
      startsAt: '2026-11-16T03:00:00.000Z',
      endsAt: '2026-11-16T03:02:00.000Z',
      grantedAt: '2026-11-16T03:00:00.000Z',
      endedAt: null,
      endReason: null,
      replacedBy: null,
    };
    return { ok: true, grant: { pass, granted: true, replaced: null } satisfies TrialPassGrant };
  },
};

beforeEach(async () => {
  if (!db) return;
  await db.sql`TRUNCATE campaigns.campaigns, campaigns.participations, campaigns.audit_log CASCADE`;
  campaigns = new CampaignService({ sql: db.sql, timeZone: () => 'UTC', participants });
  sent = [];
  answer = null;
});

async function live(over: Partial<CampaignDefinitionInput> = {}) {
  const c = await campaigns.create({ definition: definition(over), actor: A });
  await campaigns.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await campaigns.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  await campaigns.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
  return c;
}

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'granted',
    (err: unknown) => (err instanceof CampaignsError ? err.code : String(err)),
  );

describe.skipIf(!available)('trial pass campaigns', () => {
  it('activate with the tier and span set and no budget or reward; blank terms refuse by name', async () => {
    const c = await live();
    expect((await campaigns.getForOps({ id: c.id })).trialPass).toEqual({ tierId: 'test-vip-1', seconds: 120 });
    const blank = await campaigns.create({ definition: definition({ trialPass: { tierId: null, seconds: null } }), actor: A });
    const refused = await codeOf(campaigns.transition({ id: blank.id, action: 'submit', revision: 1, actor: A }));
    expect(refused).toBe('campaigns.trial_pass_unset');
    await expect(campaigns.create({ definition: definition({ type: 'pool' }), actor: A })).rejects.toMatchObject({
      code: 'campaigns.trial_pass_invalid',
    });
  });

  it("grants the live campaign's pass to one account through svc-trade's door, with the operator's reason audited", async () => {
    const c = await live();
    const grant = await new TrialPassService({ sql: db!.sql, door }).grant(c.id, ANN, { actor: A, reason: 'TEST reward for the trial' });
    expect(sent).toEqual([{ userId: ANN, campaignId: c.id, tierId: 'test-vip-1', seconds: 120, grantedBy: A }]);
    expect(grant.pass.passKey).toBe(`trial-pass:${c.id}:${ANN}`);
    const [row] = await db!.sql<{ actor: string; detail: { accountId: string; reason: string } }[]>`
      SELECT actor, detail FROM campaigns.audit_log WHERE action = 'campaign.trial_pass.grant_requested' AND target = ${c.id}`;
    expect(row).toMatchObject({ actor: A, detail: { accountId: ANN, reason: 'TEST reward for the trial' } });
  });

  it('grants nothing for a campaign that is not a live trial pass, or with no door', async () => {
    const service = new TrialPassService({ sql: db!.sql, door });
    expect(await codeOf(service.grant('cmp_none', ANN, { actor: A, reason: 'TEST' }))).toBe('campaign.unknown');
    const draft = await campaigns.create({ definition: definition(), actor: A });
    expect(await codeOf(service.grant(draft.id, ANN, { actor: A, reason: 'TEST' }))).toBe('campaign.unknown');
    const pool = await live({
      type: 'pool',
      trialPass: null,
      budget: { asset: 'USDC', limit: '10' },
      pool: { activityAsset: 'USDC', dailySlice: '1', perUserCap: '0.5', minBalance: '10', daySeconds: 600 },
    });
    expect(await codeOf(service.grant(pool.id, ANN, { actor: A, reason: 'TEST' }))).toBe('campaigns.not_trial_pass');
    const ended = await live({
      startsAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      endsAt: new Date(Date.now() + 1000).toISOString(),
    });
    const later = new TrialPassService({ sql: db!.sql, door, now: () => new Date(Date.now() + 5000) });
    expect(await codeOf(later.grant(ended.id, ANN, { actor: A, reason: 'TEST' }))).toBe('campaign.not_active');
    const c = await live();
    expect(await codeOf(new TrialPassService({ sql: db!.sql, door: null }).grant(c.id, ANN, { actor: A, reason: 'TEST' }))).toBe(
      'campaigns.trial_pass_unreachable',
    );
    expect(sent).toEqual([]);
  });

  it('says svc-trade refused, or could not be reached, and never assumes a pass', async () => {
    const c = await live();
    const service = new TrialPassService({ sql: db!.sql, door });
    answer = { ok: false, code: 'trade.tier_pass_no_programme', unreachable: false };
    const refused = service.grant(c.id, ANN, { actor: A, reason: 'TEST' });
    await expect(refused).rejects.toMatchObject({ code: 'campaigns.trial_pass_refused' });
    await expect(refused).rejects.toThrow(/trade\.tier_pass_no_programme/);
    answer = { ok: false, code: 'trade.unreachable', unreachable: true };
    expect(await codeOf(service.grant(c.id, ANN, { actor: A, reason: 'TEST' }))).toBe('campaigns.trial_pass_unreachable');
  });
});
