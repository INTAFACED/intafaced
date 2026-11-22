//! Slice `loans` against Postgres: the risk sweep, margin calls, liquidation and bad debt, and the reserve's
//! reconciliation (`services/svc-bank/src/loans/loans.test.ts`, "svc-bank loans PG-hard › LoanService" from "the risk
//! sweep" to the end of the file), each test named after the TypeScript test's words. A call on `LoanService` is the
//! Rust function it became, given the dependencies `loans_kit` builds.
//!
//! Where the TypeScript replaces one of `LoanService`'s own methods or `sql.unsafe` to hold a sweep at a point, this
//! suite holds it at the same point through the ledger the sweep is handed: `collateralOf` is the ledger read of the
//! loan's collateral account, and a sale is the ledger post of `loanLiquidate`. Nothing here skips.
//!
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Barrier, Condvar, Mutex};
use std::time::Duration;

use crate::loans_kit::{self, BORROWER, Book, DAY, HOUR, Kit, OTHER, amt, fmt, plus, policy, uuid};

use postgres::{Client, NoTls};
use service_kit::json::Json;
use service_kit::money::Amount;
use service_kit::time::Instant;
use svc_bank::db::{self, Store};
use svc_bank::loans::ports::{Deps, SaleAsk, Venue, VenueQuote, market_maker};
use svc_bank::loans::prices::MarkQuality;
use svc_bank::loans::service::{self, collateral_account, insurance_fund, reserve_account};
use svc_bank::loans::sweep::{self, Swept};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerBalance, LedgerTx, PostFailure};

const MINUTE: i64 = 60_000;

fn kit() -> Option<Kit> {
    Kit::new()
}

/// `openAt(collateralPrice)`: a funded reserve, 1 BTC on the borrower, a funded market maker, a 5000 USDT loan opened
/// at 10000, then the mark moved to `price`.
fn open_at(k: &Kit, price: &str) -> service::Opened {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.ledger.seed_market_maker("USDT", "100000");
    let p = k.product();
    let o = k.open(&p.id, "1", "5000").unwrap();
    k.prices.btc(price);
    o
}

fn sweep_at(k: &Kit, t: Instant) -> Swept {
    k.sweep_at(t).unwrap()
}

fn liquidations(k: &Kit, loan_id: &str) -> i64 {
    k.count(&format!(
        "SELECT COUNT(*)::int8 FROM bank.loan_liquidations WHERE loan_id = '{loan_id}'"
    ))
}

/// `saleCount()`: the `loan.liquidated` posts booked.
fn sale_count(k: &Kit) -> usize {
    k.ledger.posts("loanLiquidate").len()
}

fn collateral(k: &Kit, loan_id: &str) -> Amount {
    let l = k.loan(loan_id);
    k.d(|d| service::collateral_of(d, &l)).unwrap()
}

