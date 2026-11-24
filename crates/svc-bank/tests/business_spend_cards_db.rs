//! J-bank-22 through the door (BK-bcard-01, BK-bexp-01, BK-bexp-02): the checks of `business/business-cards.db.test.ts`,
//! a business giving its team cards and handling their expenses from its account at the TEST partner bank. A purchase
//! over the card's limit declines `over_limit`, moves nothing and opens one request to the admins; one within it is one
//! partner move under its purchase key, sent once. A capture over the business's receipt rule with no receipt needs
//! one, with exactly one reminder queued; the receipts download as one ZIP. A reimbursement is approved by someone
//! other than the claimant and paid as one partner move to the member's own account, sent once even when the
//! partner's answer is lost; the member's balance rises by exactly the claim. The ledger posts nothing.
//!
//! Every `it` of the TypeScript file is here, in its order. `crc32`, `testCardTail` and `zipStore` are also held to
//! the TypeScript's own output by unit tests in `src/business_spend/cards/service.rs`. The TypeScript's second
//! service built with `testPartner: null` is a second door over the same database with no TEST partner.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s_verify::BodyBind;
use svc_bank::business_spend::cards::service::{
    card_capture_key, crc32, reimbursement_key, test_card_tail,
};
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, MERCHANT, MovesQuery, TestPartner};
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
const MEMBER: u32 = 2;
const APPROVER: u32 = 3;

/// `RECEIPT`: a TEST text receipt.
fn receipt_fields(receipt_id: &str, content_type: &str) -> String {
    format!(
        r#""receiptId":"{receipt_id}","fileName":"receipt.txt","contentType":"{content_type}","contentBase64":"{}""#,
        STANDARD.encode(b"TEST receipt 80.00")
    )
}

/// svc-ledger's posting freeze: always open here, as the TypeScript's `postingEnabled: async () => true`.
#[derive(Clone)]
struct Open;

impl Freeze for Open {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: true,
            cause: None,
        })
    }
}

struct Bank {
    door: BankDoor,
    /// The same database with no TEST partner: `testPartner: null`.
    off: BankDoor,
    db: TestDb,
    ledger: Book,
}

/// A door over the stand-ins; `test_network` puts the TEST partner on.
fn door_over(db: &TestDb, ledger: &Book, people: &People, test_network: bool) -> BankDoor {
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
        partner: test_network.then(|| TestPartner::new().unwrap()),
        freeze: Box::new(Open),
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
    for (n, handle) in [(OWNER, "owner"), (MEMBER, "member"), (APPROVER, "approver")] {
        people.person(&id(n), handle, Some(&format!("{handle}@example.test")));
    }
    let door = door_over(&db, &ledger, &people, true);
    let off = door_over(&db, &ledger, &people, false);
    Some(Bank {
        door,
        off,
        db,
        ledger,
    })
}

