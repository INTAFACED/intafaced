//! Prerequisites between a course's assignments and quizzes, and the learners' moved due dates, as staff see them
//! (`curriculum/course-item-rules.ts` `CourseItemRules.adminView`, `setPrerequisites`). A set that would make an item
//! require itself refuses `academy.prerequisite_cycle` naming the path, and nothing is written. The extension grant is
//! the assessment slice's call; it answers with [`view`].

use postgres::{GenericClient, Transaction};

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::Value;

use super::release::find_cycle;
use super::sql::{self, at, first, get, iso_of, ms, opt_iso_of, query};
use super::{nullable, refuse, text};
use crate::errors::Refusal;

/// `dueFor(briefDue, extended)`: the learner's own due date when staff moved it later, else the brief's.
pub fn due_for(brief: Option<i64>, extended: Option<i64>) -> Option<i64> {
    match (brief, extended) {
        (Some(b), Some(e)) if e > b => Some(e),
        (b, _) => b,
    }
}

fn lock_course(tx: &mut Transaction<'_>, course_id: &str) -> Result<(), Refusal> {
    if first(tx, "SELECT id FROM academy.courses WHERE id = $1::text::uuid FOR UPDATE", &[&course_id])?.is_none() {
        return refuse("no course has that id", "academy.course_not_found");
    }
    Ok(())
}