/// The slice's dependencies with this test's own store, ledger and venue in place of the kit's.
fn with_parts<T>(
    k: &Kit,
    store: &Store,
    ledger: &dyn Ledger,
    venue: &dyn Venue,
    now: Instant,
    f: impl FnOnce(&Deps<'_>) -> T,
) -> T {
    f(&Deps {
        store,
        ledger,
        custody_layer: &k.custody,
        approvals: &k.desk,
        prices: &k.prices,
        venue,
        margin_calls: &k.calls,
        affiliates: &k.told,
        settings: &k.settings,
        now,
    })
}

/// `sweepAt(at)` with this test's own store, ledger and venue.
fn sweep_with(k: &Kit, store: &Store, ledger: &dyn Ledger, venue: &dyn Venue, t: Instant) -> Swept {
    k.prices.stamp(t);
    with_parts(k, store, ledger, venue, t, |d| {
        sweep::run_risk_sweep(d, t, Some(500.0))
    })
    .unwrap()
}

/// A venue that answers `proceeds` from the market maker, whatever it is asked (`laterQuote`).
struct Quote(&'static str);

impl Venue for Quote {
    fn quote(&self, _ask: &SaleAsk<'_>) -> Result<Option<VenueQuote>, String> {
        Ok(Some(VenueQuote {
            proceeds: amt(self.0),
            collateral_to: market_maker("BTC"),
            proceeds_from: market_maker("USDT"),
        }))
    }
}

/// The stored-sale suites' opening: a funded reserve, market maker and insurance fund, a full-tranche product, and a
/// 1 BTC / 5000 USDT loan.
fn stored_sale_loan(k: &Kit) -> String {
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.ledger.seed_market_maker("USDT", "100000");
    k.ledger.seed_insurance("USDT", "10000");
    let p = k.product_with(|p| p.policy = policy(|q| q.max_tranche_bps = 10_000));
    k.open(&p.id, "1", "5000").unwrap().loan.id
}

/// `ledger.post(recipes.loanLiquidate({ tranche: 0, collateralSold: sold, proceeds: 1000, principalRepaid: 1000 }))`.
fn post_sale(k: &Kit, loan_id: &str, sold: &str) -> LedgerTx {
    k.ledger
        .post(
            "loanLiquidate",
            &Json::obj([
                ("loanId", Json::str(loan_id)),
                ("userId", Json::str(BORROWER)),
                ("tranche", Json::int(0)),
                ("collateralAssetId", Json::str("BTC")),
                ("collateralSold", Json::str(sold)),
                ("debtAssetId", Json::str("USDT")),
                ("proceeds", Json::str("1000")),
                ("principalRepaid", Json::str("1000")),
                ("interestRepaid", Json::str("0")),
                ("penalty", Json::str("0")),
                ("surplusToBorrower", Json::str("0")),
                (
                    "buyer",
                    Json::obj([
                        ("collateralTo", market_maker("BTC").json()),
                        ("proceedsFrom", market_maker("USDT").json()),
                    ]),
                ),
                ("markPrice", Json::str("10000")),
            ]),
        )
        .unwrap()
}

/// The pending tranche-0 row a crash left behind, with its sale's ledger tx (and the bad debt's, when given).
fn insert_pending(
    k: &Kit,
    loan_id: &str,
    sold: &str,
    shortfall: &str,
    tx: &str,
    bad_debt_tx: Option<&str>,
) {
    let bad = bad_debt_tx.map_or_else(|| "NULL".to_owned(), |b| format!("'{b}'"));
    k.sql(&format!(
        "INSERT INTO bank.loan_liquidations (
           loan_id, tranche, ltv_bps, mark_price, grace_waived, collateral_sold, proceeds,
           principal_repaid, interest_repaid, penalty, surplus_returned, shortfall,
           ledger_tx_id, bad_debt_ledger_tx_id, status
         ) VALUES (
           '{loan_id}', 0, 9000, '10000'::numeric, true, '{sold}'::numeric, '1000'::numeric,
           '1000'::numeric, '0'::numeric, '0'::numeric, '0'::numeric, '{shortfall}'::numeric,
           '{tx}', {bad}, 'pending'
         )"
    ));
}

/// The one liquidation row's figures, as text: status, shortfall, proceeds, principal, interest, penalty, surplus,
/// collateral sold, ledger tx, bad-debt tx.
fn sale_row(k: &Kit, loan_id: &str) -> Vec<Option<String>> {
    let rows = k.rows(&format!(
        "SELECT status::text, shortfall::text, proceeds::text, principal_repaid::text, interest_repaid::text,
                penalty::text, surplus_returned::text, collateral_sold::text, ledger_tx_id::text,
                bad_debt_ledger_tx_id::text
           FROM bank.loan_liquidations WHERE loan_id = '{loan_id}'"
    ));
    assert_eq!(rows.len(), 1);
    rows[0].clone()
}

fn amount_of(cell: Option<&String>) -> String {
    fmt(amt(cell.unwrap()))
}

fn tx_id(k: &Kit, key: &str) -> Option<String> {
    k.ledger.by_key(key).map(|b| b.tx.id)
}

// ---------------------------------------------------------------------------------------------------------------
// the risk sweep

#[test]
fn leaves_a_healthy_loan_alone() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "10000");
    let s = sweep_at(&k, k.now);
    assert_eq!(s.called, 0);
    assert_eq!(s.liquidated, 0);
    assert_eq!(k.status(&o.loan.id), "active");
}

#[test]
fn raises_a_margin_call_records_it_and_delivers_it() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "6500"); // 5000/6500 = 76.93%
    let s = sweep_at(&k, k.now);
    assert_eq!(s.called, 1);
    assert_eq!(k.calls.len(), 1);
    let rows = k.rows(&format!(
        "SELECT ltv_bps::text, (notified_at IS NOT NULL)::text, cure_collateral_amount::text
           FROM bank.loan_margin_calls WHERE loan_id = '{}'",
        o.loan.id
    ));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][1].as_deref(), Some("true"));
    // The cure figure is what actually clears the call, rounded up.
    assert!(amt(rows[0][2].as_deref().unwrap()) > 0);
    assert_eq!(k.status(&o.loan.id), "margin_call");
}

/// A loan that crosses the liquidation threshold on its first mark is called, not liquidated.
#[test]
fn does_not_liquidate_on_the_first_mark_that_crosses_the_threshold() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5700"); // ~87.7%: above liquidation, below insolvency
    let s = sweep_at(&k, k.now);
    assert_eq!(s.liquidated, 0);
    assert_eq!(s.called, 1);
    assert_eq!(liquidations(&k, &o.loan.id), 0);
}

