import { z } from 'zod';

/**
 * THE TEST PARTNER'S SWITCHES: the one place a switch is declared.
 *
 * Each switch is a thing a real partner may not do or may not tell us (CUSTODY-DELTA §1.3 "Unknown, never zero"), set per
 * person through the person's own `testPartner.set` on the TEST stack. A new switch is one entry in `testPartnerSwitches`
 * and its off value in `SWITCHES_OFF`: the type, the router's input and output and the default all come from here, and
 * the compiler refuses a switch with no off value. Its behaviour goes in the module of the partner capability it shapes
 * (`test-partner-book.ts`, `test-partner-purchases.ts`, `test-partner-direct-debits.ts`, `partner-compliance.ts`,
 * `cards/partner-card-holds.ts`), never in a list of its own.
 */

/** What a partner may not offer. `currencies` is the partner's currency accounts (J-bank-01 #3). */
export const PARTNER_FEATURES = ['currencies', 'spaces', 'pots', 'joint', 'phone_wallet'] as const;
export type PartnerFeature = (typeof PARTNER_FEATURES)[number];

export const testPartnerSwitches = z
  .object({
    /** Features the partner does not offer: each refuses `bank.not_offered_by_partner` before anything is written. */
    notOffered: z.array(z.enum(PARTNER_FEATURES)).max(PARTNER_FEATURES.length).readonly(),
    /** `unknown`: the partner does not say what a move costs; the fee reads "not known", never 0. */
    fee: z.enum(['known', 'unknown']),
    /** `required`: the partner requires a reserve of us, and does not say how much; it reads "not known", never 0. */
    reserve: z.enum(['none', 'required']),
    /**
     * The partner is not answering: every write to a currency account, space, pot or joint account, a send to a person,
     * and a standing order's create, change or resume refuses `bank.partner_unavailable`, nothing written. Freezing a
     * shared pot's card, and cancelling or pausing a standing order, stay open (they only protect), and a balance read
     * gives the last figure the partner gave for that account, with the partner's time for it, or "not known" when it
     * gave none: never a fresh figure stamped now.
     */
    down: z.boolean(),
    /**
     * The partner's balance figures (b2 change 6): `live` (the default) reports each with its time now; `stale` reports
     * each with a time older than the partner's limit (`TEST_PARTNER_STALE_AFTER_MS`); `unknown` reports none, with no
     * time, so every balance reads "not known", never 0.
     */
    figures: z.enum(['live', 'stale', 'unknown']),
    /** `expired`: the ramp says any quote it gave has expired when it is accepted. */
    rampQuote: z.enum(['live', 'expired']),
    /** `unknown`: the ramp gives no fee, so no pay amount: the quote reads "not known" and nothing can be asked. */
    rampFee: z.enum(['known', 'unknown']),
    /**
     * `off`: this person's money is partner-held: INTAFACED launches holding no customer money. Bank balances are the
     * TEST partner bank's figures and moves are partner instructions; a card authorisation is held, captured, released and
     * refunded by the TEST partner card (`cards/partner-card-holds.ts`). INTAFACED's ledger posts nothing for either. `on`
     * (the default) runs the custodial layer exactly as before, for the journeys marked Later.
     */
    custody: z.enum(['on', 'off']),
    /** `lost`: the partner makes this person's next move and its answer is lost, once; then it goes back to `answered`. */
    nextReply: z.enum(['answered', 'lost']),
    /**
     * `expired`: the TEST partner card reports every hold of this person's that is still open as past its hold time, and
     * releases it, as a partner does when a merchant never captures. `live` (the default): a hold runs its TEST hold time.
     */
    cardHold: z.enum(['live', 'expired']),
    /**
     * `unlisted`: the TEST partner card declines this person's next holds with a reason code of its own that INTAFACED has
     * no words for (`TEST_PARTNER_UNLISTED_DECLINE`), as a real partner may send one we have not seen (J-bank-14 #6: an
     * unknown code shows the raw code). `none` (the default): the partner declines only for its own figures.
     */
    cardDecline: z.enum(['none', 'unlisted']),
    /**
     * `issued`: the partner has issued this person TEST account details, labelled TEST (J-bank-01 #6). `none`, the default,
     * is a stack with no banking partner for account details: every currency answers `rail.bank` and no number is shown.
     */
    accountDetails: z.enum(['none', 'issued']),
    /**
     * `not_reported`: the partner does not report what it holds back of this person's purchases, so the app reads "not
     * reported by the partner", never nothing held. `reported` (the default) lists each hold with its release time.
     */
    purchaseHolds: z.enum(['reported', 'not_reported']),
    /**
     * `expired`: the TEST partner reports every purchase hold of this person's that is still open as past its release time,
     * and releases it, once, as a partner does when the payment can no longer be reversed. `live` (the default): a hold runs
     * its TEST hold time (`TEST_PURCHASE_HOLD_DAYS`).
     */
    purchaseHold: z.enum(['live', 'expired']),
    /**
     * `held`: the partner holds this person's bank account under a legal hold, so closing it refuses
     * `bank.closure_legal_hold` and a pending closure's payout waits (J-bank-17 #5). `none` (the default): no hold.
     */
    legalHold: z.enum(['none', 'held']),
    /**
     * `not_accepted`: the partner does not accept our identity case from Verification, so onboarding asks for its own
     * check (J-bank-17 #1). `accepted` (the default): a person verified with us has the identity step done with our case.
     */
    identityCase: z.enum(['accepted', 'not_accepted']),
    /**
     * `test`: the TEST partner carries this person's instant and ACH payments out (J-bank-24 #4), labelled TEST. `none`, the
     * default, is a stack with no bank rail: every payment answers `rail.bank` and nothing moves.
     */
    bankRail: z.enum(['none', 'test']),
    /**
     * The name the TEST partner holds this person's account in (J-bank-30), as a banking partner knows its account holder:
     * labelled TEST, set by the person on the TEST stack, so it never reads as a real person's account. null, the default,
     * is a holder name the partner has not given: the salary form is refused and every direct deposit to the account is
     * returned, as a name that cannot be matched.
     */
    holderName: z
      .string()
      .trim()
      .regex(/^TEST \P{Cc}{1,120}$/u)
      .nullable(),
    /**
     * `held`: the partner holds back its answer on every USDC pay-in to this person (J-bank-31 #6): a transfer it has seen
     * stays pending, "on its way", and is not credited or counted as spendable until the switch goes back to `answered`
     * (the default), when it is credited once.
     */
    payIn: z.enum(['answered', 'held']),
    /**
     * An asset id: the TEST partner reports one open TEST order of this person's reserving that currency (J-bank-01 #3: a
     * currency with an open order cannot be removed). null, the default, is no open order.
     */
    openOrder: z
      .string()
      .regex(/^[A-Z0-9]{2,16}$/)
      .nullable(),
  })
  .strict();

