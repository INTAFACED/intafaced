//! J-bank-23 through the door (BK-bexp-03, BK-bexp-04, BK-bexp-05): the checks of `business/business-books.db.test.ts`,
//! a business keeping its books in order over the TEST partner bank's record of its account. Connecting accounting
//! software is switched off (`vendor.accounting`) and the record is kept; the bank feed by file has every line. A
//! coding rule's test run lists its matches and codes nothing; saved, it codes them and each new matching line; a
//! person codes in bulk and a rule never overwrites them. Each of the four statement formats carries the partner
//! statement's closing balance and line count and every line's id; the history window and strong customer
//! authentication refuse by name; a statement that disagrees with the partner's gives no file. The ledger posts nothing.
//!
//! What differs from the TypeScript's suite, and why:
//! - the business's card purchases: slice `business-spend`'s cards part is ported beside this one, so `TEST card
//!   activity` is seeded the way `businessCards.testPurchase` leaves it (the card and purchase rows, and one capture
//!   at the TEST partner under `bank.business.card-capture:<purchase id>`, to the TEST merchant), by `buy` below;
//! - the mismatch: the TypeScript swaps the partner's `statement` for one listing 4 lines. The Rust partner cannot be
//!   swapped, so the record is made to disagree instead: one line on the business's record at the partner that its
//!   statement of the account does not list (a move into another of its spaces). The check refused is the same.
//!
//! Added: an approved confirmation lets the 100-day export through, and the same export id is let through again
//! (`replay`), while the same approval for another period is refused `bank.step_up_mismatch`.
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
use service_kit::time::Instant;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring as PartnerWiring;
use svc_bank::partner::{AccountRef, MERCHANT, Move, MoveRequest, TestPartner};
use svc_bank::spaces::ports::Lookups;
use svc_bank::spaces::shared::Terms;
use svc_bank::spaces::space::Rules;
use svc_bank::spaces::{Tables, Wiring as SpacesWiring};
use svc_bank::transfers::step_up::Binding;
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
const DAY: i64 = 24 * 60 * 60 * 1000;

/// svc-ledger's posting freeze: open.
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
    db: TestDb,
    ledger: Book,
    approvals: Option<FakeIdentity>,
}

