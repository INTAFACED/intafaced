//! svc-bank's own ledger client against this door: the Rust `LedgerHttp` (`crates/svc-bank/src/spaces/ports.rs`) signs
//! each recipe as svc-bank and sends it to `/trpc/postRecipe` on a real Rust svc-ledger over a fresh Postgres book
//! (`support`), and reads back the receipt it checks (the key it expects, the transaction, the legs). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Each body is the one svc-bank sends, field for field, and each key is svc-bank's own key function: loans
//! (`loans/service.rs` `collateral_input`, the draw in `open`, `repay_input`, `fund_reserve`; `loans/sweep.rs`
//! `loanLiquidate` and `cover_shortfall`), business (`business/service.rs` `hold_input`, the settle and the payroll),
//! ramps and card holds (`ramps/onramp/service.rs`, `ramps/offramp.rs` `recipe_input`, `cards/moves/decide.rs` and
//! `settle.rs`, the cash-out's `Recipe::inputs`), and cashback (`cards/moves/cashback.rs`). The door is mounted as at
//! launch (per-service keys in `keypair` mode, svc-bank's own key) with the custody layer on, then off. Only the HTTP
//! transport is in process (`Fetch` hands the request to the door): the signing, the body, the door and the book are
//! the real ones.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::sync::Arc;

use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::s2s::{CallSigner, Mode};
use service_kit::server::Request;
use support::TestDb;
use support::door::{Kit, Setup, migrated};
use svc_bank::business::service::{hold_key, payroll_key, release_key, settle_key};
use svc_bank::cards::moves::cashback::rewards_pot;
use svc_bank::loans::ports::market_maker;
use svc_bank::loans::service::{
    bad_debt_key, draw_key, liquidate_key, lock_key, release_key as loan_release_key, repay_key,
};
use svc_bank::spaces::ports::{Ledger, LedgerAccount, LedgerHttp, LedgerTx, PostFailure};
use svc_ledger::door::Outcome;
use svc_ledger::errors::{CUSTODY_LAYER_OFF, INSUFFICIENT_FUNDS};

const BASE: &str = "http://svc-ledger.test";
const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYEE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOAN: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVAL_A: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const APPROVAL_B: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PAYROLL: &str = "12345678-1234-4234-8234-123456789abc";
const OFFRAMP: &str = "11111111-2222-4333-8444-555555555555";
const AUTHORIZATION: &str = "66666666-7777-4888-8999-aaaaaaaaaaaa";

/// The wire, in process: each request is handed to the door as the server hands it one.
struct DoorFetch(Arc<Kit>);

impl Fetch for DoorFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let path = req
            .url
            .strip_prefix(BASE)
            .expect("the client calls the ledger's base url");
        let headers: Vec<(String, String)> = req
            .headers
            .iter()
            .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
            .collect();
        match self.0.door.decide(&Request {
            method: &req.method,
            url: path,
            headers: &headers,
            body: req.body.as_deref().unwrap_or(""),
        }) {
            Outcome::Answer(r) => Ok(HttpResponse {
                status: r.status,
                body: r.body,
            }),
            Outcome::Owed(s) => panic!("{path} is still owed by {}", s.name()),
        }
    }
}

/// The door over a fresh book, and svc-bank's client to it, signed with svc-bank's own key (`main.rs`).
fn wired(custody_on: bool) -> Option<(TestDb, Arc<Kit>, LedgerHttp)> {
    let db = migrated()?;
    let kit = Arc::new(Kit::new(
        &db,
        &Setup {
            mode: Some(Mode::Keypair),
            services: &["svc-bank", "svc-academy"],
            custody_on,
        },
    ));
    let signer = CallSigner::new(
        "svc-bank",
        "svc-ledger",
        "unused-shared-secret-in-keypair-mode",
        Some((kit.signer("svc-bank"), Mode::Keypair)),
    );
    let ledger = LedgerHttp::new(BASE, signer, Box::new(DoorFetch(kit.clone())));
    Some((db, kit, ledger))
}

