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
import type { PartnerPurchases } from './partner-purchases.js';
import type { PartnerDirectDebitRefund, PartnerDirectDebitReport, PartnerDirectDebits } from './partner-direct-debits.js';
import {
  CLOSURE_PAYOUT_KEY,
  testPartnerCompliance,
  type PartnerCompliance,
  type TestPartnerComplianceDoors,
} from './partner-compliance.js';
import {
  accountKey,
  accountOf,
  MAX_MOVES,
  moveConflict,
  partnerDown,
  sameAccount,
  TEST_PARTNER_LABEL,
  testPartnerBook,
} from './test-partner-book.js';
import { MAX_PEOPLE, testPartnerSwitchBoard, type PartnerFeature, type TestPartnerSwitches } from './test-partner-switches.js';
import { testPartnerPurchaseDesk } from './test-partner-purchases.js';
import { testPartnerDirectDebitDesk } from './test-partner-direct-debits.js';

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
 * This file only composes the TEST partner: a switch is declared in `test-partner-switches.ts`, what the partner holds is
 * `test-partner-book.ts`, and each capability's behaviour lives in its own module (`test-partner-purchases.ts`,
 * `test-partner-direct-debits.ts`, `partner-compliance.ts`). A new capability gets a module of its own.
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
  /**
   * A payment from outside arrives in the person's main balance (J-bank-30: a salary credit by direct deposit): ONE pay-in
   * under `key`, on the partner's record and answering `moveByKey`, so the same key again answers the same credit and
   * another amount or account under it refuses `bank.partner_move_conflict`. Refuses `bank.partner_unavailable` when down
   * and `bank.account_restricted` on a closing account, nothing credited.
   */
  receive(account: PartnerAccountRef, key: string, amount: Amount): PartnerMove;
}

/**
 * The TEST partner as the rest of svc-bank holds it: its switches, record, ramp, direct debits and compliance doors, and
 * never its raw `bank`. A move at the partner goes through `BankRoot.custody`, which asks the posting freeze and the
 * operator's partner stop before each one (`freezeGuardedCustody`, `stopGuardedCustody`); a raw `bank.move` asks
 * neither (J-bank-16 `testPartner.spend`, 10 Nov; the agents usage payment until 16 Nov; the salary split and reversal
 * until 18 Nov). Only `composeBankRoot` takes the whole `TestPartner`, to build that custody.
 */
export type TestPartnerDoors = Omit<TestPartner, 'bank'>;

