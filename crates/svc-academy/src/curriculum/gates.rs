//! The reads a curriculum item passes before its body is served, and the hub's featured slot, as the TypeScript runs
//! them, statement for statement:
//!
//! - the release decision (`release/access.ts` `ReleaseAccess.assertMayRead`, `assertMayReadSignedOut` and the
//!   pure `decideRelease`, `refuseRelease`), with the course start (`curriculum/course-start.ts` `readCourseStart`);
//! - the learner's access record (`learners/learner-desk.ts` `LearnerDesk.assertAccess`), which writes the expiry of
//!   every record that has ended, once, in one serializable transaction (`@intafaced/db` `transaction`, five tries on a
//!   serialization failure);
//! - the hub's featured item and lesson (`curriculum/featured.ts` `FeaturedSlot.featured`, `learn-hub.ts`
//!   `publicLesson`, `academy-service.ts` `featuredItem`).
//!
//! The tables are the release, learner and authoring slices' to write; these are the reads the curriculum calls make,
//! and those slices reuse them. Times are read as epoch milliseconds (`floor`, as a JavaScript `Date` keeps them) and
//! written back from them, so a stored time round-trips as the TypeScript's does.

use postgres::{Client, IsolationLevel, Transaction};

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::spine;
use crate::db::{self, SERIALIZATION_FAILURE};
use crate::errors::{AcademyError, Refusal};

/// `requireCurriculumSlug`: the trimmed slug of a spine item, or `academy.curriculum_not_found`.
pub fn require_slug(slug: &str) -> Result<&str, Refusal> {
    let trimmed = js_trim(slug);
    if spine::get(trimmed).is_none() {
        return Err(
            AcademyError::new("Unknown curriculum item", "academy.curriculum_not_found").into(),
        );
    }
    Ok(trimmed)
}

/// `ItemWindow`, in epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub from: i64,
    pub until: i64,
    pub due: Option<i64>,
}

/// `ReleaseDecision`: the state, the missing prerequisites (sorted) and the lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub state: &'static str,
    pub missing: Vec<String>,
    pub lock: Option<&'static str>,
}

fn outside_window(w: Window, extension_until: Option<i64>, now: i64) -> bool {
    if now < w.from {
        return true;
    }
    let open_until = extension_until.filter(|e| *e > w.until).unwrap_or(w.until);
    if now >= open_until {
        return true;
    }
    if let Some(due) = w.due {
        let bound = extension_until.filter(|e| *e > due).unwrap_or(due);
        if now >= bound {
            return true;
        }
    }
    false
}

/// `decideRelease`.
pub fn decide(
    completed: bool,
    started: bool,
    missing: &[String],
    window: Option<Window>,
    extension_until: Option<i64>,
    now: i64,
    course_starts_at: Option<i64>,
) -> Decision {
    let locked = |missing: Vec<String>, lock| Decision {
        state: "locked",
        missing,
        lock: Some(lock),
    };
    if completed {
        return Decision {
            state: "completed",
            missing: Vec::new(),
            lock: None,
        };
    }
    let mut missing = missing.to_vec();
    missing.sort_unstable();
    if !missing.is_empty() {
        return locked(missing, "prerequisite");
    }
    if window.is_some_and(|w| outside_window(w, extension_until, now)) {
        return locked(Vec::new(), "window");
    }
    if course_starts_at.is_some_and(|c| now < c) {
        return locked(Vec::new(), "window");
    }
    Decision {
        state: if started { "started" } else { "unlocked" },
        missing: Vec::new(),
        lock: None,
    }
}

/// `refuseRelease`: a lock refuses with its reason.
pub fn refuse(d: &Decision) -> Result<(), Refusal> {
    match d.lock {
        Some("prerequisite") => Err(AcademyError::new(
            format!("academy.prerequisite_unmet missing={}", d.missing.join(",")),
            "academy.prerequisite_unmet",
        )
        .into()),
        Some(_) => Err(AcademyError::new(
            "academy.window_invalid outside the published window",
            "academy.window_invalid",
        )
        .into()),
        None => Ok(()),
    }
}

