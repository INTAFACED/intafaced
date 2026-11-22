//! The slice's records (`LoanProductRecord`, `LoanRecord`, `LoanDebt`), read from their rows as `toProduct` and
//! `toLoan` read them, and the products: create, the operator's create-once, the list, one product, its rate change.

use postgres::{GenericClient, Row};
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::Instant;

use super::risk::{LiquidationPolicy, assert_policy_coherent};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::pg;

/// A timestamp column as epoch milliseconds, as `Date` reads it.
pub fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn get<'a, T: postgres::types::FromSql<'a>>(r: &'a Row, i: usize) -> Result<T, Refusal> {
    r.try_get(i).map_err(|e| pg(&e))
}

fn amount_at(r: &Row, i: usize) -> Result<Amount, Refusal> {
    parse_amount(&get::<String>(r, i)?).map_err(Refusal::Other)
}

fn opt_amount_at(r: &Row, i: usize) -> Result<Option<Amount>, Refusal> {
    get::<Option<String>>(r, i)?
        .map(|s| parse_amount(&s).map_err(Refusal::Other))
        .transpose()
}

fn opt_time_at(r: &Row, i: usize) -> Result<Option<Instant>, Refusal> {
    Ok(get::<Option<i64>>(r, i)?.map(Instant))
}

/// One product (`LoanProductRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub debt_asset_id: String,
    pub collateral_asset_id: String,
    pub quote_asset_id: String,
    pub apr_bps: i64,
    pub max_ltv_bps: i64,
    pub min_principal: Amount,
    pub policy: LiquidationPolicy,
    pub status: String,
}

/// The columns every product read selects, in [`Product::from_row`]'s order.
pub const PRODUCT_COLS: &str = "id::text, name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps::int8, \
     max_ltv_bps::int8, margin_call_ltv_bps::int8, liquidation_ltv_bps::int8, insolvency_ltv_bps::int8, \
     target_ltv_bps::int8, penalty_bps::int8, max_tranche_bps::int8, grace_seconds::int8, min_principal::text, \
     status::text";

/// `bank.loan_params_invalid`, with why.
pub fn params_invalid(why: &str) -> Refusal {
    refuse(
        "bank.loan_params_invalid",
        format!("Loan product terms are invalid: {why}"),
    )
}

impl Product {
    /// `toProduct`: a blank floor is the typed refusal, never 0.
    pub fn from_row(r: &Row) -> Result<Product, Refusal> {
        let floor: Option<String> = get(r, 14)?;
        let Some(floor) = floor.filter(|f| !js_trim(f).is_empty()) else {
            return Err(params_invalid("minPrincipal is blank"));
        };
        Ok(Product {
            id: get(r, 0)?,
            name: get(r, 1)?,
            debt_asset_id: get(r, 2)?,
            collateral_asset_id: get(r, 3)?,
            quote_asset_id: get(r, 4)?,
            apr_bps: get(r, 5)?,
            max_ltv_bps: get(r, 6)?,
            min_principal: parse_amount(&floor).map_err(Refusal::Other)?,
            policy: LiquidationPolicy {
                margin_call_ltv_bps: get(r, 7)?,
                liquidation_ltv_bps: get(r, 8)?,
                insolvency_ltv_bps: get(r, 9)?,
                target_ltv_bps: get(r, 10)?,
                penalty_bps: get(r, 11)?,
                max_tranche_bps: get(r, 12)?,
                grace_seconds: get(r, 13)?,
            },
            status: get(r, 15)?,
        })
    }
}

/// One loan (`LoanRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loan {
    pub id: String,
    pub product_id: String,
    pub user_id: String,
    pub debt_asset_id: String,
    pub collateral_asset_id: String,
    pub quote_asset_id: String,
    pub apr_bps: i64,
    pub principal: Amount,
    /// Collateral pledged at open, snapshotted once: a term, not a live balance. None only on rows from before it.
    pub opening_collateral: Option<Amount>,
    /// `pending`, `active`, `margin_call`, `liquidating`, `repaid` or `liquidated`.
    pub status: String,
    pub draw_ledger_tx_id: Option<String>,
    pub opened_at: Instant,
    pub margin_called_at: Option<Instant>,
    pub last_mark_price: Option<Amount>,
    pub closed_at: Option<Instant>,
}

