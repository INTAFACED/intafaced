//! Release on curriculum items (`release/access.ts` `ReleaseAccess`: prerequisites, windows and the learner's release
//! view), a course's start (`curriculum/course-start.ts`), scheduled section release and pacing on a course staff made
//! (`curriculum/course-release.ts`), and the peer-count check publishing asks (`curriculum/peer-review.ts`
//! `assertPeerCountsSet`). The pure decision is the curriculum slice's (`curriculum::gates::decide`); these are the writes
//! and the fuller reads around it.

use postgres::{GenericClient, Transaction};

use service_kit::json::Json;
use crate::db::Store;
use service_kit::schema::{Value, js_trim};
use service_kit::time::js_date;

use super::sql::{self, at, first, get, iso, iso_of, ms, opt_int, opt_iso_of, query};
use super::{nullable, opt_text, refuse, text};
use crate::curriculum::gates::{self, Decision, Window};
use crate::curriculum::spine;
use crate::errors::Refusal;

const DAY_MS: i64 = 86_400_000;

/// `requireCurriculumSlug`, owned.
pub fn require_slug(slug: &str) -> Result<String, Refusal> {
    gates::require_slug(slug).map(str::to_owned)
}

/// `clearedOrWindow`: both ends or neither; the end after the start; a due inside the span.
pub fn cleared_or_window(from: Option<i64>, until: Option<i64>, due: Option<i64>) -> Result<Option<Window>, Refusal> {
    if from.is_none() && until.is_none() && due.is_none() {
        return Ok(None);
    }
    let (Some(from), Some(until)) = (from, until) else {
        return refuse("availability start and end are both required", "academy.window_invalid");
    };
    if until <= from {
        return refuse("availability end must be after the start", "academy.window_invalid");
    }
    if let Some(d) = due
        && (d < from || d > until)
    {
        return refuse("due is outside the availability window", "academy.window_invalid");
    }
    Ok(Some(Window { from, until, due }))
}

/// `requireExtensionReason`: the reason trimmed, or refused when blank (the extension calls' first check).
pub fn require_extension_reason(reason: &str) -> Result<&str, Refusal> {
    let trimmed = js_trim(reason);
    if trimmed.is_empty() {
        return refuse("academy.reason_required", "academy.reason_required");
    }
    Ok(trimmed)
}

/// `assertExtensionExtends`: an extension must pass the published window's end and its due.
pub fn assert_extension_extends(window: Window, extended_until: i64) -> Result<(), Refusal> {
    let bound = window.due.map_or(window.until, |d| d.min(window.until));
    if extended_until <= bound {
        return refuse("extension does not pass the published window", "academy.window_invalid");
    }
    Ok(())
}

/// `normalizePrerequisites`: each on the spine, no self-edge, deduplicated and sorted.
pub fn normalize_prerequisites(item_slug: &str, raw: &[&str]) -> Result<Vec<String>, Refusal> {
    let item = require_slug(item_slug)?;
    let mut out: Vec<String> = Vec::new();
    for v in raw {
        let slug = require_slug(v)?;
        if slug == item {
            return refuse(format!("academy.prerequisite_cycle path={item}>{item}"), "academy.prerequisite_cycle");
        }
        if !out.contains(&slug) {
            out.push(slug);
        }
    }
    out.sort();
    Ok(out)
}

