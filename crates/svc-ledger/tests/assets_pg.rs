//! The `assets` slice against a real Postgres, each test in its own throwaway database (`support`). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proofs it ports, case for case: `ledger/supported-assets.pg.test.ts` (nothing the owner has not
//! published reads as published; an edit lands only with an approval identity consumed for exactly that edit, that
//! asset and that revision; one operation id applies once; an edit approved against an older row refuses; the record
//! of who changed what is append-only) and `asset-registry-doors.test.ts` (who may knock, and what each answer looks
//! like on the wire).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::approvals::{ConsumeInput, Consumed, Replay};
use service_kit::json::{self, Json};
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::schema::Value;
use service_kit::server::{Door, Request};
use service_kit::telemetry::Logger;
use service_kit::tokens::TokenConfig;
use sha2::Sha256;
use support::TestDb;
use svc_ledger::approval::{Approvals, NOT_FOUNDERS, Refused};
use svc_ledger::assets::{
    self, EDIT_INVALID, EDIT_STALE, LIST_FILTER_INVALID, NOT_FOUND, OPERATION_CONFLICT,
    PRECISION_INVALID, PRECISION_UNSET, Refusal, edit_hash,
};
use svc_ledger::db::Store;
use svc_ledger::door::{DoorConfig, LedgerDoor};
use svc_ledger::freeze::MemoryBus;
use svc_ledger::migrate::FILES;

const REQUESTER: &str = "founder-a";
const APPROVER: &str = "founder-b";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
const TOKEN_SECRET: &str = "placeholder-ledger-assets-test-token-secret";
const SHARED: &str = "placeholder-assets-test-internal-secret";
const CONSUME_FAILED: &str = "action_approval.consume_failed";

/// A migrated database, every row unpublished and no edit applied (the TypeScript suite's `beforeEach`).
fn migrated() -> Option<TestDb> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    db.client()
        .batch_execute(
            "UPDATE ledger.assets SET precision = NULL, networks = '[]', default_network_id = NULL, allowed_actions = '{}', revision = 0",
        )
        .unwrap();
    Some(db)
}

#[derive(Clone)]
struct Proposed {
    action_type: String,
    target_id: String,
    expected_version: String,
    payload_hash: String,
    founders: bool,
    consumed_by: Option<String>,
}

/// Identity, as far as the ledger sees it: an approval binds action, target, version and payload hash, is consumed
/// once, and a retry under the same request id returns the consumed row without the founder attestation (as identity
/// does today), which the ledger then refuses.
#[derive(Default)]
struct Identity {
    rows: Mutex<BTreeMap<String, Proposed>>,
    calls: Mutex<Vec<Asked>>,
}

/// What one consume asked: approval, target service, target, payload hash, version, replay key.
type Asked = (String, String, String, String, String, Option<String>);

fn refused(message: &str) -> Refused {
    Refused::Coded {
        message: message.to_owned(),
        code: CONSUME_FAILED.to_owned(),
    }
}

impl Identity {
    fn approve(&self, approval_id: &str, edit: &Json, revision: i64) {
        self.approve_as(approval_id, edit, revision, "ledger.asset_edit", true);
    }

    fn approve_as(
        &self,
        approval_id: &str,
        edit: &Json,
        revision: i64,
        action_type: &str,
        founders: bool,
    ) {
        self.rows.lock().unwrap().insert(
            approval_id.to_owned(),
            Proposed {
                action_type: action_type.to_owned(),
                target_id: id_of(edit),
                expected_version: revision.to_string(),
                payload_hash: edit_hash(edit),
                founders,
                consumed_by: None,
            },
        );
    }

    fn versions(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.4.clone())
            .collect()
    }

    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

