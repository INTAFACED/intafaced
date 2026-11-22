//! Slice `ramps`, the address book, against the Rust door on a real Postgres. Ports the checks of the TypeScript's
//! suites that fall on `ramps.destinations.*`, `ops.destinationFraudList` and `ops.setDestinationFraudListing`, each
//! test named after the TypeScript test's words:
//!
//! - `ramps/address-approval.db.test.ts`: every test.
//! - `address-book.db.test.ts`: every test, on the store.
//! - `ramps/address-book.router.test.ts`: every test, through the door.
//! - `ramps/send-destination.test.ts`: every test, the question asked through the door as svc-pay asks it.
//! - `ramps/wallet-ownership.test.ts`, `ramps/wallet-ownership.db.test.ts`: every test, the flows through the door.
//! - `ramps/fraud-list.db.test.ts`, `ramps/fraud-list.test.ts`: every test on the book and the desk's calls.
//! - `ramps/sanctions-list.test.ts`: `saving a withdrawal address against the sanctions list`.
//! - `security-lock.money.test.ts`: `the address book while the security lock holds` and `whether a saved address can
//!   be used now`.
//! - `ramps/customer-ramps-deposits.test.ts`: `lists saved destinations with label and cooling end, and remove replays
//!   by idempotency key`.
//! - `withdraw-destination.test.ts`: the shape checks, the checksum, the look-alike and the legacy slot.
//!
//! Not ported, with the reason:
//! - The memory stores' runs of each `describe.each` (`memoryWithdrawDestinations`, `memoryApprovalLinks`,
//!   `memoryWalletProofs`, `memoryFraudList`) and the memory store's own tests: the TypeScript's test doubles; the Rust
//!   has only the Postgres store, which every test here runs on. Where a TypeScript test injected a clock into the memory
//!   store (an approval 25 hours ago), the test sets the row's approval time back by SQL.
//! - The store primitives `insert`, `markVerified` and `get` of `wallet-ownership.db.test.ts` are private in the Rust;
//!   their checks are made through `start` and `verify` (a second mark is a conflict, another customer's or a non-uuid
//!   proof id is not found).
//! - What falls on the off-ramp, the slice's other half: `setWithdrawDestination` and `ramps.offramp` in
//!   `fraud-list.db.test.ts` (a listed send, a reused send id, the legacy door), in `security-lock.money.test.ts` (its
//!   legacy-door lines and `a crypto withdrawal while the security lock holds`), `destKindForRamp`, and
//!   `assertOnlyWithdrawDestinations`. The legacy slot those write is `store::persist`, held here.
//! - `sanctions-list.test.ts`' reading half and `the identity security lock port`: `ramps::sanctions`' and transfers'
//!   own tests hold them.
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

/// Identity's answer per device, and a failure every read meets.
type DeviceBook = (BTreeMap<String, DeviceState>, Option<Refusal>);

/// `memoryTrustedDevices`: identity's answer per device, an unknown one neither live nor trusted.
#[derive(Clone, Default)]
struct Devices(Arc<Mutex<DeviceBook>>);

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

/// The security lock, as `memorySecurityLock`; `unwired` is a deployment that cannot read it.
#[derive(Clone)]
struct Lock(Arc<MemoryIdentity>, bool);

