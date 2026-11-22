//! Quizzes and surveys on the items of a course staff made, and their attempts (`curriculum/course-quizzes.ts`).
//!
//! Staff save a quiz item's questions and rules as a draft over the revision they read, then publish it when nothing
//! blocks it. Once a learner has an attempt (or a survey a response) its questions stay and it stays published. Each
//! start checks enrolment, then the access code (a salted scrypt hash, never read back), then the IP filter. An attempt
//! keeps its own copy of the questions; an essay leaves it pending review; the score shows as the quiz's results
//! visibility allows. An anonymous survey stores the answers with the one-way hash of the device's token and no account.

use std::net::IpAddr;

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::release::assert_item_open;
use super::score::{self, answer_fits, score_attempt, score_question};
use super::{
    array, begin, canonical, cell, exec, field, field_int, first, int, iso, iso_or_null, json_cell,
    json_of, ms, one, opt_int, opt_str, query, refuse, sha256_hex, with_client,
};
use crate::db::{self, UNIQUE_VIOLATION};
use crate::errors::Refusal;

/// The quiz item's columns (`columns`).
fn columns() -> String {
    format!(
        "i.id::text AS item_id, i.course_id::text AS course_id, i.title, i.kind, q.kind AS quiz_kind, q.anonymous, \
         q.results_visibility, q.revision, q.state, q.questions::text AS questions, q.pass_mark, q.attempt_limit, \
         q.scoring_policy, q.time_limit_seconds, q.review_mode, q.access_code_hash, q.ip_allow, q.saved_by::text AS saved_by, \
         {} AS saved_at, {} AS published_at",
        ms("q.saved_at"),
        ms("q.published_at")
    )
}

/// The attempt's columns (`ATTEMPT`), unqualified.
pub fn attempt_columns() -> String {
    format!(
        "id::text AS id, item_id::text AS item_id, user_id::text AS user_id, number, {} AS started_at, {} AS deadline_at, \
         quiz::text AS quiz, answers::text AS answers, {} AS finished_at, state, auto_score, max_score, \
         essay_points::text AS essay_points, score, passed",
        ms("started_at"),
        ms("deadline_at"),
        ms("finished_at")
    )
}

/// A quiz item as read.
#[derive(Debug, Clone)]
pub struct QuizRow {
    pub item_id: String,
    pub course_id: String,
    pub title: String,
    pub kind: String,
    pub quiz_kind: Option<String>,
    pub anonymous: Option<bool>,
    pub results_visibility: Option<String>,
    pub revision: Option<i32>,
    pub state: Option<String>,
    pub questions: Option<Json>,
    pub pass_mark: Option<i32>,
    pub attempt_limit: Option<i32>,
    pub scoring_policy: Option<String>,
    pub time_limit_seconds: Option<i32>,
    pub review_mode: Option<String>,
    pub access_code_hash: Option<String>,
    pub ip_allow: Option<Vec<String>>,
    pub saved_by: Option<String>,
    pub saved_at: Option<i64>,
    pub published_at: Option<i64>,
}

impl QuizRow {
    fn read(r: &postgres::Row) -> Result<QuizRow, Refusal> {
        Ok(QuizRow {
            item_id: cell(r, "item_id")?,
            course_id: cell(r, "course_id")?,
            title: cell(r, "title")?,
            kind: cell(r, "kind")?,
            quiz_kind: cell(r, "quiz_kind")?,
            anonymous: cell(r, "anonymous")?,
            results_visibility: cell(r, "results_visibility")?,
            revision: cell(r, "revision")?,
            state: cell(r, "state")?,
            questions: json_cell(r, "questions")?,
            pass_mark: cell(r, "pass_mark")?,
            attempt_limit: cell(r, "attempt_limit")?,
            scoring_policy: cell(r, "scoring_policy")?,
            time_limit_seconds: cell(r, "time_limit_seconds")?,
            review_mode: cell(r, "review_mode")?,
            access_code_hash: cell(r, "access_code_hash")?,
            ip_allow: cell(r, "ip_allow")?,
            saved_by: cell(r, "saved_by")?,
            saved_at: cell(r, "saved_at")?,
            published_at: cell(r, "published_at")?,
        })
    }

    pub fn quiz_kind(&self) -> &str {
        self.quiz_kind.as_deref().unwrap_or("quiz")
    }
}

/// The learner's read: the quiz row with its course and the caller's enrolment.
struct LearnerRow {
    quiz: QuizRow,
    course_slug: String,
    course_title: String,
}

/// An attempt as read.
#[derive(Debug, Clone)]
pub struct Attempt {
    pub id: String,
    pub item_id: String,
    pub user_id: String,
    pub number: i32,
    pub started_at: i64,
    pub deadline_at: Option<i64>,
    pub quiz: Json,
    pub answers: Json,
    pub finished_at: Option<i64>,
    pub state: String,
    pub auto_score: Option<i32>,
    pub max_score: Option<i32>,
    pub essay_points: Option<Json>,
    pub score: Option<i32>,
    pub passed: Option<bool>,
}

impl Attempt {
    pub fn read(r: &postgres::Row) -> Result<Attempt, Refusal> {
        Ok(Attempt {
            id: cell(r, "id")?,
            item_id: cell(r, "item_id")?,
            user_id: cell(r, "user_id")?,
            number: cell(r, "number")?,
            started_at: cell(r, "started_at")?,
            deadline_at: cell(r, "deadline_at")?,
            quiz: json_of(r, "quiz")?,
            answers: json_of(r, "answers")?,
            finished_at: cell(r, "finished_at")?,
            state: cell(r, "state")?,
            auto_score: cell(r, "auto_score")?,
            max_score: cell(r, "max_score")?,
            essay_points: json_cell(r, "essay_points")?,
            score: cell(r, "score")?,
            passed: cell(r, "passed")?,
        })
    }

    /// `row.quiz.questions`.
    pub fn questions(&self) -> &[Json] {
        array(field(&self.quiz, "questions"))
    }

    /// `row.quiz.passMark`.
    pub fn pass_mark(&self) -> i64 {
        field_int(&self.quiz, "passMark").unwrap_or(0)
    }
}

/// `questionsOf(row)`: a question saved before question kinds existed is single choice.
pub fn questions_of(questions: Option<&Json>) -> Vec<Json> {
    array(questions)
        .iter()
        .map(|q| match field(q, "kind") {
            Some(Json::String(k)) if !k.is_empty() => q.clone(),
            _ => match q {
                Json::Object(fs) => {
                    Json::Object(super::with_key(fs.clone(), "kind", Json::str("single")))
                }
                other => other.clone(),
            },
        })
        .collect()
}

