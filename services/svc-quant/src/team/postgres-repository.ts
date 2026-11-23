import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { QuantError } from '../errors.js';
import type { QuotaGate } from '../quota/quota.js';
import type { LockAttempt, StoredCollaborator, StoredGrant, StoredLock, StoredRead, TeamRepository } from './repository.js';

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error(`refusing sql identifier ${schema}.${table}`);
  return `"${schema}"."${table}"`;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return date.toISOString();
}

interface MemberSql {
  strategy_id: string;
  owner_id: string;
  member_id: string;
  role: 'view' | 'edit';
  live_control: boolean;
  added_at: Date | string;
  updated_at: Date | string;
}
interface LockSql {
  strategy_id: string;
  holder_id: string;
  taken_at: Date | string;
  expires_at: Date | string;
}
interface GrantSql {
  id: string;
  strategy_id: string;
  owner_id: string;
  write_key: string;
  created_at: Date | string;
  expires_at: Date | string;
}
interface ReadSql {
  strategy_id: string;
  grant_id: string | null;
  reader: string;
  granted: boolean;
  read_at: Date | string;
}

const memberOf = (row: MemberSql): StoredCollaborator => ({
  strategyId: row.strategy_id,
  ownerId: row.owner_id,
  memberId: row.member_id,
  role: row.role,
  liveControl: row.live_control,
  addedAt: iso(row.added_at),
  updatedAt: iso(row.updated_at),
});
const lockOf = (row: LockSql): StoredLock => ({
  strategyId: row.strategy_id,
  holderId: row.holder_id,
  takenAt: iso(row.taken_at),
  expiresAt: iso(row.expires_at),
});
const grantOf = (row: GrantSql): StoredGrant => ({
  id: row.id,
  strategyId: row.strategy_id,
  ownerId: row.owner_id,
  key: row.write_key,
  createdAt: iso(row.created_at),
  expiresAt: iso(row.expires_at),
});
const readOf = (row: ReadSql): StoredRead => ({
  strategyId: row.strategy_id,
  grantId: row.grant_id,
  reader: row.reader,
  granted: row.granted,
  readAt: iso(row.read_at),
});

