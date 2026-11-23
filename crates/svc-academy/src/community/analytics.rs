//! AC-analytics-01 and AC-analytics-02 (J-academy-16): learner summaries and the reports centre
//! (`analytics/learner-summaries.ts`, `analytics/report-tasks.ts`).
//!
//! A report is a task: written `queued`, started by one sweep and finished by the next (so staff can watch and abort
//! it), its CSV kept with its row count and SHA-256 until the owner's retention ends. Every change writes an event with
//! its actor. Refusals are the `AcademyAnalyticsError` family's. Read only apart from the task rows. No money moves.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::Db;
use super::{
    at, at_opt, begin, col, csv_field, exec, family, first, int, iso, iso_opt, ms, require_setting,
    rows,
};
use super::{sha256_hex, str_opt, strs};
use crate::db::with_client;
use crate::errors::Refusal;

/// `analyticsRefusals`: each code's status.
fn status_of(code: &str) -> &'static str {
    match code {
        "academy.report_out_of_order"
        | "academy.report_not_ready"
        | "academy.report_not_abortable" => "CONFLICT",
        "academy.report_not_found" => "NOT_FOUND",
        _ => "PRECONDITION_FAILED",
    }
}

pub fn refuse(code: &str, message: &str) -> Refusal {
    family(status_of(code), code, message)
}

fn setting(value: Option<i64>, code: &str) -> Result<i64, Refusal> {
    require_setting(value, status_of(code), code)
}

/// The learners with an open enrolment, in id order, after `after`, filtered by `tag`; at most `limit`.
pub fn learner_ids<C: GenericClient>(
    db: &mut C,
    tag: Option<&str>,
    after: Option<&str>,
    limit: i64,
) -> Result<Vec<String>, Refusal> {
    let found = rows(
        db,
        "SELECT user_id::text FROM (
           SELECT user_id FROM academy.cert_enrollments WHERE left_at IS NULL
           UNION SELECT user_id FROM academy.course_enrolments WHERE left_at IS NULL
         ) people
         WHERE ($1::text IS NULL
                OR EXISTS (SELECT 1 FROM academy.learner_tags t WHERE t.user_id = people.user_id AND t.tag = $1::text))
           AND ($2::text::uuid IS NULL OR user_id > $2::text::uuid)
         ORDER BY user_id
         LIMIT $3::int8",
        &[&tag, &after, &limit],
    )?;
    found.iter().map(|r| col(r, 0)).collect()
}

/// One learner's summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub user_id: String,
    pub enrolments: i32,
    pub items_completed: i32,
    pub last_active_at: Option<Instant>,
    pub tags: Vec<String>,
}

impl Summary {
    fn json(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("enrolments", int(self.enrolments)),
            ("itemsCompleted", int(self.items_completed)),
            ("lastActiveAt", iso_opt(self.last_active_at)),
            ("tags", strs(&self.tags)),
        ])
    }
}

/// The summary of each learner in `users`, in that order.
pub fn summaries_of<C: GenericClient>(
    db: &mut C,
    users: &[String],
) -> Result<Vec<Summary>, Refusal> {
    if users.is_empty() {
        return Ok(Vec::new());
    }
    let counts = rows(
        db,
        &format!(
            "SELECT u.user_id::text,
               (SELECT count(*) FROM academy.cert_enrollments e WHERE e.user_id = u.user_id AND e.left_at IS NULL)::int
                 + (SELECT count(*) FROM academy.course_enrolments c WHERE c.user_id = u.user_id AND c.left_at IS NULL)::int AS enrolments,
               (SELECT count(*) FROM academy.cert_item_completions i WHERE i.user_id = u.user_id)::int AS items,
               {} AS last_active
             FROM unnest($1::text[]::uuid[]) AS u(user_id)",
            ms("GREATEST(
                 (SELECT max(touched_at) FROM academy.learning_touches t WHERE t.user_id = u.user_id),
                 (SELECT max(completed_at) FROM academy.cert_item_completions i WHERE i.user_id = u.user_id),
                 (SELECT max(enrolled_at) FROM academy.cert_enrollments e WHERE e.user_id = u.user_id),
                 (SELECT max(enrolled_at) FROM academy.course_enrolments c WHERE c.user_id = u.user_id)
               )")
        ),
        &[&users],
    )?;
    let tags = rows(
        db,
        "SELECT user_id::text, tag FROM academy.learner_tags WHERE user_id = ANY($1::text[]::uuid[]) ORDER BY tag",
        &[&users],
    )?;
    let mut out = Vec::new();
    for u in users {
        let mut found = None;
        for c in &counts {
            if col::<String>(c, 0)? == *u {
                found = Some(c);
                break;
            }
        }
        let (enrolments, items, last) = match found {
            Some(c) => (col(c, 1)?, col(c, 2)?, at_opt(c, 3)?),
            None => (0, 0, None),
        };
        let mut own = Vec::new();
        for t in &tags {
            if col::<String>(t, 0)? == *u {
                own.push(col::<String>(t, 1)?);
            }
        }
        out.push(Summary {
            user_id: u.clone(),
            enrolments,
            items_completed: items,
            last_active_at: last,
            tags: own,
        });
    }
    Ok(out)
}