/// `findPrerequisiteCycle`: the first cycle, as item, prerequisite, …, item; nodes visited in first-seen order.
pub fn find_cycle(edges: &[(String, String)]) -> Option<Vec<String>> {
    let mut nodes: Vec<String> = Vec::new();
    let mut adjacent: Vec<Vec<String>> = Vec::new();
    let index = |nodes: &mut Vec<String>, adjacent: &mut Vec<Vec<String>>, n: &str| -> usize {
        if let Some(i) = nodes.iter().position(|x| x == n) {
            return i;
        }
        nodes.push(n.to_owned());
        adjacent.push(Vec::new());
        nodes.len() - 1
    };
    for (item, pre) in edges {
        let i = index(&mut nodes, &mut adjacent, item);
        if let Some(a) = adjacent.get_mut(i) {
            a.push(pre.clone());
        }
        index(&mut nodes, &mut adjacent, pre);
    }
    let mut color = vec![0u8; nodes.len()];
    let mut stack: Vec<String> = Vec::new();
    fn visit(
        node: usize,
        nodes: &[String],
        adjacent: &[Vec<String>],
        color: &mut [u8],
        stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if let Some(c) = color.get_mut(node) {
            *c = 1;
        }
        let name = nodes.get(node).cloned().unwrap_or_default();
        stack.push(name);
        for next in adjacent.get(node).map(Vec::as_slice).unwrap_or_default() {
            let n = nodes.iter().position(|x| x == next).unwrap_or(0);
            match color.get(n).copied().unwrap_or(0) {
                1 => {
                    let at = stack.iter().position(|s| s == next).unwrap_or(0);
                    let mut cycle: Vec<String> = stack.get(at..).unwrap_or_default().to_vec();
                    cycle.push(next.clone());
                    return Some(cycle);
                }
                0 => {
                    if let Some(found) = visit(n, nodes, adjacent, color, stack) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        stack.pop();
        if let Some(c) = color.get_mut(node) {
            *c = 2;
        }
        None
    }
    for n in 0..nodes.len() {
        if color.get(n).copied().unwrap_or(0) == 0
            && let Some(found) = visit(n, &nodes, &adjacent, &mut color, &mut stack)
        {
            return Some(found);
        }
    }
    None
}

fn outside(w: Window, ext: Option<i64>, now: i64) -> bool {
    if now < w.from {
        return true;
    }
    let open_until = ext.filter(|e| *e > w.until).unwrap_or(w.until);
    if now >= open_until {
        return true;
    }
    w.due.is_some_and(|d| now >= ext.filter(|e| *e > d).unwrap_or(d))
}

/// `releaseOpensAt`.
pub fn release_opens_at(window: Option<Window>, ext: Option<i64>, course_starts_at: Option<i64>, now: i64) -> Option<i64> {
    let own = window.map(|w| w.from);
    let own_closed = window.is_some_and(|w| now >= w.from && outside(w, ext, now));
    let pending = course_starts_at.filter(|c| now < *c);
    let Some(start) = pending else {
        return own;
    };
    if own_closed {
        return own;
    }
    let opens = match own {
        Some(o) if o > start => o,
        _ => start,
    };
    if window.is_some_and(|w| outside(w, ext, opens)) {
        return None;
    }
    Some(opens)
}

/// `readCourseStart(sql, path)`.
pub fn course_start<C: GenericClient>(c: &mut C, path: &str) -> Result<Option<i64>, Refusal> {
    first(
        c,
        &format!("SELECT {} AS starts_at FROM academy.course_starts WHERE path = $1::text", ms("starts_at")),
        &[&path],
    )?
    .map_or(Ok(None), |r| get(&r, "starts_at"))
}

/// `ItemReleaseView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub item_slug: String,
    pub decision: Decision,
    pub available_from: Option<i64>,
    pub available_until: Option<i64>,
    pub due_at: Option<i64>,
    pub extended_until: Option<i64>,
    pub reason: Option<String>,
    pub granted_at: Option<i64>,
    pub granted_by: Option<String>,
}

fn opt_ms(v: Option<i64>) -> Json {
    v.map_or(Json::Null, |m| Json::String(iso(m)))
}

impl View {
    /// The `itemRelease` output, in its schema's order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("itemSlug", Json::str(&self.item_slug)),
            ("state", Json::str(self.decision.state)),
            ("missing", Json::Array(self.decision.missing.iter().map(Json::str).collect())),
            ("lock", self.decision.lock.map_or(Json::Null, Json::str)),
            ("availableFrom", opt_ms(self.available_from)),
            ("availableUntil", opt_ms(self.available_until)),
            ("dueAt", opt_ms(self.due_at)),
            ("extendedUntil", opt_ms(self.extended_until)),
            ("reason", nullable(self.reason.clone())),
            ("grantedAt", opt_ms(self.granted_at)),
            ("grantedBy", nullable(self.granted_by.clone())),
        ])
    }
}