/// A question as the output schema emits it: its variant's keys, in the variant's order.
pub fn question_out(q: &Json) -> Json {
    let k = score::kind(q).to_owned();
    let get = |key: &str| field(q, key).cloned().unwrap_or(Json::Null);
    let choices = || {
        Json::Array(
            array(field(q, "choices"))
                .iter()
                .map(|c| {
                    Json::obj([
                        ("id", c.get("id").cloned().unwrap_or(Json::Null)),
                        ("text", c.get("text").cloned().unwrap_or(Json::Null)),
                    ])
                })
                .collect(),
        )
    };
    let mut out = vec![
        ("kind".to_owned(), Json::String(k.clone())),
        ("id".to_owned(), get("id")),
        ("prompt".to_owned(), get("prompt")),
        ("points".to_owned(), get("points")),
    ];
    match k.as_str() {
        "single" => {
            out.push(("choices".to_owned(), choices()));
            out.push(("correctChoiceId".to_owned(), get("correctChoiceId")));
        }
        "multi" => {
            out.push(("choices".to_owned(), choices()));
            out.push(("correctChoiceIds".to_owned(), get("correctChoiceIds")));
            out.push(("partialCredit".to_owned(), get("partialCredit")));
        }
        "numeric" => {
            out.push(("answer".to_owned(), get("answer")));
            out.push(("tolerance".to_owned(), get("tolerance")));
        }
        _ => {}
    }
    Json::Object(out)
}

/// `publishBlockers(quiz)`: what stops a draft from being published, in the editor's order.
pub fn publish_blockers(
    kind: &str,
    questions: usize,
    pass_mark: Option<i64>,
    attempt_limit: Option<i64>,
    scoring_policy: Option<&str>,
) -> Vec<&'static str> {
    let graded = kind == "quiz";
    let mut out = Vec::new();
    if questions == 0 {
        out.push("academy.quiz_no_questions");
    }
    if graded && pass_mark.is_none() {
        out.push("academy.pass_mark_unset");
    }
    if graded && attempt_limit != Some(1) && scoring_policy.is_none() {
        out.push("academy.scoring_policy_unset");
    }
    out
}

/// `recordQuizEvent`.
pub fn record_event<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    revision: i64,
    kind: &str,
    reason: Option<&str>,
    actor: &str,
    at: i64,
) -> Result<(), Refusal> {
    exec(
        c,
        "INSERT INTO academy.course_quiz_events (item_id, revision, kind, reason, actor_id, at) \
         VALUES ($1::text::uuid, $2::int4, $3, $4, $5::text::uuid, $6::text::timestamptz)",
        &[
            &item_id,
            &i32::try_from(revision).unwrap_or(i32::MAX),
            &kind,
            &reason,
            &actor,
            &iso(at),
        ],
    )?;
    Ok(())
}

/// `surveyTokenHash(itemId, clientToken)`.
pub fn survey_token_hash(item_id: &str, token: &str) -> String {
    sha256_hex(format!("{item_id}:{token}").as_bytes())
}

/// `unmapped(address)`: `::ffff:a.b.c.d` as plain IPv4.
pub fn unmapped(address: &str) -> &str {
    let lower_prefix = address
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("::ffff:"));
    let rest = address.get(7..).unwrap_or("");
    let dotted = rest.split('.').count() == 4
        && rest
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if lower_prefix && dotted {
        rest
    } else {
        address
    }
}

/// `net.isIP(address)`: 4, 6 or 0.
pub fn is_ip(address: &str) -> u8 {
    match address.parse::<IpAddr>() {
        Ok(IpAddr::V4(_)) => 4,
        Ok(IpAddr::V6(_)) => 6,
        Err(_) => 0,
    }
}

/// `ruleOf(rule)`: an address with an optional prefix.
fn rule_of(rule: &str) -> Option<(IpAddr, Option<u32>)> {
    let (address, prefix) = match rule.rfind('/') {
        Some(at) => (rule.get(..at)?, Some(rule.get(at + 1..)?)),
        None => (rule, None),
    };
    if address.contains('%') {
        return None;
    }
    let ip: IpAddr = address.parse().ok()?;
    let Some(prefix) = prefix else {
        return Some((ip, None));
    };
    let canonical = prefix == "0"
        || (!prefix.is_empty()
            && !prefix.starts_with('0')
            && prefix.bytes().all(|b| b.is_ascii_digit()));
    let n: u32 = prefix.parse().ok().filter(|_| canonical)?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    (n <= max).then_some((ip, Some(n)))
}

/// `checkIpRules(rules)`: every entry an address or a CIDR range, trimmed; refuses `academy.ip_rule_invalid`.
pub fn check_ip_rules(rules: Option<&[Json]>) -> Result<Option<Vec<String>>, Refusal> {
    let Some(rules) = rules else {
        return Ok(None);
    };
    let out: Vec<String> = rules.iter().map(|r| js_trim(r_str(r)).to_owned()).collect();
    for rule in &out {
        if rule_of(rule).is_none() {
            return refuse(
                format!("academy.ip_rule_invalid {rule}"),
                "academy.ip_rule_invalid",
            );
        }
    }
    Ok(Some(out))
}

fn r_str(j: &Json) -> &str {
    match j {
        Json::String(s) => s,
        _ => "",
    }
}

fn bits(ip: IpAddr) -> (u128, u32) {
    match ip {
        IpAddr::V4(v) => (u128::from(u32::from(v)), 32),
        IpAddr::V6(v) => (u128::from(v), 128),
    }
}

fn in_rule(address: IpAddr, rule: IpAddr, prefix: Option<u32>) -> bool {
    // Node's block list compares an IPv4 address with an IPv6 rule (and back) through the IPv4-mapped form.
    let (address, rule) = match (address, rule) {
        (IpAddr::V4(a), IpAddr::V6(_)) => (IpAddr::V6(a.to_ipv6_mapped()), rule),
        (IpAddr::V6(a), IpAddr::V4(_)) => match a.to_ipv4_mapped() {
            Some(v4) => (IpAddr::V4(v4), rule),
            None => return false,
        },
        pair => pair,
    };
    let ((a, width), (r, _)) = (bits(address), bits(rule));
    let p = prefix.unwrap_or(width);
    if p == 0 {
        return true;
    }
    let shift = width - p;
    (a >> shift) == (r >> shift)
}

/// `addressAllowed(address, rules)`.
pub fn address_allowed(address: &str, rules: &[String]) -> bool {
    let Ok(ip) = unmapped(address).parse::<IpAddr>() else {
        return false;
    };
    rules
        .iter()
        .filter_map(|r| rule_of(r))
        .any(|(rule, prefix)| in_rule(ip, rule, prefix))
}

