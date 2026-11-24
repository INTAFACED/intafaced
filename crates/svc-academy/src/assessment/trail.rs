//! Score changes after a quiz attempt is graded: key fixes, rescores, overrides and curves
//! (`curriculum/course-quiz-trail.ts`).
//!
//! An attempt row stays as the learner finished it; every later change is an event in its score trail, numbered per
//! attempt, and the score shown is the newest event's. A key fix is a new revision that changes only keys; a rescore
//! applies the current keys where they change the points (`rescore:<attempt>:<revision>`); an override sets one
//! question's points (`override:<attempt>:<question>:<n>`); a curve file sets learners' totals, whole or not at all.

use std::collections::{BTreeMap, BTreeSet};

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::Json;

use super::csv::{BadRow, read_curve_file};
use super::quizzes::{questions_of, record_event};
use super::score::{self, score_question};
use super::{
    array, begin, canonical, cell, exec, field, fields, first, int, iso, json_cell, json_of, ms,
    num, opt_int, opt_str, query, refuse, sha256_hex, with_client, with_key,
};
use crate::errors::Refusal;

/// The points entry a curve keeps its difference under.
pub const CURVE_ENTRY: &str = "~curve";

/// An event of the score trail (`EventRow`).
#[derive(Debug, Clone)]
pub struct Event {
    pub attempt_id: String,
    pub n: i32,
    pub kind: String,
    pub question_id: Option<String>,
    pub revision: Option<i32>,
    pub points: Json,
    pub keys: Json,
    pub previous_score: i32,
    pub score: i32,
    pub passed: bool,
    pub comment: Option<String>,
    pub reason: String,
    pub actor: String,
    pub at: i64,
}

/// `SELECT *` of an event, as typed columns.
pub fn event_columns(prefix: &str) -> String {
    let p = prefix;
    format!(
        "{p}attempt_id::text AS attempt_id, {p}n, {p}kind, {p}question_id, {p}revision, {p}points::text AS points, \
         {p}keys::text AS keys, {p}previous_score, {p}score, {p}passed, {p}comment, {p}reason, {p}actor::text AS actor, \
         {} AS at",
        ms(&format!("{p}at"))
    )
}

impl Event {
    pub fn read(r: &postgres::Row) -> Result<Event, Refusal> {
        Ok(Event {
            attempt_id: cell(r, "attempt_id")?,
            n: cell(r, "n")?,
            kind: cell(r, "kind")?,
            question_id: cell(r, "question_id")?,
            revision: cell(r, "revision")?,
            points: json_of(r, "points")?,
            keys: json_of(r, "keys")?,
            previous_score: cell(r, "previous_score")?,
            score: cell(r, "score")?,
            passed: cell(r, "passed")?,
            comment: cell(r, "comment")?,
            reason: cell(r, "reason")?,
            actor: cell(r, "actor")?,
            at: cell(r, "at")?,
        })
    }
}

/// `effectiveScoreSql`: the newest event's score, else the attempt's own. The attempts table is `t`.
pub const EFFECTIVE_SCORE: &str = "coalesce((SELECT e.score FROM academy.course_quiz_score_events e WHERE e.attempt_id = t.id ORDER BY e.n DESC LIMIT 1), t.score)";

/// `newestEvents(sql, attemptIds)`.
pub fn newest_events<C: GenericClient>(
    c: &mut C,
    ids: &[String],
) -> Result<BTreeMap<String, Event>, Refusal> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let rows = query(
        c,
        &format!(
            "SELECT DISTINCT ON (attempt_id) {} FROM academy.course_quiz_score_events \
             WHERE attempt_id = ANY($1::text[]::uuid[]) ORDER BY attempt_id, n DESC",
            event_columns("")
        ),
        &[&ids],
    )?;
    rows.iter()
        .map(|r| Event::read(r).map(|e| (e.attempt_id.clone(), e)))
        .collect()
}

/// `keyOf(q)`: a question's key fields.
pub fn key_of(q: &Json) -> Json {
    let get = |k: &str| field(q, k).cloned().unwrap_or(Json::Null);
    match score::kind(q) {
        "single" => Json::obj([("correctChoiceId", get("correctChoiceId"))]),
        "multi" => Json::obj([("correctChoiceIds", get("correctChoiceIds"))]),
        "numeric" => Json::obj([("answer", get("answer")), ("tolerance", get("tolerance"))]),
        _ => Json::Object(Vec::new()),
    }
}

