//! The step-up on slice `transfers`' money-out doors, against the Rust door on a real Postgres. Ports the door-level
//! checks of `step-up/step-up-money-out.test.ts` ("flag required: sends to other users", "flag required:
//! transfers.create / schedule / scheduleToUser", and the transfers doors of "flag off (the default)") and the
//! transfers sends of `step-up/door-parity.test.ts`, each test named after the TypeScript test's words. The gate's own
//! cases are `src/transfers/step_up.rs`' unit tests; the mode's values are `tests/env_parity.rs`'.
//!
//! Where the TypeScript counts calls into a mocked service ("never reaches the service"), this counts what the service
//! would have written: the stand-in ledger's posts and the slice's own rows. Identity is a faithful stand-in for its
//! same-person consume (CAS once; user, session, hash and expiry). Without `TEST_DATABASE_URL` each DB test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::{
    AccountOf, ExtraControls, Extras, HandleUnavailable, LockState, MemoryIdentity, PartyHandles,
    RecipientState, RecipientUnavailable, SecurityLock,
};
use svc_bank::transfers::step_up::{self, Binding, CreateTransfer, Schedule, ToUser, payload_hash};
use svc_bank::transfers::{Approvals, Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-step-up-money-out-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-step-up-money-out-internal-secret-long";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "99999999-9999-4999-8999-999999999999";
const SID: &str = "22222222-2222-4222-8222-222222222222";
const SID2: &str = "23232323-2222-4222-8222-222222222222";
const TRANSFER: &str = "transfer-0001";
const TRANSFER_2: &str = "transfer-0002";
const TO_USER: &str = "bank.step_up.transfers.toUser";
/// A start in the future of any run of this suite, so a standing order is accepted.
const START: &str = "2099-11-01T00:00:00.000Z";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins: svc-ledger's book (`bankTransfer` only), svc-identity's reads and its consume, the directory, the freeze.

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
}

#[derive(Clone, Default)]
struct Book(Arc<Mutex<BookState>>);

fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
    )
}

fn acct_id(a: &Acct) -> String {
    format!("acct:{}:{}:{}:{}", a.0, a.1, a.2, a.3)
}

fn acct_of(j: &Json) -> Acct {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    };
    (s("ownerType"), s("ownerId"), s("assetId"), s("kind"))
}

impl Book {
    /// Money in to a named space.
    fn fund_space(&self, space: &str, amount: &str) {
        let key = (
            "subaccount".to_owned(),
            space.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn posts(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    fn keys(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .journal
            .iter()
            .map(|(k, _)| k.clone())
            .collect()
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
            .get(&acct(a))
            .copied()
            .unwrap_or(0))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .balances
            .iter()
            .filter(|(k, _)| k.0 == owner_type && k.1 == owner)
            .map(|(k, v)| LedgerBalance {
                asset_id: k.2.clone(),
                kind: k.3.clone(),
                purpose: String::new(),
                amount: *v,
            })
            .collect())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("no registry".to_owned())
    }
    fn account_id(&self, a: &LedgerAccount) -> Result<String, String> {
        Ok(acct_id(&acct(a)))
    }
    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(_, t)| t.id == tx_id)
            .map(|(_, t)| t.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, t)| t.clone()))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        assert_eq!(
            recipe, "bankTransfer",
            "the bank posts only bankTransfer here"
        );
        let mut st = self.0.lock().unwrap();
        if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
            return Ok(t.clone());
        }
        let from = acct_of(input.get("from").unwrap());
        let to = acct_of(input.get("to").unwrap());
        let amount = match input.get("amount") {
            Some(Json::String(a)) => amt(a),
            other => panic!("amount: {other:?}"),
        };
        let held = st.balances.get(&from).copied().unwrap_or(0);
        if held < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!(
                    "Insufficient funds: {} < {}",
                    format_amount(held),
                    format_amount(amount)
                ),
                attempts: 1,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= amount;
        *st.balances.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: door::system_now(),
            entries: vec![
                TxEntry {
                    account_id: acct_id(&from),
                    asset_id: from.2.clone(),
                    direction: "credit".to_owned(),
                    amount,
                },
                TxEntry {
                    account_id: acct_id(&to),
                    asset_id: to.2.clone(),
                    direction: "debit".to_owned(),
                    amount,
                },
            ],
        };
        st.journal.push((key.to_owned(), tx.clone()));
        Ok(tx)
    }
}

/// svc-identity's reads, shared between the test and the door.
#[derive(Clone, Default)]
struct Identity(Arc<MemoryIdentity>);

