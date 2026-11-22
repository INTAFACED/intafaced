//! What the assessment calls borrow from neighbouring rooms, ported for them: a learner's later date on an item with a
//! window (`release/access.ts` `grantItemExtension`), a learner's later due date on an assignment and the course's item
//! rules it answers with (`curriculum/course-item-rules.ts` `grantExtension`, `viewIn`), the desk's void of a finished
//! quiz attempt (`learners/learner-desk.ts` `voidAttempt`), and the course team's permission check
//! (`team/course-team.ts` `require`) for `reports`.

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::{
    begin, cell, exec, first, int, iso, iso_or_null, ms, opt_str, query, refuse, serializable,
    with_client,
};
use crate::curriculum::spine;
use crate::errors::Refusal;

/// `ACADEMY_BUILTIN_ROLE_PERMISSIONS[role]` holds `reports`, or the role is not built in (`None`).
fn builtin_has_reports(role: &str) -> Option<bool> {
    match role {
        "admin" | "instructor" | "author" | "staff" | "limited_staff" | "data_researcher" => {
            Some(true)
        }
        "discussion_admin" | "moderator" | "community_ta" => Some(false),
        _ => None,
    }
}

/// `team.require(accountId, courseId, 'reports')`: every permission while the account holds no role on the course or
/// academy-wide, otherwise the union of what its active roles permit now.
pub fn require_reports<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    course_id: &str,
) -> Result<(), Refusal> {
    let roles: Vec<String> = query(
        c,
        "SELECT scope, role, since FROM academy.team_roles WHERE account_id = $1::text::uuid AND scope IN ($2, 'academy')",
        &[&account_id, &course_id],
    )?
    .iter()
    .map(|r| cell(r, "role"))
    .collect::<Result<_, _>>()?;
    if roles.is_empty() {
        return Ok(());
    }
    let mut permitted = false;
    for role in &roles {
        let has = match builtin_has_reports(role) {
            Some(h) => h,
            None => {
                let id = role.strip_prefix("custom:");
                let row = match id {
                    Some(id) => first(
                        c,
                        "SELECT id, name, permissions, active FROM academy.custom_roles WHERE id = $1::text::uuid",
                        &[&id],
                    )?,
                    None => None,
                };
                let Some(row) = row else {
                    return refuse(
                        format!("academy.role_not_found role={role}"),
                        "academy.role_not_found",
                    );
                };
                cell::<bool>(&row, "active")?
                    && cell::<Vec<String>>(&row, "permissions")?
                        .iter()
                        .any(|p| p == "reports")
            }
        };
        permitted |= has;
    }
    if !permitted {
        return refuse(
            "academy.permission_denied your role on this course does not permit reports",
            "academy.permission_denied",
        );
    }
    Ok(())
}

