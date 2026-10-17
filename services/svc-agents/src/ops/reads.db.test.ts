/**
 * Operator session list, customer catalogue, and the caller's own session list.
 * Postgres via TEST_DATABASE_URL (createTestDatabase isolates a *_test database).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { ModelGateway } from '../gateway/gateway.js';
import { DEFAULT_ROUTING_TABLE } from '../gateway/routing.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const SECRET = 'agents-reads-backend-edge-secret-32';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const GUARDRAIL = '{"limits":{"maxActionsPerSession":1},"tools":[]}';

function callerFor(userId: string, scopes: string[]) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

const db: TestDatabase = await createTestDatabase({ service: 'agents', url: adminUrl(), migrations: MIGRATIONS });
const sql = db.sql;

const deps: AgentsRouterDeps = {
  runtime: {} as AgentsRouterDeps['runtime'],
  gateway: new ModelGateway([new MockModelProvider({ id: 'primary' })], DEFAULT_ROUTING_TABLE),
  meter: {} as AgentsRouterDeps['meter'],
  feeAssetId: 'FEE',
  sql,
};
const router = createAgentsRouter(deps);
const operator = router.createCaller(callerFor(USER_A, ['admin:read']));
const customerA = router.createCaller(callerFor(USER_A, ['agents:read']));
const customerB = router.createCaller(callerFor(USER_B, ['agents:read']));
const noAgentsRead = router.createCaller(callerFor(USER_A, ['admin:read']));

beforeEach(async () => {
  await db.truncateAll();
});

async function insertSession(input: {
  userId: string;
  agentId: string;
  status: 'open' | 'closed';
  openedAt: string;
  actions?: number;
}): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version, status, opened_at, closed_at)
    VALUES (
      ${input.userId},
      ${input.agentId},
      ${sql.json(JSON.parse(GUARDRAIL))},
      1,
      ${input.status}::agents.session_status,
      ${input.openedAt}::text::timestamptz,
      ${input.status === 'closed' ? input.openedAt : null}::text::timestamptz
    )
    RETURNING id
  `;
  const id = rows[0]!.id;
  const actions = input.actions ?? 0;
  for (let sequence = 1; sequence <= actions; sequence += 1) {
    await sql`
      INSERT INTO agents.agent_actions (
        session_id, user_id, agent_id, sequence, kind, status, user_message_key, hash
      ) VALUES (
        ${id}, ${input.userId}, ${input.agentId}, ${sequence},
        'tool_call'::agents.action_kind, 'executed'::agents.action_status,
        'agents.action.executed', ${`hash-${id}-${sequence}`}
      )
    `;
  }
  return id;
}

describe('ops.sessions and session.mine', () => {
  it('lists two users with exact per-asset spend, nulls an unsettled session, and pages', async () => {
    const settled = await insertSession({
      userId: USER_A,
      agentId: 'navigator',
      status: 'closed',
      openedAt: '2026-01-03T00:00:00.000Z',
      actions: 2,
    });
    await sql`
      INSERT INTO agents.usage_windows (session_id, window_id, sealed_at, charged_amount, charged_asset, charge_key)
      VALUES
        (${settled}, 'w1', now(), ${'1.25'}::numeric, 'BBB', 'k1'),
        (${settled}, 'w2', now(), ${'2.5'}::numeric, 'AAA', 'k2'),
        (${settled}, 'w3', now(), ${'0.25'}::numeric, 'AAA', 'k3')
    `;
    const unsettled = await insertSession({
      userId: USER_B,
      agentId: 'support',
      status: 'open',
      openedAt: '2026-01-02T00:00:00.000Z',
      actions: 1,
    });
    await sql`
      INSERT INTO agents.usage_windows (session_id, window_id)
      VALUES (${unsettled}, 'open-1')
    `;
    const older = await insertSession({
      userId: USER_A,
      agentId: 'scanner',
      status: 'open',
      openedAt: '2026-01-01T00:00:00.000Z',
    });

    const first = await operator.ops.sessions({ limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([settled, unsettled]);
    expect(first.items[0]).toMatchObject({
      agentId: 'navigator',
      userId: USER_A,
      actionCount: 2,
      spend: [
        { assetId: 'AAA', amount: '2.75' },
        { assetId: 'BBB', amount: '1.25' },
      ],
      spendReason: null,
    });
    await expect(sql`
      UPDATE agents.usage_windows SET charged_asset = 'ZZZ' WHERE session_id = ${settled}
    `).rejects.toThrow(/already settled/);
    expect(first.items[1]).toMatchObject({
      userId: USER_B,
      spend: null,
      spendReason: 'no_settled_window',
      actionCount: 1,
    });
    expect(first.nextCursor).toBeTruthy();

    const second = await operator.ops.sessions({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((row) => row.id)).toEqual([older]);
    expect(second.nextCursor).toBeNull();

    const onlyA = await operator.ops.sessions({ limit: 10, userId: USER_A });
    expect(onlyA.items.every((row) => row.userId === USER_A)).toBe(true);
    expect(onlyA.items).toHaveLength(2);

    const support = await operator.ops.sessions({ limit: 10, agentId: 'support', status: 'open' });
    expect(support.items.map((row) => row.id)).toEqual([unsettled]);

    const day = await operator.ops.sessions({
      limit: 10,
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    });
    expect(day.items.map((row) => row.id)).toEqual([unsettled]);

    await expect(operator.ops.sessions({})).rejects.toMatchObject({
      message: 'agents.refused.log_mine_limit_unset',
    });
    await expect(customerA.ops.sessions({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const mineA = await customerA.session.mine({ limit: 10 });
    expect(mineA.items.map((row) => row.id).sort()).toEqual([settled, older].sort());
    expect(mineA.items.find((row) => row.id === settled)?.spend).toEqual([
      { assetId: 'AAA', amount: '2.75' },
      { assetId: 'BBB', amount: '1.25' },
    ]);
    expect(mineA.items.every((row) => row.id !== unsettled)).toBe(true);

    const mineB = await customerB.session.mine({ limit: 10 });
    expect(mineB.items.map((row) => row.id)).toEqual([unsettled]);
    expect(mineB.items[0]?.spend).toBeNull();
    expect(mineB.items[0]?.spendReason).toBe('no_settled_window');
  });

  it('pages a caller past 500 of their own sessions and hides the other user', async () => {
    await sql`
      INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version, status, opened_at)
      SELECT ${USER_A}, 'navigator', ${sql.json(JSON.parse(GUARDRAIL))}, 1, 'open'::agents.session_status,
             timestamptz '2026-06-01T00:00:00.000Z' - (g || ' seconds')::interval
        FROM generate_series(1, 501) AS g
    `;
    const foreign = await insertSession({
      userId: USER_B,
      agentId: 'navigator',
      status: 'open',
      openedAt: '2026-07-01T00:00:00.000Z',
    });

    const first = await customerA.session.mine({ limit: 500 });
    expect(first.items).toHaveLength(500);
    expect(first.items.some((row) => row.id === foreign)).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    const second = await customerA.session.mine({ limit: 500, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(foreign);
    expect(second.nextCursor).toBeNull();

    const operatorPage = await operator.ops.sessions({ limit: 10, userId: USER_A });
    expect(operatorPage.items.some((row) => row.userId === USER_B)).toBe(false);
  });

  it('returns every session that shares a millisecond, once, in opened_at DESC, id DESC order', async () => {
    const later = await insertSession({
      userId: USER_A,
      agentId: 'navigator',
      status: 'open',
      openedAt: '2026-01-02T00:00:00.123700Z',
    });
    const tieA = await insertSession({
      userId: USER_A,
      agentId: 'navigator',
      status: 'open',
      openedAt: '2026-01-02T00:00:00.123456Z',
    });
    const tieB = await insertSession({
      userId: USER_A,
      agentId: 'navigator',
      status: 'open',
      openedAt: '2026-01-02T00:00:00.123456Z',
    });
    const earlier = await insertSession({
      userId: USER_A,
      agentId: 'navigator',
      status: 'open',
      openedAt: '2026-01-02T00:00:00.123400Z',
    });
    const tieOrder = await sql<Array<{ id: string }>>`
      SELECT id::text AS id
        FROM (VALUES (${tieA}::uuid), (${tieB}::uuid)) AS tie(id)
       ORDER BY id DESC
    `;
    const stored = await sql<Array<{ id: string; us: string }>>`
      SELECT id::text AS id,
             (extract(epoch from opened_at) * 1000000)::bigint::text AS us
        FROM agents.agent_sessions
       WHERE user_id = ${USER_A}
       ORDER BY opened_at DESC, id DESC
    `;
    const expected = [later, tieOrder[0]!.id, tieOrder[1]!.id, earlier];
    expect(stored.map((row) => row.id)).toEqual(expected);
    expect(new Set(stored.map((row) => row.us)).size).toBe(3);
    expect(stored[1]?.us).toBe(stored[2]?.us);
    expect(BigInt(stored[0]!.us) > BigInt(stored[1]!.us)).toBe(true);
    expect(BigInt(stored[1]!.us) > BigInt(stored[3]!.us)).toBe(true);

    async function pageAll(
      read: (cursor?: string) => Promise<{ items: readonly { id: string }[]; nextCursor: string | null }>,
    ): Promise<string[]> {
      const ids: string[] = [];
      let cursor: string | undefined;
      let nextCursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const result = await read(cursor);
        ids.push(...result.items.map((row) => row.id));
        nextCursor = result.nextCursor;
        if (nextCursor === null) break;
        cursor = nextCursor;
      }
      expect(nextCursor).toBeNull();
      expect(ids).toEqual(expected);
      return ids;
    }

    await pageAll((cursor) => customerA.session.mine({ limit: 1, cursor }));
    await pageAll((cursor) => operator.ops.sessions({ limit: 1, cursor }));
  });
});

describe('agent.catalogue', () => {
  it('lists stored fields, keeps a null purpose null, and refuses a session without agents:read', async () => {
    await sql`
      INSERT INTO agents.agent_definitions (agent_id, version, guardrail, enabled, name, purpose)
      VALUES
        ('alpha', 2, ${sql.json(JSON.parse(GUARDRAIL))}, true, 'Alpha', 'Reads markets'),
        ('beta', 4, ${sql.json(JSON.parse(GUARDRAIL))}, false, 'Beta', NULL)
    `;
    const rows = await customerA.agent.catalogue();
    expect(rows).toEqual([
      { agentId: 'alpha', name: 'Alpha', purpose: 'Reads markets', enabled: true, version: 2 },
      { agentId: 'beta', name: 'Beta', purpose: null, enabled: false, version: 4 },
    ]);
    await expect(noAgentsRead.agent.catalogue()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
