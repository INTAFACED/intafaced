import type { Sql, TransactionSql } from 'postgres';
import { QUANT_OWNER_CRITERIA, type QuantOwnerCriterion } from '@intafaced/contracts';
import { QuantError } from '../errors.js';
import type { LifecycleRepository, OwnerCriterionRow, RecordPromotion } from './repository.js';

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return date.toISOString();
}

interface CriterionSql {
  name: string;
  value: string | null;
  set_at: Date | string;
}

function criterionOf(row: CriterionSql): OwnerCriterionRow {
  if (!(QUANT_OWNER_CRITERIA as readonly string[]).includes(row.name)) {
    throw new QuantError('quant.params_invalid', `owner criterion ${row.name} is not one this build knows`);
  }
  return { name: row.name as QuantOwnerCriterion, value: row.value, setAt: iso(row.set_at) };
}

type Response = RecordPromotion['response'];

export function createPostgresLifecycleRepository(sql: Sql, schema = 'quant', now: () => Date = () => new Date()): LifecycleRepository {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`refusing sql schema ${schema}`);
  const t = (table: string) => `"${schema}"."${table}"`;
  async function query<T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }
  return {
    async criteria() {
      const rows = await query<CriterionSql>(sql, `SELECT name, value, set_at FROM ${t('owner_criteria')} ORDER BY name`, []);
      return rows.filter((row) => (QUANT_OWNER_CRITERIA as readonly string[]).includes(row.name)).map(criterionOf);
    },

    async setCriterion(input) {
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`quant.owner_criteria:${input.name}`]);
        const prior = await query<CriterionSql & { to_boot: boolean }>(
          tx,
          `SELECT name, value, at AS set_at, to_boot FROM ${t('owner_criteria_audit')} WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        if (prior[0]) return { ...criterionOf(prior[0]), toBoot: prior[0].to_boot };
        const at = now().toISOString();
        const value = input.toBoot ? null : input.value;
        if (input.toBoot) {
          await query(tx, `DELETE FROM ${t('owner_criteria')} WHERE name = $1`, [input.name]);
        } else {
          await query(
            tx,
            `INSERT INTO ${t('owner_criteria')} (name, value, reason, set_by, set_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
            [input.name, value, input.reason, input.actor, at],
          );
        }
        await query(
          tx,
          `INSERT INTO ${t('owner_criteria_audit')} (idempotency_key, name, value, to_boot, reason, actor, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [input.idempotencyKey, input.name, value, input.toBoot, input.reason, input.actor, at],
        );
        return { name: input.name, value, setAt: at, toBoot: input.toBoot };
      });
    },

    async of(input) {
      const decisions = await query<{ response: Response }>(
        sql,
        `SELECT response FROM ${t('gate_decisions')}
          WHERE account_id = $1 AND strategy_id = $2 AND strategy_version = $3 ORDER BY at, idempotency_key`,
        [input.accountId, input.strategyId, input.strategyVersion],
      );
      const stages = await query<{ from_stage: string; to_stage: string; run_ids: string[]; at: Date | string }>(
        sql,
        `SELECT from_stage, to_stage, run_ids, at FROM ${t('strategy_stages')}
          WHERE account_id = $1 AND strategy_id = $2 AND strategy_version = $3 ORDER BY at, decision_key`,
        [input.accountId, input.strategyId, input.strategyVersion],
      );
      return {
        decisions: decisions.map((row) => row.response.decision),
        stages: stages.map((row) => ({
          from: row.from_stage as never,
          to: row.to_stage as never,
          runIds: row.run_ids,
          at: iso(row.at),
        })),
      };
    },

    async replay(accountId, key) {
      const rows = await query<{ response: Response }>(
        sql,
        `SELECT response FROM ${t('gate_decisions')} WHERE account_id = $1 AND idempotency_key = $2`,
        [accountId, key],
      );
      return rows[0]?.response ?? null;
    },

    async record(input) {
      return sql.begin(async (tx) => {
        // One promotion of a version at a time, so two presses can't both pass the "not yet in this stage" read.
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `quant.stage:${input.accountId}:${input.strategyId}:v${input.strategyVersion}`,
        ]);
        const prior = await query<{ response: Response }>(tx, `SELECT response FROM ${t('gate_decisions')} WHERE idempotency_key = $1`, [
          input.key,
        ]);
        if (prior[0]) return prior[0].response;
        if (input.stage) {
          const reached = await query(
            tx,
            `SELECT 1 FROM ${t('strategy_stages')} WHERE account_id = $1 AND strategy_id = $2 AND strategy_version = $3 AND to_stage = $4`,
            [input.accountId, input.strategyId, input.strategyVersion, input.stage.to],
          );
          if (reached.length) return null;
        }
        await query(
          tx,
          `INSERT INTO ${t('gate_decisions')}
             (idempotency_key, account_id, strategy_id, strategy_version, decision, criteria, run_ids, response, actor, at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)`,
          [
            input.key,
            input.accountId,
            input.strategyId,
            input.strategyVersion,
            input.decision.decision,
            input.decision.criteria,
            input.decision.runIds,
            input.response,
            input.actor,
            input.decision.at,
          ],
        );
        if (input.stage) {
          await query(
            tx,
            `INSERT INTO ${t('strategy_stages')}
               (decision_key, account_id, strategy_id, strategy_version, from_stage, to_stage, run_ids, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
            [
              input.key,
              input.accountId,
              input.strategyId,
              input.strategyVersion,
              input.stage.from,
              input.stage.to,
              input.stage.runIds,
              input.stage.at,
            ],
          );
        }
        return input.response;
      });
    },
  };
}
