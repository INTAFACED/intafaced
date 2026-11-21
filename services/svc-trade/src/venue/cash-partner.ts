/**
 * THE CASH LEG OF A CONVERT FROM A CASH CURRENCY (J-cex-spot-11 #11; owner row d115, 17 Nov 2026: "a cash convert through
 * crypto is offered where the partner offers it, otherwise the screen says so"). A cash currency reaches a coin in two
 * linked legs: the partner takes the person's cash and delivers a stablecoin to the person's own venue account (the cash
 * leg, the partner's, carried out for the person), then one wallet-signed venue order buys the coin with it (the venue
 * leg). INTAFACED holds none of the money and the ledger posts nothing for either leg.
 *
 * No partner is contracted, so `TRADE_CONVERT_CASH_PARTNER` is blank everywhere real and every cash currency refuses
 * `trade.convert_cash_not_offered`. `test` is the LOCAL TEST stand-in, refused at boot outside APP_ENV dev or test: it
 * prices from the TEST catalogue in `TRADE_CONVERT_CASH_TEST_JSON` (each currency it offers: its rate, fee and largest
 * leg), takes no cash and delivers TEST stablecoin through the TEST venue's own deposit control, under the leg's id. Its
 * own record of every leg is `trade.test_cash_partner_legs`, one row per business key: a retry never runs a leg twice.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount } from '@intafaced/venue-contracts';

/** The partner's figure for one cash leg: `cash` paid in `currency`, its fee inside it, and the stablecoin delivered. */
export interface CashPrice {
  readonly currency: string;
  readonly cash: Amount;
  readonly fee: Amount;
  /** The stablecoin for 1 `currency`. */
  readonly rate: Amount;
  readonly stable: string;
  /** `(cash - fee) * rate`, rounded down to the stablecoin's 6 decimals: what reaches the venue account. */
  readonly stableAmount: Amount;
}

export type CashLegState = 'pending' | 'settled' | 'refused';

/** One cash leg as the partner records it. */
export interface CashLeg extends CashPrice {
  readonly key: string;
  readonly legId: string;
  readonly userId: string;
  readonly account: UserVenueAccount;
  readonly state: CashLegState;
  readonly refusal: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}

/** The partner refused this cash leg, with its reason. Nothing was taken or delivered. */
export class CashPartnerRefusal extends Error {}

export interface CashPartner {
  /** The stablecoin it delivers: the venue leg buys the coin on the `<coin>-<stable>` market. */
  readonly stable: string;
  offers(currency: string): boolean;
  /** Its figure for `cash` of `currency`. Holds nothing. Throws `CashPartnerRefusal`. */
  price(currency: string, cash: Amount): CashPrice;
  /** Carry out the leg under `key`, once per key: the same key again is the leg it was. Throws when it could not finish. */
  exchange(ask: { key: string; userId: string; account: UserVenueAccount; price: CashPrice }): Promise<CashLeg>;
  legOf(key: string): Promise<CashLeg | null>;
}

export interface CashLegStore {
  /** Stores `leg` unless one is stored under its key; returns the one stored. */
  insert(leg: CashLeg): Promise<CashLeg>;
  get(key: string): Promise<CashLeg | null>;
  /** A pending leg settles or is refused once; a leg already decided stays as it was. */
  decide(key: string, outcome: { state: 'settled'; at: Date } | { state: 'refused'; reason: string }): Promise<CashLeg>;
}

export class MemoryCashLegStore implements CashLegStore {
  private readonly rows = new Map<string, CashLeg>();

  async insert(leg: CashLeg): Promise<CashLeg> {
    const had = this.rows.get(leg.key);
    if (had) return had;
    this.rows.set(leg.key, leg);
    return leg;
  }

  async get(key: string): Promise<CashLeg | null> {
    return this.rows.get(key) ?? null;
  }

  async decide(key: string, outcome: { state: 'settled'; at: Date } | { state: 'refused'; reason: string }): Promise<CashLeg> {
    const leg = this.rows.get(key);
    if (!leg) throw new Error(`no cash leg under ${key}`);
    if (leg.state !== 'pending') return leg;
    const next: CashLeg =
      outcome.state === 'settled'
        ? { ...leg, state: 'settled', settledAt: outcome.at }
        : { ...leg, state: 'refused', refusal: outcome.reason };
    this.rows.set(key, next);
    return next;
  }
}

