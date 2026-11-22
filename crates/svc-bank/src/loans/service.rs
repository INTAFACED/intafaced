//! `LoanService` (`loans/loan-service.ts`): opening a loan (lock, then draw), collateral in and out, daily interest,
//! repayment, the reserve, and the recovery of every money path whose ledger outcome was lost. The risk sweep and the
//! liquidation ladder are `sweep`'s.
//!
//! If the process dies exactly here, whose funds are stranded? Answered per path in the TypeScript's header, and the
//! same here: the row is claimed before its post, the post is idempotent on a business key, and only a definite
//! ledger refusal marks a row rejected. Anything else leaves it pending, counted against new claims, for a same-id
//! retry or the recovery job to re-drive on its original key.

use postgres::{GenericClient, Transaction};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::apply::{liquidation_price, minimum_collateral, origination_fee, quote_value};
use super::model::{
    self, Debt, LOAN_COL_COUNT, Loan, Product, loan, loan_cols, outstanding, product,
};
use super::ports::Deps;
use super::prices::{QuotedMark, acceptable_for_marking};
use super::risk::{RiskError, Round, daily_loan_interest, days_to_accrue, describe_ltv};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{LedgerAccount, LedgerTx, PostFailure};
use crate::spaces::space::{in_tx, pg, with};

/// `LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS`: how long after its last post attempt a pending loan's ledger call can still
/// commit (25 s retry deadline + 300 s signature skew + 15 s statement timeout + 60 s idle limit, rounded up to 7
/// minutes). Strong evidence, not proof: check svc-ledger's health before every abandon (runbook 2.2).
pub const IN_FLIGHT_BOUND_SECONDS: i64 = 7 * 60;

/// The marks of the slice's assets, by asset id.
pub use super::prices::Marks;

// ── Accounts and keys ────────────────────────────────────────────────────────────────────────────────────────────────

/// `loanCollateralAccount`: `userCollateral(userId, assetId, 'loan:<loanId>')`.
pub fn collateral_account(user_id: &str, asset_id: &str, loan_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "user",
        owner_id: user_id.to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "collateral",
        purpose: Some(format!("loan:{loan_id}")),
    }
}

