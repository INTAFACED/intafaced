//! Rubrics and peer or self review on an assignment (`curriculum/peer-review.ts`). Each review is one row keyed
//! `peer:<assignment>:<reviewer>:<author>`, written when the work is handed out and completed once with the marks.

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};

use super::assignments::learner_row;
use super::storage::{ObjectBytes, StorageConfig, configured, presign};
use super::{
    array, begin, cell, exec, field, field_str, first, int, iso, json_cell, one, opt_int, opt_str,
    query, refuse, sha256_hex, with_client,
};
use crate::errors::Refusal;

/// `hundredths(level)`: "1.5" is 150.
pub fn hundredths(level: &str) -> i128 {
    parse_amount(level).unwrap_or(Amount::ZERO).scaled() / 10_i128.pow(16)
}

/// `rubricTotal(marks)`.
pub fn rubric_total(marks: &[String]) -> String {
    let sum: i128 = marks.iter().map(|m| hundredths(m)).sum();
    let fraction = format!("{:02}", sum % 100);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{}", sum / 100)
    } else {
        format!("{}.{fraction}", sum / 100)
    }
}

const STEPS: &str = "SELECT s.revision, s.peer, s.peer_count, s.self, s.rubric_id::text AS rubric_id, r.criteria::text AS criteria \
    FROM academy.assignment_review_steps s LEFT JOIN academy.assignment_rubrics r ON r.id = s.rubric_id WHERE s.item_id = $1::text::uuid";

/// `reviewStepsOf(sql, itemId)`: null until first saved.
pub fn review_steps_of<C: GenericClient>(
    c: &mut C,
    item_id: &str,
) -> Result<Option<Json>, Refusal> {
    let Some(row) = first(c, STEPS, &[&item_id])? else {
        return Ok(None);
    };
    let peer_count: Option<i32> = cell(&row, "peer_count")?;
    let count = peer_count.unwrap_or(0);
    let waiting = one(
        c,
        "WITH authors AS (SELECT DISTINCT user_id FROM academy.assignment_submissions WHERE item_id = $1::text::uuid AND state <> 'withdrawn'), \
         tally AS ( \
           SELECT a.user_id, \
             (SELECT count(*) FROM academy.assignment_reviews r \
               WHERE r.item_id = $1::text::uuid AND r.author_id = a.user_id AND r.reviewer_id <> a.user_id AND r.marks IS NOT NULL)::int AS received, \
             (SELECT count(*) FROM academy.assignment_reviews r \
               WHERE r.item_id = $1::text::uuid AND r.reviewer_id = a.user_id AND r.author_id <> a.user_id AND r.marks IS NOT NULL)::int AS given, \
             EXISTS (SELECT 1 FROM academy.assignment_reviews r \
               WHERE r.item_id = $1::text::uuid AND r.reviewer_id = a.user_id AND r.author_id <> a.user_id AND r.marks IS NULL) AS open, \
             EXISTS (SELECT 1 FROM authors o WHERE o.user_id <> a.user_id \
               AND NOT EXISTS (SELECT 1 FROM academy.assignment_reviews r \
                 WHERE r.item_id = $1::text::uuid AND r.reviewer_id = a.user_id AND r.author_id = o.user_id)) AS free \
           FROM authors a \
         ) \
         SELECT count(*) FILTER (WHERE received < $2::int4)::int AS short, \
           count(*) FILTER (WHERE given < $2::int4 AND NOT open AND NOT free)::int AS waiting \
         FROM tally",
        &[&item_id, &count],
    )?;
    let peer: bool = cell(&row, "peer")?;
    let peer_on = peer && peer_count.is_some();
    let rubric_id: Option<String> = cell(&row, "rubric_id")?;
    let rubric = match rubric_id {
        None => Json::Null,
        Some(id) => Json::obj([
            ("id", Json::String(id)),
            (
                "criteria",
                json_cell(&row, "criteria")?.unwrap_or(Json::Null),
            ),
        ]),
    };
    Ok(Some(Json::obj([
        ("revision", int(i64::from(cell::<i32>(&row, "revision")?))),
        ("peer", Json::Bool(peer)),
        ("peerCount", opt_int(peer_count.map(i64::from))),
        ("self", Json::Bool(cell(&row, "self")?)),
        ("rubric", rubric),
        (
            "authorsShortOfReviews",
            int(if peer_on {
                i64::from(cell::<i32>(&waiting, "short")?)
            } else {
                0
            }),
        ),
        (
            "reviewersWaiting",
            int(if peer_on {
                i64::from(cell::<i32>(&waiting, "waiting")?)
            } else {
                0
            }),
        ),
    ])))
}

