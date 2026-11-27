import type { z } from 'zod';
import { compare, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { dailyLossViewSchema } from '@intafaced/contracts/trade-daily-loss-procedures';
import {
  isTestVenue,
  type PlaceUserOrderIntent,
  type UserVenue,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { dailyLossOf, nextUtcDay, startOfUtcDay } from './daily-loss.js';
import type { DailyLossLimitStore, DailyLossRecord, DailyLossTerms } from './daily-loss-limit-store.js';
import { UserVenueDoorError, type UserVenueDoor } from './user-venue-door.js';

/**
 * THE PERSON'S OPT-IN DAILY LOSS LIMIT ON THEIR OWN VENUE ACCOUNT.
 *
 * Nothing moves: no venue action is prepared for it and the ledger posts nothing. The person sets a limit, counted in the
 * venue's perpetuals collateral asset. Today's loss is the account's realised result since 00:00 UTC on the venue's own
 * fills, less every fee (`dailyLossOf`, the same count as an agent account's daily-loss cap); unrealised results are not
 * counted. Once today's loss reaches the limit, each new OPENING order (not reduce-only, and not a spot sell, which can
 * only lessen a holding) is, as the person chose:
 *   - `advisory` (the default): prepared as usual, with a warning on the answer naming the loss and the limit;
 *   - `blocking`: refused `trade.daily_loss_limit_reached`, before anything is prepared or signed.
 * A reduce-only exit is never warned about or refused here, whatever the mode.
 *
 * Changing it: a stricter change (turning it on, a lower limit, advisory to blocking) applies at once and drops any
 * loosening still waiting. A looser change (a higher limit, blocking to advisory, turning it off; a change that is
 * partly looser counts as looser) waits 24 hours from when it was asked, then applies; until then the terms in force
 * stay. Asking again for the terms in force cancels a waiting loosening.
 *
 * Fail closed: with a blocking limit in force and the venue's fills unreadable, an opening order is refused
 * `trade.daily_loss_unreadable`; an advisory one is prepared with a warning that today's loss could not be read.
 */

export const LOOSENING_WAIT_MS = 24 * 60 * 60 * 1000;
const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;

export type DailyLossErrorCode = 'trade.daily_loss_unavailable' | 'trade.daily_loss_request_invalid' | 'trade.daily_loss_field_invalid';

export class DailyLossError extends Error {
  constructor(
    message: string,
    readonly code: DailyLossErrorCode,
  ) {
    super(message);
    this.name = 'DailyLossError';
  }
}

export type DailyLossView = z.input<typeof dailyLossViewSchema>;

/** A warning an advisory limit puts on a prepared order's answer. */
export interface DailyLossWarning {
  readonly code: 'trade.daily_loss_limit_reached' | 'trade.daily_loss_unreadable';
  readonly message: string;
  readonly asset: string;
  readonly limit: string;
  /** Today's loss; null when the venue's fills could not be read. */
  readonly loss: string | null;
  readonly since: string;
}

/** Whether going from `from` to `to` loosens the limit: any part looser makes the whole change wait. */
export function loosens(from: DailyLossTerms | null, to: DailyLossTerms | null): boolean {
  if (from === null) return false;
  if (to === null) return true;
  return compare(to.limit, from.limit) > 0 || (from.mode === 'blocking' && to.mode === 'advisory');
}

/** The record as it stands at `now`: a loosening whose 24 hours are up is the terms in force. */
export function inForce(rec: DailyLossRecord, now: Date): DailyLossRecord {
  if (!rec.pending || rec.pending.effectiveAt.getTime() > now.getTime()) return rec;
  return { ...rec, active: rec.pending.terms, pending: null };
}

/** The record after the person asks for `to` at `now`: stricter or equal applies now, looser waits 24 hours. */
export function changed(rec: DailyLossRecord, to: DailyLossTerms | null, now: Date): DailyLossRecord {
  const current = inForce(rec, now);
  if (loosens(current.active, to)) {
    return { ...current, pending: { terms: to, effectiveAt: new Date(now.getTime() + LOOSENING_WAIT_MS) }, updatedAt: now };
  }
  return { ...current, active: to, pending: null, updatedAt: now };
}

function limitField(raw: string): Amount {
  const v = (raw ?? '').trim();
  if (!DECIMAL_RE.test(v)) throw new DailyLossError('limit must be a number, like 250 or 100.5', 'trade.daily_loss_field_invalid');
  const amount = parseAmount(v);
  if (compare(amount, parseAmount('0')) <= 0) throw new DailyLossError('limit must be above zero', 'trade.daily_loss_field_invalid');
  return amount;
}

const termsOut = (t: DailyLossTerms | null) => (t === null ? null : { mode: t.mode, limit: formatAmount(t.limit) });

export interface DailyLossDeps {
  readonly door: UserVenueDoor;
  readonly store: DailyLossLimitStore;
  readonly now: () => Date;
}

/** The orders an intent opens with: not reduce-only, and not a spot sell. Any other intent opens nothing. */
function ordersOf(intent: VenueIntent): readonly PlaceUserOrderIntent[] {
  if (intent.kind === 'place_order') return [intent];
  if (intent.kind === 'replace_order') return [intent.order];
  if (intent.kind === 'place_orders') return intent.orders;
  return [];
}

export class VenueDailyLossLimits {
  constructor(private readonly deps: DailyLossDeps) {}

  /** The venue's perpetuals collateral: the one asset the limit is counted in. */
  private async assetOf(venue: UserVenue, account: UserVenueAccount): Promise<string> {
    const assets = new Set(
      (await venue.markets(account)).value
        .filter((m) => m.kind === 'perpetual')
        .map((m) => (m.marginAccount?.known ? m.marginAccount.value.collateralAsset : m.quoteAsset)),
    );
    if (assets.size !== 1) {
      throw new DailyLossError(
        `${venue.venue.displayName} does not settle its perpetuals in one asset, so a daily loss limit can't be counted there`,
        'trade.daily_loss_request_invalid',
      );
    }
    const [asset] = [...assets];
    if (asset === undefined) throw new Error('unreachable: one asset was counted');
    return asset;
  }

  private async read(owner: string) {
    let account: UserVenueAccount;
    try {
      account = await this.deps.door.account(owner);
    } catch (error) {
      if (error instanceof UserVenueDoorError && error.status < 500)
        throw new DailyLossError(error.message, 'trade.daily_loss_request_invalid');
      throw error;
    }
    const venue = await this.deps.door.venue();
    return { account, venue };
  }

  async get(principal: Principal, owner: string, opts: { terms?: boolean } = {}): Promise<DailyLossView> {
    const { account, venue } = await this.read(owner);
    const rec = await this.deps.store.get({ userId: principal.userId, venueId: venue.venue.id, owner: account.owner });
    // The desk's read of an account that never set a limit: our record says it is off, and the venue is not asked.
    if (!rec && opts.terms)
      return {
        venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
        owner: account.owner,
        asset: null,
        active: null,
        pending: null,
        today: null,
      };
    const asset = rec?.asset ?? (await this.assetOf(venue, account));
    return this.view({ venue, account, asset, rec: rec ? inForce(rec, this.deps.now()) : null });
  }

  async set(principal: Principal, input: { owner: string; limit: string; mode?: 'advisory' | 'blocking' }): Promise<DailyLossView> {
    const limit = limitField(input.limit);
    return this.change(principal, input.owner, { mode: input.mode ?? 'advisory', limit });
  }

  async off(principal: Principal, owner: string): Promise<DailyLossView> {
    return this.change(principal, owner, null);
  }

  private async change(principal: Principal, owner: string, to: DailyLossTerms | null): Promise<DailyLossView> {
    const { account, venue } = await this.read(owner);
    const key = { userId: principal.userId, venueId: venue.venue.id, owner: account.owner };
    const had = await this.deps.store.get(key);
    const asset = had?.asset ?? (await this.assetOf(venue, account));
    const now = this.deps.now();
    const saved = await this.deps.store.update(key, (current) =>
      changed(current ?? { ...key, asset, active: null, pending: null, createdAt: now, updatedAt: now }, to, now),
    );
    return this.view({ venue, account, asset: saved.asset, rec: inForce(saved, now) });
  }

  private async view({
    venue,
    account,
    asset,
    rec,
  }: {
    venue: UserVenue;
    account: UserVenueAccount;
    asset: string;
    rec: DailyLossRecord | null;
  }): Promise<DailyLossView> {
    const since = startOfUtcDay(this.deps.now());
    let loss: Amount | null = null;
    let asOf: string | null = null;
    try {
      const fills = await venue.fills(account, since);
      loss = dailyLossOf(fills.value, asset);
      asOf = fills.asOf.toISOString();
    } catch {
      loss = null;
    }
    const active = rec?.active ?? null;
    return {
      venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
      owner: account.owner,
      asset,
      active: termsOut(active),
      pending: rec?.pending ? { terms: termsOut(rec.pending.terms), effectiveAt: rec.pending.effectiveAt.toISOString() } : null,
      today: {
        loss: loss === null ? null : formatAmount(loss),
        since: since.toISOString(),
        asOf,
        resetsAt: nextUtcDay(since).toISOString(),
        reached: active !== null && loss !== null && compare(loss, active.limit) >= 0,
      },
    };
  }
}

/**
 * The door's check on the person's opening orders, built from the store alone so the door takes it at start-up
 * (user-venue-door.ts `UserVenueDoorDeps.dailyLoss`).
 */
export class DailyLossGuard {
  constructor(private readonly deps: { readonly store: DailyLossLimitStore; readonly now: () => Date }) {}

  /**
   * The door's check on a fresh order (user-venue-door.ts `prepare`): nothing for an intent that opens nothing or a limit
   * that is off; at or past the limit, a warning (advisory) or the refusal (blocking).
   */
  async admit({
    principal,
    venue,
    account,
    intent,
    kindOf,
  }: {
    readonly principal: Principal;
    readonly venue: UserVenue;
    readonly account: UserVenueAccount;
    readonly intent: VenueIntent;
    /** The market's kind: a spot sell only lessens a holding, so it opens nothing. */
    readonly kindOf: (symbol: string) => Promise<'spot' | 'perpetual'>;
  }): Promise<readonly DailyLossWarning[]> {
    const orders = ordersOf(intent).filter((o) => !o.reduceOnly);
    let opens = false;
    for (const o of orders) if (o.side === 'buy' || (await kindOf(o.symbol)) !== 'spot') opens = true;
    if (!opens) return [];
    const rec = await this.deps.store.get({ userId: principal.userId, venueId: venue.venue.id, owner: account.owner });
    const now = this.deps.now();
    const active = rec ? inForce(rec, now).active : null;
    if (!rec || active === null) return [];
    const since = startOfUtcDay(now);
    const limit = formatAmount(active.limit);
    let loss: Amount;
    try {
      loss = dailyLossOf((await venue.fills(account, since)).value, rec.asset);
    } catch {
      const message = `today's loss on this account could not be read from ${venue.venue.displayName} just now, so your daily loss limit of ${limit} ${rec.asset} can't be checked`;
      if (active.mode === 'blocking') {
        throw new UserVenueDoorError(
          `${message}; this opening order is refused. Closing (reduce-only) orders still go through`,
          'trade.daily_loss_unreadable',
          503,
        );
      }
      return [{ code: 'trade.daily_loss_unreadable', message, asset: rec.asset, limit, loss: null, since: since.toISOString() }];
    }
    if (compare(loss, active.limit) < 0) return [];
    const lost = formatAmount(loss);
    if (active.mode === 'blocking') {
      throw new UserVenueDoorError(
        `this account has lost ${lost} ${rec.asset} today (UTC), reaching your daily loss limit of ${limit} ${rec.asset}, so no new opening order is placed until the day resets at ${nextUtcDay(since).toISOString()} (00:00 UTC); nothing was sent, and reduce-only orders that close a position still go through`,
        'trade.daily_loss_limit_reached',
        422,
      );
    }
    return [
      {
        code: 'trade.daily_loss_limit_reached',
        message: `this account has lost ${lost} ${rec.asset} today (UTC), reaching your daily loss limit of ${limit} ${rec.asset}`,
        asset: rec.asset,
        limit,
        loss: lost,
        since: since.toISOString(),
      },
    ];
  }
}
