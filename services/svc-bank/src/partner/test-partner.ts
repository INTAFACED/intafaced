import { randomBytes } from 'node:crypto';
import { isExplicitDevOrTest } from '@intafaced/config';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  PARTNER_PAY_INS_OWNER,
  partnerPayInsAccount,
  PARTNER_PAYOUTS_OWNER,
  partnerPayoutsAccount,
  type PartnerAccountRef,
  type PartnerPayment,
  type PartnerPaymentRequest,
  type PartnerBalance,
  type PartnerBank,
  type PartnerMove,
  type PartnerMoveRequest,
  type PartnerMovesQuery,
} from './partner-bank.js';
import type { AccountDetailSet, AccountDetailsPartner } from '../account-details/account-details.js';
import type {
  PartnerCredit,
  PartnerPaidBy,
  PartnerPurchase,
  PartnerPurchaseHold,
  PartnerPurchaseHolds,
  PartnerPurchaseRelease,
  PartnerPurchases,
  PartnerReturn,
} from './partner-purchases.js';
import type {
  PartnerDirectDebitFailure,
  PartnerDirectDebitRefund,
  PartnerDirectDebitReport,
  PartnerDirectDebits,
  PartnerMandate,
  PartnerMandateLine,
} from './partner-direct-debits.js';
import {
  CLOSURE_PAYOUT_KEY,
  testPartnerCompliance,
  type PartnerCompliance,
  type TestPartnerComplianceDoors,
} from './partner-compliance.js';

/**
 * THE TEST PARTNER BANK AND THE TEST RAMP, AND THEY ARE TEST FIXTURES (CUSTODY-DELTA §4; OWNER 226).
 *
 * INTAFACED launches holding no customer money: accounts, spaces, pots and joint accounts are the partner's, and buying to
 * a wallet is the partner's ramp. No partner is named yet, so the local test stack stands one in, labelled TEST, with a
 * switch for each thing a real partner may not do or may not tell us (§1.3 "Unknown, never zero"):
 *
 *   bank: a feature "not offered by the partner" (currency accounts, spaces, pots, joint accounts); a fee that is not
 *         known; a reserve the partner requires of us, of an amount not known; the partner down.
 *   ramp: the partner's quote expired; the partner's fee not known.
 *   custody: `off` puts this person's bank money at the partner (OWNER 226): their balances are the partner's figures and
 *         a move is one partner instruction, with nothing posted to the ledger. `on` (the default) is the custodial
 *         layer, exactly as before, for the journeys marked Later. With it off, `nextReply: 'lost'` makes the next move
 *         and then loses the partner's answer once, so a retry under the same key can be shown to make one move.
 *
 * The switches are per person and live in this process only, so one journey's switch never reaches another's account,
 * and a restart puts every switch back off. They are set through the person's own `testPartner.set` on the TEST stack.
 *
 * Chosen (`BANK_TEST_PARTNER=test`) in a process whose raw `APP_ENV` is not exactly `dev` or `test`, or with
 * `NODE_ENV=production`, the service refuses to start, as `svc-pay`'s `rails/posture.ts` refuses sandbox rails. Off (the
 * default) there is no adapter and every switch read is "off": nothing changes.
 */
/** A payee list as one comparable string: the same recipients in the same order are the same instruction. */
function payeesKey(payees: PartnerMoveRequest['payees']): string {
  return payees ? JSON.stringify(payees.map((p) => [p.name, p.iban, p.amount.toString(), p.reference])) : '';
}

export const TEST_PARTNER_SETTINGS = ['off', 'test'] as const;
export type TestPartnerSetting = (typeof TEST_PARTNER_SETTINGS)[number];

export const TEST_PARTNER_LABEL = 'TEST partner bank';

/** The reason the TEST partner card declines with under `cardDecline: 'unlisted'`: a code nothing here has words for. */
export const TEST_PARTNER_UNLISTED_DECLINE = 'test_partner.unlisted_reason';

/**
 * TEST: how old the TEST partner bank says its figure may be before it is stale (b2 change 6). A real partner declares
 * its own; this TEST value stands in on test stacks only.
 */
export const TEST_PARTNER_STALE_AFTER_MS = 60_000;

/** The TEST partner's send limit and fee (J-bank-16 #6). Made up for test stacks; not an owner decision or a partner's price. */
export const TEST_PARTNER_DAILY_SEND = '1000';
export const TEST_PARTNER_SEND_FEE = '0.5';

/**
 * TEST: how long the TEST partner holds back a purchase paid through it before it can be withdrawn (J-wallet-01 #3), by
 * how it was paid. It holds back the whole purchase. Made up for test stacks; not a partner's terms or an owner decision.
 */
export const TEST_PURCHASE_HOLD_DAYS: Readonly<Record<PartnerPaidBy, number>> = Object.freeze({ card: 7, bank_pull: 3 });

/** The stand-in merchant a TEST payment at the partner goes to (`testPartner.spend`). It is on no person's list of balances. */
export const TEST_PARTNER_MERCHANT = 'partner:test-merchant';

/**
 * The TEST partner's statement rules (J-bank-23 #3), as a partner bank declares its own: it keeps 400 days of history, and a
 * statement reaching back further than 90 days asks for a fresh strong customer authentication. TEST values, on the
 * TEST partner only; a real partner states its own.
 */
export const TEST_PARTNER_HISTORY_DAYS = 400;
export const TEST_PARTNER_SCA_AFTER_DAYS = 90;

/** TEST: how long a TEST partner quote for a move between a person's own accounts stands (J-bank-24 #3). Not a partner's terms. */
export const TEST_PARTNER_QUOTE_MS = 60_000;

/** What a partner may not offer. `currencies` is the partner's currency accounts (J-bank-01 #3). */
export const PARTNER_FEATURES = ['currencies', 'spaces', 'pots', 'joint', 'phone_wallet'] as const;
export type PartnerFeature = (typeof PARTNER_FEATURES)[number];