/// `assertPeerCountsSet(sql, courseId)`.
pub fn assert_peer_counts_set<C: GenericClient>(c: &mut C, course_id: &str) -> Result<(), Refusal> {
    let unset = first(
        c,
        "SELECT i.title FROM academy.assignment_review_steps s JOIN academy.course_items i ON i.id = s.item_id \
         WHERE i.course_id = $1::text::uuid AND s.peer AND s.peer_count IS NULL LIMIT 1",
        &[&course_id],
    )?;
    if let Some(u) = unset {
        let title: String = cell(&u, "title")?;
        return refuse(
            format!(
                "\"{title}\" has peer review on with no review count, so the course is not published"
            ),
            "academy.peer_count_unset",
        );
    }
    Ok(())
}

/// The review steps as staff save them.
pub struct StepsInput<'a> {
    pub item_id: &'a str,
    pub revision: i64,
    pub peer: bool,
    pub peer_count: Option<i64>,
    pub self_review: bool,
    /// `criteria` as the input schema returned it (names trimmed).
    pub criteria: &'a [Json],
}

/// `save(input)`.
pub fn save(pool: &Store, input: &StepsInput<'_>, operator: &str, now: i64) -> Result<(), Refusal> {
    begin(pool, |tx| {
        let item = first(
            tx,
            "SELECT i.course_id::text AS course_id, c.state AS course_state, a.item_id IS NOT NULL AS briefed, \
               a.withdrawn_at IS NOT NULL AS withdrawn \
             FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id \
             LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
             WHERE i.id = $1::text::uuid AND i.kind = 'assignment' FOR UPDATE OF i",
            &[&input.item_id],
        )?;
        let item = match item {
            Some(i) if cell::<bool>(&i, "briefed")? => i,
            _ => {
                return refuse(
                    "save the assignment brief before its review steps",
                    "academy.assignment_not_found",
                );
            }
        };
        if cell::<bool>(&item, "withdrawn")? {
            return refuse(
                "a withdrawn assignment is not edited",
                "academy.assignment_closed",
            );
        }
        let course_id: String = cell(&item, "course_id")?;
        let course_state: String = cell(&item, "course_state")?;
        let current = first(tx, STEPS, &[&input.item_id])?;
        let revision = current
            .as_ref()
            .map(|c| cell::<i32>(c, "revision"))
            .transpose()?
            .map_or(0, i64::from);
        if revision != input.revision {
            return refuse(
                format!(
                    "the review steps are at revision {revision}, not {}",
                    input.revision
                ),
                "academy.revision_stale",
            );
        }
        if input.peer && input.peer_count.is_none() && course_state == "published" {
            return refuse(
                "peer review needs how many reviews each learner gives",
                "academy.peer_count_unset",
            );
        }
        if (input.peer || input.self_review) && input.criteria.is_empty() {
            return refuse(
                "a peer or self review needs a rubric with at least one criterion",
                "academy.rubric_invalid",
            );
        }
        let names: std::collections::BTreeSet<String> = input
            .criteria
            .iter()
            .map(|c| {
                service_kit::schema::js_trim(field_str(c, "name").unwrap_or("")).to_lowercase()
            })
            .collect();
        if names.len() != input.criteria.len() {
            return refuse("two criteria have the same name", "academy.rubric_invalid");
        }
        let mut rubric_id: Option<String> = current
            .as_ref()
            .map(|c| cell(c, "rubric_id"))
            .transpose()?
            .flatten();
        let stored = current
            .as_ref()
            .map(|c| json_cell(c, "criteria"))
            .transpose()?
            .flatten();
        let criteria = Json::Array(input.criteria.to_vec());
        if input.criteria.is_empty() {
            rubric_id = None;
        } else if stored
            .as_ref()
            .is_none_or(|s| !deep_strict_equal(s, &criteria))
        {
            let rubric = one(
                tx,
                "INSERT INTO academy.assignment_rubrics (course_id, criteria, created_by, created_at) \
                 VALUES ($1::text::uuid, $2::text::jsonb, $3::text::uuid, $4::text::timestamptz) RETURNING id::text AS id",
                &[&course_id, &criteria.compact(), &operator, &iso(now)],
            )?;
            rubric_id = Some(cell(&rubric, "id")?);
        }
        let peer_count = input
            .peer_count
            .map(|n| i32::try_from(n).unwrap_or(i32::MAX));
        exec(
            tx,
            "INSERT INTO academy.assignment_review_steps (item_id, revision, peer, peer_count, self, rubric_id, saved_by, saved_at) \
             VALUES ($1::text::uuid, $2::int4, $3::bool, $4::int4, $5::bool, $6::text::uuid, $7::text::uuid, $8::text::timestamptz) \
             ON CONFLICT (item_id) DO UPDATE SET \
               revision = EXCLUDED.revision, peer = EXCLUDED.peer, peer_count = EXCLUDED.peer_count, self = EXCLUDED.self, \
               rubric_id = EXCLUDED.rubric_id, saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at",
            &[
                &input.item_id,
                &i32::try_from(revision + 1).unwrap_or(i32::MAX),
                &input.peer,
                &peer_count,
                &input.self_review,
                &rubric_id,
                &operator,
                &iso(now),
            ],
        )?;
        Ok(())
    })
}