impl Approvals for Identity {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.calls.lock().unwrap().push((
            input.approval_id.to_owned(),
            input.target_service.to_owned(),
            input.target_id.to_owned(),
            input.payload_hash.to_owned(),
            input.expected_version.to_owned(),
            input.replay.map(|r| r.request_id.to_owned()),
        ));
        let mut rows = self.rows.lock().unwrap();
        let Some(row) = rows.get_mut(input.approval_id) else {
            return Err(refused("no such approval"));
        };
        let binds = input.target_service == "svc-ledger"
            && row.target_id == input.target_id
            && row.expected_version == input.expected_version
            && row.payload_hash == input.payload_hash;
        if !binds {
            return Err(refused("payload_mismatch"));
        }
        let request = input.replay.map(|r| r.request_id.to_owned());
        if row.consumed_by.is_some() && row.consumed_by != request {
            return Err(refused("action_approval.consumed"));
        }
        let again = row.consumed_by.is_some();
        row.consumed_by = request;
        let attested = (row.founders && !again).then_some(true);
        Ok(Consumed {
            action_type: row.action_type.clone(),
            target_service: "svc-ledger".to_owned(),
            target_id: row.target_id.clone(),
            status: "CONSUMED".to_owned(),
            requester_id: REQUESTER.to_owned(),
            approver_id: Some(APPROVER.to_owned()),
            approver_is_founder: attested,
            requester_is_founder: attested,
        })
    }
}

fn id_of(edit: &Json) -> String {
    match edit.get("id") {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn usdt() -> Json {
    json::parse(
        r#"{"id":"USDT","kind":"crypto","precision":6,"networks":[{"networkId":"tron","label":"Tron (TRC-20)"},{"networkId":"ethereum","label":"Ethereum (ERC-20)"}],"defaultNetworkId":"ethereum","allowedActions":["deposit","withdraw","trade","transfer"],"state":"active","reason":"TEST: publish USDT"}"#,
    )
    .unwrap()
}

/// `usdt({ ...over })`.
fn usdt_with(over: &[(&str, Json)]) -> Json {
    let Json::Object(mut fields) = usdt() else {
        unreachable!()
    };
    for (k, v) in over {
        match fields.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = v.clone(),
            None => fields.push(((*k).to_owned(), v.clone())),
        }
    }
    Json::Object(fields)
}

fn without(edit: &Json, key: &str) -> Json {
    let Json::Object(fields) = edit else {
        unreachable!()
    };
    Json::Object(fields.iter().filter(|(k, _)| k != key).cloned().collect())
}

fn apply_with(
    store: &Store,
    identity: &dyn Approvals,
    approval_id: &str,
    operation_id: &str,
    edit: &Json,
) -> Result<Json, Refusal> {
    let input = Json::Object(vec![
        ("approvalId".to_owned(), Json::str(approval_id)),
        ("operationId".to_owned(), Json::str(operation_id)),
        ("edit".to_owned(), edit.clone()),
    ]);
    assets::apply_edit(store, identity, "operator-1", &Value::from_json(&input))
}

fn code(r: &Result<Json, Refusal>) -> String {
    match r {
        Err(Refusal::Coded { code, .. }) => code.clone(),
        Err(Refusal::Approval(Refused::Coded { code, .. })) => code.clone(),
        Err(Refusal::Store(e)) => e.code.clone().unwrap_or_default(),
        other => panic!("not a coded refusal: {other:?}"),
    }
}

fn field<'a>(j: &'a Json, k: &str) -> &'a Json {
    j.get(k).unwrap_or(&Json::Null)
}

fn ids(rows: &[Json]) -> Vec<String> {
    rows.iter().map(id_of).collect()
}

fn list(store: &Store, filter: &str) -> Vec<Json> {
    assets::list(store, Value::from_json(&json::parse(filter).unwrap())).unwrap()
}

fn get(store: &Store, asset: &str) -> Result<Json, Refusal> {
    assets::get(
        store,
        Value::from_json(&Json::obj([("assetId", Json::str(asset))])),
    )
}

fn edits(db: &TestDb) -> i64 {
    db.count("SELECT count(*) FROM ledger.asset_edits")
}