/// One page of learner summaries; the page size is the owner's (`ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE`).
pub fn summaries_page(
    pool: &Db<'_>,
    page_size: Option<i64>,
    tag: Option<&str>,
    after: Option<&str>,
) -> Result<Json, Refusal> {
    let page_size = setting(page_size, "academy.learner_summaries_list_limit_unset")?;
    with_client(pool.get()?, |db| {
        let ids = learner_ids(db, tag, after, page_size + 1)?;
        let keep = usize::try_from(page_size).unwrap_or(usize::MAX);
        let page: Vec<String> = ids.iter().take(keep).cloned().collect();
        let summaries = summaries_of(db, &page)?;
        let next = if ids.len() > keep {
            page.last().cloned()
        } else {
            None
        };
        Ok(Json::obj([
            ("tag", str_opt(tag.map(str::to_owned))),
            ("pageSize", Json::int(page_size)),
            (
                "rows",
                Json::Array(summaries.iter().map(Summary::json).collect()),
            ),
            ("next", str_opt(next)),
        ]))
    })
}

/// The learners report as CSV: its number, when it was made and its filter on the first line, then one row a learner,
/// each line ended `\r\n`.
pub fn learners_report_csv(
    n: i32,
    tag: Option<&str>,
    made_at: Instant,
    summaries: &[Summary],
) -> String {
    let line = |cells: &[String]| {
        cells
            .iter()
            .map(|c| csv_field(c))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut lines = vec![
        line(&[
            "learners report".to_owned(),
            n.to_string(),
            "made at".to_owned(),
            made_at.iso(),
            "tag".to_owned(),
            tag.unwrap_or("every learner").to_owned(),
        ]),
        line(&[
            "learner".to_owned(),
            "enrolments".to_owned(),
            "items completed".to_owned(),
            "last active".to_owned(),
            "tags".to_owned(),
        ]),
    ];
    for s in summaries {
        lines.push(line(&[
            s.user_id.clone(),
            s.enrolments.to_string(),
            s.items_completed.to_string(),
            s.last_active_at
                .map_or_else(|| "not recorded".to_owned(), Instant::iso),
            s.tags.join(" "),
        ]));
    }
    format!("{}\r\n", lines.join("\r\n"))
}

/// The owner's values the reports centre reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReportSettings {
    pub page_size: Option<i64>,
    pub retention_minutes: Option<i64>,
    pub row_limit: Option<i64>,
    pub sweep_seconds: Option<i64>,
}

fn columns() -> String {
    format!(
        "id::text, requested_by::text, n, kind, tag, state, {}, {}, {}, {}, rows, sha256, failure, {}",
        ms("requested_at"),
        ms("started_at"),
        ms("finished_at"),
        ms("expires_at"),
        ms("deleted_at")
    )
}

fn view_fields(r: &Row, now: Instant) -> Result<Vec<(String, Json)>, Refusal> {
    let state: String = col(r, 5)?;
    let expires = at_opt(r, 9)?;
    let rows_n: Option<i32> = col(r, 10)?;
    Ok(vec![
        ("id".to_owned(), Json::str(col::<String>(r, 0)?)),
        ("n".to_owned(), int(col(r, 2)?)),
        ("kind".to_owned(), Json::str(col::<String>(r, 3)?)),
        ("tag".to_owned(), str_opt(col(r, 4)?)),
        ("state".to_owned(), Json::str(state.clone())),
        ("requestedBy".to_owned(), Json::str(col::<String>(r, 1)?)),
        ("requestedAt".to_owned(), iso(at(r, 6)?)),
        ("startedAt".to_owned(), iso_opt(at_opt(r, 7)?)),
        ("finishedAt".to_owned(), iso_opt(at_opt(r, 8)?)),
        ("expiresAt".to_owned(), iso_opt(expires)),
        (
            "expired".to_owned(),
            Json::Bool(state == "done" && expires.is_some_and(|e| e.0 <= now.0)),
        ),
        ("rows".to_owned(), rows_n.map_or(Json::Null, int)),
        ("sha256".to_owned(), str_opt(col(r, 11)?)),
        ("failure".to_owned(), str_opt(col(r, 12)?)),
    ])
}

