//! The learner's own rows (`learning/customer-store.ts` `AcademyCustomerStore`, its learner part): path enrolments, the
//! reading position and active days, the video watch position, the grant audit and the enrolment counts. Every write is
//! keyed by the caller's request id or the row's own business key, so a lost reply sent again answers as the first did.

use postgres::Row;
use service_kit::json::Json;
use super::sql::Pool;
use service_kit::schema::js_trim;

use super::sql::{self, cell, column, exec, first, iso, ms, q};
use super::video;
use crate::curriculum::spine;
use crate::errors::{AcademyError, Refusal};

/// `PATHS`: the programmes a path enrolment may name.
pub const PATHS: [&str; 4] = ["foundations", "markets", "builder", "sovereign"];

/// `ACADEMY_CUSTOMER_LIST_MAX`.
pub const CUSTOMER_LIST_MAX: i64 = 200;
/// `TOUCH_LESSON_MAX_SECONDS`: one touch claims at most one UTC day of reading.
pub const TOUCH_LESSON_MAX_SECONDS: i64 = 86_400;
/// `OPS_METRICS_MAX_DAYS`.
pub const OPS_METRICS_MAX_DAYS: i64 = 366;

/// `EnrollmentRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enrollment {
    pub user_id: String,
    pub path_slug: String,
    pub enrolled_at: i64,
    pub left_at: Option<i64>,
}

impl Enrollment {
    /// `{ userId, pathSlug, enrolledAt, leftAt }`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("pathSlug", Json::str(self.path_slug.clone())),
            ("enrolledAt", Json::str(iso(self.enrolled_at))),
            ("leftAt", self.left_at.map_or(Json::Null, |l| Json::str(iso(l)))),
        ])
    }
}

fn enrollment_columns() -> String {
    format!(
        "user_id::text, path_slug, {}, {}",
        ms("enrolled_at"),
        ms("left_at")
    )
}

fn enrollment_of(row: &Row) -> Result<Enrollment, Refusal> {
    Ok(Enrollment {
        user_id: cell(row, 0)?,
        path_slug: cell(row, 1)?,
        enrolled_at: cell(row, 2)?,
        left_at: cell(row, 3)?,
    })
}

/// `LearningStateRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LearningState {
    pub last_item_slug: Option<String>,
    pub last_opened_at: Option<i64>,
    pub seconds_read: i64,
    pub active_days: i64,
}

impl LearningState {
    /// `learningStateOut`.
    pub fn json(&self) -> Json {
        Json::obj([
            (
                "lastItemSlug",
                self.last_item_slug.clone().map_or(Json::Null, Json::String),
            ),
            (
                "lastOpenedAt",
                self.last_opened_at.map_or(Json::Null, |t| Json::str(iso(t))),
            ),
            ("secondsRead", Json::int(self.seconds_read)),
            ("activeDays", Json::int(self.active_days)),
        ])
    }
}

/// `assertCustomerListLimit(limit, code, label)`.
pub fn list_limit(limit: Option<f64>, code: &str, label: &str) -> Result<i64, Refusal> {
    let unset = || {
        Refusal::from(AcademyError::new(
            format!("{label} list limit is unset — pass limit (never invent the whole table)"),
            code,
        ))
    };
    let Some(limit) = limit.filter(|l| l.is_finite()) else {
        return Err(unset());
    };
    let n = limit.floor();
    if n < 1.0 {
        return Err(unset());
    }
    #[expect(clippy::cast_possible_truncation, reason = "capped at the list maximum")]
    Ok(n.min(CUSTOMER_LIST_MAX as f64) as i64)
}

/// `assertTouchSeconds`.
pub fn touch_seconds(seconds: Option<f64>) -> Result<i64, Refusal> {
    let Some(s) = seconds else {
        return Ok(0);
    };
    #[expect(clippy::cast_precision_loss, reason = "a small bound")]
    let max = TOUCH_LESSON_MAX_SECONDS as f64;
    if !s.is_finite() || s.fract() != 0.0 || s < 0.0 || s > max {
        return Err(AcademyError::new(
            format!(
                "secondsRead must be an integer from 0 to {TOUCH_LESSON_MAX_SECONDS} (TOUCH_LESSON_MAX_SECONDS)"
            ),
            "academy.seconds_out_of_range",
        )
        .into());
    }
    #[expect(clippy::cast_possible_truncation, reason = "a whole number in range")]
    Ok(s as i64)
}

