//! Slice `ramps`, the address book, against the Rust door on a real Postgres. Ports the checks of the TypeScript's
//! suites that fall on `ramps.destinations.*`, `ops.destinationFraudList` and `ops.setDestinationFraudListing`, each
//! test named after the TypeScript test's words:
//!
//! - `ramps/address-approval.db.test.ts`: every test (the Postgres half; the memory stores are the TypeScript's own).
//! - `address-book.db.test.ts`: every test, on the Postgres store (the memory store is the TypeScript's own).
//! - `ramps/address-book.router.test.ts`: every test, through the door.
//! - `ramps/send-destination.test.ts`: every test, the sendable question through the door as svc-pay asks it.
//! - `ramps/wallet-ownership.test.ts` and `ramps/wallet-ownership.db.test.ts`: every test, the flows through the door.
//! - `ramps/fraud-list.db.test.ts`, `ramps/fraud-list.test.ts`: every test on the book and the desk's calls.
//! - `ramps/sanctions-list.test.ts`: the saving half (`saving a withdrawal address against the sanctions list`).
//! - `withdraw-destination.test.ts`: the shape checks, the checksum, the look-alike and the legacy slot.
//!
//! Not ported, with the reason:
//! - The memory stores' runs of each `describe.each` (`memoryWithdrawDestinations`, `memoryApprovalLinks`,
//!   `memoryWalletProofs`, `memoryFraudList`): the TypeScript's test doubles; the Rust has only the Postgres store, which
//!   each test here runs on.
//! - The off-ramp's tests in `fraud-list.db.test.ts` (`a send to a listed address is refused before anything is claimed or
//!   held…`, `a reused send id naming a listed address…`, `the legacy withdrawal-address door refuses a listed address…`):
//!   calls of the off-ramp (`ramps.offramp`, `ramps.setWithdrawDestination`), slice `ramps`' other half; the fraud-list
//!   check they reach is `book::fraud::is_listed`, held here.
//! - `sanctions-list.test.ts`' reading half (`reading the owner setting`, `reads a list with a network that is not a
//!   network id as unset`): `ramps::sanctions`' own unit tests hold it.
//! - The sendable door's caller checks (`serves svc-pay only…`, `refuses an input with a field it does not name`): the
//!   door decides them from the call's record, held by the guard grid and the wire replay.
//!
//! The ledger is a stand-in that answers the asset registry (or fails); identity is stand-ins for the security lock,
//! the approval mail (a recorder) and trusted devices; the operator's approvals are a desk stand-in bound to one action
//! and its fields and consumed once. Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
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

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use k256::ecdsa::SigningKey;
use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding, random_uuid,
};
use service_kit::edge;
use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::Amount;
use service_kit::s2s::{self, CallSigner};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::errors::Refusal;
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::refuse;
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::ramps::book::ports::{
    ApprovalMail, DeviceState, IdentityHttp, MailRequest, TrustedDevices, device_may_approve,
};
use svc_bank::ramps::book::store::{self, SaveInput, SavedOn};
use svc_bank::ramps::book::{approval, customer, fraud, ownership};
use svc_bank::ramps::{self, Settings};
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, Lookup, Lookups,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::{LockState, MemoryIdentity, SecurityLock};
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-address-book-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-address-book-db-internal-secret-long-ok";
const OPERATOR: &str = "77777777-7777-4777-8777-777777777777";
const APPROVER: &str = "88888888-8888-4888-8888-888888888888";
const MAIL_ID: &str = "55555555-5555-4555-8555-555555555555";
/// The device every approval test approves from, as identity answers a device approved by a mailed code.
const PROVED_DEVICE: &str = "bbbbbbbb-1111-4111-8111-000000000002";
const ADDRESS: &str = "0x1111111111111111111111111111111111111111";
const ADDR_A: &str = "0x1111111111111111111111111111111111111111";
const ADDR_B: &str = "0x2222222222222222222222222222222222222222";
const ADDR_C: &str = "0x3333333333333333333333333333333333333333";
const IBAN: &str = "DE89370400440532013000";
/// A sanctions list that is set and names an address no test saves: every other address is clear.
const SANCTIONS: &str = "*:0x00000000000000000000000000000000000dead1";
const STEPPED: &[&str] = &["bank:read", "bank:write", "trade:withdraw"];
const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// The clock: the door's `now` is a plain function, so each test thread sets its own time.

thread_local! {
    static CLOCK: Cell<i64> = const { Cell::new(0) };
}

fn clock() -> Instant {
    let at = CLOCK.with(Cell::get);
    if at == 0 {
        door::system_now()
    } else {
        Instant(at)
    }
}

fn set_now(ms: i64) {
    CLOCK.with(|n| n.set(ms));
}

/// The clock held where it reads now, so a test can move it on.
fn hold_now() -> i64 {
    let now = door::system_now().0;
    set_now(now);
    now
}

static USERS: AtomicUsize = AtomicUsize::new(0);

/// A fresh customer id per test, so no two tests see each other's rows.
fn fresh() -> String {
    format!(
        "00000000-0000-4000-8000-{:012}",
        USERS.fetch_add(1, Ordering::SeqCst) + 1
    )
}