/// `createQuizAddressResolver(cidrs)`: the trusted proxy ranges, or why one is not a CIDR range.
pub fn proxy_rules(cidrs: &str) -> Result<Vec<String>, String> {
    if js_trim(cidrs).is_empty() {
        return Ok(Vec::new());
    }
    let rules: Vec<String> = cidrs.split(',').map(|c| js_trim(c).to_owned()).collect();
    for rule in &rules {
        if !rule.contains('/') || rule_of(rule).is_none() {
            return Err(format!(
                "ACADEMY_TRUSTED_PROXY_CIDRS: {rule} is not a CIDR range"
            ));
        }
    }
    Ok(rules)
}

/// The resolver's answer: the edge's `x-intafaced-client-ip`, believed only from a socket peer inside the ranges.
pub fn resolve_address(
    rules: &[String],
    peer: Option<&str>,
    header: Option<&str>,
) -> Option<String> {
    let peer = peer?;
    if rules.is_empty() || !address_allowed(peer, rules) {
        return None;
    }
    let address = unmapped(js_trim(header?));
    (is_ip(address) != 0).then(|| address.to_owned())
}

/// `sql.begin`'s connection or the pool's: whichever runs the statements.
fn quiz_row<C: GenericClient>(c: &mut C, item_id: &str, lock: bool) -> Result<QuizRow, Refusal> {
    let sql = format!(
        "SELECT {} FROM academy.course_items i LEFT JOIN academy.course_quizzes q ON q.item_id = i.id \
         WHERE i.id = $1::text::uuid {}",
        columns(),
        if lock { "FOR UPDATE OF i" } else { "" }
    );
    let Some(r) = first(c, &sql, &[&item_id])? else {
        return refuse(
            "no outline item with that id",
            "academy.outline_item_unknown",
        );
    };
    let row = QuizRow::read(&r)?;
    if row.kind != "quiz" {
        return refuse(
            format!("a {} is not a quiz", row.kind),
            "academy.quiz_not_found",
        );
    }
    Ok(row)
}

fn learner_row<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    user_id: &str,
    lock: bool,
    now: i64,
) -> Result<LearnerRow, Refusal> {
    let sql = format!(
        "SELECT {}, c.slug AS course_slug, c.title AS course_title, c.state AS course_state, \
           EXISTS (SELECT 1 FROM academy.course_enrolments e \
             WHERE e.course_id = c.id AND e.user_id = $2::text::uuid AND e.left_at IS NULL) AS enrolled \
         FROM academy.course_items i \
         JOIN academy.courses c ON c.id = i.course_id \
         LEFT JOIN academy.course_quizzes q ON q.item_id = i.id \
         WHERE i.id = $1::text::uuid {}",
        columns(),
        if lock { "FOR SHARE OF i" } else { "" }
    );
    let r = first(c, &sql, &[&item_id, &user_id])?;
    let Some(r) = r else {
        return refuse(
            "no quiz is open at that address",
            "academy.assessment_unpublished",
        );
    };
    let quiz = QuizRow::read(&r)?;
    let course_state: String = cell(&r, "course_state")?;
    if quiz.kind != "quiz"
        || quiz.state.as_deref() != Some("published")
        || course_state != "published"
    {
        return refuse(
            "no quiz is open at that address",
            "academy.assessment_unpublished",
        );
    }
    let course_slug: String = cell(&r, "course_slug")?;
    if !cell::<bool>(&r, "enrolled")? {
        return refuse(
            format!("academy.enrolment_required course={course_slug}"),
            "academy.enrolment_required",
        );
    }
    assert_item_open(c, &quiz.item_id, user_id, now)?;
    Ok(LearnerRow {
        quiz,
        course_slug,
        course_title: cell(&r, "course_title")?,
    })
}

/// Attempts and survey responses on the quiz.
fn taken<C: GenericClient>(c: &mut C, item_id: &str) -> Result<i32, Refusal> {
    let r = one(
        c,
        "SELECT (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid)::int \
              + (SELECT count(*) FROM academy.course_survey_responses WHERE item_id = $1::text::uuid)::int AS n",
        &[&item_id],
    )?;
    cell(&r, "n")
}

fn admin_in<C: GenericClient>(c: &mut C, row: &QuizRow) -> Result<Json, Refusal> {
    let questions = questions_of(row.questions.as_ref());
    let kind = row.quiz_kind().to_owned();
    let counts = one(
        c,
        "SELECT \
           (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid)::int AS attempts, \
           (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid AND state = 'pending_review')::int AS pending, \
           (SELECT count(*) FROM academy.course_survey_responses WHERE item_id = $1::text::uuid)::int AS responses",
        &[&row.item_id],
    )?;
    let blockers = publish_blockers(
        &kind,
        questions.len(),
        row.pass_mark.map(i64::from),
        row.attempt_limit.map(i64::from),
        row.scoring_policy.as_deref(),
    );
    Ok(Json::obj([
        ("itemId", Json::str(row.item_id.clone())),
        ("courseId", Json::str(row.course_id.clone())),
        ("title", Json::str(row.title.clone())),
        ("revision", int(i64::from(row.revision.unwrap_or(0)))),
        (
            "state",
            Json::str(row.state.clone().unwrap_or_else(|| "draft".to_owned())),
        ),
        ("passMark", opt_int(row.pass_mark.map(i64::from))),
        ("attemptLimit", opt_int(row.attempt_limit.map(i64::from))),
        ("scoringPolicy", opt_str(row.scoring_policy.clone())),
        (
            "timeLimitSeconds",
            opt_int(row.time_limit_seconds.map(i64::from)),
        ),
        (
            "reviewMode",
            Json::str(
                row.review_mode
                    .clone()
                    .unwrap_or_else(|| "score_only".to_owned()),
            ),
        ),
        (
            "ipAllow",
            row.ip_allow.as_ref().map_or(Json::Null, |l| {
                Json::Array(l.iter().cloned().map(Json::String).collect())
            }),
        ),
        ("kind", Json::String(kind)),
        ("anonymous", Json::Bool(row.anonymous.unwrap_or(false))),
        (
            "resultsVisibility",
            Json::str(
                row.results_visibility
                    .clone()
                    .unwrap_or_else(|| "always".to_owned()),
            ),
        ),
        ("accessCodeSet", Json::Bool(row.access_code_hash.is_some())),
        (
            "questions",
            Json::Array(questions.iter().map(question_out).collect()),
        ),
        ("savedBy", opt_str(row.saved_by.clone())),
        ("savedAt", iso_or_null(row.saved_at)),
        ("publishedAt", iso_or_null(row.published_at)),
        (
            "attempts",
            int(i64::from(cell::<i32>(&counts, "attempts")?)),
        ),
        (
            "pendingReview",
            int(i64::from(cell::<i32>(&counts, "pending")?)),
        ),
        (
            "responses",
            int(i64::from(cell::<i32>(&counts, "responses")?)),
        ),
        (
            "blockers",
            Json::Array(blockers.into_iter().map(Json::str).collect()),
        ),
    ]))
}

/// `adminView(itemId)`.
pub fn admin_view(pool: &Store, item_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let row = quiz_row(c, item_id, false)?;
        admin_in(c, &row)
    })
}