impl RecipientState for Identity {
    fn account_of(&self, user_id: &str) -> Result<Option<AccountOf>, RecipientUnavailable> {
        self.0.account_of(user_id)
    }
}
impl SecurityLock for Identity {
    fn read(&self, user_id: &str) -> Result<LockState, svc_bank::errors::Refusal> {
        SecurityLock::read(&*self.0, user_id)
    }
}
impl PartyHandles for Identity {
    fn handle_of(&self, user_id: &str) -> Result<Option<String>, HandleUnavailable> {
        self.0.handle_of(user_id)
    }
}
impl ExtraControls for Identity {
    fn read(&self, user_id: &str) -> Result<Extras, svc_bank::errors::Refusal> {
        ExtraControls::read(&*self.0, user_id)
    }
}

struct Row {
    user_id: String,
    session_id: String,
    action_type: String,
    hash: String,
    expires_at: i64,
    consumed: bool,
    four_eyes: bool,
}

#[derive(Default)]
struct ApprovalsState {
    rows: BTreeMap<String, Row>,
    calls: usize,
    down: bool,
    timeout: bool,
}

/// `FakeIdentity`: a faithful stand-in for identity's same-person consume. CAS once, user + session + hash + expiry.
#[derive(Clone, Default)]
struct FakeIdentity(Arc<Mutex<ApprovalsState>>);

struct Approve<'a> {
    user_id: &'a str,
    session_id: &'a str,
    ttl_ms: i64,
    four_eyes: bool,
}

const MINE: Approve<'static> = Approve {
    user_id: USER,
    session_id: SID,
    ttl_ms: 300_000,
    four_eyes: false,
};

impl FakeIdentity {
    fn approve_with(&self, action: &str, fields: &[(String, String)], o: &Approve<'_>) -> String {
        let mut s = self.0.lock().unwrap();
        let id = format!("approval-{}", s.rows.len() + 1);
        s.rows.insert(
            id.clone(),
            Row {
                user_id: o.user_id.to_owned(),
                session_id: o.session_id.to_owned(),
                action_type: action.to_owned(),
                hash: payload_hash(action, fields),
                expires_at: door::system_now().0 + o.ttl_ms,
                consumed: false,
                four_eyes: o.four_eyes,
            },
        );
        id
    }
    fn approve(&self, b: &Binding) -> String {
        self.approve_with(b.action_type, &b.fields, &MINE)
    }
    fn calls(&self) -> usize {
        self.0.lock().unwrap().calls
    }
    fn set_down(&self) {
        self.0.lock().unwrap().down = true;
    }
    fn set_timeout(&self) {
        self.0.lock().unwrap().timeout = true;
    }
}

impl Approvals for FakeIdentity {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut s = self.0.lock().unwrap();
        s.calls += 1;
        if s.down {
            return Err(ConsumeError::Thrown("fetch failed".to_owned()));
        }
        if s.timeout {
            return Err(ConsumeError::Thrown(
                "The operation was aborted due to timeout".to_owned(),
            ));
        }
        let refused = |code: &str| {
            Err(ConsumeError::Refused(format!(
                "identity refused consume (412) {{\"message\":\"x [action_approval.{code}]\"}}"
            )))
        };
        let now = door::system_now().0;
        let Some(row) = s.rows.get_mut(input.approval_id) else {
            return refused("not_found");
        };
        if now >= row.expires_at {
            return refused("expired");
        }
        if input.target_service != "svc-bank"
            || input.target_id != row.action_type
            || input.operation_id != input.approval_id
        {
            return refused("target_mismatch");
        }
        if row.hash != input.payload_hash {
            return refused("payload_mismatch");
        }
        let p = principal.expect("a same-person consume binds the person");
        if !row.four_eyes && (row.user_id != p.user_id || row.session_id != p.session_id) {
            return refused("not_requester");
        }
        if row.four_eyes {
            return refused("target_mismatch");
        }
        if row.consumed {
            return refused("consumed");
        }
        row.consumed = true;
        Ok((
            Consumed {
                action_type: row.action_type.clone(),
                target_service: "svc-bank".to_owned(),
                target_id: input.target_id.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: row.user_id.clone(),
                approver_id: Some(row.user_id.clone()),
                approver_is_founder: None,
                requester_is_founder: None,
            },
            Facts {
                kind: Some("same_person".to_owned()),
                expires_at: Instant(row.expires_at).iso(),
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
// The door and its calls

/// The fixture: the person's two spaces, another person's space, and identity, under the step-up mode.
struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    approvals: FakeIdentity,
    /// The person's named USDT space the money leaves from (`FROM`).
    from: String,
    /// Another named USDT space of the person's own (`OWN_TO`).
    own_to: String,
    /// The other person's named USDT space (`FOREIGN_TO`).
    foreign_to: String,
}

fn partner_wiring() -> PartnerWiring {
    PartnerWiring {
        partner: None,
        freeze: Box::new(Open),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    }
}

fn spaces_wiring(ledger: &Book) -> SpacesWiring {
    SpacesWiring {
        ledger: Box::new(ledger.clone()),
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
    }
}

/// How identity's consume is wired: the stand-in, or none (no `IDENTITY_URL`).
enum Consume<'a> {
    Fake(&'a FakeIdentity),
    Unwired,
}

fn transfers_wiring(identity: &Identity, consume: &Consume<'_>, required: bool) -> TransfersWiring {
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity.clone()));
    if let Consume::Fake(f) = consume {
        w.approvals = Box::new((*f).clone());
    }
    w.settings = Settings {
        step_up_required: required,
        schedule_edit_cutoff: Some("60".to_owned()),
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    };
    w
}

fn door_for(
    db: &TestDb,
    ledger: &Book,
    identity: &Identity,
    consume: &Consume<'_>,
    required: bool,
) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
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
    .with_partner(partner_wiring())
    .with_spaces(spaces_wiring(ledger))
    .with_transfers(transfers_wiring(identity, consume, required))
}