export interface TestPartnerSwitches {
  /** Features the partner does not offer: each refuses `bank.not_offered_by_partner` before anything is written. */
  readonly notOffered: readonly PartnerFeature[];
  /** `unknown`: the partner does not say what a move costs; the fee reads "not known", never 0. */
  readonly fee: 'known' | 'unknown';
  /** `required`: the partner requires a reserve of us, and does not say how much; it reads "not known", never 0. */
  readonly reserve: 'none' | 'required';
  /**
   * The partner is not answering: every write to a currency account, space, pot or joint account, a send to a person,
   * and a standing order's create, change or resume refuses `bank.partner_unavailable`, nothing written. Freezing a
   * shared pot's card, and cancelling or pausing a standing order, stay open (they only protect), and a balance read
   * gives the last figure the partner gave for that account, with the partner's time for it, or "not known" when it
   * gave none: never a fresh figure stamped now.
   */
  readonly down: boolean;
  /**
   * The partner's balance figures (b2 change 6): `live` (the default) reports each with its time now; `stale` reports
   * each with a time older than the partner's limit (`TEST_PARTNER_STALE_AFTER_MS`); `unknown` reports none, with no
   * time, so every balance reads "not known", never 0.
   */
  readonly figures: 'live' | 'stale' | 'unknown';
  /** `expired`: the ramp says any quote it gave has expired when it is accepted. */
  readonly rampQuote: 'live' | 'expired';
  /** `unknown`: the ramp gives no fee, so no pay amount: the quote reads "not known" and nothing can be asked. */
  readonly rampFee: 'known' | 'unknown';
  /**
   * `off`: this person's money is partner-held (OWNER 226; B3's decision on project-state #1790). Bank balances are the
   * TEST partner bank's figures and moves are partner instructions; a card authorisation is held, captured, released and
   * refunded by the TEST partner card (`cards/partner-card-holds.ts`). INTAFACED's ledger posts nothing for either. `on`
   * (the default) runs the custodial layer exactly as before, for the journeys marked Later.
   */
  readonly custody: 'on' | 'off';
  /** `lost`: the partner makes this person's next move and its answer is lost, once; then it goes back to `answered`. */
  readonly nextReply: 'answered' | 'lost';
  /**
   * `expired`: the TEST partner card reports every hold of this person's that is still open as past its hold time, and
   * releases it, as a partner does when a merchant never captures. `live` (the default): a hold runs its TEST hold time.
   */
  readonly cardHold: 'live' | 'expired';
  /**
   * `unlisted`: the TEST partner card declines this person's next holds with a reason code of its own that INTAFACED has
   * no words for (`TEST_PARTNER_UNLISTED_DECLINE`), as a real partner may send one we have not seen (J-bank-14 #6: an
   * unknown code shows the raw code). `none` (the default): the partner declines only for its own figures.
   */
  readonly cardDecline: 'none' | 'unlisted';
  /**
   * `issued`: the partner has issued this person TEST account details, labelled TEST (J-bank-01 #6). `none`, the default,
   * is a stack with no banking partner for account details: every currency answers `rail.bank` and no number is shown.
   */
  readonly accountDetails: 'none' | 'issued';
  /**
   * `not_reported`: the partner does not report what it holds back of this person's purchases, so the app reads "not
   * reported by the partner", never nothing held. `reported` (the default) lists each hold with its release time.
   */
  readonly purchaseHolds: 'reported' | 'not_reported';
  /**
   * `expired`: the TEST partner reports every purchase hold of this person's that is still open as past its release time,
   * and releases it, once, as a partner does when the payment can no longer be reversed. `live` (the default): a hold runs
   * its TEST hold time (`TEST_PURCHASE_HOLD_DAYS`).
   */
  readonly purchaseHold: 'live' | 'expired';
  /**
   * `held`: the partner holds this person's bank account under a legal hold, so closing it refuses
   * `bank.closure_legal_hold` and a pending closure's payout waits (J-bank-17 #5). `none` (the default): no hold.
   */
  readonly legalHold: 'none' | 'held';
  /**
   * `not_accepted`: the partner does not accept our identity case from Verification, so onboarding asks for its own
   * check (J-bank-17 #1). `accepted` (the default): a person verified with us has the identity step done with our case.
   */
  readonly identityCase: 'accepted' | 'not_accepted';
  /**
   * `test`: the TEST partner carries this person's instant and ACH payments out (J-bank-24 #4), labelled TEST. `none`, the
   * default, is a stack with no bank rail: every payment answers `rail.bank` and nothing moves.
   */
  readonly bankRail: 'none' | 'test';
}

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
});

/** The partner's reserve as it reports it. An amount it has not told us is null, read as "not known", never 0. */
export type PartnerReserve = { readonly required: false } | { readonly required: true; readonly amount: null };

export interface TestPartnerFund {
  /** The business key of this TEST funding: the same id is the same funding, once. */
  readonly fundId: string;
  readonly assetId: string;
  readonly amount: Amount;
}

/** One person's page of the TEST partner's own book (`TestPartner.record`). */
export interface TestPartnerRecord {
  readonly accounts: readonly { readonly account: PartnerAccountRef; readonly amount: Amount }[];
  readonly moves: readonly PartnerMove[];
}

export interface TestPartner {
  readonly label: string;
  switches(userId: string): TestPartnerSwitches;
  /** Sets some switches for one person and returns them all. Unnamed switches keep their value. */
  set(userId: string, change: Partial<TestPartnerSwitches>): TestPartnerSwitches;
  /** The TEST partner bank's book: balances it reports and moves it makes. It holds no money. */
  readonly bank: PartnerBank;
  /**
   * Credits TEST money to the person's main balance at the TEST partner (the journey's "a partner account funded with
   * TEST money"). Once per `fundId`; the same id with another body refuses `bank.partner_move_conflict`.
   */
  fund(userId: string, funding: TestPartnerFund): PartnerBalance;
  /**
   * The TEST partner's own book for one person, as it keeps it: every account it holds for them with the amount in it,
   * and every move and pay-in on their record, oldest first. Read straight from the book, never through `bank`, so no
   * switch (down, unknown or stale figures) shapes it: it is what the partner holds, for a test to compare the app with.
   */
  record(userId: string): TestPartnerRecord;
  /** The TEST partner as the ramp's partner: it credits a paid purchase and reports what it holds back of it. */
  readonly purchases: PartnerPurchases;
  /** The TEST partner as the bank a direct debit collects from: it keeps each mandate's block (J-bank-06 #4). */
  readonly directDebits: PartnerDirectDebits;
  /**
   * The TEST partner's report of every direct debit it answers for, read straight from its book (J-bank-28 #4): each
   * mandate it knows with its state and block, each collection it refused with its own reason, and each refund it made.
   */
  directDebitReport(): PartnerDirectDebitReport;
  /**
   * The TEST partner gives a collected debit back under the scheme's refund guarantee (J-bank-28 #4): ONE move from its
   * outbound-payments account back to the account the collection came from, under `bank.dd.refund:<mandate>:<collection>`,
   * so asking again answers the same refund and the person is credited once. A collection it never moved refuses
   * `bank.dd_refund_not_collected`, nothing moved.
   */
  refundDirectDebit(userId: string, mandateId: string, collectionId: string): PartnerDirectDebitRefund;
  /** The TEST partner's compliance record of each person's bank account: onboarding, requests, reviews, closure, data (J-bank-17). */
  readonly compliance: PartnerCompliance & TestPartnerComplianceDoors;
  /**
   * The TEST partner reports a pending payment of the person's completed (J-bank-24 #5), and returns the payment as it now
   * stands. Asked again it reports the same change, the same version, as a partner's replayed notice does.
   */
  settlePayment(userId: string, paymentId: string): PartnerPayment;
}

