//! J-academy-14: the staff desk for one learner (`learners/learner-desk.ts`).
//!
//! Staff read the learner's enrolments, access records with their events, internal notes, tags, every item of their
//! courses with its completion history, quiz attempts with any void, due dates, and one audit of every staff change. Staff
//! change, each with a reason and an event: a note, a tag, an item marked complete, a quiz attempt voided, and the
//! learner's access record. An ended record refuses `academy.grant_expired`; the first read after the end moves the row
//! to `expired` and writes that event once. Internal notes and staff ids never reach a learner read. No money moves here.
//!
//! The curriculum spine (item titles and each course's items) belongs to the curriculum slice; this module reads it
//! through `curriculum::spine` and never holds a copy.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::time::Instant;

use super::Db;
use super::{
    academy, at, at_opt, col, exec, first, int, iso, iso_opt, js_trim, ms, rows, serializable,
    str_opt, strs,
};
use crate::curriculum::spine;
use crate::db::with_client;
use crate::errors::Refusal;

/// `getCurriculumItem(slug)?.title ?? slug`.
fn title_of(slug: &str) -> String {
    spine::get(slug).map_or_else(|| slug.to_owned(), |i| i.title.clone())
}

/// `PATH_TITLES`: the titles the desk writes, in `CURRICULUM_PATHS` order.
pub const PATHS: [(&str, &str); 4] = [
    ("foundations", "Foundations"),
    ("markets", "Markets"),
    ("builder", "Builder"),
    ("sovereign", "Sovereign"),
];

fn is_path(slug: &str) -> bool {
    PATHS.iter().any(|(p, _)| *p == slug)
}

fn path_title(slug: &str) -> &str {
    PATHS
        .iter()
        .find(|(p, _)| *p == slug)
        .map_or(slug, |(_, t)| *t)
}

/// Blank after trim is not a reason, and none is ever invented.
pub fn require_reason(reason: &str) -> Result<String, Refusal> {
    let trimmed = js_trim(reason);
    if trimmed.is_empty() {
        return Err(academy(
            "academy.reason_required",
            "academy.reason_required a reason is required",
        ));
    }
    Ok(trimmed.to_owned())
}

/// `at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'`.
fn day(at: Instant) -> String {
    let iso = at.iso().replacen('T', " ", 1);
    format!("{} UTC", iso.get(..16).unwrap_or(&iso))
}

fn undefined(field: &str) -> Refusal {
    Refusal::Internal {
        message: format!("Cannot read properties of undefined (reading '{field}')"),
        code: None,
    }
}

const GRANT_COLUMNS: &str = "id::text, user_id::text, path_slug, source, reason, \
    floor(extract(epoch from starts_at)*1000)::int8, floor(extract(epoch from expires_at)*1000)::int8, state";

/// Whether the learner may open items of `path` now. No access record: the free enrolment decides. A record that has
/// ended refuses `academy.grant_expired`, and its expiry is written on this read when it is not yet.
pub fn assert_access(
    pool: &Db<'_>,
    user_id: &str,
    path: &str,
    now: Instant,
) -> Result<(), Refusal> {
    let row = with_client(pool.get()?, |db| {
        first(
            db,
            &format!(
                "SELECT {GRANT_COLUMNS} FROM academy.access_grants WHERE user_id = $1::text::uuid AND path_slug = $2::text"
            ),
            &[&user_id, &path],
        )
    })?;
    let Some(row) = row else {
        return Ok(());
    };
    let state: String = col(&row, 7)?;
    let expires = at_opt(&row, 6)?;
    if state == "granted" && expires.is_none_or(|e| e.0 > now.0) {
        return Ok(());
    }
    if state == "granted" {
        settle_expiries(pool, user_id, now)?;
    }
    let tail = if state == "revoked" {
        "revoked".to_owned()
    } else {
        format!("ended={}", expires.unwrap_or(now).iso())
    };
    Err(academy(
        "academy.grant_expired",
        format!("academy.grant_expired course={path} {tail}"),
    ))
}

/// Writes the expired event, once, for every record of this learner whose end has passed.
pub fn settle_expiries(pool: &Db<'_>, user_id: &str, now: Instant) -> Result<(), Refusal> {
    serializable(pool.get()?, |tx| {
        let due = rows(
            tx,
            &format!(
                "SELECT id::text, {} FROM academy.access_grants
                  WHERE user_id = $1::text::uuid AND state = 'granted' AND expires_at IS NOT NULL AND expires_at <= $2::text::timestamptz
                  FOR UPDATE",
                ms("expires_at")
            ),
            &[&user_id, &now.iso()],
        )?;
        for grant in &due {
            let id: String = col(grant, 0)?;
            let expires_at = at(grant, 1)?;
            let n = next_grant_event(tx, &id)?;
            exec(
                tx,
                "UPDATE academy.access_grants SET state = 'expired', updated_at = $1::text::timestamptz WHERE id = $2::text::uuid",
                &[&now.iso(), &id],
            )?;
            exec(
                tx,
                "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
                 VALUES ($1::text::uuid, $2::int4, 'expired', $3::text, null, null, $4::text::timestamptz, $4::text::timestamptz)",
                &[&id, &n, &format!("expire:{id}:{n}"), &expires_at.iso()],
            )?;
        }
        Ok(())
    })
}