/// The columns every loan read selects, in [`Loan::from_row`]'s order; `l.` names the table.
pub fn loan_cols(l: &str) -> String {
    format!(
        "{l}id::text, {l}product_id::text, {l}user_id::text, {l}debt_asset_id, {l}collateral_asset_id, \
         {l}quote_asset_id, {l}apr_bps::int8, {l}principal::text, {l}opening_collateral::text, {l}status::text, \
         {l}draw_ledger_tx_id, {}, {}, {l}last_mark_price::text, {}",
        ms(&format!("{l}opened_at")),
        ms(&format!("{l}margin_called_at")),
        ms(&format!("{l}closed_at")),
    )
}

/// How many columns [`loan_cols`] selects.
pub const LOAN_COL_COUNT: usize = 15;

impl Loan {
    /// `toLoan`.
    pub fn from_row(r: &Row) -> Result<Loan, Refusal> {
        Ok(Loan {
            id: get(r, 0)?,
            product_id: get(r, 1)?,
            user_id: get(r, 2)?,
            debt_asset_id: get(r, 3)?,
            collateral_asset_id: get(r, 4)?,
            quote_asset_id: get(r, 5)?,
            apr_bps: get(r, 6)?,
            principal: amount_at(r, 7)?,
            opening_collateral: opt_amount_at(r, 8)?,
            status: get(r, 9)?,
            draw_ledger_tx_id: get(r, 10)?,
            opened_at: Instant(get(r, 11)?),
            margin_called_at: opt_time_at(r, 12)?,
            last_mark_price: opt_amount_at(r, 13)?,
            closed_at: opt_time_at(r, 14)?,
        })
    }

    /// Repaid or liquidated: nothing more is owed or held.
    pub fn closed(&self) -> bool {
        self.status == "repaid" || self.status == "liquidated"
    }
}

/// What a loan owes now (`LoanDebt`): derived from write-once rows every time, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Debt {
    /// Principal drawn, less principal repaid or recovered.
    pub principal: Amount,
    /// Interest capitalised, less interest paid or recovered.
    pub interest: Amount,
    /// `principal + interest`: the number every LTV is computed from.
    pub total: Amount,
}

/// `bank.loan_not_found`.
pub fn loan_not_found(id: &str) -> Refusal {
    refuse("bank.loan_not_found", format!("No loan {id}"))
}

/// `loan`: one loan, or `bank.loan_not_found`.
pub fn loan(c: &mut impl GenericClient, id: &str) -> Result<Loan, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.loans WHERE id = $1::text::uuid",
                loan_cols("")
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(Loan::from_row)
        .unwrap_or_else(|| Err(loan_not_found(id)))
}

/// `product`: one product, or `bank.loan_product_not_found`.
pub fn product(c: &mut impl GenericClient, id: &str) -> Result<Product, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {PRODUCT_COLS} FROM bank.loan_products WHERE id = $1::text::uuid"),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Product::from_row).unwrap_or_else(|| {
        Err(refuse(
            "bank.loan_product_not_found",
            format!("No loan product {id}"),
        ))
    })
}

/// `outstanding`: one aggregate over the write-once tables, interest and principal kept apart, each clamped at zero.
/// An insured shortfall counts only once its bad-debt post is recorded (B-01).
pub fn outstanding(c: &mut impl GenericClient, loan_id: &str) -> Result<Debt, Refusal> {
    let rows = c
        .query(
            "WITH drawn AS (
               SELECT principal FROM bank.loans WHERE id = $1::text::uuid
             ),
             accrued AS (
               SELECT COALESCE(SUM(interest_amount), 0) AS v
                 FROM bank.loan_interest_accruals WHERE loan_id = $1::text::uuid
             ),
             adjusted AS (
               SELECT COALESCE(SUM(amount), 0) AS v
                 FROM bank.loan_adjustments WHERE loan_id = $1::text::uuid AND kind = 'interest_correction'
             ),
             repaid AS (
               SELECT COALESCE(SUM(principal_amount), 0) AS p, COALESCE(SUM(interest_amount), 0) AS i
                 FROM bank.loan_repayments WHERE loan_id = $1::text::uuid AND status = 'settled'
             ),
             seized AS (
               SELECT COALESCE(SUM(principal_repaid), 0) AS p, COALESCE(SUM(interest_repaid), 0) AS i,
                      COALESCE(SUM(
                        CASE
                          WHEN shortfall > 0 AND bad_debt_ledger_tx_id IS NOT NULL THEN shortfall
                          ELSE 0
                        END
                      ), 0) AS s
                 FROM bank.loan_liquidations WHERE loan_id = $1::text::uuid AND status = 'settled'
             )
             SELECT
               GREATEST((SELECT principal FROM drawn) - repaid.p - seized.p - seized.s, 0)::text AS principal,
               GREATEST(accrued.v + adjusted.v - repaid.i - seized.i, 0)::text AS interest
               FROM accrued, adjusted, repaid, seized",
            &[&loan_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(loan_not_found(loan_id));
    };
    // No loan row makes `principal` NULL: GREATEST ignores the null and answers 0, as the TypeScript reads it.
    let principal = parse_amount(&get::<Option<String>>(r, 0)?.unwrap_or_else(|| "0".to_owned()))
        .map_err(Refusal::Other)?;
    let interest = amount_at(r, 1)?;
    Ok(Debt {
        principal,
        interest,
        total: principal + interest,
    })
}

