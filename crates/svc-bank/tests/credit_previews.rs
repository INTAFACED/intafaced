//! Slice `credit-previews` through the door, as a person calls it. Ports `services/svc-bank/src/loans/
//! credit-card-preview.test.ts`, `credit-previews.test.ts` and `src/cards/fraud-preview.test.ts`, each test named after
//! the TypeScript test's words. The wire replay sends one sample input to each call; these send every value each
//! input's enum takes, so every engine action's refusal is held, not only the sampled one.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};

const SECRET: &str = "a-bank-credit-previews-edge-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const LABEL: &str = "Preview · sample data";

fn bank() -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        services: ServiceAuth::unwired(),
        env,
        now: door::system_now,
    })
    .unwrap()
}

/// A fully verified person in DE holding `scopes`, with a second factor.
fn person(scopes: &[&str]) -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("full")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
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

const READ: &[&str] = &["bank:read"];
const WRITE: &[&str] = &["bank:read", "bank:write"];
const TREASURY: &[&str] = &["admin:treasury"];

/// A query with no input.
fn query(scopes: &[&str], path: &str) -> (u16, Json) {
    answer(&bank(), "GET", &format!("/trpc/{path}"), "", person(scopes))
}

/// A mutation with `input` as its JSON body.
fn mutate(scopes: &[&str], path: &str, input: &str) -> (u16, Json) {
    let mut h = person(scopes);
    h.push(("content-type".to_owned(), "application/json".to_owned()));
    answer(&bank(), "POST", &format!("/trpc/{path}"), input, h)
}

fn answer(
    door: &BankDoor,
    method: &str,
    url: &str,
    body: &str,
    headers: Vec<(String, String)>,
) -> (u16, Json) {
    let res = door.handle(&Request {
        method,
        url,
        headers: &headers,
        body,
    });
    (res.status, json::parse(&res.body).unwrap())
}

fn data(body: &Json) -> &Json {
    body.get("result").and_then(|r| r.get("data")).unwrap()
}

fn text<'a>(j: &'a Json, key: &str) -> &'a str {
    match j.get(key) {
        Some(Json::String(s)) => s,
        other => panic!("{key} is not a string: {other:?}"),
    }
}

fn list<'a>(j: &'a Json, key: &str) -> &'a [Json] {
    match j.get(key) {
        Some(Json::Array(a)) => a,
        other => panic!("{key} is not a list: {other:?}"),
    }
}

fn int(j: &Json, key: &str) -> i128 {
    match j.get(key) {
        Some(Json::Number(n)) => {
            #[expect(clippy::cast_possible_truncation, reason = "small integers")]
            let v = *n as i128;
            v
        }
        other => panic!("{key} is not a number: {other:?}"),
    }
}

/// A decimal string in cents.
fn cents(s: &str) -> i128 {
    s.replace('.', "").parse().unwrap()
}

fn every_row_test(rows: &[Json]) {
    assert!(!rows.is_empty());
    for row in rows {
        assert_eq!(row.get("test"), Some(&Json::Bool(true)), "{row:?}");
    }
}

/// The typed Preview refusal for `engine`'s `action`.
fn refusal(engine: &str, action: &str) -> Json {
    Json::obj([
        ("kind", Json::str("preview")),
        ("code", Json::str("preview.engine_not_built")),
        ("engine", Json::str(engine)),
        ("action", Json::str(action)),
        ("label", Json::str(LABEL)),
    ])
}

/// PRECONDITION_FAILED `preview.engine_not_built — <engine>:<action>`, the code as `data.cause` and the refusal as
/// `data.preview`.
fn expect_refused((status, body): (u16, Json), engine: &str, action: &str) {
    assert_eq!(status, 412, "{}", body.compact());
    let error = body.get("error").unwrap();
    assert_eq!(
        text(error, "message"),
        format!("preview.engine_not_built — {engine}:{action}")
    );
    let d = error.get("data").unwrap();
    assert_eq!(text(d, "code"), "PRECONDITION_FAILED");
    assert_eq!(
        d.get("cause"),
        Some(&Json::obj([(
            "code",
            Json::str("preview.engine_not_built")
        )]))
    );
    assert_eq!(d.get("preview"), Some(&refusal(engine, action)));
}

fn status_code((status, body): (u16, Json)) -> (u16, String) {
    let code = body
        .get("error")
        .and_then(|e| e.get("data"))
        .map(|d| text(d, "code").to_owned())
        .unwrap_or_default();
    (status, code)
}

const RESTRICTIONS: [&str; 5] = [
    "cash_withdrawal",
    "gambling",
    "crypto",
    "balance_transfer",
    "money_transfer",
];