const Row = z.object({
  business_key: z.string(),
  leg_id: z.string(),
  user_id: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  currency: z.string(),
  cash: z.string(),
  fee: z.string(),
  rate: z.string(),
  stable: z.string(),
  stable_amount: z.string(),
  state: z.enum(['pending', 'settled', 'refused']),
  refusal: z.string().nullable(),
  created_at: z.date(),
  settled_at: z.date().nullable(),
});

const fromRow = (r: z.infer<typeof Row>): CashLeg => ({
  key: r.business_key,
  legId: r.leg_id,
  userId: r.user_id,
  account: { venueId: r.venue_id, owner: r.owner, subAccount: null },
  currency: r.currency,
  cash: parseAmount(r.cash),
  fee: parseAmount(r.fee),
  rate: parseAmount(r.rate),
  stable: r.stable,
  stableAmount: parseAmount(r.stable_amount),
  state: r.state,
  refusal: r.refusal,
  createdAt: r.created_at,
  settledAt: r.settled_at,
});

const COLUMNS = `business_key, leg_id, user_id, venue_id, owner, currency, cash::text, fee::text, rate::text, stable,
  stable_amount::text, state, refusal, created_at, settled_at`;

export class SqlCashLegStore implements CashLegStore {
  constructor(private readonly sql: Sql) {}

  async insert(l: CashLeg): Promise<CashLeg> {
    await this.sql`
      INSERT INTO trade.test_cash_partner_legs (
        business_key, leg_id, user_id, venue_id, owner, currency, cash, fee, rate, stable, stable_amount, state, refusal,
        created_at, settled_at
      ) VALUES (
        ${l.key}, ${l.legId}, ${l.userId}, ${l.account.venueId}, ${l.account.owner}, ${l.currency}, ${formatAmount(l.cash)},
        ${formatAmount(l.fee)}, ${formatAmount(l.rate)}, ${l.stable}, ${formatAmount(l.stableAmount)}, ${l.state}, ${l.refusal},
        ${l.createdAt.toISOString()}, ${l.settledAt?.toISOString() ?? null}
      )
      ON CONFLICT (business_key) DO NOTHING`;
    const stored = await this.get(l.key);
    if (!stored) throw new Error(`cash leg ${l.key} was not stored`);
    return stored;
  }

  async get(key: string): Promise<CashLeg | null> {
    const rows = Row.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(COLUMNS)} FROM trade.test_cash_partner_legs WHERE business_key = ${key}`,
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async decide(key: string, outcome: { state: 'settled'; at: Date } | { state: 'refused'; reason: string }): Promise<CashLeg> {
    await this.sql`
      UPDATE trade.test_cash_partner_legs
      SET state = ${outcome.state},
          settled_at = ${outcome.state === 'settled' ? outcome.at.toISOString() : null},
          refusal = ${outcome.state === 'refused' ? outcome.reason : null}
      WHERE business_key = ${key} AND state = 'pending'`;
    const stored = await this.get(key);
    if (!stored) throw new Error(`no cash leg under ${key}`);
    return stored;
  }
}

const decimal = z.string().regex(/^\d+(\.\d+)?$/);
const Catalogue = z.object({
  stable: z.string().regex(/^[A-Z0-9]{2,12}$/),
  currencies: z.record(z.string().regex(/^[A-Z]{3}$/), z.object({ rate: decimal, fee: decimal, max: decimal.nullable() }).strict()),
});

interface Offer {
  readonly rate: Amount;
  readonly fee: Amount;
  readonly max: Amount | null;
}

const STABLE_STEP = 10n ** 12n;
/** The leg's id at the partner, from its business key: the venue credits a delivery under it once. */
const legIdOf = (key: string) => `tcash-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

/** The LOCAL TEST cash partner: prices from its TEST catalogue and delivers TEST stablecoin through the TEST venue. */
export class TestCashPartner implements CashPartner {
  readonly stable: string;
  private readonly offers_: ReadonlyMap<string, Offer>;