#[test]
fn does_not_liquidate_while_grace_is_still_running() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5700");
    sweep_at(&k, k.now);
    // Ten minutes later; grace is an hour.
    let s = sweep_at(&k, plus(k.now, 10 * MINUTE));
    assert_eq!(s.liquidated, 0);
    assert_eq!(liquidations(&k, &o.loan.id), 0);
}

#[test]
fn liquidates_a_partial_tranche_once_the_call_has_been_served_and_grace_has_expired() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5700");
    sweep_at(&k, k.now);
    let s = sweep_at(&k, plus(k.now, 2 * HOUR));
    assert_eq!(s.liquidated, 1);
    let rows = k.rows(&format!(
        "SELECT tranche::text, collateral_sold::text, grace_waived::text, status::text
           FROM bank.loan_liquidations WHERE loan_id = '{}'",
        o.loan.id
    ));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0].as_deref(), Some("0"));
    assert_eq!(rows[0][3].as_deref(), Some("settled"));
    assert_eq!(rows[0][2].as_deref(), Some("false"));
    // Partial. Not the whole position.
    let sold = amt(rows[0][1].as_deref().unwrap());
    assert!(sold > 0);
    assert!(sold < amt("1"));
    assert_ne!(fmt(collateral(&k, &o.loan.id)), "0");
}

#[test]
fn waives_grace_past_the_insolvency_threshold_and_records_that_it_did() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5200"); // ~96.2%
    let s = sweep_at(&k, k.now);
    assert_eq!(s.liquidated, 1);
    assert_eq!(
        k.one(&format!(
            "SELECT grace_waived::text FROM bank.loan_liquidations WHERE loan_id = '{}'",
            o.loan.id
        ))
        .as_deref(),
        Some("true")
    );
}

#[test]
fn clears_a_margin_call_when_the_borrower_posts_collateral() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "6500");
    sweep_at(&k, k.now);
    assert_eq!(k.status(&o.loan.id), "margin_call");

    k.fund(BORROWER, "BTC", "1");
    k.d(|d| service::add_collateral(d, &o.loan.id, &uuid(), amt("1")))
        .unwrap();

    let s = sweep_at(&k, plus(k.now, MINUTE));
    assert_eq!(s.cleared, 1);
    let l = k.loan(&o.loan.id);
    assert_eq!(l.status, "active");
    // The grace clock is reset: a fresh warning and a fresh hour before anything is sold.
    assert_eq!(l.margin_called_at, None);
    assert_eq!(
        k.count(&format!(
            "SELECT COUNT(*)::int8 FROM bank.loan_margin_calls WHERE loan_id = '{}' AND cleared_at IS NULL",
            o.loan.id
        )),
        0
    );
}

/// Call raised, recorded, grace, then the tranche: a borrower's first notice is never the receipt.
#[test]
fn a_liquidation_is_always_preceded_by_a_recorded_margin_call() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5700");
    sweep_at(&k, k.now);
    sweep_at(&k, plus(k.now, 2 * HOUR));
    let id = &o.loan.id;
    assert!(
        k.count(&format!(
            "SELECT COUNT(*)::int8 FROM bank.loan_margin_calls WHERE loan_id = '{id}'"
        )) >= 1
    );
    assert!(liquidations(&k, id) >= 1);
    assert_eq!(
        k.one(&format!(
            "SELECT ((SELECT called_at FROM bank.loan_margin_calls WHERE loan_id = '{id}' ORDER BY sequence LIMIT 1)
                   < (SELECT created_at FROM bank.loan_liquidations WHERE loan_id = '{id}' ORDER BY tranche LIMIT 1))::text"
        ))
        .as_deref(),
        Some("true")
    );
}

/// A doubtful mark costs a notification; a doubtful liquidation costs collateral. Refused, left for an operator.
#[test]
fn refuses_to_liquidate_on_a_mark_quality_that_must_not_seize_collateral() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5700");
    sweep_at(&k, k.now);
    // Same price, now from a single trade print.
    k.prices.set(&[("BTC", "5700", Some(MarkQuality::Last))]);
    let s = sweep_at(&k, plus(k.now, 2 * HOUR));
    assert_eq!(s.liquidated, 0);
    assert_eq!(s.refused.len(), 1);
    assert!(
        s.refused[0]
            .1
            .contains("single print must not seize collateral"),
        "{:?}",
        s.refused
    );
    assert_eq!(liquidations(&k, &o.loan.id), 0);
}

