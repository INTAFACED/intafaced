/**
 * svc-agents' read of a business team (AG-governance-01): the owner first, then
 * active members only; invited and removed people are not members.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { teamMembershipForUser } from './team-membership-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ACTIVE = '22222222-2222-4222-8222-222222222222';
const INVITED = '33333333-3333-4333-8333-333333333333';
const REMOVED = '44444444-4444-4444-8444-444444444444';
const OUTSIDER = '55555555-5555-4555-8555-555555555555';
const LATER = '66666666-6666-4666-8666-666666666666';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay team membership read is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay team membership read (source)', () => {
  it('H8a suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('teamMembershipForUser', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let business = '';

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('H8a: svc-pay team membership PG was not opened');
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchant_team_members, pay.merchants RESTART IDENTITY CASCADE');
    const [row] = await sql<{ id: string }[]>`INSERT INTO pay.merchants (user_id) VALUES (${OWNER}) RETURNING id`;
    if (!row) throw new Error('merchant insert returned no row');
    business = row.id;
    await member(LATER, 'viewer', 'active', 'TEST later', '2 minutes');
    await member(ACTIVE, 'finance', 'active', 'TEST finance', '5 minutes');
    await member(INVITED, 'finance', 'invited', null, null);
    await member(REMOVED, 'admin', 'removed', null, '9 minutes');
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function member(userId: string, role: string, status: string, label: string | null, ago: string | null) {
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, label, invited_by, activated_at)
      VALUES (${business}, ${userId}, ${role}, ${status}, ${label}, ${OWNER},
              ${ago === null ? null : sql`now() - ${ago}::interval`})`;
  }

  const team = () => [
    { userId: OWNER, role: 'owner', label: null },
    { userId: ACTIVE, role: 'finance', label: 'TEST finance' },
    { userId: LATER, role: 'viewer', label: 'TEST later' },
  ];

  it('answers the owner with the owner first and active members by when they joined', async () => {
    expect(await teamMembershipForUser(sql, OWNER)).toEqual({ ok: true, businessId: business, role: 'owner', members: team() });
  });

  it("answers an active member with the same team and the member's own role", async () => {
    expect(await teamMembershipForUser(sql, ACTIVE)).toEqual({ ok: true, businessId: business, role: 'finance', members: team() });
  });

  it('answers no_business for an invited, a removed and an outside person', async () => {
    for (const userId of [INVITED, REMOVED, OUTSIDER]) {
      expect(await teamMembershipForUser(sql, userId)).toEqual({ ok: false, reason: 'no_business' });
    }
  });

  it('answers business_shut, never the team, to the owner and a member of a suspended or closed business', async () => {
    for (const status of ['suspended', 'closed']) {
      await sql`UPDATE pay.merchants SET status = ${status}::pay.merchant_status WHERE id = ${business}`;
      for (const userId of [OWNER, ACTIVE]) {
        expect(await teamMembershipForUser(sql, userId)).toEqual({ ok: false, reason: 'business_shut' });
      }
    }
  });

  it('shows a claim stash by its visible part and never sends the email token', async () => {
    await sql`UPDATE pay.merchant_team_members SET label = ${'\u001eemail:ada@example.test'} WHERE user_id = ${ACTIVE}`;
    const answer = await teamMembershipForUser(sql, OWNER);
    expect(answer.ok && answer.members.find((m) => m.userId === ACTIVE)?.label).toBeNull();
    expect(JSON.stringify(answer)).not.toContain('ada@example.test');
  });

  it('drops a member at the next read once they are removed', async () => {
    await sql`UPDATE pay.merchant_team_members SET status = 'removed', removed_at = now() WHERE user_id = ${ACTIVE}`;
    expect(await teamMembershipForUser(sql, ACTIVE)).toEqual({ ok: false, reason: 'no_business' });
    const after = await teamMembershipForUser(sql, OWNER);
    expect(after.ok && after.members.map((m) => m.userId)).toEqual([OWNER, LATER]);
  });
});