fn uuid() -> String {
    random_uuid().unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

/// svc-ledger's asset registry: rows, or a read that fails.
#[derive(Clone)]
struct Registry(Arc<Mutex<Option<Vec<Json>>>>);

fn registry_row(id: &str, networks: &[&str], actions: &[&str]) -> Json {
    Json::obj([
        ("id", Json::str(id)),
        ("kind", Json::str("crypto")),
        ("precision", Json::Number(6.0)),
        (
            "networks",
            Json::Array(
                networks
                    .iter()
                    .map(|n| {
                        Json::obj([
                            ("networkId", Json::str(*n)),
                            ("label", Json::str(format!("TEST {n}"))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "defaultNetworkId",
            networks.first().map_or(Json::Null, |n| Json::str(*n)),
        ),
        (
            "allowedActions",
            Json::Array(actions.iter().map(|a| Json::str(*a)).collect()),
        ),
        ("state", Json::str("active")),
        ("revision", Json::Number(1.0)),
        ("updatedAt", Json::str("2026-10-23T00:00:00.000Z")),
    ])
}

impl Default for Registry {
    /// `REGISTRY`: USDT withdrawn on erc20 and base, BTC deposit only.
    fn default() -> Registry {
        Registry(Arc::new(Mutex::new(Some(vec![
            registry_row("USDT", &["erc20", "base"], &["deposit", "withdraw"]),
            registry_row("BTC", &["bitcoin"], &["deposit"]),
        ]))))
    }
}

impl Registry {
    fn set(&self, rows: Option<Vec<Json>>) {
        *self.0.lock().unwrap() = rows;
    }
}

impl Ledger for Registry {
    fn balance(&self, _account: &LedgerAccount) -> Result<Amount, String> {
        Ok(0)
    }
    fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(Vec::new())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        self.0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "ledger timed out".to_owned())
    }
}

/// Identity's mail door as a recorder: every request it was asked, and what it answers.
#[derive(Clone, Default)]
struct Mailbox(Arc<Mutex<MailState>>);

#[derive(Default)]
struct MailState {
    sent: Vec<MailRequest>,
    refuse: Option<Refusal>,
    /// The mail id it answers; `MAIL_ID` when unset.
    mail_id: Option<String>,
}

impl Mailbox {
    fn sent(&self) -> Vec<MailRequest> {
        self.0.lock().unwrap().sent.clone()
    }
    fn token(&self, i: usize) -> String {
        self.sent()[i].token.clone()
    }
    fn refuse_with(&self, r: Option<Refusal>) {
        self.0.lock().unwrap().refuse = r;
    }
    fn answer_id(&self, id: &str) {
        self.0.lock().unwrap().mail_id = Some(id.to_owned());
    }
}

impl ApprovalMail for Mailbox {
    fn send(&self, request: &MailRequest) -> Result<String, Refusal> {
        let mut st = self.0.lock().unwrap();
        if let Some(r) = st.refuse.clone() {
            return Err(r);
        }
        st.sent.push(request.clone());
        Ok(st.mail_id.clone().unwrap_or_else(|| MAIL_ID.to_owned()))
    }
}

/// `memoryTrustedDevices`: identity's answer per device, an unknown one neither live nor trusted.
#[derive(Clone, Default)]
struct Devices(Arc<Mutex<(BTreeMap<String, DeviceState>, Option<Refusal>)>>);

fn device(live: bool, trusted_by: Option<&str>, check: &str) -> DeviceState {
    DeviceState {
        live,
        trusted_by: trusted_by.map(str::to_owned),
        new_device_check: check.to_owned(),
    }
}

impl Devices {
    fn proved() -> Devices {
        let d = Devices::default();
        d.set(PROVED_DEVICE, device(true, Some("approval"), "on"));
        d
    }
    fn set(&self, id: &str, state: DeviceState) {
        self.0.lock().unwrap().0.insert(id.to_owned(), state);
    }
    fn fail_with(&self, r: Option<Refusal>) {
        self.0.lock().unwrap().1 = r;
    }
}

impl TrustedDevices for Devices {
    fn read(&self, _user_id: &str, device_id: &str) -> Result<DeviceState, Refusal> {
        let st = self.0.lock().unwrap();
        if let Some(r) = st.1.clone() {
            return Err(r);
        }
        Ok(st
            .0
            .get(device_id)
            .cloned()
            .unwrap_or_else(|| device(false, None, "on")))
    }
}

/// The security lock, as `memorySecurityLock`.
#[derive(Clone, Default)]
struct Lock(Arc<MemoryIdentity>);

impl Lock {
    fn set(&self, user: &str, locked: bool) {
        self.0.set_lock(
            user,
            LockState {
                locked,
                unlocks_at: None,
                self_frozen: false,
            },
        );
    }
    fn fail_with(&self, r: Option<Refusal>) {
        *self.0.lock_failure.lock().unwrap() = r;
    }
}

impl SecurityLock for Lock {
    fn read(&self, user_id: &str) -> Result<LockState, Refusal> {
        SecurityLock::read(&*self.0, user_id)
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

impl Desk {
    /// The approval's ids, as the desk sends them with the change.
    fn issue(&self, action: &str, fields: &[(String, String)]) -> Vec<(String, Json)> {
        let id = uuid();
        self.0
            .lock()
            .unwrap()
            .issued
            .insert(id.clone(), (action.to_owned(), payload_hash(action, fields)));
        vec![
            ("approvalId".to_owned(), Json::str(id)),
            ("operationId".to_owned(), Json::str(uuid())),
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
                expires_at: Instant(door::system_now().0 + 60_000).iso(),
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

struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The door

/// The owner's values every test starts from: a book of five, a set sanctions list, the proof window and validity,
/// the link lifetime; the cooling-off unset unless a test sets it.
fn owner() -> Settings {
    Settings {
        address_book_cap: Some("5".to_owned()),
        destination_sanctions: Some(SANCTIONS.to_owned()),
        wallet_proof_window_minutes: Some("30".to_owned()),
        wallet_proof_valid_days: Some("180".to_owned()),
        address_approval_link_minutes: Some("30".to_owned()),
        app_env: Some("test".to_owned()),
        node_env: Some("test".to_owned()),
        ..Settings::default()
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    registry: Registry,
    mail: Mailbox,
    devices: Devices,
    lock: Lock,
    desk: Desk,
}

fn door_for(
    db: &TestDb,
    registry: &Registry,
    mail: &Mailbox,
    devices: &Devices,
    lock: &Lock,
    desk: &Desk,
    settings: Settings,
) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.lock = Box::new(lock.clone());
    transfers.approvals = Box::new(desk.clone());
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth {
            secret: Some(INTERNAL.to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: clock,
        store: db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: None,
        freeze: Box::new(Open),
        custody_layer: "off".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(registry.clone()),
        directory: Box::new(NoPeople),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("20".to_owned()),
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
    .with_ramps(ramps::Wiring {
        settings,
        book: ramps::book::Wiring {
            mail: Box::new(mail.clone()),
            devices: Box::new(devices.clone()),
        },
        onramp: ramps::onramp::Wiring::none(),
    })
}

fn bank_with(settings: Settings) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let registry = Registry::default();
    let mail = Mailbox::default();
    let devices = Devices::proved();
    let lock = Lock::default();
    let desk = Desk::default();
    let door = door_for(&db, &registry, &mail, &devices, &lock, &desk, settings);
    Some(Bank {
        door,
        db,
        registry,
        mail,
        devices,
        lock,
        desk,
    })
}

fn bank() -> Option<Bank> {
    bank_with(owner())
}

impl Bank {
    /// The same database and stand-ins under other owner values.
    fn reopened(&self, settings: Settings) -> BankDoor {
        door_for(
            &self.db,
            &self.registry,
            &self.mail,
            &self.devices,
            &self.lock,
            &self.desk,
            settings,
        )
    }
    fn client(&self) -> postgres::Client {
        self.db.client()
    }
    /// `destinations.list(userId)` on the store.
    fn rows(&self, user: &str) -> Vec<store::Destination> {
        store::list(&mut self.client(), user).unwrap()
    }
    /// `destinations.save` on the store, with a cap of `cap`.
    fn store_save(&self, cap: Option<&str>, input: &SaveInput<'_>) -> Result<store::Destination, Refusal> {
        store::save(&self.db.store(), cap, input)
    }
    fn count(&self, q: &str) -> i64 {
        self.db.count(q)
    }
}

/// A saved entry's input: USDT on erc20 at `r`, labelled `label`, saved from no named sign-in.
fn entry<'a>(user: &'a str, r: &'a str, label: &'a str) -> SaveInput<'a> {
    SaveInput {
        user_id: user,
        asset_id: "USDT",
        network: "erc20",
        r#ref: r,
        tag: None,
        label,
        lookalike_of: None,
        saved_on: SavedOn {
            fam: None,
            dev: None,
        },
    }
}

fn code_of<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        Err(Refusal::Trpc(t)) => format!("trpc:{t:?}"),
        other => panic!("expected a bank refusal: {other:?}"),
    }
}

/// The principal the edge signs: the person, their scopes, and the sign-in and device the token names.
fn person_on(user: &str, scopes: &[&str], fam: Option<&str>, dev: Option<&str>) -> Vec<(String, String)> {
    let mut fields = vec![
        ("sub".to_owned(), Json::str(user)),
        (
            "scopes".to_owned(),
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier".to_owned(), Json::str("full")),
        ("mfa".to_owned(), Json::Bool(true)),
        (
            "sid".to_owned(),
            Json::str("99999999-9999-4999-8999-999999999999"),
        ),
        ("userId".to_owned(), Json::str(user)),
        ("expiresAt".to_owned(), Json::str("2099-01-01T00:00:00.000Z")),
    ];
    if let Some(f) = fam {
        fields.push(("fam".to_owned(), Json::str(f)));
    }
    if let Some(d) = dev {
        fields.push(("dev".to_owned(), Json::str(d)));
    }
    let raw = Json::Object(fields).compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ]
}

fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    person_on(user, scopes, None, None)
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

/// One answer: the status, and the data or the error.
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
    /// The refusal's own code (`cause.code`), or `ok`.
    fn code(&self) -> String {
        let cause = self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"));
        match (self.0, cause) {
            (200, _) => "ok".to_owned(),
            (_, Some(Json::String(c))) => c.clone(),
            (_, _) => self.trpc(),
        }
    }
    /// tRPC's code (`FORBIDDEN`, `BAD_REQUEST`, ...).
    fn trpc(&self) -> String {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => "ok".to_owned(),
        }
    }
    fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
}

fn send(
    door: &BankDoor,
    path: &str,
    input: Option<&str>,
    mut headers: Vec<(String, String)>,
) -> Answer {
    let kind = door::call(path).map(|c| c.kind);
    let (method, url, body) = match kind {
        Some(Kind::Query) => (
            "GET",
            match input {
                Some(i) => format!("/trpc/{path}?input={}", encode(i)),
                None => format!("/trpc/{path}"),
            },
            String::new(),
        ),
        _ => (
            "POST",
            format!("/trpc/{path}"),
            input.unwrap_or("").to_owned(),
        ),
    };
    if !body.is_empty() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let res = door.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-book-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// A call as the person with these scopes and this sign-in.
fn call_as(
    door: &BankDoor,
    headers: Vec<(String, String)>,
    path: &str,
    input: &Json,
) -> Answer {
    let body = input.compact();
    send(door, path, (body != "null").then_some(body.as_str()), headers)
}

/// A call as the person with the step-up scope and no named sign-in.
fn call(door: &BankDoor, user: &str, path: &str, input: &Json) -> Answer {
    call_as(door, person(user, STEPPED), path, input)
}

/// A call as a service, signed.
fn call_service(door: &BankDoor, service: &str, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    let headers =
        s2s::legacy_headers(service, INTERNAL, &body, clock().0.div_euclid(1000)).unwrap();
    send(door, path, Some(&body), headers)
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn s(v: &str) -> Json {
    Json::str(v)
}

/// A field of an answer, as text: a string as itself, null or missing as `null`, anything else compact.
fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn list_of(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(v) => v.clone(),
        other => panic!("not a list: {}", other.compact()),
    }
}

/// `ramps.destinations.save` of USDT on erc20 at `r` labelled `label`, as `user` on this sign-in.
fn save_on(
    door: &BankDoor,
    user: &str,
    r: &str,
    label: &str,
    fam: Option<&str>,
    dev: Option<&str>,
) -> Answer {
    call_as(
        door,
        person_on(user, STEPPED, fam, dev),
        "ramps.destinations.save",
        &obj(&[
            ("assetId", s("USDT")),
            ("network", s("erc20")),
            ("ref", s(r)),
            ("label", s(label)),
        ]),
    )
}

/// `saved(destinations, u)`: the approval suites' entry, `Cold wallet` at `ADDRESS`, its id.
fn saved(b: &Bank, user: &str) -> String {
    text(
        &save_on(&b.door, user, ADDRESS, "Cold wallet", None, None).ok(),
        "destinationId",
    )
}

fn request_mail(door: &BankDoor, user: &str, id: &str) -> Answer {
    call(
        door,
        user,
        "ramps.destinations.approval.requestMail",
        &obj(&[("destinationId", s(id))]),
    )
}

fn confirm_link(door: &BankDoor, user: &str, token: &str) -> Answer {
    call(
        door,
        user,
        "ramps.destinations.approval.confirmLink",
        &obj(&[("token", s(token))]),
    )
}

fn on_device(door: &BankDoor, user: &str, id: &str, fam: Option<&str>, dev: Option<&str>) -> Answer {
    call_as(
        door,
        person_on(user, STEPPED, fam, dev),
        "ramps.destinations.approval.onDevice",
        &obj(&[("destinationId", s(id))]),
    )
}

fn open_links(b: &Bank, user: &str) -> Vec<(String, String)> {
    approval::open_links(&mut b.client(), user, clock()).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// ramps/address-approval.db.test.ts: new-address approval (W-withdraw-09)

#[test]
fn mails_a_single_use_link_under_a_numbered_business_key_with_what_the_address_is_and_until_when_the_link_works() {
    let Some(b) = bank() else { return };
    // A clock with milliseconds, so the expiry's rounding to the second shows.
    let now = hold_now().div_euclid(1000) * 1000 + 789;
    set_now(now);
    let u = fresh();
    let id = saved(&b, &u);
    let asked = request_mail(&b.door, &u, &id).ok();
    let expires_at = Instant(now.div_euclid(1000) * 1000 + 30 * MINUTE).iso();
    assert_eq!(
        asked.compact(),
        obj(&[("destinationId", s(&id)), ("expiresAt", s(&expires_at))]).compact()
    );
    let sent = b.mail.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].key, format!("address-approval:{id}:1"));
    assert_eq!(sent[0].user_id, u);
    assert_eq!(sent[0].detail, "USDT on erc20, 0x1111...1111");
    assert_eq!(sent[0].expires_at, expires_at);
    assert!(sent[0].body().contains("\"purpose\":\"withdraw-address-approval\""));
    let token = &sent[0].token;
    assert_eq!(token.len(), 43, "{token}");
    assert!(
        token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
        "{token}"
    );
    // The book says a link is out, and until when.
    assert_eq!(open_links(&b, &u), vec![(id.clone(), expires_at)]);
    // Asking again is the next link, with its own key and token.
    request_mail(&b.door, &u, &id).ok();
    let sent = b.mail.sent();
    assert_eq!(sent[1].key, format!("address-approval:{id}:2"));
    assert_ne!(sent[1].token, sent[0].token);
}

#[test]
fn refuses_a_link_with_no_owner_lifetime_while_locked_and_for_an_entry_approved_already_mailing_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    let unset = b.reopened(Settings {
        address_approval_link_minutes: Some(String::new()),
        ..owner()
    });
    assert_eq!(
        request_mail(&unset, &u, &id).code(),
        "bank.address_approval_link_unset"
    );
    // More than seven days is more than identity shows a link for.
    assert_eq!(
        code_of(approval::require_link_minutes(Some("10081"))),
        "bank.address_approval_link_unset"
    );
    assert_eq!(approval::require_link_minutes(Some("10080")).unwrap(), 10080);

    let v = fresh();
    let other = saved(&b, &v);
    b.lock.set(&v, true);
    assert_eq!(request_mail(&b.door, &v, &other).code(), "bank.security_locked");
    b.lock.set(&v, false);
    store::approve(&mut b.client(), &v, &other, "link").unwrap();
    assert_eq!(
        request_mail(&b.door, &v, &other).code(),
        "bank.address_approval_not_pending"
    );
    assert!(b.mail.sent().is_empty());
}

#[test]
fn approves_by_the_newest_link_for_the_customer_it_was_sent_to_the_cooling_off_starts_then_and_opening_it_again_changes_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    let token = b.mail.token(0);
    // Someone else signed in, or a made-up token, is not told whose link it is.
    assert_eq!(
        confirm_link(&b.door, &fresh(), &token).code(),
        "bank.address_approval_link_invalid"
    );
    assert_eq!(
        confirm_link(&b.door, &u, &"A".repeat(43)).code(),
        "bank.address_approval_link_invalid"
    );
    let last = if token.ends_with('A') { "B" } else { "A" };
    let tampered = format!("{}{last}", &token[..token.len() - 1]);
    assert_eq!(
        confirm_link(&b.door, &u, &tampered).code(),
        "bank.address_approval_link_invalid"
    );
    let approved = confirm_link(&b.door, &u, &token).ok();
    assert_eq!(text(&approved, "destinationId"), id);
    assert_eq!(text(&approved, "state"), "cooling");
    assert_eq!(text(&approved, "approvedBy"), "link");
    assert!(open_links(&b, &u).is_empty());
    let again = confirm_link(&b.door, &u, &token).ok();
    assert_eq!(text(&again, "state"), "cooling");
    assert_eq!(text(&again, "approvedBy"), "link");
    assert_eq!(text(&again, "updatedAt"), text(&approved, "updatedAt"));
}

#[test]
fn a_replaced_or_expired_link_approves_nothing_and_says_which_a_new_link_then_works() {
    let Some(b) = bank() else { return };
    let now = hold_now();
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    request_mail(&b.door, &u, &id).ok();
    let (first, second) = (b.mail.token(0), b.mail.token(1));
    assert_eq!(
        confirm_link(&b.door, &u, &first).code(),
        "bank.address_approval_link_replaced"
    );
    set_now(now + 31 * MINUTE);
    assert_eq!(
        confirm_link(&b.door, &u, &second).code(),
        "bank.address_approval_link_expired"
    );
    assert!(open_links(&b, &u).is_empty());
    assert_eq!(b.rows(&u)[0].state, "pending");
    request_mail(&b.door, &u, &id).ok();
    assert_eq!(
        text(&confirm_link(&b.door, &u, &b.mail.token(2)).ok(), "state"),
        "cooling"
    );
}

#[test]
fn a_link_whose_mail_identity_refused_was_never_sent_so_it_never_works_and_the_one_before_it_still_does() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    b.mail.refuse_with(Some(refuse(
        "bank.address_approval_mail_unavailable",
        "no mail service",
    )));
    assert_eq!(
        request_mail(&b.door, &u, &id).code(),
        "bank.address_approval_mail_unavailable"
    );
    assert_eq!(
        text(&confirm_link(&b.door, &u, &b.mail.token(0)).ok(), "state"),
        "cooling"
    );
}

#[test]
fn refuses_to_approve_by_link_while_the_security_lock_holds_and_the_link_still_works_once_it_ends() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    b.lock.set(&u, true);
    assert_eq!(
        confirm_link(&b.door, &u, &b.mail.token(0)).code(),
        "bank.security_locked"
    );
    b.lock.set(&u, false);
    assert_eq!(
        text(&confirm_link(&b.door, &u, &b.mail.token(0)).ok(), "state"),
        "cooling"
    );
}

#[test]
fn two_openings_of_one_link_at_once_both_answer_the_approved_entry_approved_once() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    let token = b.mail.token(0);
    let (x, y) = std::thread::scope(|sc| {
        let one = sc.spawn(|| confirm_link(&b.door, &u, &token));
        let two = sc.spawn(|| confirm_link(&b.door, &u, &token));
        (one.join().unwrap().ok(), two.join().unwrap().ok())
    });
    for a in [&x, &y] {
        assert_eq!(text(a, "state"), "cooling");
        assert_eq!(text(a, "approvedBy"), "link");
    }
    assert_eq!(text(&y, "updatedAt"), text(&x, "updatedAt"));
}

