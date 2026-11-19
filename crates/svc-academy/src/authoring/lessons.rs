//! Lesson content (`curriculum/lessons.ts` `LessonRecords`): ordered blocks, one revision per save, a revert copying an
//! older revision, a publish moving what learners see, a withdrawal, a duplicate of an item, a lesson file import and the
//! template assistant draft. Every lesson change locks the course row; a save or revert is keyed by the revision it
//! makes, so a repeat after a lost reply answers with its own revision.

use postgres::{GenericClient, Transaction};

use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::schema::{Value, js_trim};

use super::courses::CourseRecords;
use super::sql::{self, at, first, get, iso_of, ms, opt_int, query};
use super::{nullable, nullable_int, refuse, text};
use crate::door::inputs;
use crate::errors::Refusal;

const REVISIONS_SHOWN: i64 = 50;
const NEIGHBOURS_SHOWN: usize = 50;
/// `ACADEMY_LESSON_FORMAT`.
pub const FORMAT: &str = "intafaced.lesson.v1";
const BLOCK_TYPES: [&str; 5] = ["text", "image", "audio", "pdf", "code"];

fn internal(message: impl Into<String>) -> Refusal {
    Refusal::Internal {
        message: message.into(),
        code: None,
    }
}

/// The recorded `academyLessonBlocksSchema` (the `blocks` of `admin.saveLesson`) and its element.
fn blocks_part() -> Result<usize, Refusal> {
    inputs::field_part("admin.saveLesson", "blocks")
        .map_err(internal)?
        .ok_or_else(|| internal("no recorded lesson blocks schema"))
}

fn block_part() -> Result<usize, Refusal> {
    inputs::element_part(blocks_part()?)
        .map_err(internal)?
        .ok_or_else(|| internal("no recorded lesson block schema"))
}

/// Blocks as the output schema gives them back (its key order, its trims).
fn as_output(blocks: &Json) -> Result<Json, Refusal> {
    match inputs::parse_part(blocks_part()?, Value::from_json(blocks)).map_err(internal)? {
        Ok(v) => Ok(v.to_json().unwrap_or(Json::Null)),
        Err(r) => Err(internal(format!("Output validation failed: {}", r.message()))),
    }
}

/// `checkBlocks`: stored blocks must read back.
fn check_blocks(blocks: &Json) -> Result<(), Refusal> {
    match inputs::parse_part(blocks_part()?, Value::from_json(blocks)).map_err(internal)? {
        Ok(_) => Ok(()),
        Err(inputs::Refused::Issues(i)) => refuse(
            format!(
                "the lesson blocks do not fit the lesson format: {}",
                i.first().map_or("invalid", |x| x.message())
            ),
            "academy.lesson_blocks_invalid",
        ),
        Err(inputs::Refused::Thrown(m)) => Err(internal(m)),
    }
}

/// `canonical`: keys sorted, so jsonb's key order does not matter.
fn canonical(v: &Json) -> String {
    match v {
        Json::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Json::Object(o) => {
            let mut keys: Vec<&(String, Json)> = o.iter().collect();
            keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|(k, v)| format!("{}:{}", Json::str(k.clone()).compact(), canonical(v)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.compact(),
    }
}

fn same_blocks(a: &Json, b: &Json) -> bool {
    canonical(a) == canonical(b)
}

fn js_slice(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<_>>())
}

/// `templateDraft`: the lesson's place and headings for a person to fill in; it states nothing as fact.
pub fn template_draft(course_title: &str, section_title: &str, item_title: &str, neighbours: &[String]) -> Json {
    let text = |m: String| Json::obj([("type", Json::str("text")), ("markdown", Json::String(m))]);
    let mut blocks = vec![
        text(format!("# {item_title}\n\nPart of “{section_title}” in “{course_title}”.")),
        text("## What you will be able to do\n\n(Write the one thing a learner can do after this lesson.)".to_owned()),
        text("## The idea\n\n(Explain the idea in your own words, with one example.)".to_owned()),
        text("## Try it\n\n(Write one short practice step.)".to_owned()),
    ];
    if !neighbours.is_empty() {
        let mut shown: Vec<String> = neighbours.iter().take(NEIGHBOURS_SHOWN).map(|t| format!("- {t}")).collect();
        if neighbours.len() > NEIGHBOURS_SHOWN {
            shown.push(format!("- and {} more", neighbours.len() - NEIGHBOURS_SHOWN));
        }
        blocks.push(text(format!("## In this section\n\n{}", shown.join("\n"))));
    }
    Json::Array(blocks)
}

/// One problem a lesson file has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub block: Option<i64>,
    pub problem: String,
}