fn view(r: &Row, now: Instant) -> Result<Json, Refusal> {
    Ok(Json::Object(view_fields(r, now)?))
}

fn event<C: GenericClient>(
    tx: &mut C,
    task_id: &str,
    event: &str,
    actor_id: Option<&str>,
    at: Instant,
) -> Result<(), Refusal> {
    exec(
        tx,
        "INSERT INTO academy.report_centre_events (task_id, n, event, actor_id, at)
         SELECT $1::text::uuid, coalesce(max(n), 0) + 1, $2::text, $3::text::uuid, $4::text::timestamptz
           FROM academy.report_centre_events WHERE task_id = $1::text::uuid",
        &[&task_id, &event, &actor_id, &at.iso()],
    )?;
    Ok(())
}

fn next_n<C: GenericClient>(tx: &mut C, actor_id: &str) -> Result<i32, Refusal> {
    match first(
        tx,
        "SELECT coalesce(max(n), 0)::int + 1 AS next FROM academy.report_centre_tasks WHERE requested_by = $1::text::uuid",
        &[&actor_id],
    )? {
        Some(r) => col(&r, 0),
        None => Ok(1),
    }
}

fn undefined() -> Refusal {
    Refusal::Internal {
        message: "Cannot read properties of undefined (reading 'id')".to_owned(),
        code: None,
    }
}

/// Every task not deleted, newest first, up to the owner's page size, and the number the caller's next request takes.
pub fn list(
    pool: &Db<'_>,
    settings: &ReportSettings,
    actor_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let page_size = setting(settings.page_size, "academy.report_tasks_list_limit_unset")?;
    with_client(pool.get()?, |db| {
        let tasks = rows(
            db,
            &format!(
                "SELECT {} FROM academy.report_centre_tasks
                  WHERE deleted_at IS NULL ORDER BY requested_at DESC, id LIMIT $1::int8",
                columns()
            ),
            &[&page_size],
        )?;
        let views = tasks
            .iter()
            .map(|r| view(r, now))
            .collect::<Result<Vec<_>, _>>()?;
        let next = next_n(db, actor_id)?;
        Ok(Json::obj([
            ("pageSize", Json::int(page_size)),
            ("tasks", Json::Array(views)),
            ("nextN", int(next)),
        ]))
    })
}

/// Task n of this founder: queued now when n is their next, the stored one when it already exists.
pub fn request(
    pool: &Db<'_>,
    settings: &ReportSettings,
    actor_id: &str,
    kind: &str,
    tag: Option<&str>,
    n: i64,
    now: Instant,
) -> Result<Json, Refusal> {
    setting(settings.retention_minutes, "academy.report_retention_unset")?;
    setting(settings.row_limit, "academy.report_limit_unset")?;
    setting(settings.sweep_seconds, "academy.report_sweep_unset")?;
    let n32 = i32::try_from(n).unwrap_or(i32::MAX);
    begin(pool.get()?, |tx| {
        // One request per founder at a time, so two presses cannot both take the next number.
        exec(
            tx,
            "SELECT pg_advisory_xact_lock(hashtext($1::text))",
            &[&format!("report:{actor_id}")],
        )?;
        if let Some(existing) = first(
            tx,
            &format!(
                "SELECT {} FROM academy.report_centre_tasks WHERE requested_by = $1::text::uuid AND n = $2::int4",
                columns()
            ),
            &[&actor_id, &n32],
        )? {
            return view(&existing, now);
        }
        let next = next_n(tx, actor_id)?;
        if i64::from(next) != n {
            return Err(refuse(
                "academy.report_out_of_order",
                &format!("your next report request is {next}, not {n}"),
            ));
        }
        let made = first(
            tx,
            &format!(
                "INSERT INTO academy.report_centre_tasks (requested_by, n, kind, tag, state, requested_at)
                 VALUES ($1::text::uuid, $2::int4, $3::text, $4::text, 'queued', $5::text::timestamptz)
                 RETURNING {}",
                columns()
            ),
            &[&actor_id, &n32, &kind, &tag, &now.iso()],
        )?
        .ok_or_else(undefined)?;
        let id: String = col(&made, 0)?;
        event(tx, &id, "requested", Some(actor_id), now)?;
        view(&made, now)
    })
}