fn int(row: &Row, i: usize) -> Result<i64, Refusal> {
    cell::<i32>(row, i).map(i64::from)
}

pub struct Store<'a> {
    pub pool: &'a Pool,
}

impl Store<'_> {
    /// `activePathSlugs`.
    pub fn active_path_slugs(&self, user_id: &str) -> Result<Vec<String>, Refusal> {
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT path_slug FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL",
                &[&user_id],
            )
        })?;
        column(&rows)
    }

    /// `enrollCertPath`: the path checked against the programmes, their prerequisites read, then one enrolment per
    /// learner and path; under a seat cap the count and the insert hold one lock per course.
    pub fn enroll_cert_path(
        &self,
        user_id: &str,
        path_slug: &str,
        seat_cap: Option<i64>,
    ) -> Result<Enrollment, Refusal> {
        let path_slug = js_trim(path_slug).to_lowercase();
        if !PATHS.contains(&path_slug.as_str()) {
            return Err(AcademyError::new(
                "pathSlug must be one of foundations | markets | builder | sovereign",
                "academy.cert_invalid",
            )
            .into());
        }
        // Every programme of the catalog has no prerequisite; the read is still made, as the TypeScript makes it.
        let _active = self.active_path_slugs(user_id)?;
        let Some(cap) = seat_cap else {
            let row = sql::on_pool(self.pool, |c| {
                first(
                    c,
                    &format!(
                        "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) \
                         VALUES ($1::text::uuid, $2, now()) \
                         ON CONFLICT (user_id, path_slug) WHERE left_at IS NULL \
                         DO UPDATE SET path_slug = EXCLUDED.path_slug RETURNING {}",
                        enrollment_columns()
                    ),
                    &[&user_id, &path_slug],
                )
            })?;
            return enrollment_of(&row.ok_or_else(|| Refusal::db("INSERT returned no row", None))?);
        };
        let lock = format!("academy.course_seats:{path_slug}");
        sql::serializable(self.pool, |tx| {
            exec(tx, "SELECT pg_advisory_xact_lock(hashtext($1))", &[&lock])?;
            let mine = first(
                tx,
                &format!(
                    "SELECT {} FROM academy.cert_enrollments \
                     WHERE user_id = $1::text::uuid AND path_slug = $2 AND left_at IS NULL",
                    enrollment_columns()
                ),
                &[&user_id, &path_slug],
            )?;
            if let Some(mine) = mine {
                return enrollment_of(&mine);
            }
            let taken = first(
                tx,
                "SELECT count(*)::int AS n FROM academy.cert_enrollments WHERE path_slug = $1 AND left_at IS NULL",
                &[&path_slug],
            )?
            .map_or(Ok(0), |r| int(&r, 0))?;
            if taken >= cap {
                return Err(AcademyError::new(
                    "academy.enrolment_closed track=audit reason=full",
                    "academy.enrolment_closed",
                )
                .into());
            }
            let row = first(
                tx,
                &format!(
                    "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) \
                     VALUES ($1::text::uuid, $2, now()) RETURNING {}",
                    enrollment_columns()
                ),
                &[&user_id, &path_slug],
            )?;
            enrollment_of(&row.ok_or_else(|| Refusal::db("INSERT returned no row", None))?)
        })
    }

    /// `seatsTaken`.
    pub fn seats_taken(&self, path_slug: &str) -> Result<i64, Refusal> {
        sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT count(*)::int AS n FROM academy.cert_enrollments WHERE path_slug = $1 AND left_at IS NULL",
                &[&path_slug],
            )?
            .map_or(Ok(0), |r| int(&r, 0))
        })
    }

    /// `myEnrollments`: the caller's active enrolments, oldest first.
    pub fn my_enrollments(&self, user_id: &str) -> Result<Vec<Enrollment>, Refusal> {
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT {} FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL \
                     ORDER BY enrolled_at ASC, path_slug ASC",
                    enrollment_columns()
                ),
                &[&user_id],
            )
        })?;
        rows.iter().map(enrollment_of).collect()
    }

    /// `learningState`.
    pub fn learning_state(&self, user_id: &str) -> Result<LearningState, Refusal> {
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "SELECT last_item_slug, {}, seconds_read FROM academy.learning_state WHERE user_id = $1::text::uuid",
                    ms("last_opened_at")
                ),
                &[&user_id],
            )
        })?;
        let days = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT COUNT(*)::int AS n FROM academy.learning_active_days WHERE user_id = $1::text::uuid",
                &[&user_id],
            )?
            .map_or(Ok(0), |r| int(&r, 0))
        })?;
        let Some(row) = row else {
            return Ok(LearningState {
                last_item_slug: None,
                last_opened_at: None,
                seconds_read: 0,
                active_days: 0,
            });
        };
        Ok(LearningState {
            last_item_slug: Some(cell(&row, 0)?),
            last_opened_at: Some(cell(&row, 1)?),
            seconds_read: int(&row, 2)?,
            active_days: days,
        })
    }

    /// `touchLesson`: the reading position, the seconds read and the active day, once per request id.
    pub fn touch_lesson(
        &self,
        user_id: &str,
        slug: &str,
        seconds_read: Option<f64>,
        client_request_id: &str,
        now: i64,
    ) -> Result<LearningState, Refusal> {
        let slug = js_trim(slug).to_owned();
        let client_request_id = js_trim(client_request_id).to_owned();
        if client_request_id.is_empty() {
            return Err(
                AcademyError::new("clientRequestId is required", "academy.cert_invalid").into(),
            );
        }
        if !spine::has(&slug) {
            return Err(AcademyError::new(
                "Unknown curriculum item",
                "academy.curriculum_not_found",
            )
            .into());
        }
        let seconds = i32::try_from(touch_seconds(seconds_read)?).unwrap_or(i32::MAX);
        let at = iso(now);
        let day = at.get(..10).unwrap_or_default().to_owned();
        let lock = format!("{user_id}:touch");
        sql::serializable(self.pool, |tx| {
            exec(
                tx,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&lock],
            )?;
            let replay = first(
                tx,
                &format!(
                    "SELECT last_item_slug, {}, seconds_read, active_days FROM academy.learning_touches \
                     WHERE user_id = $1::text::uuid AND client_request_id = $2",
                    ms("last_opened_at")
                ),
                &[&user_id, &client_request_id],
            )?;
            if let Some(r) = replay {
                return Ok(LearningState {
                    last_item_slug: Some(cell(&r, 0)?),
                    last_opened_at: Some(cell(&r, 1)?),
                    seconds_read: int(&r, 2)?,
                    active_days: int(&r, 3)?,
                });
            }
            let state = first(
                tx,
                &format!(
                    "INSERT INTO academy.learning_state (user_id, last_item_slug, last_opened_at, seconds_read) \
                     VALUES ($1::text::uuid, $2, $3::text::timestamptz, $4) \
                     ON CONFLICT (user_id) DO UPDATE SET \
                       last_item_slug = EXCLUDED.last_item_slug, \
                       last_opened_at = EXCLUDED.last_opened_at, \
                       seconds_read = academy.learning_state.seconds_read + EXCLUDED.seconds_read \
                     RETURNING last_item_slug, {}, seconds_read",
                    ms("last_opened_at")
                ),
                &[&user_id, &slug, &at, &seconds],
            )?
            .ok_or_else(|| Refusal::db("INSERT returned no row", None))?;
            exec(
                tx,
                "INSERT INTO academy.learning_active_days (user_id, active_on) VALUES ($1::text::uuid, $2::text::date) \
                 ON CONFLICT (user_id, active_on) DO NOTHING",
                &[&user_id, &day],
            )?;
            let active_days = first(
                tx,
                "SELECT COUNT(*)::int AS n FROM academy.learning_active_days WHERE user_id = $1::text::uuid",
                &[&user_id],
            )?
            .map_or(Ok(0), |r| int(&r, 0))?;
            let last_item: String = cell(&state, 0)?;
            let last_opened: i64 = cell(&state, 1)?;
            let read: i32 = cell(&state, 2)?;
            let opened = iso(last_opened);
            let days32 = i32::try_from(active_days).unwrap_or(i32::MAX);
            exec(
                tx,
                "INSERT INTO academy.learning_touches (user_id, client_request_id, item_slug, seconds_added, touched_at, \
                   last_item_slug, last_opened_at, seconds_read, active_days) \
                 VALUES ($1::text::uuid, $2, $3, $4, $5::text::timestamptz, $6, $7::text::timestamptz, $8, $9)",
                &[
                    &user_id,
                    &client_request_id,
                    &slug,
                    &seconds,
                    &at,
                    &last_item,
                    &opened,
                    &read,
                    &days32,
                ],
            )?;
            Ok(LearningState {
                last_item_slug: Some(last_item),
                last_opened_at: Some(last_opened),
                seconds_read: i64::from(read),
                active_days,
            })
        })
    }

    /// `setVideoProgress`: the position stored once per request id, with the position before it, or the first answer
    /// for a repeated request.
    pub fn set_video_progress(
        &self,
        user_id: &str,
        video_slug: &str,
        position_seconds: f64,
        client_request_id: &str,
        now: i64,
    ) -> Result<VideoSaved, Refusal> {
        let client_request_id = js_trim(client_request_id).to_owned();
        if client_request_id.is_empty() {
            return Err(
                AcademyError::new("clientRequestId is required", "academy.cert_invalid").into(),
            );
        }
        let item = video::spine_item(video_slug).ok_or_else(|| video::not_on_spine(video_slug))?;
        let p = position_seconds;
        if !p.is_finite() || p.fract() != 0.0 || p < 0.0 {
            return Err(AcademyError::new(
                "positionSeconds must be a non-negative integer",
                "academy.video_position_out_of_range",
            )
            .into());
        }
        #[expect(clippy::cast_possible_truncation, reason = "a whole number")]
        let position = p as i64;
        if let Some(duration) = item.duration_seconds
            && position > duration
        {
            return Err(AcademyError::new(
                format!("positionSeconds {position} exceeds durationSeconds {duration}"),
                "academy.video_position_out_of_range",
            )
            .into());
        }
        let position32 = i32::try_from(position).map_err(|_| {
            Refusal::db(
                format!("value \"{position}\" is out of range for type integer"),
                Some("22003".to_owned()),
            )
        })?;
        let at = iso(now);
        let lock = format!("{user_id}:video");
        sql::serializable(self.pool, |tx| {
            exec(
                tx,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&lock],
            )?;
            let replay = first(
                tx,
                "SELECT video_slug, position_seconds FROM academy.video_progress_requests \
                 WHERE user_id = $1::text::uuid AND client_request_id = $2",
                &[&user_id, &client_request_id],
            )?;
            if let Some(r) = replay {
                return Ok(VideoSaved {
                    video_slug: cell(&r, 0)?,
                    position_seconds: Some(int(&r, 1)?),
                    previous_seconds: None,
                    replayed: true,
                });
            }
            let before = first(
                tx,
                "SELECT position_seconds FROM academy.video_progress WHERE user_id = $1::text::uuid AND video_slug = $2",
                &[&user_id, &video_slug],
            )?
            .map(|r| int(&r, 0))
            .transpose()?;
            exec(
                tx,
                "INSERT INTO academy.video_progress (user_id, video_slug, position_seconds, updated_at) \
                 VALUES ($1::text::uuid, $2, $3, $4::text::timestamptz) \
                 ON CONFLICT (user_id, video_slug) DO UPDATE SET \
                   position_seconds = EXCLUDED.position_seconds, updated_at = EXCLUDED.updated_at",
                &[&user_id, &video_slug, &position32, &at],
            )?;
            exec(
                tx,
                "INSERT INTO academy.video_progress_requests (user_id, client_request_id, video_slug, position_seconds) \
                 VALUES ($1::text::uuid, $2, $3, $4)",
                &[&user_id, &client_request_id, &video_slug, &position32],
            )?;
            Ok(VideoSaved {
                video_slug: video_slug.to_owned(),
                position_seconds: Some(position),
                previous_seconds: before,
                replayed: false,
            })
        })
    }

    /// `getVideoProgress`: the stored position, or null.
    pub fn get_video_progress(&self, user_id: &str, video_slug: &str) -> Result<Json, Refusal> {
        if video::spine_item(video_slug).is_none() {
            return Err(video::not_on_spine(video_slug));
        }
        let position = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT position_seconds FROM academy.video_progress WHERE user_id = $1::text::uuid AND video_slug = $2",
                &[&user_id, &video_slug],
            )?
            .map(|r| int(&r, 0))
            .transpose()
        })?;
        Ok(video_position_json(video_slug, position))
    }

    /// The stored position alone (the router's `watched` read).
    pub fn video_position(&self, user_id: &str, video_slug: &str) -> Result<Option<i64>, Refusal> {
        if video::spine_item(video_slug).is_none() {
            return Err(video::not_on_spine(video_slug));
        }
        sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT position_seconds FROM academy.video_progress WHERE user_id = $1::text::uuid AND video_slug = $2",
                &[&user_id, &video_slug],
            )?
            .map(|r| int(&r, 0))
            .transpose()
        })
    }

    /// `grantAudit`: course access events, certificates issued and certificates revoked, newest first, one page.
    pub fn grant_audit(
        &self,
        limit: Option<f64>,
        cursor: Option<&str>,
        course: Option<&str>,
        certificate: Option<&str>,
    ) -> Result<Json, Refusal> {
        let limit = list_limit(limit, "academy.grant_audit_list_limit_unset", "Grant audit")?;
        let cursor = cursor.filter(|c| !c.is_empty()).map(decode_grant_cursor).transpose()?;
        let course = course
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let certificate = certificate
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let at_cursor = cursor.as_ref().map(|c| c.0.clone());
        let ref_cursor = cursor.as_ref().map(|c| c.1.clone());
        let read_access = certificate.is_none();
        let read_certs = course.is_none();
        let page = limit + 1;
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT user_id::text, kind, target, source, actor_id, reason, {}, \
                       to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS at_text, reference \
                     FROM ( \
                       (SELECT g.user_id, 'access_' || e.kind AS kind, g.path_slug AS target, \
                               CASE WHEN e.kind = 'granted' THEN g.source END AS source, e.actor_id::text AS actor_id, e.reason, e.at, \
                               e.key AS reference \
                          FROM academy.access_grant_events e \
                          JOIN academy.access_grants g ON g.id = e.grant_id \
                         WHERE $1::bool \
                           AND ($3::text IS NULL OR g.path_slug = $3) \
                           AND ($5::text::timestamptz IS NULL OR (e.at, e.key) < ($5::text::timestamptz, $6::text)) \
                         ORDER BY e.at DESC, e.key DESC \
                         LIMIT $7) \
                       UNION ALL \
                       (SELECT g.user_id, 'certificate_granted', g.cert_id, CASE WHEN x.public_id IS NULL THEN 'issue' ELSE 'exception' END, \
                               x.granted_by::text, x.reason, g.granted_at, g.idempotency_key \
                          FROM academy.cert_grants g \
                          LEFT JOIN academy.cert_exceptions x ON x.public_id = g.public_id \
                         WHERE $2::bool \
                           AND ($4::text IS NULL OR g.cert_id = $4) \
                           AND ($5::text::timestamptz IS NULL OR (g.granted_at, g.idempotency_key) < ($5::text::timestamptz, $6::text)) \
                         ORDER BY g.granted_at DESC, g.idempotency_key DESC \
                         LIMIT $7) \
                       UNION ALL \
                       (SELECT user_id, 'certificate_revoked', cert_id, NULL, revoked_by::text, reason, revoked_at, 'revoke:' || public_id \
                          FROM academy.cert_revocations \
                         WHERE $2::bool \
                           AND ($4::text IS NULL OR cert_id = $4) \
                           AND ($5::text::timestamptz IS NULL \
                                OR (revoked_at, 'revoke:' || public_id) < ($5::text::timestamptz, $6::text)) \
                         ORDER BY revoked_at DESC, public_id DESC \
                         LIMIT $7) \
                     ) lines \
                     ORDER BY at DESC, reference DESC \
                     LIMIT $7",
                    ms("at")
                ),
                &[
                    &read_access,
                    &read_certs,
                    &course,
                    &certificate,
                    &at_cursor,
                    &ref_cursor,
                    &page,
                ],
            )
        })?;
        let shown = usize::try_from(limit).unwrap_or(usize::MAX);
        let mut items = Vec::new();
        for r in rows.iter().take(shown) {
            items.push(Json::obj([
                ("accountId", Json::String(cell(r, 0)?)),
                ("kind", Json::String(cell(r, 1)?)),
                ("target", Json::String(cell(r, 2)?)),
                (
                    "source",
                    cell::<Option<String>>(r, 3)?.map_or(Json::Null, Json::String),
                ),
                (
                    "actorId",
                    cell::<Option<String>>(r, 4)?.map_or(Json::Null, Json::String),
                ),
                (
                    "reason",
                    cell::<Option<String>>(r, 5)?.map_or(Json::Null, Json::String),
                ),
                ("at", Json::str(iso(cell(r, 6)?))),
                ("reference", Json::String(cell(r, 8)?)),
            ]));
        }
        let next = if rows.len() > shown {
            match rows.get(shown.wrapping_sub(1)) {
                Some(last) if shown > 0 => Json::str(encode_grant_cursor(
                    &cell::<String>(last, 7)?,
                    &cell::<String>(last, 8)?,
                )),
                _ => Json::Null,
            }
        } else {
            Json::Null
        };
        Ok(Json::obj([
            ("items", Json::Array(items)),
            ("nextCursor", next),
        ]))
    }

    /// `enrolments({ from, to })`: path enrolments begun in the UTC days asked, per path.
    pub fn enrolments(&self, from: &str, to: &str) -> Result<Json, Refusal> {
        let window = utc_window("enrolments", from, to)?;
        let start = iso(window.start);
        let end = iso(window.end_exclusive);
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT path_slug, COUNT(*)::int AS n FROM academy.cert_enrollments \
                 WHERE enrolled_at >= $1::text::timestamptz AND enrolled_at < $2::text::timestamptz \
                 GROUP BY path_slug ORDER BY path_slug",
                &[&start, &end],
            )
        })?;
        let mut total = 0;
        let mut paths = Vec::new();
        for r in &rows {
            let n = int(r, 1)?;
            total += n;
            paths.push(Json::obj([
                ("pathSlug", Json::String(cell(r, 0)?)),
                ("count", Json::int(n)),
            ]));
        }
        Ok(Json::obj([
            ("from", Json::str(window.from_iso)),
            ("to", Json::str(window.to_iso)),
            ("total", Json::int(total)),
            ("paths", Json::Array(paths)),
        ]))
    }
}

