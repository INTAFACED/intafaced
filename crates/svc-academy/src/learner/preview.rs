//! AC-catalogue-03: a course as a new learner sees it, for staff (Preview as new learner) and for a visitor holding a
//! private link to the course's unlisted page (`curriculum/course-preview.ts`).
//!
//! Built from the stored course and outline: each item shows its lock (`enrol` until the reader enrols,
//! `enrolment_closed` while the course is not published, `not_released` while no lesson revision is published,
//! `scheduled` while its section has not opened). Reading writes nothing. A private link's key is 32 random bytes shown
//! once; only its SHA-256 is stored. An unknown, revoked or mismatched link, and a course that is archived or deleted,
//! give the same `academy.course_not_found`.

use super::sql::Pool;
use base64::Engine as _;
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use sha2::{Digest, Sha256};

use super::purchases::canonical_price;
use super::sql::{self, cell, first, iso, ms, q};
use crate::errors::{AcademyError, Refusal};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The states a private link opens in.
const LINK_OPENS: [&str; 3] = ["draft", "published", "concluded"];

fn course_not_found(message: &str) -> Refusal {
    AcademyError::new(message, "academy.course_not_found").into()
}

/// `academyPrivateLinkKeySchema`: `^[A-Za-z0-9_-]{43}$`.
pub fn is_link_key(key: &str) -> bool {
    key.len() == 43
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// `keyHash(key)`: SHA-256 of the key's UTF-8, as hex.
pub fn key_hash(key: &str) -> String {
    Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

const LINK_COLUMNS: &str = "id::text, reason, created_by::text, created_at_ms, revoked_by::text, revoked_at_ms, revoke_reason";

fn link_columns() -> String {
    LINK_COLUMNS
        .replace("created_at_ms", &ms("created_at"))
        .replace("revoked_at_ms", &ms("revoked_at"))
}

/// `linkOf`.
fn link_of(r: &Row) -> Result<Json, Refusal> {
    let opt = |i: usize| -> Result<Json, Refusal> {
        Ok(cell::<Option<String>>(r, i)?.map_or(Json::Null, Json::String))
    };
    Ok(Json::obj([
        ("id", Json::String(cell(r, 0)?)),
        ("reason", Json::String(cell(r, 1)?)),
        ("createdBy", Json::String(cell(r, 2)?)),
        ("createdAt", Json::str(iso(cell(r, 3)?))),
        ("revokedBy", opt(4)?),
        (
            "revokedAt",
            cell::<Option<i64>>(r, 5)?.map_or(Json::Null, |t| Json::str(iso(t))),
        ),
        ("revokeReason", opt(6)?),
    ]))
}

pub struct CoursePreview<'a> {
    pub pool: &'a Pool,
}

impl CoursePreview<'_> {
    /// Preview as new learner. Staff only; writes nothing.
    pub fn preview(&self, course_id: &str, now: i64) -> Result<Json, Refusal> {
        self.view(course_id, None, now)?
            .ok_or_else(|| course_not_found("no course has this id"))
    }

    /// The unlisted page through a private link.
    pub fn by_link(&self, slug: &str, key: &str, now: i64) -> Result<Json, Refusal> {
        if !is_link_key(key) {
            return Err(course_not_found("no course is open at this link"));
        }
        let hash = key_hash(key);
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT l.course_id::text FROM academy.course_private_links l \
                 JOIN academy.courses c ON c.id = l.course_id \
                 WHERE l.key_sha256 = $1 AND l.revoked_at IS NULL AND c.slug = $2 \
                   AND c.state IN ('draft', 'published', 'concluded')",
                &[&hash, &slug],
            )
        })?;
        let view = match row {
            Some(r) => self.view(&cell::<String>(&r, 0)?, None, now)?,
            None => None,
        };
        view.ok_or_else(|| course_not_found("no course is open at this link"))
    }

    /// The course's private links, newest first, without their keys.
    pub fn links(&self, course_id: &str) -> Result<Json, Refusal> {
        let exists = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT 1 FROM academy.courses WHERE id = $1::text::uuid",
                &[&course_id],
            )
        })?;
        if exists.is_none() {
            return Err(course_not_found("no course has this id"));
        }
        let rows = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT {} FROM academy.course_private_links WHERE course_id = $1::text::uuid \
                     ORDER BY created_at DESC, id",
                    link_columns()
                ),
                &[&course_id],
            )
        })?;
        Ok(Json::Array(
            rows.iter().map(link_of).collect::<Result<_, _>>()?,
        ))
    }

    /// A new link to the unlisted page. The key comes back once, here.
    pub fn create_link(
        &self,
        course_id: &str,
        reason: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let course = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT slug, state FROM academy.courses WHERE id = $1::text::uuid",
                &[&course_id],
            )
        })?
        .ok_or_else(|| course_not_found("no course has this id"))?;
        let slug: String = cell(&course, 0)?;
        let state: String = cell(&course, 1)?;
        if !LINK_OPENS.contains(&state.as_str()) {
            return Err(AcademyError::new(
                format!("a private link opens nothing while the course is {state}"),
                "academy.private_link_course_closed",
            )
            .into());
        }
        let mut bytes = [0u8; 32];
        getrandom_fill(&mut bytes)?;
        let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let hash = key_hash(&key);
        let at = iso(now);
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "INSERT INTO academy.course_private_links (course_id, key_sha256, reason, created_by, created_at) \
                     VALUES ($1::text::uuid, $2, $3, $4::text::uuid, $5::text::timestamptz) RETURNING {}",
                    link_columns()
                ),
                &[&course_id, &hash, &reason, &operator_id, &at],
            )
        })?
        .ok_or_else(|| Refusal::db("INSERT returned no row", None))?;
        let path = format!(
            "/academy/learning/course/{}#key={key}",
            encode_uri_component(&slug)
        );
        Ok(Json::obj([
            ("link", link_of(&row)?),
            ("key", Json::str(key)),
            ("path", Json::str(path)),
        ]))
    }

    /// The link stops opening the page. A repeat answers with the link as it was first revoked.
    pub fn revoke_link(
        &self,
        link_id: &str,
        reason: &str,
        operator_id: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let at = iso(now);
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "UPDATE academy.course_private_links \
                     SET revoked_by = $1::text::uuid, revoked_at = $2::text::timestamptz, revoke_reason = $3 \
                     WHERE id = $4::text::uuid AND revoked_at IS NULL RETURNING {}",
                    link_columns()
                ),
                &[&operator_id, &at, &reason, &link_id],
            )
        })?;
        if let Some(r) = row {
            return link_of(&r);
        }
        let stored = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "SELECT {} FROM academy.course_private_links WHERE id = $1::text::uuid",
                    link_columns()
                ),
                &[&link_id],
            )
        })?;
        match stored {
            Some(r) => link_of(&r),
            None => Err(AcademyError::new(
                "no private link has this id",
                "academy.private_link_not_found",
            )
            .into()),
        }
    }

    /// The course row and its outline from one snapshot (repeatable read, read only).
    pub fn view(
        &self,
        course_id: &str,
        reader_id: Option<&str>,
        now: i64,
    ) -> Result<Option<Json>, Refusal> {
        sql::begin_repeatable_read_only(self.pool, |tx| view_in(tx, course_id, reader_id, now))
    }
}