fn amt(s: &str) -> service_kit::money::Amount {
    parse_amount(s).unwrap()
}

fn s(v: &str) -> Json {
    Json::str(v)
}

/// `amount` into `account` from a test rail, as the engine books a test's setup (no caller, no gate).
fn seed(k: &Kit, account: &LedgerAccount, amount: &str) {
    let rail = LedgerAccount {
        owner_type: "treasury",
        owner_id: "rail:test-seed".to_owned(),
        asset_id: account.asset_id.clone(),
        kind: "available",
        purpose: None,
    };
    k.engine(&Json::obj([
        (
            "idempotencyKey",
            Json::str(format!(
                "deposit:test-seed:{}:{}:{}",
                account.owner_type, account.owner_id, account.asset_id
            )),
        ),
        ("module", s("ledger")),
        ("reason", s("deposit")),
        (
            "entries",
            Json::Array(vec![
                Json::obj([
                    ("account", rail.json()),
                    ("direction", s("credit")),
                    ("amount", s(amount)),
                ]),
                Json::obj([
                    ("account", account.json()),
                    ("direction", s("debit")),
                    ("amount", s(amount)),
                ]),
            ]),
        ),
    ]));
}

fn bal(k: &Kit, account: &LedgerAccount) -> String {
    k.bal(&account.json())
}

/// Posts through svc-bank's client and checks what svc-bank checks: the receipt names the key it expects, the
/// transaction is the one booked under it, and a retry (a lost reply) is the same transaction, booked once.
fn posts(k: &Kit, ledger: &LedgerHttp, recipe: &str, input: &Json, key: &str) -> LedgerTx {
    let tx = ledger
        .post_recipe(recipe, input, key)
        .unwrap_or_else(|f| panic!("{recipe}: {f:?}"));
    assert_eq!(tx.key, key, "{recipe}");
    assert_eq!(k.tx(key).unwrap().0, tx.id, "{recipe}");
    assert_eq!(
        ledger.post_recipe(recipe, input, key).unwrap().id,
        tx.id,
        "{recipe} retried"
    );
    assert_eq!(k.rows(key), 1, "{recipe}");
    tx
}

fn refused(ledger: &LedgerHttp, recipe: &str, input: &Json, key: &str) -> PostFailure {
    ledger
        .post_recipe(recipe, input, key)
        .expect_err("the door refuses it")
}

fn usdt(owner: &str) -> LedgerAccount {
    LedgerAccount::user_available(owner, "USDT")
}

fn reserve(asset: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "module",
        owner_id: "bank:loan-reserve".to_owned(),
        asset_id: asset.to_owned(),
        kind: "available",
        purpose: None,
    }
}

fn house(owner_id: &str, asset: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "house",
        owner_id: owner_id.to_owned(),
        asset_id: asset.to_owned(),
        kind: "available",
        purpose: None,
    }
}

fn collateral_pot() -> LedgerAccount {
    LedgerAccount {
        owner_type: "user",
        owner_id: USER.to_owned(),
        asset_id: "BTC".to_owned(),
        kind: "collateral",
        purpose: Some(format!("loan:{LOAN}")),
    }
}

/// `loans/service.rs` `collateral_input`.
fn collateral_input(amount: &str, sequence: i64) -> Json {
    Json::obj([
        ("loanId", s(LOAN)),
        ("userId", s(USER)),
        ("collateralAssetId", s("BTC")),
        ("amount", Json::str(format_amount(amt(amount)))),
        ("sequence", Json::int(sequence)),
    ])
}

/// The draw in `loans/service.rs` `open`.
fn draw_input(principal: &str) -> Json {
    Json::obj([
        ("loanId", s(LOAN)),
        ("userId", s(USER)),
        ("debtAssetId", s("USDT")),
        ("principal", Json::str(format_amount(amt(principal)))),
    ])
}