/// `ReleaseAccess.load`: the learner's view of one item.
pub fn load<C: GenericClient>(c: &mut C, user_id: &str, item_slug: &str, now: i64, course_starts_at: Option<i64>) -> Result<View, Refusal> {
    let required: Vec<String> = query(
        c,
        "SELECT prerequisite_slug FROM academy.item_prerequisites WHERE item_slug = $1::text",
        &[&item_slug],
    )?
    .iter()
    .map(|r| get(r, "prerequisite_slug"))
    .collect::<Result<_, _>>()?;
    let mut missing = Vec::new();
    if !required.is_empty() {
        let have: Vec<String> = query(
            c,
            "SELECT item_slug FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = ANY($2::text[])",
            &[&user_id, &required],
        )?
        .iter()
        .map(|r| get(r, "item_slug"))
        .collect::<Result<_, _>>()?;
        missing = required.into_iter().filter(|s| !have.contains(s)).collect();
    }
    let window = first(
        c,
        &format!(
            "SELECT {} AS available_from, {} AS available_until, {} AS due_at FROM academy.item_windows WHERE item_slug = $1::text",
            ms("available_from"),
            ms("available_until"),
            ms("due_at")
        ),
        &[&item_slug],
    )?
    .map(|r| {
        Ok::<_, Refusal>(Window {
            from: get(&r, "available_from")?,
            until: get(&r, "available_until")?,
            due: get(&r, "due_at")?,
        })
    })
    .transpose()?;
    let extension = first(
        c,
        &format!(
            "SELECT {} AS extended_until, reason, {} AS granted_at, granted_by::text AS granted_by FROM academy.item_extensions \
             WHERE user_id = $1::text::uuid AND item_slug = $2::text ORDER BY revision DESC LIMIT 1",
            ms("extended_until"),
            ms("granted_at")
        ),
        &[&user_id, &item_slug],
    )?;
    let started = first(
        c,
        "SELECT (EXISTS (SELECT 1 FROM academy.learning_touches WHERE user_id = $1::text::uuid AND item_slug = $2::text) \
           OR EXISTS (SELECT 1 FROM academy.learning_state WHERE user_id = $1::text::uuid AND last_item_slug = $2::text)) AS started",
        &[&user_id, &item_slug],
    )?
    .map_or(Ok(None), |r| get::<Option<bool>>(&r, "started"))?
        == Some(true);
    let completed = first(
        c,
        "SELECT EXISTS (SELECT 1 FROM academy.cert_item_completions WHERE user_id = $1::text::uuid AND item_slug = $2::text) AS completed",
        &[&user_id, &item_slug],
    )?
    .map_or(Ok(None), |r| get::<Option<bool>>(&r, "completed"))?
        == Some(true);
    let (ext_until, reason, granted_at, granted_by) = match &extension {
        Some(e) => (
            Some(get::<i64>(e, "extended_until")?),
            Some(get::<String>(e, "reason")?),
            Some(get::<i64>(e, "granted_at")?),
            Some(get::<String>(e, "granted_by")?),
        ),
        None => (None, None, None, None),
    };
    let decision = gates::decide(completed, started, &missing, window, ext_until, now, course_starts_at);
    Ok(View {
        item_slug: item_slug.to_owned(),
        decision,
        available_from: release_opens_at(window, ext_until, course_starts_at, now),
        available_until: window.map(|w| w.until),
        due_at: window.and_then(|w| w.due),
        extended_until: ext_until,
        reason,
        granted_at,
        granted_by,
    })
}

