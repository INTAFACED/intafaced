//! Slice `business-payouts`' database suite: the checks of `business/business-payouts.db.test.ts` (J-bank-21), each through
//! the door, on a real Postgres, with the TEST partner bank holding the business's money (`business_kit`'s ledger
//! stand-in counts every post, and none may be made).
//!
//! Ported as written: importing holds and moves nothing; under the threshold a run is one instruction carrying every
//! valid line, sent once; the partner refuses recipients that do not add up; a run id cannot be reused on another file
//! or left blank; the same import at once is one run; at or above the threshold a different approver; an unfunded run
//! stays a draft and a lost answer is read back by its key; a contractor batch under the approval rules, once; with no
//! partner the batch is kept refused `rail.bank`; self-onboarding once and crypto payroll signed by the business's own
//! wallet only, the same month at once being one run. The CSV test is `csv.rs`' unit test.
//!
//! Differences in how the TypeScript sets the scene, the checks unchanged: the approver joins as a `checker` through
//! `business.addMember` where the TypeScript invites them (slice `business-team`, not ported yet), and the approval
//! rule is written as its row where the TypeScript calls `businessTeam.addRule`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test suite: a failure is the point"
)]

use k256::ecdsa::SigningKey;
use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::time::Instant;
use sha3::{Digest, Keccak256};
use svc_bank::automations::own_moves::wallet::personal_message_hash;
use svc_bank::business::payouts::{bulk_pay_key, contractor_batch_key, crypto_payroll_key};
use svc_bank::partner::{AccountRef, MoveRequest, MovesQuery, Payee, TestPartner, payouts_account};

use crate::business_kit::{Bank, Mount, WRITE, bank_with, call, j, s, uuid};

const OWNER: &str = "00000000-0000-4000-8000-000000000001";
const A1: &str = "00000000-0000-4000-8000-000000000004";
const CONTRACTOR: &str = "00000000-0000-4000-8000-000000000008";
const IBANS: [&str; 3] = [
    "DE89370400440532013000",
    "GB82WEST12345698765432",
    "NL91ABNA0417164300",
];

fn csv() -> String {
    [
        "name,iban,amount,currency,reference".to_owned(),
        format!("TEST Ana,{},100.00,USDT,Nov", IBANS[0]),
        format!("TEST Ben,{},150.50,USDT,Nov", IBANS[1]),
        format!("TEST Cy,{},49.50,USDT,Nov", IBANS[2]),
        "TEST Dee,FR1420041010050500013M02606,12.3.4,USDT,Nov".to_owned(),
        format!("TEST Ana,{},100.00,USDT,Nov", IBANS[0]),
    ]
    .join("\n")
}

fn amt(v: &str) -> Amount {
    parse_amount(v).unwrap()
}

/// A TEST wallet key, public and made for this test only.
fn key(seed: &str) -> SigningKey {
    SigningKey::from_slice(&Keccak256::digest(seed.as_bytes())).unwrap()
}

fn business_key() -> SigningKey {
    key("TEST J-bank-21 business wallet")
}

fn other_key() -> SigningKey {
    key("TEST J-bank-21 someone else")
}