/// A door over the stand-ins: the TEST partner on, the ledger counting every post, and identity's approvals unwired
/// (the TypeScript suite's router has none) or `approvals`.
fn door_over(
    db: &TestDb,
    ledger: &Book,
    people: &People,
    approvals: Option<&FakeIdentity>,
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
    if let Some(a) = approvals {
        w.approvals = Box::new(a.clone());
    }
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
        partner: Some(TestPartner::new().unwrap()),
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

fn bank_with(approvals: Option<FakeIdentity>) -> Option<Bank> {
    let db = TestDb::new()?;
    db.migrated();
    let ledger = Book::default();
    let people = People::default();
    for (n, handle) in [(OWNER, "owner"), (MEMBER, "member")] {
        people.person(&id(n), handle, Some(&format!("{handle}@example.test")));
    }
    let door = door_over(&db, &ledger, &people, approvals.as_ref());
    Some(Bank {
        door,
        db,
        ledger,
        approvals,
    })
}

fn bank() -> Option<Bank> {
    bank_with(None)
}

/// One period, as `from` and `to` fields of a call's input.
#[derive(Clone, Copy)]
struct Period(i64, i64);

impl Period {
    /// `period()`: from the first of this month to a minute from now.
    fn this_month() -> Period {
        let now = door::system_now().0;
        let month = Instant(now).iso()[..7].to_owned();
        let from = service_kit::time::js_date(&format!("{month}-01T00:00:00.000Z"))
            .unwrap()
            .0;
        Period(from, now + 60_000)
    }

    fn fields(self) -> String {
        format!(
            r#""from":"{}","to":"{}""#,
            Instant(self.0).iso(),
            Instant(self.1).iso()
        )
    }
}

/// The owner's EUR business, as `business()` makes it.
struct Business {
    account_id: String,
    card_id: String,
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

    /// The ledger posted nothing (`ledger.journal()` is empty).
    fn ledger_untouched(&self) {
        assert_eq!(self.ledger.calls(), 0, "{:?}", self.ledger.keys());
    }

    fn line_codes(&self) -> i64 {
        self.db
            .client()
            .query_one("SELECT count(*) FROM bank.business_line_codes", &[])
            .unwrap()
            .get(0)
    }

    /// The owner's EUR business with TEST 1000 at the partner, a viewer on the team, and a month of TEST card activity.
    fn business(&self) -> Business {
        self.ok(OWNER, "testPartner.set", r#"{"custody":"off"}"#);
        let account_id = uuid();
        self.ok(
            OWNER,
            "business.create",
            &format!(r#"{{"accountId":"{account_id}","name":"TEST Books Ltd","assetId":"EUR","spendThreshold":"500"}}"#),
        );
        self.ok(
            OWNER,
            "testPartner.fundBusiness",
            &format!(
                r#"{{"accountId":"{account_id}","fundId":"fund-{account_id}","amount":"1000"}}"#
            ),
        );
        let made = self.ok(
            OWNER,
            "businessTeam.invite",
            &format!(
                r#"{{"accountId":"{account_id}","inviteId":"{}","email":null,"role":"viewer","roleId":null}}"#,
                uuid()
            ),
        );
        self.ok(
            MEMBER,
            "businessTeam.acceptInvite",
            &format!(r#"{{"token":"{}"}}"#, s(&made, "token")),
        );
        let card_id = uuid();
        self.db
            .client()
            .execute(
                "INSERT INTO bank.business_cards (id, account_id, member_user_id, asset_id, per_purchase_limit, pan_tail, issued_by) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, 'EUR', 500, '4242', $3)",
                &[&card_id, &account_id, &id(OWNER)],
            )
            .unwrap();
        let b = Business {
            account_id,
            card_id,
        };
        for (m, a) in [
            ("TESTSHOP Berlin", "12.50"),
            ("Other Cafe", "4.20"),
            ("TESTSHOP Online", "30"),
            ("testshop kiosk", "7.30"),
        ] {
            self.buy(&b, m, a);
        }
        b
    }

    /// A captured purchase on the owner's card, as `businessCards.testPurchase` leaves it: its row, and one move at
    /// the partner from the business's own account to the TEST merchant under its capture key.
    fn buy(&self, b: &Business, merchant: &str, amount: &str) {
        let purchase_id = uuid();
        let key = format!("bank.business.card-capture:{purchase_id}");
        let moved = self
            .partner()
            .lock()
            .move_raw(
                &MoveRequest {
                    key: key.clone(),
                    from: AccountRef::main(&format!("business:{}", b.account_id), "EUR"),
                    to: AccountRef::main(MERCHANT, "EUR"),
                    amount: parse_amount(amount).unwrap(),
                    payees: None,
                },
                door::system_now(),
            )
            .unwrap();
        self.db
            .client()
            .execute(
                "INSERT INTO bank.business_card_purchases \
                   (id, card_id, account_id, member_user_id, merchant, asset_id, amount, status, partner_key, partner_move_id, captured_at) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5, 'EUR', $6::text::numeric, 'captured', $7, $8, now())",
                &[&purchase_id, &b.card_id, &b.account_id, &id(OWNER), &merchant, &amount, &key, &moved.id],
            )
            .unwrap();
    }

    fn lines(&self, account_id: &str, p: Period) -> Vec<Json> {
        items(
            &self.ok(
                OWNER,
                "businessBooks.lines",
                &format!(r#"{{"accountId":"{account_id}",{}}}"#, p.fields()),
            ),
            "items",
        )
    }

    fn export(&self, who: u32, account_id: &str, p: Period, format: &str, extra: &str) -> Answer {
        self.call(
            who,
            "businessBooks.exportStatement",
            &format!(
                r#"{{"accountId":"{account_id}",{},"format":"{format}","exportId":"{}"{extra}}}"#,
                p.fields(),
                uuid()
            ),
        )
    }
}

fn items(v: &Json, key: &str) -> Vec<Json> {
    match v.get(key) {
        Some(Json::Array(a)) => a.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn find<'a>(lines: &'a [Json], key: &str, value: &str) -> &'a Json {
    lines
        .iter()
        .find(|l| s(l, key) == value)
        .unwrap_or_else(|| panic!("no line with {key} {value}"))
}

fn body(file: &Json) -> String {
    String::from_utf8(STANDARD.decode(s(file, "bodyBase64")).unwrap()).unwrap()
}

#[test]
fn n1_connecting_accounting_is_switched_off_and_its_record_kept_the_bank_feed_by_file_has_every_line()
 {
    let Some(b) = bank() else { return };
    let biz = b.business();
    let acc = format!(r#"{{"accountId":"{}"}}"#, biz.account_id);
    assert_eq!(
        b.ok(OWNER, "businessBooks.overview", &acc)
            .get("connection"),
        Some(&Json::Null)
    );
    let first = b.ok(OWNER, "businessBooks.connectAccounting", &acc);
    has(
        &first,
        &format!(
            r#"{{"status":"switched_off","needs":"vendor.accounting","requestedBy":"{}","attempts":1}}"#,
            id(OWNER)
        ),
    );
    has(
        &b.ok(OWNER, "businessBooks.connectAccounting", &acc),
        r#"{"attempts":2}"#,
    );
    has(
        b.ok(OWNER, "businessBooks.overview", &acc)
            .get("connection")
            .unwrap(),
        r#"{"status":"switched_off","attempts":2}"#,
    );
    b.call(MEMBER, "businessBooks.connectAccounting", &acc)
        .refused("bank.business_role_forbidden");

    let p = Period::this_month();
    let feed = b.export(OWNER, &biz.account_id, p, "csv", "").ok();
    let csv = body(&feed);
    let lines = b.lines(&biz.account_id, p);
    assert_eq!(lines.len(), 5, "the pay-in and four purchases");
    for l in &lines {
        assert!(csv.contains(&s(l, "id")), "{}", s(l, "id"));
    }
    b.ledger_untouched();
}

#[test]
fn n2_a_rules_test_run_shows_its_3_matches_and_codes_nothing_saved_it_codes_them_and_a_new_matching_line_bulk_coding_and_gl_codes()
 {
    let Some(b) = bank() else { return };
    let biz = b.business();
    let a = &biz.account_id;
    let p = Period::this_month();
    let tried = b.ok(
        OWNER,
        "businessBooks.testRule",
        &format!(
            r#"{{"accountId":"{a}",{},"payeeContains":"TESTSHOP"}}"#,
            p.fields()
        ),
    );
    let mut payees: Vec<String> = items(&tried, "matches")
        .iter()
        .map(|l| s(l, "payee"))
        .collect();
    payees.sort();
    assert_eq!(
        payees,
        ["TESTSHOP Berlin", "TESTSHOP Online", "testshop kiosk"]
    );
    assert_eq!(b.line_codes(), 0);
    b.call(
        MEMBER,
        "businessBooks.testRule",
        &format!(
            r#"{{"accountId":"{a}",{},"payeeContains":"TESTSHOP"}}"#,
            p.fields()
        ),
    )
    .refused("bank.business_role_forbidden");

    let rule_id = uuid();
    b.ok(
        OWNER,
        "businessBooks.saveRule",
        &format!(r#"{{"accountId":"{a}","ruleId":"{rule_id}","payeeContains":"TESTSHOP","category":"Supplies","glCode":"6100"}}"#),
    );
    b.call(
        OWNER,
        "businessBooks.saveRule",
        &format!(r#"{{"accountId":"{a}","ruleId":"{rule_id}","payeeContains":"TESTSHOP","category":"Travel"}}"#),
    )
    .refused("bank.business_request_conflict");
    let lines = b.lines(a, p);
    assert_eq!(
        lines
            .iter()
            .filter(|l| s(l, "category") == "Supplies"
                && s(l, "codedBy") == "rule"
                && s(l, "glCode") == "6100")
            .count(),
        3
    );

    // A new matching line is coded as it arrives.
    b.buy(&biz, "TESTSHOP Airport", "9.99");
    let lines = b.lines(a, p);
    has(
        find(&lines, "payee", "TESTSHOP Airport"),
        &format!(r#"{{"category":"Supplies","codedBy":"rule","ruleId":"{rule_id}"}}"#),
    );

    // Bulk: the pay-in and the cafe line at once, with a GL code; a person's code stands over a rule's.
    let pay_in = s(find(&lines, "payee", "Pay-in"), "id");
    let cafe = s(find(&lines, "payee", "Other Cafe"), "id");
    let berlin = s(find(&lines, "payee", "TESTSHOP Berlin"), "id");
    let coded = b.ok(
        OWNER,
        "businessBooks.codeLines",
        &format!(
            r#"{{"accountId":"{a}",{},"lineIds":["{pay_in}","{cafe}","{berlin}"],"category":"Office","glCode":"6200"}}"#,
            p.fields()
        ),
    );
    let got: Vec<[String; 3]> = items(&coded, "items")
        .iter()
        .map(|l| [s(l, "category"), s(l, "glCode"), s(l, "codedBy")])
        .collect();
    let want = ["Office", "6200", "person"].map(str::to_owned);
    assert_eq!(got, vec![want.clone(), want.clone(), want]);
    let lines = b.lines(a, p);
    has(
        find(&lines, "id", &berlin),
        r#"{"category":"Office","codedBy":"person"}"#,
    );
    b.call(
        OWNER,
        "businessBooks.codeLines",
        &format!(
            r#"{{"accountId":"{a}",{},"lineIds":["test-partner-move-nope"],"category":"X"}}"#,
            p.fields()
        ),
    )
    .refused("bank.business_line_not_found");
    b.call(
        OWNER,
        "businessBooks.codeLines",
        &format!(
            r#"{{"accountId":"{a}",{},"lineIds":["{cafe}"]}}"#,
            p.fields()
        ),
    )
    .refused("bank.business_books_field_invalid");
    b.ledger_untouched();
}

/// Every `T<amount>` line of a QIF file, signed.
fn qif_amounts(qif: &str) -> Vec<Amount> {
    qif.split("\r\n")
        .filter_map(|l| l.strip_prefix('T'))
        .map(|a| match a.strip_prefix('-') {
            Some(x) => -parse_amount(x).unwrap(),
            None => parse_amount(a).unwrap(),
        })
        .collect()
}

#[test]
fn n3_four_formats_carry_the_partner_statements_closing_balance_and_line_count_and_each_line_id_window_and_sca_refuse()
 {
    let Some(b) = bank() else { return };
    let biz = b.business();
    let a = &biz.account_id;
    let p = Period::this_month();
    let theirs = b
        .partner()
        .lock()
        .statement(
            &AccountRef::main(&format!("business:{a}"), "EUR"),
            Instant(p.0),
            Instant(p.1),
            door::system_now(),
        )
        .unwrap();
    assert_eq!(theirs.opening, Amount::ZERO);
    assert_eq!(format_amount(theirs.closing), "946");
    assert_eq!(theirs.lines, 5);
    let ids: Vec<String> = b.lines(a, p).iter().map(|l| s(l, "id")).collect();
    let text = |format: &str| {
        let f = b.export(OWNER, a, p, format, "").ok();
        has(
            &f,
            r#"{"closing":"946","lineCount":5,"partner":{"closing":"946","lines":5}}"#,
        );
        let body = body(&f);
        for id in &ids {
            assert!(body.contains(id), "{format}: {id}");
        }
        body
    };
    let csv = text("csv");
    assert!(csv.contains("Closing balance,946"));
    assert!(csv.contains("Line count,5"));
    let mt = text("mt940");
    let closing = mt.split("\r\n").find(|l| l.starts_with(":62F:")).unwrap();
    let rest = closing.strip_prefix(":62F:C").unwrap();
    assert!(rest[..6].bytes().all(|c| c.is_ascii_digit()), "{closing}");
    assert_eq!(&rest[6..], "EUR946,");
    assert_eq!(
        mt.split("\r\n").filter(|l| l.starts_with(":61:")).count(),
        5
    );
    let camt = text("camt053");
    assert!(camt.contains(
        "<Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy=\"EUR\">946</Amt><CdtDbtInd>CRDT</CdtDbtInd>"
    ));
    assert!(camt.contains("<NbOfNtries>5</NbOfNtries>"));
    let qif = text("qif");
    let amounts = qif_amounts(&qif);
    assert_eq!(amounts.len() - 1, 5);
    assert_eq!(
        amounts.iter().copied().sum::<Amount>(),
        parse_amount("946").unwrap()
    );

    // A viewer exports nothing.
    b.export(MEMBER, a, p, "csv", "")
        .refused("bank.business_role_forbidden");
    // The history window: 400 days at the TEST partner.
    let now = door::system_now().0;
    b.export(
        OWNER,
        a,
        Period(now - 500 * DAY, now - 480 * DAY),
        "csv",
        "",
    )
    .refused("bank.statement_history_window");
    // Further back than 90 days needs a fresh strong customer authentication; identity is not wired, so it fails
    // closed.
    let back = Period(now - 100 * DAY, p.1);
    b.export(OWNER, a, back, "csv", "")
        .refused("bank.step_up_required");
    b.export(OWNER, a, back, "csv", r#","stepUpApprovalId":"appr-1""#)
        .refused("bank.step_up_unavailable");

    // A statement that disagrees with the partner's own gives no file: one line on the business's record at the
    // partner that its statement of the account does not list.
    {
        let mut partner = b.partner().lock();
        let line = Move {
            id: partner.book.next_id("move"),
            key: format!("test.books.unlisted:{a}"),
            from: AccountRef {
                user_id: format!("business:{a}"),
                asset_id: "EUR".to_owned(),
                space_id: Some(uuid()),
            },
            to: AccountRef {
                user_id: format!("business:{a}"),
                asset_id: "EUR".to_owned(),
                space_id: Some(uuid()),
            },
            amount: parse_amount("1").unwrap(),
            moved_at: door::system_now(),
            label: svc_bank::partner::LABEL,
            payees: None,
        };
        partner.book.note(&format!("business:{a}"), line);
    }
    b.export(OWNER, a, p, "qif", "")
        .refused("bank.statement_mismatch");
    b.ledger_untouched();
}

#[test]
fn an_approved_confirmation_lets_the_old_period_through_once_per_export_and_period() {
    let Some(b) = bank_with(Some(FakeIdentity::default())) else {
        return;
    };
    let biz = b.business();
    let a = &biz.account_id;
    let now = door::system_now().0;
    let back = Period(now - 100 * DAY, now + 60_000);
    let export_id = uuid();
    let binding = Binding {
        action_type: "bank.step_up.businessBooks.exportStatement",
        operation_key: export_id.clone(),
        fields: [
            ("actor", id(OWNER)),
            ("accountId", a.clone()),
            ("exportId", export_id.clone()),
            ("from", Instant(back.0).iso()),
            ("to", Instant(back.1).iso()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect(),
    };
    let approval = b.approvals.as_ref().unwrap().approve(&id(OWNER), &binding);
    let send = |p: Period| {
        b.call(
            OWNER,
            "businessBooks.exportStatement",
            &format!(
                r#"{{"accountId":"{a}",{},"format":"camt053","exportId":"{export_id}","stepUpApprovalId":"{approval}"}}"#,
                p.fields()
            ),
        )
    };
    has(&send(back).ok(), r#"{"format":"camt053","lineCount":5}"#);
    has(&send(back).ok(), r#"{"format":"camt053","lineCount":5}"#);
    send(Period(back.0 + 1, back.1)).refused("bank.step_up_mismatch");
    b.ledger_untouched();
}
