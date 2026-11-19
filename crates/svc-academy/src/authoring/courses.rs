//! Course records (`curriculum/courses.ts` `CourseRecords`): a course staff create on the desk, its outline, topics and
//! history. Create is keyed by the slug; an edit or a move names the revision it was read at, so a repeat after a lost
//! reply finds its own result one revision on. No money moves: `price` is a catalogue figure, a decimal string.

use postgres::{GenericClient, Transaction};

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::Value;

use super::sql::{self, P, at, first, get, int, iso_of, ms, opt_int, query};
use super::{nullable, nullable_int, opt_text, refuse, text};
use crate::curriculum::spine;
use crate::errors::Refusal;

const EVENTS_SHOWN: i64 = 100;

/// `ACADEMY_COURSE_STATES`.
pub const STATES: [&str; 5] = ["draft", "published", "concluded", "archived", "deleted"];

/// The columns of a `CourseRow`, from `academy.courses c`, with `items` given.
fn columns(items: &str) -> String {
    format!(
        "c.id::text AS id, c.slug, c.title, c.summary, c.thumbnail_url, c.pricing, c.price::text AS price, c.price_asset, \
         c.state, c.revision, c.created_by::text AS created_by, {} AS created_at, {} AS updated_at, {items} AS items",
        ms("c.created_at"),
        ms("c.updated_at")
    )
}

/// Items a learner can open, counted in the same read.
const COUNTED: &str =
    "(SELECT count(*)::int FROM academy.course_items i WHERE i.course_id = c.id AND i.kind <> 'subheader')";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CourseRow {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub summary: Option<String>,
    pub thumbnail_url: Option<String>,
    pub pricing: String,
    pub price: Option<String>,
    pub price_asset: Option<String>,
    pub state: String,
    pub revision: i64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub items: i64,
}

impl CourseRow {
    fn of(r: &postgres::Row) -> Result<CourseRow, Refusal> {
        Ok(CourseRow {
            id: get(r, "id")?,
            slug: get(r, "slug")?,
            title: get(r, "title")?,
            summary: get(r, "summary")?,
            thumbnail_url: get(r, "thumbnail_url")?,
            pricing: get(r, "pricing")?,
            price: get(r, "price")?,
            price_asset: get(r, "price_asset")?,
            state: get(r, "state")?,
            revision: int(r, "revision")?,
            created_by: get(r, "created_by")?,
            created_at: iso_of(r, "created_at")?,
            updated_at: iso_of(r, "updated_at")?,
            items: int(r, "items")?,
        })
    }

    /// `courseOf(row)`, in `academyCourseSchema`'s order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(&self.id)),
            ("slug", Json::str(&self.slug)),
            ("title", Json::str(&self.title)),
            ("summary", nullable(self.summary.clone())),
            ("thumbnailUrl", nullable(self.thumbnail_url.clone())),
            ("pricing", Json::str(&self.pricing)),
            ("price", nullable(canonical_price(self.price.as_deref()))),
            ("priceAsset", nullable(self.price_asset.clone())),
            ("state", Json::str(&self.state)),
            ("revision", Json::int(self.revision)),
            ("items", Json::int(self.items)),
            ("createdBy", Json::str(&self.created_by)),
            ("createdAt", Json::str(&self.created_at)),
            ("updatedAt", Json::str(&self.updated_at)),
        ])
    }
}

/// `canonicalPrice`: `25.50`, `25.500000000000000000` and `25.5` are one price.
pub fn canonical_price(price: Option<&str>) -> Option<String> {
    let p = price?;
    if !p.contains('.') {
        return Some(p.to_owned());
    }
    let t = p.trim_end_matches('0');
    Some(t.strip_suffix('.').unwrap_or(t).to_owned())
}

/// The details an edit sends, as the checked input holds them.
struct Details<'a> {
    title: &'a str,
    summary: Option<&'a str>,
    thumbnail_url: Option<&'a str>,
    pricing: &'a str,
    price: Option<&'a str>,
    price_asset: Option<&'a str>,
}

impl<'a> Details<'a> {
    fn of(input: &'a Value) -> Details<'a> {
        Details {
            title: text(input, "title"),
            summary: opt_text(input, "summary"),
            thumbnail_url: opt_text(input, "thumbnailUrl"),
            pricing: text(input, "pricing"),
            price: opt_text(input, "price"),
            price_asset: opt_text(input, "priceAsset"),
        }
    }

    fn same(&self, row: &CourseRow) -> bool {
        row.title == self.title
            && row.summary.as_deref() == self.summary
            && row.thumbnail_url.as_deref() == self.thumbnail_url
            && row.pricing == self.pricing
            && canonical_price(row.price.as_deref()) == canonical_price(self.price)
            && row.price_asset.as_deref() == self.price_asset
    }
}

/// `assertSlugFree`: never a reserved tab, a shipped course (a curriculum path) or a lesson's address.
pub fn assert_slug_free(slug: &str) -> Result<(), Refusal> {
    spine::assert_slug_not_reserved(slug)?;
    if spine::PATHS.contains(&slug) || spine::get(slug).is_some() {
        return refuse(
            format!("slug \"{slug}\" is already the address of a course or lesson"),
            "academy.course_slug_taken",
        );
    }
    Ok(())
}

/// The owner's outline limits. `None` is not set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_sections: Option<i64>,
    pub max_items: Option<i64>,
}

impl Limits {
    fn json(self) -> Json {
        Json::obj([
            ("maxSections", nullable_int(self.max_sections)),
            ("maxItems", nullable_int(self.max_items)),
        ])
    }

    fn both(self) -> Result<(i64, i64), Refusal> {
        match (self.max_sections, self.max_items) {
            (Some(s), Some(i)) => Ok((s, i)),
            _ => refuse(
                "the owner has not set the outline section and item limits",
                "academy.outline_limits_unset",
            ),
        }
    }
}