/// `ReleaseAccess.itemRelease`: the spine check, the course start, then the view.
pub fn item_release(pool: &Store, user_id: &str, item_slug: &str, now: i64) -> Result<View, Refusal> {
    let slug = require_slug(item_slug)?;
    sql::client(pool, |c| {
        let starts = match spine::get(&slug) {
            Some(item) => course_start(c, &item.path)?,
            None => None,
        };
        load(c, user_id, &slug, now, starts)
    })
}

/// `setItemPrerequisites`: the whole set, under one advisory lock, refused when the graph then has a cycle.
pub fn set_item_prerequisites(pool: &Store, input: &Value) -> Result<Json, Refusal> {
    let item = require_slug(text(input, "itemSlug"))?;
    let raw: Vec<&str> = input
        .get("prerequisites")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let prerequisites = normalize_prerequisites(&item, &raw)?;
    sql::serializable(pool, |tx| {
        sql::exec(tx, "SELECT pg_advisory_xact_lock(hashtextextended('academy.item_prerequisites', 0))", &[])?;
        sql::exec(tx, "DELETE FROM academy.item_prerequisites WHERE item_slug = $1::text", &[&item])?;
        for p in &prerequisites {
            sql::exec(
                tx,
                "INSERT INTO academy.item_prerequisites (item_slug, prerequisite_slug) VALUES ($1::text, $2::text)",
                &[&item, p],
            )?;
        }
        let edges: Vec<(String, String)> = query(tx, "SELECT item_slug, prerequisite_slug FROM academy.item_prerequisites", &[])?
            .iter()
            .map(|r| Ok((get(r, "item_slug")?, get(r, "prerequisite_slug")?)))
            .collect::<Result<_, Refusal>>()?;
        if let Some(cycle) = find_cycle(&edges) {
            return refuse(format!("academy.prerequisite_cycle path={}", cycle.join(">")), "academy.prerequisite_cycle");
        }
        Ok(())
    })?;
    Ok(Json::obj([
        ("itemSlug", Json::str(&item)),
        ("prerequisites", Json::Array(prerequisites.iter().map(Json::str).collect())),
    ]))
}

fn date_field(input: &Value, key: &str) -> Option<i64> {
    opt_text(input, key).and_then(|s| js_date(s).map(|i| i.0))
}

/// `setItemWindow`: cleared, or upserted.
pub fn set_item_window(pool: &Store, input: &Value) -> Result<Json, Refusal> {
    let item = require_slug(text(input, "itemSlug"))?;
    let window = cleared_or_window(
        date_field(input, "availableFrom"),
        date_field(input, "availableUntil"),
        date_field(input, "dueAt"),
    )?;
    let Some(w) = window else {
        sql::client(pool, |c| sql::exec(c, "DELETE FROM academy.item_windows WHERE item_slug = $1::text", &[&item]))?;
        return Ok(Json::obj([
            ("itemSlug", Json::str(&item)),
            ("availableFrom", Json::Null),
            ("availableUntil", Json::Null),
            ("dueAt", Json::Null),
        ]));
    };
    let due = w.due.map(at);
    sql::client(pool, |c| {
        sql::exec(
            c,
            "INSERT INTO academy.item_windows (item_slug, available_from, available_until, due_at) \
             VALUES ($1::text, $2::text::timestamptz, $3::text::timestamptz, $4::text::timestamptz) \
             ON CONFLICT (item_slug) DO UPDATE SET available_from = EXCLUDED.available_from, \
               available_until = EXCLUDED.available_until, due_at = EXCLUDED.due_at",
            &[&item, &at(w.from), &at(w.until), &due],
        )
    })?;
    Ok(Json::obj([
        ("itemSlug", Json::str(&item)),
        ("availableFrom", Json::String(iso(w.from))),
        ("availableUntil", Json::String(iso(w.until))),
        ("dueAt", opt_ms(w.due)),
    ]))
}