#[test]
fn will_not_liquidate_when_no_counterparty_can_take_the_collateral() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    k.open(&p.id, "1", "5000").unwrap();
    k.venue.set(loans_kit::Buyer::Nobody);
    k.prices.btc("5700");
    sweep_at(&k, k.now);
    let s = sweep_at(&k, plus(k.now, 2 * HOUR));
    assert_eq!(s.liquidated, 0);
    assert!(
        s.refused[0].1.contains("No counterparty"),
        "{:?}",
        s.refused
    );
}

/// A full collateral sale that leaves unpaid interest must not false-cure the loan to a healthy `active`.
#[test]
fn does_not_false_cure_to_active_after_full_coll_sale_leaves_unpaid_interest() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    k.ledger.seed_market_maker("USDT", "100000");
    // Insurance covers the principal shortfall after the dust sale.
    k.ledger.seed_insurance("USDT", "10000");
    // Full-tranche policy so one insolvency rung exhausts the collateral.
    let p = k.product_with(|p| {
        p.apr_bps = 3_650;
        p.policy = policy(|q| q.max_tranche_bps = 10_000);
    });
    let id = k.open(&p.id, "1", "5000").unwrap().loan.id;
    // ~5 USDT of interest after one day at 36.5% APR on 5000.
    k.d(|d| service::accrue(d, &id, plus(k.now, DAY))).unwrap();
    assert!(k.debt(&id).interest > 0);

    // Gap crash: 1 USDT/BTC, proceeds 1 < interest; insolvency waives grace.
    k.prices.btc("1");
    let crash = sweep_at(&k, k.now);
    assert_eq!(crash.liquidated, 1);

    assert_eq!(fmt(collateral(&k, &id)), "0");
    let residual = k.debt(&id);
    assert!(residual.interest > 0);
    assert!(residual.total > 0);
    // The closing rung left residual debt: it must not already look healthy.
    assert_ne!(k.status(&id), "active");

    // Next mark: nothing left to sell. It must not clear to active with unsecured residual interest.
    let next = sweep_at(&k, plus(k.now, MINUTE));
    assert_eq!(next.cleared, 0);
    let after = k.status(&id);
    assert_ne!(after, "active");
    assert_eq!(after, "margin_call");
    assert!(k.debt(&id).interest > 0);
}

/// One bad mark must not stop the sweep for everybody else.
#[test]
fn keeps_sweeping_past_a_loan_it_cannot_mark() {
    let Some(k) = kit() else { return };
    open_at(&k, "10000");
    k.fund(OTHER, "ETH", "10");
    let exotic = k.product_with(|p| {
        p.name = "ETH-backed".to_owned();
        p.collateral_asset_id = "ETH".to_owned();
    });
    k.fund_reserve("USDT", "100000");
    let _ = k.open_as(OTHER, &uuid(), &exotic.id, "10", "1");
    let s = sweep_at(&k, k.now);
    // The BTC loan was marked; the ETH one has no mark and is reported.
    assert!(s.marked + i64::try_from(s.refused.len()).unwrap() >= 1);
}

/// A crash after the sale and the bad-debt post, before `settled`: a later quote replaces nothing and posts nothing.
#[test]
fn keeps_the_stored_shortfall_when_a_pending_liquidation_with_a_ledger_tx_is_retried_on_a_later_quote()
 {
    let Some(k) = kit() else { return };
    let id = stored_sale_loan(&k);
    let sold = post_sale(&k, &id, "0.25");
    let bad = k
        .ledger
        .post(
            "loanBadDebt",
            &Json::obj([
                ("loanId", Json::str(id.clone())),
                ("debtAssetId", Json::str("USDT")),
                ("shortfall", Json::str("4000")),
            ]),
        )
        .unwrap();
    insert_pending(&k, &id, "0.25", "4000", &sold.id, Some(&bad.id));

    let insurance_before = k.ledger.of(&insurance_fund("USDT"));
    k.prices.btc("1");
    let s = sweep_with(&k, &k.store, &k.ledger, &Quote("100"), k.now);
    assert_eq!(s.refused, Vec::new());
    assert_eq!(s.liquidated, 1);

    let row = sale_row(&k, &id);
    assert_eq!(row[0].as_deref(), Some("settled"));
    assert_eq!(amount_of(row[1].as_ref()), "4000");
    assert_eq!(amount_of(row[2].as_ref()), "1000");
    assert_eq!(amount_of(row[3].as_ref()), "1000");
    assert_eq!(amount_of(row[4].as_ref()), "0");
    assert_eq!(amount_of(row[5].as_ref()), "0");
    assert_eq!(amount_of(row[6].as_ref()), "0");
    assert_eq!(row[8].as_deref(), Some(sold.id.as_str()));
    assert_eq!(row[9].as_deref(), Some(bad.id.as_str()));
    assert_eq!(
        tx_id(&k, &format!("bank.loan.liquidate:{id}:0")),
        Some(sold.id.clone())
    );
    assert_eq!(
        tx_id(&k, &format!("bank.loan.baddebt:{id}")),
        Some(bad.id.clone())
    );
    assert_eq!(k.ledger.of(&insurance_fund("USDT")), insurance_before);
}

