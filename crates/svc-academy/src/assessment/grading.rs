//! Staff grading of assignment hand-ins (`curriculum/grading.ts`): the queue under aliases, the grader's lease, the
//! append-only grade trail keyed `grade:<submission>:<n>`, the bulk grade file and the learner's read of their feedback.

use std::collections::BTreeMap;

use postgres::{GenericClient, Transaction};

use crate::db::Store;
use service_kit::json::Json;

use super::assignments::{admin_in, learner_row};
use super::csv::{BadRow, read_grade_file};
use super::gradebook::{late_score, policy_of};
use super::peer::hundredths;
use super::{
    begin, canonical_price, cell, due_for, exec, field, first, int, iso, iso_or_null, ms, one,
    opt_str, query, refuse, sha256_hex, with_client,
};
use crate::errors::{AcademyError, Refusal};

/// `learnerGradeOf(sql, itemId, userId)`: the learner's newest grade after the late policy, or none before staff grade.
pub fn learner_grade_of<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    user_id: &str,
) -> Result<Option<Json>, Refusal> {
    let row = first(
        c,
        &format!(
            "SELECT s.version, g.n, g.score::text AS score, g.points::text AS points, g.comment, {} AS at, {} AS read_at, \
               {} AS submitted_at, {} AS due_at, {} AS extended, lp.grace_hours::text AS grace_hours, \
               lp.deduction_per_day::text AS deduction_per_day \
             FROM academy.assignment_submissions s \
             JOIN academy.assignment_grade_events g ON g.submission_id = s.id \
             JOIN academy.course_items i ON i.id = s.item_id \
             LEFT JOIN academy.course_assignments a ON a.item_id = s.item_id \
             LEFT JOIN academy.course_item_extensions x ON x.item_id = s.item_id AND x.user_id = s.user_id \
             LEFT JOIN academy.course_late_policies lp ON lp.course_id = i.course_id AND lp.set_at <= s.submitted_at \
             LEFT JOIN academy.assignment_feedback_reads r ON r.grade_event_id = g.id \
             WHERE s.item_id = $1::text::uuid AND s.user_id = $2::text::uuid \
             ORDER BY s.version DESC, g.n DESC LIMIT 1",
            ms("g.at"),
            ms("r.read_at"),
            ms("s.submitted_at"),
            ms("a.due_at"),
            ms("x.due_at")
        ),
        &[&item_id, &user_id],
    )?;
    let Some(r) = row else { return Ok(None) };
    let score = canonical_price(&cell::<String>(&r, "score")?);
    let points = canonical_price(&cell::<String>(&r, "points")?);
    let policy = policy_of(
        cell::<Option<String>>(&r, "grace_hours")?.as_deref(),
        cell::<Option<String>>(&r, "deduction_per_day")?.as_deref(),
    );
    let (late, entered) = late_score(
        &score,
        &points,
        cell(&r, "submitted_at")?,
        due_for(cell(&r, "due_at")?, cell(&r, "extended")?),
        policy.as_ref(),
    );
    Ok(Some(Json::obj([
        ("version", int(i64::from(cell::<i32>(&r, "version")?))),
        ("n", int(i64::from(cell::<i32>(&r, "n")?))),
        ("score", Json::String(late)),
        ("points", Json::String(points)),
        ("entered", opt_str(entered)),
        ("comment", opt_str(cell(&r, "comment")?)),
        ("gradedAt", Json::String(iso(cell(&r, "at")?))),
        ("readAt", iso_or_null(cell(&r, "read_at")?)),
    ])))
}

/// `requireLease()`.
fn require_lease(lease_seconds: Option<i64>) -> Result<i64, Refusal> {
    lease_seconds.ok_or_else(|| {
        AcademyError::new(
            "the owner has not set how long a grader holds a hand-in",
            "academy.grader_lease_unset",
        )
        .into()
    })
}