fn address_of(k: &SigningKey) -> String {
    let point = k.verifying_key().to_sec1_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    format!(
        "0x{}",
        hash[12..]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// What a wallet's `personal_sign` returns: the EIP-191 digest signed, `r || s || v` with v 27/28.
fn personal_sign(message: &str, k: &SigningKey) -> String {
    let (sig, id) = k.sign_prehash_recoverable(&personal_message_hash(message));
    let rs: [u8; 64] = sig.to_bytes().into();
    let hex: String = rs.iter().map(|b| format!("{b:02x}")).collect();
    format!("0x{hex}{:02x}", id.to_byte() + 27)
}

fn bank() -> Option<Bank> {
    bank_with(Mount {
        test_partner: true,
        ..Mount::default()
    })
}

fn partner(b: &Bank) -> &TestPartner {
    b.door.partner().partner.as_ref().unwrap()
}

fn business_ref(account_id: &str) -> AccountRef {
    AccountRef::main(&format!("business:{account_id}"), "USDT")
}

fn now() -> Instant {
    svc_bank::door::system_now()
}

/// What the partner holds for the business.
fn held(b: &Bank, account_id: &str) -> Amount {
    partner(b)
        .lock()
        .report(&business_ref(account_id), now())
        .amount
        .unwrap()
}

/// The business's moves at the partner, newest first.
fn moves(b: &Bank, account_id: &str) -> Vec<svc_bank::partner::Move> {
    partner(b).lock().moves(
        &format!("business:{account_id}"),
        &MovesQuery {
            limit: 50,
            before: None,
            asset_id: None,
            pay_ins: false,
        },
    )
}

fn moves_under(b: &Bank, account_id: &str, key: &str) -> Vec<svc_bank::partner::Move> {
    moves(b, account_id)
        .into_iter()
        .filter(|m| m.key == key)
        .collect()
}

fn ok(b: &Bank, user: &str, path: &str, input: &Json) -> Json {
    call(b, user, WRITE, path, input).ok()
}

fn code(b: &Bank, user: &str, path: &str, input: &Json) -> String {
    call(b, user, WRITE, path, input).code()
}

fn items(v: &Json) -> Vec<Json> {
    match v {
        Json::Array(a) => a.clone(),
        other => panic!("not an array: {}", other.compact()),
    }
}

fn obj(pairs: &[(&str, Json)]) -> Json {
    Json::Object(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

fn st(v: &str) -> Json {
    Json::str(v)
}

/// The owner's business, its money at the TEST partner (TEST `funded` USDT), threshold 500, an approver on the team.
fn business(b: &Bank, funded: &str, at_partner: bool) -> String {
    if at_partner {
        ok(b, OWNER, "testPartner.set", &j(r#"{"custody":"off"}"#));
    }
    let account_id = uuid();
    ok(
        b,
        OWNER,
        "business.create",
        &obj(&[
            ("accountId", st(&account_id)),
            ("name", st("TEST Payroll Ltd")),
            ("assetId", st("USDT")),
            ("spendThreshold", st("500")),
        ]),
    );
    if at_partner {
        ok(
            b,
            OWNER,
            "testPartner.fundBusiness",
            &obj(&[
                ("accountId", st(&account_id)),
                ("fundId", st(&format!("fund-{account_id}"))),
                ("amount", st(funded)),
            ]),
        );
    }
    ok(
        b,
        OWNER,
        "business.addMember",
        &obj(&[
            ("accountId", st(&account_id)),
            ("userId", st(A1)),
            ("role", st("checker")),
        ]),
    );
    account_id
}

fn import(b: &Bank, account_id: &str, run_id: &str, text: &str) -> Json {
    ok(
        b,
        OWNER,
        "businessPayouts.importRun",
        &obj(&[
            ("accountId", st(account_id)),
            ("runId", st(run_id)),
            ("csv", st(text)),
        ]),
    )
}

fn run_input(run_id: &str) -> Json {
    obj(&[("runId", st(run_id))])
}

fn ledger_untouched(b: &Bank) {
    assert_eq!(
        b.ledger.calls(),
        0,
        "the ledger posts nothing for any of this"
    );
}

#[test]
fn importing_holds_and_moves_nothing_and_under_the_threshold_it_is_one_instruction_sent_once() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    let run_id = uuid();
    let run = import(&b, &account_id, &run_id, &csv());
    assert_eq!(s(&run, "status"), "draft");
    assert_eq!(s(&run, "total"), "300");
    assert_eq!(
        items(run.get("issues").unwrap())
            .iter()
            .map(|i| s(i, "code"))
            .collect::<Vec<_>>(),
        ["amount_invalid", "duplicate_line"]
    );
    assert_eq!(held(&b, &account_id), amt("1000"));
    assert!(moves(&b, &account_id).is_empty());

    let sent = ok(&b, OWNER, "businessPayouts.confirmRun", &run_input(&run_id));
    assert_eq!(s(&sent, "status"), "sent");
    assert_eq!(s(&sent, "partnerKey"), bulk_pay_key(&run_id));
    assert_eq!(held(&b, &account_id), amt("700"));
    // Confirmed again: the same run, still one instruction.
    assert_eq!(
        s(
            &ok(&b, OWNER, "businessPayouts.confirmRun", &run_input(&run_id)),
            "status"
        ),
        "sent"
    );
    let out = moves_under(&b, &account_id, &bulk_pay_key(&run_id));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].amount, amt("300"));
    // The one instruction carries every valid line as its recipients, and nothing from the report.
    let payees: Vec<(String, String, Amount, Option<String>)> = out[0]
        .payees
        .clone()
        .unwrap()
        .into_iter()
        .map(|p| (p.name, p.iban, p.amount, p.reference))
        .collect();
    let nov = Some("Nov".to_owned());
    assert_eq!(
        payees,
        vec![
            (
                "TEST Ana".to_owned(),
                IBANS[0].to_owned(),
                amt("100"),
                nov.clone()
            ),
            (
                "TEST Ben".to_owned(),
                IBANS[1].to_owned(),
                amt("150.5"),
                nov.clone()
            ),
            ("TEST Cy".to_owned(), IBANS[2].to_owned(), amt("49.5"), nov),
        ]
    );
    assert_eq!(s(&sent, "partnerPayees"), "3");
    ledger_untouched(&b);
}

#[test]
fn the_partner_refuses_an_instruction_whose_recipients_do_not_add_up_and_moves_nothing() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    let key = format!("bank.business.bulk-pay:{}", uuid());
    let payee = |a: &str| Payee {
        name: "TEST Ana".to_owned(),
        iban: IBANS[0].to_owned(),
        amount: amt(a),
        reference: None,
    };
    for payees in [vec![payee("100")], vec![]] {
        let refused = partner(&b)
            .lock()
            .move_raw(
                &MoveRequest {
                    key: key.clone(),
                    from: business_ref(&account_id),
                    to: payouts_account("USDT"),
                    amount: amt("300"),
                    payees: Some(payees),
                },
                now(),
            )
            .unwrap_err();
        match refused {
            svc_bank::errors::Refusal::Bank(e) => {
                assert_eq!(e.row.code, "bank.partner_amount_invalid")
            }
            other => panic!("{other:?}"),
        }
    }
    assert!(moves(&b, &account_id).is_empty());
}

#[test]
fn a_second_run_cannot_reuse_or_blank_the_run_key() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    let run_id = uuid();
    import(&b, &account_id, &run_id, &csv());
    let again = |id: &str, text: String| {
        call(
            &b,
            OWNER,
            WRITE,
            "businessPayouts.importRun",
            &obj(&[
                ("accountId", st(&account_id)),
                ("runId", st(id)),
                ("csv", st(&text)),
            ]),
        )
    };
    again(&run_id, format!("{}\n", csv())).refused("bank.business_request_conflict");
    assert_eq!(again("", csv()).trpc(), "BAD_REQUEST");
    assert_eq!(s(&again(&run_id, csv()).ok(), "id"), run_id);
}

#[test]
fn the_same_import_sent_several_times_at_once_is_one_run_and_every_call_gets_it_back() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    for round in 0..5 {
        let id = uuid();
        let runs: Vec<Json> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| import(&b, &account_id, &id, &csv())))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for r in &runs {
            assert_eq!(
                (
                    s(r, "id"),
                    s(r, "total"),
                    items(r.get("issues").unwrap()).len()
                ),
                (id.clone(), "300".to_owned(), 2),
                "round {round}"
            );
        }
        assert_eq!(
            b.count(&format!(
                "SELECT count(*)::int8 FROM bank.business_bulk_lines WHERE run_id = '{id}'::uuid"
            )),
            3
        );
    }
    assert_eq!(
        b.count(&format!(
            "SELECT count(*)::int8 FROM bank.business_bulk_runs WHERE account_id = '{account_id}'::uuid"
        )),
        5
    );
}