/// What `setVideoProgress` stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoSaved {
    pub video_slug: String,
    pub position_seconds: Option<i64>,
    pub previous_seconds: Option<i64>,
    pub replayed: bool,
}

/// `academyVideoPositionSchema`.
pub fn video_position_json(video_slug: &str, position: Option<i64>) -> Json {
    Json::obj([
        ("videoSlug", Json::str(video_slug)),
        ("positionSeconds", position.map_or(Json::Null, Json::int)),
    ])
}

/// `UtcWindow`.
pub struct UtcWindow {
    pub from_iso: String,
    pub to_iso: String,
    pub start: i64,
    pub end_exclusive: i64,
}

const DAY_MS: i64 = 86_400_000;

/// `parseUtcDay`: `YYYY-MM-DD`, a real day of the calendar.
pub fn parse_utc_day(value: &str) -> Option<(i64, String)> {
    let b = value.as_bytes();
    if b.len() != 10 || b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = value.get(r)?;
        if !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let (y, m, d) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    if !(1..=12).contains(&m) || d < 1 || d > service_kit::time::days_in_month(y, m) {
        return None;
    }
    Some((
        service_kit::time::days_from_civil(y, m, d) * DAY_MS,
        value.to_owned(),
    ))
}

/// `utcWindow(label, from, to)`.
pub fn utc_window(label: &str, from: &str, to: &str) -> Result<UtcWindow, Refusal> {
    let invalid = |m: String| Refusal::from(AcademyError::new(m, "academy.metrics_range_invalid"));
    let (Some((from_utc, from_iso)), Some((to_utc, to_iso))) =
        (parse_utc_day(from), parse_utc_day(to))
    else {
        return Err(invalid(format!(
            "{label} from and to must be UTC days YYYY-MM-DD"
        )));
    };
    if from_utc > to_utc {
        return Err(invalid(format!("{label} from is after to")));
    }
    let span = (to_utc - from_utc) / DAY_MS + 1;
    if span > OPS_METRICS_MAX_DAYS {
        return Err(invalid(format!(
            "{label} range is {span} days; OPS_METRICS_MAX_DAYS is {OPS_METRICS_MAX_DAYS}"
        )));
    }
    Ok(UtcWindow {
        from_iso,
        to_iso,
        start: from_utc,
        end_exclusive: to_utc + DAY_MS,
    })
}