/** The TEST partner's own reason code for a collection on a mandate the person blocked with it. */
export const TEST_PARTNER_DD_BLOCKED = 'test_partner.dd_mandate_blocked';

/** The prefix of a direct debit collection's partner move key (`direct-debits.ts` collectionPartnerKey). */
const DD_COLLECTION_KEY = 'bank.dd.collection:';

/** The mandate and collection a direct debit collection's partner key names, or null for any other move. */
function ddCollectionOf(key: string): { mandateId: string; collectionId: string } | null {
  if (!key.startsWith(DD_COLLECTION_KEY)) return null;
  const [mandateId, collectionId, ...rest] = key.slice(DD_COLLECTION_KEY.length).split(':');
  return mandateId && collectionId && rest.length === 0 ? { mandateId, collectionId } : null;
}

/**
 * The most people the adapter keeps switches for. The local stack signs up a few hundred per run; past this the oldest
 * person's switches go back to off, so a long-running stack never grows without bound.
 */
const MAX_PEOPLE = 10_000;

/**
 * The most moves the TEST book keeps. Past it a move refuses `bank.partner_unavailable` (nothing moves) rather than
 * forget one: money state is never evicted. A restart empties the book, as it puts every switch back off.
 */
const MAX_MOVES = 200_000;

function accountKey(ref: PartnerAccountRef): string {
  return `${ref.userId}|${ref.assetId}|${ref.spaceId ?? 'main'}`;
}

function sameAccount(a: PartnerAccountRef, b: PartnerAccountRef): boolean {
  return accountKey(a) === accountKey(b);
}

function partnerDown(): BankError {
  return new BankError('The partner bank is not answering. Nothing was sent or changed.', 'bank.partner_unavailable');
}

function moveConflict(key: string): BankError {
  return new BankError(`The partner already holds a different move under ${key}, so this one was not made.`, 'bank.partner_move_conflict');
}