/// A timestamp column as a JavaScript `Date` holds it: epoch milliseconds.
fn ms(column: &str) -> String {
    format!("floor(extract(epoch from {column}) * 1000)::int8")
}

/// A time as a query parameter.
pub fn iso(at: i64) -> String {
    Instant(at).iso()
}

fn q(
    c: &mut Client,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<postgres::Row>, Refusal> {
    c.query(sql, params).map_err(|e| db::refusal(&e))
}

fn cell<'a, T: postgres::types::FromSql<'a>>(
    row: &'a postgres::Row,
    i: usize,
) -> Result<T, Refusal> {
    row.try_get(i).map_err(|e| db::refusal(&e))
}

/// `readCourseStart(sql, path)` for the item's path.
fn course_starts_at(c: &mut Client, item_slug: &str) -> Result<Option<i64>, Refusal> {
    let Some(item) = spine::get(item_slug) else {
        return Ok(None);
    };
    let rows = q(
        c,
        &format!(
            "SELECT {} FROM academy.course_starts WHERE path = $1",
            ms("starts_at")
        ),
        &[&item.path],
    )?;
    rows.first().map_or(Ok(None), |r| cell(r, 0))
}

fn window_of(c: &mut Client, item_slug: &str) -> Result<Option<Window>, Refusal> {
    let rows = q(
        c,
        &format!(
            "SELECT {}, {}, {} FROM academy.item_windows WHERE item_slug = $1",
            ms("available_from"),
            ms("available_until"),
            ms("due_at")
        ),
        &[&item_slug],
    )?;
    rows.first()
        .map(|r| {
            Ok(Window {
                from: cell(r, 0)?,
                until: cell(r, 1)?,
                due: cell(r, 2)?,
            })
        })
        .transpose()
}

/// `ReleaseAccess.load`: the learner's decision for one item, from its prerequisites, completions, window, latest
/// extension and whether it was started.
fn load(
    c: &mut Client,
    user_id: &str,
    item_slug: &str,
    now: i64,
    course_starts_at: Option<i64>,
) -> Result<Decision, Refusal> {
    let required: Vec<String> = q(
        c,
        "SELECT prerequisite_slug FROM academy.item_prerequisites WHERE item_slug = $1",
        &[&item_slug],
    )?
    .iter()
    .map(|r| cell(r, 0))
    .collect::<Result<_, _>>()?;
    let mut missing = Vec::new();
    if !required.is_empty() {
        let have: Vec<String> = q(
            c,
            "SELECT item_slug FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = ANY($2)",
            &[&user_id, &required],
        )?
        .iter()
        .map(|r| cell(r, 0))
        .collect::<Result<_, _>>()?;
        missing = required.into_iter().filter(|s| !have.contains(s)).collect();
    }
    let window = window_of(c, item_slug)?;
    let extension: Option<i64> = q(
        c,
        &format!(
            "SELECT {}, reason, {}, granted_by::text FROM academy.item_extensions \
             WHERE user_id = $1::text::uuid AND item_slug = $2 ORDER BY revision DESC LIMIT 1",
            ms("extended_until"),
            ms("granted_at")
        ),
        &[&user_id, &item_slug],
    )?
    .first()
    .map(|r| cell(r, 0))
    .transpose()?;
    let started: bool = q(
        c,
        "SELECT (EXISTS (SELECT 1 FROM academy.learning_touches WHERE user_id = $1::text::uuid AND item_slug = $2) \
         OR EXISTS (SELECT 1 FROM academy.learning_state WHERE user_id = $1::text::uuid AND last_item_slug = $2)) AS started",
        &[&user_id, &item_slug],
    )?
    .first()
    .map_or(Ok(false), |r| cell::<Option<bool>>(r, 0).map(|b| b == Some(true)))?;
    let completed: bool = q(
        c,
        "SELECT EXISTS (SELECT 1 FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = $2) AS completed",
        &[&user_id, &item_slug],
    )?
    .first()
    .map_or(Ok(false), |r| cell::<Option<bool>>(r, 0).map(|b| b == Some(true)))?;
    Ok(decide(
        completed,
        started,
        &missing,
        window,
        extension,
        now,
        course_starts_at,
    ))
}

/// `ReleaseAccess.itemRelease({ userId, itemSlug, now, courseStartsAt })`: the learner's decision for one item, its
/// course's start given by the caller that read it once for every item.
pub fn item_release(
    pool: &Pool,
    user_id: &str,
    item_slug: &str,
    now: i64,
    course_starts_at: Option<i64>,
) -> Result<Decision, Refusal> {
    let slug = require_slug(item_slug)?;
    db::with_client(pool, |c| load(c, user_id, slug, now, course_starts_at))
}

/// `ReleaseAccess.assertMayRead`, then the learner's access record for the item's course (`useAccessGate`): a lock
/// refuses before a body is read.
pub fn assert_may_read(
    pool: &Pool,
    user_id: &str,
    item_slug: &str,
    now: i64,
) -> Result<(), Refusal> {
    let slug = require_slug(item_slug)?;
    db::with_client(pool, |c| {
        let starts = course_starts_at(c, slug)?;
        refuse(&load(c, user_id, slug, now, starts)?)
    })?;
    match spine::get(slug) {
        Some(item) => assert_access(pool, user_id, &item.path, now),
        None => Ok(()),
    }
}

/// `ReleaseAccess.assertMayReadSignedOut`: an item with a prerequisite asks for sign-in; a published window and the
/// course start apply to everyone.
pub fn assert_may_read_signed_out(pool: &Pool, item_slug: &str, now: i64) -> Result<(), Refusal> {
    let slug = require_slug(item_slug)?;
    db::with_client(pool, |c| {
        let prerequisite = q(
            c,
            "SELECT prerequisite_slug FROM academy.item_prerequisites WHERE item_slug = $1 LIMIT 1",
            &[&slug],
        )?;
        if !prerequisite.is_empty() {
            return Err(AcademyError::new(
                "academy.sign_in_required this item has a prerequisite",
                "academy.sign_in_required",
            )
            .into());
        }
        let window = window_of(c, slug)?;
        let starts = course_starts_at(c, slug)?;
        refuse(&decide(false, false, &[], window, None, now, starts))
    })
}

/// `opensSignedOut`: whether a signed-out reader would open the item; a prerequisite or a closed window says no.
pub fn opens_signed_out(pool: &Pool, item_slug: &str, now: i64) -> Result<bool, Refusal> {
    match assert_may_read_signed_out(pool, item_slug, now) {
        Ok(()) => Ok(true),
        Err(Refusal::Academy(e))
            if e.code == "academy.sign_in_required" || e.code == "academy.window_invalid" =>
        {
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// `transaction(sql, fn)`: serializable, tried again (up to five times, with jittered backoff) on a serialization
/// failure.
fn serializable<T>(
    pool: &Pool,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut attempt: u32 = 1;
    loop {
        match db::transaction(pool, IsolationLevel::Serializable, &mut f) {
            Err(Refusal::Internal {
                code: Some(code), ..
            }) if code == SERIALIZATION_FAILURE && attempt < 5 => {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| u64::from(d.subsec_nanos()));
                let ceiling = 5u64 << attempt;
                std::thread::sleep(std::time::Duration::from_millis(nanos % ceiling.max(1)));
                attempt += 1;
            }
            other => return other,
        }
    }
}

/// `LearnerDesk.assertAccess(userId, path, now)`: no record leaves the free enrolment to decide; a record that has
/// ended refuses `academy.grant_expired`, and its expiry is written on this read when it is not yet.
pub fn assert_access(pool: &Pool, user_id: &str, path: &str, now: i64) -> Result<(), Refusal> {
    let row = db::with_client(pool, |c| {
        let rows = q(
            c,
            &format!(
                "SELECT id::text, user_id::text, path_slug, source, reason, {}, {}, state \
                 FROM academy.access_grants WHERE user_id = $1::text::uuid AND path_slug = $2",
                ms("starts_at"),
                ms("expires_at")
            ),
            &[&user_id, &path],
        )?;
        rows.first()
            .map(|r| Ok::<_, Refusal>((cell::<Option<i64>>(r, 6)?, cell::<String>(r, 7)?)))
            .transpose()
    })?;
    let Some((expires_at, state)) = row else {
        return Ok(());
    };
    if state == "granted" && expires_at.is_none_or(|e| e > now) {
        return Ok(());
    }
    if state == "granted" {
        settle_expiries(pool, user_id, now)?;
    }
    let how = if state == "revoked" {
        "revoked".to_owned()
    } else {
        format!("ended={}", iso(expires_at.unwrap_or(now)))
    };
    Err(AcademyError::new(
        format!("academy.grant_expired course={path} {how}"),
        "academy.grant_expired",
    )
    .into())
}

/// `settleExpiries`: the expired event, once, for every record of the learner whose end has passed.
pub fn settle_expiries(pool: &Pool, user_id: &str, now: i64) -> Result<(), Refusal> {
    let at = iso(now);
    serializable(pool, |tx| {
        let due = tx
            .query(
                &format!(
                    "SELECT id::text, {} FROM academy.access_grants \
                     WHERE user_id = $1::text::uuid AND state = 'granted' AND expires_at IS NOT NULL \
                     AND expires_at <= $2::text::timestamptz FOR UPDATE",
                    ms("expires_at")
                ),
                &[&user_id, &at],
            )
            .map_err(|e| db::refusal(&e))?;
        for grant in &due {
            let id: String = cell(grant, 0)?;
            let expires: i64 = cell(grant, 1)?;
            let n: i32 = tx
                .query_one(
                    "SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = $1::text::uuid",
                    &[&id],
                )
                .map_err(|e| db::refusal(&e))
                .and_then(|r| cell(&r, 0))?;
            tx.execute(
                "UPDATE academy.access_grants SET state = 'expired', updated_at = $2::text::timestamptz WHERE id = $1::text::uuid",
                &[&id, &at],
            )
            .map_err(|e| db::refusal(&e))?;
            let key = format!("expire:{id}:{n}");
            let ended = iso(expires);
            tx.execute(
                "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at) \
                 VALUES ($1::text::uuid, $2, 'expired', $3, null, null, $4::text::timestamptz, $4::text::timestamptz)",
                &[&id, &n, &key, &ended],
            )
            .map_err(|e| db::refusal(&e))?;
        }
        Ok(())
    })
}

/// `FeaturedSlot.featured()`: the curriculum item staff chose for the hub, while it is on the spine.
fn featured_slot(pool: &Pool) -> Result<Option<&'static spine::Item>, Refusal> {
    let rows = db::with_client(pool, |c| {
        q(
            c,
            "SELECT item_slug FROM academy.featured_items WHERE slot = 'hub' AND item_slug IS NOT NULL",
            &[],
        )
    })?;
    match rows.first() {
        Some(r) => Ok(spine::get(&cell::<String>(r, 0)?)),
        None => Ok(None),
    }
}

/// `featuredItem(now)`: the featured item, only while a signed-out reader would open it.
pub fn featured_item(pool: &Pool, now: i64) -> Result<Option<&'static spine::Item>, Refusal> {
    match featured_slot(pool)? {
        Some(item) if opens_signed_out(pool, &item.slug, now)? => Ok(Some(item)),
        _ => Ok(None),
    }
}

/// `LearnHub.publicLesson()`: the featured course lesson as a visitor sees it; its course's slug only while the
/// course is published.
pub fn featured_lesson(pool: &Pool) -> Result<Json, Refusal> {
    let rows = db::with_client(pool, |c| {
        q(
            c,
            "SELECT i.title, c.title AS course_title, c.slug AS course_slug, c.state AS course_state \
             FROM academy.featured_items f \
             JOIN academy.course_items i ON i.id = f.course_item_id \
             JOIN academy.courses c ON c.id = i.course_id \
             WHERE f.slot = 'hub' AND i.live_revision IS NOT NULL AND c.state IN ('draft', 'published')",
            &[],
        )
    })?;
    let Some(r) = rows.first() else {
        return Ok(Json::Null);
    };
    let state: String = cell(r, 3)?;
    Ok(Json::obj([
        ("title", Json::String(cell(r, 0)?)),
        ("courseTitle", Json::String(cell(r, 1)?)),
        (
            "courseSlug",
            if state == "published" {
                Json::String(cell(r, 2)?)
            } else {
                Json::Null
            },
        ),
    ]))
}
