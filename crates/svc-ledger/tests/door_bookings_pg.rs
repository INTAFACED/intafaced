//! The posting door's bookings for a key-proven caller, on a real Postgres, through the Rust door, each case in its own
//! throwaway database (`support`). Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proved these at the door over a stand-in ledger (or as the caller binding's verdict alone); here each
//! is a booking on the book, or a refusal that books nothing, case for case:
//! - `buyback-grant.test.ts`: "a key-proven svc-trade may post %s" and "a key-proven svc-token or svc-pay may not post
//!   %s" (`buyback_*`); its grant rows are `posting_parity.rs`'s;
//! - `staff-hold-grant.test.ts`: "on its own key: a staff hold posts, its key reads back, a deposit is refused, and
//!   balance and history refuse it" (`staff_hold_*`); its grant rows are `posting_parity.rs`'s;
//! - `caller-binding.test.ts`, "POST /trpc/post caller binding" (`binding_*`): every case, the off-list key-signed
//!   post counted and logged, the three legacy posts warned once and counted, svc-bank's interest-only loan repayment
//!   booked and svc-pay's refused, svc-agents' fee in its own module booked and in another refused, and its signature
//!   cases (no fallback to the shared secret, a replayed signed post, another audience); and "the token buyback recipes
//!   need a key once keys exist" (`key_required_*`).
//!
//! Each body is the TypeScript recipe's own, recorded by `scripts/record-door-books.mjs`; what a body needs on the book
//! first (funds, an order's hold, a maker's ask) is posted through the engine. `callerBindingCounts()` is
//! `Posting::binding_counts`, the warning lines the posting slice's log.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use service_kit::json::Json;
use service_kit::s2s::{Mode, legacy_headers, system_seconds};
use support::TestDb;
use support::door::{Kit, SECRET, Setup, fx, fx_list, migrated};
use svc_ledger::errors::{CALLER_FORBIDDEN, CALLER_UNBOUND, UNAUTHENTICATED};

const BUYBACK: [&str; 3] = [
    "buybackOrderHold",
    "buybackOrderHoldRelease",
    "buybackTakerFill",
];
const WARNING: &str = "ledger caller binding violation";

fn s(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(t)) => t.clone(),
        other => panic!("{k}: {other:?} in {}", v.compact()),
    }
}

fn booked((status, body): (u16, Json)) -> Json {
    assert_eq!(status, 200, "{}", body.compact());
    body
}

fn refused((status, body): (u16, Json), want: u16, code: &str) -> Json {
    assert_eq!(status, want, "{}", body.compact());
    assert_eq!(
        body.get("code"),
        Some(&Json::str(code)),
        "{}",
        body.compact()
    );
    body
}

fn kit(db: &TestDb, mode: Option<Mode>, services: &[&str]) -> Kit {
    Kit::new(
        db,
        &Setup {
            mode,
            services,
            custody_on: true,
        },
    )
}

fn warnings(k: &Kit) -> usize {
    k.log.text().matches(WARNING).count()
}

fn counts(k: &Kit) -> Vec<(&'static str, String, u64)> {
    k.door.posting().binding_counts()
}

fn total(k: &Kit) -> i64 {
    let mut c = postgres::Client::connect(&k.url(), postgres::NoTls).unwrap();
    c.query_one("SELECT count(*) FROM ledger.ledger_tx", &[])
        .unwrap()
        .get(0)
}

// ── the buyback recipes ──────────────────────────────────────────────────────────────────────────────────────────

/// What `recipe`'s body (from `buyback.<set>`) needs on the book first, posted by the engine.
fn buyback_book(k: &Kit, set: &str, recipe: &str) {
    for p in fx_list(&["buyback", set, "book", "funded"]) {
        k.engine(&p);
    }
    if recipe != "buybackOrderHold" {
        k.engine(&fx(&["buyback", set, "book", "held"]));
    }
    if recipe == "buybackTakerFill" {
        for p in fx_list(&["buyback", set, "book", "ask"]) {
            k.engine(&p);
        }
    }
}

fn buyback_body(set: &str, recipe: &str) -> Json {
    fx(&["buyback", set, "bodies", recipe])
}

