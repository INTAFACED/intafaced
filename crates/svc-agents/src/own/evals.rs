//! Evaluations of a person's own agent (`own/evaluations.ts`): the test set, every case run `repeats` times on the test
//! engine (no model, never billed, no ledger call), each result labelled TEST, and the verdict against the person's
//! threshold. A blank threshold or repeats count refuses by name and nothing runs or is stored. One run per
//! `agents:eval:<agent>:<request id>`. Nothing here is a balance and no value moves.

use postgres::{IsolationLevel, Transaction};

use service_kit::json::{self, Json};
use service_kit::money::js_trim;
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::guards::{js_len, test_engine_reply};
use super::{OwnError, OwnRefusal};
use crate::db::{self, StoreError};
use crate::runtime::ms;

/// `OWN_AGENT_EVAL_LIMITS`.
pub const EVAL_CASES_MAX: usize = 20;
pub const EVAL_REPEATS_MAX: i64 = 10;
pub const EVAL_TEXT_MAX: usize = 2000;

/// One transaction at READ COMMITTED (`sql.begin`): a refusal decided inside it is answered after it ends, with nothing
/// written before it.
pub fn in_transaction<T>(
    pool: &Pool,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<Result<T, OwnError>, StoreError>,
) -> Result<T, OwnError> {
    db::transaction(pool, IsolationLevel::ReadCommitted, f)?
}

/// A JSON column read as text.
pub fn jsonb(r: &postgres::Row, i: usize) -> Result<Option<Json>, OwnError> {
    let text: Option<String> = r.try_get(i)?;
    text.map(|t| json::parse(&t).map_err(|e| OwnError::Thrown(e.message)))
        .transpose()
}

/// `OwnAgentEvalCase`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalCase {
    pub input: String,
    pub expected: String,
}

/// `EvalRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalRequest {
    pub cases: Vec<EvalCase>,
    pub repeats: i64,
    pub threshold_hundredths: i64,
    pub threshold: String,
}

fn digits_only(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `THRESHOLD_RE`: `^([0-9]{1,3})(?:\.([0-9]{1,2}))?$`, as hundredths.
fn threshold_hundredths(text: &str) -> Option<i64> {
    let (whole, fraction) = match text.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (text, None),
    };
    if !digits_only(whole) || whole.len() > 3 {
        return None;
    }
    let part = match fraction {
        None => 0,
        Some(f) if digits_only(f) && f.len() <= 2 => {
            let n: i64 = f.parse().ok()?;
            if f.len() == 1 { n * 10 } else { n }
        }
        Some(_) => return None,
    };
    Some(whole.parse::<i64>().ok()? * 100 + part)
}

/// `checkEvalRequest`: the first thing it cannot run refuses, with its name.
pub fn check_eval_request(
    cases: &[Value],
    repeats: &str,
    threshold: &str,
) -> Result<EvalRequest, OwnRefusal> {
    if cases.is_empty() {
        return Err(OwnRefusal::new("agents.eval.cases_empty"));
    }
    if cases.len() > EVAL_CASES_MAX {
        return Err(OwnRefusal::with(
            "agents.eval.too_many_cases",
            [("limit", EVAL_CASES_MAX.to_string())],
        ));
    }
    let cases: Vec<EvalCase> = cases
        .iter()
        .map(|c| EvalCase {
            input: c.get("input").as_str().unwrap_or("").to_owned(),
            expected: c.get("expected").as_str().unwrap_or("").to_owned(),
        })
        .collect();
    for c in &cases {
        if c.input.contains('\0') || c.expected.contains('\0') {
            return Err(OwnRefusal::new("agents.own.text_invalid"));
        }
        if js_trim(&c.input).is_empty() || js_trim(&c.expected).is_empty() {
            return Err(OwnRefusal::new("agents.eval.case_blank"));
        }
        if js_len(&c.input) > EVAL_TEXT_MAX || js_len(&c.expected) > EVAL_TEXT_MAX {
            return Err(OwnRefusal::with(
                "agents.eval.case_too_long",
                [("limit", EVAL_TEXT_MAX.to_string())],
            ));
        }
    }
    let repeats_text = js_trim(repeats);
    if repeats_text.is_empty() {
        return Err(OwnRefusal::new("agents.eval.repeats_unset"));
    }
    let repeats = if digits_only(repeats_text) && repeats_text.len() <= 3 {
        repeats_text.parse::<i64>().ok()
    } else {
        None
    };
    let Some(repeats) = repeats.filter(|r| (1..=EVAL_REPEATS_MAX).contains(r)) else {
        return Err(OwnRefusal::with(
            "agents.eval.repeats_invalid",
            [("limit", EVAL_REPEATS_MAX.to_string())],
        ));
    };
    let trimmed = js_trim(threshold);
    let threshold_text = js_trim(trimmed.strip_suffix('%').unwrap_or(trimmed));
    if threshold_text.is_empty() {
        return Err(OwnRefusal::new("agents.eval.threshold_unset"));
    }
    let Some(hundredths) =
        threshold_hundredths(threshold_text).filter(|h| (0..=10_000).contains(h))
    else {
        return Err(OwnRefusal::new("agents.eval.threshold_invalid"));
    };
    Ok(EvalRequest {
        cases,
        repeats,
        threshold_hundredths: hundredths,
        threshold: percent(hundredths),
    })
}