// ── supported-assets.pg.test.ts ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn publishes_nothing_the_owner_has_not_set_and_lists_every_row_for_operators() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    assert!(list(&store, "{}").is_empty());
    assert_eq!(code(&get(&store, "USDT")), PRECISION_UNSET);
    assert_eq!(code(&get(&store, "NOPE")), NOT_FOUND);
    let operator = assets::operator_list(&store).unwrap();
    let row = operator.iter().find(|a| id_of(a) == "USDT").unwrap();
    assert_eq!(field(row, "precision"), &Json::Null);
    assert_eq!(field(row, "networks"), &Json::Array(Vec::new()));
    assert_eq!(field(row, "defaultNetworkId"), &Json::Null);
    assert_eq!(field(row, "allowedActions"), &Json::Array(Vec::new()));
    assert_eq!(field(row, "revision"), &Json::int(0));
    store.end();
}

#[test]
fn applies_an_approved_edit_once_and_records_who_decided_it() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let asset = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    // The row in the wire's shape and order, its `updatedAt` the edit's own clock in milliseconds.
    let at: String = db
        .client()
        .query_one(
            "SELECT to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM ledger.asset_edits",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        asset.compact(),
        format!(
            r#"{{"id":"USDT","kind":"crypto","precision":6,"networks":[{{"networkId":"tron","label":"Tron (TRC-20)"}},{{"networkId":"ethereum","label":"Ethereum (ERC-20)"}}],"defaultNetworkId":"ethereum","allowedActions":["deposit","withdraw","trade","transfer"],"state":"active","revision":1,"updatedAt":"{at}"}}"#
        )
    );
    assert_eq!(
        identity.calls.lock().unwrap()[0],
        (
            "ap-1".to_owned(),
            "svc-ledger".to_owned(),
            "USDT".to_owned(),
            edit_hash(&usdt()),
            "0".to_owned(),
            Some("asset-edit:USDT:1".to_owned()),
        )
    );
    assert_eq!(ids(&list(&store, "{}")), ["USDT"]);
    assert_eq!(ids(&list(&store, r#"{"action":"withdraw"}"#)), ["USDT"]);
    assert!(list(&store, r#"{"state":"halted"}"#).is_empty());
    // The read answers the same row the write did.
    assert_eq!(get(&store, "USDT").unwrap(), asset);
    let row = db
        .client()
        .query_one(
            "SELECT requester_id, approver_id, operator_id, revision FROM ledger.asset_edits",
            &[],
        )
        .unwrap();
    assert_eq!(
        (
            row.get::<_, String>(0),
            row.get::<_, String>(1),
            row.get::<_, String>(2),
            row.get::<_, i32>(3)
        ),
        (
            REQUESTER.to_owned(),
            APPROVER.to_owned(),
            "operator-1".to_owned(),
            1
        )
    );
    store.end();
}

#[test]
fn answers_a_retry_of_the_same_operation_with_the_row_without_applying_it_again() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let first = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    let reversed = usdt_with(&[(
        "networks",
        json::parse(r#"[{"networkId":"ethereum","label":"Ethereum (ERC-20)"},{"networkId":"tron","label":"Tron (TRC-20)"}]"#).unwrap(),
    )]);
    let again = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &reversed).unwrap();
    assert_eq!(again, first);
    assert_eq!(field(&again, "revision"), &Json::int(1));
    assert_eq!(identity.count(), 1);
    assert_eq!(edits(&db), 1);
    store.end();
}

#[test]
fn applies_two_concurrent_requests_for_the_same_operation_once() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    let coin = usdt_with(&[
        ("id", Json::str("NEWCOIN")),
        ("networks", Json::Array(Vec::new())),
        ("defaultNetworkId", Json::Null),
    ]);
    for (id, edit) in [("USDT", usdt()), ("NEWCOIN", coin)] {
        let (ap, op) = (format!("ap-{id}"), format!("op-{id}"));
        identity.approve(&ap, &edit, 0);
        let both: Vec<Result<Json, Refusal>> = std::thread::scope(|s| {
            let runs: Vec<_> = (0..2)
                .map(|_| s.spawn(|| apply_with(&store, &identity, &ap, &op, &edit)))
                .collect();
            runs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        // Whichever lands second either finds the applied row (a retry) or reaches identity after the consume and is
        // refused unattested. Never a second apply, never stale.
        let values: Vec<&Json> = both.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert!(!values.is_empty(), "{both:?}");
        for r in &both {
            if r.is_err() {
                assert_eq!(code(r), NOT_FOUNDERS);
            }
        }
        for v in &values {
            assert_eq!(*v, values[0]);
        }
        assert_eq!(
            &apply_with(&store, &identity, &ap, &op, &edit).unwrap(),
            values[0]
        );
    }
    assert_eq!(edits(&db), 2);
    store.end();
}

/// Applies the same operation in full the first time it is asked to consume, then answers as identity does.
struct LandsFirst<'a> {
    identity: &'a Identity,
    store: &'a Store,
    first: Mutex<bool>,
}

impl Approvals for LandsFirst<'_> {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        let first = std::mem::replace(&mut *self.first.lock().unwrap(), false);
        if first {
            apply_with(
                self.store,
                self.identity,
                "ap-1",
                "asset-edit:USDT:1",
                &usdt(),
            )
            .unwrap();
        }
        self.identity.consume(input)
    }
}

#[test]
fn asks_identity_for_the_revision_it_read_before_the_same_operation_landed() {
    // The interleaving that made the TypeScript's concurrent test flaky (#5978), forced: request B has read the row and
    // found no record of its operation, then request A applies the same operation in full, then B goes on. B asks
    // identity for revision 0, as approved, never A's revision 1, and is refused unattested like any retry.
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let racing = LandsFirst {
        identity: &identity,
        store: &store,
        first: Mutex::new(true),
    };
    let r = apply_with(&store, &racing, "ap-1", "asset-edit:USDT:1", &usdt());
    assert_eq!(code(&r), NOT_FOUNDERS);
    assert_eq!(identity.versions(), ["0", "0"]);
    assert_eq!(
        db.count("SELECT revision::bigint FROM ledger.asset_edits"),
        1
    );
    store.end();
}

#[test]
fn answers_a_retry_with_the_row_its_operation_produced_not_a_later_one() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let first = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    let eight = usdt_with(&[("precision", Json::int(8))]);
    identity.approve("ap-2", &eight, 1);
    apply_with(&store, &identity, "ap-2", "asset-edit:USDT:2", &eight).unwrap();
    let retry = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    assert_eq!(retry, first);
    assert_eq!(
        (field(&retry, "precision"), field(&retry, "revision")),
        (&Json::int(6), &Json::int(1))
    );
    assert_eq!(
        field(&get(&store, "USDT").unwrap(), "revision"),
        &Json::int(2)
    );
    store.end();
}