#[test]
fn buyback_a_key_proven_svc_trade_may_post_each_buyback_recipe_and_it_books() {
    for recipe in BUYBACK {
        let Some(db) = migrated() else { return };
        let k = kit(&db, Some(Mode::Dual), &["svc-trade"]);
        buyback_book(&k, "grant", recipe);
        let body = buyback_body("grant", recipe);
        let tx = booked(k.keyed("svc-trade", "/trpc/post", &body));
        let key = s(&body, "idempotencyKey");
        assert_eq!(k.tx(&key).unwrap().0, s(&tx, "txId"), "{recipe}");
        assert!(counts(&k).is_empty(), "{recipe}: {:?}", counts(&k));
    }
}

#[test]
fn buyback_a_key_proven_svc_token_or_svc_pay_may_not_post_a_buyback_recipe_and_nothing_books() {
    for recipe in BUYBACK {
        for service in ["svc-token", "svc-pay"] {
            let Some(db) = migrated() else { return };
            let k = kit(&db, Some(Mode::Dual), &["svc-token", "svc-pay"]);
            buyback_book(&k, "grant", recipe);
            let body = buyback_body("grant", recipe);
            let before = total(&k);
            let err = refused(k.keyed(service, "/trpc/post", &body), 403, CALLER_FORBIDDEN);
            assert!(
                s(&err, "message").contains(service),
                "{recipe} {service}: {}",
                err.compact()
            );
            assert!(
                s(&err, "message").contains(recipe),
                "{recipe} {service}: {}",
                err.compact()
            );
            assert_eq!(total(&k), before, "{recipe} {service}");
        }
    }
}

#[test]
fn key_required_dual_refuses_a_shared_secret_buyback_even_under_the_granted_name_and_counts_it() {
    for recipe in BUYBACK {
        let Some(db) = migrated() else { return };
        let k = kit(&db, Some(Mode::Dual), &["svc-trade"]);
        buyback_book(&k, "bind", recipe);
        let before = total(&k);
        refused(
            k.shared("svc-trade", "/trpc/post", &buyback_body("bind", recipe)),
            401,
            CALLER_UNBOUND,
        );
        assert_eq!(total(&k), before, "{recipe}");
        // Refused, and still counted as an unbound post under the claimed name.
        assert_eq!(
            counts(&k),
            [("unbound", "svc-trade".to_owned(), 1)],
            "{recipe}"
        );
    }
}

#[test]
fn key_required_dual_posts_a_key_signed_buyback_from_svc_trade() {
    for recipe in BUYBACK {
        let Some(db) = migrated() else { return };
        let k = kit(&db, Some(Mode::Dual), &["svc-trade"]);
        buyback_book(&k, "bind", recipe);
        let body = buyback_body("bind", recipe);
        booked(k.keyed("svc-trade", "/trpc/post", &body));
        assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1, "{recipe}");
    }
}

#[test]
fn key_required_dual_still_only_counts_a_shared_secret_post_of_an_unrelated_recipe() {
    let Some(db) = migrated() else { return };
    let k = kit(&db, Some(Mode::Dual), &["svc-trade"]);
    k.engine(&fx(&["callerBinding", "funded"]));
    let body = fx(&["callerBinding", "orderHold"]);
    booked(k.shared("svc-trade", "/trpc/post", &body));
    assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1);
    assert_eq!(counts(&k), [("unbound", "svc-trade".to_owned(), 1)]);
}

#[test]
fn key_required_with_keys_off_a_shared_secret_buyback_is_only_counted_as_every_recipe_is() {
    for recipe in BUYBACK {
        let Some(db) = migrated() else { return };
        let k = kit(&db, None, &[]);
        buyback_book(&k, "bind", recipe);
        let body = buyback_body("bind", recipe);
        booked(k.shared("svc-trade", "/trpc/post", &body));
        assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1, "{recipe}");
        assert_eq!(
            counts(&k),
            [("unbound", "svc-trade".to_owned(), 1)],
            "{recipe}"
        );
    }
}