fn event<C: GenericClient>(
    c: &mut C,
    course_id: &str,
    revision: i64,
    kind: &str,
    from: Option<&str>,
    to: &str,
    actor: &str,
    reason: Option<&str>,
    now: i64,
) -> Result<(), Refusal> {
    let rev = i32::try_from(revision).unwrap_or(i32::MAX);
    sql::exec(
        c,
        "INSERT INTO academy.course_events (course_id, revision, kind, from_state, to_state, actor, reason, at) \
         VALUES ($1::text::uuid, $2::int4, $3::text, $4::text, $5::text, $6::text::uuid, $7::text, $8::text::timestamptz)",
        &[&course_id, &rev, &kind, &from, &to, &actor, &reason, &at(now)],
    )?;
    Ok(())
}

/// The kind (and target state) of this operator's own event at `revision`, when there is one.
fn own_event<C: GenericClient>(c: &mut C, course_id: &str, revision: i64, actor: &str) -> Result<Option<(String, String)>, Refusal> {
    let rev = i32::try_from(revision).unwrap_or(i32::MAX);
    first(
        c,
        "SELECT kind, to_state FROM academy.course_events WHERE course_id = $1::text::uuid AND revision = $2::int4 AND actor = $3::text::uuid",
        &[&course_id, &rev, &actor],
    )?
    .map(|r| Ok((get(&r, "kind")?, get(&r, "to_state")?)))
    .transpose()
}

fn i4(n: i64) -> i32 {
    i32::try_from(n).unwrap_or(i32::MAX)
}

fn stale(row: &CourseRow, revision: i64) -> Result<(), Refusal> {
    if row.revision != revision {
        return refuse(
            format!("course is at revision {}, not {revision}", row.revision),
            "academy.course_revision_stale",
        );
    }
    Ok(())
}

/// The course row, locked (`FOR UPDATE OF c`), or `academy.course_not_found`.
pub fn lock(tx: &mut Transaction<'_>, course_id: &str) -> Result<CourseRow, Refusal> {
    let sql = format!(
        "SELECT {} FROM academy.courses c WHERE c.id = $1::text::uuid FOR UPDATE OF c",
        columns(COUNTED)
    );
    match first(tx, &sql, &[&course_id])? {
        Some(r) => CourseRow::of(&r),
        None => refuse("no course with that id", "academy.course_not_found"),
    }
}

pub struct CourseRecords {
    pub limits: Limits,
}

/// One outline item as stored.
struct OutlineItem {
    id: String,
    section_id: String,
    kind: String,
    title: String,
    indent: i64,
    url: Option<String>,
    live_revision: Option<i64>,
    lesson_revision: Option<i64>,
}

/// One section with its items.
pub struct OutlineSection {
    id: String,
    title: String,
    items: Vec<OutlineItem>,
}

impl OutlineSection {
    fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(&self.id)),
            ("title", Json::str(&self.title)),
            (
                "items",
                Json::Array(
                    self.items
                        .iter()
                        .map(|i| {
                            Json::obj([
                                ("id", Json::str(&i.id)),
                                ("kind", Json::str(&i.kind)),
                                ("title", Json::str(&i.title)),
                                ("indent", Json::int(i.indent)),
                                ("url", nullable(i.url.clone())),
                                ("lessonRevision", nullable_int(i.lesson_revision)),
                                ("liveRevision", nullable_int(i.live_revision)),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }

    /// `[s.title, s.items.map(i => [i.kind, i.title, i.indent, i.url])]`, as the save compares it.
    fn shape(&self) -> Json {
        shape_json(
            &self.title,
            self.items
                .iter()
                .map(|i| (i.kind.as_str(), i.title.as_str(), i.indent, i.url.as_deref())),
        )
    }
}

fn shape_json<'a>(title: &str, items: impl Iterator<Item = (&'a str, &'a str, i64, Option<&'a str>)>) -> Json {
    Json::Array(vec![
        Json::str(title),
        Json::Array(
            items
                .map(|(kind, title, indent, url)| {
                    Json::Array(vec![
                        Json::str(kind),
                        Json::str(title),
                        Json::int(indent),
                        url.map_or(Json::Null, Json::str),
                    ])
                })
                .collect(),
        ),
    ])
}

/// One section of the outline a save sends.
struct SectionIn<'a> {
    id: Option<&'a str>,
    title: &'a str,
    items: Vec<ItemIn<'a>>,
}

struct ItemIn<'a> {
    id: Option<&'a str>,
    kind: &'a str,
    title: &'a str,
    indent: i64,
    url: Option<&'a str>,
}

fn sections_of(input: &Value) -> Vec<SectionIn<'_>> {
    input
        .get("sections")
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(|s| SectionIn {
            id: opt_text(s, "id"),
            title: text(s, "title"),
            items: s
                .get("items")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|i| ItemIn {
                    id: opt_text(i, "id"),
                    kind: text(i, "kind"),
                    title: text(i, "title"),
                    indent: super::int(i, "indent"),
                    url: opt_text(i, "url"),
                })
                .collect(),
        })
        .collect()
}

