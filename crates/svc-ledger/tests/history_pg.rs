//! The `history` slice against a real Postgres, each test in its own throwaway database (`support`). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proofs it ports, case for case: `history-postgres.test.ts`, `history-page-postgres.test.ts`,
//! `history-page-order-id-postgres.test.ts`, `holdings-history-postgres.test.ts` and `holdings-history-door.test.ts`
//! (there against a stand-in ledger, here against the book). Each books what its TypeScript test posts: the same
//! recipes with the same arguments, recorded by `scripts/record-door.mjs` into `fixtures/history-book.golden.json`,
//! stored as `PostgresLedger.post` stores them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeSet;
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use postgres::Client;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{KeyringEntry, Mode, ServiceSigner, SignedContext, system_seconds};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::schema::{Outcome, Value};
use service_kit::server::{Door, Request};
use service_kit::telemetry::Logger;
use service_kit::time::Instant;
use service_kit::tokens::TokenConfig;
use sha2::{Digest, Sha256};
use support::TestDb;
use svc_ledger::clock::system_ms;
use svc_ledger::db::Store;
use svc_ledger::door::{DOOR_CALLERS, DoorConfig, Keys, LedgerDoor, parse};
use svc_ledger::history::{
    self, AccountRef, CURSOR_INVALID, HISTORY_MAX_ENTRIES, HOLDINGS_HISTORY_MAX_ROWS,
    HOLDINGS_TOO_LARGE, HOLDINGS_WINDOW_INVALID, HistoryEntry, HistoryRange, HoldingsHistory,
    HoldingsInput, Page, PageEntry, PageInput, RANGE_TOO_LARGE, ReadError,
};
use svc_ledger::migrate::FILES;

static BOOK: LazyLock<Json> =
    LazyLock::new(|| json::parse(include_str!("fixtures/history-book.golden.json")).unwrap());

fn s(v: &Json, k: &str) -> String {
    match v.get(k) {
        Some(Json::String(t)) => t.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

fn amt(text: &str) -> Amount {
    parse_amount(text).unwrap()
}

fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    Some(db)
}

/// One post as `PostgresLedger.post` stores it: the transaction, each entry against its account (opened on first use),
/// and the balance each leaves. A pause after it keeps every post on its own millisecond, as the TypeScript tests'
/// windows assume.
fn post(c: &mut Client, p: &Json) {
    let mut tx = c.transaction().unwrap();
    let key = s(p, "idempotency");
    let meta = p.get("meta").unwrap().compact();
    let tx_id: String = tx
        .query_one(
            "INSERT INTO ledger.ledger_tx (idempotency_key, module, reason, meta, hash, previous_hash)
             VALUES ($1, $2, $3, $4::text::jsonb, 'book:' || $1, NULL) RETURNING id::text",
            &[&key, &s(p, "module"), &s(p, "reason"), &meta],
        )
        .unwrap()
        .get(0);
    let Some(Json::Array(entries)) = p.get("entries") else {
        panic!("{key}: no entries")
    };
    for e in entries {
        let ident = [
            s(e, "ownerType"),
            s(e, "ownerId"),
            s(e, "assetId"),
            s(e, "kind"),
            s(e, "purpose"),
        ];
        tx.execute(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose)
             VALUES ($1::text::ledger.owner_type, $2, $3, $4::text::ledger.account_kind, $5) ON CONFLICT DO NOTHING",
            &[&ident[0], &ident[1], &ident[2], &ident[3], &ident[4]],
        )
        .unwrap();
        let row = tx
            .query_one(
                "UPDATE ledger.accounts
                    SET balance = balance + (CASE WHEN $6 = 'debit' THEN 1 ELSE -1 END) * $7::text::numeric
                  WHERE owner_type = $1::text::ledger.owner_type AND owner_id = $2 AND asset_id = $3
                    AND kind = $4::text::ledger.account_kind AND purpose = $5
              RETURNING id::text, balance::text",
                &[
                    &ident[0],
                    &ident[1],
                    &ident[2],
                    &ident[3],
                    &ident[4],
                    &s(e, "direction"),
                    &s(e, "amount"),
                ],
            )
            .unwrap();
        let (account_id, after): (String, String) = (row.get(0), row.get(1));
        tx.execute(
            "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::ledger.direction, $5::text::numeric, $6::text::numeric)",
            &[&tx_id, &account_id, &ident[2], &s(e, "direction"), &s(e, "amount"), &after],
        )
        .unwrap();
    }
    tx.commit().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(3));
}

/// Books every post of the named list, in order.
fn book(db: &TestDb, name: &str) {
    let Some(Json::Array(posts)) = BOOK.get(name) else {
        panic!("no book {name}")
    };
    let mut c = db.client();
    for p in posts {
        post(&mut c, p);
    }
}

/// `disableBalanceTrigger`: the raw fixtures below are one-sided on purpose (they test the cap and the order, not the
/// balance, which `journal-immutable.db.test.ts` holds).
fn balance_trigger_off(db: &TestDb) {
    db.client()
        .batch_execute(
            "ALTER TABLE ledger.ledger_entries DISABLE TRIGGER ledger_entries_tx_must_balance",
        )
        .unwrap();
}

fn posted_ms(db: &TestDb, key: &str) -> i64 {
    db.client()
        .query_one(
            "SELECT floor(extract(epoch FROM posted_at) * 1000)::bigint FROM ledger.ledger_tx WHERE idempotency_key = $1",
            &[&key],
        )
        .unwrap()
        .get(0)
}

fn available(owner: &str, asset: &str) -> AccountRef {
    AccountRef {
        owner_type: "user".to_owned(),
        owner_id: owner.to_owned(),
        asset_id: asset.to_owned(),
        kind: "available".to_owned(),
        purpose: None,
    }
}

fn window(from: i64, to: i64) -> HistoryRange {
    HistoryRange {
        from: Instant(from),
        to: Instant(to),
    }
}

fn read(store: &Store, account: &AccountRef, range: HistoryRange) -> Vec<HistoryEntry> {
    history::history(store, account, range).unwrap()
}

fn amounts(entries: &[HistoryEntry]) -> Vec<String> {
    entries.iter().map(|e| format_amount(e.amount)).collect()
}

fn code_of(e: ReadError) -> &'static str {
    match e {
        ReadError::Refused { code, .. } => code,
        ReadError::Store(s) => panic!("the database failed: {s:?}"),
    }
}

/// The door over this database, with per-service keys for `svc-bank` and `svc-tax` in `keypair` mode.
struct Doors {
    door: LedgerDoor,
    signers: Vec<(String, ServiceSigner)>,
}

fn pkcs8(seed: &[u8; 32]) -> String {
    let mut der = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    der.extend_from_slice(seed);
    URL_SAFE_NO_PAD.encode(der)
}