/// `grantItemExtension(input)` (`ReleaseAccess`): `(userId, itemSlug, revision, reason, extendedUntil, clientRequestId)`.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's fields, as the TypeScript takes them"
)]
pub fn grant_item_extension(
    pool: &Store,
    user_id: &str,
    item_slug_in: &str,
    reason_in: &str,
    extended_until: i64,
    client_request_id_in: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let item_slug = js_trim(item_slug_in).to_owned();
    if !spine::has(&item_slug) {
        return refuse("Unknown curriculum item", "academy.curriculum_not_found");
    }
    let reason = js_trim(reason_in).to_owned();
    if reason.is_empty() {
        return refuse("academy.reason_required", "academy.reason_required");
    }
    let client_request_id = js_trim(client_request_id_in).to_owned();
    if client_request_id.is_empty() {
        return refuse("clientRequestId is required", "academy.window_invalid");
    }
    let columns = format!(
        "user_id::text AS user_id, item_slug, revision, reason, {} AS extended_until, client_request_id",
        ms("extended_until")
    );
    let record = |r: &postgres::Row| -> Result<Json, Refusal> {
        Ok(Json::obj([
            ("userId", Json::String(cell(r, "user_id")?)),
            ("itemSlug", Json::String(cell(r, "item_slug")?)),
            ("revision", int(i64::from(cell::<i32>(r, "revision")?))),
            ("reason", Json::String(cell(r, "reason")?)),
            (
                "extendedUntil",
                Json::String(iso(cell(r, "extended_until")?)),
            ),
            (
                "clientRequestId",
                Json::String(cell(r, "client_request_id")?),
            ),
        ]))
    };
    serializable(pool, |tx| {
        let k1 = format!("{user_id}:{client_request_id}:extension-request");
        let k2 = format!("{user_id}:{item_slug}:extension");
        query(
            tx,
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&k1],
        )?;
        query(
            tx,
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&k2],
        )?;
        let replay = query(
            tx,
            &format!(
                "SELECT {columns} FROM academy.item_extensions WHERE user_id = $1::text::uuid AND client_request_id = $2"
            ),
            &[&user_id, &client_request_id],
        )?;
        if let Some(head) = replay.first() {
            for r in &replay {
                let agrees = cell::<String>(r, "item_slug")? == item_slug
                    && cell::<String>(r, "reason")? == reason
                    && cell::<i64>(r, "extended_until")? == extended_until;
                if !agrees {
                    return refuse(
                        "academy.window_invalid replay item, reason, or end differs",
                        "academy.window_invalid",
                    );
                }
            }
            return record(head);
        }
        let window = first(
            tx,
            &format!(
                "SELECT {} AS available_from, {} AS available_until, {} AS due_at FROM academy.item_windows WHERE item_slug = $1",
                ms("available_from"),
                ms("available_until"),
                ms("due_at")
            ),
            &[&item_slug],
        )?;
        let Some(window) = window else {
            return refuse(
                "academy.window_invalid nothing to extend",
                "academy.window_invalid",
            );
        };
        let until: i64 = cell(&window, "available_until")?;
        let due: Option<i64> = cell(&window, "due_at")?;
        let bound = due.map_or(until, |d| d.min(until));
        if extended_until <= bound {
            return refuse(
                "extension does not pass the published window",
                "academy.window_invalid",
            );
        }
        let revision: i32 = cell(
            &super::one(
                tx,
                "SELECT (COALESCE(MAX(revision), 0) + 1)::int4 AS revision FROM academy.item_extensions \
                 WHERE user_id = $1::text::uuid AND item_slug = $2",
                &[&user_id, &item_slug],
            )?,
            "revision",
        )?;
        let inserted = first(
            tx,
            &format!(
                "INSERT INTO academy.item_extensions (user_id, item_slug, revision, reason, extended_until, client_request_id, granted_by, granted_at) \
                 VALUES ($1::text::uuid, $2, $3::int4, $4, $5::text::timestamptz, $6, $7::text::uuid, $8::text::timestamptz) RETURNING {columns}"
            ),
            &[&user_id, &item_slug, &revision, &reason, &iso(extended_until), &client_request_id, &operator, &iso(now)],
        )?
        .ok_or_else(|| Refusal::db("the insert returned no row", None))?;
        record(&inserted)
    })
}

/// `requireReason(reason)` of the learner desk.
fn desk_reason(reason: &str) -> Result<String, Refusal> {
    let t = js_trim(reason);
    if t.is_empty() {
        return refuse(
            "academy.reason_required a reason is required",
            "academy.reason_required",
        );
    }
    Ok(t.to_owned())
}

