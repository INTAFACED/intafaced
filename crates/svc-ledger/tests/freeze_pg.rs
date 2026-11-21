//! The `freeze` slice against a real Postgres, each test in its own throwaway database (`support`). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proofs it ports, case for case, on the parts this slice owns (a `post()` refused by the freeze is
//! the `posting` slice's): `service.freeze.test.ts` (the switch is the database's, attribution sticks, every move is
//! told once, the database refuses an unattributed freeze), `clock-skew.test.ts` ("clock skew against postgres" and
//! the clock door), `operator-http.test.ts` ("freeze surface still gates correctly") and `four-eyes-unfreeze.test.ts`
//! at the door. Two pools over one database stand for two replicas.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use service_kit::json::Json;
use support::TestDb;
use support::operator::{OPERATOR, Shared, bearer, call, code, door_config, stub, treasury};
use svc_ledger::approval::{self, Approvals};
use svc_ledger::boot;
use svc_ledger::clock::{self, SKEW_BOUND_UNSET, WRITES_BLOCKED_CLOCK_SKEW, system_ms};
use svc_ledger::db::{Store, with_client};
use svc_ledger::door::{DoorConfig, LedgerDoor};
use svc_ledger::freeze::{self, Command, FreezeRelay, MemoryBus, SUBJECT};
use svc_ledger::migrate::FILES;
use svc_ledger::status::{self, FreezeState, read_freeze};

const CHECKER: &str = "22222222-2222-4222-8222-222222222222";
const APPROVER: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    Some(db)
}

fn relay(bus: &MemoryBus) -> FreezeRelay<'_> {
    FreezeRelay {
        bus,
        producer: "svc-ledger".to_owned(),
        now_ms: system_ms,
    }
}

fn halt<'a>(reason: &'a str, actor: &'a str) -> Command<'a> {
    Command::Freeze { reason, actor }
}

fn thaw<'a>(actor: &'a str, confirm: &'a str) -> Command<'a> {
    Command::Thaw {
        actor,
        confirm_operator_id: Some(confirm),
    }
}

fn state(store: &Store) -> FreezeState {
    with_client(store.pool().unwrap(), read_freeze).unwrap()
}

fn emitted(bus: &MemoryBus) -> Vec<Json> {
    bus.emitted(SUBJECT)
}

fn payload_of(env: &Json) -> (Json, Json, Json) {
    let p = env.get("payload").unwrap();
    (
        p.get("frozen").cloned().unwrap(),
        p.get("reason").cloned().unwrap(),
        p.get("actor").cloned().unwrap(),
    )
}

fn outbox(db: &TestDb) -> Vec<(String, String, bool)> {
    db.client()
        .query(
            "SELECT idempotency_key, switch_seq::text, published_at IS NOT NULL FROM ledger.ledger_freeze_outbox ORDER BY switch_seq",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect()
}

// ── service.freeze.test.ts ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_freeze_is_a_fact_about_the_ledger_and_a_thaw_on_another_pool_releases_it() {
    let Some(db) = migrated() else { return };
    let (a, b) = (db.store(), db.store());
    let (bus_a, bus_b) = (MemoryBus::default(), MemoryBus::default());
    freeze::switch(&a, &relay(&bus_a), halt("drift", OPERATOR)).unwrap();
    // A pool that never heard the call reads the freeze, with its reason, from the book.
    let seen = status::status(&b).unwrap();
    assert!(!seen.posting_enabled);
    assert_eq!(seen.frozen_reason.as_deref(), Some("drift"));
    assert_eq!(seen.frozen_by.as_deref(), Some(OPERATOR));
    // A fresh pool (a restart) still reads it.
    assert!(state(&db.store()).frozen);

    freeze::switch(&b, &relay(&bus_b), thaw(OPERATOR, CHECKER)).unwrap();
    assert!(status::status(&a).unwrap().posting_enabled);
    a.end();
    b.end();
}