/// `publishedCourse(slug)`: a curriculum path with published items, or `academy.course_not_found`.
pub fn published_course(slug: &str) -> Result<&'static str, Refusal> {
    let s = js_trim(slug);
    match spine::PATHS.iter().find(|p| **p == s) {
        Some(p) if !spine::list(Some(p), None).is_empty() => Ok(p),
        _ => refuse(format!("Course \"{slug}\" is not published"), "academy.course_not_found"),
    }
}

/// `CourseStarts.set`: the published-course check and the reason before the write.
pub fn set_course_start(pool: &Store, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
    let slug = published_course(text(input, "slug"))?;
    let reason = js_trim(text(input, "reason"));
    if reason.is_empty() {
        return refuse("academy.reason_required", "academy.reason_required");
    }
    let starts = date_field(input, "startsAt");
    let starts_text = starts.map(at);
    sql::client(pool, |c| {
        sql::exec(
            c,
            "INSERT INTO academy.course_starts (path, starts_at, reason, set_by, set_at) \
             VALUES ($1::text, $2::text::timestamptz, $3::text, $4::text::uuid, $5::text::timestamptz) \
             ON CONFLICT (path) DO UPDATE SET starts_at = EXCLUDED.starts_at, reason = EXCLUDED.reason, \
               set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
            &[&slug, &starts_text, &reason, &operator, &at(now)],
        )
    })?;
    Ok(Json::obj([
        ("slug", Json::str(slug)),
        ("startsAt", opt_ms(starts)),
        ("reason", Json::str(reason)),
        ("setAt", Json::String(iso(now))),
    ]))
}

/// `assertPeerCountsSet`.
pub fn assert_peer_counts_set<C: GenericClient>(c: &mut C, course_id: &str) -> Result<(), Refusal> {
    if let Some(r) = first(
        c,
        "SELECT i.title FROM academy.assignment_review_steps s JOIN academy.course_items i ON i.id = s.item_id \
         WHERE i.course_id = $1::text::uuid AND s.peer AND s.peer_count IS NULL LIMIT 1",
        &[&course_id],
    )? {
        let title: String = get(&r, "title")?;
        return refuse(
            format!("\"{title}\" has peer review on with no review count, so the course is not published"),
            "academy.peer_count_unset",
        );
    }
    Ok(())
}

// ---- Scheduled release and pacing on a course staff made (`course-release.ts`). ----

/// A section's stored rule: an instant, or days after enrolment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rule {
    At(i64),
    AfterEnrolment(i64),
}

impl Rule {
    pub fn json(&self) -> Json {
        match self {
            Rule::At(t) => Json::obj([("kind", Json::str("at")), ("at", Json::String(iso(*t)))]),
            Rule::AfterEnrolment(d) => Json::obj([("kind", Json::str("after_enrolment")), ("days", Json::int(*d))]),
        }
    }

    /// `opensAt(rule, enrolledAt)`.
    pub fn opens_at(&self, enrolled_at: Option<i64>) -> Option<i64> {
        match self {
            Rule::At(t) => Some(*t),
            Rule::AfterEnrolment(d) => enrolled_at.map(|e| e + d * DAY_MS),
        }
    }
}

/// `ruleOf(row)`.
pub fn rule_of(release_at: Option<i64>, after_days: Option<i64>) -> Option<Rule> {
    match (release_at, after_days) {
        (Some(t), _) => Some(Rule::At(t)),
        (None, Some(d)) => Some(Rule::AfterEnrolment(d)),
        _ => None,
    }
}

fn rule_in(input: &Value) -> Result<Option<Rule>, Refusal> {
    let r = input.get("rule");
    match r.get("kind").as_str() {
        Some("at") => match js_date(text(r, "at")) {
            Some(i) => Ok(Some(Rule::At(i.0))),
            None => Err(Refusal::Internal {
                message: "Invalid time value".to_owned(),
                code: None,
            }),
        },
        Some("after_enrolment") => Ok(Some(Rule::AfterEnrolment(super::int(r, "days")))),
        _ => Ok(None),
    }
}

