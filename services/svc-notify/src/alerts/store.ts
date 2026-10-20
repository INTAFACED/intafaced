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
  isSourcedAlertKind,
  type AlertCondition,
  type AlertDirection,
  type AlertSide,
  type AlertStatus,
  type CreatePriceAlertInput,
  type PriceAlert,
  type SourcedAlertKind,
} from './types.js';

export class AlertValidationError extends Error {
  readonly code: 'alert.invalid_price' | 'alert.invalid_market' | 'alert.invalid_direction' | 'alert.kind_unpublished';
  constructor(code: AlertValidationError['code'], message: string) {
    super(message);
    this.name = 'AlertValidationError';
    this.code = code;
  }
}

export interface AlertStore {
  create(input: CreatePriceAlertInput): Promise<PriceAlert>;
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
  /** Retire every active watch whose expiry has passed. Returns how many were expired. */
  expireDue(at: Date): Promise<number>;
  /** Remember which side of the target a crossing watch was last seen on. No-op for a watch that is not active. */
  setLastSide(userId: string, id: string, side: AlertSide): Promise<void>;
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
  return sourcedKind(input);
}

export class MemoryAlertStore implements AlertStore {
  private readonly byId = new Map<string, PriceAlert>();

  async create(input: CreatePriceAlertInput): Promise<PriceAlert> {
    const kind = assertCreate(input);
    const row: PriceAlert = {
      id: randomUUID(),
      userId: input.userId,
      marketId: input.marketId.trim(),
      kind,
      direction: directionOf(input),
      targetPrice: input.targetPrice.trim(),
      status: 'active',
      firedAt: null,
      createdAt: new Date(),
      condition: conditionOf(input),
      name: input.name ?? null,
      message: input.message ?? null,
      expiresAt: input.expiresAt ?? null,
      lastSide: null,
    };
    this.byId.set(row.id, row);
    return row;
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
    const next: PriceAlert = { ...row, status: 'cancelled' };
    this.byId.set(id, next);
    return next;
  }

  async expireDue(at: Date): Promise<number> {
    let expired = 0;
    for (const row of this.byId.values()) {
      if (row.status === 'active' && row.expiresAt !== null && row.expiresAt.getTime() <= at.getTime()) {
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
    const rows = await this.sql<AlertRow[]>`
      INSERT INTO notify.price_alerts (id, user_id, market_id, kind, direction, target_price, status, condition, name, message, expires_at)
      VALUES (${id}, ${input.userId}, ${input.marketId.trim()}, ${kind}, ${directionOf(input)}, ${input.targetPrice.trim()}, 'active',
        ${conditionOf(input)}, ${input.name ?? null}, ${input.message ?? null}, ${input.expiresAt ?? null})
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
    `;
    return mapRow(rows[0]!);
  }

  async list(userId: string, limit?: number): Promise<readonly PriceAlert[]> {
    const rows =
      limit == null
        ? await this.sql<AlertRow[]>`
            SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
            FROM notify.price_alerts
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
          `
        : await this.sql<AlertRow[]>`
            SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
            FROM notify.price_alerts
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `;
    return rows.map(mapRow);
  }

  async get(userId: string, id: string): Promise<PriceAlert | null> {
    const rows = await this.sql<AlertRow[]>`
      SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
      FROM notify.price_alerts
      WHERE user_id = ${userId} AND id = ${id}
      LIMIT 1
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listActiveByMarket(marketId: string): Promise<readonly PriceAlert[]> {
    const rows = await this.sql<AlertRow[]>`
      SELECT id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
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
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async cancel(userId: string, id: string): Promise<PriceAlert | null> {
    const rows = await this.sql<AlertRow[]>`
      UPDATE notify.price_alerts
      SET status = 'cancelled'
      WHERE user_id = ${userId} AND id = ${id} AND status = 'active'
      RETURNING id, user_id, market_id, kind, direction, target_price, status, fired_at, created_at, condition, name, message, expires_at, last_side
    `;
    if (rows[0]) return mapRow(rows[0]);
    return this.get(userId, id);
  }

  async expireDue(at: Date): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notify.price_alerts
      SET status = 'expired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${at}
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
  };
}
