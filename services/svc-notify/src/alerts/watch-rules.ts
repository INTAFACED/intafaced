/**
 * Watchlist alerts (J-charts-desk-09 #7, C-alerts-scan-03): one price rule on every market of one of the person's watchlists.
 *
 * - Creating one reads the list from identity (`preferences.watchlistsFor`), stores one price alert per market the list holds
 *   and the rule itself, in one transaction, held to the person's price-alert quota: all of it or none.
 * - Each sweep reads every active rule's list again and adds an alert for each market added since, before the sweep evaluates,
 *   so a later addition is watched from the next sweep on. Additions are held to the quota the same way, all or none.
 * - A sweep that cannot read the list (identity gave no answer, the list was deleted) or the market list, or that the quota
 *   refuses, adds nothing and records the reason on the rule, so the page can say it. Nothing is ever taken away by a sweep:
 *   a market taken off the list keeps its alert, managed on its own, and a market the rule once covered (even one whose alert
 *   the person since deleted) is never added again.
 * - Each alert is an ordinary price alert: it triggers, is edited, paused and deleted on its own.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { IdentityWatchlist, IdentityWatchlistsPort } from '@intafaced/contracts';
import { canonicalDecimalString } from './decimal.js';
import { AlertLimitError, quotaLimitError, type AlertService } from './service.js';
import { AlertQuotaReachedError, AlertValidationError, insertPriceAlerts, type MemoryAlertStore } from './store.js';
import { directionOfCondition, type AlertCondition, type AlertDirection, type CreatePriceAlertInput, type PriceAlert } from './types.js';

export type WatchRuleSyncCode =
  | 'identity.watchlists_unavailable'
  | 'alert.watchlist_not_found'
  | 'alert.markets_unavailable'
  | 'alert.quota_reached'
  | 'notify.alert_quota_unset'
  | 'alert.watchlist_sync_failed';

export type WatchRule = {
  readonly id: string;
  readonly userId: string;
  readonly listId: string;
  readonly listName: string;
  readonly condition: AlertCondition;
  readonly direction: AlertDirection;
  readonly targetPrice: string;
  readonly status: 'active' | 'stopped';
  /** Every market the rule has covered, in the order it covered them. */
  readonly markets: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastSyncAt: Date | null;
  readonly lastSyncCode: WatchRuleSyncCode | null;
};

export type NewWatchRule = Pick<WatchRule, 'userId' | 'listId' | 'listName' | 'condition' | 'direction' | 'targetPrice' | 'markets'>;

/** A create refused because the list could not be read or holds nothing an alert can watch. Nothing was stored. */
export class WatchRuleError extends Error {
  constructor(
    readonly code:
      'identity.watchlists_unavailable' | 'alert.watchlist_not_found' | 'alert.markets_unavailable' | 'alert.watchlist_already_followed',
  ) {
    super(code);
    this.name = 'WatchRuleError';
  }
}

export interface WatchRuleStore {
  /** Store the rule and its first alerts together. Refuses with `AlertQuotaReachedError` when they would pass `maxOpen`. */
  create(
    rule: NewWatchRule,
    alerts: readonly CreatePriceAlertInput[],
    maxOpen: number,
    at: Date,
  ): Promise<{ rule: WatchRule; alerts: readonly PriceAlert[] }>;
  /**
   * Add alerts for markets the rule does not cover yet and count them as covered, together. Applies only while the rule is
   * still active and covers exactly `rule.markets` (a sweep racing another adds once); `null` when it did not apply.
   */
  addMarkets(rule: WatchRule, alerts: readonly CreatePriceAlertInput[], maxOpen: number, at: Date): Promise<readonly PriceAlert[] | null>;
  recordSync(id: string, at: Date, code: WatchRuleSyncCode | null): Promise<void>;
  list(userId: string): Promise<readonly WatchRule[]>;
  active(): Promise<readonly WatchRule[]>;
  /** Stop following the list. The alerts it made stay. `null` when the rule is not the person's. */
  stop(userId: string, id: string, at: Date): Promise<WatchRule | null>;
}

/** The listed markets by symbol, or `null` when they cannot be read. */
export type MarketDirectory = () => Promise<ReadonlyMap<string, string> | null>;

export type WatchRuleSweepReport = { readonly rules: number; readonly added: number; readonly refusals: Readonly<Record<string, number>> };