/// `assertItemOpen(sql, itemId, userId, now)`: the section's release, then the course items it requires.
pub fn assert_item_open<C: GenericClient>(c: &mut C, item_id: &str, user_id: &str, now: i64) -> Result<(), Refusal> {
    let done = |item: &str, begun: bool| {
        let (s, t) = if begun {
            ("", "")
        } else {
            (" AND s.state NOT IN ('draft', 'withdrawn')", " AND t.state <> 'open'")
        };
        format!(
            "(EXISTS (SELECT 1 FROM academy.assignment_submissions s WHERE s.item_id = {item} AND s.user_id = $2::text::uuid{s}) \
             OR EXISTS (SELECT 1 FROM academy.course_quiz_attempts t WHERE t.item_id = {item} AND t.user_id = $2::text::uuid{t}) \
             OR EXISTS (SELECT 1 FROM academy.course_survey_takers k WHERE k.item_id = {item} AND k.user_id = $2::text::uuid))"
        )
    };
    let Some(r) = first(
        c,
        &format!(
            "SELECT {} AS release_at, r.after_days, \
               (SELECT {} FROM academy.course_enrolments e WHERE e.course_id = i.course_id AND e.user_id = $2::text::uuid AND e.left_at IS NULL) AS enrolled_at, \
               {} AS begun, \
               ARRAY(SELECT p.prerequisite_id::text FROM academy.course_item_prerequisites p \
                 JOIN academy.course_items pi ON pi.id = p.prerequisite_id AND pi.kind IN ('assignment', 'quiz') \
                 WHERE p.item_id = i.id AND NOT {} ORDER BY p.prerequisite_id) AS unmet \
             FROM academy.course_items i LEFT JOIN academy.course_section_releases r ON r.section_id = i.section_id \
             WHERE i.id = $1::text::uuid",
            ms("r.release_at"),
            ms("e.enrolled_at"),
            done("i.id", true),
            done("p.prerequisite_id", false)
        ),
        &[&item_id, &user_id],
    )?
    else {
        return Ok(());
    };
    if get::<Option<bool>>(&r, "begun")? == Some(true) {
        return Ok(());
    }
    if let Some(rule) = rule_of(get(&r, "release_at")?, opt_int(&r, "after_days")?) {
        let opens = rule.opens_at(get(&r, "enrolled_at")?);
        if opens.is_none_or(|o| o > now) {
            let when = opens.map_or_else(|| "after enrolment".to_owned(), iso);
            return refuse(format!("academy.not_released_yet opens={when}"), "academy.not_released_yet");
        }
    }
    let unmet: Vec<String> = get(&r, "unmet")?;
    if !unmet.is_empty() {
        return refuse(format!("academy.prerequisite_unmet items={}", unmet.join(",")), "academy.prerequisite_unmet");
    }
    Ok(())
}

fn started<C: GenericClient>(c: &mut C, course_id: &str) -> Result<bool, Refusal> {
    first(
        c,
        "SELECT EXISTS (SELECT 1 FROM academy.course_enrolments WHERE course_id = $1::text::uuid) AS started",
        &[&course_id],
    )?
    .map_or(Ok(false), |r| get(&r, "started"))
}

fn lock_course(tx: &mut Transaction<'_>, course_id: &str) -> Result<(), Refusal> {
    if first(tx, "SELECT id FROM academy.courses WHERE id = $1::text::uuid FOR UPDATE", &[&course_id])?.is_none() {
        return refuse("no course has that id", "academy.course_not_found");
    }
    Ok(())
}

