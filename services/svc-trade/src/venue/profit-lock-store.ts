import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { TestAgeSubject } from '@intafaced/service-kit';

/**
 * The person's weekly Profit lock on their own venue account (J-wallet-26; profit-lock.ts), held in
 * `trade.user_venue_profit_lock*` (drizzle/20261127214036_user_venue_profit_locks.sql). A setting and its weekly offers:
 * no balance, no post, nothing sent to the venue from here.
 */

export interface ProfitLockAccount {
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
}

export interface ProfitLock extends ProfitLockAccount {
  readonly id: string;
  readonly asset: string;
  readonly target: Amount;
  /** In percent, above 0 and at most 100. */
  readonly share: Amount;
  readonly coldWallet: string;
  /** The start of the week being counted. */
  readonly weekFrom: Date;
  /** TEST only: when the TEST clock last moved this lock's week back; fills before it belong to the week that ended. */
  readonly testAgedAt: Date | null;
  readonly lastReadAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ProfitLockOfferState = 'ready' | 'declined';

export interface ProfitLockOffer {
  readonly offerKey: string;
  readonly lockId: string;
  readonly userId: string;
  readonly weekFrom: Date;
  readonly asset: string;
  readonly profit: Amount;
  readonly target: Amount;
  readonly share: Amount;
  readonly amount: Amount;
  readonly coldWallet: string;
  readonly withdrawalKey: string;
  readonly state: ProfitLockOfferState;
  readonly createdAt: Date;
  readonly publishedAt: Date | null;
}

export interface ProfitLockSave extends ProfitLockAccount {
  /** Used only when the account has no lock yet. */
  readonly id: string;
  readonly asset: string;
  readonly target: Amount;
  readonly share: Amount;
  readonly coldWallet: string;
  /** Used only when the account has no lock yet: the week the new lock starts counting. */
  readonly weekFrom: Date;
  readonly at: Date;
}

export interface ProfitLockRoll {
  readonly lockId: string;
  readonly from: Date;
  readonly to: Date;
  readonly at: Date;
}

export interface ProfitLockStore {
  get(account: ProfitLockAccount): Promise<ProfitLock | null>;
  save(input: ProfitLockSave): Promise<ProfitLock>;
  all(): Promise<readonly ProfitLock[]>;
  /** The lock's next week: `weekFrom` moves forward to `to`, only from `from` (so two passes roll it once). */
  rollWeek(roll: ProfitLockRoll): Promise<void>;
  markRead(lockId: string, at: Date): Promise<void>;
  /** The week's one offer: written once per (lock, week); a second claim for the same week returns null. */
  claimOffer(offer: Omit<ProfitLockOffer, 'publishedAt' | 'state'>): Promise<ProfitLockOffer | null>;
  offer(lockId: string, weekFrom: Date): Promise<ProfitLockOffer | null>;
  decline(offerKey: string, at: Date): Promise<ProfitLockOffer | null>;
  unpublished(limit: number): Promise<readonly ProfitLockOffer[]>;
  markPublished(offerKey: string, at: Date): Promise<void>;
}

const accountId = (a: ProfitLockAccount) => `${a.userId}\n${a.venueId}\n${a.owner}`;

export class InMemoryProfitLockStore implements ProfitLockStore {
  readonly locks = new Map<string, ProfitLock>();
  readonly offers = new Map<string, ProfitLockOffer>();
  private byId(lockId: string) {
    return [...this.locks.entries()].find(([, l]) => l.id === lockId);
  }
  async get(a: ProfitLockAccount) {
    return this.locks.get(accountId(a)) ?? null;
  }
  async save(s: ProfitLockSave) {
    const prev = this.locks.get(accountId(s));
    const next: ProfitLock = {
      id: prev?.id ?? s.id,
      userId: s.userId,
      venueId: s.venueId,
      owner: s.owner,
      asset: s.asset,
      target: s.target,
      share: s.share,
      coldWallet: s.coldWallet,
      weekFrom: prev?.weekFrom ?? s.weekFrom,
      testAgedAt: prev?.testAgedAt ?? null,
      lastReadAt: prev?.lastReadAt ?? null,
      createdAt: prev?.createdAt ?? s.at,
      updatedAt: s.at,
    };
    this.locks.set(accountId(s), next);
    return next;
  }
  async all() {
    return [...this.locks.values()];
  }
  async rollWeek({ lockId, from, to, at }: ProfitLockRoll) {
    const hit = this.byId(lockId);
    if (hit && hit[1].weekFrom.getTime() === from.getTime()) this.locks.set(hit[0], { ...hit[1], weekFrom: to, updatedAt: at });
  }
  async markRead(lockId: string, at: Date) {
    const hit = this.byId(lockId);
    if (hit) this.locks.set(hit[0], { ...hit[1], lastReadAt: at });
  }
  async claimOffer(o: Omit<ProfitLockOffer, 'publishedAt' | 'state'>) {
    if (this.offers.has(o.offerKey)) return null;
    if ([...this.offers.values()].some((x) => x.lockId === o.lockId && x.weekFrom.getTime() === o.weekFrom.getTime())) return null;
    const offer: ProfitLockOffer = { ...o, state: 'ready', publishedAt: null };
    this.offers.set(o.offerKey, offer);
    return offer;
  }
  async offer(lockId: string, weekFrom: Date) {
    return [...this.offers.values()].find((o) => o.lockId === lockId && o.weekFrom.getTime() === weekFrom.getTime()) ?? null;
  }
  async decline(offerKey: string) {
    const o = this.offers.get(offerKey);
    if (!o || o.state !== 'ready') return null;
    const next: ProfitLockOffer = { ...o, state: 'declined' };
    this.offers.set(offerKey, next);
    return next;
  }
  async unpublished(limit: number) {
    return [...this.offers.values()].filter((o) => o.publishedAt === null).slice(0, limit);
  }
  async markPublished(offerKey: string, at: Date) {
    const o = this.offers.get(offerKey);
    if (o) this.offers.set(offerKey, { ...o, publishedAt: at });
  }
  /** TEST clock, as the SQL store's `ageProfitLock`. */
  age(lockId: string, ms: number, at: Date) {
    const hit = this.byId(lockId);
    if (!hit) return null;
    this.locks.set(hit[0], { ...hit[1], weekFrom: new Date(hit[1].weekFrom.getTime() - ms), testAgedAt: at });
    for (const [k, o] of this.offers) if (o.lockId === lockId) this.offers.set(k, { ...o, weekFrom: new Date(o.weekFrom.getTime() - ms) });
    return true;
  }
}

const LockRow = z.object({
  id: z.string(),
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  asset: z.string(),
  target: z.string(),
  share_percent: z.string(),
  cold_wallet: z.string(),
  week_from: z.date(),
  test_aged_at: z.date().nullable(),
  last_read_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
type LockRow = z.infer<typeof LockRow>;

const OfferRow = z.object({
  offer_key: z.string(),
  lock_id: z.string(),
  user_id: z.string(),
  week_from: z.date(),
  asset: z.string(),
  profit: z.string(),
  target: z.string(),
  share_percent: z.string(),
  amount: z.string(),
  cold_wallet: z.string(),
  withdrawal_key: z.string(),
  state: z.enum(['ready', 'declined']),
  created_at: z.date(),
  published_at: z.date().nullable(),
});
type OfferRow = z.infer<typeof OfferRow>;

const lockOf = (r: LockRow): ProfitLock => ({
  id: r.id,
  userId: r.user_id,
  venueId: r.venue_id,
  owner: r.owner,
  asset: r.asset,
  target: parseAmount(r.target),
  share: parseAmount(r.share_percent),
  coldWallet: r.cold_wallet,
  weekFrom: r.week_from,
  testAgedAt: r.test_aged_at,
  lastReadAt: r.last_read_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const offerOf = (r: OfferRow): ProfitLockOffer => ({
  offerKey: r.offer_key,
  lockId: r.lock_id,
  userId: r.user_id,
  weekFrom: r.week_from,
  asset: r.asset,
  profit: parseAmount(r.profit),
  target: parseAmount(r.target),
  share: parseAmount(r.share_percent),
  amount: parseAmount(r.amount),
  coldWallet: r.cold_wallet,
  withdrawalKey: r.withdrawal_key,
  state: r.state,
  createdAt: r.created_at,
  publishedAt: r.published_at,
});

export class SqlProfitLockStore implements ProfitLockStore {
  constructor(private readonly sql: Sql) {}

  async get({ userId, venueId, owner }: ProfitLockAccount) {
    const rows = LockRow.array().parse(
      await this.sql`
      SELECT * FROM trade.user_venue_profit_locks WHERE user_id = ${userId} AND venue_id = ${venueId} AND owner = ${owner}`,
    );
    return rows[0] ? lockOf(rows[0]) : null;
  }

  async save(s: ProfitLockSave) {
    const rows = LockRow.array().parse(
      await this.sql`
      INSERT INTO trade.user_venue_profit_locks
        (id, user_id, venue_id, owner, asset, target, share_percent, cold_wallet, week_from, created_at, updated_at)
      VALUES (${s.id}, ${s.userId}, ${s.venueId}, ${s.owner}, ${s.asset}, ${formatAmount(s.target)}, ${formatAmount(s.share)},
        ${s.coldWallet}, ${s.weekFrom}, ${s.at}, ${s.at})
      -- conflict-keys-ok: user_venue_profit_locks_pkey — the id is a fresh random uuid made for each save (profit-lock.ts), so two saves never share one; the row is named by (user_id, venue_id, owner), the key this statement absorbs
      ON CONFLICT (user_id, venue_id, owner) DO UPDATE SET
        asset = EXCLUDED.asset,
        target = EXCLUDED.target,
        share_percent = EXCLUDED.share_percent,
        cold_wallet = EXCLUDED.cold_wallet,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
    );
    const row = rows[0];
    if (!row) throw new Error('trade.user_venue_profit_locks: the save returned no row');
    return lockOf(row);
  }

  async all() {
    return LockRow.array()
      .parse(await this.sql`SELECT * FROM trade.user_venue_profit_locks ORDER BY created_at LIMIT 5000`)
      .map(lockOf);
  }

  async rollWeek({ lockId, from, to, at }: ProfitLockRoll) {
    await this.sql`
      UPDATE trade.user_venue_profit_locks SET week_from = ${to}, updated_at = ${at}
      WHERE id = ${lockId} AND week_from = ${from}`;
  }

  async markRead(lockId: string, at: Date) {
    await this.sql`UPDATE trade.user_venue_profit_locks SET last_read_at = ${at} WHERE id = ${lockId}`;
  }

  async claimOffer(o: Omit<ProfitLockOffer, 'publishedAt' | 'state'>) {
    const rows = OfferRow.array().parse(
      await this.sql`
      INSERT INTO trade.user_venue_profit_lock_offers
        (offer_key, lock_id, user_id, week_from, asset, profit, target, share_percent, amount, cold_wallet, withdrawal_key,
         state, created_at)
      VALUES (${o.offerKey}, ${o.lockId}, ${o.userId}, ${o.weekFrom}, ${o.asset}, ${formatAmount(o.profit)},
        ${formatAmount(o.target)}, ${formatAmount(o.share)}, ${formatAmount(o.amount)}, ${o.coldWallet}, ${o.withdrawalKey},
        'ready', ${o.createdAt})
      ON CONFLICT DO NOTHING
      RETURNING *`,
    );
    return rows[0] ? offerOf(rows[0]) : null;
  }

  async offer(lockId: string, weekFrom: Date) {
    const rows = OfferRow.array().parse(
      await this.sql`SELECT * FROM trade.user_venue_profit_lock_offers WHERE lock_id = ${lockId} AND week_from = ${weekFrom}`,
    );
    return rows[0] ? offerOf(rows[0]) : null;
  }

  async decline(offerKey: string, at: Date) {
    const rows = OfferRow.array().parse(
      await this.sql`
      UPDATE trade.user_venue_profit_lock_offers SET state = 'declined', declined_at = ${at}
      WHERE offer_key = ${offerKey} AND state = 'ready'
      RETURNING *`,
    );
    return rows[0] ? offerOf(rows[0]) : null;
  }

  async unpublished(limit: number) {
    return OfferRow.array()
      .parse(
        await this.sql`
        SELECT * FROM trade.user_venue_profit_lock_offers WHERE published_at IS NULL ORDER BY created_at LIMIT ${limit}`,
      )
      .map(offerOf);
  }

  async markPublished(offerKey: string, at: Date) {
    await this.sql`UPDATE trade.user_venue_profit_lock_offers SET published_at = ${at} WHERE offer_key = ${offerKey}`;
  }
}

/**
 * TEST clock for one Profit lock (svc-trade's TEST age door, subject `profit-lock`, id the lock's id): its week and that
 * week's offer move back `ms`, as if the time had gone by, and the moment of aging is kept, so venue fills before it stay
 * in the week that ended (the venue's own fill times can't move). Nothing that holds or moves value.
 */
const AgedRow = z.object({ week_from: z.date() });

export function ageProfitLock(sql: Sql): TestAgeSubject {
  return async (id, ms) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const rows = AgedRow.array().parse(
      await sql`
      UPDATE trade.user_venue_profit_locks
      SET week_from = week_from - make_interval(secs => ${ms / 1000}), test_aged_at = now()
      WHERE id = ${id}
      RETURNING week_from`,
    );
    const row = rows[0];
    if (!row) return null;
    await sql`
      UPDATE trade.user_venue_profit_lock_offers SET week_from = week_from - make_interval(secs => ${ms / 1000})
      WHERE lock_id = ${id}`;
    return { weekFrom: new Date(row.week_from).toISOString() };
  };
}
