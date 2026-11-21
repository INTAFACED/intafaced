//! The ambassador programme, stage 1: status only, no pay (`ambassadors/programme.ts` and the ambassador part of
//! `academy-service.ts`). Appoint, freeze, unfreeze and the public badge. Hosting a lobby stays svc-identity's
//! `lobbyHostRights` perk: the programme is a label and an operator control, not a second host gate.

use postgres::Client;
use postgres::Row;
use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::pg::{Param, Text, ms};
use crate::db;
use crate::errors::{AcademyError, Refusal};

/// `AmbassadorRecord`. Times are milliseconds since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbassadorRecord {
    pub user_id: String,
    /// `active` or `frozen`.
    pub status: String,
    pub appointed_by: String,
    pub appointed_at: i64,
    pub frozen_at: Option<i64>,
    pub frozen_by: Option<String>,
    pub freeze_reason: Option<String>,
}

fn iso(ms: Option<i64>) -> Json {
    ms.map_or(Json::Null, |t| Json::str(Instant(t).iso()))
}

fn text(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

impl AmbassadorRecord {
    /// `ambassadorOut`, in its key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("userId".to_owned(), Json::str(self.user_id.clone())),
            ("status".to_owned(), Json::str(self.status.clone())),
            (
                "appointedBy".to_owned(),
                Json::str(self.appointed_by.clone()),
            ),
            (
                "appointedAt".to_owned(),
                Json::str(Instant(self.appointed_at).iso()),
            ),
            ("frozenAt".to_owned(), iso(self.frozen_at)),
            ("frozenBy".to_owned(), text(self.frozen_by.as_ref())),
            ("freezeReason".to_owned(), text(self.freeze_reason.as_ref())),
        ]
    }

    pub fn to_json(&self) -> Json {
        Json::Object(self.fields())
    }
}

/// `AmbassadorBadge`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbassadorBadge {
    pub user_id: String,
    /// True only when an active programme row exists.
    pub is_ambassador: bool,
    pub status: Option<String>,
}

impl AmbassadorBadge {
    /// `ambassadorBadgeOut`, in its key order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            ("isAmbassador", Json::Bool(self.is_ambassador)),
            ("status", text(self.status.as_ref())),
        ])
    }
}

/// `badgeOf`: the public label from an optional row.
pub fn badge_of(user_id: &str, row: Option<&AmbassadorRecord>) -> AmbassadorBadge {
    match row {
        None => AmbassadorBadge {
            user_id: user_id.to_owned(),
            is_ambassador: false,
            status: None,
        },
        Some(r) => AmbassadorBadge {
            user_id: user_id.to_owned(),
            is_ambassador: r.status == "active",
            status: Some(r.status.clone()),
        },
    }
}

/// UTF-16 length, as JavaScript's `.length`.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `assertFreezeReason`: trimmed, 3 to 500 characters.
pub fn assert_freeze_reason(reason: &str) -> Result<String, AcademyError> {
    let trimmed = js_trim(reason);
    if js_len(trimmed) < 3 {
        return Err(AcademyError::new(
            "Freeze reason must name why (min 3 characters after trim)",
            "academy.ambassador_invalid",
        ));
    }
    if js_len(trimmed) > 500 {
        return Err(AcademyError::new(
            "Freeze reason max 500 characters",
            "academy.ambassador_invalid",
        ));
    }
    Ok(trimmed.to_owned())
}