/// Stops a queued or running task. Aborting an aborted task answers it again; any other state refuses.
pub fn abort(pool: &Db<'_>, actor_id: &str, task_id: &str, now: Instant) -> Result<Json, Refusal> {
    begin(pool.get()?, |tx| {
        let task = first(
            tx,
            &format!(
                "SELECT {} FROM academy.report_centre_tasks WHERE id = $1::text::uuid AND deleted_at IS NULL FOR UPDATE",
                columns()
            ),
            &[&task_id],
        )?
        .ok_or_else(|| refuse("academy.report_not_found", "no report task has that id"))?;
        let state: String = col(&task, 5)?;
        if state == "aborted" {
            return view(&task, now);
        }
        if state != "queued" && state != "running" {
            return Err(refuse(
                "academy.report_not_abortable",
                &format!("the task is {state}, so there is nothing to abort"),
            ));
        }
        let done = first(
            tx,
            &format!(
                "UPDATE academy.report_centre_tasks SET state = 'aborted', finished_at = $1::text::timestamptz
                  WHERE id = $2::text::uuid RETURNING {}",
                columns()
            ),
            &[&now.iso(), &task_id],
        )?
        .ok_or_else(undefined)?;
        event(tx, task_id, "aborted", Some(actor_id), now)?;
        view(&done, now)
    })
}

/// Takes a task off the list and drops its file. Deleting a deleted task answers the same.
pub fn delete(pool: &Db<'_>, actor_id: &str, task_id: &str, now: Instant) -> Result<Json, Refusal> {
    let answer = || {
        Json::obj([
            ("taskId", Json::str(task_id)),
            ("deleted", Json::Bool(true)),
        ])
    };
    begin(pool.get()?, |tx| {
        let task = first(
            tx,
            &format!(
                "SELECT {} FROM academy.report_centre_tasks WHERE id = $1::text::uuid FOR UPDATE",
                columns()
            ),
            &[&task_id],
        )?
        .ok_or_else(|| refuse("academy.report_not_found", "no report task has that id"))?;
        if at_opt(&task, 13)?.is_some() {
            return Ok(answer());
        }
        exec(
            tx,
            "UPDATE academy.report_centre_tasks SET deleted_at = $1::text::timestamptz, csv = NULL WHERE id = $2::text::uuid",
            &[&now.iso(), &task_id],
        )?;
        event(tx, task_id, "deleted", Some(actor_id), now)?;
        Ok(answer())
    })
}

/// A done task's stored CSV, exactly as it was made, while its retention lasts.
pub fn file(pool: &Db<'_>, task_id: &str, now: Instant) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let task = first(
            db,
            &format!(
                "SELECT {}, csv FROM academy.report_centre_tasks WHERE id = $1::text::uuid AND deleted_at IS NULL",
                columns()
            ),
            &[&task_id],
        )?
        .ok_or_else(|| refuse("academy.report_not_found", "no report task has that id"))?;
        let state: String = col(&task, 5)?;
        if state != "done" {
            return Err(refuse(
                "academy.report_not_ready",
                &format!("the task is {state}, so it has no file"),
            ));
        }
        let expires = at_opt(&task, 9)?;
        let csv: Option<String> = col(&task, 14)?;
        let Some(csv) = csv.filter(|_| !expires.is_some_and(|e| e.0 <= now.0)) else {
            let when = expires.map_or_else(|| "null".to_owned(), Instant::iso);
            return Err(refuse(
                "academy.report_expired",
                &format!("the file expired at {when}"),
            ));
        };
        let mut fields = view_fields(&task, now)?;
        fields.push(("csv".to_owned(), Json::str(csv)));
        Ok(Json::Object(fields))
    })
}

/// What one sweep did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Swept {
    pub finished: usize,
    pub started: usize,
}

