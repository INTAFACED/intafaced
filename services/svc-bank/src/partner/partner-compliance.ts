import { createHash } from 'node:crypto';
import type { KycTier } from '@intafaced/config';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { partnerPayoutsAccount, type PartnerAccountRef, type PartnerBank } from './partner-bank.js';

/**
 * THE PARTNER'S COMPLIANCE RECORD OF A BANK ACCOUNT (BK-acct-05, BK-acct-06; J-bank-17).
 *
 * The partner bank holds a person's bank account at launch, under its licence, so it is the partner that onboards them,
 * asks them for information, runs their periodic reviews, closes the account and answers a data-rights request about
 * it. svc-bank is the person's way to it: it reads what the partner asks and passes on what the person answers. Our own
 * identity case from Verification is offered to the partner, and counts only where the partner accepts it.
 *
 * Closure: a balance makes the account restricted while the closure is pending (no move in or out but the closure's own
 * payout) and needs a destination for the balance; the account closes only once the partner reports the balance paid
 * out to it. A legal hold refuses closure. The ledger posts nothing for any of it: the money is the partner's to pay.
 *
 * No partner is named, so the only implementation is the TEST partner's (`testPartnerCompliance`), labelled TEST.
 */

export type ComplianceStepStatus = 'done' | 'open';

export interface OnboardingStep {
  readonly id: 'identity' | 'information';
  readonly title: string;
  readonly status: ComplianceStepStatus;
  /** For the identity step: done with our own identity case from Verification because the partner accepts it. */
  readonly doneWith: 'identity_case' | null;
}

export interface PartnerOnboarding {
  readonly label: string;
  readonly steps: readonly OnboardingStep[];
  /** The partner's own requirements for holding an account, as it states them. */
  readonly requirements: readonly string[];
  /** Our identity case from Verification: the person's tier, and whether the partner accepts it in place of its own check. */
  readonly identityCase: { readonly tier: KycTier; readonly accepted: boolean };
  readonly complete: boolean;
}

export interface UploadedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
}

export interface InfoRequest {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly openedAt: Date;
  /** The partner's deadline for an answer. */
  readonly dueAt: Date;
  readonly status: 'open' | 'under_review';
  readonly answeredAt: Date | null;
  readonly file: UploadedFile | null;
  readonly label: string;
}

export interface PeriodicReview {
  readonly id: string;
  readonly title: string;
  readonly dueAt: Date;
  /** What the partner does if the review is not answered by its due date, in its words. */
  readonly missedEffect: string;
  readonly status: 'open' | 'answered';
  readonly answeredAt: Date | null;
  readonly label: string;
}

export interface ClosureDestination {
  readonly name: string;
  readonly accountRef: string;
}

export interface ClosureBalance {
  readonly assetId: string;
  readonly spaceId: string | null;
  readonly amount: Amount;
}

export interface PartnerClosure {
  readonly id: string;
  readonly state: 'pending' | 'closed' | 'reopened';
  readonly requestedAt: Date;
  /** Every balance the account held when closure was asked, paid out to `destination` before it closes. */
  readonly balances: readonly ClosureBalance[];
  readonly destination: ClosureDestination | null;
  /** The partner's moves paying the balance out, once it reports them. */
  readonly payoutMoveIds: readonly string[];
  readonly paidOutAt: Date | null;
  readonly closedAt: Date | null;
  readonly reopenedAt: Date | null;
  readonly label: string;
}

export interface DataRequest {
  readonly id: string;
  readonly kind: 'access' | 'portability';
  readonly requestedAt: Date;
  readonly status: 'received';
  /** The partner's own reference for the request. */
  readonly partnerRef: string;
  readonly label: string;
}

