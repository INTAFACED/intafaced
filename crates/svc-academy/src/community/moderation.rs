//! AC-rooms-02 (J-academy-18): reports, the moderation queue, and deleting posts with a reason
//! (`curriculum/moderation.ts`).
//!
//! One report per account per post. The queue lists reported entries still showing, oldest report first. A moderator
//! (`admin:write` and `discussion.moderate` on the course) deletes with a reason: a state move, never a row delete.
//! Each action is an append-only event keyed on the business, and its author's notice waits in the outbox
//! (`notified_at IS NULL`) until the bus took it; every later action and every boot sends what is still waiting.
//! No money moves.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::time::Instant;

use super::Db;
use super::team;
use super::{
    academy, at, col, exec, first, int, iso, js_trim, random_uuid, rows, serializable, str_opt,
    strs,
};
use crate::db::with_client;
use crate::errors::Refusal;
use crate::ports::Bus;

/// The subject of `academyDiscussionPostDeleted` (version 1).
pub const SUBJECT: &str = "intafaced.academy.discussion_post.deleted";

/// What the author is told: one notice per moderation event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub event_id: String,
    pub author_id: String,
    pub course_title: String,
    pub posts: i32,
    pub reason: String,
}

/// Who is moderating.
#[derive(Debug, Clone, Copy)]
pub struct Moderator<'a> {
    pub user_id: &'a str,
    pub may_write: bool,
}

const EVENT_COLUMNS: &str = "id::text, course_id::text, action, post_id::text, author_id::text, posts, actor_id::text, reason, \
     floor(extract(epoch from recorded_at)*1000)::int8";

fn event_view(row: &Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("id", Json::str(col::<String>(row, 0)?)),
        ("courseId", Json::str(col::<String>(row, 1)?)),
        ("action", Json::str(col::<String>(row, 2)?)),
        ("postId", str_opt(col(row, 3)?)),
        ("authorId", Json::str(col::<String>(row, 4)?)),
        ("posts", int(col(row, 5)?)),
        ("actorId", Json::str(col::<String>(row, 6)?)),
        ("reason", Json::str(col::<String>(row, 7)?)),
        ("recordedAt", iso(at(row, 8)?)),
    ]))
}

fn require_reason(reason: &str) -> Result<String, Refusal> {
    let trimmed = js_trim(reason);
    if trimmed.is_empty() {
        return Err(academy(
            "academy.reason_required",
            "academy.reason_required a deletion keeps who made it and why",
        ));
    }
    Ok(trimmed.to_owned())
}

const SHOWING_PARENT: &str = "(p.parent_id IS NULL OR EXISTS (SELECT 1 FROM academy.discussion_posts t WHERE t.id = p.parent_id AND t.removed_at IS NULL))";

/// A learner enrolled in the published course reports a post or reply that is still showing.
pub fn report(
    pool: &Db<'_>,
    user_id: &str,
    post_id: &str,
    reason: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        report_on(db, user_id, post_id, reason, now)
    })
}

fn report_on(
    db: &mut postgres::Client,
    user_id: &str,
    post_id: &str,
    reason: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let post = first(
        db,
        &format!(
            "SELECT p.id::text, p.course_id::text FROM academy.discussion_posts p JOIN academy.courses c ON c.id = p.course_id
              WHERE p.id = $1::text::uuid AND p.removed_at IS NULL AND c.state = 'published' AND {SHOWING_PARENT}"
        ),
        &[&post_id],
    )?
    .ok_or_else(|| academy("academy.post_not_found", format!("academy.post_not_found post={post_id}")))?;
    let id: String = col(&post, 0)?;
    let course_id: String = col(&post, 1)?;
    if first(
        db,
        "SELECT 1 FROM academy.course_enrolments WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND left_at IS NULL",
        &[&course_id, &user_id],
    )?
    .is_none()
    {
        return Err(academy(
            "academy.enrolment_required",
            "academy.enrolment_required enrol in this course to report in its discussion",
        ));
    }
    let reason = js_trim(reason);
    if reason.is_empty() {
        return Err(academy(
            "academy.reason_required",
            "academy.reason_required say why you report it",
        ));
    }
    let inserted = rows(
        db,
        "INSERT INTO academy.discussion_reports (post_id, reporter_id, reason, created_at)
         VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4::text::timestamptz)
         ON CONFLICT (post_id, reporter_id) DO NOTHING
         RETURNING post_id",
        &[&id, &user_id, &reason, &now.iso()],
    )?;
    Ok(Json::obj([
        ("postId", Json::str(id)),
        ("reported", Json::Bool(inserted.len() == 1)),
    ]))
}