export type TestPartnerSwitches = Readonly<z.infer<typeof testPartnerSwitches>>;

/** Every switch off: what a person has until they set one, and what a restart puts back. */
export const SWITCHES_OFF: TestPartnerSwitches = Object.freeze({
  notOffered: Object.freeze([]) as readonly PartnerFeature[],
  fee: 'known',
  reserve: 'none',
  down: false,
  figures: 'live',
  rampQuote: 'live',
  rampFee: 'known',
  custody: 'on',
  nextReply: 'answered',
  cardHold: 'live',
  cardDecline: 'none',
  accountDetails: 'none',
  purchaseHolds: 'reported',
  purchaseHold: 'live',
  legalHold: 'none',
  identityCase: 'accepted',
  bankRail: 'none',
  holderName: null,
  payIn: 'answered',
  openOrder: null,
});

/**
 * The most people the adapter keeps switches for. The local stack signs up a few hundred per run; past this the oldest
 * person's switches go back to off, so a long-running stack never grows without bound.
 */
export const MAX_PEOPLE = 10_000;

export interface TestPartnerSwitchBoard {
  switches(userId: string): TestPartnerSwitches;
  /** Sets some switches for one person and returns them all. Unnamed switches keep their value. */
  set(userId: string, change: Partial<TestPartnerSwitches>): TestPartnerSwitches;
}

/** Each person's switches, in this process only: one journey's switch never reaches another's account. */
export function testPartnerSwitchBoard(): TestPartnerSwitchBoard {
  const kept = new Map<string, TestPartnerSwitches>();
  return {
    switches: (userId) => kept.get(userId) ?? SWITCHES_OFF,
    set(userId, change) {
      const next: TestPartnerSwitches = Object.freeze({
        ...(kept.get(userId) ?? SWITCHES_OFF),
        ...change,
        ...(change.notOffered ? { notOffered: Object.freeze([...new Set(change.notOffered)]) } : {}),
      });
      kept.delete(userId);
      kept.set(userId, next);
      if (kept.size > MAX_PEOPLE) kept.delete(kept.keys().next().value!);
      return next;
    },
  };
}
