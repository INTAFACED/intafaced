//! The grading policy, the late policy and the gradebook of a course staff made (`curriculum/course-gradebook.ts`,
//! `course-gradebook-math.ts`, `late-policy.ts`). Every figure is a fraction in scaled bigint (10^-18), divided with
//! the remainder cut. Nothing here stores a learner's score.

use std::collections::{BTreeMap, BTreeSet};

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, mul_div, parse_amount};
use service_kit::schema::js_trim;

use super::trail::EFFECTIVE_SCORE;
use super::{
    array, begin, canonical_price, cell, due_for, field, field_int, field_str, first, int, iso,
    json_of, ms, query, refuse, repeatable_read_only,
};
use crate::errors::Refusal;

const SCALE: Amount = 1_000_000_000_000_000_000;
const HOUR_MS: Amount = 3_600_000;
const DAY_MS: Amount = 86_400_000;
const CENT: Amount = SCALE / 100;

/// A stored or validated decimal as an amount (a value the schema or the database already holds to form).
fn amount(text: &str) -> Amount {
    parse_amount(text).unwrap_or(0)
}

/// `fractionOf(score, points)`: null when there are no points to divide by.
pub fn fraction_of(score: &str, points: &str) -> Option<Amount> {
    let bottom = amount(points);
    (bottom != 0).then(|| mul_div(amount(score), SCALE, bottom, Rounding::Trunc))
}

/// `typeAverage(scores, dropLowest)`.
pub fn type_average(
    scores: &[(String, Amount)],
    drop_lowest: i64,
) -> (Option<Amount>, Vec<String>, Vec<String>) {
    if scores.is_empty() {
        return (None, Vec::new(), Vec::new());
    }
    let mut sorted = scores.to_vec();
    sorted.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.0.encode_utf16().cmp(b.0.encode_utf16()))
    });
    let drop = usize::try_from(drop_lowest)
        .unwrap_or(0)
        .min(sorted.len() - 1);
    let (dropped, kept) = sorted.split_at(drop);
    let sum: Amount = kept.iter().map(|s| s.1).sum();
    let mut counted: Vec<String> = kept.iter().map(|s| s.0.clone()).collect();
    counted.sort();
    let mut dropped: Vec<String> = dropped.iter().map(|s| s.0.clone()).collect();
    dropped.sort();
    (
        Some(sum / Amount::try_from(kept.len()).unwrap_or(1)),
        counted,
        dropped,
    )
}

/// `weightedTotal(types)`.
pub fn weighted_total(types: &[(String, Option<Amount>)]) -> Option<Amount> {
    let mut weights: Amount = 0;
    let mut sum: Amount = 0;
    for (weight, average) in types {
        let Some(avg) = average else { continue };
        let w = amount(weight);
        weights += w;
        sum += w * avg;
    }
    (weights != 0).then(|| sum / weights)
}

/// `weightSum(weights)`.
pub fn weight_sum<'a>(weights: impl Iterator<Item = &'a str>) -> Amount {
    weights.map(amount).sum()
}

/// `policyOf(row)`: a late policy as the contract carries it, or none.
pub fn policy_of(grace: Option<&str>, deduction: Option<&str>) -> Option<(String, String)> {
    match (grace, deduction) {
        (Some(g), Some(d)) => Some((format_amount(amount(g)), format_amount(amount(d)))),
        _ => None,
    }
}

fn policy_json(p: Option<&(String, String)>) -> Json {
    p.map_or(Json::Null, |(g, d)| {
        Json::obj([
            ("graceHours", Json::str(g.clone())),
            ("deductionPerDay", Json::str(d.clone())),
        ])
    })
}

/// `latePolicyOf(sql, courseId)`.
pub fn late_policy_of<C: GenericClient>(
    c: &mut C,
    course_id: &str,
) -> Result<Option<(String, String)>, Refusal> {
    let row = first(
        c,
        "SELECT grace_hours::text AS grace_hours, deduction_per_day::text AS deduction_per_day \
         FROM academy.course_late_policies WHERE course_id = $1::text::uuid",
        &[&course_id],
    )?;
    match row {
        None => Ok(None),
        Some(r) => Ok(policy_of(
            cell::<Option<String>>(&r, "grace_hours")?.as_deref(),
            cell::<Option<String>>(&r, "deduction_per_day")?.as_deref(),
        )),
    }
}

