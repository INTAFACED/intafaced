/**
 * `venue.ownActivity` (packages/contracts trade-venue-activity.ts): a person's own venue spot trading, for svc-tax's
 * profit and loss indicator (J-cex-spot-01 #11). Read-only and service-only (svc-tax).
 *
 * Which accounts: those whose owner wallet signed an action this person prepared through the door
 * (`PreparedActionStore.ownerSignedAccounts`). What: each account's balances and every spot fill, as the venue reports
 * them at the moment of the call, with the venue's as-of time. Nothing is stored and the ledger posts nothing.
 */
import { add, formatAmount, type Amount } from '@intafaced/ledger-client/money';
import { isTestVenue, type UserVenue, type UserVenueMarket } from '@intafaced/venue-contracts';
import type { TradeVenueActivity } from '@intafaced/contracts';
import type { PreparedActionStore } from './prepared-action-store.js';

/** Every fill since the venue's beginning: a lot needs the buy that opened it, however long ago. */
const BEGINNING = new Date(0);

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

export async function readOwnVenueActivity(deps: {
  /** The connected venue; null when the door is off. Throws `VenueRefusalError` when the venue is down. */
  venue: (() => Promise<UserVenue>) | null;
  store: PreparedActionStore;
  userId: string;
}): Promise<TradeVenueActivity> {
  if (!deps.venue) return { state: 'off' };
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const owned = await deps.store.ownerSignedAccounts(deps.userId, venueId);
  const test = isTestVenue(venue.venue);
  if (owned.length === 0) return { state: 'read', test, accounts: [] };
  const markets = await venue.markets(null);
  const spot = new Map<string, UserVenueMarket>();
  for (const m of markets.value) if (m.kind === 'spot') spot.set(m.symbol, m);
  const accounts = [];
  for (const { owner, subAccount } of owned) {
    const account = { venueId, owner, subAccount };
    const [balances, fills] = await Promise.all([venue.balances(account), venue.fills(account, BEGINNING)]);
    const spotFills = [];
    for (const f of [...fills.value].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.fillId.localeCompare(b.fillId))) {
      const market = spot.get(f.symbol);
      // A perpetual fill holds no coin. A spot fill on a market the venue no longer lists is left out, and that coin then
      // does not reconcile in the lot book, which names it there.
      if (!market) continue;
      const fee: Amount = add(f.venueFee, f.builderFee);
      spotFills.push({
        fillId: f.fillId,
        symbol: f.symbol,
        base: market.baseAsset,
        quote: market.quoteAsset,
        side: f.side,
        price: formatAmount(f.price),
        amount: formatAmount(f.amount),
        fee: formatAmount(fee),
        feeAsset: f.feeAsset,
        filledAt: f.filledAt.toISOString(),
      });
    }
    accounts.push({
      venueId,
      owner,
      subAccount,
      balances: balances.value.map((b) => ({ asset: b.asset, total: formatAmount(b.total) })),
      fills: spotFills,
      asOf: later(balances.asOf, fills.asOf).toISOString(),
    });
  }
  return { state: 'read', test, accounts };
}
