//! Learning programmes (`curriculum/programme-records.ts` `ProgrammeRecords`) and how a learner stands on one
//! (`academy-service.ts` `programme`, `programmes`, `learnerCourses`, `programmeStanding`, `issueProgrammeCert`). A
//! programme's certificate is written once, keyed `cert:<user>:<cert>`, when every course of a non-empty programme is
//! complete; a revoked certificate stays revoked. No XP and no money move here.

use postgres::GenericClient;

use service_kit::json::Json;
use crate::db::Store;
use service_kit::schema::Value;

use super::sql::{self, at, first, get, iso, ms, query};
use super::{refuse, text};
use crate::curriculum::spine;
use crate::errors::Refusal;

/// `ACADEMY_PROGRAMME_RESERVED_SLUGS`.
const RESERVED: [&str; 1] = ["invitations"];
const CERT_PREFIX: &str = "programme:";

/// `AcademyProgrammeRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub course_slugs: Vec<String>,
    pub revision: i64,
    pub updated_at: i64,
}

impl Record {
    pub fn json(&self) -> Json {
        Json::obj([
            ("slug", Json::str(&self.slug)),
            ("title", Json::str(&self.title)),
            ("summary", Json::str(&self.summary)),
            ("courseSlugs", Json::Array(self.course_slugs.iter().map(Json::str).collect())),
            ("revision", Json::int(self.revision)),
            ("updatedAt", Json::String(iso(self.updated_at))),
        ])
    }
}

/// Which programmes a read keeps.
#[derive(Default)]
pub struct Where<'a> {
    pub slug: Option<&'a str>,
    pub limit: Option<i64>,
    pub mine: Option<(Vec<String>, Vec<String>)>,
}

/// `ProgrammeRecords.select`.
pub fn select<C: GenericClient>(c: &mut C, w: &Where<'_>) -> Result<Vec<Record>, Refusal> {
    let mut params: Vec<Box<dyn postgres::types::ToSql + Sync>> = Vec::new();
    let mut clauses = Vec::new();
    if let Some(s) = w.slug {
        params.push(Box::new(s.to_owned()));
        clauses.push(format!("p.slug = ${}::text", params.len()));
    }
    if let Some((earned, courses)) = &w.mine {
        params.push(Box::new(earned.clone()));
        let e = params.len();
        params.push(Box::new(courses.clone()));
        let k = params.len();
        clauses.push(format!(
            "(p.slug = ANY(${e}::text[]) OR EXISTS (SELECT 1 FROM academy.programme_courses c \
             WHERE c.programme_slug = p.slug AND c.course_slug = ANY(${k}::text[])))"
        ));
    }
    let limit = match w.limit {
        Some(n) => {
            params.push(Box::new(n));
            format!("LIMIT ${}::int8", params.len())
        }
        None => "LIMIT ALL".to_owned(),
    };
    let filter = if clauses.is_empty() { "TRUE".to_owned() } else { clauses.join(" AND ") };
    let refs: Vec<sql::P<'_>> = params.iter().map(|p| p.as_ref() as sql::P<'_>).collect();
    query(
        c,
        &format!(
            "SELECT p.slug, p.title, p.summary, p.revision, {} AS updated_at, \
               (SELECT array_agg(c.course_slug ORDER BY c.position) FROM academy.programme_courses c WHERE c.programme_slug = p.slug) AS course_slugs \
             FROM academy.programmes p WHERE {filter} ORDER BY p.created_at DESC, p.slug {limit}",
            ms("p.updated_at")
        ),
        &refs,
    )?
    .iter()
    .map(|r| {
        Ok(Record {
            slug: get(r, "slug")?,
            title: get(r, "title")?,
            summary: get(r, "summary")?,
            course_slugs: get::<Option<Vec<String>>>(r, "course_slugs")?.unwrap_or_default(),
            revision: sql::int(r, "revision")?,
            updated_at: get(r, "updated_at")?,
        })
    })
    .collect()
}

/// A curriculum path with published items.
fn is_published(course: &str) -> bool {
    !spine::list(Some(course), None).is_empty()
}

/// `assertProgrammeSave`.
pub fn assert_save(slug: &str, courses: &[&str], max: Option<i64>) -> Result<(), Refusal> {
    if RESERVED.contains(&slug) {
        return refuse(format!("slug \"{slug}\" is a reserved academy address"), "academy.slug_reserved");
    }
    for c in courses {
        if !is_published(c) {
            return refuse(format!("academy.path_not_found course={c}"), "academy.path_not_found");
        }
    }
    if courses.is_empty() {
        return Ok(());
    }
    let Some(max) = max else {
        return refuse("academy.programme_limit_unset", "academy.programme_limit_unset");
    };
    if i64::try_from(courses.len()).unwrap_or(i64::MAX) > max {
        return refuse(format!("academy.programme_too_large max={max}"), "academy.programme_too_large");
    }
    Ok(())
}

