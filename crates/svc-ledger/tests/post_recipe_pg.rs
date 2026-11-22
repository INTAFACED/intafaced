//! `/trpc/postRecipe` on a real Postgres, through the Rust door, each case in its own throwaway database (`support`).
//! Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The door runs as the TypeScript tests mount it: per-service keys in `keypair` mode, the body bound, `svc-academy`'s
//! own key, the conflict mode `refuse`, and the custody layer off (as at launch). Case for case:
//! - `post-recipe-door.pg.test.ts`, all 8 cases (`pg_*`), which ran on the Rust binary only through
//!   `tests/conformance` (project `post-recipe-pg`);
//! - `post-recipe-door.test.ts`, its booking cases (`books_*`: under its key, a retry, a different body's 409, a refund
//!   over revenue, the refund after the purchase), there over an in-memory book and here over the real one, and its
//!   property "postRecipe books exactly what post(recipes[name](input)) books" (`property_*`), its runs the ones
//!   fast-check draws for the test's own seed (3343, 60 runs), recorded with the post `recipes[name](input)` builds.
//!   Its who-may-call and body refusals are `post_recipe_parity.rs` and `wire_replay.rs`.
//!
//! The calls and posts are the TypeScript's own, recorded by `scripts/record-door-books.mjs`.
//!
//! svc-bank's recipes (`bank_*`), under svc-bank's own key: one of each booked on the real book with the custody layer
//! on (each moves a customer's balance), a retry booking nothing twice, the custody layer off refusing them, and a
//! service other than svc-bank refused before anything is read. Their bodies are `post_recipe_parity.rs`'s. Its earn
//! recipes (`bank_earn_*`): a pool funded from the bank's fee revenue, a position opened, a day's interest paid once (a
//! retry the same transaction, a different payout list 409, a day the reserve cannot cover refused), the position
//! closed; the recipe's refusals (a day the calendar lacks, no payouts, a zero payout, a zero amount) before the book;
//! with the layer off the pool still funded and every customer move refused 412; another service refused 403.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::s2s::Mode;
use support::TestDb;
use support::door::{Kit, Setup, fx, fx_list, migrated};
use svc_ledger::errors::{
    CALLER_FORBIDDEN, CUSTODY_LAYER_OFF, FROZEN, IDEMPOTENCY_CONFLICT, INSUFFICIENT_FUNDS,
    POST_RECIPE_INPUT_INVALID,
};
use svc_ledger::freeze;

const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
const CHECKER: &str = "22222222-2222-4222-8222-222222222222";

fn key() -> String {
    format!("academy:purchase:perps-101:{USER}:1")
}

fn refund_key() -> String {
    format!("academy:refund:perps-101:{USER}:1")
}

fn s(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(t)) => t.clone(),
        other => panic!("{k}: {other:?} in {}", v.compact()),
    }
}

fn list(v: &Json, k: &str) -> Vec<Json> {
    match v.get(k) {
        Some(Json::Array(items)) => items.clone(),
        other => panic!("{k}: {other:?} in {}", v.compact()),
    }
}

fn code(v: &Json) -> Option<String> {
    match v.get("code") {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    }
}

fn pr(name: &str) -> Json {
    fx(&["postRecipe", name])
}

/// The door as the tests mount it (above), over a fresh book.
fn door() -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = Kit::new(
        &db,
        &Setup {
            mode: Some(Mode::Keypair),
            services: &["svc-academy"],
            custody_on: false,
        },
    );
    Some((db, k))
}

/// `poster().postRecipe(call)`: signed by svc-academy's key, a fresh signature each attempt.
fn post_recipe(k: &Kit, call: &Json) -> (u16, Json) {
    k.keyed("svc-academy", "/trpc/postRecipe", call)
}

fn booked((status, body): (u16, Json)) -> Json {
    assert_eq!(status, 200, "{}", body.compact());
    body
}

/// `[direction, amount]` of each booked entry.
fn legs(reply: &Json) -> Vec<(String, String)> {
    list(reply, "entries")
        .iter()
        .map(|e| (s(e, "direction"), s(e, "amount")))
        .collect()
}

/// `ledger.balance(houseFees('academy', 'USDC')).amount`.
fn revenue(k: &Kit) -> String {
    k.bal(&pr("revenue"))
}

// ── post-recipe-door.pg.test.ts ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn pg_books_the_purchase_once_with_custody_off_under_the_business_key_the_receipt_is_the_booked_entries()
 {
    let Some((_db, k)) = door() else { return };
    let tx = booked(post_recipe(&k, &pr("purchase")));
    assert_eq!(s(&tx, "idempotencyKey"), key());
    assert_eq!(s(&tx, "module"), "academy");
    assert_eq!(
        legs(&tx),
        [
            ("debit".to_owned(), "2.5".to_owned()),
            ("credit".to_owned(), "2.5".to_owned())
        ]
    );
    assert_eq!(k.rows(&key()), 1);
    assert_eq!(k.tx(&key()).unwrap().0, s(&tx, "txId"));
}