impl Default for Lock {
    fn default() -> Lock {
        Lock(Arc::default(), true)
    }
}

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
    fn unwired() -> Lock {
        Lock(Arc::default(), false)
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
        self.0.lock().unwrap().issued.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, fields)),
        );
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
    // A lock the test cannot see is the deployment's own: one that cannot be read.
    if lock.1 {
        transfers.lock = Box::new(lock.clone());
    }
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
    /// The same database and stand-ins with another security lock.
    fn with_lock(&self, lock: &Lock) -> BankDoor {
        door_for(
            &self.db,
            &self.registry,
            &self.mail,
            &self.devices,
            lock,
            &self.desk,
            owner(),
        )
    }
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
    fn store_save(
        &self,
        cap: Option<&str>,
        input: &SaveInput<'_>,
    ) -> Result<store::Destination, Refusal> {
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
fn person_on(
    user: &str,
    scopes: &[&str],
    fam: Option<&str>,
    dev: Option<&str>,
) -> Vec<(String, String)> {
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
        (
            "expiresAt".to_owned(),
            Json::str("2099-01-01T00:00:00.000Z"),
        ),
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
fn call_as(door: &BankDoor, headers: Vec<(String, String)>, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    send(
        door,
        path,
        (body != "null").then_some(body.as_str()),
        headers,
    )
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

fn on_device(
    door: &BankDoor,
    user: &str,
    id: &str,
    fam: Option<&str>,
    dev: Option<&str>,
) -> Answer {
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
fn mails_a_single_use_link_under_a_numbered_business_key_with_what_the_address_is_and_until_when_the_link_works()
 {
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
    assert!(
        sent[0]
            .body()
            .contains("\"purpose\":\"withdraw-address-approval\"")
    );
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
fn refuses_a_link_with_no_owner_lifetime_while_locked_and_for_an_entry_approved_already_mailing_nothing()
 {
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
    assert_eq!(
        approval::require_link_minutes(Some("10080")).unwrap(),
        10080
    );

    let v = fresh();
    let other = saved(&b, &v);
    b.lock.set(&v, true);
    assert_eq!(
        request_mail(&b.door, &v, &other).code(),
        "bank.security_locked"
    );
    b.lock.set(&v, false);
    store::approve(&mut b.client(), &v, &other, "link").unwrap();
    assert_eq!(
        request_mail(&b.door, &v, &other).code(),
        "bank.address_approval_not_pending"
    );
    assert!(b.mail.sent().is_empty());
}

#[test]
fn approves_by_the_newest_link_for_the_customer_it_was_sent_to_the_cooling_off_starts_then_and_opening_it_again_changes_nothing()
 {
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
fn a_link_whose_mail_identity_refused_was_never_sent_so_it_never_works_and_the_one_before_it_still_does()
 {
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
fn refuses_to_approve_by_link_while_the_security_lock_holds_and_the_link_still_works_once_it_ends()
{
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
fn an_older_or_expired_link_for_an_address_approved_already_answers_it_as_approved_and_changes_nothing()
 {
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
fn a_link_the_bank_failed_to_record_as_mailed_still_works_its_token_only_exists_in_the_mail_identity_took()
 {
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
fn approves_from_another_trusted_device_the_cooling_off_starts_then_by_device_and_again_changes_nothing()
 {
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
fn refuses_the_device_that_saved_it_even_after_a_refresh_or_a_new_sign_in_there_and_changes_nothing()
 {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(
        &saved_from(&b, &u, Some(SIGN_IN_A), Some(DEVICE_A)),
        "destinationId",
    );
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
    assert_eq!(
        (text(&ok, "state"), text(&ok, "approvedBy")),
        ("cooling".to_owned(), "device".to_owned())
    );
}

#[test]
fn refuses_when_either_side_names_no_sign_in_unknown_is_never_a_different_device_and_the_emailed_link_still_works()
 {
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
    assert_eq!(
        (text(&ok, "state"), text(&ok, "approvedBy")),
        ("cooling".to_owned(), "link".to_owned())
    );
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
    assert_eq!(
        store::saved_on(&mut b.client(), &stranger, &id).unwrap(),
        None
    );
    store::remove(&b.db.store(), &u, &id, &format!("remove:{id}")).unwrap();
    assert_eq!(
        on_device(&b.door, &u, &id, Some(SIGN_IN_B), None).code(),
        "bank.withdraw_destination_missing"
    );
}

#[test]
fn asks_identity_about_the_approving_device_removed_trusted_only_by_signing_in_or_with_the_check_off_it_refuses()
 {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(
        &saved_from(&b, &u, Some(SIGN_IN_A), Some(DEVICE_A)),
        "destinationId",
    );
    let approve = || on_device(&b.door, &u, &id, Some(SIGN_IN_B), Some(DEVICE_B));
    for state in [
        device(false, Some("approval"), "on"),
        device(true, Some("sign-in"), "on"),
        device(true, Some("approval"), "off"),
        device(false, None, "on"),
    ] {
        b.devices.set(DEVICE_B, state.clone());
        assert_eq!(
            approve().code(),
            "bank.address_approval_device_untrusted",
            "{state:?}"
        );
    }
    b.devices.fail_with(Some(refuse(
        "bank.address_approval_device_unavailable",
        "identity down",
    )));
    assert_eq!(approve().code(), "bank.address_approval_device_unavailable");
    let still = &b.rows(&u)[0];
    assert_eq!(
        (still.state.as_str(), still.approved_by.clone()),
        ("pending", None)
    );
    // The device the account was made on is proved too.
    b.devices.fail_with(None);
    b.devices.set(DEVICE_B, device(true, Some("sign-up"), "on"));
    let ok = approve().ok();
    assert_eq!(
        (text(&ok, "state"), text(&ok, "approvedBy")),
        ("cooling".to_owned(), "device".to_owned())
    );
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
        on_device(&b.door, &u, &id, Some(SIGN_IN_A), None)
            .ok()
            .compact(),
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
        (
            "both devices named and different",
            on(Some(f1), Some(d1)),
            on(Some(f1), Some(d2)),
            "different",
        ),
        (
            "both devices named and the same, new sign-in",
            on(Some(f1), Some(d1)),
            on(Some(f2), Some(d1)),
            "same",
        ),
        (
            "one device missing, different sign-ins: a second sign-in is not a second device",
            on(Some(f1), Some(d1)),
            on(Some(f2), None),
            "unknown",
        ),
        (
            "one device missing, the same sign-in",
            on(Some(f1), None),
            on(Some(f1), Some(d2)),
            "same",
        ),
        (
            "no sign-in on the saving side",
            on(None, Some(d1)),
            on(Some(f2), None),
            "unknown",
        ),
        (
            "no sign-in on the approving side",
            on(Some(f1), None),
            on(None, None),
            "unknown",
        ),
        (
            "nothing named on either side",
            on(None, None),
            on(None, None),
            "unknown",
        ),
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
        assert_eq!(
            approval::device_comparison(&saved, &approving),
            expected,
            "{name}"
        );
    }
}

// postgres: the approval links table

#[test]
fn keeps_only_the_sha256_of_a_token_never_the_token() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = text(
        &save_on(&b.door, &u, ADDRESS, "Hash test", None, None).ok(),
        "destinationId",
    );
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
    (
        IdentityHttp::new(base, signer, Box::new(fetch.clone())),
        fetch,
    )
}

#[test]
fn posts_the_request_signed_as_svc_bank_and_returns_the_mail_id() {
    let (port, fetch) = identity_mail(
        "http://identity.test/",
        Some((
            200,
            &format!("{{\"accepted\":true,\"mailId\":\"{MAIL_ID}\"}}"),
        )),
    );
    assert_eq!(port.send(&mail_request()).unwrap(), MAIL_ID);
    let calls = fetch.0.lock().unwrap();
    assert_eq!(calls[0].url, "http://identity.test/internal/mail");
    assert_eq!(calls[0].method, "POST");
    let sent = json::parse(calls[0].body.as_deref().unwrap()).unwrap();
    assert_eq!(
        sent.compact(),
        Json::obj([
            (
                "key",
                s("address-approval:66666666-6666-4666-8666-666666666666:1")
            ),
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
        (
            "no mail service",
            503,
            r#"{"code":"identity.mail_unwired"}"#,
            "bank.address_approval_mail_unavailable",
        ),
        (
            "no proved email",
            409,
            r#"{"code":"identity.email_unproved"}"#,
            "bank.address_approval_email_unproved",
        ),
        (
            "an inactive account",
            409,
            r#"{"code":"identity.account_not_active"}"#,
            "bank.address_approval_email_unproved",
        ),
        (
            "a key conflict",
            409,
            r#"{"code":"identity.mail_key_conflict"}"#,
            "bank.address_approval_mail_unavailable",
        ),
        (
            "a server error",
            500,
            "oops",
            "bank.address_approval_mail_unavailable",
        ),
        (
            "an answer with no mail id",
            200,
            r#"{"accepted":true}"#,
            "bank.address_approval_mail_unavailable",
        ),
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
fn book_save<'a>(
    b: &Bank,
    cap: Option<&str>,
    user: &'a str,
    over: impl FnOnce(&mut SaveInput<'a>),
) -> Result<store::Destination, Refusal> {
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
        (
            saved.origin.as_str(),
            saved.state.as_str(),
            saved.kind.as_str()
        ),
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
    assert_eq!(
        (approved.state.as_str(), approved.approved_by.as_deref()),
        ("cooling", Some("link"))
    );
    assert!(approved.approved_at.is_some());
    // The cooling-off runs from the approval, not from the save.
    assert!(approved.updated_at.0 > saved.updated_at.0);
    // Approving again changes nothing.
    let again = store::approve(&mut b.client(), &u, &saved.destination_id, "link").unwrap();
    assert_eq!(
        (again.state.as_str(), again.approved_by.as_deref()),
        ("cooling", Some("link"))
    );
    assert_eq!(again.updated_at, approved.updated_at);
    // Someone else's entry, or none at all, is missing.
    assert_eq!(
        code_of(store::approve(
            &mut b.client(),
            &fresh(),
            &saved.destination_id,
            "link"
        )),
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
fn refuses_a_label_another_saved_address_already_has_whatever_its_case_and_one_customer_cannot_block_another()
 {
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
fn records_a_look_alike_confirmation_on_the_new_entry_only_and_refuses_one_that_names_no_entry_id()
{
    let Some(b) = bank() else { return };
    let u = fresh();
    let first = book_save(&b, Some("3"), &u, |_| {}).unwrap();
    assert_eq!(
        (first.lookalike_of.clone(), first.lookalike_confirmed_at),
        (None, None)
    );
    let confirmed = book_save(&b, Some("3"), &u, |i| {
        i.r#ref = ADDR_B;
        i.label = "Checked";
        i.lookalike_of = Some(first.destination_id.clone());
    })
    .unwrap();
    assert_eq!(
        confirmed.lookalike_of.as_deref(),
        Some(first.destination_id.as_str())
    );
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
    type Bad = fn(&mut SaveInput<'_>);
    let bads: [(&str, Bad); 7] = [
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
fn renames_without_restarting_the_cooling_clock_refuses_a_taken_label_and_another_customers_entry()
{
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
        code_of(store::rename(
            &mut b.client(),
            &u,
            &one.destination_id,
            "TWO"
        )),
        "bank.destination_label_taken"
    );
    assert_eq!(
        code_of(store::rename(
            &mut b.client(),
            &fresh(),
            &one.destination_id,
            "Mine now"
        )),
        "bank.withdraw_destination_missing"
    );
    let rows = b.rows(&u);
    let now = rows
        .iter()
        .find(|d| d.destination_id == one.destination_id)
        .unwrap();
    assert_eq!(now.label.as_deref(), Some("Renamed"));
}

#[test]
fn removes_once_per_idempotency_key_only_the_callers_own_entry_and_the_slot_is_free_again() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let one = book_save(&b, Some("3"), &u, |i| i.label = "One").unwrap();
    let st = b.db.store();
    assert_eq!(
        code_of(store::remove(
            &st,
            &fresh(),
            &one.destination_id,
            "rm-other-0001"
        )),
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
    assert_eq!(
        store::require(&mut c, &u, "crypto").unwrap().r#ref,
        second.r#ref
    );
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
    assert_eq!(
        code_of(store::require(&mut c, &u, "crypto")),
        "bank.withdraw_destination_missing"
    );
    book_save(&b, Some("3"), &u, |i| {
        i.label = "Only";
        i.tag = Some("42");
    })
    .unwrap();
    assert_eq!(
        code_of(store::require(&mut c, &u, "crypto")),
        "bank.withdraw_destination_missing"
    );
    book_save(&b, Some("3"), &u, |i| {
        i.r#ref = ADDR_B;
        i.label = "Second";
    })
    .unwrap();
    assert_eq!(
        code_of(store::require(&mut c, &u, "crypto")),
        "bank.withdraw_destination_missing"
    );
}

#[test]
fn stops_a_legacy_label_from_taking_a_saved_addresss_name() {
    let Some(b) = bank() else { return };
    let u = fresh();
    book_save(&b, Some("3"), &u, |i| i.label = "Shared name").unwrap();
    assert_eq!(
        code_of(store::persist(
            &mut b.client(),
            None,
            &u,
            "bank",
            IBAN,
            Some("shared NAME")
        )),
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
                    sc.spawn(move || {
                        store::persist(&mut c, None, &u, "bank", IBAN, Some("Payroll"))
                    })
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
            (
                rows[0].origin.as_str(),
                rows[0].kind.as_str(),
                rows[0].r#ref.as_str(),
                rows[0].label.as_deref()
            ),
            ("legacy", "bank", IBAN, Some("Payroll"))
        );
    }
}

#[test]
fn a_persist_whose_label_another_entry_holds_is_still_refused_under_the_address_book_lock() {
    let Some(b) = bank() else { return };
    let u = fresh();
    b.store_save(Some("5"), &entry(&u, ADDR_A, "Taken"))
        .unwrap();
    assert_eq!(
        code_of(store::persist(
            &mut b.client(),
            None,
            &u,
            "bank",
            IBAN,
            Some("taken")
        )),
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
    assert_eq!(
        codes,
        vec!["bank.address_book_full", "bank.address_book_full"]
    );
    assert_eq!(b.rows(&u).len(), 1);
}

#[test]
fn the_down_migration_refuses_while_a_saved_entry_exists_and_restores_one_slot_per_kind_once_it_is_gone()
 {
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
    b.store_save(Some("5"), &entry(&u, ADDR_A, "Down test"))
        .unwrap();
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
    assert_eq!(
        store::require(&mut b.client(), &u, "crypto")
            .unwrap()
            .origin,
        "legacy"
    );
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
    assert_eq!(
        store::assert_persistable("crypto", EVM).unwrap(),
        ("crypto", EVM.to_owned())
    );
    assert_eq!(
        store::assert_persistable("bank", "GB82WEST12345698765432")
            .unwrap()
            .1,
        "GB82WEST12345698765432"
    );
    assert_eq!(
        store::assert_persistable("bank", "SBIN0005943").unwrap().1,
        "SBIN0005943"
    );
}

#[test]
fn refuses_empty_gibberish_before_any_hold() {
    assert_eq!(
        code_of(store::assert_persistable("crypto", "0xdead")),
        "bank.ramp_invalid_destination"
    );
    assert_eq!(
        code_of(store::assert_persistable("bank", "IBAN-TEST")),
        "bank.ramp_invalid_destination"
    );
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
    assert!(store::evm_checksum_matches(&format!(
        "0x{}",
        EIP55[0][2..].to_uppercase()
    )));
}

#[test]
fn refuses_one_flipped_letter_and_assert_persistable_withdraw_destination_says_so_with_its_own_code()
 {
    let flipped = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    assert!(!store::evm_checksum_matches(flipped));
    assert_eq!(
        code_of(store::assert_persistable("crypto", flipped)),
        "bank.address_checksum_mismatch"
    );
    // The legacy one-per-kind slot the offramp writes goes through the same check.
    let Some(b) = bank() else { return };
    assert_eq!(
        code_of(store::persist(
            &mut b.client(),
            None,
            &fresh(),
            "crypto",
            flipped,
            None
        )),
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
fn finds_a_saved_address_with_the_same_start_and_end_as_the_book_shows_them_and_a_different_middle()
{
    let saved = [row_at(EIP55[0], "Cold")];
    let near = format!("0x5aae{}eaed", "1".repeat(32));
    assert_eq!(
        store::lookalike_of(&near, &saved).map(|d| d.label.clone()),
        Some(Some("Cold".to_owned()))
    );
}

#[test]
fn ignores_the_same_address_in_any_case_a_different_start_or_end_and_anything_that_is_not_an_address()
 {
    let saved = [row_at(EIP55[0], "Cold")];
    let ones = "1".repeat(32);
    assert!(store::lookalike_of(&EIP55[0].to_lowercase(), &saved).is_none());
    assert!(store::lookalike_of(&format!("0x5aaf{ones}eaed"), &saved).is_none());
    assert!(store::lookalike_of(&format!("0x5aae{ones}eaee"), &saved).is_none());
    assert!(store::lookalike_of("0x5aaeeaed", &saved).is_none());
    assert!(
        store::lookalike_of(
            &format!("0x5aae{ones}eaed"),
            &[row_at("GB82WEST12345698765432", "Bank")]
        )
        .is_none()
    );
}

#[test]
fn never_calls_an_address_already_in_the_book_a_look_alike_even_when_another_saved_entry_shows_like_it()
 {
    let near = format!("0x5aae{}eaed", "1".repeat(32));
    let near_upper = format!("0x{}", near[2..].to_uppercase());
    let saved = [
        row_at(EIP55[0], "Cold"),
        row_at(&near_upper, "Confirmed before"),
    ];
    assert!(store::lookalike_of(&near, &saved).is_none());
}

#[test]
fn require_refuses_when_nothing_was_stored_and_persist_then_require_returns_the_stored_evm_dest() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let mut c = b.client();
    assert_eq!(
        code_of(store::require(&mut c, &u, "crypto")),
        "bank.withdraw_destination_missing"
    );
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
    assert_eq!(
        store::require(&mut c, &u, "crypto").unwrap().updated_at,
        second.updated_at
    );
}

// ---------------------------------------------------------------------------------------------------------------
// ramps/address-book.router.test.ts: through the door (W-withdraw-08)

const BOOK_ADDRESS: &str = "0xabCDeF0123456789AbcdEf0123456789aBCDEF01";

/// The router suite's owner values: a book of two, no link lifetime.
fn router_owner() -> Settings {
    Settings {
        address_book_cap: Some("2".to_owned()),
        address_approval_link_minutes: None,
        ..owner()
    }
}

fn book_entry(r: &str, label: &str) -> Vec<(&'static str, Json)> {
    vec![
        ("assetId", s("USDT")),
        ("network", s("erc20")),
        ("ref", s(r)),
        ("label", s(label)),
    ]
}

fn with(mut fields: Vec<(&'static str, Json)>, more: &[(&'static str, Json)]) -> Json {
    for (k, v) in more {
        if let Some(slot) = fields.iter_mut().find(|(f, _)| f == k) {
            slot.1 = v.clone();
        } else {
            fields.push((k, v.clone()));
        }
    }
    obj(&fields)
}

fn save_as(door: &BankDoor, user: &str, scopes: &[&str], input: &Json) -> Answer {
    call_as(door, person(user, scopes), "ramps.destinations.save", input)
}

fn list_as(door: &BankDoor, user: &str, scopes: &[&str]) -> Vec<Json> {
    list_of(
        &call_as(
            door,
            person(user, scopes),
            "ramps.destinations.list",
            &Json::Null,
        )
        .ok(),
    )
}

#[test]
fn refuses_a_plain_session_on_save_and_remove_and_saves_nothing() {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let plain = ["bank:read", "bank:write"];
    assert_eq!(
        save_as(
            &b.door,
            &u,
            &plain,
            &obj(&book_entry(BOOK_ADDRESS, "Cold wallet"))
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call_as(
            &b.door,
            person(&u, &plain),
            "ramps.destinations.remove",
            &obj(&[
                ("destinationId", s("33333333-3333-4333-8333-333333333333")),
                ("idempotencyKey", s("rm-1")),
            ])
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert!(list_as(&b.door, &u, &plain).is_empty());
}

#[test]
fn saves_with_the_step_up_scope_lists_the_row_masked_with_its_network_and_state_and_renames_with_bank_write()
 {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let saved = save_as(
        &b.door,
        &u,
        STEPPED,
        &with(
            book_entry(BOOK_ADDRESS, "Cold wallet"),
            &[("tag", s("777"))],
        ),
    )
    .ok();
    for (k, v) in [
        ("assetId", "USDT"),
        ("network", "erc20"),
        ("tag", "777"),
        ("origin", "customer"),
        ("state", "pending"),
        ("refMasked", "0xabCD…EF01"),
    ] {
        assert_eq!(text(&saved, k), v, "{k}");
    }
    let listed = list_as(&b.door, &u, &["bank:read"]);
    assert_eq!(listed.len(), 1);
    assert_eq!(
        text(&listed[0], "destinationId"),
        text(&saved, "destinationId")
    );
    assert_eq!(
        text(&listed[0], "coolingBlocker"),
        "bank.offramp_cooling_unset"
    );
    let renamed = call_as(
        &b.door,
        person(&u, &["bank:read", "bank:write"]),
        "ramps.destinations.rename",
        &obj(&[
            ("destinationId", s(&text(&saved, "destinationId"))),
            ("label", s("Vault")),
        ]),
    )
    .ok();
    assert_eq!(text(&renamed, "label"), "Vault");
}

#[test]
fn saves_a_new_address_waiting_for_approval_approving_by_link_needs_the_step_up_scope_asking_for_a_link_does_not()
 {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let saved = save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(BOOK_ADDRESS, "Approve me")),
    )
    .ok();
    for k in ["coolingOffEndsAt", "approvedAt", "approvalLinkExpiresAt"] {
        assert_eq!(text(&saved, k), "null", "{k}");
    }
    assert_eq!(text(&saved, "state"), "pending");
    let plain = person(&u, &["bank:read", "bank:write"]);
    assert_eq!(
        call_as(
            &b.door,
            plain.clone(),
            "ramps.destinations.approval.confirmLink",
            &obj(&[("token", Json::str("A".repeat(43)))])
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        call_as(
            &b.door,
            plain,
            "ramps.destinations.approval.requestMail",
            &obj(&[("destinationId", s(&text(&saved, "destinationId")))])
        )
        .code(),
        "bank.address_approval_link_unset"
    );
}

#[test]
fn approves_from_another_trusted_device_read_from_the_access_token_the_saving_one_is_refused_and_a_plain_session_may_not()
 {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let a = (SIGN_IN_A, DEVICE_A);
    let bb = (SIGN_IN_B, PROVED_DEVICE);
    let saved = call_as(
        &b.door,
        person_on(&u, STEPPED, Some(a.0), Some(a.1)),
        "ramps.destinations.save",
        &obj(&book_entry(BOOK_ADDRESS, "From A")),
    )
    .ok();
    let id = text(&saved, "destinationId");
    assert_eq!(
        store::saved_on(&mut b.client(), &u, &id).unwrap(),
        Some(SavedOn {
            fam: Some(a.0.to_owned()),
            dev: Some(a.1.to_owned())
        })
    );
    let same = on_device(&b.door, &u, &id, Some(a.0), Some(a.1));
    assert_eq!(
        (same.trpc(), same.code()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.address_approval_same_device".to_owned()
        )
    );
    // A token that names no sign-in cannot be told apart, so it refuses rather than approving.
    assert_eq!(
        on_device(&b.door, &u, &id, None, None).code(),
        "bank.address_approval_device_unknown"
    );
    assert_eq!(
        call_as(
            &b.door,
            person_on(&u, &["bank:read", "bank:write"], Some(bb.0), Some(bb.1)),
            "ramps.destinations.approval.onDevice",
            &obj(&[("destinationId", s(&id))])
        )
        .trpc(),
        "FORBIDDEN"
    );
    // The device is never taken from the request.
    assert_eq!(
        call_as(
            &b.door,
            person_on(&u, STEPPED, Some(a.0), Some(a.1)),
            "ramps.destinations.approval.onDevice",
            &obj(&[("destinationId", s(&id)), ("fam", s(bb.0))])
        )
        .trpc(),
        "BAD_REQUEST"
    );
    let approved = on_device(&b.door, &u, &id, Some(bb.0), Some(bb.1)).ok();
    assert_eq!(text(&approved, "destinationId"), id);
    assert_eq!(text(&approved, "state"), "cooling");
    assert_eq!(text(&approved, "approvedBy"), "device");
    assert_ne!(text(&approved, "approvedAt"), "null");
}

#[test]
fn names_the_typed_refusals_for_a_taken_label_and_a_full_book() {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(BOOK_ADDRESS, "Vault")),
    )
    .ok();
    let taken = save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(
            "0x2222222222222222222222222222222222222222",
            "vault",
        )),
    );
    assert_eq!(taken.trpc(), "PRECONDITION_FAILED");
    assert!(
        taken.message().contains("already have a saved address"),
        "{}",
        taken.message()
    );
    save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(
            "0x3333333333333333333333333333333333333333",
            "Second",
        )),
    )
    .ok();
    let full = save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(
            "0x4444444444444444444444444444444444444444",
            "Third",
        )),
    );
    assert!(
        full.message()
            .contains("address book is full at 2 addresses"),
        "{}",
        full.message()
    );
}

#[test]
fn removes_a_saved_address_with_the_step_up_scope() {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(BOOK_ADDRESS, "Vault")),
    )
    .ok();
    save_as(
        &b.door,
        &u,
        STEPPED,
        &obj(&book_entry(
            "0x3333333333333333333333333333333333333333",
            "Second",
        )),
    )
    .ok();
    let first = text(&list_as(&b.door, &u, STEPPED)[0], "destinationId");
    let removed = call(
        &b.door,
        &u,
        "ramps.destinations.remove",
        &obj(&[
            ("destinationId", s(&first)),
            ("idempotencyKey", s("rm-book-1")),
        ]),
    )
    .ok();
    assert_eq!(
        removed.compact(),
        obj(&[("destinationId", s(&first)), ("removed", Json::Bool(true))]).compact()
    );
    assert_eq!(list_as(&b.door, &u, STEPPED).len(), 1);
}

#[test]
fn lists_the_assets_an_address_may_be_saved_for_with_their_networks_from_the_registry() {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let networks = |door: &BankDoor| {
        call_as(
            door,
            person(&u, &["bank:read"]),
            "ramps.destinations.networks",
            &Json::Null,
        )
        .ok()
    };
    assert_eq!(
        networks(&b.door).compact(),
        r#"[{"assetId":"USDT","precision":6,"networks":[{"networkId":"erc20","label":"TEST erc20"},{"networkId":"base","label":"TEST base"}],"defaultNetworkId":"erc20"}]"#
    );
    b.registry.set(Some(Vec::new()));
    assert_eq!(networks(&b.door).compact(), "[]");
}

#[test]
fn refuses_a_network_the_registry_does_not_list_for_the_asset_and_an_asset_that_cannot_be_withdrawn_saving_nothing()
 {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let before = list_as(&b.door, &u, STEPPED);
    let tron = save_as(
        &b.door,
        &u,
        STEPPED,
        &with(book_entry(BOOK_ADDRESS, "Tron"), &[("network", s("tron"))]),
    );
    assert_eq!(tron.trpc(), "BAD_REQUEST");
    assert!(
        tron.message().contains("USDT is not sent on tron"),
        "{}",
        tron.message()
    );
    assert_eq!(
        save_as(
            &b.door,
            &u,
            STEPPED,
            &with(
                book_entry(BOOK_ADDRESS, "Coins"),
                &[("assetId", s("BTC")), ("network", s("bitcoin"))]
            ),
        )
        .trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        Json::Array(list_as(&b.door, &u, STEPPED)).compact(),
        Json::Array(before).compact()
    );
}

#[test]
fn checks_the_registry_on_the_entry_as_it_is_stored_so_a_lower_case_asset_or_a_capitalised_network_is_the_same_entry()
 {
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    let saved = save_as(
        &b.door,
        &u,
        STEPPED,
        &with(
            book_entry("0x5555555555555555555555555555555555555555", "Cased"),
            &[("assetId", s("usdt")), ("network", s("Base"))],
        ),
    )
    .ok();
    assert_eq!(
        (text(&saved, "assetId"), text(&saved, "network")),
        ("USDT".to_owned(), "base".to_owned())
    );
    call(
        &b.door,
        &u,
        "ramps.destinations.remove",
        &obj(&[
            ("destinationId", s(&text(&saved, "destinationId"))),
            ("idempotencyKey", s("rm-cased")),
        ]),
    )
    .ok();
}

#[test]
fn refuses_to_save_while_the_registry_cannot_be_read_and_says_so_rather_than_accepting_any_network()
{
    let Some(b) = bank_with(router_owner()) else {
        return;
    };
    let u = fresh();
    b.registry.set(None);
    assert_eq!(
        save_as(
            &b.door,
            &u,
            STEPPED,
            &obj(&book_entry(BOOK_ADDRESS, "Later"))
        )
        .trpc(),
        "SERVICE_UNAVAILABLE"
    );
    assert_eq!(
        call_as(
            &b.door,
            person(&u, STEPPED),
            "ramps.destinations.networks",
            &Json::Null
        )
        .trpc(),
        "SERVICE_UNAVAILABLE"
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.user_withdraw_destinations"),
        0
    );
}

// a changed character and a look-alike address (W-withdraw-03)

/// The same start and end as `BOOK_ADDRESS` as the book shows it (0xabCD…EF01), a different middle.
fn lookalike() -> String {
    format!("0xabcd{}ef01", "0".repeat(32))
}
/// `BOOK_ADDRESS` with the case of one letter flipped: its checksum no longer matches.
const TAMPERED: &str = "0xAbCDeF0123456789AbcdEf0123456789aBCDEF01";

fn check(door: &BankDoor, user: &str, r: &str) -> String {
    call_as(
        door,
        person(user, &["bank:read"]),
        "ramps.destinations.check",
        &obj(&[("ref", s(r))]),
    )
    .ok()
    .compact()
}

#[test]
fn checks_an_address_before_the_confirmation_a_mismatched_checksum_not_an_address_and_the_saved_entry_it_shows_like()
 {
    let Some(b) = bank() else { return };
    let u = fresh();
    let clean = r#"{"address":"ok","lookalike":null,"fraudListed":false}"#;
    assert_eq!(check(&b.door, &u, BOOK_ADDRESS), clean);
    let saved = save_as(
        &b.door,
        &u,
        &["bank:read", "trade:withdraw"],
        &obj(&book_entry(BOOK_ADDRESS, "Cold wallet")),
    )
    .ok();
    assert_eq!(check(&b.door, &u, &BOOK_ADDRESS.to_lowercase()), clean);
    assert_eq!(
        check(&b.door, &u, TAMPERED),
        r#"{"address":"checksum_mismatch","lookalike":null,"fraudListed":false}"#
    );
    assert_eq!(
        check(&b.door, &u, "0x1234"),
        r#"{"address":"invalid","lookalike":null,"fraudListed":false}"#
    );
    assert_eq!(
        check(&b.door, &u, &format!(" {} ", lookalike())),
        format!(
            r#"{{"address":"ok","lookalike":{{"destinationId":"{}","label":"Cold wallet","refMasked":"0xabCD…EF01"}},"fraudListed":false}}"#,
            text(&saved, "destinationId")
        )
    );
}

#[test]
fn refuses_to_save_a_mismatched_checksum_saving_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let refused = save_as(
        &b.door,
        &u,
        &["bank:read", "trade:withdraw"],
        &obj(&book_entry(TAMPERED, "Cold wallet")),
    );
    assert_eq!(refused.trpc(), "BAD_REQUEST");
    assert!(
        refused.message().contains("do not match its checksum"),
        "{}",
        refused.message()
    );
    assert!(list_as(&b.door, &u, &["bank:read"]).is_empty());
}

#[test]
fn refuses_a_look_alike_until_the_customer_confirms_they_checked_it_then_saves_it_as_its_own_entry()
{
    let Some(b) = bank() else { return };
    let u = fresh();
    let scopes = ["bank:read", "trade:withdraw"];
    save_as(
        &b.door,
        &u,
        &scopes,
        &obj(&book_entry(BOOK_ADDRESS, "Cold wallet")),
    )
    .ok();
    let near = lookalike();
    for confirm in [None, Some(false)] {
        let mut fields = book_entry(&near, "Look-alike");
        if let Some(c) = confirm {
            fields.push(("confirmLookalike", Json::Bool(c)));
        }
        let refused = save_as(&b.door, &u, &scopes, &obj(&fields));
        assert_eq!(refused.trpc(), "BAD_REQUEST");
        assert!(
            refused
                .message()
                .contains(r#"starts and ends like your saved address "Cold wallet""#),
            "{}",
            refused.message()
        );
    }
    assert_eq!(list_as(&b.door, &u, &scopes).len(), 1);
    let confirmed = save_as(
        &b.door,
        &u,
        &scopes,
        &with(
            book_entry(&near, "Look-alike"),
            &[("confirmLookalike", Json::Bool(true))],
        ),
    )
    .ok();
    // The confirmation is recorded on the new entry, not on the one it looks like.
    assert_eq!(text(&confirmed, "label"), "Look-alike");
    assert_eq!(text(&confirmed, "refMasked"), "0xabcd…ef01");
    assert!(matches!(
        confirmed.get("lookalikeConfirmedAt"),
        Some(Json::String(_))
    ));
    let rows = list_as(&b.door, &u, &scopes);
    let cold = rows
        .iter()
        .find(|r| text(r, "label") == "Cold wallet")
        .unwrap();
    assert_eq!(text(cold, "lookalikeConfirmedAt"), "null");
    assert_eq!(rows.len(), 2);
    // Saved once after confirming, the same entry again is that entry, not a new warning.
    let again = save_as(&b.door, &u, &scopes, &obj(&book_entry(&near, "Look-alike"))).ok();
    assert_eq!(
        text(&again, "destinationId"),
        text(&confirmed, "destinationId")
    );
    assert_eq!(
        check(&b.door, &u, &near),
        r#"{"address":"ok","lookalike":null,"fraudListed":false}"#
    );
}

#[test]
fn records_a_look_alike_confirmation_only_from_its_own_check_never_from_what_a_caller_passes_in() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let st = b.db.store();
    let settings = owner();
    let book = customer::Book {
        store: &st,
        ledger: &b.registry,
        lock: &b.lock,
        settings: &settings,
        now: clock(),
    };
    let mut input = entry(&u, BOOK_ADDRESS, "Cold wallet");
    input.lookalike_of = Some("33333333-3333-4333-8333-333333333333".to_owned());
    let plain = customer::save(&book, &input, false).unwrap();
    assert_eq!(text(&plain, "lookalikeConfirmedAt"), "null");
    // Through the door the field does not exist.
    assert_eq!(
        save_as(
            &b.door,
            &u,
            STEPPED,
            &with(
                book_entry(ADDR_B, "Passed in"),
                &[("lookalikeOf", s("33333333-3333-4333-8333-333333333333"))]
            )
        )
        .trpc(),
        "BAD_REQUEST"
    );
}

#[test]
fn does_not_call_the_same_address_in_another_case_or_saved_again_a_look_alike() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let scopes = ["bank:read", "trade:withdraw"];
    let first = save_as(
        &b.door,
        &u,
        &scopes,
        &obj(&book_entry(BOOK_ADDRESS, "Cold wallet")),
    )
    .ok();
    let again = save_as(
        &b.door,
        &u,
        &scopes,
        &obj(&book_entry(BOOK_ADDRESS, "Cold wallet")),
    )
    .ok();
    assert_eq!(text(&again, "destinationId"), text(&first, "destinationId"));
    let on_base = save_as(
        &b.door,
        &u,
        &scopes,
        &with(
            book_entry(&BOOK_ADDRESS.to_lowercase(), "On Base"),
            &[("network", s("base"))],
        ),
    )
    .ok();
    assert_eq!(text(&on_base, "network"), "base");
}

// ownership: prove a saved wallet (W-withdraw-17)

/// A well-known public development key (the first account of common local EVM chains). Holds nothing; TEST only.
const KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WALLET: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const STRANGER_KEY: &str = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const STRANGER: &str = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}

/// `personal_sign` of `message` by `key`: r, s and v (27 or 28), hex.
fn sign_with(key: &str, message: &str) -> String {
    let mut joined = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    joined.extend_from_slice(message.as_bytes());
    let digest = Keccak256::digest(&joined);
    let signer = SigningKey::from_slice(&unhex(key)).unwrap();
    let (sig, rec) = signer.sign_prehash_recoverable(&digest).unwrap();
    let mut out = sig.to_bytes().to_vec();
    out.push(rec.to_byte() + 27);
    format!(
        "0x{}",
        out.iter().map(|x| format!("{x:02x}")).collect::<String>()
    )
}

fn sign(message: &str) -> String {
    sign_with(KEY, message)
}

#[test]
fn needs_bank_write_lists_the_entry_pending_then_verified_and_refuses_an_unknown_proof_as_not_found()
 {
    let Some(b) = bank() else { return };
    let u = fresh();
    let saved = save_as(
        &b.door,
        &u,
        &["bank:read", "trade:withdraw"],
        &obj(&book_entry(WALLET, "TEST private")),
    )
    .ok();
    let id = text(&saved, "destinationId");
    assert_eq!(
        saved.get("ownership").unwrap().compact(),
        r#"{"state":"none","verifiedAt":null,"validUntil":null,"offerExpiresAt":null}"#
    );
    assert_eq!(
        call_as(
            &b.door,
            person(&u, &["bank:read"]),
            "ramps.destinations.ownership.start",
            &obj(&[("destinationId", s(&id))])
        )
        .trpc(),
        "FORBIDDEN"
    );
    let writer = || person(&u, &["bank:read", "bank:write"]);
    let started = call_as(
        &b.door,
        writer(),
        "ramps.destinations.ownership.start",
        &obj(&[("destinationId", s(&id))]),
    )
    .ok();
    let list = list_as(&b.door, &u, &["bank:read"]);
    assert_eq!(text(list[0].get("ownership").unwrap(), "state"), "pending");
    let verify = |proof: &str, sig: &str| {
        call_as(
            &b.door,
            writer(),
            "ramps.destinations.ownership.verify",
            &obj(&[("proofId", s(proof)), ("signature", s(sig))]),
        )
    };
    let bad = verify(&text(&started, "proofId"), "nope");
    assert_eq!(
        (bad.trpc(), bad.code()),
        (
            "BAD_REQUEST".to_owned(),
            "bank.wallet_proof_signature_invalid".to_owned()
        )
    );
    assert_eq!(
        verify(
            "44444444-4444-4444-8444-444444444444",
            &sign(&text(&started, "message"))
        )
        .trpc(),
        "NOT_FOUND"
    );
    let done = verify(
        &text(&started, "proofId"),
        &sign(&text(&started, "message")),
    )
    .ok();
    assert_eq!(text(&done, "destinationId"), id);
    assert_eq!(text(&done, "state"), "verified");
    let row = list_as(&b.door, &u, &["bank:read"]).remove(0);
    let own = row.get("ownership").unwrap();
    assert_eq!(text(own, "state"), "verified");
    assert_eq!(text(own, "verifiedAt"), text(&done, "verifiedAt"));
    assert_eq!(text(own, "validUntil"), text(&done, "validUntil"));
    // A rename keeps the proof on the row it answers with.
    let renamed = call_as(
        &b.door,
        writer(),
        "ramps.destinations.rename",
        &obj(&[("destinationId", s(&id)), ("label", s("TEST renamed"))]),
    )
    .ok();
    assert_eq!(text(renamed.get("ownership").unwrap(), "state"), "verified");
}

#[test]
fn refuses_to_start_while_the_owner_proof_window_is_blank() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = b
        .store_save(Some("5"), &entry(&u, WALLET, "TEST private"))
        .unwrap()
        .destination_id;
    let blank = b.reopened(Settings {
        wallet_proof_window_minutes: Some(String::new()),
        ..owner()
    });
    let refused = call_as(
        &blank,
        person(&u, &["bank:write"]),
        "ramps.destinations.ownership.start",
        &obj(&[("destinationId", s(&id))]),
    );
    assert_eq!(
        (refused.trpc(), refused.code()),
        (
            "PRECONDITION_FAILED".to_owned(),
            "bank.wallet_proof_window_unset".to_owned()
        )
    );
}

// ---------------------------------------------------------------------------------------------------------------
// ramps/wallet-ownership.test.ts: the signed-message proof (W-withdraw-17)

fn at(iso: &str) -> Instant {
    service_kit::time::js_date(iso).unwrap()
}

/// The same signature with v written 0/1, as some wallets return it.
fn with_low_v(sig: &str) -> String {
    let v = u8::from_str_radix(&sig[130..], 16).unwrap() - 27;
    format!("{}{v:02x}", &sig[..130])
}

#[test]
fn recovers_the_signer_of_an_independent_test_vector_made_with_another_evm_library() {
    let signature = "0x9b3af850907666f6c0672b1a2da3be092826caf4f4b7dc07e779717088a1bd5e43d05c9f345c22e271108a2b31edd49c1c81d6f7036f52d48dcf594961288de21b";
    assert_eq!(
        ownership::recover_personal_sign_address("INTAFACED wallet proof TEST vector", signature)
            .as_deref(),
        Some(WALLET)
    );
    assert_eq!(sign("INTAFACED wallet proof TEST vector"), signature);
}

#[test]
fn takes_v_as_0_1_too_and_answers_another_address_for_another_message() {
    let sig = sign("one");
    assert_eq!(
        ownership::recover_personal_sign_address("one", &with_low_v(&sig)).as_deref(),
        Some(WALLET)
    );
    assert_ne!(
        ownership::recover_personal_sign_address("two", &sig).as_deref(),
        Some(WALLET)
    );
}

#[test]
fn answers_null_for_anything_that_is_not_a_65_byte_signature() {
    let sig = sign("m");
    for bad in [
        String::new(),
        "0x".to_owned(),
        "hello".to_owned(),
        format!("0x{}", "00".repeat(65)),
        format!("0x{}", "ab".repeat(64)),
        format!("{sig}00"),
        format!("{}1d", &sig[..130]),
    ] {
        assert_eq!(
            ownership::recover_personal_sign_address("m", &bad),
            None,
            "{bad}"
        );
    }
}

fn proof(
    status: &str,
    expires: &str,
    verified_at: Option<&str>,
    valid_until: Option<&str>,
) -> ownership::Proof {
    ownership::Proof {
        id: "p".to_owned(),
        user_id: "u".to_owned(),
        destination_id: "d".to_owned(),
        address: WALLET.to_owned(),
        message: "m".to_owned(),
        status: status.to_owned(),
        expires_at: at(expires),
        verified_at: verified_at.map(at),
        valid_until: valid_until.map(at),
        signature: (status == "verified").then(|| "0x".to_owned()),
    }
}

fn pending_p() -> ownership::Proof {
    proof("pending", "2026-10-23T10:30:00Z", None, None)
}

fn verified_p() -> ownership::Proof {
    proof(
        "verified",
        "2026-10-23T10:30:00Z",
        Some("2026-10-23T10:00:00Z"),
        Some("2026-11-01T00:00:00Z"),
    )
}

fn proofs(
    pending: Option<ownership::Proof>,
    verified: Option<ownership::Proof>,
) -> ownership::EntryProofs {
    ownership::EntryProofs { pending, verified }
}

#[test]
fn reads_none_pending_verified_and_expired() {
    let state = |p: Option<&ownership::EntryProofs>, now: &str| {
        ownership::ownership_of(p, at(now), None).state
    };
    assert_eq!(state(None, "2026-10-23T10:00:00Z"), "none");
    assert_eq!(
        state(
            Some(&proofs(Some(pending_p()), None)),
            "2026-10-23T10:10:00Z"
        ),
        "pending"
    );
    assert_eq!(
        state(
            Some(&proofs(Some(pending_p()), None)),
            "2026-10-23T10:30:00Z"
        ),
        "expired"
    );
    let held = ownership::ownership_of(
        Some(&proofs(None, Some(verified_p()))),
        at("2026-10-30T00:00:00Z"),
        None,
    );
    assert_eq!(held.state, "verified");
    assert_eq!(
        held.valid_until.as_deref(),
        Some("2026-11-01T00:00:00.000Z")
    );
    assert_eq!(
        state(
            Some(&proofs(None, Some(verified_p()))),
            "2026-11-01T00:00:00Z"
        ),
        "expired"
    );
}

#[test]
fn ignores_a_proof_made_for_another_address_than_the_entry_holds_now() {
    let now = at("2026-10-30T00:00:00Z");
    let upper = format!("0x{}", WALLET[2..].to_uppercase());
    assert_eq!(
        ownership::ownership_of(Some(&proofs(None, Some(verified_p()))), now, Some(&upper)).state,
        "verified"
    );
    assert_eq!(
        ownership::ownership_of(
            Some(&proofs(Some(pending_p()), Some(verified_p()))),
            now,
            Some(ADDR_A)
        )
        .state,
        "none"
    );
}

#[test]
fn keeps_a_proof_that_still_holds_over_a_newer_offer_and_shows_the_offer_once_the_proof_lapses() {
    let newer = proof("pending", "2026-11-01T00:30:00Z", None, None);
    let both = proofs(Some(newer), Some(verified_p()));
    assert_eq!(
        ownership::ownership_of(Some(&both), at("2026-10-30T00:00:00Z"), None).state,
        "verified"
    );
    let lapsed = ownership::ownership_of(Some(&both), at("2026-11-01T00:10:00Z"), None);
    assert_eq!(lapsed.state, "pending");
    assert_eq!(
        lapsed.valid_until.as_deref(),
        Some("2026-11-01T00:00:00.000Z")
    );
    assert_eq!(
        ownership::ownership_of(Some(&both), at("2026-11-01T00:30:00Z"), None).state,
        "expired"
    );
}

/// The proof flows' rig: the clock at 2026-10-23T10:00:00Z, the wallet saved for `user` (its id).
fn proof_rig(b: &Bank, user: &str, r: &str) -> String {
    set_now(at("2026-10-23T10:00:00.000Z").0);
    let label = format!("TEST {}", &r[r.len() - 4..]);
    b.store_save(Some("5"), &entry(user, r, &label))
        .unwrap()
        .destination_id
}

fn start_proof(door: &BankDoor, user: &str, id: &str) -> Answer {
    call_as(
        door,
        person(user, &["bank:read", "bank:write"]),
        "ramps.destinations.ownership.start",
        &obj(&[("destinationId", s(id))]),
    )
}

fn verify_proof(door: &BankDoor, user: &str, proof: &str, sig: &str) -> Answer {
    call_as(
        door,
        person(user, &["bank:read", "bank:write"]),
        "ramps.destinations.ownership.verify",
        &obj(&[("proofId", s(proof)), ("signature", s(sig))]),
    )
}

fn latest_of(b: &Bank, user: &str, id: &str) -> Option<ownership::EntryProofs> {
    let all = ownership::latest(&mut b.client(), user).unwrap();
    ownership::of(&all, id).cloned()
}

fn advance(ms: i64) {
    set_now(clock().0 + ms);
}

#[test]
fn offers_a_message_naming_the_address_and_the_proof_then_verifies_the_saved_address_signing_it() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    let (proof_id, message) = (text(&started, "proofId"), text(&started, "message"));
    assert_eq!(
        message,
        ownership::proof_message(WALLET, &proof_id, at(&text(&started, "expiresAt")))
    );
    assert!(
        message.contains(WALLET)
            && message.contains(&proof_id)
            && message.contains("moves no funds")
    );
    assert_eq!(text(&started, "expiresAt"), "2026-10-23T10:30:00.000Z");
    assert_eq!(
        latest_of(&b, &u, &id).unwrap().pending.unwrap().status,
        "pending"
    );
    advance(MINUTE);
    let done = verify_proof(&b.door, &u, &proof_id, &sign(&message)).ok();
    assert_eq!(text(&done, "state"), "verified");
    assert_eq!(text(&done, "verifiedAt"), "2026-10-23T10:01:00.000Z");
    assert_eq!(text(&done, "validUntil"), "2027-04-21T10:01:00.000Z");
}

#[test]
fn refuses_another_signer_by_name_and_keeps_the_offer_open_so_the_right_wallet_can_still_sign() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    let (proof_id, message) = (text(&started, "proofId"), text(&started, "message"));
    let wrong = verify_proof(&b.door, &u, &proof_id, &sign_with(STRANGER_KEY, &message));
    assert_eq!(wrong.code(), "bank.wallet_proof_wrong_signer");
    let m = wrong.message();
    let (stranger, wallet) = (
        m.find("0x7099…79c8").unwrap(),
        m.find("0xf39f…2266").unwrap(),
    );
    assert!(stranger < wallet, "{m}");
    assert_eq!(STRANGER, "0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    assert_eq!(
        latest_of(&b, &u, &id).unwrap().pending.unwrap().status,
        "pending"
    );
    assert_eq!(
        text(
            &verify_proof(&b.door, &u, &proof_id, &sign(&message)).ok(),
            "state"
        ),
        "verified"
    );
}

#[test]
fn refuses_a_signature_of_other_text_and_text_that_is_not_a_signature() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let proof_id = text(&start_proof(&b.door, &u, &id).ok(), "proofId");
    assert_eq!(
        verify_proof(&b.door, &u, &proof_id, &sign("something else")).code(),
        "bank.wallet_proof_wrong_signer"
    );
    assert_eq!(
        verify_proof(&b.door, &u, &proof_id, "not a signature").code(),
        "bank.wallet_proof_signature_invalid"
    );
}

#[test]
fn refuses_a_lapsed_offer_and_records_nothing() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    advance(30 * MINUTE);
    assert_eq!(
        verify_proof(
            &b.door,
            &u,
            &text(&started, "proofId"),
            &sign(&text(&started, "message"))
        )
        .code(),
        "bank.wallet_proof_expired"
    );
    let latest = latest_of(&b, &u, &id);
    assert_eq!(latest.as_ref().and_then(|l| l.verified.clone()), None);
    assert_eq!(
        ownership::ownership_of(latest.as_ref(), at("2026-10-23T10:30:00Z"), None).state,
        "expired"
    );
    // A new start makes a new offer once the old one lapsed.
    let again = start_proof(&b.door, &u, &id).ok();
    assert_ne!(text(&again, "proofId"), text(&started, "proofId"));
}

#[test]
fn answers_an_open_offer_again_instead_of_making_another_and_keeps_a_held_proof_while_a_new_offer_is_open()
 {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let first = start_proof(&b.door, &u, &id).ok();
    advance(MINUTE);
    assert_eq!(
        start_proof(&b.door, &u, &id).ok().compact(),
        first.compact()
    );
    verify_proof(
        &b.door,
        &u,
        &text(&first, "proofId"),
        &sign(&text(&first, "message")),
    )
    .ok();
    let reprove = start_proof(&b.door, &u, &id).ok();
    assert_ne!(text(&reprove, "proofId"), text(&first, "proofId"));
    assert_eq!(
        ownership::ownership_of(
            latest_of(&b, &u, &id).as_ref(),
            at("2026-10-23T10:02:00Z"),
            None
        )
        .state,
        "verified"
    );
}

#[test]
fn refuses_a_signature_that_arrives_after_the_offer_lapsed_even_when_the_offer_was_open_when_the_check_began()
 {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    // The first clock read is inside the window; the read just before the proof is recorded is past it.
    let reads = Cell::new(0);
    let late = || {
        reads.set(reads.get() + 1);
        if reads.get() == 1 {
            at("2026-10-23T10:29:59.990Z")
        } else {
            at("2026-10-23T10:30:00.400Z")
        }
    };
    let refused = ownership::verify(
        &b.db.store(),
        Some("180"),
        &u,
        &text(&started, "proofId"),
        &sign(&text(&started, "message")),
        &late,
    );
    assert_eq!(code_of(refused), "bank.wallet_proof_expired");
    assert_eq!(latest_of(&b, &u, &id).and_then(|l| l.verified), None);
}

#[test]
fn does_not_find_another_customers_entry_or_proof() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let other = fresh();
    let id = proof_rig(&b, &u, WALLET);
    assert_eq!(
        start_proof(&b.door, &other, &id).code(),
        "bank.wallet_proof_not_found"
    );
    let started = start_proof(&b.door, &u, &id).ok();
    assert_eq!(
        verify_proof(
            &b.door,
            &other,
            &text(&started, "proofId"),
            &sign(&text(&started, "message"))
        )
        .code(),
        "bank.wallet_proof_not_found"
    );
}

#[test]
fn proves_only_a_saved_wallet_entry_not_the_legacy_bank_slot() {
    let Some(b) = bank() else { return };
    let u = fresh();
    set_now(at("2026-10-23T10:00:00.000Z").0);
    let slot = store::persist(&mut b.client(), None, &u, "bank", IBAN, None).unwrap();
    assert_eq!(
        start_proof(&b.door, &u, &slot.destination_id).code(),
        "bank.wallet_proof_not_found"
    );
}

#[test]
fn answers_the_same_signature_again_with_the_same_proof_and_refuses_a_different_one() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    let proof_id = text(&started, "proofId");
    let signature = sign(&text(&started, "message"));
    let first = verify_proof(&b.door, &u, &proof_id, &signature).ok();
    advance(31 * MINUTE);
    let upper = format!("0x{}", signature[2..].to_uppercase());
    assert_eq!(
        verify_proof(&b.door, &u, &proof_id, &upper).ok().compact(),
        first.compact()
    );
    assert_eq!(
        verify_proof(&b.door, &u, &proof_id, &with_low_v(&signature)).code(),
        "bank.wallet_proof_conflict"
    );
}

