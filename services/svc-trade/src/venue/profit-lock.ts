import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { getAddress } from 'viem';
import type { EventBus } from '@intafaced/events';
import { add, compare, div, formatAmount, max, min, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { profitLockViewSchema } from '@intafaced/contracts/trade-profit-lock-procedures';
import { isTestVenue, type MaybeKnown, type UserVenue, type UserVenueAccount } from '@intafaced/venue-contracts';
import type { ProfitLock, ProfitLockOffer, ProfitLockStore } from './profit-lock-store.js';
import type { PreparedActionStore } from './prepared-action-store.js';
import type { UserVenueDoor } from './user-venue-door.js';

/**
 * THE PERSON'S WEEKLY PROFIT LOCK ON THEIR OWN VENUE ACCOUNT (J-wallet-26).
 *
 * INTAFACED holds, moves and signs nothing here, and the ledger posts nothing. The person sets a weekly target for the
 * account's realised profit, a share of it to lock (percent) and their own cold wallet's address. The week's realised
 * profit is the sum of the realised results the venue reports on its own fills since the week began (00:00 UTC Monday),
 * exactly as it reports them; unrealised results are not counted. Once a week, when it reaches the target, our engine
 * writes one offer for the week (its row is the claim, unique per lock and week) and publishes one "Profit lock ready"
 * message under the offer's business key `profit-lock:<user>:<venue>:<owner>:<week start>`. The offer is a withdrawal of
 * the share to the cold wallet, filled in for the person: never more than the venue's withdrawable figure (its free
 * balance of the asset, less its withdrawal fee, which it charges on top), and saying so when cut. The person signs it
 * with their main wallet through the venue door (an agent key is refused a withdrawal there), under the offer's own
 * withdrawal key, so a retry or a double press is the same withdrawal and it is sent once; or they close it, and nothing
 * moves. A venue read that fails is named ("can't read the venue", with the last time it was read), never counted as no
 * profit, and no offer is made from it.
 *
 * The cold wallet: a 20-byte 0x address; one written in mixed case must carry its EIP-55 checksum, so a typing mistake is
 * refused by name; an INTAFACED address (one svc-trade knows as ours: the venue builder address) is refused, because
 * INTAFACED holds no customer money while custody is off.
 *
 * Crash points: the offer row is written before anything is published; a worker that stops between the two leaves it
 * unpublished, the next pass publishes it again, and the consumer files it under its key, so the person gets one message.
 */

const DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HUNDRED = parseAmount('100');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** The asset the lock counts and withdraws: the venue's perpetuals collateral, USDC. */
export const PROFIT_LOCK_ASSET = 'USDC';
/** USDC's smallest unit: an offer's amount is rounded down to it. */
const ASSET_DECIMALS = 6;

export type ProfitLockErrorCode =
  | 'trade.profit_lock_unavailable'
  | 'trade.profit_lock_request_invalid'
  | 'trade.profit_lock_field_invalid'
  | 'trade.profit_lock_address_ours'
  | 'trade.profit_lock_address_mistyped'
  | 'trade.profit_lock_no_offer';

export class ProfitLockError extends Error {
  constructor(
    message: string,
    readonly code: ProfitLockErrorCode,
    readonly field: string | null = null,
  ) {
    super(message);
    this.name = 'ProfitLockError';
  }
}

export type ProfitLockView = z.input<typeof profitLockViewSchema>;

/** 00:00 UTC on the Monday of `now`'s week. */
export function startOfUtcWeek(now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * 24 * 60 * 60 * 1000);
}

/**
 * The week a lock counts at `now`: its stored week while it lasts; once seven days are up, the next week starts at the
 * later of this week's Monday and the stored week's end (and, on a TEST stack, no earlier than the TEST clock's last move).
 */
export function weekAt(lock: Pick<ProfitLock, 'weekFrom' | 'testAgedAt'>, now: Date): Date {
  if (now.getTime() < lock.weekFrom.getTime() + WEEK_MS) return lock.weekFrom;
  let next = Math.max(startOfUtcWeek(now).getTime(), lock.weekFrom.getTime() + WEEK_MS);
  if (lock.testAgedAt) next = Math.max(next, lock.testAgedAt.getTime());
  return new Date(next);
}

/** The business key of a week's offer: the person, the venue account and the week, never a random id. */
export const profitLockOfferKey = (lock: Pick<ProfitLock, 'userId' | 'venueId' | 'owner'>, weekFrom: Date) =>
  `profit-lock:${lock.userId}:${lock.venueId}:${lock.owner}:${weekFrom.toISOString()}`;

/** The withdrawal key the offer is signed under at the venue door: the account and the week. */
export const profitLockWithdrawalKey = (owner: string, weekFrom: Date) => `profit-lock:${owner}:${weekFrom.getTime()}`;

