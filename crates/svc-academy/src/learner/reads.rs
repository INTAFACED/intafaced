//! The assignment grades of the courses staff made, as the learner's progress page shows them
//! (`curriculum/grading.ts` `courseGrades`, with `late-policy.ts`'s `lateScore`, which is the assessment slice's
//! [`gradebook::late_score`]).

use super::sql::Pool;
use service_kit::json::Json;
use service_kit::money::parse_amount;

use super::purchases::canonical_price;
use super::sql::{self, cell, ms, q};
use crate::assessment::gradebook;
use crate::errors::Refusal;

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
        .map(|a| a.scaled() / 10i128.pow(16))
        .map_err(|e| Refusal::Internal {
            message: e,
            code: None,
        })
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
            courses.push((
                course_id.clone(),
                cell(r, 1)?,
                cell(r, 2)?,
                Vec::new(),
                Vec::new(),
            ));
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
                let policy = gradebook::policy_of(grace.as_deref(), deduction.as_deref());
                let possible = canonical_price(&graded_points);
                let (late, _) = gradebook::late_score(
                    &canonical_price(&score),
                    &possible,
                    submitted.unwrap_or(0),
                    due,
                    policy.as_ref(),
                );
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
                Json::obj([
                    ("state", Json::str(state)),
                    a,
                    b,
                    c,
                    ("possible", Json::str(canonical_price(&points))),
                ])
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
                        (
                            "count",
                            Json::int(i64::try_from(graded.len()).unwrap_or(i64::MAX)),
                        ),
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
}
