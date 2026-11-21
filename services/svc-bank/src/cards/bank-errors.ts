import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `cards/` throws, and what a caller is told for each (see `../errors.ts`). */
export const CARDS_BANK_ERRORS = {
  /**
   * `BANK_CARD_ISSUER=card-sim` under live/production posture.
   *
   * The simulator is not an issuing BIN. A deployment that looks live must not
   * issue or authorise as if a scheme counterparty exists. Distinct from
   * `bank.no_card_issuer` (nobody chose an issuer) so an operator is not sent
   * looking for a missing setting when the setting they chose is the simulator.
   */
  'bank.card_sim_not_live': 'PRECONDITION_FAILED',
  /** The authorisation is larger than the card's per-authorisation ceiling. */
  'bank.card_limit_exceeded': 'BAD_REQUEST',
  'bank.card_authorization_not_found': 'BAD_REQUEST',
  /** Capture or reversal asked for on an authorisation that was declined. */
  'bank.card_authorization_declined': 'BAD_REQUEST',
  /** Already captured or already reversed — the hold is gone either way. */
  'bank.card_authorization_closed': 'BAD_REQUEST',
  /** A capture may never exceed what was authorised and held. */
  'bank.card_capture_exceeds_authorization': 'BAD_REQUEST',
  /** Disagrees with a claimed settlement row — same class as ramp_conflict. */
  /**
   * A settlement re-drive disagreed with the amount its row was claimed for.
   *
   * The ledger's business key is the authorisation, not the amount, and a reused
   * key returned the original transaction without comparing bodies — correct for a
   * re-drive, silently wrong for a disagreement. (The ledger now compares: in `refuse`
   * mode it answers `ledger.idempotency_conflict`; in `detect` mode it still returns the
   * original and logs `ledger.idempotency_mismatch`, so this check stays.) Refused rather than reconciled,
   * because the alternative reports a capture the ledger never saw and reverses
   * a remainder computed from it.
   */
  'bank.card_settlement_amount_conflict': 'BAD_REQUEST',
  /** Disagrees with the kind a sequence was claimed for — same class as the amount. */
  /**
   * A settlement disagreed with the kind its sequence was claimed for.
   *
   * Capture and reverse both take sequence 0. The unique index makes a second
   * row impossible, which is right once a movement has settled and wrong if the
   * other kind is handed the first kind's ledger transaction while the claim is
   * still pending. A pending capture is not an open door for a reverse, and a
   * pending reversal is not an open door for a capture.
   */
  'bank.card_settlement_kind_conflict': 'BAD_REQUEST',
  /**
   * Cashback for this user is posted in more than one asset.
   * The read will not add those figures into one number.
   */
  'bank.rewards_asset_ambiguous': 'PRECONDITION_FAILED',
  /** A retried issue disagreed with the card type or delivery address already stored. */
  'bank.card_issue_conflict': 'CONFLICT',
  /** A command id was reused for a different card change. */
  'bank.card_command_conflict': 'CONFLICT',
  /** A replacement id was reused for a different card, or the reason disagreed. */
  'bank.card_replace_conflict': 'CONFLICT',
  /** The rank service could not say which card tier this person has. */
  'bank.rank_unavailable': 'SERVICE_UNAVAILABLE',
  /** A pay-from order is empty or names an asset twice. */
  'bank.card_pay_from_order_invalid': 'BAD_REQUEST',
  /** The card partner does not offer this programme funding kind, or has not said (J-bank-26 #6). */
  'bank.card_funding_not_offered': 'PRECONDITION_FAILED',
  /** A programme funding request needs a positive amount, and auto reload a positive threshold. */
  'bank.card_funding_invalid': 'BAD_REQUEST',
  /** No card dispute with that id (J-bank-27). */
  'bank.card_dispute_not_found': 'NOT_FOUND',
  /** A dispute request is not in shape, or a case key was used for a different dispute. */
  'bank.card_dispute_invalid': 'BAD_REQUEST',
  /** That step is not open to a dispute in its state (a closed case, representment twice, arbitration before representment). */
  'bank.card_dispute_state': 'CONFLICT',
  /** The authorisation has no settled capture to dispute, or the amount is above what was captured. */
  'bank.card_dispute_not_disputable': 'PRECONDITION_FAILED',
  /** The disputed amount is above the owner's dispute cap (J-bank-27 #4). */
  'bank.card_dispute_cap_exceeded': 'PRECONDITION_FAILED',
  /** The card partner does not take provisional credits or dispute decisions through this adapter. */
  'bank.card_dispute_partner_unset': 'PRECONDITION_FAILED',
  /** The card partner answered a provisional credit with another amount than the one asked; nothing was recorded. */
  'bank.card_dispute_partner_mismatch': 'CONFLICT',
  'bank.card_dispute_rules_unset': 'PRECONDITION_FAILED',
  'bank.card_dispute_evidence_closed': 'CONFLICT',
  /** A card reassign named the cardholder that already holds it. (J-bank-26) */
  'bank.card_reassign_same': 'CONFLICT',
  /** A card with an authorisation still held for its holder cannot move to another cardholder. (J-bank-26) */
  'bank.card_reassign_open_hold': 'CONFLICT',
  /** A card programme setting, rule, cardholder or staff request is not in shape. (J-bank-26) */
  'bank.card_programme_invalid': 'BAD_REQUEST',
  /** An operator cannot change their own card programme role. (J-bank-26) */
  'bank.card_programme_staff_self': 'CONFLICT',
  /** No card programme rule with that key or id. (J-bank-26) */
  'bank.card_rule_not_found': 'NOT_FOUND',
  /** That rule step is not open in the rule's state (promote a rule not in shadow, roll back with nothing promoted). (J-bank-26) */
  'bank.card_rule_state': 'CONFLICT',
  /** The cardholder fails the KYC or KYB gate: no verified account, or a business with no verified beneficial owner. Recorded in the review queue. (J-bank-26) */
  'bank.cardholder_unverified': 'PRECONDITION_FAILED',
  /** The cardholder is in the review queue (a screening match or a gate gap) and can hold no new card. (J-bank-26) */
  'bank.cardholder_under_review': 'PRECONDITION_FAILED',
  /** No cardholder with that id. (J-bank-26) */
  'bank.cardholder_not_found': 'NOT_FOUND',
  /** A cardholder request key was reused with other details. (J-bank-26) */
  'bank.cardholder_conflict': 'CONFLICT',
  /** A bulk card file has a bad row; nothing was issued. (J-bank-26) */
  'bank.card_bulk_invalid': 'BAD_REQUEST',
  /** svc-bank has no signing secret, so a card programme report cannot be exported signed (J-bank-26 #7). */
  'bank.card_report_signing_unset': 'PRECONDITION_FAILED',
  /** Cards are not offered to residents of the country given. */
  'bank.card_not_eligible': 'PRECONDITION_FAILED',
  /** The person already holds as many active cards of this kind as the programme allows. */
  'bank.card_count_limit': 'PRECONDITION_FAILED',
  /** A use limit is a whole number of payments, at least one, on a virtual card. */
  'bank.card_use_limit_invalid': 'BAD_REQUEST',
  /** The cardholder terms of the current version have not been accepted. */
  'bank.card_terms_not_accepted': 'PRECONDITION_FAILED',
  /** The terms accepted are not the version or text published now. */
  'bank.card_terms_changed': 'CONFLICT',
  /** The design is not one of the programme’s designs. */
  'bank.card_design_unknown': 'BAD_REQUEST',
  /** The delivery speed is not one the programme offers. */
  'bank.card_delivery_speed_unknown': 'BAD_REQUEST',
  /** A physical card is not delivered to the country of this address. */
  'bank.card_delivery_country': 'PRECONDITION_FAILED',
  /** The card is virtual, so it has no delivery. */
  'bank.card_not_physical': 'BAD_REQUEST',
  /** The card is already produced, so its delivery address can no longer change. */
  'bank.card_address_locked': 'CONFLICT',
  /** A delivery moves forward only: ordered, produced, shipped, delivered. */
  'bank.card_shipment_order': 'CONFLICT',
  /**
   * No live issuer can view or set a PIN.
   * The missing piece is `socket.live-issuer`.
   */
  'bank.card_pin_issuer_unset': 'PRECONDITION_FAILED',
  /** A PIN was not 4 to 12 digits. The refusal never echoes the PIN. */
  'bank.card_pin_invalid': 'BAD_REQUEST',
  /** The card has no PIN at the issuer yet, so there is none to show. */
  'bank.card_pin_not_set': 'PRECONDITION_FAILED',
  /** No card partner can send a 3D Secure code for this card (J-bank-14 #5). The missing piece is `socket.live-issuer`. */
  'bank.card_3ds_issuer_unset': 'PRECONDITION_FAILED',
  /** No 3D Secure challenge with this id on this person's card. */
  'bank.card_3ds_not_found': 'NOT_FOUND',
  /** This challenge reference was already opened for a different purchase. Nothing changed. */
  'bank.card_3ds_conflict': 'CONFLICT',
  /** An open challenge was answered with no code. Nothing was counted. */
  'bank.card_3ds_code_missing': 'BAD_REQUEST',
  /**
   * No live issuer can push a card into Apple Pay or Google Pay.
   * The missing piece is `socket.live-issuer`.
   */
  'bank.card_wallet_issuer_unset': 'PRECONDITION_FAILED',
  /**
   * Module kill for cards ledger half (`BANK_CARDS_ENABLED=false` / bank.cards).
   * Issue and authorise refuse.
   */
  'bank.cards_disabled': 'SERVICE_UNAVAILABLE',
  /** The owner cannot lift a freeze an operator placed. */
  'bank.card_operator_frozen': 'CONFLICT',
  /** This person's card money is partner-held, but the card programme has no partner that holds authorisations. */
  'bank.card_partner_holds_unset': 'PRECONDITION_FAILED',
  /** The card partner has not said whether it holds the crypto or pulls from the wallet; nothing was decided. */
  'bank.card_partner_mode_not_known': 'PRECONDITION_FAILED',
  /** The card partner reports no balance for this asset, so no hold can be asked; nothing was decided. */
  'bank.card_partner_balance_not_known': 'PRECONDITION_FAILED',
  /** The card partner refused a capture above what it holds for the authorisation. Nothing moved. */
  'bank.card_partner_capture_exceeds_hold': 'BAD_REQUEST',
  /** The card partner says the hold is already captured, released or expired. Nothing moved. */
  'bank.card_partner_hold_closed': 'CONFLICT',
  /** The card partner refused a refund above what was captured. Nothing moved. */
  'bank.card_partner_refund_exceeds_capture': 'BAD_REQUEST',
  /** The card partner saw one business key with a different instruction. Nothing moved. */
  'bank.card_partner_key_conflict': 'CONFLICT',
  /** The card partner has no record of this hold (the TEST partner forgets on a restart). */
  'bank.card_partner_hold_not_found': 'PRECONDITION_FAILED',
  /** A refund on a card held in INTAFACED's own ledger is not built (`card-service.ts`, WHAT IS NOT HERE). */
  'bank.card_refund_not_built': 'PRECONDITION_FAILED',
  /** A refund needs a settled capture first. */
  'bank.card_refund_nothing_captured': 'CONFLICT',
  /** This authorisation's one refund was asked for a different amount. */
  'bank.card_refund_amount_conflict': 'CONFLICT',
  /** A card control names a category the programme doesn't list, an empty merchant, or a country that isn't two letters. */
  'bank.card_control_invalid': 'BAD_REQUEST',
  /** The control to lift is not a live control of this card. */
  'bank.card_control_not_found': 'NOT_FOUND',
} as const satisfies BankErrorTable;
