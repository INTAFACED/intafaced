//! The learner's parts of `academy-service.ts`, method for method: the course enrolment and its terms, My learning, the
//! access records, the progress page, the video position and its completions, and Complete and Undo.
//!
//! Settling certificates and programmes after a completion (`settleCertificatesNeeding`, `settleProgrammesHolding`) is
//! the certificate and programme slices' work: it is called here through [`Settle`], which those slices fill. Until
//! they do, it settles nothing (the TypeScript catches and logs every failure of both, so a completion's answer never
//! depends on them).

use std::collections::{BTreeMap, BTreeSet};

use super::sql::Pool;
use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::reads::{self, Grade};
use super::sql::{self, cell, exec, first, iso, ms, q};
use super::store::{Enrollment, Store};
use super::video;
use crate::curriculum::{gates, links, spine};
use crate::errors::{AcademyError, Refusal};
use crate::ports::Ports;

/// `academy.curriculum_not_found`, as the service words it.
pub fn curriculum_not_found() -> Refusal {
    AcademyError::new("Unknown curriculum item", "academy.curriculum_not_found").into()
}

/// The certificate and programme settling a completion or an Undo starts (`settleCertificatesNeeding`,
/// `settleProgrammesHolding`). Each failure is the settler's to log, never the completion's.
pub struct Settle {
    pub certificates_needing: fn(&Pool, &str, &str, i64),
    pub programmes_holding: fn(&Pool, &str, &str, i64),
}

fn settle_nothing(_: &Pool, _: &str, _: &str, _: i64) {}

impl Settle {
    /// Nothing settles yet: the certificate and programme slices own both.
    pub const NONE: Settle = Settle {
        certificates_needing: settle_nothing,
        programmes_holding: settle_nothing,
    };
}

/// What the service is built with that the learner calls read (`AcademyServiceOptions`).
pub struct Options<'a> {
    pub watch_threshold_seconds: Option<i64>,
    pub video_min_tier: &'a str,
    pub video_min_stake: &'a str,
    pub settle: &'a Settle,
}

/// A completion: `{ userId, itemSlug, completedAt }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    pub user_id: String,
    pub item_slug: String,
    pub completed_at: i64,
}

impl Completion {
    /// `itemCompletionOut`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("itemSlug", Json::str(self.item_slug.clone())),
            ("completedAt", Json::str(iso(self.completed_at))),
        ])
    }
}

/// `currentCompletion(sql, userId, slug)`.
pub fn current_completion(
    c: &mut impl GenericClient,
    user_id: &str,
    slug: &str,
) -> Result<Option<Completion>, Refusal> {
    first(
        c,
        &format!(
            "SELECT user_id::text, item_slug, {} FROM academy.cert_item_completions \
             WHERE user_id = $1::text::uuid AND item_slug = $2",
            ms("completed_at")
        ),
        &[&user_id, &slug],
    )?
    .map(|r| {
        Ok(Completion {
            user_id: cell(&r, 0)?,
            item_slug: cell(&r, 1)?,
            completed_at: cell(&r, 2)?,
        })
    })
    .transpose()
}

/// The free and paid tracks of a curriculum course (`TRACKS`): the certificate has no published price.
fn tracks() -> Json {
    Json::Array(vec![
        Json::obj([
            ("track", Json::str("audit")),
            ("free", Json::Bool(true)),
            ("closed", Json::Null),
        ]),
        Json::obj([
            ("track", Json::str("certificate")),
            ("free", Json::Bool(false)),
            ("closed", Json::str("no_price")),
        ]),
    ])
}

/// `assertTrackOpen(track)`.
pub fn assert_track_open(track: &str) -> Result<(), Refusal> {
    match track {
        "audit" => Ok(()),
        "certificate" => Err(AcademyError::new(
            "academy.enrolment_closed track=certificate reason=no_price",
            "academy.enrolment_closed",
        )
        .into()),
        other => Err(AcademyError::new(
            format!("academy.enrolment_closed track={other} reason=unpublished"),
            "academy.enrolment_closed",
        )
        .into()),
    }
}