#[test]
fn pg_crash_after_the_ledger_committed_but_before_the_caller_heard_the_retry_is_the_same_key_and_books_nothing_twice()
 {
    let Some((_db, k)) = door() else { return };
    // The first attempt commits and its answer is lost on the way back; the client retries the same bytes, signed anew.
    let lost = booked(post_recipe(&k, &pr("purchase")));
    let tx = booked(post_recipe(&k, &pr("purchase")));
    assert_eq!(s(&tx, "txId"), s(&lost, "txId"));
    assert_eq!(k.rows(&key()), 1);
    assert_eq!(k.tx(&key()).unwrap().0, s(&tx, "txId"));
    // And the caller asking again later (a restart) still gets the same transaction.
    assert_eq!(
        s(&booked(post_recipe(&k, &pr("purchase"))), "txId"),
        s(&tx, "txId")
    );
    assert_eq!(k.rows(&key()), 1);
    assert_eq!(revenue(&k), "2.5");
}

#[test]
fn pg_post_recipe_and_post_land_on_the_same_key_one_booking_whichever_door_the_retry_takes() {
    let Some((_db, k)) = door() else { return };
    let tx = booked(post_recipe(&k, &pr("purchase")));
    let via_post = booked(k.keyed("svc-academy", "/trpc/post", &pr("viaPost")));
    assert_eq!(s(&via_post, "txId"), s(&tx, "txId"));
    let triple = |r: &Json| {
        list(r, "entries")
            .iter()
            .map(|e| (s(e, "accountId"), s(e, "direction"), s(e, "amount")))
            .collect::<Vec<_>>()
    };
    assert_eq!(triple(&via_post), triple(&tx));
    assert_eq!(s(&pr("viaPost"), "idempotencyKey"), key());
    assert_eq!(k.rows(&key()), 1);
}

#[test]
fn pg_the_same_key_with_a_different_body_is_refused_409_idempotency_conflict_the_first_booking_stands()
 {
    let Some((_db, k)) = door() else { return };
    let tx = booked(post_recipe(&k, &pr("purchase")));
    let (status, err) = post_recipe(&k, &pr("purchaseOther"));
    assert_eq!(code(&err).as_deref(), Some(IDEMPOTENCY_CONFLICT));
    // Never read as a refusal: `classifyPostOutcome` reads a 409 as 'unknown' (the key is taken).
    assert_eq!(status, 409);
    assert_eq!(k.rows(&key()), 1);
    assert_eq!(k.tx(&key()).unwrap().0, s(&tx, "txId"));
    assert_eq!(revenue(&k), "2.5");
}

#[test]
fn pg_frozen_refused_412_a_definite_refusal_nothing_booked_after_the_thaw_the_same_call_books_once()
{
    let Some((_db, k)) = door() else { return };
    freeze::write(
        &k.store,
        freeze::Command::Freeze {
            reason: "postRecipe freeze test",
            actor: OPERATOR,
        },
    )
    .unwrap();
    let (status, err) = post_recipe(&k, &pr("purchase"));
    assert_eq!(code(&err).as_deref(), Some(FROZEN));
    // `classifyPostOutcome` reads a 412 as 'refused'.
    assert_eq!(status, 412);
    assert_eq!(k.rows(&key()), 0);

    freeze::write(
        &k.store,
        freeze::Command::Thaw {
            actor: OPERATOR,
            confirm_operator_id: Some(CHECKER),
        },
    )
    .unwrap();
    let tx = booked(post_recipe(&k, &pr("purchase")));
    assert_eq!(s(&tx, "idempotencyKey"), key());
    assert_eq!(k.rows(&key()), 1);
}

#[test]
fn pg_frozen_after_it_booked_the_retry_of_a_committed_post_still_answers_the_original_transaction()
{
    let Some((_db, k)) = door() else { return };
    let tx = booked(post_recipe(&k, &pr("purchase")));
    freeze::write(
        &k.store,
        freeze::Command::Freeze {
            reason: "postRecipe freeze after commit",
            actor: OPERATOR,
        },
    )
    .unwrap();
    assert_eq!(
        s(&booked(post_recipe(&k, &pr("purchase"))), "txId"),
        s(&tx, "txId")
    );
    assert_eq!(k.rows(&key()), 1);
}