/// A crash after the sale's tx is stored and before its shortfall is written: the retry posts the 4000 shortfall
/// once, from the stored sale, before the row settles.
#[test]
fn finishes_a_pending_liquidation_from_the_stored_sale_when_shortfall_is_still_0() {
    let Some(k) = kit() else { return };
    let id = stored_sale_loan(&k);
    let sold = post_sale(&k, &id, "1");
    insert_pending(&k, &id, "1", "0", &sold.id, None);

    let insurance_before = k.ledger.of(&insurance_fund("USDT"));
    k.prices.btc("1");
    let s = sweep_with(&k, &k.store, &k.ledger, &Quote("100"), k.now);
    assert_eq!(s.refused, Vec::new());
    assert_eq!(s.liquidated, 1);

    let row = sale_row(&k, &id);
    assert_eq!(row[0].as_deref(), Some("settled"));
    // Closing sale: principal still owed is 5000 - 1000 repaid.
    assert_eq!(amount_of(row[1].as_ref()), "4000");
    assert_eq!(amount_of(row[2].as_ref()), "1000");
    assert_eq!(amount_of(row[3].as_ref()), "1000");
    assert_eq!(amount_of(row[4].as_ref()), "0");
    assert_eq!(amount_of(row[5].as_ref()), "0");
    assert_eq!(amount_of(row[6].as_ref()), "0");
    assert_eq!(amount_of(row[7].as_ref()), "1");
    assert_eq!(row[8].as_deref(), Some(sold.id.as_str()));
    let bad_debt = tx_id(&k, &format!("bank.loan.baddebt:{id}"));
    assert!(bad_debt.is_some());
    assert_eq!(row[9], bad_debt);
    assert_eq!(
        tx_id(&k, &format!("bank.loan.liquidate:{id}:0")),
        Some(sold.id.clone())
    );
    assert_eq!(
        k.ledger.of(&insurance_fund("USDT")),
        insurance_before - amt("4000")
    );
    assert_eq!(fmt(k.debt(&id).principal), "0");

    let again = sweep_with(&k, &k.store, &k.ledger, &Quote("100"), plus(k.now, MINUTE));
    assert_eq!(again.liquidated, 0);
    assert_eq!(tx_id(&k, &format!("bank.loan.baddebt:{id}")), bad_debt);
    assert_eq!(
        k.ledger.of(&insurance_fund("USDT")),
        insurance_before - amt("4000")
    );
}

/// The same crash window on a sale that left collateral behind: settle at shortfall 0 and post no bad debt.
#[test]
fn settles_a_non_closing_stored_sale_at_shortfall_0_without_posting_bad_debt() {
    let Some(k) = kit() else { return };
    let id = stored_sale_loan(&k);
    let sold = post_sale(&k, &id, "0.25");
    insert_pending(&k, &id, "0.25", "0", &sold.id, None);

    let insurance_before = k.ledger.of(&insurance_fund("USDT"));
    k.prices.btc("1");
    let s = sweep_with(&k, &k.store, &k.ledger, &Quote("100"), k.now);
    assert_eq!(s.refused, Vec::new());
    assert_eq!(s.liquidated, 1);

    let row = sale_row(&k, &id);
    assert_eq!(row[0].as_deref(), Some("settled"));
    assert_eq!(amount_of(row[1].as_ref()), "0");
    assert_eq!(amount_of(row[2].as_ref()), "1000");
    assert_eq!(amount_of(row[3].as_ref()), "1000");
    assert_eq!(amount_of(row[4].as_ref()), "0");
    assert_eq!(amount_of(row[5].as_ref()), "0");
    assert_eq!(amount_of(row[6].as_ref()), "0");
    assert_eq!(amount_of(row[7].as_ref()), "0.25");
    assert_eq!(row[8].as_deref(), Some(sold.id.as_str()));
    assert_eq!(row[9], None);
    assert_eq!(
        tx_id(&k, &format!("bank.loan.liquidate:{id}:0")),
        Some(sold.id.clone())
    );
    assert_eq!(tx_id(&k, &format!("bank.loan.baddebt:{id}")), None);
    assert_eq!(k.ledger.of(&insurance_fund("USDT")), insurance_before);
}

/// The kit's book, with a hook run once, right after the first read of one account (`loans.collateralOf` replaced).
struct AfterFirstRead<'a> {
    inner: Book,
    watched: LedgerAccount,
    reads: Mutex<Vec<String>>,
    hook: Mutex<Option<Box<dyn FnOnce() + Send + 'a>>>,
}