export function testPartner(): TestPartner {
  const { switches, set } = testPartnerSwitchBoard();
  const book = testPartnerBook();
  const { held, byKey, byPerson } = book;
  const funds = new Map<string, { readonly userId: string; readonly assetId: string; readonly amount: Amount }>();
  const purchaseDesk = testPartnerPurchaseDesk(book, switches);
  const debitDesk = testPartnerDirectDebitDesk(book, switches);
  /** People whose bank account is closing or closed: no move in or out of it but a closure's payout (J-bank-17 #5). */
  const restricted = new Set<string>();

  /** The last figure the partner gave for each account, for a read while it is down. Bounded with the switches. */
  const lastGiven = new Map<string, PartnerBalance>();
  /** The partner's answer to a funding it made: what the account now holds, with its time now, whatever `figures` says. */
  const funded = (account: PartnerAccountRef): PartnerBalance =>
    Object.freeze({ account, amount: book.amount(account), asOf: new Date(), label: TEST_PARTNER_LABEL });
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
    const given: PartnerBalance = Object.freeze({ account, amount: book.amount(account), asOf, label: TEST_PARTNER_LABEL });
    lastGiven.delete(key);
    lastGiven.set(key, given);
    if (lastGiven.size > MAX_PEOPLE * 4) lastGiven.delete(lastGiven.keys().next().value!);
    return given;
  };

  const bank: PartnerBank = {
    label: TEST_PARTNER_LABEL,
    staleAfterMs: TEST_PARTNER_STALE_AFTER_MS,
    balance: async (account) => report(account),
    async balances(userId) {
      const out: PartnerBalance[] = [];
      for (const key of held.keys()) {
        const account = accountOf(key);
        if (account.userId === userId) out.push(report(account));
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
      const has = book.amount(request.from);
      if (has < request.amount) {
        debitDesk.refusedForFunds(request);
        throw new BankError(
          `The partner reports ${formatAmount(has)} ${request.from.assetId} in this account, less than ${formatAmount(request.amount)}. Nothing was moved.`,
          'bank.partner_insufficient_funds',
        );
      }
      // What the partner still holds back of a purchase stays where it is until its release time (J-wallet-01 #3).
      const back = purchaseDesk.heldBack(request.from);
      if (back > 0n && has - back < request.amount) {
        debitDesk.refusedForFunds(request);
        throw new BankError(
          `The partner holds back ${formatAmount(back)} ${request.from.assetId} of a purchase until its release time, so ${formatAmount(has - back)} can move now, less than ${formatAmount(request.amount)}. Nothing was moved.`,
          'bank.partner_insufficient_funds',
        );
      }
      // One step, nothing awaited: the debit, the credit and the record are made together or not at all.
      const move: PartnerMove = Object.freeze({
        id: book.nextId('move'),
        key: request.key,
        from: Object.freeze({ ...request.from }),
        to: Object.freeze({ ...request.to }),
        amount: request.amount,
        movedAt: new Date(),
        label: TEST_PARTNER_LABEL,
        ...(request.payees ? { payees: Object.freeze(request.payees.map((p) => Object.freeze({ ...p }))) } : {}),
      });
      book.add(request.from, -request.amount);
      book.add(request.to, request.amount);
      book.remember(move);
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
      let closing = book.amount(account);
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
    async openOrders(userId) {
      const assetId = switches(userId).openOrder;
      return assetId === null ? [] : [Object.freeze({ id: `TEST-order:${userId}:${assetId}`, assetId, label: TEST_PARTNER_LABEL })];
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
      const quoteId = book.nextId('quote');
      const quotedAt = new Date();
      const fee = switches(request.from.userId).fee === 'known' ? 0n : null;
      return Object.freeze({
        quoteId,
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
        const made: PartnerPayment = Object.freeze({
          id: book.nextId('payment'),
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
    directDebits: debitDesk.directDebits,
    directDebitReport: debitDesk.report,
    refundDirectDebit: debitDesk.refund,
    compliance,
    settlePayment,
    record(userId) {
      const accounts: { account: PartnerAccountRef; amount: Amount }[] = [];
      for (const [key, amount] of held) {
        const account = accountOf(key);
        if (account.userId === userId) accounts.push(Object.freeze({ account: Object.freeze(account), amount }));
      }
      return Object.freeze({ accounts: Object.freeze(accounts), moves: Object.freeze([...(byPerson.get(userId) ?? [])]) });
    },
    receive(account, key, amount) {
      const prior = byKey.get(key);
      if (prior) {
        if (!sameAccount(prior.to, account) || prior.amount !== amount || prior.from.userId !== PARTNER_PAY_INS_OWNER) {
          throw moveConflict(key);
        }
        return prior;
      }
      if (switches(account.userId).down) throw partnerDown();
      if (restricted.has(account.userId)) {
        throw new BankError(
          'This bank account is closing or closed, so the partner bank takes no payment into it.',
          'bank.account_restricted',
        );
      }
      if (byKey.size >= MAX_MOVES) throw partnerDown();
      if (amount <= 0n) throw new BankError('A payment in needs an amount above zero.', 'bank.partner_amount_invalid');
      // One step, nothing awaited: the credit and its record are made together or not at all. The pay-ins account is the
      // outside world's, so nothing is taken from it.
      const move: PartnerMove = Object.freeze({
        id: book.nextId('move'),
        key,
        from: Object.freeze(partnerPayInsAccount(account.assetId)),
        to: Object.freeze({ ...account }),
        amount,
        movedAt: new Date(),
        label: TEST_PARTNER_LABEL,
      });
      book.add(account, amount);
      book.remember(move);
      return move;
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
      // Credited and on the partner's record as a pay-in, listed only to a reader that asks for pay-ins. Not under a move
      // key: nobody instructed it, so it can never answer `moveByKey` or conflict with a move.
      book.payIn(account, `pay-in:${fundKey}`, funding.amount);
      return funded(account);
    },
    purchases: purchaseDesk.purchases,
  };
}

/** The partner custody the TEST partner decides: a person with `custody: 'off'` is held at it; everyone else, as before. */
export function testPartnerCustody(partner: TestPartner | null | undefined): { bankFor(userId: string): PartnerBank | null } {
  return { bankFor: (userId) => (partner && partner.switches(userId).custody === 'off' ? partner.bank : null) };
}

/** The TEST partner as the ramp's partner for a person it holds money for (`custody: 'off'`); none for anyone else. */
export function testPartnerPurchases(partner: TestPartnerDoors | null | undefined): {
  purchasesFor(userId: string): PartnerPurchases | null;
} {
  return { purchasesFor: (userId) => (partner && partner.switches(userId).custody === 'off' ? partner.purchases : null) };
}

/** The TEST partner as the bank a direct debit collects from, for a person it holds money for; none for anyone else. */
export function testPartnerDirectDebits(partner: TestPartnerDoors | null | undefined): {
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
export function assertPartnerOffers(partner: TestPartnerDoors | null | undefined, userId: string, feature: PartnerFeature): void {
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
export function assertPartnerAnswering(partner: TestPartnerDoors | null | undefined, userId: string): void {
  if (partner?.switches(userId).down) {
    throw new BankError('The partner bank is not answering. Nothing was sent or changed.', 'bank.partner_unavailable');
  }
}

/** Whether the partner says what a move costs. Without the adapter the caller's own published fee stands. */
export function partnerFeeKnown(partner: TestPartnerDoors | null | undefined, userId: string): boolean {
  return !partner || partner.switches(userId).fee === 'known';
}

/** The reserve the partner requires of us, as it reports it. Without the adapter, null: no partner has said anything. */
export function partnerReserve(partner: TestPartnerDoors | null | undefined, userId: string): PartnerReserve | null {
  if (!partner) return null;
  return partner.switches(userId).reserve === 'required' ? { required: true, amount: null } : { required: false };
}

/**
 * The reserve the TEST partner bank requires of INTAFACED's programme, as it reports it: required, of an amount it has not
 * told us (J-ops-console-24 #1, the capital monitor's "not known"). The per-person `reserve` switch above is what one
 * person's partner account shows; this is the programme's, the same for everyone. Without the adapter, null: no partner
 * has said anything.
 */
export function programmeReserve(partner: TestPartnerDoors | null | undefined): PartnerReserve | null {
  if (!partner) return null;
  return { required: true, amount: null };
}

/** Whether the ramp says a quote it gave has expired, whatever its own time said. */
export function rampQuoteExpired(partner: TestPartnerDoors | null | undefined, userId: string): boolean {
  return !!partner && partner.switches(userId).rampQuote === 'expired';
}

/**
 * Whose book holds this person's money: `partner` when the TEST partner's custody switch is off for them, else the
 * custodial layer (`ledger`) when it is switched on, else nobody: `none`, which every customer-balance door refuses with
 * `bank.partner_unset` (no partner is set and INTAFACED holds no customer money). `custodyLayer` is the same switch
 * svc-ledger reads (`LEDGER_CUSTODY_LAYER`, `parseCustodyLayer`).
 */
export type MoneyHeldBy = 'ledger' | 'partner' | 'none';

export function moneyHeldBy(partner: TestPartnerDoors | null | undefined, userId: string, custodyLayer: 'on' | 'off'): MoneyHeldBy {
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
export function assertRampFeeKnown(partner: TestPartnerDoors | null | undefined, userId: string): void {
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
export function testPartnerAccountDetails(partner: TestPartnerDoors): (userId: string) => AccountDetailsPartner | undefined {
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

/**
 * Whose TEST account details an id names (J-bank-30: the payroll network credits details by their id), or null: an id
 * the TEST partner did not issue, or details of a person it no longer issues them to (`accountDetails` switched back to
 * `none`). The id is the one `testPartnerAccountDetails` gives.
 */
export function testPartnerDetailsOwner(partner: TestPartnerDoors, detailsId: string): { userId: string; currency: string } | null {
  const found = /^test-partner:([^:]{1,64}):([A-Z]{3})$/.exec(detailsId);
  const userId = found?.[1];
  const currency = found?.[2];
  if (!userId || !currency) return null;
  return partner.switches(userId).accountDetails === 'issued' ? { userId, currency } : null;
}