#[test]
fn pg_the_refund_reverses_the_purchase_on_the_book_and_cannot_be_booked_twice() {
    let Some((_db, k)) = door() else { return };
    booked(post_recipe(&k, &pr("purchase")));
    let tx = booked(post_recipe(&k, &pr("refund")));
    assert_eq!(s(&tx, "idempotencyKey"), refund_key());
    assert_eq!(
        s(&booked(post_recipe(&k, &pr("refund"))), "txId"),
        s(&tx, "txId")
    );
    assert_eq!(revenue(&k), "0");
}

#[test]
fn pg_a_body_the_door_refuses_never_reaches_the_book_sent_raw_over_the_port() {
    let Some((_db, k)) = door() else { return };
    let (status, err) = post_recipe(&k, &pr("purchaseNumber"));
    assert_eq!(status, 400);
    assert_eq!(code(&err).as_deref(), Some(POST_RECIPE_INPUT_INVALID));
    assert_eq!(k.rows(&key()), 0);
}

// ── post-recipe-door.test.ts: what it books ──────────────────────────────────────────────────────────────────────

#[test]
fn books_the_purchase_under_its_business_key_and_answers_the_booked_entries_as_decimal_strings() {
    let Some((_db, k)) = door() else { return };
    // The door itself checks its reply against the record's output (`postRecipeReply`) before it answers.
    let reply = booked(post_recipe(&k, &pr("purchase")));
    assert_eq!(s(&reply, "idempotencyKey"), key());
    assert_eq!(s(&reply, "module"), "academy");
    assert_eq!(s(&reply, "reason"), "academy.purchase.posted");
    assert_eq!(
        legs(&reply),
        [
            ("debit".to_owned(), "2.5".to_owned()),
            ("credit".to_owned(), "2.5".to_owned())
        ]
    );
    assert_eq!(
        k.tx(&s(&reply, "idempotencyKey")).unwrap().0,
        s(&reply, "txId")
    );
}

#[test]
fn books_a_retry_of_the_same_call_the_first_answer_was_lost_returns_the_same_transaction_and_books_nothing_twice()
 {
    let Some((_db, k)) = door() else { return };
    let first = booked(post_recipe(&k, &pr("purchase")));
    let again = booked(post_recipe(&k, &pr("purchase")));
    assert_eq!(s(&again, "txId"), s(&first, "txId"));
    assert_eq!(s(&again, "hash"), s(&first, "hash"));
    // Both calls reached the book under the one key, which holds one transaction.
    assert_eq!(k.rows(&s(&first, "idempotencyKey")), 1);
    assert_eq!(revenue(&k), "2.5");
}

#[test]
fn books_the_same_key_with_a_different_body_is_refused_409_and_the_first_booking_stands() {
    let Some((_db, k)) = door() else { return };
    let first = booked(post_recipe(&k, &pr("purchase")));
    let (status, other) = post_recipe(&k, &pr("purchaseOther"));
    assert_eq!(status, 409);
    assert_eq!(code(&other).as_deref(), Some(IDEMPOTENCY_CONFLICT));
    assert_eq!(
        k.tx(&s(&first, "idempotencyKey")).unwrap().0,
        s(&first, "txId")
    );
    assert_eq!(revenue(&k), "2.5");
}

#[test]
fn books_a_refund_above_the_revenue_on_the_book_is_refused_by_the_ledger_400_insufficient_funds_nothing_booked()
 {
    let Some((_db, k)) = door() else { return };
    let (status, res) = post_recipe(&k, &pr("refund"));
    assert_eq!(status, 400, "{}", res.compact());
    assert_eq!(code(&res).as_deref(), Some(INSUFFICIENT_FUNDS));
    assert!(k.tx(&refund_key()).is_none());
}

#[test]
fn books_the_refund_after_the_purchase_revenue_back_to_zero_the_wallet_back_to_zero() {
    let Some((_db, k)) = door() else { return };
    booked(post_recipe(&k, &pr("purchase")));
    let res = booked(post_recipe(&k, &pr("refund")));
    assert_eq!(s(&res, "idempotencyKey"), refund_key());
    assert_eq!(s(&res, "reason"), "academy.purchase.refunded");
    assert_eq!(revenue(&k), "0");
}

// ── post-recipe-door.test.ts: the property ───────────────────────────────────────────────────────────────────────