/// `assertProgrammePageLimit`: an owner-published page size, never `all.length`.
pub fn assert_programme_page_limit(limit: Option<f64>) -> Result<usize, AcademyError> {
    let refuse = || {
        AcademyError::new(
            "Programme list limit is unset — pass limit (never invent all.length)",
            "academy.programme_list_limit_unset",
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

const COLUMNS: &str =
    "user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason";

fn row(r: &Row) -> Result<AmbassadorRecord, Refusal> {
    let get = |e: postgres::Error| db::refusal(&e);
    Ok(AmbassadorRecord {
        user_id: r.try_get::<_, Text>(0).map_err(get)?.0,
        status: r.try_get::<_, Text>(1).map_err(get)?.0,
        appointed_by: r.try_get::<_, Text>(2).map_err(get)?.0,
        appointed_at: ms(r.try_get(3).map_err(get)?),
        frozen_at: r
            .try_get::<_, Option<std::time::SystemTime>>(4)
            .map_err(get)?
            .map(ms),
        frozen_by: r.try_get::<_, Option<Text>>(5).map_err(get)?.map(|t| t.0),
        freeze_reason: r.try_get::<_, Option<Text>>(6).map_err(get)?.map(|t| t.0),
    })
}

fn rows(found: &[Row]) -> Result<Vec<AmbassadorRecord>, Refusal> {
    found.iter().map(row).collect()
}

fn already_active(user_id: &str) -> Refusal {
    AcademyError::new(
        format!("User {user_id} is already an active ambassador"),
        "academy.ambassador_already_active",
    )
    .into()
}

fn frozen_refuses_appoint(user_id: &str) -> Refusal {
    AcademyError::new(
        format!("Ambassador {user_id} is frozen — unfreeze to restore the badge (re-appoint would erase freeze audit)"),
        "academy.ambassador_already_frozen",
    )
    .into()
}

/// `ambassadorOf`.
pub fn ambassador_of(c: &mut Client, user_id: &str) -> Result<Option<AmbassadorRecord>, Refusal> {
    let found = c
        .query(
            &format!(
                "
      SELECT {COLUMNS}
        FROM academy.ambassadors WHERE user_id = $1
    "
            ),
            &[&Param(user_id)],
        )
        .map_err(|e| db::refusal(&e))?;
    Ok(rows(&found)?.into_iter().next())
}

/// `ambassadorBadge`.
pub fn ambassador_badge(c: &mut Client, user_id: &str) -> Result<AmbassadorBadge, Refusal> {
    Ok(badge_of(user_id, ambassador_of(c, user_id)?.as_ref()))
}

/// `listAmbassadors`: the owner's page size is checked before the query.
pub fn list_ambassadors(
    c: &mut Client,
    status: Option<&str>,
    limit: i64,
) -> Result<Vec<AmbassadorRecord>, Refusal> {
    let found = match status {
        Some(s) => c.query(
            &format!(
                "
          SELECT {COLUMNS}
            FROM academy.ambassadors WHERE status = $1
            ORDER BY appointed_at DESC
            LIMIT $2
        "
            ),
            &[&Param(s), &limit],
        ),
        None => c.query(
            &format!(
                "
          SELECT {COLUMNS}
            FROM academy.ambassadors ORDER BY status ASC, appointed_at DESC
            LIMIT $1
        "
            ),
            &[&limit],
        ),
    }
    .map_err(|e| db::refusal(&e))?;
    rows(&found)
}

/// `appointAmbassador`: a new row only. Already active refuses (a double click does not rewrite `appointed_by`);
/// frozen refuses (the freeze audit is kept: unfreeze instead).
pub fn appoint_ambassador(
    c: &mut Client,
    user_id: &str,
    operator_id: &str,
) -> Result<AmbassadorRecord, Refusal> {
    match ambassador_of(c, user_id)?.map(|r| r.status) {
        Some(s) if s == "active" => return Err(already_active(user_id)),
        Some(s) if s == "frozen" => return Err(frozen_refuses_appoint(user_id)),
        _ => {}
    }
    let inserted = c
        .query(
            &format!(
                "
      INSERT INTO academy.ambassadors (user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason, updated_at)
      VALUES ($1, 'active', $2, now(), NULL, NULL, NULL, now())
      ON CONFLICT (user_id) DO UPDATE SET
        status = 'active',
        appointed_by = EXCLUDED.appointed_by,
        appointed_at = now(),
        frozen_at = NULL,
        frozen_by = NULL,
        freeze_reason = NULL,
        updated_at = now()
      WHERE academy.ambassadors.status IS DISTINCT FROM 'frozen'
        AND academy.ambassadors.status IS DISTINCT FROM 'active'
      RETURNING {COLUMNS}
    "
            ),
            &[&Param(user_id), &Param(operator_id)],
        )
        .map_err(|e| db::refusal(&e))?;
    if let Some(r) = rows(&inserted)?.into_iter().next() {
        return Ok(r);
    }
    // A concurrent freeze or appoint won the race: read again and refuse honestly.
    match ambassador_of(c, user_id)?.map(|r| r.status) {
        Some(s) if s == "frozen" => Err(frozen_refuses_appoint(user_id)),
        Some(s) if s == "active" => Err(already_active(user_id)),
        _ => Err(AcademyError::new(
            format!("Could not appoint ambassador {user_id}"),
            "academy.ambassador_invalid",
        )
        .into()),
    }
}

/// `freezeAmbassador`: the reason is checked before any query; a lost race never overwrites the winner's reason.
pub fn freeze_ambassador(
    c: &mut Client,
    user_id: &str,
    operator_id: &str,
    reason: &str,
) -> Result<AmbassadorRecord, Refusal> {
    let reason = assert_freeze_reason(reason)?;
    freeze_checked(c, user_id, operator_id, &reason)
}

/// The freeze after its reason passed (`freezeAmbassador` past `assertFreezeReason`).
pub fn freeze_checked(
    c: &mut Client,
    user_id: &str,
    operator_id: &str,
    reason: &str,
) -> Result<AmbassadorRecord, Refusal> {
    let Some(existing) = ambassador_of(c, user_id)? else {
        return Err(AcademyError::new(
            format!("No ambassador programme row for {user_id}"),
            "academy.ambassador_not_found",
        )
        .into());
    };
    let already_frozen = || -> Refusal {
        AcademyError::new(
            format!("Ambassador {user_id} is already frozen"),
            "academy.ambassador_already_frozen",
        )
        .into()
    };
    if existing.status == "frozen" {
        return Err(already_frozen());
    }
    let updated = c
        .query(
            &format!(
                "
      UPDATE academy.ambassadors
         SET status = 'frozen',
             frozen_at = now(),
             frozen_by = $1,
             freeze_reason = $2,
             updated_at = now()
       WHERE user_id = $3
         AND status = 'active'
       RETURNING {COLUMNS}
    "
            ),
            &[&Param(operator_id), &Param(reason), &Param(user_id)],
        )
        .map_err(|e| db::refusal(&e))?;
    // A concurrent freeze won: do not overwrite its reason or operator.
    rows(&updated)?
        .into_iter()
        .next()
        .ok_or_else(already_frozen)
}

/// `unfreezeAmbassador`: back to active without a re-appoint; the freeze fields clear.
pub fn unfreeze_ambassador(
    c: &mut Client,
    user_id: &str,
    _operator_id: &str,
) -> Result<AmbassadorRecord, Refusal> {
    let not_found = || -> Refusal {
        AcademyError::new(
            format!("Ambassador {user_id} not found"),
            "academy.ambassador_not_found",
        )
        .into()
    };
    let Some(existing) = ambassador_of(c, user_id)? else {
        return Err(not_found());
    };
    if existing.status != "frozen" {
        return Err(AcademyError::new(
            format!("Ambassador {user_id} is not frozen"),
            "academy.ambassador_invalid",
        )
        .into());
    }
    let updated = c
        .query(
            &format!(
                "
      UPDATE academy.ambassadors
         SET status = 'active',
             frozen_at = NULL,
             frozen_by = NULL,
             freeze_reason = NULL,
             updated_at = now()
       WHERE user_id = $1 AND status = 'frozen'
       RETURNING {COLUMNS}
    "
            ),
            &[&Param(user_id)],
        )
        .map_err(|e| db::refusal(&e))?;
    rows(&updated)?.into_iter().next().ok_or_else(not_found)
}

#[cfg(test)]
mod tests {
    //! `ambassadors/programme.test.ts`: the pure label and the freeze reason. The desk's behaviour runs against
    //! Postgres in `tests/programme_ambassadors.rs`; its in-memory helpers in `memory.rs`.
    #![allow(clippy::unwrap_used, reason = "a test")]

    use super::*;

    fn base(status: &str) -> AmbassadorRecord {
        AmbassadorRecord {
            user_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            status: status.to_owned(),
            appointed_by: "22222222-2222-4222-8222-222222222222".to_owned(),
            appointed_at: 1_785_542_400_000,
            frozen_at: None,
            frozen_by: None,
            freeze_reason: None,
        }
    }

    #[test]
    fn no_row_is_not_an_ambassador() {
        assert_eq!(
            badge_of("u", None),
            AmbassadorBadge {
                user_id: "u".to_owned(),
                is_ambassador: false,
                status: None
            }
        );
        assert_eq!(
            badge_of("u", None).to_json().compact(),
            r#"{"userId":"u","isAmbassador":false,"status":null}"#
        );
    }

    #[test]
    fn is_ambassador_only_when_active() {
        assert!(badge_of("u", Some(&base("active"))).is_ambassador);
        let mut frozen = base("frozen");
        frozen.frozen_at = Some(1);
        frozen.frozen_by = Some("op".to_owned());
        frozen.freeze_reason = Some("pause".to_owned());
        assert!(!badge_of("u", Some(&frozen)).is_ambassador);
    }

    #[test]
    fn a_named_reason_is_trimmed_and_accepted() {
        assert_eq!(
            assert_freeze_reason("  policy breach  ").unwrap(),
            "policy breach"
        );
    }

    #[test]
    fn an_empty_or_short_reason_refuses() {
        assert_eq!(
            assert_freeze_reason("  x  ").unwrap_err().code,
            "academy.ambassador_invalid"
        );
        assert_eq!(
            assert_freeze_reason("").unwrap_err().code,
            "academy.ambassador_invalid"
        );
        assert_eq!(
            assert_freeze_reason(&"y".repeat(501)).unwrap_err().message,
            "Freeze reason max 500 characters"
        );
        assert!(assert_freeze_reason(&"y".repeat(500)).is_ok());
        // UTF-16 length: three astral characters are six units.
        assert!(assert_freeze_reason("\u{1F600}\u{1F600}").is_ok());
    }

    #[test]
    fn the_record_reads_out_in_the_output_schema_order() {
        assert_eq!(
            base("active").to_json().compact(),
            r#"{"userId":"11111111-1111-4111-8111-111111111111","status":"active","appointedBy":"22222222-2222-4222-8222-222222222222","appointedAt":"2026-08-01T00:00:00.000Z","frozenAt":null,"frozenBy":null,"freezeReason":null}"#
        );
    }
}
