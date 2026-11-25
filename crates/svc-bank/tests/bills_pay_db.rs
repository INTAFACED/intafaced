//! Part `pay` of slice `bills` against the Rust door on a real Postgres. Ports every bill-pay check of the TypeScript's
//! `personal-pay/personal-pay.db.test.ts` (its first six tests; the rest of that file is slice `global`'s) and
//! `personal-pay/bills-retry.test.ts`, each test named after the TypeScript test's words. A router call is a door call;
//! a call on `BillPayService` (`runDue`) is the Rust function it became, given the dependencies the door gives it.
//!
//! The ledger is a stand-in that books `bankTransfer`, refuses too little money, can lose its answer after booking, and
//! finds a transaction by its key. The bill partner is a stand-in whose rail answers what each test says. Two checks
//! the TypeScript suite does not reach are added: with the custodial layer off nothing is posted (the launch money
//! model), and a post whose answer was lost is found by its key on the retry and never posted twice.
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::bills::{self, pay};
use svc_bank::db::Store;
use svc_bank::door::{self, BankDoor, DoorConfig, Kind, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, Funding, TestPartner, payouts_account};
use svc_bank::spaces::ports::{
    DirError, Directory, Ledger, LedgerAccount, LedgerBalance, LedgerTx, Lookup, Lookups,
    PostFailure, TxEntry,
};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::{self, Rules};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::MemoryIdentity;
use svc_bank::transfers::step_up::payload_hash;
use svc_bank::transfers::{Approvals, Settings, Wiring as TransfersWiring};

use support::TestDb;

const SECRET: &str = "a-bank-bills-pay-db-edge-secret-long-enough";
const INTERNAL: &str = "a-bank-bills-pay-db-internal-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const SID: &str = "77777777-7777-4777-8777-777777777777";

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

fn t(iso: &str) -> Instant {
    js_date(iso).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-ins

type Acct = (String, String, String, String);

#[derive(Default)]
struct BookState {
    balances: BTreeMap<Acct, Amount>,
    journal: Vec<(String, LedgerTx)>,
    /// The next post books, then its answer is lost.
    lose_next: bool,
    posts: usize,
}

/// `MemoryLedger`, as far as bill pay reads and posts it.
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

fn acct_of(j: &Json) -> Acct {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        other => panic!("{k}: {other:?}"),
    };
    (s("ownerType"), s("ownerId"), s("assetId"), s("kind"))
}

impl Book {
    /// `recipes.deposit` of `amount` USDT into the person's main balance.
    fn fund(&self, user: &str, amount: &str) {
        let key = (
            "user".to_owned(),
            user.to_owned(),
            "USDT".to_owned(),
            "available".to_owned(),
        );
        *self.0.lock().unwrap().balances.entry(key).or_default() += amt(amount);
    }
    fn main(&self, user: &str) -> Amount {
        self.balance(&LedgerAccount::user_available(user, "USDT"))
            .unwrap()
    }
    /// `transfers(ledger)`: the `bankTransfer` posts.
    fn transfers(&self) -> usize {
        self.0.lock().unwrap().journal.len()
    }
    fn posts(&self) -> usize {
        self.0.lock().unwrap().posts
    }
    fn lose_next(&self) {
        self.0.lock().unwrap().lose_next = true;
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
            .unwrap_or(Amount::ZERO))
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
        assert_eq!(recipe, "bankTransfer");
        let mut st = self.0.lock().unwrap();
        st.posts += 1;
        if let Some((_, t)) = st.journal.iter().find(|(k, _)| k == key) {
            return Ok(t.clone());
        }
        let from = acct_of(input.get("from").unwrap());
        let to = acct_of(input.get("to").unwrap());
        let amount = match input.get("amount") {
            Some(Json::String(a)) => amt(a),
            other => panic!("amount: {other:?}"),
        };
        // Only a rail boundary may run negative.
        let held = st.balances.get(&from).copied().unwrap_or(Amount::ZERO);
        if from.0 != "treasury" && held < amount {
            return Err(PostFailure::Coded {
                code: "ledger.insufficient_funds".to_owned(),
                message: format!("Insufficient funds: {}", format_amount(held)),
                attempts: 1,
            });
        }
        *st.balances.entry(from.clone()).or_default() -= amount;
        *st.balances.entry(to.clone()).or_default() += amount;
        let tx = LedgerTx {
            key: key.to_owned(),
            id: format!("tx-{}", st.journal.len() + 1),
            posted_at: door::system_now(),
            entries: vec![TxEntry {
                account_id: format!("{from:?}"),
                asset_id: from.2.clone(),
                direction: "credit".to_owned(),
                amount,
            }],
        };
        st.journal.push((key.to_owned(), tx.clone()));
        if std::mem::take(&mut st.lose_next) {
            return Err(PostFailure::Unknown("socket hang up".to_owned()));
        }
        Ok(tx)
    }
}