/// Reported entries still showing, oldest report first, and the moderation events newest first.
pub fn queue(
    pool: &Db<'_>,
    course_id: Option<&str>,
    limit: i64,
    caller: Moderator<'_>,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| queue_on(db, course_id, limit, caller))
}

fn queue_on(
    db: &mut postgres::Client,
    course_id: Option<&str>,
    limit: i64,
    caller: Moderator<'_>,
) -> Result<Json, Refusal> {
    let report_sql = |filter: &str, limit_at: &str| {
        format!(
            "SELECT p.id::text, p.course_id::text, c.slug, c.title AS course_title, p.parent_id::text, p.title, p.body,
                    p.author_id::text, p.anonymous, floor(extract(epoch from p.created_at)*1000)::int8,
                    count(r.*)::int AS reports, array_agg(r.reason ORDER BY r.created_at) AS reasons,
                    floor(extract(epoch from min(r.created_at))*1000)::int8 AS first_at
               FROM academy.discussion_reports r
               JOIN academy.discussion_posts p ON p.id = r.post_id
               JOIN academy.courses c ON c.id = p.course_id
              WHERE p.removed_at IS NULL AND {SHOWING_PARENT} {filter}
              GROUP BY p.id, c.slug, c.title
              ORDER BY min(r.created_at), p.id
              LIMIT {limit_at}"
        )
    };
    let event_sql = |filter: &str, limit_at: &str| {
        format!(
            "SELECT {EVENT_COLUMNS} FROM academy.moderation_events {filter} ORDER BY recorded_at DESC, id LIMIT {limit_at}"
        )
    };
    let (reports, events) = match course_id {
        Some(c) => (
            rows(
                db,
                &report_sql("AND p.course_id = $1::text::uuid", "$2::int8"),
                &[&c, &limit],
            )?,
            rows(
                db,
                &event_sql("WHERE course_id = $1::text::uuid", "$2::int8"),
                &[&c, &limit],
            )?,
        ),
        None => (
            rows(db, &report_sql("", "$1::int8"), &[&limit])?,
            rows(db, &event_sql("", "$1::int8"), &[&limit])?,
        ),
    };
    let mut may: Vec<(String, bool)> = Vec::new();
    let mut list = Vec::new();
    for r in &reports {
        let id: String = col(r, 0)?;
        let course: String = col(r, 1)?;
        let parent: Option<String> = col(r, 4)?;
        let may_moderate = if !caller.may_write {
            false
        } else if let Some((_, m)) = may.iter().find(|(c, _)| *c == course) {
            *m
        } else {
            let m = team::permissions_of(db, caller.user_id, Some(&course))?
                .permissions
                .iter()
                .any(|p| p == "discussion.moderate");
            may.push((course.clone(), m));
            m
        };
        list.push(Json::obj([
            ("postId", Json::str(id.clone())),
            ("courseId", Json::str(course)),
            ("courseSlug", Json::str(col::<String>(r, 2)?)),
            ("courseTitle", Json::str(col::<String>(r, 3)?)),
            ("threadId", Json::str(parent.clone().unwrap_or(id))),
            ("isReply", Json::Bool(parent.is_some())),
            ("title", str_opt(col(r, 5)?)),
            ("body", Json::str(col::<String>(r, 6)?)),
            ("authorId", Json::str(col::<String>(r, 7)?)),
            ("anonymous", Json::Bool(col(r, 8)?)),
            ("postedAt", iso(at(r, 9)?)),
            ("reports", int(col(r, 10)?)),
            ("reasons", strs(&col::<Vec<String>>(r, 11)?)),
            ("firstReportedAt", iso(at(r, 12)?)),
            ("mayModerate", Json::Bool(may_moderate)),
        ]));
    }
    let events = events
        .iter()
        .map(event_view)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json::obj([
        ("reports", Json::Array(list)),
        ("events", Json::Array(events)),
        ("mayWrite", Json::Bool(caller.may_write)),
    ]))
}

