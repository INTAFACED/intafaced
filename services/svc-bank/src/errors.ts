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
  /** One-off transfer omitted a caller-stable transfer id. A blank id is not minted. */
  | 'bank.transfer_id_required'
  /** Retry reused a schedule id with different user, spaces, amount, cadence, or start. */
  | 'bank.schedule_conflict'
  /**
   * A retry reused a one-off transfer id with a different amount or destination.
   * The ledger key returns the first transaction without comparing the body.
   */
  | 'bank.transfer_mismatch'
  | 'bank.pool_not_found'
  | 'bank.pool_closed'
  | 'bank.pool_underfunded'
  /**
   * No open pool carries an operator-configured APR for the requested earn
   * surface. Empty does not mean zero yield: the product refuses rather than
   * inventing a plausible default rate.
   */
  | 'bank.earn_rate_unset'
  | 'bank.below_minimum'
  /**
   * Fixed earn pool with no positive term. Null, zero, negative, or a
   * non-finite term leaves matures_at unset or already due, and withdraw only
   * locks while matures_at is still in the future. A blank term is not an
   * open-ended lock, and it is not a default number of days.
   */
  | 'bank.term_required'
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
   * A retry reused a repayment event id but changed the amount.
   *
   * The row already holds the first interest-plus-principal split. A later call
   * with the same id must post that split, not a second one. A different amount
   * needs a new event id.
   */
  | 'bank.loan_repayment_mismatch'
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
   * key returns the original transaction without comparing bodies — correct for a
   * re-drive, silently wrong for a disagreement. Refused rather than reconciled,
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
  | 'bank.ramp_invalid_amount'
  /**
   * Asset id is blank or not a usable crypto ledger symbol. The crypto half
   * does not invent an allowlist of commercial pairs — that is product law —
   * but it refuses the empty / whitespace shape before a row or deposit posts.
   */
  | 'bank.ramp_invalid_asset'
  | 'bank.ramp_invalid_destination'
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
  /** Dest user has no primary space — refuse before ledger-client posts. */
  | 'bank.dest_user_missing'
  /** Same (rail, railRef), (user, clientRef), or offramp id already booked with different facts. */
  | 'bank.ramp_conflict'
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
  | 'bank.ledger_outcome_unknown';

export class BankError extends Error {
  constructor(
    message: string,
    readonly code: BankErrorCode,
  ) {
    super(message);
    this.name = 'BankError';
  }
}