/// What the stand-in rail answers, and how many times it was asked.
#[derive(Clone)]
enum Answer {
    Taken(&'static str, &'static str),
    Refused,
    Lost,
}

#[derive(Clone)]
struct Rail(Arc<Mutex<(Answer, usize)>>);

impl Rail {
    fn new(answer: Answer) -> Rail {
        Rail(Arc::new(Mutex::new((answer, 0))))
    }
    fn submits(&self) -> usize {
        self.0.lock().unwrap().1
    }
    fn answer(&self, answer: Answer) {
        self.0.lock().unwrap().0 = answer;
    }
}

impl pay::Rail for Rail {
    fn rail_id(&self) -> String {
        "test-bill-rail".to_owned()
    }
    fn submit(&self, _input: &pay::Submit) -> Result<pay::RailAnswer, String> {
        let mut st = self.0.lock().unwrap();
        st.1 += 1;
        match st.0 {
            Answer::Taken(r, s) => Ok(pay::RailAnswer::Taken {
                provider_ref: Some(r.to_owned()),
                status: s.to_owned(),
            }),
            Answer::Refused => Ok(pay::RailAnswer::Refused),
            Answer::Lost => Err("socket hang up".to_owned()),
        }
    }
}

struct PowerDirectory;

impl pay::Directory for PowerDirectory {
    fn search(&self, _q: &str, _c: Option<&str>) -> Result<Vec<pay::Biller>, String> {
        Ok(vec![pay::Biller {
            id: "power-de".to_owned(),
            name: "TEST POWER".to_owned(),
            country: "DE".to_owned(),
            category: "utility".to_owned(),
        }])
    }
}

struct PowerLookup;

impl pay::LookupPort for PowerLookup {
    fn lookup(&self, _b: &str, reference: &str) -> Result<Option<pay::Lookup>, String> {
        if reference == "unknown" {
            return Ok(None);
        }
        Ok(Some(pay::Lookup {
            amount_due: "25.00".to_owned(),
            due_date: "2026-11-01".to_owned(),
            payee_name: "TEST POWER".to_owned(),
            currency: "EUR".to_owned(),
        }))
    }
}

/// `liveBills(submit)`.
fn live_bills(rail: &Rail) -> pay::Wiring {
    pay::Wiring {
        directory: Some(Box::new(PowerDirectory)),
        lookup: Some(Box::new(PowerLookup)),
        rail: Some(Box::new(rail.clone())),
    }
}

/// Each approval: its action, its payload hash, and whether it was consumed.
type Approved = BTreeMap<String, (String, String, bool)>;

/// `approvingIdentity()`: identity's same-person consume, once per approval.
#[derive(Clone, Default)]
struct Identity(Arc<Mutex<Approved>>);

impl Identity {
    fn approve(&self, action: &str, fields: &[(&str, &str)]) -> String {
        let fields: Vec<(String, String)> = fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let mut st = self.0.lock().unwrap();
        let id = format!("approval-{}", st.len() + 1);
        st.insert(
            id.clone(),
            (action.to_owned(), payload_hash(action, &fields), false),
        );
        id
    }
}

