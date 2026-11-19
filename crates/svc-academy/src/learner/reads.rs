//! What the learner's views read that other parts of the TypeScript own, read here with the same statements:
//!
//! - the quiz rows (`assessment/repository.ts` `publishedSlugs`, `passedSlugs`, `definition`'s pass mark, `grades`; the
//!   code catalog `ASSESSMENT_CATALOG` is empty, so only `academy.quizzes` counts);
//! - a course's start (`readCourseStart`) and enrolment terms (`course-terms.ts` `read`, `unlisted`,
//!   `courseClosedReason`);
//! - the certificate catalog's titles (`certs/catalog.ts` `CERT_CATALOG`: one certificate, Foundations);
//! - the assignment grades of the courses staff made (`curriculum/grading.ts` `courseGrades`, with `late-policy.ts`).
//!
//! The assessment, certificate and authoring slices own the writes; these reads are the learner slice's copies of their
//! SELECTs until those slices expose them.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use super::sql::Pool;

use super::purchases::canonical_price;
use super::sql::{self, cell, column, first, iso, ms, q};
use crate::errors::Refusal;

/// `GREATEST(a.hidden_until, q.results_hidden_until) > now`, as `HIDDEN_UNTIL` writes it (`$2` is now).
const HIDDEN_UNTIL: &str = "CASE WHEN GREATEST(a.hidden_until, q.results_hidden_until) > $2::text::timestamptz \
                            THEN GREATEST(a.hidden_until, q.results_hidden_until) END";

/// `publishedSlugs()`.
pub fn published_slugs(pool: &Pool) -> Result<std::collections::BTreeSet<String>, Refusal> {
    let rows = sql::on_pool(pool, |c| q(c, "SELECT slug FROM academy.quizzes", &[]))?;
    Ok(column::<String>(&rows)?.into_iter().collect())
}

/// `passedSlugs(userId, now)`.
pub fn passed_slugs(pool: &Pool, user_id: &str, now: i64) -> Result<std::collections::BTreeSet<String>, Refusal> {
    let at = iso(now);
    let rows = sql::on_pool(pool, |c| {
        q(
            c,
            &format!(
                "SELECT DISTINCT a.slug FROM academy.assessment_attempts a \
                   LEFT JOIN academy.quizzes q ON q.slug = a.slug \
                  WHERE a.user_id = $1::text::uuid AND a.passed = true AND a.voided_at IS NULL AND {HIDDEN_UNTIL} IS NULL"
            ),
            &[&user_id, &at],
        )
    })?;
    Ok(column::<String>(&rows)?.into_iter().collect())
}

/// `definition(slug)`, as far as completion reads it: none when no quiz is published, else its pass mark (none unset).
pub fn quiz_pass_mark(pool: &Pool, slug: &str) -> Result<Option<Option<i32>>, Refusal> {
    let row = sql::on_pool(pool, |c| {
        first(
            c,
            "SELECT slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode FROM academy.quizzes WHERE slug = $1",
            &[&slug],
        )
    })?;
    row.map(|r| cell::<Option<i32>>(&r, 2)).transpose()
}

/// One `GradeRow`.
pub enum Grade {
    Pending { slug: String, attempts: i32, hidden_until: i64 },
    Released { slug: String, attempts: i32, score: i32, possible: i32, passed: bool },
}

impl Grade {
    pub fn slug(&self) -> &str {
        match self {
            Grade::Pending { slug, .. } | Grade::Released { slug, .. } => slug,
        }
    }
}

