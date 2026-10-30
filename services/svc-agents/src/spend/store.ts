import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { windowCost, type UsageGroup } from '../metering/pricing.js';
import type { SpendGate, SpendLimitView, SpendPeriod, SpendReservationView } from './gate.js';
import { canonicalAmount, decideReservation, parseSpendAmount, parseSpendLimitInput, periodStart, type SpendScope } from './limits.js';
import { readOwnCaps } from '../own/limits.js';

/** A session of a person's own agent carries `own.<agent id>` as its agent id (see `AgentRuntime.openOwnSession`). */
const OWN_PREFIX = 'own.';

function ownCapExceeded(cap: Amount, assetId: string, scope: 'call' | 'session' | 'month'): AgentError {
  return new AgentError(
    `Own agent ${scope} cap ${canonicalAmount(cap)} ${assetId} would be exceeded`,
    'agents.spend.cap_exceeded',
    'agents.refused.spend_cap',
    { limit: canonicalAmount(cap), asset: assetId, scope },
  );
}

/** Held and committed holds on this person's sessions of one own agent since `since`. */
async function ownAgentUsed(tx: Sql, userId: string, agentId: string, since: Date): Promise<Amount> {
  const rows = await tx<Array<{ total: string }>>`
    SELECT COALESCE(SUM(
      CASE
        WHEN r.status = 'held' THEN r.amount
        WHEN r.status = 'committed' THEN r.committed_amount
        ELSE 0::numeric
      END
    ), 0::numeric)::text AS total
      FROM agents.spend_reservations r
      JOIN agents.agent_sessions s ON s.id = r.session_id
     WHERE r.user_id = ${userId}
       AND s.user_id = ${userId}
       AND s.agent_id = ${agentId}
       AND r.created_at >= ${since}
       AND r.status IN ('held', 'committed')
  `;
  return parseAmount(rows[0]?.total ?? '0');
}

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

