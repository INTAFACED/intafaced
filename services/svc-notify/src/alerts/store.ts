/**
 * Price-alert watchlist store — memory for tests, Postgres for prod.
 *
 * Doctrine §2: notify schema only. No trade tables. Prices are text.
 */

import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { isValidPositivePrice } from './decimal.js';
import {
  ALERT_CONDITIONS,
  conditionOfDirection,
  directionOfCondition,
  isAlertPriceSource,
  isSourcedAlertKind,
  type AlertCondition,
  type AlertPriceSource,
  type AlertEditState,
  type AlertExtra,
  type AlertFrequency,
  type AlertStopReason,
  type AlertDirection,
  type AlertSide,
  type AlertStatus,
  type CreatePriceAlertInput,
  type PriceAlert,
  type SourcedAlertKind,
} from './types.js';

export class AlertValidationError extends Error {
  readonly code:
    'alert.invalid_price' | 'alert.invalid_market' | 'alert.invalid_direction' | 'alert.invalid_source' | 'alert.kind_unpublished';
  constructor(code: AlertValidationError['code'], message: string) {
    super(message);
    this.name = 'AlertValidationError';
    this.code = code;
  }
}

/** A create refused because the person already holds as many open alerts of the kind as the owner allows. Nothing was stored. */
export class AlertQuotaReachedError extends Error {
  /** `held` and `wanted` are set when several were asked for at once: the person holds `held` and asked for `wanted` more. */
  constructor(
    readonly limit: number,
    readonly held?: number,
    readonly wanted?: number,
  ) {
    super(`alert.quota_reached: ${limit}`);
    this.name = 'AlertQuotaReachedError';
  }
}

/** The owner's burst rule: more than `max` triggers of one alert inside `windowMs` stops it. */
export type BurstRule = { readonly windowMs: number; readonly max: number };

/** The burst window after one more trigger at `at`: the count restarts when the last window has run out. Pure, so both engines agree. */
export function nextBurst(
  state: { readonly burstStartedAt: Date | null; readonly burstCount: number },
  at: Date,
  rule: BurstRule,
): { readonly burstStartedAt: Date; readonly burstCount: number; readonly stop: boolean } {
  const open = state.burstStartedAt !== null && at.getTime() - state.burstStartedAt.getTime() <= rule.windowMs;
  const burstCount = open ? state.burstCount + 1 : 1;
  return { burstStartedAt: open ? state.burstStartedAt! : at, burstCount, stop: burstCount > rule.max };
}

export interface AlertStore {
  create(input: CreatePriceAlertInput): Promise<PriceAlert>;
  /**
   * Create several price alerts for one person as one step: all of them or none. Refused with `AlertQuotaReachedError` when the
   * person's open price alerts plus these would pass `maxOpen`, with nothing stored.
   */
  createMany(inputs: readonly CreatePriceAlertInput[], maxOpen: number): Promise<readonly PriceAlert[]>;
  /** How many alerts of a kind the person holds that are active or paused. Triggered, expired and cancelled ones do not count. */
  countOpen(userId: string, kind: SourcedAlertKind): Promise<number>;
  list(userId: string, limit?: number): Promise<readonly PriceAlert[]>;
  get(userId: string, id: string): Promise<PriceAlert | null>;
  /** Active alerts for a market — evaluation fan-in. */
  listActiveByMarket(marketId: string): Promise<readonly PriceAlert[]>;
  /**
   * Markets with at least one active watch.
   *
   * The sweep's fan-in: it must not need a list of markets from anywhere else,
   * because a market list held outside this table is a market list that drifts
   * and silently stops evaluating somebody's watch.
   */
  activeMarkets(): Promise<readonly string[]>;
  markFired(userId: string, id: string, at: Date): Promise<PriceAlert | null>;
  cancel(userId: string, id: string): Promise<PriceAlert | null>;
  /**
   * Replace the editable state of an alert that is active or stopped. The side a crossing was last seen on is forgotten, so a
   * changed target waits for a real crossing. `null` when the alert is not the person's or has already triggered, expired or
   * been cancelled.
   */
  replace(userId: string, id: string, next: AlertEditState, at: Date): Promise<PriceAlert | null>;
  /** Pause (`true`) an active alert or resume (`false`) a stopped one. Any other state is returned as it is. */
  setStopped(userId: string, id: string, stopped: boolean, at: Date): Promise<PriceAlert | null>;
  /** Remove an alert whatever its state. True when there was one to remove. */
  remove(userId: string, id: string): Promise<boolean>;
  /** Retire every active watch whose expiry has passed. Returns how many were expired. */
  expireDue(at: Date): Promise<number>;
  /** Remember which side of the target a crossing watch was last seen on. No-op for a watch that is not active. */
  setLastSide(userId: string, id: string, side: AlertSide): Promise<void>;
  /**
   * Count one more trigger of a repeating alert that stays active, and remember the side it triggered on so the next crossing is
   * a new one. Only applies while the stored fire count is still `fireCount`, so a retried sweep counts the same trigger once.
   * Returns the alert, or `null` when it was not active or had already counted this trigger.
   */
  recordRepeat(
    userId: string,
    id: string,
    fireCount: number,
    at: Date,
    side: AlertSide | null,
    burst?: BurstRule,
  ): Promise<PriceAlert | null>;
}