fn require_write(caller: Moderator<'_>) -> Result<(), Refusal> {
    if !caller.may_write {
        return Err(academy(
            "academy.permission_denied",
            "academy.permission_denied this session may read the queue but not delete",
        ));
    }
    Ok(())
}

/// Where the outbox drains to after an action: the bus, the producer's name, and where a failure is told.
pub struct Outbox<'a> {
    pub bus: &'a dyn Bus,
    pub producer: &'a str,
    pub log: &'a dyn Fn(&str, &str),
}

/// Delete one post (its replies leave learner reads with it) or one reply, with a reason. A repeat answers with the
/// first event.
pub fn delete_post(
    pool: &Db<'_>,
    outbox: &Outbox<'_>,
    post_id: &str,
    reason: &str,
    caller: Moderator<'_>,
    now: Instant,
) -> Result<Json, Refusal> {
    require_write(caller)?;
    let reason = require_reason(reason)?;
    let event = serializable(pool.get()?, |tx| {
        let post = first(
            tx,
            "SELECT id::text, course_id::text, author_id::text, removed_at IS NOT NULL
               FROM academy.discussion_posts WHERE id = $1::text::uuid FOR UPDATE",
            &[&post_id],
        )?
        .ok_or_else(|| {
            academy(
                "academy.post_not_found",
                format!("academy.post_not_found post={post_id}"),
            )
        })?;
        let id: String = col(&post, 0)?;
        let course: String = col(&post, 1)?;
        let author: String = col(&post, 2)?;
        let removed: bool = col(&post, 3)?;
        team::require(tx, caller.user_id, Some(&course), "discussion.moderate")?;
        let key = format!("moderate:{id}:delete");
        if let Some(again) = first(
            tx,
            &format!(
                "SELECT {EVENT_COLUMNS} FROM academy.moderation_events WHERE event_key = $1::text"
            ),
            &[&key],
        )? {
            return event_view(&again);
        }
        if removed {
            return Err(academy(
                "academy.post_not_found",
                format!("academy.post_not_found post={post_id}"),
            ));
        }
        exec(
            tx,
            "UPDATE academy.discussion_posts SET removed_at = $1::text::timestamptz, removed_by = $2::text::uuid, removed_reason = $3::text
              WHERE id = $4::text::uuid",
            &[&now.iso(), &caller.user_id, &reason, &id],
        )?;
        let row = first(
            tx,
            &format!(
                "INSERT INTO academy.moderation_events (course_id, action, post_id, author_id, posts, actor_id, reason, event_key, recorded_at)
                 VALUES ($1::text::uuid, 'delete', $2::text::uuid, $3::text::uuid, 1, $4::text::uuid, $5::text, $6::text, $7::text::timestamptz)
                 RETURNING {EVENT_COLUMNS}"
            ),
            &[&course, &id, &author, &caller.user_id, &reason, &key, &now.iso()],
        )?
        .ok_or_else(|| Refusal::Internal {
            message: "Cannot read properties of undefined (reading 'id')".to_owned(),
            code: None,
        })?;
        event_view(&row)
    })?;
    send_waiting(pool, outbox)?;
    Ok(Json::obj([("event", event)]))
}

