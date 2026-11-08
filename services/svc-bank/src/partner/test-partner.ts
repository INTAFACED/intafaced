import { isExplicitDevOrTest } from '@intafaced/config';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { PartnerAccountRef, PartnerBalance, PartnerBank, PartnerMove, PartnerMoveRequest, PartnerMovesQuery } from './partner-bank.js';

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
export const TEST_PARTNER_SETTINGS = ['off', 'test'] as const;
export type TestPartnerSetting = (typeof TEST_PARTNER_SETTINGS)[number];

export const TEST_PARTNER_LABEL = 'TEST partner bank';

/** What a partner may not offer. `currencies` is the partner's currency accounts (J-bank-01 #3). */
export const PARTNER_FEATURES = ['currencies', 'spaces', 'pots', 'joint'] as const;
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
   * shared pot's card, and cancelling or pausing a standing order, stay open (they only protect), and reads still show
   * what was last read.
   */
  readonly down: boolean;
  /** `expired`: the ramp says any quote it gave has expired when it is accepted. */
  readonly rampQuote: 'live' | 'expired';
  /** `unknown`: the ramp gives no fee, so no pay amount: the quote reads "not known" and nothing can be asked. */
  readonly rampFee: 'known' | 'unknown';
  /**
   * `off`: this person's bank money is held at the TEST partner bank (OWNER 226). Balances are the partner's figures and
   * moves are partner instructions; the ledger posts nothing for them. `on` (default): the custodial layer, as before.
   */
  readonly custody: 'on' | 'off';
  /** `lost`: the partner makes this person's next move and its answer is lost, once; then it goes back to `answered`. */
  readonly nextReply: 'answered' | 'lost';
}

export const SWITCHES_OFF: TestPartnerSwitches = Object.freeze({
  notOffered: Object.freeze([]) as readonly PartnerFeature[],
  fee: 'known',
  reserve: 'none',
  down: false,
  rampQuote: 'live',
  rampFee: 'known',
  custody: 'on',
  nextReply: 'answered',
});

/** The partner's reserve as it reports it. An amount it has not told us is null, read as "not known", never 0. */
export type PartnerReserve = { readonly required: false } | { readonly required: true; readonly amount: null };

export interface TestPartnerFund {
  /** The business key of this TEST funding: the same id is the same funding, once. */
  readonly fundId: string;
  readonly assetId: string;
  readonly amount: Amount;
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
  let seq = 0;

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
  const report = (account: PartnerAccountRef): PartnerBalance =>
    Object.freeze({ account, amount: held.get(accountKey(account)) ?? 0n, asOf: new Date(), label: TEST_PARTNER_LABEL });
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
        if (!sameAccount(prior.from, request.from) || !sameAccount(prior.to, request.to) || prior.amount !== request.amount) {
          throw moveConflict(request.key);
        }
        return prior;
      }
      if (switches(request.from.userId).down) throw partnerDown();
      if (byKey.size >= MAX_MOVES) throw partnerDown();
      if (request.amount <= 0n) throw new BankError('A partner move needs an amount above zero.', 'bank.partner_amount_invalid');
      if (request.from.assetId !== request.to.assetId) {
        throw new BankError('A partner move stays in one currency; convert first.', 'bank.asset_mismatch');
      }
      if (sameAccount(request.from, request.to)) throw new BankError('A transfer needs two different spaces', 'bank.same_space');
      const fromKey = accountKey(request.from);
      const has = held.get(fromKey) ?? 0n;
      if (has < request.amount) {
        throw new BankError(
          `The partner reports ${formatAmount(has)} ${request.from.assetId} in this account, less than ${formatAmount(request.amount)}. Nothing was moved.`,
          'bank.partner_insufficient_funds',
        );
      }
      // One step, nothing awaited: the debit, the credit and the record are made together or not at all.
      seq += 1;
      const move: PartnerMove = Object.freeze({
        id: `test-partner-move-${String(seq).padStart(12, '0')}`,
        key: request.key,
        from: Object.freeze({ ...request.from }),
        to: Object.freeze({ ...request.to }),
        amount: request.amount,
        movedAt: new Date(),
        label: TEST_PARTNER_LABEL,
      });
      held.set(fromKey, has - request.amount);
      held.set(accountKey(request.to), (held.get(accountKey(request.to)) ?? 0n) + request.amount);
      remember(move);
      if (switches(request.from.userId).nextReply === 'lost') {
        set(request.from.userId, { nextReply: 'answered' });
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
        if (query.assetId === undefined || move.from.assetId === query.assetId) out.push(move);
      }
      return out;
    },
  };

  return {
    label: TEST_PARTNER_LABEL,
    switches,
    set,
    bank,
    fund(userId, funding) {
      const account: PartnerAccountRef = { userId, assetId: funding.assetId, spaceId: null };
      // Per person: one person's fund id never collides with, or tells anything about, another's.
      const fundKey = `${userId}|${funding.fundId}`;
      const prior = funds.get(fundKey);
      if (prior) {
        if (prior.assetId !== funding.assetId || prior.amount !== funding.amount) {
          throw moveConflict(funding.fundId);
        }
        return report(account);
      }
      if (switches(userId).down) throw partnerDown();
      if (funding.amount <= 0n) throw new BankError('TEST funding needs an amount above zero.', 'bank.partner_amount_invalid');
      funds.set(fundKey, { userId, assetId: funding.assetId, amount: funding.amount });
      held.set(accountKey(account), (held.get(accountKey(account)) ?? 0n) + funding.amount);
      return report(account);
    },
  };
}

/** The partner custody the TEST partner decides: a person with `custody: 'off'` is held at it; everyone else, as before. */
export function testPartnerCustody(partner: TestPartner | null | undefined): { bankFor(userId: string): PartnerBank | null } {
  return { bankFor: (userId) => (partner && partner.switches(userId).custody === 'off' ? partner.bank : null) };
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

/** Whether the ramp says a quote it gave has expired, whatever its own time said. */
export function rampQuoteExpired(partner: TestPartner | null | undefined, userId: string): boolean {
  return !!partner && partner.switches(userId).rampQuote === 'expired';
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