#[test]
fn refuses_a_list_filter_that_is_not_a_state_or_action_with_a_read_code() {
    let Some(db) = migrated() else { return };
    let store = db.store();
    let r = assets::list(
        &store,
        Value::from_json(&json::parse(r#"{"state":"frozen"}"#).unwrap()),
    );
    assert!(matches!(r, Err(Refusal::Coded { ref code, .. }) if code == LIST_FILTER_INVALID));
    store.end();
}

#[test]
fn fails_closed_after_a_lost_reply_and_the_approval_must_be_given_again() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    // Identity consumed for this request, then the ledger crashed before its transaction.
    let hash = edit_hash(&usdt());
    identity
        .consume(&ConsumeInput {
            approval_id: "ap-1",
            operation_id: "asset-edit:USDT:1",
            payload_hash: &hash,
            target_service: "svc-ledger",
            target_id: "USDT",
            expected_version: "0",
            replay: Some(Replay {
                request_id: "asset-edit:USDT:1",
                consumer_principal_id: None,
            }),
        })
        .unwrap();
    let r = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt());
    assert_eq!(code(&r), NOT_FOUNDERS);
    assert!(list(&store, "{}").is_empty());
    identity.approve("ap-2", &usdt(), 0);
    let fresh = apply_with(&store, &identity, "ap-2", "asset-edit:USDT:2", &usdt()).unwrap();
    assert_eq!(field(&fresh, "revision"), &Json::int(1));
    store.end();
}