fn amt(s: &str) -> Amount {
    parse_amount(s).unwrap()
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

    /// The business's money at the partner (`held`).
    fn held(&self, account_id: &str) -> Amount {
        self.partner()
            .lock()
            .report(
                &AccountRef::main(&format!("business:{account_id}"), "USDT"),
                door::system_now(),
            )
            .amount
            .unwrap()
    }

    /// The member's own money at the partner (`memberHeld`).
    fn member_held(&self) -> Option<Amount> {
        self.partner()
            .lock()
            .report(&AccountRef::main(&id(MEMBER), "USDT"), door::system_now())
            .amount
    }

    fn move_by_key(&self, key: &str) -> Option<svc_bank::partner::Move> {
        self.partner().lock().book.by_key(key).cloned()
    }

    /// The member's partner moves under `key`.
    fn member_moves(&self, key: &str) -> usize {
        self.partner()
            .lock()
            .moves(
                &id(MEMBER),
                &MovesQuery {
                    limit: 50,
                    ..MovesQuery::default()
                },
            )
            .iter()
            .filter(|m| m.key == key)
            .count()
    }

    /// The next answer the partner gives for `user` is lost after the move is made.
    fn lose_next_reply(&self, user: &str) {
        let mut p = self.partner().lock();
        let mut sw = p.board.get(user);
        "lost".clone_into(&mut sw.next_reply);
        p.board.set(user, sw);
    }

    fn count(&self, sql: &str) -> i64 {
        self.db.client().query_one(sql, &[]).unwrap().get(0)
    }

    fn join(&self, account_id: &str, who: u32, role: &str) {
        let made = self.ok(
            OWNER,
            "businessTeam.invite",
            &format!(
                r#"{{"accountId":"{account_id}","inviteId":"{}","email":null,"role":"{role}","roleId":null}}"#,
                uuid()
            ),
        );
        self.ok(
            who,
            "businessTeam.acceptInvite",
            &format!(r#"{{"token":"{}"}}"#, s(&made, "token")),
        );
    }

    /// The owner's business with TEST 1000 USDT at the partner, a member and an approver, and the member's money at
    /// the partner.
    fn business(&self) -> String {
        self.ok(OWNER, "testPartner.set", r#"{"custody":"off"}"#);
        self.ok(MEMBER, "testPartner.set", r#"{"custody":"off"}"#);
        let account_id = uuid();
        self.ok(
            OWNER,
            "business.create",
            &format!(r#"{{"accountId":"{account_id}","name":"TEST Cards Ltd","assetId":"USDT","spendThreshold":"500"}}"#),
        );
        self.ok(
            OWNER,
            "testPartner.fundBusiness",
            &format!(
                r#"{{"accountId":"{account_id}","fundId":"fund-{account_id}","amount":"1000"}}"#
            ),
        );
        self.join(&account_id, MEMBER, "viewer");
        self.join(&account_id, APPROVER, "checker");
        account_id
    }

    fn issue(
        &self,
        who: u32,
        account_id: &str,
        card_id: &str,
        member: &str,
        limit: &str,
    ) -> Answer {
        self.call(
            who,
            "businessCards.issueCard",
            &format!(
                r#"{{"accountId":"{account_id}","cardId":"{card_id}","memberUserId":"{member}","perPurchaseLimit":"{limit}"}}"#
            ),
        )
    }

    fn purchase(
        &self,
        who: u32,
        card_id: &str,
        purchase_id: &str,
        merchant: &str,
        amount: &str,
    ) -> Answer {
        call_door(
            &self.door,
            &id(who),
            WRITE,
            "businessCards.testPurchase",
            &purchase_input(card_id, purchase_id, merchant, amount),
        )
    }

    fn overview(&self, who: u32, account_id: &str) -> Json {
        self.ok(
            who,
            "businessCards.overview",
            &format!(r#"{{"accountId":"{account_id}"}}"#),
        )
    }

    fn submit_claim(
        &self,
        account_id: &str,
        claim_id: &str,
        amount: &str,
        description: &str,
    ) -> Json {
        self.ok(
            MEMBER,
            "businessCards.submitClaim",
            &format!(
                r#"{{"accountId":"{account_id}","claimId":"{claim_id}","amount":"{amount}","description":"{description}",{}}}"#,
                receipt_fields(&uuid(), "text/plain")
            ),
        )
    }

    fn approve_and_pay(&self, who: u32, claim_id: &str) -> Answer {
        self.call(
            who,
            "businessCards.approveAndPay",
            &format!(r#"{{"claimId":"{claim_id}"}}"#),
        )
    }
}

fn purchase_input(card_id: &str, purchase_id: &str, merchant: &str, amount: &str) -> Json {
    j(&format!(
        r#"{{"cardId":"{card_id}","purchaseId":"{purchase_id}","merchant":"{merchant}","amount":"{amount}"}}"#
    ))
}

fn list(v: &Json) -> &[Json] {
    match v {
        Json::Array(items) => items,
        other => panic!("not a list: {}", other.compact()),
    }
}

fn ids(v: &Json) -> Vec<String> {
    list(v).iter().map(|i| s(i, "id")).collect()
}

#[test]
fn n1_a_card_issued_to_a_member_with_a_limit_of_100_is_in_the_members_view_only_an_admin_issues_one_only_to_a_member()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let card_id = uuid();
    let card = b.issue(OWNER, &acc, &card_id, &id(MEMBER), "100.00").ok();
    has(
        &card,
        &format!(
            r#"{{"memberUserId":"{}","perPurchaseLimit":"100","test":true,"panTail":"{}","status":"active"}}"#,
            id(MEMBER),
            test_card_tail(&card_id)
        ),
    );
    // The same id on the same terms is the same card; on other terms it is a conflict.
    assert_eq!(
        s(
            &b.issue(OWNER, &acc, &card_id, &id(MEMBER), "100").ok(),
            "id"
        ),
        card_id
    );
    b.issue(OWNER, &acc, &card_id, &id(MEMBER), "200")
        .refused("bank.business_request_conflict");
    let mine = b.overview(MEMBER, &acc);
    assert_eq!(ids(mine.get("cards").unwrap()), [card_id]);
    b.issue(MEMBER, &acc, &uuid(), &id(MEMBER), "1")
        .refused("bank.business_role_forbidden");
    b.issue(OWNER, &acc, &uuid(), &id(9), "1")
        .refused("bank.business_not_member");
    b.issue(OWNER, &acc, &uuid(), &id(MEMBER), "0")
        .refused("bank.business_card_field_invalid");
}

#[test]
fn n2_spending_120_on_a_100_card_declines_over_limit_moves_nothing_and_opens_one_request_to_the_admin()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let card_id = uuid();
    b.issue(OWNER, &acc, &card_id, &id(MEMBER), "100").ok();
    let purchase_id = uuid();
    let p = b
        .purchase(MEMBER, &card_id, &purchase_id, "TEST Shop", "120.00")
        .ok();
    has(
        &p,
        r#"{"status":"declined","declineReason":"over_limit","partnerMoveId":null}"#,
    );
    has(
        p.get("limitRequest").unwrap(),
        r#"{"status":"open","amount":"120"}"#,
    );
    // Asked again: the same purchase, still one request, still nothing moved.
    b.purchase(MEMBER, &card_id, &purchase_id, "TEST Shop", "120.00")
        .ok();
    assert_eq!(b.held(&acc), amt("1000"));
    assert!(b.move_by_key(&card_capture_key(&purchase_id)).is_none());
    let admin = b.overview(OWNER, &acc);
    let requests = list(admin.get("limitRequests").unwrap());
    assert_eq!(requests.len(), 1);
    has(
        &requests[0],
        &format!(
            r#"{{"purchaseId":"{purchase_id}","memberUserId":"{}","status":"open"}}"#,
            id(MEMBER)
        ),
    );
    // Only the cardholder spends on the card; another member cannot decide the request.
    b.purchase(APPROVER, &card_id, &uuid(), "x", "1")
        .refused("bank.business_card_not_found");
    let decide = format!(r#"{{"purchaseId":"{purchase_id}","approve":true}}"#);
    b.call(MEMBER, "businessCards.decideLimitRequest", &decide)
        .refused("bank.business_role_forbidden");
    // The admin approves: the card's limit becomes the requested amount.
    assert_eq!(
        s(
            &b.ok(OWNER, "businessCards.decideLimitRequest", &decide),
            "status"
        ),
        "approved"
    );
    assert_eq!(
        s(
            &list(b.overview(OWNER, &acc).get("cards").unwrap())[0],
            "perPurchaseLimit"
        ),
        "120"
    );
    // Off the TEST stack there is no card network to spend on.
    call_door(
        &b.off,
        &id(MEMBER),
        WRITE,
        "businessCards.testPurchase",
        &purchase_input(&card_id, &uuid(), "x", "1"),
    )
    .refused("bank.test_partner_off");
}

#[test]
fn n3_a_capture_of_80_over_the_50_rule_needs_a_receipt_with_one_reminder_the_receipt_clears_it_receipts_download_as_a_zip()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    b.ok(
        OWNER,
        "businessCards.setPolicy",
        &format!(r#"{{"accountId":"{acc}","receiptOver":"50.00"}}"#),
    );
    let card_id = uuid();
    b.issue(OWNER, &acc, &card_id, &id(MEMBER), "100").ok();
    let purchase_id = uuid();
    let p = b
        .purchase(MEMBER, &card_id, &purchase_id, "TEST Hotel", "80.00")
        .ok();
    has(
        &p,
        &format!(
            r#"{{"status":"captured","needsReceipt":true,"reminders":1,"receiptOver":"50","partnerKey":"{}"}}"#,
            card_capture_key(&purchase_id)
        ),
    );
    // One partner move, from the business's account to the TEST merchant, sent once.
    assert_eq!(b.held(&acc), amt("920"));
    b.purchase(MEMBER, &card_id, &purchase_id, "TEST Hotel", "80.00")
        .ok();
    assert_eq!(b.held(&acc), amt("920"));
    let m = b.move_by_key(&card_capture_key(&purchase_id)).unwrap();
    assert_eq!(m.amount, amt("80"));
    assert_eq!(m.to.user_id, MERCHANT);
    // Still exactly one reminder.
    assert_eq!(
        b.count(&format!(
            "SELECT count(*)::int8 FROM bank.business_receipt_reminders WHERE purchase_id = '{purchase_id}'::uuid"
        )),
        1
    );
    // Under the rule no receipt is needed.
    let small = b
        .purchase(MEMBER, &card_id, &uuid(), "TEST Cafe", "20")
        .ok();
    has(
        &small,
        r#"{"status":"captured","needsReceipt":false,"reminders":0}"#,
    );

    let zip_input = format!(r#"{{"accountId":"{acc}"}}"#);
    let zip0 = b.ok(OWNER, "businessCards.receiptsZip", &zip_input);
    has(&zip0, r#"{"count":0}"#);
    let attach = |content_type: &str| {
        b.call(
            MEMBER,
            "businessCards.attachReceipt",
            &format!(
                r#"{{"purchaseId":"{purchase_id}",{}}}"#,
                receipt_fields(&uuid(), content_type)
            ),
        )
    };
    has(
        &attach("text/plain").ok(),
        r#"{"needsReceipt":false,"reminders":0}"#,
    );
    let zip = b.ok(OWNER, "businessCards.receiptsZip", &zip_input);
    has(&zip, r#"{"count":1}"#);
    let bytes = STANDARD.decode(s(&zip, "zipBase64")).unwrap();
    assert_eq!(
        u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
        0x0403_4b50
    );
    let content = b"TEST receipt 80.00";
    assert_eq!(
        u32::from_le_bytes(bytes[14..18].try_into().unwrap()),
        crc32(content)
    );
    assert!(bytes.windows(content.len()).any(|w| w == content));
    // Only someone with export downloads them.
    b.call(MEMBER, "businessCards.receiptsZip", &zip_input)
        .refused("bank.business_role_forbidden");
    attach("text/html").rejected();
}

#[test]
fn n4_n5_a_claim_of_42_50_with_a_receipt_is_approved_and_paid_as_one_partner_move_the_members_balance_rises_by_exactly_42_50()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let claim_id = uuid();
    let claim = b.submit_claim(&acc, &claim_id, "42.50", "TEST taxi to client");
    has(
        &claim,
        &format!(
            r#"{{"status":"submitted","amount":"42.5","partnerKey":"{}","partnerMoveId":null}}"#,
            reimbursement_key(&claim_id)
        ),
    );
    assert_eq!(
        ids(b.overview(OWNER, &acc).get("claims").unwrap()),
        std::slice::from_ref(&claim_id)
    );
    // The claimant never approves their own claim.
    b.approve_and_pay(MEMBER, &claim_id)
        .refused("bank.business_self_approve");

    let before = b.member_held().unwrap_or(Amount::ZERO);
    // The partner's answer is lost once: the claim stays paying, and the retry reads the move back by its key.
    b.lose_next_reply(&format!("business:{acc}"));
    b.approve_and_pay(OWNER, &claim_id)
        .refused("bank.partner_reply_lost");
    let paid = b.approve_and_pay(OWNER, &claim_id).ok();
    assert_eq!(s(&paid, "status"), "paid");
    assert_eq!(s(&paid, "approvedBy"), id(OWNER));
    assert_eq!(
        b.member_held().unwrap().checked_sub(before).unwrap(),
        amt("42.5")
    );
    assert_eq!(b.held(&acc), amt("957.5"));
    assert_eq!(b.member_moves(&reimbursement_key(&claim_id)), 1);
    // Paid again: the same claim, no second move.
    b.approve_and_pay(OWNER, &claim_id).ok();
    assert_eq!(b.member_moves(&reimbursement_key(&claim_id)), 1);
    let mine = b.overview(MEMBER, &acc);
    assert_eq!(
        s(mine.get("myBalance").unwrap(), "amount"),
        format_amount(amt("42.5"))
    );
    // The ledger posted nothing for any of it.
    assert_eq!(b.ledger.calls(), 0, "{:?}", b.ledger.keys());
}

#[test]
fn one_purchase_pressed_eight_times_at_once_is_one_purchase_and_one_partner_move_under_the_limit_and_over_it_8888()
 {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let card_id = uuid();
    b.issue(OWNER, &acc, &card_id, &id(MEMBER), "100").ok();
    let race = |purchase_id: &str, amounts: &[&str]| -> Vec<Answer> {
        let barrier = std::sync::Barrier::new(amounts.len());
        std::thread::scope(|sc| {
            let handles: Vec<_> = amounts
                .iter()
                .map(|amount| {
                    let barrier = &barrier;
                    let b = &b;
                    let card_id = &card_id;
                    sc.spawn(move || {
                        barrier.wait();
                        b.purchase(MEMBER, card_id, purchase_id, "TEST Shop", amount)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        })
    };
    let mut spent = Amount::ZERO;
    for round in 0..10 {
        let over = round % 2 == 1;
        let purchase_id = uuid();
        let amount = if over { "120" } else { "5" };
        for p in race(&purchase_id, &[amount; 8]) {
            let want = if over {
                format!(
                    r#"{{"id":"{purchase_id}","status":"declined","declineReason":"over_limit"}}"#
                )
            } else {
                format!(r#"{{"id":"{purchase_id}","status":"captured"}}"#)
            };
            has(&p.ok(), &want);
        }
        if !over {
            spent = spent.checked_add(amt(amount)).unwrap();
        }
        assert_eq!(b.held(&acc), amt("1000").checked_sub(spent).unwrap());
    }
    assert_eq!(
        b.count("SELECT count(*)::int8 FROM bank.business_card_purchases"),
        10
    );
    assert_eq!(
        list(b.overview(OWNER, &acc).get("limitRequests").unwrap()).len(),
        5
    );
    // Copies racing on other terms: one purchase is recorded, every copy on other terms is a conflict, one move.
    let purchase_id = uuid();
    let amounts = ["6", "7", "6", "7", "6", "7", "6", "7"];
    let tries = race(&purchase_id, &amounts);
    let won: String =
        b.db.client()
            .query_one(
                "SELECT amount::text FROM bank.business_card_purchases WHERE id = $1::text::uuid",
                &[&purchase_id],
            )
            .unwrap()
            .get(0);
    let won = amt(&won);
    for (i, t) in tries.iter().enumerate() {
        if amt(amounts[i]) == won {
            has(
                &t.ok(),
                &format!(r#"{{"id":"{purchase_id}","status":"captured"}}"#),
            );
        } else {
            t.refused("bank.business_request_conflict");
        }
    }
    assert_eq!(
        b.held(&acc),
        amt("1000")
            .checked_sub(spent)
            .unwrap()
            .checked_sub(won)
            .unwrap()
    );
}

#[test]
fn a_claim_the_business_cannot_cover_is_refused_by_the_partner_moves_nothing_and_stays_open() {
    let Some(b) = bank() else { return };
    let acc = b.business();
    let claim_id = uuid();
    b.submit_claim(&acc, &claim_id, "5000", "TEST big");
    b.approve_and_pay(APPROVER, &claim_id)
        .refused("bank.partner_insufficient_funds");
    let view = b.overview(OWNER, &acc);
    let c = &list(view.get("claims").unwrap())[0];
    has(
        c,
        r#"{"status":"submitted","refusalCode":"bank.partner_insufficient_funds","partnerMoveId":null}"#,
    );
    assert_eq!(b.held(&acc), amt("1000"));
}
