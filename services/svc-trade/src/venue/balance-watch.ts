import { add, formatAmount, isNegative, isZero, mul, neg, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { Payload } from '@intafaced/events';
import {
  VenueRefusalError,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueArrival,
  type UserVenueBalance,
  type UserVenueFill,
  type UserVenueMarket,
} from '@intafaced/venue-contracts';
import type { BalanceWatchCursor, BalanceWatchStore } from './balance-watch-store.js';
import type { AccountPace } from './account-pace.js';
import type { OwnerSignedAccount } from './prepared-action-store.js';

/**
 * THE VENUE BALANCE WATCH (J-cex-spot-15 #9): one `venueBalanceChanged` event per change in the balance of a person's own
 * venue account, with its source and the venue's new total, for `/private/stream?channel=balances` (svc-ws).
 *
 * Money (J-cex-spot-15 "Money"): INTAFACED holds none of it and the ledger posts nothing. The venue holds the balance and
 * is its record; this only reads it. The accounts read are the ones the person's own wallet signed for through our door
 * (`ownerSignedAccountsAll`), so a stream never carries an account the person has not shown is theirs.
 *
 * Each reading compares the venue's totals with the ones last reported, and names each change by the venue's own record
 * behind it: a credit from outside (`arrivals`: a deposit or a transfer in) or a spot fill (`fills`: the base and quote
 * it moved and its fee). A change the venue reports no such record for, or whose records do not add up to it (a
 * withdrawal, a perpetual's margin, funding), is published once as `other`, with the venue's total. Each event's id is a
 * business key: the venue's id for the record, the account and the asset, or the account's own count of unreported
 * changes, so a reading published twice publishes the same ids and the stream ignores the repeat.
 *
 * Crash points (whose funds are stranded? none: nothing moves): the events are published before the cursor is written;
 * a watch that stops between the two publishes the same changes again under the same ids on its next reading.
 */

/** How far back each reading reads fills again, so a fill the venue reports a little late is still named. */
const BALANCE_WATCH_FILL_OVERLAP_MS = 10 * 60_000;

export type VenueBalanceChange = Omit<Payload<'venueBalanceChanged'>, 'userId'>;

interface VenueRecord {
  readonly id: string;
  readonly source: 'deposit' | 'transfer_in' | 'trade';
  readonly sourceId: string;
  readonly at: Date;
  readonly deltas: ReadonlyMap<string, Amount>;
}

const accountTag = (a: UserVenueAccount) => `${a.venueId}:${a.owner.toLowerCase()}:${a.subAccount ?? '-'}`;

function arrivalRecord(arrival: UserVenueArrival): VenueRecord {
  return {
    id: `arrival:${arrival.arrivalId}`,
    source: arrival.kind,
    sourceId: arrival.arrivalId,
    at: arrival.arrivedAt,
    deltas: new Map([[arrival.asset, arrival.amount]]),
  };
}

/** What a spot fill moved, by asset: the base and quote it traded and the fee the venue charged. Null for any other fill. */
function fillRecord(fill: UserVenueFill, market: UserVenueMarket | undefined): VenueRecord | null {
  if (!market || market.kind !== 'spot') return null;
  const deltas = new Map<string, Amount>();
  const move = (asset: string, by: Amount) => deltas.set(asset, add(deltas.get(asset) ?? ZERO, by));
  // The venue rounds a fill's quote amount up (the TEST venue's QUOTE_ROUND); a difference of rounding lands in `other`.
  const notional = mul(fill.price, fill.amount, 'ceil');
  move(market.baseAsset, fill.side === 'buy' ? fill.amount : neg(fill.amount));
  move(market.quoteAsset, fill.side === 'buy' ? neg(notional) : notional);
  move(fill.feeAsset, neg(add(fill.venueFee, fill.builderFee)));
  return { id: `fill:${fill.fillId}`, source: 'trade', sourceId: fill.fillId, at: fill.filledAt, deltas };
}

export interface BalanceReading {
  readonly balances: readonly UserVenueBalance[];
  /** Null when the venue does not read its credits from outside. */
  readonly arrivals: readonly UserVenueArrival[] | null;
  readonly fills: readonly UserVenueFill[];
  readonly markets: readonly UserVenueMarket[];
}

export interface BalanceStep {
  readonly changes: readonly VenueBalanceChange[];
  readonly next: { totals: Map<string, Amount>; unreported: Map<string, number>; fillsSince: Date };
  readonly newlySeen: readonly string[];
}

/**
 * One reading of one account against its cursor. Pure. The first reading (no cursor) publishes nothing: it is where the
 * watch starts, and every record the venue already holds counts as seen.
 */
function balanceStep(input: {
  account: UserVenueAccount;
  cursor: BalanceWatchCursor | null;
  reading: BalanceReading;
  now: Date;
}): BalanceStep {
  const { account, cursor, reading, now } = input;
  const current = new Map(reading.balances.map((b) => [b.asset, b.total]));
  const fillsSince = new Date(now.getTime() - BALANCE_WATCH_FILL_OVERLAP_MS);
  const markets = new Map(reading.markets.map((m) => [m.symbol, m]));
  const recordIds = [...(reading.arrivals ?? []).map((a) => `arrival:${a.arrivalId}`), ...reading.fills.map((f) => `fill:${f.fillId}`)];
  if (cursor === null) {
    return { changes: [], next: { totals: current, unreported: new Map(), fillsSince }, newlySeen: recordIds };
  }

  const fresh: VenueRecord[] = [];
  for (const arrival of reading.arrivals ?? []) if (!cursor.seen.has(`arrival:${arrival.arrivalId}`)) fresh.push(arrivalRecord(arrival));
  for (const fill of reading.fills) {
    if (cursor.seen.has(`fill:${fill.fillId}`)) continue;
    const record = fillRecord(fill, markets.get(fill.symbol));
    if (record) fresh.push(record);
  }
  fresh.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));

  const tag = accountTag(account);
  const changes: VenueBalanceChange[] = [];
  const totals = new Map<string, Amount>();
  const unreported = new Map(cursor.unreported);
  const assets = [...new Set([...cursor.totals.keys(), ...current.keys()])].sort();
  for (const asset of assets) {
    const before = cursor.totals.get(asset) ?? ZERO;
    const after = current.get(asset) ?? ZERO;
    totals.set(asset, after);
    const named = fresh.flatMap((r) => {
      const delta = r.deltas.get(asset) ?? ZERO;
      return isZero(delta) ? [] : [{ record: r, delta }];
    });
    const explained = named.reduce((total, n) => add(total, n.delta), ZERO);
    const residual = sub(sub(after, before), explained);
    const nextUnreported = (cursor.unreported.get(asset) ?? 0) + 1;
    const other = (change: Amount): VenueBalanceChange => ({
      changeId: `other:${tag}:${asset}:${nextUnreported}`,
      venueId: account.venueId,
      owner: account.owner.toLowerCase(),
      subAccount: account.subAccount,
      asset,
      source: 'other',
      sourceId: null,
      change: formatAmount(change),
      total: formatAmount(after),
      ts: now.toISOString(),
    });
    // An unreported debit (a withdrawal) is placed first and an unreported credit last, so each total in between is one
    // the account could hold. Where even so a total would fall below zero, the records cannot be placed in the venue's
    // order and the whole change is published once, as `other`, with the venue's total.
    const steps: { record: VenueRecord | null; delta: Amount }[] = [...named];
    if (!isZero(residual)) {
      if (isNegative(residual)) steps.unshift({ record: null, delta: residual });
      else steps.push({ record: null, delta: residual });
    }
    let running = before;
    const out: VenueBalanceChange[] = [];
    let placeable = true;
    for (const step of steps) {
      running = add(running, step.delta);
      if (isNegative(running)) placeable = false;
      if (step.record === null) {
        out.push({ ...other(step.delta), total: formatAmount(running) });
        continue;
      }
      const r = step.record;
      out.push({
        changeId: `${r.source}:${tag}:${r.sourceId}:${asset}`,
        venueId: account.venueId,
        owner: account.owner.toLowerCase(),
        subAccount: account.subAccount,
        asset,
        source: r.source,
        sourceId: r.sourceId,
        change: formatAmount(step.delta),
        total: formatAmount(running),
        ts: r.at.toISOString(),
      });
    }
    if (!placeable) {
      changes.push(other(sub(after, before)));
      unreported.set(asset, nextUnreported);
      continue;
    }
    changes.push(...out);
    if (!isZero(residual)) unreported.set(asset, nextUnreported);
  }
  // Records seen in this reading are seen whether or not they moved a total (a perpetual's fill, a zero fee).
  const newlySeen = recordIds.filter((id) => !cursor.seen.has(id));
  return { changes, next: { totals, unreported, fillsSince: maxDate(cursor.fillsSince, fillsSince) }, newlySeen };
}