/// What a book holds under a key, with the per-book ids taken out (the test's `shape`).
fn shape(k: &Kit, key: &str) -> Option<String> {
    let (_, meta) = k.tx(key)?;
    let mut c = postgres::Client::connect(&k_url(k), postgres::NoTls).unwrap();
    let head = c
        .query_one(
            "SELECT module, reason FROM ledger.ledger_tx WHERE idempotency_key = $1",
            &[&key],
        )
        .unwrap();
    let entries: Vec<String> = c
        .query(
            "SELECT e.asset_id, e.direction::text, e.amount::text, e.balance_after::text
               FROM ledger.ledger_entries e JOIN ledger.ledger_tx t ON t.id = e.tx_id
              WHERE t.idempotency_key = $1 ORDER BY e.id",
            &[&key],
        )
        .unwrap()
        .iter()
        .map(|r| {
            let n = |i: usize| format_amount(parse_amount(&r.get::<_, String>(i)).unwrap());
            format!(
                "{} {} {} {}",
                r.get::<_, String>(0),
                r.get::<_, String>(1),
                n(2),
                n(3)
            )
        })
        .collect();
    Some(format!(
        "{key} {} {} {} [{}]",
        head.get::<_, String>(0),
        head.get::<_, String>(1),
        meta.compact(),
        entries.join(", ")
    ))
}

fn k_url(k: &Kit) -> String {
    k.url()
}

/// A reply's `[assetId, direction, amount, balanceAfter]` per entry (the test's `strip`).
fn strip(reply: &Json) -> Vec<[String; 4]> {
    list(reply, "entries")
        .iter()
        .map(|e| {
            [
                s(e, "assetId"),
                s(e, "direction"),
                s(e, "amount"),
                s(e, "balanceAfter"),
            ]
        })
        .collect()
}

/// One run: its purchase and refund through `postRecipe` on one book, and the posts `recipes[name](input)` builds
/// through `post` on another; whether the purchase booked.
fn run(n: usize, call: &Json) -> bool {
    let (Some((_a, via_recipe)), Some((_b, via_post))) = (door(), door()) else {
        panic!("run {n}: no book")
    };
    let get = |k: &str| call.get(k).unwrap().clone();
    let a1 = post_recipe(&via_recipe, &get("purchase"));
    let a2 = post_recipe(&via_recipe, &get("refund"));
    let (p1, p2) = (get("purchasePost"), get("refundPost"));
    let b1 = via_post.keyed("svc-academy", "/trpc/post", &p1);
    let b2 = via_post.keyed("svc-academy", "/trpc/post", &p2);
    // The same answer on both doors, refusals included (a purchase into a partner reserve is refused by the book on
    // both: a reserve never shows less than nothing of ours).
    assert_eq!(
        [a1.0, a2.0],
        [b1.0, b2.0],
        "run {n}: {} / {}",
        a1.1.compact(),
        b1.1.compact()
    );
    assert_eq!(
        [code(&a1.1), code(&a2.1)],
        [code(&b1.1), code(&b2.1)],
        "run {n}"
    );
    for p in [&p1, &p2] {
        let key = s(p, "idempotencyKey");
        assert_eq!(
            shape(&via_recipe, &key),
            shape(&via_post, &key),
            "run {n}: {key}"
        );
    }
    if a1.0 != 200 {
        return false;
    }
    assert_eq!(
        s(&a1.1, "idempotencyKey"),
        s(&p1, "idempotencyKey"),
        "run {n}"
    );
    assert_eq!(a2.0, 200, "run {n}: {}", a2.1.compact());
    assert_eq!(
        s(&a2.1, "idempotencyKey"),
        s(&p2, "idempotencyKey"),
        "run {n}"
    );
    // Same reply on both doors, ids aside.
    assert_eq!(strip(&a1.1), strip(&b1.1), "run {n}");
    assert_eq!(strip(&a2.1), strip(&b2.1), "run {n}");
    assert_eq!(
        s(&list(&a1.1, "entries")[0], "amount"),
        s(call, "amount"),
        "run {n}"
    );
    true
}

#[test]
fn property_for_random_valid_purchases_and_their_refunds_the_two_doors_leave_the_same_book() {
    if support::admin_url().is_none() {
        return;
    }
    let calls = fx_list(&["property"]);
    assert_eq!(calls.len(), 60, "the test's own 60 runs");
    let workers = std::env::var("INTAFACED_LOCAL_JOBS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(4)
        .clamp(1, 8);
    let booked: usize = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let calls = &calls;
                scope.spawn(move || {
                    calls
                        .iter()
                        .enumerate()
                        .filter(|(n, _)| n % workers == w)
                        .filter(|(n, c)| run(*n, c))
                        .count()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).sum()
    });
    // Most runs book (a treasury wallet may go below zero): the property is not only refusals agreeing.
    assert!(booked > 20, "only {booked} of 60 runs booked");
    println!("postRecipe property: 60 runs, {booked} booked on both doors");
}

// ── svc-bank's recipes ───────────────────────────────────────────────────────────────────────────────────────────

const PAYER: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PAYEE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRANSFER: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HOLD: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SECOND_HOLD: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