/// `courseEnrolmentView(path, active, startsAt, terms, seatsTaken, now)`.
pub fn course_enrolment_view(
    path: &str,
    active: Option<&Enrollment>,
    starts_at: Option<i64>,
    terms: &reads::Terms,
    seats_taken: i64,
    now: i64,
) -> Json {
    Json::obj([
        ("slug", Json::str(path)),
        (
            "startsAt",
            starts_at.map_or(Json::Null, |s| Json::str(iso(s))),
        ),
        (
            "seatCap",
            terms
                .seat_cap
                .map_or(Json::Null, |c| Json::int(i64::from(c))),
        ),
        (
            "seatsRemaining",
            terms.seat_cap.map_or(Json::Null, |c| {
                Json::int((i64::from(c) - seats_taken).max(0))
            }),
        ),
        (
            "closed",
            reads::closed_reason(terms, seats_taken, now).map_or(Json::Null, Json::str),
        ),
        ("tracks", tracks()),
        (
            "enrolment",
            active.map_or(Json::Null, |a| {
                Json::obj([
                    ("track", Json::str("audit")),
                    ("enrolledAt", Json::str(iso(a.enrolled_at))),
                ])
            }),
        ),
        ("activationMail", Json::str("vendor.email")),
    ])
}

/// `myCourseView(path, enrolment, completed, lastItemSlug, open, startsAt, now)`.
pub fn my_course_view(
    path: &str,
    enrolment: &Enrollment,
    completed: &BTreeSet<String>,
    last_item_slug: Option<&str>,
    open: &[String],
    starts_at: Option<i64>,
    now: i64,
) -> Json {
    let items = spine::list(Some(path), None);
    let done = items.iter().filter(|i| completed.contains(&i.slug)).count();
    let starts_later = starts_at.is_some_and(|s| s > now);
    let first = open
        .first()
        .cloned()
        .or_else(|| items.first().map(|i| i.slug.clone()))
        .unwrap_or_default();
    let resume = last_item_slug
        .filter(|l| open.iter().any(|o| o == l))
        .map(str::to_owned)
        .or_else(|| open.iter().find(|s| !completed.contains(*s)).cloned())
        .unwrap_or_else(|| first.clone());
    let status = if done == items.len() {
        "completed"
    } else if starts_later {
        "future_start"
    } else {
        "in_progress"
    };
    let count = |n: usize| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
    Json::obj([
        ("slug", Json::str(path)),
        ("status", Json::str(status)),
        ("enrolledAt", Json::str(iso(enrolment.enrolled_at))),
        (
            "startsAt",
            starts_at.map_or(Json::Null, |s| Json::str(iso(s))),
        ),
        ("items", count(items.len())),
        ("completed", count(done)),
        ("firstItemSlug", Json::str(first)),
        (
            "resumeItemSlug",
            if done > 0 {
                Json::str(resume)
            } else {
                Json::Null
            },
        ),
    ])
}

/// `accessGrantView(enrolment)`.
pub fn access_grant_view(e: &Enrollment) -> Json {
    Json::obj([
        ("slug", Json::str(e.path_slug.clone())),
        ("source", Json::str("free")),
        ("grantedAt", Json::str(iso(e.enrolled_at))),
        ("expiresAt", Json::Null),
    ])
}

/// What runs in a completion's own transaction, only when that call recorded it.
pub type Alongside<'f> = dyn Fn(&mut postgres::Transaction<'_>) -> Result<(), Refusal> + 'f;

pub struct Learning<'a> {
    pub pool: &'a Pool,
    pub ports: &'a Ports,
    pub options: Options<'a>,
}