/// `viewIn`.
pub fn view<C: GenericClient>(c: &mut C, course_id: &str) -> Result<Json, Refusal> {
    if first(c, "SELECT id FROM academy.courses WHERE id = $1::text::uuid", &[&course_id])?.is_none() {
        return refuse("no course has that id", "academy.course_not_found");
    }
    let items = query(
        c,
        &format!(
            "SELECT i.id::text AS id, i.title, i.kind, {} AS due_at, \
               ARRAY(SELECT p.prerequisite_id::text FROM academy.course_item_prerequisites p WHERE p.item_id = i.id ORDER BY p.prerequisite_id) AS prerequisites, \
               ps.reason, ps.set_by::text AS set_by, {} AS set_at \
             FROM academy.course_items i \
             JOIN academy.course_sections s ON s.id = i.section_id \
             LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
             LEFT JOIN academy.course_item_prerequisite_sets ps ON ps.item_id = i.id \
             WHERE i.course_id = $1::text::uuid AND i.kind IN ('assignment', 'quiz') \
             ORDER BY s.position, i.position",
            ms("a.due_at"),
            ms("ps.set_at")
        ),
        &[&course_id],
    )?;
    let extensions = query(
        c,
        &format!(
            "SELECT x.item_id::text AS item_id, x.user_id::text AS user_id, {} AS due_at, x.reason, \
               x.granted_by::text AS granted_by, {} AS granted_at \
             FROM academy.course_item_extensions x JOIN academy.course_items i ON i.id = x.item_id \
             WHERE i.course_id = $1::text::uuid ORDER BY x.granted_at DESC, x.user_id",
            ms("x.due_at"),
            ms("x.granted_at")
        ),
        &[&course_id],
    )?;
    let items = items
        .iter()
        .map(|i| {
            Ok(Json::obj([
                ("itemId", Json::String(get(i, "id")?)),
                ("title", Json::String(get(i, "title")?)),
                ("kind", Json::String(get(i, "kind")?)),
                ("dueAt", nullable(opt_iso_of(i, "due_at")?)),
                (
                    "prerequisites",
                    Json::Array(get::<Vec<String>>(i, "prerequisites")?.into_iter().map(Json::String).collect()),
                ),
                ("setBy", nullable(get(i, "set_by")?)),
                ("setAt", nullable(opt_iso_of(i, "set_at")?)),
                ("reason", nullable(get(i, "reason")?)),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    let extensions = extensions
        .iter()
        .map(|x| {
            Ok(Json::obj([
                ("itemId", Json::String(get(x, "item_id")?)),
                ("userId", Json::String(get(x, "user_id")?)),
                ("dueAt", Json::String(iso_of(x, "due_at")?)),
                ("reason", Json::String(get(x, "reason")?)),
                ("grantedBy", Json::String(get(x, "granted_by")?)),
                ("grantedAt", Json::String(iso_of(x, "granted_at")?)),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Json::obj([
        ("courseId", Json::str(course_id)),
        ("items", Json::Array(items)),
        ("extensions", Json::Array(extensions)),
    ]))
}

pub fn admin_view(pool: &Pool, course_id: &str) -> Result<Json, Refusal> {
    sql::client(pool, |c| view(c, course_id))
}

fn gated(kind: &str) -> bool {
    kind == "assignment" || kind == "quiz"
}

/// `setPrerequisites`.
pub fn set_prerequisites(pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
    let course_id = text(input, "courseId");
    let item_id = text(input, "itemId");
    let reason = text(input, "reason");
    let mut wanted: Vec<String> = input
        .get("prerequisiteIds")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    wanted.sort();
    wanted.dedup();
    sql::begin(pool, |tx| {
        lock_course(tx, course_id)?;
        let items: Vec<(String, String, bool)> = query(
            tx,
            "SELECT i.id::text AS id, i.kind, \
               CASE i.kind \
                 WHEN 'assignment' THEN EXISTS (SELECT 1 FROM academy.course_assignments a WHERE a.item_id = i.id AND a.withdrawn_at IS NULL) \
                 WHEN 'quiz' THEN EXISTS (SELECT 1 FROM academy.course_quizzes q WHERE q.item_id = i.id) \
                 ELSE false \
               END AS completable \
             FROM academy.course_items i WHERE i.course_id = $1::text::uuid",
            &[&course_id],
        )?
        .iter()
        .map(|r| Ok((get(r, "id")?, get(r, "kind")?, get::<Option<bool>>(r, "completable")? == Some(true))))
        .collect::<Result<_, Refusal>>()?;
        let kind_of = |id: &str| items.iter().find(|(i, _, _)| i == id).map(|(_, k, c)| (k.as_str(), *c));
        if !kind_of(item_id).is_some_and(|(k, _)| gated(k)) {
            return refuse("no assignment or quiz of this course has that id", "academy.outline_item_unknown");
        }
        for id in &wanted {
            let Some((kind, completable)) = kind_of(id) else {
                return refuse(format!("no item of this course has the id {id}"), "academy.outline_item_unknown");
            };
            if id == item_id {
                return refuse(format!("academy.prerequisite_cycle path={id}>{id}"), "academy.prerequisite_cycle");
            }
            if !gated(kind) {
                return refuse(
                    format!("a {kind} records no completion on a course staff made, so it cannot be required"),
                    "academy.prerequisite_unmeasured",
                );
            }
            if !completable {
                return refuse(
                    format!("item {id} has no saved brief or quiz (or was withdrawn), so no learner can finish it yet"),
                    "academy.prerequisite_unmeasured",
                );
            }
        }
        let stored = query(
            tx,
            "SELECT p.item_id::text AS item_id, p.prerequisite_id::text AS prerequisite_id FROM academy.course_item_prerequisites p \
             JOIN academy.course_items i ON i.id = p.item_id WHERE i.course_id = $1::text::uuid",
            &[&course_id],
        )?;
        // A Map in insertion order: item → its prerequisites.
        let mut edges: Vec<(String, Vec<String>)> = Vec::new();
        for e in &stored {
            let from: String = get(e, "item_id")?;
            let to: String = get(e, "prerequisite_id")?;
            match edges.iter_mut().find(|(k, _)| *k == from) {
                Some((_, v)) => v.push(to),
                None => edges.push((from, vec![to])),
            }
        }
        let mut current = edges.iter().find(|(k, _)| k == item_id).map(|(_, v)| v.clone()).unwrap_or_default();
        current.sort();
        if current == wanted {
            return view(tx, course_id);
        }
        edges.retain(|(k, _)| k != item_id);
        let flat: Vec<(String, String)> = std::iter::once((item_id.to_owned(), wanted.clone()))
            .chain(edges)
            .flat_map(|(from, to)| to.into_iter().map(move |t| (from.clone(), t)))
            .collect();
        if let Some(cycle) = find_cycle(&flat) {
            return refuse(format!("academy.prerequisite_cycle path={}", cycle.join(">")), "academy.prerequisite_cycle");
        }
        sql::exec(tx, "DELETE FROM academy.course_item_prerequisites WHERE item_id = $1::text::uuid", &[&item_id])?;
        if !wanted.is_empty() {
            sql::exec(
                tx,
                "INSERT INTO academy.course_item_prerequisites (item_id, prerequisite_id) \
                 SELECT $1::text::uuid, p::uuid FROM unnest($2::text[]) WITH ORDINALITY AS u(p, n) ORDER BY n",
                &[&item_id, &wanted],
            )?;
        }
        sql::exec(
            tx,
            "INSERT INTO academy.course_item_prerequisite_sets (item_id, reason, set_by, set_at) \
             VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text::timestamptz) \
             ON CONFLICT (item_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
            &[&item_id, &reason, &operator, &at(now)],
        )?;
        let detail = Json::obj([("prerequisites", Json::Array(wanted.iter().map(Json::str).collect()))]).compact();
        sql::exec(
            tx,
            "INSERT INTO academy.course_item_rule_events (item_id, kind, user_id, detail, reason, actor_id, at) \
             VALUES ($1::text::uuid, 'prerequisites', null, $2::text::jsonb, $3::text, $4::text::uuid, $5::text::timestamptz)",
            &[&item_id, &detail, &reason, &operator, &at(now)],
        )?;
        view(tx, course_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_moved_date_wins() {
        assert_eq!(due_for(Some(10), Some(20)), Some(20));
        assert_eq!(due_for(Some(10), Some(5)), Some(10));
        assert_eq!(due_for(None, Some(5)), None);
        assert_eq!(due_for(Some(10), None), Some(10));
    }
}
