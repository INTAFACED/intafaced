//! Slice `credit-previews` (`PORT.md`): `creditCard.*`, `creditPreviews.*`, `ops.fraudPreview` and
//! `ops.fraudPreviewAction`, as `services/svc-bank/src/loans/credit-card-preview.router.ts`, `credit-card-preview.ts`,
//! `credit-previews.ts` and `src/cards/fraud-preview.ts` serve them.
//!
//! None of these engines exists. Every read is a fixed TEST fixture, labelled "Preview · sample data", and every
//! engine action answers with the typed Preview refusal (`preview.engine_not_built`), decided before anything is
//! read: the slice holds no store, no ledger and no other service, so it can touch none. The figures are sample
//! numbers, not our values and not an offer; amounts are decimal strings and never a number.

use service_kit::json::Json;
use service_kit::trpc::{PREVIEW_LABEL, Preview, TrpcError};

use crate::door::Ctx;

/// The answer of one of the slice's calls, by its path. `None` is a path outside the slice.
pub fn answer(ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let input = &ctx.input;
    let field = |key: &str| input.get(key).as_str().unwrap_or_default().to_owned();
    let card = |action: &str| Err(Preview::new(CREDIT_CARD_ENGINE, action).refuse());
    Some(match ctx.call.path {
        "creditCard.preview" => Ok(Some(credit_card_preview())),
        // The statements read answers with the refusal itself, never an empty list.
        "creditCard.statements" => Ok(Some(
            Preview::new(CREDIT_CARD_ENGINE, "read_statements").to_json(),
        )),
        "creditCard.application" => card("apply"),
        "creditCard.limit" => card("change_limit"),
        "creditCard.repay" => match repay_action(&field("option")) {
            Some(action) => card(action),
            None => Err(unreachable_input(ctx.call.path)),
        },
        "creditCard.rules" => card("set_usage_rule"),
        "creditCard.dispute" => card("open_dispute"),
        "creditPreviews.overview" => Ok(Some(overview())),
        "creditPreviews.schedule" => Ok(Some(schedule())),
        "creditPreviews.revolving" => Ok(Some(revolving())),
        "creditPreviews.act" => match engine_of(&field("product")) {
            Some(engine) => Err(Preview::new(engine, field("action")).refuse()),
            None => Err(unreachable_input(ctx.call.path)),
        },
        "ops.fraudPreview" => Ok(Some(fraud_preview())),
        // Every engine action on the fraud preview answers the refusal and changes nothing.
        "ops.fraudPreviewAction" => Ok(Some(Json::obj([
            ("kind", Json::str("preview")),
            ("engine", Json::str(FRAUD_PREVIEW_ENGINE)),
            ("action", Json::str(field("action"))),
            ("changed", Json::Bool(false)),
        ]))),
        _ => return None,
    })
}

/// The input passed the call's schema, so its enum holds one of the values matched; anything else is a broken port.
fn unreachable_input(path: &str) -> TrpcError {
    TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        format!("svc-bank in Rust: {path} met an input its schema refuses"),
    )
}

const T: Json = Json::Bool(true);

fn s(v: &str) -> Json {
    Json::str(v)
}

fn strs(items: &[&str]) -> Json {
    Json::Array(items.iter().map(|v| s(v)).collect())
}

// ---- creditCard.* (BK-loan-10) -------------------------------------------------------------------------------------

/// `CREDIT_CARD_PREVIEW_ENGINE`.
pub const CREDIT_CARD_ENGINE: &str = "bank.credit_card";
/// `CREDIT_CARD_TABS`.
pub const CREDIT_CARD_TABS: [&str; 5] = [
    "application",
    "limit",
    "repayment",
    "usage_rules",
    "statements",
];
/// `CREDIT_CARD_REPAYMENT_OPTIONS`, each with the engine action it refuses.
pub const CREDIT_CARD_REPAYMENTS: [(&str, &str); 4] = [
    ("pay_in_full", "repay_in_full"),
    ("pay_early", "repay_early"),
    ("pay_extra", "repay_extra"),
    ("choose_date", "set_payment_date"),
];
/// `CREDIT_CARD_RESTRICTIONS`.
pub const CREDIT_CARD_RESTRICTIONS: [&str; 5] = [
    "cash_withdrawal",
    "gambling",
    "crypto",
    "balance_transfer",
    "money_transfer",
];