/// `desk.voidAttempt(input)`: a finished attempt no longer counts; a repeat answers with when it was voided.
pub fn void_attempt(
    pool: &Store,
    user_id: &str,
    attempt_id: &str,
    reason_in: &str,
    actor: &str,
    now: i64,
) -> Result<String, Refusal> {
    let reason = desk_reason(reason_in)?;
    serializable(pool, |tx| {
        let key = format!("{user_id}:assessment");
        query(
            tx,
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&key],
        )?;
        let row = first(
            tx,
            &format!(
                "SELECT slug, score, max_score, {} AS voided_at FROM academy.assessment_attempts \
                 WHERE id = $1::text::uuid AND user_id = $2::text::uuid FOR UPDATE",
                ms("voided_at")
            ),
            &[&attempt_id, &user_id],
        )?;
        let Some(row) = row else {
            return refuse(
                "academy.attempt_not_found no finished attempt of this learner has that id",
                "academy.attempt_not_found",
            );
        };
        if let Some(at) = cell::<Option<i64>>(&row, "voided_at")? {
            return Ok(iso(at));
        }
        exec(
            tx,
            "UPDATE academy.assessment_attempts SET voided_at = $1::text::timestamptz, voided_by = $2::text::uuid, void_reason = $3 \
             WHERE id = $4::text::uuid",
            &[&iso(now), &actor, &reason, &attempt_id],
        )?;
        let slug: String = cell(&row, "slug")?;
        let title = spine::get(&slug).map_or_else(|| slug.clone(), |i| i.title.clone());
        let detail = format!(
            "{title}: quiz attempt scored {} of {} voided, so it no longer counts",
            cell::<i32>(&row, "score")?,
            cell::<i32>(&row, "max_score")?
        );
        exec(
            tx,
            "INSERT INTO academy.learner_events (user_id, kind, key, item_slug, detail, reason, actor_id, at) \
             VALUES ($1::text::uuid, 'quiz_attempt_voided', $2, $3, $4, $5, $6::text::uuid, $7::text::timestamptz) \
             ON CONFLICT (key) DO NOTHING",
            &[
                &user_id,
                &format!("void:{attempt_id}"),
                &slug,
                &detail,
                &reason,
                &actor,
                &iso(now),
            ],
        )?;
        Ok(iso(now))
    })
}

/// `courseItemRules.viewIn(sql, courseId)`.
pub fn item_rules_in<C: GenericClient>(c: &mut C, course_id: &str) -> Result<Json, Refusal> {
    if first(
        c,
        "SELECT id FROM academy.courses WHERE id = $1::text::uuid",
        &[&course_id],
    )?
    .is_none()
    {
        return refuse("no course has that id", "academy.course_not_found");
    }
    let items = query(
        c,
        &format!(
            "SELECT i.id::text AS id, i.title, i.kind, {} AS due_at, \
               ARRAY(SELECT p.prerequisite_id::text FROM academy.course_item_prerequisites p WHERE p.item_id = i.id ORDER BY p.prerequisite_id) \
                 AS prerequisites, \
               ps.reason, ps.set_by::text AS set_by, {} AS set_at \
             FROM academy.course_items i \
             JOIN academy.course_sections s ON s.id = i.section_id \
             LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
             LEFT JOIN academy.course_item_prerequisite_sets ps ON ps.item_id = i.id \
             WHERE i.course_id = $1::text::uuid AND i.kind IN ('assignment', 'quiz') \
             ORDER BY s.position, i.position",
            ms("a.due_at"),
            ms("ps.set_at")
        ),
        &[&course_id],
    )?;
    let extensions = query(
        c,
        &format!(
            "SELECT x.item_id::text AS item_id, x.user_id::text AS user_id, {} AS due_at, x.reason, x.granted_by::text AS granted_by, \
               {} AS granted_at \
             FROM academy.course_item_extensions x JOIN academy.course_items i ON i.id = x.item_id \
             WHERE i.course_id = $1::text::uuid ORDER BY x.granted_at DESC, x.user_id",
            ms("x.due_at"),
            ms("x.granted_at")
        ),
        &[&course_id],
    )?;
    Ok(Json::obj([
        ("courseId", Json::str(course_id)),
        (
            "items",
            Json::Array(
                items
                    .iter()
                    .map(|i| {
                        Ok(Json::obj([
                            ("itemId", Json::String(cell(i, "id")?)),
                            ("title", Json::String(cell(i, "title")?)),
                            ("kind", Json::String(cell(i, "kind")?)),
                            ("dueAt", iso_or_null(cell(i, "due_at")?)),
                            (
                                "prerequisites",
                                Json::Array(
                                    cell::<Vec<String>>(i, "prerequisites")?
                                        .into_iter()
                                        .map(Json::String)
                                        .collect(),
                                ),
                            ),
                            ("setBy", opt_str(cell(i, "set_by")?)),
                            ("setAt", iso_or_null(cell(i, "set_at")?)),
                            ("reason", opt_str(cell(i, "reason")?)),
                        ]))
                    })
                    .collect::<Result<_, Refusal>>()?,
            ),
        ),
        (
            "extensions",
            Json::Array(
                extensions
                    .iter()
                    .map(|x| {
                        Ok(Json::obj([
                            ("itemId", Json::String(cell(x, "item_id")?)),
                            ("userId", Json::String(cell(x, "user_id")?)),
                            ("dueAt", Json::String(iso(cell(x, "due_at")?))),
                            ("reason", Json::String(cell(x, "reason")?)),
                            ("grantedBy", Json::String(cell(x, "granted_by")?)),
                            ("grantedAt", Json::String(iso(cell(x, "granted_at")?))),
                        ]))
                    })
                    .collect::<Result<_, Refusal>>()?,
            ),
        ),
    ]))
}