#[test]
fn an_older_or_expired_link_for_an_address_approved_already_answers_it_as_approved_and_changes_nothing() {
    let Some(b) = bank() else { return };
    let now = hold_now();
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    request_mail(&b.door, &u, &id).ok();
    let approved = confirm_link(&b.door, &u, &b.mail.token(1)).ok();
    set_now(now + 31 * MINUTE);
    for token in [b.mail.token(0), b.mail.token(1)] {
        let again = confirm_link(&b.door, &u, &token).ok();
        assert_eq!(text(&again, "state"), "cooling");
        assert_eq!(text(&again, "approvedBy"), "link");
        assert_eq!(text(&again, "updatedAt"), text(&approved, "updatedAt"));
    }
}

#[test]
fn a_link_the_bank_failed_to_record_as_mailed_still_works_its_token_only_exists_in_the_mail_identity_took() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    // A mail id the links table cannot hold makes recording the mail fail after identity took it.
    b.mail.answer_id("not-a-uuid");
    let failed = request_mail(&b.door, &u, &id);
    assert_eq!(failed.0, 500, "{}", failed.1.compact());
    assert_eq!(b.mail.sent().len(), 1);
    assert_eq!(
        text(&confirm_link(&b.door, &u, &b.mail.token(0)).ok(), "state"),
        "cooling"
    );
}

