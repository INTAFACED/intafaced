//! What the business database suites share: a stand-in for svc-ledger that books the recipes slice `business` posts
//! (`bankTransfer`, `businessApprovalHold`, `businessApprovalSettle`, `businessApprovalRelease`, `businessPayroll`) as
//! the TypeScript's `MemoryLedger` does (one key books once, the same key with another body refuses
//! `ledger.idempotency_conflict`, no person's or space's account below zero), svc-identity's directory, reads and
//! same-person consume, and the door wired with them. A test calls the slice's functions with the door's own
//! dependencies (`Bank::deps`), as the TypeScript calls `bank.business.*`, or enters through the door (`call`).
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test harness: each suite uses part of it, and a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::approvals::{ConsumeError, ConsumeInput, Consumed, Facts, PrincipalBinding};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{self, system_seconds};
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
use svc_bank::spaces::space::{self, Rules, with};
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::ports::{
    AccountOf, ExtraControls, Extras, HandleUnavailable, LockState, MemoryIdentity, PartyHandles,
    RecipientState, RecipientUnavailable, SecurityLock,
};
use svc_bank::transfers::step_up::{Binding, payload_hash};
use svc_bank::transfers::{Approvals, Deps, Settings, Wiring as TransfersWiring};

use crate::support::TestDb;

pub const SECRET: &str = "a-bank-business-db-edge-secret-long-enough";
pub const INTERNAL: &str = "a-bank-business-db-internal-secret-long-ok";
pub const SID: &str = "77777777-7777-4777-8777-777777777777";
pub const WRITE: &[&str] = &["bank:read", "bank:write"];

pub fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger stand-in

/// `(ownerType, ownerId, assetId, kind, purpose)`, purpose blank for none.
pub type Acct = (String, String, String, String, String);

pub fn acct(a: &LedgerAccount) -> Acct {
    (
        a.owner_type.to_owned(),
        a.owner_id.clone(),
        a.asset_id.clone(),
        a.kind.to_owned(),
        a.purpose.clone().unwrap_or_default(),
    )
}

pub fn acct_id(a: &Acct) -> String {
    if a.4.is_empty() {
        format!("acct:{}:{}:{}:{}", a.0, a.1, a.2, a.3)
    } else {
        format!("acct:{}:{}:{}:{}:{}", a.0, a.1, a.2, a.3, a.4)
    }
}

fn acct_of(j: &Json) -> Acct {
    let s = |k: &str| match j.get(k) {
        Some(Json::String(v)) => v.clone(),
        None => String::new(),
        other => panic!("{k}: {other:?}"),
    };
    (
        s("ownerType"),
        s("ownerId"),
        s("assetId"),
        s("kind"),
        s("purpose"),
    )
}

fn amount_of(j: &Json) -> Amount {
    match j.get("amount") {
        Some(Json::String(a)) => amt(a),
        other => panic!("amount: {other:?}"),
    }
}

/// `businessApprovalHoldFor`.
fn hold_of(from: &Acct, approval_id: &str) -> Acct {
    (
        from.0.clone(),
        from.1.clone(),
        from.2.clone(),
        "hold".to_owned(),
        format!("business-approval:{approval_id}"),
    )
}