impl CourseRecords {
    /// `create`: `assertSlugFree` before anything is read, then the insert keyed by the slug.
    pub fn create(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let slug = text(input, "slug");
        assert_slug_free(slug)?;
        let d = Details::of(input);
        let price = canonical_price(d.price);
        sql::begin(pool, |tx| {
            let inserted = first(
                tx,
                &format!(
                    "INSERT INTO academy.courses AS c \
                       (slug, title, summary, thumbnail_url, pricing, price, price_asset, state, revision, created_by, created_at, updated_at) \
                     VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text::numeric, $7::text, 'draft', 1, $8::text::uuid, \
                             $9::text::timestamptz, $9::text::timestamptz) \
                     ON CONFLICT (slug) DO NOTHING RETURNING {}",
                    columns("0")
                ),
                &[&slug, &d.title, &d.summary, &d.thumbnail_url, &d.pricing, &price, &d.price_asset, &operator, &at(now)],
            )?;
            if let Some(r) = inserted {
                let row = CourseRow::of(&r)?;
                event(tx, &row.id, 1, "created", None, "draft", operator, None, now)?;
                return Ok(row.json());
            }
            let existing = first(
                tx,
                &format!("SELECT {} FROM academy.courses c WHERE c.slug = $1::text", columns("0")),
                &[&slug],
            )?
            .map(|r| CourseRow::of(&r))
            .transpose()?;
            if let Some(e) = existing {
                if e.revision == 1 && e.created_by == operator && d.same(&e) {
                    return Ok(e.json());
                }
            }
            refuse(
                format!("slug \"{slug}\" is already the address of a course"),
                "academy.course_slug_taken",
            )
        })
    }

