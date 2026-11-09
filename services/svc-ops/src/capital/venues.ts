import { OPS_CAPITAL_SOURCE_UNAVAILABLE, type OpsCapitalVenue, type OpsCapitalVenues } from '@intafaced/contracts';

/**
 * THE VENUE PORT for the capital monitor: INTAFACED's own builder account at one venue, as that venue reports it.
 *
 * A venue adapter answers with the venue's own record: the builder account's balance (a decimal string) with the venue's
 * as-of time, and the venue's published minimum for collecting builder fees, or that it publishes none. svc-ops keeps no
 * balance of its own for it: the figure is the venue's, shown as read, never summed into the ledger's own funds.
 */
export interface BuilderAccountReport {
  readonly balance: { readonly assetId: string; readonly amount: string; readonly asOf: string };
  readonly minimum:
    { readonly status: 'published'; readonly assetId: string; readonly amount: string } | { readonly status: 'not_published' };
}

export interface BuilderAccountVenue {
  readonly venueId: string;
  /** What the adapter calls the venue in the console. Names no partner (`pnpm scan:brand`). */
  readonly displayName: string;
  /** True for a TEST venue: the console marks every figure from it TEST. */
  readonly test: boolean;
  /** INTAFACED's builder account at the venue. Public, never a key. */
  readonly builderAccount: string;
  builderAccountReport(): Promise<BuilderAccountReport>;
}

const DECIMAL = /^\d+(\.\d{1,18})?$/;
const ASSET = /^[A-Z0-9]{2,16}$/;
const VENUE_TIMEOUT_MS = 5000;

/** A string matching `pattern`. `RegExp.test` alone would pass a number (it coerces), and money is never a number. */
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);

function validReport(r: BuilderAccountReport): boolean {
  const b = r?.balance;
  if (!b || !matches(b.assetId, ASSET) || !matches(b.amount, DECIMAL) || typeof b.asOf !== 'string' || Number.isNaN(Date.parse(b.asOf)))
    return false;
  const m = r.minimum;
  if (m?.status === 'not_published') return true;
  return m?.status === 'published' && matches(m.assetId, ASSET) && matches(m.amount, DECIMAL);
}

/**
 * Reads every venue's builder account at once. A venue that refuses, does not answer within the timeout, or answers in
 * another shape reads "unknown" with `ops.capital.source_unavailable`, its balance and its minimum both: never a zero, and
 * never "not published" for a minimum that could not be read. No venue at all is `undefined`, so the monitor says
 * `ops.capital.venue_not_connected` in words.
 */
export function createVenueReader(
  venues: readonly BuilderAccountVenue[],
  timeoutMs = VENUE_TIMEOUT_MS,
): (() => Promise<OpsCapitalVenues>) | undefined {
  if (venues.length === 0) return undefined;
  const readOne = async (venue: BuilderAccountVenue): Promise<OpsCapitalVenue> => {
    const base = { venueId: venue.venueId, displayName: venue.displayName, test: venue.test, builderAccount: venue.builderAccount };
    const unknown = (message: string): OpsCapitalVenue => {
      const part = { status: 'unknown' as const, code: OPS_CAPITAL_SOURCE_UNAVAILABLE, message: `${venue.displayName}: ${message}` };
      return { ...base, balance: part, minimum: part };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const report = await Promise.race([
        venue.builderAccountReport(),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (report === 'timeout') return unknown('did not answer in time, so its builder account is unknown.');
      if (!validReport(report)) return unknown('answered in a shape this service does not read, so its builder account is unknown.');
      return {
        ...base,
        balance: { status: 'read', assetId: report.balance.assetId, amount: report.balance.amount, asOf: report.balance.asOf },
        minimum:
          report.minimum.status === 'published'
            ? { status: 'published', assetId: report.minimum.assetId, amount: report.minimum.amount }
            : { status: 'not_published' },
      };
    } catch {
      return unknown('refused or did not answer the read, so its builder account is unknown.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return async () => ({ status: 'read', venues: await Promise.all(venues.map(readOne)) });
}
