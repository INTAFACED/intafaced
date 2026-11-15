import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { assertTestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { effectiveRequirement, type PolicyBaseline } from '../own/guardrails.js';
import { MemoryEventBus } from '@intafaced/events';
import { alertsRouter, checkChoice, parseThreshold, publishPendingAgentAlerts, trimDecimal, AlertRefusal } from './routes.js';

/**
 * The agent alert desk on real Postgres (J-agents-16): a blank threshold stores nothing and 0 is a value; the evaluator
 * run twice over a breached window keeps one alert; an empty window fires nothing and has no rate; every alert is kept
 * with delivery pending; an override never loosens the managed baseline, and the tool gate takes the stricter of both.
 */

const URL = process.env.TEST_DATABASE_URL_AGENTS ?? 'postgres://svc_agents:svc_agents@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const OPERATOR = '51515151-5151-4151-8151-515151515151';
const SECRET = 'an-agents-alerts-db-test-secret-32chars';
const BASELINE: PolicyBaseline = {
  own_data: 'act_on_request',
  market_data: 'act_on_request',
  draft_write: 'ask_before',
  live_write: 'act_on_request',
};

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
function signed(scopes: string[]) {
  const raw = encodePrincipal({
    sub: OPERATOR,
    userId: OPERATOR,
    sid: '52525252-5252-4252-8252-525252525252',
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
    id: 'req-alerts',
  });
}

/** A bus that refuses every publish, as one in an outage does. */
class BrokenBus extends MemoryEventBus {
  override async publish(): Promise<never> {
    throw new Error('bus down');
  }
}

const refusalOf = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AlertRefusal) return err.code;
    throw err;
  }
  return null;
};

describe('alert thresholds and rule checks (pure)', () => {
  it('a blank threshold is refused by name; 0 is a value; a rate stays within 0 to 100', () => {
    expect(refusalOf(() => parseThreshold('refusal_rate', undefined))).toBe('agents.alert_threshold_required');
    expect(refusalOf(() => parseThreshold('refusal_rate', '  '))).toBe('agents.alert_threshold_required');
    expect(parseThreshold('refusal_rate', '0')).toBe('0');
    expect(parseThreshold('refusal_rate', '100')).toBe('100');
    expect(refusalOf(() => parseThreshold('refusal_rate', '100.01'))).toBe('agents.alert_threshold_invalid');
    expect(refusalOf(() => parseThreshold('failure_rate', '-1'))).toBe('agents.alert_threshold_invalid');
    expect(refusalOf(() => parseThreshold('cost', '1e3'))).toBe('agents.alert_threshold_invalid');
    expect(parseThreshold('cost', '250.5')).toBe('250.5');
    expect(trimDecimal('0.000000000000000000')).toBe('0');
    expect(trimDecimal('12.500000000000000000')).toBe('12.5');
    expect(trimDecimal('40')).toBe('40');
  });

  it('a rule looser than the baseline, or than an override that narrows it, is refused; the built-in law comes first', () => {
    expect(checkChoice('own_data', 'act_on_request', BASELINE, null)).toBe('act_on_request');
    expect(refusalOf(() => checkChoice('own_data', 'act_without_asking', BASELINE, null))).toBe('agents.baseline_loosen_refused');
    expect(refusalOf(() => checkChoice('own_data', 'act_on_request', BASELINE, 'ask_before'))).toBe('agents.baseline_loosen_refused');
    // An override looser than the baseline (one stored before the owner tightened it) never loosens it.
    expect(refusalOf(() => checkChoice('draft_write', 'act_on_request', BASELINE, 'act_without_asking'))).toBe(
      'agents.baseline_loosen_refused',
    );
    expect(refusalOf(() => checkChoice('live_write', 'act_without_asking', BASELINE, null))).toBe('agents.rule_invalid');
    expect(refusalOf(() => checkChoice('own_data', 'hand_off', {}, null))).toBe('agents.baseline_value_unset');
  });
});

