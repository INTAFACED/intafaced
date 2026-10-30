import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
  type AgentsTeamBusinessRole,
  type AgentsTeamMembershipResponse,
} from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { createAgentsRouter, type AgentsRouterDeps } from '../router.js';
import type { TeamMembershipPort } from './membership.js';
import { TeamStore } from './store.js';

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const BUSINESS = '99999999-9999-4999-8999-999999999999';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const BEN = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const OTHER_BUSINESS = '88888888-8888-4888-8888-888888888888';

type TeamState = {
  members: string[];
  roles?: Record<string, AgentsTeamBusinessRole>;
  closed?: boolean;
  down?: boolean;
};
const SECRET = 'an-agents-team-roles-test-secret-of-32+';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

/** svc-bank's answer, as the team stands now: a member removed from `members` is gone at the next read. */
function teamPort(state: TeamState): TeamMembershipPort {
  return {
    async read(userId, businessId): Promise<AgentsTeamMembershipResponse> {
      if (state.down) throw new Error('connect ECONNREFUSED');
      if (businessId !== BUSINESS || (userId !== OWNER && !state.members.includes(userId))) return { ok: false, reason: 'not_member' };
      if (state.closed) return { ok: false, reason: 'business_closed' };
      const roleOf = (m: string) => state.roles?.[m] ?? (m === OWNER ? 'admin' : 'maker');
      return {
        ok: true,
        businessId: BUSINESS,
        role: roleOf(userId),
        members: [OWNER, ...state.members].map((m) => ({ userId: m, role: roleOf(m) })),
      };
    },
  };
}