/// `lateScore(entered, points, submittedAt, dueAt, policy)`: the score and, when something was taken off, the entered one.
pub fn late_score(
    entered: &str,
    points: &str,
    submitted_at: i64,
    due_at: Option<i64>,
    policy: Option<&(String, String)>,
) -> (String, Option<String>) {
    let (Some((grace, deduction)), Some(due)) = (policy, due_at) else {
        return (entered.to_owned(), None);
    };
    let grace_ms = amount(grace) * HOUR_MS / SCALE;
    let late_ms = Amount::from(submitted_at - due) - grace_ms;
    if late_ms <= 0 {
        return (entered.to_owned(), None);
    }
    let days = (late_ms + DAY_MS - 1) / DAY_MS;
    let asked = days * amount(deduction);
    let share = asked.min(SCALE);
    let off = ((mul_div(amount(points), share, SCALE, Rounding::Trunc) + CENT - 1) / CENT) * CENT;
    let kept = amount(entered) - off;
    let score = format_amount(kept.max(0));
    if score == format_amount(amount(entered)) {
        (entered.to_owned(), None)
    } else {
        (score, Some(entered.to_owned()))
    }
}

/// A grade type as stored and read back (`normal`).
fn normal(types: &[Json]) -> Vec<Json> {
    types
        .iter()
        .map(|t| {
            let mut ids: Vec<String> = array(field(t, "itemIds"))
                .iter()
                .filter_map(|i| {
                    if let Json::String(s) = i {
                        Some(s.clone())
                    } else {
                        None
                    }
                })
                .collect();
            ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            Json::obj([
                (
                    "name",
                    Json::str(js_trim(field_str(t, "name").unwrap_or(""))),
                ),
                (
                    "weight",
                    Json::String(format_amount(amount(field_str(t, "weight").unwrap_or("0")))),
                ),
                (
                    "dropLowest",
                    field(t, "dropLowest").cloned().unwrap_or(Json::Null),
                ),
                (
                    "itemIds",
                    Json::Array(ids.into_iter().map(Json::String).collect()),
                ),
            ])
        })
        .collect()
}

/// `quizScore(policy, attempts)`.
fn quiz_score(policy: Option<&str>, attempts: &[(i32, Amount)]) -> Amount {
    let mut by_number = attempts.to_vec();
    by_number.sort_by_key(|a| a.0);
    let firsts = by_number.first().map_or(0, |a| a.1);
    match policy {
        Some("latest") => by_number.last().map_or(0, |a| a.1),
        Some("first") => firsts,
        Some("average") => {
            by_number.iter().map(|a| a.1).sum::<Amount>()
                / Amount::try_from(by_number.len().max(1)).unwrap_or(1)
        }
        _ => by_number.iter().fold(firsts, |best, a| best.max(a.1)),
    }
}

struct Item {
    id: String,
    title: String,
    kind: String,
    scoring_policy: Option<String>,
}

/// `items(sql, courseId)`: the course's assignments with a brief and its graded quizzes, in outline order.
fn items<C: GenericClient>(c: &mut C, course_id: &str) -> Result<Vec<Item>, Refusal> {
    query(
        c,
        "SELECT i.id::text AS id, i.title, i.kind, q.scoring_policy \
         FROM academy.course_items i \
         JOIN academy.course_sections s ON s.id = i.section_id \
         LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
         LEFT JOIN academy.course_quizzes q ON q.item_id = i.id \
         WHERE i.course_id = $1::text::uuid \
           AND ((i.kind = 'assignment' AND a.item_id IS NOT NULL) OR (i.kind = 'quiz' AND q.item_id IS NOT NULL AND q.kind = 'quiz')) \
         ORDER BY s.position, i.position",
        &[&course_id],
    )?
    .iter()
    .map(|r| Ok(Item { id: cell(r, "id")?, title: cell(r, "title")?, kind: cell(r, "kind")?, scoring_policy: cell(r, "scoring_policy")? }))
    .collect()
}