/// Hundredths of a percent as a decimal string with no trailing zeros: 5000 is "50", 6666 is "66.66".
pub fn percent(hundredths: i64) -> String {
    let whole = hundredths / 100;
    let part = format!("{:02}", hundredths % 100);
    let part = part.trim_end_matches('0');
    if part.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{part}")
    }
}

/// `OwnAgentEvalResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalResult {
    pub case_index: i64,
    pub repeat: i64,
    pub input: String,
    pub expected: String,
    pub reply: String,
    pub passed: bool,
}

impl EvalResult {
    fn to_json(&self) -> Json {
        Json::obj([
            ("caseIndex", Json::int(self.case_index)),
            ("repeat", Json::int(self.repeat)),
            ("input", Json::str(self.input.clone())),
            ("expected", Json::str(self.expected.clone())),
            ("reply", Json::str(self.reply.clone())),
            ("passed", Json::Bool(self.passed)),
            ("label", Json::str("TEST")),
        ])
    }
}

/// `evaluate`'s outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub results: Vec<EvalResult>,
    pub passed: i64,
    pub total: i64,
    pub score: String,
    pub verdict: &'static str,
}

/// `evaluate`: every case on every repeat, through the test engine, judged by `replyPasses`.
pub fn evaluate(request: &EvalRequest) -> Outcome {
    let mut results = Vec::new();
    for (case_index, c) in (0_i64..).zip(&request.cases) {
        for repeat in 1..=request.repeats {
            let reply = test_engine_reply(&c.input);
            results.push(EvalResult {
                case_index,
                repeat,
                input: c.input.clone(),
                expected: c.expected.clone(),
                passed: reply.contains(&c.expected),
                reply,
            });
        }
    }
    let total = i64::try_from(results.len()).unwrap_or(i64::MAX);
    let passed = i64::try_from(results.iter().filter(|r| r.passed).count()).unwrap_or(0);
    let verdict = if passed * 10_000 >= request.threshold_hundredths * total {
        "pass"
    } else {
        "fail"
    };
    Outcome {
        score: percent(passed * 10_000 / total.max(1)),
        results,
        passed,
        total,
        verdict,
    }
}

fn case_json(c: &EvalCase) -> Json {
    Json::obj([
        ("input", Json::str(c.input.clone())),
        ("expected", Json::str(c.expected.clone())),
    ])
}