#[test]
fn refuses_an_operation_id_used_for_another_edit_and_changes_nothing() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    let eight = usdt_with(&[("precision", Json::int(8))]);
    let r = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &eight);
    assert_eq!(code(&r), OPERATION_CONFLICT);
    assert_eq!(
        field(&get(&store, "USDT").unwrap(), "precision"),
        &Json::int(6)
    );
    store.end();
}

#[test]
fn refuses_an_edit_that_is_not_the_approved_one() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let two = usdt_with(&[("precision", Json::int(2))]);
    let r = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &two);
    assert!(
        matches!(r, Err(Refusal::Approval(Refused::Coded { ref message, ref code })) if code == CONSUME_FAILED && message == "payload_mismatch")
    );
    assert!(list(&store, "{}").is_empty());
    store.end();
}

#[test]
fn refuses_an_approval_without_a_distinct_founder_pair_attested() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve_as("ap-1", &usdt(), 0, "ledger.asset_edit", false);
    let r = apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt());
    assert_eq!(code(&r), NOT_FOUNDERS);
    identity.approve_as("ap-2", &usdt(), 0, "ledger.freeze", true);
    let r = apply_with(&store, &identity, "ap-2", "asset-edit:USDT:2", &usdt());
    assert_eq!(code(&r), NOT_FOUNDERS);
    assert!(list(&store, "{}").is_empty());
    store.end();
}

#[test]
fn refuses_an_edit_approved_against_an_older_revision_once_another_has_landed() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    let eight = usdt_with(&[("precision", Json::int(8))]);
    identity.approve("ap-1", &usdt(), 0);
    identity.approve("ap-2", &eight, 0);
    apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    // ap-2 was approved at revision 0; the row is now at 1, so identity's version binding refuses it.
    let r = apply_with(&store, &identity, "ap-2", "asset-edit:USDT:2", &eight);
    assert_eq!(code(&r), CONSUME_FAILED);
    let halted = usdt_with(&[("precision", Json::int(8)), ("state", Json::str("halted"))]);
    identity.approve("ap-3", &halted, 1);
    let applied = apply_with(&store, &identity, "ap-3", "asset-edit:USDT:3", &halted).unwrap();
    assert_eq!(
        (
            field(&applied, "precision"),
            field(&applied, "state"),
            field(&applied, "revision")
        ),
        (&Json::int(8), &Json::str("halted"), &Json::int(2))
    );
    assert!(list(&store, r#"{"state":"active"}"#).is_empty());
    store.end();
}

/// Consumes as identity does, then moves the row before the write.
struct MovesTheRow<'a> {
    identity: &'a Identity,
    db: &'a TestDb,
}

impl Approvals for MovesTheRow<'_> {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        let consumed = self.identity.consume(input)?;
        self.db
            .client()
            .batch_execute("UPDATE ledger.assets SET revision = revision + 1 WHERE id = 'USDT'")
            .unwrap();
        Ok(consumed)
    }
}

#[test]
fn refuses_as_stale_when_the_row_moved_between_the_approval_and_the_write() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let racing = MovesTheRow {
        identity: &identity,
        db: &db,
    };
    let r = apply_with(&store, &racing, "ap-1", "asset-edit:USDT:1", &usdt());
    assert_eq!(code(&r), EDIT_STALE);
    assert_eq!(edits(&db), 0);
    store.end();
}

#[test]
fn adds_a_new_asset_at_revision_1_active() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    let coin = usdt_with(&[
        ("id", Json::str("NEWCOIN")),
        ("precision", Json::int(4)),
        ("networks", Json::Array(Vec::new())),
        ("defaultNetworkId", Json::Null),
        ("allowedActions", Json::Array(vec![Json::str("trade")])),
    ]);
    identity.approve("ap-new", &coin, 0);
    let added = apply_with(&store, &identity, "ap-new", "asset-edit:NEWCOIN:1", &coin).unwrap();
    assert_eq!(
        (
            id_of(&added),
            field(&added, "precision"),
            field(&added, "revision")
        ),
        ("NEWCOIN".to_owned(), &Json::int(4), &Json::int(1))
    );
    let row = db
        .client()
        .query_one(
            "SELECT precision, active, kind::text FROM ledger.assets WHERE id = 'NEWCOIN'",
            &[],
        )
        .unwrap();
    assert_eq!(
        (
            row.get::<_, i32>(0),
            row.get::<_, bool>(1),
            row.get::<_, String>(2)
        ),
        (4, true, "crypto".to_owned())
    );
    store.end();
}