#[test]
fn a_link_to_an_address_removed_since_approves_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = saved(&b, &u);
    request_mail(&b.door, &u, &id).ok();
    store::remove(&b.db.store(), &u, &id, &format!("remove:{id}")).unwrap();
    assert_eq!(
        confirm_link(&b.door, &u, &b.mail.token(0)).code(),
        "bank.withdraw_destination_missing"
    );
}

// from another signed-in device

const SIGN_IN_A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const SIGN_IN_B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
const DEVICE_A: &str = "aaaaaaaa-1111-4111-8111-000000000001";
const DEVICE_B: &str = PROVED_DEVICE;

fn saved_from(b: &Bank, user: &str, fam: Option<&str>, dev: Option<&str>) -> Json {
    save_on(&b.door, user, ADDRESS, "Cold wallet", fam, dev).ok()
}

#[test]
fn approves_from_another_trusted_device_the_cooling_off_starts_then_by_device_and_again_changes_nothing() {
    let Some(b) = bank() else { return };
    let now = hold_now();
    let u = fresh();
    let entry = saved_from(&b, &u, Some(SIGN_IN_A), Some(DEVICE_A));
    let id = text(&entry, "destinationId");
    assert_eq!(
        store::saved_on(&mut b.client(), &u, &id).unwrap(),
        Some(SavedOn {
            fam: Some(SIGN_IN_A.to_owned()),
            dev: Some(DEVICE_A.to_owned()),
        })
    );
    // A second sign-in that names no device is not a second device.
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_B), None).code(),
        "bank.address_approval_device_unknown"
    );
    let approved = on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_B)).ok();
    assert_eq!(text(&approved, "state"), "cooling");
    assert_eq!(text(&approved, "approvedBy"), "device");
    assert_ne!(text(&approved, "approvedAt"), "null");
    assert!(text(&approved, "updatedAt") >= text(&entry, "updatedAt"));
    set_now(now + MINUTE);
    let again = on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_B)).ok();
    assert_eq!(again.compact(), approved.compact());
}

#[test]
fn refuses_the_device_that_saved_it_even_after_a_refresh_or_a_new_sign_in_there_and_changes_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(&saved_from(&b, &u, Some(SIGN_IN_A), Some(DEVICE_A)), "destinationId");
    // The same sign-in (a refreshed token keeps `fam`).
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_A), Some(DEVICE_A)).code(),
        "bank.address_approval_same_device"
    );
    // A new sign-in on the same trusted device is still that device.
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_A)).code(),
        "bank.address_approval_same_device"
    );
    // With no device on the approving side, the sign-in decides: the same one refuses.
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_A), None).code(),
        "bank.address_approval_same_device"
    );
    let still = &b.rows(&u)[0];
    assert_eq!(still.state, "pending");
    assert_eq!((still.approved_at, still.approved_by.clone()), (None, None));
    // Another trusted device approves.
    let ok = on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_B)).ok();
    assert_eq!((text(&ok, "state"), text(&ok, "approvedBy")), ("cooling".to_owned(), "device".to_owned()));
}

#[test]
fn refuses_when_either_side_names_no_sign_in_unknown_is_never_a_different_device_and_the_emailed_link_still_works() {
    let Some(b) = bank() else { return };
    let u = fresh();
    // Saved from a token that named neither (an older token, or an entry saved before this).
    let id = text(&saved_from(&b, &u, None, None), "destinationId");
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_B)).code(),
        "bank.address_approval_device_unknown"
    );
    let v = fresh();
    let other = text(&saved_from(&b, &v, Some(SIGN_IN_A), None), "destinationId");
    assert_eq!(
        on_device(&b.door, &v, &other, None, None).code(),
        "bank.address_approval_device_unknown"
    );
    request_mail(&b.door, &u, &id).ok();
    let ok = confirm_link(&b.door, &u, &b.mail.token(0)).ok();
    assert_eq!((text(&ok, "state"), text(&ok, "approvedBy")), ("cooling".to_owned(), "link".to_owned()));
}

#[test]
fn refuses_while_the_security_lock_holds_another_customers_entry_and_a_removed_or_missing_one() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(&saved_from(&b, &u, Some(SIGN_IN_A), None), "destinationId");
    b.lock.set(&u, true);
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_B), None).code(),
        "bank.security_locked"
    );
    b.lock.set(&u, false);
    let stranger = fresh();
    assert_eq!(
        on_device(&b.door, &stranger, &id, Some(SIGN_IN_B), None).code(),
        "bank.withdraw_destination_missing"
    );
    assert_eq!(store::saved_on(&mut b.client(), &stranger, &id).unwrap(), None);
    store::remove(&b.db.store(), &u, &id, &format!("remove:{id}")).unwrap();
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_B), None).code(),
        "bank.withdraw_destination_missing"
    );
}