export interface PartnerCompliance {
  readonly label: string;
  onboarding(userId: string, tier: KycTier): Promise<PartnerOnboarding>;
  requests(userId: string): Promise<readonly InfoRequest[]>;
  /** Answers an open request with one file: it moves to under review once. Answering it again refuses. */
  answerRequest(userId: string, requestId: string, file: { name: string; type: string; bytes: Buffer }, now?: Date): Promise<InfoRequest>;
  reviews(userId: string): Promise<readonly PeriodicReview[]>;
  answerReview(userId: string, reviewId: string, answer: { stillAccurate: boolean; note: string | null }): Promise<PeriodicReview>;
  /** The person's closures, newest first, and whether the account is open, closing or closed. */
  closure(userId: string): Promise<{ state: 'open' | 'pending' | 'closed'; closures: readonly PartnerClosure[] }>;
  /**
   * Asks the partner to close the account. Once per `closureId`: the same id answers with that closure; another body
   * under it refuses `bank.closure_conflict`. Refuses `bank.closure_legal_hold`, `bank.closure_destination_required`
   * (a balance and no destination), `bank.closure_pending` (one is open) and `bank.account_closed`.
   */
  requestClosure(userId: string, closureId: string, destination: ClosureDestination | null): Promise<PartnerClosure>;
  /** Reopens a closed account within `windowDays` of its closing; refuses `bank.reopen_window_passed` after it. */
  reopen(userId: string, windowDays: number, now?: Date): Promise<PartnerClosure>;
  dataRequests(userId: string): Promise<readonly DataRequest[]>;
  /** Once per `requestId`: the same id answers with that request; another kind under it refuses `bank.data_request_conflict`. */
  requestData(userId: string, requestId: string, kind: DataRequest['kind']): Promise<DataRequest>;
}

/** The TEST partner's own doors, which only a test calls: opening a request or review, and reporting a payout made. */
export interface TestPartnerComplianceDoors {
  openRequest(userId: string, requestId: string, dueDays: number, now?: Date): InfoRequest;
  openReview(userId: string, reviewId: string, dueDays: number, now?: Date): PeriodicReview;
  /** The partner pays the pending closure's balance out to its destination and closes the account. Retry-safe. */
  reportPaidOut(userId: string): Promise<PartnerClosure>;
}

/** What the TEST partner needs of the TEST bank it sits beside. */
export interface TestComplianceHost {
  readonly label: string;
  readonly bank: Pick<PartnerBank, 'balances' | 'move'>;
  /** Restricts (or lifts) every move in or out of the person's accounts but a closure payout. */
  restrict(userId: string, on: boolean): void;
  /** Whether the partner accepts our identity case for this person, and whether it holds the account under a legal hold. */
  identityCaseAccepted(userId: string): boolean;
  legalHold(userId: string): boolean;
}

/** A partner move under this key prefix is a closure's payout: the one move a restricted account still makes. */
export const CLOSURE_PAYOUT_KEY = 'bank.closure.payout:';

export const TEST_PARTNER_REQUIREMENTS: readonly string[] = Object.freeze([
  'TEST: be 18 or older',
  'TEST: live in a country the partner bank serves',
]);
const TEST_REQUEST_TITLE = 'TEST: show where the money you pay in comes from';
const TEST_REQUEST_DETAIL = 'TEST request from the partner bank: upload one document, such as a payslip or a contract.';
const TEST_REVIEW_TITLE = 'TEST: confirm your account details are still accurate';
const TEST_REVIEW_MISSED =
  'TEST: if this review is not answered by its due date, the partner bank restricts the account to incoming payments until it is.';

/** The most requests, reviews, closures or data requests the TEST partner keeps for one person. */
const MAX_PER_PERSON = 50;
const DAY_MS = 86_400_000;

function err(message: string, code: ConstructorParameters<typeof BankError>[1]): BankError {
  return new BankError(message, code);
}

function capped<T>(list: T[]): void {
  if (list.length >= MAX_PER_PERSON) {
    throw err('The TEST partner keeps no more of these for this person.', 'bank.partner_unavailable');
  }
}

