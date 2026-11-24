//! The earn slice (`PORT.md`): flexible and fixed pools whose savings sit in each saver's own `stake` ledger account
//! (`earn/earn-service.ts`). A pool is a row and a rate; a saving is a row that says who, which pool and whether it is
//! open, and its money is its stake pot on the ledger, never a column. Interest is paid once a UTC day, simple, to the
//! saver's main balance, out of the pool's reserve that the bank funds: an under-funded pool fails to pay, loudly.
//!
//! - `interest`: the day's arithmetic, rounding down in the reserve's favour.
//! - `rates`: every rate a pool has published (BK-earn-05).
//! - `service`: pools, savings, the deposit's claim, post and activate, the take back and unbonding (BK-earn-04),
//!   auto-renew (BK-earn-03), the daily accrual and its recovery, and the operator's pool totals.
//! - `router`: the calls (`router/earn.router.ts`, the earn calls of `router/ops.router.ts`, `ops/earn-pools.ts`,
//!   `ops/pool-totals.ts`) and the two job doors of `index.ts`.
//!
//! Money moves only through svc-ledger's recipe door (`earnDeposit`, `earnWithdraw`, `earnPoolFund`, `earnInterest`),
//! never by entries assembled here. With the custodial layer off (`LEDGER_CUSTODY_LAYER`, the launch decision), a
//! post that would move a customer balance refuses `bank.no_partner_bank` before svc-ledger is asked, as
//! `custodyGuardedLedger` does.

pub mod interest;
pub mod rates;
pub mod router;
pub mod service;

use postgres::Row;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{Ledger, PostFailure};
use crate::spaces::space::pg;
use crate::transfers::Approvals;
use crate::transfers::ports::RecipientState;

/// The owner's values the slice reads, as `index.ts` hands them in.
#[derive(Debug, Clone)]
pub struct Settings {
    /// `TOKEN_ASSET_ID`: the asset svc-token stakes, refused here.
    pub native_asset_id: String,
    /// `BANK_EARN_RISK_WORDING_JSON`, raw; blank is `None`.
    pub risk_wording: Option<String>,
    /// `INTEREST_ACCRUAL_ENABLED`: on unless the owner turns it off (`env.ts`'s default).
    pub interest_accrual: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            native_asset_id: "IFC".to_owned(),
            risk_wording: None,
            interest_accrual: true,
        }
    }
}

/// What every part of the slice is handed for one call or one pass.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub ledger: &'a dyn Ledger,
    /// `LEDGER_CUSTODY_LAYER`: `on`, or anything else for off.
    pub custody_layer: &'a str,
    /// svc-identity's account state, asked before auto-renew relocks a saving.
    pub recipients: &'a dyn RecipientState,
    /// svc-identity's consume of an operator's approval.
    pub approvals: &'a dyn Approvals,
    pub settings: &'a Settings,
    pub now: Instant,
}

/// `custodyGuardedLedger`: with the custodial layer off no customer balance is posted from here.
pub fn custody_guard(d: &Deps<'_>) -> Result<(), Refusal> {
    if d.custody_layer == "on" {
        return Ok(());
    }
    Err(refuse(
        "bank.no_partner_bank",
        "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
    ))
}

/// `isDefiniteLedgerRefusal`: svc-ledger refused by one of the codes it decides before it commits anything.
pub fn definite_refusal(f: &PostFailure) -> bool {
    matches!(
        f.code(),
        Some(
            "ledger.insufficient_funds"
                | "ledger.invalid_entry"
                | "ledger.unbalanced"
                | "ledger.owner_identity_space"
        )
    )
}

/// A timestamp column as epoch milliseconds, as `Date` reads it.
pub fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

/// One pool (`PoolRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pool {
    pub id: String,
    pub asset_id: String,
    /// `flexible` or `fixed`.
    pub kind: String,
    pub name: String,
    pub apr_bps: i64,
    pub term_days: Option<i64>,
    pub min_deposit: Amount,
    /// `open` or `closed`.
    pub status: String,
    pub unbonding_days: Option<i64>,
    pub status_revision: i64,
}

/// The columns every pool read selects, in [`Pool::from_row`]'s order.
pub const POOL_COLS: &str = "id::text, asset_id, kind::text, name, apr_bps::int8, term_days::int8, \
     min_deposit::text, status::text, unbonding_days::int8, status_revision::int8";

