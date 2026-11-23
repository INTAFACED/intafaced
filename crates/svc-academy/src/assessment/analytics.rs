//! Quiz analytics from real graded attempts as their score trail leaves them (`curriculum/course-quiz-analytics.ts`).
//! Writes nothing.

use std::collections::{BTreeMap, BTreeSet};

use crate::db::Store;
use service_kit::json::Json;

use super::quizzes::questions_of;
use super::score;
use super::trail::{TRAIL_COLUMNS, finished_points, newest_events, read_trail};
use super::{cell, first, int, json_cell, num, query, refuse, with_client};
use crate::errors::Refusal;

/// `shareText(part, whole)`: a percentage with one place, rounded half up; null when `whole` is 0.
pub fn share_text(part: i64, whole: i64) -> Option<String> {
    if whole == 0 {
        return None;
    }
    let tenths = (part * 2000 + whole).div_euclid(2 * whole);
    Some(format!(
        "{}.{}",
        tenths.div_euclid(10),
        tenths.rem_euclid(10)
    ))
}

/// `meanText(sum, n)`: two places, rounded half up; null when `n` is 0.
pub fn mean_text(sum: i64, n: i64) -> Option<String> {
    if n == 0 {
        return None;
    }
    let hundredths = (sum * 200 + n).div_euclid(2 * n);
    Some(format!(
        "{}.{:02}",
        hundredths.div_euclid(100),
        hundredths.rem_euclid(100)
    ))
}

fn text(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::String)
}