#[test]
fn at_or_above_the_threshold_it_waits_for_a_different_approver_then_sends_once() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    let text = format!(
        "name,iban,amount,currency\nTEST Ana,{},300,USDT\nTEST Ben,{},200,USDT",
        IBANS[0], IBANS[1]
    );
    let run_id = uuid();
    import(&b, &account_id, &run_id, &text);
    let waiting = ok(&b, OWNER, "businessPayouts.confirmRun", &run_input(&run_id));
    assert_eq!(s(&waiting, "status"), "awaiting_approval");
    assert_eq!(s(&waiting, "threshold"), "500");
    assert_eq!(held(&b, &account_id), amt("1000"));
    assert_eq!(
        code(&b, OWNER, "businessPayouts.approveRun", &run_input(&run_id)),
        "bank.business_self_approve"
    );
    let sent = ok(&b, A1, "businessPayouts.approveRun", &run_input(&run_id));
    assert_eq!(s(&sent, "status"), "sent");
    assert_eq!(held(&b, &account_id), amt("500"));
    assert_eq!(
        moves_under(&b, &account_id, &bulk_pay_key(&run_id)).len(),
        1
    );
    ledger_untouched(&b);
}

#[test]
fn an_unfunded_run_sends_nothing_and_a_lost_answer_is_read_back_by_its_key_and_paid_once() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "100", true);
    let run_id = uuid();
    import(&b, &account_id, &run_id, &csv());
    assert_eq!(
        code(&b, OWNER, "businessPayouts.confirmRun", &run_input(&run_id)),
        "bank.bulk_run_unfunded"
    );
    assert_eq!(
        s(
            &ok(&b, OWNER, "businessPayouts.run", &run_input(&run_id)),
            "status"
        ),
        "draft"
    );
    ok(
        &b,
        OWNER,
        "testPartner.fundBusiness",
        &obj(&[
            ("accountId", st(&account_id)),
            ("fundId", st(&format!("top-{account_id}"))),
            ("amount", st("900")),
        ]),
    );
    {
        let mut p = partner(&b).lock();
        let user = format!("business:{account_id}");
        let mut sw = p.board.read(&user, Clone::clone);
        "lost".clone_into(&mut sw.next_reply);
        p.board.set(&user, sw);
    }
    assert_eq!(
        code(&b, OWNER, "businessPayouts.confirmRun", &run_input(&run_id)),
        "bank.partner_reply_lost"
    );
    assert_eq!(
        s(
            &ok(&b, OWNER, "businessPayouts.run", &run_input(&run_id)),
            "status"
        ),
        "sending"
    );
    assert_eq!(
        s(
            &ok(&b, OWNER, "businessPayouts.confirmRun", &run_input(&run_id)),
            "status"
        ),
        "sent"
    );
    assert_eq!(
        moves_under(&b, &account_id, &bulk_pay_key(&run_id)).len(),
        1
    );
    assert_eq!(held(&b, &account_id), amt("700"));
}