#[test]
fn a_second_freeze_with_another_attribution_is_refused_at_the_write() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    freeze::write(&store, halt("operator halt", OPERATOR)).unwrap();
    let refused = freeze::write(
        &db.store(),
        halt("reconciliation mismatch", "reconciliation"),
    )
    .unwrap_err();
    assert_eq!(refused.code.as_deref(), Some("ledger.freeze_attributed"));
    let now = state(&store);
    assert_eq!(
        (now.frozen, now.reason.as_deref(), now.actor.as_deref()),
        (true, Some("operator halt"), Some(OPERATOR))
    );
    store.end();
}

#[test]
fn the_service_freeze_refuses_a_clobber_and_the_first_reason_stands() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    freeze::switch(
        &store,
        &relay(&bus),
        halt("operator: suspected drift", OPERATOR),
    )
    .unwrap();
    let refused = freeze::switch(
        &store,
        &relay(&bus),
        halt("reconciliation mismatch", "reconciliation"),
    )
    .unwrap_err();
    assert_eq!(refused.code.as_deref(), Some("ledger.freeze_attributed"));
    assert_eq!(
        refused.message,
        format!(
            "Ledger already frozen by {OPERATOR}: operator: suspected drift — refusing to overwrite with reconciliation: reconciliation mismatch (STOP §4.2b #3)"
        )
    );
    assert_eq!(
        state(&store).reason.as_deref(),
        Some("operator: suspected drift")
    );
    assert_eq!(emitted(&bus).len(), 1);
    store.end();
}

#[test]
fn a_same_attribution_refreeze_is_a_true_no_op() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    let first = freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    let again = freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    assert_eq!(again, first);
    assert_eq!(emitted(&bus).len(), 1);
    assert_eq!(outbox(&db).len(), 1);
    store.end();
}

#[test]
fn a_thaw_of_an_open_book_is_a_true_no_op() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    let before = state(&store);
    assert!(!before.frozen);
    let again = freeze::switch(&store, &relay(&bus), thaw(OPERATOR, CHECKER)).unwrap();
    assert_eq!(again, before);
    assert!(emitted(&bus).is_empty());
    assert!(outbox(&db).is_empty());
    store.end();
}

#[test]
fn both_directions_are_told_with_who_and_why() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    freeze::switch(&store, &relay(&bus), thaw(OPERATOR, CHECKER)).unwrap();
    let sent = emitted(&bus);
    assert_eq!(sent.len(), 2);
    assert_eq!(
        payload_of(&sent[0]),
        (Json::Bool(true), Json::str("drift"), Json::str(OPERATOR))
    );
    assert_eq!(
        payload_of(&sent[1]),
        (Json::Bool(false), Json::Null, Json::str(OPERATOR))
    );
    assert_eq!(
        sent[0].get("subject"),
        Some(&Json::str("intafaced.ledger.freeze.updated"))
    );
    assert_eq!(sent[0].get("producer"), Some(&Json::str("svc-ledger")));
    store.end();
}

#[test]
fn the_change_is_timestamped_by_the_database() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    let before: f64 = db
        .client()
        .query_one("SELECT extract(epoch FROM now())::float8 * 1000", &[])
        .unwrap()
        .get(0);
    freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    let (iso, at): (String, f64) = {
        let r = db
            .client()
            .query_one(
                "SELECT to_char(changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), floor(extract(epoch FROM changed_at) * 1000)::float8 FROM ledger.posting_freeze",
                &[],
            )
            .unwrap();
        (r.get(0), r.get(1))
    };
    let sent = emitted(&bus);
    assert_eq!(
        sent[0].get("payload").unwrap().get("changedAt"),
        Some(&Json::str(iso))
    );
    assert!(at >= before.floor());
    store.end();
}