impl Learning<'_> {
    fn store(&self) -> Store<'_> {
        Store { pool: self.pool }
    }

    /// `courseEnrolment({ userId, slug, now })`.
    pub fn course_enrolment(&self, user_id: &str, slug: &str, now: i64) -> Result<Json, Refusal> {
        let path = links::published_course(slug)?;
        let enrolments = self.store().my_enrollments(user_id)?;
        let starts_at = sql::on_pool(self.pool, |c| reads::course_starts_at(c, path))?;
        let terms = sql::on_pool(self.pool, |c| reads::course_terms(c, path))?;
        let taken = self.store().seats_taken(path)?;
        let active = enrolments.iter().find(|e| e.path_slug == path);
        Ok(course_enrolment_view(
            path, active, starts_at, &terms, taken, now,
        ))
    }

    /// `enrolCourse({ userId, slug, track, now })`.
    pub fn enrol_course(
        &self,
        user_id: &str,
        slug: &str,
        track: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let path = links::published_course(slug)?;
        assert_track_open(track)?;
        self.enrol_within_terms(user_id, path, now)?;
        self.course_enrolment(user_id, path, now)
    }

    /// `enrolWithinTerms(userId, path, now)`: the cap's fullness is decided under its lock in the store.
    fn enrol_within_terms(
        &self,
        user_id: &str,
        path: &str,
        now: i64,
    ) -> Result<Enrollment, Refusal> {
        let terms = sql::on_pool(self.pool, |c| reads::course_terms(c, path))?;
        let mine = self.store().my_enrollments(user_id)?;
        if let Some(active) = mine.into_iter().find(|e| e.path_slug == path) {
            return Ok(active);
        }
        if let Some(closed) = reads::closed_reason(&terms, 0, now) {
            return Err(AcademyError::new(
                format!("academy.enrolment_closed track=audit reason={closed}"),
                "academy.enrolment_closed",
            )
            .into());
        }
        self.store()
            .enroll_cert_path(user_id, path, terms.seat_cap.map(i64::from))
    }

    /// `publicCourses()`: the catalogue's cards, without a course staff hid or unpublished.
    pub fn public_courses(&self) -> Result<Json, Refusal> {
        let unlisted = reads::unlisted(self.pool)?;
        Ok(Json::Array(
            links::public_courses()
                .into_iter()
                .filter(|(slug, _, _)| !unlisted.iter().any(|u| u == slug))
                .map(|(slug, items, minutes)| {
                    Json::obj([
                        ("slug", Json::str(slug)),
                        ("items", Json::int(i64::try_from(items).unwrap_or(i64::MAX))),
                        ("estimatedMinutes", Json::int(minutes)),
                    ])
                })
                .collect(),
        ))
    }

    /// `publicCourse(slug, now)`: the published quizzes first, then the page.
    pub fn public_course(&self, slug: &str, now: i64) -> Result<Json, Refusal> {
        let quizzes = reads::published_slugs(self.pool)?;
        links::public_course(
            slug,
            reads::certificate_title,
            |item| gates::opens_signed_out(self.pool.pool()?, item, now),
            &quizzes,
        )
    }

    /// `publishedEnrolments(userId)`: active enrolments in courses still published.
    fn published_enrolments(&self, user_id: &str) -> Result<Vec<Enrollment>, Refusal> {
        Ok(self
            .store()
            .my_enrollments(user_id)?
            .into_iter()
            .filter(|e| !spine::list(Some(&e.path_slug), None).is_empty())
            .collect())
    }

    /// `myAccessGrants(userId)`.
    pub fn my_access_grants(&self, user_id: &str) -> Result<Json, Refusal> {
        Ok(Json::Array(
            self.published_enrolments(user_id)?
                .iter()
                .map(access_grant_view)
                .collect(),
        ))
    }

    /// `completedSlugs(userId)`.
    fn completed_slugs(&self, user_id: &str) -> Result<BTreeSet<String>, Refusal> {
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT item_slug FROM academy.cert_item_completions WHERE user_id = $1::text::uuid",
                &[&user_id],
            )
        })?;
        Ok(sql::column::<String>(&rows)?.into_iter().collect())
    }

    /// `myLearning(userId, now)`.
    pub fn my_learning(&self, user_id: &str, now: i64) -> Result<Json, Refusal> {
        let enrolments = self.published_enrolments(user_id)?;
        if enrolments.is_empty() {
            return Ok(Json::Array(Vec::new()));
        }
        let completed = self.completed_slugs(user_id)?;
        let state = self.store().learning_state(user_id)?;
        let mut out = Vec::new();
        for row in &enrolments {
            let path = row.path_slug.as_str();
            let starts_at = sql::on_pool(self.pool, |c| reads::course_starts_at(c, path))?;
            let mut open = Vec::new();
            for item in spine::list(Some(path), None) {
                if gates::item_release(self.pool.pool()?, user_id, &item.slug, now, starts_at)?
                    .lock
                    .is_none()
                {
                    open.push(item.slug.clone());
                }
            }
            out.push(my_course_view(
                path,
                row,
                &completed,
                state.last_item_slug.as_deref(),
                &open,
                starts_at,
                now,
            ));
        }
        Ok(Json::Array(out))
    }

    /// `completionTimes(userId, slugs)`.
    fn completion_times(
        &self,
        user_id: &str,
        slugs: &[String],
    ) -> Result<BTreeMap<String, i64>, Refusal> {
        if slugs.is_empty() {
            return Ok(BTreeMap::new());
        }
        let rows = sql::on_pool(self.pool, |c| {
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
        rows.iter()
            .map(|r| Ok((cell(r, 0)?, cell(r, 1)?)))
            .collect()
    }

    /// `progressPage(userId, now)`.
    pub fn progress_page(&self, user_id: &str, now: i64) -> Result<Json, Refusal> {
        let enrolments = self.published_enrolments(user_id)?;
        let all_grades = reads::grades(self.pool, user_id, now)?;
        let course_grades = reads::course_grades(self.pool, user_id)?;
        let grades: Vec<Grade> = all_grades
            .into_iter()
            .filter(|g| spine::get(g.slug()).is_some())
            .collect();
        let paths: Vec<&str> = enrolments.iter().map(|e| e.path_slug.as_str()).collect();
        let slugs: Vec<String> = paths
            .iter()
            .flat_map(|p| {
                spine::list(Some(p), None)
                    .into_iter()
                    .map(|i| i.slug.clone())
            })
            .collect();
        let times = self.completion_times(user_id, &slugs)?;
        let count = |n: usize| i64::try_from(n).unwrap_or(i64::MAX);
        let courses = paths
            .iter()
            .map(|path| {
                let items = spine::list(Some(path), None);
                let completed = items.iter().filter(|i| times.contains_key(&i.slug)).count();
                Json::obj([
                    ("slug", Json::str(*path)),
                    ("visible", Json::int(count(items.len()))),
                    ("completed", Json::int(count(completed))),
                    (
                        "percent",
                        Json::str(reads::tenths(count(completed), count(items.len()))),
                    ),
                    (
                        "items",
                        Json::Array(
                            items
                                .iter()
                                .map(|i| {
                                    Json::obj([
                                        ("slug", Json::str(i.slug.clone())),
                                        ("title", Json::str(i.title.clone())),
                                        ("kind", Json::str(i.kind.clone())),
                                        (
                                            "completedAt",
                                            times
                                                .get(&i.slug)
                                                .map_or(Json::Null, |t| Json::str(iso(*t))),
                                        ),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect();
        let title = |slug: &str| spine::get(slug).map_or(String::new(), |i| i.title.clone());
        let rows = grades
            .iter()
            .map(|g| match g {
                Grade::Pending {
                    slug,
                    attempts,
                    hidden_until,
                } => Json::obj([
                    ("pending", Json::Bool(true)),
                    ("slug", Json::str(slug.clone())),
                    ("title", Json::str(title(slug))),
                    ("type", Json::str("quiz")),
                    ("attempts", Json::int(i64::from(*attempts))),
                    ("hiddenUntil", Json::str(iso(*hidden_until))),
                ]),
                Grade::Released {
                    slug,
                    attempts,
                    score,
                    possible,
                    passed,
                } => Json::obj([
                    ("pending", Json::Bool(false)),
                    ("slug", Json::str(slug.clone())),
                    ("title", Json::str(title(slug))),
                    ("type", Json::str("quiz")),
                    ("attempts", Json::int(i64::from(*attempts))),
                    ("score", Json::str(score.to_string())),
                    ("possible", Json::str(possible.to_string())),
                    (
                        "percent",
                        Json::str(reads::tenths(i64::from(*score), i64::from(*possible))),
                    ),
                    ("passed", Json::Bool(*passed)),
                ]),
            })
            .collect();
        let released: Vec<(i64, i64)> = grades
            .iter()
            .filter_map(|g| match g {
                Grade::Released {
                    score, possible, ..
                } => Some((i64::from(*score), i64::from(*possible))),
                Grade::Pending { .. } => None,
            })
            .collect();
        let averages = if released.is_empty() {
            Vec::new()
        } else {
            vec![Json::obj([
                ("type", Json::str("quiz")),
                (
                    "percent",
                    Json::str(reads::tenths(
                        released.iter().map(|r| r.0).sum(),
                        released.iter().map(|r| r.1).sum(),
                    )),
                ),
                ("count", Json::int(count(released.len()))),
            ])]
        };
        Ok(Json::obj([
            ("courses", Json::Array(courses)),
            (
                "grades",
                Json::obj([
                    ("rows", Json::Array(rows)),
                    ("averages", Json::Array(averages)),
                ]),
            ),
            ("courseGrades", course_grades),
        ]))
    }

    /// The playback gate (`assertAcademyVideoEntitled`) for the caller.
    fn assert_may_watch(&self, user_id: &str, tier: &str) -> Result<(), Refusal> {
        video::assert_entitled(
            self.ports,
            self.options.video_min_tier,
            self.options.video_min_stake,
            user_id,
            tier,
        )
    }

    /// `mayWatch(check)`: a typed refusal means no; anything else is a failure.
    fn may_watch(&self, user_id: &str, tier: &str) -> Result<bool, Refusal> {
        match self.assert_may_watch(user_id, tier) {
            Ok(()) => Ok(true),
            Err(Refusal::Academy(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// `watchedItems(userId, videos)`: the items whose video's stored position reached the owner's threshold.
    fn watched_items(
        &self,
        user_id: &str,
        videos: &[(String, String)],
    ) -> Result<BTreeSet<String>, Refusal> {
        let Some(threshold) = self.options.watch_threshold_seconds else {
            return Ok(BTreeSet::new());
        };
        if videos.is_empty() {
            return Ok(BTreeSet::new());
        }
        let mut distinct: Vec<String> = Vec::new();
        for (_, v) in videos {
            if !distinct.contains(v) {
                distinct.push(v.clone());
            }
        }
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT video_slug FROM academy.video_progress \
                 WHERE user_id = $1::text::uuid AND video_slug = ANY($2) AND position_seconds >= $3",
                &[&user_id, &distinct, &threshold],
            )
        })?;
        let seen: Vec<String> = sql::column(&rows)?;
        Ok(videos
            .iter()
            .filter(|(_, v)| seen.contains(v))
            .map(|(i, _)| i.clone())
            .collect())
    }

    /// `setVideoProgress`: the position stored first; a save that crosses the threshold completes the attached watch
    /// items the caller may open and watch.
    pub fn set_video_progress(
        &self,
        user_id: &str,
        tier: &str,
        video_slug: &str,
        position_seconds: f64,
        client_request_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let saved = self.store().set_video_progress(
            user_id,
            video_slug,
            position_seconds,
            client_request_id,
            now,
        )?;
        let stored = |completed: Vec<String>| {
            Json::obj([
                ("videoSlug", Json::str(saved.video_slug.clone())),
                (
                    "positionSeconds",
                    saved.position_seconds.map_or(Json::Null, Json::int),
                ),
                (
                    "completedItems",
                    Json::Array(completed.into_iter().map(Json::String).collect()),
                ),
            ])
        };
        let Some(threshold) = self.options.watch_threshold_seconds else {
            return Ok(stored(Vec::new()));
        };
        if saved.position_seconds.is_none_or(|p| p < threshold) {
            return Ok(stored(Vec::new()));
        }
        let attached = video::items_with_video(self.pool, &saved.video_slug)?;
        let quizzes = if attached.is_empty() {
            BTreeSet::new()
        } else {
            reads::published_slugs(self.pool)?
        };
        let items: Vec<String> = attached
            .into_iter()
            .filter(|s| !quizzes.contains(s) && spine::has(s))
            .collect();
        let crossed = !saved.replayed && saved.previous_seconds.is_none_or(|p| p < threshold);
        if crossed && !items.is_empty() && self.may_watch(user_id, tier)? {
            for slug in &items {
                if sql::on_pool(self.pool, |c| current_completion(c, user_id, slug))?.is_some() {
                    continue;
                }
                match gates::assert_may_read(self.pool.pool()?, user_id, slug, now) {
                    Ok(()) => {}
                    // Still locked: the stored position meets the rule, so Complete finishes it once it opens.
                    Err(Refusal::Academy(_)) => continue,
                    Err(e) => return Err(e),
                }
                self.record_completion(user_id, slug, now, None)?;
                (self.options.settle.programmes_holding)(self.pool, user_id, slug, now);
            }
        }
        let mut completed = Vec::new();
        for slug in &items {
            if sql::on_pool(self.pool, |c| current_completion(c, user_id, slug))?.is_some() {
                completed.push(slug.clone());
            }
        }
        Ok(stored(completed))
    }

    /// `markCurriculumComplete`: an existing completion answers; else the lock, the item's rule, then one record.
    pub fn mark_complete(
        &self,
        user_id: &str,
        tier: &str,
        item_slug: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let slug = js_trim(item_slug);
        if !spine::has(slug) {
            return Err(curriculum_not_found());
        }
        if let Some(existing) = sql::on_pool(self.pool, |c| current_completion(c, user_id, slug))? {
            return Ok(existing.json());
        }
        gates::assert_may_read(self.pool.pool()?, user_id, slug, now)?;
        let quiz = reads::quiz_pass_mark(self.pool, slug)?;
        if quiz == Some(None) {
            return Err(AcademyError::new(
                format!("academy.pass_mark_unset slug={slug}"),
                "academy.pass_mark_unset",
            )
            .into());
        }
        let video = if quiz.is_some() {
            None
        } else {
            video::item_video(self.pool, slug)?
        };
        let rule = if quiz.is_some() {
            "score"
        } else if video.is_some() {
            "watch"
        } else {
            "view"
        };
        if rule == "watch" && self.options.watch_threshold_seconds.is_none() {
            return Err(AcademyError::new(
                "academy.watch_threshold_unset",
                "academy.watch_threshold_unset",
            )
            .into());
        }
        if rule == "watch" {
            self.assert_may_watch(user_id, tier)?;
        }
        let met = match (rule, &video) {
            ("view", _) => true,
            ("score", _) => reads::passed_slugs(self.pool, user_id, now)?.contains(slug),
            (_, Some(v)) => self
                .watched_items(user_id, &[(slug.to_owned(), v.clone())])?
                .contains(slug),
            _ => false,
        };
        if !met {
            return Err(AcademyError::new(
                format!("academy.completion_rule_unmet rule={rule}"),
                "academy.completion_rule_unmet",
            )
            .into());
        }
        let (record, _) = self.record_completion(user_id, slug, now, None)?;
        (self.options.settle.certificates_needing)(self.pool, user_id, slug, now);
        (self.options.settle.programmes_holding)(self.pool, user_id, slug, now);
        Ok(record.json())
    }

    /// `recordCompletion(userId, slug, now, alongside)`: the completion and its history row, under the item's lock; a
    /// concurrent completion answers that one. `alongside` runs in the same transaction only when this call recorded.
    pub fn record_completion(
        &self,
        user_id: &str,
        slug: &str,
        now: i64,
        alongside: Option<&Alongside<'_>>,
    ) -> Result<(Completion, bool), Refusal> {
        let at = iso(now);
        let lock = format!("{user_id}:{slug}:completion");
        sql::serializable(self.pool, |tx| {
            exec(
                tx,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&lock],
            )?;
            let row = first(
                tx,
                &format!(
                    "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) \
                     VALUES ($1::text::uuid, $2, $3::text::timestamptz) \
                     ON CONFLICT (user_id, item_slug) DO NOTHING RETURNING user_id::text, item_slug, {}",
                    ms("completed_at")
                ),
                &[&user_id, &slug, &at],
            )?;
            let Some(row) = row else {
                return current_completion(tx, user_id, slug)?
                    .map(|c| (c, false))
                    .ok_or_else(|| Refusal::db("the completion was not found", None));
            };
            exec(
                tx,
                "INSERT INTO academy.item_completion_events (user_id, item_slug, event, client_request_id, recorded_at) \
                 VALUES ($1::text::uuid, $2, 'completed', NULL, $3::text::timestamptz)",
                &[&user_id, &slug, &at],
            )?;
            if let Some(f) = alongside {
                f(tx)?;
            }
            Ok((
                Completion {
                    user_id: cell(&row, 0)?,
                    item_slug: cell(&row, 1)?,
                    completed_at: cell(&row, 2)?,
                },
                true,
            ))
        })
    }

    /// `undoCurriculumComplete`: named by its `completedAt`; a replay of the request answers as the first did.
    pub fn undo_complete(
        &self,
        user_id: &str,
        item_slug: &str,
        completed_at: &str,
        client_request_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let slug = js_trim(item_slug).to_owned();
        if !spine::has(&slug) {
            return Err(curriculum_not_found());
        }
        let request = js_trim(client_request_id).to_owned();
        // `new Date(input.completedAt)` as a parameter.
        let completed = service_kit::time::js_date(completed_at)
            .map_or_else(|| completed_at.to_owned(), |t| t.iso());
        let at = iso(now);
        let answer = |undone: Json| {
            Json::obj([
                ("userId", Json::str(user_id)),
                ("itemSlug", Json::str(slug.clone())),
                ("undoneAt", undone),
            ])
        };
        let request_lock = format!("{user_id}:{request}:undo-request");
        let item_lock = format!("{user_id}:{slug}:completion");
        let undone = sql::serializable(self.pool, |tx| {
            exec(
                tx,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&request_lock],
            )?;
            exec(
                tx,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&item_lock],
            )?;
            let replay = first(
                tx,
                &format!(
                    "SELECT item_slug, {} FROM academy.item_completion_events \
                     WHERE user_id = $1::text::uuid AND client_request_id = $2",
                    ms("recorded_at")
                ),
                &[&user_id, &request],
            )?;
            if let Some(r) = replay {
                let replayed: String = cell(&r, 0)?;
                if replayed != slug {
                    return Err(AcademyError::new(
                        "academy.request_reused this request id undid another item",
                        "academy.request_reused",
                    )
                    .into());
                }
                return Ok(Some(iso(cell(&r, 1)?)));
            }
            let removed = first(
                tx,
                "DELETE FROM academy.cert_item_completions \
                 WHERE user_id = $1::text::uuid AND item_slug = $2 \
                   AND date_trunc('milliseconds', completed_at) = $3::text::timestamptz RETURNING item_slug",
                &[&user_id, &slug, &completed],
            )?;
            if removed.is_none() {
                return Ok(None);
            }
            exec(
                tx,
                "INSERT INTO academy.item_completion_events (user_id, item_slug, event, client_request_id, recorded_at) \
                 VALUES ($1::text::uuid, $2, 'undone', $3, $4::text::timestamptz)",
                &[&user_id, &slug, &request, &at],
            )?;
            Ok(Some(at.clone()))
        })?;
        // A delayed certificate waiting on this item stops waiting (a replay settles again, as the TypeScript does).
        if undone.is_some() {
            (self.options.settle.certificates_needing)(self.pool, user_id, &slug, now);
        }
        Ok(answer(undone.map_or(Json::Null, Json::String)))
    }
}

/// `requireReason(reason)` (`learners/learner-desk.ts`).
pub fn require_reason(reason: &str) -> Result<String, Refusal> {
    let trimmed = js_trim(reason);
    if trimmed.is_empty() {
        return Err(AcademyError::new(
            "academy.reason_required a reason is required",
            "academy.reason_required",
        )
        .into());
    }
    Ok(trimmed.to_owned())
}

/// The learner desk's stored key of an item staff marked complete (`LearnerDesk.markKey`).
pub fn mark_key(user_id: &str, item_slug: &str, key: &str) -> String {
    format!("mark:{user_id}:{item_slug}:{key}")
}

impl Learning<'_> {
    /// `staffMarkComplete`: staff record an item complete for a learner, keyed by the console's request.
    pub fn staff_mark_complete(
        &self,
        user_id: &str,
        item_slug: &str,
        reason: &str,
        key: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let slug = js_trim(item_slug).to_owned();
        let reason = require_reason(reason)?;
        if !spine::has(&slug) {
            return Err(curriculum_not_found());
        }
        let done =
            |what: &str| Json::obj([("userId", Json::str(user_id)), ("done", Json::str(what))]);
        let stored_key = mark_key(user_id, &slug, key);
        let recorded = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT 1 FROM academy.learner_events \
                 WHERE key = $1 AND user_id = $2::text::uuid AND kind = 'marked_complete'",
                &[&stored_key, &user_id],
            )
        })?;
        if recorded.is_some() {
            return Ok(done("already recorded"));
        }
        let title = spine::get(&slug).map_or_else(|| slug.clone(), |i| i.title.clone());
        let detail = format!("{title} marked complete for the learner");
        let at = iso(now);
        let event = |tx: &mut postgres::Transaction<'_>| -> Result<(), Refusal> {
            exec(
                tx,
                "INSERT INTO academy.learner_events (user_id, kind, key, item_slug, detail, reason, actor_id, at) \
                 VALUES ($1::text::uuid, 'marked_complete', $2, $3, $4, $5, $6::text::uuid, $7::text::timestamptz) \
                 ON CONFLICT (key) DO NOTHING",
                &[
                    &user_id,
                    &stored_key,
                    &slug,
                    &detail,
                    &reason,
                    &operator_id,
                    &at,
                ],
            )?;
            Ok(())
        };
        let (_, recorded) = self.record_completion(user_id, &slug, now, Some(&event))?;
        if !recorded {
            return Ok(done("the item was already complete"));
        }
        (self.options.settle.certificates_needing)(self.pool, user_id, &slug, now);
        (self.options.settle.programmes_holding)(self.pool, user_id, &slug, now);
        Ok(done("marked complete for the learner"))
    }
}