fn account(owner_id: &str, kind: &str, purpose: Option<&str>) -> Json {
    let mut fields = vec![
        ("ownerType", Json::str("user")),
        ("ownerId", Json::str(owner_id)),
        ("assetId", Json::str("USDC")),
        ("kind", Json::str(kind)),
    ];
    if let Some(p) = purpose {
        fields.push(("purpose", Json::str(p)));
    }
    Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn available(owner_id: &str) -> Json {
    account(owner_id, "available", None)
}

fn pot(owner_id: &str, hold_id: &str) -> Json {
    account(owner_id, "hold", Some(&format!("pay:recv:{hold_id}")))
}

fn call(recipe: &str, input: Json) -> Json {
    Json::obj([("recipe", Json::str(recipe)), ("input", input)])
}

/// svc-bank's p2p transfer of 12.5 USDC from PAYER to PAYEE.
fn transfer() -> Json {
    call(
        "bankTransfer",
        Json::obj([
            ("transferId", Json::str(TRANSFER)),
            ("occurrence", Json::int(0)),
            ("from", available(PAYER)),
            ("to", available(PAYEE)),
            ("amount", Json::str("12.5")),
            ("kind", Json::str("manual")),
            ("keySpace", Json::str("p2p")),
        ]),
    )
}

/// A hold, release or return of 12.5 USDC PAYEE received (`extra` adds the outcome's own fields).
fn received(recipe: &str, hold_id: &str, extra: &[(&str, Json)]) -> Json {
    let mut fields = vec![
        ("holdId", Json::str(hold_id)),
        ("userId", Json::str(PAYEE)),
        ("assetId", Json::str("USDC")),
        ("amount", Json::str("12.5")),
    ];
    fields.extend(extra.iter().cloned());
    call(
        recipe,
        Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
    )
}

/// The door with svc-bank's and svc-academy's keys, over a book where PAYER holds 100 USDC.
fn bank_door(custody_on: bool) -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = Kit::new(
        &db,
        &Setup {
            mode: Some(Mode::Keypair),
            services: &["svc-bank", "svc-academy"],
            custody_on,
        },
    );
    if custody_on {
        k.engine(&Json::obj([
            ("idempotencyKey", Json::str("deposit:test:post-recipe-bank")),
            ("module", Json::str("ledger")),
            ("reason", Json::str("deposit")),
            (
                "entries",
                Json::Array(vec![
                    Json::obj([
                        (
                            "account",
                            Json::obj([
                                ("ownerType", Json::str("treasury")),
                                ("ownerId", Json::str("rail:crypto-native")),
                                ("assetId", Json::str("USDC")),
                                ("kind", Json::str("available")),
                            ]),
                        ),
                        ("direction", Json::str("credit")),
                        ("amount", Json::str("100")),
                    ]),
                    Json::obj([
                        ("account", available(PAYER)),
                        ("direction", Json::str("debit")),
                        ("amount", Json::str("100")),
                    ]),
                ]),
            ),
        ]));
    }
    Some((db, k))
}

fn bank(k: &Kit, body: &Json) -> (u16, Json) {
    k.keyed("svc-bank", "/trpc/postRecipe", body)
}

