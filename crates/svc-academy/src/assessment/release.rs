//! `assertItemOpen` (`curriculum/course-release.ts`): a learner's quiz or assignment stays closed while its section has
//! not opened for them (`academy.not_released_yet`, naming the instant) and while an assignment or quiz it requires is
//! not yet handed in, finished or answered (`academy.prerequisite_unmet`, naming the items). Work the learner already
//! began on the item stays theirs. Writes nothing.

use postgres::GenericClient;

use super::{cell, first, iso, ms, refuse};
use crate::errors::Refusal;

const DAY_MS: i64 = 86_400_000;

/// `doneBy(item, userId, begun)`.
fn done_by(item: &str, begun: bool) -> String {
    let (sub, att) = if begun {
        ("", "")
    } else {
        (
            " AND s.state NOT IN ('draft', 'withdrawn')",
            " AND t.state <> 'open'",
        )
    };
    format!(
        "(EXISTS (SELECT 1 FROM academy.assignment_submissions s WHERE s.item_id = {item} AND s.user_id = $2::text::uuid{sub}) \
         OR EXISTS (SELECT 1 FROM academy.course_quiz_attempts t WHERE t.item_id = {item} AND t.user_id = $2::text::uuid{att}) \
         OR EXISTS (SELECT 1 FROM academy.course_survey_takers k WHERE k.item_id = {item} AND k.user_id = $2::text::uuid))"
    )
}

pub fn assert_item_open<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    user_id: &str,
    now: i64,
) -> Result<(), Refusal> {
    let sql = format!(
        "SELECT {release_at} AS release_at, r.after_days, \
           (SELECT {enrolled} FROM academy.course_enrolments e \
             WHERE e.course_id = i.course_id AND e.user_id = $2::text::uuid AND e.left_at IS NULL) AS enrolled_at, \
           {begun} AS begun, \
           ARRAY(SELECT p.prerequisite_id::text FROM academy.course_item_prerequisites p \
             JOIN academy.course_items pi ON pi.id = p.prerequisite_id AND pi.kind IN ('assignment', 'quiz') \
             WHERE p.item_id = i.id AND NOT {done} \
             ORDER BY p.prerequisite_id) AS unmet \
         FROM academy.course_items i LEFT JOIN academy.course_section_releases r ON r.section_id = i.section_id \
         WHERE i.id = $1::text::uuid",
        release_at = ms("r.release_at"),
        enrolled = ms("e.enrolled_at"),
        begun = done_by("i.id", true),
        done = done_by("p.prerequisite_id", false),
    );
    let Some(row) = first(c, &sql, &[&item_id, &user_id])? else {
        return Ok(());
    };
    if cell::<bool>(&row, "begun")? {
        return Ok(());
    }
    let release_at: Option<i64> = cell(&row, "release_at")?;
    let after_days: Option<i32> = cell(&row, "after_days")?;
    let enrolled_at: Option<i64> = cell(&row, "enrolled_at")?;
    // `ruleOf` then `opensAt`: an instant, or the enrolment plus the days.
    let rule = match (release_at, after_days) {
        (Some(at), _) => Some(Some(at)),
        (None, Some(days)) => Some(enrolled_at.map(|e| e + i64::from(days) * DAY_MS)),
        (None, None) => None,
    };
    if let Some(at) = rule
        && at.is_none_or(|t| t > now)
    {
        let opens = at.map_or_else(|| "after enrolment".to_owned(), iso);
        return refuse(
            format!("academy.not_released_yet opens={opens}"),
            "academy.not_released_yet",
        );
    }
    let unmet: Vec<String> = cell(&row, "unmet")?;
    if !unmet.is_empty() {
        return refuse(
            format!("academy.prerequisite_unmet items={}", unmet.join(",")),
            "academy.prerequisite_unmet",
        );
    }
    Ok(())
}