#[test]
fn refuses_to_offer_a_proof_while_the_owner_window_or_validity_is_blank_and_stores_nothing() {
    let Some(b) = bank() else { return };
    for (name, window, validity, code) in [
        (
            "window",
            None,
            Some("180"),
            "bank.wallet_proof_window_unset",
        ),
        (
            "window as zero",
            Some("0"),
            Some("180"),
            "bank.wallet_proof_window_unset",
        ),
        (
            "validity",
            Some("30"),
            Some(" "),
            "bank.wallet_proof_validity_unset",
        ),
        (
            "validity as a fraction",
            Some("30"),
            Some("1.5"),
            "bank.wallet_proof_validity_unset",
        ),
    ] {
        let u = fresh();
        let id = proof_rig(&b, &u, WALLET);
        let door = b.reopened(Settings {
            wallet_proof_window_minutes: window.map(str::to_owned),
            wallet_proof_valid_days: validity.map(str::to_owned),
            ..owner()
        });
        assert_eq!(start_proof(&door, &u, &id).code(), code, "{name}");
        assert!(
            ownership::latest(&mut b.client(), &u).unwrap().is_empty(),
            "{name}"
        );
    }
}

#[test]
fn refuses_to_verify_when_the_validity_was_unpublished_after_the_offer_and_leaves_it_pending() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    let unpublished = b.reopened(Settings {
        wallet_proof_valid_days: None,
        ..owner()
    });
    assert_eq!(
        verify_proof(
            &unpublished,
            &u,
            &text(&started, "proofId"),
            &sign(&text(&started, "message"))
        )
        .code(),
        "bank.wallet_proof_validity_unset"
    );
    assert_eq!(
        latest_of(&b, &u, &id).unwrap().pending.unwrap().status,
        "pending"
    );
}