/// `loanReserve`: `moduleAccount('bank', 'loan-reserve', assetId)`.
pub fn reserve_account(asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "module",
        owner_id: "bank:loan-reserve".to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// `insuranceFund`.
pub fn insurance_fund(asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "house",
        owner_id: "insurance-fund".to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// `houseFees('bank', assetId)`.
pub fn house_fees(asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "house",
        owner_id: "fees:bank".to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

pub fn lock_key(loan_id: &str, sequence: i64) -> String {
    format!("bank.loan.collateral.lock:{loan_id}:{sequence}")
}

pub fn release_key(loan_id: &str, sequence: i64) -> String {
    format!("bank.loan.collateral.release:{loan_id}:{sequence}")
}

pub fn draw_key(loan_id: &str) -> String {
    format!("bank.loan.draw:{loan_id}")
}

pub fn repay_key(loan_id: &str, sequence: i64) -> String {
    format!("bank.loan.repay:{loan_id}:{sequence}")
}

pub fn liquidate_key(loan_id: &str, tranche: i64) -> String {
    format!("bank.loan.liquidate:{loan_id}:{tranche}")
}

pub fn bad_debt_key(loan_id: &str) -> String {
    format!("bank.loan.baddebt:{loan_id}")
}

// ── Posting ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Why a post did not book: refused before svc-ledger was asked (the custody switch), or svc-ledger's answer.
#[derive(Debug)]
pub enum PostErr {
    Refused(Refusal),
    Ledger(PostFailure),
}

impl PostErr {
    /// `isDefiniteLedgerRefusal`: svc-ledger refused by a code it decides before it commits anything.
    pub fn definite(&self) -> bool {
        match self {
            PostErr::Ledger(f) => crate::earn::definite_refusal(f),
            PostErr::Refused(_) => false,
        }
    }

    /// `isInsufficientFunds`.
    pub fn insufficient(&self) -> bool {
        matches!(self, PostErr::Ledger(f) if f.code() == Some("ledger.insufficient_funds"))
    }

    /// What the router's guard answers for it. `LoanService` rethrows the ledger's own error, so a failure other than
    /// too little money keeps the ledger's message as it is (a sweep reports it unwrapped).
    pub fn refusal(self) -> Refusal {
        match self {
            PostErr::Refused(r) => r,
            PostErr::Ledger(f) if f.insufficient() => crate::transfers::moves::post_refusal(&f),
            PostErr::Ledger(f) => Refusal::Other(f.message().to_owned()),
        }
    }
}

/// Why a driven post failed: the claim or the record refused, the post failed, or a re-drive found its row no longer
/// pending (`NoLongerPending`).
#[derive(Debug)]
pub enum Fail {
    Refused(Refusal),
    Post(PostErr),
    NoLongerPending(String),
}

impl Fail {
    pub fn refusal(self) -> Refusal {
        match self {
            Fail::Refused(r) => r,
            Fail::Post(p) => p.refusal(),
            Fail::NoLongerPending(id) => Refusal::Other(format!("row {id} is no longer pending")),
        }
    }

    fn definite(&self) -> bool {
        matches!(self, Fail::Post(p) if p.definite())
    }
}

impl From<Refusal> for Fail {
    fn from(r: Refusal) -> Fail {
        Fail::Refused(r)
    }
}

/// `custodyGuardedLedger`: with the custodial layer off a recipe that moves a customer balance refuses
/// `bank.no_partner_bank` before svc-ledger is asked; the bank's own accounts still post.
pub fn post(
    d: &Deps<'_>,
    recipe: &str,
    input: &Json,
    key: &str,
    customer: bool,
) -> Result<LedgerTx, PostErr> {
    if customer && d.custody_layer != "on" {
        return Err(PostErr::Refused(refuse(
            "bank.no_partner_bank",
            "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
        )));
    }
    d.ledger
        .post_recipe(recipe, input, key)
        .map_err(PostErr::Ledger)
}

/// A claim's answer: this runner claimed the row, or the row was there with the tx it names, if any.
pub enum Claim {
    Claimed {
        id: String,
    },
    Existing {
        id: String,
        ledger_tx: Option<String>,
    },
}

fn tx_retryable(r: &Refusal) -> bool {
    matches!(r, Refusal::Other(m) if m.contains("40001") || m.contains("40P01") || m.contains("could not serialize") || m.contains("deadlock detected"))
}

/// `drivenPost`: claim row, ledger post, record the tx id. The claim is inserted first so a second runner loses the
/// unique index; the post is idempotent on its key. Only a definite refusal marks the row rejected: anything else may
/// be a commit whose answer was lost, and the row stays pending with its terms. `before_settle` runs after the post and
/// before the row is settled (a sale writes its shortfall and bad-debt tx there).
pub fn driven_post(
    d: &Deps<'_>,
    table: &str,
    mut claim: impl FnMut(&mut Transaction<'_>) -> Result<Claim, Refusal>,
    post_it: impl FnOnce() -> Result<LedgerTx, PostErr>,
    before_settle: Option<&dyn Fn() -> Result<(), Refusal>>,
) -> Result<String, Fail> {
    let mut attempt = 0;
    let claimed = loop {
        attempt += 1;
        match in_tx(d.store, &mut claim) {
            Err(e) if attempt < 5 && tx_retryable(&e) => {}
            other => break other?,
        }
    };
    let id = match claimed {
        Claim::Existing {
            id,
            ledger_tx: Some(tx),
        } => {
            // A row that already names its tx: settled is done; pending is the crash after the tx was stored and
            // before the shortfall was written. That sale is the one that posted; never post it again.
            let status = with(d.store, |c| row_status(c, table, &id))?;
            if status.as_deref() == Some("settled") {
                return Ok(tx);
            }
            if status.as_deref() == Some("pending") {
                if let Some(b) = before_settle {
                    b()?;
                }
                with(d.store, |c| {
                    c.execute(
                        &format!(
                            "UPDATE bank.{table} SET status = 'settled', ledger_tx_id = $1, settled_at = now() \
                              WHERE id = $2::text::uuid AND status = 'pending' AND ledger_tx_id = $1"
                        ),
                        &[&tx, &id],
                    )
                    .map_err(|e| pg(&e))
                })?;
                return Ok(tx);
            }
            id
        }
        Claim::Existing { id, .. } | Claim::Claimed { id } => id,
    };
    let posted = match post_it() {
        Ok(p) => p,
        Err(e) => {
            if e.definite()
                && let PostErr::Ledger(f) = &e
            {
                let code = f.code().unwrap_or_default().to_owned();
                with(d.store, |c| {
                    c.execute(
                            &format!(
                                "UPDATE bank.{table} SET status = 'rejected', rejection_code = $1 WHERE id = $2::text::uuid"
                            ),
                            &[&code, &id],
                        )
                        .map_err(|e| pg(&e))
                })?;
            }
            return Err(Fail::Post(e));
        }
    };
    if let Some(b) = before_settle {
        with(d.store, |c| {
            c.execute(
                &format!(
                    "UPDATE bank.{table} SET ledger_tx_id = $1 WHERE id = $2::text::uuid AND ledger_tx_id IS NULL"
                ),
                &[&posted.id, &id],
            )
            .map_err(|e| pg(&e))
        })?;
        b()?;
    }
    with(d.store, |c| {
        c.execute(
            &format!(
                "UPDATE bank.{table} SET status = 'settled', ledger_tx_id = $1, settled_at = now() WHERE id = $2::text::uuid"
            ),
            &[&posted.id, &id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(posted.id)
}

fn row_status(
    c: &mut impl GenericClient,
    table: &str,
    id: &str,
) -> Result<Option<String>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT status::text FROM bank.{table} WHERE id = $1::text::uuid"),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| r.try_get(0).map_err(|e| pg(&e)))
        .transpose()
}

fn amount_text(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn count(c: &mut impl GenericClient, sql: &str, loan_id: &str) -> Result<i64, Refusal> {
    let row = c.query_one(sql, &[&loan_id]).map_err(|e| pg(&e))?;
    row.try_get(0).map_err(|e| pg(&e))
}

// ── Marks ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `acceptedMarks`: the source's marks that pass the marking guards; a missing or unusable asset is omitted.
pub fn accepted_marks(
    d: &Deps<'_>,
    asset_ids: &[String],
    quote: &str,
    now: Instant,
) -> Result<Marks, Refusal> {
    let raw = d.prices.marks(asset_ids, quote);
    Ok(raw
        .into_iter()
        .filter(|(_, m)| acceptable_for_marking(m, now, &d.settings.mark_policy).ok)
        .collect())
}

/// `marksFor`: a loan's two assets, or `bank.mark_missing`; never a zero.
pub fn marks_for(
    d: &Deps<'_>,
    collateral: &str,
    debt: &str,
    quote: &str,
    now: Instant,
) -> Result<Marks, Refusal> {
    let marks = accepted_marks(d, &[collateral.to_owned(), debt.to_owned()], quote, now)?;
    for asset in [collateral, debt] {
        if !marks.contains_key(asset) {
            return Err(refuse(
                "bank.mark_missing",
                format!("No usable mark for {asset} in {quote}"),
            ));
        }
    }
    Ok(marks)
}

fn mark<'m>(marks: &'m Marks, asset: &str) -> Result<&'m QuotedMark, Refusal> {
    marks
        .get(asset)
        .ok_or_else(|| Refusal::Other(format!("no mark for {asset}")))
}

/// `collateralOf`: collateral held for the loan, read from the ledger. The only source.
pub fn collateral_of(d: &Deps<'_>, l: &Loan) -> Result<Amount, Refusal> {
    d.ledger
        .balance(&collateral_account(
            &l.user_id,
            &l.collateral_asset_id,
            &l.id,
        ))
        .map_err(Refusal::Other)
}

fn disabled() -> Refusal {
    refuse(
        "bank.loans_disabled",
        "Loans module is disabled (BANK_LOANS_ENABLED / bank.loans)",
    )
}

pub fn assert_enabled(d: &Deps<'_>) -> Result<(), Refusal> {
    if d.settings.module_enabled {
        Ok(())
    } else {
        Err(disabled())
    }
}

/// `originationFeeRefusal`: not set, or published above zero with no ledger leg to collect it; none when it opens.
pub fn origination_fee_refusal(d: &Deps<'_>) -> Option<&'static str> {
    match origination_fee(d.settings.origination_fee_bps.as_deref()) {
        super::apply::OriginationFee::NotSet => Some("bank.loan_fee_unset"),
        super::apply::OriginationFee::Published { bps } if bps > 0 => Some("bank.loan_fee_unwired"),
        super::apply::OriginationFee::Published { .. } => None,
    }
}

// ── The application ──────────────────────────────────────────────────────────────────────────────────────────────────

/// What opening a principal needs now (`quote`).
pub struct Quote {
    pub product: Product,
    pub principal: Amount,
    pub required_collateral: Amount,
    pub starting_ltv_bps: i64,
    pub liquidation_price: Amount,
    pub debt_mark: QuotedMark,
    pub collateral_mark: QuotedMark,
}

fn below_minimum(p: &Product) -> Refusal {
    refuse(
        "bank.below_minimum",
        format!(
            "Minimum draw for \"{}\" is {} {}",
            p.name,
            format_amount(p.min_principal),
            p.debt_asset_id
        ),
    )
}

fn product_closed(p: &Product) -> Refusal {
    refuse(
        "bank.loan_product_closed",
        format!("Loan product \"{}\" is closed", p.name),
    )
}

/// `quote`: the smallest pledge that opens `principal` now, its starting LTV and its liquidation price. A read.
pub fn quote(d: &Deps<'_>, product_id: &str, principal: Amount) -> Result<Quote, Refusal> {
    assert_enabled(d)?;
    let p = with(d.store, |c| product(c, product_id))?;
    if p.status != "open" {
        return Err(product_closed(&p));
    }
    if principal <= 0 || principal < p.min_principal {
        return Err(below_minimum(&p));
    }
    let marks = marks_for(
        d,
        &p.collateral_asset_id,
        &p.debt_asset_id,
        &p.quote_asset_id,
        d.now,
    )?;
    let debt_mark = mark(&marks, &p.debt_asset_id)?.clone();
    let collateral_mark = mark(&marks, &p.collateral_asset_id)?.clone();
    let debt_value = quote_value(principal, debt_mark.mark.price, Round::Ceil);
    let required = minimum_collateral(debt_value, collateral_mark.mark.price, p.max_ltv_bps)
        .map_err(Refusal::Other)?;
    let starting = ltv_bps(
        debt_value,
        quote_value(required, collateral_mark.mark.price, Round::Floor),
    )?;
    let liq = liquidation_price(debt_value, required, p.policy.liquidation_ltv_bps)
        .map_err(Refusal::Other)?;
    Ok(Quote {
        product: p,
        principal,
        required_collateral: required,
        starting_ltv_bps: starting,
        liquidation_price: liq,
        debt_mark,
        collateral_mark,
    })
}

/// `terms`: the loan and the two thresholds written on its row at open (null on rows from before they were).
pub fn terms(d: &Deps<'_>, loan_id: &str) -> Result<(Loan, Option<i64>, Option<i64>), Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {}, margin_call_ltv_bps::int8, liquidation_ltv_bps::int8 FROM bank.loans WHERE id = $1::text::uuid",
                    loan_cols("")
                ),
                &[&loan_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(r) = rows.first() else {
            return Err(model::loan_not_found(loan_id));
        };
        Ok((
            Loan::from_row(r)?,
            r.try_get(LOAN_COL_COUNT).map_err(|e| pg(&e))?,
            r.try_get(LOAN_COL_COUNT + 1).map_err(|e| pg(&e))?,
        ))
    })
}

/// What `open` answers.
pub struct Opened {
    pub loan: Loan,
    pub ltv_bps: i64,
    pub collateral_ledger_tx_id: String,
    pub draw_ledger_tx_id: String,
}

/// What a borrower asks to open.
pub struct OpenAsk<'a> {
    pub loan_id: &'a str,
    pub product_id: &'a str,
    pub user_id: &'a str,
    pub collateral_amount: Amount,
    pub principal: Amount,
    /// The rate the borrower was shown.
    pub expected_apr_bps: Option<i64>,
}

/// `open`: lock collateral, then release principal, in that order and as two transactions. The caller names the loan
/// id, so a retried request is the same loan and never a second leveraged position.
pub fn open(d: &Deps<'_>, ask: &OpenAsk<'_>) -> Result<Opened, Refusal> {
    assert_enabled(d)?;
    let now = d.now;
    let p = with(d.store, |c| product(c, ask.product_id))?;
    if p.status != "open" {
        return Err(product_closed(&p));
    }
    if ask.principal < p.min_principal {
        return Err(below_minimum(&p));
    }
    if ask.principal <= 0 || ask.collateral_amount <= 0 {
        return Err(refuse(
            "bank.ltv_exceeded",
            "A loan needs positive collateral and positive principal",
        ));
    }
    let opening_ltv = check_opening_ltv(d, &p, ask.collateral_amount, ask.principal, now)?;
    let loan_id = ask.loan_id;
    // A blank or unwired origination fee refuses a new loan before any row; a retry of a loan whose row exists replays
    // or finishes on the terms it opened under. The rate the borrower was shown is the one a new loan opens at.
    let known = with(d.store, |c| {
        Ok(!c
            .query(
                "SELECT 1 FROM bank.loans WHERE id = $1::text::uuid",
                &[&loan_id],
            )
            .map_err(|e| pg(&e))?
            .is_empty())
    })?;
    if !known {
        match origination_fee_refusal(d) {
            Some("bank.loan_fee_unset") => {
                return Err(refuse(
                    "bank.loan_fee_unset",
                    "The bank has not published its origination fee, so no loan is opened",
                ));
            }
            Some(code) => {
                return Err(refuse(
                    code,
                    "An origination fee is published but cannot be collected yet, so no loan is opened",
                ));
            }
            None => {}
        }
        if let Some(expected) = ask.expected_apr_bps
            && expected != p.apr_bps
        {
            return Err(refuse(
                "bank.loan_rate_changed",
                format!(
                    "The rate changed to {} bps since it was shown as {expected} bps: read the terms again",
                    p.apr_bps
                ),
            ));
        }
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the product's own int4 columns"
    )]
    let (apr, mc, liq) = (
        p.apr_bps as i32,
        p.policy.margin_call_ltv_bps as i32,
        p.policy.liquidation_ltv_bps as i32,
    );
    let inserted = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.loans (
                       id, product_id, user_id, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, principal,
                       opening_collateral, opened_at, margin_call_ltv_bps, liquidation_ltv_bps
                     ) VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7, $8::text::numeric, $9::text::numeric,
                               to_timestamp($10::float8 / 1000), $11, $12)
                     ON CONFLICT (id) DO NOTHING
                     RETURNING {}",
                    loan_cols("")
                ),
                &[
                    &loan_id,
                    &p.id,
                    &ask.user_id,
                    &p.debt_asset_id,
                    &p.collateral_asset_id,
                    &p.quote_asset_id,
                    &apr,
                    &format_amount(ask.principal),
                    &format_amount(ask.collateral_amount),
                    &instant_f64(now),
                    &mc,
                    &liq,
                ],
            )
            .map_err(|e| pg(&e))?;
        match rows.first() {
            Some(r) => Loan::from_row(r),
            None => loan(c, loan_id),
        }
    })?;
    let l = inserted;
    // The retry must be the same loan: who is asking first, then principal, then the opening collateral.
    if l.user_id != ask.user_id || l.product_id != p.id {
        return Err(refuse(
            "bank.loan_borrower_mismatch",
            format!(
                "Loan {} already exists and was not opened by this request — a retry must carry the same terms. \
                 Use a new loan id to open a different loan",
                l.id
            ),
        ));
    }
    if l.principal != ask.principal {
        return Err(refuse(
            "bank.loan_principal_mismatch",
            format!(
                "Loan {} already exists with a principal of {} {}, but this request asks for {} — a retry must carry \
                 the same terms. Use a new loan id to borrow a different amount",
                l.id,
                format_amount(l.principal),
                l.debt_asset_id,
                format_amount(ask.principal)
            ),
        ));
    }
    let stored_opening = match l.opening_collateral {
        Some(a) => Some(a),
        None => with(d.store, |c| collateral_event(c, &l.id, 0))?
            .map(|e| amount_text(&e.amount))
            .transpose()?,
    };
    if let Some(stored) = stored_opening
        && stored != ask.collateral_amount
    {
        return Err(refuse(
            "bank.loan_collateral_mismatch",
            format!(
                "Loan {} already exists with opening collateral of {} {}, but this request asks for {} — a retry \
                     must carry the same terms. Use a new loan id to pledge a different amount",
                l.id,
                format_amount(stored),
                l.collateral_asset_id,
                format_amount(ask.collateral_amount)
            ),
        ));
    }
    if l.status != "pending" {
        let (collateral_tx, draw_tx) = draw_record(d, &l.id)?;
        return Ok(Opened {
            loan: l,
            ltv_bps: opening_ltv,
            collateral_ledger_tx_id: collateral_tx,
            draw_ledger_tx_id: draw_tx,
        });
    }
    complete_pending(d, &l, ask.collateral_amount, opening_ltv, now, false)
}