#[test]
fn bank_books_one_of_each_recipe_once_under_its_business_key_and_the_balances_move_as_the_recipes_say()
 {
    let Some((_db, k)) = bank_door(true) else {
        return;
    };
    let key = format!("bank.transfer.p2p:{TRANSFER}:0");
    let tx = booked(bank(&k, &transfer()));
    assert_eq!(s(&tx, "idempotencyKey"), key);
    assert_eq!(s(&tx, "module"), "bank");
    assert_eq!(s(&tx, "reason"), "bank.transfer.manual");
    assert_eq!(
        legs(&tx),
        [
            ("credit".to_owned(), "12.5".to_owned()),
            ("debit".to_owned(), "12.5".to_owned())
        ]
    );
    // A retry after a lost reply is the same key and body: the same transaction, nothing booked twice.
    assert_eq!(s(&booked(bank(&k, &transfer())), "txId"), s(&tx, "txId"));
    assert_eq!(k.rows(&key), 1);
    assert_eq!(k.bal(&available(PAYER)), "87.5");
    assert_eq!(k.bal(&available(PAYEE)), "12.5");

    // Held, then released whole: the pot fills and empties, the recipient's available comes back.
    let held = booked(bank(&k, &received("payReceivedHold", HOLD, &[])));
    assert_eq!(s(&held, "idempotencyKey"), format!("pay.recv.hold:{HOLD}"));
    assert_eq!(k.bal(&available(PAYEE)), "0");
    assert_eq!(k.bal(&pot(PAYEE, HOLD)), "12.5");
    let whole = [("heldAmount", Json::str("12.5"))];
    let released = booked(bank(&k, &received("payReceivedRelease", HOLD, &whole)));
    assert_eq!(
        s(&released, "idempotencyKey"),
        format!("pay.recv.release:{HOLD}")
    );
    assert_eq!(k.bal(&pot(PAYEE, HOLD)), "0");
    assert_eq!(k.bal(&available(PAYEE)), "12.5");
    // One outcome per hold: a return after the release finds the pot empty.
    let returned = [
        ("heldAmount", Json::str("12.5")),
        ("payerUserId", Json::str(PAYER)),
    ];
    let (status, refused) = bank(&k, &received("payReceivedReturn", HOLD, &returned));
    assert_eq!(
        (status, code(&refused).as_deref()),
        (400, Some(INSUFFICIENT_FUNDS))
    );
    assert_eq!(k.rows(&format!("pay.recv.return:{HOLD}")), 0);

    // A second hold, returned to the payer by a ruling.
    booked(bank(&k, &received("payReceivedHold", SECOND_HOLD, &[])));
    let back = booked(bank(
        &k,
        &received("payReceivedReturn", SECOND_HOLD, &returned),
    ));
    assert_eq!(
        s(&back, "idempotencyKey"),
        format!("pay.recv.return:{SECOND_HOLD}")
    );
    assert_eq!(k.bal(&pot(PAYEE, SECOND_HOLD)), "0");
    assert_eq!(k.bal(&available(PAYEE)), "0");
    assert_eq!(k.bal(&available(PAYER)), "100");
}

#[test]
fn bank_a_partial_release_is_refused_before_the_book_and_nothing_is_booked() {
    let Some((_db, k)) = bank_door(true) else {
        return;
    };
    booked(bank(&k, &transfer()));
    booked(bank(&k, &received("payReceivedHold", HOLD, &[])));
    let part = received(
        "payReceivedRelease",
        HOLD,
        &[("heldAmount", Json::str("20"))],
    );
    let (status, refused) = bank(&k, &part);
    assert_eq!(
        (status, code(&refused).as_deref()),
        (400, Some(POST_RECIPE_INPUT_INVALID))
    );
    assert_eq!(k.rows(&format!("pay.recv.release:{HOLD}")), 0);
    assert_eq!(k.bal(&pot(PAYEE, HOLD)), "12.5");
}

#[test]
fn bank_with_the_custody_layer_off_a_transfer_between_customers_is_refused_412_and_nothing_is_booked()
 {
    let Some((_db, k)) = bank_door(false) else {
        return;
    };
    let (status, refused) = bank(&k, &transfer());
    assert_eq!(
        (status, code(&refused).as_deref()),
        (412, Some(CUSTODY_LAYER_OFF))
    );
    assert_eq!(k.rows(&format!("bank.transfer.p2p:{TRANSFER}:0")), 0);
}

#[test]
fn bank_a_service_other_than_svc_bank_may_not_post_svc_banks_recipes_403_nothing_booked() {
    let Some((_db, k)) = bank_door(true) else {
        return;
    };
    for body in [transfer(), received("payReceivedHold", HOLD, &[])] {
        let (status, refused) = k.keyed("svc-academy", "/trpc/postRecipe", &body);
        assert_eq!(
            (status, code(&refused).as_deref()),
            (403, Some(CALLER_FORBIDDEN)),
            "{}",
            refused.compact()
        );
    }
    assert_eq!(k.rows(&format!("bank.transfer.p2p:{TRANSFER}:0")), 0);
    assert_eq!(k.rows(&format!("pay.recv.hold:{HOLD}")), 0);
    assert_eq!(k.bal(&available(PAYER)), "100");
}

// ── svc-bank's earn pools ────────────────────────────────────────────────────────────────────────────────────────

const POOL: &str = "99999999-9999-4999-8999-999999999999";
const POSITION: &str = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";

fn usdc(owner_type: &str, owner_id: &str) -> Json {
    Json::obj([
        ("ownerType", Json::str(owner_type)),
        ("ownerId", Json::str(owner_id)),
        ("assetId", Json::str("USDC")),
        ("kind", Json::str("available")),
    ])
}

/// `earnPoolReserve(POOL, 'USDC')`.
fn reserve() -> Json {
    usdc("module", &format!("bank:earn:{POOL}"))
}

/// `houseFees('bank', 'USDC')`.
fn bank_fees() -> Json {
    usdc("house", "fees:bank")
}

/// `earnStakeAccount(PAYER, 'USDC', POSITION)`.
fn stake() -> Json {
    account(PAYER, "stake", Some(&format!("bank:earn:{POSITION}")))
}

