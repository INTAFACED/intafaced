//! J-bank-20 through the door (BK-bill-01 to BK-bill-03): the checks of `business/business-bills.db.test.ts`, a business
//! paying its suppliers' bills from its account at the TEST partner bank. A bill uploaded twice is flagged and not paid
//! until cleared; a pre-approved vendor's bill under its cap goes straight to payment and one over it to approvers;
//! blank Bill Pay limits refuse; a split must add up and is our record beside the partner's one payment; a scheduled
//! payment cancelled before send never reaches the partner; a declined payment and a returned one put the bill back in
//! the inbox with the partner's reason, and a return is credited once. The ledger posts nothing.
//!
//! Ported as a unit test in `src/business_spend/bills/service.rs`: "the TEST reader reads only labelled lines, and never
//! guesses". Where the TypeScript calls `businessBills.runDue` and `.returned` on the service, this drives the signed
//! job doors `index.ts` mounts for them (`/internal/jobs/bill-pay/{run-due,returned}`). "Today" and "tomorrow" are the
//! database's `current_date`, the clock the service compares a scheduled day with.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use service_kit::json::{self, Json};
use service_kit::money::format_amount;
use service_kit::s2s::{self, system_seconds};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use svc_bank::business_spend::bills::service::{bill_pay_key, bill_return_key};
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
const A1: u32 = 4;

/// svc-ledger's posting freeze as the test sets it: open or frozen.
#[derive(Clone)]
struct Switch(Arc<Mutex<bool>>);

impl Freeze for Switch {
    fn read(&self) -> Result<FreezeReading, String> {
        let open = *self.0.lock().unwrap();
        Ok(FreezeReading {
            posting_enabled: open,
            cause: (!open).then(|| "person".to_owned()),
        })
    }
}

struct Bank {
    door: BankDoor,
    db: TestDb,
    ledger: Book,
    freeze: Switch,
}

/// A door over the stand-ins: the TEST partner on, the bill reader `test-lines`, the ledger counting every post.
fn door_over(db: &TestDb, ledger: &Book, people: &People, freeze: &Switch) -> BankDoor {
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
        business_invite_minutes: Some("2".to_owned()),
        bill_reader: Some("test-lines".to_owned()),
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
        (3, "office"),
        (A1, "approver1"),
        (5, "approver2"),
        (6, "advisor"),
        (7, "newcomer"),
    ] {
        people.person(&id(n), handle, Some(&format!("{handle}@example.test")));
    }
    let freeze = Switch(Arc::new(Mutex::new(true)));
    let door = door_over(&db, &ledger, &people, &freeze);
    Some(Bank {
        door,
        db,
        ledger,
        freeze,
    })
}

/// A TEST bill: plain text with labelled lines.
fn file(vendor: &str, reference: &str, amount: &str, due: &str, note: &str) -> String {
    STANDARD.encode(format!(
        "TEST BILL\nVendor: {vendor}\nReference: {reference}\nAmount: {amount}\nDue: {due}\n{note}"
    ))
}

fn items(v: &Json) -> &[Json] {
    match v {
        Json::Array(a) => a,
        other => panic!("not a list: {}", other.compact()),
    }
}

impl Bank {
    fn call(&self, who: u32, path: &str, input: &str) -> Answer {
        call_door(&self.door, &id(who), WRITE, path, &j(input))
    }

    fn ok(&self, who: u32, path: &str, input: &str) -> Json {
        self.call(who, path, input).ok()
    }

    /// A job door, signed as svc-ops.
    fn job(&self, url: &str, body: &str) -> (u16, Json) {
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(s2s::legacy_headers("svc-ops", INTERNAL, body, system_seconds()).unwrap());
        let res = self.door.handle(&Request {
            method: "POST",
            url,
            headers: &headers,
            body,
        });
        (res.status, json::parse(&res.body).unwrap_or(Json::Null))
    }