/** Strategy teams, edit locks, support grants and support reads in the service's own schema (J-algo-dev-08). */
export function createPostgresTeamRepository(sql: Sql, gate?: QuotaGate, schema = 'quant'): TeamRepository {
  const members = relation(schema, 'strategy_collaborators');
  const locks = relation(schema, 'strategy_edit_locks');
  const grants = relation(schema, 'support_grants');
  const reads = relation(schema, 'support_reads');
  const strategies = relation(schema, 'strategies');
  const query = <T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> => db.unsafe(text, params as never[]);
  const MEMBER = 'strategy_id, owner_id, member_id, role, live_control, added_at, updated_at';
  const GRANT = 'id, strategy_id, owner_id, write_key, created_at, expires_at';
  return {
    async collaborators(strategyId) {
      const rows = await query<MemberSql>(sql, `SELECT ${MEMBER} FROM ${members} WHERE strategy_id = $1 ORDER BY added_at, member_id`, [
        strategyId,
      ]);
      return rows.map(memberOf);
    },
    async membership({ strategyId, memberId }) {
      const rows = await query<MemberSql>(sql, `SELECT ${MEMBER} FROM ${members} WHERE strategy_id = $1 AND member_id = $2::uuid`, [
        strategyId,
        memberId,
      ]);
      return rows[0] ? memberOf(rows[0]) : null;
    },
    async sharedWith(memberId) {
      const rows = await query<MemberSql>(
        sql,
        `SELECT ${MEMBER} FROM ${members} WHERE member_id = $1::uuid ORDER BY added_at, strategy_id`,
        [memberId],
      );
      return rows.map(memberOf);
    },
    async upsert(input) {
      return sql.begin(async (tx) => {
        // The strategy row first, as every strategy write locks it, so a save and an invite never wait on each other.
        const owned = await query<{ id: string }>(tx, `SELECT id FROM ${strategies} WHERE id = $1 AND account_id = $2::uuid FOR UPDATE`, [
          input.strategyId,
          input.ownerId,
        ]);
        if (!owned[0]) throw new QuantError('quant.studio_not_found', 'strategy not found');
        const at = input.at.toISOString();
        const changed = await query<MemberSql>(
          tx,
          `UPDATE ${members} SET role = $3, live_control = $4, updated_at = $5
            WHERE strategy_id = $1 AND member_id = $2::uuid RETURNING ${MEMBER}`,
          [input.strategyId, input.memberId, input.role, input.liveControl, at],
        );
        if (changed[0]) return memberOf(changed[0]);
        if (gate) {
          await gate.lock(tx, input.ownerId, ['collaborators']);
          const counted = await query<{ n: string }>(tx, `SELECT COUNT(*)::text AS n FROM ${members} WHERE strategy_id = $1`, [
            input.strategyId,
          ]);
          await gate.check(tx, input.ownerId, [{ resource: 'collaborators', used: BigInt(counted[0]?.n ?? '0'), adding: 1n }]);
        }
        const rows = await query<MemberSql>(
          tx,
          `INSERT INTO ${members} (strategy_id, owner_id, member_id, role, live_control, added_at, updated_at)
           VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $6) RETURNING ${MEMBER}`,
          [input.strategyId, input.ownerId, input.memberId, input.role, input.liveControl, at],
        );
        return memberOf(rows[0]!);
      });
    },
    async remove({ strategyId, memberId }) {
      await sql.begin(async (tx) => {
        await query(tx, `DELETE FROM ${members} WHERE strategy_id = $1 AND member_id = $2::uuid`, [strategyId, memberId]);
        await query(tx, `DELETE FROM ${locks} WHERE strategy_id = $1 AND holder_id = $2::uuid`, [strategyId, memberId]);
      });
    },
    async mostCollaborators(ownerId) {
      const rows = await query<{ n: string }>(
        sql,
        `SELECT COALESCE(MAX(n), 0)::text AS n FROM (SELECT COUNT(*) AS n FROM ${members} WHERE owner_id = $1::uuid GROUP BY strategy_id) per`,
        [ownerId],
      );
      return BigInt(rows[0]?.n ?? '0');
    },
    async lock(strategyId) {
      const rows = await query<LockSql>(sql, `SELECT strategy_id, holder_id, taken_at, expires_at FROM ${locks} WHERE strategy_id = $1`, [
        strategyId,
      ]);
      return rows[0] ? lockOf(rows[0]) : null;
    },
    async takeLock({ strategyId, holderId, at, ttlMs }): Promise<LockAttempt> {
      const taken = at.toISOString();
      const expires = new Date(at.getTime() + ttlMs).toISOString();
      // One statement: a lapsed lock or the holder's own is replaced; another person's live lock is left as it is.
      const rows = await query<LockSql>(
        sql,
        `INSERT INTO ${locks} AS l (strategy_id, holder_id, taken_at, expires_at) VALUES ($1, $2::uuid, $3, $4)
         ON CONFLICT (strategy_id) DO UPDATE SET holder_id = EXCLUDED.holder_id, taken_at = EXCLUDED.taken_at, expires_at = EXCLUDED.expires_at
          WHERE l.holder_id = EXCLUDED.holder_id OR l.expires_at <= EXCLUDED.taken_at
         RETURNING strategy_id, holder_id, taken_at, expires_at`,
        [strategyId, holderId, taken, expires],
      );
      if (rows[0]) return { taken: true, lock: lockOf(rows[0]) };
      const held = await query<LockSql>(sql, `SELECT strategy_id, holder_id, taken_at, expires_at FROM ${locks} WHERE strategy_id = $1`, [
        strategyId,
      ]);
      if (!held[0]) throw new Error('edit lock vanished between the take and the read');
      return { taken: false, lock: lockOf(held[0]) };
    },
    async releaseLock({ strategyId, holderId }) {
      await query(sql, `DELETE FROM ${locks} WHERE strategy_id = $1 AND holder_id = $2::uuid`, [strategyId, holderId]);
    },
    async grants(strategyId) {
      const rows = await query<GrantSql>(sql, `SELECT ${GRANT} FROM ${grants} WHERE strategy_id = $1 ORDER BY created_at DESC, id`, [
        strategyId,
      ]);
      return rows.map(grantOf);
    },
    async createGrant({ strategyId, ownerId, key, at, seconds }) {
      const created = at.toISOString();
      const expires = new Date(at.getTime() + seconds * 1000).toISOString();
      await query(
        sql,
        `INSERT INTO ${grants} (id, strategy_id, owner_id, write_key, created_at, expires_at)
         VALUES ($1, $2, $3::uuid, $4, $5, $6) ON CONFLICT (owner_id, write_key) DO NOTHING`,
        [randomUUID(), strategyId, ownerId, key, created, expires],
      );
      const rows = await query<GrantSql>(sql, `SELECT ${GRANT} FROM ${grants} WHERE owner_id = $1::uuid AND write_key = $2`, [
        ownerId,
        key,
      ]);
      return grantOf(rows[0]!);
    },
    async recordRead({ strategyId, reader, at }) {
      const when = at.toISOString();
      return sql.begin(async (tx) => {
        const active = await query<GrantSql>(
          tx,
          `SELECT ${GRANT} FROM ${grants} WHERE strategy_id = $1 AND created_at <= $2 AND expires_at > $2 ORDER BY expires_at DESC LIMIT 1`,
          [strategyId, when],
        );
        const grant = active[0] ? grantOf(active[0]) : null;
        await query(tx, `INSERT INTO ${reads} (id, strategy_id, grant_id, reader, granted, read_at) VALUES ($1, $2, $3, $4, $5, $6)`, [
          randomUUID(),
          strategyId,
          grant?.id ?? null,
          reader,
          grant !== null,
          when,
        ]);
        return grant;
      });
    },
    async reads(strategyId) {
      const rows = await query<ReadSql>(
        sql,
        `SELECT strategy_id, grant_id, reader, granted, read_at FROM ${reads} WHERE strategy_id = $1 ORDER BY read_at, id`,
        [strategyId],
      );
      return rows.map(readOf);
    },
  };
}