/// The bank's own fee revenue holds `amount` USDC (no customer balance moves, so it books with the layer off too).
fn seed_bank_fees(k: &Kit, amount: &str) {
    k.engine(&Json::obj([
        ("idempotencyKey", Json::str("deposit:test:bank-fees")),
        ("module", Json::str("ledger")),
        ("reason", Json::str("deposit")),
        (
            "entries",
            Json::Array(vec![
                Json::obj([
                    ("account", usdc("treasury", "rail:crypto-native")),
                    ("direction", Json::str("credit")),
                    ("amount", Json::str(amount)),
                ]),
                Json::obj([
                    ("account", bank_fees()),
                    ("direction", Json::str("debit")),
                    ("amount", Json::str(amount)),
                ]),
            ]),
        ),
    ]));
}

fn position(recipe: &str, amount: &str) -> Json {
    call(
        recipe,
        Json::obj([
            ("positionId", Json::str(POSITION)),
            ("poolId", Json::str(POOL)),
            ("userId", Json::str(PAYER)),
            ("assetId", Json::str("USDC")),
            ("amount", Json::str(amount)),
        ]),
    )
}

fn fund(funding_id: &str, amount: &str) -> Json {
    call(
        "earnPoolFund",
        Json::obj([
            ("poolId", Json::str(POOL)),
            ("fundingId", Json::str(funding_id)),
            ("assetId", Json::str("USDC")),
            ("amount", Json::str(amount)),
        ]),
    )
}

