//! The learner's path enrolments and completions the certificate calls read and write (`learning/customer-store.ts`
//! `myCompletions`, `activePathSlugs`, `enrollCertPath`, `myEnrollments`, `leaveCertPath`; `academy-service.ts`
//! `enrollCertPath` and `enrolWithinTerms`; `curriculum/course-terms.ts` `read` and `courseClosedReason`). A path is
//! also a course: Programmes enrol through the same cap, window and visibility as the course page. No money moves here.

use postgres::{GenericClient, IsolationLevel};

use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::v8_date_parse;

use super::service::{Certs, sql_list_limit};
use super::sql::{self, cell, iso, lock, ms, q};
use crate::curriculum::{links, spine};
use crate::db;
use crate::errors::{AcademyError, Refusal};

fn academy(message: impl Into<String>, code: &str) -> Refusal {
    AcademyError::new(message, code).into()
}

/// `EnrollmentRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enrolment {
    pub user_id: String,
    pub path_slug: String,
    pub enrolled_at: i64,
    pub left_at: Option<i64>,
}

impl Enrolment {
    /// `enrollmentOut`: `{ userId, pathSlug, enrolledAt }`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("pathSlug", Json::str(self.path_slug.clone())),
            ("enrolledAt", Json::str(iso(self.enrolled_at))),
        ])
    }
}

fn enrolment_columns() -> String {
    format!(
        "user_id::text, path_slug, {}, {}",
        ms("enrolled_at"),
        ms("left_at")
    )
}

fn enrolment_of(r: &postgres::Row) -> Result<Enrolment, Refusal> {
    Ok(Enrolment {
        user_id: cell(r, 0)?,
        path_slug: cell(r, 1)?,
        enrolled_at: cell(r, 2)?,
        left_at: cell(r, 3)?,
    })
}

fn first(rows: &[postgres::Row]) -> Result<Enrolment, Refusal> {
    rows.first().map(enrolment_of).transpose()?.ok_or_else(|| {
        Refusal::db(
            "Cannot read properties of undefined (reading 'user_id')",
            None,
        )
    })
}

/// `CourseTerms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub seat_cap: Option<i64>,
    pub opens_at: Option<i64>,
    pub closes_at: Option<i64>,
    pub visibility: String,
}

/// `courseClosedReason(terms, seatsTaken, now)`.
pub fn course_closed_reason(t: &Terms, seats_taken: i64, now: i64) -> Option<&'static str> {
    match t.visibility.as_str() {
        "unpublished" => return Some("unpublished"),
        "hidden" => return Some("hidden"),
        _ => {}
    }
    if t.opens_at.is_some_and(|o| now < o) {
        return Some("window_not_started");
    }
    if t.closes_at.is_some_and(|c| now >= c) {
        return Some("window_ended");
    }
    if t.seat_cap.is_some_and(|cap| seats_taken >= cap) {
        return Some("full");
    }
    None
}

/// `CourseTermsStore.read(path)`: the stored terms, or open terms when none are stored.
pub fn course_terms<C: GenericClient>(c: &mut C, path: &str) -> Result<Terms, Refusal> {
    let rows = q(
        c,
        &format!(
            "SELECT seat_cap, {}, {}, visibility FROM academy.course_enrolment_terms WHERE path = $1",
            ms("opens_at"),
            ms("closes_at")
        ),
        &[&path],
    )?;
    Ok(match rows.first() {
        Some(r) => Terms {
            seat_cap: cell::<Option<i32>>(r, 0)?.map(sql::int),
            opens_at: cell(r, 1)?,
            closes_at: cell(r, 2)?,
            visibility: cell(r, 3)?,
        },
        None => Terms {
            seat_cap: None,
            opens_at: None,
            closes_at: None,
            visibility: "published".to_owned(),
        },
    })
}

/// `myEnrollments(userId)`: active enrolments, oldest first.
pub fn my_enrolments<C: GenericClient>(
    c: &mut C,
    user_id: &str,
) -> Result<Vec<Enrolment>, Refusal> {
    q(
        c,
        &format!(
            "SELECT {} FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL \
             ORDER BY enrolled_at ASC, path_slug ASC",
            enrolment_columns()
        ),
        &[&user_id],
    )?
    .iter()
    .map(enrolment_of)
    .collect()
}

fn path_of(path_slug: &str) -> Result<String, Refusal> {
    let path = js_trim(path_slug).to_lowercase();
    if !spine::PATHS.contains(&path.as_str()) {
        return Err(academy(
            "pathSlug must be one of foundations | markets | builder | sovereign",
            "academy.cert_invalid",
        ));
    }
    Ok(path)
}