fn v_int(input: &service_kit::schema::Value, key: &str) -> Option<i64> {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the schema checked a whole number"
    )]
    input.get(key).as_number().map(|n| n as i64)
}

fn v_str<'a>(input: &'a service_kit::schema::Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

/// `save(input)`: the draft over the revision read.
pub fn save(pool: &Store, input: &Json, operator: &str, now: i64) -> Result<Json, Refusal> {
    let v = service_kit::schema::Value::from_json(input);
    let ip_allow = check_ip_rules(match field(input, "ipAllow") {
        Some(Json::Array(a)) => Some(a.as_slice()),
        _ => None,
    })?;
    let kind = v_str(&v, "kind").unwrap_or("quiz").to_owned();
    let survey = kind == "survey";
    let access_code = field(input, "accessCode");
    let code_typed = matches!(access_code, Some(Json::String(_)));
    if survey && (code_typed || ip_allow.is_some()) {
        return refuse(
            "academy.assessment_invalid a survey takes no access code or IP filter",
            "academy.assessment_invalid",
        );
    }
    let pass_mark = if survey { None } else { v_int(&v, "passMark") };
    let scoring_policy = if survey {
        None
    } else {
        v_str(&v, "scoringPolicy").map(str::to_owned)
    };
    let questions = array(field(input, "questions")).to_vec();
    let total: i64 = questions.iter().map(score::points).sum();
    if pass_mark.is_some_and(|p| p > total) {
        return refuse(
            "academy.assessment_invalid the pass mark is more than the questions' points",
            "academy.assessment_invalid",
        );
    }
    let new_code = match access_code {
        Some(Json::String(code)) => Some(super::scrypt::hash_access_code(
            code,
            &super::scrypt::random_salt(),
        )),
        _ => None,
    };
    let anonymous = matches!(field(input, "anonymous"), Some(Json::Bool(true)));
    let revision_in = v_int(&v, "revision").unwrap_or(0);
    let item_id = v_str(&v, "itemId").unwrap_or("").to_owned();
    begin(pool, |tx| {
        let row = quiz_row(tx, &item_id, true)?;
        let revision = i64::from(row.revision.unwrap_or(0));
        if revision != revision_in {
            return refuse(
                format!("the quiz is at revision {revision}, not {revision_in}"),
                "academy.revision_stale",
            );
        }
        let was = Json::obj([
            ("kind", Json::str(row.quiz_kind())),
            ("anonymous", Json::Bool(row.anonymous.unwrap_or(false))),
            (
                "questions",
                Json::Array(questions_of(row.questions.as_ref())),
            ),
        ]);
        let next = Json::obj([
            ("kind", Json::str(kind.clone())),
            ("anonymous", Json::Bool(anonymous)),
            ("questions", Json::Array(questions.clone())),
        ]);
        if taken(tx, &row.item_id)? > 0 && canonical(&was) != canonical(&next) {
            return refuse(
                "learners have taken this quiz, so its questions stay as they are",
                "academy.item_has_attempts",
            );
        }
        let state = row.state.clone().unwrap_or_else(|| "draft".to_owned());
        let blockers = publish_blockers(
            &kind,
            questions.len(),
            pass_mark,
            v_int(&v, "attemptLimit"),
            scoring_policy.as_deref(),
        );
        if state == "published"
            && let Some(b) = blockers.first()
        {
            return refuse(*b, b);
        }
        let code: Option<String> = if survey {
            None
        } else {
            match access_code {
                None => row.access_code_hash.clone(),
                Some(Json::Null) => None,
                Some(_) => new_code.clone(),
            }
        };
        let to_i32 = |n: Option<i64>| n.map(|x| i32::try_from(x).unwrap_or(i32::MAX));
        exec(
            tx,
            "INSERT INTO academy.course_quizzes \
               (item_id, revision, state, kind, anonymous, results_visibility, questions, pass_mark, attempt_limit, scoring_policy, \
                time_limit_seconds, review_mode, access_code_hash, ip_allow, saved_by, saved_at) \
             VALUES ($1::text::uuid, $2::int4, 'draft', $3, $4::bool, $5, $6::text::jsonb, $7::int4, $8::int4, $9, $10::int4, \
                     $11, $12, $13::text[], $14::text::uuid, $15::text::timestamptz) \
             ON CONFLICT (item_id) DO UPDATE SET \
               revision = EXCLUDED.revision, kind = EXCLUDED.kind, anonymous = EXCLUDED.anonymous, \
               results_visibility = EXCLUDED.results_visibility, questions = EXCLUDED.questions, pass_mark = EXCLUDED.pass_mark, \
               attempt_limit = EXCLUDED.attempt_limit, scoring_policy = EXCLUDED.scoring_policy, \
               time_limit_seconds = EXCLUDED.time_limit_seconds, review_mode = EXCLUDED.review_mode, \
               access_code_hash = EXCLUDED.access_code_hash, ip_allow = EXCLUDED.ip_allow, saved_by = EXCLUDED.saved_by, \
               saved_at = EXCLUDED.saved_at",
            &[
                &row.item_id,
                &i32::try_from(revision + 1).unwrap_or(i32::MAX),
                &kind,
                &anonymous,
                &v_str(&v, "resultsVisibility"),
                &Json::Array(questions.clone()).compact(),
                &to_i32(pass_mark),
                &to_i32(v_int(&v, "attemptLimit")),
                &scoring_policy,
                &to_i32(v_int(&v, "timeLimitSeconds")),
                &v_str(&v, "reviewMode"),
                &code,
                &ip_allow,
                &operator,
                &iso(now),
            ],
        )?;
        record_event(tx, &row.item_id, revision + 1, "saved", None, operator, now)?;
        let fresh = quiz_row(tx, &row.item_id, false)?;
        admin_in(tx, &fresh)
    })
}

/// `setState(input)`: publish when nothing blocks it, or take back to draft while nobody has taken it.
pub fn set_state(
    pool: &Store,
    item_id: &str,
    state: &str,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let row = quiz_row(tx, item_id, true)?;
        let Some(revision) = row.revision else {
            return refuse(
                "the quiz has nothing saved to publish",
                "academy.quiz_no_questions",
            );
        };
        if row.state.as_deref() == Some(state) {
            return admin_in(tx, &row);
        }
        if state == "published" {
            let blockers = publish_blockers(
                row.quiz_kind(),
                questions_of(row.questions.as_ref()).len(),
                row.pass_mark.map(i64::from),
                row.attempt_limit.map(i64::from),
                row.scoring_policy.as_deref(),
            );
            if let Some(b) = blockers.first() {
                return refuse(format!("{b} blockers={}", blockers.join(",")), b);
            }
        } else if taken(tx, &row.item_id)? > 0 {
            return refuse(
                "learners have taken this quiz, so it stays published",
                "academy.item_has_attempts",
            );
        }
        let published_at = (state == "published").then(|| iso(now));
        exec(
            tx,
            "UPDATE academy.course_quizzes SET state = $1, published_at = $2::text::timestamptz WHERE item_id = $3::text::uuid",
            &[&state, &published_at, &row.item_id],
        )?;
        let kind = if state == "published" {
            "published"
        } else {
            "unpublished"
        };
        record_event(
            tx,
            &row.item_id,
            i64::from(revision),
            kind,
            Some(reason),
            operator,
            now,
        )?;
        let fresh = quiz_row(tx, &row.item_id, false)?;
        admin_in(tx, &fresh)
    })
}