fn interest(date: &str, payouts: &[(&str, &str)]) -> Json {
    call(
        "earnInterest",
        Json::obj([
            ("poolId", Json::str(POOL)),
            ("date", Json::str(date)),
            ("assetId", Json::str("USDC")),
            (
                "payouts",
                Json::Array(
                    payouts
                        .iter()
                        .map(|(user, amount)| {
                            Json::obj([
                                ("userId", Json::str(*user)),
                                ("amount", Json::str(*amount)),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]),
    )
}

#[test]
fn bank_earn_funds_a_pool_opens_a_position_pays_a_day_and_closes_it_each_once_under_its_business_key()
 {
    let Some((_db, k)) = bank_door(true) else {
        return;
    };
    seed_bank_fees(&k, "10");

    // The pool's reserve is funded from the bank's own fee revenue; a retry is the same transaction.
    let fund_key = format!("bank.earn.fund:{POOL}:treasury-2026-11");
    let funded = booked(bank(&k, &fund("treasury-2026-11", "10")));
    assert_eq!(s(&funded, "idempotencyKey"), fund_key);
    assert_eq!(s(&funded, "reason"), "bank.earn.pool.funded");
    assert_eq!(
        s(&booked(bank(&k, &fund("treasury-2026-11", "10"))), "txId"),
        s(&funded, "txId")
    );
    assert_eq!(k.rows(&fund_key), 1);
    assert_eq!(k.bal(&bank_fees()), "0");
    assert_eq!(k.bal(&reserve()), "10");

    // A position: PAYER's available into PAYER's own stake pot for it.
    let deposit = booked(bank(&k, &position("earnDeposit", "40")));
    assert_eq!(
        s(&deposit, "idempotencyKey"),
        format!("bank.earn.deposit:{POSITION}")
    );
    assert_eq!(
        legs(&deposit),
        [
            ("credit".to_owned(), "40".to_owned()),
            ("debit".to_owned(), "40".to_owned())
        ]
    );
    assert_eq!(k.bal(&available(PAYER)), "60");
    assert_eq!(k.bal(&stake()), "40");

    // One day's interest for the pool: the reserve down by the total, each person up by theirs; once per pool and day.
    let day = interest("2026-11-22", &[(PAYER, "0.5"), (PAYEE, "0.25")]);
    let day_key = format!("bank.interest:{POOL}:2026-11-22");
    let paid = booked(bank(&k, &day));
    assert_eq!(s(&paid, "idempotencyKey"), day_key);
    assert_eq!(s(&paid, "reason"), "bank.earn.interest");
    assert_eq!(
        legs(&paid),
        [
            ("credit".to_owned(), "0.75".to_owned()),
            ("debit".to_owned(), "0.5".to_owned()),
            ("debit".to_owned(), "0.25".to_owned())
        ]
    );
    assert_eq!(s(&booked(bank(&k, &day)), "txId"), s(&paid, "txId"));
    assert_eq!(k.rows(&day_key), 1);
    // The same day paid differently is refused: the first accrual stands.
    let (status, refused) = bank(&k, &interest("2026-11-22", &[(PAYER, "1")]));
    assert_eq!(
        (status, code(&refused).as_deref()),
        (409, Some(IDEMPOTENCY_CONFLICT))
    );
    assert_eq!(k.bal(&reserve()), "9.25");
    assert_eq!(k.bal(&available(PAYER)), "60.5");
    assert_eq!(k.bal(&available(PAYEE)), "0.25");

    // A day the reserve cannot cover is refused by the book: interest is never minted.
    let (status, refused) = bank(&k, &interest("2026-11-23", &[(PAYER, "9.26")]));
    assert_eq!(
        (status, code(&refused).as_deref()),
        (400, Some(INSUFFICIENT_FUNDS))
    );
    assert_eq!(k.rows(&format!("bank.interest:{POOL}:2026-11-23")), 0);
    assert_eq!(k.bal(&reserve()), "9.25");

    // The position closes: the principal back to available, the pot empty.
    let withdraw = booked(bank(&k, &position("earnWithdraw", "40")));
    assert_eq!(
        s(&withdraw, "idempotencyKey"),
        format!("bank.earn.withdraw:{POSITION}")
    );
    assert_eq!(k.bal(&stake()), "0");
    assert_eq!(k.bal(&available(PAYER)), "100.5");
}

#[test]
fn bank_earn_inputs_the_recipe_refuses_are_refused_before_the_book_and_nothing_is_booked() {
    let Some((_db, k)) = bank_door(true) else {
        return;
    };
    seed_bank_fees(&k, "10");
    booked(bank(&k, &fund("treasury-2026-11", "10")));
    for (body, key) in [
        (
            interest("2026-02-31", &[(PAYER, "1")]),
            format!("bank.interest:{POOL}:2026-02-31"),
        ),
        (
            interest("2026-11-22", &[]),
            format!("bank.interest:{POOL}:2026-11-22"),
        ),
        (
            interest("2026-11-22", &[(PAYER, "1"), (PAYEE, "0")]),
            format!("bank.interest:{POOL}:2026-11-22"),
        ),
        (
            position("earnDeposit", "0"),
            format!("bank.earn.deposit:{POSITION}"),
        ),
        (
            fund("treasury-2026-12", "0"),
            format!("bank.earn.fund:{POOL}:treasury-2026-12"),
        ),
    ] {
        let (status, refused) = bank(&k, &body);
        assert_eq!(
            (status, code(&refused).as_deref()),
            (400, Some(POST_RECIPE_INPUT_INVALID)),
            "{}",
            body.compact()
        );
        assert_eq!(k.rows(&key), 0);
    }
    assert_eq!(k.bal(&reserve()), "10");
    assert_eq!(k.bal(&available(PAYER)), "100");
}

#[test]
fn bank_earn_with_the_custody_layer_off_a_pool_is_funded_but_no_customer_balance_moves_412() {
    let Some((_db, k)) = bank_door(false) else {
        return;
    };
    seed_bank_fees(&k, "10");
    // The bank's own money moving into its own reserve touches no customer: it books at launch.
    booked(bank(&k, &fund("treasury-2026-11", "10")));
    assert_eq!(k.bal(&reserve()), "10");
    for (body, key) in [
        (
            position("earnDeposit", "1"),
            format!("bank.earn.deposit:{POSITION}"),
        ),
        (
            interest("2026-11-22", &[(PAYER, "1")]),
            format!("bank.interest:{POOL}:2026-11-22"),
        ),
    ] {
        let (status, refused) = bank(&k, &body);
        assert_eq!(
            (status, code(&refused).as_deref()),
            (412, Some(CUSTODY_LAYER_OFF)),
            "{}",
            body.compact()
        );
        assert_eq!(k.rows(&key), 0);
    }
    assert_eq!(k.bal(&reserve()), "10");
}

#[test]
fn bank_earn_a_service_other_than_svc_bank_may_not_post_the_earn_recipes_403_nothing_booked() {
    let Some((_db, k)) = bank_door(true) else {
        return;
    };
    seed_bank_fees(&k, "10");
    for body in [
        fund("treasury-2026-11", "10"),
        position("earnDeposit", "1"),
        position("earnWithdraw", "1"),
        interest("2026-11-22", &[(PAYER, "1")]),
    ] {
        let (status, refused) = k.keyed("svc-academy", "/trpc/postRecipe", &body);
        assert_eq!(
            (status, code(&refused).as_deref()),
            (403, Some(CALLER_FORBIDDEN)),
            "{}",
            refused.compact()
        );
    }
    assert_eq!(
        k.rows(&format!("bank.earn.fund:{POOL}:treasury-2026-11")),
        0
    );
    assert_eq!(k.bal(&bank_fees()), "10");
    assert_eq!(k.bal(&available(PAYER)), "100");
}
