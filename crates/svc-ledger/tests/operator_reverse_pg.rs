//! `/trpc/operatorReverse` on a real Postgres, through the Rust door, each case in its own throwaway database
//! (`support`). Without a URL it skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The door runs with per-service keys in `keypair` mode, the body bound, the conflict mode `refuse` and the custody
//! layer off (as at launch). The original is booked by the engine itself over our own accounts (two rail boundaries, in
//! two assets), so the custody switch lets it and its reversal through. TEST amounts only.
//!
//! The cases (OPS-ledger-desk-02, J-ops-console-05 steps 1-3): one linked reversal posts and the pair nets to zero per
//! asset; a replay of the same key is the same transaction; a second ordinal is refused naming the first; an unknown
//! original is refused; a frozen ledger books nothing; a caller other than svc-ops is refused; the database refuses a
//! second reversal that skipped the door's check; two keys racing book once; `/trpc/post` refuses a hand-assembled
//! reversal; the desk's one-transaction read shows both links.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use service_kit::s2s::Mode;
use support::TestDb;
use support::door::{Kit, Setup, migrated};
use svc_ledger::desk::{self, Actor};
use svc_ledger::errors::{CALLER_FORBIDDEN, FROZEN};
use svc_ledger::freeze;
use svc_ledger::posting::{self, rules};
use svc_ledger::reversal::{self, ALREADY_REVERSED, TX_NOT_FOUND};

const SEED_KEY: &str = "test:operator-reverse:seed-1";
const UNKNOWN: &str = "99999999-9999-4999-8999-999999999999";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
const CHECKER: &str = "22222222-2222-4222-8222-222222222222";

fn door() -> Option<(TestDb, Kit)> {
    let db = migrated()?;
    let k = Kit::new(
        &db,
        &Setup {
            mode: Some(Mode::Keypair),
            services: &["svc-ops", "svc-bank"],
            custody_on: false,
        },
    );
    Some((db, k))
}

fn account(owner_type: &str, owner_id: &str, asset: &str) -> Json {
    Json::obj([
        ("ownerType", Json::str(owner_type)),
        ("ownerId", Json::str(owner_id)),
        ("assetId", Json::str(asset)),
        ("kind", Json::str("available")),
    ])
}

fn leg(account: Json, direction: &str, amount: &str) -> Json {
    Json::obj([
        ("account", account),
        ("direction", Json::str(direction)),
        ("amount", Json::str(amount)),
    ])
}

fn rail(asset: &str) -> Json {
    account("treasury", "rail:local-test", asset)
}

/// A second rail boundary. Treasury accounts may run negative, so nothing but the one-reversal rule stops a second
/// reversal of a transaction between two of them.
fn fees(asset: &str) -> Json {
    account("treasury", "rail:local-test-b", asset)
}

/// The original: TEST value in USDT and BTC moved from one rail boundary to the other. Its id.
fn seed(k: &Kit) -> String {
    k.engine(&Json::obj([
        ("idempotencyKey", Json::str(SEED_KEY)),
        ("module", Json::str("ledger")),
        ("reason", Json::str("test.seed")),
        (
            "entries",
            Json::Array(vec![
                leg(rail("USDT"), "credit", "10.5"),
                leg(fees("USDT"), "debit", "10.5"),
                leg(rail("BTC"), "credit", "0.000000000000000001"),
                leg(fees("BTC"), "debit", "0.000000000000000001"),
            ]),
        ),
    ]));
    k.tx(SEED_KEY).unwrap().0
}

fn call(original: &str, ordinal: &str) -> Json {
    Json::obj([
        ("originalTxId", Json::str(original)),
        ("ordinal", Json::str(ordinal)),
        ("reason", Json::str("LOCAL TEST booked to the wrong pot")),
        ("caseRef", Json::str("case-1")),
    ])
}

fn reverse(k: &Kit, caller: &str, original: &str, ordinal: &str) -> (u16, Json) {
    k.keyed(caller, "/trpc/operatorReverse", &call(original, ordinal))
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{key} is {other:?} in {}", j.compact()),
    }
}

fn key(original: &str, ordinal: &str) -> String {
    format!("ops:reversal:{original}:{ordinal}")
}

/// How many operator reversals the book holds.
fn reversals(k: &Kit) -> i64 {
    let mut c = postgres::Client::connect(&k.url(), postgres::NoTls).unwrap();
    c.query_one(
        "SELECT count(*) FROM ledger.ledger_tx WHERE module = 'ops' AND reason = 'operator.reversal'",
        &[],
    )
    .unwrap()
    .get(0)
}