// ── the staff hold grant ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn staff_hold_on_its_own_key_a_staff_hold_posts_its_key_reads_back_a_deposit_is_refused_and_balance_and_history_refuse_it()
 {
    let Some(db) = migrated() else { return };
    let k = kit(&db, Some(Mode::Keypair), &["svc-ops"]);
    k.engine(&fx(&["staffHold", "funded"]));
    let place = fx(&["staffHold", "place"]);
    let posted = booked(k.keyed("svc-ops", "/trpc/post", &place));
    assert_eq!(s(&place, "idempotencyKey"), "ops:hold:7");
    assert_eq!(k.tx("ops:hold:7").unwrap().0, s(&posted, "txId"));

    let read = booked(k.keyed(
        "svc-ops",
        "/trpc/txByKey",
        &Json::obj([("idempotencyKey", Json::str("ops:hold:7"))]),
    ));
    assert!(
        read.compact().contains(&s(&posted, "txId")),
        "{}",
        read.compact()
    );

    let before = total(&k);
    let deposit = fx(&["staffHold", "deposit"]);
    refused(
        k.keyed("svc-ops", "/trpc/post", &deposit),
        403,
        CALLER_FORBIDDEN,
    );
    assert!(k.tx(&s(&deposit, "idempotencyKey")).is_none());
    assert_eq!(total(&k), before);

    for door in ["balance", "balances", "history", "historyPage"] {
        refused(
            k.keyed(
                "svc-ops",
                &format!("/trpc/{door}"),
                &fx(&["staffHold", "read"]),
            ),
            403,
            CALLER_FORBIDDEN,
        );
    }
    assert_eq!(total(&k), before);
}

// ── POST /trpc/post caller binding ───────────────────────────────────────────────────────────────────────────────

const CALLERS: [&str; 5] = ["svc-trade", "svc-pay", "svc-agents", "svc-bank", "svc-edge"];

/// The test's `kit()` and `mount({ mode })`, over a book where the customer has the funds its bodies move.
fn bound(mode: Option<Mode>) -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = kit(&db, mode, &CALLERS);
    k.engine(&fx(&["callerBinding", "funded"]));
    Some((db, k))
}

fn cb(name: &str) -> Json {
    fx(&["callerBinding", name])
}

#[test]
fn binding_posts_an_allowed_pair_signed_by_that_services_own_key_and_refuses_another_service_in_both_modes()
 {
    for mode in [Mode::Dual, Mode::Keypair] {
        let Some((_db, k)) = bound(Some(mode)) else {
            return;
        };
        let body = cb("orderHold");
        booked(k.keyed("svc-trade", "/trpc/post", &body));
        assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1);
        assert!(counts(&k).is_empty(), "{mode:?}: {:?}", counts(&k));

        let Some((_db, k)) = bound(Some(mode)) else {
            return;
        };
        refused(
            k.keyed("svc-pay", "/trpc/post", &body),
            403,
            CALLER_FORBIDDEN,
        );
        assert!(k.tx(&s(&body, "idempotencyKey")).is_none(), "{mode:?}");
    }
}

#[test]
fn binding_refuses_a_spoofed_module_on_a_body_the_caller_is_otherwise_allowed_to_shape() {
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    let body = cb("feeChargeTrade");
    let err = refused(
        k.keyed("svc-agents", "/trpc/post", &body),
        403,
        CALLER_FORBIDDEN,
    );
    assert!(
        s(&err, "message").contains("module trade"),
        "{}",
        err.compact()
    );
    assert!(k.tx(&s(&body, "idempotencyKey")).is_none());
}

#[test]
fn binding_posts_the_same_fee_when_the_module_is_the_one_svc_agents_actually_sends() {
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    let body = cb("feeChargeAgents");
    let tx = booked(k.keyed("svc-agents", "/trpc/post", &body));
    assert_eq!(k.tx(&s(&body, "idempotencyKey")).unwrap().0, s(&tx, "txId"));
}

#[test]
fn binding_counts_and_logs_an_off_list_key_signed_post_and_refuses_it_in_dual_mode_too() {
    let Some((_db, k)) = bound(Some(Mode::Dual)) else {
        return;
    };
    let body = cb("orderHold");
    refused(
        k.keyed("svc-pay", "/trpc/post", &body),
        403,
        CALLER_FORBIDDEN,
    );
    assert!(k.tx(&s(&body, "idempotencyKey")).is_none());
    // Reported once, counted once, and the warning logged.
    assert_eq!(
        counts(&k).iter().map(|c| c.2).sum::<u64>(),
        1,
        "{:?}",
        counts(&k)
    );
    assert_eq!(warnings(&k), 1, "{}", k.log.text());
}