#[test]
fn asks_identity_about_the_approving_device_removed_trusted_only_by_signing_in_or_with_the_check_off_it_refuses() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(&saved_from(&b, &u, Some(SIGN_IN_A), Some(DEVICE_A)), "destinationId");
    let approve = || on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_B));
    for state in [
        device(false, Some("approval"), "on"),
        device(true, Some("sign-in"), "on"),
        device(true, Some("approval"), "off"),
        device(false, None, "on"),
    ] {
        b.devices.set(DEVICE_B, state.clone());
        assert_eq!(approve().code(), "bank.address_approval_device_untrusted", "{state:?}");
    }
    b.devices.fail_with(Some(refuse(
        "bank.address_approval_device_unavailable",
        "identity down",
    )));
    assert_eq!(approve().code(), "bank.address_approval_device_unavailable");
    let still = &b.rows(&u)[0];
    assert_eq!((still.state.as_str(), still.approved_by.clone()), ("pending", None));
    // The device the account was made on is proved too.
    b.devices.fail_with(None);
    b.devices.set(DEVICE_B, device(true, Some("sign-up"), "on"));
    let ok = approve().ok();
    assert_eq!((text(&ok, "state"), text(&ok, "approvedBy")), ("cooling".to_owned(), "device".to_owned()));
}

#[test]
fn an_entry_approved_by_link_answers_as_it_is_the_saving_ids_must_be_uuids() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(&saved_from(&b, &u, Some(SIGN_IN_A), None), "destinationId");
    request_mail(&b.door, &u, &id).ok();
    let by_link = confirm_link(&b.door, &u, &b.mail.token(0)).ok();
    // Even the saving device gets the approved entry back: there is nothing left to approve.
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_A), None).ok().compact(),
        by_link.compact()
    );
    let mut input = entry(&u, ADDRESS, "Cold wallet");
    let other = fresh();
    input.user_id = &other;
    input.saved_on.fam = Some("not-a-uuid".to_owned());
    assert_eq!(
        code_of(b.store_save(Some("5"), &input)),
        "bank.ramp_invalid_destination"
    );
}

// telling a different device

#[test]
fn telling_a_different_device() {
    let (f1, f2, d1, d2) = (
        "11111111-0000-4000-8000-000000000001",
        "22222222-0000-4000-8000-000000000002",
        "33333333-0000-4000-8000-000000000003",
        "44444444-0000-4000-8000-000000000004",
    );
    let on = |fam: Option<&str>, dev: Option<&str>| SavedOn {
        fam: fam.map(str::to_owned),
        dev: dev.map(str::to_owned),
    };
    let d1_upper = d1.to_uppercase();
    let cases = [
        ("both devices named and different", on(Some(f1), Some(d1)), on(Some(f1), Some(d2)), "different"),
        ("both devices named and the same, new sign-in", on(Some(f1), Some(d1)), on(Some(f2), Some(d1)), "same"),
        (
            "one device missing, different sign-ins: a second sign-in is not a second device",
            on(Some(f1), Some(d1)),
            on(Some(f2), None),
            "unknown",
        ),
        ("one device missing, the same sign-in", on(Some(f1), None), on(Some(f1), Some(d2)), "same"),
        ("no sign-in on the saving side", on(None, Some(d1)), on(Some(f2), None), "unknown"),
        ("no sign-in on the approving side", on(Some(f1), None), on(None, None), "unknown"),
        ("nothing named on either side", on(None, None), on(None, None), "unknown"),
        (
            "different devices, but the approving token names no sign-in",
            on(Some(f1), Some(d1)),
            on(None, Some(d2)),
            "unknown",
        ),
        (
            "case does not make a different device",
            on(Some(f1), Some(d1)),
            on(Some(f2), Some(&d1_upper)),
            "same",
        ),
    ];
    for (name, saved, approving, expected) in cases {
        assert_eq!(approval::device_comparison(&saved, &approving), expected, "{name}");
    }
}

// postgres: the approval links table

#[test]
fn keeps_only_the_sha256_of_a_token_never_the_token() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(&save_on(&b.door, &u, ADDRESS, "Hash test", None, None).ok(), "destinationId");
    request_mail(&b.door, &u, &id).ok();
    let token = b.mail.token(0);
    let rows = b
        .client()
        .query(
            "SELECT token_hash, mail_id::text, row_to_json(l)::text FROM bank.destination_approval_links l WHERE user_id = $1",
            &[&u],
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    let hash: String = rows[0].get(0);
    let expected: String = Sha256::digest(token.as_bytes())
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    assert_eq!(hash, expected);
    let whole: String = rows[0].get(2);
    assert!(!whole.contains(&token));
    let mail_id: String = rows[0].get(1);
    assert_eq!(mail_id, MAIL_ID);
}

// identity's mail door

/// identity answering one status and body, recording what it was asked.
#[derive(Clone)]
struct Answering(Arc<Mutex<Vec<HttpRequest>>>, Option<(u16, String)>);

impl Fetch for Answering {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.0.lock().unwrap().push(req.clone());
        match &self.1 {
            Some((status, body)) => Ok(HttpResponse {
                status: *status,
                body: body.clone(),
            }),
            None => Err(FetchError {
                message: "fetch failed".to_owned(),
            }),
        }
    }
}

fn mail_request() -> MailRequest {
    MailRequest {
        key: "address-approval:66666666-6666-4666-8666-666666666666:1".to_owned(),
        user_id: "77777777-7777-4777-8777-777777777777".to_owned(),
        token: "A".repeat(43),
        detail: "USDT on erc20, 0x1111...1111".to_owned(),
        expires_at: "2026-10-24T12:00:00.000Z".to_owned(),
    }
}

fn identity_mail(base: &str, answer: Option<(u16, &str)>) -> (IdentityHttp, Answering) {
    let fetch = Answering(
        Arc::new(Mutex::new(Vec::new())),
        answer.map(|(s, b)| (s, b.to_owned())),
    );
    let signer = CallSigner::new(
        "svc-bank",
        "svc-identity",
        "a-bank-approval-mail-test-secret-long-enough",
        None,
    );
    (IdentityHttp::new(base, signer, Box::new(fetch.clone())), fetch)
}