#[test]
fn one_linked_reversal_posts_and_the_pair_nets_to_zero_per_asset() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    assert_eq!(k.bal(&fees("USDT")), "10.5");

    let (status, reply) = reverse(&k, "svc-ops", &original.to_uppercase(), "1");
    assert_eq!(status, 200, "{}", reply.compact());
    assert_eq!(s(&reply, "idempotencyKey"), key(&original, "1"));
    assert_eq!(s(&reply, "reverses"), original);
    let reversing = s(&reply, "txId");
    assert_ne!(reversing, original);
    assert!(s(&reply, "postedAt").ends_with('Z'));

    let (id, meta) = k.tx(&key(&original, "1")).unwrap();
    assert_eq!(id, reversing);
    assert_eq!(s(&meta, "reverses"), original);
    assert_eq!(s(&meta, "caseRef"), "case-1");
    assert_eq!(s(&meta, "why"), "LOCAL TEST booked to the wrong pot");

    // Per asset, and per account, the original and its reversal sum to zero; every balance is back where it was.
    let mut c = postgres::Client::connect(&k.url(), postgres::NoTls).unwrap();
    let nets: Vec<(String, String)> = c
        .query(
            "SELECT e.asset_id, sum(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END)::text
               FROM ledger.ledger_entries e
              WHERE e.tx_id IN ($1::text::uuid, $2::text::uuid)
              GROUP BY e.asset_id ORDER BY e.asset_id",
            &[&original, &reversing],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(nets.len(), 2, "{nets:?}");
    for (asset, net) in &nets {
        assert!(
            net.trim_start_matches('-')
                .chars()
                .all(|ch| ch == '0' || ch == '.'),
            "{asset} nets {net}"
        );
    }
    let legs: i64 = c
        .query_one(
            "SELECT count(*) FROM ledger.ledger_entries WHERE tx_id = $1::text::uuid",
            &[&reversing],
        )
        .unwrap()
        .get(0);
    assert_eq!(legs, 4);
    for asset in ["USDT", "BTC"] {
        assert_eq!(k.bal(&fees(asset)), "0", "{asset}");
        assert_eq!(k.bal(&rail(asset)), "0", "{asset}");
    }
}

#[test]
fn the_same_key_and_body_replays_the_first_booking_and_books_nothing_twice() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let (status, first) = reverse(&k, "svc-ops", &original, "3");
    assert_eq!(status, 200, "{}", first.compact());
    let (status, again) = reverse(&k, "svc-ops", &original, "3");
    assert_eq!(status, 200, "{}", again.compact());
    assert_eq!(again.compact(), first.compact());
    assert_eq!(k.rows(&key(&original, "3")), 1);
    assert_eq!(reversals(&k), 1);
    assert_eq!(k.bal(&fees("USDT")), "0");
}

#[test]
fn a_second_ordinal_is_refused_already_reversed_naming_the_first() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let (_, first) = reverse(&k, "svc-ops", &original, "1");
    let (status, refused) = reverse(&k, "svc-ops", &original, "2");
    assert_eq!(status, 409, "{}", refused.compact());
    assert_eq!(s(&refused, "code"), ALREADY_REVERSED);
    assert_eq!(s(&refused, "reversedBy"), s(&first, "txId"));
    assert_eq!(k.rows(&key(&original, "2")), 0);
    assert_eq!(reversals(&k), 1);
}

#[test]
fn an_unknown_original_is_refused_tx_not_found_and_nothing_is_booked() {
    let Some((_db, k)) = door() else { return };
    seed(&k);
    let (status, refused) = reverse(&k, "svc-ops", UNKNOWN, "1");
    assert_eq!(status, 404, "{}", refused.compact());
    assert_eq!(s(&refused, "code"), TX_NOT_FOUND);
    assert_eq!(reversals(&k), 0);
}

#[test]
fn a_frozen_ledger_refuses_with_nothing_booked_and_after_the_thaw_the_same_call_books_once() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    freeze::write(
        &k.store,
        freeze::Command::Freeze {
            reason: "operatorReverse freeze test",
            actor: OPERATOR,
        },
    )
    .unwrap();
    let (status, refused) = reverse(&k, "svc-ops", &original, "1");
    assert_eq!(status, 412, "{}", refused.compact());
    assert_eq!(s(&refused, "code"), FROZEN);
    assert_eq!(reversals(&k), 0);
    assert_eq!(k.bal(&fees("USDT")), "10.5");

    freeze::write(
        &k.store,
        freeze::Command::Thaw {
            actor: OPERATOR,
            confirm_operator_id: Some(CHECKER),
        },
    )
    .unwrap();
    let (status, reply) = reverse(&k, "svc-ops", &original, "1");
    assert_eq!(status, 200, "{}", reply.compact());
    assert_eq!(reversals(&k), 1);
}