/// Epoch milliseconds as the float `to_timestamp` reads.
pub fn instant_f64(t: Instant) -> f64 {
    #[allow(
        clippy::cast_precision_loss,
        reason = "epoch milliseconds stay far below 2^53"
    )]
    let v = t.0 as f64;
    v
}

/// `checkOpeningLtv`: on marks that pass the marking guards, debt valued up and collateral down, under the product's cap.
fn check_opening_ltv(
    d: &Deps<'_>,
    p: &Product,
    collateral: Amount,
    principal: Amount,
    now: Instant,
) -> Result<i64, Refusal> {
    let marks = marks_for(
        d,
        &p.collateral_asset_id,
        &p.debt_asset_id,
        &p.quote_asset_id,
        now,
    )?;
    let debt_value = quote_value(
        principal,
        mark(&marks, &p.debt_asset_id)?.mark.price,
        Round::Ceil,
    );
    let collateral_value = quote_value(
        collateral,
        mark(&marks, &p.collateral_asset_id)?.mark.price,
        Round::Floor,
    );
    let ltv = ltv_bps(debt_value, collateral_value)?;
    if ltv > p.max_ltv_bps {
        return Err(refuse(
            "bank.ltv_exceeded",
            format!(
                "Opening LTV {} exceeds the {} limit for \"{}\" — post more collateral or borrow less",
                describe_ltv(ltv),
                describe_ltv(p.max_ltv_bps),
                p.name
            ),
        ));
    }
    Ok(ltv)
}

/// `withOpenLock`: one open or abandon at a time per loan, across replicas.
fn with_open_lock<T>(
    d: &Deps<'_>,
    loan_id: &str,
    body: impl FnOnce() -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    super::locks::with_lock(d.store, "bank.loan.open", loan_id, body)
}

/// `touchAttempt`: "a post attempt starts now", on the database clock.
fn touch_attempt(d: &Deps<'_>, loan_id: &str) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loans SET updated_at = now() WHERE id = $1::text::uuid AND status = 'pending'",
            &[&loan_id],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })
}

fn activate(d: &Deps<'_>, loan_id: &str, draw_tx: &str, now: Instant) -> Result<Loan, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.loans
                        SET status = 'active', draw_ledger_tx_id = $2, drawn_at = to_timestamp($3::float8 / 1000),
                            last_mark_price = NULL, updated_at = now()
                      WHERE id = $1::text::uuid AND status = 'pending'
                      RETURNING {}",
                    loan_cols("")
                ),
                &[&loan_id, &draw_tx, &instant_f64(now)],
            )
            .map_err(|e| pg(&e))?;
        match rows.first() {
            Some(r) => Loan::from_row(r),
            None => loan(c, loan_id),
        }
    })
}

/// `adoptBookedDraw`: the draw is booked, so record it and go active; never posts. A lock row that did not record its
/// tx is settled from the ledger's own record.
fn adopt_booked_draw(
    d: &Deps<'_>,
    l: &Loan,
    draw_tx: &str,
    now: Instant,
) -> Result<(Loan, String), Refusal> {
    let lock = with(d.store, |c| collateral_event(c, &l.id, 0))?;
    let mut collateral_tx = lock
        .as_ref()
        .and_then(|e| e.ledger_tx_id.clone())
        .unwrap_or_default();
    if let Some(e) = lock.filter(|e| e.ledger_tx_id.is_none()) {
        let _ = amount_text(&e.amount)?;
        if let Some(booked) = d
            .ledger
            .tx_by_key(&lock_key(&l.id, 0))
            .map_err(Refusal::Other)?
        {
            collateral_tx = booked.id.clone();
            with(d.store, |c| {
                c.execute(
                    "UPDATE bank.loan_collateral_events
                        SET status = 'settled', ledger_tx_id = $2, settled_at = now()
                      WHERE loan_id = $1::text::uuid AND sequence = 0 AND status = 'pending'",
                    &[&l.id, &booked.id],
                )
                .map(|_| ())
                .map_err(|e| pg(&e))
            })?;
        }
    }
    Ok((activate(d, &l.id, draw_tx, now)?, collateral_tx))
}

/// `completePending`: drive a pending loan to active, lock (once) then draw (once), under the open lock. Recovery looks
/// the draw key up first and adopts a booked draw; otherwise it re-checks the opening LTV on a fresh mark.
fn complete_pending(
    d: &Deps<'_>,
    l: &Loan,
    collateral: Amount,
    opening_ltv: i64,
    now: Instant,
    recovery: bool,
) -> Result<Opened, Refusal> {
    with_open_lock(d, &l.id, || {
        let current = with(d.store, |c| loan(c, &l.id))?;
        if current.status != "pending" {
            let (collateral_tx, draw_tx) = draw_record(d, &l.id)?;
            return Ok(Opened {
                loan: current,
                ltv_bps: opening_ltv,
                collateral_ledger_tx_id: collateral_tx,
                draw_ledger_tx_id: draw_tx,
            });
        }
        let mut ltv = opening_ltv;
        if recovery {
            if let Some(booked) = d
                .ledger
                .tx_by_key(&draw_key(&current.id))
                .map_err(Refusal::Other)?
            {
                let (adopted, collateral_tx) = adopt_booked_draw(d, &current, &booked.id, now)?;
                return Ok(Opened {
                    loan: adopted,
                    ltv_bps: ltv,
                    collateral_ledger_tx_id: collateral_tx,
                    draw_ledger_tx_id: booked.id,
                });
            }
            let p = with(d.store, |c| product(c, &current.product_id))?;
            ltv = check_opening_ltv(d, &p, collateral, current.principal, now)?;
        }
        // Step 1: collateral. A crash after this leaves the collateral in the borrower's own purposed account.
        touch_attempt(d, &current.id)?;
        let collateral_tx = match lock_collateral(d, &current, collateral, &current.id, Some(0)) {
            Ok((tx, _)) => tx,
            Err(Fail::Post(e)) if e.insufficient() => {
                return Err(refuse(
                    "bank.loan_collateral_short",
                    format!(
                        "Borrower cannot lock {} {} for loan {}. The loan is pending; fund the collateral or abandon \
                         the pending row.",
                        format_amount(collateral),
                        current.collateral_asset_id,
                        current.id
                    ),
                ));
            }
            Err(e) => return Err(e.refusal()),
        };
        // Step 2: principal.
        touch_attempt(d, &current.id)?;
        let draw = post(
            d,
            "loanDraw",
            &Json::obj([
                ("loanId", Json::str(current.id.clone())),
                ("userId", Json::str(current.user_id.clone())),
                ("debtAssetId", Json::str(current.debt_asset_id.clone())),
                ("principal", Json::str(format_amount(current.principal))),
            ]),
            &draw_key(&current.id),
            true,
        );
        let draw_tx = match draw {
            Ok(tx) => tx.id,
            Err(e) if e.insufficient() => {
                return Err(refuse(
                    "bank.loan_reserve_underfunded",
                    format!(
                        "The {} lending reserve cannot fund {}. The loan is pending with collateral locked; release it \
                         or fund the reserve.",
                        current.debt_asset_id,
                        format_amount(current.principal)
                    ),
                ));
            }
            Err(e) => return Err(e.refusal()),
        };
        // Status and tx id commit together: no window where the principal moved and the row does not know.
        let active = activate(d, &current.id, &draw_tx, now)?;
        Ok(Opened {
            loan: active,
            ltv_bps: ltv,
            collateral_ledger_tx_id: collateral_tx,
            draw_ledger_tx_id: draw_tx,
        })
    })
}

/// One pass of `resumePending`.
pub struct Resumed {
    pub loan_id: String,
    pub outcome: &'static str,
    pub reason: Option<String>,
}

impl Resumed {
    pub fn json(&self) -> Json {
        let mut f = vec![
            ("loanId".to_owned(), Json::str(self.loan_id.clone())),
            ("outcome".to_owned(), Json::str(self.outcome)),
        ];
        if let Some(r) = &self.reason {
            f.push(("reason".to_owned(), Json::str(r.clone())));
        }
        Json::Object(f)
    }
}

/// The message a refusal carries, as `err.message` reads it.
pub fn message_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.message.clone(),
        Refusal::Trpc(e) => e.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

/// `assertLoanResumePendingLimit`.
pub fn resume_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    crate::earn::service::job_batch_limit(
        limit,
        "bank.loan_resume_pending_limit_unset",
        100,
        1_000,
        "loans.resumePending",
    )
}

/// `resumePending`: re-drive every pending loan, oldest first. A rejected lock is final; a booked draw is adopted;
/// otherwise the opening LTV is re-checked before the draw is re-posted.
pub fn resume_pending(d: &Deps<'_>, limit: Option<f64>) -> Result<Vec<Resumed>, Refusal> {
    let batch = resume_limit(limit)?;
    let loans = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.loans WHERE status = 'pending' ORDER BY opened_at ASC LIMIT $1",
                loan_cols("")
            ),
            &[&batch],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Loan::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let mut out = Vec::new();
    for l in loans {
        let one = (|| {
            let Some(locked) = with(d.store, |c| collateral_event(c, &l.id, 0))? else {
                return Ok(Some("no collateral event to resume from".to_owned()));
            };
            if locked.status == "rejected" {
                return Ok(Some(
                    "bank.loan_collateral_rejected: the collateral lock was refused by the ledger; abandon the loan"
                        .to_owned(),
                ));
            }
            complete_pending(d, &l, amount_text(&locked.amount)?, 0, d.now, true)?;
            Ok(None)
        })();
        out.push(match one {
            Ok(None) => Resumed {
                loan_id: l.id.clone(),
                outcome: "completed",
                reason: None,
            },
            Ok(Some(reason)) => Resumed {
                loan_id: l.id.clone(),
                outcome: "failed",
                reason: Some(reason),
            },
            Err(e) => Resumed {
                loan_id: l.id.clone(),
                outcome: "failed",
                reason: Some(message_of(&e)),
            },
        });
    }
    Ok(out)
}

/// What `abandonPending` did.
pub struct Abandoned {
    pub released: Amount,
    pub ledger_tx_id: Option<String>,
    pub adopted: bool,
    pub draw_ledger_tx_id: Option<String>,
}