/// `AcademyCustomerStore.enrollCertPath`: the programme's prerequisites (none in today's catalogue, still read), then
/// the insert; under a seat cap the count and the insert hold one lock per course.
fn store_enrol(
    certs: &Certs<'_>,
    user_id: &str,
    path_slug: &str,
    seat_cap: Option<i64>,
) -> Result<Enrolment, Refusal> {
    let path = path_of(path_slug)?;
    // `PROGRAMME_CATALOG`: every path, no prerequisites; `activePathSlugs` is still read.
    db::with_client(certs.store.pool()?, |c| {
        q(
            c,
            "SELECT path_slug FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL",
            &[&user_id],
        )
    })?;
    let Some(cap) = seat_cap else {
        return db::with_client(certs.store.pool()?, |c| {
            first(&q(
                c,
                &format!(
                    "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) \
                     VALUES ($1::text::uuid, $2, now()) \
                     ON CONFLICT (user_id, path_slug) WHERE left_at IS NULL \
                     DO UPDATE SET path_slug = EXCLUDED.path_slug \
                     RETURNING {}",
                    enrolment_columns()
                ),
                &[&user_id, &path],
            )?)
        });
    };
    db::transaction_retrying(certs.store.pool()?, IsolationLevel::Serializable, |tx| {
        lock(tx, &format!("academy.course_seats:{path}"))?;
        let mine = q(
            tx,
            &format!(
                "SELECT {} FROM academy.cert_enrollments \
                 WHERE user_id = $1::text::uuid AND path_slug = $2 AND left_at IS NULL",
                enrolment_columns()
            ),
            &[&user_id, &path],
        )?;
        if let Some(r) = mine.first() {
            return enrolment_of(r);
        }
        let taken: i32 = q(
            tx,
            "SELECT count(*)::int AS n FROM academy.cert_enrollments WHERE path_slug = $1 AND left_at IS NULL",
            &[&path],
        )?
        .first()
        .map_or(Ok(0), |r| cell(r, 0))?;
        if sql::int(taken) >= cap {
            return Err(academy(
                "academy.enrolment_closed track=audit reason=full",
                "academy.enrolment_closed",
            ));
        }
        first(&q(
            tx,
            &format!(
                "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) \
                 VALUES ($1::text::uuid, $2, now()) RETURNING {}",
                enrolment_columns()
            ),
            &[&user_id, &path],
        )?)
    })
}

/// `AcademyService.enrollCertPath`: an unpublished certificate's path refuses; a path is enrolled as its course, under
/// its terms.
pub fn enroll_cert_path(
    certs: &Certs<'_>,
    user_id: &str,
    path_slug: &str,
    now: i64,
) -> Result<Enrolment, Refusal> {
    certs.refuse_unpublished_path(path_slug)?;
    let path = js_trim(path_slug).to_lowercase();
    if !spine::PATHS.contains(&path.as_str()) {
        return store_enrol(certs, user_id, path_slug, None);
    }
    let course = links::published_course(&path)?;
    // `enrolWithinTerms`: the terms and the caller's enrolments (read together), the active one answered.
    let terms = db::with_client(certs.store.pool()?, |c| course_terms(c, course))?;
    let mine = db::with_client(certs.store.pool()?, |c| my_enrolments(c, user_id))?;
    if let Some(active) = mine.into_iter().find(|r| r.path_slug == course) {
        return Ok(active);
    }
    if let Some(closed) = course_closed_reason(&terms, 0, now) {
        return Err(academy(
            format!("academy.enrolment_closed track=audit reason={closed}"),
            "academy.enrolment_closed",
        ));
    }
    store_enrol(certs, user_id, course, terms.seat_cap)
}

