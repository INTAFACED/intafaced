/**
 * Margin and liquidation-risk alerts on futures positions (D-account-03, `derivatives-account-wallet-ops-008`;
 * J-derivatives-06 #6: "One alert per crossing; with no risk levels set the toggle says 'set your risk levels' and the
 * liquidation alert still fires").
 *
 * Two alerts, two owners of the decision:
 *   · The liquidation warning is the margin call (`margin-call-transport.ts`): the venue's own level, always on. The
 *     trader cannot turn it off, and it needs no level from them.
 *   · Liquidation-risk alerts are the trader's own levels: margin ratios (maintenance over equity, as on Account
 *     metrics) at which they want to hear. Blank levels cannot be turned on (`trade.risk_alert_levels_unset`), and no
 *     level is ever filled in for them.
 *
 * One alert per crossing: a crossing of one level by one position starts when the ratio reaches the level and ends when
 * it is back under it (or the position is no longer open, or the level is gone). A re-tick above the level is the same
 * crossing. The next rise is the next generation, and its alert is keyed (position, level, generation), so a replay
 * of the event or of the tick tells the trader nothing new.
 *
 * Crash safety: the crossing row is written first and its alert published after (`announced_at`); a crash or a bus
 * failure in between leaves the row unannounced, and the next tick publishes it with the same key.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { EventBus } from '@intafaced/events';
import type { Sql } from 'postgres';
import { FuturesError, type RiskStopFigures } from './position-service.js';
import { levelFromPercent, percentOf, riskStopReached } from './risk-stop.js';

export const RISK_ALERT_INVALID = 'trade.risk_alert_invalid';
export const RISK_ALERT_LEVELS_UNSET = 'trade.risk_alert_levels_unset';
/** Bounds the work one tick does per position; not a product limit on how careful a trader may be. */
export const RISK_ALERT_MAX_LEVELS = 10;

export interface RiskAlertsView {
  /** On only with at least one level. */
  readonly enabled: boolean;
  /** The trader's levels as percents, lowest first; empty when none are set. */
  readonly levels: readonly string[];
  /** `levels_unset`: the toggle says "set your risk levels" and cannot be turned on. */
  readonly state: 'on' | 'off' | 'levels_unset';
  /** The margin call is the liquidation warning: always on, whatever the levels. */
  readonly liquidationAlert: 'always_on';
  readonly updatedAt: string | null;
  /** Crossings of the trader's levels, newest first (at most 50). */
  readonly crossings: readonly RiskAlertCrossingView[];
}

export interface RiskAlertCrossingView {
  readonly positionId: string;
  readonly symbol: string;
  readonly level: string;
  readonly generation: number;
  readonly marginRatio: string;
  readonly crossedAt: string;
  readonly endedAt: string | null;
}

interface LevelsRow {
  user_id: string;
  levels: string[];
  enabled: boolean;
  client_request_id: string;
  updated_at: Date;
}

interface CrossingRow {
  position_id: string;
  level: string;
  generation: number;
  user_id: string;
  market_id: string;
  symbol: string;
  ratio: string;
  crossed_at: Date;
  ended_at: Date | null;
  announced_at: Date | null;
}

export interface RiskAlertDeps {
  readonly sql: Sql;
  readonly bus: Pick<EventBus, 'publish'> | null;
  figures(userId: string, positionId: string): Promise<RiskStopFigures>;
  readonly now?: () => Date;
  readonly warn?: (message: string, fields: Record<string, string>) => void;
}

export interface RiskAlertTickResult {
  readonly checked: number;
  readonly crossed: number;
  readonly ended: number;
  readonly announced: number;
  readonly failed: readonly { positionId: string; message: string }[];
}

function alertLevel(raw: unknown): Amount {
  try {
    return levelFromPercent(raw);
  } catch (err) {
    if (err instanceof FuturesError) throw new FuturesError(err.message.replace('a stop', 'an alert'), RISK_ALERT_INVALID, 400);
    throw err;
  }
}

function requestId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.length > 64) throw new FuturesError('clientRequestId is required (1–64 chars)', 'trade.idempotency_key_required', 400);
  return id;
}

/** The levels a request names: percents as decimal strings, distinct, at most ten; lowest first. */
export function parseAlertLevels(raw: unknown): Amount[] {
  if (!Array.isArray(raw)) throw new FuturesError('levels must be a list of percents, for example ["60", "80"]', RISK_ALERT_INVALID, 400);
  if (raw.length > RISK_ALERT_MAX_LEVELS) {
    throw new FuturesError(`at most ${RISK_ALERT_MAX_LEVELS} levels`, RISK_ALERT_INVALID, 400);
  }
  const levels = raw.map(alertLevel).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] === levels[i - 1]) throw new FuturesError(`level ${percentOf(levels[i]!)}% is listed twice`, RISK_ALERT_INVALID, 400);
  }
  return levels;
}