function callerFor(userId: string, extra: { kid?: string } = {}) {
  const principal = {
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['agents:read', 'identity:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...(extra.kid ? { kid: extra.kid } : {}),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-team',
  });
}

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('business team roles (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-team-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  let state: TeamState;
  let store: TeamStore;
  let lockConn: Awaited<ReturnType<typeof sql.reserve>>;

  beforeAll(async () => {
    lockConn = await sql.reserve();
    await lockConn`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lockConn`select pg_advisory_unlock(842671)`;
    }
  }, 120_000);

  beforeEach(async () => {
    await lockConn`select pg_advisory_lock(842671)`;
    await sql`
      TRUNCATE agents.team_project_members, agents.team_projects, agents.team_pool_allocations, agents.team_pools,
               agents.team_role_grants
      RESTART IDENTITY CASCADE
    `;
    state = { members: [ANA, BEN] };
    store = new TeamStore(sql, teamPort(state), 'IFC');
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const grant = (memberUserId: string, role: string, allow: boolean, deny: boolean, revision = 1) =>
    store.setGrant({ actorUserId: OWNER, businessId: BUSINESS, memberUserId, role, allow, deny, revision });

  describe('roles', () => {
    it('lists each member with every role granted, and refuses a grant to a non-member', async () => {
      for (const role of ['creator', 'runner', 'approver', 'log_reader', 'spend_reader']) await grant(ANA, role, true, false);
      const view = await store.view(OWNER, BUSINESS);
      expect(view.members.map((m) => m.userId)).toEqual([OWNER, ANA, BEN]);
      expect(view.members.find((m) => m.userId === ANA)?.effective).toEqual([
        'creator',
        'runner',
        'approver',
        'log_reader',
        'spend_reader',
      ]);
      expect(view.members.find((m) => m.userId === BEN)?.effective).toEqual([]);
      await expect(grant(OUTSIDER, 'runner', true, false)).rejects.toMatchObject({ code: 'agents.role_not_member' });
      const rows = await sql`SELECT 1 FROM agents.team_role_grants WHERE member_user_id = ${OUTSIDER}`;
      expect(rows).toHaveLength(0);
    });

    it('makes deny win over allow', async () => {
      await grant(BEN, 'runner', true, true);
      const ben = (await store.view(OWNER, BUSINESS)).members.find((m) => m.userId === BEN)!;
      expect(ben.grants.find((g) => g.role === 'runner')).toMatchObject({ allow: true, deny: true, version: 1 });
      expect(ben.effective).not.toContain('runner');
    });

    it('replays a retried change once, and refuses a stale or skipped change', async () => {
      expect((await grant(ANA, 'runner', true, false)).replayed).toBe(false);
      expect((await grant(ANA, 'runner', true, false)).replayed).toBe(true);
      await expect(grant(ANA, 'runner', false, false, 1)).rejects.toMatchObject({ code: 'agents.team_change_stale' });
      await expect(grant(ANA, 'runner', false, false, 3)).rejects.toMatchObject({ code: 'agents.team_change_stale' });
      const [row] = await sql<Array<{ idempotency_key: string; version: number }>>`
        SELECT idempotency_key, version FROM agents.team_role_grants WHERE member_user_id = ${ANA}`;
      expect(row).toEqual({ idempotency_key: `agents:role:${BUSINESS}:${ANA}:runner:1`, version: 1 });
    });

    it('lets only a business admin or non-signing admin change roles, and refuses an unknown role', async () => {
      await expect(
        store.setGrant({
          actorUserId: ANA,
          businessId: BUSINESS,
          memberUserId: BEN,
          role: 'runner',
          allow: true,
          deny: false,
          revision: 1,
        }),
      ).rejects.toMatchObject({
        code: 'agents.role_admin_only',
      });
      await expect(grant(ANA, 'treasurer', true, false)).rejects.toMatchObject({ code: 'agents.role_invalid' });
      expect((await store.view(ANA, BUSINESS)).canManage).toBe(false);
      state.roles = { [ANA]: 'non_signing_admin' };
      expect((await store.view(ANA, BUSINESS)).canManage).toBe(true);
      expect(
        (
          await store.setGrant({
            actorUserId: ANA,
            businessId: BUSINESS,
            memberUserId: BEN,
            role: 'runner',
            allow: true,
            deny: false,
            revision: 1,
          })
        ).replayed,
      ).toBe(false);
    });

    it('refuses a person not on the business they name, or a business they are not on', async () => {
      await expect(store.view(OUTSIDER, BUSINESS)).rejects.toMatchObject({ code: 'agents.team_not_member' });
      await expect(store.view(OWNER, OTHER_BUSINESS)).rejects.toMatchObject({ code: 'agents.team_not_member' });
    });
  });

  describe('pool', () => {
    it('refuses a blank allocation by member and saves nothing; shows the limit once every allocation is set', async () => {
      const blank = await store.setPool({
        actorUserId: OWNER,
        businessId: BUSINESS,
        limit: '10',
        allocations: [
          { memberUserId: ANA, amount: '4' },
          { memberUserId: BEN, amount: '' },
        ],
        revision: 1,
      });
      expect(blank).toEqual({ ok: false, code: 'agents.pool_allocation_unset', memberUserIds: [BEN] });
      expect((await store.view(OWNER, BUSINESS)).pool).toBeNull();

      const set = await store.setPool({
        actorUserId: OWNER,
        businessId: BUSINESS,
        limit: '10.50',
        allocations: [
          { memberUserId: ANA, amount: '4' },
          { memberUserId: BEN, amount: '0' },
        ],
        revision: 1,
      });
      expect(set).toEqual({ ok: true, pool: { assetId: 'IFC', limit: '10.5', allocated: '4', version: 1 }, replayed: false });
      const view = await store.view(OWNER, BUSINESS);
      expect(view.pool).toEqual({ assetId: 'IFC', limit: '10.5', allocated: '4', version: 1 });
      expect(view.members.map((m) => m.allocation)).toEqual([null, '4', '0']);
    });

    it('refuses a blank or zero limit, an allocation above the limit, a non-member and an unset fee asset', async () => {
      const base = { actorUserId: OWNER, businessId: BUSINESS, allocations: [{ memberUserId: ANA, amount: '1' }], revision: 1 };
      await expect(store.setPool({ ...base, limit: ' ' })).rejects.toMatchObject({ code: 'agents.pool_limit_unset' });
      await expect(store.setPool({ ...base, limit: '0' })).rejects.toMatchObject({ code: 'agents.pool_limit_invalid' });
      await expect(store.setPool({ ...base, limit: '0.5' })).rejects.toMatchObject({ code: 'agents.pool_allocation_invalid' });
      await expect(
        store.setPool({
          ...base,
          limit: '5',
          allocations: [
            { memberUserId: ANA, amount: '3' },
            { memberUserId: BEN, amount: '2.000000000000000001' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'agents.pool_over_limit' });
      await expect(store.setPool({ ...base, limit: '5', allocations: [{ memberUserId: OUTSIDER, amount: '1' }] })).rejects.toMatchObject({
        code: 'agents.role_not_member',
      });
      await expect(new TeamStore(sql, teamPort(state), undefined).setPool({ ...base, limit: '5' })).rejects.toMatchObject({
        code: 'agents.fee_asset_unset',
      });
      const rows = await sql`SELECT 1 FROM agents.team_pools`;
      expect(rows).toHaveLength(0);
    });

    it('keys change n as agents:pool:<business>:<n> and replays it once', async () => {
      const input = {
        actorUserId: OWNER,
        businessId: BUSINESS,
        limit: '5',
        allocations: [{ memberUserId: ANA, amount: '2' }],
        revision: 1,
      };
      await store.setPool(input);
      expect(await store.setPool(input)).toMatchObject({ ok: true, replayed: true });
      await expect(store.setPool({ ...input, limit: '6' })).rejects.toMatchObject({ code: 'agents.team_change_stale' });
      const [row] = await sql<Array<{ idempotency_key: string }>>`SELECT idempotency_key FROM agents.team_pools`;
      expect(row?.idempotency_key).toBe(`agents:pool:${BUSINESS}:1`);
    });
  });

  describe('projects', () => {
    it('limits the members named on a project and not the others, and refuses a blank limit', async () => {
      await expect(
        store.createProject({ actorUserId: OWNER, businessId: BUSINESS, name: 'TEST launch', limit: '', memberUserIds: [ANA], seq: 1 }),
      ).rejects.toMatchObject({
        code: 'agents.project_limit_unset',
      });
      const made = await store.createProject({
        actorUserId: OWNER,
        businessId: BUSINESS,
        name: 'TEST launch',
        limit: '3',
        memberUserIds: [ANA],
        seq: 1,
      });
      expect(made.project).toMatchObject({ name: 'TEST launch', limit: '3', memberUserIds: [ANA] });
      const view = await store.view(OWNER, BUSINESS);
      expect(view.projects).toEqual([made.project]);
      expect(view.nextProjectSeq).toBe(2);
      expect(view.projects[0]?.memberUserIds).not.toContain(BEN);
      expect(
        (
          await store.createProject({
            actorUserId: OWNER,
            businessId: BUSINESS,
            name: 'TEST launch',
            limit: '3',
            memberUserIds: [ANA],
            seq: 1,
          })
        ).replayed,
      ).toBe(true);
      await expect(
        store.createProject({
          actorUserId: OWNER,
          businessId: BUSINESS,
          name: 'TEST other',
          limit: '3',
          memberUserIds: [OUTSIDER],
          seq: 2,
        }),
      ).rejects.toMatchObject({
        code: 'agents.role_not_member',
      });
    });
  });

  describe('a removed member', () => {
    it('drops from every view with their grants, allocation and project limit, and their next request fails', async () => {
      await grant(BEN, 'runner', true, false);
      await store.setPool({
        actorUserId: OWNER,
        businessId: BUSINESS,
        limit: '5',
        allocations: [{ memberUserId: BEN, amount: '2' }],
        revision: 1,
      });
      await store.createProject({
        actorUserId: OWNER,
        businessId: BUSINESS,
        name: 'TEST launch',
        limit: '3',
        memberUserIds: [ANA, BEN],
        seq: 1,
      });
      state.members = [ANA];
      const view = await store.view(OWNER, BUSINESS);
      expect(view.members.map((m) => m.userId)).toEqual([OWNER, ANA]);
      expect(view.pool?.allocated).toBe('0');
      expect(view.projects[0]?.memberUserIds).toEqual([ANA]);
      await expect(store.view(BEN, BUSINESS)).rejects.toMatchObject({ code: 'agents.team_not_member' });
      await expect(grant(BEN, 'runner', false, false, 2)).rejects.toMatchObject({ code: 'agents.role_not_member' });
    });

    it('refuses a closed business and an unreadable team, never an empty one', async () => {
      state.closed = true;
      await expect(store.view(OWNER, BUSINESS)).rejects.toMatchObject({ code: 'agents.business_closed' });
      state.closed = false;
      state.down = true;
      await expect(store.view(OWNER, BUSINESS)).rejects.toMatchObject({ code: 'agents.membership_unavailable' });
    });
  });

  describe('team router', () => {
    const appFor = (membership?: TeamMembershipPort) =>
      createAgentsRouter({
        sql,
        feeAssetId: 'IFC',
        ...(membership ? { teamMembership: membership } : {}),
      } as unknown as AgentsRouterDeps);

    it("answers the caller's business and carries each refusal's code", async () => {
      const app = appFor(teamPort(state));
      const owner = app.createCaller(callerFor(OWNER));
      await owner.team.grants.set({ businessId: BUSINESS, memberUserId: ANA, role: 'runner', allow: true, deny: false, revision: 1 });
      expect((await owner.team.view({ businessId: BUSINESS })).members.find((m) => m.userId === ANA)?.effective).toEqual(['runner']);
      await expect(
        owner.team.grants.set({ businessId: BUSINESS, memberUserId: OUTSIDER, role: 'runner', allow: true, deny: false, revision: 1 }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'agents.role_not_member' },
      });
      await expect(
        app
          .createCaller(callerFor(OWNER, { kid: 'key-1' }))
          .team.grants.set({ businessId: BUSINESS, memberUserId: ANA, role: 'runner', allow: false, deny: false, revision: 2 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(appFor().createCaller(callerFor(OWNER)).team.view({ businessId: BUSINESS })).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        cause: { code: 'agents.membership_unavailable' },
      });
    });
  });
}