/** The week's realised profit, as the venue reports it on its fills since `from`. */
export function realisedSince(fills: readonly { readonly realisedPnl: Amount | null; readonly filledAt: Date }[], from: Date): Amount {
  let total = ZERO;
  for (const f of fills) if (f.realisedPnl !== null && f.filledAt.getTime() >= from.getTime()) total = add(total, f.realisedPnl);
  return total;
}

/** `share` percent of `profit`, rounded down to the asset's smallest unit. */
export function shareOf(profit: Amount, share: Amount): Amount {
  const exact = div(mul(profit, share, 'floor'), HUNDRED, 'floor');
  const unit = parseAmount(`0.${'0'.repeat(ASSET_DECIMALS - 1)}1`);
  return exact - (exact % unit);
}

/** The withdrawal as filled in: the offer's amount, never above what the venue lets the account withdraw with its fee. */
export function filledIn(amount: Amount, free: Amount, fee: MaybeKnown<Amount>): { amount: Amount; cut: boolean; withdrawable: Amount } {
  const withdrawable = max(fee.known ? sub(free, fee.value) : free, ZERO);
  return compare(amount, withdrawable) > 0
    ? { amount: min(amount, withdrawable), cut: true, withdrawable }
    : { amount, cut: false, withdrawable };
}

/** Where offers are handed over; throws when the bus did not take one (it stays unpublished). */
export interface ProfitLockNotices {
  publish(offer: ProfitLockOffer): Promise<void>;
}

export function busProfitLockNotices(bus: Pick<EventBus, 'publish'>): ProfitLockNotices {
  return {
    async publish(o) {
      await bus.publish(
        'venueProfitLockReady',
        {
          offerKey: o.offerKey,
          userId: o.userId,
          asset: o.asset,
          profit: formatAmount(o.profit),
          target: formatAmount(o.target),
          share: formatAmount(o.share),
          amount: formatAmount(o.amount),
          coldWallet: o.coldWallet,
          weekFrom: o.weekFrom.toISOString(),
          raisedAt: o.createdAt.toISOString(),
        },
        { idempotencyKey: o.offerKey },
      );
    },
  };
}

export interface ProfitLockDeps {
  readonly door: Pick<UserVenueDoor, 'venue' | 'account'>;
  readonly store: ProfitLockStore;
  /** The door's own record of signed actions: a week's withdrawal, found by its key, is signed. */
  readonly actions: Pick<PreparedActionStore, 'find'>;
  readonly notices: ProfitLockNotices;
  /** Addresses svc-trade knows as INTAFACED's own (lowercase): never a cold wallet. */
  readonly ourAddresses: readonly string[];
  readonly now: () => Date;
}

export interface ProfitLockSetInput {
  readonly owner: string;
  readonly target: string;
  readonly share: string;
  readonly coldWallet: string;
}

function decimalField(raw: string, field: string): Amount {
  const v = raw.trim();
  if (!DECIMAL_RE.test(v))
    throw new ProfitLockError(`${field} must be a number, like 200 or 62.5`, 'trade.profit_lock_field_invalid', field);
  const amount = parseAmount(v);
  if (compare(amount, ZERO) <= 0) throw new ProfitLockError(`${field} must be above zero`, 'trade.profit_lock_field_invalid', field);
  return amount;
}

/** The cold wallet as stored (lowercase), or a refusal naming why. */
export function coldWalletOf(raw: string, owner: string, ours: readonly string[]): string {
  const v = raw.trim();
  if (!ADDRESS_RE.test(v)) {
    throw new ProfitLockError(
      'Cold wallet must be a wallet address: 0x and 40 letters or digits',
      'trade.profit_lock_field_invalid',
      'Cold wallet',
    );
  }
  const lower = v.toLowerCase();
  const mixed = v.slice(2) !== lower.slice(2) && v.slice(2) !== v.slice(2).toUpperCase();
  if (mixed && getAddress(lower) !== v) {
    throw new ProfitLockError(
      'This address looks mistyped: its capital letters do not match its checksum. Copy it again from your cold wallet',
      'trade.profit_lock_address_mistyped',
      'Cold wallet',
    );
  }
  if (ours.includes(lower)) {
    throw new ProfitLockError(
      'This is an INTAFACED address, not your own wallet. INTAFACED holds none of your money, so the share goes only to a wallet you hold',
      'trade.profit_lock_address_ours',
      'Cold wallet',
    );
  }
  if (lower === owner) {
    throw new ProfitLockError(
      'This is the wallet this venue account belongs to. Give the address of your cold wallet, another wallet of your own',
      'trade.profit_lock_field_invalid',
      'Cold wallet',
    );
  }
  return lower;
}