export function testPartner(): TestPartner {
  const kept = new Map<string, TestPartnerSwitches>();
  /** Scaled bigint per partner account. An account the partner holds and nobody has paid into holds 0. */
  const held = new Map<string, bigint>();
  const byKey = new Map<string, PartnerMove>();
  /** Each person's moves, oldest first; a move between two people is on both lists. */
  const byPerson = new Map<string, PartnerMove[]>();
  const funds = new Map<string, { readonly userId: string; readonly assetId: string; readonly amount: Amount }>();
  /** Each purchase credited, by person and key: one key is one credit. */
  const purchased = new Map<string, PartnerCredit & { readonly assetId: string; readonly paidBy: PartnerPaidBy }>();
  /** Each person's purchase holds still open, and those released, oldest first. */
  const openHolds = new Map<string, PartnerPurchaseHold[]>();
  /** Each purchase returned, by person and key: one key is one return. */
  const returns = new Map<string, PartnerReturn>();
  const releasedHolds = new Map<string, PartnerPurchaseRelease[]>();
  /** Each mandate the person blocked with the partner, by person and mandate, with the partner's time for it. */
  const ddBlocks = new Map<string, Date>();
  /** Each mandate the partner knows, by person and mandate, with when it first heard of it (J-bank-28 #4). */
  const ddKnown = new Map<string, { readonly userId: string; readonly mandateId: string; readonly knownAt: Date }>();
  /** Each collection the partner refused, by person, mandate and collection: one collection is one refusal. */
  const ddFailures = new Map<string, PartnerDirectDebitFailure>();
  /** Each refund the partner made, by person, mandate and collection: one collection is refunded once. */
  const ddRefunds = new Map<string, PartnerDirectDebitRefund>();
  const knowMandate = (userId: string, mandateId: string) => {
    const key = `${userId}|${mandateId}`;
    if (!ddKnown.has(key) && ddKnown.size < MAX_MOVES) ddKnown.set(key, Object.freeze({ userId, mandateId, knownAt: new Date() }));
  };
  const ddRefused = (userId: string, mandateId: string, collectionId: string, code: string) => {
    knowMandate(userId, mandateId);
    const key = `${userId}|${mandateId}|${collectionId}`;
    if (!ddFailures.has(key) && ddFailures.size < MAX_MOVES) {
      ddFailures.set(key, Object.freeze({ userId, mandateId, collectionId, code, at: new Date() }));
    }
  };
  /** A collection's move the partner refuses for want of money is on its record as a refused collection. */
  const refusedForFunds = (request: PartnerMoveRequest) => {
    const dd = ddCollectionOf(request.key);
    if (dd) ddRefused(request.from.userId, dd.mandateId, dd.collectionId, 'bank.partner_insufficient_funds');
  };
  /** People whose bank account is closing or closed: no move in or out of it but a closure's payout (J-bank-17 #5). */
  const restricted = new Set<string>();
  let seq = 0;
  /**
   * Unique to this process, so a move reference is never reused after a restart: a note kept in svc-bank's database
   * against an earlier process's move must never attach to a new move with the same sequence number.
   */
  const boot = randomBytes(6).toString('hex');

  const switches = (userId: string) => kept.get(userId) ?? SWITCHES_OFF;
  const set = (userId: string, change: Partial<TestPartnerSwitches>): TestPartnerSwitches => {
    const next: TestPartnerSwitches = Object.freeze({
      ...(kept.get(userId) ?? SWITCHES_OFF),
      ...change,
      ...(change.notOffered ? { notOffered: Object.freeze([...new Set(change.notOffered)]) } : {}),
    });
    kept.delete(userId);
    kept.set(userId, next);
    if (kept.size > MAX_PEOPLE) kept.delete(kept.keys().next().value!);
    return next;
  };
  /** The last figure the partner gave for each account, for a read while it is down. Bounded with the switches. */
  const lastGiven = new Map<string, PartnerBalance>();
  /** The partner's answer to a funding it made: what the account now holds, with its time now, whatever `figures` says. */
  const funded = (account: PartnerAccountRef): PartnerBalance =>
    Object.freeze({ account, amount: held.get(accountKey(account)) ?? 0n, asOf: new Date(), label: TEST_PARTNER_LABEL });
  const report = (account: PartnerAccountRef): PartnerBalance => {
    const key = accountKey(account);
    const now = switches(account.userId);
    if (now.down) {
      const last = lastGiven.get(key);
      return last
        ? Object.freeze({ ...last, unavailable: true })
        : Object.freeze({ account, amount: null, asOf: null, label: TEST_PARTNER_LABEL, unavailable: true });
    }
    if (now.figures === 'unknown') return Object.freeze({ account, amount: null, asOf: null, label: TEST_PARTNER_LABEL });
    const asOf = now.figures === 'stale' ? new Date(Date.now() - 2 * TEST_PARTNER_STALE_AFTER_MS) : new Date();
    const given: PartnerBalance = Object.freeze({ account, amount: held.get(key) ?? 0n, asOf, label: TEST_PARTNER_LABEL });
    lastGiven.delete(key);
    lastGiven.set(key, given);
    if (lastGiven.size > MAX_PEOPLE * 4) lastGiven.delete(lastGiven.keys().next().value!);
    return given;
  };
  /** Releases, once, every open hold of the person's that the partner says is past its release time. */
  const releaseDue = (userId: string, now: Date) => {
    const open = openHolds.get(userId) ?? [];
    const expired = switches(userId).purchaseHold === 'expired';
    const due = open.filter((h) => expired || h.releaseAt.getTime() <= now.getTime());
    if (due.length === 0) return;
    openHolds.set(
      userId,
      open.filter((h) => !due.includes(h)),
    );
    const done = releasedHolds.get(userId) ?? [];
    for (const h of due) done.push(Object.freeze({ ...h, releasedAt: now }));
    releasedHolds.set(userId, done);
  };
  /** What the partner still holds back of a person's main balance in one currency. A space holds no purchase. */
  const heldBack = (account: PartnerAccountRef): bigint => {
    if (account.spaceId !== null) return 0n;
    releaseDue(account.userId, new Date());
    let sum = 0n;
    for (const h of openHolds.get(account.userId) ?? []) if (h.assetId === account.assetId) sum += h.amount;
    return sum;
  };
  /** A pay-in on the partner's record, listed only to a reader that asks for pay-ins; never under a move key. */
  const payIn = (account: PartnerAccountRef, key: string, amount: Amount): string => {
    seq += 1;
    const id = `test-partner-move-${boot}-${String(seq).padStart(12, '0')}`;
    const list = byPerson.get(account.userId) ?? [];
    list.push(
      Object.freeze({
        id,
        key,
        from: Object.freeze(partnerPayInsAccount(account.assetId)),
        to: Object.freeze({ ...account }),
        amount,
        movedAt: new Date(),
        label: TEST_PARTNER_LABEL,
      }),
    );
    byPerson.set(account.userId, list);
    return id;
  };
  const remember = (move: PartnerMove) => {
    byKey.set(move.key, move);
    for (const userId of new Set([move.from.userId, move.to.userId])) {
      const list = byPerson.get(userId) ?? [];
      list.push(move);
      byPerson.set(userId, list);
    }
  };

  const bank: PartnerBank = {
    label: TEST_PARTNER_LABEL,
    staleAfterMs: TEST_PARTNER_STALE_AFTER_MS,
    balance: async (account) => report(account),
    async balances(userId) {
      const out: PartnerBalance[] = [];
      for (const key of held.keys()) {
        const [owner, assetId, space] = key.split('|') as [string, string, string];
        if (owner === userId) out.push(report({ userId, assetId, spaceId: space === 'main' ? null : space }));
      }
      return out;
    },
    async move(request: PartnerMoveRequest) {
      // The partner deduplicates on the key first: a retry is answered with the move it made, even while it is down.
      const prior = byKey.get(request.key);
      if (prior) {
        if (
          !sameAccount(prior.from, request.from) ||
          !sameAccount(prior.to, request.to) ||
          prior.amount !== request.amount ||
          payeesKey(prior.payees) !== payeesKey(request.payees)
        ) {
          throw moveConflict(request.key);
        }
        return prior;
      }
      // The person whose switches apply: the source's owner, or, for an amount the partner gives back out of its own
      // outbound-payments account, the person it goes to.
      const person = request.from.userId === PARTNER_PAYOUTS_OWNER ? request.to.userId : request.from.userId;
      if (switches(person).down) throw partnerDown();
      if (!request.key.startsWith(CLOSURE_PAYOUT_KEY) && (restricted.has(request.from.userId) || restricted.has(request.to.userId))) {
        throw new BankError(
          'This bank account is closing or closed, so the partner bank makes no move in or out of it. Nothing was moved.',
          'bank.account_restricted',
        );
      }
      if (byKey.size >= MAX_MOVES) throw partnerDown();
      if (request.amount <= 0n) throw new BankError('A partner move needs an amount above zero.', 'bank.partner_amount_invalid');
      if (request.payees) {
        const sum = request.payees.reduce((total, p) => total + p.amount, 0n);
        if (request.payees.length === 0 || request.payees.some((p) => p.amount <= 0n) || sum !== request.amount) {
          throw new BankError('A payout’s recipients must add up to its amount exactly. Nothing was moved.', 'bank.partner_amount_invalid');
        }
      }
      if (request.from.assetId !== request.to.assetId) {
        throw new BankError('A partner move stays in one currency; convert first.', 'bank.asset_mismatch');
      }
      if (sameAccount(request.from, request.to)) throw new BankError('A transfer needs two different spaces', 'bank.same_space');
      const fromKey = accountKey(request.from);
      const has = held.get(fromKey) ?? 0n;
      if (has < request.amount) {
        refusedForFunds(request);
        throw new BankError(
          `The partner reports ${formatAmount(has)} ${request.from.assetId} in this account, less than ${formatAmount(request.amount)}. Nothing was moved.`,
          'bank.partner_insufficient_funds',
        );
      }
      // What the partner still holds back of a purchase stays where it is until its release time (J-wallet-01 #3).
      const back = heldBack(request.from);
      if (back > 0n && has - back < request.amount) {
        refusedForFunds(request);
        throw new BankError(
          `The partner holds back ${formatAmount(back)} ${request.from.assetId} of a purchase until its release time, so ${formatAmount(has - back)} can move now, less than ${formatAmount(request.amount)}. Nothing was moved.`,
          'bank.partner_insufficient_funds',
        );
      }
      // One step, nothing awaited: the debit, the credit and the record are made together or not at all.
      seq += 1;
      const move: PartnerMove = Object.freeze({
        id: `test-partner-move-${boot}-${String(seq).padStart(12, '0')}`,
        key: request.key,
        from: Object.freeze({ ...request.from }),
        to: Object.freeze({ ...request.to }),
        amount: request.amount,
        movedAt: new Date(),
        label: TEST_PARTNER_LABEL,
        ...(request.payees ? { payees: Object.freeze(request.payees.map((p) => Object.freeze({ ...p }))) } : {}),
      });
      held.set(fromKey, has - request.amount);
      held.set(accountKey(request.to), (held.get(accountKey(request.to)) ?? 0n) + request.amount);
      remember(move);
      if (switches(person).nextReply === 'lost') {
        set(person, { nextReply: 'answered' });
        throw new BankError(
          'The partner bank did not answer, so whether this move was made is not known. Try again with the same request: it is made at most once.',
          'bank.partner_reply_lost',
        );
      }
      return move;
    },
    moveByKey: async (key) => byKey.get(key) ?? null,
    async moves(userId: string, query: PartnerMovesQuery) {
      const list = byPerson.get(userId) ?? [];
      const out: PartnerMove[] = [];
      let passed = query.before === undefined;
      for (let i = list.length - 1; i >= 0 && out.length < query.limit; i -= 1) {
        const move = list[i]!;
        if (!passed) {
          if (move.id === query.before) passed = true;
          continue;
        }
        const payIn = move.from.userId === PARTNER_PAY_INS_OWNER || move.to.userId === PARTNER_PAY_INS_OWNER;
        if (payIn && query.payIns !== true) continue;
        if (query.assetId === undefined || move.from.assetId === query.assetId) out.push(move);
      }
      return out;
    },
    historyRules: Object.freeze({
      label: TEST_PARTNER_LABEL,
      historyDays: TEST_PARTNER_HISTORY_DAYS,
      scaAfterDays: TEST_PARTNER_SCA_AFTER_DAYS,
    }),
    // The partner's own statement, worked out from its book alone: the closing balance is what the account holds now less
    // every line after the period, the opening is the closing less the period's lines, and the count is the period's lines.
    async statement(account: PartnerAccountRef, range: { from: Date; to: Date }) {
      if (switches(account.userId).down) throw partnerDown();
      const key = accountKey(account);
      let closing = held.get(key) ?? 0n;
      let net = 0n;
      let lines = 0;
      for (const move of byPerson.get(account.userId) ?? []) {
        const signed = (sameAccount(move.to, account) ? move.amount : 0n) - (sameAccount(move.from, account) ? move.amount : 0n);
        if (!sameAccount(move.to, account) && !sameAccount(move.from, account)) continue;
        if (move.movedAt >= range.to) closing -= signed;
        else if (move.movedAt >= range.from) {
          net += signed;
          lines += 1;
        }
      }
      return Object.freeze({
        account: Object.freeze({ ...account }),
        label: TEST_PARTNER_LABEL,
        from: range.from,
        to: range.to,
        opening: closing - net,
        closing,
        lines,
        asOf: new Date(),
      });
    },
    async limits(userId, assetId) {
      const dayStart = new Date(new Date().toISOString().slice(0, 10)).getTime();
      let used = 0n;
      for (const move of byPerson.get(userId) ?? []) {
        // What the person sent today: money that left them, not a move between their own spaces.
        if (
          move.from.userId === userId &&
          move.to.userId !== userId &&
          move.from.assetId === assetId &&
          move.movedAt.getTime() >= dayStart
        ) {
          used += move.amount;
        }
      }
      return Object.freeze({
        assetId,
        label: TEST_PARTNER_LABEL,
        dailySend: parseAmount(TEST_PARTNER_DAILY_SEND),
        usedToday: used,
        sendFee: switches(userId).fee === 'known' ? parseAmount(TEST_PARTNER_SEND_FEE) : null,
        asOf: new Date(),
      });
    },
    // The partner's quote for a move between a person's own accounts (J-bank-24 #3). The TEST partner takes nothing for one,
    // and says so; with `fee: 'unknown'` it does not say, so the fee and what arrives read "not known", never 0.
    async quoteMove(request) {
      if (switches(request.from.userId).down) throw partnerDown();
      if (request.amount <= 0n) throw new BankError('A partner move needs an amount above zero.', 'bank.partner_amount_invalid');
      if (request.from.assetId !== request.to.assetId) {
        throw new BankError('A partner move stays in one currency; convert first.', 'bank.asset_mismatch');
      }
      if (sameAccount(request.from, request.to)) throw new BankError('A transfer needs two different spaces', 'bank.same_space');
      seq += 1;
      const quotedAt = new Date();
      const fee = switches(request.from.userId).fee === 'known' ? 0n : null;
      return Object.freeze({
        quoteId: `test-partner-quote-${boot}-${String(seq).padStart(12, '0')}`,
        from: Object.freeze({ ...request.from }),
        to: Object.freeze({ ...request.to }),
        amount: request.amount,
        fee,
        receives: fee === null ? null : request.amount - fee,
        quotedAt,
        validUntil: new Date(quotedAt.getTime() + TEST_PARTNER_QUOTE_MS),
        label: TEST_PARTNER_LABEL,
      });
    },
    // Payments out over the TEST partner's rails (J-bank-24 #4): only for a person whose switch says the partner carries
    // them (`bankRail: 'test'`); otherwise `rail.bank`, nothing moved. A payment is one partner move into the partner's
    // outbound-payments account under the payment's key, made pending; `settlePayment` completes it.
    payments: Object.freeze({
      async pay(request: PartnerPaymentRequest) {
        const prior = payments.get(request.key);
        if (prior) {
          const asked = paymentRequests.get(request.key)!;
          if (
            !sameAccount(asked.from, request.from) ||
            asked.amount !== request.amount ||
            asked.method !== request.method ||
            JSON.stringify(asked.recipient) !== JSON.stringify(request.recipient)
          ) {
            throw moveConflict(request.key);
          }
          return prior;
        }
        if (switches(request.from.userId).bankRail !== 'test') {
          throw new BankError(
            `An ${request.method === 'ach' ? 'ACH' : 'instant'} payment needs rail.bank. It is switched off in this build.`,
            'rail.bank',
          );
        }
        if (payments.size >= MAX_MOVES) throw partnerDown();
        await bank.move({ key: request.key, from: request.from, to: partnerPayoutsAccount(request.from.assetId), amount: request.amount });
        seq += 1;
        const made: PartnerPayment = Object.freeze({
          id: `test-partner-payment-${boot}-${String(seq).padStart(12, '0')}`,
          key: request.key,
          from: Object.freeze({ ...request.from }),
          method: request.method,
          amount: request.amount,
          state: 'pending',
          version: 1,
          previous: null,
          changedAt: new Date(),
          label: TEST_PARTNER_LABEL,
        });
        payments.set(request.key, made);
        paymentRequests.set(request.key, Object.freeze({ ...request, recipient: Object.freeze({ ...request.recipient }) }));
        return made;
      },
      paymentByKey: async (key: string) => payments.get(key) ?? null,
    }),
  };
  /** Each payment the TEST partner made, by key, as it stands now, and the request it was made on. */
  const payments = new Map<string, PartnerPayment>();
  const paymentRequests = new Map<string, PartnerPaymentRequest>();
  const settlePayment = (userId: string, paymentId: string): PartnerPayment => {
    const found = [...payments.values()].find((p) => p.id === paymentId && p.from.userId === userId);
    if (!found) throw new BankError('The TEST partner has no such payment of yours.', 'bank.payment_not_found');
    // Settled already: the partner reports the same change again, the same version, as a real partner's replay does.
    if (found.state !== 'pending') return found;
    const done: PartnerPayment = Object.freeze({
      ...found,
      state: 'completed',
      previous: 'pending',
      version: found.version + 1,
      changedAt: new Date(),
    });
    payments.set(found.key, done);
    return done;
  };

  const mandate = (userId: string, mandateId: string): PartnerMandate => {
    const blockedAt = ddBlocks.get(`${userId}|${mandateId}`) ?? null;
    return Object.freeze({
      mandateId,
      blocked: blockedAt !== null,
      blockedAt,
      refusalCode: blockedAt ? TEST_PARTNER_DD_BLOCKED : null,
      label: TEST_PARTNER_LABEL,
    });
  };
  const directDebits: PartnerDirectDebits = {
    label: TEST_PARTNER_LABEL,
    async block(userId, mandateId) {
      const key = `${userId}|${mandateId}`;
      if (!ddBlocks.has(key)) {
        if (switches(userId).down) throw partnerDown();
        if (ddBlocks.size >= MAX_MOVES) throw partnerDown();
        ddBlocks.set(key, new Date());
      }
      knowMandate(userId, mandateId);
      return mandate(userId, mandateId);
    },
    async unblock(userId, mandateId) {
      const key = `${userId}|${mandateId}`;
      if (ddBlocks.has(key)) {
        if (switches(userId).down) throw partnerDown();
        ddBlocks.delete(key);
      }
      return mandate(userId, mandateId);
    },
    async mandate(userId, mandateId, forCollection) {
      if (switches(userId).down) throw partnerDown();
      knowMandate(userId, mandateId);
      const answer = mandate(userId, mandateId);
      if (forCollection !== undefined && answer.blocked) ddRefused(userId, mandateId, forCollection, answer.refusalCode!);
      return answer;
    },
    async setUp(userId, mandateId) {
      if (switches(userId).down) throw partnerDown();
      knowMandate(userId, mandateId);
    },
  };

  const compliance = testPartnerCompliance({
    label: TEST_PARTNER_LABEL,
    bank,
    restrict: (userId, on) => {
      if (on) restricted.add(userId);
      else restricted.delete(userId);
    },
    identityCaseAccepted: (userId) => switches(userId).identityCase === 'accepted',
    legalHold: (userId) => switches(userId).legalHold === 'held',
  });

  return {
    label: TEST_PARTNER_LABEL,
    switches,
    set,
    bank,
    directDebits,
    directDebitReport() {
      const mandates: PartnerMandateLine[] = [...ddKnown.values()].map((m) => {
        const blockedAt = ddBlocks.get(`${m.userId}|${m.mandateId}`) ?? null;
        return Object.freeze({ ...m, state: blockedAt ? 'blocked' : 'active', blockedAt });
      });
      return Object.freeze({
        label: TEST_PARTNER_LABEL,
        asOf: new Date(),
        mandates,
        failures: [...ddFailures.values()],
        refunds: [...ddRefunds.values()],
      });
    },
    refundDirectDebit(userId, mandateId, collectionId) {
      const key = `${userId}|${mandateId}|${collectionId}`;
      const done = ddRefunds.get(key);
      if (done) return done;
      const collected = byKey.get(`${DD_COLLECTION_KEY}${mandateId}:${collectionId}`);
      if (!collected || collected.from.userId !== userId) {
        throw new BankError('The partner collected nothing on that debit, so there is nothing to refund.', 'bank.dd_refund_not_collected');
      }
      if (ddRefunds.size >= MAX_MOVES) throw partnerDown();
      // The partner's own move back, keyed so a retry is the same refund; it shares the move book's checks and record.
      const moved = byKey.get(`bank.dd.refund:${mandateId}:${collectionId}`);
      const back =
        moved ??
        (() => {
          seq += 1;
          const move: PartnerMove = Object.freeze({
            id: `test-partner-move-${boot}-${String(seq).padStart(12, '0')}`,
            key: `bank.dd.refund:${mandateId}:${collectionId}`,
            from: collected.to,
            to: collected.from,
            amount: collected.amount,
            movedAt: new Date(),
            label: TEST_PARTNER_LABEL,
          });
          const fromKey = accountKey(move.from);
          held.set(fromKey, (held.get(fromKey) ?? 0n) - move.amount);
          held.set(accountKey(move.to), (held.get(accountKey(move.to)) ?? 0n) + move.amount);
          remember(move);
          return move;
        })();
      const refund: PartnerDirectDebitRefund = Object.freeze({
        userId,
        mandateId,
        collectionId,
        assetId: back.to.assetId,
        amount: back.amount,
        moveId: back.id,
        refundedAt: back.movedAt,
      });
      ddRefunds.set(key, refund);
      return refund;
    },
    compliance,
    settlePayment,
    record(userId) {
      const accounts: { account: PartnerAccountRef; amount: Amount }[] = [];
      for (const [key, amount] of held) {
        const [owner, assetId, space] = key.split('|') as [string, string, string];
        if (owner === userId)
          accounts.push(Object.freeze({ account: Object.freeze({ userId, assetId, spaceId: space === 'main' ? null : space }), amount }));
      }
      return Object.freeze({ accounts: Object.freeze(accounts), moves: Object.freeze([...(byPerson.get(userId) ?? [])]) });
    },
    fund(userId, funding) {
      const account: PartnerAccountRef = { userId, assetId: funding.assetId, spaceId: null };
      // Per person: one person's fund id never collides with, or tells anything about, another's.
      const fundKey = `${userId}|${funding.fundId}`;
      const prior = funds.get(fundKey);
      if (prior) {
        if (prior.assetId !== funding.assetId || prior.amount !== funding.amount) {
          throw moveConflict(funding.fundId);
        }
        return funded(account);
      }
      if (switches(userId).down) throw partnerDown();
      if (restricted.has(userId)) {
        throw new BankError(
          'This bank account is closing or closed, so the partner bank takes no payment into it.',
          'bank.account_restricted',
        );
      }
      if (funding.amount <= 0n) throw new BankError('TEST funding needs an amount above zero.', 'bank.partner_amount_invalid');
      funds.set(fundKey, { userId, assetId: funding.assetId, amount: funding.amount });
      held.set(accountKey(account), (held.get(accountKey(account)) ?? 0n) + funding.amount);
      // On the partner's record as a pay-in, listed only to a reader that asks for pay-ins. Not under a move key: nobody
      // instructed it, so it can never answer `moveByKey` or conflict with a move.
      payIn(account, `pay-in:${fundKey}`, funding.amount);
      return funded(account);
    },
    purchases: {
      label: TEST_PARTNER_LABEL,
      async credit(userId: string, purchase: PartnerPurchase): Promise<PartnerCredit> {
        // Per person, like a funding: one person's purchase key never collides with another's.
        const creditKey = `${userId}|${purchase.key}`;
        const prior = purchased.get(creditKey);
        if (prior) {
          if (prior.assetId !== purchase.assetId || prior.amount !== purchase.amount || prior.paidBy !== purchase.paidBy) {
            throw moveConflict(purchase.key);
          }
          return { id: prior.id, key: prior.key, amount: prior.amount, hold: prior.hold };
        }
        if (switches(userId).down) throw partnerDown();
        if (purchase.amount <= 0n) throw new BankError('A purchase needs an amount above zero.', 'bank.partner_amount_invalid');
        const account: PartnerAccountRef = { userId, assetId: purchase.assetId, spaceId: null };
        // One step, nothing awaited: the credit, its record and its hold are made together or not at all.
        held.set(accountKey(account), (held.get(accountKey(account)) ?? 0n) + purchase.amount);
        const id = payIn(account, `pay-in:purchase:${creditKey}`, purchase.amount);
        const at = new Date();
        const hold: PartnerPurchaseHold = Object.freeze({
          id: `test-partner-hold-${boot}-${String(seq).padStart(12, '0')}`,
          purchaseKey: purchase.key,
          assetId: purchase.assetId,
          amount: purchase.amount,
          paidBy: purchase.paidBy,
          releaseAt: new Date(at.getTime() + TEST_PURCHASE_HOLD_DAYS[purchase.paidBy] * 86_400_000),
        });
        openHolds.set(userId, [...(openHolds.get(userId) ?? []), hold]);
        const credited = Object.freeze({
          id,
          key: purchase.key,
          amount: purchase.amount,
          hold,
          assetId: purchase.assetId,
          paidBy: purchase.paidBy,
        });
        purchased.set(creditKey, credited);
        return { id, key: purchase.key, amount: purchase.amount, hold };
      },
      async returned(userId: string, purchase: PartnerPurchase): Promise<PartnerReturn> {
        const creditKey = `${userId}|${purchase.key}`;
        const credited = purchased.get(creditKey);
        if (!credited || credited.assetId !== purchase.assetId || credited.amount !== purchase.amount) {
          throw moveConflict(purchase.key);
        }
        const prior = returns.get(creditKey);
        if (prior) return prior;
        if (switches(userId).down) throw partnerDown();
        const account: PartnerAccountRef = { userId, assetId: purchase.assetId, spaceId: null };
        const has = held.get(accountKey(account)) ?? 0n;
        if (has < purchase.amount) {
          throw new BankError(
            `The partner reports ${formatAmount(has)} ${purchase.assetId}, less than the ${formatAmount(purchase.amount)} sent back. Nothing was taken.`,
            'bank.partner_insufficient_funds',
          );
        }
        // One step, nothing awaited: the amount leaves the balance, the purchase's hold goes, and the return is kept.
        held.set(accountKey(account), has - purchase.amount);
        openHolds.set(
          userId,
          (openHolds.get(userId) ?? []).filter((h) => h.purchaseKey !== purchase.key),
        );
        seq += 1;
        const id = `test-partner-move-${boot}-${String(seq).padStart(12, '0')}`;
        const at = new Date();
        // On the partner's record as the pay-in going back to where it came from, listed with the pay-ins; never under a
        // move key, as nobody instructed it.
        const list = byPerson.get(userId) ?? [];
        list.push(
          Object.freeze({
            id,
            key: `pay-in:return:${creditKey}`,
            from: Object.freeze({ ...account }),
            to: Object.freeze(partnerPayInsAccount(purchase.assetId)),
            amount: purchase.amount,
            movedAt: at,
            label: TEST_PARTNER_LABEL,
          }),
        );
        byPerson.set(userId, list);
        const back: PartnerReturn = Object.freeze({ id, key: purchase.key, amount: purchase.amount, returnedAt: at });
        returns.set(creditKey, back);
        return back;
      },
      async holds(userId: string): Promise<PartnerPurchaseHolds> {
        const now = switches(userId);
        if (now.down) throw partnerDown();
        if (now.purchaseHolds === 'not_reported') return Object.freeze({ label: TEST_PARTNER_LABEL, reported: false as const });
        const at = new Date();
        releaseDue(userId, at);
        return Object.freeze({
          label: TEST_PARTNER_LABEL,
          reported: true as const,
          asOf: at,
          holds: Object.freeze([...(openHolds.get(userId) ?? [])]),
          released: Object.freeze([...(releasedHolds.get(userId) ?? [])]),
        });
      },
    },
  };
}