/// `isDeepStrictEqual(a, b)` over JSON: objects compare by their own keys, in any order.
pub fn deep_strict_equal(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_strict_equal(p, q))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter().all(|(k, v)| {
                    y.iter()
                        .find(|(k2, _)| k2 == k)
                        .is_some_and(|(_, w)| deep_strict_equal(v, w))
                })
        }
        (Json::Number(p), Json::Number(q)) => p.to_bits() == q.to_bits() || (p == q && *p != 0.0),
        _ => a == b,
    }
}

/// `openTask(tx, itemId, userId, kind)`.
fn open_task<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    user_id: &str,
    kind: &str,
) -> Result<Option<Json>, Refusal> {
    let pair = if kind == "self" {
        "r.author_id = r.reviewer_id"
    } else {
        "r.author_id <> r.reviewer_id"
    };
    let row = first(
        c,
        &format!(
            "SELECT r.id::text AS id, b.criteria::text AS criteria, s.text, f.file_name, f.content_type, f.bytes::int8 AS bytes, \
               (SELECT count(*) FROM academy.assignment_reviews o \
                 WHERE o.item_id = r.item_id AND o.reviewer_id = r.reviewer_id AND o.author_id <> o.reviewer_id \
                   AND o.allocated_at <= r.allocated_at)::int AS ordinal \
             FROM academy.assignment_reviews r \
             JOIN academy.assignment_rubrics b ON b.id = r.rubric_id \
             JOIN academy.assignment_submissions s ON s.item_id = r.item_id AND s.user_id = r.author_id AND s.version = r.version \
             LEFT JOIN academy.assignment_files f ON f.id = s.file_id \
             WHERE r.item_id = $1::text::uuid AND r.reviewer_id = $2::text::uuid AND r.marks IS NULL AND {pair} \
             ORDER BY r.allocated_at, r.id LIMIT 1"
        ),
        &[&item_id, &user_id],
    )?;
    let Some(row) = row else { return Ok(None) };
    let file_name: Option<String> = cell(&row, "file_name")?;
    let file = match file_name {
        None => Json::Null,
        Some(name) => Json::obj([
            (
                "fileName",
                if kind == "self" {
                    Json::String(name)
                } else {
                    Json::Null
                },
            ),
            ("contentType", Json::String(cell(&row, "content_type")?)),
            ("bytes", int(cell(&row, "bytes")?)),
        ]),
    };
    Ok(Some(Json::obj([
        ("id", Json::String(cell(&row, "id")?)),
        ("kind", Json::str(kind)),
        (
            "ordinal",
            if kind == "self" {
                Json::Null
            } else {
                int(i64::from(cell::<i32>(&row, "ordinal")?))
            },
        ),
        ("text", opt_str(cell(&row, "text")?)),
        ("file", file),
        (
            "criteria",
            json_cell(&row, "criteria")?.unwrap_or(Json::Null),
        ),
    ])))
}

