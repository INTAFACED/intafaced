import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { QUANT_NOTIFY_CHANNELS, type QuantNotifyChannel } from '@intafaced/contracts';
import { QuantError } from '../errors.js';
import type { NotifyRepository, StoredAlert } from './repository.js';

interface AlertSql {
  id: string;
  account_id: string;
  strategy_id: string;
  strategy_version: number;
  template: string;
  write_key: string;
  created_at: Date | string;
}

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) {
    throw new Error(`refusing sql identifier ${schema}.${table}`);
  }
  return `"${schema}"."${table}"`;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return date.toISOString();
}

function alertOf(row: AlertSql): StoredAlert {
  return {
    id: row.id,
    accountId: row.account_id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    template: row.template,
    key: row.write_key,
    createdAt: iso(row.created_at),
  };
}

function channelsOf(value: unknown): QuantNotifyChannel[] {
  // jsonb comes back parsed; a driver that hands back its text is parsed here, so a saved list never reads as empty.
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  const list = Array.isArray(parsed) ? parsed : [];
  return QUANT_NOTIFY_CHANNELS.filter((channel) => list.includes(channel));
}

/** Strategy notification settings, fill alerts and announced fills in the service's own schema (AL-live-06, AL-alerts-01). */
export function createPostgresNotifyRepository(sql: Sql, schema = 'quant'): NotifyRepository {
  const settings = relation(schema, 'strategy_notify');
  const alerts = relation(schema, 'strategy_alerts');
  const marks = relation(schema, 'alert_fills');
  const query = <T>(text: string, params: readonly unknown[]): Promise<T[]> => sql.unsafe(text, params as never[]);
  const COLUMNS = 'id, account_id, strategy_id, strategy_version, template, write_key, created_at';
  return {
    async settings({ accountId, strategyId }) {
      const rows = await query<{ channels: unknown; updated_at: Date | string }>(
        `SELECT channels, updated_at FROM ${settings} WHERE account_id = $1::uuid AND strategy_id = $2`,
        [accountId, strategyId],
      );
      return rows[0] ? { channels: channelsOf(rows[0].channels), updatedAt: iso(rows[0].updated_at) } : null;
    },
    async saveSettings({ accountId, strategyId, channels }) {
      const rows = await query<{ channels: unknown; updated_at: Date | string }>(
        `INSERT INTO ${settings} (account_id, strategy_id, channels, updated_at)
         VALUES ($1::uuid, $2, $3::text::jsonb, now())
         ON CONFLICT (account_id, strategy_id) DO UPDATE SET channels = EXCLUDED.channels, updated_at = EXCLUDED.updated_at
         RETURNING channels, updated_at`,
        [accountId, strategyId, JSON.stringify(channels)],
      );
      return { channels: channelsOf(rows[0]!.channels), updatedAt: iso(rows[0]!.updated_at) };
    },
    async createAlert(input) {
      await query(
        `INSERT INTO ${alerts} (id, account_id, strategy_id, strategy_version, template, write_key)
         VALUES ($1, $2::uuid, $3, $4, $5, $6)
         ON CONFLICT (account_id, write_key) DO NOTHING`,
        [randomUUID(), input.accountId, input.strategyId, input.strategyVersion, input.template, input.key],
      );
      const rows = await query<AlertSql>(`SELECT ${COLUMNS} FROM ${alerts} WHERE account_id = $1::uuid AND write_key = $2`, [
        input.accountId,
        input.key,
      ]);
      return alertOf(rows[0]!);
    },
    async alerts({ accountId, strategyId, limit }) {
      const rows = await query<AlertSql>(
        `SELECT ${COLUMNS} FROM ${alerts} WHERE account_id = $1::uuid AND strategy_id = $2 ORDER BY created_at, id LIMIT $3`,
        [accountId, strategyId, limit],
      );
      return rows.map(alertOf);
    },
    async sweepAlerts({ after, limit }) {
      const rows = await query<AlertSql>(`SELECT ${COLUMNS} FROM ${alerts} WHERE ($1::text IS NULL OR id > $1) ORDER BY id LIMIT $2`, [
        after,
        limit,
      ]);
      return rows.map(alertOf);
    },
    async announced({ alertId, runId }) {
      const rows = await query<{ seq: number }>(`SELECT seq FROM ${marks} WHERE alert_id = $1 AND run_id = $2`, [alertId, runId]);
      return new Set(rows.map((row) => Number(row.seq)));
    },
    async markAnnounced({ alertId, runId, seq, eventId }) {
      await query(
        `INSERT INTO ${marks} (alert_id, run_id, seq, event_id) VALUES ($1, $2, $3, $4) ON CONFLICT (alert_id, run_id, seq) DO NOTHING`,
        [alertId, runId, seq, eventId],
      );
    },
  };
}