/// `abandonPending`: look first. A booked draw is adopted (the collateral now secures real debt); an unbooked one whose
/// last attempt is past the in-flight bound releases the collateral and closes the loan; a recent one refuses.
pub fn abandon_pending(d: &Deps<'_>, loan_id: &str) -> Result<Abandoned, Refusal> {
    with_open_lock(d, loan_id, || {
        let l = with(d.store, |c| loan(c, loan_id))?;
        if l.status != "pending" {
            return Err(refuse(
                "bank.loan_not_drawable",
                format!(
                    "Loan {loan_id} is {}, not pending — its collateral secures drawn principal",
                    l.status
                ),
            ));
        }
        if let Some(booked) = d
            .ledger
            .tx_by_key(&draw_key(&l.id))
            .map_err(Refusal::Other)?
        {
            adopt_booked_draw(d, &l, &booked.id, d.now)?;
            return Ok(Abandoned {
                released: 0,
                ledger_tx_id: None,
                adopted: true,
                draw_ledger_tx_id: Some(booked.id),
            });
        }
        let wait: i64 = with(d.store, |c| {
            let rows = c
                .query(
                    "SELECT GREATEST(0, CEIL($2::text::numeric - EXTRACT(EPOCH FROM (now() - updated_at))))::int8
                       FROM bank.loans WHERE id = $1::text::uuid",
                    &[&loan_id, &IN_FLIGHT_BOUND_SECONDS.to_string()],
                )
                .map_err(|e| pg(&e))?;
            rows.first()
                .map_or(Ok(0), |r| r.try_get(0).map_err(|e| pg(&e)))
        })?;
        if wait > 0 {
            return Err(refuse(
                "bank.loan_attempt_too_recent",
                format!(
                    "Loan {loan_id} had a ledger post attempt less than {} minutes ago, so the ledger may still commit \
                     it. Wait {wait} seconds and try again",
                    IN_FLIGHT_BOUND_SECONDS / 60
                ),
            ));
        }
        let held = collateral_of(d, &l)?;
        let close = || {
            with(d.store, |c| {
                c.execute(
                    "UPDATE bank.loans SET status = 'repaid', closed_at = now(), updated_at = now() WHERE id = $1::text::uuid",
                    &[&loan_id],
                )
                .map(|_| ())
                .map_err(|e| pg(&e))
            })
        };
        if held <= 0 {
            close()?;
            return Ok(Abandoned {
                released: 0,
                ledger_tx_id: None,
                adopted: false,
                draw_ledger_tx_id: None,
            });
        }
        let tx = release_collateral(d, &l, held, None).map_err(Fail::refusal)?;
        close()?;
        Ok(Abandoned {
            released: held,
            ledger_tx_id: Some(tx),
            adopted: false,
            draw_ledger_tx_id: None,
        })
    })
}

// ── Collateral ───────────────────────────────────────────────────────────────────────────────────────────────────────

/// A collateral event row.
#[derive(Debug, Clone)]
pub struct CollateralEvent {
    pub id: String,
    pub loan_id: String,
    pub sequence: i64,
    pub direction: String,
    pub amount: String,
    pub ledger_tx_id: Option<String>,
    pub status: String,
}

const EVENT_COLS: &str = "id::text, loan_id::text, sequence::int8, direction::text, amount::text, ledger_tx_id, status::text";

fn event_of(r: &postgres::Row) -> Result<CollateralEvent, Refusal> {
    let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    Ok(CollateralEvent {
        id: g(0)?,
        loan_id: g(1)?,
        sequence: r.try_get(2).map_err(|e| pg(&e))?,
        direction: g(3)?,
        amount: g(4)?,
        ledger_tx_id: r.try_get(5).map_err(|e| pg(&e))?,
        status: g(6)?,
    })
}