#[test]
fn refuses_a_proof_whose_entry_was_removed() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = proof_rig(&b, &u, WALLET);
    let started = start_proof(&b.door, &u, &id).ok();
    store::remove(&b.db.store(), &u, &id, "rm").unwrap();
    assert_eq!(
        verify_proof(
            &b.door,
            &u,
            &text(&started, "proofId"),
            &sign(&text(&started, "message"))
        )
        .code(),
        "bank.wallet_proof_not_found"
    );
}

// ramps/wallet-ownership.db.test.ts: the proofs table

#[test]
fn stores_the_offer_pending_verifies_it_once_and_reads_the_latest_proof_per_entry() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let upper = format!("0x{}", WALLET[2..].to_uppercase());
    let id = b
        .store_save(Some("5"), &entry(&u, &upper, "TEST"))
        .unwrap()
        .destination_id;
    let first = start_proof(&b.door, &u, &id).ok();
    assert!(text(&first, "message").contains(&format!("Address: {WALLET}")));
    // While the offer is open, starting again answers the same offer.
    assert_eq!(
        start_proof(&b.door, &u, &id).ok().compact(),
        first.compact()
    );
    assert_eq!(
        latest_of(&b, &u, &id).unwrap().pending.unwrap().id,
        text(&first, "proofId")
    );
    let done = verify_proof(
        &b.door,
        &u,
        &text(&first, "proofId"),
        &sign(&text(&first, "message")),
    )
    .ok();
    assert_eq!(text(&done, "state"), "verified");
    let stored = latest_of(&b, &u, &id).unwrap();
    assert_eq!(stored.pending, None);
    let held = stored.verified.unwrap();
    assert_eq!(
        (
            held.id.as_str(),
            held.status.as_str(),
            held.address.as_str()
        ),
        (text(&first, "proofId").as_str(), "verified", WALLET)
    );
    assert_eq!(
        held.valid_until.unwrap().0 - held.verified_at.unwrap().0,
        180 * DAY
    );
    // A second mark of the same proof finds nothing pending: another signature is a conflict, and the row is unchanged.
    assert_eq!(
        verify_proof(
            &b.door,
            &u,
            &text(&first, "proofId"),
            &with_low_v(&sign(&text(&first, "message")))
        )
        .code(),
        "bank.wallet_proof_conflict"
    );
    assert_eq!(latest_of(&b, &u, &id).unwrap().verified.unwrap(), held);
    // Proving again opens a new offer beside the held proof.
    let again = start_proof(&b.door, &u, &id).ok();
    let both = latest_of(&b, &u, &id).unwrap();
    assert_eq!(
        (both.pending.unwrap().id, both.verified.unwrap().id),
        (text(&again, "proofId"), text(&first, "proofId"))
    );
}

