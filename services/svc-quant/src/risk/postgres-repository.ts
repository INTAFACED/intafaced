import type { Sql } from 'postgres';
import { QUANT_EQUITY_STOP_POLICIES, type QuantEquityStopPolicy } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { QuantError } from '../errors.js';
import type { RiskRepository, StoredRisk } from './repository.js';

interface RiskSql {
  deposit_percent: string | null;
  max_position_notional: string | null;
  max_daily_loss: string | null;
  equity_floor: string | null;
  floor_policy: string | null;
  trading_version: number | null;
  updated_at: Date | string;
}

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) {
    throw new Error(`refusing sql identifier ${schema}.${table}`);
  }
  return `"${schema}"."${table}"`;
}

/** numeric comes back as text with its scale ("10.000000000000000000"); it reads back as the decimal it was saved as. */
const decimalOf = (value: string | null): string | null => (value === null ? null : formatAmount(parseAmount(String(value))));

function riskOf(row: RiskSql): StoredRisk {
  const at = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  if (Number.isNaN(at.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  const policy = (QUANT_EQUITY_STOP_POLICIES as readonly string[]).includes(row.floor_policy ?? '')
    ? (row.floor_policy as QuantEquityStopPolicy)
    : null;
  return {
    caps: {
      depositPercent: decimalOf(row.deposit_percent),
      maxPositionNotional: decimalOf(row.max_position_notional),
      maxDailyLoss: decimalOf(row.max_daily_loss),
      equityFloor: decimalOf(row.equity_floor),
    },
    floorPolicy: policy,
    tradingVersion: row.trading_version === null ? null : Number(row.trading_version),
    updatedAt: at.toISOString(),
  };
}

/** A strategy's risk screen in the service's own schema (AL-risk-01). */
export function createPostgresRiskRepository(sql: Sql, schema = 'quant'): RiskRepository {
  const table = relation(schema, 'strategy_risk');
  const query = <T>(text: string, params: readonly unknown[]): Promise<T[]> => sql.unsafe(text, params as never[]);
  const COLUMNS = 'deposit_percent, max_position_notional, max_daily_loss, equity_floor, floor_policy, trading_version, updated_at';
  return {
    async get({ accountId, strategyId }) {
      const rows = await query<RiskSql>(`SELECT ${COLUMNS} FROM ${table} WHERE account_id = $1::uuid AND strategy_id = $2`, [
        accountId,
        strategyId,
      ]);
      return rows[0] ? riskOf(rows[0]) : null;
    },
    async saveCaps({ accountId, strategyId, caps, floorPolicy }) {
      const rows = await query<RiskSql>(
        `INSERT INTO ${table} (account_id, strategy_id, deposit_percent, max_position_notional, max_daily_loss, equity_floor, floor_policy, updated_at)
         VALUES ($1::uuid, $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7, now())
         ON CONFLICT (account_id, strategy_id) DO UPDATE SET
           deposit_percent = EXCLUDED.deposit_percent, max_position_notional = EXCLUDED.max_position_notional,
           max_daily_loss = EXCLUDED.max_daily_loss, equity_floor = EXCLUDED.equity_floor,
           floor_policy = EXCLUDED.floor_policy, updated_at = EXCLUDED.updated_at
         RETURNING ${COLUMNS}`,
        [accountId, strategyId, caps.depositPercent, caps.maxPositionNotional, caps.maxDailyLoss, caps.equityFloor, floorPolicy],
      );
      return riskOf(rows[0]!);
    },
    async setTrading({ accountId, strategyId, version }) {
      const rows = await query<RiskSql>(
        `INSERT INTO ${table} (account_id, strategy_id, trading_version, updated_at) VALUES ($1::uuid, $2, $3, now())
         ON CONFLICT (account_id, strategy_id) DO UPDATE SET trading_version = EXCLUDED.trading_version, updated_at = EXCLUDED.updated_at
         RETURNING ${COLUMNS}`,
        [accountId, strategyId, version],
      );
      return riskOf(rows[0]!);
    },
  };
}