function sourcedKind(input: CreatePriceAlertInput): SourcedAlertKind {
  const kind = input.kind ?? 'price';
  if (!isSourcedAlertKind(kind)) {
    throw new AlertValidationError('alert.kind_unpublished', `kind=${String(kind)}`);
  }
  return kind;
}

/** The condition a create stores: the one named, else the level the direction meant before conditions existed. */
function conditionOf(input: CreatePriceAlertInput): AlertCondition {
  const condition = input.condition ?? conditionOfDirection(input.direction);
  if (!(ALERT_CONDITIONS as readonly string[]).includes(condition)) {
    throw new AlertValidationError('alert.invalid_direction', `condition=${String(condition)}`);
  }
  return condition;
}

/** A named condition decides the direction; a bare direction keeps meaning a level. */
function directionOf(input: CreatePriceAlertInput): AlertDirection {
  return input.condition ? directionOfCondition(input.condition) : input.direction;
}

/** The price source a create stores: the one named, else `mark`. A value outside the four refuses. */
function sourceOf(input: CreatePriceAlertInput): AlertPriceSource {
  const source = input.source ?? 'mark';
  if (!isAlertPriceSource(source)) {
    throw new AlertValidationError('alert.invalid_source', `source=${String(source)}`);
  }
  return source;
}

function assertCreate(input: CreatePriceAlertInput): SourcedAlertKind {
  if (!input.marketId.trim()) {
    throw new AlertValidationError('alert.invalid_market', 'marketId required');
  }
  if (input.direction !== 'above' && input.direction !== 'below') {
    throw new AlertValidationError('alert.invalid_direction', `direction=${input.direction}`);
  }
  if (!isValidPositivePrice(input.targetPrice)) {
    throw new AlertValidationError('alert.invalid_price', `targetPrice=${input.targetPrice}`);
  }
  sourceOf(input);
  return sourcedKind(input);
}

export class MemoryAlertStore implements AlertStore {
  private readonly byId = new Map<string, PriceAlert>();

  async create(input: CreatePriceAlertInput): Promise<PriceAlert> {
    const kind = assertCreate(input);
    // Counted and written with no pause between, so two creates racing for the last place cannot both pass.
    if (input.maxOpen !== undefined && this.openCount(input.userId, kind) >= input.maxOpen) {
      throw new AlertQuotaReachedError(input.maxOpen);
    }
    const createdAt = new Date();
    const row: PriceAlert = {
      id: randomUUID(),
      userId: input.userId,
      marketId: input.marketId.trim(),
      kind,
      direction: directionOf(input),
      targetPrice: input.targetPrice.trim(),
      status: 'active',
      firedAt: null,
      createdAt,
      condition: conditionOf(input),
      name: input.name ?? null,
      message: input.message ?? null,
      expiresAt: input.expiresAt ?? null,
      lastSide: null,
      extras: input.extras ?? [],
      updatedAt: createdAt,
      frequency: input.frequency ?? 'once',
      fireCount: 0,
      lastFiredAt: null,
      stopReason: null,
      burstStartedAt: null,
      burstCount: 0,
      source: sourceOf(input),
    };
    this.byId.set(row.id, row);
    return row;
  }