fn text_of(j: &Json, key: &str) -> String {
    match j.get(key) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// A stored case, read back in the schema's order.
fn stored_case(j: &Json) -> EvalCase {
    EvalCase {
        input: text_of(j, "input"),
        expected: text_of(j, "expected"),
    }
}

/// A stored result, in `ownAgentEvalResultSchema`'s order.
fn stored_result(j: &Json) -> Json {
    let pick = |k: &str| j.get(k).cloned().unwrap_or(Json::Null);
    Json::obj([
        ("caseIndex", pick("caseIndex")),
        ("repeat", pick("repeat")),
        ("input", pick("input")),
        ("expected", pick("expected")),
        ("reply", pick("reply")),
        ("passed", pick("passed")),
        ("label", pick("label")),
    ])
}

/// `RunRow`.
struct RunRow {
    id: String,
    request_id: String,
    cases: Vec<EvalCase>,
    repeats: i64,
    threshold: String,
    passed: i64,
    total: i64,
    score: String,
    verdict: String,
    results: Vec<Json>,
    created_at: Instant,
}

fn run_columns() -> String {
    format!(
        "id::text, request_id, cases_json::text, repeats, threshold, passed, total, score, verdict, results_json::text, {}",
        ms("created_at")
    )
}

fn array(j: Option<Json>) -> Vec<Json> {
    match j {
        Some(Json::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn run_of(r: &postgres::Row) -> Result<RunRow, OwnError> {
    Ok(RunRow {
        id: r.try_get(0)?,
        request_id: r.try_get(1)?,
        cases: array(jsonb(r, 2)?).iter().map(stored_case).collect(),
        repeats: i64::from(r.try_get::<_, i32>(3)?),
        threshold: r.try_get(4)?,
        passed: i64::from(r.try_get::<_, i32>(5)?),
        total: i64::from(r.try_get::<_, i32>(6)?),
        score: r.try_get(7)?,
        verdict: r.try_get(8)?,
        results: array(jsonb(r, 9)?),
        created_at: Instant(r.try_get(10)?),
    })
}

impl RunRow {
    /// `runView`, in `ownAgentEvalRunSchema`'s order.
    fn view(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("requestId", Json::str(self.request_id.clone())),
            (
                "cases",
                Json::Array(self.cases.iter().map(case_json).collect()),
            ),
            ("repeats", Json::int(self.repeats)),
            ("threshold", Json::str(self.threshold.clone())),
            ("passed", Json::int(self.passed)),
            ("total", Json::int(self.total)),
            ("score", Json::str(self.score.clone())),
            ("verdict", Json::str(self.verdict.clone())),
            ("label", Json::str("TEST")),
            (
                "results",
                Json::Array(self.results.iter().map(stored_result).collect()),
            ),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }

    /// `sameRequest`.
    fn same(&self, request: &EvalRequest) -> bool {
        self.repeats == request.repeats
            && self.threshold == request.threshold
            && self.cases == request.cases
    }
}

/// `replayed`: the stored run is this request's, or the key was reused for another.
fn replayed(row: &RunRow, request: &EvalRequest) -> Result<Json, OwnError> {
    if row.same(request) {
        Ok(row.view())
    } else {
        Err(OwnRefusal::new("agents.request_id_replay").into())
    }
}

/// `testSet`: the agent's cases in the order the person wrote them.
pub fn test_set(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT input, expected FROM agents.own_agent_eval_cases
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid
              ORDER BY position",
            &[&owner_id, &agent_id],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            Ok(case_json(&EvalCase {
                input: r.try_get(0)?,
                expected: r.try_get(1)?,
            }))
        })
        .collect::<Result<Vec<_>, OwnError>>()
        .map(Json::Array)
}

/// `runs`: newest first, as summaries.
pub fn runs(pool: &Pool, owner_id: &str, agent_id: &str, limit: i64) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT id::text, request_id, jsonb_array_length(cases_json)::int, repeats, threshold, passed, total, score,
                        verdict, {}
                   FROM agents.own_agent_eval_runs
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY created_at DESC, id
                  LIMIT $3::bigint",
                ms("created_at")
            ),
            &[&owner_id, &agent_id, &limit],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            let int = |i: usize| -> Result<Json, OwnError> {
                Ok(Json::int(i64::from(r.try_get::<_, i32>(i)?)))
            };
            let text =
                |i: usize| -> Result<Json, OwnError> { Ok(Json::str(r.try_get::<_, String>(i)?)) };
            Ok(Json::obj([
                ("id", text(0)?),
                ("requestId", text(1)?),
                ("repeats", int(3)?),
                ("threshold", text(4)?),
                ("passed", int(5)?),
                ("total", int(6)?),
                ("score", text(7)?),
                ("verdict", text(8)?),
                ("label", Json::str("TEST")),
                ("createdAt", Json::str(Instant(r.try_get(9)?).iso())),
                ("cases", int(2)?),
            ]))
        })
        .collect::<Result<Vec<_>, OwnError>>()
        .map(Json::Array)
}