export class WatchRuleService {
  constructor(
    private readonly alerts: AlertService,
    private readonly store: WatchRuleStore,
    private readonly lists: IdentityWatchlistsPort,
    private readonly markets: MarketDirectory,
  ) {}

  list(userId: string): Promise<readonly WatchRule[]> {
    return this.store.list(userId);
  }

  stop(userId: string, id: string, at: Date = new Date()): Promise<WatchRule | null> {
    return this.store.stop(userId, id, at);
  }

  async create(
    input: { readonly userId: string; readonly listId: string; readonly condition: AlertCondition; readonly targetPrice?: string | null },
    now: Date = new Date(),
  ): Promise<{ rule: WatchRule; alerts: readonly PriceAlert[] }> {
    const read = await this.lists.read({ userId: input.userId });
    if (read.state !== 'read') throw new WatchRuleError('identity.watchlists_unavailable');
    const list = read.lists.find((row) => row.id === input.listId);
    if (!list) throw new WatchRuleError('alert.watchlist_not_found');
    const directory = await this.markets();
    if (!directory) throw new WatchRuleError('alert.markets_unavailable');
    const marketIds = marketsOf(list, directory, []);
    if (marketIds.length === 0) throw new AlertValidationError('alert.invalid_market', 'the list holds no market an alert can watch');
    const direction = directionFor(input.condition);
    const { inputs, maxOpen } = await this.alerts.prepareMany(
      { userId: input.userId, marketIds, direction, condition: input.condition, targetPrice: input.targetPrice },
      now,
    );
    const targetPrice = inputs[0]!.targetPrice.trim();
    // The same list with the same rule twice would put two identical alerts on every market, now and on each later addition.
    const followed = (await this.store.list(input.userId)).some(
      (rule) =>
        rule.status === 'active' &&
        rule.listId === list.id &&
        rule.condition === input.condition &&
        canonicalDecimalString(rule.targetPrice) === canonicalDecimalString(targetPrice),
    );
    if (followed) throw new WatchRuleError('alert.watchlist_already_followed');
    try {
      return await this.store.create(
        {
          userId: input.userId,
          listId: list.id,
          listName: list.name,
          condition: input.condition,
          direction,
          targetPrice,
          markets: inputs.map((row) => row.marketId),
        },
        inputs,
        maxOpen,
        now,
      );
    } catch (err) {
      throw quotaLimitError(err);
    }
  }