/** Seconds, as a decimal string. Blank is unset. Zero is a real age. Never invent one. */
function parseHoldMaxAge(maxAge: string | null | undefined): string {
  if (maxAge == null || maxAge.trim() === '') {
    throw new AgentError(
      'Spend hold max age is unset — refusing rather than inventing an age',
      'agents.spend_hold_max_age_unset',
      'agents.refused.spend_hold_max_age_unset',
    );
  }
  const age = maxAge.trim();
  if (!/^\d+(\.\d+)?$/.test(age)) {
    throw new AgentError(
      'Spend hold max age is not a number of seconds',
      'agents.spend_limit_invalid',
      'agents.refused.spend_limit_invalid',
    );
  }
  return age;
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

/**
 * What the person already owes or has on hold: usage in every window of theirs not yet charged (sealed or not), plus
 * every hold still held in this asset. A held run has no usage row yet, and a committed one is in its window, so the
 * two never count one run twice. Usage is metered in the one fee asset, so its windows count for that asset.
 */
async function exposure(tx: Sql, userId: string, assetId: string): Promise<Amount> {
  const usage = await tx<
    Array<{ session_id: string; window_id: string; input_tokens: string; output_tokens: string; in_price: string; out_price: string }>
  >`
    SELECT r.session_id::text AS session_id, r.window_id,
           SUM(r.input_tokens)::text  AS input_tokens,
           SUM(r.output_tokens)::text AS output_tokens,
           r.input_price_per_million  AS in_price,
           r.output_price_per_million AS out_price
      FROM agents.usage_records r
      JOIN agents.usage_windows w ON w.session_id = r.session_id AND w.window_id = r.window_id
      JOIN agents.agent_sessions s ON s.id = r.session_id
     WHERE s.user_id = ${userId} AND w.charge_tx_id IS NULL
     GROUP BY r.session_id, r.window_id, r.input_price_per_million, r.output_price_per_million
  `;
  const windows = new Map<string, UsageGroup[]>();
  for (const r of usage) {
    const key = `${r.session_id}:${r.window_id}`;
    const groups = windows.get(key) ?? [];
    groups.push({
      inputTokens: BigInt(r.input_tokens ?? '0'),
      outputTokens: BigInt(r.output_tokens ?? '0'),
      price: { inputPerMillion: parseAmount(r.in_price), outputPerMillion: parseAmount(r.out_price) },
    });
    windows.set(key, groups);
  }
  let owed = 0n;
  for (const groups of windows.values()) owed += windowCost(groups);

  const held = await tx<Array<{ total: string }>>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM agents.spend_reservations
     WHERE user_id = ${userId} AND asset_id = ${assetId} AND status = 'held'
  `;
  return owed + parseAmount(held[0]?.total ?? '0');
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
    /**
     * The agent's own stored cap per session. A person who has set no limits of their own runs under this cap alone
     * (OWNER 107); absent, a person with no limits is refused, as before. Set, it also caps a person whose own
     * limit is higher: the lower of the two applies.
     */
    agentCap?: string | null;
    /** The person's available balance, read under this reservation's lock (see `SpendGate.reserve`). */
    funds?: () => Promise<Amount | null>;
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
        const session = await tx<Array<{ user_id: string; agent_id: string }>>`
          SELECT user_id, agent_id FROM agents.agent_sessions WHERE id = ${input.sessionId}
        `;
        if (session[0]?.user_id !== input.userId) {
          throw new AgentError(`No session ${input.sessionId}`, 'agents.session_not_found', 'agents.refused.session_closed');
        }
        // A session of the person's own agent is held against the caps they set for that agent, read here under the
        // lock as they stand now. Any of them unset refuses: nothing of an own agent runs uncapped.
        const ownAgentId = session[0].agent_id.startsWith(OWN_PREFIX) ? session[0].agent_id : null;
        const own = ownAgentId ? await readOwnCaps(tx, input.userId, ownAgentId.slice(OWN_PREFIX.length)) : null;
        if (ownAgentId && !own) {
          throw new AgentError('Own agent caps are unset', 'agents.spend.cap_unset', 'agents.refused.spend_limit_unset');
        }
        const limit = await readLimit(tx, input.userId);
        const agentCap = input.agentCap ? parseSpendAmount(input.agentCap, 'agent cap') : null;
        if (!limit && agentCap === null && !own) {
          throw new AgentError('User spend limit is unset', 'agents.spend_limit_unset', 'agents.refused.spend_limit_unset');
        }
        if (limit && limit.asset_id !== assetId) {
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

        const sessionUsed = await summed(tx, input.userId, input.sessionId, null);
        if (limit) {
          const start = periodStart(limit.period, now);
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
        }
        if (own && ownAgentId) {
          // Every hold of the session and of the month counts, held ones included, so two runs at once whose worst
          // cases together pass a cap cannot both be admitted.
          if (amount > own.perCall) throw ownCapExceeded(own.perCall, assetId, 'call');
          if (sessionUsed + amount > own.perSession) throw ownCapExceeded(own.perSession, assetId, 'session');
          const monthUsed = await ownAgentUsed(tx, input.userId, ownAgentId, periodStart(own.period, now));
          if (monthUsed + amount > own.perPeriod) throw ownCapExceeded(own.perPeriod, assetId, 'month');
        }
        if (agentCap !== null && sessionUsed + amount > agentCap) {
          // The agent's cap holds every run of the session, held ones included, so two runs at once cannot both fit
          // under it. It applies whether or not the person set limits of their own: the lower of the two wins.
          throw spendLimit(agentCap, assetId, 'session');
        }

        if (input.funds) {
          // Funds are read under the same per-user lock as the caps, after what is already owed, so two runs at once
          // cannot both count one balance. Owed first, balance second: a charge that settles in between can only make
          // this refuse, never admit too much. A read that fails refuses — an unknown balance is not a covered one.
          const owed = await exposure(tx, input.userId, assetId);
          let available: Amount | null;
          try {
            available = await input.funds();
          } catch {
            available = null;
          }
          if (available === null) {
            // The message key stays the funds one: the run is refused for funds not shown to cover it. The code says
            // the balance was not read, so the person is told that, not that they are short.
            throw new AgentError(
              `Available balance could not be read to cover ${canonicalAmount(amount)} ${assetId}`,
              'agents.funds_unread',
              'agents.refused.funds_insufficient',
              { worstCase: canonicalAmount(amount), asset: assetId },
            );
          }
          if (available - owed < amount) {
            throw new AgentError(
              `Available balance does not cover ${canonicalAmount(amount)} ${assetId} after ${canonicalAmount(owed)} owed`,
              'agents.funds_insufficient',
              'agents.refused.funds_insufficient',
              { worstCase: canonicalAmount(amount), asset: assetId },
            );
          }
        }

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

  /**
   * Release held rows older than `maxAge` seconds.
   *
   * A row with a usage record for the same session and reservation key stays
   * held: an effect already happened. The matching think claim is deleted in
   * the same transaction as the release. Idempotent. No default age.
   */
  async releaseStaleHolds(input: { maxAge: string | null | undefined; now?: Date }): Promise<{ released: number }> {
    const maxAge = parseHoldMaxAge(input.maxAge);
    const now = input.now ?? new Date();
    return transaction(
      this.sql,
      async (tx) => {
        const users = await tx<Array<{ user_id: string }>>`
          SELECT DISTINCT user_id
            FROM agents.spend_reservations
           WHERE status = 'held'
             AND created_at < ${now}::timestamptz - (${maxAge}::numeric * interval '1 second')
           ORDER BY user_id
        `;
        for (const user of users) await lockUser(tx, user.user_id);
        const rows = await tx<Array<{ n: string }>>`
          WITH doomed AS (
            SELECT r.user_id, r.reservation_key, r.session_id
              FROM agents.spend_reservations r
             WHERE r.status = 'held'
               AND r.created_at < ${now}::timestamptz - (${maxAge}::numeric * interval '1 second')
               AND NOT EXISTS (
                 SELECT 1
                   FROM agents.usage_records u
                  WHERE u.session_id = r.session_id
                    AND u.request_id = r.reservation_key
               )
             FOR UPDATE OF r
          ),
          released_rows AS (
            UPDATE agents.spend_reservations r
               SET status = 'released',
                   updated_at = ${now}
              FROM doomed d
             WHERE r.user_id = d.user_id
               AND r.reservation_key = d.reservation_key
               AND r.status = 'held'
            RETURNING r.session_id, r.reservation_key
          ),
          dropped AS (
            DELETE FROM agents.think_claims c
             USING released_rows rel
             WHERE c.session_id = rel.session_id
               AND c.request_id = rel.reservation_key
            RETURNING c.session_id
          )
          SELECT count(*)::text AS n FROM released_rows
        `;
        return { released: Number(rows[0]?.n ?? '0') };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
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