/** The partner custody the TEST partner decides: a person with `custody: 'off'` is held at it; everyone else, as before. */
export function testPartnerCustody(partner: TestPartner | null | undefined): { bankFor(userId: string): PartnerBank | null } {
  return { bankFor: (userId) => (partner && partner.switches(userId).custody === 'off' ? partner.bank : null) };
}

/** The TEST partner as the ramp's partner for a person it holds money for (`custody: 'off'`); none for anyone else. */
export function testPartnerPurchases(partner: TestPartner | null | undefined): { purchasesFor(userId: string): PartnerPurchases | null } {
  return { purchasesFor: (userId) => (partner && partner.switches(userId).custody === 'off' ? partner.purchases : null) };
}

/** The TEST partner as the bank a direct debit collects from, for a person it holds money for; none for anyone else. */
export function testPartnerDirectDebits(partner: TestPartner | null | undefined): {
  directDebitsFor(userId: string): PartnerDirectDebits | null;
} {
  return { directDebitsFor: (userId) => (partner && partner.switches(userId).custody === 'off' ? partner.directDebits : null) };
}

/** Why the service will not start with the adapter chosen. */
export class TestPartnerRefusedError extends Error {
  readonly code = 'bank.test_partner_outside_dev_test' as const;
  constructor() {
    super(
      'BANK_TEST_PARTNER=test is the TEST partner bank and ramp: it holds no money and stands in for no real partner; it runs only with APP_ENV exactly dev or test.',
    );
    this.name = 'TestPartnerRefusedError';
  }
}

