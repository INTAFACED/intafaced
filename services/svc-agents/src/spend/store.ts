import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import type { SpendGate, SpendLimitView, SpendPeriod, SpendReservationView } from './gate.js';
import { canonicalAmount, decideReservation, parseSpendAmount, parseSpendLimitInput, periodStart, type SpendScope } from './limits.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LimitRow {
  asset_id: string;
  per_call: string;
  per_session: string;
  per_period: string;
  period: SpendPeriod;
  updated_at: Date;
}

interface ReservationRow {
  reservation_key: string;
  session_id: string;
  asset_id: string;
  amount: string;
  committed_amount: string | null;
  status: 'held' | 'committed' | 'released';
}

function spendLimit(cap: Amount, assetId: string, scope: SpendScope): AgentError {
  return new AgentError(
    `Spend ${scope} cap ${canonicalAmount(cap)} ${assetId} would be exceeded`,
    'agents.spend_limit',
    'agents.refused.spend_cap',
    { limit: canonicalAmount(cap), asset: assetId, scope },
  );
}

function viewLimit(row: LimitRow): SpendLimitView {
  return {
    assetId: row.asset_id,
    perCall: canonicalAmount(parseAmount(row.per_call)),
    perSession: canonicalAmount(parseAmount(row.per_session)),
    perPeriod: canonicalAmount(parseAmount(row.per_period)),
    period: row.period,
  };
}

function viewReservation(row: ReservationRow, replayed: boolean): SpendReservationView {
  return {
    reservationKey: row.reservation_key,
    sessionId: row.session_id,
    assetId: row.asset_id,
    amount: canonicalAmount(parseAmount(row.amount)),
    committedAmount: row.committed_amount == null ? null : canonicalAmount(parseAmount(row.committed_amount)),
    status: row.status,
    replayed,
  };
}

async function lockUser(tx: Sql, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agents.spend:${userId}`}, 0))`;
}

async function readLimit(tx: Sql, userId: string): Promise<LimitRow | null> {
  const rows = await tx<LimitRow[]>`
    SELECT asset_id, per_call::text, per_session::text, per_period::text, period, updated_at
      FROM agents.user_spend_limits
     WHERE user_id = ${userId}
  `;
  return rows[0] ?? null;
}

async function summed(tx: Sql, userId: string, sessionId: string | null, periodStartAt: Date | null): Promise<Amount> {
  const rows =
    sessionId !== null
      ? await tx<Array<{ total: string }>>`
          SELECT COALESCE(SUM(
            CASE
              WHEN status = 'held' THEN amount
              WHEN status = 'committed' THEN committed_amount
              ELSE 0::numeric
            END
          ), 0::numeric)::text AS total
            FROM agents.spend_reservations
           WHERE user_id = ${userId}
             AND session_id = ${sessionId}
             AND status IN ('held', 'committed')
        `
      : await tx<Array<{ total: string }>>`
          SELECT COALESCE(SUM(
            CASE
              WHEN status = 'held' THEN amount
              WHEN status = 'committed' THEN committed_amount
              ELSE 0::numeric
            END
          ), 0::numeric)::text AS total
            FROM agents.spend_reservations
           WHERE user_id = ${userId}
             AND created_at >= ${periodStartAt}
             AND status IN ('held', 'committed')
        `;
  return parseAmount(rows[0]?.total ?? '0');
}

/**
 * User-set spend caps and the holds against them.
 *
 * No ledger recipe: a reservation is not a balance. Two calls with the same
 * idempotency key and the same body write once.
 */
export class UserSpendStore implements SpendGate {
  constructor(private readonly sql: Sql) {}

  async get(userId: string): Promise<SpendLimitView | null> {
    const row = await readLimit(this.sql, userId);
    return row ? viewLimit(row) : null;
  }

