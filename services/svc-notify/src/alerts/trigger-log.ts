/**
 * The alert trigger log: one row each time an alert fired, with the mark that fired it.
 *
 * Retention is an owner setting (`NOTIFY_ALERT_TRIGGER_LOG_DAYS`). Blank means no log is written and the read refuses
 * `notify.alert_trigger_log_retention_unset`; the alert still fires, because the log is a record of a delivery, not the delivery.
 * A fire is keyed by the alert id and its number (`seq`: 1 for a one-shot alert, the fire count plus one for a repeating one), so
 * recording is idempotent: a sweep that retries after a crash writes the same fire once.
 */

import type { Sql } from 'postgres';
import type { AlertCondition, PriceAlert } from './types.js';

export const NOTIFY_ALERT_TRIGGER_LOG_RETENTION_UNSET = 'notify.alert_trigger_log_retention_unset' as const;

export type AlertTrigger = {
  readonly alertId: string;
  /** Which fire of the alert this is, from 1. */
  readonly seq: number;
  readonly userId: string;
  readonly marketId: string;
  /** What the alert asked for when it fired, so a later edit does not rewrite history. */
  readonly condition: AlertCondition;
  readonly targetPrice: string;
  /** Decimal string: the mark that fired it. */
  readonly markPrice: string;
  readonly firedAt: Date;
  readonly notificationId: string | null;
};

export interface AlertTriggerLog {
  /** Record a fire once. A second record of the same alert and number is ignored. */
  record(trigger: AlertTrigger): Promise<void>;
  /** The person's triggers, newest first, optionally for one alert, none older than `since`. */
  list(userId: string, opts: { alertId?: string; since: Date; limit: number }): Promise<readonly AlertTrigger[]>;
  /** Drop every row older than `before`. Returns how many. */
  prune(before: Date): Promise<number>;
}

export const triggerOf = (alert: PriceAlert, markPrice: string, firedAt: Date, notificationId: string | null, seq = 1): AlertTrigger => ({
  alertId: alert.id,
  seq,
  userId: alert.userId,
  marketId: alert.marketId,
  condition: alert.condition,
  targetPrice: alert.targetPrice,
  markPrice,
  firedAt,
  notificationId,
});

export class MemoryAlertTriggerLog implements AlertTriggerLog {
  private readonly rows = new Map<string, AlertTrigger>();

  async record(trigger: AlertTrigger): Promise<void> {
    const key = `${trigger.alertId}:${trigger.seq}`;
    if (!this.rows.has(key)) this.rows.set(key, trigger);
  }

  async list(userId: string, opts: { alertId?: string; since: Date; limit: number }): Promise<readonly AlertTrigger[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && (opts.alertId === undefined || r.alertId === opts.alertId) && r.firedAt >= opts.since)
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())
      .slice(0, opts.limit);
  }

  async prune(before: Date): Promise<number> {
    let dropped = 0;
    for (const [key, row] of this.rows) {
      if (row.firedAt < before) {
        this.rows.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}

type TriggerRow = {
  alert_id: string;
  seq: number;
  user_id: string;
  market_id: string;
  condition: AlertCondition;
  target_price: string;
  mark_price: string;
  fired_at: Date;
  notification_id: string | null;
};

const mapTrigger = (r: TriggerRow): AlertTrigger => ({
  alertId: r.alert_id,
  seq: r.seq,
  userId: r.user_id,
  marketId: r.market_id,
  condition: r.condition,
  targetPrice: r.target_price,
  markPrice: r.mark_price,
  firedAt: r.fired_at,
  notificationId: r.notification_id,
});

/** Postgres engine. Migration `0022_notify_alert_frequency.sql` (it replaced `alert_triggers`, keyed by alert id alone). */
export class PostgresAlertTriggerLog implements AlertTriggerLog {
  constructor(private readonly sql: Sql) {}

  async record(t: AlertTrigger): Promise<void> {
    await this.sql`
      INSERT INTO notify.alert_fires (alert_id, seq, user_id, market_id, condition, target_price, mark_price, fired_at, notification_id)
      VALUES (${t.alertId}, ${t.seq}, ${t.userId}, ${t.marketId}, ${t.condition}, ${t.targetPrice}, ${t.markPrice}, ${t.firedAt}, ${t.notificationId})
      ON CONFLICT (alert_id, seq) DO NOTHING
    `;
  }

  async list(userId: string, opts: { alertId?: string; since: Date; limit: number }): Promise<readonly AlertTrigger[]> {
    const rows = await this.sql<TriggerRow[]>`
      SELECT alert_id, seq, user_id, market_id, condition, target_price, mark_price, fired_at, notification_id
      FROM notify.alert_fires
      WHERE user_id = ${userId} AND fired_at >= ${opts.since}
        ${opts.alertId === undefined ? this.sql`` : this.sql`AND alert_id = ${opts.alertId}`}
      ORDER BY fired_at DESC
      LIMIT ${opts.limit}
    `;
    return rows.map(mapTrigger);
  }

  async prune(before: Date): Promise<number> {
    const rows = await this.sql<{ alert_id: string }[]>`DELETE FROM notify.alert_fires WHERE fired_at < ${before} RETURNING alert_id`;
    return rows.length;
  }
}
