/**
 * `venue.ownActivity` (packages/contracts trade-venue-activity.ts): a person's own venue spot trading, for svc-tax's
 * profit and loss indicator (J-cex-spot-01 #11). Read-only and service-only (svc-tax).
 *
 * Which accounts: those whose owner wallet signed an action this person prepared through the door
 * (`PreparedActionStore.ownerSignedAccounts`). What: each account's balances and every spot fill, as the venue reports
 * them at the moment of the call, with the venue's as-of time. Nothing is stored and the ledger posts nothing.
 */
import { add, formatAmount, type Amount } from '@intafaced/ledger-client/money';
import { hasSubAccountReads, isTestVenue, type UserVenue, type UserVenueMarket } from '@intafaced/venue-contracts';
import type { TradeVenueActivity, TradeVenueOwnMove } from '@intafaced/contracts';
import type { PreparedActionStore } from './prepared-action-store.js';
import { OWN_MOVE_PREFIX } from './user-venue-door.js';
import { moveKey as agentMoveKey } from './agent-account.js';

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
  // The moves between each main account and its own sub-accounts (J-portfolio-04 #2): the lots go with the coins. A
  // sub-account a move reached is the person's too (their wallet signed the move), though nothing was signed on it.
  const moves = await ownMoves(venue, deps.store, deps.userId, [...new Set(owned.map((a) => a.owner))]);
  const listed = [...owned];
  for (const [owner, list] of moves) {
    for (const m of list) {
      if (!listed.some((a) => a.owner === owner && a.subAccount === m.subAccount)) listed.push({ owner, subAccount: m.subAccount });
    }
  }
  listed.sort((a, b) => a.owner.localeCompare(b.owner) || (a.subAccount ?? '').localeCompare(b.subAccount ?? ''));
  const accounts = [];
  for (const { owner, subAccount } of listed) {
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
      ...(subAccount === null ? { transfers: moves.get(owner) ?? [] } : {}),
      asOf: later(balances.asOf, fills.asOf).toISOString(),
    });
  }
  return { state: 'read', test, accounts };
}

/**
 * Each owner's moves between the main account and a sub-account: every `sub_account_transfer` this person signed through
 * the door (their own, `own:move:`, and their agent account's, `agent:move:`), as the venue's own record of it by its
 * nonce. A move the venue has no record of moved nothing and is left out. Oldest first.
 */
async function ownMoves(
  venue: UserVenue,
  store: PreparedActionStore,
  userId: string,
  owners: readonly string[],
): Promise<Map<string, TradeVenueOwnMove[]>> {
  const out = new Map<string, TradeVenueOwnMove[]>();
  if (!hasSubAccountReads(venue)) return out;
  const rows = [...(await store.listByPrefix(userId, OWN_MOVE_PREFIX)), ...(await store.listByPrefix(userId, agentMoveKey('')))];
  for (const row of rows) {
    const p = row.prepared;
    const owner = p.account.owner.toLowerCase();
    if (p.intent.kind !== 'sub_account_transfer' || row.signature === null) continue;
    if (p.venueId !== venue.venue.id || p.account.subAccount !== null || !owners.includes(owner)) continue;
    const record = (await venue.transfer({ venueId: p.venueId, owner, subAccount: null }, p.nonce)).value;
    if (record === null || record.status !== 'done') continue;
    const list = out.get(owner) ?? [];
    list.push({
      moveId: record.nonce,
      subAccount: record.subAccount.toLowerCase(),
      direction: record.direction,
      asset: record.asset,
      amount: formatAmount(record.amount),
      settledAt: record.settledAt.toISOString(),
    });
    out.set(owner, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.settledAt.localeCompare(b.settledAt) || a.moveId.localeCompare(b.moveId));
  return out;
}