/// `encodeGrantCursor`: the last line's time as the database wrote it (to the microsecond) and its reference.
pub fn encode_grant_cursor(at_text: &str, reference: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{at_text}\n{reference}"))
}

/// `Buffer.from(s, 'base64url')`: Node skips any character outside the alphabet (and padding) and decodes the rest.
fn base64url_lenient(s: &str) -> Vec<u8> {
    let value = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'-' | b'+' => Some(62),
            b'_' | b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = value(c) else {
            continue;
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).unwrap_or(0));
        }
    }
    out
}

fn grant_cursor_time(s: &str) -> bool {
    // ^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$
    let b = s.as_bytes();
    let shape = b"dddd-dd-ddTdd:dd:dd.ddddddZ";
    b.len() == shape.len()
        && b.iter().zip(shape.iter()).all(|(c, s)| match s {
            b'd' => c.is_ascii_digit(),
            other => c == other,
        })
}

/// `decodeGrantCursor`.
pub fn decode_grant_cursor(cursor: &str) -> Result<(String, String), Refusal> {
    let raw = String::from_utf8_lossy(&base64url_lenient(cursor)).into_owned();
    let (at_text, reference) = match raw.find('\n') {
        Some(nl) if nl > 0 => (
            raw.get(..nl).unwrap_or_default().to_owned(),
            raw.get(nl + 1..).unwrap_or_default().to_owned(),
        ),
        _ => (String::new(), String::new()),
    };
    if !grant_cursor_time(&at_text) || reference.is_empty() {
        return Err(AcademyError::new("cursor is not valid", "academy.cert_invalid").into());
    }
    Ok((at_text, reference))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_utc_day_is_a_real_calendar_day() {
        assert!(parse_utc_day("2026-02-29").is_none());
        assert!(parse_utc_day("2028-02-29").is_some());
        assert!(parse_utc_day("2026-1-01").is_none());
        let w = utc_window("enrolments", "2026-11-01", "2026-11-02").unwrap();
        assert_eq!(w.end_exclusive - w.start, 2 * DAY_MS);
        assert_eq!(
            code(utc_window("enrolments", "2026-11-02", "2026-11-01")),
            "academy.metrics_range_invalid"
        );
        assert!(matches!(
            utc_window("enrolments", "2025-01-01", "2026-01-02"),
            Err(Refusal::Academy(e)) if e.message == "enrolments range is 367 days; OPS_METRICS_MAX_DAYS is 366"
        ));
    }

    fn code<T>(r: Result<T, Refusal>) -> String {
        match r {
            Err(Refusal::Academy(e)) => e.code,
            _ => String::new(),
        }
    }

    #[test]
    fn the_grant_cursor_round_trips_and_a_bad_one_refuses() {
        let c = encode_grant_cursor("2026-11-20T01:02:03.123456Z", "grant:foundations:x");
        assert_eq!(
            decode_grant_cursor(&c).unwrap(),
            (
                "2026-11-20T01:02:03.123456Z".to_owned(),
                "grant:foundations:x".to_owned()
            )
        );
        assert_eq!(code(decode_grant_cursor("bm9wZQ")), "academy.cert_invalid");
    }

    #[test]
    fn a_list_limit_is_floored_capped_and_never_invented() {
        assert_eq!(list_limit(Some(3.7), "c", "L").unwrap(), 3);
        assert_eq!(list_limit(Some(5000.0), "c", "L").unwrap(), 200);
        assert_eq!(code(list_limit(None, "c", "L")), "c");
        assert_eq!(code(list_limit(Some(0.5), "c", "L")), "c");
        assert_eq!(touch_seconds(None).unwrap(), 0);
        assert_eq!(
            code(touch_seconds(Some(86_401.0))),
            "academy.seconds_out_of_range"
        );
        assert_eq!(code(touch_seconds(Some(1.5))), "academy.seconds_out_of_range");
    }
}