/// `courseItemRules.adminView(courseId)`.
pub fn item_rules(pool: &Store, course_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| item_rules_in(c, course_id))
}

/// `courseItemRules.grantExtension(input)`: a learner's own later due date on an assignment of the course.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's fields, as the TypeScript takes them"
)]
pub fn grant_course_extension(
    pool: &Store,
    course_id: &str,
    item_id: &str,
    user_id: &str,
    due_at: i64,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        if first(
            tx,
            "SELECT id FROM academy.courses WHERE id = $1::text::uuid FOR UPDATE",
            &[&course_id],
        )?
        .is_none()
        {
            return refuse("no course has that id", "academy.course_not_found");
        }
        let item = first(
            tx,
            &format!(
                "SELECT i.kind, {} AS due_at, a.withdrawn_at IS NOT NULL AS withdrawn, (a.item_id IS NOT NULL) AS has_brief \
                 FROM academy.course_items i LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
                 WHERE i.id = $1::text::uuid AND i.course_id = $2::text::uuid",
                ms("a.due_at")
            ),
            &[&item_id, &course_id],
        )?;
        let item = match item {
            Some(i)
                if cell::<String>(&i, "kind")? == "assignment"
                    && cell::<bool>(&i, "has_brief")? =>
            {
                i
            }
            _ => {
                return refuse(
                    "no assignment of this course has that id",
                    "academy.assignment_not_found",
                );
            }
        };
        if cell::<bool>(&item, "withdrawn")? {
            return refuse(
                "staff withdrew this assignment",
                "academy.assignment_closed",
            );
        }
        let Some(own) = cell::<Option<i64>>(&item, "due_at")? else {
            return refuse(
                "the assignment has no due date to move",
                "academy.window_invalid",
            );
        };
        if due_at <= own {
            return refuse(
                "the new due date is not after the assignment\u{2019}s own",
                "academy.window_invalid",
            );
        }
        if first(
            tx,
            "SELECT 1 FROM academy.course_enrolments WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND left_at IS NULL",
            &[&course_id, &user_id],
        )?
        .is_none()
        {
            return refuse(format!("academy.enrolment_required learner={user_id}"), "academy.enrolment_required");
        }
        let stored = first(
            tx,
            &format!(
                "SELECT {} AS due_at, reason FROM academy.course_item_extensions WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid",
                ms("due_at")
            ),
            &[&item_id, &user_id],
        )?;
        if let Some(s) = stored
            && cell::<i64>(&s, "due_at")? == due_at
            && cell::<String>(&s, "reason")? == reason
        {
            return item_rules_in(tx, course_id);
        }
        exec(
            tx,
            "INSERT INTO academy.course_item_extensions (item_id, user_id, due_at, reason, granted_by, granted_at) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz, $4, $5::text::uuid, $6::text::timestamptz) \
             ON CONFLICT (item_id, user_id) DO UPDATE SET due_at = EXCLUDED.due_at, reason = EXCLUDED.reason, \
               granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at",
            &[
                &item_id,
                &user_id,
                &iso(due_at),
                &reason,
                &operator,
                &iso(now),
            ],
        )?;
        let detail = Json::obj([("dueAt", Json::String(iso(due_at)))]);
        exec(
            tx,
            "INSERT INTO academy.course_item_rule_events (item_id, kind, user_id, detail, reason, actor_id, at) \
             VALUES ($1::text::uuid, 'extension', $2::text::uuid, $3::text::jsonb, $4, $5::text::uuid, $6::text::timestamptz)",
            &[
                &item_id,
                &user_id,
                &detail.compact(),
                &reason,
                &operator,
                &iso(now),
            ],
        )?;
        item_rules_in(tx, course_id)
    })
}