export function riskLevelIdempotencyKey(positionId: string, level: Amount, generation: number): string {
  return `trade.risk_level.crossed:${positionId}:${formatAmount(level)}:${generation}`;
}

export function createRiskAlertService(deps: RiskAlertDeps) {
  const { sql } = deps;
  const now = deps.now ?? (() => new Date());
  const warn =
    deps.warn ?? ((message: string, fields: Record<string, string>) => console.warn(JSON.stringify({ level: 'warn', msg: message, ...fields })));

  async function levelsRow(userId: string): Promise<LevelsRow | null> {
    const [row] = await sql<LevelsRow[]>`
      SELECT user_id, levels::text[] AS levels, enabled, client_request_id, updated_at
        FROM trade.futures_risk_alert_levels WHERE user_id = ${userId}
    `;
    return row ?? null;
  }

  async function view(userId: string, row: LevelsRow | null): Promise<RiskAlertsView> {
    const levels = (row?.levels ?? []).map((l) => percentOf(parseAmount(l)));
    const crossings = await sql<CrossingRow[]>`
      SELECT position_id, level::text AS level, generation, user_id, market_id, symbol, ratio::text AS ratio,
             crossed_at, ended_at, announced_at
        FROM trade.futures_risk_alert_crossings
       WHERE user_id = ${userId}
       ORDER BY crossed_at DESC, generation DESC
       LIMIT 50
    `;
    return {
      enabled: row?.enabled ?? false,
      levels,
      state: levels.length === 0 ? 'levels_unset' : row?.enabled ? 'on' : 'off',
      liquidationAlert: 'always_on',
      updatedAt: row ? row.updated_at.toISOString() : null,
      crossings: crossings.map((c) => ({
        positionId: c.position_id,
        symbol: c.symbol,
        level: percentOf(parseAmount(c.level)),
        generation: c.generation,
        marginRatio: percentOf(parseAmount(c.ratio)),
        crossedAt: c.crossed_at.toISOString(),
        endedAt: c.ended_at ? c.ended_at.toISOString() : null,
      })),
    };
  }

  return {
    async get(userId: string): Promise<RiskAlertsView> {
      return view(userId, await levelsRow(userId));
    },

    /**
     * Sets the trader's levels and the toggle. `enabled: true` with no levels refuses with
     * `trade.risk_alert_levels_unset`; nothing is written. The same clientRequestId again answers what it wrote.
     */
    async set(userId: string, input: { enabled: unknown; levels: unknown; clientRequestId: unknown }): Promise<RiskAlertsView> {
      const clientRequestId = requestId(input.clientRequestId);
      const existing = await levelsRow(userId);
      if (existing && existing.client_request_id === clientRequestId) return view(userId, existing);
      if (typeof input.enabled !== 'boolean') throw new FuturesError('enabled must be true or false', RISK_ALERT_INVALID, 400);
      const levels = parseAlertLevels(input.levels ?? []);
      if (input.enabled && levels.length === 0) {
        throw new FuturesError(
          'set your risk levels first: liquidation-risk alerts need at least one margin-ratio level. The liquidation alert stays on.',
          RISK_ALERT_LEVELS_UNSET,
          409,
        );
      }
      const stored = levels.map((l) => formatAmount(l));
      const [row] = await sql<LevelsRow[]>`
        INSERT INTO trade.futures_risk_alert_levels (user_id, levels, enabled, client_request_id, updated_at)
        VALUES (${userId}, ${stored}::numeric[], ${input.enabled}, ${clientRequestId}, now())
        ON CONFLICT (user_id) DO UPDATE
          SET levels = EXCLUDED.levels, enabled = EXCLUDED.enabled,
              client_request_id = EXCLUDED.client_request_id, updated_at = now()
        RETURNING user_id, levels::text[] AS levels, enabled, client_request_id, updated_at
      `;
      return view(userId, row ?? null);
    },

    /** One pass: open and end crossings from each watched position's ratio now, then publish the unannounced ones. */
    async evaluate(): Promise<RiskAlertTickResult> {
      const at = now();
      const failed: { positionId: string; message: string }[] = [];
      let crossed = 0;

      // A crossing whose position closed, whose level went or whose toggle is off has ended.
      const endedRows = await sql`
        UPDATE trade.futures_risk_alert_crossings c
           SET ended_at = ${at.toISOString()}::timestamptz
         WHERE c.ended_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM trade.positions p
               JOIN trade.futures_risk_alert_levels l ON l.user_id = p.user_id::text
              WHERE p.id = c.position_id AND p.status = 'open' AND l.enabled AND c.level = ANY (l.levels)
           )
        RETURNING c.position_id
      `;
      let ended = endedRows.length;

      const watched = await sql<{ position_id: string; user_id: string; market_id: string; symbol: string; levels: string[] }[]>`
        SELECT p.id AS position_id, p.user_id::text AS user_id, p.market_id, m.symbol, l.levels::text[] AS levels
          FROM trade.positions p
          JOIN trade.markets m ON m.id = p.market_id
          JOIN trade.futures_risk_alert_levels l ON l.user_id = p.user_id::text
         WHERE p.status = 'open' AND l.enabled AND cardinality(l.levels) > 0
         ORDER BY p.id
      `;
      for (const pos of watched) {
        try {
          const figures = await deps.figures(pos.user_id, pos.position_id);
          // A ratio the service cannot work out is not guessed: nothing opens or ends on it.
          if (figures.marginRatio === null && figures.ratioReason !== 'equity_not_positive') continue;
          for (const raw of pos.levels) {
            const level = parseAmount(raw);
            if (riskStopReached(figures, level)) {
              // Equity gone reads as past every level; the ratio recorded is then 100%.
              const ratio = figures.marginRatio ?? 10n ** 18n;
              const opened = await sql`
                INSERT INTO trade.futures_risk_alert_crossings
                  (position_id, level, generation, user_id, market_id, symbol, ratio, crossed_at)
                SELECT ${pos.position_id}::uuid, ${raw}::numeric,
                       COALESCE((SELECT MAX(generation) FROM trade.futures_risk_alert_crossings
                                  WHERE position_id = ${pos.position_id}::uuid AND level = ${raw}::numeric), 0) + 1,
                       ${pos.user_id}, ${pos.market_id}, ${pos.symbol}, ${formatAmount(ratio)}::numeric,
                       ${at.toISOString()}::timestamptz
                ON CONFLICT (position_id, level) WHERE ended_at IS NULL DO NOTHING
                RETURNING generation
              `;
              crossed += opened.length;
            } else {
              const closed = await sql`
                UPDATE trade.futures_risk_alert_crossings
                   SET ended_at = ${at.toISOString()}::timestamptz
                 WHERE position_id = ${pos.position_id}::uuid AND level = ${raw}::numeric AND ended_at IS NULL
                RETURNING generation
              `;
              ended += closed.length;
            }
          }
        } catch (err) {
          failed.push({ positionId: pos.position_id, message: err instanceof Error ? err.message : String(err) });
        }
      }

      // Publish after the rows: each unannounced crossing once, keyed, so a resend is the same alert.
      let announced = 0;
      if (deps.bus) {
        const pending = await sql<CrossingRow[]>`
          SELECT position_id, level::text AS level, generation, user_id, market_id, symbol, ratio::text AS ratio,
                 crossed_at, ended_at, announced_at
            FROM trade.futures_risk_alert_crossings
           WHERE announced_at IS NULL
           ORDER BY crossed_at
           LIMIT 200
        `;
        for (const c of pending) {
          const level = parseAmount(c.level);
          try {
            await deps.bus.publish(
              'tradeRiskLevelCrossed',
              {
                positionId: c.position_id,
                userId: c.user_id,
                marketId: c.market_id,
                symbol: c.symbol,
                level: percentOf(level),
                marginRatio: percentOf(parseAmount(c.ratio)),
                generation: c.generation,
                crossedAt: c.crossed_at.toISOString(),
              },
              { idempotencyKey: riskLevelIdempotencyKey(c.position_id, level, c.generation) },
            );
            await sql`
              UPDATE trade.futures_risk_alert_crossings SET announced_at = ${at.toISOString()}::timestamptz
               WHERE position_id = ${c.position_id}::uuid AND level = ${c.level}::numeric AND generation = ${c.generation}
            `;
            announced += 1;
          } catch (err) {
            warn('trade.risk_level.notice_unsent', { positionId: c.position_id, generation: String(c.generation), error: String(err) });
          }
        }
      }
      return { checked: watched.length, crossed, ended, announced, failed };
    },
  };
}

export type RiskAlertService = ReturnType<typeof createRiskAlertService>;