/// The recipe's legs: `(credited, debited, amount)` pairs, in the recipe's order. A recipe's own refusal is
/// `ledger.invalid_entry`.
fn legs(recipe: &str, input: &Json) -> Result<Vec<(Acct, Acct, Amount)>, String> {
    let from = || acct_of(input.get("from").unwrap());
    let approval = || match input.get("approvalId") {
        Some(Json::String(v)) => v.clone(),
        other => panic!("approvalId: {other:?}"),
    };
    let positive = |a: Amount| {
        if a > 0 {
            Ok(a)
        } else {
            Err("amount must be positive".to_owned())
        }
    };
    match recipe {
        "bankTransfer" => Ok(vec![(
            from(),
            acct_of(input.get("to").unwrap()),
            positive(amount_of(input))?,
        )]),
        "businessApprovalHold" => {
            let f = from();
            Ok(vec![(
                f.clone(),
                hold_of(&f, &approval()),
                positive(amount_of(input))?,
            )])
        }
        "businessApprovalRelease" => {
            let f = from();
            Ok(vec![(
                hold_of(&f, &approval()),
                f,
                positive(amount_of(input))?,
            )])
        }
        "businessApprovalSettle" => {
            let f = from();
            let to = acct_of(input.get("to").unwrap());
            if to.3 != "available" {
                return Err("Business approval settle destination must be available".to_owned());
            }
            if f.2 != to.2 {
                return Err("Business approval settle cannot change asset".to_owned());
            }
            Ok(vec![(
                hold_of(&f, &approval()),
                to,
                positive(amount_of(input))?,
            )])
        }
        "businessPayroll" => {
            let f = from();
            let Some(Json::Array(lines)) = input.get("recipients") else {
                panic!("recipients: {}", input.compact());
            };
            if lines.is_empty() {
                return Err("A payroll with no recipients is not a transaction".to_owned());
            }
            let mut seen = vec![f.clone()];
            let mut out = Vec::new();
            for l in lines {
                let to = acct_of(l.get("to").unwrap());
                if to.3 != "available" || to.2 != f.2 || seen.contains(&to) {
                    return Err("a payroll line the recipe refuses".to_owned());
                }
                seen.push(to.clone());
                out.push((f.clone(), to, positive(amount_of(l))?));
            }
            Ok(out)
        }
        other => panic!("the bank does not post {other} here"),
    }
}

/// A hook on each post: its number (from 1), the recipe, its key, and whether it is already booked. An error is the
/// ledger's answer.
pub type Hook = Arc<dyn Fn(u32, &str, &str, bool) -> Result<(), PostFailure> + Send + Sync>;

#[derive(Default)]
pub struct BookState {
    pub balances: BTreeMap<Acct, Amount>,
    /// `(key, recipe, body, tx)`.
    pub journal: Vec<(String, String, String, LedgerTx)>,
    pub calls: u32,
    /// `ledgerThatHidesEntries`: `post` and `getTxByKey` answer no entries; `getTx` still shows them.
    pub hide_entries: bool,
}

#[derive(Clone, Default)]
pub struct Book {
    pub st: Arc<Mutex<BookState>>,
    pub hook: Arc<Mutex<Option<Hook>>>,
}

fn rail(asset: &str) -> Acct {
    (
        "system".to_owned(),
        "rail".to_owned(),
        asset.to_owned(),
        "external".to_owned(),
        String::new(),
    )
}

impl Book {
    /// `recipes.deposit`: `amount` into an account, from the rail.
    pub fn fund(&self, a: &LedgerAccount, amount: &str) {
        let mut st = self.st.lock().unwrap();
        let to = acct(a);
        *st.balances.entry(rail(&to.2)).or_default() -= amt(amount);
        *st.balances.entry(to).or_default() += amt(amount);
    }
    /// `fund(userId, assetId, value)`.
    pub fn fund_user(&self, user: &str, asset: &str, amount: &str) {
        self.fund(&LedgerAccount::user_available(user, asset), amount);
    }
    pub fn balance_of(&self, a: &LedgerAccount) -> String {
        format_amount(
            self.st
                .lock()
                .unwrap()
                .balances
                .get(&acct(a))
                .copied()
                .unwrap_or(0),
        )
    }
    /// `availableOf(userId, assetId)`.
    pub fn available(&self, user: &str, asset: &str) -> String {
        self.balance_of(&LedgerAccount::user_available(user, asset))
    }
    /// The approval's hold, on the debit account's owner.
    pub fn held(&self, from: &LedgerAccount, approval_id: &str) -> String {
        let h = hold_of(&acct(from), approval_id);
        format_amount(
            self.st
                .lock()
                .unwrap()
                .balances
                .get(&h)
                .copied()
                .unwrap_or(0),
        )
    }
    /// The keys booked, in order.
    pub fn keys(&self) -> Vec<String> {
        self.st
            .lock()
            .unwrap()
            .journal
            .iter()
            .map(|j| j.0.clone())
            .collect()
    }
    /// The recipes booked, in order.
    pub fn recipes(&self) -> Vec<String> {
        self.st
            .lock()
            .unwrap()
            .journal
            .iter()
            .map(|j| j.1.clone())
            .collect()
    }
    /// Posts asked of the ledger, booked or not.
    pub fn calls(&self) -> u32 {
        self.st.lock().unwrap().calls
    }
    pub fn set_hook(&self, hook: Option<Hook>) {
        *self.hook.lock().unwrap() = hook;
    }
    pub fn hide_entries(&self) {
        self.st.lock().unwrap().hide_entries = true;
    }
    /// `ledger.reconcile()`: every transaction balances and every asset's accounts sum to zero.
    pub fn reconciles(&self) -> bool {
        let st = self.st.lock().unwrap();
        let mut by_asset: BTreeMap<&str, Amount> = BTreeMap::new();
        for (k, v) in &st.balances {
            *by_asset.entry(&k.2).or_default() += *v;
        }
        by_asset.values().all(|v| *v == 0)
            && st.journal.iter().all(|(_, _, _, t)| {
                let side = |d: &str| -> Amount {
                    t.entries
                        .iter()
                        .filter(|e| e.direction == d)
                        .map(|e| e.amount)
                        .sum()
                };
                side("credit") == side("debit")
            })
    }
    fn shown(&self, t: &LedgerTx) -> LedgerTx {
        let mut t = t.clone();
        if self.st.lock().unwrap().hide_entries {
            t.entries.clear();
        }
        t
    }
}