/**
 * Total over the closed setting. `off` is no adapter. `test` is the adapter only in an explicit dev or test process,
 * and throws at boot otherwise: `env` is the RAW process env.
 */
export function testPartnerFor(
  setting: TestPartnerSetting,
  env: { readonly APP_ENV?: string; readonly NODE_ENV?: string },
): TestPartner | null {
  if (setting !== 'test') return null;
  if (!isExplicitDevOrTest(env.APP_ENV) || env.NODE_ENV === 'production') throw new TestPartnerRefusedError();
  return testPartner();
}

const FEATURE_WORDS: Record<PartnerFeature, string> = {
  currencies: 'currency accounts',
  spaces: 'spaces',
  pots: 'pots',
  joint: 'joint accounts and shared pots',
  phone_wallet: 'adding a card to a phone wallet',
};

/**
 * The partner-held door's check: the partner down refuses first, then a feature it does not offer. Without the adapter
 * nothing is refused here.
 */
export function assertPartnerOffers(partner: TestPartner | null | undefined, userId: string, feature: PartnerFeature): void {
  if (!partner) return;
  const now = partner.switches(userId);
  if (now.down) throw new BankError('The partner bank is not answering. Nothing was sent or changed.', 'bank.partner_unavailable');
  if (now.notOffered.includes(feature)) {
    throw new BankError(
      `Not offered by the partner: ${FEATURE_WORDS[feature]}. Nothing was sent or changed.`,
      'bank.not_offered_by_partner',
    );
  }
}