/// `grades(userId, now)`: the best attempt per quiz, pending as a whole while any attempt is hidden.
pub fn grades(pool: &Pool, user_id: &str, now: i64) -> Result<Vec<Grade>, Refusal> {
    let at = iso(now);
    let rows = sql::on_pool(pool, |c| {
        q(
            c,
            &format!(
                "WITH visible AS ( \
                   SELECT a.slug, a.score, a.max_score, a.passed, a.submitted_at, {HIDDEN_UNTIL} AS hidden_until \
                     FROM academy.assessment_attempts a \
                     LEFT JOIN academy.quizzes q ON q.slug = a.slug \
                    WHERE a.user_id = $1::text::uuid AND a.voided_at IS NULL \
                 ) \
                 SELECT slug, score, max_score, passed, attempts, {} FROM ( \
                   SELECT DISTINCT ON (slug) slug, score, max_score, passed, submitted_at, \
                          COUNT(*) OVER (PARTITION BY slug)::int AS attempts, \
                          MAX(hidden_until) OVER (PARTITION BY slug) AS hidden_until \
                     FROM visible \
                    ORDER BY slug, passed DESC, score * 1.0 / NULLIF(max_score, 0) DESC NULLS LAST, submitted_at DESC \
                 ) best ORDER BY slug",
                ms("hidden_until")
            ),
            &[&user_id, &at],
        )
    })?;
    rows.iter()
        .map(|r| {
            let slug: String = cell(r, 0)?;
            let attempts: i32 = cell(r, 4)?;
            Ok(match cell::<Option<i64>>(r, 5)? {
                Some(hidden_until) => Grade::Pending { slug, attempts, hidden_until },
                None => Grade::Released {
                    slug,
                    attempts,
                    score: cell(r, 1)?,
                    possible: cell(r, 2)?,
                    passed: cell(r, 3)?,
                },
            })
        })
        .collect()
}

/// `readCourseStart(sql, path)`.
pub fn course_starts_at(c: &mut impl GenericClient, path: &str) -> Result<Option<i64>, Refusal> {
    Ok(first(
        c,
        &format!("SELECT {} FROM academy.course_starts WHERE path = $1", ms("starts_at")),
        &[&path],
    )?
    .map(|r| cell::<Option<i64>>(&r, 0))
    .transpose()?
    .flatten())
}

/// `CourseTerms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub seat_cap: Option<i32>,
    pub opens_at: Option<i64>,
    pub closes_at: Option<i64>,
    pub visibility: String,
}

impl Terms {
    /// `NO_TERMS`.
    pub fn none() -> Terms {
        Terms { seat_cap: None, opens_at: None, closes_at: None, visibility: "published".to_owned() }
    }
}

/// `CourseTermsStore.read(path)`.
pub fn course_terms(c: &mut impl GenericClient, path: &str) -> Result<Terms, Refusal> {
    let row = first(
        c,
        &format!(
            "SELECT seat_cap, {}, {}, visibility FROM academy.course_enrolment_terms WHERE path = $1",
            ms("opens_at"),
            ms("closes_at")
        ),
        &[&path],
    )?;
    row.map_or(Ok(Terms::none()), |r| {
        Ok(Terms {
            seat_cap: cell(&r, 0)?,
            opens_at: cell(&r, 1)?,
            closes_at: cell(&r, 2)?,
            visibility: cell(&r, 3)?,
        })
    })
}

/// `CourseTermsStore.unlisted()`.
pub fn unlisted(pool: &Pool) -> Result<Vec<String>, Refusal> {
    let rows = sql::on_pool(pool, |c| {
        q(c, "SELECT path FROM academy.course_enrolment_terms WHERE visibility <> 'published'", &[])
    })?;
    column(&rows)
}

/// `courseClosedReason(terms, seatsTaken, now)`.
pub fn closed_reason(terms: &Terms, seats_taken: i64, now: i64) -> Option<&'static str> {
    match terms.visibility.as_str() {
        "unpublished" => return Some("unpublished"),
        "hidden" => return Some("hidden"),
        _ => {}
    }
    if terms.opens_at.is_some_and(|o| now < o) {
        return Some("window_not_started");
    }
    if terms.closes_at.is_some_and(|c| now >= c) {
        return Some("window_ended");
    }
    if terms.seat_cap.is_some_and(|cap| seats_taken >= i64::from(cap)) {
        return Some("full");
    }
    None
}

/// The certificate of a path, by `CERT_CATALOG` (`FOUNDATIONS_V1`).
pub fn certificate_title(path: &str) -> Option<String> {
    (path == "foundations").then(|| "Foundations".to_owned())
}

/// `tenths(part, whole)` over whole numbers: a percent to one place, rounded half up.
pub fn tenths(part: i64, whole: i64) -> String {
    if whole <= 0 {
        return "0.0".to_owned();
    }
    let t = (part * 2000 + whole).div_euclid(2 * whole);
    format!("{}.{}", t.div_euclid(10), t.rem_euclid(10))
}

/// `tenthsOf(part, whole)` in `grading.ts`, over bigints.
fn tenths_of(part: i128, whole: i128) -> String {
    let t = (part * 2000 + whole) / (2 * whole);
    format!("{}.{}", t / 10, t % 10)
}