// Runs unconditionally: CI provides the database, and without one this suite fails rather than skips.
{
  const sql = postgres(URL, {
    max: 4,
    connection: { search_path: 'agents,public', application_name: 'svc-agents-alerts-test' },
    onnotice: () => undefined,
  });
  await assertTestDatabase(sql, 'svc-agents');

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
      TRUNCATE agents.agent_alerts, agents.agent_alert_settings, agents.agent_alert_rules, agents.agent_policy_overrides, agents.agent_actions,
               agents.agent_sessions
      RESTART IDENTITY CASCADE
    `;
  }, 30_000);

  afterEach(async () => {
    await lockConn`select pg_advisory_unlock(842671)`;
  });

  afterAll(async () => {
    lockConn.release();
    await sql.end({ timeout: 5 });
  });

  let bus = new MemoryEventBus('svc-agents');
  const desk = (scopes = ['admin:read', 'admin:write']) =>
    alertsRouter(sql, BASELINE, () => publishPendingAgentAlerts(sql, bus)).createCaller(signed(scopes));

  /** Stores `n` actions of `status` for `agentId` in a session of their own, now, as the runtime would. */
  async function actions(agentId: string, status: 'executed' | 'refused' | 'failed', n: number, cost = '0') {
    const [session] = await sql<{ id: string }[]>`
      INSERT INTO agents.agent_sessions (user_id, agent_id, guardrail, guardrail_version)
      VALUES (${OPERATOR}, ${agentId}, ${sql.json({ limits: {}, tools: [] })}, 1) RETURNING id::text
    `;
    for (let i = 0; i < n; i += 1) {
      await sql`
        INSERT INTO agents.agent_actions
          (session_id, user_id, agent_id, sequence, kind, status, task, refusal_code, cost, user_message_key, hash)
        VALUES (${session!.id}, ${OPERATOR}, ${agentId}, ${i}, 'completion', ${status}, 'plan',
                ${status === 'refused' ? 'agents.refused.task_not_allowed' : null}, ${status === 'refused' ? '0' : cost}::numeric,
                'agents.test', ${`h:${session!.id}:${i}`})
      `;
    }
  }

  describe('the agent alert desk on Postgres (J-agents-16)', () => {
    it('#1 a blank threshold stores nothing; a threshold of 0 is stored as 0', async () => {
      const ops = desk();
      await expect(ops.createRule({ name: 'TEST refusals', measure: 'refusal_rate', windowMinutes: 60 })).rejects.toThrow(
        'agents.alert_threshold_required',
      );
      expect((await ops.desk()).rules).toHaveLength(0);
      const rule = await ops.createRule({ name: 'TEST refusals', measure: 'refusal_rate', threshold: '0', windowMinutes: 60 });
      expect(rule.threshold).toBe('0');
      expect((await ops.desk()).rules.map((r) => [r.name, r.threshold])).toEqual([['TEST refusals', '0']]);
      await expect(ops.createRule({ name: 'TEST refusals', measure: 'cost', threshold: '1', windowMinutes: 5 })).rejects.toThrow(
        'agents.alert_rule_name_taken',
      );
    });

    it('#2 two evaluations of a breached window keep one alert, handed to notifications once; an empty window fires nothing and has no rate', async () => {
      bus = new MemoryEventBus('svc-agents');
      const ops = desk();
      await actions('probe', 'executed', 3);
      await actions('probe', 'refused', 1);
      const breached = await ops.createRule({ name: 'TEST refusals', measure: 'refusal_rate', threshold: '0', windowMinutes: 60 });
      const quiet = await ops.createRule({
        name: 'TEST quiet',
        measure: 'refusal_rate',
        threshold: '0',
        windowMinutes: 60,
        agentId: 'TEST-no-actions',
      });
      const first = await ops.evaluate();
      const second = await ops.evaluate();
      const current = (run: typeof first, ruleId: string) => run.windows.filter((w) => w.ruleId === ruleId)[0]!;
      expect(current(first, breached.id)).toMatchObject({ actionRows: 4, value: '25', breached: true, alertWritten: true });
      expect(current(second, breached.id)).toMatchObject({ actionRows: 4, value: '25', breached: true, alertWritten: false });
      expect(current(first, quiet.id)).toMatchObject({ actionRows: 0, value: null, breached: false, alertWritten: false });
      const { alerts } = await ops.desk();
      expect(alerts.map((a) => [a.ruleName, a.actionRows, a.value, a.threshold, a.delivery])).toEqual([
        ['TEST refusals', 4, '25', '0', 'handed_off'],
      ]);
      // Handed over once, on the rule and window's business key, to the operator who stored the rule.
      const sent = bus.emitted('agentAlertFired');
      expect(sent.map((e) => [e.payload.userId, e.payload.ruleName, e.payload.value, e.payload.threshold])).toEqual([
        [OPERATOR, 'TEST refusals', '25', '0'],
      ]);
      expect(sent[0]!.payload.alertKey).toBe(`agents.alert:${breached.id}:${alerts[0]!.windowStart}`);
      const stored = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agents.agent_alerts`;
      expect(stored[0]?.n).toBe(1);
    });

    it('#3 with notifications down an alert is kept pending and nothing is sent; back on, it is handed over', async () => {
      bus = new MemoryEventBus('svc-agents');
      const ops = desk();
      expect((await ops.desk()).notifications).toEqual({ state: 'on', setBy: null, setAt: null });
      expect((await ops.setNotifications({ state: 'down' })).state).toBe('down');
      await actions('probe', 'refused', 1);
      await ops.createRule({ name: 'TEST while down', measure: 'refusal_rate', threshold: '0', windowMinutes: 60 });
      await ops.evaluate();
      expect((await ops.desk()).alerts.map((a) => [a.ruleName, a.delivery, a.handedOffAt])).toEqual([['TEST while down', 'pending', null]]);
      expect(bus.emitted('agentAlertFired')).toHaveLength(0);
      // A publish that fails leaves it pending too.
      const broken = new BrokenBus('svc-agents');
      await sql`UPDATE agents.agent_alert_settings SET notifications = 'on'`;
      expect(await publishPendingAgentAlerts(sql, broken)).toBe(0);
      await sql`UPDATE agents.agent_alert_settings SET notifications = 'down'`;
      expect((await ops.desk()).alerts[0]!.delivery).toBe('pending');
      await ops.setNotifications({ state: 'on' });
      const kept = (await ops.desk()).alerts[0]!;
      expect(kept.delivery).toBe('handed_off');
      expect(kept.handedOffAt).not.toBeNull();
      expect(bus.emitted('agentAlertFired')).toHaveLength(1);
    });

    it('failure rate and cost read their own columns; a value at the threshold is not above it', async () => {
      const ops = desk();
      await actions('probe', 'failed', 1);
      await actions('probe', 'executed', 1, '0.75');
      await ops.createRule({ name: 'TEST failures at 50', measure: 'failure_rate', threshold: '50', windowMinutes: 30 });
      await ops.createRule({ name: 'TEST failures over 49.5', measure: 'failure_rate', threshold: '49.5', windowMinutes: 30 });
      await ops.createRule({ name: 'TEST cost at 0.75', measure: 'cost', threshold: '0.75', windowMinutes: 30 });
      await ops.createRule({ name: 'TEST cost over 0.5', measure: 'cost', threshold: '0.5', windowMinutes: 30 });
      await ops.evaluate();
      expect((await ops.desk()).alerts.map((a) => [a.ruleName, a.value]).sort()).toEqual([
        ['TEST cost over 0.5', '0.75'],
        ['TEST failures over 49.5', '50'],
      ]);
    });

    it('#4 the baseline is shown; an override looser than it is refused and not stored; a narrower one narrows the gate', async () => {
      const ops = desk();
      const before = await ops.policy();
      expect(before.classes.find((c) => c.dataClass === 'own_data')).toMatchObject({ baseline: 'act_on_request', override: null });
      await expect(ops.setOverride({ dataClass: 'own_data', choice: 'act_without_asking' })).rejects.toThrow(
        'agents.baseline_loosen_refused',
      );
      expect((await ops.policy()).classes.every((c) => c.override === null)).toBe(true);
      expect(await effectiveRequirement(sql, BASELINE, 'own_data')).toBe('act_on_request');
      const after = await ops.setOverride({ dataClass: 'own_data', choice: 'ask_before' });
      expect(after.classes.find((c) => c.dataClass === 'own_data')).toMatchObject({
        baseline: 'act_on_request',
        override: 'ask_before',
        effective: 'ask_before',
        overrideSetBy: OPERATOR,
      });
      expect(await effectiveRequirement(sql, BASELINE, 'own_data')).toBe('ask_before');
      // A blank baseline stays blank whatever the override says.
      expect(await effectiveRequirement(sql, {}, 'own_data')).toBeNull();
    });

    it('#5 a rule that loosens the baseline is refused; a write needs admin:write', async () => {
      await expect(desk().checkRule({ dataClass: 'own_data', choice: 'act_without_asking' })).rejects.toThrow(
        'agents.baseline_loosen_refused',
      );
      expect(await desk().checkRule({ dataClass: 'own_data', choice: 'ask_before' })).toEqual({
        verdict: 'allowed',
        effective: 'act_on_request',
      });
      const reader = desk(['admin:read']);
      await expect(reader.createRule({ name: 'TEST', measure: 'cost', threshold: '1', windowMinutes: 5 })).rejects.toThrow();
      await expect(reader.setOverride({ dataClass: 'own_data', choice: 'ask_before' })).rejects.toThrow();
    });
  });
}