/// Delete every post and reply of one author in one course that is still showing; their posts elsewhere stay.
pub fn bulk_delete(
    pool: &Db<'_>,
    outbox: &Outbox<'_>,
    course_id: &str,
    author_id: &str,
    reason: &str,
    caller: Moderator<'_>,
    now: Instant,
) -> Result<Json, Refusal> {
    require_write(caller)?;
    let reason = require_reason(reason)?;
    let event = serializable(pool.get()?, |tx| {
        if first(
            tx,
            "SELECT 1 FROM academy.courses WHERE id = $1::text::uuid",
            &[&course_id],
        )?
        .is_none()
        {
            return Err(academy(
                "academy.course_not_found",
                format!("academy.course_not_found course={course_id}"),
            ));
        }
        team::require(tx, caller.user_id, Some(course_id), "discussion.moderate")?;
        let lock = format!("moderate:{course_id}:{author_id}");
        exec(
            tx,
            "SELECT pg_advisory_xact_lock(hashtext($1::text))",
            &[&lock],
        )?;
        let removed = rows(
            tx,
            "UPDATE academy.discussion_posts SET removed_at = $1::text::timestamptz, removed_by = $2::text::uuid, removed_reason = $3::text
              WHERE course_id = $4::text::uuid AND author_id = $5::text::uuid AND removed_at IS NULL
             RETURNING id",
            &[&now.iso(), &caller.user_id, &reason, &course_id, &author_id],
        )?;
        let count = first(
            tx,
            "SELECT count(*)::int AS n FROM academy.moderation_events
              WHERE course_id = $1::text::uuid AND author_id = $2::text::uuid AND action = 'bulk_delete'",
            &[&course_id, &author_id],
        )?;
        let n: i32 = match &count {
            Some(r) => col(r, 0)?,
            None => 0,
        };
        let key = format!("moderate:{course_id}:{author_id}:bulk:{}", i64::from(n) + 1);
        let posts = i32::try_from(removed.len()).unwrap_or(i32::MAX);
        let notified: Option<String> = (posts == 0).then(|| now.iso());
        let row = first(
            tx,
            &format!(
                "INSERT INTO academy.moderation_events (course_id, action, post_id, author_id, posts, actor_id, reason, event_key, recorded_at, notified_at)
                 VALUES ($1::text::uuid, 'bulk_delete', NULL, $2::text::uuid, $3::int4, $4::text::uuid, $5::text, $6::text,
                         $7::text::timestamptz, $8::text::timestamptz)
                 RETURNING {EVENT_COLUMNS}"
            ),
            &[&course_id, &author_id, &posts, &caller.user_id, &reason, &key, &now.iso(), &notified],
        )?
        .ok_or_else(|| Refusal::Internal {
            message: "Cannot read properties of undefined (reading 'id')".to_owned(),
            code: None,
        })?;
        event_view(&row)
    })?;
    send_waiting(pool, outbox)?;
    Ok(Json::obj([("event", event)]))
}

/// JavaScript's `String.length`: UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `validatePayload` for `academyDiscussionPostDeleted`: the catalog's schema, checked before anything is sent.
fn validate(n: &Notice) -> Result<(), String> {
    let mut issues = Vec::new();
    if !is_guid(&n.event_id) {
        issues.push("eventId: Invalid guid");
    }
    if !is_guid(&n.author_id) {
        issues.push("authorId: Invalid uuid");
    }
    let title = js_len(&n.course_title);
    if !(1..=200).contains(&title) {
        issues.push("courseTitle: length out of range");
    }
    if n.posts < 1 {
        issues.push("posts: Number must be greater than 0");
    }
    let reason = js_len(&n.reason);
    if !(1..=500).contains(&reason) {
        issues.push("reason: length out of range");
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "academy.discussion_post.deleted payload rejected: {}",
            issues.join("; ")
        ))
    }
}

/// The envelope `buildEnvelope` makes, in its key order.
pub fn envelope(n: &Notice, producer: &str, envelope_id: String, occurred_at: Instant) -> Json {
    Json::obj([
        ("id", Json::str(envelope_id)),
        ("subject", Json::str(SUBJECT)),
        ("version", Json::int(1)),
        ("occurredAt", iso(occurred_at)),
        ("producer", Json::str(producer)),
        ("idempotencyKey", Json::str(idempotency_key(&n.event_id))),
        (
            "payload",
            Json::obj([
                ("eventId", Json::str(n.event_id.clone())),
                ("authorId", Json::str(n.author_id.clone())),
                ("courseTitle", Json::str(n.course_title.clone())),
                ("posts", int(n.posts)),
                ("reason", Json::str(n.reason.clone())),
            ]),
        ),
    ])
}

