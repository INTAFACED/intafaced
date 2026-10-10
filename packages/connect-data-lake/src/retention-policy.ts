/**
 * connect.data-lake retention gate — TSDB + retention owner wiring (D-S-18).
 *
 * Stage-1 capture stays in-process. Persistence and retention are Class X:
 * unset env refuses closed rather than inventing a store or TTL.
 */

export type DataLakeRetentionRefuseReason = 'no_tsdb' | 'no_retention_policy';

export type DataLakeRetentionGate =
  | { readonly ok: true; readonly tsdbUrl: string; readonly retentionDays: number }
  | { readonly ok: false; readonly reason: DataLakeRetentionRefuseReason };

export type DataLakeRetentionSummary = {
  readonly tsdbConfigured: boolean;
  readonly retentionConfigured: boolean;
  readonly canPersist: boolean;
  /** True when owner env is incomplete — capture stays in-process only. */
  readonly captureLogOnly: boolean;
};

/** Honesty board for operator wiring — does not claim a store exists. */
export function describeDataLakeRetention(env: NodeJS.ProcessEnv = process.env): DataLakeRetentionSummary {
  const tsdbUrl = env.CONNECT_DATA_LAKE_TSDB_URL?.trim() ?? '';
  const retentionRaw = env.CONNECT_DATA_LAKE_RETENTION_DAYS?.trim() ?? '';
  const retentionConfigured = parseRetentionDays(retentionRaw) !== null;
  return {
    tsdbConfigured: tsdbUrl.length > 0,
    retentionConfigured,
    canPersist: tsdbUrl.length > 0 && retentionConfigured,
    captureLogOnly: tsdbUrl.length === 0 || !retentionConfigured,
  };
}

function parseRetentionDays(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Gate persistence claims. Both TSDB URL and retention days must be owner-set.
 * Partial wiring is refuse-closed — never half-open retention.
 */
export function retentionPersistenceGate(env: NodeJS.ProcessEnv = process.env): DataLakeRetentionGate {
  const tsdbUrl = env.CONNECT_DATA_LAKE_TSDB_URL?.trim() ?? '';
  if (!tsdbUrl) {
    return { ok: false, reason: 'no_tsdb' };
  }
  const retentionRaw = env.CONNECT_DATA_LAKE_RETENTION_DAYS?.trim() ?? '';
  const retentionDays = parseRetentionDays(retentionRaw);
  if (retentionDays === null) {
    return { ok: false, reason: 'no_retention_policy' };
  }
  return { ok: true, tsdbUrl, retentionDays };
}
