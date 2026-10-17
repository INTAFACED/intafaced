import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { MiningError } from './errors.js';

export type ShareRejection = {
  readonly idempotencyKey: string;
  readonly windowId: string;
  readonly minerId: string;
  readonly reasonCode: string;
  readonly createdAt: Date;
};

type RejectionRow = {
  idempotency_key: string;
  window_id: string;
  miner_id: string;
  reason_code: string;
  created_at: Date;
};

function rowOf(row: RejectionRow): ShareRejection {
  return {
    idempotencyKey: row.idempotency_key,
    windowId: row.window_id,
    minerId: row.miner_id,
    reasonCode: row.reason_code,
    createdAt: row.created_at,
  };
}

/**
 * One refusal row per client key. A replay of the same key and the same
 * window, miner, and reason returns the first row. A different body under
 * the same key is `mining.idempotency_conflict` and writes nothing new.
 */
export async function recordShareRejection(
  sql: Sql,
  input: { idempotencyKey: string; windowId: string; minerId: string; reasonCode: string },
): Promise<ShareRejection> {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200 || key !== key.trim()) {
    throw new MiningError('Idempotency key is unset', 'mining.idempotency_key_unset');
  }
  if (!input.windowId.trim() || !input.minerId.trim() || !input.reasonCode.trim()) {
    throw new MiningError('Refused share is missing miner or window', 'mining.share_malformed');
  }
  return transaction(sql, async (tx) => {
    const inserted = await tx<RejectionRow[]>`
      INSERT INTO mining_pool.share_rejections (idempotency_key, window_id, miner_id, reason_code)
      VALUES (${key}, ${input.windowId}, ${input.minerId}, ${input.reasonCode})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key, window_id, miner_id, reason_code, created_at
    `;
    const [fresh] = inserted;
    if (fresh) return rowOf(fresh);
    const [existing] = await tx<RejectionRow[]>`
      SELECT idempotency_key, window_id, miner_id, reason_code, created_at
      FROM mining_pool.share_rejections
      WHERE idempotency_key = ${key}
    `;
    if (!existing) throw new MiningError('Rejection row missing after conflict', 'mining.pg_unavailable');
    if (existing.window_id !== input.windowId || existing.miner_id !== input.minerId || existing.reason_code !== input.reasonCode) {
      throw new MiningError('Idempotency key was already used for a different refusal', 'mining.idempotency_conflict');
    }
    return rowOf(existing);
  });
}