/// `analytics(itemId)`.
pub fn analytics(pool: &Store, item_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let quiz = first(
            c,
            "SELECT i.title, i.kind, q.kind AS quiz_kind, q.revision, q.questions::text AS questions \
             FROM academy.course_items i LEFT JOIN academy.course_quizzes q ON q.item_id = i.id WHERE i.id = $1::text::uuid",
            &[&item_id],
        )?;
        let quiz = match quiz {
            Some(q)
                if cell::<String>(&q, "kind")? == "quiz"
                    && cell::<Option<String>>(&q, "quiz_kind")?
                        .as_deref()
                        .unwrap_or("quiz")
                        == "quiz" =>
            {
                q
            }
            _ => return refuse("no graded quiz with that id", "academy.quiz_not_found"),
        };
        let graded = query(
            c,
            &format!(
                "SELECT {TRAIL_COLUMNS} FROM academy.course_quiz_attempts t \
                 WHERE t.item_id = $1::text::uuid AND t.state = 'graded' ORDER BY t.user_id, t.number"
            ),
            &[&item_id],
        )?
        .iter()
        .map(|r| read_trail(r, false))
        .collect::<Result<Vec<_>, _>>()?;
        let ids: Vec<String> = graded.iter().map(|g| g.id.clone()).collect();
        let events = newest_events(c, &ids)?;
        let firsts: BTreeMap<String, i32> = query(
            c,
            "SELECT user_id::text AS user_id, min(number)::int AS number FROM academy.course_quiz_attempts \
             WHERE item_id = $1::text::uuid AND state <> 'open' GROUP BY user_id",
            &[&item_id],
        )?
        .iter()
        .map(|r| Ok((cell::<String>(r, "user_id")?, cell::<i32>(r, "number")?)))
        .collect::<Result<_, Refusal>>()?;
        let learners = graded
            .iter()
            .map(|g| g.user_id.as_str())
            .collect::<BTreeSet<_>>()
            .len();
        let scored: Vec<(&super::trail::TrailAttempt, bool, Json, i64)> = graded
            .iter()
            .map(|g| {
                let last = events.get(&g.id);
                let points = last.map_or_else(
                    || finished_points(g.questions(), &g.answers, g.essay_points.as_ref()),
                    |e| e.points.clone(),
                );
                let score =
                    last.map_or_else(|| i64::from(g.score.unwrap_or(0)), |e| i64::from(e.score));
                (g, firsts.get(&g.user_id) == Some(&g.number), points, score)
            })
            .collect();
        let highest = graded
            .iter()
            .map(|g| i64::from(g.max_score.unwrap_or(0)))
            .chain(scored.iter().map(|s| s.3))
            .fold(0, i64::max);
        let mut counts: BTreeMap<i64, i64> = BTreeMap::new();
        for s in &scored {
            *counts.entry(s.3).or_insert(0) += 1;
        }
        let distribution: Vec<Json> = if scored.is_empty() {
            Vec::new()
        } else {
            (0..=highest)
                .map(|s| {
                    Json::obj([
                        ("score", int(s)),
                        ("count", int(counts.get(&s).copied().unwrap_or(0))),
                    ])
                })
                .collect()
        };
        let items: Vec<Json> = questions_of(json_cell(&quiz, "questions")?.as_ref())
            .iter()
            .map(|q| {
                let qid = score::id(q);
                let (mut attempts, mut full, mut sum, mut first_attempts, mut first_full) =
                    (0i64, 0i64, 0i64, 0i64, 0i64);
                for (a, is_first, points, _) in &scored {
                    let Some(own) = a.questions().iter().find(|x| score::id(x) == qid) else {
                        continue;
                    };
                    let earned = points.get(qid).and_then(num).unwrap_or(0);
                    attempts += 1;
                    sum += earned;
                    let got = earned >= score::points(own);
                    if got {
                        full += 1;
                    }
                    if *is_first {
                        first_attempts += 1;
                        if got {
                            first_full += 1;
                        }
                    }
                }
                Json::obj([
                    ("questionId", Json::str(qid)),
                    ("prompt", q.get("prompt").cloned().unwrap_or(Json::Null)),
                    ("kind", Json::str(score::kind(q))),
                    ("points", int(score::points(q))),
                    ("attempts", int(attempts)),
                    ("fullMarksShare", text(share_text(full, attempts))),
                    ("meanPoints", text(mean_text(sum, attempts))),
                    (
                        "firstAttemptFullMarksShare",
                        text(share_text(first_full, first_attempts)),
                    ),
                ])
            })
            .collect();
        Ok(Json::obj([
            ("itemId", Json::str(item_id)),
            ("title", Json::String(cell(&quiz, "title")?)),
            (
                "revision",
                int(i64::from(
                    cell::<Option<i32>>(&quiz, "revision")?.unwrap_or(0),
                )),
            ),
            ("graded", int(i64::try_from(graded.len()).unwrap_or(0))),
            ("learners", int(i64::try_from(learners).unwrap_or(0))),
            ("scoreDistribution", Json::Array(distribution)),
            ("items", Json::Array(items)),
        ]))
    })
}

/// `answers(input)`: answer-level data needs the data researcher role, which has no store, so every caller is refused.
pub fn answers(pool: &Store, item_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let quiz = first(
            c,
            "SELECT kind FROM academy.course_items WHERE id = $1::text::uuid",
            &[&item_id],
        )?;
        match quiz {
            Some(q) if cell::<String>(&q, "kind")? == "quiz" => refuse(
                "answer-level data needs the data researcher role on this course; course roles (AC-roles-01) have no store, so no account holds it",
                "academy.permission_denied",
            ),
            _ => refuse("no graded quiz with that id", "academy.quiz_not_found"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_and_means_round_half_up() {
        assert_eq!(share_text(1, 3).as_deref(), Some("33.3"));
        assert_eq!(share_text(2, 3).as_deref(), Some("66.7"));
        assert_eq!(share_text(1, 1).as_deref(), Some("100.0"));
        assert_eq!(share_text(0, 0), None);
        assert_eq!(mean_text(5, 2).as_deref(), Some("2.50"));
        assert_eq!(mean_text(1, 3).as_deref(), Some("0.33"));
        assert_eq!(mean_text(2, 3).as_deref(), Some("0.67"));
        assert_eq!(mean_text(1, 0), None);
    }
}