/**
 * The partner-down switch alone, for doors that move or schedule money but are not one of the partner's optional
 * features: a send to a person, and a standing order's create, change or resume. Cancel and pause stay open while it is
 * down, like freezing a card: they only stop money leaving.
 */
export function assertPartnerAnswering(partner: TestPartner | null | undefined, userId: string): void {
  if (partner?.switches(userId).down) {
    throw new BankError('The partner bank is not answering. Nothing was sent or changed.', 'bank.partner_unavailable');
  }
}

/** Whether the partner says what a move costs. Without the adapter the caller's own published fee stands. */
export function partnerFeeKnown(partner: TestPartner | null | undefined, userId: string): boolean {
  return !partner || partner.switches(userId).fee === 'known';
}

/** The reserve the partner requires of us, as it reports it. Without the adapter, null: no partner has said anything. */
export function partnerReserve(partner: TestPartner | null | undefined, userId: string): PartnerReserve | null {
  if (!partner) return null;
  return partner.switches(userId).reserve === 'required' ? { required: true, amount: null } : { required: false };
}

/**
 * The reserve the TEST partner bank requires of INTAFACED's programme, as it reports it: required, of an amount it has not
 * told us (J-ops-console-24 #1, the capital monitor's "not known"). The per-person `reserve` switch above is what one
 * person's partner account shows; this is the programme's, the same for everyone. Without the adapter, null: no partner
 * has said anything.
 */