/// `collateralEvent`: the loan's event at `sequence`.
pub fn collateral_event(
    c: &mut impl GenericClient,
    loan_id: &str,
    sequence: i64,
) -> Result<Option<CollateralEvent>, Refusal> {
    #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
    let seq = sequence as i32;
    c.query(
        &format!(
            "SELECT {EVENT_COLS} FROM bank.loan_collateral_events WHERE loan_id = $1::text::uuid AND sequence = $2"
        ),
        &[&loan_id, &seq],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(event_of)
    .transpose()
}

/// `collateralEventById`.
pub fn collateral_event_by_id(
    c: &mut impl GenericClient,
    id: &str,
) -> Result<Option<CollateralEvent>, Refusal> {
    c.query(
        &format!("SELECT {EVENT_COLS} FROM bank.loan_collateral_events WHERE id = $1::text::uuid"),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(event_of)
    .transpose()
}

/// `assertCollateralRetryMatches`: the same event id is the same loan, direction and amount.
fn assert_retry_matches(
    l: &Loan,
    event_id: &str,
    amount: Amount,
    existing: &CollateralEvent,
    direction: &str,
) -> Result<(), Refusal> {
    if existing.loan_id != l.id {
        return Err(refuse(
            "bank.loan_borrower_mismatch",
            format!(
                "Collateral event {event_id} already exists on a different loan — a retry must carry the same terms"
            ),
        ));
    }
    if existing.direction != direction {
        return Err(refuse(
            "bank.loan_collateral_mismatch",
            format!(
                "Collateral event {event_id} is a {}, not a {direction} — a retry must carry the same terms",
                existing.direction
            ),
        ));
    }
    let stored = amount_text(&existing.amount)?;
    if stored != amount {
        return Err(refuse(
            "bank.loan_collateral_mismatch",
            format!(
                "Collateral event {event_id} already exists for {} {}, but this request asks for {} — a retry must \
                 carry the same terms. Use a new event id to post a different amount",
                format_amount(stored),
                l.collateral_asset_id,
                format_amount(amount)
            ),
        ));
    }
    Ok(())
}

fn not_drawable(message: String) -> Refusal {
    refuse("bank.loan_not_drawable", message)
}

fn loan_closed(l: &Loan) -> Refusal {
    refuse("bank.loan_closed", format!("Loan {} is {}", l.id, l.status))
}

fn collateral_input(l: &Loan, amount: Amount, sequence: i64) -> Json {
    Json::obj([
        ("loanId", Json::str(l.id.clone())),
        ("userId", Json::str(l.user_id.clone())),
        (
            "collateralAssetId",
            Json::str(l.collateral_asset_id.clone()),
        ),
        ("amount", Json::str(format_amount(amount))),
        ("sequence", Json::int(sequence)),
    ])
}

/// `addCollateral`: a top-up of a drawn loan under the caller's event id (required: omitting it used to post twice).
/// Curing a call is the next mark's job.
pub fn add_collateral(
    d: &Deps<'_>,
    loan_id: &str,
    event_id: &str,
    amount: Amount,
) -> Result<(String, i64), Refusal> {
    if event_id.is_empty() {
        return Err(refuse(
            "bank.event_id_required",
            "eventId is required for a retry-safe collateral lock",
        ));
    }
    let l = with(d.store, |c| loan(c, loan_id))?;
    if l.closed() {
        return Err(loan_closed(&l));
    }
    if l.status == "pending" {
        return Err(not_drawable(format!(
            "Loan {} is pending — it has no drawn principal to secure; resume or abandon it rather than topping it up",
            l.id
        )));
    }
    if amount <= 0 {
        return Err(refuse(
            "bank.below_minimum",
            "Collateral top-up must be positive",
        ));
    }
    marks_for(
        d,
        &l.collateral_asset_id,
        &l.debt_asset_id,
        &l.quote_asset_id,
        d.now,
    )?;
    if let Some(existing) = with(d.store, |c| collateral_event_by_id(c, event_id))? {
        assert_retry_matches(&l, event_id, amount, &existing, "lock")?;
    }
    lock_collateral(d, &l, amount, event_id, None).map_err(Fail::refusal)
}

/// `lockCollateral`: claim the event under the loan row lock (MAX+1 for a new top-up, sequence 0 at open), then post
/// `loanCollateralLock` keyed on the claimed sequence. A clash on `(loan_id, sequence)` with a closing release takes the
/// next sequence.
fn lock_collateral(
    d: &Deps<'_>,
    l: &Loan,
    amount: Amount,
    event_id: &str,
    fixed_sequence: Option<i64>,
) -> Result<(String, i64), Fail> {
    let seq = std::cell::Cell::new(0_i64);
    let tx = driven_post(
        d,
        "loan_collateral_events",
        |tx| {
            tx.execute(
                "SELECT id FROM bank.loans WHERE id = $1::text::uuid FOR UPDATE",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?;
            for _ in 0..5 {
                if let Some(prior) = collateral_event_by_id(tx, event_id)? {
                    assert_retry_matches(l, event_id, amount, &prior, "lock")?;
                    seq.set(prior.sequence);
                    return Ok(Claim::Existing {
                        id: prior.id,
                        ledger_tx: prior.ledger_tx_id,
                    });
                }
                let next = next_sequence(tx, "loan_collateral_events", &l.id, "sequence")?;
                #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
                let s = fixed_sequence.unwrap_or(next) as i32;
                let rows = tx
                    .query(
                        &format!(
                            "INSERT INTO bank.loan_collateral_events (id, loan_id, sequence, direction, amount)
                             VALUES ($1::text::uuid, $2::text::uuid, $3, 'lock', $4::text::numeric)
                             ON CONFLICT DO NOTHING
                             RETURNING {EVENT_COLS}"
                        ),
                        &[&event_id, &l.id, &s, &format_amount(amount)],
                    )
                    .map_err(|e| pg(&e))?;
                if let Some(r) = rows.first() {
                    let e = event_of(r)?;
                    seq.set(e.sequence);
                    return Ok(Claim::Claimed { id: e.id });
                }
            }
            Err(Refusal::Other(format!(
                "Collateral lock {event_id} on loan {} found no free sequence after 5 tries",
                l.id
            )))
        },
        || {
            let s = seq.get();
            post(
                d,
                "loanCollateralLock",
                &collateral_input(l, amount, s),
                &lock_key(&l.id, s),
                true,
            )
        },
        None,
    )?;
    Ok((tx, seq.get()))
}

/// A closing release of everything held (`releaseCollateral(loan, held)`).
pub fn release_collateral_closing(d: &Deps<'_>, l: &Loan, held: Amount) -> Result<String, Refusal> {
    release_collateral(d, l, held, None).map_err(Fail::refusal)
}

/// `releaseCollateral` with no event id: a closing release at `sequence` (MAX+1 when none is named).
fn release_collateral(
    d: &Deps<'_>,
    l: &Loan,
    amount: Amount,
    sequence: Option<i64>,
) -> Result<String, Fail> {
    let seq = match sequence {
        Some(s) => s,
        None => with(d.store, |c| {
            next_sequence(c, "loan_collateral_events", &l.id, "sequence")
        })?,
    };
    #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
    let s32 = seq as i32;
    driven_post(
        d,
        "loan_collateral_events",
        |tx| {
            let rows = tx
                .query(
                    "INSERT INTO bank.loan_collateral_events (loan_id, sequence, direction, amount)
                     VALUES ($1::text::uuid, $2, 'release', $3::text::numeric)
                     ON CONFLICT (loan_id, sequence) DO NOTHING
                     RETURNING id::text, ledger_tx_id",
                    &[&l.id, &s32, &format_amount(amount)],
                )
                .map_err(|e| pg(&e))?;
            if let Some(r) = rows.first() {
                return Ok(Claim::Claimed {
                    id: r.try_get(0).map_err(|e| pg(&e))?,
                });
            }
            let r = tx
                .query_one(
                    "SELECT id::text, ledger_tx_id FROM bank.loan_collateral_events WHERE loan_id = $1::text::uuid AND sequence = $2",
                    &[&l.id, &s32],
                )
                .map_err(|e| pg(&e))?;
            Ok(Claim::Existing {
                id: r.try_get(0).map_err(|e| pg(&e))?,
                ledger_tx: r.try_get(1).map_err(|e| pg(&e))?,
            })
        },
        || {
            post(
                d,
                "loanCollateralRelease",
                &collateral_input(l, amount, seq),
                &release_key(&l.id, seq),
                true,
            )
        },
        None,
    )
}

/// What `releasable` reads.
pub struct Releasable {
    pub held: Amount,
    pub releasable: Amount,
    pub max_ltv_bps: i64,
    pub ltv_bps: i64,
}

fn pending_releases(
    c: &mut impl GenericClient,
    loan_id: &str,
    own_row: Option<&str>,
) -> Result<Amount, Refusal> {
    let r = c
        .query_one(
            "SELECT COALESCE(SUM(amount), 0)::text FROM bank.loan_collateral_events
              WHERE loan_id = $1::text::uuid AND direction = 'release' AND status = 'pending'
                AND ($2::text IS NULL OR id <> $2::text::uuid)",
            &[&loan_id, &own_row],
        )
        .map_err(|e| pg(&e))?;
    amount_text(&r.try_get::<_, String>(0).map_err(|e| pg(&e))?)
}

/// `releasable` (BK-loan-05): the most collateral `releaseExcess` would let go of now, at the product's max LTV, with
/// pending releases reserved. A read.
pub fn releasable(d: &Deps<'_>, loan_id: &str) -> Result<Releasable, Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    if l.closed() {
        return Err(loan_closed(&l));
    }
    if l.status == "pending" {
        return Err(not_drawable(format!(
            "Loan {} is pending; nothing is drawn, so nothing is releasable yet",
            l.id
        )));
    }
    let marks = marks_for(
        d,
        &l.collateral_asset_id,
        &l.debt_asset_id,
        &l.quote_asset_id,
        d.now,
    )?;
    let p = with(d.store, |c| product(c, &l.product_id))?;
    let reserved = with(d.store, |c| pending_releases(c, &l.id, None))?;
    let ledger_held = collateral_of(d, &l)?;
    let held = if ledger_held > reserved {
        ledger_held - reserved
    } else {
        0
    };
    let debt = with(d.store, |c| outstanding(c, &l.id))?;
    let debt_value = quote_value(
        debt.total,
        mark(&marks, &l.debt_asset_id)?.mark.price,
        Round::Ceil,
    );
    let price = mark(&marks, &l.collateral_asset_id)?.mark.price;
    let ltv_after =
        |release: Amount| ltv_bps(debt_value, quote_value(held - release, price, Round::Floor));
    let now_ltv = ltv_after(0)?;
    let mut lo: Amount = 0;
    if now_ltv <= p.max_ltv_bps {
        let mut hi = held;
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            if ltv_after(mid)? <= p.max_ltv_bps {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
    }
    Ok(Releasable {
        held,
        releasable: lo,
        max_ltv_bps: p.max_ltv_bps,
        ltv_bps: now_ltv,
    })
}

/// `releaseExcess`: a named release under the caller's event id, capped at the product's max LTV at today's marks.
pub fn release_excess(
    d: &Deps<'_>,
    loan_id: &str,
    event_id: &str,
    amount: Amount,
) -> Result<(String, i64), Refusal> {
    if event_id.is_empty() {
        return Err(refuse(
            "bank.event_id_required",
            "eventId is required for a retry-safe collateral release",
        ));
    }
    let l = with(d.store, |c| loan(c, loan_id))?;
    if l.closed() {
        return Err(loan_closed(&l));
    }
    if l.status == "pending" {
        return Err(not_drawable(format!(
            "Loan {} is pending — abandon it rather than peeling collateral off an undrawn row",
            l.id
        )));
    }
    if amount <= 0 {
        return Err(refuse(
            "bank.below_minimum",
            "Collateral release must be positive",
        ));
    }
    let marks = marks_for(
        d,
        &l.collateral_asset_id,
        &l.debt_asset_id,
        &l.quote_asset_id,
        d.now,
    )?;
    let p = with(d.store, |c| product(c, &l.product_id))?;
    let tx = release_named(d, &l, amount, event_id, &marks, &p).map_err(Fail::refusal)?;
    let Some(stored) = with(d.store, |c| collateral_event_by_id(c, event_id))? else {
        return Err(refuse(
            "bank.loan_not_found",
            format!("Collateral release {event_id} was not claimed"),
        ));
    };
    Ok((tx, stored.sequence))
}

/// `releaseNamedCollateral`: the loan row lock held across the cap check and the claim, then dropped before the post.
/// A retried row with no tx is looked up on the ledger: booked is safe to re-drive, unbooked meets the cap again.
fn release_named(
    d: &Deps<'_>,
    l: &Loan,
    amount: Amount,
    event_id: &str,
    marks: &Marks,
    p: &Product,
) -> Result<String, Fail> {
    let seq = std::cell::Cell::new(0_i64);
    driven_post(
        d,
        "loan_collateral_events",
        |tx| {
            tx.execute(
                "SELECT id FROM bank.loans WHERE id = $1::text::uuid FOR UPDATE",
                &[&l.id],
            )
            .map_err(|e| pg(&e))?;
            let check_cap = |tx: &mut Transaction<'_>, own: Option<&str>| -> Result<(), Refusal> {
                let reserved = pending_releases(tx, &l.id, own)?;
                let ledger_held = collateral_of(d, l)?;
                let held = if ledger_held > reserved {
                    ledger_held - reserved
                } else {
                    0
                };
                if amount > held {
                    return Err(refuse(
                        "bank.loan_collateral_short",
                        format!(
                            "Loan {} holds {} {}, not {}",
                            l.id,
                            format_amount(held),
                            l.collateral_asset_id,
                            format_amount(amount)
                        ),
                    ));
                }
                let debt = outstanding(tx, &l.id)?;
                let debt_value = quote_value(
                    debt.total,
                    mark(marks, &l.debt_asset_id)?.mark.price,
                    Round::Ceil,
                );
                let collateral_value = quote_value(
                    held - amount,
                    mark(marks, &l.collateral_asset_id)?.mark.price,
                    Round::Floor,
                );
                let after = ltv_bps(debt_value, collateral_value)?;
                if after > p.max_ltv_bps {
                    return Err(refuse(
                        "bank.ltv_exceeded",
                        format!(
                            "Release would put loan {} at LTV {} above the {} limit for \"{}\"",
                            l.id,
                            describe_ltv(after),
                            describe_ltv(p.max_ltv_bps),
                            p.name
                        ),
                    ));
                }
                Ok(())
            };
            if let Some(prior) = collateral_event_by_id(tx, event_id)? {
                assert_retry_matches(l, event_id, amount, &prior, "release")?;
                seq.set(prior.sequence);
                if prior.ledger_tx_id.is_none() {
                    let booked = d
                        .ledger
                        .tx_by_key(&release_key(&l.id, prior.sequence))
                        .map_err(Refusal::Other)?;
                    if booked.is_none() {
                        check_cap(tx, Some(&prior.id))?;
                    }
                }
                return Ok(Claim::Existing {
                    id: prior.id,
                    ledger_tx: prior.ledger_tx_id,
                });
            }
            check_cap(tx, None)?;
            let next = next_sequence(tx, "loan_collateral_events", &l.id, "sequence")?;
            seq.set(next);
            #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
            let s = next as i32;
            let rows = tx
                .query(
                    &format!(
                        "INSERT INTO bank.loan_collateral_events (id, loan_id, sequence, direction, amount)
                         VALUES ($1::text::uuid, $2::text::uuid, $3, 'release', $4::text::numeric)
                         ON CONFLICT (id) DO NOTHING
                         RETURNING {EVENT_COLS}"
                    ),
                    &[&event_id, &l.id, &s, &format_amount(amount)],
                )
                .map_err(|e| pg(&e))?;
            if let Some(r) = rows.first() {
                let e = event_of(r)?;
                seq.set(e.sequence);
                return Ok(Claim::Claimed { id: e.id });
            }
            let Some(row) = collateral_event_by_id(tx, event_id)? else {
                return Err(Refusal::Other(format!("release {event_id} vanished")));
            };
            assert_retry_matches(l, event_id, amount, &row, "release")?;
            seq.set(row.sequence);
            Ok(Claim::Existing {
                id: row.id,
                ledger_tx: row.ledger_tx_id,
            })
        },
        || {
            let s = seq.get();
            post(
                d,
                "loanCollateralRelease",
                &collateral_input(l, amount, s),
                &release_key(&l.id, s),
                true,
            )
        },
        None,
    )
}

/// `nextSequence`: MAX + 1 of an int4 sequence column, from 0.
pub fn next_sequence(
    c: &mut impl GenericClient,
    table: &str,
    loan_id: &str,
    column: &str,
) -> Result<i64, Refusal> {
    let r = c
        .query_one(
            &format!(
                "SELECT COALESCE(MAX(\"{column}\") + 1, 0)::int8 FROM bank.{table} WHERE loan_id = $1::text::uuid"
            ),
            &[&loan_id],
        )
        .map_err(|e| pg(&e))?;
    r.try_get(0).map_err(|e| pg(&e))
}

/// `drawRecord`: the opening lock's tx and the draw's tx, `""` for either not recorded.
fn draw_record(d: &Deps<'_>, loan_id: &str) -> Result<(String, String), Refusal> {
    with(d.store, |c| {
        let l = loan(c, loan_id)?;
        let e = collateral_event(c, loan_id, 0)?;
        Ok((
            e.and_then(|e| e.ledger_tx_id).unwrap_or_default(),
            l.draw_ledger_tx_id.unwrap_or_default(),
        ))
    })
}

// ── Interest ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// One accrued day.
pub struct AccruedDay {
    pub date: String,
    pub interest: Amount,
    pub basis: Amount,
    pub already: bool,
}

/// What `accrue` did for one loan.
pub struct Accrued {
    pub loan_id: String,
    pub days: Vec<AccruedDay>,
    pub charged: Amount,
}

/// A `RiskError` as the service throws it: a bank code is a refusal, anything else (a `RangeError`) an error.
pub fn backlog(e: RiskError) -> Refusal {
    refuse(&e.code, e.message)
}

/// `ltvBps`, its errors as refusals.
pub fn ltv_bps(debt_value: Amount, collateral_value: Amount) -> Result<i64, Refusal> {
    super::risk::ltv_bps(debt_value, collateral_value).map_err(backlog)
}

/// `accrue`: every day the loan owes and no day twice (`unique(loan_id, accrual_date)`), each on the debt at the end
/// of the day before, so a catch-up charges exactly what nightly runs would have. A zero day is still written.
pub fn accrue(d: &Deps<'_>, loan_id: &str, until: Instant) -> Result<Accrued, Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    let none = |l: &Loan| Accrued {
        loan_id: l.id.clone(),
        days: Vec::new(),
        charged: 0,
    };
    if l.closed() || l.status == "pending" {
        return Ok(none(&l));
    }
    let last = with(d.store, |c| last_accrued(c, &l.id))?;
    let days = days_to_accrue(last.as_deref(), l.opened_at, until, 400).map_err(backlog)?;
    if days.is_empty() {
        return Ok(none(&l));
    }
    let mut debt = with(d.store, |c| outstanding(c, &l.id))?.total;
    let mut charged: Amount = 0;
    let mut out = Vec::new();
    #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
    let rate = l.apr_bps as i32;
    for day in days {
        let interest =
            daily_loan_interest(debt, l.apr_bps, d.settings.days_per_year).map_err(backlog)?;
        let written = with(d.store, |c| {
            Ok(!c
                .query(
                    "INSERT INTO bank.loan_interest_accruals (loan_id, accrual_date, rate_bps, principal_basis, interest_amount)
                     VALUES ($1::text::uuid, $2::text::date, $3, $4::text::numeric, $5::text::numeric)
                     ON CONFLICT (loan_id, accrual_date) DO NOTHING
                     RETURNING id",
                    &[&l.id, &day, &rate, &format_amount(debt), &format_amount(interest)],
                )
                .map_err(|e| pg(&e))?
                .is_empty())
        })?;
        if !written {
            // The guard firing: the day was charged once already. The running debt follows the row, not our sum.
            let actual = with(d.store, |c| {
                let r = c
                    .query_one(
                        "SELECT interest_amount::text FROM bank.loan_interest_accruals
                          WHERE loan_id = $1::text::uuid AND accrual_date = $2::text::date",
                        &[&l.id, &day],
                    )
                    .map_err(|e| pg(&e))?;
                amount_text(&r.try_get::<_, String>(0).map_err(|e| pg(&e))?)
            })?;
            debt += actual;
            out.push(AccruedDay {
                date: day,
                interest: actual,
                basis: debt - actual,
                already: true,
            });
            continue;
        }
        debt += interest;
        charged += interest;
        out.push(AccruedDay {
            date: day,
            interest,
            basis: debt - interest,
            already: false,
        });
    }
    Ok(Accrued {
        loan_id: l.id,
        days: out,
        charged,
    })
}

/// The last day accrued, `YYYY-MM-DD`.
pub fn last_accrued(c: &mut impl GenericClient, loan_id: &str) -> Result<Option<String>, Refusal> {
    let r = c
        .query_one(
            "SELECT MAX(accrual_date)::text FROM bank.loan_interest_accruals WHERE loan_id = $1::text::uuid",
            &[&loan_id],
        )
        .map_err(|e| pg(&e))?;
    r.try_get(0).map_err(|e| pg(&e))
}

/// One loan's line in `accrueAll`.
pub struct AccrueLine {
    pub loan_id: String,
    pub charged: Amount,
    pub days: usize,
}

/// One loan `accrueAll` could not accrue.
pub struct AccrueFailure {
    pub loan_id: String,
    pub reason: String,
    pub code: Option<String>,
}

/// `accrueAll`'s report.
pub struct AccrueReport {
    pub results: Vec<AccrueLine>,
    pub failures: Vec<AccrueFailure>,
}

/// `accrueAll`: every open loan, oldest first, one bad loan never stopping the rest; failures returned, not swallowed.
pub fn accrue_all(
    d: &Deps<'_>,
    until: Instant,
    limit: Option<f64>,
) -> Result<AccrueReport, Refusal> {
    let batch = crate::earn::service::job_batch_limit(
        limit,
        "bank.loan_accrue_batch_limit_unset",
        1_000,
        10_000,
        "loans.accrueAll",
    )?;
    let ids: Vec<String> = with(d.store, |c| {
        c.query(
            "SELECT id::text FROM bank.loans WHERE status IN ('active', 'margin_call', 'liquidating') ORDER BY opened_at ASC LIMIT $1",
            &[&batch],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| r.try_get(0).map_err(|e| pg(&e)))
        .collect()
    })?;
    let mut report = AccrueReport {
        results: Vec::new(),
        failures: Vec::new(),
    };
    for id in ids {
        match accrue(d, &id, until) {
            Ok(a) => report.results.push(AccrueLine {
                loan_id: id,
                charged: a.charged,
                days: a.days.len(),
            }),
            Err(e) => report.failures.push(AccrueFailure {
                loan_id: id,
                reason: message_of(&e),
                code: match &e {
                    Refusal::Bank(b) => Some(b.row.code.to_owned()),
                    _ => None,
                },
            }),
        }
    }
    Ok(report)
}

// ── Repayment ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// What `repay` answers.
pub struct Repaid {
    pub ledger_tx_id: String,
    pub sequence: i64,
    pub interest_paid: Amount,
    pub principal_paid: Amount,
    pub remaining: Debt,
    pub closed: bool,
}

struct RepaymentRow {
    id: String,
    loan_id: String,
    sequence: i64,
    ledger_tx_id: Option<String>,
    interest: Amount,
    principal: Amount,
}

const REPAYMENT_COLS: &str = "id::text, loan_id::text, sequence::int8, ledger_tx_id, interest_amount::text, principal_amount::text";

fn repayment_of(r: &postgres::Row) -> Result<RepaymentRow, Refusal> {
    Ok(RepaymentRow {
        id: r.try_get(0).map_err(|e| pg(&e))?,
        loan_id: r.try_get(1).map_err(|e| pg(&e))?,
        sequence: r.try_get(2).map_err(|e| pg(&e))?,
        ledger_tx_id: r.try_get(3).map_err(|e| pg(&e))?,
        interest: amount_text(&r.try_get::<_, String>(4).map_err(|e| pg(&e))?)?,
        principal: amount_text(&r.try_get::<_, String>(5).map_err(|e| pg(&e))?)?,
    })
}

fn repayment_by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<RepaymentRow>, Refusal> {
    c.query(
        &format!("SELECT {REPAYMENT_COLS} FROM bank.loan_repayments WHERE id = $1::text::uuid"),
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(repayment_of)
    .transpose()
}

fn other_loan_repayment(event_id: &str) -> Refusal {
    refuse(
        "bank.loan_borrower_mismatch",
        format!(
            "Repayment {event_id} already exists on a different loan — a retry must carry the same terms"
        ),
    )
}

fn liquidating(l_id: &str) -> Refusal {
    refuse(
        "bank.loan_liquidating",
        format!("Loan {l_id} is mid-liquidation — wait for insurance cover / sweep before repay"),
    )
}

fn outcome_unknown(message: String) -> Refusal {
    refuse("bank.ledger_outcome_unknown", message)
}

/// `withLoanMoneyLock`: one repayment and one liquidation at a time per loan, both historical keys, sorted.
pub fn with_money_lock<T>(
    d: &Deps<'_>,
    loan_id: &str,
    body: impl FnOnce() -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    super::locks::with_locks(
        d.store,
        &["bank.loan.liquidate", "bank.loan.repay"],
        loan_id,
        body,
    )
}

fn repay_input(l: &Loan, principal: Amount, interest: Amount, sequence: i64) -> Json {
    Json::obj([
        ("loanId", Json::str(l.id.clone())),
        ("userId", Json::str(l.user_id.clone())),
        ("debtAssetId", Json::str(l.debt_asset_id.clone())),
        ("principal", Json::str(format_amount(principal))),
        ("interest", Json::str(format_amount(interest))),
        ("sequence", Json::int(sequence)),
    ])
}

/// `repay`: interest first, never more than is owed, under the caller's event id. The split is decided after the debt
/// is read again with claimed-but-unsettled repayments counted, and the claim, post and settle share one session lock.
/// A debt cleared closes the loan and returns the collateral.
pub fn repay(
    d: &Deps<'_>,
    loan_id: &str,
    amount: Amount,
    event_id: &str,
) -> Result<Repaid, Refusal> {
    if event_id.is_empty() {
        return Err(refuse(
            "bank.repayment_id_required",
            "Loan repay needs a caller-stable event id",
        ));
    }
    let now = d.now;
    let l = with(d.store, |c| loan(c, loan_id))?;
    let prior = with(d.store, |c| repayment_by_id(c, event_id))?;
    if let Some(p) = &prior {
        if p.loan_id != l.id {
            return Err(other_loan_repayment(event_id));
        }
        if let Some(tx) = &p.ledger_tx_id {
            let remaining = with(d.store, |c| outstanding(c, &l.id))?;
            // Settled already: never post again. The crash after the settle leaves the collateral locked; finish it.
            if remaining.total <= 0 && !l.closed() {
                close_repaid(d, &l, now)?;
                return Ok(Repaid {
                    ledger_tx_id: tx.clone(),
                    sequence: p.sequence,
                    interest_paid: p.interest,
                    principal_paid: p.principal,
                    remaining,
                    closed: true,
                });
            }
            return Ok(Repaid {
                ledger_tx_id: tx.clone(),
                sequence: p.sequence,
                interest_paid: p.interest,
                principal_paid: p.principal,
                remaining,
                closed: remaining.total <= 0 || l.closed(),
            });
        }
    }
    if l.closed() {
        return Err(loan_closed(&l));
    }
    if l.status == "pending" {
        return Err(not_drawable(format!(
            "Loan {} has no drawn principal to repay",
            l.id
        )));
    }
    if l.status == "liquidating" {
        return Err(liquidating(&l.id));
    }
    if amount <= 0 {
        return Err(refuse("bank.below_minimum", "A repayment must be positive"));
    }
    if with(d.store, |c| has_open_shortfall(c, &l.id))? {
        return Err(refuse(
            "bank.loan_liquidating",
            format!(
                "Loan {} has uncovered liquidation shortfall — insurance re-drive required",
                l.id
            ),
        ));
    }
    let split = std::cell::Cell::new((
        prior.as_ref().map_or(0, |p| p.interest),
        prior.as_ref().map_or(0, |p| p.principal),
        prior.as_ref().map_or(0, |p| p.sequence),
    ));
    let tx_id = with_money_lock(d, &l.id, || {
        driven_post(
            d,
            "loan_repayments",
            |tx| {
                let locked = tx
                    .query(
                        "SELECT status::text FROM bank.loans WHERE id = $1::text::uuid FOR UPDATE",
                        &[&l.id],
                    )
                    .map_err(|e| pg(&e))?;
                let Some(row) = locked.first() else {
                    return Err(model::loan_not_found(&l.id));
                };
                let status: String = row.try_get(0).map_err(|e| pg(&e))?;
                if let Some(held) = repayment_by_id(tx, event_id)? {
                    if held.loan_id != l.id {
                        return Err(other_loan_repayment(event_id));
                    }
                    split.set((held.interest, held.principal, held.sequence));
                    return Ok(Claim::Existing {
                        id: held.id,
                        ledger_tx: held.ledger_tx_id,
                    });
                }
                if status == "repaid" || status == "liquidated" {
                    return Err(refuse(
                        "bank.loan_closed",
                        format!("Loan {} is {status}", l.id),
                    ));
                }
                if has_pending_liquidation(tx, &l.id)? {
                    return Err(outcome_unknown(format!(
                        "Loan {} has a liquidation whose ledger outcome is not yet known — repay after the sweep \
                         finishes that sale",
                        l.id
                    )));
                }
                if status == "pending" {
                    return Err(not_drawable(format!(
                        "Loan {} has no drawn principal to repay",
                        l.id
                    )));
                }
                if status == "liquidating" {
                    return Err(liquidating(&l.id));
                }
                let debt = outstanding(tx, &l.id)?;
                let r = tx
                    .query_one(
                        "SELECT COALESCE(SUM(principal_amount), 0)::text, COALESCE(SUM(interest_amount), 0)::text
                           FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'pending'",
                        &[&l.id],
                    )
                    .map_err(|e| pg(&e))?;
                let pending_principal = amount_text(&r.try_get::<_, String>(0).map_err(|e| pg(&e))?)?;
                let pending_interest = amount_text(&r.try_get::<_, String>(1).map_err(|e| pg(&e))?)?;
                let interest_open = (debt.interest - pending_interest).max(0);
                let principal_open = (debt.principal - pending_principal).max(0);
                let open = interest_open + principal_open;
                if open <= 0 && pending_principal + pending_interest > 0 {
                    return Err(outcome_unknown(format!(
                        "Loan {} has a repayment whose ledger outcome is not yet known — retry that repayment id or \
                         wait for recovery",
                        l.id
                    )));
                }
                if open <= 0 {
                    return Err(refuse(
                        "bank.loan_closed",
                        format!(
                            "Loan {} has nothing outstanding — release its collateral instead",
                            l.id
                        ),
                    ));
                }
                let pay = amount.min(open);
                let interest_paid = pay.min(interest_open);
                let principal_paid = pay - interest_paid;
                let sequence = next_sequence(tx, "loan_repayments", &l.id, "sequence")?;
                split.set((interest_paid, principal_paid, sequence));
                #[allow(clippy::cast_possible_truncation, reason = "an int4 column")]
                let s = sequence as i32;
                let rows = tx
                    .query(
                        "INSERT INTO bank.loan_repayments (id, loan_id, sequence, interest_amount, principal_amount)
                         VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::numeric, $5::text::numeric)
                         ON CONFLICT (id) DO NOTHING
                         RETURNING id::text, sequence::int8",
                        &[
                            &event_id,
                            &l.id,
                            &s,
                            &format_amount(interest_paid),
                            &format_amount(principal_paid),
                        ],
                    )
                    .map_err(|e| pg(&e))?;
                if let Some(r) = rows.first() {
                    let seq: i64 = r.try_get(1).map_err(|e| pg(&e))?;
                    split.set((interest_paid, principal_paid, seq));
                    return Ok(Claim::Claimed {
                        id: r.try_get(0).map_err(|e| pg(&e))?,
                    });
                }
                let Some(row) = repayment_by_id(tx, event_id)? else {
                    return Err(Refusal::Other(format!("repayment {event_id} vanished")));
                };
                if row.loan_id != l.id {
                    return Err(other_loan_repayment(event_id));
                }
                split.set((row.interest, row.principal, row.sequence));
                Ok(Claim::Existing {
                    id: row.id,
                    ledger_tx: row.ledger_tx_id,
                })
            },
            || {
                let (i, p, s) = split.get();
                post(d, "loanRepay", &repay_input(&l, p, i, s), &repay_key(&l.id, s), true)
            },
            None,
        )
        .map_err(Fail::refusal)
    })?;
    let (interest_paid, principal_paid, sequence) = split.get();
    super::ports::tell_affiliates(
        d.affiliates,
        &super::ports::leg_after_repay(
            &l.id,
            &l.user_id,
            sequence,
            interest_paid,
            &l.debt_asset_id,
        ),
    );
    let remaining = with(d.store, |c| outstanding(c, &l.id))?;
    // Settlement: the debt is clear, so the collateral goes back. Checked here, from a figure derived after the post.
    let mut closed = false;
    if remaining.total <= 0 {
        close_repaid(d, &l, now)?;
        closed = true;
    }
    Ok(Repaid {
        ledger_tx_id: tx_id,
        sequence,
        interest_paid,
        principal_paid,
        remaining,
        closed,
    })
}

/// `releaseSettled`: release the collateral of a loan that owes nothing; refused while anything is owed.
pub fn release_settled(d: &Deps<'_>, loan_id: &str) -> Result<(Amount, Option<String>), Refusal> {
    let l = with(d.store, |c| loan(c, loan_id))?;
    let debt = with(d.store, |c| outstanding(c, &l.id))?;
    if debt.total > 0 {
        return Err(refuse(
            "bank.loan_not_settled",
            format!(
                "Loan {} still owes {} {} — releasing its collateral now would convert a secured position into an \
                 unsecured one, and there is no posting that undoes it once the borrower withdraws",
                l.id,
                format_amount(debt.total),
                l.debt_asset_id
            ),
        ));
    }
    let held = collateral_of(d, &l)?;
    if held <= 0 {
        return Ok((0, None));
    }
    let tx = release_collateral(d, &l, held, None).map_err(Fail::refusal)?;
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loans SET status = 'repaid', closed_at = COALESCE(closed_at, now()), updated_at = now()
              WHERE id = $1::text::uuid",
            &[&loan_id],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })?;
    Ok((held, Some(tx)))
}

