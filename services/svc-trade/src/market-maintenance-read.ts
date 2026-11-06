/**
 * svc-notify's market maintenance windows, as the public lifecycle read and the markets list carry them
 * (SP-developer-status-01, J-cex-spot-14 #5). The notice board is the one record: this keeps a few seconds' copy of its
 * signed-out read and nothing else. No notify address, a refusal, a timeout or a reply that does not parse all read as
 * null, which the lifecycle read publishes as `unavailable`, never as "no maintenance".
 */
import { MARKET_MAINTENANCE_PROCEDURE, marketMaintenanceReadSchema, unwrapTrpcData, type MarketMaintenanceRead } from '@intafaced/contracts';

export type MarketMaintenanceBoard = () => Promise<MarketMaintenanceRead | null>;

export function createMarketMaintenanceReader(options: {
  notifyUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
}): MarketMaintenanceBoard {
  let base: string | null = null;
  try {
    const url = new URL(options.notifyUrl ?? '');
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
      base = url.href.replace(/\/$/, '');
    }
  } catch {
    /* No address: every read is unavailable. */
  }
  const ttl = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cached: { at: number; read: MarketMaintenanceRead | null } | null = null;
  let inFlight: Promise<MarketMaintenanceRead | null> | null = null;

  async function fetchRead(): Promise<MarketMaintenanceRead | null> {
    if (base === null) return null;
    try {
      const response = await (options.fetcher ?? fetch)(`${base}/trpc/${MARKET_MAINTENANCE_PROCEDURE}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      });
      if (!response.ok) return null;
      const parsed = marketMaintenanceReadSchema.safeParse(unwrapTrpcData(await response.json()));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return async () => {
    if (cached && now() - cached.at < ttl) return cached.read;
    inFlight ??= fetchRead().then((read) => {
      cached = { at: now(), read };
      inFlight = null;
      return read;
    });
    return inFlight;
  };
}