#[test]
fn orders_two_offers_made_in_the_same_instant_by_when_they_were_made_and_marks_none_once_lapsed() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let dest = "77777777-7777-4777-8777-777777777777";
    let offer = |id: &str| {
        b.client()
            .execute(
                "INSERT INTO bank.wallet_ownership_proofs (id, user_id, destination_id, address, message, status, created_at, expires_at) \
                 VALUES ($1::text::uuid, $2, $3::text::uuid, $4, 'm', 'pending', '2026-10-23T10:00:00Z', '2026-10-23T10:01:00Z')",
                &[&id, &u, &dest, &WALLET],
            )
            .unwrap();
    };
    // The later offer has the lower id, so only the order made can pick it.
    offer("ffffffff-ffff-4fff-8fff-ffffffffffff");
    offer("00000000-0000-4000-8000-00000000000a");
    assert_eq!(
        latest_of(&b, &u, dest).unwrap().pending.unwrap().id,
        "00000000-0000-4000-8000-00000000000a"
    );
    set_now(at("2026-10-23T10:01:00Z").0);
    assert_eq!(
        verify_proof(
            &b.door,
            &u,
            "00000000-0000-4000-8000-00000000000a",
            &sign("m")
        )
        .code(),
        "bank.wallet_proof_expired"
    );
    assert_eq!(latest_of(&b, &u, dest).unwrap().verified, None);
}

#[test]
fn never_answers_another_customers_proof_or_an_id_that_is_not_one() {
    let Some(b) = bank() else { return };
    let u = fresh();
    let id = b
        .store_save(Some("5"), &entry(&u, WALLET, "TEST"))
        .unwrap()
        .destination_id;
    let started = start_proof(&b.door, &u, &id).ok();
    let other = fresh();
    let sig = sign(&text(&started, "message"));
    assert_eq!(
        verify_proof(&b.door, &other, &text(&started, "proofId"), &sig).code(),
        "bank.wallet_proof_not_found"
    );
    // The door's schema refuses an id that is not one; the store behind it finds nothing for one.
    assert_eq!(
        verify_proof(&b.door, &u, "not-a-uuid", &sig).trpc(),
        "BAD_REQUEST"
    );
    assert_eq!(
        code_of(ownership::verify(
            &b.db.store(),
            Some("180"),
            &u,
            "not-a-uuid",
            &sig,
            &clock
        )),
        "bank.wallet_proof_not_found"
    );
    assert!(
        ownership::latest(&mut b.client(), &other)
            .unwrap()
            .is_empty()
    );
    assert_eq!(latest_of(&b, &u, &id).unwrap().verified, None);
}