/// What a new product is made with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProduct {
    pub name: String,
    pub debt_asset_id: String,
    pub collateral_asset_id: String,
    pub quote_asset_id: String,
    pub apr_bps: i64,
    pub max_ltv_bps: i64,
    /// `None` is a blank floor, refused; `Some(0)` is a real floor.
    pub min_principal: Option<Amount>,
    pub policy: LiquidationPolicy,
}

const PRODUCT_INSERT_COLS: &str = "name, debt_asset_id, collateral_asset_id, quote_asset_id, apr_bps, max_ltv_bps, \
     margin_call_ltv_bps, liquidation_ltv_bps, insolvency_ltv_bps, target_ltv_bps, penalty_bps, max_tranche_bps, \
     grace_seconds, min_principal";

fn product_params(p: &NewProduct) -> [i32; 9] {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the columns are int4; the database refuses what does not fit"
    )]
    [
        p.apr_bps as i32,
        p.max_ltv_bps as i32,
        p.policy.margin_call_ltv_bps as i32,
        p.policy.liquidation_ltv_bps as i32,
        p.policy.insolvency_ltv_bps as i32,
        p.policy.target_ltv_bps as i32,
        p.policy.penalty_bps as i32,
        p.policy.max_tranche_bps as i32,
        p.policy.grace_seconds as i32,
    ]
}