fn doors(db: &TestDb) -> Doors {
    let services = ["svc-bank", "svc-tax", "svc-trade"];
    let seeds: Vec<[u8; 32]> = services
        .iter()
        .map(|svc| Sha256::digest(format!("history-pg:{svc}")).into())
        .collect();
    let keyring: Vec<KeyringEntry> = services
        .iter()
        .zip(&seeds)
        .map(|(svc, seed)| KeyringEntry {
            kid: format!("{svc}.a"),
            svc: (*svc).to_owned(),
            use_: "s2s".to_owned(),
            x: URL_SAFE_NO_PAD.encode(
                ed25519_dalek::SigningKey::from_bytes(seed)
                    .verifying_key()
                    .as_bytes(),
            ),
        })
        .collect();
    let signers = services
        .iter()
        .zip(&seeds)
        .map(|(svc, seed)| {
            (
                (*svc).to_owned(),
                ServiceSigner::new(svc, &format!("{svc}.a"), &pkcs8(seed), &keyring).unwrap(),
            )
        })
        .collect();
    let door = LedgerDoor::new(DoorConfig {
        internal_secret: "placeholder-history-test-internal-secret".to_owned(),
        body_bind: BodyBind::Require,
        keys: Some(Keys {
            verifier: ServiceVerifier::new("svc-ledger", &keyring, system_seconds).unwrap(),
            mode: Mode::Keypair,
        }),
        tokens: TokenConfig {
            secret: "placeholder-history-test-token-secret-long".to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store: db.store(),
        service_name: "svc-ledger".to_owned(),
        bus: std::sync::Arc::new(svc_ledger::freeze::MemoryBus::default()),
        approvals: Box::new(svc_ledger::approval::Unwired),
        clock_skew_bound_ms: None,
        now_ms: system_ms,
        log: Logger::new("info", Box::new(std::io::sink())),
        custody: svc_ledger::reconcile::CustodyLayer::On,
        reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
        posting: support::idle_posting(),
    })
    .unwrap();
    Doors { door, signers }
}

impl Doors {
    /// A signed `POST /trpc/<door>` from `service`: its status and parsed body.
    fn send(&self, service: &str, door: &str, body: &Json) -> (u16, Json) {
        let path = format!("/trpc/{door}");
        let text = body.compact();
        let signer = &self.signers.iter().find(|(s, _)| s == service).unwrap().1;
        let mut headers = signer
            .headers(
                "svc-ledger",
                "POST",
                &path,
                &text,
                &SignedContext {
                    content_type: Some("application/json".to_owned()),
                    ..SignedContext::default()
                },
            )
            .unwrap();
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let r = self.door.handle_as(
            &Request {
                method: "POST",
                url: &path,
                headers: &headers,
                body: &text,
            },
            "req-1",
        );
        (r.status, json::parse(&r.body).unwrap())
    }
}

fn obj(pairs: &[(&str, Json)]) -> Json {
    Json::Object(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

// ── history-postgres.test.ts ───────────────────────────────────────────────────────────────────────────────────────

const SPENDER: &str = "11111111-1111-4111-8111-111111111111";
const STRANGER: &str = "22222222-2222-4222-8222-222222222222";
const QUIET: &str = "33333333-3333-4333-8333-333333333333";

/// The spender's book and the window around it.
fn spender() -> Option<(TestDb, Store, HistoryRange)> {
    let db = migrated()?;
    book(&db, "history");
    let wide = window(
        posted_ms(&db, "hist-deposit-1") - 60_000,
        posted_ms(&db, "hist-refund-1") + 60_000,
    );
    let store = db.store();
    Some((db, store, wide))
}

#[test]
fn history_returns_exactly_the_shape_svc_bank_parses() {
    let Some((db, store, wide)) = spender() else {
        return;
    };
    let entries = read(&store, &available(SPENDER, "USDT"), wide);
    assert_eq!(entries.len(), 3);
    let first = &entries[0];
    assert_eq!(
        (first.module.as_str(), first.reason.as_str()),
        ("bank", "bank.transfer.in")
    );
    assert_eq!(first.direction, "debit");
    assert_eq!(format_amount(first.amount), "100.123456789012345678");
    // On the wire: a bare array, these six keys, the amount a decimal string, the time ISO.
    let (status, body) = doors(&db).send(
        "svc-bank",
        "history",
        &obj(&[
            (
                "account",
                obj(&[
                    ("ownerType", Json::str("user")),
                    ("ownerId", Json::str(SPENDER)),
                    ("assetId", Json::str("USDT")),
                    ("kind", Json::str("available")),
                ]),
            ),
            ("from", Json::str(wide.from.iso())),
            ("to", Json::str(wide.to.iso())),
        ]),
    );
    assert_eq!(status, 200, "{body:?}");
    let Json::Array(lines) = body else {
        panic!("not an array")
    };
    assert_eq!(lines.len(), 3);
    let Json::Object(fields) = &lines[0] else {
        panic!()
    };
    let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "txId",
            "module",
            "reason",
            "direction",
            "amount",
            "postedAt"
        ]
    );
    assert_eq!(s(&lines[0], "amount"), "100.123456789012345678");
    assert_eq!(s(&lines[0], "postedAt"), first.posted_at.iso());
    assert_eq!(s(&lines[0], "txId"), first.tx_id);
    store.end();
}

#[test]
fn history_carries_the_ledgers_own_reasons_and_directions_unaltered() {
    let Some((_db, store, wide)) = spender() else {
        return;
    };
    let entries = read(&store, &available(SPENDER, "USDT"), wide);
    let reasons: Vec<&str> = entries.iter().map(|e| e.reason.as_str()).collect();
    assert_eq!(
        reasons,
        ["bank.transfer.in", "trade.fill", "bank.transfer.in"]
    );
    let directions: Vec<&str> = entries.iter().map(|e| e.direction.as_str()).collect();
    assert_eq!(directions, ["debit", "credit", "debit"]);
    store.end();
}

#[test]
fn history_keeps_the_smallest_unit_the_book_carries() {
    let Some((_db, store, wide)) = spender() else {
        return;
    };
    let entries = read(&store, &available(SPENDER, "USDT"), wide);
    assert_eq!(format_amount(entries[2].amount), "0.000000000000000001");
    store.end();
}

#[test]
fn history_never_leaks_another_accounts_movements() {
    let Some((_db, store, wide)) = spender() else {
        return;
    };
    let shown = amounts(&read(&store, &available(SPENDER, "USDT"), wide));
    assert!(
        !shown.contains(&"999".to_owned()) && !shown.contains(&"9".to_owned()),
        "{shown:?}"
    );
    assert_eq!(read(&store, &available(STRANGER, "USDT"), wide).len(), 2);
    store.end();
}

#[test]
fn history_is_ordered_oldest_first() {
    let Some((_db, store, wide)) = spender() else {
        return;
    };
    let times: Vec<i64> = read(&store, &available(SPENDER, "USDT"), wide)
        .iter()
        .map(|e| e.posted_at.0)
        .collect();
    let mut sorted = times.clone();
    sorted.sort_unstable();
    assert_eq!(times, sorted);
    store.end();
}

#[test]
fn history_includes_a_movement_at_exactly_from_and_excludes_one_at_exactly_to() {
    let Some((db, store, _)) = spender() else {
        return;
    };
    let (deposited, spent) = (
        posted_ms(&db, "hist-deposit-1"),
        posted_ms(&db, "hist-spend-1"),
    );
    let first = read(
        &store,
        &available(SPENDER, "USDT"),
        window(deposited, spent),
    );
    assert_eq!(amounts(&first), ["100.123456789012345678"]);
    assert_eq!(
        read(
            &store,
            &available(SPENDER, "USDT"),
            window(deposited - 60_000, deposited)
        ),
        []
    );
    store.end();
}

#[test]
fn history_answers_honest_empties() {
    let Some((db, store, wide)) = spender() else {
        return;
    };
    let refunded = posted_ms(&db, "hist-refund-1");
    let deposited = posted_ms(&db, "hist-deposit-1");
    // An account that moved nothing in the window, and a zero-width window.
    assert_eq!(
        read(
            &store,
            &available(SPENDER, "USDT"),
            window(refunded + 60_000, refunded + 120_000)
        ),
        []
    );
    assert_eq!(
        read(
            &store,
            &available(SPENDER, "USDT"),
            window(deposited, deposited)
        ),
        []
    );
    // An account nobody has posted to: empty, and the read creates nothing.
    let never = "44444444-4444-4444-8444-444444444444";
    assert_eq!(read(&store, &available(never, "USDT"), wide), []);
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM ledger.accounts WHERE owner_id = '{never}'"
        )),
        0
    );
    // `purpose` is the fifth part of an account's identity: a hold is not the available account it came from.
    let hold = AccountRef {
        kind: "hold".to_owned(),
        purpose: Some("order:none".to_owned()),
        ..available(QUIET, "USDT")
    };
    assert_eq!(read(&store, &hold, wide), []);
    assert_eq!(read(&store, &available(QUIET, "USDT"), wide).len(), 1);
    store.end();
}