#[test]
fn a_failed_publish_stays_in_the_outbox_and_the_same_attribution_retry_emits_it_once() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    bus.failing.store(true, Ordering::SeqCst);
    let failed = freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap_err();
    assert_eq!(failed.message, "bus down");
    let frozen = state(&store);
    assert_eq!(
        (
            frozen.frozen,
            frozen.reason.as_deref(),
            frozen.actor.as_deref()
        ),
        (true, Some("drift"), Some(OPERATOR))
    );
    assert!(emitted(&bus).is_empty());
    let pending = outbox(&db);
    assert_eq!(pending.len(), 1);
    assert!(!pending[0].2);
    assert_eq!(pending[0].0, format!("ledger.freeze:seq:{}", pending[0].1));

    bus.failing.store(false, Ordering::SeqCst);
    let again = freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    assert_eq!(again, frozen);
    let sent = emitted(&bus);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].get("payload").unwrap().get("changedAt"),
        Some(&Json::str(frozen.changed_at.clone()))
    );
    assert_eq!(
        sent[0].get("idempotencyKey"),
        Some(&Json::str(pending[0].0.clone()))
    );

    let third = freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    assert_eq!(third.changed_at_precise, frozen.changed_at_precise);
    assert_eq!(emitted(&bus).len(), 1);
    assert!(outbox(&db)[0].2);
    store.end();
}

#[test]
fn a_failed_thaw_publish_retries_once_and_does_not_thaw_again() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    freeze::write(&store, halt("drift", OPERATOR)).unwrap();
    bus.failing.store(true, Ordering::SeqCst);
    assert_eq!(
        freeze::switch(&store, &relay(&bus), thaw(OPERATOR, CHECKER))
            .unwrap_err()
            .message,
        "bus down"
    );
    let thawed = state(&store);
    assert_eq!(
        (
            thawed.frozen,
            thawed.reason.as_deref(),
            thawed.actor.as_deref()
        ),
        (false, None, Some(OPERATOR))
    );

    bus.failing.store(false, Ordering::SeqCst);
    let again = freeze::switch(&store, &relay(&bus), thaw(OPERATOR, CHECKER)).unwrap();
    assert_eq!(again, thawed);
    // Both committed intents went out, oldest first: the freeze, then the thaw.
    let sent = emitted(&bus);
    assert_eq!(sent.len(), 2);
    assert_eq!(
        payload_of(&sent[1]),
        (Json::Bool(false), Json::Null, Json::str(OPERATOR))
    );
    let rows = outbox(&db);
    assert_eq!(
        sent[1].get("idempotencyKey"),
        Some(&Json::str(rows[1].0.clone()))
    );

    freeze::switch(&store, &relay(&bus), thaw(OPERATOR, CHECKER)).unwrap();
    assert_eq!(emitted(&bus).len(), 2);
    assert_eq!(state(&store).changed_at_precise, thawed.changed_at_precise);
    store.end();
}

#[test]
fn the_outbox_recovery_emits_a_pending_freeze_without_a_second_switch() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    bus.failing.store(true, Ordering::SeqCst);
    freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap_err();
    let frozen = state(&store);

    bus.failing.store(false, Ordering::SeqCst);
    let r = relay(&bus);
    assert_eq!(boot::recover_outbox(&store, &[&r]).unwrap(), 1);
    let sent = emitted(&bus);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].get("idempotencyKey"),
        Some(&Json::str(outbox(&db)[0].0.clone()))
    );
    assert_eq!(state(&store), frozen);

    assert_eq!(boot::recover_outbox(&store, &[&r]).unwrap(), 0);
    freeze::switch(&store, &r, halt("drift", OPERATOR)).unwrap();
    assert_eq!(emitted(&bus).len(), 1);
    store.end();
}