/// `createProduct`: the policy's order checked here as well as by the table, so the operator reads which threshold is
/// wrong rather than a constraint name.
pub fn create_product(c: &mut impl GenericClient, p: &NewProduct) -> Result<Product, Refusal> {
    assert_policy_coherent(&p.policy, p.max_ltv_bps)
        .map_err(|e| refuse("bank.policy_incoherent", e.message))?;
    if p.debt_asset_id == p.collateral_asset_id {
        return Err(refuse(
            "bank.policy_incoherent",
            format!(
                "A collateralised loan borrows one asset against another; both are {}",
                p.debt_asset_id
            ),
        ));
    }
    let Some(floor) = p.min_principal else {
        return Err(params_invalid("minPrincipal is blank"));
    };
    let n = product_params(p);
    let rows = c
        .query(
            &format!(
                "INSERT INTO bank.loan_products ({PRODUCT_INSERT_COLS}) VALUES \
                 ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text::numeric) RETURNING {PRODUCT_COLS}"
            ),
            &[
                &p.name,
                &p.debt_asset_id,
                &p.collateral_asset_id,
                &p.quote_asset_id,
                &n[0],
                &n[1],
                &n[2],
                &n[3],
                &n[4],
                &n[5],
                &n[6],
                &n[7],
                &n[8],
                &format_amount(floor),
            ],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(Product::from_row)
        .unwrap_or_else(|| Err(Refusal::Other("insert returned no product".to_owned())))
}

/// `assertLoanParams`: every term checked before a product row is written; the operator gets a 400, not a constraint.
pub fn assert_loan_params(p: &NewProduct) -> Result<(), Refusal> {
    if js_trim(&p.name).is_empty() {
        return Err(params_invalid("name is blank"));
    }
    if p.debt_asset_id == p.collateral_asset_id {
        return Err(params_invalid("debt and collateral are the same asset"));
    }
    if p.apr_bps < 0 || p.apr_bps > 10_000 {
        return Err(params_invalid("aprBps must be within 0..10000"));
    }
    if p.max_ltv_bps <= 0 {
        return Err(params_invalid("maxLtvBps must be positive"));
    }
    if p.policy.target_ltv_bps <= 0 {
        return Err(params_invalid("targetLtvBps must be positive"));
    }
    if p.policy.penalty_bps < 0 || p.policy.penalty_bps >= 10_000 {
        return Err(params_invalid("penaltyBps must be within 0..9999"));
    }
    if p.policy.insolvency_ltv_bps > 10_000 {
        return Err(params_invalid("insolvencyLtvBps cannot exceed 10000"));
    }
    let Some(floor) = p.min_principal else {
        return Err(params_invalid("minPrincipal is blank"));
    };
    if floor < 0 {
        return Err(params_invalid("minPrincipal cannot be negative"));
    }
    assert_policy_coherent(&p.policy, p.max_ltv_bps).map_err(|e| params_invalid(&e.message))
}

/// `createProductOnce` (BK-loan-02): the caller names the id, so a replay with the same terms returns the stored row
/// and the same id with any other term refuses `bank.loan_product_conflict`.
pub fn create_product_once(
    c: &mut impl GenericClient,
    product_id: &str,
    p: &NewProduct,
) -> Result<(Product, bool), Refusal> {
    assert_loan_params(p)?;
    let floor = p.min_principal.unwrap_or_default();
    let n = product_params(p);
    let rows = c
        .query(
            &format!(
                "INSERT INTO bank.loan_products (id, {PRODUCT_INSERT_COLS}) VALUES \
                 ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::text::numeric) \
                 ON CONFLICT (id) DO NOTHING RETURNING {PRODUCT_COLS}"
            ),
            &[
                &product_id,
                &p.name,
                &p.debt_asset_id,
                &p.collateral_asset_id,
                &p.quote_asset_id,
                &n[0],
                &n[1],
                &n[2],
                &n[3],
                &n[4],
                &n[5],
                &n[6],
                &n[7],
                &n[8],
                &format_amount(floor),
            ],
        )
        .map_err(|e| pg(&e))?;
    if let Some(r) = rows.first() {
        return Ok((Product::from_row(r)?, false));
    }
    let stored = product(c, product_id)?;
    let same = stored.name == p.name
        && stored.debt_asset_id == p.debt_asset_id
        && stored.collateral_asset_id == p.collateral_asset_id
        && stored.quote_asset_id == p.quote_asset_id
        && stored.apr_bps == p.apr_bps
        && stored.max_ltv_bps == p.max_ltv_bps
        && stored.min_principal == floor
        && stored.policy == p.policy;
    if !same {
        return Err(refuse(
            "bank.loan_product_conflict",
            format!(
                "Loan product {product_id} already exists with different terms; use a new product id"
            ),
        ));
    }
    Ok((stored, true))
}

/// `listProducts`: open products, by name, optionally those that borrow or pledge `asset_id`.
pub fn list_products(
    c: &mut impl GenericClient,
    asset_id: Option<&str>,
    limit: Option<f64>,
) -> Result<Vec<Product>, Refusal> {
    let page = crate::spaces::space::owner_list_limit(
        limit,
        "bank.loan_products_list_limit_unset",
        "loans.products",
    )?;
    let rows = match asset_id.filter(|a| !a.is_empty()) {
        Some(a) => c.query(
            &format!(
                "SELECT {PRODUCT_COLS} FROM bank.loan_products \
                  WHERE status = 'open' AND (debt_asset_id = $1 OR collateral_asset_id = $1) \
                  ORDER BY name ASC LIMIT $2"
            ),
            &[&a, &page],
        ),
        None => c.query(
            &format!(
                "SELECT {PRODUCT_COLS} FROM bank.loan_products WHERE status = 'open' ORDER BY name ASC LIMIT $1"
            ),
            &[&page],
        ),
    }
    .map_err(|e| pg(&e))?;
    rows.iter().map(Product::from_row).collect()
}

/// A rate change an operator asks for (BK-loan-02).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateChange {
    pub product_id: String,
    pub from_apr_bps: i64,
    pub apr_bps: i64,
    pub reason: String,
}

/// `checkRateChange`: the new rate in range, a reason of 3 to 300 characters, a real change, and the product still
/// charging the rate the change replaces, before the second person's approval is spent.
pub fn check_rate_change(c: &mut impl GenericClient, ch: &RateChange) -> Result<(), Refusal> {
    check_rate_terms(ch)?;
    let p = product(c, &ch.product_id)?;
    if p.apr_bps != ch.from_apr_bps {
        return Err(refuse(
            "bank.loan_rate_moved",
            format!(
                "The product charges {} bps, not the {} bps this change replaces: read it again",
                p.apr_bps, ch.from_apr_bps
            ),
        ));
    }
    Ok(())
}