/// `handOut(...)`: a second hand-out of the same pair is the same row.
fn hand_out<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    reviewer: &str,
    author: &str,
    version: i32,
    rubric: &str,
    now: i64,
) -> Result<(), Refusal> {
    exec(
        c,
        "INSERT INTO academy.assignment_reviews (item_id, reviewer_id, author_id, version, rubric_id, allocated_at) \
         VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::int4, $5::text::uuid, $6::text::timestamptz) \
         ON CONFLICT (item_id, reviewer_id, author_id) DO NOTHING",
        &[&item_id, &reviewer, &author, &version, &rubric, &iso(now)],
    )?;
    Ok(())
}

/// `stateIn(tx, itemId, userId, now)`.
pub fn state_in<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    user_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    learner_row(c, item_id, user_id, false, now)?;
    let key = format!("peer:{item_id}");
    query(
        c,
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&key],
    )?;
    let steps = first(
        c,
        "SELECT revision, peer, peer_count, self, rubric_id::text AS rubric_id FROM academy.assignment_review_steps WHERE item_id = $1::text::uuid",
        &[&item_id],
    )?;
    let peer = steps
        .as_ref()
        .map(|s| cell::<bool>(s, "peer"))
        .transpose()?
        .unwrap_or(false);
    let self_review = steps
        .as_ref()
        .map(|s| cell::<bool>(s, "self"))
        .transpose()?
        .unwrap_or(false);
    let peer_count: Option<i32> = steps
        .as_ref()
        .map(|s| cell(s, "peer_count"))
        .transpose()?
        .flatten();
    let rubric_id: Option<String> = steps
        .as_ref()
        .map(|s| cell(s, "rubric_id"))
        .transpose()?
        .flatten();
    let done = one(
        c,
        "SELECT count(*) FILTER (WHERE author_id <> $2::text::uuid AND marks IS NOT NULL)::int AS peer_done, \
           bool_or(author_id = $2::text::uuid AND marks IS NOT NULL) IS TRUE AS self_done \
         FROM academy.assignment_reviews WHERE item_id = $1::text::uuid AND reviewer_id = $2::text::uuid",
        &[&item_id, &user_id],
    )?;
    let peer_done = i64::from(cell::<i32>(&done, "peer_done")?);
    let self_done: bool = cell(&done, "self_done")?;
    let at = |stage: &str, task: Option<Json>| {
        Json::obj([
            ("itemId", Json::str(item_id)),
            ("stage", Json::str(stage)),
            ("peer", Json::Bool(peer)),
            ("peerCount", opt_int(peer_count.map(i64::from))),
            ("self", Json::Bool(self_review)),
            ("peerDone", int(peer_done)),
            ("selfDone", Json::Bool(self_done)),
            ("task", task.unwrap_or(Json::Null)),
        ])
    };
    let Some(rubric) = rubric_id.filter(|_| steps.is_some() && (peer || self_review)) else {
        return Ok(at("off", None));
    };
    let mine: Option<i32> = cell(
        &one(
            c,
            "SELECT max(version)::int AS version FROM academy.assignment_submissions \
             WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid AND state <> 'withdrawn'",
            &[&item_id, &user_id],
        )?,
        "version",
    )?;
    let Some(mine) = mine else {
        return Ok(at("hand_in_first", None));
    };
    if peer {
        let Some(count) = peer_count else {
            return refuse(
                "peer review has no review count set",
                "academy.peer_count_unset",
            );
        };
        if peer_done < i64::from(count) {
            if let Some(open) = open_task(c, item_id, user_id, "peer")? {
                return Ok(at("peer", Some(open)));
            }
            let author = first(
                c,
                "WITH latest AS ( \
                   SELECT DISTINCT ON (user_id) user_id, version FROM academy.assignment_submissions \
                   WHERE item_id = $1::text::uuid AND state <> 'withdrawn' ORDER BY user_id, version DESC \
                 ) \
                 SELECT l.user_id::text AS user_id, l.version FROM latest l \
                 WHERE l.user_id <> $2::text::uuid \
                   AND NOT EXISTS (SELECT 1 FROM academy.assignment_reviews x \
                     WHERE x.item_id = $1::text::uuid AND x.reviewer_id = $2::text::uuid AND x.author_id = l.user_id) \
                 ORDER BY \
                   (SELECT count(*) FROM academy.assignment_reviews r \
                     WHERE r.item_id = $1::text::uuid AND r.author_id = l.user_id AND r.reviewer_id <> l.user_id), \
                   (SELECT min(submitted_at) FROM academy.assignment_submissions f WHERE f.item_id = $1::text::uuid AND f.user_id = l.user_id), \
                   l.user_id \
                 LIMIT 1",
                &[&item_id, &user_id],
            )?;
            let Some(author) = author else {
                return Ok(at("waiting", None));
            };
            let author_id: String = cell(&author, "user_id")?;
            hand_out(
                c,
                item_id,
                user_id,
                &author_id,
                cell(&author, "version")?,
                &rubric,
                now,
            )?;
            return Ok(at("peer", open_task(c, item_id, user_id, "peer")?));
        }
    }
    if self_review && !self_done {
        if let Some(open) = open_task(c, item_id, user_id, "self")? {
            return Ok(at("self", Some(open)));
        }
        hand_out(c, item_id, user_id, user_id, mine, &rubric, now)?;
        return Ok(at("self", open_task(c, item_id, user_id, "self")?));
    }
    Ok(at("done", None))
}

