//! The assessment slice's pure parts, held to the TypeScript's own tests: `curriculum/bulk-grade-file.test.ts`,
//! `curriculum/late-policy.test.ts`, `curriculum/course-gradebook-math.test.ts` and `curriculum/course-quiz-score.test.ts`,
//! assertion for assertion.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::money::format_amount;
use svc_academy::assessment::csv::{GradeRow, read_grade_file};
use svc_academy::assessment::gradebook::{
    fraction_of, late_score, policy_of, type_average, weight_sum, weighted_total,
};
use svc_academy::assessment::score::{answer_fits, scaled_decimal, score_attempt, score_question};
use svc_academy::errors::Refusal;

fn j(text: &str) -> Json {
    json::parse(text).unwrap()
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        other => panic!("{other:?}"),
    }
}

// ── bulk-grade-file.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

const H: &str = "learner,score,comment,reason";

fn row(line: usize, alias: u32, score: &str, comment: Option<&str>) -> GradeRow {
    GradeRow {
        line,
        alias,
        score: score.to_owned(),
        comment: comment.map(str::to_owned),
        reason: None,
    }
}

#[test]
fn the_grade_file_reads_quoted_fields_crlf_lf_and_a_byte_order_mark() {
    let text = format!(
        "\u{feff}{H}\r\nLearner 1,7.5,\"Good, \"\"clear\"\" work\",\r\n3, 10, \"Two\nlines\",\r\n"
    );
    let (rows, bad) = read_grade_file(&text).unwrap();
    assert_eq!(
        rows,
        vec![
            row(2, 1, "7.5", Some("Good, \"clear\" work")),
            row(3, 3, "10", Some("Two\nlines"))
        ]
    );
    assert!(bad.is_empty());
}

#[test]
fn the_grade_file_lists_each_bad_row_by_line_and_keeps_the_good_ones() {
    let text = [
        H,
        "Learner 0,5,,",
        "Learner 2,5.123,,",
        "Learner 2,abc,,",
        "Learner 2,6,,",
        "Learner 2,7,,",
        "4,5",
        "",
    ]
    .join("\n");
    let (rows, bad) = read_grade_file(&text).unwrap();
    assert_eq!(rows, vec![row(5, 2, "6", None)]);
    let got: Vec<(usize, Option<u32>, &str)> = bad
        .iter()
        .map(|b| (b.line, b.alias, b.code.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            (2, None, "academy.bulk_row_invalid"),
            (3, Some(2), "academy.grade_invalid"),
            (4, Some(2), "academy.grade_invalid"),
            (6, Some(2), "academy.bulk_row_invalid"),
            (7, Some(4), "academy.bulk_row_invalid"),
        ]
    );
}

#[test]
fn the_grade_file_refuses_another_header_no_rows_or_an_open_quote() {
    for text in [
        String::new(),
        "learner,score\n1,5".to_owned(),
        format!("{H}\n"),
        format!("{H}\n1,\"5,,"),
    ] {
        assert_eq!(
            code(read_grade_file(&text)),
            "academy.bulk_file_invalid",
            "{text:?}"
        );
    }
}

// ── late-policy.test.ts ─────────────────────────────────────────────────────────────────────────────────────────────

const DUE: i64 = 1_793_620_800_000; // 2026-11-02T12:00:00.000Z
const HOUR: i64 = 3_600_000;

fn at(hours_after_due: i64) -> i64 {
    DUE + hours_after_due * HOUR
}

fn policy(grace: &str, deduction: &str) -> (String, String) {
    (grace.to_owned(), deduction.to_owned())
}

fn late(
    entered: &str,
    points: &str,
    submitted: i64,
    due: Option<i64>,
    p: Option<&(String, String)>,
) -> (String, Option<String>) {
    late_score(entered, points, submitted, due, p)
}

fn kept(score: &str, entered: Option<&str>) -> (String, Option<String>) {
    (score.to_owned(), entered.map(str::to_owned))
}

#[test]
fn the_due_instant_is_the_one_the_typescript_names() {
    assert_eq!(
        service_kit::time::js_date("2026-11-02T12:00:00.000Z")
            .unwrap()
            .0,
        DUE
    );
}