/// `academy.moderation:<eventId>`: the bus deduplicates a notice sent twice (a crash between the publish and the
/// `notified_at` write) on this key.
pub fn idempotency_key(event_id: &str) -> String {
    format!("academy.moderation:{event_id}")
}

fn publish(outbox: &Outbox<'_>, n: &Notice) -> Result<(), String> {
    validate(n)?;
    let id = random_uuid().map_err(|e| format!("{e:?}"))?;
    let env = envelope(n, outbox.producer, id, super::clock());
    outbox
        .bus
        .publish(SUBJECT, &idempotency_key(&n.event_id), &env)
}

/// Send every author notice still waiting, oldest first. A failure leaves it waiting for the next action or boot. With
/// no bus (`notices` null) nothing is read and nothing is sent.
pub fn send_waiting(pool: &Db<'_>, outbox: &Outbox<'_>) -> Result<usize, Refusal> {
    if !outbox.bus.usable() {
        return Ok(0);
    }
    with_client(pool.get()?, |db| send_waiting_on(db, outbox))
}

/// `send_waiting` on a connection already held.
pub fn send_waiting_on<C: GenericClient>(
    db: &mut C,
    outbox: &Outbox<'_>,
) -> Result<usize, Refusal> {
    if !outbox.bus.usable() {
        return Ok(0);
    }
    let waiting = rows(
        db,
        "SELECT e.id::text, e.author_id::text, e.posts, e.reason, c.title AS course_title
           FROM academy.moderation_events e JOIN academy.courses c ON c.id = e.course_id
          WHERE e.notified_at IS NULL ORDER BY e.recorded_at, e.id LIMIT 100",
        &[],
    )?;
    let mut sent = 0;
    for w in &waiting {
        let notice = Notice {
            event_id: col(w, 0)?,
            author_id: col(w, 1)?,
            posts: col(w, 2)?,
            reason: col(w, 3)?,
            course_title: col(w, 4)?,
        };
        let done = publish(outbox, &notice).and_then(|()| {
            exec(
                db,
                "UPDATE academy.moderation_events SET notified_at = now() WHERE id = $1::text::uuid AND notified_at IS NULL",
                &[&notice.event_id],
            )
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
        });
        match done {
            Ok(()) => sent += 1,
            Err(e) => {
                (outbox.log)(&e, &notice.event_id);
                break;
            }
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice() -> Notice {
        Notice {
            event_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            author_id: "22222222-2222-4222-8222-222222222222".to_owned(),
            course_title: "Risk".to_owned(),
            posts: 2,
            reason: "spam".to_owned(),
        }
    }

    #[test]
    fn the_envelope_keeps_build_envelope_key_order_and_the_business_key() {
        let at = Instant(1_800_000_000_000);
        let env = envelope(&notice(), "svc-academy", "e".to_owned(), at).compact();
        assert_eq!(
            env,
            r#"{"id":"e","subject":"intafaced.academy.discussion_post.deleted","version":1,"occurredAt":"2027-01-15T08:00:00.000Z","producer":"svc-academy","idempotencyKey":"academy.moderation:11111111-1111-4111-8111-111111111111","payload":{"eventId":"11111111-1111-4111-8111-111111111111","authorId":"22222222-2222-4222-8222-222222222222","courseTitle":"Risk","posts":2,"reason":"spam"}}"#
        );
    }

    #[test]
    fn a_notice_the_catalog_refuses_is_never_sent() {
        assert!(validate(&notice()).is_ok());
        let zero = Notice {
            posts: 0,
            ..notice()
        };
        assert!(validate(&zero).is_err());
        let long = Notice {
            course_title: "x".repeat(201),
            ..notice()
        };
        assert!(validate(&long).is_err());
        let bad = Notice {
            event_id: "nope".to_owned(),
            ..notice()
        };
        assert!(validate(&bad).is_err());
    }
}
