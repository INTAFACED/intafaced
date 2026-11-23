//! Slice `ops-desk` against the Rust door on a real Postgres. Ports the checks of the TypeScript's suites that fall on
//! the desk's calls, each test named after the TypeScript test's words: `ops/asset-pause.db`, `partner/partner-stops.db`,
//! `ops/transfer-health.db`, `ops/customer-balances`, and the desk's halves of `transfers/transfer-terms.db` and
//! `transfers/limit-requests.db` (their store halves are `transfers_terms_db`'s). Every call enters through the door, as
//! the TypeScript drives the router; the stop the partner asks before a move is slice `partner`'s
//! (`custody::assert_stop_open`), called here as the partner calls it.
//!
//! Not ported, with the reason: the loan and auto-invest halves of `asset-pause.db` (a borrow pause refusing
//! `loans.open`, a supply pause refusing auto-invest) are slices `loans`' and `automations`'; its earn deposit half is
//! `earn_db`'s; its unreadable-state check is the readers' (`earn`'s `assert_supply_open`). The audit line's words and
//! a log sink that throws (`customer-balances`, `transfer-health`) are the process's stdout, which a test of the door
//! cannot capture or break; the line is written before any read by the same code path the tests drive.
//!
//! The ledger is a stand-in that answers balances and history pages per owner and can fail its page reads or never end
//! them; identity is a stand-in for handles and for the operator's approvals, each bound to one action and its fields
//! and consumed once. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding, random_uuid,
};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{self, Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, HistoryEntry, HistoryPage, HistoryRequest, Ledger, LedgerAccount,
    LedgerBalance, Lookup, Lookups,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::{HandleUnavailable, PartyHandles};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-ops-desk-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-ops-desk-db-internal-secret-long-ok";
const ADA: &str = "11111111-1111-4111-8111-111111111111";
const BOB: &str = "22222222-2222-4222-8222-222222222222";
const CARA: &str = "33333333-3333-4333-8333-333333333333";
const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
const REASON: &str = "TEST: oracle incident on this asset";
const PARTNER: &str = "test-partner";
const HOUR: i64 = 60 * 60 * 1000;

fn uuid() -> String {
    random_uuid().unwrap()
}

fn now_ms() -> i64 {
    door::system_now().0
}

fn iso_ago(ms: i64) -> String {
    Instant(now_ms() - ms).iso()
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

#[derive(Default)]
struct BookState {
    balances: BTreeMap<(String, String), Vec<LedgerBalance>>,
    pages: BTreeMap<(String, String), Vec<HistoryEntry>>,
    pages_fail: bool,
    pages_endless: bool,
    asked: Vec<String>,
}

/// svc-ledger's reads for the desk: balances per owner and their `available` history, a page of two at a time.
#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

impl Book {
    fn balance(
        &self,
        owner_type: &str,
        owner: &str,
        asset: &str,
        kind: &str,
        purpose: &str,
        amount: &str,
    ) {
        self.0
            .lock()
            .unwrap()
            .balances
            .entry((owner_type.to_owned(), owner.to_owned()))
            .or_default()
            .push(LedgerBalance {
                asset_id: asset.to_owned(),
                kind: kind.to_owned(),
                purpose: purpose.to_owned(),
                amount: amt(amount),
            });
    }
    fn entry(
        &self,
        owner_type: &str,
        owner: &str,
        tx: &str,
        dir: &str,
        amount: &str,
        at: &str,
        id: Option<&str>,
    ) {
        self.0
            .lock()
            .unwrap()
            .pages
            .entry((owner_type.to_owned(), owner.to_owned()))
            .or_default()
            .push(HistoryEntry {
                tx_id: tx.to_owned(),
                module: "bank".to_owned(),
                reason: "x".to_owned(),
                direction: dir.to_owned(),
                amount: amt(amount),
                posted_at: at.to_owned(),
                asset_id: "USDT".to_owned(),
                entry_id: id.map(str::to_owned),
            });
    }
    fn asked(&self) -> Vec<String> {
        self.0.lock().unwrap().asked.clone()
    }
}

impl Ledger for Book {
    fn balance(&self, account: &LedgerAccount) -> Result<Amount, String> {
        let st = self.0.lock().unwrap();
        Ok(st
            .balances
            .get(&(account.owner_type.to_owned(), account.owner_id.clone()))
            .map_or(0, |rows| {
                rows.iter()
                    .filter(|r| r.asset_id == account.asset_id && r.kind == account.kind)
                    .map(|r| r.amount)
                    .sum()
            }))
    }
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<LedgerBalance>, String> {
        let mut st = self.0.lock().unwrap();
        st.asked.push(format!("{owner_type}:{owner_id}"));
        Ok(st
            .balances
            .get(&(owner_type.to_owned(), owner_id.to_owned()))
            .cloned()
            .unwrap_or_default())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Ok(Vec::new())
    }
    fn history_page(&self, r: &HistoryRequest<'_>) -> Result<HistoryPage, String> {
        let st = self.0.lock().unwrap();
        if st.pages_fail {
            return Err("svc-ledger historyPage answered 503".to_owned());
        }
        if st.pages_endless {
            return Ok(HistoryPage {
                entries: Vec::new(),
                next_cursor: Some("more".to_owned()),
            });
        }
        let all = st
            .pages
            .get(&(r.owner_type.to_owned(), r.owner_id.to_owned()))
            .cloned()
            .unwrap_or_default();
        let from: usize = r.cursor.map_or(0, |c| c.parse().unwrap());
        let to = (from + 2).min(all.len());
        Ok(HistoryPage {
            entries: all[from..to].to_vec(),
            next_cursor: (to < all.len()).then(|| to.to_string()),
        })
    }
}

/// `memoryPartyHandles`.
struct Handles(BTreeMap<String, String>);

impl PartyHandles for Handles {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable> {
        Ok(self.0.get(user_id).cloned())
    }
}

/// `deskApprovals()`: an approval is bound to one action and one set of fields, and is consumed once.
#[derive(Clone, Default)]
struct Desk(Arc<Mutex<DeskState>>);

#[derive(Default)]
struct DeskState {
    issued: BTreeMap<String, (String, String)>,
    used: BTreeSet<String>,
    consumed: usize,
}

fn kv(fields: &[(&str, &str)]) -> Vec<(String, String)> {
    fields
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

impl Desk {
    /// The approval's ids, as the desk sends them with the change.
    fn issue(&self, action: &str, fields: &[(&str, &str)]) -> Vec<(&'static str, Json)> {
        let id = uuid();
        self.0.lock().unwrap().issued.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, &kv(fields))),
        );
        vec![
            ("approvalId", Json::str(id)),
            ("operationId", Json::str(uuid())),
        ]
    }
    fn consumed(&self) -> usize {
        self.0.lock().unwrap().consumed
    }
}

impl Approvals for Desk {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        _principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut st = self.0.lock().unwrap();
        let refused = || ConsumeError::Refused("approval does not match this change".to_owned());
        let (action, hash) = st
            .issued
            .get(input.approval_id)
            .cloned()
            .ok_or_else(refused)?;
        if hash != input.payload_hash
            || input.target_id != action
            || st.used.contains(input.approval_id)
        {
            return Err(refused());
        }
        st.used.insert(input.approval_id.to_owned());
        st.consumed += 1;
        Ok((
            Consumed {
                action_type: action.clone(),
                target_service: "svc-bank".to_owned(),
                target_id: action,
                status: "CONSUMED".to_owned(),
                requester_id: OPERATOR.to_owned(),
                approver_id: Some(APPROVER.to_owned()),
                approver_is_founder: Some(true),
                requester_is_founder: Some(true),
            },
            Facts {
                kind: None,
                expires_at: Instant(now_ms() + 60_000).iso(),
            },
        ))
    }
}

struct NoPeople;

impl Directory for NoPeople {
    fn handles_of(&self, _ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Ok(BTreeMap::new())
    }
    fn find_active(&self, _q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Ok(None)
    }
}