fn next_grant_event<C: GenericClient>(tx: &mut C, grant_id: &str) -> Result<i32, Refusal> {
    let row = first(
        tx,
        "SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = $1::text::uuid",
        &[&grant_id],
    )?
    .ok_or_else(|| undefined("n"))?;
    col(&row, 0)
}

struct GrantEvent {
    n: i32,
    kind: String,
    reason: Option<String>,
    actor_id: Option<String>,
    expires_at: Option<Instant>,
    at: Instant,
}

struct Grant {
    id: Option<String>,
    path_slug: String,
    source: String,
    reason: Option<String>,
    starts_at: Instant,
    expires_at: Option<Instant>,
    state: String,
    events: Vec<GrantEvent>,
}

fn grant_json(g: &Grant) -> Json {
    Json::obj([
        ("id", str_opt(g.id.clone())),
        ("pathSlug", Json::str(g.path_slug.clone())),
        ("source", Json::str(g.source.clone())),
        ("reason", str_opt(g.reason.clone())),
        ("startsAt", iso(g.starts_at)),
        ("expiresAt", iso_opt(g.expires_at)),
        ("state", Json::str(g.state.clone())),
        (
            "events",
            Json::Array(
                g.events
                    .iter()
                    .map(|e| {
                        Json::obj([
                            ("n", int(e.n)),
                            ("kind", Json::str(e.kind.clone())),
                            ("reason", str_opt(e.reason.clone())),
                            ("actorId", str_opt(e.actor_id.clone())),
                            ("expiresAt", iso_opt(e.expires_at)),
                            ("at", iso(e.at)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// Every access record of the learner: the stored ones with their events, and a free one per enrolment without one.
fn access<C: GenericClient>(db: &mut C, user_id: &str) -> Result<Vec<Grant>, Refusal> {
    let grants = rows(
        db,
        &format!(
            "SELECT {GRANT_COLUMNS} FROM academy.access_grants WHERE user_id = $1::text::uuid ORDER BY created_at, id"
        ),
        &[&user_id],
    )?;
    let events = rows(
        db,
        &format!(
            "SELECT e.grant_id::text, e.n, e.kind, e.reason, e.actor_id::text, {}, {}
               FROM academy.access_grant_events e JOIN academy.access_grants g ON g.id = e.grant_id
              WHERE g.user_id = $1::text::uuid ORDER BY e.grant_id, e.n",
            ms("e.expires_at"),
            ms("e.at")
        ),
        &[&user_id],
    )?;
    let enrolments = rows(
        db,
        &format!(
            "SELECT path_slug, {} FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL ORDER BY enrolled_at",
            ms("enrolled_at")
        ),
        &[&user_id],
    )?;
    let mut held_paths: Vec<String> = Vec::new();
    let mut list = Vec::new();
    for g in &grants {
        let path: String = col(g, 2)?;
        held_paths.push(path.clone());
        if !is_path(&path) {
            continue;
        }
        let id: String = col(g, 0)?;
        let mut own = Vec::new();
        for e in &events {
            if col::<String>(e, 0)? == id {
                own.push(GrantEvent {
                    n: col(e, 1)?,
                    kind: col(e, 2)?,
                    reason: col(e, 3)?,
                    actor_id: col(e, 4)?,
                    expires_at: at_opt(e, 5)?,
                    at: at(e, 6)?,
                });
            }
        }
        list.push(Grant {
            id: Some(id),
            path_slug: path,
            source: col(g, 3)?,
            reason: col(g, 4)?,
            starts_at: at(g, 5)?,
            expires_at: at_opt(g, 6)?,
            state: col(g, 7)?,
            events: own,
        });
    }
    for e in &enrolments {
        let path: String = col(e, 0)?;
        if is_path(&path) && !held_paths.contains(&path) {
            list.push(Grant {
                id: None,
                path_slug: path,
                source: "free".to_owned(),
                reason: None,
                starts_at: at(e, 1)?,
                expires_at: None,
                state: "granted".to_owned(),
                events: Vec::new(),
            });
        }
    }
    Ok(list)
}

struct AuditRow {
    kind: String,
    at: String,
    actor_id: Option<String>,
    reason: Option<String>,
    detail: String,
}

/// The learner page. Reading it settles any access record whose end has passed.
pub fn page(pool: &Db<'_>, user_id: &str, can_change: bool, now: Instant) -> Result<Json, Refusal> {
    settle_expiries(pool, user_id, now)?;
    with_client(pool.get()?, |db| {
        let enrolments = rows(
            db,
            &format!(
                "SELECT path_slug, {}, {} FROM academy.cert_enrollments WHERE user_id = $1::text::uuid ORDER BY enrolled_at, path_slug",
                ms("enrolled_at"),
                ms("left_at")
            ),
            &[&user_id],
        )?;
        let access = access(db, user_id)?;
        let notes = rows(
            db,
            &format!(
                "SELECT n, body, author_id::text, {} FROM academy.learner_notes WHERE user_id = $1::text::uuid ORDER BY n DESC",
                ms("at")
            ),
            &[&user_id],
        )?;
        let tags = rows(
            db,
            &format!(
                "SELECT tag, added_by::text, {} FROM academy.learner_tags WHERE user_id = $1::text::uuid ORDER BY tag",
                ms("added_at")
            ),
            &[&user_id],
        )?;
        let events = rows(
            db,
            &format!(
                "SELECT kind, {}, actor_id::text, reason, detail FROM academy.learner_events WHERE user_id = $1::text::uuid",
                ms("at")
            ),
            &[&user_id],
        )?;
        let extensions = rows(
            db,
            &format!(
                "SELECT item_slug, revision, reason, {}, granted_by::text, {} FROM academy.item_extensions WHERE user_id = $1::text::uuid",
                ms("extended_until"),
                ms("granted_at")
            ),
            &[&user_id],
        )?;
        let mut audit: Vec<AuditRow> = Vec::new();
        for e in &events {
            audit.push(AuditRow {
                kind: col(e, 0)?,
                at: at(e, 1)?.iso(),
                actor_id: col(e, 2)?,
                reason: col(e, 3)?,
                detail: col(e, 4)?,
            });
        }
        for x in &extensions {
            let slug: String = col(x, 0)?;
            let title = title_of(&slug);
            audit.push(AuditRow {
                kind: "extension_granted".to_owned(),
                at: at(x, 5)?.iso(),
                actor_id: col(x, 4)?,
                reason: col(x, 2)?,
                detail: format!(
                    "{title}: due date moved to {} for this learner",
                    day(at(x, 3)?)
                ),
            });
        }
        for g in &access {
            for e in &g.events {
                let kind = match e.kind.as_str() {
                    "granted" => "grant_granted",
                    "expired" => "grant_expired",
                    _ => "grant_reinstated",
                };
                let detail = if e.kind == "expired" {
                    format!("Access to {} ended", path_title(&g.path_slug))
                } else {
                    format!(
                        "Access to {} {} ({}), {}",
                        path_title(&g.path_slug),
                        if e.kind == "granted" {
                            "granted"
                        } else {
                            "reinstated"
                        },
                        g.source,
                        e.expires_at.map_or_else(
                            || "with no end".to_owned(),
                            |x| format!("until {}", day(x))
                        )
                    )
                };
                audit.push(AuditRow {
                    kind: kind.to_owned(),
                    at: e.at.iso(),
                    actor_id: e.actor_id.clone(),
                    reason: e.reason.clone(),
                    detail,
                });
            }
        }
        // Newest first; on the same instant, by kind. The kinds are lower-case ASCII words that first differ at a letter,
        // so a byte comparison orders them as `localeCompare` does.
        audit.sort_by(|a, b| {
            if a.at == b.at {
                a.kind.cmp(&b.kind)
            } else {
                b.at.cmp(&a.at)
            }
        });
        let mut enrolled = Vec::new();
        for e in &enrolments {
            let path: String = col(e, 0)?;
            if is_path(&path) {
                enrolled.push(Json::obj([
                    ("pathSlug", Json::str(path)),
                    ("enrolledAt", iso(at(e, 1)?)),
                    ("leftAt", iso_opt(at_opt(e, 2)?)),
                ]));
            }
        }
        let mut note_list = Vec::new();
        for n in &notes {
            note_list.push(Json::obj([
                ("n", int(col(n, 0)?)),
                ("body", Json::str(col::<String>(n, 1)?)),
                ("authorId", Json::str(col::<String>(n, 2)?)),
                ("at", iso(at(n, 3)?)),
            ]));
        }
        let mut tag_list = Vec::new();
        for t in &tags {
            tag_list.push(Json::obj([
                ("tag", Json::str(col::<String>(t, 0)?)),
                ("addedBy", Json::str(col::<String>(t, 1)?)),
                ("addedAt", iso(at(t, 2)?)),
            ]));
        }
        Ok(Json::obj([
            ("userId", Json::str(user_id)),
            ("canChange", Json::Bool(can_change)),
            ("enrolments", Json::Array(enrolled)),
            (
                "access",
                Json::Array(access.iter().map(grant_json).collect()),
            ),
            ("notes", Json::Array(note_list)),
            ("tags", Json::Array(tag_list)),
            (
                "audit",
                Json::Array(
                    audit
                        .into_iter()
                        .map(|a| {
                            Json::obj([
                                ("kind", Json::str(a.kind)),
                                ("at", Json::str(a.at)),
                                ("actorId", str_opt(a.actor_id)),
                                ("reason", str_opt(a.reason)),
                                ("detail", Json::str(a.detail)),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]))
    })
}

fn by_slug<'r>(list: &'r [Row], slug: &str, at_col: usize) -> Result<Vec<&'r Row>, Refusal> {
    let mut out = Vec::new();
    for r in list {
        if col::<String>(r, at_col)? == slug {
            out.push(r);
        }
    }
    Ok(out)
}

/// Every item of each course the learner is or was enrolled in, or holds an access record for, in course order.
pub fn progress(pool: &Db<'_>, user_id: &str, can_change: bool) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let path_rows = rows(
            db,
            "SELECT path_slug FROM academy.cert_enrollments WHERE user_id = $1::text::uuid
             UNION SELECT path_slug FROM academy.access_grants WHERE user_id = $1::text::uuid",
            &[&user_id],
        )?;
        let mut held = Vec::new();
        for r in &path_rows {
            held.push(col::<String>(r, 0)?);
        }
        let paths: Vec<&str> = spine::PATHS
            .iter()
            .copied()
            .filter(|p| held.iter().any(|h| h == p))
            .collect();
        let courses: Vec<(&str, Vec<&spine::Item>)> = paths
            .iter()
            .map(|p| (*p, spine::list(Some(p), None)))
            .collect();
        let slugs: Vec<String> = courses
            .iter()
            .flat_map(|(_, items)| items.iter().map(|i| i.slug.clone()))
            .collect();
        if slugs.is_empty() {
            return Ok(Json::obj([
                ("userId", Json::str(user_id)),
                ("canChange", Json::Bool(can_change)),
                ("courses", Json::Array(Vec::new())),
            ]));
        }
        let completions = rows(
            db,
            &format!(
                "SELECT item_slug, {} FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = ANY($2::text[])",
                ms("completed_at")
            ),
            &[&user_id, &slugs],
        )?;
        let history = rows(
            db,
            &format!(
                "SELECT item_slug, event, {} FROM academy.item_completion_events
                  WHERE user_id = $1::text::uuid AND item_slug = ANY($2::text[]) ORDER BY recorded_at, id",
                ms("recorded_at")
            ),
            &[&user_id, &slugs],
        )?;
        let windows = rows(
            db,
            &format!(
                "SELECT item_slug, {} FROM academy.item_windows WHERE item_slug = ANY($1::text[])",
                ms("due_at")
            ),
            &[&slugs],
        )?;
        let extensions = rows(
            db,
            &format!(
                "SELECT DISTINCT ON (item_slug) item_slug, revision, reason, {}, granted_by::text, {}
                   FROM academy.item_extensions WHERE user_id = $1::text::uuid AND item_slug = ANY($2::text[])
                  ORDER BY item_slug, revision DESC",
                ms("extended_until"),
                ms("granted_at")
            ),
            &[&user_id, &slugs],
        )?;
        let quizzes = rows(
            db,
            "SELECT slug, attempt_limit FROM academy.quizzes WHERE slug = ANY($1::text[])",
            &[&slugs],
        )?;
        let attempts = rows(
            db,
            &format!(
                "SELECT id::text, slug, score, max_score, passed, {}, {}, voided_by::text, void_reason
                   FROM academy.assessment_attempts WHERE user_id = $1::text::uuid AND slug = ANY($2::text[])
                  ORDER BY submitted_at, id",
                ms("submitted_at"),
                ms("voided_at")
            ),
            &[&user_id, &slugs],
        )?;
        let mut course_list = Vec::new();
        for (path, items) in &courses {
            let mut item_list = Vec::new();
            for item in items {
                let done = by_slug(&completions, &item.slug, 0)?;
                let past = by_slug(&history, &item.slug, 0)?;
                let quiz = by_slug(&quizzes, &item.slug, 0)?;
                let tries = by_slug(&attempts, &item.slug, 1)?;
                let ext = by_slug(&extensions, &item.slug, 0)?;
                let window = by_slug(&windows, &item.slug, 0)?;
                let done = done.first();
                let status = if done.is_some() {
                    "completed"
                } else if !past.is_empty() {
                    "undone"
                } else {
                    "not_started"
                };
                let mut hist = Vec::new();
                for h in &past {
                    hist.push(Json::obj([
                        ("event", Json::str(col::<String>(h, 1)?)),
                        ("at", iso(at(h, 2)?)),
                    ]));
                }
                let due = match window.first() {
                    Some(w) => iso_opt(at_opt(w, 1)?),
                    None => Json::Null,
                };
                let extension = match ext.first() {
                    Some(x) => Json::obj([
                        ("until", iso(at(x, 3)?)),
                        ("reason", Json::str(col::<String>(x, 2)?)),
                        ("grantedBy", Json::str(col::<String>(x, 4)?)),
                        ("grantedAt", iso(at(x, 5)?)),
                        ("revision", int(col(x, 1)?)),
                    ]),
                    None => Json::Null,
                };
                let quiz_json = if quiz.is_empty() && tries.is_empty() {
                    Json::Null
                } else {
                    let limit: Option<i32> = match quiz.first() {
                        Some(q) => col(q, 1)?,
                        None => None,
                    };
                    let mut counted = 0i64;
                    let mut list = Vec::new();
                    for a in &tries {
                        let voided_at = at_opt(a, 6)?;
                        if voided_at.is_none() {
                            counted += 1;
                        }
                        let voided = match voided_at {
                            Some(v) => Json::obj([
                                ("at", iso(v)),
                                ("by", str_opt(col(a, 7)?)),
                                ("reason", str_opt(col(a, 8)?)),
                            ]),
                            None => Json::Null,
                        };
                        list.push(Json::obj([
                            ("attemptId", Json::str(col::<String>(a, 0)?)),
                            ("score", int(col(a, 2)?)),
                            ("maxScore", int(col(a, 3)?)),
                            ("passed", Json::Bool(col(a, 4)?)),
                            ("submittedAt", iso(at(a, 5)?)),
                            ("voided", voided),
                        ]));
                    }
                    Json::obj([
                        ("attemptLimit", limit.map_or(Json::Null, int)),
                        ("counted", Json::int(counted)),
                        ("attempts", Json::Array(list)),
                    ])
                };
                let completed_at = match done {
                    Some(d) => iso(at(d, 1)?),
                    None => Json::Null,
                };
                item_list.push(Json::obj([
                    ("slug", Json::str(item.slug.clone())),
                    ("title", Json::str(item.title.clone())),
                    ("kind", Json::str(item.kind.clone())),
                    ("status", Json::str(status)),
                    ("completedAt", completed_at),
                    ("history", Json::Array(hist)),
                    ("dueAt", due),
                    ("extension", extension),
                    ("quiz", quiz_json),
                ]));
            }
            course_list.push(Json::obj([
                ("pathSlug", Json::str(*path)),
                ("items", Json::Array(item_list)),
            ]));
        }
        Ok(Json::obj([
            ("userId", Json::str(user_id)),
            ("canChange", Json::Bool(can_change)),
            ("courses", Json::Array(course_list)),
        ]))
    })
}

/// One row of `academy.learner_events`.
pub struct LearnerEvent<'a> {
    pub user_id: &'a str,
    pub kind: &'a str,
    pub key: &'a str,
    pub item_slug: Option<&'a str>,
    pub detail: &'a str,
    pub reason: &'a str,
    pub actor_id: &'a str,
    pub now: Instant,
}

fn event<C: GenericClient>(tx: &mut C, e: &LearnerEvent<'_>) -> Result<(), Refusal> {
    exec(
        tx,
        "INSERT INTO academy.learner_events (user_id, kind, key, item_slug, detail, reason, actor_id, at)
         VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text::uuid, $8::text::timestamptz)
         ON CONFLICT (key) DO NOTHING",
        &[&e.user_id, &e.kind, &e.key, &e.item_slug, &e.detail, &e.reason, &e.actor_id, &e.now.iso()],
    )?;
    Ok(())
}

/// An internal note, keyed by the console's request. Never returned to the learner.
pub fn add_note(
    pool: &Db<'_>,
    user_id: &str,
    body: &str,
    key: &str,
    actor_id: &str,
    now: Instant,
) -> Result<i32, Refusal> {
    let body = js_trim(body);
    if body.is_empty() {
        return Err(academy(
            "academy.reason_required",
            "academy.reason_required a note needs words",
        ));
    }
    serializable(pool.get()?, |tx| {
        exec(
            tx,
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            &[&format!("{user_id}:learner-notes")],
        )?;
        let replay = first(
            tx,
            "SELECT n, body FROM academy.learner_notes WHERE user_id = $1::text::uuid AND key = $2::text",
            &[&user_id, &key],
        )?;
        // The same note again is a replay; another note under the key means someone wrote one meanwhile.
        if let Some(r) = replay {
            if col::<String>(&r, 1)? == body {
                return col(&r, 0);
            }
            return Err(academy(
                "academy.revision_stale",
                "academy.revision_stale another note was saved first; read the page again",
            ));
        }
        let next = first(
            tx,
            "SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.learner_notes WHERE user_id = $1::text::uuid",
            &[&user_id],
        )?
        .ok_or_else(|| undefined("n"))?;
        let n: i32 = col(&next, 0)?;
        exec(
            tx,
            "INSERT INTO academy.learner_notes (user_id, n, body, key, author_id, at)
             VALUES ($1::text::uuid, $2::int4, $3::text, $4::text, $5::text::uuid, $6::text::timestamptz)",
            &[&user_id, &n, &body, &key, &actor_id, &now.iso()],
        )?;
        event(
            tx,
            &LearnerEvent {
                user_id,
                kind: "note_added",
                key: &format!("note:{user_id}:{n}"),
                item_slug: None,
                detail: &format!("Internal note {n} added"),
                reason: "Internal note",
                actor_id,
                now,
            },
        )?;
        Ok(n)
    })
}

/// The stored key of an item staff marked complete: scoped to the learner and item.
pub fn mark_key(user_id: &str, item_slug: &str, key: &str) -> String {
    format!("mark:{user_id}:{item_slug}:{key}")
}

/// Whether this mark-complete was already recorded under the console's key (a replay after a lost reply).
pub fn mark_recorded<C: GenericClient>(
    db: &mut C,
    user_id: &str,
    item_slug: &str,
    key: &str,
) -> Result<bool, Refusal> {
    let found = rows(
        db,
        "SELECT 1 FROM academy.learner_events WHERE key = $1::text AND user_id = $2::text::uuid AND kind = 'marked_complete'",
        &[&mark_key(user_id, item_slug, key), &user_id],
    )?;
    Ok(!found.is_empty())
}

/// The event for an item staff marked complete for the learner, written in the completion's own transaction.
pub fn record_mark_complete<C: GenericClient>(
    tx: &mut C,
    user_id: &str,
    item_slug: &str,
    reason: &str,
    key: &str,
    actor_id: &str,
    now: Instant,
) -> Result<(), Refusal> {
    let title = title_of(item_slug);
    event(
        tx,
        &LearnerEvent {
            user_id,
            kind: "marked_complete",
            key: &mark_key(user_id, item_slug, key),
            item_slug: Some(item_slug),
            detail: &format!("{title} marked complete for the learner"),
            reason,
            actor_id,
            now,
        },
    )
}

/// One finished quiz attempt no longer counts. A repeat on a voided attempt answers as the first void did.
pub fn void_attempt(
    pool: &Db<'_>,
    user_id: &str,
    attempt_id: &str,
    reason: &str,
    actor_id: &str,
    now: Instant,
) -> Result<String, Refusal> {
    let reason = require_reason(reason)?;
    serializable(pool.get()?, |tx| {
        exec(
            tx,
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            &[&format!("{user_id}:assessment")],
        )?;
        let row = first(
            tx,
            &format!(
                "SELECT slug, score, max_score, {} FROM academy.assessment_attempts
                  WHERE id = $1::text::uuid AND user_id = $2::text::uuid FOR UPDATE",
                ms("voided_at")
            ),
            &[&attempt_id, &user_id],
        )?
        .ok_or_else(|| {
            academy(
                "academy.attempt_not_found",
                "academy.attempt_not_found no finished attempt of this learner has that id",
            )
        })?;
        if let Some(v) = at_opt(&row, 3)? {
            return Ok(v.iso());
        }
        let slug: String = col(&row, 0)?;
        let score: i32 = col(&row, 1)?;
        let max: i32 = col(&row, 2)?;
        exec(
            tx,
            "UPDATE academy.assessment_attempts SET voided_at = $1::text::timestamptz, voided_by = $2::text::uuid, void_reason = $3::text
              WHERE id = $4::text::uuid",
            &[&now.iso(), &actor_id, &reason, &attempt_id],
        )?;
        let title = title_of(&slug);
        event(
            tx,
            &LearnerEvent {
                user_id,
                kind: "quiz_attempt_voided",
                key: &format!("void:{attempt_id}"),
                item_slug: Some(&slug),
                detail: &format!(
                    "{title}: quiz attempt scored {score} of {max} voided, so it no longer counts"
                ),
                reason: &reason,
                actor_id,
                now,
            },
        )?;
        Ok(now.iso())
    })
}

fn window_invalid(expires_at: Option<Instant>, now: Instant) -> Result<(), Refusal> {
    if expires_at.is_some_and(|e| e.0 <= now.0) {
        return Err(academy(
            "academy.window_invalid",
            "academy.window_invalid the end must be after now",
        ));
    }
    Ok(())
}

/// A staff access record, keyed `grant:<course>:<learner>`: a repeat answers with the stored record, never a second one.
pub fn grant_access(
    pool: &Db<'_>,
    user_id: &str,
    path_slug: &str,
    reason: &str,
    expires_at: Option<Instant>,
    actor_id: &str,
    now: Instant,
) -> Result<(), Refusal> {
    let reason = require_reason(reason)?;
    window_invalid(expires_at, now)?;
    let expires = expires_at.map(Instant::iso);
    serializable(pool.get()?, |tx| {
        let row = first(
            tx,
            "INSERT INTO academy.access_grants (user_id, path_slug, source, reason, starts_at, expires_at, state, created_at, updated_at)
             VALUES ($1::text::uuid, $2::text, 'staff', $3::text, $4::text::timestamptz, $5::text::timestamptz, 'granted',
                     $4::text::timestamptz, $4::text::timestamptz)
             ON CONFLICT (path_slug, user_id) DO NOTHING
             RETURNING id::text",
            &[&user_id, &path_slug, &reason, &now.iso(), &expires],
        )?;
        let Some(row) = row else {
            // A repeat of a live grant answers as it is; an ended one is reinstated on its own row.
            let held = first(
                tx,
                "SELECT state FROM academy.access_grants WHERE path_slug = $1::text AND user_id = $2::text::uuid",
                &[&path_slug, &user_id],
            )?;
            if let Some(h) = held
                && col::<String>(&h, 0)? != "granted"
            {
                return Err(academy(
                    "academy.grant_expired",
                    "academy.grant_expired this access has ended: reinstate it instead",
                ));
            }
            return Ok(());
        };
        let id: String = col(&row, 0)?;
        exec(
            tx,
            "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
             VALUES ($1::text::uuid, 1, 'granted', $2::text, $3::text, $4::text::uuid, $5::text::timestamptz, $6::text::timestamptz)",
            &[&id, &format!("grant:{path_slug}:{user_id}"), &reason, &actor_id, &expires, &now.iso()],
        )?;
        Ok(())
    })
}

/// The same record granted again, keyed `reinstate:<grant>:<n>`.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript method takes these as one input object; each is a named field of it"
)]
pub fn reinstate(
    pool: &Db<'_>,
    user_id: &str,
    grant_id: &str,
    reason: &str,
    expires_at: Option<Instant>,
    n: i64,
    actor_id: &str,
    now: Instant,
) -> Result<(), Refusal> {
    let reason = require_reason(reason)?;
    window_invalid(expires_at, now)?;
    settle_expiries(pool, user_id, now)?;
    let key = format!("reinstate:{grant_id}:{n}");
    let expires = expires_at.map(Instant::iso);
    serializable(pool.get()?, |tx| {
        let grant = first(
            tx,
            &format!("SELECT {GRANT_COLUMNS} FROM academy.access_grants WHERE id = $1::text::uuid AND user_id = $2::text::uuid FOR UPDATE"),
            &[&grant_id, &user_id],
        )?
        .ok_or_else(|| academy("academy.grant_not_found", "academy.grant_not_found this learner has no such access record"))?;
        if first(
            tx,
            "SELECT 1 FROM academy.access_grant_events WHERE key = $1::text",
            &[&key],
        )?
        .is_some()
        {
            return Ok(());
        }
        if col::<String>(&grant, 7)? == "granted" {
            return Err(academy(
                "academy.grant_active",
                "academy.grant_active this access has not ended",
            ));
        }
        let id: String = col(&grant, 0)?;
        let next = next_grant_event(tx, &id)?;
        if i64::from(next) != n {
            return Err(academy(
                "academy.revision_stale",
                format!("academy.revision_stale the next event is {next}"),
            ));
        }
        exec(
            tx,
            "UPDATE academy.access_grants SET state = 'granted', expires_at = $1::text::timestamptz, updated_at = $2::text::timestamptz
              WHERE id = $3::text::uuid",
            &[&expires, &now.iso(), &id],
        )?;
        exec(
            tx,
            "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at)
             VALUES ($1::text::uuid, $2::int4, 'reinstated', $3::text, $4::text, $5::text::uuid, $6::text::timestamptz, $7::text::timestamptz)",
            &[&id, &next, &key, &reason, &actor_id, &expires, &now.iso()],
        )?;
        Ok(())
    })
}

/// Adds a tag to each learner named. A learner who already carries it is left as they are.
pub fn tag(
    pool: &Db<'_>,
    user_ids: &[String],
    tag: &str,
    reason: &str,
    actor_id: &str,
    now: Instant,
) -> Result<i64, Refusal> {
    let reason = require_reason(reason)?;
    let mut unique: Vec<&String> = Vec::new();
    for u in user_ids {
        if !unique.contains(&u) {
            unique.push(u);
        }
    }
    serializable(pool.get()?, |tx| {
        let mut added = 0i64;
        for user_id in &unique {
            let inserted = rows(
                tx,
                "INSERT INTO academy.learner_tags (tag, user_id, added_by, added_at)
                 VALUES ($1::text, $2::text::uuid, $3::text::uuid, $4::text::timestamptz)
                 ON CONFLICT (tag, user_id) DO NOTHING RETURNING tag",
                &[&tag, user_id, &actor_id, &now.iso()],
            )?;
            if inserted.is_empty() {
                continue;
            }
            added += 1;
            event(
                tx,
                &LearnerEvent {
                    user_id,
                    kind: "tag_added",
                    key: &format!("tag-add:{tag}:{user_id}:{}", now.iso()),
                    item_slug: None,
                    detail: &format!("Tag {tag} added"),
                    reason: &reason,
                    actor_id,
                    now,
                },
            )?;
        }
        Ok(added)
    })
}

/// Takes a tag off one learner; `false` when they did not carry it.
pub fn untag(
    pool: &Db<'_>,
    user_id: &str,
    tag: &str,
    reason: &str,
    actor_id: &str,
    now: Instant,
) -> Result<bool, Refusal> {
    let reason = require_reason(reason)?;
    serializable(pool.get()?, |tx| {
        let removed = rows(
            tx,
            "DELETE FROM academy.learner_tags WHERE tag = $1::text AND user_id = $2::text::uuid RETURNING tag",
            &[&tag, &user_id],
        )?;
        if removed.is_empty() {
            return Ok(false);
        }
        event(
            tx,
            &LearnerEvent {
                user_id,
                kind: "tag_removed",
                key: &format!("tag-remove:{tag}:{user_id}:{}", now.iso()),
                item_slug: None,
                detail: &format!("Tag {tag} removed"),
                reason: &reason,
                actor_id,
                now,
            },
        )?;
        Ok(true)
    })
}

/// Every tag with how many learners carry it.
pub fn tags(pool: &Db<'_>) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = rows(
            db,
            "SELECT tag, count(*)::int AS learners FROM academy.learner_tags GROUP BY tag ORDER BY tag",
            &[],
        )?;
        let mut out = Vec::new();
        for r in &list {
            out.push(Json::obj([
                ("tag", Json::str(col::<String>(r, 0)?)),
                ("learners", int(col(r, 1)?)),
            ]));
        }
        Ok(Json::Array(out))
    })
}

/// The learners report: everyone with an enrolment, an access record or a tag; with `tag`, only those who carry it.
pub fn learners(pool: &Db<'_>, tag: Option<&str>, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let ids = rows(
            db,
            "SELECT user_id::text FROM (
               SELECT user_id FROM academy.cert_enrollments WHERE left_at IS NULL
               UNION SELECT user_id FROM academy.access_grants
               UNION SELECT user_id FROM academy.learner_tags
             ) people
             WHERE $1::text IS NULL OR EXISTS (SELECT 1 FROM academy.learner_tags t WHERE t.user_id = people.user_id AND t.tag = $1::text)
             ORDER BY user_id
             LIMIT $2::int8",
            &[&tag, &limit],
        )?;
        let mut users = Vec::new();
        for r in &ids {
            users.push(col::<String>(r, 0)?);
        }
        let tag_json = str_opt(tag.map(str::to_owned));
        if users.is_empty() {
            return Ok(Json::obj([
                ("tag", tag_json),
                ("rows", Json::Array(Vec::new())),
            ]));
        }
        let paths = rows(
            db,
            "SELECT user_id::text, path_slug FROM academy.cert_enrollments
              WHERE left_at IS NULL AND user_id = ANY($1::text[]::uuid[]) ORDER BY path_slug",
            &[&users],
        )?;
        let carried = rows(
            db,
            "SELECT user_id::text, tag FROM academy.learner_tags WHERE user_id = ANY($1::text[]::uuid[]) ORDER BY tag",
            &[&users],
        )?;
        let mut out = Vec::new();
        for u in &users {
            let mut ps = Vec::new();
            for p in &paths {
                let path: String = col(p, 1)?;
                if col::<String>(p, 0)? == *u && is_path(&path) {
                    ps.push(path);
                }
            }
            let mut ts = Vec::new();
            for t in &carried {
                if col::<String>(t, 0)? == *u {
                    ts.push(col::<String>(t, 1)?);
                }
            }
            out.push(Json::obj([
                ("userId", Json::str(u.clone())),
                ("paths", strs(&ps)),
                ("tags", strs(&ts)),
            ]));
        }
        Ok(Json::obj([("tag", tag_json), ("rows", Json::Array(out))]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_is_minutes_in_utc() {
        assert_eq!(day(Instant(1_800_000_000_000)), "2027-01-15 08:00 UTC");
    }

    #[test]
    fn a_blank_reason_refuses() {
        assert!(require_reason("  ").is_err());
        assert_eq!(require_reason(" why ").ok().as_deref(), Some("why"));
    }
}