const maxDate = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/** True when every asset's total in the reading is the one last reported (an asset absent from either counts as zero). */
function sameTotals(before: ReadonlyMap<string, Amount>, balances: readonly UserVenueBalance[]): boolean {
  const now = new Map(balances.map((b) => [b.asset, b.total]));
  for (const asset of new Set([...before.keys(), ...now.keys()]))
    if ((before.get(asset) ?? ZERO) !== (now.get(asset) ?? ZERO)) return false;
  return true;
}

/**
 * The venue's credits from outside, or null when it reads none: a venue that refuses the read `not_offered` (Hyperliquid's
 * test network) reads none, and its changes are named by fills or published as `other`. Without this, every reading of
 * such a venue failed, its cursor was never written, and each tick read the account's fills again.
 */
async function readArrivals(venue: UserVenue, account: UserVenueAccount): Promise<readonly UserVenueArrival[] | null> {
  if (!venue.arrivals) return null;
  try {
    return (await venue.arrivals(account)).value;
  } catch (err) {
    if (err instanceof VenueRefusalError && err.refusal.code === 'not_offered') return null;
    throw err;
  }
}

export interface VenueBalanceWatchDeps {
  readonly venue: () => Promise<UserVenue>;
  /** Every person's accounts on this venue their own wallet signed for. */
  readonly accounts: (venueId: string) => Promise<readonly (OwnerSignedAccount & { readonly userId: string })[]>;
  readonly store: BalanceWatchStore;
  /** Publish one change to one person, under its business key. */
  readonly publish: (userId: string, change: VenueBalanceChange) => Promise<void>;
  readonly now: () => Date;
  /**
   * How many accounts a tick may read, a minute's worth at a time: on a venue that limits the box by weight a
   * minute, the watch's spend stays the same however many accounts there are. Omitted: every account on every tick.
   */
  readonly pace?: AccountPace;
}

