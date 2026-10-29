import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { LaunchError } from './errors.js';
import { LaunchService, launchSnapshotHash, ticketsFor, tierWeightFor, type CreateEventInput } from './launch-service.js';

/**
 * J-more-catalogue-11: the launch catalogue, one event's rule and terms, issuer review, and the holdings snapshot.
 * PG-hard: no skip. Every figure here is TEST.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const ACTOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const HOLDER_A = '33333333-3333-4333-8333-333333333333';
const HOLDER_B = '44444444-4444-4444-8444-444444444444';
const NOBODY = '55555555-5555-4555-8555-555555555555';

const T0 = new Date('2026-11-01T00:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_launch_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`J-more-catalogue-11 is PG-hard. TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

function event(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    id: 'test-open-launch',
    issuerId: 'test-issuer',
    type: 'token_sale',
    projectName: 'TEST Project',
    symbol: 'TST',
    periods: { announceAt: at(0), snapshotAt: at(1), openAt: at(2), closeAt: at(10), distributionAt: at(11) },
    allocation: { method: 'pro_rata', perUserCap: '250', ticketSize: null, tierWeights: null },
    terms: { price: '0.5', paymentAsset: 'USDT', rateSource: null },
    ...overrides,
  };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LaunchError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('launch rule helpers', () => {
  it('tickets are whole tickets and a tier weight is the highest tier reached', () => {
    expect(ticketsFor(amt('25.9'), amt('5'))).toBe(5n);
    const tiers = [
      { minBasis: amt('0'), weight: 1 },
      { minBasis: amt('100'), weight: 3 },
    ];
    expect(tierWeightFor(amt('99.99'), tiers)).toBe(1);
    expect(tierWeightFor(amt('100'), tiers)).toBe(3);
    expect(tierWeightFor(amt('5'), [{ minBasis: amt('10'), weight: 2 }])).toBe(0);
  });

  it('the snapshot hash does not depend on row order', () => {
    const a = { userId: HOLDER_A, basis: amt('1') };
    const b = { userId: HOLDER_B, basis: amt('2') };
    expect(launchSnapshotHash([a, b])).toBe(launchSnapshotHash([b, a]));
    expect(launchSnapshotHash([a, b])).not.toBe(launchSnapshotHash([a, { ...b, basis: amt('3') }]));
  });
});

describe('J-more-catalogue-11 launch service', () => {
  let db: TestDatabase;
  let sql: Sql;
  let launch: LaunchService;
  let adminStop: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
    sql = db.sql;
    launch = new LaunchService(sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE token.launch_snapshots, token.launch_event_moves, token.launch_events, token.launch_issuer_moves, token.launch_issuers, token.stakes CASCADE`;
  });

  const who = { actorId: ACTOR, approverId: APPROVER };

  async function onboardedIssuer(id = 'test-issuer') {
    await launch.setIssuer({ id, name: 'TEST Issuer', state: 'applied', expectedRevision: 0, ...who });
    await launch.setIssuer({ id, name: 'TEST Issuer', state: 'reviewing', expectedRevision: 1, ...who });
    return launch.setIssuer({ id, name: 'TEST Issuer', state: 'onboarded', expectedRevision: 2, ...who });
  }

  async function stake(userId: string, amount: string, startedAt: Date, status = 'active') {
    await sql`
      INSERT INTO token.stakes (user_id, amount, tier, multiplier_bps, started_at, status)
      VALUES (${userId}, ${amount}::numeric, 'flex', 10000, ${startedAt}, ${status})
    `;
  }

  /** Moves draft → announced → snapshot → open at times inside each period. */
  async function toOpen(id = 'test-open-launch') {
    await launch.moveEvent({ id, to: 'announced', expectedRevision: 0, ...who, now: at(0.5) });
    await launch.moveEvent({ id, to: 'snapshot', expectedRevision: 1, ...who, now: at(1.5) });
    return launch.moveEvent({ id, to: 'open', expectedRevision: 2, ...who, now: at(3) });
  }

  it('an empty catalogue is an empty list, and a missing page size refuses', async () => {
    expect(await launch.listEvents({ limit: 50 })).toEqual([]);
    expect(await refusal(launch.listEvents({}))).toBe('launch.events_list_limit_unset');
  });

  it('a draft is not published: the list leaves it out and a read is not found', async () => {
    await onboardedIssuer();
    await launch.createEvent(event());
    expect(await launch.listEvents({ limit: 50 })).toEqual([]);
    expect(await refusal(launch.getEvent('test-open-launch'))).toBe('launch.event_not_found');
  });

  it('creating is idempotent on the launch id; other details under the same id conflict', async () => {
    await onboardedIssuer();
    const first = await launch.createEvent(event());
    expect(await launch.createEvent(event())).toEqual(first);
    expect(await refusal(launch.createEvent(event({ terms: { price: '0.6', paymentAsset: 'USDT', rateSource: null } })))).toBe(
      'launch.event_conflict',
    );
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM token.launch_events`;
    expect(n).toBe(1);
  });

  it('refuses invalid details and an unknown issuer', async () => {
    expect(await refusal(launch.createEvent(event()))).toBe('launch.issuer_not_found');
    await onboardedIssuer();
    const bad = event({ periods: { announceAt: at(2), snapshotAt: at(1), openAt: at(3), closeAt: at(4), distributionAt: at(5) } });
    expect(await refusal(launch.createEvent(bad))).toBe('launch.event_invalid');
    expect(await refusal(launch.createEvent(event({ terms: { price: '1', paymentAsset: null, rateSource: null } })))).toBe(
      'launch.event_invalid',
    );
    expect(
      await refusal(
        launch.createEvent(event({ allocation: { method: 'pro_rata', perUserCap: '0', ticketSize: null, tierWeights: null } })),
      ),
    ).toBe('launch.event_invalid');
  });

  it('issuer review moves one step at a time, a retry replays, and a stale revision refuses', async () => {
    await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'applied', expectedRevision: 0, ...who });
    expect(
      await refusal(launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'onboarded', expectedRevision: 1, ...who })),
    ).toBe('launch.issuer_move_invalid');
    const reviewing = await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'reviewing', expectedRevision: 1, ...who });
    expect(reviewing).toMatchObject({ state: 'reviewing', revision: 2 });
    // The same move again replays: no second move row.
    expect(
      await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'reviewing', expectedRevision: 1, ...who }),
    ).toMatchObject({
      state: 'reviewing',
      revision: 2,
    });
    expect(await refusal(launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'applied', expectedRevision: 1, ...who }))).toBe(
      'launch.issuer_stale',
    );
    expect(await refusal(launch.setIssuer({ id: 'test-issuer', name: 'Other', state: 'onboarded', expectedRevision: 2, ...who }))).toBe(
      'launch.issuer_conflict',
    );
    const [{ n }] = await sql<[{ n: number }]>`SELECT count(*)::int AS n FROM token.launch_issuer_moves`;
    expect(n).toBe(2);
  });

  it('an issuer that is not onboarded cannot announce a launch', async () => {
    await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'applied', expectedRevision: 0, ...who });
    await launch.createEvent(event());
    expect(await refusal(launch.moveEvent({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, ...who, now: at(0.5) }))).toBe(
      'launch.issuer_not_onboarded',
    );
  });

  it('each step waits for its period, and a window that already closed cannot open', async () => {
    await onboardedIssuer();
    await launch.createEvent(event());
    expect(await refusal(launch.moveEvent({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, ...who, now: at(-1) }))).toBe(
      'launch.period_not_due',
    );
    expect(await refusal(launch.moveEvent({ id: 'test-open-launch', to: 'snapshot', expectedRevision: 0, ...who, now: at(5) }))).toBe(
      'launch.event_move_invalid',
    );
    await launch.moveEvent({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, ...who, now: at(0.5) });
    await launch.moveEvent({ id: 'test-open-launch', to: 'snapshot', expectedRevision: 1, ...who, now: at(1.5) });
    expect(await refusal(launch.moveEvent({ id: 'test-open-launch', to: 'open', expectedRevision: 2, ...who, now: at(10) }))).toBe(
      'launch.period_passed',
    );
  });

  it('past closed, allocation refuses as unwired; a move retry replays and a stale one refuses', async () => {
    await onboardedIssuer();
    await launch.createEvent(event());
    const open = await toOpen();
    expect(open).toMatchObject({ status: 'open', state: 'open', revision: 3 });
    expect((await launch.moveEvent({ id: 'test-open-launch', to: 'open', expectedRevision: 2, ...who, now: at(3) })).revision).toBe(3);
    expect(await refusal(launch.moveEvent({ id: 'test-open-launch', to: 'closed', expectedRevision: 2, ...who, now: at(10) }))).toBe(
      'launch.event_stale',
    );
    const closed = await launch.moveEvent({ id: 'test-open-launch', to: 'closed', expectedRevision: 3, ...who, now: at(10) });
    expect(closed).toMatchObject({ status: 'closed', state: 'past' });
    expect(await refusal(launch.moveEvent({ id: 'test-open-launch', to: 'allocated', expectedRevision: 4, ...who, now: at(12) }))).toBe(
      'launch.allocation_unwired',
    );
    const cancelled = await launch.moveEvent({ id: 'test-open-launch', to: 'cancelled', expectedRevision: 4, ...who, now: at(12) });
    expect(cancelled.status).toBe('cancelled');
  });

  it('the read-only checks refuse what the writes refuse, pass a retry, and write nothing', async () => {
    expect(await refusal(launch.checkIssuerSet({ id: 'test-issuer', name: 'TEST Issuer', state: 'reviewing', expectedRevision: 0 }))).toBe(
      'launch.issuer_move_invalid',
    );
    await launch.checkIssuerSet({ id: 'test-issuer', name: 'TEST Issuer', state: 'applied', expectedRevision: 0 });
    await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'applied', expectedRevision: 0, ...who });
    await launch.checkIssuerSet({ id: 'test-issuer', name: 'TEST Issuer', state: 'applied', expectedRevision: 0 });
    expect(await refusal(launch.checkIssuerSet({ id: 'test-issuer', name: 'TEST Issuer', state: 'onboarded', expectedRevision: 1 }))).toBe(
      'launch.issuer_move_invalid',
    );
    expect(await refusal(launch.checkMove({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, now: at(0.5) }))).toBe(
      'launch.event_not_found',
    );
    expect(await refusal(launch.checkCreate(event({ issuerId: 'other-issuer' })))).toBe('launch.issuer_not_found');
    await launch.checkCreate(event());
    await launch.createEvent(event());
    await launch.checkCreate(event());
    expect(await refusal(launch.checkCreate(event({ terms: { price: '0.6', paymentAsset: 'USDT', rateSource: null } })))).toBe(
      'launch.event_conflict',
    );
    expect(await refusal(launch.checkMove({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, now: at(0.5) }))).toBe(
      'launch.issuer_not_onboarded',
    );
    await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'reviewing', expectedRevision: 1, ...who });
    await launch.setIssuer({ id: 'test-issuer', name: 'TEST Issuer', state: 'onboarded', expectedRevision: 2, ...who });
    expect(await refusal(launch.checkMove({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, now: at(-1) }))).toBe(
      'launch.period_not_due',
    );
    expect(await refusal(launch.checkMove({ id: 'test-open-launch', to: 'open', expectedRevision: 0, now: at(3) }))).toBe(
      'launch.event_move_invalid',
    );
    expect(await refusal(launch.checkMove({ id: 'test-open-launch', to: 'announced', expectedRevision: 1, now: at(0.5) }))).toBe(
      'launch.event_stale',
    );
    await launch.checkMove({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, now: at(0.5) });
    const [{ moves }] = await sql<[{ moves: number }]>`SELECT count(*)::int AS moves FROM token.launch_event_moves`;
    expect(moves).toBe(0);
    await launch.moveEvent({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, ...who, now: at(0.5) });
    // A retry of the move that landed passes the check, so it reaches the write and replays there.
    await launch.checkMove({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, now: at(0.5) });
  });

  it('filters by state and type, newest opening first, each with its issuer state', async () => {
    await onboardedIssuer();
    await launch.createEvent(event());
    await toOpen();
    await launch.createEvent(
      event({
        id: 'test-past-launch',
        type: 'whitelist_drop',
        periods: { announceAt: at(-30), snapshotAt: at(-29), openAt: at(-28), closeAt: at(-20), distributionAt: at(-19) },
        allocation: { method: null, perUserCap: null, ticketSize: null, tierWeights: null },
        terms: { price: null, paymentAsset: null, rateSource: null },
      }),
    );
    await launch.moveEvent({ id: 'test-past-launch', to: 'cancelled', expectedRevision: 0, ...who, now: at(0) });

    expect((await launch.listEvents({ limit: 50 })).map((e) => e.id)).toEqual(['test-open-launch', 'test-past-launch']);
    const open = await launch.listEvents({ state: 'open', limit: 50 });
    expect(open.map((e) => [e.id, e.issuer.state])).toEqual([['test-open-launch', 'onboarded']]);
    expect((await launch.listEvents({ state: 'past', limit: 50 })).map((e) => e.id)).toEqual(['test-past-launch']);
    expect(await launch.listEvents({ state: 'upcoming', limit: 50 })).toEqual([]);
    expect((await launch.listEvents({ type: 'whitelist_drop', limit: 50 })).map((e) => e.id)).toEqual(['test-past-launch']);
    expect(await launch.listEvents({ limit: 1 })).toHaveLength(1);

    const past = await launch.getEvent('test-past-launch');
    expect(past.allocation).toEqual({ method: null, perUserCap: null, ticketSize: null, tierWeights: null });
    expect(past.terms).toEqual({ price: null, paymentAsset: null, rateSource: null });
  });

  it('the snapshot stores each account’s active stake at the move, and the basis is that stored row', async () => {
    await onboardedIssuer();
    await launch.createEvent(event());
    await stake(HOLDER_A, '100.5', at(-5));
    await stake(HOLDER_A, '20', at(-4));
    await stake(HOLDER_B, '7', at(-3));
    await stake(HOLDER_B, '1000', at(-3), 'pending');
    await stake(NOBODY, '9', at(5));

    expect((await launch.readBasis('test-open-launch', HOLDER_A).catch((e: LaunchError) => e.code)) as string).toBe(
      'launch.event_not_found',
    );
    await launch.moveEvent({ id: 'test-open-launch', to: 'announced', expectedRevision: 0, ...who, now: at(0.5) });
    expect(await launch.readBasis('test-open-launch', HOLDER_A)).toMatchObject({ basis: null, reason: 'snapshot_not_taken' });

    const sealed = await launch.moveEvent({ id: 'test-open-launch', to: 'snapshot', expectedRevision: 1, ...who, now: at(1.5) });
    expect(sealed.snapshot).toMatchObject({ count: 2, total: amt('127.5') });
    const rows = await sql<Array<{ user_id: string; basis: string }>>`
      SELECT user_id, basis::text AS basis FROM token.launch_snapshots WHERE event_id = 'test-open-launch' ORDER BY user_id
    `;
    expect(rows.map((r) => [r.user_id, amt(r.basis)])).toEqual([
      [HOLDER_A, amt('120.5')],
      [HOLDER_B, amt('7')],
    ]);
    expect(sealed.snapshot!.hash).toBe(launchSnapshotHash(rows.map((r) => ({ userId: r.user_id, basis: amt(r.basis) }))));

    // A stake added after the snapshot does not change the stored basis.
    await stake(HOLDER_A, '500', at(2));
    const basis = await launch.readBasis('test-open-launch', HOLDER_A);
    expect(basis).toMatchObject({ basis: amt('120.5'), reason: null, method: 'pro_rata', perUserCap: amt('250') });
    expect(basis.takenAt?.toISOString()).toBe(at(1.5).toISOString());
    expect(await launch.readBasis('test-open-launch', NOBODY)).toMatchObject({ basis: null, reason: 'no_holdings_at_snapshot' });
  });
});
