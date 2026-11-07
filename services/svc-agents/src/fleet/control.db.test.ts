import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { assertTestDatabase } from '@intafaced/db';
import { advanceBackgroundRuns, BackgroundRunStore } from '../own/background.js';
import { ownRouter } from '../own/routes.js';
import { fleetCsv, fleetRouter, ownAgentSwitch, productKindOff, readFleet } from './control.js';

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const SECRET = 'an-agents-fleet-control-test-secret-32';
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
const FOUNDER_A = '44444444-4444-4444-8444-444444444444';
const FOUNDER_B = '66666666-6666-4666-8666-666666666666';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OWN = '77777777-7777-4777-8777-777777777777';

function ctxOf(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes,
    tier: 'none',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-fleet',
  });
}

// Runs unconditionally: CI provides the database.
{
  const sql = postgres(URL, { max: 4, connection: { search_path: 'agents,public' }, onnotice: () => undefined });
  await assertTestDatabase(sql, 'svc-agents');
  let lock: Awaited<ReturnType<typeof sql.reserve>>;

  const founder = (userId: string, limit: number | null = 50) =>
    fleetRouter(sql, { registryLimit: limit }).createCaller(ctxOf(userId, ['admin:read', 'admin:write']));
  const customerOwn = () => ownRouter(sql).createCaller(ctxOf(CUSTOMER, ['agents:read']));

  beforeAll(async () => {
    lock = await sql.reserve();
    await lock`select pg_advisory_lock(842671)`;
    try {
      for (const migration of migrations) await sql.unsafe(migration);
    } finally {
      await lock`select pg_advisory_unlock(842671)`;
    }
  }, 120_000);

  beforeEach(async () => {
    // The same lock every svc-agents database suite holds for one test at a time: they share the test database.
    await lock`select pg_advisory_lock(842671)`;
    await sql`
      TRUNCATE agents.agent_switches, agents.agent_kind_switches, agents.agent_owner_assignments, agents.agent_sessions,
               agents.agent_definitions, agents.own_agents, agents.own_agent_background_runs RESTART IDENTITY CASCADE
    `;
    // agent_fleet_audit is append-only (its trigger refuses DELETE); TRUNCATE is the test's own reset.
    await sql`TRUNCATE agents.agent_fleet_audit`;
    const guardrail = (tools: unknown[], cap: string | null) => ({
      agentId: 'x',
      version: 1,
      tools,
      limits: { maxActionsPerSession: 5, maxOutputTokensPerCall: 100, maxSpendPerSession: cap, allowedModules: [], allowedTasks: [] },
    });
    await sql`
      INSERT INTO agents.agent_definitions (agent_id, guardrail, name, enabled) VALUES
        ('navigator', ${sql.json(guardrail([{ name: 'a', module: 'trade', mode: 'read', requiresApproval: false }], '5') as never)}, 'Navigator', true),
        ('support', ${sql.json(guardrail([{ name: 'b', module: 'support', mode: 'write', requiresApproval: true }], null) as never)}, 'Support', true)
    `;
    await sql`
      INSERT INTO agents.own_agents (id, owner_id, template, name, create_key, per_session_cap)
      VALUES (${OWN}, ${CUSTOMER}, 'service-starter', 'TEST helper', 'k1', 1)
    `;
  });

  afterEach(async () => {
    await lock`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lock.release();
    await sql.end({ timeout: 5 });
  });

  const audits = async (action: string) =>
    (
      await sql<{ operator_id: string; reason: string | null; row_count: number | null }[]>`
      SELECT operator_id, reason, row_count FROM agents.agent_fleet_audit WHERE action = ${action} ORDER BY at
    `
    ).map((row) => row);

  describe('the operator agent fleet (AG-registry-01, AG-control-02)', () => {
    it('lists every agent with owner, publisher, channels and risk signals, and counts total, ownerless and unmanaged', async () => {
      const read = await founder(FOUNDER_A).registry({});
      expect(read.counts).toEqual({ total: 3, ownerless: 2, unmanaged: 0, disabled: 0, quarantined: 0 });
      const own = read.rows.find((row) => row.ref === `own:${OWN}`)!;
      expect(own).toMatchObject({ kind: 'customer_built', ownerId: CUSTOMER, publisherId: null, channels: null, status: 'active' });
      expect(own.riskSignals).toEqual(['never_run']);
      const support = read.rows.find((row) => row.ref === 'product:support')!;
      expect(support).toMatchObject({ kind: 'product', ownerId: null, publisherId: null });
      expect(support.riskSignals).toEqual(['no_owner', 'write_tool', 'no_spend_cap', 'never_run']);
      // A filter narrows the rows, never the counts.
      const writers = await founder(FOUNDER_A).registry({ riskSignal: 'write_tool' });
      expect(writers.rows.map((row) => row.ref)).toEqual(['product:support']);
      expect(writers.filtered).toBe(1);
      expect(writers.counts.total).toBe(3);
    });

    it('refuses a blank page size by its code, and a customer by scope', async () => {
      await expect(founder(FOUNDER_A, null).registry({})).rejects.toMatchObject({ message: 'agents.registry_list_limit_unset' });
      const customer = fleetRouter(sql, { registryLimit: 50 }).createCaller(ctxOf(CUSTOMER, ['agents:read', 'agents:write']));
      await expect(customer.registry({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(customer.quarantine({ ref: `own:${OWN}`, reason: 'x', requestId: 'req-fleet-c1' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('exports the filtered registry over the full range, not the page, with one audit row per request id', async () => {
      const paged = founder(FOUNDER_A, 1);
      const out = await paged.export({ riskSignal: 'never_run', requestId: 'req-fleet-export-1' });
      expect(out.rows).toBe(3);
      expect(out.csv.trim().split('\n')).toHaveLength(4);
      expect(out.csv).toContain('not set');
      expect(out.auditRows).toBe(1);
      const again = await paged.export({ riskSignal: 'never_run', requestId: 'req-fleet-export-1' });
      expect(again.auditRows).toBe(1);
      expect(await audits('export')).toEqual([{ operator_id: FOUNDER_A, reason: null, row_count: 3 }]);
      await expect(paged.export({ riskSignal: 'write_tool', requestId: 'req-fleet-export-1' })).rejects.toMatchObject({
        message: 'agents.fleet_request_reused',
      });
      // A value with a comma or a line break stays one cell on one line.
      expect(
        fleetCsv([{ ...(await readFleet(sql))[0]!, name: 'a,b\nc' }])
          .trim()
          .split('\n'),
      ).toHaveLength(2);
    });

    it('quarantines with a reason, refuses new work as disabled, and restores only with two distinct founders', async () => {
      const ref = `own:${OWN}`;
      await expect(founder(FOUNDER_A).quarantine({ ref, reason: '  ', requestId: 'req-fleet-q0' })).rejects.toMatchObject({
        message: 'agents.reason_required',
      });
      await founder(FOUNDER_A).quarantine({ ref, reason: 'TEST quarantine', requestId: 'req-fleet-q1' });
      await founder(FOUNDER_A).quarantine({ ref, reason: 'TEST quarantine', requestId: 'req-fleet-q1' });
      expect(await audits('quarantine')).toEqual([{ operator_id: FOUNDER_A, reason: 'TEST quarantine', row_count: null }]);
      expect(await ownAgentSwitch(sql, OWN)).toBe('quarantined');
      expect(await customerOwn().status({ id: OWN })).toEqual({ status: 'quarantined' });
      const row = (await readFleet(sql)).find((r) => r.ref === ref)!;
      expect(row).toMatchObject({ status: 'quarantined', quarantine: { setBy: FOUNDER_A, reason: 'TEST quarantine' } });

      expect(await founder(FOUNDER_A).restore({ ref, requestId: 'req-fleet-r1' })).toEqual({ outcome: 'waiting_second_founder' });
      expect(await founder(FOUNDER_A).restore({ ref, requestId: 'req-fleet-r2' })).toEqual({ outcome: 'waiting_second_founder' });
      expect(await ownAgentSwitch(sql, OWN)).toBe('quarantined');
      expect(await founder(FOUNDER_B).restore({ ref, requestId: 'req-fleet-r3' })).toEqual({ outcome: 'restored' });
      expect(await ownAgentSwitch(sql, OWN)).toBe('active');
      // The second founder's same request again answers the same; a fresh one on an active agent is refused by name.
      expect(await founder(FOUNDER_B).restore({ ref, requestId: 'req-fleet-r3' })).toEqual({ outcome: 'restored' });
      await expect(founder(FOUNDER_B).restore({ ref, requestId: 'req-fleet-r4' })).rejects.toMatchObject({
        message: 'agents.fleet_not_quarantined',
      });
      expect((await audits('restore')).map((a) => a.operator_id)).toEqual([FOUNDER_B]);
    });

    it('quarantines a product agent through its own switch, which a boot re-register keeps', async () => {
      await founder(FOUNDER_A).quarantine({ ref: 'product:navigator', reason: 'TEST', requestId: 'req-fleet-q2' });
      const [def] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM agents.agent_definitions WHERE agent_id = 'navigator'`;
      expect(def!.enabled).toBe(false);
      await expect(
        founder(FOUNDER_A).quarantine({ ref: 'product:nobody', reason: 'TEST', requestId: 'req-fleet-q3' }),
      ).rejects.toMatchObject({
        message: 'agents.agent_not_found',
      });
    });

    it('kills a whole kind in one audited action that a restart keeps, and restores it with two founders', async () => {
      const out = await founder(FOUNDER_A).killKind({ kind: 'customer_built', reason: 'TEST kind kill', requestId: 'req-fleet-k1' });
      expect(out.agents).toBe(1);
      expect(await audits('kill_kind')).toEqual([{ operator_id: FOUNDER_A, reason: 'TEST kind kill', row_count: 1 }]);
      // A fresh read, as after a restart, still reads it off.
      expect((await readFleet(sql)).find((r) => r.ref === `own:${OWN}`)!.status).toBe('disabled_by_kind');
      expect(await ownAgentSwitch(sql, OWN)).toBe('disabled_by_kind');
      expect(await productKindOff(sql)).toBe(false);
      expect(await founder(FOUNDER_A).restoreKind({ kind: 'customer_built', requestId: 'req-fleet-k2' })).toEqual({
        outcome: 'waiting_second_founder',
      });
      expect(await founder(FOUNDER_B).restoreKind({ kind: 'customer_built', requestId: 'req-fleet-k3' })).toEqual({ outcome: 'restored' });
      expect(await ownAgentSwitch(sql, OWN)).toBe('active');
    });

    it('stops a background run at its next step once the agent is quarantined, and refuses a new one as disabled', async () => {
      const store = new BackgroundRunStore(sql);
      const run = await store.start(CUSTOMER, OWN, 'req-bg-1', 'TEST: check every market one by one', 10);
      expect(await store.start(CUSTOMER, OWN, 'req-bg-1', 'TEST: check every market one by one', 10)).toMatchObject({ id: run.id });
      await advanceBackgroundRuns(sql);
      await advanceBackgroundRuns(sql);
      expect((await store.list(CUSTOMER, OWN, 5))[0]).toMatchObject({ state: 'running', stepsDone: 2, cost: '0', label: 'TEST' });

      await founder(FOUNDER_A).quarantine({ ref: `own:${OWN}`, reason: 'TEST quarantine', requestId: 'req-fleet-bg' });
      await advanceBackgroundRuns(sql);
      await advanceBackgroundRuns(sql);
      expect((await store.list(CUSTOMER, OWN, 5))[0]).toMatchObject({
        state: 'stopped',
        stepsDone: 2,
        stopCode: 'agents.agent.quarantined',
      });

      const own = ownRouter(sql, undefined, undefined, { baseline: {}, background: { steps: 10, stepMs: 1000 } }).createCaller(
        ctxOf(CUSTOMER, ['agents:read', 'identity:write']),
      );
      await expect(own.backgroundRun({ id: OWN, requestId: 'req-bg-2', ask: 'x' })).rejects.toMatchObject({
        message: 'agents.agent.disabled',
      });
      const blank = ownRouter(sql).createCaller(ctxOf(CUSTOMER, ['agents:read', 'identity:write']));
      await expect(blank.backgroundRun({ id: OWN, requestId: 'req-bg-3', ask: 'x' })).rejects.toMatchObject({
        message: 'agents.background_unset',
      });
    });

    it('gives an ownerless agent an owner, and never takes an agent from its owner', async () => {
      const a = founder(FOUNDER_A);
      await a.reassign({ ref: 'product:support', ownerId: CUSTOMER, requestId: 'req-fleet-o1' });
      const read = await a.registry({});
      expect(read.counts.ownerless).toBe(1);
      expect(read.rows.find((r) => r.ref === 'product:support')!.ownerId).toBe(CUSTOMER);
      await expect(a.reassign({ ref: 'product:support', ownerId: FOUNDER_B, requestId: 'req-fleet-o2' })).rejects.toMatchObject({
        message: 'agents.fleet_owner_present',
      });
      await expect(a.reassign({ ref: `own:${OWN}`, ownerId: FOUNDER_B, requestId: 'req-fleet-o3' })).rejects.toMatchObject({
        message: 'agents.fleet_owner_present',
      });
    });
  });
}
