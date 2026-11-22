import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignParticipant } from '@intafaced/contracts';
import { DRAW_OWNER_QUESTION, type CampaignDefinitionInput, type CampaignDraw } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import type { CompetitionFill } from './competitions.js';
import { DrawService, drawWinners, entrantOf, entryHashOf, verifyDraw } from './draws.js';

/**
 * Lucky draws (J-campaigns-12, CM-promotions-events-02) against real Postgres. The money invariant of this version: a
 * draw never runs while the owner decision is open, so no draw ever writes a reward intent, and running or settling it
 * refuses `owner.decision`.
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
const BEN = '00000000-0000-4000-8000-0000000000b2';
const HOUR = 3_600_000;

let tiers: Map<string, CampaignParticipant['kycTier'] | 'unread'>;
const participants = {
  read: async (userId: string): Promise<CampaignParticipant | null> => {
    const tier = tiers.get(userId) ?? 'basic';
    if (tier === 'unread') return null;
    return { userId, accountType: 'individual', region: 'DE', status: 'active', kycTier: tier };
  },
};

const TERMS: CampaignDraw = {
  chancesPerFill: 2,
  caps: [
    { userType: 'none', cap: 0 },
    { userType: 'basic', cap: 5 },
    { userType: 'full', cap: 10 },
    { userType: 'institutional', cap: 10 },
  ],
  prizes: [
    { rank: 1, amount: '5' },
    { rank: 2, amount: '3' },
  ],
};
let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST draw ${(names += 1)}`,
  type: 'draw',
  rules: 'TEST rules: trade on the venue through INTAFACED to earn chances.',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '10' },
  limits: { perCustomer: { count: 1, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: null,
  draw: TERMS,
  ...over,
});

let campaigns: CampaignService;
let fills: Map<string, CompetitionFill[] | 'unread'>;
let draws: DrawService;

const fill = (fillId: string, over: Partial<CompetitionFill> = {}): CompetitionFill => ({
  fillId,
  venueAccount: '0xowner',
  symbol: 'BTC-USDC',
  quoteAsset: 'USDC',
  notional: '100',
  builderFee: '0.03',
  filledAt: new Date(Date.now() - 1_000).toISOString(),
  ...over,
});

beforeEach(async () => {
  if (!db) return;
  await db.sql`TRUNCATE campaigns.campaigns, campaigns.participations, campaigns.reward_intents, campaigns.draw_seeds,
    campaigns.draw_reads, campaigns.draw_chances, campaigns.audit_log CASCADE`;
  tiers = new Map();
  campaigns = new CampaignService({ sql: db.sql, timeZone: () => 'UTC', participants });
  fills = new Map();
  draws = new DrawService({
    sql: db.sql,
    participants,
    fills: {
      ourFills: async (userId) => {
        const list = fills.get(userId) ?? [];
        return list === 'unread'
          ? { unread: 'trade.venue.venue_down' }
          : { venueId: 'test-venue', asOf: new Date().toISOString(), fills: list };
      },
    },
  });
});

async function live(over: Partial<CampaignDefinitionInput> = {}) {
  const c = await campaigns.create({ definition: definition(over), actor: A });
  await campaigns.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await campaigns.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  await campaigns.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
  return c;
}

/** Joined a minute ago, so a TEST fill stamped a second ago falls after the join. */
async function enter(campaignId: string, accountId: string) {
  await campaigns.join({ campaignId, accountId });
  await db!.sql`UPDATE campaigns.participations SET created_at = created_at - interval '1 minute'
    WHERE campaign_id = ${campaignId} AND account_id = ${accountId}`;
}