/// `learnerView(input)`.
pub fn learner_view(pool: &Store, item_id: &str, user_id: &str, now: i64) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let row = learner_row(c, item_id, user_id, false, now)?;
        let q = &row.quiz;
        let used = one(
            c,
            "SELECT \
               (SELECT count(*) FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid)::int AS n, \
               EXISTS (SELECT 1 FROM academy.course_survey_takers WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid) AS responded",
            &[&q.item_id, &user_id],
        )?;
        let kind = q.quiz_kind().to_owned();
        let questions: Vec<Json> = questions_of(q.questions.as_ref())
            .iter()
            .map(|x| {
                let choices = match field(x, "choices") {
                    Some(Json::Array(cs)) => Json::Array(
                        cs.iter()
                            .map(|c| {
                                Json::obj([
                                    ("id", c.get("id").cloned().unwrap_or(Json::Null)),
                                    ("text", c.get("text").cloned().unwrap_or(Json::Null)),
                                ])
                            })
                            .collect(),
                    ),
                    _ => Json::Null,
                };
                Json::obj([
                    ("id", x.get("id").cloned().unwrap_or(Json::Null)),
                    ("prompt", x.get("prompt").cloned().unwrap_or(Json::Null)),
                    ("kind", Json::str(score::kind(x))),
                    ("points", x.get("points").cloned().unwrap_or(Json::Null)),
                    ("choices", choices),
                ])
            })
            .collect();
        Ok(Json::obj([
            ("itemId", Json::str(q.item_id.clone())),
            ("courseSlug", Json::str(row.course_slug.clone())),
            ("courseTitle", Json::str(row.course_title.clone())),
            ("title", Json::str(q.title.clone())),
            ("kind", Json::String(kind.clone())),
            ("anonymous", Json::Bool(q.anonymous.unwrap_or(false))),
            (
                "passMark",
                if kind == "survey" {
                    Json::Null
                } else {
                    opt_int(q.pass_mark.map(i64::from))
                },
            ),
            ("attemptLimit", opt_int(q.attempt_limit.map(i64::from))),
            (
                "timeLimitSeconds",
                opt_int(q.time_limit_seconds.map(i64::from)),
            ),
            (
                "reviewMode",
                Json::str(
                    q.review_mode
                        .clone()
                        .unwrap_or_else(|| "score_only".to_owned()),
                ),
            ),
            (
                "resultsVisibility",
                Json::str(
                    q.results_visibility
                        .clone()
                        .unwrap_or_else(|| "always".to_owned()),
                ),
            ),
            (
                "accessCodeRequired",
                Json::Bool(q.access_code_hash.is_some()),
            ),
            ("attemptsUsed", int(i64::from(cell::<i32>(&used, "n")?))),
            ("responded", Json::Bool(cell(&used, "responded")?)),
            ("questions", Json::Array(questions)),
        ]))
    })
}

/// `hold`: one learner's attempts on one quiz are taken in turn.
fn hold<C: GenericClient>(c: &mut C, user_id: &str, item_id: &str) -> Result<(), Refusal> {
    query(
        c,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&format!("{user_id}:course-quiz:{item_id}")],
    )?;
    Ok(())
}

fn attempt_sql(rest: &str) -> String {
    format!(
        "SELECT {} FROM academy.course_quiz_attempts {rest}",
        attempt_columns()
    )
}

fn own_attempt<C: GenericClient>(
    c: &mut C,
    attempt_id: &str,
    user_id: &str,
) -> Result<Attempt, Refusal> {
    let r = first(
        c,
        &attempt_sql("WHERE id = $1::text::uuid AND user_id = $2::text::uuid"),
        &[&attempt_id, &user_id],
    )?;
    match r {
        Some(r) => Attempt::read(&r),
        None => refuse("academy.attempt_not_found", "academy.attempt_not_found"),
    }
}

fn finish_row<C: GenericClient>(c: &mut C, row: &Attempt, at: i64) -> Result<Attempt, Refusal> {
    let (auto, max, essays) = score_attempt(row.questions(), &row.answers);
    let finished_at = match row.deadline_at {
        Some(d) if at > d => d,
        _ => at,
    };
    let graded = !essays;
    let to_i32 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let r = one(
        c,
        &format!(
            "UPDATE academy.course_quiz_attempts \
             SET finished_at = $1::text::timestamptz, state = $2, auto_score = $3::int4, max_score = $4::int4, score = $5::int4, \
                 passed = $6::bool \
             WHERE id = $7::text::uuid RETURNING {}",
            attempt_columns()
        ),
        &[
            &iso(finished_at),
            &(if graded { "graded" } else { "pending_review" }),
            &to_i32(auto),
            &to_i32(max),
            &graded.then(|| to_i32(auto)),
            &graded.then(|| auto >= row.pass_mark()),
            &row.id,
        ],
    )?;
    Attempt::read(&r)
}

fn settle_open<C: GenericClient>(
    c: &mut C,
    user_id: &str,
    item_id: &str,
    now: i64,
) -> Result<Option<Attempt>, Refusal> {
    let r = first(
        c,
        &attempt_sql(
            "WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid AND state = 'open'",
        ),
        &[&item_id, &user_id],
    )?;
    let Some(r) = r else {
        return Ok(None);
    };
    let open = Attempt::read(&r)?;
    if let Some(deadline) = open.deadline_at
        && now >= deadline
    {
        finish_row(c, &open, deadline)?;
        return Ok(None);
    }
    Ok(Some(open))
}

fn own_open<C: GenericClient>(
    c: &mut C,
    attempt_id: &str,
    user_id: &str,
    now: i64,
) -> Result<Attempt, Refusal> {
    let row = own_attempt(c, attempt_id, user_id)?;
    hold(c, user_id, &row.item_id)?;
    match settle_open(c, user_id, &row.item_id, now)? {
        Some(open) if open.id == attempt_id => Ok(open),
        _ => refuse(
            "academy.attempt_closed this attempt is finished",
            "academy.attempt_closed",
        ),
    }
}

