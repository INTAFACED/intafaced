export { MetricsError, metricsToTrpcError, merchantNotFound, type MetricsErrorCode } from './errors.js';
export { createMerchantMetricsAuthority, METRICS_AREAS, type MerchantMetricsAuthority } from './authority.js';
export {
  MetricsProjector,
  startMetricsRefresher,
  diffProjections,
  type RefreshResult,
  type RebuildResult,
  type ReconcileDiff,
  type ReconcileReport,
} from './projector.js';
export { MetricsReader, type BalanceReader, type MetricsReaderDeps, type RailHealthRow } from './reader.js';
export { createMetricsRuntime, railHealthRows, type MetricsRuntime, type MetricsRuntimeDeps } from './runtime.js';
export { computeFromSource, readProjection, listSourceKeys, listProjectionKeys, type DayProjection, type MetricsKey } from './compute.js';
export { resolveWindow, resolveRange, MAX_WINDOW_DAYS, type DayRange } from './window.js';