// ---- credit card preview -------------------------------------------------------------------------------------------

#[test]
fn credit_card_is_labelled_blurred_covers_every_tab_and_serves_test_rows_with_no_invented_number() {
    let (status, body) = query(READ, "creditCard.preview");
    assert_eq!(status, 200);
    let view = data(&body);
    assert_eq!(text(view, "label"), LABEL);
    assert_eq!(view.get("preview"), Some(&Json::Bool(true)));
    assert_eq!(view.get("blurred"), Some(&Json::Bool(true)));
    let tabs: Vec<&str> = list(view, "tabs")
        .iter()
        .map(|t| match t {
            Json::String(s) => s.as_str(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(
        tabs,
        [
            "application",
            "limit",
            "repayment",
            "usage_rules",
            "statements"
        ]
    );
    let rows = list(view, "rows");
    every_row_test(rows);
    let mut row_tabs: Vec<&str> = rows.iter().map(|r| text(r, "tab")).collect();
    row_tabs.dedup();
    assert_eq!(row_tabs, tabs);
    let items: Vec<&str> = rows.iter().map(|r| text(r, "item")).collect();
    for want in [
        "pay_in_full",
        "pay_early",
        "pay_extra",
        "choose_date",
        "variant:daily",
        "variant:thirty_day",
        "fee:foreign_transaction",
        "dispute_entry",
    ] {
        assert!(items.contains(&want), "{want}");
    }
    for r in RESTRICTIONS {
        assert!(items.contains(&format!("restricted:{r}").as_str()), "{r}");
    }
    let flat = Json::Array(rows.to_vec()).compact();
    assert!(!flat.chars().any(|c| c.is_ascii_digit()), "{flat}");
}

#[test]
fn credit_card_answers_the_statements_read_with_the_typed_preview_refusal_never_an_empty_list() {
    let (status, body) = query(READ, "creditCard.statements");
    assert_eq!(status, 200);
    assert_eq!(data(&body), &refusal("bank.credit_card", "read_statements"));
}

#[test]
fn credit_card_refuses_apply_limit_rules_and_dispute_with_precondition_failed_and_the_refusal_as_cause()
 {
    let card = "bank.credit_card";
    for variant in ["credit_card", "charge_card"] {
        expect_refused(
            mutate(
                WRITE,
                "creditCard.application",
                &format!(r#"{{"variant":"{variant}"}}"#),
            ),
            card,
            "apply",
        );
    }
    expect_refused(
        mutate(WRITE, "creditCard.limit", r#"{"change":"request"}"#),
        card,
        "change_limit",
    );
    for restriction in RESTRICTIONS {
        expect_refused(
            mutate(
                WRITE,
                "creditCard.rules",
                &format!(r#"{{"restriction":"{restriction}"}}"#),
            ),
            card,
            "set_usage_rule",
        );
    }
    expect_refused(
        mutate(
            WRITE,
            "creditCard.dispute",
            r#"{"statementLine":"TEST-LINE-A"}"#,
        ),
        card,
        "open_dispute",
    );
}

#[test]
fn credit_card_refuses_each_repay_option_as_its_own_engine_action() {
    for (option, action) in [
        ("pay_in_full", "repay_in_full"),
        ("pay_early", "repay_early"),
        ("pay_extra", "repay_extra"),
        ("choose_date", "set_payment_date"),
    ] {
        expect_refused(
            mutate(
                WRITE,
                "creditCard.repay",
                &format!(r#"{{"option":"{option}"}}"#),
            ),
            "bank.credit_card",
            action,
        );
    }
}

#[test]
fn credit_card_refuses_unknown_values_and_extra_fields_at_validation() {
    for (path, input) in [
        ("creditCard.application", r#"{"variant":"debit"}"#),
        (
            "creditCard.application",
            r#"{"variant":"credit_card","limit":"5000"}"#,
        ),
        ("creditCard.repay", r#"{"option":"pay_later"}"#),
        ("creditCard.rules", r#"{"restriction":"travel"}"#),
        ("creditCard.dispute", r#"{"statementLine":""}"#),
    ] {
        assert_eq!(
            status_code(mutate(WRITE, path, input)),
            (400, "BAD_REQUEST".to_owned()),
            "{path} {input}"
        );
    }
}

#[test]
fn credit_card_refuses_a_caller_without_the_bank_scopes() {
    let forbidden = (403, "FORBIDDEN".to_owned());
    assert_eq!(status_code(query(&[], "creditCard.preview")), forbidden);
    assert_eq!(status_code(query(&[], "creditCard.statements")), forbidden);
    for (path, input) in [
        ("creditCard.application", r#"{"variant":"credit_card"}"#),
        ("creditCard.limit", r#"{"change":"request"}"#),
        ("creditCard.repay", r#"{"option":"pay_in_full"}"#),
        ("creditCard.rules", r#"{"restriction":"gambling"}"#),
        ("creditCard.dispute", r#"{"statementLine":"TEST-LINE-A"}"#),
    ] {
        assert_eq!(status_code(mutate(READ, path, input)), forbidden, "{path}");
    }
}

// ---- credit previews -----------------------------------------------------------------------------------------------

#[test]
fn credit_previews_serve_the_overdraft_personal_loan_business_term_loan_and_bureau_as_labelled_blurred_test_rows()
 {
    let (status, body) = query(READ, "creditPreviews.overview");
    assert_eq!(status, 200);
    let view = data(&body);
    assert_eq!(text(view, "label"), LABEL);
    assert_eq!(view.get("preview"), Some(&Json::Bool(true)));
    assert_eq!(view.get("blurred"), Some(&Json::Bool(true)));
    for product in ["overdraft", "personalLoan", "businessTermLoan"] {
        assert_eq!(
            view.get(product).unwrap().get("test"),
            Some(&Json::Bool(true))
        );
    }
    every_row_test(list(view.get("overdraft").unwrap(), "monthlyCost"));
    let personal = view.get("personalLoan").unwrap();
    every_row_test(list(personal, "terms"));
    every_row_test(list(view.get("businessTermLoan").unwrap(), "terms"));
    every_row_test(list(view.get("bureau").unwrap(), "rows"));
    let months: Vec<i128> = list(personal, "terms")
        .iter()
        .map(|t| int(t, "termMonths"))
        .collect();
    assert_eq!(months, [12, 24, 36, 48, 60]);
}

#[test]
fn credit_previews_work_their_sample_figures_out_from_their_sample_amount_and_rate() {
    let (_, body) = query(READ, "creditPreviews.overview");
    let view = data(&body);
    // Overdraft: limit × rate ÷ 12 months, half-up to cents (rate in hundredths of a percent).
    let overdraft = view.get("overdraft").unwrap();
    let rate = cents(text(overdraft, "rate"));
    for row in list(overdraft, "monthlyCost") {
        assert_eq!(
            cents(text(row, "cost")),
            (cents(text(row, "limit")) * rate * 2 + 120_000) / 240_000
        );
    }
    // Personal loan: the total interest is the payments less the amount.
    let personal = view.get("personalLoan").unwrap();
    for t in list(personal, "terms") {
        assert_eq!(
            cents(text(t, "totalInterest")),
            cents(text(t, "monthly")) * int(t, "termMonths") - cents(text(personal, "amount"))
        );
    }
    // Business: weekly × weeks = amount + flat fee.
    let business = view.get("businessTermLoan").unwrap();
    let amount = cents(text(business, "amount"));
    for t in list(business, "terms") {
        assert_eq!(
            cents(text(t, "fee")),
            amount * cents(text(business, "flatFee")) / 10_000
        );
        assert_eq!(
            cents(text(t, "weekly")) * int(t, "weeks"),
            amount + cents(text(t, "fee"))
        );
    }
}

#[test]
fn credit_previews_serve_a_sample_unsecured_schedule_keyed_by_a_test_loan_id() {
    let (status, body) = query(READ, "creditPreviews.schedule");
    assert_eq!(status, 200);
    let schedule = data(&body);
    assert_eq!(
        text(schedule, "sampleLoanId"),
        "00000000-0000-4000-8000-000000000012"
    );
    let rows = list(schedule, "rows");
    assert_eq!(
        i128::try_from(rows.len()).unwrap(),
        int(schedule, "termMonths")
    );
    every_row_test(rows);
}

#[test]
fn credit_previews_serve_revolving_credit_over_every_section_as_test_rows() {
    let (status, body) = query(READ, "creditPreviews.revolving");
    assert_eq!(status, 200);
    let view = data(&body);
    assert_eq!(text(view, "label"), LABEL);
    assert_eq!(text(view, "engine"), "bank.revolving_credit");
    let rows = list(view, "rows");
    every_row_test(rows);
    let mut sections: Vec<&str> = rows.iter().map(|r| text(r, "section")).collect();
    sections.dedup();
    assert_eq!(
        sections,
        [
            "credit_limit",
            "statements",
            "interest_tiers",
            "repayments",
            "bureau_reporting",
            "collections"
        ]
    );
}

#[test]
fn credit_previews_refuse_every_engine_action_with_the_typed_preview_refusal_naming_its_engine() {
    for (product, engine, actions) in [
        (
            "overdraft",
            "bank.overdraft",
            &["check_eligibility", "apply", "change_limit", "cancel"][..],
        ),
        (
            "personal_loan",
            "bank.personal_loan",
            &["check_eligibility", "apply"][..],
        ),
        (
            "business_term_loan",
            "bank.business_term_loan",
            &["check_eligibility", "apply"][..],
        ),
        ("credit_bureau", "bank.credit_bureau", &["view_file"][..]),
        (
            "revolving_credit",
            "bank.revolving_credit",
            &["apply", "borrow", "repay"][..],
        ),
    ] {
        for action in actions {
            expect_refused(
                mutate(
                    WRITE,
                    "creditPreviews.act",
                    &format!(r#"{{"product":"{product}","action":"{action}"}}"#),
                ),
                engine,
                action,
            );
        }
    }
}

#[test]
fn credit_previews_refuse_an_action_a_product_does_not_offer_and_a_session_without_bank_write() {
    assert_eq!(
        status_code(mutate(
            WRITE,
            "creditPreviews.act",
            r#"{"product":"credit_bureau","action":"apply"}"#
        )),
        (400, "BAD_REQUEST".to_owned())
    );
    assert_eq!(
        status_code(mutate(
            READ,
            "creditPreviews.act",
            r#"{"product":"overdraft","action":"apply"}"#
        )),
        (403, "FORBIDDEN".to_owned())
    );
}

// ---- fraud preview -------------------------------------------------------------------------------------------------

#[test]
fn fraud_preview_is_labelled_blurred_and_serves_test_rows_only_with_no_invented_number() {
    let (status, body) = query(TREASURY, "ops.fraudPreview");
    assert_eq!(status, 200);
    let view = data(&body);
    assert_eq!(text(view, "label"), LABEL);
    assert_eq!(view.get("preview"), Some(&Json::Bool(true)));
    assert_eq!(view.get("blurred"), Some(&Json::Bool(true)));
    assert_eq!(text(view, "automaticBlocking"), "unavailable");
    let rows = list(view, "rows");
    every_row_test(rows);
    let mut signals = Vec::new();
    for row in rows {
        assert!(text(row, "testAuthorisationRef").starts_with("TEST-"));
        signals.extend(list(row, "signals").iter().map(Json::compact));
    }
    signals.sort();
    signals.dedup();
    assert_eq!(
        signals,
        [
            "\"card_testing\"",
            "\"compromised_card\"",
            "\"merchant_dispute_risk\""
        ]
    );
    let bands_and_signals = Json::Array(
        rows.iter()
            .map(|r| {
                Json::Array(vec![
                    r.get("band").unwrap().clone(),
                    r.get("signals").unwrap().clone(),
                ])
            })
            .collect(),
    )
    .compact();
    let stances = Json::Array(list(view, "stances").to_vec()).compact();
    for words in [bands_and_signals, stances] {
        assert!(!words.chars().any(|c| c.is_ascii_digit()), "{words}");
    }
}

#[test]
fn fraud_preview_refuses_each_action_with_the_typed_preview_refusal_and_changes_nothing() {
    let (_, before) = query(TREASURY, "ops.fraudPreview");
    for action in [
        "run_check",
        "set_stance",
        "automatic_blocking",
        "model_feedback",
    ] {
        let (status, body) = mutate(
            TREASURY,
            "ops.fraudPreviewAction",
            &format!(r#"{{"action":"{action}"}}"#),
        );
        assert_eq!(status, 200);
        assert_eq!(
            data(&body),
            &Json::obj([
                ("kind", Json::str("preview")),
                ("engine", Json::str("ML fraud risk score")),
                ("action", Json::str(action)),
                ("changed", Json::Bool(false)),
            ])
        );
    }
    assert_eq!(query(TREASURY, "ops.fraudPreview").1, before);
}

#[test]
fn fraud_preview_refuses_an_action_it_does_not_know_at_validation() {
    assert_eq!(
        status_code(mutate(
            TREASURY,
            "ops.fraudPreviewAction",
            r#"{"action":"approve"}"#
        )),
        (400, "BAD_REQUEST".to_owned())
    );
}

#[test]
fn fraud_preview_refuses_a_caller_without_the_treasury_scope_for_both_the_read_and_the_action() {
    let forbidden = (403, "FORBIDDEN".to_owned());
    assert_eq!(status_code(query(WRITE, "ops.fraudPreview")), forbidden);
    assert_eq!(
        status_code(mutate(
            WRITE,
            "ops.fraudPreviewAction",
            r#"{"action":"run_check"}"#
        )),
        forbidden
    );
}
