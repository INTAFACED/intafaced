import { sum, type Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { insuranceFund, merchantClearing, merchantProceeds, railBoundary, userAvailable } from '../accounts.js';

/**
 * CHARGEBACK RECIPES (§6.1 · pay.fraud).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ⚠ OWNER SIGN-OFF REQUIRED BEFORE MERGE — DIRECTION §3 CLASS M CARVE-OUT.  ║
 * ║                                                                           ║
 * ║ A new ledger recipe is money law. This file is DESIGNED, WRITTEN and       ║
 * ║ TESTED so the owner has something concrete to say yes or no to, and it is  ║
 * ║ deliberately NOT WIRED: nothing in svc-pay calls any of it, so landing it  ║
 * ║ moves no value anywhere. The signature the owner is being asked for is on  ║
 * ║ four questions, each answered in a section below:                          ║
 * ║                                                                           ║
 * ║   1. WHO IS DEBITED when a chargeback lands.        → `chargebackOpen`     ║
 * ║   2. WHERE THE LOSS SITS when they cannot pay.      → `chargebackShortfall`║
 * ║   3. WHAT HAPPENS WHEN THE BACKSTOP IS ALSO EMPTY.  → it FAILS, on purpose ║
 * ║   4. HOW THE MONEY COMES BACK if we win.            → `chargebackWon`      ║
 * ║                                                                           ║
 * ║ No EXISTING recipe is modified by this change.                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY THIS FILE HAD TO EXIST BEFORE ANY CARD RAIL DOES ────────────────────
 *
 * `docs/adr/2026-08-04-pay-rails-and-psp-socket.md` (Accepted): *"There is no
 * chargeback recipe and no `disputes` table. A card rail's most characteristic
 * event has no compensating entry to post. The `disputed` status exists in the
 * transition map as a dead end with no writer. Until a chargeback can be posted,
 * a card rail cannot be honest about what it did — which is a §0.6 problem after
 * all, arriving from the direction nobody was watching."*
 *
 * Its done bar for `pay.rails`, clause 3: *"A chargeback recipe exists in
 * `packages/ledger-client` before any rail can report a dispute."*
 *
 * ── A CHARGEBACK IS NOT A REFUND, AND THE DIFFERENCE IS THE WHOLE DESIGN ────
 *
 * `paymentRefund` already moves value from a merchant back out through the rail.
 * The postings look similar. Three facts make them different recipes rather than
 * one with a flag, and every one of them changes what the ledger must record:
 *
 *   · A REFUND IS OURS. The merchant chose it, svc-pay initiates it, and the
 *     rail can REFUSE it — which is why `paymentRefundReverse` exists to put the
 *     value back. A chargeback is THEIRS. The payer's bank has already taken the
 *     money before we hear about it. There is nothing to attempt and nothing to
 *     reverse; the only open question is whose balance the hole is in.
 *
 *   · A REFUND CANNOT OVERDRAW ANYONE. If the merchant's balance will not cover
 *     it, the post fails and no refund goes out — the correct outcome, because
 *     we simply do not send it. A chargeback has already gone out. Failing the
 *     post does not un-take the money; it only leaves the book unable to say
 *     where the money went. So a chargeback needs somewhere for the loss to sit
 *     when the merchant cannot cover it, and a refund never does.
 *
 *   · THE IDEMPOTENCY KEY IS THE DISPUTE, NOT THE PAYMENT. One charge can be
 *     disputed more than once — a second presentment, an arbitration after a won
 *     representment. Keying on the payment would make the second dispute find
 *     the first's transaction, return it, and silently book nothing at all for a
 *     second removal of real money. `RailEvent.disputeId` is separate from
 *     `railRef` for exactly this reason, and these keys follow it.
 *
 * ── THE SEQUENCE ────────────────────────────────────────────────────────────
 *
 *   chargebackOpen               merchant (clearing and/or balance) → rail
 *   chargebackShortfall          insurance fund                     → rail
 *   chargebackWon                rail → merchant, in the same proportions
 *   chargebackShortfallRecovered rail → insurance fund
 *
 * `lost`, `accepted` and `expired` post NOTHING FURTHER. That is not an omission.
 * The money left at `chargebackOpen`, when the payer's bank took it; the three
 * terminal statuses record which way the argument went, and an argument is not a
 * movement. A recipe for "we lost" would double-debit the merchant.
 *
 * ── THE HONEST LIMIT OF A RECIPE, STATED ONCE ───────────────────────────────
 *
 * A recipe is a pure function with no reading of the world. It cannot check that
 * `chargebackOpen` + `chargebackShortfall` sum to what the bank actually took,
 * because it has never seen the dispute. That check belongs to svc-pay, against
 * the `RailDispute.amount` the rail reported. `loanCollateralRelease` states the
 * same limit about the same class of precondition, and for the same reason.
 */

/**
 * The same two one-line helpers every other recipe file declares locally.
 *
 * `credit` is the SOURCE and `debit` is the DESTINATION, which reads backwards
 * to anyone who has done bookkeeping and is the convention every recipe in this
 * package already uses. Restated here because a chargeback is the one movement
 * where getting it backwards produces a posting that still balances: it would
 * credit a merchant with money the payer's bank had just taken from them.
 */
const debit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: AccountRef, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function requireNonNegative(name: string, value: Amount): void {
  if (value < 0n) throw new InvalidEntryError(`${name} cannot be negative`);
}

// ── 1 · WHO IS DEBITED ───────────────────────────────────────────────────────

export interface ChargebackInput {
  /**
   * THE RAIL'S DISPUTE ID — the business key for everything in this file.
   *
   * Not the payment id and not the charge reference. See the note above: one
   * charge can be disputed twice, and keying on the charge loses the second.
   */
  disputeId: string;
  /** The payment being disputed. Recorded in meta; never part of a key. */
  paymentId: string;
  merchantId: string;
  /**
   * The owner's trading balance. The settled leg uses it only when `settledPot`
   * is `user` (that payment's settlement post debited `userAvailable`).
   */
  merchantUserId: string;
  assetId: string;
  /** The rail the original payment arrived on. Value goes back out through it. */
  rail: string;

  /**
   * Taken from value the merchant has NOT been settled yet.
   *
   * The first place to look, and not merely by convention: pre-settlement value
   * is in `pay:clearing:<merchantId>`, which is a `module` account the merchant
   * cannot spend. Taking a chargeback from there costs them nothing they could
   * have used, and cannot fail because of something they did in the meantime.
   */
  fromClearing: Amount;

  /**
   * Taken from the merchant's SETTLED proceeds.
   *
   * This is the leg that can fail, and it is the interesting one. Once
   * settlement has run, the money is in proceeds and a payout may have sent it
   * out. Proceeds is a `module` account, hard non-negative, so a merchant who
   * no longer has it makes this post FAIL rather than pushing the balance
   * below zero or taking the shortfall from the owner's trading balance.
   *
   * That failure is correct and it is the point at which svc-pay must decide
   * between calling this with less and covering the rest through
   * `chargebackShortfall`. What it must NOT do is force the debit through
   * against an account type that tolerates going negative — that would file a
   * platform loss as a merchant receivable, and the two are not the same fact.
   */
  fromMerchantBalance: Amount;
  /**
   * Where the settled leg sits. Omitted means proceeds. `user` is the
   * pre-cutover pot for a payment whose settlement post debited `userAvailable`.
   * The idempotency key is unchanged; a replay must name the same pot the
   * booked transaction used.
   */
  settledPot?: 'proceeds' | 'user';
}

function settledLeg(input: ChargebackInput): AccountRef {
  return input.settledPot === 'user'
    ? userAvailable(input.merchantUserId, input.assetId)
    : merchantProceeds(input.merchantId, input.assetId);
}

function chargebackTotal(input: ChargebackInput, label: string): Amount {
  requireNonNegative('clearing leg', input.fromClearing);
  requireNonNegative('merchant balance leg', input.fromMerchantBalance);
  const total = sum([input.fromClearing, input.fromMerchantBalance]);
  requirePositive(label, total);
  return total;
}

/**
 * THE CHARGEBACK LANDS. The payer's bank has taken the money; the book records
 * that it has gone, and whose it was.
 *
 * ── WHY THE SPLIT IS THE CALLER'S AND NOT THE RECIPE'S ──────────────────────
 *
 * The obvious API is one `amount` and a `source: 'clearing' | 'settled'`, which
 * is what `paymentRefund` takes. It is wrong here. A refund is sized by the
 * merchant and can simply be refused if the chosen pot is short. A chargeback is
 * sized by somebody else and has already happened, so the common real case is
 * that it spans both pots — part of it covered by a window that has not settled
 * yet, the rest out of a balance the merchant has been spending from. Forcing
 * one pot would either fail a chargeback the merchant could actually cover, or
 * require two postings for one removal of money and leave a reader unable to see
 * that they were the same event.
 *
 * So both legs are explicit, both are `Amount`, and svc-pay computes them from
 * balances it can actually read. A wrong split does not half-settle: the ledger
 * refuses the whole transaction.
 *
 * ── WHAT `amount` IS, AND WHY THERE ISN'T ONE ───────────────────────────────
 *
 * There is deliberately no `amount` field. The total is the sum of the legs, so
 * there is no way to pass a total that disagrees with the parts — the class of
 * bug `loanLiquidate` has to check for explicitly, removed by construction
 * instead. What the BANK took is a different number, it lives on
 * `RailDispute.amount`, and reconciling the two is svc-pay's job because only
 * svc-pay has both.
 */
export function chargebackOpen(input: ChargebackInput): PostRequest {
  const total = chargebackTotal(input, 'chargeback amount');

  const entries: EntryInput[] = [
    ...(input.fromClearing > 0n ? [credit(merchantClearing(input.merchantId, input.assetId), input.fromClearing)] : []),
    ...(input.fromMerchantBalance > 0n ? [credit(settledLeg(input), input.fromMerchantBalance)] : []),
    debit(railBoundary(input.rail, input.assetId), total),
  ];

  return {
    idempotencyKey: `pay.chargeback.open:${input.disputeId}`,
    module: 'pay',
    reason: 'pay.chargeback.opened',
    meta: {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      rail: input.rail,
      // Both legs in meta, because `chargebackWon` has to return the value to
      // the same pots in the same proportions, and this is where it reads them.
      fromClearing: input.fromClearing.toString(),
      fromMerchantBalance: input.fromMerchantBalance.toString(),
    },
    entries,
  };
}

// ── 2 · WHERE THE LOSS SITS ──────────────────────────────────────────────────

export interface ChargebackShortfallInput {
  disputeId: string;
  paymentId: string;
  merchantId: string;
  assetId: string;
  rail: string;
  /** What the merchant could not cover. Scaled bigint. */
  amount: Amount;
}

/**
 * THE LOSS, NAMED — the part of a chargeback the merchant's balance could not
 * cover, taken from the insurance fund.
 *
 * ── AND WHEN THE FUND IS EMPTY THIS FAILS. THAT IS THE POINT. ───────────────
 *
 * `loanBadDebt` is the model and the precedent is exact: *"A platform that
 * cannot name where a loss came from should not be able to absorb it silently;
 * an operator seeing this refuse is an operator who has learned something true
 * on the day it became true."*
 *
 * `insuranceFund` is a `house` account, and §4.2's database CHECK makes every
 * non-treasury account hard non-negative. So a fund with 100 USDT in it cannot
 * absorb a 150 USDT chargeback: the post fails with insufficient funds, loudly,
 * on the money path, at the moment the platform's actual exposure exceeds the
 * backstop it has funded. There is no branch here that makes it succeed.
 *
 * ── WHY NOT JUST LET THE RAIL BOUNDARY GO NEGATIVE ──────────────────────────
 *
 * It already can — `treasury` accounts are the one owner type allowed to run
 * negative, and a negative rail boundary is exactly the platform's obligation to
 * the outside world. So a chargeback with no counter-leg at all would balance,
 * post cleanly, and leave the boundary more negative than custody says it should
 * be. Nothing would error. The reconciliation identity would quietly stop
 * holding, and the ONLY evidence that a loss had occurred would be a number that
 * looks exactly like an ordinary payout in flight.
 *
 * That is the failure mode this recipe removes. The loss gets a name, a source
 * account, and a posting an operator can query — and if there is nothing behind
 * the name, the platform finds out on the day rather than at the next audit.
 *
 * ── WHY THE INSURANCE FUND AND NOT HOUSE FEE REVENUE ────────────────────────
 *
 * `houseFees('pay')` is revenue, and revenue is not a backstop: draining it to
 * cover a chargeback makes a loss look like a bad month for the fee line, which
 * is precisely the "absorb it silently" the doctrine forbids. The insurance fund
 * already exists for exactly this in §5.2, is already the sink `loanBadDebt`
 * uses, and has to be deliberately funded — so its balance is a statement about
 * how much loss the platform has decided it can carry, which is what an operator
 * needs to know before a card rail is ever pointed at real money.
 *
 * WHETHER A MERCHANT THEN OWES US THIS BACK IS NOT DECIDED HERE. That is a
 * receivable, a commercial policy, and an owner call. This recipe records that
 * the platform paid; it does not invent a debt.
 */
export function chargebackShortfall(input: ChargebackShortfallInput): PostRequest {
  requirePositive('chargeback shortfall', input.amount);
  return {
    idempotencyKey: `pay.chargeback.shortfall:${input.disputeId}`,
    module: 'pay',
    reason: 'pay.chargeback.shortfall.covered',
    meta: {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      rail: input.rail,
    },
    entries: [credit(insuranceFund(input.assetId), input.amount), debit(railBoundary(input.rail, input.assetId), input.amount)],
  };
}

// ── 4 · HOW THE MONEY COMES BACK ─────────────────────────────────────────────

/**
 * WE WON THE REPRESENTMENT. The value returns from the rail to the pots it was
 * taken from, in the proportions it was taken in.
 *
 * A separate transaction rather than an amendment, because a ledger reverses; it
 * does not amend. Both postings stay in the journal and the trail reads "they
 * took it, we argued, we got it back" — which is also the only way an operator
 * can ever compute a true dispute win rate.
 *
 * THE SAME LEGS, DELIBERATELY. Returning a won chargeback entirely to the
 * merchant's spendable balance would be the intuitive thing and would be wrong:
 * value that was taken out of an unsettled window belongs back in that window,
 * where the settlement fee has not been applied to it yet. Paying it straight to
 * `available` would settle it at zero fee and make the merchant's clearing
 * balance permanently understate what we owe them. `chargebackOpen` writes both
 * legs into `meta` so this call has somewhere true to read them from.
 *
 * IF THE INSURANCE FUND COVERED PART OF IT, the fund is made whole through
 * `chargebackShortfallRecovered` and NOT through this recipe. Ordering matters
 * and it is svc-pay's to enforce: the fund advanced value it never owed, so it
 * is repaid before the merchant sees any of the recovery. A recipe cannot check
 * that, because it cannot see the other posting.
 */
export function chargebackWon(input: ChargebackInput): PostRequest {
  const total = chargebackTotal(input, 'recovered chargeback amount');

  const entries: EntryInput[] = [
    credit(railBoundary(input.rail, input.assetId), total),
    ...(input.fromClearing > 0n ? [debit(merchantClearing(input.merchantId, input.assetId), input.fromClearing)] : []),
    ...(input.fromMerchantBalance > 0n ? [debit(settledLeg(input), input.fromMerchantBalance)] : []),
  ];

  return {
    idempotencyKey: `pay.chargeback.won:${input.disputeId}`,
    module: 'pay',
    reason: 'pay.chargeback.won',
    meta: {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      rail: input.rail,
      fromClearing: input.fromClearing.toString(),
      fromMerchantBalance: input.fromMerchantBalance.toString(),
    },
    entries,
  };
}

/**
 * The insurance fund is made whole for a chargeback it covered and we later won.
 *
 * Its own recipe and its own key, rather than a third leg on `chargebackWon`,
 * because the fund being repaid is a different fact from the merchant being
 * repaid and the two do not always both happen: a dispute can be won after the
 * merchant has already been closed, in which case the fund is repaid and there
 * is nobody left to credit. Fusing them would make that case unpostable.
 */
export function chargebackShortfallRecovered(input: ChargebackShortfallInput): PostRequest {
  requirePositive('recovered shortfall', input.amount);
  return {
    idempotencyKey: `pay.chargeback.shortfall.recovered:${input.disputeId}`,
    module: 'pay',
    reason: 'pay.chargeback.shortfall.recovered',
    meta: {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      rail: input.rail,
    },
    entries: [credit(railBoundary(input.rail, input.assetId), input.amount), debit(insuranceFund(input.assetId), input.amount)],
  };
}