/// `loans/service.rs` `fund_reserve` with no `from` (the operator door passes none).
fn reserve_input(funding_id: &str, amount: &str) -> Json {
    Json::Object(vec![
        ("fundingId".to_owned(), s(funding_id)),
        ("debtAssetId".to_owned(), s("USDT")),
        ("amount".to_owned(), Json::str(format_amount(amt(amount)))),
    ])
}

#[test]
fn a_loan_funded_locked_drawn_repaid_liquidated_released_and_covered_books_each_once_under_svc_banks_keys()
 {
    let Some((_db, k, ledger)) = wired(true) else {
        return;
    };
    seed(&k, &LedgerAccount::user_available(USER, "BTC"), "1");
    seed(&k, &house("fees:bank", "USDT"), "1000");
    seed(&k, &house("insurance-fund", "USDT"), "50");
    seed(&k, &market_maker("USDT"), "10000");

    // The reserve, from the bank's own fee revenue.
    let fund_key = "bank.loan.reserve.fund:USDT:treasury-2026-11";
    posts(
        &k,
        &ledger,
        "loanReserveFund",
        &reserve_input("treasury-2026-11", "1000"),
        fund_key,
    );
    assert_eq!(bal(&k, &reserve("USDT")), "1000");
    assert_eq!(bal(&k, &house("fees:bank", "USDT")), "0");

    // Step 1: the collateral into the loan's own pot. Step 2: the principal to the borrower.
    let locked = posts(
        &k,
        &ledger,
        "loanCollateralLock",
        &collateral_input("0.5", 0),
        &lock_key(LOAN, 0),
    );
    assert_eq!(locked.entries.len(), 2);
    assert_eq!(bal(&k, &LedgerAccount::user_available(USER, "BTC")), "0.5");
    assert_eq!(bal(&k, &collateral_pot()), "0.5");
    posts(&k, &ledger, "loanDraw", &draw_input("600"), &draw_key(LOAN));
    assert_eq!(bal(&k, &reserve("USDT")), "400");
    assert_eq!(bal(&k, &usdt(USER)), "600");

    // A repayment: principal back to the reserve, interest to the bank's revenue (`repay_input`).
    let repay = Json::obj([
        ("loanId", s(LOAN)),
        ("userId", s(USER)),
        ("debtAssetId", s("USDT")),
        ("principal", s("100")),
        ("interest", s("1.5")),
        ("sequence", Json::int(1)),
    ]);
    let repaid = posts(&k, &ledger, "loanRepay", &repay, &repay_key(LOAN, 1));
    assert_eq!(repaid.entries.len(), 3);
    assert_eq!(bal(&k, &usdt(USER)), "498.5");
    assert_eq!(bal(&k, &reserve("USDT")), "500");
    assert_eq!(bal(&k, &house("fees:bank", "USDT")), "1.5");

    // One liquidation rung sold to the house market maker (`loans/sweep.rs`): collateral to the buyer, its payment split.
    let liquidate = Json::obj([
        ("loanId", s(LOAN)),
        ("userId", s(USER)),
        ("tranche", Json::int(0)),
        ("collateralAssetId", s("BTC")),
        ("collateralSold", s("0.1")),
        ("debtAssetId", s("USDT")),
        ("proceeds", s("600")),
        ("principalRepaid", s("500")),
        ("interestRepaid", s("10")),
        ("penalty", s("30")),
        ("surplusToBorrower", s("60")),
        (
            "buyer",
            Json::obj([
                ("collateralTo", market_maker("BTC").json()),
                ("proceedsFrom", market_maker("USDT").json()),
            ]),
        ),
        ("markPrice", s("6000")),
    ]);
    posts(
        &k,
        &ledger,
        "loanLiquidate",
        &liquidate,
        &liquidate_key(LOAN, 0),
    );
    assert_eq!(bal(&k, &collateral_pot()), "0.4");
    assert_eq!(bal(&k, &market_maker("BTC")), "0.1");
    assert_eq!(bal(&k, &market_maker("USDT")), "9400");
    assert_eq!(bal(&k, &reserve("USDT")), "1000");
    assert_eq!(bal(&k, &house("fees:bank", "USDT")), "41.5");
    assert_eq!(bal(&k, &usdt(USER)), "558.5");

    // The rest of the collateral back to the borrower; a release past what the pot holds is refused by the book.
    let over = refused(
        &ledger,
        "loanCollateralRelease",
        &collateral_input("0.5", 1),
        &loan_release_key(LOAN, 1),
    );
    assert!(over.insufficient(), "{over:?}");
    assert_eq!(k.rows(&loan_release_key(LOAN, 1)), 0);
    posts(
        &k,
        &ledger,
        "loanCollateralRelease",
        &collateral_input("0.4", 1),
        &loan_release_key(LOAN, 1),
    );
    assert_eq!(bal(&k, &collateral_pot()), "0");
    assert_eq!(bal(&k, &LedgerAccount::user_available(USER, "BTC")), "0.9");

    // Bad debt the insurance fund covers (`cover_shortfall`).
    let bad_debt = Json::obj([
        ("loanId", s(LOAN)),
        ("debtAssetId", s("USDT")),
        ("shortfall", s("12.5")),
    ]);
    posts(&k, &ledger, "loanBadDebt", &bad_debt, &bad_debt_key(LOAN));
    assert_eq!(bal(&k, &house("insurance-fund", "USDT")), "37.5");
    assert_eq!(bal(&k, &reserve("USDT")), "1012.5");
}