#[test]
fn the_envelope_is_keyed_on_the_switch_sequence_and_a_fast_thaw_keeps_its_own_key() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let bus = MemoryBus::default();
    freeze::switch(&store, &relay(&bus), halt("drift", OPERATOR)).unwrap();
    let rows = outbox(&db);
    assert_eq!(
        emitted(&bus)[0].get("idempotencyKey"),
        Some(&Json::str(format!("ledger.freeze:seq:{}", rows[0].1)))
    );
    freeze::switch(&store, &relay(&bus), thaw(OPERATOR, CHECKER)).unwrap();
    let keys: Vec<Json> = emitted(&bus)
        .iter()
        .map(|e| e.get("idempotencyKey").cloned().unwrap())
        .collect();
    assert_eq!(keys.len(), 2);
    assert_ne!(keys[0], keys[1]);
    store.end();
}

#[test]
fn a_refused_thaw_moves_nothing_and_writes_no_intent() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    freeze::write(&store, halt("drift", OPERATOR)).unwrap();
    let before = state(&store);
    for (actor, confirm, message) in [
        (
            CHECKER,
            OPERATOR,
            "the operator who froze posting cannot be the one who clears it",
        ),
        (
            CHECKER,
            " ",
            "confirming operator identity is required; the ledger does not invent a second caller",
        ),
        (
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            " AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ",
            "confirming operator must be a distinct identity; the ledger does not invent a second caller",
        ),
    ] {
        let refused = freeze::write(&store, thaw(actor, confirm)).unwrap_err();
        assert_eq!(
            (refused.code.as_deref(), refused.message.as_str()),
            (Some("missing_operator"), message)
        );
    }
    assert_eq!(state(&store), before);
    assert_eq!(outbox(&db).len(), 1);
    store.end();
}

#[test]
fn the_database_refuses_an_unattributed_freeze() {
    let Some(db) = migrated() else { return };
    let err = db
        .client()
        .batch_execute("UPDATE ledger.posting_freeze SET frozen = true WHERE id = true")
        .unwrap_err();
    assert!(
        format!("{err:?}").contains("posting_freeze_attributed_ck"),
        "{err:?}"
    );
}

// ── clock-skew.test.ts, "clock skew against postgres" ────────────────────────────────────────────────────────────

fn a_minute_ahead() -> i64 {
    system_ms() + 60_000
}

#[test]
fn a_blank_bound_refuses_and_an_explicit_zero_blocks_a_shifted_app_clock() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let unset = clock::clock_skew(&store, None, system_ms).unwrap();
    assert_eq!(
        (unset.ok, unset.code, unset.bound_ms),
        (false, Some(SKEW_BOUND_UNSET), None)
    );
    let wide = clock::clock_skew(&store, Some(86_400_000), system_ms).unwrap();
    assert_eq!((wide.ok, wide.code), (true, None));
    assert_eq!(wide.json().get("boundMs"), Some(&Json::str("86400000")));
    let blocked = clock::clock_skew(&store, Some(0), a_minute_ahead).unwrap();
    assert_eq!(
        (blocked.ok, blocked.code),
        (false, Some(WRITES_BLOCKED_CLOCK_SKEW))
    );
    assert!(blocked.skew_ms >= 59_000, "{}", blocked.skew_ms);
    store.end();
}

// ── The doors: operator-http.test.ts, four-eyes-unfreeze.test.ts ──────────────────────────────────────────────────

fn door(
    db: &TestDb,
    bus: Arc<MemoryBus>,
    approvals: Box<dyn Approvals>,
    bound: Option<i64>,
    now_ms: fn() -> i64,
) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        clock_skew_bound_ms: bound,
        now_ms,
        ..door_config(db, bus, approvals)
    })
    .unwrap()
}

