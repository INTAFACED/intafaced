import { createHash } from 'node:crypto';
import { isExplicitDevOrTest } from '@intafaced/config';
import { z } from 'zod';
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { partnerPayoutsAccount, type PartnerBank, type PartnerCustody } from './partner-bank.js';
import { moneyHeldBy, type TestPartnerDoors } from './test-partner.js';

/**
 * CASH THROUGH A COIN: THE PARTNER'S CASH LEG (J-cex-spot-11 #11; row d115, 17 Nov 2026: "a cash convert through crypto is
 * offered where the partner offers it, otherwise the screen says so").
 *
 * A person converting a cash currency to a coin does it as two linked legs. This is the first: the partner that holds the
 * person's cash sells them the venue's quote coin for it and pays that coin into the person's own venue account.
 * The second leg, the coin for the coin they want, is the venue order their wallet signs (svc-trade `venue-convert.ts`).
 *
 *   · OFFERED only where the partner offers it: the partner holds this person's cash, it is answering, it has not switched
 *     the cash leg off for them, and it gives a rate for that cash and coin. Anything else is not offered, with the reason.
 *   · ONE LEG PER KEY. svc-trade names the leg by its business key (`convert-cash:<owner>:<quoteId>`): the same key is the
 *     same leg, once, however often it is asked (a double press, a lost answer, Check again). Another body under the key
 *     refuses `bank.partner_move_conflict`. The cash leaves the person's main balance as ONE partner move under that key.
 *   · The partner pays the coin out once under the same key: a payout whose answer was lost is paid again under that key,
 *     which the venue credits once. Until it is paid the leg reads `sending`, and asking again finishes it.
 *   · Every figure is the partner's. INTAFACED's ledger posts nothing for either leg (docs/adr/2026-11-10-launch-money-model.md).
 *
 * Only the TEST partner offers a cash leg today: its rate is a labelled TEST value of the stack (`BANK_TEST_CASH_LEG_RATES`)
 * and its payout is the TEST venue's own deposit control (`BANK_TEST_CASH_LEG_VENUE_URL`). No real partner is wired, so off
 * the TEST stack nothing is offered and every carry refuses `bank.cash_leg_not_offered`.
 */

const KEY_RE = /^convert-cash:[A-Za-z0-9]{1,64}:[A-Za-z0-9_-]{8,80}$/;
/** The coin's smallest unit the partner pays in: 6 decimal places, as USDC is. */
const COIN_STEP = 10n ** 12n;
/** The most legs the TEST partner keeps; past it a carry refuses `bank.partner_unavailable` rather than forget one. */
const MAX_LEGS = 50_000;

/** One rate the partner gives: `rate` coins for one unit of `cash`. */
export interface CashLegRate {
  readonly cash: string;
  readonly coin: string;
  readonly rate: Amount;
}

export interface CashLegOffer extends CashLegRate {
  readonly label: string;
  readonly test: boolean;
  /** The person's cash the partner says can move now, or null when it gives no figure. */
  readonly available: Amount | null;
  readonly asOf: Date;
}

export interface CashLegOffers {
  readonly offers: readonly CashLegOffer[];
  /** Why nothing is offered, when nothing is. */
  readonly reason: string | null;
}

/** The person's own venue account the coin is paid into. */
export interface CashLegVenueAccount {
  readonly venueId: string;
  readonly owner: string;
}

export interface CashLegAsk {
  readonly key: string;
  readonly cash: string;
  readonly coin: string;
  /** The cash the person pays. */
  readonly spend: Amount;
  /** The least coin the caller priced its second leg with: a rate that now gives less refuses, nothing moved. */
  readonly least: Amount;
  readonly venue: CashLegVenueAccount;
}

export type CashLegState = 'sending' | 'delivered';

export interface CashLeg {
  readonly key: string;
  readonly userId: string;
  readonly cash: string;
  readonly coin: string;
  readonly paid: Amount;
  readonly delivered: Amount;
  readonly rate: Amount;
  readonly venue: CashLegVenueAccount;
  readonly state: CashLegState;
  /** The partner's id of the cash move. */
  readonly moveId: string;
  readonly movedAt: Date;
  readonly deliveredAt: Date | null;
  readonly label: string;
  readonly test: boolean;
}

/** How the partner pays the coin into a venue account: once per `ref`, whatever else is asked. */
export interface CashLegPayout {
  pay(input: { readonly ref: string; readonly venue: CashLegVenueAccount; readonly coin: string; readonly amount: Amount }): Promise<void>;
}

export interface CashLegs {
  offers(userId: string): Promise<CashLegOffers>;
  carry(userId: string, ask: CashLegAsk): Promise<CashLeg>;
  /** The leg under `key`, when it is this person's; null when the partner made none. */
  leg(userId: string, key: string): Promise<CashLeg | null>;
}

const notOffered = (reason: string): BankError =>
  new BankError(`The partner does not offer cash through a coin here: ${reason}. Nothing was moved.`, 'bank.cash_leg_not_offered');