/// The checks of [`check_rate_change`] that read nothing, run before the database is asked.
pub fn check_rate_terms(ch: &RateChange) -> Result<(), Refusal> {
    if ch.apr_bps < 0 || ch.apr_bps > 10_000 {
        return Err(params_invalid("aprBps must be within 0..10000"));
    }
    let reason = js_trim(&ch.reason);
    let n = reason.encode_utf16().count();
    if !(3..=300).contains(&n) {
        return Err(refuse(
            "bank.loan_params_invalid",
            "A rate change needs a reason of 3 to 300 characters",
        ));
    }
    if ch.apr_bps == ch.from_apr_bps {
        return Err(refuse(
            "bank.loan_params_invalid",
            format!("The change keeps the rate at {} bps", ch.apr_bps),
        ));
    }
    Ok(())
}

/// A rate change one approval made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateChanged {
    pub product_id: String,
    pub apr_bps: i64,
    pub previous_apr_bps: i64,
    pub approved_by: String,
}

/// `rateChangeByApproval`: the change one approval already made, read back for a retry; another change under it
/// refuses `bank.loan_rate_approval_reused`.
pub fn rate_change_by_approval(
    c: &mut impl GenericClient,
    approval_id: &str,
    ch: &RateChange,
) -> Result<Option<RateChanged>, Refusal> {
    let rows = c
        .query(
            "SELECT product_id::text, apr_bps::int8, previous_apr_bps::int8, reason, approved_by \
               FROM bank.loan_product_rate_changes WHERE approval_id = $1",
            &[&approval_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let product_id: String = get(r, 0)?;
    let apr: i64 = get(r, 1)?;
    let previous: i64 = get(r, 2)?;
    let reason: String = get(r, 3)?;
    if product_id != ch.product_id
        || apr != ch.apr_bps
        || previous != ch.from_apr_bps
        || reason != js_trim(&ch.reason)
    {
        return Err(refuse(
            "bank.loan_rate_approval_reused",
            format!("Approval {approval_id} already made another rate change"),
        ));
    }
    Ok(Some(RateChanged {
        product_id,
        apr_bps: apr,
        previous_apr_bps: previous,
        approved_by: get(r, 4)?,
    }))
}

/// `setProductRate`: the rate it replaces checked under the row's lock in the statement that changes it and records
/// the change, so two changes never both replace one rate and none goes unrecorded.
pub fn set_product_rate(
    c: &mut impl GenericClient,
    ch: &RateChange,
    approval_id: &str,
    approved_by: &str,
) -> Result<(Product, i64), Refusal> {
    check_rate_change(c, ch)?;
    if js_trim(approval_id).is_empty() {
        return Err(refuse(
            "bank.loan_params_invalid",
            "A rate change needs its approval id",
        ));
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "checked within 0..10000 above"
    )]
    let (to, from) = (ch.apr_bps as i32, ch.from_apr_bps as i32);
    let rows = c
        .query(
            &format!(
                "WITH prev AS (
                   SELECT id, apr_bps FROM bank.loan_products WHERE id = $1::text::uuid FOR UPDATE
                 ), changed AS (
                   UPDATE bank.loan_products p SET apr_bps = $2
                     FROM prev WHERE p.id = prev.id AND prev.apr_bps = $3
                   RETURNING p.*, prev.apr_bps AS previous_apr_bps
                 ), recorded AS (
                   INSERT INTO bank.loan_product_rate_changes (product_id, apr_bps, previous_apr_bps, reason, approval_id, approved_by)
                   SELECT id, apr_bps, previous_apr_bps, $4, $5, $6 FROM changed
                   RETURNING id
                 )
                 SELECT {PRODUCT_COLS}, changed.previous_apr_bps::int8, (SELECT count(*) FROM recorded)::int8 FROM changed"
            ),
            &[
                &ch.product_id,
                &to,
                &from,
                &js_trim(&ch.reason),
                &approval_id,
                &approved_by,
            ],
        )
        .map_err(|e| pg(&e))?;
    let moved = || {
        refuse(
            "bank.loan_rate_moved",
            "The product's rate moved before this change was made: read it again",
        )
    };
    let Some(r) = rows.first() else {
        return Err(moved());
    };
    if get::<i64>(r, 17)? != 1 {
        return Err(moved());
    }
    Ok((Product::from_row(r)?, get(r, 16)?))
}
