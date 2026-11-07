/**
 * The alert owner values the founder sets on the charts settings page (C-ops-04, C-alerts-scan-03; J-charts-desk-18 #5 #6):
 *
 *   priceQuota       most price alerts one person may hold open, per plan
 *   triggerLogDays   how many days the alert trigger log is kept
 *
 *   notify.opsAlertOwnerValues.get   admin:read   every value, where it comes from, who set it and when, and the history
 *   notify.opsAlertOwnerValues.set   admin:write  one value per write, with a reason; a blank value clears it to "not set"
 *
 * A plan is the account's verification level as its session carries it (`none`, `basic`, `full`, `institutional`): the
 * per-account level this platform already gates on. Each write is one append-only row, so the rows are the audit: who,
 * when, the old and new value, and the reason, all in one insert. A value the page has never written falls back to the
 * deployment's own setting (NOTIFY_ALERT_MAX_ACTIVE_PRICE, NOTIFY_ALERT_TRIGGER_LOG_DAYS), and the page says which one
 * applies. A cleared value is "not set" and refuses the action that needs it; nothing here holds a default number.
 */
import type { Sql } from 'postgres';
import { hasScope, type Principal } from '@intafaced/auth';

export const ALERT_PLANS = ['none', 'basic', 'full', 'institutional'] as const;
export type AlertPlan = (typeof ALERT_PLANS)[number];

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

/** The plan a session carries; anything else is `none`, the lowest. */
export function planOf(tier: string | null | undefined): AlertPlan {
  return (ALERT_PLANS as readonly string[]).includes(tier ?? '') ? (tier as AlertPlan) : 'none';
}

export class AlertOwnerValues {
  constructor(
    private readonly sql: Sql,
    private readonly deployment: DeploymentAlertValues,
  ) {}

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
  async effective(plan: AlertPlan): Promise<{ maxActivePrice: number | null; triggerLogDays: number | null }> {
    const latest = await this.latest();
    return {
      maxActivePrice: this.viewOf('priceQuota', plan, latest.get(slot('priceQuota', plan))).value,
      triggerLogDays: this.viewOf('triggerLogDays', null, latest.get(slot('triggerLogDays', null))).value,
    };
  }

  async get(principal: Principal): Promise<AlertOwnerValuesView> {
    const latest = await this.latest();
    const history = await this.sql<Row[]>`
      SELECT id::text AS id, key, plan, value, old_value, operator_id, reason, created_at
        FROM notify.alert_owner_values ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`;
    return {
      quotas: ALERT_PLANS.map((plan) => this.viewOf('priceQuota', plan, latest.get(slot('priceQuota', plan)))),
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
    if (input.key === 'priceQuota' && (plan === null || !(ALERT_PLANS as readonly string[]).includes(plan))) {
      throw new AlertOwnerValueError(NOTIFY_OWNER_VALUE_INVALID, 'a quota is set for one plan');
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