fn add_contractor(b: &Bank, account_id: &str, contractor_id: &str, iban: &str) {
    ok(
        b,
        OWNER,
        "businessPayouts.addContractor",
        &obj(&[
            ("accountId", st(account_id)),
            ("contractorId", st(contractor_id)),
            ("name", st("TEST Dev Co")),
            ("email", Json::Null),
            ("iban", st(iban)),
            ("walletAddress", Json::Null),
        ]),
    );
}

fn add_invoice(b: &Bank, contractor_id: &str, number: &str, amount: &str) -> Json {
    ok(
        b,
        OWNER,
        "businessPayouts.addInvoice",
        &obj(&[
            ("contractorId", st(contractor_id)),
            ("invoiceId", st(&uuid())),
            ("number", st(number)),
            ("amount", st(amount)),
            ("dueDate", Json::Null),
        ]),
    )
}

fn pay_batch(account_id: &str, batch_id: &str, invoice_id: &str) -> Json {
    obj(&[
        ("accountId", st(account_id)),
        ("batchId", st(batch_id)),
        ("invoiceIds", Json::Array(vec![st(invoice_id)])),
    ])
}

fn first_invoice_status(b: &Bank, account_id: &str) -> String {
    let list = ok(
        b,
        OWNER,
        "businessPayouts.contractors",
        &obj(&[("accountId", st(account_id))]),
    );
    s(
        &items(items(&list)[0].get("invoices").unwrap())[0],
        "status",
    )
}