  async set(input: {
    userId: string;
    assetId?: string | null;
    perCall?: string | null;
    perSession?: string | null;
    perPeriod?: string | null;
    period?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ readonly limits: SpendLimitView; readonly replayed: boolean }> {
    const parsed = parseSpendLimitInput(input);
    const digest = createHash('sha256')
      .update(
        [
          parsed.assetId,
          canonicalAmount(parsed.perCall),
          canonicalAmount(parsed.perSession),
          canonicalAmount(parsed.perPeriod),
          parsed.period,
        ].join('\n'),
      )
      .digest('hex');

    return transaction(
      this.sql,
      async (tx) => {
        await lockUser(tx, input.userId);
        const inserted = await tx<Array<{ idempotency_key: string }>>`
          INSERT INTO agents.spend_limit_requests (user_id, idempotency_key, digest)
          VALUES (${input.userId}, ${parsed.idempotencyKey}, ${digest})
          ON CONFLICT (user_id, idempotency_key) DO NOTHING
          RETURNING idempotency_key
        `;
        if (inserted.length === 0) {
          const prior = await tx<Array<{ digest: string }>>`
            SELECT digest FROM agents.spend_limit_requests
             WHERE user_id = ${input.userId} AND idempotency_key = ${parsed.idempotencyKey}
          `;
          if (prior[0]?.digest !== digest) {
            throw new AgentError(
              `Idempotency key ${parsed.idempotencyKey} already stored a different spend limit`,
              'agents.spend_idempotency_conflict',
              'agents.refused.spend_idempotency_conflict',
            );
          }
          const existing = await readLimit(tx, input.userId);
          if (!existing) {
            throw new AgentError('Stored spend limit row is missing', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
          }
          return { limits: viewLimit(existing), replayed: true };
        }

        const perCall = canonicalAmount(parsed.perCall);
        const perSession = canonicalAmount(parsed.perSession);
        const perPeriod = canonicalAmount(parsed.perPeriod);
        const rows = await tx<LimitRow[]>`
          INSERT INTO agents.user_spend_limits (user_id, asset_id, per_call, per_session, per_period, period)
          VALUES (${input.userId}, ${parsed.assetId}, ${perCall}::numeric, ${perSession}::numeric, ${perPeriod}::numeric, ${parsed.period})
          ON CONFLICT (user_id) DO UPDATE SET
            asset_id = EXCLUDED.asset_id,
            per_call = EXCLUDED.per_call,
            per_session = EXCLUDED.per_session,
            per_period = EXCLUDED.per_period,
            period = EXCLUDED.period,
            updated_at = now()
          RETURNING asset_id, per_call::text, per_session::text, per_period::text, period, updated_at
        `;
        const row = rows[0];
        if (!row) throw new AgentError('Spend limit was not stored', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
        return { limits: viewLimit(row), replayed: false };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async reserve(input: {
    userId: string;
    sessionId: string;
    reservationKey: string;
    assetId: string;
    amount: string;
    now?: Date;
  }): Promise<SpendReservationView> {
    const amount = parseSpendAmount(input.amount, 'reservation');
    const assetId = input.assetId?.trim() ?? '';
    if (assetId === '') {
      throw new AgentError('Reservation asset is blank', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
    }
    const reservationKey = input.reservationKey?.trim() ?? '';
    if (reservationKey === '' || reservationKey.length > 200) {
      throw new AgentError('Reservation key is blank', 'agents.spend_limit_invalid', 'agents.refused.spend_limit_invalid');
    }
    if (!UUID_RE.test(input.sessionId)) {
      throw new AgentError(`No session ${input.sessionId}`, 'agents.session_not_found', 'agents.refused.session_closed');
    }
    const now = input.now ?? new Date();

    return transaction(
      this.sql,
      async (tx) => {
        await lockUser(tx, input.userId);
        const session = await tx<Array<{ user_id: string }>>`
          SELECT user_id FROM agents.agent_sessions WHERE id = ${input.sessionId}
        `;
        if (session[0]?.user_id !== input.userId) {
          throw new AgentError(`No session ${input.sessionId}`, 'agents.session_not_found', 'agents.refused.session_closed');
        }
        const limit = await readLimit(tx, input.userId);
        if (!limit) {
          throw new AgentError('User spend limit is unset', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
        }
        if (limit.asset_id !== assetId) {
          throw new AgentError(
            `Reservation asset ${assetId} does not match the spend limit asset ${limit.asset_id}`,
            'agents.spend_limit_invalid',
            'agents.refused.spend_limit_invalid',
          );
        }

        const existing = await tx<ReservationRow[]>`
          SELECT reservation_key, session_id, asset_id, amount::text, committed_amount::text, status
            FROM agents.spend_reservations
           WHERE user_id = ${input.userId} AND reservation_key = ${reservationKey}
           FOR UPDATE
        `;
        const prior = existing[0];
        const wanted = canonicalAmount(amount);
        if (prior && prior.status !== 'released') {
          const same =
            prior.session_id === input.sessionId && prior.asset_id === assetId && canonicalAmount(parseAmount(prior.amount)) === wanted;
          if (!same) {
            throw new AgentError(
              `Reservation key ${reservationKey} is already held for a different call`,
              'agents.spend_reservation_conflict',
              'agents.refused.spend_reservation_conflict',
            );
          }
          return viewReservation(prior, true);
        }

        const start = periodStart(limit.period, now);
        const sessionUsed = await summed(tx, input.userId, input.sessionId, null);
        const periodUsed = await summed(tx, input.userId, null, start);
        const decision = decideReservation({
          perCall: parseAmount(limit.per_call),
          perSession: parseAmount(limit.per_session),
          perPeriod: parseAmount(limit.per_period),
          sessionUsed,
          periodUsed,
          amount,
        });
        if (!decision.ok) throw spendLimit(decision.cap, assetId, decision.scope);

        if (prior?.status === 'released') {
          const updated = await tx<ReservationRow[]>`
            UPDATE agents.spend_reservations
               SET session_id = ${input.sessionId},
                   asset_id = ${assetId},
                   amount = ${wanted}::numeric,
                   committed_amount = NULL,
                   status = 'held',
                   created_at = ${now},
                   updated_at = ${now}
             WHERE user_id = ${input.userId} AND reservation_key = ${reservationKey}
            RETURNING reservation_key, session_id, asset_id, amount::text, committed_amount::text, status
          `;
          const row = updated[0];
          if (!row) throw new AgentError('Reservation was not re-held', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
          return viewReservation(row, false);
        }

        const inserted = await tx<ReservationRow[]>`
          INSERT INTO agents.spend_reservations (user_id, reservation_key, session_id, asset_id, amount, status, created_at, updated_at)
          VALUES (${input.userId}, ${reservationKey}, ${input.sessionId}, ${assetId}, ${wanted}::numeric, 'held', ${now}, ${now})
          RETURNING reservation_key, session_id, asset_id, amount::text, committed_amount::text, status
        `;
        const row = inserted[0];
        if (!row) throw new AgentError('Reservation was not stored', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
        return viewReservation(row, false);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  async commitIn(tx: Sql, input: { userId: string; reservationKey: string; amount: string }): Promise<SpendReservationView> {
    await lockUser(tx, input.userId);
    return this.finish(tx, input, 'commit');
  }

  async commit(input: { userId: string; reservationKey: string; amount: string }): Promise<SpendReservationView> {
    return transaction(this.sql, async (tx) => this.commitIn(tx, input), { isolation: 'read committed', maxAttempts: 5 });
  }

  async release(input: { userId: string; reservationKey: string }): Promise<SpendReservationView> {
    return transaction(
      this.sql,
      async (tx) => {
        await lockUser(tx, input.userId);
        return this.finish(tx, { ...input, amount: '0' }, 'release');
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async finish(
    tx: Sql,
    input: { userId: string; reservationKey: string; amount: string },
    op: 'commit' | 'release',
  ): Promise<SpendReservationView> {
    const reservationKey = input.reservationKey.trim();
    if (reservationKey === '') {
      throw new AgentError('Reservation key is blank', 'agents.spend_limit_invalid', 'agents.refused.spend_limit_invalid');
    }
    const rows = await tx<ReservationRow[]>`
      SELECT reservation_key, session_id, asset_id, amount::text, committed_amount::text, status
        FROM agents.spend_reservations
       WHERE user_id = ${input.userId} AND reservation_key = ${reservationKey}
       FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new AgentError(
        `No reservation ${reservationKey}`,
        'agents.spend_reservation_not_found',
        'agents.refused.spend_reservation_missing',
      );
    }
    if (op === 'release') {
      if (row.status === 'released') return viewReservation(row, true);
      if (row.status === 'committed') {
        throw new AgentError(
          `Reservation ${reservationKey} is already committed`,
          'agents.spend_reservation_closed',
          'agents.refused.spend_reservation_closed',
        );
      }
      const updated = await tx<ReservationRow[]>`
        UPDATE agents.spend_reservations
           SET status = 'released', updated_at = now()
         WHERE user_id = ${input.userId} AND reservation_key = ${reservationKey}
        RETURNING reservation_key, session_id, asset_id, amount::text, committed_amount::text, status
      `;
      const next = updated[0];
      if (!next)
        throw new AgentError(
          'Reservation was not released',
          'agents.spend_reservation_not_found',
          'agents.refused.spend_reservation_missing',
        );
      return viewReservation(next, false);
    }

    const actual = parseSpendAmount(input.amount, 'committed spend');
    const reserved = parseAmount(row.amount);
    if (row.status === 'committed') {
      const previous = row.committed_amount == null ? null : parseAmount(row.committed_amount);
      if (previous === actual) return viewReservation(row, true);
      throw new AgentError(
        `Reservation ${reservationKey} is already committed for a different amount`,
        'agents.spend_reservation_conflict',
        'agents.refused.spend_reservation_conflict',
      );
    }
    if (row.status === 'released') {
      throw new AgentError(
        `Reservation ${reservationKey} was released`,
        'agents.spend_reservation_closed',
        'agents.refused.spend_reservation_closed',
      );
    }
    if (actual > reserved) throw spendLimit(reserved, row.asset_id, 'call');
    const committed = canonicalAmount(actual);
    const updated = await tx<ReservationRow[]>`
      UPDATE agents.spend_reservations
         SET status = 'committed', committed_amount = ${committed}::numeric, updated_at = now()
       WHERE user_id = ${input.userId} AND reservation_key = ${reservationKey}
      RETURNING reservation_key, session_id, asset_id, amount::text, committed_amount::text, status
    `;
    const next = updated[0];
    if (!next)
      throw new AgentError(
        'Reservation was not committed',
        'agents.spend_reservation_not_found',
        'agents.refused.spend_reservation_missing',
      );
    return viewReservation(next, false);
  }
}