/// One pass of the report sweep: drops expired files, finishes the tasks already running, then starts the queued ones.
pub fn sweep(pool: &Pool, settings: &ReportSettings, now: Instant) -> Result<Swept, Refusal> {
    let expired = with_client(pool, |db| {
        rows(
            db,
            "UPDATE academy.report_centre_tasks SET csv = NULL
              WHERE state = 'done' AND csv IS NOT NULL AND expires_at <= $1::text::timestamptz RETURNING id::text",
            &[&now.iso()],
        )
    })?;
    for r in &expired {
        let id: String = col(r, 0)?;
        with_client(pool, |db| event(db, &id, "expired", None, now))?;
    }
    let running = with_client(pool, |db| {
        rows(
            db,
            "SELECT id::text FROM academy.report_centre_tasks WHERE state = 'running' AND deleted_at IS NULL ORDER BY requested_at",
            &[],
        )
    })?;
    let mut finished = 0;
    for r in &running {
        let id: String = col(r, 0)?;
        if finish(pool, settings, &id, now)? {
            finished += 1;
        }
    }
    let started = with_client(pool, |db| {
        rows(
            db,
            "UPDATE academy.report_centre_tasks SET state = 'running', started_at = $1::text::timestamptz
              WHERE state = 'queued' AND deleted_at IS NULL RETURNING id::text",
            &[&now.iso()],
        )
    })?;
    for r in &started {
        let id: String = col(r, 0)?;
        with_client(pool, |db| event(db, &id, "started", None, now))?;
    }
    Ok(Swept {
        finished,
        started: started.len(),
    })
}

/// Makes one running task's file, or fails it with the refusal that stops it. False when it was no longer running.
fn finish(
    pool: &Pool,
    settings: &ReportSettings,
    task_id: &str,
    now: Instant,
) -> Result<bool, Refusal> {
    begin(pool, |tx| {
        let Some(task) = first(
            tx,
            &format!(
                "SELECT {} FROM academy.report_centre_tasks
                  WHERE id = $1::text::uuid AND state = 'running' AND deleted_at IS NULL FOR UPDATE SKIP LOCKED",
                columns()
            ),
            &[&task_id],
        )?
        else {
            return Ok(false);
        };
        let fail = |tx: &mut postgres::Transaction<'_>, failure: &str| -> Result<bool, Refusal> {
            exec(
                tx,
                "UPDATE academy.report_centre_tasks SET state = 'failed', failure = $1::text, finished_at = $2::text::timestamptz
                  WHERE id = $3::text::uuid",
                &[&failure, &now.iso(), &task_id],
            )?;
            event(tx, task_id, "failed", None, now)?;
            Ok(true)
        };
        let Some(row_limit) = settings.row_limit else {
            return fail(tx, "academy.report_limit_unset");
        };
        let Some(retention) = settings.retention_minutes else {
            return fail(tx, "academy.report_retention_unset");
        };
        let tag: Option<String> = col(&task, 4)?;
        let n: i32 = col(&task, 2)?;
        let ids = learner_ids(tx, tag.as_deref(), None, row_limit + 1)?;
        if i64::try_from(ids.len()).unwrap_or(i64::MAX) > row_limit {
            return fail(tx, "academy.report_too_large");
        }
        let summaries = summaries_of(tx, &ids)?;
        let csv = learners_report_csv(n, tag.as_deref(), now, &summaries);
        let sha = sha256_hex(&csv);
        let expires = Instant(now.0 + retention * 60_000);
        let count = i32::try_from(summaries.len()).unwrap_or(i32::MAX);
        exec(
            tx,
            "UPDATE academy.report_centre_tasks
                SET state = 'done', csv = $1::text, rows = $2::int4, sha256 = $3::text, finished_at = $4::text::timestamptz,
                    expires_at = $5::text::timestamptz
              WHERE id = $6::text::uuid",
            &[&csv, &count, &sha, &now.iso(), &expires.iso(), &task_id],
        )?;
        event(tx, task_id, "done", None, now)?;
        Ok(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_csv_ends_every_line_with_crlf() {
        let csv = learners_report_csv(
            3,
            None,
            Instant(0),
            &[Summary {
                user_id: "u".to_owned(),
                enrolments: 2,
                items_completed: 5,
                last_active_at: None,
                tags: vec!["a".to_owned(), "b".to_owned()],
            }],
        );
        assert_eq!(
            csv,
            "learners report,3,made at,1970-01-01T00:00:00.000Z,tag,every learner\r\n\
             learner,enrolments,items completed,last active,tags\r\nu,2,5,not recorded,a b\r\n"
        );
    }
}
