/**
 * svc-bank's own failure vocabulary.
 *
 * Codes are stable strings because they are what an SLO dashboard groups by and
 * what a client branches on. `bank.pool_underfunded` (an operator alarm: yield
 * we cannot pay) and `ledger.insufficient_funds` (a user with an empty space)
 * are both "the transfer did not happen", and collapsing them into one message
 * would make both unactionable.
 */
export type BankErrorCode =
  | 'bank.space_not_found'
  | 'bank.space_archived'
  | 'bank.space_locked'
  | 'bank.asset_mismatch'
  | 'bank.same_space'
  | 'bank.schedule_not_found'
  | 'bank.schedule_inactive'
  /** Standing-order create omitted a caller-stable schedule id. */
  | 'bank.schedule_id_required'
  /** Retry reused a schedule id with different user, spaces, amount, cadence, or start. */
  | 'bank.schedule_conflict'
  /** A standing order edit named a revision that is no longer current: another edit landed first. */
  | 'bank.schedule_revision_conflict'
  /** A standing order edit inside the owner-set cutoff before its next run. */
  | 'bank.schedule_cutoff'
  /** The standing order edit cutoff (BANK_SCHEDULE_EDIT_CUTOFF_MINUTES) is not published, so no edit is open. */
  | 'bank.schedule_edit_cutoff_unset'
  | 'bank.pool_not_found'
  | 'bank.pool_closed'
  /** An ops pool create reused a pool id with different terms: a new pool needs a new id. */
  | 'bank.pool_conflict'
  /** An ops pool create whose term does not fit its kind: a fixed pool needs days, a flexible one has none. */
  | 'bank.pool_terms_invalid'
  /** A fixed-term pool's rate is the term's promise: it never changes; a new rate is a new pool. */
  | 'bank.fixed_pool_rate_locked'
  /** A rate change that names the rate already in force records nothing. */
  | 'bank.pool_rate_unchanged'
  | 'bank.pool_underfunded'
  /**
   * No open pool carries an operator-configured APR for the requested earn
   * surface. Empty does not mean zero yield: the product refuses rather than
   * inventing a plausible default rate.
   */
  | 'bank.earn_rate_unset'
  | 'bank.below_minimum'
  /** Collateral lock or excess release omitted a caller-stable event id. MAX+1 on omit made a retry a second post. */
  | 'bank.event_id_required'
  | 'bank.native_asset_not_earnable'
  | 'bank.position_not_found'
  | 'bank.position_closed'
  | 'bank.position_locked'
  /**
   * A deposit reused a position id that is already taken by a different one —
   * another user, another pool, or another amount.
   *
   * `bank.loan_principal_mismatch`, for earn. The insert is `ON CONFLICT (id)
   * DO NOTHING`, so without this the second deposit runs against the first
   * one's row: the ledger moves the second caller's value into a stake pot
   * keyed by their own id, the row that gets activated is the first caller's,
   * and `principalOf()` and `stakedOf()` — the two answers this service gives
   * to "how much is staked" — stop agreeing. Same id must mean same deposit.
   */
  | 'bank.position_conflict'
  /** Earn deposit omitted a caller-stable position id. Minting a UUID made a retry a second stake. */
  | 'bank.position_id_required'
  /**
   * Withdraw (or other active-only action) refused while the deposit claim is
   * still `pending` — ledger may have posted, activate may not have. Resume the
   * claim first; do not close a half-open position under the operator's feet.
   */
  | 'bank.position_pending'
  /** Auto-renew asked of a flexible saving, or a pool with no term to renew for: only a fixed-term saving renews. */
  | 'bank.auto_renew_fixed_only'
  /** Auto-renew turned on after the saving's term ended: a term that is over does not renew; take it back or save again. */
  | 'bank.position_matured'
  /** Identity answers the saver's account is frozen, closed or unknown, so the renewal job starts no new term. */
  | 'bank.account_not_active'
  /** One saving's renewal failed for a reason with no code of its own; the job reports it and carries on. */
  | 'bank.earn_renew_failed'
  /**
   * earn_positions.principal disagrees with the ledger earn stake pot.
   * The table is eligibility (who, which pool, `active`); the money is
   * ledger-client. Accrue, principalOf, and poolSize refuse rather than size
   * from a stale column.
   */
  | 'bank.earn_principal_mismatch'
  | 'bank.not_owner'
  // ── Loans (§8.1) ───────────────────────────────────────────────────────
  | 'bank.loan_product_not_found'
  | 'bank.loan_product_closed'
  | 'bank.loan_not_found'
  | 'bank.loan_closed'
  /** Repay refused while a liquidation shortfall is still uncovering insurance. */
  | 'bank.loan_liquidating'
  /** Loan repay omitted a caller-stable event id. A new sequence made a retry a second loanRepay. */
  | 'bank.repayment_id_required'
  /** Draw refused because the loan is not in `pending` — the ordering guard. */
  | 'bank.loan_not_drawable'
  /**
   * Abandon refused: the last post attempt on this pending loan is inside the
   * in-flight bound, so the ledger could still commit it. Wait, then retry.
   */
  | 'bank.loan_attempt_too_recent'
  /**
   * Recovery will not re-post a collateral lock the ledger definitely refused.
   * Abandon the pending loan, or have the borrower open a new one.
   */
  | 'bank.loan_collateral_rejected'
  /** The requested principal puts the loan over the product's opening LTV. */
  | 'bank.ltv_exceeded'
  /**
   * A retry reused a loan id but changed the principal.
   *
   * The insert is `ON CONFLICT (id) DO NOTHING`, so a retry reads back the
   * first call's row. Every guard runs on the new input while the payout draws
   * the stored principal — put up dust against a huge pending loan and the
   * service locks the dust and pays out the original amount. Same id must mean
   * same terms; a different amount needs a different id.
   */
  | 'bank.loan_principal_mismatch'
  /**
   * A retry reused a loan id but changed the opening collateral amount.
   *
   * Sibling of `bank.loan_principal_mismatch`. Principal alone is not "same
   * terms": after a failed first lock the row still holds the first principal,
   * and a retry that names less collateral can pass LTV on the new figure then
   * lock dust while the draw still pays the original principal. Same id must
   * mean the same pledge.
   */
  | 'bank.loan_collateral_mismatch'
  /**
   * A retry reused a loan id that belongs to a different borrower, or names a
   * different product.
   *
   * The sibling of `bank.loan_principal_mismatch` and the same reasoning: the
   * guards run on the new input while the row is the first call's. Hold the
   * principal equal and a second caller was answered out of somebody else's
   * loan — told it was open with none of their own value moved, or, on a
   * `pending` row, driving that borrower's loan with this caller's collateral
   * figure.
   */
  | 'bank.loan_borrower_mismatch'
  /**
   * Borrower cannot fund the collateral lock at open. Distinct from
   * `bank.loan_reserve_underfunded` (platform short) and from a raw
   * `ledger.insufficient_funds` (which would leak past open() and mask the
   * principal-mismatch refusal on a retried id).
   */
  | 'bank.loan_collateral_short'
  /**
   * The lending reserve cannot fund this draw. An operator alarm, not a user
   * error, and deliberately distinct from `ledger.insufficient_funds`: one means
   * the borrower is short, the other means the platform is.
   */
  | 'bank.loan_reserve_underfunded'
  /** Collateral release refused while debt is outstanding. The important one. */
  | 'bank.loan_not_settled'
  /**
   * Liquidation refused because no margin call has been raised or its grace has
   * not expired. §8.1's ordering, as a refusal.
   */
  | 'bank.margin_call_required'
  /** A mark failed the staleness / deviation / quality guards in prices.ts. */
  | 'bank.mark_unusable'
  /** No mark at all for an asset the position holds. Never valued at zero. */
  | 'bank.mark_missing'
  /**
   * `portfolio.summary` needs market prices and svc-trade's tickers could not be
   * read (down, slow, or an unreadable answer). The total is refused whole: a
   * sum that quietly omitted the coins it could not price would be a wrong number.
   */
  | 'bank.prices_unavailable'
  /** `portfolio.valueOverTime`: the range must start before it ends, and before now (or is shorter than one chart step). */
  | 'bank.value_range_invalid'
  /** `portfolio.valueOverTime`: the range starts too long ago for one candle read to price it. */
  | 'bank.value_range_too_long'
  /** `portfolio.valueOverTime`: more ledger movements in the range than one answer carries. */
  | 'bank.value_history_too_large'
  /** `portfolio.valueOverTime`: svc-ledger's holdings history could not be read (or is not wired). Nothing is guessed. */
  | 'bank.value_history_unavailable'
  /**
   * `portfolio.summary` was asked to show values in a currency other than USD or BTC. The platform has no FX rate source
   * (the rate source is an owner value and stays blank), so the call refuses by name and keeps no guess.
   */
  | 'bank.fx_rate_unset'
  /**
   * Loan health has no price. The health slot stays empty.
   * The missing piece is price. A stored last mark is not a substitute.
   */
  | 'bank.loan_health_price_unset'
  /** A mark was zero or negative — a broken feed, not a cheap asset. */
  | 'bank.mark_invalid'
  /** Product thresholds are not ordered coherently. */
  | 'bank.policy_incoherent'
  /** Accrual has not run for so long that compounding the backlog needs a human. */
  | 'bank.accrual_backlog'
  /** Liquidation needs a funded counterparty and there is none. */
  | 'bank.no_liquidation_counterparty'
  /**
   * Collateral is marked in the quote asset and the debt is a different asset.
   * Booking mark × quantity as debt would invent a conversion. Seizure refuses
   * before any ledger post. A same-asset quote may still sell at the mark.
   */
  | 'bank.loan_seizure_cross_asset'
  /**
   * Collateral was exhausted without clearing the debt AND the insurance fund
   * could not cover it. The loudest code in this file.
   */
  | 'bank.bad_debt_uncovered'
  // ── Cards (§8.1, ledger half) ──────────────────────────────────────
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
  | 'bank.no_card_issuer'
  /**
   * `BANK_CARD_ISSUER=card-sim` under live/production posture.
   *
   * The simulator is not an issuing BIN. A deployment that looks live must not
   * issue or authorise as if a scheme counterparty exists. Distinct from
   * `bank.no_card_issuer` (nobody chose an issuer) so an operator is not sent
   * looking for a missing setting when the setting they chose is the simulator.
   */
  | 'bank.card_sim_not_live'
  | 'bank.card_not_found'
  /** Frozen or closed. An authorisation on it is declined, never approved. */
  | 'bank.card_not_active'
  /** The authorisation is larger than the card's per-authorisation ceiling. */
  | 'bank.card_limit_exceeded'
  | 'bank.card_authorization_not_found'
  /** Capture or reversal asked for on an authorisation that was declined. */
  | 'bank.card_authorization_declined'
  /** Already captured or already reversed — the hold is gone either way. */
  | 'bank.card_authorization_closed'
  /** A capture may never exceed what was authorised and held. */
  | 'bank.card_capture_exceeds_authorization'
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
  | 'bank.card_settlement_amount_conflict'
  /**
   * A settlement disagreed with the kind its sequence was claimed for.
   *
   * Capture and reverse both take sequence 0. The unique index makes a second
   * row impossible, which is right once a movement has settled and wrong if the
   * other kind is handed the first kind's ledger transaction while the claim is
   * still pending. A pending capture is not an open door for a reverse, and a
   * pending reversal is not an open door for a capture.
   */
  | 'bank.card_settlement_kind_conflict'
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
  | 'bank.cashback_pot_unfunded'
  /**
   * Card rewards have no issuer. A cashback rate on the card is not a balance.
   * The missing piece is an outside company, the card issuer.
   */
  | 'bank.rewards_issuer_unset'
  /**
   * Cashback for this user is posted in more than one asset.
   * The read will not add those figures into one number.
   */
  | 'bank.rewards_asset_ambiguous'
  /** A physical card was asked for without a delivery address. */
  | 'bank.card_shipping_address_required'
  /** A retried issue disagreed with the card type or delivery address already stored. */
  | 'bank.card_issue_conflict'
  /** A command id was reused for a different card change. */
  | 'bank.card_command_conflict'
  /** A replacement id was reused for a different card, or the reason disagreed. */
  | 'bank.card_replace_conflict'
  /**
   * No live issuer can return a PAN. card-sim has no card number.
   * The missing piece is `socket.live-issuer`.
   */
  | 'bank.card_pan_issuer_unset'
  /**
   * No live issuer can view or set a PIN.
   * The missing piece is `socket.live-issuer`.
   */
  | 'bank.card_pin_issuer_unset'
  /** A PIN was not 4 to 12 digits. The refusal never echoes the PIN. */
  | 'bank.card_pin_invalid'
  /**
   * No live issuer can push a card into Apple Pay or Google Pay.
   * The missing piece is `socket.live-issuer`.
   */
  | 'bank.card_wallet_issuer_unset'
  // ── Ramps (§8.1 / D-S-09, crypto ledger half) ──────────────────────────
  /**
   * NO RAMP PROGRAMME IS CONFIGURED.
   *
   * Sibling of `bank.no_card_issuer` / `bank.no_liquidation_counterparty`: a
   * missing counterparty (here: an unchosen crypto ledger half) is a refusal,
   * never a default to a simulator. Fiat is not selectable at all — see
   * `bank.fiat_ramp_socket`.
   */
  | 'bank.no_ramp_rail'
  /**
   * A live cash ramp has no rail. The programme stays simulated.
   * The missing piece is an outside company, the cash rail.
   */
  | 'bank.live_ramp_unset'
  /**
   * A paycheck deposit has no rail. The missing piece is an outside company,
   * the paycheck rail. This is not business payroll and it posts nothing.
   */
  | 'bank.no_paycheck_rail'
  /**
   * FIAT ON/OFF RAMP IS §13 `socket.psp-partners`.
   *
   * A bank/PSP partner and money-transmission permission are a commercial
   * relationship. Refusing by this code is the whole fiat half of the ADR split.
   */
  | 'bank.fiat_ramp_no_pay_adapter'
  /**
   * A pay adapter is present but none of its rails is a live fiat settle rail
   * (sandbox, absent, or missing onramp/offramp capability). Distinct from
   * empty-port `bank.fiat_ramp_no_pay_adapter` and programme-none `bank.fiat_ramp_socket`.
   */
  | 'bank.no_fiat_rail'
  | 'bank.fiat_ramp_socket'
  /**
   * On-ramp quote has no rate/fee source. A pay amount, fee, or FX rate is not invented.
   * The missing piece is socket.psp-partners plus a published price.
   */
  | 'bank.onramp_rate_unset'
  /** No quote row for this caller. */
  | 'bank.onramp_quote_missing'
  /** The quote's published expiry has passed. Nothing is charged. */
  | 'bank.onramp_quote_expired'
  /** The partner answered without a hosted URL or bank-transfer instruction. None is invented. */
  | 'bank.onramp_instruction_missing'
  /**
   * Crypto off-ramp has no published fee schedule. Zero is not assumed.
   * Kind fiat still refuses `bank.fiat_ramp_socket` before this.
   */
  | 'bank.offramp_fee_unset'
  /** Fee plus net does not equal the amount. The service does not adjust either figure. */
  | 'bank.offramp_fee_inconsistent'
  /**
   * Crypto custody is not connected. No asset list, minimum, address, or
   * incoming deposit is invented.
   */
  | 'bank.deposit_custody_unset'
  /** Custody published a catalogue or address this service will not repeat. */
  | 'bank.deposit_catalogue_invalid'
  /** The asset or network is not in the published catalogue. */
  | 'bank.deposit_asset_unpublished'
  /** The owner switched deposits of this asset on this network off: no address is issued. */
  | 'bank.deposit_network_halted'
  /** Custody returned more incoming deposits than this door will publish. None are dropped. */
  | 'bank.deposit_pending_unbounded'
  /** BANK_DEPOSIT_ADDRESS_CAP is not published, so no extra deposit address is made (W-deposit-02). */
  | 'bank.deposit_address_cap_unset'
  /** The person already holds the owner's cap of open deposit addresses for this asset on this network. */
  | 'bank.deposit_address_cap_reached'
  /** BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS is not published, so an extra address would have no expiry: none is made. */
  | 'bank.deposit_address_expiry_unset'
  /** Every address number (up to 9999) for this person, asset and network has been used; numbers are never reused. */
  | 'bank.deposit_address_numbers_used'
  /** No deposit address of this person has that asset, network and number. */
  | 'bank.deposit_address_not_found'
  /** A deposit address label must be 1 to 40 characters with no space at either end, or empty to clear it. */
  | 'bank.deposit_address_label_invalid'
  | 'bank.ramp_invalid_amount'
  /**
   * Asset id is blank or not a usable crypto ledger symbol. The crypto half
   * does not invent an allowlist of commercial pairs — that is product law —
   * but it refuses the empty / whitespace shape before a row or deposit posts.
   */
  | 'bank.ramp_invalid_asset'
  | 'bank.ramp_invalid_destination'
  /** svc-ledger's asset and network registry could not be read, or is not connected. Nothing was saved. */
  | 'bank.asset_registry_unavailable'
  /** The asset does not allow withdrawals, or the network is not listed for it in the registry. Nothing was saved. */
  | 'bank.withdraw_network_unsupported'
  /** A mixed-case EVM address whose letter case does not match its EIP-55 checksum, so a character may have changed. Nothing was saved. */
  | 'bank.address_checksum_mismatch'
  /**
   * The address shows like one already in the customer's book (same start and end, as the book shortens it) but is a
   * different address: the shape of address poisoning. Saved only once the customer confirms it. Nothing was saved.
   */
  | 'bank.address_lookalike'
  /** The address is on the owner's destination fraud list (W-withdraw-03), on its network or on every network. Nothing was saved. */
  | 'bank.destination_fraud_listed'
  /** The destination fraud list could not be read, so the address was refused rather than assumed safe. Nothing was saved. */
  | 'bank.destination_fraud_list_unreadable'
  /** The owner has not published how long a wallet proof offer stays open (`BANK_WALLET_PROOF_WINDOW_MINUTES`). Nothing was offered. */
  | 'bank.wallet_proof_window_unset'
  /** The owner has not published how long a verified wallet proof holds (`BANK_WALLET_PROOF_VALID_DAYS`). Nothing was recorded. */
  | 'bank.wallet_proof_validity_unset'
  /** No open wallet proof of this customer's has that id, or its saved address is gone or changed. */
  | 'bank.wallet_proof_not_found'
  /** The proof offer lapsed before it was signed. Start a new one. */
  | 'bank.wallet_proof_expired'
  /** The text pasted is not a 65-byte signature of the proof message. */
  | 'bank.wallet_proof_signature_invalid'
  /** The message was signed by a different address from the saved one. The offer stays open. */
  | 'bank.wallet_proof_wrong_signer'
  /** The proof is already complete with another signature, or changed while it was checked. */
  | 'bank.wallet_proof_conflict'
  /**
   * Offramp cooling hours are owner-set (PTX-M17-R03). Blank, unset,
   * non-integer, or negative refuse — never invent 24h and skip to withdrawHold.
   */
  | 'bank.offramp_cooling_unset'
  /**
   * Owner cooling hours are set, dest exists, and dest `updated_at` is still
   * inside the window. Distinct from unset (no hours) and missing dest.
   */
  | 'bank.offramp_cooling_active'
  /** Persisted dest missing — later withdraw has no real ref before withdrawHold. */
  | 'bank.withdraw_destination_missing'
  /** Another saved address of this customer already has this label (case ignored). */
  | 'bank.destination_label_taken'
  /** No banking partner is wired, so there are no account details to show or request. The blocker is named `rail.bank`. */
  | 'rail.bank'
  /** The owner has not published which currencies have account details. Nothing is listed; no list is invented. */
  | 'bank.account_details_currencies_unset'
  /** The currency asked for is not one the owner publishes account details for. */
  | 'bank.account_details_currency_unknown'
  /** The banking partner did not answer. Nothing was changed. */
  | 'bank.account_details_unavailable'
  /** The owner has not published who can open an account. No eligibility statement is shown. */
  | 'bank.eligibility_unset'
  /** The address book holds as many entries as the owner allows. */
  | 'bank.address_book_full'
  /** A linked bank account's IBAN, name or holder name is not usable. Nothing was linked. */
  | 'bank.linked_account_invalid'
  /** The customer has as many linked bank accounts as the owner's address-book cap allows. */
  | 'bank.linked_accounts_full'
  /** The linked account is not verified: only a banking partner (`rail.bank`) can verify it, so it cannot be cashed out to. */
  | 'bank.linked_account_unverified'
  /** The amount to cash out is more than the ledger's available balance for the asset. Nothing was kept. */
  | 'bank.cash_out_over_available'
  /** No linked bank account of this customer has this id. */
  | 'bank.linked_account_not_found'
  /** No cash-out of this customer has this id. */
  | 'bank.cash_out_not_found'
  /** The cash-out was not paid out (refused, still processing or failed), so it has no receipt. */
  | 'bank.cash_out_receipt_not_ready'
  /** No receipt signing key is set, so no cash-out receipt is made. */
  | 'bank.cash_out_receipt_signing_unset'
  /** The owner has not set how many addresses a book may hold. Saving refuses; no number is invented. */
  | 'bank.address_book_cap_unset'
  /** Dest user has no primary space — refuse before ledger-client posts. */
  | 'bank.dest_user_missing'
  /**
   * The recipient cannot be credited. Identity says they are frozen, closed, or
   * unknown, and bank says only that — one code, one message, no state named, so
   * it matches identity's uniform `{ found: false }`. Refused before any posting.
   */
  | 'bank.recipient_cannot_receive'
  | 'bank.sender_cannot_send'
  /** Identity could not answer the recipient check (outage, timeout, bad reply). Nothing posted; retry with the same id. */
  | 'bank.recipient_check_unavailable'
  /** No IDENTITY_URL: this deployment cannot check recipients, so it refuses to credit another user. A deployment gap, not an outage. */
  | 'bank.recipient_check_unset'
  /** The owner's security lock holds (W-withdraw-09): no withdrawal address is added or removed and nothing is sent to one until it ends. */
  | 'bank.security_locked'
  /** Identity could not answer the security lock check (outage, timeout, bad reply). Nothing changed; retry. */
  | 'bank.security_lock_unavailable'
  /** No IDENTITY_URL: this deployment cannot check the security lock, so address changes and sends refuse. A deployment gap. */
  | 'bank.security_lock_unset'
  /** The owner froze the account themselves (I-account-lifecycle-08): no address change and nothing sent until they lift it. */
  | 'bank.account_frozen_self'
  /** The address was approved already, so there is nothing to approve or mail. */
  | 'bank.address_approval_not_pending'
  /** Approving from the device (or the sign-in, where no device is named) that saved the address: another one, or the link, must. */
  | 'bank.address_approval_same_device'
  /** The saving or the approving sign-in is not named on its access token, so a different device cannot be told; use the link. */
  | 'bank.address_approval_device_unknown'
  /** Identity says the approving device is removed, expired, trusted only by signing in, or the new-device check is off. */
  | 'bank.address_approval_device_untrusted'
  /** Identity could not say whether the approving device may approve (outage, no IDENTITY_URL). Nothing was approved. */
  | 'bank.address_approval_device_unavailable'
  /** No owner-set `BANK_ADDRESS_APPROVAL_LINK_MINUTES`, so no approval link is mailed. */
  | 'bank.address_approval_link_unset'
  /** Not a link sent to this account (unknown, malformed, or spent on an address still waiting). */
  | 'bank.address_approval_link_invalid'
  /** A newer link was sent for the address; only the newest works. */
  | 'bank.address_approval_link_replaced'
  /** The link's time ran out; the customer asks for a new one. */
  | 'bank.address_approval_link_expired'
  /** Identity could not take the mail (no mail service, outage, bad reply). Nothing was sent. */
  | 'bank.address_approval_mail_unavailable'
  /** The account has no confirmed email address, so no link can be mailed. */
  | 'bank.address_approval_email_unproved'
  /** Same (rail, railRef), (user, clientRef), or offramp id already booked with different facts. */
  | 'bank.ramp_conflict'
  /** A send over a bank rail with a recipient field that rail's form refuses (the message names the field). Nothing kept. */
  | 'bank.rail_send_invalid'
  /** A send-over-a-bank-rail request id already kept on other terms, or by someone else. Nothing changed. */
  | 'bank.rail_send_conflict'
  /** A send over a bank rail for more than the space's available balance, read from the ledger. Nothing kept. */
  | 'bank.rail_send_over_available'
  /** A saved bank-rail recipient that is not the caller's, was removed, or does not exist. Not found and not yours read the same. */
  | 'bank.payee_not_found'
  /** The owner has not published how long a new recipient waits (`BANK_PAYEE_COOLING_HOURS`); a send to one refuses. */
  | 'bank.payee_cooling_unset'
  /** The recipient is inside the owner's cooling-off window; the message names when it ends. Nothing kept. */
  | 'bank.payee_cooling_active'
  /** An invite emails the recipient a link; no email delivery is connected, so it is refused by name. */
  | 'bank.payee_invite_unwired'
  /**
   * Standing-order runner kill switch (`SCHEDULED_TRANSFERS_ENABLED=false`).
   *
   * Same refusal as the HTTP job endpoint. Both surfaces must agree: an operator
   * who flipped the flag off must not still fire due schedules via tRPC.
   */
  | 'bank.transfers_disabled'
  /**
   * Earn daily interest kill switch (`INTEREST_ACCRUAL_ENABLED=false`).
   * HTTP job and `ops.accrueInterest` must agree — tRPC is not a back door.
   */
  | 'bank.interest_accrual_disabled'
  /**
   * Loan interest capitalisation kill switch (`LOAN_ACCRUAL_ENABLED=false`).
   * Same parity rule as transfers / earn.
   */
  | 'bank.loan_accrual_disabled'
  /**
   * Loan risk-sweep kill switch (`LOAN_RISK_SWEEP_ENABLED=false`).
   * Defaults off in production; tRPC must not liquidate past the HTTP stop.
   */
  | 'bank.loan_risk_sweep_disabled'
  /**
   * Module kill for loans (`BANK_LOANS_ENABLED=false` / FLAG_REGISTRY bank.loans).
   * New opens refuse; job kills stay on their own env vars.
   */
  | 'bank.loans_disabled'
  /**
   * Module kill for cards ledger half (`BANK_CARDS_ENABLED=false` / bank.cards).
   * Issue and authorise refuse.
   */
  | 'bank.cards_disabled'
  // ── Auto-invest (§31:805 / bank.auto-invest F-plane) ───────────────────────
  /**
   * Cross-asset DCA needs a convert rate counterparty. This service never
   * invents §8 rates — create and run both refuse by this name when no
   * ConvertPort is configured.
   */
  | 'bank.auto_invest_rate_unset'
  | 'bank.auto_invest_not_found'
  | 'bank.auto_invest_inactive'
  | 'bank.auto_invest_invalid_threshold'
  /** Second live card_roundup on the same (user, asset). Pause/cancel first. */
  | 'bank.auto_invest_roundup_exists'
  | 'bank.auto_invest_target_invalid'
  | 'bank.auto_invest_run_failed'
  | 'bank.auto_invest_below_threshold'
  | 'bank.auto_invest_disabled'
  // ── Business maker/checker (§31:811 partial) ───────────────────────────
  | 'bank.business_not_found'
  | 'bank.business_closed'
  | 'bank.business_not_member'
  | 'bank.business_role_forbidden'
  | 'bank.business_invalid_threshold'
  | 'bank.business_invalid_name'
  | 'bank.business_approval_not_found'
  | 'bank.business_approval_inactive'
  | 'bank.business_self_approve'
  | 'bank.business_rejected'
  | 'bank.business_cancelled'
  /**
   * Multi-recipient payroll named a different asset than the debit pot.
   * A mix would need an FX / withholding rate this service does not invent.
   */
  | 'bank.business_payroll_rate_unset'
  /** Payroll with no recipients is not a run. */
  | 'bank.business_payroll_empty'
  /** Retry reused a payroll id with different account, source, or lines. */
  | 'bank.business_payroll_conflict'
  /** Business propose omitted a caller-stable client id. */
  | 'bank.business_request_id_required'
  /** Retry reused a propose client id with different account, spaces, or amount. */
  | 'bank.business_request_conflict'
  /**
   * Job batch size unpublished. Omit used to invent 100 / 200 / 500 / 1_000 rows.
   * Blank / non-finite refuses. Owner may pass those magnitudes explicitly.
   */
  | 'bank.earn_resume_pending_limit_unset'
  | 'bank.earn_renew_batch_limit_unset'
  | 'bank.loan_resume_pending_limit_unset'
  | 'bank.loan_accrue_batch_limit_unset'
  | 'bank.transfer_due_limit_unset'
  | 'bank.auto_invest_batch_limit_unset'
  | 'bank.loan_risk_sweep_limit_unset'
  /** earn.pools catalog page size unpublished. Blank is not 50 — never dump every pool. */
  | 'bank.earn_pools_list_limit_unset'
  /** loans.products catalog page size unpublished. Blank is not 50 — never dump every product. */
  | 'bank.loan_products_list_limit_unset'
  /** spaces.list page size unpublished. Blank is not 50 — never dump every live space. */
  | 'bank.spaces_list_limit_unset'
  /** earn.positions page size unpublished. Blank is not 50 — never dump every active position. */
  | 'bank.earn_positions_list_limit_unset'
  /** earn.interestHistory page size unpublished. Blank is not 50 — never dump every paid day. */
  | 'bank.earn_interest_list_limit_unset'
  /** earn.rateHistory page size unpublished. Blank is not 50 — never dump every recorded rate. */
  | 'bank.earn_rate_history_limit_unset'
  /** sharedPots.list or sharedPots.activity page size unpublished. Blank is not 50. */
  | 'bank.shared_pots_list_limit_unset'
  /** BANK_SHARED_POT_INVITE_MINUTES or BANK_SHARED_POT_PEOPLE_CAP is blank: no pot is shared (BK-acct-09 decision note). */
  | 'bank.joint_unset'
  /** An invite accepted after its owner-set lifetime. */
  | 'bank.invite_expired'
  /** No unanswered invite of the caller's has this id, or they declined it. */
  | 'bank.invite_not_found'
  /** No active account has the handle or email asked for: unknown, frozen and closed are one answer. */
  | 'bank.invitee_not_found'
  /** A pot is shared with the owner-set number of people, open invites included. */
  | 'bank.shared_pot_full'
  /** An invite to oneself, to a member or someone already invited, an invite id reused, or an answer to an answered invite. */
  | 'bank.shared_pot_invalid'
  /** A shared pot's viewer moving money into it, or a member taking money out of a pot they do not own. */
  | 'bank.space_forbidden'
  /** loans.list page size unpublished. Blank is not 50 — never dump every loan. */
  | 'bank.loans_list_limit_unset'
  /** cards.list page size unpublished. Blank is not 50 — never dump every card. */
  | 'bank.cards_list_limit_unset'
  /** cards.authorizations page size unpublished. Blank is not 50 — never dump every decision. */
  | 'bank.card_authorizations_list_limit_unset'
  /** transfers.listSchedules page size unpublished. Blank is not 50 — never dump every standing order. */
  | 'bank.schedules_list_limit_unset'
  /** transfers.executions page size unpublished. Blank is not 50 — never dump every firing. */
  | 'bank.executions_list_limit_unset'
  /** autoInvest.list page size unpublished. Blank is not 50 — never dump every rule. */
  | 'bank.auto_invest_list_limit_unset'
  /** business.list page size unpublished. Blank is not 50 — never dump every account. */
  | 'bank.business_list_limit_unset'
  /** business.pending page size unpublished. Blank is not 50 — never dump every pending approval. */
  | 'bank.business_pending_list_limit_unset'
  /** business.approvals page size unpublished. Blank is not 50 — never dump every approval. */
  | 'bank.business_approvals_list_limit_unset'
  /** Identity has no directory for public handles (IDENTITY_URL unset, or the route is not published). */
  | 'bank.business_directory_unset'
  /** Identity did not answer the directory. Retry. */
  | 'bank.business_directory_unavailable'
  /** A person on the page has no public handle, so the page is not shown. */
  | 'bank.business_directory_incomplete'
  /** Recipient lookup budget for this caller is spent. */
  | 'bank.business_directory_rate_limited'
  /** The caller sent both a handle and an email, or neither. */
  | 'bank.business_recipient_query'
  /** Removing or demoting the only administrator. */
  | 'bank.business_last_admin'
  /** A close or threshold change of this kind is already waiting. */
  | 'bank.business_change_pending'
  /** Close while a payment is still waiting for a decision. */
  | 'bank.business_close_blocked'
  /** This teammate still has a payment waiting as its maker. Decide or cancel it before removal. */
  | 'bank.business_member_has_pending'
  /** business.approvals cursor could not be read. */
  | 'bank.business_cursor_invalid'
  /** ramps.onramps page size unpublished. Blank is not 50 — never dump every on-ramp. */
  | 'bank.onramps_list_limit_unset'
  /** ramps.offramps page size unpublished. Blank is not 50 — never dump every off-ramp. */
  | 'bank.offramps_list_limit_unset'
  /**
   * Auto-invest convert `GET /api/v1/markets?limit=` unpublished.
   * Blank is not 50 — trade refuses `trade.markets_limit_unset` (1..500).
   */
  | 'bank.convert_markets_limit_unset'
  /** Nonsense batch (non-integer / out of range) — not clamped. */
  | 'bank.validation_failed'
  /**
   * An earlier repayment on this loan is still `pending`: its ledger post failed
   * without a definite refusal, so it may have committed (a lost
   * acknowledgement). It counts as covering the debt until the same repayment
   * id is retried or `recover-loan-repayments` re-drives it, so a new event
   * cannot collect the same principal twice.
   */
  | 'bank.ledger_outcome_unknown'
  /**
   * Money-out step-up (BANK_STEP_UP_MONEY_OUT=required). This door needs a fresh
   * same-person approval from identity: none was sent, it is spent, expired,
   * another user's, or for another session. The client asks the user again.
   */
  | 'bank.step_up_required'
  /** The approval was for a different payload (amount, payee, asset, id, cadence...). Ask again. */
  | 'bank.step_up_mismatch'
  /** The approval was already spent on a different operation. Ask again. */
  | 'bank.step_up_used'
  /** Identity could not answer, or is not wired. Nothing was posted; fail closed. */
  | 'bank.step_up_unavailable'
  /** No operator row publishes a per-transfer limit, a daily limit, and a fee for this asset. */
  | 'bank.personal_transfer_terms_unset'
  /** Published limits must be above zero, and the daily limit at least the per-transfer limit. Nothing is written. */
  | 'bank.personal_transfer_terms_invalid'
  /** A positive fee is published and bankTransfer has no fee leg. Nothing is posted. */
  | 'bank.personal_transfer_fee_unwired'
  | 'bank.personal_transfer_limit_exceeded'
  | 'bank.personal_transfer_daily_limit_exceeded'
  /** Same transfer id, different note, payee, amount, request, or reference. */
  | 'bank.personal_transfer_conflict'
  | 'bank.personal_transfer_not_found'
  | 'bank.personal_note_invalid'
  /** A personal-send reference is not printable ASCII of 1 to 64 characters. */
  | 'bank.personal_reference_invalid'
  | 'bank.personal_request_not_found'
  | 'bank.personal_request_closed'
  | 'bank.personal_request_expired'
  | 'bank.personal_request_not_payer'
  | 'bank.personal_request_not_payee'
  | 'bank.personal_request_amount_mismatch'
  /** The transfer's recipient is not the request's payee. Nothing is posted. */
  | 'bank.personal_request_payee_mismatch'
  | 'bank.personal_request_claim_held'
  | 'bank.personal_request_conflict'
  | 'bank.personal_request_self'
  | 'bank.personal_request_list_limit_unset'
  | 'bank.personal_request_payer_unknown'
  | 'bank.pay_request_notify_unwired'
  /** No notices port for posted sends: the send stands, its notice stays owed. */
  | 'bank.transfer_notify_unwired'
  /** IDENTITY_URL is unset, so a request cannot name either person. */
  | 'bank.party_handles_unset'
  /** Identity did not answer a handle lookup. Nothing was created. */
  | 'bank.party_handles_unavailable'
  /**
   * The same business id already exists for someone else, or for different
   * rules. Both answers use this one code so the caller cannot tell them apart.
   */
  | 'bank.business_conflict'
  /** The owner cannot lift a freeze an operator placed. */
  | 'bank.card_operator_frozen'
  /** An operator write named no reason, or fewer than 10 characters. */
  | 'bank.ops_reason_too_short'
  /** Card programme from/to was omitted, unreadable, or not a positive span. */
  | 'bank.card_programme_span_unset'
  /** Card programme span is longer than 92 days. */
  | 'bank.card_programme_span_too_long'
  /** Ramp health window was omitted or outside 1..720 hours. */
  | 'bank.ramp_health_window_unset'
  /** Transfer health window was omitted or outside 1..720 hours. */
  | 'bank.transfer_health_window_unset'
  /** Failed-transfer window was omitted or outside 1..720 hours. */
  | 'bank.failed_transfers_window_unset'
  /** Failed-transfer page size unpublished. Blank is not 50. */
  | 'bank.failed_transfers_limit_unset'
  /** Failed-transfer cursor was not a page this service issued. */
  | 'bank.failed_transfers_cursor_invalid'
  /**
   * Operator transfer drill-down. Unknown and malformed ids share this code
   * so the shape of the id is not an existence oracle.
   */
  | 'bank.ops_transfer_not_found'
  /** Operator authorisation read (BK-cops-01): unknown or malformed id. */
  | 'bank.ops_authorization_not_found'
  /** Operator business-approval page size unpublished. Blank is not 50. */
  | 'bank.ops_business_approvals_limit_unset'
  /** A transfer id was reused with a different note or reference. */
  | 'bank.transfer_message_conflict'
  /** The activity id is not in this customer's history. */
  | 'bank.activity_not_found'
  /** Lookup stopped before history ended, so absence is not proven. */
  | 'bank.activity_lookup_bounded'
  /** The ledger entries of a balance do not add up to the live balance; the page shows the gap and no list. */
  | 'portfolio.entries_do_not_sum'
  /** A from/to or amount range is backwards. */
  | 'bank.activity_range'
  /** A note command id was reused with different text. */
  | 'bank.activity_note_conflict'
  /** A note write carried neither a note nor a report description. */
  | 'bank.activity_note_empty'
  /** A dispute id was reused with a different reason or transaction. */
  | 'bank.activity_dispute_conflict'
  /** This customer already has an open dispute on that transaction. */
  | 'bank.activity_dispute_exists'
  /** Statement dates are backwards or longer than 366 days. */
  | 'bank.statement_range'
  /** PDF statements are one UTC calendar month. */
  | 'bank.statement_pdf_one_month'
  /** More posted lines than a statement file will carry. Narrow the dates. */
  | 'bank.statement_too_large'
  /** No service secret, or activity could not be read, so no file was built. */
  | 'bank.statement_unavailable'
  /** A desk read of a customer's balances could not be recorded, so it was not made. */
  | 'bank.ops_audit_unavailable'
  /** New borrowing or new supply is paused for this asset by the desk (BK-loan-07). Repay and withdraw still work. */
  | 'bank.asset_paused'
  /** The asset pause state could not be read, so a new borrow or deposit was refused rather than assumed open. */
  | 'bank.asset_pause_unreadable'
  /** An asset pause change named a revision that is no longer current, or reused a revision with different terms. */
  | 'bank.ops_revision_conflict'
  /** A saved activity filter name is blank or longer than 60 characters. */
  | 'bank.activity_filter_name_invalid'
  /** A saved activity filter carries no filter at all. */
  | 'bank.activity_filter_empty'
  /** That saved filter name already holds a different filter. */
  | 'bank.activity_filter_conflict'
  /** Saved filter page size unpublished. Blank is not 50. */
  | 'bank.activity_filter_limit_unset'
  /** A limit-increase request reason is shorter than 10 characters (BK-acct-04). */
  | 'bank.limit_request_reason_too_short'
  /** A request of that kind for that asset is already open. */
  | 'bank.limit_request_open'
  /** A request id was reused for a different request. */
  | 'bank.limit_request_conflict'
  /** Limit request page size unpublished. Blank is not 50. */
  | 'bank.limit_request_list_limit_unset'
  | 'bank.limit_request_not_found'
  /** The decider is the customer who asked. */
  | 'bank.limit_request_self_decision'
  /** Already decided, differently. */
  | 'bank.limit_request_decided'
  /** An approval named no granted limit; it is never defaulted to the requested one. */
  | 'bank.limit_grant_unset'
  /** Operator loan product terms are blank, out of range or out of LTV order (BK-loan-02). */
  | 'bank.loan_params_invalid'
  /** A product id was reused with different terms. */
  | 'bank.loan_product_conflict'
  /** A spend door was refused for funds; carries available/onHold/inEarn figures when they could be read (RC-wallet-09). */
  | 'bank.insufficient_funds'
  /** The owner has not published the base-tier account terms (`BANK_ACCOUNT_TERMS_JSON`), or they are not in shape (BK-acct-01). */
  | 'bank.account_terms_unset'
  /** The owner has not published which currencies an account may hold (`BANK_ACCOUNT_CURRENCIES`). */
  | 'bank.account_currencies_unset'
  /** A currency that is not on the owner's list. */
  | 'bank.asset_unknown'
  /** A currency that still holds a balance, a hold, an open order or a named space cannot be removed. */
  | 'bank.currency_in_use'
  /** The owner has not published how many spaces one account may hold (`BANK_SPACE_LIMIT`) (BK-pots-01). */
  | 'bank.space_limit_unset'
  /** The account already holds the owner's number of live named spaces. */
  | 'bank.space_limit_reached'
  /** The customer already has a space with this name in this currency (`spaces_user_asset_name_idx`); rename and retry. */
  | 'bank.space_name_taken'
  /** A pot change that cannot be: a goal of zero or less, a lock date not in the future or earlier than the lock, or the primary space (BK-pots-02). */
  | 'bank.space_change_invalid'
  /** The owner has not set how long an early unlock waits (`BANK_SPACE_UNLOCK_WAIT_HOURS`), so the pot stays locked to its date (BK-pots-02). */
  | 'bank.space_unlock_rule_unset'
  /** An early unlock was asked for, or withdrawn, on a pot that is not locked now (BK-pots-02). */
  | 'bank.space_not_locked'
  /** The owner has not published when incoming payments are sorted (`BANK_INCOME_SORTER_MIN_CREDIT`), so no sorter is made (BK-pots-03). */
  | 'bank.sorter_terms_unset'
  /** A sorter that cannot be: no spaces or too many, a space twice, a share outside 1 to 10000 basis points, shares over 100%, or the account itself (BK-pots-03). */
  | 'bank.sorter_invalid'
  /** The account already sorts this asset; cancel that sorter first (BK-pots-03). */
  | 'bank.sorter_exists'
  /** The sorter id is already taken by a sorter on different terms (BK-pots-03). */
  | 'bank.sorter_conflict'
  /** No such sorter of the caller's; another person's reads the same (BK-pots-03). */
  | 'bank.sorter_not_found'
  /** One split of a sorted credit failed without a typed code (BK-pots-03). */
  | 'bank.sorter_split_failed'
  /** The profile a bank call names is not one the caller holds: an unknown or closed business, or one they are not a member of. */
  | 'bank.profile_not_held'
  /** A business profile has no company account of its own in this build, so there is no company terms, currency or detail to show. */
  | 'bank.company_account_unwired'
  /** The owner has not published the loan payoff fee (`BANK_LOAN_PAYOFF_FEE`). A quote is not given, and zero is not assumed (BK-loan-06). */
  | 'bank.loan_fee_unset'
  /** A non-zero loan payoff fee is published, but repay has no fee entry to collect it, so no payoff quote is given (BK-loan-06). */
  | 'bank.loan_fee_unsupported'
  /** The owner has not published how long a loan payoff quote stays valid (`BANK_LOAN_PAYOFF_WINDOW_MINUTES`) (BK-loan-06). */
  | 'bank.loan_payoff_window_unset'
  /** The loan's snapshotted rate cannot be used, so a projection is refused rather than invented (BK-loan-06). */
  | 'bank.loan_terms_missing'
  /** An interest correction is not in shape: a zero or malformed amount, or a reason under 3 or over 500 characters (LOAN-05). */
  | 'bank.correction_invalid'
  /** A correction that takes off more interest than the loan owes now; paid interest is never given back by a correction (LOAN-05). */
  | 'bank.correction_exceeds_interest'
  /** A correction id already used with other terms (loan, amount or reason). The first row stands (LOAN-05). */
  | 'bank.correction_conflict'
  // ── Direct debits (BK-xfer-11) ─────────────────────────────────────────
  /** A direct debit presentment or refund request is not in shape (amount, date, reason). */
  | 'bank.dd_invalid'
  /** No mandate by that id for this person. Another person's reads the same. */
  | 'bank.dd_mandate_not_found'
  /** No collection by that id for this person. */
  | 'bank.dd_collection_not_found'
  /** The scheme knows no creditor by that id, so no mandate is set up. */
  | 'bank.dd_creditor_unknown'
  /** A mandate id was set up again with other terms. */
  | 'bank.dd_mandate_conflict'
  /** A collection id was presented again with another amount or date. */
  | 'bank.dd_collection_conflict'
  /** The ledger refused a collection's entry itself (an asset it does not hold, say): it failed and nothing was posted. */
  | 'bank.dd_collection_invalid'
  /** A refund was asked for a collection that took nothing (failed, rejected or not yet due). */
  | 'bank.dd_refund_not_collected'
  /** The guarantee period for this debit has ended. */
  | 'bank.dd_refund_window_closed'
  /** No direct debit guarantee period is set, so a refund request is refused rather than assumed. */
  | 'bank.dd_guarantee_unset'
  /** A money calendar read is 1 to 62 days from a valid date. */
  | 'bank.calendar_window_invalid'
  /** Rules that move money by themselves wait for the owner's published terms, so none can be created. */
  | 'bank.rule_terms_unset'
  /** A reminder lead time is one of the offered choices, or off. */
  | 'bank.reminder_lead_invalid'
  /** The reminder rule changed since the revision the write read. */
  | 'bank.reminder_revision_conflict'
  /** No bus is wired for standing-order notices, so owed ones stay owed. */
  | 'bank.scheduled_notify_unwired'
  // ── Recovery claims (RC-identity-08, J-identity-05 #7) ─────────────────
  /** Identity could not answer which accounts a person may claim, or whether a claim's signatures count; nothing moved. */
  | 'bank.recovery_unavailable'
  /** An API key or a sub-account asked: only the heir at their own keyboard opens or executes a claim. */
  | 'bank.recovery_delegated'
  /** Staff asked: staff never claim or sweep a customer's balances, whatever their scopes. */
  | 'bank.recovery_staff_forbidden'
  /** The account is not one identity lists for this heir now. */
  | 'bank.recovery_estate_not_found'
  /** No claim by that id belongs to the caller. */
  | 'bank.recovery_claim_not_found'
  /** The account already has a claim under another notice or heir. The first claim stands. */
  | 'bank.recovery_claim_conflict'
  /** Identity refused the claim; the message names identity's code. Nothing moved. */
  | 'bank.recovery_claim_refused'
  /** Some of the owner's value is held, staked or pledged, so nothing is swept until it is free. */
  | 'bank.recovery_blocked';

export class BankError extends Error {
  constructor(
    message: string,
    readonly code: BankErrorCode,
  ) {
    super(message);
    this.name = 'BankError';
  }
}
