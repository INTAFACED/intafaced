//! J-bank-19 through the door (BK-biz-01 to BK-biz-04): the checks of `business/business-team.db.test.ts`, a business
//! bank team and its approval rules with the business's money at the TEST partner bank. Roles grant only what their
//! maker holds; an advisor waits for the owner; invites expire, are sent again and are revoked; a TEST 6000.00 payment
//! under rules over 1000.00 (one approver) and over 5000.00 (two) needs two distinct approvers, the maker is refused,
//! and the second approval sends one instruction to the partner, once, even when the partner's answer is lost; the
//! ledger posts nothing; team spend equals the partner's lines.
//!
//! Ported as unit tests in `src/business_team/service.rs`: "the roles a named role fits" and "the rule that applies is
//! the one asking the most approvals". Not here: "the TEST age door" test, whose door is the partner slice's and whose
//! business-invite subject `tests/partner_db.rs` holds; its expiry and refusal by name are held here by `#3`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::s2s_verify::BodyBind;
use svc_bank::business_team::service::payment_key;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, MovesQuery, TestPartner};
use svc_bank::spaces::ports::Lookups;
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::{Settings, Wiring as TransfersWiring};

use crate::business_kit::{
    Answer, Book, FakeIdentity, INTERNAL, Identity, People, SECRET, WRITE, call_door, has, j, s,
    uuid,
};
use crate::support::TestDb;

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

const OWNER: u32 = 1;
const BOOK: u32 = 2;
const OFFICE: u32 = 3;
const A1: u32 = 4;
const A2: u32 = 5;
const ADVISOR: u32 = 6;
const NEWCOMER: u32 = 7;

/// svc-ledger's posting freeze as the test sets it: open, frozen, or unreadable.
#[derive(Clone)]
struct Switch(Arc<Mutex<Option<bool>>>);

impl Freeze for Switch {
    fn read(&self) -> Result<FreezeReading, String> {
        match *self.0.lock().unwrap() {
            Some(open) => Ok(FreezeReading {
                posting_enabled: open,
                cause: (!open).then(|| "person".to_owned()),
            }),
            None => Err("the freeze cannot be read".to_owned()),
        }
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    people: People,
    freeze: Switch,
}

/// A door over the stand-ins: the TEST partner on, the ledger counting every post, the invite lifetime `minutes`.
fn door_over(
    db: &TestDb,
    ledger: &Book,
    people: &People,
    freeze: &Switch,
    minutes: Option<&str>,
) -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let identity = Identity::default();
    let mut w = TransfersWiring::none();
    w.recipients = Box::new(identity.clone());
    w.lock = Box::new(identity.clone());
    w.extras = Box::new(identity.clone());
    w.handles = Some(Box::new(identity));
    w.approvals = Box::new(FakeIdentity::default());
    w.settings = Settings {
        producer: "svc-bank".to_owned(),
        business_invite_minutes: minutes.map(str::to_owned),
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
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(freeze.clone()),
        custody_layer: "off".to_owned(),
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

fn bank() -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let people = People::default();
    for (n, handle) in [
        (OWNER, "owner"),
        (BOOK, "book"),
        (OFFICE, "office"),
        (A1, "approver1"),
        (A2, "approver2"),
        (ADVISOR, "advisor"),
        (NEWCOMER, "newcomer"),
    ] {
        people.person(&id(n), handle, Some(&format!("{handle}@example.test")));
    }
    let freeze = Switch(Arc::new(Mutex::new(Some(true))));
    let door = door_over(&db, &ledger, &people, &freeze, Some("2"));
    Some(Bank {
        door,
        db,
        ledger,
        people,
        freeze,
    })
}

impl Bank {
    fn call(&self, who: u32, path: &str, input: &str) -> Answer {
        call_door(&self.door, &id(who), WRITE, path, &j(input))
    }

    fn ok(&self, who: u32, path: &str, input: &str) -> Json {
        self.call(who, path, input).ok()
    }