#[test]
fn a_draw_the_reserve_cannot_cover_is_refused_insufficient_funds_and_nothing_is_booked() {
    let Some((_db, k, ledger)) = wired(true) else {
        return;
    };
    seed(&k, &LedgerAccount::user_available(USER, "BTC"), "1");
    posts(
        &k,
        &ledger,
        "loanCollateralLock",
        &collateral_input("0.5", 0),
        &lock_key(LOAN, 0),
    );
    let err = refused(&ledger, "loanDraw", &draw_input("600"), &draw_key(LOAN));
    assert_eq!(err.code(), Some(INSUFFICIENT_FUNDS), "{err:?}");
    assert_eq!(k.rows(&draw_key(LOAN)), 0);
    assert_eq!(bal(&k, &usdt(USER)), "0");
}

#[test]
fn deposits_business_approvals_payroll_card_holds_cash_outs_and_cashback_book_under_svc_banks_keys()
{
    let Some((_db, k, ledger)) = wired(true) else {
        return;
    };
    let primary = LedgerAccount::user_available(USER, "USDC");
    let named = LedgerAccount::sub_account_available(SPACE, "USDC");
    let payee = LedgerAccount::user_available(PAYEE, "USDC");

    // An on-ramp credit (`ramps/onramp/service.rs`), under `deposit:<rail>:<railRef>`.
    let deposit = Json::obj([
        ("userId", s(USER)),
        ("assetId", s("USDC")),
        ("amount", s("200")),
        ("rail", s("bank-crypto-ledger")),
        ("railRef", s("0xabc")),
    ]);
    posts(
        &k,
        &ledger,
        "deposit",
        &deposit,
        "deposit:bank-crypto-ledger:0xabc",
    );
    assert_eq!(bal(&k, &primary), "200");

    // Approval A held then released; approval B held then settled to the named space (`hold_input`, the settle).
    let hold = |id: &str, from: &LedgerAccount| {
        Json::obj([
            ("approvalId", s(id)),
            ("from", from.json()),
            ("amount", s("30")),
        ])
    };
    let held = LedgerAccount {
        owner_type: "user",
        owner_id: USER.to_owned(),
        asset_id: "USDC".to_owned(),
        kind: "hold",
        purpose: Some(format!("business-approval:{APPROVAL_A}")),
    };
    posts(
        &k,
        &ledger,
        "businessApprovalHold",
        &hold(APPROVAL_A, &primary),
        &hold_key(APPROVAL_A),
    );
    assert_eq!(bal(&k, &primary), "170");
    assert_eq!(bal(&k, &held), "30");
    posts(
        &k,
        &ledger,
        "businessApprovalRelease",
        &hold(APPROVAL_A, &primary),
        &release_key(APPROVAL_A),
    );
    assert_eq!(bal(&k, &held), "0");
    assert_eq!(bal(&k, &primary), "200");
    posts(
        &k,
        &ledger,
        "businessApprovalHold",
        &hold(APPROVAL_B, &primary),
        &hold_key(APPROVAL_B),
    );
    let settle = Json::obj([
        ("approvalId", s(APPROVAL_B)),
        ("from", primary.json()),
        ("to", named.json()),
        ("amount", s("30")),
    ]);
    posts(
        &k,
        &ledger,
        "businessApprovalSettle",
        &settle,
        &settle_key(APPROVAL_B),
    );
    assert_eq!(bal(&k, &primary), "170");
    assert_eq!(bal(&k, &named), "30");

    // A payroll run: every line paid in one post.
    let payroll = Json::obj([
        ("payrollId", s(PAYROLL)),
        ("from", primary.json()),
        (
            "recipients",
            Json::Array(vec![
                Json::obj([("to", named.json()), ("amount", s("10"))]),
                Json::obj([("to", payee.json()), ("amount", s("5"))]),
            ]),
        ),
    ]);
    let paid = posts(
        &k,
        &ledger,
        "businessPayroll",
        &payroll,
        &payroll_key(PAYROLL),
    );
    assert_eq!(paid.entries.len(), 3);
    assert_eq!(bal(&k, &primary), "155");
    assert_eq!(bal(&k, &named), "40");
    assert_eq!(bal(&k, &payee), "5");

    // An off-ramp held then settled to its rail (`ramps/offramp.rs` `recipe_input`); a card hold reversed
    // (`cards/moves/settle.rs`); a cash-out held under `cash-out:<id>` (the cash-out's `Recipe::inputs`).
    let withdrawal = |id: &str, rail: &str, amount: &str| {
        Json::obj([
            ("userId", s(USER)),
            ("assetId", s("USDC")),
            ("amount", s(amount)),
            ("rail", s(rail)),
            ("withdrawalId", s(id)),
        ])
    };
    let off = withdrawal(OFFRAMP, "bank-crypto-ledger", "20");
    posts(
        &k,
        &ledger,
        "withdrawHold",
        &off,
        &format!("withdraw.hold:{OFFRAMP}"),
    );
    posts(
        &k,
        &ledger,
        "withdrawSettle",
        &off,
        &format!("withdraw.settle:{OFFRAMP}"),
    );
    assert_eq!(bal(&k, &primary), "135");
    let card = withdrawal(AUTHORIZATION, "card-sim", "15");
    posts(
        &k,
        &ledger,
        "withdrawHold",
        &card,
        &format!("withdraw.hold:{AUTHORIZATION}"),
    );
    assert_eq!(bal(&k, &primary), "120");
    posts(
        &k,
        &ledger,
        "withdrawReverse",
        &card,
        &format!("withdraw.reverse:{AUTHORIZATION}"),
    );
    assert_eq!(bal(&k, &primary), "135");
    let cash_out = format!("cash-out:{OFFRAMP}");
    posts(
        &k,
        &ledger,
        "withdrawHold",
        &withdrawal(&cash_out, "payout-sim", "5"),
        &format!("withdraw.hold:{cash_out}"),
    );
    assert_eq!(bal(&k, &primary), "130");

    // Cashback: the bank's revenue swept into the rewards pot (`fund_pot`), then paid to the cardholder.
    seed(&k, &house("fees:bank", "USDC"), "10");
    let sweep = Json::obj([
        ("windowId", s("bank.card:2026-11")),
        ("sourceModule", s("bank")),
        ("assetId", s("USDC")),
        ("amount", s("10")),
    ]);
    posts(
        &k,
        &ledger,
        "sweepFeesToRewards",
        &sweep,
        "token.fee.sweep:bank.card:2026-11:bank:USDC",
    );
    assert_eq!(bal(&k, &rewards_pot("USDC")), "10");
    let reward_id = format!("bank.card.cashback:{AUTHORIZATION}");
    let reward = Json::obj([
        ("rewardId", s(&reward_id)),
        ("userId", s(USER)),
        ("assetId", s("USDC")),
        ("amount", s("0.25")),
        ("reason", s("bank.card.cashback")),
    ]);
    posts(
        &k,
        &ledger,
        "rewardPay",
        &reward,
        &format!("reward:{reward_id}"),
    );
    assert_eq!(bal(&k, &rewards_pot("USDC")), "9.75");
    assert_eq!(bal(&k, &primary), "130.25");
}

