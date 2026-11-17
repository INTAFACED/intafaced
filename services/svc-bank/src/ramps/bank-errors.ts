import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `ramps/` throws, and what a caller is told for each (see `../errors.ts`). */
export const RAMPS_BANK_ERRORS = {
  /**
   * A live cash ramp has no rail. The programme stays simulated.
   * The missing piece is an outside company, the cash rail.
   */
  'bank.live_ramp_unset': 'PRECONDITION_FAILED',
  /**
   * FIAT ON/OFF RAMP IS §13 `socket.psp-partners`.
   *
   * A bank/PSP partner and money-transmission permission are a commercial
   * relationship. Refusing by this code is the whole fiat half of the ADR split.
   */
  'bank.fiat_ramp_no_pay_adapter': 'PRECONDITION_FAILED',
  /**
   * A pay adapter is present but none of its rails is a live fiat settle rail
   * (sandbox, absent, or missing onramp/offramp capability). Distinct from
   * empty-port `bank.fiat_ramp_no_pay_adapter` and programme-none `bank.fiat_ramp_socket`.
   */
  'bank.no_fiat_rail': 'PRECONDITION_FAILED',
  /**
   * On-ramp quote has no rate/fee source. A pay amount, fee, or FX rate is not invented.
   * The missing piece is socket.psp-partners plus a published price.
   */
  'bank.onramp_rate_unset': 'PRECONDITION_FAILED',
  /** No quote row for this caller. */
  'bank.onramp_quote_missing': 'PRECONDITION_FAILED',
  /** The quote's published expiry has passed. Nothing is charged. */
  'bank.onramp_quote_expired': 'PRECONDITION_FAILED',
  /** The partner answered without a hosted URL or bank-transfer instruction. None is invented. */
  'bank.onramp_instruction_missing': 'PRECONDITION_FAILED',
  /** No add-money request of this customer's under that id. */
  'bank.add_money_request_missing': 'NOT_FOUND',
  /** The partner said a pay-in was paid in another amount or currency than the payment it opened. Nothing is credited. */
  'bank.onramp_paid_mismatch': 'CONFLICT',
  'bank.onramp_delivery_missing': 'CONFLICT',
  'bank.wallet_delivery_unproven': 'FORBIDDEN',
  /** Fee plus net does not equal the amount. The service does not adjust either figure. */
  'bank.offramp_fee_inconsistent': 'PRECONDITION_FAILED',
  /** The destination fraud list could not be read, so the address was refused rather than assumed safe. Nothing was saved. */
  'bank.destination_fraud_list_unreadable': 'SERVICE_UNAVAILABLE',
  /** No open wallet proof of this customer's has that id, or its saved address is gone or changed. */
  'bank.wallet_proof_not_found': 'NOT_FOUND',
  /** The proof offer lapsed before it was signed. Start a new one. */
  'bank.wallet_proof_expired': 'BAD_REQUEST',
  /** The text pasted is not a 65-byte signature of the proof message. */
  'bank.wallet_proof_signature_invalid': 'BAD_REQUEST',
  /** The message was signed by a different address from the saved one. The offer stays open. */
  'bank.wallet_proof_wrong_signer': 'BAD_REQUEST',
  /** The proof is already complete with another signature, or changed while it was checked. */
  'bank.wallet_proof_conflict': 'CONFLICT',
  /** The address was approved already, so there is nothing to approve or mail. */
  'bank.address_approval_not_pending': 'CONFLICT',
  /** Approving from the device (or the sign-in, where no device is named) that saved the address: another one, or the link, must. */
  'bank.address_approval_same_device': 'PRECONDITION_FAILED',
  /** The saving or the approving sign-in is not named on its access token, so a different device cannot be told; use the link. */
  'bank.address_approval_device_unknown': 'PRECONDITION_FAILED',
  /** Identity says the approving device is removed, expired, trusted only by signing in, or the new-device check is off. */
  'bank.address_approval_device_untrusted': 'PRECONDITION_FAILED',
  /** Identity could not say whether the approving device may approve (outage, no IDENTITY_URL). Nothing was approved. */
  'bank.address_approval_device_unavailable': 'SERVICE_UNAVAILABLE',
  /** Not a link sent to this account (unknown, malformed, or spent on an address still waiting). */
  'bank.address_approval_link_invalid': 'NOT_FOUND',
  /** A newer link was sent for the address; only the newest works. */
  'bank.address_approval_link_replaced': 'PRECONDITION_FAILED',
  /** The link's time ran out; the customer asks for a new one. */
  'bank.address_approval_link_expired': 'PRECONDITION_FAILED',
  /** Identity could not take the mail (no mail service, outage, bad reply). Nothing was sent. */
  'bank.address_approval_mail_unavailable': 'SERVICE_UNAVAILABLE',
  /** The account has no confirmed email address, so no link can be mailed. */
  'bank.address_approval_email_unproved': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
