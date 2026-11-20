//! Residency applications, stage 1: apply, withdraw, an operator's accept or reject, and the published cohorts
//! (`ambassadors/residency.ts`, the residency part of `academy-service.ts`, `learning/customer-store.ts`
//! `residencyCohorts`). No pay: IFC pay and revenue share are Class M and refuse closed in `ifc_pay`.

use postgres::{Client, Row};
use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::pg::{Param, Text, ms};
use super::programme::js_len;
use crate::db::{self, UNIQUE_VIOLATION};
use crate::errors::{AcademyError, Refusal};

/// `ResidencyApplication`. Times are milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResidencyApplication {
    pub id: String,
    pub user_id: String,
    pub cohort_slug: String,
    pub statement: String,
    /// `applied`, `accepted`, `rejected` or `withdrawn`.
    pub status: String,
    pub applied_at: i64,
    pub decided_at: Option<i64>,
    pub decided_by: Option<String>,
    pub decision_note: Option<String>,
}

fn opt_text(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

fn opt_iso(t: Option<i64>) -> Json {
    t.map_or(Json::Null, |v| Json::str(Instant(v).iso()))
}

impl ResidencyApplication {
    /// `residencyOut`, in its key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("userId".to_owned(), Json::str(self.user_id.clone())),
            ("cohortSlug".to_owned(), Json::str(self.cohort_slug.clone())),
            ("statement".to_owned(), Json::str(self.statement.clone())),
            ("status".to_owned(), Json::str(self.status.clone())),
            (
                "appliedAt".to_owned(),
                Json::str(Instant(self.applied_at).iso()),
            ),
            ("decidedAt".to_owned(), opt_iso(self.decided_at)),
            ("decidedBy".to_owned(), opt_text(self.decided_by.as_ref())),
            (
                "decisionNote".to_owned(),
                opt_text(self.decision_note.as_ref()),
            ),
        ]
    }

    pub fn to_json(&self) -> Json {
        Json::Object(self.fields())
    }
}

/// `assertResidencyPageLimit`.
pub fn assert_residency_page_limit(limit: Option<f64>) -> Result<usize, AcademyError> {
    let refuse = || {
        AcademyError::new(
            "Residency list limit is unset — pass limit (never invent all.length)",
            "academy.residency_list_limit_unset",
        )
    };
    let n = limit.filter(|n| n.is_finite()).ok_or_else(refuse)?.floor();
    if n < 1.0 {
        return Err(refuse());
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a finite whole number of at least one"
    )]
    Ok(if n > 200.0 { 200 } else { n as usize })
}

/// `assertCohortSlug`: trimmed, lower-cased, `/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/`.
pub fn assert_cohort_slug(slug: &str) -> Result<String, AcademyError> {
    let s = js_trim(slug).to_lowercase();
    let b = s.as_bytes();
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let ok = (3..=48).contains(&b.len())
        && b.first().copied().is_some_and(edge)
        && b.last().copied().is_some_and(edge)
        && b.iter().all(|c| edge(*c) || *c == b'-');
    if !ok {
        return Err(AcademyError::new(
            "Cohort slug must be 3–48 lowercase alphanumeric + hyphen",
            "academy.residency_invalid",
        ));
    }
    Ok(s)
}

/// `assertStatement`: trimmed, 20 to 2000 characters.
pub fn assert_statement(statement: &str) -> Result<String, AcademyError> {
    let t = js_trim(statement);
    if js_len(t) < 20 {
        return Err(AcademyError::new(
            "Statement min 20 characters after trim",
            "academy.residency_invalid",
        ));
    }
    if js_len(t) > 2000 {
        return Err(AcademyError::new(
            "Statement max 2000 characters",
            "academy.residency_invalid",
        ));
    }
    Ok(t.to_owned())
}