fn whole(problem: String) -> Vec<Problem> {
    vec![Problem { block: None, problem }]
}

fn path_text(p: &Json) -> String {
    match p {
        Json::String(s) => s.clone(),
        Json::Number(n) => json::js_number_string(*n),
        other => other.compact(),
    }
}

/// `checkLessonFile`: parsed as data only; every problem is named.
pub fn check_lesson_file(document: &str) -> Result<Result<Json, Vec<Problem>>, Refusal> {
    let Ok(parsed) = json::parse(document) else {
        return Ok(Err(whole("the file is not JSON".to_owned())));
    };
    let Json::Object(_) = &parsed else {
        return Ok(Err(whole(format!("the file is not an {FORMAT} lesson"))));
    };
    if parsed.get("format") != Some(&Json::str(FORMAT)) {
        return Ok(Err(whole(format!("the file is not an {FORMAT} lesson"))));
    }
    let raw = match parsed.get("blocks") {
        Some(Json::Array(a)) if !a.is_empty() && a.len() <= 200 => a.clone(),
        _ => return Ok(Err(whole("a lesson file has 1 to 200 blocks".to_owned()))),
    };
    let part = block_part()?;
    let mut problems = Vec::new();
    let mut blocks = Vec::new();
    for (i, b) in raw.iter().enumerate() {
        let n = i64::try_from(i + 1).unwrap_or(i64::MAX);
        let ty = match b {
            Json::Object(_) => b.get("type").cloned(),
            Json::Array(_) => None,
            _ => None,
        };
        let known = matches!(&ty, Some(Json::String(t)) if BLOCK_TYPES.contains(&t.as_str()));
        if !known {
            let shown = ty.unwrap_or(Json::Null).compact();
            problems.push(Problem {
                block: Some(n),
                problem: format!("unknown block type {}", js_slice(&shown, 40)),
            });
            continue;
        }
        let t = ty.as_ref().map(path_text).unwrap_or_default();
        match inputs::parse_part(part, Value::from_json(b)).map_err(internal)? {
            Ok(v) => blocks.push(v.to_json().unwrap_or(Json::Null)),
            Err(inputs::Refused::Issues(issues)) => problems.push(Problem {
                block: Some(n),
                problem: format!(
                    "a {t} block with {} not valid",
                    issues
                        .iter()
                        .map(|x| if x.path().is_empty() {
                            x.message().to_owned()
                        } else {
                            x.path().iter().map(path_text).collect::<Vec<_>>().join(".")
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            }),
            Err(inputs::Refused::Thrown(m)) => return Err(internal(m)),
        }
    }
    Ok(if problems.is_empty() { Ok(Json::Array(blocks)) } else { Err(problems) })
}

/// The item and its course, as `lockItem` reads them.
struct Item {
    id: String,
    course_id: String,
    section_id: String,
    position: i64,
    kind: String,
    title: String,
    indent: i64,
    url: Option<String>,
    live_revision: Option<i64>,
    live_course_revision: Option<i64>,
    course_state: String,
    course_revision: i64,
}

/// A stored revision.
struct Revision {
    revision: i64,
    source: String,
    from_revision: Option<i64>,
    from_item_id: Option<String>,
    blocks: Json,
    actor: String,
    at: String,
}

const REVISION_COLS: &str = "revision, source, from_revision, from_item_id::text AS from_item_id, blocks::text AS blocks, actor::text AS actor";

fn parse_json(text: &str) -> Result<Json, Refusal> {
    json::parse(text).map_err(|e| internal(e.message))
}

fn revision_of(r: &postgres::Row) -> Result<Revision, Refusal> {
    Ok(Revision {
        revision: sql::int(r, "revision")?,
        source: get(r, "source")?,
        from_revision: opt_int(r, "from_revision")?,
        from_item_id: get(r, "from_item_id")?,
        blocks: parse_json(&get::<String>(r, "blocks")?)?,
        actor: get(r, "actor")?,
        at: iso_of(r, "at")?,
    })
}

fn lock_item(tx: &mut Transaction<'_>, item_id: &str, holds_lesson: bool) -> Result<Item, Refusal> {
    let Some(r) = first(
        tx,
        "SELECT i.id::text AS id, i.course_id::text AS course_id, i.section_id::text AS section_id, i.position, i.kind, i.title, \
           i.indent, i.url, i.live_revision, i.live_course_revision, c.state AS course_state, c.revision AS course_revision \
         FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id \
         WHERE i.id = $1::text::uuid FOR UPDATE OF c, i",
        &[&item_id],
    )?
    else {
        return refuse("no outline item with that id", "academy.outline_item_unknown");
    };
    let kind: String = get(&r, "kind")?;
    if holds_lesson && (kind == "subheader" || kind == "link") {
        return refuse(format!("a {kind} holds no lesson"), "academy.item_has_no_lesson");
    }
    Ok(Item {
        id: get(&r, "id")?,
        course_id: get(&r, "course_id")?,
        section_id: get(&r, "section_id")?,
        position: sql::int(&r, "position")?,
        kind,
        title: get(&r, "title")?,
        indent: sql::int(&r, "indent")?,
        url: get(&r, "url")?,
        live_revision: opt_int(&r, "live_revision")?,
        live_course_revision: opt_int(&r, "live_course_revision")?,
        course_state: get(&r, "course_state")?,
        course_revision: sql::int(&r, "course_revision")?,
    })
}

fn newest<C: GenericClient>(c: &mut C, item_id: &str) -> Result<Option<Revision>, Refusal> {
    first(
        c,
        &format!(
            "SELECT {REVISION_COLS}, {} AS at FROM academy.lesson_revisions WHERE item_id = $1::text::uuid ORDER BY revision DESC LIMIT 1",
            ms("at")
        ),
        &[&item_id],
    )?
    .map(|r| revision_of(&r))
    .transpose()
}

#[expect(clippy::too_many_arguments, reason = "one lesson revision row: its columns, as the TypeScript inserts them")]
fn insert(
    tx: &mut Transaction<'_>,
    item_id: &str,
    revision: i64,
    source: &str,
    from_revision: Option<i64>,
    from_item_id: Option<&str>,
    blocks: &Json,
    actor: &str,
    now: i64,
) -> Result<(), Refusal> {
    check_blocks(blocks)?;
    let rev = i32::try_from(revision).unwrap_or(i32::MAX);
    let from = from_revision.map(|f| i32::try_from(f).unwrap_or(i32::MAX));
    sql::exec(
        tx,
        "INSERT INTO academy.lesson_revisions (item_id, revision, source, from_revision, from_item_id, blocks, actor, at) \
         VALUES ($1::text::uuid, $2::int4, $3::text, $4::int4, $5::text::uuid, $6::text::jsonb, $7::text::uuid, $8::text::timestamptz)",
        &[&item_id, &rev, &source, &from, &from_item_id, &blocks.compact(), &actor, &at(now)],
    )?;
    Ok(())
}

/// `courseEvent`: the course revision moves on and an event names who and why.
fn course_event(tx: &mut Transaction<'_>, item: &Item, kind: &str, actor: &str, reason: Option<&str>, now: i64) -> Result<i64, Refusal> {
    let next = first(
        tx,
        "UPDATE academy.courses SET revision = revision + 1, updated_at = $2::text::timestamptz WHERE id = $1::text::uuid RETURNING revision",
        &[&item.course_id, &at(now)],
    )?
    .ok_or_else(|| internal("the locked course row was not returned"))?;
    let next = sql::int(&next, "revision")?;
    let rev = i32::try_from(next).unwrap_or(i32::MAX);
    sql::exec(
        tx,
        "INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at) \
         VALUES ($1::text::uuid, $2::int4, $3::text, $4::text, $4::text, $5::text::uuid, $6::text, $7::text::timestamptz)",
        &[&item.course_id, &rev, &kind, &item.course_state, &actor, &reason, &at(now)],
    )?;
    Ok(next)
}

fn stale(newest: Option<&Revision>, revision: i64) -> Result<(), Refusal> {
    let at = newest.map_or(0, |n| n.revision);
    if at != revision {
        return refuse(format!("lesson is at revision {at}, not {revision}"), "academy.revision_stale");
    }
    Ok(())
}

fn course_stale(item: &Item, revision: i64) -> Result<(), Refusal> {
    if item.course_revision != revision {
        return refuse(
            format!("course is at revision {}, not {revision}", item.course_revision),
            "academy.course_revision_stale",
        );
    }
    Ok(())
}

/// Whether this operator's own event at the item's course revision is `kind`.
fn own_course_event(tx: &mut Transaction<'_>, item: &Item, actor: &str, kind: &str) -> Result<bool, Refusal> {
    let rev = i32::try_from(item.course_revision).unwrap_or(i32::MAX);
    Ok(first(
        tx,
        "SELECT kind FROM academy.course_events WHERE course_id = $1::text::uuid AND revision = $2::int4 AND actor = $3::text::uuid",
        &[&item.course_id, &rev, &actor],
    )?
    .map(|r| get::<String>(&r, "kind"))
    .transpose()?
    .as_deref()
        == Some(kind))
}

/// `LessonRecords`.
pub struct Lessons<'a> {
    pub pool: &'a Pool,
    pub courses: &'a CourseRecords,
    pub import_max_bytes: Option<i64>,
}

impl Lessons<'_> {
    /// `read`: the item, the newest revisions with the live one, and an open draft of the newest revision.
    fn read<C: GenericClient>(&self, c: &mut C, item_id: &str) -> Result<Json, Refusal> {
        let row = first(
            c,
            "SELECT i.id::text AS id, i.course_id::text AS course_id, i.kind, i.title, i.indent, i.url, i.live_revision, \
               c.state AS course_state, c.revision AS course_revision, c.title AS course_title, \
               (SELECT max(r.revision) FROM academy.lesson_revisions r WHERE r.item_id = i.id) AS lesson_revision, \
               EXISTS (SELECT 1 FROM academy.featured_items f WHERE f.course_item_id = i.id) AS featured \
             FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id WHERE i.id = $1::text::uuid",
            &[&item_id],
        )?;
        let revisions = query(
            c,
            &format!(
                "SELECT * FROM ( \
                   (SELECT {REVISION_COLS}, {at} AS at FROM academy.lesson_revisions WHERE item_id = $1::text::uuid ORDER BY revision DESC LIMIT $2::int8) \
                   UNION \
                   (SELECT r.revision, r.source, r.from_revision, r.from_item_id::text AS from_item_id, r.blocks::text AS blocks, r.actor::text AS actor, {rat} AS at \
                    FROM academy.lesson_revisions r JOIN academy.course_items i ON i.id = r.item_id AND i.live_revision = r.revision \
                    WHERE r.item_id = $1::text::uuid) \
                 ) u ORDER BY revision DESC",
                at = ms("at"),
                rat = ms("r.at")
            ),
            &[&item_id, &REVISIONS_SHOWN],
        )?;
        let draft = first(
            c,
            &format!(
                "SELECT d.based_on_revision, d.kind, d.blocks::text AS blocks, d.created_by::text AS created_by, {} AS created_at \
                 FROM academy.lesson_drafts d WHERE d.item_id = $1::text::uuid AND d.state = 'open' \
                   AND d.based_on_revision = COALESCE((SELECT max(r.revision) FROM academy.lesson_revisions r WHERE r.item_id = d.item_id), 0) \
                 ORDER BY d.created_at DESC LIMIT 1",
                ms("d.created_at")
            ),
            &[&item_id],
        )?;
        let Some(row) = row else {
            return refuse("no outline item with that id", "academy.outline_item_unknown");
        };
        let revisions = revisions
            .iter()
            .map(|r| {
                let v = revision_of(r)?;
                Ok(Json::obj([
                    ("revision", Json::int(v.revision)),
                    ("source", Json::String(v.source)),
                    ("fromRevision", nullable_int(v.from_revision)),
                    ("fromItemId", nullable(v.from_item_id)),
                    ("blocks", as_output(&v.blocks)?),
                    ("actor", Json::String(v.actor)),
                    ("at", Json::String(v.at)),
                ]))
            })
            .collect::<Result<Vec<_>, Refusal>>()?;
        let draft = match draft {
            None => Json::Null,
            Some(d) => Json::obj([
                ("basedOnRevision", Json::int(sql::int(&d, "based_on_revision")?)),
                ("kind", Json::String(get(&d, "kind")?)),
                ("blocks", as_output(&parse_json(&get::<String>(&d, "blocks")?)?)?),
                ("createdBy", Json::String(get(&d, "created_by")?)),
                ("createdAt", Json::String(iso_of(&d, "created_at")?)),
            ]),
        };
        Ok(Json::obj([
            ("courseId", Json::String(get(&row, "course_id")?)),
            ("courseTitle", Json::String(get(&row, "course_title")?)),
            ("courseState", Json::String(get(&row, "course_state")?)),
            ("courseRevision", Json::int(sql::int(&row, "course_revision")?)),
            (
                "item",
                Json::obj([
                    ("id", Json::String(get(&row, "id")?)),
                    ("kind", Json::String(get(&row, "kind")?)),
                    ("title", Json::String(get(&row, "title")?)),
                    ("indent", Json::int(sql::int(&row, "indent")?)),
                    ("url", nullable(get(&row, "url")?)),
                    ("lessonRevision", nullable_int(opt_int(&row, "lesson_revision")?)),
                    ("liveRevision", nullable_int(opt_int(&row, "live_revision")?)),
                ]),
            ),
            ("revisions", Json::Array(revisions)),
            ("importMaxBytes", nullable_int(self.import_max_bytes)),
            ("draft", draft),
            ("featured", Json::Bool(get(&row, "featured")?)),
        ]))
    }

    pub fn get(&self, item_id: &str) -> Result<Json, Refusal> {
        sql::client(self.pool, |c| self.read(c, item_id))
    }

    pub fn save(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let revision = super::int(input, "revision");
        let blocks = input.get("blocks").to_json().unwrap_or(Json::Null);
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), true)?;
            let n = newest(tx, &item.id)?;
            if let Some(v) = &n
                && v.revision == revision + 1
                && v.source == "saved"
                && v.actor == operator
                && same_blocks(&v.blocks, &blocks)
            {
                return self.read(tx, &item.id);
            }
            stale(n.as_ref(), revision)?;
            insert(tx, &item.id, revision + 1, "saved", None, None, &blocks, operator, now)?;
            self.read(tx, &item.id)
        })
    }

    pub fn revert(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let revision = super::int(input, "revision");
        let to = super::int(input, "toRevision");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), true)?;
            let n = newest(tx, &item.id)?;
            if let Some(v) = &n
                && v.revision == revision + 1
                && v.source == "reverted"
                && v.from_revision == Some(to)
                && v.actor == operator
            {
                return self.read(tx, &item.id);
            }
            stale(n.as_ref(), revision)?;
            let to4 = i32::try_from(to).unwrap_or(i32::MAX);
            let Some(old) = first(
                tx,
                &format!(
                    "SELECT {REVISION_COLS}, {} AS at FROM academy.lesson_revisions WHERE item_id = $1::text::uuid AND revision = $2::int4",
                    ms("at")
                ),
                &[&item.id, &to4],
            )?
            else {
                return refuse(format!("the lesson has no revision {to}"), "academy.lesson_revision_unknown");
            };
            let old = revision_of(&old)?;
            insert(tx, &item.id, revision + 1, "reverted", Some(to), None, &old.blocks, operator, now)?;
            self.read(tx, &item.id)
        })
    }

    pub fn publish(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let course_revision = super::int(input, "courseRevision");
        let lesson_revision = super::int(input, "lessonRevision");
        let reason = text(input, "reason");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), true)?;
            if item.course_revision == course_revision + 1
                && item.live_revision == Some(lesson_revision)
                && item.live_course_revision == Some(item.course_revision)
                && own_course_event(tx, &item, operator, "lesson")?
            {
                return self.read(tx, &item.id);
            }
            course_stale(&item, course_revision)?;
            let lr = i32::try_from(lesson_revision).unwrap_or(i32::MAX);
            let exists = first(
                tx,
                "SELECT revision FROM academy.lesson_revisions WHERE item_id = $1::text::uuid AND revision = $2::int4",
                &[&item.id, &lr],
            )?;
            if item.course_state != "draft" && item.course_state != "published" {
                return refuse(format!("a {} course's lessons are not published", item.course_state), "academy.course_not_editable");
            }
            if exists.is_none() {
                return refuse(format!("the lesson has no revision {lesson_revision}"), "academy.lesson_revision_unknown");
            }
            let next = course_event(tx, &item, "lesson", operator, Some(reason), now)?;
            let next4 = i32::try_from(next).unwrap_or(i32::MAX);
            sql::exec(
                tx,
                "UPDATE academy.course_items SET live_revision = $2::int4, live_course_revision = $3::int4 WHERE id = $1::text::uuid",
                &[&item.id, &lr, &next4],
            )?;
            self.read(tx, &item.id)
        })
    }

    pub fn withdraw(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let course_revision = super::int(input, "courseRevision");
        let reason = text(input, "reason");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), true)?;
            if item.course_revision == course_revision + 1
                && item.live_revision.is_none()
                && item.live_course_revision == Some(item.course_revision)
                && own_course_event(tx, &item, operator, "withdrawn")?
            {
                return self.read(tx, &item.id);
            }
            course_stale(&item, course_revision)?;
            if item.live_revision.is_none() {
                return refuse("learners see no revision of this lesson", "academy.lesson_not_live");
            }
            if item.course_state != "draft" && item.course_state != "published" {
                return refuse(format!("a {} course's lessons are not changed", item.course_state), "academy.course_not_editable");
            }
            let next = course_event(tx, &item, "withdrawn", operator, Some(reason), now)?;
            let next4 = i32::try_from(next).unwrap_or(i32::MAX);
            sql::exec(
                tx,
                "UPDATE academy.course_items SET live_revision = NULL, live_course_revision = $2::int4 WHERE id = $1::text::uuid",
                &[&item.id, &next4],
            )?;
            sql::exec(
                tx,
                "WITH gone AS (DELETE FROM academy.featured_items WHERE course_item_id = $1::text::uuid RETURNING slot) \
                 INSERT INTO academy.featured_events (slot, action, course_item_id, reason, actor, at) \
                 SELECT slot, 'withdrawn', $1::text::uuid, $2::text, $3::text::uuid, $4::text::timestamptz FROM gone",
                &[&item.id, &js_trim(reason), &operator, &at(now)],
            )?;
            self.read(tx, &item.id)
        })
    }

    pub fn duplicate(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let course_revision = super::int(input, "courseRevision");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), false)?;
            if item.course_revision == course_revision + 1 {
                let rev = i32::try_from(item.course_revision).unwrap_or(i32::MAX);
                if let Some(copy) = first(
                    tx,
                    "SELECT i.id::text AS id FROM academy.course_items i \
                     JOIN academy.course_events e ON e.course_id = i.course_id AND e.revision = i.copied_at_revision \
                     WHERE i.copied_from = $1::text::uuid AND i.copied_at_revision = $2::int4 \
                       AND e.actor = $3::text::uuid AND e.kind = 'outline'",
                    &[&item.id, &rev, &operator],
                )? {
                    let id: String = get(&copy, "id")?;
                    return self.read(tx, &id);
                }
            }
            course_stale(&item, course_revision)?;
            if item.course_state != "draft" {
                return refuse(
                    format!("a {} course's outline is not edited here", item.course_state),
                    "academy.course_not_editable",
                );
            }
            self.courses.assert_room_for_one_more(tx, &item.course_id, &item.kind)?;
            let pos = i32::try_from(item.position).unwrap_or(i32::MAX);
            sql::exec(
                tx,
                "UPDATE academy.course_items SET position = -2 - position WHERE section_id = $1::text::uuid AND position > $2::int4",
                &[&item.section_id, &pos],
            )?;
            sql::exec(
                tx,
                "UPDATE academy.course_items SET position = -1 - position WHERE section_id = $1::text::uuid AND position < 0",
                &[&item.section_id],
            )?;
            let at_rev = course_event(tx, &item, "outline", operator, None, now)?;
            let copy_id = sql::uuid()?;
            let at4 = i32::try_from(at_rev).unwrap_or(i32::MAX);
            let indent = i32::try_from(item.indent).unwrap_or(0);
            sql::exec(
                tx,
                "INSERT INTO academy.course_items (id, course_id, section_id, position, kind, title, indent, url, copied_from, copied_at_revision) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::int4, $5::text, $6::text, $7::int4, $8::text, $9::text::uuid, $10::int4)",
                &[&copy_id, &item.course_id, &item.section_id, &(pos + 1), &item.kind, &item.title, &indent, &item.url, &item.id, &at4],
            )?;
            if let Some(n) = newest(tx, &item.id)? {
                insert(tx, &copy_id, 1, "duplicated", None, Some(&item.id), &n.blocks, operator, now)?;
            }
            sql::exec(
                tx,
                "INSERT INTO academy.course_assignments (item_id, revision, instructions, points, due_at, text_mode, file_mode, saved_by, saved_at) \
                 SELECT $1::text::uuid, 1, instructions, points, due_at, text_mode, file_mode, $3::text::uuid, $4::text::timestamptz \
                 FROM academy.course_assignments WHERE item_id = $2::text::uuid AND withdrawn_at IS NULL",
                &[&copy_id, &item.id, &operator, &at(now)],
            )?;
            self.read(tx, &copy_id)
        })
    }

    /// `import`: the owner's size limit before the file is parsed; a bad file reports every problem and creates nothing.
    pub fn import(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let Some(max) = self.import_max_bytes else {
            return refuse("the owner has not set the lesson import size limit", "academy.import_limit_unset");
        };
        let document = text(input, "document");
        let bytes = i64::try_from(document.len()).unwrap_or(i64::MAX);
        if bytes > max {
            return refuse(format!("the file is {bytes} bytes; the limit is {max}"), "academy.import_too_large");
        }
        let item_id = text(input, "itemId");
        let blocks = match check_lesson_file(document)? {
            Ok(b) => b,
            Err(problems) => {
                return Ok(Json::obj([
                    ("outcome", Json::str("invalid")),
                    (
                        "problems",
                        Json::Array(
                            problems
                                .iter()
                                .map(|p| Json::obj([("block", nullable_int(p.block)), ("problem", Json::str(&p.problem))]))
                                .collect(),
                        ),
                    ),
                    ("lesson", self.get(item_id)?),
                ]));
            }
        };
        let revision = super::int(input, "revision");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, item_id, true)?;
            let n = newest(tx, &item.id)?;
            if let Some(v) = &n
                && v.revision == revision + 1
                && v.source == "imported"
                && v.actor == operator
                && same_blocks(&v.blocks, &blocks)
            {
                return Ok(Json::obj([("outcome", Json::str("imported")), ("lesson", self.read(tx, &item.id)?)]));
            }
            stale(n.as_ref(), revision)?;
            insert(tx, &item.id, revision + 1, "imported", None, None, &blocks, operator, now)?;
            Ok(Json::obj([("outcome", Json::str("imported")), ("lesson", self.read(tx, &item.id)?)]))
        })
    }

    /// `assistantDraft`: the model path refuses `owner.decision`; the template draft is keyed by the revision it is on.
    pub fn assistant_draft(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        if text(input, "path") == "model" {
            return Err(Refusal::OwnerDecision(
                "drafting with a model waits for the owner to choose a provider; the template draft works without one".to_owned(),
            ));
        }
        let revision = super::int(input, "revision");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), true)?;
            let n = newest(tx, &item.id)?;
            stale(n.as_ref(), revision)?;
            let place = first(
                tx,
                "SELECT s.title AS section_title, c.title AS course_title, \
                   ARRAY(SELECT o.title FROM academy.course_items o WHERE o.section_id = s.id AND o.id <> $2::text::uuid AND o.kind <> 'subheader' \
                         ORDER BY o.position) AS neighbours \
                 FROM academy.course_sections s JOIN academy.courses c ON c.id = s.course_id WHERE s.id = $1::text::uuid",
                &[&item.section_id, &item.id],
            )?
            .ok_or_else(|| internal("Cannot read properties of undefined (reading 'course_title')"))?;
            let blocks = template_draft(
                &get::<String>(&place, "course_title")?,
                &get::<String>(&place, "section_title")?,
                &item.title,
                &get::<Vec<String>>(&place, "neighbours")?,
            );
            check_blocks(&blocks)?;
            let rev = i32::try_from(revision).unwrap_or(i32::MAX);
            sql::exec(
                tx,
                "INSERT INTO academy.lesson_drafts (item_id, based_on_revision, kind, blocks, state, created_by, created_at) \
                 VALUES ($1::text::uuid, $2::int4, 'template', $3::text::jsonb, 'open', $4::text::uuid, $5::text::timestamptz) \
                 ON CONFLICT (item_id, based_on_revision, kind) DO UPDATE SET \
                   blocks = excluded.blocks, state = 'open', created_by = excluded.created_by, created_at = excluded.created_at, \
                   decided_by = NULL, decided_at = NULL \
                 WHERE academy.lesson_drafts.state = 'discarded'",
                &[&item.id, &rev, &blocks.compact(), &operator, &at(now)],
            )?;
            self.read(tx, &item.id)
        })
    }

    /// `decideDraft`.
    pub fn decide_draft(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let based = super::int(input, "basedOnRevision");
        let kind = text(input, "kind");
        let decision = text(input, "decision");
        sql::begin(self.pool, |tx| {
            let item = lock_item(tx, text(input, "itemId"), true)?;
            let b4 = i32::try_from(based).unwrap_or(i32::MAX);
            let Some(draft) = first(
                tx,
                "SELECT based_on_revision, blocks::text AS blocks, state FROM academy.lesson_drafts \
                 WHERE item_id = $1::text::uuid AND based_on_revision = $2::int4 AND kind = $3::text",
                &[&item.id, &b4, &kind],
            )?
            else {
                return refuse("no such draft for this lesson", "academy.draft_not_found");
            };
            let done = if decision == "accept" { "accepted" } else { "discarded" };
            let state: String = get(&draft, "state")?;
            if state == done {
                return self.read(tx, &item.id);
            }
            if state != "open" {
                return refuse(format!("the draft was already {state}"), "academy.draft_not_found");
            }
            let mut accepted: Option<i32> = None;
            if decision == "accept" {
                let n = newest(tx, &item.id)?;
                let at_rev = n.as_ref().map_or(0, |v| v.revision);
                let draft_based = sql::int(&draft, "based_on_revision")?;
                if at_rev != draft_based {
                    return refuse(
                        format!("the lesson moved on to revision {at_rev} since the draft was made"),
                        "academy.revision_stale",
                    );
                }
                let blocks = parse_json(&get::<String>(&draft, "blocks")?)?;
                insert(tx, &item.id, draft_based + 1, "assisted", None, None, &blocks, operator, now)?;
                accepted = Some(i32::try_from(draft_based + 1).unwrap_or(i32::MAX));
            }
            sql::exec(
                tx,
                "UPDATE academy.lesson_drafts SET state = $4::text, decided_by = $5::text::uuid, decided_at = $6::text::timestamptz, \
                   accepted_revision = $7::int4 \
                 WHERE item_id = $1::text::uuid AND based_on_revision = $2::int4 AND kind = $3::text",
                &[&item.id, &b4, &kind, &done, &operator, &at(now), &accepted],
            )?;
            self.read(tx, &item.id)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_compare_whatever_their_key_order() {
        let a = json::parse(r#"[{"type":"text","markdown":"x"}]"#).unwrap_or(Json::Null);
        let b = json::parse(r#"[{"markdown":"x","type":"text"}]"#).unwrap_or(Json::Null);
        assert!(same_blocks(&a, &b));
    }

    #[test]
    fn a_lesson_file_names_every_problem() {
        let bad = r#"{"format":"intafaced.lesson.v1","blocks":[{"type":"video"},{"type":"image","url":"http://x","alt":"a"},{"type":"text","markdown":"ok"}]}"#;
        let Ok(Err(problems)) = check_lesson_file(bad) else {
            panic!("expected problems");
        };
        assert_eq!(problems.len(), 2);
        assert_eq!(problems.first().map(|p| p.problem.as_str()), Some("unknown block type \"video\""));
        assert_eq!(problems.get(1).map(|p| (p.block, p.problem.as_str())), Some((Some(2), "a image block with url not valid")));
        assert!(matches!(check_lesson_file("nope"), Ok(Err(_))));
        assert!(matches!(check_lesson_file(r#"{"format":"intafaced.lesson.v1","blocks":[{"type":"text","markdown":" a "}]}"#), Ok(Ok(_))));
    }

    #[test]
    fn the_template_lists_the_section_and_caps_it() {
        let many: Vec<String> = (0..52).map(|i| format!("t{i}")).collect();
        let d = template_draft("C", "S", "I", &many).compact();
        assert!(d.contains("- and 2 more"));
        assert!(d.contains("Part of “S” in “C”."));
    }
}
