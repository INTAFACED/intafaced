//! J-academy-14: the learner desk's calls in this slice (`learners/learner-desk.ts`): a learner's progress as staff see
//! it, a staff access record and its reinstatement. Every change names who and why; a blank reason is refused.

use super::sql::Pool;
use service_kit::json::Json;

use super::service::require_reason;
use super::sql::{self, cell, exec, first, iso, ms, q};
use crate::curriculum::{gates, spine};
use crate::errors::{AcademyError, Refusal};

const PATHS: [&str; 4] = ["foundations", "markets", "builder", "sovereign"];

fn window_invalid() -> Refusal {
    AcademyError::new(
        "academy.window_invalid the end must be after now",
        "academy.window_invalid",
    )
    .into()
}

fn next_grant_event(tx: &mut postgres::Transaction<'_>, grant_id: &str) -> Result<i32, Refusal> {
    let r = first(
        tx,
        "SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = $1::text::uuid",
        &[&grant_id],
    )?
    .ok_or_else(|| Refusal::db("SELECT returned no row", None))?;
    cell(&r, 0)
}

pub struct Desk<'a> {
    pub pool: &'a Pool,
}

impl Desk<'_> {
    /// `progress(userId, canChange)`: every course the learner enrolled in or holds a record for, item by item.
    pub fn progress(&self, user_id: &str, can_change: bool) -> Result<Json, Refusal> {
        let path_rows: Vec<String> = sql::column(&sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT path_slug FROM academy.cert_enrollments WHERE user_id = $1::text::uuid \
                 UNION SELECT path_slug FROM academy.access_grants WHERE user_id = $1::text::uuid",
                &[&user_id],
            )
        })?)?;
        let paths: Vec<&str> = PATHS
            .iter()
            .copied()
            .filter(|p| path_rows.iter().any(|r| r == p))
            .collect();
        let slugs: Vec<String> = paths
            .iter()
            .flat_map(|p| {
                spine::list(Some(p), None)
                    .into_iter()
                    .map(|i| i.slug.clone())
            })
            .collect();
        let head = |courses: Json| {
            Json::obj([
                ("userId", Json::str(user_id)),
                ("canChange", Json::Bool(can_change)),
                ("courses", courses),
            ])
        };
        if slugs.is_empty() {
            return Ok(head(Json::Array(Vec::new())));
        }
        let completions = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT item_slug, {} FROM academy.cert_item_completions \
                     WHERE user_id = $1::text::uuid AND item_slug = ANY($2)",
                    ms("completed_at")
                ),
                &[&user_id, &slugs],
            )
        })?;
        let history = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT item_slug, event, {} FROM academy.item_completion_events \
                     WHERE user_id = $1::text::uuid AND item_slug = ANY($2) ORDER BY recorded_at, id",
                    ms("recorded_at")
                ),
                &[&user_id, &slugs],
            )
        })?;
        let windows = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT item_slug, {} FROM academy.item_windows WHERE item_slug = ANY($1)",
                    ms("due_at")
                ),
                &[&slugs],
            )
        })?;
        let extensions = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT DISTINCT ON (item_slug) item_slug, revision, reason, {}, granted_by::text, {} \
                       FROM academy.item_extensions WHERE user_id = $1::text::uuid AND item_slug = ANY($2) \
                      ORDER BY item_slug, revision DESC",
                    ms("extended_until"),
                    ms("granted_at")
                ),
                &[&user_id, &slugs],
            )
        })?;
        let quizzes = sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT slug, attempt_limit FROM academy.quizzes WHERE slug = ANY($1)",
                &[&slugs],
            )
        })?;
        let attempts = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT id::text, slug, score, max_score, passed, {}, {}, voided_by::text, void_reason \
                       FROM academy.assessment_attempts WHERE user_id = $1::text::uuid AND slug = ANY($2) \
                      ORDER BY submitted_at, id",
                    ms("submitted_at"),
                    ms("voided_at")
                ),
                &[&user_id, &slugs],
            )
        })?;
        let find = |rows: &[postgres::Row], slug: &str| -> Result<Option<usize>, Refusal> {
            for (i, r) in rows.iter().enumerate() {
                if cell::<String>(r, 0)? == slug {
                    return Ok(Some(i));
                }
            }
            Ok(None)
        };
        let mut courses = Vec::new();
        for path in &paths {
            let mut items = Vec::new();
            for item in spine::list(Some(path), None) {
                let slug = item.slug.as_str();
                let done = find(&completions, slug)?.and_then(|i| completions.get(i));
                let mut past = Vec::new();
                for h in &history {
                    if cell::<String>(h, 0)? == slug {
                        past.push(Json::obj([
                            ("event", Json::String(cell(h, 1)?)),
                            ("at", Json::str(iso(cell(h, 2)?))),
                        ]));
                    }
                }
                let quiz = find(&quizzes, slug)?.and_then(|i| quizzes.get(i));
                let mut tries = Vec::new();
                let mut counted = 0i64;
                for a in &attempts {
                    if cell::<String>(a, 1)? != slug {
                        continue;
                    }
                    let voided_at: Option<i64> = cell(a, 6)?;
                    if voided_at.is_none() {
                        counted += 1;
                    }
                    let voided = match voided_at {
                        None => Json::Null,
                        Some(at) => Json::obj([
                            ("at", Json::str(iso(at))),
                            (
                                "by",
                                Json::String(cell::<Option<String>>(a, 7)?.unwrap_or_default()),
                            ),
                            (
                                "reason",
                                Json::String(cell::<Option<String>>(a, 8)?.unwrap_or_default()),
                            ),
                        ]),
                    };
                    tries.push(Json::obj([
                        ("attemptId", Json::String(cell(a, 0)?)),
                        ("score", Json::int(i64::from(cell::<i32>(a, 2)?))),
                        ("maxScore", Json::int(i64::from(cell::<i32>(a, 3)?))),
                        ("passed", Json::Bool(cell(a, 4)?)),
                        ("submittedAt", Json::str(iso(cell(a, 5)?))),
                        ("voided", voided),
                    ]));
                }
                let ext = find(&extensions, slug)?.and_then(|i| extensions.get(i));
                let due = match find(&windows, slug)?.and_then(|i| windows.get(i)) {
                    Some(w) => cell::<Option<i64>>(w, 1)?.map_or(Json::Null, |d| Json::str(iso(d))),
                    None => Json::Null,
                };
                let status = if done.is_some() {
                    "completed"
                } else if past.is_empty() {
                    "not_started"
                } else {
                    "undone"
                };
                let quiz_json = if quiz.is_some() || !tries.is_empty() {
                    let limit = match quiz {
                        Some(qr) => cell::<Option<i32>>(qr, 1)?
                            .map_or(Json::Null, |l| Json::int(i64::from(l))),
                        None => Json::Null,
                    };
                    Json::obj([
                        ("attemptLimit", limit),
                        ("counted", Json::int(counted)),
                        ("attempts", Json::Array(tries)),
                    ])
                } else {
                    Json::Null
                };
                let extension = match ext {
                    None => Json::Null,
                    Some(x) => Json::obj([
                        ("until", Json::str(iso(cell(x, 3)?))),
                        ("reason", Json::String(cell(x, 2)?)),
                        ("grantedBy", Json::String(cell(x, 4)?)),
                        ("grantedAt", Json::str(iso(cell(x, 5)?))),
                        ("revision", Json::int(i64::from(cell::<i32>(x, 1)?))),
                    ]),
                };
                items.push(Json::obj([
                    ("slug", Json::str(item.slug.clone())),
                    ("title", Json::str(item.title.clone())),
                    ("kind", Json::str(item.kind.clone())),
                    ("status", Json::str(status)),
                    (
                        "completedAt",
                        done.map_or(Ok(Json::Null), |d| {
                            cell::<i64>(d, 1).map(|t| Json::str(iso(t)))
                        })?,
                    ),
                    ("history", Json::Array(past)),
                    ("dueAt", due),
                    ("extension", extension),
                    ("quiz", quiz_json),
                ]));
            }
            courses.push(Json::obj([
                ("pathSlug", Json::str(*path)),
                ("items", Json::Array(items)),
            ]));
        }
        Ok(head(Json::Array(courses)))
    }

    /// `grantAccess`: a staff access record keyed `grant:<course>:<learner>`; a repeat answers with the stored one.
    pub fn grant_access(
        &self,
        user_id: &str,
        path_slug: &str,
        reason: &str,
        expires_at: Option<i64>,
        actor_id: &str,
        now: i64,
    ) -> Result<(), Refusal> {
        let reason = require_reason(reason)?;
        if expires_at.is_some_and(|e| e <= now) {
            return Err(window_invalid());
        }
        let at = iso(now);
        let expires = expires_at.map(iso);
        let key = format!("grant:{path_slug}:{user_id}");
        sql::serializable(self.pool, |tx| {
            let row = first(
                tx,
                "INSERT INTO academy.access_grants (user_id, path_slug, source, reason, starts_at, expires_at, state, \
                   created_at, updated_at) \
                 VALUES ($1::text::uuid, $2, 'staff', $3, $4::text::timestamptz, $5::text::timestamptz, 'granted', \
                   $4::text::timestamptz, $4::text::timestamptz) \
                 ON CONFLICT (path_slug, user_id) DO NOTHING RETURNING id::text",
                &[&user_id, &path_slug, &reason, &at, &expires],
            )?;
            let Some(row) = row else {
                let held = first(
                    tx,
                    "SELECT state FROM academy.access_grants WHERE path_slug = $1 AND user_id = $2::text::uuid",
                    &[&path_slug, &user_id],
                )?;
                if let Some(h) = held
                    && cell::<String>(&h, 0)? != "granted"
                {
                    return Err(AcademyError::new(
                        "academy.grant_expired this access has ended: reinstate it instead",
                        "academy.grant_expired",
                    )
                    .into());
                }
                return Ok(());
            };
            let id: String = cell(&row, 0)?;
            exec(
                tx,
                "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at) \
                 VALUES ($1::text::uuid, 1, 'granted', $2, $3, $4::text::uuid, $5::text::timestamptz, $6::text::timestamptz)",
                &[&id, &key, &reason, &actor_id, &expires, &at],
            )?;
            Ok(())
        })
    }

    /// `reinstate`: the same record granted again, keyed `reinstate:<grant>:<n>`.
    #[expect(
        clippy::too_many_arguments,
        reason = "the call's own fields, as the TypeScript takes them"
    )]
    pub fn reinstate(
        &self,
        user_id: &str,
        grant_id: &str,
        reason: &str,
        expires_at: Option<i64>,
        n: i64,
        actor_id: &str,
        now: i64,
    ) -> Result<(), Refusal> {
        let reason = require_reason(reason)?;
        if expires_at.is_some_and(|e| e <= now) {
            return Err(window_invalid());
        }
        gates::settle_expiries(self.pool.pool()?, user_id, now)?;
        let key = format!("reinstate:{grant_id}:{n}");
        let at = iso(now);
        let expires = expires_at.map(iso);
        sql::serializable(self.pool, |tx| {
            let grant = first(
                tx,
                &format!(
                    "SELECT id::text, user_id::text, path_slug, source, reason, {}, {}, state \
                       FROM academy.access_grants WHERE id = $1::text::uuid AND user_id = $2::text::uuid FOR UPDATE",
                    ms("starts_at"),
                    ms("expires_at")
                ),
                &[&grant_id, &user_id],
            )?
            .ok_or_else(|| {
                Refusal::from(AcademyError::new(
                    "academy.grant_not_found this learner has no such access record",
                    "academy.grant_not_found",
                ))
            })?;
            if first(
                tx,
                "SELECT 1 FROM academy.access_grant_events WHERE key = $1",
                &[&key],
            )?
            .is_some()
            {
                return Ok(());
            }
            let id: String = cell(&grant, 0)?;
            if cell::<String>(&grant, 7)? == "granted" {
                return Err(AcademyError::new(
                    "academy.grant_active this access has not ended",
                    "academy.grant_active",
                )
                .into());
            }
            let next = next_grant_event(tx, &id)?;
            if i64::from(next) != n {
                return Err(AcademyError::new(
                    format!("academy.revision_stale the next event is {next}"),
                    "academy.revision_stale",
                )
                .into());
            }
            exec(
                tx,
                "UPDATE academy.access_grants SET state = 'granted', expires_at = $1::text::timestamptz, \
                 updated_at = $2::text::timestamptz WHERE id = $3::text::uuid",
                &[&expires, &at, &id],
            )?;
            exec(
                tx,
                "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at) \
                 VALUES ($1::text::uuid, $2, 'reinstated', $3, $4, $5::text::uuid, $6::text::timestamptz, \
                   $7::text::timestamptz)",
                &[&id, &next, &key, &reason, &actor_id, &expires, &at],
            )?;
            Ok(())
        })
    }
}