pub fn has_open_shortfall(c: &mut impl GenericClient, loan_id: &str) -> Result<bool, Refusal> {
    Ok(count(
        c,
        "SELECT COUNT(*)::int8 FROM bank.loan_liquidations
          WHERE loan_id = $1::text::uuid AND status = 'settled' AND shortfall > 0 AND bad_debt_ledger_tx_id IS NULL",
        loan_id,
    )? > 0)
}

pub fn has_pending_liquidation(c: &mut impl GenericClient, loan_id: &str) -> Result<bool, Refusal> {
    Ok(count(
        c,
        "SELECT COUNT(*)::int8 FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'pending'",
        loan_id,
    )? > 0)
}

pub fn has_pending_repayment(c: &mut impl GenericClient, loan_id: &str) -> Result<bool, Refusal> {
    Ok(count(
        c,
        "SELECT COUNT(*)::int8 FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'pending'",
        loan_id,
    )? > 0)
}

pub fn has_settled_repayment(c: &mut impl GenericClient, loan_id: &str) -> Result<bool, Refusal> {
    Ok(count(
        c,
        "SELECT COUNT(*)::int8 FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'settled'",
        loan_id,
    )? > 0)
}

/// `clearMarginCalls`.
pub fn clear_margin_calls(d: &Deps<'_>, loan_id: &str, now: Instant) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loan_margin_calls SET cleared_at = to_timestamp($2::float8 / 1000)
              WHERE loan_id = $1::text::uuid AND cleared_at IS NULL",
            &[&loan_id, &instant_f64(now)],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })
}