/// `ProgrammeRecords.save`: the checks, then one serializable transaction under the programme's advisory lock.
pub fn save(pool: &Store, input: &Value, operator: &str, now: i64, max: Option<i64>) -> Result<Json, Refusal> {
    let slug = text(input, "slug");
    let title = text(input, "title");
    let summary = text(input, "summary");
    let reason = text(input, "reason");
    let courses: Vec<&str> = input
        .get("courseSlugs")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let expected = super::opt_int(input, "expectedRevision");
    assert_save(slug, &courses, max)?;
    let lock = format!("programme:{slug}");
    let record = sql::serializable(pool, |tx| {
        sql::exec(tx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", &[&lock])?;
        let current = select(
            tx,
            &Where {
                slug: Some(slug),
                ..Where::default()
            },
        )?
        .into_iter()
        .next();
        if let Some(c) = &current
            && c.title == title
            && c.summary == summary
            && c.course_slugs.iter().map(String::as_str).eq(courses.iter().copied())
        {
            return Ok(c.clone());
        }
        match (expected, &current) {
            (None, Some(_)) => return refuse(format!("academy.programme_slug_taken slug={slug}"), "academy.programme_slug_taken"),
            (Some(_), None) => return refuse(format!("academy.programme_not_found slug={slug}"), "academy.programme_not_found"),
            (Some(e), Some(c)) if c.revision != e => {
                return refuse(format!("academy.revision_stale revision={}", c.revision), "academy.revision_stale");
            }
            _ => {}
        }
        let revision = i32::try_from(current.as_ref().map_or(0, |c| c.revision) + 1).unwrap_or(i32::MAX);
        sql::exec(
            tx,
            "INSERT INTO academy.programmes (slug, title, summary, revision, created_by, created_at, updated_at) \
             VALUES ($1::text, $2::text, $3::text, $4::int4, $5::text::uuid, $6::text::timestamptz, $6::text::timestamptz) \
             ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, \
               revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at",
            &[&slug, &title, &summary, &revision, &operator, &at(now)],
        )?;
        sql::exec(tx, "DELETE FROM academy.programme_courses WHERE programme_slug = $1::text", &[&slug])?;
        for (position, course) in courses.iter().enumerate() {
            let pos = i32::try_from(position).unwrap_or(i32::MAX);
            sql::exec(
                tx,
                "INSERT INTO academy.programme_courses (programme_slug, position, course_slug) VALUES ($1::text, $2::int4, $3::text)",
                &[&slug, &pos, course],
            )?;
        }
        let list: Vec<String> = courses.iter().map(|c| (*c).to_owned()).collect();
        sql::exec(
            tx,
            "INSERT INTO academy.programme_events (programme_slug, revision, course_slugs, operator_id, reason, recorded_at) \
             VALUES ($1::text, $2::int4, $3::text[], $4::text::uuid, $5::text, $6::text::timestamptz)",
            &[&slug, &revision, &list, &operator, &reason, &at(now)],
        )?;
        select(
            tx,
            &Where {
                slug: Some(slug),
                ..Where::default()
            },
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Refusal::Internal {
            message: "the saved programme was not read back".to_owned(),
            code: None,
        })
    })?;
    Ok(record.json())
}

/// `adminProgrammes(limit)`.
pub fn admin_list(pool: &Store, limit: i64) -> Result<Json, Refusal> {
    let rows = sql::client(pool, |c| {
        select(
            c,
            &Where {
                limit: Some(limit),
                ..Where::default()
            },
        )
    })?;
    Ok(Json::Array(rows.iter().map(Record::json).collect()))
}

/// A programme certificate the learner holds.
#[derive(Debug, Clone)]
struct Grant {
    public_id: String,
    granted_at: i64,
    status: &'static str,
}

/// `LearnerCourses`.
struct Learner {
    completed: Vec<String>,
    enrolled: Vec<String>,
    started: Vec<String>,
    grants: Vec<(String, Grant)>,
}

fn status_of(s: &str) -> &'static str {
    if s == "revoked" { "revoked" } else { "valid" }
}

