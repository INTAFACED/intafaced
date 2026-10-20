/**
 * Refusals for personal bill pay and global send.
 *
 * The sentence names the blocker. The code is what a screen branches on.
 * A blank partner, rate source, corridor catalogue or travel-rule decision
 * uses one of these. Nothing in this module invents a biller, a rate, a fee
 * or a corridor to avoid throwing.
 */

export const PSP_BLOCKER = 'socket.psp-partners' as const;

export type PersonalPayHttp = 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE' | 'FORBIDDEN';

export class PersonalPayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly http: PersonalPayHttp,
    readonly blocker?: string,
  ) {
    super(message);
    this.name = 'PersonalPayError';
  }
}

export function personalPayError(code: string, detail?: string): PersonalPayError {
  switch (code) {
    case 'bank.bills_directory_unset':
      return new PersonalPayError(
        'Biller search is socket.psp-partners. No directory was queried and no biller was invented.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.bills_lookup_unset':
      return new PersonalPayError(
        'Bill lookup is socket.psp-partners. No amount due, due date or payee name is invented.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.bills_psp_unset':
      return new PersonalPayError(
        'Bill pay is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.bills_rail_refused':
      return new PersonalPayError(
        'The bill-pay rail refused this payment. Nothing remains posted.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.bills_directory_unusable':
    case 'bank.bills_lookup_unusable':
    case 'bank.bills_rail_unusable':
      return new PersonalPayError(
        'The bill-pay provider answered in a shape this service will not coerce into a biller, an amount due or a payment.',
        code,
        'SERVICE_UNAVAILABLE',
        PSP_BLOCKER,
      );
    case 'bank.bills_outcome_unknown':
      return new PersonalPayError(
        'Bill pay did not get a definite answer from the rail. Retry the same idempotency key. Do not start a second payment.',
        code,
        'SERVICE_UNAVAILABLE',
        PSP_BLOCKER,
      );
    case 'bank.bills_reference_unknown':
      return new PersonalPayError('This biller does not have that reference.', code, 'NOT_FOUND');
    case 'bank.bills_conflict':
      return new PersonalPayError('This idempotency key was already used for a different bill payment.', code, 'CONFLICT');
    case 'bank.bills_not_found':
    case 'bank.bill_recurring_not_found':
      return new PersonalPayError('No such bill.', code, 'NOT_FOUND');
    case 'bank.bills_space_not_found':
    case 'bank.global_space_not_found':
      return new PersonalPayError('No such space.', code, 'NOT_FOUND');
    case 'bank.bills_list_limit_unset':
      return new PersonalPayError('Page size was omitted. Blank is not a default page. Pass a limit.', code, 'BAD_REQUEST');
    case 'bank.bills_cursor_invalid':
      return new PersonalPayError('That bills cursor cannot be read.', code, 'BAD_REQUEST');
    case 'bank.bill_recurring_inactive':
      return new PersonalPayError('This recurring bill is not active.', code, 'PRECONDITION_FAILED');
    case 'bank.bills_insufficient_funds':
      return new PersonalPayError(detail ?? 'Insufficient funds', code, 'BAD_REQUEST');
    case 'bank.payee_controls_unset':
      return new PersonalPayError(
        'The owner has not published the payee controls, so no send can be checked against them. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
      );
    case 'bank.payee_blocked':
      return new PersonalPayError('This payment cannot be sent to that recipient. Nothing was posted.', code, 'PRECONDITION_FAILED');
    case 'bank.transfer_settled':
      return new PersonalPayError('This send has already left, so it can no longer be held.', code, 'PRECONDITION_FAILED');
    case 'bank.transfer_not_holdable':
      return new PersonalPayError('This send is not in a state that can be held.', code, 'PRECONDITION_FAILED');
    case 'bank.hold_not_found':
      return new PersonalPayError('No open hold on this send.', code, 'NOT_FOUND');
    case 'bank.hold_conflict':
      return new PersonalPayError('This send already has a hold, or this key was used for a different hold.', code, 'CONFLICT');
    case 'bank.release_same_operator':
      return new PersonalPayError('A hold must be released by someone other than the person who placed it.', code, 'FORBIDDEN');
    case 'bank.proof_limits_unset':
      return new PersonalPayError(
        'The owner has not published which file types and sizes can be uploaded, so no upload is accepted.',
        code,
        'PRECONDITION_FAILED',
      );
    case 'bank.proof_type_not_allowed':
      return new PersonalPayError('That file type is not accepted.', code, 'BAD_REQUEST');
    case 'bank.proof_too_large':
      return new PersonalPayError('That file is larger than the limit.', code, 'BAD_REQUEST');
    case 'bank.proof_invalid':
      return new PersonalPayError('That file could not be read.', code, 'BAD_REQUEST');
    case 'bank.proof_not_requested':
      return new PersonalPayError('No document has been asked for on this send.', code, 'PRECONDITION_FAILED');
    case 'bank.proof_already_uploaded':
      return new PersonalPayError('A document was already uploaded and is being reviewed.', code, 'CONFLICT');
    case 'bank.link_reference_conflict':
      return new PersonalPayError('That reference is already linked to a different send.', code, 'CONFLICT');
    case 'bank.personal_pay_request_invalid':
      return new PersonalPayError('That bill or send request is not usable.', code, 'BAD_REQUEST');
    case 'bank.global_corridors_unset':
      return new PersonalPayError(
        'Corridor catalogue is socket.psp-partners. No country, delivery method, limit or cut-off is invented.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.global_corridors_unusable':
      return new PersonalPayError(
        'The corridor provider answered in a shape this service will not coerce into a catalogue.',
        code,
        'SERVICE_UNAVAILABLE',
        PSP_BLOCKER,
      );
    case 'bank.global_corridor_unknown':
      return new PersonalPayError(
        'That country, currency and delivery method are not in the corridor catalogue.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.global_fx_unset':
      return new PersonalPayError(
        'No exchange rate is available. The rate source is socket.psp-partners, a rate counterparty. This service does not invent a rate, a fee or a receive amount.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.global_fx_unusable':
    case 'bank.global_payout_unusable':
      return new PersonalPayError(
        'The global-send provider answered in a shape this service will not coerce into a rate or a payment.',
        code,
        'SERVICE_UNAVAILABLE',
        PSP_BLOCKER,
      );
    case 'bank.global_quote_expired':
      return new PersonalPayError('The provider quote is no longer valid. Nothing was posted.', code, 'PRECONDITION_FAILED', PSP_BLOCKER);
    case 'bank.global_payout_unset':
      return new PersonalPayError(
        'Global send is socket.psp-partners — a payout partner and money-transmission permission, not inventable code. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
        PSP_BLOCKER,
      );
    case 'bank.global_payout_refused':
      return new PersonalPayError('The payout rail refused this send. Nothing remains posted.', code, 'PRECONDITION_FAILED', PSP_BLOCKER);
    case 'bank.global_travel_rule_undecided':
      return new PersonalPayError(
        'Travel-rule data for a global send has not been decided by Nitro/Phantom. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
      );
    case 'bank.global_travel_rule_incomplete':
      return new PersonalPayError(
        'The recorded travel-rule decision requires fields this send did not include. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
      );
    case 'bank.send_field_rules_unset':
      return new PersonalPayError(
        'The owner has not published what a send needs for purpose, source of funds and reference. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
      );
    case 'bank.reference_rules_unset':
      return new PersonalPayError(
        'The owner has not published a reference length for this rail and country. Nothing was posted.',
        code,
        'PRECONDITION_FAILED',
      );
    case 'bank.reference_too_long':
      return new PersonalPayError(detail ?? 'The reference is longer than this rail allows.', code, 'BAD_REQUEST');
    case 'bank.send_purpose_required':
      return new PersonalPayError('Sends to this currency need a purpose. Nothing was posted.', code, 'BAD_REQUEST');
    case 'bank.source_of_funds_required':
      return new PersonalPayError('A send of this size needs a source of funds. Nothing was posted.', code, 'BAD_REQUEST');
    case 'bank.global_outcome_unknown':
      return new PersonalPayError(
        'Global send did not get a definite answer from the rail. Retry the same idempotency key. Do not start a second send.',
        code,
        'SERVICE_UNAVAILABLE',
        PSP_BLOCKER,
      );
    case 'bank.global_conflict':
      return new PersonalPayError('This idempotency key was already used for a different global send or recipient.', code, 'CONFLICT');
    case 'bank.global_not_found':
      return new PersonalPayError('No such send.', code, 'NOT_FOUND');
    case 'bank.global_recipient_not_found':
      return new PersonalPayError('No such recipient.', code, 'NOT_FOUND');
    case 'bank.global_list_limit_unset':
      return new PersonalPayError('Page size was omitted. Blank is not a default page. Pass a limit.', code, 'BAD_REQUEST');
    case 'bank.global_cursor_invalid':
      return new PersonalPayError('That global-send cursor cannot be read.', code, 'BAD_REQUEST');
    case 'bank.global_account_format_invalid':
      return new PersonalPayError(
        'That account is not an IBAN, an IFSC, or a 6 to 17 digit account number. Format only — this is not a bank lookup.',
        code,
        'BAD_REQUEST',
      );
    case 'bank.global_bic_format_invalid':
      return new PersonalPayError(
        'That BIC is not 8 or 11 characters in ISO 9362 shape. This is not a directory lookup.',
        code,
        'BAD_REQUEST',
      );
    case 'bank.global_insufficient_funds':
      return new PersonalPayError(detail ?? 'Insufficient funds', code, 'BAD_REQUEST');
    default:
      return new PersonalPayError('Personal pay could not complete.', code, 'SERVICE_UNAVAILABLE');
  }
}