/// The key a question carries: a choice id, choice ids or a decimal; none on an essay.
pub fn key_of_question(q: &Json) -> Json {
    let get = |k: &str| field(q, k).cloned().unwrap_or(Json::Null);
    match score::kind(q) {
        "single" => get("correctChoiceId"),
        "multi" => get("correctChoiceIds"),
        "numeric" => get("answer"),
        _ => Json::Null,
    }
}

/// `ceil(a / b)` for a positive `b`.
fn ceil_div(a: i64, b: i64) -> i64 {
    -((-a).div_euclid(b))
}

fn attempt_in<C: GenericClient>(c: &mut C, row: &Attempt, now: i64) -> Result<Json, Refusal> {
    let seconds_left = match (row.state.as_str(), row.deadline_at) {
        ("open", Some(d)) => Json::int(ceil_div(d - now, 1000).max(0)),
        _ => Json::Null,
    };
    let base = |result: Json| {
        Json::obj([
            ("attemptId", Json::str(row.id.clone())),
            ("itemId", Json::str(row.item_id.clone())),
            ("number", int(i64::from(row.number))),
            ("startedAt", Json::String(iso(row.started_at))),
            ("deadlineAt", iso_or_null(row.deadline_at)),
            ("secondsLeft", seconds_left.clone()),
            ("answers", row.answers.clone()),
            ("result", result),
        ])
    };
    if row.state == "open" {
        return Ok(base(Json::Null));
    }
    let finished_at = Json::String(iso(row.finished_at.unwrap_or(0)));
    if row.state == "pending_review" {
        return Ok(base(Json::obj([
            ("state", Json::str("pending_review")),
            ("finishedAt", finished_at),
        ])));
    }
    let (show, review_mode) = results_show(c, row)?;
    if !show {
        return Ok(base(Json::obj([
            ("state", Json::str("withheld")),
            ("finishedAt", finished_at),
        ])));
    }
    let changed = first(
        c,
        "SELECT score, passed, points::text AS points, keys::text AS keys FROM academy.course_quiz_score_events \
         WHERE attempt_id = $1::text::uuid ORDER BY n DESC LIMIT 1",
        &[&row.id],
    )?;
    let changed = match changed {
        Some(r) => Some((
            cell::<i32>(&r, "score")?,
            cell::<bool>(&r, "passed")?,
            json_of(&r, "points")?,
            json_of(&r, "keys")?,
        )),
        None => None,
    };
    let review = (review_mode == "answers").then(|| {
        row.questions()
            .iter()
            .map(|q| {
                let qid = score::id(q);
                let given = row.answers.get(qid).cloned();
                let earned = score_question(q, given.as_ref())
                    .or_else(|| {
                        row.essay_points
                            .as_ref()
                            .and_then(|e| e.get(qid))
                            .and_then(super::num)
                    })
                    .unwrap_or(0);
                let mut key = key_of_question(q);
                let mut earned = earned;
                if let Some((_, _, points, keys)) = &changed {
                    if let Some(applied) = keys.get(qid).filter(|a| !matches!(a, Json::Null)) {
                        let pick = ["correctChoiceId", "correctChoiceIds", "answer"]
                            .iter()
                            .find_map(|k| {
                                applied.get(k).filter(|v| !matches!(v, Json::Null)).cloned()
                            });
                        if let Some(p) = pick {
                            key = p;
                        }
                    }
                    if let Some(p) = points
                        .get(qid)
                        .filter(|v| !matches!(v, Json::Null))
                        .and_then(super::num)
                    {
                        earned = p;
                    }
                }
                Json::obj([
                    ("questionId", Json::str(qid)),
                    ("kind", Json::str(score::kind(q))),
                    ("given", given.unwrap_or(Json::Null)),
                    ("key", key),
                    ("earned", Json::int(earned)),
                    ("points", Json::int(score::points(q))),
                ])
            })
            .collect::<Vec<_>>()
    });
    let score = changed.as_ref().map_or(row.score.unwrap_or(0), |c| c.0);
    let pass = changed
        .as_ref()
        .map_or(row.passed.unwrap_or(false), |c| c.1);
    Ok(base(Json::obj([
        ("state", Json::str("graded")),
        ("score", int(i64::from(score))),
        ("maxScore", opt_int(row.max_score.map(i64::from))),
        ("pass", Json::Bool(pass)),
        ("finishedAt", finished_at),
        ("review", review.map_or(Json::Null, Json::Array)),
    ])))
}

/// `resultsShow(row)`: whether the quiz's visibility now lets this learner see a graded score, and its review mode.
fn results_show<C: GenericClient>(c: &mut C, row: &Attempt) -> Result<(bool, String), Refusal> {
    let quiz = first(
        c,
        "SELECT q.results_visibility AS visibility, q.attempt_limit AS limit, q.review_mode, \
           (SELECT count(*)::int FROM academy.course_quiz_attempts t \
             WHERE t.item_id = q.item_id AND t.user_id = $1::text::uuid AND t.state <> 'open') AS finished \
         FROM academy.course_quizzes q WHERE q.item_id = $2::text::uuid",
        &[&row.user_id, &row.item_id],
    )?;
    let Some(q) = quiz else {
        return Ok((false, "score_only".to_owned()));
    };
    let visibility: String = cell(&q, "visibility")?;
    if visibility == "never" {
        return Ok((false, "score_only".to_owned()));
    }
    let limit: Option<i32> = cell(&q, "limit")?;
    let finished: i32 = cell(&q, "finished")?;
    let show = visibility == "always" || limit.is_some_and(|l| finished >= l);
    Ok((show, cell(&q, "review_mode")?))
}