#[test]
fn binding_keypair_refuses_the_shared_secret_before_anything_is_judged() {
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    let body = cb("orderHold");
    refused(
        k.shared("svc-trade", "/trpc/post", &body),
        401,
        UNAUTHENTICATED,
    );
    assert!(k.tx(&s(&body, "idempotencyKey")).is_none());
    assert!(counts(&k).is_empty(), "{:?}", counts(&k));
}

#[test]
fn binding_dual_still_posts_a_shared_secret_call_for_an_allowed_claim_and_counts_it_as_unbound() {
    let Some((_db, k)) = bound(Some(Mode::Dual)) else {
        return;
    };
    let body = cb("orderHold");
    booked(k.shared("svc-trade", "/trpc/post", &body));
    assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1);
    assert_eq!(counts(&k), [("unbound", "svc-trade".to_owned(), 1)]);
}

#[test]
fn binding_warns_once_and_counts_three_legacy_posts_from_the_same_claimed_service() {
    let Some((_db, k)) = bound(Some(Mode::Dual)) else {
        return;
    };
    let body = cb("orderHold");
    for _ in 0..3 {
        booked(k.shared("svc-trade", "/trpc/post", &body));
    }
    assert_eq!(warnings(&k), 1, "{}", k.log.text());
    assert_eq!(counts(&k), [("unbound", "svc-trade".to_owned(), 3)]);
    assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1);
}

#[test]
fn binding_does_not_fall_back_to_the_shared_secret_when_a_key_signed_call_fails() {
    let Some((_db, k)) = bound(Some(Mode::Dual)) else {
        return;
    };
    let body = cb("orderHold");
    let text = body.compact();
    let mut headers = k.keyed_headers("svc-trade", "/trpc/post", &text, "svc-bank");
    headers.extend(legacy_headers("svc-trade", SECRET, &text, system_seconds()).unwrap());
    let (status, res) = k.send_with("/trpc/post", &text, &headers);
    assert_eq!(status, 401, "{}", res.compact());
    assert!(k.tx(&s(&body, "idempotencyKey")).is_none());
}

#[test]
fn binding_refuses_a_replay_of_the_same_signed_post() {
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    let body = cb("orderHold");
    let text = body.compact();
    let headers = k.keyed_headers("svc-trade", "/trpc/post", &text, "svc-ledger");
    booked(k.send_with("/trpc/post", &text, &headers));
    refused(
        k.send_with("/trpc/post", &text, &headers),
        401,
        UNAUTHENTICATED,
    );
    assert_eq!(k.rows(&s(&body, "idempotencyKey")), 1);
}

#[test]
fn binding_refuses_a_call_signed_for_another_audience() {
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    let body = cb("orderHold");
    let text = body.compact();
    let headers = k.keyed_headers("svc-trade", "/trpc/post", &text, "svc-bank");
    let (status, res) = k.send_with("/trpc/post", &text, &headers);
    assert_eq!(status, 401, "{}", res.compact());
    assert!(k.tx(&s(&body, "idempotencyKey")).is_none());
}

#[test]
fn binding_posts_an_interest_only_loan_repayment_from_svc_bank_and_refuses_it_from_svc_pay() {
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    let body = cb("interestOnlyRepay");
    let tx = booked(k.keyed("svc-bank", "/trpc/post", &body));
    let before = total(&k);
    refused(
        k.keyed("svc-pay", "/trpc/post", &body),
        403,
        CALLER_FORBIDDEN,
    );
    assert_eq!(total(&k), before);
    assert_eq!(k.tx(&s(&body, "idempotencyKey")).unwrap().0, s(&tx, "txId"));

    // And from svc-pay on a book where it was never booked: refused, nothing booked.
    let Some((_db, k)) = bound(Some(Mode::Keypair)) else {
        return;
    };
    refused(
        k.keyed("svc-pay", "/trpc/post", &body),
        403,
        CALLER_FORBIDDEN,
    );
    assert!(k.tx(&s(&body, "idempotencyKey")).is_none());
}
