import { parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { WithdrawalLimit, WithdrawalLimits } from './config.js';
import { listLimits } from './change-store.js';

/**
 * Where the guard finds the owner-set figure for a KYC tier and asset. A missing
 * figure is `undefined`, which the guard refuses; it is never read as zero or
 * unlimited.
 */
export interface LimitSource {
  /** `q` is the connection to read on. The guard passes its own transaction, so it never waits for a second pool connection. */
  get(tier: string, assetId: string, q: Sql): Promise<WithdrawalLimit | undefined>;
  /** Every figure the owner has set, by tier and asset. A tier or asset with no figure is simply absent. */
  list(q: Sql): Promise<PublishedLimit[]>;
}

export interface PublishedLimit extends WithdrawalLimit {
  readonly tier: string;
  readonly assetId: string;
}

/** The figures a founder set through `founderAdmin.limits.change` (table `pay.withdrawal_limits`). */
export function createSqlLimitSource(): LimitSource {
  return {
    async get(tier, assetId, q) {
      const rows = await q<Array<{ per_tx: string | null; rolling_24h: string | null }>>`
        SELECT per_tx, rolling_24h FROM pay.withdrawal_limits WHERE tier = ${tier} AND asset_id = ${assetId}
      `;
      const row = rows[0];
      if (!row || row.per_tx === null || row.rolling_24h === null) return undefined;
      return { perTx: parseAmount(row.per_tx), rolling24h: parseAmount(row.rolling_24h) };
    },
    async list(q) {
      return (await listLimits(q)).flatMap((r) => (r.figures ? [{ tier: r.tier, assetId: r.assetId, ...r.figures }] : []));
    },
  };
}

/** A fixed, already-parsed set of figures. Tests and the retired environment source use this. */
export function staticLimitSource(limits: WithdrawalLimits): LimitSource {
  return {
    get: async (tier, assetId, _q) => limits.byTier.get(tier)?.get(assetId),
    // Sorted by tier, then asset, like the table's own list.
    list: async (_q) =>
      [...limits.byTier]
        .flatMap(([tier, assets]) => [...assets].map(([assetId, limit]) => ({ tier, assetId, ...limit })))
        .sort((a, b) => (a.tier === b.tier ? (a.assetId < b.assetId ? -1 : 1) : a.tier < b.tier ? -1 : 1)),
  };
}