impl Ledger for AfterFirstRead<'_> {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        let held = self.inner.balance(a)?;
        if *a == self.watched {
            self.reads.lock().unwrap().push(fmt(held));
            let hook = self.hook.lock().unwrap().take();
            if let Some(h) = hook {
                h();
            }
        }
        Ok(held)
    }
    fn balances(&self, t: &str, o: &str) -> Result<Vec<LedgerBalance>, String> {
        self.inner.balances(t, o)
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.inner.assets()
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        self.inner.account_id(a)
    }
    fn tx_by_id(&self, id: &str) -> Result<Option<LedgerTx>, String> {
        self.inner.tx_by_id(id)
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        self.inner.tx_by_key(key)
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        self.inner.post_recipe(recipe, input, key)
    }
}

#[test]
fn does_not_sell_a_stale_collateral_plan_after_an_add_collateral_top_up_with_unchanged_debt() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5200");
    k.fund(BORROWER, "BTC", "1");
    let debt_before = k.debt(&o.loan.id);
    let topped_up = AtomicBool::new(false);
    let id = o.loan.id.clone();
    let book = AfterFirstRead {
        inner: k.ledger.clone(),
        watched: collateral_account(BORROWER, "BTC", &id),
        reads: Mutex::new(Vec::new()),
        // A real top-up after the sweep reads its collateral, before it can take the liquidation lock. Debt unchanged.
        hook: Mutex::new(Some(Box::new(|| {
            topped_up.store(true, Ordering::SeqCst);
            k.d(|d| service::add_collateral(d, &id, &uuid(), amt("1")))
                .unwrap();
        }))),
    };
    let s = sweep_with(&k, &k.store, &book, &k.venue, k.now);
    assert_eq!(s.refused, Vec::new());

    assert!(topped_up.load(Ordering::SeqCst));
    let reads = book.reads.lock().unwrap().clone();
    assert_eq!(reads.get(0..2), Some(&["1".to_owned(), "2".to_owned()][..]));
    assert_eq!(sale_count(&k), 0);
    assert_eq!(liquidations(&k, &o.loan.id), 0);
    assert_eq!(k.debt(&o.loan.id), debt_before);
    assert_eq!(collateral(&k, &o.loan.id), amt("2"));
    k.ledger.closes();
}

/// Where the two overlapping sweeps are held.
#[derive(Default)]
struct Hold {
    /// The first sale has posted.
    first_sale: bool,
    /// The first sale is parked inside its post, its loan's lock still held.
    parked: bool,
    /// The park is over.
    released: bool,
}

#[derive(Default)]
struct Gate {
    m: Mutex<Hold>,
    cv: Condvar,
}

impl Gate {
    fn wait_until(&self, f: impl Fn(&Hold) -> bool) {
        let g = self.m.lock().unwrap();
        let (g, t) = self
            .cv
            .wait_timeout_while(g, Duration::from_secs(15), |h| !f(h))
            .unwrap();
        assert!(!t.timed_out(), "overlapping liquidations did not finish");
        drop(g);
    }
    fn update(&self, f: impl FnOnce(&mut Hold)) {
        f(&mut self.m.lock().unwrap());
        self.cv.notify_all();
    }
}

/// One sweep's view of the book: its first collateral read waits until both sweeps have read their debt (and, for
/// the second, until the first sale has posted); the first sale parks inside its post until released.
struct Overlap<'a> {
    inner: Book,
    pot: LedgerAccount,
    gate: &'a Gate,
    both_read_debt: &'a Barrier,
    second: bool,
    first_read: AtomicBool,
}

impl Ledger for Overlap<'_> {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        if *a == self.pot && !self.first_read.swap(true, Ordering::SeqCst) {
            // The debt is read before the collateral: both sweeps now hold the old debt.
            self.both_read_debt.wait();
            if self.second {
                self.gate.wait_until(|h| h.first_sale);
            }
        }
        self.inner.balance(a)
    }
    fn balances(&self, t: &str, o: &str) -> Result<Vec<LedgerBalance>, String> {
        self.inner.balances(t, o)
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.inner.assets()
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        self.inner.account_id(a)
    }
    fn tx_by_id(&self, id: &str) -> Result<Option<LedgerTx>, String> {
        self.inner.tx_by_id(id)
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        self.inner.tx_by_key(key)
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let posted = self.inner.post_recipe(recipe, input, key);
        if recipe == "loanLiquidate" {
            let mut park = false;
            self.gate.update(|h| {
                if !h.parked {
                    h.parked = true;
                    h.first_sale = true;
                    park = true;
                }
            });
            if park {
                self.gate.wait_until(|h| h.released);
            }
        }
        posted
    }
}