/** `EUR:USDC:1.08,USD:USDC:1`: each the coins one unit of cash buys. Null when blank; a malformed list throws. */
export function parseCashLegRates(raw: string | undefined): readonly CashLegRate[] | null {
  if (!raw?.trim()) return null;
  return raw.split(',').map((part) => {
    const [cash, coin, rate, ...rest] = part.trim().split(':');
    if (
      rest.length ||
      !cash ||
      !coin ||
      !rate ||
      !/^[A-Z]{3}$/.test(cash) ||
      !/^[A-Z0-9]{2,16}$/.test(coin) ||
      !/^\d+(\.\d{1,18})?$/.test(rate)
    )
      throw new Error(`BANK_TEST_CASH_LEG_RATES "${part}" is not CASH:COIN:RATE (for example EUR:USDC:1.08)`);
    const value = parseAmount(rate);
    if (value <= 0n) throw new Error(`BANK_TEST_CASH_LEG_RATES "${part}" needs a rate above zero`);
    return Object.freeze({ cash, coin, rate: value });
  });
}

/** None offered: no partner gives a cash leg on this deployment. */
export const NO_CASH_LEGS: CashLegs = {
  offers: async () => ({ offers: [], reason: 'no partner offers a cash leg on this deployment' }),
  carry: async () => {
    throw notOffered('no partner offers a cash leg on this deployment');
  },
  leg: async () => null,
};

/**
 * The TEST partner's cash leg (LOCAL TEST): its rates, its payouts into the TEST venue, and its own record of each leg.
 * Its record lives in memory, as the rest of the TEST partner's book does: a restart empties it.
 */
export function testPartnerCashLegs(deps: {
  readonly partner: TestPartnerDoors;
  readonly custody: PartnerCustody;
  readonly custodyLayer: 'on' | 'off';
  readonly rates: readonly CashLegRate[];
  readonly payout: CashLegPayout;
}): CashLegs {
  const legs = new Map<string, CashLeg>();
  /** The carry under way for each key: a second ask of a key waits for it, then reads the one stored leg. */
  const inFlight = new Map<string, Promise<unknown>>();
  const oneAtATime = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const before = inFlight.get(key) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(key, settled);
    void settled.then(() => {
      if (inFlight.get(key) === settled) inFlight.delete(key);
    });
    return next;
  };

  const why = (userId: string): string | null => {
    if (moneyHeldBy(deps.partner, userId, deps.custodyLayer) !== 'partner') return 'the partner does not hold this person’s cash';
    const now = deps.partner.switches(userId);
    if (now.down) return 'the partner bank is not answering';
    if (now.notOffered.includes('cash_leg')) return 'the partner has switched cash through a coin off for this person';
    return null;
  };
  const bankOf = (userId: string): PartnerBank => {
    const bank = deps.custody.bankFor(userId);
    if (!bank) throw notOffered('the partner does not hold this person’s cash');
    return bank;
  };

  async function finish(leg: CashLeg): Promise<CashLeg> {
    if (leg.state === 'delivered') return leg;
    try {
      await deps.payout.pay({ ref: leg.key, venue: leg.venue, coin: leg.coin, amount: leg.delivered });
    } catch {
      throw new BankError(
        `The partner took ${formatAmount(leg.paid)} ${leg.cash} and has not yet paid ${formatAmount(leg.delivered)} ${leg.coin} into the venue account. Check again: it is paid once.`,
        'bank.cash_leg_sending',
      );
    }
    const done: CashLeg = Object.freeze({ ...leg, state: 'delivered', deliveredAt: new Date() });
    legs.set(leg.key, done);
    return done;
  }

  return {
    async offers(userId) {
      const reason = why(userId);
      if (reason) return { offers: [], reason };
      const bank = bankOf(userId);
      const offers: CashLegOffer[] = [];
      for (const r of deps.rates) {
        const balance = await bank.balance({ userId, assetId: r.cash, spaceId: null });
        offers.push({ ...r, label: bank.label, test: true, available: balance.amount, asOf: balance.asOf ?? new Date() });
      }
      return { offers, reason: null };
    },

    async carry(userId, ask) {
      if (!KEY_RE.test(ask.key)) throw new BankError('A cash leg is named by its convert key.', 'bank.cash_leg_invalid');
      if (ask.spend <= 0n || ask.least <= 0n) throw new BankError('A cash leg pays and receives above zero.', 'bank.cash_leg_invalid');
      return oneAtATime(ask.key, () => carryOne(userId, ask));
    },

    async leg(userId, key) {
      const leg = legs.get(key);
      return leg && leg.userId === userId ? leg : null;
    },
  };

  async function carryOne(userId: string, ask: CashLegAsk): Promise<CashLeg> {
    const prior = legs.get(ask.key);
    if (prior) {
      if (
        prior.userId !== userId ||
        prior.cash !== ask.cash ||
        prior.coin !== ask.coin ||
        prior.paid !== ask.spend ||
        prior.venue.venueId !== ask.venue.venueId ||
        prior.venue.owner !== ask.venue.owner
      )
        throw new BankError(
          `The partner already holds a different cash leg under ${ask.key}, so this one was not made.`,
          'bank.partner_move_conflict',
        );
      return finish(prior);
    }
    const reason = why(userId);
    if (reason) throw notOffered(reason);
    const rate = deps.rates.find((r) => r.cash === ask.cash && r.coin === ask.coin);
    if (!rate) throw notOffered(`it gives no rate for ${ask.cash} to ${ask.coin}`);
    const delivered = (mul(ask.spend, rate.rate, 'floor') / COIN_STEP) * COIN_STEP;
    if (delivered < ask.least)
      throw new BankError(
        `The partner now gives ${formatAmount(delivered)} ${ask.coin} for ${formatAmount(ask.spend)} ${ask.cash}, less than the ${formatAmount(ask.least)} priced. Nothing was moved; get a new price.`,
        'bank.cash_leg_rate_moved',
      );
    if (legs.size >= MAX_LEGS)
      throw new BankError('The partner bank is not answering. Nothing was sent or changed.', 'bank.partner_unavailable');
    const bank = bankOf(userId);
    // The cash leaves the person's main balance as one partner move under the leg's own key.
    const move = await bank.move({
      key: ask.key,
      from: { userId, assetId: ask.cash, spaceId: null },
      to: partnerPayoutsAccount(ask.cash),
      amount: ask.spend,
    });
    const leg: CashLeg = Object.freeze({
      key: ask.key,
      userId,
      cash: ask.cash,
      coin: ask.coin,
      paid: ask.spend,
      delivered,
      rate: rate.rate,
      venue: Object.freeze({ venueId: ask.venue.venueId, owner: ask.venue.owner.toLowerCase() }),
      state: 'sending',
      moveId: move.id,
      movedAt: move.movedAt,
      deliveredAt: null,
      label: bank.label,
      test: true,
    });
    legs.set(ask.key, leg);
    return finish(leg);
  }
}

