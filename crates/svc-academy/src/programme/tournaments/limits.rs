//! The SQL list limits the tournament reads take (`sql-list-limit.ts`): an owner-published page size, never an
//! invented 50 or the whole table. Blank, non-finite or below 1 refuses; 200 is the cap, not a default.

use crate::errors::AcademyError;

/// `assertSqlListLimit(limit, code, label)`: `limit` is the JS value when it is a number, `None` for any other value.
fn sql_list_limit(limit: Option<f64>, code: &str, label: &str) -> Result<i64, AcademyError> {
    let refuse = || {
        AcademyError::new(
            format!("{label} list limit is unset — pass limit (never invent the whole table)"),
            code,
        )
    };
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(refuse());
    };
    let n = l.floor();
    if n < 1.0 {
        return Err(refuse());
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a finite floor of at least 1, capped at 200"
    )]
    Ok(n.min(200.0) as i64)
}

/// `assertSeasonsSqlListLimit`.
pub fn seasons_list_limit(limit: Option<f64>) -> Result<i64, AcademyError> {
    sql_list_limit(limit, "academy.seasons_list_limit_unset", "Seasons")
}

/// `assertSeasonStandingsSqlLimit`.
pub fn season_standings_limit(limit: Option<f64>) -> Result<i64, AcademyError> {
    sql_list_limit(limit, "academy.standings_limit_unset", "Season standings")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    //! `season-standings-sql-limit-unset.test.ts` and the seasons rows of `list-remaining-sql-lists-limit-unset.test.ts`
    //! (`'nope'` and `null` are not numbers, so they reach the assert as `None`).
    use super::*;

    const UNSET: [Option<f64>; 7] = [
        None,
        None,
        Some(f64::NAN),
        Some(f64::INFINITY),
        Some(0.0),
        Some(-1.0),
        None,
    ];

    fn never_invents_fifty(message: &str) -> bool {
        let m = message.to_lowercase();
        !m.contains("50-row") && !m.contains("default 50") && !m.contains("?? 50")
    }

    #[test]
    fn standings_limit_refuses_omit_null_zero_negative_garbage() {
        for limit in UNSET {
            assert!(season_standings_limit(limit).is_err());
        }
        let e = season_standings_limit(None).unwrap_err();
        assert_eq!(e.code, "academy.standings_limit_unset");
        assert!(never_invents_fifty(&e.message));
    }

    #[test]
    fn standings_limit_accepts_published_and_caps_at_200() {
        assert_eq!(season_standings_limit(Some(50.0)).unwrap(), 50);
        assert_eq!(season_standings_limit(Some(1.0)).unwrap(), 1);
        assert_eq!(season_standings_limit(Some(200.0)).unwrap(), 200);
        assert_eq!(season_standings_limit(Some(201.0)).unwrap(), 200);
    }

    #[test]
    fn seasons_limit_refuses_omit_null_zero_negative_garbage() {
        for limit in UNSET {
            assert!(seasons_list_limit(limit).is_err());
        }
        let e = seasons_list_limit(None).unwrap_err();
        assert_eq!(e.code, "academy.seasons_list_limit_unset");
        assert!(never_invents_fifty(&e.message));
    }

    #[test]
    fn seasons_limit_accepts_published_and_caps_at_200() {
        assert_eq!(seasons_list_limit(Some(50.0)).unwrap(), 50);
        assert_eq!(seasons_list_limit(Some(1.0)).unwrap(), 1);
        assert_eq!(seasons_list_limit(Some(200.0)).unwrap(), 200);
        assert_eq!(seasons_list_limit(Some(201.0)).unwrap(), 200);
    }
}