/// `CourseRelease.viewIn`.
pub fn release_view<C: GenericClient>(c: &mut C, course_id: &str) -> Result<Json, Refusal> {
    let Some(course) = first(
        c,
        &format!(
            "SELECT p.pacing, p.set_by::text AS set_by, {} AS set_at FROM academy.courses c \
             LEFT JOIN academy.course_pacing p ON p.course_id = c.id WHERE c.id = $1::text::uuid",
            ms("p.set_at")
        ),
        &[&course_id],
    )?
    else {
        return refuse("no course has that id", "academy.course_not_found");
    };
    let sections = query(
        c,
        &format!(
            "SELECT s.id::text AS id, s.title, {} AS release_at, r.after_days, r.reason, r.set_by::text AS set_by, {} AS set_at \
             FROM academy.course_sections s LEFT JOIN academy.course_section_releases r ON r.section_id = s.id \
             WHERE s.course_id = $1::text::uuid ORDER BY s.position",
            ms("r.release_at"),
            ms("r.set_at")
        ),
        &[&course_id],
    )?;
    let locked = started(c, course_id)?;
    let sections = sections
        .iter()
        .map(|s| {
            Ok(Json::obj([
                ("sectionId", Json::String(get(s, "id")?)),
                ("title", Json::String(get(s, "title")?)),
                (
                    "rule",
                    rule_of(get(s, "release_at")?, opt_int(s, "after_days")?).map_or(Json::Null, |r| r.json()),
                ),
                ("setBy", nullable(get(s, "set_by")?)),
                ("setAt", nullable(opt_iso_of(s, "set_at")?)),
                ("reason", nullable(get(s, "reason")?)),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Json::obj([
        ("courseId", Json::str(course_id)),
        ("pacing", nullable(get(&course, "pacing")?)),
        ("pacingLocked", Json::Bool(locked)),
        ("pacingSetBy", nullable(get(&course, "set_by")?)),
        ("pacingSetAt", nullable(opt_iso_of(&course, "set_at")?)),
        ("sections", Json::Array(sections)),
    ]))
}

pub fn course_release(pool: &Store, course_id: &str) -> Result<Json, Refusal> {
    sql::client(pool, |c| release_view(c, course_id))
}

/// `CourseRelease.setSectionRelease`.
pub fn set_section_release(pool: &Store, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
    let course_id = text(input, "courseId");
    let section_id = text(input, "sectionId");
    let reason = text(input, "reason");
    sql::begin(pool, |tx| {
        lock_course(tx, course_id)?;
        let Some(section) = first(
            tx,
            &format!(
                "SELECT {} AS release_at, r.after_days FROM academy.course_sections s \
                 LEFT JOIN academy.course_section_releases r ON r.section_id = s.id \
                 WHERE s.id = $1::text::uuid AND s.course_id = $2::text::uuid",
                ms("r.release_at")
            ),
            &[&section_id, &course_id],
        )?
        else {
            return refuse("no section of this course has that id", "academy.outline_item_unknown");
        };
        let stored = rule_of(get(&section, "release_at")?, opt_int(&section, "after_days")?);
        let wanted = rule_in(input)?;
        if stored == wanted {
            return release_view(tx, course_id);
        }
        match &wanted {
            None => {
                sql::exec(tx, "DELETE FROM academy.course_section_releases WHERE section_id = $1::text::uuid", &[&section_id])?;
            }
            Some(rule) => {
                let at_text = match rule {
                    Rule::At(t) => Some(at(*t)),
                    Rule::AfterEnrolment(_) => None,
                };
                let days = match rule {
                    Rule::AfterEnrolment(d) => Some(i32::try_from(*d).unwrap_or(i32::MAX)),
                    Rule::At(_) => None,
                };
                sql::exec(
                    tx,
                    "INSERT INTO academy.course_section_releases (section_id, release_at, after_days, reason, set_by, set_at) \
                     VALUES ($1::text::uuid, $2::text::timestamptz, $3::int4, $4::text, $5::text::uuid, $6::text::timestamptz) \
                     ON CONFLICT (section_id) DO UPDATE SET release_at = EXCLUDED.release_at, after_days = EXCLUDED.after_days, \
                       reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
                    &[&section_id, &at_text, &days, &reason, &operator, &at(now)],
                )?;
            }
        }
        let rule_json = wanted.as_ref().map(|r| r.json().compact());
        sql::exec(
            tx,
            "INSERT INTO academy.course_release_events (course_id, section_id, kind, rule, reason, actor_id, at) \
             VALUES ($1::text::uuid, $2::text::uuid, 'section_release', $3::text::jsonb, $4::text, $5::text::uuid, $6::text::timestamptz)",
            &[&course_id, &section_id, &rule_json, &reason, &operator, &at(now)],
        )?;
        release_view(tx, course_id)
    })
}

/// `CourseRelease.setPacing`.
pub fn set_pacing(pool: &Store, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
    let course_id = text(input, "courseId");
    let pacing = text(input, "pacing");
    let reason = text(input, "reason");
    sql::begin(pool, |tx| {
        lock_course(tx, course_id)?;
        let current: Option<String> = first(tx, "SELECT pacing FROM academy.course_pacing WHERE course_id = $1::text::uuid", &[&course_id])?
            .map(|r| get(&r, "pacing"))
            .transpose()?;
        if current.as_deref() == Some(pacing) {
            return release_view(tx, course_id);
        }
        if started(tx, course_id)? {
            return refuse("learners have enrolled, so the pacing stays as it is", "academy.pacing_locked");
        }
        sql::exec(
            tx,
            "INSERT INTO academy.course_pacing (course_id, pacing, set_by, set_at) \
             VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text::timestamptz) \
             ON CONFLICT (course_id) DO UPDATE SET pacing = EXCLUDED.pacing, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at",
            &[&course_id, &pacing, &operator, &at(now)],
        )?;
        let rule = Json::obj([("pacing", Json::str(pacing))]).compact();
        sql::exec(
            tx,
            "INSERT INTO academy.course_release_events (course_id, section_id, kind, rule, reason, actor_id, at) \
             VALUES ($1::text::uuid, null, 'pacing', $2::text::jsonb, $3::text, $4::text::uuid, $5::text::timestamptz)",
            &[&course_id, &rule, &reason, &operator, &at(now)],
        )?;
        release_view(tx, course_id)
    })
}

/// `iso_of` re-exported for the outline.
pub fn iso_col(row: &postgres::Row, column: &str) -> Result<String, Refusal> {
    iso_of(row, column)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(a: &str, b: &str) -> (String, String) {
        (a.to_owned(), b.to_owned())
    }

    #[test]
    fn a_cycle_is_found_in_first_seen_order() {
        assert_eq!(find_cycle(&[e("a", "b"), e("b", "c")]), None);
        assert_eq!(
            find_cycle(&[e("a", "b"), e("b", "c"), e("c", "a")]),
            Some(vec!["a".into(), "b".into(), "c".into(), "a".into()])
        );
    }

    #[test]
    fn a_window_needs_both_ends_in_order_and_a_due_inside() {
        assert_eq!(cleared_or_window(None, None, None).ok(), Some(None));
        assert!(cleared_or_window(Some(1), None, None).is_err());
        assert!(cleared_or_window(Some(2), Some(2), None).is_err());
        assert!(cleared_or_window(Some(1), Some(3), Some(4)).is_err());
        assert!(cleared_or_window(Some(1), Some(3), Some(3)).is_ok());
    }

    #[test]
    fn an_item_opens_at_the_later_of_its_window_and_the_course_start() {
        let w = Window { from: 100, until: 1000, due: None };
        assert_eq!(release_opens_at(Some(w), None, Some(200), 50), Some(200));
        assert_eq!(release_opens_at(Some(w), None, Some(50), 60), Some(100));
        assert_eq!(release_opens_at(Some(w), None, Some(2000), 50), None);
        assert_eq!(release_opens_at(None, None, Some(200), 50), Some(200));
    }
}
