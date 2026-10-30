/**
 * svc-agents' read of a business team (J-agents-11): only a member gets the team, by when each joined; a removed
 * member, an outsider and an unknown business are all `not_member`; a closed business never shows its team.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  AGENTS_TEAM_BUSINESS_ROLES,
  retainRawBody,
  serviceAuthHeadersForBody,
  type AgentsTeamMembershipResponse,
} from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { BUSINESS_ROLES } from '../business/business-policy.js';
import { registerAgentsTeamMembership, teamMembershipFor } from './team-membership.js';

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const SECRET = 'bank-agents-team-read-secret-at-least-32-characters';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const MAKER = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const UNKNOWN = '55555555-5555-4555-8555-555555555555';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

// PG-hard: never skip-green. An unset or unreachable database fails this suite.
const db: TestDatabase = await createTestDatabase({ service: 'bank', url: adminUrl(), migrations });
let business = '';
let other = '';

async function open(name: string): Promise<string> {
  const [row] = await db.sql<Array<{ id: string }>>`
    INSERT INTO bank.business_accounts (name, asset_id, spend_threshold) VALUES (${name}, 'IFC', 100) RETURNING id`;
  if (!row) throw new Error('business insert returned no row');
  return row.id;
}
async function member(account: string, userId: string, role: string, ago: string) {
  await db.sql`
    INSERT INTO bank.business_members (account_id, user_id, role, created_at)
    VALUES (${account}, ${userId}, ${role}::bank.business_member_role, now() - ${ago}::interval)`;
}

beforeEach(async () => {
  await db.sql`TRUNCATE bank.business_members, bank.business_accounts RESTART IDENTITY CASCADE`;
  business = await open('TEST team');
  other = await open('TEST other');
  await member(business, ADMIN, 'admin', '10 minutes');
  await member(business, VIEWER, 'viewer', '2 minutes');
  await member(business, MAKER, 'maker', '5 minutes');
  await member(other, OUTSIDER, 'admin', '1 minute');
});

afterAll(async () => {
  await db.drop();
});

const team = () => [
  { userId: ADMIN, role: 'admin' },
  { userId: MAKER, role: 'maker' },
  { userId: VIEWER, role: 'viewer' },
];

describe('teamMembershipFor', () => {
  it('lists the same roles as svc-bank', () => {
    expect([...AGENTS_TEAM_BUSINESS_ROLES].sort()).toEqual([...BUSINESS_ROLES].sort());
  });

  it("answers each member with the whole team by join time and the member's own role", async () => {
    for (const [userId, role] of [
      [ADMIN, 'admin'],
      [MAKER, 'maker'],
      [VIEWER, 'viewer'],
    ] as const) {
      expect(await teamMembershipFor(db.sql, userId, business)).toEqual({ ok: true, businessId: business, role, members: team() });
    }
  });

  it('answers not_member to an outsider, an unknown business and a removed member', async () => {
    expect(await teamMembershipFor(db.sql, OUTSIDER, business)).toEqual({ ok: false, reason: 'not_member' });
    expect(await teamMembershipFor(db.sql, ADMIN, other)).toEqual({ ok: false, reason: 'not_member' });
    expect(await teamMembershipFor(db.sql, ADMIN, UNKNOWN)).toEqual({ ok: false, reason: 'not_member' });
    await db.sql`DELETE FROM bank.business_members WHERE account_id = ${business} AND user_id = ${MAKER}`;
    expect(await teamMembershipFor(db.sql, MAKER, business)).toEqual({ ok: false, reason: 'not_member' });
    expect(await teamMembershipFor(db.sql, ADMIN, business)).toMatchObject({
      members: [
        { userId: ADMIN, role: 'admin' },
        { userId: VIEWER, role: 'viewer' },
      ],
    });
  });

  it('answers business_closed, never the team, to a member of a closed business', async () => {
    await db.sql`UPDATE bank.business_accounts SET status = 'closed' WHERE id = ${business}`;
    for (const userId of [ADMIN, MAKER]) {
      expect(await teamMembershipFor(db.sql, userId, business)).toEqual({ ok: false, reason: 'business_closed' });
    }
    expect(await teamMembershipFor(db.sql, OUTSIDER, business)).toEqual({ ok: false, reason: 'not_member' });
  });
});

describe('POST /internal/agents/team-membership', () => {
  async function appWith(read: (u: string, b: string) => Promise<AgentsTeamMembershipResponse>) {
    const app = Fastify();
    retainRawBody(app);
    registerAgentsTeamMembership(app, { secret: SECRET, read });
    await app.ready();
    return app;
  }
  const post = (body: unknown, service = 'svc-agents') => {
    const payload = JSON.stringify(body);
    return {
      method: 'POST' as const,
      url: '/internal/agents/team-membership',
      payload,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
    };
  };

  it("answers svc-agents with the database's team", async () => {
    const app = await appWith((u, b) => teamMembershipFor(db.sql, u, b));
    const res = await app.inject(post({ userId: MAKER, businessId: business }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, businessId: business, role: 'maker', members: team() });
    const outside = await app.inject(post({ userId: OUTSIDER, businessId: business }));
    expect(outside.json()).toEqual({ ok: false, reason: 'not_member' });
    await app.close();
  });

  it('refuses an unsigned caller, another service and a bad body, without reading', async () => {
    const seen: string[] = [];
    const app = await appWith(async (u) => {
      seen.push(u);
      return { ok: false, reason: 'not_member' };
    });
    const open = await app.inject({
      method: 'POST',
      url: '/internal/agents/team-membership',
      payload: { userId: ADMIN, businessId: business },
    });
    expect(open.statusCode).toBe(401);
    expect(open.json().code).toBe('bank.unauthenticated');
    const otherService = await app.inject(post({ userId: ADMIN, businessId: business }, 'svc-identity'));
    expect(otherService.statusCode).toBe(403);
    expect(otherService.json().code).toBe('bank.team_membership_forbidden');
    for (const body of [{ userId: ADMIN }, { userId: 'x', businessId: business }, { userId: ADMIN, businessId: business, role: 'admin' }]) {
      const bad = await app.inject(post(body));
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('bank.team_membership_input');
    }
    expect(seen).toEqual([]);
    await app.close();
  });

  it('answers 503 with a typed code, never the error text, when the read fails or breaks the contract', async () => {
    const broken = { ok: true, businessId: business, role: 'admin', members: [] } as unknown as AgentsTeamMembershipResponse;
    for (const read of [
      async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.9:5432');
      },
      async () => broken,
    ]) {
      const app = await appWith(read);
      const res = await app.inject(post({ userId: ADMIN, businessId: business }));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'business team could not be read', code: 'bank.team_membership_unavailable' });
      await app.close();
    }
  });
});
