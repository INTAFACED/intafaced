//! The money doors on a real Postgres (`support`: each test in its own throwaway database; without a URL it skips, with
//! `REQUIRE_POSTGRES=1` it fails). Every post enters through `POST /trpc/post` of the door, body-bound and signed as
//! the service the TypeScript test signs as; every observation leaves through `/trpc/balance` or `/trpc/balances`; the
//! freeze crosses `POST /operator/freeze`. The posts are the TypeScript tests' own, made by the same recipes and
//! recorded in `fixtures/engine-posts.golden.json` (`scripts/record-engine-posts.mjs`).
//!
//! The TypeScript files and cases it holds, case for case:
//! - `services/svc-ledger/src/money-spine-tip-reprove.test.ts`: every case (the fill through the door with holds cleared
//!   and house fees, the retried fill moving value once, the freeze after holds, the anonymous post).
//! - `services/svc-ledger/src/promise-falsify-public-doors.test.ts`: the door flows on a book, "keeps order and
//!   withdrawal recipe pots separate across post and balances doors", "locks, draws, and releases loan recipes without
//!   commingling collateral" and "refuses loan draw against an unfunded reserve". Its other cases are held elsewhere: the
//!   refusals before the book by `posting_parity.rs` and `wire_replay.rs`, the freeze reason by `freeze_pg.rs`, a frozen
//!   book by `posting_pg.rs`, and "blank loanId" is ledger-client's own.
//!
//! The TypeScript ran these over `MemoryLedger`; here the book is the Rust engine's, on Postgres.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::sync::{Arc, LazyLock};

use service_kit::json::{self, Json};
use service_kit::s2s::{legacy_headers, system_seconds};
use service_kit::server::Request;
use support::TestDb;
use support::operator::{Shared, call as operator_call, code, door_config, stub, treasury};
use svc_ledger::door::{DoorConfig, LedgerDoor, Outcome};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::migrate::FILES;
use svc_ledger::posting::Posting;
use svc_ledger::posting::engine::{Conflict, EngineOptions};

static FIXTURE: LazyLock<Json> =
    LazyLock::new(|| json::parse(include_str!("fixtures/engine-posts.golden.json")).unwrap());

/// `door_config`'s shared secret: the one the services sign with here.
const SECRET: &str = "placeholder-operator-test-internal-secret";
const APPROVER: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

fn recorded(group: &str, name: &str) -> String {
    FIXTURE
        .get(group)
        .and_then(|g| g.get(name))
        .unwrap_or_else(|| panic!("no recorded {group} {name}"))
        .compact()
}

/// The door as `index.ts` mounts it, posting with custody on, on a migrated book of its own.
struct Doors {
    _db: TestDb,
    door: LedgerDoor,
    caller: &'static str,
}

fn doors(caller: &'static str) -> Option<Doors> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    let bus = Arc::new(MemoryBus::default());
    let posting = Posting::new(
        bus.clone(),
        "svc-ledger".to_owned(),
        true,
        EngineOptions {
            conflict: Conflict::Refuse,
            clock_skew_bound_ms: None,
            clock_ms: svc_ledger::clock::system_ms,
        },
        false,
        None,
    );
    let door = LedgerDoor::new(DoorConfig {
        posting,
        ..door_config(&db, bus, Box::new(Shared(stub(Some(APPROVER), None))))
    })
    .unwrap();
    Some(Doors {
        _db: db,
        door,
        caller,
    })
}

impl Doors {
    /// One service call, signed over its body as `serviceAuthHeadersForBody` signs it (none: unsigned).
    fn send(&self, path: &str, body: &str, signer: Option<&str>) -> (u16, Json) {
        let mut headers = match signer {
            Some(svc) => legacy_headers(svc, SECRET, body, system_seconds()).unwrap(),
            None => Vec::new(),
        };
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        match self.door.decide(&Request {
            method: "POST",
            url: path,
            headers: &headers,
            body,
        }) {
            Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
            Outcome::Owed(s) => panic!("{path} is still owed by {}", s.name()),
        }
    }

    /// `servicePost(recipes.…)`.
    fn post(&self, name: &str) -> (u16, Json) {
        self.send("/trpc/post", &recorded("posts", name), Some(self.caller))
    }

    fn posted(&self, name: &str) -> Json {
        let (status, body) = self.post(name);
        assert_eq!(status, 200, "{name}: {}", body.compact());
        body
    }

    /// `serviceBalance(ref).json()`.
    fn balance(&self, account: &str) -> Json {
        let (status, body) = self.send(
            "/trpc/balance",
            &recorded("accounts", account),
            Some(self.caller),
        );
        assert_eq!(status, 200, "{account}: {}", body.compact());
        body
    }

    fn amount(&self, account: &str) -> String {
        field(&self.balance(account), "amount")
    }
}

fn field(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k}: {other:?} in {}", j.compact()),
    }
}

// ── money-spine-tip-reprove.test.ts ──────────────────────────────────────────────────────────────────────────────────

fn fund_spine_holds(d: &Doors) {
    for name in [
        "spine.taker.deposit",
        "spine.maker.deposit",
        "spine.taker.hold",
        "spine.maker.hold",
    ] {
        d.posted(name);
    }
}

#[test]
fn a_trade_fill_through_the_door_clears_both_holds_and_books_the_house_fees() {
    let Some(d) = doors("svc-trade") else { return };
    fund_spine_holds(&d);
    let ack = d.posted("spine.fill");
    assert!(!field(&ack, "txId").is_empty());
    assert!(!field(&ack, "hash").is_empty());

    assert_eq!(d.amount("spine.maker.usdt"), "899.1");
    assert_eq!(d.amount("spine.taker.btc"), "0.998");
    assert_eq!(d.amount("spine.fees.usdt"), "0.9");
    assert_eq!(d.amount("spine.fees.btc"), "0.002");
    let taker = d.balance("spine.taker.held");
    assert_eq!(
        (field(&taker, "purpose"), field(&taker, "amount")),
        ("order:taker-spine-1".to_owned(), "0".to_owned())
    );
    let maker = d.balance("spine.maker.held");
    assert_eq!(
        (field(&maker, "purpose"), field(&maker, "amount")),
        ("order:maker-spine-1".to_owned(), "0".to_owned())
    );
}

