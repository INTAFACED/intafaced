import { router, TRPCError } from '@intafaced/contracts/trpc';
import { TRADE_ADMIN_VENUE_ACCOUNTS_GET } from '@intafaced/contracts/trade-admin-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { tradeRefusal } from '../record-refusal.js';
import { TradeOpsError } from './common.js';
import { readVenueAccounts, venueAccountsReadWire, type VenueAccountReadDeps } from './venue-account-read.js';

/** A read refusal keeps its typed code in the message's last bracket, where the console reads it. */
function fail(error: unknown): never {
  if (error instanceof TradeOpsError) {
    const code = error.code === 'trade.user_venue_off' ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: `${error.message} [${error.code}]`, cause: error });
  }
  throw error;
}

/**
 * `admin.venueAccounts.get` (J-derivatives-26 #8, venue-account-read.ts): a founder's read-only view of one person's venue
 * accounts, their margin now and ratio history as the venue reported them; `admin:read`, audited before the venue is asked.
 * With the user-venue door off it refuses `trade.user_venue_off`.
 */
export function venueAccountAdminRouter(deps?: VenueAccountReadDeps | null) {
  return router({
    venueAccounts: router({
      get: mountRecord(
        TRADE_ADMIN_VENUE_ACCOUNTS_GET,
        async ({ ctx, input }) => {
          if (!deps) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'venue accounts are not wired [trade.user_venue_off]' });
          return TRADE_ADMIN_VENUE_ACCOUNTS_GET.output.parse(
            venueAccountsReadWire(await readVenueAccounts(deps, ctx.principal, input).catch(fail)),
          );
        },
        tradeRefusal,
      ),
    }),
  });
}