/// Two sweeps read the debt before the first sale; the second reads collateral after it. Its stale debt must not
/// authorise another tranche. The first sale is held until the second waits on the real session lock.
#[test]
fn two_overlapping_sweeps_of_one_open_loan_do_not_each_sell_the_same_collateral() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5200");
    let id = o.loan.id.clone();
    // A pool with room for both sweeps' session locks, as the TypeScript's pool has.
    let store = db::open(&k.db.url, "svc-bank", 10, false).unwrap();
    let gate = Gate::default();
    let barrier = Barrier::new(2);
    let saw_lock_wait = AtomicBool::new(false);
    let done = AtomicBool::new(false);
    let view = |second: bool| Overlap {
        inner: k.ledger.clone(),
        pot: collateral_account(BORROWER, "BTC", &id),
        gate: &gate,
        both_read_debt: &barrier,
        second,
        first_read: AtomicBool::new(false),
    };
    let (first, second) = (view(false), view(true));
    k.prices.stamp(k.now);
    std::thread::scope(|s| {
        let watcher = s.spawn(|| {
            let mut c = Client::connect(&k.db.url, NoTls).unwrap();
            let started = std::time::Instant::now();
            while !done.load(Ordering::SeqCst) {
                if gate.m.lock().unwrap().parked {
                    let n: i32 = c
                        .query_one(
                            "SELECT count(*)::int FROM pg_stat_activity
                              WHERE datname = current_database() AND wait_event_type = 'Lock'
                                AND pid <> pg_backend_pid()",
                            &[],
                        )
                        .unwrap()
                        .get(0);
                    if n > 0 {
                        saw_lock_wait.store(true, Ordering::SeqCst);
                    }
                    if n > 0 || sale_count(&k) >= 2 || started.elapsed() > Duration::from_secs(10) {
                        gate.update(|h| h.released = true);
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let a = s.spawn(|| sweep_with(&k, &store, &first, &k.venue, k.now));
        let b = s.spawn(|| sweep_with(&k, &store, &second, &k.venue, k.now));
        let (ra, rb) = (a.join(), b.join());
        done.store(true, Ordering::SeqCst);
        gate.update(|h| h.released = true);
        watcher.join().unwrap();
        ra.unwrap();
        rb.unwrap();
    });

    assert!(saw_lock_wait.load(Ordering::SeqCst));
    assert_eq!(sale_count(&k), 1);
    let rows = k.rows(&format!(
        "SELECT tranche::text, status::text FROM bank.loan_liquidations WHERE loan_id = '{id}' ORDER BY tranche"
    ));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0].as_deref(), Some("0"));
    assert_eq!(rows[0][1].as_deref(), Some("settled"));
    let after = k.status(&id);
    assert!(after == "margin_call" || after == "liquidated", "{after}");
    assert_eq!(collateral(&k, &id), amt("0.75"));
    assert_eq!(k.debt(&id).principal, amt("3700"));
    k.ledger.closes();
}

#[test]
fn does_not_sell_a_loan_that_is_already_liquidating() {
    let Some(k) = kit() else { return };
    let o = open_at(&k, "5200");
    k.sql(&format!(
        "UPDATE bank.loans SET status = 'liquidating' WHERE id = '{}'",
        o.loan.id
    ));
    let s = sweep_at(&k, k.now);
    assert_eq!(s.refused, Vec::new());
    assert_eq!(sale_count(&k), 0);
    assert_eq!(liquidations(&k, &o.loan.id), 0);
    assert_eq!(k.status(&o.loan.id), "liquidating");
}

/// A venue that closes the loan while it quotes: the loan is repaid or liquidated before the sale's claim.
struct ClosesOnQuote<'a> {
    k: &'a Kit,
    loan_id: String,
    status: &'static str,
}

impl Venue for ClosesOnQuote<'_> {
    fn quote(&self, _ask: &SaleAsk<'_>) -> Result<Option<VenueQuote>, String> {
        self.k.sql(&format!(
            "UPDATE bank.loans SET status = '{}'::bank.loan_status WHERE id = '{}'",
            self.status, self.loan_id
        ));
        Quote("1300").quote(_ask)
    }
}

#[test]
fn does_not_sell_when_the_loan_is_repaid_or_liquidated_before_the_claim() {
    let Some(k) = kit() else { return };
    for closed in ["repaid", "liquidated"] {
        k.prices.btc("10000");
        let o = open_at(&k, "5200");
        let venue = ClosesOnQuote {
            k: &k,
            loan_id: o.loan.id.clone(),
            status: closed,
        };
        let before = sale_count(&k);
        let s = sweep_with(&k, &k.store, &k.ledger, &venue, k.now);
        assert_eq!(s.refused, Vec::new());
        assert_eq!(sale_count(&k), before);
        assert_eq!(liquidations(&k, &o.loan.id), 0);
        assert_eq!(k.status(&o.loan.id), closed);
    }
}