    fn partner(&self) -> &TestPartner {
        self.door.partner().partner.as_ref().unwrap()
    }

    /// The partner's moves out of the business's own account.
    fn moves(&self, account_id: &str) -> Vec<svc_bank::partner::Move> {
        self.partner().lock().moves(
            &format!("business:{account_id}"),
            &MovesQuery {
                limit: 50,
                ..MovesQuery::default()
            },
        )
    }

    fn balance(&self, account_id: &str) -> String {
        let b = self.partner().lock().report(
            &AccountRef::main(&format!("business:{account_id}"), "USDT"),
            door::system_now(),
        );
        format_amount(b.amount.unwrap())
    }

    /// The next answer the partner gives for `user` is lost after the move is made.
    fn lose_next_reply(&self, user: &str) {
        let mut p = self.partner().lock();
        let mut sw = p.board.get(user);
        "lost".clone_into(&mut sw.next_reply);
        p.board.set(user, sw);
    }

    /// The ledger posted nothing.
    fn ledger_untouched(&self) {
        assert_eq!(self.ledger.calls(), 0, "{:?}", self.ledger.keys());
    }

    /// The owner's business with its money at the TEST partner: TEST 10000 USDT in the business's own partner account.
    fn business(&self) -> String {
        self.ok(OWNER, "testPartner.set", r#"{"custody":"off"}"#);
        let account_id = uuid();
        self.ok(
            OWNER,
            "business.create",
            &format!(r#"{{"accountId":"{account_id}","name":"TEST Team Ltd","assetId":"USDT","spendThreshold":"1"}}"#),
        );
        self.ok(
            OWNER,
            "testPartner.fundBusiness",
            &format!(
                r#"{{"accountId":"{account_id}","fundId":"fund-{account_id}","amount":"10000"}}"#
            ),
        );
        account_id
    }

    fn invite(
        &self,
        who: u32,
        account_id: &str,
        role: Option<&str>,
        role_id: Option<&str>,
    ) -> Answer {
        let q = |v: Option<&str>| v.map_or_else(|| "null".to_owned(), |v| format!(r#""{v}""#));
        self.call(
            who,
            "businessTeam.invite",
            &format!(
                r#"{{"accountId":"{account_id}","inviteId":"{}","email":null,"role":{},"roleId":{}}}"#,
                uuid(),
                q(role),
                q(role_id)
            ),
        )
    }

    fn join(&self, account_id: &str, user: u32, role: Option<&str>, role_id: Option<&str>) {
        let made = self.invite(OWNER, account_id, role, role_id).ok();
        self.ok(
            user,
            "businessTeam.acceptInvite",
            &format!(r#"{{"token":"{}"}}"#, s(&made, "token")),
        );
    }

    fn create_role(&self, who: u32, account_id: &str, name: &str, permissions: &str) -> Answer {
        self.call(
            who,
            "businessTeam.createRole",
            &format!(
                r#"{{"accountId":"{account_id}","roleId":"{}","name":"{name}","permissions":{permissions}}}"#,
                uuid()
            ),
        )
    }

    fn add_rule(&self, account_id: &str, over: &str, approvals: u32) -> Json {
        self.ok(
            OWNER,
            "businessTeam.addRule",
            &format!(
                r#"{{"accountId":"{account_id}","ruleId":"{}","overAmount":"{over}","payee":null,"paymentType":null,"approvals":{approvals}}}"#,
                uuid()
            ),
        )
    }

    fn propose(
        &self,
        who: u32,
        account_id: &str,
        payment_id: &str,
        payee: &str,
        amount: &str,
    ) -> Answer {
        self.call(
            who,
            "businessTeam.propose",
            &format!(
                r#"{{"accountId":"{account_id}","paymentId":"{payment_id}","payee":"{payee}","paymentType":"domestic","amount":"{amount}"}}"#
            ),
        )
    }

    fn on_payment(&self, who: u32, path: &str, payment_id: &str) -> Answer {
        self.call(who, path, &format!(r#"{{"paymentId":"{payment_id}"}}"#))
    }

    fn account(&self, account_id: &str) -> String {
        format!(r#"{{"accountId":"{account_id}"}}"#)
    }
}

fn names(list: &Json, key: &str) -> Vec<String> {
    match list {
        Json::Array(items) => items.iter().map(|i| s(i, key)).collect(),
        other => panic!("not a list: {}", other.compact()),
    }
}

fn find<'a>(list: &'a Json, key: &str, value: &str) -> &'a Json {
    match list {
        Json::Array(items) => items.iter().find(|i| s(i, key) == value).unwrap(),
        other => panic!("not a list: {}", other.compact()),
    }
}

#[test]
fn n1_a_bookkeeper_with_view_and_export_is_refused_approvals_and_a_role_beyond_its_maker_is_refused()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let book = b
        .create_role(OWNER, &acc, "Bookkeeper", r#"["view","export"]"#)
        .ok();
    has(&book, r#"{"permissions":["view","export"]}"#);
    let office = b
        .create_role(OWNER, &acc, "Office", r#"["view","manage_team"]"#)
        .ok();
    b.join(&acc, BOOK, None, Some(&s(&book, "id")));
    b.join(&acc, OFFICE, None, Some(&s(&office, "id")));
    b.join(&acc, A1, Some("checker"), None);
    b.join(&acc, A2, Some("checker"), None);
    // The office manager holds manage_team but not approve: a role granting approve is refused, and nothing is created.
    b.create_role(OFFICE, &acc, "Approver", r#"["view","approve"]"#)
        .refused("bank.business_role_grant_exceeds");
    assert_eq!(
        names(&b.ok(OWNER, "businessTeam.roles", &b.account(&acc)), "name"),
        ["Bookkeeper", "Office"]
    );
    // The bookkeeper sees the waiting payment and cannot approve it.
    let payment = uuid();
    b.add_rule(&acc, "1000", 1);
    b.propose(OWNER, &acc, &payment, "TEST Supplier", "1500")
        .ok();
    has(
        &b.on_payment(BOOK, "businessTeam.payment", &payment).ok(),
        r#"{"status":"pending"}"#,
    );
    b.on_payment(BOOK, "businessTeam.approve", &payment)
        .refused("bank.business_role_forbidden");
    b.propose(BOOK, &acc, &uuid(), "x", "1")
        .refused("bank.business_role_forbidden");
}

#[test]
fn a_named_role_narrows_the_older_business_doors_too() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let book = s(
        &b.create_role(OWNER, &acc, "Bookkeeper", r#"["view","export"]"#)
            .ok(),
        "id",
    );
    b.join(&acc, A1, Some("checker"), None);
    b.join(&acc, A2, Some("admin"), None);
    let eligibility = |user: u32| {
        b.door.transfers_deps(|d| {
            svc_bank::business::service::approver_eligibility(d, &acc, &id(user)).unwrap()
        })
    };
    has(&eligibility(A1), r#"{"state":"eligible"}"#);
    let assign = |user: u32| {
        b.ok(
            OWNER,
            "businessTeam.assignRole",
            &format!(
                r#"{{"accountId":"{acc}","userId":"{}","roleId":"{book}"}}"#,
                id(user)
            ),
        )
    };
    assign(A1);
    assign(A2);
    // svc-pay's withdrawal approver check and the transfer doors read the same row: both are viewers there now.
    has(
        &eligibility(A1),
        r#"{"state":"role_cannot_approve","role":"viewer"}"#,
    );
    has(
        &b.ok(A1, "business.myRole", &b.account(&acc)),
        r#"{"role":"viewer"}"#,
    );
    has(
        &b.ok(A2, "business.myRole", &b.account(&acc)),
        r#"{"role":"viewer"}"#,
    );
    b.call(
        A2,
        "business.proposeTransfer",
        &format!(
            r#"{{"accountId":"{acc}","fromSpaceId":"{}","toSpaceId":"{}","amount":"1","clientId":"{}"}}"#,
            uuid(),
            uuid(),
            uuid()
        ),
    )
    .refused("bank.business_role_forbidden");
    b.call(
        A2,
        "business.addMember",
        &format!(
            r#"{{"accountId":"{acc}","userId":"{}","role":"admin"}}"#,
            id(BOOK)
        ),
    )
    .refused("bank.business_role_forbidden");
    // A role the inviter names seats the newcomer on the role it fits, never wider.
    let pay = s(
        &b.create_role(OWNER, &acc, "Payer", r#"["view","propose"]"#)
            .ok(),
        "id",
    );
    b.join(&acc, BOOK, None, Some(&pay));
    has(
        &b.ok(BOOK, "business.myRole", &b.account(&acc)),
        r#"{"role":"maker"}"#,
    );
    has(&eligibility(BOOK), r#"{"state":"role_cannot_approve"}"#);
    // A role without view is refused: every member reads the business.
    b.create_role(OWNER, &acc, "Export", r#"["export"]"#)
        .refused("bank.business_role_invalid");
    // Setting a built-in role through the member door is the member's whole role again.
    b.ok(
        OWNER,
        "business.setMemberRole",
        &format!(
            r#"{{"accountId":"{acc}","userId":"{}","role":"checker","requestId":"{}"}}"#,
            id(A1),
            uuid()
        ),
    );
    let members = b.ok(OWNER, "businessTeam.members", &b.account(&acc));
    has(
        find(&members, "userId", &id(A1)),
        r#"{"role":"checker","customRole":null,"permissions":["view","approve"]}"#,
    );
}

#[test]
fn n2_an_advisor_added_by_anyone_but_the_owner_waits_and_only_the_owner_approves() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let office = s(
        &b.create_role(OWNER, &acc, "Office", r#"["view","manage_team"]"#)
            .ok(),
        "id",
    );
    b.join(&acc, OFFICE, None, Some(&office));
    let added = b.ok(
        OFFICE,
        "businessTeam.addAdvisor",
        &format!(r#"{{"accountId":"{acc}","handle":"@advisor"}}"#),
    );
    has(&added, r#"{"status":"pending","addedByHandle":"office"}"#);
    b.call(ADVISOR, "businessTeam.overview", &b.account(&acc))
        .refused("bank.business_not_member");
    let approve = format!(r#"{{"accountId":"{acc}","userId":"{}"}}"#, id(ADVISOR));
    b.call(OFFICE, "businessTeam.approveAdvisor", &approve)
        .refused("bank.business_owner_only");
    has(
        &b.ok(OWNER, "businessTeam.approveAdvisor", &approve),
        r#"{"status":"approved"}"#,
    );
    let seen = b.ok(ADVISOR, "businessTeam.overview", &b.account(&acc));
    has(&seen, r#"{"me":{"advisor":true,"permissions":["view"]}}"#);
    b.call(
        ADVISOR,
        "businessTeam.addRule",
        &format!(
            r#"{{"accountId":"{acc}","ruleId":"{}","overAmount":"1","payee":null,"paymentType":null,"approvals":1}}"#,
            uuid()
        ),
    )
    .refused("bank.business_role_forbidden");
}

#[test]
fn n3_an_email_invite_is_for_that_email_an_expired_one_refuses_and_is_sent_again_a_revoked_one_refuses()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let to_new = b.ok(
        OWNER,
        "businessTeam.invite",
        &format!(
            r#"{{"accountId":"{acc}","inviteId":"{}","email":"Newcomer@example.test","role":"viewer","roleId":null}}"#,
            uuid()
        ),
    );
    has(
        &to_new,
        r#"{"invite":{"kind":"email","email":"newcomer@example.test","status":"open"}}"#,
    );
    let accept = |who: u32, token: &str| {
        b.call(
            who,
            "businessTeam.acceptInvite",
            &format!(r#"{{"token":"{token}"}}"#),
        )
    };
    accept(A1, &s(&to_new, "token")).refused("bank.business_invite_wrong_person");
    has(
        &accept(NEWCOMER, &s(&to_new, "token")).ok(),
        r#"{"member":{"role":"viewer"}}"#,
    );

    let link = b.invite(OWNER, &acc, Some("checker"), None).ok();
    let link_id = s(link.get("invite").unwrap(), "id");
    b.db.client()
        .execute(
            "UPDATE bank.business_invites SET expires_at = now() - interval '1 second' WHERE id = $1::text::uuid",
            &[&link_id],
        )
        .unwrap();
    accept(A1, &s(&link, "token")).refused("bank.business_invite_expired");
    let invites = b.ok(OWNER, "businessTeam.invites", &b.account(&acc));
    has(find(&invites, "id", &link_id), r#"{"status":"expired"}"#);
    let again = b.ok(
        OWNER,
        "businessTeam.resendInvite",
        &format!(
            r#"{{"accountId":"{acc}","inviteId":"{link_id}","newInviteId":"{}"}}"#,
            uuid()
        ),
    );
    accept(A1, &s(&link, "token")).refused("bank.business_invite_replaced");
    has(
        &accept(A1, &s(&again, "token")).ok(),
        r#"{"member":{"role":"checker"}}"#,
    );

    let revoked = b.invite(OWNER, &acc, Some("viewer"), None).ok();
    b.ok(
        OWNER,
        "businessTeam.revokeInvite",
        &format!(
            r#"{{"accountId":"{acc}","inviteId":"{}"}}"#,
            s(revoked.get("invite").unwrap(), "id")
        ),
    );
    accept(A2, &s(&revoked, "token")).refused("bank.business_invite_revoked");

    // The owner has not set how long an invite lasts: every invite refuses by name.
    let unset = door_over(&b.db, &b.ledger, &b.people, &b.freeze, None);
    call_door(
        &unset,
        &id(OWNER),
        WRITE,
        "businessTeam.invite",
        &j(&format!(
            r#"{{"accountId":"{acc}","inviteId":"{}","email":null,"role":"viewer","roleId":null}}"#,
            uuid()
        )),
    )
    .refused("bank.business_invite_lifetime_unset");
}

#[test]
fn n4_a_member_of_two_businesses_reads_each_by_its_own_id() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, Some("checker"), None);
    let second = uuid();
    b.ok(
        A1,
        "business.create",
        &format!(r#"{{"accountId":"{second}","name":"TEST Second Ltd","assetId":"USDT","spendThreshold":"1"}}"#),
    );
    has(
        &b.ok(A1, "businessTeam.overview", &b.account(&acc)),
        r#"{"account":{"name":"TEST Team Ltd"}}"#,
    );
    has(
        &b.ok(A1, "businessTeam.overview", &b.account(&second)),
        r#"{"account":{"name":"TEST Second Ltd"}}"#,
    );
    assert_eq!(
        names(
            &b.ok(A1, "businessTeam.members", &b.account(&second)),
            "handle"
        ),
        ["approver1"]
    );
    b.call(OWNER, "businessTeam.overview", &b.account(&second))
        .refused("bank.business_not_member");
}

#[test]
fn n5_n6_6000_under_the_test_rules_needs_two_distinct_approvers_and_the_second_sends_once() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, Some("checker"), None);
    b.join(&acc, A2, Some("checker"), None);
    b.add_rule(&acc, "1000", 1);
    let two = b.add_rule(&acc, "5000", 2);
    let payment = uuid();
    let proposed = b
        .propose(OWNER, &acc, &payment, "TEST Supplier", "6000.00")
        .ok();
    has(
        &proposed,
        &format!(
            r#"{{"status":"pending","approvalsNeeded":2,"rule":{{"id":"{}","overAmount":"5000"}},"partnerMoveId":null}}"#,
            s(&two, "id")
        ),
    );
    // The owner holds approve and is in the pool, but proposed it.
    b.on_payment(OWNER, "businessTeam.approve", &payment)
        .refused("bank.business_self_approve");
    has(
        &b.on_payment(A1, "businessTeam.approve", &payment).ok(),
        r#"{"status":"pending"}"#,
    );
    b.on_payment(A1, "businessTeam.approve", &payment)
        .refused("bank.business_already_approved");
    assert!(
        b.partner()
            .lock()
            .book
            .by_key(&payment_key(&payment))
            .is_none()
    );
    // The partner loses its answer to the second approval: the move is made, and its outcome is not known.
    b.lose_next_reply(&format!("business:{acc}"));
    b.on_payment(A2, "businessTeam.approve", &payment)
        .refused("bank.partner_reply_lost");
    has(
        &b.on_payment(OWNER, "businessTeam.payment", &payment).ok(),
        r#"{"status":"sending"}"#,
    );
    let sent = b.on_payment(A2, "businessTeam.approve", &payment).ok();
    has(
        &sent,
        r#"{"status":"sent","approvals":[{"handle":"approver1"},{"handle":"approver2"}]}"#,
    );
    let moves = b.moves(&acc);
    assert_eq!(
        moves
            .iter()
            .filter(|m| m.key == payment_key(&payment))
            .count(),
        1
    );
    assert_eq!(s(&sent, "partnerMoveId"), moves[0].id);
    assert_eq!(b.balance(&acc), "4000");
    // Again by anyone: nothing more moves.
    b.on_payment(A1, "businessTeam.approve", &payment)
        .refused("bank.business_approval_inactive");
    b.on_payment(OWNER, "businessTeam.resend", &payment).ok();
    assert_eq!(b.moves(&acc).len(), 1);
    b.ledger_untouched();
}

#[test]
fn a_rule_asking_more_approvers_than_the_business_has_refuses_before_anything_is_proposed() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, Some("checker"), None);
    b.add_rule(&acc, "5000", 2);
    b.propose(OWNER, &acc, &uuid(), "TEST Supplier", "6000")
        .refused("bank.business_approvers_short");
    assert_eq!(
        b.ok(OWNER, "businessTeam.payments", &b.account(&acc)),
        Json::Array(vec![])
    );
}

#[test]
fn the_same_payment_proposed_eight_times_at_once_is_recorded_once_and_every_call_gets_it() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, Some("checker"), None);
    b.add_rule(&acc, "1000", 1);
    for _ in 0..30 {
        let payment = uuid();
        let answers: Vec<Answer> = std::thread::scope(|scope| {
            let calls: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| b.propose(OWNER, &acc, &payment, "TEST Supplier", "1500")))
                .collect();
            calls.into_iter().map(|c| c.join().unwrap()).collect()
        });
        for a in &answers {
            has(
                &a.ok(),
                &format!(r#"{{"id":"{payment}","status":"pending"}}"#),
            );
        }
        let n: i64 =
            b.db.client()
                .query_one(
                    "SELECT count(*) FROM bank.business_payments WHERE id = $1::text::uuid",
                    &[&payment],
                )
                .unwrap()
                .get(0);
        assert_eq!(n, 1);
    }
    b.ledger_untouched();
}

#[test]
fn a_payment_sent_at_once_whose_partner_answer_is_lost_pressed_again_with_the_same_id_moves_once() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let payment = uuid();
    b.lose_next_reply(&format!("business:{acc}"));
    b.propose(OWNER, &acc, &payment, "TEST Supplier", "700")
        .refused("bank.partner_reply_lost");
    // The form sends the same id again: the bank reads the move back by its key.
    let again = b
        .propose(OWNER, &acc, &payment, "TEST Supplier", "700")
        .ok();
    has(&again, r#"{"status":"sent","approvalsNeeded":0}"#);
    assert_eq!(
        b.moves(&acc)
            .iter()
            .filter(|m| m.key == payment_key(&payment))
            .count(),
        1
    );
    has(
        &b.propose(OWNER, &acc, &payment, "TEST Supplier", "700")
            .ok(),
        &format!(
            r#"{{"status":"sent","partnerMoveId":"{}"}}"#,
            s(&again, "partnerMoveId")
        ),
    );
    assert_eq!(b.moves(&acc).len(), 1);
    // The same id on other terms is refused, never a second payment.
    b.propose(OWNER, &acc, &payment, "TEST Supplier", "701")
        .refused("bank.business_request_conflict");
    b.ledger_untouched();
}

#[test]
fn while_posting_is_frozen_or_unreadable_no_business_payment_is_recorded_approved_or_sent() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, Some("checker"), None);
    b.add_rule(&acc, "1000", 1);
    let held = uuid();
    b.propose(OWNER, &acc, &held, "TEST Supplier", "1500").ok();
    let at_once = uuid();
    for state in [Some(false), None] {
        *b.freeze.0.lock().unwrap() = state;
        b.propose(OWNER, &acc, &at_once, "TEST Supplier", "700")
            .refused("bank.posting_frozen");
        b.on_payment(A1, "businessTeam.approve", &held)
            .refused("bank.posting_frozen");
        b.on_payment(OWNER, "businessTeam.resend", &held)
            .refused("bank.posting_frozen");
    }
    *b.freeze.0.lock().unwrap() = Some(true);
    assert_eq!(
        names(
            &b.ok(OWNER, "businessTeam.payments", &b.account(&acc)),
            "id"
        ),
        std::slice::from_ref(&held)
    );
    has(
        &b.on_payment(OWNER, "businessTeam.payment", &held).ok(),
        r#"{"status":"pending","approvals":[]}"#,
    );
    assert!(
        b.moves(&acc)
            .iter()
            .all(|m| !m.key.starts_with("bank.business.payment:"))
    );
    assert_eq!(b.balance(&acc), "10000");
    // Lifted: the same approval goes through and sends once.
    has(
        &b.on_payment(A1, "businessTeam.approve", &held).ok(),
        r#"{"status":"sent"}"#,
    );
    b.ledger_untouched();
}

#[test]
fn a_built_in_role_is_granted_only_by_someone_who_holds_all_of_it() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let office = s(
        &b.create_role(OWNER, &acc, "Office", r#"["view","manage_team"]"#)
            .ok(),
        "id",
    );
    b.join(&acc, OFFICE, None, Some(&office));
    b.invite(OFFICE, &acc, Some("signer"), None)
        .refused("bank.business_role_grant_exceeds");
    b.invite(OFFICE, &acc, Some("checker"), None)
        .refused("bank.business_role_grant_exceeds");
    has(
        &b.invite(OFFICE, &acc, Some("viewer"), None).ok(),
        r#"{"invite":{"role":"viewer"}}"#,
    );
    // The owner holds sign: their signer invite stands, and the office manager cannot send it again.
    let made = b.invite(OWNER, &acc, Some("signer"), None).ok();
    b.call(
        OFFICE,
        "businessTeam.resendInvite",
        &format!(
            r#"{{"accountId":"{acc}","inviteId":"{}","newInviteId":"{}"}}"#,
            s(made.get("invite").unwrap(), "id"),
            uuid()
        ),
    )
    .refused("bank.business_role_grant_exceeds");
}

#[test]
fn a_partner_refusal_that_moved_nothing_closes_the_payment_as_refused() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let payment = uuid();
    b.propose(OWNER, &acc, &payment, "TEST Supplier", "20000")
        .refused("bank.partner_insufficient_funds");
    has(
        &b.on_payment(OWNER, "businessTeam.payment", &payment).ok(),
        r#"{"status":"refused","refusalCode":"bank.partner_insufficient_funds","partnerMoveId":null}"#,
    );
}

#[test]
fn n7_team_spend_by_member_equals_the_partner_lines_and_without_the_grant_a_member_sees_only_themselves()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, Some("checker"), None);
    let sales = b.ok(
        OWNER,
        "businessTeam.addDepartment",
        &format!(
            r#"{{"accountId":"{acc}","departmentId":"{}","name":"Sales","budget":null}}"#,
            uuid()
        ),
    );
    has(&sales, r#"{"budget":null}"#);
    let sales_id = s(&sales, "id");
    b.ok(
        OWNER,
        "businessTeam.setDepartment",
        &format!(
            r#"{{"accountId":"{acc}","userId":"{}","departmentId":"{sales_id}"}}"#,
            id(OWNER)
        ),
    );
    b.propose(OWNER, &acc, &uuid(), "TEST Cafe", "12.50").ok();
    b.propose(OWNER, &acc, &uuid(), "TEST Cab", "7.50").ok();
    let team = b.ok(OWNER, "businessTeam.spend", &b.account(&acc));
    has(&team, r#"{"scope":"team"}"#);
    let members = team.get("members").unwrap();
    has(
        find(members, "handle", "owner"),
        r#"{"partnerTotal":"20","recordTotal":"20","partnerLines":2}"#,
    );
    has(
        find(members, "handle", "approver1"),
        r#"{"partnerTotal":"0","partnerLines":0}"#,
    );
    assert_eq!(
        team.get("departments").unwrap(),
        &j(&format!(
            r#"[{{"id":"{sales_id}","name":"Sales","budget":null,"spent":"20","members":["{}"]}}]"#,
            id(OWNER)
        ))
    );
    let mine = b.ok(A1, "businessTeam.spend", &b.account(&acc));
    has(&mine, r#"{"scope":"self","departments":[]}"#);
    assert_eq!(names(mine.get("members").unwrap(), "handle"), ["approver1"]);
}

#[test]
fn concurrent_adds_of_one_department_id_are_one_department_and_another_id_with_the_same_name_is_refused_by_name()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    for round in 0..25 {
        let dep = uuid();
        let input = format!(
            r#"{{"accountId":"{acc}","departmentId":"{dep}","name":"TEST Dept {round}","budget":"100"}}"#
        );
        let answers: Vec<Answer> = std::thread::scope(|scope| {
            let calls: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| b.call(OWNER, "businessTeam.addDepartment", &input)))
                .collect();
            calls.into_iter().map(|c| c.join().unwrap()).collect()
        });
        for a in &answers {
            assert_eq!(
                a.ok(),
                j(&format!(
                    r#"{{"id":"{dep}","name":"TEST Dept {round}","budget":"100"}}"#
                )),
                "round {round}"
            );
        }
    }
    let n: i64 =
        b.db.client()
            .query_one(
                "SELECT count(*) FROM bank.business_departments WHERE account_id = $1::text::uuid",
                &[&acc],
            )
            .unwrap()
            .get(0);
    assert_eq!(n, 25);
    // Different ids racing for one name: exactly one is made, every other is refused by name, never an internal error.
    let racing: Vec<String> = std::thread::scope(|scope| {
        let calls: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    b.call(
                        OWNER,
                        "businessTeam.addDepartment",
                        &format!(
                            r#"{{"accountId":"{acc}","departmentId":"{}","name":"TEST Ops","budget":null}}"#,
                            uuid()
                        ),
                    )
                    .code()
                })
            })
            .collect();
        calls.into_iter().map(|c| c.join().unwrap()).collect()
    });
    assert_eq!(
        racing.iter().filter(|c| *c == "ok").count(),
        1,
        "{racing:?}"
    );
    assert_eq!(
        racing
            .iter()
            .filter(|c| *c == "bank.business_role_name_taken")
            .count(),
        7,
        "{racing:?}"
    );
    b.call(
        OWNER,
        "businessTeam.addDepartment",
        &format!(
            r#"{{"accountId":"{acc}","departmentId":"{}","name":"test ops","budget":null}}"#,
            uuid()
        ),
    )
    .refused("bank.business_role_name_taken");
}