/// svc-ledger's posting freeze: open, frozen for a cause, or unreadable.
struct FreezeAs(Option<Option<&'static str>>);

impl Freeze for FreezeAs {
    fn read(&self) -> Result<FreezeReading, String> {
        match self.0 {
            None => Err("svc-ledger /health did not answer".to_owned()),
            Some(None) => Ok(FreezeReading {
                posting_enabled: true,
                cause: None,
            }),
            Some(Some(c)) => Ok(FreezeReading {
                posting_enabled: false,
                cause: Some(c.to_owned()),
            }),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    desk: Desk,
}

fn door_for(db: &TestDb, b: &Book, desk: &Desk, handles: bool, freeze: FreezeAs) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.approvals = Box::new(desk.clone());
    if handles {
        transfers.handles = Some(Box::new(Handles(
            [(ADA, "ada"), (BOB, "bob")]
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        )));
    }
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: door::system_now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: None,
        freeze: Box::new(freeze),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(b.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("10".to_owned()),
            unlock_wait_hours: Some("24".to_owned()),
        },
        terms: Terms {
            invite_minutes: None,
            people_cap: None,
            card_programme: ("card-sim".to_owned(), true),
        },
        tables: Tables {
            account_terms: None,
            currencies: None,
            plans: None,
            fees: None,
            dormancy: None,
        },
    })
    .with_transfers(transfers)
}

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let desk = Desk::default();
    let door = door_for(&db, &ledger, &desk, true, FreezeAs(Some(None)));
    Some(Bank {
        door,
        db,
        ledger,
        desk,
    })
}

