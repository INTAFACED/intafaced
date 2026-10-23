import postgres from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TAX_DATABASE_POOL_MAX_UNSET, TAX_DATABASE_URL_UNSET, TaxError } from './codes.js';
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

/** The customer's own price per coin for a lot with no cost of ours: the latest version still in force. */
export interface LotBasisEntry {
  readonly lotId: string;
  readonly pricePerUnit: Amount;
  readonly note: string;
  readonly version: number;
}

export interface CostBasisChoices {
  readonly accountMethod: EngineMethod | null;
  readonly assetMethods: ReadonlyMap<string, EngineMethod>;
  readonly days: readonly DayChoice[];
  readonly picks: readonly LotPick[];
  readonly basis: readonly LotBasisEntry[];
}

export const NO_CHOICES: CostBasisChoices = { accountMethod: null, assetMethods: new Map(), days: [], picks: [], basis: [] };

export type MethodSource = 'preview' | 'day' | 'asset' | 'account' | 'default';

export interface ChoiceStore {
  /** `saved`: the store is connected. `unwired`: nothing can be saved, and reads see no choices. */
  readonly status: 'saved' | 'unwired';
  /** Why nothing can be saved, when unwired. */
  readonly code?: typeof TAX_DATABASE_URL_UNSET | typeof TAX_DATABASE_POOL_MAX_UNSET;
  read(userId: string): Promise<CostBasisChoices>;
  /** `assetId` null: the account's method. `method` null: clear it (the coin follows the account, the account the default). */
  setMethod(userId: string, assetId: string | null, method: EngineMethod | null): Promise<void>;
  setDayMethod(userId: string, day: string, assetId: string | null, method: EngineMethod | null): Promise<void>;
  /** `lotId` null: clear the pick. */
  setPick(userId: string, saleTxId: string, assetId: string, lotId: string | null): Promise<void>;
  /**
   * A new version of the customer's price for a lot; `pricePerUnit` null removes it (a removal is a version too). Rows are
   * only ever added. The same price and note as the version in force adds nothing. Returns the version in force afterwards
   * (0: there has never been one).
   */
  setBasis(userId: string, lotId: string, pricePerUnit: Amount | null, note: string): Promise<number>;
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

/** No usable settings store: reads see no choices, and a save is refused by name rather than dropped. */
function refusingChoices(code: typeof TAX_DATABASE_URL_UNSET | typeof TAX_DATABASE_POOL_MAX_UNSET, why: string): ChoiceStore {
  const refuse = async (): Promise<never> => {
    throw new TaxError(code, `${why}, so a cost-basis choice cannot be saved`);
  };
  return {
    status: 'unwired',
    code,
    read: async () => NO_CHOICES,
    setMethod: refuse,
    setDayMethod: refuse,
    setPick: refuse,
    setBasis: refuse,
  };
}

export const unwiredChoices: ChoiceStore = refusingChoices(TAX_DATABASE_URL_UNSET, 'the cost-basis settings store is not connected');

/** In-memory store for tests. */
export function memoryChoices(): ChoiceStore {
  const methods = new Map<string, EngineMethod>();
  const days = new Map<string, DayChoice & { userId: string }>();
  const picks = new Map<string, LotPick & { userId: string }>();
  const basis: Array<{ userId: string; lotId: string; version: number; pricePerUnit: Amount | null; note: string }> = [];
  const latest = (userId: string, lotId: string) =>
    basis.filter((b) => b.userId === userId && b.lotId === lotId).sort((a, b) => b.version - a.version)[0];
  return {
    status: 'saved',
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
        days: [...days.values()].filter((d) => d.userId === userId).map(({ day, assetId, method }) => ({ day, assetId, method })),
        picks: [...picks.values()].filter((p) => p.userId === userId).map(({ saleTxId, assetId, lotId }) => ({ saleTxId, assetId, lotId })),
        basis: [...new Set(basis.filter((b) => b.userId === userId).map((b) => b.lotId))].flatMap((lotId) => {
          const row = latest(userId, lotId)!;
          return row.pricePerUnit === null ? [] : [{ lotId, pricePerUnit: row.pricePerUnit, note: row.note, version: row.version }];
        }),
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
    async setBasis(userId, lotId, pricePerUnit, note) {
      const row = latest(userId, lotId);
      const same = row ? row.pricePerUnit === pricePerUnit && (pricePerUnit === null || row.note === note) : pricePerUnit === null;
      if (same) return row?.version ?? 0;
      const version = (row?.version ?? 0) + 1;
      basis.push({ userId, lotId, version, pricePerUnit, note: pricePerUnit === null ? '' : note });
      return version;
    },
  };
}

type Sql = ReturnType<typeof postgres>;

/** Postgres store over schema `tax` (drizzle/0000_tax_cost_basis.sql). Every query is keyed by the caller's id. */
export function postgresChoices(sql: Sql): ChoiceStore {
  return {
    status: 'saved',
    async read(userId) {
      const [methods, days, picks, basis] = await Promise.all([
        sql<Array<{ asset_id: string; method: EngineMethod }>>`
          SELECT asset_id, method FROM tax.method_choices WHERE user_id = ${userId}`,
        sql<Array<{ day: string; asset_id: string; method: EngineMethod }>>`
          SELECT to_char(day, 'YYYY-MM-DD') AS day, asset_id, method FROM tax.method_days WHERE user_id = ${userId} ORDER BY day`,
        sql<Array<{ sale_tx_id: string; asset_id: string; lot_id: string }>>`
          SELECT sale_tx_id, asset_id, lot_id FROM tax.lot_picks WHERE user_id = ${userId}`,
        sql<Array<{ lot_id: string; version: number; price_per_unit: string | null; note: string }>>`
          SELECT DISTINCT ON (lot_id) lot_id, version, price_per_unit::text AS price_per_unit, note
          FROM tax.lot_basis WHERE user_id = ${userId} ORDER BY lot_id, version DESC`,
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
        basis: basis.flatMap((row) =>
          row.price_per_unit === null
            ? []
            : [{ lotId: row.lot_id, pricePerUnit: parseAmount(row.price_per_unit), note: row.note, version: row.version }],
        ),
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
    async setBasis(userId, lotId, pricePerUnit, note) {
      const price = pricePerUnit === null ? null : formatAmount(pricePerUnit);
      const kept = price === null ? '' : note;
      // One statement: the next version, unless the version in force already says the same (or there is nothing to remove).
      // The key (user, lot, version) is the business key `basisoverride:<user>:<lot>:<version>`; two identical writes at once
      // meet on it and only one row is added.
      await sql`
        WITH latest AS (
          SELECT version, price_per_unit, note FROM tax.lot_basis
          WHERE user_id = ${userId} AND lot_id = ${lotId} ORDER BY version DESC LIMIT 1
        )
        INSERT INTO tax.lot_basis (user_id, lot_id, version, price_per_unit, note)
        SELECT ${userId}, ${lotId}, COALESCE((SELECT version FROM latest), 0) + 1, ${price}::numeric, ${kept}
        WHERE NOT EXISTS (
          SELECT 1 FROM latest WHERE price_per_unit IS NOT DISTINCT FROM ${price}::numeric AND (${price}::numeric IS NULL OR note = ${kept})
        )
        AND (${price}::numeric IS NOT NULL OR EXISTS (SELECT 1 FROM latest))
        ON CONFLICT (user_id, lot_id, version) DO NOTHING`;
      const [row] = await sql<Array<{ version: number }>>`
        SELECT COALESCE(max(version), 0)::int AS version FROM tax.lot_basis WHERE user_id = ${userId} AND lot_id = ${lotId}`;
      return row?.version ?? 0;
    },
  };
}

/**
 * Opens the settings store from the environment. DATABASE_URL unset: unwired (reads use the default, saves refuse by name).
 * DATABASE_POOL_MAX is required with it; blank is not 10.
 */
export function openChoices(env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined }): {
  store: ChoiceStore;
  close: () => Promise<void>;
} {
  const url = env.DATABASE_URL?.trim();
  if (!url) return { store: unwiredChoices, close: async () => undefined };
  const pool = Number(env.DATABASE_POOL_MAX?.trim() || 'NaN');
  if (!Number.isInteger(pool) || pool < 1 || pool > 200) {
    return {
      store: refusingChoices(TAX_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX must be an integer from 1 to 200'),
      close: async () => undefined,
    };
  }
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  return { store: postgresChoices(sql), close: () => sql.end({ timeout: 5 }) };
}