/// `closeRepaid`: the debt is clear, so settle pending releases, release what is still held and mark the loan repaid.
/// Refused while a sale is pending: closing over it would leave that sale unbooked.
pub fn close_repaid(d: &Deps<'_>, l: &Loan, now: Instant) -> Result<(), Refusal> {
    if with(d.store, |c| has_pending_liquidation(c, &l.id))? {
        return Err(outcome_unknown(format!(
            "Loan {} has a liquidation whose ledger outcome is not yet known — it closes after the sweep finishes that sale",
            l.id
        )));
    }
    redrive_pending_releases(d, l)?;
    let held = collateral_of(d, l)?;
    if held > 0 {
        release_collateral(d, l, held, None).map_err(Fail::refusal)?;
    }
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loans SET status = 'repaid', margin_called_at = NULL, closed_at = to_timestamp($2::float8 / 1000),
                    updated_at = now()
              WHERE id = $1::text::uuid AND status IN ('active', 'margin_call')",
            &[&l.id, &instant_f64(now)],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })?;
    clear_margin_calls(d, &l.id, now)
}

/// `reclaimPending`: a re-drive's claim; the row locked and still pending, else skipped.
fn reclaim_pending(tx: &mut Transaction<'_>, table: &str, id: &str) -> Result<Claim, Fail> {
    let rows = tx
        .query(
            &format!("SELECT status::text, ledger_tx_id FROM bank.{table} WHERE id = $1::text::uuid FOR UPDATE"),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(Fail::NoLongerPending(id.to_owned()));
    };
    let status: String = r.try_get(0).map_err(|e| pg(&e))?;
    if status != "pending" {
        return Err(Fail::NoLongerPending(id.to_owned()));
    }
    Ok(Claim::Existing {
        id: id.to_owned(),
        ledger_tx: r.try_get(1).map_err(|e| pg(&e))?,
    })
}

/// `drivenPost` whose claim may say "no longer pending": the claim's answer is carried out of the transaction.
fn redrive(
    d: &Deps<'_>,
    table: &str,
    id: &str,
    post_it: impl FnOnce() -> Result<LedgerTx, PostErr>,
) -> Result<(), Fail> {
    let skipped = std::cell::Cell::new(false);
    let out = driven_post(
        d,
        table,
        |tx| match reclaim_pending(tx, table, id) {
            Ok(c) => Ok(c),
            Err(Fail::NoLongerPending(_)) => {
                skipped.set(true);
                Err(Refusal::Other(format!("row {id} is no longer pending")))
            }
            Err(e) => Err(e.refusal()),
        },
        post_it,
        None,
    );
    match out {
        Ok(_) => Ok(()),
        Err(_) if skipped.get() => Err(Fail::NoLongerPending(id.to_owned())),
        Err(e) => Err(e),
    }
}