fn repay_action(option: &str) -> Option<&'static str> {
    CREDIT_CARD_REPAYMENTS
        .iter()
        .find(|(o, _)| *o == option)
        .map(|(_, a)| *a)
}

/// `creditCardPreview()`: TEST rows only, and no number at all.
fn credit_card_preview() -> Json {
    let mut rows = Vec::new();
    let mut tab = |tab: &str, items: Vec<String>| {
        for item in items {
            rows.push(Json::obj([
                ("tab", s(tab)),
                ("item", Json::str(item)),
                ("test", T),
            ]));
        }
    };
    let own = |items: &[&str]| items.iter().map(|v| (*v).to_owned()).collect::<Vec<_>>();
    tab(
        "application",
        own(&[
            "soft_eligibility_check",
            "personalised_rate",
            "representative_apr",
            "credit_card",
            "charge_card",
        ]),
    );
    tab("limit", own(&["credit_limit", "change_limit"]));
    let mut repayment: Vec<String> = CREDIT_CARD_REPAYMENTS
        .iter()
        .map(|(o, _)| (*o).to_owned())
        .collect();
    repayment.extend(["daily", "thirty_day"].map(|v| format!("variant:{v}")));
    tab("repayment", repayment);
    let mut usage = vec!["fee:foreign_transaction".to_owned()];
    usage.extend(CREDIT_CARD_RESTRICTIONS.map(|r| format!("restricted:{r}")));
    tab("usage_rules", usage);
    tab(
        "statements",
        own(&["statement", "dispute_entry", "zero_liability_notice"]),
    );
    Json::obj([
        ("label", s(PREVIEW_LABEL)),
        ("engine", s(CREDIT_CARD_ENGINE)),
        ("preview", T),
        ("blurred", T),
        ("tabs", strs(&CREDIT_CARD_TABS)),
        ("rows", Json::Array(rows)),
    ])
}

// ---- creditPreviews.* (J-bank-12) ----------------------------------------------------------------------------------

/// `CREDIT_PREVIEW_ENGINES`: each product's missing engine.
pub const CREDIT_PREVIEW_ENGINES: [(&str, &str); 5] = [
    ("overdraft", "bank.overdraft"),
    ("personal_loan", "bank.personal_loan"),
    ("business_term_loan", "bank.business_term_loan"),
    ("credit_bureau", "bank.credit_bureau"),
    ("revolving_credit", "bank.revolving_credit"),
];

fn engine_of(product: &str) -> Option<&'static str> {
    CREDIT_PREVIEW_ENGINES
        .iter()
        .find(|(p, _)| *p == product)
        .map(|(_, e)| *e)
}

/// `label`, `preview`, `blurred`, `currency`: every credit preview's shell.
fn shell<const N: usize>(rest: [(&str, Json); N]) -> Json {
    let mut fields = vec![
        ("label".to_owned(), s(PREVIEW_LABEL)),
        ("preview".to_owned(), T),
        ("blurred".to_owned(), T),
        ("currency".to_owned(), s("EUR")),
    ];
    fields.extend(rest.into_iter().map(|(k, v)| (k.to_owned(), v)));
    Json::Object(fields)
}

/// The overdraft, the personal loan, the business term loan and bureau reporting (BK-loan-08). The monthly payments
/// are the annuity payment on the sample amount at the sample rate, half-up to cents, worked out once.
fn overview() -> Json {
    let monthly_cost = [("250.00", "2.29"), ("500.00", "4.58"), ("1000.00", "9.17")]
        .map(|(limit, cost)| Json::obj([("limit", s(limit)), ("cost", s(cost)), ("test", T)]));
    let personal = [
        (12, "432.40", "188.80"),
        (24, "223.64", "367.36"),
        (36, "154.16", "549.76"),
        (48, "119.50", "736.00"),
        (60, "98.77", "926.20"),
    ]
    .map(|(months, monthly, interest)| {
        Json::obj([
            ("termMonths", Json::int(months)),
            ("monthly", s(monthly)),
            ("totalInterest", s(interest)),
            ("test", T),
        ])
    });
    let business = [(26, "2000.00"), (52, "1000.00")].map(|(weeks, weekly)| {
        Json::obj([
            ("weeks", Json::int(weeks)),
            ("weekly", s(weekly)),
            ("fee", s("2000.00")),
            ("test", T),
        ])
    });
    let bureau = ["account_history", "repayment_history", "how_it_appears"]
        .map(|item| Json::obj([("item", s(item)), ("test", T)]));
    shell([
        (
            "overdraft",
            Json::obj([
                ("engine", s("bank.overdraft")),
                ("limits", strs(&["250.00", "500.00", "1000.00"])),
                ("rate", s("11.00")),
                ("monthlyCost", Json::Array(monthly_cost.to_vec())),
                ("repaymentWindowMonths", Json::int(2)),
                ("test", T),
            ]),
        ),
        (
            "personalLoan",
            Json::obj([
                ("engine", s("bank.personal_loan")),
                ("amount", s("5000.00")),
                ("rate", s("6.90")),
                ("terms", Json::Array(personal.to_vec())),
                ("test", T),
            ]),
        ),
        (
            "businessTermLoan",
            Json::obj([
                ("engine", s("bank.business_term_loan")),
                ("amount", s("50000.00")),
                ("flatFee", s("4.00")),
                ("terms", Json::Array(business.to_vec())),
                ("test", T),
            ]),
        ),
        (
            "bureau",
            Json::obj([
                ("engine", s("bank.credit_bureau")),
                ("rows", Json::Array(bureau.to_vec())),
            ]),
        ),
    ])
}

