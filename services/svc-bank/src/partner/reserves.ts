import type { BankPartnerReserves, OpsCapitalReserve } from '@intafaced/contracts';
import { BankError } from '../errors.js';
import type { CardPartnerTerms } from '../cards/partner-terms.js';
import { programmeReserve, type TestPartner } from './test-partner.js';

/**
 * ANY RESERVE A PARTNER HOLDS OF OURS, as each partner adapter reports it (J-ops-console-24 #1), for svc-ops' capital
 * monitor alone (`/internal/capital/partner-reserves`).
 *
 * Two partners can hold one: the partner bank and the card partner. A reserve whose amount the partner has not told us is
 * `not_known`, never zero, and never `none` (CUSTODY-DELTA §1.3). A partner this deployment has no adapter for is absent:
 * it holds nothing of ours because there is no partner. Nothing here reads or writes the ledger.
 */
export function partnerReservesRead(input: {
  readonly testPartner: TestPartner | null;
  /** The card partner's terms, or null when the deployment has no card issuer. */
  readonly cardTerms: CardPartnerTerms | null;
  readonly now: Date;
}): BankPartnerReserves {
  const partners: BankPartnerReserves['partners'][number][] = [];
  const bank = programmeReserve(input.testPartner);
  if (input.testPartner && bank) {
    partners.push({
      partner: 'bank',
      label: input.testPartner.label,
      test: true,
      // The TEST partner bank never reports an amount: required with none told is "not known".
      reserve: bank.required ? { status: 'not_known' } : { status: 'none' },
    });
  }
  if (input.cardTerms) {
    const r = input.cardTerms.reserve;
    const reserve: OpsCapitalReserve =
      r === null ? { status: 'not_known' } : r.required ? { status: 'reported', assetId: r.assetId, amount: r.amount } : { status: 'none' };
    partners.push({
      partner: 'card',
      label: input.cardTerms.test ? 'TEST partner card' : 'Card partner',
      test: input.cardTerms.test,
      reserve,
    });
  }
  return { asOf: input.now.toISOString(), partners };
}

/** The card partner's terms, or null when no card issuer is configured. Any other failure is thrown, never read as none. */
export function cardTermsOrNone(read: () => CardPartnerTerms): CardPartnerTerms | null {
  try {
    return read();
  } catch (err) {
    if (err instanceof BankError && err.code === 'bank.no_card_issuer') return null;
    throw err;
  }
}