/// `redrivePendingRepayments`: each pending repayment re-posted on its original key and terms, under the money lock.
/// A definite refusal is recorded and the next goes on; an unknown outcome stops, so the caller acts on nothing.
pub fn redrive_pending_repayments(d: &Deps<'_>, l: &Loan) -> Result<(), Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {REPAYMENT_COLS} FROM bank.loan_repayments
                  WHERE loan_id = $1::text::uuid AND status = 'pending' ORDER BY sequence ASC"
            ),
            &[&l.id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(repayment_of)
        .collect::<Result<Vec<_>, _>>()
    })?;
    for row in rows {
        let r = with_money_lock(d, &l.id, || {
            Ok(redrive(d, "loan_repayments", &row.id, || {
                post(
                    d,
                    "loanRepay",
                    &repay_input(l, row.principal, row.interest, row.sequence),
                    &repay_key(&l.id, row.sequence),
                    true,
                )
            }))
        })?;
        match r {
            Ok(()) => {}
            Err(e @ Fail::NoLongerPending(_)) => drop(e),
            Err(e) if e.definite() => {}
            Err(e) => return Err(e.refusal()),
        }
    }
    Ok(())
}

/// `redrivePendingReleases`: each pending release re-posted on its original key; only once the debt is clear.
fn redrive_pending_releases(d: &Deps<'_>, l: &Loan) -> Result<(), Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {EVENT_COLS} FROM bank.loan_collateral_events
                  WHERE loan_id = $1::text::uuid AND direction = 'release' AND status = 'pending' ORDER BY sequence ASC"
            ),
            &[&l.id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(event_of)
        .collect::<Result<Vec<_>, _>>()
    })?;
    for row in rows {
        let amount = amount_text(&row.amount)?;
        match redrive(d, "loan_collateral_events", &row.id, || {
            post(
                d,
                "loanCollateralRelease",
                &collateral_input(l, amount, row.sequence),
                &release_key(&l.id, row.sequence),
                true,
            )
        }) {
            Ok(()) | Err(Fail::NoLongerPending(_)) => {}
            Err(e) if e.definite() => {}
            Err(e) => return Err(e.refusal()),
        }
    }
    Ok(())
}

/// `recoverRepayments`: loans with a pending repayment or release, re-driven on their original keys; a cleared debt
/// with a settled repayment closes. A loan that still owes keeps its pending releases untouched.
pub fn recover_repayments(d: &Deps<'_>, limit: Option<f64>) -> Result<Vec<Resumed>, Refusal> {
    let batch = resume_limit(limit)?;
    let loans = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.loans l
                  WHERE l.status IN ('active', 'margin_call')
                    AND (EXISTS (SELECT 1 FROM bank.loan_repayments r WHERE r.loan_id = l.id AND r.status = 'pending')
                      OR EXISTS (SELECT 1 FROM bank.loan_collateral_events e
                                  WHERE e.loan_id = l.id AND e.direction = 'release' AND e.status = 'pending'))
                  ORDER BY l.opened_at ASC LIMIT $1",
                loan_cols("l.")
            ),
            &[&batch],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Loan::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let mut out = Vec::new();
    for l in loans {
        let one = (|| {
            redrive_pending_repayments(d, &l)?;
            let debt = with(d.store, |c| outstanding(c, &l.id))?;
            if debt.total <= 0 && with(d.store, |c| has_settled_repayment(c, &l.id))? {
                close_repaid(d, &l, d.now)?;
                return Ok("completed");
            }
            Ok("open")
        })();
        out.push(match one {
            Ok(outcome) => Resumed {
                loan_id: l.id.clone(),
                outcome,
                reason: None,
            },
            Err(e) => Resumed {
                loan_id: l.id.clone(),
                outcome: "failed",
                reason: Some(message_of(&e)),
            },
        });
    }
    Ok(out)
}

// ── The reserve ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// `fundReserve`: claim a funding row, post `loanReserveFund` from the bank's fees, settle. The same funding id
/// re-posts idempotently and answers the original tx.
pub fn fund_reserve(
    d: &Deps<'_>,
    debt_asset_id: &str,
    funding_id: &str,
    amount: Amount,
    from: Option<&LedgerAccount>,
) -> Result<String, Refusal> {
    if amount <= 0 {
        return Err(refuse(
            "bank.below_minimum",
            "Reserve funding amount must be positive",
        ));
    }
    let settled = with(d.store, |c| {
        let claimed = c
            .query(
                "INSERT INTO bank.loan_reserve_fundings (funding_id, debt_asset_id, amount, status)
                 VALUES ($1, $2, $3::text::numeric, 'pending')
                 ON CONFLICT (funding_id) DO NOTHING
                 RETURNING funding_id",
                &[&funding_id, &debt_asset_id, &format_amount(amount)],
            )
            .map_err(|e| pg(&e))?;
        if !claimed.is_empty() {
            return Ok(None);
        }
        let rows = c
            .query(
                "SELECT status::text, ledger_tx_id, amount::text, debt_asset_id
                   FROM bank.loan_reserve_fundings WHERE funding_id = $1",
                &[&funding_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(r) = rows.first() else {
            return Err(refuse(
                "bank.loan_not_found",
                format!("Funding {funding_id} disappeared after a conflict"),
            ));
        };
        let status: String = r.try_get(0).map_err(|e| pg(&e))?;
        let tx: Option<String> = r.try_get(1).map_err(|e| pg(&e))?;
        let stored = amount_text(&r.try_get::<_, String>(2).map_err(|e| pg(&e))?)?;
        let asset: String = r.try_get(3).map_err(|e| pg(&e))?;
        if asset != debt_asset_id || stored != amount {
            return Err(refuse(
                "bank.loan_principal_mismatch",
                format!("Funding {funding_id} already exists on different terms"),
            ));
        }
        Ok(if status == "settled" { tx } else { None })
    })?;
    if let Some(tx) = settled {
        return Ok(tx);
    }
    let mut input = vec![
        ("fundingId".to_owned(), Json::str(funding_id)),
        ("debtAssetId".to_owned(), Json::str(debt_asset_id)),
        ("amount".to_owned(), Json::str(format_amount(amount))),
    ];
    if let Some(f) = from {
        input.push(("from".to_owned(), f.json()));
    }
    // Only a customer's own account as the source is a custodial move.
    let customer = from.is_some_and(|f| f.owner_type == "user");
    let posted = post(
        d,
        "loanReserveFund",
        &Json::Object(input),
        &format!("bank.loan.reserve.fund:{debt_asset_id}:{funding_id}"),
        customer,
    )
    .map_err(PostErr::refusal)?;
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.loan_reserve_fundings SET status = 'settled', ledger_tx_id = $1, settled_at = now()
              WHERE funding_id = $2 AND status = 'pending'",
            &[&posted.id, &funding_id],
        )
        .map(|_| ())
        .map_err(|e| pg(&e))
    })?;
    Ok(posted.id)
}

/// `reconcileReserve`'s figures.
pub struct Reconciled {
    pub reserve_balance: Amount,
    pub outstanding_principal: Amount,
    pub bad_debt: Amount,
    pub funded: Amount,
    pub drift: Amount,
    pub independent: bool,
}

/// `reconcileReserve`: `funded − badDebt ≈ reserve + outstanding principal`, `funded` from the funding rows (not a
/// tautology with the reserve), the residual as `drift`. Only drawn loans count.
pub fn reconcile_reserve(d: &Deps<'_>, debt_asset_id: &str) -> Result<Reconciled, Refusal> {
    let reserve = d
        .ledger
        .balance(&reserve_account(debt_asset_id))
        .map_err(Refusal::Other)?;
    let figures = with(d.store, |c| {
        let r = c
            .query_one(
                "WITH open_loans AS (
                   SELECT id, principal FROM bank.loans WHERE debt_asset_id = $1 AND drawn_at IS NOT NULL
                 )
                 SELECT
                   COALESCE((SELECT SUM(principal) FROM open_loans), 0)::text,
                   COALESCE((SELECT SUM(r.principal_amount) FROM bank.loan_repayments r
                              JOIN open_loans l ON l.id = r.loan_id WHERE r.status = 'settled'), 0)::text,
                   COALESCE((SELECT SUM(q.principal_repaid) FROM bank.loan_liquidations q
                              JOIN open_loans l ON l.id = q.loan_id WHERE q.status = 'settled'), 0)::text,
                   COALESCE((SELECT SUM(q.shortfall) FROM bank.loan_liquidations q
                              JOIN open_loans l ON l.id = q.loan_id
                             WHERE q.status = 'settled' AND q.bad_debt_ledger_tx_id IS NOT NULL), 0)::text,
                   COALESCE((SELECT SUM(amount) FROM bank.loan_reserve_fundings
                             WHERE debt_asset_id = $1 AND status = 'settled'), 0)::text",
                &[&debt_asset_id],
            )
            .map_err(|e| pg(&e))?;
        (0..5)
            .map(|i| amount_text(&r.try_get::<_, String>(i).map_err(|e| pg(&e))?))
            .collect::<Result<Vec<_>, _>>()
    })?;
    let [drawn, repaid, recovered, bad_debt, funded] = figures[..] else {
        return Err(Refusal::Other(
            "the reserve read answered no figures".to_owned(),
        ));
    };
    let outstanding_principal = (drawn - repaid - recovered - bad_debt).max(0);
    Ok(Reconciled {
        reserve_balance: reserve,
        outstanding_principal,
        bad_debt,
        funded,
        drift: funded - bad_debt - reserve - outstanding_principal,
        independent: true,
    })
}

/// `insuranceCapacity`: the insurance fund's balance in the debt asset.
pub fn insurance_capacity(d: &Deps<'_>, debt_asset_id: &str) -> Result<Amount, Refusal> {
    d.ledger
        .balance(&insurance_fund(debt_asset_id))
        .map_err(Refusal::Other)
}

/// `loansOf`: the borrower's loans, newest first.
pub fn loans_of(d: &Deps<'_>, user_id: &str, limit: Option<f64>) -> Result<Vec<Loan>, Refusal> {
    let page =
        crate::spaces::space::owner_list_limit(limit, "bank.loans_list_limit_unset", "loans.list")?;
    with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.loans WHERE user_id = $1 ORDER BY opened_at DESC LIMIT $2",
                loan_cols("")
            ),
            &[&user_id, &page],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Loan::from_row)
        .collect()
    })
}