  async createMany(inputs: readonly CreatePriceAlertInput[], maxOpen: number): Promise<readonly PriceAlert[]> {
    const first = inputs[0];
    if (!first) return [];
    // Counted and written with no pause between, and checked for every input before any is written.
    const held = this.openCount(first.userId, 'price');
    if (held + inputs.length > maxOpen) throw new AlertQuotaReachedError(maxOpen, held, inputs.length);
    for (const input of inputs) assertCreate(input);
    // Each create writes before it first pauses, so every row is in before anything else can run.
    return Promise.all(inputs.map((input) => this.create({ ...input })));
  }

  private openCount(userId: string, kind: SourcedAlertKind): number {
    return [...this.byId.values()].filter(
      (r) => r.userId === userId && r.kind === kind && (r.status === 'active' || r.status === 'stopped'),
    ).length;
  }

  async countOpen(userId: string, kind: SourcedAlertKind): Promise<number> {
    return this.openCount(userId, kind);
  }

  async list(userId: string, limit?: number): Promise<readonly PriceAlert[]> {
    const rows = [...this.byId.values()].filter((r) => r.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return limit == null ? rows : rows.slice(0, limit);
  }

  async get(userId: string, id: string): Promise<PriceAlert | null> {
    const row = this.byId.get(id);
    return row && row.userId === userId ? row : null;
  }

  async listActiveByMarket(marketId: string): Promise<readonly PriceAlert[]> {
    return [...this.byId.values()].filter((r) => r.marketId === marketId && r.status === 'active');
  }

  async activeMarkets(): Promise<readonly string[]> {
    return [...new Set([...this.byId.values()].filter((r) => r.status === 'active').map((r) => r.marketId))].sort();
  }

  async markFired(userId: string, id: string, at: Date): Promise<PriceAlert | null> {
    const row = await this.get(userId, id);
    if (!row || row.status !== 'active') return null;
    const next: PriceAlert = { ...row, status: 'fired', firedAt: at };
    this.byId.set(id, next);
    return next;
  }

  async cancel(userId: string, id: string): Promise<PriceAlert | null> {
    const row = await this.get(userId, id);
    if (!row || row.status === 'cancelled') return row;
    if (row.status === 'fired' || row.status === 'expired') return row;
    const next: PriceAlert = { ...row, status: 'cancelled', updatedAt: new Date() };
    this.byId.set(id, next);
    return next;
  }

  async replace(userId: string, id: string, next: AlertEditState, at: Date): Promise<PriceAlert | null> {
    const row = await this.get(userId, id);
    if (!row || (row.status !== 'active' && row.status !== 'stopped')) return null;
    const updated: PriceAlert = { ...row, ...next, lastSide: null, updatedAt: at };
    this.byId.set(id, updated);
    return updated;
  }

  async setStopped(userId: string, id: string, stopped: boolean, at: Date): Promise<PriceAlert | null> {
    const row = await this.get(userId, id);
    if (!row) return null;
    if (stopped && row.status !== 'active') return row;
    if (!stopped && row.status !== 'stopped') return row;
    const updated: PriceAlert = {
      ...row,
      status: stopped ? 'stopped' : 'active',
      lastSide: null,
      stopReason: null,
      burstStartedAt: null,
      burstCount: 0,
      updatedAt: at,
    };
    this.byId.set(id, updated);
    return updated;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const row = await this.get(userId, id);
    return row ? this.byId.delete(id) : false;
  }

  async expireDue(at: Date): Promise<number> {
    let expired = 0;
    for (const row of this.byId.values()) {
      if ((row.status === 'active' || row.status === 'stopped') && row.expiresAt !== null && row.expiresAt.getTime() <= at.getTime()) {
        this.byId.set(row.id, { ...row, status: 'expired' });
        expired += 1;
      }
    }
    return expired;
  }

  async setLastSide(userId: string, id: string, side: AlertSide): Promise<void> {
    const row = await this.get(userId, id);
    if (row && row.status === 'active') this.byId.set(id, { ...row, lastSide: side });
  }

  async recordRepeat(
    userId: string,
    id: string,
    fireCount: number,
    at: Date,
    side: AlertSide | null,
    burst?: BurstRule,
  ): Promise<PriceAlert | null> {
    const row = await this.get(userId, id);
    if (!row || row.status !== 'active' || row.fireCount !== fireCount) return null;
    const counted = burst ? nextBurst(row, at, burst) : null;
    const next: PriceAlert = {
      ...row,
      fireCount: fireCount + 1,
      lastFiredAt: at,
      lastSide: side ?? row.lastSide,
      ...(counted
        ? {
            burstStartedAt: counted.burstStartedAt,
            burstCount: counted.burstCount,
            ...(counted.stop ? { status: 'stopped' as const, stopReason: 'burst' as const, updatedAt: at } : {}),
          }
        : {}),
    };
    this.byId.set(id, next);
    return next;
  }
}

/**
 * Postgres-backed store. Migration `0006_notify_price_alerts.sql`.
 * Instantiated only when DATABASE_URL is configured at boot.
 */
export class PostgresAlertStore implements AlertStore {
  constructor(private readonly sql: Sql) {}