fn has_key(q: &Json) -> bool {
    let set = |k: &str| !matches!(field(q, k), None | Some(Json::Null));
    match score::kind(q) {
        "essay" => true,
        "single" => set("correctChoiceId"),
        "multi" => set("correctChoiceIds"),
        _ => set("answer"),
    }
}

fn without_key(q: &Json) -> Json {
    let key = key_of(q);
    let drop: BTreeSet<&str> = fields(&key).iter().map(|(k, _)| k.as_str()).collect();
    Json::Object(
        fields(q)
            .iter()
            .filter(|(k, _)| !drop.contains(k.as_str()))
            .cloned()
            .collect(),
    )
}

/// `checkKeyFix(was, next)`: the same questions in order with only keys changed; the ids whose key changed.
pub fn check_key_fix(was: &[Json], next: &[Json]) -> Result<Vec<String>, Refusal> {
    if was.len() != next.len() {
        return refuse(
            "a key fix keeps every question; add or take one away in a new quiz",
            "academy.key_fix_invalid",
        );
    }
    let mut changed = Vec::new();
    for (i, (old, q)) in was.iter().zip(next).enumerate() {
        if canonical(&without_key(old)) != canonical(&without_key(q)) {
            return refuse(
                format!(
                    "question {} changes more than its key; a key fix changes only keys",
                    i + 1
                ),
                "academy.key_fix_invalid",
            );
        }
        if !has_key(q) {
            return refuse(
                format!("question {} has no key; a key fix sets one", i + 1),
                "academy.key_fix_invalid",
            );
        }
        if canonical(&key_of(old)) != canonical(&key_of(q)) {
            changed.push(score::id(q).to_owned());
        }
    }
    if changed.is_empty() {
        return refuse("no key changed", "academy.key_fix_invalid");
    }
    Ok(changed)
}

/// The parts of an attempt the trail reads.
pub struct TrailAttempt {
    pub id: String,
    pub user_id: String,
    pub number: i32,
    pub finished_at: i64,
    pub state: String,
    pub quiz: Json,
    pub answers: Json,
    pub essay_points: Option<Json>,
    pub score: Option<i32>,
    pub max_score: Option<i32>,
    pub passed: Option<bool>,
    pub alias: i32,
}

impl TrailAttempt {
    pub fn questions(&self) -> &[Json] {
        array(field(&self.quiz, "questions"))
    }

    pub fn pass_mark(&self) -> i64 {
        super::field_int(&self.quiz, "passMark").unwrap_or(0)
    }
}

pub const TRAIL_COLUMNS: &str = "t.id::text AS id, t.item_id::text AS item_id, t.user_id::text AS user_id, t.number, \
    floor(extract(epoch from t.finished_at) * 1000)::int8 AS finished_at, t.state, t.quiz::text AS quiz, \
    t.answers::text AS answers, t.essay_points::text AS essay_points, t.score, t.max_score, t.passed";

/// `ALIASES(itemId)`: each learner's per-quiz alias, by first start then account (the item is `$1`).
const ALIASES: &str = "SELECT user_id, row_number() OVER (ORDER BY min(started_at), user_id)::int AS alias \
    FROM academy.course_quiz_attempts WHERE item_id = $1::text::uuid GROUP BY user_id";

pub fn read_trail(r: &postgres::Row, with_alias: bool) -> Result<TrailAttempt, Refusal> {
    Ok(TrailAttempt {
        id: cell(r, "id")?,
        user_id: cell(r, "user_id")?,
        number: cell(r, "number")?,
        finished_at: cell::<Option<i64>>(r, "finished_at")?.unwrap_or(0),
        state: cell(r, "state")?,
        quiz: json_of(r, "quiz")?,
        answers: json_of(r, "answers")?,
        essay_points: json_cell(r, "essay_points")?,
        score: cell(r, "score")?,
        max_score: cell(r, "max_score")?,
        passed: cell(r, "passed")?,
        alias: if with_alias { cell(r, "alias")? } else { 0 },
    })
}

/// `finishedPoints(attempt)`.
pub fn finished_points(questions: &[Json], answers: &Json, essay_points: Option<&Json>) -> Json {
    let mut out: Vec<(String, Json)> = Vec::new();
    for q in questions {
        let id = score::id(q);
        let p = score_question(q, answers.get(id))
            .or_else(|| essay_points.and_then(|e| e.get(id)).and_then(num))
            .unwrap_or(0);
        out = with_key(out, id, Json::int(p));
    }
    Json::Object(service_kit::json::js_key_order(out))
}