fn getrandom_fill(bytes: &mut [u8]) -> Result<(), Refusal> {
    getrandom::fill(bytes).map_err(|e| Refusal::Internal {
        message: e.to_string(),
        code: None,
    })
}

/// `viewIn(tx, courseId, readerId, now)`.
pub fn view_in(
    tx: &mut impl GenericClient,
    course_id: &str,
    reader_id: Option<&str>,
    now: i64,
) -> Result<Option<Json>, Refusal> {
    let Some(course) = first(
        tx,
        "SELECT c.slug, c.title, c.summary, c.thumbnail_url, c.pricing, c.price::text, c.price_asset, c.state, p.pacing \
         FROM academy.courses c LEFT JOIN academy.course_pacing p ON p.course_id = c.id WHERE c.id = $1::text::uuid",
        &[&course_id],
    )?
    else {
        return Ok(None);
    };
    let enrolled_at: Option<i64> = match reader_id {
        None => None,
        Some(reader) => first(
            tx,
            &format!(
                "SELECT {} FROM academy.course_enrolments \
                 WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND left_at IS NULL",
                ms("enrolled_at")
            ),
            &[&course_id, &reader],
        )?
        .map(|r| cell(&r, 0))
        .transpose()?,
    };
    let enrolled = enrolled_at.is_some();
    let state: String = cell(&course, 7)?;
    let rows = q(
        tx,
        &format!(
            "SELECT s.id::text AS section_id, s.title AS section_title, {}, r.after_days::int4, i.id::text, i.kind, \
               i.title, i.indent::int4, i.live_revision::int4, (a.item_id IS NOT NULL) AS assignment_open \
             FROM academy.course_sections s \
             LEFT JOIN academy.course_section_releases r ON r.section_id = s.id \
             LEFT JOIN academy.course_items i ON i.section_id = s.id \
             LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
             WHERE s.course_id = $1::text::uuid \
             ORDER BY s.position, i.position",
            ms("r.release_at")
        ),
        &[&course_id],
    )?;
    /// A section being built: its id, whether it is open, its head fields and its items.
    type Section = (String, bool, Vec<(String, Json)>, Vec<Json>);
    let mut sections: Vec<Section> = Vec::new();
    for r in &rows {
        let section_id: String = cell(r, 0)?;
        if sections.last().map(|s| &s.0) != Some(&section_id) {
            let release_at: Option<i64> = cell(r, 2)?;
            let after_days: Option<i32> = cell(r, 3)?;
            // `ruleOf` then `opensAt`.
            let (release, open) = match (release_at, after_days) {
                (None, None) => (Json::Null, true),
                (Some(at), _) => {
                    let open = at <= now;
                    (
                        Json::obj([
                            ("at", Json::str(iso(at))),
                            ("afterEnrolmentDays", Json::Null),
                            ("open", Json::Bool(open)),
                        ]),
                        open,
                    )
                }
                (None, Some(days)) => {
                    let at = enrolled_at.map(|e| e + i64::from(days) * DAY_MS);
                    let open = at.is_some_and(|a| a <= now);
                    (
                        Json::obj([
                            ("at", at.map_or(Json::Null, |a| Json::str(iso(a)))),
                            ("afterEnrolmentDays", Json::int(i64::from(days))),
                            ("open", Json::Bool(open)),
                        ]),
                        open,
                    )
                }
            };
            let head = vec![
                ("title".to_owned(), Json::String(cell(r, 1)?)),
                ("release".to_owned(), release),
            ];
            sections.push((section_id, open, head, Vec::new()));
        }
        let id: Option<String> = cell(r, 4)?;
        let kind: Option<String> = cell(r, 5)?;
        let title: Option<String> = cell(r, 6)?;
        let (Some(id), Some(kind), Some(title)) = (id, kind, title) else {
            continue;
        };
        let indent: Option<i32> = cell(r, 7)?;
        let live: Option<i32> = cell(r, 8)?;
        let assignment_open: bool = cell(r, 9)?;
        let released = kind == "link"
            || if kind == "assignment" {
                assignment_open
            } else {
                live.is_some()
            };
        let Some(current) = sections.last_mut() else {
            continue;
        };
        let lock = if kind == "subheader" {
            Json::Null
        } else if !released {
            Json::str("not_released")
        } else if enrolled {
            if current.1 {
                Json::Null
            } else {
                Json::str("scheduled")
            }
        } else if state == "published" {
            Json::str("enrol")
        } else {
            Json::str("enrolment_closed")
        };
        current.3.push(Json::obj([
            ("id", Json::String(id)),
            ("kind", Json::String(kind)),
            ("title", Json::String(title)),
            ("indent", Json::int(i64::from(indent.unwrap_or(0)))),
            ("lock", lock),
        ]));
    }
    let opt = |i: usize| -> Result<Json, Refusal> {
        Ok(cell::<Option<String>>(&course, i)?.map_or(Json::Null, Json::String))
    };
    let price: Option<String> = cell(&course, 5)?;
    Ok(Some(Json::obj([
        ("slug", Json::String(cell(&course, 0)?)),
        ("title", Json::String(cell(&course, 1)?)),
        ("summary", opt(2)?),
        ("thumbnailUrl", opt(3)?),
        ("pricing", Json::String(cell(&course, 4)?)),
        (
            "price",
            price.map_or(Json::Null, |p| Json::str(canonical_price(&p))),
        ),
        ("priceAsset", opt(6)?),
        ("state", Json::String(state)),
        ("pacing", opt(8)?),
        (
            "sections",
            Json::Array(
                sections
                    .into_iter()
                    .map(|(_, _, mut head, items)| {
                        head.push(("items".to_owned(), Json::Array(items)));
                        Json::Object(head)
                    })
                    .collect(),
            ),
        ),
    ])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_43_base64url_characters_and_only_its_hash_is_kept() {
        assert!(is_link_key(&"a".repeat(43)));
        assert!(!is_link_key(&"a".repeat(42)));
        assert!(!is_link_key(&format!("{}=", "a".repeat(42))));
        assert_eq!(
            key_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(encode_uri_component("a b/ç"), "a%20b%2F%C3%A7");
    }
}