/// `state(input)`.
pub fn state(pool: &Store, item_id: &str, user_id: &str, now: i64) -> Result<Json, Refusal> {
    begin(pool, |tx| state_in(tx, item_id, user_id, now))
}

/// `submit(input)`: one review's marks, then the learner's next stage.
pub fn submit(
    pool: &Store,
    item_id: &str,
    task_id: &str,
    marks: &[String],
    user_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        learner_row(tx, item_id, user_id, false, now)?;
        let task = first(
            tx,
            "SELECT r.id::text AS id, r.marks::text AS marks, b.criteria::text AS criteria \
             FROM academy.assignment_reviews r JOIN academy.assignment_rubrics b ON b.id = r.rubric_id \
             WHERE r.id = $1::text::uuid AND r.item_id = $2::text::uuid AND r.reviewer_id = $3::text::uuid FOR UPDATE OF r",
            &[&task_id, &item_id, &user_id],
        )?;
        let Some(task) = task else {
            return refuse(
                "no review of yours with that id",
                "academy.review_task_not_found",
            );
        };
        let given = Json::Array(marks.iter().cloned().map(Json::String).collect());
        if let Some(stored) = json_cell(&task, "marks")? {
            if deep_strict_equal(&stored, &given) {
                return state_in(tx, item_id, user_id, now);
            }
            return refuse(
                "this review was already sent with other marks",
                "academy.review_already_sent",
            );
        }
        let criteria = json_cell(&task, "criteria")?.unwrap_or(Json::Null);
        let criteria = array(Some(&criteria));
        let fits = marks.len() == criteria.len()
            && marks.iter().zip(criteria).all(|(m, c)| {
                array(field(c, "levels"))
                    .iter()
                    .any(|l| matches!(l, Json::String(s) if s == m))
            });
        if !fits {
            return refuse(
                "give one of its levels for every criterion of the rubric",
                "academy.review_marks_invalid",
            );
        }
        let id: String = cell(&task, "id")?;
        exec(
            tx,
            "UPDATE academy.assignment_reviews SET marks = $1::text::jsonb, total = $2::text::numeric, reviewed_at = $3::text::timestamptz \
             WHERE id = $4::text::uuid",
            &[&given.compact(), &rubric_total(marks), &iso(now), &id],
        )?;
        state_in(tx, item_id, user_id, now)
    })
}