#[test]
fn refuses_a_change_of_kind_and_a_blank_or_out_of_range_precision_before_asking_identity() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    let apply = |edit: &Json| apply_with(&store, &identity, "ap-1", "op-1", edit);
    assert_eq!(
        code(&apply(&usdt_with(&[("kind", Json::str("fiat"))]))),
        EDIT_INVALID
    );
    assert_eq!(
        code(&apply(&without(&usdt(), "precision"))),
        PRECISION_UNSET
    );
    assert_eq!(
        code(&apply(&usdt_with(&[("precision", Json::int(19))]))),
        PRECISION_INVALID
    );
    assert_eq!(
        code(&apply(&usdt_with(&[(
            "defaultNetworkId",
            Json::str("solana")
        )]))),
        "ledger.asset_default_network_not_listed"
    );
    assert_eq!(identity.count(), 0);
    store.end();
}

#[test]
fn keeps_the_record_of_edits_append_only() {
    let Some(db) = migrated() else { return };
    let (store, identity) = (db.store(), Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    apply_with(&store, &identity, "ap-1", "asset-edit:USDT:1", &usdt()).unwrap();
    let mut c = db.client();
    for sql in [
        "UPDATE ledger.asset_edits SET operator_id = 'someone-else'",
        "DELETE FROM ledger.asset_edits",
        "TRUNCATE ledger.asset_edits",
    ] {
        let err = c.batch_execute(sql).unwrap_err();
        assert!(format!("{err:?}").contains("append-only"), "{sql}: {err:?}");
    }
    assert_eq!(edits(&db), 1);
    store.end();
}

// ── asset-registry-doors.test.ts ────────────────────────────────────────────────────────────────────────────────────

struct Shared(Arc<Identity>);

impl Approvals for Shared {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.0.consume(input)
    }
}

fn door(db: &TestDb, identity: Arc<Identity>) -> LedgerDoor {
    LedgerDoor::new(DoorConfig {
        approvals: Box::new(Shared(identity)),
        ..door_parts(db)
    })
    .unwrap()
}

fn bearer(scopes: &[&str], mfa: bool) -> String {
    let now = system_seconds();
    let b64 = |j: Json| URL_SAFE_NO_PAD.encode(j.compact());
    let header = b64(Json::obj([
        ("alg", Json::str("HS256")),
        ("typ", Json::str("JWT")),
    ]));
    let claims = b64(Json::obj([
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("basic")),
        ("mfa", Json::Bool(mfa)),
        ("sid", Json::str("33333333-3333-4333-8333-333333333333")),
        ("sub", Json::str(OPERATOR)),
        ("iss", Json::str("intafaced")),
        ("aud", Json::str("intafaced.api")),
        ("iat", Json::int(now)),
        ("exp", Json::int(now + 900)),
        ("jti", Json::str("44444444-4444-4444-8444-444444444444")),
    ]));
    let mut mac = Hmac::<Sha256>::new_from_slice(TOKEN_SECRET.as_bytes()).unwrap();
    mac.update(format!("{header}.{claims}").as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("Bearer {header}.{claims}.{sig}")
}