#[test]
fn a_contractor_with_an_invoice_of_500_paid_as_a_batch_under_the_approval_rules_once() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    b.sql()
        .execute(
            "INSERT INTO bank.business_payment_rules (id, account_id, over_amount, payee, payment_type, approvals, created_by) \
             VALUES ($1::text::uuid, $2::text::uuid, 100, NULL, NULL, 1, $3)",
            &[&uuid(), &account_id, &OWNER],
        )
        .unwrap();
    let contractor_id = uuid();
    add_contractor(&b, &account_id, &contractor_id, IBANS[0]);
    let c = add_invoice(&b, &contractor_id, "TEST-INV-1", "500.00");
    let invoices = items(c.get("invoices").unwrap());
    assert_eq!(
        invoices
            .iter()
            .map(|i| (s(i, "number"), s(i, "amount"), s(i, "status")))
            .collect::<Vec<_>>(),
        [("TEST-INV-1".to_owned(), "500".to_owned(), "open".to_owned())]
    );
    assert_eq!(s(&c, "ibanLast4"), "3000");
    let invoice_id = s(&invoices[0], "id");
    let batch_id = uuid();
    let waiting = ok(
        &b,
        OWNER,
        "businessPayouts.payBatch",
        &pay_batch(&account_id, &batch_id, &invoice_id),
    );
    assert_eq!(s(&waiting, "status"), "awaiting_approval");
    assert_eq!(s(&waiting, "partnerKey"), contractor_batch_key(&batch_id));
    assert_eq!(held(&b, &account_id), amt("1000"));
    let approve = obj(&[("batchId", st(&batch_id))]);
    assert_eq!(
        code(&b, OWNER, "businessPayouts.approveBatch", &approve),
        "bank.business_self_approve"
    );
    assert_eq!(
        code(
            &b,
            OWNER,
            "businessPayouts.payBatch",
            &pay_batch(&account_id, &uuid(), &invoice_id)
        ),
        "bank.contractor_invoice_not_open"
    );
    let sent = ok(&b, A1, "businessPayouts.approveBatch", &approve);
    assert_eq!(s(&sent, "status"), "sent");
    assert_eq!(held(&b, &account_id), amt("500"));
    let out = moves_under(&b, &account_id, &contractor_batch_key(&batch_id));
    assert_eq!(out.len(), 1);
    let payees: Vec<_> = out[0]
        .payees
        .clone()
        .unwrap()
        .into_iter()
        .map(|p| (p.name, p.iban, p.amount, p.reference))
        .collect();
    assert_eq!(
        payees,
        vec![(
            "TEST Dev Co".to_owned(),
            IBANS[0].to_owned(),
            amt("500"),
            Some("TEST-INV-1".to_owned())
        )]
    );
    assert_eq!(s(&sent, "partnerPayees"), "1");
    assert_eq!(first_invoice_status(&b, &account_id), "paid");
    ledger_untouched(&b);
}

