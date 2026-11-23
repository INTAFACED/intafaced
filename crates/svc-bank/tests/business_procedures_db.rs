//! Slice `business`'s customer procedures against the Rust door on a real Postgres. Ports the TypeScript's
//! `business/business-procedures.db.test.ts` (all of it: the describe "business team, history and dual control"),
//! each test named after the TypeScript test's words. Every call there goes through the TypeScript router
//! (`createBankRouter(...).createCaller`), so every call here is a door call (tRPC path `business.*`) as that
//! person, with the same principal (scopes `bank:read`, `bank:write`, session `SID`).
//!
//! The directory is the kit's `People` seeded with the TypeScript's `PEOPLE` (the frozen person is inactive, so never
//! found); a deposit (`recipes.deposit`) is the kit's `fund_user`; `ledger.balance(userAvailable(...))` is
//! `Book::available`. Each test has its own migrated database, as the TypeScript truncates the tables before each.
//! Without `TEST_DATABASE_URL` each test skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! Not ported as written:
//! - `memoryBusinessDirectory` looks a handle or an email up case-insensitively ("Exact, case-insensitive"); the door
//!   here is the kit's door with the kit's directory read through `Folded`, which looks up that way itself, and the
//!   step-up gate on or off.
//! - "requires a fresh confirmation to remove a teammate when step-up is on": the TypeScript builds one bank and calls it
//!   once without the step-up gate (to open the account) and once with it. The Rust door's gate is set when it is mounted
//!   (`BANK_STEP_UP_MONEY_OUT`), so the gated caller is a second door over the same database, ledger and identity
//!   (`door_for(&b, true)`). The approval is issued by the kit's same-person consume (`FakeIdentity`) for the
//!   same action type and fields the TypeScript's `approvingIdentity` hashes.
//! - "stops recipient lookup after the caller budget": the TypeScript mounts `BusinessLookupLimiter({ max: 2 })`; the
//!   Rust `Lookups` has no constructor but its default (30 a minute per caller, the production budget), and the kit
//!   mounts the default. So the caller spends the whole budget of 30 misses, and the next lookup is refused with the
//!   same code and message the TypeScript checks.
//! - "refuses handle reads when the directory is not connected": the TypeScript mounts no directory; here the kit's
//!   directory answers every read as unset (`People::fail(Some(DirError::Unset))`), which is what
//!   `unconfiguredBusinessDirectory` (Rust `NoDirectory`) answers.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::ops::Deref;

use service_kit::json::Json;
use service_kit::s2s_verify::BodyBind;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::spaces::ports::{DirError, Directory, Lookup, Lookups};
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::step_up::Binding;
use svc_bank::transfers::{Settings, Wiring as TransfersWiring};

use crate::business_kit::{
    Answer, Bank, INTERNAL, People, SECRET, WRITE, bank, call_door, has, j, s, uuid,
};

const ADMIN: &str = "11111111-1111-4111-8111-111111111111";
const SECOND: &str = "22222222-2222-4222-8222-222222222222";
const MAKER: &str = "33333333-3333-4333-8333-333333333333";
const CHECKER: &str = "44444444-4444-4444-8444-444444444444";
const PAYEE: &str = "55555555-5555-4555-8555-555555555555";
const FROZEN: &str = "66666666-6666-4666-8666-666666666666";

/// `PEOPLE`: `(userId, handle, email, active)`.
const PEOPLE: &[(&str, &str, &str, bool)] = &[
    (ADMIN, "Ada_Admin", "ada@example.com", true),
    (SECOND, "Bea_Admin", "bea@example.com", true),
    (MAKER, "Max_Maker", "max@example.com", true),
    (CHECKER, "Cara_Check", "cara@example.com", true),
    (PAYEE, "Pat_Payee", "pat@example.com", true),
    (FROZEN, "Fro_Zen", "fro@example.com", false),
];

