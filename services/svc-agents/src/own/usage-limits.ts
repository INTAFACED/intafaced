import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';
import { formatAmount, MoneyError, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { periodStart } from '../spend/limits.js';
import { OwnAgentRefusal } from './catalog.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN_PREFIX = 'own.';

/** The UTC month a spend counts in, as `YYYY-MM`. */
export function usageMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** The business key of one agent's alert in one month: it is recorded, published and delivered once under it. */
export function usageAlertKey(agentId: string, month: string): string {
  return `agents.usage_alert:${agentId}:${month}`;
}

/** What the person set; null is not set. */
export type OwnUsageLimits = { readonly alertAt: Amount | null; readonly hardLimit: Amount | null; readonly email: boolean };

/** Wire view (`ownAgentUsageLimitsSchema` without the fee asset, which the route adds). */
export type OwnUsageLimitsView = {
  readonly alertAt: string | null;
  readonly hardLimit: string | null;
  readonly email: boolean;
  readonly month: string;
  readonly spent: string;
  readonly alertCrossed: boolean;
  readonly alert: { readonly key: string; readonly spent: string } | null;
  readonly hardLimitReached: boolean;
};

/** Blank is not set; anything else must be a decimal amount above zero. */
function parseOptional(value: string | null | undefined): Amount | null {
  const text = value?.trim() ?? '';
  if (!text) return null;
  try {
    const amount = parseAmount(text);
    if (amount <= 0n) throw new OwnAgentRefusal('agents.usage.limit_invalid');
    return amount;
  } catch (err) {
    if (err instanceof MoneyError) throw new OwnAgentRefusal('agents.usage.limit_invalid');
    throw err;
  }
}

/** The person's usage limits for one own agent, or null when they set none. Read on the caller's transaction. */
export async function readOwnUsageLimits(sql: Sql, ownerId: string, agentId: string): Promise<OwnUsageLimits | null> {
  if (!UUID_RE.test(agentId)) return null;
  const rows = await sql<Array<{ alert_at: string | null; hard_limit: string | null; email: boolean }>>`
    SELECT alert_at::text, hard_limit::text, email
      FROM agents.own_agent_usage_limits
     WHERE owner_id = ${ownerId} AND agent_id = ${agentId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    alertAt: row.alert_at === null ? null : parseAmount(row.alert_at),
    hardLimit: row.hard_limit === null ? null : parseAmount(row.hard_limit),
    email: row.email,
  };
}

/**
 * What this person's runs of one own agent actually cost since `since`: committed holds only. A held run has not cost
 * anything yet, so it neither crosses the alert nor reaches the hard limit; it is counted once it commits.
 */
export async function ownAgentSpent(sql: Sql, userId: string, agentId: string, since: Date): Promise<Amount> {
  const rows = await sql<Array<{ total: string }>>`
    SELECT COALESCE(SUM(r.committed_amount), 0::numeric)::text AS total
      FROM agents.spend_reservations r
      JOIN agents.agent_sessions s ON s.id = r.session_id
     WHERE r.user_id = ${userId}
       AND s.user_id = ${userId}
       AND s.agent_id = ${OWN_PREFIX + agentId}
       AND r.status = 'committed'
       AND r.created_at >= ${since}
  `;
  return parseAmount(rows[0]?.total ?? '0');
}

/**
 * Refuses a new run of this own agent once this month's use reached the hard limit the person set. `used` is the
 * month's committed cost plus the worst case of every run still held, read under the reserve's per-user lock, so runs
 * started together cannot all pass a limit that only finished runs would show: past it by at most one run's worst
 * case. Called only where a run is held, never where one commits: a run already held finishes and is charged.
 */
export async function assertBelowHardLimit(
  tx: Sql,
  input: { userId: string; agentId: string; assetId: string; used: Amount; now: Date },
): Promise<void> {
  const { userId, agentId, assetId, used, now } = input;
  const limits = await readOwnUsageLimits(tx, userId, agentId);
  if (!limits?.hardLimit) return;
  if (used >= limits.hardLimit) {
    throw new AgentError(
      `Own agent hard limit ${formatAmount(limits.hardLimit)} ${assetId} for ${usageMonth(now)} is reached`,
      'agents.usage.hard_limit_reached',
      'agents.refused.hard_limit_reached',
      { limit: formatAmount(limits.hardLimit), asset: assetId, month: usageMonth(now) },
    );
  }
}

/**
 * Records the month's alert for the own agent behind this reservation once its committed spend reached the alert the
 * person set. Runs in the commit's transaction, after the reservation is committed, so the alert and the spend that
 * crossed it land together or not at all. Once per agent and month: a second crossing writes nothing.
 */
export async function noteUsageAlert(tx: Sql, input: { userId: string; reservationKey: string }): Promise<void> {
  const rows = await tx<Array<{ agent_id: string; asset_id: string; created_at: Date }>>`
    SELECT s.agent_id, r.asset_id, r.created_at
      FROM agents.spend_reservations r
      JOIN agents.agent_sessions s ON s.id = r.session_id
     WHERE r.user_id = ${input.userId} AND r.reservation_key = ${input.reservationKey} AND r.status = 'committed'
  `;
  const row = rows[0];
  if (!row || !row.agent_id.startsWith(OWN_PREFIX)) return;
  // The month the run was held in, which is the month its spend counts in, even when it commits after midnight.
  await recordUsageAlert(tx, { userId: input.userId, agentId: row.agent_id.slice(OWN_PREFIX.length), assetId: row.asset_id, at: row.created_at });
}

/**
 * Records the month's alert when this agent's committed spend in the month of `at` reached the alert the person set.
 * Once per agent and month: a month already recorded is not summed again, and a second crossing writes nothing.
 */
async function recordUsageAlert(tx: Sql, input: { userId: string; agentId: string; assetId: string; at: Date }): Promise<void> {
  const { userId, agentId, assetId, at } = input;
  const month = usageMonth(at);
  const key = usageAlertKey(agentId, month);
  const recorded = await tx`SELECT 1 FROM agents.own_agent_usage_alerts WHERE alert_key = ${key}`;
  if (recorded[0]) return;
  const limits = await readOwnUsageLimits(tx, userId, agentId);
  if (!limits?.alertAt) return;
  const spent = await ownAgentSpent(tx, userId, agentId, periodStart('month', at));
  if (spent < limits.alertAt) return;
  await tx`
    INSERT INTO agents.own_agent_usage_alerts (alert_key, agent_id, owner_id, month, alert_at, spent, asset_id, email)
    VALUES (${key}, ${agentId}, ${userId}, ${month}, ${formatAmount(limits.alertAt)}::numeric,
            ${formatAmount(spent)}::numeric, ${assetId}, ${limits.email})
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Publishes every recorded alert not yet published, on its business key, then marks it published. A crash between
 * the two publishes it again under the same key, which the bus drops as a duplicate. Scoped to one person when given.
 */
export async function publishPendingUsageAlerts(sql: Sql, bus: EventBus, ownerId?: string): Promise<number> {
  const rows = await sql<
    Array<{
      alert_key: string;
      agent_id: string;
      owner_id: string;
      month: string;
      alert_at: string;
      spent: string;
      asset_id: string;
      email: boolean;
    }>
  >`
    SELECT alert_key, agent_id::text, owner_id, month, alert_at::text, spent::text, asset_id, email
      FROM agents.own_agent_usage_alerts
     WHERE published_at IS NULL ${ownerId === undefined ? sql`` : sql`AND owner_id = ${ownerId}`}
     ORDER BY created_at
     LIMIT 100
  `;
  for (const row of rows) {
    await bus.publish(
      'agentUsageAlertCrossed',
      {
        alertKey: row.alert_key,
        userId: row.owner_id,
        agentId: row.agent_id,
        month: row.month,
        alertAt: formatAmount(parseAmount(row.alert_at)),
        spent: formatAmount(parseAmount(row.spent)),
        assetId: row.asset_id,
        email: row.email,
      },
      { idempotencyKey: row.alert_key },
    );
    await sql`
      UPDATE agents.own_agent_usage_alerts SET published_at = now(), updated_at = now()
       WHERE alert_key = ${row.alert_key} AND published_at IS NULL
    `;
  }
  return rows.length;
}

/**
 * The alert and hard limit a person sets for one of their own agents. Only the owner reads or writes them; another
 * person's agent reads as not found. Neither is a balance and neither moves value.
 */
export class OwnUsageLimitsStore {
  constructor(private readonly sql: Sql) {}

  async get(ownerId: string, agentId: string, now: Date = new Date()): Promise<OwnUsageLimitsView> {
    await this.assertOwned(this.sql, ownerId, agentId);
    return this.view(this.sql, ownerId, agentId, now);
  }

  /**
   * Blank clears one; the alert must sit below the hard limit when both are set. Saving the same values is a no-op. An
   * alert already passed this month is recorded on save.
   */
  async set(
    ownerId: string,
    agentId: string,
    input: { alertAt: string | null; hardLimit: string | null; email: boolean; assetId: string },
    now: Date = new Date(),
  ): Promise<OwnUsageLimitsView> {
    const alertAt = parseOptional(input.alertAt);
    const hardLimit = parseOptional(input.hardLimit);
    if (alertAt !== null && hardLimit !== null && alertAt >= hardLimit) {
      throw new OwnAgentRefusal('agents.usage.alert_above_limit', { limit: formatAmount(hardLimit) });
    }
    return this.sql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      await this.assertOwned(sql, ownerId, agentId, true);
      await sql`
        INSERT INTO agents.own_agent_usage_limits (agent_id, owner_id, alert_at, hard_limit, email)
        VALUES (${agentId}, ${ownerId}, ${alertAt === null ? null : formatAmount(alertAt)}::numeric,
                ${hardLimit === null ? null : formatAmount(hardLimit)}::numeric, ${input.email})
        ON CONFLICT (agent_id) DO UPDATE
           SET alert_at = EXCLUDED.alert_at,
               hard_limit = EXCLUDED.hard_limit,
               email = EXCLUDED.email,
               updated_at = now()
      `;
      // An alert set at or below what the agent already spent this month is reached now, not at the next run.
      await recordUsageAlert(sql, { userId: ownerId, agentId, assetId: input.assetId, at: now });
      return this.view(sql, ownerId, agentId, now);
    });
  }

  private async assertOwned(sql: Sql, ownerId: string, agentId: string, lock = false): Promise<void> {
    if (!UUID_RE.test(agentId)) throw new OwnAgentRefusal('agents.own.not_found');
    const rows = lock
      ? await sql`SELECT 1 FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId} FOR UPDATE`
      : await sql`SELECT 1 FROM agents.own_agents WHERE owner_id = ${ownerId} AND id = ${agentId}`;
    if (!rows[0]) throw new OwnAgentRefusal('agents.own.not_found');
  }

  private async view(sql: Sql, ownerId: string, agentId: string, now: Date): Promise<OwnUsageLimitsView> {
    const limits = await readOwnUsageLimits(sql, ownerId, agentId);
    const month = usageMonth(now);
    const spent = await ownAgentSpent(sql, ownerId, agentId, periodStart('month', now));
    const alerts = await sql<Array<{ alert_key: string; spent: string }>>`
      SELECT alert_key, spent::text FROM agents.own_agent_usage_alerts WHERE alert_key = ${usageAlertKey(agentId, month)}
    `;
    const alert = alerts[0];
    return {
      alertAt: limits?.alertAt == null ? null : formatAmount(limits.alertAt),
      hardLimit: limits?.hardLimit == null ? null : formatAmount(limits.hardLimit),
      email: limits?.email ?? false,
      month,
      spent: formatAmount(spent),
      alertCrossed: alert !== undefined,
      alert: alert ? { key: alert.alert_key, spent: formatAmount(parseAmount(alert.spent)) } : null,
      hardLimitReached: limits?.hardLimit != null && spent >= limits.hardLimit,
    };
  }
}