#[test]
fn a_retried_trade_fill_through_the_door_moves_value_once() {
    let Some(d) = doors("svc-trade") else { return };
    fund_spine_holds(&d);
    let first = d.posted("spine.fill");
    let second = d.posted("spine.fill");
    assert_eq!(field(&second, "txId"), field(&first, "txId"));
    assert_eq!(field(&second, "hash"), field(&first, "hash"));
    assert_eq!(d.amount("spine.maker.usdt"), "899.1");
    assert_eq!(d.amount("spine.fees.usdt"), "0.9");
}

#[test]
fn a_freeze_after_the_holds_blocks_the_fill_at_the_door_and_leaves_the_pots_untouched() {
    let Some(d) = doors("svc-trade") else { return };
    fund_spine_holds(&d);
    let (status, body) = operator_call(
        &d.door,
        "POST",
        "/operator/freeze",
        treasury(),
        r#"{"reason":"spine tip re-prove mid-fill halt","approvalId":"appr-1","operationId":"op-1"}"#,
    );
    assert_eq!(status, 200, "{}", body.compact());

    let (status, body) = d.post("spine.fill");
    assert_eq!((status, code(&body)), (412, Some("ledger.frozen")));
    assert_eq!(d.amount("spine.taker.held"), "900");
    assert_eq!(d.amount("spine.maker.held"), "1");
    assert_eq!(d.amount("spine.fees.usdt"), "0");
}

#[test]
fn an_anonymous_post_never_reaches_the_book() {
    let Some(d) = doors("svc-trade") else { return };
    let (status, _) = d.send("/trpc/post", &recorded("posts", "spine.anon"), None);
    assert_eq!(status, 401);
    assert_eq!(d.amount("spine.taker.usdt"), "0");
}

// ── promise-falsify-public-doors.test.ts: the flows on a book ────────────────────────────────────────────────────────

const PF_USER: &str = "11111111-1111-4111-8111-111111111111";

/// One holding of `/trpc/balances`' answer: its kind, purpose and amount.
fn holding(list: &Json, kind: &str, purpose: &str) -> Option<String> {
    let Json::Array(items) = list else {
        panic!("not a list: {}", list.compact())
    };
    items
        .iter()
        .find(|h| field(h, "kind") == kind && field(h, "purpose") == purpose)
        .map(|h| field(h, "amount"))
}

#[test]
fn order_and_withdrawal_pots_stay_separate_across_the_post_and_balances_doors() {
    let Some(d) = doors("svc-bank") else { return };
    d.posted("pf.pots.deposit");
    d.posted("pf.pots.order");
    d.posted("pf.pots.withdraw");

    let (status, list) = d.send(
        "/trpc/balances",
        &format!(r#"{{"ownerType":"user","ownerId":"{PF_USER}"}}"#),
        Some(d.caller),
    );
    assert_eq!(status, 200);
    assert_eq!(holding(&list, "available", "").as_deref(), Some("13"));
    assert_eq!(
        holding(&list, "hold", "order:order-door-1").as_deref(),
        Some("10")
    );
    assert_eq!(
        holding(&list, "hold", "withdraw:withdraw-door-1").as_deref(),
        Some("7")
    );

    d.posted("pf.pots.reverse");
    let reversed = d.balance("pf.withdraw");
    assert_eq!(
        (field(&reversed, "purpose"), field(&reversed, "amount")),
        ("withdraw:withdraw-door-1".to_owned(), "0".to_owned())
    );
    let order = d.balance("pf.order");
    assert_eq!(
        (field(&order, "purpose"), field(&order, "amount")),
        ("order:order-door-1".to_owned(), "10".to_owned())
    );
}

#[test]
fn loans_lock_draw_and_release_without_commingling_collateral() {
    let Some(d) = doors("svc-bank") else { return };
    for name in [
        "pf.loan.collateral",
        "pf.loan.cash",
        "pf.loan.fee",
        "pf.loan.fund",
        "pf.loan.lock.a",
        "pf.loan.lock.b",
        "pf.loan.draw.a",
        "pf.loan.release.a",
    ] {
        d.posted(name);
    }
    let a = d.balance("pf.loan.a");
    let b = d.balance("pf.loan.b");
    assert_eq!(
        (field(&a, "kind"), field(&a, "purpose"), field(&a, "amount")),
        (
            "collateral".to_owned(),
            "loan:loan-door-a".to_owned(),
            "0".to_owned()
        )
    );
    assert_eq!(
        (field(&b, "kind"), field(&b, "purpose"), field(&b, "amount")),
        (
            "collateral".to_owned(),
            "loan:loan-door-b".to_owned(),
            "1".to_owned()
        )
    );
    assert_eq!(d.amount("pf.reserve"), "0");
    assert_eq!(d.amount("pf.usdt"), "1000");
}

#[test]
fn a_loan_draw_against_an_unfunded_reserve_is_refused() {
    let Some(d) = doors("svc-bank") else { return };
    d.posted("pf.unfunded.deposit");
    let (status, body) = d.post("pf.unfunded.draw");
    assert_eq!(
        (status, code(&body)),
        (400, Some("ledger.insufficient_funds"))
    );
    assert_eq!(d.amount("pf.usdt"), "100");
}
