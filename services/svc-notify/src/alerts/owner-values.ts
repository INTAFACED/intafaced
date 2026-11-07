/**
 * The alert owner values the founder sets on the charts settings page (C-ops-04, C-alerts-scan-03; J-charts-desk-18 #5 #6):
 *
 *   priceQuota       most price alerts one person may hold open, per plan
 *   triggerLogDays   how many days the alert trigger log is kept
 *
 *   notify.opsAlertOwnerValues.get   admin:read   every value, where it comes from, who set it and when, and the history
 *   notify.opsAlertOwnerValues.set   admin:write  one value per write, with a reason; a blank value clears it to "not set"
 *
 * A plan is the account plan of the owner's plan table (BK-acct-04, `BANK_PLANS_JSON` in svc-bank; svc-notify reads the
 * same table as NOTIFY_ACCOUNT_PLANS_JSON). It is the product's one plan. Nobody can subscribe yet, so every person is on
 * the table's default plan, the bank's own rule. A blank table is "not set": no plan quota applies and the page says so.
 * Each write is one append-only row, so the rows are the audit: who,
 * when, the old and new value, and the reason, all in one insert. A value the page has never written falls back to the
 * deployment's own setting (NOTIFY_ALERT_MAX_ACTIVE_PRICE, NOTIFY_ALERT_TRIGGER_LOG_DAYS), and the page says which one
 * applies. A cleared value is "not set" and refuses the action that needs it; nothing here holds a default number.
 */
import type { Sql } from 'postgres';
import { hasScope, type Principal } from '@intafaced/auth';

/** A plan id of the owner's table: lower case, as svc-bank parses it. */
export type AlertPlan = string;
export const PLAN_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The owner's account plans, as much of the table as alerts need: the ids, their names, and the default. */
export interface AccountPlans {
  readonly defaultPlanId: string;
  readonly plans: readonly { readonly id: string; readonly name: string }[];
}

/**
 * The owner's plan table from its JSON (`{ defaultPlanId, plans: [{ id, name, … }] }`, the bank's shape), or null when it
 * is blank or not in shape: then no plan is known and the page says "not set".
 */
export function parseAccountPlans(raw: string | undefined | null): AccountPlans | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = parsed as { defaultPlanId?: unknown; plans?: unknown };
  if (!Array.isArray(o.plans) || o.plans.length === 0 || typeof o.defaultPlanId !== 'string') return null;
  const plans: { id: string; name: string }[] = [];
  for (const p of o.plans as Array<Record<string, unknown>>) {
    if (typeof p.id !== 'string' || !PLAN_ID.test(p.id) || typeof p.name !== 'string' || p.name.trim() === '' || p.name.length > 80) {
      return null;
    }
    plans.push({ id: p.id, name: p.name });
  }
  if (new Set(plans.map((p) => p.id)).size !== plans.length || !plans.some((p) => p.id === o.defaultPlanId)) return null;
  return { defaultPlanId: o.defaultPlanId, plans };
}

export const ALERT_OWNER_KEYS = ['priceQuota', 'triggerLogDays'] as const;
export type AlertOwnerKey = (typeof ALERT_OWNER_KEYS)[number];

/** Schema bounds for a set value; they bound what may be stored, they are not defaults. */
export const ALERT_OWNER_BOUNDS: Readonly<Record<AlertOwnerKey, number>> = { priceQuota: 10_000, triggerLogDays: 3_650 };

export const NOTIFY_OWNER_VALUE_STALE = 'notify.owner_value_stale' as const;
export const NOTIFY_OWNER_VALUE_INVALID = 'notify.owner_value_invalid' as const;
export const NOTIFY_OWNER_VALUE_REASON_REQUIRED = 'notify.owner_value_reason_required' as const;
export const NOTIFY_OWNER_VALUE_FORBIDDEN = 'notify.owner_value_forbidden' as const;
export const OWNER_REASON_MIN = 12;
const HISTORY_LIMIT = 50;

export class AlertOwnerValueError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AlertOwnerValueError';
  }
}