#[test]
fn posts_the_request_signed_as_svc_bank_and_returns_the_mail_id() {
    let (port, fetch) = identity_mail(
        "http://identity.test/",
        Some((200, &format!("{{\"accepted\":true,\"mailId\":\"{MAIL_ID}\"}}"))),
    );
    assert_eq!(port.send(&mail_request()).unwrap(), MAIL_ID);
    let calls = fetch.0.lock().unwrap();
    assert_eq!(calls[0].url, "http://identity.test/internal/mail");
    assert_eq!(calls[0].method, "POST");
    let sent = json::parse(calls[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(
        sent.compact(),
        Json::obj([
            ("key", s("address-approval:66666666-6666-4666-8666-666666666666:1")),
            ("userId", s("77777777-7777-4777-8777-777777777777")),
            ("purpose", s("withdraw-address-approval")),
            ("token", Json::str("A".repeat(43))),
            ("detail", s("USDT on erc20, 0x1111...1111")),
            ("expiresAt", s("2026-10-24T12:00:00.000Z")),
        ])
        .compact()
    );
    assert!(
        calls[0]
            .headers
            .iter()
            .any(|(k, _)| k.to_lowercase().starts_with("x-intafaced")),
        "{:?}",
        calls[0].headers
    );
}

#[test]
fn maps_identitys_answers_to_a_refusal_the_customer_can_be_told() {
    for (case, status, body, code) in [
        ("no mail service", 503, r#"{"code":"identity.mail_unwired"}"#, "bank.address_approval_mail_unavailable"),
        ("no proved email", 409, r#"{"code":"identity.email_unproved"}"#, "bank.address_approval_email_unproved"),
        ("an inactive account", 409, r#"{"code":"identity.account_not_active"}"#, "bank.address_approval_email_unproved"),
        ("a key conflict", 409, r#"{"code":"identity.mail_key_conflict"}"#, "bank.address_approval_mail_unavailable"),
        ("a server error", 500, "oops", "bank.address_approval_mail_unavailable"),
        ("an answer with no mail id", 200, r#"{"accepted":true}"#, "bank.address_approval_mail_unavailable"),
    ] {
        let (port, _) = identity_mail("http://identity.test", Some((status, body)));
        assert_eq!(code_of(port.send(&mail_request())), code, "{case}");
    }
}

#[test]
fn is_unavailable_when_identity_does_not_answer() {
    let (port, _) = identity_mail("http://identity.test", None);
    assert_eq!(
        code_of(port.send(&mail_request())),
        "bank.address_approval_mail_unavailable"
    );
}

// which devices may approve

#[test]
fn only_a_live_proved_device_while_the_new_device_check_is_on() {
    assert!(device_may_approve(&device(true, Some("approval"), "on")));
    assert!(device_may_approve(&device(true, Some("sign-up"), "on")));
    assert!(!device_may_approve(&device(true, Some("sign-in"), "on")));
    assert!(!device_may_approve(&device(true, Some("approval"), "off")));
    assert!(!device_may_approve(&device(false, Some("approval"), "on")));
    assert!(!device_may_approve(&device(true, None, "on")));
}

// ---------------------------------------------------------------------------------------------------------------
// address-book.db.test.ts: the store (W-withdraw-08)

/// The suite's `save`: `usdt` on `ERC20` at `ADDR_A`, `Cold wallet`, with a cap of `cap`.
fn book_save<'a>(b: &Bank, cap: Option<&str>, user: &'a str, over: impl FnOnce(&mut SaveInput<'a>)) -> Result<store::Destination, Refusal> {
    let mut input = entry(user, ADDR_A, "Cold wallet");
    input.asset_id = "usdt";
    input.network = "ERC20";
    over(&mut input);
    b.store_save(cap, &input)
}

#[test]
fn saves_an_entry_with_its_asset_network_and_tag_and_lists_it_with_its_state() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let saved = book_save(&b, Some("3"), &u, |i| i.tag = Some("12345")).unwrap();
    // A new entry waits for the customer's approval (W-withdraw-09).
    assert_eq!(saved.asset_id.as_deref(), Some("USDT"));
    assert_eq!(saved.network.as_deref(), Some("erc20"));
    assert_eq!(saved.tag.as_deref(), Some("12345"));
    assert_eq!(
        (saved.origin.as_str(), saved.state.as_str(), saved.kind.as_str()),
        ("customer", "pending", "crypto")
    );
    assert_eq!((saved.approved_at, saved.approved_by), (None, None));
    assert_eq!(b.rows(&u).len(), 1);
    assert!(b.rows(&fresh()).is_empty());
}

#[test]
fn an_approval_makes_a_new_entry_cooling_from_that_moment_once() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let saved = book_save(&b, Some("3"), &u, |_| {}).unwrap();
    assert_eq!(saved.state, "pending");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let approved = store::approve(&mut b.client(), &u, &saved.destination_id, "link").unwrap();
    assert_eq!((approved.state.as_str(), approved.approved_by.as_deref()), ("cooling", Some("link")));
    assert!(approved.approved_at.is_some());
    // The cooling-off runs from the approval, not from the save.
    assert!(approved.updated_at.0 > saved.updated_at.0);
    // Approving again changes nothing.
    let again = store::approve(&mut b.client(), &u, &saved.destination_id, "link").unwrap();
    assert_eq!((again.state.as_str(), again.approved_by.as_deref()), ("cooling", Some("link")));
    assert_eq!(again.updated_at, approved.updated_at);
    // Someone else's entry, or none at all, is missing.
    assert_eq!(
        code_of(store::approve(&mut b.client(), &fresh(), &saved.destination_id, "link")),
        "bank.withdraw_destination_missing"
    );
}

#[test]
fn saves_the_same_asset_network_address_tag_once_whatever_the_address_case_without_moving_it() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let first = book_save(&b, Some("3"), &u, |_| {}).unwrap();
    let upper = format!("0x{}", ADDR_A[2..].to_uppercase());
    let again = book_save(&b, Some("3"), &u, |i| {
        i.r#ref = &upper;
        i.label = "Another name";
    })
    .unwrap();
    assert_eq!(again.destination_id, first.destination_id);
    assert_eq!(again.label.as_deref(), Some("Cold wallet"));
    assert_eq!(again.updated_at, first.updated_at);
    // A different memo, network or asset is a different entry.
    let other = book_save(&b, Some("3"), &u, |i| {
        i.tag = Some("99");
        i.label = "With memo";
    })
    .unwrap();
    assert_ne!(other.destination_id, first.destination_id);
    assert_eq!(b.rows(&u).len(), 2);
}

#[test]
fn refuses_a_label_another_saved_address_already_has_whatever_its_case_and_one_customer_cannot_block_another() {
    let Some(b) = bank() else { return };
    let u = fresh();
    book_save(&b, Some("3"), &u, |_| {}).unwrap();
    assert_eq!(
        code_of(book_save(&b, Some("3"), &u, |i| {
            i.r#ref = ADDR_B;
            i.label = "cold WALLET";
        })),
        "bank.destination_label_taken"
    );
    assert_eq!(b.rows(&u).len(), 1);
    book_save(&b, Some("3"), &fresh(), |i| {
        i.r#ref = ADDR_B;
        i.label = "cold wallet";
    })
    .unwrap();
}

#[test]
fn refuses_a_blank_cap_and_a_full_book_before_and_after_the_cap_is_set() {
    let Some(b) = bank() else { return };
    let u = fresh();
    for cap in [None, Some(" "), Some("0")] {
        assert_eq!(
            code_of(book_save(&b, cap, &u, |_| {})),
            "bank.address_book_cap_unset",
            "{cap:?}"
        );
    }
    book_save(&b, Some("2"), &u, |i| i.label = "One").unwrap();
    book_save(&b, Some("2"), &u, |i| {
        i.r#ref = ADDR_B;
        i.label = "Two";
    })
    .unwrap();
    assert_eq!(
        code_of(book_save(&b, Some("2"), &u, |i| {
            i.r#ref = ADDR_C;
            i.label = "Three";
        })),
        "bank.address_book_full"
    );
    // A repeat of a saved entry is not a new one, so it still answers when the book is full.
    book_save(&b, Some("2"), &u, |i| i.label = "One").unwrap();
}

#[test]
fn records_a_look_alike_confirmation_on_the_new_entry_only_and_refuses_one_that_names_no_entry_id() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let first = book_save(&b, Some("3"), &u, |_| {}).unwrap();
    assert_eq!((first.lookalike_of.clone(), first.lookalike_confirmed_at), (None, None));
    let confirmed = book_save(&b, Some("3"), &u, |i| {
        i.r#ref = ADDR_B;
        i.label = "Checked";
        i.lookalike_of = Some(first.destination_id.clone());
    })
    .unwrap();
    assert_eq!(confirmed.lookalike_of.as_deref(), Some(first.destination_id.as_str()));
    assert!(confirmed.lookalike_confirmed_at.is_some());
    let listed = b.rows(&u);
    let row = |id: &str| listed.iter().find(|r| r.destination_id == id).unwrap();
    assert_eq!(
        row(&confirmed.destination_id).lookalike_of.as_deref(),
        Some(first.destination_id.as_str())
    );
    assert_eq!(row(&first.destination_id).lookalike_confirmed_at, None);
    assert_eq!(
        code_of(book_save(&b, Some("3"), &u, |i| {
            i.r#ref = ADDR_C;
            i.label = "Bad";
            i.lookalike_of = Some("not-an-id".to_owned());
        })),
        "bank.ramp_invalid_destination"
    );
    assert_eq!(b.rows(&u).len(), 2);
}

#[test]
fn refuses_a_malformed_address_network_asset_tag_or_label_and_saves_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let bads: [(&str, fn(&mut SaveInput<'_>)); 7] = [
        ("ref not-an-address", |i| i.r#ref = "not-an-address"),
        ("ref IBAN", |i| i.r#ref = IBAN),
        ("network x", |i| i.network = "x"),
        ("network bad net!", |i| i.network = "bad net!"),
        ("asset blank", |i| i.asset_id = ""),
        ("tag padded", |i| i.tag = Some(" padded ")),
        ("label blank", |i| i.label = " "),
    ];
    for (name, bad) in bads {
        assert_eq!(
            code_of(book_save(&b, Some("3"), &u, bad)),
            "bank.ramp_invalid_destination",
            "{name}"
        );
    }
    assert!(b.rows(&u).is_empty());
}

#[test]
fn renames_without_restarting_the_cooling_clock_refuses_a_taken_label_and_another_customers_entry() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let one = book_save(&b, Some("3"), &u, |i| i.label = "One").unwrap();
    book_save(&b, Some("3"), &u, |i| {
        i.r#ref = ADDR_B;
        i.label = "Two";
    })
    .unwrap();
    let renamed = store::rename(&mut b.client(), &u, &one.destination_id, "Renamed").unwrap();
    assert_eq!(renamed.label.as_deref(), Some("Renamed"));
    assert_eq!(renamed.updated_at, one.updated_at);
    assert_eq!(
        code_of(store::rename(&mut b.client(), &u, &one.destination_id, "TWO")),
        "bank.destination_label_taken"
    );
    assert_eq!(
        code_of(store::rename(&mut b.client(), &fresh(), &one.destination_id, "Mine now")),
        "bank.withdraw_destination_missing"
    );
    let rows = b.rows(&u);
    let now = rows.iter().find(|d| d.destination_id == one.destination_id).unwrap();
    assert_eq!(now.label.as_deref(), Some("Renamed"));
}

#[test]
fn removes_once_per_idempotency_key_only_the_callers_own_entry_and_the_slot_is_free_again() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let one = book_save(&b, Some("3"), &u, |i| i.label = "One").unwrap();
    let st = b.db.store();
    assert_eq!(
        code_of(store::remove(&st, &fresh(), &one.destination_id, "rm-other-0001")),
        "bank.withdraw_destination_missing"
    );
    store::remove(&st, &u, &one.destination_id, "rm-key-0001").unwrap();
    assert_eq!(
        store::remove(&st, &u, &one.destination_id, "rm-key-0001").unwrap(),
        one.destination_id
    );
    assert_eq!(
        code_of(store::remove(&st, &u, &one.destination_id, "rm-key-0002")),
        "bank.withdraw_destination_missing"
    );
    book_save(&b, Some("3"), &u, |i| i.label = "One").unwrap();
}

#[test]
fn keeps_the_legacy_slot_working_one_per_kind_and_withdrawals_still_find_it() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let mut c = b.client();
    store::persist(&mut c, None, &u, "crypto", ADDR_A, None).unwrap();
    let second = store::persist(&mut c, None, &u, "crypto", ADDR_B, None).unwrap();
    assert_eq!(b.rows(&u).len(), 1);
    assert_eq!(store::require(&mut c, &u, "crypto").unwrap().r#ref, second.r#ref);
    store::persist(&mut c, None, &u, "bank", IBAN, None).unwrap();
    assert_eq!(store::require(&mut c, &u, "bank").unwrap().r#ref, IBAN);
    // A saved book entry never replaces the legacy slot.
    book_save(&b, Some("3"), &u, |i| {
        i.r#ref = ADDR_C;
        i.label = "Book";
    })
    .unwrap();
    assert_eq!(store::require(&mut c, &u, "crypto").unwrap().r#ref, ADDR_B);
}

#[test]
fn never_picks_a_saved_address_for_a_withdrawal_only_the_legacy_slot_answers_require() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let mut c = b.client();
    assert_eq!(code_of(store::require(&mut c, &u, "crypto")), "bank.withdraw_destination_missing");
    book_save(&b, Some("3"), &u, |i| {
        i.label = "Only";
        i.tag = Some("42");
    })
    .unwrap();
    assert_eq!(code_of(store::require(&mut c, &u, "crypto")), "bank.withdraw_destination_missing");
    book_save(&b, Some("3"), &u, |i| {
        i.r#ref = ADDR_B;
        i.label = "Second";
    })
    .unwrap();
    assert_eq!(code_of(store::require(&mut c, &u, "crypto")), "bank.withdraw_destination_missing");
}

#[test]
fn stops_a_legacy_label_from_taking_a_saved_addresss_name() {
    let Some(b) = bank() else { return };
    let u = fresh();
    book_save(&b, Some("3"), &u, |i| i.label = "Shared name").unwrap();
    assert_eq!(
        code_of(store::persist(&mut b.client(), None, &u, "bank", IBAN, Some("shared NAME"))),
        "bank.destination_label_taken"
    );
}

// address book: postgres only

#[test]
fn two_first_persists_racing_with_the_same_label_both_return_the_one_legacy_row() {
    let Some(b) = bank() else { return };
    for _round in 0..40 {
        let u = fresh();
        let results: Vec<Result<store::Destination, Refusal>> = std::thread::scope(|sc| {
            let racers: Vec<_> = (0..6)
                .map(|_| {
                    let mut c = b.client();
                    let u = u.clone();
                    sc.spawn(move || store::persist(&mut c, None, &u, "bank", IBAN, Some("Payroll")))
                })
                .collect();
            racers.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let failed: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
        assert!(failed.is_empty(), "{failed:?}");
        let ids: BTreeSet<String> = results
            .into_iter()
            .map(|r| r.unwrap().destination_id)
            .collect();
        assert_eq!(ids.len(), 1);
        let rows = b.rows(&u);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].origin.as_str(), rows[0].kind.as_str(), rows[0].r#ref.as_str(), rows[0].label.as_deref()),
            ("legacy", "bank", IBAN, Some("Payroll"))
        );
    }
}

#[test]
fn a_persist_whose_label_another_entry_holds_is_still_refused_under_the_address_book_lock() {
    let Some(b) = bank() else { return };
    let u = fresh();
    b.store_save(Some("5"), &entry(&u, ADDR_A, "Taken")).unwrap();
    assert_eq!(
        code_of(store::persist(&mut b.client(), None, &u, "bank", IBAN, Some("taken"))),
        "bank.destination_label_taken"
    );
    let origins: Vec<String> = b.rows(&u).into_iter().map(|r| r.origin).collect();
    assert_eq!(origins, vec!["customer".to_owned()]);
}

#[test]
fn lets_two_racing_saves_pass_the_cap_only_once() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let results: Vec<Result<store::Destination, Refusal>> = std::thread::scope(|sc| {
        let racers: Vec<_> = [(ADDR_A, "A"), (ADDR_B, "B"), (ADDR_C, "C")]
            .into_iter()
            .map(|(r, label)| {
                let st = b.db.store();
                let u = u.clone();
                sc.spawn(move || store::save(&st, Some("1"), &entry(&u, r, label)))
            })
            .collect();
        racers.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    let codes: Vec<String> = results
        .into_iter()
        .filter(Result::is_err)
        .map(code_of)
        .collect();
    assert_eq!(codes, vec!["bank.address_book_full", "bank.address_book_full"]);
    assert_eq!(b.rows(&u).len(), 1);
}

#[test]
fn the_down_migration_refuses_while_a_saved_entry_exists_and_restores_one_slot_per_kind_once_it_is_gone() {
    let Some(b) = bank() else { return };
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let down = std::fs::read_to_string(dir.join("0043_withdraw_address_book.down.sql")).unwrap();
    let up = std::fs::read_to_string(dir.join("0043_withdraw_address_book.sql")).unwrap();
    let in_tx = |sql: &str| -> Result<(), String> {
        let mut c = b.client();
        let mut tx = c.transaction().map_err(|e| e.to_string())?;
        tx.batch_execute(sql).map_err(|e| {
            e.as_db_error()
                .map_or_else(|| e.to_string(), |d| d.message().to_owned())
        })?;
        tx.commit().map_err(|e| e.to_string())
    };
    let u = fresh();
    b.store_save(Some("5"), &entry(&u, ADDR_A, "Down test")).unwrap();
    let refused = in_tx(&down).unwrap_err();
    assert!(refused.contains("saved entries"), "{refused}");
    b.client()
        .batch_execute("DELETE FROM bank.user_withdraw_destinations WHERE origin <> 'legacy'")
        .unwrap();
    store::persist(&mut b.client(), None, &u, "crypto", ADDR_B, None).unwrap();
    in_tx(&down).unwrap();
    let rows: Vec<(String, String)> = b
        .client()
        .query(
            "SELECT kind::text, ref FROM bank.user_withdraw_destinations WHERE user_id = $1",
            &[&u],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(rows, vec![("crypto".to_owned(), ADDR_B.to_owned())]);
    // Two old rows of one customer with the same label: the up migration keeps both, renaming the later one.
    let twin = fresh();
    b.client()
        .execute(
            "INSERT INTO bank.user_withdraw_destinations (user_id, kind, ref, label) VALUES ($1, 'crypto', $2, 'Same'), ($1, 'bank', $3, 'same')",
            &[&twin, &ADDR_A, &IBAN],
        )
        .unwrap();
    // Back up again, and the legacy row is still the legacy slot.
    in_tx(&up).unwrap();
    let labels: Vec<(String, String)> = b
        .client()
        .query(
            "SELECT kind::text, label FROM bank.user_withdraw_destinations WHERE user_id = $1 ORDER BY kind",
            &[&twin],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(
        labels,
        vec![
            ("bank".to_owned(), "same".to_owned()),
            ("crypto".to_owned(), "Same (2)".to_owned())
        ]
    );
    assert_eq!(store::require(&mut b.client(), &u, "crypto").unwrap().origin, "legacy");
}

#[test]
fn shows_the_start_and_end_of_an_address_and_hides_the_middle() {
    assert_eq!(customer::mask_ref(ADDR_A), "0x1111…1111");
    assert_eq!(customer::mask_ref(IBAN), "DE8937…3000");
    assert_eq!(customer::mask_ref("short"), "sh…");
}

// ---------------------------------------------------------------------------------------------------------------
// withdraw-destination.test.ts: the shape checks

const EVM: &str = "0x000000000000000000000000000000000000dEaD";

#[test]
fn accepts_evm_on_crypto_and_iban_ifsc_on_bank() {
    assert_eq!(store::assert_persistable("crypto", EVM).unwrap(), ("crypto", EVM.to_owned()));
    assert_eq!(store::assert_persistable("bank", "GB82WEST12345698765432").unwrap().1, "GB82WEST12345698765432");
    assert_eq!(store::assert_persistable("bank", "SBIN0005943").unwrap().1, "SBIN0005943");
}

#[test]
fn refuses_empty_gibberish_before_any_hold() {
    assert_eq!(code_of(store::assert_persistable("crypto", "0xdead")), "bank.ramp_invalid_destination");
    assert_eq!(code_of(store::assert_persistable("bank", "IBAN-TEST")), "bank.ramp_invalid_destination");
}

const EIP55: [&str; 4] = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

#[test]
fn accepts_the_specification_examples_and_an_address_in_one_case_only_which_carries_no_checksum() {
    for a in EIP55 {
        assert!(store::evm_checksum_matches(a), "{a}");
    }
    assert!(store::evm_checksum_matches(&EIP55[0].to_lowercase()));
    assert!(store::evm_checksum_matches(&format!("0x{}", EIP55[0][2..].to_uppercase())));
}

#[test]
fn refuses_one_flipped_letter_and_assert_persistable_withdraw_destination_says_so_with_its_own_code() {
    let flipped = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    assert!(!store::evm_checksum_matches(flipped));
    assert_eq!(code_of(store::assert_persistable("crypto", flipped)), "bank.address_checksum_mismatch");
    // The legacy one-per-kind slot the offramp writes goes through the same check.
    let Some(b) = bank() else { return };
    assert_eq!(
        code_of(store::persist(&mut b.client(), None, &fresh(), "crypto", flipped, None)),
        "bank.address_checksum_mismatch"
    );
}

fn row_at(r: &str, label: &str) -> store::Destination {
    store::Destination {
        destination_id: uuid(),
        user_id: "u".to_owned(),
        kind: "crypto".to_owned(),
        r#ref: r.to_owned(),
        label: Some(label.to_owned()),
        asset_id: None,
        network: None,
        tag: None,
        origin: "customer".to_owned(),
        state: "pending".to_owned(),
        added_at: Instant(0),
        updated_at: Instant(0),
        lookalike_of: None,
        lookalike_confirmed_at: None,
        approved_at: None,
        approved_by: None,
    }
}

#[test]
fn finds_a_saved_address_with_the_same_start_and_end_as_the_book_shows_them_and_a_different_middle() {
    let saved = [row_at(EIP55[0], "Cold")];
    let near = format!("0x5aae{}eaed", "1".repeat(32));
    assert_eq!(store::lookalike_of(&near, &saved).map(|d| d.label.clone()), Some(Some("Cold".to_owned())));
}

#[test]
fn ignores_the_same_address_in_any_case_a_different_start_or_end_and_anything_that_is_not_an_address() {
    let saved = [row_at(EIP55[0], "Cold")];
    let ones = "1".repeat(32);
    assert!(store::lookalike_of(&EIP55[0].to_lowercase(), &saved).is_none());
    assert!(store::lookalike_of(&format!("0x5aaf{ones}eaed"), &saved).is_none());
    assert!(store::lookalike_of(&format!("0x5aae{ones}eaee"), &saved).is_none());
    assert!(store::lookalike_of("0x5aaeeaed", &saved).is_none());
    assert!(store::lookalike_of(&format!("0x5aae{ones}eaed"), &[row_at("GB82WEST12345698765432", "Bank")]).is_none());
}

#[test]
fn never_calls_an_address_already_in_the_book_a_look_alike_even_when_another_saved_entry_shows_like_it() {
    let near = format!("0x5aae{}eaed", "1".repeat(32));
    let near_upper = format!("0x{}", near[2..].to_uppercase());
    let saved = [row_at(EIP55[0], "Cold"), row_at(&near_upper, "Confirmed before")];
    assert!(store::lookalike_of(&near, &saved).is_none());
}

#[test]
fn require_refuses_when_nothing_was_stored_and_persist_then_require_returns_the_stored_evm_dest() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let mut c = b.client();
    assert_eq!(code_of(store::require(&mut c, &u, "crypto")), "bank.withdraw_destination_missing");
    store::persist(&mut c, None, &u, "crypto", EVM, None).unwrap();
    let got = store::require(&mut c, &u, "crypto").unwrap();
    assert_eq!((got.kind.as_str(), got.r#ref.as_str()), ("crypto", EVM));
}

#[test]
fn same_ref_persist_still_bumps_updated_at() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let mut c = b.client();
    let first = store::persist(&mut c, None, &u, "crypto", EVM, None).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let second = store::persist(&mut c, None, &u, "crypto", EVM, None).unwrap();
    assert_eq!(second.r#ref, EVM);
    assert!(second.updated_at.0 > first.updated_at.0);
    assert_eq!(store::require(&mut c, &u, "crypto").unwrap().updated_at, second.updated_at);
}
