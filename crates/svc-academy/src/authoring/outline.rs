//! The outline a learner reads (`academy-service.ts` `courseOutline`, `courseReleases`, `completionTimes`,
//! `completionRule`, `watchedItems`, and the assessment repository's `passedSlugs` and `publishedSlugs`): each item of the
//! item's course with the caller's own release state, completion rule and due date. Titles, kinds and lock reasons only:
//! no body, and no staff name or reason from an extension.

use service_kit::json::Json;
use crate::db::Store;
use service_kit::schema::js_trim;

use super::release::{self, course_start};
use super::sql::{self, at, get, iso, ms, query};
use super::{refuse, tracks};
use crate::curriculum::spine;
use crate::errors::Refusal;

/// `dueFor(dueAt, extendedUntil)` as the outline shows it.
fn due_for(due: Option<i64>, extended: Option<i64>) -> (Json, bool) {
    match (due, extended) {
        (None, _) => (Json::Null, false),
        (Some(d), Some(e)) if e > d => (Json::String(iso(e)), true),
        (Some(d), _) => (Json::String(iso(d)), false),
    }
}

/// `courseOutline({ userId, itemSlug })`.
pub fn course_outline(pool: &Store, user_id: &str, item_slug: &str, now: i64, watch_threshold: Option<i64>) -> Result<Json, Refusal> {
    let Some(item) = spine::get(js_trim(item_slug)) else {
        return refuse("Unknown curriculum item", "academy.curriculum_not_found");
    };
    let path = item.path.clone();
    sql::client(pool, |c| {
        let starts = course_start(c, &path)?;
        let rows = spine::list(Some(&path), None);
        let mut views = Vec::new();
        for r in &rows {
            views.push(release::load(c, user_id, &r.slug, now, starts)?);
        }
        let slugs: Vec<String> = rows.iter().map(|r| r.slug.clone()).collect();
        let completed_at: Vec<(String, i64)> = if slugs.is_empty() {
            Vec::new()
        } else {
            query(
                c,
                &format!(
                    "SELECT item_slug, {} AS completed_at FROM academy.cert_item_completions \
                     WHERE user_id = $1::text::uuid AND item_slug = ANY($2::text[])",
                    ms("completed_at")
                ),
                &[&user_id, &slugs],
            )?
            .iter()
            .map(|r| Ok((get(r, "item_slug")?, get(r, "completed_at")?)))
            .collect::<Result<_, Refusal>>()?
        };
        let passed: Vec<String> = query(
            c,
            "SELECT DISTINCT a.slug FROM academy.assessment_attempts a LEFT JOIN academy.quizzes q ON q.slug = a.slug \
             WHERE a.user_id = $1::text::uuid AND a.passed = true AND a.voided_at IS NULL \
               AND CASE WHEN GREATEST(a.hidden_until, q.results_hidden_until) > $2::text::timestamptz \
                        THEN GREATEST(a.hidden_until, q.results_hidden_until) END IS NULL",
            &[&user_id, &at(now)],
        )?
        .iter()
        .map(|r| get(r, "slug"))
        .collect::<Result<_, _>>()?;
        // The code catalog of assessments is empty; the published ones are the rows.
        let quizzes: Vec<String> = query(c, "SELECT slug FROM academy.quizzes", &[])?
            .iter()
            .map(|r| get(r, "slug"))
            .collect::<Result<_, _>>()?;
        let videos = tracks::item_videos(c, &slugs)?;
        let watched: Vec<String> = match watch_threshold {
            Some(t) if !videos.is_empty() => {
                let mut distinct: Vec<String> = Vec::new();
                for (_, v) in &videos {
                    if !distinct.contains(v) {
                        distinct.push(v.clone());
                    }
                }
                let t4 = i32::try_from(t).unwrap_or(i32::MAX);
                let seen: Vec<String> = query(
                    c,
                    "SELECT video_slug FROM academy.video_progress \
                     WHERE user_id = $1::text::uuid AND video_slug = ANY($2::text[]) AND position_seconds >= $3::int4",
                    &[&user_id, &distinct, &t4],
                )?
                .iter()
                .map(|r| get(r, "video_slug"))
                .collect::<Result<_, _>>()?;
                videos.iter().filter(|(_, v)| seen.contains(v)).map(|(i, _)| i.clone()).collect()
            }
            _ => Vec::new(),
        };
        let items = rows
            .iter()
            .zip(&views)
            .map(|(row, view)| {
                let opens_later = view.decision.lock == Some("window") && view.available_from.is_some_and(|f| f > now);
                let has_quiz = quizzes.contains(&row.slug);
                let rule = if has_quiz {
                    "score"
                } else if videos.iter().any(|(i, _)| *i == row.slug) {
                    "watch"
                } else {
                    "view"
                };
                let met = rule == "view" || if rule == "score" { passed.contains(&row.slug) } else { watched.contains(&row.slug) };
                let (due, extended) = due_for(view.due_at, view.extended_until);
                Json::obj([
                    ("slug", Json::str(&row.slug)),
                    ("title", Json::str(&row.title)),
                    ("kind", Json::str(&row.kind)),
                    ("type", Json::str(spine::item_type(&row.kind, has_quiz))),
                    ("state", Json::str(view.decision.state)),
                    ("lock", view.decision.lock.map_or(Json::Null, Json::str)),
                    ("missing", Json::Array(view.decision.missing.iter().map(Json::str).collect())),
                    (
                        "opensAt",
                        if opens_later {
                            view.available_from.map_or(Json::Null, |f| Json::String(iso(f)))
                        } else {
                            Json::Null
                        },
                    ),
                    ("rule", Json::str(rule)),
                    ("ruleMet", Json::Bool(met)),
                    (
                        "completedAt",
                        completed_at
                            .iter()
                            .find(|(s, _)| *s == row.slug)
                            .map_or(Json::Null, |(_, t)| Json::String(iso(*t))),
                    ),
                    ("dueAt", due),
                    ("dueExtended", Json::Bool(extended)),
                ])
            })
            .collect();
        Ok(Json::obj([("slug", Json::str(&path)), ("items", Json::Array(items))]))
    })
}