#[test]
fn with_no_partner_payout_rail_the_intent_is_kept_refused_with_rail_bank_and_nothing_moves() {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "0", false);
    let contractor_id = uuid();
    add_contractor(&b, &account_id, &contractor_id, IBANS[1]);
    let c = add_invoice(&b, &contractor_id, "TEST-INV-2", "500");
    let invoice_id = s(&items(c.get("invoices").unwrap())[0], "id");
    let batch = ok(
        &b,
        OWNER,
        "businessPayouts.payBatch",
        &pay_batch(&account_id, &uuid(), &invoice_id),
    );
    assert_eq!(s(&batch, "status"), "refused");
    assert_eq!(s(&batch, "refusalCode"), "rail.bank");
    assert_eq!(first_invoice_status(&b, &account_id), "open");
    ledger_untouched(&b);
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one story, as the TypeScript's test tells it"
)]
fn contractor_self_onboarding_once_and_each_crypto_payroll_run_signed_by_the_business_own_wallet_only()
 {
    let Some(b) = bank() else { return };
    let account_id = business(&b, "1000", true);
    let invite = ok(
        &b,
        OWNER,
        "businessPayouts.createInvite",
        &obj(&[("accountId", st(&account_id))]),
    );
    let token = s(&invite, "token");
    let info = ok(
        &b,
        CONTRACTOR,
        "businessPayouts.inviteInfo",
        &obj(&[("token", st(&token))]),
    );
    assert_eq!(
        info.compact(),
        r#"{"businessName":"TEST Payroll Ltd","open":true}"#
    );
    let wallet = address_of(&other_key());
    let join = |user: &str, name: &str| {
        call(
            &b,
            user,
            WRITE,
            "businessPayouts.joinAsContractor",
            &obj(&[
                ("token", st(&token)),
                ("name", st(name)),
                ("email", Json::Null),
                ("iban", Json::Null),
                ("walletAddress", st(&wallet)),
            ]),
        )
    };
    let joined = join(CONTRACTOR, "TEST Remote Dev").ok();
    join(A1, "x").refused("bank.contractor_invite_used");
    let payroll_id = uuid();
    let create = || {
        obj(&[
            ("accountId", st(&account_id)),
            ("payrollId", st(&payroll_id)),
            ("name", st("TEST Monthly")),
            ("dayOfMonth", Json::int(25)),
            (
                "members",
                Json::Array(vec![obj(&[
                    ("contractorId", st(&s(&joined, "contractorId"))),
                    ("amount", st("250")),
                ])]),
            ),
        ])
    };
    assert_eq!(
        code(&b, OWNER, "businessPayouts.createPayroll", &create()),
        "bank.payroll_wallet_missing"
    );
    let address = address_of(&business_key());
    let offer = ok(
        &b,
        OWNER,
        "businessPayouts.walletOffer",
        &obj(&[("accountId", st(&account_id)), ("address", st(&address))]),
    );
    let connect = |offer: &Json, k: &SigningKey| {
        call(
            &b,
            OWNER,
            WRITE,
            "businessPayouts.connectWallet",
            &obj(&[
                ("offerId", st(&s(offer, "offerId"))),
                ("signature", st(&personal_sign(&s(offer, "message"), k))),
            ]),
        )
    };
    connect(&offer, &other_key()).refused("bank.payroll_signature_invalid");
    assert_eq!(
        s(&connect(&offer, &business_key()).ok(), "address"),
        address
    );
    ok(&b, OWNER, "businessPayouts.createPayroll", &create());
    let prepare = |period: &str| {
        call(
            &b,
            OWNER,
            WRITE,
            "businessPayouts.prepareRun",
            &obj(&[("payrollId", st(&payroll_id)), ("period", st(period))]),
        )
    };
    let prepared = prepare("2026-12").ok();
    let run = items(prepared.get("runs").unwrap())[0].clone();
    assert_eq!(
        s(&run, "runKey"),
        crypto_payroll_key(&payroll_id, "2026-12")
    );
    assert_eq!(
        items(run.get("payslips").unwrap())
            .iter()
            .map(|p| (s(p, "name"), s(p, "amount"), s(p, "walletAddress")))
            .collect::<Vec<_>>(),
        [(
            "TEST Remote Dev".to_owned(),
            "250".to_owned(),
            wallet.clone()
        )]
    );
    assert_eq!(items(prepare("2026-12").ok().get("runs").unwrap()).len(), 1);
    let sign = |run: &Json, k: &SigningKey| {
        call(
            &b,
            OWNER,
            WRITE,
            "businessPayouts.signRun",
            &obj(&[
                ("runId", st(&s(run, "id"))),
                ("signature", st(&personal_sign(&s(run, "message"), k))),
            ]),
        )
    };
    sign(&run, &other_key()).refused("bank.payroll_signature_invalid");
    let signed = sign(&run, &business_key()).ok();
    let first = &items(signed.get("runs").unwrap())[0];
    assert_eq!(s(first, "status"), "signed");
    assert_eq!(s(first, "walletAddress"), address);

    // The business replaces its wallet: a run prepared for the old one is no longer signed by it.
    let later = items(prepare("2027-01").ok().get("runs").unwrap())
        .into_iter()
        .find(|r| s(r, "period") == "2027-01")
        .unwrap();
    let next = ok(
        &b,
        OWNER,
        "businessPayouts.walletOffer",
        &obj(&[
            ("accountId", st(&account_id)),
            ("address", st(&address_of(&other_key()))),
        ]),
    );
    connect(&next, &other_key()).ok();
    sign(&later, &business_key()).refused("bank.payroll_wallet_missing");
    // The same month pressed several times at once is one run with its payslips once, and no caller gets 23505.
    for month in 3..=12 {
        let period = format!("2027-{month:02}");
        let raced: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| prepare(&period).code()))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(raced.iter().all(|c| c == "ok"), "{period}: {raced:?}");
        let runs = b
            .sql()
            .query(
                "SELECT id::text FROM bank.business_crypto_payroll_runs WHERE payroll_id = $1::text::uuid AND period = $2",
                &[&payroll_id, &period],
            )
            .unwrap();
        assert_eq!(runs.len(), 1);
        let run_id: String = runs[0].get(0);
        assert_eq!(
            b.count(&format!(
                "SELECT count(*)::int8 FROM bank.business_crypto_payslips WHERE run_id = '{run_id}'::uuid"
            )),
            1
        );
    }
    // INTAFACED holds none of it: the partner balance and the ledger are untouched.
    assert_eq!(held(&b, &account_id), amt("1000"));
    ledger_untouched(&b);
}