/// `finishedKeys(attempt)`.
pub fn finished_keys(questions: &[Json]) -> Json {
    let mut out: Vec<(String, Json)> = Vec::new();
    for q in questions {
        out = with_key(out, score::id(q), key_of(q));
    }
    Json::Object(service_kit::json::js_key_order(out))
}

fn set_key(obj: &Json, key: &str, value: Json) -> Json {
    Json::Object(service_kit::json::js_key_order(with_key(
        fields(obj).to_vec(),
        key,
        value,
    )))
}

/// `rescoredPoints(attempt, points, keys, current)`.
pub fn rescored_points(
    questions: &[Json],
    answers: &Json,
    points: &Json,
    keys: &Json,
    current: &[Json],
) -> (Json, Json) {
    let mut out_points = points.clone();
    let mut out_keys = keys.clone();
    for q in questions {
        let id = score::id(q);
        let Some(now) = current.iter().find(|c| score::id(c) == id) else {
            continue;
        };
        if score::kind(now) != score::kind(q) || score::kind(q) == "essay" {
            continue;
        }
        let key = key_of(now);
        let was = keys.get(id).cloned().unwrap_or_else(|| key_of(q));
        if canonical(&was) == canonical(&key) {
            continue;
        }
        let mut merged = fields(q).to_vec();
        for (k, v) in fields(&key) {
            merged = with_key(merged, k, v.clone());
        }
        let p = score_question(&Json::Object(merged), answers.get(id)).unwrap_or(0);
        out_points = set_key(&out_points, id, Json::int(p));
        out_keys = set_key(&out_keys, id, key);
    }
    (out_points, out_keys)
}

/// `onOlderKeys(attempt, keys, current)`.
pub fn on_older_keys(questions: &[Json], keys: &Json, current: &[Json]) -> bool {
    questions.iter().any(|q| {
        let id = score::id(q);
        current
            .iter()
            .find(|c| score::id(c) == id)
            .is_some_and(|now| {
                score::kind(now) == score::kind(q)
                    && score::kind(q) != "essay"
                    && canonical(&keys.get(id).cloned().unwrap_or_else(|| key_of(q)))
                        != canonical(&key_of(now))
            })
    })
}

fn total(points: &Json) -> i64 {
    fields(points)
        .iter()
        .map(|(_, v)| num(v).unwrap_or(0))
        .sum()
}

/// `scoreOf(points, maxScore)`: the sum held to 0 and the maximum.
pub fn score_of(points: &Json, max_score: Option<i32>) -> i64 {
    total(points)
        .max(0)
        .min(max_score.map_or(9_007_199_254_740_991, i64::from))
}

fn i32_of(n: i64) -> i32 {
    i32::try_from(n).unwrap_or(i32::MAX)
}

fn bad_json(b: &BadRow) -> Json {
    Json::obj([
        ("line", Json::int(i64::try_from(b.line).unwrap_or(0))),
        (
            "alias",
            b.alias.map_or(Json::Null, |a| Json::int(i64::from(a))),
        ),
        ("code", Json::str(b.code.clone())),
        ("message", Json::str(b.message.clone())),
    ])
}

fn row_json(line: i64, alias: i64, number: i64, from: i64, to: i64) -> Json {
    Json::obj([
        ("line", Json::int(line)),
        ("alias", Json::int(alias)),
        ("number", Json::int(number)),
        ("from", Json::int(from)),
        ("to", Json::int(to)),
    ])
}