const log = (msg: string, fields: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ level: 'warn', msg, ...fields })}\n`);

const known = (m: MaybeKnown<Amount>) => (m.known ? { known: true as const, value: formatAmount(m.value) } : { known: false as const });

export class VenueProfitLocks {
  /** Locks this process is judging now, so two passes never judge one lock at once in this process. */
  private readonly driving = new Set<string>();

  constructor(private readonly deps: ProfitLockDeps) {}

  private get ours() {
    return this.deps.ourAddresses.map((a) => a.toLowerCase());
  }

  async get(principal: Principal, owner: string): Promise<ProfitLockView> {
    const account = await this.deps.door.account(owner);
    return this.view(principal, account);
  }

  /** Set (or change) the target, the share and the cold wallet. A new lock starts counting this week. */
  async set(principal: Principal, input: ProfitLockSetInput): Promise<ProfitLockView> {
    const account = await this.deps.door.account(input.owner);
    const target = decimalField(input.target, 'Weekly target');
    const share = decimalField(input.share, 'Share to lock');
    if (compare(share, HUNDRED) > 0) {
      throw new ProfitLockError(
        'Share to lock is a percent of the week’s profit: at most 100',
        'trade.profit_lock_field_invalid',
        'Share to lock',
      );
    }
    const coldWallet = coldWalletOf(input.coldWallet, account.owner, this.ours);
    const at = this.deps.now();
    await this.deps.store.save({
      id: randomUUID(),
      userId: principal.userId,
      venueId: account.venueId,
      owner: account.owner,
      asset: PROFIT_LOCK_ASSET,
      target,
      share,
      coldWallet,
      weekFrom: startOfUtcWeek(at),
      at,
    });
    return this.view(principal, account);
  }

  /** Close this week's offer without signing: nothing is signed or sent, and the week offers nothing more. */
  async decline(principal: Principal, owner: string, offerKey: string): Promise<ProfitLockView> {
    const account = await this.deps.door.account(owner);
    const lock = await this.deps.store.get({ userId: principal.userId, venueId: account.venueId, owner: account.owner });
    const week = lock ? weekAt(lock, this.deps.now()) : null;
    const offer = lock && week ? await this.deps.store.offer(lock.id, week) : null;
    if (!lock || !offer || offer.offerKey !== offerKey || offer.state !== 'ready' || (await this.signedNonce(principal.userId, offer))) {
      throw new ProfitLockError('There is no offer open this week to close', 'trade.profit_lock_no_offer');
    }
    await this.deps.store.decline(offerKey, this.deps.now());
    return this.view(principal, account);
  }

  private async signedNonce(userId: string, offer: ProfitLockOffer): Promise<string | null> {
    const action = await this.deps.actions.find(userId, offer.withdrawalKey);
    return action && action.signature !== null ? action.prepared.nonce : null;
  }

  // ── the engine ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** One pass: every lock judged once against the venue's fills; then every offer not yet handed over. */
  async tick(): Promise<{ readonly offered: number; readonly published: number }> {
    let offered = 0;
    for (const lock of await this.deps.store.all()) {
      if (this.driving.has(lock.id)) continue;
      this.driving.add(lock.id);
      try {
        if (await this.pass(lock)) offered += 1;
      } catch (err) {
        log('trade.profit_lock.pass_failed', { lock: lock.id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        this.driving.delete(lock.id);
      }
    }
    return { offered, published: await this.publishPending() };
  }

  /** The lock's week as it stands now, rolled forward in the store once its seven days are up. */
  private async week(lock: ProfitLock, at: Date): Promise<Date> {
    const week = weekAt(lock, at);
    if (week.getTime() !== lock.weekFrom.getTime()) await this.deps.store.rollWeek({ lockId: lock.id, from: lock.weekFrom, to: week, at });
    return week;
  }

  /** Reads the week's realised profit from the venue; throws when the venue can't be read. */
  private async profit(venue: UserVenue, lock: ProfitLock, week: Date) {
    const account: UserVenueAccount = { venueId: lock.venueId, owner: lock.owner, subAccount: null };
    const fills = await venue.fills(account, week);
    await this.deps.store.markRead(lock.id, this.deps.now());
    return { profit: realisedSince(fills.value, week), asOf: fills.asOf };
  }

  private async pass(lock: ProfitLock): Promise<boolean> {
    const venue = await this.deps.door.venue();
    if (venue.venue.id !== lock.venueId) return false;
    const at = this.deps.now();
    const week = await this.week(lock, at);
    if (await this.deps.store.offer(lock.id, week)) return false;
    const { profit } = await this.profit(venue, lock, week);
    return (await this.claim(lock, { week, profit, at })) !== null;
  }

  /** The week's one offer, when its profit reached the target and its share is above zero. */
  private async claim(lock: ProfitLock, { week, profit, at }: { week: Date; profit: Amount; at: Date }): Promise<ProfitLockOffer | null> {
    if (compare(profit, lock.target) < 0) return null;
    const amount = shareOf(profit, lock.share);
    if (compare(amount, ZERO) <= 0) return null;
    return this.deps.store.claimOffer({
      offerKey: profitLockOfferKey(lock, week),
      lockId: lock.id,
      userId: lock.userId,
      weekFrom: week,
      asset: lock.asset,
      profit,
      target: lock.target,
      share: lock.share,
      amount,
      coldWallet: lock.coldWallet,
      withdrawalKey: profitLockWithdrawalKey(lock.owner, week),
      createdAt: at,
    });
  }

  /** Hand every unpublished offer to the bus, oldest first; one the bus did not take stays for the next pass. */
  async publishPending(): Promise<number> {
    let sent = 0;
    for (const o of await this.deps.store.unpublished(100)) {
      try {
        await this.deps.notices.publish(o);
      } catch (err) {
        log('trade.profit_lock.notice_unsent', { offerKey: o.offerKey, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      await this.deps.store.markPublished(o.offerKey, this.deps.now());
      sent += 1;
    }
    return sent;
  }

  // ── the view ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async view(principal: Principal, account: UserVenueAccount): Promise<ProfitLockView> {
    const venue = await this.deps.door.venue();
    const head = {
      venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
      owner: account.owner,
      asset: PROFIT_LOCK_ASSET,
    };
    const at = this.deps.now();
    const lock = await this.deps.store.get({ userId: principal.userId, venueId: account.venueId, owner: account.owner });
    if (!lock) {
      return {
        ...head,
        lockId: null,
        setting: null,
        week: { from: startOfUtcWeek(at).toISOString(), readable: true, profit: null, asOf: null, lastReadAt: null },
        offer: null,
        withdrawal: null,
      };
    }
    const week = await this.week(lock, at);
    const setting = {
      target: formatAmount(lock.target),
      share: formatAmount(lock.share),
      coldWallet: lock.coldWallet,
      savedAt: lock.updatedAt.toISOString(),
    };
    let read: { profit: Amount; asOf: Date };
    let free: Amount;
    let terms: { fee: MaybeKnown<Amount>; networkFee: MaybeKnown<Amount> };
    let balancesAsOf: Date;
    try {
      read = await this.profit(venue, lock, week);
      const balances = await venue.balances(account);
      free = balances.value.find((b) => b.asset === lock.asset)?.free ?? ZERO;
      balancesAsOf = balances.asOf;
      const t = venue.withdrawalTerms ? (await venue.withdrawalTerms(lock.asset)).value : null;
      terms = { fee: t?.fee ?? { known: false }, networkFee: t?.networkFee ?? { known: false } };
    } catch (err) {
      log('trade.profit_lock.venue_unread', { lock: lock.id, message: err instanceof Error ? err.message : String(err) });
      const last = await this.deps.store.get({ userId: principal.userId, venueId: account.venueId, owner: account.owner });
      return {
        ...head,
        lockId: lock.id,
        setting,
        week: { from: week.toISOString(), readable: false, profit: null, asOf: null, lastReadAt: last?.lastReadAt?.toISOString() ?? null },
        offer: null,
        withdrawal: null,
      };
    }
    // The view may reach the target before the engine's next pass: the claim is the same one, under the same key.
    const offer = (await this.deps.store.offer(lock.id, week)) ?? (await this.claim(lock, { week, profit: read.profit, at }));
    if (offer && offer.publishedAt === null) void this.publishPending().catch(() => undefined);
    const nonce = offer ? await this.signedNonce(principal.userId, offer) : null;
    const state = nonce !== null ? ('signed' as const) : (offer?.state ?? 'ready');
    const fill = offer && state === 'ready' ? filledIn(offer.amount, free, terms.fee) : null;
    return {
      ...head,
      lockId: lock.id,
      setting,
      week: {
        from: week.toISOString(),
        readable: true,
        profit: formatAmount(read.profit),
        asOf: read.asOf.toISOString(),
        lastReadAt: read.asOf.toISOString(),
      },
      offer: offer
        ? {
            offerKey: offer.offerKey,
            weekFrom: offer.weekFrom.toISOString(),
            profit: formatAmount(offer.profit),
            target: formatAmount(offer.target),
            share: formatAmount(offer.share),
            amount: formatAmount(offer.amount),
            coldWallet: offer.coldWallet,
            state,
            withdrawalKey: offer.withdrawalKey,
            nonce,
            at: offer.createdAt.toISOString(),
          }
        : null,
      withdrawal: fill
        ? {
            amount: formatAmount(fill.amount),
            cut: fill.cut,
            free: formatAmount(free),
            withdrawable: formatAmount(fill.withdrawable),
            fee: known(terms.fee),
            networkFee: known(terms.networkFee),
            asOf: balancesAsOf.toISOString(),
          }
        : null,
    };
  }
}