/// `memoryBusinessDirectory`: the kit's directory, looked up as the TypeScript's double does ("Exact,
/// case-insensitive"); the kit's own `People` matches a handle or an email case-sensitively.
struct Folded(People);

fn same_error(e: &DirError) -> DirError {
    *e
}

impl Directory for Folded {
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        self.0.handles_of(ids)
    }
    fn find_active(&self, q: &Lookup) -> Result<Option<(String, String)>, DirError> {
        let st = self.0.0.lock().unwrap();
        if let Some(e) = &st.failure {
            return Err(same_error(e));
        }
        let id = match q {
            Lookup::Handle(h) => st
                .handles
                .iter()
                .find(|(_, v)| v.to_lowercase() == h.to_lowercase())
                .map(|(k, _)| k.clone()),
            Lookup::Email(e) => st
                .emails
                .iter()
                .find(|(k, _)| k.to_lowercase() == e.to_lowercase())
                .map(|(_, v)| v.clone()),
        };
        Ok(id
            .filter(|i| !st.inactive.contains(i))
            .and_then(|i| st.handles.get(&i).map(|h| (i.clone(), h.clone()))))
    }
    fn published_names(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        self.0.published_names(ids)
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

/// The kit's door (`business_kit::door_over`) with the case-insensitive directory, and the step-up gate on or off.
fn door_for(b: &Bank, step_up: bool) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(b.identity.clone());
    w.lock = Box::new(b.identity.clone());
    w.extras = Box::new(b.identity.clone());
    w.handles = Some(Box::new(b.identity.clone()));
    w.approvals = Box::new(b.approvals.clone());
    w.settings = Settings {
        step_up_required: step_up,
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
        store: b.db.store(),
    })
    .unwrap()
    .with_partner(PartnerWiring {
        partner: None,
        freeze: Box::new(Open),
        custody_layer: "on".to_owned(),
        cash_legs: None,
        pay_in: None,
    })
    .with_spaces(SpacesWiring {
        ledger: Box::new(b.ledger.clone()),
        directory: Box::new(Folded(b.people.clone())),
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

/// A bank and the door the test's callers enter through.
struct Bk {
    b: Bank,
    door: BankDoor,
}

impl Deref for Bk {
    type Target = Bank;
    fn deref(&self) -> &Bank {
        &self.b
    }
}

/// A bank with no directory people yet.
fn bare() -> Option<Bk> {
    let b = bank()?;
    let door = door_for(&b, false);
    Some(Bk { b, door })
}

/// A bank with `memoryBusinessDirectory(PEOPLE)`.
fn seeded() -> Option<Bk> {
    let t = bare()?;
    seed(&t);
    Some(t)
}

fn seed(b: &Bank) {
    for (id, handle, email, active) in PEOPLE {
        b.people.person(id, handle, Some(email));
        if !active {
            b.people.deactivate(id);
        }
    }
}

/// `caller(bank, user).<path>(input)`.
fn c(b: &Bk, user: &str, path: &str, input: &str) -> Answer {
    call_door(&b.door, user, WRITE, path, &j(input))
}

fn create(b: &Bk) -> String {
    let a = c(
        b,
        ADMIN,
        "business.create",
        &format!(
            r#"{{"accountId":"{}","name":"Northwind","assetId":"USDT","spendThreshold":"100"}}"#,
            uuid()
        ),
    );
    s(&a.ok(), "id")
}

/// `openTeam()`: the account's id.
fn open_team(b: &Bk) -> String {
    let id = create(b);
    for (user, role) in [(SECOND, "admin"), (MAKER, "maker"), (CHECKER, "checker")] {
        c(
            b,
            ADMIN,
            "business.addMember",
            &format!(r#"{{"accountId":"{id}","userId":"{user}","role":"{role}"}}"#),
        )
        .ok();
    }
    id
}

fn arr(v: &Json) -> Vec<Json> {
    match v {
        Json::Array(a) => a.clone(),
        other => panic!("not an array: {}", other.compact()),
    }
}

fn field<'a>(v: &'a Json, k: &str) -> &'a Json {
    v.get(k)
        .unwrap_or_else(|| panic!("{k} missing in {}", v.compact()))
}

fn contains(a: &Answer, part: &str) {
    a.rejected();
    assert!(
        a.message().contains(part),
        "{part} not in {}",
        a.1.compact()
    );
}

fn propose(b: &Bk, account: &str, from: &str, to: &str, amount: &str) -> Json {
    c(
        b,
        MAKER,
        "business.proposeTransfer",
        &format!(
            r#"{{"accountId":"{account}","fromSpaceId":"{from}","toSpaceId":"{to}","amount":"{amount}","clientId":"{}"}}"#,
            uuid()
        ),
    )
    .ok()
}

#[test]
fn lists_teammates_by_handle_and_lets_an_admin_remove_or_change_a_role() {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let listed = c(
        &b,
        MAKER,
        "business.members",
        &format!(r#"{{"accountId":"{account}"}}"#),
    )
    .ok();
    let rows: Vec<(String, String)> = arr(field(&listed, "members"))
        .iter()
        .map(|r| (s(r, "handle"), s(r, "role")))
        .collect();
    let want: Vec<(String, String)> = [
        ("Ada_Admin", "admin"),
        ("Bea_Admin", "admin"),
        ("Max_Maker", "maker"),
        ("Cara_Check", "checker"),
    ]
    .iter()
    .map(|(h, r)| ((*h).to_owned(), (*r).to_owned()))
    .collect();
    assert_eq!(rows, want);
    assert_eq!(field(&listed, "pendingControls"), &Json::Array(vec![]));

    let forbidden = c(
        &b,
        MAKER,
        "business.removeMember",
        &format!(
            r#"{{"accountId":"{account}","userId":"{CHECKER}","requestId":"{}"}}"#,
            uuid()
        ),
    );
    assert_eq!(forbidden.trpc(), "CONFLICT", "{}", forbidden.1.compact());
    forbidden.refused("bank.business_role_forbidden");

    let request_id = uuid();
    let remove_maker =
        format!(r#"{{"accountId":"{account}","userId":"{MAKER}","requestId":"{request_id}"}}"#);
    let removed = c(&b, ADMIN, "business.removeMember", &remove_maker).ok();
    assert_eq!(
        removed,
        j(&format!(
            r#"{{"accountId":"{account}","userId":"{MAKER}","removed":true}}"#
        ))
    );
    assert_eq!(
        c(&b, ADMIN, "business.removeMember", &remove_maker).ok(),
        removed
    );
    let other_terms = c(
        &b,
        ADMIN,
        "business.removeMember",
        &format!(r#"{{"accountId":"{account}","userId":"{CHECKER}","requestId":"{request_id}"}}"#),
    );
    assert_eq!(
        other_terms.trpc(),
        "CONFLICT",
        "{}",
        other_terms.1.compact()
    );

    let role_id = uuid();
    let set_role = format!(
        r#"{{"accountId":"{account}","userId":"{CHECKER}","role":"maker","requestId":"{role_id}"}}"#
    );
    has(
        &c(&b, ADMIN, "business.setMemberRole", &set_role).ok(),
        r#"{"role":"maker"}"#,
    );
    has(
        &c(&b, ADMIN, "business.setMemberRole", &set_role).ok(),
        r#"{"role":"maker"}"#,
    );
    c(
        &b,
        ADMIN,
        "business.removeMember",
        &format!(
            r#"{{"accountId":"{account}","userId":"{SECOND}","requestId":"{}"}}"#,
            uuid()
        ),
    )
    .ok();
    let last = c(
        &b,
        ADMIN,
        "business.setMemberRole",
        &format!(
            r#"{{"accountId":"{account}","userId":"{ADMIN}","role":"maker","requestId":"{}"}}"#,
            uuid()
        ),
    );
    assert_eq!(last.trpc(), "PRECONDITION_FAILED", "{}", last.1.compact());
    contains(&last, "bank.business_last_admin");
}

#[test]
fn requires_a_fresh_confirmation_to_remove_a_teammate_when_step_up_is_on() {
    let Some(b) = seeded() else { return };
    let account = create(&b);
    c(
        &b,
        ADMIN,
        "business.addMember",
        &format!(r#"{{"accountId":"{account}","userId":"{MAKER}","role":"maker"}}"#),
    )
    .ok();
    let gated = door_for(&b, true);
    let request_id = uuid();
    let bare = call_door(
        &gated,
        ADMIN,
        WRITE,
        "business.removeMember",
        &j(&format!(
            r#"{{"accountId":"{account}","userId":"{MAKER}","requestId":"{request_id}"}}"#
        )),
    );
    contains(&bare, "bank.step_up_required");
    let approval_id = b.approvals.approve(
        ADMIN,
        &Binding {
            action_type: "bank.step_up.business.removeMember",
            fields: [
                ("actor", ADMIN),
                ("accountId", account.as_str()),
                ("userId", MAKER),
                ("requestId", request_id.as_str()),
            ]
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
            operation_key: request_id.clone(),
        },
    );
    let confirmed = call_door(
        &gated,
        ADMIN,
        WRITE,
        "business.removeMember",
        &j(&format!(
            r#"{{"accountId":"{account}","userId":"{MAKER}","requestId":"{request_id}","stepUpApprovalId":"{approval_id}"}}"#
        )),
    );
    has(&confirmed.ok(), r#"{"removed":true}"#);
}

#[test]
fn resolves_a_receiving_space_by_handle_or_email_and_gives_one_miss_for_the_rest() {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let space = b.primary(PAYEE, "USDT");
    let ask = |rest: &str| {
        c(
            &b,
            ADMIN,
            "business.resolveRecipientSpace",
            &format!(r#"{{"accountId":"{account}",{rest}}}"#),
        )
    };
    let found = |asset: &str, space: Option<&str>| {
        j(&format!(
            r#"{{"found":true,"handle":"Pat_Payee","assetId":"{asset}","spaceId":{}}}"#,
            space.map_or("null".to_owned(), |s| format!(r#""{s}""#))
        ))
    };
    let miss = j(r#"{"found":false}"#);
    assert_eq!(
        ask(r#""assetId":"USDT","handle":" @pat_payee ""#).ok(),
        found("USDT", Some(&space))
    );
    assert_eq!(
        ask(r#""assetId":"USDT","email":"PAT@example.com""#).ok(),
        found("USDT", Some(&space))
    );
    assert_eq!(
        ask(r#""assetId":"EUR","handle":"Pat_Payee""#).ok(),
        found("EUR", None)
    );
    assert_eq!(ask(r#""assetId":"USDT","handle":"Fro_Zen""#).ok(), miss);
    assert_eq!(ask(r#""assetId":"USDT","handle":"nobody_here""#).ok(), miss);
    assert_eq!(ask(r#""assetId":"USDT","email":"nope""#).ok(), miss);
    let both = ask(r#""assetId":"USDT","handle":"Pat_Payee","email":"pat@example.com""#);
    assert_eq!(both.trpc(), "BAD_REQUEST", "{}", both.1.compact());
    contains(&both, "bank.business_recipient_query");
}

#[test]
fn stops_recipient_lookup_after_the_caller_budget() {
    let Some(b) = seeded() else { return };
    let account = create(&b);
    let ask = |handle: &str| {
        c(
            &b,
            ADMIN,
            "business.resolveRecipientSpace",
            &format!(r#"{{"accountId":"{account}","assetId":"USDT","handle":"{handle}"}}"#),
        )
    };
    // The budget is the default 30 (see the module's note), where the TypeScript mounts 2.
    for _ in 0..30 {
        ask("nobody_here").ok();
    }
    let over = ask("Pat_Payee");
    assert_eq!(over.trpc(), "TOO_MANY_REQUESTS", "{}", over.1.compact());
    contains(&over, "bank.business_directory_rate_limited");
}

#[test]
fn refuses_handle_reads_when_the_directory_is_not_connected() {
    let Some(b) = bare() else { return };
    b.people.fail(Some(DirError::Unset));
    let account = create(&b);
    let members = c(
        &b,
        ADMIN,
        "business.members",
        &format!(r#"{{"accountId":"{account}"}}"#),
    );
    assert_eq!(
        members.trpc(),
        "PRECONDITION_FAILED",
        "{}",
        members.1.compact()
    );
    contains(&members, "bank.business_directory_unset");
    let approvals = c(
        &b,
        ADMIN,
        "business.approvals",
        &format!(r#"{{"accountId":"{account}","limit":20}}"#),
    );
    contains(&approvals, "bank.business_directory_unset");
    let lookup = c(
        &b,
        ADMIN,
        "business.resolveRecipientSpace",
        &format!(r#"{{"accountId":"{account}","assetId":"USDT","handle":"Pat_Payee"}}"#),
    );
    contains(&lookup, "IDENTITY_URL is unset");
}

#[test]
fn pages_approval_history_by_handle_and_keeps_pending_as_the_waiting_queue() {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let from = b.primary(MAKER, "USDT");
    let to = b.primary(PAYEE, "USDT");
    b.ledger.fund_user(MAKER, "USDT", "500");
    let posted = propose(&b, &account, &from, &to, "10");
    assert_eq!(s(&posted, "kind"), "posted");
    let pending = propose(&b, &account, &from, &to, "100");
    assert_eq!(s(&pending, "kind"), "pending");
    let waiting = arr(&c(
        &b,
        MAKER,
        "business.pending",
        &format!(r#"{{"accountId":"{account}","limit":20}}"#),
    )
    .ok());
    assert_eq!(waiting.len(), 1);
    has(
        &waiting[0],
        r#"{"makerHandle":"Max_Maker","receiverOwnerHandle":"Pat_Payee","status":"pending"}"#,
    );
    assert!(
        waiting[0].get("makerUserId").is_none(),
        "{}",
        waiting[0].compact()
    );
    assert!(
        waiting[0].get("checkerUserId").is_none(),
        "{}",
        waiting[0].compact()
    );

    let history = c(
        &b,
        CHECKER,
        "business.approvals",
        &format!(r#"{{"accountId":"{account}","limit":1}}"#),
    )
    .ok();
    let first = arr(field(&history, "items"));
    assert_eq!(first.len(), 1);
    let Some(Json::String(cursor)) = history.get("nextCursor") else {
        panic!("nextCursor is not a string: {}", history.compact());
    };
    assert!(
        first[0].get("makerUserId").is_none(),
        "{}",
        first[0].compact()
    );
    assert!(
        first[0].get("checkerUserId").is_none(),
        "{}",
        first[0].compact()
    );
    let rest = c(
        &b,
        CHECKER,
        "business.approvals",
        &format!(r#"{{"accountId":"{account}","limit":10,"cursor":"{cursor}"}}"#),
    )
    .ok();
    let handles: Vec<Json> = first
        .iter()
        .chain(arr(field(&rest, "items")).iter())
        .map(|r| {
            Json::Array(vec![
                field(r, "status").clone(),
                field(r, "makerHandle").clone(),
                field(r, "checkerHandle").clone(),
            ])
        })
        .collect();
    assert_eq!(handles.len(), 2);
    for want in [
        j(r#"["pending","Max_Maker",null]"#),
        j(r#"["approved","Max_Maker",null]"#),
    ] {
        assert!(
            handles.contains(&want),
            "{} not in {:?}",
            want.compact(),
            handles.iter().map(Json::compact).collect::<Vec<_>>()
        );
    }
    let decided = c(
        &b,
        CHECKER,
        "business.approvals",
        &format!(r#"{{"accountId":"{account}","status":"approved","limit":10}}"#),
    )
    .ok();
    let statuses: Vec<String> = arr(field(&decided, "items"))
        .iter()
        .map(|r| s(r, "status"))
        .collect();
    assert_eq!(statuses, vec!["approved".to_owned()]);
    let unset = c(
        &b,
        CHECKER,
        "business.approvals",
        &format!(r#"{{"accountId":"{account}"}}"#),
    );
    assert_eq!(unset.trpc(), "BAD_REQUEST", "{}", unset.1.compact());
    unset.refused("bank.business_approvals_list_limit_unset");
}

#[test]
fn changes_the_threshold_and_closes_only_when_a_second_administrator_confirms() {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let request_id = uuid();
    let threshold = |user: &str, t: &str, rid: &str| {
        c(
            &b,
            user,
            "business.setThreshold",
            &format!(r#"{{"accountId":"{account}","spendThreshold":"{t}","requestId":"{rid}"}}"#),
        )
    };
    let first = threshold(ADMIN, "40", &request_id).ok();
    assert_eq!(s(&first, "status"), "pending");
    assert_eq!(s(field(&first, "account"), "spendThreshold"), "100");
    has(
        &threshold(ADMIN, "40", &request_id).ok(),
        r#"{"status":"pending"}"#,
    );
    let other_terms = threshold(ADMIN, "41", &request_id);
    assert_eq!(
        other_terms.trpc(),
        "CONFLICT",
        "{}",
        other_terms.1.compact()
    );
    contains(
        &threshold(SECOND, "80", &uuid()),
        "bank.business_change_pending",
    );
    let applied = threshold(SECOND, "40.00", &request_id).ok();
    has(
        &applied,
        r#"{"status":"applied","account":{"spendThreshold":"40"}}"#,
    );
    let team = c(
        &b,
        ADMIN,
        "business.members",
        &format!(r#"{{"accountId":"{account}"}}"#),
    )
    .ok();
    assert_eq!(field(&team, "pendingControls"), &Json::Array(vec![]));

    let close_id = uuid();
    let close = |user: &str, rid: &str| {
        c(
            &b,
            user,
            "business.close",
            &format!(r#"{{"accountId":"{account}","requestId":"{rid}"}}"#),
        )
    };
    has(
        &close(ADMIN, &close_id).ok(),
        r#"{"status":"pending","account":{"status":"active"}}"#,
    );
    let closed = close(SECOND, &close_id).ok();
    has(
        &closed,
        r#"{"status":"applied","account":{"status":"closed"}}"#,
    );
    let visible = c(&b, ADMIN, "business.list", r#"{"limit":20}"#).ok();
    let statuses: Vec<String> = arr(&visible).iter().map(|r| s(r, "status")).collect();
    assert_eq!(statuses, vec!["closed".to_owned()]);
    let again = close(ADMIN, &uuid());
    assert_eq!(again.trpc(), "CONFLICT", "{}", again.1.compact());
    again.refused("bank.business_closed");
}

#[test]
fn will_not_close_while_a_payment_is_still_waiting() {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let from = b.primary(MAKER, "USDT");
    let to = b.primary(PAYEE, "USDT");
    b.ledger.fund_user(MAKER, "USDT", "500");
    propose(&b, &account, &from, &to, "100");
    let blocked = c(
        &b,
        ADMIN,
        "business.close",
        &format!(r#"{{"accountId":"{account}","requestId":"{}"}}"#, uuid()),
    );
    contains(&blocked, "bank.business_close_blocked");
    assert_eq!(b.ledger.available(MAKER, "USDT"), "400");
}

#[test]
fn refuses_to_remove_a_maker_who_still_holds_their_own_payment_and_that_maker_can_cancel_after_the_membership_row_is_gone()
 {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let from = b.primary(MAKER, "USDT");
    let to = b.primary(PAYEE, "USDT");
    b.ledger.fund_user(MAKER, "USDT", "500");
    let pending = propose(&b, &account, &from, &to, "100");
    assert_eq!(s(&pending, "kind"), "pending");
    let approval_id = s(field(&pending, "approval"), "id");
    let refused = c(
        &b,
        ADMIN,
        "business.removeMember",
        &format!(
            r#"{{"accountId":"{account}","userId":"{MAKER}","requestId":"{}"}}"#,
            uuid()
        ),
    );
    assert_eq!(
        refused.trpc(),
        "PRECONDITION_FAILED",
        "{}",
        refused.1.compact()
    );
    refused.refused("bank.business_member_has_pending");
    let listed = c(
        &b,
        ADMIN,
        "business.members",
        &format!(r#"{{"accountId":"{account}"}}"#),
    )
    .ok();
    let ids: Vec<String> = arr(field(&listed, "members"))
        .iter()
        .map(|r| s(r, "userId"))
        .collect();
    assert!(ids.contains(&MAKER.to_owned()), "{ids:?}");
    b.sql()
        .execute(
            "DELETE FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
            &[&account, &MAKER],
        )
        .unwrap();
    c(
        &b,
        MAKER,
        "business.cancel",
        &format!(r#"{{"approvalId":"{approval_id}"}}"#),
    )
    .ok();
    assert_eq!(b.ledger.available(MAKER, "USDT"), "500");
}

#[test]
fn lets_an_administrator_withdraw_a_pending_threshold_so_another_proposal_can_start() {
    let Some(b) = seeded() else { return };
    let account = open_team(&b);
    let request_id = uuid();
    let threshold = |user: &str, t: &str, rid: &str| {
        c(
            &b,
            user,
            "business.setThreshold",
            &format!(r#"{{"accountId":"{account}","spendThreshold":"{t}","requestId":"{rid}"}}"#),
        )
    };
    let cancel = || {
        c(
            &b,
            ADMIN,
            "business.cancelControl",
            &format!(r#"{{"accountId":"{account}","requestId":"{request_id}"}}"#),
        )
    };
    has(
        &threshold(ADMIN, "40", &request_id).ok(),
        r#"{"status":"pending","account":{"spendThreshold":"100"}}"#,
    );
    let busy = threshold(SECOND, "80", &uuid());
    assert_eq!(busy.trpc(), "CONFLICT", "{}", busy.1.compact());
    busy.refused("bank.business_change_pending");
    has(
        &cancel().ok(),
        &format!(
            r#"{{"status":"cancelled","requestId":"{request_id}","account":{{"spendThreshold":"100"}}}}"#
        ),
    );
    has(
        &cancel().ok(),
        &format!(r#"{{"status":"cancelled","requestId":"{request_id}"}}"#),
    );
    let inactive = threshold(SECOND, "40", &request_id);
    assert_eq!(inactive.trpc(), "CONFLICT", "{}", inactive.1.compact());
    inactive.refused("bank.business_approval_inactive");
    let still = arr(&c(&b, ADMIN, "business.list", r#"{"limit":20}"#).ok());
    let row = still
        .iter()
        .find(|r| s(r, "id") == account)
        .expect("the account is listed");
    assert_eq!(s(row, "spendThreshold"), "100");
    let next_id = uuid();
    has(
        &threshold(SECOND, "80", &next_id).ok(),
        &format!(
            r#"{{"status":"pending","requestId":"{next_id}","account":{{"spendThreshold":"100"}}}}"#
        ),
    );
    let team = c(
        &b,
        ADMIN,
        "business.members",
        &format!(r#"{{"accountId":"{account}"}}"#),
    )
    .ok();
    let ids: Vec<String> = arr(field(&team, "pendingControls"))
        .iter()
        .map(|r| s(r, "requestId"))
        .collect();
    assert_eq!(ids, vec![next_id]);
}