/// `(note ?? '').trim().slice(0, 500) || null`: the first 500 UTF-16 units of the trimmed note, none when blank.
pub fn decision_note(note: Option<&str>) -> Option<String> {
    let t = js_trim(note.unwrap_or_default());
    let units: Vec<u16> = t.encode_utf16().take(500).collect();
    let cut = String::from_utf16_lossy(&units);
    (!cut.is_empty()).then_some(cut)
}

const COLUMNS: &str = "id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note";

fn row(r: &Row) -> Result<ResidencyApplication, Refusal> {
    let get = |e: postgres::Error| db::refusal(&e);
    Ok(ResidencyApplication {
        id: r.try_get::<_, Text>(0).map_err(get)?.0,
        user_id: r.try_get::<_, Text>(1).map_err(get)?.0,
        cohort_slug: r.try_get::<_, Text>(2).map_err(get)?.0,
        statement: r.try_get::<_, Text>(3).map_err(get)?.0,
        status: r.try_get::<_, Text>(4).map_err(get)?.0,
        applied_at: ms(r.try_get(5).map_err(get)?),
        decided_at: r
            .try_get::<_, Option<std::time::SystemTime>>(6)
            .map_err(get)?
            .map(ms),
        decided_by: r.try_get::<_, Option<Text>>(7).map_err(get)?.map(|t| t.0),
        decision_note: r.try_get::<_, Option<Text>>(8).map_err(get)?.map(|t| t.0),
    })
}

fn rows(found: &[Row]) -> Result<Vec<ResidencyApplication>, Refusal> {
    found.iter().map(row).collect()
}

fn not_found() -> Refusal {
    AcademyError::new("Application not found", "academy.residency_not_found").into()
}

fn not_pending(status: &str) -> Refusal {
    AcademyError::new(
        format!("Application is {status}"),
        "academy.residency_not_pending",
    )
    .into()
}

/// The slug and statement `applyResidency` checks before its insert.
pub fn check_application(
    cohort_slug: &str,
    statement: &str,
) -> Result<(String, String), AcademyError> {
    Ok((
        assert_cohort_slug(cohort_slug)?,
        assert_statement(statement)?,
    ))
}

/// `applyResidency` past its checks: one open application per user and cohort (the partial unique index), a second
/// refused by its unique violation.
pub fn apply_residency(
    c: &mut Client,
    user_id: &str,
    cohort_slug: &str,
    statement: &str,
) -> Result<ResidencyApplication, Refusal> {
    let inserted = c.query(
        &format!(
            "
        INSERT INTO academy.residency_applications
          (user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note, updated_at)
        VALUES
          ($1, $2, $3, 'applied', now(), NULL, NULL, NULL, now())
        RETURNING {COLUMNS}
      "
        ),
        &[&Param(user_id), &Param(cohort_slug), &Param(statement)],
    );
    match inserted {
        Ok(found) => rows(&found)?
            .into_iter()
            .next()
            .ok_or_else(|| Refusal::db("the insert returned no row", None)),
        Err(e) if db::sqlstate(&e).as_deref() == Some(UNIQUE_VIOLATION) => Err(AcademyError::new(
            "Open application already exists for this cohort",
            "academy.residency_already_open",
        )
        .into()),
        Err(e) => Err(db::refusal(&e)),
    }
}

/// `withdrawResidency`: the applicant's own open application only; someone else's reads as not found.
pub fn withdraw_residency(
    c: &mut Client,
    id: &str,
    user_id: &str,
) -> Result<ResidencyApplication, Refusal> {
    let updated = c
        .query(
            &format!(
                "
      UPDATE academy.residency_applications
         SET status = 'withdrawn',
             decided_at = now(),
             decided_by = $1,
             decision_note = 'withdrawn by applicant',
             updated_at = now()
       WHERE id = $2
         AND user_id = $3
         AND status = 'applied'
       RETURNING {COLUMNS}
    "
            ),
            &[&Param(user_id), &Param(id), &Param(user_id)],
        )
        .map_err(|e| db::refusal(&e))?;
    if let Some(r) = rows(&updated)?.into_iter().next() {
        return Ok(r);
    }
    let existing = c
        .query(
            "
        SELECT status, user_id FROM academy.residency_applications WHERE id = $1
      ",
            &[&Param(id)],
        )
        .map_err(|e| db::refusal(&e))?;
    let Some(first) = existing.first() else {
        return Err(not_found());
    };
    let status = first.try_get::<_, Text>(0).map_err(|e| db::refusal(&e))?.0;
    let owner = first.try_get::<_, Text>(1).map_err(|e| db::refusal(&e))?.0;
    if owner != user_id {
        return Err(not_found());
    }
    Err(not_pending(&status))
}