/// `curve(input)`.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's fields, as the TypeScript takes them"
)]
pub fn curve(
    pool: &Store,
    max_bytes: Option<i64>,
    item_id: &str,
    file_name: &str,
    csv: &str,
    dry_run: bool,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let Some(max) = max_bytes else {
        return refuse(
            "the owner has not set how large a curve file may be",
            "academy.bulk_limit_unset",
        );
    };
    let bytes = i64::try_from(csv.len()).unwrap_or(i64::MAX);
    if bytes > max {
        return refuse(
            format!("the file is {bytes} bytes; the limit is {max}"),
            "academy.bulk_file_too_large",
        );
    }
    let sha = sha256_hex(csv.as_bytes());
    let (rows, bad) = read_curve_file(csv)?;
    begin(pool, |tx| {
        let quiz = first(
            tx,
            "SELECT kind FROM academy.course_quizzes WHERE item_id = $1::text::uuid FOR UPDATE",
            &[&item_id],
        )?;
        let kind: Option<String> = quiz.map(|q| cell(&q, "kind")).transpose()?;
        if kind.as_deref() != Some("quiz") {
            return refuse("no graded quiz with that id", "academy.quiz_not_found");
        }
        let base = |repeated: bool, applied: bool, rows: Vec<Json>, rejected: Vec<Json>| {
            Json::obj([
                ("sha256", Json::str(sha.clone())),
                ("fileName", Json::str(file_name)),
                ("dryRun", Json::Bool(dry_run)),
                ("repeated", Json::Bool(repeated)),
                ("applied", Json::Bool(applied)),
                ("rows", Json::Array(rows)),
                ("rejected", Json::Array(rejected)),
            ])
        };
        let prior = query(
            tx,
            &format!(
                "SELECT e.file_line AS line, a.alias, t.number, e.previous_score AS from, e.score AS to \
                 FROM academy.course_quiz_score_events e \
                 JOIN academy.course_quiz_attempts t ON t.id = e.attempt_id \
                 JOIN ({ALIASES}) a ON a.user_id = t.user_id \
                 WHERE t.item_id = $1::text::uuid AND e.kind = 'curve' AND e.file_sha256 = $2 \
                 ORDER BY e.file_line"
            ),
            &[&item_id, &sha],
        )?;
        if !prior.is_empty() {
            let rows = prior
                .iter()
                .map(|r| {
                    Ok(row_json(
                        i64::from(cell::<i32>(r, "line")?),
                        i64::from(cell::<i32>(r, "alias")?),
                        i64::from(cell::<i32>(r, "number")?),
                        i64::from(cell::<i32>(r, "from")?),
                        i64::from(cell::<i32>(r, "to")?),
                    ))
                })
                .collect::<Result<Vec<_>, Refusal>>()?;
            return Ok(base(true, false, rows, Vec::new()));
        }
        let newest = query(
            tx,
            &format!(
                "SELECT DISTINCT ON (t.user_id) {TRAIL_COLUMNS}, a.alias FROM academy.course_quiz_attempts t \
                 JOIN ({ALIASES}) a USING (user_id) \
                 WHERE t.item_id = $1::text::uuid AND t.state <> 'open' \
                 ORDER BY t.user_id, t.number DESC"
            ),
            &[&item_id],
        )?
        .iter()
        .map(|r| read_trail(r, true))
        .collect::<Result<Vec<_>, _>>()?;
        let ids: Vec<String> = newest.iter().map(|a| a.id.clone()).collect();
        let events = newest_events(tx, &ids)?;
        let mut rejected: Vec<BadRow> = bad.clone();
        let mut planned: Vec<(&super::csv::CurveRow, &TrailAttempt, i64)> = Vec::new();
        for row in &rows {
            let attempt = newest
                .iter()
                .find(|a| i64::from(a.alias) == i64::from(row.alias));
            let mut refuse_row = |code: &str, message: String| {
                rejected.push(BadRow {
                    line: row.line,
                    alias: Some(row.alias),
                    code: code.to_owned(),
                    message,
                });
            };
            match attempt {
                None => refuse_row(
                    "academy.attempt_not_found",
                    format!("no Learner {} took this quiz", row.alias),
                ),
                Some(a) if a.state != "graded" => {
                    refuse_row(
                        "academy.attempt_closed",
                        format!(
                            "Learner {}'s newest attempt waits for an essay score",
                            row.alias
                        ),
                    );
                }
                Some(a) if row.score > i64::from(a.max_score.unwrap_or(0)) => refuse_row(
                    "academy.assessment_invalid",
                    format!(
                        "a score of {} is above the {} the attempt is out of",
                        row.score,
                        a.max_score
                            .map_or_else(|| "null".to_owned(), |m| m.to_string())
                    ),
                ),
                Some(a) => {
                    let from = events
                        .get(&a.id)
                        .map_or(i64::from(a.score.unwrap_or(0)), |e| i64::from(e.score));
                    planned.push((row, a, from));
                }
            }
        }
        rejected.sort_by_key(|b| b.line);
        let mut listed: Vec<(usize, Json)> = planned
            .iter()
            .map(|(row, a, from)| {
                (
                    row.line,
                    row_json(
                        i64::try_from(row.line).unwrap_or(0),
                        i64::from(row.alias),
                        i64::from(a.number),
                        *from,
                        row.score,
                    ),
                )
            })
            .collect();
        listed.sort_by_key(|(l, _)| *l);
        if dry_run {
            return Ok(base(
                false,
                false,
                listed.into_iter().map(|(_, j)| j).collect(),
                rejected.iter().map(bad_json).collect(),
            ));
        }
        if !rejected.is_empty() {
            return refuse(
                format!(
                    "{} row(s) of this file are refused; a curve applies whole, so run the dry run and correct them",
                    rejected.len()
                ),
                "academy.bulk_file_invalid",
            );
        }
        let mut changing = planned.clone();
        changing.sort_by(|a, b| a.1.id.encode_utf16().cmp(b.1.id.encode_utf16()));
        for (_, a, _) in &changing {
            query(
                tx,
                "SELECT 1 FROM academy.course_quiz_attempts WHERE id = $1::text::uuid FOR UPDATE",
                &[&a.id],
            )?;
        }
        let locked_ids: Vec<String> = changing.iter().map(|(_, a, _)| a.id.clone()).collect();
        let locked = newest_events(tx, &locked_ids)?;
        let mut applied: Vec<(usize, Json)> = Vec::new();
        for (row, a, _) in &changing {
            let last = locked.get(&a.id);
            let from = last.map_or(i64::from(a.score.unwrap_or(0)), |e| i64::from(e.score));
            applied.push((
                row.line,
                row_json(
                    i64::try_from(row.line).unwrap_or(0),
                    i64::from(row.alias),
                    i64::from(a.number),
                    from,
                    row.score,
                ),
            ));
            if from == row.score {
                continue;
            }
            let before = last.map_or_else(
                || finished_points(a.questions(), &a.answers, a.essay_points.as_ref()),
                |e| e.points.clone(),
            );
            let questions = Json::Object(
                fields(&before)
                    .iter()
                    .filter(|(k, _)| k != CURVE_ENTRY)
                    .cloned()
                    .collect(),
            );
            let points = set_key(
                &questions,
                CURVE_ENTRY,
                Json::int(row.score - total(&questions)),
            );
            let keys = last.map_or_else(|| finished_keys(a.questions()), |e| e.keys.clone());
            exec(
                tx,
                "INSERT INTO academy.course_quiz_score_events \
                   (attempt_id, n, kind, points, keys, previous_score, score, passed, reason, actor, at, file_sha256, file_line) \
                 VALUES ($1::text::uuid, $2::int4, 'curve', $3::text::jsonb, $4::text::jsonb, $5::int4, $6::int4, $7::bool, $8, \
                         $9::text::uuid, $10::text::timestamptz, $11, $12::int4)",
                &[
                    &a.id,
                    &(last.map_or(0, |e| e.n) + 1),
                    &points.compact(),
                    &keys.compact(),
                    &i32_of(from),
                    &i32_of(row.score),
                    &(row.score >= a.pass_mark()),
                    &reason,
                    &operator,
                    &iso(now),
                    &sha,
                    &i32_of(i64::try_from(row.line).unwrap_or(0)),
                ],
            )?;
        }
        applied.sort_by_key(|(l, _)| *l);
        Ok(base(
            false,
            true,
            applied.into_iter().map(|(_, j)| j).collect(),
            Vec::new(),
        ))
    })
}