/// `hundredths(level)`.
fn hundredths(level: &str) -> Result<i128, Refusal> {
    parse_amount(level)
        .map(|a| a / 10i128.pow(16))
        .map_err(|e| Refusal::Internal { message: e, code: None })
}

const SCALE: Amount = 1_000_000_000_000_000_000;
const HOUR_MS: Amount = 3_600_000;
const DAY_MS: Amount = 86_400_000;
const CENT: Amount = SCALE / 100;

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(|e| Refusal::Internal { message: e, code: None })
}

/// `lateScore(entered, points, submittedAt, dueAt, policy)`'s score.
pub fn late_score(
    entered: &str,
    points: &str,
    submitted_at: i64,
    due_at: Option<i64>,
    policy: Option<(&str, &str)>,
) -> Result<String, Refusal> {
    let (Some((grace_hours, deduction_per_day)), Some(due)) = (policy, due_at) else {
        return Ok(entered.to_owned());
    };
    let grace_ms = amount(grace_hours)? * HOUR_MS / SCALE;
    let late_ms = Amount::from(submitted_at - due) - grace_ms;
    if late_ms <= 0 {
        return Ok(entered.to_owned());
    }
    let days = (late_ms + DAY_MS - 1) / DAY_MS;
    let asked = days * amount(deduction_per_day)?;
    let share = asked.min(SCALE);
    let off = ((amount(points)? * share / SCALE + CENT - 1) / CENT) * CENT;
    let kept = amount(entered)? - off;
    let score = format_amount(kept.max(0));
    Ok(if score == format_amount(amount(entered)?) { entered.to_owned() } else { score })
}

