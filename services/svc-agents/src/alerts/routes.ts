import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import {
  OWN_AGENT_DATA_CLASSES,
  OWN_AGENT_RULE_CHOICES,
  type OwnAgentDataClass,
  type OwnAgentRuleChoice,
} from '@intafaced/contracts/agents-own';
import { stricter, type PolicyBaseline } from '../own/guardrails.js';
import { PolicyOverrideStore } from '../own/overrides.js';

/**
 * The operator's agent alert desk (AG-analytics-02, AG-guardrails-02; J-agents-16).
 *
 * Alert rules: a measure over every agent action svc-agents recorded (refusal rate and failure rate in percent of the
 * window's actions, or cost in the fee asset), a threshold the operator typed, a window length in minutes, and
 * optionally one agent. A blank threshold is refused by name and nothing is stored; 0 is a value like any other.
 *
 * The evaluator reads each rule's current window and the one before it (windows are aligned to the epoch by the
 * rule's length). A window with no actions has no rate: it fires nothing and is reported as having no rows, never as
 * 0%. A window whose measure is above the threshold writes one alert, keyed by rule and window start, so the evaluator
 * running again (the timer, a second "Evaluate now", two replicas) writes no second row for that window. An alert is
 * kept whatever happens to its delivery: no delivery vendor is connected to svc-agents, so every alert stays `pending`.
 *
 * The managed baseline is the owner's (`AGENTS_POLICY_BASELINE`); this desk shows it and sets this environment's
 * override per tool class, which may only narrow it. A rule may be checked against both before anyone stores it.
 * Nothing here moves value.
 */

export const ALERT_MEASURES = ['refusal_rate', 'failure_rate', 'cost'] as const;
export type AlertMeasure = (typeof ALERT_MEASURES)[number];

export type AlertRefusalCode =
  | 'agents.alert_threshold_required'
  | 'agents.alert_threshold_invalid'
  | 'agents.alert_rule_name_taken'
  | 'agents.alert_rule_not_found'
  | 'agents.baseline_value_unset'
  | 'agents.baseline_loosen_refused'
  | 'agents.rule_invalid'
  | 'agents.alerts_person_only';

export class AlertRefusal extends Error {
  constructor(
    readonly code: AlertRefusalCode,
    readonly detail: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = 'AlertRefusal';
  }
}

const STATUS: Record<AlertRefusalCode, TRPCError['code']> = {
  'agents.alert_threshold_required': 'BAD_REQUEST',
  'agents.alert_threshold_invalid': 'BAD_REQUEST',
  'agents.alert_rule_name_taken': 'CONFLICT',
  'agents.alert_rule_not_found': 'NOT_FOUND',
  'agents.baseline_value_unset': 'PRECONDITION_FAILED',
  'agents.baseline_loosen_refused': 'BAD_REQUEST',
  'agents.rule_invalid': 'BAD_REQUEST',
  'agents.alerts_person_only': 'FORBIDDEN',
};

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AlertRefusal)) throw err;
    throw new TRPCError({ code: STATUS[err.code], message: err.code, cause: err });
  }
}

function sqlOf(sql: Sql | undefined): Sql {
  if (!sql) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return sql;
}

/** A decimal string with no exponent, at most 18 places: how a threshold is typed and stored. */
const DECIMAL = /^\d{1,20}(\.\d{1,18})?$/;