/** What the deployment's own settings say, used only for a value the page has never written. */
export interface DeploymentAlertValues {
  readonly maxActivePrice: number | null;
  readonly triggerLogDays: number | null;
}

export interface OwnerValueView {
  readonly key: AlertOwnerKey;
  /** The plan for a quota; null for the retention. */
  readonly plan: AlertPlan | null;
  /** What applies now; null is "not set". */
  readonly value: number | null;
  /** `page`: set on the settings page. `deployment`: never set on the page, the deployment's setting applies. */
  readonly source: 'page' | 'deployment';
  /** The id of the newest page write for this value, or "0"; a write must name it. */
  readonly version: string;
  readonly operatorId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export interface OwnerValueChange {
  readonly id: string;
  readonly key: AlertOwnerKey;
  readonly plan: AlertPlan | null;
  readonly oldValue: number | null;
  readonly newValue: number | null;
  readonly operatorId: string;
  readonly reason: string;
  readonly at: string;
}

export interface AlertOwnerValuesView {
  /** The owner's plans, or null while the plan table is not set. */
  readonly plans: AccountPlans | null;
  readonly quotas: readonly OwnerValueView[];
  readonly triggerLogDays: OwnerValueView;
  /** Newest first. */
  readonly history: readonly OwnerValueChange[];
  readonly canWrite: boolean;
}

export interface AlertOwnerValueSet {
  readonly key: AlertOwnerKey;
  readonly plan?: AlertPlan | null;
  readonly value: number | null;
  readonly expectedVersion: string;
  readonly reason: string;
  readonly clientRequestId: string;
}

type Row = {
  id: string;
  key: AlertOwnerKey;
  plan: AlertPlan | null;
  value: number | null;
  old_value: number | null;
  operator_id: string;
  reason: string;
  created_at: Date;
};

const slot = (key: AlertOwnerKey, plan: AlertPlan | null) => `${key}:${plan ?? ''}`;

/**
 * The plan a person is on: the account's own plan id where one can be read, else the default plan. No subscription can be
 * made yet (svc-bank, BK-acct-04), so it is the default for everyone. Null while the plan table is not set.
 */
export function planOf(plans: AccountPlans | null, accountPlanId?: string | null): AlertPlan | null {
  if (!plans) return null;
  if (accountPlanId && plans.plans.some((p) => p.id === accountPlanId)) return accountPlanId;
  return plans.defaultPlanId;
}

export class AlertOwnerValues {
  constructor(
    private readonly sql: Sql,
    private readonly deployment: DeploymentAlertValues,
    private readonly plans: AccountPlans | null,
  ) {}

  /** The plan this person's quota is read for (the default plan for everyone today), or null while no plan table is set. */
  planFor(accountPlanId?: string | null): AlertPlan | null {
    return planOf(this.plans, accountPlanId);
  }

  private async latest(): Promise<Map<string, Row>> {
    const rows = await this.sql<Row[]>`
      SELECT DISTINCT ON (key, coalesce(plan, ''))
             id::text AS id, key, plan, value, old_value, operator_id, reason, created_at
        FROM notify.alert_owner_values
       ORDER BY key, coalesce(plan, ''), id DESC`;
    return new Map(rows.map((r) => [slot(r.key, r.plan), r]));
  }

  private viewOf(key: AlertOwnerKey, plan: AlertPlan | null, row: Row | undefined): OwnerValueView {
    if (row) {
      return {
        key,
        plan,
        value: row.value,
        source: 'page',
        version: row.id,
        operatorId: row.operator_id,
        reason: row.reason,
        updatedAt: row.created_at.toISOString(),
      };
    }
    const value = key === 'priceQuota' ? this.deployment.maxActivePrice : this.deployment.triggerLogDays;
    return { key, plan, value, source: 'deployment', version: '0', operatorId: null, reason: null, updatedAt: null };
  }

  /** What applies to a person on `plan` now. One read; nothing is cached, so a saved value applies to the next create. */
  async effective(plan: AlertPlan | null): Promise<{ maxActivePrice: number | null; triggerLogDays: number | null }> {
    const latest = await this.latest();
    return {
      // No plan table: no plan quota can apply, so the deployment's own setting does, as before plans existed.
      maxActivePrice:
        plan === null ? this.deployment.maxActivePrice : this.viewOf('priceQuota', plan, latest.get(slot('priceQuota', plan))).value,
      triggerLogDays: this.viewOf('triggerLogDays', null, latest.get(slot('triggerLogDays', null))).value,
    };
  }