/// `lease(tx, ...)`: the caller's lease, taken when free or expired and renewed when theirs.
fn lease(
    tx: &mut Transaction<'_>,
    submission_id: &str,
    operator: &str,
    now: i64,
    seconds: i64,
) -> Result<(), Refusal> {
    let held = first(
        tx,
        "INSERT INTO academy.assignment_grader_leases (submission_id, holder, expires_at) \
         VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz) \
         ON CONFLICT (submission_id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at \
           WHERE academy.assignment_grader_leases.holder = EXCLUDED.holder OR academy.assignment_grader_leases.expires_at <= $4::text::timestamptz \
         RETURNING holder",
        &[
            &submission_id,
            &operator,
            &iso(now + seconds * 1000),
            &iso(now),
        ],
    )?;
    if held.is_none() {
        return refuse("another grader holds this hand-in", "academy.grader_locked");
    }
    Ok(())
}

struct HandIn {
    submission_id: String,
    points: String,
}

/// `handIn(tx, itemId, submissionId)`: the newest hand-in of its learner, locked, neither withdrawn nor closed.
fn hand_in(
    tx: &mut Transaction<'_>,
    item_id: &str,
    submission_id: &str,
) -> Result<HandIn, Refusal> {
    let row = first(
        tx,
        "SELECT s.id::text AS submission_id, s.state, a.points::text AS points, a.withdrawn_at IS NOT NULL AS withdrawn \
         FROM academy.assignment_submissions s JOIN academy.course_assignments a ON a.item_id = s.item_id \
         WHERE s.id = $1::text::uuid AND s.item_id = $2::text::uuid \
           AND s.version = (SELECT max(version) FROM academy.assignment_submissions o WHERE o.item_id = s.item_id AND o.user_id = s.user_id) \
         FOR UPDATE OF s",
        &[&submission_id, &item_id],
    )?;
    let row = match row {
        Some(r) if cell::<String>(&r, "state")? != "withdrawn" => r,
        _ => {
            return refuse(
                "no newest hand-in with that id on this assignment",
                "academy.submission_not_found",
            );
        }
    };
    if cell::<bool>(&row, "withdrawn")? {
        return refuse(
            "staff withdrew this assignment",
            "academy.assignment_closed",
        );
    }
    Ok(HandIn {
        submission_id: cell(&row, "submission_id")?,
        points: cell(&row, "points")?,
    })
}