/// `bulkEntries`: rows inserted in bulk, not posted (the test is about the limit, not the chain).
fn bulk_entries(db: &TestDb, user: &str, count: i32) {
    let mut c = db.client();
    let id: String = c
        .query_one(
            "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind, purpose)
             VALUES ('user', $1, 'USDT', 'available', '')
             ON CONFLICT (owner_type, owner_id, asset_id, kind, purpose) DO UPDATE SET owner_id = EXCLUDED.owner_id
             RETURNING id::text",
            &[&user],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO ledger.ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
         SELECT gen_random_uuid(), 'bulk-' || $1 || '-' || i, 'bank', 'bank.transfer.in', '{}'::jsonb,
                timestamptz '2026-05-01T00:00:00Z' + (i * interval '1 second'), 'bulk-hash-' || i, NULL
           FROM generate_series(1, $2::int) AS i",
        &[&user, &count],
    )
    .unwrap();
    c.execute(
        "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
         SELECT t.id, $1::text::uuid, 'USDT', 'debit', 1::numeric, 1::numeric
           FROM ledger.ledger_tx t
          WHERE t.idempotency_key LIKE $2
            AND NOT EXISTS (SELECT 1 FROM ledger.ledger_entries e WHERE e.tx_id = t.id)",
        &[&id, &format!("bulk-{user}-%")],
    )
    .unwrap();
}

fn bulk_window() -> HistoryRange {
    window(
        service_kit::time::v8_date_parse("2026-04-01T00:00:00Z").unwrap(),
        service_kit::time::v8_date_parse("2026-06-01T00:00:00Z").unwrap(),
    )
}

/// The window's two ends on moments the book holds exactly (whole seconds), which a posted entry's microseconds never
/// are: `from` admits the entry at it, `to` holds back the entry at it.
#[test]
fn history_window_ends_are_exact_on_whole_moments() {
    let Some(db) = migrated() else { return };
    balance_trigger_off(&db);
    let user = "57777777-7777-4777-8777-777777777777";
    bulk_entries(&db, user, 3);
    let store = db.store();
    let second =
        |n: i64| service_kit::time::v8_date_parse("2026-05-01T00:00:00Z").unwrap() + n * 1000;
    let count = |from: i64, to: i64| {
        read(
            &store,
            &available(user, "USDT"),
            window(second(from), second(to)),
        )
        .len()
    };
    assert_eq!(count(1, 2), 1);
    assert_eq!(count(1, 3), 2);
    assert_eq!(count(0, 1), 0);
    assert_eq!(count(3, 3), 0);
    assert_eq!(count(3, 4), 1);
    store.end();
}

#[test]
fn history_answers_in_full_at_exactly_the_cap() {
    let Some(db) = migrated() else { return };
    balance_trigger_off(&db);
    let user = "55555555-5555-4555-8555-555555555555";
    bulk_entries(&db, user, i32::try_from(HISTORY_MAX_ENTRIES).unwrap());
    let store = db.store();
    assert_eq!(
        read(&store, &available(user, "USDT"), bulk_window()).len(),
        HISTORY_MAX_ENTRIES
    );
    store.end();
}

#[test]
fn history_refuses_one_row_past_the_cap_and_a_narrower_window_answers() {
    let Some(db) = migrated() else { return };
    balance_trigger_off(&db);
    let user = "66666666-6666-4666-8666-666666666666";
    bulk_entries(&db, user, i32::try_from(HISTORY_MAX_ENTRIES + 1).unwrap());
    let store = db.store();
    let refused = history::history(&store, &available(user, "USDT"), bulk_window()).unwrap_err();
    let ReadError::Refused { code, message } = refused else {
        panic!()
    };
    assert_eq!(code, RANGE_TOO_LARGE);
    assert!(
        message.contains(
            "between 2026-04-01T00:00:00.000Z and 2026-06-01T00:00:00.000Z exceeds 10000 entries"
        ),
        "{message}"
    );
    // At the door it is 400 with its own message, never a short array.
    let (status, body) = doors(&db).send(
        "svc-bank",
        "history",
        &obj(&[
            (
                "account",
                obj(&[
                    ("ownerType", Json::str("user")),
                    ("ownerId", Json::str(user)),
                    ("assetId", Json::str("USDT")),
                    ("kind", Json::str("available")),
                ]),
            ),
            ("from", Json::str("2026-04-01T00:00:00Z")),
            ("to", Json::str("2026-06-01T00:00:00Z")),
        ]),
    );
    assert_eq!(
        (status, s(&body, "code")),
        (400, RANGE_TOO_LARGE.to_owned())
    );
    let half = window(
        service_kit::time::v8_date_parse("2026-05-01T00:00:00Z").unwrap(),
        service_kit::time::v8_date_parse("2026-05-01T01:00:00Z").unwrap(),
    );
    let some = read(&store, &available(user, "USDT"), half).len();
    assert!(some > 0 && some <= HISTORY_MAX_ENTRIES, "{some}");
    store.end();
}

// ── history-page-postgres.test.ts ──────────────────────────────────────────────────────────────────────────────────

const PAGER: &str = "71111111-1111-4111-8111-111111111111";
const OTHER: &str = "72222222-2222-4222-8222-222222222222";
const EMPTY: &str = "73333333-3333-4333-8333-333333333333";
const RAILER: &str = "74444444-4444-4444-8444-444444444444";
const CONVERTER: &str = "75555555-5555-4555-8555-555555555555";
const WITHDRAWER: &str = "76666666-6666-4666-8666-666666666666";

fn scope(owner: &str, limit: i64) -> PageInput {
    PageInput {
        owner_type: "user".to_owned(),
        owner_id: owner.to_owned(),
        kind: "available".to_owned(),
        purpose: None,
        asset_id: None,
        limit,
        cursor: None,
    }
}

fn page(store: &Store, input: &PageInput) -> Page {
    history::history_page(store, input).unwrap()
}

/// Every page from the first, following `nextCursor` (at most 50 pages).
fn walk(store: &Store, base: &PageInput, limit: i64) -> (Vec<PageEntry>, usize) {
    let mut seen = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let p = page(
            store,
            &PageInput {
                limit,
                cursor: cursor.clone(),
                ..base.clone()
            },
        );
        seen.extend(p.entries);
        pages += 1;
        cursor = p.next_cursor;
        if cursor.is_none() || pages >= 50 {
            return (seen, pages);
        }
    }
}

fn tx_ids(entries: &[PageEntry]) -> Vec<String> {
    entries.iter().map(|e| e.entry.tx_id.clone()).collect()
}

