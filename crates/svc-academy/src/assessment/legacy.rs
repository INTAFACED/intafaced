//! The code-catalogue and staff-published quizzes on curriculum items (`assessment/repository.ts`, `catalog.ts`,
//! `score.ts`, and the `AcademyService` wrappers): `assessment.get`, `start`, `current`, `answer`, `finish`, `review`,
//! `submit`, `attempts` and `admin.setQuiz`.
//!
//! A definition is held as the JSON the TypeScript keeps (`AssessmentDefinition`). The owner's code catalogue is empty
//! (`ASSESSMENT_CATALOG`), so in the running service every quiz is one staff published; a test passes its own.

use std::collections::BTreeSet;

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::{self, Json};
use service_kit::schema::js_trim;

use super::{
    array, cell, exec, field, field_int, field_str, first, int, iso, json_cell, ms, query, refuse,
    serializable, with_client,
};
use crate::curriculum::{gates, spine};
use crate::errors::Refusal;

/// `ASSESSMENT_CATALOG`: no owner-published scored assessment exists in this repo.
pub const CATALOG: &[Json] = &[];

fn s(j: &Json, key: &str) -> String {
    field_str(j, key).unwrap_or("").to_owned()
}

/// `assessmentBySlug(slug, catalog)`.
fn by_slug<'a>(catalog: &'a [Json], slug: &str) -> Option<&'a Json> {
    catalog.iter().find(|d| field_str(d, "slug") == Some(slug))
}

fn opt_num(j: &Json, key: &str) -> Option<i64> {
    field_int(j, key)
}

/// `definition(slug, sql)`: the code catalogue first, then what staff published.
fn definition<C: GenericClient>(
    c: &mut C,
    catalog: &[Json],
    slug: &str,
) -> Result<Option<Json>, Refusal> {
    if let Some(d) = by_slug(catalog, slug) {
        return Ok(Some(d.clone()));
    }
    let row = first(
        c,
        "SELECT slug, definition::text AS definition, pass_mark, attempt_limit, time_limit_seconds, review_mode \
         FROM academy.quizzes WHERE slug = $1",
        &[&slug],
    )?;
    let Some(r) = row else { return Ok(None) };
    let num = |v: Option<i32>| v.map_or(Json::Null, |n| int(i64::from(n)));
    Ok(Some(Json::obj([
        ("slug", Json::String(cell(&r, "slug")?)),
        ("kind", Json::str("quiz")),
        (
            "questions",
            json_cell(&r, "definition")?.unwrap_or(Json::Null),
        ),
        ("passMark", num(cell(&r, "pass_mark")?)),
        ("attemptLimit", num(cell(&r, "attempt_limit")?)),
        ("cooldownSeconds", Json::Null),
        ("timeLimitSeconds", num(cell(&r, "time_limit_seconds")?)),
        ("reviewMode", Json::String(cell(&r, "review_mode")?)),
    ])))
}

fn unpublished<T>(slug: &str) -> Result<T, Refusal> {
    refuse(
        format!("academy.assessment_unpublished slug={slug}"),
        "academy.assessment_unpublished",
    )
}

fn pass_mark_unset<T>(slug: &str) -> Result<T, Refusal> {
    refuse(
        format!("academy.pass_mark_unset slug={slug}"),
        "academy.pass_mark_unset",
    )
}

/// `scoreAssessment(def, answers)`: `(score, maxScore, pass)`.
pub fn score_assessment(
    def: &Json,
    answers: &[(String, String)],
) -> Result<(i64, i64, bool), Refusal> {
    let Some(pass_mark) = opt_num(def, "passMark") else {
        return pass_mark_unset(&s(def, "slug"));
    };
    let questions = array(field(def, "questions"));
    let mut seen = BTreeSet::new();
    for (qid, cid) in answers {
        if !seen.insert(qid.clone()) {
            return refuse(
                format!("duplicate answer for {qid}"),
                "academy.assessment_invalid",
            );
        }
        let fits = questions
            .iter()
            .find(|q| field_str(q, "id") == Some(qid))
            .is_some_and(|q| {
                array(field(q, "choices"))
                    .iter()
                    .any(|c| field_str(c, "id") == Some(cid))
            });
        if !fits {
            return refuse(
                "answer does not match a published question",
                "academy.assessment_invalid",
            );
        }
    }
    let (mut score, mut max) = (0, 0);
    for q in questions {
        let points = opt_num(q, "points").filter(|p| *p >= 1);
        let Some(points) = points
            .filter(|_| matches!(field(q, "points"), Some(Json::Number(n)) if n.fract() == 0.0))
        else {
            return refuse(
                format!("question {} points are not a positive integer", s(q, "id")),
                "academy.assessment_invalid",
            );
        };
        max += points;
        let id = field_str(q, "id");
        if answers.iter().any(|(qid, cid)| {
            Some(qid.as_str()) == id && field_str(q, "correctChoiceId") == Some(cid.as_str())
        }) {
            score += points;
        }
    }
    Ok((score, max, score >= pass_mark))
}