#[test]
fn refuses_a_verified_row_without_its_signature_and_an_offer_that_ends_before_it_starts() {
    let Some(b) = bank() else { return };
    let id = "33333333-3333-4333-8333-333333333333";
    let constraint = |sql: &str| {
        b.client()
            .execute(sql, &[&id])
            .unwrap_err()
            .as_db_error()
            .and_then(|d| d.constraint().map(str::to_owned))
            .unwrap_or_default()
    };
    assert_eq!(
        constraint(
            "INSERT INTO bank.wallet_ownership_proofs (id, user_id, destination_id, address, message, status, expires_at, verified_at, valid_until) \
             VALUES ($1::text::uuid, 'u', $1::text::uuid, 'a', 'm', 'verified', now() + interval '1 minute', now(), now())"
        ),
        "wallet_ownership_proofs_verified_ck"
    );
    assert_eq!(
        constraint(
            "INSERT INTO bank.wallet_ownership_proofs (id, user_id, destination_id, address, message, expires_at) \
             VALUES ($1::text::uuid, 'u', $1::text::uuid, 'a', 'm', now() - interval '1 minute')"
        ),
        "wallet_ownership_proofs_window_ck"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// ramps/fraud-list.db.test.ts and ramps/fraud-list.test.ts: the destination fraud list (W-withdraw-03)

const OFFICER: &str = OPERATOR;
const LISTED: &str = "0x7e5700000000000000000000000000000000fa1d";
const CLEAN: &str = "0x52908400098527886E0F7030069857D2E4169EE7";
const REASON: &str = "TEST: reported as a scam wallet";
const CUSTOMER: &str = "11111111-1111-4111-8111-111111111111";

fn upper_hex(a: &str) -> String {
    format!("0x{}", a[2..].to_uppercase())
}

/// The fraud suites' bank: USDT withdrawn on ethereum and base.
fn fraud_bank() -> Option<Bank> {
    let b = bank()?;
    b.registry.set(Some(vec![registry_row(
        "USDT",
        &["ethereum", "base"],
        &["deposit", "withdraw"],
    )]));
    Some(b)
}

/// The listing change's input, with an approval for `approved` (this change unless another is named).
fn listing(change: &fraud::Change<'_>, approval: Option<Vec<(String, Json)>>) -> Json {
    let mut fields = vec![
        ("network".to_owned(), s(change.network)),
        ("address".to_owned(), s(change.address)),
        ("listed".to_owned(), Json::Bool(change.listed)),
        (
            "expectedRevision".to_owned(),
            Json::Number(change.expected_revision as f64),
        ),
        ("reason".to_owned(), s(change.reason)),
    ];
    fields.extend(approval.unwrap_or_default());
    Json::Object(fields)
}

fn set_listing(b: &Bank, scopes: &[&str], input: &Json) -> Answer {
    call_as(
        &b.door,
        person(OFFICER, scopes),
        "ops.setDestinationFraudListing",
        input,
    )
}

/// `list(bank, approvals, change, reason)`: the change with its own approval, as compliance.
fn list_change(
    b: &Bank,
    network: &str,
    address: &str,
    listed: bool,
    rev: i64,
    reason: &str,
) -> Answer {
    let change = fraud::Change {
        network,
        address,
        listed,
        expected_revision: rev,
        reason,
    };
    let approval = fraud::fields(&change)
        .ok()
        .map(|f| b.desk.issue(fraud::SET_ACTION, &f));
    set_listing(b, &["admin:compliance"], &listing(&change, approval))
}

fn desk_list(b: &Bank, input: &Json) -> Json {
    call_as(
        &b.door,
        person(OFFICER, &["admin:read"]),
        "ops.destinationFraudList",
        input,
    )
    .ok()
}

fn wallet(r: &str, network: &str) -> Json {
    obj(&[
        ("assetId", s("USDT")),
        ("network", s(network)),
        ("ref", s(r)),
        ("label", Json::str(format!("TEST wallet {}", &uuid()[..8]))),
    ])
}

fn check_on(b: &Bank, r: &str, network: &str) -> Answer {
    call(
        &b.door,
        CUSTOMER,
        "ramps.destinations.check",
        &obj(&[("ref", s(r)), ("network", s(network))]),
    )
}

#[test]
fn starts_empty_nothing_is_listed_and_the_address_book_saves_any_valid_address() {
    let Some(b) = fraud_bank() else { return };
    assert_eq!(
        desk_list(&b, &obj(&[("limit", Json::Number(50.0))])).compact(),
        r#"{"entries":[],"history":[]}"#
    );
    assert_eq!(
        text(&check_on(&b, LISTED, "ethereum").ok(), "fraudListed"),
        "false"
    );
    assert_eq!(
        text(
            &call(
                &b.door,
                CUSTOMER,
                "ramps.destinations.save",
                &wallet(LISTED, "ethereum")
            )
            .ok(),
            "state"
        ),
        "pending"
    );
}

#[test]
fn a_listed_address_is_refused_by_name_before_anything_is_written_however_its_case_is_typed_on_every_network()
 {
    let Some(b) = fraud_bank() else { return };
    let listed = list_change(&b, "*", &upper_hex(LISTED), true, 0, REASON).ok();
    for (k, v) in [
        ("network", "*"),
        ("address", LISTED),
        ("listed", "true"),
        ("revision", "1"),
        ("approvedBy", APPROVER),
        ("replayed", "false"),
    ] {
        assert_eq!(text(&listed, k), v, "{k}");
    }
    for (r, network) in [(LISTED.to_owned(), "ethereum"), (upper_hex(LISTED), "base")] {
        assert_eq!(text(&check_on(&b, &r, network).ok(), "fraudListed"), "true");
        assert_eq!(
            call(
                &b.door,
                CUSTOMER,
                "ramps.destinations.save",
                &wallet(&r, network)
            )
            .code(),
            "bank.destination_fraud_listed"
        );
    }
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.user_withdraw_destinations WHERE lower(ref) = '{LISTED}'"
        )),
        0
    );
    assert!(list_as(&b.door, CUSTOMER, STEPPED).is_empty());
    // An address that is not listed still saves.
    assert_eq!(
        text(
            &call(
                &b.door,
                CUSTOMER,
                "ramps.destinations.save",
                &wallet(CLEAN, "ethereum")
            )
            .ok(),
            "refMasked"
        ),
        "0x5290…9EE7"
    );
}

#[test]
fn a_listing_on_one_network_refuses_that_network_only() {
    let Some(b) = fraud_bank() else { return };
    list_change(&b, "base", LISTED, true, 0, REASON).ok();
    assert_eq!(
        call(
            &b.door,
            CUSTOMER,
            "ramps.destinations.save",
            &wallet(LISTED, "base")
        )
        .code(),
        "bank.destination_fraud_listed"
    );
    assert_eq!(
        text(
            &call(
                &b.door,
                CUSTOMER,
                "ramps.destinations.save",
                &wallet(LISTED, "ethereum")
            )
            .ok(),
            "network"
        ),
        "ethereum"
    );
}

#[test]
fn a_saved_entry_listed_later_reads_blocked_and_saving_it_again_is_refused_rather_than_replayed() {
    let Some(b) = fraud_bank() else { return };
    let saved = call(
        &b.door,
        CUSTOMER,
        "ramps.destinations.save",
        &wallet(CLEAN, "ethereum"),
    )
    .ok();
    list_change(&b, "*", CLEAN, true, 0, REASON).ok();
    assert_eq!(
        text(
            &call(
                &b.door,
                CUSTOMER,
                "ramps.destinations.readiness",
                &obj(&[("destinationId", s(&text(&saved, "destinationId")))])
            )
            .ok(),
            "state"
        ),
        "blocked"
    );
    let again = with(
        vec![
            ("assetId", s("USDT")),
            ("network", s("ethereum")),
            ("ref", s(CLEAN)),
        ],
        &[("label", s(&text(&saved, "label")))],
    );
    assert_eq!(
        call(&b.door, CUSTOMER, "ramps.destinations.save", &again).code(),
        "bank.destination_fraud_listed"
    );
}

#[test]
fn delisting_is_its_own_approved_change_the_history_keeps_both_newest_first_and_refuses_edits() {
    let Some(b) = fraud_bank() else { return };
    list_change(&b, "*", LISTED, true, 0, REASON).ok();
    list_change(
        &b,
        "*",
        LISTED,
        false,
        1,
        "TEST: report withdrawn after review",
    )
    .ok();
    assert_eq!(b.desk.consumed(), 2);
    assert_eq!(
        text(
            &call(
                &b.door,
                CUSTOMER,
                "ramps.destinations.save",
                &wallet(LISTED, "ethereum")
            )
            .ok(),
            "state"
        ),
        "pending"
    );
    let desk = desk_list(
        &b,
        &obj(&[
            ("limit", Json::Number(50.0)),
            (
                "historyFor",
                obj(&[("network", s("*")), ("address", s(&upper_hex(LISTED)))]),
            ),
            ("historyLimit", Json::Number(10.0)),
        ]),
    );
    let entries = list_of(desk.get("entries").unwrap());
    assert_eq!(entries.len(), 1);
    assert_eq!(
        (
            text(&entries[0], "address"),
            text(&entries[0], "listed"),
            text(&entries[0], "revision")
        ),
        (LISTED.to_owned(), "false".to_owned(), "2".to_owned())
    );
    let history: Vec<[String; 5]> = list_of(desk.get("history").unwrap())
        .iter()
        .map(|h| {
            [
                text(h, "revision"),
                text(h, "listed"),
                text(h, "requestedBy"),
                text(h, "approvedBy"),
                text(h, "changeKey"),
            ]
        })
        .collect();
    let row = |rev: i64, listed: &str| {
        [
            rev.to_string(),
            listed.to_owned(),
            OFFICER.to_owned(),
            APPROVER.to_owned(),
            fraud::change_key("*", LISTED, rev),
        ]
    };
    assert_eq!(history, vec![row(2, "false"), row(1, "true")]);
    for edit in [
        "UPDATE bank.destination_fraud_list_history SET listed = true",
        "DELETE FROM bank.destination_fraud_list_history",
    ] {
        let e = b.client().batch_execute(edit).unwrap_err();
        assert!(format!("{e:?}").contains("append-only"), "{e:?}");
    }
}

#[test]
fn a_retried_change_replays_without_a_second_approval_another_change_on_the_same_revision_conflicts()
 {
    let Some(b) = fraud_bank() else { return };
    list_change(&b, "*", LISTED, true, 0, REASON).ok();
    let retry = fraud::Change {
        network: "*",
        address: LISTED,
        listed: true,
        expected_revision: 0,
        reason: REASON,
    };
    let again = set_listing(&b, &["admin:compliance"], &listing(&retry, None)).ok();
    assert_eq!(
        (text(&again, "revision"), text(&again, "replayed")),
        ("1".to_owned(), "true".to_owned())
    );
    assert_eq!(b.desk.consumed(), 1);
    assert_eq!(
        list_change(&b, "*", LISTED, false, 0, REASON).code(),
        "bank.ops_revision_conflict"
    );
    // Once a later change lands, the old retry is stale: it conflicts rather than reporting a state that is no longer true.
    list_change(
        &b,
        "*",
        LISTED,
        false,
        1,
        "TEST: report withdrawn after review",
    )
    .ok();
    assert_eq!(
        set_listing(&b, &["admin:compliance"], &listing(&retry, None)).code(),
        "bank.ops_revision_conflict"
    );
}

#[test]
fn needs_compliance_and_a_matching_approval_a_short_reason_and_a_read_only_desk_change_nothing() {
    let Some(b) = fraud_bank() else { return };
    let change = fraud::Change {
        network: "*",
        address: LISTED,
        listed: true,
        expected_revision: 0,
        reason: REASON,
    };
    let own = b
        .desk
        .issue(fraud::SET_ACTION, &fraud::fields(&change).unwrap());
    assert_eq!(
        set_listing(&b, &["admin:read"], &listing(&change, Some(own))).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        list_change(&b, "*", LISTED, true, 0, "too short").code(),
        "bank.ops_reason_too_short"
    );
    // An approval for another address, or for this change with another reason, is not this change's approval.
    for other in [
        fraud::Change {
            address: CLEAN,
            ..change
        },
        fraud::Change {
            reason: "TEST: some other reason",
            ..change
        },
    ] {
        let wrong = b
            .desk
            .issue(fraud::SET_ACTION, &fraud::fields(&other).unwrap());
        assert_eq!(
            set_listing(&b, &["admin:compliance"], &listing(&change, Some(wrong))).trpc(),
            "PRECONDITION_FAILED"
        );
    }
    assert_eq!(
        b.count("SELECT count(*) FROM bank.destination_fraud_list"),
        0
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.destination_fraud_list_history"),
        0
    );
}

#[test]
fn refuses_a_listing_that_is_not_an_evm_address_since_it_would_be_stored_and_match_nothing() {
    let Some(b) = fraud_bank() else { return };
    for address in [
        "not-an-address".to_owned(),
        format!("0X{}", &LISTED[2..]),
        format!("{LISTED}00"),
    ] {
        assert_eq!(
            list_change(&b, "*", &address, true, 0, REASON).trpc(),
            "BAD_REQUEST",
            "{address}"
        );
    }
    assert_eq!(
        b.count("SELECT count(*) FROM bank.destination_fraud_list"),
        0
    );
}

#[test]
fn the_history_refuses_a_truncate_as_well_as_edits() {
    let Some(b) = fraud_bank() else { return };
    let e = b
        .client()
        .batch_execute("TRUNCATE bank.destination_fraud_list_history")
        .unwrap_err();
    assert!(format!("{e:?}").contains("append-only"), "{e:?}");
}

#[test]
fn a_list_that_cannot_be_read_refuses_the_save_rather_than_assuming_the_address_is_safe() {
    // A database with no fraud list table: every read of the list fails.
    let Some(broken) = TestDb::new() else { return };
    assert_eq!(
        code_of(fraud::is_listed(
            &mut broken.client(),
            Some("ethereum"),
            CLEAN
        )),
        "bank.destination_fraud_list_unreadable"
    );
}

#[test]
fn keys_an_evm_address_in_lower_case_and_any_other_address_exactly_as_written() {
    assert_eq!(
        ramps::refs::address_key(" 0x7E5700000000000000000000000000000000FA1D "),
        "0x7e5700000000000000000000000000000000fa1d"
    );
    assert_eq!(ramps::refs::address_key("bc1QxyZ"), "bc1QxyZ");
}

#[test]
fn takes_star_or_a_network_id_and_refuses_anything_else() {
    assert_eq!(
        ramps::refs::network_key(ramps::refs::ANY_NETWORK).unwrap(),
        "*"
    );
    assert_eq!(ramps::refs::network_key("Ethereum").unwrap(), "ethereum");
    assert!(ramps::refs::network_key("eth net").is_err());
}

#[test]
fn binds_an_approval_to_the_normalised_change_the_next_revision_and_the_reason() {
    let fields = fraud::fields(&fraud::Change {
        network: "Base",
        address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
        listed: true,
        expected_revision: 2,
        reason: " TEST: reported scam ",
    })
    .unwrap();
    let kv: Vec<(&str, &str)> = fields
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        kv,
        vec![
            ("network", "base"),
            ("address", "0xabcdef0123456789abcdef0123456789abcdef01"),
            ("listed", "true"),
            ("revision", "3"),
            ("reason", "TEST: reported scam"),
        ]
    );
}

#[test]
fn an_empty_list_lists_nothing_a_listing_matches_its_network_or_every_network() {
    let Some(b) = fraud_bank() else { return };
    let mut c = b.client();
    assert!(!fraud::is_listed(&mut c, Some("ethereum"), LISTED).unwrap());
    list_change(&b, "*", &upper_hex(LISTED), true, 0, REASON).ok();
    list_change(&b, "base", ADDR_A, true, 0, REASON).ok();
    assert!(fraud::is_listed(&mut c, Some("ethereum"), LISTED).unwrap());
    assert!(fraud::is_listed(&mut c, Some("base"), ADDR_A).unwrap());
    assert!(!fraud::is_listed(&mut c, Some("ethereum"), ADDR_A).unwrap());
    // An entry with no network matches any listing.
    assert!(fraud::is_listed(&mut c, None, ADDR_A).unwrap());
}