  async get(principal: Principal): Promise<AlertOwnerValuesView> {
    const latest = await this.latest();
    const history = await this.sql<Row[]>`
      SELECT id::text AS id, key, plan, value, old_value, operator_id, reason, created_at
        FROM notify.alert_owner_values ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`;
    return {
      plans: this.plans,
      quotas: (this.plans?.plans ?? []).map(({ id: plan }) => this.viewOf('priceQuota', plan, latest.get(slot('priceQuota', plan)))),
      triggerLogDays: this.viewOf('triggerLogDays', null, latest.get(slot('triggerLogDays', null))),
      history: history.map((r) => ({
        id: r.id,
        key: r.key,
        plan: r.plan,
        oldValue: r.old_value,
        newValue: r.value,
        operatorId: r.operator_id,
        reason: r.reason,
        at: r.created_at.toISOString(),
      })),
      canWrite: hasScope(principal.scopes, 'admin:write'),
    };
  }

  async set(principal: Principal, input: AlertOwnerValueSet): Promise<AlertOwnerValuesView> {
    if (!hasScope(principal.scopes, 'admin:write')) {
      throw new AlertOwnerValueError(NOTIFY_OWNER_VALUE_FORBIDDEN, 'changing an owner value needs admin:write');
    }
    if (!(ALERT_OWNER_KEYS as readonly string[]).includes(input.key)) {
      throw new AlertOwnerValueError(NOTIFY_OWNER_VALUE_INVALID, 'unknown owner value');
    }
    const plan = input.key === 'priceQuota' ? (input.plan ?? null) : null;
    if (input.key === 'priceQuota' && (plan === null || !this.plans?.plans.some((p) => p.id === plan))) {
      throw new AlertOwnerValueError(
        NOTIFY_OWNER_VALUE_INVALID,
        this.plans
          ? "a quota is set for one plan of the owner's plan table"
          : "the owner's plan table is not set, so no plan quota can be set",
      );
    }
    const bound = ALERT_OWNER_BOUNDS[input.key];
    if (input.value !== null && (!Number.isInteger(input.value) || input.value < 1 || input.value > bound)) {
      throw new AlertOwnerValueError(NOTIFY_OWNER_VALUE_INVALID, `the value is a whole number from 1 to ${bound}, or blank`);
    }
    const reason = input.reason.trim();
    if (reason.length < OWNER_REASON_MIN) {
      throw new AlertOwnerValueError(NOTIFY_OWNER_VALUE_REASON_REQUIRED, `a reason of at least ${OWNER_REASON_MIN} characters is required`);
    }
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.alert_owner_values:${slot(input.key, plan)}`}, 0))`;
      const [replay] = await tx<{ id: string }[]>`
        SELECT id::text AS id FROM notify.alert_owner_values WHERE client_request_id = ${input.clientRequestId}`;
      if (replay) return;
      const [current] = await tx<{ id: string; value: number | null }[]>`
        SELECT id::text AS id, value FROM notify.alert_owner_values
         WHERE key = ${input.key} AND coalesce(plan, '') = ${plan ?? ''} ORDER BY id DESC LIMIT 1`;
      if ((current?.id ?? '0') !== input.expectedVersion) {
        throw new AlertOwnerValueError(NOTIFY_OWNER_VALUE_STALE, 'the value changed since it was read: read it again');
      }
      const old = current ? current.value : input.key === 'priceQuota' ? this.deployment.maxActivePrice : this.deployment.triggerLogDays;
      await tx`
        INSERT INTO notify.alert_owner_values (key, plan, value, old_value, operator_id, reason, client_request_id)
        VALUES (${input.key}, ${plan}, ${input.value}, ${old}, ${principal.sub}, ${reason}, ${input.clientRequestId})`;
    });
    return this.get(principal);
  }
}