/// `latest`: the newest run in full, or null before the first.
pub fn latest(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Json, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_eval_runs WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY created_at DESC, id LIMIT 1",
                run_columns()
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    match rows.first() {
        Some(r) => Ok(run_of(r)?.view()),
        None => Ok(Json::Null),
    }
}

fn find(
    c: &mut impl postgres::GenericClient,
    owner_id: &str,
    key: &str,
) -> Result<Option<RunRow>, OwnError> {
    let rows = c.query(
        &format!(
            "SELECT {} FROM agents.own_agent_eval_runs WHERE owner_id = $1::text AND request_key = $2::text",
            run_columns()
        ),
        &[&owner_id, &key],
    )?;
    rows.first().map(run_of).transpose()
}

/// `start`: runs and stores one evaluation and saves its cases as the agent's test set, in one transaction. The same
/// request id again returns the run it made; with another request it refuses `agents.request_id_replay`.
pub fn start(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    request_id: &str,
    request: &EvalRequest,
) -> Result<Json, OwnError> {
    let key = format!("agents:eval:{agent_id}:{request_id}");
    let stored = {
        let mut conn = pool.get().map_err(StoreError::from)?;
        find(conn.client().map_err(StoreError::from)?, owner_id, &key)?
    };
    if let Some(row) = stored {
        return replayed(&row, request);
    }
    let outcome = evaluate(request);
    let cases = Json::Array(request.cases.iter().map(case_json).collect()).compact();
    let results = Json::Array(outcome.results.iter().map(EvalResult::to_json).collect()).compact();
    let repeats = i32::try_from(request.repeats).unwrap_or(i32::MAX);
    let (passed, total) = (
        i32::try_from(outcome.passed).unwrap_or(i32::MAX),
        i32::try_from(outcome.total).unwrap_or(i32::MAX),
    );
    in_transaction(pool, |tx| {
        // One start of this agent at a time, stamped with the clock after the lock.
        tx.query(
            "SELECT id FROM agents.own_agents WHERE id = $1::text::uuid AND owner_id = $2::text FOR UPDATE",
            &[&agent_id, &owner_id],
        )?;
        let inserted = tx.query(
            &format!(
                "INSERT INTO agents.own_agent_eval_runs
                   (agent_id, owner_id, request_id, request_key, cases_json, repeats, threshold, passed, total, score, verdict,
                    results_json, created_at)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text::jsonb, $6::int, $7::text, $8::int, $9::int,
                         $10::text, $11::text, $12::text::jsonb, clock_timestamp())
                 ON CONFLICT (owner_id, request_key) DO NOTHING
                 RETURNING {}",
                run_columns()
            ),
            &[
                &agent_id,
                &owner_id,
                &request_id,
                &key,
                &cases,
                &repeats,
                &request.threshold,
                &passed,
                &total,
                &outcome.score,
                &outcome.verdict,
                &results,
            ],
        )?;
        let Some(row) = inserted.first() else {
            // Another start with this key committed first.
            return Ok(match find(tx, owner_id, &key) {
                Ok(Some(raced)) => replayed(&raced, request),
                Ok(None) => Err(OwnError::Thrown(
                    "own eval run raced and vanished".to_owned(),
                )),
                Err(e) => Err(e),
            });
        };
        let run = match run_of(row) {
            Ok(r) => r,
            Err(e) => return Ok(Err(e)),
        };
        tx.execute(
            "DELETE FROM agents.own_agent_eval_cases WHERE owner_id = $1::text AND agent_id = $2::text::uuid",
            &[&owner_id, &agent_id],
        )?;
        for (position, c) in (0_i32..).zip(&request.cases) {
            tx.execute(
                "INSERT INTO agents.own_agent_eval_cases (agent_id, owner_id, position, input, expected)
                 VALUES ($1::text::uuid, $2::text, $3::int, $4::text, $5::text)",
                &[&agent_id, &owner_id, &position, &c.input, &c.expected],
            )?;
        }
        Ok(Ok(run.view()))
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn case(input: &str, expected: &str) -> Value {
        Value::Object(vec![
            ("input".to_owned(), Value::String(input.to_owned())),
            ("expected".to_owned(), Value::String(expected.to_owned())),
        ])
    }

    fn cases() -> Vec<Value> {
        vec![
            case("TEST case", "TEST answer"),
            case("Say TEST answer", "TEST answer"),
        ]
    }

    fn refused(c: &[Value], repeats: &str, threshold: &str) -> String {
        check_eval_request(c, repeats, threshold).unwrap_err().code
    }

    #[test]
    fn the_test_engine_answers_from_the_input_alone() {
        assert_eq!(
            test_engine_reply("Say TEST answer"),
            "TEST reply: Say TEST answer"
        );
        assert!("TEST reply: Say TEST answer".contains("TEST answer"));
        assert!(!"TEST reply: say test answer".contains("TEST answer"));
    }

    #[test]
    fn a_blank_threshold_or_repeats_count_refuses_by_name_then_the_rest() {
        let c = cases();
        assert_eq!(refused(&c, "2", ""), "agents.eval.threshold_unset");
        assert_eq!(refused(&c, "2", "  "), "agents.eval.threshold_unset");
        assert_eq!(refused(&c, "", "50"), "agents.eval.repeats_unset");
        assert_eq!(refused(&[], "2", "50"), "agents.eval.cases_empty");
        assert_eq!(
            refused(&[case(" ", "x")], "2", "50"),
            "agents.eval.case_blank"
        );
        for repeats in ["0", "11", "1.5", "-1", "two"] {
            assert_eq!(
                refused(&c, repeats, "50"),
                "agents.eval.repeats_invalid",
                "{repeats}"
            );
        }
        for threshold in ["100.01", "101", "-1", "50.123", "half", "1e2"] {
            assert_eq!(
                refused(&c, "2", threshold),
                "agents.eval.threshold_invalid",
                "{threshold}"
            );
        }
        assert_eq!(
            refused(&[case(&"x".repeat(2001), "x")], "1", "50"),
            "agents.eval.case_too_long"
        );
        let many: Vec<Value> = (0..21).map(|i| case(&format!("in {i}"), "x")).collect();
        assert_eq!(refused(&many, "1", "50"), "agents.eval.too_many_cases");
    }

    #[test]
    fn a_case_is_kept_exactly_as_typed() {
        let r = check_eval_request(&[case("reanswer", " answer")], "1", "100").unwrap();
        assert_eq!(
            r.cases,
            [EvalCase {
                input: "reanswer".to_owned(),
                expected: " answer".to_owned()
            }]
        );
        let o = evaluate(&r);
        assert_eq!((o.passed, o.verdict), (0, "fail"));
    }

    #[test]
    fn the_verdict_is_the_exact_share_against_the_threshold() {
        let c = cases();
        let r = check_eval_request(&c, "2", "50%").unwrap();
        assert_eq!(r.threshold, "50");
        let t = |s: &str| {
            let r = check_eval_request(&c, "1", s).unwrap();
            (r.threshold, r.threshold_hundredths)
        };
        assert_eq!(t("66.5"), ("66.5".to_owned(), 6650));
        assert_eq!(t("7.05"), ("7.05".to_owned(), 705));
        assert_eq!(t("100.0"), ("100".to_owned(), 10_000));
        let o = evaluate(&r);
        assert_eq!(
            o.results
                .iter()
                .map(|x| (x.case_index, x.repeat, x.passed))
                .collect::<Vec<_>>(),
            [(0, 1, false), (0, 2, false), (1, 1, true), (1, 2, true)]
        );
        assert_eq!(
            (o.passed, o.total, o.score.as_str(), o.verdict),
            (2, 4, "50", "pass")
        );
        let v = |c: &[Value], repeats: &str, th: &str| {
            evaluate(&check_eval_request(c, repeats, th).unwrap())
        };
        assert_eq!(v(&c, "2", "50.01").verdict, "fail");
        assert_eq!(v(&c, "1", "0").verdict, "pass");
        let one = v(&c[1..], "3", "100");
        assert_eq!((one.score.as_str(), one.verdict), ("100", "pass"));
        let thirds = [c[0].clone(), c[1].clone(), c[1].clone()];
        let o = v(&thirds, "1", "66.66");
        assert_eq!((o.score.as_str(), o.verdict), ("66.66", "pass"));
        assert_eq!(v(&thirds, "1", "66.67").verdict, "fail");
    }
}