/// `SAMPLE_UNSECURED_LOAN_ID`: a TEST loan id the servicing doors refuse without a lookup.
pub const SAMPLE_UNSECURED_LOAN_ID: &str = "00000000-0000-4000-8000-000000000012";

/// A sample unsecured-loan schedule for the servicing preview (BK-loan-09).
fn schedule() -> Json {
    let rows = (1..=12)
        .map(|n| Json::obj([("n", Json::int(n)), ("amount", s("432.40")), ("test", T)]))
        .collect();
    shell([
        ("sampleLoanId", s(SAMPLE_UNSECURED_LOAN_ID)),
        ("amount", s("5000.00")),
        ("rate", s("6.90")),
        ("termMonths", Json::int(12)),
        ("rows", Json::Array(rows)),
    ])
}

/// Revolving card credit (BK-cops-09, the customer half).
fn revolving() -> Json {
    let rows = [
        ("credit_limit", "limit", Some("2000.00")),
        ("credit_limit", "available", Some("1650.00")),
        ("statements", "statement_balance", Some("350.00")),
        ("statements", "minimum_due", Some("25.00")),
        ("interest_tiers", "purchases_rate", Some("19.90")),
        ("interest_tiers", "cash_rate", Some("24.90")),
        ("repayments", "pay_in_full", Some("350.00")),
        ("repayments", "pay_minimum", Some("25.00")),
        ("bureau_reporting", "monthly_report", None),
        ("collections", "missed_payment_steps", None),
    ]
    .map(|(section, item, figure)| {
        Json::obj([
            ("section", s(section)),
            ("item", s(item)),
            ("figure", figure.map_or(Json::Null, s)),
            ("test", T),
        ])
    });
    shell([
        ("engine", s("bank.revolving_credit")),
        ("rows", Json::Array(rows.to_vec())),
    ])
}

// ---- ops.fraudPreview* (BK-cops-09, the fraud half) ----------------------------------------------------------------

/// `FRAUD_PREVIEW_ENGINE`: the fraud preview names its engine in words, not as an engine id.
pub const FRAUD_PREVIEW_ENGINE: &str = "ML fraud risk score";

/// TEST rows only, one per band, covering every signal; a score is a named band and a stance is named, never a
/// number. It never changes an authorisation, posts nothing and sets no freeze.
fn fraud_preview() -> Json {
    let rows = [
        (
            "TEST-AUTH-1",
            "very_likely",
            &["card_testing", "compromised_card"][..],
        ),
        ("TEST-AUTH-2", "neutral", &["merchant_dispute_risk"][..]),
        ("TEST-AUTH-3", "very_unlikely", &[][..]),
    ]
    .map(|(reference, band, signals)| {
        Json::obj([
            ("testAuthorisationRef", s(reference)),
            ("test", T),
            ("band", s(band)),
            ("signals", strs(signals)),
        ])
    });
    Json::obj([
        ("label", s(PREVIEW_LABEL)),
        ("engine", s(FRAUD_PREVIEW_ENGINE)),
        ("preview", T),
        ("blurred", T),
        (
            "stances",
            strs(&[
                "maximise_approval_rate",
                "balanced",
                "maximise_risk_prevention",
            ]),
        ),
        ("automaticBlocking", s("unavailable")),
        ("rows", Json::Array(rows.to_vec())),
    ])
}