  /**
   * The sweep's first step: every active rule picks up the markets added to its list since. One identity read per person.
   * A rule that fails for any reason records it and the pass goes on to the next, so one rule never holds back another. The
   * pass takes at least one rule and stops taking more after `budgetMs`, so the evaluation of alerts already held never waits long on identity; the rules
   * left are taken first on the next pass, as they are the longest unchecked.
   */
  async sync(at: Date = new Date(), budgetMs = WATCH_RULE_SYNC_BUDGET_MS): Promise<WatchRuleSweepReport> {
    const started = Date.now();
    const rules = [...(await this.store.active())].sort(
      (a, b) => (a.lastSyncAt?.getTime() ?? 0) - (b.lastSyncAt?.getTime() ?? 0) || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const byUser = new Map<string, Awaited<ReturnType<IdentityWatchlistsPort['read']>>>();
    let directory: ReadonlyMap<string, string> | null | undefined;
    let expired = false;
    let added = 0;
    let checked = 0;
    const refusals: Record<string, number> = {};
    const refuse = async (rule: WatchRule, code: WatchRuleSyncCode) => {
      refusals[code] = (refusals[code] ?? 0) + 1;
      await this.store.recordSync(rule.id, at, code);
    };
    for (const rule of rules) {
      // At least one rule a pass, so every rule is reached in turn however slow identity is.
      if (checked > 0 && Date.now() - started >= budgetMs) break;
      checked += 1;
      try {
        let read = byUser.get(rule.userId);
        if (!read) {
          read = await this.lists.read({ userId: rule.userId });
          byUser.set(rule.userId, read);
        }
        if (read.state !== 'read') {
          await refuse(rule, 'identity.watchlists_unavailable');
          continue;
        }
        const list = read.lists.find((row) => row.id === rule.listId);
        if (!list) {
          await refuse(rule, 'alert.watchlist_not_found');
          continue;
        }
        if (directory === undefined) directory = await this.markets();
        if (!directory) {
          await refuse(rule, 'alert.markets_unavailable');
          continue;
        }
        const fresh = marketsOf(list, directory, rule.markets);
        if (fresh.length === 0) {
          // Checked, with nothing to add: the page's "last checked" is this pass.
          await this.store.recordSync(rule.id, at, null);
          continue;
        }
        try {
          // Alerts past their time are retired once a pass, before the first quota count, not once a rule.
          const { inputs, maxOpen } = await this.alerts.prepareMany(
            { userId: rule.userId, marketIds: fresh, direction: rule.direction, condition: rule.condition, targetPrice: rule.targetPrice },
            at,
            { expire: !expired },
          );
          expired = true;
          const rows = await this.store.addMarkets(rule, inputs, maxOpen, at);
          added += rows?.length ?? 0;
        } catch (err) {
          if (err instanceof AlertQuotaReachedError) await refuse(rule, 'alert.quota_reached');
          else if (err instanceof AlertLimitError && err.code === 'notify.alert_quota_unset')
            await refuse(rule, 'notify.alert_quota_unset');
          else throw err;
        }
      } catch {
        await refuse(rule, 'alert.watchlist_sync_failed').catch(() => undefined);
      }
    }
    return { rules: checked, added, refusals };
  }
}

/** How long one pass may spend following lists before the alert evaluation runs. */
export const WATCH_RULE_SYNC_BUDGET_MS = 15_000;

/** A crossing either way has no side of its own; the stored direction then says nothing and `above` is kept, as a create does. */
function directionFor(condition: AlertCondition): AlertDirection {
  return condition === 'crossing' ? 'above' : directionOfCondition(condition);
}

/** The list's markets an alert can watch, in the list's order, each once, leaving out those already covered. */
export function marketsOf(list: IdentityWatchlist, directory: ReadonlyMap<string, string>, covered: readonly string[]): string[] {
  const seen = new Set(covered);
  const out: string[] = [];
  for (const symbol of list.symbols) {
    const id = directory.get(symbol);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export class MemoryWatchRuleStore implements WatchRuleStore {
  private readonly byId = new Map<string, WatchRule>();
  constructor(private readonly alerts: MemoryAlertStore) {}

  async create(rule: NewWatchRule, inputs: readonly CreatePriceAlertInput[], maxOpen: number, at: Date) {
    const alerts = await this.alerts.createMany(inputs, maxOpen);
    const row: WatchRule = {
      ...rule,
      id: randomUUID(),
      status: 'active',
      createdAt: at,
      updatedAt: at,
      lastSyncAt: at,
      lastSyncCode: null,
    };
    this.byId.set(row.id, row);
    return { rule: row, alerts };
  }

  async addMarkets(rule: WatchRule, inputs: readonly CreatePriceAlertInput[], maxOpen: number, at: Date) {
    const stored = this.byId.get(rule.id);
    if (!stored || stored.status !== 'active' || stored.markets.join('\n') !== rule.markets.join('\n')) return null;
    const alerts = await this.alerts.createMany(inputs, maxOpen);
    this.byId.set(rule.id, {
      ...stored,
      markets: [...stored.markets, ...inputs.map((row) => row.marketId)],
      updatedAt: at,
      lastSyncAt: at,
      lastSyncCode: null,
    });
    return alerts;
  }

  async recordSync(id: string, at: Date, code: WatchRuleSyncCode | null) {
    const stored = this.byId.get(id);
    if (stored) this.byId.set(id, { ...stored, lastSyncAt: at, lastSyncCode: code });
  }

  async list(userId: string) {
    return [...this.byId.values()].filter((row) => row.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async active() {
    return [...this.byId.values()].filter((row) => row.status === 'active').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async stop(userId: string, id: string, at: Date) {
    const stored = this.byId.get(id);
    if (!stored || stored.userId !== userId) return null;
    if (stored.status === 'stopped') return stored;
    const next: WatchRule = { ...stored, status: 'stopped', updatedAt: at };
    this.byId.set(id, next);
    return next;
  }
}

type RuleRow = {
  id: string;
  user_id: string;
  list_id: string;
  list_name: string;
  condition: AlertCondition;
  direction: AlertDirection;
  target_price: string;
  status: 'active' | 'stopped';
  markets: string[];
  created_at: Date;
  updated_at: Date;
  last_sync_at: Date | null;
  last_sync_code: WatchRuleSyncCode | null;
};

const COLUMNS =
  'id, user_id, list_id, list_name, condition, direction, target_price, status, markets, created_at, updated_at, last_sync_at, last_sync_code';

function ruleOf(row: RuleRow): WatchRule {
  return {
    id: row.id,
    userId: row.user_id,
    listId: row.list_id,
    listName: row.list_name,
    condition: row.condition,
    direction: row.direction,
    targetPrice: row.target_price,
    status: row.status,
    markets: Array.isArray(row.markets) ? row.markets.filter((id): id is string => typeof id === 'string') : [],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
    lastSyncCode: row.last_sync_code,
  };
}

/** Postgres-backed rules. Migration `20261107074033_notify_watchlist_alerts.sql`. */
export class PostgresWatchRuleStore implements WatchRuleStore {
  constructor(private readonly sql: Sql) {}

  async create(rule: NewWatchRule, inputs: readonly CreatePriceAlertInput[], maxOpen: number, at: Date) {
    try {
      return await this.createOnce(rule, inputs, maxOpen, at);
    } catch (err) {
      // Two saves of the same follow racing: the second meets the one-follow index, and nothing of it is stored.
      if ((err as { code?: string }).code === '23505') throw new WatchRuleError('alert.watchlist_already_followed');
      throw err;
    }
  }

  private async createOnce(rule: NewWatchRule, inputs: readonly CreatePriceAlertInput[], maxOpen: number, at: Date) {
    return this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const alerts = await insertPriceAlerts(tx, inputs, maxOpen);
      const [row] = await tx<RuleRow[]>`
        INSERT INTO notify.watchlist_alerts (id, user_id, list_id, list_name, condition, direction, target_price, status, markets, created_at, updated_at, last_sync_at)
        VALUES (${randomUUID()}, ${rule.userId}, ${rule.listId}, ${rule.listName}, ${rule.condition}, ${rule.direction}, ${rule.targetPrice}, 'active',
          ${tx.json([...rule.markets] as never)}, ${at}, ${at}, ${at})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return { rule: ruleOf(row!), alerts };
    });
  }

  async addMarkets(rule: WatchRule, inputs: readonly CreatePriceAlertInput[], maxOpen: number, at: Date) {
    return this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      // The rule row first, locked: a second sweep waits here and then sees the markets this one covered.
      const [current] = await tx<RuleRow[]>`SELECT ${tx.unsafe(COLUMNS)} FROM notify.watchlist_alerts WHERE id = ${rule.id} FOR UPDATE`;
      if (!current) return null;
      const stored = ruleOf(current);
      if (stored.status !== 'active' || stored.markets.join('\n') !== rule.markets.join('\n')) return null;
      const alerts = await insertPriceAlerts(tx, inputs, maxOpen);
      const markets = [...stored.markets, ...inputs.map((row) => row.marketId)];
      await tx`
        UPDATE notify.watchlist_alerts
        SET markets = ${tx.json(markets as never)}, updated_at = ${at}, last_sync_at = ${at}, last_sync_code = NULL
        WHERE id = ${rule.id}
      `;
      return alerts;
    });
  }

  async recordSync(id: string, at: Date, code: WatchRuleSyncCode | null) {
    await this.sql`UPDATE notify.watchlist_alerts SET last_sync_at = ${at}, last_sync_code = ${code} WHERE id = ${id}`;
  }

  async list(userId: string) {
    const rows = await this.sql<RuleRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.watchlist_alerts WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 100
    `;
    return rows.map(ruleOf);
  }

  async active() {
    const rows = await this.sql<RuleRow[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.watchlist_alerts WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map(ruleOf);
  }

  async stop(userId: string, id: string, at: Date) {
    const [row] = await this.sql<RuleRow[]>`
      UPDATE notify.watchlist_alerts
      SET status = 'stopped', updated_at = CASE WHEN status = 'active' THEN ${at}::timestamptz ELSE updated_at END
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING ${this.sql.unsafe(COLUMNS)}
    `;
    return row ? ruleOf(row) : null;
  }
}
