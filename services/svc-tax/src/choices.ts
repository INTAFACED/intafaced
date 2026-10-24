import type { Sql } from 'postgres';
import type { EngineDispose, EngineMethod, SaleRule } from './lot-engine.js';

/**
 * COST-BASIS CHOICES. What the customer chose for their own profit and loss indicator: a matching method for the whole
 * account, one for a coin, one for a single day, and which lot a given sale used. These are settings rows in svc-tax's own
 * schema, keyed by the caller. They move no value and post nothing to the ledger; the lot book applies them when it is read.
 *
 * Which method a sale uses, most specific first: a method set for that coin on that day, a method set for every coin on that
 * day, the coin's method, the account's method, then the product default. A picked lot is drawn first whatever the method.
 */

export interface DayChoice {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  /** Null: every coin on that day. */
  readonly assetId: string | null;
  readonly method: EngineMethod;
}

export interface LotPick {
  readonly saleTxId: string;
  readonly assetId: string;
  readonly lotId: string;
}

export interface CostBasisChoices {
  readonly accountMethod: EngineMethod | null;
  readonly assetMethods: ReadonlyMap<string, EngineMethod>;
  readonly days: readonly DayChoice[];
  readonly picks: readonly LotPick[];
}

export const NO_CHOICES: CostBasisChoices = { accountMethod: null, assetMethods: new Map(), days: [], picks: [] };

export type MethodSource = 'preview' | 'day' | 'asset' | 'account' | 'default';

export interface ChoiceStore {
  read(userId: string): Promise<CostBasisChoices>;
  /** `assetId` null: the account's method. `method` null: clear it (the coin follows the account, the account the default). */
  setMethod(userId: string, assetId: string | null, method: EngineMethod | null): Promise<void>;
  setDayMethod(userId: string, day: string, assetId: string | null, method: EngineMethod | null): Promise<void>;
  /** `lotId` null: clear the pick. */
  setPick(userId: string, saleTxId: string, assetId: string, lotId: string | null): Promise<void>;
}

const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** The rule for each sale under the customer's choices, or under one method for everything when previewing. */
export function saleRules(
  choices: CostBasisChoices,
  fallback: EngineMethod,
  preview: EngineMethod | null,
): (sale: EngineDispose) => SaleRule & { source: MethodSource } {
  if (preview !== null) return () => ({ method: preview, source: 'preview' });
  const days = new Map(choices.days.map((d) => [`${d.day}|${d.assetId ?? '*'}`, d.method]));
  const picks = new Map(choices.picks.map((p) => [`${p.saleTxId}|${p.assetId}`, p.lotId]));
  return (sale) => {
    const day = utcDay(sale.postedAt);
    const lotId = picks.get(`${sale.txId}|${sale.assetId}`) ?? null;
    const coinDay = days.get(`${day}|${sale.assetId}`);
    if (coinDay) return { method: coinDay, lotId, source: 'day' };
    const allDay = days.get(`${day}|*`);
    if (allDay) return { method: allDay, lotId, source: 'day' };
    const coin = choices.assetMethods.get(sale.assetId);
    if (coin) return { method: coin, lotId, source: 'asset' };
    if (choices.accountMethod) return { method: choices.accountMethod, lotId, source: 'account' };
    return { method: fallback, lotId, source: 'default' };
  };
}

/** In-process stand-in for tests. */
export function createMemoryChoiceStore(): ChoiceStore {
  const methods = new Map<string, EngineMethod>();
  const days = new Map<string, DayChoice & { userId: string }>();
  const picks = new Map<string, LotPick & { userId: string }>();
  return {
    async read(userId) {
      const assetMethods = new Map<string, EngineMethod>();
      let accountMethod: EngineMethod | null = null;
      for (const [key, method] of methods) {
        const [owner, asset] = key.split('|') as [string, string];
        if (owner !== userId) continue;
        if (asset === '*') accountMethod = method;
        else assetMethods.set(asset, method);
      }
      return {
        accountMethod,
        assetMethods,
        days: [...days.values()]
          .filter((d) => d.userId === userId)
          .map(({ day, assetId, method }) => ({ day, assetId, method }))
          .sort((a, b) => a.day.localeCompare(b.day)),
        picks: [...picks.values()].filter((p) => p.userId === userId).map(({ saleTxId, assetId, lotId }) => ({ saleTxId, assetId, lotId })),
      };
    },
    async setMethod(userId, assetId, method) {
      const key = `${userId}|${assetId ?? '*'}`;
      if (method === null) methods.delete(key);
      else methods.set(key, method);
    },
    async setDayMethod(userId, day, assetId, method) {
      const key = `${userId}|${day}|${assetId ?? '*'}`;
      if (method === null) days.delete(key);
      else days.set(key, { userId, day, assetId, method });
    },
    async setPick(userId, saleTxId, assetId, lotId) {
      const key = `${userId}|${saleTxId}|${assetId}`;
      if (lotId === null) picks.delete(key);
      else picks.set(key, { userId, saleTxId, assetId, lotId });
    },
  };
}