/// `start(input)`: enrolment, then the access code, then the IP filter; an open attempt is answered as it stands.
pub fn start(
    pool: &Store,
    item_id: &str,
    user_id: &str,
    access_code: Option<&str>,
    client_address: Option<&str>,
    now: i64,
) -> Result<Json, Refusal> {
    let checked = with_client(pool, |c| learner_row(c, item_id, user_id, false, now))?;
    if checked.quiz.quiz_kind() == "survey" {
        return refuse(
            "a survey is answered with submitCourseSurvey, not started",
            "academy.quiz_not_found",
        );
    }
    if let Some(stored) = &checked.quiz.access_code_hash {
        let ok = access_code.is_some_and(|code| {
            !code.is_empty() && super::scrypt::access_code_matches(code, stored)
        });
        if !ok {
            return refuse("academy.access_code_invalid", "academy.access_code_invalid");
        }
    }
    begin(pool, |tx| {
        let row = learner_row(tx, item_id, user_id, true, now)?;
        let q = &row.quiz;
        if q.access_code_hash != checked.quiz.access_code_hash || q.quiz_kind() != "quiz" {
            return refuse(
                "academy.access_code_invalid the quiz changed; start again",
                "academy.access_code_invalid",
            );
        }
        if let Some(rules) = &q.ip_allow {
            let address = client_address.map(unmapped);
            let Some(address) = address.filter(|a| is_ip(a) != 0) else {
                return refuse(
                    "academy.ip_unreadable the caller address could not be read",
                    "academy.ip_unreadable",
                );
            };
            if !address_allowed(address, rules) {
                return refuse("academy.ip_not_allowed", "academy.ip_not_allowed");
            }
        }
        hold(tx, user_id, &q.item_id)?;
        if let Some(open) = settle_open(tx, user_id, &q.item_id, now)? {
            return attempt_in(tx, &open, now);
        }
        let counted: i32 = cell(
            &one(
                tx,
                "SELECT count(*)::int AS n FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid",
                &[&q.item_id, &user_id],
            )?,
            "n",
        )?;
        if let Some(limit) = q.attempt_limit
            && counted >= limit
        {
            return refuse(
                format!("academy.attempt_limit limit={limit}"),
                "academy.attempt_limit",
            );
        }
        let deadline = q.time_limit_seconds.map(|s| iso(now + i64::from(s) * 1000));
        let copy = Json::obj([
            ("questions", Json::Array(questions_of(q.questions.as_ref()))),
            ("passMark", opt_int(q.pass_mark.map(i64::from))),
        ]);
        let created = one(
            tx,
            &format!(
                "INSERT INTO academy.course_quiz_attempts (item_id, user_id, number, started_at, deadline_at, quiz, state) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::int4, $4::text::timestamptz, $5::text::timestamptz, $6::text::jsonb, 'open') \
                 RETURNING {}",
                attempt_columns()
            ),
            &[
                &q.item_id,
                &user_id,
                &(counted + 1),
                &iso(now),
                &deadline,
                &copy.compact(),
            ],
        )?;
        attempt_in(tx, &Attempt::read(&created)?, now)
    })
}

/// `current(input)`: the caller's newest attempt, or null.
pub fn current(pool: &Store, item_id: &str, user_id: &str, now: i64) -> Result<Json, Refusal> {
    let row = with_client(pool, |c| learner_row(c, item_id, user_id, false, now))?;
    begin(pool, |tx| {
        hold(tx, user_id, &row.quiz.item_id)?;
        settle_open(tx, user_id, &row.quiz.item_id, now)?;
        let latest = first(
            tx,
            &attempt_sql(
                "WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid ORDER BY number DESC LIMIT 1",
            ),
            &[&row.quiz.item_id, &user_id],
        )?;
        match latest {
            Some(r) => attempt_in(tx, &Attempt::read(&r)?, now),
            None => Ok(Json::Null),
        }
    })
}

/// `answer(input)`: one answer on the caller's open attempt.
pub fn answer(
    pool: &Store,
    attempt_id: &str,
    user_id: &str,
    question_id: &str,
    given: &Json,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let open = own_open(tx, attempt_id, user_id, now)?;
        let fits = open
            .questions()
            .iter()
            .find(|q| score::id(q) == question_id)
            .is_some_and(|q| answer_fits(q, given));
        if !fits {
            return refuse(
                "academy.assessment_invalid the answer does not fit that question",
                "academy.assessment_invalid",
            );
        }
        let patch = Json::Object(vec![(question_id.to_owned(), given.clone())]);
        let saved = one(
            tx,
            &format!(
                "UPDATE academy.course_quiz_attempts SET answers = answers || $1::text::jsonb WHERE id = $2::text::uuid RETURNING {}",
                attempt_columns()
            ),
            &[&patch.compact(), &open.id],
        )?;
        attempt_in(tx, &Attempt::read(&saved)?, now)
    })
}

/// `finish(input)`: score once; finishing again answers the same.
pub fn finish(pool: &Store, attempt_id: &str, user_id: &str, now: i64) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let row = own_attempt(tx, attempt_id, user_id)?;
        hold(tx, user_id, &row.item_id)?;
        let current = Attempt::read(&one(
            tx,
            &attempt_sql("WHERE id = $1::text::uuid"),
            &[&row.id],
        )?)?;
        let finished = if current.state == "open" {
            finish_row(tx, &current, now)?
        } else {
            current
        };
        attempt_in(tx, &finished, now)
    })
}

/// `reviews(itemId)`: finished attempts waiting for an essay score, oldest first, under per-quiz aliases.
pub fn reviews(pool: &Store, item_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let row = quiz_row(c, item_id, false)?;
        let cols = attempt_columns();
        let rows = query(
            c,
            &format!(
                "SELECT {cols}, a.alias FROM academy.course_quiz_attempts t \
                 JOIN (SELECT user_id, row_number() OVER (ORDER BY min(started_at), user_id)::int AS alias \
                       FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid GROUP BY user_id) a USING (user_id) \
                 WHERE t.item_id = $1::text::uuid AND t.state = 'pending_review' \
                 ORDER BY t.finished_at, t.id"
            ),
            &[&row.item_id],
        )?;
        let mut out = Vec::new();
        for r in &rows {
            let a = Attempt::read(r)?;
            let alias: i32 = cell(r, "alias")?;
            let essays: Vec<Json> = a
                .questions()
                .iter()
                .filter(|q| score::kind(q) == "essay")
                .map(|q| {
                    let text = match a.answers.get(score::id(q)) {
                        Some(Json::String(s)) => Json::String(s.clone()),
                        _ => Json::Null,
                    };
                    Json::obj([
                        ("questionId", Json::str(score::id(q))),
                        ("prompt", q.get("prompt").cloned().unwrap_or(Json::Null)),
                        ("points", Json::int(score::points(q))),
                        ("text", text),
                    ])
                })
                .collect();
            out.push(Json::obj([
                ("attemptId", Json::str(a.id.clone())),
                ("alias", int(i64::from(alias))),
                ("number", int(i64::from(a.number))),
                ("finishedAt", Json::String(iso(a.finished_at.unwrap_or(0)))),
                ("autoScore", int(i64::from(a.auto_score.unwrap_or(0)))),
                ("essays", Json::Array(essays)),
            ]));
        }
        Ok(Json::Array(out))
    })
}