/**
 * LOCAL TEST: the TEST partner pays the coin into the TEST venue by the venue's own deposit control, under a reference made
 * from the leg's key, so a payout asked again is credited once.
 */
export function testVenuePayout(baseUrl: string, fetcher: typeof fetch = fetch): CashLegPayout {
  const base = baseUrl.replace(/\/$/, '');
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`the TEST venue answered ${response.status}`);
    return response.json();
  };
  const venueInfo = z.object({ chainId: z.union([z.number(), z.string()]).optional() });
  return {
    async pay({ ref, venue, coin, amount }) {
      const info = venueInfo.parse(await call('/venue'));
      const tx = createHash('sha256').update(ref).digest('hex');
      await call('/test/deposit', {
        account: { venueId: venue.venueId, owner: venue.owner, subAccount: null },
        asset: coin,
        amount: formatAmount(amount),
        depositRef: `${String(info.chainId ?? 0)}:0x${tx}:0`,
      });
    },
  };
}

/**
 * The TEST cash leg the stack asked for: both values set, with the TEST partner, on dev or test only. Neither set: none.
 * One without the other, or either without the TEST partner or outside dev or test, refuses to start.
 */
export function testCashLegFor({
  rates,
  venueUrl,
  partner,
  env,
}: {
  readonly rates: string | undefined;
  readonly venueUrl: string | undefined;
  readonly partner: TestPartnerDoors | null;
  readonly env: { readonly APP_ENV?: string; readonly NODE_ENV?: string };
}): { readonly rates: readonly CashLegRate[]; readonly payout: CashLegPayout } | null {
  const parsed = parseCashLegRates(rates);
  const url = venueUrl?.trim() ?? '';
  if (!parsed && !url) return null;
  if (!parsed || !url) throw new Error('BANK_TEST_CASH_LEG_RATES and BANK_TEST_CASH_LEG_VENUE_URL are set together or not at all');
  if (!partner || !isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production')
    throw new Error('the TEST cash leg runs only with BANK_TEST_PARTNER=test on a dev or test stack');
  return { rates: parsed, payout: testVenuePayout(new URL(url).href) };
}

export const presentCashLeg = (leg: CashLeg) => ({
  legKey: leg.key,
  cash: leg.cash,
  coin: leg.coin,
  paid: formatAmount(leg.paid),
  delivered: formatAmount(leg.delivered),
  rate: formatAmount(leg.rate),
  venue: leg.venue,
  state: leg.state,
  moveId: leg.moveId,
  movedAt: leg.movedAt.toISOString(),
  deliveredAt: leg.deliveredAt?.toISOString() ?? null,
  label: leg.label,
  test: leg.test,
});

export const presentCashLegOffers = (o: CashLegOffers) => ({
  reason: o.reason,
  offers: o.offers.map((x) => ({
    cash: x.cash,
    coin: x.coin,
    rate: formatAmount(x.rate),
    available: x.available === null ? null : formatAmount(x.available),
    asOf: x.asOf.toISOString(),
    label: x.label,
    test: x.test,
  })),
});