// ---------------------------------------------------------------------------------------------------------------
// ramps/sanctions-list.test.ts: saving a withdrawal address against the sanctions list (J-wallet-05 #2)

fn sanctioned(raw: Option<&str>) -> Settings {
    Settings {
        destination_sanctions: raw.map(str::to_owned),
        ..owner()
    }
}

fn eth_save(door: &BankDoor, user: &str, r: &str) -> Answer {
    call(
        door,
        user,
        "ramps.destinations.save",
        &wallet(r, "ethereum"),
    )
}

#[test]
fn refuses_every_save_while_the_owner_setting_is_blank_and_saves_nothing() {
    let Some(b) = fraud_bank() else { return };
    let u = fresh();
    for raw in [None, Some(""), Some("not a list")] {
        let door = b.reopened(sanctioned(raw));
        assert_eq!(
            eth_save(&door, &u, CLEAN).code(),
            "bank.destination_sanctions_unset",
            "{raw:?}"
        );
        assert!(b.rows(&u).is_empty());
    }
}

#[test]
fn reads_the_setting_as_it_stands_at_each_save() {
    let Some(b) = fraud_bank() else { return };
    let u = fresh();
    assert_eq!(
        eth_save(&b.reopened(sanctioned(None)), &u, CLEAN).code(),
        "bank.destination_sanctions_unset"
    );
    eth_save(
        &b.reopened(sanctioned(Some(&format!("ethereum:{LISTED}")))),
        &u,
        CLEAN,
    )
    .ok();
    assert_eq!(b.rows(&u).len(), 1);
}

#[test]
fn refuses_a_listed_address_by_name_however_its_case_is_typed_and_saves_nothing() {
    let Some(b) = fraud_bank() else { return };
    let u = fresh();
    let door = b.reopened(sanctioned(Some(&format!("ethereum:{LISTED}"))));
    for r in [LISTED.to_owned(), upper_hex(LISTED)] {
        assert_eq!(
            eth_save(&door, &u, &r).code(),
            "bank.destination_sanctions_listed"
        );
    }
    assert!(b.rows(&u).is_empty());
}

#[test]
fn refuses_the_check_before_the_confirmation_code_as_the_save_would() {
    let Some(b) = fraud_bank() else { return };
    let u = fresh();
    let door = b.reopened(sanctioned(Some(&format!("ethereum:{LISTED}"))));
    let checked = |door: &BankDoor, r: &str| {
        call(
            door,
            &u,
            "ramps.destinations.check",
            &obj(&[("ref", s(r)), ("network", s("ethereum"))]),
        )
    };
    assert_eq!(
        checked(&door, LISTED).code(),
        "bank.destination_sanctions_listed"
    );
    assert_eq!(text(&checked(&door, CLEAN).ok(), "address"), "ok");
    assert_eq!(
        checked(&b.reopened(sanctioned(None)), CLEAN).code(),
        "bank.destination_sanctions_unset"
    );
}

#[test]
fn refuses_saving_again_an_entry_saved_before_it_was_listed_rather_than_answering_the_replay() {
    let Some(b) = fraud_bank() else { return };
    let u = fresh();
    let first = wallet(LISTED, "ethereum");
    call(&b.door, &u, "ramps.destinations.save", &first).ok();
    let listed = b.reopened(sanctioned(Some(&format!("*:{LISTED}"))));
    assert_eq!(
        call(&listed, &u, "ramps.destinations.save", &first).code(),
        "bank.destination_sanctions_listed"
    );
    assert_eq!(b.rows(&u).len(), 1);
}

// ---------------------------------------------------------------------------------------------------------------
// ramps/send-destination.test.ts: whether money may be sent to an address on a network now (J-wallet-05 #6)

const SEND_ADDRESS: &str = "0x52908400098527886E0F7030069857D2E4169EE7";
const SEND_UNLOCKS_AT: &str = "2026-10-25T08:00:00.000Z";
const HOUR: i64 = 3_600_000;

fn send_owner(hours: Option<&str>, sanctions: Option<&str>) -> Settings {
    Settings {
        offramp_cooling_hours: hours.map(str::to_owned),
        destination_sanctions: sanctions.map(str::to_owned),
        ..owner()
    }
}

/// The send suite's bank: USDT on ethereum and base, a 24-hour cooling-off.
fn send_bank() -> Option<Bank> {
    let b = bank_with(send_owner(Some("24"), Some(SANCTIONS)))?;
    b.registry.set(Some(vec![registry_row(
        "USDT",
        &["ethereum", "base"],
        &["deposit", "withdraw"],
    )]));
    Some(b)
}

fn send_entry(network: &str, tag: Option<&str>) -> Json {
    let mut fields = vec![
        ("assetId", s("USDT")),
        ("network", s(network)),
        ("ref", s(SEND_ADDRESS)),
        ("label", s("TEST send wallet")),
    ];
    if let Some(t) = tag {
        fields.push(("tag", s(t)));
    }
    obj(&fields)
}

/// Saved and approved 25 hours ago: past a 24-hour cooling-off. The approval's time is set back as the TypeScript's
/// injected clock sets it.
fn ready_entry(b: &Bank, user: &str, network: &str, tag: Option<&str>) -> String {
    let id = text(
        &call(
            &b.door,
            user,
            "ramps.destinations.save",
            &send_entry(network, tag),
        )
        .ok(),
        "destinationId",
    );
    store::approve(&mut b.client(), user, &id, "link").unwrap();
    b.client()
        .execute(
            "UPDATE bank.user_withdraw_destinations SET approved_at = now() - interval '25 hours', \
             updated_at = now() - interval '25 hours' WHERE destination_id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    id
}

fn sendable(door: &BankDoor, user: &str, asset: &str, network: &str, r: &str) -> Answer {
    call_service(
        door,
        "svc-pay",
        "ramps.destinations.sendable",
        &obj(&[
            ("userId", s(user)),
            ("assetId", s(asset)),
            ("network", s(network)),
            ("ref", s(r)),
        ]),
    )
}

fn ask(door: &BankDoor, user: &str) -> Answer {
    sendable(door, user, "USDT", "ethereum", SEND_ADDRESS)
}

fn answer_of(state: &str, id: Option<&str>, ends: Option<&str>) -> String {
    obj(&[
        ("state", s(state)),
        ("destinationId", id.map_or(Json::Null, Json::str)),
        ("coolingOffEndsAt", ends.map_or(Json::Null, Json::str)),
    ])
    .compact()
}

#[test]
fn answers_ready_for_a_saved_approved_entry_past_its_cooling_off_on_that_network_whatever_the_letter_case()
 {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    let id = ready_entry(&b, &u, "ethereum", None);
    assert_eq!(
        ask(&b.door, &u).ok().compact(),
        answer_of("ready", Some(&id), None)
    );
    let lower = sendable(
        &b.door,
        &u,
        "usdt",
        "ethereum",
        &SEND_ADDRESS.to_lowercase(),
    )
    .ok();
    assert_eq!(
        (text(&lower, "state"), text(&lower, "destinationId")),
        ("ready".to_owned(), id)
    );
}

#[test]
fn answers_other_network_when_the_address_is_saved_for_the_asset_only_on_another_network() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    ready_entry(&b, &u, "ethereum", None);
    assert_eq!(
        sendable(&b.door, &u, "USDT", "base", SEND_ADDRESS)
            .ok()
            .compact(),
        answer_of("other_network", None, None)
    );
}

#[test]
fn answers_not_saved_for_an_address_not_in_the_book_another_asset_or_another_person() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    ready_entry(&b, &u, "ethereum", None);
    let not_saved = answer_of("not_saved", None, None);
    assert_eq!(
        sendable(&b.door, &u, "USDT", "ethereum", EVM)
            .ok()
            .compact(),
        not_saved
    );
    assert_eq!(
        sendable(&b.door, &u, "ETH", "ethereum", SEND_ADDRESS)
            .ok()
            .compact(),
        not_saved
    );
    assert_eq!(ask(&b.door, &fresh()).ok().compact(), not_saved);
}

#[test]
fn does_not_match_an_entry_saved_with_a_tag_since_a_send_carries_none() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    ready_entry(&b, &u, "ethereum", Some("memo-1"));
    assert_eq!(text(&ask(&b.door, &u).ok(), "state"), "not_saved");
    // Nor does it count as saved on another network: switching networks would still find no tagless entry.
    let v = fresh();
    ready_entry(&b, &v, "base", Some("memo-1"));
    assert_eq!(text(&ask(&b.door, &v).ok(), "state"), "not_saved");
}

#[test]
fn answers_approval_pending_for_a_saved_entry_not_approved_yet() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    call(
        &b.door,
        &u,
        "ramps.destinations.save",
        &send_entry("ethereum", None),
    )
    .ok();
    assert_eq!(text(&ask(&b.door, &u).ok(), "state"), "approval_pending");
}

#[test]
fn answers_cooling_with_its_end_inside_the_cooling_off_and_cooling_unset_when_none_is_published() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    let id = text(
        &call(
            &b.door,
            &u,
            "ramps.destinations.save",
            &send_entry("ethereum", None),
        )
        .ok(),
        "destinationId",
    );
    let approved = store::approve(&mut b.client(), &u, &id, "link").unwrap();
    let ends = Instant(approved.updated_at.0 + 24 * HOUR).iso();
    assert_eq!(
        ask(&b.door, &u).ok().compact(),
        answer_of("cooling", Some(&id), Some(&ends))
    );
    let v = fresh();
    ready_entry(&b, &v, "ethereum", None);
    let unset = b.reopened(send_owner(Some(""), Some(SANCTIONS)));
    assert_eq!(text(&ask(&unset, &v).ok(), "state"), "cooling_unset");
}

#[test]
fn answers_locked_while_the_security_lock_holds_and_refuses_when_the_lock_cannot_be_read() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    ready_entry(&b, &u, "ethereum", None);
    b.lock.0.set_lock(
        &u,
        LockState {
            locked: true,
            unlocks_at: Some(SEND_UNLOCKS_AT.to_owned()),
            self_frozen: false,
        },
    );
    assert_eq!(text(&ask(&b.door, &u).ok(), "state"), "locked");
    b.lock.fail_with(Some(refuse(
        "bank.security_lock_unavailable",
        "identity is down",
    )));
    assert_eq!(ask(&b.door, &u).code(), "bank.security_lock_unavailable");
}

#[test]
fn answers_blocked_for_a_saved_ready_entry_whose_address_is_put_on_the_fraud_list_afterwards() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    let id = ready_entry(&b, &u, "ethereum", None);
    list_change(&b, "*", SEND_ADDRESS, true, 0, REASON).ok();
    let a = ask(&b.door, &u).ok();
    assert_eq!(
        (text(&a, "state"), text(&a, "destinationId")),
        ("blocked".to_owned(), id)
    );
}

#[test]
fn answers_blocked_for_a_saved_ready_entry_whose_address_is_sanctioned_afterwards() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    let id = ready_entry(&b, &u, "ethereum", None);
    let listed = b.reopened(send_owner(
        Some("24"),
        Some(&format!("ethereum:{}", SEND_ADDRESS.to_lowercase())),
    ));
    let a = ask(&listed, &u).ok();
    assert_eq!(
        (text(&a, "state"), text(&a, "destinationId")),
        ("blocked".to_owned(), id)
    );
}

#[test]
fn answers_blocked_for_a_saved_ready_entry_once_the_sanctions_list_is_unset_nothing_is_screened_so_nothing_is_sent()
 {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    let id = ready_entry(&b, &u, "ethereum", None);
    let unset = b.reopened(send_owner(Some("24"), None));
    let a = ask(&unset, &u).ok();
    assert_eq!(
        (text(&a, "state"), text(&a, "destinationId")),
        ("blocked".to_owned(), id)
    );
}

#[test]
fn never_answers_ready_for_a_removed_entry() {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    let id = ready_entry(&b, &u, "ethereum", None);
    call(
        &b.door,
        &u,
        "ramps.destinations.remove",
        &obj(&[
            ("destinationId", s(&id)),
            ("idempotencyKey", Json::str(format!("remove:{id}"))),
        ]),
    )
    .ok();
    assert_eq!(text(&ask(&b.door, &u).ok(), "state"), "not_saved");
}

// the sendable door

#[test]
fn answers_svc_pay_and_serves_svc_pay_only_another_service_is_forbidden_and_no_service_is_unauthorized()
 {
    let Some(b) = send_bank() else { return };
    let u = fresh();
    assert_eq!(text(&ask(&b.door, &u).ok(), "state"), "not_saved");
    let input = obj(&[
        ("userId", s(&u)),
        ("assetId", s("USDT")),
        ("network", s("ethereum")),
        ("ref", s(SEND_ADDRESS)),
    ]);
    assert_eq!(
        call_service(&b.door, "svc-tax", "ramps.destinations.sendable", &input).trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        send(
            &b.door,
            "ramps.destinations.sendable",
            Some(&input.compact()),
            Vec::new()
        )
        .trpc(),
        "UNAUTHORIZED"
    );
}