export function testPartnerCompliance(host: TestComplianceHost): PartnerCompliance & TestPartnerComplianceDoors {
  const requests = new Map<string, InfoRequest[]>();
  const reviews = new Map<string, PeriodicReview[]>();
  const closures = new Map<string, PartnerClosure[]>();
  const dataRequests = new Map<string, DataRequest[]>();
  let seq = 0;
  const ref = (kind: string) => {
    seq += 1;
    return `test-partner-${kind}-${String(seq).padStart(8, '0')}`;
  };
  const listOf = <T>(map: Map<string, T[]>, userId: string): T[] => {
    let list = map.get(userId);
    if (!list) {
      list = [];
      map.set(userId, list);
    }
    return list;
  };
  const replace = <T extends { id: string }>(list: T[], next: T): T => {
    const at = list.findIndex((row) => row.id === next.id);
    list[at] = next;
    return next;
  };
  const current = (userId: string): PartnerClosure | undefined => closures.get(userId)?.at(-1);
  const stateOf = (userId: string): 'open' | 'pending' | 'closed' => {
    const last = current(userId);
    if (!last || last.state === 'reopened') return 'open';
    return last.state;
  };
  /** Every account the partner holds for the person with money in it. A figure it does not know refuses. */
  const balancesOf = async (userId: string): Promise<ClosureBalance[]> => {
    const out: ClosureBalance[] = [];
    for (const row of await host.bank.balances(userId)) {
      if (row.amount === null || row.unavailable) {
        throw err(
          'The partner bank does not say what this account holds right now, so it cannot be closed yet.',
          'bank.partner_unavailable',
        );
      }
      if (row.amount > 0n) out.push({ assetId: row.account.assetId, spaceId: row.account.spaceId, amount: row.amount });
    }
    return out.sort((a, b) => `${a.assetId}|${a.spaceId ?? ''}`.localeCompare(`${b.assetId}|${b.spaceId ?? ''}`));
  };

  return {
    label: host.label,

    async onboarding(userId, tier) {
      const accepted = host.identityCaseAccepted(userId);
      const identityDone = accepted && tier !== 'none';
      const informationDone = (requests.get(userId) ?? []).every((row) => row.status !== 'open');
      const steps: OnboardingStep[] = [
        {
          id: 'identity',
          title: accepted
            ? 'TEST: confirm who you are (the partner bank accepts your INTAFACED verification)'
            : 'TEST: confirm who you are with the partner bank’s own check',
          status: identityDone ? 'done' : 'open',
          doneWith: identityDone ? 'identity_case' : null,
        },
        {
          id: 'information',
          title: 'TEST: answer the partner bank’s information requests',
          status: informationDone ? 'done' : 'open',
          doneWith: null,
        },
      ];
      return Object.freeze({
        label: host.label,
        steps: Object.freeze(steps),
        requirements: TEST_PARTNER_REQUIREMENTS,
        identityCase: Object.freeze({ tier, accepted }),
        complete: steps.every((step) => step.status === 'done'),
      });
    },

    requests: async (userId) => [...(requests.get(userId) ?? [])].reverse(),

    async answerRequest(userId, requestId, file, now = new Date()) {
      const list = requests.get(userId) ?? [];
      const row = list.find((r) => r.id === requestId);
      if (!row) throw err('The partner bank has no such request for you.', 'bank.info_request_not_found');
      const sha256 = createHash('sha256').update(file.bytes).digest('hex');
      if (row.status !== 'open') {
        throw err('This request has been answered and is under review; it takes one answer.', 'bank.info_request_not_open');
      }
      if (now.getTime() > row.dueAt.getTime()) {
        throw err('This request is past its deadline, so the partner bank takes no answer to it here.', 'bank.info_request_past_deadline');
      }
      return replace(
        list,
        Object.freeze({
          ...row,
          status: 'under_review' as const,
          answeredAt: now,
          file: Object.freeze({ name: file.name, type: file.type, size: file.bytes.length, sha256 }),
        }),
      );
    },

    reviews: async (userId) => [...(reviews.get(userId) ?? [])].reverse(),

    async answerReview(userId, reviewId) {
      const list = reviews.get(userId) ?? [];
      const row = list.find((r) => r.id === reviewId);
      if (!row) throw err('The partner bank has no such review for you.', 'bank.review_not_found');
      if (row.status !== 'open') throw err('This review is already answered.', 'bank.review_not_open');
      return replace(list, Object.freeze({ ...row, status: 'answered' as const, answeredAt: new Date() }));
    },

    closure: async (userId) => ({ state: stateOf(userId), closures: [...(closures.get(userId) ?? [])].reverse() }),

    async requestClosure(userId, closureId, destination) {
      const list = listOf(closures, userId);
      const prior = list.find((row) => row.id === closureId);
      if (prior) {
        const same =
          (prior.destination === null && destination === null) ||
          (prior.destination !== null &&
            destination !== null &&
            prior.destination.name === destination.name &&
            prior.destination.accountRef === destination.accountRef);
        if (!same) throw err('Another closure request already has this id, so this one was not made.', 'bank.closure_conflict');
        return prior;
      }
      const state = stateOf(userId);
      if (state === 'pending') throw err('Closing this account is already under way.', 'bank.closure_pending');
      if (state === 'closed') throw err('This account is already closed.', 'bank.account_closed');
      if (host.legalHold(userId)) {
        throw err(
          'The partner bank holds this account under a legal hold, so it cannot be closed while the hold stands.',
          'bank.closure_legal_hold',
        );
      }
      const balances = await balancesOf(userId);
      if (balances.length > 0 && destination === null) {
        throw err(
          'This account still holds money: name where the partner bank should pay it out before it closes.',
          'bank.closure_destination_required',
        );
      }
      capped(list);
      const now = new Date();
      const closing: PartnerClosure = Object.freeze({
        id: closureId,
        state: balances.length > 0 ? ('pending' as const) : ('closed' as const),
        requestedAt: now,
        balances: Object.freeze(balances),
        destination: balances.length > 0 ? destination : null,
        payoutMoveIds: Object.freeze([]),
        paidOutAt: null,
        closedAt: balances.length > 0 ? null : now,
        reopenedAt: null,
        label: host.label,
      });
      list.push(closing);
      host.restrict(userId, true);
      return closing;
    },

    async reopen(userId, windowDays, now = new Date()) {
      const list = closures.get(userId) ?? [];
      const last = list.at(-1);
      if (!last || last.state !== 'closed' || last.closedAt === null) throw err('This account is not closed.', 'bank.account_not_closed');
      if (now.getTime() > last.closedAt.getTime() + windowDays * DAY_MS) {
        throw err(`This account closed more than ${windowDays} days ago, so it can no longer be reopened.`, 'bank.reopen_window_passed');
      }
      const reopened = replace(list, Object.freeze({ ...last, state: 'reopened' as const, reopenedAt: now }));
      host.restrict(userId, false);
      return reopened;
    },

    dataRequests: async (userId) => [...(dataRequests.get(userId) ?? [])].reverse(),

    async requestData(userId, requestId, kind) {
      const list = listOf(dataRequests, userId);
      const prior = list.find((row) => row.id === requestId);
      if (prior) {
        if (prior.kind !== kind) throw err('Another data request already has this id.', 'bank.data_request_conflict');
        return prior;
      }
      capped(list);
      const row: DataRequest = Object.freeze({
        id: requestId,
        kind,
        requestedAt: new Date(),
        status: 'received' as const,
        partnerRef: ref('data'),
        label: host.label,
      });
      list.push(row);
      return row;
    },

    openRequest(userId, requestId, dueDays, now = new Date()) {
      const list = listOf(requests, userId);
      const prior = list.find((row) => row.id === requestId);
      if (prior) return prior;
      capped(list);
      const row: InfoRequest = Object.freeze({
        id: requestId,
        title: TEST_REQUEST_TITLE,
        detail: TEST_REQUEST_DETAIL,
        openedAt: now,
        dueAt: new Date(now.getTime() + dueDays * DAY_MS),
        status: 'open' as const,
        answeredAt: null,
        file: null,
        label: host.label,
      });
      list.push(row);
      return row;
    },

    openReview(userId, reviewId, dueDays, now = new Date()) {
      const list = listOf(reviews, userId);
      const prior = list.find((row) => row.id === reviewId);
      if (prior) return prior;
      capped(list);
      const row: PeriodicReview = Object.freeze({
        id: reviewId,
        title: TEST_REVIEW_TITLE,
        dueAt: new Date(now.getTime() + dueDays * DAY_MS),
        missedEffect: TEST_REVIEW_MISSED,
        status: 'open' as const,
        answeredAt: null,
        label: host.label,
      });
      list.push(row);
      return row;
    },

    async reportPaidOut(userId) {
      const list = closures.get(userId) ?? [];
      const last = list.at(-1);
      if (!last || last.state !== 'pending') throw err('No closure of this account is waiting for its payout.', 'bank.closure_not_found');
      if (host.legalHold(userId)) {
        throw err(
          'The partner bank holds this account under a legal hold, so the payout waits for the hold to end.',
          'bank.closure_legal_hold',
        );
      }
      // One move per balance, each under its own key: a retry after a lost reply makes each at most once.
      const moveIds: string[] = [];
      for (const balance of last.balances) {
        const from: PartnerAccountRef = { userId, assetId: balance.assetId, spaceId: balance.spaceId };
        const moved = await host.bank.move({
          key: `${CLOSURE_PAYOUT_KEY}${userId}:${last.id}:${balance.assetId}:${balance.spaceId ?? 'main'}`,
          from,
          to: partnerPayoutsAccount(balance.assetId),
          amount: balance.amount,
        });
        moveIds.push(moved.id);
      }
      const now = new Date();
      return replace(
        list,
        Object.freeze({ ...last, state: 'closed' as const, payoutMoveIds: Object.freeze(moveIds), paidOutAt: now, closedAt: now }),
      );
    },
  };
}

/** A closure's balances on the wire: decimal strings, never numbers. */
export function closureBalancesOut(balances: readonly ClosureBalance[]) {
  return balances.map((row) => ({ assetId: row.assetId, spaceId: row.spaceId, amount: formatAmount(row.amount) }));
}