  async create(input: CreatePriceAlertInput): Promise<PriceAlert> {
    const kind = assertCreate(input);
    const id = randomUUID();
    const insert = (sql: Sql) => sql<AlertRow[]>`
      INSERT INTO notify.price_alerts (id, user_id, market_id, kind, direction, target_price, status, condition, name, message, expires_at, extra_conditions, frequency, source)
      VALUES (${id}, ${input.userId}, ${input.marketId.trim()}, ${kind}, ${directionOf(input)}, ${input.targetPrice.trim()}, 'active',
        ${conditionOf(input)}, ${input.name ?? null}, ${input.message ?? null}, ${input.expiresAt ?? null}, ${sql.json((input.extras ?? []) as never)},
        ${input.frequency ?? 'once'}, ${sourceOf(input)})
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
    `;
    if (input.maxOpen === undefined) return mapRow((await insert(this.sql))[0]!);
    const maxOpen = input.maxOpen;
    // One create per person at a time while the cap is checked, so two racing creates cannot both pass it.
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.alert_quota:${input.userId}`}, 0))`;
      const [counted] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notify.price_alerts
        WHERE user_id = ${input.userId} AND kind = ${kind} AND status IN ('active', 'stopped')
      `;
      if ((counted?.n ?? 0) >= maxOpen) throw new AlertQuotaReachedError(maxOpen);
      return mapRow((await insert(tx as unknown as Sql))[0]!);
    });
  }

  async createMany(inputs: readonly CreatePriceAlertInput[], maxOpen: number): Promise<readonly PriceAlert[]> {
    const first = inputs[0];
    if (!first) return [];
    for (const input of inputs) assertCreate(input);
    // One transaction under the same per-person lock a single create takes, so the batch is all in or all out.
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notify.alert_quota:${first.userId}`}, 0))`;
      const [counted] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notify.price_alerts
        WHERE user_id = ${first.userId} AND kind = 'price' AND status IN ('active', 'stopped')
      `;
      const held = counted?.n ?? 0;
      if (held + inputs.length > maxOpen) throw new AlertQuotaReachedError(maxOpen, held, inputs.length);
      const rows: PriceAlert[] = [];
      for (const input of inputs) {
        const [row] = await tx<AlertRow[]>`
          INSERT INTO notify.price_alerts (id, user_id, market_id, kind, direction, target_price, status, condition, name, message, expires_at, extra_conditions, frequency, source)
          VALUES (${randomUUID()}, ${input.userId}, ${input.marketId.trim()}, 'price', ${directionOf(input)}, ${input.targetPrice.trim()}, 'active',
            ${conditionOf(input)}, ${input.name ?? null}, ${input.message ?? null}, ${input.expiresAt ?? null}, ${tx.json((input.extras ?? []) as never)},
            ${input.frequency ?? 'once'}, ${sourceOf(input)})
          RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
        `;
        rows.push(mapRow(row!));
      }
      return rows;
    });
  }

  async countOpen(userId: string, kind: SourcedAlertKind): Promise<number> {
    const [counted] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notify.price_alerts
      WHERE user_id = ${userId} AND kind = ${kind} AND status IN ('active', 'stopped')
    `;
    return counted?.n ?? 0;
  }

  async list(userId: string, limit?: number): Promise<readonly PriceAlert[]> {
    const rows =
      limit == null
        ? await this.sql<AlertRow[]>`
            SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
            FROM notify.price_alerts
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
          `
        : await this.sql<AlertRow[]>`
            SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
            FROM notify.price_alerts
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
    return rows.map(mapRow);
  }

  async get(userId: string, id: string): Promise<PriceAlert | null> {
    const rows = await this.sql<AlertRow[]>`
      SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
      FROM notify.price_alerts
      WHERE user_id = ${userId} AND id = ${id}
      LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listActiveByMarket(marketId: string): Promise<readonly PriceAlert[]> {
    const rows = await this.sql<AlertRow[]>`
      SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
      FROM notify.price_alerts
      WHERE market_id = ${marketId} AND status = 'active'
    `;
    return rows.map(mapRow);
  }

  async activeMarkets(): Promise<readonly string[]> {
    const rows = await this.sql<{ market_id: string }[]>`
      SELECT DISTINCT market_id
      FROM notify.price_alerts
      WHERE status = 'active'
      ORDER BY market_id
    `;
    return rows.map((r) => r.market_id);
  }

  async markFired(userId: string, id: string, at: Date): Promise<PriceAlert | null> {
    const rows = await this.sql<AlertRow[]>`
      UPDATE notify.price_alerts
      SET status = 'fired', fired_at = ${at}
      WHERE user_id = ${userId} AND id = ${id} AND status = 'active'
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async cancel(userId: string, id: string): Promise<PriceAlert | null> {
    const rows = await this.sql<AlertRow[]>`
      UPDATE notify.price_alerts
      SET status = 'cancelled', updated_at = now()
      WHERE user_id = ${userId} AND id = ${id} AND status IN ('active', 'stopped')
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
    `;
    if (rows[0]) return mapRow(rows[0]);
    return this.get(userId, id);
  }

  async replace(userId: string, id: string, next: AlertEditState, at: Date): Promise<PriceAlert | null> {
    const rows = await this.sql<AlertRow[]>`
      UPDATE notify.price_alerts
      SET direction = ${next.direction}, target_price = ${next.targetPrice}, condition = ${next.condition}, name = ${next.name},
          message = ${next.message}, expires_at = ${next.expiresAt}, extra_conditions = ${this.sql.json(next.extras as never)},
          frequency = ${next.frequency}, source = ${next.source}, last_side = NULL, updated_at = ${at}
      WHERE user_id = ${userId} AND id = ${id} AND status IN ('active', 'stopped')
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async setStopped(userId: string, id: string, stopped: boolean, at: Date): Promise<PriceAlert | null> {
    const from = stopped ? 'active' : 'stopped';
    const to = stopped ? 'stopped' : 'active';
    const rows = await this.sql<AlertRow[]>`
      UPDATE notify.price_alerts
      SET status = ${to}, last_side = NULL, stop_reason = NULL, burst_started_at = NULL, burst_count = 0, updated_at = ${at}
      WHERE user_id = ${userId} AND id = ${id} AND status = ${from}
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
    `;
    if (rows[0]) return mapRow(rows[0]);
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`DELETE FROM notify.price_alerts WHERE user_id = ${userId} AND id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async expireDue(at: Date): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notify.price_alerts
      SET status = 'expired'
      WHERE status IN ('active', 'stopped') AND expires_at IS NOT NULL AND expires_at <= ${at}
      RETURNING id
    `;
    return rows.length;
  }

  async setLastSide(userId: string, id: string, side: AlertSide): Promise<void> {
    await this.sql`
      UPDATE notify.price_alerts
      SET last_side = ${side}
      WHERE user_id = ${userId} AND id = ${id} AND status = 'active'
    `;
  }

  async recordRepeat(
    userId: string,
    id: string,
    fireCount: number,
    at: Date,
    side: AlertSide | null,
    burst?: BurstRule,
  ): Promise<PriceAlert | null> {
    // The row is locked while the window is counted, so two sweeps cannot both count into the same window.
    return this.sql.begin(async (tx) => {
      const [row] = await tx<AlertRow[]>`
        SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
        FROM notify.price_alerts
        WHERE user_id = ${userId} AND id = ${id} AND status = 'active' AND fire_count = ${fireCount}
        FOR UPDATE
      `;
      if (!row) return null;
      const counted = burst ? nextBurst({ burstStartedAt: row.burst_started_at, burstCount: row.burst_count }, at, burst) : null;
      const stop = counted?.stop === true;
      const [updated] = await tx<AlertRow[]>`
        UPDATE notify.price_alerts
        SET fire_count = fire_count + 1, last_fired_at = ${at}, last_side = COALESCE(${side}, last_side),
            burst_started_at = ${counted ? counted.burstStartedAt : row.burst_started_at},
            burst_count = ${counted ? counted.burstCount : row.burst_count},
            status = ${stop ? 'stopped' : 'active'}, stop_reason = ${stop ? 'burst' : null},
            updated_at = ${stop ? at : row.updated_at}
        WHERE user_id = ${userId} AND id = ${id}
        RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side, extra_conditions, updated_at, frequency, fire_count, last_fired_at, stop_reason, burst_started_at, burst_count, source
      `;
      return updated ? mapRow(updated) : null;
    });
  }
}

type AlertRow = {
  id: string;
  user_id: string;
  market_id: string;
  kind: SourcedAlertKind;
  direction: AlertDirection;
  target_price: string;
  status: AlertStatus;
  fired_at: Date | null;
  created_at: Date;
  condition: AlertCondition;
  name: string | null;
  message: string | null;
  expires_at: Date | null;
  last_side: AlertSide | null;
  extra_conditions: AlertExtra[] | null;
  updated_at: Date;
  frequency: AlertFrequency;
  fire_count: number;
  last_fired_at: Date | null;
  stop_reason: AlertStopReason | null;
  burst_started_at: Date | null;
  burst_count: number;
  source: AlertPriceSource;
};

function mapRow(r: AlertRow): PriceAlert {
  return {
    id: r.id,
    userId: r.user_id,
    marketId: r.market_id,
    kind: isSourcedAlertKind(r.kind) ? r.kind : 'price',
    direction: r.direction,
    targetPrice: r.target_price,
    status: r.status,
    firedAt: r.fired_at,
    createdAt: r.created_at,
    condition: r.condition,
    name: r.name,
    message: r.message,
    expiresAt: r.expires_at,
    lastSide: r.last_side,
    extras: r.extra_conditions ?? [],
    updatedAt: r.updated_at,
    frequency: r.frequency === 'every_crossing' ? 'every_crossing' : 'once',
    fireCount: r.fire_count,
    lastFiredAt: r.last_fired_at,
    stopReason: r.stop_reason === 'burst' ? 'burst' : null,
    burstStartedAt: r.burst_started_at,
    burstCount: r.burst_count,
    source: isAlertPriceSource(r.source) ? r.source : 'mark',
  };
}