#[derive(Clone)]
struct Cell {
    state: &'static str,
    score: Option<Amount>,
    entered: Option<Amount>,
}

const NOT_ATTEMPTED: Cell = Cell {
    state: "not_attempted",
    score: None,
    entered: None,
};
const PENDING: Cell = Cell {
    state: "pending",
    score: None,
    entered: None,
};

/// A gradebook cell's key: `(itemId, userId)`.
type CellKey = (String, String);

/// One assignment type's line for a learner: `(id, title, score, counted item ids, dropped item ids)`.
type TypeRow = (String, String, Option<Amount>, Vec<String>, Vec<String>);

fn opt_fraction(f: Option<Amount>) -> Json {
    f.map_or(Json::Null, |v| Json::String(format_amount(v)))
}

fn strings(v: &[String]) -> Json {
    Json::Array(v.iter().cloned().map(Json::String).collect())
}

/// `viewIn(sql, courseId)`: the gradebook read on a connection the caller holds.
pub fn view_in<C: GenericClient>(c: &mut C, course_id: &str) -> Result<Json, Refusal> {
    if first(
        c,
        "SELECT id FROM academy.courses WHERE id = $1::text::uuid",
        &[&course_id],
    )?
    .is_none()
    {
        return refuse("no course has that id", "academy.course_not_found");
    }
    let policy = first(
        c,
        &format!(
            "SELECT revision, types::text AS types, set_by::text AS set_by, {} AS set_at, reason \
             FROM academy.course_grading_policies WHERE course_id = $1::text::uuid",
            ms("set_at")
        ),
        &[&course_id],
    )?;
    let late = first(
        c,
        &format!(
            "SELECT revision, grace_hours::text AS grace_hours, deduction_per_day::text AS deduction_per_day, set_by::text AS set_by, \
             {} AS set_at, reason FROM academy.course_late_policies WHERE course_id = $1::text::uuid",
            ms("set_at")
        ),
        &[&course_id],
    )?;
    let late_policy = match &late {
        Some(r) => policy_of(
            cell::<Option<String>>(r, "grace_hours")?.as_deref(),
            cell::<Option<String>>(r, "deduction_per_day")?.as_deref(),
        ),
        None => None,
    };
    let late_set_at: Option<i64> = late.as_ref().map(|r| cell(r, "set_at")).transpose()?;
    let items = items(c, course_id)?;
    let learners: Vec<String> = query(
        c,
        "SELECT user_id::text AS user_id FROM academy.course_enrolments WHERE course_id = $1::text::uuid AND left_at IS NULL \
         ORDER BY enrolled_at, user_id",
        &[&course_id],
    )?
    .iter()
    .map(|r| cell(r, "user_id"))
    .collect::<Result<_, _>>()?;
    let hand_ins = query(
        c,
        &format!(
            "SELECT DISTINCT ON (s.item_id, s.user_id) s.item_id::text AS item_id, s.user_id::text AS user_id, s.state, \
               g.score::text AS score, g.points::text AS points, {} AS submitted_at, {} AS due_at, {} AS extended \
             FROM academy.assignment_submissions s \
             JOIN academy.course_items i ON i.id = s.item_id \
             LEFT JOIN academy.course_assignments a ON a.item_id = s.item_id \
             LEFT JOIN academy.course_item_extensions x ON x.item_id = s.item_id AND x.user_id = s.user_id \
             LEFT JOIN LATERAL ( \
               SELECT score, points FROM academy.assignment_grade_events WHERE submission_id = s.id ORDER BY n DESC LIMIT 1 \
             ) g ON TRUE \
             WHERE i.course_id = $1::text::uuid \
             ORDER BY s.item_id, s.user_id, s.version DESC",
            ms("s.submitted_at"),
            ms("a.due_at"),
            ms("x.due_at")
        ),
        &[&course_id],
    )?;
    let attempts = query(
        c,
        &format!(
            "SELECT t.item_id::text AS item_id, t.user_id::text AS user_id, t.number, t.state, {EFFECTIVE_SCORE} AS score, t.max_score \
             FROM academy.course_quiz_attempts t JOIN academy.course_items i ON i.id = t.item_id \
             WHERE i.course_id = $1::text::uuid"
        ),
        &[&course_id],
    )?;

    let mut cells: BTreeMap<(String, String), Cell> = BTreeMap::new();
    for h in &hand_ins {
        let item_id: String = cell(h, "item_id")?;
        let user_id: String = cell(h, "user_id")?;
        let state: String = cell(h, "state")?;
        let score: Option<String> = cell(h, "score")?;
        let points: Option<String> =
            cell::<Option<String>>(h, "points")?.map(|p| canonical_price(&p));
        let submitted_at: i64 = cell(h, "submitted_at")?;
        let due = due_for(cell(h, "due_at")?, cell(h, "extended")?);
        let policy = if late_set_at.is_some_and(|at| at <= submitted_at) {
            late_policy.as_ref()
        } else {
            None
        };
        let cut = match (&score, &points) {
            (Some(s), Some(p)) => Some(late_score(
                &canonical_price(s),
                p,
                submitted_at,
                due,
                policy,
            )),
            _ => None,
        };
        let fraction = match (&cut, &points) {
            (Some((s, _)), Some(p)) => fraction_of(s, p),
            _ => None,
        };
        if let (Some(f), Some(p)) = (fraction, &points) {
            let entered = cut
                .as_ref()
                .and_then(|(_, e)| e.as_deref())
                .and_then(|e| fraction_of(e, p));
            cells.insert(
                (item_id, user_id),
                Cell {
                    state: "graded",
                    score: Some(f),
                    entered,
                },
            );
        } else if state != "draft" && state != "withdrawn" {
            cells.insert((item_id, user_id), PENDING);
        }
    }
    let quiz_policy: BTreeMap<&str, Option<&str>> = items
        .iter()
        .filter(|i| i.kind == "quiz")
        .map(|i| (i.id.as_str(), i.scoring_policy.as_deref()))
        .collect();
    // Insertion order matters for the cells only by key, so a map keyed like the TypeScript's suffices.
    let mut graded: Vec<(CellKey, Vec<(i32, Amount)>)> = Vec::new();
    for a in &attempts {
        let item_id: String = cell(a, "item_id")?;
        if !quiz_policy.contains_key(item_id.as_str()) {
            continue;
        }
        let k = (item_id, cell::<String>(a, "user_id")?);
        let state: String = cell(a, "state")?;
        let score: Option<i32> = cell(a, "score")?;
        let max: Option<i32> = cell(a, "max_score")?;
        let fraction = match (state.as_str(), score, max) {
            ("graded", Some(s), Some(m)) if m != 0 => fraction_of(&s.to_string(), &m.to_string()),
            _ => None,
        };
        if let Some(f) = fraction {
            let number: i32 = cell(a, "number")?;
            match graded.iter_mut().find(|(gk, _)| *gk == k) {
                Some((_, list)) => list.push((number, f)),
                None => graded.push((k, vec![(number, f)])),
            }
        } else if state == "pending_review" && !cells.contains_key(&k) {
            cells.insert(k, PENDING);
        }
    }
    for (k, list) in graded {
        let policy = quiz_policy.get(k.0.as_str()).copied().flatten();
        cells.insert(
            k,
            Cell {
                state: "graded",
                score: Some(quiz_score(policy, &list)),
                entered: None,
            },
        );
    }

    let types: Vec<Json> = match &policy {
        Some(p) => normal(array(Some(&json_of(p, "types")?))),
        None => Vec::new(),
    };
    let learner_rows: Vec<Json> = learners
        .iter()
        .map(|user_id| {
            let cell_of = |item_id: &str| {
                cells
                    .get(&(item_id.to_owned(), user_id.clone()))
                    .cloned()
                    .unwrap_or(NOT_ATTEMPTED)
            };
            let by_type: Vec<TypeRow> = types
                .iter()
                .map(|t| {
                    let scored: Vec<(String, Amount)> = array(field(t, "itemIds"))
                        .iter()
                        .filter_map(|i| {
                            if let Json::String(s) = i {
                                Some(s.as_str())
                            } else {
                                None
                            }
                        })
                        .filter_map(|id| {
                            let c = cell_of(id);
                            match (c.state, c.score) {
                                ("graded", Some(s)) => Some((id.to_owned(), s)),
                                _ => None,
                            }
                        })
                        .collect();
                    let (average, counted, dropped) =
                        type_average(&scored, field_int(t, "dropLowest").unwrap_or(0));
                    (
                        field_str(t, "name").unwrap_or("").to_owned(),
                        field_str(t, "weight").unwrap_or("0").to_owned(),
                        average,
                        counted,
                        dropped,
                    )
                })
                .collect();
            let total = if policy.is_some() {
                weighted_total(
                    &by_type
                        .iter()
                        .map(|t| (t.1.clone(), t.2))
                        .collect::<Vec<_>>(),
                )
            } else {
                None
            };
            Json::obj([
                ("userId", Json::str(user_id.clone())),
                (
                    "items",
                    Json::Array(
                        items
                            .iter()
                            .map(|i| {
                                let c = cell_of(&i.id);
                                Json::obj([
                                    ("itemId", Json::str(i.id.clone())),
                                    ("state", Json::str(c.state)),
                                    ("score", opt_fraction(c.score)),
                                    ("entered", opt_fraction(c.entered)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "types",
                    Json::Array(
                        by_type
                            .iter()
                            .map(|t| {
                                Json::obj([
                                    ("name", Json::str(t.0.clone())),
                                    ("average", opt_fraction(t.2)),
                                    ("counted", strings(&t.3)),
                                    ("dropped", strings(&t.4)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("total", opt_fraction(total)),
            ])
        })
        .collect();
    let policy_out = match &policy {
        Some(p) => Json::obj([
            ("revision", int(i64::from(cell::<i32>(p, "revision")?))),
            ("types", Json::Array(types.clone())),
            ("setBy", Json::String(cell(p, "set_by")?)),
            ("setAt", Json::String(iso(cell(p, "set_at")?))),
            ("reason", Json::String(cell(p, "reason")?)),
        ]),
        None => Json::Null,
    };
    let late_out = match &late {
        Some(r) => Json::obj([
            ("revision", int(i64::from(cell::<i32>(r, "revision")?))),
            ("policy", policy_json(late_policy.as_ref())),
            ("setBy", Json::String(cell(r, "set_by")?)),
            ("setAt", Json::String(iso(cell(r, "set_at")?))),
            ("reason", Json::String(cell(r, "reason")?)),
        ]),
        None => Json::Null,
    };
    Ok(Json::obj([
        ("courseId", Json::str(course_id)),
        ("policy", policy_out),
        ("latePolicy", late_out),
        (
            "items",
            Json::Array(
                items
                    .iter()
                    .map(|i| {
                        Json::obj([
                            ("itemId", Json::str(i.id.clone())),
                            ("title", Json::str(i.title.clone())),
                            ("kind", Json::str(i.kind.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("learners", Json::Array(learner_rows)),
    ]))
}

/// `view(courseId)`.
pub fn view(pool: &Store, course_id: &str) -> Result<Json, Refusal> {
    repeatable_read_only(pool, |tx| view_in(tx, course_id))
}

fn lock_course<C: GenericClient>(c: &mut C, course_id: &str) -> Result<(), Refusal> {
    if first(
        c,
        "SELECT id FROM academy.courses WHERE id = $1::text::uuid FOR UPDATE",
        &[&course_id],
    )?
    .is_none()
    {
        return refuse("no course has that id", "academy.course_not_found");
    }
    Ok(())
}

/// `savePolicy(input)`.
pub fn save_policy(
    pool: &Store,
    course_id: &str,
    revision_in: i64,
    types_in: &[Json],
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        lock_course(tx, course_id)?;
        let stored = first(
            tx,
            "SELECT revision, types::text AS types FROM academy.course_grading_policies WHERE course_id = $1::text::uuid",
            &[&course_id],
        )?;
        let revision = match &stored {
            Some(s) => i64::from(cell::<i32>(s, "revision")?),
            None => 0,
        };
        if revision != revision_in {
            return refuse(
                format!("the grading policy is at revision {revision}, not {revision_in}"),
                "academy.revision_stale",
            );
        }
        let types = normal(types_in);
        let sum = weight_sum(types.iter().map(|t| field_str(t, "weight").unwrap_or("0")));
        if sum != SCALE {
            return refuse(
                format!(
                    "academy.weights_invalid sum={}: the weights must add up to exactly 1",
                    format_amount(sum)
                ),
                "academy.weights_invalid",
            );
        }
        let gradable: BTreeSet<String> = items(tx, course_id)?.into_iter().map(|i| i.id).collect();
        let mut seen = BTreeSet::new();
        let mut names = BTreeSet::new();
        for t in &types {
            let name = field_str(t, "name").unwrap_or("");
            if !names.insert(name.to_lowercase()) {
                return refuse(
                    format!("two types are named {name}"),
                    "academy.grading_policy_invalid",
                );
            }
            let ids = array(field(t, "itemIds"));
            if field_int(t, "dropLowest").unwrap_or(0)
                >= i64::try_from(ids.len()).unwrap_or(i64::MAX)
            {
                return refuse(
                    format!("{name} would drop every score it holds"),
                    "academy.grading_policy_invalid",
                );
            }
            for id in ids.iter().filter_map(|i| {
                if let Json::String(s) = i {
                    Some(s.as_str())
                } else {
                    None
                }
            }) {
                if !gradable.contains(id) {
                    return refuse(
                        format!("item {id} is not a graded assignment or quiz of this course"),
                        "academy.grading_policy_invalid",
                    );
                }
                if !seen.insert(id.to_owned()) {
                    return refuse(
                        format!("item {id} is in two types"),
                        "academy.grading_policy_invalid",
                    );
                }
            }
        }
        let next_types = Json::Array(types);
        if let Some(s) = &stored
            && Json::Array(normal(array(Some(&json_of(s, "types")?)))).compact()
                == next_types.compact()
        {
            return view_in(tx, course_id);
        }
        let next = i32::try_from(revision + 1).unwrap_or(i32::MAX);
        let types_text = next_types.compact();
        let at = iso(now);
        super::exec(
            tx,
            "INSERT INTO academy.course_grading_policies (course_id, revision, types, reason, set_by, set_at) \
             VALUES ($1::text::uuid, $2::int4, $3::text::jsonb, $4, $5::text::uuid, $6::text::timestamptz) \
             ON CONFLICT (course_id) DO UPDATE SET revision = EXCLUDED.revision, types = EXCLUDED.types, reason = EXCLUDED.reason, \
               set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
            &[&course_id, &next, &types_text, &reason, &operator, &at],
        )?;
        super::exec(
            tx,
            "INSERT INTO academy.course_grading_policy_events (course_id, revision, types, reason, actor_id, at) \
             VALUES ($1::text::uuid, $2::int4, $3::text::jsonb, $4, $5::text::uuid, $6::text::timestamptz)",
            &[&course_id, &next, &types_text, &reason, &operator, &at],
        )?;
        view_in(tx, course_id)
    })
}

/// `saveLatePolicy(input)`: `policy` is `(graceHours, deductionPerDay)` or none to clear.
pub fn save_late_policy(
    pool: &Store,
    course_id: &str,
    revision_in: i64,
    policy: Option<(&str, &str)>,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        lock_course(tx, course_id)?;
        let stored = first(
            tx,
            "SELECT revision, grace_hours::text AS grace_hours, deduction_per_day::text AS deduction_per_day \
             FROM academy.course_late_policies WHERE course_id = $1::text::uuid",
            &[&course_id],
        )?;
        let (revision, was) = match &stored {
            Some(s) => (
                i64::from(cell::<i32>(s, "revision")?),
                policy_of(
                    cell::<Option<String>>(s, "grace_hours")?.as_deref(),
                    cell::<Option<String>>(s, "deduction_per_day")?.as_deref(),
                ),
            ),
            None => (0, None),
        };
        if revision != revision_in {
            return refuse(
                format!("the late policy is at revision {revision}, not {revision_in}"),
                "academy.revision_stale",
            );
        }
        let asked = policy.and_then(|(g, d)| policy_of(Some(g), Some(d)));
        if asked == was {
            return view_in(tx, course_id);
        }
        let next = i32::try_from(revision + 1).unwrap_or(i32::MAX);
        let grace = policy.map(|p| p.0);
        let deduction = policy.map(|p| p.1);
        let at = iso(now);
        super::exec(
            tx,
            "INSERT INTO academy.course_late_policies (course_id, revision, grace_hours, deduction_per_day, reason, set_by, set_at) \
             VALUES ($1::text::uuid, $2::int4, $3::text::numeric, $4::text::numeric, $5, $6::text::uuid, $7::text::timestamptz) \
             ON CONFLICT (course_id) DO UPDATE SET revision = EXCLUDED.revision, grace_hours = EXCLUDED.grace_hours, \
               deduction_per_day = EXCLUDED.deduction_per_day, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
            &[
                &course_id, &next, &grace, &deduction, &reason, &operator, &at,
            ],
        )?;
        super::exec(
            tx,
            "INSERT INTO academy.course_late_policy_events (course_id, revision, grace_hours, deduction_per_day, reason, actor_id, at) \
             VALUES ($1::text::uuid, $2::int4, $3::text::numeric, $4::text::numeric, $5, $6::text::uuid, $7::text::timestamptz)",
            &[
                &course_id, &next, &grace, &deduction, &reason, &operator, &at,
            ],
        )?;
        view_in(tx, course_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractions_cut_and_drop_lowest() {
        assert_eq!(
            fraction_of("2", "3").map(format_amount).as_deref(),
            Some("0.666666666666666666")
        );
        assert_eq!(fraction_of("1", "0"), None);
        let s = |id: &str, v: &str| (id.to_owned(), amount(v));
        let (avg, counted, dropped) = type_average(&[s("b", "0.5"), s("a", "0.5"), s("c", "1")], 1);
        assert_eq!(avg.map(format_amount).as_deref(), Some("0.75"));
        assert_eq!(counted, vec!["b".to_owned(), "c".to_owned()]);
        assert_eq!(dropped, vec!["a".to_owned()]);
        let (avg, _, dropped) = type_average(&[s("a", "0.2")], 3);
        assert_eq!(avg.map(format_amount).as_deref(), Some("0.2"));
        assert!(dropped.is_empty());
        assert_eq!(
            weighted_total(&[("0.6".into(), Some(amount("0.5"))), ("0.4".into(), None)])
                .map(format_amount)
                .as_deref(),
            Some("0.5")
        );
    }

    #[test]
    fn late_score_cuts_per_started_day_after_grace() {
        let p = ("24".to_owned(), "0.1".to_owned());
        let day = 86_400_000;
        assert_eq!(
            late_score("10", "10", day, Some(0), Some(&p)),
            ("10".to_owned(), None)
        );
        assert_eq!(
            late_score("10", "10", day + 1, Some(0), Some(&p)),
            ("9".to_owned(), Some("10".to_owned()))
        );
        assert_eq!(
            late_score("10", "10", 30 * day, Some(0), Some(&p)),
            ("0".to_owned(), Some("10".to_owned()))
        );
        assert_eq!(
            late_score("7.5", "7", 2 * day + 1, Some(0), Some(&p)),
            ("6.1".to_owned(), Some("7.5".to_owned()))
        );
        assert_eq!(
            late_score("10", "10", 9 * day, None, Some(&p)),
            ("10".to_owned(), None)
        );
    }
}