/// One request to the door: its status and parsed body.
fn call(
    door: &LedgerDoor,
    method: &str,
    url: &str,
    auth: Option<String>,
    body: Option<&Json>,
) -> (u16, Json) {
    let text = body.map(Json::compact).unwrap_or_default();
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(a) = auth {
        headers.push(("authorization".to_owned(), a));
    }
    if body.is_some() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = door.handle_as(
        &Request {
            method,
            url,
            headers: &headers,
            body: &text,
        },
        "req-1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

/// A service door, called with the shared secret as `service`.
fn s2s_call(door: &LedgerDoor, service: &str, path: &str, body: &Json) -> (u16, Json) {
    let text = body.compact();
    let mut headers = s2s::legacy_headers(service, SHARED, &text, system_seconds()).unwrap();
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_as(
        &Request {
            method: "POST",
            url: path,
            headers: &headers,
            body: &text,
        },
        "req-1",
    );
    (res.status, json::parse(&res.body).unwrap())
}

fn code_of(body: &Json) -> &str {
    match body.get("code") {
        Some(Json::String(s)) => s,
        _ => "",
    }
}

#[test]
fn the_service_doors_list_and_get_for_a_reader_and_refuse_unknown_and_unpublished_as_400() {
    let Some(db) = migrated() else { return };
    let identity = Arc::new(Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let applied = apply_with(
        &db.store(),
        &*identity,
        "ap-1",
        "asset-edit:USDT:1",
        &usdt(),
    )
    .unwrap();
    db.client()
        .batch_execute("INSERT INTO ledger.assets (id, kind) VALUES ('BLANK', 'crypto')")
        .unwrap();
    let d = door(&db, identity);
    let (status, body) = s2s_call(
        &d,
        "svc-bank",
        "/trpc/assetsList",
        &json::parse(r#"{"action":"withdraw"}"#).unwrap(),
    );
    assert_eq!(
        (status, body),
        (
            200,
            Json::Object(vec![(
                "assets".to_owned(),
                Json::Array(vec![applied.clone()])
            )])
        )
    );
    let get = |asset: &str| {
        s2s_call(
            &d,
            "svc-pay",
            "/trpc/assetsGet",
            &Json::obj([("assetId", Json::str(asset))]),
        )
    };
    assert_eq!(get("USDT"), (200, applied));
    let (status, body) = get("NOPE");
    assert_eq!((status, code_of(&body)), (400, NOT_FOUND));
    assert_eq!(
        body.get("message"),
        Some(&Json::str("No asset NOPE is registered"))
    );
    let (status, body) = get("BLANK");
    assert_eq!((status, code_of(&body)), (400, PRECISION_UNSET));
    let (status, body) = s2s_call(
        &d,
        "svc-bank",
        "/trpc/assetsList",
        &json::parse(r#"{"state":"frozen"}"#).unwrap(),
    );
    assert_eq!((status, code_of(&body)), (400, LIST_FILTER_INVALID));
    d.end();
}

#[test]
fn the_operator_doors_refuse_without_treasury_and_a_second_factor_and_apply_nothing() {
    let Some(db) = migrated() else { return };
    let identity = Arc::new(Identity::default());
    identity.approve("ap-1", &usdt(), 0);
    let d = door(&db, identity.clone());
    assert_eq!(call(&d, "GET", "/operator/assets", None, None).0, 401);
    let body = Json::Object(vec![
        ("approvalId".to_owned(), Json::str("ap-1")),
        ("operationId".to_owned(), Json::str("op-1")),
        ("edit".to_owned(), usdt()),
    ]);
    for auth in [
        bearer(&["admin:treasury"], false),
        bearer(&["admin:read"], true),
    ] {
        let (status, _) = call(
            &d,
            "POST",
            "/operator/assets/apply-edit",
            Some(auth),
            Some(&body),
        );
        assert!((401..500).contains(&status), "{status}");
    }
    assert_eq!(identity.count(), 0);
    assert_eq!(edits(&db), 0);
    d.end();
}

#[test]
fn the_operator_doors_list_every_row_apply_as_the_signed_in_operator_and_answer_stale_and_reused_with_409()
 {
    let Some(db) = migrated() else { return };
    let identity = Arc::new(Identity::default());
    let d = door(&db, identity.clone());
    let auth = || Some(bearer(&["admin:treasury"], true));
    let (status, listed) = call(&d, "GET", "/operator/assets", auth(), None);
    assert_eq!(status, 200);
    let Some(Json::Array(rows)) = listed.get("assets") else {
        panic!("{listed:?}")
    };
    let usdt_row = rows.iter().find(|r| id_of(r) == "USDT").unwrap();
    assert_eq!(field(usdt_row, "precision"), &Json::Null);

    let send = |ap: &str, op: &str, edit: &Json| {
        let body = Json::Object(vec![
            ("approvalId".to_owned(), Json::str(ap)),
            ("operationId".to_owned(), Json::str(op)),
            ("edit".to_owned(), edit.clone()),
        ]);
        call(
            &d,
            "POST",
            "/operator/assets/apply-edit",
            auth(),
            Some(&body),
        )
    };
    identity.approve("ap-1", &usdt(), 0);
    let (status, applied) = send("ap-1", "op-1", &usdt());
    assert_eq!((status, field(&applied, "revision")), (200, &Json::int(1)));
    let operator: String = db
        .client()
        .query_one("SELECT operator_id FROM ledger.asset_edits", &[])
        .unwrap()
        .get(0);
    assert_eq!(operator, OPERATOR);

    // Reused: the same operation id for another edit.
    let eight = usdt_with(&[("precision", Json::int(8))]);
    let (status, body) = send("ap-1", "op-1", &eight);
    assert_eq!((status, code_of(&body)), (409, OPERATION_CONFLICT));
    // Stale: approved at revision 1, and the row moved before the write.
    identity.approve("ap-2", &eight, 1);
    let racing = LedgerDoor::new(DoorConfig {
        approvals: Box::new(MovesTheRowOwned {
            identity: identity.clone(),
            url: db.url.clone(),
        }),
        ..door_parts(&db)
    })
    .unwrap();
    let body = Json::Object(vec![
        ("approvalId".to_owned(), Json::str("ap-2")),
        ("operationId".to_owned(), Json::str("op-2")),
        ("edit".to_owned(), eight.clone()),
    ]);
    let (status, body) = call(
        &racing,
        "POST",
        "/operator/assets/apply-edit",
        auth(),
        Some(&body),
    );
    assert_eq!((status, code_of(&body)), (409, EDIT_STALE));
    // A refused approval answers 400 with identity's code; an input that is not an edit, the edit's own code.
    let (status, body) = send("ap-9", "op-9", &eight);
    assert_eq!((status, code_of(&body)), (400, CONSUME_FAILED));
    let (status, body) = send("ap-9", "op-9", &without(&eight, "precision"));
    assert_eq!((status, code_of(&body)), (400, PRECISION_UNSET));
    assert_eq!(edits(&db), 1);
    d.end();
    racing.end();
}

fn door_parts(db: &TestDb) -> DoorConfig {
    DoorConfig {
        internal_secret: SHARED.to_owned(),
        body_bind: BodyBind::Require,
        keys: None,
        tokens: TokenConfig {
            secret: TOKEN_SECRET.to_owned(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store: db.store(),
        service_name: "svc-ledger".to_owned(),
        bus: Arc::new(MemoryBus::default()),
        approvals: Box::new(svc_ledger::approval::Unwired),
        clock_skew_bound_ms: None,
        now_ms: svc_ledger::clock::system_ms,
        log: Logger::new("info", Box::new(std::io::sink())),
        custody: svc_ledger::reconcile::CustodyLayer::On,
        reconcile_statement_timeout_ms: svc_ledger::reconcile::DEFAULT_STATEMENT_TIMEOUT_MS,
        indexer_url: None,
        fetch: Arc::new(service_kit::http::UreqFetch::new()),
        posting: support::idle_posting(),
    }
}

/// [`MovesTheRow`], owning what it holds, for a door.
struct MovesTheRowOwned {
    identity: Arc<Identity>,
    url: String,
}

impl Approvals for MovesTheRowOwned {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        let consumed = self.identity.consume(input)?;
        postgres::Client::connect(&self.url, postgres::NoTls)
            .unwrap()
            .batch_execute("UPDATE ledger.assets SET revision = revision + 1 WHERE id = 'USDT'")
            .unwrap();
        Ok(consumed)
    }
}