#[test]
fn with_the_custody_layer_off_the_reserve_is_funded_but_no_customer_balance_moves_412() {
    let Some((_db, k, ledger)) = wired(false) else {
        return;
    };
    seed(&k, &house("fees:bank", "USDT"), "1000");
    // The bank's own money into its own reserve touches no customer: it books at launch.
    posts(
        &k,
        &ledger,
        "loanReserveFund",
        &reserve_input("treasury-2026-11", "1000"),
        "bank.loan.reserve.fund:USDT:treasury-2026-11",
    );
    assert_eq!(bal(&k, &reserve("USDT")), "1000");
    for (recipe, input, key) in [
        (
            "loanCollateralLock",
            collateral_input("0.5", 0),
            lock_key(LOAN, 0),
        ),
        ("loanDraw", draw_input("600"), draw_key(LOAN)),
    ] {
        let err = refused(&ledger, recipe, &input, &key);
        assert_eq!(err.code(), Some(CUSTODY_LAYER_OFF), "{recipe}: {err:?}");
        assert_eq!(k.rows(&key), 0, "{recipe}");
    }
    assert_eq!(bal(&k, &reserve("USDT")), "1000");
}

#[test]
fn inputs_a_recipe_refuses_and_another_services_call_are_refused_before_the_book_and_nothing_is_booked()
 {
    let Some((_db, k, ledger)) = wired(true) else {
        return;
    };
    seed(&k, &LedgerAccount::user_available(USER, "BTC"), "1");
    // A zero lock and a repayment of nothing are the recipes' own refusals.
    let zero = refused(
        &ledger,
        "loanCollateralLock",
        &collateral_input("0", 0),
        &lock_key(LOAN, 0),
    );
    assert_eq!(
        zero.code(),
        Some(svc_ledger::errors::POST_RECIPE_INPUT_INVALID),
        "{zero:?}"
    );
    let nothing = Json::obj([
        ("loanId", s(LOAN)),
        ("userId", s(USER)),
        ("debtAssetId", s("USDT")),
        ("principal", s("0")),
        ("interest", s("0")),
        ("sequence", Json::int(0)),
    ]);
    let none = refused(&ledger, "loanRepay", &nothing, &repay_key(LOAN, 0));
    assert_eq!(
        none.code(),
        Some(svc_ledger::errors::POST_RECIPE_INPUT_INVALID),
        "{none:?}"
    );
    assert_eq!(k.rows(&lock_key(LOAN, 0)), 0);
    assert_eq!(k.rows(&repay_key(LOAN, 0)), 0);
    // svc-academy holds no grant for svc-bank's recipes.
    let body = Json::obj([
        ("recipe", s("loanCollateralLock")),
        ("input", collateral_input("0.5", 0)),
    ]);
    let (status, reply) = k.keyed("svc-academy", "/trpc/postRecipe", &body);
    assert_eq!(status, 403, "{}", reply.compact());
    assert_eq!(k.rows(&lock_key(LOAN, 0)), 0);
    assert_eq!(bal(&k, &LedgerAccount::user_available(USER, "BTC")), "1");
}