/** Postgres store over schema `tax` (drizzle/20261024110000_cost_basis_choices.sql). Every query is keyed by the caller's id. */
export function createPgChoiceStore(sql: Sql): ChoiceStore {
  return {
    async read(userId) {
      const [methods, days, picks] = await Promise.all([
        sql<Array<{ asset_id: string; method: EngineMethod }>>`
          SELECT asset_id, method FROM tax.method_choices WHERE user_id = ${userId}`,
        sql<Array<{ day: string; asset_id: string; method: EngineMethod }>>`
          SELECT to_char(day, 'YYYY-MM-DD') AS day, asset_id, method FROM tax.method_days WHERE user_id = ${userId} ORDER BY day`,
        sql<Array<{ sale_tx_id: string; asset_id: string; lot_id: string }>>`
          SELECT sale_tx_id, asset_id, lot_id FROM tax.lot_picks WHERE user_id = ${userId}`,
      ]);
      const assetMethods = new Map<string, EngineMethod>();
      let accountMethod: EngineMethod | null = null;
      for (const row of methods) {
        if (row.asset_id === '*') accountMethod = row.method;
        else assetMethods.set(row.asset_id, row.method);
      }
      return {
        accountMethod,
        assetMethods,
        days: days.map((row) => ({ day: row.day, assetId: row.asset_id === '*' ? null : row.asset_id, method: row.method })),
        picks: picks.map((row) => ({ saleTxId: row.sale_tx_id, assetId: row.asset_id, lotId: row.lot_id })),
      };
    },
    async setMethod(userId, assetId, method) {
      const asset = assetId ?? '*';
      if (method === null) {
        await sql`DELETE FROM tax.method_choices WHERE user_id = ${userId} AND asset_id = ${asset}`;
        return;
      }
      await sql`
        INSERT INTO tax.method_choices (user_id, asset_id, method, updated_at) VALUES (${userId}, ${asset}, ${method}, now())
        ON CONFLICT (user_id, asset_id) DO UPDATE SET method = EXCLUDED.method, updated_at = now()`;
    },
    async setDayMethod(userId, day, assetId, method) {
      const asset = assetId ?? '*';
      if (method === null) {
        await sql`DELETE FROM tax.method_days WHERE user_id = ${userId} AND day = ${day}::date AND asset_id = ${asset}`;
        return;
      }
      await sql`
        INSERT INTO tax.method_days (user_id, day, asset_id, method, updated_at) VALUES (${userId}, ${day}::date, ${asset}, ${method}, now())
        ON CONFLICT (user_id, day, asset_id) DO UPDATE SET method = EXCLUDED.method, updated_at = now()`;
    },
    async setPick(userId, saleTxId, assetId, lotId) {
      if (lotId === null) {
        await sql`DELETE FROM tax.lot_picks WHERE user_id = ${userId} AND sale_tx_id = ${saleTxId} AND asset_id = ${assetId}`;
        return;
      }
      await sql`
        INSERT INTO tax.lot_picks (user_id, sale_tx_id, asset_id, lot_id, updated_at) VALUES (${userId}, ${saleTxId}, ${assetId}, ${lotId}, now())
        ON CONFLICT (user_id, sale_tx_id, asset_id) DO UPDATE SET lot_id = EXCLUDED.lot_id, updated_at = now()`;
    },
  };
}