fn coded(code: &str, message: String) -> PostFailure {
    PostFailure::Coded {
        code: code.to_owned(),
        message,
        attempts: 1,
    }
}

impl Ledger for Book {
    fn balance(&self, a: &LedgerAccount) -> Result<Amount, String> {
        Ok(self
            .st
            .lock()
            .unwrap()
            .balances
            .get(&acct(a))
            .copied()
            .unwrap_or(0))
    }
    fn balances(&self, owner_type: &str, owner: &str) -> Result<Vec<LedgerBalance>, String> {
        Ok(self
            .st
            .lock()
            .unwrap()
            .balances
            .iter()
            .filter(|(k, _)| k.0 == owner_type && k.1 == owner)
            .map(|(k, v)| LedgerBalance {
                asset_id: k.2.clone(),
                kind: k.3.clone(),
                purpose: k.4.clone(),
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
            .st
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|j| j.3.id == tx_id)
            .map(|j| j.3.clone()))
    }
    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        let found = self
            .st
            .lock()
            .unwrap()
            .journal
            .iter()
            .find(|j| j.0 == key)
            .map(|j| j.3.clone());
        Ok(found.map(|t| self.shown(&t)))
    }
    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let n = {
            let mut st = self.st.lock().unwrap();
            st.calls += 1;
            st.calls
        };
        let hook = self.hook.lock().unwrap().clone();
        if let Some(h) = &hook {
            h(n, recipe, key, false)?;
        }
        let body = input.compact();
        let tx = {
            let mut st = self.st.lock().unwrap();
            if let Some(j) = st.journal.iter().find(|j| j.0 == key) {
                if j.1 != recipe || j.2 != body {
                    return Err(coded(
                        "ledger.idempotency_conflict",
                        format!("Idempotency key {key} was used with a different request"),
                    ));
                }
                j.3.clone()
            } else {
                let legs = legs(recipe, input).map_err(|m| coded("ledger.invalid_entry", m))?;
                let mut next = st.balances.clone();
                let mut entries = Vec::new();
                for (from, to, amount) in &legs {
                    *next.entry(from.clone()).or_default() -= *amount;
                    *next.entry(to.clone()).or_default() += *amount;
                    entries.push(TxEntry {
                        account_id: acct_id(from),
                        asset_id: from.2.clone(),
                        direction: "credit".to_owned(),
                        amount: *amount,
                    });
                    entries.push(TxEntry {
                        account_id: acct_id(to),
                        asset_id: to.2.clone(),
                        direction: "debit".to_owned(),
                        amount: *amount,
                    });
                }
                // A payroll's one credit of the whole, as the recipe writes it.
                if recipe == "businessPayroll" {
                    let total: Amount = legs.iter().map(|l| l.2).sum();
                    entries.retain(|e| e.direction == "debit");
                    entries.insert(
                        0,
                        TxEntry {
                            account_id: acct_id(&legs[0].0),
                            asset_id: legs[0].0.2.clone(),
                            direction: "credit".to_owned(),
                            amount: total,
                        },
                    );
                }
                for (from, _, _) in &legs {
                    let left = next.get(from).copied().unwrap_or(0);
                    if from.0 != "system" && left < 0 {
                        let had = st.balances.get(from).copied().unwrap_or(0);
                        return Err(coded(
                            "ledger.insufficient_funds",
                            format!("Insufficient funds: {}", format_amount(had)),
                        ));
                    }
                }
                st.balances = next;
                let tx = LedgerTx {
                    key: key.to_owned(),
                    id: format!("tx-{}", st.journal.len() + 1),
                    posted_at: door::system_now(),
                    entries,
                };
                st.journal
                    .push((key.to_owned(), recipe.to_owned(), body, tx.clone()));
                tx
            }
        };
        if let Some(h) = &hook {
            h(n, recipe, key, true)?;
        }
        Ok(self.shown(&tx))
    }
}

