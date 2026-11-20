import type { BankErrorTable } from './bank-error-table.js';

/**
 * svc-bank refusals thrown from more than one folder, or from the service's root files.
 * A refusal one folder throws lives in that folder's own `bank-errors.ts` (see `errors.ts`).
 */
export const SHARED_BANK_ERRORS = {
  'bank.space_not_found': 'NOT_FOUND',

  // ── The codes that used to fall through `default:` ────────────────────
  //
  // Every one of them was already reaching the client as a 400 carrying its
  // domain sentence. Nothing about that is wrong FOR AN OWNER — "Space
  // 'Holiday fund' is locked until …" is the most useful thing this service
  // can say to the person who set the lock, and the ADR is explicit that the
  // failure mode to avoid is a service so cautious the owner cannot act. So
  // the messages are kept and the codes are now DECIDED rather than
  // defaulted; who is allowed to hear them is settled one layer up, at the
  // call site that knows whose row it is.
  //
  // The split follows the loans block above. A state the row is in that a
  // later request could clear is 409; a request that is simply wrong for the
  // rules is 400.
  'bank.space_archived': 'CONFLICT',
  'bank.space_locked': 'CONFLICT',
  'bank.asset_mismatch': 'BAD_REQUEST',

  'bank.same_space': 'BAD_REQUEST',
  /** A standing order edit named a revision that is no longer current: another edit landed first. */
  'bank.schedule_revision_conflict': 'CONFLICT',
  // The next run is too close: the request is fine, the moment is not.
  /** A standing order edit inside the owner-set cutoff before its next run. */
  'bank.schedule_cutoff': 'CONFLICT',
  /** The standing order edit cutoff (BANK_SCHEDULE_EDIT_CUTOFF_MINUTES) is not published, so no edit is open. */
  'bank.schedule_edit_cutoff_unset': 'PRECONDITION_FAILED',
  'bank.pool_closed': 'CONFLICT',
  /** An ops pool create whose term does not fit its kind: a fixed pool needs days, a flexible one has none. */
  'bank.pool_terms_invalid': 'BAD_REQUEST',
  /** A fixed-term pool's rate is the term's promise: it never changes; a new rate is a new pool. */
  'bank.fixed_pool_rate_locked': 'CONFLICT',
  /** A rate change that names the rate already in force records nothing. */
  'bank.pool_rate_unchanged': 'CONFLICT',
  /** The owner has not published the staking risk wording (`BANK_EARN_RISK_WORDING_JSON`), or it is not in shape. */
  'bank.earn_risk_wording_unset': 'PRECONDITION_FAILED',
  // Not the caller's fault and not something a retry fixes — the pool
  // needs funding (or books reconciled) before this day can accrue.
  'bank.pool_underfunded': 'PRECONDITION_FAILED',
  'bank.below_minimum': 'BAD_REQUEST',
  'bank.not_owner': 'FORBIDDEN',
  /**
   * Recovery will not re-post a collateral lock the ledger definitely refused.
   * Abandon the pending loan, or have the borrower open a new one.
   */
  'bank.loan_collateral_rejected': 'CONFLICT',
  /** The requested principal puts the loan over the product's opening LTV. */
  'bank.ltv_exceeded': 'BAD_REQUEST',
  // CONFLICT rather than BAD_REQUEST: the request is well-formed, it just
  // collides with a loan that already exists under that id on other terms.
  /**
   * A retry reused a loan id but changed the principal.
   *
   * The insert is `ON CONFLICT (id) DO NOTHING`, so a retry reads back the
   * first call's row. Every guard runs on the new input while the payout draws
   * the stored principal — put up dust against a huge pending loan and the
   * service locks the dust and pays out the original amount. Same id must mean
   * same terms; a different amount needs a different id.
   */
  'bank.loan_principal_mismatch': 'CONFLICT',
  /** A mark failed the staleness / deviation / quality guards in prices.ts. */
  'bank.mark_unusable': 'PRECONDITION_FAILED',
  /** No mark at all for an asset the position holds. Never valued at zero. */
  'bank.mark_missing': 'PRECONDITION_FAILED',

  // svc-trade's prices could not be read. A retry later may work; the
  // caller sent nothing wrong.
  /**
   * `portfolio.summary` needs market prices and svc-trade's tickers could not be
   * read (down, slow, or an unreadable answer). The total is refused whole: a
   * sum that quietly omitted the coins it could not price would be a wrong number.
   */
  'bank.prices_unavailable': 'SERVICE_UNAVAILABLE',
  /** `portfolio.valueOverTime`: the range must start before it ends, and before now (or is shorter than one chart step). */
  'bank.value_range_invalid': 'BAD_REQUEST',
  /** `portfolio.valueOverTime`: the range starts too long ago for one candle read to price it. */
  'bank.value_range_too_long': 'BAD_REQUEST',
  /** `portfolio.valueOverTime`: more ledger movements in the range than one answer carries. */
  'bank.value_history_too_large': 'BAD_REQUEST',
  /**
   * `portfolio.summary` was asked to show values in a currency other than USD or BTC. The platform has no FX rate source
   * (the rate source is an owner value and stays blank), so the call refuses by name and keeps no guess.
   */
  'bank.fx_rate_unset': 'PRECONDITION_FAILED',
  /**
   * Loan health has no price. The health slot stays empty.
   * The missing piece is price. A stored last mark is not a substitute.
   */
  'bank.loan_health_price_unset': 'PRECONDITION_FAILED',
  /** A mark was zero or negative — a broken feed, not a cheap asset. */
  'bank.mark_invalid': 'PRECONDITION_FAILED',

  // Named refusals where the platform, not the caller, is missing something.
  // Same shape and the same reason as `bank.no_liquidation_counterparty`.
  /**
   * NO ISSUER IS CONFIGURED, so this deployment has no card programme.
   *
   * The sibling of `bank.no_liquidation_counterparty`, and here for the same
   * reason: a missing counterparty is a refusal, never a default. A card service
   * that quietly approved authorisations with no issuer behind it would be
   * claiming a card programme exists — which is a commercial relationship
   * (`socket.live-issuer`), not a line of code. Refusing by name is the only
   * honest thing an unconfigured deployment can do.
   */
  'bank.no_card_issuer': 'PRECONDITION_FAILED',
  'bank.card_not_found': 'BAD_REQUEST',
  /** Frozen or closed. An authorisation on it is declined, never approved. */
  'bank.card_not_active': 'BAD_REQUEST',
  /**
   * Cashback was owed and the rewards pot could not pay it.
   *
   * `loanBadDebt`'s rule applied to the other direction: a platform that cannot
   * name where value came from should not be able to conjure it. Cashback is
   * paid out of the rewards engine, which is funded from real bank revenue — so
   * an empty pot means the promised rate is not currently earned, and an
   * operator seeing this refuse has learned something true on the day it became
   * true. The capture it belongs to still stands; only the reward refuses.
   */
  'bank.cashback_pot_unfunded': 'PRECONDITION_FAILED',
  /**
   * Card rewards have no issuer. A cashback rate on the card is not a balance.
   * The missing piece is an outside company, the card issuer.
   */
  'bank.rewards_issuer_unset': 'PRECONDITION_FAILED',
  /** A physical card was asked for without a delivery address. */
  'bank.card_shipping_address_required': 'BAD_REQUEST',
  /** The owner has not published a cashback rate for this rank card tier. */
  'bank.cashback_rate_unset': 'PRECONDITION_FAILED',
  /** The owner has not published the card programme (countries, card limits, terms), so no card can be ordered. */
  'bank.card_eligibility_unset': 'PRECONDITION_FAILED',
  'bank.card_spend_assets_unset': 'PRECONDITION_FAILED',
  /** A pay-from order names an asset the card partner cannot spend from (J-bank-29 #2). */
  'bank.card_pay_from_not_offered': 'PRECONDITION_FAILED',
  /** The owner has not published the dispute cap for this asset, so no credit or cardholder decision is made (J-bank-27 #4). */
  'bank.card_dispute_cap_unset': 'PRECONDITION_FAILED',
  /** A card programme staff member with the viewer role cannot change programme settings (J-bank-26 #7). (J-bank-26) */
  'bank.card_programme_viewer': 'FORBIDDEN',
  /** The cardholder sanctions list (BANK_CARDHOLDER_SANCTIONS) is not set, so no cardholder can be screened or created. (J-bank-26) */
  'bank.cardholder_screening_unset': 'PRECONDITION_FAILED',
  /** No printer or courier is connected (hardware); only the test stand-in reports a delivery. */
  'bank.card_printer_unset': 'PRECONDITION_FAILED',
  /**
   * No live issuer can return a PAN. card-sim has no card number.
   * The missing piece is `socket.live-issuer`.
   */
  'bank.card_pan_issuer_unset': 'PRECONDITION_FAILED',
  /** The owner has not set how many wrong PIN tries block a card (`BANK_CARD_PIN_TRY_LIMIT`), so no PIN is checked. */
  'bank.card_pin_try_limit_unset': 'PRECONDITION_FAILED',
  /** The owner has not set how many wrong 3D Secure codes lock a challenge (`BANK_CARD_3DS_TRY_LIMIT`), so none is checked. */
  'bank.card_3ds_try_limit_unset': 'PRECONDITION_FAILED',
  /**
   * NO RAMP PROGRAMME IS CONFIGURED.
   *
   * Sibling of `bank.no_card_issuer` / `bank.no_liquidation_counterparty`: a
   * missing counterparty (here: an unchosen crypto ledger half) is a refusal,
   * never a default to a simulator. Fiat is not selectable at all — see
   * `bank.fiat_ramp_socket`.
   */
  'bank.no_ramp_rail': 'PRECONDITION_FAILED',
  'bank.fiat_ramp_socket': 'PRECONDITION_FAILED',
  /**
   * Crypto off-ramp has no published fee schedule. Zero is not assumed.
   * Kind fiat still refuses `bank.fiat_ramp_socket` before this.
   */
  'bank.offramp_fee_unset': 'PRECONDITION_FAILED',
  /**
   * Crypto custody is not connected. No asset list, minimum, address, or
   * incoming deposit is invented.
   */
  'bank.deposit_custody_unset': 'PRECONDITION_FAILED',
  /** BANK_DEPOSIT_ADDRESS_CAP is not published, so no extra deposit address is made (W-deposit-02). */
  'bank.deposit_address_cap_unset': 'PRECONDITION_FAILED',
  /** The person already holds the owner's cap of open deposit addresses for this asset on this network. */
  'bank.deposit_address_cap_reached': 'PRECONDITION_FAILED',
  /** BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS is not published, so an extra address would have no expiry: none is made. */
  'bank.deposit_address_expiry_unset': 'PRECONDITION_FAILED',
  'bank.ramp_invalid_amount': 'BAD_REQUEST',
  /**
   * Asset id is blank or not a usable crypto ledger symbol. The crypto half
   * does not invent an allowlist of commercial pairs — that is product law —
   * but it refuses the empty / whitespace shape before a row or deposit posts.
   */
  'bank.ramp_invalid_asset': 'BAD_REQUEST',
  'bank.ramp_invalid_destination': 'BAD_REQUEST',
  // The ledger's asset registry could not be read; nothing was saved. Retry later.
  /** svc-ledger's asset and network registry could not be read, or is not connected. Nothing was saved. */
  'bank.asset_registry_unavailable': 'SERVICE_UNAVAILABLE',
  /** The asset does not allow withdrawals, or the network is not listed for it in the registry. Nothing was saved. */
  'bank.withdraw_network_unsupported': 'BAD_REQUEST',
  /** A mixed-case EVM address whose letter case does not match its EIP-55 checksum, so a character may have changed. Nothing was saved. */
  'bank.address_checksum_mismatch': 'BAD_REQUEST',
  /**
   * The address shows like one already in the customer's book (same start and end, as the book shortens it) but is a
   * different address: the shape of address poisoning. Saved only once the customer confirms it. Nothing was saved.
   */
  'bank.address_lookalike': 'BAD_REQUEST',
  /** The address is on the owner's destination fraud list (W-withdraw-03), on its network or on every network. Nothing was saved. */
  'bank.destination_fraud_listed': 'BAD_REQUEST',
  /** The address is on the owner's destination sanctions list (`BANK_DESTINATION_SANCTIONS`). Nothing was saved. */
  'bank.destination_sanctions_listed': 'BAD_REQUEST',
  /** The owner's destination sanctions list is unset, blank or unreadable, so no address is screened or saved. Nothing was saved. */
  'bank.destination_sanctions_unset': 'PRECONDITION_FAILED',
  /** The owner has not published how long a wallet proof offer stays open (`BANK_WALLET_PROOF_WINDOW_MINUTES`). Nothing was offered. */
  'bank.wallet_proof_window_unset': 'PRECONDITION_FAILED',
  /** The owner has not published how long a verified wallet proof holds (`BANK_WALLET_PROOF_VALID_DAYS`). Nothing was recorded. */
  'bank.wallet_proof_validity_unset': 'PRECONDITION_FAILED',
  /**
   * Offramp cooling hours are owner-set (PTX-M17-R03). Blank, unset,
   * non-integer, or negative refuse — never invent 24h and skip to withdrawHold.
   */
  'bank.offramp_cooling_unset': 'PRECONDITION_FAILED',
  /**
   * Owner cooling hours are set, dest exists, and dest `updated_at` is still
   * inside the window. Distinct from unset (no hours) and missing dest.
   */
  'bank.offramp_cooling_active': 'PRECONDITION_FAILED',
  /** Persisted dest missing — later withdraw has no real ref before withdrawHold. */
  'bank.withdraw_destination_missing': 'PRECONDITION_FAILED',
  /** Another saved address of this customer already has this label (case ignored). */
  'bank.destination_label_taken': 'PRECONDITION_FAILED',
  /** No banking partner is wired, so there are no account details to show or request. The blocker is named `rail.bank`. */
  'rail.bank': 'PRECONDITION_FAILED',
  /** The owner has not published which currencies have account details. Nothing is listed; no list is invented. */
  'bank.account_details_currencies_unset': 'PRECONDITION_FAILED',
  /** The owner has not published who can open an account. No eligibility statement is shown. */
  'bank.eligibility_unset': 'PRECONDITION_FAILED',
  /** The address book holds as many entries as the owner allows. */
  'bank.address_book_full': 'PRECONDITION_FAILED',
  /** The linked account is not verified: only a banking partner (`rail.bank`) can verify it, so it cannot be cashed out to. */
  'bank.linked_account_unverified': 'PRECONDITION_FAILED',
  /** The owner has not set how many addresses a book may hold. Saving refuses; no number is invented. */
  'bank.address_book_cap_unset': 'PRECONDITION_FAILED',
  /** Dest user has no primary space — refuse before ledger-client posts. */
  'bank.dest_user_missing': 'PRECONDITION_FAILED',
  /**
   * The recipient cannot be credited. Identity says they are frozen, closed, or
   * unknown, and bank says only that — one code, one message, no state named, so
   * it matches identity's uniform `{ found: false }`. Refused before any posting.
   */
  'bank.recipient_cannot_receive': 'PRECONDITION_FAILED',
  'bank.sender_cannot_send': 'PRECONDITION_FAILED',
  // Identity could not answer; nothing was posted. Retry with the same id.
  /** Identity could not answer the recipient check (outage, timeout, bad reply). Nothing posted; retry with the same id. */
  'bank.recipient_check_unavailable': 'SERVICE_UNAVAILABLE',
  /** No IDENTITY_URL: this deployment cannot check recipients, so it refuses to credit another user. A deployment gap, not an outage. */
  'bank.recipient_check_unset': 'PRECONDITION_FAILED',
  /** The owner's security lock holds (W-withdraw-09): no withdrawal address is added or removed and nothing is sent to one until it ends. */
  'bank.security_locked': 'PRECONDITION_FAILED',
  /** Identity could not answer the security lock check (outage, timeout, bad reply). Nothing changed; retry. */
  'bank.security_lock_unavailable': 'SERVICE_UNAVAILABLE',
  /** No IDENTITY_URL: this deployment cannot check the security lock, so address changes and sends refuse. A deployment gap. */
  'bank.security_lock_unset': 'PRECONDITION_FAILED',
  /** The owner froze the account themselves (I-account-lifecycle-08): no address change and nothing sent until they lift it. */
  'bank.account_frozen_self': 'PRECONDITION_FAILED',
  /** No owner-set `BANK_ADDRESS_APPROVAL_LINK_MINUTES`, so no approval link is mailed. */
  'bank.address_approval_link_unset': 'PRECONDITION_FAILED',
  /** Same (rail, railRef), (user, clientRef), or offramp id already booked with different facts. */
  'bank.ramp_conflict': 'BAD_REQUEST',
  /** The owner has not published how long a new recipient waits (`BANK_PAYEE_COOLING_HOURS`); a send to one refuses. */
  'bank.payee_cooling_unset': 'PRECONDITION_FAILED',

  // Kill switches. Same 503 class as the matching HTTP job endpoints —
  // operator flipped the flag off; tRPC must not be a back door past it.
  /**
   * Standing-order runner kill switch (`SCHEDULED_TRANSFERS_ENABLED=false`).
   *
   * Same refusal as the HTTP job endpoint. Both surfaces must agree: an operator
   * who flipped the flag off must not still fire due schedules via tRPC.
   */
  'bank.transfers_disabled': 'SERVICE_UNAVAILABLE',
  /**
   * Earn daily interest kill switch (`INTEREST_ACCRUAL_ENABLED=false`).
   * HTTP job and `ops.accrueInterest` must agree — tRPC is not a back door.
   */
  'bank.interest_accrual_disabled': 'SERVICE_UNAVAILABLE',
  /**
   * Loan interest capitalisation kill switch (`LOAN_ACCRUAL_ENABLED=false`).
   * Same parity rule as transfers / earn.
   */
  'bank.loan_accrual_disabled': 'SERVICE_UNAVAILABLE',
  /**
   * Loan risk-sweep kill switch (`LOAN_RISK_SWEEP_ENABLED=false`).
   * Defaults off in production; tRPC must not liquidate past the HTTP stop.
   */
  'bank.loan_risk_sweep_disabled': 'SERVICE_UNAVAILABLE',
  /**
   * Cross-asset DCA needs a convert rate counterparty. This service never
   * invents §8 rates — create and run both refuse by this name when no
   * ConvertPort is configured.
   */
  'bank.auto_invest_rate_unset': 'PRECONDITION_FAILED',
  'bank.auto_invest_target_invalid': 'BAD_REQUEST',
  'bank.auto_invest_run_failed': 'CONFLICT',
  'bank.auto_invest_disabled': 'SERVICE_UNAVAILABLE',
  /** BANK_BUSINESS_INVITE_MINUTES is blank: no team invite is sent until the owner sets it. */
  'bank.business_invite_lifetime_unset': 'PRECONDITION_FAILED',
  /** A bill file with no name, empty, or over 1 MiB. */
  'bank.bill_file_invalid': 'BAD_REQUEST',
  /** The partner quotes no move between a person's own accounts. Nothing was asked. */
  'bank.partner_quote_unavailable': 'PRECONDITION_FAILED',
  /** No payment by that id is the caller's. */
  'bank.payment_not_found': 'NOT_FOUND',
  /** No webhook endpoint by that id is the caller's. */
  'bank.webhook_endpoint_not_found': 'NOT_FOUND',
  /** The partner offers no statement, or does not say how far back its record reaches. */
  'bank.partner_statement_unavailable': 'PRECONDITION_FAILED',
  /**
   * Multi-recipient payroll named a different asset than the debit pot.
   * A mix would need an FX / withholding rate this service does not invent.
   */
  'bank.business_payroll_rate_unset': 'PRECONDITION_FAILED',
  /** Retry reused a payroll id with different account, source, or lines. */
  'bank.business_payroll_conflict': 'CONFLICT',
  /**
   * Job batch size unpublished. Omit used to invent 100 / 200 / 500 / 1_000 rows.
   * Blank / non-finite refuses. Owner may pass those magnitudes explicitly.
   */
  'bank.earn_resume_pending_limit_unset': 'BAD_REQUEST',
  'bank.earn_renew_batch_limit_unset': 'BAD_REQUEST',
  'bank.earn_release_batch_limit_unset': 'BAD_REQUEST',
  'bank.loan_resume_pending_limit_unset': 'BAD_REQUEST',
  'bank.loan_accrue_batch_limit_unset': 'BAD_REQUEST',
  'bank.transfer_due_limit_unset': 'BAD_REQUEST',
  'bank.auto_invest_batch_limit_unset': 'BAD_REQUEST',
  'bank.loan_risk_sweep_limit_unset': 'BAD_REQUEST',
  /** earn.pools catalog page size unpublished. Blank is not 50 — never dump every pool. */
  'bank.earn_pools_list_limit_unset': 'BAD_REQUEST',
  /** loans.products catalog page size unpublished. Blank is not 50 — never dump every product. */
  'bank.loan_products_list_limit_unset': 'BAD_REQUEST',
  /** spaces.list page size unpublished. Blank is not 50 — never dump every live space. */
  'bank.spaces_list_limit_unset': 'BAD_REQUEST',
  /** earn.positions page size unpublished. Blank is not 50 — never dump every active position. */
  'bank.earn_positions_list_limit_unset': 'BAD_REQUEST',
  /** earn.interestHistory page size unpublished. Blank is not 50 — never dump every paid day. */
  'bank.earn_interest_list_limit_unset': 'BAD_REQUEST',
  /** earn.rateHistory page size unpublished. Blank is not 50 — never dump every recorded rate. */
  'bank.earn_rate_history_limit_unset': 'BAD_REQUEST',
  /** sharedPots.list or sharedPots.activity page size unpublished. Blank is not 50. */
  'bank.shared_pots_list_limit_unset': 'BAD_REQUEST',
  /** BANK_SHARED_POT_INVITE_MINUTES or BANK_SHARED_POT_PEOPLE_CAP is blank: no pot is shared (BK-acct-09 decision note). */
  'bank.joint_unset': 'PRECONDITION_FAILED',
  /** A shared pot's viewer moving money into it, or a member taking money out of a pot they do not own. */
  'bank.space_forbidden': 'FORBIDDEN',
  /** loans.list page size unpublished. Blank is not 50 — never dump every loan. */
  'bank.loans_list_limit_unset': 'BAD_REQUEST',
  /** cards.list page size unpublished. Blank is not 50 — never dump every card. */
  'bank.cards_list_limit_unset': 'BAD_REQUEST',
  /** cards.authorizations page size unpublished. Blank is not 50 — never dump every decision. */
  'bank.card_authorizations_list_limit_unset': 'BAD_REQUEST',
  /** transfers.listSchedules page size unpublished. Blank is not 50 — never dump every standing order. */
  'bank.schedules_list_limit_unset': 'BAD_REQUEST',
  /** transfers.executions page size unpublished. Blank is not 50 — never dump every firing. */
  'bank.executions_list_limit_unset': 'BAD_REQUEST',
  /** autoInvest.list page size unpublished. Blank is not 50 — never dump every rule. */
  'bank.auto_invest_list_limit_unset': 'BAD_REQUEST',
  /** business.list page size unpublished. Blank is not 50 — never dump every account. */
  'bank.business_list_limit_unset': 'BAD_REQUEST',
  /** business.pending page size unpublished. Blank is not 50 — never dump every pending approval. */
  'bank.business_pending_list_limit_unset': 'BAD_REQUEST',
  /** business.approvals page size unpublished. Blank is not 50 — never dump every approval. */
  'bank.business_approvals_list_limit_unset': 'BAD_REQUEST',
  /** Identity has no directory for public handles (IDENTITY_URL unset, or the route is not published). */
  'bank.business_directory_unset': 'PRECONDITION_FAILED',
  /** Identity did not answer the directory. Retry. */
  'bank.business_directory_unavailable': 'SERVICE_UNAVAILABLE',

  /** Recipient lookup budget for this caller is spent. */
  'bank.business_directory_rate_limited': 'TOO_MANY_REQUESTS',
  /** ramps.onramps page size unpublished. Blank is not 50 — never dump every on-ramp. */
  'bank.onramps_list_limit_unset': 'BAD_REQUEST',
  /** ramps.offramps page size unpublished. Blank is not 50 — never dump every off-ramp. */
  'bank.offramps_list_limit_unset': 'BAD_REQUEST',
  /**
   * Auto-invest convert `GET /api/v1/markets?limit=` unpublished.
   * Blank is not 50 — trade refuses `trade.markets_limit_unset` (1..500).
   */
  'bank.convert_markets_limit_unset': 'BAD_REQUEST',
  /** Nonsense batch (non-integer / out of range) — not clamped. */
  'bank.validation_failed': 'BAD_REQUEST',

  // The ledger may have committed; the claim is held pending. Retry later
  // with the same id, never with a new one.
  /**
   * An earlier repayment on this loan is still `pending`: its ledger post failed
   * without a definite refusal, so it may have committed (a lost
   * acknowledgement). It counts as covering the debt until the same repayment
   * id is retried or `recover-loan-repayments` re-drives it, so a new event
   * cannot collect the same principal twice.
   */
  'bank.ledger_outcome_unknown': 'SERVICE_UNAVAILABLE',
  // The client must run its step-up sheet (passkey or TOTP) and retry with `stepUpApprovalId`.
  /**
   * Money-out step-up (BANK_STEP_UP_MONEY_OUT=required). This door needs a fresh
   * same-person approval from identity: none was sent, it is spent, expired,
   * another user's, or for another session. The client asks the user again.
   */
  'bank.step_up_required': 'PRECONDITION_FAILED',
  // Identity could not confirm the step-up approval; nothing was posted.
  /** Identity could not answer, or is not wired. Nothing was posted; fail closed. */
  'bank.step_up_unavailable': 'SERVICE_UNAVAILABLE',
  /** A positive fee is published and bankTransfer has no fee leg. Nothing is posted. */
  'bank.personal_transfer_fee_unwired': 'PRECONDITION_FAILED',
  /** PP-money-balance-05: no release period is published, so payments from strangers cannot be held. */
  'bank.stranger_hold_period_unset': 'PRECONDITION_FAILED',
  /** No reminder rule is published (`BANK_REQUEST_REMIND_POLICY_JSON` blank). */
  'bank.reminder_policy_unset': 'PRECONDITION_FAILED',
  'bank.pay_request_notify_unwired': 'PRECONDITION_FAILED',
  /** IDENTITY_URL is unset, so a request cannot name either person. */
  'bank.party_handles_unset': 'PRECONDITION_FAILED',
  /** Identity did not answer a handle lookup. Nothing was created. */
  'bank.party_handles_unavailable': 'SERVICE_UNAVAILABLE',
  /** An operator write named no reason, or fewer than 10 characters. */
  'bank.ops_reason_too_short': 'BAD_REQUEST',
  /** Operator authorisation read (BK-cops-01): unknown or malformed id. */
  'bank.ops_authorization_not_found': 'NOT_FOUND',
  /** The ledger entries of a balance do not add up to the live balance; the page shows the gap and no list. */
  'portfolio.entries_do_not_sum': 'PRECONDITION_FAILED',
  /** A from/to or amount range is backwards. */
  'bank.activity_range': 'BAD_REQUEST',
  /** Statement dates are backwards or longer than 366 days. */
  'bank.statement_range': 'BAD_REQUEST',
  /** More posted lines than a statement file will carry. Narrow the dates. */
  'bank.statement_too_large': 'PRECONDITION_FAILED',
  /** Left to spend needs a budget: none is set (BK-acct-08). */
  'bank.budget_unset': 'PRECONDITION_FAILED',
  /** No plan table is published (BANK_PLANS_JSON), so plans cannot be shown (BK-acct-04). */
  'bank.plans_unset': 'PRECONDITION_FAILED',
  /** No dormancy rule is published (BANK_DORMANCY_RULES_JSON), so no notice is given and no fee taken (RC-bank-01). */
  'bank.dormancy_rule_unset': 'PRECONDITION_FAILED',
  /** A paid plan is a fee posting, and no plan-fee recipe exists in ledger-client yet (BK-acct-04). */
  'bank.plan_fee_unwired': 'PRECONDITION_FAILED',
  /** No service secret, or activity could not be read, so no file was built. */
  'bank.statement_unavailable': 'SERVICE_UNAVAILABLE',
  /** Background exports are not switched on in this deployment: no worker interval or claim lease is set (PF-statements-02). */
  'bank.statement_jobs_unset': 'SERVICE_UNAVAILABLE',
  /** An asset pause change named a revision that is no longer current, or reused a revision with different terms. */
  'bank.ops_revision_conflict': 'CONFLICT',

  'bank.limit_request_not_found': 'NOT_FOUND',
  /** A spend door was refused for funds; carries available/onHold/inEarn figures when they could be read (RC-wallet-09). */
  'bank.insufficient_funds': 'BAD_REQUEST',
  /** The owner has not published the base-tier account terms (`BANK_ACCOUNT_TERMS_JSON`), or they are not in shape (BK-acct-01). */
  'bank.account_terms_unset': 'PRECONDITION_FAILED',
  /** The owner has not published which currencies an account may hold (`BANK_ACCOUNT_CURRENCIES`). */
  'bank.account_currencies_unset': 'PRECONDITION_FAILED',
  /** A currency that is not on the owner's list. */
  'bank.asset_unknown': 'BAD_REQUEST',
  /** The owner has not published how many spaces one account may hold (`BANK_SPACE_LIMIT`) (BK-pots-01). */
  'bank.space_limit_unset': 'PRECONDITION_FAILED',
  /** The account already holds the owner's number of live named spaces. */
  'bank.space_limit_reached': 'PRECONDITION_FAILED',
  /** A pot change that cannot be: a goal of zero or less, a lock date not in the future or earlier than the lock, or the primary space (BK-pots-02). */
  'bank.space_change_invalid': 'BAD_REQUEST',
  /** The owner has not set how long an early unlock waits (`BANK_SPACE_UNLOCK_WAIT_HOURS`), so the pot stays locked to its date (BK-pots-02). */
  'bank.space_unlock_rule_unset': 'PRECONDITION_FAILED',
  /** The owner has not published when incoming payments are sorted (`BANK_INCOME_SORTER_MIN_CREDIT`), so no sorter is made (BK-pots-03). */
  'bank.sorter_terms_unset': 'PRECONDITION_FAILED',
  /** A business profile has no company account of its own in this build, so there is no company terms, currency or detail to show. */
  'bank.company_account_unwired': 'PRECONDITION_FAILED',
  /**
   * The owner has not published a loan fee, and zero is not assumed: the payoff fee (`BANK_LOAN_PAYOFF_FEE`, no payoff quote
   * is given, BK-loan-06) or the origination fee (`BANK_LOAN_ORIGINATION_FEE_BPS`, no new loan is opened, BK-loan-01).
   */
  'bank.loan_fee_unset': 'PRECONDITION_FAILED',
  /** A non-zero loan origination fee is published, but no ledger leg collects it yet, so no loan is opened (BK-loan-01). */
  'bank.loan_fee_unwired': 'PRECONDITION_FAILED',
  /** The owner has not published how long a loan payoff quote stays valid (`BANK_LOAN_PAYOFF_WINDOW_MINUTES`) (BK-loan-06). */
  'bank.loan_payoff_window_unset': 'PRECONDITION_FAILED',
  /** A refund was asked for a collection that took nothing (failed, rejected or not yet due). */
  'bank.dd_refund_not_collected': 'CONFLICT',
  /** Rules that move money by themselves wait for the owner's published terms, so none can be created. */
  'bank.rule_terms_unset': 'PRECONDITION_FAILED',
  /** No bus is wired for standing-order notices, so owed ones stay owed. */
  'bank.scheduled_notify_unwired': 'PRECONDITION_FAILED',
  /** Identity could not answer which accounts a person may claim, or whether a claim's signatures count; nothing moved. */
  'bank.recovery_unavailable': 'SERVICE_UNAVAILABLE',
  /** The partner bank does not offer this feature (currency accounts, spaces, pots or joint accounts); nothing written. */
  'bank.not_offered_by_partner': 'PRECONDITION_FAILED',
  /** The partner bank is not answering; nothing was sent or changed. */
  'bank.partner_unavailable': 'SERVICE_UNAVAILABLE',
  /** The partner's ramp gave no fee, so the pay amount is not known; no quote was kept. */
  'bank.onramp_fee_not_known': 'PRECONDITION_FAILED',
  /** The TEST partner switches exist only on a stack that runs the TEST partner (`BANK_TEST_PARTNER=test`). */
  'bank.test_partner_off': 'PRECONDITION_FAILED',
  /** The custodial layer is off and no partner bank holds this money, so no customer balance is posted. */
  'bank.no_partner_bank': 'PRECONDITION_FAILED',
  /** svc-ledger's platform posting freeze is on, or could not be read: the partner is asked to move nothing. */
  'bank.posting_frozen': 'SERVICE_UNAVAILABLE',
  /** The partner has not reported this balance: "not known", never 0. */
  'bank.partner_balance_not_known': 'PRECONDITION_FAILED',
  /** One side of a move is held at the partner and the other is not; no single partner move can make it. */
  'bank.partner_custody_mismatch': 'PRECONDITION_FAILED',
  /** The partner holds a different move under this business key; nothing was moved. */
  'bank.partner_move_conflict': 'CONFLICT',
  /** The source account at the partner does not hold the amount; nothing was moved. */
  'bank.partner_insufficient_funds': 'CONFLICT',
  /** The partner's answer was lost: the move may have been made. Retry under the same key: it is made at most once. */
  'bank.partner_reply_lost': 'SERVICE_UNAVAILABLE',
  /** A partner move or TEST funding needs an amount above zero. */
  'bank.partner_amount_invalid': 'BAD_REQUEST',
  /** Operations stopped this kind of partner instruction (`partner/partner-stops.ts`); nothing was sent. */
  'bank.partner_stopped': 'SERVICE_UNAVAILABLE',
  /** Whether this kind of partner instruction is stopped could not be read, so nothing was sent. */
  'bank.partner_stop_unreadable': 'SERVICE_UNAVAILABLE',
  /** This payment's partner path is not built yet; nothing was sent. */
  'bank.partner_path_not_built': 'PRECONDITION_FAILED',
  /** No partner holds this person's money and the custodial layer is off (`LEDGER_CUSTODY_LAYER`): nothing was written. */
  'bank.partner_unset': 'PRECONDITION_FAILED',
  /** The owner has not published their requirements for a bank account (BANK_ONBOARDING_REQUIREMENTS_JSON) (BK-acct-05). */
  'bank.onboarding_requirements_unset': 'PRECONDITION_FAILED',
  /** The owner has not published the size cap and types for an answer to an information request (BANK_INFO_REQUEST_UPLOAD_JSON). */
  'bank.info_request_upload_unset': 'PRECONDITION_FAILED',
  /** The bank account is closing or closed: the partner makes no move in or out of it but the closure payout. */
  'bank.account_restricted': 'PRECONDITION_FAILED',
  /** The owner has not published how long a closed account may be reopened (BANK_REOPEN_WINDOW_DAYS). */
  'bank.reopen_window_unset': 'PRECONDITION_FAILED',
  /** The owner has not published the reversal window (BANK_DIRECT_DEPOSIT_REVERSAL_DAYS). */
  'bank.direct_deposit_reversal_window_unset': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