    /// `businessBills.runDue({ limit: 10 })`, through its job door.
    fn run_due(&self) -> Json {
        let (status, body) = self.job("/internal/jobs/bill-pay/run-due", r#"{"limit":10}"#);
        assert_eq!(status, 200, "{}", body.compact());
        body
    }

    /// `businessBills.returned(...)`, through its job door.
    fn returned(&self, payment_id: &str, reason: &str) -> Json {
        let (status, body) = self.job(
            "/internal/jobs/bill-pay/returned",
            &format!(r#"{{"paymentId":"{payment_id}","reason":"{reason}"}}"#),
        );
        assert_eq!(status, 200, "{}", body.compact());
        body
    }

    fn partner(&self) -> &TestPartner {
        self.door.partner().partner.as_ref().unwrap()
    }

    /// The partner's moves on the business's own account.
    fn moves(&self, account_id: &str) -> Vec<svc_bank::partner::Move> {
        self.partner().lock().moves(
            &format!("business:{account_id}"),
            &MovesQuery {
                limit: 50,
                ..MovesQuery::default()
            },
        )
    }

    fn move_by_key(&self, key: &str) -> Option<svc_bank::partner::Move> {
        self.partner().lock().book.by_key(key).cloned()
    }

    /// What the partner holds in the business's own account.
    fn held(&self, account_id: &str) -> String {
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

    /// A day on the database's clock, `offset` days from today.
    fn day(&self, offset: i32) -> String {
        self.db
            .client()
            .query_one("SELECT (current_date + $1::int)::text", &[&offset])
            .unwrap()
            .get(0)
    }

    fn sql(&self, statement: &str, payment_id: &str) {
        self.db.client().execute(statement, &[&payment_id]).unwrap();
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

    fn join(&self, account_id: &str, user: u32, role: &str) {
        let made = self.ok(
            OWNER,
            "businessTeam.invite",
            &format!(
                r#"{{"accountId":"{account_id}","inviteId":"{}","email":null,"role":"{role}","roleId":null}}"#,
                uuid()
            ),
        );
        self.ok(
            user,
            "businessTeam.acceptInvite",
            &format!(r#"{{"token":"{}"}}"#, s(&made, "token")),
        );
    }

    fn upload(&self, account_id: &str, content: &str, bill_id: &str) -> Json {
        self.ok(
            OWNER,
            "businessBills.upload",
            &format!(
                r#"{{"accountId":"{account_id}","billId":"{bill_id}","fileName":"bill.txt","contentType":"text/plain","contentBase64":"{content}"}}"#
            ),
        )
    }

    fn set_vendor(&self, account_id: &str, name: &str, cap: &str) {
        self.ok(
            OWNER,
            "businessBills.setVendor",
            &format!(r#"{{"accountId":"{account_id}","name":"{name}","cap":"{cap}"}}"#),
        );
    }

    fn set_limits(&self, account_id: &str, per: &str, daily: &str, monthly: &str) {
        let q = |v: &str| {
            if v == "null" {
                v.to_owned()
            } else {
                format!(r#""{v}""#)
            }
        };
        self.ok(
            OWNER,
            "businessBills.setLimits",
            &format!(
                r#"{{"accountId":"{account_id}","perPayment":{},"daily":{},"monthly":{}}}"#,
                q(per),
                q(daily),
                q(monthly)
            ),
        );
    }

    fn ready(&self, account_id: &str) {
        self.join(account_id, A1, "checker");
        self.set_vendor(account_id, "TEST Paper Co", "200");
        self.set_limits(account_id, "5000", "8000", "9000");
    }

    fn on_bill(&self, who: u32, path: &str, bill_id: &str) -> Answer {
        self.call(who, path, &format!(r#"{{"billId":"{bill_id}"}}"#))
    }

    fn on_payment(&self, who: u32, path: &str, payment_id: &str) -> Answer {
        self.call(who, path, &format!(r#"{{"paymentId":"{payment_id}"}}"#))
    }

    fn pay(
        &self,
        who: u32,
        bill_id: &str,
        payment_id: &str,
        scheduled_for: Option<&str>,
        splits: &str,
    ) -> Answer {
        let day = scheduled_for.map_or_else(|| "null".to_owned(), |d| format!(r#""{d}""#));
        self.call(
            who,
            "businessBills.pay",
            &format!(
                r#"{{"billId":"{bill_id}","paymentId":"{payment_id}","scheduledFor":{day},"splits":{splits}}}"#
            ),
        )
    }
}

#[test]
fn n1_a_bill_uploaded_twice_the_second_is_flagged_may_be_a_duplicate_of_the_first_and_cannot_be_paid_until_cleared()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ready(&acc);
    let content = file("TEST Paper Co", "INV-1001", "150.00", "2026-12-01", "");
    let first = b.upload(&acc, &content, &uuid());
    has(
        &first,
        r#"{"status":"inbox","vendor":"TEST Paper Co","amount":"150","duplicateOf":null,"extracted":{"label":"Preview · sample data"}}"#,
    );
    // The same upload sent again under its id is the same bill, never a second one.
    assert_eq!(
        s(&b.upload(&acc, &content, &s(&first, "id")), "id"),
        s(&first, "id")
    );
    let second = b.upload(&acc, &content, &uuid());
    has(
        second.get("duplicateOf").unwrap(),
        &format!(r#"{{"id":"{}","reference":"INV-1001"}}"#, s(&first, "id")),
    );
    b.on_bill(OWNER, "businessBills.submit", &s(&second, "id"))
        .refused("bank.bill_duplicate_uncleared");
    // A different file with the same vendor and reference is flagged too.
    let rescan = b.upload(
        &acc,
        &file(
            "TEST Paper Co",
            "INV-1001",
            "150.00",
            "2026-12-01",
            "rescanned",
        ),
        &uuid(),
    );
    assert_eq!(s(rescan.get("duplicateOf").unwrap(), "id"), s(&first, "id"));
    // Only someone who manages the team clears it.
    b.join(&acc, BOOK, "maker");
    b.on_bill(BOOK, "businessBills.clearDuplicate", &s(&second, "id"))
        .refused("bank.business_role_forbidden");
    let cleared = b
        .on_bill(OWNER, "businessBills.clearDuplicate", &s(&second, "id"))
        .ok();
    has(&cleared, r#"{"duplicateCleared":true}"#);
    has(
        &b.on_bill(OWNER, "businessBills.submit", &s(&second, "id"))
            .ok(),
        r#"{"status":"approved"}"#,
    );
    b.ledger_untouched();
}

#[test]
fn n2_a_pre_approved_vendor_at_or_under_its_cap_goes_straight_to_payment_over_it_to_approvers_blank_limits_refuse()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.join(&acc, A1, "checker");
    b.set_vendor(&acc, "TEST Paper Co", "200");
    let small = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-2001", "150.00", "2026-12-02", ""),
            &uuid(),
        ),
        "id",
    );
    has(
        &b.on_bill(OWNER, "businessBills.submit", &small).ok(),
        r#"{"status":"approved","preapproved":true,"approvalsNeeded":0}"#,
    );
    // Limits blank: every payment refuses, and nothing reaches the partner.
    assert_eq!(
        b.ok(
            OWNER,
            "businessBills.settings",
            &format!(r#"{{"accountId":"{acc}"}}"#)
        )
        .get("limits")
        .unwrap(),
        &j(r#"{"perPayment":null,"daily":null,"monthly":null}"#)
    );
    let payment = uuid();
    b.pay(OWNER, &small, &payment, None, "[]")
        .refused("bank.bill_limit_unset");
    b.set_limits(&acc, "5000", "null", "9000");
    b.pay(OWNER, &small, &payment, None, "[]")
        .refused("bank.bill_limit_unset");
    b.set_limits(&acc, "100", "8000", "9000");
    b.pay(OWNER, &small, &payment, None, "[]")
        .refused("bank.bill_limit_exceeded");
    assert_eq!(b.held(&acc), "10000");
    b.set_limits(&acc, "5000", "8000", "9000");
    let paid = b.pay(OWNER, &small, &payment, None, "[]").ok();
    has(
        &paid,
        &format!(
            r#"{{"status":"paid","payments":[{{"status":"sent","partnerKey":"{}"}}]}}"#,
            bill_pay_key(&small, 1)
        ),
    );
    assert_eq!(b.held(&acc), "9850");
    let big = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-2002", "250.00", "2026-12-03", ""),
            &uuid(),
        ),
        "id",
    );
    has(
        &b.on_bill(OWNER, "businessBills.submit", &big).ok(),
        r#"{"status":"awaiting_approval","preapproved":false,"approvalsNeeded":1}"#,
    );
    b.pay(OWNER, &big, &uuid(), None, "[]")
        .refused("bank.bill_not_approved");
    b.on_bill(OWNER, "businessBills.approve", &big)
        .refused("bank.business_self_approve");
    has(
        &b.on_bill(A1, "businessBills.approve", &big).ok(),
        r#"{"status":"approved"}"#,
    );
    b.on_bill(A1, "businessBills.approve", &big)
        .refused("bank.business_approval_inactive");
    b.ledger_untouched();
}

#[test]
fn n3_a_split_is_our_record_beside_the_partners_one_payment_and_must_add_up_to_the_bill() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ready(&acc);
    let bill = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-3001", "100.00", "2026-12-04", ""),
            &uuid(),
        ),
        "id",
    );
    b.on_bill(OWNER, "businessBills.submit", &bill).ok();
    let payment = uuid();
    let wrong = r#"[{"category":"Office supplies","amount":"60.00"},{"category":"Printing","amount":"39.99"}]"#;
    b.pay(OWNER, &bill, &payment, None, wrong)
        .refused("bank.split_total_mismatch");
    let splits = r#"[{"category":"Office supplies","amount":"60.00"},{"category":"Printing","amount":"40.00"}]"#;
    let paid = b.pay(OWNER, &bill, &payment, None, splits).ok();
    has(
        &items(paid.get("payments").unwrap())[0],
        r#"{"status":"sent","amount":"100","splits":[{"category":"Office supplies","amount":"60"},{"category":"Printing","amount":"40"}]}"#,
    );
    let moves = b.moves(&acc);
    assert_eq!(
        moves
            .iter()
            .filter(|m| m.key.starts_with("bank.business.bill-pay:"))
            .count(),
        1
    );
    assert_eq!(moves[0].key, bill_pay_key(&bill, 1));
    assert_eq!(format_amount(moves[0].amount), "100");
    // The same payment id again moves nothing more.
    b.pay(OWNER, &bill, &payment, None, splits).ok();
    assert_eq!(b.moves(&acc).len(), 1);
    b.ledger_untouched();
}

#[test]
fn a_lost_partner_answer_is_read_back_by_its_key_and_paid_once() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ready(&acc);
    let bill = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-3101", "50.00", "2026-12-04", ""),
            &uuid(),
        ),
        "id",
    );
    b.on_bill(OWNER, "businessBills.submit", &bill).ok();
    let payment = uuid();
    b.lose_next_reply(&format!("business:{acc}"));
    b.pay(OWNER, &bill, &payment, None, "[]")
        .refused("bank.partner_reply_lost");
    let got = b.on_bill(OWNER, "businessBills.get", &bill).ok();
    has(
        &items(got.get("payments").unwrap())[0],
        r#"{"status":"sending"}"#,
    );
    has(
        &b.pay(OWNER, &bill, &payment, None, "[]").ok(),
        r#"{"status":"paid"}"#,
    );
    assert_eq!(b.moves(&acc).len(), 1);
    assert_eq!(b.held(&acc), "9950");
}

#[test]
fn n4_a_scheduled_payment_cancelled_before_send_never_reaches_the_partner_and_the_bill_is_approved_again()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ready(&acc);
    let bill = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-4001", "120.00", "2026-12-05", ""),
            &uuid(),
        ),
        "id",
    );
    b.on_bill(OWNER, "businessBills.submit", &bill).ok();
    b.pay(OWNER, &bill, &uuid(), Some(&b.day(0)), "[]")
        .refused("bank.bill_schedule_invalid");
    let tomorrow = b.day(1);
    let payment = uuid();
    let scheduled = b.pay(OWNER, &bill, &payment, Some(&tomorrow), "[]").ok();
    has(
        &scheduled,
        &format!(
            r#"{{"status":"scheduled","payments":[{{"status":"scheduled","scheduledFor":"{tomorrow}"}}]}}"#
        ),
    );
    let cancelled = b.on_payment(OWNER, "businessBills.cancel", &payment).ok();
    has(
        &cancelled,
        r#"{"status":"approved","payments":[{"status":"cancelled"}]}"#,
    );
    let again = b.on_payment(OWNER, "businessBills.cancel", &payment).ok();
    assert_eq!(items(again.get("payments").unwrap()).len(), 1);
    // The day comes: nothing is sent for it.
    b.sql(
        "UPDATE bank.business_bill_payments SET scheduled_for = current_date WHERE id = $1::text::uuid",
        &payment,
    );
    assert_eq!(b.run_due(), j(r#"{"sent":0,"declined":0,"unknown":0}"#));
    assert!(b.move_by_key(&bill_pay_key(&bill, 1)).is_none());
    assert_eq!(b.held(&acc), "10000");
    // A scheduled one not cancelled is sent once on its day, and then cannot be cancelled.
    let second = uuid();
    b.pay(OWNER, &bill, &second, Some(&tomorrow), "[]").ok();
    b.sql(
        "UPDATE bank.business_bill_payments SET scheduled_for = current_date WHERE id = $1::text::uuid",
        &second,
    );
    assert_eq!(b.run_due(), j(r#"{"sent":1,"declined":0,"unknown":0}"#));
    assert_eq!(b.run_due(), j(r#"{"sent":0,"declined":0,"unknown":0}"#));
    b.on_payment(OWNER, "businessBills.cancel", &second)
        .refused("bank.bill_payment_sent");
    assert_eq!(b.held(&acc), "9880");
    b.ledger_untouched();
}

#[test]
fn n5_a_declined_payment_and_a_returned_one_the_partners_reason_the_bill_back_in_the_inbox_a_return_credited_once()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ready(&acc);
    // More than the partner holds: the partner declines, nothing moves.
    let big = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-5001", "12000.00", "2026-12-06", ""),
            &uuid(),
        ),
        "id",
    );
    b.set_limits(&acc, "20000", "30000", "40000");
    b.on_bill(OWNER, "businessBills.submit", &big).ok();
    b.on_bill(A1, "businessBills.approve", &big).ok();
    let declined = b.pay(OWNER, &big, &uuid(), None, "[]").ok();
    has(
        &declined,
        r#"{"status":"inbox","round":2,"approvals":[],"back":{"reason":"bank.partner_insufficient_funds"},"payments":[{"status":"declined","partnerReason":"bank.partner_insufficient_funds"}]}"#,
    );
    let text = s(declined.get("back").unwrap(), "text");
    assert!(text.contains("The partner reports"), "{text}");
    assert_eq!(b.held(&acc), "10000");
    // Returned: paid once, then given back once as the partner reports it.
    let bill = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-5002", "120.00", "2026-12-07", ""),
            &uuid(),
        ),
        "id",
    );
    b.on_bill(OWNER, "businessBills.submit", &bill).ok();
    let payment = uuid();
    b.pay(OWNER, &bill, &payment, None, "[]").ok();
    assert_eq!(b.held(&acc), "9880");
    let back = b.returned(&payment, "account_closed");
    has(
        &back,
        r#"{"status":"inbox","back":{"reason":"returned:account_closed","text":"The payee’s bank account is closed."},"payments":[{"status":"returned","partnerReason":"account_closed"}]}"#,
    );
    assert_eq!(b.held(&acc), "10000");
    b.returned(&payment, "account_closed");
    assert_eq!(b.held(&acc), "10000");
    assert_eq!(
        b.moves(&acc)
            .iter()
            .filter(|m| m.key == bill_return_key(&payment))
            .count(),
        1
    );
    // Corrected and paid again: a new attempt under a new key.
    b.on_bill(OWNER, "businessBills.submit", &bill).ok();
    let retry = b.pay(OWNER, &bill, &uuid(), None, "[]").ok();
    let attempts: Vec<(String, String, String)> = items(retry.get("payments").unwrap())
        .iter()
        .map(|p| (s(p, "attempt"), s(p, "status"), s(p, "partnerKey")))
        .collect();
    assert_eq!(
        attempts,
        [
            (
                "1".to_owned(),
                "returned".to_owned(),
                bill_pay_key(&bill, 1)
            ),
            ("2".to_owned(), "sent".to_owned(), bill_pay_key(&bill, 2)),
        ]
    );
    b.ledger_untouched();
}

#[test]
fn while_posting_is_frozen_nothing_is_paid() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ready(&acc);
    let bill = s(
        &b.upload(
            &acc,
            &file("TEST Paper Co", "INV-6001", "10.00", "2026-12-08", ""),
            &uuid(),
        ),
        "id",
    );
    b.on_bill(OWNER, "businessBills.submit", &bill).ok();
    *b.freeze.0.lock().unwrap() = false;
    b.pay(OWNER, &bill, &uuid(), None, "[]")
        .refused("bank.posting_frozen");
    let got = b.on_bill(OWNER, "businessBills.get", &bill).ok();
    assert_eq!(got.get("payments").unwrap(), &j("[]"));
    assert_eq!(b.held(&acc), "10000");
}