/// `fixKey(input)`: the next revision of a published graded quiz with only keys changed.
pub fn fix_key(
    pool: &Store,
    item_id: &str,
    revision_in: i64,
    questions: &[Json],
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<(), Refusal> {
    begin(pool, |tx| {
        let quiz = first(
            tx,
            "SELECT q.revision, q.state, q.kind, q.questions::text AS questions FROM academy.course_quizzes q \
             JOIN academy.course_items i ON i.id = q.item_id AND i.kind = 'quiz' \
             WHERE q.item_id = $1::text::uuid FOR UPDATE OF q",
            &[&item_id],
        )?;
        let Some(quiz) = quiz else {
            return refuse("no quiz with that id", "academy.quiz_not_found");
        };
        let revision = i64::from(cell::<i32>(&quiz, "revision")?);
        let state: String = cell(&quiz, "state")?;
        let kind: String = cell(&quiz, "kind")?;
        if kind != "quiz" || state != "published" {
            return refuse(
                "only a published graded quiz is fixed; a draft is saved",
                "academy.key_fix_invalid",
            );
        }
        if revision != revision_in {
            return refuse(
                format!("the quiz is at revision {revision}, not {revision_in}"),
                "academy.revision_stale",
            );
        }
        let was = questions_of(json_cell(&quiz, "questions")?.as_ref());
        check_key_fix(&was, questions)?;
        exec(
            tx,
            "UPDATE academy.course_quizzes SET revision = $1::int4, questions = $2::text::jsonb, saved_by = $3::text::uuid, \
             saved_at = $4::text::timestamptz WHERE item_id = $5::text::uuid",
            &[
                &i32_of(revision + 1),
                &Json::Array(questions.to_vec()).compact(),
                &operator,
                &iso(now),
                &item_id,
            ],
        )?;
        record_event(
            tx,
            item_id,
            revision + 1,
            "key_fixed",
            Some(reason),
            operator,
            now,
        )
    })
}

/// `rescore(input)`.
pub fn rescore(
    pool: &Store,
    item_id: &str,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let (revision, rescored) = begin(pool, |tx| {
        let quiz = first(
            tx,
            "SELECT q.revision, q.kind, q.questions::text AS questions FROM academy.course_quizzes q WHERE q.item_id = $1::text::uuid FOR UPDATE",
            &[&item_id],
        )?;
        let kind: Option<String> = quiz.as_ref().map(|q| cell(q, "kind")).transpose()?;
        let Some(quiz) = quiz.filter(|_| kind.as_deref() == Some("quiz")) else {
            return refuse("no graded quiz with that id", "academy.quiz_not_found");
        };
        let revision: i32 = cell(&quiz, "revision")?;
        let current = questions_of(json_cell(&quiz, "questions")?.as_ref());
        let attempts = query(
            tx,
            &format!(
                "SELECT {TRAIL_COLUMNS}, a.alias FROM academy.course_quiz_attempts t \
                 JOIN ({ALIASES}) a USING (user_id) \
                 WHERE t.item_id = $1::text::uuid AND t.state = 'graded' ORDER BY t.id FOR UPDATE OF t"
            ),
            &[&item_id],
        )?
        .iter()
        .map(|r| read_trail(r, true))
        .collect::<Result<Vec<_>, _>>()?;
        let ids: Vec<String> = attempts.iter().map(|a| a.id.clone()).collect();
        let newest = newest_events(tx, &ids)?;
        let done: BTreeSet<String> = query(
            tx,
            "SELECT e.attempt_id::text AS attempt_id FROM academy.course_quiz_score_events e \
             JOIN academy.course_quiz_attempts t ON t.id = e.attempt_id \
             WHERE t.item_id = $1::text::uuid AND e.kind = 'rescore' AND e.revision = $2::int4",
            &[&item_id, &revision],
        )?
        .iter()
        .map(|r| cell::<String>(r, "attempt_id"))
        .collect::<Result<_, _>>()?;
        let mut rescored: Vec<(i32, i32, i64, i64)> = Vec::new();
        for a in &attempts {
            if done.contains(&a.id) {
                continue;
            }
            let last = newest.get(&a.id);
            let before = last.map_or_else(
                || finished_points(a.questions(), &a.answers, a.essay_points.as_ref()),
                |e| e.points.clone(),
            );
            let keys = last.map_or_else(|| finished_keys(a.questions()), |e| e.keys.clone());
            let (after_points, after_keys) =
                rescored_points(a.questions(), &a.answers, &before, &keys, &current);
            if canonical(&before) == canonical(&after_points) {
                continue;
            }
            let from = last.map_or_else(
                || a.score.map_or_else(|| total(&before), i64::from),
                |e| i64::from(e.score),
            );
            let to = score_of(&after_points, a.max_score);
            exec(
                tx,
                "INSERT INTO academy.course_quiz_score_events \
                   (attempt_id, n, kind, revision, points, keys, previous_score, score, passed, reason, actor, at) \
                 VALUES ($1::text::uuid, $2::int4, 'rescore', $3::int4, $4::text::jsonb, $5::text::jsonb, $6::int4, $7::int4, \
                         $8::bool, $9, $10::text::uuid, $11::text::timestamptz)",
                &[
                    &a.id,
                    &(last.map_or(0, |e| e.n) + 1),
                    &revision,
                    &after_points.compact(),
                    &after_keys.compact(),
                    &i32_of(from),
                    &i32_of(to),
                    &(to >= a.pass_mark()),
                    &reason,
                    &operator,
                    &iso(now),
                ],
            )?;
            rescored.push((a.alias, a.number, from, to));
        }
        rescored.sort_by(|x, y| x.0.cmp(&y.0).then(x.1.cmp(&y.1)));
        Ok((revision, rescored))
    })?;
    Ok(Json::obj([
        ("revision", int(i64::from(revision))),
        (
            "rescored",
            Json::Array(
                rescored
                    .into_iter()
                    .map(|(alias, number, from, to)| {
                        Json::obj([
                            ("alias", int(i64::from(alias))),
                            ("number", int(i64::from(number))),
                            ("from", int(from)),
                            ("to", int(to)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("attempts", attempts(pool, item_id)?),
    ]))
}

/// `override(input)`: one question's points as score event `n`; the same `n` again answers as stored.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's fields, as the TypeScript takes them"
)]
pub fn override_score(
    pool: &Store,
    item_id: &str,
    attempt_id: &str,
    question_id: &str,
    points: i64,
    n: i64,
    comment: Option<&str>,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let row = first(
            tx,
            &format!(
                "SELECT {TRAIL_COLUMNS} FROM academy.course_quiz_attempts t WHERE t.id = $1::text::uuid FOR UPDATE"
            ),
            &[&attempt_id],
        )?;
        let attempt = match &row {
            Some(r) if cell::<String>(r, "item_id")? == item_id => read_trail(r, false)?,
            _ => {
                return refuse(
                    "no attempt with that id on this quiz",
                    "academy.attempt_not_found",
                );
            }
        };
        if attempt.state != "graded" {
            return refuse(
                format!("the attempt is {}; score its essays first", attempt.state),
                "academy.attempt_closed",
            );
        }
        let question = attempt
            .questions()
            .iter()
            .find(|q| score::id(q) == question_id);
        if question.is_none_or(|q| points > score::points(q)) {
            return refuse(
                "score a question of this attempt, from 0 to its points",
                "academy.assessment_invalid",
            );
        }
        let comment = comment.filter(|c| !c.is_empty());
        let n32 = i32_of(n);
        let stored = first(
            tx,
            &format!("SELECT {} FROM academy.course_quiz_score_events WHERE attempt_id = $1::text::uuid AND n = $2::int4", event_columns("")),
            &[&attempt.id, &n32],
        )?
        .map(|r| Event::read(&r))
        .transpose()?;
        if let Some(s) = &stored
            && s.kind == "override"
            && s.question_id.as_deref() == Some(question_id)
            && s.points.get(question_id).and_then(num) == Some(points)
            && s.comment.as_deref() == comment
            && s.reason == reason
            && s.actor == operator
        {
            return Ok(());
        }
        let last = first(
            tx,
            &format!("SELECT {} FROM academy.course_quiz_score_events WHERE attempt_id = $1::text::uuid ORDER BY n DESC LIMIT 1", event_columns("")),
            &[&attempt.id],
        )?
        .map(|r| Event::read(&r))
        .transpose()?;
        let next = i64::from(last.as_ref().map_or(0, |e| e.n)) + 1;
        if n != next {
            return refuse(
                format!(
                    "the next score change on this attempt is {next}, not {n}; read the attempts again"
                ),
                "academy.revision_stale",
            );
        }
        let before = last.as_ref().map_or_else(
            || {
                finished_points(
                    attempt.questions(),
                    &attempt.answers,
                    attempt.essay_points.as_ref(),
                )
            },
            |e| e.points.clone(),
        );
        let after = set_key(&before, question_id, Json::int(points));
        let to = score_of(&after, attempt.max_score);
        let keys = last
            .as_ref()
            .map_or_else(|| finished_keys(attempt.questions()), |e| e.keys.clone());
        let previous = last.as_ref().map_or_else(
            || attempt.score.map_or_else(|| total(&before), i64::from),
            |e| i64::from(e.score),
        );
        exec(
            tx,
            "INSERT INTO academy.course_quiz_score_events \
               (attempt_id, n, kind, question_id, points, keys, previous_score, score, passed, comment, reason, actor, at) \
             VALUES ($1::text::uuid, $2::int4, 'override', $3, $4::text::jsonb, $5::text::jsonb, $6::int4, $7::int4, $8::bool, $9, $10, \
                     $11::text::uuid, $12::text::timestamptz)",
            &[
                &attempt.id,
                &n32,
                &question_id,
                &after.compact(),
                &keys.compact(),
                &i32_of(previous),
                &i32_of(to),
                &(to >= attempt.pass_mark()),
                &comment,
                &reason,
                &operator,
                &iso(now),
            ],
        )?;
        Ok(())
    })?;
    attempts(pool, item_id)
}

/// `attempts(itemId)`: every finished attempt under its alias, with its points and score trail.
pub fn attempts(pool: &Store, item_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let quiz = first(
            c,
            "SELECT i.title, i.kind, q.revision, q.pass_mark, q.questions::text AS questions \
             FROM academy.course_items i LEFT JOIN academy.course_quizzes q ON q.item_id = i.id WHERE i.id = $1::text::uuid",
            &[&item_id],
        )?;
        let quiz = match quiz {
            Some(q) if cell::<String>(&q, "kind")? == "quiz" => q,
            _ => return refuse("no quiz with that id", "academy.quiz_not_found"),
        };
        let current = questions_of(json_cell(&quiz, "questions")?.as_ref());
        let rows = query(
            c,
            &format!(
                "SELECT {TRAIL_COLUMNS}, a.alias FROM academy.course_quiz_attempts t \
                 JOIN ({ALIASES}) a USING (user_id) \
                 WHERE t.item_id = $1::text::uuid AND t.state <> 'open' ORDER BY a.alias, t.number"
            ),
            &[&item_id],
        )?
        .iter()
        .map(|r| read_trail(r, true))
        .collect::<Result<Vec<_>, _>>()?;
        let events = query(
            c,
            &format!(
                "SELECT {} FROM academy.course_quiz_score_events e JOIN academy.course_quiz_attempts t ON t.id = e.attempt_id \
                 WHERE t.item_id = $1::text::uuid ORDER BY e.attempt_id, e.n",
                event_columns("e.")
            ),
            &[&item_id],
        )?
        .iter()
        .map(Event::read)
        .collect::<Result<Vec<_>, _>>()?;
        let list: Vec<Json> = rows
            .iter()
            .map(|r| {
                let own: Vec<&Event> = events.iter().filter(|e| e.attempt_id == r.id).collect();
                let last = own.last();
                let graded = r.state == "graded";
                let points = match last {
                    Some(e) => Some(e.points.clone()),
                    None if graded => Some(finished_points(
                        r.questions(),
                        &r.answers,
                        r.essay_points.as_ref(),
                    )),
                    None => None,
                };
                let keys = last.map_or_else(|| finished_keys(r.questions()), |e| e.keys.clone());
                Json::obj([
                    ("attemptId", Json::str(r.id.clone())),
                    ("alias", int(i64::from(r.alias))),
                    ("number", int(i64::from(r.number))),
                    ("finishedAt", Json::String(iso(r.finished_at))),
                    ("state", Json::str(r.state.clone())),
                    ("originalScore", opt_int(r.score.map(i64::from))),
                    (
                        "score",
                        opt_int(last.map(|e| e.score).or(r.score).map(i64::from)),
                    ),
                    ("maxScore", int(i64::from(r.max_score.unwrap_or(0)))),
                    (
                        "passed",
                        last.map(|e| e.passed)
                            .or(r.passed)
                            .map_or(Json::Null, Json::Bool),
                    ),
                    ("passMark", int(r.pass_mark())),
                    (
                        "rescoreDue",
                        Json::Bool(graded && on_older_keys(r.questions(), &keys, &current)),
                    ),
                    (
                        "questions",
                        Json::Array(
                            r.questions()
                                .iter()
                                .map(|q| {
                                    let earned = points.as_ref().map_or(Json::Null, |p| {
                                        Json::int(p.get(score::id(q)).and_then(num).unwrap_or(0))
                                    });
                                    Json::obj([
                                        ("questionId", Json::str(score::id(q))),
                                        ("prompt", q.get("prompt").cloned().unwrap_or(Json::Null)),
                                        ("points", Json::int(score::points(q))),
                                        ("earned", earned),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    (
                        "events",
                        Json::Array(
                            own.iter()
                                .map(|e| {
                                    Json::obj([
                                        ("n", int(i64::from(e.n))),
                                        ("kind", Json::str(e.kind.clone())),
                                        ("questionId", opt_str(e.question_id.clone())),
                                        ("revision", opt_int(e.revision.map(i64::from))),
                                        ("previousScore", int(i64::from(e.previous_score))),
                                        ("score", int(i64::from(e.score))),
                                        ("passed", Json::Bool(e.passed)),
                                        ("comment", opt_str(e.comment.clone())),
                                        ("reason", Json::str(e.reason.clone())),
                                        ("at", Json::String(iso(e.at))),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    ("nextN", int(i64::from(last.map_or(0, |e| e.n)) + 1)),
                ])
            })
            .collect();
        Ok(Json::obj([
            ("itemId", Json::str(item_id)),
            ("title", Json::String(cell(&quiz, "title")?)),
            (
                "revision",
                int(i64::from(
                    cell::<Option<i32>>(&quiz, "revision")?.unwrap_or(0),
                )),
            ),
            (
                "passMark",
                opt_int(cell::<Option<i32>>(&quiz, "pass_mark")?.map(i64::from)),
            ),
            ("attempts", Json::Array(list)),
        ]))
    })
}