#[test]
fn late_policy_takes_nothing_with_no_policy_no_due_date_on_time_or_inside_the_grace() {
    let p = policy("2", "0.1");
    assert_eq!(late("8", "10", at(30), Some(DUE), None), kept("8", None));
    assert_eq!(late("8", "10", at(30), None, Some(&p)), kept("8", None));
    assert_eq!(
        late("8", "10", at(-1), Some(DUE), Some(&p)),
        kept("8", None)
    );
    assert_eq!(late("8", "10", at(2), Some(DUE), Some(&p)), kept("8", None));
}

#[test]
fn late_policy_takes_the_deduction_per_started_day_and_keeps_the_entered_grade() {
    let p = policy("2", "0.1");
    assert_eq!(
        late("8", "10", at(2) + 60_000, Some(DUE), Some(&p)),
        kept("7", Some("8"))
    );
    assert_eq!(
        late("8", "10", at(27), Some(DUE), Some(&p)),
        kept("6", Some("8"))
    );
}

#[test]
fn late_policy_never_goes_below_zero_nor_takes_more_than_all_the_points() {
    let p = policy("2", "0.1");
    assert_eq!(
        late("3", "10", at(24 * 30), Some(DUE), Some(&p)),
        kept("0", Some("3"))
    );
    assert_eq!(
        late("10", "10", at(24 * 30), Some(DUE), Some(&policy("0", "1"))),
        kept("0", Some("10"))
    );
}

#[test]
fn late_policy_rounds_the_deduction_up_to_the_hundredth() {
    assert_eq!(
        late("7.5", "7.5", at(1), Some(DUE), Some(&policy("0", "0.0333"))),
        kept("7.25", Some("7.5"))
    );
    assert_eq!(
        late("0", "10", at(5), Some(DUE), Some(&policy("2", "0.1"))),
        kept("0", None)
    );
}

#[test]
fn late_policy_reads_stored_numerics_back_as_the_contract_strings() {
    assert_eq!(
        policy_of(Some("24.00"), Some("0.1000")),
        Some(policy("24", "0.1"))
    );
    assert_eq!(
        policy_of(Some("1.50"), Some("1.0000")),
        Some(policy("1.5", "1"))
    );
    assert_eq!(policy_of(None, None), None);
}

// ── course-gradebook-math.test.ts ───────────────────────────────────────────────────────────────────────────────────

const ONE: i128 = 1_000_000_000_000_000_000;

fn f(score: &str, points: &str) -> i128 {
    fraction_of(score, points).unwrap()
}

#[test]
fn weights_add_exactly() {
    assert_ne!(weight_sum(["0.4", "0.4", "0.3"].into_iter()), ONE);
    assert_eq!(weight_sum(["0.4", "0.4", "0.2"].into_iter()), ONE);
    assert_eq!(weight_sum(["0.1", "0.2", "0.7"].into_iter()), ONE);
}

#[test]
fn the_lowest_is_dropped_before_averaging_never_the_last_score() {
    let scores = vec![
        ("a".to_owned(), f("10", "10")),
        ("b".to_owned(), f("5", "10")),
        ("c".to_owned(), f("8", "10")),
    ];
    let (average, counted, dropped) = type_average(&scores, 1);
    assert_eq!(format_amount(average.unwrap()), "0.9");
    assert_eq!(
        (counted, dropped),
        (vec!["a".to_owned(), "c".to_owned()], vec!["b".to_owned()])
    );
    let (_, counted, dropped) = type_average(&[("a".to_owned(), f("3", "10"))], 2);
    assert_eq!(
        (counted, dropped),
        (vec!["a".to_owned()], Vec::<String>::new())
    );
    assert_eq!(type_average(&[], 1).0, None);
}

#[test]
fn types_with_an_average_are_weighted_and_thirds_are_cut() {
    let w = |s: &str| s.to_owned();
    assert_eq!(
        format_amount(
            weighted_total(&[
                (w("0.6"), Some(f("9", "10"))),
                (w("0.4"), Some(f("1", "1")))
            ])
            .unwrap()
        ),
        "0.94"
    );
    assert_eq!(
        format_amount(weighted_total(&[(w("0.6"), Some(f("9", "10"))), (w("0.4"), None)]).unwrap()),
        "0.9"
    );
    assert_eq!(weighted_total(&[(w("1"), None)]), None);
    assert_eq!(format_amount(f("1", "3")), "0.333333333333333333");
}

