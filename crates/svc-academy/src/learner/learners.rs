//! AC-catalogue-03 and AC-enrolment-01: the courses staff made, on the learner side: the public catalogue, a course's
//! public page and enrolling in it (`curriculum/course-learners.ts`).
//!
//! A published course is listed and its page is public; anything else is `academy.course_not_found`. Enrolling on the
//! free audit track is keyed by the one open enrolment a learner may hold; a repeat answers with it. The paid
//! certificate track is open only on a priced course while course payments are set up, and needs the learner's recorded
//! purchase (`academy.payment_required`). No money moves here.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::pg::Pool;

use super::preview::CoursePreview;
use super::purchases::{CoursePurchases, canonical_price, holds_purchase};
use super::sql::{self, cell, exec, first, iso, ms, q};
use crate::errors::{AcademyError, Refusal};

struct CourseRow {
    id: String,
    slug: String,
    state: String,
    pricing: String,
    price: Option<String>,
    price_asset: Option<String>,
}

const COURSE_COLUMNS: &str = "id::text, slug, state, pricing, price::text, price_asset";

fn course_of(r: &Row) -> Result<CourseRow, Refusal> {
    Ok(CourseRow {
        id: cell(r, 0)?,
        slug: cell(r, 1)?,
        state: cell(r, 2)?,
        pricing: cell(r, 3)?,
        price: cell(r, 4)?,
        price_asset: cell(r, 5)?,
    })
}

fn not_found(slug: &str) -> Refusal {
    AcademyError::new(
        format!("no published course has the address \"{slug}\""),
        "academy.course_not_found",
    )
    .into()
}

/// One track: its name, whether it is free, and why it is closed.
struct Track {
    track: &'static str,
    free: bool,
    closed: Option<&'static str>,
}

pub struct CourseLearners<'a> {
    pub pool: &'a Pool,
    pub preview: CoursePreview<'a>,
    pub purchases: &'a CoursePurchases<'a>,
}

