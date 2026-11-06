/**
 * Market maintenance (SP-developer-status-01, J-cex-spot-14 #5): a published svc-notify maintenance notice that names a
 * market reaches that market's lifecycle read as `upcomingMaintenance`.
 *
 * A notice names a market by its status component, `market-<base>-<quote>` in lower case (BTC/USDC is
 * `market-btc-usdc`). svc-notify serves the windows that name a market and have not ended, signed-out; svc-trade reads
 * them and puts the nearest one on each market. Nothing here is stored twice: the notice board is the one record.
 */
import { z } from 'zod';

/** The tRPC path on svc-notify's root router. */
export const MARKET_MAINTENANCE_PROCEDURE = 'notify.marketMaintenance' as const;

/** `market-<base>-<quote>`: the shape svc-notify accepts as a market component without a status page defining it. */
export const MARKET_COMPONENT_PATTERN = /^market-[a-z0-9]{1,15}-[a-z0-9]{1,15}$/;

/** The status component that names one spot market, or null for a symbol that has no such component. */
export function marketComponentId(symbol: string): string | null {
  const [base, quote, ...rest] = symbol.split('/');
  if (!base || !quote || rest.length > 0) return null;
  const id = `market-${base.toLowerCase()}-${quote.toLowerCase()}`;
  return MARKET_COMPONENT_PATTERN.test(id) ? id : null;
}

export const marketMaintenanceWindowSchema = z.object({
  id: z.string().guid(),
  title: z.string(),
  /** The market components the notice names. */
  markets: z.array(z.string().regex(MARKET_COMPONENT_PATTERN)).min(1),
  /** Null when the notice names no start: it is open now. */
  startsAt: z.string().datetime({ offset: true }).nullable(),
  /** Null when the notice names no end: the page reads "End time not set". */
  endsAt: z.string().datetime({ offset: true }).nullable(),
});
export type MarketMaintenanceWindow = z.infer<typeof marketMaintenanceWindowSchema>;

export const marketMaintenanceReadSchema = z.object({ windows: z.array(marketMaintenanceWindowSchema) });
export type MarketMaintenanceRead = z.infer<typeof marketMaintenanceReadSchema>;

/**
 * What a market's lifecycle read says about maintenance. `none`: the board was read and names no window for it.
 * `unavailable`: the board could not be read, so nothing is claimed either way. Otherwise the nearest window that has
 * not ended, `scheduled` before its start and `in_progress` from it.
 */
export type UpcomingMaintenance =
  | { readonly status: 'none' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'scheduled' | 'in_progress';
      readonly noticeId: string;
      readonly title: string;
      readonly startsAt: string | null;
      readonly endsAt: string | null;
    };

/** The nearest window for one market from the board's read, or `none`. */
export function upcomingMaintenanceFor(
  symbol: string,
  read: MarketMaintenanceRead | null,
  now: Date,
): UpcomingMaintenance {
  if (read === null) return { status: 'unavailable' };
  const component = marketComponentId(symbol);
  if (component === null) return { status: 'none' };
  const at = now.getTime();
  const windows = read.windows
    .filter((w) => w.markets.includes(component))
    .filter((w) => w.endsAt === null || Date.parse(w.endsAt) > at)
    .sort((a, b) => (a.startsAt === null ? 0 : Date.parse(a.startsAt)) - (b.startsAt === null ? 0 : Date.parse(b.startsAt)));
  const next = windows[0];
  if (!next) return { status: 'none' };
  const started = next.startsAt === null || Date.parse(next.startsAt) <= at;
  return {
    status: started ? 'in_progress' : 'scheduled',
    noticeId: next.id,
    title: next.title,
    startsAt: next.startsAt,
    endsAt: next.endsAt,
  };
}