/// `getAssessment(slug)`.
pub fn get(pool: &Store, catalog: &[Json], slug: &str) -> Result<Json, Refusal> {
    let def = with_client(pool, |c| definition(c, catalog, slug))?;
    let Some(def) = def else {
        return unpublished(slug);
    };
    let Some(pass_mark) = opt_num(&def, "passMark") else {
        return pass_mark_unset(slug);
    };
    Ok(Json::obj([
        ("slug", Json::String(s(&def, "slug"))),
        ("kind", field(&def, "kind").cloned().unwrap_or(Json::Null)),
        ("passMark", int(pass_mark)),
        (
            "timeLimitSeconds",
            opt_num(&def, "timeLimitSeconds").map_or(Json::Null, int),
        ),
        (
            "attemptLimit",
            opt_num(&def, "attemptLimit").map_or(Json::Null, int),
        ),
        (
            "reviewMode",
            Json::String(
                field_str(&def, "reviewMode")
                    .unwrap_or("score_only")
                    .to_owned(),
            ),
        ),
        (
            "questions",
            Json::Array(
                array(field(&def, "questions"))
                    .iter()
                    .map(|q| {
                        Json::obj([
                            ("id", field(q, "id").cloned().unwrap_or(Json::Null)),
                            ("prompt", field(q, "prompt").cloned().unwrap_or(Json::Null)),
                            ("kind", field(q, "kind").cloned().unwrap_or(Json::Null)),
                            ("points", field(q, "points").cloned().unwrap_or(Json::Null)),
                            ("choices", choices(q)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

fn choices(q: &Json) -> Json {
    Json::Array(
        array(field(q, "choices"))
            .iter()
            .map(|c| {
                Json::obj([
                    ("id", field(c, "id").cloned().unwrap_or(Json::Null)),
                    ("text", field(c, "text").cloned().unwrap_or(Json::Null)),
                ])
            })
            .collect(),
    )
}

/// `HIDDEN_UNTIL(sql, now)` with `now` as `$NOW`: over `academy.assessment_attempts a LEFT JOIN academy.quizzes q`.
fn hidden_until(now_param: &str) -> String {
    format!(
        "CASE WHEN GREATEST(a.hidden_until, q.results_hidden_until) > {now_param}::text::timestamptz \
         THEN GREATEST(a.hidden_until, q.results_hidden_until) END"
    )
}

fn attempt_row(r: &postgres::Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("slug", Json::String(cell(r, "slug")?)),
        ("score", int(i64::from(cell::<i32>(r, "score")?))),
        ("maxScore", int(i64::from(cell::<i32>(r, "max_score")?))),
        ("pass", Json::Bool(cell(r, "passed")?)),
        ("submittedAt", Json::String(iso(cell(r, "submitted_at")?))),
    ]))
}

fn attempt_sql_columns() -> String {
    format!(
        "slug, score, max_score, passed, {} AS submitted_at",
        ms("submitted_at")
    )
}

/// `attempts(userId, slug, now)`.
pub fn attempts(
    pool: &Store,
    catalog: &[Json],
    user_id: &str,
    slug: &str,
    now: i64,
) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        if definition(c, catalog, slug)?.is_none() {
            return unpublished(slug);
        }
        let rows = query(
            c,
            &format!(
                "SELECT a.slug, a.score, a.max_score, a.passed, {} AS submitted_at, {} AS hidden_until \
                 FROM academy.assessment_attempts a LEFT JOIN academy.quizzes q ON q.slug = a.slug \
                 WHERE a.user_id = $1::text::uuid AND a.slug = $2 AND a.voided_at IS NULL \
                 ORDER BY a.submitted_at DESC, a.client_attempt_id DESC",
                ms("a.submitted_at"),
                ms(&format!("({})", hidden_until("$3")))
            ),
            &[&user_id, &slug, &iso(now)],
        )?;
        let list = rows
            .iter()
            .map(|r| {
                let hidden: Option<i64> = cell(r, "hidden_until")?;
                Ok(match hidden {
                    Some(h) => Json::obj([
                        ("slug", Json::String(cell(r, "slug")?)),
                        ("score", Json::Null),
                        ("maxScore", Json::Null),
                        ("pass", Json::Null),
                        ("submittedAt", Json::String(iso(cell(r, "submitted_at")?))),
                        ("hiddenUntil", Json::String(iso(h))),
                    ]),
                    None => {
                        let mut f = super::fields(&attempt_row(r)?).to_vec();
                        f.push(("hiddenUntil".to_owned(), Json::Null));
                        Json::Object(f)
                    }
                })
            })
            .collect::<Result<Vec<_>, Refusal>>()?;
        Ok(Json::Array(list))
    })
}

/// `assertMayAttempt(tx, def, userId, now)`.
fn assert_may_attempt<C: GenericClient>(
    c: &mut C,
    def: &Json,
    user_id: &str,
    now: i64,
) -> Result<(), Refusal> {
    let slug = s(def, "slug");
    let row = first(
        c,
        &format!(
            "SELECT COUNT(*)::int AS n, {} AS last FROM academy.assessment_attempts \
             WHERE user_id = $1::text::uuid AND slug = $2 AND voided_at IS NULL",
            ms("MAX(submitted_at)")
        ),
        &[&user_id, &slug],
    )?;
    let count = row
        .as_ref()
        .map(|r| cell::<i32>(r, "n"))
        .transpose()?
        .map_or(0, i64::from);
    if let Some(limit) = opt_num(def, "attemptLimit")
        && count >= limit
    {
        return refuse(
            format!("academy.attempt_limit slug={slug} limit={limit}"),
            "academy.attempt_limit",
        );
    }
    let last: Option<i64> = row.as_ref().map(|r| cell(r, "last")).transpose()?.flatten();
    if let (Some(cooldown), Some(last)) = (opt_num(def, "cooldownSeconds"), last)
        && now - last < cooldown * 1000
    {
        return refuse(
            format!("academy.attempt_cooldown slug={slug}"),
            "academy.attempt_cooldown",
        );
    }
    Ok(())
}

fn lock<C: GenericClient>(c: &mut C, user_id: &str) -> Result<(), Refusal> {
    let key = format!("{user_id}:assessment");
    query(
        c,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&key],
    )?;
    Ok(())
}

/// `submit(input)`: one row per `clientAttemptId`; a replay returns that row and does not rescore.
pub fn submit(
    pool: &Store,
    catalog: &[Json],
    user_id: &str,
    slug: &str,
    answers: &[(String, String)],
    client_attempt_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let key = js_trim(client_attempt_id);
    if key.is_empty() {
        return refuse("clientAttemptId is required", "academy.assessment_invalid");
    }
    if key.starts_with("quiz-attempt:") {
        return refuse(
            "academy.request_reused clientAttemptId names a timed attempt",
            "academy.request_reused",
        );
    }
    let select = format!(
        "SELECT {} FROM academy.assessment_attempts WHERE user_id = $1::text::uuid AND client_attempt_id = $2",
        attempt_sql_columns()
    );
    serializable(pool, |tx| {
        lock(tx, user_id)?;
        if let Some(prior) = first(tx, &select, &[&user_id, &key])? {
            return attempt_row(&prior);
        }
        let Some(def) = definition(tx, catalog, slug)? else { return unpublished(slug) };
        let def_slug = s(&def, "slug");
        if by_slug(catalog, &def_slug).is_none() || opt_num(&def, "timeLimitSeconds").is_some() {
            return refuse(format!("academy.attempt_required slug={def_slug} is taken with Start"), "academy.attempt_required");
        }
        if opt_num(&def, "passMark").is_none() {
            return pass_mark_unset(&def_slug);
        }
        if !query(
            tx,
            "SELECT 1 FROM academy.quiz_attempts WHERE user_id = $1::text::uuid AND slug = $2 AND finished_at IS NULL",
            &[&user_id, &def_slug],
        )?
        .is_empty()
        {
            return refuse(format!("academy.attempt_open slug={def_slug}"), "academy.attempt_open");
        }
        assert_may_attempt(tx, &def, user_id, now)?;
        let (score, max, pass) = score_assessment(&def, answers)?;
        let i = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
        let inserted = first(
            tx,
            &format!(
                "INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed, submitted_at) \
                 VALUES ($1::text::uuid, $2, $3, $4::int4, $5::int4, $6::bool, $7::text::timestamptz) \
                 ON CONFLICT (user_id, client_attempt_id) DO NOTHING RETURNING {}",
                attempt_sql_columns()
            ),
            &[&user_id, &def_slug, &key, &i(score), &i(max), &pass, &iso(now)],
        )?;
        if let Some(r) = inserted {
            return attempt_row(&r);
        }
        match first(tx, &select, &[&user_id, &key])? {
            Some(r) => attempt_row(&r),
            None => refuse("attempt insert left no row", "academy.assessment_invalid"),
        }
    })
    // `settleCertificatesNeeding(userId, 'assessment:<slug>')`: no certificate of the owner's catalogue names an
    // assessment, so nothing is settled (see `settle_certificates_needing`).
    .inspect(|_| settle_certificates_needing(&format!("assessment:{slug}")))
}

/// `settleCertificatesNeeding(userId, requirement, now)`: every certificate whose requirements name `requirement` is
/// settled. The owner's catalogue (`CERT_CATALOG`: Foundations, whose requirements are lessons only) names no
/// `assessment:` requirement, so after a quiz there is nothing to settle; a failure there is logged and never refuses.
fn settle_certificates_needing(_requirement: &str) {}

/// A timed attempt row (`AttemptRowSql`).
struct Row {
    id: String,
    user_id: String,
    slug: String,
    number: i32,
    started_at: i64,
    deadline_at: Option<i64>,
    answers: Json,
    finished_at: Option<i64>,
    score: Option<i32>,
    max_score: Option<i32>,
    passed: Option<bool>,
    quiz: Json,
}

fn columns() -> String {
    format!(
        "id::text AS id, user_id::text AS user_id, slug, number, {} AS started_at, {} AS deadline_at, answers::text AS answers, \
         {} AS finished_at, score, max_score, passed, quiz::text AS quiz",
        ms("started_at"),
        ms("deadline_at"),
        ms("finished_at")
    )
}

fn read_row(r: &postgres::Row) -> Result<Row, Refusal> {
    Ok(Row {
        id: cell(r, "id")?,
        user_id: cell(r, "user_id")?,
        slug: cell(r, "slug")?,
        number: cell(r, "number")?,
        started_at: cell(r, "started_at")?,
        deadline_at: cell(r, "deadline_at")?,
        answers: json_cell(r, "answers")?.unwrap_or(Json::Object(Vec::new())),
        finished_at: cell(r, "finished_at")?,
        score: cell(r, "score")?,
        max_score: cell(r, "max_score")?,
        passed: cell(r, "passed")?,
        quiz: json_cell(r, "quiz")?.unwrap_or(Json::Null),
    })
}

/// `attemptView(row, now, hiddenUntil)`.
fn view(row: &Row, now: i64, hidden: Option<i64>) -> Json {
    let open = row.finished_at.is_none();
    let seconds_left = match (open, row.deadline_at) {
        (true, Some(d)) => {
            let ms_left = d - now;
            int((-(-ms_left).div_euclid(1000)).max(0))
        }
        _ => Json::Null,
    };
    let result = match (row.finished_at, hidden) {
        (None, _) => Json::Null,
        (Some(f), Some(h)) => Json::obj([
            ("hidden", Json::Bool(true)),
            ("hiddenUntil", Json::String(iso(h))),
            ("finishedAt", Json::String(iso(f))),
        ]),
        (Some(f), None) => Json::obj([
            ("hidden", Json::Bool(false)),
            ("score", int(i64::from(row.score.unwrap_or(0)))),
            ("maxScore", int(i64::from(row.max_score.unwrap_or(0)))),
            ("pass", Json::Bool(row.passed.unwrap_or(false))),
            ("finishedAt", Json::String(iso(f))),
        ]),
    };
    Json::obj([
        ("attemptId", Json::String(row.id.clone())),
        ("slug", Json::String(row.slug.clone())),
        ("number", int(i64::from(row.number))),
        ("startedAt", Json::String(iso(row.started_at))),
        (
            "deadlineAt",
            row.deadline_at.map_or(Json::Null, |d| Json::String(iso(d))),
        ),
        ("secondsLeft", seconds_left),
        (
            "answers",
            Json::Object(json::js_key_order(super::fields(&row.answers).to_vec())),
        ),
        ("result", result),
    ])
}

/// `finishRow(tx, row, at)`: score the saved answers against the attempt's own copy of the quiz, once.
fn finish_row<C: GenericClient>(c: &mut C, row: &Row, at: i64) -> Result<Row, Refusal> {
    let def = &row.quiz;
    let questions = array(field(def, "questions"));
    let answers: Vec<(String, String)> = super::fields(&row.answers)
        .iter()
        .filter_map(|(q, v)| match v {
            Json::String(cid) => Some((q.clone(), cid.clone())),
            _ => None,
        })
        .filter(|(qid, cid)| {
            questions.iter().any(|q| {
                field_str(q, "id") == Some(qid)
                    && array(field(q, "choices"))
                        .iter()
                        .any(|ch| field_str(ch, "id") == Some(cid))
            })
        })
        .collect();
    let (score, max, pass) = score_assessment(def, &answers)?;
    let finished = match row.deadline_at {
        Some(d) if at > d => d,
        _ => at,
    };
    let i = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let updated = first(
        c,
        &format!(
            "UPDATE academy.quiz_attempts SET finished_at = $1::text::timestamptz, score = $2::int4, max_score = $3::int4, passed = $4::bool \
             WHERE id = $5::text::uuid RETURNING {}",
            columns()
        ),
        &[&iso(finished), &i(score), &i(max), &pass, &row.id],
    )?
    .ok_or_else(|| Refusal::db("the update returned no row", None))?;
    exec(
        c,
        "INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed, submitted_at, hidden_until) \
         VALUES ($1::text::uuid, $2, $3, $4::int4, $5::int4, $6::bool, $7::text::timestamptz, \
                 (SELECT results_hidden_until FROM academy.quizzes WHERE slug = $2)) \
         ON CONFLICT (user_id, client_attempt_id) DO NOTHING",
        &[
            &row.user_id,
            &row.slug,
            &format!("quiz-attempt:{}", row.id),
            &i(score),
            &i(max),
            &pass,
            &iso(finished),
        ],
    )?;
    read_row(&updated)
}

/// `settleOpen(tx, userId, slug, now)`: the open attempt, unless its deadline has passed.
fn settle_open<C: GenericClient>(
    c: &mut C,
    user_id: &str,
    slug: &str,
    now: i64,
) -> Result<Option<Row>, Refusal> {
    let open = first(
        c,
        &format!(
            "SELECT {} FROM academy.quiz_attempts WHERE user_id = $1::text::uuid AND slug = $2 AND finished_at IS NULL",
            columns()
        ),
        &[&user_id, &slug],
    )?;
    let Some(open) = open.map(|r| read_row(&r)).transpose()? else {
        return Ok(None);
    };
    if let Some(d) = open.deadline_at
        && now >= d
    {
        finish_row(c, &open, d)?;
        return Ok(None);
    }
    Ok(Some(open))
}

/// `attemptHiddenUntil(sql, userId, attemptId, now)`.
fn attempt_hidden_until<C: GenericClient>(
    c: &mut C,
    user_id: &str,
    attempt_id: &str,
    now: i64,
) -> Result<Option<i64>, Refusal> {
    let row = first(
        c,
        &format!(
            "SELECT {} AS until FROM academy.assessment_attempts a LEFT JOIN academy.quizzes q ON q.slug = a.slug \
             WHERE a.user_id = $1::text::uuid AND a.client_attempt_id = $2",
            ms(&format!("({})", hidden_until("$3")))
        ),
        &[&user_id, &format!("quiz-attempt:{attempt_id}"), &iso(now)],
    )?;
    Ok(row
        .map(|r| cell::<Option<i64>>(&r, "until"))
        .transpose()?
        .flatten())
}

/// `startQuizAttempt(input)`: the learner's path access first, then Start (or resume) a timed attempt.
pub fn start(
    pool: &Store,
    catalog: &[Json],
    user_id: &str,
    slug: &str,
    now: i64,
) -> Result<Json, Refusal> {
    if let Some(item) = spine::get(js_trim(slug))
        && !item.path.is_empty()
    {
        gates::assert_access(pool.pool()?, user_id, &item.path, now)?;
    }
    serializable(pool, |tx| {
        lock(tx, user_id)?;
        if let Some(open) = settle_open(tx, user_id, slug, now)? {
            return Ok(view(&open, now, None));
        }
        let Some(def) = definition(tx, catalog, slug)? else {
            return unpublished(slug);
        };
        let def_slug = s(&def, "slug");
        if opt_num(&def, "passMark").is_none() {
            return pass_mark_unset(&def_slug);
        }
        assert_may_attempt(tx, &def, user_id, now)?;
        let next: i32 = cell(
            &super::one(
                tx,
                "SELECT COALESCE(MAX(number), 0)::int + 1 AS next FROM academy.quiz_attempts WHERE user_id = $1::text::uuid AND slug = $2",
                &[&user_id, &def_slug],
            )?,
            "next",
        )?;
        let deadline = opt_num(&def, "timeLimitSeconds").map(|l| iso(now + l * 1000));
        let row = first(
            tx,
            &format!(
                "INSERT INTO academy.quiz_attempts (user_id, slug, number, started_at, deadline_at, quiz) \
                 VALUES ($1::text::uuid, $2, $3::int4, $4::text::timestamptz, $5::text::timestamptz, $6::text::jsonb) RETURNING {}",
                columns()
            ),
            &[&user_id, &def_slug, &next, &iso(now), &deadline, &def.compact()],
        )?
        .ok_or_else(|| Refusal::db("the insert returned no row", None))?;
        Ok(view(&read_row(&row)?, now, None))
    })
}

/// `current(input)`.
pub fn current(pool: &Store, user_id: &str, slug: &str, now: i64) -> Result<Json, Refusal> {
    serializable(pool, |tx| {
        lock(tx, user_id)?;
        Ok(settle_open(tx, user_id, slug, now)?.map_or(Json::Null, |o| view(&o, now, None)))
    })
}

/// `attemptSlug(userId, attemptId)`.
fn attempt_slug(pool: &Store, user_id: &str, attempt_id: &str) -> Result<String, Refusal> {
    let row = with_client(pool, |c| {
        first(
            c,
            "SELECT slug FROM academy.quiz_attempts WHERE id = $1::text::uuid AND user_id = $2::text::uuid",
            &[&attempt_id, &user_id],
        )
    })?;
    match row {
        Some(r) => cell(&r, "slug"),
        None => refuse("academy.attempt_not_found", "academy.attempt_not_found"),
    }
}

/// `answer(input)`: save one answer on the caller's open attempt.
pub fn answer(
    pool: &Store,
    user_id: &str,
    attempt_id: &str,
    question_id: &str,
    choice_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let slug = attempt_slug(pool, user_id, attempt_id)?;
    serializable(pool, |tx| {
        lock(tx, user_id)?;
        let open = settle_open(tx, user_id, &slug, now)?;
        let Some(open) = open.filter(|o| o.id == attempt_id) else {
            return refuse(
                "academy.attempt_closed this attempt is finished",
                "academy.attempt_closed",
            );
        };
        let fits = array(field(&open.quiz, "questions"))
            .iter()
            .find(|q| field_str(q, "id") == Some(question_id))
            .is_some_and(|q| {
                array(field(q, "choices"))
                    .iter()
                    .any(|c| field_str(c, "id") == Some(choice_id))
            });
        if !fits {
            return refuse(
                "answer does not match a published question",
                "academy.assessment_invalid",
            );
        }
        let patch = Json::Object(vec![(question_id.to_owned(), Json::str(choice_id))]);
        let row = first(
            tx,
            &format!("UPDATE academy.quiz_attempts SET answers = answers || $1::text::jsonb WHERE id = $2::text::uuid RETURNING {}", columns()),
            &[&patch.compact(), &open.id],
        )?
        .ok_or_else(|| Refusal::db("the update returned no row", None))?;
        Ok(view(&read_row(&row)?, now, None))
    })
}

/// `finishQuizAttempt(input)`: score the saved answers once; finishing again answers with the same result.
pub fn finish(pool: &Store, user_id: &str, attempt_id: &str, now: i64) -> Result<Json, Refusal> {
    attempt_slug(pool, user_id, attempt_id)?;
    let out = serializable(pool, |tx| {
        lock(tx, user_id)?;
        let row = first(
            tx,
            &format!("SELECT {} FROM academy.quiz_attempts WHERE id = $1::text::uuid AND user_id = $2::text::uuid", columns()),
            &[&attempt_id, &user_id],
        )?
        .ok_or_else(|| Refusal::Internal { message: "Cannot read properties of undefined (reading 'finished_at')".into(), code: None })?;
        let row = read_row(&row)?;
        let finished = if row.finished_at.is_some() {
            row
        } else {
            finish_row(tx, &row, now)?
        };
        let hidden = attempt_hidden_until(tx, user_id, &finished.id, now)?;
        Ok(view(&finished, now, hidden))
    })?;
    if let Some(slug) = field_str(&out, "slug") {
        settle_certificates_needing(&format!("assessment:{slug}"));
    }
    Ok(out)
}

/// `review(input)`: a finished attempt of the caller's own, against the key or the score only.
pub fn review(pool: &Store, user_id: &str, attempt_id: &str, now: i64) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let row = first(
            c,
            &format!(
                "SELECT {} FROM academy.quiz_attempts WHERE id = $1::text::uuid AND user_id = $2::text::uuid",
                columns()
            ),
            &[&attempt_id, &user_id],
        )?;
        let Some(row) = row.map(|r| read_row(&r)).transpose()? else {
            return refuse("academy.attempt_not_found", "academy.attempt_not_found");
        };
        let Some(finished_at) = row.finished_at else {
            return refuse(
                "academy.attempt_open finish the attempt to review it",
                "academy.attempt_open",
            );
        };
        if let Some(h) = attempt_hidden_until(c, user_id, &row.id, now)? {
            return refuse(
                format!("academy.grades_hidden until={}", iso(h)),
                "academy.grades_hidden",
            );
        }
        let mode = field_str(&row.quiz, "reviewMode")
            .unwrap_or("score_only")
            .to_owned();
        let questions = if mode == "score_only" {
            Json::Null
        } else {
            Json::Array(
                array(field(&row.quiz, "questions"))
                    .iter()
                    .map(|q| {
                        let chosen = field_str(q, "id")
                            .and_then(|id| field_str(&row.answers, id))
                            .map(str::to_owned);
                        let correct = field_str(q, "correctChoiceId").map(str::to_owned);
                        Json::obj([
                            ("id", field(q, "id").cloned().unwrap_or(Json::Null)),
                            ("prompt", field(q, "prompt").cloned().unwrap_or(Json::Null)),
                            ("choices", choices(q)),
                            (
                                "chosenChoiceId",
                                chosen.clone().map_or(Json::Null, Json::String),
                            ),
                            (
                                "correctChoiceId",
                                correct.clone().map_or(Json::Null, Json::String),
                            ),
                            ("correct", Json::Bool(chosen.is_some() && chosen == correct)),
                        ])
                    })
                    .collect(),
            )
        };
        Ok(Json::obj([
            ("attemptId", Json::String(row.id.clone())),
            ("slug", Json::String(row.slug.clone())),
            ("number", int(i64::from(row.number))),
            ("score", int(i64::from(row.score.unwrap_or(0)))),
            ("maxScore", int(i64::from(row.max_score.unwrap_or(0)))),
            ("pass", Json::Bool(row.passed.unwrap_or(false))),
            ("finishedAt", Json::String(iso(finished_at))),
            ("reviewMode", Json::String(mode)),
            ("questions", questions),
        ]))
    })
}

fn invalid<T>(message: String) -> Result<T, Refusal> {
    refuse(
        format!("academy.assessment_invalid {message}"),
        "academy.assessment_invalid",
    )
}

fn whole(j: Option<&Json>) -> Option<i64> {
    match j {
        Some(Json::Number(n)) if n.fract() == 0.0 => super::num(&Json::Number(*n)),
        _ => None,
    }
}

/// `assertAssessmentCatalog([definition], lesson)` for one staff definition, as `academy.assessment_invalid`.
fn check_definition(def: &Json) -> Result<(), Refusal> {
    let slug = s(def, "slug");
    if slug.is_empty() {
        return invalid("duplicate or blank assessment slug: (blank)".to_owned());
    }
    if !spine::has(&slug) {
        return invalid(format!("assessment {slug} is not a curriculum lesson"));
    }
    let questions = array(field(def, "questions"));
    if questions.is_empty() {
        return invalid(format!("assessment {slug} has no questions"));
    }
    let total: i64 = questions
        .iter()
        .map(|q| field_int(q, "points").unwrap_or(0))
        .sum();
    if let Some(pm) = field(def, "passMark").filter(|p| !matches!(p, Json::Null)) {
        let Some(pm) = whole(Some(pm)).filter(|p| *p >= 0) else {
            return invalid(format!(
                "assessment {slug} pass mark is not a non-negative integer"
            ));
        };
        if pm > total {
            return invalid(format!(
                "assessment {slug} pass mark is more than the questions' points, so no one could pass"
            ));
        }
    }
    if field(def, "attemptLimit").is_some_and(|v| !matches!(v, Json::Null))
        && whole(field(def, "attemptLimit")).is_none_or(|n| n < 1)
    {
        return invalid(format!(
            "assessment {slug} attempt limit is not a positive integer"
        ));
    }
    if field(def, "timeLimitSeconds").is_some_and(|v| !matches!(v, Json::Null))
        && whole(field(def, "timeLimitSeconds")).is_none_or(|n| n < 1)
    {
        return invalid(format!(
            "assessment {slug} time limit is not a positive integer"
        ));
    }
    let mut ids = BTreeSet::new();
    for q in questions {
        let id = s(q, "id");
        if id.is_empty() || !ids.insert(id.clone()) {
            return invalid(format!(
                "assessment {slug} has a blank or duplicate question id"
            ));
        }
        if js_trim(&s(q, "prompt")).is_empty() {
            return invalid(format!(
                "assessment {slug} question {id} is not a single-choice prompt"
            ));
        }
        if whole(field(q, "points")).is_none_or(|p| p < 1) {
            return invalid(format!(
                "assessment {slug} question {id} points are not a positive integer"
            ));
        }
        let cs = array(field(q, "choices"));
        if cs.len() < 2 {
            return invalid(format!(
                "assessment {slug} question {id} needs at least two choices"
            ));
        }
        let mut choice_ids = BTreeSet::new();
        for c in cs {
            let cid = s(c, "id");
            if cid.is_empty() || !choice_ids.insert(cid) || js_trim(&s(c, "text")).is_empty() {
                return invalid(format!(
                    "assessment {slug} question {id} has a blank choice"
                ));
            }
        }
        if !choice_ids.contains(&s(q, "correctChoiceId")) {
            return invalid(format!(
                "assessment {slug} question {id} correct choice is not one of the choices"
            ));
        }
    }
    Ok(())
}

/// `setQuiz(input)`: staff publish the quiz on one item, or take it down with `quiz: null`.
pub fn set_quiz(
    pool: &Store,
    catalog: &[Json],
    slug_in: &str,
    quiz: Option<&Json>,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let slug = js_trim(slug_in).to_owned();
    if !spine::has(&slug) {
        return refuse("Unknown curriculum item", "academy.curriculum_not_found");
    }
    if by_slug(catalog, &slug).is_some() {
        return refuse(
            format!("academy.assessment_invalid {slug} is published in the code catalog"),
            "academy.assessment_invalid",
        );
    }
    let Some(quiz) = quiz.filter(|q| !matches!(q, Json::Null)) else {
        with_client(pool, |c| {
            exec(c, "DELETE FROM academy.quizzes WHERE slug = $1", &[&slug])
        })?;
        return Ok(Json::obj([
            ("slug", Json::String(slug)),
            ("published", Json::Bool(false)),
        ]));
    };
    let questions: Vec<Json> = array(field(quiz, "questions"))
        .iter()
        .map(|q| {
            Json::obj([
                ("id", field(q, "id").cloned().unwrap_or(Json::Null)),
                ("prompt", field(q, "prompt").cloned().unwrap_or(Json::Null)),
                ("kind", Json::str("single")),
                ("points", field(q, "points").cloned().unwrap_or(Json::Null)),
                ("choices", choices(q)),
                (
                    "correctChoiceId",
                    field(q, "correctChoiceId").cloned().unwrap_or(Json::Null),
                ),
            ])
        })
        .collect();
    let get = |k: &str| field(quiz, k).cloned().unwrap_or(Json::Null);
    let def = Json::obj([
        ("slug", Json::String(slug.clone())),
        ("kind", Json::str("quiz")),
        ("passMark", get("passMark")),
        ("attemptLimit", get("attemptLimit")),
        ("cooldownSeconds", Json::Null),
        ("timeLimitSeconds", get("timeLimitSeconds")),
        ("reviewMode", get("reviewMode")),
        ("questions", Json::Array(questions.clone())),
    ]);
    check_definition(&def)?;
    let n = |k: &str| field_int(quiz, k).map(|v| i32::try_from(v).unwrap_or(i32::MAX));
    let hidden = field_str(quiz, "resultsHiddenUntil")
        .filter(|h| !h.is_empty())
        .map(str::to_owned);
    let review_mode = field_str(quiz, "reviewMode").unwrap_or("").to_owned();
    with_client(pool, |c| {
        exec(
            c,
            "INSERT INTO academy.quizzes (slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode, reason, set_by, set_at, \
                                          results_hidden_until) \
             VALUES ($1, $2::text::jsonb, $3::int4, $4::int4, $5::int4, $6, $7, $8::text::uuid, $9::text::timestamptz, $10::text::timestamptz) \
             ON CONFLICT (slug) DO UPDATE SET \
               definition = EXCLUDED.definition, pass_mark = EXCLUDED.pass_mark, attempt_limit = EXCLUDED.attempt_limit, \
               time_limit_seconds = EXCLUDED.time_limit_seconds, review_mode = EXCLUDED.review_mode, \
               reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at, \
               results_hidden_until = EXCLUDED.results_hidden_until",
            &[
                &slug,
                &Json::Array(questions).compact(),
                &n("passMark"),
                &n("attemptLimit"),
                &n("timeLimitSeconds"),
                &review_mode,
                &js_trim(reason),
                &operator,
                &iso(now),
                &hidden,
            ],
        )
    })?;
    Ok(Json::obj([
        ("slug", Json::String(slug)),
        ("published", Json::Bool(true)),
    ]))
}