impl CourseLearners<'_> {
    /// The published courses, most recently published first, up to `limit`.
    pub fn published(&self, limit: i64) -> Result<Json, Refusal> {
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                "SELECT c.slug, c.title, c.summary, c.thumbnail_url, c.pricing, c.price::text, c.price_asset, \
                   (SELECT count(*)::int FROM academy.course_items i \
                     WHERE i.course_id = c.id AND (i.kind = 'link' \
                       OR (i.kind = 'assignment' AND EXISTS (SELECT 1 FROM academy.course_assignments a WHERE a.item_id = i.id)) \
                       OR (i.kind NOT IN ('subheader', 'assignment') AND i.live_revision IS NOT NULL))) AS items \
                 FROM academy.courses c \
                 WHERE c.state = 'published' \
                 ORDER BY (SELECT max(e.at) FROM academy.course_events e \
                     WHERE e.course_id = c.id AND e.kind = 'state' AND e.to_state = 'published') DESC NULLS LAST, c.id \
                 LIMIT $1",
                &[&limit],
            )
        })?;
        let cards = rows
            .iter()
            .map(|r| {
                let opt = |i: usize| -> Result<Json, Refusal> {
                    Ok(cell::<Option<String>>(r, i)?.map_or(Json::Null, Json::String))
                };
                let price: Option<String> = cell(r, 5)?;
                Ok(Json::obj([
                    ("slug", Json::String(cell(r, 0)?)),
                    ("title", Json::String(cell(r, 1)?)),
                    ("summary", opt(2)?),
                    ("thumbnailUrl", opt(3)?),
                    ("pricing", Json::String(cell(r, 4)?)),
                    ("price", price.map_or(Json::Null, |p| Json::str(canonical_price(&p)))),
                    ("priceAsset", opt(6)?),
                    ("items", Json::int(i64::from(cell::<i32>(r, 7)?))),
                ]))
            })
            .collect::<Result<_, Refusal>>()?;
        Ok(Json::Array(cards))
    }

    /// A published course's page; signed in, the reader's own enrolment opens what is released.
    pub fn page(&self, slug: &str, reader_id: Option<&str>, now: i64) -> Result<Json, Refusal> {
        let course = self.published_row(slug)?;
        let view = self.preview.view(&course.id, reader_id, now)?;
        match view {
            Some(v) if matches!(v.get("state"), Some(Json::String(s)) if s == "published") => Ok(v),
            _ => Err(not_found(slug)),
        }
    }

    /// The terms of enrolling and the caller's own open enrolment.
    pub fn terms(&self, user_id: &str, slug: &str) -> Result<Json, Refusal> {
        let course = self.published_row(slug)?;
        let open = sql::on_pool(self.pool, |c| open(c, &course.id, user_id))?;
        Ok(self.terms_of(&course, open))
    }

    /// Enrol on an open track. A repeat while enrolled answers with the same enrolment.
    pub fn enrol(&self, user_id: &str, slug: &str, track: &str, now: i64) -> Result<Json, Refusal> {
        sql::begin(self.pool, |tx| {
            let course = first(
                tx,
                &format!("SELECT {COURSE_COLUMNS} FROM academy.courses WHERE slug = $1 FOR SHARE"),
                &[&slug],
            )?
            .as_ref()
            .map(course_of)
            .transpose()?;
            let Some(course) = course.filter(|c| c.state == "published") else {
                return Err(not_found(slug));
            };
            let tracks = self.tracks(&course);
            let row = tracks.iter().find(|t| t.track == track);
            match row {
                Some(t) if t.closed.is_none() => {}
                _ => {
                    let reason = row.and_then(|t| t.closed).unwrap_or("unpublished");
                    return Err(AcademyError::new(
                        format!("academy.enrolment_closed track={track} reason={reason}"),
                        "academy.enrolment_closed",
                    )
                    .into());
                }
            }
            if row.is_some_and(|t| !t.free) && !holds_purchase(tx, &course.id, user_id)? {
                return Err(AcademyError::new(
                    format!(
                        "academy.payment_required the {track} track of \"{}\" needs a purchase first",
                        course.slug
                    ),
                    "academy.payment_required",
                )
                .into());
            }
            let at = iso(now);
            exec(
                tx,
                "INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::timestamptz) \
                 ON CONFLICT (course_id, user_id) WHERE left_at IS NULL DO NOTHING",
                &[&course.id, &user_id, &track, &at],
            )?;
            let open = open(tx, &course.id, user_id)?;
            Ok(self.terms_of(&course, open))
        })
    }

    /// Leave the enrolment that began at `enrolled_at` (its business key); a repeat answers with the terms as they stand.
    pub fn leave(&self, user_id: &str, slug: &str, enrolled_at: &str, now: i64) -> Result<Json, Refusal> {
        sql::begin(self.pool, |tx| {
            let course = first(
                tx,
                &format!("SELECT {COURSE_COLUMNS} FROM academy.courses WHERE slug = $1"),
                &[&slug],
            )?
            .as_ref()
            .map(course_of)
            .transpose()?
            .ok_or_else(|| not_found(slug))?;
            let at = iso(now);
            exec(
                tx,
                "UPDATE academy.course_enrolments SET left_at = $1::text::timestamptz \
                 WHERE course_id = $2::text::uuid AND user_id = $3::text::uuid AND left_at IS NULL \
                   AND date_trunc('milliseconds', enrolled_at) = date_trunc('milliseconds', $4::text::timestamptz)",
                &[&at, &course.id, &user_id, &enrolled_at],
            )?;
            let open = open(tx, &course.id, user_id)?;
            Ok(self.terms_of(&course, open))
        })
    }

    fn published_row(&self, slug: &str) -> Result<CourseRow, Refusal> {
        let course = sql::on_pool(self.pool, |c| {
            first(c, &format!("SELECT {COURSE_COLUMNS} FROM academy.courses WHERE slug = $1"), &[&slug])
        })?
        .as_ref()
        .map(course_of)
        .transpose()?;
        course.filter(|c| c.state == "published").ok_or_else(|| not_found(slug))
    }

    fn tracks(&self, course: &CourseRow) -> Vec<Track> {
        let audit = Track { track: "audit", free: true, closed: None };
        let certificate = |closed| Track { track: "certificate", free: false, closed };
        if course.pricing == "free" {
            return vec![audit];
        }
        if course.price.is_none() {
            return vec![audit, certificate(Some("no_price"))];
        }
        if !self
            .purchases
            .sells(&course.pricing, course.price.as_deref(), course.price_asset.as_deref())
        {
            return vec![audit, certificate(Some("payments_off"))];
        }
        vec![audit, certificate(None)]
    }

    fn terms_of(&self, course: &CourseRow, enrolment: Option<(String, i64)>) -> Json {
        let tracks = self
            .tracks(course)
            .into_iter()
            .map(|t| {
                Json::obj([
                    ("track", Json::str(t.track)),
                    ("free", Json::Bool(t.free)),
                    ("closed", t.closed.map_or(Json::Null, Json::str)),
                ])
            })
            .collect();
        Json::obj([
            ("slug", Json::str(course.slug.clone())),
            ("startsAt", Json::Null),
            ("seatCap", Json::Null),
            ("seatsRemaining", Json::Null),
            ("closed", if course.state == "published" { Json::Null } else { Json::str("unpublished") }),
            ("tracks", Json::Array(tracks)),
            (
                "enrolment",
                enrolment.map_or(Json::Null, |(track, at)| {
                    Json::obj([("track", Json::String(track)), ("enrolledAt", Json::str(iso(at)))])
                }),
            ),
            ("activationMail", Json::str("vendor.email")),
        ])
    }
}

/// The caller's open enrolment: its track and start.
fn open(c: &mut impl GenericClient, course_id: &str, user_id: &str) -> Result<Option<(String, i64)>, Refusal> {
    first(
        c,
        &format!(
            "SELECT track, {} FROM academy.course_enrolments \
             WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND left_at IS NULL",
            ms("enrolled_at")
        ),
        &[&course_id, &user_id],
    )?
    .map(|r| Ok((cell(&r, 0)?, cell(&r, 1)?)))
    .transpose()
}