/// `decideResidency`: an open application only.
pub fn decide_residency(
    c: &mut Client,
    id: &str,
    operator_id: &str,
    decision: &str,
    note: Option<&str>,
) -> Result<ResidencyApplication, Refusal> {
    let note = decision_note(note);
    let note_param = note.as_deref().map(Param);
    let updated = c
        .query(
            &format!(
                "
      UPDATE academy.residency_applications
         SET status = $1,
             decided_at = now(),
             decided_by = $2,
             decision_note = $3,
             updated_at = now()
       WHERE id = $4
         AND status = 'applied'
       RETURNING {COLUMNS}
    "
            ),
            &[
                &Param(decision),
                &Param(operator_id),
                &note_param,
                &Param(id),
            ],
        )
        .map_err(|e| db::refusal(&e))?;
    if let Some(r) = rows(&updated)?.into_iter().next() {
        return Ok(r);
    }
    let existing = c
        .query(
            "
        SELECT status FROM academy.residency_applications WHERE id = $1
      ",
            &[&Param(id)],
        )
        .map_err(|e| db::refusal(&e))?;
    let Some(first) = existing.first() else {
        return Err(not_found());
    };
    Err(not_pending(
        &first.try_get::<_, Text>(0).map_err(|e| db::refusal(&e))?.0,
    ))
}

/// `myResidencies`: the caller's applications, newest first, at the owner's page size.
pub fn my_residencies(
    c: &mut Client,
    user_id: &str,
    limit: i64,
) -> Result<Vec<ResidencyApplication>, Refusal> {
    let found = c
        .query(
            &format!(
                "
      SELECT {COLUMNS}
        FROM academy.residency_applications
       WHERE user_id = $1
       ORDER BY applied_at DESC
       LIMIT $2
    "
            ),
            &[&Param(user_id), &limit],
        )
        .map_err(|e| db::refusal(&e))?;
    rows(&found)
}

/// `listOpenResidencies`: the operator queue, oldest first; a cohort filter is trimmed and lower-cased.
pub fn list_open_residencies(
    c: &mut Client,
    cohort_slug: Option<&str>,
    limit: i64,
) -> Result<Vec<ResidencyApplication>, Refusal> {
    let found = match cohort_slug {
        Some(slug) => {
            let slug = js_trim(slug).to_lowercase();
            c.query(
                &format!(
                    "
          SELECT {COLUMNS}
            FROM academy.residency_applications
           WHERE status = 'applied' AND cohort_slug = $1
           ORDER BY applied_at ASC
           LIMIT $2
        "
                ),
                &[&Param(&slug), &limit],
            )
        }
        None => c.query(
            &format!(
                "
          SELECT {COLUMNS}
            FROM academy.residency_applications
           WHERE status = 'applied'
           ORDER BY applied_at ASC
           LIMIT $1
        "
            ),
            &[&limit],
        ),
    }
    .map_err(|e| db::refusal(&e))?;
    rows(&found)
}

/// One open, published cohort (`CohortRow`). Seats left are counted only from a set capacity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cohort {
    pub slug: String,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub capacity: Option<i32>,
    pub entry_rules: Option<String>,
    pub seats_left: Option<i32>,
}

