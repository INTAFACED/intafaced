import { OPS_CAPITAL_SOURCE_UNAVAILABLE, opsCapitalVenueSchema, type OpsCapitalVenue, type OpsCapitalVenues } from '@intafaced/contracts';

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
  /** The venue's record now. `signal` aborts when the monitor stops waiting, so a hung call is cancelled, not left pending. */
  builderAccountReport(signal: AbortSignal): Promise<BuilderAccountReport>;
}

const VENUE_TIMEOUT_MS = 5000;
const ERROR_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** The adapter's typed refusal code, when it gives one, so a refusal and an outage read apart. Never the raw message. */
function causeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? ` (${code})` : '';
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
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const report = await Promise.race([
        venue.builderAccountReport(controller.signal),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (report === 'timeout') {
        controller.abort();
        return unknown('did not answer in time, so its builder account is unknown.');
      }
      // Checked against the contract itself: a decimal string (never a number), an asset code, an as-of time with its offset.
      const read = opsCapitalVenueSchema.safeParse({
        ...base,
        balance: { status: 'read', ...report?.balance },
        minimum: report?.minimum?.status === 'published' || report?.minimum?.status === 'not_published' ? report.minimum : { status: '' },
      });
      if (!read.success || read.data.balance.status !== 'read' || read.data.minimum.status === 'unknown') {
        return unknown('answered in a shape this service does not read, so its builder account is unknown.');
      }
      return read.data;
    } catch (error) {
      return unknown(`refused or did not answer the read${causeOf(error)}, so its builder account is unknown.`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return async () => ({ status: 'read', venues: await Promise.all(venues.map(readOne)) });
}