  constructor(
    catalogue: z.infer<typeof Catalogue>,
    private readonly deps: {
      store: CashLegStore;
      now: () => Date;
      /** Credits `amount` of `asset` to `account` under `ref`, once per ref (the TEST venue's deposit control). */
      deliver: (account: UserVenueAccount, asset: string, amount: Amount, ref: string) => Promise<void>;
    },
  ) {
    this.stable = catalogue.stable;
    this.offers_ = new Map(
      Object.entries(catalogue.currencies).map(([c, o]) => [
        c,
        { rate: parseAmount(o.rate), fee: parseAmount(o.fee), max: o.max === null ? null : parseAmount(o.max) },
      ]),
    );
  }

  offers(currency: string): boolean {
    return this.offers_.has(currency);
  }

  price(currency: string, cash: Amount): CashPrice {
    const offer = this.offers_.get(currency);
    if (!offer) throw new CashPartnerRefusal(`the partner does not offer ${currency}`);
    if (offer.max !== null && cash > offer.max)
      throw new CashPartnerRefusal(`the partner takes at most ${formatAmount(offer.max)} ${currency} in one leg`);
    if (cash <= offer.fee) throw new CashPartnerRefusal(`the partner's fee is ${formatAmount(offer.fee)} ${currency}; pay more than it`);
    const stableAmount = (mul(sub(cash, offer.fee), offer.rate, 'floor') / STABLE_STEP) * STABLE_STEP;
    return { currency, cash, fee: offer.fee, rate: offer.rate, stable: this.stable, stableAmount };
  }

  async exchange(ask: { key: string; userId: string; account: UserVenueAccount; price: CashPrice }): Promise<CashLeg> {
    const leg = await this.deps.store.insert({
      ...ask.price,
      key: ask.key,
      legId: legIdOf(ask.key),
      userId: ask.userId,
      account: { ...ask.account, subAccount: null },
      state: 'pending',
      refusal: null,
      createdAt: this.deps.now(),
      settledAt: null,
    });
    const p = ask.price;
    if (leg.userId !== ask.userId || leg.currency !== p.currency || leg.cash !== p.cash || leg.stableAmount !== p.stableAmount)
      throw new CashPartnerRefusal('this key already carried out a different cash leg');
    if (leg.state !== 'pending') return leg;
    try {
      this.price(leg.currency, leg.cash);
    } catch (err) {
      if (err instanceof CashPartnerRefusal) return this.deps.store.decide(leg.key, { state: 'refused', reason: err.message });
      throw err;
    }
    // A delivery that fails leaves the leg pending: the same key again delivers under the same id, credited once.
    await this.deps.deliver(leg.account, leg.stable, leg.stableAmount, leg.legId);
    return this.deps.store.decide(leg.key, { state: 'settled', at: this.deps.now() });
  }

  legOf(key: string): Promise<CashLeg | null> {
    return this.deps.store.get(key);
  }
}

/**
 * The cash partner `TRADE_CONVERT_CASH_PARTNER` names: blank is none, so every cash currency is not offered; `test` is the
 * LOCAL TEST stand-in, refused outside APP_ENV dev or test and without its catalogue.
 */
export function cashPartnerFor(
  setting: string,
  catalogueJson: string,
  appEnv: string | undefined,
  deps: ConstructorParameters<typeof TestCashPartner>[1],
): CashPartner | null {
  const name = setting.trim();
  if (name === '') return null;
  if (name !== 'test') throw new Error(`TRADE_CONVERT_CASH_PARTNER is "${name}"; leave it blank (no partner) or set test on a test stack`);
  if (appEnv !== 'dev' && appEnv !== 'test')
    throw new Error(`TRADE_CONVERT_CASH_PARTNER=test is the LOCAL TEST cash partner and is refused outside APP_ENV dev or test`);
  if (!catalogueJson.trim()) throw new Error('TRADE_CONVERT_CASH_PARTNER=test needs its TEST catalogue in TRADE_CONVERT_CASH_TEST_JSON');
  return new TestCashPartner(Catalogue.parse(JSON.parse(catalogueJson)), deps);
}