fn amount(r: &Row, i: usize) -> Result<Amount, Refusal> {
    parse_amount(&r.try_get::<_, String>(i).map_err(|e| pg(&e))?).map_err(Refusal::Other)
}

impl Pool {
    pub fn from_row(r: &Row) -> Result<Pool, Refusal> {
        Ok(Pool {
            id: r.try_get(0).map_err(|e| pg(&e))?,
            asset_id: r.try_get(1).map_err(|e| pg(&e))?,
            kind: r.try_get(2).map_err(|e| pg(&e))?,
            name: r.try_get(3).map_err(|e| pg(&e))?,
            apr_bps: r.try_get(4).map_err(|e| pg(&e))?,
            term_days: r.try_get(5).map_err(|e| pg(&e))?,
            min_deposit: amount(r, 6)?,
            status: r.try_get(7).map_err(|e| pg(&e))?,
            unbonding_days: r.try_get(8).map_err(|e| pg(&e))?,
            status_revision: r.try_get(9).map_err(|e| pg(&e))?,
        })
    }

    /// `poolView`: what a pool publishes, with the facts of the code (paid daily, simple, from the reserve) and null
    /// for the figures no owner table holds.
    pub fn view(&self) -> Vec<(String, Json)> {
        let f = |k: &str, v: Json| (k.to_owned(), v);
        vec![
            f("id", Json::str(self.id.clone())),
            f("assetId", Json::str(self.asset_id.clone())),
            f("kind", Json::str(self.kind.clone())),
            f("name", Json::str(self.name.clone())),
            f("aprBps", Json::int(self.apr_bps)),
            f("termDays", self.term_days.map_or(Json::Null, Json::int)),
            f("minDeposit", Json::str(format_amount(self.min_deposit))),
            f("payoutEvery", Json::str("day")),
            f("compounding", Json::str("simple")),
            f("rewardAssetId", Json::str(self.asset_id.clone())),
            f("yieldSource", Json::str("pool_reserve")),
            f("rateBands", Json::Null),
            f("commissionBps", Json::Null),
            f("capacity", Json::Null),
            f(
                "unbondingDays",
                self.unbonding_days.map_or(Json::Null, Json::int),
            ),
        ]
    }
}

/// One saving (`PositionRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Position {
    pub id: String,
    pub pool_id: String,
    pub user_id: String,
    pub asset_id: String,
    pub principal: Amount,
    pub opened_at: Instant,
    pub matures_at: Option<Instant>,
    /// `pending` (the claim before activate), `active` or `closed`.
    pub status: String,
    pub auto_renew: bool,
    pub unbonding_started_at: Option<Instant>,
    pub unbonds_at: Option<Instant>,
}

/// The columns every saving read selects, in [`Position::from_row`]'s order.
pub fn position_cols() -> String {
    format!(
        "id::text, pool_id::text, user_id, asset_id, principal::text, {}, {}, status::text, auto_renew, {}, {}",
        ms("opened_at"),
        ms("matures_at"),
        ms("unbonding_started_at"),
        ms("unbonds_at")
    )
}

impl Position {
    pub fn from_row(r: &Row) -> Result<Position, Refusal> {
        let at = |i: usize| -> Result<Option<Instant>, Refusal> {
            Ok(r.try_get::<_, Option<i64>>(i)
                .map_err(|e| pg(&e))?
                .map(Instant))
        };
        Ok(Position {
            id: r.try_get(0).map_err(|e| pg(&e))?,
            pool_id: r.try_get(1).map_err(|e| pg(&e))?,
            user_id: r.try_get(2).map_err(|e| pg(&e))?,
            asset_id: r.try_get(3).map_err(|e| pg(&e))?,
            principal: amount(r, 4)?,
            opened_at: Instant(r.try_get(5).map_err(|e| pg(&e))?),
            matures_at: at(6)?,
            status: r.try_get(7).map_err(|e| pg(&e))?,
            auto_renew: r.try_get(8).map_err(|e| pg(&e))?,
            unbonding_started_at: at(9)?,
            unbonds_at: at(10)?,
        })
    }
}

/// `bank.pool_not_found`.
pub fn pool_not_found(pool_id: &str) -> Refusal {
    refuse("bank.pool_not_found", format!("Pool {pool_id} not found"))
}