/// `courseGrades(userId)`: per course the learner is enrolled in, each assignment's state and score, and the average.
pub fn course_grades(pool: &Pool, user_id: &str) -> Result<Json, Refusal> {
    let rows = sql::on_pool(pool, |c| {
        q(
            c,
            &format!(
                "SELECT c.id::text AS course_id, c.slug, c.title AS course_title, i.id::text AS item_id, i.title, \
                   a.points::text AS points, a.withdrawn_at IS NOT NULL AS withdrawn, l.id IS NOT NULL AS handed_in, \
                   g.score::text AS score, g.points::text AS graded_points, {}, {}, {}, \
                   lp.grace_hours::text AS grace_hours, lp.deduction_per_day::text AS deduction_per_day \
                 FROM academy.course_enrolments e \
                 JOIN academy.courses c ON c.id = e.course_id AND c.state = 'published' \
                 JOIN academy.course_items i ON i.course_id = c.id AND i.kind = 'assignment' \
                 JOIN academy.course_sections sec ON sec.id = i.section_id \
                 JOIN academy.course_assignments a ON a.item_id = i.id \
                 LEFT JOIN LATERAL ( \
                   SELECT s.id, s.submitted_at FROM academy.assignment_submissions s \
                   WHERE s.item_id = i.id AND s.user_id = $1::text::uuid \
                   ORDER BY s.version DESC LIMIT 1 \
                 ) l ON TRUE \
                 LEFT JOIN LATERAL ( \
                   SELECT g.score, g.points FROM academy.assignment_grade_events g WHERE g.submission_id = l.id \
                   ORDER BY g.n DESC LIMIT 1 \
                 ) g ON TRUE \
                 LEFT JOIN academy.course_item_extensions x ON x.item_id = i.id AND x.user_id = $1::text::uuid \
                 LEFT JOIN academy.course_late_policies lp ON lp.course_id = c.id AND lp.set_at <= l.submitted_at \
                 WHERE e.user_id = $1::text::uuid AND e.left_at IS NULL \
                 ORDER BY c.title, c.id, sec.position, i.position",
                ms("l.submitted_at"),
                ms("a.due_at"),
                ms("x.due_at")
            ),
            &[&user_id],
        )
    })?;
    /// Course id, slug, title, rows, and each graded row's (score, possible) in hundredths.
    type Course = (String, String, String, Vec<Json>, Vec<(i128, i128)>);
    let mut courses: Vec<Course> = Vec::new();
    for r in &rows {
        let course_id: String = cell(r, 0)?;
        if !courses.iter().any(|c| c.0 == course_id) {
            courses.push((course_id.clone(), cell(r, 1)?, cell(r, 2)?, Vec::new(), Vec::new()));
        }
        let Some(course) = courses.iter_mut().find(|c| c.0 == course_id) else {
            continue;
        };
        let head = [
            ("itemId", Json::String(cell(r, 3)?)),
            ("title", Json::String(cell(r, 4)?)),
            ("type", Json::str("assignment")),
        ];
        let score: Option<String> = cell(r, 8)?;
        let row = match score {
            Some(score) => {
                let graded_points: String = cell::<Option<String>>(r, 9)?.unwrap_or_default();
                let submitted: Option<i64> = cell(r, 10)?;
                let brief_due: Option<i64> = cell(r, 11)?;
                let extended: Option<i64> = cell(r, 12)?;
                // `dueFor(briefDue, extended)`.
                let due = match (brief_due, extended) {
                    (Some(b), Some(e)) => Some(b.max(e)),
                    (b, _) => b,
                };
                let grace: Option<String> = cell(r, 13)?;
                let deduction: Option<String> = cell(r, 14)?;
                // `policyOf(row)`: both stored values, as `formatAmount(parseAmount(..))`.
                let policy = match (&grace, &deduction) {
                    (Some(g), Some(d)) => Some((format_amount(amount(g)?), format_amount(amount(d)?))),
                    _ => None,
                };
                let possible = canonical_price(&graded_points);
                let late = late_score(
                    &canonical_price(&score),
                    &possible,
                    submitted.unwrap_or(0),
                    due,
                    policy.as_ref().map(|(g, d)| (g.as_str(), d.as_str())),
                )?;
                course.4.push((hundredths(&late)?, hundredths(&possible)?));
                let [a, b, c] = head;
                // The output schema's order: `state` first.
                Json::obj([
                    ("state", Json::str("graded")),
                    a,
                    b,
                    c,
                    ("score", Json::str(late)),
                    ("possible", Json::str(possible)),
                ])
            }
            None => {
                let handed_in: bool = cell(r, 7)?;
                let withdrawn: bool = cell(r, 6)?;
                let points: String = cell::<Option<String>>(r, 5)?.unwrap_or_default();
                let state = if handed_in {
                    "handed_in"
                } else if withdrawn {
                    "withdrawn"
                } else {
                    "not_attempted"
                };
                let [a, b, c] = head;
                Json::obj([("state", Json::str(state)), a, b, c, ("possible", Json::str(canonical_price(&points)))])
            }
        };
        course.3.push(row);
    }
    Ok(Json::Array(
        courses
            .into_iter()
            .map(|(_, slug, title, rows, graded)| {
                let averages = if graded.is_empty() {
                    Vec::new()
                } else {
                    let score: i128 = graded.iter().map(|g| g.0).sum();
                    let possible: i128 = graded.iter().map(|g| g.1).sum();
                    vec![Json::obj([
                        ("type", Json::str("assignment")),
                        ("percent", Json::str(tenths_of(score, possible))),
                        ("count", Json::int(i64::try_from(graded.len()).unwrap_or(i64::MAX))),
                    ])]
                };
                Json::obj([
                    ("slug", Json::String(slug)),
                    ("title", Json::String(title)),
                    ("rows", Json::Array(rows)),
                    ("averages", Json::Array(averages)),
                ])
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tenths_round_half_up_to_one_place() {
        assert_eq!(tenths(1, 3), "33.3");
        assert_eq!(tenths(2, 3), "66.7");
        assert_eq!(tenths(0, 0), "0.0");
        assert_eq!(tenths(7, 7), "100.0");
    }

    #[test]
    fn a_late_hand_in_loses_its_deduction_per_started_day_past_the_grace() {
        let due = 0;
        let day = 86_400_000;
        // On time, or within the grace: nothing taken off.
        assert_eq!(late_score("8", "10", due, Some(due), Some(("24", "0.1"))).unwrap(), "8");
        assert_eq!(late_score("8", "10", due + day, Some(due), Some(("24", "0.1"))).unwrap(), "8");
        // One started day past the grace: a tenth of the points.
        assert_eq!(late_score("8", "10", due + day + 1, Some(due), Some(("24", "0.1"))).unwrap(), "7");
        // Never below zero; no policy or no due date, nothing.
        assert_eq!(late_score("8", "10", due + 30 * day, Some(due), Some(("0", "0.5"))).unwrap(), "0");
        assert_eq!(late_score("8", "10", due + 30 * day, None, Some(("0", "0.5"))).unwrap(), "8");
        assert_eq!(late_score("8", "10", due + 30 * day, Some(due), None).unwrap(), "8");
    }
}