/// `leaveCertPath`: leaves the active enrolment once per client request; a repeat answers the same leave.
pub fn leave_cert_path(
    certs: &Certs<'_>,
    user_id: &str,
    path_slug: &str,
    client_request_id: &str,
) -> Result<Enrolment, Refusal> {
    let path = path_of(path_slug)?;
    let request = js_trim(client_request_id);
    if request.is_empty() {
        return Err(academy(
            "clientRequestId is required",
            "academy.cert_invalid",
        ));
    }
    db::transaction_retrying(certs.store.pool()?, IsolationLevel::Serializable, |tx| {
        let replay = q(
            tx,
            &format!(
                "SELECT {} FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND leave_request_id = $2",
                enrolment_columns()
            ),
            &[&user_id, &request],
        )?;
        if let Some(r) = replay.first() {
            return enrolment_of(r);
        }
        let active = q(
            tx,
            &format!(
                "SELECT id::text, {} FROM academy.cert_enrollments \
                 WHERE user_id = $1::text::uuid AND path_slug = $2 AND left_at IS NULL FOR UPDATE",
                enrolment_columns()
            ),
            &[&user_id, &path],
        )?;
        let Some(active) = active.first() else {
            let prior = q(
                tx,
                &format!(
                    "SELECT {} FROM academy.cert_enrollments \
                     WHERE user_id = $1::text::uuid AND path_slug = $2 AND left_at IS NOT NULL \
                     ORDER BY left_at DESC LIMIT 1",
                    enrolment_columns()
                ),
                &[&user_id, &path],
            )?;
            if let Some(r) = prior.first() {
                return enrolment_of(r);
            }
            return Err(academy(
                "No enrolment to leave",
                "academy.enrollment_not_found",
            ));
        };
        let id: String = cell(active, 0)?;
        first(&q(
            tx,
            &format!(
                "UPDATE academy.cert_enrollments SET left_at = now(), leave_request_id = $1 \
                 WHERE id = $2::text::uuid AND left_at IS NULL RETURNING {}",
                enrolment_columns()
            ),
            &[&request, &id],
        )?)
    })
}

/// `Buffer.from(text, 'base64url').toString('utf8')`: Node's decoder reads both alphabets, skips any other character,
/// stops at `=`, and drops leftover bits; bad UTF-8 becomes U+FFFD.
pub fn node_base64url_utf8(text: &str) -> String {
    let mut bytes = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from((acc >> bits) & 0xff).unwrap_or(0));
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `Buffer.from(text, 'utf8').toString('base64url')`.
pub fn base64url(text: &str) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in text.bytes() {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(char::from(
                *A.get(usize::try_from((acc >> bits) & 63).unwrap_or(0))
                    .unwrap_or(&b'A'),
            ));
        }
    }
    if bits > 0 {
        out.push(char::from(
            *A.get(usize::try_from((acc << (6 - bits)) & 63).unwrap_or(0))
                .unwrap_or(&b'A'),
        ));
    }
    out
}

/// `decodeCursor`: `<ISO time>\n<slug>`, or `academy.cert_invalid`.
fn decode_cursor(cursor: &str) -> Result<(i64, String), Refusal> {
    let invalid = || academy("cursor is not valid", "academy.cert_invalid");
    let raw = node_base64url_utf8(cursor);
    let nl = raw.find('\n').filter(|n| *n >= 1).ok_or_else(invalid)?;
    let (at, key) = (raw.get(..nl).unwrap_or(""), raw.get(nl + 1..).unwrap_or(""));
    let at = v8_date_parse(at).ok_or_else(invalid)?;
    if key.is_empty() {
        return Err(invalid());
    }
    Ok((at, key.to_owned()))
}

/// `myCompletions`: the caller's completions newest first, a page at a time.
pub fn my_completions(
    certs: &Certs<'_>,
    user_id: &str,
    limit: Option<f64>,
    cursor: Option<&str>,
) -> Result<Json, Refusal> {
    let limit = sql_list_limit(
        limit,
        "academy.my_completions_list_limit_unset",
        "Completions",
    )?;
    let cursor = cursor
        .filter(|c| !c.is_empty())
        .map(decode_cursor)
        .transpose()?;
    let at = cursor.as_ref().map(|(at, _)| iso(*at));
    let key = cursor.as_ref().map_or(String::new(), |(_, k)| k.clone());
    let rows = db::with_client(certs.store.pool()?, |c| {
        q(
            c,
            &format!(
                "SELECT item_slug, {} \
                   FROM academy.cert_item_completions \
                  WHERE user_id = $1::text::uuid \
                    AND ($2::text::timestamptz IS NULL OR (completed_at, item_slug) < ($2::text::timestamptz, $3)) \
                  ORDER BY completed_at DESC, item_slug DESC \
                  LIMIT $4",
                ms("completed_at")
            ),
            &[&user_id, &at, &key, &(limit + 1)],
        )
    })?;
    let page: Vec<&postgres::Row> = rows
        .iter()
        .take(usize::try_from(limit).unwrap_or(0))
        .collect();
    let mut items = Vec::new();
    for r in &page {
        items.push(Json::obj([
            ("itemSlug", Json::str(cell::<String>(r, 0)?)),
            ("completedAt", Json::str(iso(cell(r, 1)?))),
        ]));
    }
    let next = match page.last() {
        Some(last) if i64::try_from(rows.len()).unwrap_or(0) > limit => {
            let slug: String = cell(last, 0)?;
            Json::str(base64url(&format!("{}\n{slug}", iso(cell(last, 1)?))))
        }
        _ => Json::Null,
    };
    Ok(Json::obj([
        ("items", Json::Array(items)),
        ("nextCursor", next),
    ]))
}