/// `queueIn(sql, itemId, operatorId, now)`.
fn queue_in<C: GenericClient>(
    c: &mut C,
    lease_seconds: Option<i64>,
    item_id: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let view = admin_in(c, item_id)?;
    let brief = field(&view, "brief")
        .filter(|b| !matches!(b, Json::Null))
        .cloned();
    let Some(brief) = brief else {
        return refuse(
            "the assignment has no brief",
            "academy.assignment_not_found",
        );
    };
    let rows = query(
        c,
        &format!(
            "WITH firsts AS ( \
               SELECT user_id, rank() OVER (ORDER BY min(submitted_at), user_id)::int AS alias \
               FROM academy.assignment_submissions WHERE item_id = $1::text::uuid GROUP BY user_id \
             ), \
             latest AS ( \
               SELECT DISTINCT ON (user_id) * FROM academy.assignment_submissions WHERE item_id = $1::text::uuid ORDER BY user_id, version DESC \
             ) \
             SELECT l.id::text AS submission_id, f.alias, l.version, {} AS submitted_at, l.text, \
               fl.file_name, fl.content_type, fl.bytes::int8 AS bytes, pr.received, pr.mean_total, \
               g.score::text AS score, g.comment, {} AS graded_at, coalesce(g.n, 0)::int AS last_n, \
               le.holder::text AS holder, {} AS expires_at, {} AS extended_due \
             FROM latest l \
             JOIN firsts f ON f.user_id = l.user_id \
             LEFT JOIN academy.assignment_files fl ON fl.id = l.file_id \
             CROSS JOIN LATERAL ( \
               SELECT count(*)::int AS received, round(avg(r.total), 2)::text AS mean_total FROM academy.assignment_reviews r \
               WHERE r.item_id = l.item_id AND r.author_id = l.user_id AND r.version = l.version \
                 AND r.reviewer_id <> r.author_id AND r.marks IS NOT NULL \
             ) pr \
             LEFT JOIN LATERAL ( \
               SELECT score, comment, at, n FROM academy.assignment_grade_events WHERE submission_id = l.id ORDER BY n DESC LIMIT 1 \
             ) g ON TRUE \
             LEFT JOIN academy.assignment_grader_leases le ON le.submission_id = l.id AND le.expires_at > $2::text::timestamptz \
             LEFT JOIN academy.course_item_extensions x ON x.item_id = l.item_id AND x.user_id = l.user_id \
             ORDER BY f.alias",
            ms("l.submitted_at"),
            ms("g.at"),
            ms("le.expires_at"),
            ms("x.due_at")
        ),
        &[&item_id, &iso(now)],
    )?;
    let due_at = match field(&brief, "dueAt") {
        Some(Json::String(s)) => service_kit::time::js_date(s).map(|i| i.0),
        _ => None,
    };
    let list = rows
        .iter()
        .map(|r| {
            let submitted: i64 = cell(r, "submitted_at")?;
            let due = due_for(due_at, cell(r, "extended_due")?);
            let file_name: Option<String> = cell(r, "file_name")?;
            let score: Option<String> = cell(r, "score")?;
            let last_n = i64::from(cell::<i32>(r, "last_n")?);
            let holder: Option<String> = cell(r, "holder")?;
            Ok(Json::obj([
                ("submissionId", Json::String(cell(r, "submission_id")?)),
                ("alias", int(i64::from(cell::<i32>(r, "alias")?))),
                ("version", int(i64::from(cell::<i32>(r, "version")?))),
                ("submittedAt", Json::String(iso(submitted))),
                ("late", Json::Bool(due.is_some_and(|d| submitted > d))),
                ("text", opt_str(cell(r, "text")?)),
                (
                    "file",
                    match file_name {
                        None => Json::Null,
                        Some(n) => Json::obj([
                            ("fileName", Json::String(n)),
                            ("contentType", opt_str(cell(r, "content_type")?)),
                            ("bytes", int(cell::<Option<i64>>(r, "bytes")?.unwrap_or(0))),
                        ]),
                    },
                ),
                (
                    "peerReviews",
                    Json::obj([
                        ("received", int(i64::from(cell::<i32>(r, "received")?))),
                        (
                            "meanTotal",
                            opt_str(
                                cell::<Option<String>>(r, "mean_total")?
                                    .map(|m| canonical_price(&m)),
                            ),
                        ),
                    ]),
                ),
                (
                    "grade",
                    match score {
                        None => Json::Null,
                        Some(s) => Json::obj([
                            ("score", Json::String(canonical_price(&s))),
                            ("comment", opt_str(cell(r, "comment")?)),
                            ("gradedAt", iso_or_null(cell(r, "graded_at")?)),
                            ("overrides", int(last_n - 1)),
                        ]),
                    },
                ),
                ("nextN", int(last_n + 1)),
                (
                    "lease",
                    match holder {
                        None => Json::Null,
                        Some(h) => Json::obj([
                            ("mine", Json::Bool(h == operator)),
                            ("expiresAt", iso_or_null(cell(r, "expires_at")?)),
                        ]),
                    },
                ),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Json::obj([
        (
            "itemId",
            field(&view, "itemId").cloned().unwrap_or(Json::Null),
        ),
        (
            "courseId",
            field(&view, "courseId").cloned().unwrap_or(Json::Null),
        ),
        (
            "title",
            field(&view, "title").cloned().unwrap_or(Json::Null),
        ),
        (
            "points",
            field(&brief, "points").cloned().unwrap_or(Json::Null),
        ),
        ("leaseSeconds", lease_seconds.map_or(Json::Null, int)),
        ("rows", Json::Array(list)),
    ]))
}

/// `queue(input)`. Writes nothing.
pub fn queue(
    pool: &Store,
    lease_seconds: Option<i64>,
    item_id: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    with_client(pool, |c| queue_in(c, lease_seconds, item_id, operator, now))
}

/// `open(input)`: take or renew the caller's lease on one hand-in.
pub fn open(
    pool: &Store,
    lease_seconds: Option<i64>,
    item_id: &str,
    submission_id: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let seconds = require_lease(lease_seconds)?;
    begin(pool, |tx| {
        let h = hand_in(tx, item_id, submission_id)?;
        lease(tx, &h.submission_id, operator, now, seconds)
    })?;
    queue(pool, lease_seconds, item_id, operator, now)
}

/// A grade as staff send it.
pub struct GradeInput<'a> {
    pub item_id: &'a str,
    pub submission_id: &'a str,
    pub n: i64,
    pub score: &'a str,
    pub comment: Option<&'a str>,
    pub reason: Option<&'a str>,
}

/// `grade(input)`: grade event `n` under the caller's lease, which it then releases.
pub fn grade(
    pool: &Store,
    lease_seconds: Option<i64>,
    input: &GradeInput<'_>,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let seconds = require_lease(lease_seconds)?;
    let comment = input.comment.filter(|c| !c.is_empty());
    let reason = if input.n > 1 { input.reason } else { None };
    let n32 = i32::try_from(input.n).unwrap_or(i32::MAX);
    begin(pool, |tx| {
        let h = hand_in(tx, input.item_id, input.submission_id)?;
        let stored = first(
            tx,
            "SELECT score::text AS score, comment, reason, actor::text AS actor FROM academy.assignment_grade_events \
             WHERE submission_id = $1::text::uuid AND n = $2::int4",
            &[&h.submission_id, &n32],
        )?;
        if let Some(s) = stored
            && cell::<String>(&s, "actor")? == operator
            && canonical_price(&cell::<String>(&s, "score")?) == canonical_price(input.score)
            && cell::<Option<String>>(&s, "comment")?.as_deref() == comment
            && cell::<Option<String>>(&s, "reason")?.as_deref() == reason
        {
            return Ok(());
        }
        let last = i64::from(cell::<i32>(
            &one(
                tx,
                "SELECT coalesce(max(n), 0)::int AS n FROM academy.assignment_grade_events WHERE submission_id = $1::text::uuid",
                &[&h.submission_id],
            )?,
            "n",
        )?);
        if input.n != last + 1 {
            return refuse(
                format!(
                    "the next grade on this hand-in is {}, not {}; read the queue again",
                    last + 1,
                    input.n
                ),
                "academy.revision_stale",
            );
        }
        if hundredths(input.score) > hundredths(&h.points) {
            return refuse(
                format!(
                    "a score of {} is above the {} points",
                    input.score,
                    canonical_price(&h.points)
                ),
                "academy.grade_invalid",
            );
        }
        if input.n > 1 && input.reason.is_none_or(str::is_empty) {
            return refuse("changing a grade needs a reason", "academy.reason_required");
        }
        lease(tx, &h.submission_id, operator, now, seconds)?;
        exec(
            tx,
            "INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at) \
             VALUES ($1::text::uuid, $2::int4, $3::text::numeric, $4::text::numeric, $5, $6::text::uuid, $7, $8::text::timestamptz)",
            &[
                &h.submission_id,
                &n32,
                &input.score,
                &h.points,
                &comment,
                &operator,
                &reason,
                &iso(now),
            ],
        )?;
        exec(
            tx,
            "UPDATE academy.assignment_submissions SET state = 'graded' WHERE id = $1::text::uuid",
            &[&h.submission_id],
        )?;
        exec(
            tx,
            "DELETE FROM academy.assignment_grader_leases WHERE submission_id = $1::text::uuid",
            &[&h.submission_id],
        )?;
        Ok(())
    })?;
    queue(pool, lease_seconds, input.item_id, operator, now)
}

fn bad_json(b: &BadRow) -> Json {
    Json::obj([
        ("line", int(i64::try_from(b.line).unwrap_or(0))),
        ("alias", b.alias.map_or(Json::Null, |a| int(i64::from(a)))),
        ("code", Json::str(b.code.clone())),
        ("message", Json::str(b.message.clone())),
    ])
}

/// `bulkGrade(input)`: a file of grades for one assignment, by alias.
pub fn bulk_grade(
    pool: &Store,
    lease_seconds: Option<i64>,
    item_id: &str,
    file_name: &str,
    csv: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let seconds = require_lease(lease_seconds)?;
    let view = with_client(pool, |c| admin_in(c, item_id))?;
    if field(&view, "brief").is_none_or(|b| matches!(b, Json::Null)) {
        return refuse(
            "the assignment has no brief",
            "academy.assignment_not_found",
        );
    }
    let sha = sha256_hex(csv.as_bytes());
    let (rows, bad) = read_grade_file(csv)?;
    let outcome = begin(pool, |tx| {
        let created = first(
            tx,
            "INSERT INTO academy.assignment_bulk_grades (item_id, sha256, actor, result, at) \
             VALUES ($1::text::uuid, $2, $3::text::uuid, '{}'::jsonb, $4::text::timestamptz) \
             ON CONFLICT (item_id, sha256) DO NOTHING RETURNING id::text AS id",
            &[&item_id, &sha, &operator, &iso(now)],
        )?;
        let repeated = created.is_none();
        let stored = match created {
            Some(c) => c,
            None => one(
                tx,
                "SELECT id::text AS id FROM academy.assignment_bulk_grades WHERE item_id = $1::text::uuid AND sha256 = $2 FOR UPDATE",
                &[&item_id, &sha],
            )?,
        };
        let file_id: String = cell(&stored, "id")?;
        let targets: BTreeMap<i64, (String, bool)> = query(
            tx,
            "WITH firsts AS ( \
               SELECT user_id, rank() OVER (ORDER BY min(submitted_at), user_id)::int AS alias \
               FROM academy.assignment_submissions WHERE item_id = $1::text::uuid GROUP BY user_id \
             ) \
             SELECT f.alias, l.id::text AS submission_id, \
               EXISTS (SELECT 1 FROM academy.assignment_grade_events g WHERE g.submission_id = l.id AND g.bulk_id = $2::text::uuid) AS by_file \
             FROM firsts f \
             JOIN LATERAL ( \
               SELECT id FROM academy.assignment_submissions s \
               WHERE s.item_id = $1::text::uuid AND s.user_id = f.user_id ORDER BY s.version DESC LIMIT 1 \
             ) l ON TRUE",
            &[&item_id, &file_id],
        )?
        .iter()
        .map(|r| Ok((i64::from(cell::<i32>(r, "alias")?), (cell(r, "submission_id")?, cell(r, "by_file")?))))
        .collect::<Result<_, Refusal>>()?;
        let mut applied: Vec<(usize, Json)> = Vec::new();
        let mut rejected: Vec<BadRow> = bad.clone();
        let mut changed = 0i64;
        let mut named: Vec<_> = rows
            .iter()
            .map(|row| (row, targets.get(&i64::from(row.alias))))
            .collect();
        named.sort_by(|a, b| {
            a.1.map_or("", |t| t.0.as_str())
                .cmp(b.1.map_or("", |t| t.0.as_str()))
        });
        for (row, target) in named {
            let mut refuse_row = |code: &str, message: String| {
                rejected.push(BadRow {
                    line: row.line,
                    alias: Some(row.alias),
                    code: code.to_owned(),
                    message,
                });
            };
            let applied_row = || {
                Json::obj([
                    ("line", int(i64::try_from(row.line).unwrap_or(0))),
                    ("alias", int(i64::from(row.alias))),
                    ("score", Json::String(canonical_price(&row.score))),
                ])
            };
            let Some((submission_id, by_file)) = target else {
                refuse_row(
                    "academy.submission_not_found",
                    format!("no Learner {} has handed in this assignment", row.alias),
                );
                continue;
            };
            if *by_file {
                applied.push((row.line, applied_row()));
                continue;
            }
            let h = match hand_in(tx, item_id, submission_id) {
                Ok(h) => h,
                Err(Refusal::Academy(e)) => {
                    refuse_row(&e.code, e.message);
                    continue;
                }
                Err(other) => return Err(other),
            };
            if hundredths(&row.score) > hundredths(&h.points) {
                refuse_row(
                    "academy.grade_invalid",
                    format!(
                        "a score of {} is above the {} points",
                        row.score,
                        canonical_price(&h.points)
                    ),
                );
                continue;
            }
            let n = i64::from(cell::<i32>(
                &one(
                    tx,
                    "SELECT coalesce(max(n), 0)::int AS n FROM academy.assignment_grade_events WHERE submission_id = $1::text::uuid",
                    &[submission_id],
                )?,
                "n",
            )?) + 1;
            if n > 1 && row.reason.is_none() {
                refuse_row(
                    "academy.reason_required",
                    format!(
                        "Learner {} already has a grade; changing it needs a reason",
                        row.alias
                    ),
                );
                continue;
            }
            match lease(tx, submission_id, operator, now, seconds) {
                Ok(()) => {}
                Err(Refusal::Academy(e)) => {
                    refuse_row(
                        &e.code,
                        format!("another grader holds Learner {}'s hand-in", row.alias),
                    );
                    continue;
                }
                Err(other) => return Err(other),
            }
            exec(
                tx,
                "INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at, bulk_id) \
                 VALUES ($1::text::uuid, $2::int4, $3::text::numeric, $4::text::numeric, $5, $6::text::uuid, $7, $8::text::timestamptz, $9::text::uuid)",
                &[
                    submission_id,
                    &i32::try_from(n).unwrap_or(i32::MAX),
                    &row.score,
                    &h.points,
                    &row.comment,
                    &operator,
                    &if n > 1 { row.reason.clone() } else { None },
                    &iso(now),
                    &file_id,
                ],
            )?;
            exec(
                tx,
                "UPDATE academy.assignment_submissions SET state = 'graded' WHERE id = $1::text::uuid",
                &[submission_id],
            )?;
            exec(
                tx,
                "DELETE FROM academy.assignment_grader_leases WHERE submission_id = $1::text::uuid",
                &[submission_id],
            )?;
            applied.push((row.line, applied_row()));
            changed += 1;
        }
        applied.sort_by_key(|(l, _)| *l);
        rejected.sort_by_key(|b| b.line);
        let outcome = Json::obj([
            ("sha256", Json::str(sha.clone())),
            ("fileName", Json::str(file_name)),
            ("at", Json::String(iso(now))),
            ("repeated", Json::Bool(repeated)),
            ("changed", int(changed)),
            (
                "applied",
                Json::Array(applied.into_iter().map(|(_, j)| j).collect()),
            ),
            (
                "rejected",
                Json::Array(rejected.iter().map(bad_json).collect()),
            ),
        ]);
        exec(
            tx,
            "UPDATE academy.assignment_bulk_grades SET result = $1::text::jsonb WHERE id = $2::text::uuid",
            &[&outcome.compact(), &file_id],
        )?;
        Ok(outcome)
    })?;
    let mut out = super::fields(&outcome).to_vec();
    out.push((
        "queue".to_owned(),
        queue(pool, lease_seconds, item_id, operator, now)?,
    ));
    Ok(Json::Object(out))
}

/// `markRead(input)`: the learner read grade event `n` on version `version`. A repeat answers as stored.
pub fn mark_read(
    pool: &Store,
    item_id: &str,
    version: i64,
    n: i64,
    user_id: &str,
    now: i64,
) -> Result<(), Refusal> {
    with_client(pool, |c| {
        learner_row(c, item_id, user_id, false, now)?;
        let event = first(
            c,
            "SELECT g.id::text AS id FROM academy.assignment_submissions s \
             JOIN academy.assignment_grade_events g ON g.submission_id = s.id \
             WHERE s.item_id = $1::text::uuid AND s.user_id = $2::text::uuid AND s.version = $3::int4 AND g.n = $4::int4",
            &[
                &item_id,
                &user_id,
                &i32::try_from(version).unwrap_or(i32::MAX),
                &i32::try_from(n).unwrap_or(i32::MAX),
            ],
        )?;
        let Some(event) = event else {
            return refuse(
                "that hand-in has no grade to read",
                "academy.submission_not_found",
            );
        };
        let id: String = cell(&event, "id")?;
        exec(
            c,
            "INSERT INTO academy.assignment_feedback_reads (grade_event_id, user_id, read_at) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz) ON CONFLICT (grade_event_id) DO NOTHING",
            &[&id, &user_id, &iso(now)],
        )?;
        Ok(())
    })
}