#[test]
fn reading_the_freeze_needs_treasury_with_a_second_factor_and_names_its_version() {
    let Some(db) = migrated() else { return };
    let d = door(
        &db,
        Arc::default(),
        Box::new(approval::Unwired),
        None,
        system_ms,
    );
    assert_eq!(call(&d, "GET", "/operator/freeze", None, "").0, 401);
    assert_eq!(
        call(
            &d,
            "GET",
            "/operator/freeze",
            Some(bearer(&["admin:treasury"], false)),
            ""
        )
        .0,
        401
    );
    let (status, body) = call(&d, "GET", "/operator/freeze", treasury(), "");
    assert_eq!(status, 200);
    let row = state(d.store());
    assert_eq!(
        body,
        Json::obj([
            ("frozen", Json::Bool(false)),
            ("reason", Json::Null),
            ("actor", Json::Null),
            ("changedAt", Json::str(row.changed_at)),
            ("version", Json::str(row.changed_at_precise)),
        ])
    );
}

#[test]
fn a_freeze_needs_a_usable_reason_and_spends_an_approval_bound_to_it() {
    let Some(db) = migrated() else { return };
    let bus = Arc::new(MemoryBus::default());
    let approvals = stub(Some(APPROVER), None);
    let d = door(
        &db,
        bus.clone(),
        Box::new(Shared(approvals.clone())),
        None,
        system_ms,
    );
    for reason in [
        r#"{"reason":"too short"}"#,
        r#"{"reason":""}"#,
        r#"{"reason":"            ","approvalId":"a","operationId":"o"}"#,
    ] {
        let (status, body) = call(&d, "POST", "/operator/freeze", treasury(), reason);
        assert_eq!(
            (status, code(&body)),
            (400, Some("ledger.operator_request_failed"))
        );
    }
    assert!(approvals.seen.lock().unwrap().is_empty());
    assert!(!state(d.store()).frozen);

    let prior = state(d.store());
    let (status, body) = call(
        &d,
        "POST",
        "/operator/freeze",
        treasury(),
        r#"{"reason":"  suspected USDT chain drift  ","approvalId":"appr-1","operationId":"op-1"}"#,
    );
    assert_eq!(status, 200, "{body:?}");
    let now = state(d.store());
    assert_eq!(body.get("frozen"), Some(&Json::Bool(true)));
    assert_eq!(
        body.get("reason"),
        Some(&Json::str("suspected USDT chain drift"))
    );
    assert_eq!(body.get("actor"), Some(&Json::str(OPERATOR)));
    assert_eq!(body.get("confirmOperatorId"), Some(&Json::str(APPROVER)));
    assert_eq!(
        body.get("version"),
        Some(&Json::str(now.changed_at_precise.clone()))
    );
    // The approval was bound to the trimmed reason, the target and the version the door read first.
    assert_eq!(
        approvals.seen.lock().unwrap()[0],
        (
            "appr-1".to_owned(),
            "op-1".to_owned(),
            approval::payload_hash("ledger.freeze", &[("reason", "suspected USDT chain drift")]),
            "posting_freeze".to_owned(),
            prior.changed_at_precise
        )
    );
    assert_eq!(emitted(&bus).len(), 1);
}

#[test]
fn a_service_secret_or_another_scope_cannot_open_the_freeze_door() {
    let Some(db) = migrated() else { return };
    let approvals = stub(Some(APPROVER), None);
    let d = door(
        &db,
        Arc::default(),
        Box::new(Shared(approvals.clone())),
        None,
        system_ms,
    );
    let body = r#"{"reason":"suspected USDT chain drift","approvalId":"a","operationId":"o"}"#;
    assert_eq!(call(&d, "POST", "/operator/freeze", None, body).0, 401);
    assert_eq!(
        call(
            &d,
            "POST",
            "/operator/freeze",
            Some(bearer(&["admin:write"], true)),
            body
        )
        .0,
        403
    );
    assert!(approvals.seen.lock().unwrap().is_empty());
    assert!(!state(d.store()).frozen);
}

