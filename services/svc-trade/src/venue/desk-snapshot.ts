/**
 * `venue.deskSnapshot` (packages/contracts trade-desk-snapshot.ts): the launch desk's read of a person's own venue accounts,
 * for svc-notify's read-only Telegram alerts. Read-only and service-only (svc-notify).
 *
 * Which accounts: those whose owner wallet signed an action this person prepared through the door
 * (`PreparedActionStore.ownerSignedAccounts`). What: each account's perpetual positions, its margin use from the venue's
 * own margin summary, the perpetual fills since the asked time and the week's realised profit, as the venue reports them
 * at the moment of the call, with today's and the week's realised result. The venue refusing a read answers `unreadable`
 * with its name. Nothing is stored and the ledger posts nothing.
 */
import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { isTestVenue, VenueRefusalError, type UserVenue, type UserVenueAccount, type UserVenueFill } from '@intafaced/venue-contracts';
import type { tradeDeskSnapshotSchema, TradeDeskSnapshotInput } from '@intafaced/contracts/trade-desk-snapshot';
import type { z } from 'zod';
import type { PreparedActionStore } from './prepared-action-store.js';

type DeskSnapshot = z.input<typeof tradeDeskSnapshotSchema>;

const HUNDRED = parseAmount('100');
const DAY_MS = 86_400_000;

/** Monday 00:00 UTC of the week holding `at`. */
export function weekStartOf(at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const sinceMonday = (at.getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS);
}

/** 00:00 UTC of the day holding `at`. */
function dayStartOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** `used` over `value` in percent, floored to two places; null with no value above zero to divide by. */
export function marginUseOf(used: Amount, value: Amount): string | null {
  if (compare(value, ZERO) <= 0) return null;
  const pct = formatAmount(div(mul(used, HUNDRED), value, 'floor'));
  const dot = pct.indexOf('.');
  if (dot < 0) return pct;
  const two = pct.slice(dot + 1, dot + 3).replace(/0+$/, '');
  return two ? `${pct.slice(0, dot)}.${two}` : pct.slice(0, dot);
}

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

export async function readDeskSnapshot(deps: {
  /** The connected venue; null when the door is off. Throws `VenueRefusalError` when the venue is down. */
  venue: (() => Promise<UserVenue>) | null;
  store: PreparedActionStore;
  input: TradeDeskSnapshotInput;
  now: () => Date;
}): Promise<DeskSnapshot> {
  if (!deps.venue) return { state: 'off' };
  const venue = await deps.venue();
  try {
    return await readOpen(venue, deps);
  } catch (err) {
    // The venue is known but did not answer: name it, so the person is never shown no positions.
    if (err instanceof VenueRefusalError) return { state: 'unreadable', venue: venue.venue.displayName, test: isTestVenue(venue.venue) };
    throw err;
  }
}

async function readOpen(
  venue: UserVenue,
  deps: { store: PreparedActionStore; input: TradeDeskSnapshotInput; now: () => Date },
): Promise<DeskSnapshot> {
  const venueId = venue.venue.id;
  const weekStart = weekStartOf(deps.now());
  const since = new Date(deps.input.since);
  const from = since.getTime() < weekStart.getTime() ? since : weekStart;
  const owned = await deps.store.ownerSignedAccounts(deps.input.userId, venueId);
  const markets = (await venue.markets(null)).value;
  const spot = new Set(markets.filter((m) => m.kind === 'spot').map((m) => m.symbol));
  const perp = markets.find((m) => m.kind !== 'spot');
  const asset = perp ? (perp.marginAccount?.known ? perp.marginAccount.value.collateralAsset : perp.quoteAsset) : '';

  let asOf = new Date(0);
  const accounts: Extract<DeskSnapshot, { state: 'read' }>['accounts'] = [];
  const perpFills: UserVenueFill[] = [];
  for (const { owner, subAccount } of owned) {
    const account: UserVenueAccount = { venueId, owner, subAccount };
    const [positions, fills, summary] = await Promise.all([
      venue.positions(account),
      venue.fills(account, from),
      venue.accountSummary ? venue.accountSummary(account) : Promise.resolve(null),
    ]);
    asOf = [asOf, positions.asOf, fills.asOf, ...(summary ? [summary.asOf] : [])].reduce(later);
    const marginUsed = positions.value.reduce((t, p) => add(t, p.margin), ZERO);
    const value = summary ? summary.value.equity : null;
    const used = summary ? summary.value.usedMargin : marginUsed;
    accounts.push({
      owner,
      subAccount,
      accountValue: value === null ? null : formatAmount(value),
      marginUsed: formatAmount(used),
      marginUse: value === null ? null : marginUseOf(used, value),
      unrealisedPnl: formatAmount(positions.value.reduce((t, p) => add(t, p.unrealisedPnl), ZERO)),
      positions: positions.value.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: formatAmount(p.size),
        entryPrice: formatAmount(p.entryPrice),
        markPrice: formatAmount(p.markPrice),
        unrealisedPnl: formatAmount(p.unrealisedPnl),
        margin: formatAmount(p.margin),
        liquidationPrice: p.liquidationPrice.known ? formatAmount(p.liquidationPrice.value) : null,
      })),
    });
    for (const f of fills.value) if (!spot.has(f.symbol)) perpFills.push(f);
  }
  perpFills.sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime() || a.fillId.localeCompare(b.fillId));

  const dayStart = dayStartOf(deps.now());
  const span = (start: Date) => {
    let realised = ZERO;
    let fees = ZERO;
    for (const f of perpFills) {
      if (f.filledAt.getTime() < start.getTime()) continue;
      if (f.realisedPnl !== null) realised = add(realised, f.realisedPnl);
      fees = add(fees, add(f.venueFee, f.builderFee));
    }
    return { asset, realisedPnl: formatAmount(realised), fees: formatAmount(fees), profit: formatAmount(sub(realised, fees)) };
  };

  return {
    state: 'read',
    test: isTestVenue(venue.venue),
    asOf: (asOf.getTime() === 0 ? deps.now() : asOf).toISOString(),
    weekStart: weekStart.toISOString(),
    accounts,
    fills: perpFills
      .filter((f) => f.filledAt.getTime() >= since.getTime())
      .map((f) => ({
        fillId: f.fillId,
        symbol: f.symbol,
        side: f.side,
        price: formatAmount(f.price),
        amount: formatAmount(f.amount),
        realisedPnl: f.realisedPnl === null ? null : formatAmount(f.realisedPnl),
        fee: formatAmount(add(f.venueFee, f.builderFee)),
        feeAsset: f.feeAsset,
        filledAt: f.filledAt.toISOString(),
      })),
    week: span(weekStart),
    dayStart: dayStart.toISOString(),
    today: span(dayStart),
  };
}