/// `bank.position_not_found`.
pub fn position_not_found(position_id: &str) -> Refusal {
    refuse(
        "bank.position_not_found",
        format!("Position {position_id} not found"),
    )
}

/// `bank.position_closed`.
pub fn position_closed() -> Refusal {
    refuse("bank.position_closed", "Position is already closed")
}

/// `bank.earn_rate_unset`.
pub fn rate_unset(asset_id: Option<&str>) -> Refusal {
    refuse(
        "bank.earn_rate_unset",
        asset_id.map_or_else(
            || "No earn rates are configured".to_owned(),
            |a| format!("No earn rate is configured for {a}"),
        ),
    )
}

/// `stakePrincipalForAccrual`: the stake pot is the money; a recorded principal that disagrees refuses
/// `bank.earn_principal_mismatch` rather than invent a day's yield.
pub fn stake_principal(
    position_id: &str,
    recorded: Amount,
    book: Amount,
) -> Result<Amount, Refusal> {
    if book != recorded {
        return Err(refuse(
            "bank.earn_principal_mismatch",
            format!(
                "Earn position {position_id} table principal {} disagrees with ledger stake {} — refusing to invent interest",
                format_amount(recorded),
                format_amount(book)
            ),
        ));
    }
    Ok(book)
}

/// The code a refusal carries, as a job report names it; `None` for one that is no `BankError`.
pub fn code_of(r: &Refusal) -> Option<&'static str> {
    match r {
        Refusal::Bank(e) => Some(e.row.code),
        _ => None,
    }
}

/// What a thrown error's `message` is, as a job report quotes it.
pub fn message_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.message.clone(),
        Refusal::Trpc(t) => t.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_the_slice_refuses_with_is_a_bank_error_code() {
        for code in [
            "bank.pool_not_found",
            "bank.pool_conflict",
            "bank.pool_status_unchanged",
            "bank.pool_status_stale",
            "bank.unbond_not_confirmed",
            "bank.position_unbonding",
            "bank.earn_release_failed",
            "bank.earn_rate_unset",
            "bank.native_asset_not_earnable",
            "bank.position_not_found",
            "bank.position_closed",
            "bank.position_locked",
            "bank.position_conflict",
            "bank.position_id_required",
            "bank.position_pending",
            "bank.auto_renew_fixed_only",
            "bank.position_matured",
            "bank.account_not_active",
            "bank.earn_renew_failed",
            "bank.earn_principal_mismatch",
            "bank.pool_closed",
            "bank.below_minimum",
            "bank.pool_underfunded",
            "bank.pool_terms_invalid",
            "bank.fixed_pool_rate_locked",
            "bank.pool_rate_unchanged",
            "bank.earn_risk_wording_unset",
            "bank.recipient_check_unset",
            "bank.recipient_check_unavailable",
            "bank.asset_paused",
            "bank.asset_pause_unreadable",
            "bank.interest_accrual_disabled",
            "bank.accrual_day_not_begun",
            "bank.earn_pools_list_limit_unset",
            "bank.earn_positions_list_limit_unset",
            "bank.earn_interest_list_limit_unset",
            "bank.earn_rate_history_limit_unset",
            "bank.earn_resume_pending_limit_unset",
            "bank.earn_renew_batch_limit_unset",
            "bank.earn_release_batch_limit_unset",
            "bank.validation_failed",
            "bank.no_partner_bank",
        ] {
            assert!(
                matches!(refuse(code, "m"), Refusal::Bank(_)),
                "{code} is no BankError code"
            );
        }
    }

    #[test]
    fn only_the_refusals_made_before_a_commit_prove_nothing_was_booked() {
        let coded = |code: &str, attempts| PostFailure::Coded {
            code: code.to_owned(),
            message: "m".to_owned(),
            attempts,
        };
        assert!(definite_refusal(&coded("ledger.insufficient_funds", 2)));
        assert!(definite_refusal(&coded("ledger.invalid_entry", 1)));
        // The freeze and a reused key prove nothing: the claim stays for its recovery.
        assert!(!definite_refusal(&coded("ledger.frozen", 1)));
        assert!(!definite_refusal(&coded("ledger.idempotency_conflict", 1)));
        assert!(!definite_refusal(&PostFailure::Unknown(
            "timeout".to_owned()
        )));
    }
}