/** Postgres numeric text without its padding zeros: "0.000…" is "0", "12.500…" is "12.5". Never through a number. */
export function trimDecimal(text: string): string {
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Checks a typed threshold: blank is refused by name; a rate is a percent from 0 to 100. Returns the decimal string. */
export function parseThreshold(measure: AlertMeasure, raw: string | undefined): string {
  const text = raw?.trim() ?? '';
  if (text === '') throw new AlertRefusal('agents.alert_threshold_required', { field: 'threshold' });
  if (!DECIMAL.test(text)) throw new AlertRefusal('agents.alert_threshold_invalid', { field: 'threshold' });
  if (measure !== 'cost') {
    const [whole = '0', fraction = ''] = text.split('.');
    const over = BigInt(whole) > 100n || (BigInt(whole) === 100n && /[1-9]/.test(fraction));
    if (over) throw new AlertRefusal('agents.alert_threshold_invalid', { field: 'threshold' });
  }
  return text;
}

const ruleView = z.object({
  id: z.string(),
  name: z.string(),
  measure: z.enum(ALERT_MEASURES),
  threshold: z.string(),
  windowMinutes: z.number().int(),
  agentId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
type RuleView = z.infer<typeof ruleView>;

const alertView = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  measure: z.enum(ALERT_MEASURES),
  windowStart: z.string(),
  windowEnd: z.string(),
  actionRows: z.number().int(),
  value: z.string(),
  threshold: z.string(),
  delivery: z.enum(['pending', 'sent']),
  createdAt: z.string(),
});

const windowView = z.object({
  ruleId: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  actionRows: z.number().int(),
  /** Null when the window has no actions: there is no rate to show. */
  value: z.string().nullable(),
  breached: z.boolean(),
  /** True only for the evaluation that wrote the window's alert; a later one finds it already kept. */
  alertWritten: z.boolean(),
});
type WindowView = z.infer<typeof windowView>;

interface RuleRow {
  id: string;
  name: string;
  measure: AlertMeasure;
  threshold: string;
  window_minutes: number;
  agent_id: string | null;
  created_by: string;
  created_at: Date;
}
const viewOfRule = (row: RuleRow): RuleView => ({
  id: row.id,
  name: row.name,
  measure: row.measure,
  threshold: trimDecimal(row.threshold),
  windowMinutes: row.window_minutes,
  agentId: row.agent_id,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const RULE_COLUMNS = 'id, name, measure, threshold::text AS threshold, window_minutes, agent_id, created_by, created_at';

async function readRules(sql: Sql): Promise<RuleView[]> {
  const rows = await sql.unsafe<RuleRow[]>(`SELECT ${RULE_COLUMNS} FROM agents.agent_alert_rules ORDER BY created_at, id`);
  return rows.map(viewOfRule);
}

/** Most alerts one read lists, newest first. Not an owner value: a bound on one desk read. */
export const ALERTS_LISTED = 200;

async function readAlerts(sql: Sql): Promise<z.infer<typeof alertView>[]> {
  const rows = await sql<
    {
      id: string;
      rule_id: string;
      rule_name: string;
      measure: AlertMeasure;
      window_start: Date;
      window_end: Date;
      action_rows: number;
      value: string;
      threshold: string;
      delivery: 'pending' | 'sent';
      created_at: Date;
    }[]
  >`
    SELECT a.id, a.rule_id, r.name AS rule_name, r.measure, a.window_start, a.window_end, a.action_rows,
           a.value::text AS value, a.threshold::text AS threshold, a.delivery, a.created_at
      FROM agents.agent_alerts a JOIN agents.agent_alert_rules r ON r.id = a.rule_id
     ORDER BY a.created_at DESC, a.id
     LIMIT ${ALERTS_LISTED}
  `;
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    measure: row.measure,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    actionRows: row.action_rows,
    value: trimDecimal(row.value),
    threshold: trimDecimal(row.threshold),
    delivery: row.delivery,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * One rule over one window `offset` windows back from the current one (0 is the window now open, 1 the one before).
 * The measure and the comparison are both Postgres numeric; nothing passes through a JS number. A breach writes its
 * alert in the same statement, once per rule and window.
 */
async function evaluateWindow(sql: Sql, rule: RuleView, offset: number): Promise<WindowView> {
  const rows = await sql<
    { window_start: Date; window_end: Date; action_rows: number; value: string | null; breached: boolean; written: boolean }[]
  >`
    WITH bounds AS (
      SELECT to_timestamp((floor(extract(epoch FROM now()) / (${rule.windowMinutes}::int * 60)) - ${offset}::int)
                          * (${rule.windowMinutes}::int * 60)) AS window_start
    ), span AS (
      SELECT window_start, window_start + make_interval(mins => ${rule.windowMinutes}::int) AS window_end FROM bounds
    ), stats AS (
      SELECT s.window_start, s.window_end, count(a.id)::int AS action_rows,
             count(a.id) FILTER (WHERE a.status = 'refused') AS refused,
             count(a.id) FILTER (WHERE a.status = 'failed') AS failed,
             coalesce(sum(a.cost), 0) AS cost
        FROM span s
        LEFT JOIN agents.agent_actions a
          ON a.occurred_at >= s.window_start AND a.occurred_at < s.window_end
         AND (${rule.agentId}::text IS NULL OR a.agent_id = ${rule.agentId}::text)
       GROUP BY s.window_start, s.window_end
    ), measured AS (
      SELECT window_start, window_end, action_rows,
             CASE WHEN action_rows = 0 THEN NULL
                  WHEN ${rule.measure}::text = 'refusal_rate' THEN round(refused * 100.0 / action_rows, 4)
                  WHEN ${rule.measure}::text = 'failure_rate' THEN round(failed * 100.0 / action_rows, 4)
                  ELSE cost END AS value
        FROM stats
    ), fired AS (
      INSERT INTO agents.agent_alerts (rule_id, window_start, window_end, action_rows, value, threshold)
      SELECT ${rule.id}::uuid, window_start, window_end, action_rows, value, ${rule.threshold}::numeric
        FROM measured WHERE value IS NOT NULL AND value > ${rule.threshold}::numeric
      ON CONFLICT (rule_id, window_start) DO NOTHING
      RETURNING id
    )
    SELECT window_start, window_end, action_rows, value::text AS value,
           coalesce(value > ${rule.threshold}::numeric, false) AS breached,
           EXISTS (SELECT 1 FROM fired) AS written
      FROM measured
  `;
  const row = rows[0]!;
  return {
    ruleId: rule.id,
    windowStart: row.window_start.toISOString(),
    windowEnd: row.window_end.toISOString(),
    actionRows: row.action_rows,
    value: row.value === null ? null : trimDecimal(row.value),
    breached: row.breached,
    alertWritten: row.written,
  };
}

/** Every rule over its current and previous window. The timer and "Evaluate now" both run this. */
export async function evaluateAlertRules(sql: Sql): Promise<WindowView[]> {
  const rules = await readRules(sql);
  const out: WindowView[] = [];
  for (const rule of rules) {
    out.push(await evaluateWindow(sql, rule, 0));
    out.push(await evaluateWindow(sql, rule, 1));
  }
  return out;
}

const looseness = (choice: OwnAgentRuleChoice): number => OWN_AGENT_RULE_CHOICES.indexOf(choice);

/** The baseline's requirement for one class: blank refuses by its code. */
function required(baseline: PolicyBaseline, dataClass: OwnAgentDataClass): OwnAgentRuleChoice {
  const value = baseline[dataClass];
  if (!value) throw new AlertRefusal('agents.baseline_value_unset', { dataClass });
  return value;
}

/**
 * A standing rule's choice against what applies here: the built-in law first (a live-write tool never acts without
 * asking), then the baseline narrowed by this environment's override. Asking first or handing off only narrows.
 */
export function checkChoice(
  dataClass: OwnAgentDataClass,
  choice: OwnAgentRuleChoice,
  baseline: PolicyBaseline,
  override: OwnAgentRuleChoice | null,
): OwnAgentRuleChoice {
  if (dataClass === 'live_write' && choice === 'act_without_asking') throw new AlertRefusal('agents.rule_invalid', { dataClass });
  const base = required(baseline, dataClass);
  const effective = override ? stricter(base, override) : base;
  if (looseness(choice) > looseness(effective))
    throw new AlertRefusal('agents.baseline_loosen_refused', { dataClass, required: effective });
  return effective;
}

const policyView = z.object({
  classes: z.array(
    z.object({
      dataClass: z.enum(OWN_AGENT_DATA_CLASSES),
      baseline: z.enum(OWN_AGENT_RULE_CHOICES).nullable(),
      override: z.enum(OWN_AGENT_RULE_CHOICES).nullable(),
      overrideSetBy: z.string().nullable(),
      overrideSetAt: z.string().nullable(),
      effective: z.enum(OWN_AGENT_RULE_CHOICES).nullable(),
    }),
  ),
});

async function readPolicy(sql: Sql, baseline: PolicyBaseline): Promise<z.infer<typeof policyView>> {
  const overrides = await new PolicyOverrideStore(sql).list();
  return {
    classes: OWN_AGENT_DATA_CLASSES.map((dataClass) => {
      const base = baseline[dataClass] ?? null;
      const override = overrides.find((o) => o.dataClass === dataClass) ?? null;
      return {
        dataClass,
        baseline: base,
        override: override?.choice ?? null,
        overrideSetBy: override?.setBy ?? null,
        overrideSetAt: override?.setAt ?? null,
        effective: base && override ? stricter(base, override.choice) : base,
      };
    }),
  };
}

export function alertsRouter(sql: Sql | undefined, baseline: PolicyBaseline) {
  // A signed-in operator's own session: never a service forwarding a principal, an API key or a sub-account.
  const operator = (scope: 'admin:read' | 'admin:write') =>
    scopedProcedure(scope, { module: 'agents', person: true }).use(({ ctx, next }) => {
      if (ctx.principal.kid || ctx.principal.sub_account) throw new TRPCError({ code: 'FORBIDDEN', message: 'agents.alerts_person_only' });
      return next();
    });

  return router({
    /** The stored rules, oldest first, and the newest alerts with their delivery state. */
    desk: operator('admin:read')
      .output(z.object({ rules: z.array(ruleView), alerts: z.array(alertView), alertsListed: z.number().int() }))
      .query(() =>
        guard(async () => {
          const db = sqlOf(sql);
          return { rules: await readRules(db), alerts: await readAlerts(db), alertsListed: ALERTS_LISTED };
        }),
      ),

    /** Stores one rule. A blank threshold is refused by name before anything is written; 0 is stored as 0. */
    createRule: operator('admin:write')
      .input(
        z.object({
          name: z.string().trim().min(1).max(80),
          measure: z.enum(ALERT_MEASURES),
          threshold: z.string().max(60).optional(),
          windowMinutes: z.number().int().min(1).max(1440),
          agentId: z.string().trim().min(1).max(120).optional(),
        }),
      )
      .output(ruleView)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const threshold = parseThreshold(input.measure, input.threshold);
          const rows = await sqlOf(sql).unsafe<RuleRow[]>(
            `INSERT INTO agents.agent_alert_rules (name, measure, threshold, window_minutes, agent_id, created_by)
             VALUES ($1, $2, $3::numeric, $4, $5, $6)
             ON CONFLICT (name) DO NOTHING
             RETURNING ${RULE_COLUMNS}`,
            [input.name, input.measure, threshold, input.windowMinutes, input.agentId ?? null, ctx.principal.userId],
          );
          if (!rows[0]) throw new AlertRefusal('agents.alert_rule_name_taken');
          return viewOfRule(rows[0]);
        }),
      ),

    /** Runs the evaluator now over every rule's current and previous window, and says what each window came to. */
    evaluate: operator('admin:write')
      .output(z.object({ windows: z.array(windowView) }))
      .mutation(() => guard(async () => ({ windows: await evaluateAlertRules(sqlOf(sql)) }))),

    /** The owner's managed baseline per class, this environment's override, and the stricter of the two. */
    policy: operator('admin:read')
      .output(policyView)
      .query(() => guard(async () => readPolicy(sqlOf(sql), baseline))),

    /** Sets this environment's override for one class. One looser than the baseline is refused and nothing is stored. */
    setOverride: operator('admin:write')
      .input(z.object({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES), choice: z.enum(OWN_AGENT_RULE_CHOICES) }))
      .output(policyView)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const db = sqlOf(sql);
          const base = required(baseline, input.dataClass);
          if (looseness(input.choice) > looseness(base)) {
            throw new AlertRefusal('agents.baseline_loosen_refused', { dataClass: input.dataClass, required: base });
          }
          await new PolicyOverrideStore(db).set(input.dataClass, input.choice, ctx.principal.userId);
          return readPolicy(db, baseline);
        }),
      ),

    /** Checks a person's standing rule against the baseline and this environment's override. Stores nothing. */
    checkRule: operator('admin:read')
      .input(z.object({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES), choice: z.enum(OWN_AGENT_RULE_CHOICES) }))
      .output(z.object({ verdict: z.literal('allowed'), effective: z.enum(OWN_AGENT_RULE_CHOICES) }))
      .mutation(({ input }) =>
        guard(async () => {
          const override = await new PolicyOverrideStore(sqlOf(sql)).forClass(input.dataClass);
          return { verdict: 'allowed' as const, effective: checkChoice(input.dataClass, input.choice, baseline, override) };
        }),
      ),
  });
}