/// `learnerCourses(userId)`: completions, published enrolments, then programme certificates.
fn learner<C: GenericClient>(c: &mut C, user_id: &str) -> Result<Learner, Refusal> {
    let completed: Vec<String> = query(
        c,
        "SELECT item_slug FROM academy.cert_item_completions WHERE user_id = $1::text::uuid",
        &[&user_id],
    )?
    .iter()
    .map(|r| get(r, "item_slug"))
    .collect::<Result<_, _>>()?;
    let enrolled: Vec<String> = query(
        c,
        "SELECT path_slug FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL \
         ORDER BY enrolled_at ASC, path_slug ASC",
        &[&user_id],
    )?
    .iter()
    .map(|r| get::<String>(r, "path_slug"))
    .collect::<Result<Vec<_>, _>>()?
    .into_iter()
    .filter(|p| is_published(p))
    .collect();
    let grants = query(
        c,
        &format!(
            "SELECT cert_id, {} AS granted_at, public_id, status FROM academy.cert_grants \
             WHERE user_id = $1::text::uuid AND starts_with(cert_id, $2::text)",
            ms("granted_at")
        ),
        &[&user_id, &CERT_PREFIX],
    )?
    .iter()
    .map(|r| {
        let cert: String = get(r, "cert_id")?;
        let status: String = get(r, "status")?;
        Ok((
            cert.get(CERT_PREFIX.len()..).unwrap_or("").to_owned(),
            Grant {
                public_id: get(r, "public_id")?,
                granted_at: get(r, "granted_at")?,
                status: status_of(&status),
            },
        ))
    })
    .collect::<Result<Vec<_>, Refusal>>()?;
    let mut started = enrolled.clone();
    for p in spine::PATHS {
        let items = spine::list(Some(p), None);
        if !items.is_empty() && items.iter().all(|i| completed.contains(&i.slug)) && !started.iter().any(|s| s == p) {
            started.push(p.to_owned());
        }
    }
    Ok(Learner {
        completed,
        enrolled,
        started,
        grants,
    })
}

/// `issueProgrammeCert`: the grant once, then the row as stored.
fn issue<C: GenericClient>(c: &mut C, user_id: &str, cert_id: &str, now: i64) -> Result<Grant, Refusal> {
    let key = format!("cert:{user_id}:{cert_id}");
    let public_id = sql::random_hex::<16>()?;
    sql::exec(
        c,
        "INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key, public_id, design_revision) \
         VALUES ($1::text::uuid, $2::text, $3::text::timestamptz, $4::text, $5::text, \
                 (SELECT active_revision FROM academy.cert_designs WHERE cert_id = $2::text)) \
         ON CONFLICT (user_id, cert_id) DO NOTHING \
         RETURNING user_id, cert_id, granted_at, idempotency_key, public_id",
        &[&user_id, &cert_id, &at(now), &key, &public_id],
    )?;
    let Some(r) = first(
        c,
        &format!(
            "SELECT user_id, cert_id, {} AS granted_at, idempotency_key, public_id, status FROM academy.cert_grants \
             WHERE user_id = $1::text::uuid AND cert_id = $2::text",
            ms("granted_at")
        ),
        &[&user_id, &cert_id],
    )?
    else {
        return refuse(format!("Programme certificate left no row for {cert_id}"), "academy.cert_invalid");
    };
    let status: String = get(&r, "status")?;
    Ok(Grant {
        public_id: get(&r, "public_id")?,
        granted_at: get(&r, "granted_at")?,
        status: status_of(&status),
    })
}

