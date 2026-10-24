import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DropService, claimKeyOf } from './drops.js';
import { CampaignsError } from './codes.js';

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

describe.skipIf(!db)('limited drops (Postgres)', () => {
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
    expect(await code(drops.createDrop({ ...base, count: '3', value: { asset: 'USDT', amount: '10' } }))).toBe(
      'campaigns.reward_saga_unwired',
    );
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