/// The pager's book: three moves, another owner's, then seven entries tied on one timestamp after them.
fn pager() -> Option<(TestDb, Store, i64, Vec<String>)> {
    let db = migrated()?;
    balance_trigger_off(&db);
    book(&db, "page");
    let tied_at = system_ms() + 60_000;
    let mut c = db.client();
    let account: String = c
        .query_one(
            "SELECT id::text FROM ledger.accounts WHERE owner_id = $1 AND asset_id = 'USDT' AND kind = 'available'",
            &[&PAGER],
        )
        .unwrap()
        .get(0);
    c.execute(
        "INSERT INTO ledger.ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
         SELECT gen_random_uuid(), 'tied-key-' || i, 'bank', 'bank.tied', '{}'::jsonb,
                timestamptz 'epoch' + $1::bigint * interval '1 millisecond', 'tied-hash-' || i, NULL
           FROM generate_series(1, 7) AS i",
        &[&tied_at],
    )
    .unwrap();
    c.execute(
        "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
         SELECT t.id, $1::text::uuid, 'USDT', 'debit', 1::numeric, 1::numeric
           FROM ledger.ledger_tx t WHERE t.idempotency_key LIKE 'tied-key-%' ORDER BY t.idempotency_key",
        &[&account],
    )
    .unwrap();
    let tied = c
        .query(
            "SELECT e.tx_id::text FROM ledger.ledger_entries e JOIN ledger.ledger_tx t ON t.id = e.tx_id
              WHERE t.idempotency_key LIKE 'tied-key-%' ORDER BY e.id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    let store = db.store();
    Some((db, store, tied_at, tied))
}

#[test]
fn page_walks_newest_first_across_a_boundary_inside_equal_timestamps() {
    let Some((_db, store, tied_at, tied)) = pager() else {
        return;
    };
    let all = page(&store, &scope(PAGER, 200));
    assert_eq!(all.entries.len(), 10);
    assert_eq!(all.next_cursor, None);
    let (seen, pages) = walk(&store, &scope(PAGER, 3), 3);
    assert_eq!(pages, 4);
    assert_eq!(tx_ids(&seen), tx_ids(&all.entries));
    assert_eq!(tx_ids(&seen).into_iter().collect::<BTreeSet<_>>().len(), 10);
    let times: Vec<i64> = seen.iter().map(|e| e.entry.posted_at.0).collect();
    let mut newest_first = times.clone();
    newest_first.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(times, newest_first);
    let shown_tied: Vec<String> = seen
        .iter()
        .filter(|e| e.entry.posted_at.0 == tied_at)
        .map(|e| e.entry.tx_id.clone())
        .collect();
    assert_eq!(shown_tied, tied.into_iter().rev().collect::<Vec<_>>());
    store.end();
}

#[test]
fn page_id_order_and_time_order_agree() {
    let Some((db, store, ..)) = pager() else {
        return;
    };
    let expected: Vec<String> = db
        .client()
        .query(
            "SELECT e.tx_id::text FROM ledger.ledger_entries e
               JOIN ledger.ledger_tx t ON t.id = e.tx_id
               JOIN ledger.accounts a ON a.id = e.account_id
              WHERE a.owner_id = $1 AND a.kind = 'available'
              ORDER BY t.posted_at DESC, e.id DESC",
            &[&PAGER],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(tx_ids(&walk(&store, &scope(PAGER, 4), 4).0), expected);
    store.end();
}

#[test]
fn page_filters_by_asset_and_the_cursor_stays_inside_it() {
    let Some((_db, store, ..)) = pager() else {
        return;
    };
    let usd = page(
        &store,
        &PageInput {
            asset_id: Some("USD".to_owned()),
            ..scope(PAGER, 50)
        },
    );
    assert_eq!(usd.entries.len(), 1);
    assert_eq!(usd.entries[0].asset_id, "USD");
    assert_eq!(format_amount(usd.entries[0].entry.amount), "2");
    let (seen, _) = walk(
        &store,
        &PageInput {
            asset_id: Some("USDT".to_owned()),
            ..scope(PAGER, 4)
        },
        4,
    );
    assert_eq!(seen.len(), 9);
    assert!(seen.iter().all(|e| e.asset_id == "USDT"));
    store.end();
}

fn page_schema(extra: &[(&str, Json)]) -> Outcome {
    let mut fields = vec![
        ("ownerType".to_owned(), Json::str("user")),
        ("ownerId".to_owned(), Json::str(PAGER)),
        ("kind".to_owned(), Json::str("available")),
    ];
    fields.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), v.clone())));
    parse("historyPage", Value::from_json(&Json::Object(fields))).unwrap()
}

#[test]
fn page_input_refuses_unknown_keys_and_holds_limit_to_1_through_200_defaulting_to_50() {
    assert!(matches!(
        page_schema(&[("before", Json::str("x"))]),
        Outcome::Issues(_)
    ));
    assert!(matches!(
        page_schema(&[("offset", Json::int(5))]),
        Outcome::Issues(_)
    ));
    let Outcome::Ok(v) = page_schema(&[]) else {
        panic!()
    };
    assert_eq!(v.get("limit"), &Value::Number(50.0));
    for bad in [0.0, -1.0, 201.0, 1.5] {
        assert!(
            matches!(
                page_schema(&[("limit", Json::Number(bad))]),
                Outcome::Issues(_)
            ),
            "{bad}"
        );
    }
    for good in [1, 200] {
        let Outcome::Ok(v) = page_schema(&[("limit", Json::int(good))]) else {
            panic!()
        };
        #[allow(clippy::cast_precision_loss, reason = "1 or 200")]
        let want = good as f64;
        assert_eq!(v.get("limit"), &Value::Number(want));
    }
}

#[test]
fn page_answers_an_empty_history_empty_with_no_cursor_and_creates_nothing() {
    let Some((db, store, ..)) = pager() else {
        return;
    };
    let empty = page(&store, &scope(EMPTY, 50));
    assert_eq!(
        empty,
        Page {
            entries: Vec::new(),
            next_cursor: None
        }
    );
    assert_eq!(
        db.count(&format!(
            "SELECT count(*) FROM ledger.accounts WHERE owner_id = '{EMPTY}'"
        )),
        0
    );
    // A page that ends exactly on the last entry has no next cursor; one entry of ten has one.
    let ten = page(&store, &scope(PAGER, 10));
    assert_eq!((ten.entries.len(), ten.next_cursor), (10, None));
    let one = page(&store, &scope(PAGER, 1));
    assert_eq!(one.entries.len(), 1);
    assert!(one.next_cursor.is_some());
    store.end();
}

#[test]
fn page_a_forged_cursor_cannot_read_another_account() {
    let Some((db, store, ..)) = pager() else {
        return;
    };
    let other: String = db
        .client()
        .query_one(
            "SELECT e.id::text FROM ledger.ledger_entries e JOIN ledger.accounts a ON a.id = e.account_id
              WHERE a.owner_id = $1 AND a.asset_id = 'USDT' LIMIT 1",
            &[&OTHER],
        )
        .unwrap()
        .get(0);
    let forged = history::encode_cursor(&(other.parse::<i64>().unwrap() + 1000).to_string());
    let p = page(
        &store,
        &PageInput {
            cursor: Some(forged),
            ..scope(PAGER, 200)
        },
    );
    assert_eq!(p.entries.len(), 10);
    assert!(
        !p.entries
            .iter()
            .any(|e| format_amount(e.entry.amount) == "999")
    );
    store.end();
}

#[test]
fn page_refuses_garbage_cursors_with_a_typed_error() {
    let Some((db, store, ..)) = pager() else {
        return;
    };
    let bad = [
        "not-a-cursor!".to_owned(),
        URL_SAFE_NO_PAD.encode("v2.abc"),
        URL_SAFE_NO_PAD.encode("v1.1.1"),
        URL_SAFE_NO_PAD.encode("v2.1'; DROP TABLE accounts;--"),
        URL_SAFE_NO_PAD.encode("v2.99999999999999999999"),
    ];
    for cursor in &bad {
        let refused = history::history_page(
            &store,
            &PageInput {
                cursor: Some(cursor.clone()),
                ..scope(PAGER, 50)
            },
        );
        assert_eq!(code_of(refused.unwrap_err()), CURSOR_INVALID, "{cursor}");
    }
    // At the door: 400 with the code the record names.
    let (status, body) = doors(&db).send(
        "svc-trade",
        "historyPage",
        &obj(&[
            ("ownerType", Json::str("user")),
            ("ownerId", Json::str(PAGER)),
            ("kind", Json::str("available")),
            ("cursor", Json::str(&bad[1])),
        ]),
    );
    assert_eq!((status, s(&body, "code")), (400, CURSOR_INVALID.to_owned()));
    store.end();
}