pub fn away() -> PostFailure {
    PostFailure::Unknown("ledger away".to_owned())
}

// ---------------------------------------------------------------------------------------------------------------
// svc-identity: the business directory, the person reads, the same-person consume

#[derive(Default)]
pub struct DirState {
    pub handles: BTreeMap<String, String>,
    pub emails: BTreeMap<String, String>,
    pub names: BTreeMap<String, String>,
    /// Ids that are not active (frozen or closed): never found.
    pub inactive: Vec<String>,
    pub failure: Option<DirError>,
    pub asked: Vec<Vec<String>>,
}

/// `memoryBusinessDirectory`.
#[derive(Clone, Default)]
pub struct People(pub Arc<Mutex<DirState>>);

impl People {
    pub fn person(&self, id: &str, handle: &str, email: Option<&str>) {
        let mut s = self.0.lock().unwrap();
        s.handles.insert(id.to_owned(), handle.to_owned());
        if let Some(e) = email {
            s.emails.insert(e.to_owned(), id.to_owned());
        }
    }
    pub fn name(&self, id: &str, name: &str) {
        self.0
            .lock()
            .unwrap()
            .names
            .insert(id.to_owned(), name.to_owned());
    }
    pub fn deactivate(&self, id: &str) {
        self.0.lock().unwrap().inactive.push(id.to_owned());
    }
    pub fn fail(&self, e: Option<DirError>) {
        self.0.lock().unwrap().failure = e;
    }
}

fn dir_err(e: &DirError) -> DirError {
    *e
}

impl Directory for People {
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        let mut s = self.0.lock().unwrap();
        s.asked.push(ids.to_vec());
        if let Some(e) = &s.failure {
            return Err(dir_err(e));
        }
        Ok(ids
            .iter()
            .filter_map(|i| s.handles.get(i).map(|h| (i.clone(), h.clone())))
            .collect())
    }
    fn find_active(&self, q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        let s = self.0.lock().unwrap();
        if let Some(e) = &s.failure {
            return Err(dir_err(e));
        }
        // `memoryBusinessDirectory`: exact, case-insensitive.
        let id = match q {
            Lookup::Handle(h) => s
                .handles
                .iter()
                .find(|(_, v)| v.to_lowercase() == h.to_lowercase())
                .map(|(k, _)| k.clone()),
            Lookup::Email(e) => s
                .emails
                .iter()
                .find(|(k, _)| k.to_lowercase() == e.to_lowercase())
                .map(|(_, v)| v.clone()),
        };
        Ok(id
            .filter(|i| !s.inactive.contains(i))
            .and_then(|i| s.handles.get(&i).map(|h| (i.clone(), h.clone()))))
    }
    fn published_names(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        let s = self.0.lock().unwrap();
        if let Some(e) = &s.failure {
            return Err(dir_err(e));
        }
        Ok(ids
            .iter()
            .filter_map(|i| s.names.get(i).map(|n| (i.clone(), n.clone())))
            .collect())
    }
}

/// svc-identity's reads, shared between the test and the door.
#[derive(Clone, Default)]
pub struct Identity(pub Arc<MemoryIdentity>);

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
}

#[derive(Default)]
pub struct ApprovalsState {
    rows: BTreeMap<String, Row>,
    pub calls: usize,
}

/// `FakeIdentity`: identity's same-person consume. CAS once; user, session, hash and expiry.
#[derive(Clone, Default)]
pub struct FakeIdentity(pub Arc<Mutex<ApprovalsState>>);