impl Approvals for Identity {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        _principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        let mut st = self.0.lock().unwrap();
        let refused = |c: &str| {
            Err(ConsumeError::Refused(format!(
                "identity refused consume (412) {{\"message\":\"x [action_approval.{c}]\"}}"
            )))
        };
        let Some(row) = st.get_mut(input.approval_id) else {
            return refused("not_found");
        };
        if row.0 != input.target_id {
            return refused("target_mismatch");
        }
        if row.1 != input.payload_hash {
            return refused("payload_mismatch");
        }
        if row.2 {
            return refused("consumed");
        }
        row.2 = true;
        Ok((
            Consumed {
                action_type: row.0.clone(),
                target_service: "svc-bank".to_owned(),
                target_id: input.target_id.to_owned(),
                status: "CONSUMED".to_owned(),
                requester_id: USER.to_owned(),
                approver_id: Some(USER.to_owned()),
                approver_is_founder: None,
                requester_is_founder: None,
            },
            Facts {
                kind: Some("same_person".to_owned()),
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

struct Bank {
    _db: TestDb,
    store: Store,
    door: BankDoor,
    ledger: Book,
}

/// What a test mounts: the bill ports, the step-up gate and the custodial layer.
struct Mount {
    bills: pay::Wiring,
    step_up: Option<Identity>,
    custody_layer: &'static str,
    /// The TEST partner bank on the stack (`held` below puts the person's money there).
    partner: bool,
}

impl Default for Mount {
    fn default() -> Mount {
        Mount {
            bills: pay::Wiring::none(),
            step_up: None,
            custody_layer: "on",
            partner: false,
        }
    }
}

/// `mount(options)`.
fn mount(m: Mount) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut transfers = TransfersWiring::none();
    transfers.recipients = Box::new(MemoryIdentity::default());
    transfers.settings = Settings {
        producer: "svc-bank".to_owned(),
        step_up_required: m.step_up.is_some(),
        ..Settings::default()
    };
    if let Some(identity) = m.step_up {
        transfers.approvals = Box::new(identity);
    }
    let mut bills = bills::Wiring::none();
    bills.pay = m.bills;
    let door = BankDoor::new(DoorConfig {
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
        partner: m.partner.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(Open),
        custody_layer: m.custody_layer.to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(ledger.clone()),
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
    .with_bills(bills);
    let store = db.store();
    Some(Bank {
        _db: db,
        store,
        door,
        ledger,
    })
}

impl Bank {
    /// `funded(bank, ledger, userId)`: 100 USDT and the person's main space.
    fn funded(&self, user: &str) -> String {
        self.ledger.fund(user, "100");
        space::with(&self.store, |c| space::ensure_primary(c, user, "USDT"))
            .unwrap()
            .id
    }
    /// The TEST partner holds the person's money (`custody: 'off'`), its bank rail as `rail` says, and `amount` USDT
    /// paid in there; the ledger holds none. Answers the person's main space.
    fn held(&self, user: &str, rail: &str, amount: &str) -> String {
        let partner = self.door.partner().partner.as_ref().unwrap();
        let mut st = partner.lock();
        let mut sw = st.board.read(user, Clone::clone);
        "off".clone_into(&mut sw.custody);
        rail.clone_into(&mut sw.bank_rail);
        st.board.set(user, sw);
        st.fund(
            user,
            &Funding {
                fund_id: "bills-fund".to_owned(),
                asset_id: "USDT".to_owned(),
                amount: amt(amount),
            },
            t("2026-10-01T00:00:00.000Z"),
        )
        .unwrap();
        drop(st);
        space::with(&self.store, |c| space::ensure_primary(c, user, "USDT"))
            .unwrap()
            .id
    }
    /// The person's main USDT balance, and the partner's outbound payments, as the partner's own book holds them.
    fn at_partner(&self, user: &str) -> (Amount, Amount) {
        let st = self.door.partner().partner.as_ref().unwrap().lock();
        (
            st.book.amount(&AccountRef::main(user, "USDT")),
            st.book.amount(&payouts_account("USDT")),
        )
    }
    fn set_rail(&self, user: &str, rail: &str) {
        let mut st = self.door.partner().partner.as_ref().unwrap().lock();
        let mut sw = st.board.read(user, Clone::clone);
        rail.clone_into(&mut sw.bank_rail);
        st.board.set(user, sw);
    }
    /// `bank.bills.runDue(limit, now)`.
    fn run_due(&self, limit: f64, now: Instant) -> pay::RunReport {
        self.door
            .bills_deps(now, |d| pay::run_due(d, limit, now))
            .unwrap()
    }
    fn count(&self, q: &str) -> i64 {
        space::with(&self.store, |c| {
            Ok(c.query_one(q, &[]).unwrap().get::<_, i64>(0))
        })
        .unwrap()
    }
}

fn principal(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(user)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str(SID)),
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

const READ: &[&str] = &["bank:read"];
const WRITE: &[&str] = &["bank:read", "bank:write"];
const FOUNDER: &[&str] = &["admin:read"];

/// One answer: its status and body.
struct Answer2(u16, Json);

impl Answer2 {
    fn data(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1.get("result").unwrap().get("data").unwrap().clone()
    }
    fn err(&self) -> &Json {
        assert_ne!(self.0, 200, "{}", self.1.compact());
        self.1.get("error").unwrap()
    }
    /// `error.data.code`, the tRPC code.
    fn trpc(&self) -> String {
        s(self.err().get("data").unwrap(), "code")
    }
    /// `cause.code`.
    fn cause(&self) -> String {
        let data = self.err().get("data").unwrap();
        data.get("cause")
            .map_or("null".to_owned(), |c| s(c, "code"))
    }
    fn message(&self) -> String {
        s(self.err(), "message")
    }
}

impl Bank {
    fn call(&self, user: &str, scopes: &[&str], path: &str, input: &str) -> Answer2 {
        let headers = {
            let mut h = principal(user, scopes);
            h.push(("content-type".to_owned(), "application/json".to_owned()));
            h
        };
        let (url, method, body) = match door::call(path).map(|c| c.kind) {
            Some(Kind::Query) if input.is_empty() => (format!("/trpc/{path}"), "GET", ""),
            Some(Kind::Query) => (format!("/trpc/{path}?input={}", encode(input)), "GET", ""),
            _ => (format!("/trpc/{path}"), "POST", input),
        };
        let res = self.door.handle_from(
            &Request {
                method,
                url: &url,
                headers: &headers,
                body,
            },
            "req-bills-db",
            "127.0.0.1",
        );
        Answer2(res.status, json::parse(&res.body).unwrap())
    }
}

fn s(j: &Json, k: &str) -> String {
    match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

fn pay_input(key: &str, amount: &str, space: &str) -> String {
    format!(
        r#"{{"idempotencyKey":"{key}","billerId":"power-de","reference":"100","amount":"{amount}","fromSpaceId":"{space}"}}"#
    )
}

// ---------------------------------------------------------------------------------------------------------------
// personal bill pay (`personal-pay.db.test.ts`)

#[test]
fn refuses_biller_search_lookup_and_pay_while_the_psp_port_is_unset_and_a_retry_does_not_post() {
    let Some(b) = mount(Mount::default()) else {
        return;
    };
    let space = b.funded(USER);
    let search = b.call(USER, WRITE, "bills.billers.search", r#"{"query":"power"}"#);
    assert_eq!(search.trpc(), "PRECONDITION_FAILED");
    assert!(search.message().contains("socket.psp-partners"));
    assert_eq!(search.cause(), "bank.bills_directory_unset");
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.lookup",
            r#"{"billerId":"power-de","reference":"100"}"#
        )
        .cause(),
        "bank.bills_lookup_unset"
    );
    let input = pay_input("bill-key-01", "10", &space);
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_psp_unset"
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_psp_unset"
    );
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.pay",
            &pay_input("bill-key-01", "11", &space)
        )
        .cause(),
        "bank.bills_conflict"
    );
    let page = b.call(USER, WRITE, "bills.list", r#"{"limit":10}"#).data();
    let Some(Json::Array(items)) = page.get("items") else {
        panic!()
    };
    assert_eq!(items.len(), 1);
    assert_eq!(
        (
            s(&items[0], "status"),
            s(&items[0], "amount"),
            s(&items[0], "ledgerTxId"),
            s(&items[0], "failureCode"),
            s(&items[0], "failureBlocker"),
        ),
        (
            "failed".to_owned(),
            "10".to_owned(),
            "null".to_owned(),
            "bank.bills_psp_unset".to_owned(),
            "socket.psp-partners".to_owned()
        )
    );
    assert_eq!(b.ledger.transfers(), 0);
    assert_eq!(b.ledger.main(USER), amt("100"));
    let recur = format!(
        r#"{{"idempotencyKey":"recur-key-1","billerId":"power-de","reference":"100","amount":"10","fromSpaceId":"{space}","cadence":"monthly","startsAt":"2026-01-01T00:00:00.000Z"}}"#
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.recurring.create", &recur)
            .cause(),
        "bank.bills_psp_unset"
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.recurring.list", r#"{"limit":10}"#)
            .data()
            .compact(),
        "[]"
    );
}

#[test]
fn refuses_a_session_that_lacks_the_scope_including_founder_counts() {
    let Some(b) = mount(Mount::default()) else {
        return;
    };
    let space = b.funded(USER);
    assert_eq!(
        b.call(USER, &["trade:read"], "bills.list", r#"{"limit":10}"#)
            .trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        b.call(
            USER,
            READ,
            "bills.pay",
            &pay_input("bill-key-02", "10", &space)
        )
        .trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        b.call(USER, &["bank:write"], "bills.list", r#"{"limit":10}"#)
            .trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.ops.summary", "").trpc(),
        "FORBIDDEN"
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.runDue", r#"{"limit":10}"#)
            .trpc(),
        "UNAUTHORIZED"
    );
    let founder = b.call(USER, FOUNDER, "bills.ops.summary", "").data();
    assert_eq!(
        founder.get("rails").unwrap().compact(),
        r#"{"billerDirectory":"unset","lookup":"unset","payRail":"unset","blocker":"socket.psp-partners"}"#
    );
    assert_eq!(s(founder.get("counts").unwrap(), "failed"), "0");
    assert_eq!(founder.get("volumes").unwrap().compact(), "[]");
}

#[test]
fn does_not_pay_from_another_persons_space() {
    let Some(b) = mount(Mount::default()) else {
        return;
    };
    let theirs = b.funded(OTHER);
    let a = b.call(
        USER,
        WRITE,
        "bills.pay",
        &pay_input("bill-key-03", "10", &theirs),
    );
    assert_eq!(
        (a.trpc(), a.cause()),
        (
            "NOT_FOUND".to_owned(),
            "bank.bills_space_not_found".to_owned()
        )
    );
    assert_eq!(b.ledger.transfers(), 0);
    assert_eq!(b.count("SELECT count(*) FROM bank.bill_payments"), 0);
}

#[test]
fn requires_step_up_when_the_gate_is_on_and_still_posts_nothing_while_the_rail_is_blank() {
    let identity = Identity::default();
    let Some(b) = mount(Mount {
        step_up: Some(identity.clone()),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    let input = pay_input("bill-key-04", "10.00", &space);
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.step_up_required"
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.list", r#"{"limit":10}"#)
            .data()
            .get("items")
            .unwrap()
            .compact(),
        "[]"
    );
    // `billPayStepUp({ actor: USER, ...input, assetId: 'USDT' })`: the amount as sent, never reformatted.
    let approval = identity.approve(
        "bank.step_up.bills.pay",
        &[
            ("actor", USER),
            ("idempotencyKey", "bill-key-04"),
            ("billerId", "power-de"),
            ("reference", "100"),
            ("fromSpaceId", &space),
            ("assetId", "USDT"),
            ("amount", "10.00"),
        ],
    );
    let with = format!(
        r#"{{"idempotencyKey":"bill-key-04","billerId":"power-de","reference":"100","amount":"10.00","fromSpaceId":"{space}","stepUpApprovalId":"{approval}"}}"#
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &with).cause(),
        "bank.bills_psp_unset"
    );
    assert_eq!(b.ledger.transfers(), 0);
}

#[test]
fn posts_a_live_bill_once_through_the_ledger_and_returns_the_provider_reference() {
    let rail = Rail::new(Answer::Taken("bill-ref-1", "accepted"));
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.billers.search",
            r#"{"query":"power","country":"DE"}"#
        )
        .data()
        .compact(),
        r#"[{"id":"power-de","name":"TEST POWER","country":"DE","category":"utility"}]"#
    );
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.lookup",
            r#"{"billerId":"power-de","reference":"100"}"#
        )
        .data()
        .compact(),
        r#"{"amountDue":"25.00","dueDate":"2026-11-01","payeeName":"TEST POWER","currency":"EUR"}"#
    );
    let input = pay_input("bill-key-05", "10", &space);
    let paid = b.call(USER, WRITE, "bills.pay", &input).data();
    let again = b.call(USER, WRITE, "bills.pay", &input).data();
    assert_eq!(s(&again, "id"), s(&paid, "id"));
    assert_eq!(
        (
            s(&again, "status"),
            s(&again, "providerRef"),
            s(&again, "amount")
        ),
        (
            "accepted".to_owned(),
            "bill-ref-1".to_owned(),
            "10".to_owned()
        )
    );
    assert_eq!(s(&again, "ledgerTxId"), s(&paid, "ledgerTxId"));
    assert_ne!(s(&paid, "ledgerTxId"), "null");
    assert_eq!(rail.submits(), 1);
    assert_eq!(b.ledger.transfers(), 1);
    assert_eq!(
        b.ledger.keys(),
        [format!("bank.transfer.rail:{}:0", s(&paid, "id"))]
    );
    assert_eq!(b.ledger.main(USER), amt("90"));
    let id = s(&paid, "id");
    let got = b
        .call(USER, READ, "bills.get", &format!(r#"{{"id":"{id}"}}"#))
        .data();
    assert_eq!(s(&got, "ledgerTxId"), s(&paid, "ledgerTxId"));
    assert_eq!(
        b.call(OTHER, READ, "bills.get", &format!(r#"{{"id":"{id}"}}"#))
            .cause(),
        "bank.bills_not_found"
    );
    let founder = b.call(USER, FOUNDER, "bills.ops.summary", "").data();
    assert_eq!(s(founder.get("counts").unwrap(), "accepted"), "1");
    assert_eq!(
        founder.get("volumes").unwrap().compact(),
        r#"[{"status":"accepted","assetId":"USDT","count":1,"amount":"10"}]"#
    );
    assert_eq!(s(founder.get("rails").unwrap(), "payRail"), "live");
}

#[test]
fn reverses_a_refused_live_bill_and_does_not_reverse_it_again_on_retry() {
    let rail = Rail::new(Answer::Refused);
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    let input = pay_input("bill-key-06", "10", &space);
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_rail_refused"
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_rail_refused"
    );
    assert_eq!(b.ledger.transfers(), 2);
    assert_eq!(b.ledger.main(USER), amt("100"));
    let failed = b
        .call(USER, FOUNDER, "bills.ops.failed", r#"{"limit":10}"#)
        .data();
    let Some(Json::Array(items)) = failed.get("items") else {
        panic!()
    };
    assert_eq!(
        (
            s(&items[0], "userId"),
            s(&items[0], "failureCode"),
            s(&items[0], "ledgerTxId")
        ),
        (
            USER.to_owned(),
            "bank.bills_rail_refused".to_owned(),
            "null".to_owned()
        )
    );
    let id = s(&items[0], "id");
    let drill = b
        .call(
            USER,
            FOUNDER,
            "bills.ops.get",
            &format!(r#"{{"id":"{id}"}}"#),
        )
        .data();
    assert_eq!(s(&drill, "userId"), USER);
}

#[test]
fn refuses_an_unaffordable_live_bill_before_the_rail_is_told_and_runs_a_recurring_bill_once() {
    let rail = Rail::new(Answer::Taken("bill-ref-2", "paid"));
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.pay",
            &pay_input("bill-key-07", "1000", &space)
        )
        .cause(),
        "bank.bills_insufficient_funds"
    );
    assert_eq!(rail.submits(), 0);
    assert_eq!(b.ledger.transfers(), 0);
    let recur = |key: &str, starts: &str| {
        format!(
            r#"{{"idempotencyKey":"{key}","billerId":"power-de","reference":"100","amount":"10","fromSpaceId":"{space}","cadence":"weekly","startsAt":"{starts}"}}"#
        )
    };
    let schedule = b
        .call(
            USER,
            WRITE,
            "bills.recurring.create",
            &recur("recur-key-2", "2020-01-01T00:00:00.000Z"),
        )
        .data();
    let id = s(&schedule, "id");
    b.call(
        USER,
        WRITE,
        "bills.recurring.pause",
        &format!(r#"{{"id":"{id}"}}"#),
    )
    .data();
    let listed = b
        .call(USER, WRITE, "bills.recurring.list", r#"{"limit":5}"#)
        .data();
    let Some(Json::Array(rows)) = Some(listed) else {
        panic!()
    };
    assert_eq!(s(&rows[0], "status"), "paused");
    assert_eq!(
        b.call(
            OTHER,
            WRITE,
            "bills.recurring.cancel",
            &format!(r#"{{"id":"{id}"}}"#)
        )
        .cause(),
        "bank.bill_recurring_not_found"
    );
    assert_eq!(b.run_due(10.0, t("2026-10-17T00:00:00.000Z")).considered, 0);
    b.call(
        USER,
        WRITE,
        "bills.recurring.cancel",
        &format!(r#"{{"id":"{id}"}}"#),
    )
    .data();
    let active = b
        .call(
            USER,
            WRITE,
            "bills.recurring.create",
            &recur("recur-key-3", "2026-10-17T00:00:00.000Z"),
        )
        .data();
    let first = b.run_due(10.0, t("2026-10-17T00:00:00.000Z"));
    let second = b.run_due(10.0, t("2026-10-17T00:00:00.000Z"));
    assert_eq!(first.settled, 1);
    assert_eq!(second.settled, 0);
    assert_eq!(b.ledger.transfers(), 1);
    assert_ne!(s(&active, "id"), "null");
}

// ---------------------------------------------------------------------------------------------------------------
// Bills at the TEST partner bank (the launch model: the partner holds the money and pays the biller)

fn recur_input(key: &str, biller: &str, amount: &str, space: &str, starts: &str) -> String {
    format!(
        r#"{{"idempotencyKey":"{key}","billerId":"{biller}","reference":"ACC-1","amount":"{amount}","fromSpaceId":"{space}","cadence":"monthly","startsAt":"{starts}"}}"#
    )
}

#[test]
fn a_recurring_bill_the_partner_holds_the_money_for_is_one_partner_payment_each_month_and_the_ledger_posts_nothing()
 {
    let Some(b) = mount(Mount {
        custody_layer: "off",
        partner: true,
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.held(USER, "test", "50");
    let found = b
        .call(USER, READ, "bills.billers.search", r#"{"query":"water"}"#)
        .data();
    let Json::Array(found) = found else { panic!() };
    assert_eq!(found.len(), 1);
    assert_eq!(
        (s(&found[0], "id"), s(&found[0], "name")),
        ("test-biller-water".to_owned(), "TEST Water".to_owned())
    );
    // An id the partner does not list is no biller.
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.recurring.create",
            &recur_input(
                "recur-p-0",
                "power-de",
                "10",
                &space,
                "2026-10-17T00:00:00.000Z"
            )
        )
        .cause(),
        "bank.personal_pay_request_invalid"
    );
    let bill = b
        .call(
            USER,
            WRITE,
            "bills.recurring.create",
            &recur_input(
                "recur-p-1",
                "test-biller-water",
                "10",
                &space,
                "2026-10-17T00:00:00.000Z",
            ),
        )
        .data();
    assert_eq!(
        (s(&bill, "status"), s(&bill, "nextRunAt")),
        ("active".to_owned(), "2026-10-17T00:00:00.000Z".to_owned())
    );
    let first = b.run_due(10.0, t("2026-10-17T00:00:00.000Z"));
    let second = b.run_due(10.0, t("2026-10-17T00:00:00.000Z"));
    assert_eq!((first.settled, second.considered), (1, 0));
    assert_eq!(b.at_partner(USER), (amt("40"), amt("10")));
    assert_eq!(b.ledger.posts(), 0);
    assert_eq!(
        b.count(
            "SELECT count(*) FROM bank.bill_payments \
              WHERE status = 'accepted' AND provider_ref IS NOT NULL AND ledger_tx_id IS NULL"
        ),
        1
    );
    let listed = b
        .call(USER, READ, "bills.recurring.list", r#"{"limit":5}"#)
        .data();
    let Json::Array(rows) = listed else { panic!() };
    assert_eq!(s(&rows[0], "nextRunAt"), "2026-11-17T00:00:00.000Z");
}

#[test]
fn with_the_partner_rail_off_a_bill_refuses_and_too_little_money_at_the_partner_fails_the_bill_with_nothing_sent()
 {
    let Some(b) = mount(Mount {
        custody_layer: "off",
        partner: true,
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.held(USER, "none", "5");
    assert_eq!(
        b.call(USER, READ, "bills.billers.search", r#"{"query":"water"}"#)
            .cause(),
        "bank.bills_directory_unset"
    );
    assert_eq!(
        b.call(
            USER,
            WRITE,
            "bills.recurring.create",
            &recur_input(
                "recur-p-2",
                "test-biller-water",
                "10",
                &space,
                "2026-10-17T00:00:00.000Z"
            )
        )
        .cause(),
        "bank.bills_psp_unset"
    );
    b.set_rail(USER, "test");
    let input = format!(
        r#"{{"idempotencyKey":"bill-p-3","billerId":"test-biller-energy","reference":"ACC-2","amount":"10","fromSpaceId":"{space}"}}"#
    );
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_insufficient_funds"
    );
    // The retry reads the failed bill back; the partner is not asked again.
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_insufficient_funds"
    );
    assert_eq!(b.at_partner(USER), (amt("5"), amt("0")));
    assert_eq!(b.ledger.posts(), 0);
    assert_eq!(
        b.count("SELECT count(*) FROM bank.bill_payments WHERE status = 'failed' AND provider_ref IS NULL"),
        1
    );
}

// ---------------------------------------------------------------------------------------------------------------
// `bills-retry.test.ts`

#[test]
fn retries_the_final_recurring_bill_after_an_unknown_rail_outcome() {
    let rail = Rail::new(Answer::Lost);
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    let schedule = b
        .call(
            USER,
            WRITE,
            "bills.recurring.create",
            &format!(
                r#"{{"idempotencyKey":"recur-key-9","billerId":"water","reference":"invoice","amount":"10","fromSpaceId":"{space}","cadence":"weekly","startsAt":"2026-11-01T00:00:00Z","endsAt":"2026-11-02T00:00:00Z"}}"#
            ),
        )
        .data();
    let id = s(&schedule, "id");
    let first = b.run_due(10.0, t("2026-11-01T00:00:00Z"));
    assert_eq!(
        first.failures,
        [(id.clone(), "bank.bills_outcome_unknown".to_owned())]
    );
    // The occurrence is not fired: the order stays active and due there.
    assert_eq!(
        b.count("SELECT count(*) FROM bank.bill_recurring_firings"),
        0
    );
    rail.answer(Answer::Taken("bill-ref-9", "paid"));
    let second = b.run_due(10.0, t("2026-11-03T00:00:00Z"));
    assert_eq!(second.settled, 1);
    // The same key both times: one payment, one post.
    assert_eq!(
        b.count(&format!(
            "SELECT count(*) FROM bank.bill_payments WHERE idempotency_key = 'bill-recur:{id}:0'"
        )),
        1
    );
    assert_eq!(b.count("SELECT count(*) FROM bank.bill_payments"), 1);
    assert_eq!(b.ledger.transfers(), 1);
    assert_eq!(rail.submits(), 2);
    let listed = b
        .call(USER, WRITE, "bills.recurring.list", r#"{"limit":5}"#)
        .data();
    let Json::Array(rows) = listed else { panic!() };
    assert_eq!(s(&rows[0], "status"), "completed");
}

// ---------------------------------------------------------------------------------------------------------------
// Added: the launch money model and a lost answer

#[test]
fn with_the_custodial_layer_off_a_bill_posts_nothing_and_stays_open_for_its_retry() {
    let rail = Rail::new(Answer::Taken("bill-ref-3", "accepted"));
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        custody_layer: "off",
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    let a = b.call(
        USER,
        WRITE,
        "bills.pay",
        &pay_input("bill-key-08", "10", &space),
    );
    assert_eq!(
        (a.trpc(), a.cause(), a.message()),
        (
            "INTERNAL_SERVER_ERROR".to_owned(),
            "bank.no_partner_bank".to_owned(),
            "Bank operation failed".to_owned()
        )
    );
    assert_eq!((b.ledger.posts(), rail.submits()), (0, 0));
    assert_eq!(b.ledger.main(USER), amt("100"));
    assert_eq!(
        b.count("SELECT count(*) FROM bank.bill_payments WHERE status = 'submitted' AND ledger_tx_id IS NULL"),
        1
    );
}

#[test]
fn a_post_whose_answer_was_lost_is_found_by_its_key_on_the_retry_and_never_posted_twice() {
    let rail = Rail::new(Answer::Taken("bill-ref-4", "paid"));
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    let input = pay_input("bill-key-09", "10", &space);
    b.ledger.lose_next();
    let lost = b.call(USER, WRITE, "bills.pay", &input);
    assert_eq!(lost.trpc(), "INTERNAL_SERVER_ERROR");
    assert_eq!(rail.submits(), 0);
    assert_eq!(b.ledger.transfers(), 1);
    let paid = b.call(USER, WRITE, "bills.pay", &input).data();
    assert_eq!(
        (s(&paid, "status"), s(&paid, "ledgerTxId")),
        ("paid".to_owned(), "tx-1".to_owned())
    );
    assert_eq!(b.ledger.posts(), 1);
    assert_eq!(b.ledger.transfers(), 1);
    assert_eq!(b.ledger.main(USER), amt("90"));
    assert_eq!(rail.submits(), 1);
}

#[test]
fn a_rail_whose_answer_is_lost_keeps_the_post_and_the_retry_submits_the_same_payment_again() {
    let rail = Rail::new(Answer::Lost);
    let Some(b) = mount(Mount {
        bills: live_bills(&rail),
        ..Mount::default()
    }) else {
        return;
    };
    let space = b.funded(USER);
    let input = pay_input("bill-key-10", "10", &space);
    assert_eq!(
        b.call(USER, WRITE, "bills.pay", &input).cause(),
        "bank.bills_outcome_unknown"
    );
    assert_eq!(
        b.count("SELECT count(*) FROM bank.bill_payments WHERE status = 'submitted' AND ledger_tx_id IS NOT NULL"),
        1
    );
    rail.answer(Answer::Taken("bill-ref-5", "accepted"));
    let paid = b.call(USER, WRITE, "bills.pay", &input).data();
    assert_eq!(s(&paid, "status"), "accepted");
    assert_eq!((b.ledger.transfers(), rail.submits()), (1, 2));
    assert_eq!(b.ledger.main(USER), amt("90"));
}