export class VenueBalanceWatch {
  constructor(private readonly deps: VenueBalanceWatchDeps) {}

  /** One reading of every watched account. An account whose reading fails is read again on the next tick. */
  async tick(): Promise<{ accounts: number; read: number; published: number; failed: number }> {
    const venue = await this.deps.venue();
    const venueId = venue.venue.id;
    const owners = new Map<string, { account: UserVenueAccount; users: string[] }>();
    for (const a of await this.deps.accounts(venueId)) {
      const account: UserVenueAccount = { venueId, owner: a.owner.toLowerCase(), subAccount: a.subAccount };
      const k = accountTag(account);
      const entry = owners.get(k) ?? { account, users: [] };
      if (!entry.users.includes(a.userId)) entry.users.push(a.userId);
      owners.set(k, entry);
    }
    const due = this.deps.pace ? this.deps.pace.take([...owners.values()], (e) => accountTag(e.account)).due : [...owners.values()];
    if (due.length === 0) return { accounts: owners.size, read: 0, published: 0, failed: 0 };
    const markets = (await venue.markets(null)).value;
    let published = 0;
    let failed = 0;
    for (const { account, users } of due) {
      try {
        published += await this.readOne({ venue, account, users, markets });
      } catch (err) {
        failed++;
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.venue_balance_watch.read_failed', account: accountTag(account), message: String(err) })}\n`,
        );
      }
    }
    return { accounts: owners.size, read: due.length, published, failed };
  }

  private async readOne(input: {
    venue: UserVenue;
    account: UserVenueAccount;
    users: readonly string[];
    markets: readonly UserVenueMarket[];
  }) {
    const { venue, account, users, markets } = input;
    const now = this.deps.now();
    const cursor = await this.deps.store.read(account);
    const since = cursor ? cursor.fillsSince : new Date(now.getTime() - BALANCE_WATCH_FILL_OVERLAP_MS);
    const balances = (await venue.balances(account)).value;
    // Totals that did not move have no record to name: the records (a fill read weighs ten balance reads on Hyperliquid)
    // are read only for the first reading and a reading whose totals moved. A record seen later is still named by its id.
    if (cursor && sameTotals(cursor.totals, balances)) return 0;
    const [arrivals, fills] = await Promise.all([readArrivals(venue, account), venue.fills(account, since)]);
    const step = balanceStep({ account, cursor, reading: { balances, arrivals, fills: fills.value, markets }, now });
    for (const change of step.changes) for (const userId of users) await this.deps.publish(userId, change);
    await this.deps.store.write(account, step.next, step.newlySeen);
    return step.changes.length * users.length;
  }
}