impl FakeIdentity {
    /// An approval for this binding, issued to `user` on `SID` for five minutes.
    pub fn approve(&self, user: &str, b: &Binding) -> String {
        let mut s = self.0.lock().unwrap();
        let id = format!("approval-{}", s.rows.len() + 1);
        s.rows.insert(
            id.clone(),
            Row {
                user_id: user.to_owned(),
                session_id: SID.to_owned(),
                action_type: b.action_type.to_owned(),
                hash: payload_hash(b.action_type, &b.fields),
                expires_at: door::system_now().0 + 300_000,
                consumed: false,
            },
        );
        id
    }
    pub fn calls(&self) -> usize {
        self.0.lock().unwrap().calls
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
        if row.user_id != p.user_id || row.session_id != p.session_id {
            return refused("not_requester");
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
// The bank

/// How the bank is mounted.
pub struct Mount {
    /// `LEDGER_CUSTODY_LAYER`: `on` by default, so business money posts, as on the TypeScript's memory ledger.
    pub custody_layer: &'static str,
    /// `BANK_STEP_UP_MONEY_OUT=required`.
    pub step_up: bool,
}

impl Default for Mount {
    fn default() -> Mount {
        Mount {
            custody_layer: "on",
            step_up: false,
        }
    }
}

pub struct Bank {
    pub door: BankDoor,
    pub db: TestDb,
    pub ledger: Book,
    pub people: People,
    pub identity: Identity,
    pub approvals: FakeIdentity,
}

/// A migrated database and a bank over it; none without `TEST_DATABASE_URL` (the test skips).
pub fn bank() -> Option<Bank> {
    bank_with(Mount::default())
}

pub fn bank_with(m: Mount) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    Some(mount(db, m))
}

/// A bank over an existing database: a second instance over the same tables.
pub fn mount(db: TestDb, m: Mount) -> Bank {
    let ledger = Book::default();
    let people = People::default();
    let identity = Identity::default();
    let approvals = FakeIdentity::default();
    let door = door_over(&db, &ledger, &people, &identity, &approvals, &m);
    Bank {
        door,
        db,
        ledger,
        people,
        identity,
        approvals,
    }
}

/// A door over these stand-ins (a second door sharing a ledger and a database).
pub fn door_over(
    db: &TestDb,
    ledger: &Book,
    people: &People,
    identity: &Identity,
    approvals: &FakeIdentity,
    m: &Mount,
) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity.clone()));
    w.approvals = Box::new(approvals.clone());
    w.settings = Settings {
        step_up_required: m.step_up,
        producer: "svc-bank".to_owned(),
        ..Settings::default()
    };
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
        freeze: Box::new(Open),
        custody_layer: m.custody_layer.to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(ledger.clone()),
        directory: Box::new(people.clone()),
        lookups: Lookups::default(),
        rules: Rules {
            space_limit: Some("50".to_owned()),
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
    .with_transfers(w)
}