impl Cohort {
    /// `cohortOut`, in its key order.
    pub fn to_json(&self) -> Json {
        let int = |n: Option<i32>| n.map_or(Json::Null, |v| Json::int(i64::from(v)));
        Json::obj([
            ("slug", Json::str(self.slug.clone())),
            ("startsAt", opt_iso(self.starts_at)),
            ("endsAt", opt_iso(self.ends_at)),
            ("capacity", int(self.capacity)),
            ("entryRules", opt_text(self.entry_rules.as_ref())),
            ("seatsLeft", int(self.seats_left)),
        ])
    }
}

/// `residencyCohorts`: open, published cohorts by slug, at the owner's page size.
pub fn residency_cohorts(c: &mut Client, limit: i64) -> Result<Vec<Cohort>, Refusal> {
    let found = c
        .query(
            "
      SELECT c.slug, c.starts_at, c.ends_at, c.capacity, c.entry_rules,
             CASE
               WHEN c.capacity IS NULL THEN NULL
               ELSE c.capacity - (
                 SELECT COUNT(*)::int FROM academy.residency_applications a
                  WHERE a.cohort_slug = c.slug AND a.status IN ('applied', 'accepted')
               )
             END AS seats_left
        FROM academy.residency_cohorts c
       WHERE c.status = 'open' AND c.published = true
       ORDER BY c.slug ASC
       LIMIT $1
    ",
            &[&limit],
        )
        .map_err(|e| db::refusal(&e))?;
    let get = |e: postgres::Error| db::refusal(&e);
    found
        .iter()
        .map(|r| {
            Ok(Cohort {
                slug: r.try_get::<_, Text>(0).map_err(get)?.0,
                starts_at: r
                    .try_get::<_, Option<std::time::SystemTime>>(1)
                    .map_err(get)?
                    .map(ms),
                ends_at: r
                    .try_get::<_, Option<std::time::SystemTime>>(2)
                    .map_err(get)?
                    .map(ms),
                capacity: r.try_get(3).map_err(get)?,
                entry_rules: r.try_get::<_, Option<Text>>(4).map_err(get)?.map(|t| t.0),
                seats_left: r.try_get(5).map_err(get)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    //! The pure checks of `ambassadors/residency.ts`. The desk's behaviour runs against Postgres in
    //! `tests/programme_ambassadors.rs`; the in-memory desk's helpers in `memory.rs`.
    #![allow(clippy::unwrap_used, reason = "a test")]

    use super::*;

    #[test]
    fn a_short_statement_or_slug_refuses() {
        assert_eq!(
            assert_statement("hi").unwrap_err().code,
            "academy.residency_invalid"
        );
        assert_eq!(
            assert_cohort_slug("xx").unwrap_err().code,
            "academy.residency_invalid"
        );
        assert_eq!(
            assert_statement(&"s".repeat(2001)).unwrap_err().message,
            "Statement max 2000 characters"
        );
        assert_eq!(
            assert_statement("  I host weekly risk-first lobbies.  ").unwrap(),
            "I host weekly risk-first lobbies."
        );
    }

    #[test]
    fn a_cohort_slug_is_trimmed_and_lower_cased() {
        assert_eq!(assert_cohort_slug("  Bali-2026 ").unwrap(), "bali-2026");
        for bad in ["-bali", "bali-", "ba_li", &"a".repeat(49)] {
            assert!(assert_cohort_slug(bad).is_err(), "{bad}");
        }
        assert!(assert_cohort_slug(&"a".repeat(48)).is_ok());
    }

    #[test]
    fn a_decision_note_is_trimmed_cut_and_blank_is_none() {
        assert_eq!(decision_note(None), None);
        assert_eq!(decision_note(Some("   ")), None);
        assert_eq!(
            decision_note(Some(" strong host ")).as_deref(),
            Some("strong host")
        );
        assert_eq!(
            decision_note(Some(&"n".repeat(600))).map(|n| n.len()),
            Some(500)
        );
    }
}
