import { isExplicitDevOrTest } from '@intafaced/config';
import { BankError } from '../errors.js';

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
   * The partner is not answering: every write to a currency account, space, pot or joint account refuses
   * `bank.partner_unavailable`, nothing written. Freezing a shared pot's card stays open (it only protects), and reads
   * still show what was last read.
   */
  readonly down: boolean;
  /** `expired`: the ramp says any quote it gave has expired when it is accepted. */
  readonly rampQuote: 'live' | 'expired';
  /** `unknown`: the ramp gives no fee, so no pay amount: the quote reads "not known" and nothing can be asked. */
  readonly rampFee: 'known' | 'unknown';
}

export const SWITCHES_OFF: TestPartnerSwitches = Object.freeze({
  notOffered: Object.freeze([]) as readonly PartnerFeature[],
  fee: 'known',
  reserve: 'none',
  down: false,
  rampQuote: 'live',
  rampFee: 'known',
});

/** The partner's reserve as it reports it. An amount it has not told us is null, read as "not known", never 0. */
export type PartnerReserve = { readonly required: false } | { readonly required: true; readonly amount: null };

export interface TestPartner {
  readonly label: string;
  switches(userId: string): TestPartnerSwitches;
  /** Sets some switches for one person and returns them all. Unnamed switches keep their value. */
  set(userId: string, change: Partial<TestPartnerSwitches>): TestPartnerSwitches;
}

/**
 * The most people the adapter keeps switches for. The local stack signs up a few hundred per run; past this the oldest
 * person's switches go back to off, so a long-running stack never grows without bound.
 */
const MAX_PEOPLE = 10_000;

export function testPartner(): TestPartner {
  const kept = new Map<string, TestPartnerSwitches>();
  return {
    label: TEST_PARTNER_LABEL,
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