impl Bank {
    /// `f` given the slice's dependencies, as a call through the door has them.
    pub fn deps<T>(&self, f: impl FnOnce(&Deps<'_>) -> T) -> T {
        self.door.transfers_deps(f)
    }
    pub fn sql(&self) -> postgres::Client {
        self.db.client()
    }
    pub fn count(&self, sql: &str) -> i64 {
        self.db.count(sql)
    }
    /// `spaces.ensurePrimary(user, asset)`: the space's id.
    pub fn primary(&self, user: &str, asset: &str) -> String {
        with(self.door.store(), |c| space::ensure_primary(c, user, asset))
            .unwrap()
            .id
    }
    /// `spaces.create({ userId, assetId, name })`: the space's id.
    pub fn pot(&self, user: &str, asset: &str, name: &str) -> String {
        let a = call(
            self,
            user,
            WRITE,
            "spaces.create",
            &j(&format!(r#"{{"assetId":"{asset}","name":"{name}"}}"#)),
        );
        s(&a.ok(), "id")
    }
    /// The space's ledger account.
    pub fn account(&self, space_id: &str) -> LedgerAccount {
        with(self.door.store(), |c| space::get(c, space_id))
            .unwrap()
            .ledger_account()
    }
    /// `spaces.balanceOf(space)`.
    pub fn balance(&self, space_id: &str) -> String {
        self.ledger.balance_of(&self.account(space_id))
    }
    /// Funds a space's own account.
    pub fn fund_space(&self, space_id: &str, amount: &str) {
        self.ledger.fund(&self.account(space_id), amount);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Calls through the door

pub fn person(user: &str, scopes: &[&str]) -> Vec<(String, String)> {
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
            if b.is_ascii_alphanumeric() || b"-_.`".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct Answer(pub u16, pub Json);

impl Answer {
    pub fn ok(&self) -> Json {
        assert_eq!(self.0, 200, "{}", self.1.compact());
        self.1
            .get("result")
            .and_then(|r| r.get("data"))
            .cloned()
            .unwrap_or(Json::Null)
    }
    /// The refusal's own code (`cause.code`), `ok`, or `none` for a refusal with no code.
    pub fn code(&self) -> String {
        let cause = self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("cause"))
            .and_then(|c| c.get("code"));
        match (self.0, cause) {
            (200, _) => "ok".to_owned(),
            (_, Some(Json::String(c))) => c.clone(),
            _ => "none".to_owned(),
        }
    }
    /// The tRPC code (`error.data.code`): `FORBIDDEN`, `BAD_REQUEST`, ...
    pub fn trpc(&self) -> String {
        match self
            .1
            .get("error")
            .and_then(|e| e.get("data"))
            .and_then(|d| d.get("code"))
        {
            Some(Json::String(c)) => c.clone(),
            _ => String::new(),
        }
    }
    pub fn message(&self) -> String {
        match self.1.get("error").and_then(|e| e.get("message")) {
            Some(Json::String(m)) => m.clone(),
            _ => String::new(),
        }
    }
    /// `rejects.toMatchObject({ cause: { code } })`.
    pub fn refused(&self, code: &str) {
        assert_eq!(self.code(), code, "{}", self.1.compact());
    }
    pub fn rejected(&self) {
        assert_ne!(self.0, 200, "{}", self.1.compact());
    }
}

/// A call as the person, through the door.
pub fn call(b: &Bank, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    call_door(&b.door, user, scopes, path, input)
}

pub fn call_door(d: &BankDoor, user: &str, scopes: &[&str], path: &str, input: &Json) -> Answer {
    send(d, path, input, person(user, scopes))
}

/// A call signed as `service` (the legacy HMAC), with no person.
pub fn call_as_service(b: &Bank, service: &str, path: &str, input: &Json) -> Answer {
    let body = input.compact();
    let headers = s2s::legacy_headers(service, INTERNAL, &body, system_seconds()).unwrap();
    send(&b.door, path, input, headers)
}

fn send(d: &BankDoor, path: &str, input: &Json, mut headers: Vec<(String, String)>) -> Answer {
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
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    let res = d.handle_from(
        &Request {
            method,
            url: &url,
            headers: &headers,
            body: &body,
        },
        "req-business-db",
        "127.0.0.1",
    );
    Answer(res.status, json::parse(&res.body).unwrap_or(Json::Null))
}

/// A REST door, signed as `service` (or unsigned): the status and the body.
pub fn rest(b: &Bank, service: Option<&str>, url: &str, body: &str) -> (u16, Json) {
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(s) = service {
        headers.extend(s2s::legacy_headers(s, INTERNAL, body, system_seconds()).unwrap());
    }
    let res = b.door.handle(&Request {
        method: "POST",
        url,
        headers: &headers,
        body,
    });
    (res.status, json::parse(&res.body).unwrap_or(Json::Null))
}

pub fn j(text: &str) -> Json {
    json::parse(text).unwrap()
}

pub fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(x)) => x.clone(),
        Some(Json::Null) | None => "null".to_owned(),
        Some(other) => other.compact(),
    }
}

/// `toMatchObject`: every field `expected` names, with the same value (objects recursively, arrays item by item).
pub fn subset(actual: &Json, expected: &Json) -> bool {
    match (actual, expected) {
        (Json::Object(_), Json::Object(want)) => want
            .iter()
            .all(|(k, w)| actual.get(k).is_some_and(|a| subset(a, w))),
        (Json::Array(a), Json::Array(w)) => {
            a.len() == w.len() && a.iter().zip(w).all(|(x, y)| subset(x, y))
        }
        (a, w) => a == w,
    }
}

pub fn has(actual: &Json, expected: &str) {
    assert!(
        subset(actual, &j(expected)),
        "{} does not match {expected}",
        actual.compact()
    );
}

/// A fresh v4 uuid (`randomUUID()` for an id the test does not name).
pub fn uuid() -> String {
    service_kit::approvals::random_uuid().unwrap()
}