#[test]
fn a_standing_freeze_by_another_answers_409_and_keeps_its_reason() {
    let Some(db) = migrated() else { return };
    let d = door(
        &db,
        Arc::default(),
        Box::new(Shared(stub(Some(APPROVER), None))),
        None,
        system_ms,
    );
    freeze::write(d.store(), halt("reconciliation mismatch", "reconciliation")).unwrap();
    let (status, body) = call(
        &d,
        "POST",
        "/operator/freeze",
        treasury(),
        r#"{"reason":"operator: suspected USDT drift","approvalId":"appr-1","operationId":"op-1"}"#,
    );
    assert_eq!(
        (status, code(&body)),
        (409, Some("ledger.freeze_attributed"))
    );
    assert_eq!(
        state(d.store()).reason.as_deref(),
        Some("reconciliation mismatch")
    );
}

#[test]
fn a_freeze_or_thaw_without_approval_ids_refuses_and_writes_nothing() {
    let Some(db) = migrated() else { return };
    let approvals = stub(Some(APPROVER), Some(true));
    let d = door(
        &db,
        Arc::default(),
        Box::new(Shared(approvals.clone())),
        None,
        system_ms,
    );
    for body in [
        r#"{"reason":"suspected USDT chain drift"}"#.to_owned(),
        format!(r#"{{"reason":"suspected USDT chain drift","confirmOperatorId":"{OPERATOR}"}}"#),
    ] {
        let (status, b) = call(&d, "POST", "/operator/freeze", treasury(), &body);
        assert_eq!(
            (status, code(&b)),
            (400, Some("ledger.operator_request_failed"))
        );
    }
    assert!(!state(d.store()).frozen);

    freeze::write(d.store(), halt("drift", CHECKER)).unwrap();
    for body in [
        "{}".to_owned(),
        format!(r#"{{"confirmOperatorId":"{OPERATOR}"}}"#),
        String::new(),
    ] {
        let (status, b) = call(&d, "POST", "/operator/unfreeze", treasury(), &body);
        assert_eq!(
            (status, code(&b)),
            (400, Some("ledger.operator_request_failed"))
        );
    }
    // Blank ids after the trim are not an approval either.
    let (status, b) = call(
        &d,
        "POST",
        "/operator/unfreeze",
        treasury(),
        r#"{"approvalId":" ","operationId":"op-1"}"#,
    );
    assert_eq!((status, code(&b)), (400, Some("action_approval.missing")));
    assert!(approvals.seen.lock().unwrap().is_empty());
    assert!(state(d.store()).frozen);

    let prior = state(d.store());
    let (status, b) = call(
        &d,
        "POST",
        "/operator/unfreeze",
        treasury(),
        r#"{"approvalId":"appr-1","operationId":"op-1"}"#,
    );
    assert_eq!(status, 200, "{b:?}");
    assert_eq!(b.get("frozen"), Some(&Json::Bool(false)));
    assert_eq!(b.get("reason"), Some(&Json::Null));
    assert_eq!(b.get("confirmOperatorId"), Some(&Json::str(APPROVER)));
    // The thaw is bound to the empty payload, its target and the version the door read first, as the stack's
    // proposal binds it (tooling/scripts/local-test-gates.test.mjs).
    assert_eq!(
        approvals.seen.lock().unwrap()[0],
        (
            "appr-1".to_owned(),
            "op-1".to_owned(),
            approval::payload_hash("ledger.unfreeze", &[]),
            "posting_unfreeze".to_owned(),
            prior.changed_at_precise
        )
    );
}

#[test]
fn a_thaw_needs_a_founder_pair_and_never_the_freezer_as_the_second_person() {
    let Some(db) = migrated() else { return };
    let body = r#"{"approvalId":"appr-1","operationId":"op-1"}"#;
    // No attestation: the founder-audience thaw is refused and the book stays frozen.
    let d = door(
        &db,
        Arc::default(),
        Box::new(Shared(stub(Some(APPROVER), None))),
        None,
        system_ms,
    );
    freeze::write(d.store(), halt("drift", CHECKER)).unwrap();
    let (status, b) = call(&d, "POST", "/operator/unfreeze", treasury(), body);
    assert_eq!(
        (status, code(&b)),
        (400, Some("action_approval.not_founders"))
    );
    assert!(state(d.store()).frozen);

    // Founders, but the approver is the one who froze the book.
    let d = door(
        &db,
        Arc::default(),
        Box::new(Shared(stub(Some(CHECKER), Some(true)))),
        None,
        system_ms,
    );
    let (status, b) = call(&d, "POST", "/operator/unfreeze", treasury(), body);
    assert_eq!((status, code(&b)), (400, Some("missing_operator")));
    assert_eq!(
        b.get("message"),
        Some(&Json::str(
            "the operator who froze posting cannot be the one who clears it"
        ))
    );
    assert!(state(d.store()).frozen);
}

#[test]
fn without_identity_no_freeze_is_approved() {
    let Some(db) = migrated() else { return };
    let d = door(
        &db,
        Arc::default(),
        Box::new(approval::Unwired),
        None,
        system_ms,
    );
    let (status, b) = call(
        &d,
        "POST",
        "/operator/freeze",
        treasury(),
        r#"{"reason":"suspected USDT chain drift","approvalId":"a","operationId":"o"}"#,
    );
    assert_eq!(
        (status, code(&b)),
        (400, Some("action_approval.identity_unwired"))
    );
    assert!(!state(d.store()).frozen);
}

#[test]
fn a_freeze_whose_publish_fails_answers_the_failure_with_the_switch_moved_and_its_intent_kept() {
    let Some(db) = migrated() else { return };
    let bus = Arc::new(MemoryBus::default());
    bus.failing.store(true, Ordering::SeqCst);
    let d = door(
        &db,
        bus.clone(),
        Box::new(Shared(stub(Some(APPROVER), None))),
        None,
        system_ms,
    );
    let (status, b) = call(
        &d,
        "POST",
        "/operator/freeze",
        treasury(),
        r#"{"reason":"suspected USDT chain drift","approvalId":"a","operationId":"o"}"#,
    );
    assert_eq!(
        (status, b.get("message"), code(&b)),
        (
            400,
            Some(&Json::str("bus down")),
            Some("ledger.operator_request_failed")
        )
    );
    assert!(state(d.store()).frozen);
    assert!(!outbox(&db)[0].2);
}

#[test]
fn the_clock_door_answers_412_unset_503_past_the_bound_and_200_within_it() {
    let Some(db) = migrated() else { return };
    let d = door(
        &db,
        Arc::default(),
        Box::new(approval::Unwired),
        None,
        system_ms,
    );
    assert_eq!(
        call(&d, "GET", "/operator/integrity/clock", None, "").0,
        401
    );
    let (status, b) = call(&d, "GET", "/operator/integrity/clock", treasury(), "");
    assert_eq!((status, code(&b)), (412, Some(SKEW_BOUND_UNSET)));
    assert_eq!(b.get("boundMs"), Some(&Json::Null));
    let keys: Vec<String> = match &b {
        Json::Object(f) => f.iter().map(|(k, _)| k.clone()).collect(),
        _ => Vec::new(),
    };
    assert_eq!(
        keys,
        ["ok", "code", "boundMs", "skewMs", "appNow", "databaseNow"]
    );

    let d = door(
        &db,
        Arc::default(),
        Box::new(approval::Unwired),
        Some(0),
        a_minute_ahead,
    );
    let (status, b) = call(&d, "GET", "/operator/integrity/clock", treasury(), "");
    assert_eq!((status, code(&b)), (503, Some(WRITES_BLOCKED_CLOCK_SKEW)));
    assert_eq!(b.get("boundMs"), Some(&Json::str("0")));

    let d = door(
        &db,
        Arc::default(),
        Box::new(approval::Unwired),
        Some(86_400_000),
        system_ms,
    );
    let (status, b) = call(&d, "GET", "/operator/integrity/clock", treasury(), "");
    assert_eq!((status, b.get("ok")), (200, Some(&Json::Bool(true))));
    assert_eq!(b.get("code"), Some(&Json::Null));
}