/// `fixture(mode)`: the spaces are real rows, the from-space holds 100 USDT, and personal sends have published terms.
fn fixture(required: bool) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let identity = Identity::default();
    let approvals = FakeIdentity::default();
    let door = door_for(
        &db,
        &ledger,
        &identity,
        &Consume::Fake(&approvals),
        required,
    );
    db.client()
        .execute(
            "INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) \
             VALUES ('USDT', 1000, 10000, 0)",
            &[],
        )
        .unwrap();
    let mut b = Bank {
        door,
        db,
        ledger,
        approvals,
        from: String::new(),
        own_to: String::new(),
        foreign_to: String::new(),
    };
    b.from = pot(&b, USER, "From");
    b.own_to = pot(&b, USER, "Own");
    b.foreign_to = pot(&b, OTHER, "Theirs");
    b.ledger.fund_space(&b.from, "100");
    Some(b)
}

impl Bank {
    fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
    /// What the send path writes: its reservation rows.
    fn sends(&self) -> i64 {
        self.count("SELECT count(*) FROM bank.personal_transfers")
    }
    /// Nothing reached the service: no post on the book and no send row.
    fn untouched(&self) {
        assert_eq!(
            self.ledger.posts(),
            0,
            "a post reached the ledger: {:?}",
            self.ledger.keys()
        );
        assert_eq!(self.sends(), 0, "a send was reserved");
    }
}

fn principal(user: &str, sid: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str(sid)),
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
            (status, _) => panic!("no refusal code: {status} {}", self.1.compact()),
        }
    }
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

fn send_on(door: &BankDoor, path: &str, input: &str, mut headers: Vec<(String, String)>) -> Answer {
    let (method, url, body) = match door::call(path).map(|c| c.kind) {
        Some(Kind::Query) => (
            "GET",
            format!("/trpc/{path}?input={}", encode(input)),
            String::new(),
        ),
        _ => ("POST", format!("/trpc/{path}"), input.to_owned()),
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
        "req-step-up-money-out",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap())
}

/// A call as the person, in their first session.
fn call(b: &Bank, path: &str, input: &str) -> Answer {
    send_on(
        &b.door,
        path,
        input,
        principal(USER, SID, &["bank:read", "bank:write"]),
    )
}