/// `programmeStanding`.
fn standing<C: GenericClient>(c: &mut C, user_id: &str, record: &Record, l: &Learner, now: i64) -> Result<Json, Refusal> {
    let mut rows = Vec::new();
    let (mut done, mut enrolled, mut not) = (0, 0, 0);
    for slug in &record.course_slugs {
        let items = spine::list(Some(slug), None);
        let completed = items.iter().filter(|i| l.completed.contains(&i.slug)).count();
        let state = if !items.is_empty() && completed == items.len() {
            done += 1;
            "completed"
        } else if l.enrolled.contains(slug) {
            enrolled += 1;
            "enrolled"
        } else {
            not += 1;
            "not_enrolled"
        };
        rows.push(Json::obj([
            ("slug", Json::str(slug)),
            ("state", Json::str(state)),
            ("items", Json::int(i64::try_from(items.len()).unwrap_or(0))),
            ("completed", Json::int(i64::try_from(completed).unwrap_or(0))),
        ]));
    }
    let cert_id = format!("{CERT_PREFIX}{}", record.slug);
    let finished = !record.course_slugs.is_empty() && done == record.course_slugs.len();
    let held = l.grants.iter().find(|(s, _)| *s == record.slug).map(|(_, g)| g.clone());
    let grant = match held {
        Some(g) => Some(g),
        None if finished => Some(issue(c, user_id, &cert_id, now)?),
        None => None,
    };
    let certificate = match grant {
        Some(g) => Json::obj([
            ("state", Json::str("earned")),
            ("certId", Json::str(&cert_id)),
            ("publicId", Json::String(g.public_id)),
            ("grantedAt", Json::String(iso(g.granted_at))),
            ("status", Json::str(g.status)),
        ]),
        None => Json::obj([("state", Json::str("not_earned")), ("certId", Json::str(&cert_id))]),
    };
    let n = |x: usize| Json::int(i64::try_from(x).unwrap_or(0));
    Ok(Json::obj([
        ("slug", Json::str(&record.slug)),
        ("title", Json::str(&record.title)),
        ("summary", Json::str(&record.summary)),
        ("courses", Json::Array(rows)),
        ("counts", Json::obj([("completed", n(done)), ("enrolled", n(enrolled)), ("notEnrolled", n(not))])),
        ("certificate", certificate),
    ]))
}

/// `programme({ userId, slug })`.
pub fn programme(pool: &Store, user_id: &str, slug: &str, now: i64) -> Result<Json, Refusal> {
    sql::client(pool, |c| {
        let Some(record) = select(
            c,
            &Where {
                slug: Some(slug),
                ..Where::default()
            },
        )?
        .into_iter()
        .next() else {
            return refuse(format!("academy.programme_not_found slug={slug}"), "academy.programme_not_found");
        };
        let l = learner(c, user_id)?;
        standing(c, user_id, &record, &l, now)
    })
}

/// `programmes({ userId, limit, mine })`.
pub fn programmes(pool: &Store, user_id: &str, limit: i64, mine: bool, now: i64) -> Result<Json, Refusal> {
    sql::client(pool, |c| {
        let l = learner(c, user_id)?;
        let records = select(
            c,
            &Where {
                limit: Some(limit),
                mine: mine.then(|| (l.grants.iter().map(|(s, _)| s.clone()).collect(), l.started.clone())),
                ..Where::default()
            },
        )?;
        let mut out = Vec::new();
        for r in &records {
            out.push(standing(c, user_id, r, &l, now)?);
        }
        Ok(Json::Array(out))
    })
}

/// `PROGRAMME_SLUGS` (`curriculum/programmes.ts`): the four Blueprint paths a programme definition names.
pub const PROGRAMME_SLUGS: [&str; 4] = ["foundations", "markets", "builder", "sovereign"];

/// `ProgrammeDefinition`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definition {
    pub slug: &'static str,
    pub prerequisites: Vec<String>,
}

/// `PROGRAMME_CATALOG`: none of the owner's prerequisites is authored, so every path ships an empty list.
pub fn catalog() -> Vec<Definition> {
    PROGRAMME_SLUGS.iter().map(|slug| Definition { slug, prerequisites: Vec::new() }).collect()
}

/// `assertProgrammeCatalog`: the `ProgrammeCatalogError` message, when the list is not a catalog.
pub fn assert_catalog(defs: &[Definition]) -> Result<(), String> {
    let mut slugs: Vec<&str> = defs.iter().map(|d| d.slug).collect();
    slugs.sort_unstable();
    slugs.dedup();
    if slugs.len() != defs.len() {
        return Err("duplicate programme slug".to_owned());
    }
    if let Some(missing) = PROGRAMME_SLUGS.iter().find(|s| !slugs.contains(s)) {
        return Err(format!("programme catalog missing {missing}"));
    }
    for def in defs {
        if let Some(pre) = def.prerequisites.iter().find(|p| !slugs.contains(&p.as_str())) {
            return Err(format!("unknown prerequisite slug: {pre}"));
        }
    }
    Ok(())
}

/// `programmeBySlug`.
pub fn by_slug<'a>(defs: &'a [Definition], slug: &str) -> Option<&'a Definition> {
    defs.iter().find(|d| d.slug == slug)
}

/// `unmetPrerequisites`: the prerequisite slugs the caller holds no active enrolment for.
pub fn unmet(def: &Definition, active: &[String]) -> Vec<String> {
    def.prerequisites.iter().filter(|p| !active.contains(p)).cloned().collect()
}