// ── course-quiz-score.test.ts ───────────────────────────────────────────────────────────────────────────────────────

const CHOICES: &str =
    r#"[{"id":"a","text":"A"},{"id":"b","text":"B"},{"id":"c","text":"C"},{"id":"d","text":"D"}]"#;

fn multi(partial: bool) -> Json {
    j(&format!(
        r#"{{"kind":"multi","id":"m","prompt":"TEST pick two","points":4,"choices":{CHOICES},"correctChoiceIds":["a","b"],"partialCredit":{partial}}}"#
    ))
}

fn numeric() -> Json {
    j(
        r#"{"kind":"numeric","id":"n","prompt":"TEST 1/3","points":3,"answer":"0.333","tolerance":"0.001"}"#,
    )
}

fn essay() -> Json {
    j(r#"{"kind":"essay","id":"e","prompt":"TEST explain","points":5}"#)
}

#[test]
fn decimals_are_read_exactly_and_what_is_not_one_is_refused() {
    assert_eq!(
        scaled_decimal("0.1").unwrap() + scaled_decimal("0.2").unwrap(),
        scaled_decimal("0.3").unwrap()
    );
    assert_eq!(scaled_decimal("-1.5"), Some(-1_500_000_000_000_000_000));
    for bad in ["1e3", "01", ".5", "1.", "NaN", ""] {
        assert_eq!(scaled_decimal(bad), None, "{bad}");
    }
}

#[test]
fn multi_select_scores_all_or_nothing_or_a_share_per_correct_choice() {
    let s = |q: &Json, a: &str| score_question(q, Some(&j(a)));
    assert_eq!(s(&multi(false), r#"["a","b"]"#), Some(4));
    assert_eq!(s(&multi(false), r#"["a"]"#), Some(0));
    assert_eq!(s(&multi(true), r#"["a"]"#), Some(2));
    assert_eq!(s(&multi(true), r#"["b","a"]"#), Some(4));
    assert_eq!(s(&multi(true), r#"["a","c"]"#), Some(0));
    assert_eq!(s(&multi(true), "[]"), Some(0));
    assert_eq!(s(&multi(true), r#"["a","a"]"#), Some(0));
}

#[test]
fn numeric_scores_inside_the_tolerance_inclusive() {
    let s = |a: &str| score_question(&numeric(), Some(&Json::str(a)));
    assert_eq!(s("0.333"), Some(3));
    assert_eq!(s("0.334"), Some(3));
    assert_eq!(s("0.332"), Some(3));
    assert_eq!(s("0.3341"), Some(0));
    assert_eq!(s("1/3"), Some(0));
    assert!(!answer_fits(&numeric(), &Json::str("1e-1")));
}

#[test]
fn an_essay_has_no_automatic_score_and_its_attempt_waits_for_staff() {
    assert_eq!(
        score_question(&essay(), Some(&Json::str("TEST text"))),
        None
    );
    assert_eq!(
        score_attempt(
            &[multi(true), numeric(), essay()],
            &j(r#"{"m":["a"],"n":"0.333","e":"TEST"}"#)
        ),
        (5, 12, true)
    );
    assert_eq!(score_attempt(&[numeric()], &j("{}")), (0, 3, false));
}

#[test]
fn an_answer_fits_only_its_own_question_kind() {
    assert!(!answer_fits(&multi(false), &Json::str("a")));
    assert!(!answer_fits(&multi(false), &j(r#"["z"]"#)));
    let single = j(&format!(
        r#"{{"kind":"single","id":"s","prompt":"p","points":1,"choices":{CHOICES},"correctChoiceId":"a"}}"#
    ));
    assert!(!answer_fits(&single, &j(r#"["a"]"#)));
    assert!(!answer_fits(&essay(), &j(r#"["a"]"#)));
}