    /// `duplicate`: a new draft at its own address, copied from any course; no learner record is read or written.
    pub fn duplicate(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let slug = text(input, "slug");
        assert_slug_free(slug)?;
        let title = text(input, "title");
        sql::begin(pool, |tx| {
            let source = lock(tx, text(input, "courseId"))?;
            let reason = format!("duplicated from {}: {}", source.slug, text(input, "reason"));
            let inserted = first(
                tx,
                &format!(
                    "INSERT INTO academy.courses AS c \
                       (slug, title, summary, thumbnail_url, pricing, price, price_asset, state, revision, created_by, created_at, updated_at) \
                     VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text::numeric, $7::text, 'draft', 1, $8::text::uuid, \
                             $9::text::timestamptz, $9::text::timestamptz) \
                     ON CONFLICT (slug) DO NOTHING RETURNING {}",
                    columns("0")
                ),
                &[
                    &slug,
                    &title,
                    &source.summary,
                    &source.thumbnail_url,
                    &source.pricing,
                    &source.price,
                    &source.price_asset,
                    &operator,
                    &at(now),
                ],
            )?;
            let Some(copy) = inserted else {
                let existing = first(
                    tx,
                    &format!(
                        "SELECT {}, e.reason AS event_reason, \
                           (SELECT count(*)::int FROM academy.course_items i LEFT JOIN academy.course_items s ON s.id = i.copied_from \
                            WHERE i.course_id = c.id AND (s.course_id IS DISTINCT FROM $2::text::uuid)) AS foreign_items \
                         FROM academy.courses c JOIN academy.course_events e ON e.course_id = c.id AND e.revision = 1 \
                         WHERE c.slug = $1::text",
                        columns("0")
                    ),
                    &[&slug, &source.id],
                )?;
                if let Some(r) = existing {
                    let e = CourseRow::of(&r)?;
                    let event_reason: Option<String> = get(&r, "event_reason")?;
                    if e.revision == 1
                        && e.created_by == operator
                        && e.title == title
                        && event_reason.as_deref() == Some(reason.as_str())
                        && int(&r, "foreign_items")? == 0
                    {
                        return Ok(self.get_in(tx, &e.id)?.course.json());
                    }
                }
                return refuse(
                    format!("slug \"{slug}\" is already the address of a course"),
                    "academy.course_slug_taken",
                );
            };
            let copy = CourseRow::of(&copy)?;
            event(tx, &copy.id, 1, "created", None, "draft", operator, Some(&reason), now)?;
            sql::exec(
                tx,
                "INSERT INTO academy.course_topics (course_id, topic_id) \
                 SELECT $1::text::uuid, topic_id FROM academy.course_topics WHERE course_id = $2::text::uuid",
                &[&copy.id, &source.id],
            )?;
            let sections = query(
                tx,
                "SELECT id::text AS id, position, title FROM academy.course_sections WHERE course_id = $1::text::uuid ORDER BY position",
                &[&source.id],
            )?;
            let mut section_ids: Vec<(String, String)> = Vec::new();
            for s in &sections {
                section_ids.push((get(s, "id")?, sql::uuid()?));
            }
            if !sections.is_empty() {
                let mut values = Vec::new();
                let mut params: Vec<Box<dyn postgres::types::ToSql + Sync>> = Vec::new();
                for (n, s) in sections.iter().enumerate() {
                    let new_id = section_ids.get(n).map(|(_, v)| v.clone()).unwrap_or_default();
                    let b = params.len();
                    values.push(format!(
                        "(${}::text::uuid, ${}::text::uuid, ${}::int4, ${}::text)",
                        b + 1,
                        b + 2,
                        b + 3,
                        b + 4
                    ));
                    params.push(Box::new(new_id));
                    params.push(Box::new(copy.id.clone()));
                    params.push(Box::new(get::<i32>(s, "position")?));
                    params.push(Box::new(get::<String>(s, "title")?));
                }
                let refs: Vec<P<'_>> = params.iter().map(|p| p.as_ref() as P<'_>).collect();
                sql::exec(
                    tx,
                    &format!(
                        "INSERT INTO academy.course_sections (id, course_id, position, title) VALUES {}",
                        values.join(", ")
                    ),
                    &refs,
                )?;
            }
            let items = query(
                tx,
                "SELECT id::text AS id, section_id::text AS section_id, position, kind, title, indent, url \
                 FROM academy.course_items WHERE course_id = $1::text::uuid",
                &[&source.id],
            )?;
            if !items.is_empty() {
                let mut values = Vec::new();
                let mut params: Vec<Box<dyn postgres::types::ToSql + Sync>> = Vec::new();
                for i in &items {
                    let section: String = get(i, "section_id")?;
                    let new_section = section_ids
                        .iter()
                        .find(|(old, _)| *old == section)
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default();
                    let b = params.len();
                    values.push(format!(
                        "(${}::text::uuid, ${}::text::uuid, ${}::text::uuid, ${}::int4, ${}::text, ${}::text, ${}::int4, ${}::text, ${}::text::uuid, 1)",
                        b + 1,
                        b + 2,
                        b + 3,
                        b + 4,
                        b + 5,
                        b + 6,
                        b + 7,
                        b + 8,
                        b + 9
                    ));
                    params.push(Box::new(sql::uuid()?));
                    params.push(Box::new(copy.id.clone()));
                    params.push(Box::new(new_section));
                    params.push(Box::new(get::<i32>(i, "position")?));
                    params.push(Box::new(get::<String>(i, "kind")?));
                    params.push(Box::new(get::<String>(i, "title")?));
                    params.push(Box::new(get::<i32>(i, "indent")?));
                    params.push(Box::new(get::<Option<String>>(i, "url")?));
                    params.push(Box::new(get::<String>(i, "id")?));
                }
                let refs: Vec<P<'_>> = params.iter().map(|p| p.as_ref() as P<'_>).collect();
                sql::exec(
                    tx,
                    &format!(
                        "INSERT INTO academy.course_items \
                           (id, course_id, section_id, position, kind, title, indent, url, copied_from, copied_at_revision) VALUES {}",
                        values.join(", ")
                    ),
                    &refs,
                )?;
            }
            sql::exec(
                tx,
                "INSERT INTO academy.lesson_revisions (item_id, revision, source, from_revision, from_item_id, blocks, actor, at) \
                 SELECT i.id, 1, 'duplicated', NULL, i.copied_from, r.blocks, $2::text::uuid, $3::text::timestamptz \
                 FROM academy.course_items i \
                 JOIN LATERAL ( \
                   SELECT blocks FROM academy.lesson_revisions WHERE item_id = i.copied_from ORDER BY revision DESC LIMIT 1 \
                 ) r ON true \
                 WHERE i.course_id = $1::text::uuid",
                &[&copy.id, &operator, &at(now)],
            )?;
            sql::exec(
                tx,
                "INSERT INTO academy.course_assignments (item_id, revision, instructions, points, due_at, text_mode, file_mode, saved_by, saved_at) \
                 SELECT i.id, 1, a.instructions, a.points, a.due_at, a.text_mode, a.file_mode, $2::text::uuid, $3::text::timestamptz \
                 FROM academy.course_items i \
                 JOIN LATERAL ( \
                   SELECT * FROM academy.course_assignments \
                   WHERE item_id = i.copied_from AND withdrawn_at IS NULL ORDER BY revision DESC LIMIT 1 \
                 ) a ON true \
                 WHERE i.course_id = $1::text::uuid",
                &[&copy.id, &operator, &at(now)],
            )?;
            Ok(self.get_in(tx, &copy.id)?.course.json())
        })
    }

    pub fn update(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let d = Details::of(input);
        let price = canonical_price(d.price);
        let revision = super::int(input, "revision");
        sql::begin(pool, |tx| {
            let row = lock(tx, text(input, "courseId"))?;
            if row.revision == revision + 1 && d.same(&row) {
                if let Some((kind, _)) = own_event(tx, &row.id, row.revision, operator)? {
                    if kind == "updated" {
                        return Ok(row.json());
                    }
                }
            }
            stale(&row, revision)?;
            if row.state != "draft" {
                return refuse(format!("a {} course is not edited here", row.state), "academy.course_not_editable");
            }
            let next = first(
                tx,
                &format!(
                    "UPDATE academy.courses AS c SET \
                       title = $2::text, summary = $3::text, thumbnail_url = $4::text, pricing = $5::text, \
                       price = $6::text::numeric, price_asset = $7::text, revision = revision + 1, updated_at = $8::text::timestamptz \
                     WHERE c.id = $1::text::uuid RETURNING {}",
                    columns("$9::int4")
                ),
                &[&row.id, &d.title, &d.summary, &d.thumbnail_url, &d.pricing, &price, &d.price_asset, &at(now), &i4(row.items)],
            )?;
            let next = CourseRow::of(&next.ok_or_else(missing)?)?;
            event(tx, &row.id, next.revision, "updated", Some(&row.state), &row.state, operator, None, now)?;
            Ok(next.json())
        })
    }

    /// `setTopics`: the topics as a whole over the revision read.
    pub fn set_topics(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let revision = super::int(input, "revision");
        let topic_ids: Vec<String> = input
            .get("topicIds")
            .as_array()
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        sql::begin(pool, |tx| {
            let row = lock(tx, text(input, "courseId"))?;
            if row.revision == revision + 1 {
                let own = own_event(tx, &row.id, row.revision, operator)?;
                let held: Vec<String> = query(
                    tx,
                    "SELECT topic_id::text AS topic_id FROM academy.course_topics WHERE course_id = $1::text::uuid",
                    &[&row.id],
                )?
                .iter()
                .map(|r| get(r, "topic_id"))
                .collect::<Result<_, _>>()?;
                let same = held.len() == topic_ids.len() && held.iter().all(|h| topic_ids.contains(h));
                if own.is_some_and(|(k, _)| k == "topics") && same {
                    return Ok(self.get_in(tx, &row.id)?.json(self.limits));
                }
            }
            stale(&row, revision)?;
            if row.state != "draft" && row.state != "published" {
                return refuse(format!("a {} course is not filed here", row.state), "academy.course_not_editable");
            }
            if !topic_ids.is_empty() {
                let found = query(
                    tx,
                    "SELECT id FROM academy.topics WHERE id = ANY($1::text[]::uuid[])",
                    &[&topic_ids],
                )?;
                if found.len() != topic_ids.len() {
                    return refuse("no topic with one of those ids", "academy.topic_not_found");
                }
            }
            sql::exec(tx, "DELETE FROM academy.course_topics WHERE course_id = $1::text::uuid", &[&row.id])?;
            if !topic_ids.is_empty() {
                sql::exec(
                    tx,
                    "INSERT INTO academy.course_topics (course_id, topic_id) \
                     SELECT $1::text::uuid, t::uuid FROM unnest($2::text[]) WITH ORDINALITY AS u(t, n) ORDER BY n",
                    &[&row.id, &topic_ids],
                )?;
            }
            let next = bump(tx, &row.id, now)?;
            event(tx, &row.id, next, "topics", Some(&row.state), &row.state, operator, None, now)?;
            Ok(self.get_in(tx, &row.id)?.json(self.limits))
        })
    }

    pub fn set_state(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let revision = super::int(input, "revision");
        let to = text(input, "to");
        let reason = text(input, "reason");
        sql::begin(pool, |tx| {
            let row = lock(tx, text(input, "courseId"))?;
            if row.revision == revision + 1 && row.state == to {
                if let Some((kind, to_state)) = own_event(tx, &row.id, row.revision, operator)? {
                    if kind == "state" && to_state == to {
                        return Ok(row.json());
                    }
                }
            }
            stale(&row, revision)?;
            if row.state != "draft" {
                return refuse(
                    format!("a {} course cannot move to {to}", row.state),
                    "academy.item_transition_illegal",
                );
            }
            if row.pricing == "paid" && row.price.is_none() {
                return refuse("a paid course has no price, so it is not published", "academy.price_unset");
            }
            if row.items == 0 {
                return refuse(
                    "the course has nothing in its outline, so it is not published",
                    "academy.course_outline_empty",
                );
            }
            assert_peer_counts_set(tx, &row.id)?;
            let next = first(
                tx,
                &format!(
                    "UPDATE academy.courses AS c SET state = $2::text, revision = revision + 1, updated_at = $3::text::timestamptz \
                     WHERE c.id = $1::text::uuid RETURNING {}",
                    columns("$4::int4")
                ),
                &[&row.id, &to, &at(now), &i4(row.items)],
            )?;
            let next = CourseRow::of(&next.ok_or_else(missing)?)?;
            event(tx, &row.id, next.revision, "state", Some(&row.state), to, operator, Some(reason), now)?;
            Ok(next.json())
        })
    }

    pub fn withdraw_price(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let revision = super::int(input, "revision");
        let reason = text(input, "reason");
        sql::begin(pool, |tx| {
            let row = lock(tx, text(input, "courseId"))?;
            if row.revision == revision + 1 && row.price.is_none() {
                if let Some((kind, _)) = own_event(tx, &row.id, row.revision, operator)? {
                    if kind == "price_withdrawn" {
                        return Ok(row.json());
                    }
                }
            }
            stale(&row, revision)?;
            if row.state != "published" {
                return refuse(
                    format!("a {} course's price is not withdrawn here; edit the draft", row.state),
                    "academy.course_not_editable",
                );
            }
            if row.pricing != "paid" {
                return refuse("a free course has no price to withdraw", "academy.course_not_editable");
            }
            if row.price.is_none() {
                return refuse("the course has no price to withdraw", "academy.course_not_editable");
            }
            let next = first(
                tx,
                &format!(
                    "UPDATE academy.courses AS c SET price = NULL, price_asset = NULL, price_withdrawn_at = $2::text::timestamptz, \
                       revision = revision + 1, updated_at = $2::text::timestamptz \
                     WHERE c.id = $1::text::uuid RETURNING {}",
                    columns("$3::int4")
                ),
                &[&row.id, &at(now), &i4(row.items)],
            )?;
            let next = CourseRow::of(&next.ok_or_else(missing)?)?;
            event(tx, &row.id, next.revision, "price_withdrawn", Some(&row.state), &row.state, operator, Some(reason), now)?;
            Ok(next.json())
        })
    }

    /// `saveOutline`: both limits set and the outline inside them before anything is read.
    pub fn save_outline(&self, pool: &Pool, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let (max_sections, max_items) = self.limits.both()?;
        let sections = sections_of(input);
        let item_count: usize = sections
            .iter()
            .map(|s| s.items.iter().filter(|i| i.kind != "subheader").count())
            .sum();
        let n_sections = i64::try_from(sections.len()).unwrap_or(i64::MAX);
        let n_items = i64::try_from(item_count).unwrap_or(i64::MAX);
        if n_sections > max_sections || n_items > max_items {
            return refuse(
                format!("{n_sections} sections and {n_items} items; the limits are {max_sections} and {max_items}"),
                "academy.outline_too_large",
            );
        }
        let wanted = Json::Array(
            sections
                .iter()
                .map(|s| shape_json(s.title, s.items.iter().map(|i| (i.kind, i.title, i.indent, i.url))))
                .collect(),
        )
        .compact();
        let revision = super::int(input, "revision");
        let course_id = text(input, "courseId");
        sql::begin(pool, |tx| {
            let row = lock(tx, course_id)?;
            if row.revision == revision + 1 {
                if let Some((kind, _)) = own_event(tx, &row.id, row.revision, operator)? {
                    if kind == "outline" {
                        let stored = outline(tx, &row.id)?;
                        let have = Json::Array(stored.iter().map(OutlineSection::shape).collect()).compact();
                        if have == wanted {
                            return Ok(self.get_in(tx, course_id)?.json(self.limits));
                        }
                    }
                }
            }
            stale(&row, revision)?;
            if row.state != "draft" {
                return refuse(format!("a {} course is not edited here", row.state), "academy.course_not_editable");
            }
            write_outline(tx, &row.id, &sections)?;
            let next = bump(tx, &row.id, now)?;
            event(tx, &row.id, next, "outline", Some(&row.state), &row.state, operator, None, now)?;
            Ok(self.get_in(tx, course_id)?.json(self.limits))
        })
    }

    /// `get(courseId)` outside a transaction.
    pub fn get(&self, pool: &Pool, course_id: &str) -> Result<Json, Refusal> {
        sql::client(pool, |c| Ok(self.get_in(c, course_id)?.json(self.limits)))
    }

    pub fn get_in<C: GenericClient>(&self, c: &mut C, course_id: &str) -> Result<Detail, Refusal> {
        let sql = format!("SELECT {} FROM academy.courses c WHERE c.id = $1::text::uuid", columns(COUNTED));
        let Some(r) = first(c, &sql, &[&course_id])? else {
            return refuse("no course with that id", "academy.course_not_found");
        };
        let course = CourseRow::of(&r)?;
        let outline = outline(c, course_id)?;
        let topics = query(
            c,
            &format!(
                "SELECT t.id::text AS id, t.slug, t.name, {} AS created_at FROM academy.course_topics ct \
                 JOIN academy.topics t ON t.id = ct.topic_id WHERE ct.course_id = $1::text::uuid ORDER BY t.name, t.slug",
                ms("t.created_at")
            ),
            &[&course_id],
        )?
        .iter()
        .map(topic_json)
        .collect::<Result<Vec<_>, _>>()?;
        let events = query(
            c,
            &format!(
                "SELECT kind, revision, from_state, to_state, actor::text AS actor, reason, {} AS at FROM academy.course_events \
                 WHERE course_id = $1::text::uuid ORDER BY revision DESC LIMIT $2::int8",
                ms("at")
            ),
            &[&course_id, &EVENTS_SHOWN],
        )?
        .iter()
        .map(|e| {
            Ok(Json::obj([
                ("kind", Json::String(get(e, "kind")?)),
                ("revision", Json::int(int(e, "revision")?)),
                ("fromState", nullable(get(e, "from_state")?)),
                ("toState", Json::String(get(e, "to_state")?)),
                ("actor", Json::String(get(e, "actor")?)),
                ("reason", nullable(get(e, "reason")?)),
                ("at", Json::String(iso_of(e, "at")?)),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
        Ok(Detail {
            course,
            topics,
            outline,
            events,
        })
    }

    /// `list({ state, limit })`: a missing page size refuses before anything is read.
    pub fn list(&self, pool: &Pool, input: &Value) -> Result<Json, Refusal> {
        let Some(limit) = super::opt_int(input, "limit") else {
            return refuse("the course list needs a page size", "academy.courses_list_limit_unset");
        };
        let state = opt_text(input, "state");
        sql::client(pool, |c| {
            let rows = match state {
                Some(s) => query(
                    c,
                    &format!(
                        "SELECT {} FROM academy.courses c WHERE c.state = $1::text ORDER BY c.created_at DESC, c.id LIMIT $2::int8",
                        columns(COUNTED)
                    ),
                    &[&s, &limit],
                )?,
                None => query(
                    c,
                    &format!(
                        "SELECT {} FROM academy.courses c ORDER BY c.created_at DESC, c.id LIMIT $1::int8",
                        columns(COUNTED)
                    ),
                    &[&limit],
                )?,
            };
            let tally = query(c, "SELECT state, count(*)::int AS n FROM academy.courses GROUP BY state", &[])?;
            let mut counts: Vec<(String, Json)> = STATES.iter().map(|s| ((*s).to_owned(), Json::int(0))).collect();
            for t in &tally {
                let s: String = get(t, "state")?;
                let n = int(t, "n")?;
                match counts.iter_mut().find(|(k, _)| *k == s) {
                    Some(slot) => slot.1 = Json::int(n),
                    None => counts.push((s, Json::int(n))),
                }
            }
            // The output schema keeps the five states, in order, and drops anything else.
            counts.retain(|(k, _)| STATES.contains(&k.as_str()));
            Ok(Json::obj([
                (
                    "courses",
                    Json::Array(
                        rows.iter()
                            .map(|r| CourseRow::of(r).map(|c| c.json()))
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ),
                ("counts", Json::Object(counts)),
            ]))
        })
    }

    /// `assertRoomForOneMore(tx, courseId, kind)`.
    pub fn assert_room_for_one_more(&self, tx: &mut Transaction<'_>, course_id: &str, kind: &str) -> Result<(), Refusal> {
        let (_, max_items) = self.limits.both()?;
        if kind == "subheader" {
            return Ok(());
        }
        let n = first(
            tx,
            "SELECT count(*)::int AS items FROM academy.course_items WHERE course_id = $1::text::uuid AND kind <> 'subheader'",
            &[&course_id],
        )?
        .map_or(Ok(0), |r| int(&r, "items"))?;
        if n + 1 > max_items {
            return refuse(format!("{} items; the limit is {max_items}", n + 1), "academy.outline_too_large");
        }
        Ok(())
    }
}

fn missing() -> Refusal {
    Refusal::Internal {
        message: "the locked course row was not returned".to_owned(),
        code: None,
    }
}

/// `UPDATE academy.courses SET revision = revision + 1 ... RETURNING revision`.
fn bump(tx: &mut Transaction<'_>, course_id: &str, now: i64) -> Result<i64, Refusal> {
    let r = first(
        tx,
        "UPDATE academy.courses SET revision = revision + 1, updated_at = $2::text::timestamptz WHERE id = $1::text::uuid RETURNING revision",
        &[&course_id, &at(now)],
    )?
    .ok_or_else(missing)?;
    int(&r, "revision")
}

pub fn topic_json(t: &postgres::Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("id", Json::String(get(t, "id")?)),
        ("slug", Json::String(get(t, "slug")?)),
        ("name", Json::String(get(t, "name")?)),
        ("createdAt", Json::String(iso_of(t, "created_at")?)),
    ]))
}

/// `AcademyCourseDetail`.
pub struct Detail {
    pub course: CourseRow,
    topics: Vec<Json>,
    outline: Vec<OutlineSection>,
    events: Vec<Json>,
}

impl Detail {
    pub fn json(&self, limits: Limits) -> Json {
        Json::obj([
            ("course", self.course.json()),
            ("topics", Json::Array(self.topics.clone())),
            ("outline", Json::Array(self.outline.iter().map(OutlineSection::json).collect())),
            ("limits", limits.json()),
            ("events", Json::Array(self.events.clone())),
        ])
    }
}

fn outline<C: GenericClient>(c: &mut C, course_id: &str) -> Result<Vec<OutlineSection>, Refusal> {
    let sections = query(
        c,
        "SELECT id::text AS id, title FROM academy.course_sections WHERE course_id = $1::text::uuid ORDER BY position",
        &[&course_id],
    )?;
    let items = query(
        c,
        "SELECT i.id::text AS id, i.section_id::text AS section_id, i.kind, i.title, i.indent, i.url, i.live_revision, \
           (SELECT max(r.revision) FROM academy.lesson_revisions r WHERE r.item_id = i.id) AS lesson_revision \
         FROM academy.course_items i WHERE i.course_id = $1::text::uuid ORDER BY i.position",
        &[&course_id],
    )?
    .iter()
    .map(|i| {
        Ok(OutlineItem {
            id: get(i, "id")?,
            section_id: get(i, "section_id")?,
            kind: get(i, "kind")?,
            title: get(i, "title")?,
            indent: int(i, "indent")?,
            url: get(i, "url")?,
            live_revision: opt_int(i, "live_revision")?,
            lesson_revision: opt_int(i, "lesson_revision")?,
        })
    })
    .collect::<Result<Vec<_>, Refusal>>()?;
    let mut out = Vec::new();
    for s in &sections {
        let id: String = get(s, "id")?;
        let own = items
            .iter()
            .filter(|i| i.section_id == id)
            .map(|i| OutlineItem {
                id: i.id.clone(),
                section_id: i.section_id.clone(),
                kind: i.kind.clone(),
                title: i.title.clone(),
                indent: i.indent,
                url: i.url.clone(),
                live_revision: i.live_revision,
                lesson_revision: i.lesson_revision,
            })
            .collect();
        out.push(OutlineSection {
            id,
            title: get(s, "title")?,
            items: own,
        });
    }
    Ok(out)
}

/// `writeOutline`: stored sections and items keep their ids; positions move out of the way first.
fn write_outline(tx: &mut Transaction<'_>, course_id: &str, sections: &[SectionIn<'_>]) -> Result<(), Refusal> {
    let have = first(
        tx,
        "SELECT \
           ARRAY(SELECT id::text FROM academy.course_sections WHERE course_id = $1::text::uuid) AS sections, \
           ARRAY(SELECT id::text FROM academy.course_items WHERE course_id = $1::text::uuid) AS items",
        &[&course_id],
    )?
    .ok_or_else(missing)?;
    let own_sections: Vec<String> = get(&have, "sections")?;
    let own_items: Vec<String> = get(&have, "items")?;
    let named: Vec<&str> = sections
        .iter()
        .flat_map(|s| s.id.into_iter().chain(s.items.iter().filter_map(|i| i.id)))
        .collect();
    let mut distinct = named.clone();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.len() != named.len() {
        return refuse("the outline names one section or item twice", "academy.outline_item_unknown");
    }
    for s in sections {
        if s.id.is_some_and(|id| !own_sections.iter().any(|o| o == id)) {
            return refuse("the outline names a section this course does not hold", "academy.outline_item_unknown");
        }
        for i in &s.items {
            if i.id.is_some_and(|id| !own_items.iter().any(|o| o == id)) {
                return refuse("the outline names an item this course does not hold", "academy.outline_item_unknown");
            }
        }
    }
    let all: Vec<&ItemIn<'_>> = sections.iter().flat_map(|s| s.items.iter()).collect();
    let labelled: Vec<String> = all
        .iter()
        .filter(|i| i.id.is_some() && (i.kind == "subheader" || i.kind == "link"))
        .filter_map(|i| i.id.map(str::to_owned))
        .collect();
    if !labelled.is_empty() {
        let n = first(
            tx,
            "SELECT count(*)::int AS n FROM academy.lesson_revisions WHERE item_id = ANY($1::text[]::uuid[])",
            &[&labelled],
        )?
        .map_or(Ok(0), |r| int(&r, "n"))?;
        if n > 0 {
            return refuse("an item with a lesson does not become a subheader or a link", "academy.item_kind_locked");
        }
    }
    let kept: Vec<&str> = all.iter().filter(|i| i.kind == "assignment").filter_map(|i| i.id).collect();
    let listed: Vec<&str> = all.iter().filter_map(|i| i.id).collect();
    let briefs = query(
        tx,
        "SELECT a.item_id::text AS item_id, EXISTS (SELECT 1 FROM academy.assignment_submissions s WHERE s.item_id = a.item_id) AS handed_in \
         FROM academy.course_assignments a JOIN academy.course_items i ON i.id = a.item_id WHERE i.course_id = $1::text::uuid",
        &[&course_id],
    )?;
    for b in &briefs {
        let id: String = get(b, "item_id")?;
        if kept.contains(&id.as_str()) {
            continue;
        }
        let handed_in: bool = get(b, "handed_in")?;
        if handed_in && !listed.contains(&id.as_str()) {
            return refuse(
                "learners handed in to this assignment, so it stays in the outline; withdraw it instead",
                "academy.assignment_has_submissions",
            );
        }
        if listed.contains(&id.as_str()) {
            return refuse("an assignment with a brief stays an assignment", "academy.item_kind_locked");
        }
    }
    let quiz_kept: Vec<&str> = all.iter().filter(|i| i.kind == "quiz").filter_map(|i| i.id).collect();
    let quizzes = query(
        tx,
        "SELECT q.item_id::text AS item_id, (EXISTS (SELECT 1 FROM academy.course_quiz_attempts t WHERE t.item_id = q.item_id) \
           OR EXISTS (SELECT 1 FROM academy.course_survey_responses r WHERE r.item_id = q.item_id)) AS attempted \
         FROM academy.course_quizzes q JOIN academy.course_items i ON i.id = q.item_id WHERE i.course_id = $1::text::uuid",
        &[&course_id],
    )?;
    for q in &quizzes {
        let id: String = get(q, "item_id")?;
        if quiz_kept.contains(&id.as_str()) {
            continue;
        }
        let attempted: Option<bool> = get(q, "attempted")?;
        if attempted == Some(true) && !listed.contains(&id.as_str()) {
            return refuse("learners attempted this quiz, so it stays in the outline", "academy.item_has_attempts");
        }
        if listed.contains(&id.as_str()) {
            return refuse("a saved quiz stays a quiz", "academy.item_kind_locked");
        }
    }
    sql::exec(
        tx,
        "UPDATE academy.course_items SET position = -1 - position WHERE course_id = $1::text::uuid",
        &[&course_id],
    )?;
    sql::exec(
        tx,
        "UPDATE academy.course_sections SET position = -1 - position WHERE course_id = $1::text::uuid",
        &[&course_id],
    )?;
    let mut section_ids = Vec::new();
    for s in sections {
        section_ids.push(match s.id {
            Some(id) => id.to_owned(),
            None => sql::uuid()?,
        });
    }
    if !sections.is_empty() {
        let mut values = Vec::new();
        let mut params: Vec<Box<dyn postgres::types::ToSql + Sync>> = Vec::new();
        for (position, s) in sections.iter().enumerate() {
            let b = params.len();
            values.push(format!(
                "(${}::text::uuid, ${}::text::uuid, ${}::int4, ${}::text)",
                b + 1,
                b + 2,
                b + 3,
                b + 4
            ));
            params.push(Box::new(section_ids.get(position).cloned().unwrap_or_default()));
            params.push(Box::new(course_id.to_owned()));
            params.push(Box::new(i32::try_from(position).unwrap_or(i32::MAX)));
            params.push(Box::new(s.title.to_owned()));
        }
        let refs: Vec<P<'_>> = params.iter().map(|p| p.as_ref() as P<'_>).collect();
        sql::exec(
            tx,
            &format!(
                "INSERT INTO academy.course_sections (id, course_id, position, title) VALUES {} \
                 ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, title = EXCLUDED.title",
                values.join(", ")
            ),
            &refs,
        )?;
    }
    let mut item_ids = Vec::new();
    let mut values = Vec::new();
    let mut params: Vec<Box<dyn postgres::types::ToSql + Sync>> = Vec::new();
    for (sp, s) in sections.iter().enumerate() {
        for (position, i) in s.items.iter().enumerate() {
            let id = match i.id {
                Some(id) => id.to_owned(),
                None => sql::uuid()?,
            };
            item_ids.push(id.clone());
            let b = params.len();
            values.push(format!(
                "(${}::text::uuid, ${}::text::uuid, ${}::text::uuid, ${}::int4, ${}::text, ${}::text, ${}::int4, ${}::text)",
                b + 1,
                b + 2,
                b + 3,
                b + 4,
                b + 5,
                b + 6,
                b + 7,
                b + 8
            ));
            params.push(Box::new(id));
            params.push(Box::new(course_id.to_owned()));
            params.push(Box::new(section_ids.get(sp).cloned().unwrap_or_default()));
            params.push(Box::new(i32::try_from(position).unwrap_or(i32::MAX)));
            params.push(Box::new(i.kind.to_owned()));
            params.push(Box::new(i.title.to_owned()));
            params.push(Box::new(i32::try_from(i.indent).unwrap_or(0)));
            params.push(Box::new(i.url.map(str::to_owned)));
        }
    }
    if !values.is_empty() {
        let refs: Vec<P<'_>> = params.iter().map(|p| p.as_ref() as P<'_>).collect();
        sql::exec(
            tx,
            &format!(
                "INSERT INTO academy.course_items (id, course_id, section_id, position, kind, title, indent, url) VALUES {} \
                 ON CONFLICT (id) DO UPDATE SET section_id = EXCLUDED.section_id, position = EXCLUDED.position, kind = EXCLUDED.kind, \
                   title = EXCLUDED.title, indent = EXCLUDED.indent, url = EXCLUDED.url",
                values.join(", ")
            ),
            &refs,
        )?;
    }
    sql::exec(
        tx,
        "DELETE FROM academy.course_items WHERE course_id = $1::text::uuid AND NOT (id = ANY($2::text[]::uuid[]))",
        &[&course_id, &item_ids],
    )?;
    sql::exec(
        tx,
        "DELETE FROM academy.course_sections WHERE course_id = $1::text::uuid AND NOT (id = ANY($2::text[]::uuid[]))",
        &[&course_id, &section_ids],
    )?;
    Ok(())
}

/// `assertPeerCountsSet(tx, courseId)` (`curriculum/peer-review.ts`): a course is not published while one of its open
/// assignments asks for peer reviews without the owner's counts.
pub fn assert_peer_counts_set(tx: &mut Transaction<'_>, course_id: &str) -> Result<(), Refusal> {
    super::release::assert_peer_counts_set(tx, course_id)
}

/// The JSON of a stored `price` for a repeat: never a float.
pub fn price_param(price: Option<&str>) -> Option<String> {
    canonical_price(price)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_price_drops_its_trailing_zeros_and_point() {
        assert_eq!(canonical_price(Some("25.50")).as_deref(), Some("25.5"));
        assert_eq!(canonical_price(Some("25.500000000000000000")).as_deref(), Some("25.5"));
        assert_eq!(canonical_price(Some("100.00")).as_deref(), Some("100"));
        assert_eq!(canonical_price(Some("100")).as_deref(), Some("100"));
        assert_eq!(canonical_price(None), None);
    }
}