#[test]
fn refuses_an_input_with_a_field_it_does_not_name() {
    let Some(b) = send_bank() else { return };
    let input = obj(&[
        ("userId", s(&fresh())),
        ("assetId", s("USDT")),
        ("network", s("ethereum")),
        ("ref", s(SEND_ADDRESS)),
        ("tag", s("memo")),
    ]);
    assert_eq!(
        call_service(&b.door, "svc-pay", "ramps.destinations.sendable", &input).trpc(),
        "BAD_REQUEST"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// security-lock.money.test.ts: the address book while the security lock holds, and whether a saved address can be used

const LOCK_USER: &str = CUSTOMER;
const LOCK_OTHER: &str = "44444444-4444-4444-8444-444444444444";
const UNLOCKS_AT: &str = "2026-10-25T08:00:00.000Z";

fn lock_state(locked: bool, self_frozen: bool) -> LockState {
    LockState {
        locked,
        unlocks_at: locked.then(|| UNLOCKS_AT.to_owned()),
        self_frozen,
    }
}

fn lock_entry() -> Json {
    obj(&book_entry(BOOK_ADDRESS, "TEST cold wallet"))
}

/// A bank whose cooling-off is 24 hours, and a fresh user of its own database.
fn lock_bank() -> Option<Bank> {
    bank_with(send_owner(Some("24"), Some(SANCTIONS)))
}

#[test]
fn refuses_adding_an_address_and_the_book_is_unchanged() {
    let Some(b) = lock_bank() else { return };
    b.lock.0.set_lock(LOCK_USER, lock_state(true, false));
    assert_eq!(
        call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).code(),
        "bank.security_locked"
    );
    assert_eq!(
        call(
            &b.door,
            LOCK_USER,
            "ramps.destinations.check",
            &obj(&[("ref", s(BOOK_ADDRESS))])
        )
        .code(),
        "bank.security_locked"
    );
    assert!(b.rows(LOCK_USER).is_empty());
}

#[test]
fn refuses_adding_an_address_while_the_owner_froze_the_account_and_the_book_is_unchanged() {
    let Some(b) = lock_bank() else { return };
    b.lock.0.set_lock(LOCK_USER, lock_state(false, true));
    assert_eq!(
        call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).code(),
        "bank.account_frozen_self"
    );
    assert!(b.rows(LOCK_USER).is_empty());
}

#[test]
fn answers_a_replay_of_a_save_made_before_the_lock_as_before_and_adds_nothing_new() {
    let Some(b) = lock_bank() else { return };
    let saved = call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).ok();
    b.lock.0.set_lock(LOCK_USER, lock_state(true, false));
    let lower = obj(&book_entry(
        &BOOK_ADDRESS.to_lowercase(),
        "TEST cold wallet",
    ));
    assert_eq!(
        text(
            &call(&b.door, LOCK_USER, "ramps.destinations.save", &lower).ok(),
            "destinationId"
        ),
        text(&saved, "destinationId")
    );
    let tagged = with(
        book_entry(BOOK_ADDRESS, "TEST other"),
        &[("tag", s("memo-1"))],
    );
    assert_eq!(
        call(&b.door, LOCK_USER, "ramps.destinations.save", &tagged).code(),
        "bank.security_locked"
    );
    let ids: Vec<String> = b
        .rows(LOCK_USER)
        .into_iter()
        .map(|r| r.destination_id)
        .collect();
    assert_eq!(ids, vec![text(&saved, "destinationId")]);
}

#[test]
fn still_removes_an_address_removing_only_takes_a_way_out_away() {
    let Some(b) = lock_bank() else { return };
    let id = text(
        &call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).ok(),
        "destinationId",
    );
    b.lock.0.set_lock(LOCK_USER, lock_state(true, false));
    let removed = call(
        &b.door,
        LOCK_USER,
        "ramps.destinations.remove",
        &obj(&[
            ("destinationId", s(&id)),
            (
                "idempotencyKey",
                Json::str(format!("destination-remove:{id}")),
            ),
        ]),
    )
    .ok();
    assert_eq!(
        removed.compact(),
        obj(&[("destinationId", s(&id)), ("removed", Json::Bool(true))]).compact()
    );
    assert!(b.rows(LOCK_USER).is_empty());
}

#[test]
fn still_renames_a_label_cannot_change_where_money_goes() {
    let Some(b) = lock_bank() else { return };
    let id = text(
        &call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).ok(),
        "destinationId",
    );
    b.lock.0.set_lock(LOCK_USER, lock_state(true, false));
    let renamed = call(
        &b.door,
        LOCK_USER,
        "ramps.destinations.rename",
        &obj(&[("destinationId", s(&id)), ("label", s("TEST renamed"))]),
    )
    .ok();
    assert_eq!(text(&renamed, "label"), "TEST renamed");
}

#[test]
fn refuses_every_change_when_identity_cannot_be_read_and_stores_nothing() {
    let Some(b) = lock_bank() else { return };
    b.lock.fail_with(Some(refuse(
        "bank.security_lock_unavailable",
        "identity is down",
    )));
    assert_eq!(
        call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).code(),
        "bank.security_lock_unavailable"
    );
    assert!(b.rows(LOCK_USER).is_empty());
}

#[test]
fn refuses_every_change_on_a_deployment_that_cannot_read_the_lock() {
    let Some(b) = lock_bank() else { return };
    let door = b.with_lock(&Lock::unwired());
    assert_eq!(
        call(&door, LOCK_USER, "ramps.destinations.save", &lock_entry()).code(),
        "bank.security_lock_unset"
    );
    assert!(b.rows(LOCK_USER).is_empty());
}

#[test]
fn reads_the_lock_of_the_caller_not_of_anyone_else() {
    let Some(b) = lock_bank() else { return };
    b.lock.0.set_lock(LOCK_OTHER, lock_state(true, false));
    let saved = call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).ok();
    assert_eq!(text(&saved, "label"), "TEST cold wallet");
    let asked = b.lock.0.asked();
    assert!(
        !asked.is_empty() && asked.iter().all(|u| u == LOCK_USER),
        "{asked:?}"
    );
}

fn readiness(door: &BankDoor, user: &str, id: &str) -> Answer {
    call(
        door,
        user,
        "ramps.destinations.readiness",
        &obj(&[("destinationId", s(id))]),
    )
}

fn readiness_of(id: &str, state: &str) -> String {
    obj(&[
        ("destinationId", s(id)),
        ("state", s(state)),
        ("coolingOffEndsAt", Json::Null),
        ("lockUnlocksAt", Json::Null),
        ("approvalLinkExpiresAt", Json::Null),
    ])
    .compact()
}

/// Saved, then approved by its emailed link: its cooling-off runs from the approval (W-withdraw-09); `ago` sets the
/// approval back as the TypeScript's clock does.
fn approved_entry(b: &Bank, ago_hours: i64) -> String {
    let id = text(
        &call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).ok(),
        "destinationId",
    );
    store::approve(&mut b.client(), LOCK_USER, &id, "link").unwrap();
    b.client()
        .execute(
            "UPDATE bank.user_withdraw_destinations SET approved_at = approved_at - make_interval(hours => $2::int4), \
             updated_at = updated_at - make_interval(hours => $2::int4) WHERE destination_id = $1::text::uuid",
            &[&id, &i32::try_from(ago_hours).unwrap()],
        )
        .unwrap();
    id
}

#[test]
fn says_approval_pending_for_a_new_address_until_it_is_approved_with_until_when_an_emailed_link_works()
 {
    let Some(b) = lock_bank() else { return };
    let saved = call(&b.door, LOCK_USER, "ramps.destinations.save", &lock_entry()).ok();
    let id = text(&saved, "destinationId");
    for (k, v) in [
        ("state", "pending"),
        ("coolingOffEndsAt", "null"),
        ("approvalLinkExpiresAt", "null"),
    ] {
        assert_eq!(text(&saved, k), v, "{k}");
    }
    assert_eq!(
        readiness(&b.door, LOCK_USER, &id).ok().compact(),
        readiness_of(&id, "approval_pending")
    );
    store::approve(&mut b.client(), LOCK_USER, &id, "link").unwrap();
    assert_eq!(
        text(&readiness(&b.door, LOCK_USER, &id).ok(), "state"),
        "cooling"
    );
}

#[test]
fn says_cooling_with_the_end_of_the_cooling_off_for_an_address_saved_just_now() {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 0);
    let approved_at = b.rows(LOCK_USER)[0].updated_at;
    let answer = readiness(&b.door, LOCK_USER, &id).ok();
    assert_eq!(text(&answer, "state"), "cooling");
    assert_eq!(
        text(&answer, "coolingOffEndsAt"),
        Instant(approved_at.0 + 24 * HOUR).iso()
    );
    assert_eq!(text(&answer, "lockUnlocksAt"), "null");
}

#[test]
fn says_ready_once_the_cooling_off_has_ended() {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 25);
    assert_eq!(
        text(&readiness(&b.door, LOCK_USER, &id).ok(), "state"),
        "ready"
    );
}

#[test]
fn says_cooling_unset_while_no_cooling_off_period_is_published_and_invents_none() {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 25);
    let unset = b.reopened(send_owner(Some(""), Some(SANCTIONS)));
    assert_eq!(
        readiness(&unset, LOCK_USER, &id).ok().compact(),
        readiness_of(&id, "cooling_unset")
    );
}

#[test]
fn says_cooling_with_no_end_when_the_published_period_runs_past_any_date_as_the_send_path_refuses_it()
 {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 0);
    let forever = b.reopened(send_owner(Some("99999999999999"), Some(SANCTIONS)));
    assert_eq!(
        readiness(&forever, LOCK_USER, &id).ok().compact(),
        readiness_of(&id, "cooling")
    );
}

#[test]
fn puts_the_security_lock_first_with_when_it_ends() {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 25);
    b.lock.0.set_lock(LOCK_USER, lock_state(true, false));
    let a = readiness(&b.door, LOCK_USER, &id).ok();
    assert_eq!(
        (text(&a, "state"), text(&a, "lockUnlocksAt")),
        ("locked".to_owned(), UNLOCKS_AT.to_owned())
    );
}

#[test]
fn reads_a_self_frozen_account_as_locked_with_no_end_so_the_address_is_not_ready() {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 25);
    b.lock.0.set_lock(LOCK_USER, lock_state(false, true));
    let a = readiness(&b.door, LOCK_USER, &id).ok();
    assert_eq!(
        (text(&a, "state"), text(&a, "lockUnlocksAt")),
        ("locked".to_owned(), "null".to_owned())
    );
}

#[test]
fn does_not_answer_for_an_address_that_is_someone_elses_or_not_in_the_book() {
    let Some(b) = lock_bank() else { return };
    let id = approved_entry(&b, 0);
    assert_eq!(
        readiness(&b.door, LOCK_OTHER, &id).code(),
        "bank.withdraw_destination_missing"
    );
    assert_eq!(
        readiness(&b.door, LOCK_USER, &uuid()).code(),
        "bank.withdraw_destination_missing"
    );
}

// ramps/customer-ramps-deposits.test.ts: the saved destinations' list and remove

#[test]
fn lists_saved_destinations_with_label_and_cooling_end_and_remove_replays_by_idempotency_key() {
    let Some(b) = lock_bank() else { return };
    let (user, other) = (fresh(), fresh());
    // The off-ramp's legacy slots, as `setWithdrawDestination` writes them.
    store::persist(
        &mut b.client(),
        None,
        &user,
        "crypto",
        EVM,
        Some("Holiday wallet"),
    )
    .unwrap();
    store::persist(&mut b.client(), None, &user, "bank", IBAN, None).unwrap();
    let listed = list_as(&b.door, &user, STEPPED);
    let mut kinds: Vec<String> = listed.iter().map(|r| text(r, "kind")).collect();
    kinds.sort();
    assert_eq!(kinds, vec!["bank", "crypto"]);
    let crypto = listed
        .iter()
        .find(|r| text(r, "kind") == "crypto")
        .unwrap()
        .clone();
    assert_eq!(
        (
            text(&crypto, "label"),
            text(&crypto, "ref"),
            text(&crypto, "coolingBlocker")
        ),
        (
            "Holiday wallet".to_owned(),
            EVM.to_owned(),
            "null".to_owned()
        )
    );
    let id = text(&crypto, "destinationId");
    let stored = b
        .rows(&user)
        .into_iter()
        .find(|r| r.destination_id == id)
        .unwrap()
        .updated_at;
    assert_eq!(
        at(&text(&crypto, "coolingOffEndsAt")).0 - stored.0,
        24 * HOUR
    );

    let unpublished = b.reopened(send_owner(None, Some(SANCTIONS)));
    let row = list_as(&unpublished, &user, STEPPED)
        .into_iter()
        .find(|r| text(r, "kind") == "crypto")
        .unwrap();
    assert_eq!(
        (text(&row, "coolingOffEndsAt"), text(&row, "coolingBlocker")),
        ("null".to_owned(), "bank.offramp_cooling_unset".to_owned())
    );

    let remove = |who: &str, key: &str| {
        call(
            &b.door,
            who,
            "ramps.destinations.remove",
            &obj(&[("destinationId", s(&id)), ("idempotencyKey", s(key))]),
        )
    };
    assert_eq!(
        remove(&other, &uuid()).code(),
        "bank.withdraw_destination_missing"
    );
    assert!(
        list_as(&b.door, &user, STEPPED)
            .iter()
            .any(|r| text(r, "destinationId") == id)
    );
    let key = uuid();
    let removed = remove(&user, &key).ok();
    assert_eq!(
        removed.compact(),
        obj(&[("destinationId", s(&id)), ("removed", Json::Bool(true))]).compact()
    );
    assert_eq!(remove(&user, &key).ok().compact(), removed.compact());
    assert_eq!(
        remove(&user, &uuid()).code(),
        "bank.withdraw_destination_missing"
    );
    let left: Vec<String> = list_as(&b.door, &user, STEPPED)
        .iter()
        .map(|r| text(r, "kind"))
        .collect();
    assert_eq!(left, vec!["bank"]);
}