const intentCount = async () => (await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM campaigns.reward_intents`)[0]!.n;

describe('the winner function anyone can recompute', () => {
  const seed = 'ab'.repeat(32);
  const entries = [
    { entrant: entrantOf(ANN), chances: 3 },
    { entrant: entrantOf(BEN), chances: 1 },
    { entrant: entrantOf('00000000-0000-4000-8000-0000000000c3'), chances: 0 },
  ];

  it('is the same every time, one place per entrant, and never picks an entrant with no chance', () => {
    const winners = drawWinners(seed, entries, 3);
    expect(drawWinners(seed, entries, 3)).toEqual(winners);
    expect(winners).toHaveLength(2);
    expect(new Set(winners.map((w) => w.entrant)).size).toBe(2);
    expect(winners.map((w) => w.entrant)).not.toContain(entries[2]!.entrant);
  });

  it('checks against the commitment and entry hash; a changed entry list fails', () => {
    const commitment = createHash('sha256').update(seed).digest('hex');
    const entryHash = entryHashOf(entries);
    const winners = drawWinners(seed, entries, 2);
    expect(verifyDraw({ seed, commitment, entryHash, entries, winners })).toBe(true);
    const changed = [{ ...entries[0]!, chances: 4 }, ...entries.slice(1)];
    expect(verifyDraw({ seed, commitment, entryHash, entries: changed, winners })).toBe(false);
    expect(verifyDraw({ seed: 'cd'.repeat(32), commitment, entryHash, entries, winners })).toBe(false);
  });
});

describe.skipIf(!available)('draws (J-campaigns-12)', () => {
  it('refuses to go live with a blank chances per fill, a blank cap for any user type, no prize table or a short budget', async () => {
    const gaps = async (over: Partial<CampaignDefinitionInput>) => {
      const c = await campaigns.create({ definition: definition(over), actor: A });
      return (await campaigns.validate({ id: c.id })).missing.map((m) => `${m.code}:${m.field}`);
    };
    expect(await gaps({})).toEqual([]);
    expect(await gaps({ draw: { ...TERMS, chancesPerFill: null } })).toEqual(['campaigns.draw_unset:chancesPerFill']);
    expect(await gaps({ draw: { ...TERMS, caps: TERMS.caps.slice(1) } })).toEqual(['campaigns.draw_unset:cap.none']);
    expect(await gaps({ draw: { ...TERMS, caps: TERMS.caps.map((c) => (c.userType === 'full' ? { ...c, cap: null } : c)) } })).toEqual([
      'campaigns.draw_unset:cap.full',
    ]);
    expect(await gaps({ draw: { ...TERMS, prizes: [] } })).toEqual(['campaigns.reward_unset:prizes']);
    expect(await gaps({ budget: { asset: 'USDC', limit: '7' } })).toEqual(['campaigns.prize_pool_short:budget']);
    expect(await gaps({ draw: null })).toEqual(['campaigns.draw_unset:draw']);
    await expect(campaigns.create({ definition: definition({ type: 'task', draw: TERMS }), actor: A })).rejects.toMatchObject({
      code: 'campaigns.draw_invalid',
    });
  });

  it('#1 #2 shows the odds, prizes, my chances up to the cap for my user type, and the seed commitment', async () => {
    const c = await live();
    await enter(c.id, ANN);
    await enter(c.id, BEN);
    tiers.set(BEN, 'full');
    const before = await draws.board({ campaignId: c.id, accountId: ANN });
    expect(before).toMatchObject({ prizeAsset: 'USDC', pool: '10', chancesPerFill: 2, totalChances: 0, entrants: 2, closed: false });
    expect(before.prizes).toEqual(TERMS.prizes);
    expect(before.mine).toMatchObject({ userType: 'basic', cap: 5, chances: 0, fills: 0, capped: false });
    expect(before.running).toEqual({ code: 'owner.decision', question: DRAW_OWNER_QUESTION });
    expect(before.revealed).toBeNull();
    const [seed] = await db!.sql<{ seed: string; commitment: string }[]>`SELECT seed, commitment FROM campaigns.draw_seeds`;
    expect(before.commitment).toBe(createHash('sha256').update(seed!.seed).digest('hex'));
    expect(JSON.stringify(before)).not.toContain(seed!.seed);

    // Two fills: 2 + 2 chances. A fill with no fee of ours, one before the join, adds nothing.
    fills.set(ANN, [
      fill('f1'),
      fill('f2'),
      fill('f0', { builderFee: '0' }),
      fill('old', { filledAt: new Date(Date.now() - HOUR / 2).toISOString() }),
    ]);
    expect((await draws.board({ campaignId: c.id, accountId: ANN })).mine).toMatchObject({ chances: 4, fills: 2, capped: false });
    // Read again: each fill counts once.
    expect((await draws.board({ campaignId: c.id, accountId: ANN })).mine).toMatchObject({ chances: 4, fills: 2 });
    // Two more: the cap of 5 stops the third at 1 and the fourth at 0.
    fills.set(ANN, [fill('f1'), fill('f2'), fill('f3'), fill('f4')]);
    const capped = await draws.board({ campaignId: c.id, accountId: ANN });
    expect(capped.mine).toMatchObject({ chances: 5, fills: 4, capped: true, cap: 5 });
    fills.set(ANN, [fill('f1'), fill('f2'), fill('f3'), fill('f4'), fill('f5')]);
    expect((await draws.board({ campaignId: c.id, accountId: ANN })).mine).toMatchObject({ chances: 5, capped: true });

    // The other entrant's chances are counted by the pass; the odds and the entry hash follow.
    fills.set(BEN, [fill('b1')]);
    await draws.tick();
    const both = await draws.board({ campaignId: c.id, accountId: ANN });
    expect(both.totalChances).toBe(7);
    expect(both.entryHash).toBe(
      entryHashOf([
        { entrant: entrantOf(ANN), chances: 5 },
        { entrant: entrantOf(BEN), chances: 2 },
      ]),
    );
    expect(both.commitment).toBe(before.commitment);
    expect(both.entryHash).not.toBe(capped.entryHash);
    expect(await intentCount()).toBe(0);
  });

  it('names a read that failed and keeps the chances as last counted, never zero', async () => {
    const c = await live();
    await enter(c.id, ANN);
    fills.set(ANN, [fill('f1')]);
    await draws.board({ campaignId: c.id, accountId: ANN });
    fills.set(ANN, 'unread');
    const b = await draws.board({ campaignId: c.id, accountId: ANN });
    expect(b.unread).toBe('trade.venue.venue_down');
    expect(b.mine).toMatchObject({ chances: 2 });
    tiers.set(ANN, 'unread');
    expect((await draws.board({ campaignId: c.id, accountId: ANN })).unread).toBe('campaigns.participant_unread');
  });

  it('#3 running or settling refuses owner.decision naming the question, audits the attempt and pays nothing', async () => {
    const c = await live();
    await enter(c.id, ANN);
    fills.set(ANN, [fill('f1')]);
    await draws.board({ campaignId: c.id, accountId: ANN });
    for (const action of ['run', 'settle'] as const) {
      await expect(draws.refuseRun({ campaignId: c.id, actor: A, reason: 'TEST run', action })).rejects.toMatchObject({
        code: 'owner.decision',
        message: DRAW_OWNER_QUESTION,
      });
    }
    const audit = await db!.sql<{ action: string }[]>`
      SELECT action FROM campaigns.audit_log WHERE target = ${c.id} AND action LIKE 'campaign.draw.%' ORDER BY id`;
    expect(audit.map((a) => a.action)).toEqual(['campaign.draw.run_refused', 'campaign.draw.settle_refused']);
    const b = await draws.board({ campaignId: c.id, accountId: ANN });
    expect(b.revealed).toBeNull();
    expect(b.winners).toEqual([]);
    expect(await intentCount()).toBe(0);
  });

  it('refuses a board for a campaign that is not a draw', async () => {
    const c = await live({ type: 'task', draw: null, reward: { asset: 'USDC', amount: '1' } });
    await expect(draws.board({ campaignId: c.id, accountId: ANN })).rejects.toMatchObject({ code: 'campaigns.not_draw' });
  });
});