impl Bank {
    /// The same database, book and desk with other wiring (`services(null)`, another freeze).
    fn rewired(&self, handles: bool, freeze: FreezeAs) -> BankDoor {
        door_for(&self.db, &self.ledger, &self.desk, handles, freeze)
    }
    fn sql(&self, q: &str) {
        self.db.client().batch_execute(q).unwrap();
    }
    fn count(&self, q: &str) -> i64 {
        self.db.count(q)
    }
    /// A named space of one person, in USDT.
    fn space(&self, user: &str, name: &str) -> String {
        let id = uuid();
        self.sql(&format!(
            "INSERT INTO bank.spaces (id, user_id, asset_id, kind, name) VALUES ('{id}', '{user}', 'USDT', 'named', '{name}')"
        ));
        id
    }
    /// A monthly standing order of 25 USDT between two spaces.
    fn schedule(&self, user: &str, from: &str, to: &str) -> String {
        let id = uuid();
        self.sql(&format!(
            "INSERT INTO bank.scheduled_transfers (id, user_id, asset_id, from_space_id, to_space_id, amount, cadence, \
               starts_at, next_run_at, status) \
             VALUES ('{id}', '{user}', 'USDT', '{from}', '{to}', '25', 'monthly', now(), now(), 'active')"
        ));
        id
    }
    fn execution(
        &self,
        id: &str,
        schedule: &str,
        n: i64,
        amount: &str,
        status: &str,
        code: Option<&str>,
        ledger: Option<&str>,
        at: &str,
    ) {
        let q = |v: Option<&str>| v.map_or_else(|| "NULL".to_owned(), |s| format!("'{s}'"));
        let settled = if status == "settled" {
            format!("'{at}'")
        } else {
            "NULL".to_owned()
        };
        self.sql(&format!(
            "INSERT INTO bank.transfer_executions (id, schedule_id, occurrence, amount, status, rejection_code, \
               ledger_tx_id, attempted_at, settled_at) \
             VALUES ('{id}', '{schedule}', {n}, '{amount}', '{status}'::bank.execution_status, {}, {}, '{at}'::timestamptz, {settled}::timestamptz)",
            q(code),
            q(ledger)
        ));
    }
}

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("99999999-9999-4999-8999-999999999999")),
        ("userId", Json::str(user)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct Answer(u16, Json);

impl Answer {
    fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    fn data(&self, k: &str) -> Option<Json> {
        self.1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get(k))
            .cloned()
    }
    /// The tRPC code (`rejects.toMatchObject({ code })`).
    fn trpc(&self) -> String {
        match self.data("code") {
            Some(Json::String(c)) => c,
            _ => format!("ok: {}", self.1.compact()),
        }
    }
    /// `rejects.toMatchObject({ cause: { code } })`.
    fn cause(&self) -> String {
        match self.data("cause").and_then(|c| c.get("code").cloned()) {
            Some(Json::String(c)) => c,
            _ => format!("no cause: {} {}", self.0, self.1.compact()),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn send_to(door: &BankDoor, path: &str, input: &Json, user: &str, scopes: &[&str]) -> Answer {
    let input = input.compact();
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(&input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input),
    };
    let mut headers = person(user, scopes);
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-ops-desk-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    send_to(&b.door, path, input, user, scopes)
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn with_ids(mut fields: Vec<(&str, Json)>, ids: Vec<(&'static str, Json)>) -> Json {
    fields.extend(ids);
    obj(&fields)
}

fn s(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn arr(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(a) => a.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

fn code_of(r: Result<(), Refusal>) -> String {
    match r {
        Ok(()) => "open".to_owned(),
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        Err(other) => format!("{other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// ops/asset-pause.db.test.ts

const PAUSE: &str = "bank.ops.setAssetPause";

/// `pause(bank, approvals, asset, borrow, supply, expectedRevision, reason)`: an approval issued for this change.
fn pause(b: &Bank, asset: &str, borrow: bool, supply: bool, expected: i64, reason: &str) -> Answer {
    let ids = b.desk.issue(
        PAUSE,
        &[
            ("assetId", asset),
            ("borrowPaused", &borrow.to_string()),
            ("supplyPaused", &supply.to_string()),
            ("revision", &(expected + 1).to_string()),
        ],
    );
    pause_with(b, asset, borrow, supply, expected, reason, ids)
}

fn pause_with(
    b: &Bank,
    asset: &str,
    borrow: bool,
    supply: bool,
    expected: i64,
    reason: &str,
    ids: Vec<(&'static str, Json)>,
) -> Answer {
    call(
        b,
        OPERATOR,
        &["admin:treasury"],
        "ops.setAssetPause",
        &with_ids(
            vec![
                ("assetId", Json::str(asset)),
                ("borrowPaused", Json::Bool(borrow)),
                ("supplyPaused", Json::Bool(supply)),
                ("expectedRevision", Json::int(expected)),
                ("reason", Json::str(reason)),
            ],
            ids,
        ),
    )
}

#[test]
fn desk_read_starts_empty_names_the_three_owners_and_a_read_only_operator_cannot_change_anything() {
    let Some(b) = bank() else { return };
    let desk = call(&b, OPERATOR, &["admin:read"], "ops.assetPauses", &obj(&[])).ok();
    assert_eq!(
        desk.compact(),
        r#"{"owners":{"assetPause":"svc-bank","postingFreeze":"svc-ledger","accountFreeze":"svc-identity"},"assets":[],"history":[]}"#
    );
    let change = obj(&[
        ("assetId", Json::str("BTC")),
        ("borrowPaused", Json::Bool(true)),
        ("supplyPaused", Json::Bool(false)),
        ("expectedRevision", Json::int(0)),
        ("reason", Json::str(REASON)),
    ]);
    assert_eq!(
        call(&b, OPERATOR, &["admin:read"], "ops.setAssetPause", &change).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call(&b, ADA, &["bank:read"], "ops.assetPauses", &obj(&[])).trpc(),
        "FORBIDDEN"
    );
}

#[test]
fn a_history_read_with_no_page_size_refuses_rather_than_defaulting_one() {
    let Some(b) = bank() else { return };
    let a = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.assetPauses",
        &obj(&[("historyFor", Json::str("BTC"))]),
    );
    assert_eq!(
        (a.trpc(), a.cause()),
        (
            "BAD_REQUEST".to_owned(),
            "bank.validation_failed".to_owned()
        )
    );
}

#[test]
fn a_change_with_no_second_person_is_refused_and_writes_nothing() {
    let Some(b) = bank() else { return };
    let none = pause_with(&b, "BTC", true, false, 0, REASON, Vec::new());
    assert_eq!(
        (none.trpc(), none.cause()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "action_approval.missing".to_owned()
        )
    );
    // An approval issued for a different state does not authorise this one.
    let other = b.desk.issue(
        PAUSE,
        &[
            ("assetId", "BTC"),
            ("borrowPaused", "true"),
            ("supplyPaused", "false"),
            ("revision", "1"),
        ],
    );
    let wrong = pause_with(&b, "BTC", true, true, 0, REASON, other);
    assert_eq!(wrong.cause(), "action_approval.consume_failed");
    assert_eq!(b.count("SELECT count(*) FROM bank.asset_pauses"), 0);
    assert_eq!(b.count("SELECT count(*) FROM bank.asset_pause_history"), 0);
}

#[test]
fn a_reason_shorter_than_10_characters_refuses_before_any_approval_is_consumed() {
    let Some(b) = bank() else { return };
    let a = pause(&b, "BTC", true, false, 0, "short");
    assert_eq!(
        (a.trpc(), a.cause()),
        (
            "BAD_REQUEST".to_owned(),
            "bank.ops_reason_too_short".to_owned()
        )
    );
    assert_eq!(b.desk.consumed(), 0);
}

#[test]
fn records_the_change_with_its_approver_and_business_key_a_retry_replays_a_different_change_on_the_same_revision_conflicts()
 {
    let Some(b) = bank() else { return };
    let first = pause(&b, "BTC", true, false, 0, REASON).ok();
    assert_eq!(
        [
            s(&first, "assetId"),
            s(&first, "borrowPaused"),
            s(&first, "supplyPaused"),
            s(&first, "revision"),
            s(&first, "approvedBy"),
            s(&first, "replayed")
        ],
        ["BTC", "true", "false", "1", APPROVER, "false"]
    );
    assert_ne!(s(&first, "updatedAt"), "null");

    let again = pause(&b, "BTC", true, false, 0, REASON).ok();
    assert_eq!(
        (
            s(&again, "revision"),
            s(&again, "replayed"),
            s(&again, "updatedAt")
        ),
        ("1".to_owned(), "true".to_owned(), "null".to_owned())
    );
    assert_eq!(b.desk.consumed(), 1);

    assert_eq!(pause(&b, "BTC", true, true, 0, REASON).trpc(), "CONFLICT");
    // A stale revision is the loser of a concurrent toggle.
    let stale = pause(&b, "BTC", false, false, 5, REASON);
    assert_eq!(
        (stale.trpc(), stale.cause()),
        (
            "CONFLICT".to_owned(),
            "bank.ops_revision_conflict".to_owned()
        )
    );

    let desk = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.assetPauses",
        &obj(&[
            ("historyFor", Json::str("BTC")),
            ("historyLimit", Json::int(10)),
        ]),
    )
    .ok();
    let assets = arr(desk.get("assets").unwrap());
    assert_eq!(assets.len(), 1);
    assert_eq!(
        (
            s(&assets[0], "assetId"),
            s(&assets[0], "borrowPaused"),
            s(&assets[0], "revision")
        ),
        ("BTC".to_owned(), "true".to_owned(), "1".to_owned())
    );
    let history = arr(desk.get("history").unwrap());
    assert_eq!(history.len(), 1);
    assert_eq!(
        (
            s(&history[0], "revision"),
            s(&history[0], "changeKey"),
            s(&history[0], "approvedBy")
        ),
        (
            "1".to_owned(),
            "ops-pause:BTC:1".to_owned(),
            APPROVER.to_owned()
        )
    );

    let second = pause(&b, "BTC", false, false, 1, REASON).ok();
    assert_eq!(
        (s(&second, "revision"), s(&second, "borrowPaused")),
        ("2".to_owned(), "false".to_owned())
    );
    // The pause the readers ask: earn's deposit check reads the row this wrote.
    assert_eq!(
        b.count(
            "SELECT count(*) FROM bank.asset_pauses WHERE asset_id = 'BTC' AND NOT borrow_paused"
        ),
        1
    );
}

#[test]
fn two_operators_toggling_the_same_revision_at_once_one_change_one_ops_revision_conflict() {
    let Some(b) = bank() else { return };
    let answers: Vec<Answer> = std::thread::scope(|sc| {
        let one = sc.spawn(|| pause(&b, "ETH", true, false, 0, REASON));
        let two = sc.spawn(|| pause(&b, "ETH", false, true, 0, REASON));
        vec![one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(
        answers.iter().filter(|a| a.0 == 200).count(),
        1,
        "{answers:?}"
    );
    let lost = answers.iter().find(|a| a.0 != 200).unwrap();
    assert_eq!(
        (lost.trpc(), lost.cause()),
        (
            "CONFLICT".to_owned(),
            "bank.ops_revision_conflict".to_owned()
        )
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.asset_pause_history WHERE asset_id = 'ETH'"),
        1
    );
}

// ---------------------------------------------------------------------------------------------------------------
// partner/partner-stops.db.test.ts, through the desk's calls

const STOP: &str = "bank.ops.setPartnerStop";

fn stop(b: &Bank, kinds: &[&str], expected: i64, reason: &str) -> Answer {
    let mut sorted: Vec<&str> = [
        "bank_move",
        "card_hold",
        "card_capture",
        "card_release",
        "card_refund",
    ]
    .into_iter()
    .filter(|k| kinds.contains(k))
    .collect();
    sorted.dedup();
    let ids = b.desk.issue(
        STOP,
        &[
            ("partnerId", PARTNER),
            ("stoppedKinds", &sorted.join(",")),
            ("revision", &(expected + 1).to_string()),
        ],
    );
    stop_with(b, kinds, expected, reason, ids)
}

fn stop_with(
    b: &Bank,
    kinds: &[&str],
    expected: i64,
    reason: &str,
    ids: Vec<(&'static str, Json)>,
) -> Answer {
    call(
        b,
        OPERATOR,
        &["admin:treasury"],
        "ops.setPartnerStop",
        &with_ids(
            vec![
                ("partnerId", Json::str(PARTNER)),
                (
                    "stoppedKinds",
                    Json::Array(kinds.iter().map(|k| Json::str(*k)).collect()),
                ),
                ("expectedRevision", Json::int(expected)),
                ("reason", Json::str(reason)),
            ],
            ids,
        ),
    )
}

const STOP_REASON: &str = "TEST wrong instructions seen";

#[test]
fn never_stopped_reads_open_at_revision_0_a_stop_refuses_only_the_kinds_it_names() {
    let Some(b) = bank() else { return };
    let desk = call(&b, OPERATOR, &["admin:read"], "ops.partnerStops", &obj(&[])).ok();
    assert_eq!(
        desk.compact(),
        r#"{"kinds":["bank_move","card_hold","card_capture","card_release","card_refund"],"partners":[],"history":[]}"#
    );
    let store = b.db.store();
    assert_eq!(
        code_of(custody::assert_stop_open(&store, PARTNER, "bank_move")),
        "open"
    );
    let set = stop(&b, &["card_capture", "bank_move"], 0, STOP_REASON).ok();
    assert_eq!(
        [
            s(&set, "stoppedKinds"),
            s(&set, "revision"),
            s(&set, "approvedBy"),
            s(&set, "replayed")
        ],
        [r#"["bank_move","card_capture"]"#, "1", APPROVER, "false"]
    );
    assert_eq!(
        code_of(custody::assert_stop_open(&store, PARTNER, "bank_move")),
        "bank.partner_stopped"
    );
    assert_eq!(
        code_of(custody::assert_stop_open(&store, PARTNER, "card_capture")),
        "bank.partner_stopped"
    );
    assert_eq!(
        code_of(custody::assert_stop_open(&store, PARTNER, "card_hold")),
        "open"
    );
    // Another partner is not stopped by this one's row.
    assert_eq!(
        code_of(custody::assert_stop_open(
            &store,
            "other-partner",
            "bank_move"
        )),
        "open"
    );
}

#[test]
fn a_change_needs_the_second_person_a_failed_approval_writes_nothing() {
    let Some(b) = bank() else { return };
    let ids = b.desk.issue(
        STOP,
        &[
            ("partnerId", PARTNER),
            ("stoppedKinds", "card_hold"),
            ("revision", "1"),
        ],
    );
    let refused = stop_with(&b, &["card_capture", "bank_move"], 0, STOP_REASON, ids);
    assert_eq!(
        (refused.trpc(), refused.cause()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "action_approval.consume_failed".to_owned()
        )
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.partner_stops"), 0);
    assert_eq!(b.count("SELECT count(*) FROM bank.partner_stop_history"), 0);
}

#[test]
fn the_same_change_replays_without_a_second_approval_a_different_change_on_the_same_revision_conflicts()
 {
    let Some(b) = bank() else { return };
    stop(&b, &["card_capture", "bank_move"], 0, STOP_REASON).ok();
    // The same kinds in another order are the same change; its retry needs no approval.
    let replay = stop_with(
        &b,
        &["bank_move", "card_capture"],
        0,
        STOP_REASON,
        Vec::new(),
    )
    .ok();
    assert_eq!(
        (s(&replay, "revision"), s(&replay, "replayed")),
        ("1".to_owned(), "true".to_owned())
    );
    assert_eq!(b.desk.consumed(), 1);
    assert_eq!(
        stop(&b, &["card_hold"], 0, STOP_REASON).cause(),
        "bank.ops_revision_conflict"
    );
    assert_eq!(
        stop(&b, &["card_capture", "bank_move"], 5, STOP_REASON).cause(),
        "bank.ops_revision_conflict"
    );
}

#[test]
fn two_operators_on_the_same_revision_make_one_change_and_one_conflict() {
    let Some(b) = bank() else { return };
    let answers: Vec<Answer> = std::thread::scope(|sc| {
        let one = sc.spawn(|| stop(&b, &["bank_move"], 0, STOP_REASON));
        let two = sc.spawn(|| stop(&b, &["card_hold"], 0, STOP_REASON));
        vec![one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(
        answers.iter().filter(|a| a.0 == 200).count(),
        1,
        "{answers:?}"
    );
    assert_eq!(
        answers.iter().find(|a| a.0 != 200).unwrap().cause(),
        "bank.ops_revision_conflict"
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.partner_stops WHERE revision = 1"),
        1
    );
}

#[test]
fn refuses_a_short_reason_and_an_unknown_kind_before_asking_for_approval() {
    let Some(b) = bank() else { return };
    assert_eq!(
        stop(&b, &["bank_move"], 0, "short").cause(),
        "bank.ops_reason_too_short"
    );
    // An unknown kind never reaches the desk: the input check refuses it.
    assert_eq!(stop(&b, &["wire"], 0, STOP_REASON).trpc(), "BAD_REQUEST");
    assert_eq!(b.desk.consumed(), 0);
}

#[test]
fn lifting_is_a_change_too_and_the_history_keeps_each_one_under_its_business_key_newest_first() {
    let Some(b) = bank() else { return };
    stop(&b, &["card_capture", "bank_move"], 0, STOP_REASON).ok();
    stop(&b, &[], 1, "TEST partner confirmed the fix").ok();
    assert_eq!(
        code_of(custody::assert_stop_open(
            &b.db.store(),
            PARTNER,
            "bank_move"
        )),
        "open"
    );
    let desk = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.partnerStops",
        &obj(&[
            ("historyFor", Json::str(PARTNER)),
            ("historyLimit", Json::int(10)),
        ]),
    )
    .ok();
    let history: Vec<[String; 3]> = arr(desk.get("history").unwrap())
        .iter()
        .map(|h| [s(h, "revision"), s(h, "changeKey"), s(h, "stoppedKinds")])
        .collect();
    assert_eq!(
        history,
        vec![
            [
                "2".to_owned(),
                "ops-partner-stop:test-partner:2".to_owned(),
                "[]".to_owned()
            ],
            [
                "1".to_owned(),
                "ops-partner-stop:test-partner:1".to_owned(),
                r#"["bank_move","card_capture"]"#.to_owned()
            ],
        ]
    );
    let partners = arr(desk.get("partners").unwrap());
    assert_eq!(
        (s(&partners[0], "stoppedKinds"), s(&partners[0], "revision")),
        ("[]".to_owned(), "2".to_owned())
    );
    // A history read with no page size refuses, as the pause's does.
    assert_eq!(
        call(
            &b,
            OPERATOR,
            &["admin:read"],
            "ops.partnerStops",
            &obj(&[("historyFor", Json::str(PARTNER))])
        )
        .cause(),
        "bank.validation_failed"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// partner/partner-refusals.ts: the desk's read of what the stops refused

#[test]
fn the_desk_reads_the_freeze_the_stops_and_what_each_refused_by_reason_over_the_days_it_names() {
    let Some(b) = bank() else { return };
    // Nothing ever refused: no first day, no counts, posting enabled.
    let empty = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.partnerRefusals",
        &obj(&[("days", Json::int(7))]),
    )
    .ok();
    assert_eq!(
        empty.compact(),
        r#"{"freeze":{"postingEnabled":true,"cause":null,"owner":"svc-ledger"},"stops":[],"firstDay":null,"counts":[]}"#
    );
    // A stop refuses two moves and is counted; an old count outside the window is not read but names the first day.
    stop(&b, &["bank_move"], 0, STOP_REASON).ok();
    let store = b.db.store();
    for _ in 0..2 {
        assert_eq!(
            code_of(custody::assert_stop_open(&store, PARTNER, "bank_move")),
            "bank.partner_stopped"
        );
    }
    b.sql(
        "INSERT INTO bank.partner_refusal_counts (day, refused_by, cause, kind, count) \
         VALUES ((now() AT TIME ZONE 'UTC')::date - 30, 'posting_freeze', 'person', 'bank_move', 4)",
    );
    let frozen = b.rewired(true, FreezeAs(Some(Some("mismatch"))));
    let read = send_to(
        &frozen,
        "ops.partnerRefusals",
        &obj(&[("days", Json::int(7))]),
        OPERATOR,
        &["admin:read"],
    )
    .ok();
    assert_eq!(
        read.get("freeze").unwrap().compact(),
        r#"{"postingEnabled":false,"cause":"mismatch","owner":"svc-ledger"}"#
    );
    assert_eq!(
        read.get("stops").unwrap().compact(),
        r#"[{"partnerId":"test-partner","stoppedKinds":["bank_move"],"revision":1}]"#
    );
    let counts = arr(read.get("counts").unwrap());
    assert_eq!(counts.len(), 1);
    assert_eq!(
        [
            s(&counts[0], "refusedBy"),
            s(&counts[0], "cause"),
            s(&counts[0], "kind"),
            s(&counts[0], "count")
        ],
        ["partner_stop", "stopped", "bank_move", "2"]
    );
    let first = s(&read, "firstDay");
    assert!(first < s(&counts[0], "day"), "{first}");
    // A freeze that cannot be read is never "enabled".
    let unreadable = b.rewired(true, FreezeAs(None));
    let read = send_to(
        &unreadable,
        "ops.partnerRefusals",
        &obj(&[("days", Json::int(90))]),
        OPERATOR,
        &["admin:read"],
    )
    .ok();
    assert_eq!(
        read.get("freeze").unwrap().compact(),
        r#"{"postingEnabled":false,"cause":"unreadable","owner":"svc-ledger"}"#
    );
    assert_eq!(arr(read.get("counts").unwrap()).len(), 2);
    // The window is required, and the customer never reads the desk.
    assert_eq!(
        call(
            &b,
            OPERATOR,
            &["admin:read"],
            "ops.partnerRefusals",
            &obj(&[])
        )
        .trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        call(
            &b,
            ADA,
            &["bank:read"],
            "ops.partnerRefusals",
            &obj(&[("days", Json::int(7))])
        )
        .trpc(),
        "FORBIDDEN"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// ops/transfer-health.db.test.ts

#[test]
fn counts_each_standing_order_status_an_exact_ratio_and_leaves_missing_sources_without_a_number() {
    let Some(b) = bank() else { return };
    let ada_from = b.space(ADA, "Ada from");
    let bob_to = b.space(BOB, "Bob to");
    let schedule = b.schedule(ADA, &ada_from, &bob_to);
    let recent = iso_ago(2 * HOUR);
    let old = iso_ago(100 * HOUR);
    let pending_old = iso_ago(10 * HOUR);
    let mut n = 0;
    let mut exec = |status: &str, at: &str, code: Option<&str>, ledger: Option<String>| {
        b.execution(
            &uuid(),
            &schedule,
            n,
            "1.50",
            status,
            code,
            ledger.as_deref(),
            at,
        );
        n += 1;
    };
    for _ in 0..3 {
        exec("rejected", &recent, Some("ledger.insufficient_funds"), None);
    }
    for i in 0..4 {
        exec("settled", &recent, None, Some(format!("tx-settled-{i}")));
    }
    exec("pending", &pending_old, None, None);
    exec("pending", &recent, None, None);
    exec("pending", &recent, None, None);
    exec("skipped", &recent, Some("bank.schedule_paused"), None);
    exec("skipped", &recent, Some("bank.schedule_paused"), None);
    exec("rejected", &old, Some("ledger.insufficient_funds"), None);
    exec("pending", &old, None, None);

    let reserved_at = iso_ago(4 * HOUR);
    for (id, status, ledger, at) in [
        ("xfer-reserved-a", "reserved", "NULL", &reserved_at),
        ("xfer-reserved-b", "reserved", "NULL", &recent),
        ("xfer-posted-a", "posted", "'tx-one-a'", &recent),
        ("xfer-posted-b", "posted", "'tx-one-b'", &recent),
        ("xfer-posted-c", "posted", "'tx-one-c'", &recent),
        ("xfer-posted-old", "posted", "'tx-one-old'", &old),
    ] {
        b.sql(&format!(
            "INSERT INTO bank.personal_transfers (transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, \
               asset_id, amount, status, created_at) \
             VALUES ('{id}', {ledger}, '{ADA}', '{ada_from}', '{BOB}', 'USDT', '8.00', '{status}', '{at}')"
        ));
    }
    let submitted_at = iso_ago(3 * HOUR);
    for (status, key, code, at) in [
        ("submitted", "bill-sub", "NULL", &submitted_at),
        ("accepted", "bill-acc", "NULL", &recent),
        ("paid", "bill-paid", "NULL", &recent),
        ("failed", "bill-fail", "'bank.bills_rail_refused'", &recent),
        ("returned", "bill-ret", "NULL", &recent),
        ("failed", "bill-old", "'bank.bills_rail_refused'", &old),
    ] {
        b.sql(&format!(
            "INSERT INTO bank.bill_payments (id, user_id, idempotency_key, biller_id, reference, amount, asset_id, \
               from_space_id, status, failure_code, created_at, updated_at) \
             VALUES ('{}', '{ADA}', '{key}', 'biller', 'ref', '4.00', 'USDT', '{ada_from}', '{status}', {code}, '{at}', '{at}')",
            uuid()
        ));
    }

    let health = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.transferHealth",
        &obj(&[("windowHours", Json::int(48))]),
    )
    .ok();
    let so = health.get("standingOrders").unwrap();
    assert_eq!(
        [
            s(so, "pending"),
            s(so, "settled"),
            s(so, "rejected"),
            s(so, "skipped"),
            s(so, "total"),
            s(so, "failureRate")
        ],
        ["3", "4", "3", "2", "12", "0.25"]
    );
    let age: i64 = s(so, "oldestPendingAgeSeconds").parse().unwrap();
    assert!((10 * 3600 - 30..10 * 3600 + 30).contains(&age), "{age}");
    let one_off = health.get("oneOff").unwrap();
    assert_eq!(
        [
            s(one_off, "available"),
            s(one_off, "reserved"),
            s(one_off, "posted"),
            s(one_off, "total"),
            s(one_off, "failureRate"),
            s(one_off, "failureRateReason")
        ],
        ["true", "2", "3", "5", "null", "failures_not_recorded"]
    );
    let age: i64 = s(one_off, "oldestPendingAgeSeconds").parse().unwrap();
    assert!(age > 4 * 3600 - 30, "{age}");
    let bills = health.get("bills").unwrap();
    assert_eq!(
        [
            s(bills, "available"),
            s(bills, "submitted"),
            s(bills, "accepted"),
            s(bills, "paid"),
            s(bills, "failed"),
            s(bills, "returned"),
            s(bills, "total"),
            s(bills, "failureRate")
        ],
        ["true", "1", "1", "1", "1", "1", "5", "0.2"]
    );
    assert_eq!(
        health.get("p2p").unwrap().compact(),
        r#"{"available":false,"reason":"served_by_p2p_ops"}"#
    );
    let text = health.compact();
    assert!(!text.contains(ADA) && !text.contains(BOB) && !text.contains(&schedule));

    let empty = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.transferHealth",
        &obj(&[("windowHours", Json::int(1))]),
    )
    .ok();
    let so = empty.get("standingOrders").unwrap();
    assert_eq!(
        [
            s(so, "failureRate"),
            s(so, "oldestPendingAgeSeconds"),
            s(so, "total")
        ],
        ["null", "null", "0"]
    );
    assert_eq!(s(empty.get("bills").unwrap(), "failureRate"), "null");
    assert_eq!(s(empty.get("oneOff").unwrap(), "failureRate"), "null");

    let unset = call(
        &b,
        OPERATOR,
        &["admin:read"],
        "ops.transferHealth",
        &obj(&[]),
    );
    assert_eq!(unset.trpc(), "BAD_REQUEST");
    assert!(
        unset
            .message()
            .contains("bank.transfer_health_window_unset")
    );
    assert_eq!(
        call(
            &b,
            ADA,
            &["bank:read"],
            "ops.transferHealth",
            &obj(&[("windowHours", Json::int(24))])
        )
        .trpc(),
        "FORBIDDEN"
    );
}

#[test]
fn lists_rejected_standing_orders_newest_first_pages_without_gaps_and_refuses_the_wrong_session() {
    let Some(b) = bank() else { return };
    let ada_from = b.space(ADA, "Ada from");
    let ada_to = b.space(ADA, "Ada to");
    let bob_from = b.space(BOB, "Bob from");
    let bob_to = b.space(BOB, "Bob to");
    let cara_to = b.space(CARA, "Cara to");
    let ada_to_bob = b.schedule(ADA, &ada_from, &bob_to);
    let ada_to_cara = b.schedule(ADA, &ada_from, &cara_to);
    let bob_to_ada = b.schedule(BOB, &bob_from, &ada_to);
    let base = now_ms() - HOUR;
    let (newest, middle, oldest, settled, outside, same_newer, same_older) =
        (uuid(), uuid(), uuid(), uuid(), uuid(), uuid(), uuid());
    let iso = |ms: i64| Instant(ms).iso();
    b.execution(
        &oldest,
        &bob_to_ada,
        0,
        "10.50",
        "rejected",
        Some("vendor.mystery"),
        None,
        &iso(base - 3000),
    );
    b.execution(
        &middle,
        &ada_to_cara,
        0,
        "10.50",
        "rejected",
        Some("bank.recipient_cannot_receive"),
        None,
        &iso(base - 2000),
    );
    b.execution(
        &newest,
        &ada_to_bob,
        0,
        "10.50",
        "rejected",
        Some("ledger.insufficient_funds"),
        None,
        &iso(base - 1000),
    );
    b.execution(
        &settled,
        &ada_to_bob,
        1,
        "10.50",
        "settled",
        None,
        Some("tx-settled-page"),
        &iso(base + 5000),
    );
    b.execution(
        &outside,
        &ada_to_bob,
        2,
        "10.50",
        "rejected",
        Some("ledger.insufficient_funds"),
        None,
        &iso(now_ms() - 100 * HOUR),
    );
    b.sql(&format!(
        "INSERT INTO bank.transfer_executions (id, schedule_id, occurrence, amount, status, rejection_code, attempted_at) VALUES \
           ('{same_newer}', '{ada_to_bob}', 3, '1', 'rejected', 'ledger.insufficient_funds', '{0}'::timestamptz), \
           ('{same_older}', '{ada_to_bob}', 4, '1', 'rejected', 'ledger.insufficient_funds', '{0}'::timestamptz - interval '300 microseconds')",
        iso(base)
    ));

    let page = |limit: i64, cursor: Option<String>| {
        let mut f = vec![("windowHours", Json::int(48)), ("limit", Json::int(limit))];
        if let Some(c) = cursor {
            f.push(("cursor", Json::str(c)));
        }
        call(
            &b,
            OPERATOR,
            &["admin:compliance"],
            "ops.failedTransfers",
            &obj(&f),
        )
        .ok()
    };
    let cursor = |p: &Json| match p.get("nextCursor") {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    };
    let first = page(2, None);
    let ids = |p: &Json| {
        arr(p.get("items").unwrap())
            .iter()
            .map(|r| s(r, "id"))
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&first), vec![same_newer.clone(), same_older.clone()]);
    let second = page(2, cursor(&first));
    let third = page(2, cursor(&second));
    let all: Vec<String> = [ids(&first), ids(&second), ids(&third)].concat();
    assert_eq!(
        all,
        vec![
            same_newer,
            same_older,
            newest.clone(),
            middle.clone(),
            oldest
        ]
    );
    assert_eq!(s(&third, "nextCursor"), "null");
    assert!(!all.contains(&settled) && !all.contains(&outside));

    let listed = &arr(second.get("items").unwrap())[0];
    assert_eq!(
        listed.compact(),
        format!(
            r#"{{"id":"{newest}","kind":"standing_order","amount":"10.5","assetId":"USDT","status":"rejected","rejectionCode":"ledger.insufficient_funds","reason":"ledger.insufficient_funds","attemptedAt":"{}","sender":{{"handle":"ada","reason":null}},"receiver":{{"handle":"bob","reason":null}}}}"#,
            iso(base - 1000)
        )
    );
    let to_cara = &arr(second.get("items").unwrap())[1];
    assert_eq!(
        [
            s(to_cara, "id"),
            s(to_cara, "rejectionCode"),
            s(to_cara, "reason")
        ],
        [
            middle,
            "bank.recipient_cannot_receive".to_owned(),
            "This recipient cannot receive payments".to_owned()
        ]
    );
    assert_eq!(
        to_cara.get("receiver").unwrap().compact(),
        r#"{"handle":null,"reason":"handle_unresolved"}"#
    );
    let text = format!("{}{}{}", first.compact(), second.compact(), third.compact());
    assert!(!text.contains(ADA) && !text.contains(BOB) && !text.contains(CARA));

    let unset = call(
        &b,
        OPERATOR,
        &["admin:compliance"],
        "ops.failedTransfers",
        &obj(&[("windowHours", Json::int(48))]),
    );
    assert_eq!(unset.trpc(), "BAD_REQUEST");
    assert!(
        unset
            .message()
            .contains("bank.failed_transfers_limit_unset")
    );
    let forged = call(
        &b,
        OPERATOR,
        &["admin:compliance"],
        "ops.failedTransfers",
        &obj(&[
            ("windowHours", Json::int(48)),
            ("limit", Json::int(2)),
            ("cursor", Json::str("bm90LWEtY3Vyc29y")),
        ]),
    );
    assert_eq!(forged.cause(), "bank.failed_transfers_cursor_invalid");
    let fw = obj(&[("windowHours", Json::int(48)), ("limit", Json::int(10))]);
    assert_eq!(
        call(&b, OPERATOR, &["admin:read"], "ops.failedTransfers", &fw).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call(
            &b,
            ADA,
            &["bank:read", "bank:write"],
            "ops.failedTransfers",
            &fw
        )
        .trpc(),
        "FORBIDDEN"
    );
    // With no identity wired the page refuses rather than naming nobody.
    let unwired = b.rewired(false, FreezeAs(Some(None)));
    let refused = send_to(
        &unwired,
        "ops.failedTransfers",
        &obj(&[("windowHours", Json::int(48)), ("limit", Json::int(2))]),
        OPERATOR,
        &["admin:compliance"],
    );
    assert_eq!(refused.trpc(), "PRECONDITION_FAILED");
    assert!(
        refused.message().contains("IDENTITY_URL"),
        "{}",
        refused.message()
    );
}

#[test]
fn returns_the_stored_row_the_same_not_found_for_a_bad_id_and_an_audit_line() {
    let Some(b) = bank() else { return };
    let ada_from = b.space(ADA, "Ada from");
    let bob_to = b.space(BOB, "Bob to");
    let schedule = b.schedule(ADA, &ada_from, &bob_to);
    let id = uuid();
    let attempted = Instant(now_ms() - HOUR).iso();
    b.execution(
        &id,
        &schedule,
        7,
        "10.50",
        "rejected",
        Some("ledger.insufficient_funds"),
        None,
        &attempted,
    );
    b.sql(&format!(
        "INSERT INTO bank.personal_transfers (transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status) \
         VALUES ('xfer-detail-1', 'tx-detail-1', '{ADA}', '{ada_from}', '{BOB}', 'USDT', '3.00', 'posted')"
    ));
    let read = |id: &str| {
        call(
            &b,
            OPERATOR,
            &["admin:compliance"],
            "ops.transferDetail",
            &obj(&[("id", Json::str(id))]),
        )
    };
    let row = read(&id).ok();
    assert_eq!(
        row.compact(),
        format!(
            r#"{{"id":"{id}","kind":"standing_order","senderUserId":"{ADA}","receiverUserId":"{BOB}","amount":"10.5","assetId":"USDT","status":"rejected","rejectionCode":"ledger.insufficient_funds","reason":"ledger.insufficient_funds","ledgerTxId":null,"scheduleId":"{schedule}","occurrence":7,"attemptedAt":"{attempted}","settledAt":null}}"#
        )
    );
    // An id in capitals is the same execution.
    assert_eq!(s(&read(&id.to_uppercase()).ok(), "id"), id);
    let one_off = read("xfer-detail-1").ok();
    assert_eq!(
        [
            s(&one_off, "id"),
            s(&one_off, "kind"),
            s(&one_off, "amount"),
            s(&one_off, "status"),
            s(&one_off, "ledgerTxId"),
            s(&one_off, "scheduleId"),
            s(&one_off, "occurrence"),
            s(&one_off, "rejectionCode")
        ],
        [
            "xfer-detail-1",
            "one_off",
            "3",
            "posted",
            "tx-detail-1",
            "null",
            "null",
            "null"
        ]
    );
    for missing in [uuid(), "not-an-id".to_owned()] {
        let a = read(&missing);
        assert_eq!(
            (a.trpc(), a.message()),
            (
                "NOT_FOUND".to_owned(),
                "No such transfer (bank.ops_transfer_not_found)".to_owned()
            )
        );
    }
    let q = obj(&[("id", Json::str(id))]);
    assert_eq!(
        call(&b, ADA, &["bank:read"], "ops.transferDetail", &q).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call(&b, OPERATOR, &["admin:read"], "ops.transferDetail", &q).trpc(),
        "FORBIDDEN"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// ops/customer-balances.test.ts

#[test]
fn shows_the_same_split_as_the_customer_one_column_per_lock_kind() {
    let Some(b) = bank() else { return };
    b.ledger.balance("user", BOB, "USDT", "available", "", "70");
    b.ledger
        .balance("user", BOB, "USDT", "hold", "order:a", "20");
    b.ledger
        .balance("user", BOB, "USDT", "stake", "earn:p", "10");
    // A named space's money is the customer's too; a claim that nets to zero shows no lock.
    let space = b.space(BOB, "Rainy day");
    b.ledger
        .balance("subaccount", &space, "USDT", "available", "", "5");
    b.ledger.balance("user", BOB, "BTC", "hold", "order:x", "1");
    b.ledger
        .balance("user", BOB, "BTC", "hold", "order:x", "-1");
    b.ledger.balance("user", BOB, "BTC", "available", "", "0.5");
    let out = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.customerBalances",
        &obj(&[("userId", Json::str(BOB))]),
    )
    .ok();
    assert_eq!(
        out.compact(),
        format!(
            r#"{{"userId":"{BOB}","assets":[{{"assetId":"BTC","total":"0.5","available":"0.5","hold":"0","escrow":"0","stake":"0","collateral":"0"}},{{"assetId":"USDT","total":"105","available":"75","hold":"20","escrow":"0","stake":"10","collateral":"0"}}]}}"#
        )
    );
    assert_eq!(
        b.ledger.asked(),
        vec![format!("user:{BOB}"), format!("subaccount:{space}")]
    );
}

#[test]
fn refuses_a_customer_session_and_an_operator_without_the_treasury_scope_and_reads_nothing() {
    let Some(b) = bank() else { return };
    b.ledger.balance("user", BOB, "USDT", "available", "", "5");
    let who = obj(&[("userId", Json::str(BOB))]);
    assert_eq!(
        call(&b, BOB, &["bank:read"], "ops.customerBalances", &who).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call(
            &b,
            OPERATOR,
            &["admin:compliance"],
            "ops.customerBalances",
            &who
        )
        .trpc(),
        "FORBIDDEN"
    );
    let entries = obj(&[("userId", Json::str(BOB)), ("assetId", Json::str("USDT"))]);
    assert_eq!(
        call(
            &b,
            BOB,
            &["bank:read"],
            "ops.customerBalanceEntries",
            &entries
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert!(b.ledger.asked().is_empty());
}

#[test]
fn refuses_a_smuggled_field_and_a_non_uuid_customer() {
    let Some(b) = bank() else { return };
    let t = &["admin:treasury"];
    assert_eq!(
        call(
            &b,
            OPERATOR,
            t,
            "ops.customerBalances",
            &obj(&[("userId", Json::str("nope"))])
        )
        .trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        call(
            &b,
            OPERATOR,
            t,
            "ops.customerBalances",
            &obj(&[("userId", Json::str(BOB)), ("extra", Json::int(1))])
        )
        .trpc(),
        "BAD_REQUEST"
    );
    assert!(b.ledger.asked().is_empty());
}

#[test]
fn lists_the_entries_behind_the_balance_with_the_sum_check_and_names_a_mismatch() {
    let Some(b) = bank() else { return };
    b.ledger.balance("user", BOB, "USDT", "available", "", "70");
    b.ledger.entry(
        "user",
        BOB,
        "t0",
        "debit",
        "100",
        "2026-10-01T00:00:00Z",
        Some("1"),
    );
    b.ledger.entry(
        "user",
        BOB,
        "t1",
        "credit",
        "30",
        "2026-10-02T00:00:00Z",
        Some("2"),
    );
    let q = obj(&[("userId", Json::str(BOB)), ("assetId", Json::str("usdt"))]);
    let out = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.customerBalanceEntries",
        &q,
    )
    .ok();
    assert_eq!(
        out.compact(),
        r#"{"assetId":"USDT","entries":[{"entryId":"2","txId":"t1","accountId":"main","reason":"x","direction":"credit","amount":"30","postedAt":"2026-10-02T00:00:00.000Z"},{"entryId":"1","txId":"t0","accountId":"main","reason":"x","direction":"debit","amount":"100","postedAt":"2026-10-01T00:00:00.000Z"}],"nextCursor":null,"sumCheck":{"ok":true,"entriesSum":"70","balance":"70","entryCount":2}}"#
    );
    // One more entry than the balance shows: refused, the gap named.
    b.ledger.entry(
        "user",
        BOB,
        "t2",
        "debit",
        "1",
        "2026-10-03T00:00:00Z",
        Some("3"),
    );
    let bad = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.customerBalanceEntries",
        &q,
    );
    assert_eq!(
        (bad.trpc(), bad.cause()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "portfolio.entries_do_not_sum".to_owned()
        )
    );
    assert!(bad.message().contains("a gap of 1"), "{}", bad.message());
}

#[test]
fn the_entries_of_every_named_space_are_read_page_by_page_and_shown_a_page_at_a_time() {
    let Some(b) = bank() else { return };
    let space = b.space(BOB, "Rainy day");
    b.ledger.balance("user", BOB, "USDT", "available", "", "3");
    b.ledger
        .balance("subaccount", &space, "USDT", "available", "", "2");
    for (i, at) in ["2026-10-01", "2026-10-02", "2026-10-03"]
        .iter()
        .enumerate()
    {
        b.ledger.entry(
            "user",
            BOB,
            &format!("m{i}"),
            "debit",
            "1",
            &format!("{at}T00:00:00Z"),
            None,
        );
    }
    b.ledger.entry(
        "subaccount",
        &space,
        "s0",
        "debit",
        "2",
        "2026-10-02T12:00:00Z",
        None,
    );
    let read = |cursor: Option<&str>| {
        let mut f = vec![
            ("userId", Json::str(BOB)),
            ("assetId", Json::str("USDT")),
            ("limit", Json::int(3)),
        ];
        if let Some(c) = cursor {
            f.push(("cursor", Json::str(c)));
        }
        call(
            &b,
            OPERATOR,
            &["admin:treasury"],
            "ops.customerBalanceEntries",
            &obj(&f),
        )
        .ok()
    };
    let first = read(None);
    let line = |e: &Json| format!("{}@{}", s(e, "txId"), s(e, "accountId"));
    assert_eq!(
        arr(first.get("entries").unwrap())
            .iter()
            .map(line)
            .collect::<Vec<_>>(),
        vec![
            "m2@main".to_owned(),
            format!("s0@{space}"),
            "m1@main".to_owned()
        ]
    );
    assert_eq!(s(&first, "nextCursor"), "3");
    let second = read(Some("3"));
    assert_eq!(
        arr(second.get("entries").unwrap())
            .iter()
            .map(line)
            .collect::<Vec<_>>(),
        vec!["m0@main".to_owned()]
    );
    assert_eq!(s(&second, "nextCursor"), "null");
    assert_eq!(
        second.get("sumCheck").unwrap().compact(),
        r#"{"ok":true,"entriesSum":"5","balance":"5","entryCount":4}"#
    );
    let bad = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.customerBalanceEntries",
        &obj(&[
            ("userId", Json::str(BOB)),
            ("assetId", Json::str("USDT")),
            ("cursor", Json::str("x1")),
        ]),
    );
    assert_eq!(bad.cause(), "bank.activity_range");
}

#[test]
fn says_the_history_is_unavailable_when_the_history_reads_fail_not_an_opaque_error() {
    let Some(b) = bank() else { return };
    b.ledger.balance("user", BOB, "USDT", "available", "", "5");
    let q = obj(&[("userId", Json::str(BOB)), ("assetId", Json::str("USDT"))]);
    b.ledger.0.lock().unwrap().pages_fail = true;
    let off = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.customerBalanceEntries",
        &q,
    );
    assert_eq!(
        (off.trpc(), off.message()),
        (
            "SERVICE_UNAVAILABLE".to_owned(),
            "Activity is not available right now. Try again in a minute.".to_owned()
        )
    );
    // A history too long to prove is refused, never shown in part.
    let mut st = b.ledger.0.lock().unwrap();
    st.pages_fail = false;
    st.pages_endless = true;
    drop(st);
    let long = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.customerBalanceEntries",
        &q,
    );
    assert_eq!(
        (long.trpc(), long.cause()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.activity_lookup_bounded".to_owned()
        )
    );
}

// ---------------------------------------------------------------------------------------------------------------
// transfers/transfer-terms.db.test.ts: the desk's call

const PUBLISH: &str = "bank.ops.publishTransferTerms";

fn terms(asset: &str, per: &str, daily: &str, fee: &str) -> Vec<(&'static str, Json)> {
    vec![
        ("assetId", Json::str(asset)),
        ("perTransferLimit", Json::str(per)),
        ("dailyLimit", Json::str(daily)),
        ("fee", Json::str(fee)),
    ]
}

fn publish(b: &Bank, scopes: &[&str], asset: &str, per: &str, daily: &str, fee: &str) -> Answer {
    let ids = b.desk.issue(
        PUBLISH,
        &[
            ("assetId", asset),
            ("perTransferLimit", per),
            ("dailyLimit", daily),
            ("fee", fee),
        ],
    );
    call(
        b,
        OPERATOR,
        scopes,
        "ops.publishTransferTerms",
        &with_ids(terms(asset, per, daily, fee), ids),
    )
}

fn stored(b: &Bank) -> Vec<String> {
    b.db
        .client()
        .query(
            "SELECT asset_id || ' ' || per_transfer_limit::text || ' ' || daily_limit::text || ' ' || fee::text \
               FROM bank.personal_transfer_terms ORDER BY asset_id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

#[test]
fn publishes_the_figures_with_a_second_person_names_the_approver_and_the_send_path_reads_them() {
    let Some(b) = bank() else { return };
    let published = publish(&b, &["admin:compliance"], "USDT", "250", "1000", "0").ok();
    assert_eq!(
        [
            s(&published, "assetId"),
            s(&published, "perTransferLimit"),
            s(&published, "dailyLimit"),
            s(&published, "fee"),
            s(&published, "approvedBy")
        ],
        ["USDT", "250", "1000", "0", APPROVER]
    );
    assert_ne!(s(&published, "publishedAt"), "null");
    assert_eq!(b.desk.consumed(), 1);
    let quote = call(
        &b,
        ADA,
        &["bank:read", "bank:write"],
        "transfers.quote",
        &obj(&[("assetId", Json::str("USDT")), ("amount", Json::str("10"))]),
    )
    .ok();
    assert_eq!(
        [
            s(&quote, "perTransferLimit"),
            s(&quote, "dailyLimit"),
            s(&quote, "fee")
        ],
        ["250", "1000", "0"]
    );
}

#[test]
fn publishing_again_replaces_the_figures_for_that_asset_only() {
    let Some(b) = bank() else { return };
    let c = &["admin:compliance"];
    publish(&b, c, "USDT", "250", "1000", "0").ok();
    publish(&b, c, "USDC", "5", "5", "0").ok();
    publish(&b, c, "USDT", "100", "1000", "0").ok();
    assert_eq!(
        stored(&b),
        vec![
            "USDC 5.000000000000000000 5.000000000000000000 0.000000000000000000",
            "USDT 100.000000000000000000 1000.000000000000000000 0.000000000000000000",
        ]
    );
}

#[test]
fn refuses_with_no_approval_or_an_approval_bound_to_other_figures_and_writes_nothing() {
    let Some(b) = bank() else { return };
    let none = call(
        &b,
        OPERATOR,
        &["admin:compliance"],
        "ops.publishTransferTerms",
        &obj(&terms("USDT", "250", "1000", "0")),
    );
    assert_eq!(none.cause(), "action_approval.missing");
    let other = b.desk.issue(
        PUBLISH,
        &[
            ("assetId", "USDT"),
            ("perTransferLimit", "250"),
            ("dailyLimit", "1000000"),
            ("fee", "0"),
        ],
    );
    let wrong = call(
        &b,
        OPERATOR,
        &["admin:compliance"],
        "ops.publishTransferTerms",
        &with_ids(terms("USDT", "250", "1000", "0"), other),
    );
    assert_eq!(wrong.cause(), "action_approval.consume_failed");
    assert!(stored(&b).is_empty());
}

#[test]
fn refuses_zero_negative_or_inverted_limits_or_an_asset_code_sends_would_never_match_before_spending_the_approval()
 {
    let Some(b) = bank() else { return };
    let c = &["admin:compliance"];
    for (per, daily) in [("0", "1000"), ("250", "0"), ("1001", "1000")] {
        let a = publish(&b, c, "USDT", per, daily, "0");
        assert_eq!(a.trpc(), "BAD_REQUEST");
        assert!(
            a.message().contains("bank.personal_transfer_terms_invalid"),
            "{}",
            a.message()
        );
    }
    assert_eq!(
        publish(&b, c, "USDT", "250", "1000", "-1").trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        publish(&b, c, "usdt", "250", "1000", "0").trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(b.desk.consumed(), 0);
    assert!(stored(&b).is_empty());
}

#[test]
fn publishing_needs_admin_compliance() {
    let Some(b) = bank() else { return };
    for scopes in [&["bank:write"][..], &["admin:treasury"][..]] {
        assert_eq!(
            publish(&b, scopes, "USDT", "250", "1000", "0").trpc(),
            "FORBIDDEN"
        );
    }
    assert_eq!(b.desk.consumed(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// transfers/limit-requests.db.test.ts: the desk's queue and decision

fn open_request(b: &Bank) -> String {
    publish(b, &["admin:compliance"], "USDT", "100", "100", "0").ok();
    let id = uuid();
    call(
        b,
        ADA,
        &["bank:read", "bank:write"],
        "limits.requestIncrease",
        &obj(&[
            ("requestId", Json::str(id.clone())),
            ("assetId", Json::str("USDT")),
            ("kind", Json::str("daily")),
            ("requested", Json::str("500")),
            ("reason", Json::str("TEST: rent is due this week")),
        ]),
    )
    .ok();
    id
}

fn decide(
    b: &Bank,
    user: &str,
    id: &str,
    decision: &str,
    granted: Option<&str>,
    note: &str,
) -> Answer {
    let mut f = vec![
        ("requestId", Json::str(id)),
        ("decision", Json::str(decision)),
        ("note", Json::str(note)),
    ];
    if let Some(g) = granted {
        f.push(("granted", Json::str(g)));
    }
    call(
        b,
        user,
        &["admin:compliance"],
        "ops.decideLimitRequest",
        &obj(&f),
    )
}

#[test]
fn a_decline_grants_nothing_a_replayed_decision_returns_the_first_a_different_one_conflicts() {
    let Some(b) = bank() else { return };
    let id = open_request(&b);
    let queue = call(
        &b,
        CARA,
        &["admin:compliance"],
        "ops.limitRequests",
        &obj(&[("limit", Json::int(10))]),
    )
    .ok();
    let open = arr(&queue);
    assert_eq!(
        (open.len(), s(&open[0], "id"), s(&open[0], "userId")),
        (1, id.clone(), ADA.to_owned())
    );
    assert_eq!(
        decide(&b, CARA, &id, "decline", Some("10"), "TEST: not this time").cause(),
        "bank.validation_failed"
    );
    let first = decide(&b, CARA, &id, "decline", None, "TEST: not this time").ok();
    assert_eq!(
        (
            s(&first, "status"),
            s(&first, "replayed"),
            s(&first, "decidedBy")
        ),
        ("declined".to_owned(), "false".to_owned(), CARA.to_owned())
    );
    let again = decide(&b, CARA, &id, "decline", None, "TEST: not this time").ok();
    assert_eq!(s(&again, "replayed"), "true");
    assert_eq!(
        decide(
            &b,
            CARA,
            &id,
            "approve",
            Some("500"),
            "TEST: changed my mind"
        )
        .cause(),
        "bank.limit_request_decided"
    );
    let quote = call(
        &b,
        ADA,
        &["bank:read"],
        "transfers.quote",
        &obj(&[("assetId", Json::str("USDT")), ("amount", Json::str("1"))]),
    )
    .ok();
    assert_eq!(s(&quote, "dailyLimit"), "100");
}

#[test]
fn refuses_an_approval_with_no_granted_amount_a_short_note_a_self_decision_and_an_unknown_request()
{
    let Some(b) = bank() else { return };
    let id = open_request(&b);
    let a = decide(&b, CARA, &id, "approve", None, "TEST: income verified");
    assert!(a.message().contains("never defaulted"), "{}", a.message());
    assert_eq!(
        decide(&b, CARA, &id, "approve", Some("500"), "ok").cause(),
        "bank.ops_reason_too_short"
    );
    assert_eq!(
        decide(
            &b,
            ADA,
            &id,
            "approve",
            Some("500"),
            "TEST: approving my own"
        )
        .cause(),
        "bank.limit_request_self_decision"
    );
    assert_eq!(
        decide(&b, CARA, &uuid(), "decline", None, "TEST: no such request").cause(),
        "bank.limit_request_not_found"
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.limit_increase_requests WHERE status = 'open'"),
        1
    );
    // The queue's page size is never defaulted, and the customer never reads it.
    assert_eq!(
        call(
            &b,
            CARA,
            &["admin:compliance"],
            "ops.limitRequests",
            &obj(&[])
        )
        .trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        call(
            &b,
            ADA,
            &["bank:read", "bank:write"],
            "ops.limitRequests",
            &obj(&[("limit", Json::int(10))])
        )
        .trpc(),
        "FORBIDDEN"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The held sends' desk (`ops.heldSends`, `releaseHeldSend`, `rejectHeldSend`; the review itself is `transfers_send_db`'s)

fn held(b: &Bank, transfer_id: &str, from_space: &str, minutes_ago: i64) {
    b.sql(&format!(
        "INSERT INTO bank.personal_send_reviews (transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, \
           to_handle, reason_class, created_at) \
         VALUES ('{transfer_id}', '{ADA}', '{from_space}', '{BOB}', 'USDT', '75.5', 'bob', 'amount_over_review_line', \
           now() - interval '{minutes_ago} minutes')"
    ));
}

#[test]
fn the_desk_lists_held_sends_oldest_first_and_a_reject_names_the_operator_and_moves_nothing() {
    let Some(b) = bank() else { return };
    let from = b.space(ADA, "Ada main");
    held(&b, "held-send-new", &from, 1);
    held(&b, "held-send-old", &from, 10);
    let list = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.heldSends",
        &obj(&[]),
    )
    .ok();
    let rows = arr(&list);
    assert_eq!(
        rows.iter().map(|r| s(r, "transferId")).collect::<Vec<_>>(),
        vec!["held-send-old", "held-send-new"]
    );
    assert_eq!(
        [
            s(&rows[0], "status"),
            s(&rows[0], "amount"),
            s(&rows[0], "toHandle"),
            s(&rows[0], "fromUserId"),
            s(&rows[0], "toUserId")
        ],
        ["in_review", "75.5", "bob", ADA, BOB]
    );
    let page = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.heldSends",
        &obj(&[("limit", Json::int(1))]),
    )
    .ok();
    assert_eq!(arr(&page).len(), 1);
    let rejected = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.rejectHeldSend",
        &obj(&[("transferId", Json::str("held-send-old"))]),
    )
    .ok();
    assert_eq!(s(&rejected, "status"), "rejected");
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.personal_send_reviews WHERE decided_by = '{OPERATOR}'"
        )),
        1
    );
    // A repeat is safe; the customer never reaches the desk.
    let again = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.rejectHeldSend",
        &obj(&[("transferId", Json::str("held-send-old"))]),
    )
    .ok();
    assert_eq!(s(&again, "status"), "rejected");
    assert_eq!(
        call(&b, ADA, &["bank:read"], "ops.heldSends", &obj(&[])).trpc(),
        "FORBIDDEN"
    );
}

#[test]
fn a_release_needs_the_second_persons_approval_for_that_send_and_without_it_nothing_changes() {
    let Some(b) = bank() else { return };
    let from = b.space(ADA, "Ada main");
    held(&b, "held-send-rel", &from, 5);
    let release = |ids: Vec<(&'static str, Json)>| {
        call(
            &b,
            OPERATOR,
            &["admin:treasury"],
            "ops.releaseHeldSend",
            &with_ids(vec![("transferId", Json::str("held-send-rel"))], ids),
        )
    };
    assert_eq!(release(Vec::new()).cause(), "action_approval.missing");
    // An approval for another held send does not release this one; a typed-in second name is not approval.
    let other = b.desk.issue(
        "bank.release_held_send",
        &[("transferId", "held-send-other")],
    );
    assert_eq!(release(other).cause(), "action_approval.consume_failed");
    let typed = release(vec![("confirmOperatorId", Json::str(APPROVER))]);
    assert_eq!(typed.cause(), "action_approval.missing");
    assert_eq!(b.count("SELECT count(*) FROM bank.personal_send_reviews WHERE status = 'in_review' AND decided_by IS NULL"), 1);
    // An approval for an id with no held send is spent and answers not-found.
    let ghost = b.desk.issue(
        "bank.release_held_send",
        &[("transferId", "held-send-ghost")],
    );
    let a = call(
        &b,
        OPERATOR,
        &["admin:treasury"],
        "ops.releaseHeldSend",
        &with_ids(vec![("transferId", Json::str("held-send-ghost"))], ghost),
    );
    assert_eq!(a.cause(), "bank.held_send_not_found");
    assert_eq!(b.desk.consumed(), 1);
}