export function programmeReserve(partner: TestPartner | null | undefined): PartnerReserve | null {
  if (!partner) return null;
  return { required: true, amount: null };
}

/** Whether the ramp says a quote it gave has expired, whatever its own time said. */
export function rampQuoteExpired(partner: TestPartner | null | undefined, userId: string): boolean {
  return !!partner && partner.switches(userId).rampQuote === 'expired';
}

/**
 * Whose book holds this person's money: `partner` when the TEST partner's custody switch is off for them, else the
 * custodial layer (`ledger`) when it is switched on, else nobody: `none`, which every customer-balance door refuses with
 * `bank.partner_unset` (no partner is set and INTAFACED holds no customer money). `custodyLayer` is the same switch
 * svc-ledger reads (`LEDGER_CUSTODY_LAYER`, `parseCustodyLayer`).
 */
export type MoneyHeldBy = 'ledger' | 'partner' | 'none';

export function moneyHeldBy(partner: TestPartner | null | undefined, userId: string, custodyLayer: 'on' | 'off'): MoneyHeldBy {
  if (partner && partner.switches(userId).custody === 'off') return 'partner';
  return custodyLayer === 'on' ? 'ledger' : 'none';
}

/** The refusal for `none`: no partner holds this person's money, and the custodial layer is switched off. */
export function partnerUnset(): BankError {
  return new BankError(
    'No partner is set to hold this money, and INTAFACED holds no customer money (the custodial layer is off). Nothing was sent or changed.',
    'bank.partner_unset',
  );
}

/** Refuses a ramp quote whose fee the ramp does not give: no fee, so no pay amount, and nothing is kept. */
export function assertRampFeeKnown(partner: TestPartner | null | undefined, userId: string): void {
  if (partner && partner.switches(userId).rampFee === 'unknown') {
    throw new BankError(
      'The partner gave no fee for this purchase, so what you would pay is not known. Nothing was kept or charged.',
      'bank.onramp_fee_not_known',
    );
  }
}

/**
 * The TEST partner's account details for one person, or none: with `accountDetails: 'issued'` the TEST partner answers
 * as a banking partner would, with one set per currency labelled TEST (its bank is the TEST partner bank, and every value
 * says TEST, so nothing reads as a real account); otherwise there is no partner and the service answers `rail.bank`.
 */
export function testPartnerAccountDetails(partner: TestPartner): (userId: string) => AccountDetailsPartner | undefined {
  const details = (userId: string, currency: string): AccountDetailSet => ({
    id: `test-partner:${userId}:${currency}`,
    accountNumber: `TEST-${currency}-${userId.replace(/-/g, '').toUpperCase()}`,
    sortCode: null,
    routingNumber: null,
    bsb: null,
    iban: null,
    bic: null,
    partnerBank: partner.label,
    restrictions: ['TEST details: no real account exists and nothing can be received'],
  });
  const issued = { state: 'done' as const };
  // The partner down answers nothing, as at every other partner-held door.
  const answer = async (userId: string, currency: string) => {
    assertPartnerAnswering(partner, userId);
    return { ...issued, sets: [details(userId, currency)] };
  };
  const issuer: AccountDetailsPartner = { detailsFor: answer, request: answer };
  return (userId) => (partner.switches(userId).accountDetails === 'issued' ? issuer : undefined);
}
