/**
 * User-visible WebSocket close / error copy.
 *
 * Reasons on the wire are catalog keys resolved through `@intafaced/i18n`.
 * Mode is `prod` so a missing key cannot throw on the socket path. A key that
 * is not in the catalog yet refuses as the key name — greppable, never blank,
 * never invented English. Catalog rows land in a separate PR; this service
 * must not wait on them.
 */
import { createTranslator, type ParamValue } from '@intafaced/i18n';

const translator = createTranslator('en', undefined, { mode: 'prod', onMissing: () => undefined });

export const WS_COPY = {
  unknownMarket: 'ws.close.unknown_market',
  tradesUnavailable: 'ws.close.trades_unavailable',
  atCapacity: 'ws.close.at_capacity',
  maxConnectionsUnset: 'ws.close.max_connections_unset',
  depthLimitUnset: 'ws.close.depth_limit_unset',
  tradeRecentLimitUnset: 'ws.close.trade_recent_limit_unset',
  dropCopyRecentLimitUnset: 'ws.close.drop_copy_recent_limit_unset',
  maxLagTicksUnset: 'ws.close.max_lag_ticks_unset',
  highWaterBytesUnset: 'ws.close.high_water_bytes_unset',
  privateAtCapacity: 'ws.close.private_at_capacity',
  privateUserLimit: 'ws.close.private_user_limit',
  privateMaxConnectionsPerUserUnset: 'ws.close.private_max_connections_per_user_unset',
  shuttingDown: 'ws.close.shutting_down',
  tokenExpired: 'ws.close.token_expired',
} as const;

export function resolveWsCopy(key: string, params: Readonly<Record<string, ParamValue>> = {}): string {
  return translator.tUnsafe(key, params);
}