#[test]
fn finishes_a_pending_rung_that_already_has_a_ledger_tx_while_the_loan_is_liquidating() {
    let Some(k) = kit() else { return };
    let id = stored_sale_loan(&k);
    let sold = post_sale(&k, &id, "1");
    insert_pending(&k, &id, "1", "0", &sold.id, None);
    k.sql(&format!(
        "UPDATE bank.loans SET status = 'liquidating' WHERE id = '{id}'"
    ));
    k.prices.btc("1");
    let before = sale_count(&k);
    let s = sweep_with(&k, &k.store, &k.ledger, &Quote("100"), k.now);
    assert_eq!(s.refused, Vec::new());
    assert_eq!(sale_count(&k), before);
    let rows = k.rows(&format!(
        "SELECT status::text, tranche::text, ledger_tx_id::text FROM bank.loan_liquidations
          WHERE loan_id = '{id}' ORDER BY tranche"
    ));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0].as_deref(), Some("settled"));
    assert_eq!(rows[0][1].as_deref(), Some("0"));
    assert_eq!(rows[0][2].as_deref(), Some(sold.id.as_str()));
    assert_eq!(
        tx_id(&k, &format!("bank.loan.liquidate:{id}:0")),
        Some(sold.id.clone())
    );
    assert_eq!(tx_id(&k, &format!("bank.loan.liquidate:{id}:1")), None);
}

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation

#[test]
fn the_reserve_identity_holds_funded_minus_bad_debt_equals_reserve_plus_outstanding_independent() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    k.open(&p.id, "1", "5000").unwrap();
    let r = k.d(|d| service::reconcile_reserve(d, "USDT")).unwrap();
    assert_eq!(fmt(r.reserve_balance), "95000");
    assert_eq!(fmt(r.outstanding_principal), "5000");
    assert_eq!(fmt(r.funded), "100000");
    // `funded` is the bank's funding table sum, independent of the ledger's reserve.
    assert!(r.independent);
    assert_eq!(fmt(r.drift), "0");
}

#[test]
fn reconcile_reserve_reports_independent_drift_when_funding_table_and_ledger_disagree() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "50000");
    // Take from the reserve without a funding row: the drift must surface, not hide as 0.
    k.ledger.shift(
        &reserve_account("USDT"),
        &loans_kit::available(BORROWER, "USDT"),
        "1000",
    );
    let r = k.d(|d| service::reconcile_reserve(d, "USDT")).unwrap();
    assert!(r.independent);
    assert_eq!(fmt(r.funded), "50000");
    assert_eq!(fmt(r.reserve_balance), "49000");
    assert_eq!(fmt(r.drift), "1000");
}

#[test]
fn pending_undrawn_principal_does_not_inflate_outstanding_reserve_never_left() {
    let Some(k) = kit() else { return };
    // An empty reserve: open locks collateral and fails the draw, leaving the loan pending.
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    let _ = k.open(&p.id, "1", "5000");
    let r = k.d(|d| service::reconcile_reserve(d, "USDT")).unwrap();
    // No draw happened: outstanding stays zero though a loan row names 5000.
    assert_eq!(fmt(r.outstanding_principal), "0");
    assert_eq!(fmt(r.reserve_balance), "0");
    assert_eq!(fmt(r.funded), "0");
    assert!(r.independent);
    assert_eq!(fmt(r.drift), "0");
}

#[test]
fn a_borrower_can_never_see_another_borrowers_loan_through_the_service() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "1");
    let p = k.product();
    k.open(&p.id, "1", "5000").unwrap();
    assert_eq!(
        k.d(|d| service::loans_of(d, OTHER, Some(50.0)))
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        k.d(|d| service::loans_of(d, BORROWER, Some(50.0)))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn marks_a_portfolio_reporting_the_aggregate_and_each_loan_on_its_own() {
    let Some(k) = kit() else { return };
    k.fund_reserve("USDT", "100000");
    k.fund(BORROWER, "BTC", "2");
    let p = k.product();
    k.open(&p.id, "1", "5000").unwrap();
    k.open(&p.id, "1", "1000").unwrap();
    let mark = k.d(|d| sweep::mark_user(d, BORROWER)).unwrap();
    assert_eq!(mark.loans.len(), 2);
    // Portfolio LTV is 6000/20000 = 30%; each loan's own figure is reported too, since aggregate health is a warning
    // and never authority to reach across to another loan's collateral.
    assert_eq!(mark.portfolio_ltv_bps, 3_000);
    assert!(mark.loans.iter().any(|l| l.ltv_bps == 5_000));
}