#[test]
fn page_returns_entry_ids_and_an_allow_listed_rail_only() {
    let Some(db) = migrated() else { return };
    book(&db, "rails");
    let store = db.store();
    let p = page(&store, &scope(RAILER, 200));
    assert_eq!(p.entries.len(), 6);
    let db_ids: Vec<String> = db
        .client()
        .query(
            "SELECT e.id::text FROM ledger.ledger_entries e JOIN ledger.accounts a ON a.id = e.account_id
              WHERE a.owner_id = $1 AND a.kind = 'available' ORDER BY e.id DESC",
            &[&RAILER],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    let ids: Vec<String> = p.entries.iter().map(|e| e.entry_id.clone()).collect();
    assert_eq!(ids, db_ids);
    assert!(
        ids.iter()
            .all(|id| !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit()))
    );
    let rails: Vec<Option<&str>> = p.entries.iter().rev().map(|e| e.rail.as_deref()).collect();
    assert_eq!(
        rails,
        [
            Some("crypto-native"),
            Some("bank-crypto-ledger"),
            Some("local-test"),
            None,
            None,
            None
        ]
    );
    let (status, wire) = doors(&db).send(
        "svc-bank",
        "historyPage",
        &obj(&[
            ("ownerType", Json::str("user")),
            ("ownerId", Json::str(RAILER)),
            ("kind", Json::str("available")),
            ("limit", Json::int(200)),
        ]),
    );
    assert_eq!(status, 200);
    let wire = wire.compact();
    assert!(
        !wire.contains("must-not-leak") && !wire.contains("not-a-known-rail"),
        "{wire}"
    );
    let first = page(&store, &scope(RAILER, 2));
    let resumed = page(
        &store,
        &PageInput {
            cursor: Some(history::encode_cursor(&first.entries[1].entry_id)),
            ..scope(RAILER, 200)
        },
    );
    let resumed_ids: Vec<String> = resumed.entries.iter().map(|e| e.entry_id.clone()).collect();
    assert_eq!(resumed_ids, ids[2..]);
    store.end();
}

