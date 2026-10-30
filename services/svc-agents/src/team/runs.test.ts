import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsTeamBusinessRole, AgentsTeamMembershipResponse } from '@intafaced/contracts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client';
import { OwnAgentStore } from '../own/store.js';
import type { AgentRuntime } from '../runtime.js';
import { UserSpendStore } from '../spend/store.js';
import type { TeamMembershipPort } from './membership.js';
import { TeamRuns } from './runs.js';
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
const ANA_SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BEN_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OUTSIDER_SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type TeamState = { members: string[]; roles?: Record<string, AgentsTeamBusinessRole> };

function teamPort(state: TeamState): TeamMembershipPort {
  return {
    async read(userId, businessId): Promise<AgentsTeamMembershipResponse> {
      if (businessId !== BUSINESS || (userId !== OWNER && !state.members.includes(userId))) return { ok: false, reason: 'not_member' };
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

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('business team runs (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const sql = postgres(URL, {
    max: 8,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-team-runs-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');
  const spend = new UserSpendStore(sql);
  let state: TeamState;
  let store: TeamStore;
  let runs: TeamRuns;
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
      TRUNCATE agents.team_held_actions, agents.team_sessions, agents.team_project_members, agents.team_projects,
               agents.team_pool_allocations, agents.team_pools, agents.team_role_grants, agents.spend_reservations,
               agents.usage_records, agents.usage_windows, agents.own_agents, agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO agents.agent_sessions (id, user_id, agent_id, guardrail, guardrail_version)
      VALUES (${ANA_SESSION}, ${ANA}, 'probe', ${sql.json({ limits: {} })}, 1),
             (${BEN_SESSION}, ${BEN}, 'probe', ${sql.json({ limits: {} })}, 1),
             (${OUTSIDER_SESSION}, ${OUTSIDER}, 'probe', ${sql.json({ limits: {} })}, 1)
    `;
    await sql`
      INSERT INTO agents.team_sessions (session_id, business_id, member_user_id, own_agent_id)
      VALUES (${ANA_SESSION}, ${BUSINESS}, ${ANA}, 'a'), (${BEN_SESSION}, ${BUSINESS}, ${BEN}, 'b'),
             (${OUTSIDER_SESSION}, ${BUSINESS}, ${OUTSIDER}, 'c')
    `;
    state = { members: [ANA, BEN] };
    store = new TeamStore(sql, teamPort(state), 'IFC');
    runs = new TeamRuns(sql, teamPort(state), {} as AgentRuntime, 'IFC');
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  const pool = (limit: string, allocations: Array<[string, string]>, revision = 1) =>
    store.setPool({
      actorUserId: OWNER,
      businessId: BUSINESS,
      limit,
      allocations: allocations.map(([memberUserId, amount]) => ({ memberUserId, amount })),
      revision,
    });
  const hold = (userId: string, sessionId: string, key: string, amount: string) =>
    spend.reserve({ userId, sessionId, reservationKey: key, assetId: 'IFC', amount, agentCap: '100', teamRun: true });
  const held = async () => {
    const [row] = await sql<Array<{ total: string }>>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM agents.spend_reservations WHERE status = 'held'`;
    return parseAmount(row!.total);
  };
  const grant = (memberUserId: string, role: string) =>
    store.setGrant({ actorUserId: OWNER, businessId: BUSINESS, memberUserId, role, allow: true, deny: false, revision: 1 });

  describe('a team hold', () => {
    it('refuses a run on a team session from any route but the team run route, whatever request id it sends', async () => {
      await pool('3', [
        [ANA, '2'],
        [BEN, '1'],
      ]);
      // Another route (own.run, complete) reaches the spend gate without the team route's flag: a hand-made `team:`
      // key does not stand in for the membership and role read.
      for (const key of ['team:forged', 'plain-key']) {
        await expect(
          spend.reserve({ userId: ANA, sessionId: ANA_SESSION, reservationKey: key, assetId: 'IFC', amount: '0.5', agentCap: '100' }),
        ).rejects.toMatchObject({ code: 'agents.session_not_found' });
      }
      // The flag alone does not either: the team route's key carries its prefix.
      await expect(
        spend.reserve({
          userId: ANA,
          sessionId: ANA_SESSION,
          reservationKey: 'plain',
          assetId: 'IFC',
          amount: '0.5',
          agentCap: '100',
          teamRun: true,
        }),
      ).rejects.toMatchObject({ code: 'agents.session_not_found' });
      expect(await held()).toBe(0n);
      expect((await hold(ANA, ANA_SESSION, 'team:a1', '0.5')).status).toBe('held');
    });

    it("refuses a run past the member's allocation and keeps the pool within its limit", async () => {
      await pool('3', [
        [ANA, '2'],
        [BEN, '1'],
      ]);
      expect((await hold(ANA, ANA_SESSION, 'team:a1', '1.5')).status).toBe('held');
      await expect(hold(ANA, ANA_SESSION, 'team:a2', '1')).rejects.toMatchObject({
        code: 'agents.team.allocation_exceeded',
        userMessageParams: { scope: 'allocation', limit: '2' },
      });
      expect(await held()).toBe(parseAmount('1.5'));
      const view = await store.view(OWNER, BUSINESS);
      expect(view.used).toBe('1.5');
      expect(view.members.find((m) => m.userId === ANA)?.used).toBe('1.5');
      expect(view.members.find((m) => m.userId === BEN)?.used).toBe('0');
    });

    it('refuses a member with no allocation, and a hold the team run route did not make', async () => {
      await pool('3', [[ANA, '2']]);
      await expect(hold(BEN, BEN_SESSION, 'team:b1', '0.1')).rejects.toMatchObject({ code: 'agents.team.allocation_unset' });
      await expect(hold(ANA, ANA_SESSION, 'plain-key', '0.1')).rejects.toMatchObject({ code: 'agents.session_not_found' });
      expect(await held()).toBe(0n);
    });

    it("limits a project's members together and not the members outside it", async () => {
      await pool('4', [
        [ANA, '2'],
        [BEN, '2'],
      ]);
      await store.createProject({
        actorUserId: OWNER,
        businessId: BUSINESS,
        name: 'TEST launch',
        limit: '1',
        memberUserIds: [ANA],
        seq: 1,
      });
      await expect(hold(ANA, ANA_SESSION, 'team:a1', '1.5')).rejects.toMatchObject({
        code: 'agents.team.project_limit_exceeded',
        userMessageParams: { scope: 'project', limit: '1' },
      });
      expect((await hold(BEN, BEN_SESSION, 'team:b1', '1.5')).status).toBe('held');
    });

    it('refuses a run once the pool limit is lowered below what was spent', async () => {
      await pool('3', [
        [ANA, '2'],
        [BEN, '1'],
      ]);
      await hold(ANA, ANA_SESSION, 'team:a1', '1.5');
      await pool(
        '1',
        [
          [ANA, '0.5'],
          [BEN, '0.5'],
        ],
        2,
      );
      await expect(hold(BEN, BEN_SESSION, 'team:b1', '0.5')).rejects.toMatchObject({ code: 'agents.team.pool_exceeded' });
    });

    it('never lets runs at once pass the pool limit (invariant)', async () => {
      await pool('2', [
        [ANA, '1'],
        [BEN, '1'],
      ]);
      const attempts = Array.from({ length: 12 }, (_, i) =>
        hold(i % 2 ? ANA : BEN, i % 2 ? ANA_SESSION : BEN_SESSION, `team:race-${i}`, '0.3').then(
          () => 'held',
          (err: { code?: string }) => err.code,
        ),
      );
      const outcomes = await Promise.all(attempts);
      expect(outcomes.filter((o) => o === 'held')).toHaveLength(6);
      expect(new Set(outcomes.filter((o) => o !== 'held'))).toEqual(new Set(['agents.team.allocation_exceeded']));
      expect(await held()).toBeLessThanOrEqual(parseAmount('2'));
    });
  });

  describe('held actions', () => {
    async function anaAgent() {
      const own = new OwnAgentStore(sql);
      return own.create(ANA, 'service-starter', 'team-test-agent-1');
    }

    it("refuses the agent's creator approving its own held action by four eyes, even holding approver", async () => {
      const agent = await anaAgent();
      await grant(ANA, 'creator');
      await grant(ANA, 'approver');
      await grant(BEN, 'approver');
      const proposed = await runs.hold({ userId: ANA, businessId: BUSINESS, agentId: agent.id, tool: 'support.kb.search', seq: 1 });
      expect(proposed.action).toMatchObject({ status: 'held', heldBy: 'agents.approval_required', creatorUserId: ANA });
      await expect(runs.approve({ userId: ANA, businessId: BUSINESS, actionId: proposed.action.id })).rejects.toMatchObject({
        code: 'agents.team_four_eyes',
      });
      const [after] = await sql`SELECT status, approved_by FROM agents.team_held_actions WHERE id = ${proposed.action.id}`;
      expect(after).toEqual({ status: 'held', approved_by: null });
      const approved = await runs.approve({ userId: BEN, businessId: BUSINESS, actionId: proposed.action.id });
      expect(approved).toMatchObject({ replayed: false, action: { status: 'approved', approvedBy: BEN } });
      expect((await runs.approve({ userId: BEN, businessId: BUSINESS, actionId: proposed.action.id })).replayed).toBe(true);
      await expect(sql`UPDATE agents.team_held_actions SET approved_by = ${ANA} WHERE id = ${proposed.action.id}`).rejects.toMatchObject({
        constraint_name: 'team_held_actions_four_eyes_ck',
      });
    });

    it('needs the creator role to propose and the approver role to approve, and only the agent’s own tools', async () => {
      const agent = await anaAgent();
      await expect(
        runs.hold({ userId: ANA, businessId: BUSINESS, agentId: agent.id, tool: 'support.kb.search', seq: 1 }),
      ).rejects.toMatchObject({
        code: 'agents.team_role_required',
      });
      await grant(ANA, 'creator');
      await expect(
        runs.hold({ userId: ANA, businessId: BUSINESS, agentId: agent.id, tool: 'ledger.transfer', seq: 1 }),
      ).rejects.toMatchObject({
        code: 'agents.team_tool_not_declared',
      });
      const proposed = await runs.hold({ userId: ANA, businessId: BUSINESS, agentId: agent.id, tool: 'support.kb.search', seq: 1 });
      expect((await runs.hold({ userId: ANA, businessId: BUSINESS, agentId: agent.id, tool: 'support.kb.search', seq: 1 })).replayed).toBe(
        true,
      );
      await expect(runs.approve({ userId: BEN, businessId: BUSINESS, actionId: proposed.action.id })).rejects.toMatchObject({
        code: 'agents.team_role_required',
      });
    });
  });

  describe('a removed member', () => {
    it('is refused at their next run before anything is held', async () => {
      await grant(BEN, 'runner');
      state.members = [ANA];
      await expect(
        runs.run({ userId: BEN, businessId: BUSINESS, sessionId: BEN_SESSION, requestId: 'req-removed-1', ask: 'TEST' }),
      ).rejects.toMatchObject({ code: 'agents.team_not_member' });
      expect(await held()).toBe(0n);
    });
  });

  describe('usage', () => {
    async function window(sessionId: string, windowId: string, sealed: boolean, charged: string, tokens: [number, number]) {
      await sql`INSERT INTO agents.usage_windows (session_id, window_id) VALUES (${sessionId}, ${windowId})`;
      await sql`
        INSERT INTO agents.usage_records (session_id, window_id, request_id, task, provider_id, model, input_tokens, output_tokens,
                                          input_price_per_million, output_price_per_million)
        VALUES (${sessionId}, ${windowId}, ${`r-${windowId}`}, 'own.run', 'mock', 'mock', ${tokens[0]}, ${tokens[1]}, 1, 2)
      `;
      if (sealed) {
        await sql`
          UPDATE agents.usage_windows SET sealed_at = now(), charged_amount = ${charged}, charge_key = ${`agents:usage:${sessionId}:${windowId}`}
           WHERE session_id = ${sessionId} AND window_id = ${windowId}
        `;
      }
    }

    it('totals sealed windows by member and task, for members of the business only', async () => {
      await window(ANA_SESSION, 'w1', true, '0.000003', [1, 1]);
      await window(ANA_SESSION, 'w2', false, '0', [5, 5]);
      await window(BEN_SESSION, 'w1', true, '0.000005', [1, 2]);
      await window(OUTSIDER_SESSION, 'w1', true, '0.000009', [3, 3]);
      const usage = await runs.usage({ userId: OWNER, businessId: BUSINESS });
      expect(usage.members.map((m) => m.userId)).toEqual([OWNER, ANA, BEN]);
      expect(usage.members.find((m) => m.userId === ANA)).toEqual({
        userId: ANA,
        windows: 1,
        sealedTotal: '0.000003',
        tasks: [{ task: 'own.run', inputTokens: 1, outputTokens: 1, cost: '0.000003' }],
      });
      expect(usage.members.find((m) => m.userId === BEN)?.sealedTotal).toBe('0.000005');
      expect(usage.sealedTotal).toBe('0.000008');
    });

    it('needs the spend reader role unless the asker is a business admin', async () => {
      await expect(runs.usage({ userId: ANA, businessId: BUSINESS })).rejects.toMatchObject({ code: 'agents.team_role_required' });
      await grant(ANA, 'spend_reader');
      expect((await runs.usage({ userId: ANA, businessId: BUSINESS })).sealedTotal).toBe('0');
      await expect(runs.usage({ userId: OUTSIDER, businessId: BUSINESS })).rejects.toMatchObject({ code: 'agents.team_not_member' });
    });
  });
}