/// `file(input)`: the file handed to the caller to review, read back from our store and checked against its SHA-256.
pub fn file(
    pool: &Store,
    storage: Option<&StorageConfig>,
    bytes_port: &dyn ObjectBytes,
    item_id: &str,
    task_id: &str,
    user_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let row = with_client(pool, |c| {
        learner_row(c, item_id, user_id, false, now)?;
        first(
            c,
            "SELECT f.object_key, f.sha256, f.content_type, f.bytes::text AS bytes \
             FROM academy.assignment_reviews r \
             JOIN academy.assignment_submissions s ON s.item_id = r.item_id AND s.user_id = r.author_id AND s.version = r.version \
             JOIN academy.assignment_files f ON f.id = s.file_id \
             WHERE r.id = $1::text::uuid AND r.item_id = $2::text::uuid AND r.reviewer_id = $3::text::uuid",
            &[&task_id, &item_id, &user_id],
        )
    })?;
    let Some(row) = row else {
        return refuse(
            "no file in a review of yours with that id",
            "academy.review_task_not_found",
        );
    };
    let Some(storage) = storage.filter(|s| configured(s)) else {
        return refuse(
            "File storage is not configured",
            "academy.video_storage_unconfigured",
        );
    };
    let key: String = cell(&row, "object_key")?;
    let url = presign(storage, "GET", &key, now)?;
    let read = bytes_port.get(&url).ok();
    let body = read
        .filter(|(status, _)| (200..300).contains(status))
        .map(|(_, b)| b);
    let size: String = cell(&row, "bytes")?;
    let sha: String = cell(&row, "sha256")?;
    let whole = body.filter(|b| b.len().to_string() == size && sha256_hex(b) == sha);
    let Some(bytes) = whole else {
        return refuse(
            "the file could not be read back whole from storage; try again",
            "academy.file_unavailable",
        );
    };
    use base64::Engine as _;
    Ok(Json::obj([
        ("contentType", Json::String(cell(&row, "content_type")?)),
        ("bytes", int(i64::try_from(bytes.len()).unwrap_or(i64::MAX))),
        (
            "contentBase64",
            Json::String(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_in_hundredths() {
        assert_eq!(hundredths("1.5"), 150);
        assert_eq!(rubric_total(&["1.5".into(), "2".into()]), "3.5");
        assert_eq!(rubric_total(&["0.25".into(), "0.75".into()]), "1");
        assert_eq!(rubric_total(&["0.05".into()]), "0.05");
        assert_eq!(rubric_total(&["0.1".into()]), "0.1");
    }

    #[test]
    fn deep_equal_ignores_key_order() {
        let a =
            service_kit::json::parse(r#"[{"name":"A","levels":["0","1"]}]"#).unwrap_or(Json::Null);
        let b =
            service_kit::json::parse(r#"[{"levels":["0","1"],"name":"A"}]"#).unwrap_or(Json::Null);
        let c =
            service_kit::json::parse(r#"[{"levels":["0","2"],"name":"A"}]"#).unwrap_or(Json::Null);
        assert!(deep_strict_equal(&a, &b));
        assert!(!deep_strict_equal(&a, &c));
    }
}