#[test]
fn a_caller_other_than_svc_ops_is_refused_before_anything_is_read() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let (status, refused) = reverse(&k, "svc-bank", &original, "1");
    assert_eq!(status, 403, "{}", refused.compact());
    assert_eq!(s(&refused, "code"), CALLER_FORBIDDEN);
    assert_eq!(reversals(&k), 0);
}

#[test]
fn a_body_the_record_refuses_never_reaches_the_book() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    for bad in [
        call(&original, "0"),
        call("not-a-uuid", "1"),
        Json::obj([
            ("originalTxId", Json::str(original.clone())),
            ("ordinal", Json::str("1")),
            ("reason", Json::str("   ")),
            ("caseRef", Json::str("case-1")),
        ]),
    ] {
        let (status, _) = k.keyed("svc-ops", "/trpc/operatorReverse", &bad);
        assert_eq!(status, 400, "{}", bad.compact());
    }
    assert_eq!(reversals(&k), 0);
}

#[test]
fn the_database_refuses_a_second_reversal_that_skipped_the_doors_check() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let (status, _) = reverse(&k, "svc-ops", &original, "1");
    assert_eq!(status, 200);
    // The recipe's post under a second key, booked straight through the engine: the one-reversal index refuses it.
    let legs = svc_ledger::db::with_client(k.store.pool().unwrap(), |c| {
        reversal::original_legs(c, &original)
    })
    .unwrap()
    .unwrap();
    let second = reversal::operator_reverse(&original, &legs, "2", "LOCAL TEST", "case-2").unwrap();
    let booked = posting::book(&k.store, k.door.posting(), &second);
    assert!(booked.is_err(), "{booked:?}");
    assert_eq!(k.rows(&key(&original, "2")), 0);
    assert_eq!(reversals(&k), 1);
}

#[test]
fn two_keys_racing_book_once_and_the_other_is_refused_naming_the_winner() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let answers: Vec<(u16, Json)> = std::thread::scope(|scope| {
        let handles: Vec<_> = ["1", "2", "3", "4"]
            .into_iter()
            .map(|n| {
                let (k, original) = (&k, &original);
                scope.spawn(move || reverse(k, "svc-ops", original, n))
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let won: Vec<&Json> = answers
        .iter()
        .filter(|(st, _)| *st == 200)
        .map(|(_, j)| j)
        .collect();
    assert_eq!(won.len(), 1, "{answers:?}");
    let winner = s(won[0], "txId");
    for (status, reply) in answers.iter().filter(|(st, _)| *st != 200) {
        assert_eq!(*status, 409, "{}", reply.compact());
        assert_eq!(s(reply, "code"), ALREADY_REVERSED);
        assert_eq!(s(reply, "reversedBy"), winner);
    }
    assert_eq!(reversals(&k), 1);
}

#[test]
fn post_refuses_a_hand_assembled_reversal_from_svc_ops() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let body = Json::obj([
        ("idempotencyKey", Json::str(key(&original, "1"))),
        ("module", Json::str("ops")),
        ("reason", Json::str("operator.reversal")),
        (
            "meta",
            Json::obj([("reverses", Json::str(original.clone()))]),
        ),
        (
            "entries",
            Json::Array(vec![
                leg(rail("USDT"), "debit", "10.5"),
                leg(fees("USDT"), "credit", "10.5"),
            ]),
        ),
    ]);
    let (status, refused) = k.keyed("svc-ops", "/trpc/post", &body);
    assert_ne!(status, 200, "{}", refused.compact());
    assert_eq!(reversals(&k), 0);
    // The engine's own parse of that body is the reversal's shape: it is the door, not the shape, that refuses it.
    assert!(rules::read_post(&body).is_ok());
}

#[test]
fn the_desks_one_transaction_read_shows_both_links() {
    let Some((_db, k)) = door() else { return };
    let original = seed(&k);
    let actor = Actor {
        actor_id: OPERATOR,
        request_id: Some("req-reverse"),
    };
    let before = desk::operator_tx_get(&k.store, actor, &original).unwrap();
    assert_eq!(before.get("reversedBy"), Some(&Json::Null));
    assert_eq!(before.get("reverses"), Some(&Json::Null));

    let (_, reply) = reverse(&k, "svc-ops", &original, "1");
    let reversing = s(&reply, "txId");
    let read = desk::operator_tx_get(&k.store, actor, &original).unwrap();
    assert_eq!(s(&read, "reversedBy"), reversing);
    assert_eq!(read.get("reverses"), Some(&Json::Null));
    let back = desk::operator_tx_get(&k.store, actor, &reversing).unwrap();
    assert_eq!(s(&back, "reverses"), original);
    assert_eq!(back.get("reversedBy"), Some(&Json::Null));
    assert_eq!(s(&back, "module"), "ops");
    assert_eq!(s(&back, "reason"), "operator.reversal");
}
