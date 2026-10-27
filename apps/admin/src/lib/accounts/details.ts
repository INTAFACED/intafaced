import { CUSTOMER_PROTECTED_DETAIL_KEYS, type CustomerDetailKey, type CustomerDetailsResult } from '@intafaced/contracts/account-controls';

/**
 * A customer's personal details as the console edits them (OPS-accounts-desk-02, J-ops-console-04 #9). Identity keeps the
 * details and decides: open details apply at once, and name, date of birth and tax number open a compliance review that
 * the other founder passes or rejects. Pure and browser-safe: labels and the words for identity's answers.
 */

export const DETAIL_LABEL: Readonly<Record<CustomerDetailKey, string>> = {
  legalName: 'Legal name',
  dateOfBirth: 'Date of birth',
  taxNumber: 'Tax number',
  phone: 'Phone',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  postalCode: 'Postal code',
  countryCode: 'Country (two letters)',
  occupation: 'Occupation',
  income: 'Income',
  businessDetails: 'Business details',
};

export function isProtectedDetail(key: CustomerDetailKey): boolean {
  return (CUSTOMER_PROTECTED_DETAIL_KEYS as readonly string[]).includes(key);
}

const REFUSAL_WORDS: Readonly<Record<Extract<CustomerDetailsResult, { outcome: 'refused' }>['code'], string>> = {
  'operator.denied': 'Identity accepts this only from a live founder. Nothing was changed.',
  'mfa.required': 'Identity needs a session with a second factor. Sign in again. Nothing was changed.',
  'target.not_found': 'Identity has no customer with this id. Nothing was changed.',
  'request.conflict':
    'This edit was already asked for on this reading with other words or values. Read the account again. Nothing was changed.',
  'identity.account_archived':
    'The customer record is archived, so identity keeps it read-only (identity.account_archived). Nothing was changed.',
  'identity.details_unconfigured':
    'Identity keeps customer details encrypted under the KYC document key (IDENTITY_KYC_DOC_KEY), which is not set, so no detail can be read or changed.',
  'identity.details_founder_forbidden': 'A founder’s own details are not edited from the console. Nothing was changed.',
  'identity.details_mixed_edit':
    'One edit changes either protected details (name, date of birth, tax number) or the others, never both. Nothing was changed.',
  'identity.details_unchanged': 'That is already the value on record. Nothing was changed.',
  'identity.details_documents_unknown': 'A document named is not one of this customer’s documents. Nothing was changed.',
  'identity.details_review_open':
    'A compliance review of this customer’s protected details is already open. It has to be passed or rejected first. Nothing was changed.',
  'identity.details_review_not_found': 'Identity has no such review. Nothing was changed.',
  'identity.details_review_closed': 'That review was already decided. Nothing more was changed.',
  'identity.details_review_self_forbidden':
    'You asked for this change, so the other founder decides the review (identity.details_review_self_forbidden). Nothing was changed.',
};

/** What identity answered, in words. Only `applied` changed the record. */
export function detailsReply(result: CustomerDetailsResult): { readonly ok: boolean; readonly text: string } {
  const fields = result.fields.map((key) => DETAIL_LABEL[key]).join(', ');
  switch (result.outcome) {
    case 'applied':
      return {
        ok: true,
        text: result.reviewId
          ? `Review passed: identity applied ${fields} (record version ${result.version}).`
          : `Saved: identity applied ${fields} (record version ${result.version}).`,
      };
    case 'review_opened':
      return {
        ok: true,
        text: `Compliance review opened for ${fields}. The record keeps the old value until the other founder passes it.`,
      };
    case 'review_rejected':
      return { ok: true, text: `Review rejected: ${fields} stays as it was.` };
    case 'conflict':
      return {
        ok: false,
        text: `The record changed since you read it (now version ${result.version}). Read it again; nothing was changed.`,
      };
    case 'refused':
      return { ok: false, text: `${REFUSAL_WORDS[result.code]} (${result.code})` };
  }
}

const OUTCOME_LABEL: Readonly<Record<CustomerDetailsResult['outcome'], string>> = {
  applied: 'applied',
  review_opened: 'review opened',
  review_rejected: 'review rejected',
  refused: 'refused',
  conflict: 'version conflict',
};

/** One history row's outcome, in words. */
export function historyOutcome(result: CustomerDetailsResult): string {
  return result.outcome === 'refused' ? `refused (${result.code})` : OUTCOME_LABEL[result.outcome];
}