/// `scoreEssays(input)`: each essay from 0 to its points, then the attempt is graded.
pub fn score_essays(
    pool: &Store,
    item_id: &str,
    attempt_id: &str,
    points: &Json,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let item = begin(pool, |tx| {
        let row = first(
            tx,
            &attempt_sql("WHERE id = $1::text::uuid FOR UPDATE"),
            &[&attempt_id],
        )?;
        let row = match row {
            Some(r) => Attempt::read(&r)?,
            None => return refuse("academy.attempt_not_found", "academy.attempt_not_found"),
        };
        if row.item_id != item_id {
            return refuse("academy.attempt_not_found", "academy.attempt_not_found");
        }
        if row.state != "pending_review" {
            return refuse(
                format!(
                    "academy.attempt_closed the attempt is {}, not waiting for a score",
                    row.state
                ),
                "academy.attempt_closed",
            );
        }
        let essays: Vec<&Json> = row
            .questions()
            .iter()
            .filter(|q| score::kind(q) == "essay")
            .collect();
        let given = super::fields(points);
        let bad = given.len() != essays.len()
            || essays
                .iter()
                .any(|q| match points.get(score::id(q)).and_then(super::num) {
                    None => true,
                    Some(p) => p > score::points(q),
                });
        if bad {
            return refuse(
                "academy.assessment_invalid score every essay, each from 0 to its points",
                "academy.assessment_invalid",
            );
        }
        let total = i64::from(row.auto_score.unwrap_or(0))
            + essays
                .iter()
                .map(|q| points.get(score::id(q)).and_then(super::num).unwrap_or(0))
                .sum::<i64>();
        exec(
            tx,
            "UPDATE academy.course_quiz_attempts \
             SET state = 'graded', essay_points = $1::text::jsonb, score = $2::int4, passed = $3::bool, \
                 scored_by = $4::text::uuid, scored_at = $5::text::timestamptz \
             WHERE id = $6::text::uuid",
            &[
                &points.compact(),
                &i32::try_from(total).unwrap_or(i32::MAX),
                &(total >= row.pass_mark()),
                &operator,
                &iso(now),
                &row.id,
            ],
        )?;
        let quiz = first(
            tx,
            "SELECT revision FROM academy.course_quizzes WHERE item_id = $1::text::uuid",
            &[&row.item_id],
        )?;
        let revision = match quiz {
            Some(q) => i64::from(cell::<i32>(&q, "revision")?),
            None => 1,
        };
        record_event(
            tx,
            &row.item_id,
            revision,
            "essay_scored",
            None,
            operator,
            now,
        )?;
        Ok(row.item_id)
    })?;
    reviews(pool, &item)
}

/// `submitSurvey(input)`: one response per learner; an anonymous one keeps no account and the hour only.
pub fn submit_survey(
    pool: &Store,
    item_id: &str,
    user_id: &str,
    token: &str,
    answers: &Json,
    now: i64,
) -> Result<Json, Refusal> {
    let row = with_client(pool, |c| learner_row(c, item_id, user_id, false, now))?;
    let q = &row.quiz;
    if q.quiz_kind() != "survey" {
        return refuse(
            "a graded quiz is started, not sent as a survey",
            "academy.quiz_not_found",
        );
    }
    let questions = questions_of(q.questions.as_ref());
    let entries = super::fields(answers);
    if entries.is_empty() {
        return refuse(
            "academy.assessment_invalid answer at least one question",
            "academy.assessment_invalid",
        );
    }
    for (question_id, given) in entries {
        let fits = questions
            .iter()
            .find(|x| score::id(x) == question_id)
            .is_some_and(|x| answer_fits(x, given));
        if !fits {
            return refuse(
                format!("academy.assessment_invalid the answer to {question_id} does not fit it"),
                "academy.assessment_invalid",
            );
        }
    }
    let anonymous = q.anonymous.unwrap_or(false);
    let at = if anonymous {
        now.div_euclid(3_600_000) * 3_600_000
    } else {
        now
    };
    let duplicate = || {
        refuse::<Json>(
            "this survey already has your answers",
            "academy.survey_duplicate",
        )
    };
    let taken: i32 = with_client(pool, |c| {
        cell(
            &one(
                c,
                "SELECT count(*)::int AS n FROM academy.course_survey_takers WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid",
                &[&q.item_id, &user_id],
            )?,
            "n",
        )
    })?;
    if taken > 0 {
        return duplicate();
    }
    let owner = (!anonymous).then_some(user_id);
    let hash = survey_token_hash(&q.item_id, token);
    let inserted = with_client(pool, |c| {
        Ok(c.query(
            "INSERT INTO academy.course_survey_responses (item_id, user_id, token_hash, answers, submitted_at) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::jsonb, $5::text::timestamptz) RETURNING id::text AS id",
            &[&q.item_id, &owner, &hash, &answers.compact(), &iso(at)],
        ))
    })?;
    let response_id: String = match inserted {
        Ok(rows) => match rows.first() {
            Some(r) => cell(r, "id")?,
            None => return Err(Refusal::db("the insert returned no row", None)),
        },
        Err(e) if db::sqlstate(&e).as_deref() == Some(UNIQUE_VIOLATION) => return duplicate(),
        Err(e) => return Err(db::refusal(&e)),
    };
    let taker = with_client(pool, |c| {
        Ok(c.execute(
            "INSERT INTO academy.course_survey_takers (item_id, user_id) VALUES ($1::text::uuid, $2::text::uuid)",
            &[&q.item_id, &user_id],
        ))
    })?;
    if let Err(e) = taker {
        if db::sqlstate(&e).as_deref() != Some(UNIQUE_VIOLATION) {
            return Err(db::refusal(&e));
        }
        with_client(pool, |c| {
            exec(
                c,
                "DELETE FROM academy.course_survey_responses WHERE id = $1::text::uuid",
                &[&response_id],
            )
        })?;
        return duplicate();
    }
    Ok(Json::obj([
        ("itemId", Json::str(q.item_id.clone())),
        ("anonymous", Json::Bool(anonymous)),
        ("submittedAt", Json::String(iso(now))),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_rules() {
        let rules = vec!["203.0.113.0/24".to_owned(), "2001:db8::/32".to_owned()];
        assert!(address_allowed("203.0.113.7", &rules));
        assert!(address_allowed("::ffff:203.0.113.7", &rules));
        assert!(!address_allowed("198.51.100.1", &rules));
        assert!(address_allowed("2001:db8::1", &rules));
        assert!(rule_of("10.0.0.0/33").is_none());
        assert!(rule_of("10.0.0.0/08").is_none());
        assert!(rule_of("fe80::1%eth0").is_none());
        assert_eq!(unmapped("::FFFF:1.2.3.4"), "1.2.3.4");
        assert!(proxy_rules("10.0.0.1").is_err());
        assert_eq!(
            resolve_address(
                &proxy_rules("10.0.0.0/8").unwrap_or_default(),
                Some("10.1.2.3"),
                Some(" 203.0.113.9 ")
            ),
            Some("203.0.113.9".to_owned())
        );
        assert_eq!(
            resolve_address(&[], Some("10.1.2.3"), Some("203.0.113.9")),
            None
        );
    }

    #[test]
    fn blockers_in_editor_order() {
        assert_eq!(
            publish_blockers("quiz", 0, None, None, None),
            vec![
                "academy.quiz_no_questions",
                "academy.pass_mark_unset",
                "academy.scoring_policy_unset"
            ]
        );
        assert!(publish_blockers("quiz", 1, Some(0), Some(1), None).is_empty());
        assert!(publish_blockers("survey", 1, None, None, None).is_empty());
    }
}