#[test]
fn page_returns_an_allow_listed_product_only() {
    let Some(db) = migrated() else { return };
    book(&db, "products");
    let store = db.store();
    let p = page(&store, &scope(CONVERTER, 200));
    let shown: Vec<(String, String, Option<String>)> = p
        .entries
        .iter()
        .rev()
        .map(|e| {
            (
                e.entry.reason.clone(),
                e.asset_id.clone(),
                e.product.clone(),
            )
        })
        .collect();
    let row =
        |r: &str, a: &str, p: Option<&str>| (r.to_owned(), a.to_owned(), p.map(str::to_owned));
    assert_eq!(
        shown,
        [
            row("deposit.credited", "USDT", None),
            row("order.hold", "USDT", None),
            row("trade.fill.mm_maker", "BTC", None),
            row("order.hold", "USDT", None),
            row("trade.fill.mm_maker", "BTC", Some("convert")),
            row("order.hold", "USDT", None),
            row("trade.fill.mm_maker", "BTC", None),
        ]
    );
    let (_, wire) = doors(&db).send(
        "svc-bank",
        "historyPage",
        &obj(&[
            ("ownerType", Json::str("user")),
            ("ownerId", Json::str(CONVERTER)),
            ("kind", Json::str("available")),
            ("limit", Json::int(200)),
        ]),
    );
    let wire = wire.compact();
    assert!(wire.contains(r#""product":"convert""#) && !wire.contains("not-a-known-product"));
    store.end();
}

#[test]
fn page_returns_a_withdrawal_lines_own_withdrawal_id_and_null_elsewhere() {
    let Some(db) = migrated() else { return };
    book(&db, "withdrawals");
    let store = db.store();
    let p = page(&store, &scope(WITHDRAWER, 200));
    let shown: Vec<(&str, Option<&str>)> = p
        .entries
        .iter()
        .rev()
        .map(|e| (e.entry.reason.as_str(), e.withdrawal_id.as_deref()))
        .collect();
    let id0 = "7a7a7a7a-0000-4000-8000-000000000001:0";
    let id1 = "7a7a7a7a-0000-4000-8000-000000000001:1";
    assert_eq!(
        shown,
        [
            ("deposit.credited", None),
            ("withdraw.held", Some(id0)),
            ("withdraw.reversed", Some(id0)),
            ("withdraw.held", Some(id1)),
        ]
    );
    store.end();
}

#[test]
fn page_leaves_the_old_history_as_it_was() {
    let Some((db, store, ..)) = pager() else {
        return;
    };
    let entries = read(
        &store,
        &available(PAGER, "USDT"),
        window(
            service_kit::time::v8_date_parse("2026-01-01T00:00:00Z").unwrap(),
            service_kit::time::v8_date_parse("2099-01-01T00:00:00Z").unwrap(),
        ),
    );
    assert_eq!(entries.len(), 9);
    let times: Vec<i64> = entries.iter().map(|e| e.posted_at.0).collect();
    let mut sorted = times.clone();
    sorted.sort_unstable();
    assert_eq!(times, sorted);
    // The door still refuses a cursor on `history`, before its schema would strip it.
    let (status, body) = doors(&db).send(
        "svc-bank",
        "history",
        &obj(&[
            (
                "account",
                obj(&[
                    ("ownerType", Json::str("user")),
                    ("ownerId", Json::str(PAGER)),
                    ("assetId", Json::str("USDT")),
                    ("kind", Json::str("available")),
                ]),
            ),
            ("from", Json::str("2026-01-01T00:00:00Z")),
            ("to", Json::str("2026-02-01T00:00:00Z")),
            ("cursor", Json::str("x")),
        ]),
    );
    assert_eq!(
        (status, s(&body, "code")),
        (400, history::PAGE_SOCKET.to_owned())
    );
    assert!(s(&body, "message").contains("socket"));
    store.end();
}

// ── history-page-order-id-postgres.test.ts ─────────────────────────────────────────────────────────────────────────

mod oid {
    pub const TAKER: &str = "81111111-1111-4111-8111-111111111111";
    pub const MAKER: &str = "82222222-2222-4222-8222-222222222222";
    pub const SELF: &str = "83333333-3333-4333-8333-333333333333";
    pub const FREE: &str = "84444444-4444-4444-8444-444444444444";
    pub const FREE_MAKER: &str = "85555555-5555-4555-8555-555555555555";
    pub const BB_MAKER: &str = "86666666-6666-4666-8666-666666666666";
    pub const TAKER_ORDER: &str = "d1111111-1111-4111-8111-d11111111111";
    pub const MAKER_ORDER: &str = "d2222222-2222-4222-8222-d22222222222";
    pub const MAKER_ORDER_2: &str = "d3333333-3333-4333-8333-d33333333333";
    pub const MM_TAKER_ORDER: &str = "d4444444-4444-4444-8444-d44444444444";
    pub const SELF_BUY: &str = "d5555555-5555-4555-8555-d55555555555";
    pub const SELF_SELL: &str = "d6666666-6666-4666-8666-d66666666666";
    pub const BB_ASK: &str = "d9999999-9999-4999-8999-d99999999999";
}

fn orders() -> Option<(TestDb, Store)> {
    let db = migrated()?;
    book(&db, "orderIds");
    let store = db.store();
    Some((db, store))
}

fn lines(store: &Store, owner: &str) -> Vec<PageEntry> {
    page(store, &scope(owner, 200)).entries
}

fn hold_lines(store: &Store, owner: &str, order: &str) -> Vec<PageEntry> {
    page(
        store,
        &PageInput {
            kind: "hold".to_owned(),
            purpose: Some(format!("order:{order}")),
            ..scope(owner, 200)
        },
    )
    .entries
}

fn by_reason(entries: &[PageEntry], reason: &str) -> Vec<PageEntry> {
    entries
        .iter()
        .filter(|e| e.entry.reason == reason)
        .cloned()
        .collect()
}

fn order_of(e: &PageEntry) -> Option<&str> {
    e.order_id.as_deref()
}

#[test]
fn order_ids_name_each_sides_own_order_on_fills_holds_amends_and_releases() {
    let Some((_db, store)) = orders() else { return };
    let taker = lines(&store, oid::TAKER);
    let fills = by_reason(&taker, "trade.fill");
    assert_eq!(fills.len(), 2);
    for f in &fills {
        assert_eq!(
            (f.asset_id.as_str(), f.entry.direction.as_str(), order_of(f)),
            ("BTC", "debit", Some(oid::TAKER_ORDER))
        );
    }
    let maker = lines(&store, oid::MAKER);
    let maker_fills = by_reason(&maker, "trade.fill");
    let mut ids: Vec<&str> = maker_fills.iter().filter_map(order_of).collect();
    ids.sort_unstable();
    assert_eq!(ids, [oid::MAKER_ORDER, oid::MAKER_ORDER_2]);
    assert!(
        maker_fills
            .iter()
            .all(|f| f.asset_id == "USDT" && f.entry.direction == "debit")
    );
    let held = by_reason(&taker, "order.hold");
    let own = held
        .iter()
        .find(|e| order_of(e) == Some(oid::TAKER_ORDER))
        .unwrap();
    assert_eq!(
        (own.entry.direction.as_str(), own.asset_id.as_str()),
        ("credit", "USDT")
    );
    let amend = by_reason(&taker, "order.hold.amend");
    assert_eq!(amend.len(), 1);
    assert_eq!(
        (order_of(&amend[0]), amend[0].entry.direction.as_str()),
        (Some(oid::TAKER_ORDER), "credit")
    );
    let release = by_reason(&taker, "order.hold.released");
    assert_eq!(release.len(), 1);
    assert_eq!(
        (order_of(&release[0]), release[0].entry.direction.as_str()),
        (Some(oid::TAKER_ORDER), "debit")
    );
    let mut maker_hold_ids: Vec<String> = by_reason(&maker, "order.hold")
        .iter()
        .filter_map(|e| e.order_id.clone())
        .collect();
    maker_hold_ids.sort_unstable();
    assert_eq!(maker_hold_ids, [oid::MAKER_ORDER, oid::MAKER_ORDER_2]);
    // Against the house market maker, the customer's own order.
    let mm = by_reason(&taker, "trade.fill.mm_maker");
    assert_eq!(mm.len(), 1);
    assert_eq!(
        (
            mm[0].asset_id.as_str(),
            mm[0].entry.direction.as_str(),
            order_of(&mm[0])
        ),
        ("BTC", "debit", Some(oid::MM_TAKER_ORDER))
    );
    store.end();
}

#[test]
fn order_ids_on_a_self_trade_follow_the_asset_each_line_received() {
    let Some((_db, store)) = orders() else { return };
    let own = by_reason(&lines(&store, oid::SELF), "trade.fill");
    assert_eq!(own.len(), 2);
    let on = |asset: &str| own.iter().find(|e| e.asset_id == asset).unwrap().clone();
    assert_eq!(order_of(&on("BTC")), Some(oid::SELF_BUY));
    assert_eq!(order_of(&on("USDT")), Some(oid::SELF_SELL));
    // On an order-hold account page, the id is that account's own order.
    for order in [oid::SELF_BUY, oid::SELF_SELL] {
        let entries = hold_lines(&store, oid::SELF, order);
        assert!(entries.len() >= 2, "{order}");
        assert!(
            entries.iter().all(|e| order_of(e) == Some(order)),
            "{order}"
        );
        assert!(entries.iter().any(|e| e.entry.reason == "trade.fill"));
    }
    // The fee each line names is in the asset it received.
    assert_eq!(on("BTC").fee, Some(amt("0.002")));
    assert_eq!(on("USDT").fee, Some(amt("0.9")));
    store.end();
}

#[test]
fn order_ids_are_null_on_a_line_with_no_order_on_the_wire_too() {
    let Some((db, store)) = orders() else { return };
    let dep = by_reason(&lines(&store, oid::TAKER), "deposit.credited");
    assert_eq!(dep.len(), 1);
    assert_eq!(dep[0].order_id, None);
    let (_, wire) = doors(&db).send(
        "svc-bank",
        "historyPage",
        &obj(&[
            ("ownerType", Json::str("user")),
            ("ownerId", Json::str(oid::TAKER)),
            ("kind", Json::str("available")),
            ("limit", Json::int(200)),
        ]),
    );
    let Some(Json::Array(entries)) = wire.get("entries") else {
        panic!()
    };
    let find = |reason: &str| entries.iter().find(|e| s(e, "reason") == reason).unwrap();
    assert_eq!(find("deposit.credited").get("orderId"), Some(&Json::Null));
    assert_eq!(s(find("order.hold.amend"), "orderId"), oid::TAKER_ORDER);
    // The fee as a decimal string, and null as null.
    let fills: Vec<String> = entries
        .iter()
        .filter(|e| s(e, "reason") == "trade.fill")
        .map(|e| s(e, "fee"))
        .collect();
    assert_eq!(fills, ["0.002", "0.002"]);
    assert_eq!(s(find("trade.fill.mm_maker"), "fee"), "0.002");
    assert_eq!(find("deposit.credited").get("fee"), Some(&Json::Null));
    store.end();
}

#[test]
fn a_fills_receiving_line_names_its_own_fee_and_every_other_line_none() {
    let Some((_db, store)) = orders() else { return };
    let taker = lines(&store, oid::TAKER);
    let fills = by_reason(&taker, "trade.fill");
    assert_eq!(
        fills.iter().map(|f| f.fee).collect::<Vec<_>>(),
        [Some(amt("0.002")); 2]
    );
    assert_eq!(
        fills.iter().map(|f| f.entry.amount).collect::<Vec<_>>(),
        [amt("0.998"); 2]
    );
    let mut maker: Vec<Option<Amount>> = by_reason(&lines(&store, oid::MAKER), "trade.fill")
        .iter()
        .map(|f| f.fee)
        .collect();
    maker.sort_unstable();
    assert_eq!(maker, [Some(amt("0.6")), Some(amt("0.62"))]);
    // Against the market maker, the customer's fee alone.
    let mm = by_reason(&taker, "trade.fill.mm_maker");
    assert_eq!(
        (mm[0].entry.amount, mm[0].fee),
        (amt("0.998"), Some(amt("0.002")))
    );
    // A fill that booked no fee says 0.
    let free = by_reason(&lines(&store, oid::FREE), "trade.fill");
    assert_eq!(
        (free[0].asset_id.as_str(), free[0].entry.amount, free[0].fee),
        ("BTC", amt("0.5"), Some(0))
    );
    let free_maker = by_reason(&lines(&store, oid::FREE_MAKER), "trade.fill");
    assert_eq!(
        (
            free_maker[0].asset_id.as_str(),
            free_maker[0].entry.amount,
            free_maker[0].fee
        ),
        ("USDT", amt("300"), Some(0))
    );
    // Every other line: none, the paying leg on an order-hold page included.
    assert!(
        taker
            .iter()
            .filter(|e| !e.entry.reason.starts_with("trade.fill"))
            .all(|e| e.fee.is_none())
    );
    let hold = hold_lines(&store, oid::TAKER, oid::TAKER_ORDER);
    assert!(hold.iter().any(|e| e.entry.reason == "trade.fill"));
    assert!(hold.iter().all(|e| e.fee.is_none()));
    store.end();
}

#[test]
fn a_buyback_fill_names_the_makers_own_ask_and_its_fee() {
    let Some((_db, store)) = orders() else { return };
    let bb = by_reason(&lines(&store, oid::BB_MAKER), "trade.fill.buyback");
    assert_eq!(bb.len(), 1);
    assert_eq!(
        (
            bb[0].asset_id.as_str(),
            bb[0].entry.direction.as_str(),
            bb[0].entry.amount,
            bb[0].fee,
            order_of(&bb[0])
        ),
        (
            "USDT",
            "debit",
            amt("299.7"),
            Some(amt("0.3")),
            Some(oid::BB_ASK)
        )
    );
    let ask = by_reason(
        &hold_lines(&store, oid::BB_MAKER, oid::BB_ASK),
        "trade.fill.buyback",
    );
    assert_eq!(ask.len(), 1);
    assert_eq!(
        (
            ask[0].asset_id.as_str(),
            ask[0].entry.direction.as_str(),
            order_of(&ask[0]),
            ask[0].fee
        ),
        ("BTC", "credit", Some(oid::BB_ASK), None)
    );
    store.end();
}

#[test]
fn order_ids_leave_paging_unchanged() {
    let Some((_db, store)) = orders() else { return };
    let all: Vec<String> = lines(&store, oid::TAKER)
        .iter()
        .map(|e| e.entry_id.clone())
        .collect();
    let (seen, _) = walk(&store, &scope(oid::TAKER, 3), 3);
    assert_eq!(
        seen.iter().map(|e| e.entry_id.clone()).collect::<Vec<_>>(),
        all
    );
    store.end();
}

// ── holdings-history-postgres.test.ts ──────────────────────────────────────────────────────────────────────────────

const H_TAKER: &str = "91111111-1111-4111-8111-111111111111";
const H_MAKER: &str = "92222222-2222-4222-8222-222222222222";
const H_BB_MAKER: &str = "94444444-4444-4444-8444-444444444444";
const DAY_MS: i64 = 86_400_000;

/// The start of the day before now, on the UTC day boundary: every movement booked here is after it.
fn day_before() -> i64 {
    (system_ms() / DAY_MS) * DAY_MS - DAY_MS
}

fn holdings_book() -> Option<(TestDb, Store)> {
    let db = migrated()?;
    book(&db, "holdings");
    // `clearOfMinuteEnd`: the transfers next share one 60 s bucket.
    let left = 60_000 - system_ms() % 60_000;
    if left < 10_000 {
        std::thread::sleep(std::time::Duration::from_millis(
            u64::try_from(left + 50).unwrap(),
        ));
    }
    book(&db, "holdingsMinute");
    let store = db.store();
    Some((db, store))
}

fn ask(owner: &str, from: i64, bucket_seconds: i64) -> HoldingsInput {
    HoldingsInput {
        owner_type: "user".to_owned(),
        owner_id: owner.to_owned(),
        from: Instant(from),
        bucket_seconds,
    }
}

fn holdings(store: &Store, owner: &str) -> HoldingsHistory {
    history::holdings_history(
        store,
        &ask(owner, day_before(), 60),
        HOLDINGS_HISTORY_MAX_ROWS,
    )
    .unwrap()
}

fn net_of(read: &HoldingsHistory, asset: &str) -> Amount {
    read.movements
        .iter()
        .filter(|m| m.asset_id == asset)
        .map(|m| m.inflow - m.outflow)
        .sum()
}

fn held_of(read: &HoldingsHistory, asset: &str) -> Amount {
    read.holdings
        .iter()
        .find(|h| h.asset_id == asset)
        .map_or(0, |h| h.amount)
}

/// `[inflow, outflow, fee]` of each row under one asset and reason.
fn flows(read: &HoldingsHistory, asset: &str, reason: &str) -> Vec<[String; 3]> {
    read.movements
        .iter()
        .filter(|m| m.asset_id == asset && m.reason == reason)
        .map(|m| {
            [
                format_amount(m.inflow),
                format_amount(m.outflow),
                format_amount(m.fee),
            ]
        })
        .collect()
}

#[test]
fn holdings_are_every_account_of_the_owner_locks_included_and_replay_to_nothing() {
    let Some((db, store)) = holdings_book() else {
        return;
    };
    let got = holdings(&store, H_TAKER);
    for asset in ["USDT", "BTC"] {
        let sum: String = db
            .client()
            .query_one(
                "SELECT COALESCE(SUM(balance), 0)::text FROM ledger.accounts WHERE owner_type = 'user' AND owner_id = $1 AND asset_id = $2",
                &[&H_TAKER, &asset],
            )
            .unwrap()
            .get(0);
        assert_eq!(held_of(&got, asset), amt(&sum), "{asset}");
    }
    assert_eq!(format_amount(held_of(&got, "BTC")), "0.00698");
    assert_eq!(format_amount(held_of(&got, "USDT")), "400");
    // Holdings less every movement since before the first one is zero.
    let maker = holdings(&store, H_MAKER);
    for asset in ["USDT", "BTC"] {
        assert_eq!(held_of(&got, asset) - net_of(&got, asset), 0, "{asset}");
        assert_eq!(held_of(&maker, asset) - net_of(&maker, asset), 0, "{asset}");
    }
    store.end();
}

#[test]
fn holdings_leave_out_moves_between_the_owners_own_accounts() {
    let Some((_db, store)) = holdings_book() else {
        return;
    };
    let got = holdings(&store, H_TAKER);
    let reasons: Vec<String> = got
        .movements
        .iter()
        .map(|m| format!("{} {}", m.asset_id, m.reason))
        .collect();
    for internal in [
        "USDT order.hold",
        "USDT order.hold.released",
        "BTC withdraw.held",
        "BTC withdraw.reversed",
    ] {
        assert!(!reasons.contains(&internal.to_owned()), "{internal}");
    }
    let deposits: Vec<String> = got
        .movements
        .iter()
        .filter(|m| m.asset_id == "USDT" && m.module != "trade" && m.inflow > 0 && m.outflow == 0)
        .map(|m| format_amount(m.inflow))
        .collect();
    assert_eq!(deposits, ["1000"]);
    let row = |a: &str, b: &str, c: &str| [a.to_owned(), b.to_owned(), c.to_owned()];
    assert_eq!(flows(&got, "USDT", "trade.fill"), [row("0", "600", "0")]);
    assert_eq!(
        flows(&got, "BTC", "trade.fill"),
        [row("0.00998", "0", "0.00002")]
    );
    assert_eq!(
        flows(&got, "BTC", "withdraw.settled"),
        [row("0", "0.003", "0")]
    );
    // Money in and money out under one reason in one bucket stay apart.
    assert_eq!(
        flows(&got, "USDT", "bank.transfer.manual"),
        [row("50", "50", "0")]
    );
    store.end();
}

#[test]
fn holdings_name_the_same_fee_as_the_page_and_only_on_the_receiving_line() {
    let Some((_db, store)) = holdings_book() else {
        return;
    };
    let got = holdings(&store, H_TAKER);
    let p = page(
        &store,
        &PageInput {
            asset_id: Some("BTC".to_owned()),
            ..scope(H_TAKER, 200)
        },
    );
    let line = p
        .entries
        .iter()
        .find(|e| e.entry.reason == "trade.fill" && e.entry.direction == "debit")
        .unwrap();
    let fill = got
        .movements
        .iter()
        .find(|m| m.asset_id == "BTC" && m.reason == "trade.fill")
        .unwrap();
    assert_eq!(Some(fill.fee), line.fee);
    for m in &got.movements {
        if !(m.asset_id == "BTC" && m.reason == "trade.fill") {
            assert_eq!(m.fee, 0, "{} {}", m.asset_id, m.reason);
        }
    }
    store.end();
}

#[test]
fn holdings_of_a_buyback_maker_and_never_another_owner() {
    let Some((_db, store)) = holdings_book() else {
        return;
    };
    let bb = holdings(&store, H_BB_MAKER);
    let row = |a: &str, b: &str, c: &str| [a.to_owned(), b.to_owned(), c.to_owned()];
    assert_eq!(
        flows(&bb, "USDT", "trade.fill.buyback"),
        [row("299.7", "0", "0.3")]
    );
    assert_eq!(
        flows(&bb, "BTC", "trade.fill.buyback"),
        [row("0", "0.5", "0")]
    );
    for asset in ["USDT", "BTC"] {
        assert_eq!(held_of(&bb, asset) - net_of(&bb, asset), 0, "{asset}");
    }
    let taker = holdings(&store, H_TAKER);
    let maker = holdings(&store, H_MAKER);
    let assets: Vec<&str> = taker.holdings.iter().map(|h| h.asset_id.as_str()).collect();
    assert_eq!(assets, ["BTC", "USDT"]);
    assert_eq!(format_amount(net_of(&maker, "BTC")), "0.99");
    assert_eq!(format_amount(held_of(&maker, "USDT")), "599.4");
    let maker_fees: Vec<Amount> = maker
        .movements
        .iter()
        .filter(|m| m.asset_id == "BTC" && m.reason == "trade.fill")
        .map(|m| m.fee)
        .collect();
    assert_eq!(maker_fees, [0]);
    store.end();
}

#[test]
fn holdings_bucket_on_the_utc_grid_asked_with_the_same_totals_and_the_same_holdings_from_any_start()
{
    let Some((_db, store)) = holdings_book() else {
        return;
    };
    let day = history::holdings_history(
        &store,
        &ask(H_TAKER, day_before(), 86_400),
        HOLDINGS_HISTORY_MAX_ROWS,
    )
    .unwrap();
    assert!(day.movements.iter().all(|m| m.bucket_start.0 % DAY_MS == 0));
    let minute = holdings(&store, H_TAKER);
    assert!(
        minute
            .movements
            .iter()
            .all(|m| m.bucket_start.0 % 60_000 == 0)
    );
    for asset in ["USDT", "BTC"] {
        assert_eq!(net_of(&day, asset), net_of(&minute, asset), "{asset}");
    }
    let this_minute = (system_ms() / 60_000) * 60_000;
    let late = history::holdings_history(
        &store,
        &ask(H_TAKER, this_minute, 60),
        HOLDINGS_HISTORY_MAX_ROWS,
    )
    .unwrap();
    assert_eq!(late.holdings, minute.holdings);
    assert!(late.movements.len() <= minute.movements.len());
    let nobody = holdings(&store, "93333333-3333-4333-8333-333333333333");
    assert!(nobody.holdings.is_empty() && nobody.movements.is_empty());
    store.end();
}

#[test]
fn holdings_refuse_more_rows_than_they_may_carry() {
    let Some((_db, store)) = holdings_book() else {
        return;
    };
    let count = holdings(&store, H_TAKER).movements.len();
    assert!(history::holdings_history(&store, &ask(H_TAKER, day_before(), 60), count).is_ok());
    let refused =
        history::holdings_history(&store, &ask(H_TAKER, day_before(), 60), count - 1).unwrap_err();
    assert_eq!(code_of(refused), HOLDINGS_TOO_LARGE);
    store.end();
}

#[test]
fn holdings_refuse_a_start_in_the_future_or_off_its_bucket() {
    let now = system_ms();
    let next_minute = (now / 60_000) * 60_000 + 60_000;
    let at = |t: &str| service_kit::time::v8_date_parse(t);
    for (from, bucket) in [
        (Some(next_minute), 60),
        (at("2026-10-01T00:00:30Z"), 60),
        (at("2026-10-01T01:00:00Z"), 86_400),
    ] {
        assert_eq!(
            code_of(history::holdings_window(from, bucket, now).unwrap_err()),
            HOLDINGS_WINDOW_INVALID
        );
    }
}

// ── holdings-history-door.test.ts, and the wire form ───────────────────────────────────────────────────────────────

fn holdings_ask(owner: &str, from: &str, bucket: i64) -> Json {
    obj(&[
        ("ownerType", Json::str("user")),
        ("ownerId", Json::str(owner)),
        ("from", Json::str(from)),
        ("bucketSeconds", Json::int(bucket)),
    ])
}

#[test]
fn the_holdings_door_names_svc_bank_alone() {
    let callers = DOOR_CALLERS
        .iter()
        .find(|(d, _)| *d == "holdingsHistory")
        .unwrap()
        .1;
    assert_eq!(callers, ["svc-bank"]);
}

#[test]
fn the_holdings_door_answers_svc_bank_with_decimal_strings_and_iso_bucket_starts() {
    let Some((db, store)) = holdings_book() else {
        return;
    };
    let from = Instant(day_before()).iso();
    let (status, wire) = doors(&db).send(
        "svc-bank",
        "holdingsHistory",
        &holdings_ask(H_TAKER, &from, 60),
    );
    assert_eq!(status, 200, "{wire:?}");
    let Json::Object(fields) = &wire else {
        panic!()
    };
    let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        keys,
        ["asOf", "from", "bucketSeconds", "holdings", "movements"]
    );
    assert_eq!(s(&wire, "from"), from);
    assert_eq!(wire.get("bucketSeconds"), Some(&Json::int(60)));
    assert!(service_kit::time::v8_date_parse(&s(&wire, "asOf")).is_some());
    let decimal = |t: &str| {
        let (whole, frac) = t.split_once('.').unwrap_or((t, "1"));
        !whole.is_empty()
            && whole.bytes().all(|b| b.is_ascii_digit())
            && (1..=18).contains(&frac.len())
            && frac.bytes().all(|b| b.is_ascii_digit())
    };
    let Some(Json::Array(held)) = wire.get("holdings") else {
        panic!()
    };
    assert_eq!(
        held.iter()
            .map(|h| (s(h, "assetId"), s(h, "amount")))
            .collect::<Vec<_>>(),
        [
            ("BTC".to_owned(), "0.00698".to_owned()),
            ("USDT".to_owned(), "400".to_owned())
        ]
    );
    let Some(Json::Array(moved)) = wire.get("movements") else {
        panic!()
    };
    assert!(!moved.is_empty());
    for m in moved {
        assert!(s(m, "bucketStart").ends_with(":00.000Z"), "{m:?}");
        for k in ["inflow", "outflow", "fee"] {
            assert!(decimal(&s(m, k)), "{k} {m:?}");
        }
    }
    // The wire is the read, field for field.
    let direct = holdings(&store, H_TAKER);
    assert_eq!(moved.len(), direct.movements.len());
    store.end();
}

#[test]
fn the_holdings_door_refuses_a_caller_it_does_not_list_and_a_window_or_owner_it_cannot_answer() {
    let Some(db) = migrated() else { return };
    let d = doors(&db);
    let user = "81111111-1111-4111-8111-111111111111";
    let ok = "2026-10-01T00:00:00.000Z";
    let (status, body) = d.send("svc-tax", "holdingsHistory", &holdings_ask(user, ok, 3_600));
    assert_eq!(
        (status, s(&body, "code")),
        (403, "ledger.caller_forbidden".to_owned())
    );
    let (status, body) = d.send(
        "svc-bank",
        "holdingsHistory",
        &holdings_ask(user, "2026-10-01T00:30:00.000Z", 3_600),
    );
    assert_eq!(
        (status, s(&body, "code")),
        (400, HOLDINGS_WINDOW_INVALID.to_owned())
    );
    assert_eq!(
        d.send("svc-bank", "holdingsHistory", &holdings_ask(user, ok, 120))
            .0,
        400
    );
    let house = obj(&[
        ("ownerType", Json::str("house")),
        ("ownerId", Json::str("fees:trade")),
        ("from", Json::str(ok)),
        ("bucketSeconds", Json::int(3_600)),
    ]);
    assert_eq!(d.send("svc-bank", "holdingsHistory", &house).0, 400);
    // A start this door can answer, for an owner with no book: nothing held, nothing moved.
    let (status, body) = d.send(
        "svc-bank",
        "holdingsHistory",
        &holdings_ask(user, ok, 3_600),
    );
    assert_eq!(status, 200, "{body:?}");
    assert_eq!(body.get("holdings"), Some(&Json::Array(Vec::new())));
    assert_eq!(body.get("movements"), Some(&Json::Array(Vec::new())));
    db.store().end();
}