fn text(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

/// `spaces.create` as `user`.
fn pot(b: &Bank, user: &str, name: &str) -> String {
    let a = send_on(
        &b.door,
        "spaces.create",
        &format!(r#"{{"assetId":"USDT","name":"{name}"}}"#),
        principal(user, SID, &["bank:read", "bank:write"]),
    );
    text(&a.ok(), "id")
}

/// `toUserInput`, with any field changed and the approval named.
fn to_user_input(
    b: &Bank,
    transfer: &str,
    to: &str,
    amount: &str,
    extra: &str,
    approval: Option<&str>,
) -> String {
    let approval = approval.map_or(String::new(), |a| format!(r#","stepUpApprovalId":"{a}""#));
    format!(
        r#"{{"transferId":"{transfer}","fromSpaceId":"{}","toUserId":"{to}","amount":"{amount}"{extra}{approval}}}"#,
        b.from
    )
}

/// `toUserFields`: what the person approves for the send of `toUserInput`.
fn to_user_fields(
    b: &Bank,
    transfer: &str,
    to: &str,
    asset: &str,
    amount: &str,
    note: Option<&str>,
) -> Binding {
    step_up::to_user_binding(&ToUser {
        actor: USER,
        transfer_id: transfer,
        from_space_id: &b.from,
        to_user_id: to,
        asset_id: asset,
        amount,
        note,
        reference: None,
        request_id: None,
    })
}

fn base(b: &Bank) -> Binding {
    to_user_fields(b, TRANSFER, OTHER, "USDT", "5", None)
}

fn to_user(b: &Bank, approval: Option<&str>) -> Answer {
    call(
        b,
        "transfers.toUser",
        &to_user_input(b, TRANSFER, OTHER, "5", "", approval),
    )
}

/// A refusal of the gate, by its code and tRPC code.
fn refused(a: &Answer, code: &str, trpc: &str) {
    assert_eq!(
        (a.code(), a.trpc()),
        (code.to_owned(), trpc.to_owned()),
        "{}",
        a.1.compact()
    );
    assert!(a.message().contains(code), "{}", a.message());
}

// ---------------------------------------------------------------------------------------------------------------
// step-up/step-up-money-out.test.ts: flag required: sends to other users

/// "transfers.toUser with a note reaches personalPay and not the space-transfer path"
#[test]
fn transfers_to_user_with_a_note_reaches_personal_pay_and_not_the_space_transfer_path() {
    let Some(b) = fixture(true) else { return };
    let id = b.approvals.approve(&to_user_fields(
        &b,
        TRANSFER,
        OTHER,
        "USDT",
        "5",
        Some("October rent"),
    ));
    let a = call(
        &b,
        "transfers.toUser",
        &to_user_input(
            &b,
            TRANSFER,
            OTHER,
            "5",
            r#","note":"October rent""#,
            Some(&id),
        ),
    )
    .ok();
    assert_eq!(text(&a, "note"), "October rent");
    assert_eq!(text(&a, "reference"), "null");
    assert_ne!(text(&a, "ledgerTxId"), "null");
    // The person-to-person send's own key and row, never a move between spaces.
    assert_eq!(
        b.ledger.keys(),
        vec![format!("bank.transfer.p2p:{TRANSFER}:0")]
    );
    assert_eq!(b.sends(), 1);
}

/// "refuses without an approval, and never reaches the service"
#[test]
fn refuses_without_an_approval_and_never_reaches_the_service() {
    let Some(b) = fixture(true) else { return };
    refused(
        &to_user(&b, None),
        "bank.step_up_required",
        "PRECONDITION_FAILED",
    );
    b.untouched();
    assert_eq!(b.approvals.calls(), 0);
}

/// "accepts an approval for exactly this payload, then replays the same transferId without asking identity again"
#[test]
fn accepts_an_approval_for_exactly_this_payload_then_replays_the_same_transfer_id_without_asking_identity_again()
 {
    let Some(b) = fixture(true) else { return };
    let id = b.approvals.approve(&base(&b));
    let first = to_user(&b, Some(&id)).ok();
    let again = to_user(&b, Some(&id)).ok();
    assert_ne!(text(&first, "ledgerTxId"), "null");
    assert_eq!(text(&first, "ledgerTxId"), text(&again, "ledgerTxId"));
    // Both reached the send; it posted once, under its one key.
    assert_eq!(b.ledger.posts(), 1);
    assert_eq!(b.approvals.calls(), 1);
}

/// "a different %s than the one approved is a mismatch and posts nothing" (amount, payee, transferId)
#[test]
fn a_different_amount_payee_or_transfer_id_than_the_one_approved_is_a_mismatch_and_posts_nothing() {
    let Some(b) = fixture(true) else { return };
    for (transfer, to, amount) in [
        (TRANSFER, OTHER, "6"),
        (TRANSFER, "someone-else", "5"),
        (TRANSFER_2, OTHER, "5"),
    ] {
        let id = b.approvals.approve(&base(&b));
        let a = call(
            &b,
            "transfers.toUser",
            &to_user_input(&b, transfer, to, amount, "", Some(&id)),
        );
        assert_eq!(
            a.code(),
            "bank.step_up_mismatch",
            "{transfer} {to} {amount}"
        );
        b.untouched();
    }
}

/// "a different asset (the from space is in another asset) is a mismatch"
#[test]
fn a_different_asset_the_from_space_is_in_another_asset_is_a_mismatch() {
    let Some(b) = fixture(true) else { return };
    let id = b
        .approvals
        .approve(&to_user_fields(&b, TRANSFER, OTHER, "EUR", "5", None));
    assert_eq!(to_user(&b, Some(&id)).code(), "bank.step_up_mismatch");
    b.untouched();
}

/// "another session of the same user cannot replay a spent approval, even for the same transfer"
#[test]
fn another_session_of_the_same_user_cannot_replay_a_spent_approval_even_for_the_same_transfer() {
    let Some(b) = fixture(true) else { return };
    let id = b.approvals.approve(&base(&b));
    to_user(&b, Some(&id)).ok();
    let other_session = send_on(
        &b.door,
        "transfers.toUser",
        &to_user_input(&b, TRANSFER, OTHER, "5", "", Some(&id)),
        principal(USER, SID2, &["bank:read", "bank:write"]),
    );
    assert_eq!(other_session.code(), "bank.step_up_required");
    assert_eq!(b.ledger.posts(), 1);
    assert_eq!(b.sends(), 1);
}

/// "a timeout talking to identity is unavailable (503), and nothing posts"
#[test]
fn a_timeout_talking_to_identity_is_unavailable_503_and_nothing_posts() {
    let Some(b) = fixture(true) else { return };
    let id = b.approvals.approve(&base(&b));
    b.approvals.set_timeout();
    let a = to_user(&b, Some(&id));
    assert_eq!(a.0, 503);
    refused(&a, "bank.step_up_unavailable", "SERVICE_UNAVAILABLE");
    b.untouched();
}

/// "a spent approval cannot pay a different transfer"
#[test]
fn a_spent_approval_cannot_pay_a_different_transfer() {
    let Some(b) = fixture(true) else { return };
    let id = b.approvals.approve(&base(&b));
    to_user(&b, Some(&id)).ok();
    let a = call(
        &b,
        "transfers.toUser",
        &to_user_input(&b, TRANSFER_2, OTHER, "5", "", Some(&id)),
    );
    assert_eq!(a.code(), "bank.step_up_mismatch");
    assert_eq!(b.ledger.posts(), 1);
    assert_eq!(b.sends(), 1);
}

/// "an approval spent elsewhere (consumed at identity, no use record) is refused as used"
#[test]
fn an_approval_spent_elsewhere_consumed_at_identity_no_use_record_is_refused_as_used() {
    let Some(b) = fixture(true) else { return };
    let bind = base(&b);
    let id = b.approvals.approve(&bind);
    let hash = payload_hash(bind.action_type, &bind.fields);
    b.approvals
        .consume(
            &ConsumeInput {
                approval_id: &id,
                operation_id: &id,
                payload_hash: &hash,
                target_service: "svc-bank",
                target_id: TO_USER,
                expected_version: "1",
                replay: None,
            },
            Some(PrincipalBinding {
                user_id: USER,
                session_id: SID,
            }),
        )
        .unwrap();
    assert_eq!(to_user(&b, Some(&id)).code(), "bank.step_up_used");
    b.untouched();
}

/// "refuses an expired approval, another user, another session and an unknown id"
#[test]
fn refuses_an_expired_approval_another_user_another_session_and_an_unknown_id() {
    let Some(b) = fixture(true) else { return };
    let bind = base(&b);
    let expired = b.approvals.approve_with(
        bind.action_type,
        &bind.fields,
        &Approve {
            ttl_ms: -1000,
            ..MINE
        },
    );
    let other_user = b.approvals.approve_with(
        bind.action_type,
        &bind.fields,
        &Approve {
            user_id: OTHER,
            ..MINE
        },
    );
    let other_session = b.approvals.approve_with(
        bind.action_type,
        &bind.fields,
        &Approve {
            session_id: SID2,
            ..MINE
        },
    );
    for id in [
        expired.as_str(),
        &other_user,
        &other_session,
        "does-not-exist",
    ] {
        assert_eq!(
            to_user(&b, Some(id)).code(),
            "bank.step_up_required",
            "{id}"
        );
    }
    b.untouched();
}

/// "refuses a four-eyes approval on a step-up door"
#[test]
fn refuses_a_four_eyes_approval_on_a_step_up_door() {
    let Some(b) = fixture(true) else { return };
    let bind = base(&b);
    let id = b.approvals.approve_with(
        bind.action_type,
        &bind.fields,
        &Approve {
            four_eyes: true,
            ..MINE
        },
    );
    assert_ne!(to_user(&b, Some(&id)).0, 200);
    b.untouched();
}

/// "fails closed when identity is unreachable or not wired"
#[test]
fn fails_closed_when_identity_is_unreachable_or_not_wired() {
    let Some(b) = fixture(true) else { return };
    let id = b.approvals.approve(&base(&b));
    b.approvals.set_down();
    refused(
        &to_user(&b, Some(&id)),
        "bank.step_up_unavailable",
        "SERVICE_UNAVAILABLE",
    );
    b.untouched();

    // No `IDENTITY_URL`: the door's consume is the unwired one.
    let identity = Identity::default();
    let unwired = door_for(&b.db, &b.ledger, &identity, &Consume::Unwired, true);
    let a = send_on(
        &unwired,
        "transfers.toUser",
        &to_user_input(&b, TRANSFER, OTHER, "5", "", Some(&id)),
        principal(USER, SID, &["bank:read", "bank:write"]),
    );
    assert_eq!(
        (a.0, a.trpc()),
        (503, "SERVICE_UNAVAILABLE".to_owned()),
        "{}",
        a.1.compact()
    );
    b.untouched();
}

/// "a trade:withdraw bearer is no substitute for an approval"
#[test]
fn a_trade_withdraw_bearer_is_no_substitute_for_an_approval() {
    let Some(b) = fixture(true) else { return };
    let a = send_on(
        &b.door,
        "transfers.toUser",
        &to_user_input(&b, TRANSFER, OTHER, "5", "", None),
        principal(USER, SID, &["bank:read", "bank:write", "trade:withdraw"]),
    );
    assert_eq!(a.code(), "bank.step_up_required");
    b.untouched();
}

/// "sending to yourself by user id does not prompt"
#[test]
fn sending_to_yourself_by_user_id_does_not_prompt() {
    let Some(b) = fixture(true) else { return };
    let a = call(
        &b,
        "transfers.toUser",
        &to_user_input(&b, TRANSFER, USER, "5", "", None),
    )
    .ok();
    assert_ne!(text(&a, "ledgerTxId"), "null");
    assert_eq!(b.approvals.calls(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// step-up/step-up-money-out.test.ts: flag required: transfers.create / schedule / scheduleToUser

fn create_input(b: &Bank, to: &str, approval: Option<&str>) -> String {
    let approval = approval.map_or(String::new(), |a| format!(r#","stepUpApprovalId":"{a}""#));
    format!(
        r#"{{"transferId":"{TRANSFER}","fromSpaceId":"{}","toSpaceId":"{to}","amount":"5"{approval}}}"#,
        b.from
    )
}

fn create_fields(b: &Bank, to: &str) -> Binding {
    step_up::create_transfer_binding(&CreateTransfer {
        actor: USER,
        transfer_id: TRANSFER,
        from_space_id: &b.from,
        to_space_id: to,
        asset_id: "USDT",
        amount: "5",
        note: None,
        reference: None,
    })
}

/// "a move between your own spaces never prompts"
#[test]
fn a_move_between_your_own_spaces_never_prompts() {
    let Some(b) = fixture(true) else { return };
    let a = call(&b, "transfers.create", &create_input(&b, &b.own_to, None)).ok();
    assert_ne!(text(&a, "ledgerTxId"), "null");
    // The move between spaces, not a send to a person.
    assert_eq!(
        b.ledger.keys(),
        vec![format!("bank.transfer.own:{TRANSFER}:0")]
    );
    assert_eq!(b.sends(), 0);
    assert_eq!(b.approvals.calls(), 0);
}

/// "to another user (or an unknown space) it needs an approval for that exact destination"
#[test]
fn to_another_user_or_an_unknown_space_it_needs_an_approval_for_that_exact_destination() {
    let Some(b) = fixture(true) else { return };
    let foreign = b.foreign_to.clone();
    assert_eq!(
        call(&b, "transfers.create", &create_input(&b, &foreign, None)).code(),
        "bank.step_up_required"
    );
    // An id that does not exist is indistinguishable from a foreign one: it asks for the step-up too.
    assert_eq!(
        call(
            &b,
            "transfers.create",
            &create_input(&b, "00000000-0000-4000-8000-000000000000", None)
        )
        .code(),
        "bank.step_up_required"
    );
    assert_eq!(b.ledger.posts(), 0);
    let id = b.approvals.approve(&create_fields(&b, &foreign));
    let a = call(
        &b,
        "transfers.create",
        &create_input(&b, &foreign, Some(&id)),
    )
    .ok();
    assert_ne!(text(&a, "ledgerTxId"), "null");
    let wrong_payee = b.approvals.approve(&create_fields(&b, &b.own_to));
    assert_eq!(
        call(
            &b,
            "transfers.create",
            &create_input(&b, &foreign, Some(&wrong_payee))
        )
        .code(),
        "bank.step_up_mismatch"
    );
    assert_eq!(b.ledger.posts(), 1);
}

fn schedule_input(
    b: &Bank,
    id: &str,
    payee: (&str, &str),
    cadence: &str,
    approval: Option<&str>,
) -> String {
    let approval = approval.map_or(String::new(), |a| format!(r#","stepUpApprovalId":"{a}""#));
    format!(
        r#"{{"scheduleId":"{id}","fromSpaceId":"{}","{}":"{}","amount":"5","cadence":"{cadence}","startsAt":"{START}"{approval}}}"#,
        b.from, payee.0, payee.1
    )
}

fn schedule_common<'a>(b: &'a Bank, id: &'a str, cadence: &'a str) -> Schedule<'a> {
    Schedule {
        actor: USER,
        schedule_id: id,
        from_space_id: &b.from,
        asset_id: "USDT",
        amount: "5",
        cadence,
        starts_at: START,
        ends_at: None,
    }
}

fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}

/// "standing orders to another person are approved at creation, binding cadence and dates; cancel and pause never
/// prompt". The TypeScript's mock pauses after cancelling; a real cancelled order no longer pauses, so here the order
/// is paused, then cancelled: neither asks for a step-up.
#[test]
fn standing_orders_to_another_person_are_approved_at_creation_binding_cadence_and_dates_cancel_and_pause_never_prompt()
 {
    let Some(b) = fixture(true) else { return };
    let sched = uuid();
    let foreign = b.foreign_to.clone();
    let payee = ("toSpaceId", foreign.as_str());
    assert_eq!(
        call(
            &b,
            "transfers.schedule",
            &schedule_input(&b, &sched, payee, "monthly", None)
        )
        .code(),
        "bank.step_up_required"
    );
    let bind = step_up::schedule_binding(&schedule_common(&b, &sched, "monthly"), &foreign);
    let id = b.approvals.approve(&bind);
    assert_eq!(
        call(
            &b,
            "transfers.schedule",
            &schedule_input(&b, &sched, payee, "daily", Some(&id))
        )
        .code(),
        "bank.step_up_mismatch"
    );
    let made = call(
        &b,
        "transfers.schedule",
        &schedule_input(&b, &sched, payee, "monthly", Some(&id)),
    )
    .ok();
    assert_eq!(text(&made, "id"), sched);
    let asked = b.approvals.calls();
    let paused = call(
        &b,
        "transfers.pause",
        &format!(r#"{{"scheduleId":"{sched}"}}"#),
    )
    .ok();
    assert_eq!(text(&paused, "status"), "paused");
    let cancelled = call(
        &b,
        "transfers.cancel",
        &format!(r#"{{"scheduleId":"{sched}"}}"#),
    )
    .ok();
    assert_eq!(cancelled.compact(), r#"{"cancelled":true}"#);
    assert_eq!(
        b.approvals.calls(),
        asked,
        "cancel and pause asked identity"
    );
}

/// "scheduleToUser needs one; to yourself it does not"
#[test]
fn schedule_to_user_needs_one_to_yourself_it_does_not() {
    let Some(b) = fixture(true) else { return };
    let sched = uuid();
    let input = schedule_input(&b, &sched, ("toUserId", OTHER), "weekly", None);
    assert_eq!(
        call(&b, "transfers.scheduleToUser", &input).code(),
        "bank.step_up_required"
    );
    let bind = step_up::schedule_to_user_binding(&schedule_common(&b, &sched, "weekly"), OTHER);
    // The pinned fields: `endsAt` is bound as the empty string when the order has no end.
    assert_eq!(
        bind.fields
            .iter()
            .find(|(k, _)| k == "endsAt")
            .map(|(_, v)| v.as_str()),
        Some("")
    );
    let id = b.approvals.approve(&bind);
    let made = call(
        &b,
        "transfers.scheduleToUser",
        &schedule_input(&b, &sched, ("toUserId", OTHER), "weekly", Some(&id)),
    )
    .ok();
    assert_eq!(text(&made, "id"), sched);
    let asked = b.approvals.calls();
    let own = uuid();
    let to_self = call(
        &b,
        "transfers.scheduleToUser",
        &schedule_input(&b, &own, ("toUserId", USER), "weekly", None),
    )
    .ok();
    assert_eq!(text(&to_self, "id"), own);
    assert_eq!(b.approvals.calls(), asked);
}

// ---------------------------------------------------------------------------------------------------------------
// step-up/step-up-money-out.test.ts: flag off (the default), transfers' doors

/// "every door runs without an approval, identity is never asked and no extra space lookups happen" (the transfers
/// doors: `toUser`, `create` to another person's space, `scheduleToUser`). The space-lookup count is the TypeScript
/// mock's; here the doors' answers and identity's silence are what is held.
#[test]
fn every_door_runs_without_an_approval_and_identity_is_never_asked() {
    let Some(b) = fixture(false) else { return };
    assert_ne!(text(&to_user(&b, None).ok(), "ledgerTxId"), "null");
    let foreign = b.foreign_to.clone();
    let create = format!(
        r#"{{"transferId":"{TRANSFER_2}","fromSpaceId":"{}","toSpaceId":"{foreign}","amount":"5"}}"#,
        b.from
    );
    assert_ne!(
        text(&call(&b, "transfers.create", &create).ok(), "ledgerTxId"),
        "null"
    );
    let sched = uuid();
    call(
        &b,
        "transfers.scheduleToUser",
        &schedule_input(&b, &sched, ("toUserId", OTHER), "daily", None),
    )
    .ok();
    assert_eq!(b.approvals.calls(), 0);
}

/// "a router built without a gate behaves the same": the Rust door always has the gate; with the mode off and no
/// identity wired at all, a send to another person still goes through.
#[test]
fn a_door_with_the_mode_off_and_no_identity_behaves_the_same() {
    let Some(b) = fixture(false) else { return };
    let identity = Identity::default();
    let plain = door_for(&b.db, &b.ledger, &identity, &Consume::Unwired, false);
    let a = send_on(
        &plain,
        "transfers.toUser",
        &to_user_input(&b, TRANSFER, OTHER, "5", "", None),
        principal(USER, SID, &["bank:read", "bank:write"]),
    )
    .ok();
    assert_ne!(text(&a, "ledgerTxId"), "null");
}

// ---------------------------------------------------------------------------------------------------------------
// step-up/door-parity.test.ts: a step-up approval for a send is spendable at the bank door
//
// Identity's side (`bindCustomerStepUp` then `customerStepUpPayloadHash`: `actor` plus the sent fields, sorted, as
// `JSON.stringify({ actionType, fields })`, sha256) for these exact inputs, pinned. The bank's side is the binding
// the door builds, hashed by the door's own `payload_hash`.

const ACTOR: &str = USER;
const PARITY_TO: &str = "99999999-9999-4999-8999-999999999999";

fn parity_to_user(note: Option<&str>, reference: Option<&str>, request: Option<&str>) -> String {
    let b = step_up::to_user_binding(&ToUser {
        actor: ACTOR,
        transfer_id: "transfer:jbank04:1",
        from_space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        to_user_id: PARITY_TO,
        asset_id: "USDT",
        amount: "40",
        note,
        reference,
        request_id: request,
    });
    payload_hash(b.action_type, &b.fields)
}

/// "to a person, with no note or reference" / "a note" / "a reference" / "a note, a reference and the request it
/// settles"
#[test]
fn to_a_person_with_each_note_reference_and_request() {
    assert_eq!(
        parity_to_user(None, None, None),
        "sha256:5e34247a828f5a2f7d8f952874ee97b85805d398219f3762fba62f2cd4be04b4"
    );
    assert_eq!(
        parity_to_user(Some("Lunch, TEST"), None, None),
        "sha256:68296efe83076b20a2326efb2382086ea3bd67cff303564cad3f98cb69f74f19"
    );
    assert_eq!(
        parity_to_user(None, Some("INV-0042"), None),
        "sha256:802491c53aab878246e0a438765747797fda9aae6ab6f296d61f610d908b76ad"
    );
    assert_eq!(
        parity_to_user(
            Some("Rent"),
            Some("OCT"),
            Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        ),
        "sha256:4f1e600105fceedaa09d7fd6e395e7c140d3fafe949b9c4985612c8837e4e3bd"
    );
}

/// "to another person's space, with a note and a reference"
#[test]
fn to_another_persons_space_with_a_note_and_a_reference() {
    let b = step_up::create_transfer_binding(&CreateTransfer {
        actor: ACTOR,
        transfer_id: "transfer:jbank04:1",
        from_space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        to_space_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        asset_id: "USDT",
        amount: "40",
        note: Some("Split bill"),
        reference: Some("DIN-7"),
    });
    assert_eq!(
        payload_hash(b.action_type, &b.fields),
        "sha256:47c97407550b4b038cc39a8ebb1b6375e052fb8fb935c716d5888508f38e0aeb"
    );
}

/// "an approval for one note is never spendable on a send with another"
#[test]
fn an_approval_for_one_note_is_never_spendable_on_a_send_with_another() {
    let approved = "sha256:8d17d53d27362c39594dcc53c3c7d2686520b18570b29a776e7c2dc6be5c0e06";
    assert_eq!(parity_to_user(Some("Rent"), None, None), approved);
    assert_ne!(
        parity_to_user(Some("Rent, all of it"), None, None),
        approved
    );
    assert_ne!(parity_to_user(None, None, None), approved);
}
